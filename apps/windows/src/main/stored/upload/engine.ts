// One upload, from init to a finalized object id — or to an honest unknown.
//
// ## The producer is in another process, so the schedule is the contract
//
// Ciphertext is produced by the renderer that holds the user's `File` objects
// (see `service.ts` for the host contract). This engine never encrypts and
// never reads a file. What it does is hold the plan computed from the ordered
// descriptors and require every frame to match it: the right file index, the
// right global sequence number, the right byte length. A producer that sends
// one frame too many, one too few, one twice, or two at once is refused, and
// the refusal happens before the bytes reach the wire rather than as a
// corrupted object at the far end.
//
// The sequence counter is GLOBAL and never resets per file — `encryptFiles`
// derives its nonce from it, so a per-file reset would reuse nonces across
// files under one key. A zero-byte file owes no frames at all.
//
// ## One acknowledged frame in flight
//
// `feed` resolves only once the frame is accounted for: buffered, and PATCHed
// if that buffering filled a chunk. A concurrent `feed` is a refusal, not a
// queue — a queue would let a producer run ahead of the acknowledged offset and
// make the retained replay window a guess.
//
// ## The retained window is what makes a retry safe
//
// The server commits partial chunks, so bytes behind an unacknowledged offset
// must be re-sendable. They are re-sent from THIS buffer, byte for byte — never
// re-encrypted. Re-encrypting is the one catastrophic mistake available here:
// the key is retained across a retry, and AES-GCM under a repeated nonce with
// different plaintext is a break, not a glitch. A `File` is a live handle to a
// disk file the user can edit between attempts, so "encrypt it again" can never
// be assumed to produce the same bytes. If the server's offset falls outside the
// retained window, this attempt ends — ambiguous or failed, truthfully — and a
// new attempt is a NEW key and a NEW object, which is the caller's explicit
// decision.
//
// ## Finalize is once-only and 409 is not success
//
// `handleUploadFinalize` claims the session terminally before any gate, and
// keeps a tombstone that answers 409 for every later attempt — including after
// a post-claim refusal that dropped the blob. The object id exists only in the
// single 200, and `GET /api/uploads/{id}` answers 404 once the session is done.
// So a lost finalize response is genuinely AMBIGUOUS: the key is kept, the
// record says so, and only `reconcile.ts`'s exact manifest-digest proof can
// resolve it. Nothing here guesses from a filename, a size or a timestamp.

import type { StoredRuntime } from "../runtime-contract.js";
import { AuthorityRevoked, Fence } from "./authority.js";
import { FrameScheduleError, UploadFrameSchedule, type UploadPlan } from "./plan.js";
import {
  UploadTransportError,
  type UploadByteTransport,
  type UploadRetention,
} from "./transport.js";

/** Bounded attempts for one append, and the backoff between them. */
export const MAX_APPEND_ATTEMPTS = 5;
/** Consecutive attempts that move the committed offset by zero before this
 *  engine stops asking. Without it a server answering 200/`received:
 *  unchanged` forever is an infinite loop that looks like an upload. */
export const MAX_STALLED_ATTEMPTS = 3;
export const MAX_FINALIZE_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 300;
const BACKOFF_CAP_MS = 5_000;

export type UploadFailureCode =
  | "authority-revoked"
  | "concurrent-feed"
  | "frame-sequence"
  | "frame-index"
  | "frame-length"
  | "producer-overrun"
  | "producer-short"
  | "byte-total"
  | "offset-regressed"
  | "offset-ahead"
  | "offset-invalid"
  | "no-progress"
  | "session-gone"
  | "server-refused"
  | "network"
  | "timeout"
  | "cancelled"
  | "internal";

export class UploadFailure extends Error {
  constructor(
    readonly code: UploadFailureCode,
    readonly status: number | null = null,
  ) {
    super(status === null ? code : `${code}: ${String(status)}`);
    this.name = "UploadFailure";
  }
}

export type UploadOutcome =
  /** Finalized. `objectId` is the server's, and the only thing a link may use. */
  | { readonly status: "published"; readonly objectId: string; readonly expiresAt: number; readonly cleanupPending?: boolean }
  /**
   * The outcome could not be determined. An object MAY exist. The key is
   * retained and the journal record stays `ambiguous`.
   */
  | { readonly status: "ambiguous"; readonly code: UploadFailureCode }
  /** Complete original ciphertext and its protected plan remain on this PC. */
  | { readonly status: "interrupted"; readonly code: UploadFailureCode }
  /** Nothing was finalized, provably: finalize was never called. */
  | { readonly status: "failed"; readonly code: UploadFailureCode; readonly status_: number | null }
  | { readonly status: "cancelled" };

