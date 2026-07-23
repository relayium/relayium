import { describe, it, expect, vi, afterEach } from "vitest";
import { createWakeLock } from "./wakelock";

// A fake WakeLockSentinel + navigator.wakeLock. request() hands back a fresh
// sentinel each call and records the "release" listener so tests can simulate
// the platform auto-releasing on tab-hide.
function fakeWakeLock() {
  const sentinels: FakeSentinel[] = [];
  const request = vi.fn(async () => {
    const s = new FakeSentinel();
    sentinels.push(s);
    return s as unknown as WakeLockSentinel;
  });
  return { api: { request } as unknown as WakeLock, request, sentinels };
}

class FakeSentinel {
  released = false;
  onrelease: (() => void) | null = null;
  release = vi.fn(async () => { this.released = true; });
  addEventListener(_: string, cb: () => void) { this.onrelease = cb; }
}

function stub(api: WakeLock | undefined) {
  Object.defineProperty(navigator, "wakeLock", { value: api, configurable: true });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  // @ts-expect-error clean the stubbed property back off navigator
  delete navigator.wakeLock;
  vi.restoreAllMocks();
});

describe("createWakeLock", () => {
  it("requests a screen lock on acquire and is idempotent", async () => {
    const { api, request } = fakeWakeLock();
    stub(api);
    const wake = createWakeLock();

    wake.acquire();
    wake.acquire(); // second call must not fire a second request
    await tick();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("screen");
  });

  it("releases the held sentinel on release", async () => {
    const { api, sentinels } = fakeWakeLock();
    stub(api);
    const wake = createWakeLock();

    wake.acquire();
    await tick();
    wake.release();

    expect(sentinels[0].release).toHaveBeenCalled();
  });

  it("does nothing (and never throws) without navigator.wakeLock", async () => {
    stub(undefined);
    const wake = createWakeLock();
    expect(() => { wake.acquire(); wake.release(); }).not.toThrow();
    await tick();
  });

  it("re-requests when the tab becomes visible after a platform release", async () => {
    const { api, request, sentinels } = fakeWakeLock();
    stub(api);
    const wake = createWakeLock();

    wake.acquire();
    await tick();
    expect(request).toHaveBeenCalledTimes(1);

    // Platform auto-releases on tab-hide: fire the sentinel's release listener.
    sentinels[0].onrelease?.();
    // Tab comes back to the foreground.
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await tick();

    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("createWakeLock destroy", () => {
  it("摘掉 visibilitychange，销毁后不再重新请求锁", async () => {
    const { api, request } = fakeWakeLock();
    stub(api);
    const wl = createWakeLock();
    wl.acquire();
    await tick();
    expect(request).toHaveBeenCalledTimes(1);

    wl.destroy();
    document.dispatchEvent(new Event("visibilitychange"));
    await tick();
    expect(request).toHaveBeenCalledTimes(1); // 没有第二次
  });
});
