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
// dependency, and runs this in well under a second.
//
// ## Why it proves itself
//
// A parser that matched nothing, or matched something other than the live cap,
// would be as green as agreement. After the real evaluation every mutation below
// is applied to the REAL file contents in memory — each must actually change the
// text, and each must turn exactly its own claim red. There is deliberately no
// statistical test here: a random check on CI is a flake by construction.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** The browser half's OWN classification of an argv (print-only seam). */
function classify(argv) {
  const r = spawnSync(process.execPath, [FIXTURE, ...argv, "--check-args"], { encoding: "utf8", timeout: 20_000 });
  let parsed = null;
  try { parsed = r.status === 0 ? JSON.parse(r.stdout) : null; } catch { parsed = null; }
  return { status: r.status, out: parsed, err: (r.stderr ?? "").trim() };
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
