import { describe, it, expect, vi, afterEach } from "vitest";
import { chooseRtcConfig, fetchIceConfig, MAX_FALLBACK_RELAYS, type RelayEntry } from "./ice";

const STUN_ONLY = [{ urls: "stun:relay.example:3478" }];
const LEGACY_TURN = { urls: ["turn:legacy.example:3478"], username: "u", credential: "c" };

const relay = (id: string): RelayEntry => ({
  id,
  iceServers: [{ urls: [`turn:${id}.example:3478`], username: `u-${id}`, credential: `c-${id}` }],
});

const turnUrls = (servers: RTCIceServer[]): string[] =>
  servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])).filter((u) => u.startsWith("turn"));

describe("chooseRtcConfig", () => {
  it("uses only the agreed relay, relay-only, once one has been picked", () => {
    const relays = [relay("tok"), relay("fra")];
    const cfg = chooseRtcConfig({ iceServers: [...STUN_ONLY, LEGACY_TURN], relays }, "fra");
    expect(cfg.iceTransportPolicy).toBe("relay");
    expect(turnUrls(cfg.iceServers)).toEqual(["turn:fra.example:3478"]);
  });

  // THE REGRESSION. A deployment that serves relays through the pool — every
  // "only my nodes" user, and any fleet-only deployment — has NO top-level TURN.
  // The old fallback asked hasTurnServer(iceServers), saw STUN only, dropped the
  // whole pool and returned policy "all" with nothing but STUN. Across networks
  // that cannot connect at all: ICE sits in "checking", the card sits at 0%, and
  // 30s later it says "connection failed". A phone falls into this bucket far
  // more often than a desktop, because it is the RTT probe timing out that
  // leaves selectedRelayId null.
  it("still relays when no relay was picked and the pool is the only source of TURN", () => {
    const relays = [relay("tok"), relay("fra")];
    const cfg = chooseRtcConfig({ iceServers: STUN_ONLY, relays }, null);
    expect(cfg.iceTransportPolicy).toBe("relay");
    expect(turnUrls(cfg.iceServers)).toEqual([
      "turn:tok.example:3478",
      "turn:fra.example:3478",
    ]);
  });

  it("unions the legacy entry with the pool rather than choosing between them", () => {
    const cfg = chooseRtcConfig({ iceServers: [...STUN_ONLY, LEGACY_TURN], relays: [relay("tok")] }, null);
    expect(turnUrls(cfg.iceServers)).toEqual(["turn:legacy.example:3478", "turn:tok.example:3478"]);
  });

  // A selection naming a relay that is no longer in the pool (room switched, the
  // node went offline between the measurement and the transfer) must fall into
  // the union, not silently produce a config with no relay in it.
  it("falls back to the union when the selected id is not in the pool", () => {
    const cfg = chooseRtcConfig({ iceServers: STUN_ONLY, relays: [relay("tok")] }, "gone");
    expect(cfg.iceTransportPolicy).toBe("relay");
    expect(turnUrls(cfg.iceServers)).toEqual(["turn:tok.example:3478"]);
  });

  it("bounds how many pool relays the fallback allocates against", () => {
    const relays = Array.from({ length: MAX_FALLBACK_RELAYS + 3 }, (_, i) => relay(`r${i}`));
    const cfg = chooseRtcConfig({ iceServers: [], relays }, null);
    expect(turnUrls(cfg.iceServers)).toHaveLength(MAX_FALLBACK_RELAYS);
  });

  // The cap exists to bound abuse, not to trim a real deployment. Production
  // advertises five; a cap at or below that would drop a relay that works —
  // possibly the only one that works — for the exact users this fallback is for.
  it("keeps every relay of a production-sized pool", () => {
    const relays = Array.from({ length: 5 }, (_, i) => relay(`prod${i}`));
    const cfg = chooseRtcConfig({ iceServers: [], relays }, null);
    expect(turnUrls(cfg.iceServers)).toHaveLength(5);
  });

  // LAN is the case that must NOT change: no code means no relay, and forcing
  // relay-only there would leave zero candidates on a network that works fine.
  it("keeps policy 'all' when there is no TURN anywhere (LAN)", () => {
    const cfg = chooseRtcConfig({ iceServers: STUN_ONLY, relays: [] }, null);
    expect(cfg.iceTransportPolicy).toBeUndefined();
    expect(cfg.iceServers).toEqual(STUN_ONLY);
  });

  it("keeps policy 'all' for an empty config (the /api/ice-failed fallback)", () => {
    const cfg = chooseRtcConfig({ iceServers: [], relays: [] }, null);
    expect(cfg.iceTransportPolicy).toBeUndefined();
    expect(cfg.iceServers).toEqual([]);
  });
});

