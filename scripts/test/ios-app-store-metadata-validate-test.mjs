#!/usr/bin/env node
// scripts/test/ios-app-store-metadata-validate-test.mjs — proof that
// `scripts/ios-app-store-metadata-validate.mjs` actually says no.
//
// ── why a mutation suite and not an assertion suite ──────────────────────────
//
// The validator passes on the packet this repository ships. That fact is worth
// nothing on its own: a validator whose every rule had been deleted would also
// pass on it, and so would one that read the file and returned zero. The only
// way to know a rule exists is to break the thing it protects and require the
// complaint.
//
// So every case below takes the REAL packet, applies exactly one edit — an
// over-long subtitle, a keyword list that is legal in characters and illegal in
// bytes, a sixth product turned into a seventh, a demo password in the reviewer
// notes, a `/apps/` marketing URL, a feature claimed while the label is
// unassessed — writes it to a temporary file, and runs the validator on that
// file as a child process. The case passes only if the validator exits 1 AND
// its complaint names the defect. A mutation that leaves it quiet is a rule
// that is not there.
//
// Two classes of mutation are deliberately over-represented, because both are
// invisible to an eye reading the file:
//
//   * MULTIBYTE. Apple's keyword limit is 100 UTF-8 BYTES. A Chinese list of
//     thirty-four characters is legal by every character count and rejected by
//     App Store Connect. A validator that counted `String.length` would pass
//     it, so a case here builds exactly that list.
//   * MALFORMED RAW STRUCTURE. A duplicate object key, a `__proto__` key, a
//     BOM, a CRLF, a tab. `JSON.parse` normalizes or accepts every one of them
//     and reports nothing, so these are mutated as TEXT rather than as values.
//
// A third class was added on 2026-09-03, when the validator started PARSING
// `PrivacyInfo.xcprivacy` rather than scanning it for type names:
//
//   * THE MANIFEST. A flipped linked flag, a swapped purpose, a repeated key, a
//     fifth key, a tracking answer turned on. Each leaves the ordered list of
//     type names untouched, so each was invisible to the text scan the validator
//     used before — and each is a different privacy label than the one the app
//     ships. These cases cannot be driven through `--packet`, because the
//     manifest paths are resolved from the validator's own location, so they
//     build a throwaway repository under the temporary directory instead: a copy
//     of the validator, a copy of each manifest, one mutation, and a run. The
//     product's own manifests are never written to.
//
// Nothing here reads a credential, contacts a network or observes App Store
// Connect. The fixtures live under a temporary directory that is removed on the
// way out, and the shipped packet and manifests are only ever read.
//
// USAGE: node scripts/test/ios-app-store-metadata-validate-test.mjs
// EXIT   0 every case behaved; 1 at least one did not

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const validator = join(repoRoot, "scripts", "ios-app-store-metadata-validate.mjs");
const shippedPacketPath = join(repoRoot, "docs", "app-store-metadata-ios.json");

const shippedRaw = readFileSync(shippedPacketPath, "utf8");

let failures = 0;
let cases = 0;
const ok = (label) => process.stdout.write(`ok   — ${label}\n`);
const bad = (label, detail) => {
  failures += 1;
  process.stdout.write(`FAIL — ${label}\n     ${detail}\n`);
};

const work = mkdtempSync(join(tmpdir(), "ios-app-store-metadata-test."));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

