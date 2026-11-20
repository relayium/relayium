// Preparation and upload are distinct phases. The renderer supplies the exact
// production ciphertext once; only a complete, verified spool may reach HTTP.
import { AuthorityRevoked, Fence } from "./authority.js";
import { UploadEngine, UploadFailure, type CipherFrame, type EngineHooks, type UploadOutcome, type UploadFailureCode } from "./engine.js";
import { FrameScheduleError, UploadFrameSchedule, frameLengthAt, planUpload, type UploadPlan } from "./plan.js";
import { RecoveryStore, type RecoveryPlan } from "./recovery-store.js";
import { UploadTransport, UploadTransportError, type UploadByteTransport, type FinalizeReceipt } from "./transport.js";
import type { StoredRuntime } from "../runtime-contract.js";
import type { StoredSendPhase } from "../../../shared/ipc-contract.js";

export type PreparedOutcome = UploadOutcome;
type Writer = Awaited<ReturnType<RecoveryStore["create"]>>;
interface Context {
  readonly store: RecoveryStore;
  readonly runtime: StoredRuntime;
  readonly transport: UploadByteTransport & Pick<UploadTransport, "finalizeRecoverable">;
  readonly fence: Fence;
  readonly hooks?: EngineHooks;
  readonly onPreparing?: (prepared: number, total: number) => void;
  readonly onStage?: (stage: StoredSendPhase) => void;
}

