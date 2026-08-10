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
import firefoxSend from "./content/articles/compare-firefox-send.mjs";

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
// 428571, 123456 and ABCD-1234 all reached readers on this branch. Since the
// format change the alphabet is the ten decimal digits, so every old-alphabet
// example (K7M4XR and friends) is caught here too.
const CODE_ALPHABET = "0123456789";
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
    // tree the code-shaped arguments are all the same demonstration code, so
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
// ── (d) "realtime is the mode for large files" ────────────────────────────
// Realtime genuinely has no server-side size cap, and this rule does not touch
// that fact — the corpus states it in ten places and every one of them stays.
// What it forbids is the step from the fact to the recommendation: a realtime
// transfer rides one live session, so both page/app sessions must stay active;
// a temporary transport drop can resume, but closing or reloading ends the live
// session. The large-file path is the stored download link, which remains
// available after the upload completes. So the rule needs all three of a realtime word, a
// large-file word, and a word of RECOMMENDATION in the same sentence. Requiring
// the third is the whole design: without it the rule swallows "Realtime
// transfers handle up to 1,000 files per batch with no server-side size cap"
// (compare-dropbox, compare-google-drive, compare-wetransfer — nine locales
// each), which is true and is the differentiator those articles exist to state.
//
// Every RECOMMENDS entry below is harvested from the copy that shipped, so the
// rule recognises the defect rather than the fix.
// Portuguese is "tempo real" and Spanish "tiempo real"; German inflects the
// adjective AND umlauts the stem in the superlative (große → größten), which is
// why both halves are spelled out rather than guessed from the positive form.
const REALTIME_WORD = /\breal-?time\b|实时|リアルタイム|실시간|Echtzeit|temps réel|الفوري|t(?:ie|e)mpo real/i;
const LARGE_FILE_WORD =
  /\b(?:biggest|largest|large|big|huge|multi-gigabyte)\b[^.]{0,12}\bfiles?\b|大(?:的)?文件|最大的文件|大容量|大きなファイル|最大のファイル|큰 파일|대용량|gr(?:o|ö)(?:ß|ss)(?:e|en|er|ere|eren|ten)\s+Dateien|gros fichiers|ملفات كبيرة|أكبر الملفات|archivos (?:grandes|más grandes)|arquivos (?:grandes|maiores)|maiores arquivos/i;
const RECOMMENDS = {
  en: ["cleanest option", "best option", "best for", "best way", "ideal for", "the way to go", "recommended for", "reach for"],
  zh: ["最干净的选择", "最好的选择", "最佳选择", "最适合", "推荐用", "首选"],
  ja: ["最もすっきりした選択肢", "最良の選択肢", "最適です", "おすすめ"],
  ko: ["가장 깔끔한 선택", "가장 좋은 선택", "최선의 선택", "가장 적합"],
  de: ["sauberste Option", "beste Option", "am besten für", "ideal für", "empfiehlt sich"],
  fr: ["l'option la plus nette", "la meilleure option", "idéal pour", "le mieux pour", "recommandé pour"],
  ar: ["الخيار الأنظف", "الخيار الأفضل", "الأنسب", "الأمثل"],
  es: ["la opción más limpia", "la mejor opción", "ideal para", "lo mejor para", "recomendado para"],
  pt: ["a opção mais limpa", "a melhor opção", "ideal para", "o melhor para", "recomendado para"],
};

