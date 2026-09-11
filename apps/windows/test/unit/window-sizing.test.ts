// The window against the screens people actually have.
//
// Windows display scaling shrinks the LOGICAL work area rather than enlarging
// the window, so the interesting cases are not exotic monitors — they are
// ordinary laptops at the scale Windows itself recommends for them. Each case
// below is a real configuration, written out with its arithmetic, because the
// bug this replaces came from porting numbers that were safe on a Mac without
// checking what they meant here.

import { describe, expect, it } from "vitest";
import { DESIRED_MINIMUM, PREFERRED, fitToWorkArea } from "../../src/main/window-sizing.js";

describe("a screen with room to spare", () => {
  // 1920x1080 at 100%, taskbar taking 40. The window opens exactly as designed
  // and the minimum is untouched — the common case must not be changed by a fix
  // aimed at the uncommon one.
  it("opens at the preferred size and keeps the designed minimum", () => {
    expect(fitToWorkArea({ width: 1920, height: 1040 })).toEqual({
      width: PREFERRED.width,
      height: PREFERRED.height,
      minWidth: DESIRED_MINIMUM.width,
      minHeight: DESIRED_MINIMUM.height,
    });
  });
});

describe("a screen Windows scaling has made small", () => {
  // 1366x768 at 150% is 910x512 logical, and the taskbar takes ~40 of that.
  // The old fixed minimum of 560 is TALLER than the whole work area: the bottom
  // of the app sits below the edge of the screen and cannot be brought up.
  it("never asks for more height than a 1366x768 laptop at 150% has", () => {
    const sizing = fitToWorkArea({ width: 910, height: 472 });
    expect(sizing.height).toBe(472);
    expect(sizing.minHeight).toBe(472);
    expect(sizing.minHeight).toBeLessThan(DESIRED_MINIMUM.height);
    // Width still fits, so it is left alone. A fix that shrank both would make
    // the window narrower than it needs to be on this machine.
    expect(sizing.minWidth).toBe(DESIRED_MINIMUM.width);
  });

  // 1920x1080 at 200%: 960x540, minus the taskbar.
  it("fits a 1080p screen at 200%", () => {
    const sizing = fitToWorkArea({ width: 960, height: 500 });
    expect(sizing).toEqual({ width: 960, height: 500, minWidth: DESIRED_MINIMUM.width, minHeight: 500 });
  });

  // Both dimensions short — a small tablet, or a scaled screen in portrait.
  it("fits a screen that is short in both directions", () => {
    expect(fitToWorkArea({ width: 800, height: 600 })).toEqual({
      width: 800,
      height: 600,
      minWidth: 800,
      minHeight: 560,
    });
  });
});

describe("the invariants that make it safe", () => {
  const AREAS = [
    { width: 1920, height: 1040 },
    { width: 1536, height: 824 },
    { width: 1280, height: 680 },
    { width: 910, height: 472 },
    { width: 960, height: 500 },
    { width: 800, height: 600 },
    { width: 640, height: 400 },
    { width: 320, height: 240 },
    { width: 1, height: 1 },
  ];

  // The property the whole file exists for. A window larger than the work area
  // in EITHER direction is one the user cannot see all of.
  it("never exceeds the work area", () => {
    for (const area of AREAS) {
      const s = fitToWorkArea(area);
      expect(s.width, JSON.stringify(area)).toBeLessThanOrEqual(area.width);
      expect(s.height, JSON.stringify(area)).toBeLessThanOrEqual(area.height);
      expect(s.minWidth, JSON.stringify(area)).toBeLessThanOrEqual(area.width);
      expect(s.minHeight, JSON.stringify(area)).toBeLessThanOrEqual(area.height);
    }
  });

  // A minimum above the opening size is a window that opens already clamped —
  // which is how it opened taller than the desktop to begin with.
  it("never asks for a minimum larger than the window it opens", () => {
    for (const area of AREAS) {
      const s = fitToWorkArea(area);
      expect(s.minWidth, JSON.stringify(area)).toBeLessThanOrEqual(s.width);
      expect(s.minHeight, JSON.stringify(area)).toBeLessThanOrEqual(s.height);
    }
  });

  it("never asks for more than the app was designed for", () => {
    for (const area of AREAS) {
      const s = fitToWorkArea(area);
      expect(s.width, JSON.stringify(area)).toBeLessThanOrEqual(PREFERRED.width);
      expect(s.height, JSON.stringify(area)).toBeLessThanOrEqual(PREFERRED.height);
    }
  });

  it("always produces a window with a real size", () => {
    for (const area of AREAS) {
      const s = fitToWorkArea(area);
      for (const [name, value] of Object.entries(s)) {
        expect(Number.isInteger(value), `${name} ${JSON.stringify(area)}`).toBe(true);
        expect(value, `${name} ${JSON.stringify(area)}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("a reading that cannot be used", () => {
  // The size comes from the OS through Electron. A zero, a negative or a NaN
  // must not become a window with no size at all — that is worse than the bug
  // being fixed, so an unusable reading falls back to what shipped before.
  it("ignores a work area that is not a size", () => {
    for (const area of [
      { width: 0, height: 0 },
      { width: -1920, height: -1080 },
      { width: Number.NaN, height: Number.NaN },
      { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY },
    ]) {
      const s = fitToWorkArea(area);
      expect(s.width, JSON.stringify(area)).toBe(PREFERRED.width);
      expect(s.height, JSON.stringify(area)).toBe(PREFERRED.height);
      expect(s.minWidth, JSON.stringify(area)).toBe(DESIRED_MINIMUM.width);
      expect(s.minHeight, JSON.stringify(area)).toBe(DESIRED_MINIMUM.height);
    }
  });

  // One dimension bad and the other good: the good one is still honoured.
  it("uses the dimension it CAN read", () => {
    const s = fitToWorkArea({ width: 910, height: Number.NaN });
    expect(s.width).toBe(910);
    expect(s.height).toBe(PREFERRED.height);
  });

  // A fractional reading is real: Windows reports scaled sizes, and a window
  // cannot be 471.5 pixels tall. Rounding DOWN is the safe direction.
  it("rounds a fractional work area down rather than up", () => {
    expect(fitToWorkArea({ width: 910.9, height: 472.9 })).toEqual({
      width: 910,
      height: 472,
      minWidth: DESIRED_MINIMUM.width,
      minHeight: 472,
    });
  });
});
