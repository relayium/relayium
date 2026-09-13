// The coordinator: single-flight, once-a-day, never-trust-a-restart, and an
// install that only ever happens through the verified platform boundary.
//
// ## Why these run on POSIX only
//
// Every service here injects `posixScopeProvider` explicitly. The production
// default refuses on `win32` until the native adapter is wired, and that refusal
// must NOT be softened to make a test pass — so the same core assertions run
// against the real Windows capability in `update-windows-native.test.ts`, and
// this file is skipped there rather than pretending to cover it.
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  InstallExpectation,
  InstallOutcome,
  PlatformInstaller,
  PublisherVerdict,
  QuiesceDecision,
  QuiesceRequest,
} from "../../src/main/update/contracts.js";
import {
  AUTOMATIC_CHECK_INTERVAL_MS,
  UpdateService,
  type UpdateServiceOptions,
} from "../../src/main/update/service.js";
import { posixScopeProvider } from "../../src/main/update/custody.js";
import { PRODUCTION_TRUST_BASE, type UpdateTrust } from "../../src/main/update/trust.js";

/** The staged file's name carries a per-attempt nonce, so tests read it back
 *  rather than composing it. Composing it is the mistake the nonce prevents. */
async function stagedName(dir: string): Promise<string> {
  const exe = (await readdir(join(dir, "updates"))).filter((name) => name.endsWith(".exe"));
  expect(exe).toHaveLength(1);
  return exe[0] as string;
}

const stagedFiles = async (dir: string): Promise<string[]> =>
  (await readdir(join(dir, "updates"))).filter((name) => name.endsWith(".exe"));

/**
 * These suites drive the POSIX capability directly.
 *
 * Skipped on Windows with a reason rather than silently: the production default
 * there is fail-closed until the native adapter is wired, and softening it to
 * make a test pass would remove the very guarantee the test set exists to keep.
 * `update-windows-native.test.ts` runs the same core assertions against the real
 * Windows capability.
 */
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

const owned: string[] = [];
afterEach(async () => {
  for (const dir of owned.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "relayium-update-svc-"));
  owned.push(dir);
  return dir;
}

function ephemeralKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  return { encoded: jwk.x ?? "", privateKey };
}

const PAYLOAD = new Uint8Array(2048).fill(3);
const SHA = createHash("sha256").update(PAYLOAD).digest("hex");
const RELEASE = "https://github.com/relayium/relayium/releases/download/windows-v0.3.0/Setup.exe";

const manifestDocument = (overrides: Record<string, unknown> = {}) => ({
  schema: 1,
  product: "relayium-windows",
  channel: "stable",
  platform: "windows",
  arch: "x64",
  version: "0.3.0",
  build: 9,
  artifact: { url: RELEASE, sizeBytes: PAYLOAD.byteLength, sha256: SHA },
  publishedAt: 1_789_000_000,
  notesUrl: null,
  ...overrides,
});

interface World {
  readonly service: UpdateService;
  readonly key: ReturnType<typeof ephemeralKey>;
  readonly dir: string;
  readonly fetched: string[];
  now: number;
  installs: InstallExpectation[];
  leaseReleases: string[];
  consentRequests: QuiesceRequest[];
}

