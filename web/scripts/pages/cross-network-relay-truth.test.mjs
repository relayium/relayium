// web/scripts/pages/cross-network-relay-truth.test.mjs — one fact, checked in
// the maintained locales: a cross-network browser session is relayed BY DESIGN.
//
// WHY THIS EXISTS, separately from content-claims.test.mjs. That file already
// forbids "if the direct connection fails it falls back to a relay", and it is
// good at the phrasings it lists. It did not see the shape that actually
// shipped, because the shape is not a phrase — it is a walkthrough that tells
// the reader to look at a label and expect one of two outcomes:
//
//     "Read the label again. P2P direct means a direct path was found across
//      the internet. Relayed means one could not be."
//     "Across networks you get either P2P direct or Relayed, and which one
//      depends on the two networks rather than on anything you configured."
//
// Both were live in guides-what-is-p2p-file-transfer.mjs while the same article,
// three sections earlier, correctly explained that Relayium asks ICE for a
// relay-only path from the start. `chooseRtcConfig` (web/src/lib/ice.ts) returns
// `iceTransportPolicy: "relay"` as soon as a TURN server is in the list, so no
// direct candidate is ever gathered on that path and "P2P direct" is not a
// reachable outcome. A reader following those steps is told to look for a state
// the product cannot produce, and told that getting the other one means their
// network is at fault.
//
// So this rule is about a DISJUNCTION rather than a phrase: maintained copy may
// not offer "direct or relayed" as the two possible results of a cross-network
// browser session. Frozen locales are out of scope — their prose is archived.
import { describe, expect, it } from "vitest";
import { MAINTAINED_LANGS } from "./shared.mjs";

const MODULES = Object.entries(
  import.meta.glob(["./content/**/*.mjs", "!./content/**/*.test.mjs"], { eager: true }),
).map(([path, mod]) => [path.replace("./content/", ""), mod]);

function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}
function langMaps(mod) {
  const seen = new Set();
  const maps = [];
  for (const v of Object.values(mod)) {
    if (!v || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    if (v.langs && typeof v.langs === "object" && !seen.has(v.langs)) {
      seen.add(v.langs);
      maps.push(v.langs);
    } else if (MAINTAINED_LANGS.some((l) => v[l])) maps.push(v);
    else maps.push({ en: v });
  }
  return maps;
}
const SENTENCE = /[^.!?。！？\n]+/g;
const sentences = (s) => [...s.matchAll(SENTENCE)].map((m) => m[0]);

// "either P2P direct or Relayed", "P2P direct or Relayed", "direct or relayed",
// and the Chinese 「P2P 直连」或「中继」 / 直连或中继.
const DIRECT_OR_RELAYED = {
  en: /\b(?:P2P\s+)?direct\b[^.]{0,30}\bor\b[^.]{0,20}\brelayed\b|\brelayed\b[^.]{0,30}\bor\b[^.]{0,20}\b(?:P2P\s+)?direct\b/i,
  zh: /直连[」』"']?\s*(?:或|还是|与)\s*[「『"']?中继|中继[」』"']?\s*(?:或|还是|与)\s*[「『"']?(?:P2P\s*)?直连/,
};
// …but only when the sentence is about the CROSS-NETWORK browser path. On a
// same-network room the disjunction is legitimate — a LAN session really can
// come out either way, and this rule must not push that copy into vagueness.
const CROSS_NETWORK = {
  en: /\bcross[- ]network\b|\bacross networks\b|\bacross the internet\b|\bdifferent networks\b|\bpairing[- ]code\b/i,
  zh: /跨网络|跨互联网|不同(的)?网络|配对码/,
};
// And a sentence that is explicitly describing generic WebRTC/ICE rather than
// Relayium is allowed to lay out the ladder — that is what the first half of
// the p2p guide does, on purpose.
const GENERIC_ICE = {
  en: /\bin (?:a )?general\b|\bgeneric\b|\bWebRTC\/ICE\b|\bin principle\b/i,
  zh: /通用|一般(来说|而言)|原理上|理论上/,
};

describe("cross-network browser sessions are relayed by design", () => {
  it("covers every maintained locale", () => {
    for (const lang of MAINTAINED_LANGS)
      for (const [name, table] of [
        ["DIRECT_OR_RELAYED", DIRECT_OR_RELAYED],
        ["CROSS_NETWORK", CROSS_NETWORK],
        ["GENERIC_ICE", GENERIC_ICE],
      ])
        expect(table[lang], `${name} is missing ${lang}`).toBeDefined();
  });

  it("never offers direct-or-relayed as the outcome of a cross-network session", () => {
    const bad = [];
    for (const [file, mod] of MODULES)
      for (const map of langMaps(mod))
        for (const lang of MAINTAINED_LANGS)
          for (const s of strings(map[lang]))
            for (const sentence of sentences(s)) {
              if (!DIRECT_OR_RELAYED[lang].test(sentence)) continue;
              if (!CROSS_NETWORK[lang].test(sentence)) continue; // LAN may vary
              if (GENERIC_ICE[lang].test(sentence)) continue; // the ICE ladder
              bad.push(`${file} [${lang}] ${sentence.trim()}`);
            }
    expect(bad).toEqual([]);
  });

  it("fires on the sentences that actually shipped, and spares the ones that should", () => {
    // Verbatim from guides-what-is-p2p-file-transfer.mjs before this batch.
    for (const [lang, sentence] of [
      ["en", "Across networks you get either P2P direct or Relayed, and which one depends on the two networks"],
      ["en", "Read the label again on the cross-network transfer: P2P direct or Relayed"],
      ["zh", "跨网络时你会看到「P2P 直连」或「中继」之一"],
    ]) {
      expect(DIRECT_OR_RELAYED[lang].test(sentence), `${lang} not matched: ${sentence}`).toBe(true);
      expect(CROSS_NETWORK[lang].test(sentence), `${lang} not scoped: ${sentence}`).toBe(true);
    }
    // The two the rule must keep its hands off: a same-network room, where the
    // outcome genuinely varies, and the generic-ICE explanation.
    for (const [lang, sentence] of [
      ["en", "On one Wi-Fi the label reads LAN direct or, rarely, relayed"],
      ["zh", "同一网络下标签会显示「局域网直连」，极少数情况下也可能是「中继」"],
    ])
      expect(CROSS_NETWORK[lang].test(sentence), `${lang} wrongly scoped: ${sentence}`).toBe(false);
    expect(
      GENERIC_ICE.en.test("In a general WebRTC/ICE design a session ends up direct or relayed"),
    ).toBe(true);
  });
});
