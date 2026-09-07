// web/src/lib/i18n-transfer-product-names.test.ts — the three transfer
// destinations have one name each, in both maintained languages, and none of
// them is named after how it is built.
//
// Relayium has three sibling ways to move something, and the name is the first
// thing that tells a person which one they are on:
//
//   局域网传输  / LAN               same network, no account
//   配对传输    / Pairing transfer  a 6-digit code; a shared network is not required
//   分享链接    / Share a link      encrypt, store, hand over a link
//
// The stale names of every previous round are kept verbatim as rejections —
// `realtime` and `direct` on the pairing destination, `async` on the stored one
// — so this guard recognises each defect it has seen and not only the last fix.
// `direct` matters most: `MacSurface.lanTransfer`'s comment records that the
// client cannot tell a direct path from a relayed one, and that destination
// routinely runs over TURN.
//
// **What the names stopped carrying, prose still carries.** `crossnet.realtimeSub`
// still says the session is live and `homeCross.desc` still says the pairing
// destination works across networks; both are asserted below, because otherwise
// "stop naming it after the mechanism" would be indistinguishable from "stop
// mentioning the mechanism".
//
// The token tables are per language and written by hand, so that somebody had
// to read each translation and confirm the name survived it.
//
// The native side of the same invariant — macOS rows and iOS tabs — is
// `TransferDestinationNamingTests` in RelayiumKit, because those strings live
// in `.lproj` catalogs this suite cannot read.
import { describe, expect, it } from "vitest";
import en from "./i18n/en";
import zh from "./i18n/zh";

const locales = { en, zh };
type Code = keyof typeof locales;

type Tokens = {
  /** This language's way of naming the pairing-code destination. */
  pairing: RegExp;
  /** This language's way of naming the stored-link destination. */
  shareLink: RegExp;
  /** This language's way of saying "same/local network" — LAN's own name. */
  lan: RegExp;
  /** Names that shipped on the pairing destination and may never return: the
   *  transport (`realtime`) and the false path claim (`direct`). */
  stalePairing: RegExp[];
  /** The jargon that shipped on the stored destination. */
  staleStored: RegExp;
  /** Real-time wording that must remain available as description. */
  liveDescription: RegExp;
  /** The reach-another-network fact, which is no longer in the name. */
  crossNetwork: RegExp;
};

const t: Record<Code, Tokens> = {
  en: {
    pairing: /pairing/i,
    // "Share a link" is the name; "sharing a link" is the same name inside a
    // sentence. Both are the destination, and a token that matched only the
    // first would push the prose back to naming it something else.
    shareLink: /shar(e|ing) a link/i,
    lan: /\bLAN\b/,
    stalePairing: [/^realtime(\s|$)|^realtime transfer$/i, /^direct(\s|$)|^direct transfer$/i],
    staleStored: /^async(\s|$)|^async transfer$/i,
    liveDescription: /live|real time|online now/i,
    crossNetwork: /across networks|cross-network/i,
  },
  zh: {
    pairing: /配对/,
    shareLink: /分享链接/,
    lan: /局域网|LAN/,
    stalePairing: [/^实时传输$|^实时$/, /^直连$|^直连传输$/],
    staleStored: /^异步传输$|^异步$/,
    liveDescription: /实时|在线/,
    crossNetwork: /跨网络/,
  },
};

/**
 * Every surface that NAMES the pairing destination, as opposed to describing
 * what happens on it. Each of these is read as "which product am I looking
 * at?": the navigation tab, the page's own heading, the card heading before and
 * during a session, the comparison column a person picks from — and
 * `emptyCrossCta`, which is the LAN empty state's only route to this
 * destination and therefore the naming surface most likely to be read by
 * somebody who has not yet chosen one.
 */
function pairingNames(m: typeof en): Record<string, string> {
  return {
    "nav.crossTab": m.nav.crossTab,
    crossTitle: m.crossTitle,
    emptyCrossCta: m.emptyCrossCta,
    "crossSell.realtime.cta": m.crossSell.realtime.cta,
    "homeCross.realtimeCta": m.homeCross.realtimeCta,
    "methods.realtime.name": m.methods.realtime.name,
    "crossnet.realtimeTitle": m.crossnet.realtimeTitle,
    "compare.colRealtime": m.compare.colRealtime,
  };
}

