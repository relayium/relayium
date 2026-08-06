// web/scripts/pages/browser-howto-tutorial.test.mjs — the eleven browser-facing
// how-tos are runnable tutorials, not essays, in all nine locales.
//
// cli-tutorial-structure.test.mjs does this job for the six CLI guides, where a
// "check" is a shell command and every code block is byte-identical across
// locales. Neither of those holds in a browser:
//
//   • The reader's diagnostic is a PAGE they open (https://relayium.com/…,
//     chrome://downloads) or an exact on-screen reading they compare — never a
//     command line. So the executable-first-token rule from the CLI file would
//     reject every honest check here, and a separate allowlist carries it.
//   • The app is localized. A guide that quotes an English button at a German
//     reader is telling them to click something their UI never shows
//     (content/GLOSSARY.md, "UI labels must match the shipped app"). So the
//     labels in these articles are DIFFERENT per locale on purpose, and what is
//     pinned instead is that each locale quotes the value its own
//     src/lib/i18n/<lang>.ts actually ships. That is the strongest rule in this
//     file: the expected values are read out of the app rather than typed here,
//     so a UI rename fails the tutorials that quote it.
//   • What must stay byte-identical is the machine half: URLs and the `#c=` /
//     `#k=` fragments. Those are compared against English.
//
// ── WHAT IS ASSERTED ────────────────────────────────────────────────────────
//  1. Presence per article per locale — all 99 documents carry prerequisites, an
//     ordered procedure, an observable success signal and troubleshooting.
//  2. Semantics in the rendered page, not just in the data: a procedure reaches
//     the reader as a real <ol> and troubleshooting as a well-formed <dl>.
//  3. Every troubleshooting entry carries a check that is OPENABLE (a page, a
//     browser-internal URL, a CLI command) or an exact on-screen reading, plus a
//     fix that names something concrete. "Check your network" cannot pass.
//  4. Locale alignment against English: structure, and every URL in every code
//     block, because a translated URL is a link that does not resolve.
//  5. Product truth per article, from the facts a reader would be misled by:
//     cross-network browser sessions are RELAYED (their success badge must be
//     the shipped "Relayed" label, never "LAN direct"), same-network discovery
//     turns on the public IP, the iOS blockers are iCloud Private Relay and
//     WebKit's missing File System Access API, and the stored link's key travels
//     in `#k=` and never reaches the server — though the browser that uploaded
//     keeps a local copy, so "My files" in that same browser can rebuild the
//     link (upload-keys.ts). "In `#k=` and nowhere else" is the wrong boundary:
//     the honest one is server vs. local browser.
//  6. Mutation proofs at the bottom: the same validators, run over deliberately
//     broken documents, must speak up. A guard nobody has watched fail is not a
//     guard.
import { describe, it, expect } from "vitest";

import sameWifi from "./content/articles/howto-same-wifi.mjs";
import pcPhone from "./content/articles/howto-pc-to-phone-wirelessly.mjs";
import androidIphone from "./content/articles/howto-android-to-iphone.mjs";
import macWindows from "./content/articles/howto-mac-to-windows.mjs";
import airdrop from "./content/articles/howto-airdrop-for-windows-android.mjs";
import computers from "./content/articles/howto-send-files-between-computers.mjs";
import qrCode from "./content/articles/howto-transfer-by-qr-code.mjs";
import sendText from "./content/articles/howto-send-text-between-devices.mjs";
import folder from "./content/articles/howto-send-a-folder.mjs";
import largeFiles from "./content/articles/howto-large-files-without-cloud.mjs";
import expiringLink from "./content/articles/howto-share-file-expiring-link.mjs";
import serverBackups from "./content/articles/howto-automate-server-backups.mjs";
import compareSnapdrop from "./content/articles/compare-snapdrop.mjs";

import en from "../../src/lib/i18n/en.ts";
import zh from "../../src/lib/i18n/zh.ts";
import ja from "../../src/lib/i18n/ja.ts";
import ko from "../../src/lib/i18n/ko.ts";
import de from "../../src/lib/i18n/de.ts";
import fr from "../../src/lib/i18n/fr.ts";
import ar from "../../src/lib/i18n/ar.ts";
import es from "../../src/lib/i18n/es.ts";
import pt from "../../src/lib/i18n/pt.ts";

import { buildArticlePages } from "./build-pages.mjs";
import { renderArticlePage } from "./article-template.mjs";
import { LANGS } from "./shared.mjs";

/**
 * The exact eleven this batch covers. Named rather than globbed: `howto-*` also
 * matches howto-automate-server-backups, which is a server/CLI guide and is
 * deliberately NOT in this set — see the partition test below, which is what
 * stops this list from silently falling behind the folder.
 */
const TUTORIALS = {
  "howto-same-wifi": sameWifi,
  "howto-pc-to-phone-wirelessly": pcPhone,
  "howto-android-to-iphone": androidIphone,
  "howto-mac-to-windows": macWindows,
  "howto-airdrop-for-windows-android": airdrop,
  "howto-send-files-between-computers": computers,
  "howto-transfer-by-qr-code": qrCode,
  "howto-send-text-between-devices": sendText,
  "howto-send-a-folder": folder,
  "howto-large-files-without-cloud": largeFiles,
  "howto-share-file-expiring-link": expiringLink,
};

/** The shipped app tables, so every expected label is read from the app. */
const APP = { en, zh, ja, ko, de, fr, ar, es, pt };

/** A dotted path into a locale table, or undefined when it is not a string. */
function label(lang, path) {
  const v = path.split(".").reduce((o, k) => (o == null ? o : o[k]), APP[lang]);
  return typeof v === "string" ? v : undefined;
}

const sections = (doc) => doc.sections || [];
const withPrereqs = (doc) => sections(doc).filter((s) => s.prereqs);
const withSteps = (doc) => sections(doc).filter((s) => s.steps?.length);
const withSuccess = (doc) => sections(doc).filter((s) => s.success);
const withTrouble = (doc) => sections(doc).filter((s) => s.troubleshooting);

/** Every code block a section can hold, in render order. */
const sectionCode = (s) => [
  ...(s.code || []),
  ...(s.steps || []).flatMap((step) => step.code || []),
  ...(s.success?.code || []),
  ...(s.troubleshooting?.items || []).flatMap((i) => i.code || []),
];

/** Every string in the document, joined with real newlines (see the CLI file:
 *  JSON.stringify destroys the word boundaries these rules depend on). */
const docStrings = (v) =>
  typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(docStrings) : [];
const docText = (doc) => docStrings(doc).join("\n");
const codeText = (doc) => sections(doc).flatMap(sectionCode).join("\n");

/**
 * What a browser reader can be told to CHECK. A closed allowlist, because the
 * point of the rule is that a "check" has to be something they can put on
 * screen — not a sentence:
 *   • a Relayium page they can open,
 *   • a browser-internal page (chrome://downloads, about:downloads) — the only
 *     honest way to confirm where a download actually landed,
 *   • a `relayium …` command, for the two places these guides touch the CLI,
 *   • an exact counter reading ("1,024 / 65,536 bytes") to compare against.
 * Extend it deliberately; every entry is used by one of these eleven today.
 */
const CHECKABLE = [
  /^https:\/\/relayium\.com(?:\/|$)/,
  /^(?:chrome|edge):\/\/[a-z/]+$/,
  /^about:[a-z]+$/,
  /^relayium\s+[a-z]+/,
  /^[\d][\d.,  ]* \/ [\d][\d.,  ]*\s\S/,
];

/** The first line of a check that is not a comment, or null. */
function checkLine(block) {
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\s+#\s.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    return line;
  }
  return null;
}

const isCheckable = (line) => line != null && CHECKABLE.some((re) => re.test(line));

/**
 * A fix has to name something the reader can act on: an address, a figure, a
 * named piece of software, or a labelled thing on screen.
 *
 * Deliberately wider than the CLI file's equivalent, and the reason is the
 * subject matter rather than laxity. A CLI fix can always name a flag or a path;
 * a browser fix often has nothing of the sort to name — "turn off iCloud Private
 * Relay for that Wi-Fi" is as concrete as advice gets, and contains neither. So
 * the rule accepts four families instead of one, each of which a piece of vague
 * hand-waving lacks: an address (a page, a browser-internal page, a link
 * fragment, a command), a figure, a product or technology name from PRODUCTS
 * below, or a UI element named inside the corpus's typographic quotes. The VAGUE
 * list and the 40-character floor carry the rest.
 */
const ADDRESS_OR_FIGURE = new RegExp(
  [
    "https://relayium\\.com",
    "(?:chrome|edge)://[a-z]+",
    "about:[a-z]+",
    "#[ck]=",
    "relayium\\s+[a-z]{2,}",
    "\\b\\d+\\b",
  ].join("|"),
);

// Product and technology names, which the corpus leaves untranslated in all nine
// locales, so naming one is evidence in Arabic exactly as in German.
const PRODUCTS =
  /Chrome|Edge|Firefox|Safari|WebKit|Android|iOS|iPhone|iPad|Windows|macOS|Linux|VPN|NAT|VLAN|iCloud|AirDrop|TURN|WebRTC|Wi-?Fi|WLAN|SSID|Mesh|USB|HTTPS?|ZIP64|\.zip|MiB|GiB|SHA-256|UTF-8|AES-256|File System Access|Relayium|relayium\.com|github\.com/i;

