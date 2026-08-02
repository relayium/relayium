import { describe, expect, it } from "vitest";
import { lastForegroundAt, stalled } from "./foreground";

const STALL = 45_000;

describe("stalled", () => {
  it("does not fire while bytes are arriving", () => {
    expect(stalled(100_000, 99_000, 0, STALL)).toBe(false);
  });

  it("fires when a foregrounded page really has gone quiet", () => {
    expect(stalled(100_000, 40_000, 0, STALL)).toBe(true);
  });

  // The case this exists for. Android suspends a backgrounded tab, so a user who
  // switches apps for two minutes returns to a watchdog that has "seen" two
  // minutes of silence — and would fail a transfer that was never stalled. The
  // screen wake lock covers screen-off; it cannot cover app switching.
  it("grants a fresh window when the page has just returned to the foreground", () => {
    const now = 240_000;
    const lastByte = 5_000; // before the tab was suspended
    expect(stalled(now, lastByte, 0, STALL)).toBe(true); // wall clock alone: dead
    expect(stalled(now, lastByte, now - 100, STALL)).toBe(false); // just came back: alive
  });

  it("still fails a connection that is dead after the page came back", () => {
    const cameBack = 100_000;
    expect(stalled(cameBack + STALL, 5_000, cameBack, STALL)).toBe(false); // exactly at the edge
    expect(stalled(cameBack + STALL + 1, 5_000, cameBack, STALL)).toBe(true);
  });

  it("is unaffected by a foreground moment older than the last byte", () => {
    expect(stalled(100_000, 99_000, 10_000, STALL)).toBe(false);
    expect(stalled(100_000, 40_000, 10_000, STALL)).toBe(true);
  });
});

describe("lastForegroundAt", () => {
  it("starts at page load rather than at zero", () => {
    // Zero would make every early watchdog tick look like a stale foreground and
    // defeat the whole point on the first transfer of a session.
    expect(lastForegroundAt()).toBeGreaterThan(0);
    expect(lastForegroundAt()).toBeLessThanOrEqual(Date.now());
  });
});
