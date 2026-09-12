/**
 * What a link's ending means on screen, apart from the screen.
 *
 * macOS puts the same decision in its own type — `LinkWorkspaceCopy.text(for:)`
 * — and its doc says why: the mapping is exercised by `swift test`, and a
 * switch with no `default` makes a tenth ending state its own answer rather
 * than inherit somebody else's. A `{#if}` chain inside a `.svelte` file can do
 * neither. Svelte has no exhaustiveness checking at all, and nothing but a real
 * mounted renderer can execute one.
 *
 * So the decision lives here, in a module a unit test can call directly, and
 * `LinkPane` renders what it returns.
 */

import type { PeerWorkspace } from "../../../../../web/src/lib/peer-workspace.svelte";
import type { MessageKey } from "../i18n/messages.js";

/** The shared workspace's own union, taken from the value rather than restated. */
export type LinkEndReason = PeerWorkspace["linkEndReason"];

/**
 * One named ending, as a message key. Total over the union, with no default.
 *
 * `""` is a member of the type — it is what "no named ending" looks like — so
 * it is answered here rather than left to a fallback. Its answer is the plain
 * status word, which is the most this side actually knows when the workspace
 * has not named a reason.
 */
export function linkEndKey(reason: LinkEndReason): MessageKey {
  switch (reason) {
    case "relayExpired":
      return "linkEndedRelay";
    case "signalingLost":
      return "linkEndedSignaling";
    case "":
      return "linkStatusFailed";
    default: {
      // Removing this does NOT produce a compile error on its own: the function
      // would simply return `undefined` and the line would render blank, which
      // reads as the link having ended for no reason at all. The `never` is
      // what turns a new union member into a build failure, and the sentence
      // after it is what keeps a runtime surprise honest rather than empty.
      const unhandled: never = reason;
      void unhandled;
      return "linkStatusFailed";
    }
  }
}

/**
 * The link is over, whether or not the ending had a name.
 *
 * One rule in one place because three surfaces ask it: the sentence, the two
 * warnings, and which button is offered. A named reason and a plain `failed`
 * are equally terminal — the web states the same rule, having found that a
 * failed link that did not read as terminal kept showing a path badge, a
 * verification code and live warnings for a connection that no longer existed.
 */
export function linkIsTerminal(reason: LinkEndReason, status: PeerWorkspace["linkStatus"]): boolean {
  return reason !== "" || status === "failed";
}
