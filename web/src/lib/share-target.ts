// Client half of the Web Share Target flow. The service worker parks files
// shared into the installed PWA in a cache and redirects here with a token;
// we read them back into File objects. Android/Chromium only — iOS Safari has
// no inbound share target, where this simply finds no token and no-ops.
const SHARE_CACHE = "relayium-share";

/** Register the service worker. Production + secure context only; the offline
 *  shell and share target are best-effort, so failures are swallowed. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

/** If the current URL carries a share-target token, drain the SW-stashed files
 *  back into File objects, then clean up the cache entries and the URL param so
 *  a reload can't re-trigger. Returns [] when there's nothing to drain. */
export async function drainSharedFiles(): Promise<File[]> {
  const params = new URLSearchParams(location.search);
  const token = params.get("share-target");
  if (!token) return [];

  // Strip the param up front so a refresh doesn't reopen a spent share.
  params.delete("share-target");
  const qs = params.toString();
  history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);

  if (!("caches" in window)) return [];
  try {
    const cache = await caches.open(SHARE_CACHE);
    const base = "/__shared__/" + token + "/";
    const countRes = await cache.match(base + "count");
    const count = countRes ? parseInt(await countRes.text(), 10) : 0;

    const files: File[] = [];
    for (let i = 0; i < count; i++) {
      const res = await cache.match(base + i);
      if (!res) continue;
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get("x-name") || `shared-${i}`);
      files.push(new File([blob], name, { type: res.headers.get("content-type") || blob.type }));
    }

    // Best-effort cleanup: this token's entries are one-shot.
    await cache.delete(base + "count");
    for (let i = 0; i < count; i++) await cache.delete(base + i);
    return files;
  } catch {
    return [];
  }
}
