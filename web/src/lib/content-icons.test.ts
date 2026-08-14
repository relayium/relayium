import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "./i18n/en";
import zh from "./i18n/zh";
import ja from "./i18n/ja";
import ko from "./i18n/ko";
import de from "./i18n/de";
import fr from "./i18n/fr";
import ar from "./i18n/ar";
import es from "./i18n/es";
import pt from "./i18n/pt";

const locales = { en, zh, ja, ko, de, fr, ar, es, pt };
const source = (name: string) => readFileSync(join(import.meta.dirname, name), "utf8");

describe("content icon ownership", () => {
  it("keeps presentation fields out of every translated content item", () => {
    for (const [code, messages] of Object.entries(locales)) {
      for (const variant of ["realtime", "offline"] as const) {
        const ways = messages.howItWorks[variant].ways;
        expect(ways, `${code}.${variant}`).toHaveLength(3);
        expect(ways.some((way) => "icon" in way), `${code}.${variant}`).toBe(false);
      }
      expect(messages.useCases.items, `${code}.useCases`).toHaveLength(5);
      expect(messages.useCases.items.some((item) => "icon" in item), `${code}.useCases`).toBe(false);
    }
  });

  it("keeps fixed semantic maps next to their positional consumers", () => {
    const how = source("HowItWorks.svelte");
    expect(how).toContain('realtime: ["link", "pairing-code", "bolt"]');
    expect(how).toContain('offline: ["lock", "link", "download"]');
    expect(how).toContain('<Icon name={icons[variant][i]} size={24} />');

    const cases = source("UseCases.svelte");
    expect(cases).toContain('["globe", "clock", "devices", "lock", "message"]');
    expect(cases).toContain('<Icon name={CASE_ICONS[i]} size={22} />');

    const compare = source("ModeCompare.svelte");
    expect(compare).toContain('<Icon name="network" />');
    expect(compare).toContain('<Icon name="bolt" />');
    expect(compare).toContain('<Icon name="package" />');
  });

  it("uses logical, direction-neutral HowToSteps connectors and badge corners", () => {
    const howTo = source("HowToSteps.svelte");
    expect(howTo).toContain("inset-inline-end:");
    expect(howTo).toContain("inset-inline-start:");
    expect(howTo).not.toMatch(/\b(?:right|left)\s*:/);
    expect(howTo).not.toMatch(/\b(?:float|text-align)\s*:\s*(?:right|left)\b/);
    expect(howTo).not.toContain('content: "›"');
    expect(howTo.match(/<Icon name=\{s\.icon\}/g)).toHaveLength(1);
  });

  it("replaces the unreliable CLI network character with the shared glyph", () => {
    const cli = source("CliPage.svelte");
    const data = source("cli-page-data.ts");
    expect(`${cli}\n${data}`).not.toContain("🖧");
    expect(cli.match(/<Icon name="network" size=\{22\} \/>/g)).toHaveLength(3);
    expect(data.match(/(?:g|icon): "network"/g)).toHaveLength(2);
  });

  it("draws the Device Inbox hero mark from the shared icon set, not from an emoji", () => {
    const page = source("DeviceInboxPage.svelte");
    // An emoji here was a different picture per platform and font (and a tofu
    // box where the font had none), and it was the one product glyph on the page
    // that no design token could reach — it could not take the accent colour or
    // the narrow-viewport size the badge around it already had.
    expect(page).not.toContain("📥");
    expect(page).toContain('<div class="logo" aria-hidden="true"><Icon name="inbox" /></div>');
    // Decorative on purpose: the localized <h1> immediately below it is what
    // names this page, so a title or label here would be a second, untranslated
    // accessible name for the same thing.
    expect(page).toMatch(/<div class="logo" aria-hidden="true">[\s\S]*?<h1>\{t\.deviceInboxPage\.heading\}/);
  });

  it("keeps the stored-mode heading glyph in code rather than translations", () => {
    const offline = source("OfflinePage.svelte");
    expect(offline).toContain('<Icon name="package" size={18} />');
    for (const [code, messages] of Object.entries(locales)) {
      expect(messages.methods.stored.name, `${code}.methods.stored.name`).not.toContain("📦");
    }
  });
});
