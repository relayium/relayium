#!/usr/bin/env node
// scripts/ios-app-store-screenshots-validate.mjs — a staged storefront
// screenshot bundle, checked against the rules the metadata packet already
// states, before anything is dragged into App Store Connect.
//
// ── why this exists ──────────────────────────────────────────────────────────
//
// `docs/ios-app-store-submission.md` states the screenshot rules in prose, and
// `docs/app-store-metadata-ios.json` states them as data. Prose does not stop
// anything, and the failure modes it describes are all silent at exactly the
// moment they matter:
//
//   * an RGBA PNG looks identical to an RGB one in Preview, in Finder and in a
//     diff, and is rejected on upload;
//   * `1290x2795` looks identical to `1290x2796` to a human reading a filename,
//     and is rejected on upload;
//   * a `.png` extension on a JPEG uploads and then behaves as neither;
//   * a Debug capture is pixel-identical to a Release one EXCEPT for the
//     fabricated subscription prices from
//     `apps/ios/Relayium/UITestSubscriptions.swift` — which is a fabricated
//     price on a public storefront, the one screenshot defect with a commercial
//     consequence rather than a rejected save;
//   * the same file staged into `en-US` and `zh-Hans` is a localization that was
//     never actually done, and nothing about the two directories says so;
//   * a missing `ipad-13`/`zh-Hans` cell is not visible until the upload form
//     shows an empty tab.
//
// None of that is visible to a build, a Swift test or a linter, so it is
// checked here, against the bytes, before the upload that would carry it.
//
// ── what it refuses ──────────────────────────────────────────────────────────
//
//   * a bundle that does not exist. The default posture is REFUSAL: with no
//     `--bundle`, nothing has been staged, and "nothing staged" is a failing
//     state rather than a quiet pass. `--expect-blocked` is the one way to a
//     zero exit from there, and it ASSERTS the blocked state rather than
//     ignoring it;
//   * a manifest that is not exactly one well-formed JSON document: a BOM, a
//     tab, a CRLF, a duplicate object key, a key named `__proto__`,
//     `constructor` or `prototype`, or any key the schema does not name at any
//     depth. Keys are compared DECODED, so `retouched` and `\u0072etouched` are
//     one key and declaring both is the duplicate it is. An unknown key is a
//     finding, never something to skip: a misspelled `retouced` that is silently
//     discarded reads exactly like an attestation that was made;
//   * a set, a locale, a pixel size or a per-cell count that is not the one the
//     PACKET states. None of those are restated here as literals — they are
//     derived, so that a packet edit changes the rule, and so that a rule cannot
//     drift away from the packet unnoticed;
//   * a missing set-locale cell, an extra one, an empty one, a cell over the
//     packet's maximum, a shot staged twice in one cell, and a set whose ordered
//     shot sequence differs between the two localizations;
//   * an image whose BYTES disagree with the manifest: a wrong pixel size, an
//     encoding that is not what the magic number says, an extension that is not
//     what the encoding says, a byte count or digest that does not match;
//   * a PNG carrying an alpha channel — colour type 4 or 6, or a `tRNS` chunk —
//     a broken chunk stream, a failed CRC, bytes after `IEND`, or a landscape
//     frame;
//   * a PNG that is a header rather than an image: no `IDAT`, `IDAT` chunks that
//     are not consecutive, a colour type and bit depth PNG does not pair, a
//     palette image with no `PLTE`, and an `IDAT` stream that does not inflate
//     to the scanlines its own header describes. Adam7 interlacing is refused
//     outright rather than half-checked, because this measures the
//     non-interlaced layout;
//   * a JPEG that is not 8-bit baseline or progressive greyscale/YCbCr:
//     arithmetic, lossless and hierarchical `SOF` variants, a CMYK component
//     count, a missing frame header, a missing `EOI`;
//   * a JPEG that is a marker stream rather than an image: a frame header with
//     no `SOS` scan behind it, a scan with no entropy-coded bytes, a scan that
//     runs off the end of the file, and bytes after `EOI`. The scan is stepped
//     through past stuffed `0xff00` pairs and restart markers rather than
//     skipped — stepped, never Huffman-decoded;
//   * a JPEG whose tables or component references do not resolve. `DQT` and
//     `DHT` segments are parsed to the byte and must be consumed exactly, so an
//     empty, truncated or malformed one defines no table rather than counting
//     as a marker seen; a frame may not repeat a component id; and by scan time
//     every quantization selector and every reachable DC/AC Huffman selector
//     must name a table something actually defined, against a component the
//     frame actually declared, with no component selected twice. That proves
//     the scan's references RESOLVE, not that its entropy bytes decode;
//   * two files anywhere in the bundle with identical bytes;
//   * a path that is not exactly `<set>/<locale>/<name>.<ext>` with a safe name,
//     a symlink, a non-regular file, an entry that escapes the bundle root, and
//     any file or directory on disk the manifest does not list;
//   * provenance that is not a `Release` capture: a Debug configuration, a
//     `--relayium-ui-testing` launch argument, a UI-test fixture, a fabricated
//     price, a retouched frame;
//   * a per-file human review that is absent, incomplete, or claims to have been
//     performed by a tool. `humanReview.method` must be exactly `human-visual`;
//     `ocr`, `automated`, `script`, `model` and friends are named and refused,
//     because the thing being attested is not something this file can check;
//   * the Account shot, while the subscription products the packet describes do
//     not exist in the record it observed. That screen cannot render a real
//     offer list yet, so any capture of it is either empty or fabricated;
//   * ANY report that the current packet is ready. While `screenshots.state` is
//     `not-captured`, a perfectly-formed bundle still exits non-zero and the
//     finding says why. The structural findings are still reported alongside it,
//     so a bundle can be iterated on — but it cannot be declared done by staging
//     files next to a packet that says none exist.
//
// ── what it is NOT ───────────────────────────────────────────────────────────
//
// It does not look at the picture.
//
// It INFLATES a PNG's scanlines and STEPS THROUGH a JPEG's entropy-coded bytes,
// because a header with no image behind it is a file that uploads and renders
// nowhere. That is measurement against the header, and it is the whole of what
// those two passes do: nothing here interprets, renders or reads what the pixels
// show.
//
// The JPEG side is STRUCTURAL specifically. Its tables are parsed and its
// selectors are resolved against them, which is why a malformed table or a
// dangling reference is caught — but the entropy-coded bytes themselves are
// only STEPPED past their stuffing and restart markers. There is no Huffman
// decoder here, no dequantization and no IDCT, so a file whose references all
// resolve can still hold entropy data that decodes to nothing. Structural
// integrity is the claim; decodability is not.
//
// That is the whole of the honest claim, and it is worth being blunt about,
// because the two rules that matter most on a public asset are exactly the two
// this program cannot enforce:
//
//   * NEUTRAL CONTENT. Whether a frame shows an account email address, a device
//     name, a pairing code, a share link or its `#k=` fragment, an IP address, a
//     hostname, a real file name or notification content is a question about
//     rendered glyphs. There is NO OCR here, no text extraction, no image model
//     and no automatic privacy inspection of any kind — and none is planned,
//     because a passing OCR run would be a more dangerous artifact than an
//     absent one: it would read as "checked" while missing rotated, truncated,
//     low-contrast or partially-occluded text.
//   * TRUTHFULNESS. Whether a frame shows the app's real appearance and real
//     data, unretouched, is a question about the world.
//
// So both are handled the only way they honestly can be: a NAMED HUMAN records,
// PER FILE, that they looked at that file and confirmed each. This program
// checks that the attestation is present, complete, well-formed and not
// disguised automation. It cannot check that it is true. A passing run means the
// bundle is structurally uploadable and somebody has put their name to the parts
// that are not structural — NOT that the screenshots are clean.
//
// It also reads no credential, makes no network request, observes no App Store
// Connect state, and stages, generates, retouches and uploads nothing.
//
// `scripts/test/ios-app-store-screenshots-validate-test.mjs` proves each rule by
// mutation, over synthetic images built in a temporary directory. Those fixtures
// are validation data — deliberately not proposed storefront content — and no
// storefront asset exists in this repository.
//
// USAGE
//   node scripts/ios-app-store-screenshots-validate.mjs
//                              [--bundle <dir>] [--packet <path>]
//                              [--expect-blocked] [--quiet]
//
// EXIT  0 the staged bundle satisfies every rule and the packet agrees it is
//         captured; or `--expect-blocked` and the gate is honestly blocked
//       1 at least one finding, all of them printed
//       2 usage error, or an input could not be read

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PACKET = resolve(repoRoot, "docs/app-store-metadata-ios.json");
const MANIFEST_NAME = "manifest.json";

// This bound is this project's own sanity limit, not a published Apple one, and
// it is written down as such rather than dressed up as a rule from Apple. A
// portrait still image at the largest accepted size is a few megabytes; past
// this it is a video, a mistake, or a mislabelled archive.
const MAX_FILE_BYTES = 25 * 1024 * 1024;

// The ceiling on what a PNG's IDAT stream is allowed to inflate to. The largest
// accepted portrait size at 16-bit truecolour is around 34 MB of scanlines, so
// this clears every real screenshot while refusing a decompression bomb: a few
// kilobytes of IDAT can describe terabytes, and this runs over whatever someone
// staged in a directory.
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

