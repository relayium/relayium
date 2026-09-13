// The feed read: verify the exact bytes BEFORE parsing, carry no credential,
// follow no redirect, and never cure a rejected signature by retrying.
import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { FeedError, MAX_SIGNATURE_BYTES, readFeed } from "../../src/main/update/feed.js";
import { MAX_MANIFEST_BYTES } from "../../src/main/update/manifest.js";
import { PRODUCTION_TRUST_BASE, type UpdateTrust } from "../../src/main/update/trust.js";

function ephemeralKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  return { encoded: jwk.x ?? "", privateKey };
}

const MANIFEST = {
  schema: 1,
  product: "relayium-windows",
  channel: "stable",
  platform: "windows",
  arch: "x64",
  version: "0.2.0",
  build: 7,
  artifact: {
    url: "https://github.com/relayium/relayium/releases/download/windows-v0.2.0/Setup.exe",
    sizeBytes: 1024,
    sha256: "b".repeat(64),
  },
  publishedAt: 1_789_000_000,
  notesUrl: null,
};

interface Served {
  readonly metadata?: Uint8Array | string;
  readonly signature?: Uint8Array | string;
  readonly metaStatus?: number;
  readonly sigStatus?: number;
  readonly redirect?: boolean;
  readonly reject?: Error;
  readonly headers?: Record<string, string>;
}

