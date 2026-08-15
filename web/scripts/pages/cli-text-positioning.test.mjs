// web/scripts/pages/cli-text-positioning.test.mjs — the static twin of the
// positioning guard in src/lib/i18n.test.ts ("平台定位文案覆盖文件与临时文本").
//
// `relayium text` shipped in v0.12.0, so the CLI moves files AND ephemeral text;
// the web app now does both. The prerendered surfaces say so in the
// places a crawler (and a no-JS reader) sees first: the /cli shell's
// <title>/description/pitch, and the /apps download hub — its own
// description/pitch plus the web and CLI entries, in all nine locales. All of
// them were written when the product was pitched as file-only, and none has a
// test that would notice them drifting back: shells.test.mjs only pins the shell
// to the SPA's meta, and the i18n guard cannot see .mjs content modules at all.
//
// The macOS and iOS cards carry files AND text too, since R3-D/E/F: the second
// describe below asserts that positively, and guards the claim that is still
// untrue there — store distribution. The iOS Share Extension used to be on that
// list; it has shipped in `apps/ios/RelayiumShare`, so the guard is now split by
// language set: the two maintained locales must NAME it, and the seven archived
// ones must not have gained it, because they were preserved rather than
// retranslated.
//
// The word tables are per-locale on purpose. Matching the Latin command name
// "text" would pass on a sentence that only ever talks about send/receive,
// because the command name appears verbatim in every locale.
import { describe, it, expect } from "vitest";
import apps from "./content/apps.mjs";
import { cli } from "./content/spa-pages.mjs";
import { LANGS, MAINTAINED_LANGS, FROZEN_LANGS } from "./shared.mjs";

const TEXT_WORD = {
  en: /\btext\b/i,
  zh: /文本/,
  ja: /テキスト/,
  ko: /텍스트/,
  de: /Text/,
  fr: /texte/i,
  es: /texto/i,
  pt: /texto/i,
  // منصّة ("platform") contains the letters نص back to back, and "pick your
  // platform" is exactly how the hero pitch ends — a bare /نص/ makes the Arabic
  // cell always true. Exclude the م-prefixed form so the assertion has teeth.
  ar: /(?<!م)نص/,
};

// The platform cards are positional in every locale: web, CLI, macOS, iOS.
// Both shipped platforms get the same treatment — the web app has carried
// "Send a message" as long as the transfer UI has.
const WEB_CARD = 0;
const CLI_CARD = 1;

describe("/apps web and CLI copy covers files and ephemeral text", () => {
  for (const [name, card] of [
    ["web", WEB_CARD],
    ["CLI", CLI_CARD],
  ]) {
    it(`names text in the ${name} picker bullet and card, in every locale`, () => {
      for (const lang of LANGS) {
        const doc = apps.langs[lang];
        expect(doc.how.steps[card], `${lang} /apps ${name} bullet is still file-only`).toMatch(TEXT_WORD[lang]);
        expect(doc.why.items[card].desc, `${lang} /apps ${name} card is still file-only`).toMatch(TEXT_WORD[lang]);
      }
    });
  }

  it("names text in the page description and the hero pitch, in every locale", () => {
    // These two are the page's own positioning: the <meta description> a crawler
    // indexes, and the first sentence a no-JS reader sees.
    for (const lang of LANGS) {
      const doc = apps.langs[lang];
      expect(doc.description, `${lang} /apps description is still file-only`).toMatch(TEXT_WORD[lang]);
      expect(doc.hero.pitch, `${lang} /apps hero pitch is still file-only`).toMatch(TEXT_WORD[lang]);
    }
  });

});

// The native half of this file used to assert the opposite: that the macOS and
// iOS cards must NOT mention text, because neither client had a text session.
// Both do now — macOS by pairing code and nearby, iOS since R3-D/E/F — so the
// old guard was keeping a stale sentence green. What is still untrue is the
// store distribution: neither app is on any store.
const FILE_WORD = {
  en: /\bfiles?\b/i,
  zh: /文件/,
  ja: /ファイル/,
  ko: /파일/,
  de: /Datei/i,
  fr: /fichier/i,
  es: /archivo/i,
  pt: /arquivo/i,
  ar: /ملف/,
};

// Apple leaves the store name untranslated in all nine locales, so one pattern
// covers every doc. "Coming to the App Store" is a distribution promise with
// nothing behind it; the page's own "coming soon" grouping states the status.
const STORE_CLAIM = /app\s*store/i;

