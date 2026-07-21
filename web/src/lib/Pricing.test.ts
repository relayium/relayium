import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Pricing from "./Pricing.svelte";
import { loadLang } from "./i18n.svelte";

const TIERS = [
  {
    id: "free",
    name: "Free",
    storageBytes: 1024 * 1024 * 1024,
    trafficBytes: 1024 * 1024 * 1024,
    retentionSecs: 86400,
    priceMonthly: 0,
    priceYearly: 0,
    purchasableMonthly: false,
    purchasableYearly: false,
  },
  {
    id: "pro",
    name: "Pro",
    storageBytes: 100 * 1024 * 1024 * 1024,
    trafficBytes: 200 * 1024 * 1024 * 1024,
    retentionSecs: 30 * 86400,
    priceMonthly: 900, // $9.00
    priceYearly: 9000, // $90.00
    purchasableMonthly: true,
    purchasableYearly: true,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    storageBytes: 1024 * 1024 * 1024 * 1024,
    trafficBytes: 2 * 1024 * 1024 * 1024 * 1024,
    retentionSecs: 90 * 86400,
    priceMonthly: 4900,
    priceYearly: 49000,
    purchasableMonthly: false,
    purchasableYearly: false,
  },
];

let target: HTMLDivElement;
let app: unknown;

async function mountPricing() {
  // messages[lang()] must be populated before mount — Pricing.svelte reads it
  // synchronously in a $derived — mirroring main.ts's real bootstrap order
  // (mirrors Account.billing.test.ts's mountAccount helper).
  await loadLang("en");
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(Pricing, { target });
  // Let onMount's async fetch()+json() chain resolve (a real macrotask tick
  // clears every microtask queued by the mock's async/await layers), then
  // flush the resulting $state write into the DOM.
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

beforeEach(() => {
  // jsdom logs (but doesn't throw on) `location.href =`; stub it so the real
  // checkout-redirect assignment is observable without a jsdom navigation error.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { href: "" },
  });
});

afterEach(() => {
  if (app) unmount(app as never);
  target?.remove();
  vi.unstubAllGlobals();
});