function serve(served: Served) {
  const seen: { url: string; init: RequestInit }[] = [];
  const body = (value: Uint8Array | string | undefined): BodyInit | null => {
    if (value === undefined) return null;
    return typeof value === "string" ? value : (value as Uint8Array<ArrayBuffer>);
  };
  const impl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    seen.push({ url: target, init: init ?? {} });
    if (served.reject) throw served.reject;
    if (served.redirect === true) throw new TypeError("unexpected redirect");
    const isSignature = target.endsWith(".sig");
    const status = (isSignature ? served.sigStatus : served.metaStatus) ?? 200;
    if (status !== 200) return new Response("no", { status });
    return new Response(body(isSignature ? served.signature : served.metadata), {
      status: 200,
      headers: served.headers ?? {},
    });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const trustWith = (keys: readonly string[]): UpdateTrust => ({
  ...PRODUCTION_TRUST_BASE,
  publicKeys: keys,
});

function signed(document: unknown, key: ReturnType<typeof ephemeralKey>) {
  const metadata = new TextEncoder().encode(JSON.stringify(document));
  return { metadata, signature: sign(null, metadata, key.privateKey).toString("base64url") };
}

const code = async (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "resolved",
    (error: unknown) => (error instanceof FeedError ? error.code : `other:${String(error)}`),
  );

describe("reading the feed", () => {
  it("verifies and returns the manifest", async () => {
    const key = ephemeralKey();
    const { impl, seen } = serve(signed(MANIFEST, key));
    const manifest = await readFeed(trustWith([key.encoded]), { fetchImpl: impl });
    expect(manifest.build).toBe(7);
    // The signature is fetched FIRST, so a metadata document is never held
    // without something to check it against.
    expect(seen[0]?.url).toBe(PRODUCTION_TRUST_BASE.signatureUrl);
    expect(seen[1]?.url).toBe(PRODUCTION_TRUST_BASE.feedUrl);
  });

  it("carries no credential and no identifier, and follows no redirect", async () => {
    const key = ephemeralKey();
    const { impl, seen } = serve(signed(MANIFEST, key));
    await readFeed(trustWith([key.encoded]), { fetchImpl: impl });
    for (const request of seen) {
      expect(Object.keys(request.init.headers as Record<string, string>)).toEqual(["accept"]);
      expect(JSON.stringify(request.init)).not.toMatch(/authorization|cookie|bearer/i);
      // The URL is fixed: no query string, so nothing distinguishes one
      // installation's check from another's.
      expect(new URL(request.url).search).toBe("");
      expect(request.init.redirect).toBe("error");
    }
  });

  it("refuses a document signed by another key, and calls it untrusted", async () => {
    const mine = ephemeralKey();
    const theirs = ephemeralKey();
    const { impl } = serve(signed(MANIFEST, theirs));
    const error = await readFeed(trustWith([mine.encoded]), { fetchImpl: impl }).then(
      () => null,
      (reason: unknown) => reason as FeedError,
    );
    expect(error?.code).toBe("untrusted");
    // TERMINAL. A rejected signature is not cured by asking again.
    expect(error?.retryable).toBe(false);
  });

  it("refuses a document whose bytes changed after signing", async () => {
    const key = ephemeralKey();
    const honest = signed(MANIFEST, key);
    const tampered = new TextEncoder().encode(
      JSON.stringify({ ...MANIFEST, build: 9999 }),
    );
    const { impl } = serve({ metadata: tampered, signature: honest.signature });
    expect(await code(readFeed(trustWith([key.encoded]), { fetchImpl: impl }))).toBe("untrusted");
  });

  it("refuses a well-signed document this build does not understand", async () => {
    // Signed correctly, and still not a manifest: verification and
    // comprehension are separate answers.
    const key = ephemeralKey();
    const { impl } = serve(signed({ ...MANIFEST, schema: 99 }, key));
    const error = await readFeed(trustWith([key.encoded]), { fetchImpl: impl }).then(
      () => null,
      (reason: unknown) => reason as FeedError,
    );
    expect(error?.code).toBe("malformed");
    expect(error?.detail).toBe("unknown-schema");
  });

  it("refuses a build with no pin before it believes anything", async () => {
    const key = ephemeralKey();
    const { impl } = serve(signed(MANIFEST, key));
    const error = await readFeed(trustWith([]), { fetchImpl: impl }).then(
      () => null,
      (reason: unknown) => reason as FeedError,
    );
    expect(error?.code).toBe("untrusted");
    expect(error?.detail).toBe("no-pin");
  });

  it("bounds both documents", async () => {
    const key = ephemeralKey();
    const huge = serve({
      ...signed(MANIFEST, key),
      metadata: new Uint8Array(MAX_MANIFEST_BYTES + 1),
    });
    expect(await code(readFeed(trustWith([key.encoded]), { fetchImpl: huge.impl }))).toBe("too-large");
    const fatSignature = serve({
      ...signed(MANIFEST, key),
      signature: "A".repeat(MAX_SIGNATURE_BYTES + 1),
    });
    expect(await code(readFeed(trustWith([key.encoded]), { fetchImpl: fatSignature.impl }))).toBe(
      "too-large",
    );
  });

  it("maps transport answers without guessing", async () => {
    const key = ephemeralKey();
    const document = signed(MANIFEST, key);
    const notFound = serve({ ...document, metaStatus: 404 });
    const error = await readFeed(trustWith([key.encoded]), { fetchImpl: notFound.impl }).then(
      () => null,
      (reason: unknown) => reason as FeedError,
    );
    expect(error?.code).toBe("http");
    expect(error?.status).toBe(404);
    expect(error?.retryable).toBe(false);

    const offline = serve({ reject: new TypeError("fetch failed") });
    expect(await code(readFeed(trustWith([key.encoded]), { fetchImpl: offline.impl }))).toBe("network");

    const redirected = serve({ redirect: true });
    expect(await code(readFeed(trustWith([key.encoded]), { fetchImpl: redirected.impl }))).toBe(
      "redirect",
    );
  });

  it("reports a 5xx as retryable and a 403 as not", async () => {
    const key = ephemeralKey();
    const document = signed(MANIFEST, key);
    for (const [status, retryable] of [
      [500, true],
      [503, true],
      [429, true],
      [403, false],
    ] as const) {
      const { impl } = serve({ ...document, metaStatus: status });
      const error = await readFeed(trustWith([key.encoded]), { fetchImpl: impl }).then(
        () => null,
        (reason: unknown) => reason as FeedError,
      );
      expect(error?.retryable, String(status)).toBe(retryable);
    }
  });

  it("honours a caller's cancellation", async () => {
    const key = ephemeralKey();
    const controller = new AbortController();
    const impl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as unknown as typeof fetch;
    const running = readFeed(trustWith([key.encoded]), { fetchImpl: impl }, controller.signal);
    controller.abort();
    expect(await code(running)).toBe("cancelled");
  });
});
