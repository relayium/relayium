// Judging a stored object's manifest before anything is opened.
//
// ## Why the whole manifest is judged first, and before the folder picker
//
// `src/main/io/plan.ts` already explains why a per-file check is not enough: a
// validator that runs as each file arrives has already created files by the time
// it meets the one it must refuse. This module adds the two reasons that are
// specific to a stored receive:
//
//   * The refusal must precede the DESTINATION. Asking the user to choose a
//     folder for a manifest this build is going to refuse spends their attention
//     on a dialog whose answer cannot matter.
//   * The refusal must precede the HELPER. `native/internal/nameguard` refuses
//     the same manifests, and correctly — but at a protocol boundary, where the
//     only thing that can be reported is a code. Refusing here is what lets the
//     user be told which shape of manifest was rejected.
//
// ## The two bounds that are the helper's and not the planner's
//
// `native/README.md` is explicit that the native manifest bounds are STRICTER
// than `plan.ts`'s — 1 MiB aggregate name bytes and 4096 distinct directories,
// neither of which exists in the TypeScript planner — and that main should
// pre-check them so the user sees a better message than a boundary refusal.
// They are resources the helper actually holds: names are the bulk of the `open`
// frame, and directory handles are pinned for the whole of publication. So they
// are restated here, next to the planner, rather than discovered at `open`.

import type { NativeManifestEntry } from "../io/native-helper-client.js";
import { planManifest, type PlanFailure } from "../io/plan.js";
import type { PathRejection } from "../io/winpath.js";
import type { RuntimeStoredManifest } from "./runtime-contract.js";

/** `nameguard.MaxManifestNameBytes`. */
export const MAX_MANIFEST_NAME_BYTES = 1 << 20;
/** `nameguard.MaxDistinctDirectories`. */
export const MAX_DISTINCT_DIRECTORIES = 4096;

/**
 * Why a manifest was refused.
 *
 * Names are deliberately ABSENT. This value is reported to the UI and may be
 * logged, and a filename is the sender's content: `plan.ts` carries the
 * offending name for a local message, and it stops here. The kind and the path
 * reason are what a user needs ("this transfer contains a name Windows cannot
 * create") and all a bug report needs.
 */
export type ManifestRefusal =
  | { readonly kind: "path"; readonly reason: PathRejection }
  | { readonly kind: "duplicate" }
  | { readonly kind: "file-vs-parent" }
  | { readonly kind: "size" }
  | { readonly kind: "count" }
  | { readonly kind: "total-size" }
  | { readonly kind: "manifest-too-large" }
  | { readonly kind: "too-many-directories" };

export interface StoredWritePlan {
  /** What the helper's `open` request carries: validated names, declared sizes. */
  readonly manifest: readonly NativeManifestEntry[];
  /** Total plaintext bytes — what `end(expected)` will be checked against. */
  readonly totalBytes: number;
  /**
   * Exact ciphertext length this object must have.
   *
   * Derived from the AUTHENTICATED manifest, never from the server's `size`
   * field, and used as the hard ceiling on the blob body. Each file is chunked
   * independently at `storeChunkSize`, the last chunk is not padded, and there
   * is no separator frame between files — so the total is exact rather than an
   * estimate. A zero-byte file contributes no frame at all.
   */
  readonly cipherBytes: number;
}

export type StoredManifestPlan =
  | { readonly ok: true; readonly plan: StoredWritePlan }
  | { readonly ok: false; readonly refusal: ManifestRefusal };

const utf8 = new TextEncoder();

/** Drop the name from a planner failure, keeping the diagnosis. */
function stripName(failure: PlanFailure): ManifestRefusal {
  switch (failure.kind) {
    case "path":
      return { kind: "path", reason: failure.reason };
    case "duplicate":
      return { kind: "duplicate" };
    case "file-vs-parent":
      return { kind: "file-vs-parent" };
    case "size":
      return { kind: "size" };
    case "count":
      return { kind: "count" };
    case "total-size":
      return { kind: "total-size" };
  }
}

