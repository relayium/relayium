import { describe, it, expect, vi, afterEach } from "vitest";
import {
  routeFromLocation as rfl, downloadId, CROSS_PATH, CLI_PATH, APPS_PATH,
  VERIFY_EMAIL_PATH, RESET_PASSWORD_PATH, MAGIC_PATH,
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
