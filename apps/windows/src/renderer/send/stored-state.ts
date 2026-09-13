/**
 * Where a stored upload got to, as a message key.
 *
 * Extracted from `StoredPage` for the reason the other two maps were: a
 * `{#if}` chain over a union cannot be checked for exhaustiveness by the
 * compiler and cannot be executed without mounting a renderer.
 *
 * This one had fallen off the end. `UploadState` has four members; the chain
 * mapped three and finished `return state;`, so a row for an upload that never
 * settled rendered the English identifier `pending` — as the row's entire
 * label, in any language. The same defect as the retained-cleanup card
 * rendering `EBUSY`, and as a failed sign-in rendering `String(err)`.
 */

import type { UploadState } from "../../shared/ipc-contract.js";
import type { MessageKey } from "../i18n/messages.js";

export function uploadStateKey(state: UploadState): MessageKey {
  switch (state) {
    case "published":
      return "sendHistoryPublished";
    case "ambiguous":
      return "sendHistoryAmbiguous";
    case "closed":
      return "sendHistoryClosed";
    case "pending":
      // Distinct from `ambiguous` and it matters which one a person is looking
      // at: `ambiguous` means the object MAY exist under an id this client
      // never learned, and offers a re-check. `pending` means nothing was ever
      // finalized, so there is nothing to re-check and nothing to share.
      return "sendHistoryPending";
    default: {
      const unhandled: never = state;
      void unhandled;
      // Never the raw value. Putting a wire identifier on screen is what this
      // function replaces, and a fifth state would inherit that same bug from
      // a fallback that echoed its input.
      return "sendHistoryAmbiguous";
    }
  }
}
