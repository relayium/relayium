import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentDataRoot,
  currentInstallDirectory,
  resolveDataRoot,
  APP_DIRECTORY,
  type DataRootEnvironment,
} from "../../src/main/storage.js";

// Real Windows path strings, judged by Windows rules. These tests run on macOS
// and Linux in CI's unit lane, so the implementation must reach for
// `path.win32` rather than the host's module — otherwise `C:\Users\me` is one
// relative segment and every rule below is being tested against a non-path.
/**
 * A fake `realpathSync.native`.
 *
 * `links` maps a path to what the kernel would say it really is — a junction,
 * a `subst` drive, a redirected profile. Anything absent resolves to itself;
 * anything in `missing` throws `ENOENT` so the ancestor climb runs; anything in
 * `denied` throws `EACCES`, which must NOT be treated as absent.
 *
 * Case-insensitive, because NTFS is.
 */
const realpathFake = (
  links: Record<string, string> = {},
  missing: readonly string[] = [],
  denied: readonly string[] = [],
): ((target: string) => string) => {
  const fold = (p: string): string => p.toLocaleUpperCase("en-US").replace(/\\+$/, "");
  const linkTable = new Map(Object.entries(links).map(([k, v]) => [fold(k), v]));
  const missingSet = new Set(missing.map(fold));
  const deniedSet = new Set(denied.map(fold));
  return (target: string): string => {
    const key = fold(target);
    if (deniedSet.has(key)) {
      const err: NodeJS.ErrnoException = new Error(`EACCES: ${target}`);
      err.code = "EACCES";
      throw err;
    }
    if (missingSet.has(key)) {
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${target}`);
      err.code = "ENOENT";
      throw err;
    }
    // An alias on an ANCESTOR shows up in the resolved leaf — that is what the
    // real call does, and a fake that only substituted exact matches would let
    // these cases pass for the wrong reason. Longest matching prefix wins.
    let best: string | null = null;
    for (const candidate of linkTable.keys()) {
      if (key === candidate || key.startsWith(`${candidate}\\`)) {
        if (best === null || candidate.length > best.length) best = candidate;
      }
    }
    if (best === null) return target;
    return `${linkTable.get(best)}${target.slice(best.length)}`;
  };
};

const win = (over: Partial<DataRootEnvironment> = {}): DataRootEnvironment => ({
  platform: "win32",
  localAppData: "C:\\Users\\lily\\AppData\\Local",
  installDirectory: "C:\\Users\\lily\\AppData\\Local\\Programs\\Relayium",
  override: undefined,
  // Identity by default: no aliases in play, so these cases test the same
  // containment rules they always did.
  realpath: realpathFake(),
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

// ---------------------------------------------------------------------------
// Alias closure.
//
// The v1 guard compared `path.win32.normalize`d spellings. That collapses `.`,
// `..` and duplicate separators — and nothing else. Every case below passes the
// v1 guard and must be refused by this one.
// ---------------------------------------------------------------------------

describe("aliases, not spellings", () => {
  const LOCAL = "C:\\Users\\lily\\AppData\\Local";

  it("refuses an install directory that is a junction onto the profile", () => {
    // Lexically `C:\Staging` shares nothing with the data root. The kernel says
    // otherwise, and the kernel is right.
    expect(
      resolveDataRoot(
        win({
          installDirectory: "C:\\Staging",
          realpath: realpathFake({ "C:\\Staging": LOCAL }),
        }),
      ),
    ).toEqual({ ok: false, reason: "inside-install-directory" });
  });

  it("refuses a subst drive that lands on the profile", () => {
    // `subst X: %LOCALAPPDATA%` — a namespace alias with NO reparse point
    // anywhere on the path, which is why scanning for reparse attributes to
    // decide whether canonicalisation is needed does not work.
    expect(
      resolveDataRoot(
        win({ installDirectory: "X:\\", realpath: realpathFake({ "X:\\": LOCAL }) }),
      ),
    ).toEqual({ ok: false, reason: "inside-install-directory" });
  });

  it("refuses a drive letter whose resolution lands on the profile", () => {
    // True for a `subst` drive, which the DOS-name form does collapse. NOT a
    // claim about two drive letters mounted on ONE volume: see the documented
    // limitation below, which this fake must not paper over.
    expect(
      resolveDataRoot(
        win({
          installDirectory: "Y:\\Users\\lily\\AppData\\Local",
          realpath: realpathFake({ "Y:\\Users\\lily\\AppData\\Local": LOCAL }),
        }),
      ),
    ).toEqual({ ok: false, reason: "inside-install-directory" });
  });

  it("still installs through a drive letter that lands somewhere else", () => {
    expect(
      resolveDataRoot(
        win({
          installDirectory: "Y:\\Programs\\Relayium",
          realpath: realpathFake({ "Y:\\Programs\\Relayium": "C:\\Programs\\Relayium" }),
        }),
      ).ok,
    ).toBe(true);
  });

  /**
   * The limitation, asserted rather than left as prose.
   *
   * libuv 1.52.1 resolves with `VOLUME_NAME_DOS`, so when one volume has two
   * DOS mount points the returned name is whichever Windows picks, and two
   * paths naming the same directory through different letters can come back
   * as different strings. This test pins that gap so nobody later reads the
   * cases above as covering it: the guard PERMITS here, and the NSIS
   * volume-GUID guard is what refuses it before extraction.
   */
  it("does NOT catch one volume reached through two DOS mount points", () => {
    expect(
      resolveDataRoot(
        win({
          installDirectory: "Y:\\Users\\lily\\AppData\\Local",
          // Both letters are the same volume, but DOS-form resolution returns
          // each unchanged — which is exactly the case it cannot see.
          realpath: realpathFake(),
        }),
      ).ok,
    ).toBe(true);
  });

  it("resolves the PRIVATE side too, not just the destination", () => {
    // A redirected profile: %LOCALAPPDATA% really lives on D:. The install
    // directory names D: honestly, so only resolving the destination would miss
    // the collision entirely.
    expect(
      resolveDataRoot(
        win({
          installDirectory: "D:\\Profiles\\lily",
          realpath: realpathFake({ [LOCAL]: "D:\\Profiles\\lily\\Local" }),
        }),
      ),
    ).toEqual({ ok: false, reason: "inside-install-directory" });
  });

  it("still installs into an ordinary junction that goes somewhere harmless", () => {
    // The over-refusal regression. A guard that refuses every alias is not a
    // guard, it is a machine that cannot be installed on.
    expect(
      resolveDataRoot(
        win({
          installDirectory: "C:\\Staging",
          realpath: realpathFake({ "C:\\Staging": "C:\\Program Files\\Relayium" }),
        }),
      ),
    ).toEqual({ ok: true, path: `${LOCAL}\\${APP_DIRECTORY}` });
  });

  it("still installs when a redirected profile is on another volume", () => {
    // Both sides resolve, they land on different volumes, there is no
    // collision. This is why "different volume" is a permit and not a refusal.
    expect(
      resolveDataRoot(
        win({
          installDirectory: "C:\\Program Files\\Relayium",
          realpath: realpathFake({ [LOCAL]: "D:\\Profiles\\lily\\Local" }),
        }),
      ).ok,
    ).toBe(true);
  });
});

describe("failing closed rather than guessing", () => {
  const LOCAL = "C:\\Users\\lily\\AppData\\Local";

  it("climbs to the nearest existing ancestor and re-appends the rest", () => {
    // The data root does not exist yet on a first install; the profile does.
    // A component that does not exist cannot be an alias, so re-attaching it
    // is sound.
    expect(
      resolveDataRoot(
        win({
          installDirectory: "C:\\Program Files\\Relayium",
          realpath: realpathFake({}, [`${LOCAL}\\${APP_DIRECTORY}`]),
        }),
      ).ok,
    ).toBe(true);
  });

  it("treats access-denied as unverifiable, NOT as absent", () => {
    // The distinction that matters: climbing past a directory that exists but
    // cannot be opened steps straight over the alias being looked for.
    expect(
      resolveDataRoot(
        win({ installDirectory: "C:\\Staging", realpath: realpathFake({}, [], ["C:\\Staging"]) }),
      ),
    ).toEqual({ ok: false, reason: "unverifiable" });
  });

  it("does not fall back to the raw spelling when the private side is unverifiable", () => {
    expect(
      resolveDataRoot(
        win({
          installDirectory: "C:\\Program Files\\Relayium",
          // The data root does not exist yet, so resolution climbs to the
          // profile — which exists and cannot be opened.
          realpath: realpathFake({}, [`${LOCAL}\\${APP_DIRECTORY}`], [LOCAL]),
        }),
      ),
    ).toEqual({ ok: false, reason: "unverifiable" });
  });

  it("refuses a UNC destination without asking the network", () => {
    let asked = false;
    const result = resolveDataRoot(
      win({
        installDirectory: "\\\\server\\share\\Relayium",
        realpath: (target: string) => {
          asked = true;
          return target;
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "network-path" });
    // Syntactic, and BEFORE the filesystem: the directory page must not stall
    // on an SMB lookup to reach a conclusion the spelling already gives.
    expect(asked).toBe(false);
  });

  it("refuses a drive letter that turns out to be a network share", () => {
    // Not syntactically UNC, so this one can only be caught after resolving.
    expect(
      resolveDataRoot(
        win({
          installDirectory: "Z:\\Relayium",
          realpath: realpathFake({ "Z:\\Relayium": "\\\\server\\share\\Relayium" }),
        }),
      ),
    ).toEqual({ ok: false, reason: "network-path" });
  });

  it("bounds the climb instead of walking forever", () => {
    const deep = `C:\\${Array.from({ length: 80 }, (_, i) => `d${i}`).join("\\")}`;
    expect(
      resolveDataRoot(
        win({
          installDirectory: deep,
          // Nothing exists, so it climbs — and must stop.
          realpath: (target: string) => {
            const err: NodeJS.ErrnoException = new Error(`ENOENT: ${target}`);
            err.code = "ENOENT";
            throw err;
          },
        }),
      ),
    ).toEqual({ ok: false, reason: "unverifiable" });
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

// ---------------------------------------------------------------------------
// The guard was unreachable in the shipping app.
//
// `resolveDataRoot`'s containment rule was thoroughly tested above and never
// executed in production: the only caller, `handlers.ts`, invoked
// `currentDataRoot()` with no argument, so `installDirectory` was always
// `undefined` and the whole check was skipped. These cases exist so that
// cannot silently return.
// ---------------------------------------------------------------------------

describe("the install directory is supplied by default, not left undefined", () => {
  it("defaults to the running executable's own directory", () => {
    // `win32.dirname`, matching the module: a backslash-separated path must be
    // judged by Windows rules on whatever host is running this.
    expect(currentInstallDirectory()).toBe(win32.dirname(process.execPath));
  });

  /**
   * The regression that matters, driven through the real `currentDataRoot()`
   * with NO argument.
   *
   * `process.platform`, `process.execPath` and `%LOCALAPPDATA%` are all
   * temporarily replaced so the Windows branch is genuinely taken on a macOS or
   * Linux runner, and all three are restored in `finally` — `fileParallelism`
   * is off, but every later test in this file still shares this process.
   *
   * Reinstating `installDirectory?: string` makes this fail while every other
   * case in this file still passes, which is exactly how the guard came to be
   * unreachable in the first place.
   */
  it("applies the containment guard when no argument is passed", () => {
    const platform = process.platform;
    const execPath = process.execPath;
    const localAppData = process.env["LOCALAPPDATA"];
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      process.env["LOCALAPPDATA"] = "C:\\Users\\lily\\AppData\\Local";
      // The program unpacked straight into %LOCALAPPDATA%, so the private data
      // directory would sit inside the directory an uninstall deletes.
      process.execPath = "C:\\Users\\lily\\AppData\\Local\\Relayium.exe";
      expect(currentDataRoot(undefined, realpathFake())).toEqual({
        ok: false,
        reason: "inside-install-directory",
      });

      // A sane install directory still resolves, so the guard is not simply
      // refusing everything.
      process.execPath = "C:\\Users\\lily\\AppData\\Local\\Programs\\Relayium\\Relayium.exe";
      expect(currentDataRoot(undefined, realpathFake())).toEqual({
        ok: true,
        path: `C:\\Users\\lily\\AppData\\Local\\${APP_DIRECTORY}`,
      });
    } finally {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      process.execPath = execPath;
      if (localAppData === undefined) delete process.env["LOCALAPPDATA"];
      else process.env["LOCALAPPDATA"] = localAppData;
    }
  });

  it("still honours an explicitly supplied install directory", () => {
    const platform = process.platform;
    const localAppData = process.env["LOCALAPPDATA"];
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      process.env["LOCALAPPDATA"] = "C:\\Users\\lily\\AppData\\Local";
      expect(currentDataRoot("C:\\Users\\lily\\AppData\\Local", realpathFake())).toEqual({
        ok: false,
        reason: "inside-install-directory",
      });
    } finally {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      if (localAppData === undefined) delete process.env["LOCALAPPDATA"];
      else process.env["LOCALAPPDATA"] = localAppData;
    }
  });
});

// The installer guard and the runtime guard must name the same directory.
// Guarding a different one than the one holding the keys guards nothing, and
// the two live in different languages in different files.
describe("the installer guard and storage.ts agree on the directory name", () => {
  it("uses the same literal in installer.nsh", () => {
    const nsh = readFileSync(
      fileURLToPath(new URL("../../assets/installer.nsh", import.meta.url)),
      "utf8",
    );
    const declared = /!define\s+RELAYIUM_PRIVATE_DIR_NAME\s+"([^"]+)"/.exec(nsh);
    expect(declared?.[1]).toBe(APP_DIRECTORY);
    // And it is actually used to build the path it compares against.
    expect(nsh).toContain("$LOCALAPPDATA\\${RELAYIUM_PRIVATE_DIR_NAME}");
  });
});
