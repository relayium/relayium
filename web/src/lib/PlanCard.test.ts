// 会员卡的组件级覆盖。三种形态各钉一条：免费档（要有升级引导）、付费档（要有
// 管理订阅）、最高档（升级引导必须消失）。用真实的 session/i18n 模块 + mock
// fetch，与 QuotaNotice.test.ts 同款。
import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import PlanCard from "./PlanCard.svelte";
import { refreshSession } from "./auth.svelte";
import { loadLang } from "./i18n.svelte";
import { invalidateUsage } from "./usage.svelte";

let target: HTMLDivElement;
let app: unknown;

function plan(over: Record<string, unknown> = {}) {
  return {
    id: "free", name: "Free", storageBytes: 100 * 1024 * 1024,
    trafficBytes: 1024 * 1024 * 1024, retentionSecs: 3 * 86400,
    priceMonthly: 0, isTop: false, subscriptionStatus: "", subscriptionEnd: 0,
    ...over,
  };
}

// 登录并让 /api/me/usage 返回指定套餐。`userOver` 用来往 /api/me 的 user 对象上
// 盖字段——session 上也有一份 planId/subscriptionStatus/subscriptionEnd，用它来
// 钉死"套餐信息只认 /api/me/usage"这条数据源裁定。
async function mountWith(p: Record<string, unknown>, userOver: Record<string, unknown> = {}) {
  const user = { id: "u1", email: "a@b.c", displayName: "A", hasPassword: true, ...userOver };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/me") return { ok: true, status: 200, json: async () => ({ user }) };
    if (url === "/api/me/usage") return {
      ok: true, status: 200,
      json: async () => ({
        period: "202607", resetsAt: 0,
        traffic: { used: 0, cap: 0 }, storage: { used: 0, cap: 0 },
        plan: p,
      }),
    };
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch);
  await refreshSession();
  await loadLang("en");
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(PlanCard, { target });
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

const buttons = () => [...target.querySelectorAll("button")].map((b) => b.textContent?.trim());

afterEach(() => {
  if (app) unmount(app as never);
  target?.remove();
  vi.unstubAllGlobals();
  invalidateUsage();
});

describe("PlanCard", () => {
  it("免费档显示等级名、权益与升级入口", async () => {
    await mountWith(plan());
    const html = target.textContent ?? "";
    expect(html).toContain("Free");
    expect(html).toContain("100 MB");         // 存储权益
    expect(html).toContain("Files kept 3 days"); // 保留期
    expect(html).toContain("Running out of room?"); // 引导句
    const btns = buttons();
    expect(btns).toContain("Upgrade");
    expect(btns).not.toContain("Manage billing");
  });

  it("付费档额外给出管理订阅入口", async () => {
    await mountWith(plan({ id: "pro", name: "Pro", priceMonthly: 890, subscriptionStatus: "active" }));
    const btns = buttons();
    expect(btns).toContain("Upgrade");
    expect(btns).toContain("Manage billing");
  });

  it("最高档不再引导升级", async () => {
    await mountWith(plan({ id: "max", name: "Max", isTop: true, subscriptionStatus: "active" }));
    const btns = buttons();
    // 已经买到顶了还催升级是负体验，也没有目标页可去。
    expect(btns).not.toContain("Upgrade");
    expect(target.textContent).toContain("You're on the highest tier.");
    // 顶档也是付费的，管理订阅入口不能跟着升级入口一起消失。
    expect(btns).toContain("Manage billing");
  });

  it("无限档的权益不显示成 0", async () => {
    await mountWith(plan({ id: "max", name: "Max", storageBytes: 0, trafficBytes: 0, retentionSecs: 0 }));
    const text = target.textContent ?? "";
    expect(text).toContain("Files kept indefinitely");
    // 钉整条权益串而不只是"含有 Unlimited / 不含 0 B"：后者对"两处 cap 只坏了
    // 一处"是瞎的（另一处仍会渲染出 Unlimited，断言照样通过），而 0 字节的
    // formatSize 恰好是 "0 B" 这件事也只是巧合，不该被当成断言的支点。
    expect(target.querySelector(".perks")?.textContent).toBe(
      "Unlimited storage · Unlimited/mo traffic · Files kept indefinitely",
    );
  });

  it("套餐信息只认 /api/me/usage，不读 session 上那份", async () => {
    // session 的 user 对象上也带 planId/subscriptionStatus/subscriptionEnd，两处
    // 会漂移（session 是登录那一刻的快照，usage 是实时的）。这里让两边互相矛盾：
    // session 说 Legacy/已订阅，usage 说 Free/从未结账。渲染必须跟 usage 走。
    await mountWith(
      plan({ id: "free", name: "Free", subscriptionStatus: "", subscriptionEnd: 0 }),
      { planId: "legacy", subscriptionStatus: "active", subscriptionEnd: 4102444800 },
    );
    const btns = buttons();
    expect(btns).not.toContain("Manage billing"); // usage 说没订阅
    expect(target.textContent).toContain("Free");
    expect(target.textContent).not.toContain("active");
  });

  it("取不到套餐时整块不渲染", async () => {
    // 老服务端不返回 plan 字段：会员卡是附加信息，画一张空卡比不画更糟。
    const user = { id: "u2", email: "c@d.e", displayName: "C", hasPassword: true };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/me") return { ok: true, status: 200, json: async () => ({ user }) };
      if (url === "/api/me/usage") return {
        ok: true, status: 200,
        json: async () => ({
          period: "202607", resetsAt: 0,
          traffic: { used: 0, cap: 0 }, storage: { used: 0, cap: 0 },
        }),
      };
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);
    await refreshSession();
    await loadLang("en");
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(PlanCard, { target });
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    expect(target.querySelector(".plan-card")).toBeNull();
  });
});
