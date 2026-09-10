// Who owns a stored receive, and for how long.
//
// `stored/receive.ts` owns one transfer, completely and correctly. It does not
// own the SET of them: it is a free function with no registry, no cap, no
// account and no document, so nothing there can be cancelled by a reload, a
// sign-out or a quit. That is this file's whole job, and it is the same job
// `AppService` does for LAN leases — deliberately the same shape, because the
// failures are the same ones.
//
// ## What it holds
//
// A job is registered SYNCHRONOUSLY, before the first await, so a revocation
// that arrives while the link is being fetched finds it. It carries the document
// generation it started under — and only that; there is no account fence here,
// for the reason `StoredReceiveAuthority` gives. Every match is aborted
// synchronously and only then joined: one loop that awaited each teardown would
// leave later jobs running under a document that had already gone away.
//
// ## What it does not do
//
// It does not parse links (that is `parseStoredLink`, the single authority), it
// does not choose destinations (the host's native picker does, after the
// manifest is judged), and it never sees a filesystem path from the renderer.

import {
  receiveStoredLink,
  type DestinationGrant,
  type StoredReceiveOptions,
} from "../stored/receive.js";
import { storedCleanups, type CleanupRegistry, type CleanupRetryOutcome } from "../stored/cleanup.js";
import type { StoredObjectFacts, StoredReceiveReport } from "../stored/report.js";

/**
 * The longest link this service will even look at.
 *
 * Restated rather than imported: `stored/link.ts` keeps its own bound as an
 * internal constant, and a backend file is not mine to change. Both refuse the
 * same input; this one refuses it before the string is handed on at all, which
 * is what an admission check is for. If the parser's bound ever grows, this one
 * refusing first is the safe direction.
 */
const MAX_ACCEPTED_LINK_LENGTH = 2048;

/**
 * How many receives may run at once.
 *
 * Small on purpose. Each one holds a helper child process, a staging directory
 * and an open body; the user chose them one link at a time, and a page that
 * could start twenty has a bug rather than a feature. Refused at admission,
 * never by evicting one that is already running.
 */
export const MAX_ACTIVE_STORED_RECEIVES = 4;

/** How many finished outcomes are kept for a page that missed the push. */
const MAX_REMEMBERED_OUTCOMES = 8;

/**
 * Who a receive belongs to — and deliberately NOT which account.
 *
 * A public stored link is anonymous: there is no bearer on the request and no
 * key custody in this process, so an account change is not a change of
 * authority over it. The shipped Mac composes it the same way —
 * `CloudDownloadModel` holds no account, session or bearer, and
 * `RelayiumApp.swift:888` cancels it from exactly one place, the quit guard's
 * `cancelTransfers`; no sign-out path touches it.
 *
 * So a download survives signing out and signing in as somebody else, in the
 * same document. What ends it is the document going away, an explicit cancel,
 * or quit. Coupling it to the epoch merely because main happens to know one
 * would kill a stranger's download because the user logged in.
 *
 * Stored SEND, history and the Device Inbox are the opposite case: they carry a
 * bearer and account-scoped custody, and their account fences are mandatory.
 */
export interface StoredReceiveAuthority {
  /** The document that asked. */
  readonly document: number;
}

export interface StoredReceiveStart {
  readonly link: string;
  readonly authority: StoredReceiveAuthority;
}

export type StoredReceiveRefusal =
  /** More receives than this process will run at once. */
  | "at-capacity"
  /** The link is longer than any link this product makes. Refused before it is
   *  parsed, and before anything is fetched. */
  | "too-long"
  /** Not admitting: a quit is being decided, or this process is going away. */
  | "unavailable";

export type StoredReceiveOutcome =
  | { readonly ok: true; readonly report: StoredReceiveReport }
  | { readonly ok: false; readonly refusal: StoredReceiveRefusal };

/**
 * What asking a retained destination to tear down again answers.
 *
 * `unavailable` is this service's addition to the registry's own outcomes, and
 * it means the attempt was REFUSED rather than made. It cannot be reported as
 * either of the registry's near-misses without lying: `unknown` says nobody
 * holds the ticket, and `uncertain` says a teardown was attempted and did not
 * confirm. Nothing was attempted and nothing was given up — the ticket is still
 * held, still counted in the inventory, and retryable again after `resume`.
 */
