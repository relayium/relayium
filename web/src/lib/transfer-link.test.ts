import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseTransferToken,
  buildTransferLink,
  wsURL,
  createTransfer,
} from "./transfer-link";

describe("parseTransferToken", () => {
  it("extracts the token from #t=", () => {
    expect(parseTransferToken("#t=abc123")).toBe("abc123");
  });
  it("returns empty for no hash or other hashes", () => {
    expect(parseTransferToken("")).toBe("");
    expect(parseTransferToken("#")).toBe("");
    expect(parseTransferToken("#other=1")).toBe("");
    expect(parseTransferToken("#t=")).toBe("");
  });
});

describe("buildTransferLink", () => {
  it("puts the token in the fragment", () => {
    expect(buildTransferLink("https://relayium.app", "tok")).toBe(
      "https://relayium.app/#t=tok",
    );
  });
});

describe("wsURL", () => {
  it("uses wss on https and appends room when token present", () => {
    expect(wsURL({ protocol: "https:", host: "relayium.app" }, "tok")).toBe(
      "wss://relayium.app/ws?room=tok",
    );
  });
  it("uses ws on http and omits room when no token", () => {
    expect(wsURL({ protocol: "http:", host: "localhost:8080" }, "")).toBe(
      "ws://localhost:8080/ws",
    );
  });
});

describe("createTransfer", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("POSTs with credentials and returns the parsed body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "tok", expiresAt: 123 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await createTransfer();
    expect(out).toEqual({ token: "tok", expiresAt: 123 });
    expect(fetchMock).toHaveBeenCalledWith("/api/transfers", {
      method: "POST",
      credentials: "include",
    });
  });
  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(createTransfer()).rejects.toThrow("401");
  });
});
