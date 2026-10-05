#!/usr/bin/env node
// scripts/test/role-coverage-cap-test.mjs — every lane that asserts BOTH link
// roles either schedules both deterministically or samples enough rounds.
//
// ## Why this exists
//
// Where a lane still uses random hub ids, every round is a coin flip and a lane
// capped at N rounds misses a role in
// 2^-(N-1) of perfectly healthy runs. W-N19 (2026-09-22) raised two of the three
// lanes that assert role coverage to 10 and missed the third: the Windows
// `realtime` fixture kept a hard `Math.min(8, …)` clamp, and on 2026-09-23 run
// 35808231491 went red there with all eight rounds functionally green and the
// browser responder in every one of them — the 2^-7 tail. Nothing compared the
// three caps, so the drift was invisible until the coin landed.
//
// ## What it checks
//
// The cap is parsed out of the actual source of each lane, and the loop is
// checked to be bounded by that parsed value rather than by a literal:
//
//   - `apps/windows/test/smoke/realtime-pairing-acceptance.mjs`: the clamp AND
//     the default of `Math.min(<clamp>, Number(process.env.RT_ROUNDS ?? <default>))`,
//     independently. Lowering either one lowers the effective cap — the clamp
//     is what actually capped the 2026-09-23 run — so each is its own claim.
//   - `scripts/native-web-pairing-acceptance.sh`: exactly two rounds with
//     opposite deterministic peer-id orderings and an expected-role assertion.
//   - `scripts/android-interop-acceptance.sh`: DETERMINISTIC since 2026-10-02,
//     when ten green rounds all left the browser responder (run 36990034609;
//     cause unknown). Exactly three rounds with no override and no early
//     break; six globally distinct ids whose consecutive pairs imply exactly
//     the planned roles (responder, initiator, responder); the welcome barrier
//     ahead of the Android half, on both sides (`web/e2e/android-interop.mjs`
//     writes its exclusive 0600 receipt before waiting for the peer); the plan
//     handed to the oracle; the oracle still judging identities; and the final
//     accepted-socket count.
//   - The browser half's TWO real callers, run through the browser half's OWN
//     argument classifier (`node web/e2e/android-interop.mjs … --check-args`,
//     print-only, nothing read, spawned or written): the argv each caller's
//     source actually passes, with every shell variable replaced by a fixed
//     placeholder, must classify as `strict` for `android-interop-acceptance.sh`
//     and as `ui-session` for `android-ui-session-acceptance.sh` — the d5216a55d
//     regression, where the UI caller passed none of the strict barrier
//     arguments and its browser half exited 2 before Chrome, is RED here by
//     name. Neither caller may pass a diagnostic seam flag. The welcome
//     judgement itself is exercised through the print-only `--check-welcome`
//     seam on recorded wire histories (wrong id, repeated welcome, two
//     sockets, malformed id), never by writing a receipt.
//   - `scripts/interop/cli-android-acceptance.sh` (the CLI ↔ Android cell):
//     DETERMINISTIC since 2026-10-06, when hosted job 111971866405 ran eight
//     functionally green rounds with the CLI responder in all eight. The same
//     claims as the browser lane — three rounds, no override, no early break,
//     six distinct ids, CLI first, planned roles that the ids imply — plus its
//     own barrier: the app cleared, stopped and confirmed gone BEFORE the CLI
//     peer starts; the Android half only after the server's log shows the
//     CLI's socket 2r-1 accepted (an accepted socket, not a welcome); exactly
//     1..2r accepted at each round's end; the server stopped and its slot
//     retired before the unchanged six-socket `peer-id-log`; the plan carrying
//     the identity and the oracle judging it. The barrier's WAIT is not only
//     named: the real `await_cli_accepted` is extracted from the lane and run
//     in bash against real logs with the real oracle (pending then accepted,
//     an unfinished tail, a later socket, a wrong id, a gap, the CLI exiting,
//     the bound), with only the process/adb seams stubbed.
//
// Every statistical cap — only Windows samples now — must be equal to every
// other and at least FLOOR. It does not check what an environment override can
// do: the Windows override is downward-only by construction (the clamp), and
// overrides are diagnostic knobs that no workflow sets. A deterministic lane has
// no override at all.
//
// ## Why it lives here
//
// The three lanes live in `windows.yml`, `native-web-pairing.yml` and
// `android-interop.yml`, each behind its own path filter, so an edit to one
// lane never runs the others. `repo-hygiene.yml` has no path filter, needs no
// installed dependency (the CLI lane's barrier runs under the runner's own
// bash and python3), and runs this in a few seconds.
//
// ## Why it proves itself
//
// A parser that matched nothing, or matched something other than the live cap,
// would be as green as agreement. After the real evaluation every mutation below
// is applied to the REAL file contents in memory — each must actually change the
// text, and each must turn exactly its own claim red. There is deliberately no
// statistical test here: a random check on CI is a flake by construction.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/** Rounds every role-coverage lane must be able to run. At 10 a healthy run
 *  misses a role in 2^-9 (~0.2%), the value W-N19 chose. A statistical lane may
 *  run more rounds than this as long as all its caps move together. */
const FLOOR = 10;

const LANES = {
  windows: "apps/windows/test/smoke/realtime-pairing-acceptance.mjs",
  native: "scripts/native-web-pairing-acceptance.sh",
  android: "scripts/android-interop-acceptance.sh",
  androidOracle: "scripts/test/android-interop-oracle.py",
  androidBrowser: "web/e2e/android-interop.mjs",
  uiShell: "scripts/android-ui-session-acceptance.sh",
  cliAndroid: "scripts/interop/cli-android-acceptance.sh",
  cliAndroidOracle: "scripts/interop/cli-android-oracle.py",
  cliAndroidPlan: "scripts/interop/cli-matrix-plan.py",
};

const FIXTURE = new URL("../../web/e2e/android-interop.mjs", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "role-coverage-cap-"));
process.on("exit", () => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } });

/** Fixed placeholders for every shell variable a caller passes. A variable
 *  with no placeholder is a failure, never silently dropped. None of these
 *  paths is created: `--check-args` reads, spawns and writes nothing. */
const PLACEHOLDERS = {
  origin: "http://127.0.0.1:9",
  code: "123456",
  browser_out: join(scratch, "browser.json"),
  verify_mode: "default",
  web_message_text: "message",
  web_message: "message",
  plan: join(scratch, "plan.json"),
  round: "2",
  nonce: "0123456789abcdef0123456789abcdef",
  receipt: join(scratch, "welcome.json"),
  browser_planned_id: "0222222222222222",
};

/** The argv a caller's source passes to the browser half, substituted. */
function callerArgv(text) {
  const found = [...(text ?? "").matchAll(/exec node e2e\/android-interop\.mjs \\\n([\s\S]*?)\)/g)];
  if (found.length !== 1) return { error: `found ${found.length} invocations of the browser half, not one` };
  const argv = [];
  for (const m of found[0][1].replace(/\\\n/g, " ").matchAll(/"([^"]*)"|(\S+)/g)) {
    const token = m[1] ?? m[2];
    const variable = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(token);
    if (variable) {
      if (!(variable[1] in PLACEHOLDERS)) return { error: `no placeholder for $${variable[1]}` };
      argv.push(PLACEHOLDERS[variable[1]]);
    } else if (token.includes("$")) {
      return { error: `cannot substitute ${JSON.stringify(token)}` };
    } else {
      argv.push(token);
    }
  }
  return { argv };
}

/** The browser half's OWN classification of an argv (print-only seam).
 *  Memoised per argv: the seam is deterministic, and most mutations leave
 *  both callers' argv unchanged. */
const classified = new Map();
function classify(argv) {
  const key = JSON.stringify(argv);
  if (classified.has(key)) return classified.get(key);
  const r = spawnSync(process.execPath, [FIXTURE, ...argv, "--check-args"], { encoding: "utf8", timeout: 20_000 });
  let parsed = null;
  try { parsed = r.status === 0 ? JSON.parse(r.stdout) : null; } catch { parsed = null; }
  const result = { status: r.status, out: parsed, err: (r.stderr ?? "").trim() };
  classified.set(key, result);
  return result;
}

