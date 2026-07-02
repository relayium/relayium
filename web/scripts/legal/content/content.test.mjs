import { describe, it, expect } from "vitest";
import privacy from "./privacy.mjs";
import terms from "./terms.mjs";
import security from "./security.mjs";
import { LANGS } from "../shared.mjs";

const docs = { privacy, terms, security };
const REQUIRED = ["title", "description", "updatedLabel", "updated", "otherDocLabel", "lead", "sections"];

describe("legal content", () => {
  for (const [name, doc] of Object.entries(docs)) {
    it(`${name} declares its slug`, () => expect(doc.slug).toBe(name));

    it(`${name} has all 6 languages`, () => {
      expect(Object.keys(doc.langs).sort()).toEqual([...LANGS].sort());
    });

    for (const lang of LANGS) {
      it(`${name}.${lang} has every required field`, () => {
        const d = doc.langs[lang];
        for (const k of REQUIRED) expect(d, `${name}.${lang}.${k}`).toHaveProperty(k);
        expect(d.updated).toBe("2026-07-01");
        expect(d.lead.length).toBeGreaterThan(0);
        expect(d.sections.length).toBeGreaterThan(0);
        for (const s of d.sections) expect(typeof s.heading).toBe("string");
      });
    }

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