function recommendsRealtimeForLargeFiles(s, lang) {
  for (const raw of sentences(s)) {
    const t = stripArabicMarks(raw);
    const lt = t.toLowerCase();
    if (!REALTIME_WORD.test(t) || !LARGE_FILE_WORD.test(t)) continue;
    if (!RECOMMENDS[lang].some((p) => lt.includes(stripArabicMarks(p).toLowerCase()))) continue;
    return `recommends realtime as the mode for large files: "${raw.trim()}"`;
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

// ── (e) "a pairing-code room keeps the older, separate controls" ──────────
// Retired on 2026-08-10. `link/1` used to be scoped to the code-less LAN room,
// so a pairing-code room really did fall back to the legacy file/folder/message
// fork — and eleven strings across three articles said so. That scope is gone:
// `linkRoomActive()` is now `LINK_BUILD_SUPPORT` and nothing else, so a default
// build advertises and routes the unified link in EVERY room (peer-caps.svelte.ts,
// and web/e2e/code-room.mjs proves it in two real browsers: the pairing-room peer
// card offers exactly one action, which opens one link with one SAS and a composer
// visible by default with the file and folder controls under it).
//
// What did NOT move is `peerSupportsLink()`, still an exact match — so an older
// browser, a native client or the CLI keeps the legacy surfaces, in either room.
// That is why this rule is about the ROOM and never about the peer: "an older
// browser keeps the earlier flow" is correct copy and must keep passing, while
// "the pairing-code room keeps the older controls" is the retired claim.
//
// Every phrase below is harvested verbatim from the diff that removed it, per the
// header: a table written from the corrected copy would recognise none of them.
const PAIRING_ROOM = {
  en: ["pairing code", "pairing-code", "cross-network", "across networks"],
  zh: ["配对码", "跨网络"],
  ja: ["ペアリングコード", "クロスネットワーク", "ネットワークをまたぐ"],
  ko: ["페어링 코드", "교차 네트워크", "다른 네트워크", "네트워크를 넘"],
  de: ["pairing-code", "cross-network", "netzübergreifend", "über verschiedene netze", "über netze hinweg"],
  fr: ["code d'appairage", "code d’appairage", "interréseau", "entre réseaux", "cross-network", "code navigateur"],
  ar: ["رمز الاقتران", "رمز اقتران", "عبر الشبكات", "بين الشبكات", "عبر شبكتين"],
  es: ["código de emparejamiento", "código de navegador", "entre redes", "redes distintas"],
  pt: ["código de emparelhamento", "código de navegador", "entre redes", "redes diferentes"],
};
// Deliberately specific multi-word phrases. A bare "older" / "más antigua" /
// "plus ancienne" would swallow the comparison articles, which legitimately call
// somebody else's product older, and a rule that fires on those gets suppressed.
const OLDER_SURFACE = {
  // "the older controls" and not a bare "older controls": the corrected copy says
  // "the file and folder controls under it", and f-"older controls" is a substring
  // of it. A rule that fires on the sentence describing the NEW surface is worse
  // than no rule, and this one nearly did.
  en: ["the older controls", "own older controls", "older surface", "its own, older", "older interface", "older separate surface"],
  zh: ["更早的一套控件", "更早的、独立的界面", "更早的控件", "旧的一套控件"],
  ja: ["以前からの操作が残", "より古い独立した画面", "古いコントロール"],
  ko: ["예전 컨트롤", "더 오래된 별도의 화면", "오래된 컨트롤"],
  de: ["älteren bedienelemente", "ältere oberfläche", "eigene, ältere", "alten bedienelemente"],
  fr: ["anciennes commandes", "commandes plus anciennes", "surface distincte et plus ancienne"],
  ar: ["الأدوات الأقدم", "أدواتها الأقدم", "واجهة مستقلة وأقدم"],
  es: ["controles antiguos", "controles más antiguos", "superficie propia y más antigua"],
  pt: ["controles mais antigos", "superfície própria e mais antiga"],
};

/**
 * The retired claim, in any locale.
 *
 * The defect phrase must sit in the FOCAL sentence; the room evidence may come
 * from the sentence on either side of it. That window is not generosity — it is
 * required to see the shipped ja and ko defects at all, where 。 split "その部屋
 * には以前からの操作が残っていて…" away from the クロスネットワーク that identifies
 * which room "その部屋" is. As in rule (b), the window only ever ADDS evidence
 * that a sentence is on topic; it can never excuse one.
 */
function claimsPairingRoomIsOlder(s, lang) {
  const sents = sentences(s);
  for (let i = 0; i < sents.length; i++) {
    const focal = stripArabicMarks(sents[i]).toLowerCase();
    if (!OLDER_SURFACE[lang].some((p) => focal.includes(stripArabicMarks(p).toLowerCase()))) continue;
    const window = stripArabicMarks(sents.slice(Math.max(0, i - 1), i + 2).join(" ")).toLowerCase();
    if (!PAIRING_ROOM[lang].some((p) => window.includes(stripArabicMarks(p).toLowerCase()))) continue;
    return `says a pairing-code room keeps the older, separate controls: "${sents[i].trim()}"`;
  }
}

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

  it("never recommends realtime as the mode for large files", () => {
    const bad = scan(recommendsRealtimeForLargeFiles);
    if (bad.length) throw new Error(`realtime recommended for large files:\n  ${bad.join("\n  ")}`);
  });

  // The nine sentences below are the ones that shipped, verbatim from the diff
  // that removed them. A table written from the corrected copy would recognise
  // none of them.
  it("recognises the big-file recommendation in every language", () => {
    const BAIT = {
      en: "For the biggest files, when you can both be online, the realtime path stays the cleanest option.",
      zh: "对于最大的文件，只要双方都能在线，实时路径始终是最干净的选择。",
      ja: "最大のファイルでは、双方がオンラインになれるなら、リアルタイムの経路が常に最もすっきりした選択肢です。",
      ko: "가장 큰 파일이라면, 양쪽이 온라인일 수 있을 때 실시간 경로가 언제나 가장 깔끔한 선택입니다.",
      de: "Für die größten Dateien bleibt der Echtzeitweg die sauberste Option, wenn ihr beide online sein könnt.",
      fr: "Pour les plus gros fichiers, quand vous pouvez tous deux être en ligne, la voie en temps réel reste l'option la plus nette.",
      ar: "أما لأكبر الملفات، حين يمكنكما أن تكونا متصلين معًا، فيبقى المسار الفوري الخيار الأنظف.",
      es: "Para los archivos más grandes, cuando ambos lados pueden estar en línea, la vía en tiempo real sigue siendo la opción más limpia.",
      pt: "Para os maiores arquivos, quando os dois conseguem ficar online, o caminho em tempo real continua sendo a opção mais limpa.",
    };
    const deaf = LANGS.filter((l) => !recommendsRealtimeForLargeFiles(BAIT[l], l));
    if (deaf.length) throw new Error(`big-file recommendation rule never fires for: ${deaf.join(", ")}`);
  });

  // The mirror: the no-server-cap fact is not the defect, and a rule that
  // cannot tell them apart would force the corpus to stop stating a true
  // differentiator.
  it("does not fire on the true no-server-cap statement", () => {
    const FACTS = {
      en: "Realtime transfers handle up to 1,000 files per batch with no server-side size cap — Chrome and Edge stream large files straight to disk.",
      zh: "实时传输一次最多可处理 1,000 个文件，没有服务器端大小上限——Chrome 和 Edge 会把大文件直接流式写入磁盘。",
      ja: "リアルタイム転送は1バッチ最大1,000ファイルで、サーバー側のサイズ上限はありません。大きなファイルはChromeとEdgeがディスクへ直接書き出します。",
      ko: "실시간 전송은 배치당 최대 1,000개 파일을 다루며 서버 측 크기 상한이 없습니다. 큰 파일은 Chrome과 Edge가 디스크로 곧장 씁니다.",
      de: "Echtzeitübertragungen haben kein serverseitiges Limit; große Dateien streamen Chrome und Edge direkt auf die Festplatte.",
      fr: "Les transferts en temps réel n'ont aucune limite de taille côté serveur : Chrome et Edge écrivent les gros fichiers directement sur le disque.",
      ar: "لا حدّ من جهة الخادم لعمليات النقل الفوري؛ ويبثّ Chrome وEdge الملفات الكبيرة إلى القرص.",
      es: "Las transferencias en tiempo real no tienen tope de tamaño en el servidor: Chrome y Edge escriben los archivos grandes directamente en el disco.",
      pt: "As transferências em tempo real não têm limite de tamanho no servidor: Chrome e Edge gravam os arquivos grandes direto no disco.",
    };
    const trigger = LANGS.filter((l) => recommendsRealtimeForLargeFiles(FACTS[l], l));
    if (trigger.length) throw new Error(`big-file rule false-positives on the size fact in: ${trigger.join(", ")}`);
  });
});

