// axe-core is a development-only scanner. This test is the guard that keeps it
// that way.
//
// The failure it prevents is quiet and expensive: one `import "axe-core"` from a
// component would pull ~600KB of accessibility rules into the production bundle
// that every visitor downloads, and nothing else in the build would complain
// about it. So the rule is written down here instead of trusted to review —
// the scanner reads axe off disk from node_modules (see e2e/a11y-core.mjs), and
// src/ must never mention it at all.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const webRoot = resolve(import.meta.dirname, "..", "..");
const srcRoot = join(webRoot, "src");
const pkg = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf8"));

/** Every source file under src/, minus vitest's own cache (it lands in src/lib/node_modules). */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|js|svelte|css|html)$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe("axe-core stays a development dependency", () => {
  it("is declared in devDependencies only", () => {
    expect(pkg.devDependencies?.["axe-core"], "axe-core must be a devDependency").toBeTruthy();
    expect(pkg.dependencies?.["axe-core"], "axe-core must NOT be a runtime dependency").toBeUndefined();
  });

  it("is referenced by no file under src/", () => {
    const thisFile = resolve(import.meta.filename);
    const offenders = sourceFiles(srcRoot)
      .filter((path) => path !== thisFile)
      .filter((path) => /axe-core|axe\.min\.js/.test(readFileSync(path, "utf8")))
      .map((path) => relative(webRoot, path));
    expect(offenders, `these shipped sources reference axe: ${offenders.join(", ")}`).toEqual([]);
  });
});
