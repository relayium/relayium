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

describe("homepage use-case cards", () => {
  it("has one target slug per card", () => {
    expect(slugs.length).toBeGreaterThan(0);
    for (const [code, m] of Object.entries(LOCALES)) {
      expect.soft(m.useCases.items.length, `locale ${code}`).toBe(slugs.length);
    }
  });

  it("points every card at an article that is actually generated", () => {
    // Read as text rather than imported: the module names do not track the
    // slugs (guides/how-relayium-encrypts-your-files lives in
    // guides-how-encryption-works.mjs), and importing gen-pages.mjs from a src/
    // test drags that file into tsconfig.app's scope, where it type-checks as
    // 165 errors. A typo here ships a homepage link into the 404 page.
    const dir = join(import.meta.dirname, "../../scripts/pages/content/articles");
    const real = new Set(
      readdirSync(dir).flatMap((f) => {
        const m = readFileSync(join(dir, f), "utf8").match(/^\s*slug: "([^"]+)"/m);
        return m ? [m[1]] : [];
      })
    );
    expect(real.size).toBeGreaterThan(30);
    expect(slugs.filter((s) => !real.has(s))).toEqual([]);
  });

  it("links the slashed form, so the card does not cost a 301", () => {
    expect(src).toContain('pageUrl(CASE_SLUGS[i], lang()) + "/"');
  });

  it("renders the cards as anchors, not plain divs", () => {
    expect(src).toContain('<a class="case reveal"');
  });
});
