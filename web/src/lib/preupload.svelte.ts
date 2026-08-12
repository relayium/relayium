// The sender half of pre-upload: spend the wait for the other device by pushing
// the staged batch up as ciphertext bound to the pairing code, instead of
// sitting idle until someone joins.
//
// Authoritative definition: docs/protocol/relayium-pair-room-v1.md. The three
// facts this module exists to honour:
//
//   - ONE OBJECT PER FILE. Never per batch. That is what makes "already
//     uploaded comes from storage, not yet started goes over the live link" a
//     per-file decision, and it is why no single file is ever split across the
//     two transports.
//   - THE STATUS IS THE ANSWER. 409 means the peer is already here (start no
//     more, let the running one finish), 410/404 mean the room is over and its
//     ciphertext is gone (this file goes back to the live-link lane), 403/503
//     mean this code or this deployment cannot pre-upload at all (say nothing,
//     change nothing — the live link is what always happened).
//   - THE KEY NEVER LEAVES THIS PAGE. Each object's key is held in the outbox
//     and handed to the peer over the peers' own end-to-end channel
//     (preupload-handoff.ts). The server sees ciphertext and an opaque id.
//
// Deliberately NOT tied to any component's lifetime. The waiting-room surface
// unmounts the moment a peer joins, and an upload in flight at that moment is
// allowed to finish (only a NEW init is refused with 409). A driver owned by
// that component would abort exactly the upload the protocol says to keep.

import { uploadFileResumable, UploadError } from "./stored-file";
import {
  outbox,
  outboxState,
  outboxToken,
  outboxIndexOf,
  markUploading,
  markUploaded,
  failUpload,
  releaseUploaded,
} from "./outbox.svelte";
import { advertisedCaps } from "./peer-caps.svelte";
import { CAP_PREUPLOAD } from "./preupload-handoff";

/**
 * What the user is owed an explanation for.
 *
 * `""` for everything that changed nothing they can see: the peer joined and the
 * live link takes over, this deployment does not offer pre-upload, the code is
 * not one this instance can bind to, the account is out of quota, the network
 * dropped. In every one of those the staged files are exactly where they were
 * and behave exactly as they did before pre-upload existed, so an error message
 * would invent a problem.
 *
 * `"expired"` is the one case with a visible consequence: bytes went up, the
 * room's deadline passed before the transfer could start, and the server deleted
 * that ciphertext. The files are back in the live-link lane and the code is dead,
 * so the user has to mint a new one — and is told so rather than left looking at
 * a batch that quietly stopped moving.
 */
export type PreuploadNotice = "" | "expired";

/** Which entry is uploading right now and how far it has got. `token` is the
 *  outbox handle (outboxToken), not an index: the queue moves while this runs.
 *  `code` is the room those bytes are bound to — a reader that acts on "an
 *  upload is in flight" has to know whether it is in flight for ITS room, and a
 *  surface can outlive the room whose upload is still winding down. */
export interface PreuploadProgress {
  code: string;
  token: string;
  sent: number;
  total: number;
}

/**
 * Where the room's deadline stood the last time the server said so.
 *
 * The pairing code's on-screen countdown runs from the MINT; the room's real
 * deadline runs from the last committed byte (docs/protocol/relayium-pair-room-v1.md §2)
 * and the code is dragged along with it. Nothing polls, so a client only ever
 * hears about it on the responses to requests it was making anyway: every
 * append's ack, the resume probe that recovers a lost one, and finalize.
 *
 * Scoped to a code because it is one room's fact: room A's window says nothing
 * about the digits the user is looking at now, and it can easily be the LATER of
 * the two.
 */
export interface PreuploadDeadline {
  code: string;
  /** Unix seconds, the server's clock — the same units the mint's expiry uses. */
  expiresAt: number;
}

