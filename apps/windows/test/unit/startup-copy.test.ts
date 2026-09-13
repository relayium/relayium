// What the account screen says about opening Relayium at sign-in.
//
// The chain this covers used to answer six of seven possibilities, and the
// seventh — the consent prompt itself throwing — fell into "That could not be
// changed on this PC". Windows refused nothing there; nothing was attempted.
import { describe, expect, it } from "vitest";

import { startupFailureKey, startupStateKey } from "../../src/renderer/account/startup-copy.js";
import type { LoginItemFailure, LoginItemState } from "../../src/main/login-item.js";
import { en, zh } from "../../src/renderer/i18n/messages.js";

const FAILURES: readonly LoginItemFailure["kind"][] = ["unreadable", "write-failed", "consent-failed"];
const STATES: readonly LoginItemState[] = ["off", "on", "disabled-by-user", "on-by-other-means"];

describe("why startup could not be read or changed", () => {
  it("answers every failure, in both maintained languages", () => {
    for (const kind of FAILURES) {
      const key = startupFailureKey({ kind });
      expect(en[key], kind).toBeTruthy();
      expect(zh[key], kind).toBeTruthy();
      expect(zh[key], kind).not.toBe(en[key]);
    }
  });

  it("gives all three their own sentence", () => {
    // The defect: `consent-failed` shared the write-failure sentence, which
    // names the machine as the culprit for something the machine never saw.
    const said = FAILURES.map((kind) => en[startupFailureKey({ kind })]);
    expect(new Set(said).size).toBe(FAILURES.length);
  });

  it("does not blame the PC when the PROMPT failed", () => {
    expect(startupFailureKey({ kind: "consent-failed" })).not.toBe(
      startupFailureKey({ kind: "write-failed" }),
    );
    // And it does not read as "we could not find out" either — that is the
    // unreadable case, and this one knows exactly what happened.
    expect(startupFailureKey({ kind: "consent-failed" })).not.toBe(
      startupFailureKey({ kind: "unreadable" }),
    );
  });

  it("never reports a failure to read as OFF", () => {
    // `login-item.ts` states this rule and keeps the two apart on purpose: off
    // is a claim about the machine, unreadable is a claim about the call, and a
    // screen that shows the first when it means the second invites somebody to
    // fix what may not be broken.
    for (const kind of FAILURES) {
      expect(startupFailureKey({ kind }), kind).not.toBe(startupStateKey("off"));
    }
  });
});

describe("what the system currently reports", () => {
  it("answers every state, in both maintained languages", () => {
    for (const state of STATES) {
      const key = startupStateKey(state);
      expect(en[key], state).toBeTruthy();
      expect(zh[key], state).toBeTruthy();
      expect(zh[key], state).not.toBe(en[key]);
    }
  });

  it("keeps the two that took real thought apart from OFF", () => {
    // `disabled-by-user` is registered but switched off in Task Manager, which
    // no checkbox here can undo. `on-by-other-means` is not registered by this
    // app and yet will launch. Collapsing either into "off" would offer the
    // wrong remedy.
    for (const state of ["disabled-by-user", "on-by-other-means"] as const) {
      expect(startupStateKey(state), state).not.toBe(startupStateKey("off"));
      expect(startupStateKey(state), state).not.toBe(startupStateKey("on"));
    }
    expect(startupStateKey("disabled-by-user")).not.toBe(startupStateKey("on-by-other-means"));
  });

  it("gives all four their own sentence", () => {
    expect(new Set(STATES.map((s) => en[startupStateKey(s)])).size).toBe(STATES.length);
    expect(new Set(STATES.map((s) => zh[startupStateKey(s)])).size).toBe(STATES.length);
  });
});
