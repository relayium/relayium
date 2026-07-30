import { describe, it, expect } from "vitest";
import article from "./content/articles/cli-getting-started.mjs";
import { LANGS } from "./shared.mjs";

const TEXT_WORD = {
  en: /\btext\b/i, zh: /文本/, ja: /テキスト/, ko: /텍스트/, de: /Text/,
  fr: /texte/i, ar: /(?<!م)نص/, es: /texto/i, pt: /texto/i,
};

describe("CLI getting-started guide includes ephemeral text", () => {
  it("positions files and text in every localized title and description", () => {
    for (const lang of LANGS) {
      const doc = article.langs[lang];
      expect(doc.title, `${lang} title`).toMatch(TEXT_WORD[lang]);
      expect(doc.description, `${lang} description`).toMatch(TEXT_WORD[lang]);
      expect(doc.lead.join(" "), `${lang} lead`).toMatch(TEXT_WORD[lang]);
    }
  });

  it("has the same copy-ready text workflow and protocol boundaries in every language", () => {
    for (const lang of LANGS) {
      const section = article.langs[lang].sections.find((item) =>
        item.code?.includes("relayium text")
      );
      expect(section, `${lang} text section`).toBeTruthy();
      expect(section.code).toEqual(["relayium text", "relayium text K7M4XR"]);

      const copy = [...(section.body ?? []), ...(section.bullets ?? [])].join(" ");
      expect(copy, `${lang} mint login`).toContain("relayium login");
      expect(copy, `${lang} direct P2P`).toMatch(/P2P|peer-to-peer/i);
      expect(copy, `${lang} no browser relay`).toContain("TURN");
      expect(copy, `${lang} byte limit`).toMatch(/65[.,\s]?536/);
      expect(copy, `${lang} larger content`).toContain("relayium send");
    }
  });

  it("records the release date and preserves the three file modes", () => {
    expect(article.updated).toBe("2026-07-30");
    const en = article.langs.en.sections.find((item) => item.heading === "The three ways it moves files");
    expect(en?.bullets.join(" ")).toContain("push / pull");
    expect(en?.bullets.join(" ")).toContain("send / receive");
    expect(en?.bullets.join(" ")).toContain("daemon direct");
  });

  it("keeps the account FAQ aligned with text code minting", () => {
    for (const lang of LANGS) {
      const faq = article.langs[lang].faq.items.find((item) => item.q.includes("account")
        || item.q.includes("账号") || item.q.includes("アカウント")
        || item.q.includes("계정") || item.q.includes("Konto")
        || item.q.includes("compte") || item.q.includes("حساب")
        || item.q.includes("cuenta") || item.q.includes("conta"));
      expect(faq, `${lang} account FAQ`).toBeTruthy();
      expect(faq.a, `${lang} account FAQ`).toContain("send");
      expect(faq.a, `${lang} account FAQ`).toContain("text");
      expect(faq.a, `${lang} account FAQ`).toContain("relayium login");
    }
  });
});
