// What a received file may be dragged or revealed by.
//
// A closed token per item. The renderer never learns where a file is, and there
// is no channel that takes a path and drags or reveals it.
//
// ## Two actions today, three in the parity target
//
// macOS offers drag, reveal and SHARE (`ReceivedResultView.swift:53`). This
// contract carries the first two.
//
// Share is absent because it needs a native bridge that does not exist yet —
// NOT because Windows cannot do it. Share SOURCE via
// `IDataTransferManagerInterop::GetForWindow` / `ShowShareUIForWindow` is
// supported for unpackaged desktop apps; only share TARGET needs a package
// manifest. When that bridge lands, `share` joins `ReceivedAction` and the
// copy gains one string. Until then this contract is INCOMPLETE against parity,
// which is a different statement from being at its limit.

/**
 * What a received item can do today. Closed; neither carries a path.
 *
 * `share` is the missing third — see the header. It is not represented here
 * because nothing can perform it yet, and a token for an action that always
 * fails would be worse than its absence.
 */
export type ReceivedAction = "drag" | "reveal";

export function isReceivedAction(value: unknown): value is ReceivedAction {
  return value === "drag" || value === "reveal";
}

/** One received item, as a page may see it. */
export interface ReceivedItemView {
  /** Opaque, single-document capability. Not a path. */
  readonly token: string;
  /** The last segment, for display. */
  readonly name: string;
  /** Relative to the receive root, forward-slashed. Never absolute. */
  readonly relativePath: string;
  readonly size: number;
}

/** How a drag or a reveal ended. */
export type ReceivedActionOutcome =
  | { readonly kind: "started" }
  | { readonly kind: "revealed" }
  /** Not registered, or registered to another document or account. */
  | { readonly kind: "unknown-token" }
  /** The file is gone, is no longer a regular file, or changed identity. */
  | { readonly kind: "missing" }
  /** A quit is being decided, or this process is going away. */
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed" };

/** How many received items one account/document may have registered at once. */
export const MAX_RECEIVED_ITEMS = 2_000;

/**
 * One path segment's worth of validation, as the accepted manifest defines it.
 *
 * `inbox-manifest.ts:223` refuses a component that IS `.` or `..`. A name that
 * merely contains two dots — `photo..jpg`, `archive..tar.gz` — is an ordinary
 * file, and a substring test refused those for no reason at all.
 */
export function isSafeRelativePath(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("/")) return false;
  // A drive-qualified path is not relative. Matches the manifest's byte-1 test.
  if (value.length >= 2 && value[1] === ":") return false;
  if (value.includes("\\")) return false;
  for (const segment of value.split("/")) {
    if (segment === "") return false;
    if (segment === "." || segment === "..") return false;
  }
  return true;
}
