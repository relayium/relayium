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
 *  outbox handle (outboxToken), not an index: the queue moves while this runs. */
export interface PreuploadProgress {
  token: string;
  sent: number;
  total: number;
}

let notice = $state<PreuploadNotice>("");
let progress = $state<PreuploadProgress | null>(null);

/** Reactive read of the one thing the waiting room may have to explain. */
export function preuploadNotice(): PreuploadNotice {
  return notice;
}

/** Reactive read of the upload in flight, or null. */
export function preuploadProgress(): PreuploadProgress | null {
  return progress;
}

/**
 * Whether this BUILD may pre-upload at all.
 *
 * The gate is its own `preupload/1` announcement, and that is not a coincidence
 * dressed up as a rule: the announcement means "I can send frame kind 10", and
 * frame kind 10 is the only way an uploaded object's key ever reaches the
 * receiver. A build that uploads without it produces ciphertext nobody can open
 * — the receiver joins, is handed nothing, and the objects sit in storage until
 * the room's deadline deletes them. That is strictly worse than not
 * pre-uploading at all.
 *
 * So the checkpoint that wires the handoff turns the sender on by announcing the
 * capability, and nothing else can. Today it is false
 * (preupload-handoff.test.ts pins the announcement's absence).
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
    // A different room: its own deadline, its own refusals, its own explanation.
    activeCode = code;
    held = false;
    closed = false;
    notice = "";
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
  activeCode = "";
  skipped.clear();
  held = false;
  closed = false;
  notice = "";
  progress = null;
  inFlight?.abort();
  inFlight = null;
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
      try {
        const res = await uploadFileResumable(
          [picked.file],
          { purpose: "pair_room", code },
          (p) => {
            progress = { token, sent: p.sent, total: p.total };
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
      } catch (e) {
        const at = outboxIndexOf(token);
        // Back to `staged`, so the live link picks it up on join. An entry
        // parked in `uploading` is a file that would go over neither transport.
        if (at >= 0) failUpload(at);
        if (!continueAfter(e)) return;
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
 */
function continueAfter(e: unknown): boolean {
  // An abort is this module's own doing — the file left the queue, or the room
  // was abandoned — and it says nothing about whether more work is possible. So
  // it never ends the pass: the loop's own top decides that, from the room that
  // is active by then. Ending here instead would strand a freshly minted room
  // whose predecessor's upload was aborted to make way for it.
  if (e instanceof DOMException && e.name === "AbortError") return true;
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
      return false;
    default:
      // 403 (no live code this instance minted, or not this account's), 503 (not
      // offered here), 413/429 (quota), 500, a network failure, a malformed id:
      // all leave the batch exactly as it was and the live link exactly as it
      // was. Stop asking — every one of them will answer the same way for the
      // next file — and say nothing.
      closed = true;
      return false;
  }
}