/**
 * The largest number that can be a room deadline AT ALL, and the reason this
 * module filters: a room somebody has JOINED has no expiry, and the server says
 * so with math.MaxInt64 (≈9.22e18). The code is a different clock — extended to
 * the join deadline, never to never — so that number is not one to count down to.
 *
 * An ABSOLUTE instant, deliberately, and not `Date.now() + MAX_JOINABLE`. That
 * earlier ceiling read the server's answer through this browser's clock, and the
 * two are not related: a device hours behind (a hand-set clock, a dead battery, a
 * timezone written into the clock itself) is otherwise working perfectly, and
 * every honest deadline it is handed sits past a ceiling anchored to its own now.
 * Discarding one costs exactly what this feature buys — the card falls back to
 * the mint's five minutes and announces a dead code while the server is still
 * admitting the receiver, with a button offering to burn the rendezvous.
 *
 * So the test is only "is this a Unix second at all". 1e11 is the year 5138: past
 * anything a deadline can honestly be, and far below both the sentinel and a
 * millisecond timestamp sent where seconds were meant (≈1.8e12) — the two ways a
 * number that is not Unix seconds actually reaches here. Skew cannot fake either.
 *
 * It deliberately does NOT reject a deadline in this browser's past. That is a
 * legitimate answer (the room really is over, or the clock is FAST), and the
 * forward-only rule plus the server's own 410 already handle it; rejecting it
 * here would put the local clock back in the decision by the other door.
 */
const MAX_PLAUSIBLE_DEADLINE = 1e11;

let notice = $state<PreuploadNotice>("");
let progress = $state<PreuploadProgress | null>(null);
let deadline = $state<PreuploadDeadline | null>(null);
/**
 * The room whose window this client CANNOT speak for, "" when there is none.
 *
 * The residual ambiguity, and the one state that has to exist rather than be
 * approximated by one of the other two. An append can commit bytes — extending
 * the room, and with it the code — and then have its answer, and the resume
 * probe behind it, both lost. From here that is indistinguishable from an append
 * that landed nowhere, so this client knows two things and not a third: bytes
 * went up, and where the window ended is not something it was told.
 *
 * What it must NOT do is resolve that either way. Falling back to the mint
 * announces a dead code and offers to burn a rendezvous the server may still be
 * admitting joins on — the failure this whole change exists to close. Assuming
 * the extension instead leaves a code that quietly stopped working looking fine
 * forever. So it is carried as its own answer, and the surface says so.
 */
let unconfirmed = $state("");

/** Reactive read of the one thing the waiting room may have to explain. */
export function preuploadNotice(): PreuploadNotice {
  return notice;
}

/** Reactive read of the upload in flight, or null. */
export function preuploadProgress(): PreuploadProgress | null {
  return progress;
}

/** Reactive read of the last deadline the server reported for the room being
 *  pre-uploaded into, or null while nothing has finished in it. */
export function preuploadDeadline(): PreuploadDeadline | null {
  return deadline;
}

/** Reactive read of the room whose window could not be confirmed, "" when none
 *  — see `unconfirmed`. */
export function preuploadUnconfirmed(): string {
  return unconfirmed;
}

/**
 * Record what the server just said about `code`'s room.
 *
 * Forward only, and per room. Forward because that is the server's own rule for
 * both the room and the code (§2): an extension may push a deadline out, never
 * pull it in, so an answer older than one already held is not news. Per room
 * because the caller can be a landing from a room that is already over, and its
 * window — usually the later of the two — must not become the current room's.
 *
 * A usable answer also ENDS any doubt about that room, and does so even when the
 * forward-only rule then discards it. Every deadline is measured from a byte the
 * server committed, and this one was committed after whatever ambiguous append
 * came before it, so the window it names is at or past anything the lost answer
 * could have bought. Certainty replaces doubt rather than sitting beside it.
 */
function noteDeadline(code: string, expiresAt: number): void {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return;
  if (expiresAt > MAX_PLAUSIBLE_DEADLINE) return; // a joined room's "never"
  if (unconfirmed === code) unconfirmed = "";
  if (deadline?.code === code && deadline.expiresAt >= expiresAt) return;
  deadline = { code, expiresAt };
}

/**
 * Whether this BUILD may pre-upload at all.
 *
 * The gate is its own `preupload/1` announcement, and that is not a coincidence
 * dressed up as a rule: the announcement means "I can send frame kind 12", and
 * frame kind 12 is the only way an uploaded object's key ever reaches the
 * receiver. A build that uploads without it produces ciphertext nobody can open
 * — the receiver joins, is handed nothing, and the objects stay in storage for
 * good: a joined room has no deadline and no fallback expiry, so with no
 * completion ever spent against them, nothing but an operator or account
 * deletion removes them. That is strictly worse than not pre-uploading at all.
 *
 * So the checkpoint that wires the handoff turned the sender on by announcing
 * the capability, and nothing else can. It is true from that checkpoint on
 * (preupload-handoff.test.ts pins the announcement, and preupload.test.ts pins
 * that withdrawing it stops the uploader too).
 */
