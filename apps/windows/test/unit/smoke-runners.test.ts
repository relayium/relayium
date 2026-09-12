// Every smoke entry point has something that runs it.
//
// Four did not. `os-entry`, `pair-handoff`, `account-details` and
// `update-details` each build the real Svelte client and drive it in a real
// Electron renderer — 341 assertions between them — and no workflow and no
// package script named any of them. They had never executed on Windows.
//
// A harness with no runner is invisible in the same way a passing test is: the
// log says nothing about it either way, and the repository looks like it has
// coverage it has never once exercised. Finding them took reading a GREEN run
// for what it skipped, which is not a thing anybody does on a schedule.
//
// So it is a test. The fifth harness cannot be added and forgotten.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SMOKE = fileURLToPath(new URL("../smoke", import.meta.url));
const APP = fileURLToPath(new URL("../..", import.meta.url));
const REPO = fileURLToPath(new URL("../../../..", import.meta.url));

/**
 * An ENTRY POINT is a harness a person or a job starts.
 *
 * `*-main.mjs` files are the children those wrappers spawn, and the rest are
 * libraries the harnesses import — neither is started directly, so neither
 * needs a runner. The distinction is by suffix because that is the convention
 * this directory already follows.
 */
function entryPoints(): string[] {
  return readdirSync(SMOKE)
    .filter((name) => name.endsWith(".mjs"))
    .filter((name) => name.endsWith("-smoke.mjs") || name.endsWith("-acceptance.mjs") || name === "secret-durability.mjs");
}

const workflow = readFileSync(path.join(REPO, ".github", "workflows", "windows.yml"), "utf8");
const scripts: Record<string, string> = JSON.parse(readFileSync(path.join(APP, "package.json"), "utf8")).scripts;

/** Whether anything actually starts this file: a workflow line, or a script a workflow runs. */
function hasRunner(entry: string): boolean {
  if (workflow.includes(entry)) return true;
  for (const [name, body] of Object.entries(scripts)) {
    if (body.includes(entry) && workflow.includes(`npm run ${name}`)) return true;
  }
  return false;
}

describe("every smoke entry point", () => {
  it("is a set this test can actually see", () => {
    // Guards the test: a suffix convention that changed would otherwise report
    // perfect coverage of an empty list.
    const found = entryPoints();
    expect(found.length).toBeGreaterThanOrEqual(8);
    expect(found).toContain("electron-smoke.mjs");
    expect(found).toContain("installed-acceptance.mjs");
  });

  it("has something that runs it", () => {
    const orphans = entryPoints().filter((entry) => !hasRunner(entry));
    expect(orphans, `no workflow step or invoked script starts: ${orphans.join(", ")}`).toEqual([]);
  });

  // The other half of the same mistake: a script nobody calls looks like a
  // runner in `package.json` and is not one.
  it("is started by a script the workflow actually invokes", () => {
    const dead = Object.entries(scripts)
      .filter(([name, body]) => name.startsWith("test:smoke") && !workflow.includes(`npm run ${name}`))
      .map(([name]) => name);
    expect(dead, `these smoke scripts are never invoked by CI: ${dead.join(", ")}`).toEqual([]);
  });
});