let fixtureNumber = 0;
function runOn(text, extraArgs = []) {
  fixtureNumber += 1;
  const path = join(work, `packet-${fixtureNumber}.json`);
  writeFileSync(path, text);
  const result = spawnSync(process.execPath, [validator, "--packet", path, "--quiet", ...extraArgs], {
    encoding: "utf8",
  });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const clone = () => JSON.parse(shippedRaw);
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

// A mutation that does not change the file is a mutation that was never
// applied — the commonest way a suite like this silently stops testing
// anything. Every value case is required to differ from the shipped packet.
function rejects(label, mutate, expected, extraArgs = []) {
  cases += 1;
  const mutated = clone();
  mutate(mutated);
  const text = serialize(mutated);
  if (text === serialize(clone())) {
    bad(label, "the mutation was a no-op; the rule it targets was never exercised");
    return;
  }
  assertRejected(label, runOn(text, extraArgs), expected);
}

function rejectsRaw(label, transform, expected, extraArgs = []) {
  cases += 1;
  const text = transform(shippedRaw);
  if (text === shippedRaw) {
    bad(label, "the raw mutation was a no-op; the rule it targets was never exercised");
    return;
  }
  assertRejected(label, runOn(text, extraArgs), expected);
}

function assertRejected(label, { status, out }, expected) {
  if (status !== 1) {
    bad(label, `exited ${status}, expected 1; output: ${out.trim().split("\n").slice(0, 3).join(" | ")}`);
    return;
  }
  if (!out.includes(expected)) {
    bad(label, `rejected, but no finding mentioned '${expected}'; output: ${out.trim().split("\n").slice(0, 6).join(" | ")}`);
    return;
  }
  ok(label);
}

function accepts(label, text, extraArgs = []) {
  cases += 1;
  const { status, out } = runOn(text, extraArgs);
  if (status !== 0) bad(label, `exited ${status}; output: ${out.trim().split("\n").slice(0, 6).join(" | ")}`);
  else ok(label);
}

// ── the baseline ─────────────────────────────────────────────────────────────

accepts("the shipped packet passes", shippedRaw);
accepts("the shipped packet passes against its own declared version", shippedRaw, ["--expect-version", "0.3.1"]);

// A validator that exits 0 on anything would satisfy every `accepts` above and
// nothing below, which is what the rest of this file is for.

// ── Apple's length limits ────────────────────────────────────────────────────

rejects(
  "a name over 30 characters",
  (p) => {
    p.storefront["en-US"].name = "Relayium Encrypted File Transfer";
  },
  "over Apple's limit of 30",
);

rejects(
  "a subtitle over 30 characters",
  (p) => {
    p.storefront["en-US"].subtitle = "End-to-end encrypted device transfer";
  },
  "over Apple's limit of 30",
);

rejects(
  "promotional text over 170 characters",
  (p) => {
    p.storefront["en-US"].promotionalText = `${p.storefront["en-US"].promotionalText} And a sentence that pushes it past the limit.`;
  },
  "over Apple's limit of 170",
);

rejects(
  "a description over 4000 characters",
  (p) => {
    p.storefront["en-US"].description += ` ${"transfer ".repeat(500)}`.trimEnd();
  },
  "over Apple's limit of 4000",
);

rejects(
  "What's New over 4000 characters",
  (p) => {
    p.storefront["zh-Hans"].whatsNew += `${"设备收件箱现在可以接收。".repeat(400)}`;
  },
  "over Apple's limit of 4000",
);

// Three cases lived here: an in-app purchase display name under Apple's
// minimum of two characters, one over thirty, and a description over forty-five.
// They are gone because the rules they exercised are gone, and the rules are
// gone because the packet no longer proposes any subscription copy — the six
// products already exist and are Approved, so a display name written in this
// repository would be an edit to a live product rather than a draft of a new
// one. If a genuinely new product is ever proposed, the limits and these three
// cases come back together. What replaces them is the set below: the packet
// must not be able to say the catalogue is a proposal, and must not be able to
// name a second product namespace.

rejects(
  "the Approved catalogue restated as a proposal",
  (p) => {
    p.subscriptions.productIdentifiersAlreadyExistAndAreApproved = false;
  },
  "an identifier that exists is not a proposal",
);

rejects(
  "permission to create new products",
  (p) => {
    p.subscriptions.noNewProductsMayBeCreated = false;
  },
  "cannot be deleted",
);

rejects(
  "a product moved into the superseded namespace",
  (p) => {
    p.subscriptions.products[0].productId = "com.relayium.app.plus.monthly";
  },
  "permanently fork the catalogue",
);

// The same proposal arriving as prose rather than as a product row. A reviewer
// requirement or a note saying "create com.relayium.app.plus.monthly" is just
// as actionable as a row, and a rule that reads only `subscriptions.products`
// would not see it.
rejects(
  "a second product namespace proposed in prose",
  (p) => {
    p.subscriptions.reviewRequirements.push(
      "Create com.relayium.app.plus.monthly for the iOS storefront.",
    );
  },
  "a second namespace is permanent",
);

rejects(
  "a product whose live state is downgraded from Approved",
  (p) => {
    p.subscriptions.products[2].observedState = "Ready to Submit";
  },
  "subscriptions.products[2].observedState",
);

rejects(
  "the Approved group resubmitted with the app version",
  (p) => {
    p.subscriptions.submittedWithAppVersion = true;
  },
  "already Approved",
);

rejects(
  "a second subscription group id",
  (p) => {
    p.subscriptions.group.groupId = "22307428";
  },
  "subscriptions.group.groupId",
);

// ── keywords: the byte limit, and why characters are not enough ──────────────

rejects(
  "a Chinese keyword list that is legal in characters and over 100 UTF-8 BYTES",
  (p) => {
    // 36 characters — far inside any character-based limit — and 116 bytes with
    // the separators once encoded as UTF-8. This is the case a `String.length`
    // check waves through and App Store Connect refuses.
    p.storefront["zh-Hans"].keywords = [
      "文件传输",
      "跨设备传输",
      "局域网传输",
      "加密传输",
      "发送文件",
      "设备互传",
      "二维码配对",
      "端到端加密",
    ];
  },
  "UTF-8 bytes",
);

rejects(
  "an English keyword list over 100 UTF-8 bytes",
  (p) => {
    p.storefront["en-US"].keywords = [
      "file transfer",
      "send files",
      "encrypted",
      "device to device",
      "nearby",
      "cross network",
      "qr code",
      "peer to peer",
      "large files",
    ];
  },
  "UTF-8 bytes",
);

rejects(
  "a two-character keyword",
  (p) => {
    p.storefront["zh-Hans"].keywords[1] = "传输";
  },
  "Apple refuses a keyword of two or fewer",
);

rejects(
  "a duplicated keyword",
  (p) => {
    p.storefront["en-US"].keywords[5] = p.storefront["en-US"].keywords[0];
  },
  "is a duplicate of an earlier element",
);

rejects(
  "a keyword carrying its own comma",
  (p) => {
    p.storefront["en-US"].keywords[4] = "nearby,offline";
  },
  "must not contain a comma",
);

// ── locales ──────────────────────────────────────────────────────────────────

rejects(
  "a storefront locale that has gone missing",
  (p) => {
    delete p.storefront["zh-Hans"];
  },
  "storefront.zh-Hans",
);

rejects(
  "a storefront locale nobody speaks",
  (p) => {
    p.storefront.ja = JSON.parse(JSON.stringify(p.storefront["en-US"]));
  },
  "storefront.ja",
);

rejects(
  "a TestFlight locale that has gone missing",
  (p) => {
    delete p.testFlight.whatToTest["zh-Hans"];
  },
  "testFlight.whatToTest.zh-Hans",
);

// A product localization dropping a locale was the third locale case. The
// packet carries no product localizations any more, so the equivalent
// assertion is that a product cannot quietly REGROW one: an unknown key at any
// depth is a finding, which is what stops the removed drafts from being pasted
// back in beside the identifiers.
rejects(
  "a product that regrows its localization drafts",
  (p) => {
    p.subscriptions.products[2].localizations = {
      "en-US": { displayName: "Relayium Pro Monthly", description: "Relayium Pro plan, billed monthly." },
      "zh-Hans": { displayName: "Relayium Pro 月付", description: "Relayium Pro 套餐，按月计费。" },
    };
  },
  "subscriptions.products[2].localizations",
);

rejects(
  "the declared locale list itself drifting",
  (p) => {
    p.locales = ["en-US", "zh-Hans", "ja"];
  },
  "must be exactly [en-US, zh-Hans]",
);

// ── shape: unknown, missing, and wrongly typed ───────────────────────────────

rejects(
  "an unknown top-level key",
  (p) => {
    p.appPreviews = { state: "not-captured" };
  },
  "is not a field this packet defines",
);

rejects(
  "an unknown nested key",
  (p) => {
    p.storefront["en-US"].promoText = "a second promotional text nobody reads";
  },
  "is not a field this packet defines",
);

rejects(
  "a missing required field",
  (p) => {
    delete p.storefront["en-US"].whatsNew;
  },
  "storefront.en-US.whatsNew: is missing",
);

rejects(
  "a string field holding a number",
  (p) => {
    p.storefront["en-US"].subtitle = 30;
  },
  "must be a string, not number",
);

rejects(
  "a boolean field holding a string",
  (p) => {
    p.appReview.signInRequired = "yes";
  },
  "must be a boolean, not string",
);

rejects(
  "an array field holding an object",
  (p) => {
    p.storefront["en-US"].keywords = { 0: "file transfer" };
  },
  "must be an array, not object",
);

rejects(
  "an object field holding null",
  (p) => {
    p.screenshots.capture = null;
  },
  "must be an object, not null",
);

rejects(
  "an empty string",
  (p) => {
    p.storefront["zh-Hans"].subtitle = "";
  },
  "must not be empty",
);

rejects(
  "a string with trailing whitespace",
  (p) => {
    p.storefront["en-US"].subtitle += " ";
  },
  "has leading or trailing whitespace",
);

rejects(
  "a single-line field carrying a newline",
  (p) => {
    p.storefront["en-US"].subtitle = "End-to-end\nencrypted";
  },
  "contains a control character",
);

// ── the pinned record ────────────────────────────────────────────────────────

rejects(
  "the Apple ID drifting",
  (p) => {
    p.record.appleId = "6791918823";
  },
  "record.appleId",
);

rejects(
  "the bundle identifier drifting",
  (p) => {
    p.record.bundleId = "com.relayium.ios";
  },
  "record.bundleId",
);

rejects(
  "the record name drifting",
  (p) => {
    p.record.recordName = "Relayium";
  },
  "record.recordName",
);

// The App Store name is owner-controlled and the record holds `relayium`. A
// metadata paste is not the place to rename an app, so the exact case is pinned
// in BOTH directions: neither a capitalized rename nor any other spelling.
rejects(
  "the record name being capitalized into a rename",
  (p) => {
    p.storefront["en-US"].name = "Relayium";
  },
  "must be exactly 'relayium'",
);

rejects(
  "the Chinese storefront renaming the app",
  (p) => {
    p.storefront["zh-Hans"].name = "Relayium 中继";
  },
  "must be exactly 'relayium'",
);

rejects(
  "a rename smuggled back in as a delta note",
  (p) => {
    p.record.displayNameDelta = "This packet enters the exact-case product name 'Relayium'.";
  },
  "is not a field this packet defines",
);

rejects(
  "a marketing version the packet was not drafted for",
  (p) => {
    p.record.marketingVersion = "0.4.0";
  },
  "not the '0.3.1' this packet was written for",
);

cases += 1;
assertRejected(
  "a candidate whose version disagrees with the packet",
  runOn(shippedRaw, ["--expect-version", "0.4.0"]),
  "this run was told the candidate is '0.4.0'",
);

// ── URLs ─────────────────────────────────────────────────────────────────────

rejects(
  "a marketing URL pointing at the 404ing /apps/ page",
  (p) => {
    p.storefront["en-US"].marketingUrl = "https://relayium.com/apps/";
  },
  "which 404s in English",
);

rejects(
  "a localized /apps/ URL smuggled into the description",
  (p) => {
    p.storefront["zh-Hans"].description += "\n\nhttps://relayium.com/zh/apps/";
  },
  "which 404s in English",
);

rejects(
  "a Chinese marketing URL that is not the pinned site root",
  (p) => {
    p.storefront["zh-Hans"].marketingUrl = "https://relayium.com/zh/";
  },
  "must be 'https://relayium.com/'",
);

rejects(
  "an English marketing URL that is not the pinned site root",
  (p) => {
    p.storefront["en-US"].marketingUrl = "https://relayium.com/support/";
  },
  "must be 'https://relayium.com/'",
);

rejects(
  "a support URL that is not the localized one",
  (p) => {
    p.storefront["zh-Hans"].supportUrl = "https://relayium.com/support/";
  },
  "must be 'https://relayium.com/zh/support/'",
);

rejects(
  "a privacy URL on another host",
  (p) => {
    p.storefront["en-US"].privacyPolicyUrl = "https://relayium.pages.dev/privacy/";
  },
  "is not a relayium.com page",
);

rejects(
  "a plain-HTTP URL",
  (p) => {
    p.storefront["en-US"].description += "\n\nhttp://relayium.com/terms/";
  },
  "is plain HTTP",
);

// ── the six subscription products ────────────────────────────────────────────

rejects(
  "five products instead of six",
  (p) => {
    p.subscriptions.products.pop();
  },
  "fewer than the required 6",
);

rejects(
  "seven products instead of six",
  (p) => {
    p.subscriptions.products.push(JSON.parse(JSON.stringify(p.subscriptions.products[0])));
  },
  "more than the permitted 6",
);

rejects(
  "two products sharing one identifier",
  (p) => {
    p.subscriptions.products[5].productId = p.subscriptions.products[4].productId;
  },
  "is a duplicate",
);

// "A product reusing a macOS identifier" used to be here, and it was refused.
// It is now the CORRECT value and the refusal has been inverted — that case
// moved up to "a product moved into the superseded namespace". This is the one
// rule in the file whose polarity the universal-purchase migration reversed, so
// it is worth being explicit: `com.relayium.mac.*` is the catalogue, and
// `com.relayium.app.*` is what must never be created.

rejects(
  "a product identifier that does not match its own plan and cycle",
  (p) => {
    p.subscriptions.products[1].cycle = "monthly";
  },
  "must be 'com.relayium.mac.plus.monthly' for the plus monthly row",
);

rejects(
  "the group's live copy being reclaimed as this repository's to author",
  (p) => {
    p.subscriptions.group.referenceNameAndLocalizationsAreLiveAndNotAuthoredHere = false;
  },
  "subscriptions.group.referenceNameAndLocalizationsAreLiveAndNotAuthoredHere",
);

rejects(
  "the group's live state being downgraded from Approved",
  (p) => {
    p.subscriptions.group.observedState = "Missing Metadata";
  },
  "subscriptions.group.observedState",
);

// ── availability and ANSSI ───────────────────────────────────────────────────

rejects(
  "France quietly returning to the initial release",
  (p) => {
    p.availability.initialExcludedTerritories = p.availability.initialExcludedTerritories.filter(
      (entry) => entry.code !== "FR",
    );
  },
  "must be exactly CN and FR",
);

rejects(
  "a third excluded territory appearing without a decision",
  (p) => {
    p.availability.initialExcludedTerritories.push({
      code: "DE",
      name: "Germany",
      reason: "Held out of the initial release.",
    });
  },
  "must be exactly CN and FR",
);

rejects(
  "ANSSI going back to being an unconditional launch blocker",
  (p) => {
    p.availability.anssiDeclaration.blocksInitialRelease = true;
  },
  "availability.anssiDeclaration.blocksInitialRelease",
);

rejects(
  "ANSSI ceasing to block adding France",
  (p) => {
    p.availability.anssiDeclaration.blocksAddingFrance = false;
  },
  "availability.anssiDeclaration.blocksAddingFrance",
);

// ── placeholders, credentials, contact details, prices ───────────────────────

rejects(
  "an angle-bracket placeholder where a real value belongs",
  (p) => {
    p.appReview.notes += "\n\nDemo account: <owner-provided at submission>";
  },
  "an angle-bracket placeholder",
);

rejects(
  "a TODO left in the copy",
  (p) => {
    p.storefront["en-US"].whatsNew += "\n\nTODO: mention the iPad sidebar.";
  },
  "a placeholder marker",
);

rejects(
  "an email address in the reviewer notes",
  (p) => {
    p.appReview.notes += "\n\nReview contact: reviewer@relayium.com";
  },
  "an email address",
);

rejects(
  "a telephone number in the reviewer notes",
  (p) => {
    p.appReview.notes += "\n\nContact on 415-555-0142 during review.";
  },
  "a telephone number",
);

rejects(
  "a demo password in the reviewer notes",
  (p) => {
    p.appReview.notes += "\n\nDemo account password: relayium-review-2026";
  },
  "a credential word",
);

rejects(
  "an owner-entered field acquiring a value",
  (p) => {
    p.appReview.ownerEnteredFields[5].value = "hunter2";
  },
  "is not a field this packet defines",
);

rejects(
  "an owner-entered field this packet does not own",
  (p) => {
    p.appReview.ownerEnteredFields[0].field = "appleIdPassword";
  },
  "which is not an owner-entered App Store Connect field",
);

rejects(
  "a price in the description",
  (p) => {
    p.storefront["en-US"].description += "\n\nRelayium Plus is US$1.99 per month.";
  },
  "a currency amount",
);

// The bare-decimal case used to run against a product description. There are
// no product descriptions here now, so it runs against the section that DOES
// still talk about price — the note explaining that prices are live on the
// record and not authored in this repository. That is exactly where somebody
// would be tempted to write one down.
rejects(
  "a bare decimal price in the subscription price note",
  (p) => {
    p.subscriptions.priceAndAvailability.note += " Plus is 1.99 monthly.";
  },
  "a decimal price",
);

// ── claims the shipped build does not support ────────────────────────────────

rejects(
  "an English description promising background receiving",
  (p) => {
    p.storefront["en-US"].description += "\n\nRelayium keeps receiving in the background.";
  },
  "uses 'background'",
);

rejects(
  "an English description promising notifications",
  (p) => {
    p.storefront["en-US"].promotionalText = "Get a notification the moment a file lands on this device.";
  },
  "a notification claim",
);

rejects(
  "an English description calling the product a backup",
  (p) => {
    p.storefront["en-US"].subtitle = "Encrypted backup for files";
  },
  "a backup claim",
);

rejects(
  "an English description promising sync",
  (p) => {
    p.storefront["en-US"].whatsNew += "\n\nYour devices now sync as soon as they are online.";
  },
  "a sync claim",
);

rejects(
  "a Chinese description promising automatic sync",
  (p) => {
    p.storefront["zh-Hans"].whatsNew += "\n\n你的设备现在会自动同步。";
  },
  "(automatic)",
);

rejects(
  "a Chinese description promising notifications",
  (p) => {
    p.storefront["zh-Hans"].promotionalText += "文件到达时会收到通知。";
  },
  "(notification)",
);

rejects(
  "a keyword promising background receiving",
  (p) => {
    p.storefront["en-US"].keywords[4] = "background transfer";
  },
  "uses 'background'",
);

rejects(
  "reviewer notes that have acquired a background-receiving claim",
  (p) => {
    p.appReview.notes += "\n\nThe app also receives in the background when signed in.";
  },
  "a background-receiving claim",
);

rejects(
  "a TestFlight description that has acquired a notification claim",
  (p) => {
    p.testFlight.betaAppDescription["en-US"] += "\n\nThe build sends you a notification on arrival.";
  },
  "a notification claim",
);

rejects(
  "reviewer notes that have lost the no-notification disclosure",
  (p) => {
    p.appReview.notes = p.appReview.notes.replace(
      "and no notification of any kind is delivered at any point",
      "and delivery is immediate",
    );
  },
  "must state 'no notification'",
);

rejects(
  "reviewer notes that have lost the two-device disclosure",
  (p) => {
    p.appReview.notes = p.appReview.notes.replace("two devices", "a device");
  },
  "must state 'two devices'",
);

rejects(
  "reviewer notes that have lost the off-by-default disclosure",
  (p) => {
    p.appReview.notes = p.appReview.notes.replace("Receiving is off by default.", "Receiving is ready to use.");
  },
  "must state 'off by default'",
);

rejects(
  "reviewer notes that have lost the Sandbox statement",
  (p) => {
    p.appReview.notes = p.appReview.notes.replace(
      " A Sandbox account is not charged.",
      " Purchases are validated before any entitlement is granted.",
    );
  },
  "must state 'Sandbox'",
);

rejects(
  "a Chinese TestFlight description that has lost the foreground disclosure",
  (p) => {
    p.testFlight.betaAppDescription["zh-Hans"] = p.testFlight.betaAppDescription["zh-Hans"].replace(
      "并处于前台时",
      "时",
    );
  },
  "must state '前台'",
);

// ── Cross-network Transfer needs an account in exactly one direction ─────────
//
// `PairingCodeModel.mint` takes a bearer token and the server will not mint
// anonymously; joining a code somebody else is showing takes no token. So the
// blanket sentence is false in one direction and true in the other, and it is
// the sentence a copywriter reaches for. Both halves are checked: the blanket
// claim is refused, and deleting the accurate one — which would satisfy every
// ban — is refused too.

rejects(
  "an English description claiming Cross-network Transfer needs no account",
  (p) => {
    p.storefront["en-US"].description = p.storefront["en-US"].description.replace(
      "Device Inbox, stored links, your plan and showing a cross-network code need a Relayium account. LAN Transfer needs none, and neither does joining a cross-network code somebody else is showing.",
      "Device Inbox, stored links and your plan need a Relayium account. LAN Transfer and Cross-network Transfer do not.",
    );
  },
  "a blanket claim that Cross-network Transfer needs no account",
);

rejects(
  "a Chinese description claiming Cross-network Transfer needs no account",
  (p) => {
    p.storefront["zh-Hans"].description = p.storefront["zh-Hans"].description.replace(
      "设备收件箱、存储链接、套餐，以及出示跨网络配对码，都需要 Relayium 账户；局域网传输不需要，加入别人出示的跨网络配对码也不需要。",
      "设备收件箱、存储链接和套餐需要 Relayium 账户；局域网传输和跨网络传输不需要。",
    );
  },
  "a blanket claim that Cross-network Transfer needs no account",
);

rejects(
  "reviewer notes claiming Cross-network Transfer works signed out",
  (p) => {
    p.appReview.notes = p.appReview.notes.replace(
      "LAN Transfer works signed out. Cross-network Transfer is direction-specific:",
      "Cross-network Transfer works signed out. Also:",
    );
  },
  "Cross-network Transfer works signed out",
);

rejects(
  "a TestFlight description pairing the two lanes as account-free",
  (p) => {
    p.testFlight.betaAppDescription["en-US"] += "\n\nLAN Transfer and Cross-network Transfer need no account.";
  },
  "a blanket claim that Cross-network Transfer needs no account",
);

rejects(
  "the English description losing the account asymmetry",
  (p) => {
    p.storefront["en-US"].description = p.storefront["en-US"].description.replace(
      "Showing a code needs a Relayium account; joining a code somebody else is showing does not. ",
      "",
    );
  },
  "must state 'Showing a code needs a Relayium account'",
);

rejects(
  "the Chinese description losing the account asymmetry",
  (p) => {
    p.storefront["zh-Hans"].description = p.storefront["zh-Hans"].description.replace(
      "出示配对码需要 Relayium 账户；加入别人出示的码则不需要。",
      "",
    );
  },
  "must state '出示配对码需要 Relayium 账户'",
);

rejects(
  "reviewer notes losing the account asymmetry",
  (p) => {
    p.appReview.notes = p.appReview.notes.replace(
      "joining a six-digit code somebody else is showing works signed out, but showing a code requires a signed-in account",
      "it works between any two devices",
    );
  },
  "must state 'showing a code requires a signed-in account'",
);

rejects(
  "the English What to Test losing the signed-out join check",
  (p) => {
    p.testFlight.whatToTest["en-US"] = p.testFlight.whatToTest["en-US"].replace(
      " Confirm the asymmetry explicitly — signed out, joining a code somebody else is showing works, and showing a code does not; signed in, showing a code works.",
      "",
    );
  },
  "must state 'joining a code somebody else is showing works, and showing a code does not'",
);

rejects(
  "the Chinese What to Test losing the signed-out join check",
  (p) => {
    p.testFlight.whatToTest["zh-Hans"] = p.testFlight.whatToTest["zh-Hans"].replace(
      "并且明确验证这个不对称：未登录时可以加入别人出示的码，但不能出示码；登录后才能出示码。",
      "",
    );
  },
  "must state '未登录时可以加入别人出示的码，但不能出示码'",
);

// ── the review attachment: state and prose must agree, both ways ─────────────

rejects(
  "reviewer notes claiming an attachment that has not been produced",
  (p) => {
    p.appReview.notes = p.appReview.notes.replace(
      "A review attachment demonstrating the two-device flow must be supplied with this submission. It has not been produced yet, and this record does not claim it exists; produce it and attach it before submitting, then update this sentence to say it is attached.",
      "A review attachment demonstrating the two-device flow is provided.",
    );
  },
  "says the review attachment is provided while appReview.attachment.state is 'not-produced'",
);

rejects(
  "reviewer notes dropping the attachment requirement altogether",
  (p) => {
    p.appReview.notes = p.appReview.notes.replace(
      "A review attachment demonstrating the two-device flow must be supplied with this submission. It has not been produced yet, and this record does not claim it exists; produce it and attach it before submitting, then update this sentence to say it is attached.",
      "A reviewer with one device sees the empty state.",
    );
  },
  "must state that the review attachment 'must be supplied'",
);

rejects(
  "the attachment state advancing while the notes still say it is owed",
  (p) => {
    p.appReview.attachment.state = "produced";
  },
  "still says the review attachment must be supplied",
);

rejects(
  "an attachment state nobody defined",
  (p) => {
    p.appReview.attachment.state = "in-progress";
  },
  "must be one of not-produced, produced",
);

// ── the packet's own state strings ───────────────────────────────────────────

rejects(
  "the packet claiming it is not entered in App Store Connect",
  (p) => {
    p.packet.state = "draft-not-entered-in-app-store-connect";
  },
  "packet.state",
);

rejects(
  "the subscription catalogue claiming no row exists",
  (p) => {
    p.subscriptions.state = "no-row-exists-in-app-store-connect";
  },
  "subscriptions.state",
);

rejects(
  "availability claiming it has not been entered",
  (p) => {
    p.availability.state = "owner-decision-not-yet-entered";
  },
  "availability.state",
);

// "The product identifiers being promoted from proposal to fact" used to sit
// here, refusing a packet that claimed the six identifiers existed. They do
// exist, so that case has inverted into "the Approved catalogue restated as a
// proposal" further up, alongside the two rules that now matter more: that no
// new product may be created, and that the superseded namespace may not be
// named anywhere in the packet.


// ── the App Store Connect observation ────────────────────────────────────────
//
// Rewritten 2026-09-03 with the target. Until then the target was the separate
// iOS-only record `6791918822` and almost every field on it was empty, so every
// case here mutated in one direction: a gate claimed met. The universal-purchase
// record is not like that. It ships macOS publicly, its catalogue is Approved,
// its privacy answers are published, its price and availability are set — so
// the cases below now come in three kinds:
//
//   * THE WRONG RECORD. Still two records, and the decoy has swapped places:
//     `6791918822` / `com.relayium.app` is the one this repository itself used
//     to name, which makes it look correct to anyone reading an older commit.
//     Every way of naming it as the target is mutated here.
//   * A GATE CLAIMED MET, as before, but only two gates are left to claim: a
//     build selected on the iOS version, and the screenshots.
//   * A LIVE FACT CLAIMED ABSENT, which is new and is the more dangerous half.
//     Saying the subscription group, the products, the privacy answers, the
//     price, the availability or the selected release option are missing does
//     not merely understate the record — it invites somebody to set them, and
//     on this record creating a product or a second group is permanent and
//     forks the catalogue the released macOS app is selling through.

rejects(
  "the superseded record's Apple ID used as the target",
  (p) => {
    p.record.appleId = "6791918822";
  },
  "never a delivery target",
);

rejects(
  "the retired bundle identifier used as the target",
  (p) => {
    p.record.bundleId = "com.relayium.app";
  },
  "is the retired identity",
);

rejects(
  "the iOS share extension moved onto the macOS appex identifier",
  (p) => {
    p.record.shareExtensionBundleId = "com.relayium.mac.Share";
  },
  "record.shareExtensionBundleId",
);

rejects(
  "the iOS share extension reverted to the retired identifier",
  (p) => {
    p.record.shareExtensionBundleId = "com.relayium.app.share";
  },
  "record.shareExtensionBundleId",
);

rejects(
  "the superseded record marked as the delivery target",
  (p) => {
    p.appStoreConnectObservation.records[1].targetForIosRelease = true;
  },
  "marks the superseded record",
);

rejects(
  "both records marked as the iOS target",
  (p) => {
    p.appStoreConnectObservation.records[1].targetForIosRelease = true;
    p.appStoreConnectObservation.records[0].note = "Either record will do.";
  },
  "names 2 iOS targets",
);

rejects(
  "neither record marked as the iOS target",
  (p) => {
    p.appStoreConnectObservation.records[0].targetForIosRelease = false;
  },
  "names 0 iOS targets",
);

rejects(
  "the target swapped back onto the superseded identifiers",
  (p) => {
    p.appStoreConnectObservation.records[0].appleId = "6791918822";
    p.appStoreConnectObservation.records[0].bundleId = "com.relayium.app";
  },
  "as the iOS target; it is 6801142976",
);

rejects(
  "the superseded record dropped from the observation",
  (p) => {
    p.appStoreConnectObservation.records[1].appleId = "6791918823";
  },
  "does not record the superseded iOS-only record",
);

rejects(
  "the superseded record recorded under the wrong bundle",
  (p) => {
    p.appStoreConnectObservation.records[1].bundleId = "com.relayium.ios";
  },
  "records 6791918822 with bundle",
);

rejects(
  "the superseded Apple ID pasted into the reviewer notes",
  (p) => {
    p.appReview.notes = `${p.appReview.notes}\n\nApp Store Connect record 6791918822.`;
  },
  "names Apple ID 6791918822",
);

rejects(
  "the retired bundle pasted into the reviewer notes",
  (p) => {
    p.appReview.notes = `${p.appReview.notes}\n\nThe bundle under review is com.relayium.app.`;
  },
  "names 'com.relayium.app'",
);

// The App Group survived the migration with the retired bundle id inside its
// name, so the scan above has to see past it. A rule that refused this string
// would make preserving a live container look like naming a dead record — and
// the container is what every staged share draft lives in.
accepts(
  "the App Group's name, which contains the retired bundle id and is not it",
  serialize(
    (() => {
      const p = clone();
      p.appPrivacy.shareExtension.reason +=
        " The container is group.com.relayium.app and it did not follow the bundle id.";
      return p;
    })(),
  ),
);

rejects(
  "the observed version drifting from the version this packet is drafted for",
  (p) => {
    p.appStoreConnectObservation.records[0].observedVersion = "0.4.0";
  },
  "read the target's version back as",
);

rejects(
  "the observed version state promoted past what was read",
  (p) => {
    p.appStoreConnectObservation.records[0].observedVersionState = "Waiting for Review";
  },
  "reports the target's version state as",
);

rejects(
  "a build claimed selected on the iOS version",
  (p) => {
    p.appStoreConnectObservation.observedFields[1].present = true;
  },
  "no build is selected",
);

rejects(
  "the Approved subscription group claimed absent",
  (p) => {
    p.appStoreConnectObservation.observedFields[2].present = false;
  },
  "subscription group 22307427",
);

rejects(
  "the six Approved products claimed absent",
  (p) => {
    p.appStoreConnectObservation.observedFields[3].present = false;
  },
  "the six com.relayium.mac",
);

rejects(
  "the published App Privacy answers claimed unanswered",
  (p) => {
    p.appStoreConnectObservation.observedFields[4].present = false;
  },
  "App Privacy is published on the record",
);

rejects(
  "the saved Privacy Policy URL claimed absent",
  (p) => {
    p.appStoreConnectObservation.observedFields[5].present = false;
  },
  "is saved as the record's Privacy Policy URL",
);

rejects(
  "a User Privacy Choices URL claimed saved on the record",
  (p) => {
    p.appStoreConnectObservation.observedFields[6].present = true;
  },
  "the User Privacy Choices URL is blank",
);

rejects(
  "the price schedule claimed absent",
  (p) => {
    p.appStoreConnectObservation.observedFields[7].present = false;
  },
  "Free across all 175 price territories",
);

rejects(
  "the availability selection claimed absent",
  (p) => {
    p.appStoreConnectObservation.observedFields[8].present = false;
  },
  "available in 173 territories",
);

rejects(
  "screenshots claimed on a version that has none",
  (p) => {
    p.appStoreConnectObservation.observedFields[9].present = true;
  },
  "required iPhone and iPad screenshot sets are missing",
);

// The one gate whose reading is neither "still owed" nor "already done": the
// version's release option was READ as manual. Claiming it absent invites
// somebody to go and set it, and the option they would most likely set is the
// default — automatic — which ships an approved version with no human in the
// loop.
rejects(
  "the selected manual release option claimed absent",
  (p) => {
    p.appStoreConnectObservation.observedFields[10].present = false;
  },
  "manual release is the option selected",
);

rejects(
  "a blocking gate quietly downgraded to non-blocking",
  (p) => {
    p.appStoreConnectObservation.observedFields[9].blocksSubmission = false;
  },
  "must be true for 'screenshots'",
);

rejects(
  "the readings reordered so the transcript no longer matches the pass",
  (p) => {
    const fields = p.appStoreConnectObservation.observedFields;
    [fields[1], fields[2]] = [fields[2], fields[1]];
  },
  "the order is the order the fields were read in",
);

rejects(
  "a reading dropped from the transcript",
  (p) => {
    p.appStoreConnectObservation.observedFields.splice(10, 1);
  },
  "fewer than the required 12",
);

rejects(
  "a reading of a field nobody defined",
  (p) => {
    p.appStoreConnectObservation.observedFields[11].id = "app-store-connect-vibes";
  },
  "appStoreConnectObservation.observedFields[11].id",
);

// ── the universal-purchase shape itself ──────────────────────────────────────

rejects(
  "the record described as iOS-only",
  (p) => {
    p.appStoreConnectObservation.universalPurchase.platforms = ["iOS"];
  },
  "appStoreConnectObservation.universalPurchase.platforms",
);

rejects(
  "the shared bundle id contradicted inside the universal-purchase section",
  (p) => {
    p.appStoreConnectObservation.universalPurchase.sharedBundleId = "com.relayium.ios";
  },
  "appStoreConnectObservation.universalPurchase.sharedBundleId",
);

rejects(
  "the released macOS platform reclaimed as writable here",
  (p) => {
    p.appStoreConnectObservation.universalPurchase.macOSIsReadOnlyHere = false;
  },
  "appStoreConnectObservation.universalPurchase.macOSIsReadOnlyHere",
);

rejects(
  "the iOS delivery state widened to speak for the whole record",
  (p) => {
    p.appStoreConnectObservation.deliveryState.platform = "macOS";
  },
  "appStoreConnectObservation.deliveryState.platform",
);

rejects(
  "the iOS platform claimed released, which the macOS one is",
  (p) => {
    p.appStoreConnectObservation.deliveryState.released = true;
  },
  "appStoreConnectObservation.deliveryState.released",
);

rejects(
  "the iOS version set to release itself on approval",
  (p) => {
    p.appStoreConnectObservation.deliveryState.releaseType = "automatic";
  },
  "appStoreConnectObservation.deliveryState.releaseType",
);

// Manual release was read off the record. Demoting that to an intention is the
// edit that makes it revisable by opinion rather than by re-reading.
rejects(
  "the observed manual release restated as a mere intention",
  (p) => {
    p.appStoreConnectObservation.deliveryState.releaseTypeObservedOnTheRecord = false;
  },
  "demoting an observation to an intention",
);

rejects(
  "a signed test notification claimed for this record",
  (p) => {
    p.appStoreConnectObservation.appStoreServerNotifications
      .signedTestNotificationObservedForThisRecord = true;
  },
  "signedTestNotificationObservedForThisRecord",
);

// ── the published privacy union, which is per RECORD and not per platform ────

rejects(
  "the published union losing the type only macOS declares",
  (p) => {
    p.appPrivacy.recordLevelPublishedUnion =
      p.appPrivacy.recordLevelPublishedUnion.filter((t) => t !== "NSPrivacyCollectedDataTypeDeviceID");
  },
  "appPrivacy.recordLevelPublishedUnion",
);

rejects(
  "the iOS manifest list padded to match the published union",
  (p) => {
    p.appPrivacy.collected.push({
      type: "NSPrivacyCollectedDataTypeDeviceID",
      linked: true,
      tracking: false,
      purposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
      basis: "Parity with the record's published answers.",
    });
  },
  "appPrivacy.collected",
);

rejects(
  "a published union carrying a type neither platform declares",
  (p) => {
    p.appPrivacy.recordLevelPublishedUnion[6] = "NSPrivacyCollectedDataTypePreciseLocation";
  },
  "unexpected NSPrivacyCollectedDataTypePreciseLocation",
);

rejects(
  "the record's saved Privacy Policy URL repointed",
  (p) => {
    p.appPrivacy.privacyPolicyUrlOnRecord = "https://relayium.com/legal/privacy/";
  },
  "appPrivacy.privacyPolicyUrlOnRecord",
);

rejects(
  "a User Privacy Choices URL claimed present in the privacy section",
  (p) => {
    p.appPrivacy.userPrivacyChoicesUrlOnRecordIsBlank = false;
  },
  "appPrivacy.userPrivacyChoicesUrlOnRecordIsBlank",
);

// ── availability, now that it is a live selection rather than an intention ───

rejects(
  "the live territory counts contradicted",
  (p) => {
    p.availability.availableTerritoryCount = 175;
  },
  "availability.availableTerritoryCount",
);

rejects(
  "the app claimed not to be free",
  (p) => {
    p.availability.free = false;
  },
  "availability.free",
);

rejects(
  "the record claimed fully submission-ready",
  (p) => {
    p.appStoreConnectObservation.fullySubmissionReady = true;
  },
  "unmet gate(s)",
);

rejects(
  "a ready-to-submit claim in prose rather than in the flag",
  (p) => {
    p.appStoreConnectObservation.readinessNote =
      "The record has been read back and is ready to submit.";
  },
  "a ready-to-submit claim",
);

rejects(
  "an all-gates-met claim in prose",
  (p) => {
    p.appStoreConnectObservation.scope = "All gates are met and the record needs nothing further.";
  },
  "an all-gates-met claim",
);

rejects(
  "the production notification endpoint claimed absent",
  (p) => {
    p.appStoreConnectObservation.appStoreServerNotifications.productionUrlConfigured = false;
  },
  "productionUrlConfigured",
);

rejects(
  "the sandbox notification endpoint claimed absent",
  (p) => {
    p.appStoreConnectObservation.appStoreServerNotifications.sandboxUrlConfigured = false;
  },
  "sandboxUrlConfigured",
);

rejects(
  "the notification endpoint repointed away from Relayium's",
  (p) => {
    p.appStoreConnectObservation.appStoreServerNotifications.url = "https://relayium.com/api/apple/notify";
  },
  "appStoreServerNotifications.url",
);

rejects(
  "the notification endpoints removed from the observation altogether",
  (p) => {
    delete p.appStoreConnectObservation.appStoreServerNotifications;
  },
  "appStoreConnectObservation.appStoreServerNotifications: is missing",
);

rejects(
  "the observed reading of the notification endpoints flipped to absent",
  (p) => {
    p.appStoreConnectObservation.observedFields[11].present = false;
  },
  "both the Production and Sandbox Server URLs were already saved",
);

rejects(
  "a signed TEST notification claimed for this record",
  (p) => {
    p.appStoreConnectObservation.appStoreServerNotifications.signedTestNotificationObservedForThisRecord = true;
  },
  "signedTestNotificationObservedForThisRecord",
);

rejects(
  "an archive claimed against this record",
  (p) => {
    p.appStoreConnectObservation.deliveryState.archived = true;
  },
  "deliveryState.archived",
);

rejects(
  "an upload claimed against this record",
  (p) => {
    p.appStoreConnectObservation.deliveryState.uploaded = true;
  },
  "deliveryState.uploaded",
);

rejects(
  "a submission claimed against this record",
  (p) => {
    p.appStoreConnectObservation.deliveryState.submittedForReview = true;
  },
  "deliveryState.submittedForReview",
);

rejects(
  "a release claimed against this record",
  (p) => {
    p.appStoreConnectObservation.deliveryState.released = true;
  },
  "deliveryState.released",
);

rejects(
  "the observation date moved without a new reading",
  (p) => {
    p.appStoreConnectObservation.observedAt = "2026-09-10";
  },
  "appStoreConnectObservation.observedAt",
);

rejects(
  "the observation date reduced to a year",
  (p) => {
    p.appStoreConnectObservation.observedAt = "2026";
  },
  "appStoreConnectObservation.observedAt",
);

rejects(
  "the time zone of the reading changed",
  (p) => {
    p.appStoreConnectObservation.timeZone = "UTC";
  },
  "appStoreConnectObservation.timeZone",
);

rejects(
  "the whole observation deleted",
  (p) => {
    delete p.appStoreConnectObservation;
  },
  "appStoreConnectObservation: is missing",
);

rejects(
  "the observation growing a field no rule reads",
  (p) => {
    p.appStoreConnectObservation.confidence = "high";
  },
  "appStoreConnectObservation.confidence",
);

rejects(
  "the build-number caveat deleted from what was not observed",
  (p) => {
    p.appStoreConnectObservation.notObserved = p.appStoreConnectObservation.notObserved.filter(
      (entry) => !entry.includes("build number"),
    );
  },
  "highest consumed build number is unobserved",
);

rejects(
  "the blanket 'nothing has been read back' posture restored",
  (p) => {
    p.packet.note = "Every value here is a draft. Nothing here has been read back from App Store Connect.";
  },
  "blanket 'nothing has been read back' posture",
);

rejects(
  "the blanket 'this file has read back nothing' posture restored",
  (p) => {
    p.subscriptions.priceAndAvailability.note =
      "The six identifiers are a proposal and this file has read back no row.";
  },
  "blanket 'this file has read back nothing' posture",
);

rejects(
  "the blanket 'nothing here has looked' posture restored",
  (p) => {
    p.appPrivacy.note = "The App Privacy answers this project proposes. Nothing here has looked at the record.";
  },
  "blanket 'nothing here has looked' posture",
);

rejects(
  "a blanket claim that the record has never been inspected",
  (p) => {
    p.appStoreConnectObservation.scope = "No field of the record has been read, so all of this is a proposal.";
  },
  "a blanket claim that the record has not been inspected",
);

rejects(
  "a fully-ready claim in prose",
  (p) => {
    p.appStoreConnectObservation.readinessNote = "The record is fully ready and needs no further work.";
  },
  "a fully-ready claim",
);

rejects(
  "a submission-ready claim in prose",
  (p) => {
    p.appStoreConnectObservation.readinessNote = "This record is submission-ready as of the date above.";
  },
  "a submission-ready claim",
);

rejects(
  "a ready-for-release claim in prose",
  (p) => {
    p.appStoreConnectObservation.readinessNote = "The version is ready for release once somebody presses the button.";
  },
  "a ready-to-release claim",
);

rejects(
  "a nothing-is-blocking claim in prose",
  (p) => {
    p.appStoreConnectObservation.readinessNote = "Nothing is blocking this record from going out.";
  },
  "a nothing-is-blocking claim",
);

rejects(
  "the packet's observation pointer reverted to a single boolean",
  (p) => {
    p.packet.observedAppStoreConnectState = false;
  },
  "packet.observedAppStoreConnectState",
);

rejects(
  "the App Privacy section's observation pointer reverted to a single boolean",
  (p) => {
    p.appPrivacy.observedAppStoreConnectState = false;
  },
  "appPrivacy.observedAppStoreConnectState",
);

rejects(
  "the App Privacy state reverted to the blanket read-back-required posture",
  (p) => {
    p.appPrivacy.state = "drafted-in-this-repository-app-store-connect-readback-required";
  },
  "appPrivacy.state",
);

rejects(
  "a screenshot count raised above what the record was observed to hold",
  (p) => {
    p.screenshots.state = "not-captured";
    p.screenshots.capturedCount = 3;
  },
  "sets were observed missing on the record on 2026-09-03",
);

// ── the screenshot reading, and the survey it is not ──────────────────────
//
// The reading is the version record's own screenshot count, zero, on the page
// inspected. It is NOT a per-set and per-localization survey, and the gap
// between those two matters because the wider one is free to write, reads as
// more thorough, blocks exactly the same gate, and is unsupported. `present:
// false` cannot catch it: the over-read agrees with the pin and overstates the
// evidence behind it. These cases hold the narrow reading in place from both
// directions — the caveat may not be dropped, and the survey may not be written.

rejects(
  "the screenshot per-set and per-localization caveat dropped",
  (p) => {
    p.appStoreConnectObservation.notObserved =
      p.appStoreConnectObservation.notObserved.filter(
        (entry) => !(/screenshot/i.test(entry) && /localization/i.test(entry)),
      );
  },
  "set by set and localization by localization",
);

rejects(
  "the caveat kept, but narrowed until it no longer names the localization axis",
  (p) => {
    const observation = p.appStoreConnectObservation;
    const index = observation.notObserved.findIndex(
      (entry) => /screenshot/i.test(entry) && /localization/i.test(entry),
    );
    observation.notObserved[index] =
      "Screenshot state read one device set at a time. The count above is the record's own.";
  },
  "set by set and localization by localization",
);

rejects(
  "the field reading re-expanded into the every-set-and-every-locale survey",
  (p) => {
    p.appStoreConnectObservation.observedFields[10].observed =
      "The record holds zero screenshots, across every set and every locale.";
  },
  "across every set or every locale",
);

rejects(
  "the same survey written with all-sets-and-all-locales wording",
  (p) => {
    p.appStoreConnectObservation.observedFields[10].observed =
      "Screenshots were read back empty in all sets and all localizations.";
  },
  "across every set or every locale",
);

rejects(
  "the survey asserted somewhere other than the reading it belongs to",
  (p) => {
    p.screenshots.blockedBy.push(
      "Confirmed at read-back: no screenshot is present in any localization of either set.",
    );
  },
  "across every set or every locale",
);

rejects(
  "the survey smuggled in as a next action rather than an observation",
  (p) => {
    p.appStoreConnectObservation.observedFields[10].nextAction =
      "Every set and every locale was verified empty, so capture them as the screenshots section specifies.";
  },
  "across every set or every locale",
);

// The other direction, and the reason the rule is three tokens rather than one:
// Apple's upload RULE quantifies over sets and localizations in every packet
// that states it. A guard that refused the word "localization" near the word
// "screenshot" would refuse the rule too, and the packet would be edited to
// stop stating it. The limit is not an observation and must stay sayable.
{
  const packet = clone();
  packet.screenshots.blockedBy.push(
    "Apple accepts one to ten screenshots per set, per localization, and each set is uploaded separately.",
  );
  accepts(
    "Apple's per-set, per-localization upload rule, which is a limit and not a reading",
    serialize(packet),
  );
}

// ── screenshots ──────────────────────────────────────────────────────────────

rejects(
  "a screenshot count claimed while the state says none were captured",
  (p) => {
    p.screenshots.capturedCount = 6;
  },
  "screenshots.capturedCount",
);

rejects(
  "an accepted iPhone size that is not one Apple accepts",
  (p) => {
    p.screenshots.sets[0].acceptedPortraitPixelSizes[0] = "1284x2778";
  },
  "must be exactly [1320x2868, 1290x2796, 1260x2736]",
);

rejects(
  "the iPad set losing one of its two accepted sizes",
  (p) => {
    p.screenshots.sets[1].acceptedPortraitPixelSizes.pop();
  },
  "must be exactly [2064x2752, 2048x2732]",
);

rejects(
  "a screenshot set nobody defined",
  (p) => {
    p.screenshots.sets[1].id = "ipad-12.9";
  },
  "declares an unknown set 'ipad-12.9'",
);

rejects(
  "a pixel size that is not a pixel size",
  (p) => {
    p.screenshots.sets[0].acceptedPortraitPixelSizes[1] = "1290 x 2796";
  },
  "does not match",
);

rejects(
  "the alpha-channel ban being lifted",
  (p) => {
    p.screenshots.rules.alphaChannelAllowed = true;
  },
  "screenshots.rules.alphaChannelAllowed",
);

rejects(
  "the false signed-IPA capture requirement coming back",
  (p) => {
    p.screenshots.capture.signedIpaRequired = true;
  },
  "screenshots.capture.signedIpaRequired",
);

rejects(
  "the DEBUG-fixture ban being lifted",
  (p) => {
    p.screenshots.capture.uiTestFixturesForbidden = false;
  },
  "screenshots.capture.uiTestFixturesForbidden",
);

rejects(
  "a Debug capture becoming acceptable",
  (p) => {
    p.screenshots.capture.requiredConfiguration = "Debug";
  },
  "screenshots.capture.requiredConfiguration",
);

// ── the Accessibility Nutrition Label ────────────────────────────────────────

rejects(
  "a feature claimed while the label is unassessed",
  (p) => {
    p.accessibilityNutritionLabel.deviceFamilies[0].features[0].claimed = true;
  },
  "accessibilityNutritionLabel.deviceFamilies[0].features[0].claimed",
);

rejects(
  "Sufficient Contrast claimed while the per-device-family assessment is unperformed",
  (p) => {
    const family = p.accessibilityNutritionLabel.deviceFamilies[1];
    const feature = family.features.find((entry) => entry.id === "sufficient-contrast");
    feature.claimed = true;
    feature.assessment = "passes";
  },
  "features[3].claimed: must be false",
);

rejects(
  "the per-family contrast blocker being quietly dropped",
  (p) => {
    for (const family of p.accessibilityNutritionLabel.deviceFamilies) {
      for (const feature of family.features) delete feature.blocker;
    }
  },
  "sufficient-contrast must carry its known blocker",
);

rejects(
  "the label state advancing while nothing has been tested",
  (p) => {
    p.accessibilityNutritionLabel.state = "assessed";
  },
  "accessibilityNutritionLabel.state",
);

rejects(
  "a device family disappearing",
  (p) => {
    p.accessibilityNutritionLabel.deviceFamilies.pop();
  },
  "fewer than the required 2",
);

rejects(
  "iPad losing a feature row",
  (p) => {
    p.accessibilityNutritionLabel.deviceFamilies[1].features =
      p.accessibilityNutritionLabel.deviceFamilies[1].features.filter((entry) => entry.id !== "voice-over");
  },
  "is missing 'voice-over'",
);

rejects(
  "a feature row nobody defined",
  (p) => {
    p.accessibilityNutritionLabel.deviceFamilies[0].features[8].id = "haptics";
  },
  "must be one of voice-over",
);

// ── the raw document, before JSON.parse gets to normalize it ─────────────────

rejectsRaw(
  "a duplicate object key JSON.parse would silently collapse",
  (text) =>
    text.replace(
      '    "subtitle": "End-to-end encrypted transfer",',
      '    "subtitle": "End-to-end encrypted transfer",\n      "subtitle": "Encrypted transfer",',
    ),
  "duplicate object key",
);

rejectsRaw(
  "a __proto__ key",
  (text) => text.replace('  "schemaVersion": 1,', '  "__proto__": {},\n  "schemaVersion": 1,'),
  "is refused outright",
);

rejectsRaw(
  "a UTF-8 BOM",
  (text) => `﻿${text}`,
  "starts with a UTF-8 BOM",
);

rejectsRaw(
  "CRLF line endings",
  (text) => text.replace(/\n/g, "\r\n"),
  "contains a carriage return",
);

rejectsRaw(
  "a tab in the indentation",
  (text) => text.replace('  "schemaVersion": 1,', '\t"schemaVersion": 1,'),
  "contains a tab",
);

rejectsRaw(
  "a missing final newline",
  (text) => text.replace(/\n$/, ""),
  "does not end with a newline",
);

rejectsRaw(
  "a document that is not JSON at all",
  (text) => `${text.slice(0, 200)}`,
  "is not valid JSON",
);

rejectsRaw(
  "a top-level array instead of an object",
  () => "[]\n",
  "must be an object, not an array",
);

// ── the draft App Privacy graph ──────────────────────────────────────────────
//
// The packet carries the answers somebody will type into App Store Connect, and
// they must be exactly what the app ships. Every case below is a way that list
// goes wrong while remaining well-formed JSON that passes every other rule —
// which is the whole problem with a privacy label: nothing at runtime, in a
// build, or at upload notices.
//
// The other direction — the validator's pin against the manifest the app
// actually ships — is exercised further down, under "the manifest itself".

rejects(
  "a collected-data type missing from the App Privacy graph",
  (p) => {
    p.appPrivacy.collected = p.appPrivacy.collected.filter(
      (entry) => entry.type !== "NSPrivacyCollectedDataTypeOtherUsageData",
    );
  },
  "appPrivacy.collected",
);

rejects(
  "DeviceID added to the App Privacy graph",
  (p) => {
    p.appPrivacy.collected[4] = {
      type: "NSPrivacyCollectedDataTypeDeviceID",
      linked: true,
      tracking: false,
      purposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
      basis: "A parity-minded edit that copied the macOS entry across.",
    };
  },
  "NSPrivacyCollectedDataTypeDeviceID",
);

rejects(
  "the App Privacy graph reordered against the shipped manifest",
  (p) => {
    p.appPrivacy.collected.reverse();
  },
  "the order matches the shipped manifest",
);

rejects(
  "the identifier-free aggregate declared as linked to the account",
  (p) => {
    p.appPrivacy.collected[5].linked = true;
  },
  "appPrivacy.collected[5].linked",
);

rejects(
  "an account-linked type declared as unlinked",
  (p) => {
    p.appPrivacy.collected[1].linked = false;
  },
  "appPrivacy.collected[1].linked",
);

rejects(
  "a collected type declared as tracking",
  (p) => {
    p.appPrivacy.collected[1].tracking = true;
  },
  "appPrivacy.collected[1].tracking",
);

rejects(
  "a wrong purpose on a linked type",
  (p) => {
    p.appPrivacy.collected[0].purposes = ["NSPrivacyCollectedDataTypePurposeAnalytics"];
  },
  "appPrivacy.collected[0].purposes",
);

rejects(
  "the aggregate declared for App Functionality instead of Analytics",
  (p) => {
    p.appPrivacy.collected[5].purposes = ["NSPrivacyCollectedDataTypePurposeAppFunctionality"];
  },
  "appPrivacy.collected[5].purposes",
);

rejects(
  "a second purpose nobody justified",
  (p) => {
    p.appPrivacy.collected[0].purposes = [
      "NSPrivacyCollectedDataTypePurposeAppFunctionality",
      "NSPrivacyCollectedDataTypePurposeAnalytics",
    ];
  },
  "appPrivacy.collected[0].purposes",
);

rejects(
  "the recorded reason for DeviceID's absence removed",
  (p) => {
    p.appPrivacy.deliberatelyAbsent = p.appPrivacy.deliberatelyAbsent.filter(
      (entry) => entry.type !== "NSPrivacyCollectedDataTypeDeviceID",
    );
  },
  "appPrivacy.deliberatelyAbsent",
);

rejects(
  "the Share extension claiming to collect something",
  (p) => {
    p.appPrivacy.shareExtension.collected = ["NSPrivacyCollectedDataTypeEmailAddress"];
  },
  "appPrivacy.shareExtension.collected",
);

rejects(
  "the tracking answer flipped to true",
  (p) => {
    p.appPrivacy.tracking = true;
  },
  "appPrivacy.tracking",
);

rejects(
  "a tracking domain named",
  (p) => {
    p.appPrivacy.trackingDomains = ["https://relayium.com/"];
  },
  "appPrivacy.trackingDomains",
);

// The state fields, which are what keep this a DRAFT. A packet that claimed the
// answers were entered would be making a provider-state claim nothing here has
// observed — the same failure the subscriptions section is pinned against.
rejects(
  "an App Privacy section claiming App Store Connect state was observed",
  (p) => {
    p.appPrivacy.observedAppStoreConnectState = true;
  },
  "appPrivacy.observedAppStoreConnectState",
);

rejects(
  "an App Privacy section claiming the answers are live",
  (p) => {
    p.appPrivacy.state = "entered-in-app-store-connect";
  },
  "appPrivacy.state",
);

rejects(
  "the App Privacy source of truth repointed away from the shipped manifest",
  (p) => {
    p.appPrivacy.sourceOfTruth = "docs/ios-app-store-submission.md";
  },
  "appPrivacy.sourceOfTruth",
);

// ── the stored-link controls the app actually ships ──────────────────────────
//
// `SendView` offers an expiry picker and a delete-after-first-download toggle.
// There is no download-count field, and the storefront copy claimed one.

rejects(
  "an English download-limit claim",
  (p) => {
    p.storefront["en-US"].description = p.storefront["en-US"].description.replace(
      "You choose when the link expires, and you can have it delete itself after the first download.",
      "with your own expiry and download limits.",
    );
  },
  "a download-limit claim",
);

rejects(
  "a Chinese download-count claim",
  (p) => {
    p.storefront["zh-Hans"].description = p.storefront["zh-Hans"].description.replace(
      "有效期由你自己定，也可以选择首次下载后即删除。",
      "有效期和下载次数由你自己定。",
    );
  },
  "'下载次数' (download count)",
);

rejects(
  "an English description that drops the stored-link controls entirely",
  (p) => {
    p.storefront["en-US"].description = p.storefront["en-US"].description.replace(
      "You choose when the link expires, and you can have it delete itself after the first download.",
      "Pick it up whenever.",
    );
  },
  "when the link expires",
);

rejects(
  "a Chinese description that drops the stored-link controls entirely",
  (p) => {
    p.storefront["zh-Hans"].description = p.storefront["zh-Hans"].description.replace(
      "有效期由你自己定，也可以选择首次下载后即删除。",
      "稍后来取即可。",
    );
  },
  "有效期由你自己定",
);

// ── the manifest itself ──────────────────────────────────────────────────────
//
// Everything above mutates the PACKET. This section mutates the file Apple
// actually reads, which is the half that used to be untested — and untestable,
// while the only way to reach it was to edit the product's own manifest.
//
// It is reachable now because the validator resolves the two manifests relative
// to ITS OWN location. So each case builds a throwaway repository under the
// temporary directory — a copy of the validator in `scripts/`, a copy of each
// manifest under `apps/ios/` — mutates one manifest inside that copy, and runs
// the copied validator against the REAL shipped packet. Nothing in
// `apps/ios/` is written to, and the shipped packet is only ever read.
//
// The first case is the control, and it is not decoration: it proves the
// fixture is a faithful copy. Without it, every red below could be the fixture
// being broken rather than the mutation being caught, and a validator that
// rejected any temporary repository outright would look like a complete suite.
//
// Each mutation below is one the previous text scan could not see. That scan
// collected the ordered list of type NAMES, so a flipped linked flag, a swapped
// purpose, a repeated key, an extra key and a tracking answer turned on all left
// it green while the manifest and the packet described different labels.

const APP_MANIFEST_PATH = join("apps", "ios", "Relayium", "PrivacyInfo.xcprivacy");
const SHARE_MANIFEST_PATH = join("apps", "ios", "RelayiumShare", "PrivacyInfo.xcprivacy");
const shippedAppManifest = readFileSync(join(repoRoot, APP_MANIFEST_PATH), "utf8");
const shippedShareManifest = readFileSync(join(repoRoot, SHARE_MANIFEST_PATH), "utf8");

/** One collected-data entry's `<dict>`, located by the type it declares.
 *
 *  The comments are what make this need care: the manifest argues about
 *  `NSPrivacyCollectedDataTypeDeviceID` and about Analytics in prose, so a
 *  mutation applied to the whole file could land in an explanation. Anchoring on
 *  the `<string>` element and widening to the enclosing `<dict>` keeps every
 *  edit inside markup. */
function inEntry(text, type, pattern, replacement) {
  const anchor = text.indexOf(`<string>${type}</string>`);
  if (anchor === -1) throw new Error(`the fixture manifest declares no ${type}`);
  const start = text.lastIndexOf("<dict>", anchor);
  const end = text.indexOf("</dict>", anchor) + "</dict>".length;
  const block = text.slice(start, end);
  const mutated = block.replace(pattern, replacement);
  if (mutated === block) throw new Error(`the mutation did not apply inside the ${type} entry`);
  return text.slice(0, start) + mutated + text.slice(end);
}

/** The whole `<dict>` for one entry, so a case can duplicate or move it. */
function entryBlock(text, type) {
  const anchor = text.indexOf(`<string>${type}</string>`);
  const start = text.lastIndexOf("<dict>", anchor);
  const end = text.indexOf("</dict>", anchor) + "</dict>".length;
  return text.slice(start, end);
}

let fixtureRepo = 0;
/** A throwaway repository holding the two manifest texts, and one run of the
 *  copied validator inside it. `null` means "do not write this manifest at
 *  all", which is the one failure a text mutation cannot express. */
function runInFixture({ appText = shippedAppManifest, shareText = shippedShareManifest } = {}) {
  fixtureRepo += 1;
  const root = join(work, `repo-${fixtureRepo}`);
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "apps", "ios", "Relayium"), { recursive: true });
  mkdirSync(join(root, "apps", "ios", "RelayiumShare"), { recursive: true });
  copyFileSync(validator, join(root, "scripts", "ios-app-store-metadata-validate.mjs"));
  if (appText !== null) writeFileSync(join(root, APP_MANIFEST_PATH), appText);
  if (shareText !== null) writeFileSync(join(root, SHARE_MANIFEST_PATH), shareText);
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts", "ios-app-store-metadata-validate.mjs"),
     "--packet", shippedPacketPath, "--quiet"],
    { encoding: "utf8" },
  );
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * One manifest mutation, required to be caught.
 *
 * The same no-op guard the packet cases carry, and it earns its place here for
 * a sharper reason: these mutations are `String.replace` calls against
 * TAB-INDENTED XML. A search string whose whitespace does not match the file
 * replaces nothing, the fixture is written pristine, and the case would
 * otherwise report "exited 0" — a rule that looks missing when it is the test
 * that is broken.
 */
