import { describe, expect, it } from "vitest";
import { BoundedTransport, MAX_RESPONSE_BYTES } from "../../src/main/net/transport.js";

const ORIGIN = "https://relayium.com";

const respondWith = (body: string, init: ResponseInit = {}): typeof fetch =>
  (async () => new Response(body, { status: 200, ...init })) as unknown as typeof fetch;

describe("origin binding", () => {
  it("refuses a URL that is not this build's origin", async () => {
    const t = new BoundedTransport(ORIGIN, respondWith("{}"));
    await expect(t.postJSON("https://evil.example/api/cli/device/poll", {})).rejects.toMatchObject({
      code: "bad-url",
    });
  });

  it("refuses a value that is not a URL at all", async () => {
    const t = new BoundedTransport(ORIGIN, respondWith("{}"));
    await expect(t.postJSON("/api/cli/device/poll", {})).rejects.toMatchObject({ code: "bad-url" });
  });
});

describe("redirects", () => {
  // Following a 302 to another host with an Authorization header attached hands
  // the bearer to whoever controls the target — and would report success.
  it("never follows one", async () => {
    let seen: RequestInit | undefined;
    const t = new BoundedTransport(ORIGIN, (async (_u: string, init: RequestInit) => {
      seen = init;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);
    await t.postJSON(`${ORIGIN}/api/cli/device/start`, undefined);
    expect(seen?.redirect).toBe("error");
  });
});

describe("bounds", () => {
  it("refuses a body larger than the ceiling", async () => {
    const huge = "x".repeat(MAX_RESPONSE_BYTES + 10);
    const t = new BoundedTransport(ORIGIN, respondWith(huge));
    await expect(t.postJSON(`${ORIGIN}/api/cli/device/start`, undefined)).rejects.toMatchObject({
      code: "too-large",
    });
  });

  it("refuses on a declared length over the ceiling without reading the body", async () => {
    const t = new BoundedTransport(
      ORIGIN,
      respondWith("{}", { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }),
    );
    await expect(t.postJSON(`${ORIGIN}/api/cli/device/start`, undefined)).rejects.toMatchObject({
      code: "too-large",
    });
  });

  it("carries a deadline on every request", async () => {
    let seen: RequestInit | undefined;
    const t = new BoundedTransport(ORIGIN, (async (_u: string, init: RequestInit) => {
      seen = init;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);
    await t.postJSON(`${ORIGIN}/api/cli/device/start`, undefined);
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a timeout distinctly from a network failure", async () => {
    const t = new BoundedTransport(ORIGIN, (async () => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch);
    await expect(t.postJSON(`${ORIGIN}/api/cli/device/start`, undefined)).rejects.toMatchObject({
      code: "timeout",
    });
  });
});

describe("parsing", () => {
  it("returns the status even when the body is not JSON", async () => {
    const t = new BoundedTransport(ORIGIN, respondWith("not json", { status: 429 }));
    await expect(t.postJSON(`${ORIGIN}/api/cli/device/start`, undefined)).resolves.toEqual({
      status: 429,
      body: undefined,
    });
  });
});
