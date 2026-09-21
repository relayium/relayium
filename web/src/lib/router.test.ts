import { describe, it, expect, vi, afterEach } from "vitest";
import {
  routeFromLocation as rfl, downloadId, CROSS_PATH, CLI_PATH, APPS_PATH, DEVICE_INBOX_PATH,
  VERIFY_EMAIL_PATH, RESET_PASSWORD_PATH, MAGIC_PATH, OFFLINE_PATH,
  navigate, currentRoute, setNavGuard, syncRouteFromLocation,
} from "./router.svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("routeFromLocation", () => {
  it("defaults to lan on root", () => {
    expect(rfl("/", "")).toBe("lan");
  });
  it("is cross on the cross-network path", () => {
    expect(rfl(CROSS_PATH, "")).toBe("cross");
  });
  it("ignores non-code hashes", () => {
    expect(rfl("/", "#other=1")).toBe("lan");
  });
  it("is cli on the /cli path", () => {
    expect(rfl(CLI_PATH, "")).toBe("cli");
  });
  it("a pairing code still wins over /cli", () => {
    expect(rfl("/cli", "#c=424242")).toBe("cross");
  });
});

describe("routeFromLocation email-verification pages", () => {
  it("is verify-email on the /verify-email path", () => {
    expect(rfl(VERIFY_EMAIL_PATH, "")).toBe("verify-email");
  });
  it("is reset-password on the /reset-password path", () => {
    expect(rfl(RESET_PASSWORD_PATH, "")).toBe("reset-password");
  });
  it("a pairing code still wins over either path", () => {
    expect(rfl(VERIFY_EMAIL_PATH, "#c=424242")).toBe("cross");
    expect(rfl(RESET_PASSWORD_PATH, "#c=424242")).toBe("cross");
  });
});

describe("routeFromLocation offline page", () => {
  it("maps /offline-transfer to the offline route", () => {
    expect(rfl("/offline-transfer", "")).toBe("offline");
  });
  it("a pairing code still wins over the offline path", () => {
    expect(rfl("/offline-transfer", "#c=424242")).toBe("cross");
  });
});

describe("routeFromLocation device-inbox page", () => {
  it("is device-inbox on the /device-inbox path", () => {
    expect(rfl(DEVICE_INBOX_PATH, "")).toBe("device-inbox");
  });
  it("a pairing code still wins over /device-inbox", () => {
    // A join link must land the recipient on the realtime page no matter which
    // route the URL otherwise names.
    expect(rfl(DEVICE_INBOX_PATH, "#c=424242")).toBe("cross");
  });
  it("does not swallow the guide URL that merely starts the same way", () => {
    // /guides/device-inbox-server/ is a static page, not this SPA route.
    expect(rfl("/guides/device-inbox-server/", "")).toBe("lan");
    expect(rfl("/device-inbox/", "")).toBe("lan");
  });
});

describe("routeFromLocation apps page", () => {
  it("is apps on the /apps path", () => {
    expect(rfl(APPS_PATH, "")).toBe("apps");
  });
  it("a pairing code still wins over /apps", () => {
    expect(rfl("/apps", "#c=424242")).toBe("cross");
  });
  it("does not collide with the /d/ download prefix", () => {
    expect(rfl("/apps", "")).toBe("apps");
    expect(rfl("/d/abc123", "")).toBe("download");
  });
});

describe("download route", () => {
  it("is download for /d/<id>", () => {
    expect(rfl("/d/abc123", "")).toBe("download");
  });
  it("extracts the id from the path", () => {
    expect(downloadId("/d/abc123")).toBe("abc123");
    expect(downloadId("/")).toBe("");
  });
  it("does not treat bare /d/ as a download route", () => {
    expect(rfl("/d/", "")).toBe("lan");
  });
  it("leaves normal routes unaffected", () => {
    expect(rfl("/", "")).toBe("lan");
    expect(rfl(CROSS_PATH, "")).toBe("cross");
  });
});

describe("routeFromLocation with a pairing code", () => {
  it("treats #c=<code> as the cross-network route", () => {
    expect(rfl("/", "#c=424242")).toBe("cross");
    expect(rfl("/cross-network", "#c=042424")).toBe("cross");
  });
  it("does not treat a malformed #c= as cross", () => {
    expect(rfl("/", "#c=123")).toBe("lan");
  });
});

