// web/src/lib/i18n-transfer-product-names.test.ts — the three transfer
// destinations have one name each, in both maintained languages, and none of
// them is named after the operation you perform on it.
//
// Relayium has three sibling ways to move something, and the name is the first
// thing that tells a person which one they are on:
//
//   局域网传输    / LAN                     same network, no account
//   跨网络传输    / Cross-network transfer  both sides online; no shared network needed
//   分享链接      / Share a link            encrypt, store, hand over a link
//
// **Why the middle one is named after the networks again.** It shipped for a
// while as 配对传输 / Pairing transfer, named after the thing you type in. The
// owner's finding was that this is not understandable: "pairing" answers "what
// do I do here", and a destination name has to answer "which of the three is
// this" — which, for this one, is whether the two devices have to share a
// network. `nav.crossTab` is the full name and `shell.crossShort` is its
// compact form; both are asserted, because the compact label is the ONLY name
// a phone shows and a rename that stopped at the desktop row would leave the
// old product name shipping on the smaller screen.
//
// The stale names of every previous round are kept verbatim as rejections —
// `realtime`, `direct` and now `pairing` on this destination, `async` on the
// stored one — so this guard recognises each defect it has seen and not only
// the last fix. `direct` matters most: `MacSurface.lanTransfer`'s comment
// records that the client cannot tell a direct path from a relayed one, and
// that destination routinely runs over TURN.
//
// **The pairing code did not go away; it stopped being the name.** It is the
// operation, and `shell.pairGroup` and the `pair.*` controls still say so — a
// separate assertion below, because "stop naming the destination after the code"
// and "stop mentioning the code" are different changes and only one of them was
// asked for. The same split protects the live-session fact (`crossnet.realtimeSub`)
// and the reaches-another-network fact (`homeCross.desc`).
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
  /** This language's way of naming the cross-network destination. */
  crossNetwork: RegExp;
  /** This language's way of naming the stored-link destination. */
  shareLink: RegExp;
  /** This language's way of saying "same/local network" — LAN's own name. */
  lan: RegExp;
  /** Names that shipped on the cross-network destination and may never return:
   *  the transport (`realtime`), the false path claim (`direct`), and the
   *  operation (`pairing`) — the last one anchored so that it rejects the
   *  destination name and the bare compact label without touching a sentence
   *  that merely mentions a pairing code. */
  staleCross: RegExp[];
  /** The jargon that shipped on the stored destination. */
  staleStored: RegExp;
  /** Real-time wording that must remain available as description. */
  liveDescription: RegExp;
  /** "Reaches another network" as a FACT, phrased so that the destination's own
   *  name cannot satisfy it on its own. */
  crossNetworkFact: RegExp;
  /** The pairing code, as the operation it still is. */
  pairingCode: RegExp;
  /** "Both devices are present at the same time". */
  bothOnline: RegExp;
  /** Claims that a shared network is DISALLOWED here. It is not: this
   *  destination also connects two devices that happen to share one. */
  sameNetworkExcluded: RegExp;
};

const t: Record<Code, Tokens> = {
  en: {
    crossNetwork: /cross-network/i,
    // "Share a link" is the name; "sharing a link" is the same name inside a
    // sentence. Both are the destination, and a token that matched only the
    // first would push the prose back to naming it something else.
    shareLink: /shar(e|ing) a link/i,
    lan: /\bLAN\b/,
    staleCross: [
      /^realtime(\s|$)|^realtime transfer$/i,
      /^direct(\s|$)|^direct transfer$/i,
      /^pairing$|\bpairing transfers?\b/i,
    ],
    staleStored: /^async(\s|$)|^async transfer$/i,
    liveDescription: /live|real time|online now/i,
    crossNetworkFact: /across networks/i,
    pairingCode: /pairing code/i,
    bothOnline: /both devices online|both sides online|both online/i,
    sameNetworkExcluded: /only (?:works )?across networks|not on the same network|different networks only/i,
  },
  zh: {
    crossNetwork: /跨网络/,
    shareLink: /分享链接/,
    lan: /局域网|LAN/,
    staleCross: [/^实时传输$|^实时$/, /^直连$|^直连传输$/, /^配对$|配对传输/],
    staleStored: /^异步传输$|^异步$/,
    liveDescription: /实时|在线/,
    crossNetworkFact: /跨网络也可以|跨网络都可以/,
    pairingCode: /配对码/,
    bothOnline: /双方.*在线|两端.*在线/,
    sameNetworkExcluded: /仅.*跨网络|只能跨网络|不能在同一网络|必须不在同一网络/,
  },
};

/**
 * Every surface that NAMES the cross-network destination, as opposed to
 * describing what happens on it. Each of these is read as "which product am I
 * looking at?": the navigation tab and its compact phone label, the page's own
 * heading, the card heading, the comparison column a person picks from — and
 * `emptyCrossCta`, which is the LAN empty state's only route to this
 * destination and therefore the naming surface most likely to be read by
 * somebody who has not yet chosen one.
 */
