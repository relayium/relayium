// The receiver half of pre-upload: the peer handed us object ids and keys over
// the end-to-end channel (preupload-handoff.ts, frame kind 12), and this turns
// them into files on disk.
//
// Authoritative definition: docs/protocol/relayium-pair-room-v1.md §4.
//
// Four properties this module exists to hold:
//
//   - THE ACCEPT STEP IS NOT SKIPPED. Bytes that arrive from storage instead of
//     over the live link are still bytes a stranger who guessed a code could be
//     sending. The live lane raises a consent prompt before anything is written;
//     so does this. Pre-upload changes where the ciphertext was parked, not who
//     decides whether to keep it.
//   - NOTHING IS HALF-DELIVERED IN SILENCE. A batch whose manifest cannot be
//     read, or whose download fails, is reported as failed — never as a folder
//     that is quietly missing a file. §4.4: "a receiver that never got a handoff
//     MUST NOT claim success", and the same holds for one it got and could not
//     complete. What it says about a partial failure is what actually happened:
//     see `savedCount`.
//   - RE-DELIVERY IS FREE, AND A FAILURE IS NOT FINAL. The sender re-sends the
//     WHOLE set on every (re)established link. An id this driver has DELIVERED,
//     or one the user DECLINED, is dropped on the way in: not an error, not a
//     second prompt, not a second download. An id that merely failed is not in
//     that category — see the disposition table below.
//   - A CONTINUATION NEVER OUTLIVES ITS ROOM. Every await here is a window in
//     which the user can leave, decline, or be handed a different room. See
//     `epoch`.
//
// The keys here never go anywhere. They arrived sealed, they are used to fetch
// and decrypt, and they are dropped with the room — no URL, no storage, no log.

import {
  keyFromFragment,
  fetchStoredManifest,
  isAbortError,
  completeStoredObject,
  StoredDownloadHttpError,
  DownloadNetworkError,
  type CompletionOutcome,
} from "./stored-file";
import { completionProof, decodeKey } from "./store-crypto";
import { storedSaveSpecs, storedTotalBytes, writeStoredObject } from "./stored-download";
import {
  pickSaveTarget as defaultPickSaveTarget,
  SaveCancelledError,
  SinkCancelledError,
  SinkTransportError,
  type FileMetaLite,
  type SaveOptions,
  type SaveTarget,
} from "./filesink";
import type { StoredManifest } from "./store-crypto";
import type { HandoffItem } from "./preupload-handoff";

/**
 * `idle` — nothing offered, or the last batch was dismissed.
 * `resolving` — reading each object's encrypted manifest to learn what it holds.
 * `prompt` — the user is being asked, exactly as the live lane asks.
 * `receiving` — downloading and writing.
 * `done` / `failed` — terminal for this batch; `dismiss()` returns to idle and
 * lets anything that arrived meanwhile take its turn.
 */
export type StoredReceiveStatus = "idle" | "resolving" | "prompt" | "receiving" | "done" | "failed";

/** Why a batch failed, in the vocabulary the UI has copy for. */
export type StoredReceiveError = "" | "gone" | "netFail" | "decryptFail" | "saveFail";

/**
 * The failures a second attempt could plausibly survive.
 *
 * `gone` cannot: the object is not there any more, so every retry is a request
 * for something that has been deleted, and the remedy is a fresh transfer. WHY
 * it was deleted is not something this client is told — see `classify` — and
 * neither this comment nor the copy may invent a cause for it. `decryptFail`
 * cannot either: the key the peer sent does not open its
 * object, and it will not open it next time — §4.4 makes that a hard error with
 * no fallback. Offering a retry for either would be a button with a guaranteed
 * failure behind it.
 */
const RETRYABLE_ERRORS: ReadonlySet<StoredReceiveError> = new Set<StoredReceiveError>(["netFail", "saveFail"]);