export interface CipherGeometry {
  readonly storeChunkSize: number;
  readonly frameOverhead: number;
}

/**
 * Validate a decrypted manifest and produce the write plan, or the refusal.
 *
 * Deterministic in the manifest's own order, so the same manifest always names
 * the same offending entry and a refusal is reproducible from a bug report.
 */
export function planStoredManifest(
  manifest: RuntimeStoredManifest,
  geometry: CipherGeometry,
): StoredManifestPlan {
  // An empty manifest is refused HERE as well as by the shared validator that
  // produced this object. Publishing "0 of 0 files saved" from an object that
  // decrypted successfully is a report nobody can act on, and this module must
  // not depend on an upstream check to prevent it.
  if (manifest.files.length === 0) return { ok: false, refusal: { kind: "count" } };

  const planned = planManifest(manifest.files.map((file) => ({ name: file.name, size: file.size })));
  if (!planned.ok) return { ok: false, refusal: stripName(planned.failure) };

  let nameBytes = 0;
  const directories = new Set<string>();
  const entries: NativeManifestEntry[] = [];
  let cipherBytes = 0;

  for (const file of planned.files) {
    // The VALIDATED segments, rejoined — not the raw manifest string. What the
    // helper is asked to create is exactly what was judged here.
    const name = file.segments.join("/");
    nameBytes += utf8.encode(name).length;
    if (nameBytes > MAX_MANIFEST_NAME_BYTES) {
      return { ok: false, refusal: { kind: "manifest-too-large" } };
    }
    for (let i = 1; i < file.segments.length; i += 1) {
      // Case-folded, matching `winpath.collisionKey`: `A/x` and `a/y` need ONE
      // directory on NTFS, and counting two would refuse a manifest the helper
      // would accept.
      directories.add(file.segments.slice(0, i).map((part) => part.toLocaleUpperCase("en-US")).join("/"));
    }
    if (directories.size > MAX_DISTINCT_DIRECTORIES) {
      return { ok: false, refusal: { kind: "too-many-directories" } };
    }
    entries.push({ name, size: file.size });
    cipherBytes +=
      file.size + geometry.frameOverhead * Math.ceil(file.size / geometry.storeChunkSize);
  }

  // The ciphertext total is a bound this process will allocate against, so it
  // has to be arithmetic and not an approximation. `plan.ts` already refused a
  // plaintext total past MAX_SAFE_INTEGER; frame overhead can push a manifest
  // just under it past, and a ceiling that is not a safe integer bounds nothing.
  if (!Number.isSafeInteger(cipherBytes)) return { ok: false, refusal: { kind: "total-size" } };

  return { ok: true, plan: { manifest: entries, totalBytes: planned.totalBytes, cipherBytes } };
}

/**
 * The sealed manifest bytes from the metadata document's base64.
 *
 * STRICT, because `Buffer.from(s, "base64")` is not: it silently ignores
 * characters outside the alphabet, so `"!!!!"` decodes to an empty buffer and a
 * corrupted field would arrive as "this object has no manifest" rather than as
 * a refusal. The alphabet, the padding and the length are all checked first,
 * and the decode is verified to have consumed the whole string.
 *
 * Standard base64 with padding — what `server/account` emits and what
 * `web/src/lib/stored-file.ts` feeds to `atob`. Not the URL-safe variant the
 * link fragment uses.
 *
 * Returns null rather than throwing: its caller reports a malformed metadata
 * document, and an exception carrying the offending string is exactly what must
 * not happen to a field this size.
 */
export function sealedManifestBytes(encoded: string): Uint8Array | null {
  if (encoded.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const expected = (encoded.length / 4) * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength !== expected) return null;
  // A sealed frame is at least its 16-byte GCM tag plus one byte of plaintext,
  // and no manifest document is one byte. A shorter value cannot be frame 0.
  if (bytes.byteLength <= 16) return null;
  return new Uint8Array(bytes);
}
