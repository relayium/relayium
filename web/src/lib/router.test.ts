import { describe, it, expect } from "vitest";
import { routeFromLocation as rfl, downloadId, CROSS_PATH } from "./router.svelte";

describe("routeFromLocation", () => {
  it("defaults to lan on root", () => {
    expect(rfl("/", "")).toBe("lan");
  });
  it("is cross on the cross-network path", () => {
    expect(rfl(CROSS_PATH, "")).toBe("cross");
  });
  it("is cross whenever a transfer token is present, regardless of path", () => {
    expect(rfl("/", "#t=abc123")).toBe("cross");
  });
  it("ignores non-token hashes", () => {
    expect(rfl("/", "#other=1")).toBe("lan");
  });
});

describe("download route", () => {
  it("is download for /d/<id>", () => {
    expect(rfl("/d/abc123", "")).toBe("download");
  });
  it("extracts the id from the path", () => {
    expect(downloadId("/d/abc123")).toBe("abc123");
    expect(downloadId("/")).toBe("");
  });
  it("does not treat bare /d/ as a download route", () => {
    expect(rfl("/d/", "")).toBe("lan");
  });
  it("leaves normal routes unaffected", () => {
    expect(rfl("/", "")).toBe("lan");
    expect(rfl(CROSS_PATH, "")).toBe("cross");
  });
});
