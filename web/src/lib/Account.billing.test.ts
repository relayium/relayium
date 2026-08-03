import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import Account from "./Account.svelte";
import { loadLang } from "./i18n.svelte";

const FREE_USER = {
  id: "u1", email: "free@example.com", displayName: "Free",
  hasPassword: true, emailVerified: true, onlyOwnNodes: false,
  planId: "free", subscriptionStatus: "", subscriptionEnd: 0, hasBilling: false,
};

const PRO_USER = {
  id: "u2", email: "pro@example.com", displayName: "Pro",
  hasPassword: true, emailVerified: true, onlyOwnNodes: false,
  planId: "pro", subscriptionStatus: "active", subscriptionEnd: 1234567890, hasBilling: true,
};

const PLAN_TIERS = [
  { id: "free", name: "Free", storageBytes: 1, trafficBytes: 1, retentionSecs: 86400, priceMonthly: 0, priceYearly: 0, purchasableMonthly: false, purchasableYearly: false },
  { id: "pro", name: "Pro", storageBytes: 1, trafficBytes: 1, retentionSecs: 86400, priceMonthly: 900, priceYearly: 9000, purchasableMonthly: true, purchasableYearly: true },
];

let target: HTMLDivElement;
let app: unknown;
// The "Manage billing" redirect test stubs `window.location` wholesale (jsdom
// throws "not implemented: navigation" on a real `location.href =` to a
// foreign origin) — capture the real descriptor so it can be restored, or
// later tests that read location.search after a real history.replaceState
// would observe the frozen stub instead.
const realLocationDescriptor = Object.getOwnPropertyDescriptor(window, "location")!;

function baseFetchMock(user: unknown) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/auth/methods") return { ok: true, status: 200, json: async () => ({ password: true, google: false, magic: false }) };
    if (url === "/api/me") return { ok: true, status: 200, json: async () => ({ user }) };
    if (url === "/api/devices") return { ok: true, status: 200, json: async () => ({}) };
    if (url === "/api/plans") return { ok: true, status: 200, json: async () => PLAN_TIERS };
    if (url === "/api/billing/portal") {
      expect(init?.method).toBe("POST");
      expect(init?.credentials).toBe("include");
      return { ok: true, status: 200, json: async () => ({ url: "https://billing.stripe.com/session/xyz" }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
}

async function mountAccount(openInitial = true) {
  // messages[lang()] must be populated before mount — Account.svelte reads it
  // synchronously in a $derived — mirroring main.ts's real bootstrap order.
  await loadLang("en");
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(Account, { target, props: { open: openInitial } });
  // onMount chains fetchAuthMethods() then refreshSession(), each an
  // await fetch()+json() pair — one macrotask tick drains the whole
  // microtask chain (mirrors Pricing.test.ts's mountPricing helper).
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

beforeEach(() => {
  history.replaceState(null, "", "/");
});

afterEach(() => {
  if (app) unmount(app as never);
  target?.remove();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", realLocationDescriptor);
  history.replaceState(null, "", "/");
});

describe("Account billing", () => {
  it("shows the current plan and an Upgrade control for a free user", async () => {
    vi.stubGlobal("fetch", baseFetchMock(FREE_USER));
    await mountAccount();

    expect(target.textContent).toContain("Free");
    const upgradeBtn = Array.from(target.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Upgrade");
    expect(upgradeBtn).toBeTruthy();
    expect(target.querySelector(".pricing")).toBeNull();

    upgradeBtn!.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    // Clicking Upgrade reveals the inline Pricing component (fetches /api/plans).
    expect(target.querySelector(".pricing")).not.toBeNull();
    expect(target.textContent).toContain("Pro");
  });

  // Pricing's second embedding. The a11y scan reaches exactly this state
  // (spa/cross-network/account-modal/pricing), so the tier heading level has to
  // be the same one /pricing pins — one component, one answer.
  it("renders the inline tier names as h2 inside the account dialog", async () => {
    vi.stubGlobal("fetch", baseFetchMock(FREE_USER));
    await mountAccount();

    const upgradeBtn = Array.from(target.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Upgrade");
    upgradeBtn!.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    const inline = target.querySelector(".pricing-inline")!;
    expect(inline).not.toBeNull();
    const names = Array.from(inline.querySelectorAll<HTMLElement>(".tier-name"));
    // Real cards, not the aria-hidden skeleton: the skeleton has no .tier-name.
    expect(names.map((n) => n.textContent)).toEqual(PLAN_TIERS.map((t) => t.name));
    expect(names.map((n) => n.tagName)).toEqual(PLAN_TIERS.map(() => "H2"));
    expect(inline.querySelectorAll("h3").length).toBe(0);
  });

  it("shows a Manage billing button for a subscribed user that POSTs the portal endpoint and redirects", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, href: "", search: "", pathname: "/", hash: "" },
    });
    vi.stubGlobal("fetch", baseFetchMock(PRO_USER));
    await mountAccount();

    expect(target.textContent).toContain("active");
    const manageBtn = Array.from(target.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Manage billing");
    expect(manageBtn).toBeTruthy();
    // Subscribed users also get an Upgrade/change-plan link (to the /pricing page),
    // but it must NOT reveal the inline free-user Pricing component here.
    const upgradeLink = Array.from(target.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Upgrade");
    expect(upgradeLink).toBeTruthy();
    expect(target.querySelector(".pricing")).toBeNull();

    manageBtn!.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    expect(window.location.href).toBe("https://billing.stripe.com/session/xyz");
  });

  it("shows an error message when the portal endpoint fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/auth/methods") return { ok: true, status: 200, json: async () => ({ password: true, google: false, magic: false }) };
      if (url === "/api/me") return { ok: true, status: 200, json: async () => ({ user: PRO_USER }) };
      if (url === "/api/devices") return { ok: true, status: 200, json: async () => ({}) };
      if (url === "/api/billing/portal") return { ok: false, status: 404, json: async () => ({}) };
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch);
    await mountAccount();

    const manageBtn = Array.from(target.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Manage billing");
    manageBtn!.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    expect(target.querySelector(".err")).not.toBeNull();
  });

  it("shows a success banner for ?billing=success and cleans the URL", async () => {
    history.replaceState(null, "", "/?billing=success&keep=1");
    vi.stubGlobal("fetch", baseFetchMock(FREE_USER));
    await mountAccount(false);

    expect(target.textContent).toMatch(/thanks|success|active/i);
    expect(location.search).toBe("?keep=1");
  });

  it("shows a cancel banner for ?billing=cancel", async () => {
    history.replaceState(null, "", "/?billing=cancel");
    vi.stubGlobal("fetch", baseFetchMock(FREE_USER));
    await mountAccount(false);

    expect(target.textContent).toMatch(/cancel/i);
    expect(location.search).toBe("");
  });
});
