// The policy source: what this build runs under when the network, the cache or
// the origin misbehaves.
//
// Every case is written as an attack on invariant 1 — fail open — because that
// is the one whose failure is a bricked app rather than a missed lever. If any
// of these ends with something other than a usable policy, a Windows client
// cannot start because a server was slow.
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EMBEDDED_FLOOR, MAX_POLICY_BYTES } from "../../src/main/policy/client-policy.js";
import { PolicyStore, policyPath, NO_MEMORY } from "../../src/main/policy/policy-store.js";
import { PolicySource, fromMemory } from "../../src/main/policy/policy-source.js";

const roots: string[] = [];
afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "relayium-policy-"));
  roots.push(dir);
  return dir;
}

const DOC = (over: Record<string, unknown> = {}): unknown => ({
  schema: 1,
  windows: {
    policyRevision: 7,
    minimumSupportedVersion: "1.0.0",
    recommendedVersion: "1.1.0",
    latestVersion: "1.2.0",
    minimumSupportedBuild: 10,
    ...over,
  },
});

/** A `fetch` that answers with these bytes, and counts its calls. */
function answering(body: string | Uint8Array, status = 200) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    // A fresh buffer, so the type is the plain `ArrayBuffer`-backed one `Response` takes.
    return new Response(bytes.slice().buffer as ArrayBuffer, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const refusing = () => {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    throw new Error("network down");
  }) as unknown as typeof fetch;
  return { impl, calls };
};

describe("with nothing remembered and nothing served", () => {
  it("runs under the embedded floor", async () => {
    const store = new PolicyStore(policyPath(await root()));
    const { impl } = refusing();
    const resolved = await new PolicySource({ origin: "https://x.test", store, fetchImpl: impl }).resolve();
    expect(resolved.origin).toBe("floor");
    expect(resolved.policy).toEqual(EMBEDDED_FLOOR);
  });
});

describe("a served document", () => {
  it("is adopted and remembered", async () => {
    const dir = await root();
    const store = new PolicyStore(policyPath(dir));
    const { impl, calls } = answering(JSON.stringify(DOC()));
    const source = new PolicySource({ origin: "https://x.test", store, fetchImpl: impl });
    const resolved = await source.resolve();
    expect(resolved.origin).toBe("served");
    expect(resolved.policy.revision).toBe(7);
    expect(calls[0]).toBe("https://x.test/api/client-policy/windows");
    // Remembered as the RAW document, so a later build re-decodes it against
    // its own floor rather than inheriting this verdict.
    const onDisk = JSON.parse(await readFile(policyPath(dir), "utf8")) as Record<string, unknown>;
    expect(onDisk["acceptedRevision"]).toBe(7);
    expect(onDisk["document"]).toEqual(DOC());
  });

  it("is refused when it replays an older revision", async () => {
    const dir = await root();
    const store = new PolicyStore(policyPath(dir));
    await store.write({ document: DOC(), acceptedRevision: 7 });
    // A genuine, correctly served, OLDER policy — the attack the barrier exists
    // for. The device keeps what it already had.
    const { impl } = answering(JSON.stringify(DOC({ policyRevision: 6, minimumSupportedVersion: "0.0.1" })));
    const resolved = await new PolicySource({ origin: "https://x.test", store, fetchImpl: impl }).resolve();
    expect(resolved.origin).toBe("remembered");
    expect(resolved.policy.revision).toBe(7);
  });

  it("is refused when it DECLARES a size over the ceiling", async () => {
    const store = new PolicyStore(policyPath(await root()));
    const { impl } = answering("x".repeat(MAX_POLICY_BYTES + 1));
    const resolved = await new PolicySource({ origin: "https://x.test", store, fetchImpl: impl }).resolve();
    expect(resolved.origin).toBe("floor");
  });

  it("is refused when it STREAMS more than the ceiling without declaring it", async () => {
    // The check that matters, and it was untested until a RED proof for it
    // refused to fire: the case above is caught by `content-length` before the
    // stream is read at all. A declared length is a claim; the stream is the
    // fact, and an origin that wants to hand a client an unbounded body simply
    // does not declare one.
    const store = new PolicyStore(policyPath(await root()));
    let served = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        served += 1;
        // Well past the ceiling if it is ever allowed to finish.
        if (served > 40) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const impl = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    const resolved = await new PolicySource({ origin: "https://x.test", store, fetchImpl: impl }).resolve();
    expect(resolved.origin).toBe("floor");
    // Abandoned rather than drained: the read stops at the ceiling.
    expect(served).toBeLessThan(40);
  });

  it("is refused when it is not JSON at all", async () => {
    const store = new PolicyStore(policyPath(await root()));
    const { impl } = answering("<html>a captive portal</html>");
    const resolved = await new PolicySource({ origin: "https://x.test", store, fetchImpl: impl }).resolve();
    expect(resolved.origin).toBe("floor");
  });

  it("is refused on a non-200", async () => {
    const store = new PolicyStore(policyPath(await root()));
    const { impl } = answering(JSON.stringify(DOC()), 503);
    const resolved = await new PolicySource({ origin: "https://x.test", store, fetchImpl: impl }).resolve();
    expect(resolved.origin).toBe("floor");
  });
});

