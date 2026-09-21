#!/usr/bin/env node
// scripts/test/document-claims-test.mjs — what the repository's own documents
// may claim, checked on the one kind of commit that can break it.
//
// ## Why this is a Node check and not an XCTest case
//
// These claims were XCTest cases — ten in `MacSurfaceGuardTests`, three in
// `IOSSurfaceGuardTests` — and the only workflow that ran them was
// `swift-package.yml`, whose filter is exactly `apps/RelayiumKit/**` plus
// itself. None of the files they read lives there. On 2026-09-20 a docs-only
// commit moved `apps/README.md` to "In development at 0.4.1" while the guard
// still pinned 0.4.0; no path-filtered lane started, every hosted check was
// green, and `main` was red for a day until somebody ran `swift test` by hand.
//
// Adding the documents to the Swift lane's filter is refused by three CI policy
// tests, correctly: a README edit must not buy a paid macOS runner. So the
// claims moved HERE. `repo-hygiene.yml` has no path filter, runs on Linux, and
// runs on every `main` push and — through `merge-gate.yml` — every pull
// request. That is a strict superset of when the Swift copies ran, and it
// includes the five files a claim can be broken from:
//
//   README.md                        apps/README.md
//   apps/mac/release-readiness.json  web/native-releases.json
//   web/mac-app-store-release.json
//
// This file OWNS these claims. A Swift copy must not be kept or re-added beside
// it: two hand-maintained pins of one sentence drifting apart is the incident,
// not the cure.
//
// ## Fidelity: these are Swift string semantics, on purpose
//
// The assertions were moved, not reinterpreted, so the matching below does what
// the Swift did rather than what JavaScript does by default:
//
//   * a `Character` is an extended grapheme cluster, compared by canonical
//     equivalence — so `contains` here is grapheme-aligned over NFC-normalized
//     clusters, not a UTF-16 `includes`;
//   * `flattened` splits on `Character.isWhitespace`, which is the Unicode
//     White_Space property of the cluster's FIRST scalar (so `\r\n` is one
//     separator and U+FEFF is not one), and drops empty runs;
//   * the delivery-status row is found by `hasPrefix` on lines split at the
//     `\n` Character and is compared LOWERCASED — every needle against it is
//     lowercase, because a capitalised needle never matches and turns a ban
//     into a vacuous pass;
//   * the prediction window is ±60 Characters, not UTF-16 units.
//
// Two places are deliberately not identical, and both err on the strict side:
//
//   * `Character.isNumber` is Numeric_Type ≠ None, which JavaScript cannot
//     name. The prediction BAN uses `\p{N}` plus every Han ideograph (a
//     superset, so it can only flag more); the App Apple ID REQUIREMENT uses
//     ASCII digits (a subset, so it can only accept less).
//   * `localizedCaseInsensitiveContains` is locale-sensitive; this compares
//     lowercased text, which is what it does under the `en`/POSIX locale CI has.
//
// ## Why it proves itself
//
// Almost every claim here is a ban, and a ban over a document that was never
// opened, or through a matcher that cannot match, reports the same green as a
// clean document. So: every document must exist and be non-empty; the number of
// claims evaluated is held to a literal; every ban is PLANTED into an in-memory
// copy (wrapped or re-cased the way its shape must see through) and must go
// red; every required sentence is REMOVED and must go red; and each procedural
// rule has hand-written mutations, with legitimate edits that must stay green.
//
// No dependencies, so there is nothing to install.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const README = "README.md";
const APPS = "apps/README.md";
const READINESS = "apps/mac/release-readiness.json";
const MAC_MANIFEST = "web/native-releases.json";
const APP_STORE = "web/mac-app-store-release.json";

/** The three documents a reader takes as a statement of what the product IS. */
const CLAIM_SURFACES = [README, APPS, READINESS];
const INPUTS = [...CLAIM_SURFACES, MAC_MANIFEST, APP_STORE];

/**
 * How many claims one evaluation makes. A literal, so that a loop that quietly
 * stopped iterating — an emptied table, a renamed shape — is a failure rather
 * than a shorter green run. Change it in the same commit as the claim you add
 * or retire, and say which in the message.
 */
const EXPECTED_CLAIMS = 125;

// ---------------------------------------------------------------------------
// 1. Swift string semantics
// ---------------------------------------------------------------------------

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** A Swift `String`'s `Character`s: extended grapheme clusters. */
function characters(text) {
  const segment = () => Array.from(segmenter.segment(text), (part) => part.segment);
  // Needles are short and many; documents are long and few, and each is read
  // by several shapes. Callers never mutate the array.
  return text.length < 1024 ? segment() : memo("characters", text, segment);
}

