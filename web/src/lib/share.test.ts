import { describe, it, expect, afterEach, vi } from "vitest";
import { canShare, share } from "./share";

afterEach(() => vi.unstubAllGlobals());

describe("canShare", () => {
  it("is false when navigator.share is absent (desktop / jsdom)", () => {
    expect(canShare()).toBe(false);
  });
  it("is true when navigator.share is a function", () => {
    vi.stubGlobal("navigator", { share: () => Promise.resolve() });
    expect(canShare()).toBe(true);
  });
});

describe("share", () => {
  it("no-ops when the Web Share API is unavailable", async () => {
    await expect(share({ url: "https://relayium.app/d/x" })).resolves.toBeUndefined();
  });
  it("forwards the payload to navigator.share when supported", async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share: shareMock });
    await share({ url: "https://relayium.app/d/x", title: "Relayium" });
    expect(shareMock).toHaveBeenCalledWith({ url: "https://relayium.app/d/x", title: "Relayium" });
  });
  it("swallows a user-cancelled share (AbortError)", async () => {
    vi.stubGlobal("navigator", { share: vi.fn().mockRejectedValue(new DOMException("cancelled", "AbortError")) });
    await expect(share({ url: "https://relayium.app/d/x" })).resolves.toBeUndefined();
  });
});
