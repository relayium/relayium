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
// Nothing here reads a credential, contacts a network or observes App Store
// Connect. The fixtures live under a temporary directory that is removed on the
// way out, and the shipped packet is only ever read.
//
// USAGE: node scripts/test/ios-app-store-metadata-validate-test.mjs
// EXIT   0 every case behaved; 1 at least one did not

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
accepts("the shipped packet passes against its own declared version", shippedRaw, ["--expect-version", "0.3.0"]);

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

rejects(
  "an in-app purchase display name of one character",
  (p) => {
    p.subscriptions.products[0].localizations["en-US"].displayName = "R";
  },
  "under Apple's minimum of 2",
);

rejects(
  "an in-app purchase display name over 30 characters",
  (p) => {
    p.subscriptions.products[0].localizations["en-US"].displayName = "Relayium Plus Monthly Subscription";
  },
  "over Apple's limit of 30",
);

rejects(
  "an in-app purchase description over 45 characters",
  (p) => {
    p.subscriptions.products[3].localizations["en-US"].description =
      "The Relayium Pro plan, billed once every year.";
  },
  "over Apple's limit of 45",
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

rejects(
  "a product localization locale that has gone missing",
  (p) => {
    delete p.subscriptions.products[2].localizations["zh-Hans"];
  },
  "subscriptions.products[2].localizations.zh-Hans",
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
    p.record.bundleId = "com.relayium.mac";
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
  "not the '0.3.0' this packet was written for",
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

rejects(
  "a product reusing a macOS identifier",
  (p) => {
    p.subscriptions.products[0].productId = "com.relayium.mac.plus.monthly";
  },
  "reuses a macOS identifier",
);

rejects(
  "a product identifier that does not match its own plan and cycle",
  (p) => {
    p.subscriptions.products[1].cycle = "monthly";
  },
  "must be 'com.relayium.app.plus.monthly' for the plus monthly row",
);

rejects(
  "the subscription group losing its Chinese display name",
  (p) => {
    delete p.subscriptions.group.localizations["zh-Hans"];
  },
  "subscriptions.group.localizations.zh-Hans",
);

rejects(
  "the first-submission requirement being switched off",
  (p) => {
    p.subscriptions.submittedWithAppVersion = false;
  },
  "subscriptions.submittedWithAppVersion",
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

rejects(
  "a bare decimal price in a product description",
  (p) => {
    p.subscriptions.products[0].localizations["en-US"].description = "Relayium Plus, 1.99 monthly.";
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

// ── nothing claims live App Store Connect state ──────────────────────────────

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

rejects(
  "the product identifiers being promoted from proposal to fact",
  (p) => {
    p.subscriptions.productIdentifiersAreProposedDrafts = false;
  },
  "subscriptions.productIdentifiersAreProposedDrafts",
);

rejects(
  "the owner-confirmation requirement disappearing",
  (p) => {
    delete p.subscriptions.ownerConfirmationRequired;
  },
  "subscriptions.ownerConfirmationRequired: is missing",
);

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
