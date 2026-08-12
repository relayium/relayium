// An entitlement bought somewhere other than this site (today: the App Store)
// must render as SUBSCRIBED here, with no Stripe management action and no
// invitation to subscribe again. Every Stripe call this page can make is
// refused server-side for such an account — checkout returns 409
// already_subscribed and change-plan/preview return 409 managed_by_provider —
// so a button that survived here would be a button that cannot work, and
// "Upgrade" would be an invitation to pay twice.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Pricing from "./Pricing.svelte";
import Account from "./Account.svelte";
import { refreshSession } from "./auth.svelte";
import { setLang } from "./i18n.svelte";
import en from "./i18n/en";

const TIERS = [
  { id: "free", name: "Free", storageBytes: 1e9, trafficBytes: 1e9, retentionSecs: 86400, priceMonthly: 0, priceYearly: 0, purchasableMonthly: false, purchasableYearly: false },
  { id: "plus", name: "Plus", storageBytes: 5e9, trafficBytes: 3e11, retentionSecs: 30 * 86400, priceMonthly: 390, priceYearly: 2900, purchasableMonthly: true, purchasableYearly: true },
  { id: "pro", name: "Pro", storageBytes: 5e10, trafficBytes: 1e12, retentionSecs: 90 * 86400, priceMonthly: 890, priceYearly: 7900, purchasableMonthly: true, purchasableYearly: true },
];

let target: HTMLDivElement;
let app: unknown;

async function mountPricingAs(user: Record<string, unknown>) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/plans") return { ok: true, status: 200, json: async () => TIERS };
    if (url === "/api/me") return { ok: true, status: 200, json: async () => ({ user }) };
    // Answered rather than thrown so a Stripe scheduled-change action is
    // exercised end to end where it belongs — and so a page that reached for it
    // where it does NOT belong shows up as a recorded call, not an exception.
    if (url === "/api/billing/cancel-scheduled-change") return { ok: true, status: 200, json: async () => ({}) };
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  await refreshSession();
  await setLang("en");
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(Pricing, { target });
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  return fetchMock;
}

