// Component-level coverage for the /me page's quota meters, plus direct unit
// coverage for the shared per-user cache in usage.svelte.ts that QuotaMeters,
// QuotaNotice, and Task 8's PlanCard all read from. Follows the same
// mount+flushSync pattern as QuotaNotice.test.ts.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, unmount, flushSync, type Component } from "svelte";
import QuotaMeters from "./QuotaMeters.svelte";
import QuotaNotice from "./QuotaNotice.svelte";
import { refreshSession } from "./auth.svelte";
import { loadLang } from "./i18n.svelte";
import { fetchUsage, invalidateUsage } from "./usage.svelte";

let targets: HTMLDivElement[] = [];
let apps: unknown[] = [];

function usageResponse(used: number, cap: number) {
  return {
    ok: true, status: 200,
    json: async () => ({
      period: "202607", resetsAt: 0,
      traffic: { used, cap },
      storage: { used, cap },
    }),
  };
}

// Logs a user in (or out, for user === null) via the real /api/me response
// refreshSession() consumes, so session().user matches what the components read.
async function setSession(user: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/me") return user
      ? { ok: true, status: 200, json: async () => ({ user }) }
      : { ok: false, status: 401, json: async () => ({}) };
    throw new Error(`unexpected fetch ${url} during session setup`);
  }) as unknown as typeof fetch);
  await refreshSession();
}

function mountComponent(Comp: Component<Record<string, never>>): HTMLDivElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  targets.push(target);
  apps.push(mount(Comp, { target }));
  return target;
}

// Two macrotask ticks drains the $effect's fetch("/api/me/usage") plus the
// state write, mirroring QuotaNotice.test.ts's mountNotice().
async function settle() {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

afterEach(() => {
  for (const app of apps) unmount(app as never);
  for (const target of targets) target.remove();
  apps = [];
  targets = [];
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
  // usage.svelte.ts 按用户 id 缓存在途 promise。用例之间用的是同一个 user id，
  // 不清掉的话第二个用例会命中第一个用例 mock 出来的响应。
  invalidateUsage();
});

describe("QuotaMeters", () => {
  it("never fetches usage while logged out, and renders nothing", async () => {
    await setSession(null);
    const usageFetch = vi.fn(async (url: string) => {
      if (url === "/api/me/usage") return usageResponse(50, 100);
      throw new Error(`unexpected fetch ${url} while logged out`);
    });
    vi.stubGlobal("fetch", usageFetch as unknown as typeof fetch);
    await loadLang("en");
    const target = mountComponent(QuotaMeters);
    await settle();

    expect(target.querySelector(".quota")).toBeNull();
    const calledUrls = usageFetch.mock.calls.map((args) => args[0]);
    expect(calledUrls).not.toContain("/api/me/usage");
  });

  it("clears usage (no stale numbers left over) after logout", async () => {
    await setSession({ id: "m1", email: "m1@b.com", displayName: "M1" });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/me/usage") return usageResponse(42, 100);
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);
    await loadLang("en");
    const target = mountComponent(QuotaMeters);
    await settle();
    expect(target.querySelector(".quota")).not.toBeNull();
    expect(target.textContent).toContain("42");

    // Log out. No further /api/me/usage fetch should happen — the effect must
    // clear usage purely from uid becoming null, not from a stale response.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/me") return { ok: false, status: 401, json: async () => ({}) };
      throw new Error(`must not fetch ${url} while logged out`);
    }) as unknown as typeof fetch);
    await refreshSession();
    flushSync();

    expect(target.querySelector(".quota")).toBeNull();
  });

  it("ignores a stale /api/me/usage response that resolves after logout (race)", async () => {
    // Mirrors QuotaNotice.test.ts's identical race test: the request for m2 is
    // still in flight when the user logs out (Nav's logout control lives on
    // the same page and does NOT unmount QuotaMeters). Without the session
    // guard in QuotaMeters' .then, that stale response would overwrite `usage`
    // and redraw the previous account's numbers after logout.
    await setSession({ id: "m2", email: "m2@b.com", displayName: "M2" });

    let resolveUsage!: (value: unknown) => void;
    const pendingUsage = new Promise((resolve) => { resolveUsage = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/me/usage") return pendingUsage;
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);

    await loadLang("en");
    const target = mountComponent(QuotaMeters);
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    // m2's /api/me/usage is in flight; nothing has resolved yet.
    expect(target.querySelector(".quota")).toBeNull();

    // Log out while that request is still pending.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/me") return { ok: false, status: 401, json: async () => ({}) };
      throw new Error(`must not fetch ${url} while logged out`);
    }) as unknown as typeof fetch);
    await refreshSession();
    flushSync();
    expect(target.querySelector(".quota")).toBeNull();

    // The stale m2 request finally resolves. It must be dropped: the session
    // moved on (logged out) since it was issued.
    resolveUsage(usageResponse(42, 100));
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    expect(target.querySelector(".quota")).toBeNull();
  });
});

describe("usage.svelte.ts shared cache — cross-component dedup", () => {
  it("mounting QuotaMeters and QuotaNotice in the same frame issues exactly one /api/me/usage request", async () => {
    // This is the entire reason Task 6 exists: without the shared cache, two
    // components independently reading the same session would each fire
    // their own fetch("/api/me/usage"). A third consumer (Task 8's PlanCard)
    // would make it three. Pin the count at one.
    await setSession({ id: "s1", email: "s1@b.com", displayName: "S1" });
    const usageFetch = vi.fn(async (url: string) => {
      if (url === "/api/me/usage") return usageResponse(85, 100);
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", usageFetch as unknown as typeof fetch);
    await loadLang("en");
    mountComponent(QuotaMeters);
    mountComponent(QuotaNotice);
    await settle();

    const usageCalls = usageFetch.mock.calls.filter((args) => args[0] === "/api/me/usage");
    expect(usageCalls.length).toBe(1);
  });
});

describe("fetchUsage / invalidateUsage", () => {
  it("dedupes concurrent calls for the same user id into one network request", async () => {
    const mockFetch = vi.fn(async () => usageResponse(1, 100));
    vi.stubGlobal("fetch", mockFetch as unknown as typeof fetch);

    const [a, b] = await Promise.all([fetchUsage("u1"), fetchUsage("u1")]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("issues a fresh request when the user id changes", async () => {
    const mockFetch = vi.fn(async () => usageResponse(1, 100));
    vi.stubGlobal("fetch", mockFetch as unknown as typeof fetch);

    await fetchUsage("u1");
    await fetchUsage("u2");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("issues a fresh request for the same user id after invalidateUsage()", async () => {
    const mockFetch = vi.fn(async () => usageResponse(1, 100));
    vi.stubGlobal("fetch", mockFetch as unknown as typeof fetch);

    await fetchUsage("u1");
    invalidateUsage();
    await fetchUsage("u1");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("resolves to null (not a rejection) when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch);

    await expect(fetchUsage("u1")).resolves.toBeNull();
  });
});
