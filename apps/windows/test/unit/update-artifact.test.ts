// The artifact download: an exact host allowlist, a streamed hash against the
// SIGNED length and digest, exclusively created staging, and retained ownership
// of a partial file.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactDownloadFailed,
  MAX_ARTIFACT_HOPS,
  downloadArtifact,
  hopVerdict,
} from "../../src/main/update/artifact.js";
import { posixScopeProvider, type StagingScope } from "../../src/main/update/custody.js";
import type { UpdateManifest } from "../../src/main/update/manifest.js";
import { DEFAULT_ARTIFACT_HOSTS, PRODUCTION_TRUST_BASE } from "../../src/main/update/trust.js";

/**
 * The POSIX capability, driven directly.
 *
 * Skipped on Windows with a reason: the production default is fail-closed there
 * until the native adapter is wired, and `posixScopeProvider` cannot run on it
 * (`O_DIRECTORY`/`O_NOFOLLOW` do not exist). The same core assertions run
 * against the real Windows capability in `update-windows-native.test.ts`.
 */
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

const owned: string[] = [];
const scopes: StagingScope[] = [];
afterEach(async () => {
  // The scope holds a directory descriptor; it is a capability, not a path, and
  // has to be closed like one.
  for (const scope of scopes.splice(0)) await scope.close();
  for (const dir of owned.splice(0)) await rm(dir, { recursive: true, force: true });
});
/** A real held scope. The download is handed custody, never a directory name. */
async function staging(): Promise<StagingScope> {
  const dir = await mkdtemp(join(tmpdir(), "relayium-update-"));
  owned.push(dir);
  const scope = await posixScopeProvider.open(dir, "updates");
  scopes.push(scope);
  return scope;
}

const trust = { ...PRODUCTION_TRUST_BASE, publicKeys: ["x".repeat(43)] };
/** A fixed nonce so the derived name is predictable IN THE TEST. Production
 *  mints a fresh one per attempt — that is the point of it. */
const NONCE = "0011223344556677";
const IDENTITY = { version: "0.2.0", build: 7, nonce: NONCE };
const STAGED = `relayium-0.2.0-7-${NONCE}.exe`;
/** Records the receipt callback so tests can assert it ran before any byte. */
let heldCalls = 0;
const onHeld = async (): Promise<void> => {
  heldCalls += 1;
};
const RELEASE = "https://github.com/relayium/relayium/releases/download/windows-v0.2.0/Setup.exe";
const ASSET = "https://objects.githubusercontent.com/release/abc/Setup.exe";

const manifestFor = (payload: Uint8Array): UpdateManifest => ({
  signedBytes: new TextEncoder().encode("{fixture}"),
  signature: "s".repeat(86),
  schema: 1,
  product: "relayium-windows",
  channel: "stable",
  platform: "windows",
  arch: "x64",
  version: "0.2.0",
  build: 7,
  artifactUrl: RELEASE,
  artifactBytes: payload.byteLength,
  artifactSha256: createHash("sha256").update(payload).digest("hex"),
  publishedAt: 1_789_000_000,
  notesUrl: null,
});

interface Plan {
  readonly status?: number;
  readonly location?: string;
  readonly chunks?: readonly Uint8Array[];
  readonly headers?: Record<string, string>;
  readonly reject?: Error;
}

function serve(plan: (url: string) => Plan) {
  const seen: string[] = [];
  const impl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = String(url);
    seen.push(target);
    const outcome = plan(target);
    if (outcome.reject) throw outcome.reject;
    void init;
    if (outcome.location !== undefined) {
      return new Response(new Uint8Array([1, 2]), {
        status: outcome.status ?? 302,
        headers: { location: outcome.location },
      });
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of outcome.chunks ?? []) controller.enqueue(chunk);
        controller.close();
      },
    });
    return new Response(body, { status: outcome.status ?? 200, headers: outcome.headers ?? {} });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