async function world(options: {
  readonly document?: Record<string, unknown>;
  readonly verdict?: PublisherVerdict;
  readonly install?: (expectation: InstallExpectation) => Promise<InstallOutcome>;
  readonly consent?: (request: QuiesceRequest) => Promise<QuiesceDecision>;
  readonly releaseFails?: boolean;
  readonly noConsent?: boolean;
  readonly current?: { version: string; build: number };
  readonly engineering?: boolean;
  readonly pin?: boolean;
  readonly publisher?: string | null;
  readonly payload?: Uint8Array;
  readonly dir?: string;
  readonly onReveal?: (path: string) => void;
  /** Reuse a pin across worlds, which is what "the same installation
   *  restarted" means. A fresh key would be a different build. */
  readonly key?: ReturnType<typeof ephemeralKey>;
}): Promise<World> {
  const key = options.key ?? ephemeralKey();
  const dir = options.dir ?? (await dataDir());
  const document = new TextEncoder().encode(JSON.stringify(options.document ?? manifestDocument()));
  const signature = sign(null, document, key.privateKey).toString("base64url");
  const fetched: string[] = [];
  const payload = options.payload ?? PAYLOAD;
  const state = {
    now: 1_000_000,
    installs: [] as InstallExpectation[],
    leaseReleases: [] as string[],
    consentRequests: [] as QuiesceRequest[],
  };
  const trust: UpdateTrust = {
    ...PRODUCTION_TRUST_BASE,
    publicKeys: options.pin === false ? [] : [key.encoded],
    expectedPublisher: options.publisher ?? "CN=Relayium",
  };
  const fetchImpl = (async (url: string | URL): Promise<Response> => {
    const target = String(url);
    fetched.push(target);
    if (target.endsWith(".sig")) return new Response(signature, { status: 200 });
    if (target === trust.feedUrl) {
      return new Response(document as Uint8Array<ArrayBuffer>, { status: 200 });
    }
    return new Response(payload as Uint8Array<ArrayBuffer>, { status: 200 });
  }) as unknown as typeof fetch;

  const installer: PlatformInstaller = {
    installVerified: async (expectation) => {
      state.installs.push(expectation);
      return options.install
        ? options.install(expectation)
        : { outcome: "launched" as const };
    },
  };
  const serviceOptions: UpdateServiceOptions = {
    trust,
    engineering: options.engineering ?? false,
    current: options.current ?? { version: "0.2.0", build: 7 },
    dataDirectory: dir,
    verifier: { verify: async () => options.verdict ?? "signed-by-expected-publisher" },
    installer,
    revealer: {
      reveal: async (path: string) => {
        options.onReveal?.(path);
      },
    },
    quiesceConsent: {
      request: async (request) => {
        state.consentRequests.push(request);
        if (options.consent) return options.consent(request);
        return {
          granted: true as const,
          lease: {
            release: async (reason: string) => {
              state.leaseReleases.push(reason);
              return options.releaseFails === true
                ? ({ outcome: "unknown", detail: "still-quiesced" } as const)
                : ({ outcome: "resumed" } as const);
            },
          },
        };
      },
    },
    clock: { now: () => state.now },
    feed: { fetchImpl },
    artifact: { fetchImpl },
    // EXPLICIT, never the platform default. These are core-behaviour tests, and
    // the default is deliberately fail-closed on `win32` — see the note at the
    // top of the file. Injecting the capability is what keeps them testing the
    // coordinator instead of testing which platform they happen to run on.
    scope: posixScopeProvider,
  };
  return {
    service: new UpdateService(serviceOptions),
    key,
    dir,
    fetched,
    get now() {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },
    get installs() {
      return state.installs;
    },
    get leaseReleases() {
      return state.leaseReleases;
    },
    get consentRequests() {
      return state.consentRequests;
    },
  } as World;
}

describeOnPosix("when updates are off", () => {
  it("is disabled for an engineering build, and checks nothing", async () => {
    const w = await world({ engineering: true });
    expect(w.service.current).toEqual({ kind: "disabled", reason: "engineering-build" });
    await w.service.check("manual");
    expect(w.fetched).toEqual([]);
  });

  it("is disabled with no pinned key", async () => {
    const w = await world({ pin: false });
    expect(w.service.current).toEqual({ kind: "disabled", reason: "no-pin" });
    await w.service.check("manual");
    expect(w.fetched).toEqual([]);
  });
});

