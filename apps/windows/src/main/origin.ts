// Which server this build talks to.
//
// A desktop client that can be pointed at another origin at runtime is a
// credential-theft tool waiting for an argument: the bearer token, the device
// identity and every stored-link key are scoped to one origin, and an app that
// dials a different one on request will hand them over. So the production
// origin is a constant compiled into the build, and the only way to reach a
// local server is an engineering build, which is a different product.

import { engineeringOverride, isEngineeringBuild } from "./build-mode.js";

/** The one origin a distributed build will ever contact. */
export const PRODUCTION_ORIGIN = "https://relayium.com";

/**
 * The loopback origin an engineering build may use, matching the macOS
 * Engineering candidate's `http://127.0.0.1:18080`.
 *
 * Loopback-only by construction: the override is parsed and its hostname must
 * be a loopback literal, so `RELAYIUM_WINDOWS_ORIGIN=https://evil.example` is
 * refused even in an engineering build.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function apiOrigin(): string {
  const override = engineeringOverride("RELAYIUM_WINDOWS_ORIGIN");
  if (!override) return PRODUCTION_ORIGIN;
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    return PRODUCTION_ORIGIN;
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return PRODUCTION_ORIGIN;
  return parsed.origin;
}

/** True when this build is talking to something other than production. */
export const isEngineeringOrigin = (): boolean =>
  isEngineeringBuild() && apiOrigin() !== PRODUCTION_ORIGIN;
