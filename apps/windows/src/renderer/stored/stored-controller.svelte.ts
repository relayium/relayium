// One stored receive, owned by the SHELL rather than by a page.
//
// ## Why this is not component state
//
// A page unmounts the moment the user looks at another row. Held in the
// component, a running transfer's job id, its progress and its outcome all go
// with it — the bar restarts at nothing, Cancel has nothing to name, and the
// receipt for a transfer that finished while the user was on another page is
// never shown at all. The draft link goes too, which is exactly the thing
// someone switches away to copy again.
//
// So the controller lives as long as the app does. The page renders it.
//
// ## The race this closes
//
// `receive()` acknowledges ADMISSION and the events arrive separately. For a
// fast failure — a malformed link, a 404, a zero-byte object — the outcome can
// be pushed before the acknowledgement is even delivered, so a listener that
// only matches against the id it is about to learn discards the answer and
// waits forever. After the id is known this asks main for the retained result,
// and every path in and out is fenced on the SAME id, so a late answer for a
// job that has been replaced cannot clear the new one.
//
// PROGRESS has the identical race and needs the identical answer. The first
// frame is emitted the moment the transfer starts moving, which is often before
// the acknowledgement has crossed the process boundary; dropping it left the
// bar at zero until the next frame, and a transfer that reports once — a small
// object, a stalled one — left it at zero for good. Only the LAST frame per job
// is held, because a progress frame supersedes its predecessor rather than
// adding to it, and it is fenced on the same id: a frame for a job that has
// been replaced must never move the bar for the one running now.

import type { MessageKey } from "../i18n/messages.js";

export interface StoredFailure {
  readonly code: string;
  readonly residue: boolean;
  readonly retryable: boolean;
  readonly cleanupTicket: string | null;
  readonly published: "none" | "unknown";
}

export type StoredReport =
  | {
      readonly status: "saved";
      readonly publishedCount: number;
      readonly residue: boolean;
      readonly cleanupTicket: string | null;
    }
  | {
      readonly status: "partially-saved";
      readonly publishedCount: number;
      readonly total: number;
      readonly residue: boolean;
      readonly cleanupTicket: string | null;
    }
  | { readonly status: "declined" }
  | { readonly status: "cancelled"; readonly residue: boolean; readonly cleanupTicket: string | null }
  | { readonly status: "failed"; readonly failure: StoredFailure };

export type StoredStartResult =
  | { readonly ok: true; readonly jobId: string }
  | { readonly ok: false; readonly refusal: string };

export interface StoredBridge {
  receive(payload: { link: string }): Promise<StoredStartResult>;
  cancel(payload: { jobId: string }): Promise<{ cancelled: boolean }>;
  result(payload: { jobId: string }): Promise<{ result: { ok: boolean; report?: StoredReport } | null }>;
  inventory(): Promise<{ active: number; retained: readonly string[]; retrying: readonly string[] }>;
  retryCleanup(payload: { ticket: string }): Promise<{ outcome: string; residue?: boolean }>;
  onProgress(cb: (payload: unknown) => void): () => void;
  onOutcome(cb: (payload: unknown) => void): () => void;
}

/** How many unacknowledged jobs' events are held at once, per kind. */
const MAX_EARLY_HELD = 8;

export class StoredController {
  /** The link box. Survives navigation, and is counted as unfinished work. */
  link = $state("");
  busy = $state(false);
  received = $state(0);
  total = $state(0);
  report = $state<StoredReport | null>(null);
  refusal = $state<string | null>(null);
  retained = $state<readonly string[]>([]);
  cleanupNote = $state<MessageKey | null>(null);
  /** Set when a link arrived from outside, so the page can say where it came from. */
  fromDeepLink = $state(false);

  #jobId: string | null = null;
  /** Outcomes that arrived before their acknowledgement did. */
  readonly #early = new Map<string, StoredReport>();
  /** The last progress frame per job that arrived before its acknowledgement. */
  readonly #earlyProgress = new Map<string, { received: number; total: number }>();
  readonly #stop: Array<() => void> = [];

