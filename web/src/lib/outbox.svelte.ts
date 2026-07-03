// Shared "files waiting for a peer" queue. Two producers fill it: the OS share
// sheet (share-target) and the pick-files-then-pair flow (CodePairing). App's
// auto-send effect drains it the moment exactly one peer is reachable, so the
// sender never has to re-pick after the connection comes up.

import type { PickedFile } from "./drag";

let files = $state<PickedFile[]>([]);

/** Reactive read of the queued files ([] when none). */
export function outbox(): PickedFile[] {
  return files;
}

/** Replace the queue (a fresh pick supersedes any stale leftovers). */
export function setOutbox(next: PickedFile[]): void {
  files = next;
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
