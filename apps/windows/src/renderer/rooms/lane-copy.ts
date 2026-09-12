/**
 * Two closed unions, and the sentence each member gets.
 *
 * Both used to be consumed by a chain inside `LinkPane`, and both chains were
 * incomplete in the way a chain always can be: Svelte has no exhaustiveness
 * checking, a ternary that falls off the end returns `""`, and an `if` chain
 * that falls off the end reaches a catch-all that makes a claim nobody checked
 * against the union.
 *
 * What that cost, concretely:
 *
 * * The text lane rendered NOTHING for `flooding` and `failed`. A message that
 *   could not be sent, and a session closed because the peer sent too many,
 *   said nothing at all.
 * * The receive receipt sent `cancelled`, `cleanup-uncertain` and `io-failed`
 *   to "Could not write to the folder you chose." For `cleanup-uncertain` that
 *   is not merely vague: the write may have SUCCEEDED and only the teardown
 *   could not confirm it, so the sentence was false about the user's own disk.
 * * It tested for `permission` and `conflict`, which `PublishFailureReason`
 *   does not contain and main cannot emit. Dead branches, and dead copy the
 *   dead-copy pin could not see because the keys were referenced.
 *
 * So both maps live here, where a `never` guard turns a new member into a
 * build failure and a test can call them without mounting anything. The same
 * reasoning as `link-ending.ts`, and the same shape macOS uses.
 */

import type { TextErrorKey } from "../../../../../web/src/lib/text-model";
import type { PublishFailureReason } from "../../shared/ipc-contract.js";
import type { MessageKey } from "../i18n/messages.js";

/**
 * Why a save failed, in words. Total, with no catch-all.
 *
 * Every member is answered here rather than by a fallback, because the fallback
 * WAS the defect: a sentence about not being able to write, attached to three
 * reasons that mean something else.
 */
export function publishFailureKey(reason: PublishFailureReason): MessageKey {
  switch (reason) {
    case "unsupported":
      // A build limitation, not a failure of this save, and said as one.
      return "recvUnsupported";
    case "timeout":
      return "recvFailedTimeout";
    case "cancelled":
      return "recvFailedCancelled";
    case "cleanup-uncertain":
      return "recvFailedUncertain";
    case "io-failed":
      // The one reason "could not write to the folder you chose" is true of.
      return "recvFailedPrefix";
    case "exists":
      return "recvFailedConflict";
    case "permission":
      return "recvFailedPermission";
    case "no-space":
      return "recvFailedNoSpace";
    case "in-use":
      return "recvFailedInUse";
    case "gone":
      return "recvFailedGone";
    case "name-too-long":
      return "recvFailedNameTooLong";
    case "helper-unavailable":
    case "internal":
      // Both are this app's own problem rather than anything about the folder,
      // and there is nothing the user can do differently about either.
      return "recvFailedInternal";
    default: {
      const unhandled: never = reason;
      void unhandled;
      return "recvFailedInternal";
    }
  }
}

/**
 * The text lane's own error, in words. `""` means the lane has none.
 *
 * Returning a key rather than a sentence keeps the language out of here, and
 * returning `""` for the empty member keeps the caller's `{#if}` honest: there
 * is a real state in which the lane has nothing wrong with it.
 */
export function textErrorMessageKey(key: TextErrorKey): MessageKey | "" {
  switch (key) {
    case "":
      return "";
    case "tooLong":
      return "textTooLong";
    case "flooding":
      return "textFlooding";
    case "unsupported":
      return "textUnsupported";
    case "peerBusy":
      return "textPeerBusy";
    case "failed":
      return "textFailed";
    case "refused":
      return "textRefused";
    default: {
      // Not `""`. Silence is what this function exists to stop: a seventh
      // member appearing here means the lane failed for a reason nobody has
      // written a sentence for, and saying the least honest thing beats saying
      // nothing. The `never` above it is what makes that unreachable.
      const unhandled: never = key;
      void unhandled;
      return "textFailed";
    }
  }
}
