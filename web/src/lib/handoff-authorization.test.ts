// The one thing standing between a pre-uploaded batch and a peer that may have
// guessed the pairing code.
//
// The gap this closes was real on the three-state lane diff: with advanced
// verification ON, `attach()` pulled the stored key set and emitted frame kind 12
// the instant an authenticated link existed — and a link exists as soon as the
// workspace is opened to SHOW the verification code. So the code the sender was
// being told to compare was already too late to matter: the joiner held the keys
// to every finalized object before the sender clicked anything. The old (broken)
// live fallback hid it, because it released those entries back to the live lane
// before the link came up and the handoff had nothing left to name.
//
// Executed rather than described, and stateful on purpose: what makes an
// authorization safe is not the shape of the record but every way it stops
// matching the world.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { flushSync } from "svelte";
import { trackEffect } from "./effect-probe.svelte";
import {
  authorizeHandoff,
  handoffAllowed,
  revokeHandoff,
  type HandoffContext,
} from "./handoff-authorization.svelte";
// The production preference, driven here rather than described: a grant made
// under one setting must not survive the user changing it, and "App remembers to
// revoke" is not a property any test of this module could prove.
import { setVerifyPeers, verifyPeers } from "./verify-pref.svelte";

/** A code room with advanced verification on: the one configuration in which a
 *  sender confirmation stands in front of the handoff at all. */
const ctx = (over: Partial<HandoffContext> = {}): HandoffContext => ({
  peerId: "peer-1",
  roomCode: "room-1",
  linkGeneration: 3,
  verifyOn: true,
  ...over,
});

beforeEach(() => {
  // The preference first: setting it is itself a revocation now, so a grant
  // recorded before it would be dropped by the reset rather than by the test.
  setVerifyPeers(false);
  revokeHandoff();
});

describe("nothing leaves before the sender confirms", () => {
  it("refuses a peer nobody authorized", () => {
    expect(handoffAllowed(ctx())).toBe(false);
  });

  it("allows exactly the peer, room and link that were authorized", () => {
    authorizeHandoff(ctx());
    expect(handoffAllowed(ctx())).toBe(true);
  });

  it("has no stop to enforce when no confirmation is in force", () => {
    // Advanced verification off, and LAN in every mode. There is no code on
    // screen to compare, so a bar there would be a click-through — the product
    // rule the whole confirmation is derived from (verify-gates).
    expect(handoffAllowed(ctx({ verifyOn: false }))).toBe(true);
    expect(handoffAllowed(ctx({ roomCode: "" }))).toBe(true);
  });
});

describe("the authorization stops matching the world", () => {
  it("does not follow the user to a different target", () => {
    authorizeHandoff(ctx());
    expect(handoffAllowed(ctx({ peerId: "peer-2" }))).toBe(false);
  });

  it("does not survive a reconnect, which the server renames", () => {
    authorizeHandoff(ctx({ peerId: "peer-1" }));
    // A peer that drops and rejoins is issued a fresh id. Nothing about the old
    // one is inherited — including a confirmation given against its SAS.
    expect(handoffAllowed(ctx({ peerId: "peer-1-again" }))).toBe(false);
  });

  it("does not survive a new link to the same peer", () => {
    // A new authentication step has a new SAS, and the user compared the old
    // one. `linkGeneration` advances on establishment and teardown but NOT on a
    // transport replacement, which is exactly the distinction needed here: a
    // rebuilt transport under one compared code keeps the authorization.
    authorizeHandoff(ctx({ linkGeneration: 3 }));
    expect(handoffAllowed(ctx({ linkGeneration: 3 }))).toBe(true);
    expect(handoffAllowed(ctx({ linkGeneration: 4 }))).toBe(false);
  });

  it("does not survive the link ending", () => {
    // No live link is reported as generation -1 rather than as a stale number:
    // an ended link's code is not on screen, so there is nothing the user could
    // still be comparing.
    authorizeHandoff(ctx());
    expect(handoffAllowed(ctx({ linkGeneration: -1 }))).toBe(false);
  });

  it("does not survive a room switch", () => {
    authorizeHandoff(ctx({ roomCode: "room-1" }));
    expect(handoffAllowed(ctx({ roomCode: "room-2" }))).toBe(false);
    // And the objects belong to the room they were uploaded into, so leaving the
    // room entirely is not a way to keep an authorization alive either.
    expect(handoffAllowed(ctx({ roomCode: "", verifyOn: true }))).toBe(true); // no stop in force at all
  });

  it("does not survive the preference it was given under changing", () => {
    setVerifyPeers(true);
    authorizeHandoff(ctx({ verifyOn: true }));
    // Turning verification off removes the stop entirely (allowed, and the whole
    // point of the preference); turning it back on must not silently reinstate a
    // decision made before the user changed their mind.
    setVerifyPeers(false);
    expect(handoffAllowed(ctx({ verifyOn: false }))).toBe(true);
    setVerifyPeers(true);
    expect(handoffAllowed(ctx({ verifyOn: true }))).toBe(false);
  });

  it("is revoked outright", () => {
    authorizeHandoff(ctx());
    revokeHandoff();
    expect(handoffAllowed(ctx())).toBe(false);
  });
});