  constructor(private readonly bridge: StoredBridge) {
    // Subscribed ONCE, for the life of the app. A subscription rebuilt whenever
    // the job id changed would be torn down and replaced in the same tick the
    // answer arrives in.
    this.#stop.push(
      bridge.onOutcome((payload) => {
        const shaped = payload as { jobId?: unknown; outcome?: unknown };
        if (typeof shaped.jobId !== "string") return;
        const outcome = shaped.outcome as { ok?: unknown; report?: StoredReport } | undefined;
        if (outcome?.ok !== true || outcome.report === undefined) return;
        this.#deliver(shaped.jobId, outcome.report);
      }),
    );
    this.#stop.push(
      bridge.onProgress((payload) => {
        const shaped = payload as { jobId?: unknown; received?: unknown; total?: unknown };
        if (typeof shaped.jobId !== "string") return;
        if (typeof shaped.received !== "number" || typeof shaped.total !== "number") return;
        if (this.#jobId === null) {
          // Not yet acknowledged. Held, bounded, last frame wins.
          this.#remember(this.#earlyProgress, shaped.jobId, {
            received: shaped.received,
            total: shaped.total,
          });
          return;
        }
        // The identity fence, unchanged: a frame for a job that has been
        // replaced must not move the bar for the one running now.
        if (shaped.jobId !== this.#jobId) return;
        this.received = shaped.received;
        this.total = shaped.total;
      }),
    );
    void this.refreshRetained();
  }

  /** The job the page can cancel right now, or null. */
  get jobId(): string | null {
    return this.#jobId;
  }

  dispose(): void {
    for (const stop of this.#stop) stop();
    this.#stop.length = 0;
  }

  /** A link from the OS. It lands in the box; it starts nothing. */
  offer(link: string): void {
    if (this.busy) return;
    this.link = link;
    this.fromDeepLink = true;
    this.report = null;
    this.refusal = null;
  }

  async open(): Promise<void> {
    const value = this.link.trim();
    if (value === "" || this.busy) return;
    this.busy = true;
    this.report = null;
    this.refusal = null;
    this.received = 0;
    this.total = 0;

    let started: StoredStartResult;
    try {
      started = await this.bridge.receive({ link: value });
    } catch {
      // A rejected invoke is a refusal without a code. Never an error object on
      // screen, which is where a path would arrive.
      this.refusal = "unavailable";
      this.busy = false;
      return;
    }
    if (!started.ok) {
      this.refusal = started.refusal;
      this.busy = false;
      return;
    }

    this.#jobId = started.jobId;

    // The answer may already have arrived — a malformed link, a 404, a
    // zero-byte object all finish faster than this acknowledgement travels.
    const early = this.#early.get(started.jobId);
    if (early) {
      this.#early.delete(started.jobId);
      this.#earlyProgress.delete(started.jobId);
      this.#settle(started.jobId, early);
      return;
    }

    // And it may already have MOVED. Applied after the outcome check, because
    // a job that has already ended has no progress worth showing.
    const moved = this.#earlyProgress.get(started.jobId);
    if (moved) {
      this.#earlyProgress.delete(started.jobId);
      this.received = moved.received;
      this.total = moved.total;
    }

    // And it may have arrived while nothing was listening at all. Asking is the
    // fallback the push does not cover; the id fence is what stops a stale
    // answer landing on a job that has since been replaced.
    const asked = await this.bridge.result({ jobId: started.jobId }).catch(() => null);
    const report = asked?.result?.ok === true ? asked.result.report : undefined;
    if (report !== undefined) this.#settle(started.jobId, report);
  }

  async cancel(): Promise<void> {
    const id = this.#jobId;
    if (id === null) return;
    await this.bridge.cancel({ jobId: id }).catch(() => undefined);
  }

  async retryCleanup(ticket: string): Promise<void> {
    this.cleanupNote = null;
    const outcome = await this.bridge.retryCleanup({ ticket }).catch(() => ({ outcome: "unknown" }));
    // Three answers, not two. `unavailable` means main refused to START a
    // teardown — it is quiescing or gone — so saying "still could not be
    // cleaned up" would report a failure of a helper nobody asked.
    this.cleanupNote =
      outcome.outcome === "clean"
        ? "storedRetainedClean"
        : outcome.outcome === "unavailable"
          ? "storedRetainedUnavailable"
          : "storedRetainedStuck";
    await this.refreshRetained();
  }

  async refreshRetained(): Promise<void> {
    const inventory = await this.bridge.inventory().catch(() => null);
    if (inventory) this.retained = inventory.retained;
  }

  /** An outcome for a job that may or may not be the one on screen. */
  #deliver(jobId: string, report: StoredReport): void {
    if (this.#jobId === null) {
      // Not yet acknowledged. Held, bounded, until `open` learns the id.
      this.#remember(this.#early, jobId, report);
      return;
    }
    this.#settle(jobId, report);
  }

  /**
   * Hold one value per job, oldest-first, bounded.
   *
   * Bounded because nothing arriving before an acknowledgement is guaranteed to
   * ever be claimed: a job whose page navigated away leaves its entry behind,
   * and an unbounded map of them is a leak. Counts and closed codes only, so
   * there is nothing here to protect beyond its size.
   */
  #remember<T>(held: Map<string, T>, jobId: string, value: T): void {
    held.set(jobId, value);
    while (held.size > MAX_EARLY_HELD) {
      const oldest = held.keys().next().value;
      if (oldest === undefined) break;
      held.delete(oldest);
    }
  }

  #settle(jobId: string, report: StoredReport): void {
    // The identity fence. An answer for a job that has been replaced must not
    // clear the one running now.
    if (jobId !== this.#jobId) return;
    this.#jobId = null;
    this.#earlyProgress.delete(jobId);
    this.report = report;
    this.busy = false;
    this.fromDeepLink = false;
    // The box held a key; there is no reason to keep it once it has been used.
    if (report.status === "saved") this.link = "";
    void this.refreshRetained();
  }
}
