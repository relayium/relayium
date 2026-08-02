import { describe, it, expect } from "vitest";
import { detectPlatform, mobileFromUA } from "./platform";

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

// 这个判断只喂给一处：filesink 在没有实测证据时该不该相信 File System Access
// 选择器。所以宁可多认（多一次内存提示），不可漏认（在弹不出选择器的设备上
// 声称能流式落盘，然后一声不吭地把整批攒进内存）。
describe("mobileFromUA", () => {
  it("认出 Android 手机与平板（平板 UA 里没有 'Mobile'）", () => {
    expect(mobileFromUA("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/140 Mobile Safari/537.36")).toBe(true);
    expect(mobileFromUA("Mozilla/5.0 (Linux; Android 13; SM-X710) Chrome/140 Safari/537.36")).toBe(true);
  });
  it("认出 iPhone/iPad，以及桌面模式的 iPadOS", () => {
    expect(mobileFromUA("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(true);
    expect(mobileFromUA("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe(true);
    expect(mobileFromUA("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", undefined, 5)).toBe(true);
  });
  it("桌面浏览器不算", () => {
    expect(mobileFromUA("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140 Safari/537.36")).toBe(false);
    expect(mobileFromUA("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140 Safari/537.36")).toBe(false);
    expect(mobileFromUA("Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0")).toBe(false);
    expect(mobileFromUA("")).toBe(false);
  });
  it("UA-CH 的 mobile 位只在为 true 时采信：Android 平板报的是 false，仍要按手机算", () => {
    expect(mobileFromUA("some-random-agent", true)).toBe(true);
    expect(mobileFromUA("Mozilla/5.0 (Linux; Android 13; SM-X710) Chrome/140 Safari/537.36", false)).toBe(true);
    expect(mobileFromUA("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140", false)).toBe(false);
  });
});
