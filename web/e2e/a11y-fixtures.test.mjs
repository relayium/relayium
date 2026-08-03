import { describe, expect, it, vi } from "vitest";
import {
  AUTH_METHODS, FREE_USER, FREE_USER_ROUTES, PLANS, PRICING_ROUTES, apiFixtureScript,
} from "./a11y-fixtures.mjs";

/**
 * 把注入脚本真的执行一遍，返回被补丁替换后的 fetch 和它下面那个"真" fetch 的间谍。
 *
 * 直接跑源码而不是把逻辑复述一遍：这份脚本唯一的运行环境是浏览器里的一段字符串，
 * 而字符串是没有类型检查、也不会被 lint 碰到的——它出错的方式恰恰是"看起来完全对"。
 */
function install(routes) {
  const realFetch = vi.fn(async () => new Response("real", { status: 200 }));
  window.fetch = realFetch;
  // eslint-disable-next-line no-new-func
  new Function(apiFixtureScript(routes))();
  return { fetch: window.fetch, realFetch };
}

describe("a11y API fixture", () => {
  it("answers a matched same-origin GET with a valid JSON Response", async () => {
    const { fetch } = install({ "/api/plans": PLANS });

    const res = await fetch("/api/plans");

    expect(res).toBeInstanceOf(Response);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    await expect(res.json()).resolves.toEqual(PLANS);
  });

  it("reads the URL off a Request instead of stringifying it", async () => {
    // String(new Request(u)) is "[object Request]" — a matcher that only did
    // String(input) would silently stop matching and leave the page in the very
    // load-error state this fixture exists to get past.
    const { fetch, realFetch } = install({ "/api/plans": PLANS });

    const res = await fetch(new Request(new URL("/api/plans", location.href)));

    await expect(res.json()).resolves.toEqual(PLANS);
    expect(realFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["an unmatched path", () => ["/api/files/abc/meta"]],
    ["a cross-origin URL", () => ["https://example.invalid/api/plans"]],
    ["a non-GET on a matched path", () => ["/api/plans", { method: "POST" }]],
    // Node's Request has no document to resolve against, so these spell the
    // origin out; the fixture resolves relative strings via document.baseURI.
    ["a non-GET Request on a matched path", () => [new Request(new URL("/api/plans", location.href), { method: "DELETE" })]],
    ["an init.method override on a GET Request", () => [new Request(new URL("/api/plans", location.href)), { method: "POST" }]],
  ])("passes %s through to the real fetch, arguments untouched", async (_name, build) => {
    const { fetch, realFetch } = install({ "/api/plans": PLANS });
    const args = build();

    const res = await fetch(...args);

    expect(realFetch).toHaveBeenCalledTimes(1);
    // Same object identity, not a rebuilt request: rebuilding drops signal,
    // credentials and body without anyone noticing.
    expect(realFetch.mock.calls[0][0]).toBe(args[0]);
    expect(realFetch.mock.calls[0][1]).toBe(args[1]);
    await expect(res.text()).resolves.toBe("real");
  });

  it("falls through instead of throwing when the input is not a usable URL", async () => {
    const { fetch, realFetch } = install({ "/api/plans": PLANS });
    const hostile = { toString() { throw new Error("boom"); } };

    await expect(fetch(hostile)).resolves.toBeInstanceOf(Response);
    expect(realFetch).toHaveBeenCalledTimes(1);
  });

  it("only stubs the paths it was given, so a second target's routes cannot leak in", async () => {
    const { fetch, realFetch } = install(PRICING_ROUTES);

    // The pricing target is deliberately signed out: it must NOT inherit the
    // account target's session fixture.
    await fetch("/api/me");

    expect(realFetch).toHaveBeenCalledTimes(1);
  });
});

describe("a11y fixture payloads", () => {
  it("serves a realistic non-empty plan set", () => {
    // Pricing.svelte treats an empty array as a load failure, and a single tier
    // would not exercise the grid the scan is there to look at.
    expect(PLANS.length).toBeGreaterThanOrEqual(3);
    expect(PLANS.some((p) => p.priceMonthly === 0)).toBe(true);
    expect(PLANS.some((p) => p.priceMonthly > 0 && p.purchasableMonthly)).toBe(true);
    for (const plan of PLANS) {
      expect(plan.name).toBeTruthy();
      expect(plan.retentionSecs).toBeGreaterThan(0);
    }
  });

  it("signs the account target in as a free user with no Stripe customer", () => {
    // Account.svelte only inlines <Pricing /> when hasBilling is false; a
    // subscriber gets the portal buttons and the inline grid never mounts.
    expect(FREE_USER.planId).toBe("free");
    expect(FREE_USER.hasBilling).toBe(false);
    expect(FREE_USER_ROUTES["/api/me"]).toEqual({ user: FREE_USER });
    expect(FREE_USER_ROUTES["/api/auth/methods"]).toBe(AUTH_METHODS);
    expect(FREE_USER_ROUTES["/api/plans"]).toBe(PLANS);
  });
});
