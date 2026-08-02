// The three accent roles, checked as numbers instead of as intent.
//
// --accent is decorative (fills, rims, gradient stops) and is deliberately NOT
// required to clear a text threshold: it is 4.39:1 on white. That is exactly why
// the split exists, and exactly why it can rot silently — someone reaches for the
// brand colour, writes `color: var(--accent)`, and ships a link nobody can read.
// The numbers below come from parsing the real app.css, so a token edit that
// breaks AA fails here in milliseconds rather than in a browser scan later.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const libDir = resolve(import.meta.dirname);
const css = readFileSync(resolve(libDir, "..", "app.css"), "utf8");

function relativeLuminance(hex: string): number {
  // #fff has to become #ffffff first: a 3-char string yields one pair plus a
  // dropped character, and the missing channels turn every ratio into NaN —
  // which compares false against every threshold and passes nothing loudly.
  const raw = hex.replace("#", "");
  const full = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw;
  const channels = (full.match(/../g) ?? []).map((pair) => {
    const value = parseInt(pair, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * Reads a token out of one of app.css's three declaration blocks: the light
 * `:root`, the `prefers-color-scheme: dark` block, and the explicit
 * `[data-theme="dark"]` block. The last two must agree — a token defined in only
 * one of them leaves either "system dark" or "chose dark" on the light value,
 * and nobody notices because both look purple.
 */
function token(name: string): { light: string; dark: string[] } {
  const all = [...css.matchAll(new RegExp(`${name}:\\s*(#[0-9a-f]{3,8})`, "gi"))].map((m) => m[1]);
  expect(all.length, `${name} should be declared in the light root and both dark blocks`).toBe(3);
  return { light: all[0], dark: [all[1], all[2]] };
}

/**
 * The selector of the rule a given line sits in: the text before the `{` on that
 * same line if it opens one, otherwise the nearest `{` above it. Walking back to
 * the *nearest* brace matters — slicing a fixed window and splitting on the first
 * `{` picks up the preceding rule's selector instead of this one's.
 */
function openingSelector(lines: string[], index: number): string {
  const own = lines[index];
  if (own.includes("{")) return own.slice(0, own.indexOf("{"));
  for (let i = index - 1; i >= 0 && index - i < 12; i--) {
    if (lines[i].includes("{")) return lines[i].slice(0, lines[i].indexOf("{"));
  }
  return "";
}

const bg = token("--bg");
const accent = token("--accent");
const accentDeep = token("--accent-deep");
const accentFg = token("--accent-fg");
const accentAction = token("--accent-action");
const accentActionDeep = token("--accent-action-deep");
const okToken = token("--ok");
const surface = token("--surface");
const WHITE = "#ffffff";

const components = [
  ...readdirSync(libDir)
    .filter((name) => name.endsWith(".svelte"))
    .map((name) => ({ name, source: readFileSync(join(libDir, name), "utf8") })),
  { name: "App.svelte", source: readFileSync(resolve(libDir, "..", "App.svelte"), "utf8") },
];

describe("accent foreground token", () => {
  it("clears AA body text against its own theme background", () => {
    expect(contrast(accentFg.light, bg.light)).toBeGreaterThanOrEqual(4.5);
    for (const value of accentFg.dark) expect(contrast(value, bg.dark[0])).toBeGreaterThanOrEqual(4.5);
  });

  it("is declared identically in both dark blocks", () => {
    expect(accentFg.dark[0]).toBe(accentFg.dark[1]);
    expect(accentAction.dark[0]).toBe(accentAction.dark[1]);
  });
});

describe("accent action token", () => {
  it("carries white text at AA in both themes", () => {
    expect(contrast(WHITE, accentAction.light)).toBeGreaterThanOrEqual(4.5);
    for (const value of accentAction.dark) expect(contrast(WHITE, value)).toBeGreaterThanOrEqual(4.5);
  });

  it("is needed — the decorative accent could not carry white text", () => {
    // Pins the reason the split exists. If someone "simplifies" --accent-action
    // back to --accent, the numbers this guards are right here.
    expect(contrast(WHITE, accent.light)).toBeLessThan(4.5);
    expect(contrast(WHITE, accent.dark[0])).toBeLessThan(4.5);
  });
});

describe("action gradient carries white text at both ends", () => {
  // A gradient only has to be checked at its endpoints: each channel is linear in
  // the ramp position and the sRGB transfer curve is convex, so luminance is
  // convex too — its maximum, i.e. the WORST contrast against white, is always at
  // one end and never in the middle.
  it("clears AA at both stops in both themes", () => {
    for (const [a, b] of [
      [accentAction.light, accentActionDeep.light],
      [accentAction.dark[0], accentActionDeep.dark[0]],
    ]) {
      expect(contrast(WHITE, a)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(WHITE, b)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("is needed — the decorative gradient fails white text at three of its four stops", () => {
    // Pins why --grad-action exists. Light stop 1 is 4.39:1; both dark stops are
    // under 3:1. Only the light second stop ever passed, which is exactly how a
    // gradient hides this kind of defect.
    expect(contrast(WHITE, accent.light)).toBeLessThan(4.5);
    expect(contrast(WHITE, accent.dark[0])).toBeLessThan(4.5);
    expect(contrast(WHITE, accentDeep.dark[0])).toBeLessThan(4.5);
  });

  it("is the gradient every white-text surface actually uses", () => {
    // --grad-accent may still paint logo marks and progress fills; it may not sit
    // under a word. These four component surfaces all carry white text; generated
    // static CTAs have a matching contract in static-landmarks.test.mjs.
    const WHITE_TEXT_SURFACES: Array<[string, RegExp]> = [
      ["app.css .btn-primary", /\.btn-primary \{ background: var\(--grad-action\)/],
      ["Nav .tab.active", /\.tab\.active \{ color: #fff; background: var\(--grad-action\)/],
      ["App .pavatar", /\.pavatar \{[\s\S]{0,160}?background: var\(--grad-action\)/],
      ["PeerLink .avatar.target", /\.avatar\.target \{\s*background: var\(--grad-action\)/],
    ];
    const sources: Record<string, string> = {
      "app.css .btn-primary": css,
      "Nav .tab.active": readFileSync(join(libDir, "Nav.svelte"), "utf8"),
      "App .pavatar": readFileSync(resolve(libDir, "..", "App.svelte"), "utf8"),
      "PeerLink .avatar.target": readFileSync(join(libDir, "PeerLink.svelte"), "utf8"),
    };
    for (const [label, pattern] of WHITE_TEXT_SURFACES) {
      expect(pattern.test(sources[label]), `${label} must use --grad-action`).toBe(true);
    }
  });
});

describe("success foreground token", () => {
  it("clears AA against both the page and card backgrounds in both themes", () => {
    expect(contrast(okToken.light, bg.light)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(okToken.light, surface.light)).toBeGreaterThanOrEqual(4.5);
    for (let i = 0; i < okToken.dark.length; i++) {
      expect(contrast(okToken.dark[i], bg.dark[i])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(okToken.dark[i], surface.dark[i])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the legacy low-contrast green out of readable component text", () => {
    const offenders: string[] = [];
    for (const { name, source } of components) {
      source.split("\n").forEach((line, i) => {
        if (/color:\s*#2ecc71\b/i.test(line)) offenders.push(`${name}:${i + 1}`);
      });
    }
    expect(offenders, "these success states must use --ok").toEqual([]);
  });
});

describe("decorative accent stays out of text and solid actions", () => {
  // App.svelte is scanned alongside src/lib: it holds the transfer workspace, and
  // three of its own text colours were still on the decorative accent after the
  // first pass because only src/lib was being checked.
  it("no component paints text with var(--accent)", () => {
    // Icons are the one documented exception: an <svg> carries no text, so it
    // answers to the 3:1 non-text threshold instead, which the decorative accent
    // clears. Recognised by a selector whose class name ends in "icon" — narrow
    // on purpose, so the exception cannot quietly widen to cover real text.
    const ICON_SELECTOR = /\.[\w-]*icon\b/;
    const offenders: string[] = [];
    for (const { name, source } of components) {
      const lines = source.split("\n");
      lines.forEach((line, i) => {
        if (!/(^|[;{\s])color:\s*var\(--accent\)\s*;/.test(line)) return;
        if (ICON_SELECTOR.test(openingSelector(lines, i))) return;
        offenders.push(`${name}:${i + 1}`);
      });
    }
    expect(offenders, "these paint words with the decorative accent").toEqual([]);
  });

  it("no component puts white text on a solid var(--accent) fill", () => {
    const offenders: string[] = [];
    for (const { name, source } of components) {
      const lines = source.split("\n");
      lines.forEach((line, i) => {
        if (!/background:\s*var\(--accent\)\s*;/.test(line)) return;
        // The fill and the colour are usually on the same line or the one beside it.
        const context = lines.slice(Math.max(0, i - 2), i + 3).join("\n");
        if (/color:\s*(#fff\b|#ffffff\b|white\b|var\(--accent-contrast)/.test(context)) offenders.push(`${name}:${i + 1}`);
      });
    }
    expect(offenders, "these need --accent-action, not --accent").toEqual([]);
  });
});
