// The one place that decides whether an ambient override may be honoured.
//
// ## Why this is a single module and not an `if` at each call site
//
// Every override in this app — the API origin, the data root, the secret-store
// stub — is a hole in exactly the property the app is meant to have. Spread
// across call sites, "only in development" becomes a convention, and a
// convention is what ships an environment variable to users. Here it is one
// predicate, asserted by one test, and a packaged build answers `false` to all
// of it regardless of what the environment says.
//
// The macOS app draws the same line with its Engineering xcconfig: a separate
// bundle id, its own Keychain service, its own origin, no Sparkle, and a
// permanent on-screen banner. This is that idea with the parts Electron gives
// us — and, like it, the engineering build is a DIFFERENT product, not a
// production build with a flag flipped.

import { app } from "electron";

/**
 * `app.isPackaged` is false only when running from an unpackaged checkout —
 * `electron .`, the smoke test, a vitest process with no Electron at all. It is
 * the property electron-builder cannot leave unset, which is why it is the
 * anchor rather than `NODE_ENV`.
 */
function packaged(): boolean {
  // The unit tests import this module without an Electron runtime, where `app`
  // is undefined. Treat "no Electron" as unpackaged: the alternative would make
  // the tests exercise a code path the product never takes.
  try {
    return app?.isPackaged ?? false;
  } catch {
    return false;
  }
}

/**
 * True only for a deliberately-started engineering build.
 *
 * BOTH halves are required. Being unpackaged is not enough — a developer
 * running the real app locally should still get the real origin and the real
 * secret store, because that is what they are trying to test.
 */
export function isEngineeringBuild(): boolean {
  if (packaged()) return false;
  return process.env["RELAYIUM_WINDOWS_ENGINEERING"] === "1";
}

/**
 * Read an override, or `undefined` in every build that may not have one.
 *
 * Deliberately the only exported reader of `process.env` in the main process.
 */
export function engineeringOverride(name: string): string | undefined {
  if (!isEngineeringBuild()) return undefined;
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** Shown as a permanent, non-dismissible banner, exactly as macOS does. */
export const ENGINEERING_BANNER = "ENGINEERING BUILD · NOT FOR DISTRIBUTION";
