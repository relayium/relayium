// Component-level coverage for the /me page's quota meters, plus direct unit
// coverage for the shared per-user cache in usage.svelte.ts that QuotaMeters,
// QuotaNotice, and Task 8's PlanCard all read from. Follows the same
// mount+flushSync pattern as QuotaNotice.test.ts.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, unmount, flushSync, type Component } from "svelte";
import QuotaMeters from "./QuotaMeters.svelte";
import QuotaNotice from "./QuotaNotice.svelte";
import PlanCard from "./PlanCard.svelte";
import MePage from "./MePage.svelte";
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

describe("QuotaMeters — 用量被别的组件改掉之后要重画", () => {
  it("re-reads /api/me/usage after invalidateUsage(), without a remount or a user change", async () => {
    // PairRoomStorage 就在这条存储条下面，释放掉一批配对副本会直接改变 storage.used。
    // 它做完调 invalidateUsage()；如果这条 $effect 不把世代号当依赖，用户会盯着一个
    // 已经不成立的存储数字，直到离开 /me 再回来。清缓存本身**不会**让已经画出来的
    // 组件重取——这正是这条用例守的东西。
    await setSession({ id: "rf1", email: "rf1@b.com", displayName: "RF1" });
    let used = 5000;
    const f = vi.fn(async (url: string) => {
      if (url === "/api/me/usage") return usageResponse(used, 100000);
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", f as unknown as typeof fetch);
    await loadLang("en");
    const target = mountComponent(QuotaMeters);
    await settle();
    expect(f.mock.calls.filter((a) => a[0] === "/api/me/usage").length).toBe(1);
    const first = target.textContent ?? "";

    used = 0; // the pair-room copies were released
    invalidateUsage();
    await settle();

    expect(f.mock.calls.filter((a) => a[0] === "/api/me/usage").length).toBe(2);
    expect(target.querySelector(".quota")).not.toBeNull();
    expect(target.textContent).not.toBe(first);
  });
});

describe("usage.svelte.ts shared cache — cross-component dedup", () => {
  it("mounting QuotaMeters, QuotaNotice and PlanCard in the same frame issues exactly one /api/me/usage request", async () => {
    // This is the entire reason Task 6 exists: without the shared cache, three
    // components independently reading the same session would each fire
    // their own fetch("/api/me/usage"). Pin the count at one.
    await setSession({ id: "s1", email: "s1@b.com", displayName: "S1" });
    const usageFetch = vi.fn(async (url: string) => {
      if (url === "/api/me/usage") return usageResponse(85, 100);
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", usageFetch as unknown as typeof fetch);
    await loadLang("en");
    mountComponent(QuotaMeters);
    mountComponent(QuotaNotice);
    mountComponent(PlanCard);
    await settle();

    const usageCalls = usageFetch.mock.calls.filter((args) => args[0] === "/api/me/usage");
    expect(usageCalls.length).toBe(1);
  });
});

describe("QuotaMeters — 换用户后界面画的是新账号的数字", () => {
  it("renders the new account's numbers after A logs out and B logs in", async () => {
    // 变异"让 fetchUsage 忽略 userId 变化"之前只被 fetchUsage 单测的调用次数断言
    // 逮到；这条从界面这一端钉死同一语义：串号污染是用户看得见的后果，不只是多
    // 打/少打一次请求的实现细节。
    // 单个 stub 按当前账号发数据。分两次 stubGlobal 会有竞态：换号后 Svelte 的
    // $effect 在微任务里就重跑了，那时新的 stub 还没装上。
    let user: unknown = { id: "sw-a", email: "a@b.com", displayName: "A" };
    const used = () => ((user as { id: string }).id === "sw-a" ? 42 : 77);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/me") return { ok: true, status: 200, json: async () => ({ user }) };
      if (url === "/api/me/usage") return usageResponse(used(), 100);
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);
    await refreshSession();
    await loadLang("en");
    const target = mountComponent(QuotaMeters);
    await settle();
    expect(target.textContent).toContain("42");

    // A 登出、B 登入。B 的用量完全不同。
    user = { id: "sw-b", email: "b@b.com", displayName: "B" };
    await refreshSession();
    await settle();

    expect(target.querySelector(".quota")).not.toBeNull();
    expect(target.textContent).toContain("77");
    expect(target.textContent).not.toContain("42");
  });
});

// MePage 每次挂载都要丢缓存，这样"离开 /me 再回来"能拿到新数字（上传完文件、
// 改完档之后回个人中心，数字必须动），同时"一次访问内多个组件只打一次请求"这条
// 共享缓存的收益不能丢。两条契约各钉一条测试。
describe("/me visits refresh usage", () => {
  // MePage 挂载时会打一串它自己的请求；这里一律喂空数据，只关心 /api/me/usage。
  function mePageFetch(user: unknown) {
    return vi.fn(async (url: string) => {
      if (url === "/api/me/usage") return usageResponse(42, 100);
      if (url === "/api/me") return { ok: true, status: 200, json: async () => ({ user }) };
      if (url === "/api/stats") return { ok: true, status: 200, json: async () => ({ transfers: 0, downloads: 0, uploadBytes: 0, downloadBytes: 0, relayBytes: 0 }) };
      if (url === "/api/files") return { ok: true, status: 200, json: async () => ({ files: [] }) };
      if (url === "/api/nodes/mine") return { ok: true, status: 200, json: async () => ({ nodes: [] }) };
      // PairRoomStorage sits under the meters on /me and reads this. An account
      // with none renders nothing at all, which is the case every test here is in.
      if (url === "/api/pair-rooms") {
        return { ok: true, status: 200, json: async () => ({ rooms: [], totals: { rooms: 0, objects: 0, bytes: 0 }, limit: 200, truncated: false }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }
  const usageCallCount = (f: { mock: { calls: unknown[][] } }) =>
    f.mock.calls.filter((args) => args[0] === "/api/me/usage").length;

  it("issues exactly one /api/me/usage request per visit, however many consumers mount", async () => {
    const user = { id: "me1", email: "me1@b.com", displayName: "ME1" };
    await setSession(user);
    const f = mePageFetch(user);
    vi.stubGlobal("fetch", f as unknown as typeof fetch);
    await loadLang("en");
    mountComponent(MePage);
    mountComponent(QuotaNotice); // 第二个消费者，模拟 Task 8 的 PlanCard
    await settle();

    expect(usageCallCount(f)).toBe(1);
  });

  it("issues a fresh /api/me/usage request when /me is left and revisited", async () => {
    const user = { id: "me2", email: "me2@b.com", displayName: "ME2" };
    await setSession(user);
    const f = mePageFetch(user);
    vi.stubGlobal("fetch", f as unknown as typeof fetch);
    await loadLang("en");

    // 第一次访问 /me。
    const first = mount(MePage, { target: document.body.appendChild(document.createElement("div")) });
    await settle();
    expect(usageCallCount(f)).toBe(1);

    // 离开 /me（懒加载路由的 {#if} 分支会真的卸载页面）……
    unmount(first as never);
    flushSync();

    // ……再回来。用户 id 没变，所以只有"进 /me 刷新"这条逻辑能让它重新请求。
    mountComponent(MePage);
    await settle();

    expect(usageCallCount(f)).toBe(2);
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

  it("retries after a failure instead of caching the failure forever", async () => {
    // 缓存的是 promise，所以一次瞬时网络抖动会把"resolve 成 null"的 promise 存
    // 住，同一 userId 后续永不重试——用量条会在整个 SPA 会话内静默消失。第一次
    // 失败、第二次网络已恢复，必须真的重新发请求并拿到数据。
    let attempt = 0;
    const mockFetch = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("network down");
      return usageResponse(7, 100);
    });
    vi.stubGlobal("fetch", mockFetch as unknown as typeof fetch);

    expect(await fetchUsage("u1")).toBeNull();
    const second = await fetchUsage("u1");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(second).not.toBeNull();
    expect(second!.traffic.used).toBe(7);
  });

  it("retries after a non-2xx response instead of caching it forever", async () => {
    // 同上，但走的是 `r.ok === false` 那条路径（一次 500 不该让用量永久消失）。
    let attempt = 0;
    const mockFetch = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return { ok: false, status: 500, json: async () => ({}) };
      return usageResponse(9, 100);
    });
    vi.stubGlobal("fetch", mockFetch as unknown as typeof fetch);

    expect(await fetchUsage("u1")).toBeNull();
    const second = await fetchUsage("u1");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(second!.traffic.used).toBe(9);
  });

  it("a late failure does not evict a newer, valid cache entry", async () => {
    // forget() 里的身份检查（cached === p）：给 u1 发的请求还在飞，期间换到了
    // u2 并成功缓存；u1 那次最终失败时若无条件清缓存，会把 u2 的有效缓存误伤
    // 掉，下一次 fetchUsage("u2") 就要多打一次请求。
    let failU1!: (e: unknown) => void;
    const pendingU1 = new Promise((_resolve, reject) => { failU1 = reject; });
    const mockFetch = vi.fn(async (_url: string, _init?: unknown) => {
      return mockFetch.mock.calls.length === 1 ? pendingU1 : usageResponse(5, 100);
    });
    vi.stubGlobal("fetch", mockFetch as unknown as typeof fetch);

    const u1 = fetchUsage("u1"); // 在途，尚未失败
    await fetchUsage("u2");      // 换用户，u2 成功并占住缓存
    expect(mockFetch).toHaveBeenCalledTimes(2);

    failU1(new Error("network down")); // u1 迟到的失败
    expect(await u1).toBeNull();

    await fetchUsage("u2"); // 必须命中 u2 的缓存，不能重新请求
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("resolves to null (not a rejection) when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch);

    await expect(fetchUsage("u1")).resolves.toBeNull();
  });
});
