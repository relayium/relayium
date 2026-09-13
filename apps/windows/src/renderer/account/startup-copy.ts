/**
 * What "open Relayium when you sign in" is actually doing, in words.
 *
 * A module rather than a ternary chain in `AccountPage`, for the reason the
 * `FAILURE_KEY` map twenty lines above it already gives: a member added without
 * copy should be a compile error, not a sentence somebody else's branch
 * happens to catch.
 *
 * The chain this replaces covered six of seven possibilities. The seventh —
 * `consent-failed` — fell into "That could not be changed on this PC", which
 * names the wrong culprit: `enable()` returns it when the CONSENT PROMPT throws,
 * so nothing was attempted and Windows refused nothing. A person told their PC
 * would not take the change goes looking for a machine problem that is not
 * there.
 */

import type { LoginItemFailure, LoginItemState } from "../../main/login-item.js";
import type { MessageKey } from "../i18n/messages.js";

/** Why the question could not be answered or the change not made. */
export function startupFailureKey(failure: LoginItemFailure): MessageKey {
  switch (failure.kind) {
    case "unreadable":
      // NOT "off". "Off" is a claim about the machine; this is a claim about
      // the call, and `login-item.ts` keeps them apart deliberately.
      return "settingsStartupUnreadable";
    case "write-failed":
      return "settingsStartupWriteFailed";
    case "consent-failed":
      return "settingsStartupConsentFailed";
    default: {
      const unhandled: never = failure;
      void unhandled;
      // The least this screen can honestly say about a failure it cannot name:
      // that it could not find out. Never the write-failure sentence, which
      // would blame the machine for something nobody established.
      return "settingsStartupUnreadable";
    }
  }
}

/** What the system currently reports. */
export function startupStateKey(state: LoginItemState): MessageKey {
  switch (state) {
    case "on":
      return "settingsStartupOn";
    case "disabled-by-user":
      // Registered, and switched off under Task Manager → Startup apps. No
      // checkbox on this screen can undo that, which is why it is its own
      // sentence rather than "off".
      return "settingsStartupDisabled";
    case "on-by-other-means":
      // Something else on this PC launches Relayium. Turning this on would add
      // a second entry for one outcome.
      return "settingsStartupOther";
    case "off":
      return "settingsStartupOff";
    default: {
      const unhandled: never = state;
      void unhandled;
      return "settingsStartupOff";
    }
  }
}