describe("comparison articles describe realtime transport precisely", () => {
  const CANNOT_READ_OR_DECRYPT = {
    en: /cannot read or decrypt/i,
    zh: /无法读取或解密/,
    ja: /読んだり復号したりできません/,
    ko: /읽거나 복호화할 수 없습니다/,
    de: /weder lesen noch entschlüsseln/i,
    fr: /ni lire ni déchiffrer/i,
    ar: /لا يستطيع قراءة.+أو فك تشفيره/,
    es: /no puede leer ni descifrar/i,
    pt: /não consegue ler nem descriptografar/i,
  };

  it("never tells a reader that a pairing-code room keeps the older controls", () => {
    const bad = scan(claimsPairingRoomIsOlder);
    if (bad.length) throw new Error(`retired pairing-room surface claims:\n  ${bad.join("\n  ")}`);
  });

  // Verbatim from the diff that removed them — one per locale, from the three
  // articles that carried the claim (howto-send-a-folder, howto-send-text-between-devices,
  // howto-transfer-by-qr-code). A green run over the corpus proves nothing about a
  // matcher that cannot fire, and the ja/ko entries are the ones that need the
  // look-back window, so they are the reason this case exists.
  it("recognises the retired pairing-room claim in every language", () => {
    const BAIT = {
      en: "Across networks it is a separate procedure — create a browser pairing code on the cross-network page, and that room keeps its own older controls.",
      zh: "跨网络的配对码房间保留的是更早的一套控件，文件夹按钮在房间自己的卡片上。",
      ja: "クロスネットワーク画面でブラウザ用コードを作り、もう一方のブラウザで参加します。その部屋には以前からの操作が残っていて、相手のカードには今も「メッセージを送る」が並びます。",
      ko: "교차 네트워크 페이지에서 브라우저 코드를 만들고 다른 브라우저가 참여합니다. 그 방은 예전 컨트롤을 그대로 두어 상대 카드에 여전히 “메시지 보내기”가 있습니다.",
      de: "Ein netzübergreifender Pairing-Code-Raum behält stattdessen die älteren Bedienelemente, mit seinem eigenen Ordner-Knopf auf der Karte des Raums.",
      fr: "Une salle par code d'appairage entre réseaux conserve au contraire les anciennes commandes, avec son propre bouton de dossier sur la carte de la salle.",
      ar: "أما غرفة رمز الاقتران عبر الشبكات فتحتفظ بالأدوات الأقدم، وزر المجلد فيها على بطاقة الغرفة نفسها.",
      es: "Una sala de código de emparejamiento entre redes conserva en cambio los controles antiguos, con su propio botón de carpeta en la tarjeta de la sala.",
      pt: "Já uma sala de código de emparelhamento entre redes mantém os controles mais antigos, com o botão de pasta no cartão da própria sala.",
    };
    const deaf = LANGS.filter((l) => !claimsPairingRoomIsOlder(norm(BAIT[l]), l));
    if (deaf.length) throw new Error(`retired pairing-room rule never fires for: ${deaf.join(", ")}`);
  });

  // The mirror, and the one that keeps this rule honest: the capability gate is
  // REAL. `peerSupportsLink()` is an exact match, so an older browser, a native
  // client or the CLI does keep the earlier one-at-a-time flow — in a pairing-code
  // room as much as on a LAN. That sentence is correct copy, it sits right next to
  // a pairing-code word in the shipped articles, and a rule that swallowed it
  // would force the corpus to stop stating a true limit.
  it("does not fire on the true statement about capability-gated older peers", () => {
    const FACTS = {
      en: "Across networks the peer card offers the same one action. The one exception is a peer that is not an up-to-date browser — an older one, a native app, the CLI: it keeps the earlier flow, where files and messages are used one at a time.",
      zh: "跨网络也是同一个动作。唯一的例外是不够新的对端——旧版浏览器、原生应用、CLI：它们保留更早的那套流程，文件和消息只能一次用一样。",
      ja: "ネットワークをまたぐ場合も同じ一つの操作です。唯一の例外は最新のブラウザではない相手——古いブラウザ、ネイティブアプリ、CLI——で、その場合はファイルとメッセージを一度に片方ずつ使う以前の流れが残ります。",
      ko: "다른 네트워크에서도 같은 하나의 동작입니다. 유일한 예외는 최신 브라우저가 아닌 상대 — 오래된 브라우저, 네이티브 앱, CLI — 로, 이 경우 파일과 메시지를 한 번에 하나씩 쓰던 이전 흐름이 남습니다.",
      de: "Netzübergreifend ist es dieselbe eine Aktion. Die einzige Ausnahme ist eine Gegenstelle, die kein aktueller Browser ist — ein älterer, eine native App, das CLI: Dort bleibt der frühere Ablauf, bei dem Dateien und Nachrichten nacheinander genutzt werden.",
      fr: "Entre réseaux, c'est la même action unique. La seule exception est un pair qui n'est pas un navigateur à jour — un ancien, une application native, le CLI : il conserve le flux antérieur, où fichiers et messages s'utilisent l'un après l'autre.",
      ar: "وعبر الشبكات هو الإجراء نفسه. والاستثناء الوحيد طرف ليس متصفحًا حديثًا — متصفح أقدم أو تطبيق أصلي أو CLI: فيبقى لديه المسار السابق حيث تُستخدم الملفات والرسائل واحدة تلو الأخرى.",
      es: "Entre redes es la misma acción única. La única excepción es un par que no es un navegador actualizado — uno antiguo, una app nativa, el CLI: conserva el flujo anterior, donde los archivos y los mensajes se usan de uno en uno.",
      pt: "Entre redes é a mesma ação única. A única exceção é um par que não é um navegador atualizado — um antigo, um app nativo, a CLI: ele mantém o fluxo anterior, em que arquivos e mensagens são usados um de cada vez.",
    };
    const trigger = LANGS.filter((l) => claimsPairingRoomIsOlder(norm(FACTS[l]), l));
    if (trigger.length) throw new Error(`retired pairing-room rule false-positives on the capability gate in: ${trigger.join(", ")}`);

    // And the substring trap this rule walked into once: the sentence that
    // describes the NEW surface says "the file and folder controls", in which
    // f-"older controls" is a substring. Caught before it shipped; pinned here so
    // a future widening of the table cannot reintroduce it.
    const NEW_SURFACE =
      "With both devices online in a pairing-code room, the peer card's one action opens a shared workspace: the composer on screen by default and the file and folder controls under it.";
    if (claimsPairingRoomIsOlder(NEW_SURFACE, "en")) {
      throw new Error("retired pairing-room rule fires on the sentence describing the new surface");
    }
  });

  it("distinguishes LAN direct from cross-network TURN in every Firefox Send locale", () => {
    const bad = [];
    for (const lang of LANGS) {
      const text = norm(firefoxSend.langs[lang].sections[3].body[0]);
      if (!/TURN/i.test(text)) bad.push(`${lang}: missing TURN`);
      if (!CANNOT_READ_OR_DECRYPT[lang].test(text))
        bad.push(`${lang}: does not say TURN cannot read or decrypt plaintext`);
    }
    if (bad.length) throw new Error(`imprecise Firefox Send realtime claims:\n  ${bad.join("\n  ")}`);
  });
});