function manifestRejects(label, { app, share, omitApp = false }, expected) {
  cases += 1;
  let appText;
  let shareText;
  try {
    if (omitApp) appText = null;
    else if (app) appText = app(shippedAppManifest);
    if (share) shareText = share(shippedShareManifest);
  } catch (error) {
    bad(label, `the fixture could not be built: ${error.message}`);
    return;
  }
  if (appText === shippedAppManifest || shareText === shippedShareManifest) {
    bad(label, "the manifest mutation was a no-op; the rule it targets was never exercised");
    return;
  }
  assertRejected(label, runInFixture({ appText, shareText }), expected);
}

cases += 1;
{
  // The control. An unmutated copy must behave exactly like the real tree.
  const { status, out } = runInFixture();
  if (status !== 0) {
    bad("an unmutated manifest fixture passes",
        `exited ${status}; the fixture is not a faithful copy and every case below is meaningless. ` +
        `output: ${out.trim().split("\n").slice(0, 6).join(" | ")}`);
  } else {
    ok("an unmutated manifest fixture passes");
  }
}

manifestRejects(
  "the manifest linking the identifier-free aggregate to the account",
  {
    app: (text) =>
      inEntry(text, "NSPrivacyCollectedDataTypeProductInteraction",
              /(<key>NSPrivacyCollectedDataTypeLinked<\/key>\s*)<false\/>/, "$1<true/>"),
  },
  "linked=true",
);

