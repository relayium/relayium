#!/usr/bin/env node
// scripts/test/ui-test-budget-test.mjs — the Apple UI test jobs end a hang as a
// FAILED step with its evidence kept, not as a cancelled job with none.
//
// ## The failure this pins (audit D-M3, 2026-09-28)
//
// `ios-ui-smoke` ran 28–40 minutes against a 45-minute job budget, and no
// xcodebuild UI run carried a per-test timeout, so one wedged XCUITest held the
// runner until the JOB timed out. GitHub reports a job timeout as `cancelled`,
// and the evidence uploads were conditioned on `failure()` or on
// `outcome == success || failure` — so exactly the run that hung kept no
// `.xcresult`, and the only evidence of where it hung was discarded.
//
// ## What each UI test job must hold
//
//   1. its xcodebuild `test` step has an `id:` and a `timeout-minutes:`
//      strictly BELOW every value the job's own `timeout-minutes` can take, so
//      a hang ends inside the step (reported `failure`) with time left for the
//      upload;
//   2. that xcodebuild invocation enables XCTest's own per-test timeout —
//      `-test-timeouts-enabled YES` with a `-maximum-test-execution-time-allowance`
//      and a `-default-test-execution-time-allowance` of at most 600 s;
//   3. its evidence step runs on `cancelled` as well: `always()` guarded by the
//      test step's outcome, naming `cancelled` — never a bare `failure()`.
//
// And every `xcodebuild … test` invocation anywhere in macos.yml and ios.yml
// carries the flags in (2), so a new UI job cannot be added without them.
//
// Deliberately a line reader over these two files rather than a YAML parser:
// the shapes are fixed and the self-test below mutates each property and
// requires it to be reported by name.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { fullPathOf } from "../ci/ci-evidence-view.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX_ALLOWANCE_S = 600;

const JOBS = [
  { file: "macos.yml", job: "ui-smoke", step: "ui_smoke", evidence: "Upload macOS UI smoke result evidence" },
  { file: "ios.yml", job: "ios-ui-smoke", step: "ui_smoke", evidence: "Retain UI smoke diagnosis" },
  { file: "ios.yml", job: "ios-ipad-shell", step: "ipad_shell", evidence: "Retain iPad shell diagnosis" },
];

/** The lines of job `name` (4-space body), or null. */
function jobLines(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^ {2}\S/.test(lines[end]) && !/^\S/.test(lines[end])) end += 1;
  return lines.slice(start + 1, end);
}