/**
 * What this driver has decided about one object id, for the life of the room.
 *
 * The dedupe that makes the sender's blind whole-set resending correct, and the
 * reason it is a table rather than a single `taken` set. Claiming an id the
 * moment it was OFFERED made every one of these states mean "never mention this
 * again" — so one transient 500, or one dropped socket, permanently disabled the
 * retry that the sender was faithfully performing on every reconnect. The card
 * said "try again", nothing ever tried, and the files stayed in storage for
 * good — a joined room has no deadline and no fallback expiry, so nothing but
 * an explicit completion, an operator or account deletion ever removes them.
 *
 * `held` — queued, being resolved, or on screen right now. Not offered twice.
 * `done` — written. Never fetched again: that would bill the sender for bytes
 *   the user already has and write a second copy beside the first.
 * `rejected` — the user said no. Never re-asked; a resend must not re-put a
 *   question that has been answered.
 * `spent` — failed in a way a retry cannot survive (see RETRYABLE_ERRORS).
 *   Terminal like `rejected`, and separate from it only so the two reasons stay
 *   legible.
 * *absent* — never seen, or failed retryably. Both mean "offer it".
 */
type Disposition = "held" | "done" | "rejected" | "spent";

export interface StoredReceiveDeps {
  /** Test seam; production opens the real save picker inside the accept gesture. */
  pickSaveTarget?(files: FileMetaLite[], opts?: SaveOptions): Promise<SaveTarget>;
  /** How long to wait before each completion RETRY, and — by its length — how
   *  many retries there are at all. Defaults to COMPLETION_BACKOFF_MS. Injectable
   *  so tests can assert the bound without spending it in real time. */
  completionBackoffMs?: readonly number[];
}

/**
 * The wait before each completion retry; its LENGTH is the retry budget.
 *
 * One attempt, plus one per entry here — three attempts over roughly nine
 * seconds. Deliberately small, and the smallness is the point: a completion is
 * housekeeping that runs AFTER the user's files are safely on disk. Nothing the
 * user is waiting for depends on it, nothing they see changes with it, and what
 * giving up costs is a sender's storage — not the user's file. It is a real
 * cost and an open-ended one, because a joined room has no fallback expiry: an
 * object this gives up on is held until the account is deleted. Grinding an
 * unreachable server for minutes is still not how to buy that back: it spends
 * the shared per-IP budget that the next receiver's DOWNLOAD needs, on
 * something nobody is waiting for.
 */
export const COMPLETION_BACKOFF_MS: readonly number[] = [1_500, 6_000];

/** One object whose files are on the disk and whose proof has not been spent
 *  yet. Holds the PROOF, not the file key: the proof can only end this object's
 *  life, while the key could still decrypt it, and the moment the batch is
 *  delivered there is no longer any reason for this driver to be able to. */
interface PendingCompletion {
  id: string;
  proof: Uint8Array;
  /** Attempts made. Compared against the backoff schedule's length, which is
   *  what makes the bound and the waiting one fact rather than two. */
  tries: number;
}

/** Wait `ms`, or stop early if the room ends. Resolves either way — the caller's
 *  epoch check is what decides whether there is still work to do, and a rejection
 *  here would only be a second way to say the same thing. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * How this lane opens a save target.
 *
 * Empty, and explicitly so rather than by omission. `swStream` is the one option
 * `pickSaveTarget` takes, and it must stay OFF here for exactly the reason it is
 * off for the live receive lane: a service-worker sink acknowledges a chunk when
 * the SW has queued it, not when it is on disk, and this driver reports "Saved."
 * from those acknowledgements. The download page is the only caller that turns it
 * on, and it has no peer and makes no durability promise.
 *
 * It is also the value `warnsAboutMemory`/`asksWhereToSave` must be asked with
 * on the card in front of this — the same options, or the pre-flight question is
 * about a different branch than the one that will run.
 */
export const STORED_RECEIVE_SAVE_OPTS: SaveOptions = {};

interface ResolvedObject {
  item: HandoffItem;
  key: CryptoKey;
  manifest: StoredManifest;
  specs: FileMetaLite[];
  bytes: number;
}

