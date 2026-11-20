import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Use the npm JavaScript entry point supplied by `npm run`. A .cmd file is
// not an executable for CreateProcess; shell:true would reinterpret arguments.
export function npmCommand(env = process.env) {
  const cli = env.npm_execpath;
  if (!cli || !existsSync(cli) || !/\.(?:c?js|mjs)$/i.test(cli)) {
    throw new Error("Start this command through npm run (npm_execpath must name npm's JavaScript entry point).");
  }
  return { command: process.execPath, prefix: [cli] };
}

export function selectGates(gates, args) {
  if (args.some((arg) => !arg.startsWith("--only=")) || args.length > 1) {
    throw new Error("Usage: npm run gates -- [--only=check,unit,...]");
  }
  if (!args.length) return gates;
  const names = args[0].slice("--only=".length).split(",");
  const known = new Set(gates.map(([name]) => name));
  if (names.some((name) => !known.has(name)) || new Set(names).size !== names.length) {
    throw new Error(`Unknown, empty or duplicate gate. Names: ${[...known].join(", ")}`);
  }
  return gates.filter(([name]) => names.includes(name));
}

// No application output is kept in memory. Wait for close (all pipes drained),
// flush the log, THEN record the result. The called harness owns its deadlines
// and descendants; this wrapper never kills a process and calls that a pass.
export async function runCommand(step, logPath, env = process.env, echo = true) {
  const log = createWriteStream(logPath, { fd: openSync(logPath, "wx", 0o600) });
  const stdoutLog = step.goTests
    ? createWriteStream(`${logPath}.stdout`, { fd: openSync(`${logPath}.stdout`, "wx", 0o600) }) : null;
  let logError = null;
  log.on("error", (err) => { logError = err.message; });
  stdoutLog?.on("error", (err) => { logError = err.message; });
  const started = Date.now();
  const child = spawn(step.command, step.args, {
    cwd: step.cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"],
  });
  let error = null;
  child.on("error", (err) => { error = err.message; });
  for (const [stream, terminal] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.on("data", (data) => {
      log.write(data);
      if (stream === child.stdout) stdoutLog?.write(data);
      if (echo) terminal.write(data);
    });
  }
  const { code, signal } = await new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  await Promise.all([log, stdoutLog].filter(Boolean).map((output) => new Promise((resolve) => {
    if (output.closed) resolve();
    else { output.once("close", resolve); output.end(); }
  })));
  return {
    name: step.name, status: code === 0 && !error && !logError && !signal ? "PASS" : "FAIL",
    code, signal, error: error ?? logError, milliseconds: Date.now() - started,
    log: logPath,
  };
}

export function goTestSummary(text) {
  const events = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const tests = events.filter((e) => e.Test && ["pass", "skip", "fail"].includes(e.Action));
  if (!tests.length) throw new Error("Native tests produced no completed test events.");
  return {
    passed: tests.filter((e) => e.Action === "pass").length,
    failed: tests.filter((e) => e.Action === "fail").map((e) => `${e.Package}/${e.Test}`),
    skipped: tests.filter((e) => e.Action === "skip").map((e) => `${e.Package}/${e.Test}`),
  };
}

export function vitestSummary(text) {
  const report = JSON.parse(text);
  const assertions = report.testResults?.flatMap((suite) => suite.assertionResults ?? []) ?? [];
  if (!assertions.length || !Number.isInteger(report.numPassedTests) || report.numTotalTests !== assertions.length) {
    throw new Error("Unit tests produced no complete test inventory.");
  }
  if (assertions.some((a) => !["passed", "failed", "pending", "skipped", "todo", "disabled"].includes(a.status))) {
    throw new Error("Unit tests reported an unknown test state.");
  }
  return {
    passed: report.numPassedTests,
    failed: assertions.filter((a) => a.status === "failed").map((a) => a.fullName),
    skipped: assertions.filter((a) => ["pending", "skipped", "todo", "disabled"].includes(a.status)).map((a) => a.fullName),
    success: report.success === true && report.numFailedTests === 0,
  };
}

export async function runPlan(steps, directory, metadata, { env = process.env, echo = true, finalCheck } = {}) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const reportPath = join(directory, "report.json");
  const report = { schema: 1, ...metadata, planned: steps.map((s) => s.name), started: new Date().toISOString(), status: "RUNNING", steps: [] };
  // Refuse to overwrite an earlier run, including an interrupted one.
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  for (const [index, step] of steps.entries()) {
    const logPath = join(directory, `${String(index + 1).padStart(2, "0")}-${step.name}.log`);
    const unitReport = `${logPath}.vitest.json`;
    const command = step.vitest ? { ...step, args: [...step.args, "--", "--reporter=default", "--reporter=json", `--outputFile=${unitReport}`] } : step;
    const result = await runCommand(command, logPath, env, echo);
    if (step.goTests && result.status === "PASS") {
      try {
        result.tests = goTestSummary(readFileSync(`${logPath}.stdout`, "utf8"));
        if (result.tests.failed.length) result.status = "FAIL";
      } catch (err) { result.status = "FAIL"; result.error = err.message; }
    }
    if (step.vitest && result.status === "PASS") {
      try {
        result.tests = vitestSummary(readFileSync(unitReport, "utf8"));
        if (!result.tests.success || result.tests.failed.length) result.status = "FAIL";
      } catch (err) { result.status = "FAIL"; result.error = err.message; }
    }
    report.steps.push(result);
    save();
    // Build/preflight failure cannot be followed by a test against stale output.
    if (result.status === "FAIL") break;
  }
  report.finished = new Date().toISOString();
  report.status = report.steps.some((r) => r.status === "FAIL") ? "FAIL"
    : report.steps.some((r) => r.tests?.skipped.length) ? "PASS_WITH_SKIPS" : "PASS";
  if (finalCheck) {
    try { report.sourceEnd = finalCheck(); }
    catch (err) { report.status = "FAIL"; report.sourceError = err.message; }
  }
  report.notRun = steps.slice(report.steps.length).map((step) => step.name);
  save();
  return report;
}