/** One ciphertext frame, as the producer hands it over. */
export interface CipherFrame {
  /** Index into the plan's manifest — the file these bytes belong to. */
  readonly fileIndex: number;
  /** The GLOBAL frame counter, starting at 1. Frame 0 is the manifest. */
  readonly seq: number;
  /** `uint32BE(len(ct)) ‖ ct`, exactly as `encryptFiles` yields it. */
  readonly bytes: Uint8Array;
}

export interface EngineHooks {
  /** Committed ciphertext bytes, as the SERVER has acknowledged them. Fenced,
   *  so a revoked job publishes no more progress. */
  readonly onProgress?: (committed: number, total: number) => void;
  /** Called once, with the upload session id, immediately after init. */
  readonly onSession?: (uploadId: string) => Promise<void> | void;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new UploadFailure("cancelled"));
    };
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new UploadFailure("cancelled"));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });

const backoff = (attempt: number): number =>
  Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);


export class UploadEngine {
  /** The replay buffer AND the pack buffer.
   *
   *  Sized from the VALIDATED chunk size plus one whole frame, because the
   *  last frame of a chunk may cross the chunk boundary — upload chunk edges
   *  need not align with frame edges, the server sees an opaque byte stream.
   *  Allocated once, from a number `UploadTransport.init` has already clamped,
   *  so a hostile `chunkSize` cannot make this an arbitrary allocation. */
  private readonly buffer: Uint8Array;
  private filled = 0;
  /** Global ciphertext offset of `buffer[0]`. */
  private chunkStart = 0;
  /** What the server has acknowledged. */
  private committed = 0;
  /** A resume may begin inside a frame. The complete original ciphertext
   * frame is validated, then only its unacknowledged suffix enters the wire. */
  private skipFromNextFrame = 0;

  private readonly schedule: UploadFrameSchedule;
  private busy = false;
  private settled: UploadOutcome | null = null;
  /** The request currently in flight, so cancellation can JOIN it rather than
   *  abandon a live promise and a live socket. */
  private inFlight: Promise<unknown> | null = null;
  private readonly aborter = new AbortController();
  private finalizeAttempted = false;
  /** The engine's own cancellation merged with the fence's revocation, so a
   *  request in flight is reached by either. */
  private signal!: AbortSignal;

  private constructor(
    readonly uploadId: string,
    private readonly chunkSize: number,
    private readonly plan: UploadPlan,
    private readonly transport: UploadByteTransport,
    private readonly fence: Fence,
    private readonly hooks: EngineHooks,
    maxFrameBytes: number,
  ) {
    this.buffer = new Uint8Array(chunkSize + maxFrameBytes);
    this.signal = AbortSignal.any([this.aborter.signal, fence.signal]);
    this.schedule = new UploadFrameSchedule(plan);
  }

  /**
   * Seal the manifest, open the session, and return a live engine.
   *
   * The order is fixed by what must be true if this crashes: the caller has
   * already persisted the key (see `service.ts`), so an init that succeeds and
   * is then lost leaves an openable object rather than orphan ciphertext.
   */
  static async open(input: {
    readonly runtime: StoredRuntime;
    readonly key: CryptoKey;
    readonly sealedManifest: Uint8Array;
    readonly plan: UploadPlan;
    readonly retention: UploadRetention;
    readonly transport: UploadByteTransport;
    readonly fence: Fence;
    readonly hooks?: EngineHooks;
  }): Promise<UploadEngine> {
    input.fence.assert();
    // Bound to the fence, which is the only thing that exists at this point:
    // the engine's own AbortController is created below, so an unsignalled init
    // was a request no revocation could reach.
    const receipt = await input.transport.init(
      input.sealedManifest,
      input.retention,
      input.plan.cipherBytes,
      input.fence.signal,
    );
    // A whole frame is a full plaintext chunk plus the tag and the prefix.
    const maxFrameBytes = input.runtime.constants.storeChunkSize + input.runtime.constants.frameOverhead;
    const engine = new UploadEngine(
      receipt.uploadId,
      receipt.chunkSize,
      input.plan,
      input.transport,
      input.fence,
      input.hooks ?? {},
      maxFrameBytes,
    );
    await input.hooks?.onSession?.(receipt.uploadId);
    return engine;
  }

