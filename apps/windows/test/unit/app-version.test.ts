// Where this build learns what version it is.
//
// `process.env.npm_package_version` is set by npm while a SCRIPT is running. A
// packaged app launched from the Start menu has no npm and no such variable, so
// every read of it in shipped code falls through to whatever default sits
// beside it — and a default that happens to equal the current version is a bug
// that will not appear until the first release that changes the number.
//
// It is also settable by whoever starts the process, which `handlers.ts`
// already says of the update path: "a build that read its own identity from the
// environment could be told it was newer than an update by being started
// differently."
//
// This is a source-level check because the correct call, `app.getVersion()`,
// reads metadata that only exists inside a packaged bundle. What can be
// asserted here is that nothing in the main process asks the environment; the
// smoke asserts the runtime half by poisoning the variable.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MAIN = fileURLToPath(new URL("../../src/main", import.meta.url));

function everySourceFile(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return everySourceFile(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("the version a shipped build reports", () => {
  it("is never read from the environment", () => {
    const offenders: string[] = [];
    for (const file of everySourceFile(MAIN)) {
      const source = readFileSync(file, "utf8");
      for (const [index, line] of source.split(/\r?\n/).entries()) {
        // The comments explaining WHY this is wrong are allowed to name it.
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
        if (line.includes("npm_package_version")) {
          offenders.push(`${path.relative(MAIN, file)}:${index + 1}`);
        }
      }
    }
    expect(offenders, offenders.join(", ")).toEqual([]);
  });

  // The two that were wrong, named so a revert is loud rather than quiet. One
  // of them is sent to central during Device Inbox enrolment and validated
  // there, so it is not a diagnostic string.
  it("comes from app.getVersion() at both of the call sites that had it wrong", () => {
    const handlers = readFileSync(path.join(MAIN, "handlers.ts"), "utf8");
    expect(handlers).toMatch(/^\s*version: app\.getVersion\(\),$/m);
    expect(handlers).toMatch(/^\s*appVersion: app\.getVersion\(\),$/m);
  });

  // A literal beside a fallback is how the defect hid: it was correct only
  // because the package version happened to equal it.
  it("has no hard-coded version literal left in the main process", () => {
    for (const file of everySourceFile(MAIN)) {
      const source = readFileSync(file, "utf8");
      const code = source
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
        .join("\n");
      expect(code, path.relative(MAIN, file)).not.toMatch(/\?\?\s*"0\.0\.1"/);
    }
  });
});
