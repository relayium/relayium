// Turning what the user picked into what one upload will send — or refusing it.
//
// ## The same gate as a receive, deliberately
//
// The manifest a send composes is the manifest a receive will judge, so this
// module runs the plan through `../manifest.ts`'s `planStoredManifest`: the
// same Windows path semantics, the same case-collision and file-versus-parent
// rules, the same count and safe-integer bounds, the same folder preservation.
// A Windows client that uploaded a manifest its own receive path would refuse
// would be shipping a transfer that only other platforms can open.
//
// ## Two bounds the receive side does not have
//
//   * **The sealed manifest must fit `POST /api/uploads`.**
//     `server/account/files.go:26` sets `maxManifestBytes = 64 KiB` and reads
//     the length prefix before anything else, so an oversized manifest is a
//     400 with no session opened. That is much tighter than the native
//     helper's 1 MiB aggregate-name budget, so it is checked HERE, against the
//     actual sealed bytes rather than an estimate.
//   * **The frame schedule.** The producer of ciphertext lives in another
//     process; this module derives, from sizes alone, exactly how many frames
//     each file owes and how long each one must be. That is what lets the
//     engine refuse an overrun, an underrun or a mislabelled frame instead of
//     discovering the disagreement as a corrupted object at the far end.

import { planStoredManifest, type CipherGeometry, type ManifestRefusal } from "../manifest.js";

/** `server/account/files.go`'s `maxManifestBytes`. */
export const SEALED_MANIFEST_MAX_BYTES = 64 * 1024;

/** One entry the user picked, in the order the producer will encrypt them. */
export interface UploadDescriptor {
  /** Relative path with `/` separators — `webkitRelativePath` or the leaf name. */
  readonly path: string;
  readonly size: number;
}

export type UploadRefusal =
  | { readonly kind: "manifest"; readonly refusal: ManifestRefusal }
  /** The sealed manifest is larger than init will accept. */
  | { readonly kind: "manifest-too-large-to-send"; readonly bytes: number };

/**
 * What one file owes the wire, as GEOMETRY rather than as a list.
 *
 * The first version materialised one number per frame. A descriptor is a size,
 * and `planStoredManifest` bounds only the totals (at `MAX_SAFE_INTEGER`), so a
 * single valid entry of 2**50 bytes made this allocate billions of numbers
 * synchronously — before the server had been asked anything, before a quota,
 * before init. Even a legitimately large file paid proportional metadata for
 * nothing. Root caught it.
 *
 * Every frame of a file is `storeChunkSize` of plaintext except possibly the
 * last, so four numbers describe all of them and any one length is O(1). No
 * file-size cap was added to fix this: a cap would narrow parity with the
 * macOS client, and the problem was never the size — it was materialising it.
 */
export interface FileFrames {
  readonly index: number;
  /** Frames carrying a FULL plaintext chunk. */
  readonly fullFrames: number;
  /** The ciphertext length of a full frame, or 0 when there are none. */
  readonly fullBytes: number;
  /** The ciphertext length of the final short frame, or 0 when there is none. */
  readonly tailBytes: number;
  /** `fullFrames + (tailBytes > 0 ? 1 : 0)`. Zero for a zero-byte file. */
  readonly frameCount: number;
}

export interface UploadPlan {
  /** Validated, canonical names and declared sizes, in producer order. */
  readonly manifest: readonly { readonly name: string; readonly size: number }[];
  readonly totalPlaintextBytes: number;
  /** Exact ciphertext length. This is `?size=` and the finalize expectation. */
  readonly cipherBytes: number;
  /** Per-file frame GEOMETRY. A zero-byte file owes NO frames. */
  readonly frames: readonly FileFrames[];
  /** Total frames across the object — the last global sequence number. */
  readonly frameCount: number;
}

export type UploadPlanResult =
  | { readonly ok: true; readonly plan: UploadPlan }
  | { readonly ok: false; readonly refusal: UploadRefusal };

/**
 * The frame geometry one file produces. O(1), whatever the size.
 *
 * `encryptFiles` slices at `storeChunkSize` and does not pad the last slice, so
 * a file is `floor(size/chunk)` full frames plus a remainder frame when
 * `size % chunk` is non-zero. A ZERO-byte file produces none at all — its loop
 * never runs — which is the fact every empty-file bug in this product comes
 * from, and the reason it is stated as data here rather than rediscovered.
 */
export function frameGeometry(size: number, geometry: CipherGeometry, index = 0): FileFrames {
  const fullFrames = Math.floor(size / geometry.storeChunkSize);
  const remainder = size % geometry.storeChunkSize;
  const tailBytes = remainder > 0 ? remainder + geometry.frameOverhead : 0;
  return {
    index,
    fullFrames,
    fullBytes: fullFrames > 0 ? geometry.storeChunkSize + geometry.frameOverhead : 0,
    tailBytes,
    frameCount: fullFrames + (tailBytes > 0 ? 1 : 0),
  };
}

/**
 * The ciphertext length of one frame, by position within its file.
 *
 * The only accessor the engine needs, and the reason the geometry above is
 * enough: `expects` and the per-frame check are both O(1) rather than an index
 * into a list that had to exist.
 */
export function frameLengthAt(file: FileFrames, frameInFile: number): number | null {
  if (frameInFile < 0 || frameInFile >= file.frameCount) return null;
  return frameInFile < file.fullFrames ? file.fullBytes : file.tailBytes;
}

/**
 * Validate an ordered descriptor list and derive the whole send schedule.
 *
 * ORDER IS PART OF THE PLAN. The ciphertext carries no per-file delimiter — a
 * receiver splits one frame sequence by the manifest's declared sizes — so the
 * array the producer encrypts must be the array this manifest was composed
 * from. If it is re-sorted in between, every file lands under another file's
 * name and no AEAD check anywhere notices whenever the sizes happen to line
 * up. The engine therefore requires each frame to name its file INDEX, and the
 * host contract requires the producer to hold the same frozen array.
 */
export function planUpload(
  descriptors: readonly UploadDescriptor[],
  geometry: CipherGeometry,
): UploadPlanResult {
  const planned = planStoredManifest(
    { files: descriptors.map((entry) => ({ name: entry.path, size: entry.size })) },
    geometry,
  );
  if (!planned.ok) return { ok: false, refusal: { kind: "manifest", refusal: planned.refusal } };

  // O(file count), not O(frame count): one small record per FILE, whatever the
  // sizes are.
  const frames = planned.plan.manifest.map((entry, index) =>
    frameGeometry(entry.size, geometry, index),
  );
  return {
    ok: true,
    plan: {
      manifest: planned.plan.manifest,
      totalPlaintextBytes: planned.plan.totalBytes,
      cipherBytes: planned.plan.cipherBytes,
      frames,
      frameCount: frames.reduce((n, file) => n + file.frameCount, 0),
    },
  };
}

/**
 * Refuse a sealed manifest init would reject.
 *
 * Checked on the ACTUAL sealed length: the plaintext JSON's size is not a
 * proxy, because the seal adds a tag and the count that matters is the one the
 * server reads out of the length prefix.
 */
export function sealedManifestFits(sealed: Uint8Array): UploadRefusal | null {
  return sealed.byteLength > SEALED_MANIFEST_MAX_BYTES
    ? { kind: "manifest-too-large-to-send", bytes: sealed.byteLength }
    : null;
}