manifestRejects(
  "the manifest unlinking an account-linked type",
  {
    app: (text) =>
      inEntry(text, "NSPrivacyCollectedDataTypeEmailAddress",
              /(<key>NSPrivacyCollectedDataTypeLinked<\/key>\s*)<true\/>/, "$1<false/>"),
  },
  "linked=false",
);

manifestRejects(
  "the manifest declaring a collected type as tracking",
  {
    app: (text) =>
      inEntry(text, "NSPrivacyCollectedDataTypeName",
              /(<key>NSPrivacyCollectedDataTypeTracking<\/key>\s*)<false\/>/, "$1<true/>"),
  },
  "tracking=true",
);

manifestRejects(
  "the manifest moving the aggregate from Analytics to App Functionality",
  {
    app: (text) =>
      inEntry(text, "NSPrivacyCollectedDataTypeProductInteraction",
              "NSPrivacyCollectedDataTypePurposeAnalytics",
              "NSPrivacyCollectedDataTypePurposeAppFunctionality"),
  },
  "NSPrivacyCollectedDataTypeProductInteraction(linked=false, tracking=false, " +
    "purposes=[NSPrivacyCollectedDataTypePurposeAppFunctionality])",
);

manifestRejects(
  "the manifest growing a second purpose nobody justified",
  {
    app: (text) =>
      inEntry(text, "NSPrivacyCollectedDataTypeUserID",
              "<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>",
              "<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>" +
              "<string>NSPrivacyCollectedDataTypePurposeAnalytics</string>"),
  },
  "does not match the shipped manifest",
);