describe("fetchIceConfig relay status", () => {
  afterEach(() => vi.unstubAllGlobals());

  const okBody = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
  const errBody = (status: number, body?: unknown, headers?: Record<string, string>) => ({
    ok: false,
    status,
    headers: new Headers(headers),
    json: async () => {
      if (body === undefined) throw new SyntaxError("not JSON");
      return body;
    },
  });

  it("reports ok when a code room was issued a relay", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okBody({ iceServers: [STUN_ONLY[0], LEGACY_TURN] })));
    expect((await fetchIceConfig("483920")).relayStatus).toBe("ok");
  });

  it("reports ok when the relay arrives only through the pool", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okBody({ iceServers: STUN_ONLY, relays: [relay("tok")] })));
    expect((await fetchIceConfig("483920")).relayStatus).toBe("ok");
  });

  // LAN legitimately has no relay; calling that a fault would put a scary banner
  // on the one flow that never needed a relay in the first place.
  it("reports ok for a LAN request with no code and no relay", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okBody({ iceServers: STUN_ONLY })));
    expect((await fetchIceConfig("")).relayStatus).toBe("ok");
  });

  it("passes through the server's own reason for withholding a relay", async () => {
    for (const denied of ["quota", "unverified"] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okBody({ iceServers: STUN_ONLY, relayDenied: denied })));
      expect((await fetchIceConfig("483920")).relayStatus).toBe(denied);
      vi.unstubAllGlobals();
    }
  });

  it("reports none when a code room came back with no relay and no reason", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okBody({ iceServers: STUN_ONLY })));
    expect((await fetchIceConfig("483920")).relayStatus).toBe("none");
  });

  // /api/ice is 5/min/IP and a phone on a carrier CGNAT shares its public IP
  // with strangers, so a 429 here is not exotic. Two things must hold: it is
  // named rather than looking like a normal LAN response, and it is NOT retried
  // — an immediate second request spends the user's next token and makes the
  // limit they are already hitting worse.
  it("does not retry a rate limit, and says so", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errBody(429));
    vi.stubGlobal("fetch", fetchMock);
    const cfg = await fetchIceConfig("483920");
    expect(cfg.relayStatus).toBe("ratelimited");
    expect(cfg.iceServers).toEqual([]); // never a third-party STUN — see FALLBACK
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a network error", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network error"))
      .mockResolvedValueOnce(okBody({ iceServers: [STUN_ONLY[0], LEGACY_TURN] }));
    vi.stubGlobal("fetch", fetchMock);
    const cfg = await fetchIceConfig("483920");
    expect(cfg.relayStatus).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errBody(503))
      .mockResolvedValueOnce(okBody({ iceServers: [STUN_ONLY[0], LEGACY_TURN] }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchIceConfig("483920")).relayStatus).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // A deliberate denial is an answer. Repeating it wastes a rate-limit token
  // and, worse, would report "unavailable" over a reason the UI can explain.
  it("keeps a denial's specific reason and does not retry it", async () => {
    for (const denied of ["quota", "unverified"] as const) {
      const fetchMock = vi.fn().mockResolvedValue(errBody(403, { relayDenied: denied }));
      vi.stubGlobal("fetch", fetchMock);
      expect((await fetchIceConfig("483920")).relayStatus).toBe(denied);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    }
  });

  it("does not retry a 4xx it cannot explain", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errBody(400));
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchIceConfig("483920")).relayStatus).toBe("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A 200 carrying index.html — a misconfigured proxy. Repeating it cannot help.
  it("does not retry a 200 whose body is not JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers(),
      json: async () => { throw new SyntaxError("Unexpected token <"); },
    });
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchIceConfig("483920")).relayStatus).toBe("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits exactly as long as a short Retry-After asks", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(errBody(503, undefined, { "Retry-After": "3" }))
        .mockResolvedValueOnce(okBody({ iceServers: [STUN_ONLY[0], LEGACY_TURN] }));
      vi.stubGlobal("fetch", fetchMock);
      const pending = fetchIceConfig("483920");
      await vi.advanceTimersByTimeAsync(2_500);
      expect(fetchMock).toHaveBeenCalledTimes(1); // the default 1.2s backoff would already have fired
      await vi.advanceTimersByTimeAsync(600);
      expect((await pending).relayStatus).toBe("ok");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // "Come back in an hour" is an answer. Waiting it out would freeze the session
  // on a request nobody is going to succeed at.
  it("does not retry at all when Retry-After is long", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errBody(503, undefined, { "Retry-After": "3600" }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchIceConfig("483920")).relayStatus).toBe("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
