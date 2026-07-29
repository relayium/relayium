// web/scripts/pages/content-claims.test.mjs — three mechanical assertions over
// every locale of every content module, for the three claim families this branch
// shipped live: a pairing code no server could issue, a sentence telling readers
// that sending needs no account, and a sentence telling readers that a transfer
// tries a direct connection first and falls back to a relay.
//
// Deliberately narrow. This is not locale key-parity (src/lib/i18n.test.ts) and
// not a general fact checker — it pins the three things a human reviewer kept
// missing precisely because they read like prose rather than like code.
//
// ── HOW TO EXTEND THIS FILE, and the one mistake not to repeat ───────────────
// The first version of this test caught 4 locales out of 9 when a reviewer fed
// it the strings that had actually shipped. Root cause: the phrase tables were
// written by reading the CORRECTED copy. A guard built from what the text says
// when it is right cannot recognise what it says when it is wrong. So when you
// add a locale or a turn of phrase, harvest it from `git log -p` on the commit
// that FIXED a defect — every line that diff removed is a known-live defect and
// belongs in a table here. Reading the current copy will reproduce the bug.
//
// The phrases below that came from that recovery, and would never have been
// guessed from the corrected text, are marked "// shipped".
//
// The bar to clear before you change a rule: take a defect string that really
// shipped, put it in one locale at a time, run this file, and confirm it fails —
// for all nine locales, not for English. As last verified, five defect families
// × nine locales = 45 injections, 45 caught, zero false positives on the corpus.
import { describe, it } from "vitest";
import { LANGS } from "./shared.mjs";

// The whole content tree, by glob rather than a hand-kept list, so a new file is
// covered the day it lands. It used to be ./content/articles/*.mjs only, and the
// relay-fallback defect below was found in legal/security.mjs, legal/privacy.mjs
// and landing.mjs — every one of them outside the old glob.
const MODULES = Object.entries(
  import.meta.glob(["./content/**/*.mjs", "!./content/**/*.test.mjs"], { eager: true }),
).map(([path, mod]) => [path.replace("./content/", ""), mod]);

/** Every string in a value, flattened. */
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

// Content modules come in three shapes, and all three carry claims:
//   { langs: { en, zh, … } }   articles, legal pages, the mode pages
//   { en: {…}, zh: {…} }       install-section.mjs
//   { … }                      spa-pages.mjs — /pricing and /cli, English-only,
//                              and the surface where the last --server defect
//                              shipped precisely because it is not localized.
// landing.mjs has no `en` key at all (English is the SPA itself), so a missing
// locale is normal and must not throw.
function langMaps(mod) {
  const seen = new Set();
  const maps = [];
  for (const v of Object.values(mod)) {
    if (!v || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    if (v.langs && typeof v.langs === "object" && !seen.has(v.langs)) {
      seen.add(v.langs);
      maps.push(v.langs);
    } else if (LANGS.some((l) => v[l])) maps.push(v);
    else maps.push({ en: v });
  }
  return maps;
}

// Arabic ships with tashkeel in places (مُرحِّل) and without it in others, and a
// literal table can only match one of the two. Stripping the marks means every
// Arabic pattern below is written bare and matches both.
const TASHKEEL = /[ً-ْٰـ]/g;
const norm = (s) => s.replace(TASHKEEL, "");

/** Walk every (file, lang, string); `fn` returns a complaint or nothing. */
function scan(fn) {
  const bad = [];
  for (const [file, mod] of MODULES)
    for (const map of langMaps(mod))
      for (const lang of LANGS)
        for (const s of strings(map[lang])) {
          const why = fn(norm(s), lang);
          if (why) bad.push(`${file} [${lang}] ${why}`);
        }
  return bad;
}

// Sentence units. Splitting on 。 is what a reader would expect and what rules
// (a) and (c) want, but it is also what defeated the account rule in ja and ko:
// "up 以外はアカウント不要。relayium login が要るのは up だけ。" puts the claim
// and the only token that identifies it as a CLI claim in different sentences.
// So rule (b) reads a two-sentence window — but only to ADD evidence that a
// sentence is on-topic, never to excuse one. Widening a unit so that a
// neighbouring sentence can exculpate a claim is how a guard quietly dies.
const SENTENCE = /[^.!?。！？\n]+/g;
const sentences = (s) => [...s.matchAll(SENTENCE)].map((m) => m[0]);

// ── (a) demonstrated pairing codes ────────────────────────────────────────
// signal.CodeAlphabet / signal.CodeLen. A code outside them is one the server
// could never have issued, so the example fails before it reaches the network.
// 428571, 123456 and ABCD-1234 all reached readers on this branch.
const CODE_ALPHABET = "ACDEFHJKMNPRTWXY23456789";
const CODE_LEN = 6;
const INVOCATION = /relayium (send|receive)((?: +\S+)*)/g;
// The `(?: +\S+)*` above runs to the end of the string, so in prose it swallows
// the sentence: "Then run relayium send big.zip 428571 on the sender machine."
// used to have "machine" as its last argument, which is not code-shaped, and so
// it passed. Bound the argument list instead: consume tokens while they still
// look like arguments (a flag, a path, or an uppercase/digit token) and stop at
// the first ordinary word, which is where the command ended and prose resumed.
const ARGISH = /^[-~@]|[./\\:@]|^[A-Z0-9][A-Z0-9-]*$/;
const CODEISH = /^[A-Z0-9][A-Z0-9-]{2,}$/;
const TRAILING = /[.,;:)\]}!?。，、；：]+$/u;

