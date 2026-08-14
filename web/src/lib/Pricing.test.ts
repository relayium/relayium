import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Pricing from "./Pricing.svelte";
import { setLang, type Lang } from "./i18n.svelte";
// The locale tables are code-split, so read the expected strings from the split
// modules directly rather than restating them here (a restated literal would
// drift from the translation the component actually renders).
import zh from "./i18n/zh";
import en from "./i18n/en";

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

async function mountPricing(code: Lang = "en") {
  // messages[lang()] must be populated *and current* before mount —
  // Pricing.svelte reads messages[lang()] synchronously in a $derived —
  // mirroring main.ts's real bootstrap order (mirrors Account.billing.test.ts's
  // mountAccount helper). setLang (which loads first, then switches) rather than
  // loadLang, so the locale cases actually change the rendered language.
  await setLang(code);
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

afterEach(async () => {
  if (app) unmount(app as never);
  target?.remove();
  vi.unstubAllGlobals();
  // setLang is module-global (and sets <html lang/dir>); leaving Arabic behind
  // would silently flip every later test's language and document direction.
  await setLang("en");
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

  // ── First-viewport asynchronous states ─────────────────────────────────────
  // Pricing now sits above the fold on /pricing, so "waiting on /api/plans" and
  // "/api/plans failed" are things a visitor actually looks at. Neither may
  // render as a blank decision area.

  it("while /api/plans is pending, renders decorative skeletons and one localized loading status", async () => {
    // A promise that never settles == the request still in flight.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})) as unknown as typeof fetch);
    await mountPricing();

    const status = target.querySelector('[role="status"]');
    expect(status, "a pending load must announce itself").not.toBeNull();
    expect(status!.textContent?.trim()).toBe(en.billing.loadingPlans);

    const skeletons = target.querySelectorAll(".tier-skeleton");
    expect(skeletons.length, "skeletons keep the tier grid's footprint").toBe(4);
    // Decorative: hidden from the accessibility tree and holding nothing
    // focusable, so the status line is the only announced loading content.
    expect(skeletons[0].closest(".tiers")?.getAttribute("aria-hidden")).toBe("true");
    expect(target.querySelectorAll(".tiers button, .tiers a, .tiers input, .tiers [tabindex]").length).toBe(0);

    // And no real tier card is claiming to be a plan yet.
    expect(target.querySelectorAll(".tier:not(.tier-skeleton)").length).toBe(0);

    // The cycle control is usable throughout — it is not gated on the fetch.
    expect(target.querySelectorAll(".toggle-btn").length).toBe(2);
  });

  it("removes the skeletons and the loading status once the plans land", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => TIERS })) as unknown as typeof fetch);
    await mountPricing();

    expect(target.querySelectorAll(".tier-skeleton").length).toBe(0);
    expect(target.querySelector('[role="status"]')).toBeNull();
    expect(target.querySelectorAll(".tier").length).toBe(TIERS.length);
    expect(target.querySelector(".err")).toBeNull();
  });

  it("on a failed /api/plans, shows a danger callout instead of an empty or skeleton grid", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch);
    await mountPricing();

    const err = target.querySelector(".err");
    expect(err, "a failed plan load must be explained").not.toBeNull();
    expect(err!.textContent).toBe(en.billing.loadError);
    expect(err!.classList.contains("ui-callout")).toBe(true);
    expect(err!.classList.contains("ui-callout-danger")).toBe(true);
    expect(err!.getAttribute("role")).toBe("alert");

    // Neither a stuck skeleton nor a silent empty grid survives the failure.
    expect(target.querySelectorAll(".tier-skeleton").length).toBe(0);
    expect(target.querySelector(".tiers")).toBeNull();
    expect(target.querySelector('[role="status"]')).toBeNull();
  });

  it("recovers the same way when the plans request rejects outright (offline)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch);
    await mountPricing();

    expect(target.querySelector(".err")?.textContent).toBe(en.billing.loadError);
    expect(target.querySelectorAll(".tier-skeleton").length).toBe(0);
    expect(target.querySelector(".tiers")).toBeNull();
  });

  it("treats a successful but empty active-plan response as an announced failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })) as unknown as typeof fetch);
    await mountPricing();

    const alert = target.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(en.billing.loadError);
    expect(target.querySelectorAll(".tier-skeleton")).toHaveLength(0);
    expect(target.querySelector(".tiers")).toBeNull();
  });

  // ── Billing-cycle accessibility ────────────────────────────────────────────

  it("names the cycle group from the locale table, not a hard-coded English string", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => TIERS })) as unknown as typeof fetch);
    await mountPricing("zh");

    const group = target.querySelector('[role="group"]')!;
    expect(group.getAttribute("aria-label")).toBe(zh.billing.cycleLabel);
    // Regression guard: this attribute used to be the literal "Billing cycle"
    // in every locale.
    expect(group.getAttribute("aria-label")).not.toBe("Billing cycle");
    expect(zh.billing.cycleLabel).not.toBe(en.billing.cycleLabel);
  });

  it("exposes the selected cycle as aria-pressed on both buttons, and flips it on click", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => TIERS })) as unknown as typeof fetch);
    await mountPricing();

    const [monthlyBtn, yearlyBtn] = Array.from(target.querySelectorAll<HTMLButtonElement>(".toggle-btn"));
    expect(monthlyBtn.getAttribute("aria-pressed")).toBe("true");
    expect(yearlyBtn.getAttribute("aria-pressed")).toBe("false");

    yearlyBtn.click();
    flushSync();

    expect(monthlyBtn.getAttribute("aria-pressed")).toBe("false");
    expect(yearlyBtn.getAttribute("aria-pressed")).toBe("true");
    // aria-pressed stays in step with the class the visual state is drawn from.
    expect(yearlyBtn.classList.contains("active")).toBe(true);
    expect(monthlyBtn.classList.contains("active")).toBe(false);
  });

  // ── Bidi isolation ─────────────────────────────────────────────────────────

  // The isolate exists FOR an RTL locale, and neither maintained language is RTL
  // since the 2026-08-14 freeze — so this now mounts a maintained locale and
  // asserts the isolate is there regardless. That is the property worth keeping:
  // the <bdi dir="ltr"> is what makes the amount safe the day a locale that
  // needs it is restored, and it is exactly the kind of markup that gets
  // "simplified" away once nothing renders right to left.
  it("isolates the USD amount in an LTR bdi so it cannot reorder in an RTL locale", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => TIERS })) as unknown as typeof fetch);
    await mountPricing("zh");

    const proCard = Array.from(target.querySelectorAll(".tier")).find((c) => c.textContent?.includes("Pro"))!;
    const amount = proCard.querySelector(".tier-price bdi")!;
    expect(amount, "the price amount must be its own bidi isolate").not.toBeNull();
    expect(amount.tagName.toLowerCase()).toBe("bdi");
    expect(amount.getAttribute("dir")).toBe("ltr");
    // Sign, digits and decimal separator all inside the isolate — nothing of the
    // amount leaks into the surrounding RTL run.
    expect(amount.textContent).toBe("$9.00");

    // The per-cycle suffix is the localized string, outside the isolate.
    expect(proCard.querySelector(".tier-suffix")?.textContent?.trim()).toBe(zh.billing.perMonth);
    // The popular marker is still rendered in RTL (it is placed with logical
    // properties, so it moves rather than disappears).
    expect(proCard.querySelector(".ribbon")?.textContent?.trim()).toBe(zh.billing.popular);
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

  it("the cycle the price is displayed at is the cycle checkout is asked for", async () => {
    // The toggle is only honest if the same state drives both the number the
    // visitor read and the request Stripe receives.
    let sentBody: unknown = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/plans") return { ok: true, status: 200, json: async () => TIERS };
      if (url === "/api/billing/checkout") {
        sentBody = JSON.parse(init!.body as string);
        return { ok: true, status: 200, json: async () => ({ url: "https://checkout.stripe.com/session/yr" }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    await mountPricing();

    const yearlyBtn = Array.from(target.querySelectorAll<HTMLButtonElement>(".toggle-btn")).find((b) => b.textContent?.trim() === "Yearly")!;
    yearlyBtn.click();
    flushSync();

    const proCard = Array.from(target.querySelectorAll(".tier")).find((c) => c.textContent?.includes("Pro"))!;
    expect(proCard.querySelector(".tier-price bdi")?.textContent).toBe("$90.00");
    expect(proCard.querySelector(".tier-suffix")?.textContent?.trim()).toBe(en.billing.perYear);

    (proCard.querySelector("button.btn-primary") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    expect(sentBody).toEqual({ planId: "pro", cycle: "yearly" });
    expect(window.location.href).toBe("https://checkout.stripe.com/session/yr");
  });

  it("ignores a second Upgrade click while the first checkout is still in flight", async () => {
    // busyPlanId is the re-entry guard: without it a double-click starts two
    // Stripe Checkout sessions for the same plan.
    let checkoutCalls = 0;
    let release = () => {};
    const gate = new Promise<void>((r) => { release = () => r(); });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/plans") return { ok: true, status: 200, json: async () => TIERS };
      if (url === "/api/billing/checkout") {
        checkoutCalls++;
        await gate; // hold the request open so a second click lands mid-flight
        return { ok: true, status: 200, json: async () => ({ url: "https://checkout.stripe.com/session/abc" }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    await mountPricing();

    const proCard = Array.from(target.querySelectorAll(".tier")).find((c) => c.textContent?.includes("Pro"))!;
    const btn = proCard.querySelector("button.btn-primary") as HTMLButtonElement;
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    // The in-flight tier's button is disabled, and a click on it is a no-op.
    expect(btn.disabled).toBe(true);
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(checkoutCalls).toBe(1);

    release();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
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
    expect(target.querySelector('[role="alert"]')?.textContent).toContain("Sign in to upgrade");
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

  it("a subscribed user downgrades via the previewed modal, sees the period-end summary (no immediate charge), and gets a success toast on confirm", async () => {
    const SUB_TIERS = [
      { id: "free", name: "Free", storageBytes: 1e9, trafficBytes: 1e9, retentionSecs: 86400, priceMonthly: 0, priceYearly: 0, purchasableMonthly: false, purchasableYearly: false },
      { id: "plus", name: "Plus", storageBytes: 5e9, trafficBytes: 3e11, retentionSecs: 30 * 86400, priceMonthly: 390, priceYearly: 2900, purchasableMonthly: true, purchasableYearly: true },
      { id: "pro", name: "Pro", storageBytes: 5e10, trafficBytes: 1e12, retentionSecs: 90 * 86400, priceMonthly: 890, priceYearly: 7900, purchasableMonthly: true, purchasableYearly: true },
    ];
    // On Pro, so Plus (a lower tier) is a downgrade.
    const subUser = { id: "u1", email: "sub@example.com", displayName: "", hasPassword: true, planId: "pro", subscriptionStatus: "active", hasBilling: true };
    let changeBody: unknown = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/plans") return { ok: true, status: 200, json: async () => SUB_TIERS };
      if (url === "/api/me") return { ok: true, status: 200, json: async () => ({ user: subUser }) };
      if (url === "/api/billing/preview") {
        return { ok: true, status: 200, json: async () => ({ effective: "period_end", immediateChargeCents: 0, nextAmountCents: 390, nextCycle: "monthly", effectiveDate: 1789999999 }) };
      }
      if (url === "/api/billing/change-plan") { changeBody = JSON.parse(init!.body as string); return { ok: true, status: 200, json: async () => ({ status: "ok" }) }; }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    // Seed the session store as a live Pro subscriber before mounting.
    const { refreshSession } = await import("./auth.svelte");
    await refreshSession();

    await mountPricing();

    const cards = Array.from(target.querySelectorAll(".tier"));
    const plusCard = cards.find((c) => c.textContent?.includes("Plus"))!;
    const proCard = cards.find((c) => c.textContent?.includes("Pro"))!;

    expect(proCard.textContent).toContain("Current plan");

    // The lower tier offers a Downgrade that opens the previewed change-plan modal.
    const downBtn = plusCard.querySelector("button.btn-primary") as HTMLButtonElement;
    expect(downBtn.textContent?.trim()).toBe("Downgrade");
    downBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    expect(fetchMock).toHaveBeenCalledWith("/api/billing/preview", expect.objectContaining({ method: "POST" }));

    // Downgrade preview: period-end summary text, no immediate-charge wording.
    const modalText = target.querySelector(".modal")?.textContent ?? "";
    expect(modalText).toContain("period end");
    expect(modalText).not.toContain("charged");

    // Confirming inside the modal is what actually hits change-plan.
    const confirmBtn = Array.from(target.querySelectorAll(".modal button")).find((b) => b.textContent?.trim() === "Confirm change") as HTMLButtonElement;
    expect(confirmBtn).toBeTruthy();
    confirmBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    expect(fetchMock).toHaveBeenCalledWith("/api/billing/change-plan", expect.objectContaining({ method: "POST" }));
    expect(changeBody).toEqual({ planId: "plus", cycle: "monthly" });

    // onModalClose(true) closes the modal and surfaces the success toast — the
    // actual wiring point this test exists to cover.
    expect(target.querySelector(".modal")).toBeNull();
    expect(target.textContent).toContain("Plan updated — thanks!");
    expect(target.querySelector('.ok-note[role="status"]')?.textContent).toContain("Plan updated — thanks!");
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

  it("a subscribed user gets a Downgrade-to-Free button on the free tier that opens the billing portal", async () => {
    // The bug: the Free tier card was dead for subscribers — just the word
    // "Free", no button — so a paid user had no way to leave from the page they'd
    // naturally look on. Downgrading to Free is a cancellation (Free has no Stripe
    // price), so the button routes to the Stripe portal, where the cancel lives.
    const SUB_TIERS = [
      { id: "free", name: "Free", storageBytes: 1e9, trafficBytes: 1e9, retentionSecs: 86400, priceMonthly: 0, priceYearly: 0, purchasableMonthly: false, purchasableYearly: false },
      { id: "plus", name: "Plus", storageBytes: 5e9, trafficBytes: 3e11, retentionSecs: 30 * 86400, priceMonthly: 390, priceYearly: 2900, purchasableMonthly: true, purchasableYearly: true },
    ];
    const subUser = { id: "u1", email: "sub@example.com", displayName: "", hasPassword: true, planId: "plus", subscriptionStatus: "active", hasBilling: true };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/plans") return { ok: true, status: 200, json: async () => SUB_TIERS };
      if (url === "/api/me") return { ok: true, status: 200, json: async () => ({ user: subUser }) };
      if (url === "/api/billing/portal") {
        expect(init?.method).toBe("POST");
        return { ok: true, status: 200, json: async () => ({ url: "https://billing.stripe.com/session/xyz" }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { refreshSession } = await import("./auth.svelte");
    await refreshSession();
    await mountPricing();

    const freeCard = Array.from(target.querySelectorAll(".tier")).find((c) => c.textContent?.includes("Free"))!;
    const btn = Array.from(freeCard.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Downgrade to Free") as HTMLButtonElement;
    expect(btn, "Free tier must offer a Downgrade-to-Free action to subscribers").toBeTruthy();

    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    expect(fetchMock).toHaveBeenCalledWith("/api/billing/portal", expect.objectContaining({ method: "POST" }));
    expect(window.location.href).toBe("https://billing.stripe.com/session/xyz");
  });
});
