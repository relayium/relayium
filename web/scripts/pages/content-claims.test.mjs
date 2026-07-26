// web/scripts/pages/content-claims.test.mjs — two mechanical assertions over
// every locale of every article, for the two claim classes this branch shipped
// live three review rounds in a row: a pairing code no server could issue, and
// a sentence telling readers that sending needs no account.
//
// Deliberately narrow. This is not locale key-parity (src/lib/i18n.test.ts) and
// not a general fact checker — it pins the two things a human reviewer kept
// missing precisely because they read like prose rather than like code.
import { describe, it } from "vitest";
import { LANGS } from "./shared.mjs";

// By glob, not a hand-kept list, so a new article is covered the day it lands.
const DOCS = Object.entries(import.meta.glob("./content/articles/*.mjs", { eager: true })).map(
  ([path, mod]) => [path.split("/").pop(), mod.default],
);

/** Every string in a locale's doc, flattened. */
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

/** Walk every (file, lang, string); `fn` returns a complaint or nothing. */
function scan(fn) {
  const bad = [];
  for (const [file, doc] of DOCS)
    for (const lang of LANGS)
      for (const s of strings(doc.langs?.[lang])) {
        const why = fn(s, lang);
        if (why) bad.push(`${file} [${lang}] ${why}`);
      }
  return bad;
}

const SENTENCE = /[^.!?。！？\n]+/g;

// ── (a) demonstrated pairing codes ────────────────────────────────────────
// signal.CodeAlphabet / signal.CodeLen. A code outside them is one the server
// could never have issued, so the example fails before it reaches the network.
// 428571, 123456 and ABCD-1234 all reached readers on this branch.
const CODE_ALPHABET = "ACDEFHJKMNPRTWXY23456789";
const CODE_LEN = 6;
// The code slot is receive's first argument and send's last. Only tokens that
// already look like a code (uppercase/digits, no path characters) are judged —
// prose following a bare command name is not a code slot.
const INVOCATION = /relayium (send|receive)((?: +\S+)*)/g;
const CODEISH = /^[A-Z0-9][A-Z0-9-]{2,}$/;

function badCodeExample(s) {
  for (const [, verb, argstr] of s.matchAll(INVOCATION)) {
    const args = argstr.trim().split(/\s+/).filter(Boolean);
    if (!args.length) continue;
    const tok = verb === "receive" ? args[0] : args[args.length - 1];
    if (!CODEISH.test(tok)) continue;
    if (tok.length !== CODE_LEN || [...tok].some((c) => !CODE_ALPHABET.includes(c)))
      return `demonstrates \`relayium ${verb} … ${tok}\`, which is not a code the server can issue`;
  }
}

// ── (b) "sending needs no account" ────────────────────────────────────────
// `relayium send` needs an account whenever it has to mint a code. Two shapes
// have shipped, and each gets its own rule below, because a flat "send in the
// same sentence as 'no account'" rule matches 91 sentences of the current,
// correct corpus (every LAN and receiver-side claim) and so has no power.
//
// EXTEND THESE TABLES when you add a locale or a new turn of phrase. That is
// the whole maintenance cost of this test, and it is the point of it.
const NO_ACCOUNT = {
  en: ["no account", "without an account", "no login", "no sign-in", "without signing in", "need no account"],
  zh: ["无需账号", "不需要账号", "无需登录", "不需要登录", "不用登录", "无需注册"],
  ja: ["アカウント不要", "アカウントは不要", "アカウントなし", "ログイン不要", "ログインなし", "ログインせず"],
  ko: ["계정이 필요 없", "계정 없이", "계정 불필요", "로그인 없이", "로그인이 필요 없"],
  de: ["kein Konto", "ohne Konto", "keine Anmeldung", "ohne Anmeldung", "kein Login"],
  fr: ["aucun compte", "sans compte", "pas de compte", "sans connexion", "sans se connecter"],
  ar: ["بلا حساب", "دون حساب", "بدون حساب", "لا يحتاج إلى حساب", "لا تحتاج إلى حساب", "دون تسجيل دخول"],
  es: ["sin cuenta", "ninguna cuenta", "no necesita cuenta", "no necesitan cuenta", "sin iniciar sesión"],
  pt: ["sem conta", "sem nenhuma conta", "não precisa de conta", "não precisam de conta", "sem login"],
};
// Shape 1 — the carve-out that forgets send: "Everything except up needs no
// account", "alles andere … ohne Anmeldung". Keep these to real exclusion
// words; "the rest"-style remainders match true enumerated claims. Arabic
// "عدا" is spaced because it is a substring of إعدادات.
const EXCEPTION = {
  en: ["except", "other than", "apart from", "everything else", "anything else"],
  zh: ["除", "以外", "其它都", "其他都"],
  ja: ["以外", "それ以外"],
  ko: ["제외", "그 외"],
  de: ["außer", "abgesehen von", "alles andere"],
  fr: ["sauf", "à part", "hormis", "tout le reste"],
  ar: ["ما عدا", "باستثناء", " عدا "],
  es: ["excepto", "salvo", "aparte de", "todo lo demás"],
  pt: ["exceto", "salvo", "afora", "todo o resto"],
};
// The claim must be about the CLI for this to be the bug: a same-network claim
// about phones ("sin cuenta en la misma red") is an exclusion and is true.
const ABOUT_THE_CLI = /relayium|push\/pull|daemon/i;
// Shape 2 — send listed as a mode that needs nothing: "everything else —
// push/pull, send/receive, daemon-direct, sync — keeps working with no login".
// A sentence that also states the requirement is engaging with it, not denying
// it; `relayium login` is Latin script in every locale, so it travels.
const MODE_PAIR = /send\s*\/\s*receive/i;
const STATES_THE_REQUIREMENT = /relayium login|sign(?:ed|s)?[ -]in/i;

function deniesSendNeedsAnAccount(s, lang) {
  for (const m of s.matchAll(SENTENCE)) {
    const t = m[0].toLowerCase();
    if (!NO_ACCOUNT[lang].some((p) => t.includes(p.toLowerCase()))) continue;
    if (MODE_PAIR.test(t) && !STATES_THE_REQUIREMENT.test(t))
      return `lists send/receive as needing no account: "${m[0].trim()}"`;
    if (/send/.test(t)) continue; // names the exception, so it is not sweeping it in
    if (ABOUT_THE_CLI.test(t) && EXCEPTION[lang].some((p) => t.includes(p.toLowerCase())))
      return `excepts something from needing an account but never names send: "${m[0].trim()}"`;
  }
}

describe("article claims about pairing codes and accounts", () => {
  it("demonstrates only codes the server could actually issue", () => {
    const bad = scan(badCodeExample);
    if (bad.length) throw new Error(`invalid pairing-code examples:\n  ${bad.join("\n  ")}`);
  });

  it("never tells a reader that sending needs no account", () => {
    const bad = scan(deniesSendNeedsAnAccount);
    if (bad.length) throw new Error(`over-broad no-account claims:\n  ${bad.join("\n  ")}`);
  });
});
