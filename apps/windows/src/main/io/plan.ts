// Turning a manifest into a write plan — or refusing it, before touching disk.
//
// ## Why the whole manifest is judged before the first byte is written
//
// A per-file check that runs as each file arrives has already created files by
// the time it meets the one it must refuse. The receiver is then in the state
// this codebase refuses to report honestly anywhere else: partially delivered,
// with no single true answer to "did it save?". So the plan is total — every
// entry validated, every pair compared — and a manifest with one bad entry
// produces zero files rather than N-1.
//
// ## The two conflicts a per-name validator cannot see
//
// `winpath.validateRelativePath` judges one name in isolation and is blind to
// the manifest's own shape:
//
//   * **Case collision.** `A.txt` and `a.txt` are both valid names and the same
//     NTFS file. Writing both means the second silently replaces the first and
//     the receiver is told two files arrived.
//   * **File-versus-parent.** `file` and `file/child` are both valid names, and
//     no ordering satisfies them: creating `file` makes `file/child` fail with
//     ENOTDIR, creating `file/` makes `file` fail with EISDIR. A manifest
//     containing both is unsatisfiable, and the honest answer is to say so
//     before creating either.

import { collisionKey, validateRelativePath, type PathRejection } from "./winpath.js";

export interface ManifestEntry {
  readonly name: string;
  readonly size: number;
}

export interface PlannedFile {
  /** Validated, separator-split components, relative to the chosen root. */
  readonly segments: readonly string[];
  /** The exact byte count the sink will require. Never re-derived later. */
  readonly size: number;
}

export type PlanFailure =
  | { readonly kind: "path"; readonly name: string; readonly reason: PathRejection }
  | { readonly kind: "duplicate"; readonly name: string; readonly conflictsWith: string }
  | { readonly kind: "file-vs-parent"; readonly name: string; readonly conflictsWith: string }
  | { readonly kind: "size"; readonly name: string }
  | { readonly kind: "count" }
  | { readonly kind: "total-size" };

export type PlanResult =
  | { readonly ok: true; readonly files: readonly PlannedFile[]; readonly totalBytes: number }
  | { readonly ok: false; readonly failure: PlanFailure };

/** Matches the realtime wire's `MAX_FILES`. A manifest above it is refused by
 *  the wire decoder too; repeated here so the planner is not the weaker gate. */
export const MAX_FILES = 1000;
/** `Number.MAX_SAFE_INTEGER` is the Device Inbox manifest's declared ceiling,
 *  chosen because one of the implementations runs in a browser. */
export const MAX_TOTAL_BYTES = Number.MAX_SAFE_INTEGER;

/**
 * Validate an entire manifest and produce the write plan, or the first failure.
 *
 * Deterministic in the manifest's own order: the same manifest always names the
 * same offending entry, so a refusal message is reproducible from a bug report.
 */
export function planManifest(entries: readonly ManifestEntry[]): PlanResult {
  if (entries.length > MAX_FILES) return { ok: false, failure: { kind: "count" } };

  const files: PlannedFile[] = [];
  /** collision key -> the name that claimed it, for a truthful conflict message. */
  const claimed = new Map<string, string>();
  /** every directory prefix any entry needs, so a later file can be refused. */
  const directories = new Map<string, string>();
  let totalBytes = 0;

  for (const entry of entries) {
    const verdict = validateRelativePath(entry.name);
    if (!verdict.ok || !verdict.segments) {
      return { ok: false, failure: { kind: "path", name: entry.name, reason: verdict.reason ?? "empty" } };
    }
    // A size that is not a non-negative safe integer cannot be compared against
    // a byte counter, so a sink built on it could never detect a short write.
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      return { ok: false, failure: { kind: "size", name: entry.name } };
    }
    totalBytes += entry.size;
    if (totalBytes > MAX_TOTAL_BYTES) return { ok: false, failure: { kind: "total-size" } };

    const segments = verdict.segments;
    const key = collisionKey(segments);

    const previous = claimed.get(key);
    if (previous !== undefined) {
      return { ok: false, failure: { kind: "duplicate", name: entry.name, conflictsWith: previous } };
    }
    // This file's own path may not pass THROUGH a name another entry claimed as
    // a file: `file/child` after `file`.
    for (let i = 1; i < segments.length; i += 1) {
      const prefix = collisionKey(segments.slice(0, i));
      const owner = claimed.get(prefix);
      if (owner !== undefined) {
        return { ok: false, failure: { kind: "file-vs-parent", name: entry.name, conflictsWith: owner } };
      }
      if (!directories.has(prefix)) directories.set(prefix, entry.name);
    }
    // ...and this file may not claim a name an earlier entry already needs as a
    // directory: `file` after `file/child`. Both directions, or the refusal
    // would depend on manifest order.
    const needsDirectory = directories.get(key);
    if (needsDirectory !== undefined) {
      return { ok: false, failure: { kind: "file-vs-parent", name: entry.name, conflictsWith: needsDirectory } };
    }

    claimed.set(key, entry.name);
    files.push({ segments, size: entry.size });
  }

  return { ok: true, files, totalBytes };
}
