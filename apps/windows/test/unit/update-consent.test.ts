// Consent, cancellation and the fence — the paths where an install must NOT
// happen and the app must still come back.
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  InstallExpectation,
  InstallOutcome,
  QuiesceDecision,
  QuiesceRequest,
  ReleaseOutcome,
} from "../../src/main/update/contracts.js";
import { UpdateService } from "../../src/main/update/service.js";
import { PRODUCTION_TRUST_BASE } from "../../src/main/update/trust.js";

const owned: string[] = [];
afterEach(async () => {
  for (const dir of owned.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "relayium-update-consent-"));
  owned.push(dir);
  return dir;
}

function ephemeralKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  return { encoded: jwk.x ?? "", privateKey };
}

const PAYLOAD = new Uint8Array(128).fill(6);
const SHA = createHash("sha256").update(PAYLOAD).digest("hex");

async function ready(options: {
  readonly consent?: (request: QuiesceRequest) => Promise<QuiesceDecision>;
  readonly install?: (expectation: InstallExpectation) => Promise<InstallOutcome>;
  readonly withConsent?: boolean;
}) {
  const dir = await root();
  const key = ephemeralKey();
  const document = new TextEncoder().encode(
    JSON.stringify({
      schema: 1,
      product: "relayium-windows",
      channel: "stable",
      platform: "windows",
      arch: "x64",
      version: "2.0.0",
      build: 20,
      artifact: {
        url: "https://github.com/relayium/relayium/releases/download/x/Setup.exe",
        sizeBytes: PAYLOAD.byteLength,
        sha256: SHA,
      },
      publishedAt: 1_789_000_000,
      notesUrl: null,
    }),
  );
  const signature = sign(null, document, key.privateKey).toString("base64url");
  const fetchImpl = (async (url: string | URL): Promise<Response> => {
    const target = String(url);
    if (target.endsWith(".sig")) return new Response(signature, { status: 200 });
    if (target.endsWith("updates.json")) {
      return new Response(document as Uint8Array<ArrayBuffer>, { status: 200 });
    }
    return new Response(PAYLOAD as Uint8Array<ArrayBuffer>, { status: 200 });
  }) as unknown as typeof fetch;
  const installs: InstallExpectation[] = [];
  const releases: string[] = [];
  const service = new UpdateService({
    trust: { ...PRODUCTION_TRUST_BASE, publicKeys: [key.encoded], expectedPublisher: "CN=Relayium" },
    engineering: false,
    current: { version: "1.0.0", build: 1 },
    dataDirectory: dir,
    verifier: { verify: async () => "signed-by-expected-publisher" },
    installer: {
      installVerified: async (expectation) => {
        installs.push(expectation);
        return options.install ? options.install(expectation) : { outcome: "launched" };
      },
    },
    ...(options.withConsent === false
      ? {}
      : {
          quiesceConsent: {
            request: async (request) =>
              options.consent
                ? options.consent(request)
                : {
                    granted: true,
                    lease: {
                      release: async (reason: string): Promise<ReleaseOutcome> => {
                        releases.push(reason);
                        return { outcome: "resumed" };
                      },
                    },
                  },
          },
        }),
    feed: { fetchImpl },
    artifact: { fetchImpl },
  });
  await service.check("manual");
  const state = await service.download();
  return { service, state, installs, releases, dir };
}

describe("consent has no default", () => {
  it("refuses to install with no consent adapter", async () => {
    const world = await ready({ withConsent: false });
    expect(world.state.kind).toBe("ready");
    const after = await world.service.install();
    expect(after).toMatchObject({ kind: "install-deferred", reason: "no-consent-adapter" });
    // FAIL CLOSED: the absence of the resident lane's opinion is not its
    // approval, on the operation that ends the session.
    expect(world.installs).toEqual([]);
  });
});

