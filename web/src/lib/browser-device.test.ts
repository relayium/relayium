import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserDeviceError, ensureBrowserDevice } from "./browser-device";

afterEach(() => vi.unstubAllGlobals());

describe("browser sender identity", () => {
  it("asks the authenticated endpoint without exposing or persisting a bearer", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      deviceId: "a".repeat(32), created: true,
    }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    await ensureBrowserDevice();
    expect(fetcher).toHaveBeenCalledWith("/api/devices/browser-install", expect.objectContaining({
      method: "POST", credentials: "include", body: "{}",
    }));
    const request = JSON.stringify(fetcher.mock.calls[0]);
    expect(request).not.toContain("rlm_web_");
    expect(request).not.toContain("access_token");
  });

  it("preserves actionable closed reasons and sanitizes every other refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "browser_device_revoked", detail: "secret" }),
      { status: 409, headers: { "content-type": "application/json" } },
    )));
    await expect(ensureBrowserDevice()).rejects.toEqual(
      expect.objectContaining<Partial<BrowserDeviceError>>({ code: "browser_device_revoked" }),
    );

    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "browser_device_limit", detail: "secret" }),
      { status: 409, headers: { "content-type": "application/json" } },
    )));
    await expect(ensureBrowserDevice()).rejects.toEqual(
      expect.objectContaining<Partial<BrowserDeviceError>>({ code: "browser_device_limit" }),
    );

    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "provider_internal_secret" }),
      { status: 500, headers: { "content-type": "application/json" } },
    )));
    await expect(ensureBrowserDevice()).rejects.toEqual(
      expect.objectContaining<Partial<BrowserDeviceError>>({ code: "unavailable" }),
    );
  });
});
