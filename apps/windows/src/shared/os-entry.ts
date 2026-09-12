// What an OS-delivered selection may tell a renderer.
//
// Windows hands this app file PATHS — through an Explorer verb, a Send-to
// shortcut, Open With, or a drop on the executable — and they arrive in `argv`,
// which is main's. None of them crosses to a page.
//
// What crosses is a CAPABILITY: an opaque token per file, plus the display
// facts a person needs to recognise what they are about to send. A token is
// only meaningful to the process that minted it, is bound to one document, and
// authorises exactly one thing — a bounded range read of the file it was minted
// for. There is no channel here that takes a path.
//
// ## Staged, never sent
//
// An OS entry stages a selection and stops. Sending is a thing a person does
// after seeing what was selected; an activation that transmitted files on its
// own would make "open with" a send button.

/** One logical chunk. `STORE_CHUNK_SIZE`/`CHUNK_SIZE` in `web/src/lib`. */
export const MAX_SELECTION_CHUNK = 192 * 1024;

/** How many files one activation may stage. Refused, never truncated. */
export const MAX_SELECTION_FILES = 5_000;

/** How deep a folder walk goes before it refuses. */
export const MAX_SELECTION_DEPTH = 32;

/** How many paths one `--send-files` run may name, before any walk. */
export const MAX_SELECTION_ROOTS = 256;

/** The longest relative path this build will carry. */
export const MAX_RELATIVE_PATH = 1024;

/**
 * The argument that introduces an OS selection.
 *
 * An explicit grammar, and the ONLY one: `--send-files` followed by one or more
 * paths, terminated by the end of `argv` or by the next `--` argument. A bare
 * path in `argv` is NOT a selection — treating unrecognised arguments as files
 * would make every future flag, and every stray token a shell expanded, into a
 * file this app tried to open.
 */
export const SEND_FILES_FLAG = "--send-files";

/** Why an activation staged nothing, or staged less than it was given. */
export type SelectionRefusal =
  /** Not a `--send-files` activation at all. */
  | "no-selection"
  /** More roots, files or depth than this build will take. Nothing staged. */
  | "too-many"
  /** A path that is not a regular file or an ordinary directory. */
  | "unsupported-kind"
  /** A symlink, reparse point, or a walk that left its root. */
  | "escapes-root"
  /** Two entries would occupy the same relative path. */
  | "collision"
  /** The path could not be examined at all. */
  | "unreadable"
  /** A quit is being decided, the page reloaded, or the account moved. */
  | "unavailable";
// There is deliberately no member for "something is already staged". That
// refusal is real, but it is not reported as a refusal REASON: the staged view
// stays on screen and counts the turned-away activations in `refusedSince`, so
// the page can say how many and what to do about them. See `#refusedSince` in
// `src/main/features/os-entry.ts`. A member declared here and produced nowhere
// is a decoy — this one existed until an exhaustiveness check found it.

/**
 * One staged file, as a page may see it.
 *
 * `relativePath` is what a folder send needs in order to arrive as a folder,
 * and it is always relative — it is built from the walk, never from the
 * absolute path it came from. `name` is its last segment.
 */
export interface SelectionEntryView {
  /** Opaque, single-document, read-only capability. Not a path. */
  readonly token: string;
  readonly name: string;
  /** Forward-slashed, relative to the selected root. Never absolute. */
  readonly relativePath: string;
  readonly size: number;
}

/**
 * A staged selection.
 *
 * `rootNames` are the display names of what the user actually picked — a file
 * name or a folder name — so a page can say "3 files from Photos" without ever
 * being told where Photos is.
 */
export interface SelectionView {
  readonly kind: "staged";
  /** Changes on every activation. Ties a page's state to one selection. */
  readonly selectionId: string;
  readonly entries: readonly SelectionEntryView[];
  readonly rootNames: readonly string[];
  readonly totalBytes: number;
  readonly stagedAt: number;
  /**
   * Activations refused while this selection was held.
   *
   * Surfaced so the refusal is visible rather than merely logged: a person who
   * invoked Send-to three times needs to know two of them did nothing.
   */
  readonly refusedSince: number;
}

export interface SelectionEmptyView {
  readonly kind: "empty";
  readonly selectionId: string;
  /** Why the last activation staged nothing, when one happened. */
  readonly refusal: SelectionRefusal | null;
}

export type OsEntryView = SelectionView | SelectionEmptyView;

/**
 * What a bounded read answered.
 *
 * `bytes` is at most `MAX_SELECTION_CHUNK`, and short only at end of file — a
 * short read anywhere else is reported as a failure rather than passed off as
 * the end of the data, because silently truncating a file is how a send arrives
 * corrupt and calls itself complete.
 */
export type SelectionReadResult =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  /** The token is not registered, or belongs to another document. */
  | { readonly kind: "unknown-token" }
  /** The file changed identity, vanished, or stopped being a regular file. */
  | { readonly kind: "changed" }
  /** Out of range, over the chunk ceiling, or negative. */
  | { readonly kind: "bad-range" }
  /** Read refused: quit fence, dispose, or too many reads at once. */
  | { readonly kind: "unavailable" }
  /** The read was attempted and failed. */
  | { readonly kind: "failed" };

export const OS_ENTRY_EMPTY: OsEntryView = Object.freeze({
  kind: "empty",
  selectionId: "",
  refusal: null,
});

/** Whether a range is one this build will even attempt. */
export function isReadableRange(offset: number, length: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0) return false;
  if (!Number.isSafeInteger(length) || length <= 0) return false;
  return length <= MAX_SELECTION_CHUNK;
}