export interface StoredReceiver {
  readonly status: StoredReceiveStatus;
  readonly errorKey: StoredReceiveError;
  /** Everything the pending or running batch will write, in write order. */
  readonly files: readonly FileMetaLite[];
  readonly total: number;
  readonly received: number;
  /** How many objects are waiting behind the current batch. Shown so a user who
   *  finishes one batch is not surprised by a second prompt appearing. */
  readonly waitingCount: number;
  /**
   * How many files of a FAILED batch actually reached the user's disk.
   *
   * 0 for a failure before any byte landed, and 0 for a target that only
   * delivers on `done()` (the ZIP branch buffers the whole archive, so a batch
   * that never finalised produced no file at all however many entries it added).
   * Otherwise the real count — because "Nothing was saved" is false on every
   * per-file target, and a user told that does not know there is half a folder
   * to clean up, or that a retry will land beside it.
   */
  readonly savedCount: number;
  /** Whether `retry()` would do anything: a failed batch whose failure a second
   *  attempt could survive. What the card's retry control renders on. */
  readonly retryable: boolean;
  /** Fold a freshly received handoff in. Ids already settled are no-ops. */
  offer(items: readonly HandoffItem[]): void;
  /** MUST be called from the user's own click: the save picker needs the gesture. */
  accept(): Promise<void>;
  reject(): void;
  /** Attempt a retryably-failed batch again, now, without waiting for a resend
   *  from a peer that may already be gone. */
  retry(): void;
  /** Clear a terminal batch and let anything queued behind it take its turn. */
  dismiss(): void;
  /** Leaving the room. Everything, including what was decided about each id. */
  reset(): void;
  active(): boolean;
}