/** Every surface that NAMES the stored-link destination. */
function storedNames(m: typeof en): Record<string, string> {
  return {
    "nav.offlineTab": m.nav.offlineTab,
    offlineTitle: m.offlineTitle,
    "methods.stored.name": m.methods.stored.name,
    "compare.colStored": m.compare.colStored,
    "crossSell.offline.cta": m.crossSell.offline.cta,
    "homeCross.offlineCta": m.homeCross.offlineCta,
  };
}

/** The LAN destination's own naming surfaces, for the sibling comparison. */
function lanNames(m: typeof en): Record<string, string> {
  return { "nav.lanTab": m.nav.lanTab, "compare.colLan": m.compare.colLan };
}

describe("the three transfer destinations are named as siblings", () => {
  for (const [code, m] of Object.entries(locales) as [Code, typeof en][]) {
    const tok = t[code];

    it(`${code} names the pairing destination after the pairing code, everywhere`, () => {
      for (const [key, value] of Object.entries(pairingNames(m))) {
        expect(value.trim(), `${code}: ${key} is empty`).toBeTruthy();
        expect(value, `${code}: ${key} does not name the pairing product`)
          .toMatch(tok.pairing);
        for (const stale of tok.stalePairing) {
          expect(value, `${code}: ${key} names the destination after its transport or claims a direct path`)
            .not.toMatch(stale);
        }
      }
    });

    it(`${code} names the stored destination after the link it hands over, everywhere`, () => {
      for (const [key, value] of Object.entries(storedNames(m))) {
        expect(value.trim(), `${code}: ${key} is empty`).toBeTruthy();
        expect(value, `${code}: ${key} does not name the link-sharing product`)
          .toMatch(tok.shareLink);
        expect(value, `${code}: ${key} still calls the destination "async"`)
          .not.toMatch(tok.staleStored);
      }
    });

    it(`${code} keeps LAN's own name on LAN's surfaces`, () => {
      // The renames must not drag the sibling with them: destinations that all
      // say "network" and nothing else are not a choice.
      for (const [key, value] of Object.entries(lanNames(m))) {
        expect(value, `${code}: ${key} lost the LAN name`).toMatch(tok.lan);
        expect(value, `${code}: ${key} now claims to be the pairing product`)
          .not.toMatch(tok.pairing);
      }
    });

    it(`${code} uses one name across tab, heading, card and comparison`, () => {
      // Not string equality: a tab is abbreviated and a heading is not. What
      // must hold is that the same distinguishing word appears in all of them,
      // which is what makes the tab, the page and the table one destination.
      for (const [label, names, token] of [
        ["pairing", Object.values(pairingNames(m)), tok.pairing],
        ["stored", Object.values(storedNames(m)), tok.shareLink],
      ] as const) {
        const shared = names.filter((n) => token.test(n));
        expect(shared.length, `${code}: only ${shared.length}/${names.length} ${label} naming surfaces agree`)
          .toBe(names.length);
      }
    });

    it(`${code} still describes the session as live, in prose`, () => {
      // Real time did not stop being true; it stopped being the name. The
      // sub-heading under the active card is where a person learns the session
      // needs both sides present, so removing it would be a different defect.
      expect(m.crossnet.realtimeSub, `${code}: the live nature of the session went missing`)
        .toMatch(tok.liveDescription);
    });

    it(`${code} still says the pairing destination reaches another network`, () => {
      // The reason the previous name existed. It is the fact a person needs
      // when the two devices are not on one Wi-Fi, and dropping the word
      // "cross-network" from the NAME may not drop the fact from the product.
      // `homeCross` is the card that exists to answer exactly that question.
      expect(m.homeCross.desc, `${code}: nothing says the pairing destination crosses networks`)
        .toMatch(tok.crossNetwork);
    });

    it(`${code} answers "which mode" with all three destination names`, () => {
      // The comparison sub-line is the one sentence that puts the choice in
      // words. It named the mode "realtime" while the column above it said
      // something else in five of nine languages.
      expect(m.compare.sub, `${code}: the mode comparison never names the pairing destination`)
        .toMatch(tok.pairing);
      expect(m.compare.sub, `${code}: the mode comparison never names LAN`).toMatch(tok.lan);
      expect(m.compare.sub, `${code}: the mode comparison never names the stored destination`)
        .toMatch(tok.shareLink);
    });
  }
});
