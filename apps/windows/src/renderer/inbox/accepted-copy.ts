/**
 * What accepting a delivery actually did, in words.
 *
 * A module rather than an if-chain in `InboxPage`, and this file already made
 * the argument twice: `RESIDUE_KEY` is a total map with `satisfies`, and
 * `noticeText` is a `switch` with a `never` guard. `acceptedText` was the third
 * shape, and the one that had not been swept.
 *
 * ## What the fallback was saying
 *
 * Both chains ended at `inboxFailed` — "That did not work. Relayium will try
 * again on its own." Six of `InboxAcceptOutcome`'s eight members were named,
 * and three of `DeliveryReceipt`'s four. The two that were not:
 *
 * * `not-enabled` — receiving is switched OFF on this device. The sentence is
 *   wrong twice over, and the second half is the worse half: Relayium will not
 *   try again on its own, because there is nothing running to try. A vague
 *   catch-all wastes a reader's attention; one that PROMISES a retry makes them
 *   wait for something that is never coming.
 * * a `refused` receipt — the delivery was reached and came back with an
 *   `InboxFailure` carrying a code this app already has a sentence for.
 *   `BLOCKED_KEY` is total over `InboxFailureCode` and was right there.
 */

import type { DeliveryReceipt, InboxAcceptOutcome } from "../../shared/ipc-contract.js";
import type { MessageKey } from "../i18n/messages.js";
import { BLOCKED_KEY } from "./blocked-copy.js";

/** A key, plus the values it needs. The caller owns the language. */
export type AcceptedCopy =
  | { readonly key: MessageKey }
  | { readonly key: MessageKey; readonly values: Record<string, string | number> };

function receiptCopy(receipt: DeliveryReceipt): AcceptedCopy {
  switch (receipt.kind) {
    case "saved":
      // `ackPending` is reported as saved, because it is: the files are on
      // disk and only the acknowledgement is missing. Calling that a failure
      // would be false in the direction that matters most.
      return { key: receipt.ackPending ? "inboxAckPending" : "inboxAcceptedSaved" };
    case "saved-message":
      return { key: receipt.ackPending ? "inboxAckPending" : "inboxAcceptedSavedMessage" };
    case "partial":
      return {
        key: "inboxAcceptedPartial",
        values: { saved: receipt.savedCount, total: receipt.total },
      };
    case "refused":
      // The receipt CARRIES the reason, and this app already has a sentence
      // for every code it can hold. Answering from the code says which problem
      // it was; the fallback said only that something did not work, and then
      // promised a retry the refusal may rule out.
      return { key: BLOCKED_KEY[receipt.failure.code] };
    default: {
      const unhandled: never = receipt;
      void unhandled;
      return { key: "inboxFailed" };
    }
  }
}

export function acceptedCopy(outcome: InboxAcceptOutcome): AcceptedCopy {
  switch (outcome.kind) {
    case "received":
      return receiptCopy(outcome.receipt);
    case "queued":
      // Accepted on the server and not reached in this pass. Not a failure.
      return { key: "inboxAcceptedQueued" };
    case "blocked":
      return { key: "inboxAcceptedBlocked" };
    case "already-settled":
      return { key: "inboxAcceptedSettled" };
    case "busy":
      return { key: "inboxAcceptedBusy" };
    case "refused":
      return { key: "inboxAcceptedRefused" };
    case "not-enabled":
      // Its own sentence, and deliberately one that does NOT promise a retry.
      return { key: "inboxAcceptedNotEnabled" };
    case "failed":
      // The one case the old fallback was right about — and now it says so by
      // name, so the next member added does not inherit its sentence.
      return { key: "inboxFailed" };
    default: {
      const unhandled: never = outcome;
      void unhandled;
      return { key: "inboxFailed" };
    }
  }
}