// The ways a human review can be faked by a tool. `human-visual` is the only
// accepted value, so these are not needed to reject them — they exist so the
// REFUSAL names the specific substitution, because the substitution is the whole
// point of the rule.
const NON_HUMAN_REVIEW_METHODS = [
  "ocr", "automated", "automatic", "tool", "script", "scripted",
  "ai", "model", "llm", "vision", "heuristic", "validator", "ci",
];

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,58}\.(png|jpg|jpeg)$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PIXEL_SIZE = /^[1-9]\d{2,4}x[1-9]\d{2,4}$/;
// Written as escapes rather than as literal bytes, so the class survives every
// copy, diff and editor this file passes through.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

// Built on first use and reused. Declared here rather than beside crc32() below
// because the top-level bundle walk calls that function while a `let` further
// down the file is still in its temporal dead zone.
let crcTable = null;

// ── findings ─────────────────────────────────────────────────────────────────

const findings = [];
const fail = (path, message) => findings.push(`${path}: ${message}`);

// ── arguments ────────────────────────────────────────────────────────────────

let packetPath = DEFAULT_PACKET;
let bundlePath = null;
let expectBlocked = false;
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
  else if (arg === "--bundle") bundlePath = resolve(next());
  else if (arg === "--expect-blocked") expectBlocked = true;
  else if (arg === "--quiet") quiet = true;
  else if (arg === "--help" || arg === "-h") usage(null);
  else usage(`unknown option ${arg}`);
}

// The two modes contradict each other: one asserts that nothing is staged, the
// other inspects what is. Refusing the combination is better than picking a
// winner, because either choice silently ignores half of what was asked for.
if (expectBlocked && bundlePath !== null) {
  usage("--expect-blocked asserts that nothing is staged; it cannot be combined with --bundle");
}

function usage(problem) {
  if (problem) process.stderr.write(`${problem}\n\n`);
  process.stderr.write(
    "usage: node scripts/ios-app-store-screenshots-validate.mjs " +
      "[--bundle <dir>] [--packet <path>] [--expect-blocked] [--quiet]\n",
  );
  process.exit(2);
}

// ── the packet, which is where every rule comes from ─────────────────────────

let packet;
try {
  packet = JSON.parse(readFileSync(packetPath, "utf8"));
} catch (error) {
  process.stderr.write(`cannot read the metadata packet at ${packetPath}: ${error.message}\n`);
  process.exit(2);
}

// A packet that is not shaped like a packet cannot be the source of any rule,
// and substituting a default would be the worst available failure: the bundle
// would be checked against something nobody wrote down. Fatal, exit 2.
function packetFatal(message) {
  process.stderr.write(`the metadata packet at ${packetPath} ${message}\n`);
  process.exit(2);
}

if (!isPlainObject(packet)) packetFatal("is not a JSON object");
if (!isPlainObject(packet.screenshots)) packetFatal("has no screenshots section");
if (!Array.isArray(packet.locales)) packetFatal("has no locales array");

const shots = packet.screenshots;

// ── the derived rules ────────────────────────────────────────────────────────
//
// Everything below is read out of the packet rather than restated. That is the
// opposite of the choice `ios-app-store-metadata-validate.mjs` makes, and
// deliberately so: THAT validator pins the packet's facts, so it must hold them
// independently. THIS one enforces the packet's facts against files on disk, so
// restating them would create a second home for `1290x2796` and a way for the
// two to disagree while both pass.

const LOCALES = packet.locales;
if (LOCALES.length === 0 || !LOCALES.every((locale) => typeof locale === "string" && locale.length > 0)) {
  packetFatal("has an empty or malformed locales array");
}
if (new Set(LOCALES).size !== LOCALES.length) packetFatal("lists a duplicate locale");

if (!Array.isArray(shots.sets) || shots.sets.length === 0) packetFatal("declares no screenshot sets");

const SETS = new Map();
for (const set of shots.sets) {
  if (!isPlainObject(set) || typeof set.id !== "string" || !Array.isArray(set.acceptedPortraitPixelSizes)) {
    packetFatal("declares a malformed screenshot set");
  }
  if (SETS.has(set.id)) packetFatal(`declares the screenshot set '${set.id}' twice`);
  const sizes = new Set();
  for (const size of set.acceptedPortraitPixelSizes) {
    if (typeof size !== "string" || !PIXEL_SIZE.test(size)) {
      packetFatal(`declares a malformed accepted size in the '${set.id}' set`);
    }
    // The packet calls these PORTRAIT sizes. If one of them is not portrait then
    // the packet is wrong, and checking files against it would carry the error
    // into an upload rather than catch it.
    const [width, height] = size.split("x").map(Number);
    if (height <= width) {
      packetFatal(`lists '${size}' as a portrait size in the '${set.id}' set, but it is not portrait`);
    }
    sizes.add(size);
  }
  if (sizes.size === 0) packetFatal(`declares the '${set.id}' set with no accepted size`);
  SETS.set(set.id, sizes);
}

const rules = shots.rules;
if (!isPlainObject(rules)) packetFatal("has no screenshots.rules");
const MIN_PER_CELL = rules.minPerSetPerLocale;
const MAX_PER_CELL = rules.maxPerSetPerLocale;
if (!Number.isInteger(MIN_PER_CELL) || MIN_PER_CELL < 1) packetFatal("has a malformed minPerSetPerLocale");
if (!Number.isInteger(MAX_PER_CELL) || MAX_PER_CELL < MIN_PER_CELL) packetFatal("has a malformed maxPerSetPerLocale");
if (rules.alphaChannelAllowed !== false) packetFatal("says an alpha channel is allowed; Apple rejects one");
if (rules.perLocalizationSets !== true) packetFatal("no longer requires per-localization sets");

const capture = shots.capture;
if (!isPlainObject(capture)) packetFatal("has no screenshots.capture");
const REQUIRED_CONFIGURATION = capture.requiredConfiguration;
if (typeof REQUIRED_CONFIGURATION !== "string" || REQUIRED_CONFIGURATION.length === 0) {
  packetFatal("has no screenshots.capture.requiredConfiguration");
}
// These four are the honesty rules. A packet that switched one off would
// silently switch off the matching check below, so the packet is refused
// instead: turning one off is a product decision, not a validator one.
for (const flag of [
  "debugBuildsForbidden",
  "uiTestFixturesForbidden",
  "fabricatedPricesForbidden",
  "retouchingForbidden",
]) {
  if (capture[flag] !== true) packetFatal(`no longer sets screenshots.capture.${flag}`);
}

if (!Array.isArray(shots.shotList) || shots.shotList.length === 0) packetFatal("declares no shot list");
const SHOT_LIST = shots.shotList;
for (const shot of SHOT_LIST) {
  if (typeof shot !== "string" || shot.trim().length === 0) packetFatal("declares a malformed shot-list entry");
}
if (new Set(SHOT_LIST).size !== SHOT_LIST.length) packetFatal("lists the same shot twice");

// ── the shot that is blocked on something other than a capture session ───────
//
// The Account screen renders the subscription offer list. The packet's own
// observation records that this record holds no subscription products, and the
// packet's identifiers are proposed drafts — so there is nothing for that screen
// to render honestly. A capture of it today shows either an empty list or a
// fixture, and both are worse than no screenshot at all: one is unshippable, the
// other puts a price Apple never sold onto a public asset.
//
// This unblocks by itself, with no code change, the moment the packet records
// real products on the record.
const observedFields = Array.isArray(packet.appStoreConnectObservation?.observedFields)
  ? packet.appStoreConnectObservation.observedFields
  : [];
const observedProducts = observedFields.find((entry) => isPlainObject(entry) && entry.id === "subscription-products");
const productsAreReal =
  observedProducts?.present === true && packet.subscriptions?.productIdentifiersAreProposedDrafts === false;
const ACCOUNT_SHOTS = productsAreReal ? [] : SHOT_LIST.filter((shot) => /^account\b/i.test(shot));

// ── the packet's own readiness claim ─────────────────────────────────────────
//
// A bundle is only ever "ready" alongside a packet that says screenshots exist.
// While the packet says `not-captured` this program reports every structural
// finding it can — the bundle is still worth iterating on — and then refuses the
// bundle anyway. Staging files next to a packet that says none exist is not a
// way to turn the gate green.
const packetSaysCaptured = shots.state === "captured";
const packetBlockers = Array.isArray(shots.blockedBy) ? shots.blockedBy : [];

// ── --expect-blocked: assert the gate, do not skip it ────────────────────────

if (expectBlocked) {
  if (packetSaysCaptured) {
    fail(
      "screenshots.state",
      "is 'captured', so the gate is no longer blocked; check the staged bundle with --bundle instead",
    );
  } else if (shots.state !== "not-captured") {
    fail("screenshots.state", `is ${describe(shots.state)}, which is neither 'not-captured' nor 'captured'`);
  }
  if (shots.capturedCount !== 0) {
    fail("screenshots.capturedCount", `is ${describe(shots.capturedCount)} while nothing is staged; it must be 0`);
  }
  if (packetBlockers.length === 0) {
    fail(
      "screenshots.blockedBy",
      "records no blocker while the state is not-captured; an uncaptured gate must say what blocks it",
    );
  }
  const gate = observedFields.find((entry) => isPlainObject(entry) && entry.id === "screenshots");
  if (!gate) fail("appStoreConnectObservation.observedFields", "no longer records a 'screenshots' field");
  else if (gate.present !== false || gate.blocksSubmission !== true) {
    fail("appStoreConnectObservation.observedFields[screenshots]", "no longer reads as an unmet blocking gate");
  }
  reportBlocked();
}

