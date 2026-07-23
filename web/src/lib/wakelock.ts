/** A screen wake lock that survives the browser auto-releasing it when the tab
 *  is hidden. `acquire()`/`release()` are idempotent; on browsers without
 *  `navigator.wakeLock` (older Safari/Android) it silently does nothing. */
export interface WakeLockController {
  acquire(): void;
  release(): void;
  /** 摘掉 visibilitychange 监听。每个实例都会挂一个全局监听器，不摘就意味着
   *  每 new 一个 controller 就永久多一个——调用方销毁时必须调这个。 */
  destroy(): void;
}

export function createWakeLock(): WakeLockController {
  let wanted = false;
  let sentinel: WakeLockSentinel | null = null;
  let requesting = false;

  async function request() {
    if (!wanted || sentinel || requesting) return;
    const wl = navigator.wakeLock;
    if (!wl) return; // unsupported → no-op
    requesting = true;
    try {
      const s = await wl.request("screen");
      if (!wanted) {
        // Released while the request was in flight — don't hold a stale lock.
        s.release().catch(() => {});
        return;
      }
      sentinel = s;
      // The platform releases the sentinel on tab-hide; clear our handle so the
      // visibilitychange listener knows to re-request when we're visible again.
      s.addEventListener("release", () => { if (sentinel === s) sentinel = null; });
    } catch {
      // A policy/user-gesture rejection: stay `wanted` and retry on next visible.
    } finally {
      requesting = false;
    }
  }

  const onVisible = () => {
    if (document.visibilityState === "visible") request();
  };
  const hasDoc = typeof document !== "undefined";
  if (hasDoc) document.addEventListener("visibilitychange", onVisible);

  return {
    acquire() {
      if (wanted) return;
      wanted = true;
      request();
    },
    release() {
      wanted = false;
      const s = sentinel;
      sentinel = null;
      s?.release().catch(() => {});
    },
    destroy() {
      this.release();
      if (hasDoc) document.removeEventListener("visibilitychange", onVisible);
    },
  };
}
