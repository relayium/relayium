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

import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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

// The round's identities. Round 2 of the real schedule plans the browser
// INITIATOR: its id is the smaller of the pair. The wire history is what the
// browser half records — metadata only — and it shows the initiator's side of
// the exchange: the Android responder ASKED, the browser OFFERED.
const SELF = "0222222222222222";
const PEER = "f222222222222222";
const sig = (dir, kind, peer = PEER) => ({ dir, kind, peer });
const initiatorWire = () => ({
  sockets: [{
    path: "/ws",
    welcomes: [SELF],
    rosters: [[SELF], [SELF, PEER], [SELF]],
    lefts: [PEER],
    signals: [sig("in", "request"), sig("in", "request"), sig("out", "offer"), sig("in", "answer"),
              sig("out", "other"), sig("in", "other")],
  }],
});

const baseBrowser = () => ({
  origin: "http://127.0.0.1:1",
  reachedWorkspace: true,
  sas: "705955",
  role: "initiator",
  selfId: SELF,
  peerId: PEER,
  round: "2",
  wire: initiatorWire(),
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
  round: "2",
  plannedRole: "initiator",
  expectedBrowserId: SELF,
  expectedAndroidId: PEER,
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
  return oracleRun(paths);
}
function oracleRun(args) {
  const out = spawnSync("python3", [oracle, ...args], { encoding: "utf8" });
  return { status: out.status, stderr: out.stderr ?? "" };
}
/** A negative control counts only when the oracle refused for ITS reason. */
const refusedFor = (got, reason) => got.status === 1 && reason.test(got.stderr);

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

// ── 3. who played which role: planned, assigned, and played ────────────────
//
// The browser's own `role` field is that file's arithmetic. Each mutant below
// keeps it (or breaks only the evidence) and must be refused for its OWN
// reason — the welcome, the rosters, the schedule, or the wire's direction.

const responderWorld = () => {
  const browser = fresh(baseBrowser);
  const expect = fresh(baseExpect);
  const self = "f111111111111111";
  const peer = "0111111111111111";
  Object.assign(browser, { role: "responder", selfId: self, peerId: peer, round: "1" });
  browser.wire = {
    sockets: [{
      path: "/ws", welcomes: [self], rosters: [[self], [peer, self], [self]], lefts: [peer],
      signals: [sig("out", "request", peer), sig("in", "offer", peer), sig("out", "answer", peer),
                sig("in", "other", peer)],
    }],
  };
  Object.assign(expect, { round: "1", plannedRole: "responder", expectedBrowserId: self, expectedAndroidId: peer });
  return { browser, android: fresh(baseAndroid), expect };
};
{
  const w = responderWorld();
  const got = run(w.browser, w.android, w.expect);
  check(got.status === 0, `a correct RESPONDER round must be ACCEPTED, but the oracle exited ${got.status}:\n${got.stderr}`);
  check(/browser f111111111111111 \(planned f111111111111111\), Android 0111111111111111/.test(got.stderr),
    `the accepted round did not print its real and planned ids:\n${got.stderr}`);
}

const OTHER = "0333333333333333";
const sock = (w) => w.browser.wire.sockets[0];
const IDENTITY_MUTANTS = [
  ["the browser's welcome never arrived", /saw 0 welcomes/, (w) => { sock(w).welcomes = []; }],
  ["the browser was welcomed twice", /saw 2 welcomes/, (w) => { sock(w).welcomes.push(SELF); }],
  ["the page reconnected (a second socket)", /opened 2 websockets/,
    (w) => { w.browser.wire.sockets.push(structuredClone(sock(w))); }],
  ["the welcome named another round's id", /welcomed the browser as f333333333333333/,
    (w) => { sock(w).welcomes = ["f333333333333333"]; }],
  ["both clients planned the SAME id", /planned the SAME id/, (w) => { w.expect.expectedAndroidId = SELF; }],
  ["a foreign peer joined the room", /named 2 peers besides/, (w) => { sock(w).rosters[1].push(OTHER); }],
  ["the Android peer left and came back", /left the roster and came back/,
    (w) => { sock(w).rosters = [[SELF], [SELF, PEER], [SELF], [SELF, PEER], [SELF]]; }],
  ["a roster omitted the browser itself", /omitted the browser's own id/, (w) => { sock(w).rosters[1] = [PEER]; }],
  ["the room's Android id is not the planned one (a foreign round)", /the room's Android id was f333333333333333/,
    (w) => {
      const s = sock(w);
      s.rosters = s.rosters.map((r) => r.map((i) => (i === PEER ? "f333333333333333" : i)));
      s.lefts = ["f333333333333333"];
      s.signals = s.signals.map((x) => ({ ...x, peer: "f333333333333333" }));
      w.browser.peerId = "f333333333333333";
    }],
  ["the wire contradicts the plan (role field kept, offers arrived)", /wire role 'responder' is not the planned 'initiator'/,
    (w) => { sock(w).signals = [sig("out", "request"), sig("in", "offer"), sig("out", "answer")]; }],
  ["offers crossed in both directions", /offers went in BOTH directions/,
    (w) => { sock(w).signals.push(sig("in", "offer")); }],
  ["no offer crossed at all", /no link offer crossed/,
    (w) => { sock(w).signals = sock(w).signals.filter((x) => x.kind !== "offer"); }],
  ["the initiator also asked (a request in the wrong direction)", /also sent 1 link request/,
    (w) => { sock(w).signals.push(sig("out", "request")); }],
  ["a signal went to a foreign peer", /not this round's Android peer/,
    (w) => { sock(w).signals.push(sig("out", "other", OTHER)); }],
  ["the round planned no role", /has no planned role/, (w) => { delete w.expect.plannedRole; }],
  ["the schedule's ids contradict its planned role", /the schedule is inconsistent/,
    (w) => { w.expect.plannedRole = "responder"; }],
  ["the browser's role field disagrees with the evidence", /report's role 'responder'/,
    (w) => { w.browser.role = "responder"; }],
  ["the browser report carries no wire history", /carries no wire history/, (w) => { delete w.browser.wire; }],
  ["the hub reported a foreign departure", /departure of '0333333333333333'/, (w) => { sock(w).lefts = [OTHER]; }],
  ["a signal record is malformed", /signal record is malformed/,
    (w) => { sock(w).signals.push({ dir: "sideways", kind: "offer", peer: PEER }); }],
  ["an id in the room is not lowercase hex", /Android id 'F222222222222222' is not 16 lowercase hex/,
    (w) => { sock(w).rosters = sock(w).rosters.map((r) => r.map((i) => (i === PEER ? "F222222222222222" : i))); }],
];
for (const [name, reason, mutate] of IDENTITY_MUTANTS) {
  const world = { browser: fresh(baseBrowser), android: fresh(baseAndroid), expect: fresh(baseExpect) };
  const before = JSON.stringify(world);
  mutate(world);
  check(JSON.stringify(world) !== before, `the identity mutation "${name}" changed nothing`);
  const got = run(world.browser, world.android, world.expect);
  check(refusedFor(got, reason),
    `the oracle did not refuse "${name}" for its own reason ${reason} (exit ${got.status}):\n${got.stderr}`);
}

// ── 4. the welcome barrier's receipt ────────────────────────────────────────

const NONCE = "0123456789abcdef0123456789abcdef";
const receiptBody = (over = {}) => JSON.stringify({
  round: "2", nonce: NONCE, selfId: SELF, expectedSelfId: SELF, sockets: 1, welcomes: 1, ...over,
}) + "\n";
let receipts = 0;
const receiptCase = (body, { mode = 0o600, args = ["2", NONCE, SELF], link = false } = {}) => {
  const p = join(dir, `welcome-${++receipts}.json`);
  if (body !== null) {
    if (link) {
      const target = join(dir, `welcome-target-${receipts}.json`);
      writeFileSync(target, body, { mode: 0o600 });
      symlinkSync(target, p);
    } else {
      writeFileSync(p, body, { mode: 0o600 });
      chmodSync(p, mode);
    }
  }
  return oracleRun(["ready-receipt", p, ...args]);
};
{
  const got = receiptCase(receiptBody());
  check(got.status === 0, `a correct welcome receipt must be ACCEPTED, but the oracle exited ${got.status}:\n${got.stderr}`);
}
for (const [name, reason, build] of [
  ["no receipt at all (the barrier never happened)", /is absent/, () => receiptCase(null)],
  ["a receipt readable by others", /mode 644, not 0600/, () => receiptCase(receiptBody(), { mode: 0o644 })],
  ["another run's nonce", /nonce is '/, () => receiptCase(receiptBody({ nonce: "f".repeat(32) }))],
  ["another round's receipt", /round is '1'/, () => receiptCase(receiptBody({ round: "1" }))],
  ["the browser was welcomed with another id", /selfId is 'f333333333333333'/,
    () => receiptCase(receiptBody({ selfId: "f333333333333333" }))],
  ["two sockets before the barrier", /sockets is 2/, () => receiptCase(receiptBody({ sockets: 2 }))],
  ["an extra field smuggled in", /carries fields/, () => receiptCase(receiptBody({ role: "initiator" }))],
  ["a half-written receipt", /unreadable or not JSON/, () => receiptCase(receiptBody().slice(0, 20))],
  ["a receipt with no final newline", /truncated/, () => receiptCase(receiptBody().trimEnd())],
  ["a symlink in place of the receipt", /not a regular file/, () => receiptCase(receiptBody(), { link: true })],
]) {
  const got = build();
  check(refusedFor(got, reason), `the receipt check did not refuse "${name}" for ${reason} (exit ${got.status}):\n${got.stderr}`);
}

// ── 5. every accepted websocket, counted — against the REAL producer ───────
//
// The log lines are rendered from `acceptancePeerIDLogFormat` as it stands in
// server/main.go, and the generator must log through that constant, so a drift
// between what the server writes and what the oracle parses fails here rather
// than as a red emulator run.

const mainGo = readFileSync(resolve(repoRoot, "server/main.go"), "utf8");
const formatMatch = /^const acceptancePeerIDLogFormat = "([^"\\]*)"$/m.exec(mainGo);
check(formatMatch !== null, "server/main.go no longer declares acceptancePeerIDLogFormat as one plain string");
check(mainGo.includes("\t\tlogf(acceptancePeerIDLogFormat, seq, id)\n"),
  "the generator in server/main.go no longer logs every invocation through acceptancePeerIDLogFormat");
const GO_FORMAT = formatMatch?.[1] ?? "";
check(GO_FORMAT.split("%d").length === 2 && GO_FORMAT.split("%s").length === 2
      && GO_FORMAT.indexOf("%d") < GO_FORMAT.indexOf("%s") && !/%[^ds]/.test(GO_FORMAT.replace(/%[ds]/g, "")),
  `acceptancePeerIDLogFormat ${JSON.stringify(GO_FORMAT)} is not one %d followed by one %s`);
/** Render one line exactly as Go's log.Printf would: the standard prefix, then the format. */
const render = (format, seq, id) => `2026/10/02 10:00:0${seq % 10} ` + format.replace("%d", String(seq)).replace("%s", id);

const SCHEDULE = ["f111111111111111", "0111111111111111", "0222222222222222",
                  "f222222222222222", "f333333333333333", "0333333333333333"];
const shellIds = /^acceptance_peer_ids="([^"\n]*)"$/m.exec(
  readFileSync(resolve(repoRoot, "scripts/android-interop-acceptance.sh"), "utf8"))?.[1];
