// Where this installation's private state lives.
//
// ## Why not Electron's default `userData`
//
// Electron resolves `userData` to `%APPDATA%\<name>`, which is the **Roaming**
// profile. On a domain-joined or Entra-joined machine Roaming is synchronised
// to a server and onto every other machine the user signs into. Three of the
// things this app stores must never do that:
//
//   * the **installation identity**, whose entire purpose is to distinguish this
//     machine from a copy of itself — roaming it makes two devices claim one
//     device row;
//   * the **account bearer**, which is this device's session, not the account's;
//   * the **Device Inbox private key**, whose public half central hands senders
//     so they can seal to *this* device. A roamed copy silently turns a
//     one-device mailbox into several.
//
// The macOS app makes the same call by writing `kSecAttrSynchronizable: false`
// explicitly so an item cannot travel through iCloud Keychain. This is that
// decision on Windows, and it is why there is **no fallback to Roaming**: if the
// local path cannot be resolved, this module fails and the caller refuses to
// persist, because storing in the wrong place is worse than not storing.

import { realpathSync } from "node:fs";
import path from "node:path";
import { engineeringOverride } from "./build-mode.js";

export type DataRootFailure =
  | "no-local-app-data"
  | "not-absolute"
  | "inside-install-directory"
  | "unsupported-platform"
  | "network-path"
  | "unverifiable";

export type DataRootResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: DataRootFailure };

/** The folder name under the per-machine profile. */
export const APP_DIRECTORY = "Relayium";

export interface DataRootEnvironment {
  readonly platform: NodeJS.Platform;
  /** `%LOCALAPPDATA%`. Absent is a hard failure, not a cue to try Roaming. */
  readonly localAppData: string | undefined;
  /** Where the app itself is installed, so state is never written into it. */
  readonly installDirectory: string | undefined;
  /** Engineering/test only: a task-owned isolated root. */
  readonly override: string | undefined;
  /**
   * Canonicalise an existing path — in the shipping app, `fs.realpathSync.native`.
   * See `canonicalize` for exactly how far that reaches.
   *
   * Required rather than optional, and supplied by every construction site. An
   * earlier revision of this module learned the hard way that a guard whose
   * argument is optional is a guard the only real caller omits.
   *
   * Throws with a Node `code`: `ENOENT` when the path does not exist, `EACCES`
   * or `EPERM` when it exists and cannot be opened. Those two are NOT the same
   * answer; see `canonicalize` below.
   */
  readonly realpath: (target: string) => string;
}

/**
 * Windows path containment.
 *
 * Two properties the POSIX form gets wrong:
 *
 *   * **Case.** NTFS is case-insensitive, so `C:\\Program Files\\Relayium` and
 *     `c:\\program files\\relayium` are one directory. A case-sensitive compare
 *     would answer "different" and let state be written into the install
 *     directory, where an uninstall deletes it.
 *   * **Trailing separators.** `C:\\App\\` and `C:\\App` are the same directory;
 *     normalising first means one spelling cannot slip past the other.
 *
 * The separator boundary is still required so `C:\\App-2` is not read as living
 * inside `C:\\App`.
 */
const containsWin32 = (parent: string, child: string): boolean => {
  const fold = (p: string): string => {
    const normalized = path.win32.normalize(p).toLocaleUpperCase("en-US");
    return normalized.length > 1 && normalized.endsWith(path.win32.sep)
      ? normalized.slice(0, -1)
      : normalized;
  };
  const a = fold(parent);
  const b = fold(child);
  return b === a || b.startsWith(a + path.win32.sep);
};

/**
 * A UNC path, judged syntactically.
 *
 * Checked before touching the filesystem, deliberately. A network destination
 * cannot be canonicalised into the same namespace as a local one — the volume
 * GUID form is documented as unavailable over SMB — so it is unsupported
 * outright, and asking the filesystem about it first would mean a blocking
 * SMB lookup to reach a conclusion already known from the spelling.
 */
const isNetworkPath = (target: string): boolean => target.startsWith("\\\\");

