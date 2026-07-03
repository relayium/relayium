// Best-effort completion notifications. Every function is a safe no-op when the
// Notification API is missing or permission isn't granted, so callers needn't guard.

/** Pure gate: only notify when the user is looking elsewhere and has granted
 *  permission. Extracted so the decision is unit-testable without the API. */
export function shouldNotify(
  visibility: DocumentVisibilityState,
  permission: NotificationPermission,
): boolean {
  return visibility !== "visible" && permission === "granted";
}

/** Ask for permission once, if the user hasn't decided. Best called from a user
 *  gesture (a transfer start) so browsers that require one still show the prompt.
 *  A no-op after the first decision. */
export function requestNotifyPermission(): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => { /* dismissed / unsupported */ });
  }
}

/** Show a transfer-completion notification, but only while the tab is hidden.
 *  Prefers the service-worker registration (required on Android) and falls back
 *  to the Notification constructor; any failure is swallowed. */
export async function notifyTransfer(body: string): Promise<void> {
  if (typeof Notification === "undefined" || typeof document === "undefined") return;
  if (!shouldNotify(document.visibilityState, Notification.permission)) return;
  const opts: NotificationOptions = { body, tag: "relayium-transfer", icon: "/icon-192.png" };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg && "showNotification" in reg) { await reg.showNotification("Relayium", opts); return; }
    const n = new Notification("Relayium", opts);
    n.onclick = () => { try { window.focus(); } catch { /* ignore */ } n.close(); };
  } catch { /* constructor unsupported on some mobile browsers — skip silently */ }
}
