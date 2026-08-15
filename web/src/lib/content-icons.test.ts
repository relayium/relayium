import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "./i18n/en";
import zh from "./i18n/zh";

const locales = { en, zh };
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

  it("draws the six Device Inbox platform rows from the shared icon set too", () => {
    const data = source("device-inbox-platforms.ts");
    const page = source("DeviceInboxPage.svelte");
    const icon = source("Icon.svelte");
    const names = source("icon-name.ts");

    // The exact six that replaced 🖥️ 🐧 💻 🪟 📱 🤖, in the page's own order.
    // Form factors rather than OS logos: a rack, a workstation, a laptop, a
    // window, a phone and a robot stay legible as 21px strokes, and the
    // localized name beside each one is what actually identifies the platform.
    expect(data.match(/\n\s+icon: "(\w[\w-]*)",/g)?.map((m) => m.trim())).toEqual([
      'icon: "server",',
      'icon: "desktop",',
      'icon: "laptop",',
      'icon: "window",',
      'icon: "phone",',
      'icon: "robot",',
    ]);

    // Every name the data declares must be one Icon.svelte can actually draw.
    // Both halves are asserted: the exported union (so `check` fails on a typo)
    // and the render branch (so a name in the union with no geometry — a silent
    // empty <svg> — fails too).
    for (const name of [...data.matchAll(/\n\s+icon: "([\w-]+)",/g)].map((m) => m[1])) {
      expect(names, `IconName is missing "${name}"`).toContain(`| "${name}"`);
      expect(icon, `Icon.svelte draws nothing for "${name}"`).toContain(`name === "${name}"`);
    }

    // …and the row renders it decoratively, beside the name rather than as one.
    expect(page).toContain('<span class="g" aria-hidden="true"><Icon name={p.icon} /></span>');

    // Direction-neutral by construction rather than by a mirrored stylesheet:
    // the component takes no direction input and mirrors nothing, so the same
    // six marks are correct in an RTL document without a second rule anywhere.
    expect(icon).not.toMatch(/transform|scaleX|\bdir\b/);
    expect(page).not.toMatch(/\.g\s*\{[^}]*\b(?:left|right)\s*:/);

    // No emoji may come back into either file. A picture that changes per OS and
    // font, cannot take a design token, and has no stroke weight is what this
    // pair of files exists to keep out.
    for (const [where, src] of [["data", data], ["page", page]] as const) {
      expect(src.match(/\p{Extended_Pictographic}/gu) ?? [], `${where} regained an emoji`).toEqual([]);
    }
    expect(data).not.toContain("glyph");
  });

  it("keeps the stored-mode heading glyph in code rather than translations", () => {
    const offline = source("OfflinePage.svelte");
    expect(offline).toContain('<Icon name="package" size={18} />');
    for (const [code, messages] of Object.entries(locales)) {
      expect(messages.methods.stored.name, `${code}.methods.stored.name`).not.toContain("📦");
    }
  });
});