describe("an authorization that could never be compared is not recorded", () => {
  it("refuses one with no live link behind it", () => {
    // The bar can be armed before any link exists — a preselected batch arms it
    // the instant one peer joins — and there is no SAS then. Recording one there
    // would authorize a comparison the user could not have made.
    authorizeHandoff(ctx({ linkGeneration: -1 }));
    expect(handoffAllowed(ctx())).toBe(false);
  });

  it("refuses one with no peer", () => {
    authorizeHandoff(ctx({ peerId: "" }));
    expect(handoffAllowed(ctx({ peerId: "" }))).toBe(false);
  });
});

describe("changing the preference is itself the revocation", () => {
  // Codex found this one open: `handoffAllowed` compares the preference the
  // grant was made under, which catches "off now, granted while on" — and misses
  // the round trip. ON → OFF → ON leaves `verifyOn: true` on both sides of the
  // comparison, so a decision the user made before they changed their mind twice
  // came back into force with the stop it was supposed to answer to.
  //
  // Wired at the SETTER rather than in App's change handler. The handler is one
  // call site that has to remember; the setter is the only way the preference
  // moves at all, so a later caller — a settings surface, a sync across tabs, a
  // test seam — cannot reintroduce this by forgetting.
  const app = readFileSync(resolve(process.cwd(), "src/App.svelte"), "utf8");

  it("is the setter App's own toggle calls", () => {
    // Binds the executable rules below to production: they are about
    // `setVerifyPeers`, and this is what makes that the function the checkbox
    // actually reaches. A second, ungated write path would make every assertion
    // in this file true about code nobody runs.
    const at = app.indexOf("function toggleVerify(");
    expect(at, "toggleVerify is missing from App.svelte").toBeGreaterThan(-1);
    const body = app.slice(at, app.indexOf("}", at));
    expect(body).toContain("setVerifyPeers(");
    expect(app.match(/setVerifyPeers\(/g)).toHaveLength(1);
    // The preference is never written by assigning the store's own reactive
    // value from a template either.
    expect(app).not.toContain("verifyPeers =");
  });

  it("drops a grant when verification is switched off", () => {
    setVerifyPeers(true);
    authorizeHandoff(ctx({ verifyOn: true }));
    setVerifyPeers(false);
    // Nothing is being enforced while it is off — that is the preference doing
    // its job — but the record itself is gone, which is what the round trip
    // below can then observe.
    expect(handoffAllowed(ctx({ verifyOn: true }))).toBe(false);
  });

  it("makes switching verification back on ask again", () => {
    setVerifyPeers(true);
    authorizeHandoff(ctx({ verifyOn: true }));
    expect(handoffAllowed(ctx({ verifyOn: true }))).toBe(true);
    setVerifyPeers(false);
    setVerifyPeers(true);
    expect(handoffAllowed(ctx({ verifyOn: true }))).toBe(false);
  });

  it("drops a grant when verification is switched on", () => {
    // The other direction, and not a hypothetical shape: with the preference off
    // there is no stop at all, so anything that records a grant there records one
    // nobody was asked for. Turning verification ON must not inherit it.
    authorizeHandoff(ctx({ verifyOn: false }));
    setVerifyPeers(true);
    expect(handoffAllowed(ctx({ verifyOn: true }))).toBe(false);
  });

  it("keeps a grant when the setter is called with the value it already has", () => {
    // Idempotent, because a re-render or a repeated write is not the user
    // changing their mind — and dropping a live grant there would put the
    // confirmation bar back in the middle of a handoff for no reason.
    setVerifyPeers(true);
    authorizeHandoff(ctx({ verifyOn: true }));
    setVerifyPeers(true);
    expect(handoffAllowed(ctx({ verifyOn: true }))).toBe(true);
  });

  it("never lets a reader see the new preference with the old grant", () => {
    // The send gate is reactive and the pull behind it runs on an effect, so
    // "revoked eventually" is not enough: no flush may ever observe a state in
    // which verification is on and a stale grant still answers yes. Both writes
    // happen inside one synchronous call, revocation first.
    setVerifyPeers(true);
    authorizeHandoff(ctx({ verifyOn: true }));
    const probe = trackEffect(() => verifyPeers() && handoffAllowed(ctx({ verifyOn: verifyPeers() })));
    flushSync();
    expect(probe.values).toEqual([true]);

    setVerifyPeers(false);
    flushSync();
    setVerifyPeers(true);
    flushSync();
    // One run per change of the preference, and the answer after the first one
    // is never yes again — including the run in which verification is back ON,
    // which is the state the stale grant used to match.
    expect(probe.values).toEqual([true, false, false]);
    expect(probe.values.slice(1)).not.toContain(true);
    probe.stop();
  });
});

describe("the gate is reactive, because a control reads it", () => {
  it("re-runs a reader when the authorization is granted and withdrawn", () => {
    // The send gate has to close on confirmation, or the bar it armed comes
    // straight back; the release control has to reappear on revocation, or a
    // fully pre-uploaded batch has no control on screen that can reach it.
    const probe = trackEffect(() => handoffAllowed(ctx()));
    flushSync();
    expect(probe.values).toEqual([false]);

    authorizeHandoff(ctx());
    flushSync();
    expect(probe.values).toEqual([false, true]);

    revokeHandoff();
    flushSync();
    expect(probe.values).toEqual([false, true, false]);
    probe.stop();
  });
});