export type StoredCleanupRetryResult =
  | CleanupRetryOutcome
  | { readonly outcome: "unavailable" };

/**
 * Which job, and which document asked for it.
 *
 * The generation travels WITH the job rather than being read back from the host
 * when something is delivered. A host that read its current generation at
 * delivery time would answer "is there a document?" when the question is "is it
 * still the one that asked?", and a reload's replacement would be handed the
 * retired document's progress and its outcome.
 */
export interface StoredJobRef {
  readonly id: string;
  /** The document generation this job was admitted under. */
  readonly document: number;
}

export interface StoredReceiveDeps {
  /**
   * The native folder picker, asked only after the manifest is judged.
   *
   * Returning null is a decline, not a failure. The host is also where the
   * window lives, which is why this is injected rather than reached for.
   */
  pickDestination(facts: StoredObjectFacts, job: StoredJobRef): Promise<DestinationGrant | null>;
  /** Cumulative decrypted bytes, for the page that asked. */
  onProgress?(job: StoredJobRef, received: number, total: number): void;
  /** How a job ended, pushed as soon as it does. */
  onOutcome?(job: StoredJobRef, outcome: StoredReceiveOutcome): void;
  /** Test seam. Production is the imported `receiveStoredLink`. */
  receive?(options: StoredReceiveOptions): Promise<StoredReceiveReport>;
  /** Test seam. Production is the process-wide registry. */
  cleanups?: CleanupRegistry;
  /** Passed through to the receive, for tests only. */
  transport?: StoredReceiveOptions["transport"];
  destination?: StoredReceiveOptions["destination"];
  runtime?: StoredReceiveOptions["runtime"];
  hosts?: StoredReceiveOptions["hosts"];
}

interface Job {
  readonly ref: StoredJobRef;
  readonly control: AbortController;
  /** Never rejects. Joined by a teardown to know the work has STOPPED. */
  readonly settled: Promise<void>;
}

/** What is live and what was left behind, for the quit prompt and the page. */
export interface StoredReceiveInventory {
  readonly active: number;
  /** Retained cleanup tickets: destinations whose teardown did not settle. */
  readonly retained: readonly string[];
  /** Tickets whose retry is running right now. A subset of `retained`. */
  readonly retrying: readonly string[];
}

export class StoredReceiveService {
  private readonly jobs = new Map<string, Job>();
  /**
   * How the last few jobs ended.
   *
   * The outcome is PUSHED when it happens; this is what answers a page that was
   * not listening — one that navigated away and back, or that missed the event
   * between subscribing and starting. Bounded and oldest-first, because it is a
   * convenience, not a history: `stored/report.ts` outcomes are counts and
   * closed codes, so nothing here is a secret, but nothing should accumulate
   * either.
   */
  private readonly results = new Map<string, StoredReceiveOutcome>();
  /** Cleanup retries in flight, one per ticket. Joined by every teardown. */
  private readonly retries = new Map<string, Promise<CleanupRetryOutcome>>();
  private seq = 0;
  /**
   * Not admitting new work. Nothing running is affected.
   *
   * One flag for both reasons it can be set, because the question every
   * admission asks is the same: a quit that is being DECIDED (`fence`, cleared
   * by `resume`) and a quit that is being CARRIED OUT (`quiesce`) both mean
   * "start nothing new". `AppService.admissionFenced` is the same flag for the
   * same reason; this exists so the two can be set together, in one tick.
   */
  private fenced = false;
  private disposed = false;

  constructor(private readonly deps: StoredReceiveDeps) {}

  private get cleanups(): CleanupRegistry {
    return this.deps.cleanups ?? storedCleanups;
  }

  /** Everything this process is holding for stored receive. */
  inventory(): StoredReceiveInventory {
    return {
      active: this.jobs.size,
      retained: this.cleanups.tickets,
      retrying: [...this.retries.keys()],
    };
  }

