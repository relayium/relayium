// 会员卡在"权益不是（不只是）在本站买的"时的形态：卡片照常显示套餐，但不给
// 任何点了必然失败的账单按钮。数据源是 /api/me/usage 的 plan.entitlementProvider
// ——和卡片其余字段同一份快照，不掺 session().user。
import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import PlanCard from "./PlanCard.svelte";
import { refreshSession } from "./auth.svelte";
import { loadLang } from "./i18n.svelte";
import { invalidateUsage } from "./usage.svelte";
import en from "./i18n/en";

let target: HTMLDivElement;
let app: unknown;

async function mountWith(plan: Record<string, unknown>, user: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/me") return { ok: true, status: 200, json: async () => ({ user }) };
    if (url === "/api/me/usage") return {
      ok: true, status: 200,
      json: async () => ({
        period: "202608", resetsAt: 0,
        traffic: { used: 0, cap: 0 }, storage: { used: 0, cap: 0 },
        plan,
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

const paidPlan = (over: Record<string, unknown> = {}) => ({
  id: "pro", name: "Pro", storageBytes: 5e9, trafficBytes: 1e11, retentionSecs: 7 * 86400,
  priceMonthly: 499, priceYearly: 4999, billingCycle: "monthly",
  scheduledPlanId: "", scheduledPlanName: "",
  isTop: false, subscriptionStatus: "active", subscriptionEnd: 1_900_000_000,
  ...over,
});

const buttonLabels = () => [...target.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");

afterEach(() => {
  if (app) unmount(app as never);
  app = null;
  target?.remove();
  vi.unstubAllGlobals();
  invalidateUsage();
});

describe("PlanCard entitlement provider", () => {
  it("App Store 订阅：照常显示套餐，但没有换套餐/管理账单/取消订阅", async () => {
    await mountWith(
      paidPlan({ entitlementProvider: "apple" }),
      { id: "u1", email: "a@b.c", displayName: "A", hasPassword: true, hasBilling: false },
    );
    expect(target.textContent).toContain("Pro");
    expect(target.querySelector('[data-testid="plan-managed-elsewhere"]')?.textContent?.trim())
      .toBe(en.billing.appleManagedBadge);
    const labels = buttonLabels();
    for (const gone of [en.billing.changePlan, en.billing.upgrade, en.billing.manageBilling, en.billing.cancelSubscription]) {
      expect(labels).not.toContain(gone);
    }
  });

  it("两个渠道同时生效：同样不在这张卡上给 Stripe 动作", async () => {
    // hasBilling 为真（确实有 Stripe 客户），但门户只会取消其中一半——这张卡
    // 不该把它伪装成"管理你的订阅"。
    await mountWith(
      paidPlan({ entitlementProvider: "multiple" }),
      { id: "u1", email: "a@b.c", displayName: "A", hasPassword: true, hasBilling: true },
    );
    const labels = buttonLabels();
    expect(labels).not.toContain(en.billing.manageBilling);
    expect(labels).not.toContain(en.billing.cancelSubscription);
    expect(target.querySelector('[data-testid="plan-managed-elsewhere"]')).not.toBeNull();
  });

  it("Stripe 订阅不受影响", async () => {
    await mountWith(
      paidPlan({ entitlementProvider: "stripe" }),
      { id: "u1", email: "a@b.c", displayName: "A", hasPassword: true, hasBilling: true },
    );
    expect(target.querySelector('[data-testid="plan-managed-elsewhere"]')).toBeNull();
    const labels = buttonLabels();
    expect(labels).toContain(en.billing.changePlan);
    expect(labels).toContain(en.billing.manageBilling);
    expect(labels).toContain(en.billing.cancelSubscription);
  });

  it("老服务端不返回该字段时，行为与从前完全一致", async () => {
    // 整个 key 不存在（不是空串）——这正是老服务端发出来的形状。
    await mountWith(paidPlan(), { id: "u1", email: "a@b.c", displayName: "A", hasPassword: true, hasBilling: true });
    expect(target.querySelector('[data-testid="plan-managed-elsewhere"]')).toBeNull();
    expect(buttonLabels()).toContain(en.billing.manageBilling);
  });
});