manifestRejects(
  "the manifest declaring the same purpose twice",
  {
    app: (text) =>
      inEntry(text, "NSPrivacyCollectedDataTypeUserID",
              "<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>",
              "<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>" +
              "<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>"),
  },
  "repeats a purpose",
);

manifestRejects(
  "the manifest declaring an entry key twice",
  {
    app: (text) =>
      inEntry(text, "NSPrivacyCollectedDataTypeName",
              /(<key>NSPrivacyCollectedDataTypeLinked<\/key>\s*<true\/>)/,
              "$1<key>NSPrivacyCollectedDataTypeLinked</key><false/>"),
  },
  "declares the key 'NSPrivacyCollectedDataTypeLinked' twice",
);

manifestRejects(
  "the manifest carrying a fifth key on an entry",
  {
    app: (text) =>
      inEntry(text, "NSPrivacyCollectedDataTypeName",
              /(<key>NSPrivacyCollectedDataTypeLinked<\/key>\s*<true\/>)/,
              "$1<key>NSPrivacyCollectedDataTypeNotes</key><string>whatever</string>"),
  },
  "is not the shape Apple defines",
);

manifestRejects(
  "the manifest declaring the same data type twice",
  {
    app: (text) =>
      text.replace(entryBlock(text, "NSPrivacyCollectedDataTypeUserID"),
                   `${entryBlock(text, "NSPrivacyCollectedDataTypeUserID")}\n${entryBlock(text, "NSPrivacyCollectedDataTypeUserID")}`),
  },
  "declares 'NSPrivacyCollectedDataTypeUserID' more than once",
);

