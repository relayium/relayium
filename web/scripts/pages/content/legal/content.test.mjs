import { describe, it, expect } from "vitest";
import privacy from "./privacy.mjs";
import terms from "./terms.mjs";
import security from "./security.mjs";
import support from "./support.mjs";
import { LANGS, MAINTAINED_LANGS, FROZEN_LANGS } from "../../shared.mjs";

const docs = { privacy, terms, security, support };
const REQUIRED = ["title", "description", "updatedLabel", "updated", "otherDocLabel", "lead", "sections"];

describe("legal content", () => {
  for (const [name, doc] of Object.entries(docs)) {
    it(`${name} declares its slug`, () => expect(doc.slug).toBe(name));

    it(`${name} has all 9 languages`, () => {
      expect(Object.keys(doc.langs).sort()).toEqual([...LANGS].sort());
    });

    for (const lang of LANGS) {
      it(`${name}.${lang} has every required field`, () => {
        const d = doc.langs[lang];
        for (const k of REQUIRED) expect(d, `${name}.${lang}.${k}`).toHaveProperty(k);
        // Pin the MAINTAINED pair to the doc's own English date rather than one
        // hardcoded literal: a per-doc date lets documents be revised
        // independently, while still catching the real bug (one maintained
        // language silently keeping a stale "last updated" after a revision).
        //
        // The seven frozen locales are excluded on purpose, and that exclusion
        // is the point rather than a loophole. Their prose is archived at the
        // 2026-08-14 language freeze and is not edited when en/zh are corrected
        // — so making them inherit the English date would have them tell a
        // reader their translation was reviewed on a day nobody reviewed it.
        // The invariant that replaces equality is below: one shared cohort date,
        // never ahead of English.
        if (MAINTAINED_LANGS.includes(lang))
          expect(d.updated, `${name}.${lang}.updated`).toBe(doc.langs.en.updated);
        expect(d.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(d.lead.length).toBeGreaterThan(0);
        expect(d.sections.length).toBeGreaterThan(0);
        for (const s of d.sections) expect(typeof s.heading).toBe("string");
      });
    }

    it(`${name} dates the frozen seven as one archived cohort, never ahead of English`, () => {
      // They were frozen together, so they carry one date; and a frozen
      // translation can only ever be as current as the English it was made
      // from, never more current. Both halves fail loudly if somebody "tidies"
      // the dates in either direction.
      const frozen = FROZEN_LANGS.map((l) => doc.langs[l].updated);
      expect(new Set(frozen).size, `${name}: frozen locales disagree on their archive date`).toBe(1);
      expect(
        frozen[0] <= doc.langs.en.updated,
        `${name}: a frozen translation claims to be newer than the English it came from`,
      ).toBe(true);
    });

    it(`${name} has the same section count across languages`, () => {
      const counts = LANGS.map((l) => doc.langs[l].sections.length);
      expect(new Set(counts).size).toBe(1);
    });

    it(`${name} translations are not identical to English`, () => {
      for (const lang of ["ja", "ko", "de", "fr"]) {
        expect(doc.langs[lang].title, `${name}.${lang}.title`).not.toBe(doc.langs.en.title);
        expect(doc.langs[lang].sections[0].heading).not.toBe(doc.langs.en.sections[0].heading);
      }
    });

    it(`${name} keeps bullets count per section across languages`, () => {
      for (let i = 0; i < doc.langs.en.sections.length; i++) {
        const en = (doc.langs.en.sections[i].bullets || []).length;
        for (const lang of LANGS) {
          expect((doc.langs[lang].sections[i].bullets || []).length, `${name}.${lang}.s${i}`).toBe(en);
        }
      }
    });

    it(`${name} contains no 'draft' wording`, () => {
      const blob = JSON.stringify(doc).toLowerCase();
      expect(blob).not.toContain("draft");
    });
  }
});
