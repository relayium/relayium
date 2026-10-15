import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentSpeedPref,
  DEFAULT_SPEED_PREF,
  MAX_CAP_BPS,
  MIN_CAP_BPS,
  parseSpeedPref,
  resetSpeedPrefMemoryForTests,
  saveSpeedPref,
  SPEED_PREF_KEY,
} from "./transfer-control";
import { reloadSpeedPref, setSpeedPref, speedPref } from "./transfer-speed-pref.svelte";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem(SPEED_PREF_KEY);
  resetSpeedPrefMemoryForTests();
  reloadSpeedPref();
});

describe("upload speed preference", () => {
  it("defaults to fastest", () => {
    expect(parseSpeedPref(null)).toEqual(DEFAULT_SPEED_PREF);
    expect(currentSpeedPref().mode).toBe("fast");
    expect(speedPref().mode).toBe("fast");
  });

  it("rejects malformed or hostile stored values instead of trusting them", () => {
    expect(parseSpeedPref("{")).toEqual(DEFAULT_SPEED_PREF);
    expect(parseSpeedPref(JSON.stringify({ mode: "turbo", capBytesPerSec: 5 }))).toEqual({ mode: "fast", capBytesPerSec: MIN_CAP_BPS });
    expect(parseSpeedPref(JSON.stringify({ mode: "cap", capBytesPerSec: 1e18 }))).toEqual({ mode: "cap", capBytesPerSec: MAX_CAP_BPS });
    expect(parseSpeedPref(JSON.stringify({ mode: "cap", capBytesPerSec: "1" }))).toEqual({ mode: "cap", capBytesPerSec: DEFAULT_SPEED_PREF.capBytesPerSec });
  });

  it("the UI setter drives what uploads read, persists, and removes the key at default", () => {
    setSpeedPref({ mode: "cap", capBytesPerSec: 256 * 1024 });
    expect(currentSpeedPref()).toEqual({ mode: "cap", capBytesPerSec: 256 * 1024 });
    expect(JSON.parse(localStorage.getItem(SPEED_PREF_KEY)!)).toEqual({ mode: "cap", capBytesPerSec: 256 * 1024 });
    reloadSpeedPref();
    expect(speedPref()).toEqual({ mode: "cap", capBytesPerSec: 256 * 1024 });
    setSpeedPref({ ...DEFAULT_SPEED_PREF });
    expect(localStorage.getItem(SPEED_PREF_KEY)).toBeNull();
  });

  it("blocked storage still controls the actual uploads of this page", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    });
    saveSpeedPref({ mode: "background", capBytesPerSec: 0 });
    expect(currentSpeedPref().mode).toBe("background");
  });

  it("works with no storage at all (Node runtimes) and touches none at import", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(currentSpeedPref()).toEqual(DEFAULT_SPEED_PREF);
    expect(saveSpeedPref({ mode: "cap", capBytesPerSec: 64 * 1024 })).toEqual({ mode: "cap", capBytesPerSec: 64 * 1024 });
    expect(currentSpeedPref().mode).toBe("cap");
  });
});
