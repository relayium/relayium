// The two GETs, their bounds, and what they refuse.
//
// The `fetch` seam is driven by a fake that behaves the way the real one does
// in the ways that matter here: aborting the signal ERRORS a live body (which
// is what makes a stalled or cancelled read observable), `content-length` is a
// header the peer controls, and a redirect surfaces as a rejection rather than
// a response.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_META_TIMEOUT_MS,
  MAX_BLOB_REDIRECTS,
  MAX_META_BYTES,
  StoredTransport,
  StoredTransportError,
  directDownloadVerdict,
} from "../../src/main/stored/transport.js";

const ORIGIN = "https://relayium.com";
const ID = "abc123";

const META = {
  encManifest: Buffer.from(new Uint8Array(32).fill(1)).toString("base64"),
  size: 54,
  burnAfterRead: false,
  expiresAt: 1_800_000_000,
};

interface Seen {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fetch whose body is a real stream, wired to the signal like a real one. */
function fakeFetch(
  plan: (seen: Seen) => {
    readonly status?: number;
    readonly headers?: Record<string, string>;
    readonly chunks?: readonly (Uint8Array | "stall")[];
    readonly body?: string;
    readonly reject?: Error;
  },
): { impl: typeof fetch; seen: Seen[]; cancels: () => number } {
  const seen: Seen[] = [];
  let cancels = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const record: Seen = { url: String(url), init: init ?? {} };
    seen.push(record);
    const outcome = plan(record);
    if (outcome.reject) throw outcome.reject;
    const signal = init?.signal ?? null;
    const chunks = outcome.chunks;
    let body: ReadableStream<Uint8Array> | null = null;
    if (chunks !== undefined) {
      body = new ReadableStream<Uint8Array>({
        cancel() {
          cancels += 1;
        },
        start(controller) {
          const abort = (): void => {
            const error = new Error("aborted");
            error.name = "AbortError";
            controller.error(error);
          };
          if (signal) {
            if (signal.aborted) return abort();
            signal.addEventListener("abort", abort, { once: true });
          }
          for (const chunk of chunks) {
            // "stall" means: deliver nothing more and never close. Only an
            // abort can end this stream, which is the case the watchdog exists
            // for.
            if (chunk === "stall") return;
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
    } else if (outcome.body !== undefined) {
      body = new ReadableStream<Uint8Array>({
        cancel() {
          cancels += 1;
        },
        start(controller) {
          controller.enqueue(new TextEncoder().encode(outcome.body ?? ""));
          controller.close();
        },
      });
    }
    return new Response(body, {
      status: outcome.status ?? 200,
      headers: outcome.headers ?? {},
    });
  }) as unknown as typeof fetch;
  return { impl, seen, cancels: () => cancels };
}

const transport = (impl: typeof fetch, options: { metaTimeoutMs?: number; stallMs?: number } = {}) =>
  new StoredTransport(ORIGIN, { fetchImpl: impl, ...options });

const code = async (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "resolved",
    (error: unknown) => (error instanceof StoredTransportError ? error.code : `other:${String(error)}`),
  );

describe("the metadata read", () => {
  it("composes the URL from the build's origin and carries no credential", async () => {
    const { impl, seen } = fakeFetch(() => ({ body: JSON.stringify(META) }));
    await transport(impl).meta(ID);
    expect(seen[0]?.url).toBe(`${ORIGIN}/api/files/${ID}/meta`);
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(Object.keys(headers)).toEqual(["accept"]);
    // No bearer, no cookie, no device identity: these routes are
    // unauthenticated and a receive must work signed out.
    expect(JSON.stringify(seen[0]?.init)).not.toMatch(/authorization|cookie|credentials/i);
  });

  it("never follows a redirect", async () => {
    const { impl, seen } = fakeFetch(() => ({ body: JSON.stringify(META) }));
    await transport(impl).meta(ID);
    expect(seen[0]?.init.redirect).toBe("error");
  });

  it("returns the documented document", async () => {
    const { impl } = fakeFetch(() => ({ body: JSON.stringify(META) }));
    await expect(transport(impl).meta(ID)).resolves.toEqual(META);
  });

  it("maps a non-2xx to its status", async () => {
    for (const status of [403, 404, 429, 500, 503]) {
      const { impl } = fakeFetch(() => ({ status, body: "nope" }));
      const error = await transport(impl)
        .meta(ID)
        .then(() => null, (reason: unknown) => reason as StoredTransportError);
      expect(error?.code).toBe("http");
      expect(error?.status).toBe(status);
    }
  });

  it("refuses a document past its ceiling, by header and by count", async () => {
    const declared = fakeFetch(() => ({
      headers: { "content-length": String(MAX_META_BYTES + 1) },
      body: "{}",
    }));
    expect(await code(transport(declared.impl).meta(ID))).toBe("too-large");

    // A peer that lies about `content-length` is stopped by the counted read.
    const counted = fakeFetch(() => ({
      headers: { "content-length": "2" },
      chunks: [new Uint8Array(MAX_META_BYTES + 1)],
    }));
    expect(await code(transport(counted.impl).meta(ID))).toBe("too-large");
  });

  it("refuses a 2xx body that is not the documented shape", async () => {
    const bodies = [
      "not json",
      "null",
      "[]",
      JSON.stringify({ ...META, encManifest: 42 }),
      JSON.stringify({ ...META, encManifest: "" }),
      JSON.stringify({ ...META, size: -1 }),
      JSON.stringify({ ...META, size: 1.5 }),
      JSON.stringify({ ...META, burnAfterRead: "yes" }),
      JSON.stringify({ ...META, expiresAt: "soon" }),
      JSON.stringify({ encManifest: META.encManifest }),
    ];
    for (const body of bodies) {
      const { impl } = fakeFetch(() => ({ body }));
      expect(await code(transport(impl).meta(ID)), body.slice(0, 40)).toBe("malformed");
    }
  });

  it("reports an unreachable server as a network fault", async () => {
    const { impl } = fakeFetch(() => ({ reject: new TypeError("fetch failed") }));
    expect(await code(transport(impl).meta(ID))).toBe("network");
  });

  it("reports a refused redirect distinctly from a network blip", async () => {
    const { impl } = fakeFetch(() => ({ reject: new TypeError("unexpected redirect") }));
    expect(await code(transport(impl).meta(ID))).toBe("redirect");
  });

  it("times out rather than waiting forever", async () => {
    const impl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("timeout");
          error.name = "TimeoutError";
          reject(error);
        });
      })) as unknown as typeof fetch;
    expect(await code(transport(impl, { metaTimeoutMs: 10 }).meta(ID))).toBe("timeout");
    expect(DEFAULT_META_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("reports the caller's own cancellation as a cancellation, not a fault", async () => {
    const controller = new AbortController();
    const impl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as unknown as typeof fetch;
    const running = transport(impl).meta(ID, controller.signal);
    controller.abort();
    expect(await code(running)).toBe("cancelled");
  });
});

describe("the ciphertext read", () => {
  const frame = (n: number): Uint8Array => new Uint8Array(n).fill(9);

  it("composes its own URL and judges redirects itself", async () => {
    const { impl, seen } = fakeFetch(() => ({ chunks: [frame(4)] }));
    await transport(impl).blob(ID, 100);
    expect(seen[0]?.url).toBe(`${ORIGIN}/api/files/${ID}/blob`);
    // `manual`, not `error`: the runtime must not follow a 3xx on its own,
    // because it would apply no host boundary. See directDownloadVerdict.
    expect(seen[0]?.init.redirect).toBe("manual");
  });

  it("carries no credential and no BYO opt-in header on any hop", async () => {
    const { impl, seen } = fakeFetch((request) =>
      request.url === `${ORIGIN}/api/files/${ID}/blob`
        ? { status: 302, headers: { location: `https://n1.relayium.com/blob/${ID}` } }
        : { chunks: [frame(4)] },
    );
    const body = await transport(impl).blob(ID, 100);
    expect((await body.read())?.byteLength).toBe(4);
    expect(seen).toHaveLength(2);
    for (const request of seen) {
      const headers = request.init.headers as Record<string, string>;
      // The complete header set on every hop. `X-Relayium-Direct-Download`
      // absent means a BYO own-node object stays on central's proxy path and
      // no user-advertised hostname is ever contacted.
      expect(Object.keys(headers)).toEqual(["accept"]);
      expect(JSON.stringify(request.init)).not.toMatch(/authorization|cookie|referer|direct-download/i);
    }
  });

  it("follows central -> fleet, the ordinary unlimited-object path", async () => {
    const fleet = `https://n7.relayium.com/blob/${ID}?tok=abc`;
    const { impl, seen } = fakeFetch((request) =>
      request.url === fleet
        ? { chunks: [frame(6)] }
        : { status: 302, headers: { location: fleet } },
    );
    const body = await transport(impl).blob(ID, 100);
    expect((await body.read())?.byteLength).toBe(6);
    expect(seen.map((request) => request.url)).toEqual([`${ORIGIN}/api/files/${ID}/blob`, fleet]);
  });

  it("replays central ONCE when a fleet hop answers 403 with a spent token", async () => {
    const fleet = `https://n7.relayium.com/blob/${ID}`;
    let fleetHits = 0;
    const { impl, seen } = fakeFetch((request) => {
      if (request.url !== fleet) return { status: 302, headers: { location: fleet } };
      fleetHits += 1;
      return fleetHits === 1 ? { status: 403, chunks: [] } : { chunks: [frame(5)] };
    });
    const body = await transport(impl).blob(ID, 100);
    expect((await body.read())?.byteLength).toBe(5);
    // central, node(403), central, node(200) — and no more.
    expect(seen).toHaveLength(4);
  });

  it("does not replay a 403 that came straight from central", async () => {
    // No redirect was followed, so this is a real refusal and not a spent
    // one-shot token.
    const { impl, seen } = fakeFetch(() => ({ status: 403, chunks: [] }));
    const error = await transport(impl)
      .blob(ID, 100)
      .then(() => null, (reason: unknown) => reason as StoredTransportError);
    expect(error?.code).toBe("http");
    expect(error?.status).toBe(403);
    expect(seen).toHaveLength(1);
  });

  it("refuses a second 403 rather than replaying forever", async () => {
    const fleet = `https://n7.relayium.com/blob/${ID}`;
    const { impl, seen } = fakeFetch((request) =>
      request.url === fleet ? { status: 403, chunks: [] } : { status: 302, headers: { location: fleet } },
    );
    const error = await transport(impl)
      .blob(ID, 100)
      .then(() => null, (reason: unknown) => reason as StoredTransportError);
    expect(error?.status).toBe(403);
    expect(seen).toHaveLength(4);
  });

  it("refuses a redirect outside the boundary and reports it", async () => {
    const { impl, seen } = fakeFetch(() => ({
      status: 302,
      headers: { location: "https://evil.example/blob" },
    }));
    expect(await code(transport(impl).blob(ID, 100))).toBe("redirect");
    // Refused before the untrusted host was ever contacted.
    expect(seen).toHaveLength(1);
  });

  it("refuses a redirect loop instead of hanging", async () => {
    const { impl } = fakeFetch((request) => ({
      status: 302,
      headers: { location: request.url },
    }));
    expect(await code(transport(impl).blob(ID, 100))).toBe("redirect");
  });

  it("refuses a redirect chain longer than the hop bound", async () => {
    let n = 0;
    const { impl } = fakeFetch(() => {
      n += 1;
      return { status: 302, headers: { location: `https://n${String(n)}.relayium.com/blob` } };
    });
    expect(await code(transport(impl).blob(ID, 100))).toBe("redirect");
    expect(MAX_BLOB_REDIRECTS).toBe(3);
  });

  it("cancels the redirect response body before the next hop", async () => {
    // A hop that leaves its predecessor open holds a connection per hop.
    const fleet = `https://n7.relayium.com/blob/${ID}`;
    let cancelled = false;
    const impl = ((url: string, init?: RequestInit): Promise<Response> => {
      if (String(url) === fleet) {
        return Promise.resolve(new Response(new Uint8Array(4), { status: 200 }));
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(16));
        },
        cancel() {
          cancelled = true;
        },
      });
      void init;
      return Promise.resolve(new Response(body, { status: 302, headers: { location: fleet } }));
    }) as unknown as typeof fetch;
    const body = await transport(impl).blob(ID, 100);
    expect((await body.read())?.byteLength).toBe(4);
    expect(cancelled).toBe(true);
  });

  it("delivers chunks and ends with null", async () => {
    const { impl } = fakeFetch(() => ({ chunks: [frame(3), frame(2)] }));
    const body = await transport(impl).blob(ID, 100);
    expect((await body.read())?.byteLength).toBe(3);
    expect((await body.read())?.byteLength).toBe(2);
    expect(await body.read()).toBeNull();
    // Idempotent after the end.
    expect(await body.read()).toBeNull();
  });

  it("skips a zero-length chunk instead of treating it as the end", async () => {
    const { impl } = fakeFetch(() => ({ chunks: [new Uint8Array(0), frame(5)] }));
    const body = await transport(impl).blob(ID, 100);
    expect((await body.read())?.byteLength).toBe(5);
    expect(await body.read()).toBeNull();
  });

  it("refuses a body that runs past the manifest's ciphertext length", async () => {
    // The ceiling is derived from the AUTHENTICATED manifest, so a server that
    // sends more is refused mid-flight rather than filling a disk.
    const { impl } = fakeFetch(() => ({ chunks: [frame(30), frame(30)] }));
    const body = await transport(impl).blob(ID, 40);
    expect((await body.read())?.byteLength).toBe(30);
    expect(await code(body.read())).toBe("too-large");
  });

  it("refuses a declared length past the ceiling before reading a byte", async () => {
    const { impl } = fakeFetch(() => ({ headers: { "content-length": "999" }, chunks: [frame(4)] }));
    expect(await code(transport(impl).blob(ID, 40))).toBe("too-large");
  });

  it("maps a non-2xx blob answer to its status", async () => {
    const { impl } = fakeFetch(() => ({ status: 404, chunks: [] }));
    const error = await transport(impl)
      .blob(ID, 100)
      .then(() => null, (reason: unknown) => reason as StoredTransportError);
    expect(error?.code).toBe("http");
    expect(error?.status).toBe(404);
  });

  it("fails a stalled body instead of pinning the transfer forever", async () => {
    const { impl } = fakeFetch(() => ({ chunks: [frame(4), "stall"] }));
    const body = await transport(impl, { stallMs: 20 }).blob(ID, 100);
    expect((await body.read())?.byteLength).toBe(4);
    expect(await code(body.read())).toBe("timeout");
  });

  it("reports the caller's cancellation of a live body as a cancellation", async () => {
    const controller = new AbortController();
    const { impl } = fakeFetch(() => ({ chunks: [frame(4), "stall"] }));
    const body = await transport(impl, { stallMs: 5_000 }).blob(ID, 100, controller.signal);
    expect((await body.read())?.byteLength).toBe(4);
    const pending = body.read();
    controller.abort();
    expect(await code(pending)).toBe("cancelled");
  });

  it("refuses to start once the caller has already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { impl, seen } = fakeFetch(() => ({ chunks: [frame(4)] }));
    expect(await code(transport(impl).blob(ID, 100, controller.signal))).toBe("cancelled");
    // And costs the server nothing.
    expect(seen).toEqual([]);
  });

  it("close() is idempotent and never throws", async () => {
    const { impl } = fakeFetch(() => ({ chunks: [frame(4)] }));
    const body = await transport(impl).blob(ID, 100);
    await body.close();
    await body.close();
    expect(await body.read()).toBeNull();
  });
});

