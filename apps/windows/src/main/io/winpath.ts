// Windows destination-path safety for received transfers.
//
// ## Why this is not `web/src/lib/zip.ts`'s `safeSegments`
//
// That function DROPS unsafe segments and keeps going, because a ZIP a browser
// hands the user is a best-effort container: a mangled member is still a
// download. This file answers a different question — "may I create this exact
// file inside the folder the user chose?" — and the only safe answer to a name
// it cannot honour is *no*. Silently rewriting `..\..\evil` into `evil` writes
// a file the sender did not name and the receiver did not agree to; silently
// dropping it reports success for bytes nobody has. Both are the failure this
// module exists to prevent, so every rejection below is a refusal.
//
// ## Why the checks are structural, not a blocklist of examples
//
// Windows resolves a path through several layers (Win32 normalisation, the
// device namespace, alternate data streams) before the filesystem sees it, and
// each layer can turn a string that *looks* relative into one that is not. So a
// segment is admitted only when it is positively ordinary: no separator, no
// drive, no colon, no reserved device name, no trailing dot or space, no
// control character. Anything else is refused with a reason.
//
// Source: Microsoft, "Naming Files, Paths, and Namespaces"
// https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file

/** Why a path was refused. Stable strings — the renderer maps them to copy. */
export type PathRejection =
  | "empty"
  | "absolute"
  | "drive-relative"
  | "unc-or-device"
  | "traversal"
  | "backslash-in-segment"
  | "separator-in-segment"
  | "reserved-device-name"
  | "alternate-data-stream"
  | "invalid-character"
  | "deceptive-character"
  | "trailing-dot-or-space"
  | "segment-too-long"
  | "too-deep"
  | "path-too-long";

export interface PathVerdict {
  readonly ok: boolean;
  readonly reason?: PathRejection;
  /** The validated segments, only when `ok`. Never derived from a rejected input. */
  readonly segments?: readonly string[];
}

/**
 * Reserved DOS device names.
 *
 * The superscript forms are real and are the ones a blocklist typically misses:
 * Microsoft's page lists `COM¹ COM² COM³` and `LPT¹ LPT² LPT³` alongside the
 * ASCII digits, because Win32 maps them to the same devices.
 *
 * A name is reserved when the part BEFORE the first dot matches: `NUL.txt` is
 * the NUL device, not a text file.
 */
const RESERVED = new Set<string>([
  "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
  ...Array.from({ length: 10 }, (_, i) => `COM${i}`),
  ...Array.from({ length: 10 }, (_, i) => `LPT${i}`),
  "COM\u00B9", "COM\u00B2", "COM\u00B3",
  "LPT\u00B9", "LPT\u00B2", "LPT\u00B3",
]);