  get outcome(): UploadOutcome | null {
    return this.settled;
  }

  /** Reattach to a session whose offset was freshly read from the server.
   * Callers must verify the complete persisted ciphertext before reaching this
   * method. This never opens a second session or regenerates a nonce. */
  static resume(input: {
    readonly uploadId: string;
    readonly chunkSize: number;
    readonly received: number;
    readonly runtime: StoredRuntime;
    readonly plan: UploadPlan;
    readonly transport: UploadByteTransport;
    readonly fence: Fence;
    readonly hooks?: EngineHooks;
  }): UploadEngine {
    if (!Number.isSafeInteger(input.received) || input.received < 0 || input.received > input.plan.cipherBytes) {
      throw new UploadFailure("offset-invalid");
    }
    if (!Number.isSafeInteger(input.chunkSize) || input.chunkSize < 64 * 1024 || input.chunkSize > 16 * 1024 * 1024) {
      throw new UploadFailure("internal");
    }
    input.fence.assert();
    const engine = new UploadEngine(input.uploadId, input.chunkSize, input.plan, input.transport, input.fence,
      input.hooks ?? {}, input.runtime.constants.storeChunkSize + input.runtime.constants.frameOverhead);
    engine.chunkStart = input.received;
    engine.committed = input.received;
    engine.skipFromNextFrame = engine.schedule.seek(input.received);
    return engine;
  }

  /** Committed ciphertext bytes and the total this object owes. */
  get progress(): { readonly committed: number; readonly total: number } {
    return { committed: this.committed, total: this.plan.cipherBytes };
  }

  /** What the producer must send next, so a host can drive it without keeping
   *  its own copy of the schedule. */
  get expects(): { readonly fileIndex: number; readonly seq: number; readonly bytes: number } | null {
    return this.schedule.next;
  }

  /**
   * Accept one frame, and resolve when it is accounted for.
   *
   * Every refusal here is terminal for the job: a producer that disagreed with
   * the schedule cannot be resynchronised, because this engine cannot produce
   * the bytes it was expecting.
   */
  async feed(frame: CipherFrame): Promise<void> {
    if (this.settled !== null) throw new UploadFailure("internal");
    if (this.busy) {
      // Not queued. A queue would let the producer run ahead of the
      // acknowledged offset, and the retained window would stop being a fact.
      throw this.fail("concurrent-feed");
    }
    this.busy = true;
    try {
      this.fence.assert();
      this.advanceCursorOver(frame);
      const suffix = frame.bytes.subarray(this.skipFromNextFrame);
      this.skipFromNextFrame = 0;
      this.buffer.set(suffix, this.filled);
      this.filled += suffix.byteLength;
      if (this.filled >= this.chunkSize) await this.flush(false);
    } catch (error) {
      throw this.absorb(error);
    } finally {
      this.busy = false;
    }
  }

  /** Validate one frame against the schedule and advance past it. */
  private advanceCursorOver(frame: CipherFrame): void {
    try { this.schedule.take(frame); }
    catch (error) {
      if (error instanceof FrameScheduleError) throw this.fail(error.code);
      throw error;
    }
  }

