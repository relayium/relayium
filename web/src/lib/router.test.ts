import { describe, it, expect } from "vitest";
import { routeFromLocation, CROSS_PATH } from "./router.svelte";

describe("routeFromLocation", () => {
  it("defaults to lan on root", () => {
    expect(routeFromLocation("/", "")).toBe("lan");
  });
  it("is cross on the cross-network path", () => {
    expect(routeFromLocation(CROSS_PATH, "")).toBe("cross");
  });
  it("is cross whenever a transfer token is present, regardless of path", () => {
    expect(routeFromLocation("/", "#t=abc123")).toBe("cross");
  });
  it("ignores non-token hashes", () => {
    expect(routeFromLocation("/", "#other=1")).toBe("lan");
  });
});
