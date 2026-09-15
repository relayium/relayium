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

// ── The settings shell's own accent pair ────────────────────────────────────
//
// The four transfer destinations re-tint themselves inside `.appshell.shell`,
// to the reference's purple (`Relayium 设计规范` §3: #6d45f5 light, #8b6bff
// dark) over the reference's neutral surfaces. Those overrides are written in
// `rgb()` rather than hex ON PURPOSE — `token()` above counts exactly three hex
// declarations per accent token, and a fourth would fail a contract these
// values are not part of. That is also why they need their own check: written
// in a notation the parser above cannot see, they would otherwise be the one
// accent pair in the product that nothing measures.
//
// The reference's own accent is NOT accessible as written in dark: #8b6bff is
// 4.27:1 as text on the dark content surface and 3.72:1 under white. So the
// shell keeps the same three-role split the site already uses — decorative,
// foreground, action — and only the decorative role is the literal reference
// value.
function rgbToken(block: string, name: string): string {
  const m = new RegExp(`${name}:\\s*rgb\\((\\d+) (\\d+) (\\d+)\\)`).exec(block);
  expect(m, `${name} should be declared as rgb() inside the shell block`).not.toBeNull();
  const [, r, g, b] = m!;
  return "#" + [r, g, b].map((v) => Number(v).toString(16).padStart(2, "0")).join("");
}

/** A `.appshell.shell` rule body, selected by its opening selector. */
function shellBlock(selector: string): string {
  const at = css.indexOf(selector + " {");
  expect(at, `${selector} is no longer a declaration block in app.css`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("\n}", at));
}

/** A `--shell-*` surface token.
 *
 *  The three declaration blocks are located by their own first token rather than
 *  by selector text: `:root[data-theme="dark"]` appears twice in this file (the
 *  site palette, then the shell's), and slicing from the first one reads the
 *  LIGHT shell values as if they were dark — which is a helper bug that shows up
 *  as a contrast failure and sends the reader to the stylesheet. Order in the
 *  file is light `:root`, the prefers-color-scheme block, then the explicit
 *  attribute block; the last two must agree, which is checked below. */
function shellBlocks(): string[] {
  const at: number[] = [];
  for (let i = css.indexOf("--shell-win:"); i !== -1; i = css.indexOf("--shell-win:", i + 1)) at.push(i);
  expect(at.length, "--shell-win should be declared in the light root and both dark blocks").toBe(3);
  return at.map((i) => css.slice(i, css.indexOf("\n}", i)));
}
function shellSurface(name: string, dark: boolean): string {
  const [lightBlock, mediaDark, attrDark] = shellBlocks();
  const read = (block: string) => {
    const m = new RegExp(`${name}:\\s*(#[0-9a-f]{3,8})`, "i").exec(block);
    expect(m, `${name} should be declared as a hex surface`).not.toBeNull();
    return m![1];
  };
  if (!dark) return read(lightBlock);
  // A token defined in only one of the two dark blocks leaves either "system
  // dark" or "chose dark" on the light value, and nobody notices.
  expect(read(mediaDark), `${name} must match in both dark blocks`).toBe(read(attrDark));
  return read(attrDark);
}

describe("the settings shell's accent pair", () => {
  const light = shellBlock(".appshell.shell");
  const dark = shellBlock(':root[data-theme="dark"] .appshell.shell');
  const lightContent = shellSurface("--shell-content", false);
  const darkContent = shellSurface("--shell-content", true);

  /** An `--accent-bg` tint composited over an opaque surface — the surface text
   *  on a selected row, an active tag or the verification note actually sits on.
   *  Checking only the card and the content surface is what let two foregrounds
   *  ship under AA: 4.39:1 (light tag) and 4.34:1 (dark `.sas` note). */
  function tinted(block: string, base: string): string {
    const m = /--accent-bg:\s*rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/.exec(block);
    expect(m, "--accent-bg should be declared as rgb(r g b / a) inside the shell").not.toBeNull();
    const [, r, g, b, a] = m!;
    const alpha = Number(a);
    const raw = base.replace("#", "");
    const under = (raw.match(/../g) ?? []).map((pair) => parseInt(pair, 16));
    const mix = [Number(r), Number(g), Number(b)].map((c, i) => Math.round(alpha * c + (1 - alpha) * under[i]));
    return "#" + mix.map((c) => c.toString(16).padStart(2, "0")).join("");
  }

  it("reads as text at AA on the accent-tinted surface, not only on the card", () => {
    const lightCard = shellSurface("--shell-card", false);
    const darkCard = shellSurface("--shell-card", true);
    for (const [block, card, content, label] of [
      [light, lightCard, lightContent, "light"],
      [dark, darkCard, darkContent, "dark"],
    ] as const) {
      for (const base of [card, content]) {
        const surface = tinted(block, base);
        expect(contrast(rgbToken(block, "--accent-fg"), surface), `${label} accent-fg on ${surface}`)
          .toBeGreaterThanOrEqual(4.5);
        // The secondary body tier renders on these surfaces too (callouts, the
        // homepage limit line). It is measured, not assumed.
        const body = label === "light" ? token("--text").light : token("--text").dark[0];
        expect(contrast(body, surface), `${label} --text (${body}) on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("reads as text at AA on the surface it actually sits on", () => {
    expect(contrast(rgbToken(light, "--accent-fg"), lightContent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgbToken(dark, "--accent-fg"), darkContent)).toBeGreaterThanOrEqual(4.5);
    // The light card is white and the dark card is a translucent lift over the
    // content surface, so the content surface is the harder of the two in dark
    // and white is the harder one in light. Check both ends.
    expect(contrast(rgbToken(light, "--accent-fg"), WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it("carries white text at AA wherever it is a solid fill", () => {
    for (const block of [light, dark]) {
      expect(contrast(WHITE, rgbToken(block, "--accent-action"))).toBeGreaterThanOrEqual(4.5);
      // The shell flattens the action gradient to one colour, so the selected
      // sidebar row and the primary button are the same measured fill.
      expect(contrast(WHITE, rgbToken(block, "--grad-action"))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("is needed — the reference's own accent fails both roles in dark", () => {
    // Pins why the split survives the re-tint. If someone "simplifies"
    // --accent-fg and --accent-action back to the reference's --accent, these
    // are the numbers that say what breaks.
    const decorative = rgbToken(dark, "--accent");
    expect(contrast(decorative, darkContent)).toBeLessThan(4.5);
    expect(contrast(WHITE, decorative)).toBeLessThan(4.5);
  });

  it("keeps the reference's neutral surface hierarchy rather than the site's wash", () => {
    // Four distinct steps, window → sidebar → content → card, in both themes.
    for (const dark of [false, true]) {
      const steps = ["--shell-win", "--shell-side", "--shell-content"].map((n) => shellSurface(n, dark));
      expect(new Set(steps).size, dark ? "dark" : "light").toBe(3);
    }
    // And the wash is switched off rather than painted over: a class on <html>,
    // because body's radial gradients are wider than <main>.
    expect(css).toContain(":root.shell-route body {");
  });
});