describe("the consent request", () => {
  it("names the job to EXCLUDE, so a host cannot deadlock on it", async () => {
    let seen: QuiesceRequest | null = null;
    const world = await ready({
      consent: async (request) => {
        seen = request;
        return { granted: true, lease: { release: async () => ({ outcome: "resumed" }) } };
      },
    });
    await world.service.install();
    // The host quiesces everything but this token. Awaiting `install()` from
    // inside `request()` would deadlock both sides, and the token is what makes
    // that statement checkable.
    expect((seen as unknown as QuiesceRequest).excludeToken).toBe("update:2.0.0+20");
    expect((seen as unknown as QuiesceRequest).signal.aborted).toBe(false);
  });

  it("is abortable: an explicit quit while consent is pending installs nothing", async () => {
    let arrived!: () => void;
    const at = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const world = await ready({
      consent: async (request) => {
        arrived();
        // The host waits on the user, and the user quits.
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) return resolve();
          request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { granted: false, reason: "quit" };
      },
    });
    const installing = world.service.install();
    await at;
    // This host DOES honour the abort, so the join succeeds.
    expect(await world.service.quiesce()).toEqual({ joined: true });
    await installing;
    expect(world.installs).toEqual([]);
  });

  it("releases a LATE grant without installing", async () => {
    // The user cancelled while the host was deciding; the answer then arrives
    // as `granted`. The lease must be handed back and nothing may run.
    const released: string[] = [];
    let arrived!: () => void;
    const at = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let allow!: () => void;
    const gate = new Promise<void>((resolve) => {
      allow = resolve;
    });
    const world = await ready({
      consent: async () => {
        arrived();
        await gate;
        return {
          granted: true,
          lease: {
            release: async (reason: string) => {
              released.push(reason);
              return { outcome: "resumed" };
            },
          },
        };
      },
    });
    const installing = world.service.install();
    await at;
    // Bounded: the host is deliberately ignoring the abort here, which is
    // exactly why `quiesce` cannot wait forever. It reports that it did not
    // join rather than hanging.
    expect(await world.service.quiesce(50)).toEqual({ joined: false });
    allow();
    const state = await installing;
    expect(world.installs).toEqual([]);
    // Handed back, not kept.
    expect(released).toEqual(["install-not-completed"]);
    expect(state.kind).toBe("install-deferred");
  });
});

describe("a release that does not resume is reported", () => {
  it("does not present a still-quiesced app as healthy", async () => {
    const world = await ready({
      install: async () => ({ outcome: "refused", refusal: "not-lockable" }),
      consent: async () => ({
        granted: true,
        lease: {
          release: async (): Promise<ReleaseOutcome> => ({
            outcome: "unknown",
            detail: "still-quiesced",
          }),
        },
      }),
    });
    const state = await world.service.install();
    expect(state.kind).toBe("install-deferred");
    if (state.kind !== "install-deferred") return;
    // The actual outcome, not "resumed".
    expect(state.reason).toContain("not-resumed");
    expect(state.reason).toContain("still-quiesced");
  });

  it("treats a throwing release the same way", async () => {
    const world = await ready({
      install: async () => ({ outcome: "refused", refusal: "identity-changed" }),
      consent: async () => ({
        granted: true,
        lease: {
          release: async () => {
            throw new Error("resident gone");
          },
        },
      }),
    });
    const state = await world.service.install();
    expect(state.kind).toBe("install-deferred");
    if (state.kind !== "install-deferred") return;
    expect(state.reason).toContain("not-resumed");
  });
});

describe("the fence covers every operation", () => {
  it("a quiesced service reveals nothing", async () => {
    const revealed: string[] = [];
    const dir = await root();
    const key = ephemeralKey();
    const service = new UpdateService({
      trust: { ...PRODUCTION_TRUST_BASE, publicKeys: [key.encoded], expectedPublisher: null },
      engineering: false,
      current: { version: "1.0.0", build: 1 },
      dataDirectory: dir,
      revealer: {
        reveal: async (path: string) => {
          revealed.push(path);
        },
      },
    });
    await service.quiesce();
    // Not admitted, so it cannot touch the filesystem after the fence.
    await service.reveal();
    expect(revealed).toEqual([]);
    expect(await service.automaticCheckDue()).toBe(false);
    expect(await service.residue()).toEqual([]);
  });

  it("admits one operation at a time", async () => {
    const world = await ready({});
    // `install` holds the slot; a concurrent check is refused rather than
    // queued behind it.
    const installing = world.service.install();
    const checked = await world.service.check("manual");
    expect(checked.kind).toBe("ready");
    await installing;
  });
});
