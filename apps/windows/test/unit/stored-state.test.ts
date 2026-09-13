// Where a stored upload got to, and the label the history list gives it.
//
// The chain this map replaces ended `return state;`, so `pending` — the one
// member it did not name — rendered as the English identifier `pending`, as the
// row's whole label, in any language.
import { describe, expect, it } from "vitest";

import { uploadStateKey } from "../../src/renderer/send/stored-state.js";
import { UPLOAD_STATES, type UploadState } from "../../src/shared/ipc-contract.js";
import { en, zh } from "../../src/renderer/i18n/messages.js";

/**
 * The union's own list, not a copy of it.
 *
 * Restating the members here would make these cases pass for a fifth state
 * nobody had written a label for — the same shape of mistake the map itself
 * had. Reading `UPLOAD_STATES` means a new member is checked by existing.
 */
const STATES: readonly UploadState[] = UPLOAD_STATES;

describe("the history row's label", () => {
  it("names every state, in both maintained languages", () => {
    for (const state of STATES) {
      const key = uploadStateKey(state);
      expect(en[key], state).toBeTruthy();
      expect(zh[key], state).toBeTruthy();
      expect(zh[key], state).not.toBe(en[key]);
    }
  });

  it("never renders the wire identifier itself", () => {
    // The defect, stated as an assertion: no label may BE the state's own
    // token. A person reading their own history should not have to know this
    // app's vocabulary.
    for (const state of STATES) {
      const key = uploadStateKey(state);
      expect(en[key].toLowerCase(), state).not.toBe(state);
      expect(zh[key], state).not.toBe(state);
    }
  });

  it("keeps every state visibly apart", () => {
    // Four states, four labels. `pending` sharing `ambiguous`'s word would be
    // the same defect in a politer form: the row offers a re-check for one and
    // nothing for the other, so a shared label makes the buttons look arbitrary.
    const labels = STATES.map((state) => en[uploadStateKey(state)]);
    expect(new Set(labels).size).toBe(STATES.length);
    expect(new Set(STATES.map((state) => zh[uploadStateKey(state)])).size).toBe(STATES.length);
  });

  it("does not call an unfinished upload unconfirmed", () => {
    // They mean different things and offer different actions. `ambiguous` may
    // exist on the server under an id this client never learned, and the row
    // offers Check again; `pending` was never finalized, so there is nothing to
    // check and nothing to share.
    expect(uploadStateKey("pending")).not.toBe(uploadStateKey("ambiguous"));
  });
});
