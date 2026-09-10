// Sending to your own devices, owned by the SHELL rather than by the page.
//
// ## This side is what encrypts
//
// The renderer holds the user's `File` objects — from `<input>`,
// `webkitdirectory` and drag-drop, all of which open the native Windows pickers
// while granting no arbitrary-path read channel — and it runs the PRODUCTION
// shared `encryptFiles`. That is what keeps a path reader out of the main
// process, and it is why this delivery's content key crosses main→renderer.
//
// What follows from holding that key: it is never rendered, never logged, never
// put in a message, and never kept after the job settles. The only thing done
// with it is `importStoreKey`.
//
// A MESSAGE is encrypted here too, and main is told a byte LENGTH rather than
// the text. There is deliberately no channel that carries the message itself.
//
// ## One target at a time, and why
//
// A delivery is sealed to ONE device's key, so N targets are N jobs with N
// content keys and N uploads — there is no broadcast in this protocol. They run
// in sequence rather than at once: the frames come from one producer reading
// the same files, and running four uploads concurrently would multiply the
// memory and the bandwidth without making any single one arrive sooner. Each
// target therefore has its own status, and one failing does not cancel the rest.
//
// ## The frozen array is the contract
//
// `entries` and `encryptFiles` MUST see the same array, in the same order: main
// plans the manifest from the first and the engine checks the frames the second
// produces against that plan, file index by file index and sequence by
// sequence. So the picked files are frozen when they are picked, and a re-pick
// starts a FRESH job with a FRESH key — never a re-encryption of different
// bytes under a key that has already been used.

import { encryptFiles, importStoreKey, decodeKey } from "../../../../../web/src/lib/store-crypto";
import type { FrameExpectation, InboxSendStart, InboxView } from "../../shared/ipc-contract.js";
import type { InboxSendTargetView, InboxSendView } from "../../main/features/inbox-send.js";

/** What `inboxSendTargets` answers. */
export type InboxSendTargetsAnswer =
  | { readonly ok: true; readonly targets: readonly InboxSendTargetView[] }
  | { readonly ok: false; readonly refusal: string };

/** The preload surface this controller uses. Declared, not inferred. */
export interface InboxSendBridge {
  targets(): Promise<InboxSendTargetsAnswer>;
  start(payload: {
    target: string;
    kind: "file" | "text";
    entries: readonly { path: string; size: number }[];
  }): Promise<InboxSendStart>;
  feed(payload: {
    jobId: string;
    fileIndex: number;
    seq: number;
    bytes: Uint8Array;
  }): Promise<{ expects: FrameExpectation | null }>;
  end(payload: { jobId: string }): Promise<InboxSendView>;
  cancel(payload: { jobId: string }): Promise<InboxSendView>;
  converge(payload: { jobId: string }): Promise<InboxSendView>;
  onProgress(cb: (payload: unknown) => void): () => void;
  onOutcome(cb: (payload: unknown) => void): () => void;
}

/** What one target's delivery is doing. Closed states; never a server string. */
export type TargetPhase = "idle" | "queued" | "sending" | "settled";

export interface TargetStatus {
  readonly phase: TargetPhase;
  /** The job, while there is one. Needed for cancel and converge. */
  readonly jobId: string | null;
  readonly committed: number;
  readonly total: number;
  /** The terminal view, once there is one. */
  readonly view: InboxSendView | null;
  /** A refusal that happened before a job existed. */
  readonly refusal: string | null;
}

/** One delivery this page could not establish the outcome of. */
export interface UnresolvedSend {
  readonly jobId: string;
  readonly deviceID: string;
  /** The device's name at the time, so a row can still be read afterwards. */
  readonly name: string;
  readonly view: InboxSendView;
}

const IDLE: TargetStatus = {
  phase: "idle",
  jobId: null,
  committed: 0,
  total: 0,
  view: null,
  refusal: null,
};

export class InboxSendController {
  /** The devices this account has, as the picker sees them. Never keys. */
  targets = $state<readonly InboxSendTargetView[]>([]);
  /**
   * The list could not be READ.
   *
   * Distinct from "you have no other devices", and the distinction is the
   * point: showing an empty picker over a failed request tells the user they
   * have nothing to send to, which may be the opposite of the truth.
   */
  targetsUnavailable = $state(false);
  /** Why, when it could not be read. A closed token, rendered as a sentence. */
  targetsRefusal = $state<string | null>(null);

  /** Which devices the user chose. Ids only. */
  selected = $state<readonly string[]>([]);
  /** Files or a message. One delivery is one kind — the manifest says so. */
  mode = $state<"files" | "text">("files");
  /** Frozen when picked. The SAME array `encryptFiles` walks. */
  files = $state<readonly File[]>([]);
  message = $state("");

