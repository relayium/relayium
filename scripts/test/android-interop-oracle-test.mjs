#!/usr/bin/env node
// scripts/test/android-interop-oracle-test.mjs — the interop acceptance's
// COMPARISON, judged.
//
// ## Why an oracle needs its own test
//
// `scripts/android-interop-acceptance.sh` runs two real clients and then
// decides whether they agreed. Everything expensive about that lane — an
// emulator, a Go server, a Web build, a real Chrome, real WebRTC — produces
// exactly one bit of value, and that bit is produced by the comparison. A
// comparison that cannot fail turns the whole lane into a very slow `true`.
//
// That is not hypothetical here. The first version of this oracle read
//
//     elif browser.get("receivedFileHex"):
//         ...compare the digest...
//
// so an observation in which the browser received NO bytes at all skipped the
// digest check entirely and passed — while the expected payload digest was
// non-empty. The `empty received payload` case below is that exact mutant, and
// it must be REJECTED.
//
// ## How it works
//
// One correct observation pair, then a mutation per rule. Every mutant must
// make the oracle exit non-zero, and the correct pair must make it exit zero.
// A mutation that stopped applying — because a field was renamed — would leave
// the observation unbroken and its case would pass for the wrong reason, so
// each mutation asserts that it actually CHANGED something first.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const oracle = resolve(repoRoot, "scripts/test/android-interop-oracle.py");

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

// ── a correct round ─────────────────────────────────────────────────────────
//
// Shaped exactly like a real one: a multi-entry inbound batch including a
// ZERO-byte file and one that crosses the 192 KiB fragment boundary, two
// outbound batches, both messages, and matching SAS digits.

const BIG = { name: "web-big.bin", size: 199_000, sha256: "a".repeat(64) };
const ZERO = { name: "web-zero.bin", size: 0, sha256: "b".repeat(64) };
const SMALL = { name: "web-small.bin", size: 1024, sha256: "c".repeat(64) };
const SECOND = { name: "web-second.bin", size: 4096, sha256: "d".repeat(64) };

// The Android→web payloads are compared by hashing the browser's own bytes, so
// these fixtures carry real hex and its real digest.
import { createHash } from "node:crypto";
const bytes = (size, seed) =>
  Buffer.from(Array.from({ length: size }, (_, i) => (i * 31 + seed) & 0xff));
const record = (name, size, seed) => {
  const buf = bytes(size, seed);
  return {
    want: { name, size, sha256: createHash("sha256").update(buf).digest("hex") },
    saw: { name, size, hex: buf.toString("hex") },
  };
};
// The android→web direction carries the SAME boundary payloads as inbound on
// an uncancelled round — a >192KiB body, a zero-byte file, a small one — plus
// a repeated batch. The browser saves the multi-entry batch through its
// directory path (observed per file by the ledger), so all four are compared
// by real per-file bytes.
const first = record("android-to-web.bin", 199_000, 5);
const zeroOut = record("zero-android-to-web.bin", 0, 0);
const smallOut = record("small-android-to-web.bin", 3072, 7);
const again = record("again-android-to-web.bin", 2048, 6);

const WEB_MESSAGE = "  web → android:\n\t你好 🌍   ";
const ANDROID_MESSAGE = "android → web: 端到端\tindented";
const POST_CANCEL = "android → web: after the cancel";

const baseBrowser = () => ({
  origin: "http://127.0.0.1:1",
  reachedWorkspace: true,
  sas: "705955",
  role: "initiator",
  verify: "on",
  receivedMessages: [WEB_MESSAGE, ANDROID_MESSAGE, "relayium-e2e:send-again", POST_CANCEL],
  receivedFiles: [first.saw, zeroOut.saw, smallOut.saw, again.saw],
  sentBatches: [[BIG.name, ZERO.name, SMALL.name], [SMALL.name]],
  sentDone: true,
  peerLeft: true,
});

const baseAndroid = () => ({
  origin: "http://10.0.2.2:4321",
  sas: "705955",
  linkId: 1,
  receivedMessage: WEB_MESSAGE,
  sentMessage: ANDROID_MESSAGE,
  postCancelMessage: POST_CANCEL,
  saved: [
    { name: BIG.name, size: BIG.size, sha256: BIG.sha256 },
    { name: ZERO.name, size: ZERO.size, sha256: ZERO.sha256 },
    { name: SMALL.name, size: SMALL.size, sha256: SMALL.sha256 },
  ],
  sent: [first.want, zeroOut.want, smallOut.want, again.want],
  sendCancelled: false,
  peerConfirmedDone: true,
  sentinelIntact: true,
  errorKey: null,
  cleanupIncomplete: false,
  treeBefore: ["sentinel-do-not-touch.txt"],
  treeAfter: ["sentinel-do-not-touch.txt", BIG.name, ZERO.name, SMALL.name],
});