// A thing on screen, named in the quotes each locale actually uses (« », 「」,
// „ “, “ ”, ‘ ’). Quoting a label is how these guides point at a control, so a
// fix that does it is pointing at something the reader can find.
const QUOTED_UI = /[«「『„“‘][^«»「」『』„“”’]{2,}[»」』“”’]/;

const namesSomethingConcrete = (fix) =>
  ADDRESS_OR_FIGURE.test(fix) || PRODUCTS.test(fix) || QUOTED_UI.test(fix);

/**
 * Latin tokens of 4+ characters inside a check, comments included.
 *
 * A fix also counts as concrete when it names something the check itself shows —
 * AirDrop, WebKit, Private Relay. Latin-only and 4+ characters so a translated
 * word from a `#` comment cannot satisfy the rule trivially.
 */
const checkTokens = (blocks) =>
  [...new Set((blocks || []).join("\n").match(/[A-Za-z][A-Za-z0-9_.-]{3,}/g) || [])];

// Hand-waving that must never reach a diagnostic. English-only on purpose: the
// rule that carries every locale is CONCRETE above, and a nine-language table of
// vagueness would be a table of guesses rather than of things that shipped.
const VAGUE = [
  /check your (?:network|internet|connection|settings)\b/i,
  /make sure everything (?:is|looks) (?:ok|okay|correct|fine)/i,
  /try again later/i,
  /contact support/i,
  /something went wrong/i,
  /restart your (?:browser|device|computer)\.?$/i,
];

// A step or bullet that types its own number is fake numbering: the reader sees
// "1." and the machine sees a paragraph. Latin, CJK and Arabic separators.
const TYPED_NUMBER = /^\s*[(（]?\d+\s*[.)．、）:：]/;