/** `< > : " | ? *` plus every C0 control, including NUL and newline. */
const INVALID_CHAR = /[<>:"|?*\u0000-\u001F]/;

/**
 * Characters that change how a name READS without changing what it is.
 *
 * DEL, and the bidi overrides and isolates. `photo\u202Egnp.exe` renders in
 * Explorer as `photoexe.png`, because U+202E reverses everything after it — the
 * reader double-clicks an executable believing it is an image, and on Windows
 * the extension is what decides that.
 *
 * Its own class rather than an addition to `INVALID_CHAR`, and its own reason,
 * because the two are different facts: those characters cannot be written at
 * all, these can be written perfectly and are still refused.
 *
 * REFUSED, never stripped — this receiver does not rewrite a name into a
 * different one. macOS strips them on its side; the outcome that matters is the
 * same, which is that the name never reaches disk.
 *
 * Byte-identical to the class in `web/src/lib/filename.ts` and to `isDeceptive`
 * in `native/internal/nameguard/nameguard.go`. C1 (U+0080-U+009F) is
 * deliberately absent: no other implementation refuses it, and a name only some
 * of a user's devices accept is the failure the shared manifest rule exists to
 * prevent.
 */
const DECEPTIVE_CHAR = /[\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

/**
 * Bounds. TWO limits apply to a component and neither implies the other.
 *
 * `MAX_SEGMENT_UTF16` is the filesystem's: NTFS counts a filename in UTF-16
 * code units and stops at 255, so a 256-character ASCII name is unwritable no
 * matter what the wire permits. `MAX_SEGMENT_BYTES` is the Device Inbox
 * manifest's declared ceiling in UTF-8 bytes, kept so one wire cannot mint a
 * name the other refuses.
 *
 * The UTF-8 ceiling does NOT subsume the UTF-16 one: 256 ASCII characters are
 * 256 bytes, comfortably under 1024, and still one over what NTFS will create.
 * A multibyte name fails the other way — 400 CJK characters are 1200 bytes and
 * 400 units, over both. Checking only one leaves a real name unrefused.
 */
export const MAX_SEGMENT_UTF16 = 255;
export const MAX_SEGMENT_BYTES = 1024;
export const MAX_DEPTH = 64;
export const MAX_RELATIVE_CHARS = 32_000;

const utf8 = new TextEncoder();
const reject = (reason: PathRejection): PathVerdict => ({ ok: false, reason });

/**
 * Validate one manifest-supplied relative path.
 *
 * Accepts `/` as the separator (what both wires use). A literal backslash is
 * refused rather than treated as a separator: on Windows it IS one, so a sender
 * that means a directory must say so in the wire's own vocabulary, and one that
 * did not mean a directory must not accidentally create one.
 */
export function validateRelativePath(raw: string): PathVerdict {
  if (typeof raw !== "string" || raw.length === 0) return reject("empty");
  if (raw.length > MAX_RELATIVE_CHARS) return reject("path-too-long");

  // Device and UNC namespaces first: `\\?\`, `\\.\`, `\\server\share`. They
  // bypass Win32 normalisation entirely, so no per-segment check would see them.
  if (/^[\\/]{2}/.test(raw)) return reject("unc-or-device");
  if (/^[\\/]/.test(raw)) return reject("absolute");
  if (/^[A-Za-z]:[\\/]/.test(raw)) return reject("absolute");
  // `C:name` resolves against that drive's *current* directory — process state
  // the sender does not know and must not reach. Distinct reason: it is not the
  // same mistake as `C:\name`.
  if (/^[A-Za-z]:/.test(raw)) return reject("drive-relative");

  const segments = raw.split("/");
  if (segments.length > MAX_DEPTH) return reject("too-deep");

  for (const segment of segments) {
    const verdict = validateSegment(segment);
    if (!verdict.ok) return verdict;
  }
  return { ok: true, segments };
}

/** Validate a single path component. Exported for the manifest planner. */
export function validateSegment(segment: string): PathVerdict {
  if (segment.length === 0) return reject("empty");
  if (segment === "." || segment === "..") return reject("traversal");
  // A component is ONE component. `validateRelativePath` splits on `/` before
  // it gets here, so this only fires for a direct caller — but this function is
  // exported, and a validator that answers "fine" for `a/b` would let a caller
  // that skipped the splitter create a directory nobody declared.
  if (segment.includes("/")) return reject("separator-in-segment");
  // A backslash inside a component is a separator Windows would honour, so the
  // component is a directory the sender never declared — and `a\..\escape` is a
  // traversal that survives every `/`-based check.
  if (segment.includes("\\")) return reject("backslash-in-segment");
  // Colon is both the drive marker and the alternate-data-stream marker.
  // Reported precisely: `name:stream` writes a hidden stream of `name` that no
  // directory listing shows.
  if (segment.includes(":")) return reject("alternate-data-stream");
  if (INVALID_CHAR.test(segment)) return reject("invalid-character");
  if (DECEPTIVE_CHAR.test(segment)) return reject("deceptive-character");
  // Windows silently strips these at creation, so `report.txt ` and
  // `report.txt` become one file — a collision the manifest never declared.
  if (/[. ]$/.test(segment)) return reject("trailing-dot-or-space");
  // `String.length` IS the UTF-16 unit count, which is what NTFS counts.
  if (segment.length > MAX_SEGMENT_UTF16) return reject("segment-too-long");
  if (utf8.encode(segment).length > MAX_SEGMENT_BYTES) return reject("segment-too-long");

  const stem = segment.split(".")[0] ?? "";
  if (RESERVED.has(stem.toUpperCase())) return reject("reserved-device-name");

  return { ok: true, segments: [segment] };
}

/**
 * The comparison key for "would these two names be the same file on disk?"
 *
 * NTFS is case-insensitive by default, so `A.txt` and `a.txt` collide. Folding
 * happens once, here, so the collision check and the write path cannot disagree
 * about what a duplicate is.
 */
export const collisionKey = (segments: readonly string[]): string =>
  segments.map((s) => s.toLocaleUpperCase("en-US")).join("/");
