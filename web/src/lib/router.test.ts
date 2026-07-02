import { describe, it, expect, vi, afterEach } from "vitest";
import {
  routeFromLocation as rfl, downloadId, CROSS_PATH,
  navigate, currentRoute, setNavGuard, syncRouteFromLocation,
} from "./router.svelte";

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

describe("routeFromLocation with a pairing code", () => {
  it("treats #c=<code> as the cross-network route", () => {
    expect(rfl("/", "#c=424242")).toBe("cross");
    expect(rfl("/cross-network", "#c=042424")).toBe("cross");
  });
  it("does not treat a malformed #c= as cross", () => {
    expect(rfl("/", "#c=123")).toBe("lan");
  });
});

describe("navigate", () => {
  afterEach(() => {
    setNavGuard(null);
    history.replaceState({}, "", "/");
    syncRouteFromLocation(); // reset route to "lan" between cases
  });

  it("switches route to the target tab", () => {
    navigate("cross");
    expect(currentRoute()).toBe("cross");
  });

  it("is a no-op when already on the target tab (does not consult the guard)", () => {
    navigate("cross");
    const guard = vi.fn(() => true);
    setNavGuard(guard);
    navigate("cross"); // already here
    expect(guard).not.toHaveBeenCalled();
    expect(currentRoute()).toBe("cross");
  });

  it("cancels navigation when the guard returns false", () => {
    // start on lan
    expect(currentRoute()).toBe("lan");
    setNavGuard(() => false);
    navigate("cross");
    expect(currentRoute()).toBe("lan");
  });

  it("proceeds when the guard returns true", () => {
    setNavGuard(() => true);
    navigate("cross");
    expect(currentRoute()).toBe("cross");
  });
});