  /**
   * Send what is buffered, honouring the server's committed offset.
   *
   * `force` sends a short buffer (the tail, at `end()`); otherwise only whole
   * chunks go.
   */
  private async flush(force: boolean): Promise<void> {
    while (this.filled > 0 && (force || this.filled >= this.chunkSize)) {
      let attempt = 0;
      let stalled = 0;
      for (;;) {
        // A status probe can consume all or part of the retained window after
        // a lost response. Recompute from that NEW window: the old length can
        // include stale buffer bytes, or send an empty window twice.
        if (this.filled === 0) break;
        const send = Math.min(this.filled, this.chunkSize);
        attempt += 1;
        this.fence.assert();
        const before = this.chunkStart;
        let receipt;
        try {
          const request = this.transport.append(
            this.uploadId,
            this.chunkStart,
            this.plan.cipherBytes,
            this.buffer.subarray(0, send),
            this.signal,
          );
          this.inFlight = request;
          receipt = await request;
        } catch (error) {
          const failure = this.classify(error);
          if (failure.code === "cancelled") throw failure;
          // A transient fault may have committed a PREFIX — the server bills
          // and keeps whatever landed — so the offset is re-read rather than
          // assumed, and the replay starts from the server's own answer.
          if (!this.retryable(failure) || attempt >= MAX_APPEND_ATTEMPTS) throw failure;
          const resynced = await this.resync();
          if (!resynced) throw failure;
          if (this.chunkStart === before) {
            stalled += 1;
            if (stalled >= MAX_STALLED_ATTEMPTS) throw this.fail("no-progress");
          } else {
            stalled = 0;
          }
          await sleep(backoff(attempt), this.signal);
          continue;
        } finally {
          this.inFlight = null;
        }
        this.consume(receipt.received);
        if (this.chunkStart === before) {
          // A 200 or a 409 that moved nothing. Bounded, so a server answering
          // the same offset forever is a failure rather than a spin.
          stalled += 1;
          if (stalled >= MAX_STALLED_ATTEMPTS) throw this.fail("no-progress");
          if (attempt >= MAX_APPEND_ATTEMPTS) throw this.fail("no-progress");
          await sleep(backoff(attempt), this.signal);
          continue;
        }
        break;
      }
    }
  }

  /** Apply a server offset to the retained window, or refuse it. */
  private consume(received: number): void {
    if (!Number.isSafeInteger(received) || received < 0) throw this.fail("offset-invalid");
    if (received < this.chunkStart) {
      // The server is behind bytes this engine no longer retains. Those bytes
      // cannot be re-sent — and must never be re-encrypted, which under the
      // same key would repeat a nonce over different plaintext.
      throw this.fail("offset-regressed");
    }
    if (received > this.chunkStart + this.filled) {
      // Ahead of everything this producer has made: the session is not the one
      // this engine thinks it is.
      throw this.fail("offset-ahead");
    }
    const consumed = received - this.chunkStart;
    if (consumed > 0 && consumed < this.filled) {
      // Partial commit. The unacknowledged SUFFIX moves to the front and is
      // replayed byte-for-byte from the same buffer.
      this.buffer.copyWithin(0, consumed, this.filled);
    }
    this.filled -= consumed;
    this.chunkStart = received;
    this.committed = received;
    if (this.fence.valid) this.hooks.onProgress?.(this.committed, this.plan.cipherBytes);
  }

  /** Re-read the committed offset after a fault. False when the session is gone
   *  or the probe itself failed — neither of which a replay can proceed past. */
  private async resync(): Promise<boolean> {
    try {
      this.fence.assert();
      const request = this.transport.status(this.uploadId, this.signal);
      this.inFlight = request;
      const answer = await request;
      if (answer === "gone") throw this.fail("session-gone");
      this.consume(answer.received);
      return true;
    } catch (error) {
      if (error instanceof UploadFailure) {
        if (error.code === "session-gone" || error.code === "cancelled") throw error;
        // A regression or an overshoot discovered by the probe is as terminal
        // as one discovered by an append.
        if (error.code.startsWith("offset-")) throw error;
      }
      return false;
    } finally {
      this.inFlight = null;
    }
  }

  private retryable(failure: UploadFailure): boolean {
    if (failure.code === "network" || failure.code === "timeout") return true;
    if (failure.code !== "server-refused" || failure.status === null) return false;
    return failure.status === 429 || failure.status === 503 || failure.status >= 500;
  }