const baseExpect = () => ({
  origin: "http://10.0.2.2:4321",
  verify: "on",
  cancel: "none",
  webMessage: WEB_MESSAGE,
  androidMessages: [ANDROID_MESSAGE, POST_CANCEL],
  androidSent: [first.want, zeroOut.want, smallOut.want, again.want],
  webSent: [BIG, ZERO, SMALL],
});

// ── the runner ──────────────────────────────────────────────────────────────

/**
 * Every builder returns a FRESH deep copy.
 *
 * The fixtures share nested objects (`first.saw` appears in the browser's
 * record and `first.want` in the expectation), and a mutation that reached
 * through to a shared object would corrupt every LATER case — turning "this
 * mutant was rejected" into "some earlier mutant was still in effect". The
 * mutation-actually-applied assertion below would not catch that, because the
 * mutation genuinely did apply; it applied too widely.
 */
const fresh = (build) => structuredClone(build());

const dir = mkdtempSync(join(tmpdir(), "android-oracle-test-"));
let n = 0;
function run(browser, android, expect) {
  const id = ++n;
  const paths = ["browser", "android", "expect"].map((what) => {
    const p = join(dir, `${what}-${id}.json`);
    writeFileSync(p, JSON.stringify({ browser, android, expect }[what], null, 2));
    return p;
  });
  const out = spawnSync("python3", [oracle, ...paths], { encoding: "utf8" });
  return { status: out.status, stderr: out.stderr ?? "" };
}

// ── 1. the correct round passes ─────────────────────────────────────────────

const positive = run(fresh(baseBrowser), fresh(baseAndroid), fresh(baseExpect));
check(positive.status === 0,
  `the correct observation pair must be ACCEPTED, but the oracle exited `
  + `${positive.status}:\n${positive.stderr}`);

// ── 1b. the two CANCEL round shapes also pass ───────────────────────────────
//
// The boundary-payload requirements are gated on `cancel == "none"`: a
// receive-cancel round discards the boundary-carrying first batch by design
// and completes a single-file retry. An ungated oracle would reject every
// correct cancel round — which is exactly what the acceptance would then
// report as an interop disagreement — so "a correct cancel round is accepted"
// is itself a rule under test here.

const receiveCancel = (() => {
  const browser = fresh(baseBrowser);
  const android = fresh(baseAndroid);
  const expect = fresh(baseExpect);
  expect.cancel = "receive";
  expect.webSent = [SECOND];
  expect.androidMustNotSave = [BIG.name, SMALL.name];
  android.saved = [{ name: SECOND.name, size: SECOND.size, sha256: SECOND.sha256 }];
  android.treeAfterCancel = ["sentinel-do-not-touch.txt"];
  android.treeAfter = ["sentinel-do-not-touch.txt", SECOND.name];
  return run(browser, android, expect);
})();
check(receiveCancel.status === 0,
  `a correct receive-cancel round must be ACCEPTED, but the oracle exited `
  + `${receiveCancel.status}:\n${receiveCancel.stderr}`);

// A correct send-cancel round: the cancelled file is > FLOW_WINDOW; the
// browser held it, saw the peer's cancel, released, and committed only a
// strictly-smaller PARTIAL; a fresh small retry completed. The gate lifecycle
// is what proves the cancel was active and observed.
const CANCEL_FULL = 8 * 1024 * 1024 + 4096;
const retry = record("retry-android-to-web.bin", 2048, 10);
const partialForbidden = { name: "android-to-web.bin", size: 65536, hex: "ab".repeat(65536) };
const sendCancelBase = () => {
  const browser = fresh(baseBrowser);
  const android = fresh(baseAndroid);
  const expect = fresh(baseExpect);
  expect.cancel = "send";
  expect.androidSent = [retry.want];
  expect.browserMustNotSave = ["android-to-web.bin"];
  expect.cancelledFullSize = CANCEL_FULL;
  browser.receivedFiles = [retry.saw, partialForbidden];
  browser.forbiddenGate = { armed: true, writeHeld: true, cancelObserved: true, released: true };
  android.sent = [retry.want];
  android.sendCancelled = true;
  return { browser, android, expect };
};
const sendCancel = (() => {
  const { browser, android, expect } = sendCancelBase();
  return run(browser, android, expect);
})();
check(sendCancel.status === 0,
  `a correct send-cancel round must be ACCEPTED, but the oracle exited `
  + `${sendCancel.status}:\n${sendCancel.stderr}`);

