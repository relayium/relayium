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
  StoredDownloadHttpError,
  DownloadNetworkError,
} from "./stored-file";
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
 * `gone` cannot: the room's deadline passed and the ciphertext was deleted, so
 * every retry is a request for something that is not there, and the remedy is a
 * new code. `decryptFail` cannot either: the key the peer sent does not open its
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
 * said "try again", nothing ever tried, and the files sat in storage until the
 * room deleted them.
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

  function classify(e: unknown): StoredReceiveError {
    if (e instanceof DownloadNetworkError) return "netFail";
    if (e instanceof SinkTransportError || e instanceof SinkCancelledError) return "saveFail";
    if (e instanceof StoredDownloadHttpError) {
      // 404/410 is the room's own deadline having passed and the ciphertext
      // deleted with it — the one failure whose remedy is "ask for a new code",
      // not "try again". Everything else the server says is a transport-shaped
      // problem the user can retry.
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
   * handoff belongs to ONE pairing room: a `gone` on any of them is the room's
   * own deadline having passed, which took the others with it. A `decryptFail`
   * is a sender that is broken or hostile about the keys it sent, which is not a
   * property of one item either. So there is no healthy remainder being written
   * off — and the all-or-nothing report the user already saw stays true.
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
      // up, taking the refusal with it. The ciphertext expires with the room,
      // which is what the sender's own deadline is for.
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
