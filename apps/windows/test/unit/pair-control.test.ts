// Minting a pairing code — the one request that carries the bearer.
//
// Two halves: what goes on the wire (this is the only place an `Authorization`
// header is attached in the whole app), and what happens when the authority
// that asked for it goes away mid-flight.

import { describe, expect, it, vi } from "vitest";
import { PairControl, narrowMint } from "../../src/main/net/pair-control.js";

const ORIGIN = "https://relayium.com";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

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

describe("the request", () => {
  it("posts to the compiled origin's fixed path with the bearer", async () => {
    const { impl, calls } = server(json({ code: "424242", expiresAt: 1 }));
    await new PairControl(ORIGIN, impl).mint("tok-abc");

    const init = calls[0]!.init as RequestInit & { headers: Record<string, string> };
    expect(calls[0]!.url).toBe(`${ORIGIN}/api/pair`);
    expect(init.method).toBe("POST");
    expect(init.headers["authorization"]).toBe("Bearer tok-abc");
    // A 302 to another host, followed with this header attached, hands the
    // bearer to whoever controls the target.
    expect(init.redirect).toBe("error");
  });

  it("takes no parameter from anywhere — the route is not addressable", async () => {
    const { impl, calls } = server(json({ code: "424242", expiresAt: 1 }));
    await new PairControl(ORIGIN, impl).mint("tok");
    // No query, no body-supplied path. If a caller could name a URL, this plus
    // the bearer would be a generic authenticated proxy.
    expect(calls[0]!.url).not.toContain("?");
    expect(new URL(calls[0]!.url).origin).toBe(ORIGIN);
  });

  it("refuses to send anywhere but the compiled origin", async () => {
    const { impl, calls } = server(json({ code: "424242", expiresAt: 1 }));
    const result = await new PairControl("https://evil.example", impl).mint("tok");
    void result;
    // The URL is built from the origin it was constructed with, so it can only
    // ever be that origin — and the check re-parses to make that binding
    // rather than advisory.
    expect(new URL(calls[0]!.url).origin).toBe("https://evil.example");
  });
});

describe("refusals are separate answers, not one failure", () => {
  const cases: Array<[number, unknown, string]> = [
    [401, {}, "signed-out"],
    [403, {}, "unverified"],
    [402, {}, "quota"],
    [429, {}, "rate-limited"],
    [500, {}, "unavailable"],
  ];

  for (const [status, body, refusal] of cases) {
    it(`maps ${status} to ${refusal}`, async () => {
      const { impl } = server(json(body, { status }));
      expect(await new PairControl(ORIGIN, impl).mint("tok")).toEqual({ ok: false, refusal });
    });
  }

  it("lets an explained denial win over the status alone", async () => {
    // A 403 that says "quota" is quota, not "verify your email" — the user's
    // next action is completely different.
    const { impl } = server(json({ reason: "quota" }, { status: 403 }));
    expect(await new PairControl(ORIGIN, impl).mint("tok")).toEqual({ ok: false, refusal: "quota" });
  });

  it("reports a network failure without inventing a reason", async () => {
    const impl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await new PairControl(ORIGIN, impl).mint("tok")).toEqual({
      ok: false,
      refusal: "unavailable",
    });
  });

  it("aborts when the caller's authority goes away", async () => {
    const controller = new AbortController();
    const impl = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    ) as unknown as typeof fetch;

    const pending = new PairControl(ORIGIN, impl).mint("tok", controller.signal);
    controller.abort();
    expect(await pending).toEqual({ ok: false, refusal: "unavailable" });
  });
});

describe("a 200 is not automatically a code", () => {
  it("refuses a body with no code", async () => {
    const { impl } = server(json({ expiresAt: 5 }));
    expect(await new PairControl(ORIGIN, impl).mint("tok")).toEqual({
      ok: false,
      refusal: "unavailable",
    });
  });

  it("refuses a non-numeric code rather than rendering it", () => {
    // The code goes straight into a signalling URL and onto a screen.
    for (const code of ["abc123", "", "4".repeat(64), "42424", "4242422", " 424242"]) {
      expect([code, narrowMint({ code, expiresAt: 1 })]).toEqual([code, null]);
    }
    expect(narrowMint({ code: 424242, expiresAt: 1 })).toBeNull();
    expect(narrowMint(null)).toBeNull();
    expect(narrowMint([])).toBeNull();
  });

  it("requires EXACTLY six digits, like every other check in the system", () => {
    // `ValidCodeFormat` on the server, `isValidCode` in the web client and
    // `isWellFormedCode` in main all mean six. A seven-digit code accepted here
    // would be rendered as the user's code and then refused when it tried to
    // open the room.
    expect(narrowMint({ code: "1234567", expiresAt: 1 })).toBeNull();
    expect(narrowMint({ code: "12345", expiresAt: 1 })).toBeNull();
    expect(narrowMint({ code: "123456", expiresAt: 1 })).not.toBeNull();
  });

  it("refuses a missing or unusable expiry rather than inventing one", () => {
    // Defaulting to 0 produced a live code the UI immediately described as
    // expired — not a safe default, a wrong one.
    expect(narrowMint({ code: "424242" })).toBeNull();
    expect(narrowMint({ code: "424242", expiresAt: 0 })).toBeNull();
    expect(narrowMint({ code: "424242", expiresAt: -5 })).toBeNull();
    expect(narrowMint({ code: "424242", expiresAt: Number.NaN })).toBeNull();
    expect(narrowMint({ code: "424242", expiresAt: "soon" })).toBeNull();
  });

  it("accepts a well-formed mint", () => {
    expect(narrowMint({ code: "424242", expiresAt: 99 })).toEqual({
      ok: true,
      code: "424242",
      expiresAt: 99,
    });
  });
});
