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

describe("maintained privacy copy discloses the activation aggregate exactly", () => {
  const flattened = (value) => {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(flattened);
    if (value && typeof value === "object") return Object.values(value).flatMap(flattened);
    return [];
  };

  for (const lang of MAINTAINED_LANGS) {
    it(`${lang} calls it identifier-free best-effort lower-bound actions, not people or conversion`, () => {
      const text = flattened(privacy.langs[lang]).join("\n");
      if (lang === "en") {
        expect(text).toMatch(/first-party, identifier-free monthly aggregate action counts/);
        expect(text).toMatch(/successful code mints.*first admitted socket.*first transition to two admitted peers/s);
        expect(text).toMatch(/only UTC month.*three fixed stages.*nonnegative count/s);
        expect(text).toMatch(/best-effort lower-bound action counts, not unique users, a cohort, or an exact conversion rate/);
        expect(text).toMatch(/same-month action totals and is not cohort conversion/);
        expect(text).toMatch(/database does not store it against your account and contains no field linking it to an account/);
      } else {
        expect(text).toMatch(/第一方、无标识符的跨网络配对月度聚合动作数/);
        expect(text).toMatch(/成功铸码.*首次接纳连接.*首次变为两个已接纳端/s);
        expect(text).toMatch(/只包含 UTC 月份.*三个固定阶段之一.*非负整数计数/s);
        expect(text).toMatch(/尽力写入的动作数下界，不是独立用户数、同期群或精确转化率/);
        expect(text).toMatch(/同月动作总数相除，并不是同期群转化/);
        expect(text).toMatch(/数据库不按账号保存这些聚合，也不含将其连接到账号的字段/);
      }
      expect(text).toMatch(/third-party analytics SDK|第三方分析 SDK/);
    });
  }
});