  /**
   * The producer says that was everything.
   *
   * Finalize is reached only from here, and only after the schedule is complete
   * AND the server's committed total equals the plan's exact ciphertext length.
   * An `end()` that arrives early is a refusal, not a short object.
   */
  async end(): Promise<UploadOutcome> {
    if (this.settled !== null) return this.settled;
    if (this.busy) throw this.fail("concurrent-feed");
    this.busy = true;
    try {
      this.fence.assert();
      if (this.expects !== null) throw this.fail("producer-short");
      await this.flush(true);
      if (this.committed !== this.plan.cipherBytes || this.filled !== 0) {
        throw this.fail("byte-total");
      }
      return await this.finalize();
    } catch (error) {
      throw this.absorb(error);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Claim the object, once.
   *
   * A transport fault gets a bounded retry, because the request may never have
   * reached the server. But the moment a 409 comes back, the session has been
   * claimed by SOMETHING — this client's own lost attempt, a racing one, or a
   * post-claim refusal that dropped the blob — and no request in this API can
   * say which. That is reported as `ambiguous`, never as success and never as a
   * clean failure.
   */
  private async finalize(): Promise<UploadOutcome> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      this.fence.assert();
      const first = !this.finalizeAttempted;
      this.finalizeAttempted = true;
      try {
        const request = this.transport.finalize(this.uploadId, this.signal);
        this.inFlight = request;
        const receipt = await request;
        if (receipt.outcome === "finalized") {
          return this.settle({
            status: "published",
            objectId: receipt.id,
            expiresAt: receipt.expiresAt,
          });
        }
        // 409. If this was our very FIRST attempt, something else claimed the
        // session — still ambiguous, because the claim may have been a success
        // whose object we cannot name.
        void first;
        return this.settle({ status: "ambiguous", code: "server-refused" });
      } catch (error) {
        const failure = this.classify(error);
        if (failure.code === "cancelled") {
          // A cancel during finalize cannot claim nothing happened.
          return this.settle({ status: "ambiguous", code: "cancelled" });
        }
        if (this.retryable(failure) && attempt < MAX_FINALIZE_ATTEMPTS) {
          await sleep(backoff(attempt), this.signal);
          continue;
        }
        // Every remaining case is a finalize whose outcome is unknown: the
        // request may have been claimed before the answer was lost.
        return this.settle({ status: "ambiguous", code: failure.code });
      } finally {
        this.inFlight = null;
      }
    }
  }

  /**
   * Stop, and join whatever is in flight.
   *
   * The distinction that matters: a cancel BEFORE finalize was attempted means
   * nothing was published — provably, because finalize is the only thing that
   * can publish. A cancel after it began is ambiguous. Neither claims the
   * server erased anything: there is no `DELETE /api/uploads/{id}`, so the
   * session is left to the server's own reaper.
   */
  async cancel(): Promise<UploadOutcome> {
    if (this.settled !== null) return this.settled;
    this.fence.revoke("cancelled");
    this.aborter.abort();
    // Joined, never abandoned: a live request holds a socket and a server-side
    // append, and resolving the caller while it runs would be a lie about what
    // has stopped.
    await Promise.allSettled([this.inFlight ?? Promise.resolve()]);
    return this.settle(
      this.finalizeAttempted
        ? { status: "ambiguous", code: "cancelled" }
        : { status: "cancelled" },
    );
  }

  /** Map a thrown value onto this engine's closed failure set. */
  private classify(error: unknown): UploadFailure {
    if (error instanceof UploadFailure) return error;
    if (error instanceof AuthorityRevoked) {
      return new UploadFailure(error.reason === "cancelled" ? "cancelled" : "authority-revoked");
    }
    if (error instanceof UploadTransportError) {
      switch (error.code) {
        case "network":
          return new UploadFailure("network");
        case "timeout":
          return new UploadFailure("timeout");
        case "cancelled":
          return new UploadFailure("cancelled");
        case "http":
          return new UploadFailure(error.status === 404 ? "session-gone" : "server-refused", error.status);
        default:
          return new UploadFailure("server-refused", error.status);
      }
    }
    return new UploadFailure("internal");
  }

  /** Record a failure as this job's outcome and return it to be thrown. */
  private fail(code: UploadFailureCode, status: number | null = null): UploadFailure {
    return new UploadFailure(code, status);
  }

  /**
   * Turn a thrown value into the settled outcome, without ever converting an
   * unknown publication into a clean failure.
   */
  private absorb(error: unknown): UploadFailure {
    const failure = this.classify(error);
    if (this.settled === null) {
      if (this.finalizeAttempted) {
        this.settle({ status: "ambiguous", code: failure.code });
      } else if (failure.code === "cancelled") {
        this.settle({ status: "cancelled" });
      } else {
        // Provably nothing was published: finalize is the only publisher and it
        // was never called.
        this.settle({ status: "failed", code: failure.code, status_: failure.status });
      }
    }
    return failure;
  }

  private settle(outcome: UploadOutcome): UploadOutcome {
    this.settled ??= outcome;
    this.fence.revoke("job-settled");
    return this.settled;
  }
}