  /** True while any receive is running — for the quit risk snapshot. */
  get active(): number {
    return this.jobs.size;
  }

  /**
   * Start a receive, or refuse.
   *
   * Everything up to `this.jobs.set` is synchronous: a `revokeDocument` that
   * runs at any point after this call returns finds the job, and one that runs
   * during the awaited body finds it too.
   */
  start(request: StoredReceiveStart): { refusal: StoredReceiveRefusal } | { jobId: string; outcome: Promise<StoredReceiveOutcome> } {
    if (this.disposed || this.fenced) return { refusal: "unavailable" };
    // Cheap shape checks before anything expensive, and before the link is even
    // parsed. The length bound is the parser's own, restated here so an
    // oversized paste is refused without being handed on.
    if (typeof request.link !== "string" || request.link.length > MAX_ACCEPTED_LINK_LENGTH) {
      return { refusal: "too-long" };
    }
    if (this.jobs.size >= MAX_ACTIVE_STORED_RECEIVES) return { refusal: "at-capacity" };

    const id = `stored-receive-${String(++this.seq)}`;
    const control = new AbortController();
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const ref: StoredJobRef = { id, document: request.authority.document };
    const job: Job = { ref, control, settled };
    this.jobs.set(id, job);

    const outcome = this.run(job, request.link)
      .then((settledOutcome) => {
        this.remember(id, settledOutcome);
        this.deps.onOutcome?.(ref, settledOutcome);
        return settledOutcome;
      })
      .finally(() => {
        this.jobs.delete(id);
        markSettled();
      });
    // The caller gets the id NOW. A page that only learned it when the transfer
    // ended could show no progress for it and could not cancel it — the two
    // things the id exists for.
    return { jobId: id, outcome };
  }

  private async run(job: Job, link: string): Promise<StoredReceiveOutcome> {
    const receive = this.deps.receive ?? receiveStoredLink;
    const report = await receive({
      link,
      signal: job.control.signal,
      cleanups: this.cleanups,
      authority: {
        /**
         * Ask for a folder, but never WAIT for a human to answer.
         *
         * The dialog is raced against this job's abort. Awaiting it directly
         * made quit and reload hang for as long as someone left the picker on
         * screen — the same failure the LAN path fences rather than joins, and
         * for the same reason: a dialog nobody has answered has created nothing,
         * so there is nothing to wait for.
         *
         * When the abort wins, this answers "declined" immediately. The
         * dialog's own promise is retained only so its rejection is handled;
         * its late result is never read, so a folder chosen after the abort
         * opens nothing. An unopened folder is not a resource and is not
         * counted as one.
         */
        grant: async (facts) => {
          if (job.control.signal.aborted) return null;
          const picked = this.deps.pickDestination(facts, job.ref);
          // Held, not joined: an abandoned dialog must not become an unhandled
          // rejection, and must not become a destination either.
          picked.catch(() => undefined);
          const abandoned = new Promise<null>((resolve) => {
            job.control.signal.addEventListener("abort", () => resolve(null), { once: true });
          });
          const grant = await Promise.race([picked, abandoned]);
          return job.control.signal.aborted ? null : grant;
        },
      },
      ...(this.deps.onProgress
        ? {
            onProgress: (received: number, total: number) => {
              // Suppressed once this job is no longer wanted. A cancelled
              // receive that kept reporting would draw a live-looking bar for a
              // transfer nobody is going to finish; the host fences on the
              // document generation too, so a stale document sees nothing.
              if (job.control.signal.aborted) return;
              this.deps.onProgress?.(job.ref, received, total);
            },
          }
        : {}),
      ...(this.deps.transport ? { transport: this.deps.transport } : {}),
      ...(this.deps.destination ? { destination: this.deps.destination } : {}),
      ...(this.deps.runtime ? { runtime: this.deps.runtime } : {}),
      ...(this.deps.hosts ? { hosts: this.deps.hosts } : {}),
    });
    return { ok: true, report };
  }

  /** How a job ended, for a page that missed the push. Null once forgotten. */
  result(jobId: string): StoredReceiveOutcome | null {
    return this.results.get(jobId) ?? null;
  }

