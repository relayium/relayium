// Shared "files waiting for a peer" queue. Three producers fill it: the OS share
// sheet (share-target), the pick-files-then-pair flow, and staging inside a code
// room that is still waiting for the other device (CodePairing). App's auto-send
// effect drains it the moment exactly one peer is reachable, so the sender never
// has to re-pick after the connection comes up.

import type { PickedFile } from "./drag";

/**
 * Where one queued file's bytes are.
 *
 * `staged` — on this device only, to be sent over the live link when a peer
 * arrives. Every entry starts here, and this is the only state that existed
 * before pre-upload.
 * `uploading` — ciphertext is going up against the pairing code right now.
 * `uploaded` — the server holds the ciphertext; the receiver will fetch it and
 * be given the key over the end-to-end channel.
 *
 * There is deliberately no `failed`: a pre-upload that fails goes back to
 * `staged`, because the live link is the answer to "the upload did not work",
 * and an entry parked in a terminal failure state is a file the user watched
 * disappear from both transports.
 */
export type OutboxUploadState = "staged" | "uploading" | "uploaded";

/** What the receiver needs to fetch one pre-uploaded file: the stored object's
 *  id, and the key the server has never seen. Delivered over the peers' own
 *  encrypted channel (docs/protocol/relayium-pair-room-v1.md §4), never over
 *  signaling and never to the server. */
export interface StoredRef {
  id: string;
  /** base64url, no padding — the stored-wire key encoding. */
  key: string;
}

interface Entry {
  state: OutboxUploadState;
  /** Set exactly when state === "uploaded". */
  ref?: StoredRef;
  /** This entry's stable handle — see outboxToken. */
  token: string;
}

/** Source of entry handles. Monotonic for the life of the page and never reset,
 *  so a handle taken before a clear can never name an entry queued after it. */
let nextToken = 1;

let files = $state<PickedFile[]>([]);
/**
 * Per-entry upload state, index-aligned with `files`.
 *
 * A parallel array rather than a field on PickedFile: PickedFile is what the
 * drag/share/picker layers produce and what PendingFiles renders, and threading
 * a transport concern through all of them would put upload state in three more
 * places that can disagree. Every mutator below moves both arrays together, so
 * the alignment is a local invariant of this file.
 */
let states = $state<Entry[]>([]);

/** Reactive read of the queued files ([] when none). */
export function outbox(): PickedFile[] {
  return files;
}

/** This entry's transport state; `staged` for any index that has none. */
export function outboxState(index: number): OutboxUploadState {
  return states[index]?.state ?? "staged";
}

/**
 * Every already-uploaded entry's stored reference, in queue order.
 *
 * This is the input to the key-handoff message: the sender sends exactly these
 * on every (re)established link, and the receiver dedupes by id
 * (preupload-handoff.ts).
 */
export function uploadedRefs(): StoredRef[] {
  const out: StoredRef[] = [];
  for (const e of states) if (e?.state === "uploaded" && e.ref) out.push(e.ref);
  return out;
}

/** Mark the entry at `index` as being uploaded right now. Out of range, or an
 *  entry already past staging, changes nothing. */
export function markUploading(index: number): void {
  if (outboxState(index) !== "staged" || index >= files.length) return;
  // The handle rides through every transition: it is what the uploader resolves
  // against, so a state change that minted a new one would strand the upload.
  states = states.map((e, i) => (i === index ? { state: "uploading", token: e.token } : e));
}

/** Record that the entry at `index` is on the server under `ref`. Only an entry
 *  that is actually uploading can complete: a stale callback from a cancelled or
 *  removed upload must not resurrect one. */
export function markUploaded(index: number, ref: StoredRef): void {
  if (outboxState(index) !== "uploading") return;
  states = states.map((e, i) => (i === index ? { state: "uploaded", ref, token: e.token } : e));
}

/** Return a failed upload to the live-link path. Idempotent. */
export function failUpload(index: number): void {
  if (outboxState(index) !== "uploading") return;
  states = states.map((e, i) => (i === index ? { state: "staged", token: e.token } : e));
}