// ── no bundle: the default, and it is a refusal ──────────────────────────────

if (bundlePath === null) {
  fail(
    "<bundle>",
    "no bundle was given. Nothing is staged in this repository, and 'nothing staged' is a failing state rather " +
      "than a passing one. Pass --bundle <dir> to check a staged bundle, or --expect-blocked to assert that the " +
      "gate is still honestly blocked",
  );
  report();
}

// ── the bundle root ──────────────────────────────────────────────────────────

let bundleReal;
try {
  const stat = lstatSync(bundlePath);
  if (!stat.isDirectory()) {
    process.stderr.write(`the bundle at ${bundlePath} is not a directory\n`);
    process.exit(2);
  }
  bundleReal = realpathSync(bundlePath);
} catch (error) {
  process.stderr.write(`cannot read the bundle at ${bundlePath}: ${error.message}\n`);
  process.exit(2);
}

// ── the manifest, as bytes before it is a document ───────────────────────────

const manifestPath = join(bundleReal, MANIFEST_NAME);
let manifestRaw;
try {
  manifestRaw = readFileSync(manifestPath, "utf8");
} catch (error) {
  process.stderr.write(`cannot read the bundle manifest at ${manifestPath}: ${error.message}\n`);
  process.exit(2);
}

// Parsing normalizes, and the facts below do not survive it: `JSON.parse` keeps
// the LAST of two duplicate keys and tells nobody, and a BOM or a CRLF survives
// into whatever copies the file. So the bytes are judged first, and a raw
// finding is fatal — there is no useful schema report to give about a document
// whose shape is already in doubt.
if (manifestRaw.charCodeAt(0) === 0xfeff) fail(MANIFEST_NAME, "starts with a UTF-8 BOM; write it as plain UTF-8");
if (manifestRaw.includes("\r")) fail(MANIFEST_NAME, "contains a carriage return; the manifest is LF-only");
if (manifestRaw.includes("\t")) fail(MANIFEST_NAME, "contains a tab; the manifest is indented with spaces");
if (!manifestRaw.endsWith("\n")) fail(MANIFEST_NAME, "does not end with a newline");
for (const problem of rawStructureFindings(manifestRaw)) fail(MANIFEST_NAME, problem);
if (findings.length > 0) report();

let manifest;
try {
  manifest = JSON.parse(manifestRaw);
} catch (error) {
  fail(MANIFEST_NAME, `is not valid JSON: ${error.message}`);
  report();
}

// ── the manifest document ────────────────────────────────────────────────────

if (!isPlainObject(manifest)) {
  fail(MANIFEST_NAME, `is ${describe(manifest)}, not an object`);
  report();
}

only(manifest, MANIFEST_NAME, ["schemaVersion", "bundle", "files"]);

if (manifest.schemaVersion !== 1) {
  fail(`${MANIFEST_NAME}.schemaVersion`, `is ${describe(manifest.schemaVersion)}; this validator reads version 1`);
}

if (!isPlainObject(manifest.bundle)) {
  fail(`${MANIFEST_NAME}.bundle`, `is ${describe(manifest.bundle)}, not an object`);
} else {
  const staged = manifest.bundle;
  only(staged, `${MANIFEST_NAME}.bundle`, ["marketingVersion", "stagedAt", "stagedBy"]);
  const expectedVersion = packet.record?.marketingVersion;
  if (typeof expectedVersion === "string" && staged.marketingVersion !== expectedVersion) {
    // A bundle staged against a different marketing version is a bundle of a
    // different app's screens. It is not obviously wrong on disk, and it is
    // unrecoverable once uploaded.
    fail(
      `${MANIFEST_NAME}.bundle.marketingVersion`,
      `is ${describe(staged.marketingVersion)}; the packet's record is at ${expectedVersion}`,
    );
  }
  requireDate(staged.stagedAt, `${MANIFEST_NAME}.bundle.stagedAt`);
  requireText(staged.stagedBy, `${MANIFEST_NAME}.bundle.stagedBy`);
}

if (!Array.isArray(manifest.files)) {
  fail(`${MANIFEST_NAME}.files`, `is ${describe(manifest.files)}, not an array`);
  report();
}
if (manifest.files.length === 0) {
  fail(`${MANIFEST_NAME}.files`, "is empty; a bundle with no files is not a bundle");
  report();
}

// ── each declared file ───────────────────────────────────────────────────────

const cells = new Map(); // `${setId} ${locale}` -> [{ path, shot }]
const digests = new Map(); // sha256 -> the first bundle path that hashed to it
const declaredPaths = new Set();
const readableFiles = new Set();

manifest.files.forEach((entry, index) => {
  const at = `${MANIFEST_NAME}.files[${index}]`;
  if (!isPlainObject(entry)) {
    fail(at, `is ${describe(entry)}, not an object`);
    return;
  }
  only(entry, at, ["file", "sha256", "bytes", "encoding", "pixelSize", "shot", "capture", "humanReview"]);

  const declaredPath = entry.file;
  if (typeof declaredPath !== "string" || declaredPath.length === 0) {
    fail(`${at}.file`, `is ${describe(declaredPath)}, not a path`);
    return;
  }
  if (declaredPaths.has(declaredPath)) {
    fail(`${at}.file`, `lists '${declaredPath}' a second time`);
    return;
  }
  declaredPaths.add(declaredPath);

  const placement = checkPath(declaredPath, at);
  if (!placement) return;

  checkCapture(entry.capture, `${at}.capture`);
  checkHumanReview(entry.humanReview, `${at}.humanReview`, declaredPath);

  // The shot must be one the packet actually lists, quoted exactly. A
  // paraphrase is not accepted: "which screen is this" is the one piece of
  // semantic information the manifest carries, and an approximate one cannot be
  // checked against the shot list at all.
  if (typeof entry.shot !== "string" || !SHOT_LIST.includes(entry.shot)) {
    fail(
      `${at}.shot`,
      `is ${describe(entry.shot)}; it must quote one of the packet's screenshots.shotList entries exactly`,
    );
  } else if (ACCOUNT_SHOTS.includes(entry.shot)) {
    fail(
      `${at}.shot`,
      "captures the Account screen while the packet records no subscription products on the record " +
        "(appStoreConnectObservation subscription-products is absent, and the identifiers are proposed drafts). " +
        "That screen cannot render a real offer list yet, so the capture is either empty or fabricated",
    );
  }

  const bytes = readImage(join(bundleReal, ...declaredPath.split("/")), at);
  if (!bytes) return;
  readableFiles.add(declaredPath);

  if (!Number.isInteger(entry.bytes) || entry.bytes !== bytes.length) {
    fail(`${at}.bytes`, `says ${describe(entry.bytes)}; the file is ${bytes.length} bytes`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (typeof entry.sha256 !== "string" || !SHA256_HEX.test(entry.sha256)) {
    fail(`${at}.sha256`, `is ${describe(entry.sha256)}; it must be a lowercase 64-character SHA-256 hex digest`);
  } else if (entry.sha256 !== digest) {
    fail(`${at}.sha256`, `says ${entry.sha256}; the file hashes to ${digest}`);
  }

  // Byte-identical files anywhere in the bundle. Within one cell that is a
  // duplicate slide; across the two localizations it is a localization that was
  // never performed, and the directory names say nothing about it either way.
  if (digests.has(digest)) {
    fail(`${at}.file`, `is byte-identical to '${digests.get(digest)}'`);
  } else {
    digests.set(digest, declaredPath);
  }

  const image = decodeImage(bytes, at);
  if (!image) return;

  // The extension, the declared encoding and the magic number are three
  // independent claims about one file, and any two can agree while the third
  // does not. All three are compared.
  const extension = declaredPath.slice(declaredPath.lastIndexOf(".") + 1).toLowerCase();
  const extensionEncoding = extension === "png" ? "png" : "jpeg";
  if (entry.encoding !== "png" && entry.encoding !== "jpeg") {
    fail(`${at}.encoding`, `is ${describe(entry.encoding)}; the accepted still-image encodings are 'png' and 'jpeg'`);
  } else if (entry.encoding !== image.encoding) {
    fail(`${at}.encoding`, `says '${entry.encoding}', but the file's bytes are ${image.encoding}`);
  }
  if (extensionEncoding !== image.encoding) {
    fail(`${at}.file`, `ends in '.${extension}', but the file's bytes are ${image.encoding}`);
  }

  const actualSize = `${image.width}x${image.height}`;
  if (entry.pixelSize !== actualSize) {
    fail(`${at}.pixelSize`, `says ${describe(entry.pixelSize)}; the file's own header says ${actualSize}`);
  }
  const accepted = SETS.get(placement.setId);
  if (!accepted.has(actualSize)) {
    fail(
      `${at}.file`,
      `is ${actualSize}; the packet accepts ${[...accepted].join(", ")} for the '${placement.setId}' set`,
    );
  }
  if (image.height <= image.width) {
    fail(`${at}.file`, `is ${actualSize}, which is not portrait`);
  }

  const key = `${placement.setId} ${placement.locale}`;
  if (!cells.has(key)) cells.set(key, []);
  cells.get(key).push({ path: declaredPath, shot: entry.shot });
});

// ── the grid of cells the packet requires ────────────────────────────────────

for (const setId of SETS.keys()) {
  const sequences = new Map();
  for (const locale of LOCALES) {
    const entries = cells.get(`${setId} ${locale}`) ?? [];
    if (entries.length < MIN_PER_CELL) {
      fail(
        `${setId}/${locale}`,
        entries.length === 0
          ? `has no screenshot; the packet requires ${MIN_PER_CELL} to ${MAX_PER_CELL} per set per localization`
          : `has ${entries.length}; the packet requires at least ${MIN_PER_CELL}`,
      );
    }
    if (entries.length > MAX_PER_CELL) {
      fail(`${setId}/${locale}`, `has ${entries.length}; the packet allows at most ${MAX_PER_CELL}`);
    }
    const shotCounts = new Map();
    for (const { shot } of entries) shotCounts.set(shot, (shotCounts.get(shot) ?? 0) + 1);
    for (const [shot, count] of shotCounts) {
      if (count > 1) fail(`${setId}/${locale}`, `stages the shot ${JSON.stringify(shot)} ${count} times in one cell`);
    }
    sequences.set(locale, entries.map((entry) => entry.shot).join(" | "));
  }
  // The localizations of one set are the same story told twice. A different
  // ordered shot sequence between them means one of them is missing a screen or
  // telling a different story, and the upload form shows two tabs that each look
  // independently plausible.
  if (new Set(sequences.values()).size > 1) {
    fail(
      setId,
      "stages a different ordered shot sequence per localization: " +
        [...sequences].map(([locale, sequence]) => `${locale} = [${sequence}]`).join("; "),
    );
  }
}

// ── the disk, which is the other half of the manifest ────────────────────────
//
// Everything above walks the manifest and looks for the file it names. This
// walks the DISK and looks for the manifest entry, because the failure it
// catches is the opposite one and just as expensive: a rejected frame left in
// the directory, a `.DS_Store`, an editor backup, a stray set folder. Anything
// present and unlisted is a finding — what gets dragged into the upload form is
// the bundle, not the manifest.

walkDisk(bundleReal, []);

function walkDisk(directory, relative) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    fail(relative.join("/") || ".", `cannot be read: ${error.message}`);
    return;
  }
  for (const dirent of entries) {
    const here = [...relative, dirent.name];
    const shown = here.join("/");
    if (dirent.isSymbolicLink()) {
      fail(shown, "is a symlink; a bundle holds real files only");
      continue;
    }
    if (dirent.isDirectory()) {
      if (here.length === 1 && !SETS.has(dirent.name)) {
        fail(shown, `is not one of the packet's sets (${[...SETS.keys()].join(", ")})`);
        continue;
      }
      if (here.length === 2 && !LOCALES.includes(dirent.name)) {
        fail(shown, `is not one of the packet's locales (${LOCALES.join(", ")})`);
        continue;
      }
      if (here.length > 2) {
        fail(shown, "is a directory below the set/locale level; the bundle is exactly two levels deep");
        continue;
      }
      walkDisk(join(directory, dirent.name), here);
      continue;
    }
    if (!dirent.isFile()) {
      fail(shown, "is neither a regular file nor a directory");
      continue;
    }
    if (here.length === 1 && dirent.name === MANIFEST_NAME) continue;
    if (!declaredPaths.has(shown)) {
      fail(shown, `is present in the bundle but ${MANIFEST_NAME} does not list it`);
    }
  }
}

