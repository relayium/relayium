// One stored send, owned by the SHELL rather than by a page.
//
// ## This is the process that produces the ciphertext
//
// The renderer holds the user's `File` objects — from `<input>`,
// `webkitdirectory` and drag-drop, all of which open the native Windows
// pickers while granting no arbitrary-path read channel — and it runs the
// PRODUCTION shared `encryptFiles` from `web/src/lib/store-crypto.ts`. That is
// what keeps a path reader out of the main process, and it is why the content
// key for this job crosses main→renderer: this side is what encrypts.
//
// What follows from holding that key: it is never rendered, never logged, never
// put in a message, and never kept after the job settles. The only thing done
// with it is `importStoreKey`.
//
// ## The frozen array is the contract
//
// `descriptors` and `encryptFiles` MUST see the same array, in the same order:
// main plans the manifest from the first and the engine checks the frames the
// second produces against that plan, file index by file index and sequence by
// sequence. So the picked files are frozen at the moment they are picked, and a
// re-pick starts a FRESH job with a FRESH key — never a re-encryption of
// different bytes under a key that has already been used, which for AES-GCM is
// a break rather than a bug.
//
// ## Why this outlives the page
//
// A send takes as long as an upload takes, and a user switches rows while it
// runs. Held in the component, the job id, the progress and the receipt would
// all go with the unmount — and so would the picked files, which is the one
// thing that cannot be recovered without asking the user to choose them again.

import { encryptFiles, importStoreKey, decodeKey } from "../../../../../web/src/lib/store-crypto";
import type {
  FrameExpectation,
  StoredSendHistoryEntry,
  StoredSendOutcome,
  StoredSendStart,
} from "../../shared/ipc-contract.js";

/** The preload surface this controller uses. Declared, not inferred. */
export interface StoredSendBridge {
  start(payload: {
    entries: readonly { path: string; size: number }[];
    retention: { burnAfterRead: boolean; ttlSeconds: number };
  }): Promise<StoredSendStart>;
  feed(payload: {
    jobId: string;
    fileIndex: number;
    seq: number;
    bytes: Uint8Array;
  }): Promise<{ expects: FrameExpectation | null }>;
  end(payload: { jobId: string }): Promise<StoredSendOutcome>;
  cancel(payload: { jobId: string }): Promise<StoredSendOutcome>;
  history(): Promise<{ entries: readonly StoredSendHistoryEntry[] | null }>;
  link(payload: { jobId: string }): Promise<{ link: string | null }>;
  remove(payload: { jobId: string }): Promise<{ result: string }>;
  reconcile(payload: { jobId: string }): Promise<StoredSendOutcome>;
  copyLink(payload: { jobId: string }): Promise<{ result: "copied" | "unavailable" }>;
  onProgress(cb: (payload: unknown) => void): () => void;
  onOutcome(cb: (payload: unknown) => void): () => void;
  onAccount(cb: (payload: unknown) => void): () => void;
}

/** Why a send did not start. Closed codes; never the user's file names. */
export type SendRefusal =
  | { readonly kind: "unavailable" }
  | { readonly kind: "at-capacity" }
  | { readonly kind: "signed-out" }
  | { readonly kind: "nothing-picked" }
  | { readonly kind: "internal" }
  | { readonly kind: "refused"; readonly code: string; readonly manifest: string | null };

/** How many days a link may last, offered as the Mac offers them. */
export const TTL_CHOICES: readonly number[] = [1, 7, 14];
const DAY_SECONDS = 24 * 60 * 60;

export class StoredSendController {
  /**
   * The files the user picked, frozen in the order they were picked.
   *
   * The SAME array reaches `descriptors` and `encryptFiles`. Replacing it is
   * how a new job begins; mutating it is never done.
   */
  files = $state<readonly File[]>([]);
  burnAfterRead = $state(false);
  ttlDays = $state(7);