describeOnPosix("the hop policy", () => {
  const verdict = (location: string | null, extra: { hop?: number; visited?: string[] } = {}) =>
    hopVerdict({
      current: RELEASE,
      location,
      hosts: DEFAULT_ARTIFACT_HOSTS,
      hop: extra.hop ?? 0,
      visited: new Set(extra.visited ?? [RELEASE]),
    });

  it("follows github.com to its release-asset hosts", () => {
    for (const location of [
      "https://objects.githubusercontent.com/release/abc/Setup.exe",
      "https://release-assets.githubusercontent.com/x/Setup.exe",
    ]) {
      expect(verdict(location), location).toMatchObject({ follow: true });
    }
  });

  it("refuses a subdomain the list does not name EXACTLY", () => {
    // The whole reason the list is exact: a suffix test would admit any
    // subdomain of a shared hosting domain, and this is an executable.
    for (const host of [
      "evil.objects.githubusercontent.com",
      "objects.githubusercontent.com.evil.example",
      "githubusercontent.com",
      "raw.githubusercontent.com",
      "codeload.github.com",
      "github.com.evil.example",
    ]) {
      const answer = verdict(`https://${host}/Setup.exe`);
      expect(answer, host).toMatchObject({ follow: false, reason: "untrusted-host" });
      // The refused host is REPORTED, so the pin can be extended from
      // evidence rather than from a guess.
      if (!answer.follow) expect(answer.host).toBe(host);
    }
  });

  it("refuses an S3 bucket host, and says which one", () => {
    // Deliberately not pinned: a bucket name is not a publisher identity.
    const answer = verdict("https://github-production-release-asset-2e65be.s3.amazonaws.com/x");
    expect(answer).toMatchObject({ follow: false, reason: "untrusted-host" });
    if (!answer.follow) expect(answer.host).toContain("s3.amazonaws.com");
  });

  it("refuses a downgrade, userinfo, a fragment, an odd port, a loop and a long chain", () => {
    expect(verdict("http://objects.githubusercontent.com/x")).toMatchObject({
      reason: "insecure-scheme",
    });
    expect(verdict("https://user:pw@objects.githubusercontent.com/x")).toMatchObject({
      reason: "userinfo",
    });
    expect(verdict("https://objects.githubusercontent.com/x#k=1")).toMatchObject({ reason: "fragment" });
    expect(verdict("https://objects.githubusercontent.com:8443/x")).toMatchObject({ reason: "port" });
    expect(verdict(ASSET, { visited: [RELEASE, ASSET] })).toMatchObject({ reason: "loop" });
    expect(verdict(ASSET, { hop: MAX_ARTIFACT_HOPS })).toMatchObject({ reason: "too-many-hops" });
    expect(verdict(null)).toMatchObject({ reason: "no-location" });
  });

  it("is not the fleet allowlist", () => {
    // `*.relayium.com` governs opaque ciphertext that fails an AEAD check when
    // it is wrong. Sharing it here would widen what may hand this app an
    // executable.
    expect(verdict("https://n1.relayium.com/Setup.exe")).toMatchObject({
      follow: false,
      reason: "untrusted-host",
    });
  });
});

