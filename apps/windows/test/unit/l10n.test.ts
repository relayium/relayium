import { describe, expect, it } from "vitest";
import { EN, ZH_HANS, catalogFor, resolveLocale, translator, type MessageKey } from "../../src/main/l10n.js";

describe("both maintained languages are complete", () => {
  it("has the same key set in each", () => {
    expect(Object.keys(ZH_HANS).sort()).toEqual(Object.keys(EN).sort());
  });

  it("has no empty or placeholder values", () => {
    for (const [locale, catalog] of [["en", EN], ["zh-Hans", ZH_HANS]] as const) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), `${locale}/${key}`).not.toBe("");
        expect(value, `${locale}/${key}`).not.toContain("TODO");
      }
    }
  });

  it("does not leave Chinese copy identical to English", () => {
    // A key whose zh value is byte-identical to its English one is almost always
    // an untranslated paste. `Relayium` is the product name and is exempt.
    for (const key of Object.keys(EN) as MessageKey[]) {
      if (EN[key] === "Relayium") continue;
      expect(ZH_HANS[key], key).not.toBe(EN[key]);
    }
  });
});

describe("no interpolation reaches user-facing copy", () => {
  // The invariant the macOS app asserts as text: a catalog with a substitution
  // point is a catalog a value can leak through.
  it("contains no template or printf placeholders", () => {
    for (const catalog of [EN, ZH_HANS]) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(value, key).not.toMatch(/\$\{|%[sd@]|\{\d+\}/);
      }
    }
  });
});

describe("locale resolution", () => {
  it("maps Simplified regions to zh-Hans", () => {
    for (const tag of ["zh", "zh-CN", "zh-Hans", "zh-hans-cn", "zh_SG", "zh-MY"]) {
      expect(resolveLocale(tag), tag).toBe("zh-Hans");
    }
  });

  it("does NOT serve Simplified to Traditional locales", () => {
    // Substituting Simplified would claim support for a language this product
    // does not maintain. English is the declared fallback.
    for (const tag of ["zh-TW", "zh-HK", "zh-Hant", "zh-Hant-TW"]) {
      expect(resolveLocale(tag), tag).toBe("en");
    }
  });

  it("falls back to English for anything else, including absent", () => {
    for (const tag of ["en", "en-GB", "de", "", undefined]) {
      expect(resolveLocale(tag)).toBe("en");
    }
  });
});

describe("translator", () => {
  it("returns the catalog for its locale", () => {
    expect(translator("zh-Hans")("resident.tray.quit")).toBe(ZH_HANS["resident.tray.quit"]);
    expect(translator("en")("resident.tray.quit")).toBe(EN["resident.tray.quit"]);
    expect(catalogFor("en")).toBe(EN);
  });
});
