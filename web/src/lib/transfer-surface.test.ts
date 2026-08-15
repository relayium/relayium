// web/src/lib/transfer-surface.test.ts — LAN Transfer and Cross-network
// Transfer are sibling products, pinned as behaviour.
//
// The shipped defect these tests are written against: `showTransfer` was
// `busy || storedReceiver || (visiblePeers.length > 0 && !lanDismissed)`, with
// no route term at all. `/cross-network` therefore rendered the shared transfer
// surface — device cards, peer names, the same-network empty prompt — the
// moment ANY peer became visible, and without a pairing room every visible peer
// is a LAN neighbour, because the signalling socket is bound to the room-less
// LAN endpoint. Opening the cross-network page with a second browser window on
// the same Wi-Fi was enough to see it.
//
// `lanRoom()` below is what makes these tests about the defect rather than
// about the fix: it is the exact state that shipped broken, and every
// assertion on it fails against the old condition.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  showsPeerRoster,
  showsTransferSurface,
  type TransferSurfaceState,
} from "./transfer-surface";

/** Nothing happening anywhere: no room, no peer, no transfer. */
const idle: TransferSurfaceState = {
  route: "lan",
  roomCode: "",
  busy: false,
  storedReceiveActive: false,
  visiblePeers: 0,
};

/**
 * A LAN neighbour is visible and this page is on `/cross-network`.
 *
 * `roomCode: ""` is the whole point: with no code, the socket is on the LAN
 * endpoint, so the only devices it can offer are same-network ones.
 */
const lanRoom = (over: Partial<TransferSurfaceState> = {}): TransferSurfaceState => ({
  ...idle, route: "cross", roomCode: "", visiblePeers: 1, ...over,
});

/** A pairing room with the code's one participant joined. */
const codeRoom = (over: Partial<TransferSurfaceState> = {}): TransferSurfaceState => ({
  ...idle, route: "cross", roomCode: "418902", visiblePeers: 1, ...over,
});

describe("a LAN peer cannot surface on the cross-network destination", () => {
  it("does not draw the transfer surface for a visible LAN peer", () => {
    expect(showsTransferSurface(lanRoom())).toBe(false);
  });

  it("stays hidden for many LAN peers, which is where the roster would appear", () => {
    expect(showsTransferSurface(lanRoom({ visiblePeers: 4 }))).toBe(false);
  });

  it("stays hidden while a LAN transfer this tab started is still running", () => {
    // The old condition's first term. A LAN transfer keeps running and keeps
    // its ownership — it simply stays on the destination that owns it, which is
    // the same rule macOS states with `TransferPresence`. Rendering it here
    // would put the peer's card and name on the cross-network page.
    expect(showsTransferSurface(lanRoom({ busy: true }))).toBe(false);
    expect(showsTransferSurface(lanRoom({ busy: true, visiblePeers: 0 }))).toBe(false);
  });

  it("stays hidden for a stored receive that has no pairing room behind it", () => {
    expect(showsTransferSurface(lanRoom({ storedReceiveActive: true, visiblePeers: 0 })))
      .toBe(false);
  });

  it("is not merely hidden everywhere — the same state on LAN still draws it", () => {
    // Without this, a fix that returned false unconditionally would pass every
    // assertion above while deleting the product.
    expect(showsTransferSurface({ ...lanRoom(), route: "lan" })).toBe(true);
    expect(showsTransferSurface({ ...lanRoom({ busy: true, visiblePeers: 0 }), route: "lan" }))
      .toBe(true);
  });
});

describe("the cross-network destination still draws its own session", () => {
  it("draws the surface once the code's participant has joined", () => {
    expect(showsTransferSurface(codeRoom())).toBe(true);
  });

  it("keeps drawing it for an in-flight code transfer whose roster emptied", () => {
    // The signalling socket can drop after the handoff while the transfer
    // itself can still finish. Losing the surface here would take an unanswered
    // consent prompt and its downloads off the screen.
    expect(showsTransferSurface(codeRoom({ busy: true, visiblePeers: 0 }))).toBe(true);
    expect(showsTransferSurface(codeRoom({ storedReceiveActive: true, visiblePeers: 0 })))
      .toBe(true);
  });

  it("waits for the room rather than drawing an empty surface next to the code", () => {
    expect(showsTransferSurface(codeRoom({ visiblePeers: 0 }))).toBe(false);
  });
});

