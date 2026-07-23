import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchIceConfig, fetchIceServers, hasTurnServer, pickRelay } from "./ice";

// 服务端下发什么就是什么的夹具。故意不写成公共 STUN 的地址——那会让人以为
// 代码里还有一个第三方默认值。
const STUN = [{ urls: "stun:relay.example:3478" }];
// /api/ice 挂掉时回落到**空列表**，不是公共 STUN —— 见 ice.ts 的注释。
const FALLBACK_STUN: never[] = [];

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

  it("falls back to an empty list (never a third-party STUN) on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const out = await fetchIceServers("424242");
    expect(out).toEqual(FALLBACK_STUN);
  });

  it("falls back to an empty list when a 200 body isn't JSON (e.g. nginx serves index.html)", async () => {
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
    expect(out).toEqual(FALLBACK_STUN);
  });

  it("falls back to an empty list when the fetch itself rejects (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const out = await fetchIceServers("424242");
    expect(out).toEqual(FALLBACK_STUN);
  });
});

describe("fetchIceConfig relayDenied", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes through relayDenied when the server withholds TURN over the cap", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ iceServers: STUN, relays: [], relayDenied: "quota" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = await fetchIceConfig("424242");
    expect(cfg.relayDenied).toBe("quota");
    expect(cfg.iceServers).toEqual(STUN);
  });

  it("leaves relayDenied undefined when the server does not send it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ iceServers: STUN, relays: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = await fetchIceConfig("424242");
    expect(cfg.relayDenied).toBeUndefined();
  });

  it("leaves relayDenied undefined on a fallback (non-ok / network error)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = await fetchIceConfig("424242");
    expect(cfg.relayDenied).toBeUndefined();
    expect(cfg.iceServers).toEqual(FALLBACK_STUN);
  });
});

describe("hasTurnServer", () => {
  it("is false for a STUN-only list (LAN / no pairing code)", () => {
    expect(hasTurnServer(STUN)).toBe(false);
    expect(hasTurnServer([])).toBe(false);
  });

  it("is true when a turn: or turns: URL is present", () => {
    expect(hasTurnServer([{ urls: ["turn:t:3478"], username: "u", credential: "c" }])).toBe(true);
    expect(hasTurnServer([{ urls: "turns:t:5349", username: "u", credential: "c" }])).toBe(true);
    // Mixed STUN + TURN (the real /api/ice code-room response) still counts.
    expect(hasTurnServer([{ urls: "stun:s:3478" }, { urls: ["turn:t:3478"] }])).toBe(true);
  });

  it("does not mistake a stun: URL that merely contains 'turn' hostname parts", () => {
    expect(hasTurnServer([{ urls: "stun:saturn.example.com:3478" }])).toBe(false);
  });
});

describe("pickRelay", () => {
  it("minimises the worse of the two peers' RTTs", () => {
    // tok: max(30,200)=200; la: max(180,40)=180 → la wins (better worst-case leg).
    const mine = { tok: 30, la: 180 };
    const theirs = { tok: 200, la: 40 };
    expect(pickRelay(mine, theirs)).toBe("la");
  });

  it("only considers relays both peers measured", () => {
    // sg is fastest for me but the peer never measured it → ineligible.
    expect(pickRelay({ sg: 10, tok: 90 }, { tok: 95 })).toBe("tok");
    expect(pickRelay({ sg: 10 }, { tok: 95 })).toBeNull();
    expect(pickRelay({}, {})).toBeNull();
  });

  it("is symmetric — both peers derive the same id from swapped inputs", () => {
    const a = { tok: 30, la: 180, fra: 90 };
    const b = { tok: 200, la: 40, fra: 95 };
    expect(pickRelay(a, b)).toBe(pickRelay(b, a));
  });

  it("breaks ties on worst-case by sum, then by id (stable on both sides)", () => {
    // Both have max 100; tok sum=150 < la sum=200 → tok.
    expect(pickRelay({ tok: 100, la: 100 }, { tok: 50, la: 100 })).toBe("tok");
    // Identical worst-case AND sum → lowest id, same on both sides.
    expect(pickRelay({ b: 100, a: 100 }, { b: 100, a: 100 })).toBe("a");
  });
});