function failureCode(error: unknown): UploadFailureCode {
  if (error instanceof UploadFailure) return error.code;
  if (error instanceof AuthorityRevoked) return error.reason === "cancelled" ? "cancelled" : "authority-revoked";
  if (error instanceof UploadTransportError) {
    if (error.code === "network" || error.code === "timeout" || error.code === "cancelled") return error.code;
    return error.code === "http" && error.status === 404 ? "session-gone" : "server-refused";
  }
  return "internal";
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new UploadFailure("cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export class PreparedUploadEngine {
  private readonly schedule: UploadFrameSchedule;
  private working: Promise<unknown> | null = null;
  private network: UploadEngine | null = null;
  private terminal: PreparedOutcome | null = null;
  private closingPreparation: Promise<PreparedOutcome> | null = null;
  private prepared = 0;
  private constructor(private readonly context: Context, private plan: RecoveryPlan,
    private readonly geometry: UploadPlan, private readonly writer: Writer | null) {
    this.schedule = new UploadFrameSchedule(geometry);
  }

  static async create(context: Context, input: Parameters<RecoveryStore["create"]>[0]): Promise<PreparedUploadEngine> {
    context.fence.assert();
    const geometry = planUpload(input.descriptors, context.runtime.constants);
    if (!geometry.ok || geometry.plan.cipherBytes !== input.cipherBytes) throw new UploadFailure("internal");
    const writer = await context.store.create(input);
    try {
      context.fence.assert();
      return new PreparedUploadEngine(context, await context.store.read(input.accountId, input.origin, input.jobId), geometry.plan, writer);
    } catch (error) { await writer.close(); throw error; }
  }

  static async recover(context: Context, accountId: string, origin: string, jobId: string): Promise<PreparedUploadEngine> {
    context.fence.assert();
    const plan = await context.store.read(accountId, origin, jobId);
    const geometry = planUpload(plan.descriptors, context.runtime.constants);
    if (!geometry.ok || geometry.plan.cipherBytes !== plan.cipherBytes) throw new UploadFailure("internal");
    await context.store.verify(plan, context.fence.signal);
    context.fence.assert();
    return new PreparedUploadEngine(context, plan, geometry.plan, null);
  }

  get outcome(): PreparedOutcome | null { return this.terminal; }
  get phase(): RecoveryPlan["phase"] { return this.plan.phase; }
  get expects() { return this.writer && this.plan.phase === "preparing" ? this.schedule.next : null; }
  get progress() { return this.network?.progress ?? { committed: 0, total: this.plan.cipherBytes }; }
  async releasePublishedCopy(): Promise<void> {
    if (this.plan.phase !== "published") throw new UploadFailure("internal");
    await this.context.store.remove(this.plan);
  }

  async feed(frame: CipherFrame): Promise<void> {
    if (this.working) throw new UploadFailure("concurrent-feed");
    if (!this.writer || this.terminal || this.plan.phase !== "preparing") throw new UploadFailure("internal");
    this.context.fence.assert();
    try { this.schedule.take(frame); }
    catch (error) {
      if (error instanceof FrameScheduleError) {
        await this.failPreparation(error.code);
        throw new UploadFailure(error.code);
      }
      throw error;
    }
    const work = this.writer.append(frame.bytes);
    this.working = work;
    try {
      await work;
      this.context.fence.assert();
      this.prepared += frame.bytes.length;
      this.context.onPreparing?.(this.prepared, this.plan.cipherBytes);
    } catch (error) {
      await this.failPreparation(failureCode(error));
      throw error;
    } finally { if (this.working === work) this.working = null; }
  }

  private failPreparation(code: UploadFailureCode): Promise<PreparedOutcome> {
    if (this.closingPreparation) return this.closingPreparation;
    const outcome: PreparedOutcome = { status: "failed", code, status_: null };
    this.terminal = outcome;
    this.context.fence.revoke("job-settled");
    this.closingPreparation = (this.writer?.close() ?? Promise.resolve()).then(() => outcome);
    return this.closingPreparation;
  }

  async end(): Promise<PreparedOutcome> {
    if (this.closingPreparation) return this.closingPreparation;
    if (this.terminal) return this.terminal;
    if (this.working) throw new UploadFailure("concurrent-feed");
    if (this.writer && this.schedule.next !== null) return this.failPreparation("producer-short");
    const work = this.upload();
    this.working = work;
    try { return this.terminal = await work; }
    catch (error) {
      // Local ciphertext and custody survive every uncertain network result.
      const code = failureCode(this.context.fence.valid ? error : new AuthorityRevoked(this.context.fence.reason!));
      if (this.plan.phase === "preparing") return this.failPreparation(code);
      return this.terminal = this.plan.phase === "finalizing" ? { status: "ambiguous", code }
        : { status: "interrupted", code };
    } finally { if (this.working === work) this.working = null; }
  }

  private async finalize(signal: AbortSignal): Promise<FinalizeReceipt> {
    const { store, transport, fence } = this.context;
    if (!this.plan.uploadId) throw new UploadFailure("internal");
    this.context.onStage?.("finalizing");
    await store.verify(this.plan, signal);
    fence.assert();
    if (this.plan.phase !== "finalizing") this.plan = await store.update(this.plan, { phase: "finalizing" });
    for (let polls = 0; polls < 12; polls++) {
      fence.assert();
      const result = await transport.finalizeRecoverable(this.plan.uploadId!, signal);
      if (result.outcome === "finalized") return result;
      if (result.outcome !== "running") return { outcome: "already-finalized" };
      if (polls < 11) await pause(5000, signal);
    }
    return { outcome: "already-finalized" };
  }

  private async upload(): Promise<PreparedOutcome> {
    const { store, runtime, transport, fence, hooks } = this.context;
    if (this.writer && this.plan.phase === "preparing") this.plan = await this.writer.finish();
    fence.assert();
    await store.verify(this.plan, fence.signal);
    fence.assert();
    if (this.plan.phase === "published" && this.plan.objectId) {
      return { status: "published", objectId: this.plan.objectId, expiresAt: this.plan.expiresAt };
    }
    if (this.plan.phase === "finalizing") {
      // No new init/status/PATCH after a possibly committed finalize.
      const result = await this.finalize(fence.signal);
      if (result.outcome !== "finalized") return { status: "ambiguous", code: "server-refused" };
      this.plan = await store.update(this.plan, { phase: "published", objectId: result.id, expiresAt: result.expiresAt });
      return { status: "published", objectId: result.id, expiresAt: result.expiresAt };
    }
    let received = 0;
    this.context.onStage?.("uploading");
    if (this.plan.uploadId) {
      const status = await transport.status(this.plan.uploadId, fence.signal);
      if (status === "gone") {
        this.context.onStage?.("restarting");
        // Finalize has never been attempted: its durable marker precedes the
        // call. An explicit Resume may restart the expired session using the
        // SAME complete ciphertext, key and manifest; never a silent new file.
        this.plan = await store.update(this.plan, { phase: "uploading", uploadId: null, chunkSize: null });
      } else received = status.received;
    }
    if (!this.plan.uploadId) {
      fence.assert();
      if (this.plan.phase === "ready") this.plan = await store.update(this.plan, { phase: "uploading" });
      const session = await transport.init(new Uint8Array(Buffer.from(this.plan.sealedManifest, "base64")),
        this.plan.retention, this.plan.cipherBytes, fence.signal);
      // Persist the exact session BEFORE the first PATCH. A failure leaves no
      // network engine that could run ahead of its durable identity.
      this.plan = await store.update(this.plan, { phase: "uploading", uploadId: session.uploadId, chunkSize: session.chunkSize });
      await hooks?.onSession?.(session.uploadId);
      this.context.onStage?.("uploading");
    }
    fence.assert();
    const finalizer: UploadByteTransport = {
      init: (...args) => transport.init(...args), append: (...args) => transport.append(...args),
      status: (...args) => transport.status(...args), finalize: (_id, signal) => this.finalize(signal ?? fence.signal),
    };
    this.network = UploadEngine.resume({ uploadId: this.plan.uploadId!, chunkSize: this.plan.chunkSize!,
      received, runtime, plan: this.geometry, transport: finalizer, fence, hooks: hooks ?? {} });
    // O(files + remaining frames), never an allocation proportional to file
    // size. Reconstruct frame positions from the SAME geometry as the engine.
    let fileOffset = 0; let firstSeq = 1;
    for (const file of this.geometry.frames) {
      const first = this.network.expects;
      if (!first) break;
      const from = Math.max(0, first.seq - firstSeq);
      for (let index = from; index < file.frameCount; index++) {
        fence.assert();
        const length = frameLengthAt(file, index)!;
        const bytes = await store.range(this.plan, fileOffset + index * file.fullBytes, length);
        await this.network.feed({ fileIndex: file.index, seq: firstSeq + index, bytes });
      }
      fileOffset += file.fullFrames * file.fullBytes + file.tailBytes;
      firstSeq += file.frameCount;
    }
    const result = await this.network.end();
    if (result.status === "published") {
      this.plan = await store.update(this.plan, { phase: "published", objectId: result.objectId, expiresAt: result.expiresAt });
      return result;
    }
    return result.status === "failed" || result.status === "cancelled"
      ? { status: "interrupted", code: result.status === "failed" ? result.code : "cancelled" } : result;
  }

  async cancel(): Promise<PreparedOutcome> {
    this.context.fence.revoke("cancelled");
    await this.network?.cancel();
    await this.working?.catch(() => undefined);
    await this.closingPreparation?.catch(() => undefined);
    await this.writer?.close();
    if (this.terminal?.status === "published") return this.terminal;
    return this.terminal = this.plan.phase === "preparing" ? { status: "cancelled" }
      : this.plan.phase === "finalizing" ? { status: "ambiguous", code: "cancelled" }
      : { status: "interrupted", code: "cancelled" };
  }
}
