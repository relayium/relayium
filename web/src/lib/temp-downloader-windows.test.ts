import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { windowsTempDownloaderScript } from "./temp-downloader";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe.skipIf(process.platform !== "win32")("the Windows temporary downloader", () => {
  it(
    "verifies, extracts and runs the official CLI, then cleans after an error",
    () => {
      const tempBase = mkdtempSync(join(tmpdir(), "relayium-powershell-"));
      try {
        // Port 9 is deliberately closed on the hosted runner. Reaching the
        // wrapper's exit-code error proves the pinned archive passed SHA-256,
        // expanded, and its real relayium.exe was invoked; a checksum failure
        // or PowerShell parse error cannot satisfy this assertion.
        const link = `http://127.0.0.1:9/d/windows-ci#k=${KEY}`;
        const result = spawnSync(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            windowsTempDownloaderScript(link, "."),
          ],
          {
            encoding: "utf8",
            env: { ...process.env, TEMP: tempBase, TMP: tempBase },
            timeout: 120_000,
          },
        );

        expect(result.error).toBeUndefined();
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain("relayium down failed with exit code");
        expect(`${result.stdout}\n${result.stderr}`).not.toContain("pinned SHA-256 mismatch");
        expect(readdirSync(tempBase), "the random relayium temp directory remains").toEqual([]);
      } finally {
        rmSync(tempBase, { recursive: true, force: true });
      }
    },
    150_000,
  );
});
