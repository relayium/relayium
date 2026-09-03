#!/usr/bin/env node
// scripts/ios-app-store-metadata-validate.mjs — the iOS App Store metadata
// packet, checked against the limits Apple enforces and the claims this
// product is allowed to make.
//
// ── why this exists ──────────────────────────────────────────────────────────
//
// `docs/app-store-metadata-ios.json` is copy-and-paste material. Every string
// in it is destined for a form field in App Store Connect that nothing in this
// repository can see, and every failure mode is silent here and expensive
// there: a subtitle one character over the limit is a rejected save, a keyword
// list one BYTE over is a rejected save in Chinese and not in English, a
// description that promises background receiving is a false public statement
// about a foreground-only receiver, and a demo password pasted "temporarily"
// into a tracked file is a credential leak that survives in history.
//
// None of that is visible to a build, a Swift test or a linter. So it is
// checked here, before the archive that would carry it.
//
// ── what it refuses ──────────────────────────────────────────────────────────
//
//   * a raw file that is not exactly one well-formed JSON document: a BOM, a
//     tab, a CRLF, a duplicate object key, or a key named `__proto__`,
//     `constructor` or `prototype`;
//   * ANY key the schema below does not name, at any depth. Unknown input is a
//     finding, never something to ignore: a typo'd `promoText` that is silently
//     discarded reads exactly like a field that was filled in;
//   * a wrong type, a missing field, an empty or untrimmed string, a control
//     character, a duplicate array element;
//   * a locale set that is not exactly `en-US` and `zh-Hans`, in the storefront,
//     in TestFlight, in the subscription group and in every product;
//   * a length or byte limit Apple enforces — name and subtitle 30 characters,
//     promotional text 170, description and What's New 4000, keywords 100 UTF-8
//     BYTES with every keyword longer than two characters, in-app purchase
//     display name 2..30 characters and its description 45;
//   * a pinned fact that has drifted: the Apple ID, the bundle identifier, the
//     record name, the marketing version, the support/marketing/privacy URLs,
//     the excluded initial territories, the six product identifiers;
//   * a URL that is not a resolving `https://relayium.com/` page, and in
//     particular anything under `/apps/`, which 404s in English;
//   * a placeholder, a secret-shaped value, a contact detail or a price;
//   * a marketing claim this product does not ship — background receiving,
//     notifications, sync, backup, a download-count limit on a stored link —
//     and a reviewer note that has lost one of the disclosures a single-device
//     reviewer needs;
//   * a screenshot or accessibility state that claims more than has been done;
//   * a draft App Privacy graph that is not exactly the one the app ships. The
//     packet carries the answers somebody will type into App Store Connect, and
//     they are checked twice: against the graph pinned in this file, and
//     against `apps/ios/Relayium/PrivacyInfo.xcprivacy` itself — so a packet and
//     a validator edited to agree with each other, and not with the binary,
//     is a finding rather than a passing run. The manifest is PARSED, not
//     scanned: the linked flag, the tracking flag and the ordered purpose list
//     of every entry are compared, along with the label-level tracking answer
//     and its domains, and a manifest this validator cannot read exactly —
//     duplicate key, extra key, unknown element, repeated data type — is a
//     finding rather than an empty reading;
//   * an App Store Connect observation that has drifted from what was actually
//     read back. `appStoreConnectObservation` is a DATED, FIELD-SCOPED record of
//     one read-only pass, and every fact in it is pinned below: which record is
//     the iOS target, which record is the macOS one that must never be, and the
//     present/absent state of each field that was read. A packet that claims a
//     build, a subscription product, a completed privacy or accessibility
//     answer, a price, an availability selection, a screenshot, an archive, an
//     upload, a submission, a release, or a fully submission-ready record is
//     refused, and so is one that says the already-configured notification
//     endpoints are absent;
//   * the macOS record used as the iOS delivery target. `6801142976` /
//     `com.relayium.mac` is a real App Store Connect record that ALSO carries an
//     abandoned, empty iOS platform, which is exactly what makes it a plausible
//     wrong answer. It may appear only where this packet forbids it, never as
//     the record, the bundle, the share extension or a product identifier;
//   * the blanket "nothing has been read back" posture, reasserted anywhere in
//     the packet. It was true until the record was read; restoring it would
//     discard a dated observation and replace it with a false absence;
//
// ── what it is not ───────────────────────────────────────────────────────────
//
// It reads one file. It performs no network request, reads no credential,
// resolves no URL, and observes no App Store Connect state — so a pass says the
// packet is internally consistent and within Apple's limits, NOT that any of it
// has been entered, accepted, or is live.
//
// That last point is sharper now that the packet carries an observation. The
// `appStoreConnectObservation` section is a RECORDED read-back, not a live one:
// this validator checks that what was written down is internally consistent,
// that it names the right record, and that it claims nothing it also says is
// unmet — and it cannot tell whether the read-back happened at all. A passing
// run is not evidence that the record still looks like this. Re-inspect
// read-only before acting. `scripts/test/ios-app-store-metadata-validate-
// test.mjs` proves each rule by mutation.
//
// USAGE
//   node scripts/ios-app-store-metadata-validate.mjs
//                                   [--packet <path>] [--expect-version <x.y.z>]
//                                   [--quiet]
//
// EXIT  0 the packet satisfies every rule
//       1 at least one finding, all of them printed
//       2 usage error, or the packet could not be read

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PACKET = resolve(repoRoot, "docs/app-store-metadata-ios.json");

// ── the pinned facts ─────────────────────────────────────────────────────────
//
// Restated here rather than read out of the packet, so that editing the packet
// cannot also edit what the packet is checked against.
const LOCALES = ["en-US", "zh-Hans"];
const APPLE_ID = "6791918822";
const BUNDLE_ID = "com.relayium.app";
const SHARE_BUNDLE_ID = "com.relayium.app.share";
const TEAM_ID = "7PVYUG4YQS";
const RECORD_NAME = "relayium";
const MARKETING_VERSION = "0.3.0";
// The name the record actually holds. This is NOT a place to propose a rename:
// the App Store name is owner-controlled, changing it is an App Store Connect
// edit with its own review implications, and a packet that quietly enters a
// different capitalization would rename the app as a side effect of a metadata
// paste. Exact case, both locales.
const DISPLAY_NAME = "relayium";
const EXCLUDED_TERRITORIES = ["CN", "FR"];

// ── the two records, and the one that is never the iOS target ────────────────
//
// There are two App Store Connect app records, and the wrong one is not
// obviously wrong. `6801142976` is the shipped macOS record for
// `com.relayium.mac`, and it ALSO carries an abandoned, empty iOS `0.1.0`
// platform — so it appears in the Apps list showing an iOS platform, exactly
// like a record somebody looking for the iOS app would expect to find. It is
// not the iOS app: different bundle identifier, different build-number
// sequence, different subscription catalogue, different product.
//
// The iOS record is `6791918822` / `com.relayium.app`, and it is the only one
// this packet describes. Pinning both halves — the target AND the decoy — is
// the point: pinning only the target catches a typo, and it is not a typo that
// puts a build on the macOS record, it is a plausible-looking Apps row.
const MAC_APPLE_ID = "6801142976";
const MAC_BUNDLE_ID = "com.relayium.mac";

// The one read-only pass this packet records, and the fields it covered.
const OBSERVED_AT = "2026-09-03";
const OBSERVED_TIME_ZONE = "Asia/Dubai";
const OBSERVED_VERSION_STATE = "Prepare for Submission";
const NOTIFICATION_URL = "https://relayium.com/api/apple/notifications";

// What the record actually held on `OBSERVED_AT`, pinned here rather than read
// out of the packet — the same reason every other fact above is restated: a
// packet that can edit what it is checked against is checked against nothing.
//
// `present` is the whole point. Eleven of these were read as EMPTY, and an
// empty field is a fact with a date on it, not an absence of information. The
// direction that matters is upward: a packet edited to say a build exists, a
// product exists, privacy is answered, a price is set or a screenshot is
// uploaded is claiming a gate is met that was observed unmet, and that claim is
// how an unsubmittable record gets treated as a submittable one.
const OBSERVED_FIELDS = [
  { id: "version", present: true, blocksSubmission: false,
    why: "the record's editable version was read back as 0.3.0 Prepare for Submission" },
  { id: "testflight-builds", present: false, blocksSubmission: true,
    why: "TestFlight listed no builds" },
  { id: "subscription-groups", present: false, blocksSubmission: true,
    why: "the record carried no subscription group" },
  { id: "subscription-products", present: false, blocksSubmission: true,
    why: "the record carried no in-app purchase or subscription product" },
  { id: "app-privacy-data-practices", present: false, blocksSubmission: true,
    why: "App Privacy read Not Started" },
  { id: "app-privacy-policy-url", present: false, blocksSubmission: true,
    why: "no Privacy Policy URL was saved on the record" },
  { id: "app-privacy-choices-url", present: false, blocksSubmission: false,
    why: "no User Privacy Choices URL was saved, and Apple treats that field as optional" },
  { id: "accessibility", present: false, blocksSubmission: false,
    why: "the Accessibility Nutrition Label read Not Started, and it is voluntary" },
  { id: "price-schedule", present: false, blocksSubmission: true,
    why: "the record had no price schedule" },
  { id: "availability", present: false, blocksSubmission: true,
    why: "app availability was not set" },
  { id: "screenshots", present: false, blocksSubmission: true,
    why: "the record held zero screenshots" },
  { id: "app-store-server-notifications", present: true, blocksSubmission: false,
    why: "both the Production and Sandbox Server URLs were already saved to the Relayium endpoint" },
];
const OBSERVED_FIELD_IDS = OBSERVED_FIELDS.map((entry) => entry.id);

const URLS = {
  "en-US": {
    supportUrl: "https://relayium.com/support/",
    marketingUrl: "https://relayium.com/",
    privacyPolicyUrl: "https://relayium.com/privacy/",
  },
  "zh-Hans": {
    supportUrl: "https://relayium.com/zh/support/",
    // The site root, not `/zh/`: the lease pins one resolving marketing URL for
    // the record. The SUPPORT URL stays localized, because Apple renders it per
    // storefront and both pages exist.
    marketingUrl: "https://relayium.com/",
    privacyPolicyUrl: "https://relayium.com/privacy/",
  },
};

// Apple's current limits. Characters are counted as Unicode code points, which
// is what `Array.from` gives and what `String.length` does NOT: a description
// full of emoji or of astral-plane characters would be measured long by UTF-16
// code units. Keywords are the exception and are counted in UTF-8 BYTES,
// because that is the limit Apple actually applies — 100 bytes is 100 Latin
// keyword characters and roughly 33 Chinese ones, and a validator that counted
// characters would pass a Chinese list three times over the limit.
const LIMIT = {
  name: 30,
  subtitle: 30,
  promotionalText: 170,
  description: 4000,
  whatsNew: 4000,
  keywordBytes: 100,
  keywordMinChars: 3, // Apple refuses a keyword of two characters or fewer
  iapDisplayNameMin: 2,
  iapDisplayNameMax: 30,
  iapDescription: 45,
};

const PLANS = ["plus", "pro", "max"];
const CYCLES = ["monthly", "yearly"];
const PRODUCT_IDS = PLANS.flatMap((plan) => CYCLES.map((cycle) => `${BUNDLE_ID}.${plan}.${cycle}`));