// Send-cancel NEGATIVES: each must be rejected. A full-size forbidden save is
// the run7 failure; a missing gate step means the cancel was never active.
for (const [label, mutate] of [
  ["the cancelled file was saved at FULL size (run7)",
    (w) => { w.browser.receivedFiles[1] = { name: "android-to-web.bin", size: CANCEL_FULL, hex: "cd".repeat(CANCEL_FULL) }; }],
  ["the browser never held the cancelled write",
    (w) => { w.browser.forbiddenGate.writeHeld = false; }],
  ["the browser never observed the peer's cancel",
    (w) => { w.browser.forbiddenGate.cancelObserved = false; }],
  ["the browser never released the held write",
    (w) => { w.browser.forbiddenGate.released = false; }],
  ["the send-cancel round carries no gate at all",
    (w) => { delete w.browser.forbiddenGate; }],
]) {
  const w = sendCancelBase();
  mutate(w);
  const got = run(w.browser, w.android, w.expect);
  check(got.status !== 0,
    `the oracle ACCEPTED a broken send-cancel round: "${label}"`);
}

// ── 2. every rule, mutated ──────────────────────────────────────────────────

const MUTANTS = [
  {
    name: "empty received payload (the shipped false green)",
    // The exact mutation root reproduced: the browser received NOTHING while
    // the expected Android payload digest stays non-empty. The first version
    // of this oracle skipped its digest check on a falsy hex and passed.
    mutate: ({ browser }) => { browser.receivedFiles[0].hex = ""; browser.receivedFiles[0].size = 0; },
  },
  {
    name: "the received record loses its bytes field entirely",
    mutate: ({ browser }) => { delete browser.receivedFiles[0].hex; },
  },
  {
    name: "the browser completed no saves at all",
    mutate: ({ browser }) => { browser.receivedFiles = []; },
  },
  {
    name: "one byte of the received payload differs",
    mutate: ({ browser }) => {
      const hex = browser.receivedFiles[0].hex;
      browser.receivedFiles[0].hex = (hex[0] === "0" ? "1" : "0") + hex.slice(1);
    },
  },
  {
    name: "the size and the bytes disagree",
    mutate: ({ browser }) => { browser.receivedFiles[0].size += 1; },
  },
  {
    name: "Android saved different bytes than the browser sent",
    mutate: ({ android }) => { android.saved[0].sha256 = "f".repeat(64); },
  },
  {
    name: "Android saved a truncated file",
    mutate: ({ android }) => { android.saved[0].size = 10; },
  },
  {
    name: "Android saved nothing",
    mutate: ({ android }) => { android.saved = []; },
  },
  {
    name: "the zero-byte file is absent from the round",
    mutate: ({ android, expect }) => {
      android.saved = android.saved.filter((f) => f.size !== 0);
      expect.webSent = expect.webSent.filter((f) => f.size !== 0);
    },
  },
  {
    name: "nothing crossed the 192KiB fragment boundary",
    mutate: ({ android, expect }) => {
      android.saved = android.saved.filter((f) => f.size <= 196608);
      expect.webSent = expect.webSent.filter((f) => f.size <= 196608);
    },
  },
  {
    name: "the two clients derived different SAS digits",
    mutate: ({ android }) => { android.sas = "000000"; },
  },
  {
    name: "the browser derived no SAS on the path that shows one",
    mutate: ({ browser }) => { browser.sas = ""; },
  },
  {
    name: "the browser never saw the Android message",
    mutate: ({ browser }) => {
      browser.receivedMessages = browser.receivedMessages.filter((m) => m !== ANDROID_MESSAGE);
    },
  },
  {
    name: "the browser never saw the POST-CANCEL message",
    // The claim "text survives a cancelled transfer" must be about the PEER,
    // not about Android's own message list.
    mutate: ({ browser }) => {
      browser.receivedMessages = browser.receivedMessages.filter((m) => m !== POST_CANCEL);
    },
  },
  {
    name: "Android received a different message than the browser sent",
    mutate: ({ android }) => { android.receivedMessage = WEB_MESSAGE.trim(); },
  },
  {
    name: "the Android app resolved production instead of this run's server",
    mutate: ({ android }) => { android.origin = "https://relayium.com"; },
  },
  {
    name: "the browser never reached the workspace",
    mutate: ({ browser }) => { browser.reachedWorkspace = false; },
  },
  {
    name: "the round ended with an error the report carries",
    mutate: ({ android }) => { android.errorKey = "error_integrity"; },
  },
  {
    name: "the app reported an incomplete cleanup",
    mutate: ({ android }) => { android.cleanupIncomplete = true; },
  },
  {
    name: "a cancelled receive left its own file behind",
    mutate: ({ android, expect }) => {
      expect.cancel = "receive";
      expect.androidMustNotSave = [BIG.name];
      android.treeAfterCancel = ["sentinel-do-not-touch.txt", BIG.name];
      android.sentinelIntact = true;
    },
  },
  {
    name: "a cancelled receive's rollback damaged unrelated content",
    mutate: ({ android, expect }) => {
      expect.cancel = "receive";
      expect.androidMustNotSave = [BIG.name];
      android.treeAfterCancel = [];
      android.sentinelIntact = false;
    },
  },
  {
    name: "the send-cancel round never cancelled",
    mutate: ({ android, expect }) => { expect.cancel = "send"; android.sendCancelled = false; },
  },
  {
    name: "the browser completed a save the round cancelled",
    mutate: ({ expect }) => { expect.browserMustNotSave = [first.want.name]; },
  },
  {
    name: "the inbound batch has only one entry",
    mutate: ({ android, expect }) => {
      expect.webSent = [BIG];
      android.saved = android.saved.filter((f) => f.name === BIG.name);
    },
  },
  {
    name: "the android→web batch loses its boundary entries",
    // Zero-byte and multi-entry were once proved web→android ONLY while the
    // run's claim covered both directions; a plan that quietly drops the
    // outbound boundary payloads must be rejected, not narrower-but-green.
    mutate: ({ browser, android, expect }) => {
      const boundary = (f) => f.name === first.want.name;
      expect.androidSent = expect.androidSent.filter(boundary);
      android.sent = android.sent.filter(boundary);
      browser.receivedFiles = browser.receivedFiles.filter(boundary);
    },
  },
  {
    name: "nothing in the plan crosses 192KiB android→web",
    mutate: ({ browser, android, expect }) => {
      const under = (f) => f.size <= 196_608;
      expect.androidSent = expect.androidSent.filter(under);
      android.sent = android.sent.filter(under);
      browser.receivedFiles = browser.receivedFiles.filter(under);
    },
  },
  {
    name: "the browser never sent the terminal done handshake",
    // The done message is what keeps the Android Activity alive until the
    // browser has everything; a round that stopped sending it is one
    // regression away from the pilot that reported OK with a missing file.
    mutate: ({ browser }) => { browser.sentDone = false; },
  },
  {
    name: "the browser never observed the peer leave after done",
    mutate: ({ browser }) => { browser.peerLeft = false; },
  },
  {
    name: "Android closed without the browser's done confirmation",
    mutate: ({ android }) => { android.peerConfirmedDone = false; },
  },
  {
    name: "the Android report has no saved field at all",
    mutate: ({ android }) => { delete android.saved; },
  },
  {
    name: "the browser report has no receivedFiles field at all",
    mutate: ({ browser }) => { delete browser.receivedFiles; },
  },
];

for (const { name, mutate } of MUTANTS) {
  const world = {
    browser: fresh(baseBrowser), android: fresh(baseAndroid), expect: fresh(baseExpect),
  };
  const before = JSON.stringify(world);
  mutate(world);
  check(JSON.stringify(world) !== before,
    `the mutation "${name}" changed nothing. A mutation that stopped applying — because a `
    + `field was renamed — leaves the observation correct, and its case then passes for the `
    + `wrong reason.`);

  const got = run(world.browser, world.android, world.expect);
  check(got.status !== 0,
    `the oracle ACCEPTED the mutant "${name}". Every expensive thing this lane does produces `
    + `one bit, and that bit is this comparison; a rule that cannot reject is not a rule.`);
}

if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`android-interop-oracle-test: ${failures.length} failure(s)`);
  process.exit(1);
}
console.error("android-interop-oracle-test: OK (3 positives — plain, receive-cancel, "
  + `send-cancel — plus 5 send-cancel negatives and ${MUTANTS.length} mutants rejected)`);
