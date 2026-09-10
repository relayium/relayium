// Owning tests for the device-task byte adapter.
//
// The one thing this adapter adds is the PURPOSE. Everything else is delegated,
// so what is asserted here is that the delegation really is delegation and that
// the one request it owns is shaped the way the server reads it.
import { describe, expect, it, vi } from "vitest";

import { DeviceTaskByteTransport } from "../../src/main/inbox/send-bytes.js";
import {
  UploadTransportError,
  type AppendReceipt,
  type FinalizeReceipt,
  type UploadByteTransport,
} from "../../src/main/stored/upload/transport.js";

const ORIGIN = "https://relayium.example";

function innerSpy(): UploadByteTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    init: () => {
      calls.push("init");
      return Promise.resolve({ uploadId: "inner", chunkSize: 1 });
    },
    append: (id, from, total, bytes): Promise<AppendReceipt> => {
      calls.push(`append:${id}:${String(from)}:${String(total)}:${String(bytes.byteLength)}`);
      return Promise.resolve({ outcome: "committed", received: from + bytes.byteLength });
    },
    status: (id) => {
      calls.push(`status:${id}`);
      return Promise.resolve({ received: 7 });
    },
    finalize: (id): Promise<FinalizeReceipt> => {
      calls.push(`finalize:${id}`);
      return Promise.resolve({ outcome: "finalized", id: "obj-1", expiresAt: 9 });
    },
  };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("device-task byte adapter", () => {
  it("names purpose=device_task and frames the sealed manifest", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.url = String(input);
      seen.init = init;
      return ok({ uploadId: "up-1", chunkSize: 128 * 1024 });
    }) as unknown as typeof fetch;

    const adapter = new DeviceTaskByteTransport(innerSpy(), ORIGIN, "bearer-value", { fetchImpl });
    const manifest = new Uint8Array([1, 2, 3, 4, 5]);
    const receipt = await adapter.init(manifest, { burnAfterRead: false, ttlSeconds: 3600 }, 4096);

    expect(receipt).toEqual({ uploadId: "up-1", chunkSize: 128 * 1024 });
    expect(seen.url).toContain("/api/uploads?purpose=device_task");
    expect(seen.url).toContain("ttl=3600");
    expect(seen.url).toContain("size=4096");
    // `u32be(manifestLen) || sealedManifest`, exactly as the server reads it.
    const body = new Uint8Array(seen.init!.body as ArrayBufferView as Uint8Array);
    expect(new DataView(body.buffer, body.byteOffset).getUint32(0, false)).toBe(5);
    expect([...body.subarray(4)]).toEqual([1, 2, 3, 4, 5]);
    expect(seen.init!.redirect).toBe("error");
    expect(new Headers(seen.init!.headers).get("authorization")).toBe("Bearer bearer-value");
  });

  it("clamps a server chunk size and falls back when it is absent", async () => {
    const tiny = new DeviceTaskByteTransport(innerSpy(), ORIGIN, "b", {
      fetchImpl: (async () => ok({ uploadId: "u", chunkSize: 1 })) as unknown as typeof fetch,
    });
    expect((await tiny.init(new Uint8Array(1), { burnAfterRead: false, ttlSeconds: 1 }, 1)).chunkSize).toBe(
      64 * 1024,
    );
    const absent = new DeviceTaskByteTransport(innerSpy(), ORIGIN, "b", {
      fetchImpl: (async () => ok({ uploadId: "u" })) as unknown as typeof fetch,
    });
    expect((await absent.init(new Uint8Array(1), { burnAfterRead: false, ttlSeconds: 1 }, 1)).chunkSize).toBe(
      8 * 1024 * 1024,
    );
  });

  it("refuses an upload id that could compose another endpoint", async () => {
    const adapter = new DeviceTaskByteTransport(innerSpy(), ORIGIN, "b", {
      fetchImpl: (async () => ok({ uploadId: "../me", chunkSize: 0 })) as unknown as typeof fetch,
    });
    await expect(
      adapter.init(new Uint8Array(1), { burnAfterRead: false, ttlSeconds: 1 }, 1),
    ).rejects.toMatchObject({ code: "malformed" });
  });

  it("DELEGATES append, status and finalize unchanged", async () => {
    const inner = innerSpy();
    const adapter = new DeviceTaskByteTransport(inner, ORIGIN, "b", {
      fetchImpl: (async () => ok({ uploadId: "u", chunkSize: 0 })) as unknown as typeof fetch,
    });
    await adapter.append("up-1", 10, 100, new Uint8Array(5));
    await adapter.status("up-1");
    await adapter.finalize("up-1");
    // Byte-for-byte the accepted transport's calls: the offset algebra, partial
    // commits and bounded retries are ITS logic, not a copy living here.
    expect(inner.calls).toEqual(["append:up-1:10:100:5", "status:up-1", "finalize:up-1"]);
    expect(inner.calls).not.toContain("init");
  });

  it("maps a caller abort and a deadline to different outcomes", async () => {
    const aborted = new DeviceTaskByteTransport(innerSpy(), ORIGIN, "b", {
      fetchImpl: (() => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" }))) as unknown as typeof fetch,
    });
    await expect(
      aborted.init(new Uint8Array(1), { burnAfterRead: false, ttlSeconds: 1 }, 1),
    ).rejects.toMatchObject({ code: "cancelled" });

    const timedOut = new DeviceTaskByteTransport(innerSpy(), ORIGIN, "b", {
      fetchImpl: (() => Promise.reject(Object.assign(new Error("x"), { name: "TimeoutError" }))) as unknown as typeof fetch,
    });
    await expect(
      timedOut.init(new Uint8Array(1), { burnAfterRead: false, ttlSeconds: 1 }, 1),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("refuses a composition that leaves the captured origin", async () => {
    const adapter = new DeviceTaskByteTransport(innerSpy(), "not a url", "b", {
      fetchImpl: (async () => ok({ uploadId: "u" })) as unknown as typeof fetch,
    });
    await expect(
      adapter.init(new Uint8Array(1), { burnAfterRead: false, ttlSeconds: 1 }, 1),
    ).rejects.toBeInstanceOf(UploadTransportError);
  });
});