/** Unicode White_Space, which is what `Character.isWhitespace` reads. */
const WHITE_SPACE = new Set([
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
  0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** `Character.isWhitespace`: decided by the cluster's first scalar. */
function isWhitespace(character) {
  return WHITE_SPACE.has(character.codePointAt(0));
}

/** `text.split(whereSeparator: \.isWhitespace).joined(separator: " ")`. */
function flattened(text) {
  const words = [];
  let word = "";
  for (const character of characters(text)) {
    if (isWhitespace(character)) {
      if (word !== "") words.push(word);
      word = "";
    } else {
      word += character;
    }
  }
  if (word !== "") words.push(word);
  return words.join(" ");
}

// A noncharacter, so it can be a cluster boundary marker without ever being
// document content. Built from its code point rather than typed.
const BOUNDARY = String.fromCharCode(0xffff);

// Segmenting a 140 kB document is cheap once and expensive 125 times per
// evaluation times 130 evaluations. Everything derived from the REAL documents
// is kept for the whole run; what a mutation derives is dropped after it.
const kept = new Map();
let scratch = new Map();
let keeping = false;

function memo(kind, text, compute) {
  // Keyed by the text and THEN the kind: V8 remembers a string's hash, so the
  // same document object is hashed once rather than once per lookup.
  for (const cache of [kept, scratch]) {
    const byKind = cache.get(text);
    if (byKind?.has(kind)) return byKind.get(kind);
  }
  const value = compute();
  const cache = keeping ? kept : scratch;
  if (!cache.has(text)) cache.set(text, new Map());
  cache.get(text).set(kind, value);
  return value;
}

/** Clusters, each NFC-normalized, fenced by BOUNDARY on every side. */
function key(text) {
  return memo("key", text, () => BOUNDARY
    + characters(text).map((character) => character.normalize("NFC")).join(BOUNDARY)
    + BOUNDARY);
}

/** Swift `haystack.contains(needle)`: cluster-aligned, canonically equivalent. */
function contains(haystack, needle) {
  if (needle === "") throw new Error("an empty needle is contained in everything; refusing it");
  return key(haystack).includes(key(needle));
}

/** Swift `haystack.hasPrefix(prefix)`. */
function hasPrefix(haystack, prefix) {
  return key(haystack).startsWith(key(prefix));
}

/** Swift `text.split(separator: "\n")`: `\r\n` is a different Character. */
function lines(text) {
  const out = [];
  let line = "";
  for (const character of characters(text)) {
    if (character === "\n") {
      if (line !== "") out.push(line);
      line = "";
    } else {
      line += character;
    }
  }
  if (line !== "") out.push(line);
  return out;
}

/** One row of the root README's delivery-status table, LOWERCASED, or null. */
function deliveryStatusEntry(readme, platform) {
  const row = lines(readme).find((line) => hasPrefix(line, `| **${platform}** |`));
  return row === undefined ? null : row.toLowerCase();
}

/** The root README's `## Delivery status` section, up to the next `## `. */
function deliverySection(readme) {
  return readme.split("## Delivery status")[1]?.split("\n## ")[0] ?? "";
}

/** Superset of `Character.isNumber`; see the header. Used by a BAN only. */
function isNumberForBan(character) {
  return /^[\p{N}\p{Script=Han}]/u.test(character);
}

const PREDICTION_WORDS = ["predicted", "projected", "estimated", "extrapolated",
  "expected count", "should come out at", "we expect around"];

/** Passages where a prediction word sits within 60 Characters of a number. */
function unobservedFigures(text) {
  const raw = characters(text.toLowerCase());
  const normal = raw.map((character) => character.normalize("NFC"));
  const passages = [];
  for (const word of PREDICTION_WORDS) {
    const needle = characters(word);
    let from = 0;
    while (from + needle.length <= normal.length) {
      let hit = -1;
      for (let at = normal.indexOf(needle[0], from); at >= 0; at = normal.indexOf(needle[0], at + 1)) {
        if (needle.every((character, offset) => normal[at + offset] === character)) {
          hit = at;
          break;
        }
      }
      if (hit < 0) break;
      const window = raw.slice(Math.max(0, hit - 60),
        Math.min(raw.length, hit + needle.length + 60));
      if (window.some(isNumberForBan)) passages.push(window.join(""));
      from = hit + needle.length;
    }
  }
  return passages;
}

// ---------------------------------------------------------------------------
// 2. The two release records, decoded the way `JSONDecoder` decoded them
// ---------------------------------------------------------------------------

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const optional = (value, ok) => value === undefined || value === null || ok(value);
const isString = (value) => typeof value === "string";
const isInt = (value) => typeof value === "number" && Number.isInteger(value);

/**
 * `ReleaseManifest { macos: MacRelease? }` with `available: Bool` required and
 * `version: String?`, `build: Int?`, `downloadUrl: String?`. Strong decoding is
 * the point: a `build` of 1.5 or `true` is a decode failure, not a plausible 1.
 */
function decodeMacManifest(text) {
  const root = JSON.parse(text);
  if (!isObject(root)) throw new Error("the top level is not an object");
  if (root.macos === undefined || root.macos === null) return { macos: null };
  const macos = root.macos;
  if (!isObject(macos)) throw new Error("`macos` is not an object");
  if (typeof macos.available !== "boolean") throw new Error("`macos.available` is not a boolean");
  if (!optional(macos.version, isString)) throw new Error("`macos.version` is not a string");
  if (!optional(macos.build, isInt)) throw new Error("`macos.build` is not an integer");
  if (!optional(macos.downloadUrl, isString)) throw new Error("`macos.downloadUrl` is not a string");
  return { macos };
}

/** `AppStoreRelease`: five fields, none optional. */
function decodeAppStoreRelease(text) {
  const release = JSON.parse(text);
  if (!isObject(release)) throw new Error("the top level is not an object");
  if (!isInt(release.schema)) throw new Error("`schema` is missing or not an integer");
  for (const field of ["appleId", "version", "publishedAt", "url"]) {
    if (!isString(release[field])) throw new Error(`\`${field}\` is missing or not a string`);
  }
  return release;
}

// ---------------------------------------------------------------------------
// 3. The claims that are one needle against one shape of one document
// ---------------------------------------------------------------------------

// Shapes: `raw` the text; `lower` lowercased; `flat` whitespace-flattened;
// `flatLower` flattened then lowercased; `flatAnyCase` flattened, compared
// case-insensitively; `deliveryFlat` / `deliveryLower` over the Delivery status
// section; `row:<platform>` over that platform's lowercased table row.

const WHY = {
  inline: "the Mac adopted the shared deep-link coordinator, so a README that still records "
    + "\"applies links inline\" as a follow-up sends a reader looking for work that is done",
  iosPublic: "PROJECT-GOVERNANCE.md \"Native product launch definition\": macOS has two real "
    + "public channels, iOS has none, and internal TestFlight is not a public release — phrases "
    + "rather than bare words, because the documents legitimately mention the App Store",
  fetchable: "\"there is a download\" and \"the download is one Gatekeeper will run\" are "
    + "different promises, so the documents must say what the published artifact IS",
  approval: "the readiness manifest records the OWNER's approval and the release job gates on "
    + "it; an accidental revert must fail here rather than reach the release as \"not approved\"",
  iosStatus: "the status has to be STATED, not merely left unclaimed: iOS development resumed "
    + "at 0.3.0, the current development version is named, nothing was ever released, and "
    + "internal TestFlight use is dated history rather than a current distribution channel. "
    + "When the iOS version moves, the document sentence and this pin move in ONE commit — "
    + "that they could move separately is the incident this file exists for",
  width: "decision 5 moved the window floor from 380 pt to 860×560; a document that still "
    + "names the old floor tells the next person the wrong width to check truncation at",
  workspace: "the merged Workspace and a browseable \"Open a link\" no longer exist; a "
    + "description of a screen a reader cannot find is worse than none — asserted in both "
    + "directions so deleting the sentence cannot satisfy it",
  overstate: "wording that overstates what is distributed without using a word the launch ban "
    + "catches; each phrase was true of a different tree than this one, and the corrected "
    + "sentences must be present rather than merely deleted",
  evidence: "the readiness manifest must name the artifact it actually observed (signed Debug) "
    + "and keep the caveat that a signed Release build was never exercised that way",
  iosRow: "the delivery-status table is what a reader can GET; iOS has shipped nothing, so it "
    + "has no row — and the section must still say what `apps/ios/` is, because a claim removed "
    + "instead of corrected is this repository's recurring documentation failure",
  browsersRow: "the platforms with no native client must still be told what to use, and Android "
    + "left that row when its APK was published",
  androidRow: "Android has a row of its own that names the direct-APK channel and the limits "
    + "that are still real, and must not resurrect the 0.1.1-era denials",
  roadmap: "the root README is concise and points detailed future work at docs/ instead of "
    + "growing a second long-form roadmap",
  iosOffer: "any iOS download offer anywhere in the README points at something that does not "
    + "exist; the no-app sentence must survive, Android must be stated as what it DOES ship, and "
    + "only the denial forms of the Android sentence are banned so the truth stays writable",
};

const IOS_STATUS_SENTENCE = "iOS development resumed on 2026-09-01 at version 0.3.0: internal "
  + "TestFlight builds were used for development acceptance before the earlier pause, and "
  + "neither the iOS app nor its share extension is publicly offered.";
const ROOT_IOS_STATE = "`apps/ios/` exists in this repository and its development has "
  + "**resumed**, at version `0.4.1`";

const ban = (doc, shape, needle, why) => ({ kind: "ban", doc, shape, needle, why });
const need = (doc, shape, needle, why) => ({ kind: "require", doc, shape, needle, why });
const across = (docs, make) => docs.flatMap(make);

const NEEDLE_CLAIMS = [
  // Was `MacSurfaceGuardTests.testNothingStillCallsTheMacLinkPathInline`, the
  // one assertion of it that read a document; the rest reads Swift sources and
  // stayed where the Swift lane can see them.
  ban(APPS, "raw", "**macOS still applies links inline**", WHY.inline),

  // Was `testNoClaimSurfaceClaimsAPublicIOSRelease`.
  ...across(CLAIM_SURFACES, (doc) => [
    "the ios app is publicly available", "download the ios app", "the ios app has launched",
    "the ios app is now live", "ios app is available for download",
  ].map((claim) => ban(doc, "lower", claim, WHY.iosPublic))),

  // Was `testTheDocsNameTheMacOSReleaseAReaderCanActuallyFetch` (its tag half
  // is derived from the manifest and lives in section 4).
  ...across([README, APPS], (doc) => [
    need(doc, "flatLower", "developer id-signed", WHY.fetchable),
    need(doc, "flatLower", "notarized", WHY.fetchable),
  ]),

  // Was `testTheReadinessManifestRecordsTheOwnersApproval`.
  need(READINESS, "raw", "\"approved\": true", WHY.approval),

  // Was `testTheDocsStateTheIOSEngineeringBuildStatusOutright` — the test the
  // 2026-09-20 incident turned red with nobody watching.
  need(APPS, "flat", IOS_STATUS_SENTENCE, WHY.iosStatus),
  ban(APPS, "flat", "are engineering builds distributed through internal TestFlight", WHY.iosStatus),
  need(APPS, "flat", "**In development at 0.4.1 and not public**", WHY.iosStatus),
  need(APPS, "flat", "**Development resumed 2026-09-01, at version 0.3.0.**", WHY.iosStatus),
  ban(APPS, "flat", "**Development paused", WHY.iosStatus),
  ban(README, "flat", "The iOS app runs its transfer, nearby and account workflows", WHY.iosStatus),
  need(README, "flat", ROOT_IOS_STATE, WHY.iosStatus),
  need(README, "flat", "It has never been publicly released", WHY.iosStatus),

  // Was `testNoDocumentAssertsTheOldMinimumWidth`.
  ...across(CLAIM_SURFACES, (doc) => ["380pt", "380 pt", "380-pt"]
    .map((spelling) => ban(doc, "raw", spelling, WHY.width))),

  // Was `testNoDocumentStillDescribesTheMergedWorkspaceOrABrowseableOpenLink`.
  ...across(CLAIM_SURFACES, (doc) => [
    "Workspace — one peer", "Workspace is one row", "one Workspace", "Workspace, Send a link",
    "a live Workspace", "sidebar names all five destinations",
  ].map((stale) => ban(doc, "flat", stale, WHY.workspace))),
  need(APPS, "flat", "LAN Transfer", WHY.workspace),
  need(APPS, "flat", "Cross-network Transfer", WHY.workspace),
  ban(APPS, "flat", "Open a link, Device Inbox", WHY.workspace),
  need(APPS, "flat", "five destinations", WHY.workspace),
  need(APPS, "flatAnyCase", "deep link", WHY.workspace),

  // Was `testNoClaimSurfaceOverstatesWhatIsDistributed` (its derived status
  // sentence lives in section 4).
  ban(APPS, "flat", "Nothing in this directory is publicly distributed", WHY.overstate),
  ban(APPS, "flat", "public macOS UI ships", WHY.overstate),
  ban(APPS, "flat", "the shipped app", WHY.overstate),
  ban(APPS, "flat", "nine shipped `.lproj`", WHY.overstate),
  ban(READINESS, "flat", "whole public macOS UI", WHY.overstate),
  ban(READINESS, "flat", "nine shipped .lproj", WHY.overstate),
  ban(READINESS, "flat", "a live shipped-bundle receive", WHY.overstate),
  need(APPS, "flat", IOS_STATUS_SENTENCE, WHY.overstate),
  need(READINESS, "flat", "Current-tree signed Debug QA repeated a live receive", WHY.evidence),
  need(READINESS, "flat", "NearbyReceiveE2E --send-to against the running Relayium.app", WHY.evidence),
  need(READINESS, "flat", "the file still existed 55 seconds after completion", WHY.evidence),
  need(READINESS, "flat", "A signed Release build has never been exercised this way", WHY.evidence),

  // Was `IOSSurfaceGuardTests.testTheReadmeDoesNotListIOSAsADeliveryPlatform`
  // (the row-presence halves are procedural and live in section 4).
  need(README, "deliveryFlat", ROOT_IOS_STATE, WHY.iosRow),
  need(README, "deliveryFlat", "It has never been publicly released", WHY.iosRow),
  need(README, "deliveryLower", "no app store listing", WHY.iosRow),
  need(README, "row:iPhone, iPad, Windows, Linux", "web app", WHY.browsersRow),
  need(README, "row:iPhone, iPad, Windows, Linux", "publishes no app for these platforms", WHY.browsersRow),
  ban(README, "row:iPhone, iPad, Windows, Linux", "android", WHY.browsersRow),
  need(README, "row:Android", "apk", WHY.androidRow),
  need(README, "row:Android", "no google play listing", WHY.androidRow),
  need(README, "row:Android", "foreground only", WHY.androidRow),
  ...["no device inbox", "no nearby discovery", "no account features"]
    .map((stale) => ban(README, "row:Android", stale, WHY.androidRow)),

  // Was `testTheReadmeNextEntryScopesTheRemainingIOSWork`.
  need(README, "raw", "[`docs/`](docs/)", WHY.roadmap),
  ban(README, "raw", "- **Next:", WHY.roadmap),

  // Was `testTheReadmeOffersNoIOSDownload`.
  ...["download the ios app", "get it on the app store", "testflight.apple.com"]
    .map((offer) => ban(README, "flatLower", offer, WHY.iosOffer)),
  need(README, "flatLower", "there is no relayium app for ios or windows", WHY.iosOffer),
  need(README, "flatLower", "an android public preview is published as a direct apk", WHY.iosOffer),
  ...["no relayium app for android", "relayium app for ios, android or windows",
    "publishes no android app"].map((denial) => ban(README, "flatLower", denial, WHY.iosOffer)),
];

const SHAPE_NOTE = {
  raw: "as written",
  lower: "ignoring case",
  flat: "ignoring line wrapping",
  flatLower: "ignoring line wrapping and case",
  flatAnyCase: "ignoring line wrapping and case",
  deliveryFlat: "inside \"## Delivery status\", ignoring line wrapping",
  deliveryLower: "inside \"## Delivery status\", ignoring case",
};

function shapeNote(shape) {
  if (shape.startsWith("row:")) {
    return `inside the delivery-status row "| **${shape.slice(4)}** |", ignoring case`;
  }
  return SHAPE_NOTE[shape];
}

/** The text a needle is judged against, or null when that text does not exist. */
function haystack(text, shape) {
  return memo(`haystack:${shape}`, text, () => haystackUncached(text, shape));
}

function haystackUncached(text, shape) {
  if (shape.startsWith("row:")) return deliveryStatusEntry(text, shape.slice(4));
  switch (shape) {
    case "raw": return text;
    case "lower": return text.toLowerCase();
    case "flat": return flattened(text);
    case "flatLower":
    case "flatAnyCase": return flattened(text).toLowerCase();
    case "deliveryFlat": return flattened(deliverySection(text));
    case "deliveryLower": return deliverySection(text).toLowerCase();
    default: throw new Error(`unknown shape ${shape}`);
  }
}

const needleId = (claim) => `${claim.kind}|${claim.doc}|${claim.shape}|${claim.needle}`;

// ---------------------------------------------------------------------------
// 4. One evaluation: every claim, over an in-memory world
// ---------------------------------------------------------------------------

/**
 * `world` maps a repository path to its text (or to `undefined` when the file
 * is missing). Pure, so the mutations below can run it over altered copies.
 */
function evaluate(world) {
  scratch = new Map();
  const failures = [];
  let claims = 0;
  const claim = (id, ok, message) => {
    claims += 1;
    if (!ok) failures.push({ id, message });
  };
  const structural = (id, ok, message) => { if (!ok) failures.push({ id, message }); };

  // -- inputs exist, are non-empty, and cannot collide with the matcher
  for (const path of INPUTS) {
    const text = world[path];
    structural(`input|${path}`, typeof text === "string" && haystack(text, "flat") !== "",
      `${path}: the file is missing or empty. Every claim about it would be judged over nothing, `
      + "and a ban over nothing passes — either the file moved and this check must follow it, or "
      + "it was deleted and this check is what should have said so.");
    structural(`boundary|${path}`, typeof text !== "string" || !text.includes(BOUNDARY),
      `${path}: contains U+FFFF, the noncharacter this check fences grapheme clusters with; `
      + "matching over it would be unsound.");
  }
  const doc = (path) => (typeof world[path] === "string" ? world[path] : "");

  // -- web/native-releases.json: what `publishedMacVersion()` validated
  const macWhy = "the documented release tag and status sentence are DERIVED from this record — "
    + "not from Xcode's MARKETING_VERSION, which advances before publication — so a record that "
    + "is unavailable, unversioned, carries a non-positive build or points at another asset "
    + "would put a broken link in the READMEs with every other claim still green";
  let macos = null;
  let macDecodeError = null;
  try {
    macos = decodeMacManifest(doc(MAC_MANIFEST)).macos;
  } catch (error) {
    macDecodeError = error.message;
  }
  claim("mac|decodes", macDecodeError === null,
    `${MAC_MANIFEST}: does not decode as a release manifest (${macDecodeError}) — ${macWhy}`);
  claim("mac|present", macos !== null,
    `${MAC_MANIFEST}: names no macOS release — ${macWhy}`);
  claim("mac|available", macos?.available === true,
    `${MAC_MANIFEST}: does not offer a published download (\`available\` is not true) — ${macWhy}`);
  claim("mac|version", isString(macos?.version),
    `${MAC_MANIFEST}: carries no version — ${macWhy}`);
  claim("mac|version-nonempty", isString(macos?.version) && macos.version !== "",
    `${MAC_MANIFEST}: carries an empty version — ${macWhy}`);
  claim("mac|build", isInt(macos?.build),
    `${MAC_MANIFEST}: carries no build — ${macWhy}`);
  claim("mac|build-positive", isInt(macos?.build) && macos.build > 0,
    `${MAC_MANIFEST}: carries a non-positive build — ${macWhy}`);
  const macVersion = isString(macos?.version) ? macos.version : null;
  const dmg = `https://github.com/relayium/relayium/releases/download/macos-v${macVersion}/Relayium.dmg`;
  claim("mac|dmg", macVersion !== null && macos.downloadUrl === dmg,
    `${MAC_MANIFEST}: \`downloadUrl\` is ${JSON.stringify(macos?.downloadUrl)}, not the immutable `
    + `DMG for its own version (${dmg}) — ${macWhy}`);

  // -- web/mac-app-store-release.json: what `publishedAppStoreRelease()` validated
  const storeWhy = "macOS ships on two independently versioned channels and only this record says "
    + "what Apple is serving; as a literal it said 1.3.1 through every release up to 1.3.8 and "
    + "stayed green, because a README and a pin copied from each other always agree";
  let store = null;
  let storeDecodeError = null;
  try {
    store = decodeAppStoreRelease(doc(APP_STORE));
  } catch (error) {
    storeDecodeError = error.message;
  }
  claim("store|decodes", storeDecodeError === null,
    `${APP_STORE}: does not decode as an App Store release (${storeDecodeError}) — ${storeWhy}`);
  claim("store|schema", store?.schema === 1,
    `${APP_STORE}: declares a schema this check does not read — ${storeWhy}`);
  claim("store|version-nonempty", isString(store?.version) && store.version !== "",
    `${APP_STORE}: carries an empty App Store version — ${storeWhy}`);
  claim("store|appleid-nonempty", isString(store?.appleId) && store.appleId !== "",
    `${APP_STORE}: carries an empty App Apple ID — ${storeWhy}`);
  claim("store|appleid-numeric", isString(store?.appleId) && /^[0-9]*$/.test(store.appleId),
    `${APP_STORE}: carries an App Apple ID that is not a bare numeric identifier — ${storeWhy}`);
  claim("store|published-at", isString(store?.publishedAt) && characters(store.publishedAt).length === 10,
    `${APP_STORE}: carries no ISO-8601 publication date (want 10 characters) — ${storeWhy}`);
  claim("store|url", store !== null && store.url === `https://apps.apple.com/app/id${store.appleId}`,
    `${APP_STORE}: names a product URL that does not address its own App Apple ID, so both READMEs `
    + `would be required to send readers to somebody else's app — ${storeWhy}`);

  // -- the needle claims
  for (const entry of NEEDLE_CLAIMS) {
    const text = haystack(doc(entry.doc), entry.shape);
    const needle = entry.shape === "flatAnyCase" ? entry.needle.toLowerCase() : entry.needle;
    const found = text !== null && contains(text, needle);
    const where = shapeNote(entry.shape);
    if (entry.kind === "ban") {
      // A missing row cannot satisfy a ban: the Swift unwrapped it first.
      claim(needleId(entry), text !== null && !found,
        text === null
          ? `${entry.doc}: the delivery-status row this ban reads is gone (${where}) — ${entry.why}`
          : `${entry.doc}: must NOT contain ${JSON.stringify(entry.needle)} (${where}) — ${entry.why}`);
    } else {
      claim(needleId(entry), found,
        `${entry.doc}: must contain ${JSON.stringify(entry.needle)} (${where}) — ${entry.why}`);
    }
  }

  // -- was `testTheDocsNameTheMacAppStoreRelease`
  const linkWhy = "the version is required INSIDE the product link, not merely somewhere in the "
    + "file: both channels have carried the same number, so a bare search is satisfied by the "
    + "Developer ID sentence alone and stays green through a rewrite that erases the App Store "
    + "version. The link is the only prose that says which channel a version belongs to";
  for (const path of [README, APPS]) {
    const flat = haystack(doc(path), "flat");
    const url = store?.url ?? null;
    claim(`store-link|${path}`, isString(url) && url !== "" && contains(flat, url),
      `${path}: must link the public Mac App Store product (${url}) — ${linkWhy}`);
    const spans = isString(url) && url !== ""
      ? flat.split(`](${url})`).slice(0, -1).map((before) => before.split("[").at(-1) ?? "")
      : [];
    claim(`store-spans|${path}`, spans.length > 0,
      `${path}: carries no Mac App Store link to read a version out of — ${linkWhy}`);
    const version = isString(store?.version) && store.version !== "" ? store.version : null;
    const unnamed = spans.filter((span) => version === null || !contains(span, version));
    claim(`store-span-version|${path}`, spans.length > 0 && unnamed.length === 0,
      `${path}: links the Mac App Store product without naming its release ${version}: `
      + `${unnamed.map((span) => `[${span}]`).join(", ") || "(no link to read)"} — ${linkWhy}`);
  }

  // -- was `testTheDocsNameTheMacOSReleaseAReaderCanActuallyFetch`, tag half
  for (const path of [README, APPS]) {
    const tag = `macos-v${macVersion}`;
    claim(`mac-tag|${path}`, macVersion !== null && contains(doc(path), tag),
      `${path}: must name the exact release tag a reader can fetch (${tag}, from ${MAC_MANIFEST}) `
      + `— ${WHY.fetchable}`);
  }

  // -- was `testNoClaimSurfaceOverstatesWhatIsDistributed`, derived half
  {
    const sentence = `**Status: released as ${macVersion}.**`;
    claim(`mac-status|${APPS}`, macVersion !== null && contains(haystack(doc(APPS), "flat"), sentence),
      `${APPS}: must state the macOS status precisely (${sentence}, version from ${MAC_MANIFEST}). `
      + "Derived, not written down: pinned as the literal 1.0 it stayed green from 1.1 to 1.2.3 "
      + `while the sentence described a release five versions old — ${WHY.overstate}`);
  }

  // -- was `testTheReadmeDoesNotListIOSAsADeliveryPlatform`, row-presence half
  claim("row-absent|iOS", haystack(doc(README), "row:iOS") === null,
    `${README}: iOS is back in the delivery-status table — ${WHY.iosRow}`);
  claim("row-present|iPhone, iPad, Windows, Linux",
    haystack(doc(README), "row:iPhone, iPad, Windows, Linux") !== null,
    `${README}: the no-native-app platforms lost their delivery-status row — ${WHY.browsersRow}`);
  claim("row-present|Android", haystack(doc(README), "row:Android") !== null,
    `${README}: Android has no delivery-status row of its own — ${WHY.androidRow}`);

  // -- was `testNoDocumentPublishesAPredictedFigure`
  for (const path of CLAIM_SURFACES) {
    const passages = memo("figures", doc(path), () => unobservedFigures(doc(path)));
    claim(`predicted|${path}`, passages.length === 0,
      `${path}: publishes an unobserved figure: ${passages.map((p) => `…${p}…`).join(" | ")} — `
      + "constraint 13: a repository document may carry a number only if somebody watched it "
      + "happen. Bound to a figure, not to the word: \"hard to estimate\" is ordinary English, a "
      + "prediction word within 60 characters of a digit is a number nobody observed");
  }

  return { failures, claims };
}

// ---------------------------------------------------------------------------
// 5. The real repository
// ---------------------------------------------------------------------------

const failures = [];
function check(ok, message) {
  if (!ok) failures.push(message);
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const real = {};
for (const path of INPUTS) {
  try {
    real[path] = utf8.decode(readFileSync(resolve(repoRoot, path)));
  } catch (error) {
    real[path] = undefined;
    check(false, `${path}: cannot be read as UTF-8 text (${error.message})`);
  }
}

keeping = true;
const verdict = evaluate(real);
keeping = false;
for (const failure of verdict.failures) check(false, failure.message);
check(verdict.claims === EXPECTED_CLAIMS,
  `this check evaluated ${verdict.claims} claim(s), want exactly ${EXPECTED_CLAIMS}. A table or a `
  + "loop changed size: if a claim was deliberately added or retired, move EXPECTED_CLAIMS in the "
  + "same commit; if not, some claims silently stopped being made.");

// ---------------------------------------------------------------------------
// 6. Proof that each claim can fail
// ---------------------------------------------------------------------------
//
// Run over in-memory copies of the real documents, and only meaningful when the
// real documents pass — a removal "fails as expected" for the wrong reason on a
// document that never had the sentence.

const WRAP = "\n    ";
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A banned needle, disguised exactly as far as its shape must see through. */
function disguise(entry) {
  const wrapped = entry.needle.split(" ").join(WRAP);
  switch (entry.shape) {
    case "raw": return entry.needle;
    case "lower": return entry.needle.toUpperCase();
    case "flat": return wrapped;
    case "flatLower": return wrapped.toUpperCase();
    default: return entry.needle.toUpperCase(); // a table row is one line, lowercased
  }
}

/** The world with a banned needle planted where its shape reads. */
function planted(entry) {
  const text = real[entry.doc];
  if (entry.shape.startsWith("row:")) {
    const prefix = `| **${entry.shape.slice(4)}** |`;
    return { ...real, [entry.doc]: text.split("\n")
      .map((line) => (line.startsWith(prefix) ? `${line} ${disguise(entry)} |` : line)).join("\n") };
  }
  return { ...real, [entry.doc]: `${text}\n\n${disguise(entry)}\n` };
}

/** The world with every occurrence of a required needle taken out of its document. */
function removed(entry) {
  const pattern = new RegExp(escapeRegExp(entry.needle).replace(/ /g, "\\s+"),
    ["raw", "flat", "deliveryFlat"].includes(entry.shape) ? "gu" : "giu");
  const text = real[entry.doc];
  const next = text.replace(pattern, "REMOVED");
  return next === text ? null : { ...real, [entry.doc]: next };
}

/** Replace a sentence however it is wrapped: line wrapping is nobody's contract. */
const sub = (path, from, to) => {
  const pattern = new RegExp(escapeRegExp(from).replace(/ /g, "\\s+"), "gu");
  const text = real[path];
  const next = text.replace(pattern, () => to);
  if (next === text) throw new Error(`${path} does not contain ${JSON.stringify(from)}`);
  return { ...real, [path]: next };
};
const json = (path, edit) => {
  const value = JSON.parse(real[path]);
  edit(value);
  return { ...real, [path]: `${JSON.stringify(value, null, 2)}\n` };
};
const append = (path, text) => ({ ...real, [path]: `${real[path]}\n\n${text}\n` });

const realStore = verdict.failures.length === 0 ? JSON.parse(real[APP_STORE]) : {};

const MUTATIONS = [
  // -- the incident, replayed: the document moves and the pin does not
  { name: "INCIDENT: apps/README.md moves the iOS development version without this pin moving",
    world: () => sub(APPS, "**In development at 0.4.1 and not public**",
      "**In development at 0.4.2 and not public**"),
    expect: [`require|${APPS}|flat|**In development at 0.4.1 and not public**`] },
  { name: "INCIDENT: the root README moves the iOS development version without this pin moving",
    world: () => sub(README, "at version `0.4.1`", "at version `0.4.2`"),
    expect: [`require|${README}|flat|${ROOT_IOS_STATE}`, `require|${README}|deliveryFlat|${ROOT_IOS_STATE}`] },

  // -- the records
  { name: "the macOS manifest is not JSON", world: () => ({ ...real, [MAC_MANIFEST]: "{" }),
    expect: ["mac|decodes", `mac-tag|${README}`, `mac-status|${APPS}`] },
  { name: "the macOS manifest is missing", world: () => ({ ...real, [MAC_MANIFEST]: undefined }),
    expect: [`input|${MAC_MANIFEST}`, "mac|decodes"] },
  { name: "the macOS manifest names no macOS release", world: () => json(MAC_MANIFEST, (v) => { delete v.macos; }),
    expect: ["mac|present", `mac-tag|${APPS}`] },
  { name: "the macOS release is withdrawn", world: () => json(MAC_MANIFEST, (v) => { v.macos.available = false; }),
    expect: ["mac|available"] },
  { name: "`available` is the string \"true\"", world: () => json(MAC_MANIFEST, (v) => { v.macos.available = "true"; }),
    expect: ["mac|decodes"] },
  { name: "the macOS manifest carries no version", world: () => json(MAC_MANIFEST, (v) => { delete v.macos.version; }),
    expect: ["mac|version", `mac-tag|${README}`] },
  { name: "the macOS manifest carries an empty version", world: () => json(MAC_MANIFEST, (v) => { v.macos.version = ""; }),
    expect: ["mac|version-nonempty"] },
  { name: "the macOS manifest carries no build", world: () => json(MAC_MANIFEST, (v) => { delete v.macos.build; }),
    expect: ["mac|build"] },
  { name: "the build is zero", world: () => json(MAC_MANIFEST, (v) => { v.macos.build = 0; }),
    expect: ["mac|build-positive"] },
  { name: "the build is fractional, which bridges to a plausible integer", world: () => json(MAC_MANIFEST, (v) => { v.macos.build = 1.5; }),
    expect: ["mac|decodes"] },
  { name: "the build is `true`, which bridges to 1", world: () => json(MAC_MANIFEST, (v) => { v.macos.build = true; }),
    expect: ["mac|decodes"] },
  { name: "the download points at the mutable `latest` alias",
    world: () => json(MAC_MANIFEST, (v) => { v.macos.downloadUrl = "https://github.com/relayium/relayium/releases/latest/download/Relayium.dmg"; }),
    expect: ["mac|dmg"] },
  { name: "the manifest advances and the documents do not follow",
    world: () => json(MAC_MANIFEST, (v) => {
      v.macos.version = "99.0.0";
      v.macos.downloadUrl = "https://github.com/relayium/relayium/releases/download/macos-v99.0.0/Relayium.dmg";
    }),
    expect: [`mac-tag|${README}`, `mac-tag|${APPS}`, `mac-status|${APPS}`] },
  { name: "the App Store record is not JSON", world: () => ({ ...real, [APP_STORE]: "[" }),
    expect: ["store|decodes", `store-link|${README}`, `store-spans|${APPS}`] },
  { name: "the App Store record loses a field", world: () => json(APP_STORE, (v) => { delete v.publishedAt; }),
    expect: ["store|decodes"] },
  { name: "the App Store record declares schema 2", world: () => json(APP_STORE, (v) => { v.schema = 2; }),
    expect: ["store|schema"] },
  { name: "the App Store version is empty", world: () => json(APP_STORE, (v) => { v.version = ""; }),
    expect: ["store|version-nonempty", `store-span-version|${README}`] },
  { name: "the App Apple ID is empty", world: () => json(APP_STORE, (v) => { v.appleId = ""; }),
    expect: ["store|appleid-nonempty"] },
  { name: "the App Apple ID carries the `id` prefix", world: () => json(APP_STORE, (v) => { v.appleId = `id${v.appleId}`; }),
    expect: ["store|appleid-numeric"] },
  { name: "the publication date carries a time", world: () => json(APP_STORE, (v) => { v.publishedAt = `${v.publishedAt}T00:00:00Z`; }),
    expect: ["store|published-at"] },
  { name: "the product URL addresses another app", world: () => json(APP_STORE, (v) => { v.url = "https://apps.apple.com/app/id1"; }),
    expect: ["store|url"] },
  { name: "the App Store release advances and the documents do not follow",
    world: () => json(APP_STORE, (v) => { v.version = "99.9.9"; }),
    expect: [`store-span-version|${README}`, `store-span-version|${APPS}`] },

  // -- the link span
  { name: "the root README drops the Mac App Store link",
    world: () => sub(README, `](${realStore.url})`, "](https://example.invalid/)"),
    expect: [`store-link|${README}`, `store-spans|${README}`, `store-span-version|${README}`] },
  { name: "apps/README.md keeps the link but moves the version outside it",
    world: () => ({ ...real, [APPS]: real[APPS].split(`](${realStore.url})`)
      .map((part, index, all) => (index === all.length - 1 ? part
        : `${part.slice(0, part.lastIndexOf("["))}[the Mac App Store`)).join(`](${realStore.url})`) }),
    expect: [`store-span-version|${APPS}`] },

  // -- the delivery-status table
  { name: "iOS returns to the delivery-status table",
    world: () => sub(README, "\n| **Android** |", "\n| **iOS** | Internal TestFlight | In development. |\n| **Android** |"),
    expect: ["row-absent|iOS"] },
  { name: "the no-native-app row is deleted",
    world: () => sub(README, "| **iPhone, iPad, Windows, Linux** |", "| **Other platforms** |"),
    expect: ["row-present|iPhone, iPad, Windows, Linux", `require|${README}|row:iPhone, iPad, Windows, Linux|web app`,
      `ban|${README}|row:iPhone, iPad, Windows, Linux|android`] },
  { name: "the Android row is deleted",
    world: () => sub(README, "| **Android** |", "| **Robot** |"),
    expect: ["row-present|Android", `require|${README}|row:Android|apk`, `ban|${README}|row:Android|no device inbox`] },
  { name: "the Delivery status heading is renamed, so the section reads as empty",
    world: () => sub(README, "## Delivery status", "## Where things stand"),
    expect: [`require|${README}|deliveryFlat|${ROOT_IOS_STATE}`, `require|${README}|deliveryLower|no app store listing`] },

  // -- the predicted figure
  { name: "a projected number is published in the root README",
    world: () => append(README, "Relay egress is PROJECTED to fall by 40 percent."),
    expect: [`predicted|${README}`] },
  { name: "an estimate is published in the readiness manifest, 58 characters before its figure",
    world: () => append(READINESS, `estimated${" ".repeat(10)}${"x".repeat(48)}7`),
    expect: [`predicted|${READINESS}`] },
  { name: "a full-width digit is still a number",
    world: () => append(APPS, "we expect around ４０ peers"),
    expect: [`predicted|${APPS}`] },

  // -- legitimate edits, which must stay green
  { name: "\"hard to estimate\" with no figure near it is ordinary English",
    world: () => append(README, `${"x".repeat(80)} The cost is hard to have estimated in advance. ${"y".repeat(80)}`),
    refuse: /./ },
  { name: "a figure 61 characters past the prediction word is outside the window",
    world: () => append(README, `${"x".repeat(80)} estimated${"y".repeat(61)}7`),
    refuse: /./ },
  { name: "the iOS status sentence is re-wrapped across lines",
    world: () => sub(APPS, "**In development at 0.4.1 and not public**", "**In development\nat 0.4.1 and\n   not public**"),
    refuse: /./ },
  { name: "the affirmative Android sentence stays writable",
    world: () => append(README, "The Relayium app for Android is a public preview."),
    refuse: /./ },
  { name: "the App Store is mentioned without an iOS offer",
    world: () => append(APPS, "These clients can ship through the App Store; Apple sign-in waits for a Mac App Store track."),
    refuse: /./ },
];

let mutationsRun = 0;
let generated = 0;

function runMutation(name, world, expect, refuse) {
  let got;
  try {
    got = evaluate(world);
  } catch (error) {
    check(false, `the document-claims mutation "${name}" threw instead of reporting: ${error.message}`);
    return;
  }
  mutationsRun += 1;
  const rendered = got.failures.length === 0 ? "no failures at all"
    : `[\n    ${got.failures.map((failure) => failure.id).join("\n    ")}\n  ]`;
  for (const id of expect ?? []) {
    check(got.failures.some((failure) => failure.id === id),
      `this check did NOT complain about "${name}". Expected the claim ${JSON.stringify(id)} to fail; `
      + `got ${rendered}. A claim that cannot fail for the reason it was written reports green over `
      + "a document that says the opposite.");
  }
  if (refuse) {
    check(!got.failures.some((failure) => refuse.test(failure.id)),
      `this check complained about "${name}", which is a legitimate edit; got ${rendered}. A guard `
      + "that forbids the correction as well as the error gets disabled, and then guards nothing.");
  }
  check(got.claims === EXPECTED_CLAIMS,
    `the mutation "${name}" evaluated ${got.claims} claim(s), want ${EXPECTED_CLAIMS}: a broken input `
    + "made claims disappear instead of fail.");
}

if (failures.length === 0) {
  for (const entry of NEEDLE_CLAIMS) {
    if (entry.kind === "ban") {
      generated += 1;
      runMutation(`planted: ${entry.doc} gains ${JSON.stringify(disguise(entry))} (${entry.shape})`,
        planted(entry), [needleId(entry)]);
    } else {
      const world = removed(entry);
      generated += 1;
      if (world === null) {
        check(false, `cannot build the removal mutation for ${needleId(entry)}: the needle was not found `
          + "in the raw document by the removal pattern, so this requirement has no proof it can fail.");
        continue;
      }
      runMutation(`removed: ${entry.doc} loses ${JSON.stringify(entry.needle)} (${entry.shape})`,
        world, [needleId(entry)]);
    }
  }
  check(generated === NEEDLE_CLAIMS.length && generated > 0,
    `generated ${generated} mutation(s) for ${NEEDLE_CLAIMS.length} needle claim(s)`);
  for (const mutation of MUTATIONS) {
    let world;
    try {
      world = mutation.world();
    } catch (error) {
      check(false, `the mutation "${mutation.name}" could not be built: ${error.message}. The document `
        + "moved; re-point the mutation so the rule it proves keeps a proof.");
      continue;
    }
    if (!mutation.expect && !mutation.refuse) {
      check(false, `the mutation "${mutation.name}" asserts neither expect nor refuse`);
      continue;
    }
    runMutation(mutation.name, world, mutation.expect, mutation.refuse);
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
  process.stderr.write(`\n${failures.length} document-claims assertion(s) failed\n`);
  process.exit(1);
}

process.stdout.write(
  `document-claims-test: OK (${verdict.claims} claims over ${CLAIM_SURFACES.join(", ")} against `
  + `macOS ${JSON.parse(real[MAC_MANIFEST]).macos.version} direct and ${JSON.parse(real[APP_STORE]).version} `
  + `on the Mac App Store; ${mutationsRun} mutations — ${generated} generated, one per ban planted and one `
  + `per required sentence removed, plus ${MUTATIONS.length} hand-written — prove each of those can fail)\n`,
);