const buttonLabels = () => [...target.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");

afterEach(async () => {
  if (app) unmount(app as never);
  app = null;
  target?.remove();
  vi.unstubAllGlobals();
  await setLang("en");
});

describe("Pricing with a non-Stripe entitlement", () => {
  it("an App Store subscriber sees their tier and where to manage it, with no purchase or portal action", async () => {
    await mountPricingAs({
      id: "u1", email: "apple@example.com", displayName: "", hasPassword: true,
      planId: "pro", subscriptionStatus: "active", hasBilling: false,
      entitlementProvider: "apple",
    });

    expect(target.querySelector('[data-testid="managed-elsewhere"]')?.textContent?.trim())
      .toBe(en.billing.appleManagedNote);
    // Still recognizably subscribed: the tier they hold is badged as current.
    expect(target.textContent).toContain(en.billing.current);
    expect(target.textContent).toContain(en.billing.appleManagedBadge);

    const labels = buttonLabels();
    // The two cycle toggles are the only controls left. Anything that would
    // start a purchase or open the Stripe portal must be gone.
    for (const gone of [en.billing.upgrade, en.billing.downgrade, en.billing.downgradeToFree,
      en.billing.switchToYearly, en.billing.switchToMonthly]) {
      expect(labels).not.toContain(gone);
    }
  });

  it("switching the cycle toggle still offers no action to an App Store subscriber", async () => {
    // The tier the user holds stops matching `relation === "current"` once the
    // cycle differs, which is exactly the branch that used to fall through to a
    // "Switch to yearly" button wired to checkout.
    await mountPricingAs({
      id: "u1", email: "apple@example.com", displayName: "", hasPassword: true,
      planId: "pro", subscriptionStatus: "active", hasBilling: false,
      entitlementProvider: "apple", billingCycle: "monthly",
    });
    const yearly = [...target.querySelectorAll("button")].find((b) => b.textContent?.trim() === en.billing.yearly)!;
    yearly.click();
    flushSync();

    const labels = buttonLabels();
    expect(labels).not.toContain(en.billing.switchToYearly);
    expect(labels).not.toContain(en.billing.upgrade);
    expect(target.textContent).toContain(en.billing.appleManagedBadge);
  });

  it("a subscriber on two providers is told so, and is offered neither side's controls here", async () => {
    await mountPricingAs({
      id: "u1", email: "both@example.com", displayName: "", hasPassword: true,
      planId: "pro", subscriptionStatus: "active", hasBilling: true,
      entitlementProvider: "multiple",
    });

    expect(target.querySelector('[data-testid="managed-elsewhere"]')?.textContent?.trim())
      .toBe(en.billing.multipleProvidersNote);
    const labels = buttonLabels();
    expect(labels).not.toContain(en.billing.upgrade);
    expect(labels).not.toContain(en.billing.downgradeToFree);
  });

  // A pending period-end downgrade is Stripe's own state, and it can outlive the
  // Stripe subscription that created it — an account that later buys through the
  // App Store still carries the stale scheduled_plan_id. "Keep current plan"
  // calls cancel-scheduled-change, which for a non-Stripe entitlement can only
  // answer 409 managed_by_provider, so offering it is offering a button whose
  // one possible outcome is an error.
  for (const provider of ["apple", "multiple"] as const) {
    it(`offers no scheduled-change action to a ${provider} subscriber carrying a stale schedule`, async () => {
      const fetchMock = await mountPricingAs({
        id: "u1", email: `${provider}@example.com`, displayName: "", hasPassword: true,
        planId: "pro", subscriptionStatus: "active", hasBilling: provider === "multiple",
        entitlementProvider: provider, scheduledPlanId: "plus",
      });

      expect(buttonLabels()).not.toContain(en.billing.keepCurrentPlan);
      // Nor the read-only half of the same Stripe claim: a "Scheduled" badge on a
      // tier this account is not scheduled to move to is a false statement, and
      // the managed-elsewhere note is the truthful thing in its place.
      expect(target.textContent).not.toContain(en.billing.scheduledNote("Plus"));
      expect(target.textContent).not.toContain(en.billing.scheduledBadge);
      expect(target.textContent).toContain(en.billing.appleManagedBadge);

      const requested = fetchMock.mock.calls.map((c) => c[0]);
      expect(requested).not.toContain("/api/billing/cancel-scheduled-change");
    });
  }

  it("leaves an ordinary Stripe subscriber's scheduled-change control working", async () => {
    const fetchMock = await mountPricingAs({
      id: "u1", email: "stripe@example.com", displayName: "", hasPassword: true,
      planId: "pro", subscriptionStatus: "active", hasBilling: true,
      entitlementProvider: "stripe", scheduledPlanId: "plus",
    });
    expect(target.textContent).toContain(en.billing.scheduledNote("Plus"));
    expect(target.textContent).toContain(en.billing.scheduledBadge);

    const keep = [...target.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === en.billing.keepCurrentPlan)!;
    expect(keep).toBeTruthy();
    keep.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock.mock.calls.map((c) => c[0])).toContain("/api/billing/cancel-scheduled-change");
  });

  it("an ordinary Stripe subscriber is untouched by the provider gate", async () => {
    await mountPricingAs({
      id: "u1", email: "stripe@example.com", displayName: "", hasPassword: true,
      planId: "plus", subscriptionStatus: "active", hasBilling: true,
      entitlementProvider: "stripe",
    });
    expect(target.querySelector('[data-testid="managed-elsewhere"]')).toBeNull();
    expect(buttonLabels()).toContain(en.billing.upgrade);
    expect(target.textContent).not.toContain(en.billing.appleManagedBadge);
  });

  it("a payload with no entitlementProvider at all behaves exactly as before", async () => {
    // An older server (or an older cached response) simply omits the field. It
    // must not be read as "some other provider" — that would hide the purchase
    // path from every free user on the planet.
    await mountPricingAs({
      id: "u1", email: "legacy@example.com", displayName: "", hasPassword: true,
      planId: "free", subscriptionStatus: "", hasBilling: false,
    });
    expect(target.querySelector('[data-testid="managed-elsewhere"]')).toBeNull();
    expect(buttonLabels()).toContain(en.billing.upgrade);
  });
});

describe("Account panel with a non-Stripe entitlement", () => {
  async function mountAccountAs(user: Record<string, unknown>) {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/me") return { ok: true, status: 200, json: async () => ({ user }) };
      if (url === "/api/plans") return { ok: true, status: 200, json: async () => TIERS };
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch);
    await refreshSession();
    await setLang("en");
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(Account, { target });
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    // Open the account dialog: the billing section only exists inside it.
    const opener = target.querySelector("button.acct-btn") as HTMLButtonElement;
    opener.click();
    flushSync();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }

  it("offers no Upgrade or Manage billing to an App Store subscriber", async () => {
    await mountAccountAs({
      id: "u1", email: "apple@example.com", displayName: "", hasPassword: true,
      planId: "pro", subscriptionStatus: "active", hasBilling: false,
      entitlementProvider: "apple",
    });
    expect(target.querySelector('[data-testid="account-managed-elsewhere"]')?.textContent?.trim())
      .toBe(en.billing.appleManagedNote);
    const labels = buttonLabels();
    expect(labels).not.toContain(en.billing.upgrade);
    expect(labels).not.toContain(en.billing.manageBilling);
    expect(labels).not.toContain(en.billing.cancelSubscription);
  });

  it("leaves a Stripe subscriber's billing controls in place", async () => {
    await mountAccountAs({
      id: "u1", email: "stripe@example.com", displayName: "", hasPassword: true,
      planId: "pro", subscriptionStatus: "active", hasBilling: true,
      entitlementProvider: "stripe",
    });
    expect(target.querySelector('[data-testid="account-managed-elsewhere"]')).toBeNull();
    const labels = buttonLabels();
    expect(labels).toContain(en.billing.manageBilling);
    expect(labels).toContain(en.billing.cancelSubscription);
  });
});