check(shellIds === SCHEDULE.join(","),
  `the acceptance's schedule ${JSON.stringify(shellIds)} is not the one these controls exercise`);
const lineFor = (seq, format = GO_FORMAT) => render(format, seq, SCHEDULE[(seq - 1) % SCHEDULE.length]);
const logOf = (seqs, { format = GO_FORMAT, tail = "\n", extra = [] } = {}) => [
  "2026/10/02 10:00:00 relayium signaling server listening on 127.0.0.1:41234",
  ...seqs.map((seq) => lineFor(seq, format)),
  ...extra,
  "2026/10/02 10:00:09 shutting down",
].join("\n") + tail;
let logs = 0;
const logCase = (text, schedule = SCHEDULE.join(",")) => {
  const p = join(dir, `server-${++logs}.log`);
  writeFileSync(p, text);
  return oracleRun(["peer-id-log", p, schedule]);
};
for (const [name, text] of [
  ["six accepts in order", logOf([1, 2, 3, 4, 5, 6])],
  ["six concurrent accepts logged out of order", logOf([1, 2, 4, 3, 6, 5])],
]) {
  const got = logCase(text);
  check(got.status === 0, `the peer-id count must ACCEPT "${name}", but exited ${got.status}:\n${got.stderr}`);
  check(/accepted websocket seq=6 id=0333333333333333/.test(got.stderr), `"${name}" printed no seq/id table:\n${got.stderr}`);
}
for (const [name, reason, build] of [
  ["a scheduled socket was never accepted", /accepted 5 websocket\(s\), not exactly the 6/, () => logCase(logOf([1, 2, 3, 4, 5]))],
  ["a SEVENTH accept, whose id aliases the first", /accepted 7 websocket\(s\).*extra \[7\]/, () => logCase(logOf([1, 2, 3, 4, 5, 6, 7]))],
  ["TWELVE accepts, every id matching the cycle", /accepted 12 websocket\(s\)/,
    () => logCase(logOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))],
  ["a sequence number logged twice", /sequence 3 was logged twice/, () => logCase(logOf([1, 2, 3, 3, 4, 5, 6]))],
  ["a sequence carried the wrong id", /sequence 4 carried f111111111111111/,
    () => logCase(logOf([1, 2, 3, 5, 6], { extra: [render(GO_FORMAT, 4, "f111111111111111")] }))],
  ["a malformed marker line", /peer-id log line is malformed/,
    () => logCase(logOf([1, 2, 3, 4, 5, 6], { extra: ["2026/10/02 10:00:07 relayium-acceptance-peer-id seq=x id=?"] }))],
  ["an uppercase id", /peer-id log line is malformed/,
    () => logCase(logOf([1, 2, 3, 4, 5], { extra: [render(GO_FORMAT, 6, "0333333333333333".toUpperCase().replace("0", "A"))] }))],
  ["a zero sequence", /peer-id log line is malformed/,
    () => logCase(logOf([1, 2, 3, 4, 5, 6], { extra: [render(GO_FORMAT, 0, SCHEDULE[0])] }))],
  ["a log read while still being written", /does not end with a newline/, () => logCase(logOf([1, 2, 3, 4, 5, 6], { tail: "" }))],
  ["an empty log", /server log is empty/, () => logCase("")],
  ["a missing log", /server log is unreadable/, () => oracleRun(["peer-id-log", join(dir, "absent.log"), SCHEDULE.join(",")])],
  ["a schedule that repeats an id", /repeats an id/,
    () => logCase(logOf([1, 2, 3, 4, 5, 6]), [...SCHEDULE.slice(0, 5), SCHEDULE[0]].join(","))],
  ["the producer's format drifted from the parser", /peer-id log line is malformed/,
    () => logCase(logOf([1, 2, 3, 4, 5, 6], { format: GO_FORMAT.replace("seq=%d", "n=%d") }))],
]) {
  const got = build();
  check(refusedFor(got, reason), `the peer-id count did not refuse "${name}" for ${reason} (exit ${got.status}):\n${got.stderr}`);
}

if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`android-interop-oracle-test: ${failures.length} failure(s)`);
  process.exit(1);
}
console.error("android-interop-oracle-test: OK (4 positives — initiator, responder, receive-cancel, "
  + `send-cancel — plus 5 send-cancel negatives, ${MUTANTS.length} mutants, `
  + `${IDENTITY_MUTANTS.length} identity mutants, 10 receipt and 13 peer-id-log negatives, each refused for its reason)`);