manifestRejects(
  "the manifest adding DeviceID for parity with macOS",
  {
    app: (text) =>
      text.replace(entryBlock(text, "NSPrivacyCollectedDataTypeName"),
                   `${entryBlock(text, "NSPrivacyCollectedDataTypeName")}
		<dict>
			<key>NSPrivacyCollectedDataType</key>
			<string>NSPrivacyCollectedDataTypeDeviceID</string>
			<key>NSPrivacyCollectedDataTypeLinked</key>
			<true/>
			<key>NSPrivacyCollectedDataTypeTracking</key>
			<false/>
			<key>NSPrivacyCollectedDataTypePurposes</key>
			<array>
				<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
			</array>
		</dict>`),
  },
  "NSPrivacyCollectedDataTypeDeviceID",
);

manifestRejects(
  "the manifest dropping an entry the packet declares",
  {
    app: (text) => text.replace(entryBlock(text, "NSPrivacyCollectedDataTypeOtherUsageData"), ""),
  },
  "but apps/ios/Relayium/PrivacyInfo.xcprivacy declares 5",
);

manifestRejects(
  "the manifest reordering its entries",
  {
    app: (text) => {
      const first = entryBlock(text, "NSPrivacyCollectedDataTypeName");
      const second = entryBlock(text, "NSPrivacyCollectedDataTypeEmailAddress");
      return text.replace(first, " FIRST ").replace(second, first).replace(" FIRST ", second);
    },
  },
  "does not match the shipped manifest",
);