/** Every URL-shaped token in a document's code blocks, in order. */
const urlsOf = (doc) => codeText(doc).match(/(?:https?|chrome|edge|about):[^\s"]+/g) || [];

/**
 * The structural contract, as a list of complaints. Returned rather than
 * asserted so the mutation tests can run it over a broken document and demand
 * that it speaks up.
 */
function validate(name, lang, doc, enDoc) {
  const bad = [];
  const at = `${name}[${lang}]`;

  const pre = withPrereqs(doc);
  if (pre.length !== 1) bad.push(`${at}: wants exactly one prerequisites block, found ${pre.length}`);
  for (const s of pre) {
    if (!s.prereqs.label?.trim()) bad.push(`${at}: prerequisites block has no label`);
    if (!(s.prereqs.items?.length >= 3)) bad.push(`${at}: prerequisites lists fewer than 3 items`);
    for (const i of s.prereqs.items || []) {
      if (i.trim().length < 20) bad.push(`${at}: prerequisite too short to be a condition: "${i}"`);
    }
  }

  const steps = withSteps(doc);
  if (steps.length !== 1) bad.push(`${at}: wants exactly one numbered procedure, found ${steps.length}`);
  for (const s of steps) {
    if (s.steps.length < 4) bad.push(`${at}: procedure "${s.heading}" has fewer than 4 steps`);
    for (const step of s.steps) {
      if (!step.text?.trim()) bad.push(`${at}: a step has no text`);
      if (TYPED_NUMBER.test(step.text || "")) bad.push(`${at}: step types its own number: "${step.text}"`);
      for (const b of step.code || []) if (!b.trim()) bad.push(`${at}: a step has an empty code block`);
    }
    // A browser step is "go here and look at this", so at least the first one
    // has to hand over an address rather than a description of one.
    if (!s.steps.some((step) => (step.code || []).some((c) => /https:\/\/relayium\.com/.test(c)))) {
      bad.push(`${at}: procedure "${s.heading}" never gives the reader a page to open`);
    }
  }
  for (const s of sections(doc))
    for (const b of s.bullets || [])
      if (TYPED_NUMBER.test(b)) bad.push(`${at}: bullet types its own number: "${b}"`);

  const ok = withSuccess(doc);
  if (ok.length !== 1) bad.push(`${at}: wants exactly one success block, found ${ok.length}`);
  for (const s of ok) {
    if (!s.success.label?.trim()) bad.push(`${at}: success block has no label`);
    if (!s.success.code?.length) bad.push(`${at}: success block shows no observable state`);
    if (!(s.success.body?.length >= 1)) bad.push(`${at}: success block never says what to look at`);
  }

  const fix = withTrouble(doc);
  if (fix.length !== 1) bad.push(`${at}: wants exactly one troubleshooting block, found ${fix.length}`);
  for (const s of fix) {
    if (!s.troubleshooting.label?.trim()) bad.push(`${at}: troubleshooting block has no label`);
    const items = s.troubleshooting.items || [];
    if (items.length < 4) bad.push(`${at}: troubleshooting lists fewer than 4 entries`);
    for (const i of items) {
      if (!i.symptom?.trim()) bad.push(`${at}: a troubleshooting entry has no symptom`);
      if (!i.code?.length) bad.push(`${at}: "${i.symptom}" has no check to make`);
      for (const block of i.code || []) {
        if (!isCheckable(checkLine(block))) {
          bad.push(`${at}: "${i.symptom}" check is not something to open or read: ${JSON.stringify(block)}`);
        }
      }
      const f = (i.fix || "").trim();
      if (f.length < 40) bad.push(`${at}: fix for "${i.symptom}" is too short to be a fix`);
      // Judged over the symptom AND the fix, because that pair is what a reader
      // consults as one unit — "the expiry list has no 14 days" plus "pick the
      // longest one offered" is concrete advice even though the figure sits in
      // the first half. The check is deliberately EXCLUDED from this judgement:
      // it is already required to be an openable locator above, so counting it
      // here would make the rule vacuous.
      //
      // English-only, for the same reason VAGUE below is: whether a sentence
      // names something actionable is a judgement about PROSE, and nine
      // per-language heuristics for it would be nine guesses that pass because
      // they never fire. What carries the other eight locales is mechanical
      // instead — every entry's check must be an openable locator, every locale
      // must quote the label its own app ships, the addresses must match English
      // byte for byte, and the per-article facts must survive translation.
      const stated = `${i.symptom || ""}\n${f}`;
      if (lang === "en" && !namesSomethingConcrete(stated) && !checkTokens(i.code).some((t) => f.includes(t))) {
        bad.push(`${at}: fix for "${i.symptom}" names nothing concrete`);
      }
      if (lang === "en") for (const v of VAGUE) if (v.test(f)) bad.push(`${at}: vague fix for "${i.symptom}"`);
    }
  }

  if (enDoc) {
    const shape = (d) => ({
      sections: sections(d).length,
      prereqItems: withPrereqs(d).flatMap((s) => s.prereqs.items).length,
      steps: withSteps(d).map((s) => s.steps.length).join(","),
      success: withSuccess(d).length,
      troubles: withTrouble(d).flatMap((s) => s.troubleshooting.items).length,
    });
    const mine = JSON.stringify(shape(doc));
    const theirs = JSON.stringify(shape(enDoc));
    if (mine !== theirs) bad.push(`${at}: structure diverges from en — ${mine} vs ${theirs}`);

    // On-screen labels are translated (they must be — see the header). URLs are
    // not: a link is a machine address, and a translated one does not resolve.
    const mineUrls = urlsOf(doc).join("\n");
    const theirUrls = urlsOf(enDoc).join("\n");
    if (mineUrls !== theirUrls) bad.push(`${at}: the addresses diverge from en — ${mineUrls} vs ${theirUrls}`);
  }
  return bad;
}

// ── UI LABELS, READ OUT OF THE SHIPPED APP ──────────────────────────────────
// Per article, the i18n keys whose value that locale's page must quote. The
// expected string is looked up in src/lib/i18n/<lang>.ts, so this fails both
// ways: a tutorial that invents a label, and a UI rename that leaves the
// tutorials pointing at a button nobody has any more.
const UI_ANCHORS = {
  // Same-network sending goes through the unified workspace: a nearby-device
  // card's one action is `workspace.open`, and files, folders and messages then
  // travel over that single connection. So the anchors are the card, the action
  // that opens the workspace, the two controls inside it, the gate an incoming
  // batch still has to pass, and the two path badges the header can show.
  "howto-same-wifi": ["peersTitle", "workspace.open", "sendFile", "sendFolder", "accept", "pathLan", "pathP2p"],
  // The four device-pair guides are same-network guides too, so they take the
  // same shape: the card, the one action it offers, the controls the workspace
  // then puts on screen, the gate an incoming batch still has to pass, and the
  // badge the header shows. `text.sendHint` is anchored on the three whose
  // sender is a computer; the phone-to-phone guide quotes the composer without
  // it, because a ⌘/Ctrl hint is not what that reader is looking at.
  "howto-pc-to-phone-wirelessly": ["peersTitle", "workspace.open", "sendFile", "sendFolder", "text.sendHint", "accept", "pathLan"],
  "howto-android-to-iphone": ["peersTitle", "workspace.open", "sendFile", "sendFolder", "accept", "pathLan"],
  "howto-mac-to-windows": ["peersTitle", "workspace.open", "sendFile", "sendFolder", "text.sendHint", "accept", "pathLan"],
  "howto-airdrop-for-windows-android": ["peersTitle", "workspace.open", "sendFile", "sendFolder", "text.sendHint", "accept", "pathLan"],
  "howto-send-files-between-computers": ["pathRelay", "pair.yourCode", "pair.joinBtn"],
  // A scan puts the second device in the room and stops there, so `accept` is
  // anchored too: an incoming batch is still gated on the receiving screen, and
  // that is the half a "just scan and it's sent" rewrite would drop.
  "howto-transfer-by-qr-code": ["pathRelay", "pair.scanHint", "pair.enterCode", "accept"],
  // Two procedures, deliberately not merged. Same network: the nearby-device
  // card's one action is `workspace.open`, and the composer lives inside that
  // workspace. Cross-network: a pairing-code room is NOT a link room
  // (peer-caps.svelte.ts gates CAP_LINK on `roomCode() === ""`), so it keeps the
  // older peer-card controls and `text.open` is still the button there. Both
  // labels are anchored so neither procedure can quietly absorb the other.
  "howto-send-text-between-devices": ["peersTitle", "workspace.open", "text.open", "text.sendHint", "text.copy"],
  // Same split for folders: `workspace.open` on the card, `sendFolder` as the
  // attachment inside the workspace, `accept` as the gate the batch still passes.
  "howto-send-a-folder": ["peersTitle", "workspace.open", "sendFolder", "accept", "pathLan"],
  "howto-large-files-without-cloud": ["stored.pick", "stored.ttlLabel", "download.done"],
  // `me.filesTitle` is the mechanical half of the key-recovery fact: the browser
  // that uploaded keeps the key locally, so every locale has to name its own
  // "My files" rather than telling the reader the link was the only copy.
  "howto-share-file-expiring-link": ["stored.linkReady", "stored.burnLabel", "stored.ttlLabel", "me.filesTitle"],
};

// French typography puts a no-break space before a colon, and whether a given
// string carries U+00A0 or a plain space is a typesetting decision rather than a
// different label. Normalise it on both sides so the rule stays about the words.
const flatSpace = (s) => s.replace(/ /g, " ");

function labelComplaints(name, lang, doc) {
  const bad = [];
  const text = flatSpace(docText(doc));
  for (const key of UI_ANCHORS[name]) {
    const want = label(lang, key);
    if (want === undefined) {
      bad.push(`${name}[${lang}]: i18n key ${key} is gone — the label rule would pass vacuously`);
      continue;
    }
    if (!text.includes(flatSpace(want))) {
      bad.push(`${name}[${lang}]: never quotes the shipped ${key} label ${JSON.stringify(want)}`);
    }
  }
  return bad;
}

// ── PRODUCT TRUTH, PER ARTICLE ──────────────────────────────────────────────
// Facts a reader would be actively misled by, each pinned on a token the corpus
// leaves untranslated in all nine locales (a URL, a product name, a number), so
// the rule bites in Arabic and Japanese exactly as it does in English. Digits
// are compared with separators stripped, because 65,536 / 65.536 / 65 536 are
// the same number written three correct ways.
const digits = (s) => s.replace(/[.,   ]/g, "");

const FACTS = {
  "howto-same-wifi": {
    tokens: ["https://relayium.com/", "https://relayium.com/cross-network", "chrome://downloads"],
    numbers: ["203.0.113.9"],
  },
  "howto-pc-to-phone-wirelessly": {
    tokens: ["https://relayium.com/cross-network", "Android", "chrome://downloads"],
    numbers: ["256"],
  },
  // The iOS pair has two blockers that no amount of Wi-Fi fixing touches:
  // iCloud Private Relay changes the phone's public IP, and every iPhone
  // browser is WebKit and so has no File System Access API. Private Relay is
  // ONE common cause of a mismatched public IP rather than the usual one, so
  // what is pinned is that the guide still names it — not that it blames it.
  "howto-android-to-iphone": {
    tokens: ["iCloud", "Safari", "WebKit"],
    numbers: ["256"],
  },
  // Windows forbids characters macOS allows, and Relayium's own collision
  // rename is `report (1).pdf` — a reader who expects an overwrite loses data.
  // POSIX and NTFS are the other half of the same honesty: the bytes and the
  // relative paths cross, the permission model does not, and only a guide that
  // says so has any reason to name either filesystem.
  "howto-mac-to-windows": {
    tokens: ["report (1).pdf", "File System Access", "Safari", "POSIX", "NTFS"],
    numbers: ["2026:08:05"],
  },
  // The honest gap against AirDrop: proximity is not the criterion, and an
  // air-gapped LAN cannot reach the rendezvous at all.
  "howto-airdrop-for-windows-android": {
    tokens: ["AirDrop", "github.com/relayium/relayium", ".zip"],
    numbers: ["256"],
  },
  "howto-send-files-between-computers": {
    tokens: ["https://relayium.com/cross-network#c=483920", "https://relayium.com/offline-transfer", "https://relayium.com/me"],
    numbers: ["483920"],
  },
  "howto-transfer-by-qr-code": {
    tokens: ["https://relayium.com/cross-network#c=483920", "#c="],
    numbers: ["483920"],
  },
  "howto-send-text-between-devices": {
    tokens: ["relayium text 483920", "UTF-8"],
    numbers: ["65536"],
  },
  "howto-send-a-folder": {
    tokens: [".zip", "ZIP64", "Safari"],
    numbers: ["1000", "4"],
  },
  "howto-large-files-without-cloud": {
    tokens: ["https://relayium.com/offline-transfer", "#k=", "AES-256-GCM"],
    numbers: ["256"],
  },
  "howto-share-file-expiring-link": {
    tokens: ["https://relayium.com/offline-transfer", "#k=", "AES-256-GCM"],
    numbers: ["512"],
  },
};

// ── CLAIMS THESE GUIDES HAVE ALREADY HAD TO RETIRE ──────────────────────────
// Wording that described an older build, or that was never true, and that a
// rewrite could plausibly bring back. English-only for the same reason VAGUE and
// DIRECT_OVERCLAIM are: each entry is a claim SHAPE, and nine translations of a
// shape would be nine guesses that pass because they never fire. What carries
// the other eight locales is mechanical instead — the shipped-label rule above,
// and the untranslated FACTS tokens (POSIX and NTFS on the Mac guide) that only
// a correctly hedged sentence has any reason to contain.
const RETIRED_CLAIMS = {
  "howto-send-files-between-computers": [
    // TURN is the deliberate cross-network route, but no implementation or
    // network contract promises a fixed setup time or proves that an attempted
    // direct path would have timed out. Desktop streaming also removes a
    // Relayium size cap without removing OS, disk or session limits.
    /(?:connects?|comes up) in (?:a )?(?:second or two|one or two seconds)/i,
    /direct attempts?[^.]{0,50}almost always time out/i,
    /essentially unlimited/i,
  ],
  "howto-pc-to-phone-wirelessly": [
    // A mobile browser MAY throttle or suspend a background tab; neither the
    // spec nor any shipped browser promises which. Stated as a certainty it
    // reads as "this cannot work", when leaving the tab in front is the fix.
    /\bandroid suspends a (?:backgrounded )?tab/i,
    /\bis suspended on android\b/i,
  ],
  "howto-android-to-iphone": [
    /\bis suspended on android\b/i,
    /a backgrounded tab is suspended/i,
    // Private Relay is one common cause of two public IPs. Calling it the
    // dominant one sends every other reader — mobile data, a VPN, a guest
    // SSID — to a setting that was never their problem.
    /almost always means icloud/i,
    /one cause dominates/i,
  ],
  "howto-mac-to-windows": [
    // The bytes and the relative paths cross; a Windows-forbidden character in
    // a name and the POSIX permission bits do not. "Nothing changes" is the
    // sentence that loses a reader their file mode without telling them.
    /no line-ending or filename changes/i,
    /(?:doesn't|does not) touch line endings, encoding, or filenames/i,
    /(?:filenames?|permissions?)[^.]{0,40}(?:never change|are never changed)/i,
  ],
  "howto-airdrop-for-windows-android": [
    // A room lists every device on the network, but a transfer still goes to
    // the one peer whose workspace you opened. Promising a fan-out promises
    // something the send path has no code for.
    /more than one nearby device can receive at once/i,
    /(?:several|multiple|more than one) devices?[^.]{0,40}receiv(?:e|ing)[^.]{0,20}at once/i,
  ],
  "howto-transfer-by-qr-code": [
    // A pairing code is not the only account-gated flow: creating an async
    // download link needs a signed-in sender too. Saying it is "the one place"
    // tells a reader the stored route is open to them when it is not.
    /is the one place relayium asks for/i,
    // The QR renders on the device that minted the code, so that side is the one
    // being scanned. That settles who joins whom and nothing else — either side
    // can be the sender once both are in the room.
    /(?:the other device|the other one) is always the one (?:doing the )?scanning/i,
    // Scanning opens the join link, which joins the room. It picks no files and
    // sends none, and an incoming batch is still gated by `accept`.
    /scanning (?:it )?starts the transfer/i,
    /(?:the scan|scanning)[^.]{0,40}sends? the files? (?:automatically|on its own)/i,
    /no acceptance is needed/i,
  ],
  "howto-send-text-between-devices": [
    // Before the unified workspace, a nearby-device card carried its own “Send a
    // message” button. It does not any more: that card's one action opens the
    // workspace and the composer lives inside it. The banned shape is the LAN
    // instruction only — in a cross-network pairing-code room the peer card
    // really does still offer that button, and the guide must keep saying so.
    /on the other device'?s card, (?:choose|press|tap|click) “Send a message”/i,
    /(?:choose|press|tap|click) “Send a message” on (?:the|that|a) nearby[- ]device'?s card/i,
  ],
  "howto-send-a-folder": [
    // The relative paths cross on a REALTIME send. A stored upload is handed a
    // flat File[] (StoredUpload.svelte drops PickedFile.path) and the manifest
    // is built from f.name, so the tree does not survive that route at all.
    /relative paths survive both routes/i,
    /(?:stored|download) link[^.]{0,60}(?:preserves|keeps|retains)[^.]{0,40}(?:structure|tree|relative path)/i,
    // A temporary drop resumes from the last durable checkpoint while both pages
    // are alive; only closing or reloading one really ends it. "Start over" is
    // the advice that throws away a transfer that was about to continue.
    /stops where it stopped rather than picking up later/i,
    /(?:a )?dropped connection[^.]{0,30}cannot resume/i,
    // The old LAN fork: a nearby-device card no longer sends a folder itself.
    /(?:choose|pick) the recipient'?s card and press/i,
  ],
  "howto-large-files-without-cloud": [
    // A limited download spends its slot once real ciphertext starts moving;
    // only a zero-byte response releases it. Normal retention choices are
    // already plan-filtered, and /me does not expose a live daily remainder.
    /burn(?:s|ed)? (?:only )?after (?:the )?(?:first )?complete(?:d)? download/i,
    /burn[^.]{0,20}only[^.]{0,20}(?:the )?(?:first )?complete(?:d)? download/i,
    /(?:the link stops working|deletes the file)[^.]{0,30}(?:once|when) the recipient finishes downloading/i,
    /server silently truncates/i,
    /\/me[^.]{0,100}(?:shows|displays)[^.]{0,50}(?:daily|today)[^.]{0,30}(?:remaining|left)/i,
    /either of you can close the laptop/i,
  ],
  "howto-share-file-expiring-link": [
    // The burn slot goes the moment real ciphertext starts moving — an
    // interrupted download spends it, and only a zero-byte attempt is released
    // (account/files.go: `if limited && n == 0 { ReleaseDownloadSlot }`).
    // Promising that burn waits for a complete download tells a reader their
    // half-finished download cost them nothing.
    /burn(?:s|ed)? (?:only )?after (?:the )?(?:first )?complete(?:d)? download/i,
    /(?:the link stops working|deletes the file)[^.]{0,30}(?:once|when) the recipient finishes downloading/i,
    // The key never reaches the server, but the browser that uploaded keeps it
    // in localStorage, so "My files" there can rebuild the link. Calling the
    // link the only copy sends a reader who still has that browser away.
    /the link (?:itself )?is the only copy of the key/i,
    /there is no key recovery/i,
    // The normal picker is already plan-filtered. The server repeats the cap as
    // a defensive check; it is not a hidden shortening step after a supported
    // option has been selected in the UI.
    /server[^.]{0,60}silently (?:truncates|shortens)/i,
  ],
};

function retiredClaimComplaints(name, doc) {
  const text = docText(doc);
  return (RETIRED_CLAIMS[name] || [])
    .filter((re) => re.test(text))
    .map((re) => `${name}[en]: brings back a retired claim — ${re}`);
}

// Positive half of the final safety/lifecycle repair. These are intentionally
// scoped to the two English masters: translated pages are carried by structural
// parity and their shipped-label/fact anchors, while pretending to recognise
// nine languages with English regexes would make this guard look stronger than
// it is.
const ACCURACY_ANCHORS = {
  "howto-send-files-between-computers": [
    /no relayium server imposes a size cap/i,
    /browser[^.]{0,80}operating system[^.]{0,80}(?:free space|disk)[^.]{0,100}live session/i,
  ],
  "howto-large-files-without-cloud": [
    /slot is spent as soon as a download starts receiving ciphertext/i,
    /delivered no bytes at all releases it/i,
    /monthly account usage, not a live remaining daily counter/i,
    /(?:the recipient(?:'s)?|their) own download still has to (?:run|continue) to the end/i,
  ],
};

function accuracyAnchorComplaints(name, doc) {
  const text = docText(doc);
  return (ACCURACY_ANCHORS[name] || [])
    .filter((re) => !re.test(text))
    .map((re) => `${name}[en]: loses a required accuracy anchor — ${re}`);
}

const TIMING_ARTICLES = [
  "howto-same-wifi",
  "howto-pc-to-phone-wirelessly",
  "howto-android-to-iphone",
  "howto-mac-to-windows",
  "howto-airdrop-for-windows-android",
  "howto-transfer-by-qr-code",
];

const TIMING_OVERCLAIM = [
  /(?:about|around|roughly) (?:20|twenty) seconds/i,
  /(?:connects?|connected|comes up|is established) in (?:a )?(?:second or two|one or two seconds|1[–-]2 seconds)/i,
  /direct (?:path|route|candidate|attempt)[^.]{0,70}(?:almost always|nearly always|rarely)/i,
];

function timingClaimComplaints(name, doc) {
  const text = docText(doc);
  return TIMING_OVERCLAIM
    .filter((re) => re.test(text))
    .map((re) => `${name}[en]: promises unsupported cross-network timing or probability — ${re}`);
}

function factComplaints(name, lang, doc) {
  const bad = [];
  const text = docText(doc);
  const flat = digits(text);
  for (const token of FACTS[name].tokens) {
    if (!text.includes(token)) bad.push(`${name}[${lang}]: no longer states ${JSON.stringify(token)}`);
  }
  for (const n of FACTS[name].numbers) {
    if (!flat.includes(digits(n))) bad.push(`${name}[${lang}]: no longer states the figure ${n}`);
  }
  return bad;
}

// ── THE ONE CLAIM THAT WOULD BREAK A CROSS-NETWORK READER ───────────────────
// A pairing-code browser session is relay-only BY DESIGN (rtcConfig() forces
// iceTransportPolicy: "relay" once the rendezvous hands out a credential). So on
// those two articles the badge a successful reader sees is the shipped
// `pathRelay` label, and seeing `pathLan` there would mean the two machines were
// never on different networks at all. Pinning it on success.code rather than on
// the whole document is deliberate: the prose is allowed — and expected — to
// explain what "LAN direct" would have meant.
const CROSS_NETWORK = ["howto-send-files-between-computers", "howto-transfer-by-qr-code"];

// Direct-P2P overclaims about the browser's cross-network path. English-only,
// like VAGUE: a tempered span is a claim SHAPE, and nine translations of one
// would be nine guesses. Harvested from the wording this corpus has had to
// correct before (see content-claims.test.mjs).
const DIRECT_OVERCLAIM = [
  /browsers? connect(?:s)? directly/i,
  /direct peer-to-peer (?:browser )?connection/i,
  /connects? (?:you )?directly to (?:the )?other (?:browser|device)/i,
  /straight (?:from|between) (?:one )?browser to (?:the other|another)/i,
  /no relay in between/i,
];

function relayPathComplaints(name, lang, doc, { english = false } = {}) {
  const bad = [];
  const success = withSuccess(doc)[0]?.success;
  if (!success?.code?.length) {
    return [`${name}[${lang}]: no success block to judge — the relay-path rule would pass vacuously`];
  }
  const shown = success.code.join("\n");
  const relayed = label(lang, "pathRelay");
  const lanDirect = label(lang, "pathLan");
  if (relayed === undefined || lanDirect === undefined) {
    return [`${name}[${lang}]: pathRelay/pathLan are gone from the app table — nothing to compare`];
  }
  if (!shown.includes(relayed)) {
    bad.push(`${name}[${lang}]: the success state does not show the relayed badge ${JSON.stringify(relayed)}`);
  }
  if (shown.includes(lanDirect)) {
    bad.push(`${name}[${lang}]: the success state claims ${JSON.stringify(lanDirect)} for a cross-network session`);
  }
  if (!english) return bad;
  // The diagnostics are where a wrong path claim does the most damage, because
  // that is what a reader consults when the transfer is already misbehaving.
  const judged = [
    ...(success.body || []),
    ...withTrouble(doc).flatMap((s) => (s.troubleshooting.items || []).map((i) => `${i.symptom} ${i.fix}`)),
  ].join("\n");
  for (const re of DIRECT_OVERCLAIM) {
    if (re.test(judged)) bad.push(`${name}[${lang}]: sells the cross-network path as direct — ${re}`);
  }
  return bad;
}

describe("the eleven browser how-tos are runnable tutorials in all nine locales", () => {
  it("carries prerequisites, an ordered procedure, a success signal and troubleshooting", () => {
    const bad = [];
    for (const [name, article] of Object.entries(TUTORIALS))
      for (const lang of LANGS)
        bad.push(...validate(name, lang, article.langs[lang], lang === "en" ? null : article.langs.en));
    expect(bad).toEqual([]);
  });

  it("covers all eleven articles and all nine locales, not a subset", () => {
    // Guards the guard: a renamed import or a shrunken LANGS would otherwise
    // turn every assertion above green by checking nothing.
    expect(Object.keys(TUTORIALS)).toHaveLength(11);
    expect(LANGS).toHaveLength(9);
    for (const [name, article] of Object.entries(TUTORIALS)) {
      expect(Object.keys(article.langs), name).toEqual([...LANGS]);
      for (const lang of LANGS) expect(article.langs[lang]?.sections?.length ?? 0, `${name}[${lang}]`).toBeGreaterThan(2);
    }
  });

  it("publishes the material rewrite date for every tutorial in the batch", () => {
    for (const [name, article] of Object.entries(TUTORIALS)) {
      expect(article.updated, name).toBe("2026-08-05");
    }
  });

  it("excludes the server guide deliberately rather than by accident", () => {
    // howto-automate-server-backups is a `howto-*` file that this batch does not
    // cover: it is a cron/SSH guide for the later server batch. Asserting that
    // it is NOT in the set is what stops someone from "fixing" a future failure
    // by quietly widening the list.
    const slugs = Object.values(TUTORIALS).map((a) => a.slug);
    expect(slugs).not.toContain(serverBackups.slug);
    expect(serverBackups.slug).toBe("how-to/automate-server-backups");
  });

  it("quotes the labels the app actually ships, in each locale's own language", () => {
    const bad = [];
    for (const [name, article] of Object.entries(TUTORIALS))
      for (const lang of LANGS) bad.push(...labelComplaints(name, lang, article.langs[lang]));
    expect(bad).toEqual([]);
  });

  it("keeps the label rule honest: the English page must not carry a German button", () => {
    // The mirror of the rule above. If a tutorial pasted one locale's UI string
    // into another, the check above would still pass (it only asks for its own
    // locale's label), so the cross-contamination is asserted separately.
    const bad = [];
    for (const [name, article] of Object.entries(TUTORIALS)) {
      const enText = docText(article.langs.en);
      for (const key of UI_ANCHORS[name]) {
        for (const lang of LANGS) {
          if (lang === "en") continue;
          const other = label(lang, key);
          // Some labels are legitimately identical across locales (LAN direct in
          // en and fr, for one), so only a value that DIFFERS from English can
          // be evidence of contamination.
          if (other && other !== label("en", key) && enText.includes(other)) {
            bad.push(`${name}: the en page quotes the ${lang} ${key} label ${JSON.stringify(other)}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps each article's critical facts in every locale", () => {
    const bad = [];
    for (const [name, article] of Object.entries(TUTORIALS))
      for (const lang of LANGS) bad.push(...factComplaints(name, lang, article.langs[lang]));
    expect(bad).toEqual([]);
  });

  it("does not bring back a claim these guides have already had to retire", () => {
    const bad = [];
    for (const name of Object.keys(RETIRED_CLAIMS)) {
      expect(TUTORIALS[name], `${name} is not in this batch`).toBeTruthy();
      bad.push(...retiredClaimComplaints(name, TUTORIALS[name].langs.en));
    }
    expect(bad).toEqual([]);
  });

  it("keeps the final size, burn, quota and page-lifecycle corrections explicit", () => {
    const bad = [];
    for (const name of Object.keys(ACCURACY_ANCHORS)) {
      bad.push(...accuracyAnchorComplaints(name, TUTORIALS[name].langs.en));
    }
    expect(bad).toEqual([]);
  });

  it("does not promise cross-network setup times or direct-path failure odds", () => {
    const bad = [];
    for (const name of TIMING_ARTICLES) bad.push(...timingClaimComplaints(name, TUTORIALS[name].langs.en));
    expect(bad).toEqual([]);
  });
});

describe("a cross-network browser session is reported as relayed, never as direct", () => {
  it("shows the shipped relayed badge as the success state, in all nine locales", () => {
    const bad = [];
    for (const name of CROSS_NETWORK)
      for (const lang of LANGS)
        bad.push(...relayPathComplaints(name, lang, TUTORIALS[name].langs[lang], { english: lang === "en" }));
    expect(bad).toEqual([]);
  });

  it("never claims a direct browser-to-browser path where the reader is diagnosing", () => {
    // Scoped to the rendered success and troubleshooting boxes rather than the
    // whole page, and deliberately so: these articles SHOULD say that two
    // browsers connect directly on the same LAN — that sentence is true, and it
    // is the contrast the cross-network section is written against. What must
    // never say it is the part a reader consults about a cross-network session.
    for (const name of CROSS_NETWORK) {
      const page = buildArticlePages([TUTORIALS[name]]).find((p) => p.path.startsWith("how-to/"));
      expect(page, `${name}: the English page must exist to be checked`).toBeTruthy();
      const box = (kind) => {
        const from = page.html.indexOf(`data-block="${kind}"`);
        expect(from, `${page.path}: no ${kind} block on the page`).toBeGreaterThan(-1);
        return page.html.slice(from, page.html.indexOf("</div>", from));
      };
      const judged = `${box("success")}\n${box("troubleshooting")}`;
      for (const re of DIRECT_OVERCLAIM) {
        expect(judged, `${page.path}: direct-path overclaim ${re}`).not.toMatch(re);
      }
      expect(box("success"), `${page.path}: the relayed badge never reaches the reader`).toContain(
        label("en", "pathRelay"),
      );
    }
  });

  it("keeps the same-network guides saying LAN direct, so the contrast is real", () => {
    // The other half of the same fact. If both families said the same thing the
    // rule above would be decoration.
    for (const lang of LANGS) {
      const shown = withSuccess(sameWifi.langs[lang])[0].success.code.join("\n");
      expect(shown, `same-wifi[${lang}]`).toContain(label(lang, "pathLan"));
      expect(shown, `same-wifi[${lang}]`).not.toContain(label(lang, "pathRelay"));
    }
  });
});

describe("the tutorial blocks reach the page with the right semantics", () => {
  const pages = Object.values(TUTORIALS).flatMap((a) => buildArticlePages([a]));

  it("renders one page per article per locale", () => {
    expect(pages).toHaveLength(11 * 9);
  });

  it("renders the procedure as an <ol>, never a <ul> and never typed numerals", () => {
    for (const page of pages) {
      expect(page.html, page.path).toContain('<ol class="steps" data-block="steps">');
      const ol = page.html.slice(page.html.indexOf('<ol class="steps"'));
      const body = ol.slice(0, ol.indexOf("</ol>"));
      expect(body, `${page.path}: a procedure must not be an unordered list`).not.toContain("<ul");
      expect(body, `${page.path}: steps must be <li><p>…`).toContain("<li><p>");
      expect(body, `${page.path}: a step must not print its own number`).not.toMatch(/<li><p>\s*\d+[.)]/);
      expect((body.match(/<li>/g) || []).length, `${page.path}: step count`).toBeGreaterThanOrEqual(4);
    }
  });

  it("labels the prerequisites, success and troubleshooting blocks distinctly", () => {
    for (const page of pages) {
      for (const kind of ["prereqs", "success", "troubleshooting"]) {
        expect(page.html, `${page.path}: missing ${kind}`).toContain(`data-block="${kind}"`);
      }
      const boxes = page.html.match(/<div class="cbox [^"]+" data-block="[a-z]+"><p class="cbox-t">/g) || [];
      expect(boxes.length, `${page.path}: every cbox needs a label`).toBeGreaterThanOrEqual(3);
      // Troubleshooting is a description list: the symptom is the term, the
      // check and the fix are its description.
      const fix = page.html.slice(page.html.indexOf('data-block="troubleshooting"'));
      const dl = fix.slice(fix.indexOf("<dl>"), fix.indexOf("</dl>"));
      const dts = (dl.match(/<dt>/g) || []).length;
      expect(dts, `${page.path}: dt count`).toBeGreaterThanOrEqual(4);
      expect(dts, `${page.path}: every dt needs its dd`).toBe((dl.match(/<dd>/g) || []).length);
      expect(dl.indexOf("<dt>"), `${page.path}: dt precedes dd`).toBeLessThan(dl.indexOf("<dd>"));
      expect(dl, `${page.path}: every check needs a <pre>`).toContain("<pre><code>");
    }
  });

  it("carries the openable checks through to the page, escaped", () => {
    // The reader's diagnostic has to survive rendering: an address that the
    // template mangled is not something they can open.
    for (const page of pages) {
      expect(page.html, `${page.path}: no Relayium page to open`).toContain("https://relayium.com/");
      expect(page.html, `${page.path}: raw < in a code block`).not.toMatch(/<code>[^<]*<(?!\/code)/);
    }
    const withFragment = buildArticlePages([expiringLink]);
    for (const page of withFragment) {
      expect(page.html, `${page.path}: the #k= fragment never reaches the reader`).toContain("#k=");
    }
  });

  it("emits the block stylesheet only on pages that use a block", () => {
    for (const page of pages) expect(page.html, page.path).toContain("ol.steps{");
    // An unrelated prose article must stay byte-for-byte free of all of it.
    const plain = buildArticlePages([compareSnapdrop])[0].html;
    expect(plain, "a prose article must not ship the block CSS").not.toContain("ol.steps{");
    expect(plain).not.toContain(".cbox{");
    expect(plain).not.toContain('data-block="');
    // The server guide is still deliberately outside THIS batch's set (see the
    // exclusion test above), but the later guides batch did give it the blocks,
    // so it is no longer an example of a page without them. What it still proves
    // here is the gating: a page that uses the blocks ships the CSS, and the
    // prose article above shows the same build emits none of it.
    const server = buildArticlePages([serverBackups])[0].html;
    expect(server, "the server guide now carries the blocks").toContain('data-block="steps"');
    expect(server, "so it must ship the block CSS too").toContain("ol.steps{");
  });

  it("keeps the RTL pages on logical properties and one main landmark", () => {
    const arPages = pages.filter((p) => p.path.startsWith("ar/"));
    expect(arPages).toHaveLength(11);
    for (const page of arPages) {
      expect(page.html).toContain('dir="rtl"');
      expect(page.html.split("<main>").length - 1).toBe(1);
      expect(page.html.split("</main>").length - 1).toBe(1);
    }
    const html = arPages[0].html;
    const css = html.slice(html.indexOf(".cbox{"), html.indexOf("</style>", html.indexOf(".cbox{")));
    expect(css).toContain("border-inline-start");
    expect(css).toContain("padding-inline-start");
    expect(css).not.toMatch(/(?:margin|padding|border)-(?:left|right)\s*:/);
    expect(css).not.toMatch(/text-align\s*:\s*(?:left|right)/);
  });

  it("renders a hostile browser label safely inside every block", () => {
    // A fixture rather than real content: escaping has to hold for whatever a
    // future author quotes out of the UI, including the characters that would
    // break the page if they reached it raw.
    const HOSTILE = '</code></pre><script>alert("x")</script> & "quoted" <b>';
    const doc = {
      title: "Fixture",
      description: "Fixture",
      updatedLabel: "Last updated",
      lead: ["Lead."],
      sections: [
        {
          heading: "Do the thing",
          prereqs: { label: `Need ${HOSTILE}`, items: [`item ${HOSTILE}`] },
          steps: [{ text: `step ${HOSTILE}`, code: [`https://relayium.com/ ${HOSTILE}`] }, { text: "no code" }],
          success: { label: `Worked ${HOSTILE}`, body: [`saw ${HOSTILE}`], code: [`state ${HOSTILE}`] },
          troubleshooting: {
            label: `If ${HOSTILE}`,
            items: [{ symptom: `sym ${HOSTILE}`, code: [`https://relayium.com/ ${HOSTILE}`], fix: `fix ${HOSTILE}` }],
          },
        },
      ],
      cta: { text: "cta", button: "go" },
      relatedHeading: "More",
    };
    const html = renderArticlePage({ slug: "how-to/fixture", lang: "ar", doc, updated: "2026-08-05" });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('alert("x")');
    // One occurrence per field that carried the fixture string: prereq label +
    // prereq item + step text + step code + success label + success body +
    // success code + troubleshooting label + symptom + check + fix = 11.
    expect((html.match(/&lt;\/code&gt;&lt;\/pre&gt;&lt;script&gt;/g) || []).length).toBe(11);
    expect(html).toContain("&amp; &quot;quoted&quot; &lt;b&gt;");
    const ol = html.slice(html.indexOf('<ol class="steps"'), html.indexOf("</ol>") + 5);
    expect(ol).toContain("<li><p>no code</p></li>");
    expect(html.split("<main>").length - 1).toBe(1);
  });
});

// The point of the file. Each mutation below is a real way this work could rot;
// if the rules above shrugged at any of them they would be decoration.
describe("the browser guard fails when a tutorial regresses", () => {
  const clone = (doc) => JSON.parse(JSON.stringify(doc));
  const enOf = (name) => clone(TUTORIALS[name].langs.en);

  it("catches removed prerequisites", () => {
    const doc = enOf("howto-same-wifi");
    for (const s of doc.sections) delete s.prereqs;
    expect(validate("x", "en", doc, null).join("\n")).toMatch(/exactly one prerequisites block, found 0/);
  });

  it("catches a procedure demoted to a bullet list", () => {
    const doc = enOf("howto-pc-to-phone-wirelessly");
    for (const s of doc.sections) {
      if (!s.steps) continue;
      s.bullets = [...(s.bullets || []), ...s.steps.map((step, i) => `${i + 1}. ${step.text}`)];
      delete s.steps;
    }
    const bad = validate("x", "en", doc, null).join("\n");
    expect(bad).toMatch(/wants exactly one numbered procedure, found 0/);
    expect(bad).toMatch(/bullet types its own number/);

    // And the rendered page loses the <ol> the semantics test demands.
    const html = renderArticlePage({ slug: "how-to/x", lang: "en", doc, updated: "2026-08-05" });
    expect(html).not.toContain('data-block="steps"');
  });

  it("catches a removed success block, and one with no state to compare", () => {
    const gone = enOf("howto-mac-to-windows");
    for (const s of gone.sections) delete s.success;
    expect(validate("x", "en", gone, null).join("\n")).toMatch(/wants exactly one success block, found 0/);

    const empty = enOf("howto-mac-to-windows");
    delete empty.sections.find((s) => s.success).success.code;
    expect(validate("x", "en", empty, null).join("\n")).toMatch(/shows no observable state/);
  });

  it("catches a removed troubleshooting block", () => {
    const doc = enOf("howto-airdrop-for-windows-android");
    for (const s of doc.sections) delete s.troubleshooting;
    expect(validate("x", "en", doc, null).join("\n")).toMatch(/exactly one troubleshooting block, found 0/);
  });

  it("catches troubleshooting rewritten as generic, non-actionable advice", () => {
    const doc = enOf("howto-same-wifi");
    const t = doc.sections.find((s) => s.troubleshooting).troubleshooting;
    t.items[0].code = ["make sure both devices are on the same network and try again"];
    t.items[0].fix = "Check your network settings on both devices and make sure everything is correct.";
    t.items[1].fix = "Have another look and then try the whole thing once more, slowly.";
    const bad = validate("x", "en", doc, null).join("\n");
    expect(bad).toMatch(/check is not something to open or read/);
    expect(bad).toMatch(/vague fix/);
    expect(bad).toMatch(/names nothing concrete/);
  });

  it("catches a procedure that stops handing the reader a page to open", () => {
    const doc = enOf("howto-transfer-by-qr-code");
    const s = doc.sections.find((x) => x.steps?.length);
    for (const step of s.steps) delete step.code;
    expect(validate("x", "en", doc, null).join("\n")).toMatch(/never gives the reader a page to open/);
  });

  it("catches a locale that translated an address", () => {
    const doc = clone(TUTORIALS["howto-large-files-without-cloud"].langs.de);
    const s = doc.sections.find((x) => x.steps?.some((st) => st.code?.length));
    const st = s.steps.find((x) => x.code?.length);
    st.code[0] = st.code[0].replace("/offline-transfer", "/asynchrone-uebertragung");
    expect(validate("x", "de", doc, TUTORIALS["howto-large-files-without-cloud"].langs.en).join("\n")).toMatch(
      /the addresses diverge from en/,
    );
  });

  it("catches a locale that dropped a step", () => {
    const doc = clone(TUTORIALS["howto-send-a-folder"].langs.ja);
    doc.sections.find((s) => s.steps?.length).steps.pop();
    expect(validate("x", "ja", doc, TUTORIALS["howto-send-a-folder"].langs.en).join("\n")).toMatch(
      /structure diverges from en/,
    );
  });

  // ── the browser-specific fact guards ──────────────────────────────────────

  it("catches a cross-network success state relabelled as a direct LAN hop", () => {
    // The overclaim this batch is most likely to reintroduce: a pairing-code
    // session is relay-only by design, so "LAN direct" there is not a nicer
    // wording of the same thing — it is a different transport.
    const doc = enOf("howto-send-files-between-computers");
    const s = doc.sections.find((x) => x.success);
    s.success.code = s.success.code.map((c) => c.replace(label("en", "pathRelay"), label("en", "pathLan")));
    const bad = relayPathComplaints("x", "en", doc, { english: true }).join("\n");
    expect(bad).toMatch(/does not show the relayed badge/);
    expect(bad).toMatch(/claims "LAN direct" for a cross-network session/);
  });

  it("catches a direct-P2P claim smuggled into a cross-network diagnostic", () => {
    const doc = enOf("howto-transfer-by-qr-code");
    const t = doc.sections.find((x) => x.troubleshooting).troubleshooting;
    t.items[0].fix = `${t.items[0].fix} Once it joins, the two browsers connect directly with no relay in between.`;
    const bad = relayPathComplaints("x", "en", doc, { english: true }).join("\n");
    expect(bad).toMatch(/sells the cross-network path as direct/);
  });

  it("notices when the same locale's success block disappears entirely", () => {
    // A rule about how a badge is worded passes trivially once there is no
    // badge, so the absence has to be a complaint of its own.
    const doc = enOf("howto-send-files-between-computers");
    for (const s of doc.sections) delete s.success;
    expect(relayPathComplaints("x", "en", doc).join("\n")).toMatch(/pass vacuously/);
  });

  it("catches the iOS guide losing iCloud Private Relay as one common cause", () => {
    // Two phones on one Wi-Fi that cannot see each other are often an iPhone
    // whose public IP was changed by Private Relay — one common reason among
    // several, not the majority verdict. A guide that drops it entirely sends
    // the reader to the router; one that blames it for everything sends the
    // reader with a VPN or mobile data to a setting they never had on. Both
    // halves are guarded: the name has to survive here, and the dominance
    // wording is banned by RETIRED_CLAIMS below.
    const doc = clone(TUTORIALS["howto-android-to-iphone"].langs.zh);
    const strip = (s) => s.replace(/iCloud/g, "云");
    doc.sections = doc.sections.map((s) => JSON.parse(strip(JSON.stringify(s))));
    expect(factComplaints("howto-android-to-iphone", "zh", doc).join("\n")).toMatch(/no longer states "iCloud"/);
  });

  it("catches the iOS guide promoting Private Relay back to the dominant cause", () => {
    const doc = enOf("howto-android-to-iphone");
    const s = doc.sections.find((x) => x.troubleshooting);
    s.body = [...(s.body || []), "On one Wi-Fi, one cause dominates: iCloud Private Relay."];
    expect(retiredClaimComplaints("howto-android-to-iphone", doc).join("\n")).toMatch(/one cause dominates/);
  });

  it("catches a device-pair guide reverting to the old LAN peer-card fork", () => {
    // Same mutation as the same-wifi one below, aimed at a second guide on
    // purpose: these four were the ones still telling a reader to press “Send
    // files” on a nearby-device card, which a current build does not show.
    const doc = enOf("howto-pc-to-phone-wirelessly");
    doc.sections = JSON.parse(
      JSON.stringify(doc.sections).replaceAll(label("en", "workspace.open"), label("en", "sendFile")),
    );
    expect(labelComplaints("howto-pc-to-phone-wirelessly", "en", doc).join("\n")).toMatch(
      /never quotes the shipped workspace\.open label/,
    );
  });

  it("catches the Mac guide promising that filenames and permissions never change", () => {
    // The bytes cross unchanged; the name may be impossible to create on NTFS
    // and the POSIX mode is not carried at all. Both halves are guarded — the
    // banned shape here, and POSIX/NTFS as required tokens in every locale.
    const doc = enOf("howto-mac-to-windows");
    const s = doc.sections.find((x) => /change/i.test(x.heading || ""));
    expect(s, "the Mac guide must keep a section about what changes").toBeTruthy();
    s.body = ["No. Relayium transfers the original bytes exactly as they are — no line-ending or filename changes."];
    expect(retiredClaimComplaints("howto-mac-to-windows", doc).join("\n")).toMatch(/no line-ending or filename changes/);

    // Whole document, not just `sections`: the FAQ answers the same question
    // again, so stripping one half would leave the token in the other and the
    // mutation would prove nothing.
    const stripped = JSON.parse(JSON.stringify(enOf("howto-mac-to-windows")).replace(/POSIX/g, "file"));
    expect(factComplaints("howto-mac-to-windows", "en", stripped).join("\n")).toMatch(/no longer states "POSIX"/);
  });

  it("catches the AirDrop guide promising a concurrent fan-out", () => {
    // The room is not capped at two devices, which is true and worth saying.
    // "So several receive at once" is the step that does not follow: a transfer
    // is addressed to the one peer whose workspace is open.
    const doc = enOf("howto-airdrop-for-windows-android");
    const s = doc.sections.find((x) => x.success);
    s.success.body = [...s.success.body, "The room is not capped, so more than one nearby device can receive at once."];
    expect(retiredClaimComplaints("howto-airdrop-for-windows-android", doc).join("\n")).toMatch(
      /more than one nearby device can receive at once/,
    );
  });

  it("catches a phone guide stating background suspension as a certainty", () => {
    const doc = enOf("howto-pc-to-phone-wirelessly");
    const t = doc.sections.find((x) => x.troubleshooting).troubleshooting;
    t.items[2].fix = `Android suspends a backgrounded tab, so no bytes move. ${t.items[2].fix}`;
    expect(retiredClaimComplaints("howto-pc-to-phone-wirelessly", doc).join("\n")).toMatch(
      /android suspends a \(\?:backgrounded \)\?tab/i,
    );
  });

  it("catches the Mac-to-Windows guide losing the collision rename", () => {
    // Relayium writes report (1).pdf rather than overwriting, and a reader who
    // believes the opposite will assume a file was replaced when it was not.
    const doc = enOf("howto-mac-to-windows");
    const s = doc.sections.find((x) => x.success);
    s.success.body = s.success.body.map((b) => b.replace(/report \(1\)\.pdf/g, "a new name"));
    expect(factComplaints("howto-mac-to-windows", "en", doc).join("\n")).toMatch(
      /no longer states "report \(1\)\.pdf"/,
    );
  });

  it("catches the text guide losing the one-message byte limit", () => {
    const doc = clone(TUTORIALS["howto-send-text-between-devices"].langs.fr);
    doc.sections = JSON.parse(JSON.stringify(doc.sections).replace(/65[.,  ]?536/g, "beaucoup"));
    expect(factComplaints("howto-send-text-between-devices", "fr", doc).join("\n")).toMatch(
      /no longer states the figure 65536/,
    );
  });

  it("catches the stored-link guides losing the #k= fragment", () => {
    // That fragment is how the key travels, and the server never receives it. A
    // guide that tells the reader to share "the link" without it is handing over
    // something undecryptable — the uploading browser's local copy is the only
    // other place the key exists, and only on that one device.
    const doc = enOf("howto-share-file-expiring-link");
    doc.sections = JSON.parse(JSON.stringify(doc.sections).replace(/#k=/g, "?key="));
    expect(factComplaints("howto-share-file-expiring-link", "en", doc).join("\n")).toMatch(/no longer states "#k="/);
  });

  it("catches a locale that quotes a button its own UI never shows", () => {
    const doc = clone(TUTORIALS["howto-same-wifi"].langs.de);
    doc.sections = JSON.parse(
      JSON.stringify(doc.sections).replace(new RegExp(label("de", "peersTitle"), "g"), "Nearby devices"),
    );
    const bad = labelComplaints("howto-same-wifi", "de", doc).join("\n");
    expect(bad).toMatch(/never quotes the shipped peersTitle label/);
  });

  it("catches the same-network guide reverting to the old LAN peer-card fork", () => {
    // Before the unified workspace, a nearby-device card sent files itself: it
    // carried its own “Send files” / “Send a folder” buttons and the path badge
    // sat on the card. That fork is gone — the card offers `workspace.open` and
    // nothing else, and the state is read off the workspace header. A guide that
    // drifts back to it is telling the reader to press a button their app no
    // longer has, so losing the workspace step has to be a complaint.
    const doc = enOf("howto-same-wifi");
    doc.sections = JSON.parse(
      JSON.stringify(doc.sections).replaceAll(label("en", "workspace.open"), label("en", "sendFile")),
    );
    expect(labelComplaints("howto-same-wifi", "en", doc).join("\n")).toMatch(
      /never quotes the shipped workspace\.open label/,
    );
  });

  it("catches the QR guide selling a scan as the transfer itself", () => {
    // Scanning opens the join link, and joining is where it stops: the sender
    // still picks the files and the receiving screen still has to press Accept.
    // "Scan and it's sent" is the sentence that leaves a reader staring at a
    // prompt nobody told them about.
    const doc = enOf("howto-transfer-by-qr-code");
    const s = doc.sections.find((x) => x.success);
    s.success.body = [...s.success.body, "Scanning starts the transfer, so no acceptance is needed on the other device."];
    const bad = retiredClaimComplaints("howto-transfer-by-qr-code", doc).join("\n");
    expect(bad).toMatch(/scanning \(\?:it \)\?starts the transfer/i);
    expect(bad).toMatch(/no acceptance is needed/i);
  });

  it("catches the QR guide fixing the direction, and calling itself the only account gate", () => {
    // Two overclaims from the same paragraph. The QR renders on the minting
    // device, which decides who joins whom rather than who may send afterwards;
    // and an async download link is account-gated exactly like a pairing code.
    const doc = enOf("howto-transfer-by-qr-code");
    const s = doc.sections.find((x) => x.prereqs);
    s.prereqs.items = [
      "Creating a pairing code is the one place Relayium asks for an account, and nothing else needs one.",
      "One direction, decided before you start: the other device is always the one doing the scanning.",
      ...s.prereqs.items.slice(2),
    ];
    const bad = retiredClaimComplaints("howto-transfer-by-qr-code", doc).join("\n");
    expect(bad).toMatch(/is the one place relayium asks for/i);
    expect(bad).toMatch(/is always the one \(\?:doing the \)\?scanning/i);
  });

  it("catches a QR guide dropping the acceptance gate from the shipped labels", () => {
    // The mechanical half of the same fact, and the half that carries the other
    // eight locales: every page has to quote its own `accept` label.
    const doc = JSON.parse(
      JSON.stringify(TUTORIALS["howto-transfer-by-qr-code"].langs.de).replaceAll(label("de", "accept"), "sofort"),
    );
    expect(labelComplaints("howto-transfer-by-qr-code", "de", doc).join("\n")).toMatch(
      /never quotes the shipped accept label/,
    );
  });

  it("catches the text guide reverting to the old LAN peer-card fork", () => {
    // Same-network text now lives in the workspace the card opens. The banned
    // instruction is the LAN one only: a cross-network pairing-code room really
    // does still put “Send a message” on the peer card, which is why the two
    // procedures are kept apart rather than merged.
    const doc = enOf("howto-send-text-between-devices");
    doc.sections = JSON.parse(
      JSON.stringify(doc.sections).replaceAll(label("en", "workspace.open"), label("en", "text.open")),
    );
    expect(labelComplaints("howto-send-text-between-devices", "en", doc).join("\n")).toMatch(
      /never quotes the shipped workspace\.open label/,
    );

    doc.sections.find((x) => x.steps?.length).steps[1].text =
      "On the other device's card, choose “Send a message” and start typing.";
    expect(retiredClaimComplaints("howto-send-text-between-devices", doc).join("\n")).toMatch(
      /on the other device'\?s card/i,
    );
  });

  it("catches the folder guide reverting to the old LAN peer-card fork", () => {
    const doc = enOf("howto-send-a-folder");
    doc.sections = JSON.parse(
      JSON.stringify(doc.sections).replaceAll(label("en", "workspace.open"), label("en", "sendFolder")),
    );
    expect(labelComplaints("howto-send-a-folder", "en", doc).join("\n")).toMatch(
      /never quotes the shipped workspace\.open label/,
    );

    doc.sections.find((x) => x.steps?.length).steps[2].text =
      "Choose the recipient's card and press “Send a folder”.";
    expect(retiredClaimComplaints("howto-send-a-folder", doc).join("\n")).toMatch(
      /\(\?:choose\|pick\) the recipient'\?s card and press/i,
    );
  });

  it("catches the folder guide flattening the truth about the stored route and about resume", () => {
    // Two failures a reader pays for directly. A stored upload is handed a flat
    // File[] and its manifest is built from f.name, so the tree does NOT cross
    // that way — recommending a link to preserve structure loses the layout and
    // collides same-named files. And a temporary drop resumes from the last
    // durable checkpoint while both pages live, so "it stops where it stopped"
    // throws away a transfer that was about to continue.
    const doc = enOf("howto-send-a-folder");
    const t = doc.sections.find((x) => x.troubleshooting).troubleshooting;
    t.items[3].fix = `Relative paths survive both routes, so nothing was flattened. ${t.items[3].fix}`;
    t.items[4].fix = "A realtime send stops where it stopped rather than picking up later, so start again.";
    const s = doc.sections.find((x) => /link/i.test(x.heading || ""));
    expect(s, "the folder guide must keep a section about the stored route").toBeTruthy();
    s.body = [...s.body, "A stored link preserves the folder structure just as a realtime send does."];
    const bad = retiredClaimComplaints("howto-send-a-folder", doc).join("\n");
    expect(bad).toMatch(/relative paths survive both routes/i);
    expect(bad).toMatch(/stops where it stopped rather than picking up later/i);
    expect(bad).toMatch(/preserves\|keeps\|retains/i);
  });

  it("catches the expiring-link guide promising that burn waits for a complete download", () => {
    // The slot is spent as soon as ciphertext starts moving. A reader told that
    // burn only fires on a completed download will retry a broken download and
    // find the file already gone — with their single slot spent on the half they
    // never received.
    const doc = enOf("howto-share-file-expiring-link");
    const s = doc.sections.find((x) => /burn/i.test(x.heading || ""));
    expect(s, "the guide must keep a section about burn-after-read").toBeTruthy();
    s.bullets = [...s.bullets, "Or: burn after the first complete download, instead of a fixed time"];
    s.body = [...s.body, "The link stops working once the recipient finishes downloading."];
    const bad = retiredClaimComplaints("howto-share-file-expiring-link", doc).join("\n");
    expect(bad).toMatch(/complete\(\?:d\)\? download/i);
    expect(bad).toMatch(/the recipient finishes downloading/i);
  });

  it("catches fixed-time and unlimited-capacity promises in the computer guide", () => {
    const doc = enOf("howto-send-files-between-computers");
    doc.faq.items[2].a += " It comes up in a second or two because direct attempts almost always time out first.";
    doc.faq.items[3].a = "Desktop Chrome and Edge are essentially unlimited.";
    const bad = retiredClaimComplaints("howto-send-files-between-computers", doc).join("\n");
    expect(bad).toMatch(/second or two/);
    expect(bad).toMatch(/almost always time out/);
    expect(bad).toMatch(/essentially unlimited/);

    const vague = enOf("howto-send-files-between-computers");
    vague.faq.items[3].a = "Large files work in a modern browser.";
    expect(accuracyAnchorComplaints("howto-send-files-between-computers", vague).join("\n")).toMatch(
      /required accuracy anchor/,
    );
  });

  it("catches burn, daily-quota, retention and close-laptop regressions in the large-file guide", () => {
    const doc = enOf("howto-large-files-without-cloud");
    const t = doc.sections.find((x) => x.troubleshooting).troubleshooting;
    t.items[1].fix = "/me shows the daily quota remaining and how much is left.";
    t.items[2].fix = "The server silently truncates a longer retention choice.";
    t.items[3].fix = "Burn only happens after the first completed download.";
    doc.sections.find((x) => x.prereqs).prereqs.items[3] =
      "Once upload finishes, either of you can close the laptop.";
    const bad = retiredClaimComplaints("howto-large-files-without-cloud", doc).join("\n");
    expect(bad).toMatch(/daily|today/);
    expect(bad).toMatch(/silently truncates/);
    expect(bad).toMatch(/complete/);
    expect(bad).toMatch(/either of you can close/);

    const incomplete = enOf("howto-large-files-without-cloud");
    incomplete.sections = JSON.parse(
      JSON.stringify(incomplete.sections)
        .replace(/slot is spent as soon as a download starts receiving ciphertext/gi, "single-use link")
        .replace(/delivered no bytes at all releases it/gi, "failed attempts may be retried")
        .replace(/monthly account usage, not a live remaining daily counter/gi, "account usage")
        .replace(/(?:the recipient's|their) own download still has to run to the end/gi, "the recipient can fetch later"),
    );
    expect(accuracyAnchorComplaints("howto-large-files-without-cloud", incomplete)).toHaveLength(4);
  });

  it("catches fixed cross-network timing and failure-probability promises", () => {
    const doc = enOf("howto-transfer-by-qr-code");
    const s = doc.sections.find((x) => /scan/i.test(x.heading || ""));
    s.body = [
      ...s.body,
      "A direct path almost always fails, taking around 20 seconds, while TURN connects in a second or two.",
    ];
    const bad = timingClaimComplaints("howto-transfer-by-qr-code", doc).join("\n");
    expect(bad).toMatch(/20|twenty/);
    expect(bad).toMatch(/second or two/);
    expect(bad).toMatch(/almost always/);
  });

  it("catches the expiring-link guide claiming supported retention is silently shortened", () => {
    const doc = enOf("howto-share-file-expiring-link");
    const s = doc.sections.find((x) => x.prereqs);
    s.prereqs.items[2] = "The server silently truncates a longer retention period rather than refusing it.";
    expect(retiredClaimComplaints("howto-share-file-expiring-link", doc).join("\n")).toMatch(
      /silently.*(?:truncates|shortens)/i,
    );
  });

  it("catches a stored-link guide losing the same-browser My files recovery", () => {
    // The key never reaches the server, but the browser that uploaded keeps it
    // in localStorage, so Account → My files there rebuilds the link. Both
    // halves are guarded: the shipped label has to survive in every locale, and
    // the "only copy" wording is banned in the English master.
    const doc = JSON.parse(
      JSON.stringify(TUTORIALS["howto-share-file-expiring-link"].langs.de).replaceAll(
        label("de", "me.filesTitle"),
        "die Kontoseite",
      ),
    );
    expect(labelComplaints("howto-share-file-expiring-link", "de", doc).join("\n")).toMatch(
      /never quotes the shipped me\.filesTitle label/,
    );

    const master = enOf("howto-share-file-expiring-link");
    const s = master.sections.find((x) => /zero-knowledge/i.test(x.heading || ""));
    expect(s, "the guide must keep a section about the zero-knowledge limits").toBeTruthy();
    s.body = [...s.body, "The link is the only copy of the key, and there is no key recovery."];
    const bad = retiredClaimComplaints("howto-share-file-expiring-link", master).join("\n");
    expect(bad).toMatch(/is the only copy of the key/i);
    expect(bad).toMatch(/there is no key recovery/i);
  });

  it("notices when an anchored i18n key stops existing", () => {
    // The label rule reads its expectations out of the app, so a renamed key
    // must fail loudly rather than making the rule vacuous.
    const doc = TUTORIALS["howto-same-wifi"].langs.en;
    const saved = APP.en.peersTitle;
    try {
      delete APP.en.peersTitle;
      expect(labelComplaints("howto-same-wifi", "en", doc).join("\n")).toMatch(/i18n key peersTitle is gone/);
    } finally {
      APP.en.peersTitle = saved;
    }
  });
});
