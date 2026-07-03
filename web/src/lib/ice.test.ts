import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchIceServers } from "./ice";

const STUN = [{ urls: "stun:stun.l.google.com:19302" }];

describe("fetchIceServers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests /api/ice with ?code= for a pairing code and returns the list", async () => {
    const servers = [
      { urls: ["stun:s:3478"] },
      { urls: ["turn:t:3478"], username: "u", credential: "c" },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ iceServers: servers }) });
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchIceServers("424242");
    expect(out).toEqual(servers);
    expect(fetchMock).toHaveBeenCalledWith("/api/ice?code=424242", {
      credentials: "include",
    });
  });

  it("omits the query when no code", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ iceServers: STUN }) });
    vi.stubGlobal("fetch", fetchMock);

    await fetchIceServers("");
    expect(fetchMock).toHaveBeenCalledWith("/api/ice", { credentials: "include" });
  });

  it("falls back to a STUN entry on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const out = await fetchIceServers("424242");
    expect(out).toEqual(STUN);
  });

  it("falls back to STUN when a 200 body isn't JSON (e.g. nginx serves index.html)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      }),
    );
    const out = await fetchIceServers("424242");
    expect(out).toEqual(STUN);
  });

  it("falls back to STUN when the fetch itself rejects (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const out = await fetchIceServers("424242");
    expect(out).toEqual(STUN);
  });
});
