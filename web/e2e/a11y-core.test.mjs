import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyAllowlist, loadAllowlist, parseExpiry } from "./a11y-core.mjs";

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

describe("scanner target readiness", () => {
  it("waits for the landing page's lazy content, not only its eager workspace", () => {
    // On localhost the dynamic chunk often arrives before axe starts, which made
    // `.lan-workspace` look sufficient. Production proved it was a timing race:
    // the same scan omitted the whole below-the-fold component and 36 decisions.
    const source = readFileSync(join(import.meta.dirname, "a11y-scan.mjs"), "utf8");
    for (const id of ["spa/landing/desktop-light", "spa/landing/mobile-dark"]) {
      expect(source).toMatch(new RegExp(`id: "${id}"[^\\n]+ready: "#home-text-title"`));
    }
  });
});