// ── the packet's readiness, which no amount of staging substitutes for ───────

if (!packetSaysCaptured) {
  fail(
    "screenshots.state",
    `is ${describe(shots.state)} in ${packetPath}. A staged bundle cannot be reported ready while the packet ` +
      "records that no screenshot exists; the findings above, if any, are still worth fixing, but this one closes " +
      "by capturing the assets and updating the packet, not by staging files next to it",
  );
  if (packetBlockers.length > 0) {
    fail("screenshots.blockedBy", `still records ${packetBlockers.length} blocker(s): ${packetBlockers.join(" ")}`);
  }
} else {
  if (packetBlockers.length > 0) {
    fail(
      "screenshots.blockedBy",
      `records ${packetBlockers.length} blocker(s) while the state says captured; a captured gate has none left`,
    );
  }
  if (shots.capturedCount !== readableFiles.size) {
    fail(
      "screenshots.capturedCount",
      `says ${describe(shots.capturedCount)}; the bundle holds ${readableFiles.size} readable file(s)`,
    );
  }
}

report();

// ── checks ───────────────────────────────────────────────────────────────────

// The path is the one manifest field that can reach outside the bundle, so it is
// judged as a STRING before it is used to touch the disk.
function checkPath(declaredPath, at) {
  if (declaredPath !== declaredPath.normalize("NFC")) {
    fail(`${at}.file`, "is not NFC-normalized; two visually identical names would be two different files");
    return null;
  }
  if (declaredPath.includes("\\")) {
    fail(`${at}.file`, "contains a backslash; bundle paths are POSIX with '/' separators");
    return null;
  }
  if (CONTROL_CHARACTER.test(declaredPath)) {
    fail(`${at}.file`, "contains a control character");
    return null;
  }
  if (declaredPath.startsWith("/") || /^[A-Za-z]:/.test(declaredPath)) {
    fail(`${at}.file`, "is an absolute path; bundle paths are relative to the bundle root");
    return null;
  }
  const segments = declaredPath.split("/");
  if (segments.length !== 3) {
    fail(`${at}.file`, `has ${segments.length} path segment(s); a bundle path is exactly '<set>/<locale>/<name>.<ext>'`);
    return null;
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      fail(`${at}.file`, "contains a '.' or '..' segment");
      return null;
    }
    if (!SAFE_SEGMENT.test(segment)) {
      fail(`${at}.file`, `has the unsafe path segment '${segment}'`);
      return null;
    }
  }
  const [setId, locale, name] = segments;
  if (!SETS.has(setId)) {
    fail(`${at}.file`, `names the set '${setId}', which the packet does not declare`);
    return null;
  }
  if (!LOCALES.includes(locale)) {
    fail(`${at}.file`, `names the locale '${locale}', which the packet does not declare`);
    return null;
  }
  // One dot, at the end, in front of a still-image extension. This is what stops
  // `shot.png.command` and every other double extension from being staged.
  if (!SAFE_FILE_NAME.test(name)) {
    fail(
      `${at}.file`,
      `has the unsafe file name '${name}'; it must be [A-Za-z0-9][A-Za-z0-9_-]* with a single '.png', '.jpg' or ` +
        "'.jpeg' extension",
    );
    return null;
  }
  return { setId, locale, name };
}

function checkCapture(value, at) {
  if (!isPlainObject(value)) {
    fail(at, `is ${describe(value)}, not an object; every file states how it was captured`);
    return;
  }
  only(value, at, [
    "configuration", "source", "buildIdentifier", "launchArguments",
    "usedUITestFixtures", "fabricatedPrices", "retouched",
  ]);

  if (value.configuration !== REQUIRED_CONFIGURATION) {
    fail(
      `${at}.configuration`,
      `is ${describe(value.configuration)}; the packet requires '${REQUIRED_CONFIGURATION}'. A Debug capture ` +
        "compiles apps/ios/Relayium/UITestSubscriptions.swift and can put a price Apple never sold onto a public " +
        "storefront asset",
    );
  }
  // Simulator or hardware is the owner's choice — the packet says so, and
  // signing changes nothing a camera can see. What is NOT a choice is that the
  // method is written down.
  if (value.source !== "simulator" && value.source !== "device") {
    fail(`${at}.source`, `is ${describe(value.source)}; it must be 'simulator' or 'device'`);
  }
  requireText(value.buildIdentifier, `${at}.buildIdentifier`);

  if (!Array.isArray(value.launchArguments)) {
    fail(`${at}.launchArguments`, `is ${describe(value.launchArguments)}, not an array (use [] for a plain launch)`);
  } else {
    value.launchArguments.forEach((argument, index) => {
      if (typeof argument !== "string") {
        fail(`${at}.launchArguments[${index}]`, `is ${describe(argument)}, not a string`);
        return;
      }
      if (/ui[-_ ]?test/i.test(argument)) {
        fail(
          `${at}.launchArguments[${index}]`,
          `is '${argument}'; a UI-testing launch renders fixture data and fixture prices`,
        );
      }
    });
  }
  for (const [flag, why] of [
    ["usedUITestFixtures", "the packet forbids UI-test fixtures in a storefront asset"],
    ["fabricatedPrices", "a fabricated price on a public storefront asset is a false commercial claim"],
    ["retouched", "the packet forbids retouching; a storefront asset shows the app's real appearance"],
  ]) {
    if (value[flag] !== false) fail(`${at}.${flag}`, `is ${describe(value[flag])}; it must be false — ${why}`);
  }
}