manifestRejects(
  "the manifest turning the label-level tracking answer on",
  {
    app: (text) => text.replace("<key>NSPrivacyTracking</key>\n\t<false/>",
                                "<key>NSPrivacyTracking</key>\n\t<true/>"),
  },
  "declares NSPrivacyTracking true",
);

manifestRejects(
  "the manifest naming a tracking domain",
  {
    app: (text) => text.replace("<key>NSPrivacyTrackingDomains</key>\n\t<array/>",
                                "<key>NSPrivacyTrackingDomains</key>\n\t<array><string>relayium.com</string></array>"),
  },
  "appPrivacy.trackingDomains",
);

manifestRejects(
  "the manifest carrying an unknown top-level key",
  {
    app: (text) => text.replace("<key>NSPrivacyTracking</key>",
                                "<key>NSPrivacyCollectsEverything</key><true/><key>NSPrivacyTracking</key>"),
  },
  "declares the unknown top-level key",
);

manifestRejects(
  "a manifest this validator cannot read exactly",
  { app: (text) => text.replace("</string>\n\t\t\t<key>NSPrivacyCollectedDataTypeLinked</key>", "\n\t\t\t<key>NSPrivacyCollectedDataTypeLinked</key>") },
  "appPrivacy.sourceOfTruth",
);