describe("the direct-download trust boundary", () => {
  const verdict = (location: string | null, extra: { current?: string; hop?: number; visited?: string[] } = {}) =>
    directDownloadVerdict({
      current: extra.current ?? `${ORIGIN}/api/files/${ID}/blob`,
      location,
      centralHost: "relayium.com",
      hop: extra.hop ?? 0,
      visited: new Set(extra.visited ?? []),
    });

  it("admits the fleet, the apex and a relative Location", () => {
    for (const location of [
      "https://n1.relayium.com/blob/x",
      "https://deep.node.relayium.com/blob/x",
      "https://relayium.com/api/files/x/blob",
      "https://n1.relayium.com:443/blob/x",
      "/api/files/other/blob",
    ]) {
      expect(verdict(location), location).toMatchObject({ follow: true });
    }
  });

  it("refuses every lookalike host", () => {
    // Each of these contains the string "relayium.com" and is a different
    // domain. The dot in the suffix is what refuses them.
    for (const host of [
      "relayium.com.evil.example",
      "evilrelayium.com",
      "xrelayium.com",
      "relayium.com.",
      "relayium.co",
      "notrelayium.com",
      "relayium.com-evil.example",
      "fleet.relayium.com.evil.example",
    ]) {
      expect(verdict(`https://${host}/blob`), host).toEqual({ follow: false, reason: "untrusted-host" });
    }
  });

  it("refuses a downgrade, even from a plaintext hop", () => {
    expect(verdict("http://n1.relayium.com/blob")).toEqual({ follow: false, reason: "insecure-scheme" });
    // An engineering build on loopback therefore follows NO redirect at all:
    // production is the only place fleet-direct is exercised. Deliberate — a
    // plaintext hop is where a body could be substituted, and the AEAD failure
    // that follows would look to the user like a corrupted file.
    expect(
      verdict("http://127.0.0.1:18080/api/files/x/blob", { current: "http://127.0.0.1:18080/api/files/x/blob" }),
    ).toEqual({ follow: false, reason: "insecure-scheme" });
    for (const location of ["file:///c:/windows/system32", "data:text/plain,x", "intent://evil"]) {
      expect(verdict(location), location).toEqual({ follow: false, reason: "insecure-scheme" });
    }
  });

  it("refuses userinfo, a fragment and a non-default port", () => {
    expect(verdict("https://user:pass@n1.relayium.com/blob")).toEqual({ follow: false, reason: "userinfo" });
    // The fragment is where a KEY lives in this product; refused, never stripped.
    expect(verdict("https://n1.relayium.com/blob#k=VVV")).toEqual({ follow: false, reason: "fragment" });
    expect(verdict("https://n1.relayium.com:8443/blob")).toEqual({ follow: false, reason: "port" });
  });

  it("refuses a missing or unusable Location", () => {
    expect(verdict(null)).toEqual({ follow: false, reason: "no-location" });
    expect(verdict("   ")).toEqual({ follow: false, reason: "no-location" });
  });

  it("refuses a repeat and an over-long chain", () => {
    const seen = "https://n1.relayium.com/blob/x";
    expect(verdict(seen, { visited: [seen] })).toEqual({ follow: false, reason: "loop" });
    expect(verdict(seen, { hop: MAX_BLOB_REDIRECTS })).toEqual({ follow: false, reason: "too-many-hops" });
  });
});