  busy = $state(false);
  committed = $state(0);
  total = $state(0);
  outcome = $state<StoredSendOutcome | null>(null);
  refusal = $state<SendRefusal | null>(null);
  /** The link for the send that just finished, held only while it is shown. */
  link = $state<string | null>(null);
  /**
   * WHICH send the link on screen belongs to.
   *
   * Captured when the link is revealed, because at that moment this object
   * knows the job id for certain. The page used to derive it from
   * `history[0].jobId` instead, and that is a race with a user-visible cost:
   * the link is shown as soon as `end` reports `published`, while the history
   * refresh that would populate row 0 is still in flight. A Copy pressed in
   * that window named the empty string and was refused at the boundary; once
   * the history did land, the same expression could name a DIFFERENT job than
   * the link being displayed — and copying somebody else's link is worse than
   * copying nothing.
   *
   * Identity is therefore held, never inferred from ordering.
   */
  linkJobId = $state<string | null>(null);
  /** What the last Copy did. Never silent: a refusal is shown. */
  copied = $state<"copied" | "failed" | null>(null);
  /** What the last delete or re-check did, so neither is silent either. */
  rowNotice = $state<{ jobId: string; kind: "deleted" | "delete-failed" | "rechecked" | "still-unknown" } | null>(null);
  history = $state<readonly StoredSendHistoryEntry[]>([]);
  /**
   * The record could not be READ.
   *
   * Distinct from an empty history, and the distinction is the point: showing
   * "you have not sent anything yet" over a journal this app failed to open
   * would tell the user their sends are gone.
   */
  historyUnavailable = $state(false);
  /** History rows with an operation in flight, so one row can show progress. */
  working = $state<readonly string[]>([]);

  #jobId: string | null = null;
  /**
   * Which attempt is current.
   *
   * Bumped by every send, every cancel and every account change. A delayed
   * result — a `feed` that was in flight, a `finally` from a send the user
   * cancelled, a history read issued under the previous account — checks it
   * before touching anything. Without it an older attempt's `finally`
   * unconditionally cleared `busy` and refreshed history over a NEWER attempt,
   * and a history read issued before a sign-out restored the old account's rows
   * after it.
   */
  #attempt = 0;
  /** The account generation this state belongs to. */
  #epoch = 0;
  /**
   * Which history read is the newest one issued.
   *
   * The epoch alone is not enough. Two reads issued under the SAME account can
   * still land out of order — a slow one from before a delete, a fast one from
   * after it — and the older answer then overwrites the newer, putting a row
   * back that the user has just removed. Only the latest issued read may write.
   */
  #historySeq = 0;
  /** Progress frames that arrived before their acknowledgement did. */
  readonly #early = new Map<string, { committed: number; total: number }>();
  readonly #stop: Array<() => void> = [];

