import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Pricing from "./Pricing.svelte";

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
});
