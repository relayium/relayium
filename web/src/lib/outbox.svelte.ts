// Shared "files waiting for a peer" queue. Three producers fill it: the OS share
// sheet (share-target), the pick-files-then-pair flow, and staging inside a code
// room that is still waiting for the other device (CodePairing). App's auto-send
// effect drains it the moment exactly one peer is reachable, so the sender never
// has to re-pick after the connection comes up.

import type { PickedFile } from "./drag";

let files = $state<PickedFile[]>([]);

/** Reactive read of the queued files ([] when none). */
export function outbox(): PickedFile[] {
  return files;
}

/** Replace the queue (a fresh pick supersedes any stale leftovers).
 *
 *  Deliberately still a REPLACE, next to addToOutbox below. The two producers
 *  that call it — the share sheet and the files-first pick — each mean "this
 *  batch is what I am sending", so a leftover from an abandoned attempt must not
 *  ride along. Staging inside a room means the opposite and appends. */
export function setOutbox(next: PickedFile[]): void {
  files = next;
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
  if (fresh.length) files = [...files, ...fresh];
}

/** Drop one staged file by position; an out-of-range index changes nothing.
 *
 *  Staging is only honest if it is reversible: a queue you can add to but not
 *  correct turns one misdrag into "start over and re-pick everything". */
export function removeFromOutbox(index: number): void {
  if (index < 0 || index >= files.length) return;
  files = [...files.slice(0, index), ...files.slice(index + 1)];
}

/** Drain the queue atomically: returns the files and empties it, so two racing
 *  consumers can't double-send the same batch. */
export function takeOutbox(): PickedFile[] {
  const drained = files;
  files = [];
  return drained;
}

export function clearOutbox(): void {
  files = [];
}