/** Both real callers, run through the real classifier. */
function evaluateCallers(w, problems) {
  for (const [lane, key, want, who] of [
    ["android", "callers:main", "strict", "the role-coverage lane's caller"],
    ["uiShell", "callers:ui", "ui-session", "the UI session caller"],
  ]) {
    const { argv, error } = callerArgv(w[lane]);
    if (error) {
      problems.push({ key, message: `${LANES[lane]}: ${error}` });
      continue;
    }
    const r = classify(argv);
    if (r.status !== 0 || r.out?.welcomeMode !== want) {
      problems.push({ key, message: `${who}'s argv is refused or misclassified by the browser half `
        + `(exit ${r.status}, mode ${JSON.stringify(r.out?.welcomeMode ?? null)}, want ${want}): ${r.err.split("\n").slice(1).join(" ")}` });
    }
    if (/--check-(?:args|welcome)\b/.test(w[lane] ?? "")) {
      problems.push({ key: "callers:seam", message: `${LANES[lane]} passes a diagnostic seam flag to the browser half` });
    }
  }
}

/** A lane file that cannot be read is reported as that lane's parse failure
 *  (with the reason) rather than as a stack trace. */
const unreadable = [];
const read = (p) => {
  try {
    return readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
  } catch (err) {
    unreadable.push(`${p}: ${err.code ?? err.message}`);
    return undefined;
  }
};

const realWorld = () => Object.fromEntries(Object.entries(LANES).map(([k, p]) => [k, read(p)]));

const WINDOWS_CAP =
  /^const MAX_ROUNDS = Math\.max\(1, Math\.min\((\d+), Number\(process\.env\.RT_ROUNDS \?\? (\d+)\)\)\);$/gm;
const WINDOWS_LOOP = /^\s*for \(let index = 1; index <= MAX_ROUNDS; index \+= 1\) \{$/gm;
const SHELL_LOOP = /^while \[ "\$round" -lt "\$max_rounds" \]; do$/gm;
const ANDROID_ROUNDS = /^max_rounds=(\S*)$/gm;
const ANDROID_IDS = /^acceptance_peer_ids="([^"\n]*)"$/gm;
const ANDROID_ROLES = /^planned_roles=\(([^)\n]*)\)$/gm;
const ID16 = /^[0-9a-f]{16}$/;
/** `linkRole` (web/src/lib/peer-link.svelte.ts): the smaller id offers. */
const roleOf = (self, peer) => (self < peer ? "initiator" : "responder");
const NATIVE_DETERMINISTIC = /^max_rounds=2$/gm;
const NATIVE_IDS = /^acceptance_peer_ids="ffffffffffffffff,0000000000000000,0000000000000000,ffffffffffffffff"$/gm;

/** Returns `{ problems: [{ key, message }], caps }`. `key` names the claim, so
 *  a mutation can be required to fail for ITS reason and not merely to fail. */
function evaluate(w) {
  const problems = [];
  const caps = []; // [{ key, value }]
  const exactlyOne = (key, text, re, what) => {
    const found = [...(text ?? "").matchAll(re)];
    if (found.length !== 1) {
      problems.push({ key, message: `${what}: expected exactly one match, found ${found.length} — the cap cannot be read, so it proves nothing` });
      return null;
    }
    return found[0];
  };

  const win = exactlyOne("windows:parse", w.windows, WINDOWS_CAP, `${LANES.windows} MAX_ROUNDS declaration`);
  if (win) {
    caps.push({ key: "windows:clamp", value: Number(win[1]) });
    caps.push({ key: "windows:default", value: Number(win[2]) });
  }
  exactlyOne("windows:loop", w.windows, WINDOWS_LOOP, `${LANES.windows} round loop bounded by MAX_ROUNDS`);

  evaluateAndroid(w, problems, exactlyOne);
  evaluateCliAndroid(w, problems, exactlyOne);
  evaluateCallers(w, problems);
  exactlyOne("native:deterministic-rounds", w.native, NATIVE_DETERMINISTIC, `${LANES.native} deterministic two-round declaration`);
  exactlyOne("native:deterministic-ids", w.native, NATIVE_IDS, `${LANES.native} opposite peer-id schedule`);
  if (!(w.native ?? "").includes('|| fail "round $round assigned browser role $role, want deterministic $expected_role"')) {
    problems.push({ key: "native:role-assertion", message: `${LANES.native} no longer fails when a scheduled role is not observed` });
  }

  for (const c of caps) {
    if (!(c.value >= FLOOR)) {
      problems.push({ key: `${c.key}:floor`, message: `${c.key} is ${c.value}, below the ${FLOOR}-round floor — a healthy run misses a role in 2^-${c.value - 1}` });
    }
  }
  const values = new Set(caps.map((c) => c.value));
  if (values.size > 1) {
    problems.push({ key: "equal", message: `the role-coverage caps disagree: ${caps.map((c) => `${c.key}=${c.value}`).join(", ")}` });
  }
  return { problems, caps };
}

/**
 * The Android lane's deterministic schedule, read from its real source. Each
 * claim has its own key, so a mutation must fail for ITS reason.
 */
function evaluateAndroid(w, problems, exactlyOne) {
  const text = w.android ?? "";
  const bad = (key, message) => problems.push({ key, message: `${LANES.android}: ${message}` });

  const rounds = exactlyOne("android:rounds", text, ANDROID_ROUNDS, `${LANES.android} max_rounds declaration`);
  if (rounds && rounds[1] !== "3") bad("android:rounds", `max_rounds is ${rounds[1]}, not exactly 3`);
  if (text.includes("RELAYIUM_ANDROID_ROUNDS")) {
    bad("android:override", "the round count can be overridden again; a deterministic lane runs exactly its schedule");
  }

  const loop = exactlyOne("android:loop", text, SHELL_LOOP, `${LANES.android} round loop bounded by max_rounds`);
  if (loop) {
    const body = text.slice(loop.index, text.indexOf("\ndone\n", loop.index));
    const code = body.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    if (/\bbreak\b/.test(code)) bad("android:no-break", "the round loop can break early; a round it skips is a scenario never run");
  }

  let ids = null;
  const idsMatch = exactlyOne("android:ids", text, ANDROID_IDS, `${LANES.android} peer-id schedule`);
  if (idsMatch) {
    const list = idsMatch[1].split(",");
    if (list.length !== 6) bad("android:ids", `the schedule has ${list.length} ids, not six (two per round)`);
    else if (!list.every((id) => ID16.test(id))) bad("android:ids", "a schedule id is not 16 lowercase hex characters");
    else if (new Set(list).size !== list.length) bad("android:ids", "the schedule repeats an id; rounds could match each other's evidence");
    else ids = list;
  }

  let roles = null;
  const rolesMatch = exactlyOne("android:roles", text, ANDROID_ROLES, `${LANES.android} planned roles`);
  if (rolesMatch) {
    const list = rolesMatch[1].trim().split(/\s+/);
    if (list.length !== 3 || !list.every((r) => r === "initiator" || r === "responder")) {
      bad("android:roles", `planned roles ${JSON.stringify(list)} are not three of initiator/responder`);
    } else if (!list.includes("initiator") || !list.includes("responder")) {
      bad("android:roles", `planned roles ${JSON.stringify(list)} never plan both roles`);
    } else {
      roles = list;
    }
  }
  if (ids && roles) {
    roles.forEach((want, r) => {
      const got = roleOf(ids[2 * r], ids[2 * r + 1]);
      if (got !== want) bad("android:schedule", `round ${r + 1}'s ids ${ids[2 * r]}/${ids[2 * r + 1]} make the browser ${got}, not the planned ${want}`);
    });
  }

  // The welcome barrier sits between the browser launch and the Android half.
  const launch = text.indexOf('--expect-self "$browser_planned_id"');
  const barrier = text.indexOf('\n  await_browser_welcome "$receipt"\n');
  const instrument = text.indexOf("adbs shell am instrument");
  if (!(launch >= 0 && barrier > launch && instrument > barrier)) {
    bad("android:barrier", "the Android half is no longer started only after the browser's welcome receipt");
  }

  for (const line of ['"plannedRole": planned_role,', '"expectedBrowserId": browser_planned_id,',
                      '"expectedAndroidId": android_planned_id,']) {
    if (!text.includes(line)) bad("android:plan-binding", `the round's expectation no longer carries ${line}`);
  }

  const stop = text.indexOf("\nstop_owned_server\n");
  const count = text.indexOf('android-interop-oracle.py" peer-id-log');
  const done = text.indexOf("\ncompleted=1");
  if (!(stop >= 0 && count > stop && done > count)) {
    bad("android:count", "the accepted-socket count no longer runs after the server stops and before the PASS");
  }

  // The browser half's side of the barrier: its own welcome is awaited (and
  // the receipt written, exclusively and 0600) BEFORE it waits for the Android
  // peer. That file needs a real Chrome to run, so its order is held here.
  const page = w.androidBrowser ?? "";
  const welcome = page.indexOf("\n    await awaitOwnWelcome(tab, joinDeadline);\n");
  const peerWait = page.indexOf('"the Android peer to join the code room"');
  if (!(welcome >= 0 && peerWait > welcome)
      || !page.includes('writeFileSync(temp, receipt, { flag: "wx", mode: 0o600 });')
      || !page.includes("linkSync(temp, READY);")) {
    problems.push({ key: "browser:barrier", message: `${LANES.androidBrowser} no longer writes its exclusive 0600 welcome receipt before waiting for the Android peer` });
  }

  if (!(w.androidOracle ?? "").includes("    problems.extend(judge_identity(browser, expect))\n")) {
    problems.push({ key: "oracle:identity", message: `${LANES.androidOracle} no longer judges each round's identities and wire roles` });
  }
}