describe("Pricing", () => {
  it("renders all tiers from /api/plans", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe("/api/plans");
      return { ok: true, status: 200, json: async () => TIERS };
    }) as unknown as typeof fetch);

    await mountPricing();

    expect(target.textContent).toContain("Free");
    expect(target.textContent).toContain("Pro");
    expect(target.textContent).toContain("Enterprise");
  });

  it("toggle switches the displayed price between monthly and yearly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => TIERS })) as unknown as typeof fetch);
    await mountPricing();

    expect(target.textContent).toContain("$9.00");
    expect(target.textContent).not.toContain("$90.00");

    const yearlyBtn = Array.from(target.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Yearly")!;
    yearlyBtn.click();
    flushSync();

    expect(target.textContent).toContain("$90.00");
    expect(target.textContent).not.toContain("$9.00");
  });

  it("free tier shows no upgrade button", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => TIERS })) as unknown as typeof fetch);
    await mountPricing();

    const tierCards = Array.from(target.querySelectorAll(".tier"));
    const freeCard = tierCards.find((c) => c.textContent?.includes("Free"))!;
    expect(freeCard.querySelector("button.btn-primary")).toBeNull();
  });

  it("disables the non-purchasable tier's Upgrade button", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => TIERS })) as unknown as typeof fetch);
    await mountPricing();

    const tierCards = Array.from(target.querySelectorAll(".tier"));
    const enterpriseCard = tierCards.find((c) => c.textContent?.includes("Enterprise"))!;
    const btn = enterpriseCard.querySelector("button.btn-primary") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(true);
    expect(enterpriseCard.textContent).toContain("Not available yet");
  });

  it("clicking the purchasable tier's Upgrade POSTs checkout with {planId, cycle} and redirects", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/plans") return { ok: true, status: 200, json: async () => TIERS };
      if (url === "/api/billing/checkout") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(init!.body as string)).toEqual({ planId: "pro", cycle: "monthly" });
        return { ok: true, status: 200, json: async () => ({ url: "https://checkout.stripe.com/session/abc" }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    await mountPricing();

    const tierCards = Array.from(target.querySelectorAll(".tier"));
    const proCard = tierCards.find((c) => c.textContent?.includes("Pro"))!;
    const btn = proCard.querySelector("button.btn-primary") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    expect(fetchMock).toHaveBeenCalledWith("/api/billing/checkout", expect.objectContaining({ method: "POST" }));
    expect(window.location.href).toBe("https://checkout.stripe.com/session/abc");
  });

  it("shows a sign-in message on 401 instead of navigating", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/plans") return { ok: true, status: 200, json: async () => TIERS };
      if (url === "/api/billing/checkout") return { ok: false, status: 401, json: async () => ({}) };
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    await mountPricing();

    const tierCards = Array.from(target.querySelectorAll(".tier"));
    const proCard = tierCards.find((c) => c.textContent?.includes("Pro"))!;
    const btn = proCard.querySelector("button.btn-primary") as HTMLButtonElement;
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    expect(target.textContent).toContain("Sign in to upgrade");
    expect(window.location.href).toBe("");
  });

  it("a subscribed user upgrades via a previewed change-plan modal (not checkout) and sees their current tier", async () => {
    const SUB_TIERS = [
      { id: "free", name: "Free", storageBytes: 1e9, trafficBytes: 1e9, retentionSecs: 86400, priceMonthly: 0, priceYearly: 0, purchasableMonthly: false, purchasableYearly: false },
      { id: "plus", name: "Plus", storageBytes: 5e9, trafficBytes: 3e11, retentionSecs: 30 * 86400, priceMonthly: 390, priceYearly: 2900, purchasableMonthly: true, purchasableYearly: true },
      { id: "pro", name: "Pro", storageBytes: 5e10, trafficBytes: 1e12, retentionSecs: 90 * 86400, priceMonthly: 890, priceYearly: 7900, purchasableMonthly: true, purchasableYearly: true },
    ];
    const subUser = { id: "u1", email: "sub@example.com", displayName: "", hasPassword: true, planId: "plus", subscriptionStatus: "active", hasBilling: true };
    let changeBody: unknown = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/plans") return { ok: true, status: 200, json: async () => SUB_TIERS };
      if (url === "/api/me") return { ok: true, status: 200, json: async () => ({ user: subUser }) };
      if (url === "/api/billing/preview") {
        return { ok: true, status: 200, json: async () => ({ effective: "now", immediateChargeCents: 500, nextAmountCents: 890, nextCycle: "monthly", effectiveDate: 1789999999 }) };
      }
      if (url === "/api/billing/change-plan") { changeBody = JSON.parse(init!.body as string); return { ok: true, status: 200, json: async () => ({ status: "ok" }) }; }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    // Seed the session store as a live Plus subscriber before mounting.
    const { refreshSession } = await import("./auth.svelte");
    await refreshSession();

    await mountPricing();

    const cards = Array.from(target.querySelectorAll(".tier"));
    const plusCard = cards.find((c) => c.textContent?.includes("Plus"))!;
    const proCard = cards.find((c) => c.textContent?.includes("Pro"))!;

    // Their current tier shows a "Current plan" badge and no action button.
    expect(plusCard.textContent).toContain("Current plan");
    expect(plusCard.querySelector("button.btn-primary")).toBeNull();

    // The higher tier offers an Upgrade that opens the previewed change-plan
    // modal (in-app), not a fresh checkout.
    const upBtn = proCard.querySelector("button.btn-primary") as HTMLButtonElement;
    expect(upBtn.textContent?.trim()).toBe("Upgrade");
    upBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    expect(fetchMock).toHaveBeenCalledWith("/api/billing/preview", expect.objectContaining({ method: "POST" }));

    // Confirming inside the modal is what actually hits change-plan.
    const confirmBtn = Array.from(target.querySelectorAll(".modal button")).find((b) => b.textContent?.trim() === "Confirm change") as HTMLButtonElement;
    expect(confirmBtn).toBeTruthy();
    confirmBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    expect(fetchMock).toHaveBeenCalledWith("/api/billing/change-plan", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/billing/checkout", expect.anything());
    expect(changeBody).toEqual({ planId: "pro", cycle: "monthly" });
  });

  it("defaults the cycle toggle to the subscriber's current cycle", async () => {
    const SUB_TIERS = [
      { id: "free", name: "Free", storageBytes: 1e9, trafficBytes: 1e9, retentionSecs: 86400, priceMonthly: 0, priceYearly: 0, purchasableMonthly: false, purchasableYearly: false },
      { id: "plus", name: "Plus", storageBytes: 5e9, trafficBytes: 3e11, retentionSecs: 30 * 86400, priceMonthly: 390, priceYearly: 2900, purchasableMonthly: true, purchasableYearly: true },
    ];
    const subUser = { id: "u1", email: "sub@example.com", displayName: "", hasPassword: true, planId: "plus", subscriptionStatus: "active", hasBilling: true, billingCycle: "yearly" };
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/plans") return { ok: true, status: 200, json: async () => SUB_TIERS };
      if (url === "/api/me") return { ok: true, status: 200, json: async () => ({ user: subUser }) };
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    // Seed the session store as a live yearly Plus subscriber before mounting.
    const { refreshSession } = await import("./auth.svelte");
    await refreshSession();

    await mountPricing();

    const yearlyBtn = [...target.querySelectorAll(".toggle-btn")].find((b) => /year/i.test(b.textContent ?? ""));
    expect(yearlyBtn?.classList.contains("active")).toBe(true);
  });

  it("shows a pending-downgrade banner and cancels it via cancel-scheduled-change", async () => {
    const TIERS2 = [
      { id: "free", name: "Free", storageBytes: 1e9, trafficBytes: 1e9, retentionSecs: 86400, priceMonthly: 0, priceYearly: 0, purchasableMonthly: false, purchasableYearly: false },
      { id: "plus", name: "Plus", storageBytes: 5e9, trafficBytes: 3e11, retentionSecs: 30 * 86400, priceMonthly: 390, priceYearly: 2900, purchasableMonthly: true, purchasableYearly: true },
      { id: "pro", name: "Pro", storageBytes: 5e10, trafficBytes: 1e12, retentionSecs: 90 * 86400, priceMonthly: 890, priceYearly: 7900, purchasableMonthly: true, purchasableYearly: true },
    ];
    // On Pro, with a pending downgrade to Plus.
    let meUser: Record<string, unknown> = { id: "u1", email: "s@example.com", displayName: "", hasPassword: true, planId: "pro", subscriptionStatus: "active", hasBilling: true, scheduledPlanId: "plus" };
    let cancelCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/plans") return { ok: true, status: 200, json: async () => TIERS2 };
      if (url === "/api/me") return { ok: true, status: 200, json: async () => ({ user: meUser }) };
      if (url === "/api/billing/cancel-scheduled-change") { cancelCalls++; meUser = { ...meUser, scheduledPlanId: "" }; return { ok: true, status: 200, json: async () => ({ status: "ok" }) }; }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { refreshSession } = await import("./auth.svelte");
    await refreshSession();
    await mountPricing();

    // Banner names the scheduled tier; the Plus card shows a "Scheduled" badge.
    expect(target.querySelector(".sched-banner")?.textContent).toContain("Plus");
    const plusCard = Array.from(target.querySelectorAll(".tier")).find((c) => c.textContent?.includes("Plus"))!;
    expect(plusCard.textContent).toContain("Scheduled");

    // "Keep current plan" cancels the pending downgrade.
    const keepBtn = Array.from(target.querySelectorAll(".sched-banner button")).find((b) => b.textContent?.trim() === "Keep current plan") as HTMLButtonElement;
    expect(keepBtn).toBeTruthy();
    keepBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    expect(cancelCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/billing/cancel-scheduled-change", expect.objectContaining({ method: "POST" }));
  });
});