// The two rules this program cannot check, checked as far as they honestly can
// be: that a named human recorded, for THIS file, that they looked.
function checkHumanReview(value, at, declaredPath) {
  if (!isPlainObject(value)) {
    fail(
      at,
      `is ${describe(value)}, not an object. Neutral content and truthfulness are not machine-checkable here — ` +
        "there is no OCR and no image inspection in this validator — so every file carries a named human's review " +
        "or it is refused",
    );
    return;
  }
  only(value, at, [
    "method", "reviewer", "reviewedAt", "neutralContentConfirmed", "truthfulUnretouchedConfirmed", "notes",
  ]);

  if (typeof value.method === "string" && NON_HUMAN_REVIEW_METHODS.includes(value.method.trim().toLowerCase())) {
    fail(
      `${at}.method`,
      `is ${describe(value.method)}. This validator performs no OCR and no automatic semantic inspection, and ` +
        "neither may stand in for the review: a tool that misses rotated, truncated or low-contrast text reports a " +
        "clean frame that is not clean. The value must be 'human-visual'",
    );
  } else if (value.method !== "human-visual") {
    fail(`${at}.method`, `is ${describe(value.method)}; it must be exactly 'human-visual'`);
  }
  requireText(value.reviewer, `${at}.reviewer`);
  requireDate(value.reviewedAt, `${at}.reviewedAt`);
  // Free-form, and required: a reviewer who has to write a sentence about the
  // frame has to have looked at the frame.
  requireText(value.notes, `${at}.notes`);

  if (value.neutralContentConfirmed !== true) {
    fail(
      `${at}.neutralContentConfirmed`,
      `is ${describe(value.neutralContentConfirmed)} for '${declaredPath}'; a named human must confirm this frame ` +
        "shows no account address, device name, pairing code, share link or '#k=' fragment, IP address, hostname, " +
        "real file name or notification content. Nothing here reads the pixels",
    );
  }
  if (value.truthfulUnretouchedConfirmed !== true) {
    fail(
      `${at}.truthfulUnretouchedConfirmed`,
      `is ${describe(value.truthfulUnretouchedConfirmed)} for '${declaredPath}'; a named human must confirm this ` +
        "frame shows the app's real appearance and real data, unretouched",
    );
  }
}

function requireText(value, at) {
  if (typeof value !== "string") {
    fail(at, `is ${describe(value)}, not a string`);
    return;
  }
  if (value.trim().length === 0) {
    fail(at, "is empty; an unfilled attestation field is not an attestation");
    return;
  }
  if (value.trim() !== value) fail(at, "has leading or trailing whitespace");
  if (CONTROL_CHARACTER.test(value)) fail(at, "contains a control character");
}

function requireDate(value, at) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    fail(at, `is ${describe(value)}; it must be an ISO 'YYYY-MM-DD' date`);
    return;
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    fail(at, `is '${value}', which is not a real date`);
  }
}

// ── image bytes ──────────────────────────────────────────────────────────────

function readImage(absolutePath, at) {
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch (error) {
    fail(`${at}.file`, `names a file that is not in the bundle: ${error.message}`);
    return null;
  }
  if (stat.isSymbolicLink()) {
    fail(`${at}.file`, "is a symlink; a bundle holds real files only");
    return null;
  }
  if (!stat.isFile()) {
    fail(`${at}.file`, "is not a regular file");
    return null;
  }
  // Defence in depth. The string checks above already forbid `..`, an absolute
  // path and a backslash, so this should be unreachable — which is exactly when
  // a containment check is worth keeping.
  let real;
  try {
    real = realpathSync(absolutePath);
  } catch (error) {
    fail(`${at}.file`, `cannot be resolved: ${error.message}`);
    return null;
  }
  if (!real.startsWith(bundleReal + sep)) {
    fail(`${at}.file`, "resolves outside the bundle root");
    return null;
  }
  if (stat.size === 0) {
    fail(`${at}.file`, "is empty");
    return null;
  }
  if (stat.size > MAX_FILE_BYTES) {
    fail(`${at}.file`, `is ${stat.size} bytes; this project refuses a still image over ${MAX_FILE_BYTES} bytes`);
    return null;
  }
  try {
    return readFileSync(absolutePath);
  } catch (error) {
    fail(`${at}.file`, `cannot be read: ${error.message}`);
    return null;
  }
}

// The extension is a claim. This is the fact.
function decodeImage(bytes, at) {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return decodePng(bytes, at);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return decodeJpeg(bytes, at);
  fail(
    `${at}.file`,
    "is neither a PNG nor a JPEG by its magic number; the accepted storefront still-image encodings are PNG and JPEG",
  );
  return null;
}

// PNG is walked chunk by chunk and then actually INFLATED, because most of what
// makes a byte stream a picture is not in `IHDR`: a `tRNS` chunk is transparency
// on a colour type that otherwise reads as opaque, bytes after `IEND` are a file
// carrying something other than the picture, and a header with no `IDAT` behind
// it — or an `IDAT` whose zlib stream does not inflate to the scanlines that
// header describes — is a file that will render nowhere. A 33-byte header read
// accepts all three.
function decodePng(bytes, at) {
  // Colour type -> the bit depths PNG actually defines for it. 4 (greyscale +
  // alpha) and 6 (truecolour + alpha) are refused before this is consulted, so
  // the accepted opaque types are exactly greyscale, truecolour and palette.
  // A pair outside this table is a header no decoder agrees about.
  const LEGAL_BIT_DEPTHS = new Map([
    [0, [1, 2, 4, 8, 16]],
    [2, [8, 16]],
    [3, [1, 2, 4, 8]],
  ]);
  const CHANNELS = new Map([
    [0, 1],
    [2, 3],
    [3, 1],
  ]);
  const KNOWN_CRITICAL = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);

  let width = null;
  let height = null;
  let bitDepth = null;
  let colourType = null;
  let paletteEntries = null;
  let sawIhdr = false;
  let sawIend = false;
  let sawIdat = false; // including a legal zero-length one, which carries no bytes
  const idatParts = [];
  let idatClosed = false; // some other chunk has appeared after the IDAT run began
  let offset = 8;

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      fail(`${at}.file`, "is a truncated PNG: a chunk header runs past the end of the file");
      return null;
    }
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (length > bytes.length || dataEnd + 4 > bytes.length) {
      fail(`${at}.file`, `is a truncated PNG: the '${type}' chunk claims ${length} bytes and runs past the end`);
      return null;
    }
    if (bytes.readUInt32BE(dataEnd) !== crc32(bytes.subarray(offset + 4, dataEnd))) {
      fail(`${at}.file`, `is a corrupt PNG: the '${type}' chunk fails its CRC`);
      return null;
    }

    if (type === "IHDR") {
      if (sawIhdr) {
        fail(`${at}.file`, "is a malformed PNG: it has more than one IHDR");
        return null;
      }
      if (offset !== 8) {
        fail(`${at}.file`, "is a malformed PNG: IHDR is not the first chunk");
        return null;
      }
      if (length !== 13) {
        fail(`${at}.file`, `is a malformed PNG: IHDR is ${length} bytes, not 13`);
        return null;
      }
      sawIhdr = true;
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colourType = bytes[dataStart + 9];
      const compression = bytes[dataStart + 10];
      const filter = bytes[dataStart + 11];
      const interlace = bytes[dataStart + 12];
      if (width === 0 || height === 0) {
        fail(`${at}.file`, `is a malformed PNG: its dimensions are ${width}x${height}`);
        return null;
      }
      // Colour type 4 is greyscale+alpha, 6 is truecolour+alpha. Both upload
      // happily and both are rejected by App Store Connect, and neither is
      // visible in any viewer that composites onto white.
      if (colourType === 4 || colourType === 6) {
        fail(
          `${at}.file`,
          `is a PNG with an alpha channel (colour type ${colourType}); the packet's ` +
            "screenshots.rules.alphaChannelAllowed is false and Apple rejects one. Flatten it onto an opaque " +
            "background rather than trusting that it looks opaque",
        );
        return null;
      }
      if (!LEGAL_BIT_DEPTHS.has(colourType)) {
        fail(`${at}.file`, `is a PNG with the invalid colour type ${colourType}`);
        return null;
      }
      // The pair, not the two fields separately. `2/4` and `3/16` each name a
      // legal colour type and a legal bit depth and are not a legal PNG, and a
      // header this validator accepted but no decoder does would have been
      // checked only in the sense that something looked at it.
      if (!LEGAL_BIT_DEPTHS.get(colourType).includes(bitDepth)) {
        fail(
          `${at}.file`,
          `is a PNG at bit depth ${bitDepth} on colour type ${colourType}; PNG defines colour type ` +
            `${colourType} at bit depth ${LEGAL_BIT_DEPTHS.get(colourType).join(", ")} only`,
        );
        return null;
      }
      if (compression !== 0 || filter !== 0) {
        fail(`${at}.file`, "is a PNG with a non-standard compression or filter method");
        return null;
      }
      if (interlace !== 0 && interlace !== 1) {
        fail(`${at}.file`, `is a PNG with the invalid interlace method ${interlace}`);
        return null;
      }
      // Adam7 is legal PNG and is REFUSED here rather than half-checked: its
      // seven passes have their own scanline geometry, and this validator
      // measures the non-interlaced one. Accepting an interlaced file would mean
      // reporting "checked" on the one part of the stream it did not check.
      // Nothing in this project's capture path produces one.
      if (interlace === 1) {
        fail(
          `${at}.file`,
          "is an Adam7 interlaced PNG; this validator inflates and measures the non-interlaced scanline layout " +
            "only, so it refuses one rather than passing an image it did not check. Save it non-interlaced",
        );
        return null;
      }
    } else if (!sawIhdr) {
      fail(`${at}.file`, `is a malformed PNG: the '${type}' chunk precedes IHDR`);
      return null;
    } else {
      // Every IDAT of an image is one deflate stream cut into pieces, and the
      // pieces must be consecutive. Anything between them means the bytes being
      // concatenated below are not the stream the file claims to carry.
      if (type !== "IDAT" && sawIdat) idatClosed = true;

      if (type === "tRNS") {
        // Transparency on a palette, or a colour key. The header reads as
        // opaque; the image is not.
        fail(
          `${at}.file`,
          "is a PNG carrying a tRNS transparency chunk; its colour type reads as opaque but the image is not. " +
            "Flatten it",
        );
        return null;
      } else if (type === "PLTE") {
        if (paletteEntries !== null) {
          fail(`${at}.file`, "is a malformed PNG: it has more than one PLTE");
          return null;
        }
        if (sawIdat) {
          fail(`${at}.file`, "is a malformed PNG: its PLTE palette follows the IDAT data it is meant to index");
          return null;
        }
        if (colourType === 0) {
          fail(`${at}.file`, "is a malformed PNG: it carries a PLTE palette on a greyscale image, which PNG forbids");
          return null;
        }
        if (length === 0 || length % 3 !== 0) {
          fail(`${at}.file`, `is a malformed PNG: PLTE is ${length} bytes, which is not a whole number of RGB entries`);
          return null;
        }
        paletteEntries = length / 3;
        // 256 is the hard ceiling PNG puts on a palette, and it holds even when
        // the palette is the OPTIONAL suggested one a truecolour image may
        // carry. Checking only the colour-type-3 index width below would let a
        // truecolour PNG ship an arbitrarily long PLTE unchallenged.
        if (paletteEntries > 256) {
          fail(
            `${at}.file`,
            `is a malformed PNG: its PLTE holds ${paletteEntries} entries, and PNG allows at most 256`,
          );
          return null;
        }
        if (colourType === 3 && paletteEntries > 1 << bitDepth) {
          fail(
            `${at}.file`,
            `is a malformed PNG: its PLTE holds ${paletteEntries} entries, more than the ${1 << bitDepth} a ` +
              `${bitDepth}-bit index can address`,
          );
          return null;
        }
      } else if (type === "IDAT") {
        if (idatClosed) {
          fail(
            `${at}.file`,
            "is a malformed PNG: its IDAT chunks are not consecutive, so they are not one compressed image",
          );
          return null;
        }
        sawIdat = true;
        if (length > 0) idatParts.push(bytes.subarray(dataStart, dataEnd));
      } else if (type === "IEND") {
        if (length !== 0) {
          fail(`${at}.file`, `is a malformed PNG: IEND carries ${length} bytes`);
          return null;
        }
        sawIend = true;
        // Nothing may follow IEND. Trailing bytes are a concatenated file, an
        // appended chunk or an editor artifact riding along inside something that
        // is about to be published, and they are checked HERE rather than by
        // continuing the walk, because arbitrary trailing bytes rarely parse as a
        // chunk and would otherwise be reported as a truncation instead.
        if (dataEnd + 4 !== bytes.length) {
          fail(
            `${at}.file`,
            `is a PNG with ${bytes.length - dataEnd - 4} byte(s) after IEND; the file carries something other than ` +
              "the image",
          );
          return null;
        }
      } else if (/^[A-Z]/.test(type) && !KNOWN_CRITICAL.has(type)) {
        // A critical chunk (uppercase first letter) this validator does not know
        // is a chunk a decoder is required to refuse. Skipping it would be
        // reading a different file from the one that gets uploaded.
        fail(`${at}.file`, `is a PNG carrying the unknown critical chunk '${type}'`);
        return null;
      }
    }
    offset = dataEnd + 4;
  }

  if (!sawIhdr) {
    fail(`${at}.file`, "is a malformed PNG: it has no IHDR");
    return null;
  }
  if (!sawIend) {
    fail(`${at}.file`, "is a truncated PNG: it has no IEND");
    return null;
  }
  if (colourType === 3 && paletteEntries === null) {
    fail(
      `${at}.file`,
      "is a palette PNG (colour type 3) with no PLTE chunk; every pixel indexes a palette the file does not carry",
    );
    return null;
  }
  // A header and an end marker with nothing between them. It passes every
  // structural check above, is a few dozen bytes, and is not an image.
  if (idatParts.length === 0) {
    fail(
      `${at}.file`,
      "is a PNG with no IDAT image data; it carries a header and an end marker and nothing to render between them",
    );
    return null;
  }

  // The scanlines the header describes: one filter byte and then
  // ceil(width x channels x depth / 8) bytes, per row. Inflating and measuring
  // is what separates a real encode from a plausible-looking chunk stream.
  const stride = Math.ceil((width * CHANNELS.get(colourType) * bitDepth) / 8) + 1;
  const expected = stride * height;
  if (expected > MAX_DECOMPRESSED_BYTES) {
    fail(
      `${at}.file`,
      `declares ${width}x${height} at bit depth ${bitDepth}, whose scanlines are ${expected} bytes — past the ` +
        `${MAX_DECOMPRESSED_BYTES} this validator will inflate. That is not a storefront screenshot`,
    );
    return null;
  }
  let raw;
  try {
    // `maxOutputLength` bounds the inflate rather than trusting the header: a
    // small IDAT can decompress to gigabytes, and this runs on whatever someone
    // staged. One byte over `expected` is enough to report the mismatch below.
    raw = inflateSync(Buffer.concat(idatParts), { maxOutputLength: expected + 1 });
  } catch (error) {
    fail(`${at}.file`, `is a PNG whose IDAT chunks do not inflate to an image: ${error.message}`);
    return null;
  }
  if (raw.length !== expected) {
    fail(
      `${at}.file`,
      `is a PNG whose IDAT data inflates to ${raw.length} byte(s); its ${width}x${height} header at bit depth ` +
        `${bitDepth} and colour type ${colourType} describes ${expected}`,
    );
    return null;
  }
  for (let row = 0; row < height; row += 1) {
    const filterType = raw[row * stride];
    if (filterType > 4) {
      fail(`${at}.file`, `is a corrupt PNG: scanline ${row} carries the undefined filter type ${filterType}`);
      return null;
    }
  }
  return { encoding: "png", width, height };
}