describe("navigate", () => {
  afterEach(() => {
    // First, so a case that failed before its own mockRestore() cannot leave a
    // history spy behind for the reset below and for every case after it.
    vi.restoreAllMocks();
    setNavGuard(null);
    history.replaceState({}, "", "/");
    syncRouteFromLocation(); // reset route to "lan" between cases
  });

  it("switches route to the target tab", () => {
    navigate("cross");
    expect(currentRoute()).toBe("cross");
  });

  it("is a no-op when already on the target tab (does not consult the guard)", () => {
    navigate("cross");
    const guard = vi.fn(() => true);
    setNavGuard(guard);
    navigate("cross"); // already here
    expect(guard).not.toHaveBeenCalled();
    expect(currentRoute()).toBe("cross");
  });

  it("cancels navigation when the guard returns false", () => {
    // start on lan
    expect(currentRoute()).toBe("lan");
    setNavGuard(() => false);
    navigate("cross");
    expect(currentRoute()).toBe("lan");
  });

  it("proceeds when the guard returns true", () => {
    setNavGuard(() => true);
    navigate("cross");
    expect(currentRoute()).toBe("cross");
  });

  it("waits for a guard that answers with a promise, then navigates", async () => {
    // The in-app confirmation dialog cannot answer synchronously, and the whole
    // point of the guard is that nothing is torn down before the answer: a user
    // who is still reading "interrupt this transfer?" must still have the
    // transfer.
    let answer: (ok: boolean) => void = () => {};
    setNavGuard(() => new Promise<boolean>((r) => { answer = r; }));
    navigate("cross");
    expect(currentRoute()).toBe("lan"); // still here while the question is open
    answer(true);
    await vi.waitFor(() => expect(currentRoute()).toBe("cross"));
  });

  it("stays put when a promised guard answers false", async () => {
    setNavGuard(() => Promise.resolve(false));
    navigate("cross");
    await Promise.resolve();
    await Promise.resolve();
    expect(currentRoute()).toBe("lan");
  });

  it("does not navigate late if the route already moved while the guard was open", async () => {
    // An awaited guard means arbitrary time passes between the click and the
    // commit. A popstate, or a second answered dialog, can land in between —
    // and a stale commit would then yank the user off the page they are on.
    let answer: (ok: boolean) => void = () => {};
    setNavGuard(() => new Promise<boolean>((r) => { answer = r; }));
    navigate("cross");
    setNavGuard(null);
    navigate("apps"); // resolved synchronously, no guard
    expect(currentRoute()).toBe("apps");
    answer(true); // the stale "cross" answer arrives now
    await Promise.resolve();
    await Promise.resolve();
    expect(currentRoute()).toBe("apps");
    expect(location.pathname).toBe(APPS_PATH);
  });

  it("writes the fragment only once a promised guard has said yes", async () => {
    // The offline page's "compare" link under an upload in flight: the answer
    // arrives after navigate() has returned, so a caller cannot add the hash
    // itself — it has to travel with the navigation.
    navigate("offline");
    let answer: (ok: boolean) => void = () => {};
    setNavGuard(() => new Promise<boolean>((r) => { answer = r; }));
    const push = vi.spyOn(history, "pushState");
    navigate("cross", "#compare");
    expect(push).not.toHaveBeenCalled(); // nothing written while the question is open
    expect(location.pathname + location.hash).toBe(OFFLINE_PATH);
    answer(true);
    await vi.waitFor(() => expect(currentRoute()).toBe("cross"));
    expect(location.pathname + location.search + location.hash).toBe(`${CROSS_PATH}#compare`);
    expect(push).toHaveBeenCalledTimes(1);
    push.mockRestore();
  });

  it("carries a fragment into the pushed URL, written before the route flips", () => {
    // CrossPage reads location.hash as it mounts, and it mounts because the
    // route changed — so the hash has to be in the URL first, and in the SAME
    // entry rather than patched on by a second history call.
    const seen: string[] = [];
    const real = history.pushState.bind(history);
    const push = vi.spyOn(history, "pushState").mockImplementation((...args) => {
      seen.push(currentRoute());
      real(...args);
    });
    const replace = vi.spyOn(history, "replaceState");
    navigate("cross", "#compare");
    expect(push.mock.calls).toEqual([[{}, "", "/cross-network#compare"]]);
    expect(replace).not.toHaveBeenCalled();
    expect(seen).toEqual(["lan"]); // the old route was still current when the URL was written
    expect(currentRoute()).toBe("cross");
    expect(location.pathname + location.search + location.hash).toBe("/cross-network#compare");
    push.mockRestore();
    replace.mockRestore();
  });

  it("pushes exactly the bare path when no fragment is given", () => {
    // Every call site but one. The string is pinned, not derived, so a default
    // that started appending anything ("#", "?") would show up here.
    const push = vi.spyOn(history, "pushState");
    navigate("cross");
    expect(push.mock.calls).toEqual([[{}, "", "/cross-network"]]);
    expect(location.pathname + location.search + location.hash).toBe("/cross-network");
    push.mockRestore();
  });

  it("leaves the current entry untouched when a promised guard says no", async () => {
    navigate("offline");
    const before = history.length;
    const push = vi.spyOn(history, "pushState");
    const replace = vi.spyOn(history, "replaceState");
    setNavGuard(() => Promise.resolve(false));
    navigate("cross", "#compare");
    await Promise.resolve();
    await Promise.resolve();
    expect(currentRoute()).toBe("offline");
    expect(location.pathname + location.search + location.hash).toBe(OFFLINE_PATH);
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(history.length).toBe(before);
    push.mockRestore();
    replace.mockRestore();
  });

  it("leaves the current entry untouched when the guard says no synchronously", () => {
    navigate("offline");
    const push = vi.spyOn(history, "pushState");
    const replace = vi.spyOn(history, "replaceState");
    setNavGuard(() => false);
    navigate("cross", "#compare");
    expect(currentRoute()).toBe("offline");
    expect(location.pathname + location.search + location.hash).toBe(OFFLINE_PATH);
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    push.mockRestore();
    replace.mockRestore();
  });

  it("discards the fragment along with a late answer once the route has moved", async () => {
    navigate("offline");
    let answer: (ok: boolean) => void = () => {};
    setNavGuard(() => new Promise<boolean>((r) => { answer = r; }));
    navigate("cross", "#compare");
    setNavGuard(null);
    navigate("apps"); // the user went somewhere else while the dialog was open
    const push = vi.spyOn(history, "pushState");
    const replace = vi.spyOn(history, "replaceState");
    answer(true); // the stale "cross#compare" answer arrives now
    await Promise.resolve();
    await Promise.resolve();
    expect(currentRoute()).toBe("apps");
    expect(location.pathname + location.search + location.hash).toBe(APPS_PATH);
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    push.mockRestore();
    replace.mockRestore();
  });

  it("does not write a fragment when already on the target route", () => {
    navigate("cross");
    const push = vi.spyOn(history, "pushState");
    const replace = vi.spyOn(history, "replaceState");
    navigate("cross", "#compare");
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(location.pathname + location.search + location.hash).toBe("/cross-network");
    push.mockRestore();
    replace.mockRestore();
  });

  it("drops anything that is not a plain #id and navigates without it", () => {
    // The fragment is concatenated onto a path, so this list is the ways a
    // string could turn that into a different URL — or, for "#c=", into a
    // pairing code that routeFromLocation reads as "cross" on any path.
    const hostile = [
      "compare", "#", "##compare", "#a b", "#c=424242", "#compare\n", "#x/../y",
      "?q=1#compare", "/evil#compare", "//evil.example/#compare", "https://evil.example/#x",
      "#compare?x=1", "#%63=424242",
    ];
    for (const fragment of hostile) {
      const push = vi.spyOn(history, "pushState");
      navigate("apps", fragment);
      expect(push.mock.calls, JSON.stringify(fragment)).toEqual([[{}, "", "/apps"]]);
      expect(currentRoute(), JSON.stringify(fragment)).toBe("apps");
      expect(location.pathname + location.search + location.hash, JSON.stringify(fragment)).toBe("/apps");
      push.mockRestore();
      history.replaceState({}, "", "/");
      syncRouteFromLocation();
    }
  });

  it("switches to verify-email and reset-password and back to their paths", () => {
    navigate("verify-email");
    expect(currentRoute()).toBe("verify-email");
    expect(location.pathname).toBe(VERIFY_EMAIL_PATH);
    navigate("reset-password");
    expect(currentRoute()).toBe("reset-password");
    expect(location.pathname).toBe(RESET_PASSWORD_PATH);
  });

  it("switches to apps and sets the /apps path", () => {
    navigate("apps");
    expect(currentRoute()).toBe("apps");
    expect(location.pathname).toBe(APPS_PATH);
  });
});

describe("magic-link 路由", () => {
  it("/magic-link 映射到登录落地页", () => {
    expect(rfl("/magic-link", "")).toBe("magic-link");
  });
  it("路径常量与服务端 handlers.go 的 magicLinkPath 一致", () => {
    // 两边写死同一个字符串，差一个字符的表现是：用户点开邮件里的链接，落到 SPA 的
    // 首页而不是登录页——看起来像"链接没反应"，查起来毫无线索。
    const go = readFileSync(resolve(process.cwd(), "../server/account/handlers.go"), "utf8");
    const m = /const magicLinkPath = "([^"]+)"/.exec(go);
    expect(m, "handlers.go 里找不到 magicLinkPath").not.toBeNull();
    expect(m![1]).toBe(MAGIC_PATH);
  });
});
