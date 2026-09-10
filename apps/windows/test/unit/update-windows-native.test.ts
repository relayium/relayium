// The core's behaviour, over the REAL Windows capability.
//
// The POSIX suites prove the coordinator against `posixScopeProvider`. This one
// proves the same assertions against the native helper, so "the core works" is
// not a statement about the platform the tests happened to run on.
//
// ## It does not skip quietly on Windows
//
// On `win32` a missing helper binary is a FAILURE, not a skip: the whole point
// is that the packaged build has one, and a suite that shrugged when it was
// absent would report green for a build with no update capability at all. On
// other platforms it is skipped with a reason, because the helper is
// Windows-only by construction.
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HELPER_FILE_NAME,
  nativePublisherVerifier,
  nativeScopeProvider,
} from "../../src/main/update/native-scope.js";
import { UpdateService } from "../../src/main/update/service.js";
import { PRODUCTION_TRUST_BASE, type UpdateTrust } from "../../src/main/update/trust.js";

const describeOnWindows = process.platform === "win32" ? describe : describe.skip;

/** Where the workflow builds it, overridable for a local run. */
const helperPath =
  process.env["RELAYIUM_UPDATE_HELPER"] ??
  join(process.cwd(), "native", "build", HELPER_FILE_NAME);

const owned: string[] = [];
afterEach(async () => {
  for (const dir of owned.splice(0)) await rm(dir, { recursive: true, force: true });
});

const PAYLOAD = new Uint8Array(4096).fill(6);
const SHA = createHash("sha256").update(PAYLOAD).digest("hex");
const RELEASE = "https://github.com/relayium/relayium/releases/download/windows-v0.3.0/Setup.exe";

type Key = ReturnType<typeof ephemeralKey>;

function ephemeralKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  return { encoded: jwk.x ?? "", privateKey };
}

interface World {
  readonly dir: string;
  readonly key: Key;
  readonly service: UpdateService;
  readonly staging: string;
  readonly journalPath: string;
}

/**
 * A service over a data directory.
 *
 * `dir` and `key` are parameters so a RESTART can be expressed: the same
 * installation is the same directory and the same pin, and a fresh directory
 * with a fresh key proves nothing about durability.
 */
async function world(options: { dir?: string; key?: Key } = {}): Promise<World> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "relayium-update-native-")));
  if (options.dir === undefined) owned.push(dir);
  const key = options.key ?? ephemeralKey();
  const document = {
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
  };
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  const signature = sign(null, bytes, key.privateKey).toString("base64url");
  const trust: UpdateTrust = {
    ...PRODUCTION_TRUST_BASE,
    publicKeys: [key.encoded],
    // Unset, exactly as production: the install path is unreachable and the
    // artifact is classified, not approved.
    expectedPublisher: null,
  };
  const fetchImpl = (async (url: string | URL): Promise<Response> => {
    const target = String(url);
    if (target.endsWith(".sig")) return new Response(signature, { status: 200 });
    if (target === trust.feedUrl) {
      return new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200 });
    }
    return new Response(PAYLOAD as Uint8Array<ArrayBuffer>, { status: 200 });
  }) as unknown as typeof fetch;
  return {
    dir,
    key,
    staging: join(dir, "updates"),
    journalPath: join(dir, "updates", "candidate.json"),
    service: new UpdateService({
      trust,
      engineering: false,
      current: { version: "0.2.0", build: 7 },
      dataDirectory: dir,
      // The REAL preview verifier, not a stub.
      //
      // A hard-coded `unsigned` would produce the same states while proving
      // nothing about the path that produces them: the `PublisherPreview` shape,
      // the `install.verify` framing, the pinless classification, and the
      // helper's own reading of an unsigned file would all be bypassed. The
      // fixture bytes are genuinely unsigned, so the honest verdict is
      // `unsigned` and the state is `ready-unsigned` — but now because Windows
      // said so, through the adapter under test.
      //
      // `expectedPublisher: null` matches production: nothing is pinned, so the
      // helper classifies without comparing and can never answer `expected`.
      verifier: nativePublisherVerifier({ helperPath, expectedPublisher: null }),
      feed: { fetchImpl },
      artifact: { fetchImpl },
      scope: nativeScopeProvider({ helperPath }),
    }),
  };
}

interface Record {
  readonly candidate: { version: string; build: number; nonce: string; receipt: string } | null;
  readonly pending: unknown;
  readonly residue: readonly { detail: string; owned: boolean }[];
}

const readRecord = async (path: string): Promise<Record> =>
  JSON.parse(await readFile(path, "utf8")) as Record;

const stagedName = (record: Record): string =>
  `relayium-0.3.0-9-${record.candidate?.nonce ?? "missing"}.exe`;

const exeCount = async (staging: string): Promise<number> =>
  (await readdir(staging)).filter((name) => name.endsWith(".exe")).length;

