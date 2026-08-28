// web/scripts/pages/apps-generated-twin.test.mjs — /apps is two artifacts, and
// they have to say the same thing.
//
// The SPA (src/lib/AppsPage.svelte, from the i18n tables) is what a person with
// JavaScript sees. The prose in content/apps.mjs is what a crawler, an answer
// engine, a link unfurler and a JS-less reader see — at the same URL. They
// drifted before: /device-inbox kept badging macOS "In testing" for three
// published releases because the page had two answers to "is the Mac app out",
// and only one of them was maintained. This file is the pair of eyes on that.
//
// The banned-claim list is IMPORTED from the SPA-side test rather than restated
// here, because two copies of a rule is the same defect one level up.
import { describe, it, expect } from "vitest";
import apps from "./content/apps.mjs";
import { MAINTAINED_LANGS, FROZEN_LANGS } from "./shared.mjs";
import en from "../../src/lib/i18n/en.ts";
import zh from "../../src/lib/i18n/zh.ts";
import { FORBIDDEN_APP_CLAIMS, violatesClaim } from "../../src/lib/apps-claim-rules.ts";

const APP = { en, zh };

/** Every string in a value, so a claim is caught wherever it was moved to. */
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

describe("the generated /apps prose obeys the same claim rules as the SPA", () => {
  it.each(MAINTAINED_LANGS)("%s says none of the forbidden things", (lang) => {
    // Walked as VALUES, not as source text: apps.mjs's own comments name the
    // banned words in order to explain why they are banned, so a source-text
    // scan trips on its own documentation. (It did, on the first run.)
    const copy = strings(apps.langs[lang]);
    expect(copy.length, `${lang} has no copy to check`).toBeGreaterThan(15);
    for (const rule of FORBIDDEN_APP_CLAIMS) {
      expect(copy.find((s) => violatesClaim(s, rule)), `${lang}: ${rule.why}`).toBeUndefined();
    }
  });

  it("leaves the archived /apps pages their published copy", () => {
    // The seven are archived, not rewritten. They keep the release-status facts
    // macos-release-surface.test.mjs enforces (signed/notarized when there is a
    // download, "not publicly available yet" when there is not) and they do NOT
    // get the maintained platform copy — the only thing added to them is the
    // archived-translation notice the template renders.
    //
    // This is also why the forbidden-claim sweep above is MAINTAINED_LANGS and
    // not LANGS: the archived seven still describe an iOS app, which the
    // maintained pair may no longer do. Freezing a translation means freezing
    // what it says, and a page that carried the notice while being silently
    // rewritten would be an archive in name only.
    for (const lang of FROZEN_LANGS) {
      const doc = apps.langs[lang];
      expect(doc, `${lang} lost its archived /apps page`).toBeTruthy();
      expect(doc.how.steps.length, `${lang} was given the maintained platform bullets`).toBe(4);
      expect(doc.compare.items.length, `${lang} was given the maintained comparison`).toBe(2);
    }
  });
});

describe("the maintained twin carries the same product facts as the SPA", () => {
  it("names no platform this repository does not ship, on either surface", () => {
    // The three cards removed on 2026-08-28. Asserted on both surfaces because
    // the failure this file exists for is asymmetric drift: /device-inbox kept
    // badging macOS "In testing" for three published releases because the page
    // had two answers and only one of them was maintained.
    for (const lang of MAINTAINED_LANGS) {
      const prose = strings(apps.langs[lang]).join("\n");
      const spa = strings(APP[lang].appsPage).join("\n");
      expect(APP[lang].appsPage.cards.ios, `${lang} SPA still has an iOS card`).toBeUndefined();
      expect(APP[lang].appsPage.cards.android, `${lang} SPA still has an Android card`).toBeUndefined();
      expect(APP[lang].appsPage.cards.windows, `${lang} SPA still has a Windows card`).toBeUndefined();
      for (const [surface, copy] of [["static", prose], ["SPA", spa]]) {
        expect(copy, `${lang} ${surface} /apps still describes a native app for an unshipped platform`)
          .not.toMatch(/\b(?:iOS|iPhone|iPad|Android|Windows)\s+(?:native\s+|desktop\s+)*app\b|(?:iOS|iPhone|iPad|Android|Windows)\s*(?:桌面)?(?:原生)?应用/i);
      }
    }
  });

  it("still answers the reader on those platforms, rather than going silent", () => {
    // Deleting three cards must not delete the answer they carried. The OS
    // names stay — what changes is that they point at the browser and the CLI,
    // which is what actually serves those readers today.
    const facts = {
      en: [/iPhone, iPad, Android, Windows and Linux/, /command line/i, /nothing to install/i],
      zh: [/iPhone、iPad、Android、Windows 与 Linux/, /命令行/, /无需安装/],
    };
    for (const lang of MAINTAINED_LANGS) {
      const prose = strings(apps.langs[lang]).join("\n");
      const spa = strings(APP[lang].appsPage).join("\n");
      for (const re of facts[lang]) {
        expect(prose, `${lang} static /apps drops ${re}`).toMatch(re);
        expect(spa, `${lang} SPA /apps drops ${re}`).toMatch(re);
      }
    }
  });

  it("names the Mac App Store on both surfaces", () => {
    // The listing is public (web/mac-app-store-release.json) and the page was
    // forbidden from saying so until 2026-08-28. Required positively, because
    // simply lifting the ban leaves a page that is just as silent and passes.
    for (const lang of MAINTAINED_LANGS) {
      expect(strings(apps.langs[lang]).join("\n"), `${lang} static /apps hides the App Store channel`)
        .toMatch(/Mac App Store/);
      expect(strings(APP[lang].appsPage).join("\n"), `${lang} SPA /apps hides the App Store channel`)
        .toMatch(/Mac App Store/);
    }
  });

  it("carries the Web-versus-native section on both surfaces, with the same heading", () => {
    for (const lang of MAINTAINED_LANGS) {
      expect(apps.langs[lang].compare.heading, `${lang} static heading`)
        .toBe(APP[lang].appsPage.chooser.heading);
      // Three blocks on the static side (web, macOS, everywhere else) against
      // the SPA's two columns plus its footnote — same three facts, laid out
      // for two different media.
      expect(apps.langs[lang].compare.items.length, `${lang} static comparison`).toBe(3);
    }
  });

  it("makes the same five macOS claims in the prose that the SPA makes in the cards", () => {
    const CLAIMS = {
      en: [/menu bar/i, /Share menu/i, /Open With/i, /opens in the app/i, /Device Inbox/i],
      zh: [/菜单栏/, /分享」菜单/, /打开方式/, /直接在应用里打开/, /设备收件箱/],
    };
    for (const lang of MAINTAINED_LANGS) {
      const prose = strings(apps.langs[lang].compare).join("\n");
      const spa = strings(APP[lang].appsPage.chooser).join("\n");
      for (const re of CLAIMS[lang]) {
        expect(prose, `${lang} static comparison drops ${re}`).toMatch(re);
        expect(spa, `${lang} SPA comparison drops ${re}`).toMatch(re);
      }
    }
  });
});