describeOnPosix("checking", () => {
  it("finds a newer build", async () => {
    const w = await world({});
    const state = await w.service.check("manual");
    expect(state).toMatchObject({ kind: "update-available" });
    if (state.kind !== "update-available") return;
    expect(state.candidate).toMatchObject({ version: "0.3.0", build: 9, sizeBytes: 2048 });
    // The hash is not claimed until the bytes are hashed here.
    expect(state.candidate.sha256).toBeNull();
  });

  it("reports up-to-date for an equal build", async () => {
    const w = await world({ current: { version: "0.3.0", build: 9 } });
    expect(await w.service.check("manual")).toMatchObject({ kind: "up-to-date" });
  });

  it("refuses a version regression WITHOUT calling it up-to-date", async () => {
    const w = await world({
      document: manifestDocument({ version: "0.1.0", build: 99 }),
    });
    expect(await w.service.check("manual")).toEqual({
      kind: "check-failed",
      reason: "version-regression",
      retryable: false,
    });
  });

  it("reports an untrusted feed terminally", async () => {
    const other = ephemeralKey();
    const dir = await dataDir();
    const document = new TextEncoder().encode(JSON.stringify(manifestDocument()));
    const signature = sign(null, document, other.privateKey).toString("base64url");
    const service = new UpdateService({
      trust: { ...PRODUCTION_TRUST_BASE, publicKeys: [ephemeralKey().encoded], expectedPublisher: "CN=X" },
      engineering: false,
      current: { version: "0.2.0", build: 7 },
      dataDirectory: dir,
      feed: {
        fetchImpl: (async (url: string | URL) =>
          String(url).endsWith(".sig")
            ? new Response(signature, { status: 200 })
            : new Response(document as Uint8Array<ArrayBuffer>, { status: 200 })) as unknown as typeof fetch,
      },
    });
    const state = await service.check("manual");
    expect(state.kind).toBe("feed-untrusted");
    // And no download is reachable from there.
    expect(await service.download()).toBe(state);
  });

  it("bounds an automatic check to once a day, while a manual one is not bounded", async () => {
    const w = await world({});
    expect(await w.service.automaticCheckDue()).toBe(true);
    await w.service.check("automatic");
    expect(w.fetched.length).toBe(2);
    // Same day: the automatic check does nothing.
    await w.service.check("automatic");
    expect(w.fetched.length).toBe(2);
    // A manual one always may.
    await w.service.check("manual");
    expect(w.fetched.length).toBe(4);
    // A day later the automatic one is due again.
    w.now += AUTOMATIC_CHECK_INTERVAL_MS;
    expect(await w.service.automaticCheckDue()).toBe(true);
  });

  it("admits one job at a time", async () => {
    const w = await world({});
    const first = w.service.check("manual");
    // The second is refused synchronously, not queued.
    const second = await w.service.check("manual");
    expect(second).toEqual({ kind: "checking" });
    await first;
    expect(w.fetched.length).toBe(2);
  });
});

describeOnPosix("downloading and the four publisher answers", () => {
  const cases: readonly (readonly [PublisherVerdict, string])[] = [
    ["signed-by-expected-publisher", "ready"],
    ["unsigned", "ready-unsigned"],
    ["signed-by-other-publisher", "publisher-mismatch"],
    ["unavailable", "verifier-unavailable"],
  ];
  for (const [verdict, kind] of cases) {
    it(`maps ${verdict} to ${kind}`, async () => {
      const w = await world({ verdict });
      await w.service.check("manual");
      const state = await w.service.download();
      expect(state.kind).toBe(kind);
      if (state.kind === "ready" || state.kind === "ready-unsigned") {
        // The hash is now a fact about a file on this disk.
        expect(state.candidate.sha256).toBe(SHA);
      }
    });
  }

  it("only `ready` can install; the other three cannot", async () => {
    for (const [verdict] of cases) {
      const w = await world({ verdict });
      await w.service.check("manual");
      const downloaded = await w.service.download();
      const after = await w.service.install();
      if (verdict === "signed-by-expected-publisher") {
        expect(after.kind).toBe("installing");
        expect(w.installs.length).toBe(1);
      } else {
        // Nothing was handed to the platform installer at all.
        expect(after).toBe(downloaded);
        expect(w.installs).toEqual([]);
      }
    }
  });

  it("retires the staged file and reports a hash mismatch", async () => {
    const w = await world({ payload: new Uint8Array(2048).fill(9) });
    await w.service.check("manual");
    const state = await w.service.download();
    expect(state).toMatchObject({ kind: "verify-failed", reason: "integrity" });
    // Ownership of the partial file was retained and then used.
    expect(await stagedFiles(w.dir)).toEqual([]);
  });
});