function commandArgs(argstr) {
  const args = [];
  for (const raw of argstr.trim().split(/\s+/).filter(Boolean)) {
    const tok = raw.replace(TRAILING, "");
    if (!tok || !ARGISH.test(tok)) break;
    args.push(tok);
  }
  return args;
}

function badCodeExample(s) {
  for (const [, verb, argstr] of s.matchAll(INVOCATION))
    // Every code-shaped token inside the bounded argument list is judged, not
    // just the slot the grammar puts it in: the code is receive's first argument
    // and send's last, but a prose example can put it anywhere and the point is
    // that the number is unissuable wherever it sits. Across the whole content
    // tree exactly three distinct code-shaped arguments exist, all K7M4XR, so
    // this costs nothing in false positives and closes the positional hole.
    for (const tok of commandArgs(argstr))
      if (CODEISH.test(tok) && (tok.length !== CODE_LEN || [...tok].some((c) => !CODE_ALPHABET.includes(c))))
        return `demonstrates \`relayium ${verb} … ${tok}\`, which is not a code the server can issue`;
}

// ── (b) "sending needs no account" ────────────────────────────────────────
// `relayium send` needs an account whenever it has to mint a code. Three shapes
// have shipped or are one edit away, and each gets its own rule below, because a
// flat "send in the same sentence as 'no account'" rule matches 91 sentences of
// the current, correct corpus (every LAN and receiver-side claim) and so has no
// power. Re-measured after the glob widened to the whole content tree: 91 in
// ./content/articles alone (the original measurement, reproduced exactly), 96
// tree-wide with the loose /send/ that rule used, and still 37 tree-wide even
// with a word-bounded \bsend\b. Do not "simplify" this back into one rule.
//
// EXTEND THESE TABLES when you add a locale or a new turn of phrase. That is
// the whole maintenance cost of this test, and it is the point of it.
const NO_ACCOUNT = {
  en: ["no account", "without an account", "no login", "no sign-in", "without signing in", "need no account", "needs no account", "no account required", "no account at all"],
  zh: ["无需账号", "不需要账号", "不用账号", "无需登录", "不需要登录", "不用登录", "无需注册", "不需要注册"],
  ja: ["アカウント不要", "アカウントは不要", "アカウントなし", "アカウントはいりません", "アカウントもいりません", "ログイン不要", "ログインなし", "ログインせず"],
  ko: ["계정이 필요 없", "계정 없이", "계정 불필요", "계정도 필요 없", "로그인 없이", "로그인이 필요 없", "로그인 불필요"],
  // "braucht nichts ein Konto" — shipped, and unreachable from "braucht kein
  // Konto", which is what the corrected sentence says.
  de: ["kein Konto", "keinen Account", "ohne Konto", "keine Anmeldung", "ohne Anmeldung", "kein Login", "ohne Login", "braucht nichts ein Konto"],
  // "se passe de compte" — shipped. An idiom, not a negation of "compte".
  fr: ["aucun compte", "sans compte", "pas de compte", "sans connexion", "sans se connecter", "se passe de compte", "se passent de compte", "nul besoin de compte"],
  ar: ["بلا حساب", "دون حساب", "بدون حساب", "من دون حساب", "لا يحتاج إلى حساب", "لا تحتاج إلى حساب", "لا يحتاجان إلى حساب", "دون تسجيل دخول", "بلا تسجيل دخول"],
  // "se hace sin cuenta" — shipped; "sin cuenta" happens to be a substring, which
  // is luck, not design. Keep the full idiom listed so the next one is noticed.
  es: ["sin cuenta", "ninguna cuenta", "no necesita cuenta", "no necesitan cuenta", "no requiere cuenta", "no hace falta cuenta", "sin iniciar sesión", "se hace sin cuenta"],
  // "dispensa conta" — shipped. Portuguese says "dispenses with" where the rest
  // of the corpus negates, so no negation-based pattern would ever have seen it.
  pt: ["sem conta", "sem nenhuma conta", "não precisa de conta", "não precisam de conta", "não exige conta", "sem login", "dispensa conta", "dispensam conta"],
};
// Shape 1 — the carve-out that forgets send: "Everything except up needs no
// account", "alles andere … ohne Anmeldung". Keep these to real exclusion
// words; "the rest"-style remainders match true enumerated claims. Arabic
// "عدا" is spaced because it is a substring of إعدادات.
const EXCEPTION = {
  en: ["except", "other than", "apart from", "everything else", "anything else", "all but"],
  zh: ["除", "以外", "其它都", "其他都"],
  ja: ["以外", "それ以外"],
  ko: ["제외", "그 외", "빼면", "말고는"],
  de: ["außer", "abgesehen von", "alles andere"],
  fr: ["sauf", "à part", "hormis", "tout le reste"],
  ar: ["ما عدا", "باستثناء", " عدا "],
  es: ["excepto", "salvo", "aparte de", "todo lo demás"],
  pt: ["exceto", "salvo", "afora", "todo o resto", "tirando"],
};
// The claim must be about the CLI for this to be the bug: a same-network claim
// about phones ("sin cuenta en la misma red") is an exclusion and is true. Note
// this matches `relayium <verb>`, not the bare brand name — "Open Relayium on
// both phones and send your first file — no account needed on the same network"
// is browser copy and correct, and a bare /relayium/ swept it in.
const ABOUT_THE_CLI = /relayium (?:send|receive|up|down|push|pull|sync|serve|daemon|login)|push ?\/ ?pull|daemon[- ]direct/i;
// A sentence that also states the requirement is engaging with it, not denying
// it; `relayium login` is Latin script in every locale, so it travels. Localized
// verbs are deliberately NOT listed: "登录" / "ログイン" / "로그인" are substrings
// of the no-account phrases themselves ("不需要登录"), so adding them would
// exempt the very sentences this rule exists to catch.
const STATES_THE_REQUIREMENT = /relayium login|sign(?:ed|s)?[ -]in/i;
// Shape 2 — send listed as a mode that needs nothing: "everything else —
// push/pull, send/receive, daemon-direct, sync — keeps working with no login".
const MODE_PAIR = /send\s*[/、]\s*receive/i;
// Shape 3 — the plainest form: the command named, and the no-account claim
// predicated straight onto it. The old rule had `if (/send/.test(t)) continue;`
// here, which exempted ANY sentence containing "send" — that is, it exempted the
// literal bug from a test named after it, and an agent writing copy then
// reported keeping "send" inside no-login sentences *because the test checks
// that*. A guard that shapes prose instead of catching errors is worse than no
// guard. What the exemption was reaching for is real, though: naming send as
// the excepted thing ("everything except send needs no account") is correct
// copy. So the exemption is now positional — send has to sit AT the exception
// marker to earn it — and the plain assertion is caught by shape 3 below.
// The command form, not a bare "send": the corpus has 37 correct sentences that
// pair \bsend\b with a no-account phrase, nearly all of them browser or LAN copy
// ("send your first file — no account needed on the same network"), and no
// mechanical rule separates those from a prose-only "sending needs no account".
// Naming the command is what makes the claim a CLI claim, and the copy
// convention throughout the corpus is to name it. That is the deliberate limit
// of this shape: a prose-only denial that never says `relayium send` is out of
// reach here, and rule shapes 1 and 2 are what cover the enumerated forms.
const SEND_CMD = /relayium send/gi;
// How far a no-account phrase may sit after `relayium send` and still be read as
// predicated on it. 40 characters is a clause. The correct sentences that pair
// them at greater distance are the qualified ones the corpus really does make —
// "relayium send requires it only when the server has to mint a fresh code — run
// send with a code someone handed you and it mints nothing, so it needs no
// login" — and they must keep passing.
const PREDICATION = 40;

