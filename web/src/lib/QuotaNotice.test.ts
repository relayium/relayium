// Component-level coverage for the transfer-surface 80%-quota banner. There's
// no browser/admin-UI harness available in this environment, so this exercises
// the real component (real session/i18n/router modules, mocked fetch) via the
// same mount+flushSync pattern Account.billing.test.ts uses for the sibling
// billing-banner logic — the closest deterministic substitute for "log in,
// shrink the plan cap in /admin/plans, reload, look at the page."
import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import QuotaNotice from "./QuotaNotice.svelte";
import { refreshSession } from "./auth.svelte";
import { loadLang } from "./i18n.svelte";
import { currentRoute } from "./router.svelte";

let target: HTMLDivElement;
let app: unknown;

function usageResponse(used: number, cap: number) {
  return {
    ok: true, status: 200,
    json: async () => ({
      period: "202607", resetsAt: 0,
      traffic: { used, cap },
      storage: { used: 0, cap: 0 },
    }),
  };
}

// Logs a user in (or out, for user === null) via the real /api/me response
// refreshSession() consumes, so session().user matches what QuotaNotice reads.
async function setSession(user: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/me") return user
      ? { ok: true, status: 200, json: async () => ({ user }) }
      : { ok: false, status: 401, json: async () => ({}) };
    throw new Error(`unexpected fetch ${url} during session setup`);
  }) as unknown as typeof fetch);
  await refreshSession();
}

async function mountNotice() {
  await loadLang("en");
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(QuotaNotice, { target });
  // The $effect's fetch("/api/me/usage") is async; two macrotask ticks drains
  // it plus the state write (mirrors Account.billing.test.ts's mountAccount).
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

afterEach(() => {
  if (app) unmount(app as never);
  target?.remove();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

describe("QuotaNotice", () => {
  it("stays hidden and never fetches usage when logged out", async () => {
    await setSession(null);
    // Any fetch at all (besides the /api/me above) is a bug: an anonymous
    // visitor has no quota to warn about.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      throw new Error(`must not fetch ${url} while logged out`);
    }) as unknown as typeof fetch);
    await mountNotice();
    expect(target.querySelector(".quota-warn")).toBeNull();
  });

  it("shows the warning + Upgrade button once usage crosses 80%", async () => {
    await setSession({ id: "u1", email: "a@b.com", displayName: "A" });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/me/usage") return usageResponse(85, 100);
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);
    await mountNotice();

    const banner = target.querySelector(".quota-warn");
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("85");
    const btn = target.querySelector("button");
    expect(btn?.textContent?.trim()).toBe("Upgrade");
  });

  it("stays hidden below the 80% threshold", async () => {
    await setSession({ id: "u2", email: "b@b.com", displayName: "B" });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/me/usage") return usageResponse(10, 100);
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);
    await mountNotice();
    expect(target.querySelector(".quota-warn")).toBeNull();
  });

  it("never warns on an unlimited plan (cap 0), no matter how much is used", async () => {
    await setSession({ id: "u3", email: "c@b.com", displayName: "C" });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/me/usage") return usageResponse(999_999_999, 0);
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);
    await mountNotice();
    expect(target.querySelector(".quota-warn")).toBeNull();
  });

  it("clicking Upgrade navigates to the real pricing route", async () => {
    await setSession({ id: "u4", email: "d@b.com", displayName: "D" });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/me/usage") return usageResponse(90, 100);
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);
    await mountNotice();

    target.querySelector("button")!.click();
    flushSync();

    expect(currentRoute()).toBe("pricing");
    expect(location.pathname).toBe("/pricing");
  });

  it("clears any residual percentage from the previous account on logout", async () => {
    await setSession({ id: "u5", email: "e@b.com", displayName: "E" });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/me/usage") return usageResponse(90, 100);
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);
    await mountNotice();
    expect(target.querySelector(".quota-warn")).not.toBeNull();

    // Log out. No further /api/me/usage fetch should happen — the effect must
    // zero pct purely from uid becoming null, not from a stale response.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/me") return { ok: false, status: 401, json: async () => ({}) };
      throw new Error(`must not fetch ${url} while logged out`);
    }) as unknown as typeof fetch);
    await refreshSession();
    flushSync();

    expect(target.querySelector(".quota-warn")).toBeNull();
  });
});
