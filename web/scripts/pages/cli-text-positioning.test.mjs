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
// Both did by then — macOS by pairing code and nearby, iOS since R3-D/E/F — so
// the old guard was keeping a stale sentence green.
//
// It moved again on 2026-08-28. The maintained pair no longer has an iOS card:
// `apps/` holds no Android or Windows target and iOS development is paused with
// no public listing, so the maintained docs carry web / CLI / macOS / "every
// other platform" and the archived seven keep the four they were published
// with. Card index 3 therefore means two different things depending on which
// set a locale is in, and every assertion below now says which set it is about
// rather than sharing one index constant across both.
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
// covers every doc.
//
// The Mac App Store is subtracted first. That listing went public on 2026-08-26
// (`web/mac-app-store-release.json`), so naming it is a fact and not a promise;
// a bare "App Store" for an unlisted app still is one, which is what this
// catches. The same subtraction is applied by `apps-claim-rules.ts` across the
// whole page — this file only keeps the narrower per-card form.
const STORE_CLAIM = /app\s*store/i;
const withoutMacStore = (text) => text.replace(/\bMac App Store\b/gi, " ");

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
/** Card 3. The iOS card in the archived seven; "every other platform" in en/zh. */
const FOURTH_CARD = 3;

describe("/apps native copy matches what the native apps actually do", () => {
  it("gives the macOS card its shipped file and text capability, in every locale", () => {
    for (const lang of LANGS) {
      const { desc } = apps.langs[lang].why.items[MAC_CARD];
      expect(desc, `${lang} macOS card dropped its text capability`).toMatch(TEXT_WORD[lang]);
      expect(desc, `${lang} macOS card dropped its file capability`).toMatch(FILE_WORD[lang]);
    }
  });

  it("gives the archived iOS card its file and text capability", () => {
    // The seven still describe an iOS app, because they are frozen. While that
    // description is published, it has to stay as accurate as it was.
    for (const lang of FROZEN_LANGS) {
      const { desc } = apps.langs[lang].why.items[FOURTH_CARD];
      expect(desc, `${lang} archived iOS card dropped its text capability`).toMatch(TEXT_WORD[lang]);
      expect(desc, `${lang} archived iOS card dropped its file capability`).toMatch(FILE_WORD[lang]);
    }
  });

  it("promises no store distribution beyond the one listing that exists", () => {
    // The Mac App Store is subtracted, so what is left is a claim about a store
    // Relayium is not on. Every card is swept, not only the native ones: a
    // claim moved into another bullet is the same claim.
    for (const lang of LANGS) {
      const doc = apps.langs[lang];
      for (const [i, step] of doc.how.steps.entries()) {
        expect(withoutMacStore(step), `${lang} bullet ${i} promises store distribution`)
          .not.toMatch(STORE_CLAIM);
      }
      for (const [i, item] of doc.why.items.entries()) {
        expect(withoutMacStore(item.desc), `${lang} card ${i} promises store distribution`)
          .not.toMatch(STORE_CLAIM);
      }
    }
  });

  it("names the Mac App Store in the maintained macOS card", () => {
    // Positive, because the whole point of relaxing the ban is that the page
    // states the fact. Maintained only: the archives keep their published copy.
    for (const lang of MAINTAINED_LANGS) {
      expect(apps.langs[lang].why.items[MAC_CARD].desc, `${lang} macOS card hides the App Store channel`)
        .toMatch(/Mac App Store/);
    }
  });

  it("leaves the archived locales the iOS copy they were published with", () => {
    // The seven are preserved, not retranslated: back-filling one sentence into
    // a page whose surrounding paragraphs are frozen produces a page that is
    // current in one place and stale everywhere else, which reads as current
    // throughout. The archived-translation notice the template renders is the
    // only thing these pages gain. They were never given the maintained pair's
    // Share-Extension sentence, and they keep not having it.
    for (const lang of FROZEN_LANGS) {
      const doc = apps.langs[lang];
      expect(doc.how.steps[FOURTH_CARD], `${lang} archive was given the maintained iOS bullet`)
        .not.toMatch(SHARE_SHEET[lang]);
      expect(doc.why.items[FOURTH_CARD].desc, `${lang} archive was given the maintained iOS card`)
        .not.toMatch(SHARE_SHEET[lang]);
    }
  });

  // English is the master the archived eight were translated from; pinning the
  // exact boundaries here beats copying eight sentences into the test.
  it("keeps the English boundaries between shipped and unshipped work", () => {
    const doc = apps.langs.en;
    // The fourth card is no longer about iOS. It is the answer for every
    // platform with no client, and its job is to name them and point at the
    // browser rather than to describe an app.
    const fourth = doc.why.items[FOURTH_CARD].desc;
    expect(fourth).toMatch(/iPhone, iPad, Android, Windows and Linux/);
    expect(fourth).toMatch(/publishes no app for those platforms/i);
    expect(fourth).not.toMatch(/background|notification|push\b/i);
    // The page-level positioning scoped ephemeral text to web + CLI; the macOS
    // client sends text too.
    expect(doc.description).not.toMatch(/text in the web app and the CLI/i);
    expect(doc.hero.pitch).not.toMatch(/text in the web app and the CLI/i);
    // …and neither the title nor the description may list a platform whose app
    // does not exist. Both did until 2026-08-28.
    expect(doc.title).not.toMatch(/\biOS\b|\bAndroid\b/i);
    expect(doc.description).not.toMatch(/\biOS\b|\bAndroid\b/i);
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
