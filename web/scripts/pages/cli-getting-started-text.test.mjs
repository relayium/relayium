import { describe, it, expect } from "vitest";
import article from "./content/articles/cli-getting-started.mjs";
import { LANGS } from "./shared.mjs";

const TEXT_WORD = {
  en: /\btext\b/i, zh: /文本/, ja: /テキスト/, ko: /텍스트/, de: /Text/,
  fr: /texte/i, ar: /(?<!م)نص/, es: /texto/i, pt: /texto/i,
};
const SERVER_WORD = /server|服务器|サーバー|서버|serveur|خوادم|servidor/i;
const RETAIN_WORD = /retain|保留|保持|보관|behalten|conserver|الاحتفاظ|conservar|guardar/i;

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
      expect(section.code).toEqual(["relayium text", "relayium text 483920"]);

      const copy = [...(section.body ?? []), ...(section.bullets ?? [])].join(" ");
      expect(copy, `${lang} mint login`).toContain("relayium login");
      expect(copy, `${lang} direct P2P`).toMatch(/P2P|peer-to-peer/i);
      expect(copy, `${lang} no browser relay`).toContain("TURN");
      expect(copy, `${lang} server storage boundary`).toMatch(SERVER_WORD);
      expect(copy, `${lang} endpoint retention boundary`).toMatch(RETAIN_WORD);
      expect(copy, `${lang} byte limit`).toMatch(/65[.,\s]?536/);
      expect(copy, `${lang} larger content`).toContain("relayium send");
    }
  });

  it("records the rewrite date and keeps the chooser on every mode", () => {
    // 2026-08-07 was the date the guide became a runnable tutorial. It moved
    // again when the chooser was corrected from three modes to the seven the
    // product actually has — cli-mode-chooser.test.mjs owns that contract, and
    // pins the date with the rewrite that earned it.
    expect(article.updated).toBe("2026-09-01");
    const en = article.langs.en.sections.find(
      (item) => item.heading === "The seven ways it moves files and text",
    );
    expect(en, "the mode chooser section was renamed or removed").toBeTruthy();
    const bullets = en.bullets.join(" ");
    // The three the old section listed are still here — the correction added
    // modes, it did not swap one incomplete list for another.
    expect(bullets).toContain("relayium push / relayium pull");
    expect(bullets).toContain("relayium send / relayium receive");
    expect(bullets).toContain("daemon direct");
    // …and the four it never mentioned.
    expect(bullets).toContain("relayium up / relayium down");
    expect(bullets).toContain("Device Inbox");
    expect(bullets).toContain("relayium text");
    expect(bullets).toContain("relayium sync");
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