// ── the App Privacy answers, pinned ──────────────────────────────────────────
//
// The App Store privacy label is the one part of this packet that is a PUBLIC
// PROMISE rather than a form field: a shopper reads it before installing, and
// unlike a subtitle over its limit, a wrong answer here saves cleanly and is
// discovered by somebody who trusted it.
//
// It is stated three times in this repository, deliberately and independently:
// `apps/ios/Relayium/PrivacyInfo.xcprivacy` is what the app SHIPS,
// `IOSPrivacyManifestTests` derives it from the source and server storage that
// justify each entry, and `scripts/ios-app-store-candidate.sh` checks the BUILT
// bundles. This is the fourth statement and it has a different job: it is what
// somebody will type into App Store Connect, so it is pinned here and then
// cross-checked against the shipped manifest below. Three agreeing statements
// and a packet that quietly disagrees with all of them is exactly the failure
// this constant exists to prevent.
//
// `NSPrivacyCollectedDataTypeDeviceID` is absent and the macOS record declares
// it. That asymmetry is checked as an explicit absence rather than left to the
// equality comparison, because it is the entry a parity-minded edit adds.
const APP_PRIVACY_TYPES = [
  { type: "NSPrivacyCollectedDataTypeName", linked: true, purpose: "AppFunctionality" },
  { type: "NSPrivacyCollectedDataTypeEmailAddress", linked: true, purpose: "AppFunctionality" },
  { type: "NSPrivacyCollectedDataTypePurchaseHistory", linked: true, purpose: "AppFunctionality" },
  { type: "NSPrivacyCollectedDataTypeUserID", linked: true, purpose: "AppFunctionality" },
  { type: "NSPrivacyCollectedDataTypeOtherUsageData", linked: true, purpose: "AppFunctionality" },
  { type: "NSPrivacyCollectedDataTypeProductInteraction", linked: false, purpose: "Analytics" },
].map(({ type, linked, purpose }) => ({
  type,
  linked,
  tracking: false,
  purposes: [`NSPrivacyCollectedDataTypePurpose${purpose}`],
}));

const APP_PRIVACY_ABSENT_TYPES = ["NSPrivacyCollectedDataTypeDeviceID"];
const APP_MANIFEST = "apps/ios/Relayium/PrivacyInfo.xcprivacy";
const SHARE_MANIFEST = "apps/ios/RelayiumShare/PrivacyInfo.xcprivacy";

const OWNER_ENTERED_FIELDS = [
  "contactFirstName",
  "contactLastName",
  "contactPhoneNumber",
  "contactEmail",
  "demoAccountName",
  "demoAccountPassword",
  "betaFeedbackEmail",
];

const SCREENSHOT_SETS = {
  "iphone-6.9": ["1320x2868", "1290x2796", "1260x2736"],
  "ipad-13": ["2064x2752", "2048x2732"],
};

const DEVICE_FAMILIES = ["iphone", "ipad"];
const A11Y_FEATURES = [
  "voice-over",
  "voice-control",
  "larger-text",
  "sufficient-contrast",
  "reduced-motion",
  "differentiate-without-color-alone",
  "dark-interface",
  "captions",
  "audio-descriptions",
];

// ── findings ─────────────────────────────────────────────────────────────────

const findings = [];
const fail = (path, message) => findings.push(`${path}: ${message}`);

// ── arguments ────────────────────────────────────────────────────────────────

let packetPath = DEFAULT_PACKET;
let expectVersion = null;
let quiet = false;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  const next = () => {
    i += 1;
    if (i >= argv.length) usage(`${arg} needs a value`);
    return argv[i];
  };
  if (arg === "--packet") packetPath = resolve(next());
  else if (arg === "--expect-version") expectVersion = next();
  else if (arg === "--quiet") quiet = true;
  else if (arg === "--help" || arg === "-h") usage(null);
  else usage(`unknown option ${arg}`);
}

function usage(problem) {
  if (problem) process.stderr.write(`${problem}\n\n`);
  process.stderr.write(
    "usage: node scripts/ios-app-store-metadata-validate.mjs " +
      "[--packet <path>] [--expect-version <x.y.z>] [--quiet]\n",
  );
  process.exit(2);
}

// ── the raw file, before it is a document ────────────────────────────────────
//
// Everything below this point works on parsed values, and parsing normalizes:
// `JSON.parse` keeps the LAST of two duplicate keys and tells nobody, and a BOM
// or a CRLF survives into whatever copies the file. So the bytes are judged
// first, and a raw-structure finding is fatal — there is no useful schema
// report to give about a document whose shape is already in doubt.

let raw;
try {
  raw = readFileSync(packetPath, "utf8");
} catch (error) {
  process.stderr.write(`cannot read the packet at ${packetPath}: ${error.message}\n`);
  process.exit(2);
}

if (raw.charCodeAt(0) === 0xfeff) fail("<file>", "starts with a UTF-8 BOM; write it as plain UTF-8");
if (raw.includes("\r")) fail("<file>", "contains a carriage return; the packet is LF-only");
if (raw.includes("\t")) fail("<file>", "contains a tab; the packet is indented with spaces");
if (!raw.endsWith("\n")) fail("<file>", "does not end with a newline");

// A tiny structural scan, run over the TEXT rather than the parsed value,
// because the two facts it is looking for do not survive parsing. Numbers and
// bare literals are skipped: only strings and punctuation carry the object
// shape this needs.
function rawStructureFindings(text) {
  const problems = [];
  const tokens = [];
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      let value = "";
      while (j < text.length) {
        const d = text[j];
        if (d === "\\") {
          value += d + (text[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (d === '"') break;
        value += d;
        j += 1;
      }
      tokens.push({ kind: "string", value });
      i = j + 1;
      continue;
    }
    if (c === "{" || c === "}" || c === "[" || c === "]" || c === ":" || c === ",") {
      tokens.push({ kind: c });
      i += 1;
      continue;
    }
    i += 1;
  }

  const stack = [];
  const trail = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const token = tokens[k];
    if (token.kind === "{") {
      stack.push({ object: true, keys: new Set() });
      continue;
    }
    if (token.kind === "[") {
      stack.push({ object: false });
      continue;
    }
    if (token.kind === "}" || token.kind === "]") {
      stack.pop();
      trail.pop();
      continue;
    }
    if (token.kind !== "string") continue;
    const top = stack[stack.length - 1];
    const isKey = top && top.object && tokens[k + 1] && tokens[k + 1].kind === ":";
    if (!isKey) continue;
    const where = trail.length ? `${trail.join(".")}.${token.value}` : token.value;
    if (top.keys.has(token.value)) {
      problems.push(`${where}: duplicate object key; JSON.parse would silently keep only the last one`);
    }
    top.keys.add(token.value);
    if (token.value === "__proto__" || token.value === "constructor" || token.value === "prototype") {
      problems.push(`${where}: key name '${token.value}' is refused outright`);
    }
    trail.push(token.value);
  }
  return problems;
}

for (const problem of rawStructureFindings(raw)) fail("<raw>", problem);

let packet;
try {
  packet = JSON.parse(raw);
} catch (error) {
  fail("<file>", `is not valid JSON: ${error.message}`);
  report();
}

if (findings.length > 0) report(); // a malformed raw document gets no schema report

// ── the schema ───────────────────────────────────────────────────────────────
//
// Declared as a tree of specs and walked strictly in both directions: a field
// the tree names and the packet lacks is a finding, and a field the packet
// carries and the tree does not name is ALSO a finding. The second half is the
// one that matters. A packet is copy-and-paste material for a form nothing here
// can see, so a key that no rule reads is a key nobody will notice is unread.

// `because` is appended to the finding an `equals` pin produces. A pinned value
// says WHAT it must be; some of these pins exist for a reason the operator has
// to know — that the other Apple ID is a real record with an iOS platform on
// it, that a count was observed to be zero on a particular day — and a bare
// `must be exactly 'X'` sends them to change X. The schema walk reports and
// exits before any cross-check runs, so a cross-check cannot carry this: it
// would be unreachable code explaining a finding nobody would ever see with it.
const str = (options = {}) => ({ kind: "string", ...options });
const bool = (options = {}) => ({ kind: "boolean", ...options });
const int = (options = {}) => ({ kind: "integer", ...options });
const arr = (item, options = {}) => ({ kind: "array", item, ...options });
const obj = (fields, options = {}) => ({ kind: "object", fields, ...options });
const localeMap = (value) => obj(Object.fromEntries(LOCALES.map((locale) => [locale, value])));

const storefrontSpec = obj({
  name: str({ maxChars: LIMIT.name, equals: DISPLAY_NAME }),
  subtitle: str({ maxChars: LIMIT.subtitle }),
  promotionalText: str({ maxChars: LIMIT.promotionalText }),
  description: str({ maxChars: LIMIT.description, multiline: true }),
  keywords: arr(str({ noComma: true }), { min: 1, unique: true }),
  whatsNew: str({ maxChars: LIMIT.whatsNew, multiline: true }),
  supportUrl: str({ url: true }),
  marketingUrl: str({ url: true }),
  privacyPolicyUrl: str({ url: true }),
});

const productSpec = obj({
  productId: str(),
  referenceName: str(),
  plan: str({ oneOf: PLANS }),
  cycle: str({ oneOf: CYCLES }),
  localizations: localeMap(
    obj({
      displayName: str({ minChars: LIMIT.iapDisplayNameMin, maxChars: LIMIT.iapDisplayNameMax }),
      description: str({ maxChars: LIMIT.iapDescription }),
    }),
  ),
});

const featureSpec = obj(
  {
    id: str({ oneOf: A11Y_FEATURES }),
    claimed: bool({ equals: false }),
    assessment: str({ equals: "not-assessed" }),
    blocker: str(),
  },
  { optional: ["blocker"] },
);