// Per-locale, and used in BOTH directions now: required of the two maintained
// docs, forbidden of the seven archived ones. Matching only Latin spellings
// would make every non-English cell of the archive check vacuously true, which
// is the same reason TEXT_WORD above is per-locale.
const SHARE_SHEET = {
  en: /share[\s-]?sheet|share extension/i,
  zh: /系统分享面板|分享面板|分享菜单|共享菜单|分享扩展/,
  ja: /共有シート|共有機能拡張/,
  ko: /공유 시트|공유 확장/,
  de: /Teilen-Menü|Share Extension/i,
  fr: /feuille de partage|extension de partage/i,
  es: /hoja de compartir|extensión de compartir/i,
  pt: /folha de compartilhamento|extensão de compartilhamento/i,
  ar: /ورقة المشاركة|امتداد المشاركة/,
};

const MAC_CARD = 2;
const IOS_CARD = 3;

describe("/apps native copy matches what the native apps actually do", () => {
  it("gives both native cards their shipped file and text capability, in every locale", () => {
    for (const lang of LANGS) {
      const { items } = apps.langs[lang].why;
      for (const i of [MAC_CARD, IOS_CARD]) {
        expect(items[i].desc, `${lang} native card ${i} dropped its text capability`).toMatch(TEXT_WORD[lang]);
        expect(items[i].desc, `${lang} native card ${i} dropped its file capability`).toMatch(FILE_WORD[lang]);
      }
    }
  });

  it("promises no store distribution in the bullets or the cards", () => {
    for (const lang of LANGS) {
      const doc = apps.langs[lang];
      for (const i of [MAC_CARD, IOS_CARD]) {
        expect(doc.how.steps[i], `${lang} bullet ${i} promises store distribution`).not.toMatch(STORE_CLAIM);
        expect(doc.why.items[i].desc, `${lang} card ${i} promises store distribution`).not.toMatch(STORE_CLAIM);
      }
    }
  });

  it("names the shipped iOS Share Extension in the maintained bullet and card", () => {
    // `apps/ios/RelayiumShare` is a real `com.apple.share-services` target
    // embedded at `PlugIns/RelayiumShare.appex`. This assertion is the inverse
    // of the one it replaces: while the target did not exist, the page naming a
    // share sheet was the lie; now the page omitting it is.
    for (const lang of MAINTAINED_LANGS) {
      const doc = apps.langs[lang];
      expect(doc.how.steps[IOS_CARD], `${lang} iOS bullet hides the shipped Share Extension`).toMatch(SHARE_SHEET[lang]);
      expect(doc.why.items[IOS_CARD].desc, `${lang} iOS card hides the shipped Share Extension`).toMatch(SHARE_SHEET[lang]);
    }
  });

  it("leaves the archived locales the copy they were published with", () => {
    // The seven are preserved, not retranslated: back-filling one sentence into
    // a page whose surrounding paragraphs are frozen produces a page that is
    // current in one place and stale everywhere else, which reads as current
    // throughout. The archived-translation notice the template renders is the
    // only thing these pages gain.
    for (const lang of FROZEN_LANGS) {
      const doc = apps.langs[lang];
      expect(doc.how.steps[IOS_CARD], `${lang} archive was given the new iOS bullet`).not.toMatch(SHARE_SHEET[lang]);
      expect(doc.why.items[IOS_CARD].desc, `${lang} archive was given the new iOS card`).not.toMatch(SHARE_SHEET[lang]);
    }
  });

  // English is the master the other eight are translated from; pinning the
  // exact boundaries here beats copying eight sentences into the test.
  it("keeps the English boundaries between shipped and unshipped work", () => {
    const doc = apps.langs.en;
    expect(doc.why.items[IOS_CARD].desc).toMatch(/while the app is open/i);
    expect(doc.why.items[IOS_CARD].desc).not.toMatch(/background|notification|push\b/i);
    // The page-level positioning scoped ephemeral text to web + CLI; both
    // native clients now send text too.
    expect(doc.description).not.toMatch(/text in the web app and the CLI/i);
    expect(doc.hero.pitch).not.toMatch(/text in the web app and the CLI/i);
    // iOS is a real, running app now — "planned" understates it as badly as a
    // store date overstates it.
    expect(doc.compare.items[1].body).not.toMatch(/iOS planned|with iOS planned/i);
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
    // Both ends online, nothing kept server-side — and the honest caveat that
    // the other machine can keep what it receives. "never stored on any
    // server" claimed more than the protocol delivers.
    expect(item.desc).toMatch(/both ends stay online/i);
    expect(item.desc).toMatch(/no message bodies and no server-side history/i);
    expect(item.desc).toMatch(/copy or keep/i);
    expect(item.desc).not.toMatch(/never stored|persistent history/i);
  });
});