  busy = $state(false);
  /** Per target, keyed by device id. Cleared by a new pick or a new send. */
  status = $state<Readonly<Record<string, TargetStatus>>>({});
  /**
   * Deliveries nobody can account for, keyed by JOB rather than by device.
   *
   * Separate from `status` on purpose, and the separation is the fix. The rows
   * describe the CURRENT selection and are replaced whenever the user picks or
   * sends again; an unresolved delivery is not part of any current selection —
   * it is a thing that may have happened, and the job id here is the only
   * handle that can still establish it. Keeping it inside `status` meant a
   * second send to the same device silently overwrote the record of the first,
   * and the user was left with a delivery that might be live, no way to ask,
   * and nothing on screen saying so.
   *
   * Entries leave only when a converge ESTABLISHES something.
   */
  unresolvedSends = $state<readonly UnresolvedSend[]>([]);

  /** The account generation this state belongs to. */
  #epoch = 0;
  /**
   * Which attempt is current.
   *
   * Bumped by every send, every cancel and every account change. A delayed
   * result — a `feed` in flight, a `finally` from a cancelled attempt, a target
   * list read issued under the previous account — checks it before touching
   * anything.
   */
  #attempt = 0;
  /** The job the producer is feeding right now, so a cancel can name it. */
  #running: string | null = null;
  /** Devices with a re-check in flight. `$state` so the button can disable. */
  #checking = $state<ReadonlySet<string>>(new Set());
  /** Progress frames that arrived before their `start` answered. */
  readonly #early = new Map<string, { committed: number; total: number }>();
  readonly #stop: Array<() => void> = [];