const SCHEMA = obj({
  schemaVersion: int({ equals: 1 }),
  packet: obj({
    id: str({ equals: "ios-app-store-metadata" }),
    state: str({ equals: `draft-in-this-repository-record-observed-${OBSERVED_AT}` }),
    // Was a boolean, and a boolean was the defect: one flag for a whole record
    // can only say "all of it" or "none of it", and the truth is neither. It
    // points at the section that says which fields were read and when.
    observedAppStoreConnectState: str({ equals: "field-scoped-see-appStoreConnectObservation" }),
    prose: str({ equals: "docs/ios-app-store-submission.md" }),
    validator: str({ equals: "scripts/ios-app-store-metadata-validate.mjs" }),
    note: str({ multiline: true }),
  }),
  record: obj({
    recordName: str({ equals: RECORD_NAME }),
    appleId: str({
      equals: APPLE_ID,
      exemptFromSecretScan: true,
      because:
        `${MAC_APPLE_ID} is the other record — the macOS one, which also carries an abandoned empty iOS ` +
        "platform and is therefore the plausible wrong answer. It is never an iOS delivery target",
    }),
    bundleId: str({
      equals: BUNDLE_ID,
      because: `'${MAC_BUNDLE_ID}' and anything under it belongs to the macOS record and is never the iOS target`,
    }),
    shareExtensionBundleId: str({
      equals: SHARE_BUNDLE_ID,
      because: `'${MAC_BUNDLE_ID}.share' belongs to the macOS record and is never the iOS extension`,
    }),
    teamId: str({ equals: TEAM_ID }),
    marketingVersion: str({ pattern: /^\d+\.\d+\.\d+$/ }),
    primaryCategoryUti: str({ equals: "public.app-category.utilities" }),
  }),
  // The dated read-back. Everything above it is what this project proposes;
  // this is the only section that states what App Store Connect holds, and it
  // states it per field, with the day it was read.
  appStoreConnectObservation: obj({
    state: str({ equals: "field-scoped-read-only-observation-recorded" }),
    observedAt: str({ equals: OBSERVED_AT, pattern: /^\d{4}-\d{2}-\d{2}$/ }),
    timeZone: str({ equals: OBSERVED_TIME_ZONE }),
    method: str({ multiline: true }),
    scope: str({ multiline: true }),
    // Deliberately NOT pinned to false here. The rule below derives it from the
    // gates this same section reports unmet, so the claim is refused by the
    // evidence rather than by a constant somebody could move.
    fullySubmissionReady: bool(),
    readinessNote: str({ multiline: true }),
    records: arr(
      obj({
        role: str(),
        appleId: str({ exemptFromSecretScan: true }),
        bundleId: str(),
        platforms: str(),
        observedVersion: str({ pattern: /^\d+\.\d+\.\d+$/ }),
        observedVersionState: str(),
        targetForIosRelease: bool(),
        note: str({ multiline: true }),
      }),
      { min: 2, max: 2 },
    ),
    observedFields: arr(
      obj({
        id: str({ oneOf: OBSERVED_FIELD_IDS }),
        field: str(),
        present: bool(),
        blocksSubmission: bool(),
        observed: str({ multiline: true }),
        nextAction: str({ multiline: true }),
      }),
      { min: OBSERVED_FIELDS.length, max: OBSERVED_FIELDS.length },
    ),
    // The one input that is already configured, so the failure mode here is the
    // opposite of everywhere else: not an unearned claim, a silent deletion.
    appStoreServerNotifications: obj({
      productionUrlConfigured: bool({ equals: true }),
      sandboxUrlConfigured: bool({ equals: true }),
      url: str({ equals: NOTIFICATION_URL }),
      signedTestNotificationObservedForThisRecord: bool({ equals: false }),
      note: str({ multiline: true }),
    }),
    deliveryState: obj({
      archived: bool({ equals: false }),
      uploaded: bool({ equals: false }),
      submittedForReview: bool({ equals: false }),
      released: bool({ equals: false }),
      note: str({ multiline: true }),
    }),
    notObserved: arr(str({ multiline: true }), { min: 1, unique: true }),
  }),
  locales: arr(str(), { unique: true, exact: LOCALES }),
  availability: obj({
    // The selection this repository intends, and — since 2026-09-03 — the fact
    // that the record carries none. Both halves, because either alone is a
    // different and misleading statement.
    state: str({ equals: "recorded-in-this-repository-record-shows-availability-not-set" }),
    initialExcludedTerritories: arr(
      obj({ code: str(), name: str(), reason: str({ multiline: true }) }),
      { min: 1 },
    ),
    anssiDeclaration: obj({
      state: str({ equals: "not-started" }),
      blocksInitialRelease: bool({ equals: false }),
      blocksAddingFrance: bool({ equals: true }),
      note: str({ multiline: true }),
    }),
    exportComplianceCodeInPlists: obj({
      state: str({ equals: "absent-by-design" }),
      guardedBy: str(),
    }),
  }),
  storefront: localeMap(storefrontSpec),
  appPrivacy: obj({
    // Same two-part honesty as `subscriptions.state`: what this repository
    // holds, and what the record holds. Until 2026-09-03 the second half could
    // only be "a read-back is owed", because nothing had looked. It has now
    // been looked at, and it is empty — which is a dated fact, not the blanket
    // absence of one.
    state: str({ equals: "drafted-in-this-repository-record-shows-data-practices-not-started" }),
    observedAppStoreConnectState: str({ equals: "field-scoped-see-appStoreConnectObservation" }),
    sourceOfTruth: str({ equals: APP_MANIFEST }),
    // The label-level tracking answer, which must agree with the manifest's
    // `NSPrivacyTracking`. Pinned to false with no domains, because a `true`
    // here would put Relayium inside App Tracking Transparency's scope.
    tracking: bool({ equals: false }),
    trackingDomains: arr(str(), { max: 0 }),
    note: str({ multiline: true }),
    collected: arr(
      obj({
        type: str({ pattern: /^NSPrivacyCollectedDataType[A-Za-z]+$/ }),
        linked: bool(),
        tracking: bool({ equals: false }),
        purposes: arr(str({ pattern: /^NSPrivacyCollectedDataTypePurpose[A-Za-z]+$/ }), {
          min: 1,
          unique: true,
        }),
        basis: str({ multiline: true }),
      }),
      { min: APP_PRIVACY_TYPES.length, max: APP_PRIVACY_TYPES.length },
    ),
    deliberatelyAbsent: arr(
      obj({
        type: str({ pattern: /^NSPrivacyCollectedDataType[A-Za-z]+$/ }),
        declaredOnMacOS: bool(),
        reason: str({ multiline: true }),
        revisitTrigger: str({ multiline: true }),
        guardedBy: str(),
      }),
      { min: 1 },
    ),
    shareExtension: obj({
      bundleId: str({ equals: SHARE_BUNDLE_ID }),
      // `max: 0` rather than a missing key: the extension declaring an EMPTY
      // list is a claim in its own right, and one this packet must carry.
      collected: arr(str(), { max: 0 }),
      reason: str({ multiline: true }),
      guardedBy: str(),
    }),
  }),
  appReview: obj({
    signInRequired: bool({ equals: true }),
    ownerEnteredFields: arr(
      obj({ field: str({ exemptFromSecretScan: true }), enteredIn: str({ equals: "App Store Connect only" }) }),
      { min: 1 },
    ),
    notes: str({ multiline: true }),
    attachment: obj({
      state: str({ oneOf: ["not-produced", "produced"] }),
      purpose: str({ multiline: true }),
      storefrontAsset: bool({ equals: false }),
    }),
  }),
  testFlight: obj({
    betaAppDescription: localeMap(str({ multiline: true, maxChars: LIMIT.description })),
    whatToTest: localeMap(str({ multiline: true, maxChars: LIMIT.description })),
  }),
  subscriptions: obj({
    // 'no row exists' used to be unsayable here, because nothing had read the
    // live record. It has now been read, on the date pinned above, and it holds
    // no group and no products — so the state says both what this repository
    // drafts and what the record was observed to hold.
    state: str({ equals: "drafted-in-this-repository-record-shows-no-group-or-products" }),
    productIdentifiersAreProposedDrafts: bool({
      equals: true,
      because:
        `the record was observed on ${OBSERVED_AT} with no subscription group and no products at all, and an ` +
        "identifier that exists nowhere is a proposal",
    }),
    ownerConfirmationRequired: str({ multiline: true }),
    submittedWithAppVersion: bool({ equals: true }),
    submittedWithAppVersionNote: str({ multiline: true }),
    group: obj({
      referenceName: str(),
      localizations: localeMap(obj({ displayName: str({ minChars: LIMIT.iapDisplayNameMin, maxChars: LIMIT.iapDisplayNameMax }) })),
    }),
    priceAndAvailability: obj({
      state: str({ equals: "owner-decision-outstanding" }),
      note: str({ multiline: true }),
    }),
    products: arr(productSpec, { min: 6, max: 6 }),
    reviewRequirements: arr(str({ multiline: true }), { min: 1, unique: true }),
  }),
  screenshots: obj({
    state: str({ equals: "not-captured" }),
    capturedCount: int({
      equals: 0,
      because: `none have been captured here, and the record was observed on ${OBSERVED_AT} holding no screenshots`,
    }),
    blockedBy: arr(str({ multiline: true }), { min: 1, unique: true }),
    rules: obj({
      minPerSetPerLocale: int({ equals: 1 }),
      maxPerSetPerLocale: int({ equals: 10 }),
      alphaChannelAllowed: bool({ equals: false }),
      perLocalizationSets: bool({ equals: true }),
    }),
    sets: arr(
      obj({
        id: str(),
        name: str(),
        acceptedPortraitPixelSizes: arr(str({ pattern: /^[1-9]\d{2,4}x[1-9]\d{2,4}$/ }), { min: 1, unique: true }),
      }),
      { min: 2, max: 2 },
    ),
    capture: obj({
      requiredConfiguration: str({ equals: "Release" }),
      signedIpaRequired: bool({ equals: false }),
      physicalDeviceRequired: bool({ equals: false }),
      releaseSimulatorCapturePermitted: bool({ equals: true }),
      debugBuildsForbidden: bool({ equals: true }),
      uiTestFixturesForbidden: bool({ equals: true }),
      fabricatedPricesForbidden: bool({ equals: true }),
      retouchingForbidden: bool({ equals: true }),
      methodIsOwnerChoice: bool({ equals: true }),
      note: str({ multiline: true }),
    }),
    shotList: arr(str({ multiline: true }), { min: 1, unique: true }),
  }),
  accessibilityNutritionLabel: obj({
    state: str({ equals: "unassessed" }),
    anyFeatureClaimed: bool({
      equals: false,
      because: `the Accessibility Nutrition Label was observed Not Started on the record on ${OBSERVED_AT}`,
    }),
    note: str({ multiline: true }),
    knownBlockers: arr(str({ multiline: true }), { min: 1, unique: true }),
    deviceFamilies: arr(obj({ id: str({ oneOf: DEVICE_FAMILIES }), features: arr(featureSpec, { min: 1 }) }), {
      min: 2,
      max: 2,
    }),
    checklistPerDeviceFamily: arr(str({ multiline: true }), { min: 1, unique: true }),
  }),
});

// Every string the document carries, collected during the walk so the content
// scans below run over the whole packet rather than over a hand-listed subset —
// a placeholder or a credential is a finding wherever it hides.
const allStrings = [];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walk(value, spec, path) {
  switch (spec.kind) {
    case "string":
      return walkString(value, spec, path);
    case "boolean":
      if (typeof value !== "boolean") return fail(path, `must be a boolean, not ${describe(value)}`);
      if (spec.equals !== undefined && value !== spec.equals) {
        fail(path, `must be ${spec.equals}${spec.because ? `; ${spec.because}` : ""}`);
      }
      return undefined;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return fail(path, `must be an integer, not ${describe(value)}`);
      }
      if (spec.equals !== undefined && value !== spec.equals) {
        fail(path, `must be ${spec.equals}${spec.because ? `; ${spec.because}` : ""}`);
      }
      return undefined;
    case "array":
      return walkArray(value, spec, path);
    case "object":
      return walkObject(value, spec, path);
    default:
      return fail(path, `internal: unknown spec kind ${spec.kind}`);
  }
}

