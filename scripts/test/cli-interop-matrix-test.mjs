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
//   * an outcome the CLI reported the wrong number of times, a wrong exit code.
//
// Then the WIRING: the workflows run exactly these entry points, on the paths
// that feed them, with no `if:`/`continue-on-error` escape hatch — each also
// mutated away to prove the check notices.
//
// Runs in `compat.yml` (unfiltered), so it judges every change.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { matchesFilter, readPushPaths } from "../ci/select-lanes.mjs";

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
    const good = (cancel = "none") => {
      const root = join(scratch, `android-${n++}`);
      mkdirSync(root);
      const plan = JSON.parse(execFileSync("python3", [join(interop, "cli-matrix-plan.py"), "android", root, "2", "cli", cancel], { encoding: "utf8" }));
      for (const e of plan.android.expectSaved) writeFileSync(join(plan.dest, e.name), body(e.size, e.seed));
      const saved = [...(cancel === "receive" ? [] : plan.first), ...plan.second]
        .map((e) => ({ name: e.name, size: e.size, sha256: sha(body(e.size, e.seed)) }));
      const obs = {
        complete: true,
        cli: {
          stderr: [
            "linked with a Relayium app or the web page (end-to-end encrypted link/1, responder)",
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
    // The receive-cancel round has its own expectations.
    const rc = good("receive");
    rc.obs.cli.stderr = rc.obs.cli.stderr.filter((l, i, a) => !(l.startsWith("delivered") && a.indexOf(l) === i));
    rc.obs.cli.stderr.push("not delivered: the other side stopped the transfer");
    rc.obs.cli.exit.code = 1;
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
    rc.android.saved.push({ name: "cli-big-2.bin", size: 199000, sha256: sha(body(199000, 2)) });
    need(run(rc).code !== 0, "cli-android-oracle: a receive-cancel round in which Android kept the stopped batch was judged green");
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
    const wf = (name) => readFileSync(join(repo, ".github", "workflows", name), "utf8");
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
        "scripts/interop/cli-android-oracle.py", "scripts/interop/cli-matrix-plan.py", "scripts/interop/cli-process.mjs", "server/cmd/relayium/pair.go"]);
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
console.log(`cli-interop-matrix-test: ${checks} checks passed (four judges shown a good round and each single fault; A12 wiring and its mutations)`);