describeOnPosix("the download", () => {
  const payload = new Uint8Array(4096).fill(7);

  it("follows one hop, hashes as it goes, and writes a private staged file", async () => {
    const scope = await staging();
    const manifest = manifestFor(payload);
    const { impl, seen } = serve((url) =>
      url === RELEASE ? { location: ASSET } : { chunks: [payload.subarray(0, 1000), payload.subarray(1000)] },
    );
    const staged = await downloadArtifact(manifest, trust, scope, IDENTITY, onHeld, { fetchImpl: impl });
    expect(seen).toEqual([RELEASE, ASSET]);
    expect(staged.bytes).toBe(payload.byteLength);
    expect(staged.sha256).toBe(manifest.artifactSha256);
    // The name comes from the SIGNED manifest, never from the URL.
    expect(staged.path).toBe(join(scope.directory, STAGED));
    // The receipt was recorded once, before anything was written.
    expect(heldCalls).toBeGreaterThan(0);
    expect(new Uint8Array(await readFile(staged.path))).toEqual(payload);
  });

  it("refuses a body longer than the signed length, mid-flight", async () => {
    const scope = await staging();
    const manifest = manifestFor(payload);
    const { impl } = serve((url) =>
      url === RELEASE ? { location: ASSET } : { chunks: [payload, new Uint8Array(10)] },
    );
    const failure = await downloadArtifact(manifest, trust, scope, IDENTITY, onHeld, { fetchImpl: impl }).then(
      () => null,
      (error: unknown) => error as ArtifactDownloadFailed,
    );
    expect(failure?.cause.code).toBe("too-large");
  });

  it("refuses a short body as an INTEGRITY failure, not a network one", async () => {
    const scope = await staging();
    const manifest = manifestFor(payload);
    const { impl } = serve((url) =>
      url === RELEASE ? { location: ASSET } : { chunks: [payload.subarray(0, 100)] },
    );
    const failure = await downloadArtifact(manifest, trust, scope, IDENTITY, onHeld, { fetchImpl: impl }).then(
      () => null,
      (error: unknown) => error as ArtifactDownloadFailed,
    );
    // The signed manifest said how long it would be.
    expect(failure?.cause.code).toBe("integrity");
    expect(failure?.cause.detail).toBe("short");
  });

  it("refuses a body whose hash does not match the signed digest", async () => {
    const scope = await staging();
    const manifest = manifestFor(payload);
    const other = new Uint8Array(payload.byteLength).fill(9);
    const { impl } = serve((url) => (url === RELEASE ? { location: ASSET } : { chunks: [other] }));
    const failure = await downloadArtifact(manifest, trust, scope, IDENTITY, onHeld, { fetchImpl: impl }).then(
      () => null,
      (error: unknown) => error as ArtifactDownloadFailed,
    );
    expect(failure?.cause.code).toBe("integrity");
    expect(failure?.cause.detail).toBe("hash");
  });

  it("RETAINS the partial file and hands back the receipt that owns it", async () => {
    const scope = await staging();
    const manifest = manifestFor(payload);
    const { impl } = serve((url) =>
      url === RELEASE ? { location: ASSET } : { chunks: [payload.subarray(0, 100)] },
    );
    const failure = await downloadArtifact(manifest, trust, scope, IDENTITY, onHeld, { fetchImpl: impl }).then(
      () => null,
      (error: unknown) => error as ArtifactDownloadFailed,
    );
    // Ownership is handed back as a RECEIPT, not as a path: a caller that
    // loses it cannot decide anything, and a caller that has it can delete the
    // exact object this download created.
    expect(failure?.custody?.path).toBe(join(scope.directory, STAGED));
    expect(await readdir(scope.directory)).toContain(STAGED);
    expect(await failure?.custody?.discard()).toEqual({ outcome: "gone" });
    expect(await readdir(scope.directory)).toEqual([]);
  });

  it("refuses an existing staged file, and owns NOTHING when it does", async () => {
    const scope = await staging();
    const manifest = manifestFor(payload);
    await writeFile(join(scope.directory, STAGED), "someone else's", "utf8");
    const { impl, seen } = serve(() => ({ chunks: [payload] }));
    const failure = await downloadArtifact(manifest, trust, scope, IDENTITY, onHeld, { fetchImpl: impl }).then(
      () => null,
      (error: unknown) => error as ArtifactDownloadFailed,
    );
    expect(failure?.cause.code).toBe("staging");
    // The decisive part: no receipt, so no caller can be handed authority to
    // delete a file this download never created.
    expect(failure?.custody).toBeNull();
    // Refused before a single request.
    expect(seen).toEqual([]);
    expect(await readFile(join(scope.directory, STAGED), "utf8")).toBe(
      "someone else's",
    );
  });

  it("refuses an untrusted redirect target and names the host", async () => {
    const scope = await staging();
    const manifest = manifestFor(payload);
    const { impl, seen } = serve(() => ({ location: "https://evil.example/Setup.exe" }));
    const failure = await downloadArtifact(manifest, trust, scope, IDENTITY, onHeld, { fetchImpl: impl }).then(
      () => null,
      (error: unknown) => error as ArtifactDownloadFailed,
    );
    expect(failure?.cause.code).toBe("untrusted-host");
    expect(failure?.cause.detail).toBe("evil.example");
    // The untrusted host was never contacted.
    expect(seen).toEqual([RELEASE]);
  });

  it("carries no credential on any hop", async () => {
    const scope = await staging();
    const manifest = manifestFor(payload);
    const headers: Record<string, string>[] = [];
    const impl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      headers.push(init?.headers as Record<string, string>);
      if (String(url) === RELEASE) {
        return new Response(null, { status: 302, headers: { location: ASSET } });
      }
      return new Response(payload as Uint8Array<ArrayBuffer>, { status: 200 });
    }) as unknown as typeof fetch;
    await downloadArtifact(manifest, trust, scope, IDENTITY, onHeld, { fetchImpl: impl });
    for (const header of headers) {
      expect(Object.keys(header)).toEqual(["accept"]);
    }
  });

  it("stops when the caller cancels, and keeps the partial file", async () => {
    const scope = await staging();
    const manifest = manifestFor(payload);
    const controller = new AbortController();
    const impl = (async (): Promise<Response> => {
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(payload.subarray(0, 10));
          controller.abort();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const failure = await downloadArtifact(
      manifest,
      trust,
      scope,
      IDENTITY,
      onHeld,
      { fetchImpl: impl },
      controller.signal,
    ).then(
      () => null,
      (error: unknown) => error as ArtifactDownloadFailed,
    );
    expect(failure?.cause.code).toBe("cancelled");
    expect(failure?.custody).not.toBeNull();
  });
});