function walkString(value, spec, path) {
  if (typeof value !== "string") return fail(path, `must be a string, not ${describe(value)}`);
  allStrings.push({ path, value, spec });
  if (value.length === 0) return fail(path, "must not be empty");
  if (value !== value.trim()) fail(path, "has leading or trailing whitespace");
  const control = spec.multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (control.test(value)) fail(path, "contains a control character");
  const chars = Array.from(value).length;
  if (spec.maxChars !== undefined && chars > spec.maxChars) {
    fail(path, `is ${chars} characters, over Apple's limit of ${spec.maxChars}`);
  }
  if (spec.minChars !== undefined && chars < spec.minChars) {
    fail(path, `is ${chars} characters, under Apple's minimum of ${spec.minChars}`);
  }
  if (spec.equals !== undefined && value !== spec.equals) {
    fail(path, `must be exactly '${spec.equals}'${spec.because ? `; ${spec.because}` : ""}`);
  }
  if (spec.oneOf && !spec.oneOf.includes(value)) fail(path, `must be one of ${spec.oneOf.join(", ")}`);
  if (spec.pattern && !spec.pattern.test(value)) fail(path, `does not match ${spec.pattern}`);
  if (spec.noComma && value.includes(",")) fail(path, "must not contain a comma");
  if (spec.url && !/^https:\/\/[^\s]+$/.test(value)) fail(path, "must be a single https URL");
  return undefined;
}

function walkArray(value, spec, path) {
  if (!Array.isArray(value)) return fail(path, `must be an array, not ${describe(value)}`);
  if (spec.min !== undefined && value.length < spec.min) {
    fail(path, `has ${value.length} elements, fewer than the required ${spec.min}`);
  }
  if (spec.max !== undefined && value.length > spec.max) {
    fail(path, `has ${value.length} elements, more than the permitted ${spec.max}`);
  }
  if (spec.exact) {
    const same = value.length === spec.exact.length && value.every((element, index) => element === spec.exact[index]);
    if (!same) fail(path, `must be exactly [${spec.exact.join(", ")}]`);
  }
  if (spec.unique) {
    const seen = new Set();
    value.forEach((element, index) => {
      const key = JSON.stringify(element);
      if (seen.has(key)) fail(`${path}[${index}]`, "is a duplicate of an earlier element");
      seen.add(key);
    });
  }
  value.forEach((element, index) => walk(element, spec.item, `${path}[${index}]`));
  return undefined;
}

function walkObject(value, spec, path) {
  if (!isPlainObject(value)) return fail(path, `must be an object, not ${describe(value)}`);
  const optional = new Set(spec.optional ?? []);
  for (const [key, fieldSpec] of Object.entries(spec.fields)) {
    const child = path ? `${path}.${key}` : key;
    if (!Object.hasOwn(value, key)) {
      if (!optional.has(key)) fail(child, "is missing");
      continue;
    }
    walk(value[key], fieldSpec, child);
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(spec.fields, key)) {
      fail(path ? `${path}.${key}` : key, "is not a field this packet defines; refused rather than ignored");
    }
  }
  return undefined;
}

function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

walk(packet, SCHEMA, "");

// A structural failure makes every cross-check below unsound: a missing
// `storefront` cannot be read for its keywords, and reporting fifty cascade
// findings would bury the one that matters.
if (findings.length > 0) report();

// ── content scans, over every string in the document ─────────────────────────

const PLACEHOLDERS = [
  [/<[^<>\n]{1,60}>/, "an angle-bracket placeholder"],
  [/\b(TODO|TBD|FIXME|XXX|PLACEHOLDER|REPLACE_ME|CHANGEME)\b/i, "a placeholder marker"],
  [/lorem ipsum/i, "filler text"],
  [/\bexample\.(com|org|net)\b/i, "an example domain"],
  [/\.invalid\b/i, "an .invalid domain"],
  [/\bREDACTED\b/i, "a redaction marker where a real value belongs"],
];