describeOnWindows("the update core over the native helper", () => {
  it("has the packaged helper to run against", () => {
    // Asserted, not skipped: a Windows build without this binary has no update
    // capability, and reporting green for it would be the false claim.
    expect(existsSync(helperPath), `no helper at ${helperPath}`).toBe(true);
  });

  it("classifies the downloaded artifact through the real preview adapter", async () => {
    // The composition this suite exists to cover: core -> native-scope ->
    // helper -> WinVerifyTrust, on bytes that carry no signature.
    const w = await world();
    expect((await w.service.check()).kind).toBe("update-available");
    const state = await w.service.download();
    await w.service.quiesce();
    // Not `verifier-unavailable`: the check RAN and answered. Not `ready`:
    // nothing may install on an unsigned artifact.
    expect(state.kind).toBe("ready-unsigned");
  });

  it("survives a restart of the SAME installation", async () => {
    const first = await world();
    expect((await first.service.check()).kind).toBe("update-available");
    expect((await first.service.download()).kind).toBe("ready-unsigned");
    await first.service.quiesce();
    const before = await readRecord(first.journalPath);
    expect(before.candidate?.receipt).toMatch(/^win:[0-9a-f]+:[0-9a-f]+$/);

    // The same directory and the same pin. A new directory or a new key would
    // be a different installation, and would prove nothing about durability.
    const restarted = await world({ dir: first.dir, key: first.key });
    const state = await restarted.service.reverifyStaged();
    await restarted.service.quiesce();

    expect(state.kind).toBe("ready-unsigned");
    const after = await readRecord(first.journalPath);
    // The same OBJECT, still: the receipt is what proves it across the restart.
    expect(after.candidate?.receipt).toBe(before.candidate?.receipt);
    expect(after.candidate?.nonce).toBe(before.candidate?.nonce);
    expect(await exeCount(first.staging)).toBe(1);
  });

  it("preserves a replacement, and still cleans up what it does own", async () => {
    const first = await world();
    await first.service.check();
    await first.service.download();
    await first.service.quiesce();
    const record = await readRecord(first.journalPath);
    const staged = join(first.staging, stagedName(record));

    // Replaced between runs: same name, different object.
    await rm(staged);
    await writeFile(staged, "a different file", "utf8");

    const restarted = await world({ dir: first.dir, key: first.key });
    const state = await restarted.service.reverifyStaged();
    await restarted.service.quiesce();

    expect(await readFile(staged, "utf8")).toBe("a different file");
    expect(state.kind).toBe("verify-failed");
    const after = await readRecord(first.journalPath);
    expect(after.candidate).toBeNull();
    expect(after.residue).toMatchObject([{ detail: "identity-changed", owned: false }]);

    // POSITIVE CONTROL. Preserving must not be "never deletes anything": an
    // untouched candidate this installation created IS removed when the running
    // build has caught up with it.
    const clean = await world();
    await clean.service.check();
    await clean.service.download();
    await clean.service.quiesce();
    expect(await exeCount(clean.staging)).toBe(1);
    // A service already AT that build retires the staged candidate.
    const superseded = new UpdateService({
      trust: {
        ...PRODUCTION_TRUST_BASE,
        publicKeys: [clean.key.encoded],
        expectedPublisher: null,
      },
      engineering: false,
      current: { version: "0.3.0", build: 9 },
      dataDirectory: clean.dir,
      verifier: { verify: async () => "unsigned" },
      scope: nativeScopeProvider({ helperPath }),
    });
    expect((await superseded.reverifyStaged()).kind).toBe("up-to-date");
    await superseded.quiesce();
    expect(await exeCount(clean.staging)).toBe(0);
  });

  it("refuses a junction at the staging directory and leaves its target alone", async () => {
    const w = await world();
    // The journal must exist first, so the refusal is the SCOPE's and not a
    // missing record: this is the `blocked` path, not `journal-unavailable`.
    expect((await w.service.check()).kind).toBe("update-available");

    const sibling = join(w.dir, "elsewhere");
    await mkdir(sibling, { recursive: true });
    const sentinel = join(sibling, "must-survive.txt");
    await writeFile(sentinel, "untouched", "utf8");
    await rm(w.staging, { recursive: true, force: true });
    const linked = spawnSync("cmd", ["/c", "mklink", "/J", w.staging, sibling], {
      encoding: "utf8",
    });
    expect(linked.status, linked.stderr).toBe(0);

    const state = await w.service.download();
    await w.service.quiesce();

    // Exact, not a union of acceptable states.
    expect(state).toEqual({
      kind: "blocked",
      reason: "staging-unowned",
      count: 0,
      detail: "redirected",
    });
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
    expect(await readdir(sibling)).toEqual(["must-survive.txt"]);
    // The junction is removed without descending, so cleanup cannot reach the
    // sibling either.
    await rm(w.staging, { recursive: true, force: true });
  });
});

describe("the platform default", () => {
  it("is fail-closed on Windows regardless of this suite", async () => {
    const { defaultScopeProvider, failClosedScopeProvider } = await import(
      "../../src/main/update/custody.js"
    );
    expect(defaultScopeProvider("win32")).toBe(failClosedScopeProvider);
  });
});