describe("the metadata body is never left open", () => {
  // A refusal that returns without cancelling leaves a live body, and
  // therefore a live connection, behind a method that has already settled.
  // Root's real-HTTP probe caught this against a server that sent headers plus
  // one byte and then parked: `too-large` rejected and the response was still
  // open 100ms later, with this side's deadline no longer watching anything.
  //
  // Every case below uses a PARKED body — one that never closes — because a
  // stream that has already ended holds nothing to leak, and asserting a
  // cancel on it would be asserting a no-op.
  const parked = (chunks: readonly (Uint8Array | "stall")[]) => [...chunks, "stall" as const];

  it("cancels a live body after refusing a non-ok status", async () => {
    const { impl, cancels } = fakeFetch(() => ({ status: 500, chunks: parked([]) }));
    expect(await code(transport(impl).meta(ID))).toBe("http");
    expect(cancels()).toBe(1);
  });

  it("cancels a live body after refusing a declared length past the ceiling", async () => {
    // Exactly root's probe, at unit scale: headers plus one byte, then parked.
    const { impl, cancels } = fakeFetch(() => ({
      headers: { "content-length": String(MAX_META_BYTES + 1) },
      chunks: parked([new TextEncoder().encode("{")]),
    }));
    expect(await code(transport(impl).meta(ID))).toBe("too-large");
    expect(cancels()).toBe(1);
  });

  it("cancels a live body after refusing a counted length past the ceiling", async () => {
    const { impl, cancels } = fakeFetch(() => ({
      headers: { "content-length": "2" },
      chunks: parked([new Uint8Array(MAX_META_BYTES + 1)]),
    }));
    expect(await code(transport(impl).meta(ID))).toBe("too-large");
    expect(cancels()).toBe(1);
  });

  it("refuses a bodyless 200 without pretending it read one", async () => {
    // No body to cancel, and the absence must not bypass the refusal either.
    const impl = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    expect(await code(transport(impl).meta(ID))).toBe("malformed");
  });

  it("has nothing to cancel once a body has been read to the end", async () => {
    // Both a success and a parse refusal consume the whole body first, so the
    // stream is already closed and no teardown is owed. Asserted so the
    // no-cancel case is deliberate rather than an omission.
    const ok = fakeFetch(() => ({ body: JSON.stringify(META) }));
    await expect(transport(ok.impl).meta(ID)).resolves.toEqual(META);
    expect(ok.cancels()).toBe(0);

    const bad = fakeFetch(() => ({ body: "not json" }));
    expect(await code(transport(bad.impl).meta(ID))).toBe("malformed");
    expect(bad.cancels()).toBe(0);
  });

  it("reports the caller's abort on a live body as a cancellation", async () => {
    // The abort errors the stream itself, which is the teardown; what matters
    // here is that the caller is told it cancelled rather than told the server
    // failed.
    const controller = new AbortController();
    const { impl } = fakeFetch(() => ({ chunks: parked([new TextEncoder().encode("{")]) }));
    const running = transport(impl, { metaTimeoutMs: 5_000 }).meta(ID, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(await code(running)).toBe("cancelled");
  });

  it("times out a parked body instead of waiting on its own deadline forever", async () => {
    const { impl, cancels } = fakeFetch(() => ({ chunks: parked([new TextEncoder().encode("{")]) }));
    expect(await code(transport(impl, { metaTimeoutMs: 20 }).meta(ID))).toBe("timeout");
    expect(cancels()).toBe(0); // the deadline errored the stream; nothing is owed
  });
});
