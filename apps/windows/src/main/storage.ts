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

import path from "node:path";
import { engineeringOverride } from "./build-mode.js";

export type DataRootFailure =
  | "no-local-app-data"
  | "not-absolute"
  | "inside-install-directory"
  | "unsupported-platform";

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
  // sibling of this path rather than a parent — but an installer variant that
  // changed that would make every uninstall delete the user's keys and history.
  // Checked rather than assumed.
  if (env.installDirectory && path.win32.isAbsolute(env.installDirectory)) {
    if (containsWin32(env.installDirectory, dataRoot)) {
      return { ok: false, reason: "inside-install-directory" };
    }
  }

  return { ok: true, path: dataRoot };
}

/** Read the ambient environment for the process this is running in. */
export function currentDataRoot(installDirectory?: string): DataRootResult {
  return resolveDataRoot({
    platform: process.platform,
    localAppData: process.env["LOCALAPPDATA"],
    installDirectory,
    override: engineeringOverride("RELAYIUM_WINDOWS_DATA_ROOT"),
  });
}
