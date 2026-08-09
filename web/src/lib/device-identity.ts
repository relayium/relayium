// Telling one account device from another (DECISION-LOG 2026-08-04).
//
// The problem this exists for: `relayium login` used to name every device
// literally "CLI", so an account with three servers in it showed three rows
// reading `CLI / CLI / Never used / Revoke`. The owner could not tell which
// machine a destructive revoke would disconnect. Labels fix that going
// forward; these helpers fix it for the rows that already exist, without
// inventing history or requiring a database backfill.
//
// Two rules govern this file:
//
//  1. **Never render a whole device id.** The suffix below is a fragment,
//     enough to tell two rows apart and not enough to be the id. The full id
//     stays in the request path where it belongs, and command history, bearer
//     tokens and the origin IP are not shown at all.
//  2. **Distinguish, never authenticate.** The suffix identifies a row to a
//     human. Nothing selects, authorizes or deletes by it — revoke sends the
//     exact id it was given.

/** How many characters of the id the row shows. Six of a 32-character hex id
 *  is 24 bits: two devices in one account colliding is not a real event, and
 *  even if it happened the signed-in time still separates them. */
const SUFFIX_LENGTH = 6;

/** Below this many usable characters there is nothing worth rendering — a
 *  one-character "suffix" tells the reader less than the blank does. */
const MIN_SUFFIX_LENGTH = 2;

/**
 * A short, stable fragment of a device id, for telling otherwise identical
 * rows apart.
 *
 * Case is PRESERVED. Upper-casing would read more cleanly, but it would also
 * merge ids that differ only in case into one displayed suffix — turning a
 * disambiguator into a thing that occasionally fails to disambiguate. Ids from
 * central are lowercase hex, so this costs nothing there and stays correct if
 * that ever changes.
 *
 * Non-alphanumerics are dropped rather than escaped: an id is opaque, a
 * fragment of one is decoration, and a slash or a space in the middle of it
 * would read as structure that is not there.
 *
 * Returns "" when the id carries too little to shorten, which callers render
 * as no suffix at all rather than as an empty badge.
 */
export function deviceSuffix(id: string): string {
  const usable = id.replace(/[^0-9A-Za-z]/g, "");
  if (usable.length < MIN_SUFFIX_LENGTH) return "";
  return usable.slice(-SUFFIX_LENGTH);
}

/** Longest device label central will store (internal/devicelabel.MaxRunes).
 *  Used as the rename field's `maxlength`, which is a courtesy — the server
 *  decides, and this file deliberately does not restate its Unicode rules. */
export const DEVICE_NAME_MAX = 64;

/**
 * What the rename field sends: trimmed, with internal whitespace runs
 * collapsed.
 *
 * This is the ONLY normalization done in the browser. The control-character,
 * bidi and length rules live in one place — `internal/devicelabel` — and are
 * enforced by the endpoint. Restating them here would create a second
 * definition to drift from the first, and the failure mode of that drift is a
 * name the UI accepts and the server silently stores differently. Whitespace
 * is excluded from that reasoning because both sides agree on it exactly and
 * trimming as you type is what every text field does.
 */
export function normalizeDeviceName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}