export function preuploadSenderReady(): boolean {
  return advertisedCaps().includes(CAP_PREUPLOAD);
}

/** The room being pre-uploaded into, "" when none. */
let activeCode = "";
/** No further uploads may START. Set when the peer joined (locally observed, or
 *  the server's 409) and when the waiting surface goes away. Never aborts. */
let held = false;
/** This room can take no more pre-uploads at all — its deadline passed, or the
 *  server refused the binding outright. */
let closed = false;
/**
 * Whether a pass is running, and the promise of the running one.
 *
 * A boolean rather than "is the promise non-null", because the promise settles a
 * turn later than the loop stops: a start that arrived in that gap would be
 * handed a pass which has already decided to end, and the room it was for would
 * never get a driver. `running` is set and cleared inside the loop itself, with
 * no await between the decision and the flag.
 */
let running = false;
let driver: Promise<void> = Promise.resolve();
/** Aborts only the upload in flight, and only when its file is gone. */
let inFlight: AbortController | null = null;

/**
 * Pre-upload the staged batch against `code`, and keep doing so as more files
 * are staged, until the room stops accepting them.
 *
 * Idempotent: calling it again while it runs joins the running pass rather than
 * starting a second one. Two drivers would open two sessions for one room, and
 * (worse) could both claim the same entry between its state read and its
 * markUploading. A running pass follows the room — it re-reads which room it is
 * working for between files — so a code change does not need a second driver.
 *
 * @param ready whether this build may pre-upload — see preuploadSenderReady,
 *   whose answer is the default. The parameter exists so the sender's own tests
 *   can prove this works before the handoff that turns it on lands; production
 *   callers pass nothing and get the real gate.
 */
export function startPreupload(code: string, ready = preuploadSenderReady()): Promise<void> {
  if (!ready || !code) return Promise.resolve();
  if (code !== activeCode) {
    // A different room: its own deadline, its own refusals, its own explanation
    // — and none of the previous room's objects.
    leaveRoom();
    activeCode = code;
  }
  if (!running) driver = drive();
  return driver;
}

/**
 * Start no further uploads for `code`; let the one in flight finish.
 *
 * This is the join, seen from this side. The protocol allows the running upload
 * to complete on purpose — its bytes are already sent and already billed, and
 * only a new init is refused — so this must never abort.
 *
 * Scoped to a room, and that is not decoration. The caller is a surface being
 * torn down, and a torn-down surface can belong to a room that is already over
 * — the choose screen, or the previous code after a re-mint — while a driver for
 * the CURRENT room is running. An unscoped hold would stop that driver, and no
 * later call would clear it: startPreupload only re-arms when the code changes,
 * and it has not.
 */
export function holdPreupload(code: string): void {
  if (code && code === activeCode) held = true;
}

/** Leaving the room: stop, abandon anything in flight, and forget the
 *  explanation with the room it belonged to. */
export function resetPreupload(): void {
  leaveRoom();
  activeCode = "";
}

/**
 * The room boundary — everything that must not survive one room into the next.
 *
 * ONE function, called from both entry points that can notice the change
 * (`resetPreupload`, and `startPreupload` being handed a different code),
 * because the two halves of "this room is over" have to be inseparable. An
 * upload in flight is aborted; that half was always here. The half that was
 * missing is what a FINISHED upload leaves behind:
 *
 * A completed pre-upload puts its entry in `uploaded`, which means "no lane owes
 * this file anything — the handoff will name it". That is only true for the room
 * it went into. Its object is bound to THAT room, dies on that room's deadline,
 * and its id is meaningless to the peer that joins the next one. Left alone
 * across a re-mint, the entry belongs to nobody: the live link skips it (it is
 * not `staged`), the driver never picks it up again (same reason), and the
 * handoff would hand the new peer keys to a fetch that 404s. The file the user
 * staged simply never arrives, and nothing on screen says so.
 *
 * So the boundary returns those entries to `staged`, exactly as a failed upload
 * is returned — the live link is always the answer to "this object is no longer
 * reachable" — and the new room's driver uploads them again under its own code.
 * The old objects are deliberately not deleted from the server: their life is
 * the old room's, whose deadline reclaims them (see releaseUploaded).
 *
 * It also leaves `uploadedRefs()` empty at the moment the room changes, which is
 * what makes the handoff's late pull safe: the set can only ever describe the
 * room that is current, so there is no window in which a stale ref could be
 * sealed into a frame at all.
 */