describeOnPosix("the install boundary", () => {
  it("hands the platform an immutable expectation, not a bare path", async () => {
    const w = await world({});
    await w.service.check("manual");
    await w.service.download();
    const name = await stagedName(w.dir);
    await w.service.install();
    expect(w.installs[0]).toEqual({
      // Directory and name, not a composed path: the adapter is required to
      // reach the file handle-relative beneath a root it holds.
      directory: join(w.dir, "updates"),
      name,
      // The receipt travels to the final effect too, so the installer verifies
      // the same OBJECT the download created rather than the same name.
      receipt: expect.stringMatching(/^posix:[0-9a-f]+:[0-9a-f]+$/) as unknown as string,
      sizeBytes: PAYLOAD.byteLength,
      sha256: SHA,
      publisher: "CN=Relayium",
    });
  });

  it("never launches when the staged bytes changed after verification", async () => {
    const w = await world({});
    await w.service.check("manual");
    await w.service.download();
    // Someone replaces the file between the download and the click.
    await writeFile(join(w.dir, "updates", await stagedName(w.dir)), "not the installer", "utf8");
    const state = await w.service.install();
    expect(state).toMatchObject({ kind: "verify-failed", reason: "staging-changed" });
    expect(w.installs).toEqual([]);
  });

  it("never launches a candidate the running build has caught up with", async () => {
    const w = await world({});
    await w.service.check("manual");
    await w.service.download();
    // A second service over the SAME data directory and the SAME pin, already
    // at that build.
    const later = await world({ dir: w.dir, key: w.key, current: { version: "0.3.0", build: 9 } });
    const state = await later.service.reverifyStaged();
    expect(state.kind).toBe("up-to-date");
    expect(later.installs).toEqual([]);
    // And the stale installer is not left lying around to be clicked.
    expect(await stagedFiles(w.dir)).toEqual([]);
  });

  it("never launches after a cancel", async () => {
    const w = await world({});
    await w.service.check("manual");
    await w.service.download();
    await w.service.quiesce();
    w.service.resume();
    // A quiesced service admits nothing; after resume the state is still ready
    // but the run that was cancelled launched nothing.
    expect(w.installs).toEqual([]);
  });

  it("releases the consent lease when the platform refuses", async () => {
    const w = await world({
      install: async () => ({ outcome: "refused", refusal: "identity-changed" }),
    });
    await w.service.check("manual");
    await w.service.download();
    const state = await w.service.install();
    expect(state).toMatchObject({ kind: "install-deferred", reason: "identity-changed" });
    // The app goes back to work rather than staying quiesced.
    expect(w.leaseReleases).toEqual(["install-not-completed"]);
  });

  it("keeps the lease only when the process actually launched", async () => {
    const w = await world({});
    await w.service.check("manual");
    await w.service.download();
    expect((await w.service.install()).kind).toBe("installing");
    expect(w.leaseReleases).toEqual([]);
  });

  it("does not install when the resident side refuses consent", async () => {
    const w = await world({
      consent: async () => ({ granted: false, reason: "transfer-in-flight" }),
    });
    await w.service.check("manual");
    await w.service.download();
    expect(await w.service.install()).toMatchObject({
      kind: "install-deferred",
      reason: "transfer-in-flight",
    });
    expect(w.installs).toEqual([]);
  });

  it("maps a platform publisher refusal back to the honest state", async () => {
    const w = await world({
      install: async () => ({
        outcome: "refused",
        refusal: "publisher",
        verdict: "signed-by-other-publisher",
      }),
    });
    await w.service.check("manual");
    await w.service.download();
    expect((await w.service.install()).kind).toBe("publisher-mismatch");
    expect(w.leaseReleases).toEqual(["install-not-completed"]);
  });

  it("fails closed with no platform installer", async () => {
    const dir = await dataDir();
    const key = ephemeralKey();
    const document = new TextEncoder().encode(JSON.stringify(manifestDocument()));
    const signature = sign(null, document, key.privateKey).toString("base64url");
    const fetchImpl = (async (url: string | URL) => {
      const target = String(url);
      if (target.endsWith(".sig")) return new Response(signature, { status: 200 });
      if (target.endsWith("updates.json")) {
        return new Response(document as Uint8Array<ArrayBuffer>, { status: 200 });
      }
      return new Response(PAYLOAD as Uint8Array<ArrayBuffer>, { status: 200 });
    }) as unknown as typeof fetch;
    const service = new UpdateService({
      trust: { ...PRODUCTION_TRUST_BASE, publicKeys: [key.encoded], expectedPublisher: "CN=Relayium" },
      engineering: false,
      current: { version: "0.2.0", build: 7 },
      dataDirectory: dir,
      verifier: { verify: async () => "signed-by-expected-publisher" },
      // No `installer`.
      quiesceConsent: {
        request: async () => ({
          granted: true,
          lease: { release: async () => ({ outcome: "resumed" }) },
        }),
      },
      feed: { fetchImpl },
      artifact: { fetchImpl },
    });
    await service.check("manual");
    expect((await service.download()).kind).toBe("ready");
    // Refuses rather than running anything.
    expect(await service.install()).toMatchObject({
      kind: "install-deferred",
      reason: "platform-error",
    });
  });
});

