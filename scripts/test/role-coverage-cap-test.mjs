#!/usr/bin/env node
// scripts/test/role-coverage-cap-test.mjs — the three lanes that assert BOTH
// link roles were seen run the same number of rounds, and enough of them.
//
// ## Why this exists
//
// The link role is `selfId < peerId` over the hub's random ids, so every round
// is an independent coin flip and a lane capped at N rounds misses a role in
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
//   - `scripts/native-web-pairing-acceptance.sh` and
//     `scripts/android-interop-acceptance.sh`: the `${VAR:-<default>}` default.
//
// Every parsed number must be equal to every other and at least FLOOR. It does
// not check what an environment override can do: the Windows override is
// downward-only by construction (the clamp), and overrides are diagnostic knobs
// that no workflow sets.
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

import { readFileSync } from "node:fs";

/** Rounds every role-coverage lane must be able to run. At 10 a healthy run
 *  misses a role in 2^-9 (~0.2%), the value W-N19 chose. The lanes may run more
 *  rounds than this as long as all four caps move together. */
const FLOOR = 10;

const LANES = {
  windows: "apps/windows/test/smoke/realtime-pairing-acceptance.mjs",
  native: "scripts/native-web-pairing-acceptance.sh",
  android: "scripts/android-interop-acceptance.sh",
};

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
const shellCap = (v) => new RegExp(`^max_rounds="\\$\\{${v}:-(\\d+)\\}"$`, "gm");
const SHELL_LOOP = /^while \[ "\$round" -lt "\$max_rounds" \]; do$/gm;
const SHELL_VARS = { native: "RELAYIUM_PAIRING_ROUNDS", android: "RELAYIUM_ANDROID_ROUNDS" };

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

  for (const lane of ["native", "android"]) {
    const m = exactlyOne(`${lane}:parse`, w[lane], shellCap(SHELL_VARS[lane]), `${LANES[lane]} max_rounds default`);
    if (m) caps.push({ key: `${lane}:default`, value: Number(m[1]) });
    exactlyOne(`${lane}:loop`, w[lane], SHELL_LOOP, `${LANES[lane]} round loop bounded by max_rounds`);
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

let failed = 0;
const fail = (msg) => { failed++; console.error(`FAIL ${msg}`); };

const world = realWorld();
const real = evaluate(world);
for (const u of unreadable) fail(`cannot read ${u}`);
for (const p of real.problems) fail(`[${p.key}] ${p.message}`);
if (real.problems.length === 0 && real.caps.length !== 4) fail(`read ${real.caps.length} caps, expected 4`);

/** Replace exactly one occurrence in one lane's real text. An anchor that is
 *  absent or ambiguous would make the mutation vacuous, so it throws. */
const mutate = (lane, from, to) => {
  const text = world[lane];
  if (text.split(from).length !== 2) throw new Error(`mutation anchor ${JSON.stringify(from)} is not unique in ${LANES[lane]}`);
  return { ...world, [lane]: text.replace(from, to) };
};

// Mutations only run once the real evaluation is clean, so all four caps are
// read and equal. Anchors are built from those parsed values, not from FLOOR:
// lanes legitimately raised together above the floor must still find them.
const CAP = real.caps[0]?.value;
const LOW = FLOOR - 2; // below the floor; at 10 this is the 2026-09-23 value, 8
const HIGH = CAP + 2; // above the live cap, so it differs from the other three
const winLine = (clamp, dflt) => `Math.min(${clamp}, Number(process.env.RT_ROUNDS ?? ${dflt}))`;
const WIN_LINE = winLine(CAP, CAP);
const nativeDefault = (n) => `RELAYIUM_PAIRING_ROUNDS:-${n}}`;
const androidDefault = (n) => `RELAYIUM_ANDROID_ROUNDS:-${n}}`;
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
  ["native default lowered",
    () => mutate("native", nativeDefault(CAP), nativeDefault(LOW)),
    ["native:default:floor", "equal"]],
  ["android default lowered",
    () => mutate("android", androidDefault(CAP), androidDefault(LOW)),
    ["android:default:floor", "equal"]],
  ["all four lowered together (equal, but below the floor)",
    () => {
      let w = mutate("windows", WIN_LINE, winLine(LOW, LOW));
      w = { ...w, native: w.native.replace(nativeDefault(CAP), nativeDefault(LOW)) };
      w = { ...w, android: w.android.replace(androidDefault(CAP), androidDefault(LOW)) };
      return w;
    },
    ["windows:clamp:floor", "windows:default:floor", "native:default:floor", "android:default:floor"]],
  ["windows declaration rewritten into a form the parser does not know",
    () => mutate("windows", WIN_LINE, `Number(process.env.RT_ROUNDS ?? ${CAP})`),
    ["windows:parse"]],
  ["windows declaration duplicated (which one is live?)",
    () => mutate("windows", "const MAX_ROUNDS =", `const MAX_ROUNDS = Math.max(1, ${WIN_LINE});\nconst MAX_ROUNDS =`),
    ["windows:parse"]],
  ["windows loop bounded by a literal instead of MAX_ROUNDS",
    () => mutate("windows", "index <= MAX_ROUNDS;", "index <= 8;"),
    ["windows:loop"]],
  ["native default removed",
    () => mutate("native", `max_rounds="\${${nativeDefault(CAP)}"`, "max_rounds=\"$RELAYIUM_PAIRING_ROUNDS\""),
    ["native:parse"]],
  ["android loop bounded by a literal",
    () => mutate("android", `-lt "$max_rounds" ]; do`, `-lt 8 ]; do`),
    ["android:loop"]],
  ["android file unreadable (empty)",
    () => ({ ...world, android: "" }),
    ["android:parse", "android:loop"]],
  ["windows file missing",
    () => ({ ...world, windows: undefined }),
    ["windows:parse", "windows:loop"]],
];

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
  + `${caught} mutations each red for its own claim`);
