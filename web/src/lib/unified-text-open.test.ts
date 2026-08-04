import { describe, expect, it } from "vitest";
import { createUnifiedTextOpener } from "./unified-text-open";

// A link built by the FILE lane has no conversation on it, and the unified
// workspace's whole promise is that both lanes are there. So the text lane is
// opened once, automatically — which makes "once" the entire safety property:
// every extra open re-runs a consent prompt on the peer that nobody asked for.
//
// The rule is a model rather than a flag in App.svelte because the interesting
// cases are lifecycle mutations (a lane that ended, a transport that was
// replaced, a second link to the same peer) and a boolean buried in a component
// can only be tested by scraping source.
const link = (linkGeneration: number, textIdle = true) => ({
  hasLink: true,
  linkGeneration,
  textIdle,
});

describe("unified text auto-open", () => {
  it("opens once for an authenticated link", () => {
    const opener = createUnifiedTextOpener();
    expect(opener.shouldOpen(link(1))).toBe(true);
    opener.markOpened(1);
    expect(opener.shouldOpen(link(1))).toBe(false);
  });

  it("never opens before an actual link exists", () => {
    const opener = createUnifiedTextOpener();
    // requesting/connecting: the manager has a peer but no authenticated link,
    // and opening here would be a second, racing establishment attempt.
    expect(opener.shouldOpen({ hasLink: false, linkGeneration: 1, textIdle: true })).toBe(false);
    // …and having declined, it has still not spent this generation.
    expect(opener.shouldOpen(link(1))).toBe(true);
  });

  it("never opens a lane that is not idle", () => {
    const opener = createUnifiedTextOpener();
    expect(opener.shouldOpen(link(1, false))).toBe(false);
  });

  it("does not reopen after the conversation ended, was refused or failed", () => {
    const opener = createUnifiedTextOpener();
    expect(opener.shouldOpen(link(3))).toBe(true);
    opener.markOpened(3);
    // Terminal states are not idle, so the lane guard alone already refuses…
    expect(opener.shouldOpen(link(3, false))).toBe(false);
    // …and the generation guard refuses even if the lane reported idle again,
    // which is what a cleared transcript on a still-live link looks like.
    expect(opener.shouldOpen(link(3))).toBe(false);
  });

  it("does not retrigger when the transport is replaced under the same link", () => {
    const opener = createUnifiedTextOpener();
    opener.markOpened(7);
    // An authenticated transport replacement keeps the SAME linkGeneration (see
    // mixed-session): same authentication step, same conversation history, and
    // the lane it suspended must not be reopened behind the user.
    expect(opener.shouldOpen(link(7))).toBe(false);
  });

  it("opens once more for a new authenticated link", () => {
    const opener = createUnifiedTextOpener();
    opener.markOpened(7);
    expect(opener.shouldOpen(link(8))).toBe(true);
    opener.markOpened(8);
    expect(opener.shouldOpen(link(8))).toBe(false);
    // And it does not fall back to the older generation either.
    expect(opener.shouldOpen(link(7))).toBe(false);
  });

  it("treats generation 0 as a real generation", () => {
    // The first link a page ever makes must not be indistinguishable from
    // "nothing has been opened yet".
    const opener = createUnifiedTextOpener();
    expect(opener.shouldOpen(link(0))).toBe(true);
    opener.markOpened(0);
    expect(opener.shouldOpen(link(0))).toBe(false);
  });

  it("forgets on reset without being able to open anything by itself", () => {
    const opener = createUnifiedTextOpener();
    opener.markOpened(4);
    opener.reset();
    // Reset is what an explicit Disconnect does to the launcher. It restores the
    // "never opened" state but cannot conjure a link: with none, still false.
    expect(opener.shouldOpen({ hasLink: false, linkGeneration: 4, textIdle: true })).toBe(false);
    expect(opener.shouldOpen(link(4))).toBe(true);
  });
});