describe("the roster section exists only where its empty state is true", () => {
  it("keeps LAN's roster with nobody around, because that IS LAN's answer", () => {
    expect(showsPeerRoster("lan", 0)).toBe(true);
    expect(showsPeerRoster("lan", 2)).toBe(true);
  });

  it("drops the section on cross-network when the code's participant is gone", () => {
    // Its empty state says "open this page on another device or browser window
    // on the same network" — a network this destination does not use.
    expect(showsPeerRoster("cross", 0)).toBe(false);
    expect(showsPeerRoster("cross", 1)).toBe(true);
  });
});

describe("App.svelte asks this seam rather than restating the rule", () => {
  const app = readFileSync(resolve(process.cwd(), "src/App.svelte"), "utf8");

  it("derives showTransfer from showsTransferSurface with the live route", () => {
    expect(app).toContain('import { showsTransferSurface, showsPeerRoster } from "./lib/transfer-surface"');
    const derived = app.slice(app.indexOf("const showTransfer = $derived("), app.indexOf("// The window-wide drop"));
    expect(derived).toContain("showsTransferSurface({");
    expect(derived).toContain("route: currentRoute()");
    expect(derived).toContain("roomCode,");
    // The retired flag and its un-dismiss effect are the shipped shape of the
    // LAN auto-surface. Leaving them behind leaves the behaviour one edit away.
    expect(app).not.toContain("lanDismissed");
    expect(app).not.toContain("dismissLan");
  });

  it("gates the roster section on the seam, and drops cross's LAN empty state", () => {
    const surface = app.slice(
      app.indexOf("{#snippet transferSurface()}"),
      app.indexOf("{/snippet}", app.indexOf("{#snippet transferSurface()}")),
    );
    expect(surface).toContain("showsPeerRoster(currentRoute(), visiblePeers.length)");
    // `emptyPeers` names the same network in both maintained languages. It may
    // exist exactly once in the snippet — inside the LAN-only chooser branch.
    const empties = surface.split("t.emptyPeers").length - 1;
    expect(empties, "the same-network prompt has a second render site").toBe(1);
    const lanOnly = surface.slice(
      surface.indexOf('{#if currentRoute() === "lan"}\n      {#if chooser === "empty"}'),
      surface.indexOf("{:else}", surface.indexOf('{#if chooser === "empty"}')),
    );
    expect(lanOnly, "the same-network prompt escaped the LAN branch").toContain("t.emptyPeers");
  });

  it("never labels the cross-network roster with LAN's own heading", () => {
    const heading = app.slice(app.indexOf('<section class="peers"'), app.indexOf("<QuotaNotice />"));
    expect(heading).toContain("t.crossPeersTitle");
    // The shipped `currentRoute() === "cross" && roomCode` fell through to
    // "Nearby devices" for the room-less LAN auto-surface this batch removed.
    expect(heading).not.toContain("roomCode");
    // LAN's title moved OUT of this section and became the page's <h1>, so the
    // section must not print it a second time — and the cross branch must not
    // have been collapsed along with it.
    expect(heading).not.toContain("t.peersTitle");
    expect(heading).toMatch(/\{#if currentRoute\(\) === "cross"\}\s*<h2>\{t\.crossPeersTitle\}<\/h2>\s*\{\/if\}/);
  });
});

describe("CrossPage has no LAN-driven exit left to take", () => {
  const page = readFileSync(resolve(process.cwd(), "src/lib/CrossPage.svelte"), "utf8");

  it("returns to the method choices by leaving the room alone", () => {
    expect(page).toContain("enterRoom({})");
    expect(page).not.toContain("dismissLan");
  });
});
