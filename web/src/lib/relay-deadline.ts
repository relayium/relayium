// The bounded lifetime of a RELAYED unified link, derived from the credential
// the server actually issued.
//
// A `link/1` link is long-lived by design: one authenticated connection carries
// both lanes for as long as the two people are working. On LAN that costs
// nothing. Through a TURN relay it does not: the ephemeral credential
// `/api/ice` issues is a TURN REST username of the form `<unix-expiry>:<token>`
// (server/account/turn.go), and when it lapses the allocation behind the link
// goes with it. Nothing tells the page that happened — a relayed link simply
// stops moving bytes, and, worse, the recovery driver would then spend its whole
// window re-offering a transport with credentials that can no longer allocate.
//
// So the deadline is derived up front, from the config the page was handed, and
// the link is closed with a truthful "start again" before the credential dies
// rather than after. It is a CLIENT-side bound on the client's own behaviour: it
// changes nothing on the wire and grants nothing. Being wrong in the safe
// direction (ending slightly early) is the entire design goal.

// Type-only: nothing here fetches anything, and the pool entry shape is already
// defined beside the fetch that produces it.
import type { RelayEntry } from "./ice";

/**
 * How much local-clock error the margin absorbs.
 *
 * `expiry` is stamped by the server's clock; every timer here runs on the
 * browser's. If the browser is AHEAD, the remaining lifetime is underestimated
 * and the link ends early — safe. If it is BEHIND, the lifetime is
 * overestimated, which is the direction that would present dead credentials as
 * live, so the margin is subtracted to cover it. A minute covers ordinary NTP
 * drift and phone clock slop; nothing client-side can cover a clock that is
 * hours out, and pretending otherwise would just move the lie.
 */
export const TURN_CLOCK_SKEW_MS = 60_000;

/** How long before the boundary the live link must say so. Long enough to
 *  finish a sentence and re-pair deliberately, short enough that it is not a
 *  permanent banner on an hour-long credential. */
export const RELAY_DEADLINE_WARN_MS = 5 * 60_000;

export interface RelayDeadline {
  /** The earliest server-stated expiry, as local-clock ms. Reported so a caller
   *  (and a test) can see what the margin was applied to. */
  expiresAt: number;
  /** Local-clock ms at which the relayed link must be terminal. */
  deadlineAt: number;
  /** Local-clock ms at which the live link must warn. Never after the deadline. */
  warnAt: number;
}

/** The part of an ICE config this reads: the legacy top-level list plus every
 *  pool entry, because ICE decides which of them carries the link. */
export interface RelayDeadlineConfig {
  iceServers?: readonly RTCIceServer[];
  relays?: readonly RelayEntry[];
}

function urlsOf(server: RTCIceServer): string[] {
  const urls = (server as { urls?: unknown }).urls;
  const list = Array.isArray(urls) ? urls : [urls];
  return list.filter((u): u is string => typeof u === "string");
}

function isRelayEntry(server: RTCIceServer): boolean {
  return urlsOf(server).some((u) => u.startsWith("turn:") || u.startsWith("turns:"));
}

/**
 * The unix-second expiry a TURN REST username states, or null.
 *
 * Strict on purpose. `Number("")`, `Number(" 12 ")` and `Number("0x10")` are all
 * finite, so a lenient parse would read an expiry out of a credential that never
 * carried one — and an expiry read out of noise is a deadline imposed on a link
 * for no reason. Only `^\d+$` before the first colon counts, and only a positive
 * value inside the range JS integers are exact in.
 */
function restExpirySeconds(username: unknown): number | null {
  if (typeof username !== "string") return null;
  const colon = username.indexOf(":");
  if (colon <= 0) return null;
  const head = username.slice(0, colon);
  if (!/^\d+$/.test(head)) return null;
  const seconds = Number(head);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  return seconds;
}

/**
 * The earliest expiry stated by any TURN credential in a list, in unix seconds.
 *
 * EARLIEST, not first or longest: the pool hands out one credential per relay
 * and ICE decides which one carries the link, so the only honest bound is the
 * one that dies first. A credential on an entry with no `turn:`/`turns:` URL is
 * ignored — a STUN entry has no allocation to lose, and reading one would let a
 * hostile `/api/ice` body impose a deadline on a link that never relays.
 *
 * Malformed entries are skipped rather than failing the whole list: dropping a
 * valid sibling because of a broken neighbour would remove the bound entirely,
 * which is the one outcome worth avoiding. Returns null when nothing states an
 * expiry, which is the LAN answer and the answer for a STUN-only code room.
 */
export function earliestTurnExpiry(servers: readonly RTCIceServer[] | undefined): number | null {
  if (!Array.isArray(servers)) return null;
  let earliest: number | null = null;
  for (const server of servers) {
    if (!server || typeof server !== "object") continue;
    if (!isRelayEntry(server)) continue;
    const seconds = restExpirySeconds((server as { username?: unknown }).username);
    if (seconds === null) continue;
    if (earliest === null || seconds < earliest) earliest = seconds;
  }
  return earliest;
}

/**
 * The deadline pair for one ICE config, or null when nothing relays.
 *
 * Derived ONCE, against the clock that was current when the config was fetched,
 * and then held as absolute local-clock instants. Re-deriving it later against a
 * clock that has since been stepped would silently move the boundary under a
 * live link, which is exactly the failure this exists to prevent.
 *
 * Both instants are clamped to `now`: a caller arms timers off them, and a
 * negative delay fires immediately in a way that is indistinguishable from
 * "there was no deadline". An already-expired credential is a real state — a
 * badly-set clock, or a config held far too long — and the truthful response is
 * an immediate terminal one, not an unbounded link.
 */
export function relayDeadline(cfg: RelayDeadlineConfig, now: number): RelayDeadline | null {
  const candidates: (number | null)[] = [earliestTurnExpiry(cfg.iceServers)];
  for (const relay of cfg.relays ?? []) candidates.push(earliestTurnExpiry(relay?.iceServers));
  let earliest: number | null = null;
  for (const seconds of candidates) {
    if (seconds === null) continue;
    if (earliest === null || seconds < earliest) earliest = seconds;
  }
  if (earliest === null) return null;
  const expiresAt = earliest * 1000;
  const deadlineAt = Math.max(now, expiresAt - TURN_CLOCK_SKEW_MS);
  return { expiresAt, deadlineAt, warnAt: Math.max(now, deadlineAt - RELAY_DEADLINE_WARN_MS) };
}