// ── the CLI ↔ Android lane ───────────────────────────────────────────────

const CLI_ACCEPT_POLLS = /^cli_accept_polls=(\S*)$/gm;
const BARRIER_FN = /^await_cli_accepted\(\) \{\n[\s\S]*?\n\}\n/gm;
const STOP_APP_FN = /^stop_android_app\(\) \{\n[\s\S]*?\n\}\n/gm;
const SERVER_STOP_FN = /^stop_owned_server\(\) \{\n[\s\S]*?\n\}\n/gm;
const INTEROP_DIR = new URL("../interop/", import.meta.url).pathname;
const GO_FORMAT = /^const acceptancePeerIDLogFormat = "([^"\\]*)"$/m.exec(read("server/main.go") ?? "")?.[1] ?? "";

/** Index of `needle` in `text` at or after `from`, or -1. */
const at = (text, needle, from = 0) => (from < 0 ? -1 : text.indexOf(needle, from));
/** True when every needle is found, each starting after the previous one
 *  starts (needles may share their boundary newline). */
const inOrder = (text, needles, from = 0) => {
  let pos = from;
  for (const n of needles) {
    pos = at(text, n, pos);
    if (pos < 0) return false;
    pos += 1;
  }
  return true;
};

/**
 * The CLI lane's schedule and barrier, read from its real source. Each claim
 * has its own key, so a mutation must fail for ITS reason.
 */
