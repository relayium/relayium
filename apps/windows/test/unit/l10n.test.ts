import { describe, expect, it } from "vitest";
import {
  EN,
  ZH_HANS,
  catalogFor,
  counter,
  resolveLocale,
  translator,
  type CountedMessageKey,
  type MessageKey,
} from "../../src/main/l10n.js";

/** The complete set of keys allowed to carry `{count}`. Widening this is the
 *  review surface for interpolation; see `l10n.ts`. */
const COUNTED: readonly CountedMessageKey[] = ["native.download.pickTitle"];

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
    for (const key of Object.keys(EN) as (MessageKey | CountedMessageKey)[]) {
      if (EN[key] === "Relayium") continue;
      expect(ZH_HANS[key], key).not.toBe(EN[key]);
    }
  });
});

describe("interpolation is exactly one substitution, in exactly the named keys", () => {
  // The invariant this file used to state absolutely: a catalog with a
  // substitution point is a catalog a value can leak through. It is now stated
  // narrowly instead, because the stored-link picker has to say how many files
  // are about to be written and Windows has no other surface that can.
  it("contains no template or printf placeholders", () => {
    for (const catalog of [EN, ZH_HANS]) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(value, key).not.toMatch(/\$\{|%[sd@]|\{\d+\}/);
      }
    }
  });

  it("puts `{count}` in the counted keys and nowhere else", () => {
    for (const [locale, catalog] of [["en", EN], ["zh-Hans", ZH_HANS]] as const) {
      for (const [key, value] of Object.entries(catalog)) {
        const counted = (COUNTED as readonly string[]).includes(key);
        expect(value.includes("{count}"), `${locale}/${key}`).toBe(counted);
      }
    }
  });

  it("leaves no other brace-delimited placeholder anywhere", () => {
    for (const catalog of [EN, ZH_HANS]) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.replace(/\{count\}/g, ""), key).not.toMatch(/[{}]/);
      }
    }
  });
});

describe("the counting lookup", () => {
  it("substitutes in both catalogs, each in its own word order", () => {
    expect(counter("en")("native.download.pickTitle", 3)).toBe("Choose where to save 3 file(s)");
    expect(counter("zh-Hans")("native.download.pickTitle", 3)).toBe("选择保存位置（3 个文件）");
  });

  it("leaves nothing unsubstituted", () => {
    for (const locale of ["en", "zh-Hans"] as const) {
      for (const key of COUNTED) {
        expect(counter(locale)(key, 1)).not.toContain("{count}");
      }
    }
  });

  it("renders a whole, non-negative number whatever it is handed", () => {
    // The count comes from a validated manifest, so these are impossible today.
    // They are asserted anyway because the alternative — `NaN file(s)` or
    // `-1 file(s)` in the dialog that authorises a write — is a sentence no
    // user should ever be shown.
    const t = counter("en");
    expect(t("native.download.pickTitle", 2.7)).toContain("2 file(s)");
    expect(t("native.download.pickTitle", -5)).toContain("0 file(s)");
    expect(t("native.download.pickTitle", Number.NaN)).toContain("0 file(s)");
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