describeOnPosix("a candidate left by an earlier run", () => {
  it("is re-verified rather than trusted", async () => {
    const w = await world({});
    await w.service.check("manual");
    expect((await w.service.download()).kind).toBe("ready");

    // A fresh process over the same directory and pin: `ready` is not
    // remembered, and the stored SIGNED bytes are re-authenticated.
    const restarted = await world({ dir: w.dir, key: w.key });
    expect(restarted.service.current).toMatchObject({ kind: "idle" });
    expect((await restarted.service.reverifyStaged()).kind).toBe("ready");
    expect(restarted.installs).toEqual([]);
  });

  it("is discarded when its bytes changed while the app was closed", async () => {
    const w = await world({});
    await w.service.check("manual");
    await w.service.download();
    await writeFile(join(w.dir, "updates", await stagedName(w.dir)), "swapped", "utf8");
    const restarted = await world({ dir: w.dir, key: w.key });
    const state = await restarted.service.reverifyStaged();
    expect(state).toMatchObject({ kind: "verify-failed", reason: "stale-staging" });
    expect(await stagedFiles(w.dir)).toEqual([]);
  });

  it("refuses a stored candidate under a DIFFERENT pin", async () => {
    // Key rotation, or an attacker who replaced the pin's counterpart. The
    // stored metadata no longer authenticates, so nothing about it is used.
    const w = await world({});
    await w.service.check("manual");
    expect((await w.service.download()).kind).toBe("ready");
    const elsewhere = await world({ dir: w.dir });
    const state = await elsewhere.service.reverifyStaged();
    expect(state.kind).toBe("feed-untrusted");
    expect(elsewhere.installs).toEqual([]);
  });

  it("keeps no secret and no identifier in its journal", async () => {
    const w = await world({});
    await w.service.check("manual");
    await w.service.download();
    const raw = await readFile(join(w.dir, "updates", "candidate.json"), "utf8");
    // No credential, and — the finding this pins — NO PATH. A path in this file
    // would be a filesystem call authorized by an unsigned local record.
    expect(raw).not.toMatch(/bearer|token|cookie|account/i);
    expect(raw).not.toContain(w.dir);
    expect(raw).not.toContain(".exe");
    expect(raw).not.toMatch(/"path"/);
    // What it does hold is the SIGNED metadata and its signature, which is the
    // only authority a restart may use.
    const parsed = JSON.parse(raw) as { candidate: { metadata: string; signature: string } };
    expect(Buffer.from(parsed.candidate.metadata, "base64").toString("utf8")).toContain("\"build\":9");
    expect(parsed.candidate.signature.length).toBeGreaterThan(80);
  });
});

describeOnPosix("revealing an unsigned installer", () => {
  it("shows the file and never claims an update happened", async () => {
    const revealed: string[] = [];
    const w = await world({
      verdict: "unsigned",
      onReveal: (path) => revealed.push(path),
    });
    await w.service.check("manual");
    await w.service.download();
    const state = await w.service.reveal();
    expect(state.kind).toBe("revealed");
    expect(revealed).toHaveLength(1);
    // `revealed` is the end of the unsigned path — an installer on disk, not an
    // updated application.
    expect(w.installs).toEqual([]);
  });

  it("cannot reveal from any other state", async () => {
    const w = await world({ verdict: "unavailable" });
    await w.service.check("manual");
    const downloaded = await w.service.download();
    expect(await w.service.reveal()).toBe(downloaded);
  });
});
