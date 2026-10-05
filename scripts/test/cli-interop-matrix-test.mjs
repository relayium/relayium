#!/usr/bin/env node
// scripts/test/cli-interop-matrix-test.mjs — the A12 CLI pairing interop
// matrix can fail, and is wired where it claims to be.
//
// ## Why this exists
//
// Every A12 cell ends in a judge — `cli-web-oracle.py`, `cli-android-oracle.py`,
// `cli-mac-oracle.py`, and `cli-go-matrix.sh judge` for the named Go cells —
// and a judge that cannot say no is the most expensive kind of green: the lane
// reports agreement it never checked. So each judge is first shown a
// synthetic round that must PASS, and then that round with exactly one thing
// wrong, which must FAIL for the stated reason:
//
//   * a missing, extra (declined/cancelled) or wrong-bytes file on either side;
//   * a SKIPPED or renamed named test, a FAIL, a log without both link roles;
//   * both ends claiming one link role, different SAS digits;
//   * an outcome the CLI reported the wrong number of times, a wrong exit code;
//   * for the CLI ↔ Android schedule, a CLI role other than the planned one,
//     a plan whose ids and role disagree, and every way the live accepted-
//     socket prefix the shell waits on can be short (pending), wrong (fatal)
//     or complete — rendered from the server's real log format.
//
// Then the WIRING: the workflows run exactly these entry points, on the paths
// that feed them, with no `if:`/`continue-on-error` escape hatch — each also
// mutated away to prove the check notices.
//
// Runs in `compat.yml` (unfiltered), so it judges every change.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { matchesFilter, readPushPaths } from "../ci/select-lanes.mjs";
import { fullPathOf } from "../ci/ci-evidence-view.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const interop = join(repo, "scripts", "interop");
let failures = 0;
let checks = 0;
const need = (cond, msg) => { checks += 1; if (!cond) { failures += 1; console.error(`  ✗ ${msg}`); } };

const body = (size, seed) => {
  const period = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) period[i] = (i * 31 + seed) & 0xff;
  const out = Buffer.alloc(size);
  for (let o = 0; o < size; o += 256) period.copy(out, o, 0, Math.min(256, size - o));
  return out;
};
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const clone = (x) => JSON.parse(JSON.stringify(x));

function runJudge(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: r.stderr ?? "" };
}

/** A synthetic round that must pass, then one mutation per rule. */
function judgeCases(label, { good, mutations, run, expectOut }) {
  const g = run(good());
  need(g.code === 0, `${label}: the synthetic good round must PASS (exit ${g.code}): ${g.err.slice(0, 600)}`);
  if (expectOut) need(g.out === expectOut, `${label}: the good round must print ${expectOut}, printed ${JSON.stringify(g.out)}`);
  for (const m of mutations) {
    const world = good();
    m.mutate(world);
    const r = run(world);
    need(r.code !== 0, `${label}: "${m.name}" was judged green`);
    if (r.code !== 0 && m.expect) {
      need(m.expect.test(r.err), `${label}: "${m.name}" failed for the wrong reason: ${r.err.slice(0, 400)}`);
    }
  }
}

