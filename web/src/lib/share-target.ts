// Client half of the Web Share Target flow. The service worker parks files
// shared into the installed PWA in a cache and redirects here with a token;
// we read them back into File objects. Android/Chromium only — iOS Safari has
// no inbound share target, where this simply finds no token and no-ops.
import { probeStreamSupport, streamDownloadsActive } from "./filesink";

const SHARE_CACHE = "relayium-share";

/** 检查等待中的 SW 能不能放行的间隔。只在真有一个 waiting 版本时才起表。 */
const ACTIVATE_RETRY_MS = 15_000;

/** Register the service worker. Production + secure context only; the offline
 *  shell and share target are best-effort, so failures are swallowed. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register("/sw.js").then(activateWhenIdle).catch(() => {});
  // 顺带把流式下载的就绪状态探出来。必须现在（异步）做完：canStreamToDisk 是
  // 同步的，pickSaveTarget 又必须整个跑在用户手势里，到那时已经来不及等 SW。
  probeStreamSupport();
}

/**
 * 放行等待中的新 SW —— 但只在没有流式下载在途的时候。
 *
 * sw-template.js 的 install 故意不再自作主张 skipWaiting：新 SW 一激活，旧 SW 连同
 * 它内存里的流式下载注册表一起消失，正在落盘的那次下载会在下一个 chunk 上永远等不到
 * ack（页面侧靠 STREAM_ACK_TIMEOUT_MS 兜成一个报错，但用户丢的是一次大文件下载）。
 * 换成由页面在空闲时放行：绝大多数情况下就是「装好即刻生效」，只有正在下载时才推迟。
 *
 * 推迟只用一个轮询而不是订阅下载结束事件：这条路径不值得为它建一套通知机制，
 * 而且轮询还顺带覆盖了「下载在别的标签页里」这种页面根本收不到事件的情形。
 */
export function activateWhenIdle(reg: ServiceWorkerRegistration): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => { if (timer) { clearInterval(timer); timer = undefined; } };
  const tryActivate = () => {
    const waiting = reg.waiting;
    if (!waiting) return; // 没有待激活的版本，什么都不用做
    if (streamDownloadsActive()) { timer ??= setInterval(tryActivate, ACTIVATE_RETRY_MS); return; }
    stop();
    waiting.postMessage({ type: "skip-waiting" });
  };
  reg.addEventListener("updatefound", () => {
    const installing = reg.installing;
    installing?.addEventListener("statechange", () => {
      if (installing.state === "installed") tryActivate();
    });
  });
  // 上一次访问留下的 waiting 版本（当时正在下载，或标签页被关掉了）。
  tryActivate();
  navigator.serviceWorker.addEventListener("controllerchange", stop);
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