  private remember(jobId: string, outcome: StoredReceiveOutcome): void {
    this.results.set(jobId, outcome);
    while (this.results.size > MAX_REMEMBERED_OUTCOMES) {
      const oldest = this.results.keys().next().value;
      if (oldest === undefined) break;
      this.results.delete(oldest);
    }
  }

  /** The user pressed Cancel. Unknown ids are ignored, not an error. */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    job.control.abort();
    return true;
  }

  /**
   * The document that asked went away — a reload, or a renderer crash.
   *
   * Aborted synchronously for every match FIRST, then joined. Awaiting each in
   * turn would leave later jobs running under a document that is already gone.
   */
  async revokeDocument(generation: number): Promise<void> {
    await this.retire((job) => job.ref.document === generation);
  }

  private async retire(select: (job: Job) => boolean): Promise<void> {
    const chosen = [...this.jobs.values()].filter(select);
    // Aborted synchronously for every match, THEN joined.
    for (const job of chosen) job.control.abort();
    // Cleanup retries are joined too: a retry in flight owns a helper child
    // process and is exactly the kind of work a teardown must not return
    // around. `allSettled` because a failed retry keeps its ticket and is
    // reported through the inventory, not thrown from here.
    await Promise.allSettled([...chosen.map((job) => job.settled), ...this.retries.values()]);
  }

  /**
   * Stop admitting new work. Nothing in flight is touched.
   *
   * The partner of `AppService.fenceReceives`, and it exists because a quit
   * asks the user a question and then WAITS — for the page's acknowledgement,
   * and then for a human. Held across both, so the risk the prompt described
   * is still the risk when it is answered: a receive admitted in that window
   * would be stopped by a quit that never mentioned it.
   *
   * Idempotent, and cleared only by `resume()`.
   */
  fence(): void {
    this.fenced = true;
  }

  /**
   * Stop admitting, cancel what is running, and join it. Recoverable.
   *
   * Mirrors `AppService.quiesce`: this is a quit the user may still refuse, so
   * nothing here is terminal and `resume()` puts it back. The aborts happen
   * before the first await, so a caller may start this and join it later
   * without leaving anything running in between.
   */
  async quiesce(): Promise<StoredReceiveInventory> {
    this.fence();
    await this.retire(() => true);
    return this.inventory();
  }

  /** The user stayed. New receives and cleanup retries are admitted again. */
  resume(): void {
    if (!this.disposed) this.fenced = false;
  }

  /** Terminal. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.fenced = true;
    await this.retire(() => true);
  }

  /**
   * Ask a retained destination to tear down again.
   *
   * The ticket's owner is this process, and a failure KEEPS it: the next
   * attempt may be the one that works, and releasing on failure is the silent
   * drop the registry exists to prevent. A REFUSAL keeps it for the same
   * reason and a stronger one — nothing was attempted, so there is nothing to
   * conclude about the destination.
   */
  retryCleanup(ticket: string): Promise<StoredCleanupRetryResult> {
    // ONE owner per ticket. Two concurrent retries would each ask the same
    // helper to tear down, and the second would report on work the first was
    // still doing; a second caller joins the first attempt instead. Joining is
    // deliberately ahead of the fence below: that attempt is already owned and
    // already joined by `retire`, so answering it is not new work.
    const existing = this.retries.get(ticket);
    if (existing) return existing;
    // Admission, synchronously, before the registry is touched. The SAME fence
    // the start path uses, because this is the same kind of thing: a new helper
    // child process, started now.
    //
    // `retire` joins the retries it can SEE. Without this, `quiesce` and
    // `dispose` snapshot that set and a retry admitted afterwards owns a helper
    // no teardown is waiting for — after `dispose`, one nothing will ever wait
    // for, in a process on its way out. A quit prompt that says files could not
    // be cleaned up is exactly where "try again" gets pressed.
    if (this.disposed || this.fenced) return Promise.resolve({ outcome: "unavailable" });
    const run = this.cleanups.retry(ticket).finally(() => this.retries.delete(ticket));
    this.retries.set(ticket, run);
    return run;
  }
}