export function createStoredReceiver(deps: StoredReceiveDeps = {}): StoredReceiver {
  const choose = deps.pickSaveTarget ?? defaultPickSaveTarget;
  const backoff = deps.completionBackoffMs ?? COMPLETION_BACKOFF_MS;

  let status = $state<StoredReceiveStatus>("idle");
  let errorKey = $state<StoredReceiveError>("");
  let files = $state.raw<readonly FileMetaLite[]>([]);
  let total = $state(0);
  let received = $state(0);
  let waitingCount = $state(0);
  let savedCount = $state(0);
  let retryable = $state(false);

  /** What has been decided about each id this room offered. See Disposition. */
  const decided = new Map<string, Disposition>();
  /** Offered, not yet resolved. */
  let waiting: HandoffItem[] = [];
  /** The batch being prompted for, or running. */
  let batch: ResolvedObject[] = [];
  /** The items `retry()` would attempt again. Populated only for a failure whose
   *  class is retryable, so `retryable` cannot promise what it cannot deliver. */
  let lastFailed: HandoffItem[] = [];
  /** Guards against two resolve passes racing after two frames arrive together. */
  let resolving = false;
  /**
   * Set SYNCHRONOUSLY by accept(), because `status` cannot be.
   *
   * The first thing accept() does is await the save picker, and `status` stays
   * `prompt` for as long as that dialog is open — so a second click would open a
   * second picker and start a second run over the same objects, writing every
   * file twice into two targets. The status check alone cannot see that; this
   * can, because nothing awaits between the check and the set.
   */
  let accepting = false;
  /**
   * Which room's work is current. Bumped by `reset()` and by `reject()`.
   *
   * Everything here is a chain of awaits — a manifest fetch, a save picker, a
   * download — and each one is a window in which the answer this work is for can
   * stop being the current answer. Without a token compared after EVERY await,
   * three real failures follow, and all three end with bytes on a disk:
   *
   *   - `reset()` (the user left the room, or a new pairing began) races a
   *     manifest fetch: the resolve lands afterwards and publishes a prompt for a
   *     room that no longer exists — or, worse, over the batch a NEW room is
   *     already showing, so the user accepts one set of names and receives
   *     another.
   *   - `reset()` races an open save picker or a running download: the previous
   *     pairing's files are written after the user left it.
   *   - `reject()` races an open save picker. `status` is still `prompt` for the
   *     whole time that dialog is up, so declining is available throughout — and
   *     the batch, its keys and its target are already captured in a closure. The
   *     picker resolving would then write files the user has just refused.
   *
   * `dismiss()` deliberately does NOT bump it: it is reachable only from a
   * terminal status, which accept() sets synchronously before it returns, so
   * there is never anything in flight for it to invalidate.
   */
  let epoch = 0;
  /**
   * The teeth behind `epoch`, for the one window a token cannot cover.
   *
   * A token is only read where this module has an await to read it at — between
   * two objects, after the picker, after a manifest. That is enough for
   * everything that is *waiting*, and enough for nothing that is *streaming*:
   * once a blob response body is live, each remaining chunk is decrypted and
   * written by a loop inside `downloadBlob`, and this module does not get
   * control back until the whole object is on disk. So a `reset()` landing there
   * used to stop nothing — the previous room's files went on appearing, one at
   * a time, with `status` already back to `idle` and the card already gone.
   *
   * One controller per epoch, replaced whenever the epoch is bumped, so the two
   * are the same fact stated twice: *invalidated* and *aborted* cannot come
   * apart. Callers capture `live.signal` alongside their `mine = epoch`, which
   * is what makes a signal captured by an old run stay the aborted one after
   * `live` has moved on.
   */
  let live = new AbortController();

  /**
   * End the current generation of work: nothing in flight for it may publish,
   * and nothing in flight for it may keep writing.
   *
   * Both halves, always together — that is the whole reason this is a function
   * and not two statements at each call site.
   */
  function invalidate() {
    epoch++;
    live.abort();
    live = new AbortController();
  }

  /**
   * Objects that are on the user's disk and whose proof has not been spent yet.
   *
   * A SEPARATE state from everything above it, and that separation is the whole
   * safety property. By the time an entry lands here the batch is over: the
   * files are written, the card says what it says, and nothing about this list
   * can change any of that. So a completion that fails — or fails three times —
   * is never a reason to fetch an object again, write a file again, or tell the
   * user something went wrong with their transfer. Nothing did.
   */
  let pending: PendingCompletion[] = [];
  /** One completion runner at a time. Two would post the same proofs twice and
   *  race each other's rounds over one list. */
  let completing = false;
  /**
   * The ROOM's generation, and its cancellation — the pair `epoch`/`live` cannot
   * serve here.
   *
   * `epoch` is bumped by `reject()` as well as `reset()`, because declining a
   * batch has to invalidate that batch's own in-flight work (an open save picker
   * above all). A completion belongs to a DIFFERENT batch — one already saved —
   * and declining the next offer says nothing about it. Sharing the token would
   * therefore strand the previous batch's completion silently, and a joined room
   * has no deadline to fall back on: the sender's ciphertext would then be held
   * until the account is deleted.
   *
   * So this pair is bumped and aborted by `reset()` alone, which is the one
   * event that really does end everything: the user left the room, or a new
   * pairing began. The two halves move together for the same reason `invalidate`
   * exists — *invalidated* and *aborted* must not come apart.
   */
  let completionEpoch = 0;
  let completionLive = new AbortController();

  /**
   * Take delivery of a set of objects: derive each proof and start the sync.
   *
   * Called ONLY from a truthful delivery boundary — see the two call sites in
   * `accept()`.
   *
   * The proof is derived HERE and the pending entry keeps only that. The batch
   * itself still holds its `HandoffItem`s, keys and all, until it is dismissed
   * or the room is reset — that is unchanged. What this avoids is the completion
   * state OUTLIVING the batch while holding a key: `pending` can survive a
   * dismissal by design (the files are saved; the sync is not the user's
   * business), and it must not be the reason a key that can still decrypt an
   * object is kept alive past the card that needed it. A proof can only end that
   * object's life.
   */
  async function queueCompletions(items: readonly HandoffItem[]): Promise<void> {
    const mine = completionEpoch;
    const signal = completionLive.signal;
    for (const it of items) {
      let proof: Uint8Array;
      try {
        proof = await completionProof(decodeKey(it.key));
      } catch {
        // Unreachable for anything `decodeHandoff` let through — it applies the
        // same strict decoder and the same 32-byte rule. Caught anyway, and
        // WITHOUT logging the value or the error: this is the one place holding
        // a file key, and a thrown message is the classic way one reaches a
        // console. Skipping costs the sender storage; it cannot cost the user a
        // file, which is already written.
        console.error("relayium stored handoff completion proof error");
        continue;
      }
      // The key was still current when this derivation started; a room that
      // ended while it ran must not leave a proof behind for the next one.
      if (mine !== completionEpoch) return;
      pending.push({ id: it.id, proof, tries: 0 });
    }
    void runCompletions(mine, signal);
  }

  /**
   * Post the pending proofs, retrying boundedly while this room lives.
   *
   * Idempotent by the server's own contract: 204 is "it is gone — and,
   * identically, there was nothing to end", so a retry of an attempt whose
   * answer we never saw is safe. That is what makes retrying here correct rather
   * than merely tolerable.
   *
   * Every await is followed by a token check, for the same reason every await in
   * the download path is: the answer this work is for can stop being the current
   * answer while it is pending. Here the stakes are one-directional — a stale
   * continuation cannot write a file — but it CAN post a proof for a room the
   * user has left, and it can put entries back into a list a new room now owns.
   */
  async function runCompletions(mine: number, signal: AbortSignal): Promise<void> {
    if (completing) return;
    completing = true;
    try {
      while (pending.length > 0) {
        if (mine !== completionEpoch) return;
        // The round is taken off the list, so anything queued while it runs
        // waits for the next one instead of being retried on this one's clock.
        const round = pending;
        pending = [];
        const keep: PendingCompletion[] = [];
        for (const p of round) {
          let outcome: CompletionOutcome;
          try {
            outcome = await completeStoredObject(p.id, p.proof, signal);
          } catch {
            // A cancellation, or a value this client should never have sent.
            // Neither is worth another attempt, and neither is reported: no
            // error here is about the user's files.
            if (mine !== completionEpoch) return;
            continue;
          }
          if (mine !== completionEpoch) return;
          // `completed`, `unsupported` and `refused` are all settled: the object
          // is gone, or no proof this receiver can derive will ever work on it.
          if (outcome !== "retry") continue;
          p.tries++;
          if (p.tries <= backoff.length) keep.push(p);
        }
        if (mine !== completionEpoch) return;
        if (keep.length === 0) continue; // only fresh arrivals left, if anything
        pending = [...pending, ...keep];
        // The least-tried entry sets the wait, so an object on its first failure
        // is not made to serve another one's longest backoff.
        await delay(backoff[Math.min(...keep.map((p) => p.tries)) - 1], signal);
      }
    } finally {
      // Only this room's own runner may release the latch — the same rule the
      // resolve pass follows, and for the same reason.
      if (mine === completionEpoch) completing = false;
    }
  }

  function classify(e: unknown): StoredReceiveError {
    if (e instanceof DownloadNetworkError) return "netFail";
    if (e instanceof SinkTransportError || e instanceof SinkCancelledError) return "saveFail";
    if (e instanceof StoredDownloadHttpError) {
      // 404/410 is the object no longer being available — the one failure whose
      // remedy is "ask for a new transfer", not "try again". What the status
      // does NOT carry is a reason, and this driver is in no position to supply
      // one: it only runs at all once a handoff has arrived, which means the
      // room is joined and §2 has left it no deadline to have passed. A
      // completion posted by another receiver, an operational cleanup, a
      // deleted account and a join race all arrive here as the same two codes.
      // So the class says "gone" and stops there; the copy does the same.
      // Everything else the server says is a transport-shaped problem the user
      // can retry.
      return e.status === 404 || e.status === 410 ? "gone" : "netFail";
    }
    // A cancellation is this driver stopping its OWN run, never a fault to
    // report. Every abort reachable today is raised by `invalidate()`, which
    // bumps the epoch in the same breath — so the stale-epoch check in each
    // catch returns before this is consulted, and nothing is shown at all.
    // Mapped anyway, and to the retryable class, because of what the fallthrough
    // below would otherwise do if that ever stopped being true: `decryptFail`
    // marks every id in the batch `spent` — permanently unretryable, with the
    // retry control hidden — on the strength of a cancellation that says
    // nothing whatsoever about anyone's keys.
    if (isAbortError(e)) return "netFail";
    // A key that does not open its object. §4.4 makes this a hard error for that
    // item with no fallback, because the unencrypted path it would fall back to
    // does not exist.
    return "decryptFail";
  }

  function publishBatch() {
    files = batch.flatMap((o) => o.specs);
    total = batch.reduce((n, o) => n + o.bytes, 0);
    received = 0;
  }

  function clearBatch() {
    batch = [];
    files = [];
    total = 0;
  }

  /**
   * Record how a batch ended, for every id in it.
   *
   * The whole batch shares the verdict, deliberately, and the two non-retryable
   * classes are why that is right rather than merely simple. Every object in one
   * handoff belongs to ONE sender's storage in ONE room, and the removals this
   * client can name — an operational cleanup, a deleted account, the sender's
   * own release — act on that storage rather than on a single item, so a `gone`
   * on one of them is almost never a healthy remainder being written off. Where
   * it is (one object completed elsewhere while its siblings survive), what the
   * remainder needs is a fresh handoff carrying it again, which is exactly what
   * the copy asks the user for. A `decryptFail` is a sender that is broken or
   * hostile about the keys it sent, which is not a property of one item either.
   * Either way the all-or-nothing report the user already saw stays true.
   */
  function settleFailure(items: readonly HandoffItem[], err: StoredReceiveError) {
    const canRetry = RETRYABLE_ERRORS.has(err);
    for (const it of items) {
      // Absent, not a state of its own: "worth offering again" is exactly what
      // an id this driver has never heard of means, so the sender's next
      // whole-set resend becomes the retry, arriving for free on every reconnect.
      if (canRetry) decided.delete(it.id);
      else decided.set(it.id, "spent");
    }
    lastFailed = canRetry ? [...items] : [];
    retryable = lastFailed.length > 0;
    errorKey = err;
    status = "failed";
  }

  /**
   * Promote the queue into a prompt, if nothing is already occupying the surface.
   *
   * One prompt per handoff frame that introduced new ids, deliberately. The
   * alternative — folding late arrivals into a running batch — cannot work:
   * `pickSaveTarget` is handed the file list up front and may already have built
   * a directory or a ZIP from it. A second frame is a second batch, which is
   * exactly how the live lane treats a second batch too.
   */
  async function advance(): Promise<void> {
    if (resolving || status !== "idle" || waiting.length === 0) return;
    const mine = epoch;
    // Captured with the token, not read from `live` later: by the time an await
    // lands, `live` may already be the NEXT room's controller, and asking it
    // would be asking whether the new room is over.
    const signal = live.signal;
    resolving = true;
    const items = waiting;
    waiting = [];
    waitingCount = 0;
    status = "resolving";
    errorKey = "";
    savedCount = 0;
    retryable = false;
    try {
      const resolved: ResolvedObject[] = [];
      for (const item of items) {
        const key = await keyFromFragment(item.key);
        if (mine !== epoch) return;
        const manifest = await fetchStoredManifest(item.id, key, signal);
        // Checked before the result is kept, not merely before the next request:
        // `resolved` holds live CryptoKeys for a room that may already be over.
        if (mine !== epoch) return;
        resolved.push({
          item,
          key,
          manifest,
          specs: storedSaveSpecs(manifest),
          bytes: storedTotalBytes(manifest),
        });
      }
      batch = resolved;
      publishBatch();
      // No empty-batch branch, and none is needed: `decryptManifest` runs
      // validateManifestFiles, which refuses a manifest with no files. A stored
      // object that describes nothing therefore fails to resolve at all and
      // lands in the catch below as a hard error — never as a prompt for
      // nothing, and never as a "Saved." for a batch that was never downloaded.
      status = "prompt";
    } catch (e) {
      if (mine !== epoch) return;
      // All or nothing. Prompting for the subset that resolved would offer a
      // batch the sender never sent, and completing it would report success for
      // a transfer that lost a file on the way in.
      console.error("relayium stored handoff resolve error", e);
      clearBatch();
      // `savedCount` is not re-zeroed here: this pass set it to 0 above, and
      // nothing between there and here can write it — a resolve only ever runs
      // from `idle`, and the only writer of a non-zero count is a receive that
      // has already finished. A second assignment would read as though one of
      // those could interleave.
      settleFailure(items, classify(e));
    } finally {
      // Only this room's own pass may release the latch. A stale continuation
      // that cleared it would let two resolves run against one surface.
      if (mine === epoch) resolving = false;
    }
  }

  return {
    get status() { return status; },
    get errorKey() { return errorKey; },
    get files() { return files; },
    get total() { return total; },
    get received() { return received; },
    get waitingCount() { return waitingCount; },
    get savedCount() { return savedCount; },
    get retryable() { return retryable; },

    offer(items) {
      let fresh = 0;
      for (const it of items) {
        // Absent means "never seen, or failed in a way worth trying again" —
        // and a resend from the peer IS that second attempt, arriving for free
        // on every reconnect.
        if (decided.has(it.id)) continue;
        decided.set(it.id, "held");
        waiting.push(it);
        fresh++;
      }
      if (!fresh) return; // a resend of what we already hold: the no-op §4.4 promises
      waitingCount = waiting.length;
      void advance();
    },

    async accept() {
      if (accepting || status !== "prompt" || batch.length === 0) return;
      accepting = true;
      const mine = epoch;
      // Captured here — synchronously, with the token, before the picker — so a
      // `reject()` while the dialog is up aborts THIS run's downloads, not
      // whatever the room does next. See `live`.
      const signal = live.signal;
      const running = batch;
      const runningItems = running.map((o) => o.item);
      let target: SaveTarget;
      try {
        // Inside the caller's click. Cancelling the picker is not a failure:
        // nothing happened, and the prompt stays exactly where it was so the
        // user can answer it again.
        target = await choose(files.slice(), STORED_RECEIVE_SAVE_OPTS);
      } catch (e) {
        // A stale run leaves `accepting` alone: reset()/reject() already cleared
        // it, and clearing it again could unlatch a run the NEW epoch started.
        if (mine !== epoch) return;
        accepting = false;
        if (e instanceof SaveCancelledError) return;
        savedCount = 0;
        settleFailure(runningItems, "saveFail");
        return;
      }
      // The picker is the longest window in this whole driver — a modal dialog,
      // open for as long as the user takes. If the room went away or the batch
      // was declined while it was up, the target that just resolved is a place
      // to write files nobody is waiting for any more.
      if (mine !== epoch) return;
      status = "receiving";
      received = 0;
      savedCount = 0;
      let base = 0;
      let filesClosed = 0;
      const written: HandoffItem[] = [];
      try {
        for (const obj of running) {
          await writeStoredObject({
            id: obj.item.id,
            key: obj.key,
            manifest: obj.manifest,
            target,
            specs: obj.specs,
            onProgress: (n) => { if (mine === epoch) received = base + n; },
            onFileClosed: () => { filesClosed++; },
            // One target for the whole batch, so only the last object may end it.
            finalize: false,
            // What actually stops a download that is already streaming.
            signal,
          });
          if (mine !== epoch) return;
          written.push(obj.item);
          base += obj.bytes;
          received = base;
        }
        // Exactly once, after every file in every object is closed. The ZIP
        // branch produces nothing at all without it.
        //
        // Re-checked immediately before, rather than leaning on the loop's last
        // round having just checked: that adjacency is load-bearing — `done()`
        // is the COMMIT, the call that assembles the archive and triggers the
        // browser download — and it is exactly the kind of thing a later edit
        // (an await slipped in after the loop, an empty-batch early path) breaks
        // without noticing. Stated where it matters, so it cannot be lost.
        if (mine !== epoch) return;
        await target.done?.();
        if (mine !== epoch) return;
        for (const it of runningItems) decided.set(it.id, "done");
        savedCount = 0;
        retryable = false;
        status = "done";
        // THE DELIVERY BOUNDARY, and the only place a whole batch crosses it:
        // every file of every object is closed AND the batch is finalised. Only
        // now can a target that commits locally honestly say the bytes are the
        // user's — which is what a completion tells the server, and what makes
        // it delete the only remaining copy.
        //
        // A `browserHandoff` target says nothing of the kind, however well the
        // save went: its close()/done() is an `<a download>` click or a service
        // worker stream, and the download can still fail out of our sight. The
        // user keeps their files either way; the sender keeps their ciphertext,
        // and — a joined room having no fallback expiry — keeps it until the
        // account is deleted. Open-ended storage is still the cheap side of this
        // trade: it is the owner's to measure and reclaim, while a file lost to
        // an early completion is nobody's to get back.
        if (target.delivery === "localCommit") void queueCompletions(runningItems);
      } catch (e) {
        if (mine !== epoch) return;
        console.error("relayium stored handoff receive error", e);
        // `bundled` targets hand the user nothing until done() runs, so a batch
        // that failed before it produced no file at all — and every object in it
        // is still worth retrying, including the ones that "finished".
        const perFile = target.bundled !== true;
        savedCount = perFile ? filesClosed : 0;
        if (perFile) for (const it of written) decided.set(it.id, "done");
        const unfinished = perFile
          ? runningItems.filter((it) => !written.includes(it))
          : runningItems;
        settleFailure(unfinished, classify(e));
        // A batch can fail and still have delivered part of itself. `written`
        // holds the objects whose every file was closed BEFORE the failure, so
        // on a per-file target that commits locally those are on the disk and
        // their proofs are true — the same fact `savedCount` is reporting one
        // line above. The object that failed is not in the list, and must not
        // be: completing it would delete the ciphertext the retry is going to
        // ask for. A `bundled` target delivered nothing at all (done() never
        // ran), which is exactly what `perFile` already says.
        if (perFile && target.delivery === "localCommit") void queueCompletions(written);
      } finally {
        if (mine === epoch) accepting = false;
      }
    },

    reject() {
      if (status !== "prompt") return;
      // The ids move from `held` to their RESTING state, which is the answer the
      // user just gave: a resend on the next reconnect must not re-ask a question
      // that has been answered. `held` happens to block a re-offer too, so this
      // write is not what stops the second prompt — it is what stops the state
      // from being a lie. Every other terminal path leaves either `done`, `spent`
      // or absent behind, and an id parked in "queued, or on screen right now"
      // for a batch that is neither is the kind of thing a later reader cleans
      // up, taking the refusal with it. The ciphertext outlives the refusal: a
      // decline is not a completion, and a joined room has no deadline to fall
      // back on, so the sender's copy is held until an operator or account
      // deletion removes it.
      for (const o of batch) decided.set(o.item.id, "rejected");
      // Anything already in flight for this batch — an open save picker above
      // all — is now answering a question that has been answered the other way.
      //
      // Only reachable from `prompt`, so there is no live download here to
      // abort; the abort half of this matters for the picker race, where the
      // manifest reads of a batch resolved moments ago may still be settling.
      invalidate();
      clearBatch();
      lastFailed = [];
      retryable = false;
      savedCount = 0;
      accepting = false;
      resolving = false;
      status = "idle";
      void advance();
    },

    retry() {
      if (status !== "failed" || lastFailed.length === 0) return;
      // Re-offer only what is still unsettled. A resend that arrived while the
      // failure card was up may already have re-queued some of these, and
      // queueing them twice would prompt for the same object in two batches.
      const again = lastFailed.filter((it) => !decided.has(it.id));
      lastFailed = [];
      retryable = false;
      for (const it of again) decided.set(it.id, "held");
      waiting = [...again, ...waiting];
      waitingCount = waiting.length;
      clearBatch();
      received = 0;
      errorKey = "";
      savedCount = 0;
      accepting = false;
      status = "idle";
      void advance();
    },

    dismiss() {
      if (status !== "done" && status !== "failed") return;
      clearBatch();
      received = 0;
      errorKey = "";
      savedCount = 0;
      // Dismissing is not declining: a retryable failure stays retryable, which
      // is what makes the sender's next resend pick it up. `lastFailed` goes
      // because the card that owned the retry control is gone with it.
      lastFailed = [];
      retryable = false;
      accepting = false;
      status = "idle";
      void advance();
    },

    reset() {
      // Before anything else: every continuation still awaiting a fetch, a
      // picker or a download belongs to the room that is ending, and each of
      // them would otherwise resume into this state — or, in the case of a
      // download whose body is already streaming, never yield control back to
      // be checked at all, and simply go on writing the old room's files.
      invalidate();
      // And the completion sync, which `invalidate()` deliberately does NOT
      // touch — see `completionEpoch`. This is the one event that ends it:
      // leaving the room ends the room's business, and a proof posted afterwards
      // would be spent from a pairing the user has left, possibly while a
      // different one is already on screen. What is dropped is a release that
      // will now never happen — nothing else ends a joined room's storage — but
      // it is only storage: the files were saved long ago.
      completionEpoch++;
      completionLive.abort();
      completionLive = new AbortController();
      pending = [];
      completing = false;
      decided.clear();
      waiting = [];
      waitingCount = 0;
      lastFailed = [];
      retryable = false;
      clearBatch();
      received = 0;
      savedCount = 0;
      errorKey = "";
      accepting = false;
      resolving = false;
      status = "idle";
    },

    active() {
      return status === "resolving" || status === "prompt" || status === "receiving";
    },
  };
}
