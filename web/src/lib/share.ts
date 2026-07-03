// Thin wrapper over the Web Share API. Progressive enhancement: canShare() gates
// the button so it only appears where the OS share sheet is available (mostly
// mobile); everywhere else the copy button and QR remain the path.

export function canShare(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

/** Open the OS share sheet for a link. No-op when unsupported; a user-cancelled
 *  share (AbortError) or any failure is swallowed so the copy button still works. */
export async function share(data: ShareData): Promise<void> {
  if (!canShare()) return;
  try {
    await navigator.share(data);
  } catch {
    /* dismissed or unsupported target — the copyable link is still on screen */
  }
}
