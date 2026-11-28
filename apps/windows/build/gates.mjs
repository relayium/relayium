// Local checks shared with the personal-machine QA entry point.
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmCommand, runPlan, selectGates } from "./qa-runner.mjs";

export const GATES = [
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

export function gateSteps(selected, appRoot, npm) {
  return selected.map(([name, args]) => ({ name, command: npm.command, args: [...npm.prefix, ...args], cwd: appRoot, vitest: name === "unit" }));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const selected = selectGates(GATES, process.argv.slice(2));
    const npm = npmCommand();
    const directory = mkdtempSync(join(tmpdir(), "relayium-gates-"));
    console.log(`Evidence: ${directory}`);
    const report = await runPlan(gateSteps(selected, fileURLToPath(new URL("..", import.meta.url)), npm), directory, {
      profile: "selected-gates", platform: process.platform, node: process.version,
      selected: selected.map(([name]) => name),
    });
    console.log(`gates: ${report.status}; ${report.steps.length}/${selected.length} executed; ${directory}`);
    process.exitCode = report.status === "PASS" ? 0 : report.status === "PASS_WITH_SKIPS" ? 2 : 1;
  } catch (err) { console.error(err.message); process.exitCode = 2; }
}
