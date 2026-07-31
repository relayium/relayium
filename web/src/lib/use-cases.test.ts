import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
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

const LOCALES = { en, zh, ja, ko, de, fr, ar, es, pt };

// UseCases.svelte maps its cards to articles BY POSITION, so the two lists have
// to stay the same length in every locale. Parsing the component keeps this
// honest without exporting an array purely for the test.
const src = readFileSync(join(import.meta.dirname, "UseCases.svelte"), "utf8");
const slugs = [...src.matchAll(/^\s{4}"([a-z-]+\/[a-z-]+)",/gm)].map((m) => m[1]);
const iconBlock = src.match(/const CASE_ICONS:[^=]+?\=\s*\[([^\]]+)\]/s)?.[1] ?? "";
const icons = [...iconBlock.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);

// Read as text rather than imported: the module names do not track the slugs
// (guides/how-relayium-encrypts-your-files lives in
// guides-how-encryption-works.mjs), and importing gen-pages.mjs from a src/ test
// drags that file into tsconfig.app's scope, where it type-checks as 165 errors.
// A typo in CASE_SLUGS ships a homepage link into the 404 page.
const articleDir = join(import.meta.dirname, "../../scripts/pages/content/articles");
const generated = new Set(
  readdirSync(articleDir).flatMap((f) => {
    const m = readFileSync(join(articleDir, f), "utf8").match(/^\s*slug: "([^"]+)"/m);
    return m ? [m[1]] : [];
  })
);

describe("homepage use-case cards", () => {
  it("has one target slug per card", () => {
    expect(slugs.length).toBeGreaterThan(0);
    expect(icons).toHaveLength(slugs.length);
    for (const [code, m] of Object.entries(LOCALES)) {
      expect.soft(m.useCases.items.length, `locale ${code}`).toBe(slugs.length);
    }
  });

  it("points every card at an article that is actually generated", () => {
    expect(generated.size).toBeGreaterThan(30);
    expect(slugs.filter((s) => !generated.has(s))).toEqual([]);
  });

  it("has a text card, pointing at the text guide", () => {
    // The homepage positions text as a first-class transfer, so the self-ID grid
    // has to offer the reader a text row at all — the copy is per-locale but the
    // link target is not.
    expect(slugs).toContain("how-to/send-text-between-devices");
    for (const [code, m] of Object.entries(LOCALES)) {
      const card = m.useCases.items[slugs.indexOf("how-to/send-text-between-devices")];
      expect.soft(card?.title.trim(), `locale ${code} text card title`).toBeTruthy();
      expect.soft(card?.desc.trim(), `locale ${code} text card desc`).toBeTruthy();
    }
  });

  it("links the slashed form, so the card does not cost a 301", () => {
    expect(src).toContain('pageUrl(CASE_SLUGS[i], lang()) + "/"');
  });

  it("renders the cards as anchors, not plain divs", () => {
    expect(src).toContain('<a class="case reveal"');
  });

  it("lets a trailing odd card span the grid instead of leaving a hole", () => {
    // Five cards in a two-column grid; without this the last row is half empty.
    expect(src).toContain(".case:last-child:nth-child(odd) { grid-column: 1 / -1; }");
  });
});