type Canonical =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: "network-path" | "unverifiable" };

/**
 * Resolve `target` through the filesystem, climbing to the nearest ancestor
 * that exists and re-appending the part that does not.
 *
 * ## Why lexical comparison is not enough
 *
 * `path.win32.normalize` collapses `.`, `..` and duplicate separators, and
 * nothing else. A junction or symlink aimed at the private data directory
 * survives it, and so does a `subst` drive — a namespace alias with no reparse
 * point anywhere on the path. Only asking the kernel what a handle actually
 * names collapses those.
 *
 * ## Exactly how far `realpathSync.native` reaches — checked, not assumed
 *
 * Node 24.20.0 bundles libuv 1.52.1, whose `fs__realpath_handle`
 * (`deps/uv/src/win/fs.c`) calls
 * `GetFinalPathNameByHandleW(handle, ..., VOLUME_NAME_DOS)` — flags `0` for the
 * `FILE_NAME_*` half, i.e. `FILE_NAME_NORMALIZED | VOLUME_NAME_DOS` — and then
 * strips the `\\?\` prefix, rewriting `\\?\UNC\server\share` back to
 * `\\server\share`.
 *
 * **DOS volume names, not volume GUIDs.** That still resolves junctions,
 * symlinks, mount points, 8.3 names and `subst` drives, because the handle
 * lands on the real volume and the DOS name is looked up from the device.
 *
 * **The limitation it leaves:** when one volume is reachable through more than
 * one DOS mount point — two drive letters, or a letter plus a directory mount —
 * `VOLUME_NAME_DOS` returns one of them and Windows does not document which. So
 * this function cannot be relied on to make two such paths compare equal. The
 * volume-GUID form would, and that is what the NSIS guard in
 * `assets/installer.nsh` uses; the installer is the primary defence and runs
 * before extraction, where it can actually prevent the loss. This runtime half
 * is the second, weaker guard, and this is one of the ways it is weaker. It is
 * recorded rather than closed: closing it here would mean a native call or a
 * new dependency, which is a separate reviewed decision.
 *
 * That the UNC rewrite happens at all is why the network check below is applied
 * to the RESOLVED value as well as the input.
 *
 * ## Fail closed
 *
 * There is no fallback to the raw spelling. Both sides of the comparison must
 * reach the same namespace or the comparison means nothing, so anything that
 * cannot be resolved is refused rather than guessed at. In particular `EACCES`
 * is not treated as "absent": climbing past a directory that exists but cannot
 * be opened would step straight over the alias this is looking for.
 */
const canonicalize = (target: string, realpath: (p: string) => string): Canonical => {
  if (isNetworkPath(target)) return { ok: false, reason: "network-path" };

  let current = path.win32.normalize(target);
  const tail: string[] = [];

  // Bounded: a path deeper than this is not one to keep guessing about.
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const resolved = realpath(current);
      if (isNetworkPath(resolved)) return { ok: false, reason: "network-path" };
      return { ok: true, path: path.win32.join(resolved, ...tail) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return { ok: false, reason: "unverifiable" };
      const parent = path.win32.dirname(current);
      // `dirname` is a fixed point at the root, which is how the climb ends.
      if (parent === current) return { ok: false, reason: "unverifiable" };
      tail.unshift(path.win32.basename(current));
      current = parent;
    }
  }
  return { ok: false, reason: "unverifiable" };
};

/**
 * Resolve the private data root, or say precisely why it cannot be resolved.
 *
 * Pure in its environment so the failure cases are testable without arranging a
 * broken Windows profile.
 */
