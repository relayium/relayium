import { describe, expect, it } from "vitest";
import { UploadTransport } from "../../src/main/stored/upload/transport.js";

describe("server-bound upload finalization recovery", () => {
  it("uses exactly the opt-in request and only accepts the named server object", async () => {
    const seen: RequestInit[] = [];
    const transport = new UploadTransport("https://relayium.com", "synthetic-bearer", {
      fetchImpl: (async (_url, init) => {
        seen.push(init!);
        return new Response(JSON.stringify({ id: "object-1", expiresAt: 1800000000, recovered: true }), { status: 200 });
      }) as typeof fetch,
    });
    expect(await transport.finalizeRecoverable("session-1")).toEqual({ outcome: "finalized", id: "object-1", expiresAt: 1800000000 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toBe('{"recoverFinalized":true}');
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers).toMatchObject({ authorization: "Bearer synthetic-bearer", "content-type": "application/json" });
  });

  it.each(["failed", "expired", "removed", "running", "unknown"])("keeps server outcome %s separate from success", async (outcome) => {
    const transport = new UploadTransport("https://relayium.com", "synthetic-bearer", {
      fetchImpl: (async () => new Response(JSON.stringify({ outcome }), { status: 409 })) as typeof fetch,
    });
    const result = await transport.finalizeRecoverable("session-1");
    expect(result).toEqual(outcome === "running" ? { outcome: "running" }
      : outcome === "unknown" ? { outcome: "unconfirmed" } : { outcome: "terminal", reason: outcome });
  });

  it("never treats a legacy text conflict or a missing session as a published object", async () => {
    for (const status of [409, 404]) {
      const transport = new UploadTransport("https://relayium.com", "synthetic-bearer", {
        fetchImpl: (async () => new Response("already finalized", { status })) as typeof fetch,
      });
      if (status === 409) expect(await transport.finalizeRecoverable("session-1")).toEqual({ outcome: "unconfirmed" });
      else await expect(transport.finalizeRecoverable("session-1")).rejects.toMatchObject({ code: "http", status: 404 });
    }
  });

  it.each([{ id: "../other", expiresAt: 5 }, { id: "object-1" }, { id: "object-1", expiresAt: NaN }])("rejects malformed recovered identity", async (answer) => {
    const transport = new UploadTransport("https://relayium.com", "synthetic-bearer", {
      fetchImpl: (async () => new Response(JSON.stringify(answer), { status: 200 })) as typeof fetch,
    });
    await expect(transport.finalizeRecoverable("session-1")).rejects.toMatchObject({ code: "malformed" });
  });
});