  constructor(private readonly bridge: StoredSendBridge) {
    // Nothing is assumed about the starting account: the first `onAccount` push
    // establishes it, and `forgetAccount` runs only when it genuinely differs.
    // Subscribed ONCE, for the life of the app. The same race the stored
    // receive controller documents applies here: the first committed frame can
    // arrive before `start` has answered.
    this.#stop.push(
      bridge.onProgress((payload) => {
        const shaped = payload as { jobId?: unknown; committed?: unknown; total?: unknown };
        if (typeof shaped.jobId !== "string") return;
        if (typeof shaped.committed !== "number" || typeof shaped.total !== "number") return;
        if (this.#jobId === null) {
          this.#early.set(shaped.jobId, { committed: shaped.committed, total: shaped.total });
          while (this.#early.size > 8) {
            const oldest = this.#early.keys().next().value;
            if (oldest === undefined) break;
            this.#early.delete(oldest);
          }
          return;
        }
        if (shaped.jobId !== this.#jobId) return;
        this.committed = shaped.committed;
        this.total = shaped.total;
      }),
    );
    this.#stop.push(
      bridge.onOutcome((payload) => {
        const shaped = payload as { jobId?: unknown; outcome?: unknown };
        if (typeof shaped.jobId !== "string" || shaped.jobId !== this.#jobId) return;
        this.outcome = shaped.outcome as StoredSendOutcome;
      }),
    );
    this.#stop.push(
      bridge.onAccount((payload) => {
        const shaped = payload as { epoch?: unknown; signedIn?: unknown };
        if (typeof shaped.epoch !== "number") return;
        if (shaped.epoch !== this.#epoch) {
          // A different account. Everything that belonged to the old one goes.
          this.forgetAccount(shaped.epoch);
          return;
        }
        // The SAME account, newly readable: the credential has just become
        // durable. Read the history that is now available — and do NOT clear
        // anything, because an in-flight send under this account is still the
        // user's and cancelling it here would be a sign-in destroying a send.
        void this.refreshHistory();
      }),
    );
  }

  /**
   * The account moved. Drop everything that belonged to the old one, NOW.
   *
   * Synchronous, and it clears the link first: a link is a key, and leaving one
   * on screen across a sign-out is the failure this whole path exists to
   * prevent. History goes too — those rows are another account's — and the
   * attempt is bumped so anything already in flight lands on nothing.
   */
  forgetAccount(epoch: number): void {
    this.#epoch = epoch;
    this.#attempt += 1;
    this.#jobId = null;
    this.link = null;
    this.linkJobId = null;
    this.copied = null;
    this.history = [];
    this.historyUnavailable = false;
    // Any read already in flight is now stale by sequence as well as by epoch.
    this.#historySeq += 1;
    this.rowNotice = null;
    this.outcome = null;
    this.refusal = null;
    this.busy = false;
    this.committed = 0;
    this.total = 0;
    // The picked files are the user's own choice and are NOT theirs to lose on
    // an account change — they were never sent anywhere. They stay.
    void this.refreshHistory();
  }

  /** Whether a delayed result still belongs to the current attempt. */
  #current(attempt: number, epoch: number): boolean {
    return this.#attempt === attempt && this.#epoch === epoch;
  }

  /** The user picked files or a folder. A new pick replaces the last one. */
  pick(files: readonly File[]): void {
    if (this.busy) return;
    // Frozen here, so the array `encryptFiles` walks is the array the manifest
    // was planned from.
    this.files = Object.freeze([...files]);
    this.outcome = null;
    this.refusal = null;
    this.link = null;
    this.linkJobId = null;
    this.committed = 0;
    this.total = 0;
  }

  clear(): void {
    if (this.busy) return;
    this.files = [];
    this.outcome = null;
    this.refusal = null;
    this.link = null;
    this.linkJobId = null;
  }

  get totalBytes(): number {
    return this.files.reduce((sum, file) => sum + file.size, 0);
  }

  /**
   * Encrypt and upload the picked files.
   *
   * Every frame is labelled by what MAIN says it owes next, not by a count kept
   * here: `expects` carries the file index, the global sequence and the exact
   * ciphertext length, so a producer that drifted from the plan is caught by
   * the engine rather than discovered as a corrupt object at the far end.
   */
  async send(): Promise<void> {
    if (this.busy || this.files.length === 0) return;
    const attempt = ++this.#attempt;
    const epoch = this.#epoch;
    this.busy = true;
    this.outcome = null;
    this.refusal = null;
    this.link = null;
    this.linkJobId = null;
    this.committed = 0;

    // The same array, in the same order, as `encryptFiles` will walk.
    const picked = this.files;
    const entries = picked.map((file) => ({
      // `webkitRelativePath` when the user picked a folder, so the structure
      // they chose is preserved; the leaf name otherwise.
      //
      // Read defensively. Chromium always defines it — empty for a file pick —
      // but it is a `webkit`-prefixed extension rather than part of the File
      // standard, and Node's `File` does not have it at all. Without this the
      // controller could not be driven outside a browser, which is where its
      // cancellation and ordering races are actually testable.
      path: (file.webkitRelativePath ?? "").length > 0 ? file.webkitRelativePath : file.name,
      size: file.size,
    }));

    let started: StoredSendStart;
    try {
      started = await this.bridge.start({
        entries,
        retention: { burnAfterRead: this.burnAfterRead, ttlSeconds: this.ttlDays * DAY_SECONDS },
      });
    } catch {
      if (this.#current(attempt, epoch)) {
        this.refusal = { kind: "internal" };
        this.busy = false;
      }
      return;
    }

    // Cancelled, or the account changed, while `start` was in flight. The job
    // exists in main and must be stopped rather than left running for a page
    // that has moved on — and nothing of it is written over the newer attempt.
    if (!this.#current(attempt, epoch)) {
      if (started.ok) void this.bridge.cancel({ jobId: started.jobId }).catch(() => null);
      return;
    }

    if (!started.ok) {
      this.busy = false;
      this.refusal =
        started.refusal === "refused"
          ? {
              kind: "refused",
              code: started.code ?? "internal",
              manifest: started.manifest?.kind ?? null,
            }
          : { kind: started.refusal };
      return;
    }

    this.#jobId = started.jobId;
    this.total = started.cipherBytes;
    const early = this.#early.get(started.jobId);
    if (early !== undefined) {
      this.committed = early.committed;
      this.total = early.total;
      this.#early.delete(started.jobId);
    }

    try {
      // The key is used and never kept: no field holds it, and it is not put on
      // screen, in a message or in a log.
      const key = await importStoreKey(decodeKey(started.contentKey));
      let expects = started.expects;
      for await (const bytes of encryptFiles([...picked], key)) {
        // Checked every frame: a cancel or an account change mid-upload stops
        // the producer rather than encrypting the rest for nobody.
        if (!this.#current(attempt, epoch) || this.#jobId !== started.jobId) return;
        if (expects === null) break;
        const answer = await this.bridge.feed({
          jobId: started.jobId,
          fileIndex: expects.fileIndex,
          seq: expects.seq,
          bytes,
        });
        expects = answer.expects;
      }
      if (!this.#current(attempt, epoch) || this.#jobId !== started.jobId) return;
      const settled = await this.bridge.end({ jobId: started.jobId });
      if (!this.#current(attempt, epoch)) return;
      this.outcome = settled;
      if (settled.status === "published") await this.revealLink(started.jobId, attempt, epoch);
    } catch {
      // A throw on this side is not evidence about the server. Main reports the
      // durable outcome; asking for it is more truthful than inventing one.
      if (this.#jobId === started.jobId) {
        const settled = await this.bridge.cancel({ jobId: started.jobId }).catch(() => null);
        if (this.#current(attempt, epoch)) this.outcome = settled;
      }
    } finally {
      // GUARDED. Unconditionally clearing `busy` here cleared it for a NEWER
      // attempt that had already started, and the history refresh landed on
      // whatever the page had moved on to.
      if (this.#current(attempt, epoch)) {
        if (this.#jobId === started.jobId) this.#jobId = null;
        this.busy = false;
        await this.refreshHistory();
      }
    }
  }

  /** The user pressed Cancel while it was running. */
  /**
   * The user pressed Cancel.
   *
   * Works BEFORE the start has been acknowledged, which is when a person is
   * most likely to press it. There is no job id to name yet, so the intent is
   * recorded by bumping the attempt: `send` sees it the moment `start` answers
   * and cancels the job main has just created. Returning early here left the UI
   * saying "uploading" over an upload nobody was going to stop.
   */
  async cancel(): Promise<void> {
    if (!this.busy) return;
    const jobId = this.#jobId;
    // The intent, recorded whether or not there is anything to name yet.
    this.#attempt += 1;
    this.#jobId = null;
    this.busy = false;
    if (jobId === null) {
      // Admitted but not yet acknowledged. `send` cancels it on arrival.
      this.outcome = { status: "cancelled" };
      return;
    }
    this.outcome = await this.bridge.cancel({ jobId }).catch(() => null);
    await this.refreshHistory();
  }

  private async revealLink(jobId: string, attempt: number, epoch: number): Promise<void> {
    const answer = await this.bridge.link({ jobId }).catch(() => ({ link: null }));
    // A link that came back after a sign-out belongs to an account that has
    // gone away, and it is a KEY.
    if (!this.#current(attempt, epoch)) return;
    // The link and the job it belongs to are installed TOGETHER. Nothing reads
    // one without the other, so there is no window in which a link on screen
    // has no identity or the wrong one.
    this.link = answer.link;
    this.linkJobId = answer.link === null ? null : jobId;
  }

  /**
   * Copy one send's link, from MAIN.
   *
   * Not `navigator.clipboard`: `window.ts` denies every renderer permission, so
   * that path does not fail occasionally — it never works. Main composes the
   * link under the live account and writes it. The answer is always rendered,
   * so a refusal is visible rather than a button that appears to do nothing.
   */
  /**
   * Copy the link that is ON SCREEN, by the identity captured with it.
   *
   * No argument, deliberately. The page used to pass an id it had derived from
   * the history's ordering, which is how it came to name an empty string during
   * the window before the history landed — and, once it had, potentially a
   * different job than the one being displayed. There is now nothing for a
   * caller to get wrong: this copies the link it is showing or it refuses.
   */
  async copyShownLink(): Promise<void> {
    const jobId = this.linkJobId;
    // No identity means no link is being shown, or its job is not known. Either
    // way there is nothing to copy, and asking main with an empty id would be a
    // request the boundary refuses — which the user would see as a failed copy
    // of a link that is plainly on their screen.
    if (jobId === null || this.link === null) {
      this.copied = "failed";
      return;
    }
    await this.copyLink(jobId);
  }

  async copyLink(jobId: string): Promise<void> {
    const attempt = this.#attempt;
    const epoch = this.#epoch;
    const answer = await this.bridge
      .copyLink({ jobId })
      .catch(() => ({ result: "unavailable" as const }));
    if (!this.#current(attempt, epoch)) return;
    this.copied = answer.result === "copied" ? "copied" : "failed";
    if (answer.result !== "copied") return;
    setTimeout(() => {
      if (this.#current(attempt, epoch)) this.copied = null;
    }, 1500);
  }

  async refreshHistory(): Promise<void> {
    const epoch = this.#epoch;
    const seq = ++this.#historySeq;
    const answer = await this.bridge.history().catch(() => ({ entries: null }));
    // A read issued before a sign-out must not restore the old account's rows,
    // and an older read must not overwrite a newer one's answer.
    if (this.#epoch !== epoch || this.#historySeq !== seq) return;
    if (answer.entries === null) {
      this.historyUnavailable = true;
      return;
    }
    this.historyUnavailable = false;
    this.history = answer.entries;
  }

  /** Show the link for a past send, for exactly as long as it is on screen. */
  async linkFor(jobId: string): Promise<string | null> {
    if (this.working.includes(jobId)) return null;
    const epoch = this.#epoch;
    this.working = [...this.working, jobId];
    try {
      const answer = await this.bridge.link({ jobId }).catch(() => ({ link: null }));
      // Dropped rather than shown: this string is a key.
      return this.#epoch === epoch ? answer.link : null;
    } finally {
      this.working = this.working.filter((entry) => entry !== jobId);
    }
  }

  /** Delete one published object. Main retires the key only after the server
   *  confirms it is gone. */
  async remove(jobId: string): Promise<string> {
    if (this.working.includes(jobId)) return "failed";
    this.working = [...this.working, jobId];
    try {
      const epoch = this.#epoch;
      const answer = await this.bridge.remove({ jobId }).catch(() => ({ result: "failed" }));
      if (this.#epoch === epoch) {
        // Rendered, always. A delete that failed and said nothing left the user
        // believing an object was gone when it is still there.
        this.rowNotice = {
          jobId,
          kind: answer.result === "deleted" || answer.result === "absent" ? "deleted" : "delete-failed",
        };
      }
      await this.refreshHistory();
      return answer.result;
    } finally {
      this.working = this.working.filter((entry) => entry !== jobId);
    }
  }

  /** Ask again what an ambiguous send actually did. Never re-uploads. */
  async reconcile(jobId: string): Promise<StoredSendOutcome | null> {
    if (this.working.includes(jobId)) return null;
    this.working = [...this.working, jobId];
    try {
      const epoch = this.#epoch;
      const settled = await this.bridge.reconcile({ jobId }).catch(() => null);
      if (this.#epoch === epoch) {
        this.rowNotice = {
          jobId,
          kind: settled?.status === "published" ? "rechecked" : "still-unknown",
        };
      }
      await this.refreshHistory();
      return settled;
    } finally {
      this.working = this.working.filter((entry) => entry !== jobId);
    }
  }

  dispose(): void {
    for (const stop of this.#stop.splice(0)) stop();
  }
}
