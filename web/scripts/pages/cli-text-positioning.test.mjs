// web/scripts/pages/cli-text-positioning.test.mjs — the static twin of the
// positioning guard in src/lib/i18n.test.ts ("CLI 定位文案覆盖文件与临时文本").
//
// `relayium text` shipped in v0.12.0, so the CLI moves files AND ephemeral text.
// The prerendered surfaces say so in two places a crawler (and a no-JS reader)
// sees first: the /cli shell's <title>/description/pitch, and the CLI card on
// the /apps download hub — the latter in all nine locales. Both were written
// when the CLI really was file-only, and neither has a test that would notice
// them drifting back: shells.test.mjs only pins the shell to the SPA's meta, and
// the i18n guard cannot see .mjs content modules at all.
//
// The word tables are per-locale on purpose. Matching the Latin command name
// "text" would pass on a sentence that only ever talks about send/receive,
// because the command name appears verbatim in every locale.
import { describe, it, expect } from "vitest";
import apps from "./content/apps.mjs";
import { cli } from "./content/spa-pages.mjs";
import { LANGS } from "./shared.mjs";

const TEXT_WORD = {
  en: /\btext\b/i,
  zh: /文本/,
  ja: /テキスト/,
  ko: /텍스트/,
  de: /Text/,
  fr: /texte/i,
  es: /texto/i,
  pt: /texto/i,
  ar: /نص/,
};

// The platform cards are positional in every locale: web, CLI, macOS, iOS.
const CLI_CARD = 1;

describe("/apps CLI card covers files and ephemeral text", () => {
  it("names text in the picker bullet and the card, in every locale", () => {
    for (const lang of LANGS) {
      const doc = apps.langs[lang];
      expect(doc.how.steps[CLI_CARD], `${lang} /apps CLI bullet is still file-only`).toMatch(TEXT_WORD[lang]);
      expect(doc.why.items[CLI_CARD].desc, `${lang} /apps CLI card is still file-only`).toMatch(TEXT_WORD[lang]);
    }
  });

  it("does not extend the claim to the unshipped native apps", () => {
    // Neither apps/ client implements the text session; saying they do would be
    // a promise the code cannot keep.
    for (const lang of LANGS) {
      const { items } = apps.langs[lang].why;
      for (const i of [2, 3]) {
        expect(items[i].desc, `${lang} native card claims text support`).not.toMatch(TEXT_WORD[lang]);
      }
    }
  });
});

describe("/cli shell covers files and ephemeral text", () => {
  it("says so in the title, the description and the hero pitch", () => {
    expect(cli.title).toMatch(TEXT_WORD.en);
    expect(cli.description).toMatch(TEXT_WORD.en);
    expect(cli.hero.pitch).toMatch(TEXT_WORD.en);
  });

  it("lists text among the modes, with its protocol facts intact", () => {
    const item = cli.why.items.find((i) => i.title.startsWith("text"));
    expect(item, "the /cli shell dropped the text mode").toBeTruthy();
    // Minting needs an account; joining a printed code does not. Getting this
    // backwards is the defect the CLI-side onboarding copy already shipped once.
    expect(item.desc).toContain("relayium login");
    expect(item.desc).toContain("relayium text CODE");
    expect(item.desc).toMatch(/no login|no account/i);
    expect(item.desc).toContain("65,536");
    expect(item.desc).toMatch(/never stored/i);
  });
});