describe("the origin is composed, never read", () => {
  it("does not fetch at all over plaintext", async () => {
    // A plaintext origin would let the network decide whether this build runs.
    const store = new PolicyStore(policyPath(await root()));
    const { impl, calls } = answering(JSON.stringify(DOC()));
    const resolved = await new PolicySource({ origin: "http://x.test", store, fetchImpl: impl }).resolve();
    expect(calls).toEqual([]);
    expect(resolved.origin).toBe("floor");
  });
});

describe("what is remembered", () => {
  it("survives a network outage", async () => {
    const dir = await root();
    const store = new PolicyStore(policyPath(dir));
    await store.write({ document: DOC(), acceptedRevision: 7 });
    const { impl } = refusing();
    const resolved = await new PolicySource({ origin: "https://x.test", store, fetchImpl: impl }).resolve();
    expect(resolved.origin).toBe("remembered");
    expect(resolved.policy.minimumSupported).toEqual([1, 0, 0]);
  });

  it("falls to the floor when the cache parses but is not this schema", async () => {
    // Distinct from unparseable, and it was untested until a RED proof for the
    // shape check refused to fire: the corrupt-file case below never reaches
    // that branch, because `JSON.parse` throws first.
    for (const shape of ['[]', '{"schema":2,"acceptedRevision":9}', '{"schema":1}',
                         '{"schema":1,"acceptedRevision":"9"}', '{"schema":1,"acceptedRevision":1.5}',
                         'null', '"a string"']) {
      const dir = await root();
      await writeFile(policyPath(dir), shape, "utf8");
      expect(await new PolicyStore(policyPath(dir)).read(), shape).toEqual(NO_MEMORY);
    }
  });

  it("falls to the floor when the cache file is corrupt", async () => {
    const dir = await root();
    await writeFile(policyPath(dir), "{not json", "utf8");
    const store = new PolicyStore(policyPath(dir));
    expect(await store.read()).toEqual(NO_MEMORY);
    const { impl } = refusing();
    const resolved = await new PolicySource({ origin: "https://x.test", store, fetchImpl: impl }).resolve();
    expect(resolved.origin).toBe("floor");
  });

  it("keeps the barrier when the remembered document is refused", async () => {
    // A document accepted once, which this build will not read — a schema it
    // does not know. The POLICY falls back, and the barrier does not: the
    // revision was accepted once and forgetting it reopens the replay.
    const memory = { document: { schema: 99, windows: {} }, acceptedRevision: 42 };
    const resolved = fromMemory(memory);
    expect(resolved.origin).toBe("floor");
    expect(resolved.acceptedRevision).toBe(42);
  });

  it("never lets the barrier fall below the build's own floor", async () => {
    const resolved = fromMemory({ document: null, acceptedRevision: 0 });
    expect(resolved.acceptedRevision).toBe(EMBEDDED_FLOOR.revision);
  });
});

describe("a cache that cannot be written", () => {
  it("does not stop the policy taking effect", async () => {
    // The policy is already in force for this session; a device that could not
    // persist it simply re-fetches next launch.
    const store = new PolicyStore("/definitely/not/a/writable/path/client-policy.json");
    const { impl } = answering(JSON.stringify(DOC()));
    const resolved = await new PolicySource({ origin: "https://x.test", store, fetchImpl: impl }).resolve();
    expect(resolved.origin).toBe("served");
    expect(resolved.policy.revision).toBe(7);
  });
});