function evaluateCliAndroid(w, problems, exactlyOne) {
  const text = w.cliAndroid ?? "";
  const bad = (key, message) => problems.push({ key, message: `${LANES.cliAndroid}: ${message}` });

  const rounds = exactlyOne("cliAndroid:rounds", text, ANDROID_ROUNDS, `${LANES.cliAndroid} max_rounds declaration`);
  if (rounds && rounds[1] !== "3") bad("cliAndroid:rounds", `max_rounds is ${rounds[1]}, not exactly 3`);
  if (text.includes("RELAYIUM_CLI_ANDROID_ROUNDS")) {
    bad("cliAndroid:override", "the round count can be overridden again; a deterministic lane runs exactly its schedule");
  }

  exactlyOne("cliAndroid:loop", text, SHELL_LOOP, `${LANES.cliAndroid} round loop bounded by max_rounds`);
  // The body is located by the loop's shape, not its bound, so a loop bounded
  // by a literal is red for that alone.
  const loop = /^while [^\n]*; do$/m.exec(text);
  let body = "";
  let afterLoop = -1;
  if (loop) {
    const end = text.indexOf("\ndone\n", loop.index);
    body = text.slice(loop.index, end < 0 ? text.length : end);
    afterLoop = end < 0 ? -1 : end;
    // The one-line `for …; do …; done` poll for the code file may break out
    // of ITSELF; nothing may break out of the round loop.
    const code = body.split("\n").filter((l) => !l.trim().startsWith("#")
      && !/^\s*for [^\n]*; do [^\n]*; done$/.test(l)).join("\n");
    if (/\bbreak\b/.test(code)) bad("cliAndroid:no-break", "the round loop can break early; a round it skips is a scenario never run");
  }

  let ids = null;
  const idsMatch = exactlyOne("cliAndroid:ids", text, ANDROID_IDS, `${LANES.cliAndroid} peer-id schedule`);
  if (idsMatch) {
    const list = idsMatch[1].split(",");
    if (list.length !== 6) bad("cliAndroid:ids", `the schedule has ${list.length} ids, not six (two per round)`);
    else if (!list.every((id) => ID16.test(id))) bad("cliAndroid:ids", "a schedule id is not 16 lowercase hex characters");
    else if (new Set(list).size !== list.length) bad("cliAndroid:ids", "the schedule repeats an id; rounds could match each other's evidence");
    else ids = list;
  }
  let roles = null;
  const rolesMatch = exactlyOne("cliAndroid:roles", text, ANDROID_ROLES, `${LANES.cliAndroid} planned roles`);
  if (rolesMatch) {
    const list = rolesMatch[1].trim().split(/\s+/);
    if (list.length !== 3 || !list.every((r) => r === "initiator" || r === "responder")) {
      bad("cliAndroid:roles", `planned roles ${JSON.stringify(list)} are not three of initiator/responder`);
    } else if (!list.includes("initiator") || !list.includes("responder")) {
      bad("cliAndroid:roles", `planned roles ${JSON.stringify(list)} never plan both roles`);
    } else {
      roles = list;
    }
  }
  // CLI first: round r's CLI is entry 2r-1, its role `linkwire.LinkRole`.
  if (ids && roles) {
    roles.forEach((want, r) => {
      const got = roleOf(ids[2 * r], ids[2 * r + 1]);
      if (got !== want) bad("cliAndroid:schedule", `round ${r + 1}'s ids ${ids[2 * r]}/${ids[2 * r + 1]} make the CLI ${got}, not the planned ${want}`);
    });
  }
  for (const line of ['  cli_planned_id="${peer_id_schedule[$((2 * round - 2))]:-}"\n',
                      '  android_planned_id="${peer_id_schedule[$((2 * round - 1))]:-}"\n',
                      '  planned_role="${planned_roles[$((round - 1))]:-}"\n']) {
    if (!body.includes(line)) bad("cliAndroid:assignment", `the round no longer takes ${line.trim()} (CLI first)`);
  }

  // Before the CLI peer exists: the app cleared, stopped, confirmed gone.
  if (!inOrder(body, ['\n  adbs shell pm clear "$app_id"', '\n  stop_android_app "before round', '\n  node "$here/cli-android-peer.mjs"'])) {
    bad("cliAndroid:reset", "the app is no longer cleared and confirmed stopped before the CLI peer starts");
  }
  // The CLI-first barrier: after the peer starts, before the Android half.
  if (!inOrder(body, ['\n  node "$here/cli-android-peer.mjs"', '\n  await_cli_accepted "$((2 * round - 1))"\n', "\n  adbs shell am instrument"])) {
    bad("cliAndroid:barrier", "the Android half is no longer started only after the server accepted the CLI's socket 2r-1");
  }
  // The round's end: CLI reaped, app stopped, exactly 1..2r accepted.
  if (!inOrder(body, ["\n  reap_cli_peer || peer_status=$?\n", '\n  stop_android_app "after round $round"\n',
                      '\n  python3 "$here/cli-android-oracle.py" accepted-prefix "$run_root/server.log" \\\n      "$acceptance_peer_ids" "$((2 * round))" \\\n    || fail '])) {
    bad("cliAndroid:round-end", "a round no longer ends by requiring exactly sockets 1..2r with the CLI reaped and the app stopped");
  }
  if (!body.includes('\n  [ "$role" = "$planned_role" ] \\\n    || fail ')) {
    bad("cliAndroid:role-assertion", "a round no longer fails when the CLI's role is not the planned one");
  }
  if (!body.includes(' "$cancel" \\\n      "$code" "$cli_planned_id" "$android_planned_id" "$planned_role" >"$plan" \\\n')) {
    bad("cliAndroid:plan-binding", "the round's plan no longer carries the planned ids and role");
  }
  const tail = afterLoop < 0 ? "" : text.slice(afterLoop);
  if (!tail.includes('\n[ "$round" -eq 3 ] || fail ')) {
    bad("cliAndroid:all-rounds", "the run no longer requires all three scheduled rounds");
  }
  if (!inOrder(tail, ['\nstop_android_app "before the final count"\n', "\nstop_owned_server\n",
                      '\npython3 "$repo/scripts/test/android-interop-oracle.py" peer-id-log \\\n    "$run_root/server.log" "$acceptance_peer_ids" \\\n  || fail ',
                      "\nassert_run_was_local\n", "\ncompleted=1"])) {
    bad("cliAndroid:count", "the six-socket count no longer runs after the app and the server stop and before the PASS");
  }
  const stop = exactlyOne("cliAndroid:server-stop", text, SERVER_STOP_FN, `${LANES.cliAndroid} stop_owned_server`);
  if (stop && !inOrder(stop[0], ['kill -TERM "$pid"', 'while owned_child_running "$pid"; do', '[ "$waited" -lt 100 ] || fail',
                                 '\n  wait "$pid" 2>/dev/null || true\n  retire_owned_child server "$pid"\n'])) {
    bad("cliAndroid:server-stop", "the server is no longer stopped, awaited, reaped and its one registry slot retired before the count");
  }
  // Signals reach only PIDs this run started: no pattern kills, no process
  // groups, no literal PIDs.
  const code = text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  const kills = [...code.matchAll(/(?:^|[\s;(&|])kill\s+([^\n]*)/gm)];
  const owned = kills.filter((m) => /^(?:-(?:TERM|KILL|0)\s+)?"\$[a-z_]*pid"(?:\s|$)/.test(m[1]));
  if (/\b(?:pkill|killall)\b/.test(code) || owned.length !== kills.length || kills.length === 0) {
    bad("cliAndroid:signals", "a signal is sent to something other than one owned PID variable");
  }
  const polls = exactlyOne("cliAndroid:accept-bound", text, CLI_ACCEPT_POLLS, `${LANES.cliAndroid} barrier bound`);
  if (polls && !(/^[1-9][0-9]*$/.test(polls[1]) && Number(polls[1]) <= 480)) {
    bad("cliAndroid:accept-bound", `the barrier bound ${polls[1]} is not a positive poll count of at most 480 (120 s)`);
  }
  const fn = [...text.matchAll(BARRIER_FN)];
  if (fn.length !== 1) {
    bad("cliAndroid:barrier-behavior", `found ${fn.length} await_cli_accepted definitions, not one`);
  } else if (ids) {
    const wrong = barrierBehavior(fn[0][0], ids);
    if (wrong.length) bad("cliAndroid:barrier-behavior", `the CLI-first barrier misbehaves when run:\n      ${wrong.join("\n      ")}`);
  }
  const stopFn = [...text.matchAll(STOP_APP_FN)];
  if (stopFn.length !== 1) {
    bad("cliAndroid:stop-behavior", `found ${stopFn.length} stop_android_app definitions, not one`);
  } else {
    const wrong = stopAppBehavior(stopFn[0][0]);
    if (wrong.length) bad("cliAndroid:stop-behavior", `the app-stop confirmation misbehaves when run:\n      ${wrong.join("\n      ")}`);
  }

  const oracle = w.cliAndroidOracle ?? "";
  if (!oracle.includes("\n    judge_identity(plan, role, p)\n")
      || !oracle.includes('    if len(argv) >= 2 and argv[1] == "accepted-prefix":\n        return accepted_prefix_main(argv)\n')) {
    problems.push({ key: "cliAndroidOracle:identity", message: `${LANES.cliAndroidOracle} no longer judges the planned identity or answers accepted-prefix` });
  }
  const plan = w.cliAndroidPlan ?? "";
  if (!plan.includes('        "identity": identity,\n') || !plan.includes('    elif len(argv) == 10 and argv[1] == "android":\n')) {
    problems.push({ key: "cliAndroidPlan:identity", message: `${LANES.cliAndroidPlan} no longer writes the round's planned identity` });
  }
}

/** One value as a single-quoted shell word: literal for bash, whatever it
 *  contains (`'` becomes `'\''`). Never JSON — `"…"` lets bash expand `$(…)`,
 *  backticks and `$var` inside it. */
const shq = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
/** A directory segment holding every character the fixtures' shell quoting
 *  must keep literal: a space, a single quote, a `$(…)` and a backtick
 *  command. If bash ever evaluated one, the harmless `touch` would leave its
 *  marker in the fixture's own directory (each run's cwd). */
const HOSTILE = "it's a $(touch r26-dollar-marker) `touch r26-backtick-marker` dir";
const MARKERS = ["r26-dollar-marker", "r26-backtick-marker"];
/** Problems if a fixture's shell did not keep its quoted values literal: the
 *  values it recorded differ from the ones given, or a marker appeared. */
function literalProblems(dir, given) {
  const out = [];
  let seen = null;
  try { seen = readFileSync(join(dir, "values"), "utf8").split("\0"); } catch { seen = null; }
  if (!seen || JSON.stringify(seen) !== JSON.stringify(given)) {
    out.push(`its shell values were not kept literal: ${JSON.stringify(seen)?.slice(0, 200)}`);
  }
  for (const m of MARKERS) if (existsSync(join(dir, m))) out.push(`its shell executed a quoted value (${m} created)`);
  return out;
}
/** The fixture line that records `names` NUL-separated next to the script. */
const recordValues = (names) => `{ ${names.map((n, i) => `printf '%s${i < names.length - 1 ? "\\0" : ""}' "$${n}"`).join("; ")}; } >"$(dirname "\${BASH_SOURCE[0]}")/values"`;

/**
 * The barrier's wait, RUN: the lane's own `await_cli_accepted` text in bash,
 * against server logs rendered from the real producer format and judged by the
 * real `cli-android-oracle.py`. Only the seams that would touch a process are
 * stubbed — `owned_child_running`, `stop_cli_peer`, `reap_cli_peer`, `fail` —
 * and `sleep`, which counts polls and can append the CLI's accept mid-wait.
 * Memoised per function text and schedule, so mutations elsewhere cost nothing.
 */
const behaviorCache = new Map();
function barrierBehavior(fnText, ids) {
  const cacheKey = `${fnText}\0${ids.join(",")}`;
  if (behaviorCache.has(cacheKey)) return behaviorCache.get(cacheKey);
  const problems = [];
  const line = (seq, id = ids[seq - 1]) => `2026/10/06 01:00:0${seq % 10} ${GO_FORMAT.replace("%d", String(seq)).replace("%s", id)}`;
  const log = (seqs, extra = []) => ["2026/10/06 01:00:00 relayium signaling server listening on 127.0.0.1:41234",
    ...seqs.map((q) => line(q)), ...extra].join("\n") + "\n";
  const SCENARIOS = [
    ["the CLI's socket already accepted", { log: log([1, 2, 3]) }, { exit: 0, polls: 0 }],
    ["pending, then the CLI's accept arrives", { log: log([1, 2]), appendAt: { 2: line(3) + "\n" } }, { exit: 0, polls: 2 }],
    ["only an unfinished tail, never completed (the bound)", { log: log([1, 2]) + line(3).slice(0, -4), limit: 3 },
      { exit: 1, polls: 3, stopped: true, says: /within 3 polls/ }],
    ["Android's socket accepted before the CLI's barrier", { log: log([1, 2, 3, 4]) }, { exit: 1, polls: 0, stopped: true, says: /cannot become/ }],
    ["the CLI's socket carried another id", { log: log([1, 2], [line(3, ids[0])]) }, { exit: 1, polls: 0, stopped: true, says: /cannot become/ }],
    ["a gap below the CLI's socket", { log: log([1, 3]) }, { exit: 1, polls: 0, stopped: true, says: /cannot become/ }],
    ["the CLI exited while the barrier waited", { log: log([1, 2]), exited: true },
      { exit: 1, polls: 0, reaped: true, says: /exited \(status 9\) before the server accepted its socket 3/ }],
    // An exact, valid prefix is NOT a handover when the CLI is already gone.
    ["the CLI's socket accepted, but the CLI already exited", { log: log([1, 2, 3]), exited: true },
      { exit: 1, polls: 0, reaped: true, says: /exited \(status 9\) by the time the server had accepted its socket 3; it is not handed over/ }],
    ["pending, then the CLI's accept arrives as the CLI exits", { log: log([1, 2]), appendAt: { 2: line(3) + "\n" }, exitAt: 2 },
      { exit: 1, polls: 2, reaped: true, says: /by the time the server had accepted its socket 3/ }],
  ];
  SCENARIOS.forEach(([name, given, want], i) => {
    const dir = join(scratch, `barrier-${behaviorCache.size}-${i} ${HOSTILE}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "server.log"), given.log);
    for (const [n, text] of Object.entries(given.appendAt ?? {})) writeFileSync(join(dir, `append-at-${n}`), text);
    if (given.exited) writeFileSync(join(dir, "cli-exited"), "");
    if (given.exitAt) writeFileSync(join(dir, `exit-at-${given.exitAt}`), "");
    const here = INTEROP_DIR.replace(/\/$/, "");
    const script = [
      "set -Eeuo pipefail",
      `here=${shq(here)}`,
      `run_root=${shq(dir)}`,
      `acceptance_peer_ids=${shq(ids.join(","))}`,
      "round=2", "peer_pid=4242", `cli_planned_id=${shq(ids[2])}`, `cli_accept_polls=${shq(given.limit ?? 5)}`,
      recordValues(["here", "run_root", "acceptance_peer_ids", "cli_planned_id"]),
      `say() { printf '%s\\n' "$*" >&2; }`,
      `fail() { printf 'FAIL: %s\\n' "$*" >&2; exit 1; }`,
      `stop_cli_peer() { printf 'STOPPED\\n' >&2; }`,
      `reap_cli_peer() { printf 'REAPED\\n' >&2; return 9; }`,
      `owned_child_running() { [ "$1" = 4242 ] && [ ! -e "$run_root/cli-exited" ]; }`,
      "polls_seen=0",
      `sleep() { polls_seen=$((polls_seen + 1)); printf '%s' "$polls_seen" >"$run_root/polls"; `
        + `[ "$polls_seen" -le 12 ] || { printf 'RUNAWAY\\n' >&2; exit 97; }; `
        + `if [ -e "$run_root/append-at-$polls_seen" ]; then cat "$run_root/append-at-$polls_seen" >>"$run_root/server.log"; fi; `
        + `if [ -e "$run_root/exit-at-$polls_seen" ]; then : >"$run_root/cli-exited"; fi; }`,
      fnText,
      "await_cli_accepted 3",
      `printf 'RETURNED\\n' >&2`,
    ].join("\n") + "\n";
    writeFileSync(join(dir, "run.sh"), script);
    const r = spawnSync("bash", [join(dir, "run.sh")], { cwd: dir, encoding: "utf8", timeout: 20_000 });
    const err = r.stderr ?? "";
    let polls = 0;
    try { polls = Number(readFileSync(join(dir, "polls"), "utf8")); } catch { polls = 0; }
    const got = [];
    if (r.status !== want.exit) got.push(`exit ${r.status}, want ${want.exit}`);
    if (want.exit === 0 && !/RETURNED/.test(err)) got.push("did not return");
    if (polls !== want.polls) got.push(`${polls} polls, want ${want.polls}`);
    if (/STOPPED/.test(err) !== Boolean(want.stopped)) got.push(want.stopped ? "the CLI peer was not stopped" : "the CLI peer was stopped");
    if (/REAPED/.test(err) !== Boolean(want.reaped)) got.push(want.reaped ? "the exited CLI peer was not reaped" : "a CLI peer was reaped");
    if (want.says && !want.says.test(err)) got.push(`no ${want.says} in its failure`);
    if (want.exit === 0 && !/accepted socket 3 as .* \(an accepted socket, not a welcome receipt\)/.test(err)) got.push("no accepted-socket (not welcome) line");
    got.push(...literalProblems(dir, [here, dir, ids.join(","), ids[2]]));
    if (got.length) problems.push(`barrier "${name}": ${got.join("; ")}: ${err.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`);
  });
  behaviorCache.set(cacheKey, problems);
  return problems;
}

/**
 * The app-stop confirmation, RUN: the lane's own `stop_android_app` text in
 * bash with only `adbs` (and `fail`) stubbed — a scripted force-stop status
 * and `pidof` stdout/stderr/status, every call recorded. Only `pidof` exiting
 * 1 with empty stdout and stderr is a confirmed absence. Memoised per text.
 */
const stopAppCache = new Map();
function stopAppBehavior(fnText) {
  if (stopAppCache.has(fnText)) return stopAppCache.get(fnText);
  const problems = [];
  const APP = "com.relayium.android.debug";
  const CALLS = [`shell am force-stop ${APP}`, `shell pidof ${APP}`];
  const SCENARIOS = [
    ["no app process (pidof 1, nothing printed)", { pidof: [1, "", ""] }, { exit: 0, calls: CALLS }],
    ["no app process, a bare CRLF from the device", { pidof: [1, "\r\n", ""] }, { exit: 0, calls: CALLS }],
    ["the app still running", { pidof: [0, "4321\r\n", ""] }, { exit: 1, calls: CALLS, says: /still running after force-stop before round 2's CLI peer starts \(pid 4321\)/ }],
    ["device offline, empty stdout (the R25 false absence)", { pidof: [1, "", "error: device offline\n"] },
      { exit: 1, calls: CALLS, says: /process query failed \(exit 1\): error: device offline/ }],
    ["a query error with a successful status", { pidof: [0, "", "error: closed\n"] }, { exit: 1, calls: CALLS, says: /process query failed \(exit 0\): error: closed/ }],
    ["an unexpected query status, nothing printed", { pidof: [255, "", ""] }, { exit: 1, calls: CALLS, says: /process query exited 255/ }],
    ["an unexpected query status 2", { pidof: [2, "", ""] }, { exit: 1, calls: CALLS, says: /process query exited 2/ }],
    ["exit 0 without a PID", { pidof: [0, "", ""] }, { exit: 1, calls: CALLS, says: /exited 0 without a PID/ }],
    ["exit 1 yet something printed", { pidof: [1, "1234", ""] }, { exit: 1, calls: CALLS, says: /exited 1 yet printed '1234'/ }],
    ["the force-stop failed", { force: 1, pidof: [1, "", ""] }, { exit: 1, calls: CALLS.slice(0, 1), says: /could not stop the app before round 2/ }],
  ];
  SCENARIOS.forEach(([name, given, want], i) => {
    const dir = join(scratch, `stop-app-${stopAppCache.size}-${i} ${HOSTILE}`);
    mkdirSync(dir);
    const [status, out, err] = given.pidof;
    const script = [
      "set -Eeuo pipefail",
      `run_root=${shq(dir)}`,
      `app_id=${shq(APP)}`,
      recordValues(["run_root", "app_id"]),
      `fail() { printf 'FAIL: %s\\n' "$*" >&2; exit 1; }`,
      `adbs() { printf '%s\\n' "$*" >>"$run_root/adb-calls"; case "$2" in `
        + `am) return ${shq(given.force ?? 0)} ;; `
        + `pidof) printf '%s' ${shq(out)}; printf '%s' ${shq(err)} >&2; return ${shq(status)} ;; `
        + `*) exit 98 ;; esac; }`,
      fnText,
      `stop_android_app "before round 2's CLI peer starts"`,
      `printf 'RETURNED\\n' >&2`,
    ].join("\n") + "\n";
    writeFileSync(join(dir, "run.sh"), script);
    const r = spawnSync("bash", [join(dir, "run.sh")], { cwd: dir, encoding: "utf8", timeout: 20_000 });
    const errText = r.stderr ?? "";
    let calls = [];
    try { calls = readFileSync(join(dir, "adb-calls"), "utf8").trim().split("\n"); } catch { calls = []; }
    const got = [];
    if (r.status !== want.exit) got.push(`exit ${r.status}, want ${want.exit}`);
    if ((want.exit === 0) !== /RETURNED/.test(errText)) got.push(want.exit === 0 ? "did not return" : "returned");
    if (JSON.stringify(calls) !== JSON.stringify(want.calls)) got.push(`adb calls ${JSON.stringify(calls)}, want ${JSON.stringify(want.calls)}`);
    if (want.says && !want.says.test(errText)) got.push(`no ${want.says} in its failure`);
    got.push(...literalProblems(dir, [dir, APP]));
    if (got.length) problems.push(`app stop "${name}": ${got.join("; ")}: ${errText.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`);
  });
  stopAppCache.set(fnText, problems);
  return problems;
}

let failed = 0;
const fail = (msg) => { failed++; console.error(`FAIL ${msg}`); };

const world = realWorld();
const real = evaluate(world);
for (const u of unreadable) fail(`cannot read ${u}`);
for (const p of real.problems) fail(`[${p.key}] ${p.message}`);
if (real.problems.length === 0 && real.caps.length !== 2) fail(`read ${real.caps.length} statistical caps, expected 2`);

/** Replace exactly one occurrence in one lane's real text. An anchor that is
 *  absent or ambiguous would make the mutation vacuous, so it throws. */
const mutate = (lane, from, to) => {
  const text = world[lane];
  if (text.split(from).length !== 2) throw new Error(`mutation anchor ${JSON.stringify(from)} is not unique in ${LANES[lane]}`);
  return { ...world, [lane]: text.replace(from, to) };
};

// Mutations only run once the real evaluation is clean, so both caps are
// read and equal. Anchors are built from those parsed values, not from FLOOR:
// lanes legitimately raised together above the floor must still find them.
const CAP = real.caps[0]?.value;
const LOW = FLOOR - 2; // below the floor; at 10 this is the 2026-09-23 value, 8
const HIGH = CAP + 2; // above the live cap, so it differs from the other three
const winLine = (clamp, dflt) => `Math.min(${clamp}, Number(process.env.RT_ROUNDS ?? ${dflt}))`;
const WIN_LINE = winLine(CAP, CAP);
const ANDROID_ID_LINE = /^acceptance_peer_ids="([^"\n]*)"$/m.exec(world.android ?? "")?.[1] ?? "";
const CLI_ID_LINE = /^acceptance_peer_ids="([^"\n]*)"$/m.exec(world.cliAndroid ?? "")?.[1] ?? "";
const swapIds = (csv, i, j) => { const l = csv.split(","); [l[i], l[j]] = [l[j], l[i]]; return l.join(","); };
const setId = (csv, i, v) => { const l = csv.split(","); l[i] = v; return l.join(","); };
// Each mutation: the world, and the exact set of problem keys it must produce.
const MUTATIONS = [
  ["windows clamp lowered alone (the 2026-09-23 shape)",
    () => mutate("windows", WIN_LINE, winLine(LOW, CAP)),
    ["windows:clamp:floor", "equal"]],
  ["windows default lowered alone",
    () => mutate("windows", WIN_LINE, winLine(CAP, LOW)),
    ["windows:default:floor", "equal"]],
  ["windows clamp raised alone (equality, not only the floor)",
    () => mutate("windows", WIN_LINE, winLine(HIGH, CAP)),
    ["equal"]],
  ["both windows caps lowered together (equal, but below the floor)",
    () => mutate("windows", WIN_LINE, winLine(LOW, LOW)),
    ["windows:clamp:floor", "windows:default:floor"]],
  ["windows declaration rewritten into a form the parser does not know",
    () => mutate("windows", WIN_LINE, `Number(process.env.RT_ROUNDS ?? ${CAP})`),
    ["windows:parse"]],
  ["windows declaration duplicated (which one is live?)",
    () => mutate("windows", "const MAX_ROUNDS =", `const MAX_ROUNDS = Math.max(1, ${WIN_LINE});\nconst MAX_ROUNDS =`),
    ["windows:parse"]],
  ["windows loop bounded by a literal instead of MAX_ROUNDS",
    () => mutate("windows", "index <= MAX_ROUNDS;", "index <= 8;"),
    ["windows:loop"]],
  ["native deterministic schedule removed",
    () => mutate("native", "max_rounds=2", "max_rounds=3"),
    ["native:deterministic-rounds"]],
  ["native peer-id ordering weakened",
    () => mutate("native", "ffffffffffffffff,0000000000000000,0000000000000000,ffffffffffffffff", "ffffffffffffffff,0000000000000000"),
    ["native:deterministic-ids"]],
  ["native expected-role failure removed",
    () => mutate("native", '|| fail "round $round assigned browser role $role, want deterministic $expected_role"', "|| true"),
    ["native:role-assertion"]],
  ["android loop bounded by a literal",
    () => mutate("android", `-lt "$max_rounds" ]; do`, `-lt 8 ]; do`),
    ["android:loop"]],
  ["android runs a fourth round",
    () => mutate("android", "\nmax_rounds=3\n", "\nmax_rounds=4\n"),
    ["android:rounds"]],
  ["android round count overridable again (the old statistical tail)",
    () => mutate("android", "\nmax_rounds=3\n", '\nmax_rounds="${RELAYIUM_ANDROID_ROUNDS:-3}"\n'),
    ["android:override", "android:rounds"]],
  ["android loop breaks early (the third round skipped)",
    () => mutate("android", '  say "-- round $round passed (browser was $role, as planned)"\ndone\n',
                 '  say "-- round $round passed (browser was $role, as planned)"\n  [ "$round" -lt 2 ] || break\ndone\n'),
    ["android:no-break"]],
  ["android schedule repeats an id across rounds",
    () => mutate("android", ANDROID_ID_LINE, setId(ANDROID_ID_LINE, 2, ANDROID_ID_LINE.split(",")[1])),
    ["android:ids"]],
  ["android schedule loses a round's ids",
    () => mutate("android", ANDROID_ID_LINE, ANDROID_ID_LINE.split(",").slice(0, 4).join(",")),
    ["android:ids"]],
  ["android schedule pair reordered (round 2 no longer plans the browser initiator)",
    () => mutate("android", ANDROID_ID_LINE, swapIds(ANDROID_ID_LINE, 2, 3)),
    ["android:schedule"]],
  ["android plans the browser responder in every round",
    () => mutate("android", "planned_roles=(responder initiator responder)", "planned_roles=(responder responder responder)"),
    ["android:roles"]],
  ["android welcome barrier removed",
    () => mutate("android", '\n  await_browser_welcome "$receipt"\n', "\n"),
    ["android:barrier"]],
  ["android plan no longer handed to the oracle",
    () => mutate("android", '"plannedRole": planned_role,', '"plannedRole": "responder",'),
    ["android:plan-binding"]],
  ["android accepted-socket count removed",
    () => mutate("android", 'android-interop-oracle.py" peer-id-log', 'android-interop-oracle.py" --version'),
    ["android:count"]],
  ["browser half waits for the peer without its own welcome first",
    () => mutate("androidBrowser", "\n    await awaitOwnWelcome(tab, joinDeadline);\n", "\n"),
    ["browser:barrier"]],
  ["browser half writes a receipt others can read",
    () => mutate("androidBrowser", 'writeFileSync(temp, receipt, { flag: "wx", mode: 0o600 });', 'writeFileSync(temp, receipt, { mode: 0o644 });'),
    ["browser:barrier"]],
  ["android oracle stops judging identities",
    () => mutate("androidOracle", "    problems.extend(judge_identity(browser, expect))\n", "\n"),
    ["oracle:identity"]],
  ["android file unreadable (empty)",
    () => ({ ...world, android: "" }),
    ["android:rounds", "android:loop", "android:ids", "android:roles", "android:barrier",
     "android:plan-binding", "android:plan-binding", "android:plan-binding", "android:count", "callers:main"]],
  ["UI caller without its welcome mode (the d5216a55d regression)",
    () => mutate("uiShell", '--plan "$plan" \\\n    --welcome-mode ui-session ) \\', '--plan "$plan" ) \\'),
    ["callers:ui"]],
  ["UI caller passes a strict barrier argument too (mixed)",
    () => mutate("uiShell", "    --welcome-mode ui-session ) \\", '    --welcome-mode ui-session --round "$round" ) \\'),
    ["callers:ui"]],
  ["UI caller asks for strict",
    () => mutate("uiShell", "    --welcome-mode ui-session ) \\", "    --welcome-mode strict ) \\"),
    ["callers:ui"]],
  ["UI caller passes a diagnostic seam",
    () => mutate("uiShell", "    --welcome-mode ui-session ) \\", "    --welcome-mode ui-session --check-args ) \\"),
    ["callers:seam"]],
  ["role-coverage caller downgraded to ui-session",
    () => mutate("android", '--expect-self "$browser_planned_id"', '--expect-self "$browser_planned_id" --welcome-mode ui-session'),
    ["callers:main"]],
  ["role-coverage caller loses --round",
    () => mutate("android", ' --round "$round" --nonce', " --nonce"),
    ["callers:main"]],
  ["role-coverage caller loses --nonce",
    () => mutate("android", ' --nonce "$nonce"', ""),
    ["callers:main"]],
  ["role-coverage caller loses --ready",
    () => mutate("android", ' --ready "$receipt"', ""),
    ["callers:main"]],
  ["role-coverage caller loses --expect-self",
    () => mutate("android", ' --expect-self "$browser_planned_id"', ""),
    ["callers:main", "android:barrier"]],
  ["role-coverage caller passes a variable with no placeholder",
    () => mutate("android", '--code "$code"', '--code "$mystery_code"'),
    ["callers:main"]],
  ["windows file missing",
    () => ({ ...world, windows: undefined }),
    ["windows:parse", "windows:loop"]],

  // ── the CLI ↔ Android lane ──
  ["cli-android runs a fourth round",
    () => mutate("cliAndroid", "\nmax_rounds=3\n", "\nmax_rounds=4\n"),
    ["cliAndroid:rounds"]],
  ["cli-android round count overridable again (the hosted 111971866405 shape)",
    () => mutate("cliAndroid", "\nmax_rounds=3\n", '\nmax_rounds="${RELAYIUM_CLI_ANDROID_ROUNDS:-8}"\n'),
    ["cliAndroid:override", "cliAndroid:rounds"]],
  ["cli-android loop bounded by a literal",
    () => mutate("cliAndroid", `-lt "$max_rounds" ]; do`, `-lt 8 ]; do`),
    ["cliAndroid:loop"]],
  ["cli-android loop breaks early once both cells are seen (the old shape)",
    () => mutate("cliAndroid", '  say "-- round $round passed (CLI was $role, as planned)"\ndone\n',
                 '  say "-- round $round passed (CLI was $role, as planned)"\n  [ "$round" -lt 2 ] || break\ndone\n'),
    ["cliAndroid:no-break"]],
  ["cli-android schedule repeats an id across rounds",
    () => mutate("cliAndroid", CLI_ID_LINE, setId(CLI_ID_LINE, 2, CLI_ID_LINE.split(",")[1])),
    ["cliAndroid:ids"]],
  ["cli-android schedule loses a round's ids",
    () => mutate("cliAndroid", CLI_ID_LINE, CLI_ID_LINE.split(",").slice(0, 4).join(",")),
    ["cliAndroid:ids"]],
  ["cli-android schedule pair reordered (round 2 no longer plans the CLI initiator)",
    () => mutate("cliAndroid", CLI_ID_LINE, swapIds(CLI_ID_LINE, 2, 3)),
    ["cliAndroid:schedule"]],
  ["cli-android plans the CLI responder in every round (the hosted failure, planned)",
    () => mutate("cliAndroid", "planned_roles=(responder initiator responder)", "planned_roles=(responder responder responder)"),
    ["cliAndroid:roles"]],
  ["cli-android hands the CLI Android's entry (Android first)",
    () => mutate("cliAndroid", 'cli_planned_id="${peer_id_schedule[$((2 * round - 2))]:-}"', 'cli_planned_id="${peer_id_schedule[$((2 * round - 1))]:-}"'),
    ["cliAndroid:assignment"]],
  ["cli-android no longer confirms the app stopped before the CLI starts",
    () => mutate("cliAndroid", `  stop_android_app "before round $round's CLI peer starts"\n`, ""),
    ["cliAndroid:reset"]],
  ["cli-android clears the app only after the CLI peer started (the old order)",
    () => mutate("cliAndroid", `  adbs shell pm clear "$app_id" >/dev/null 2>&1 \\\n    || fail "could not reset the app's data before round $round"\n`, ""),
    ["cliAndroid:reset"]],
  ["cli-android starts the Android half on the code file alone (barrier removed)",
    () => mutate("cliAndroid", '  await_cli_accepted "$((2 * round - 1))"\n', ""),
    ["cliAndroid:barrier"]],
  ["cli-android barrier waits for Android's sequence instead of the CLI's",
    () => mutate("cliAndroid", 'await_cli_accepted "$((2 * round - 1))"', 'await_cli_accepted "$((2 * round))"'),
    ["cliAndroid:barrier"]],
  ["cli-android round end checks only the CLI's socket",
    () => mutate("cliAndroid", '"$acceptance_peer_ids" "$((2 * round))" \\\n    || fail "after round', '"$acceptance_peer_ids" "$((2 * round - 1))" \\\n    || fail "after round'),
    ["cliAndroid:round-end"]],
  ["cli-android round end counts while the app may still run",
    () => mutate("cliAndroid", '  stop_android_app "after round $round"\n', ""),
    ["cliAndroid:round-end"]],
  ["cli-android stops asserting the planned role",
    () => mutate("cliAndroid", '[ "$role" = "$planned_role" ] \\\n    || fail ', '[ "$role" = "$planned_role" ] \\\n    || say '),
    ["cliAndroid:role-assertion"]],
  ["cli-android plan built without the schedule (legacy identity null)",
    () => mutate("cliAndroid", '"$code" "$cli_planned_id" "$android_planned_id" "$planned_role" >"$plan"', '"$code" >"$plan"'),
    ["cliAndroid:plan-binding"]],
  ["cli-android passes with fewer than three rounds",
    () => mutate("cliAndroid", '[ "$round" -eq 3 ] || fail "ran', '[ "$round" -ge 1 ] || fail "ran'),
    ["cliAndroid:all-rounds"]],
  ["cli-android counts before the server stops",
    () => mutate("cliAndroid", '\nstop_owned_server\npython3 "$repo/scripts/test/android-interop-oracle.py" peer-id-log \\\n    "$run_root/server.log" "$acceptance_peer_ids" \\\n  || fail "the server did not accept exactly the scheduled websockets"\n',
                 '\npython3 "$repo/scripts/test/android-interop-oracle.py" peer-id-log \\\n    "$run_root/server.log" "$acceptance_peer_ids" \\\n  || fail "the server did not accept exactly the scheduled websockets"\nstop_owned_server\n'),
    ["cliAndroid:count"]],
  ["cli-android six-socket count removed",
    () => mutate("cliAndroid", 'android-interop-oracle.py" peer-id-log', 'android-interop-oracle.py" --version'),
    ["cliAndroid:count"]],
  ["cli-android leaves the stopped server's PID in the cleanup registry",
    () => mutate("cliAndroid", '  retire_owned_child server "$pid"\n', ""),
    ["cliAndroid:server-stop"]],
  ["cli-android counts without waiting for the server to exit",
    () => mutate("cliAndroid", 'while owned_child_running "$pid"; do', "while false; do"),
    ["cliAndroid:server-stop"]],
  ["cli-android stops the server by pattern",
    () => mutate("cliAndroid", '  kill -TERM "$pid" 2>/dev/null || fail "could not signal the owned server', '  pkill -f relayium-server || fail "could not signal the owned server'),
    ["cliAndroid:server-stop", "cliAndroid:signals"]],
  ["cli-android signals its whole process group",
    () => mutate("cliAndroid", 'kill -TERM "$peer_pid" 2>/dev/null || true', "kill -TERM 0 2>/dev/null || true"),
    ["cliAndroid:signals"]],
  ["cli-android barrier effectively unbounded",
    () => mutate("cliAndroid", "\ncli_accept_polls=240\n", "\ncli_accept_polls=100000\n"),
    ["cliAndroid:accept-bound"]],
  ["cli-android barrier treats a short prefix as accepted",
    () => mutate("cliAndroid", "      3) ;;\n", "      3) break ;;\n"),
    ["cliAndroid:barrier-behavior"]],
  ["cli-android barrier retries what waiting cannot fix",
    () => mutate("cliAndroid", `fail "round $round: the server's accepted sockets cannot become`, `say "round $round: the server's accepted sockets cannot become`),
    ["cliAndroid:barrier-behavior"]],
  ["cli-android barrier ignores the CLI peer exiting",
    () => mutate("cliAndroid", '    if ! owned_child_running "$peer_pid"; then\n', "    if false; then\n"),
    ["cliAndroid:barrier-behavior"]],
  ["cli-android barrier has no bound",
    () => mutate("cliAndroid", '    if [ "$polls" -ge "$cli_accept_polls" ]; then\n', "    if false; then\n"),
    ["cliAndroid:barrier-behavior"]],
  ["cli-android barrier hands over a CLI that already exited (the R25 shape)",
    () => mutate("cliAndroid", "      0) ;;\n", "      0) break ;;\n"),
    ["cliAndroid:barrier-behavior"]],
  ["cli-android takes a failed process query with empty stdout as absence (the R25 shape)",
    () => mutate("cliAndroid", '  if [ -s "$query.err" ]; then\n', "  if false; then\n"),
    ["cliAndroid:stop-behavior"]],
  ["cli-android accepts any process-query status",
    () => mutate("cliAndroid", '    *) fail "could not confirm the app stopped $1: its process query exited $status" ;;\n', "    *) ;;\n"),
    ["cliAndroid:stop-behavior"]],
  ["cli-android ignores a live app PID",
    () => mutate("cliAndroid", "    0)\n      [ -n \"$pids\" ] \\\n", "    0) return 0 ;;\n    9)\n      [ -n \"$pids\" ] \\\n"),
    ["cliAndroid:stop-behavior"]],
  ["cli-android ignores a failed force-stop",
    () => mutate("cliAndroid", '    || fail "could not stop the app $1"\n', "    || true\n"),
    ["cliAndroid:stop-behavior"]],
  ["cli-android barrier reads another log",
    () => mutate("cliAndroid", 'accepted-prefix "$run_root/server.log" \\\n        "$acceptance_peer_ids" "$want"', 'accepted-prefix "$run_root/client.log" \\\n        "$acceptance_peer_ids" "$want"'),
    ["cliAndroid:barrier-behavior"]],
  ["cli-android oracle stops judging the planned identity",
    () => mutate("cliAndroidOracle", "\n    judge_identity(plan, role, p)\n", "\n"),
    ["cliAndroidOracle:identity"]],
  ["cli-android plan generator drops the identity",
    () => mutate("cliAndroidPlan", '        "identity": identity,\n', '        "identity": None,\n'),
    ["cliAndroidPlan:identity"]],
  ["cli-android file unreadable (empty)",
    () => ({ ...world, cliAndroid: "" }),
    ["cliAndroid:rounds", "cliAndroid:loop", "cliAndroid:ids", "cliAndroid:roles", "cliAndroid:assignment",
     "cliAndroid:assignment", "cliAndroid:assignment", "cliAndroid:reset", "cliAndroid:barrier", "cliAndroid:round-end",
     "cliAndroid:role-assertion", "cliAndroid:plan-binding", "cliAndroid:all-rounds", "cliAndroid:count",
     "cliAndroid:server-stop", "cliAndroid:signals", "cliAndroid:accept-bound", "cliAndroid:barrier-behavior",
     "cliAndroid:stop-behavior"]],
];