// JPEG has no alpha channel to reject, so what is checked instead is that the
// file is STRUCTURALLY a still image this pipeline can be sure about, and that
// it actually CARRIES A SCAN.
//
// The boundary matters and is worth stating plainly: nothing here Huffman-
// decodes anything. The entropy-coded bytes are STEPPED THROUGH — past stuffed
// `0xff00` pairs and restart markers, to the marker that ends the scan — and
// never expanded into coefficients or pixels. What that buys is the refusal of
// a file that is a marker stream rather than an image: `SOI`, a frame header
// and `EOI` reads as a well-formed JPEG to anything that only follows segment
// lengths, and it is exactly what a hand-built fixture, a cancelled export or a
// truncated copy produces — a file that declares 1290x2796 and renders nowhere.
//
// For the same reason the tables are PARSED rather than counted. A `DQT` or
// `DHT` marker with an empty, truncated or malformed segment behind it defines
// no table, and a scan whose component selectors name a component the frame
// never declared, or a table no segment ever defined, cannot be decoded by
// anything. Presence of a marker is not possession of a table, so this tracks
// which table ids and classes are actually DEFINED and resolves every selector
// against them. That is still a structural claim: it proves the scan's
// references resolve, not that the entropy bytes behind them decode.
function decodeJpeg(bytes, at) {
  const BASELINE_OR_PROGRESSIVE = new Set([0xc0, 0xc1, 0xc2]);
  const UNSUPPORTED_FRAME = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let width = null;
  let height = null;
  let frameMarker = null;
  let sawFrame = false;
  // Quantization table ids, and Huffman tables keyed `<class>:<id>`, that a
  // well-formed segment actually DEFINED. Frame components map their id to the
  // quantization table they select.
  const quantTables = new Set();
  const huffmanTables = new Set();
  const frameComponents = new Map();
  let scans = 0;
  let sawEnd = false;
  let offset = 2;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      fail(`${at}.file`, `is a malformed JPEG: expected a marker at byte ${offset}`);
      return null;
    }
    // 0xff is legal fill before a marker.
    let cursor = offset + 1;
    while (cursor < bytes.length && bytes[cursor] === 0xff) cursor += 1;
    if (cursor >= bytes.length) {
      fail(`${at}.file`, "is a truncated JPEG: it ends inside marker padding");
      return null;
    }
    const marker = bytes[cursor];
    const markerName = `0xff${marker.toString(16).padStart(2, "0")}`;

    if (marker === 0x00) {
      fail(`${at}.file`, `is a malformed JPEG: a stuffed 0xff00 pair at byte ${offset} sits outside any scan`);
      return null;
    }
    if (marker !== 0x01 && marker < 0xc0) {
      fail(`${at}.file`, `is a malformed JPEG: ${markerName} at byte ${offset} is not a JPEG marker`);
      return null;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset = cursor + 1;
      continue;
    }
    if (marker === 0xd9) {
      if (!sawFrame) {
        fail(`${at}.file`, "is a JPEG that ends before any frame header; it carries no image");
        return null;
      }
      if (scans === 0) {
        fail(
          `${at}.file`,
          "is a JPEG that reaches EOI with no SOS scan: it declares a frame and carries no entropy-coded image " +
            "data at all. A marker stream is not a picture",
        );
        return null;
      }
      sawEnd = true;
      offset = cursor + 1;
      break;
    }
    if (cursor + 3 > bytes.length) {
      fail(`${at}.file`, "is a truncated JPEG: a segment length runs past the end of the file");
      return null;
    }
    const length = bytes.readUInt16BE(cursor + 1);
    if (length < 2 || cursor + 1 + length > bytes.length) {
      fail(`${at}.file`, `is a malformed JPEG: the ${markerName} segment claims ${length} bytes`);
      return null;
    }
    const segmentStart = cursor + 3;
    const segmentEnd = cursor + 1 + length;

    if (UNSUPPORTED_FRAME.has(marker)) {
      fail(
        `${at}.file`,
        `is an arithmetic, lossless or hierarchical JPEG (frame marker ${markerName}); stage a ` +
          "baseline or progressive JPEG, or a PNG",
      );
      return null;
    }
    if (marker === 0xcc) {
      fail(`${at}.file`, "is an arithmetic-coded JPEG (it defines arithmetic conditioning); stage a Huffman one");
      return null;
    }
    if (BASELINE_OR_PROGRESSIVE.has(marker)) {
      if (sawFrame) {
        fail(`${at}.file`, "is a multi-frame JPEG; a storefront still image is one frame");
        return null;
      }
      if (length < 8) {
        fail(`${at}.file`, "is a malformed JPEG: its frame header is too short");
        return null;
      }
      const precision = bytes[cursor + 3];
      height = bytes.readUInt16BE(cursor + 4);
      width = bytes.readUInt16BE(cursor + 6);
      const components = bytes[cursor + 8];
      if (precision !== 8) {
        fail(`${at}.file`, `is a ${precision}-bit JPEG; stage an 8-bit one`);
        return null;
      }
      if (width === 0 || height === 0) {
        fail(`${at}.file`, `is a malformed JPEG: its dimensions are ${width}x${height}`);
        return null;
      }
      if (components !== 1 && components !== 3) {
        fail(
          `${at}.file`,
          `is a ${components}-component JPEG; a storefront still image is greyscale or YCbCr, not CMYK`,
        );
        return null;
      }
      if (length !== 8 + 3 * components) {
        fail(
          `${at}.file`,
          `is a malformed JPEG: its frame header is ${length} bytes, not the ${8 + 3 * components} its ` +
            `${components} component(s) require`,
        );
        return null;
      }
      // The component specifications. A scan selects components BY THIS ID, so
      // a repeated id makes every later selector ambiguous, and a quantization
      // selector outside 0-3 names a table JPEG cannot express.
      for (let i = 0; i < components; i += 1) {
        const id = bytes[cursor + 9 + i * 3];
        const quantSelector = bytes[cursor + 11 + i * 3];
        if (frameComponents.has(id)) {
          fail(
            `${at}.file`,
            `is a malformed JPEG: its frame declares component id ${id} twice, so a scan selecting that id ` +
              "names two different components",
          );
          return null;
        }
        if (quantSelector > 3) {
          fail(
            `${at}.file`,
            `is a malformed JPEG: frame component ${id} selects quantization table ${quantSelector}, and JPEG ` +
              "defines only tables 0-3",
          );
          return null;
        }
        frameComponents.set(id, quantSelector);
      }
      sawFrame = true;
      frameMarker = marker;
      offset = segmentEnd;
      continue;
    }

    // DQT. One or more tables packed into the segment: a precision/id byte, then
    // 64 or 128 coefficient bytes. The segment must be consumed EXACTLY, so an
    // empty or part-written table defines nothing and is refused here rather
    // than counted as "a DQT was present".
    if (marker === 0xdb) {
      if (segmentStart === segmentEnd) {
        fail(`${at}.file`, "is a malformed JPEG: it carries a DQT segment that defines no quantization table at all");
        return null;
      }
      let position = segmentStart;
      while (position < segmentEnd) {
        const precision = bytes[position] >> 4;
        const tableId = bytes[position] & 0x0f;
        if (precision > 1) {
          fail(
            `${at}.file`,
            `is a malformed JPEG: a DQT table declares precision ${precision}, and JPEG defines only 0 (8-bit) ` +
              "and 1 (16-bit)",
          );
          return null;
        }
        if (tableId > 3) {
          fail(`${at}.file`, `is a malformed JPEG: a DQT table declares id ${tableId}, and JPEG defines only 0-3`);
          return null;
        }
        const tableBytes = 1 + (precision === 0 ? 64 : 128);
        if (position + tableBytes > segmentEnd) {
          fail(
            `${at}.file`,
            `is a truncated JPEG: its DQT table ${tableId} needs ${tableBytes - 1} coefficient bytes and its ` +
              `segment carries ${segmentEnd - position - 1}`,
          );
          return null;
        }
        quantTables.add(tableId);
        position += tableBytes;
      }
      offset = segmentEnd;
      continue;
    }

    // DHT. Per table: a class/id byte, sixteen code-length counts, then one
    // symbol per counted code. The counts are checked against the code space as
    // well as the segment, because a set of lengths that over-subscribes a
    // 16-bit Huffman code cannot be built into a table by any decoder.
    if (marker === 0xc4) {
      if (segmentStart === segmentEnd) {
        fail(`${at}.file`, "is a malformed JPEG: it carries a DHT segment that defines no Huffman table at all");
        return null;
      }
      let position = segmentStart;
      while (position < segmentEnd) {
        const tableClass = bytes[position] >> 4;
        const tableId = bytes[position] & 0x0f;
        if (tableClass > 1) {
          fail(
            `${at}.file`,
            `is a malformed JPEG: a DHT table declares class ${tableClass}, and JPEG defines only 0 (DC) and 1 (AC)`,
          );
          return null;
        }
        if (tableId > 3) {
          fail(`${at}.file`, `is a malformed JPEG: a DHT table declares id ${tableId}, and JPEG defines only 0-3`);
          return null;
        }
        if (position + 17 > segmentEnd) {
          fail(`${at}.file`, "is a truncated JPEG: a DHT table's sixteen code-length counts run past its segment");
          return null;
        }
        let symbols = 0;
        let codeSpace = 0;
        for (let bitLength = 1; bitLength <= 16; bitLength += 1) {
          const count = bytes[position + bitLength];
          symbols += count;
          codeSpace += count * (1 << (16 - bitLength));
        }
        if (symbols === 0) {
          fail(
            `${at}.file`,
            `is a malformed JPEG: its DHT ${tableClass === 0 ? "DC" : "AC"} table ${tableId} declares no codes at ` +
              "all, so it defines nothing to decode with",
          );
          return null;
        }
        if (codeSpace > 1 << 16) {
          fail(
            `${at}.file`,
            `is a malformed JPEG: its DHT ${tableClass === 0 ? "DC" : "AC"} table ${tableId} declares code lengths ` +
              "that over-subscribe the Huffman code space, so no table can be built from them",
          );
          return null;
        }
        if (position + 17 + symbols > segmentEnd) {
          fail(
            `${at}.file`,
            `is a truncated JPEG: its DHT ${tableClass === 0 ? "DC" : "AC"} table ${tableId} declares ${symbols} ` +
              `code(s) and its segment carries ${segmentEnd - position - 17} symbol byte(s)`,
          );
          return null;
        }
        huffmanTables.add(`${tableClass}:${tableId}`);
        position += 17 + symbols;
      }
      offset = segmentEnd;
      continue;
    }

    if (marker === 0xda) {
      if (!sawFrame) {
        fail(`${at}.file`, "is a malformed JPEG: its scan begins before any frame header");
        return null;
      }
      // A Huffman-coded frame that reaches its scan with no table defined cannot
      // be decoded by anything, whatever the entropy bytes behind it look like.
      if (quantTables.size === 0) {
        fail(`${at}.file`, "is a malformed JPEG: its scan begins with no DQT quantization table defined");
        return null;
      }
      if (huffmanTables.size === 0) {
        fail(`${at}.file`, "is a malformed JPEG: its scan begins with no DHT Huffman table defined");
        return null;
      }
      // Not merely SOME table: the exact tables this frame's components select.
      for (const [id, quantSelector] of frameComponents) {
        if (!quantTables.has(quantSelector)) {
          fail(
            `${at}.file`,
            `is a malformed JPEG: frame component ${id} selects quantization table ${quantSelector}, which no DQT ` +
              "segment defines",
          );
          return null;
        }
      }
      if (length < 6) {
        fail(`${at}.file`, "is a malformed JPEG: its scan header is too short");
        return null;
      }
      const scanComponents = bytes[segmentStart];
      if (scanComponents < 1 || scanComponents > frameComponents.size) {
        fail(
          `${at}.file`,
          `is a malformed JPEG: its scan declares ${scanComponents} component(s) against a ` +
            `${frameComponents.size}-component frame`,
        );
        return null;
      }
      if (length !== 6 + 2 * scanComponents) {
        fail(
          `${at}.file`,
          `is a malformed JPEG: its scan header is ${length} bytes, not the ${6 + 2 * scanComponents} its ` +
            `${scanComponents} component(s) require`,
        );
        return null;
      }
      // Which Huffman tables a scan actually USES depends on the frame. A
      // sequential scan codes both DC and AC coefficients for every component
      // it names. A progressive scan codes one band: `Ss == 0` is the DC band —
      // and a DC refinement pass, `Ah != 0`, codes nothing through a table at
      // all — while `Ss != 0` is an AC band. Requiring both everywhere would
      // reject legitimate progressive files, so only the tables the scan can
      // actually reach are required.
      const progressive = frameMarker === 0xc2;
      const spectralStart = bytes[segmentStart + 1 + 2 * scanComponents];
      const approximationHigh = bytes[segmentStart + 3 + 2 * scanComponents] >> 4;
      const needsDc = !progressive || (spectralStart === 0 && approximationHigh === 0);
      const needsAc = !progressive || spectralStart !== 0;
      const selected = new Set();
      for (let i = 0; i < scanComponents; i += 1) {
        const selector = bytes[segmentStart + 1 + i * 2];
        const tableByte = bytes[segmentStart + 2 + i * 2];
        const dcTable = tableByte >> 4;
        const acTable = tableByte & 0x0f;
        if (selected.has(selector)) {
          fail(
            `${at}.file`,
            `is a malformed JPEG: its scan selects component ${selector} twice, so the same component is coded ` +
              "into one scan more than once",
          );
          return null;
        }
        selected.add(selector);
        if (!frameComponents.has(selector)) {
          fail(
            `${at}.file`,
            `is a malformed JPEG: its scan selects component ${selector}, which its frame header does not declare`,
          );
          return null;
        }
        if (needsDc) {
          if (dcTable > 3) {
            fail(
              `${at}.file`,
              `is a malformed JPEG: its scan selects DC Huffman table ${dcTable} for component ${selector}, and ` +
                "JPEG defines only tables 0-3",
            );
            return null;
          }
          if (!huffmanTables.has(`0:${dcTable}`)) {
            fail(
              `${at}.file`,
              `is a malformed JPEG: its scan selects DC Huffman table ${dcTable} for component ${selector}, which ` +
                "no DHT segment defines",
            );
            return null;
          }
        }
        if (needsAc) {
          if (acTable > 3) {
            fail(
              `${at}.file`,
              `is a malformed JPEG: its scan selects AC Huffman table ${acTable} for component ${selector}, and ` +
                "JPEG defines only tables 0-3",
            );
            return null;
          }
          if (!huffmanTables.has(`1:${acTable}`)) {
            fail(
              `${at}.file`,
              `is a malformed JPEG: its scan selects AC Huffman table ${acTable} for component ${selector}, which ` +
                "no DHT segment defines",
            );
            return null;
          }
        }
      }

      // The entropy-coded data. It is STEPPED, not decoded: inside it `0xff00`
      // is a literal 0xff byte and `0xffd0`..`0xffd7` are restart markers, and
      // both belong to the scan. Any other marker ends it, and running out of
      // file instead is a truncation.
      let position = segmentEnd;
      let entropyBytes = 0;
      let ended = false;
      while (position < bytes.length) {
        if (bytes[position] !== 0xff) {
          position += 1;
          entropyBytes += 1;
          continue;
        }
        let next = position + 1;
        while (next < bytes.length && bytes[next] === 0xff) next += 1;
        if (next >= bytes.length) {
          position = bytes.length;
          break;
        }
        const inScan = bytes[next];
        if (inScan === 0x00) {
          entropyBytes += 1;
          position = next + 1;
          continue;
        }
        if (inScan >= 0xd0 && inScan <= 0xd7) {
          position = next + 1;
          continue;
        }
        ended = true;
        break;
      }
      if (!ended) {
        fail(
          `${at}.file`,
          "is a truncated JPEG: its entropy-coded scan runs to the end of the file without reaching a marker",
        );
        return null;
      }
      if (entropyBytes === 0) {
        fail(`${at}.file`, "is a malformed JPEG: its scan header is followed by a marker, with no entropy-coded data");
        return null;
      }
      scans += 1;
      offset = position;
      continue;
    }
    offset = segmentEnd;
  }

  if (!sawFrame) {
    fail(`${at}.file`, "is a malformed JPEG: it has no frame header");
    return null;
  }
  if (scans === 0) {
    fail(`${at}.file`, "is a malformed JPEG: it has no SOS scan, so it carries no entropy-coded image data");
    return null;
  }
  if (!sawEnd) {
    fail(`${at}.file`, "is a truncated JPEG: it does not end with an EOI marker");
    return null;
  }
  if (offset !== bytes.length) {
    fail(
      `${at}.file`,
      `is a JPEG with ${bytes.length - offset} byte(s) after EOI; the file carries something other than the image`,
    );
    return null;
  }
  return { encoding: "jpeg", width, height };
}

