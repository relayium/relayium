// The ICE control plane, both halves.
//
// The first half drives `IceControl` directly: it is a transport, so what is
// asserted is that it forwards faithfully and lets go of what it refuses.
//
// The second half is the one that matters most, and it is why this file exists
// rather than a narrower one. It runs a REAL round trip — a fake server, main's
// bounded reader, the IPC reply shape, the renderer's transport, and the actual
// `fetchIceConfig` from `web/src/lib/ice.ts` — and asserts the verdict is
// identical to what a browser hitting the same server would have produced. That
// is the regression that catches a narrowing pass quietly deleting an answer,
// which is exactly what the first draft of this slice did.

import { describe, expect, it, vi } from "vitest";
import {
  MAX_ICE_REQUESTS_IN_FLIGHT,
  MAX_ICE_REQUESTS_PER_ROOM,
  MAX_ICE_RETRY_AFTER_SECONDS,
  MAX_ICE_ROOMS_PER_DOCUMENT,
} from "../../src/shared/ipc-contract.js";
import {
  IceAdmissionError,
  IceControl,
  IceRequestRegistry,
  narrowIceBody,
} from "../../src/main/net/ice-control.js";
import { createIceTransport } from "../../src/renderer/transport/ice-transport.js";
import { MAX_RESPONSE_BYTES } from "../../src/main/net/transport.js";
import { fetchIceConfig } from "../../../../web/src/lib/ice";

const ORIGIN = "https://relayium.example";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

/** A server that answers once with whatever the test supplies. */
const server = (...responses: Response[]) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new TypeError("fetch failed");
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
};

describe("IceControl addresses one fixed route", () => {
  it("builds the URL from the compiled origin and appends a validated code", async () => {
    const { impl, calls } = server(json({ iceServers: [] }));
    await new IceControl(ORIGIN, impl).read("424242");
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/ice?code=424242`);
  });

  it("omits the query for a LAN read, and still performs one", async () => {
    // LAN is NOT "no ICE fetch". Mac asks with an empty code and is answered
    // STUN-only (`NearbyTransferTests`); skipping the request would silently
    // drop STUN.
    const { impl, calls } = server(json({ iceServers: [{ urls: ["stun:s:3478"] }] }));
    await new IceControl(ORIGIN, impl).read(undefined);
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/ice`);
  });

  it("sends no credential, follows no redirect, and uses GET", async () => {
    const { impl, calls } = server(json({}));
    await new IceControl(ORIGIN, impl).read("424242");
    const init = calls[0]!.init as RequestInit & { headers: Record<string, string> };
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
    expect(init.headers["accept"]).toBe("application/json");
  });

  it("refuses a malformed code without making a request", async () => {
    const { impl, calls } = server(json({}));
    const reply = await new IceControl(ORIGIN, impl).read("42a242");
    expect(reply).toEqual({ ok: false, failure: "refused" });
    expect(calls).toHaveLength(0);
  });

  it("makes exactly ONE request — the retry belongs to the shared module", async () => {
    const { impl, calls } = server(new Response(null, { status: 503 }));
    await new IceControl(ORIGIN, impl).read("424242");
    expect(calls).toHaveLength(1);
  });

  it("names the three no-response outcomes distinctly", async () => {
    const network = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await new IceControl(ORIGIN, network).read("")).toEqual({ ok: false, failure: "network" });

    const redirect = vi.fn(async () => {
      throw new TypeError("unexpected redirect");
    }) as unknown as typeof fetch;
    expect(await new IceControl(ORIGIN, redirect).read("")).toEqual({ ok: false, failure: "redirect" });

    const timeout = vi.fn(async () => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;
    expect(await new IceControl(ORIGIN, timeout).read("")).toEqual({ ok: false, failure: "timeout" });
  });

  it("aborts an in-flight read when its owning room revokes", async () => {
    const controller = new AbortController();
    const impl = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
    ) as unknown as typeof fetch;

    const pending = new IceControl(ORIGIN, impl).read("", controller.signal);
    controller.abort();
    expect(await pending).toEqual({ ok: false, failure: "timeout" });
  });
});

