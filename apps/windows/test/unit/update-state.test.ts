// The state set, and exactly which states may act.
//
// These predicates are the ones a UI will branch on, so they are pinned
// directly rather than only through the service. The service ALSO refuses
// (it extracts a candidate only from `ready`), and that redundancy is
// deliberate — but a service test cannot tell a widened predicate from a
// working one, because the second guard catches it. This file can.
import { describe, expect, it } from "vitest";

import type { PublisherVerdict } from "../../src/main/update/contracts.js";
import {
  canInstall,
  canReveal,
  stateForVerdict,
  type CandidateFacts,
  type UpdateState,
} from "../../src/main/update/state.js";

const candidate: CandidateFacts = {
  version: "0.3.0",
  build: 9,
  sizeBytes: 2048,
  notesUrl: null,
  sha256: "a".repeat(64),
};

/** Every state kind, once. A new kind added without a decision here will fail
 *  the exhaustiveness check below rather than silently defaulting to "cannot". */
const ALL: readonly UpdateState[] = [
  { kind: "disabled", reason: "engineering-build" },
  { kind: "disabled", reason: "no-pin" },
  { kind: "idle", lastCheckedAt: null },
  { kind: "checking" },
  { kind: "up-to-date", checkedAt: 1 },
  { kind: "check-failed", reason: "network", retryable: true },
  { kind: "feed-untrusted", detail: "not-signed-by-pin" },
  { kind: "update-available", candidate },
  { kind: "downloading", candidate, receivedBytes: 10 },
  { kind: "verify-failed", candidate, reason: "integrity" },
  { kind: "ready", candidate },
  { kind: "ready-unsigned", candidate },
  { kind: "publisher-mismatch", candidate },
  { kind: "verifier-unavailable", candidate },
  { kind: "installing", candidate },
  { kind: "install-deferred", candidate, reason: "busy" },
  { kind: "revealed", candidate },
  { kind: "journal-unavailable", reason: "corrupt" },
  { kind: "blocked", reason: "unresolved-residue", count: 1, detail: null },
  { kind: "blocked", reason: "staging-unowned", count: 0, detail: "no-platform-scope" },
];

describe("which states may act", () => {
  it("exactly one state may install", () => {
    const installable = ALL.filter(canInstall).map((state) => state.kind);
    expect(installable).toEqual(["ready"]);
  });

  it("exactly one state may reveal, and it is not the installable one", () => {
    const revealable = ALL.filter(canReveal).map((state) => state.kind);
    expect(revealable).toEqual(["ready-unsigned"]);
    // The unsigned path never gains an execute affordance, and the signed path
    // never gains a reveal-instead-of-install one.
    expect(ALL.filter((state) => canInstall(state) && canReveal(state))).toEqual([]);
  });

  it("covers every kind, so a new state cannot default to permitted", () => {
    const kinds = new Set(ALL.map((state) => state.kind));
    // Update this list when a state is added — and decide, at that moment,
    // whether it may install or reveal.
    expect([...kinds].sort()).toEqual(
      [
        "blocked",
        "check-failed",
        "checking",
        "disabled",
        "downloading",
        "feed-untrusted",
        "idle",
        "install-deferred",
        "installing",
        "journal-unavailable",
        "publisher-mismatch",
        "ready",
        "ready-unsigned",
        "revealed",
        "up-to-date",
        "update-available",
        "verifier-unavailable",
        "verify-failed",
      ].sort(),
    );
  });
});

describe("the four publisher answers stay four", () => {
  const mapping: readonly (readonly [PublisherVerdict, UpdateState["kind"]])[] = [
    ["signed-by-expected-publisher", "ready"],
    ["unsigned", "ready-unsigned"],
    ["signed-by-other-publisher", "publisher-mismatch"],
    ["unavailable", "verifier-unavailable"],
  ];

  for (const [verdict, kind] of mapping) {
    it(`${verdict} becomes ${kind}`, () => {
      expect(stateForVerdict(verdict, candidate).kind).toBe(kind);
    });
  }

  it("never collapses `unavailable` into `unsigned`", () => {
    // A check that could not run is not a check that found nothing: the first
    // offers nothing at all, the second may reveal.
    const unavailable = stateForVerdict("unavailable", candidate);
    const unsigned = stateForVerdict("unsigned", candidate);
    expect(unavailable.kind).not.toBe(unsigned.kind);
    expect(canReveal(unavailable)).toBe(false);
    expect(canInstall(unavailable)).toBe(false);
  });

  it("treats another publisher as its own terminal state, not as unsigned", () => {
    const mismatch = stateForVerdict("signed-by-other-publisher", candidate);
    expect(canInstall(mismatch)).toBe(false);
    expect(canReveal(mismatch)).toBe(false);
  });
});