function deniesSendNeedsAnAccount(s, lang) {
  const sents = sentences(s);
  for (let i = 0; i < sents.length; i++) {
    const t = sents[i];
    const lt = t.toLowerCase();
    const claim = NO_ACCOUNT[lang].find((p) => lt.includes(p.toLowerCase()));
    if (!claim) continue;
    const window = sents.slice(i, i + 2).join(" ");

    // Shape 2: send/receive listed among the modes that need nothing.
    if (MODE_PAIR.test(t) && !STATES_THE_REQUIREMENT.test(t))
      return `lists send/receive as needing no account: "${t.trim()}"`;

    // Shape 3: `relayium send` with the denial predicated on it.
    const at = lt.indexOf(claim.toLowerCase());
    for (const m of t.matchAll(SEND_CMD)) {
      const gap = at - (m.index + m[0].length);
      if (gap >= 0 && gap <= PREDICATION && !STATES_THE_REQUIREMENT.test(t))
        return `says relayium send needs no account: "${t.trim()}"`;
    }

    // Shape 1: a carve-out that excepts something other than send. The window
    // supplies the CLI evidence that 。 split off in ja and ko.
    if (!ABOUT_THE_CLI.test(window)) continue;
    const exc = EXCEPTION[lang].find((p) => lt.includes(p.toLowerCase()));
    if (!exc) continue;
    const ei = lt.indexOf(exc.toLowerCase());
    const si = lt.indexOf("send");
    if (si >= 0 && Math.abs(si - ei) <= 24) continue; // send IS the exception
    return `excepts something from needing an account but never names send: "${t.trim()}"`;
  }
}