function crossNetworkNames(m: typeof en): Record<string, string> {
  return {
    "nav.crossTab": m.nav.crossTab,
    "shell.crossShort": m.shell.crossShort,
    crossTitle: m.crossTitle,
    emptyCrossCta: m.emptyCrossCta,
    "crossSell.realtime.cta": m.crossSell.realtime.cta,
    "homeCross.realtimeCta": m.homeCross.realtimeCta,
    "methods.realtime.name": m.methods.realtime.name,
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

    it(`${code} names the cross-network destination after the networks, everywhere`, () => {
      for (const [key, value] of Object.entries(crossNetworkNames(m))) {
        expect(value.trim(), `${code}: ${key} is empty`).toBeTruthy();
        expect(value, `${code}: ${key} does not name the cross-network product`)
          .toMatch(tok.crossNetwork);
        for (const stale of tok.staleCross) {
          expect(value, `${code}: ${key} names the destination after its transport, its operation, or claims a direct path`)
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
        expect(value, `${code}: ${key} now claims to be the cross-network product`)
          .not.toMatch(tok.crossNetwork);
      }
    });

    it(`${code} uses one name across tab, compact label, heading and comparison`, () => {
      // Not string equality: a phone label is abbreviated and a heading is not.
      // What must hold is that the same distinguishing word appears in all of
      // them, which is what makes the tab, the page and the table one
      // destination.
      for (const [label, names, token] of [
        ["cross-network", Object.values(crossNetworkNames(m)), tok.crossNetwork],
        ["stored", Object.values(storedNames(m)), tok.shareLink],
      ] as const) {
        const shared = names.filter((n) => token.test(n));
        expect(shared.length, `${code}: only ${shared.length}/${names.length} ${label} naming surfaces agree`)
          .toBe(names.length);
      }
    });

    it(`${code} keeps the compact label addressable by what it says`, () => {
      // WCAG 2.5.3, the same rule Nav.test.ts checks on the rendered chip,
      // asserted here on the translation pair itself: the phone shows
      // `crossShort` and announces `nav.crossTab`, so the short one has to be
      // part of the long one. A rename that changed only one side would pass
      // the naming assertions above and still break speech input.
      expect(m.nav.crossTab, `${code}: the compact label is not part of the full name`)
        .toContain(m.shell.crossShort);
    });

    it(`${code} still describes the session as live, in prose`, () => {
      // Real time did not stop being true; it stopped being the name. The
      // sub-heading under the active card is where a person learns the session
      // needs both sides present, so removing it would be a different defect.
      expect(m.crossnet.realtimeSub, `${code}: the live nature of the session went missing`)
        .toMatch(tok.liveDescription);
    });

    it(`${code} still says the destination reaches another network, in prose`, () => {
      // The fact, not the name — `crossNetworkFact` is phrased so that printing
      // the destination's own name cannot satisfy it. `homeCross` is the card
      // that exists to answer exactly the question "we are not on one Wi-Fi".
      expect(m.homeCross.desc, `${code}: nothing states the cross-network fact`)
        .toMatch(tok.crossNetworkFact);
    });

    it(`${code} keeps the pairing code as the operation it still is`, () => {
      // The destination stopped being NAMED after the code. The code is still
      // what you create, read out and type in, and the controls that do it have
      // to keep saying so — otherwise "stop naming it after the operation"
      // would be indistinguishable from "stop naming the operation".
      for (const [key, value] of [
        ["shell.pairGroup", m.shell.pairGroup],
        ["pair.sendCode", m.pair.sendCode],
        ["pair.enterCode", m.pair.enterCode],
      ] as const) {
        expect(value, `${code}: ${key} no longer names the pairing code`).toMatch(tok.pairingCode);
      }
    });

    it(`${code} answers "which mode" with all three destination names`, () => {
      // The comparison sub-line is the one sentence that puts the choice in
      // words. It named the mode "realtime" while the column above it said
      // something else in five of nine languages.
      expect(m.compare.sub, `${code}: the mode comparison never names the cross-network destination`)
        .toMatch(tok.crossNetwork);
      expect(m.compare.sub, `${code}: the mode comparison never names LAN`).toMatch(tok.lan);
      expect(m.compare.sub, `${code}: the mode comparison never names the stored destination`)
        .toMatch(tok.shareLink);
    });

    it(`${code} answers "what is this page" on the cross-network first screen`, () => {
      // The subtitle under the <h1>. The name alone says which of the three
      // this is; these are the three things a person needs before touching a
      // control, and the reason the old name was readable at all.
      const sub = m.crossSubtitle;
      expect(sub.trim(), `${code}: crossSubtitle is empty`).toBeTruthy();
      expect(sub, `${code}: the subtitle never says both devices have to be there`)
        .toMatch(tok.bothOnline);
      expect(sub, `${code}: the subtitle never says how the two are joined`)
        .toMatch(tok.pairingCode);
      // The FACT token, not the name token: the <h1> directly above already
      // prints the name, so asserting the name here would pass on an echo.
      expect(sub, `${code}: the subtitle never says it reaches another network`)
        .toMatch(tok.crossNetworkFact);
      // A shared network is not a disqualification here — this destination
      // connects two devices on one network as readily as two on different
      // ones. Copy that reads as a restriction would send those people to LAN
      // and leave them stuck when AP isolation blocks discovery.
      expect(sub, `${code}: the subtitle claims only different networks are supported`)
        .not.toMatch(tok.sameNetworkExcluded);
    });
  }
});
