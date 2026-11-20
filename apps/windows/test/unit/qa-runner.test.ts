import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
// Plain Node entry points are also executable without the renderer toolchain.
// @ts-expect-error JavaScript build tooling has no declaration file.
import { npmCommand, selectGates, runCommand, runPlan, goTestSummary, vitestSummary } from "../../build/qa-runner.mjs";
// @ts-expect-error JavaScript build tooling has no declaration file.
import { profileFromArgs, qaSteps } from "../../build/qa.mjs";
// @ts-expect-error JavaScript build tooling has no declaration file.
import { GATES } from "../../build/gates.mjs";

const npmCli = createRequire(import.meta.url).resolve("vitest/package.json");
const child = (name: string, source: string) => ({ name, command: process.execPath, args: ["-e", source], cwd: tmpdir() });
async function temporary(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "relayium-qa-controls-"));
  try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("personal-machine QA controls", () => {
  it("rejects partial matches, empty names and duplicates before running any gate", () => {
    for (const args of [["--only=check,typo"], ["--only="], ["--only=unit,unit"], ["--unknown"], ["--only=check", "--only=unit"]]) {
      expect(() => selectGates(GATES, args)).toThrow();
    }
    expect(selectGates(GATES, ["--only=check,unit"]).map(([name]: string[]) => name)).toEqual(["check", "unit"]);
    expect(selectGates(GATES, [])).toEqual(GATES);
  });

  it("requires an actual npm JavaScript entry rather than a cmd shell", () => {
    for (const env of [{}, { npm_execpath: "missing.js" }, { npm_execpath: npmCli }]) {
      expect(() => npmCommand(env)).toThrow();
    }
  });

  it("executes arguments with spaces and shell metacharacters literally", async () => temporary(async (dir) => {
    const value = 'spaces & echo INJECTED | $(echo expanded) "quoted"';
    const step = child("literal", "process.stdout.write(process.argv[1]);");
    step.args.push(value);
    const result = await runCommand(step, join(dir, "literal.log"), process.env, false);
    expect(result.status).toBe("PASS");
    expect(readFileSync(result.log, "utf8")).toBe(value);
  }));

  it("starts a JavaScript npm entry point through Node without a shell", async () => temporary(async (dir) => {
    const cli = join(dir, "npm cli with spaces.cjs");
    writeFileSync(cli, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    const npm = npmCommand({ npm_execpath: cli });
    const result = await runCommand({ name: "npm", command: npm.command, args: [...npm.prefix, "run", "check"] }, join(dir, "npm.log"), process.env, false);
    expect(result.status).toBe("PASS");
    expect(JSON.parse(readFileSync(result.log, "utf8"))).toEqual(["run", "check"]);
  }));

  it("preserves native failure and launch errors; never reports them as zero", async () => temporary(async (dir) => {
    const bad = await runCommand(child("bad", "process.stderr.write('retained failure'); process.exit(7)"), join(dir, "bad.log"), process.env, false);
    expect(bad).toMatchObject({ status: "FAIL", code: 7 });
    expect(readFileSync(bad.log, "utf8")).toBe("retained failure");
    const missing = await runCommand({ name: "missing", command: join(dir, "absent-executable"), args: [] }, join(dir, "missing.log"), process.env, false);
    expect(missing.status).toBe("FAIL");
    expect(missing.error).toBeTruthy();
  }));

  it("does not treat process termination as success", async () => temporary(async (dir) => {
    const result = await runCommand(child("terminated", "process.kill(process.pid, 'SIGTERM')"), join(dir, "signal.log"), process.env, false);
    expect(result.status).toBe("FAIL");
  }));

  it("stops before dependent tests can use stale build outputs and retains source binding", async () => temporary(async (dir) => {
    const report = await runPlan([child("build", "process.exit(3)"), child("must-not-run", "process.exit(0)")], dir,
      { commit: "test-source", profile: "control" }, { echo: false });
    expect(report.status).toBe("FAIL");
    expect(report.notRun).toEqual(["must-not-run"]);
    expect(report.steps).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "report.json"), "utf8"))).toMatchObject({ commit: "test-source", status: "FAIL" });
    await expect(runPlan([], dir, {}, { echo: false })).rejects.toThrow();
  }));

  it("keeps native skips qualified and separates Go stderr from test events", async () => temporary(async (dir) => {
    const events = [{ Action: "pass", Package: "native", Test: "executed" }, { Action: "skip", Package: "native", Test: "needs-second-user" }];
    const report = await runPlan([{ ...child("native", `process.stderr.write('go: downloading dependency\\n'); console.log(${JSON.stringify(events.map((e) => JSON.stringify(e)).join("\n"))})`), goTests: true }], dir, {}, { echo: false });
    expect(report.status).toBe("PASS_WITH_SKIPS");
    expect(report.steps[0].tests.skipped).toEqual(["native/needs-second-user"]);
    expect(readFileSync(report.steps[0].log, "utf8")).toContain("downloading dependency");
  }));

  it("fails empty, malformed and failed native inventories", () => {
    expect(() => goTestSummary("")).toThrow();
    expect(() => goTestSummary("not-json")).toThrow();
    expect(goTestSummary('{"Action":"fail","Package":"p","Test":"broken"}\r\n').failed).toEqual(["p/broken"]);
  });

  it("records unit skips and refuses incomplete inventories even with process exit zero", async () => temporary(async (dir) => {
    const raw = { numPassedTests: 1, numTotalTests: 2, numFailedTests: 0, success: true,
      testResults: [{ assertionResults: [{ status: "passed", fullName: "ran" }, { status: "pending", fullName: "Windows only" }] }] };
    expect(vitestSummary(JSON.stringify(raw)).skipped).toEqual(["Windows only"]);
    expect(() => vitestSummary(JSON.stringify({ ...raw, numTotalTests: 3 }))).toThrow();
    const report = await runPlan([{ ...child("unit", "process.exit(0)"), vitest: true }], dir, {}, { echo: false });
    expect(report.status).toBe("FAIL"); // no reporter output: not proof of execution
  }));

  it("refuses success when source identity changes during execution", async () => temporary(async (dir) => {
    const report = await runPlan([child("test", "process.exit(0)")], dir, {}, {
      echo: false, finalCheck: () => { throw new Error("source changed"); },
    });
    expect(report.status).toBe("FAIL");
    expect(report.sourceError).toBe("source changed");
  }));

  it("never defaults a Mac run to a Windows pass, and rejects unknown profile arguments", () => {
    expect(() => profileFromArgs([], "darwin")).toThrow("requires Windows");
    expect(() => profileFromArgs(["--profile=typo"], "win32")).toThrow();
    expect(profileFromArgs([], "win32")).toBe("windows");
    expect(profileFromArgs(["--profile=portable"], "darwin")).toBe("portable");
    const npm = { command: "node", prefix: ["npm-cli.js"] };
    const portable = qaSteps("portable", tmpdir(), npm);
    expect(portable.map((s: { name: string }) => s.name)).toEqual(["check", "unit", "build"]);
    const windows = qaSteps("windows", tmpdir(), npm);
    expect(windows.map((s: { name: string }) => s.name)).toContain("secret-durability");
    expect(windows.findIndex((s: { name: string }) => s.name === "build-secret-helper")).toBeLessThan(windows.findIndex((s: { name: string }) => s.name === "unit"));
    expect(windows.some((s: { name: string }) => /install|mount|xuser/.test(s.name))).toBe(false);
  });
});