function leaveRoom(): void {
  skipped.clear();
  held = false;
  closed = false;
  notice = "";
  progress = null;
  // The old room's deadline goes with the old room's objects. Left behind it
  // would hold the NEXT code's countdown open on a window that belongs to digits
  // nobody can join with any more. Doubt is one room's fact for exactly the same
  // reason: what could not be confirmed about a room the user has left is not a
  // reason to be vague about the one now on screen.
  deadline = null;
  unconfirmed = "";
  inFlight?.abort();
  inFlight = null;
  releaseUploaded();
}

/**
 * Entries this driver has decided not to pre-upload, by outbox handle.
 *
 * They stay `staged` — the live link is exactly where they belong — so without
 * this the loop would pick the same one again on every pass and never reach the
 * files after it. Handles, not indices, because the queue moves; cleared with
 * the room in resetPreupload.
 */
const skipped = new Set<string>();

/** The first entry the live link has not been handed, no upload has claimed, and
 *  this driver has not passed over. */
function nextStaged(): number {
  return outbox().findIndex((_, i) => outboxState(i) === "staged" && !skipped.has(outboxToken(i)));
}

/**
 * One pass over the queue: upload each staged file the room will still take.
 *
 * The whole loop sits inside this function's own try/finally deliberately. Every
 * exit is a `return` from inside it, so `running` is cleared in the same turn the
 * decision to stop is made — with the loop extracted into a second function, the
 * flag would survive one microtask past the decision, and a start arriving in
 * that gap would be handed a pass that has already given up, leaving its room
 * with no driver at all.
 */