// ── (c) "it falls back to a relay" ────────────────────────────────────────
// False in every path, which is what makes it worth a mechanical rule rather
// than a reviewer's judgement:
//   • Browser cross-network (a pairing-code room) is TURN-relay-only BY DESIGN.
//     rtcConfig() in src/App.svelte forces iceTransportPolicy: "relay" when the
//     rendezvous handed out a relay credential — 1-2 s to connect instead of
//     ~20 s of doomed cross-NAT probing that ends on the same relay anyway.
//   • Same-LAN is direct, always; those sessions are never issued a credential.
//   • The CLI is direct-only and never relays file bytes. It fails instead.
// So nothing "falls back to a relay". Unlike a bare "direct" claim — true on a
// LAN, and a matter of judgement elsewhere — the fallback claim is wrong in
// every context, so it can be asserted flatly.
//
// Harvested from the diff that corrected them; every one of these shipped.
const FALLS_BACK = {
  en: ["falls back", "fall back", "falling back", "fell back"],
  zh: ["退回到", "回落到"],
  ja: ["フォールバック"],
  ko: ["폴백"],
  de: ["weicht", "weichen", "ausweichen", "auszuweichen", "ausgewichen"],
  fr: ["bascule", "basculer", "basculant", "se rabat"],
  ar: ["يتراجع", "يعود إلى", "تعود إلى", "يلجأ"],
  es: ["recurre a", "recurren a", "recurriendo a", "recurrir a"],
  pt: ["recorre a", "recorrem a", "recorrendo a", "recorrer a"],
};
// The rule is about the direct-vs-relay path choice, so all three of "falls
// back", a relay, and a direct path must be in the sentence. Requiring the
// direct word is not decoration: it is what keeps guides-own-node.mjs's "never
// fall back to our shared infrastructure … Only use my own nodes for
// relay/storage" out — that sentence is about node selection and has no notion
// of a direct path in it.
// Every form the corpus actually uses, which is not what this pattern used to
// list. Measured against the content tree, the old version was blind to:
//   ja  中継    33 occurrences — it only had the SIMPLIFIED 中继 (继 ≠ 継)
//   ko  중계    17 — it only had the loanword 릴레이
//   zh  中转     4 — the verb form, kept deliberately over the noun 中继
//   ar  مُرحِّل  145 — see stripArabicMarks below
// So the ja and ar halves of this guard were passing because they never fired,
// not because the copy was clean.
const RELAY = /\brelay(?:s|ed|ing)?\b|中继|中継|中转|リレー|릴레이|중계|relais|retransmis|مرحل|ترحيل/i;
// Arabic is written with diacritics throughout this corpus (المُرحِّل), and the
// marks are separate code points sitting between the letters — so a pattern
// written as the bare skeleton (مرحل) matches none of them. That skeleton had
// exactly 1 hit in the whole tree against 145 for the vocalised form. Strip the
// marks before matching rather than trying to spell every vocalisation.
const stripArabicMarks = (s) => s.replace(/[ً-ْٰـ]/g, "");
// "diret" is not a typo for "direct": Portuguese drops the c (direto / direta),
// and leaving it out is exactly how the pt locale slipped through a first draft
// of this rule while the other eight were caught.
const DIRECT = /direct|diret|direkt|直连|直接|직접|직결|مباشر/i;
// Denying the fallback is the corrected copy, and it is everywhere: "it doesn't
// fall back to a relay", "リレーにフォールバックせず", "es weicht nicht auf ein
// Relay aus". A negation anywhere in the sentence would be useless — the true
// claims say "when a direct connection ISN'T possible, it falls back" — so the
// negation has to be attached to the fallback verb itself, within a word or two.
const NOT_FALLING_BACK = {
  en: /(?:\bnot|\bnever|n['’]t|\brather than|\binstead of|\bwithout)\s+(?:\w+\s+){0,1}fall(?:s|ing|en)?\s+back/i,
  zh: /[不无没][^，。；]{0,3}(?:退回|回落)/,
  ja: /フォールバック[^。]{0,6}?(?:せず|しません|しない|ません|なし|ではなく|ありません|持ちません)/,
  ko: /폴백[^.]{0,6}?(?:없|않|아니)/,
  de: /(?:weicht|weichen)\s+(?:\w+\s+){0,2}nicht|(?:statt|anstatt|ohne|nicht)[^.]{0,30}(?:aus)?zuweichen|nicht\s+(?:\w+\s+){0,2}(?:aus)?weich/i,
  fr: /(?:plutôt que|au lieu|sans|jamais)[^.]{0,14}(?:bascul|se rabat)|ne\s+(?:\w+\s+){0,2}bascule\s+pas/i,
  ar: /لا\s+(?:يتراجع|يعود|تعود|يلجأ)|بدل(?:ا)?\s+من/,
  es: /(?:en lugar de|en vez de|sin|nunca)\s+recurr|no\s+recurre/i,
  pt: /(?:em vez de|em lugar de|sem|nunca)\s+recorr|não\s+recorre/i,
};
// Two false-positive classes the rule must not swallow:
//  1. push "falls back to a tar stream over SSH" when the far end has no
//     relayium (cli-backup-server-ssh, howto-automate-server-backups, all nine
//     locales). A different fallback, and a correct one — excluded by requiring
//     a relay word in the same sentence, since none of those sentences has one.
//  2. A comparison article stating that someone else's tool falls back to its
//     own relay. magic-wormhole really does ship a Transit Relay; that sentence
//     is true and is theirs. The cost is that a Relayium defect written inside a
//     sentence that also names a competitor would be missed — narrow, and worth
//     it against six false positives that would otherwise sit here forever.
const SOMEONE_ELSES_TOOL = /magic-wormhole|\bcroc\b|transit relay|localsend|syncthing|tailscale|resilio/i;

function claimsRelayIsAFallback(s, lang) {
  for (const raw of sentences(s)) {
    // Diacritics only ever hide a match, never create one, so normalising every
    // language is safe and keeps the Arabic tables from needing vocalised twins.
    const t = stripArabicMarks(raw);
    const lt = t.toLowerCase();
    if (!FALLS_BACK[lang].some((p) => lt.includes(p.toLowerCase()))) continue;
    if (!RELAY.test(t) || !DIRECT.test(t)) continue;
    if (NOT_FALLING_BACK[lang].test(t)) continue;
    if (SOMEONE_ELSES_TOOL.test(t)) continue;
    return `says a transfer falls back to a relay when a direct path fails: "${raw.trim()}"`;
  }
}
// Deliberately tolerated: guides-what-is-p2p-file-transfer.mjs defines the TURN
// protocol generically — "a fallback relay server that both devices connect to
// when a direct path fails" — in a networking-explainer section that is scoped
// to Relayium in the paragraph below it. Every locale of that sentence uses the
// noun ("a fallback relay server", "einen Ausweich-Relay-Server"), never the
// verb, and the tables above list only verb forms, so it passes without any
// special case. If you ever add a bare noun form to FALLS_BACK, that sentence is
// what will light up, and the answer is to reword it — "TURN is a relay server
// that both devices connect to when a direct path fails" says the same thing
// without the word — not to weaken the table.

describe("content claims about pairing codes, accounts and the relay", () => {
  it("demonstrates only codes the server could actually issue", () => {
    const bad = scan(badCodeExample);
    if (bad.length) throw new Error(`invalid pairing-code examples:\n  ${bad.join("\n  ")}`);
  });

  it("never tells a reader that sending needs no account", () => {
    const bad = scan(deniesSendNeedsAnAccount);
    if (bad.length) throw new Error(`over-broad no-account claims:\n  ${bad.join("\n  ")}`);
  });

  it("never tells a reader that a transfer falls back to a relay", () => {
    const bad = scan(claimsRelayIsAFallback);
    if (bad.length) throw new Error(`false relay-fallback claims:\n  ${bad.join("\n  ")}`);
  });

  // The rule above is nine independent per-language matchers, and a green run
  // proves nothing about a matcher that cannot fire at all. Two of them could
  // not: the ja half listed only the simplified 中继 while the corpus writes 中継
  // (33 occurrences), and the ar half listed the unvocalised مرحل while the
  // corpus writes مُرحِّل (145 vs 1). Both had been "passing" since they were
  // written. This feeds each locale a sentence that IS the thing the rule
  // forbids, and fails if the rule shrugs.
  it("actually fires in every language it claims to cover", () => {
    const BAIT = {
      en: "If a direct connection fails it falls back to a relay.",
      zh: "如果直连失败，就会回落到中继。",
      ja: "直接接続に失敗した場合は中継サーバーにフォールバックします。",
      ko: "직접 연결이 실패하면 릴레이로 폴백합니다.",
      de: "Wenn keine direkte Verbindung zustande kommt, weicht es auf ein Relay aus.",
      fr: "Si la connexion directe échoue, il bascule vers le relais.",
      ar: "إذا فشل الاتصال المباشر فإنه يتراجع إلى المُرحِّل.",
      es: "Si la conexión directa falla, recurre a un retransmisor.",
      pt: "Se a conexão direta falhar, recorre a um retransmissor.",
    };
    const deaf = LANGS.filter((l) => !claimsRelayIsAFallback(BAIT[l], l));
    if (deaf.length) throw new Error(`relay-fallback rule never fires for: ${deaf.join(", ")}`);
  });

  // The mirror of the above: a matcher that fires on everything is just as
  // useless, and the corrected copy ("does NOT fall back to a relay") is the
  // sentence most at risk of being swallowed.
  it("does not fire on copy that denies the fallback", () => {
    const DENIALS = {
      en: "It never falls back to a relay when a direct path is available.",
      zh: "在可以直连时它从不回落到中继。",
      ja: "直接接続できる場合は中継にフォールバックしません。",
      ko: "직접 연결이 가능하면 릴레이로 폴백하지 않습니다.",
      de: "Es weicht nicht auf ein Relay aus, wenn eine direkte Verbindung möglich ist.",
      fr: "Il ne bascule pas vers le relais lorsque la connexion directe est possible.",
      ar: "لا يتراجع إلى المُرحِّل عندما يكون الاتصال المباشر متاحًا.",
      es: "No recurre a un retransmisor cuando la conexión directa es posible.",
      pt: "Não recorre a um retransmissor quando a conexão direta é possível.",
    };
    const trigger = LANGS.filter((l) => claimsRelayIsAFallback(DENIALS[l], l));
    if (trigger.length) throw new Error(`relay-fallback rule false-positives on a denial in: ${trigger.join(", ")}`);
  });
});