/**
 * A stable handle to the entry at `index`, or "" for an index that has none.
 *
 * An index answers "where is this file now", and that is not the question a
 * pre-upload asks. An upload runs for minutes while the user goes on adding and
 * removing files, so the index it started from can name a different file — or no
 * file — by the time it finishes. Marking a completion by that index files one
 * file's stored key under another file's row, or silently strands the entry that
 * moved. Take a handle before starting, resolve it again at every state change.
 */
export function outboxToken(index: number): string {
  if (index < 0 || index >= states.length) return "";
  return states[index].token;
}

/** Where the entry with this handle is now, or -1 if it is gone (removed,
 *  replaced or cleared). "Gone" is a real answer and the caller must act on it:
 *  the alternative — falling back to the original index — is exactly the
 *  wrong-row write this exists to prevent. */
export function outboxIndexOf(token: string): number {
  if (!token) return -1;
  return states.findIndex((e) => e.token === token);
}

/** A fresh `staged` entry per file. */
const stagedFor = (list: readonly unknown[]): Entry[] =>
  list.map(() => ({ state: "staged" as const, token: `e${nextToken++}` }));

/** Replace the queue (a fresh pick supersedes any stale leftovers).
 *
 *  Deliberately still a REPLACE, next to addToOutbox below. The two producers
 *  that call it — the share sheet and the files-first pick — each mean "this
 *  batch is what I am sending", so a leftover from an abandoned attempt must not
 *  ride along. Staging inside a room means the opposite and appends. */
export function setOutbox(next: PickedFile[]): void {
  files = next;
  states = stagedFor(next);
}

/** Identity of a picked file for dedupe purposes.
 *
 *  Reference equality is useless here: picking the same file twice hands us two
 *  distinct File objects. Name+size+lastModified is what the browser gives us
 *  without reading the bytes, and re-picking one file is the case worth
 *  catching — not two genuinely different files that collide on all three. */
const identity = (p: PickedFile): string =>
  `${p.file.name}:${p.file.size}:${p.file.lastModified}`;

/** Append to the queue, skipping anything already queued.
 *
 *  This is what staging in a waiting code room uses: each pick adds to the batch
 *  rather than discarding what is already there, so "drag in a few files, then a
 *  few more" behaves the way it looks. Dedupe covers both directions — against
 *  what is already queued, and within a single call. */
export function addToOutbox(next: PickedFile[]): void {
  const seen = new Set(files.map(identity));
  const fresh: PickedFile[] = [];
  for (const p of next) {
    const key = identity(p);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(p);
  }
  if (fresh.length) {
    files = [...files, ...fresh];
    states = [...states, ...stagedFor(fresh)];
  }
}

/** Drop one staged file by position; an out-of-range index changes nothing.
 *
 *  Staging is only honest if it is reversible: a queue you can add to but not
 *  correct turns one misdrag into "start over and re-pick everything". */
export function removeFromOutbox(index: number): void {
  if (index < 0 || index >= files.length) return;
  files = [...files.slice(0, index), ...files.slice(index + 1)];
  states = [...states.slice(0, index), ...states.slice(index + 1)];
}

/**
 * Drain the entries the LIVE LINK is responsible for: returns the staged files
 * and removes exactly those, leaving anything uploading or uploaded in place.
 *
 * This is the seam between the two transports, and the whole reason per-entry
 * state exists. App's auto-send effect drains this the moment a peer is
 * reachable; if it drained everything, a file that was already pre-uploaded
 * would ALSO go over the link — one transfer sent twice and billed twice, with
 * the receiver writing the same file from two sources.
 *
 * Still atomic for its own population, so two racing consumers cannot both take
 * the same staged file. With nothing uploaded (every entry staged, which is
 * every queue until a pre-upload starts) this is exactly the drain-everything it
 * has always been.
 */
export function takeOutbox(): PickedFile[] {
  const drained: PickedFile[] = [];
  const keptFiles: PickedFile[] = [];
  const keptStates: Entry[] = [];
  files.forEach((p, i) => {
    if (outboxState(i) === "staged") {
      drained.push(p);
      return;
    }
    keptFiles.push(p);
    keptStates.push(states[i]);
  });
  files = keptFiles;
  states = keptStates;
  return drained;
}

export function clearOutbox(): void {
  files = [];
  states = [];
}
