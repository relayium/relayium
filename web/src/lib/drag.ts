// web/src/lib/drag.ts
// Pure logic for window-wide drag-to-send. Kept DOM-free so it is unit-testable.

/** Whether a drag carries files (vs. dragging a page element or selected text).
 *  `types` may be a DOMStringList (real DataTransfer) or a string[] (tests); both
 *  are indexable, so we iterate by index. */
export function hasFiles(
  types: readonly string[] | DOMStringList | undefined,
): boolean {
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === "Files") return true;
  }
  return false;
}

/** Decide what a window-level file drop should do.
 *  - "off":  inactive (a transfer is in progress, or there is no peer) — let the
 *            page's own drop handling (e.g. the stored-upload card) take over.
 *  - "send": exactly one peer — dropping anywhere sends to it.
 *  - "pick": multiple peers — the user must drop onto a specific device card. */
export function dropTarget(
  peerCount: number,
  busy: boolean,
): "off" | "send" | "pick" {
  if (busy || peerCount <= 0) return "off";
  return peerCount === 1 ? "send" : "pick";
}
