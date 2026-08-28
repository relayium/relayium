// web/scripts/pages/pricing-truth.test.mjs — one mechanical rule family over the
// maintained locales: content may not tell a reader that Relayium has no paid
// tier, that it is unconditionally free, or that every mode connects directly.
//
// WHY THIS EXISTS. The site shipped Free/Plus/Pro/Max plans and a `relayium up`
// that stores into hosted, quota-counted storage, but a batch of articles kept
// the pre-billing copy: "no paid tier", "completely free", "every mode connects
// the two ends directly", "nothing to meter". Those sentences were true when
// they were written and are false now, and no existing guard could see them —
// content-claims.test.mjs pins account and relay-fallback claims, not price.
//
// WHAT IS STILL TRUE, and must keep being sayable:
//   • the software: AGPL-3.0, free and open source, a free binary to download;
//   • direct paths: LAN/same-network browser transfers, and CLI push, pull,
//     sync, daemon-direct, send / receive and text — nothing metered;
//   • a node you run yourself: your own bandwidth, your own disk, no bill.
// What is NOT true any more: that the hosted product as a whole is free, or
// that `up` (hosted storage) and cross-network relay cost nothing.
//
// So each rule below is a claim pattern plus, for most of them, an escape: a
// sentence that names the free path or the licence it is talking about is a
// scoped statement and passes. A sentence that makes the claim in the abstract
// does not. The universal-mode rule (c) has no scope escape, because there is
// no scope in which "every mode" is direct — `up` is a mode and it uploads.
//
// ── HOW TO EXTEND ────────────────────────────────────────────────────────────
// Adding a maintained locale is one key in each table below plus its entry in
// MAINTAINED_LANGS; nothing else in this file is language-aware. Add the key
// even if you believe the locale is clean — a missing key is a silent pass, so
// `covers every maintained locale` fails the build until you do.
//
// Harvest new phrases from the diff that FIXED a defect, not from the corrected
// copy — the same lesson content-claims.test.mjs records at length. Every
// pattern in NO_PAID_TIER, TOTALIZED_FREE and UNIVERSAL_MODE below was taken
// from a sentence that was live on relayium.com before this batch.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAINTAINED_LANGS } from "./shared.mjs";

// The whole content tree, by glob rather than a hand-kept list, so a new
// article is covered the day it lands. Frozen locales are deliberately out of
// range: their prose is archived at the 2026-08-14 freeze and is not corrected.
const MODULES = Object.entries(
  import.meta.glob(["./content/**/*.mjs", "!./content/**/*.test.mjs"], { eager: true }),
).map(([path, mod]) => [path.replace("./content/", ""), mod]);

// ── the English homepage is content too, and it was the hole ────────────────
// `/` is not generated from content/**: it is the checked-in SPA shell, whose
// <script type="application/ld+json"> and <noscript> body are what a crawler
// and a no-JS reader actually read. On 2026-08-28 both of them still answered
// "Is Relayium free?" with "Yes." and nothing about the hosted bound — the exact
// defect rule (d) exists to catch — and this file could not see it, because it
// only ever globbed the content tree. So index.html is lifted into the same
// shape a content module has (`{ en: … }`, with `{ q, a }` pairs) and walks
// every rule below unchanged. The Chinese homepage needs no equivalent: it is
// generated from content/landing.mjs, which is already in MODULES.
const INDEX_HTML = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

/** Minimal entity decode — enough for the entities this file's copy uses. */
const unesc = (s) =>
  s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
const detag = (s) => unesc(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/** The homepage's JSON-LD graph, its FAQ as `{ q, a }`, and its no-JS prose. */
function indexHtmlSurface(html) {
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => JSON.parse(m[1]));
  const faq = [];
  for (const graph of ld)
    for (const node of graph["@graph"] ?? [])
      for (const e of node.mainEntity ?? [])
        if (e.name && e.acceptedAnswer?.text) faq.push({ q: e.name, a: e.acceptedAnswer.text });

  // The no-JS body's own FAQ: <h3>question</h3> followed by its <p>answer</p>.
  const noscript = html.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] ?? "";
  for (const m of noscript.matchAll(/<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g))
    faq.push({ q: detag(m[1]), a: detag(m[2]) });

  // …and every other sentence a crawler reads, so rules (a)–(c) cover the
  // prose and the structured description/featureList, not just the FAQ.
  return { faq, prose: [detag(noscript), ...ld.map((g) => JSON.stringify(g))] };
}

/** MODULES plus the static surfaces, in the `[file, module]` shape scan() walks. */
const SURFACES = [...MODULES, ["index.html", { home: { en: indexHtmlSurface(INDEX_HTML) } }]];

/** Every string in a value, flattened. */
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

// Same three module shapes content-claims.test.mjs documents: `{ langs: {…} }`,
// a bare `{ en, zh, … }`, and an unlocalized object (spa-pages.mjs), which is
// English and is read as such.
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

/** Every `{ q, a }` pair in a value. Rule (d) below needs the question and its
 *  answer together, which `strings()` deliberately throws away. */
