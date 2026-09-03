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
//     notifications, sync, backup — and a reviewer note that has lost one of
//     the disclosures a single-device reviewer needs;
//   * a screenshot or accessibility state that claims more than has been done.
//
// ── what it is not ───────────────────────────────────────────────────────────
//
// It reads one file. It performs no network request, reads no credential,
// resolves no URL, and observes no App Store Connect state — so a pass says the
// packet is internally consistent and within Apple's limits, NOT that any of it
// has been entered, accepted, or is live. `scripts/test/ios-app-store-metadata-
// validate-test.mjs` proves each rule by mutation.
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
    state: str({ equals: "draft-in-this-repository-app-store-connect-readback-required" }),
    observedAppStoreConnectState: bool({ equals: false }),
    prose: str({ equals: "docs/ios-app-store-submission.md" }),
    validator: str({ equals: "scripts/ios-app-store-metadata-validate.mjs" }),
    note: str({ multiline: true }),
  }),
  record: obj({
    recordName: str({ equals: RECORD_NAME }),
    appleId: str({ equals: APPLE_ID, exemptFromSecretScan: true }),
    bundleId: str({ equals: BUNDLE_ID }),
    shareExtensionBundleId: str({ equals: SHARE_BUNDLE_ID }),
    teamId: str({ equals: TEAM_ID }),
    marketingVersion: str({ pattern: /^\d+\.\d+\.\d+$/ }),
    primaryCategoryUti: str({ equals: "public.app-category.utilities" }),
  }),
  locales: arr(str(), { unique: true, exact: LOCALES }),
  availability: obj({
    state: str({ equals: "recorded-in-this-repository-app-store-connect-readback-required" }),
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
    // 'no row exists' would be a claim about the live record, and nothing here has
    // read the live record. The state says what this repository holds and that a
    // read-back is owed — the only two things it can honestly say.
    state: str({ equals: "drafted-in-this-repository-app-store-connect-readback-required" }),
    productIdentifiersAreProposedDrafts: bool({ equals: true }),
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
    capturedCount: int({ equals: 0 }),
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
    anyFeatureClaimed: bool({ equals: false }),
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
      if (spec.equals !== undefined && value !== spec.equals) fail(path, `must be ${spec.equals}`);
      return undefined;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return fail(path, `must be an integer, not ${describe(value)}`);
      }
      if (spec.equals !== undefined && value !== spec.equals) fail(path, `must be ${spec.equals}`);
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
  if (spec.equals !== undefined && value !== spec.equals) fail(path, `must be exactly '${spec.equals}'`);
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
for (const [path, required] of [...REQUIRED_SUBSTRINGS, ...REQUIRED_ACCOUNT_DISTINCTION]) {
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
    process.stdout.write("  nothing here has been read back from App Store Connect.\n");
  }
  process.exit(0);
}
