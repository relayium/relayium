// What the sender is told the other device is doing.
//
// The map this covers used to be two branches over a ten-member union, and one
// of the two values it tested for — `acked` — belongs to the RECEIVER's local
// journal and can never appear here. So everything except `saved` read as
// "Delivered — waiting for that device to collect it", including three states
// in which the server has recorded that it will never be collected.
import { describe, expect, it } from "vitest";

import { deliveryStateKey, deliveryIsOver } from "../../src/renderer/inbox/delivery-copy.js";
import { TASK_STATES, type TaskState } from "../../src/shared/ipc-contract.js";
import { en, zh } from "../../src/renderer/i18n/messages.js";

/** The union's own list. Restating it would let a new state pass unchecked. */
const STATES: readonly TaskState[] = TASK_STATES;

/** The server has recorded that these will never be collected. */
const NEVER_COMING = ["expired", "revoked", "failed_terminal"] as const;

describe("what the other device is doing", () => {
  it("answers every server state, in both maintained languages", () => {
    for (const state of STATES) {
      const key = deliveryStateKey(state);
      expect(en[key], state).toBeTruthy();
      expect(zh[key], state).toBeTruthy();
      expect(zh[key], state).not.toBe(en[key]);
    }
  });

  it("never tells the sender a dead delivery is on its way", () => {
    // THE defect. Each of these used to render "Delivered — waiting for that
    // device to collect it".
    const waiting = en[deliveryStateKey("queued")];
    for (const state of NEVER_COMING) {
      const sentence = en[deliveryStateKey(state)];
      expect(sentence, state).not.toBe(waiting);
      expect(sentence.toLowerCase(), state).not.toContain("waiting");
      // And it must not read as saved either.
      expect(sentence, state).not.toBe(en[deliveryStateKey("saved")]);
    }
  });

  it("lets only `saved` claim the files are on the other device", () => {
    const saved = deliveryStateKey("saved");
    for (const state of STATES.filter((s) => s !== "saved")) {
      expect(deliveryStateKey(state), state).not.toBe(saved);
    }
  });

  it("keeps retryable and terminal failure apart", () => {
    // Opposite next actions: wait, versus stop expecting it.
    expect(deliveryStateKey("failed_retryable")).not.toBe(deliveryStateKey("failed_terminal"));
    expect(en[deliveryStateKey("failed_retryable")]).not.toBe(en[deliveryStateKey("failed_terminal")]);
    expect(zh[deliveryStateKey("failed_retryable")]).not.toBe(zh[deliveryStateKey("failed_terminal")]);
  });

  it("does not claim success for a state this build has never seen", () => {
    // The `never` guard makes an eleventh state a BUILD error, which is the
    // real protection — and it also means no test can reach the default branch
    // through the type. Reaching it deliberately is worth doing anyway: the
    // failure being fixed here is precisely an unrecognised state inheriting a
    // claim about somebody's files, and a fallback that returned the
    // optimistic sentence would restore it in a new form.
    //
    // Proved by injection: making that branch return `inboxSendDelivered` left
    // every other case green. This is the case that catches it.
    const key = deliveryStateKey("a_state_from_a_later_server" as TaskState);
    expect(key).not.toBe(deliveryStateKey("saved"));
    expect(en[key]).not.toBe(en[deliveryStateKey("saved")]);
    expect(en[key]).toBeTruthy();
    expect(zh[key]).toBeTruthy();
  });

  it("gives all ten states their own sentence", () => {
    // Ten states, ten sentences, in both languages. Any collapse here is the
    // old defect in a smaller form.
    expect(new Set(STATES.map((s) => en[deliveryStateKey(s)])).size).toBe(STATES.length);
    expect(new Set(STATES.map((s) => zh[deliveryStateKey(s)])).size).toBe(STATES.length);
  });

  it("answers no real state with the fallback", () => {
    // Without this, adding an eleventh state to `TASK_STATES` fails the BUILD
    // on the `never` guard — the real gate — but leaves these cases green,
    // because the fallback returns a key and that key has copy. This makes the
    // tests carry the claim too: every state in the list has a sentence chosen
    // for it, not inherited from the branch for states nobody has written one
    // for. Verified by adding `quarantined` to the shared list.
    const fallback = deliveryStateKey("a_state_from_a_later_server" as TaskState);
    for (const state of STATES) {
      expect(deliveryStateKey(state), state).not.toBe(fallback);
    }
  });
});

describe("whether the delivery is over", () => {
  it("is true for saved and for the three that will never arrive", () => {
    expect(deliveryIsOver("saved")).toBe(true);
    for (const state of NEVER_COMING) expect(deliveryIsOver(state), state).toBe(true);
  });

  it("is false while the other device can still act", () => {
    // `attention_required` deliberately included: the other device can resolve
    // it and go on to save. Calling it over would stop a surface from showing
    // the outcome that follows.
    for (const state of ["queued", "notified", "downloading", "verifying", "attention_required", "failed_retryable"] as const) {
      expect(deliveryIsOver(state), state).toBe(false);
    }
  });

  it("agrees with the server's own terminal set, plus retryable", () => {
    // The server calls saved/expired/revoked/failed_terminal terminal.
    // `failed_retryable` is the one that is NOT, and this asserts the two
    // notions have not silently merged.
    expect(deliveryIsOver("failed_retryable")).toBe(false);
    expect(deliveryIsOver("failed_terminal")).toBe(true);
  });
});
