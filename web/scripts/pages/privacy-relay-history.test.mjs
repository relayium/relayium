import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import privacy from "./content/legal/privacy.mjs";
import { MAX_HISTORY_ENTRIES, HISTORY_TTL_MS } from "../../src/lib/relay-history";

const claims = {
  en: ["30 records", "24 hours", "salted hash", "upper bounds", "no file name", "sign-out do not clear"],
  zh: ["30 条", "24 小时", "加盐", "上界", "不包含文件名", "退出登录不会清除"],
};
describe("relay routing history privacy disclosure", () => {
  it("bounds the disclosed retention to the actual local history implementation", () => {
    expect(MAX_HISTORY_ENTRIES).toBe(30);
    expect(HISTORY_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
  for (const [lang, tokens] of Object.entries(claims)) {
    it(`${lang}: explains the separate local records and shared routing hints in source and generated policy`, () => {
      const source = JSON.stringify(privacy.langs[lang]);
      const page = readFileSync(`public/${lang === "en" ? "" : `${lang}/`}privacy/index.html`, "utf8");
      for (const token of tokens) {
        expect(source, token).toContain(token);
        expect(page, token).toContain(token);
      }
    });
  }
});
