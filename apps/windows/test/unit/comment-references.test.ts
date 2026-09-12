// A comment that names a test file is a promise that the file is there.
//
// Three of them were not. `capabilities.ts` said `inbox-capabilities.test.ts`
// "pins that they are only advertised together with their implementation";
// `bridge.ts` said `ipc-contract.test.ts` "is what keeps the two honest";
// `window.ts` said `window.test.ts` "can assert the exact set". None of those
// files exists. In all three cases the coverage DID exist, under another name —
// so nothing was untested, and a reader grepping the named file would have
// concluded otherwise and possibly written it again.
//
// That is the failure this guards: not missing coverage, but a signpost that
// points at nothing. Renaming a test file is the ordinary way to create one.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = fileURLToPath(new URL("../../../..", import.meta.url));
const ROOTS = ["apps/windows/src", "apps/windows/native", "apps/windows/build"];

/**
 * References this repository does not own.
 *
 * `syscall_windows_test.go` is cited from `golang.org/x/sys/windows`, with the
 * line number, as the source of a documented syscall behaviour. Naming it is
 * the point; vendoring it is not. Anything added here needs the same kind of
 * reason.
 */
const EXTERNAL = new Set(["syscall_windows_test.go"]);

function sourceFiles(dir: string): string[] {
  const full = path.join(REPO, dir);
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const child = path.join(at, entry);
      if (statSync(child).isDirectory()) walk(child);
      else if (/\.(ts|go|mjs|cts|svelte)$/.test(entry)) out.push(child);
    }
  };
  walk(full);
  return out;
}

/** Every test file named anywhere in the repository, by basename. */
function testFilesInRepo(): Set<string> {
  const found = new Set<string>();
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "release") continue;
      const child = path.join(at, entry);
      if (statSync(child).isDirectory()) walk(child);
      else if (/\.test\.(ts|mjs)$|_test\.go$/.test(entry)) found.add(entry);
    }
  };
  walk(REPO);
  return found;
}

describe("test files named in comments", () => {
  const named = new Map<string, string>();
  for (const file of ROOTS.flatMap(sourceFiles)) {
    for (const match of readFileSync(file, "utf8").matchAll(/[A-Za-z0-9_.-]+\.test\.(?:ts|mjs)|[A-Za-z0-9_]+_test\.go/g)) {
      if (!named.has(match[0])) named.set(match[0], path.relative(REPO, file));
    }
  }

  it("finds some, so this test cannot pass by matching nothing", () => {
    expect(named.size).toBeGreaterThanOrEqual(8);
  });

  it("all exist", () => {
    const existing = testFilesInRepo();
    const dangling = [...named]
      .filter(([name]) => !existing.has(name) && !EXTERNAL.has(name))
      .map(([name, from]) => `${name} (named by ${from})`);
    expect(dangling, `these comments name a test file that does not exist:\n  ${dangling.join("\n  ")}`).toEqual([]);
  });
});
