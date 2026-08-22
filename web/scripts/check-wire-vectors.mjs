#!/usr/bin/env node
// web/scripts/check-wire-vectors.mjs — the cross-language wire vectors are
// GENERATED, and this is the check that says so out loud.
//
//   node scripts/check-wire-vectors.mjs            # verify (npm run test:vectors)
//   node scripts/check-wire-vectors.mjs --write    # regenerate (npm run gen:vectors)
//
// ## What is actually being protected
//
// The fixtures under `apps/RelayiumKit/Tests/Fixtures/` are the only place the
// Swift and the TypeScript implementations of the same wire meet. The Swift
// tests (`RealtimeFrameTests`, `RealtimeFragmentationTests`,
// `LinkWebWorkspaceInteropTests`, `StoreKeyTests`, `KeyAgreementTests`, …) do
// not re-derive the bytes; they assert against these files, which were
// transcribed from `web/src/lib/transfer.ts`, `web/src/lib/store-crypto.ts` and
// `web/src/lib/crypto.ts` by the generators next to this script.
//
// That makes the fixtures a claim about the Web implementation that only the
// generator can substantiate — and nothing re-ran the generator. Change a frame
// header in `transfer.ts`, update the generator, forget to run it, and every
// Swift vector test still passes: it is being compared against the frozen bytes
// of the OLD wire, and the two implementations have silently diverged with a
// green board. The reverse rot is worse and quieter: hand-edit a fixture to make
// a red Swift test go green and the generator — the actual source of truth —
// never disagrees with anyone again.
//
// So this runs the generators and requires the tracked bytes to come back
// byte-identical. There is no assertion here about what the bytes MEAN; that is
// the Swift suites' job. The only claim is the one nothing else could make: the
// committed fixtures are what the current Web implementation produces.
//
// ## Why it runs the generators twice
//
// A generator that is not deterministic — a random key, a timestamp, an
// iteration order that depends on a hash seed — would turn this gate into an
// intermittent red that everybody learns to re-run. Two consecutive runs are
// compared to each other FIRST, so nondeterminism is reported as exactly that,
// once, instead of as a mysterious diff against a fixture that was fine.
//
// ## Why it always restores what it found
//
// In verify mode this must not be a command that edits your working tree as a
// side effect of asking a question — a failed check that also rewrites the file
// it is complaining about destroys the very evidence you need to read. The
// original bytes are restored on every path, including the throwing one, so
// verify mode is observably read-only and `--write` is the only way to change a
// fixture.
//
// ## Why `crypto-vectors.json` is in this table now
//
// It was excluded for as long as it had two authors. `gen-crypto-vectors.mjs`
// wrote most of it, but the `textKeys` block came from
// `web/src/lib/text-vectors.test.ts`, which PRINTS the block for a human to
// paste (commit b59fd94d, "text wire v1"), so running the generator DELETED a
// block `KeyAgreementTests.swift` reads and this gate would have been red for a
// reason that had nothing to do with drift.
//
// The generator now derives `textKeys` itself, from the same session keys and
// the same `relayium-text-v1\0` domain as `crypto.ts`, so the fixture has one
// author again and belongs here. `text-vectors.test.ts` still recomputes those
// keys through `crypto.ts` and asserts the committed values, which is the half
// this gate cannot do: this file proves the fixture is what the generator
// produces, that suite proves the generator agrees with the shipped web code.
//
// ## Why `device-inbox-manifest-v3-vectors.json` is here on different terms
//
// Nothing above is retracted; this fixture simply is not the same kind of
// object, and pretending it was would have kept it out of the gate forever.
//
// The three fixtures above are generated end to end — the generator invents the
// keys, the frames and the plaintexts, so there is nothing in the file a human
// wrote and "the generator is the only author" is trivially true. The
// device-inbox fixture is a HYBRID and always will be. Most of it is judgement
// that cannot be derived from anything: 55 documents that must be REFUSED and
// the named clause each must be refused under, 6 boundary cases the consumers
// build for themselves, and the item lists and case names of the accept
// vectors. Its own header says, correctly, that regenerating it from an
// implementation would make it agree with whatever that implementation
// currently does.
//
// But three fields inside each accept case are not judgement at all. Given the
// item list, `canonical`, `kind` and `total` are a pure function of the
// protocol — and `canonical` is the single most dangerous string in the whole
// file, because all three implementations assert AGAINST it rather than
// re-deriving it. A mistyped canonical byte string is not a red test; it is a
// wrong contract that Go, TypeScript and Swift are then all required to match,
// and the three of them agreeing is precisely what everyone reads as proof.
//
// So `gen-device-inbox-manifest-vectors.mjs` owns those three fields and
// nothing else. It reads the tracked file for the hand-authored half and carries
// every one of those values through untouched — deriving, correcting and
// overwriting none of them — and derives the rest from a transcription of
// `docs/protocol/relayium-device-inbox-v3.md` (and, through v3 §2's explicit
// adoption, v2 §6-§10) that imports no implementation — not
// `web/src/lib/inbox-manifest.ts`, not `server/internal/inboxmanifest`, not
// RelayiumKit. That independence is load-bearing here in a way it is not for
// the fixtures above: a generator that called the shipped encoder would assert
// `x == x` and stay green through any escaping change, which is the exact class
// of divergence the device-inbox vectors were written to catch.
//
// One thing this gate's own framing must not blur for the hybrid: that
// generator does not copy bytes. It parses the fixture and reserializes all of
// it, so the outer formatting — indentation, key order, JSON escaping, the
// U+2028/U+2029 pass — is the generator's rather than the tracked file's.
// Hand-authored VALUES survive that round trip exactly; hand-authored spellings
// of them do not. The byte identity this gate requires is the FIXED POINT of
// that reserialization, reachable because the fixture was normalized into the
// generator's output form first — not a promise that the hand-authored bytes
// were left alone. It is still the right thing to measure: it is red for a
// hand-edited canonical string and red for an unregenerated item list, which is
// the whole job.
//
// The split of duties is the same as `crypto-vectors.json`'s, one layer over:
// this gate proves the committed canonical bytes are what the SPEC transcription
// produces from the committed item lists, and the three language suites prove
// their own encoders produce those same bytes. Neither half can be inferred
// from the other, and a hand-edit of a canonical string to quiet a red suite now
// fails here.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..");