const scratch = mkdtempSync(join(tmpdir(), "cli-interop-matrix-test-"));
const pycacheOf = () => {
  const dir = join(repo, "scripts", "test", "__pycache__");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("android_interop_oracle")).sort().join(",") : "";
};
const pycacheBefore = pycacheOf();
try {
  // ── cli-web-oracle.py ─────────────────────────────────────────────────
  {
    let n = 0;
    const good = () => {
      const root = join(scratch, `web-${n++}`);
      mkdirSync(root);
      const plan = JSON.parse(execFileSync("python3", [join(interop, "cli-matrix-plan.py"), "web", root, "1", "cli", "on", "quit"], { encoding: "utf8" }));
      for (const e of plan.webBatches.flat) writeFileSync(join(plan.dest, e.name), body(e.size, e.seed));
      for (const e of plan.webBatches.folder) {
        mkdirSync(dirname(join(plan.dest, e.path)), { recursive: true });
        writeFileSync(join(plan.dest, e.path), body(e.size, e.seed));
      }
      const save = (e, path, extra = {}) => ({ name: e.name, path, closed: true, aborted: false, removed: false, size: e.size, sha256: sha(body(e.size, e.seed)), ...extra });
      const saves = [
        ...plan.cliBatches.flat.map((e) => save(e, e.name)),
        ...plan.cliBatches.dir.entries.map((e) => save(e, e.path)),
        { name: plan.cliBatches.cancel.name, path: plan.cliBatches.cancel.name, closed: true, size: 0, sha256: sha(Buffer.alloc(0)) },
      ];
      const stderr = [
        "linked with a Relayium app or the web page (end-to-end encrypted link/1, initiator)",
        "verification code (SAS): 123456 — not the pairing code; compare it on both ends to rule out a substituted endpoint",
        "connected. Type a message and press Enter to send it.",
        "saved: every file verified and written to disk in /x", "saved: every file verified and written to disk in /x",
        "declined",
        "delivered: the other side verified and saved the files", "delivered: the other side verified and saved the files",
        "not sent: the other side declined the files",
        "the partial files of that batch were removed; nothing from it was kept",
        "not saved: the sender cancelled",
        "not delivered: the other side stopped the transfer",
      ];
      const obs = {
        complete: true,
        cli: { stderr, stdout: plan.webMessages.map((m) => m + "\n").join(""), exit: { code: 1 } },
        web: { role: "responder", sas: "123456", receivedMessages: [...plan.cliMessages], saves, sdp: {} },
        cancel: { stopped: true, resumed: true, webCancelClicked: true },
        receiverCancel: { clicked: true },
      };
      return { plan, obs };
    };
    const run = ({ plan, obs }) => {
      const dir = mkdtempSync(join(scratch, "judge-"));
      writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
      writeFileSync(join(dir, "obs.json"), JSON.stringify(obs));
      return runJudge("python3", [join(interop, "cli-web-oracle.py"), join(dir, "plan.json"), join(dir, "obs.json")]);
    };
    judgeCases("cli-web-oracle", {
      good, run, expectOut: "initiator",
      mutations: [
        { name: "a web→cli file is missing on disk", expect: /did not save web-big-1\.bin/,
          mutate: (w) => rmSync(join(w.plan.dest, "web-big-1.bin")) },
        { name: "the declined batch landed on disk", expect: /must not: web-declined-1\.bin/,
          mutate: (w) => writeFileSync(join(w.plan.dest, "web-declined-1.bin"), "x") },
        { name: "a leftover partial of the cancelled batch", expect: /must not: web-cancel-1\.bin/,
          mutate: (w) => writeFileSync(join(w.plan.dest, "web-cancel-1.bin"), "x") },
        { name: "a folder file has the wrong bytes", expect: /wrong bytes/,
          mutate: (w) => writeFileSync(join(w.plan.dest, "web-dir-1", "top-1.txt"), body(333, 99)) },
        { name: "the folder lost its nesting", expect: /did not save web-dir-1\/sub\/deep-1\.bin/,
          mutate: (w) => { rmSync(join(w.plan.dest, "web-dir-1", "sub"), { recursive: true }); writeFileSync(join(w.plan.dest, "deep-1.bin"), body(70000, 12)); } },
        { name: "stdout carries something besides the peer's messages", expect: /stdout is not exactly/,
          mutate: (w) => { w.obs.cli.stdout += "noise\n"; } },
        { name: "the page never showed the CLI's message", expect: /never showed the CLI's message/,
          mutate: (w) => { w.obs.web.receivedMessages = []; } },
        { name: "both ends claim initiator", expect: /same link role/,
          mutate: (w) => { w.obs.web.role = "initiator"; } },
        { name: "the SAS differ on a verify=on round", expect: /different SAS/,
          mutate: (w) => { w.obs.web.sas = "654321"; } },
        { name: "a cli→web save is missing", expect: /completed 0 saves of cli-big-1\.bin/,
          mutate: (w) => { w.obs.web.saves = w.obs.web.saves.filter((s) => s.name !== "cli-big-1.bin"); } },
        { name: "a cli→web save has the wrong bytes", expect: /page saved cli-dir-1\/top-1\.txt with the wrong bytes/,
          mutate: (w) => { w.obs.web.saves.find((s) => s.path === "cli-dir-1/top-1.txt").sha256 = "00"; } },
        { name: "the page saved the batch it declined", expect: /which it declined/,
          mutate: (w) => { w.obs.web.saves.push({ name: "cli-declined-1.bin", path: "cli-declined-1.bin", closed: true, size: 4000 }); } },
        { name: "the stopped batch completed at the page", expect: /FULL body of cli-cancel-1\.bin/,
          mutate: (w) => { const s = w.obs.web.saves.find((x) => x.name === "cli-cancel-1.bin"); s.size = w.plan.cliBatches.cancel.size; } },
        { name: "the CLI reported one saved batch, not two", expect: /reported saved 1 time/,
          mutate: (w) => { w.obs.cli.stderr.splice(w.obs.cli.stderr.indexOf("saved: every file verified and written to disk in /x"), 1); } },
        { name: "the CLI never reported the receiver's stop", expect: /receiver's stop 0 time/,
          mutate: (w) => { w.obs.cli.stderr = w.obs.cli.stderr.filter((l) => !l.startsWith("not delivered")); } },
        { name: "the CLI never reported the sender's cancel", expect: /sender's cancel 0 time/,
          mutate: (w) => { w.obs.cli.stderr = w.obs.cli.stderr.filter((l) => l !== "not saved: the sender cancelled"); } },
        { name: "the pre-b897f15bd cancel wording", expect: /sender's cancel 0 time/,
          mutate: (w) => { const i = w.obs.cli.stderr.indexOf("not saved: the sender cancelled"); w.obs.cli.stderr[i] = "not saved: the sender cancelled; nothing from it was kept"; } },
        { name: "the CLI never reported the discard of the cancelled batch", expect: /discard of the cancelled batch 0 time/,
          mutate: (w) => { w.obs.cli.stderr = w.obs.cli.stderr.filter((l) => !l.startsWith("the partial files of that batch")); } },
        { name: "the connection was lost", expect: /lost connection/,
          mutate: (w) => { w.obs.cli.stderr.push("the connection to the other side was lost"); } },
        { name: "the CLI exited 0 after declines and cancels", expect: /exited .* not 1/,
          mutate: (w) => { w.obs.cli.exit.code = 0; } },
        { name: "the sender-cancel cell never pressed Cancel", expect: /sender-cancel cell/,
          mutate: (w) => { w.obs.cancel.webCancelClicked = false; } },
        { name: "the driver did not complete", expect: /did not complete/,
          mutate: (w) => { w.obs.complete = false; } },
      ],
    });
  }

  // ── cli-android-oracle.py ─────────────────────────────────────────────
  {
    let n = 0;
    // `ident` is [cliId, androidId, plannedRole] for the deterministic form
    // (the shell's 10-argument call), or null for the legacy 6-argument form.
    const good = (cancel = "none", ident = null) => {
      const root = join(scratch, `android-${n++}`);
      mkdirSync(root);
      const args = ident ? [cancel, "", ...ident] : [cancel];
      const plan = JSON.parse(execFileSync("python3", [join(interop, "cli-matrix-plan.py"), "android", root, "2", "cli", ...args], { encoding: "utf8" }));
      for (const e of plan.android.expectSaved) writeFileSync(join(plan.dest, e.name), body(e.size, e.seed));
      const saved = [...(cancel === "receive" ? [] : plan.first), ...plan.second]
        .map((e) => ({ name: e.name, size: e.size, sha256: sha(body(e.size, e.seed)) }));
      const obs = {
        complete: true,
        cli: {
          stderr: [
            `linked with a Relayium app or the web page (end-to-end encrypted link/1, ${ident ? ident[2] : "responder"})`,
            "verification code (SAS): 111222 — not the pairing code",
            "delivered: the other side verified and saved the files", "delivered: the other side verified and saved the files",
            "saved: every file verified and written to disk in /x", "saved: every file verified and written to disk in /x",
            "the other side ended the session",
          ],
          stdout: `${plan.androidMessage}\nrelayium-e2e:send-again\n${plan.postMessage}\n`,
          exit: { code: 0 },
        },
      };
      const android = { complete: true, sas: "111222", receivedMessage: plan.cliMessage, saved, treeAfter: [] };
      return { plan, obs, android };
    };
    const run = ({ plan, obs, android }) => {
      const dir = mkdtempSync(join(scratch, "judge-"));
      for (const [f, v] of [["plan", plan], ["obs", obs], ["android", android]]) writeFileSync(join(dir, `${f}.json`), JSON.stringify(v));
      return runJudge("python3", [join(interop, "cli-android-oracle.py"), join(dir, "plan.json"), join(dir, "obs.json"), join(dir, "android.json")]);
    };
    judgeCases("cli-android-oracle", {
      good: () => good(), run, expectOut: "responder",
      mutations: [
        { name: "Android's file is missing on the CLI", expect: /did not save android-to-cli-2\.bin/,
          mutate: (w) => rmSync(join(w.plan.dest, "android-to-cli-2.bin")) },
        { name: "Android saved the wrong bytes", expect: /Android did not save cli-big-2\.bin exactly/,
          mutate: (w) => { w.android.saved[0].sha256 = "00"; } },
        { name: "the SAS differ", expect: /SAS differ/, mutate: (w) => { w.android.sas = "999999"; } },
        { name: "the CLI's stdout lost the send-again marker", expect: /stdout is not exactly/,
          mutate: (w) => { w.obs.cli.stdout = w.obs.cli.stdout.replace("relayium-e2e:send-again\n", ""); } },
        { name: "the CLI exited 1 on a clean round", expect: /exited/, mutate: (w) => { w.obs.cli.exit.code = 1; } },
        { name: "the session ended twice (leave and drop)", expect: /did not end exactly once/,
          mutate: (w) => { w.obs.cli.stderr.push("the connection to the other side was lost"); } },
        { name: "Android dropped the link but the CLI exited 0", expect: /not 1 \(ending: drop\)/,
          mutate: (w) => { w.obs.cli.stderr = w.obs.cli.stderr.map((l) => l === "the other side ended the session" ? "the connection to the other side was lost" : l); } },
      ],
    });
    // The receive-cancel round has its own expectations. Its plan is GATED
    // (an active cancel, below); the original, ungated expectations are kept
    // against an explicitly ungated plan (`receiveGate: null`), so the rules
    // for a round that does not hold a write stay exactly as they were.
    const STOP = "not delivered: the other side stopped the transfer";
    const ungated = () => {
      const w = good("receive");
      w.plan.receiveGate = null;
      w.obs.cli.stderr = w.obs.cli.stderr.filter((l, i, a) => !(l.startsWith("delivered") && a.indexOf(l) === i));
      w.obs.cli.stderr.push(STOP);
      w.obs.cli.exit.code = 1;
      return w;
    };
    const rc = ungated();
    need(run(rc).code === 0, `cli-android-oracle: a correct receive-cancel round must PASS: ${run(rc).err.slice(0, 400)}`);
    const rcDecline = clone(rc);
    rcDecline.obs.cli.stderr = rcDecline.obs.cli.stderr.map((l) => l.startsWith("not delivered") ? "not sent: the other side declined the files" : l);
    need(run(rcDecline).code === 0, `cli-android-oracle: a receive-cancel round seen as a decline must PASS: ${run(rcDecline).err.slice(0, 400)}`);
    const rcBoth = clone(rc);
    rcBoth.obs.cli.stderr.push("not sent: the other side declined the files");
    need(run(rcBoth).code !== 0, "cli-android-oracle: a receive-cancel round reported as BOTH a stop and a decline was judged green");
    // Android's teardown today drops the link rather than leaving: accepted,
    // with the CLI's exit 1 that follows from it.
    const drop = good();
    drop.obs.cli.stderr = drop.obs.cli.stderr.map((l) => l === "the other side ended the session" ? "the connection to the other side was lost" : l);
    drop.obs.cli.exit.code = 1;
    need(run(drop).code === 0, `cli-android-oracle: a clean round ended by Android's drop must PASS: ${run(drop).err.slice(0, 400)}`);
    const big = rc.plan.first[0];
    rc.android.saved.push({ name: big.name, size: big.size, sha256: sha(body(big.size, big.seed)) });
    need(run(rc).code !== 0, "cli-android-oracle: a receive-cancel round in which Android kept the stopped batch was judged green");

    // ── the ACTIVE receive cancel (plan receiveGate: "first-write") ─────────
    //
    // A typed record of what the instrumentation observed on the real store
    // and the real controller state, in the store's own event order.
    const active = () => {
      const w = ungated();
      w.plan = JSON.parse(execFileSync("python3", [join(interop, "cli-matrix-plan.py"), "android", join(scratch, `android-${n++}`), "2", "cli", "receive"], { encoding: "utf8" }));
      for (const e of w.plan.android.expectSaved) writeFileSync(join(w.plan.dest, e.name), body(e.size, e.seed));
      w.android.saved = w.plan.second.map((e) => ({ name: e.name, size: e.size, sha256: sha(body(e.size, e.seed)) }));
      const names = w.plan.first.map((e) => e.name);
      w.obs.firstBatchOutcome = STOP;
      w.android.linkId = 3;
      w.android.offered = names;
      w.android.treeAfterCancel = ["sentinel-do-not-touch.txt"];
      w.android.cleanupIncompleteAfterCancel = false;
      w.android.activeReceiveCancel = {
        mode: "first-write", storeSerial: 1, storeSerialBefore: 0, token: 1, boundGeneration: 1,
        manifest: [...names], heldIndex: 0, heldBytes: 65536, okWritesBeforeHold: 0,
        incomingAtCancel: [...names], progressNullAtCancel: true, errorKeyAtCancel: null, laneDownAtCancel: false,
        phaseAtCancel: "CONNECTED", linkAtCancel: 3, effectWhileHeld: true, errorKeyAfterEffect: null,
        laneDownAfterEffect: false, phaseAfterEffect: "CONNECTED", linkAfterEffect: 3,
        holdSeq: 3, marks: { cancelCalled: 4, cancelEffectObserved: 5 }, releaseSeq: 6, releasedBy: "test",
        heldWriteSeq: 7, heldWriteOutcome: "ok", discardSeq: 8, discardGeneration: 1, discardDuringBegin: false,
        discardOutcome: "ok", discardsObserved: 2,
      };
      return w;
    };
    const rec = (w) => w.android.activeReceiveCancel;
    judgeCases("cli-android-oracle (active receive cancel)", {
      good: active, run, expectOut: "responder",
      mutations: [
        { name: "the plan does not say whether the gate is on", expect: /does not say whether the receive gate is on/,
          mutate: (w) => { delete w.plan.receiveGate; } },
        { name: "an unknown gate", expect: /unknown receive gate/, mutate: (w) => { w.plan.receiveGate = "first-byte"; } },
        { name: "the gated first body fits in one window", expect: /not larger than one flow window/,
          mutate: (w) => { w.plan.first[0].size = 8 * 1024 * 1024; } },
        { name: "no active record at all", expect: /no active receive-cancel record/,
          mutate: (w) => { delete w.android.activeReceiveCancel; } },
        { name: "a record bound to another store", expect: /storeSerial.*not the one store this launch built/,
          mutate: (w) => { rec(w).storeSerial = 2; } },
        { name: "the write was never held", expect: /missing events \[.holdSeq.\]/,
          mutate: (w) => { delete rec(w).holdSeq; } },
        { name: "a different batch was held", expect: /manifest.*not the CLI's first batch/,
          mutate: (w) => { rec(w).manifest = ["cli-second-2.bin"]; } },
        { name: "a different file was held", expect: /heldIndex.*not the batch's first file/,
          mutate: (w) => { rec(w).heldIndex = 2; } },
        { name: "bytes were acknowledged before the hold", expect: /okWritesBeforeHold.*durable/,
          mutate: (w) => { rec(w).okWritesBeforeHold = 1; } },
        { name: "the cancel was of a different batch", expect: /incomingAtCancel.*not of the held batch/,
          mutate: (w) => { rec(w).incomingAtCancel = []; } },
        { name: "progress was already durable at the cancel", expect: /progressNullAtCancel/,
          mutate: (w) => { rec(w).progressNullAtCancel = false; } },
        { name: "the cancel was only called, its effect never seen while held", expect: /effectWhileHeld/,
          mutate: (w) => { rec(w).effectWhileHeld = false; } },
        { name: "the effect was seen only after the release", expect: /events are out of order/,
          mutate: (w) => { rec(w).marks.cancelEffectObserved = 9; } },
        { name: "the hold ended by timeout", expect: /releasedBy.*not released by the test/,
          mutate: (w) => { rec(w).releasedBy = "timeout"; } },
        { name: "the cancel surfaced a save failure", expect: /errorKeyAfterEffect.*save failure is not a cancel/,
          mutate: (w) => { rec(w).errorKeyAfterEffect = "error_save_failed"; } },
        { name: "an error already stood before the cancel", expect: /errorKeyAtCancel/,
          mutate: (w) => { rec(w).errorKeyAtCancel = "error_save_failed"; } },
        { name: "the cancel took the file lane down", expect: /laneDownAfterEffect/,
          mutate: (w) => { rec(w).laneDownAfterEffect = true; } },
        { name: "the cancel was on another link", expect: /linkAfterEffect.*not this round's link/,
          mutate: (w) => { rec(w).linkAfterEffect = 4; } },
        { name: "the released held write failed", expect: /heldWriteOutcome/,
          mutate: (w) => { rec(w).heldWriteOutcome = "failed"; } },
        { name: "the rollback did not complete", expect: /discardOutcome.*did not complete/,
          mutate: (w) => { rec(w).discardOutcome = "failed"; } },
        { name: "the rollback seen was of another generation", expect: /discardGeneration.*not the cancelled batch's rollback/,
          mutate: (w) => { rec(w).discardGeneration = 2; } },
        { name: "the rollback seen was a begin's defensive discard", expect: /discardDuringBegin/,
          mutate: (w) => { rec(w).discardDuringBegin = true; } },
        { name: "no rollback was seen at all", expect: /missing events \[.discardSeq.\]/,
          mutate: (w) => { rec(w).discardSeq = null; } },
        { name: "a boolean field carried a truthy number", expect: /effectWhileHeld/,
          mutate: (w) => { rec(w).effectWhileHeld = 1; } },
        { name: "the cancelled batch leaked into the tree", expect: /cancelled receive left files behind/,
          mutate: (w) => { w.android.treeAfterCancel.push(w.plan.first[0].name); } },
        { name: "the rollback removed the sentinel", expect: /removed content it did not own/,
          mutate: (w) => { w.android.treeAfterCancel = []; } },
        { name: "the rollback reported leftovers", expect: /rollback was not complete/,
          mutate: (w) => { w.android.cleanupIncompleteAfterCancel = true; } },
        { name: "the retry arrived with the wrong bytes", expect: /Android did not save cli-second-2\.bin exactly/,
          mutate: (w) => { w.android.saved[0].sha256 = "00"; } },
        { name: "the CLI saw a DECLINE", expect: /delivered 1 \/ stopped 0 \/ declined 1, not 1 \/ 1 \/ 0/,
          mutate: (w) => { w.obs.cli.stderr = w.obs.cli.stderr.map((l) => l === STOP ? "not sent: the other side declined the files" : l); } },
        { name: "the CLI saw 'could not save' (a late refusal)", expect: /reported a save failure/,
          mutate: (w) => { w.obs.cli.stderr = w.obs.cli.stderr.map((l) => l === STOP ? "not delivered: the other side could not save the files" : l); } },
        { name: "the peer's first-batch outcome is not the stop", expect: /first batch ended/,
          mutate: (w) => { delete w.obs.firstBatchOutcome; } },
      ],
    });
    // A record in a round that did not plan the gate is a failure too.
    const stray = clone(rc);
    stray.android.saved = stray.android.saved.filter((s) => s.name !== big.name);
    stray.android.activeReceiveCancel = { mode: "first-write" };
    const strayRun = run(stray);
    need(strayRun.code !== 0 && /did not plan one/.test(strayRun.err),
      `cli-android-oracle: an active record in an ungated round was not refused for that reason: ${strayRun.err.slice(0, 300)}`);

    // ── the deterministic schedule (plan `identity`) ────────────────────────
    //
    // The ids are the REAL lane's, CLI first per round; the role each pair
    // implies is `linkwire.LinkRole` (the smaller id initiates).
    const shell = readFileSync(join(interop, "cli-android-acceptance.sh"), "utf8");
    const SCHED = ["f444444444444444", "0444444444444444", "0555555555555555",
                   "f555555555555555", "f666666666666666", "0666666666666666"];
    need(/^acceptance_peer_ids="([^"\n]*)"$/m.exec(shell)?.[1] === SCHED.join(","),
      "cli-android-acceptance.sh's schedule is not the one these controls exercise");
    need(/^planned_roles=\(([^)\n]*)\)$/m.exec(shell)?.[1] === "responder initiator responder",
      "cli-android-acceptance.sh's planned roles are not the ones these controls exercise");
    const RESP = [SCHED[0], SCHED[1], "responder"];   // round 1
    const INIT = [SCHED[2], SCHED[3], "initiator"];   // round 2
    const linkedAs = (w, role) => {
      w.obs.cli.stderr = w.obs.cli.stderr.map((l) => l.startsWith("linked with ") ? `linked with a Relayium app or the web page (end-to-end encrypted link/1, ${role})` : l);
    };
    const id = (w) => w.plan.identity;
    for (const [label, ident, other] of [["responder", RESP, "initiator"], ["initiator", INIT, "responder"]]) {
      judgeCases(`cli-android-oracle (scheduled CLI ${label})`, {
        good: () => good("none", ident), run, expectOut: label,
        mutations: [
          { name: "the CLI linked in the other role", expect: new RegExp(`linked as ${other}, but the schedule .* planned ${label}`),
            mutate: (w) => linkedAs(w, other) },
          { name: "the plan's role contradicts its ids", expect: /schedule is inconsistent/,
            mutate: (w) => { id(w).plannedRole = other; linkedAs(w, other); } },
          { name: "the plan's ids are swapped", expect: /schedule is inconsistent/,
            mutate: (w) => { [id(w).expectedCliId, id(w).expectedAndroidId] = [id(w).expectedAndroidId, id(w).expectedCliId]; } },
          { name: "both clients planned the same id", expect: /planned the SAME id/,
            mutate: (w) => { id(w).expectedAndroidId = id(w).expectedCliId; } },
          { name: "an uppercase planned id", expect: /planned CLI id .* not 16 lowercase hex/,
            mutate: (w) => { id(w).expectedCliId = id(w).expectedCliId.toUpperCase().replace(/^0/, "A"); } },
          { name: "a short planned id", expect: /planned Android id .* not 16 lowercase hex/,
            mutate: (w) => { id(w).expectedAndroidId = id(w).expectedAndroidId.slice(0, 15); } },
          { name: "a numeric planned id", expect: /planned CLI id .* not 16 lowercase hex/,
            mutate: (w) => { id(w).expectedCliId = 1; } },
          { name: "an unknown planned role", expect: /planned role .* neither initiator nor responder/,
            mutate: (w) => { id(w).plannedRole = "either"; } },
          { name: "the plan does not carry identity at all", expect: /does not say which identities/,
            mutate: (w) => { delete w.plan.identity; } },
          { name: "the identity lacks its planned role", expect: /identity has no \['plannedRole'\]/,
            mutate: (w) => { delete id(w).plannedRole; } },
          { name: "the identity lacks the Android id", expect: /identity has no \['expectedAndroidId'\]/,
            mutate: (w) => { delete id(w).expectedAndroidId; } },
          { name: "the identity carries an unjudged field", expect: /fields nobody judges/,
            mutate: (w) => { id(w).welcomedId = id(w).expectedCliId; } },
          { name: "the identity is a bare role", expect: /neither a schedule nor null/,
            mutate: (w) => { w.plan.identity = label; } },
          { name: "the CLI printed no linked line", expect: /printed 0 linked lines[\s\S]*planned \w+ is unobserved/,
            mutate: (w) => { w.obs.cli.stderr = w.obs.cli.stderr.filter((l) => !l.startsWith("linked with ")); } },
          { name: "the CLI printed two linked lines (a relink)", expect: /printed 2 linked lines[\s\S]*planned \w+ is unobserved/,
            mutate: (w) => { w.obs.cli.stderr.splice(1, 0, w.obs.cli.stderr[0]); } },
          { name: "a relink in the OTHER role", expect: /printed 2 linked lines/,
            mutate: (w) => { w.obs.cli.stderr.splice(1, 0, `linked with a Relayium app or the web page (end-to-end encrypted link/1, ${other})`); } },
        ],
      });
    }
    // The active receive cancel under its scheduled identity (round 2 plans
    // the CLI initiator), so the gated judgement and the identity compose.
    const activeSched = active();
    activeSched.plan.identity = { expectedCliId: INIT[0], expectedAndroidId: INIT[1], plannedRole: "initiator" };
    linkedAs(activeSched, "initiator");
    const as = run(activeSched);
    need(as.code === 0 && as.out === "initiator", `cli-android-oracle: the scheduled active receive-cancel round must PASS as initiator: ${as.err.slice(0, 400)}`);
    // A legacy (null) plan still accepts EITHER role — and the plan says so.
    const legacyInit = good();
    need(Object.hasOwn(legacyInit.plan, "identity") && legacyInit.plan.identity === null,
      "cli-matrix-plan.py's legacy android form must write an explicit identity: null");
    linkedAs(legacyInit, "initiator");
    const li = run(legacyInit);
    need(li.code === 0 && li.out === "initiator", `cli-android-oracle: an unscheduled (identity null) initiator round must PASS: ${li.err.slice(0, 400)}`);

    // The plan generator: the 7-argument form stays legacy, the 10-argument
    // form refuses a schedule that cannot be one (and creates nothing), and
    // nothing in between is accepted.
    const planRun = (args) => {
      const root = join(scratch, `android-plan-${n++}`);
      mkdirSync(root);
      const r = spawnSync("python3", [join(interop, "cli-matrix-plan.py"), "android", root, "3", "api", "none", ...args], { encoding: "utf8" });
      return { ...r, root };
    };
    const seven = planRun(["123456"]);
    need(seven.status === 0 && JSON.parse(seven.stdout).identity === null && JSON.parse(seven.stdout).code === "123456",
      `cli-matrix-plan.py: the 7-argument android form must stay legacy with identity null: ${seven.stderr}`);
    const ten = planRun(["123456", SCHED[4], SCHED[5], "responder"]);
    need(ten.status === 0 && JSON.stringify(JSON.parse(ten.stdout).identity)
      === JSON.stringify({ expectedCliId: SCHED[4], expectedAndroidId: SCHED[5], plannedRole: "responder" }),
      `cli-matrix-plan.py: the 10-argument android form must carry the schedule: ${ten.stderr}`);
    for (const [name, args, reason] of [
      ["identical ids", ["", SCHED[0], SCHED[0], "responder"], /same id/],
      ["a malformed id", ["", "F444444444444444", SCHED[1], "responder"], /not 16 lowercase hex/],
      ["an unknown role", ["", SCHED[0], SCHED[1], "both"], /neither initiator nor responder/],
      ["ids that imply the other role", ["", SCHED[0], SCHED[1], "initiator"], /make the CLI responder, not the planned initiator/],
      ["only the ids (9 arguments)", ["", SCHED[0], SCHED[1]], /usage|cli-matrix-plan\.py web/],
      ["one id (8 arguments)", ["", SCHED[0]], /usage|cli-matrix-plan\.py web/],
    ]) {
      const r = planRun(args);
      need(r.status === 2 && reason.test(r.stderr), `cli-matrix-plan.py: "${name}" was not refused for its reason (exit ${r.status}): ${r.stderr.slice(0, 300)}`);
      need(!existsSync(join(r.root, "stage-3")), `cli-matrix-plan.py: "${name}" staged files before refusing`);
    }

    // ── accepted-prefix: the live CLI-first barrier and the round-end check ─
    //
    // Lines rendered from `acceptancePeerIDLogFormat` as it stands in
    // server/main.go, behind Go's standard log prefix, so a drift between the
    // producer and this consumer fails here rather than on an emulator.
    const mainGo = readFileSync(join(repo, "server", "main.go"), "utf8");
    const GO_FORMAT = /^const acceptancePeerIDLogFormat = "([^"\\]*)"$/m.exec(mainGo)?.[1] ?? "";
    need(GO_FORMAT.includes("%d") && GO_FORMAT.includes("%s") && mainGo.includes("\t\tlogf(acceptancePeerIDLogFormat, seq, id)\n"),
      "server/main.go no longer logs every accepted socket through one acceptancePeerIDLogFormat");
    const render = (seq, idv = SCHED[(seq - 1) % 6], format = GO_FORMAT) =>
      `2026/10/06 01:00:0${seq % 10} ` + format.replace("%d", String(seq)).replace("%s", idv);
    // A marker line for an arbitrary decimal sequence TEXT (render's clock
    // digit assumes a small number).
    const atSeq = (digits, idv) => "2026/10/06 01:00:09 " + GO_FORMAT.replace("%d", digits).replace("%s", idv);
    const logOf = (seqs, { extra = [], tail = "" } = {}) =>
      ["2026/10/06 01:00:00 relayium signaling server listening on 127.0.0.1:41234",
       ...seqs.map((q) => render(q)), ...extra].join("\n") + "\n" + tail;
    let logs = 0;
    const prefix = (text, expected, schedule = SCHED.join(",")) => {
      const f = join(scratch, `server-${logs++}.log`);
      writeFileSync(f, text);
      return runJudge("python3", [join(interop, "cli-android-oracle.py"), "accepted-prefix", f, schedule, String(expected)]);
    };
    for (const [seqs, expected] of [[[1], 1], [[1, 2], 2], [[1, 2, 3], 3], [[1, 2, 3, 4], 4], [[1, 2, 3, 4, 5], 5], [[1, 2, 3, 4, 5, 6], 6]]) {
      const r = prefix(logOf(seqs), expected);
      need(r.code === 0 && new RegExp(`seq ${expected} was assigned ${SCHED[expected - 1]} \\(an accepted socket, not a welcome receipt\\)`).test(r.err),
        `accepted-prefix: ${seqs.length} accepts must be exactly the prefix ${expected} (exit ${r.code}): ${r.err.slice(0, 300)}`);
    }
    const halfLine = render(3).slice(0, -6);   // the server is mid-write
    for (const [name, text, expected] of [
      ["an empty log (the server has not written yet)", "", 1],
      ["a log with no accepts yet", logOf([]), 1],
      ["the CLI has not dialled yet (round 2)", logOf([1, 2]), 3],
      ["the CLI has not dialled yet (round 3)", logOf([1, 2, 3, 4]), 5],
      ["the CLI's accept is still being written (unfinished tail)", logOf([1, 2], { tail: halfLine }), 3],
      ["an unfinished, not-yet-parsable tail", logOf([1, 2], { tail: "2026/10/06 01:00:03 relayium-acceptance-peer-id seq=" }), 3],
      ["only an unfinished line, no newline at all", render(1), 1],
    ]) {
      const r = prefix(text, expected);
      need(r.code === 3 && /pending/.test(r.err) && !/^ {2}- /m.test(r.err),
        `accepted-prefix: "${name}" must be PENDING (exit 3), got exit ${r.code}: ${r.err.slice(0, 300)}`);
    }
    const tailDone = prefix(logOf([1, 2], { tail: halfLine }), 2);
    need(tailDone.code === 0, `accepted-prefix: an unfinished later line must not count as an extra accept: ${tailDone.err.slice(0, 300)}`);
    for (const [name, build, reason] of [
      ["Android accepted before the CLI's barrier (a socket beyond it)", () => prefix(logOf([1, 2, 3, 4]), 3), /sequence 4 .* while waiting for 3/],
      ["an extra socket after the round (a reconnect)", () => prefix(logOf([1, 2, 3, 4, 5]), 4), /sequence 5 .* while waiting for 4/],
      ["a seventh accept beyond the whole schedule", () => prefix(logOf([1, 2, 3, 4, 5, 6, 7]), 6), /sequence 7 .* while waiting for 6/],
      ["a gap below a later accept", () => prefix(logOf([1, 3]), 3), /\[2\] are missing below the accepted 3/],
      ["a gap while still short", () => prefix(logOf([1, 3]), 5), /\[2\] are missing below the accepted 3/],
      ["a sequence logged twice", () => prefix(logOf([1, 2, 2]), 3), /sequence 2 was logged twice/],
      ["the CLI's socket carried another id", () => prefix(logOf([1, 2], { extra: [render(3, SCHED[0])] }), 3),
        /sequence 3 carried f444444444444444, not the schedule's 0555555555555555/],
      ["an earlier socket carried another id", () => prefix(logOf([1], { extra: [render(2, SCHED[2])] }), 3), /sequence 2 carried/],
      ["a malformed marker line", () => prefix(logOf([1], { extra: ["2026/10/06 01:00:02 relayium-acceptance-peer-id seq=x id=?"] }), 3), /malformed/],
      ["a zero sequence", () => prefix(logOf([1], { extra: [render(0, SCHED[0])] }), 3), /malformed/],
      ["an uppercase id", () => prefix(logOf([1], { extra: [render(2, SCHED[1].toUpperCase().replace("0", "A"))] }), 3), /malformed/],
      ["the producer's format drifted", () => prefix(logOf([], { extra: [render(1, SCHED[0], GO_FORMAT.replace("seq=%d", "n=%d"))] }), 1), /malformed/],
      ["a schedule that reuses an id", () => prefix(logOf([1]), 1, [...SCHED.slice(0, 5), SCHED[0]].join(",")), /repeats an id/],
      ["a five-id schedule", () => prefix(logOf([1]), 1, SCHED.slice(0, 5).join(",")), /5 ids, not six/],
      ["a malformed schedule id", () => prefix(logOf([1]), 1, [...SCHED.slice(0, 5), "xyz"].join(",")), /not a list of 16-lowercase-hex ids/],
      ["an expected prefix of 0", () => prefix(logOf([1]), 0), /not a sequence within the six-id schedule/],
      ["an expected prefix beyond the schedule", () => prefix(logOf([1]), 7), /not a sequence within the six-id schedule/],
      ["a zero-padded expected prefix", () => prefix(logOf([1]), "01"), /not a sequence within the six-id schedule/],
      ["a non-numeric expected prefix", () => prefix(logOf([1]), "x"), /not a sequence within the six-id schedule/],
      ["a missing log", () => runJudge("python3", [join(interop, "cli-android-oracle.py"), "accepted-prefix", join(scratch, "absent.log"), SCHED.join(","), "1"]), /unreadable/],
      // Input-derived sequences are refused from their digits, never used as
      // a range bound or converted when longer than the schedule's one digit.
      ["a billion-th sequence (no range up to it)", () => prefix(logOf([1, 2], { extra: [atSeq("1000000000", SCHED[2])] }), 3),
        /sequence 1000000000 \(0555555555555555\) .* while waiting for 3; it is beyond the six-id schedule/],
      ["a 5000-digit sequence (no conversion, no traceback)", () => prefix(logOf([1], { extra: [atSeq("9".repeat(5000), SCHED[1])] }), 1),
        /sequence 9{40}\.\.\.\(5000 characters\) .* beyond the six-id schedule/],
      ["a two-digit sequence beside a valid prefix", () => prefix(logOf([1, 2, 3, 4, 5, 6], { extra: [atSeq("10", SCHED[0])] }), 6),
        /sequence 10 .* beyond the six-id schedule/],
      ["a 5000-digit expected prefix", () => prefix(logOf([1]), "1" + "0".repeat(4999)), /'1{1}0{39}\.\.\.\(5000 characters\)' is not a sequence within/],
    ]) {
      const t0 = Date.now();
      const r = build();
      const ms = Date.now() - t0;
      need(r.code === 1 && reason.test(r.err) && !/Traceback/.test(r.err),
        `accepted-prefix: "${name}" was not refused (exit 1) for its reason (exit ${r.code}): ${r.err.slice(0, 300)}`);
      need(ms < 10_000, `accepted-prefix: "${name}" took ${ms} ms to refuse; a refusal must not scale with an input-derived sequence`);
    }
    const usage = runJudge("python3", [join(interop, "cli-android-oracle.py"), "accepted-prefix", join(scratch, "absent.log"), SCHED.join(",")]);
    need(usage.code === 2 && /usage/.test(usage.err), `accepted-prefix: a missing bound must be a usage error (exit ${usage.code})`);
    // The grammar is imported from the browser lane's oracle; no bytecode may
    // be left beside it in the checkout.
    need(pycacheBefore === pycacheOf(), "accepted-prefix wrote Python bytecode into scripts/test/__pycache__");
  }

  // ── cli-mac-oracle.py ─────────────────────────────────────────────────
  {
    let n = 0;
    const good = () => {
      const root = join(scratch, `mac-${n++}`);
      mkdirSync(root);
      const plan = JSON.parse(execFileSync("python3", [join(interop, "cli-matrix-plan.py"), "mac", root, "3", "mac"], { encoding: "utf8" }));
      for (const f of plan.macFiles) writeFileSync(join(plan.dest, f.name), f.contents);
      for (const e of [...plan.cliBatches.flat, ...plan.cliBatches.dir.entries]) {
        mkdirSync(dirname(join(plan.macReceive, e.path)), { recursive: true });
        writeFileSync(join(plan.macReceive, e.path), body(e.size, e.seed));
      }
      // A receipt's path is relative to the batch's top folder (observed).
      const receipts = [...plan.cliBatches.flat, ...plan.cliBatches.dir.entries]
        .map((e) => ({ name: e.name, path: e.path.split("/").slice(1).join("/") || undefined, size: e.size, sha256: sha(body(e.size, e.seed)) }));
      const obs = {
        complete: true,
        mac: { sas: "424242", messages: [plan.cliMessage], allFiles: receipts, linkPhase: "open(x)" },
        cli: {
          stderr: [
            "linked with a Relayium app or the web page (end-to-end encrypted link/1, initiator)",
            "verification code (SAS): 424242 — not the pairing code",
            "saved: every file verified and written to disk in /x", "saved: every file verified and written to disk in /x",
            "delivered: the other side verified and saved the files", "delivered: the other side verified and saved the files",
          ],
          stdout: plan.macMessage + "\n",
          exit: { code: 0 },
        },
      };
      return { plan, obs };
    };
    const run = ({ plan, obs }) => {
      const dir = mkdtempSync(join(scratch, "judge-"));
      writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
      writeFileSync(join(dir, "obs.json"), JSON.stringify(obs));
      return runJudge("python3", [join(interop, "cli-mac-oracle.py"), join(dir, "plan.json"), join(dir, "obs.json")]);
    };
    judgeCases("cli-mac-oracle", {
      good, run, expectOut: "initiator",
      mutations: [
        { name: "the Mac flattened the directory tree on disk", expect: /did not write cli-dir-3\/a\/b\/nested-3\.bin/,
          mutate: (w) => { rmSync(join(w.plan.macReceive, "cli-dir-3"), { recursive: true }); writeFileSync(join(w.plan.macReceive, "nested-3.bin"), body(90000, 45)); } },
        { name: "the Mac wrote wrong bytes", expect: /did not write cli-big-3\.bin exactly/,
          mutate: (w) => writeFileSync(join(w.plan.macReceive, "cli-big-3.bin"), "x") },
        { name: "the Mac's receipt disagrees with its disk", expect: /receipts for top-3\.txt do not match/,
          mutate: (w) => { w.obs.mac.allFiles.find((r) => r.name === "top-3.txt").sha256 = "00"; } },
        { name: "the CLI saved the Mac's file with other bytes", expect: /did not save mac-first-3\.txt exactly/,
          mutate: (w) => writeFileSync(join(w.plan.dest, "mac-first-3.txt"), "other") },
        { name: "the Mac fell back to legacy", expect: /legacy wire/, mutate: (w) => { w.obs.mac.legacyFallback = { peerId: "x" }; } },
        { name: "an incomplete batch", expect: /incomplete batch/, mutate: (w) => { w.obs.cli.stderr.push("not delivered: the transfer ended before every file arrived"); } },
      ],
    });
  }

  // ── cli-go-matrix.sh judge ────────────────────────────────────────────
  {
    const script = readFileSync(join(interop, "cli-go-matrix.sh"), "utf8");
    const names = (label) => {
      const m = new RegExp(`^${label}=\\(\\n([\\s\\S]*?)^\\)`, "m").exec(script);
      if (!m) throw new Error(`cli-go-matrix.sh has no ${label}=( … ) list`);
      return m[1].split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
    };
    const core = names("core"), posix = names("posix_only"), old = names("old");
    need(core.includes("TestLinkSinkReservedDeviceNames") && core.includes("TestProductInputLossFailsTheRun"),
      "CLI matrix must execute receive-name and input-loss regressions on every platform");
    need(old.includes("TestLinkDevAgainstOldCLI") && old.includes("TestProductCommandsKeepTheLegacyWireWithOlderCLI")
      && old.includes("TestPairAgainstOlderCLIEndsFast"), "cli-go-matrix.sh no longer names the three old-version pair tests");
    need(core.includes("TestPairInterleavedBatchesAndTextsBothWays") && core.includes("TestPairDeclinedBatchAndRejectedSASNeverWrite"),
      "cli-go-matrix.sh no longer names the CLI↔CLI files/decline cells");
    // Every named test exists, as a top-level Test function in cmd/relayium.
    const sources = execFileSync("git", ["-C", repo, "grep", "-h", "^func Test", "--", "server/cmd/relayium/*_test.go"], { encoding: "utf8" });
    for (const t of [...core, ...posix, ...old]) {
      need(new RegExp(`^func ${t}\\(t \\*testing\\.T\\)`, "m").test(sources), `cli-go-matrix.sh names ${t}, which server/cmd/relayium does not define`);
    }
    const goodLog = (platform) => [
      ...[...core, ...old, ...(platform === "windows" ? [] : posix)].map((t) => `--- PASS: ${t} (1.00s)`),
      "    pair_test.go:330: linked with another relayium CLI (end-to-end encrypted link/1, initiator)",
      "    pair_test.go:330: linked with another relayium CLI (end-to-end encrypted link/1, responder)",
      "PASS", "ok  \tgithub.com/relayium/relayium/cmd/relayium\t10.0s",
    ];
    const judge = (platform, lines) => {
      const f = join(mkdtempSync(join(scratch, "golog-")), "log");
      writeFileSync(f, lines.join("\n") + "\n");
      return runJudge("bash", [join(interop, "cli-go-matrix.sh"), "judge", platform, f]);
    };
    for (const platform of ["linux", "windows"]) {
      const g = judge(platform, goodLog(platform));
      need(g.code === 0, `cli-go-matrix judge (${platform}): the good log must PASS: ${g.err.slice(0, 400)}`);
    }
    const mut = [
      ["an old-version pair SKIPPED (the shallow-clone failure this lane exists for)", "linux",
        (l) => l.map((x) => x.startsWith("--- PASS: TestLinkDevAgainstOldCLI ") ? "--- SKIP: TestLinkDevAgainstOldCLI (0.00s)" : x), /TestLinkDevAgainstOldCLI did not PASS|unexpected SKIP/],
      ["a named test renamed away (no PASS line)", "linux",
        (l) => l.filter((x) => !x.startsWith("--- PASS: TestPairDeclinedBatchAndRejectedSASNeverWrite ")), /did not PASS/],
      ["a subtest skipped", "linux", (l) => [...l, "    --- SKIP: TestProductTextOverLink/piped (0.00s)"], /unexpected SKIP/],
      ["a subtest failed", "linux", (l) => [...l, "    --- FAIL: TestLinkDevManySmallFiles/x (0.00s)"], /FAILED/],
      ["only one link role in the log", "linux", (l) => l.filter((x) => !x.includes(", responder)")), /RESPONDER/],
      ["the ctrl-C cell missing on linux", "linux", (l) => l.filter((x) => !x.includes("TestInterruptIsALeave")), /did not PASS/],
      ["the permitted subtest skipped WITHOUT its stated reason", "linux",
        (l) => [...l, "        --- SKIP: TestLinkDevAgainstOldCLI/piped-text-new-to-old/new-first (9.00s)"], /without its stated reason/],
    ];
    for (const [name, platform, f, expect] of mut) {
      const r = judge(platform, f(goodLog(platform)));
      need(r.code !== 0, `cli-go-matrix judge: "${name}" was judged green`);
      if (r.code !== 0) need(expect.test(r.err), `cli-go-matrix judge: "${name}" failed for the wrong reason: ${r.err.slice(0, 300)}`);
    }
    const reasoned = judge("linux", [...goodLog("linux"),
      "        --- SKIP: TestLinkDevAgainstOldCLI/piped-text-new-to-old/new-first (9.00s)",
      "            linkdev_test.go:723: today's direct race never connected in 6 attempts on this host"]);
    need(reasoned.code === 0, `cli-go-matrix judge: the one permitted, reasoned subtest skip must pass: ${reasoned.err.slice(0, 300)}`);
    const run = runJudge("bash", [join(interop, "cli-go-matrix.sh"), "run", "linux", join(scratch, "never-written")]);
    need(run.code !== 0 && /RELAYIUM_OLD_CLI is not set/.test(run.err),
      "cli-go-matrix.sh run must refuse to start without RELAYIUM_OLD_CLI (the old pairs would skip)");
  }

  // ── wiring ────────────────────────────────────────────────────────────
  {
    const wf = (name) => fullPathOf(name, readFileSync(join(repo, ".github", "workflows", name), "utf8"));
    /** The `run:` values of one job's steps, and the job's own header lines. */
    const job = (text, id) => {
      const lines = text.split("\n");
      const at = lines.findIndex((l) => l === `  ${id}:`);
      if (at < 0) return null;
      let end = lines.findIndex((l, i) => i > at && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
      if (end < 0) end = lines.length;
      return lines.slice(at, end).join("\n");
    };
    const checkWiring = (docs) => {
      const problems = [];
      const p = (m) => problems.push(m);
      const go = docs["go.yml"], nwp = docs["native-web-pairing.yml"], ai = docs["android-interop.yml"];
      const test = job(go, "test"), win = job(go, "cli-windows");
      if (!test || !/scripts\/interop\/build-old-cli\.sh/.test(test)) p("go.yml/test no longer builds the old CLI");
      if (!test || !/RELAYIUM_OLD_CLI=\$old" >> "\$GITHUB_ENV"/.test(test)) p("go.yml/test no longer exports RELAYIUM_OLD_CLI");
      if (!test || !/run: bash scripts\/interop\/cli-go-matrix\.sh run linux /.test(test)) p("go.yml/test no longer runs the CLI matrix on linux");
      if (!win || !/scripts\/interop\/build-old-cli\.sh/.test(win)) p("go.yml/cli-windows no longer builds the old CLI");
      if (!win || !/run: bash scripts\/interop\/cli-go-matrix\.sh run windows /.test(win)) p("go.yml/cli-windows no longer runs the CLI matrix by name");
      const cliWeb = job(nwp, "cli-web"), pairing = job(nwp, "pairing");
      if (!cliWeb || !/run: scripts\/interop\/cli-web-acceptance\.sh\s*$/m.test(cliWeb)) p("native-web-pairing.yml has no cli-web job running cli-web-acceptance.sh");
      if (!pairing || !/run: scripts\/interop\/cli-mac-acceptance\.sh\s*$/m.test(pairing)) p("native-web-pairing.yml/pairing no longer runs the CLI ↔ macOS cell");
      for (const [name, text] of [["cli-web", cliWeb], ["pairing", pairing]]) {
        if (text && /^\s{4}(if|continue-on-error):/m.test(text)) p(`native-web-pairing.yml/${name} gained an if:/continue-on-error escape`);
      }
      if (!/^\s+(RELAYIUM_ANDROID_PREBUILT=1 )?\.\/scripts\/interop\/cli-android-acceptance\.sh\s*$/m.test(ai)) p("android-interop.yml no longer runs the CLI ↔ Android cell");
      const watches = (doc, name, files) => {
        let paths;
        try { paths = readPushPaths(doc, name); } catch (e) { p(`${name}: push paths unreadable: ${e.message}`); return; }
        for (const f of files) if (!matchesFilter(paths, f)) p(`${name} does not trigger on ${f}, an input of its CLI cell`);
      };
      watches(go, "go.yml", ["scripts/interop/cli-go-matrix.sh", "scripts/interop/build-old-cli.sh", "server/cmd/relayium/pair.go"]);
      watches(nwp, "native-web-pairing.yml", ["scripts/interop/cli-web-acceptance.sh", "scripts/interop/cli-web-oracle.py",
        "scripts/interop/cli-mac-acceptance.sh", "scripts/interop/cli-mac-peer.mjs", "scripts/interop/cli-mac-oracle.py",
        "scripts/interop/cli-matrix-plan.py", "scripts/interop/cli-process.mjs", "web/e2e/cli-web-pairing.mjs", "server/cmd/relayium/pair.go"]);
      watches(ai, "android-interop.yml", ["scripts/interop/cli-android-acceptance.sh", "scripts/interop/cli-android-peer.mjs",
        "scripts/interop/cli-android-oracle.py", "scripts/interop/cli-matrix-plan.py", "scripts/interop/cli-process.mjs", "server/cmd/relayium/pair.go",
        // The CLI lane's accepted-socket grammar and final count are this file's.
        "scripts/test/android-interop-oracle.py", "server/main.go"]);
      return problems;
    };
    const docs = Object.fromEntries(["go.yml", "native-web-pairing.yml", "android-interop.yml"].map((n) => [n, wf(n)]));
    const real = checkWiring(docs);
    need(real.length === 0, `the A12 wiring is incomplete:\n    ${real.join("\n    ")}`);
    const mutations = [
      ["go.yml stops building the old CLI", "go.yml", (t) => t.replace(/old="\$\(scripts\/interop\/build-old-cli\.sh "\$RUNNER_TEMP\/relayium-old"\)"/, 'old=""'), /test no longer builds the old CLI/],
      ["go.yml drops the Windows matrix step", "go.yml", (t) => t.replace("run: bash scripts/interop/cli-go-matrix.sh run windows", "run: echo skipped"), /cli-windows no longer runs/],
      ["go.yml stops watching the matrix script", "go.yml", (t) => t.replace("      - 'scripts/interop/cli-go-matrix.sh'\n", ""), /does not trigger on scripts\/interop\/cli-go-matrix\.sh/],
      ["the cli-web job is deleted", "native-web-pairing.yml", (t) => t.replace("  cli-web:\n", "  cli-web-gone:\n"), /no cli-web job/],
      ["the cli-web job becomes advisory", "native-web-pairing.yml", (t) => t.replace("  cli-web:\n    runs-on: ubuntu-latest\n", "  cli-web:\n    runs-on: ubuntu-latest\n    continue-on-error: true\n"), /escape/],
      ["native-web-pairing stops watching the web oracle", "native-web-pairing.yml", (t) => t.replace("      - 'scripts/interop/cli-web-oracle.py'\n", ""), /does not trigger on scripts\/interop\/cli-web-oracle\.py/],
      ["the macOS step is removed", "native-web-pairing.yml", (t) => t.replace("run: scripts/interop/cli-mac-acceptance.sh", "run: true"), /CLI ↔ macOS/],
      ["android-interop drops the CLI cell", "android-interop.yml", (t) => t.replace(/^.*cli-android-acceptance\.sh\s*$\n/m, ""), /CLI ↔ Android/],
    ];
    for (const [name, file, f, expect] of mutations) {
      const mutated = { ...docs, [file]: f(docs[file]) };
      need(mutated[file] !== docs[file], `wiring mutation "${name}" did not change ${file} (stale mutation)`);
      const got = checkWiring(mutated);
      need(got.some((m) => expect.test(m)), `wiring mutation "${name}" was not detected (got: ${got.join("; ") || "nothing"})`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures) {
  console.error(`cli-interop-matrix-test: ${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`cli-interop-matrix-test: ${checks} checks passed (four judges shown a good round and each single fault; the CLI ↔ Android schedule and its accepted-socket prefix; A12 wiring and its mutations)`);