describe("IceControl narrows without dropping answers", () => {
  it("keeps relayDenied, region and stun", () => {
    const body = narrowIceBody({
      iceServers: [{ urls: "turn:t:3478", username: "u", credential: "c" }],
      relays: [
        { id: "eu", region: "eu-west", stun: "stun:eu:3478", iceServers: [{ urls: ["turn:eu:3478"] }] },
      ],
      relayDenied: "quota",
    });
    expect(body).toEqual({
      iceServers: [{ urls: ["turn:t:3478"], username: "u", credential: "c" }],
      relays: [
        { id: "eu", region: "eu-west", stun: "stun:eu:3478", iceServers: [{ urls: ["turn:eu:3478"] }] },
      ],
      relayDenied: "quota",
    });
  });

  it("passes a relayDenied reason this build does not recognise", () => {
    // `relayStatusOf` decides which values mean something. Pre-filtering here
    // would silently delete a reason a newer server introduced.
    expect(narrowIceBody({ relayDenied: "suspended" })?.relayDenied).toBe("suspended");
  });

  it("drops a URL whose scheme an ICE agent cannot use", () => {
    const body = narrowIceBody({
      iceServers: [{ urls: ["javascript:alert(1)", "http://evil", "turn:t:3478"] }],
    });
    expect(body?.iceServers).toEqual([{ urls: ["turn:t:3478"] }]);
  });

  it("drops a relay whose stun URL is not a stun/turn scheme, keeping the relay", () => {
    const body = narrowIceBody({
      relays: [{ id: "eu", stun: "http://evil", iceServers: [{ urls: ["turn:eu:3478"] }] }],
    });
    expect(body?.relays).toEqual([{ id: "eu", iceServers: [{ urls: ["turn:eu:3478"] }] }]);
  });

  it("refuses a body that is not an object", () => {
    expect(narrowIceBody(null)).toBeNull();
    expect(narrowIceBody([])).toBeNull();
    expect(narrowIceBody("nope")).toBeNull();
  });
});

describe("IceControl lets go of bodies it will not read", () => {
  /** A body whose cancellation is observable. */
  const trackedBody = () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    return { stream, cancelled: () => cancelled };
  };

  it("releases the body of a 429 rather than leaving its connection pinned", async () => {
    const tracked = trackedBody();
    const { impl } = server(new Response(tracked.stream, { status: 429 }));
    const reply = await new IceControl(ORIGIN, impl).read("424242");
    expect(reply).toMatchObject({ ok: true, status: 429, body: null });
    expect(tracked.cancelled()).toBe(true);
  });

  it("releases the body when Content-Length declares more than the ceiling", async () => {
    const tracked = trackedBody();
    const { impl } = server(
      new Response(tracked.stream, {
        status: 200,
        headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
      }),
    );
    const reply = await new IceControl(ORIGIN, impl).read("");
    expect(reply).toMatchObject({ ok: true, status: 200, body: null });
    expect(tracked.cancelled()).toBe(true);
  });

  it("stops reading a body that exceeds the ceiling mid-stream", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { impl } = server(new Response(stream, { status: 200 }));
    const reply = await new IceControl(ORIGIN, impl).read("");
    expect(reply).toMatchObject({ ok: true, body: null });
    expect(cancelled).toBe(true);
  });
});