// ── the browser half's own contract, run directly ──────────────────────────
//
// Not per-mutation: these exercise the fixture's classifier and its welcome
// judgement on fixed inputs. Every case names what it must produce.
const BASE = ["--origin", PLACEHOLDERS.origin, "--code", "123456", "--out", PLACEHOLDERS.browser_out,
              "--plan", PLACEHOLDERS.plan];
const STRICT = ["--round", "2", "--nonce", PLACEHOLDERS.nonce, "--ready", PLACEHOLDERS.receipt,
                "--expect-self", "0222222222222222"];
let contracts = 0;
const contract = (name, argv, want) => {
  const r = classify(argv);
  const ok = want.mode ? (r.status === 0 && r.out?.welcomeMode === want.mode)
    : (r.status === 2 && want.reason.test(r.err));
  if (ok) contracts++;
  else fail(`contract "${name}": exit ${r.status}, mode ${JSON.stringify(r.out?.welcomeMode ?? null)}: ${r.err.slice(0, 300)}`);
};
if (failed === 0) {
  contract("strict, default mode", [...BASE, ...STRICT], { mode: "strict" });
  contract("strict, explicit mode", [...BASE, ...STRICT, "--welcome-mode", "strict"], { mode: "strict" });
  contract("ui-session", [...BASE, "--welcome-mode", "ui-session"], { mode: "ui-session" });
  contract("no mode and no barrier arguments (the UI caller before this fix)", [...BASE],
    { reason: /strict mode requires --round/ });
  for (let i = 0; i < STRICT.length; i += 2) {
    const without = [...STRICT.slice(0, i), ...STRICT.slice(i + 2)];
    contract(`strict without ${STRICT[i]}`, [...BASE, ...without],
      { reason: new RegExp(`strict mode requires ${STRICT[i]}`) });
  }
  for (let i = 0; i < STRICT.length; i += 2) {
    contract(`ui-session with ${STRICT[i]}`, [...BASE, "--welcome-mode", "ui-session", STRICT[i], STRICT[i + 1]],
      { reason: new RegExp(`ui-session mode refuses the strict barrier arguments ${STRICT[i]}`) });
  }
  contract("strict with a malformed --expect-self", [...BASE, ...STRICT.slice(0, 6), "--expect-self", "0222"],
    { reason: /--expect-self as 16 lowercase hex/ });
  contract("an unknown mode", [...BASE, "--welcome-mode", "relaxed"], { reason: /must be one of strict, ui-session/ });
  contract("a mode flag with no value", [...BASE, "--welcome-mode"], { reason: /must be one of strict, ui-session/ });
  contract("no plan", ["--origin", PLACEHOLDERS.origin, "--code", "1", "--out", PLACEHOLDERS.browser_out, ...STRICT],
    { reason: /--plan is required/ });

  // The welcome judgement, through the print-only seam: never a receipt.
  const SELF = "0222222222222222";
  const wire = (sockets) => ({ sockets: sockets.map((welcomes) => ({ path: "/ws", welcomes, rosters: [], lefts: [], signals: [] })) });
  const verdict = (name, mode, history, want) => {
    const file = join(scratch, `wire-${contracts}-${name.replace(/[^a-z]+/gi, "-")}.json`);
    writeFileSync(file, JSON.stringify(history));
    const argv = mode === "strict" ? [...BASE, ...STRICT] : [...BASE, "--welcome-mode", "ui-session"];
    const r = spawnSync(process.execPath, [FIXTURE, ...argv, "--check-welcome", file], { encoding: "utf8", timeout: 20_000 });
    let v = null;
    try { v = JSON.parse(r.stdout); } catch { v = null; }
    const ok = r.status === 0 && v && (want.ok ? v.ok === true && v.selfId === want.selfId : v.ok === false && want.reason.test(v.problem));
    if (ok) contracts++;
    else fail(`welcome "${name}" (${mode}): exit ${r.status}, verdict ${r.stdout.trim().slice(0, 300)} ${r.stderr.trim().slice(0, 200)}`);
  };
  verdict("the planned id, one socket, one welcome", "strict", wire([[SELF]]), { ok: true, selfId: SELF });
  verdict("another id than planned", "strict", wire([["f333333333333333"]]), { reason: /but the schedule planned 0222222222222222/ });
  verdict("a repeated welcome", "strict", wire([[SELF, SELF]]), { reason: /saw 2 welcomes/ });
  verdict("two sockets", "strict", wire([[SELF], []]), { reason: /opened 2 websockets/ });
  verdict("a malformed id", "strict", wire([["0222"]]), { reason: /malformed id/ });
  verdict("no welcome at all", "strict", wire([[]]), { reason: /saw 0 welcomes/ });
  verdict("a random production id", "ui-session", wire([["9a8b7c6d5e4f3a2b"]]), { ok: true, selfId: "9a8b7c6d5e4f3a2b" });
  verdict("a repeated welcome", "ui-session", wire([["9a8b7c6d5e4f3a2b", "1111111111111111"]]), { reason: /saw 2 welcomes/ });
  verdict("two sockets", "ui-session", wire([["9a8b7c6d5e4f3a2b"], ["1111111111111111"]]), { reason: /opened 2 websockets/ });
  verdict("a malformed id", "ui-session", wire([["NOT-HEX-AT-ALL!!"]]), { reason: /malformed id/ });
}

let caught = 0;
if (failed === 0) {
  for (const [name, build, expected] of MUTATIONS) {
    let got;
    try {
      got = evaluate(build()).problems.map((p) => p.key).sort();
    } catch (err) {
      fail(`mutation "${name}" could not be built: ${err.message}`);
      continue;
    }
    const want = [...expected].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      fail(`mutation "${name}" produced ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    } else {
      caught++;
    }
  }
}

if (failed > 0) {
  console.error(`\nrole-coverage-cap: ${failed} failure(s)`);
  process.exit(1);
}
console.log(`ok role-coverage-cap: ${real.caps.map((c) => `${c.key}=${c.value}`).join(" ")} (floor ${FLOOR}); `
  + `${caught} mutations each red for its own claim; ${contracts} browser-half contract cases`);
