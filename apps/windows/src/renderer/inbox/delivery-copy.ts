/**
 * What the OTHER device is doing with a delivery, in words.
 *
 * ## What this replaces
 *
 * ```js
 * return view.state === "acked" || view.state === "saved"
 *   ? t("inboxSendDelivered")          // "Delivered"
 *   : t("inboxSendDeliveredWaiting");  // "Delivered — waiting for that device to collect it"
 * ```
 *
 * Two branches over a ten-member union, and one of the two values it tested for
 * is not in that union at all: `acked` belongs to the RECEIVER's local journal
 * (`main/inbox/journal.ts`, `TaskPhase`), a different vocabulary that never
 * crosses to the sender. So the condition was effectively `state === "saved"`,
 * and everything else said "waiting for that device to collect it".
 *
 * Including `expired`, `revoked` and `failed_terminal` — three states in which
 * the server has recorded that the delivery will NEVER be collected. Telling
 * somebody their files are on their way when nothing was written is not a vague
 * sentence, it is a false one, and it is the kind a person acts on: they stop
 * chasing it, or they delete their local copy.
 *
 * The map is total with a `never` guard, and lives here rather than in the page
 * because Svelte has no exhaustiveness checking and nothing but a mounted
 * renderer executes a branch.
 */

import type { TaskState } from "../../shared/ipc-contract.js";
import type { MessageKey } from "../i18n/messages.js";

export function deliveryStateKey(state: TaskState): MessageKey {
  switch (state) {
    case "saved":
      // The ONLY state that may claim the files are on the other device. The
      // server reaches it only from `verifying`, and only when the device
      // asserts `committed: true` — its own comment: "the bytes arrived" is not
      // "the file is on disk".
      return "inboxSendDelivered";
    case "queued":
      return "inboxSendStateQueued";
    case "notified":
      return "inboxSendStateNotified";
    case "downloading":
      return "inboxSendStateDownloading";
    case "verifying":
      return "inboxSendStateVerifying";
    case "attention_required":
      return "inboxSendStateAttention";
    case "expired":
      return "inboxSendStateExpired";
    case "revoked":
      return "inboxSendStateRevoked";
    case "failed_retryable":
      // Kept apart from terminal because the next actions are opposite: one is
      // wait, the other is send it again or stop expecting it.
      return "inboxSendStateFailedRetryable";
    case "failed_terminal":
      return "inboxSendStateFailedTerminal";
    default: {
      const unhandled: never = state;
      void unhandled;
      // NOT the optimistic sentence. An eleventh state this build has never
      // seen is a state it cannot vouch for, and the failure mode being fixed
      // here is exactly an unknown one inheriting a claim of success.
      return "inboxSendUnknown";
    }
  }
}

/**
 * Whether this state means nothing further will happen.
 *
 * Asked separately from the sentence because a surface may want to stop showing
 * a spinner, or stop offering Cancel, and reading that off a sentence is how a
 * screen ends up parsing its own copy. `attention_required` is deliberately NOT
 * terminal: the other device can still resolve it and save.
 */
export function deliveryIsOver(state: TaskState): boolean {
  return state === "saved" || state === "expired" || state === "revoked" || state === "failed_terminal";
}