describe("Retry-After is forwarded, bounded, and interpreted by the shared module", () => {
  it("forwards a usable delta-seconds value", async () => {
    const { impl } = server(new Response(null, { status: 503, headers: { "Retry-After": "2" } }));
    const reply = await new IceControl(ORIGIN, impl).read("");
    expect(reply).toMatchObject({ ok: true, status: 503, retryAfterSeconds: 2 });
  });

  it("caps a hostile value rather than passing an unbounded wait", async () => {
    const { impl } = server(
      new Response(null, { status: 503, headers: { "Retry-After": "999999999" } }),
    );
    const reply = await new IceControl(ORIGIN, impl).read("");
    expect(reply).toMatchObject({ retryAfterSeconds: MAX_ICE_RETRY_AFTER_SECONDS });
  });

  it("omits an unparseable or HTTP-date value", async () => {
    const { impl } = server(
      new Response(null, { status: 503, headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" } }),
    );
    const reply = await new IceControl(ORIGIN, impl).read("");
    expect(reply).toEqual({ ok: true, status: 503, body: null });
  });
});

// ---------------------------------------------------------------------------
// The whole path, against the shared classifier
// ---------------------------------------------------------------------------

/** Server → main → IPC → renderer transport → `fetchIceConfig`. */
async function throughWindows(code: string, ...responses: Response[]) {
  const { impl, calls } = server(...responses);
  const control = new IceControl(ORIGIN, impl);
  const transport = createIceTransport({ config: (p) => control.read(p.code) }, code, "room-1");
  return { config: await fetchIceConfig(code, transport), calls };
}

/** The same server answers, read the way a browser would read them. */
async function throughBrowser(code: string, ...responses: Response[]) {
  const { impl } = server(...responses);
  return fetchIceConfig(code, (url) => (impl as unknown as typeof fetch)(url));
}

describe("the Windows path produces the SAME verdict as the browser path", () => {
  const cases: Array<{ name: string; code: string; responses: () => Response[] }> = [
    {
      name: "a healthy code room with a relay pool",
      code: "424242",
      responses: () => [
        json({
          iceServers: [{ urls: ["stun:s:3478"] }],
          relays: [{ id: "eu", region: "eu-west", iceServers: [{ urls: ["turn:eu:3478"], username: "u", credential: "c" }] }],
        }),
      ],
    },
    {
      name: "a quota denial",
      code: "424242",
      responses: () => [json({ relayDenied: "quota" }, { status: 403 })],
    },
    {
      name: "an unverified denial",
      code: "424242",
      responses: () => [json({ relayDenied: "unverified" }, { status: 403 })],
    },
    {
      name: "rate limiting",
      code: "424242",
      responses: () => [new Response(null, { status: 429 })],
    },
    {
      name: "a code room the deployment issued no TURN for",
      code: "424242",
      responses: () => [json({ iceServers: [{ urls: ["stun:s:3478"] }], relays: [] })],
    },
    {
      name: "a LAN room, answered STUN-only",
      code: "",
      responses: () => [json({ iceServers: [{ urls: ["stun:s:3478"] }] })],
    },
    {
      name: "a proxy serving HTML for /api/*",
      code: "",
      responses: () => [new Response("<!doctype html>", { status: 200 })],
    },
  ];

  for (const testCase of cases) {
    it(`agrees on ${testCase.name}`, async () => {
      const windows = await throughWindows(testCase.code, ...testCase.responses());
      const browser = await throughBrowser(testCase.code, ...testCase.responses());
      expect(windows.config).toEqual(browser);
    });
  }

  it("keeps rate limiting distinct from unavailable — the case the first draft lost", async () => {
    const limited = await throughWindows("424242", new Response(null, { status: 429 }));
    const dead = await throughWindows("424242");
    expect(limited.config.relayStatus).toBe("ratelimited");
    expect(dead.config.relayStatus).toBe("unavailable");
    expect(limited.config.relayStatus).not.toBe(dead.config.relayStatus);
    // And a 429 is answered without spending the user's next token.
    expect(limited.calls).toHaveLength(1);
  });

  it("retries a 5xx through main exactly once, driven by the shared module", async () => {
    const result = await throughWindows(
      "",
      new Response(null, { status: 503, headers: { "Retry-After": "0" } }),
      json({ iceServers: [{ urls: ["stun:s:3478"] }] }),
    );
    expect(result.calls).toHaveLength(2);
    expect(result.config.relayStatus).toBe("ok");
  });

  it("never invents a third-party STUN when the endpoint is unreadable", async () => {
    const result = await throughWindows("424242");
    expect(result.config.iceServers).toEqual([]);
    expect(result.config.relays).toEqual([]);
  });
});

describe("the renderer transport is bound to one request", () => {
  it("refuses a URL that is not the one its code would have produced", async () => {
    const transport = createIceTransport(
      { config: async () => ({ ok: true, status: 200, body: {} }) },
      "424242",
      "room-1",
    );
    await expect(transport("/api/ice")).rejects.toThrow(/bound to a different request/);
    await expect(transport("https://evil.example/api/ice?code=424242")).rejects.toThrow();
    await expect(transport("/api/ice?code=424242")).resolves.toBeInstanceOf(Response);
  });

  it("never asks main for a URL — only for a code, under its room", async () => {
    const config = vi.fn(async () => ({ ok: true as const, status: 200, body: {} }));
    await createIceTransport({ config }, "424242", "room-1")("/api/ice?code=424242");
    expect(config).toHaveBeenCalledWith({ owner: "room-1", code: "424242" });
    await createIceTransport({ config }, "", "room-2")("/api/ice");
    expect(config).toHaveBeenLastCalledWith({ owner: "room-2" });
  });
});


// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------
//
// Both cases below were REPRODUCED against the previous implementation before
// this one existed — see `ice-admission-repro.mjs`, which replicates that
// algorithm verbatim and shows 500 concurrent privileged requests admitted
// under a cap that reads as two, plus an aborted request's cleanup deleting the
// live replacement group.

describe("ICE admission bounds the actual resource", () => {
  it("does not let a renderer-chosen owner name buy unlimited requests", () => {
    const registry = new IceRequestRegistry();
    const leases = [];
    let refusals = 0;
    // The exact attack: vary `owner` each invoke.
    for (let i = 0; i < 500; i += 1) {
      try {
        leases.push(registry.admit(0, `owner-${i}`));
      } catch (err) {
        expect(err).toBeInstanceOf(IceAdmissionError);
        refusals += 1;
      }
    }
    expect(refusals).toBeGreaterThan(0);
    // Bounded by the number of ROOMS a document may have, not by the number of
    // names it can invent.
    expect(registry.roomCount(0)).toBeLessThanOrEqual(MAX_ICE_ROOMS_PER_DOCUMENT);
    expect(registry.inFlight).toBeLessThanOrEqual(MAX_ICE_REQUESTS_IN_FLIGHT);
  });

  it("still lets one document hold both of its rooms", () => {
    const registry = new IceRequestRegistry();
    expect(() => registry.admit(0, "lan")).not.toThrow();
    expect(() => registry.admit(0, "code")).not.toThrow();
    expect(registry.roomCount(0)).toBe(2);
  });

  it("caps one room so it cannot starve the other", () => {
    const registry = new IceRequestRegistry();
    for (let i = 0; i < MAX_ICE_REQUESTS_PER_ROOM; i += 1) registry.admit(0, "lan");
    expect(() => registry.admit(0, "lan")).toThrow(IceAdmissionError);
    // The other room is unaffected.
    expect(() => registry.admit(0, "code")).not.toThrow();
  });

  it("caps the global unsettled count across documents", () => {
    const registry = new IceRequestRegistry();
    let admitted = 0;
    for (let generation = 0; generation < 20; generation += 1) {
      for (const owner of ["lan", "code"]) {
        for (let i = 0; i < MAX_ICE_REQUESTS_PER_ROOM; i += 1) {
          try {
            registry.admit(generation, owner);
            admitted += 1;
          } catch {
            /* refused */
          }
        }
      }
    }
    expect(admitted).toBe(MAX_ICE_REQUESTS_IN_FLIGHT);
    expect(registry.inFlight).toBe(MAX_ICE_REQUESTS_IN_FLIGHT);
  });

  it("frees capacity at SETTLEMENT, not at abort", () => {
    const registry = new IceRequestRegistry();
    const lease = registry.admit(0, "lan");
    expect(registry.inFlight).toBe(1);

    // An abort asks a connection to end; it does not end it. Freeing capacity
    // here is how a fault that aborts in a loop keeps every connection while
    // the ledger reports none.
    registry.abortRoom(0, "lan");
    expect(lease.signal.aborted).toBe(true);
    expect(registry.inFlight).toBe(1);

    lease.release();
    expect(registry.inFlight).toBe(0);
  });

  it("does not let an aborted request's release delete the live replacement", () => {
    const registry = new IceRequestRegistry();
    const stale = registry.admit(0, "lan");

    // The room's socket retires while its read is still unsettled.
    registry.abortRoom(0, "lan");
    // It reconnects and issues a fresh read under the same owner name.
    const fresh = registry.admit(0, "lan");
    expect(registry.roomCount(0)).toBe(1);

    // The OLD request finally settles. Releasing by NAME would delete the live
    // group here, leaving the live request untracked and its controller
    // unreachable — a request nothing could ever abort again.
    stale.release();

    expect(registry.roomCount(0)).toBe(1);
    expect(registry.inFlight).toBe(1);
    // And the live request is still reachable by an abort.
    registry.abortRoom(0, "lan");
    expect(fresh.signal.aborted).toBe(true);
  });

  it("releases only once however many times it is called", () => {
    const registry = new IceRequestRegistry();
    const lease = registry.admit(0, "lan");
    lease.release();
    lease.release();
    expect(registry.inFlight).toBe(0);
  });

  it("aborts one room without touching the other", () => {
    const registry = new IceRequestRegistry();
    const lan = registry.admit(0, "lan");
    const code = registry.admit(0, "code");
    registry.abortRoom(0, "lan");
    expect(lan.signal.aborted).toBe(true);
    expect(code.signal.aborted).toBe(false);
  });

  it("aborts a whole document without touching a later one", () => {
    const registry = new IceRequestRegistry();
    const stale = registry.admit(0, "lan");
    const fresh = registry.admit(1, "lan");
    registry.abortDocument(0);
    expect(stale.signal.aborted).toBe(true);
    expect(fresh.signal.aborted).toBe(false);
  });

  it("aborts everything on teardown", () => {
    const registry = new IceRequestRegistry();
    const a = registry.admit(0, "lan");
    const b = registry.admit(1, "code");
    registry.abortAll();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
  });

  it("reclaims a room's slot once its requests settle", () => {
    const registry = new IceRequestRegistry();
    const first = registry.admit(0, "room-a");
    const second = registry.admit(0, "room-b");
    expect(() => registry.admit(0, "room-c")).toThrow(IceAdmissionError);

    first.release();
    second.release();
    expect(registry.roomCount(0)).toBe(0);
    expect(() => registry.admit(0, "room-c")).not.toThrow();
  });
});
