// Every smoke harness answers `check` the same way.
//
// This exists because the difference cost a whole scenario. `smoke-main.mjs`
// gained a guard written as `if (!check(...)) return;` — the idiom used in
// `installed-acceptance.mjs`, whose `check` returns the boolean. That one did
// not, so the guard read `if (!undefined) return;`, the function returned on its
// first line, and the run stayed green: a scenario that never executes reports
// nothing at all.
//
// Four other harnesses had the same undefined-returning shape. None of them had
// sprung it yet, which is the only reason this is a sweep and not an outage.
// The lesson from the version defect earlier the same night applies exactly: a
// fix taken in one file and not carried to its siblings has a half-life.
//
// So the contract is pinned rather than remembered. A new harness that defines
// its own `check` — as all six do, deliberately, because each owns its own
// failure list — has to answer like the others.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SMOKE = fileURLToPath(new URL("../smoke", import.meta.url));

/** The code, without the prose that explains it. */
const withoutComments = (body: string): string =>
  body
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

/** Every harness that defines a `check` of its own. */
function harnessesDefiningCheck(): { file: string; body: string }[] {
  const found: { file: string; body: string }[] = [];
  for (const entry of readdirSync(SMOKE)) {
    if (!entry.endsWith(".mjs")) continue;
    const source = readFileSync(path.join(SMOKE, entry), "utf8");
    // The definition and everything up to the closing brace of the arrow body.
    const match = source.match(/const check = \(name, ok, detail\) => \{([\s\S]*?)\n\};/);
    if (match) found.push({ file: entry, body: match[1]! });
  }
  return found;
}

describe("the check() contract every smoke harness shares", () => {
  it("is defined by more than one harness, so this test has something to compare", () => {
    // Guards the test itself: a regex that stopped matching would otherwise
    // report perfect agreement across an empty set.
    expect(harnessesDefiningCheck().length).toBeGreaterThanOrEqual(5);
  });

  it("returns its result in every one of them", () => {
    // COMMENTS STRIPPED FIRST, and that is not a detail. The first version of
    // this test looked for the word `return` anywhere in the body — and the
    // explanatory comment these definitions now carry contains the phrase
    // `if (!check(...)) return;`, so every harness satisfied it including one
    // deliberately broken to prove otherwise. A test made vacuous by the
    // comment beside the code it checks is the same fault, one level up.
    const silent = harnessesDefiningCheck()
      .filter(({ body }) => !/\breturn\b/.test(withoutComments(body)))
      .map(({ file }) => file);
    expect(silent, `these still return undefined: ${silent.join(", ")}`).toEqual([]);
  });

  it("records the failure before returning, in every one of them", () => {
    // Returning is only half of it. A `check` that answered without recording
    // would make a guard work and the run lie.
    for (const { file, body } of harnessesDefiningCheck()) {
      expect(body, file).toMatch(/failures\.push/);
    }
  });
});