/** Steps of a job as { keys: Map, run: string } — keys at the step's own indent. */
function stepsOf(lines) {
  const steps = [];
  let current = null;
  let runIndent = -1;
  for (const line of lines) {
    const item = /^( {6})- (.*)$/.exec(line);
    if (item) {
      current = { keys: new Map(), run: "" };
      steps.push(current);
      runIndent = -1;
      const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(item[2]);
      if (kv) current.keys.set(kv[1], kv[2]);
      if (kv?.[1] === "run") runIndent = 8;
      continue;
    }
    if (!current) continue;
    if (runIndent !== -1 && (line.trim() === "" || line.startsWith(" ".repeat(runIndent + 2)))) {
      current.run += `${line}\n`;
      continue;
    }
    runIndent = -1;
    const kv = /^ {8}([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (kv) {
      current.keys.set(kv[1], kv[2]);
      if (kv[1] === "run") { runIndent = 8; current.run += `${kv[2]}\n`; }
    }
  }
  return steps;
}

/** Every value the job's `timeout-minutes` can take: a number, or each matrix `timeout`. */
function jobTimeouts(lines) {
  const raw = lines.find((line) => /^ {4}timeout-minutes:/.test(line))?.split(":")[1].trim();
  if (raw === undefined) return [];
  if (/^\d+$/.test(raw)) return [Number(raw)];
  const key = /\$\{\{\s*matrix\.([A-Za-z_]+)\s*\}\}/.exec(raw)?.[1];
  if (!key) return [];
  return lines.map((line) => new RegExp(`^\\s+${key}:\\s*(\\d+)\\s*$`).exec(line)?.[1])
    .filter(Boolean).map(Number);
}

/** Problems with one xcodebuild `test` invocation's per-test timeout flags. */
function flagProblems(run, where) {
  const problems = [];
  if (!/-test-timeouts-enabled\s+YES\b/.test(run)) {
    problems.push(`${where}: xcodebuild test runs without \`-test-timeouts-enabled YES\`, so a hung UI test holds the runner until the job times out`);
  }
  for (const flag of ["-maximum-test-execution-time-allowance", "-default-test-execution-time-allowance"]) {
    const value = new RegExp(`${flag}\\s+(\\d+)\\b`).exec(run)?.[1];
    if (value === undefined) problems.push(`${where}: xcodebuild test runs without \`${flag} <seconds>\``);
    else if (Number(value) > MAX_ALLOWANCE_S || Number(value) <= 0) {
      problems.push(`${where}: \`${flag} ${value}\` is outside (0, ${MAX_ALLOWANCE_S}] seconds`);
    }
  }
  return problems;
}

// ── the iPhone stage: one supervised step (scripts/ci/ios-ui-smoke.py) ─────────────────────────────────────
//
// The `ios-ui-smoke` step no longer calls `xcodebuild … test` itself: it hands its own arrays and its quoted selection
// heredoc to the supervisor, which runs `build-for-testing` and then `test-without-building` with the step's
// `test_limits` and `selection`, only after BOTH the boot and the build succeeded, inside the original budgets.
//
// Two halves, both exact:
//   - the STEP: parsed into prelude / invocation / heredoc / epilogue. The supervisor must be ONE top-level simple
//     command whose exit status is the step's (`set -euo pipefail` first, nothing that branches, masks, pipes or
//     follows it — `|| true`, `; true`, `cond &&`, `if false`, `| tee`, a trailing `exit 0` all lose a failure), the
//     step must not carry `if:`/`continue-on-error:`/`shell:`, and an exact normalized pin of the whole step (full-
//     line comments aside) catches any drift the named checks do not enumerate.
//   - the HELPER: READ, never run or imported. Its syntax tree is judged by a fixed `/usr/bin/python3 -B -c` reader
//     on finite stdin, with a timeout and an output cap, failing closed. The pin is over a canonical serialization
//     that is the same on every Python the reader may meet (3.9 locally, 3.12 on Ubuntu): every node's fields must be
//     EXACTLY the reviewed schema, except that an EMPTY `type_params` on FunctionDef/AsyncFunctionDef/ClassDef (added
//     in Python 3.12, always empty for code without PEP 695 syntax) is dropped. A non-empty `type_params`, a
//     `type_params` anywhere else, or any other field or node type outside the schema is refused, never normalized.
const SUPERVISOR = "scripts/ci/ios-ui-smoke.py";
const SUPERVISOR_AST_SHA256 = "d9e02e5e3a2ef5a9f4e18a49864ccaf90e6e11074960f5fb5318d701d736af29";
const STAGE_SHA256 = "fcb767e4c70582a3c2a149272d35a2f48575a2f484c47a70467cca978f071b70";
const STAGE_KEYS = ["name", "id", "timeout-minutes", "env", "run"];
const PRELUDE = [
  "set -euo pipefail",
  "common=(-project apps/ios/Relayium.xcodeproj -scheme Relayium",
  "  -derivedDataPath \"$RUNNER_TEMP/dd-ios\")",
  "test_limits=(-test-timeouts-enabled YES",
  "  -default-test-execution-time-allowance 300",
  "  -maximum-test-execution-time-allowance 300)",
  "case \"$UI_SHARD\" in",
  "  app-shell)",
  "    selection=(-collect-test-diagnostics never",
  "      -only-testing:RelayiumUITests/AppShellUITests)",
  "    ;;",
  "  complement)",
  "    selection=(-skip-testing:RelayiumUITests/AppShellUITests",
  "      -only-testing:RelayiumUITests)",
  "    ;;",
  "  *)",
  "    echo \"::error::unknown UI shard '$UI_SHARD'; it would select nothing\"",
  "    exit 1",
  "    ;;",
  "esac",
];
const INVOCATION = [
  `/usr/bin/python3 ${SUPERVISOR} --shard "$UI_SHARD" \\`,
  "  --log-dir \"$RUNNER_TEMP/ios-ui-smoke-$UI_SHARD-logs\" \\",
  "  --build-result \"$RUNNER_TEMP/ios-ui-build-$UI_SHARD.xcresult\" \\",
  "  --test-result \"$RUNNER_TEMP/ios-ui-smoke-$UI_SHARD.xcresult\" \\",
  "  -- \"${common[@]}\" -- \"${test_limits[@]}\" -- \"${selection[@]}\" <<'SELECT'",
];
const HEREDOC_END = "SELECT";
const AST_FACTS = `
import ast, hashlib, json, sys
MODE = sys.argv[1] if len(sys.argv) > 1 else ""
SCHEMA = {
    "Add": (), "And": (), "Assign": ('targets', 'value', 'type_comment'), "Attribute": ('value', 'attr', 'ctx'),
    "AugAssign": ('target', 'op', 'value'), "BinOp": ('left', 'op', 'right'), "BoolOp": ('op', 'values'),
    "Break": (), "Call": ('func', 'args', 'keywords'),
    "ClassDef": ('name', 'bases', 'keywords', 'body', 'decorator_list'), "Compare": ('left', 'ops', 'comparators'),
    "Constant": ('value', 'kind'), "Continue": (), "Dict": ('keys', 'values'),
    "DictComp": ('key', 'value', 'generators'), "Div": (), "Eq": (), "ExceptHandler": ('type', 'name', 'body'),
    "Expr": ('value',), "For": ('target', 'iter', 'body', 'orelse', 'type_comment'),
    "FormattedValue": ('value', 'conversion', 'format_spec'),
    "FunctionDef": ('name', 'args', 'body', 'decorator_list', 'returns', 'type_comment'),
    "GeneratorExp": ('elt', 'generators'), "Gt": (), "GtE": (), "If": ('test', 'body', 'orelse'),
    "IfExp": ('test', 'body', 'orelse'), "Import": ('names',), "ImportFrom": ('module', 'names', 'level'), "In": (),
    "Is": (), "IsNot": (), "JoinedStr": ('values',), "LShift": (), "List": ('elts', 'ctx'),
    "ListComp": ('elt', 'generators'), "Load": (), "Lt": (), "LtE": (), "Module": ('body', 'type_ignores'),
    "Mult": (), "Name": ('id', 'ctx'), "Not": (), "NotEq": (), "NotIn": (), "Or": (), "Pass": (),
    "Raise": ('exc', 'cause'), "Return": ('value',), "Slice": ('lower', 'upper', 'step'),
    "Starred": ('value', 'ctx'), "Store": (), "Sub": (), "Subscript": ('value', 'slice', 'ctx'),
    "Try": ('body', 'handlers', 'orelse', 'finalbody'), "Tuple": ('elts', 'ctx'), "USub": (),
    "UnaryOp": ('op', 'operand'), "While": ('test', 'body', 'orelse'), "With": ('items', 'body', 'type_comment'),
    "alias": ('name', 'asname'), "arg": ('arg', 'annotation', 'type_comment'),
    "arguments": ('posonlyargs', 'args', 'vararg', 'kwonlyargs', 'kw_defaults', 'kwarg', 'defaults'),
    "comprehension": ('target', 'iter', 'ifs', 'is_async'), "keyword": ('arg', 'value'),
    "withitem": ('context_expr', 'optional_vars')
}
DEFS = ("FunctionDef", "AsyncFunctionDef", "ClassDef")
src = sys.stdin.read()
try:
    tree = ast.parse(src)
except SyntaxError as e:
    print(json.dumps({"error": "the helper does not parse: %s" % e})); sys.exit(0)

def with_field(node, name, value):
    if name not in node._fields:
        node._fields = (*node._fields, name)
    setattr(node, name, value)

# Self-test only (never passed by budgetProblems): the documented Python 3.12 schema, synthesized on any interpreter.
if MODE:
    defs = [n for n in ast.walk(tree) if type(n).__name__ in DEFS]
    if MODE == "py312-empty-type-params":
        for n in defs: with_field(n, "type_params", [])
    elif MODE == "py312-nonempty-type-params":
        with_field(defs[0], "type_params", [ast.Name(id="T", ctx=ast.Load())])
    elif MODE == "empty-type-params-elsewhere":
        with_field(next(n for n in ast.walk(tree) if isinstance(n, ast.Assign)), "type_params", [])
    elif MODE == "unknown-field":
        with_field(defs[0], "novel", None)
    else:
        print(json.dumps({"error": "unknown self-test mode %r" % MODE})); sys.exit(0)

class Refused(Exception):
    pass

def canon(v):
    if isinstance(v, ast.AST):
        kind = type(v).__name__
        if kind not in SCHEMA:
            raise Refused("node type %s is outside the reviewed schema" % kind)
        fields = list(v._fields)
        if "type_params" in fields:
            if kind not in DEFS:
                raise Refused("%s carries type_params, which only FunctionDef/AsyncFunctionDef/ClassDef may" % kind)
            if getattr(v, "type_params") != []:
                raise Refused("%s %s has non-empty type_params" % (kind, getattr(v, "name", "?")))
            fields.remove("type_params")
        if tuple(fields) != SCHEMA[kind]:
            raise Refused("%s has fields %s, want exactly %s (an unknown semantic field)" % (kind, fields, list(SCHEMA[kind])))
        return [kind] + [canon(getattr(v, f, None)) for f in fields]
    if isinstance(v, list):
        return ["list"] + [canon(x) for x in v]
    if v is None or v is Ellipsis:
        return [repr(v)]
    if isinstance(v, (bool, int, float, complex, str, bytes)):
        return [type(v).__name__, repr(v)]
    raise Refused("a field holds an unexpected %s" % type(v).__name__)

try:
    sha = hashlib.sha256(json.dumps(canon(tree), separators=(",", ":")).encode()).hexdigest()
except Refused as e:
    print(json.dumps({"error": "the helper's syntax tree is refused: %s" % e})); sys.exit(0)

counts, consts = {}, {}
for node in tree.body:
    if isinstance(node, ast.Assign):
        for t in node.targets:
            if isinstance(t, ast.Name):
                counts[t.id] = counts.get(t.id, 0) + 1
                try:
                    consts[t.id] = ast.literal_eval(node.value)
                except Exception:
                    consts[t.id] = None
    elif type(node).__name__ in DEFS:
        counts["def " + node.name] = counts.get("def " + node.name, 0) + 1
    elif isinstance(node, (ast.AugAssign, ast.AnnAssign)) and isinstance(getattr(node, "target", None), ast.Name):
        counts[node.target.id] = counts.get(node.target.id, 0) + 1
facts = {"sha": sha, "counts": counts,
         "consts": {k: consts.get(k) for k in ("SELECT_BOOT_LIMIT", "ACTION_LIMIT", "STAGE_LIMIT", "CLEANUP_TOTAL", "TEST_LIMITS")},
         "tasks": {}, "waits": [], "test_deadline": None, "cleanup": None, "main_cleanup": False}
fn = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
main = fn.get("main")
if main is not None:
    for n in ast.walk(main):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "Task" and len(n.args) >= 5 \\
                and isinstance(n.args[0], ast.Constant) and isinstance(n.args[1], ast.List):
            facts["tasks"][n.args[0].value] = {"line": n.lineno, "tail": [ast.unparse(e) for e in n.args[1].elts[-3:]],
                                               "head": ast.unparse(n.args[1].elts[0]), "deadline": ast.unparse(n.args[4])}
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "wait_for" and n.args:
            facts["waits"].append({"line": n.lineno, "arg": ast.unparse(n.args[0])})
        if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "test_deadline" for t in n.targets):
            facts["test_deadline"] = ast.unparse(n.value)
    facts["main_cleanup"] = any(isinstance(n, ast.Try) and any("cleanup_all()" in ast.unparse(f) for f in n.finalbody)
                                for n in ast.walk(main))
cleanup = fn.get("cleanup_all")
if cleanup is not None:
    text = ast.unparse(cleanup)
    facts["cleanup"] = {"total": "CLEANUP_TOTAL" in text, "monotonic": "time.monotonic()" in text,
                        "once": "if CLEANUP['deadline'] is None" in text}
facts["wall_clock"] = "time.time(" in src
print(json.dumps(facts))
`;

/** The helper's AST facts, or { error }. Bounded and fail-closed. `mode` is for the self-test only. */
function helperFacts(text, mode = "") {
  if (typeof text !== "string") return { error: `${SUPERVISOR} is missing` };
  const r = spawnSync("/usr/bin/python3", ["-B", "-c", AST_FACTS, ...(mode ? [mode] : [])], {
    input: text, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 1 << 20,
    env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1", LC_ALL: "C" },
  });
  if (r.error || r.status !== 0) return { error: `the AST reader failed (${r.error?.message ?? `exit ${r.status}`})` };
  try { return JSON.parse(r.stdout); } catch { return { error: "the AST reader printed no JSON" }; }
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const CONTROL_FLOW = /^\s*(?:if|then|elif|else|fi|while|until|for|select|do|done|function|trap|exec|return|alias|shopt)\b|^\s*exit\s+0\b|^\s*set\s+\+|^\s*[{}()]|\b[A-Za-z_][A-Za-z_0-9]*\s*\(\)\s*\{/;

/** Problems with the step that runs the supervisor: its keys, its control flow, its exact command. */
function stageProblems(stepLines, keys, run, where) {
  const problems = [];
  const extra = [...keys.keys()].filter((k) => !STAGE_KEYS.includes(k));
  if (extra.length) {
    problems.push(`${where}: the supervised step carries \`${extra.join("`, `")}\`, which can skip it or discard its failure`);
  }
  const body = run.split("\n").slice(1);
  if (run.split("\n")[0] !== "|" || body.some((l) => l !== "" && !l.startsWith(" ".repeat(10)))) {
    problems.push(`${where}: the supervised step's \`run: |\` block is not the reviewed literal block`);
    return problems;
  }
  const lines = body.map((l) => l.slice(10)).filter((l) => !/^\s*#/.test(l));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const calls = lines.map((l, i) => [l, i]).filter(([l]) => l.includes(SUPERVISOR));
  if (calls.length !== 1) {
    problems.push(`${where}: the step does not run \`${SUPERVISOR}\` exactly once (found ${calls.length}): no helper, an alternate one or a second call`);
    return problems;
  }
  const at = calls[0][1];
  const prefix = lines[at].slice(0, lines[at].indexOf("/usr/bin/python3"));
  if (prefix !== "" || !lines[at].startsWith(INVOCATION[0].split(" ").slice(0, 2).join(" "))) {
    problems.push(`${where}: the supervisor is not a top-level simple command (\`${lines[at].trim().slice(0, 60)}\`): a condition, pipeline or block can skip it or replace its exit status`);
  }
  const close = lines.findIndex((l, i) => i >= at && l.includes("<<'SELECT'"));
  if (close === -1) {
    problems.push(`${where}: the supervisor is not fed the quoted selection heredoc \`<<'SELECT'\``);
    return problems;
  }
  const tail = lines[close].slice(lines[close].indexOf("<<'SELECT'") + "<<'SELECT'".length);
  if (tail.trim() !== "") {
    problems.push(`${where}: the supervisor's exit status is masked or piped after its heredoc (\`${tail.trim()}\`), so a failed stage would pass`);
  }
  const invocation = lines.slice(at, close + 1).map((l, i) => (i === close - at ? l.slice(0, l.indexOf("<<'SELECT'") + 10) : l));
  invocation[0] = invocation[0].slice(prefix.length);
  if (JSON.stringify(invocation) !== JSON.stringify(INVOCATION)) {
    problems.push(`${where}: the supervisor's arguments are not the reviewed ones (three argument groups \`-- common -- test_limits -- selection\` and the quoted selection heredoc)`);
  }
  const end = lines.findIndex((l, i) => i > close && l === HEREDOC_END);
  if (end === -1) {
    problems.push(`${where}: the selection heredoc has no \`${HEREDOC_END}\` terminator`);
    return problems;
  }
  const epilogue = lines.slice(end + 1).filter((l) => l.trim() !== "");
  if (epilogue.length) {
    problems.push(`${where}: commands follow the supervisor (\`${epilogue[0].trim()}\`), so the step's exit status is no longer the stage's`);
  }
  const outside = [...lines.slice(0, at), ...lines.slice(end + 1)];
  if (outside.some((l) => /^\s*xcodebuild\b/.test(l)) || lines.some((l) => /-test-timeouts-enabled\s+NO/.test(l))) {
    problems.push(`${where}: the step runs xcodebuild itself or disables the per-test timeout, bypassing the supervisor's budgets`);
  }
  const prelude = lines.slice(0, at).filter((l) => l.trim() !== "");
  if (prelude[0] !== "set -euo pipefail") {
    problems.push(`${where}: the step does not start with \`set -euo pipefail\`, so a failed command before the supervisor can be ignored`);
  }
  const flow = prelude.find((l) => CONTROL_FLOW.test(l) && !PRELUDE.includes(l));
  if (flow !== undefined) {
    problems.push(`${where}: control flow before the supervisor (\`${flow.trim()}\`) can skip it or mask its status`);
  }
  if (JSON.stringify(prelude) !== JSON.stringify(PRELUDE)) {
    problems.push(`${where}: the commands before the supervisor are not the reviewed prelude (arrays, shard selections, unknown-shard refusal)`);
  }
  const block = stepLines.filter((l) => !/^\s*#/.test(l)).map((l) => l.trimEnd()).join("\n").replace(/\n+$/, "");
  if (sha256(block) !== STAGE_SHA256) {
    problems.push(`${where}: the supervised step ${sha256(block)} is not the reviewed stage ${STAGE_SHA256}; review the change and re-pin`);
  }
  return problems;
}

/** Problems with the supervisor's own syntax tree. */
function helperProblems(helperText, where, mode) {
  const problems = [];
  const f = helperFacts(helperText, mode);
  if (f.error) { problems.push(`${where}: ${f.error}`); return problems; }
  const want = { SELECT_BOOT_LIMIT: 300, ACTION_LIMIT: 2880, STAGE_LIMIT: 3170, CLEANUP_TOTAL: 10 };
  for (const [name, value] of Object.entries(want)) {
    if (f.consts[name] !== value || f.counts[name] !== 1) {
      problems.push(`${where}: the supervisor's ${name} is ${JSON.stringify(f.consts[name])} (assigned ${f.counts[name] ?? 0}×), want ${value} assigned once`);
    }
  }
  const limits = ["-test-timeouts-enabled", "YES", "-default-test-execution-time-allowance", "300", "-maximum-test-execution-time-allowance", "300"];
  if (JSON.stringify(f.consts.TEST_LIMITS) !== JSON.stringify(limits) || f.counts.TEST_LIMITS !== 1) {
    problems.push(`${where}: the supervisor's TEST_LIMITS are ${JSON.stringify(f.consts.TEST_LIMITS)}, want the original 300 s per-test allowances`);
  }
  for (const name of ["main", "cleanup_all", "wait_for", "parse", "Task"]) {
    if (f.counts[`def ${name}`] !== 1) problems.push(`${where}: the supervisor defines \`${name}\` ${f.counts[`def ${name}`] ?? 0} times, want once`);
  }
  const test = f.tasks.test;
  const build = f.tasks.build;
  if (!test || test.head !== "'xcodebuild'" || JSON.stringify(test.tail) !== JSON.stringify(["*limits", "*selection", "'test-without-building'"])) {
    problems.push(`${where}: the supervisor's test is not \`xcodebuild … *limits *selection test-without-building\` (got ${JSON.stringify(test)})`);
  }
  if (!build || build.head !== "'xcodebuild'" || build.tail[2] !== "'build-for-testing'") {
    problems.push(`${where}: the supervisor's build is not \`xcodebuild … build-for-testing\` (got ${JSON.stringify(build)})`);
  }
  const barrier = f.waits.find((w) => w.arg === "[boot, build]");
  if (!barrier || !test || barrier.line > test.line) {
    problems.push(`${where}: the supervisor does not wait for BOTH the boot and the build before it starts the test`);
  }
  if (f.test_deadline !== "min(test_start + ACTION_LIMIT - build_elapsed, STAGE_LIMIT)" || test?.deadline !== "test_deadline") {
    problems.push(`${where}: the test's deadline is ${JSON.stringify(f.test_deadline)}, want min(test_start + ACTION_LIMIT - build_elapsed, STAGE_LIMIT) — the build's elapsed time deducted and the stage clamp kept`);
  }
  if (!f.cleanup?.total || !f.cleanup?.monotonic || !f.cleanup?.once || !f.main_cleanup || f.wall_clock) {
    problems.push(`${where}: the supervisor's cleanup is not ONE shared monotonic CLEANUP_TOTAL deadline run from main's finally (or it reads the wall clock)`);
  }
  if (f.sha !== SUPERVISOR_AST_SHA256) {
    problems.push(`${where}: the supervisor's canonical AST ${f.sha} is not the reviewed ${SUPERVISOR_AST_SHA256}; review the change and re-pin`);
  }
  return problems;
}

export function budgetProblems(files) {
  const problems = [];
  for (const { file, job, step, evidence } of JOBS) {
    const text = files[file];
    const lines = jobLines(text, job);
    if (lines === null) { problems.push(`${file}: job \`${job}\` is gone; update this test with it`); continue; }
    const where = `${file}/${job}`;
    const timeouts = jobTimeouts(lines);
    if (timeouts.length === 0) problems.push(`${where}: no readable job timeout-minutes`);
    const steps = stepsOf(lines);
    const test = steps.find((s) => s.keys.get("id") === step);
    if (!test) { problems.push(`${where}: no step with \`id: ${step}\` — the evidence guard has nothing to read`); continue; }
    const stepTimeout = Number(test.keys.get("timeout-minutes"));
    if (!Number.isInteger(stepTimeout) || stepTimeout <= 0) {
      problems.push(`${where}: the \`${step}\` step has no numeric timeout-minutes, so a hang ends as a job timeout (cancelled) instead of a failed step`);
    } else if (timeouts.some((t) => stepTimeout >= t)) {
      problems.push(`${where}: the \`${step}\` step's timeout-minutes ${stepTimeout} is not below the job's [${timeouts.join(", ")}]`);
    }
    if (job === "ios-ui-smoke") {
      if (lines.some((l) => /^ {4}continue-on-error:/.test(l))) {
        problems.push(`${where}: the job carries \`continue-on-error:\`, so a failed stage would not fail the run`);
      }
      const at = lines.findIndex((l) => l === "      - name: Run iOS primary-task UI smoke");
      let stop = at + 1;
      while (at !== -1 && stop < lines.length && !/^ {6}- /.test(lines[stop])) stop += 1;
      problems.push(...stageProblems(at === -1 ? [] : lines.slice(at, stop), test.keys, test.run, where));
      problems.push(...helperProblems(files.helper, where, files.selfTestAstMode));
    } else if (!/xcodebuild[\s\S]*\btest\s*$/m.test(test.run)) {
      problems.push(`${where}: the \`${step}\` step no longer runs \`xcodebuild … test\``);
    }
    problems.push(...flagProblems(test.run, `${where} step ${step}`));

    const upload = steps.find((s) => s.keys.get("name") === evidence);
    if (!upload) { problems.push(`${where}: the evidence step "${evidence}" is gone`); continue; }
    const condition = upload.keys.get("if") ?? "";
    const guarded = /always\(\)/.test(condition) && condition.includes(`steps.${step}.outcome`)
      && /['"]cancelled['"]/.test(condition);
    if (!guarded) {
      problems.push(`${where}: "${evidence}" runs \`if: ${condition}\`; it must run when the \`${step}\` step `
        + `was CANCELLED (a job timeout), i.e. \`always()\` plus \`steps.${step}.outcome\` naming 'cancelled'`);
    }
  }
  // Every xcodebuild `test` invocation in these files carries the flags.
  for (const file of ["macos.yml", "ios.yml"]) {
    const blocks = files[file].split(/\n(?= {6}- )/);
    for (const block of blocks) {
      if (!/xcodebuild[^\n]*(?:\\\n[^\n]*)*\btest\s*$/m.test(block)) continue;
      const name = /name:\s*(.*)/.exec(block)?.[1] ?? "(unnamed step)";
      problems.push(...flagProblems(block, `${file} step "${name}"`));
    }
  }
  return problems;
}

function selfTest(files) {
  const failures = [];
  const helper = (from, to) => {
    if (typeof files.helper !== "string" || !files.helper.includes(from)) throw new Error(`the helper no longer contains ${JSON.stringify(from)}`);
    return { ...files, helper: files.helper.replace(from, to) };
  };
  const mutate = (file, from, to) => {
    if (!files[file].includes(from)) throw new Error(`${file} no longer contains ${JSON.stringify(from)}`);
    return { ...files, [file]: files[file].replace(from, to) };
  };
  const cases = [
    ["the macOS upload condition reverted to success/failure only",
      () => mutate("macos.yml",
        `if: always() && contains(fromJSON('["success","failure","cancelled"]'), steps.ui_smoke.outcome)`,
        `if: always() && (steps.ui_smoke.outcome == 'success' || steps.ui_smoke.outcome == 'failure')`),
      /macos\.yml\/ui-smoke: "Upload macOS UI smoke result evidence" runs/],
    ["the iOS diagnosis back on bare failure()",
      () => mutate("ios.yml",
        `if: always() && contains(fromJSON('["failure","cancelled"]'), steps.ui_smoke.outcome)`,
        "if: failure()"),
      /ios\.yml\/ios-ui-smoke: "Retain UI smoke diagnosis" runs/],
    ["the per-test timeout switch removed from the iPad run",
      () => {
        const at = files["ios.yml"].indexOf("ios-ipad-shell.xcresult\" \\\n            -test-timeouts-enabled YES");
        if (at === -1) throw new Error("ios.yml iPad flags moved");
        return { ...files, "ios.yml": files["ios.yml"].slice(0, at)
          + files["ios.yml"].slice(at).replace("-test-timeouts-enabled YES \\\n            ", "") };
      },
      /ios\.yml\/ios-ipad-shell step ipad_shell: xcodebuild test runs without `-test-timeouts-enabled YES`/],
    ["the macOS step budget raised to the job's",
      () => mutate("macos.yml", "        timeout-minutes: 24\n", "        timeout-minutes: 30\n"),
      /macos\.yml\/ui-smoke: the `ui_smoke` step's timeout-minutes 30 is not below/],
    ["an allowance above ten minutes",
      () => mutate("ios.yml", "-maximum-test-execution-time-allowance 300", "-maximum-test-execution-time-allowance 900"),
      /-maximum-test-execution-time-allowance 900` is outside/],
    // ── the iPhone supervisor: each way the stage stops being budgeted is reported by name ──
    ["the step calls another helper",
      () => mutate("ios.yml", `/usr/bin/python3 ${SUPERVISOR}`, "/usr/bin/python3 scripts/ci/other.py"),
      /ios-ui-smoke: the step does not run `scripts\/ci\/ios-ui-smoke\.py` exactly once \(found 0\)/],
    ["the step stops forwarding its test limits",
      () => mutate("ios.yml", '-- "${test_limits[@]}" --', "-- --"),
      /ios-ui-smoke: the supervisor's arguments are not the reviewed ones \(three argument groups/],
    ["the step adds a shadow xcodebuild test",
      () => mutate("ios.yml", "          esac\n", "          esac\n          xcodebuild -project apps/ios/Relayium.xcodeproj test\n"),
      /ios-ui-smoke: the step runs xcodebuild itself/],
    ["the helper is missing",
      () => ({ ...files, helper: null }),
      /ios-ui-smoke: scripts\/ci\/ios-ui-smoke\.py is missing/],
    ["the helper tests with plain `test` (argv)",
      () => helper("\"test-without-building\"],", "\"test\"],"),
      /the supervisor's test is not `xcodebuild … \*limits \*selection test-without-building`/],
    ["the helper drops the forwarded limits",
      () => helper("*limits, *selection, \"test-without-building\"", "*selection, \"test-without-building\""),
      /the supervisor's test is not/],
    ["the helper no longer waits for both boot and build",
      () => helper("        wait_for([boot, build])\n", "        wait_for([build])\n"),
      /does not wait for BOTH the boot and the build/],
    ["the helper stops deducting the build's time",
      () => helper("min(test_start + ACTION_LIMIT - build_elapsed, STAGE_LIMIT)", "min(test_start + ACTION_LIMIT, STAGE_LIMIT)"),
      /the build's elapsed time deducted/],
    ["the helper drops the stage clamp",
      () => helper("min(test_start + ACTION_LIMIT - build_elapsed, STAGE_LIMIT)", "test_start + ACTION_LIMIT - build_elapsed"),
      /the stage clamp kept/],
    ["the helper's cleanup is no longer one shared deadline",
      () => helper("    if CLEANUP[\"deadline\"] is None:\n", "    if True:\n"),
      /ONE shared monotonic CLEANUP_TOTAL deadline/],
    ["the helper overrides a budget after its definition",
      () => helper("\n\nif __name__ == \"__main__\":", "\nACTION_LIMIT = 9999.0\n\nif __name__ == \"__main__\":"),
      /ACTION_LIMIT is 9999 \(assigned 2×\)/],
    ["the helper raises its stage limit",
      () => helper("STAGE_LIMIT = 3170.0", "STAGE_LIMIT = 3240.0"),
      /STAGE_LIMIT is 3240/],
    ["the helper gains a shadow main",
      () => helper("\n\nif __name__ == \"__main__\":", "\ndef main(argv):\n    return 0\n\nif __name__ == \"__main__\":"),
      /defines `main` 2 times/],
    ["the helper drifts in a way not enumerated (pin)",
      () => helper("POLL = 0.2", "POLL = 0.5"),
      /canonical AST .* is not the reviewed/],
    // ── R2: the supervisor's exit status IS the step's — every way to lose it is reported by name ──
    ["the supervisor's status masked with `|| true`",
      () => mutate("ios.yml", "<<'SELECT'\n", "<<'SELECT' || true\n"),
      /exit status is masked or piped after its heredoc \(`\|\| true`\)/],
    ["the supervisor's status masked with `; true`",
      () => mutate("ios.yml", "<<'SELECT'\n", "<<'SELECT'; true\n"),
      /exit status is masked or piped after its heredoc \(`; true`\)/],
    ["the supervisor piped into tee",
      () => mutate("ios.yml", "<<'SELECT'\n", "<<'SELECT' | tee \"$RUNNER_TEMP/ui.log\"\n"),
      /exit status is masked or piped after its heredoc \(`\| tee/],
    ["the supervisor behind a condition that skips it",
      () => mutate("ios.yml", `          /usr/bin/python3 ${SUPERVISOR}`, `          [ "$UI_SHARD" = none ] && /usr/bin/python3 ${SUPERVISOR}`),
      /the supervisor is not a top-level simple command \(`\[ "\$UI_SHARD" = none \] &&/],
    ["the supervisor at the end of a pipeline",
      () => mutate("ios.yml", `          /usr/bin/python3 ${SUPERVISOR}`, `          true | /usr/bin/python3 ${SUPERVISOR}`),
      /the supervisor is not a top-level simple command \(`true \|/],
    ["the supervisor inside a dead `if false`",
      () => {
        const once = mutate("ios.yml", `          /usr/bin/python3 ${SUPERVISOR}`, `          if false; then\n          /usr/bin/python3 ${SUPERVISOR}`);
        const end = once["ios.yml"].indexOf("\n          SELECT\n");
        return { ...once, "ios.yml": `${once["ios.yml"].slice(0, end)}\n          SELECT\n          fi\n${once["ios.yml"].slice(end + "\n          SELECT\n".length)}` };
      },
      /control flow before the supervisor \(`if false; then`\)/],
    ["a command after the supervisor replaces its status",
      () => mutate("ios.yml", "\n          SELECT\n", "\n          SELECT\n          exit 0\n"),
      /commands follow the supervisor \(`exit 0`\)/],
    ["errexit dropped from the step",
      () => mutate("ios.yml", "          set -euo pipefail\n          common=", "          set -uo pipefail\n          common="),
      /the step does not start with `set -euo pipefail`/],
    ["`set +e` before the supervisor",
      () => mutate("ios.yml", "          esac\n", "          esac\n          set +e\n"),
      /control flow before the supervisor \(`set \+e`\)/],
    ["a second supervisor call",
      () => mutate("ios.yml", "          esac\n", `          esac\n          /usr/bin/python3 ${SUPERVISOR} --help\n`),
      /does not run `scripts\/ci\/ios-ui-smoke\.py` exactly once \(found 2\)/],
    ["no supervisor at all",
      () => mutate("ios.yml", `          /usr/bin/python3 ${SUPERVISOR} --shard`, "          /usr/bin/true --shard"),
      /does not run `scripts\/ci\/ios-ui-smoke\.py` exactly once \(found 0\)/],
    ["the step marked continue-on-error",
      () => mutate("ios.yml", "        id: ui_smoke\n        timeout-minutes: 53\n", "        id: ui_smoke\n        continue-on-error: true\n        timeout-minutes: 53\n"),
      /the supervised step carries `continue-on-error`/],
    ["the step skipped by its own `if:`",
      () => mutate("ios.yml", "        id: ui_smoke\n        timeout-minutes: 53\n", "        id: ui_smoke\n        if: false\n        timeout-minutes: 53\n"),
      /the supervised step carries `if`/],
    ["the job marked continue-on-error",
      () => mutate("ios.yml", "    timeout-minutes: 65\n", "    timeout-minutes: 65\n    continue-on-error: true\n"),
      /ios-ui-smoke: the job carries `continue-on-error:`/],
    ["the stage drifts in a way not enumerated (stage pin)",
      () => mutate("ios.yml", "        timeout-minutes: 53\n", "        timeout-minutes: 52\n"),
      /the supervised step [0-9a-f]{64} is not the reviewed stage/],
    // ── R2: the canonical AST — only an EMPTY 3.12 type_params on a def/class is normalized ──
    // (synthetic: the documented Python 3.12 schema injected under whatever /usr/bin/python3 is; see the positives)
    ["non-empty type_params (synthetic 3.12)",
      () => ({ ...files, selfTestAstMode: "py312-nonempty-type-params" }),
      /the helper's syntax tree is refused: ClassDef Fail has non-empty type_params/],
    ["an empty type_params on a node that never has one (synthetic)",
      () => ({ ...files, selfTestAstMode: "empty-type-params-elsewhere" }),
      /refused: Assign carries type_params, which only FunctionDef\/AsyncFunctionDef\/ClassDef may/],
    ["an unknown semantic field (synthetic)",
      () => ({ ...files, selfTestAstMode: "unknown-field" }),
      /refused: ClassDef has fields .*'novel'.* \(an unknown semantic field\)/],
    ["a node type outside the reviewed schema",
      () => helper("\n\nif __name__ == \"__main__\":", "\nasync def later():\n    pass\n\nif __name__ == \"__main__\":"),
      /refused: node type AsyncFunctionDef is outside the reviewed schema/],
  ];
  // Positives: changes the guard must NOT report.
  const positives = [
    ["the documented Python 3.12 schema: EMPTY type_params on every def/class (synthetic) keeps the same pin",
      () => ({ ...files, selfTestAstMode: "py312-empty-type-params" })],
  ];
  for (const [name, build] of positives) {
    const problems = budgetProblems(build());
    if (problems.length) failures.push(`self-test positive "${name}" was refused: ${problems.join(" | ")}`);
  }
  for (const [name, build, expect] of cases) {
    let world;
    try { world = build(); } catch (err) { failures.push(`self-test "${name}" could not apply: ${err.message}`); continue; }
    const problems = budgetProblems(world);
    if (!problems.some((p) => expect.test(p))) {
      failures.push(`self-test "${name}" went unreported (want ${expect}); got: ${problems.join(" | ") || "nothing"}`);
    }
  }
  return { failures, count: cases.length, positives: positives.length };
}

const files = Object.fromEntries(["macos.yml", "ios.yml"]
  .map((f) => [f, fullPathOf(f, readFileSync(resolve(repoRoot, ".github/workflows", f), "utf8"))]));
files.helper = existsSync(resolve(repoRoot, SUPERVISOR)) ? readFileSync(resolve(repoRoot, SUPERVISOR), "utf8") : null;
const problems = budgetProblems(files);
const self = problems.length === 0 ? selfTest(files) : { failures: [], count: 0 };
const all = [...problems, ...self.failures];
if (all.length > 0) {
  console.error(`ui-test-budget-test: ${all.length} failure(s)`);
  for (const p of all) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`ui-test-budget-test: OK (${JOBS.length} Apple UI test jobs end a hang as a failed step and keep `
  + `their .xcresult on cancellation; every xcodebuild test in macos.yml/ios.yml has a per-test timeout; `
  + `${self.count} mutations each reported, ${self.positives} positive(s) accepted)`);