export function resolveDataRoot(env: DataRootEnvironment): DataRootResult {
  // The override is an engineering/test root on whatever host is running, so it
  // is judged with that host's own path rules rather than Windows'.
  if (env.override) {
    if (!path.isAbsolute(env.override)) return { ok: false, reason: "not-absolute" };
    return { ok: true, path: path.resolve(env.override) };
  }

  if (env.platform !== "win32") {
    // Darwin and Linux reach this only in development and in CI's unit lane.
    // There is no "reasonable default" worth inventing: an engineering build
    // supplies an isolated root, and anything else is a platform this product
    // does not ship to.
    return { ok: false, reason: "unsupported-platform" };
  }

  // No Roaming fallback, deliberately. See the header.
  if (!env.localAppData || env.localAppData.length === 0) {
    return { ok: false, reason: "no-local-app-data" };
  }
  // `path.win32` explicitly, not the ambient `path`. This function is pure and
  // is unit-tested on macOS and Linux, where the host module would read
  // `C:\\Users\\me` as one relative segment and every Windows rule below would
  // be tested against something that is not a Windows path.
  if (!path.win32.isAbsolute(env.localAppData)) return { ok: false, reason: "not-absolute" };

  const dataRoot = path.win32.normalize(path.win32.join(env.localAppData, APP_DIRECTORY));

  // A per-user install puts the program under `%LOCALAPPDATA%\Programs`, a
  // sibling of this path rather than a parent — but the NSIS installer allows
  // the destination to be changed, so it can be pointed at this path or at a
  // parent of it. Checked rather than assumed.
  //
  // ## What this check does NOT do
  //
  // It refuses to WRITE state into a directory an uninstall will delete. It
  // cannot protect state that is ALREADY there: by the time this runs the
  // installer has already extracted, and a destination enclosing this path
  // would have taken the previous installation's identity with it. That is why
  // the installer refuses such a destination BEFORE extraction — see
  // `assets/installer.nsh`. This is the second of the two guards, and the
  // weaker one.
  if (env.installDirectory && path.win32.isAbsolute(env.installDirectory)) {
    // Both sides through the filesystem, and both on EVERY call — a cached
    // answer for the private side would be a staleness claim, and what a path
    // means is a property of the filesystem now, not of its spelling.
    const install = canonicalize(env.installDirectory, env.realpath);
    if (!install.ok) return { ok: false, reason: install.reason };
    const data = canonicalize(dataRoot, env.realpath);
    if (!data.ok) return { ok: false, reason: data.reason };

    if (containsWin32(install.path, data.path)) {
      return { ok: false, reason: "inside-install-directory" };
    }
  }

  return { ok: true, path: dataRoot };
}

/**
 * Where the running program lives, for the containment check below.
 *
 * `process.execPath` is the app's own executable — in a packaged build,
 * `<install dir>\Relayium.exe`. Its directory is therefore the real
 * installation directory, without the app having to be told what it is.
 *
 * `path.win32.dirname`, not the ambient one, for the same reason every other
 * comparison in this module reaches for `path.win32`: this is a Windows path,
 * and it must be judged by Windows rules on whatever host is evaluating it. On
 * Windows the two are identical; elsewhere the ambient POSIX `dirname` returns
 * `"."` for a backslash-separated path, which is not absolute and would make
 * the containment check below skip itself silently.
 */
export function currentInstallDirectory(): string {
  return path.win32.dirname(process.execPath);
}

/**
 * Read the ambient environment for the process this is running in.
 *
 * `installDirectory` DEFAULTS to the running executable's directory rather than
 * being optional-and-usually-omitted. It was the latter, and the only caller
 * passed nothing — which left the `inside-install-directory` guard below
 * permanently unused in the shipping app. A guard nobody supplies an argument
 * to is not a guard; it is a comment with a type signature.
 *
 * The parameter remains overridable so the failure cases stay testable without
 * arranging a particular `execPath`.
 */
export function currentDataRoot(
  installDirectory: string = currentInstallDirectory(),
  realpath: (target: string) => string = realpathSync.native,
): DataRootResult {
  return resolveDataRoot({
    platform: process.platform,
    localAppData: process.env["LOCALAPPDATA"],
    installDirectory,
    override: engineeringOverride("RELAYIUM_WINDOWS_DATA_ROOT"),
    // `realpathSync.native` reaches the kernel; the JS `realpathSync` does not.
    // Its exact reach, and the multi-mount case it does NOT cover, are in
    // `canonicalize` above.
    realpath,
  });
}