/**
 * Every generator whose output is a tracked cross-language fixture AND whose
 * generator is the only author of the FIELDS IT OWNS.
 *
 * That last clause used to read "the fixture's only author", which was true of
 * the first three and was the reason `crypto-vectors.json` stayed out of this
 * table until its second author was removed. It is deliberately widened rather
 * than dropped: the device-inbox entry has a permanent second author — the
 * human who writes the refusals and the item lists — and single authorship per
 * FIELD is what the gate actually needs. The two failure modes it prevents,
 * a stale fixture and a hand-edited one, are properties of the generated
 * fields, not of the file. See the section above for what that costs and why it
 * is still worth doing.
 *
 * `generator` is relative to `web/` because the generators write their output
 * through a path relative to the current directory; they are run with `web/` as
 * the working directory for that reason and no other. The device-inbox
 * generator READS through the same relative path for the same reason.
 */
const VECTORS = [
  {
    // The blocker this gate was written for. `transfer.ts`'s frame stream —
    // chunk, batch, done, ack, resume, the three control bytes and the
    // fragmentation grid — as the Swift realtime suites consume it.
    generator: "scripts/gen-realtime-wire-vectors.mjs",
    fixture: "apps/RelayiumKit/Tests/Fixtures/realtime-wire-vectors.json",
  },
  {
    // The same shape, one wire over: `store-crypto.ts`'s framed AES-GCM stored
    // objects. Included because it has the same single-author property and the
    // same failure mode, and because a gate that covered one of two identical
    // fixtures would just be an invitation to rot the other one.
    generator: "scripts/gen-store-wire-vectors.mjs",
    fixture: "apps/RelayiumKit/Tests/Fixtures/store-wire-vectors.json",
  },
  {
    // Not a frame wire but the same contract problem one layer down:
    // `crypto.ts`'s key agreement, SAS, commitment, AEAD nonce schedule,
    // resume-auth key and text-stream keys, as `KeyAgreementTests`,
    // `HandshakeStateTests` and the rest of the Swift crypto suites consume
    // them. Eligible since the generator became this fixture's only author; see
    // the section above for what that took and why it was worth it.
    generator: "scripts/gen-crypto-vectors.mjs",
    fixture: "apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json",
  },
  {
    // The Device Inbox v3 manifest. The odd one out in this table, and the
    // section below says why: its generator does not invent the vectors, it
    // derives three fields inside vectors a human wrote. It is here because the
    // fields it derives — `canonical` above all — have exactly the failure mode
    // this gate exists for, and because the half it does NOT own is the half no
    // generator could produce.
    generator: "scripts/gen-device-inbox-manifest-vectors.mjs",
    fixture: "apps/RelayiumKit/Tests/Fixtures/device-inbox-manifest-v3-vectors.json",
  },
];

const write = process.argv.includes("--write");

const failures = [];
const fail = (message) => failures.push(message);