function faqPairs(v, out = []) {
  if (Array.isArray(v)) {
    for (const x of v) faqPairs(x, out);
    return out;
  }
  if (v && typeof v === "object") {
    if (typeof v.q === "string" && typeof v.a === "string") out.push(v);
    for (const x of Object.values(v)) faqPairs(x, out);
  }
  return out;
}

const SENTENCE = /[^.!?。！？\n]+/g;
const sentences = (s) => [...s.matchAll(SENTENCE)].map((m) => m[0]);

// ── the scope escapes ────────────────────────────────────────────────────────
// A sentence escapes a price rule by naming the free thing it is talking about.
// Free paths come in two kinds, and the difference is the whole point of this
// section: some name the path by its nature, and some only name it if you
// already know you are in the command line.
//
// PATH_SCOPE — INHERENT scopes. Every alternative here is free by construction:
// a local network, a direct connection, SSH, the resident daemon, or
// infrastructure the reader owns. There is no reading of "same network" or
// "straight across" that involves hosted storage or a billed relay, so these
// stand on their own. `up` and `down` are deliberately absent.
const PATH_SCOPE = {
  en: /\bdirect(ly)?\b|\bstraight (across|to|between|from|onto|through)\b|\bLAN\b|\blocal network\b|\bsame[- ](Wi-?Fi|network)\b|\bpeer[- ]to[- ]peer\b|\bSSH\b|\bdaemon\b|\bself[- ]host|\byour own (node|server|hardware|infrastructure|disk)\b/i,
  zh: /直连|直接|局域网|同一网络|同一个网络|同一 ?Wi-?Fi|点对点|SSH|daemon|自托管|自己的节点|自己(运行|掌控)的|自己的(服务器|硬件|磁盘)/i,
};

// CLI_ONLY — CONDITIONAL scopes. These name a free path in the CLI and
// something else, or nothing, anywhere else, so each one is gated on the copy
// having said it means the command line.
//
// PAIRING_CODE: a pairing code is not one path, it is two, and they bill
// differently. The CLI's `relayium send` / `relayium receive` pair negotiates a
// direct connection and really is free. A cross-network pairing code in the
// BROWSER is relay-by-design — ICE is forced relay-only, so the bytes go
// through TURN, and TURN bytes are billable. Until 2026-08-28 the bare term sat
// in PATH_SCOPE as if it named one free path, which let "Cross-network browser
// pairing-code transfers are completely free" escape every rule below.
//
// CLI_COMMAND: `push`, `pull`, `sync`, `send`, `receive` and `serve` are the
// names of direct commands — and also ordinary English words. As bare
// alternatives in PATH_SCOPE they scoped any sentence built on the imperative,
// whatever it was actually about: "Send files across networks in the browser:
// completely free" escaped on the word "Send" while describing the billed relay
// path, which is the same defect as the pairing code through a sibling token.
// A command name is only a free-path scope when it is unmistakably the command.
//
// Both are gated on CLI_CONTEXT, which is deliberately NOT a path scope on its
// own — "the CLI is completely free" is precisely the sentence this file exists
// to catch, because the CLI has `up`. It only qualifies the tokens above. For
// the same reason `up` and `down` are absent from the command list it
// recognises: naming a hosted command must not license a free claim.
const PAIRING_CODE = { en: /\bpairing[- ]code\b/i, zh: /配对码/ };
const CLI_COMMAND = {
  en: /\b(push|pull|sync|send|receive|serve)\b/i,
  zh: /\b(push|pull|sync|send|receive|serve)\b/i,
};
const CLI_CONTEXT = {
  en: /\bCLI\b|\bcommand[- ]line\b|\bterminal\b|\bshell\b|\$\s*relayium\b|\brelayium\s+(push|pull|sync|send|receive|serve)\b/i,
  zh: /CLI|命令行|终端|shell|\$\s*relayium\b|relayium\s+(push|pull|sync|send|receive|serve)/i,
};
// …and a path scope points FORWARD, not backward. Matching PATH_SCOPE against
// the whole sentence let a later, unrelated clause launder an earlier absolute
// claim: "Relayium is completely free, and you can also push files directly
// over SSH" passed, because "push" and "directly" were somewhere in the
// sentence. They were not scoping anything — they were a second statement.
//
// A path scope is a restriction, so it governs the clause it sits in and the
// clauses after it ("Direct file and text bytes never pass through a relay, so
// there is nothing to meter" — set first, carried forward). A clause AFTER the
// claim scopes it only when it is subordinated to it: "It is free, as long as
// you stay on the same network." An and-joined sibling is not that.
//
// LICENCE_SCOPE deliberately stays sentence-wide: it is not a restriction but a
// topic marker. A sentence that says AGPL or open-source anywhere in it is
// talking about the software, whichever half of the sentence says so.
const CLAUSE_BREAK = /[,;，；]|—|–|--/g;
/** Clause boundaries as [start, end) offsets over one sentence. */
function clauseSpans(sentence) {
  const spans = [];
  let start = 0;
  for (const m of sentence.matchAll(CLAUSE_BREAK)) {
    spans.push([start, m.index]);
    start = m.index + m[0].length;
  }
  spans.push([start, sentence.length]);
  return spans;
}
// Subordinators that let a following clause restrict what precedes it.
const RESTRICTS_WHAT_PRECEDES = {
  en: /^\s*(and\s+)?(only\s+)?(as|so)?\s*(long as|if|when|whenever|unless|provided|providing)\b/i,
  zh: /^\s*(只要|如果|除非|前提是|条件是|限于|仅限|除了)/,
};
/** Does PATH_SCOPE scope a claim whose match starts at `at` in `sentence`? */
function pathScopes(lang, sentence, at) {
  const spans = clauseSpans(sentence);
  const claim = spans.findIndex(([a, b]) => at >= a && at < b);
  const parts = spans.map(([a, b]) => sentence.slice(a, b));
  // A pairing code, and a bare command name, count as a free path only once the
  // copy has said it means the CLI. That qualifier carries forward across
  // clauses exactly like a scope does — "In the terminal, a pairing-code
  // transfer is free" sets it in clause 0 and spends it in clause 1 — so
  // `cliByHere[j]` is "some clause up to and including j named the CLI", not
  // "clause j did".
  const cliByHere = [];
  for (const [j, part] of parts.entries())
    cliByHere[j] = (j > 0 && cliByHere[j - 1]) || CLI_CONTEXT[lang].test(part);

  return parts.some((part, j) => {
    const cliOnly = PAIRING_CODE[lang].test(part) || CLI_COMMAND[lang].test(part);
    const scoped = PATH_SCOPE[lang].test(part) || (cliOnly && cliByHere[j]);
    if (!scoped) return false;
    if (j <= claim) return true; // set before, or in, the clause making the claim
    return RESTRICTS_WHAT_PRECEDES[lang].test(part); // subordinated to it
  });
}

