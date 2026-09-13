// The identity a Windows toast is attributed to, checked in both places it is
// written.
//
// On Windows a notification is attributed to an AppUserModelID. The one that
// exists on a machine belongs to the installed SHORTCUT, which electron-builder
// stamps from `appId`; the running process claims one by calling
// `setAppUserModelId`. When those two strings differ, nothing errors and nothing
// is logged — the toast is attributed to an identity no shortcut owns, and it
// either shows unattributed or never appears. Every unit test of the
// notification path still passes, because they exercise the seam and the seam is
// fine.
//
// `main.ts` says the literal is spelled out "so a mismatch is a visible edit".
// Visible is not checked; a person has to be looking at both files in the same
// afternoon. This is the check.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), "utf8");

/** What electron-builder stamps onto the shortcuts it creates. */
function packagedAppId(): string {
  const line = read("electron-builder.yml")
    .split(/\r?\n/)
    .find((l) => /^appId:/.test(l));
  expect(line, "electron-builder.yml has no appId").toBeTruthy();
  return line!.replace(/^appId:\s*/, "").trim();
}

/** What the running process claims it is. */
function runtimeAppId(): string | null {
  const match = read("src/main/main.ts").match(/setAppUserModelId\("([^"]+)"\)/);
  return match?.[1] ?? null;
}

describe("the AppUserModelID", () => {
  it("is claimed by the process at all", () => {
    // Without the call, Electron uses a per-process default that matches no
    // installed shortcut.
    expect(runtimeAppId()).not.toBeNull();
  });

  it("is the same string the installer stamps on the shortcut", () => {
    expect(runtimeAppId()).toBe(packagedAppId());
  });

  it("is a real identity rather than an empty or placeholder one", () => {
    const id = packagedAppId();
    expect(id.length).toBeGreaterThan(0);
    expect(id).not.toMatch(/^(com\.electron|com\.example|todo|changeme)/i);
    // Quoting in the YAML would make the shortcut's identity include the
    // quotes, which is a mismatch that looks identical when read aloud.
    expect(id).not.toMatch(/^["']|["']$/);
  });

  // Windows-only in effect, and guarded in the source for that reason. A call
  // made unconditionally would set an identity on macOS too, where the concept
  // does not exist.
  it("is claimed only on Windows", () => {
    const source = read("src/main/main.ts");
    expect(source).toMatch(/process\.platform === "win32"\) app\.setAppUserModelId\(/);
  });
});
