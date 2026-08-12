// "Advanced verification" — the user preference that decides whether this device
// shows the SAS comparison and stops for the extra confirmations built around it.
//
// **Default OFF, and opt-IN.** That is a product decision about what the SAS
// actually buys, not a relaxation of the transfer's security:
//
//   - The SAS detects substitution of the SIGNALLING endpoints, and only if a
//     human actually compares both codes out of band. Nobody who is not looking
//     for it does that, so a mandatory-looking step that everyone clicks through
//     provides no protection while teaching users that consent prompts are noise.
//   - Everything the SAS is NOT is unaffected by this flag. Commit-reveal still
//     runs on every link and still fails the handshake if the reveal does not
//     match the commitment; AEAD still authenticates every frame; keys are still
//     generated on the device and never leave it; the relay still only ever sees
//     ciphertext. Those are cryptographic hard failures — they are not gated on a
//     checkbox and cannot be turned off from the UI at all.
//   - Receiving a FILE still asks. That prompt is content/save consent (and the
//     transient user gesture the desktop file/directory pickers require), not
//     pairing verification, so it is outside this preference in every mode.
//
// So "off" means: no SAS on screen, and no confirmation steps whose only stated
// reason was comparing it. "On" restores the previous behaviour in full.
//
// Stored per-device in localStorage, like the transfer-history preference, and
// for the same reasons: it is a property of this browser rather than of the
// account, and there is no account at all on the joining side of a code room.
//
// Changing it is not only a display decision, which is why this module reaches
// for the handoff authorization below: a confirmation the user gave while the
// SAS was on screen is a decision made under this preference, and it does not
// outlive it. See `apply`.

import { revokeHandoff } from "./handoff-authorization.svelte";

/** Present only once the user has turned the preference ON. An absent key is
 *  the default, so a device that never opens the setting keeps behaving the
 *  same way even if the default is ever revisited. Mirrors history.ts's
 *  opt-OUT key, inverted because this default is the other way round. */
const ON_KEY = "relayium.verify.on";

function load(): boolean {
  try {
    return localStorage.getItem(ON_KEY) === "1";
  } catch {
    // Private mode / blocked storage must not silently turn a security-relevant
    // step ON either: an unreadable store means "we know nothing", and the
    // default is what we do when we know nothing.
    return false;
  }
}

let on = $state(load());

/** Reactive read: does this device show and gate on the SAS comparison? */
export function verifyPeers(): boolean {
  return on;
}

/**
 * Move the preference, and drop anything the user decided under the old one.
 *
 * The only decision that qualifies today is the pre-upload handoff
 * authorization, and it is exactly the kind that must not survive: it is a
 * record of "the user compared this link's SAS with this peer", and the SAS is
 * on screen only while this preference is ON. `handoffAllowed` already refuses a
 * grant whose recorded preference differs from the current one, which catches a
 * single change — and misses the ROUND TRIP. On → off → on puts `verifyOn: true`
 * back on both sides of that comparison, so a confirmation given before the user
 * changed their mind twice would come back into force without anyone being asked
 * again.
 *
 * Here rather than in App's change handler, because a handler is one call site
 * that has to remember and this is the only way the preference moves at all. The
 * revocation happens BEFORE the value changes and in the same synchronous call,
 * so no reactive reader — and no emission riding one — can ever observe the new
 * preference while the old grant still answers yes.
 *
 * A write that does not change the value is not the user changing their mind, so
 * it revokes nothing: dropping a live grant on a repeated write would put the
 * confirmation bar back in the middle of a handoff the user already authorized.
 */
function apply(next: boolean): void {
  if (next !== on) revokeHandoff();
  on = next;
}

export function setVerifyPeers(next: boolean): void {
  apply(next);
  try {
    if (next) localStorage.setItem(ON_KEY, "1");
    else localStorage.removeItem(ON_KEY);
  } catch {
    /* best-effort: quota / private mode. The in-memory value still applies to
       this session, which is what the user just asked for. */
  }
}

/** Test seam: drop the in-memory value back to whatever storage says. Not used
 *  by the app — a page load runs `load()` once, at module init. Through the same
 *  door as the setter, so a seam cannot be the one way the preference moves
 *  without taking the decisions made under it with it. */
export function reloadVerifyPeers(): void {
  apply(load());
}
