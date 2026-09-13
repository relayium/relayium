// The local gate runner covers every gate.
//
// A pre-push check with a hole in it is worse than none: it answers "all
// green" about a subset nobody remembers choosing. So the list inside
// `build/gates.mjs` is checked against `package.json` rather than trusted —
// the same rule four restated sets have already earned today.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const APP = fileURLToPath(new URL("../..", import.meta.url));
const REPO = fileURLToPath(new URL("../../../..", import.meta.url));
const gates = readFileSync(path.join(APP, "build", "gates.mjs"), "utf8");
const scripts: Record<string, string> = JSON.parse(
  readFileSync(path.join(APP, "package.json"), "utf8"),
).scripts;
const workflow = readFileSync(path.join(REPO, ".github", "workflows", "windows.yml"), "utf8");

/** The npm scripts the runner actually invokes, read out of its own source. */
function invoked(): string[] {
  return [...gates.matchAll(/\["run", "([^"]+)"\]/g)].map((m) => m[1] as string);
}

describe("the local gate runner", () => {
  it("invokes something this test can actually see", () => {
    // Guards the test: a change to how the list is written would otherwise
    // report perfect coverage of an empty set.
    expect(invoked().length).toBeGreaterThanOrEqual(10);
    expect(invoked()).toContain("check");
  });

  it("runs every renderer and lifecycle smoke", () => {
    // Derived from `package.json`, so a NEW smoke is missing from the local
    // gate until it is added — which is the whole point. Four sets today were
    // hand-written copies that went stale exactly this way.
    const smokes = Object.keys(scripts).filter((name) => name.startsWith("test:smoke"));
    expect(smokes.length).toBeGreaterThanOrEqual(9);
    for (const smoke of smokes) {
      expect(invoked(), smoke).toContain(smoke);
    }
  });

  it("runs the three that are not smokes", () => {
    for (const core of ["check", "test", "build"]) {
      expect(invoked(), core).toContain(core);
    }
  });

  it("names only scripts that exist", () => {
    for (const name of invoked()) {
      expect(scripts[name], name).toBeTruthy();
    }
  });

  it("is deliberately NOT a CI step", () => {
    // CI runs these as separate named steps so a failure names the surface
    // without anybody opening a log — its own comment says so. Collapsing them
    // into one step would take that away, so the workflow must not call this.
    expect(workflow).not.toContain("npm run gates");
    // And it must stay outside the `test:smoke` namespace, because the
    // orphan-smoke pin requires every script there to be invoked BY the
    // workflow — which this one deliberately is not.
    expect(Object.keys(scripts)).toContain("gates");
    expect(Object.keys(scripts).filter((n) => n.startsWith("test:smoke"))).not.toContain("gates");
  });
});
