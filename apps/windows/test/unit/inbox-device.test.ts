// The one authenticated request the Inbox host makes outside `src/main/inbox/**`.
//
// It carries a bearer, so the assertions that matter are about where it may go
// and what it will believe: the pinned origin, the refusal to follow a
// redirect, the bounded body, and the rule that a "current" row which cannot
// name its device is malformed rather than something to skip past.

import { describe, expect, it } from "vitest";
import { DeviceLookupError, resolveCurrentDevice } from "../../src/main/features/inbox-device.js";

const ORIGIN = "https://relayium.com";

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

async function lookup(fetchImpl: typeof fetch, origin = ORIGIN) {
  return resolveCurrentDevice({
    origin,
    bearer: "bearer-value",
    signal: new AbortController().signal,
    fetchImpl,
  });
}

describe("resolving this installation's device row", () => {
  it("returns the row central marks current", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const device = await lookup((async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return reply({
        devices: [
          { ID: "other", Name: "A phone", Current: false },
          { ID: "this-one", Name: "A PC", Current: true },
        ],
      });
    }) as unknown as typeof fetch);

    expect(device).toEqual({ id: "this-one", name: "A PC" });
    expect(seen.url).toBe(`${ORIGIN}/api/devices`);
    // The bearer travels in a header, and the request refuses to be redirected
    // off this origin — a redirect is how a credential reaches another host.
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer bearer-value");
    expect(seen.init?.redirect).toBe("error");
  });

  it("accepts a device that has never been named", async () => {
    const device = await lookup((async () =>
      reply({ devices: [{ ID: "this-one", Current: true }] })) as unknown as typeof fetch);
    expect(device).toEqual({ id: "this-one", name: "" });
  });

  it("refuses a URL that would leave this build's origin", async () => {
    await expect(
      lookup((async () => reply({ devices: [] })) as unknown as typeof fetch, "not a url"),
    ).rejects.toMatchObject({ code: "origin-refused" });
  });

  it("reports an unusable credential as its own failure, not as a network blip", async () => {
    // The distinction is what stops the scheduler retrying on a timer: no
    // amount of backoff fixes a bearer the server will not accept.
    await expect(
      lookup((async () => reply({}, 401)) as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("says not-enrolled when no row is this installation's", async () => {
    await expect(
      lookup((async () =>
        reply({ devices: [{ ID: "other", Current: false }] })) as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "not-enrolled" });
  });

  it("refuses a current row that cannot name its device", async () => {
    // NOT "keep looking": a second current row would then be adopted as this
    // installation's, which is exactly the substitution to refuse.
    await expect(
      lookup((async () =>
        reply({
          devices: [
            { ID: "", Current: true },
            { ID: "attacker", Current: true },
          ],
        })) as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "malformed" });
  });

  it("refuses a list longer than any real account has", async () => {
    const devices = Array.from({ length: 513 }, (_, i) => ({ ID: `d${String(i)}`, Current: false }));
    await expect(
      lookup((async () => reply({ devices })) as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "malformed" });
  });

  it("refuses a body larger than the ceiling, by counting rather than by trusting", async () => {
    // The declared length says 1; the actual body is far past the bound. The
    // counted read is the real limit, which is the whole point of it.
    const huge = "x".repeat(300 * 1024);
    const response = new Response(JSON.stringify({ devices: [], pad: huge }), {
      status: 200,
      headers: { "content-length": "1" },
    });
    await expect(
      lookup((async () => response) as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "too-large" });
  });

  it("reports a redirect as an origin refusal rather than an ordinary failure", async () => {
    await expect(
      lookup((async () => {
        throw new TypeError("failed to fetch: redirect count exceeded");
      }) as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "origin-refused" });
  });

  it("is a typed error, so a caller can branch on it", async () => {
    const error = await lookup((async () => reply({}, 401)) as unknown as typeof fetch).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(DeviceLookupError);
  });
});
