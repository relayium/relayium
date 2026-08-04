// "Is this the page the user is looking at?" — the signal that decides which of
// one browser's tabs a nearby device's request should reach.
//
// Initial state requires both visibility and focus. Visibility distinguishes
// tabs; focus distinguishes two side-by-side browser windows. Losing focus does
// not send an "inactive" frame — the server keeps the last representative — so
// switching to another app never makes the device unreachable. A later focus is
// only a positive handover signal.

interface CurrentPageTarget {
  readonly visibilityState: string;
  hasFocus?(): boolean;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

/** Whether this page is the current one. */
export function isCurrentPage(doc: CurrentPageTarget = document): boolean {
  return doc.visibilityState === "visible" && (doc.hasFocus?.() ?? true);
}

/**
 * Call `onBecomeCurrent` when this page becomes the current one — on a genuine
 * transition only.
 *
 * The edge matters: each announcement is a signaling frame charged to this
 * connection's per-connection budget on the server, and focus/visibility events
 * arrive in bursts. Nothing fires on start, because the join frame already
 * carries the page's state.
 */
export function watchCurrentPage(
  onBecomeCurrent: () => void,
  doc: CurrentPageTarget = document,
  win: Pick<CurrentPageTarget, "addEventListener" | "removeEventListener"> = window,
): () => void {
  let announced = isCurrentPage(doc);
  const check = () => {
    if (!isCurrentPage(doc)) {
      announced = false;
      return;
    }
    if (announced) return;
    announced = true;
    onBecomeCurrent();
  };
  // A blur is not "no longer current" (see above) — it only re-arms the edge, so
  // the focus that follows it announces the handover between two visible pages.
  const onBlur = () => { announced = false; };
  doc.addEventListener("visibilitychange", check);
  win.addEventListener("focus", check);
  win.addEventListener("blur", onBlur);
  return () => {
    doc.removeEventListener("visibilitychange", check);
    win.removeEventListener("focus", check);
    win.removeEventListener("blur", onBlur);
  };
}
