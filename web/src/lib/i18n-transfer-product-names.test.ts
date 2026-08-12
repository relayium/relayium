// web/src/lib/i18n-transfer-product-names.test.ts — the two direct transfer
// destinations have one name each, in all nine languages.
//
// Relayium has two sibling direct-transfer products, and the name is the first
// thing that tells a person which one they are on:
//
//   局域网传输  / LAN Transfer            same network, no account
//   跨网络传输  / Cross-network Transfer  a pairing code, no shared network
//
// What shipped named the second one after its *implementation* — 实时传输 /
// Realtime / Echtzeitübertragung — which is not a choice a person can make.
// "Real time" is true of LAN transfer as well, so it distinguishes nothing; the
// question the navigation actually answers is whether the two devices share a
// network. macOS already ships `LAN Transfer` and `Cross-network Transfer` as
// two sidebar rows, so the Web tab, page heading and comparison column naming
// the same destination differently made one product read as three.
//
// The token tables are per language and written by hand, so that somebody had
// to read each translation and confirm the name survived it. `stale` is
// different in kind: those are the strings that actually shipped, kept verbatim
// so this guard recognises the defect and not only the fix.
//
// Real time stays available as DESCRIPTIVE copy — `crossnet.realtimeSub`, the
// FAQ and the comparison rows still say the session is live and needs both
// sides online. It is the destination's NAME that may not be it.
import { describe, expect, it } from "vitest";
import en from "./i18n/en";
import zh from "./i18n/zh";
import ja from "./i18n/ja";
import ko from "./i18n/ko";
import de from "./i18n/de";
import fr from "./i18n/fr";
import ar from "./i18n/ar";
import es from "./i18n/es";
import pt from "./i18n/pt";

const locales = { en, zh, ja, ko, de, fr, ar, es, pt };
type Code = keyof typeof locales;

type Tokens = {
  /** This language's way of saying "across networks". */
  crossNetwork: RegExp;
  /** This language's way of saying "same/local network" — LAN's own name. */
  lan: RegExp;
  /** The realtime NAME that shipped on the cross-network destination. */
  stale: RegExp;
  /** Real-time wording that must remain available as description. */
  liveDescription: RegExp;
};

const t: Record<Code, Tokens> = {
  en: {
    crossNetwork: /cross-network/i,
    lan: /\bLAN\b/,
    stale: /^realtime(\s|$)|^realtime transfer$/i,
    liveDescription: /live|real time|online now/i,
  },
  zh: {
    crossNetwork: /跨网络/,
    lan: /局域网|LAN/,
    stale: /^实时传输$|^实时$/,
    liveDescription: /实时|在线/,
  },
  ja: {
    crossNetwork: /ネットワーク間/,
    lan: /LAN/,
    stale: /^リアルタイム転送$|^リアルタイム$/,
    liveDescription: /リアルタイム|オンライン/,
  },
  ko: {
    crossNetwork: /네트워크 간/,
    lan: /LAN/,
    stale: /^실시간 전송$|^실시간$/,
    liveDescription: /실시간|온라인/,
  },
  de: {
    crossNetwork: /netzwerkübergreifend/i,
    lan: /\bLAN\b/,
    stale: /^Echtzeitübertragung$|^Echtzeit$/,
    liveDescription: /Echtzeit|online/i,
  },
  fr: {
    crossNetwork: /entre réseaux/i,
    lan: /\bLAN\b/,
    stale: /^Transfert en temps réel$|^Temps réel$/,
    liveDescription: /temps réel|en ligne/i,
  },
  ar: {
    // Arabic writes it as "across the networks"; the definite article is part
    // of the phrase, so match the noun run rather than a bare word.
    crossNetwork: /عبر الشبكات/,
    lan: /الشبكة المحلية|LAN/,
    stale: /^نقل فوري$|^فوري$/,
    liveDescription: /فوري|متصل/,
  },
  es: {
    crossNetwork: /entre redes/i,
    lan: /red local|\bLAN\b/i,
    stale: /^Transferencia en tiempo real$|^Tiempo real$/,
    liveDescription: /tiempo real|en línea/i,
  },
  pt: {
    crossNetwork: /entre redes/i,
    lan: /rede local|\bLAN\b/i,
    stale: /^Transferência em tempo real$|^Tempo real$/,
    liveDescription: /tempo real|online/i,
  },
};

/**
 * Every surface that NAMES the cross-network destination, as opposed to
 * describing what happens on it. Each of these is read as "which product am I
 * looking at?": the navigation tab, the page's own heading, the card heading
 * before and during a session, and the comparison column a person picks from.
 */
function destinationNames(m: typeof en): Record<string, string> {
  return {
    "nav.crossTab": m.nav.crossTab,
    crossTitle: m.crossTitle,
    "methods.realtime.name": m.methods.realtime.name,
    "crossnet.realtimeTitle": m.crossnet.realtimeTitle,
    "compare.colRealtime": m.compare.colRealtime,
  };
}

/** The LAN destination's own naming surfaces, for the sibling comparison. */
function lanNames(m: typeof en): Record<string, string> {
  return { "nav.lanTab": m.nav.lanTab, "compare.colLan": m.compare.colLan };
}

describe("the two direct transfer destinations are named as siblings", () => {
  for (const [code, m] of Object.entries(locales) as [Code, typeof en][]) {
    const tok = t[code];

    it(`${code} names the cross-network destination after the networks, everywhere`, () => {
      for (const [key, value] of Object.entries(destinationNames(m))) {
        expect(value.trim(), `${code}: ${key} is empty`).toBeTruthy();
        expect(value, `${code}: ${key} does not name the cross-network product`)
          .toMatch(tok.crossNetwork);
        expect(value, `${code}: ${key} still names the destination after real time`)
          .not.toMatch(tok.stale);
      }
    });

    it(`${code} keeps LAN's own name on LAN's surfaces`, () => {
      // The rename must not drag the sibling with it: two destinations that
      // both say "network" and nothing else are not a choice.
      for (const [key, value] of Object.entries(lanNames(m))) {
        expect(value, `${code}: ${key} lost the LAN name`).toMatch(tok.lan);
        expect(value, `${code}: ${key} now claims to be the cross-network product`)
          .not.toMatch(tok.crossNetwork);
      }
    });

    it(`${code} uses one name across tab, heading, card and comparison`, () => {
      // Not string equality: a tab is abbreviated and a heading is not. What
      // must hold is that the same distinguishing word appears in all of them,
      // which is what makes the tab, the page and the table one destination.
      const names = Object.values(destinationNames(m));
      const shared = names.filter((n) => tok.crossNetwork.test(n));
      expect(shared.length, `${code}: only ${shared.length}/${names.length} naming surfaces agree`)
        .toBe(names.length);
    });

    it(`${code} still describes the session as live, in prose`, () => {
      // Real time did not stop being true; it stopped being the name. The
      // sub-heading under the active card is where a person learns the session
      // needs both sides present, so removing it would be a different defect.
      expect(m.crossnet.realtimeSub, `${code}: the live nature of the session went missing`)
        .toMatch(tok.liveDescription);
    });

    it(`${code} answers "which mode" with both destination names`, () => {
      // The comparison sub-line is the one sentence that puts the choice in
      // words. It named the mode "realtime" while the column above it said
      // something else in five of nine languages.
      expect(m.compare.sub, `${code}: the mode comparison never names cross-network`)
        .toMatch(tok.crossNetwork);
      expect(m.compare.sub, `${code}: the mode comparison never names LAN`).toMatch(tok.lan);
    });
  }
});