manifestRejects(
  "an empty manifest file",
  { app: () => "" },
  "does not open with a <plist> element",
);

manifestRejects(
  "a manifest that is not there at all",
  { omitApp: true },
  "could not be read",
);

manifestRejects(
  "the Share extension's manifest declaring a collected type",
  {
    share: (text) => text.replace("<key>NSPrivacyCollectedDataTypes</key>\n\t<array/>",
                                  `<key>NSPrivacyCollectedDataTypes</key>
	<array>
		<dict>
			<key>NSPrivacyCollectedDataType</key>
			<string>NSPrivacyCollectedDataTypeEmailAddress</string>
			<key>NSPrivacyCollectedDataTypeLinked</key>
			<true/>
			<key>NSPrivacyCollectedDataTypeTracking</key>
			<false/>
			<key>NSPrivacyCollectedDataTypePurposes</key>
			<array>
				<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
			</array>
		</dict>
	</array>`),
  },
  "appPrivacy.shareExtension.collected",
);

manifestRejects(
  "the Share extension's manifest turning tracking on",
  {
    share: (text) => text.replace("<key>NSPrivacyTracking</key>\n\t<false/>",
                                  "<key>NSPrivacyTracking</key>\n\t<true/>"),
  },
  "the appex tracks nothing",
);

manifestRejects(
  "the Share extension's manifest dropping its collected-data claim",
  { share: (text) => text.replace("<key>NSPrivacyCollectedDataTypes</key>\n\t<array/>", "") },
  "declares no NSPrivacyCollectedDataTypes",
);

// ── the CLI contract ─────────────────────────────────────────────────────────

cases += 1;
{
  const result = spawnSync(process.execPath, [validator, "--packet", join(work, "nothing-here.json")], {
    encoding: "utf8",
  });
  if (result.status !== 2) bad("an unreadable packet exits 2", `exited ${result.status}`);
  else ok("an unreadable packet exits 2");
}

cases += 1;
{
  const result = spawnSync(process.execPath, [validator, "--nonsense"], { encoding: "utf8" });
  if (result.status !== 2) bad("an unknown option exits 2", `exited ${result.status}`);
  else ok("an unknown option exits 2");
}

// ── report ───────────────────────────────────────────────────────────────────

process.stdout.write(`\n${cases} cases, ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
