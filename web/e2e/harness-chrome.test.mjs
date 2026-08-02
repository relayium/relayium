import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveChrome } from "./harness.mjs";

const originalChromePath = process.env.CHROME_PATH;
const temporary = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "relayium-chrome-path-"));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  if (originalChromePath === undefined) delete process.env.CHROME_PATH;
  else process.env.CHROME_PATH = originalChromePath;
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Chrome path resolution", () => {
  it("honours an explicit executable file", () => {
    const path = join(tempDir(), "chrome");
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
    process.env.CHROME_PATH = path;

    expect(resolveChrome()).toBe(path);
  });

  it("rejects a missing explicit path instead of silently falling back", () => {
    process.env.CHROME_PATH = join(tempDir(), "missing");
    expect(() => resolveChrome()).toThrow(/there is no such file/);
  });

  it("rejects a directory with an actionable error", () => {
    const path = join(tempDir(), "Chrome.app");
    mkdirSync(path);
    process.env.CHROME_PATH = path;
    expect(() => resolveChrome()).toThrow(/directory, not an executable/);
  });

  it("rejects a regular file without execute permission", () => {
    const path = join(tempDir(), "chrome");
    writeFileSync(path, "not executable\n");
    chmodSync(path, 0o644);
    process.env.CHROME_PATH = path;
    expect(() => resolveChrome()).toThrow(/not executable by this user/);
  });
});
