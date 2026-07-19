import { describe, it, expect } from "vitest";
import { detectPlatform } from "./platform";

describe("detectPlatform", () => {
  it("detects iOS (iPhone and iPad)", () => {
    expect(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("ios");
  });
  it("detects macOS but not when it is actually iOS", () => {
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("mac");
    // iPad UAs contain "Mac OS X" — iOS must win
    expect(detectPlatform("Mozilla/5.0 (iPad; CPU OS 16 like Mac OS X)")).toBe("ios");
  });
  it("treats a touch-capable Macintosh UA (iPadOS desktop mode) as iOS", () => {
    const iPadDesktopUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
    // iPadOS 13+ desktop mode: Macintosh UA but maxTouchPoints > 1
    expect(detectPlatform(iPadDesktopUA, 5)).toBe("ios");
    // a real Mac has no touch screen (0/undefined) → stays mac
    expect(detectPlatform(iPadDesktopUA, 0)).toBe("mac");
    expect(detectPlatform(iPadDesktopUA)).toBe("mac");
  });
  it("detects Android before Linux (Android UAs contain 'Linux')", () => {
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("android");
  });
  it("detects Windows and Linux", () => {
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });
  it("falls back to unknown", () => {
    expect(detectPlatform("")).toBe("unknown");
    expect(detectPlatform("some-random-agent")).toBe("unknown");
  });
});