// LICENCE_SCOPE — the sentence is about the software rather than the service.
// The binary and its source are free and stay free, so a claim anchored to the
// licence is allowed. Note "CLI" is NOT here: the CLI has `up`, so "the CLI is
// completely free" is exactly the sentence this file exists to catch.
const LICENCE_SCOPE = {
  en: /\bopen[- ]source\b|\bAGPL\b|\blicen[cs]e[ds]?\b|\bsource code\b|\bbinar(y|ies)\b|\bGitHub\b/i,
  zh: /开源|AGPL|许可证|许可|源代码|二进制|GitHub/i,
};

// ── (a) "no paid tier" ───────────────────────────────────────────────────────
// Relayium has Free, Plus, Pro and Max. A sentence may say a particular path
// costs nothing; it may not say the tiers do not exist. Scoped by PATH_SCOPE
// only — a licence word does not make a claim about tiers true.
const NO_PAID_TIER = {
  en: [/\bno paid (tier|plan)s?\b/i, /\bthere'?s no paid\b/i, /\bwithout a paid (tier|plan)\b/i, /\bno (tiers|plans|subscription|upsell)\b/i, /\bno premium (tier|plan)\b/i],
  zh: [/没有付费(档位?|计划|方案)?/, /不存在付费(档位?|计划|方案)/, /无付费(档位?|计划|方案)/, /没有(任何)?订阅/],
};

// ── (b) totalized free claims ────────────────────────────────────────────────
// "free" on its own is usually fine and often true. A totalizer — completely,
// always, forever, every, no matter — turns it into a claim about the whole
// product, and that claim is false. Escapable by either scope: a totalized free
// claim about a direct path or about the licence is still true.
const TOTALIZED_FREE = {
  en: [
    /\b(completely|entirely|totally|absolutely|always|100%|utterly)\s+free\b/i,
    /\bfree\s+(forever|for ever|for everyone|for every\b|no matter\b|either way\b|whatever\b)/i,
    /\bnothing to (pay|meter|bill|charge)\b/i,
    // Subject-anchored on purpose. A bare /costs? nothing/ also matched "a
    // connect-then-drop costs nothing", which is about a burn-after-read slot
    // and not about money at all.
    /\b(relayium|the (CLI|app|service|product)|it all|everything)\s+(costs?|is)\s+(you\s+)?nothing\b/i,
    /\bat no (cost|charge)\b/i,
    /\bnever costs?\b/i,
    /\bfree, (completely|entirely|full stop)\b/i,
  ],
  zh: [
    /完全免费/, /始终免费/, /永远免费/, /一直免费/, /百分之百免费/, /全部免费/, /都免费/, /均免费/,
    /不收(任何)?费/, /没有(任何)?费用/, /无需(任何)?付费/, /不花钱/, /不要钱/, /没有什么可(计量|付费)/,
    // 无任何费用 / 不产生任何费用 / 零费用 — the same claim without 没有, which is
    // how "完全无任何费用" sat on the Chinese homepage FAQ until 2026-08-28.
    /无任何费用/, /不产生(任何)?费用/, /零费用/,
  ],
};

// ── (c) universal-mode directness ────────────────────────────────────────────
// "every mode connects the two ends directly" / "in every mode the file bytes
// travel directly" / "whichever way you use it". `relayium up` is a mode and it
// uploads an encrypted copy to hosted storage, so there is no reading of these
// under which they are true — hence no scope escape. The only way out is to
// name the exception in the same sentence.
const UNIVERSAL_MODE = {
  en: [/\b(in )?every (transfer )?mode\b/i, /\ball (transfer )?modes\b/i, /\bwhichever way you use it\b/i, /\bevery way you use it\b/i, /\bno matter which mode\b/i, /\bin all cases the (file )?bytes\b/i],
  zh: [/每种模式/, /所有模式/, /所有传输模式/, /任何模式/, /无论用哪种方式/, /不管用哪种方式/, /各种模式都/],
};
// Naming the exception is what makes such a sentence honest, so a sentence that
// does is allowed. `up` is matched with a boundary so that "upload" and "群" do
// not count as naming it.
const NAMES_THE_EXCEPTION = {
  en: /\b(except|apart from|other than|aside from|besides|excluding)\b[^.]*\bup\b|\bup\b[^.]*\b(is|are) the (one |only |deliberate )?exception\b/i,
  zh: /除[^。]*\bup\b|\bup\b[^。]*(除外|例外)/i,
};
// …and the universal phrase only matters when it generalises about directness
// or cost. "无论用哪种方式，接收方都从不需要账号" is a true statement about
// accounts that happens to use the same words, and rule (c) must not eat it.
const GENERALISES_ABOUT_PATH_OR_COST = {
  en: /\bdirect(ly)?\b|\bnever (pass|passes|touch|touches|upload|uploads|leaves?)\b|\bfree\b|\bmeter(ed|ing)?\b|\bpay\b|\bcosts?\b|\bstraight (across|to|between)\b/i,
  zh: /直接|直连|不经过|从不经过|免费|计量|收费|付费|上传/,
};
// ── (d) "is Relayium free?" answered as if it were one question ──────────────
// An article FAQ that asks about the WHOLE product — not "is the CLI free", not
// "is self-hosting free", but "Is Relayium free?" — is asking about two things
// that now have different answers: the software (AGPL-3.0, free, unlimited) and
// the hosted service (a free tier with a storage cap, a retention window and
// three paid plans above it). compare-firefox-send.mjs answered it "Yes.
// Relayium is free and open source under the AGPL-3.0 license" while the same
// article's body sells stored download links, which are exactly the metered
// part. Nothing in rules (a)–(c) sees that: there is no totalizer, no "no paid
// tier", no "every mode", so the sentence is individually unobjectionable and
// collectively false.
//
// So this rule is about the shape of the answer rather than a phrase in it: a
// whole-product price question must not open with a bare affirmative, and must
// name BOTH halves — the licence/software scope and the hosted bound. A
// question that scopes itself ("Is Relayium's CLI free?", "Is the CLI still
// free if I self-host?", "Is running an always-on receiver free?") is not
// caught, because its answer is allowed to be a plain yes about that scope.
const WHOLE_PRODUCT_PRICE_Q = {
  en: /^\s*(is|are)\s+relayium\s+free\b/i,
  // The brand is optional: content/landing.mjs asks the whole-product question
  // as a bare "免费吗？" and rule (d) could not see it. Still anchored, so a
  // scoped question ("Relayium 的 CLI 免费吗？", "自托管之后 CLI 还免费吗？")
  // stays out of range — its plain 免费 answer is true of the scope it set.
  zh: /^\s*(relayium\s*)?(是否)?免费(吗)?[?？]?\s*$/i,
};
// The opener the defect used. "Yes." / "免费。" as the first thing a reader sees
// is the claim, whatever the rest of the paragraph goes on to qualify.
const BARE_AFFIRMATIVE = {
  en: /^\s*(yes|yep|absolutely|of course)\b\s*[.,!—-]/i,
  zh: /^\s*(是的?|对|会|免费|是)\s*[。，！,.]/,
};
// Half one: the answer says which part is the free software.
const NAMES_THE_SOFTWARE = {
  en: /\bopen[- ]source\b|\bAGPL\b|\blicen[cs]e[ds]?\b|\bsource code\b/i,
  zh: /开源|AGPL|许可|源代码/,
};
// Half two: the answer says what bounds the hosted side. A quota alone is not
// enough — the reader has to be told there is a plan above it, which is the
// difference between "you have a limit" and "you can buy a bigger one".
const NAMES_THE_HOSTED_BOUND = {
  en: /\b(paid|monthly)\s+(plans?|tiers?|allowances?)\b|\ballowance\b|\bplan'?s? (storage|retention)\b|\b(Plus|Pro|Max)\b/,
  zh: /付费(套餐|档位|计划)|每月额度|套餐(的)?(存储)?额度|套餐的存储|留存时长|档位/,
};

// The /pricing page states the split in its own section titles, and a title has
// no room to restate the scope its section spells out immediately below. These
// are exact strings, not patterns, so an unrelated sentence cannot hide behind
// one. Keep this list to headings that a maintained pricing surface owns.
const SCOPED_BY_ITS_OWN_SECTION = {
  en: new Set(["Always free", "Want 100% free"]),
  zh: new Set(["始终免费", "想要 100% 免费"]),
};

/** Walk every (file, maintained lang, sentence); `fn` returns a complaint or nothing. */
function scan(fn) {
  const bad = [];
  for (const [file, mod] of SURFACES)
    for (const map of langMaps(mod))
      for (const lang of MAINTAINED_LANGS)
        for (const s of strings(map[lang]))
          for (const sentence of sentences(s)) {
            const why = fn(sentence, lang);
            if (why) bad.push(`${file} [${lang}] ${why}: ${sentence.trim()}`);
          }
  return bad;
}

/** Offset of the earliest pattern match in `sentence`, or -1. Rules that have a
 *  scope escape need to know WHERE the claim is, not just that it is there. */
const hitIndex = (table, lang, sentence) => {
  let best = -1;
  for (const re of table[lang] ?? []) {
    const m = re.exec(sentence);
    if (m && (best < 0 || m.index < best)) best = m.index;
  }
  return best;
};
const hit = (table, lang, sentence) => hitIndex(table, lang, sentence) >= 0;

/** Rule (b) for one sentence: a complaint string, or nothing if it is allowed.
 *  Named rather than inlined into its `it` so the adversarial probes can aim at
 *  the same code path the content scan uses. */
function unconditionalFreeComplaint(sentence, lang) {
  const at = hitIndex(TOTALIZED_FREE, lang, sentence);
  if (at < 0) return;
  if (SCOPED_BY_ITS_OWN_SECTION[lang].has(sentence.trim())) return;
  if (pathScopes(lang, sentence, at)) return; // scoped to a free path
  if (LICENCE_SCOPE[lang].test(sentence)) return; // scoped to the software
  return "makes an unconditional free claim";
}

describe("pricing truth in maintained locales", () => {
  it("covers every maintained locale", () => {
    // A locale with no table entry would pass every rule by accident. Fail here
    // instead, so restoring a locale cannot silently unguard it.
    for (const lang of MAINTAINED_LANGS)
      for (const [name, table] of [
        ["PATH_SCOPE", PATH_SCOPE],
        ["PAIRING_CODE", PAIRING_CODE],
        ["CLI_COMMAND", CLI_COMMAND],
        ["CLI_CONTEXT", CLI_CONTEXT],
        ["RESTRICTS_WHAT_PRECEDES", RESTRICTS_WHAT_PRECEDES],
        ["LICENCE_SCOPE", LICENCE_SCOPE],
        ["NO_PAID_TIER", NO_PAID_TIER],
        ["TOTALIZED_FREE", TOTALIZED_FREE],
        ["UNIVERSAL_MODE", UNIVERSAL_MODE],
        ["NAMES_THE_EXCEPTION", NAMES_THE_EXCEPTION],
        ["GENERALISES_ABOUT_PATH_OR_COST", GENERALISES_ABOUT_PATH_OR_COST],
        ["SCOPED_BY_ITS_OWN_SECTION", SCOPED_BY_ITS_OWN_SECTION],
        ["WHOLE_PRODUCT_PRICE_Q", WHOLE_PRODUCT_PRICE_Q],
        ["BARE_AFFIRMATIVE", BARE_AFFIRMATIVE],
        ["NAMES_THE_SOFTWARE", NAMES_THE_SOFTWARE],
        ["NAMES_THE_HOSTED_BOUND", NAMES_THE_HOSTED_BOUND],
      ])
        expect(table[lang], `${name} is missing ${lang}`).toBeDefined();
  });

  it("never says Relayium has no paid tier", () => {
    expect(
      scan((sentence, lang) => {
        const at = hitIndex(NO_PAID_TIER, lang, sentence);
        if (at < 0) return;
        if (pathScopes(lang, sentence, at)) return; // scoped to a free path
        return "claims there is no paid tier";
      }),
    ).toEqual([]);
  });

  it("never calls the hosted product unconditionally free", () => {
    expect(scan(unconditionalFreeComplaint)).toEqual([]);
  });

  // Rule (b), aimed at one sentence instead of the whole tree. The adversarial
  // pairing-code probes below run through THIS, the same function the scan
  // uses, so a probe cannot pass against a private copy of the rule that has
  // drifted from the one guarding the content.
  it("scopes a pairing code by the CLI, not by the word", () => {
    // Rejected: a cross-network pairing code in the browser is relay-only by
    // design, so its bytes go through TURN and are billed. Before 2026-08-28
    // the bare `pairing-code` token escaped this sentence outright.
    for (const [lang, sentence] of [
      ["en", "Cross-network browser pairing-code transfers are completely free"],
      ["en", "Pairing-code transfers in the browser are always free"],
      ["zh", "跨网络浏览器配对码传输完全免费"],
    ])
      expect(unconditionalFreeComplaint(sentence, lang), `${lang} should be rejected: ${sentence}`)
        .toBe("makes an unconditional free claim");

    // Kept: `relayium send` / `relayium receive` negotiate a direct connection,
    // so a pairing-code claim that is explicitly about the CLI is true and must
    // still pass. The first of each pair carries no other free-path token — no
    // "direct", no bare `send`/`receive` — so it is the new CLI-context
    // alternative alone that is doing the work, not a token that survived.
    for (const [lang, sentence] of [
      ["en", "The CLI's pairing-code mode is completely free"],
      ["en", "In the terminal, a pairing-code transfer is always free"],
      ["en", "relayium send and relayium receive use a pairing code and are completely free"],
      ["zh", "CLI 的配对码模式完全免费"],
      ["zh", "命令行下的配对码传输始终免费"],
    ])
      expect(unconditionalFreeComplaint(sentence, lang), `${lang} should pass: ${sentence}`)
        .toBeUndefined();

    // The probes are only meaningful if the claim itself is in range: each one
    // must trip TOTALIZED_FREE, so that "passes" means "escaped" rather than
    // "was never a candidate".
    for (const [lang, sentence] of [
      ["en", "The CLI's pairing-code mode is completely free"],
      ["en", "Cross-network browser pairing-code transfers are completely free"],
      ["zh", "CLI 的配对码模式完全免费"],
      ["zh", "跨网络浏览器配对码传输完全免费"],
    ])
      expect(hit(TOTALIZED_FREE, lang, sentence), `${lang}: ${sentence} must be a candidate`).toBe(true);
  });

  // The same defect as the pairing code, one token over. `push`, `pull`, `sync`,
  // `send`, `receive` and `serve` name direct commands and are also ordinary
  // English words, so as bare alternatives they scoped whatever sentence they
  // happened to sit in. These probes run through unconditionalFreeComplaint —
  // the function the tree scan uses — so they cannot pass against a private
  // copy of the rule.
  it("scopes a CLI command name by the command line, not by the verb", () => {
    // Rejected: an English imperative on a browser or whole-service sentence.
    // The first is the exact sentence that escaped through bare `send` after
    // the pairing code was fixed; the rest are its siblings, one per token.
    for (const [lang, sentence] of [
      ["en", "Send files across networks in the browser: completely free"],
      ["en", "Sync your photos between phone and laptop in the browser and it is completely free"],
      ["en", "Push a file to anyone in the world from the web app — always free"],
      ["en", "We serve every transfer at no cost"],
      ["en", "Receive a cross-network transfer in your browser, completely free"],
      ["zh", "在浏览器里 send 文件完全免费"],
    ])
      expect(unconditionalFreeComplaint(sentence, lang), `${lang} should be rejected: ${sentence}`)
        .toBe("makes an unconditional free claim");

    // Kept: the command names really do mark free paths once the copy says it
    // means the command line — as `relayium <command>`, as `$ relayium …` in a
    // code line, or under a CLI / terminal qualifier carried forward from an
    // earlier clause. None of these carries an inherent scope word, so it is
    // the CLI gate alone doing the work.
    for (const [lang, sentence] of [
      ["en", "relayium push copies a folder to a server you already have and is completely free"],
      ["en", "$ relayium serve — the listening inbox, and it is always free"],
      ["en", "In the terminal, push and pull are completely free"],
      ["en", "The CLI's sync command is completely free"],
      ["zh", "CLI 的 push、pull、sync 完全免费"],
      ["zh", "relayium receive 完全免费"],
    ])
      expect(unconditionalFreeComplaint(sentence, lang), `${lang} should pass: ${sentence}`)
        .toBeUndefined();

    // Every probe has to be a candidate, or "passes" would mean "was never in
    // range" — and the CLI gate has to be what admits the kept ones, not a
    // scope word that survived in the sentence.
    for (const [lang, sentence] of [
      ["en", "Send files across networks in the browser: completely free"],
      ["en", "relayium push copies a folder to a server you already have and is completely free"],
      ["en", "In the terminal, push and pull are completely free"],
      ["zh", "在浏览器里 send 文件完全免费"],
      ["zh", "CLI 的 push、pull、sync 完全免费"],
    ]) {
      expect(hit(TOTALIZED_FREE, lang, sentence), `${lang}: ${sentence} must be a candidate`).toBe(true);
      expect(PATH_SCOPE[lang].test(sentence), `${lang}: inherent scope leaked in: ${sentence}`).toBe(false);
      expect(LICENCE_SCOPE[lang].test(sentence), `${lang}: licence scope leaked in: ${sentence}`).toBe(false);
    }
  });

  it("never says every mode connects directly", () => {
    expect(
      scan((sentence, lang) => {
        if (!hit(UNIVERSAL_MODE, lang, sentence)) return;
        if (!GENERALISES_ABOUT_PATH_OR_COST[lang].test(sentence)) return;
        if (NAMES_THE_EXCEPTION[lang].test(sentence)) return;
        return "generalises over every mode, but up uploads to hosted storage";
      }),
    ).toEqual([]);
  });

  it("never answers \"is Relayium free?\" as if the service were the software", () => {
    const bad = [];
    for (const [file, mod] of SURFACES)
      for (const map of langMaps(mod))
        for (const lang of MAINTAINED_LANGS)
          for (const { q, a } of faqPairs(map[lang])) {
            if (!WHOLE_PRODUCT_PRICE_Q[lang].test(q)) continue;
            if (BARE_AFFIRMATIVE[lang].test(a))
              bad.push(`${file} [${lang}] opens with a bare yes: ${q} -> ${a.slice(0, 60)}…`);
            if (!NAMES_THE_SOFTWARE[lang].test(a))
              bad.push(`${file} [${lang}] never says which part is the free software: ${q}`);
            if (!NAMES_THE_HOSTED_BOUND[lang].test(a))
              bad.push(`${file} [${lang}] never names the plan/allowance that bounds the hosted side: ${q}`);
          }
    expect(bad).toEqual([]);
  });

  it("catches the phrases that actually shipped", () => {
    // The guard is only worth its maintenance if it fails on the real defect
    // text. These are verbatim from the copy this batch replaced.
    const shipped = [
      ["en", "There's no paid tier and nothing to meter", NO_PAID_TIER],
      ["en", "no paid tier to unlock bigger or faster transfers", NO_PAID_TIER],
      ["zh", "没有付费档位，也没有什么可计量的", NO_PAID_TIER],
      ["en", "The CLI is completely free", TOTALIZED_FREE],
      ["en", "There is nothing to pay", TOTALIZED_FREE],
      ["zh", "CLI 完全免费", TOTALIZED_FREE],
      // The Chinese homepage FAQ, verbatim, until 2026-08-28. It said the whole
      // product cost nothing while Free/Plus/Pro/Max were live, and no pattern
      // above saw it: it uses 无任何费用 rather than 没有任何费用.
      ["zh", "Relayium 采用 AGPL-3.0 许可开源，完全无任何费用", TOTALIZED_FREE],
      ["en", "In every mode the file bytes travel directly between the two ends", UNIVERSAL_MODE],
      ["en", "it's free for every transfer mode", UNIVERSAL_MODE],
      ["zh", "每种模式都是两端直接连接", UNIVERSAL_MODE],
      ["zh", "无论用哪种方式，文件字节都在两端之间直接传输", UNIVERSAL_MODE],
    ];
    for (const [lang, sentence, table] of shipped)
      expect(hit(table, lang, sentence), `${lang}: ${sentence}`).toBe(true);

    // Rule (d)'s defect is a Q/A shape rather than a sentence, so it is pinned
    // as the exact pair that was live in compare-firefox-send.mjs on 2026-08-28.
    const shippedPairs = [
      [
        "en",
        "Is Relayium free?",
        "Yes. Relayium is free and open source under the AGPL-3.0 license. Creating a stored download link requires the sender to sign in (links count against your account's storage quota), but the recipient never needs an account to download.",
      ],
      [
        "zh",
        "Relayium 免费吗？",
        "免费。Relayium 采用 AGPL-3.0 许可，免费开源。生成存储下载链接需要发送方登录（链接计入你账号的存储配额），但收件方下载始终无需账号。",
      ],
    ];
    for (const [lang, q, a] of shippedPairs) {
      expect(WHOLE_PRODUCT_PRICE_Q[lang].test(q), `${lang}: question not matched`).toBe(true);
      // Caught twice over: the bare opener, and the missing plan bound. A
      // storage *quota* is named in both, which is why NAMES_THE_HOSTED_BOUND
      // asks for the plan above it rather than for any limit at all.
      expect(BARE_AFFIRMATIVE[lang].test(a), `${lang}: bare affirmative not matched`).toBe(true);
      expect(NAMES_THE_HOSTED_BOUND[lang].test(a), `${lang}: hosted bound wrongly found`).toBe(false);
    }

    // …and the scoped questions rule (d) must keep its hands off, because their
    // plain "Yes" is true of the scope the question set.
    for (const [lang, q] of [
      ["en", "Is Relayium's CLI free?"],
      ["en", "Is the CLI still free if I self-host?"],
      ["en", "Is running an always-on receiver free?"],
      ["zh", "Relayium 的 CLI 免费吗？"],
      ["zh", "自托管之后 CLI 还免费吗？"],
    ])
      expect(WHOLE_PRODUCT_PRICE_Q[lang].test(q), `${lang}: ${q} should be out of scope`).toBe(false);

    // The homepage's own pair, verbatim from index.html before this batch. It is
    // pinned here because index.html was outside this file's reach entirely
    // until SURFACES was added above, so nothing proved the rule would fire on
    // it. The Chinese twin is content/landing.mjs's, whose question carries no
    // brand name — which is why WHOLE_PRODUCT_PRICE_Q.zh made it optional.
    for (const [lang, q, a] of [
      [
        "en",
        "Is Relayium free?",
        "Yes. Relayium is free and open source (AGPL-3.0), with no installation. Same-network file and live text transfers need no account. Creating a cross-network pairing code for files or text requires sign-in; joining with a code does not. Creating a stored download link also requires sign-in.",
      ],
      [
        "zh",
        "免费吗？",
        "免费。Relayium 采用 AGPL-3.0 许可开源，完全无任何费用；同一网络下实时传输无需登录，跨网络配对码传输仅发送方需登录，接收方始终无需账号。",
      ],
    ]) {
      expect(WHOLE_PRODUCT_PRICE_Q[lang].test(q), `${lang}: homepage question not matched`).toBe(true);
      expect(BARE_AFFIRMATIVE[lang].test(a), `${lang}: homepage bare affirmative not matched`).toBe(true);
      expect(NAMES_THE_HOSTED_BOUND[lang].test(a), `${lang}: homepage hosted bound wrongly found`).toBe(false);
    }

    // A borderline one that is deliberately IN scope: it names a competitor's
    // plan but still asks about Relayium as a whole, and compare-dropbox.mjs
    // answers it "Mostly." with both halves named. Pinned so that narrowing the
    // question pattern later has to notice it stops being covered.
    expect(WHOLE_PRODUCT_PRICE_Q.en.test("Is Relayium free to use instead of a Dropbox plan?")).toBe(true);
  });

  it("leaves scoped free-direct statements alone", () => {
    // The other half of the bar: these are true, they shipped, and a guard that
    // rejected them would push writers into vaguer copy than the product needs.
    const keep = [
      ["en", "Direct file and text bytes never pass through a Relayium relay, so there is nothing to meter", TOTALIZED_FREE, PATH_SCOPE],
      ["en", "relayium serve is part of the free, self-hostable CLI — no account, no paid tier, on either side of the connection", NO_PAID_TIER, PATH_SCOPE],
      ["zh", "上面三种直连方式都不收费", TOTALIZED_FREE, PATH_SCOPE],
      ["zh", "同一网络内的传输也不收费", TOTALIZED_FREE, PATH_SCOPE],
    ];
    for (const [lang, sentence, table, escape] of keep) {
      expect(hit(table, lang, sentence), `${lang}: ${sentence}`).toBe(true);
      expect(escape[lang].test(sentence), `${lang} escape: ${sentence}`).toBe(true);
    }
    // And two the licence escape has to carry, because the software really is free.
    for (const [lang, sentence] of [
      ["en", "It stays free either way — Relayium is open source under the AGPL-3"],
      ["en", "License and cost: both AGPL-3.0-licensed and both free for direct transfers"],
    ])
      expect(LICENCE_SCOPE[lang].test(sentence), sentence).toBe(true);
  });

  it("will not let a later, unrelated clause launder an earlier absolute claim", () => {
    // The defect the sentence-wide escape allowed. Both of these name a genuinely
    // free path, and in neither does that path scope the claim in front of it.
    for (const [lang, sentence, table] of [
      ["en", "Relayium is completely free, and you can also push files directly over SSH", TOTALIZED_FREE],
      ["en", "There are no paid plans, and same-network transfers are direct", NO_PAID_TIER],
      ["zh", "Relayium 完全免费，你也可以用 SSH 直连推送文件", TOTALIZED_FREE],
    ]) {
      const at = hitIndex(table, lang, sentence);
      expect(at, `${lang}: ${sentence}`).toBeGreaterThanOrEqual(0);
      expect(PATH_SCOPE[lang].test(sentence), `${lang}: sentence-wide would have escaped`).toBe(true);
      expect(pathScopes(lang, sentence, at), `${lang}: ${sentence}`).toBe(false);
    }
    // …and the two directions that must keep working: a scope set earlier and
    // carried forward, and a genuinely subordinated restriction set afterwards.
    for (const [lang, sentence, table] of [
      ["en", "Direct file and text bytes never pass through a relay, so there is nothing to meter", TOTALIZED_FREE],
      ["en", "It is completely free, as long as you stay on the same network", TOTALIZED_FREE],
      ["zh", "同一网络内的传输完全免费", TOTALIZED_FREE],
      ["zh", "完全免费，只要你走的是直连", TOTALIZED_FREE],
    ]) {
      const at = hitIndex(table, lang, sentence);
      expect(at, `${lang}: ${sentence}`).toBeGreaterThanOrEqual(0);
      expect(pathScopes(lang, sentence, at), `${lang}: ${sentence}`).toBe(true);
    }
  });

  it("reads the static English homepage, not just the content tree", () => {
    // SURFACES is the reason rule (d) can see `/`. If index.html ever stops
    // parsing — a moved marker, a renamed script type — this fails loudly here
    // rather than silently reducing the guard's reach to the content tree.
    const surface = indexHtmlSurface(INDEX_HTML);
    expect(surface.faq.length, "no FAQ pairs parsed out of index.html").toBeGreaterThan(0);
    // Both halves: the JSON-LD answer and its no-JS twin.
    const priceQs = surface.faq.filter(({ q }) => WHOLE_PRODUCT_PRICE_Q.en.test(q));
    expect(priceQs.length, "the whole-product price question was not found twice").toBe(2);
    for (const { a } of priceQs) {
      expect(BARE_AFFIRMATIVE.en.test(a), `homepage answer opens with a bare yes: ${a.slice(0, 40)}`).toBe(false);
      expect(NAMES_THE_SOFTWARE.en.test(a)).toBe(true);
      expect(NAMES_THE_HOSTED_BOUND.en.test(a)).toBe(true);
    }
  });

  it("does not fire on the near misses that are not price claims", () => {
    // Each of these tripped an earlier draft of a rule above. They are pinned so
    // that widening a pattern later has to notice them again.
    expect(
      PATH_SCOPE.en.test("the file streams straight across, encrypted, at full speed and at no cost"),
    ).toBe(true); // a direct connection, described without the word "direct"
    expect(hit(TOTALIZED_FREE, "en", "so a connect-then-drop costs nothing")).toBe(false); // burn slots, not money
    expect(PATH_SCOPE.en.test("Same-network file and live-text transfers are always free")).toBe(true);
    expect(PATH_SCOPE.en.test("You can also stay 100% free by running your own node")).toBe(true);
    expect(
      GENERALISES_ABOUT_PATH_OR_COST.zh.test("但无论用哪种方式，接收方都从不需要账号"),
    ).toBe(false); // accounts, not directness or cost
  });
});