  constructor(
    private readonly bridge: InboxSendBridge,
    /** The Inbox state push, for the ACCOUNT generation and nothing else. */
    subscribeState: (cb: (payload: unknown) => void) => () => void,
  ) {
    this.#stop.push(
      bridge.onProgress((payload) => {
        const shaped = payload as { jobId?: unknown; committed?: unknown; total?: unknown };
        if (typeof shaped.jobId !== "string") return;
        if (typeof shaped.committed !== "number" || typeof shaped.total !== "number") return;
        const target = this.targetOf(shaped.jobId);
        if (target === null) {
          // The first committed frame can beat `start`'s answer back to this
          // side. Held, bounded, and applied when the job is known.
          this.#early.set(shaped.jobId, { committed: shaped.committed, total: shaped.total });
          while (this.#early.size > 8) {
            const oldest = this.#early.keys().next().value;
            if (oldest === undefined) break;
            this.#early.delete(oldest);
          }
          return;
        }
        this.patch(target, { committed: shaped.committed, total: shaped.total });
      }),
    );
    this.#stop.push(
      bridge.onOutcome((payload) => {
        const shaped = payload as { jobId?: unknown; outcome?: unknown };
        if (typeof shaped.jobId !== "string") return;
        const target = this.targetOf(shaped.jobId);
        if (target === null) return;
        // Pushed as well as returned, because a delivery outlives the call that
        // started it: a sign-out or a quit drain settles one with nobody
        // awaiting `end`.
        //
        // A late `unknown` may NOT overturn a definite answer. Main coalesces
        // its own converges, but an outcome push and a returned view are two
        // paths to the same row, and only one of them can be the later one.
        const pushed = shaped.outcome as InboxSendView;
        const held = this.status[target]?.view ?? null;
        if (pushed.kind === "unknown" && held !== null && held.kind !== "unknown") return;
        this.patch(target, { phase: "settled", view: pushed });
      }),
    );
    this.#stop.push(
      subscribeState((payload) => {
        const shaped = payload as InboxView | null;
        if (shaped === null || typeof shaped !== "object") return;
        if (typeof shaped.epoch !== "number") return;
        if (shaped.epoch === this.#epoch) return;
        this.forgetAccount(shaped.epoch);
      }),
    );
  }

  /**
   * The account moved. Drop everything that belonged to the old one, NOW.
   *
   * The target list goes first: those are another account's devices, and a
   * picker still offering them would let the user address a delivery to a
   * machine this account does not have. The picked FILES stay — they were never
   * sent anywhere, and they are the user's own choice rather than the previous
   * account's data.
   */
  forgetAccount(epoch: number): void {
    this.#epoch = epoch;
    this.#attempt += 1;
    this.#running = null;
    this.#early.clear();
    this.targets = [];
    this.targetsUnavailable = false;
    this.targetsRefusal = null;
    this.selected = [];
    this.status = {};
    // Another account's deliveries, and its jobs are not this account's to ask
    // about — main refuses a converge across an account change anyway.
    this.unresolvedSends = [];
    this.#checking = new Set();
    this.busy = false;
    void this.refreshTargets();
  }

  /** Whether a delayed result still belongs to the current attempt. */
  #current(attempt: number, epoch: number): boolean {
    return this.#attempt === attempt && this.#epoch === epoch;
  }

  private targetOf(jobId: string): string | null {
    for (const [deviceID, entry] of Object.entries(this.status)) {
      if (entry.jobId === jobId) return deviceID;
    }
    return null;
  }

  private patch(deviceID: string, over: Partial<TargetStatus>): void {
    const current = this.status[deviceID] ?? IDLE;
    const next = { ...current, ...over };
    this.status = { ...this.status, [deviceID]: next };
    // An outcome nobody can account for is remembered OUTSIDE the rows, so the
    // next pick or send cannot take the handle away with the selection.
    if (next.view?.kind === "unknown" && next.jobId !== null) this.remember(next.jobId, deviceID, next.view);
  }

  private remember(jobId: string, deviceID: string, view: InboxSendView): void {
    if (this.unresolvedSends.some((entry) => entry.jobId === jobId)) return;
    const name = this.targets.find((target) => target.deviceID === deviceID)?.name ?? "";
    this.unresolvedSends = [...this.unresolvedSends, { jobId, deviceID, name, view }];
  }

  /** Forget one, because it was finally established. Never because time passed. */
  private established(jobId: string): void {
    this.unresolvedSends = this.unresolvedSends.filter((entry) => entry.jobId !== jobId);
  }

  async refreshTargets(): Promise<void> {
    const attempt = this.#attempt;
    const epoch = this.#epoch;
    const answer = await this.bridge
      .targets()
      .catch(() => ({ ok: false as const, refusal: "unavailable" }));
    if (!this.#current(attempt, epoch)) return;
    if (!answer.ok) {
      this.targetsUnavailable = true;
      this.targetsRefusal = answer.refusal;
      return;
    }
    this.targetsUnavailable = false;
    this.targetsRefusal = null;
    this.targets = answer.targets;
    // A device that went away, or turned receiving off, must not stay selected:
    // the send would be refused at the far end and the user would have been
    // looking at a tick next to a machine that cannot take it.
    const eligible = new Set(answer.targets.filter((t) => t.eligible).map((t) => t.deviceID));
    this.selected = this.selected.filter((id) => eligible.has(id));
  }

  toggle(deviceID: string): void {
    if (this.busy) return;
    this.selected = this.selected.includes(deviceID)
      ? this.selected.filter((id) => id !== deviceID)
      : [...this.selected, deviceID];
  }

  /** The user picked files or a folder. A new pick replaces the last one. */
  pick(files: readonly File[]): void {
    if (this.busy) return;
    // Frozen here, so the array `encryptFiles` walks is the array the manifest
    // was planned from.
    this.files = Object.freeze([...files]);
    this.mode = "files";
    this.clearStatuses();
  }

  clear(): void {
    if (this.busy) return;
    this.files = [];
    this.message = "";
    this.clearStatuses();
  }

  /**
   * Clear last send's rows — except the ones nobody can account for.
   *
   * Settled rows go with the selection they described: leaving "Delivered"
   * beside a new pick reads as THIS one having arrived.
   *
   * An UNRESOLVED row does not go. It is the only handle on a delivery that may
   * be live: the job id it carries is what `converge` replays, and clearing it
   * left the user with a delivery that might have happened, no way to ask
   * again, and nothing on screen saying so. Picking new files is not an answer
   * to "did the last one arrive?".
   */
  private clearStatuses(): void {
    const next: Record<string, TargetStatus> = {};
    for (const [deviceID, entry] of Object.entries(this.status)) {
      if (entry.view?.kind === "unknown") next[deviceID] = entry;
    }
    this.status = next;
  }

  /** Deliveries this page still cannot account for. Rendered as their own. */
  get unresolved(): readonly UnresolvedSend[] {
    return this.unresolvedSends;
  }

  get totalBytes(): number {
    return this.files.reduce((sum, file) => sum + file.size, 0);
  }

  /** Whether there is anything to send at all. */
  get ready(): boolean {
    if (this.selected.length === 0) return false;
    return this.mode === "text" ? this.message.trim().length > 0 : this.files.length > 0;
  }

  /**
   * Encrypt and deliver, one target at a time.
   *
   * Each target is a separate job with its OWN content key, because a delivery
   * is sealed to one device. A target that refuses does not stop the others:
   * "your laptop has receiving off" is not a reason to abandon the delivery to
   * your desktop.
   */
  async send(): Promise<void> {
    if (this.busy || !this.ready) return;
    const attempt = ++this.#attempt;
    const epoch = this.#epoch;
    this.busy = true;

    const targets = [...this.selected];
    const queued: Record<string, TargetStatus> = {};
    for (const id of targets) queued[id] = { ...IDLE, phase: "queued" };
    this.status = queued;

    // Built ONCE, outside the loop: every target sends the same bytes, and
    // re-reading the message per target would let it change under the manifest
    // one job already declared.
    const payload = this.payload();
    try {
      for (const deviceID of targets) {
        if (!this.#current(attempt, epoch)) return;
        await this.deliver(deviceID, payload, attempt, epoch);
      }
    } finally {
      // GUARDED: an older attempt's `finally` must not clear `busy` for a newer
      // one that has already started.
      if (this.#current(attempt, epoch)) {
        this.busy = false;
        this.#running = null;
      }
    }
  }

  /** The immutable selection this send delivers. */
  private payload(): { readonly kind: "file" | "text"; readonly files: readonly File[] } {
    if (this.mode !== "text") return { kind: "file", files: this.files };
    // The message is encrypted on THIS side like any other content. Main is
    // told its byte length and receives frames; there is no channel that
    // carries the text.
    const bytes = new TextEncoder().encode(this.message);
    return { kind: "text", files: [new File([bytes], "message")] };
  }

  private async deliver(
    deviceID: string,
    payload: { readonly kind: "file" | "text"; readonly files: readonly File[] },
    attempt: number,
    epoch: number,
  ): Promise<void> {
    const picked = payload.files;
    const entries = picked.map((file) => ({
      // `webkitRelativePath` when the user picked a folder, so the structure
      // they chose is preserved; the leaf name otherwise. Read defensively:
      // Chromium always defines it, but it is a `webkit`-prefixed extension and
      // Node's `File` does not have it at all — without this the controller
      // could not be driven outside a browser, which is where its ordering and
      // cancellation races are actually testable.
      path: (file.webkitRelativePath ?? "").length > 0 ? file.webkitRelativePath : file.name,
      size: file.size,
    }));

    let started: InboxSendStart;
    try {
      started = await this.bridge.start({ target: deviceID, kind: payload.kind, entries });
    } catch {
      if (this.#current(attempt, epoch)) this.patch(deviceID, { phase: "settled", refusal: "internal" });
      return;
    }
    // Cancelled, or the account changed, while `start` was in flight. The job
    // exists in main and must be stopped rather than left running for a page
    // that has moved on.
    if (!this.#current(attempt, epoch)) {
      if (started.ok) void this.bridge.cancel({ jobId: started.jobId }).catch(() => null);
      return;
    }
    if (!started.ok) {
      // The CODE when there is one: "at capacity" covers two different
      // situations — too many running, and too many unaccounted for — and only
      // one of them is fixed by waiting.
      this.patch(deviceID, { phase: "settled", refusal: started.code ?? started.refusal });
      return;
    }

    this.#running = started.jobId;
    const early = this.#early.get(started.jobId);
    this.#early.delete(started.jobId);
    this.patch(deviceID, {
      phase: "sending",
      jobId: started.jobId,
      committed: early?.committed ?? 0,
      total: early?.total ?? started.cipherBytes,
      view: null,
      refusal: null,
    });

    try {
      // The key is used and never kept: no field holds it, and it is not put on
      // screen, in a message or in a log.
      const key = await importStoreKey(decodeKey(started.contentKey));
      let expects = started.expects;
      for await (const bytes of encryptFiles([...picked], key)) {
        // Checked every frame: a cancel or an account change mid-upload stops
        // the producer rather than encrypting the rest for nobody.
        if (!this.#current(attempt, epoch) || this.#running !== started.jobId) return;
        if (expects === null) break;
        const answer = await this.bridge.feed({
          jobId: started.jobId,
          fileIndex: expects.fileIndex,
          seq: expects.seq,
          bytes,
        });
        expects = answer.expects;
      }
      if (!this.#current(attempt, epoch) || this.#running !== started.jobId) return;
      const view = await this.bridge.end({ jobId: started.jobId });
      if (!this.#current(attempt, epoch)) return;
      this.patch(deviceID, { phase: "settled", view });
    } catch {
      // A throw on this side is not evidence about the server. Main reports the
      // durable outcome; asking for it is more truthful than inventing one.
      const view = await this.bridge.cancel({ jobId: started.jobId }).catch(() => null);
      if (this.#current(attempt, epoch)) {
        this.patch(deviceID, { phase: "settled", ...(view === null ? { refusal: "internal" } : { view }) });
      }
    } finally {
      if (this.#running === started.jobId) this.#running = null;
    }
  }

  /**
   * The user pressed Cancel.
   *
   * Works BEFORE a job id exists, which is when a person is most likely to
   * press it: the intent is recorded by bumping the attempt, and `deliver` sees
   * it the moment `start` answers and cancels the job main has just created.
   */
  async cancel(): Promise<void> {
    if (!this.busy) return;
    const running = this.#running;
    this.#attempt += 1;
    this.#running = null;
    this.busy = false;
    const pending: Record<string, TargetStatus> = { ...this.status };
    for (const [deviceID, entry] of Object.entries(pending)) {
      if (entry.phase === "queued") {
        // Never started. Reported as cancelled rather than left saying
        // "waiting" over a send nobody is going to make.
        pending[deviceID] = { ...entry, phase: "settled", view: { kind: "cancelled", state: null } };
      }
    }
    this.status = pending;
    if (running === null) return;
    const view = await this.bridge.cancel({ jobId: running }).catch(() => null);
    const target = this.targetOf(running);
    if (target !== null && view !== null) this.patch(target, { phase: "settled", view });
  }

  /**
   * Ask again what an UNKNOWN delivery actually did.
   *
   * Convergence, never a fresh send. An unknown outcome means a delivery MAY be
   * live: the plan and its idempotency key were retained precisely so the same
   * attempt can be replayed, and sending again would deliver the same thing
   * twice.
   */
  async converge(deviceID: string): Promise<void> {
    // The OLDEST unresolved delivery to this device, ahead of the current row.
    //
    // A second send to the same device leaves two things that could be meant by
    // "check again", and only one of them needs establishing: the older one is
    // the delivery that may have happened and cannot otherwise be found. The
    // current row, if it is also unresolved, is in the history too — so this is
    // an ORDER, not a choice between them.
    const oldest = this.unresolvedSends.find((held) => held.deviceID === deviceID);
    if (oldest !== undefined) {
      await this.convergeJob(oldest.jobId, deviceID);
      return;
    }
    const entry = this.status[deviceID];
    if (entry?.jobId == null || entry.view?.kind !== "unknown") return;
    // One at a time per device. Two presses of "Check again" raced, and the
    // slower answer won by arrival order — so a re-check that established
    // `delivered` could be overwritten by one that established nothing.
    await this.convergeJob(entry.jobId, deviceID);
  }

  /**
   * Ask again about ONE delivery, named by its job.
   *
   * Job-keyed because that is what a converge actually replays: the durable
   * plan and its idempotency key. A device can have more than one unresolved
   * delivery, and "check the device" is not a question the protocol answers.
   */
  async convergeJob(jobId: string, deviceID?: string): Promise<void> {
    // One at a time per JOB. Two presses raced, and the slower answer won by
    // arrival order — so a re-check that established `delivered` could be
    // overwritten by one that established nothing.
    if (this.#checking.has(jobId)) return;
    this.#checking = new Set([...this.#checking, jobId]);
    const attempt = this.#attempt;
    const epoch = this.#epoch;
    try {
      const view = await this.bridge.converge({ jobId }).catch(() => null);
      if (!this.#current(attempt, epoch) || view === null) return;
      if (view.kind !== "unknown") {
        // Established at last. It leaves the history for this reason and no
        // other — never because a newer send replaced it.
        this.established(jobId);
      }
      const row = deviceID ?? this.unresolvedSends.find((held) => held.jobId === jobId)?.deviceID;
      if (row === undefined) return;
      // Established is established. A later attempt that could not establish
      // anything says nothing about what an earlier one proved.
      const held = this.status[row]?.view ?? null;
      if (view.kind === "unknown" && held !== null && held.kind !== "unknown") return;
      // Only the row that still NAMES this job may be rewritten by it: a newer
      // send to the same device owns that row now.
      if (this.status[row] !== undefined && this.status[row]?.jobId !== jobId) return;
      this.patch(row, { phase: "settled", view });
    } finally {
      const next = new Set(this.#checking);
      next.delete(jobId);
      this.#checking = next;
    }
  }

  /** Whether a re-check is running for a job — or for a device's oldest one. */
  checking(idOrDevice: string): boolean {
    if (this.#checking.has(idOrDevice)) return true;
    const oldest = this.unresolvedSends.find((held) => held.deviceID === idOrDevice);
    return oldest !== undefined && this.#checking.has(oldest.jobId);
  }

  dispose(): void {
    this.#attempt += 1;
    for (const stop of this.#stop.splice(0)) stop();
  }
}
