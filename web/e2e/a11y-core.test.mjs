import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyAllowlist, loadAllowlist, parseExpiry } from "./a11y-core.mjs";
import { FREE_USER_ROUTES, PLANS, PRICING_ROUTES } from "./a11y-fixtures.mjs";
import { LOADED_TIERS, TARGETS } from "./a11y-targets.mjs";

const temporary = [];

function allowlist(entries) {
  const dir = mkdtempSync(join(tmpdir(), "relayium-a11y-allowlist-"));
  temporary.push(dir);
  const path = join(dir, "allowlist.json");
  writeFileSync(path, JSON.stringify({ entries }));
  return path;
}

const entry = (overrides = {}) => ({
  target: "spa/apps",
  rule: "color-contrast",
  selector: ".example",
  reason: "Tracked while the component is redesigned.",
  owner: "web",
  expires: "2026-08-31",
  ...overrides,
});

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("accessibility allowlist policy", () => {
  it.each([
    ["2024-02-29", true],
    ["2026-02-29", false],
    ["2026-02-31", false],
    ["2026-13-01", false],
    ["2026-1-01", false],
    [" 2026-08-31", false],
    ["2026-08-31T00:00:00Z", false],
  ])("validates the exact calendar date %s", (value, valid) => {
    expect(parseExpiry(value) instanceof Date).toBe(valid);
  });

  it("keeps an entry valid through its UTC expiry day and expires it afterwards", () => {
    const path = allowlist([entry({ expires: "2026-08-02" })]);
    expect(loadAllowlist(path, { today: new Date("2026-08-02T23:59:59.999Z") }).expired).toEqual([]);
    expect(loadAllowlist(path, { today: new Date("2026-08-03T00:00:00.000Z") }).expired).toHaveLength(1);
  });

  it.each([
    ["wildcard selector", entry({ selector: "*" })],
    ["multiple rules", entry({ rule: "color-contrast region" })],
    ["invalid calendar date", entry({ expires: "2026-02-31" })],
    ["unknown field", { ...entry(), ticket: "A11Y-1" }],
  ])("rejects a broad or malformed %s entry", (_name, value) => {
    expect(() => loadAllowlist(allowlist([value]))).toThrow(/invalid|too broad|single axe rule|calendar date|not a recognised field/);
  });

  it("matches one exact target, rule, and selector without claiming its neighbours", () => {
    const loaded = loadAllowlist(allowlist([entry()]));
    const violations = [{
      id: "color-contrast",
      nodes: [{ target: ".example" }, { target: ".other" }],
    }];

    const result = applyAllowlist("spa/apps", violations, loaded);

    expect(result.allowed).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].node.target).toBe(".other");
    expect(loaded.entries[0].matched).toBe(1);
  });
});

const target = (id) => {
  const found = TARGETS.find((t) => t.id === id);
  expect(found, `no scan target with id ${id}`).toBeTruthy();
  return found;
};

describe("scanner target readiness", () => {
  it("waits for the landing page's lazy content, not only its eager workspace", () => {
    // On localhost the dynamic chunk often arrives before axe starts, which made
    // `.lan-workspace` look sufficient. Production proved it was a timing race:
    // the same scan omitted the whole below-the-fold component and 36 decisions.
    for (const id of ["spa/landing/desktop-light", "spa/landing/mobile-dark"]) {
      expect(target(id).ready).toBe("#home-text-title");
    }
  });

  it("gives every target a ready selector and no fixed sleep", () => {
    for (const t of TARGETS) {
      expect(t.ready, `${t.id} has no ready selector`).toBeTruthy();
      for (const step of t.drive ?? []) {
        expect(step.click, `${t.id} drive step has no click`).toBeTruthy();
        expect(step.ready, `${t.id} drive step has no ready selector`).toBeTruthy();
      }
    }
  });

  it("scans standalone /pricing with real plans loaded, not the load-error shell", () => {
    // The defect this pins: `vite preview` serves no /api, so /pricing used to
    // stop at loadError and `.pricing-page` was still there — the scan reported
    // a clean pricing page while the four tier cards it exists to check had
    // never rendered. That is exactly where the h1 -> h3 heading skip lives.
    const pricing = target("spa/pricing");

    expect(pricing.fixture, "/pricing must stub /api/plans in the browser").toBe(PRICING_ROUTES);
    expect(pricing.fixture["/api/plans"].length).toBeGreaterThan(0);
    expect(pricing.ready).toContain(LOADED_TIERS);
    expect(pricing.ready).toContain(".pricing-page");
    // One card is not the grid: a selector satisfied by the first tier would go
    // green on a half-rendered page.
    expect(pricing.readyCount).toBe(PLANS.length);
  });

  it("drives the inline account pricing target all the way to real tier cards", () => {
    const inline = target("spa/cross-network/account-modal/pricing");

    // A signed-in FREE user is the only session that reaches this branch:
    // Account.svelte inlines <Pricing /> only when hasBilling is false.
    expect(inline.fixture).toBe(FREE_USER_ROUTES);
    expect(inline.fixture["/api/me"].user.hasBilling).toBe(false);
    expect(inline.fixture["/api/me"].user.planId).toBe("free");
    expect(inline.fixture["/api/auth/methods"]).toBeTruthy();

    // Two steps: open the account dialog, then expand the inline grid. The last
    // one must land on loaded tiers inside .pricing-inline — stopping at the
    // dialog would scan a modal that never showed a price.
    expect(inline.drive).toHaveLength(2);
    expect(inline.drive[0].ready).toContain(".billing-section");
    const last = inline.drive.at(-1);
    expect(last.ready).toContain(".pricing-inline");
    expect(last.ready).toContain(LOADED_TIERS);
    expect(last.readyCount).toBe(PLANS.length);
  });

  it("keeps the signed-out account dialog as its own target", () => {
    // Two embeddings, two contexts. The signed-out dialog is the login form; it
    // must not be quietly replaced by the signed-in one.
    const signedOut = target("spa/cross-network/account-modal");

    expect(signedOut.fixture).toBeUndefined();
    expect(signedOut.drive.at(-1).ready).toContain('[role="dialog"]');
  });

  it("only injects an API fixture where a target actually needs one", () => {
    // The fixture is per-tab (Page.addScriptToEvaluateOnNewDocument on that tab's
    // session), so it cannot leak sideways — but a target that quietly grew one
    // would stop scanning the real, backend-free page.
    const withFixture = TARGETS.filter((t) => t.fixture).map((t) => t.id);
    expect(withFixture).toEqual(["spa/pricing", "spa/cross-network/account-modal/pricing"]);
  });
});
