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
import { FORBIDDEN_APP_CLAIMS } from "../../src/lib/apps-claim-rules.ts";

const APP = { en, zh };

/** Every string in a value, so a claim is caught wherever it was moved to. */
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

describe("the generated /apps prose obeys the same claim rules as the SPA", () => {
  it.each(MAINTAINED_LANGS)("%s says none of the five forbidden things", (lang) => {
    // Walked as VALUES, not as source text: apps.mjs's own comments name the
    // banned words in order to explain why they are banned, so a source-text
    // scan trips on its own documentation. (It did, on the first run.)
    const copy = strings(apps.langs[lang]);
    expect(copy.length, `${lang} has no copy to check`).toBeGreaterThan(20);
    for (const { why, re } of FORBIDDEN_APP_CLAIMS) {
      expect(copy.find((s) => re.test(s)), `${lang}: ${why}`).toBeUndefined();
    }
  });

  it("leaves the archived /apps pages their published copy", () => {
    // The seven are archived, not rewritten. They keep the release-status facts
    // macos-release-surface.test.mjs enforces (signed/notarized when there is a
    // download, "not publicly available yet" when there is not) and they do NOT
    // get the new platform copy — the only thing added to them is the
    // archived-translation notice the template renders.
    for (const lang of FROZEN_LANGS) {
      const doc = apps.langs[lang];
      expect(doc, `${lang} lost its archived /apps page`).toBeTruthy();
      expect(doc.how.steps.length, `${lang} was given the new platform bullets`).toBe(4);
      expect(doc.compare.items.length, `${lang} was given the new comparison`).toBe(2);
    }
  });
});

describe("the maintained twin carries the same product facts as the SPA", () => {
  it("states the Android and Windows development status in both", () => {
    for (const lang of MAINTAINED_LANGS) {
      const prose = strings(apps.langs[lang]).join("\n");
      const cards = APP[lang].appsPage.cards;
      for (const id of ["android", "windows"]) {
        // Not string equality: the static page is prose and the SPA is cards, so
        // they are allowed to word it differently. What must match is the fact.
        expect(prose, `${lang} static /apps omits ${id}`).toMatch(
          lang === "en" ? new RegExp(`${id}`, "i") : new RegExp(id === "android" ? "Android" : "Windows"),
        );
        expect(cards[id]?.name, `${lang} SPA has no ${id} card`).toBeTruthy();
        expect(cards[id]?.cta, `${lang} ${id} card must stay actionless`).toBeUndefined();
      }
    }
  });

  it("keeps the Windows CLI fact and the Android web-app pointer on both surfaces", () => {
    // The two things that stop an actionless card from being a dead end.
    const facts = {
      en: [/command line already works on Windows/i, /web app is the way to use Relayium on Android|web app runs in any Android browser/i],
      zh: [/命令行工具今天就已经支持 Windows/, /网页版/],
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

  it("carries the Web-versus-native section on both surfaces, with the same heading", () => {
    for (const lang of MAINTAINED_LANGS) {
      expect(apps.langs[lang].compare.heading, `${lang} static heading`)
        .toBe(APP[lang].appsPage.chooser.heading);
      // Three blocks on the static side (web, macOS, the iOS limitation) against
      // the SPA's two columns plus its footnote — same three facts, laid out for
      // two different media.
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

  it("keeps the iOS limitation on both, and promises nothing else about it", () => {
    const OPEN = { en: /while it is open/i, zh: /应用打开时/ };
    for (const lang of MAINTAINED_LANGS) {
      expect(strings(apps.langs[lang]).join("\n"), `${lang} static`).toMatch(OPEN[lang]);
      expect(strings(APP[lang].appsPage).join("\n"), `${lang} SPA`).toMatch(OPEN[lang]);
    }
  });
});
