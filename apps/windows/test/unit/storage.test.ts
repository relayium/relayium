import { describe, expect, it } from "vitest";
import { resolveDataRoot, APP_DIRECTORY, type DataRootEnvironment } from "../../src/main/storage.js";

// Real Windows path strings, judged by Windows rules. These tests run on macOS
// and Linux in CI's unit lane, so the implementation must reach for
// `path.win32` rather than the host's module — otherwise `C:\Users\me` is one
// relative segment and every rule below is being tested against a non-path.
const win = (over: Partial<DataRootEnvironment> = {}): DataRootEnvironment => ({
  platform: "win32",
  localAppData: "C:\\Users\\lily\\AppData\\Local",
  installDirectory: "C:\\Users\\lily\\AppData\\Local\\Programs\\Relayium",
  override: undefined,
  ...over,
});

describe("the local profile, never Roaming", () => {
  it("anchors under %LOCALAPPDATA%", () => {
    const result = resolveDataRoot(win());
    expect(result).toEqual({
      ok: true,
      path: `C:\\Users\\lily\\AppData\\Local\\${APP_DIRECTORY}`,
    });
  });

  // Roaming is synchronised to a server on domain- and Entra-joined machines.
  // An installation identity that roams makes two devices claim one device row;
  // a Device Inbox key that roams turns a one-device mailbox into several.
  it("fails closed when the local profile is absent, rather than falling back", () => {
    expect(resolveDataRoot(win({ localAppData: undefined }))).toEqual({
      ok: false,
      reason: "no-local-app-data",
    });
    expect(resolveDataRoot(win({ localAppData: "" }))).toEqual({
      ok: false,
      reason: "no-local-app-data",
    });
  });

  it("never consults APPDATA, even when it is the only thing set", () => {
    const result = resolveDataRoot(win({ localAppData: undefined }));
    expect(result.ok).toBe(false);
    // The Roaming path must not appear in any successful answer.
    expect(JSON.stringify(result)).not.toContain("Roaming");
  });

  it("refuses a relative local profile", () => {
    expect(resolveDataRoot(win({ localAppData: "AppData\\Local" }))).toEqual({
      ok: false,
      reason: "not-absolute",
    });
  });
});

describe("separation from the install directory", () => {
  // An uninstall removes the install directory. State written inside it is the
  // user's keys and history, deleted by an operation that never mentioned them.
  it("accepts a sibling of the install directory", () => {
    expect(resolveDataRoot(win()).ok).toBe(true);
  });

  it("refuses a data root inside the install directory", () => {
    expect(
      resolveDataRoot(win({ installDirectory: "C:\\Users\\lily\\AppData\\Local" })),
    ).toEqual({ ok: false, reason: "inside-install-directory" });
  });

  // NTFS is case-insensitive: these are one directory, and a case-sensitive
  // compare would answer "different" and admit the write.
  it("refuses regardless of case", () => {
    expect(
      resolveDataRoot(win({ installDirectory: "c:\\users\\LILY\\appdata\\local" })),
    ).toEqual({ ok: false, reason: "inside-install-directory" });
  });

  it("refuses regardless of a trailing separator", () => {
    expect(
      resolveDataRoot(win({ installDirectory: "C:\\Users\\lily\\AppData\\Local\\" })),
    ).toEqual({ ok: false, reason: "inside-install-directory" });
  });

  it("refuses when the data root IS the install directory, however spelled", () => {
    for (const install of [
      `C:\\Users\\lily\\AppData\\Local\\${APP_DIRECTORY}`,
      `c:\\users\\lily\\appdata\\local\\${APP_DIRECTORY.toLowerCase()}`,
      `C:\\Users\\lily\\AppData\\Local\\${APP_DIRECTORY}\\`,
      `C:\\Users\\lily\\AppData\\Local\\.\\${APP_DIRECTORY}`,
    ]) {
      expect(resolveDataRoot(win({ installDirectory: install })).ok).toBe(false);
    }
  });

  // The separator boundary still has to hold, or a merely similar name is
  // treated as a parent and a legitimate layout is refused.
  it("does not treat a similarly-named sibling as a parent", () => {
    expect(
      resolveDataRoot(win({ installDirectory: "C:\\Users\\lily\\AppData\\Local-Other" })).ok,
    ).toBe(true);
  });
});

describe("non-Windows hosts", () => {
  it("has no invented default", () => {
    expect(resolveDataRoot(win({ platform: "darwin" }))).toEqual({
      ok: false,
      reason: "unsupported-platform",
    });
  });

  it("uses an explicit isolated root when one is supplied", () => {
    const root = process.platform === "win32" ? "C:\\temp\\task-owned" : "/tmp/task-owned";
    expect(resolveDataRoot(win({ platform: "darwin", override: root }))).toEqual({
      ok: true,
      path: root,
    });
  });

  it("refuses a relative override", () => {
    expect(resolveDataRoot(win({ platform: "darwin", override: "relative/root" }))).toEqual({
      ok: false,
      reason: "not-absolute",
    });
  });
});