function crc32(buffer) {
  if (crcTable === null) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

// ── shape helpers ────────────────────────────────────────────────────────────

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Unknown input is a finding, never something to ignore. A misspelled
// `retouced: false` parses, validates against nothing, and reads to a human
// exactly like an attestation that was made.
function only(value, at, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${at}.${key}`, "is not a key this manifest schema defines");
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) fail(`${at}.${key}`, "is missing");
  }
}

function describe(value) {
  if (value === undefined) return "absent";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (isPlainObject(value)) return "an object";
  return String(value);
}

// The JSON escapes, decoded exactly as `JSON.parse` decodes them. This matters
// because the scan below compares KEY VALUES, and a key's value is not its
// spelling: `"retouched"` and `"\u0072etouched"` are the same key, written two
// ways, and a scan that compared the raw text would see two different keys —
// which is a duplicate that silently overrides an attestation and is reported by
// nobody. Malformed escapes are kept verbatim and left to `JSON.parse`, which
// rejects the document anyway; the only job here is to stay in step with the
// text.
function decodeJsonString(text, start) {
  const SIMPLE = new Map([
    ['"', '"'],
    ["\\", "\\"],
    ["/", "/"],
    ["b", "\b"],
    ["f", "\f"],
    ["n", "\n"],
    ["r", "\r"],
    ["t", "\t"],
  ]);
  let value = "";
  let i = start + 1;
  while (i < text.length) {
    const character = text[i];
    if (character === '"') return { value, end: i + 1 };
    if (character !== "\\") {
      value += character;
      i += 1;
      continue;
    }
    const escape = text[i + 1];
    i += 2;
    if (SIMPLE.has(escape)) {
      value += SIMPLE.get(escape);
      continue;
    }
    if (escape === "u") {
      const hex = text.slice(i, i + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        // Not an escape at all. The characters behind it are read as the literal
        // text they are on the next passes round this loop.
        value += "\\u";
        continue;
      }
      // Code UNITS, not code points: a surrogate pair arrives as two `\uXXXX`
      // escapes and concatenating the units rebuilds it, which is what
      // `JSON.parse` produces.
      value += String.fromCharCode(Number.parseInt(hex, 16));
      i += 4;
      continue;
    }
    value += `\\${escape ?? ""}`;
  }
  return { value, end: text.length };
}

// A structural scan over the TEXT rather than the parsed value, because the two
// facts it looks for do not survive parsing: `JSON.parse` silently keeps the
// last of two duplicate keys, and a `__proto__` key is a prototype write in
// anything that later assigns the parsed object onto another. Numbers and bare
// literals are skipped; only strings and punctuation carry the object shape this
// needs. Strings are DECODED before they are compared, so an escaped spelling of
// a key is the key.
function rawStructureFindings(text) {
  const problems = [];
  const tokens = [];
  for (let i = 0; i < text.length; ) {
    const character = text[i];
    if (character === '"') {
      const string = decodeJsonString(text, i);
      tokens.push({ kind: "string", value: string.value });
      i = string.end;
      continue;
    }
    if ("{}[]:,".includes(character)) {
      tokens.push({ kind: character });
      i += 1;
      continue;
    }
    i += 1;
  }

  const stack = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind === "{") stack.push(new Set());
    else if (token.kind === "}") stack.pop();
    else if (token.kind === "string" && tokens[i + 1]?.kind === ":" && stack.length > 0) {
      const keys = stack[stack.length - 1];
      const key = token.value;
      if (keys.has(key)) {
        problems.push(`declares the key '${key}' twice in one object; JSON.parse keeps only the last`);
      }
      keys.add(key);
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        problems.push(`declares a '${key}' key`);
      }
    }
  }
  return problems;
}

// ── report ───────────────────────────────────────────────────────────────────

function reportBlocked() {
  if (findings.length > 0) {
    process.stderr.write(`SCREENSHOT GATE STATE REJECTED — ${findings.length} finding(s) in ${packetPath}\n`);
    for (const finding of findings) process.stderr.write(`  - ${finding}\n`);
    process.exit(1);
  }
  if (!quiet) {
    process.stdout.write(
      `screenshot gate blocked, as recorded: ${packetPath}\n` +
        `  state ${shots.state}, ${shots.capturedCount} captured, ${packetBlockers.length} recorded blocker(s)\n` +
        `  required when captured: ${[...SETS.keys()].join(", ")} x ${LOCALES.join(", ")}, ` +
        `${MIN_PER_CELL} to ${MAX_PER_CELL} per cell, portrait, no alpha channel\n` +
        "  nothing is staged in this repository, and this run asserts that rather than passing over it.\n",
    );
  }
  process.exit(0);
}

function report() {
  if (findings.length > 0) {
    process.stderr.write(
      `SCREENSHOT BUNDLE REJECTED — ${findings.length} finding(s) in ${bundlePath ?? "<no bundle>"}\n`,
    );
    for (const finding of findings) process.stderr.write(`  - ${finding}\n`);
    process.exit(1);
  }
  if (!quiet) {
    process.stdout.write(`screenshot bundle ok: ${bundlePath}\n`);
    for (const setId of SETS.keys()) {
      const counts = LOCALES.map((locale) => `${locale} ${(cells.get(`${setId} ${locale}`) ?? []).length}`);
      process.stdout.write(`  ${setId}  ${counts.join("  ")}  (${MIN_PER_CELL}..${MAX_PER_CELL} per cell)\n`);
    }
    process.stdout.write(
      `  ${readableFiles.size} file(s), every one opaque, portrait, at an accepted size and unique by SHA-256\n` +
        "  NOT checked here: what any of them show. There is no OCR and no automatic semantic inspection in this\n" +
        "  validator. Neutral content and truthfulness rest entirely on the per-file human attestations, which are\n" +
        "  recorded claims — a pass is not evidence that they are true.\n",
    );
  }
  process.exit(0);
}
