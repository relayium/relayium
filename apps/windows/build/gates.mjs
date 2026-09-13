// Every local gate, in one command, answering with one exit code.
//
// ## Why this exists
//
// On 2026-09-13 a batch shipped with four `tsc` errors and CI caught them.
// `npm run check` had reported all four. It is five tools — `svelte-check` and
// four `tsc` invocations — and they report differently: svelte-check prints
// `ERROR "file" …` and a `COMPLETED n FILES m ERRORS` summary line, while `tsc`
// prints `file(line,col): error TS…` and no summary at all. The output was
// being filtered with a pattern that could not match the second kind, so a
// failing run displayed `COMPLETED … 0 ERRORS` and read as green. The exit code
// said otherwise the whole time and nobody looked at it.
//
// The lesson was written down. In the next batch a script that edits a ledger
// raised a traceback, and the same shell line went on to commit and push, so
// the visible output ended in a push URL and the commit shipped incomplete.
//
// A rule in a document did nothing at the moment of acting, twice. So: the rule
// as a command. Run everything, print what each did, exit non-zero if any of
// them failed. The exit code is the product; the table is for reading.
//
// ## What it is not
//
// Not a CI step, and it should not become one. The workflow runs these as
// separate named steps on purpose — its own comment says "so a failure names
// the surface without anybody opening a log" — and collapsing them into one
// step would take that away. This is the pre-push check, run where the
// developer is.
//
// It is Node rather than shell because this product is built and tested on
// Windows. A gate that only runs on the maintainer's Mac is a gate with a hole
// in it exactly where the product lives.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * Every gate, in the order a failure is most useful.
 *
 * Types first because a type error makes everything after it noise; then the
 * unit suite, then the build the smokes need, then the smokes themselves. The
 * run does NOT stop at the first failure — these are minutes, and a table
 * showing that three surfaces broke is worth more than one showing the first.
 */
const GATES = [
  ["check", ["run", "check"]],
  ["unit", ["run", "test"]],
  ["build", ["run", "build"]],
  ["smoke:bootstrap", ["run", "test:smoke"]],
  ["smoke:resident", ["run", "test:smoke:resident"]],
  ["smoke:os-entry", ["run", "test:smoke:os-entry"]],
  ["smoke:pair-handoff", ["run", "test:smoke:pair-handoff"]],
  ["smoke:account", ["run", "test:smoke:account-details"]],
  ["smoke:update", ["run", "test:smoke:update-details"]],
  ["smoke:inbox", ["run", "test:smoke:inbox-page"]],
  ["smoke:lan", ["run", "test:smoke:lan-page"]],
  ["smoke:link", ["run", "test:smoke:link-pane"]],
];

/** `--only=check,unit` runs a subset, for iterating without the smokes. */
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",")) : null;
const selected = GATES.filter(([name]) => only === null || only.has(name));

if (selected.length === 0) {
  process.stderr.write(`gates: --only matched nothing. Names: ${GATES.map(([n]) => n).join(", ")}\n`);
  process.exit(2);
}

const results = [];
for (const [name, args] of selected) {
  const started = Date.now();
  const run = spawnSync(npm, args, { cwd: appRoot, stdio: "inherit", shell: false });
  // `status` is null when the child was killed by a signal, which is a failure
  // and must not read as 0.
  const code = run.status === null ? 1 : run.status;
  results.push({ name, code, seconds: Math.round((Date.now() - started) / 1000), signal: run.signal });
}

const failed = results.filter((r) => r.code !== 0);
process.stdout.write("\n");
for (const r of results) {
  const mark = r.code === 0 ? "ok  " : "FAIL";
  const why = r.signal ? ` (killed by ${r.signal})` : r.code === 0 ? "" : ` (exit ${String(r.code)})`;
  process.stdout.write(`${mark} ${r.name.padEnd(20)} ${String(r.seconds).padStart(4)}s${why}\n`);
}
process.stdout.write(
  failed.length === 0
    ? `\ngates: ${String(results.length)} passed\n`
    : `\ngates: ${String(failed.length)} of ${String(results.length)} FAILED — ${failed.map((r) => r.name).join(", ")}\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