/** Run one generator with `web/` as the working directory, quietly. */
function runGenerator(entry) {
  try {
    return execFileSync(process.execPath, [entry.generator], {
      cwd: webRoot,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (err) {
    const detail = [err.stdout, err.stderr, err.message]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`${entry.generator} failed:\n${detail}`);
  }
}

/** Regenerate everything, then read back what landed on disk. */
function regenerateAndRead() {
  for (const entry of VECTORS) runGenerator(entry);
  return new Map(VECTORS.map((entry) => [entry.fixture, readFileSync(resolve(repoRoot, entry.fixture))]));
}

/**
 * The first line that differs, as a human can act on it.
 *
 * These fixtures are pretty-printed JSON with one hex string per line, so a line
 * number plus the two truncated values names the field that moved. A byte offset
 * into 17KB of hex would not.
 */
function describeDiff(expected, actual, labels = ["tracked  ", "generated"]) {
  if (expected.equals(actual)) return null;
  const want = expected.toString("utf8").split("\n");
  const got = actual.toString("utf8").split("\n");
  const clip = (line) => (line === undefined ? "<end of file>" : line.length > 120 ? `${line.slice(0, 117)}…` : line);
  for (let i = 0; i < Math.max(want.length, got.length); i += 1) {
    if (want[i] === got[i]) continue;
    return [
      `      first difference at line ${i + 1}`,
      `        ${labels[0]}: ${clip(want[i])}`,
      `        ${labels[1]}: ${clip(got[i])}`,
      `      (${want.length} / ${got.length} lines, ${expected.length} / ${actual.length} bytes)`,
    ].join("\n");
  }
  // Same lines, different bytes: a trailing-newline or line-ending change.
  return `      the lines are equal but the bytes are not (${expected.length} / ${actual.length} bytes)`;
}

// ── the inputs have to exist before anything is run or overwritten ───────────
for (const entry of VECTORS) {
  if (!existsSync(resolve(webRoot, entry.generator))) {
    fail(`${entry.generator} does not exist; this table names the generator that owns ${entry.fixture}`);
  }
  if (!write && !existsSync(resolve(repoRoot, entry.fixture))) {
    fail(`${entry.fixture} does not exist; the Swift vector suites read it and it must be tracked`);
  }
}
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
  process.exit(1);
}

if (write) {
  for (const entry of VECTORS) {
    process.stdout.write(runGenerator(entry));
    process.stdout.write(`  → ${entry.fixture}\n`);
  }
  process.stdout.write(
    `\nregenerated ${VECTORS.length} wire-vector fixture(s). `
    + `Review the diff and commit it together with the change that caused it.\n`,
  );
  process.exit(0);
}

// ── verify: regenerate twice, restore, then judge ────────────────────────────
const tracked = new Map(
  VECTORS.map((entry) => [entry.fixture, readFileSync(resolve(repoRoot, entry.fixture))]),
);

let first;
let second;
let crashed = null;
try {
  first = regenerateAndRead();
  second = regenerateAndRead();
} catch (err) {
  // Recorded rather than reported here: a generator may have rewritten one
  // fixture and then thrown on the next, and the restore below has to run
  // before anything exits. `process.exit` inside a catch skips its own finally.
  crashed = err;
} finally {
  for (const [fixture, bytes] of tracked) {
    const path = resolve(repoRoot, fixture);
    if (!existsSync(path) || !readFileSync(path).equals(bytes)) writeFileSync(path, bytes);
  }
}
if (crashed) {
  process.stderr.write(`FAIL: ${crashed.message}\n`);
  process.exit(1);
}

for (const entry of VECTORS) {
  const runOne = first.get(entry.fixture);
  const runTwo = second.get(entry.fixture);
  const drift = describeDiff(runOne, runTwo, ["first run ", "second run"]);
  if (drift) {
    fail(
      `${entry.generator} is NOT deterministic — two consecutive runs disagreed:\n${drift}\n`
      + `      A generated fixture that cannot be reproduced cannot gate anything. Remove the\n`
      + `      randomness, timestamp or unordered iteration from the generator first.`,
    );
    continue;
  }
  const diff = describeDiff(tracked.get(entry.fixture), runOne);
  if (diff) {
    fail(
      `${entry.fixture} is not what ${entry.generator} produces:\n${diff}\n`
      + `      Run \`npm run gen:vectors\` from web/ and commit the result together with the\n`
      + `      Web-side change that moved the wire — the Swift vector suites assert against\n`
      + `      this file, so until it is regenerated they are testing the OLD wire.`,
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
  process.stderr.write(`\n${failures.length} wire-vector assertion(s) failed\n`);
  process.exit(1);
}

process.stdout.write(
  `ok: ${VECTORS.length} cross-language wire-vector fixture(s) reproduce byte-for-byte from their `
  + `generators, twice (${VECTORS.map((entry) => entry.fixture).join(", ")})\n`,
);