async function drive(): Promise<void> {
  running = true;
  try {
    for (;;) {
      // Re-read the room every time round: minting a fresh code replaces it, and
      // this pass follows rather than needing a second one behind it.
      const code = activeCode;
      if (!code || held || closed) return;
      const index = nextStaged();
      if (index < 0) return;
      const token = outboxToken(index);
      const picked = outbox()[index];
      // A folder's file keeps its relative path only on the live link: the
      // stored manifest carries names and sizes and nothing else, so
      // pre-uploading one would silently flatten the folder the receiver is
      // meant to get back. Passed over rather than uploaded — slower, and
      // correct — and the flat files in the same batch still go up.
      if (picked.path) {
        skipped.add(token);
        continue;
      }
      markUploading(index);
      const ctl = new AbortController();
      inFlight = ctl;
      // Whether THIS attempt got as far as handing bytes to the network. It is
      // what decides how its failure may be read: before it, nothing moved on
      // the server and the code's own window is untouched; after it, an append
      // may have committed and extended the room without ever saying so.
      let onWire = false;
      try {
        const res = await uploadFileResumable(
          [picked.file],
          { purpose: "pair_room", code },
          (p) => {
            progress = { code, token, sent: p.sent, total: p.total };
            if (p.onWire) onWire = true;
            // Every response that names the room's deadline, taken as it
            // arrives: the append's ack and the probe that recovers a lost one.
            // Waiting for finalize is what left a failed batch with nothing.
            //
            // Guarded on the room still being the active one for the same reason
            // the landing below is: a tick from an upload whose room the user has
            // already left must not file that room's window over the new one's.
            if (p.expiresAt !== undefined && code === activeCode) noteDeadline(code, p.expiresAt);
            // The user removed this file (or cleared the batch) while its bytes
            // were going up. Nothing will ever be handed the key, so stop paying
            // for the rest of them.
            if (outboxIndexOf(token) < 0) ctl.abort();
          },
          ctl.signal,
        );
        const at = outboxIndexOf(token);
        // Two ways this upload can be worth nothing by the time it lands, and
        // both end with the entry back on the live link rather than marked
        // uploaded:
        //
        //   - the entry is gone (removed, or the batch was cleared). Never mark
        //     by the starting index — that index may now hold a different file,
        //     and this key is not its key. The object dies with the room.
        //   - the room changed underneath it. The object is bound to the room it
        //     was uploaded into, so its ciphertext dies on THAT room's deadline;
        //     handing its key to the new room's peer would promise a fetch that
        //     404s. The bytes are spent either way — the file is not.
        if (at < 0) continue;
        if (activeCode !== code) {
          failUpload(at);
          continue;
        }
        markUploaded(at, { id: res.id, key: res.key });
        // Recorded only on the path that keeps the object, and only under the
        // room that is still current — the two refusals above have already
        // returned. This response is the one moment the server tells a client
        // where the room's window now ends, and therefore how long the code it
        // is showing has left.
        noteDeadline(code, res.expiresAt);
      } catch (e) {
        const at = outboxIndexOf(token);
        // Back to `staged`, so the live link picks it up on join. An entry
        // parked in `uploading` is a file that would go over neither transport.
        if (at >= 0) failUpload(at);
        if (!continueAfter(e, code, onWire)) return;
      } finally {
        inFlight = null;
        progress = null;
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Classify a failed upload: whether to try the next staged file, and what (if
 * anything) the user is owed.
 *
 * Nothing here retries the file that just failed. `uploadFileResumable` has
 * already exhausted its own per-chunk retries, and a driver that re-queued the
 * same file would spend the room's remaining seconds — and the account's
 * traffic — on a batch it is no longer able to finish.
 *
 * `code` and `onWire` are what the failure has to be read AGAINST: which room it
 * was for, and whether it happened after bytes had been handed to the network.
 */
function continueAfter(e: unknown, code: string, onWire: boolean): boolean {
  // Doubt about a room the user has already left is not doubt about the one on
  // screen — and `leaveRoom` has already cleared this room's state, which a late
  // landing must not undo.
  const mayBeExtended = onWire && code === activeCode;
  // An abort is this module's own doing — the file left the queue, or the room
  // was abandoned — and it says nothing about whether more work is possible. So
  // it never ends the pass: the loop's own top decides that, from the room that
  // is active by then. Ending here instead would strand a freshly minted room
  // whose predecessor's upload was aborted to make way for it.
  if (e instanceof DOMException && e.name === "AbortError") {
    // Its bytes were still bytes. An abort stops the request, not whatever the
    // server had already committed of it, so a room it may have extended is
    // exactly as unconfirmable as any other lost answer.
    if (mayBeExtended) unconfirmed = code;
    return true;
  }
  const status = e instanceof UploadError ? e.status : 0;
  switch (status) {
    case 409:
      // Someone joined. Start no more; the live link carries the rest, which is
      // what the sender was always going to get for files picked after a join.
      held = true;
      return false;
    case 410:
    case 404:
      // The room's deadline passed and its ciphertext is gone (410), or the void
      // already reclaimed the session so there is nothing left to append to
      // (404). Terminal for the whole room, and the only refusal with a
      // consequence the user can see.
      closed = true;
      notice = "expired";
      // And it outranks every deadline this module was ever handed. A window an
      // earlier file bought can still be in the future when the room is voided
      // early — an operator, a deleted account — and a card counting that window
      // down would go on offering a rendezvous the server has already emptied.
      // The server is the authority on the room being over; nothing this client
      // was told before that may argue with it — including this module's own
      // "I could not tell", which is a statement about missing evidence and has
      // nothing left to be true about once the evidence arrives.
      deadline = null;
      unconfirmed = "";
      return false;
    default:
      // 403 (no live code this instance minted, or not this account's), 503 (not
      // offered here), 413/429 (quota), 500, a network failure, a malformed id:
      // all leave the batch exactly as it was and the live link exactly as it
      // was. Stop asking — every one of them will answer the same way for the
      // next file — and say nothing.
      //
      // Say nothing about the FILES, that is. If bytes had already gone out, the
      // room may have been extended by them and this client was not told where
      // to, and none of these statuses is an answer to that question: a 500 in
      // particular is returned by an append that has already committed its bytes
      // and moved the room in the same transaction.
      if (mayBeExtended) unconfirmed = code;
      closed = true;
      return false;
  }
}
