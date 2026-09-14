import { describe, expect, it } from "vitest";
import en from "./en";
import zh from "./zh";
import { pricing } from "../../../scripts/pages/content/spa-pages.mjs";

// The self-host upsell used to promise that running your own node made Relayium
// "100% free", with "no limits and no fees", because "every transfer" went
// through your node. That is not what the accounting does.
//
// Three paths, three different answers:
//
//  1. Bytes RELAYED through your own node are not billable — the meter keys off
//     the node's owner (`billable = node.OwnerType == "fleet"`).
//  2. An upload that LANDS on your own node skips metering and the daily quota
//     (`TestUploadToOwnNodeSkipsQuota`).
//  3. A DOWNLOAD is only free when the client opts into fetching it straight
//     from your online node. Without that opt-in header, or with the node
//     offline, or for a burn/limited file, central proxies the bytes — Relayium
//     really pays that egress and really meters it
//     (`TestByoOwnNodeWithoutOptInIsProxiedAndMetered`).
//
// So (1) and (2) are genuinely free and must keep being advertised; (3) is not,
// and an unqualified "fully free" is a billing claim the server contradicts the
// first time a browser downloads a shared file from the user's own node.
//
// This pins both directions. Dropping the qualification is the failure that
// brought this test into existence; deleting the benefit instead would be an
// over-correction that makes the page lie in the other direction, so the
// own-node advantage is pinned as present too.
//
// Tokens are language-specific on purpose. Asserting a shared token like "node"
// would pass on a Chinese string that still says 100% 免费, which is exactly the
// locale this kind of copy fix forgets.

const locales = { en, zh };

/** The six strings the self-host claim is made in. */
function claims(t: typeof en) {
  return {
    "pricingPage.subtitle": t.pricingPage.subtitle,
    "pricingPage.selfhostTitle": t.pricingPage.selfhostTitle,
    "pricingPage.selfhostBody": t.pricingPage.selfhostBody,
    "pricingPage.a4": t.pricingPage.a4,
    "why.selfhostTitle": t.why.selfhostTitle,
    "why.selfhostBody": t.why.selfhostBody,
  };
}

/** Prose keys with room to qualify. Titles are headlines and are exempt. */
const PROSE = [
  "pricingPage.subtitle",
  "pricingPage.selfhostBody",
  "pricingPage.a4",
  "why.selfhostBody",
];

// Wording that promises an unconditional free ride. Retired verbatim phrases are
// listed alongside the general shapes: a phrase that already shipped is the one
// most likely to be pasted back.
const UNCONDITIONAL = {
  en: [
    /100%\s*free/i,
    /fully free/i,
    /no limits and no fees/i,
    /no usage limits and nothing to pay/i,
    /nothing for us to charge/i,
    /route every transfer through it/i,
    /go entirely through your node/i,
  ],
  zh: [
    /100%\s*免费/,
    /完全免费/,
    /没有任何限制和费用/,
    /没有用量限制，也无需付费/,
    /也就不收费/,
    /每一次传输都经过它/,
    /全部走你自己的节点/,
  ],
};

// The qualification that has to survive translation: downloads Relayium carries
// still draw on the plan allowance.
const QUALIFIED = {
  en: { allowance: /allowance/i, stillCounts: /(still count|count as usual|still use)/i },
  zh: { allowance: /额度/, stillCounts: /(仍会计入|照常计入|仍然计入)/ },
};

// The still-true benefit, which this correction must not delete. The EN shape is
// loose because the copy says "your own node" in some places and "your own relay
// + storage node" in others; both are the same promise.
const BENEFIT = {
  en: /your own [^.]{0,40}node/i,
  zh: /节点/,
};

// /pricing has no localized static twin, so its crawlable text is hand-mirrored
// from the English catalogue in spa-pages.mjs. A correction applied to only one
// of the two leaves the other serving the retired claim to crawlers and to
// anyone with JavaScript off.
const MIRRORED: [string, string, string][] = [
  ["pricing.description", pricing.description, en.pricingPage.subtitle],
  ["pricing.hero.pitch", pricing.hero.pitch, en.pricingPage.subtitle],
  ["pricing.compare.heading", pricing.compare.heading, en.pricingPage.selfhostTitle],
  ["pricing.compare.items[0].body", pricing.compare.items[0].body, en.pricingPage.selfhostBody],
];

describe("self-host node metering claims", () => {
  for (const [lang, t] of Object.entries(locales) as [keyof typeof UNCONDITIONAL, typeof en][]) {
    describe(lang, () => {
      it("promises no unconditional own-node free ride", () => {
        for (const [key, text] of Object.entries(claims(t))) {
          for (const stale of UNCONDITIONAL[lang]) {
            expect(text, `${lang} ${key} still claims ${stale}`).not.toMatch(stale);
          }
        }
      });

      it("says Relayium-carried downloads still use the plan allowance", () => {
        for (const key of PROSE) {
          const text = claims(t)[key as keyof ReturnType<typeof claims>];
          expect(text, `${lang} ${key} names no allowance`).toMatch(QUALIFIED[lang].allowance);
          expect(text, `${lang} ${key} does not say those bytes still count`).toMatch(
            QUALIFIED[lang].stillCounts,
          );
        }
      });

      it("still advertises the own-node advantage", () => {
        for (const [key, text] of Object.entries(claims(t))) {
          expect(text, `${lang} ${key} lost the own-node benefit`).toMatch(BENEFIT[lang]);
        }
      });
    });
  }

  describe("crawlable /pricing mirror", () => {
    it("repeats the English catalogue verbatim", () => {
      for (const [key, crawler, source] of MIRRORED) {
        expect(crawler, `${key} has drifted from its en.ts source`).toBe(source);
      }
    });

    it("answers the own-node question with the catalogue's a4", () => {
      const answers = pricing.faq.items.map((i: { a: string }) => i.a);
      expect(answers, "no FAQ answer matches pricingPage.a4").toContain(en.pricingPage.a4);
    });
  });
});
