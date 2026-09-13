// Two closed unions, and the sentence each member gets.
//
// These call the maps directly because that is the whole reason the maps left
// `LinkPane`: a `{#if}` chain cannot be checked for exhaustiveness by the
// compiler and cannot be executed without mounting a renderer, and both chains
// were in fact incomplete.
import { describe, expect, it } from "vitest";

import { publishFailureKey, textErrorMessageKey } from "../../src/renderer/rooms/lane-copy.js";
import type { PublishFailureReason } from "../../src/shared/ipc-contract.js";
import type { TextErrorKey } from "../../../../web/src/lib/text-model";
import { en, zh } from "../../src/renderer/i18n/messages.js";

/**
 * Every member, listed HERE.
 *
 * The `never` guard makes a new member a BUILD failure; this list is what makes
 * it a test failure too, and it is the list that carries the claim "all of
 * these were checked".
 */
const REASONS: readonly PublishFailureReason[] = [
  "unsupported", "helper-unavailable", "timeout", "cancelled", "cleanup-uncertain",
  "io-failed", "internal", "exists", "permission", "no-space", "in-use", "gone",
  "name-too-long",
];

const TEXT_KEYS: readonly TextErrorKey[] = [
  "", "tooLong", "flooding", "unsupported", "peerBusy", "failed", "refused",
];

describe("why a save failed", () => {
  it("answers every member, in both maintained languages", () => {
    for (const reason of REASONS) {
      const key = publishFailureKey(reason);
      expect(en[key], reason).toBeTruthy();
      expect(zh[key], reason).toBeTruthy();
      expect(zh[key], reason).not.toBe(en[key]);
    }
  });

  it("gives the actionable filesystem outcomes DIFFERENT sentences", () => {
    // The defect this closes. Every one of these used to render "Could not
    // write to the folder you chose", because the helper's own wire codes
    // reached the screen untranslated and no branch matched them. Each needs a
    // different thing done about it: free space, close the other program,
    // rename, choose another folder.
    const actionable = ["exists", "permission", "no-space", "in-use", "gone", "name-too-long"] as const;
    const sentences = actionable.map((reason) => en[publishFailureKey(reason)]);
    expect(new Set(sentences).size).toBe(actionable.length);
    // And none of them is the generic one, which is now ONLY `io-failed`.
    for (const sentence of sentences) expect(sentence).not.toBe(en.recvFailedPrefix);
    expect(en[publishFailureKey("io-failed")]).toBe(en.recvFailedPrefix);
  });

  it("does not call a full disk a folder problem", () => {
    // Named on its own because the generic sentence sends somebody to check
    // permissions on a folder that is perfectly fine.
    expect(en[publishFailureKey("no-space")]).not.toBe(en.recvFailedPrefix);
    expect(en[publishFailureKey("no-space")]).not.toBe(en[publishFailureKey("permission")]);
  });

  it("does not call a cancel or an uncertain cleanup a write failure", () => {
    // `cleanup-uncertain` means the write may have SUCCEEDED and only the
    // teardown could not confirm it. "Could not write" is false there.
    for (const reason of ["cancelled", "cleanup-uncertain"] as const) {
      expect(en[publishFailureKey(reason)]).not.toBe(en.recvFailedPrefix);
    }
    expect(en[publishFailureKey("cancelled")]).not.toBe(en[publishFailureKey("cleanup-uncertain")]);
  });
});

describe("the text lane's own error", () => {
  it("is silent for the empty member and ONLY that one", () => {
    expect(textErrorMessageKey("")).toBe("");
    for (const key of TEXT_KEYS.filter((k) => k !== "")) {
      expect(textErrorMessageKey(key), key).not.toBe("");
    }
  });

  it("says something for the two that used to say nothing", () => {
    // A message that could not be sent, and a session closed because the peer
    // sent too many, both rendered as silence.
    for (const key of ["flooding", "failed"] as const) {
      const message = textErrorMessageKey(key);
      expect(message).not.toBe("");
      expect(en[message as Exclude<typeof message, "">]).toBeTruthy();
      expect(zh[message as Exclude<typeof message, "">]).toBeTruthy();
    }
  });

  it("gives every named member its own sentence, in both languages", () => {
    const named = TEXT_KEYS.filter((k): k is Exclude<TextErrorKey, ""> => k !== "");
    const keys = named.map((k) => textErrorMessageKey(k) as Exclude<ReturnType<typeof textErrorMessageKey>, "">);
    expect(new Set(keys).size).toBe(named.length);
    for (const key of keys) {
      expect(en[key]).toBeTruthy();
      expect(zh[key]).toBeTruthy();
      expect(zh[key]).not.toBe(en[key]);
    }
  });
});