const SECRET_SHAPES = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "an email address"],
  [/(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/, "a telephone number"],
  [/\b(password|passwd|passphrase|secret|api[_-]?key|access[_-]?token|bearer)\b/i, "a credential word"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a JSON Web Token"],
  [/\b[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}\b/, "an app-specific password"],
];

// A price in this file is wrong twice over: the storefront renders the real
// StoreKit price per territory, and the iOS price point has not been decided.
const PRICE_SHAPES = [
  [/(?:US\s?\$|\$|€|£|¥|￥|₩|USD|CNY|RMB)\s?\d/, "a currency amount"],
  [/\b\d+\.\d{2}\b/, "a decimal price"],
];

for (const { path, value, spec } of allStrings) {
  for (const [pattern, what] of PLACEHOLDERS) {
    if (pattern.test(value)) fail(path, `contains ${what}; this packet is copy-ready or it is not shipped`);
  }
  for (const [pattern, what] of PRICE_SHAPES) {
    if (pattern.test(value)) fail(path, `contains ${what}; prices are rendered by StoreKit and are an owner decision`);
  }
  if (spec.exemptFromSecretScan) continue;
  for (const [pattern, what] of SECRET_SHAPES) {
    if (pattern.test(value)) {
      fail(path, `looks like ${what}; contact details and demo credentials are entered in App Store Connect only`);
    }
  }
}

// Every URL anywhere in the packet, not only the three URL fields: a support
// address pasted into the description is just as public and just as capable of
// 404ing. `/apps/` is the specific known one — the English page does not exist,
// only `/apps/macos/` does.
for (const { path, value } of allStrings) {
  for (const url of value.match(/https?:\/\/[^\s)>"']+/g) ?? []) {
    if (url.startsWith("http://")) fail(path, `${url} is plain HTTP`);
    else if (!url.startsWith("https://relayium.com/")) fail(path, `${url} is not a relayium.com page`);
    if (/^https?:\/\/relayium\.com\/(?:[a-z-]{2,7}\/)?apps(?:\/|$)/.test(url)) {
      fail(path, `${url} is the /apps/ path, which 404s in English; use https://relayium.com/`);
    }
  }
}

// ── the marketing copy may only promise what 0.3.0 ships ─────────────────────
//
// The receiver is foreground-only, registers for no notifications and delivers
// none, is off until switched on, and is not a backup or a sync service. The
// reviewer notes and the TestFlight text must SAY all of that, so they are
// checked separately below; the storefront copy must simply never use the
// vocabulary, in either language.
const FORBIDDEN_IN_MARKETING = [
  [/\bbackground\b/i, "'background'"],
  [/\bnotif/i, "a notification claim"],
  [/\bpush\b/i, "'push'"],
  [/\bback(ing)?[ -]?up\b|\bbackups?\b/i, "a backup claim"],
  [/\bsync(s|ed|ing|hroni[sz])?\b/i, "a sync claim"],
  [/\bautomatic(ally)?\b/i, "an automation claim"],
  [/后台/, "'后台' (background)"],
  [/通知/, "'通知' (notification)"],
  [/推送/, "'推送' (push)"],
  [/备份/, "'备份' (backup)"],
  [/同步/, "'同步' (sync)"],
  [/自动/, "'自动' (automatic)"],
];

const marketingPaths = [];
for (const locale of LOCALES) {
  for (const field of ["name", "subtitle", "promotionalText", "description", "whatsNew"]) {
    marketingPaths.push(`storefront.${locale}.${field}`);
  }
  marketingPaths.push(`subscriptions.group.localizations.${locale}.displayName`);
  packet.subscriptions.products.forEach((_, index) => {
    marketingPaths.push(`subscriptions.products[${index}].localizations.${locale}.displayName`);
    marketingPaths.push(`subscriptions.products[${index}].localizations.${locale}.description`);
  });
}
const marketingPathSet = new Set(marketingPaths);

for (const { path, value } of allStrings) {
  const isKeyword = /^storefront\.[^.]+\.keywords\[\d+\]$/.test(path);
  if (!marketingPathSet.has(path) && !isKeyword) continue;
  for (const [pattern, what] of FORBIDDEN_IN_MARKETING) {
    if (pattern.test(value)) {
      fail(path, `uses ${what}; 0.3.0 receives only in the foreground, delivers no notification, and is not a backup or sync service`);
    }
  }
}

// The opposite failure: reviewer-facing text that has QUIETLY acquired a claim.
// These are positive assertions, so a blanket vocabulary ban cannot be used —
// the honest sentences here are the negations of exactly these words.
const FORBIDDEN_CLAIMS = [
  [/receives?[^.]{0,20}in the background/i, "a background-receiving claim"],
  [/background receiv/i, "a background-receiving claim"],
  [/\bsends? (?:you )?(?:a )?notifications?\b/i, "a notification claim"],
  [/push notification/i, "a push-notification claim"],
  [/automatic(?:ally)? (?:sync|back)/i, "an automatic sync or backup claim"],
  [/\b(?:is|as) a backup\b/i, "a backup claim"],
  [/后台接收/, "a background-receiving claim"],
  [/自动同步/, "an automatic-sync claim"],
  [/发送通知/, "a notification claim"],
];

const reviewerPaths = [
  "appReview.notes",
  ...LOCALES.map((locale) => `testFlight.betaAppDescription.${locale}`),
  ...LOCALES.map((locale) => `testFlight.whatToTest.${locale}`),
];
const reviewerPathSet = new Set(reviewerPaths);

for (const { path, value } of allStrings) {
  if (!reviewerPathSet.has(path)) continue;
  for (const [pattern, what] of FORBIDDEN_CLAIMS) {
    if (pattern.test(value)) fail(path, `makes ${what}, which this build does not do`);
  }
}

// Cross-network Transfer is DIRECTION-SPECIFIC, and the blanket sentence is the
// easy mistake: `PairingCodeModel.mint` takes a bearer token and the server will
// not mint anonymously, because the account that mints a code owns whatever is
// relayed through it. JOINING a code somebody else is showing takes no token at
// all. So "LAN Transfer and Cross-network Transfer need no account" is false in
// one direction and true in the other, and a storefront that says it will be
// read as a promise by someone who then cannot show a code signed out.
const FORBIDDEN_ACCOUNT_CLAIMS = [
  [/LAN Transfer and Cross-network Transfer (?:do not|does not|need no|needs no|require no|requires no|work|works)/i, "a blanket claim that Cross-network Transfer needs no account"],
  [/Cross-network Transfer[^.]{0,40}?(?:needs? no account|requires? no account|without an account|no account (?:is )?(?:needed|required))/i, "an unqualified claim that Cross-network Transfer needs no account"],
  [/Cross-network Transfer (?:works?|runs?|is available) signed out/i, "an unqualified claim that Cross-network Transfer works signed out"],
  [/局域网传输和跨网络传输(?:都)?不需要/, "a blanket claim that Cross-network Transfer needs no account"],
  [/跨网络传输不需要(?:账户|登录)/, "a blanket claim that Cross-network Transfer needs no account"],
];

const accountClaimPaths = new Set([
  ...marketingPaths,
  ...reviewerPathsForClaims(),
]);

function reviewerPathsForClaims() {
  return [
    "appReview.notes",
    ...LOCALES.map((locale) => `testFlight.betaAppDescription.${locale}`),
    ...LOCALES.map((locale) => `testFlight.whatToTest.${locale}`),
  ];
}

for (const { path, value } of allStrings) {
  if (!accountClaimPaths.has(path)) continue;
  for (const [pattern, what] of FORBIDDEN_ACCOUNT_CLAIMS) {
    if (pattern.test(value)) {
      fail(
        path,
        `makes ${what}; showing a cross-network code requires a signed-in account and joining one does not, so the two directions must be stated separately`,
      );
    }
  }
}

// The accurate statement has to be PRESENT, not merely un-contradicted: deleting
// the sentence would satisfy every ban above.
const REQUIRED_ACCOUNT_DISTINCTION = [
  ["storefront.en-US.description", ["Showing a code needs a Relayium account", "joining a code somebody else is showing does not"]],
  ["storefront.zh-Hans.description", ["出示配对码需要 Relayium 账户", "加入别人出示的码则不需要"]],
  ["appReview.notes", ["joining a six-digit code somebody else is showing works signed out", "showing a code requires a signed-in account"]],
  ["testFlight.betaAppDescription.en-US", ["showing a cross-network pairing code need a", "joining a cross-network code somebody else is showing"]],
  ["testFlight.betaAppDescription.zh-Hans", ["出示跨网络配对码", "加入别人出示的跨网络配对码也不需要"]],
  ["testFlight.whatToTest.en-US", ["joining a code somebody else is showing works, and showing a code does not"]],
  ["testFlight.whatToTest.zh-Hans", ["未登录时可以加入别人出示的码，但不能出示码"]],
];

// A stored link's controls are an EXPIRY and an optional delete-after-first-
// download, and that is all `SendView` offers: a `Picker` bound to `upload.ttl`
// and a `Toggle` bound to `upload.burnAfterRead`. No iOS surface offers a
// download-count cap, and no client model carries one.
//
// A download-count cap does exist elsewhere in the product — the CLI's
// `--max-downloads`, resolved server-side — which is exactly why the claim read
// as plausible and survived review. It is still false about the app this
// listing describes, and the listing is what a shopper reads.
//
// The storefront copy said users set "your own expiry and download limits" (and
// "有效期和下载次数由你自己定" in Chinese) — a control this build does not ship,
// promised to somebody choosing whether to install. It is the same class of
// defect as the background-receiving claim above and is banned the same way: a
// shopper who buys a plan expecting to cap downloads at five has been told
// something untrue by the listing.
//
// "Burn after read" is deliberately NOT how the ban is phrased. The honest
// replacement uses the app's own words — "Delete after first download" /
// "首次下载后即删除" — so the vocabulary a reader meets in the listing is the
// vocabulary they meet in the app.
const FORBIDDEN_STORED_LINK_CLAIMS = [
  [/download limits?/i, "a download-limit claim"],
  [/limit[^.]{0,30}\bdownloads?\b/i, "a download-limit claim"],
  [/\bdownloads?\b[^.]{0,20}\blimits?\b/i, "a download-limit claim"],
  [/number of downloads/i, "a download-count claim"],
  [/下载次数/, "'下载次数' (download count)"],
  [/下载(?:数量|上限)/, "a download-count or download-cap claim"],
];

for (const { path, value } of allStrings) {
  if (!marketingPathSet.has(path)) continue;
  for (const [pattern, what] of FORBIDDEN_STORED_LINK_CLAIMS) {
    if (pattern.test(value)) {
      fail(
        path,
        `makes ${what}; a stored link's shipped controls are an expiry and an optional delete-after-first-download, and there is no download-count field in the app`,
      );
    }
  }
}

// The accurate statement has to be PRESENT, not merely un-contradicted:
// deleting the sentence would satisfy every ban above and leave the listing
// silent about the one control a sender actually has.
const REQUIRED_STORED_LINK_CONTROLS = [
  ["storefront.en-US.description", ["when the link expires", "delete itself after the first download"]],
  ["storefront.zh-Hans.description", ["有效期由你自己定", "首次下载后即删除"]],
];

// The review attachment: the packet says whether it exists, and the reviewer
// notes say something about it. A packet whose state and whose prose disagree is
// worse than either alone, because whichever one an operator reads is the one
// they will act on. Checked in BOTH directions so neither value can be edited
// alone.
{
  const attachmentState = packet.appReview.attachment.state;
  const notes = packet.appReview.notes;
  const claimsItExists = /attachment[\s\S]{0,120}?\b(?:is|has been) (?:provided|attached|included|supplied)\b/i.test(notes);
  const claimsItIsOwed = notes.includes("must be supplied");
  if (attachmentState === "not-produced") {
    if (claimsItExists) {
      fail(
        "appReview.notes",
        "says the review attachment is provided while appReview.attachment.state is 'not-produced'",
      );
    }
    if (!claimsItIsOwed) {
      fail(
        "appReview.notes",
        "must state that the review attachment 'must be supplied' while its state is 'not-produced'",
      );
    }
  } else {
    if (!claimsItExists) {
      fail("appReview.notes", "does not say the review attachment is attached, but its state is 'produced'");
    }
    if (claimsItIsOwed) {
      fail("appReview.notes", "still says the review attachment must be supplied, but its state is 'produced'");
    }
  }
}

// And the disclosures a single-device reviewer needs in order not to file the
// product's design as a defect. Each is a substring rather than a paraphrase,
// because a rule that accepts a paraphrase accepts its absence.
const REQUIRED_SUBSTRINGS = [
  ["appReview.notes", ["two devices", "same Relayium account", "foreground", "no notification", "off by default", "Received", "Sandbox", "demo account", "end-to-end encrypted", "ciphertext"]],
  ["testFlight.betaAppDescription.en-US", ["foreground", "no notification"]],
  ["testFlight.betaAppDescription.zh-Hans", ["前台", "通知"]],
  ["testFlight.whatToTest.en-US", ["two devices", "Files"]],
  ["testFlight.whatToTest.zh-Hans", ["两台设备", "文件"]],
];

const stringAt = new Map(allStrings.map(({ path, value }) => [path, value]));
for (const [path, required] of [
  ...REQUIRED_SUBSTRINGS,
  ...REQUIRED_ACCOUNT_DISTINCTION,
  ...REQUIRED_STORED_LINK_CONTROLS,
]) {
  const value = stringAt.get(path);
  if (value === undefined) continue;
  for (const needle of required) {
    if (!value.includes(needle)) fail(path, `must state '${needle}' and does not`);
  }
}

// ── cross-checks the schema cannot express ───────────────────────────────────

if (expectVersion !== null && packet.record.marketingVersion !== expectVersion) {
  fail(
    "record.marketingVersion",
    `is '${packet.record.marketingVersion}' but this run was told the candidate is '${expectVersion}'`,
  );
}
if (packet.record.marketingVersion !== MARKETING_VERSION) {
  fail(
    "record.marketingVersion",
    `is '${packet.record.marketingVersion}', not the '${MARKETING_VERSION}' this packet was written for; re-draft What's New before changing it`,
  );
}

for (const scope of ["storefront", "testFlight.betaAppDescription", "testFlight.whatToTest", "subscriptions.group.localizations"]) {
  const value = scope.split(".").reduce((node, key) => node?.[key], packet);
  const keys = Object.keys(value ?? {});
  if (keys.length !== LOCALES.length || !LOCALES.every((locale) => keys.includes(locale))) {
    fail(scope, `must carry exactly ${LOCALES.join(" and ")}, not ${keys.join(", ") || "nothing"}`);
  }
}

for (const locale of LOCALES) {
  const entry = packet.storefront?.[locale];
  if (!entry) continue;

  for (const [field, expected] of Object.entries(URLS[locale])) {
    if (entry[field] !== expected) fail(`storefront.${locale}.${field}`, `must be '${expected}'`);
  }

  const joined = entry.keywords.join(",");
  const bytes = Buffer.byteLength(joined, "utf8");
  if (bytes > LIMIT.keywordBytes) {
    fail(
      `storefront.${locale}.keywords`,
      `is ${bytes} UTF-8 bytes as the comma-separated string Apple stores, over the limit of ${LIMIT.keywordBytes}`,
    );
  }
  entry.keywords.forEach((keyword, index) => {
    const chars = Array.from(keyword).length;
    if (chars < LIMIT.keywordMinChars) {
      fail(`storefront.${locale}.keywords[${index}]`, `is ${chars} characters; Apple refuses a keyword of two or fewer`);
    }
  });
}

const territoryCodes = packet.availability.initialExcludedTerritories.map((entry) => entry.code);
const sortedTerritories = [...territoryCodes].sort();
if (
  sortedTerritories.length !== EXCLUDED_TERRITORIES.length ||
  !EXCLUDED_TERRITORIES.every((code, index) => sortedTerritories[index] === code)
) {
  fail(
    "availability.initialExcludedTerritories",
    `must be exactly ${EXCLUDED_TERRITORIES.join(" and ")}, not ${sortedTerritories.join(", ") || "nothing"}`,
  );
}

const seenProductIds = new Set();
packet.subscriptions.products.forEach((product, index) => {
  const path = `subscriptions.products[${index}]`;
  const expected = `${BUNDLE_ID}.${product.plan}.${product.cycle}`;
  if (product.productId !== expected) {
    fail(`${path}.productId`, `must be '${expected}' for the ${product.plan} ${product.cycle} row`);
  }
  if (product.productId.startsWith("com.relayium.mac.")) {
    fail(`${path}.productId`, "reuses a macOS identifier; the two records must not share a product");
  }
  if (seenProductIds.has(product.productId)) fail(`${path}.productId`, "is a duplicate");
  seenProductIds.add(product.productId);
});
for (const id of PRODUCT_IDS) {
  if (!seenProductIds.has(id)) fail("subscriptions.products", `is missing the row for '${id}'`);
}

const enteredFields = packet.appReview.ownerEnteredFields.map((entry) => entry.field);
for (const field of OWNER_ENTERED_FIELDS) {
  if (!enteredFields.includes(field)) fail("appReview.ownerEnteredFields", `does not name '${field}'`);
}
for (const field of enteredFields) {
  if (!OWNER_ENTERED_FIELDS.includes(field)) {
    fail("appReview.ownerEnteredFields", `names '${field}', which is not an owner-entered App Store Connect field`);
  }
}

const setIds = packet.screenshots.sets.map((set) => set.id);
for (const [id, sizes] of Object.entries(SCREENSHOT_SETS)) {
  const set = packet.screenshots.sets.find((candidate) => candidate.id === id);
  if (!set) {
    fail("screenshots.sets", `is missing the '${id}' set`);
    continue;
  }
  const actual = set.acceptedPortraitPixelSizes;
  const same = actual.length === sizes.length && sizes.every((size, index) => actual[index] === size);
  if (!same) {
    fail(
      `screenshots.sets[${setIds.indexOf(id)}].acceptedPortraitPixelSizes`,
      `must be exactly [${sizes.join(", ")}]`,
    );
  }
}
for (const id of setIds) {
  if (!Object.hasOwn(SCREENSHOT_SETS, id)) fail("screenshots.sets", `declares an unknown set '${id}'`);
}
if (packet.screenshots.state === "not-captured" && packet.screenshots.capturedCount !== 0) {
  fail("screenshots.capturedCount", "must be 0 while the state is not-captured");
}

const familyIds = packet.accessibilityNutritionLabel.deviceFamilies.map((family) => family.id);
for (const id of DEVICE_FAMILIES) {
  if (!familyIds.includes(id)) fail("accessibilityNutritionLabel.deviceFamilies", `is missing the '${id}' family`);
}
packet.accessibilityNutritionLabel.deviceFamilies.forEach((family, index) => {
  const path = `accessibilityNutritionLabel.deviceFamilies[${index}]`;
  const ids = family.features.map((feature) => feature.id);
  for (const feature of A11Y_FEATURES) {
    if (!ids.includes(feature)) fail(`${path}.features`, `is missing '${feature}'`);
  }
  const seen = new Set();
  ids.forEach((id, position) => {
    if (seen.has(id)) fail(`${path}.features[${position}]`, `repeats '${id}'`);
    seen.add(id);
  });
  const contrast = family.features.find((feature) => feature.id === "sufficient-contrast");
  if (contrast && typeof contrast.blocker !== "string") {
    fail(
      `${path}.features`,
      "sufficient-contrast must carry its known blocker; the measured shortfalls are resolved, but the per-device-family assessment has not been performed",
    );
  }
});
if (packet.accessibilityNutritionLabel.deviceFamilies.some((family) => family.features.some((f) => f.claimed))) {
  fail("accessibilityNutritionLabel", "claims a feature while the label state is unassessed");
}

// ── the App Store Connect observation ────────────────────────────────────────
//
// One read-only pass, written down. Nothing here can re-run it, so what is
// checked is everything that CAN be checked without looking: that the right
// record is named and the wrong one is refused, that the per-field readings
// match what was actually read, that no gate reported unmet is also reported
// met, and that the drafts elsewhere in this packet still agree with it.
//
// The asymmetry is deliberate. A packet that understates the record costs a
// wasted re-inspection. A packet that overstates it — a build that is not
// there, a product that was never created, an answered privacy questionnaire —
// sends somebody to archive, upload or submit against a record that will refuse
// them, or worse, does not refuse them.

const observation = packet.appStoreConnectObservation;

// `record.appleId`, `record.bundleId` and `record.shareExtensionBundleId` are
// pinned by the schema above and carry the macOS record in their `because`, so
// a swap is refused there with its reason attached. What is left for here is
// everywhere else. The two places the macOS identifiers legitimately
// appear are this observation, which exists to forbid them, and the subscription
// review requirements, which warn against reusing a macOS product identifier.
// Anywhere else, a macOS identifier in an iOS packet is either a paste or a
// drift, and neither is something to read past.
const macIdentifierIsAllowedAt = (path) =>
  path.startsWith("appStoreConnectObservation.") || /^subscriptions\.reviewRequirements\[\d+\]$/.test(path);

for (const { path, value } of allStrings) {
  if (macIdentifierIsAllowedAt(path)) continue;
  if (value.includes(MAC_APPLE_ID)) {
    fail(path, `names Apple ID ${MAC_APPLE_ID}, the macOS record; this packet describes the iOS record ${APPLE_ID} only`);
  }
  if (value.includes(MAC_BUNDLE_ID)) {
    fail(path, `names '${MAC_BUNDLE_ID}', the macOS bundle; this packet describes '${BUNDLE_ID}' only`);
  }
}

// Exactly one of the two records is the iOS target, and it is the iOS one.
const targets = observation.records.filter((entry) => entry.targetForIosRelease);
if (targets.length !== 1) {
  fail(
    "appStoreConnectObservation.records",
    `names ${targets.length} iOS targets; exactly one record may be the iOS delivery target`,
  );
}
const iosRecord = targets[0];
if (iosRecord) {
  if (iosRecord.appleId !== APPLE_ID || iosRecord.bundleId !== BUNDLE_ID) {
    fail(
      "appStoreConnectObservation.records",
      `names ${iosRecord.appleId} / '${iosRecord.bundleId}' as the iOS target; it is ${APPLE_ID} / '${BUNDLE_ID}'`,
    );
  }
  if (iosRecord.observedVersion !== packet.record.marketingVersion) {
    fail(
      "appStoreConnectObservation.records",
      `read the target's version back as '${iosRecord.observedVersion}', but this packet is drafted for ` +
        `'${packet.record.marketingVersion}'; one of the two is describing a different version than the other`,
    );
  }
  if (iosRecord.observedVersionState !== OBSERVED_VERSION_STATE) {
    fail(
      "appStoreConnectObservation.records",
      `reports the target's version state as '${iosRecord.observedVersionState}'; it was read back as ` +
        `'${OBSERVED_VERSION_STATE}', which is the state of a version that has never been submitted`,
    );
  }
}

const macRecord = observation.records.find((entry) => entry.appleId === MAC_APPLE_ID);
if (!macRecord) {
  fail(
    "appStoreConnectObservation.records",
    `does not record the macOS record ${MAC_APPLE_ID}. It exists, it shows an abandoned empty iOS platform, and an ` +
      "operator who has not been told that will find it and treat it as the iOS record",
  );
} else {
  if (macRecord.targetForIosRelease) {
    fail(
      "appStoreConnectObservation.records",
      `marks the macOS record ${MAC_APPLE_ID} as the iOS delivery target. Its iOS platform is an abandoned empty ` +
        `0.1.0 on a different bundle identifier; the iOS record is ${APPLE_ID}`,
    );
  }
  if (macRecord.bundleId !== MAC_BUNDLE_ID) {
    fail(
      "appStoreConnectObservation.records",
      `records ${MAC_APPLE_ID} with bundle '${macRecord.bundleId}'; it is '${MAC_BUNDLE_ID}'`,
    );
  }
}

// Each field, against what was read. Order is compared as well as membership:
// the list is a transcript of one pass, and a reordered transcript is a
// different document.
OBSERVED_FIELDS.forEach((expected, index) => {
  const actual = observation.observedFields[index];
  const path = `appStoreConnectObservation.observedFields[${index}]`;
  if (!actual) {
    fail("appStoreConnectObservation.observedFields", `is missing the '${expected.id}' reading`);
    return;
  }
  if (actual.id !== expected.id) {
    fail(`${path}.id`, `must be '${expected.id}'; the order is the order the fields were read in`);
    return;
  }
  if (actual.present !== expected.present) {
    fail(
      `${path}.present`,
      `claims '${expected.id}' is ${actual.present ? "present" : "absent"} on the record, but on ${OBSERVED_AT} ` +
        `${expected.why}. Change this only from a fresh read-only inspection, and change the date with it`,
    );
  }
  if (actual.blocksSubmission !== expected.blocksSubmission) {
    fail(
      `${path}.blocksSubmission`,
      `must be ${expected.blocksSubmission} for '${expected.id}'; whether a missing field blocks submission is ` +
        "Apple's rule, not this packet's preference",
    );
  }
});

const openGates = observation.observedFields.filter((entry) => entry.blocksSubmission && !entry.present);

// The claim this whole section exists to make unsayable.
if (observation.fullySubmissionReady) {
  fail(
    "appStoreConnectObservation.fullySubmissionReady",
    openGates.length > 0
      ? `claims the record is fully submission-ready while this same section reports ${openGates.length} unmet gate(s): ` +
          `${openGates.map((entry) => entry.id).join(", ")}`
      : "claims the record is fully submission-ready. Submission readiness is decided in App Store Connect against a " +
          "build this packet does not have; it is never a value this repository may assert",
  );
}

// The drafts elsewhere in this packet are held against these same readings by
// their own schema pins — `screenshots.capturedCount`, the proposed-draft flag
// on the subscription identifiers, and the accessibility claim flag each carry
// the observation in their `because`. They are not re-checked here: a
// cross-check behind a pin is unreachable code.

// An empty TestFlight list is the reading most likely to be over-read. It does
// not say no build number was ever consumed — expired, removed and Invalid
// builds keep theirs — and the candidate script's `--readback-highest-build`
// still rests on an operator attestation. Losing that caveat turns a limit of
// the observation into an apparent finding of it.
if (!observation.notObserved.some((entry) => entry.includes("build number"))) {
  fail(
    "appStoreConnectObservation.notObserved",
    "no longer records that the highest consumed build number is unobserved. An empty TestFlight list does not " +
      "answer it, and scripts/ios-app-store-candidate.sh's --readback-highest-build is still an attestation",
  );
}

// The screenshot reading is the second one most likely to be over-read, and it
// over-reads in a direction the `present: false` pin cannot see. What was read
// is the version record's OWN screenshot count — zero, on the page inspected.
// Each device set and each localization was not opened and read back one at a
// time. "Zero on this record" and "zero in every set and every locale" are
// different statements: the first is a field reading, the second is a survey
// nobody ran. Both block the gate, so nothing is gained by the wider one and a
// dated observation is what is lost. Keep the caveat that says which one this
// is.
if (!observation.notObserved.some(
  (entry) => /screenshot/i.test(entry) && /localization/i.test(entry),
)) {
  fail(
    "appStoreConnectObservation.notObserved",
    "no longer records that screenshot state was not read back set by set and localization by localization. The " +
      "reading is the record's own screenshot count; without this caveat a field-scoped zero reads as a per-set " +
      "and per-locale survey that was never run",
  );
}

// The posture this section replaced, refused if it comes back. Until the record
// was read, "nothing here has been read back" was the honest thing to say and
// it is written all over this packet's history. Restoring it now would delete a
// dated observation and put a false absence in its place — and a false absence
// reads exactly like a fact nobody has established.
const FORBIDDEN_BLANKET_ABSENCE = [
  [/nothing[^.]{0,40}has been read back/i, "the blanket 'nothing has been read back' posture"],
  [/has read back no\b/i, "the blanket 'this file has read back nothing' posture"],
  [/nothing here has looked/i, "the blanket 'nothing here has looked' posture"],
  [/no(?:thing| field| value| part)[^.]{0,40}of the record has been (?:read|observed|inspected)/i,
   "a blanket claim that the record has not been inspected"],
];

// The same over-read, arriving as prose instead of as a dropped caveat.
//
// This is scoped narrowly on purpose. "One to ten screenshots per set, per
// localization" is Apple's UPLOAD RULE and is stated all over this packet and
// its prose; "zero screenshots in every set and every locale" is a CLAIM ABOUT
// LIVE STATE that no read-back supports. The discriminator is the emptiness
// word: a rule states a limit, this over-read states an absence. So a sentence
// is refused only when it carries all three of a screenshot, an emptiness and a
// universal quantifier over sets or locales — which no rule statement does.
const SCREENSHOT_SURVEY_TOKENS = [
  /\bscreenshots?\b/i,
  /\b(?:zero|none|no|empty|nothing|not a single)\b/i,
  /\b(?:every|all|each|any)\s+(?:set|sets|locale|locales|localization|localizations)\b/i,
];

// And the exact conjunction the corrected reading was written with, refused on
// its own. Nothing in this packet needs to quantify over both axes at once, so
// its return is a reversion rather than a rephrasing.
const EVERY_SET_AND_EVERY_LOCALE =
  /\b(?:every|all|each)\s+(?:set|sets)\s+and\s+(?:every|all|each)\s+(?:locale|locales|localization|localizations)\b/i;

const claimsAScreenshotSurvey = (value) =>
  EVERY_SET_AND_EVERY_LOCALE.test(value) ||
  value
    .split(/[.;\n]/)
    .some((sentence) => SCREENSHOT_SURVEY_TOKENS.every((token) => token.test(sentence)));

// And the opposite overclaim, in prose rather than in a flag.
const FORBIDDEN_READINESS_CLAIMS = [
  [/\bfully (?:submission[- ]?)?ready\b/i, "a fully-ready claim"],
  [/\bsubmission[- ]ready\b/i, "a submission-ready claim"],
  [/\bready to submit\b/i, "a ready-to-submit claim"],
  [/\bready (?:for|to) release\b/i, "a ready-to-release claim"],
  [/\ball (?:the )?gates?[^.]{0,24}\b(?:met|passed|green|clear)\b/i, "an all-gates-met claim"],
  [/\bnothing\b[^.]{0,24}\bblock(?:s|ing)\b/i, "a nothing-is-blocking claim"],
];

for (const { path, value } of allStrings) {
  for (const [pattern, what] of FORBIDDEN_BLANKET_ABSENCE) {
    if (pattern.test(value)) {
      fail(
        path,
        `restates ${what}. The record was read field by field on ${OBSERVED_AT}; ` +
          "appStoreConnectObservation is where what it held is written, and a blanket absence would discard it",
      );
    }
  }
  for (const [pattern, what] of FORBIDDEN_READINESS_CLAIMS) {
    if (pattern.test(value)) {
      fail(
        path,
        `makes ${what}. There is no build, no product, no privacy answer, no price, no availability and no ` +
          "screenshot on this record; submission readiness is not something this packet may assert",
      );
    }
  }
  if (claimsAScreenshotSurvey(value)) {
    fail(
      path,
      "claims a screenshot state across every set or every locale. What was read on " +
        `${OBSERVED_AT} is the version record's own screenshot count, zero, on the page inspected; no per-set ` +
        "and no per-localization read-back was performed, and the gate is already blocked by the reading that was",
    );
  }
}


// ── the App Privacy answers, against the manifest the app actually ships ─────
//
// Two checks, and they answer different questions. The first compares the
// packet against the graph pinned at the top of this file: it catches a packet
// edited on its own. The second compares BOTH against
// `apps/ios/Relayium/PrivacyInfo.xcprivacy`: it catches the case the first
// cannot see, where the manifest changed and the packet and this validator were
// updated together to agree with each other and not with the app.
//
// Without the second, three files could agree on an answer the shipped binary
// contradicts — which is the whole failure mode this section exists for, since
// the manifest is what Apple reads and the packet is only what somebody types.

const declaredPrivacy = packet.appPrivacy.collected;
APP_PRIVACY_TYPES.forEach((expected, index) => {
  const actual = declaredPrivacy[index];
  const path = `appPrivacy.collected[${index}]`;
  if (!actual) {
    fail("appPrivacy.collected", `is missing the '${expected.type}' entry`);
    return;
  }
  // Order is compared, not merely membership. The manifest is an ordered list
  // and the candidate script indexes the built one positionally, so a packet
  // that reorders these is describing a different file than the one shipping.
  if (actual.type !== expected.type) {
    fail(`${path}.type`, `must be '${expected.type}'; the order matches the shipped manifest`);
    return;
  }
  if (actual.linked !== expected.linked) {
    fail(`${path}.linked`, `must be ${expected.linked} for '${expected.type}'`);
  }
  if (actual.tracking !== expected.tracking) {
    fail(`${path}.tracking`, `must be ${expected.tracking}; nothing in this app tracks`);
  }
  const samePurposes =
    actual.purposes.length === expected.purposes.length &&
    expected.purposes.every((purpose, position) => actual.purposes[position] === purpose);
  if (!samePurposes) {
    fail(`${path}.purposes`, `must be exactly [${expected.purposes.join(", ")}] for '${expected.type}'`);
  }
});

const declaredPrivacyTypes = declaredPrivacy.map((entry) => entry.type);
for (const absent of APP_PRIVACY_ABSENT_TYPES) {
  if (declaredPrivacyTypes.includes(absent)) {
    fail(
      "appPrivacy.collected",
      `declares '${absent}', which iOS must not: the macOS record declares it, and no iOS call site sends one`,
    );
  }
}
const absentTypes = packet.appPrivacy.deliberatelyAbsent.map((entry) => entry.type);
for (const absent of APP_PRIVACY_ABSENT_TYPES) {
  if (!absentTypes.includes(absent)) {
    fail(
      "appPrivacy.deliberatelyAbsent",
      `does not record why '${absent}' is absent; an unexplained absence is indistinguishable from an oversight`,
    );
  }
}

// ── the manifest, read exactly ───────────────────────────────────────────────
//
// This used to be a regular expression over the file's text that collected the
// ORDERED LIST OF TYPES and nothing else, on the argument that a full plist
// parser "would be a second thing to get wrong". The argument was wrong in a way
// that mattered: an ordered list of type names is the one part of a collected-
// data entry that CANNOT be edited quietly. Everything else can.
//
// A manifest that flips `NSPrivacyCollectedDataTypeLinked` on the activation
// aggregate, or swaps a purpose from Analytics to App Functionality, or grows a
// second purpose, or declares the same type twice, still yields exactly the type
// list this validator was pinned against — so the run stayed green while the
// packet described a different privacy label than the binary shipped. That is
// the precise failure this whole section exists to catch, and the text scan
// could not see it.
//
// So the manifest is parsed. Not with `plutil`, which is macOS-only and would
// make this validator unrunnable in CI on anything else, and not with a
// dependency: with the small strict reader below, which accepts the subset of
// the plist XML grammar Apple's manifests use and REFUSES everything else. A
// refusal is a finding, never a silent fallback to "no entries found" — that
// direction is how an unreadable file passes as an empty one.
//
// XML comments are stripped first, and that is load-bearing rather than tidy.
// The manifest argues at length for its own contents — including a paragraph
// naming `NSPrivacyCollectedDataTypeDeviceID` in order to explain why it is
// absent, and another containing the literal `api/devices/<id>/inbox/...` — so a
// parser fed the raw text would read prose as markup.

class ManifestError extends Error {}

/** Every tag and text run in the document, in order. Attributes are dropped:
 *  `<plist version="1.0">` is an open tag named `plist`, and no value in this
 *  grammar carries an attribute that means anything. */
function plistTokens(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("<", index);
    if (open === -1) {
      tokens.push({ kind: "text", value: text.slice(index) });
      break;
    }
    if (open > index) tokens.push({ kind: "text", value: text.slice(index, open) });
    const close = text.indexOf(">", open);
    if (close === -1) throw new ManifestError("contains an unterminated tag");
    const raw = text.slice(open + 1, close).trim();
    if (raw.length === 0) throw new ManifestError("contains an empty tag");
    if (raw.startsWith("/")) tokens.push({ kind: "close", name: raw.slice(1).trim() });
    else if (raw.endsWith("/")) tokens.push({ kind: "empty", name: raw.slice(0, -1).trim().split(/\s/)[0] });
    else tokens.push({ kind: "open", name: raw.split(/\s/)[0] });
    index = close + 1;
  }
  return tokens;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(value) {
  return value.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[a-z]+);/g, (whole, body) => {
    if (body.startsWith("#x")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    const named = ENTITIES[body];
    if (named === undefined) throw new ManifestError(`uses the unknown XML entity '&${body};'`);
    return named;
  });
}

// The value kinds Apple's manifests contain, plus the numeric ones a hand edit
// could plausibly introduce. Anything else — `<data>`, `<date>`, a tag this
// grammar does not name — is refused rather than skipped.
//
// `key` is NOT here. It is read by the dict branch below through the same
// routine, but it is not a value: an `<array>` holding a `<key>` is a malformed
// document, and listing `key` as a scalar would silently accept one as a string.
const SCALARS = new Set(["string", "integer", "real"]);

/** The text of a `<name>…</name>` element that has already been opened at `at`.
 *  Returns the raw text and the index after the closing tag. */
function parseTextElement(tokens, at, name) {
  let text = "";
  let index = at + 1;
  while (tokens[index] && tokens[index].kind === "text") {
    text += tokens[index].value;
    index += 1;
  }
  const closing = tokens[index];
  if (!closing || closing.kind !== "close" || closing.name !== name) {
    throw new ManifestError(`has an unclosed <${name}>`);
  }
  return [text, index + 1];
}

/** One value starting at `at`. Returns the value and the index after it. */
function parseValue(tokens, at) {
  const token = tokens[at];
  if (!token) throw new ManifestError("ends in the middle of a value");
  if (token.kind === "empty") {
    if (token.name === "true") return [true, at + 1];
    if (token.name === "false") return [false, at + 1];
    if (token.name === "array") return [[], at + 1];
    if (token.name === "dict") return [new Map(), at + 1];
    if (token.name === "string") return ["", at + 1];
    throw new ManifestError(`declares an empty <${token.name}/>, which is not a value`);
  }
  if (token.kind !== "open") throw new ManifestError(`has a stray </${token.name ?? "?"}>`);

  if (SCALARS.has(token.name)) {
    const [text, after] = parseTextElement(tokens, at, token.name);
    if (token.name === "string") return [decodeEntities(text), after];
    const number = Number(text.trim());
    if (!Number.isFinite(number)) throw new ManifestError(`has a <${token.name}> that is not a number`);
    return [number, after];
  }

  if (token.name === "array") {
    const values = [];
    let index = at + 1;
    for (;;) {
      index = skipWhitespace(tokens, index);
      const next = tokens[index];
      if (!next) throw new ManifestError("has an unclosed <array>");
      if (next.kind === "close") {
        if (next.name !== "array") throw new ManifestError(`closes an <array> with </${next.name}>`);
        return [values, index + 1];
      }
      const [value, after] = parseValue(tokens, index);
      values.push(value);
      index = after;
    }
  }

  if (token.name === "dict") {
    // A Map, not an object: it preserves declaration order, it cannot collide
    // with `__proto__`, and `.has` gives the duplicate-key check below something
    // exact to ask.
    const entries = new Map();
    let index = at + 1;
    for (;;) {
      index = skipWhitespace(tokens, index);
      const next = tokens[index];
      if (!next) throw new ManifestError("has an unclosed <dict>");
      if (next.kind === "close") {
        if (next.name !== "dict") throw new ManifestError(`closes a <dict> with </${next.name}>`);
        return [entries, index + 1];
      }
      if (next.kind !== "open" || next.name !== "key") {
        throw new ManifestError(`has a <dict> entry that starts with <${next.name}> instead of <key>`);
      }
      const [rawKey, afterKey] = parseTextElement(tokens, index, "key");
      const key = decodeEntities(rawKey);
      // The failure `plutil` and `PropertyListSerialization` both paper over:
      // a repeated key. Whichever one a reader keeps, the other is invisible.
      if (entries.has(key)) throw new ManifestError(`declares the key '${key}' twice`);
      const [value, afterValue] = parseValue(tokens, skipWhitespace(tokens, afterKey));
      entries.set(key, value);
      index = afterValue;
    }
  }

  throw new ManifestError(`declares <${token.name}>, which is not part of this grammar`);
}

/** Whitespace-only text between markup is structure, not content. Text that is
 *  NOT whitespace-only outside a scalar is a document this reader will not
 *  guess about. */
function skipWhitespace(tokens, at) {
  let index = at;
  while (tokens[index] && tokens[index].kind === "text") {
    if (tokens[index].value.trim().length > 0) {
      throw new ManifestError(`has the stray text '${tokens[index].value.trim().slice(0, 40)}' between tags`);
    }
    index += 1;
  }
  return index;
}

const MANIFEST_KEYS = [
  "NSPrivacyTracking",
  "NSPrivacyTrackingDomains",
  "NSPrivacyCollectedDataTypes",
  "NSPrivacyAccessedAPITypes",
];

const COLLECTED_ENTRY_KEYS = [
  "NSPrivacyCollectedDataType",
  "NSPrivacyCollectedDataTypeLinked",
  "NSPrivacyCollectedDataTypeTracking",
  "NSPrivacyCollectedDataTypePurposes",
];

/**
 * The privacy manifest at `relativePath`, as the four facts this validator
 * compares: the label-level tracking answer, the tracking domains, and the
 * ordered collected-data entries with their linked flag, tracking flag and
 * ordered purposes.
 *
 * Throws `ManifestError` on anything it cannot read EXACTLY. A returned value
 * is a complete reading of the file, never a partial one — which is what makes
 * "the manifest declares no such type" a fact rather than an artefact of a
 * scan that stopped early.
 */
function readPrivacyManifest(relativePath) {
  const text = readFileSync(resolve(repoRoot, relativePath), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/g, "");

  const tokens = plistTokens(text);
  let index = skipWhitespace(tokens, 0);
  const root = tokens[index];
  if (!root || root.kind !== "open" || root.name !== "plist") {
    throw new ManifestError("does not open with a <plist> element");
  }
  const [body, afterBody] = parseValue(tokens, skipWhitespace(tokens, index + 1));
  index = skipWhitespace(tokens, afterBody);
  if (!tokens[index] || tokens[index].kind !== "close" || tokens[index].name !== "plist") {
    throw new ManifestError("does not close its <plist> element after exactly one value");
  }
  if (skipWhitespace(tokens, index + 1) !== tokens.length) {
    throw new ManifestError("carries a second document after </plist>");
  }
  if (!(body instanceof Map)) throw new ManifestError("is not a dictionary at the top level");

  for (const key of body.keys()) {
    if (!MANIFEST_KEYS.includes(key)) throw new ManifestError(`declares the unknown top-level key '${key}'`);
  }
  for (const key of ["NSPrivacyTracking", "NSPrivacyTrackingDomains", "NSPrivacyCollectedDataTypes"]) {
    if (!body.has(key)) throw new ManifestError(`declares no ${key}`);
  }

  const tracking = body.get("NSPrivacyTracking");
  if (typeof tracking !== "boolean") throw new ManifestError("declares a non-boolean NSPrivacyTracking");

  const domains = body.get("NSPrivacyTrackingDomains");
  if (!Array.isArray(domains) || domains.some((domain) => typeof domain !== "string")) {
    throw new ManifestError("declares NSPrivacyTrackingDomains that is not a list of strings");
  }

  const rawCollected = body.get("NSPrivacyCollectedDataTypes");
  if (!Array.isArray(rawCollected)) {
    throw new ManifestError("declares NSPrivacyCollectedDataTypes that is not an array");
  }

  const collected = rawCollected.map((entry, position) => {
    const where = `NSPrivacyCollectedDataTypes[${position}]`;
    if (!(entry instanceof Map)) throw new ManifestError(`${where} is not a dictionary`);
    // Exactly Apple's four keys. A fifth is as wrong as a missing one, and
    // neither has a runtime that would notice.
    const keys = [...entry.keys()].sort();
    if (keys.length !== COLLECTED_ENTRY_KEYS.length ||
        !COLLECTED_ENTRY_KEYS.every((key) => keys.includes(key))) {
      throw new ManifestError(`${where} is not the shape Apple defines: [${keys.join(", ")}]`);
    }
    const type = entry.get("NSPrivacyCollectedDataType");
    if (typeof type !== "string" || !/^NSPrivacyCollectedDataType[A-Za-z]+$/.test(type)) {
      throw new ManifestError(`${where} names no readable data type`);
    }
    const linked = entry.get("NSPrivacyCollectedDataTypeLinked");
    const entryTracking = entry.get("NSPrivacyCollectedDataTypeTracking");
    if (typeof linked !== "boolean" || typeof entryTracking !== "boolean") {
      throw new ManifestError(`${where} ('${type}') has a non-boolean linked or tracking flag`);
    }
    const purposes = entry.get("NSPrivacyCollectedDataTypePurposes");
    if (!Array.isArray(purposes) || purposes.length === 0 ||
        purposes.some((purpose) => typeof purpose !== "string" ||
          !/^NSPrivacyCollectedDataTypePurpose[A-Za-z]+$/.test(purpose))) {
      throw new ManifestError(`${where} ('${type}') has no readable purpose list`);
    }
    if (new Set(purposes).size !== purposes.length) {
      throw new ManifestError(`${where} ('${type}') repeats a purpose`);
    }
    return { type, linked, tracking: entryTracking, purposes };
  });

  const seen = new Set();
  for (const entry of collected) {
    if (seen.has(entry.type)) throw new ManifestError(`declares '${entry.type}' more than once`);
    seen.add(entry.type);
  }

  return { tracking, trackingDomains: domains, collected };
}

const describeEntry = (entry) =>
  `${entry.type}(linked=${entry.linked}, tracking=${entry.tracking}, ` +
  `purposes=[${entry.purposes.join(", ")}])`;

/** A manifest failure, reported. Anything that is neither a reading failure nor
 *  a filesystem failure is a BUG IN THIS FILE and is rethrown: reporting it as
 *  a manifest finding would send somebody to re-audit a correct manifest. */
function failManifest(path, where, error) {
  if (error instanceof ManifestError) fail(where, `${path} ${error.message}`);
  else if (error && error.code) fail(where, `${path} could not be read: ${error.message}`);
  else throw error;
}

let manifest = null;
try {
  manifest = readPrivacyManifest(APP_MANIFEST);
} catch (error) {
  failManifest(APP_MANIFEST, "appPrivacy.sourceOfTruth", error);
}
if (manifest !== null) {
  // The label-level answers, which are a public promise of their own: a
  // manifest that turned NSPrivacyTracking on would put Relayium inside App
  // Tracking Transparency's scope while this packet said it was outside it.
  if (manifest.tracking !== packet.appPrivacy.tracking) {
    fail(
      "appPrivacy.tracking",
      `is ${packet.appPrivacy.tracking}, but ${APP_MANIFEST} declares NSPrivacyTracking ${manifest.tracking}`,
    );
  }
  if (manifest.trackingDomains.length !== packet.appPrivacy.trackingDomains.length) {
    fail(
      "appPrivacy.trackingDomains",
      `lists ${packet.appPrivacy.trackingDomains.length}, but ${APP_MANIFEST} declares [${manifest.trackingDomains.join(", ")}]`,
    );
  }

  // The graph itself, entry by entry and in order. Compared against the pin at
  // the top of this file rather than against the packet, because the packet has
  // already been compared to that pin above: agreeing with the pin and with the
  // manifest is the same as all three agreeing, and reporting it this way names
  // the manifest — the file Apple actually reads — in the finding.
  const expected = APP_PRIVACY_TYPES;
  if (manifest.collected.length !== expected.length) {
    fail(
      "appPrivacy.collected",
      `has ${expected.length} entries, but ${APP_MANIFEST} declares ${manifest.collected.length}: ` +
        `[${manifest.collected.map((entry) => entry.type).join(", ")}]. The manifest is what Apple reads; reconcile before submitting`,
    );
  }
  expected.forEach((want, index) => {
    const got = manifest.collected[index];
    if (!got) return; // already reported by the length finding above
    const same =
      got.type === want.type &&
      got.linked === want.linked &&
      got.tracking === want.tracking &&
      got.purposes.length === want.purposes.length &&
      want.purposes.every((purpose, position) => got.purposes[position] === purpose);
    if (!same) {
      fail(
        `appPrivacy.collected[${index}]`,
        `does not match the shipped manifest. ${APP_MANIFEST} declares ${describeEntry(got)}, ` +
          `this packet and validator pin ${describeEntry(want)}. The manifest is what Apple reads; ` +
          "reconcile before submitting",
      );
    }
  });

  const manifestTypes = manifest.collected.map((entry) => entry.type);
  for (const absent of APP_PRIVACY_ABSENT_TYPES) {
    if (manifestTypes.includes(absent)) {
      fail("appPrivacy.deliberatelyAbsent", `${APP_MANIFEST} now declares '${absent}', which this packet records as absent`);
    }
  }
}

// And the extension, whose declared list must be empty in both places — and
// which must not have quietly acquired a tracking answer either.
let shareManifest = null;
try {
  shareManifest = readPrivacyManifest(SHARE_MANIFEST);
} catch (error) {
  failManifest(SHARE_MANIFEST, "appPrivacy.shareExtension", error);
}
if (shareManifest !== null) {
  if (shareManifest.collected.length > 0) {
    fail(
      "appPrivacy.shareExtension.collected",
      `is empty, but ${SHARE_MANIFEST} declares [${shareManifest.collected.map(describeEntry).join(", ")}]; ` +
        "the extension stages files into the App Group and must collect nothing",
    );
  }
  if (shareManifest.tracking !== false || shareManifest.trackingDomains.length > 0) {
    fail(
      "appPrivacy.shareExtension",
      `${SHARE_MANIFEST} declares NSPrivacyTracking ${shareManifest.tracking} with ` +
        `${shareManifest.trackingDomains.length} tracking domain(s); the appex tracks nothing`,
    );
  }
}

// ── report ───────────────────────────────────────────────────────────────────

report();

function report() {
  if (findings.length > 0) {
    process.stderr.write(`METADATA PACKET REJECTED — ${findings.length} finding(s) in ${packetPath}\n`);
    for (const finding of findings) process.stderr.write(`  - ${finding}\n`);
    process.exit(1);
  }
  if (!quiet) {
    process.stdout.write(`metadata packet ok: ${packetPath}\n`);
    for (const locale of LOCALES) {
      const entry = packet.storefront[locale];
      const chars = (value) => Array.from(value).length;
      process.stdout.write(
        `  ${locale}  name ${chars(entry.name)}/${LIMIT.name}` +
          `  subtitle ${chars(entry.subtitle)}/${LIMIT.subtitle}` +
          `  promo ${chars(entry.promotionalText)}/${LIMIT.promotionalText}` +
          `  description ${chars(entry.description)}/${LIMIT.description}` +
          `  what's new ${chars(entry.whatsNew)}/${LIMIT.whatsNew}` +
          `  keywords ${Buffer.byteLength(entry.keywords.join(","), "utf8")}/${LIMIT.keywordBytes} bytes\n`,
      );
    }
    process.stdout.write(
      `  ${packet.subscriptions.products.length} subscription products, ` +
        `screenshots ${packet.screenshots.state}, accessibility ${packet.accessibilityNutritionLabel.state}\n`,
    );
    const open = packet.appStoreConnectObservation.observedFields.filter((e) => e.blocksSubmission && !e.present);
    process.stdout.write(
      `  record ${APPLE_ID} (${BUNDLE_ID}) read back ${OBSERVED_AT} ${OBSERVED_TIME_ZONE}: ` +
        `${open.length} of ${OBSERVED_FIELDS.length} observed fields are unmet gates` +
        `${open.length > 0 ? ` — ${open.map((e) => e.id).join(", ")}` : ""}\n`,
    );
    process.stdout.write(
      `  ${MAC_APPLE_ID} (${MAC_BUNDLE_ID}) is the macOS record and is never an iOS target.\n` +
        "  this is a recorded read-back, not a live one; re-inspect read-only before archiving, uploading or submitting.\n",
    );
  }
  process.exit(0);
}
