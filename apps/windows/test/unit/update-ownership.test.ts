// The ownership boundary, adversarially.
//
// Everything here is about what an UNSIGNED LOCAL FILE is allowed to make this
// process do. The journal is exactly that, and the answers must be: it cannot
// name a file to delete, it cannot vouch for a candidate, and it cannot be
// reset away by a transient read error.
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JournalError, UpdateJournal, parseJournal } from "../../src/main/update/journal.js";
import { UpdateService } from "../../src/main/update/service.js";
import {
  StagingError,
  retireCandidate,
  stagedFileName,
  stagedPath,
} from "../../src/main/update/staging.js";
import { posixScopeProvider } from "../../src/main/update/custody.js";
import { PRODUCTION_TRUST_BASE, type UpdateTrust } from "../../src/main/update/trust.js";

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
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "relayium-update-own-"));
  owned.push(dir);
  return dir;
}

function ephemeralKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  return { encoded: jwk.x ?? "", privateKey };
}

/** A fixed nonce keeps the derived name predictable in tests; production mints
 *  a fresh one for every attempt, which is what makes recovery decidable. */
const NONCE = "0011223344556677";
/** A receipt that names no object on this machine: records alone authorize
 *  nothing, which is exactly what most of these tests assert. */
const RECEIPT_FIXTURE = "posix:0:0";


/** The receipt token the capability mints: the object's device and inode. A
 *  test that wants a delete to be authorized has to name the real object. */
async function rewriteReceipt(journalPath: string, receipt: string): Promise<void> {
  const document = JSON.parse(await readFile(journalPath, "utf8")) as {
    candidate: Record<string, unknown> | null;
  };
  if (document.candidate) document.candidate["receipt"] = receipt;
  await writeFile(journalPath, JSON.stringify(document), "utf8");
}

async function receiptOf(path: string): Promise<string> {
  const info = await stat(path);
  return `posix:${info.dev.toString(16)}:${info.ino.toString(16)}`;
}

const PAYLOAD = new Uint8Array(64).fill(4);
const SHA = createHash("sha256").update(PAYLOAD).digest("hex");

const manifestFor = (version: string, build: number) => ({
  schema: 1,
  product: "relayium-windows",
  channel: "stable",
  platform: "windows",
  arch: "x64",
  version,
  build,
  artifact: {
    url: "https://github.com/relayium/relayium/releases/download/x/Setup.exe",
    sizeBytes: PAYLOAD.byteLength,
    sha256: SHA,
  },
  publishedAt: 1_789_000_000,
  notesUrl: null,
});

function signedPair(document: unknown, key: ReturnType<typeof ephemeralKey>) {
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  return {
    metadata: Buffer.from(bytes).toString("base64"),
    signature: sign(null, bytes, key.privateKey).toString("base64url"),
  };
}

const trustFor = (key: ReturnType<typeof ephemeralKey>): UpdateTrust => ({
  ...PRODUCTION_TRUST_BASE,
  publicKeys: [key.encoded],
  expectedPublisher: "CN=Relayium",
});

function serviceOver(dir: string, key: ReturnType<typeof ephemeralKey>, current = { version: "1.0.0", build: 2 }) {
  return new UpdateService({
    trust: trustFor(key),
    engineering: false,
    current,
    dataDirectory: dir,
    verifier: { verify: async () => "signed-by-expected-publisher" },
    installer: { installVerified: async () => ({ outcome: "launched" }) },
    revealer: { reveal: async () => undefined },
    quiesceConsent: {
      request: async () => ({ granted: true, lease: { release: async () => ({ outcome: "resumed" }) } }),
    },
    // EXPLICIT, never the platform default — see the note above.
    scope: posixScopeProvider,
  });
}

describeOnPosix("a forged journal cannot name a file", () => {
  it("does not delete a file outside owned staging", async () => {
    // Root's probe, as a unit test. The record names a victim outside
    // `updates/` and an older build, so the old code's retire path deleted it.
    const dir = await root();
    const data = join(dir, "data");
    const victim = join(dir, "unrelated-user-file.txt");
    await mkdir(join(data, "updates"), { recursive: true });
    await writeFile(victim, "must survive", "utf8");
    await writeFile(
      join(data, "updates", "candidate.json"),
      JSON.stringify({
        v: 1,
        lastCheckedAt: null,
        candidate: {
          version: "0.9.0",
          build: 1,
          sizeBytes: 12,
          sha256: "0".repeat(64),
          path: victim,
          notesUrl: null,
        },
      }),
      "utf8",
    );
    const service = serviceOver(data, ephemeralKey());
    await service.reverifyStaged();
    await service.quiesce();
    expect(await readFile(victim, "utf8")).toBe("must survive");
  });

  it("refuses the whole record when it carries a `path` at all", () => {
    // Not ignored: a `path` field means the document came from a revision whose
    // paths were authority, and dropping it silently would make a downgrade
    // indistinguishable from an upgrade.
    expect(() =>
      parseJournal(
        JSON.stringify({
          v: 1,
          lastCheckedAt: null,
          candidate: { version: "1.0.0", build: 2, nonce: NONCE, receipt: RECEIPT_FIXTURE, metadata: "AAAA", signature: "AAAA", path: "/etc/passwd" },
          residue: [],
        }),
      ),
    ).toThrow(JournalError);
  });

  it("derives one inert filename, and refuses an identity that cannot make one", () => {
    expect(stagedFileName({ version: "1.2.3", build: 45, nonce: NONCE })).toBe(
      `relayium-1.2.3-45-${NONCE}.exe`,
    );
    const dir = "/tmp/data";
    expect(stagedPath(dir, { version: "1.2.3", build: 45, nonce: NONCE })).toBe(
      join(dir, "updates", `relayium-1.2.3-45-${NONCE}.exe`),
    );
    for (const identity of [
      { version: "../../etc/passwd", build: 1, nonce: NONCE },
      { version: "1.2.3/../..", build: 1, nonce: NONCE },
      { version: "C:\\evil", build: 1, nonce: NONCE },
      { version: "1.2.3", build: 0, nonce: NONCE },
      { version: "1.2.3", build: -1, nonce: NONCE },
      { version: "1.2.3", build: 1.5, nonce: NONCE },
      { version: "", build: 1, nonce: NONCE },
      // A nonce is part of the identity, and a forged one that could escape the
      // directory must not produce a name either.
      { version: "1.2.3", build: 1, nonce: "../../etc/passwd" },
      { version: "1.2.3", build: 1, nonce: "SHOUTING12345678" },
      { version: "1.2.3", build: 1, nonce: "" },
    ]) {
      expect(() => stagedFileName(identity), JSON.stringify(identity)).toThrow(StagingError);
    }
  });

  it("retiring an unnameable identity deletes nothing", async () => {
    const dir = await root();
    const victim = join(dir, "victim.txt");
    await writeFile(victim, "here", "utf8");
    // Even an identity crafted to escape produces no path and so no delete.
    const outcome = await retireCandidate(
      dir,
      { version: "../victim.txt", build: 1 } as never,
      await receiptOf(victim),
    );
    // Not `gone`: nothing was looked at and nothing was removed, so reporting a
    // confirmed absence would be a claim this never established. Note the
    // receipt is the VICTIM's — a real receipt for the wrong name authorizes
    // nothing either.
    expect(outcome).toEqual({ outcome: "residue", detail: "bad-identity" });
    expect(await readFile(victim, "utf8")).toBe("here");
  });
});

describeOnPosix("a forged journal cannot vouch for a candidate", () => {
  it("refuses metadata that is not signed by the pin, and clears it", async () => {
    const dir = await root();
    const mine = ephemeralKey();
    const theirs = ephemeralKey();
    await mkdir(join(dir, "updates"), { recursive: true });
    // A perfectly well-formed record — signed by the wrong key.
    await writeFile(
      join(dir, "updates", "candidate.json"),
      JSON.stringify({
        v: 1,
        lastCheckedAt: null,
        candidate: { version: "9.9.9", build: 99, nonce: NONCE, receipt: RECEIPT_FIXTURE, ...signedPair(manifestFor("9.9.9", 99), theirs) },
        residue: [],
      }),
      "utf8",
    );
    const service = serviceOver(dir, mine);
    expect((await service.reverifyStaged()).kind).toBe("feed-untrusted");
  });

  it("refuses a SUBSTITUTED signed manifest whose identity is not the record's", async () => {
    // The substitution attack the plain-field journal allowed: take a genuinely
    // signed OLD manifest and file it under a NEW identity, so the derived path
    // points at an installer the attacker has, while the record claims a newer
    // build. The identity in the record must match the VERIFIED manifest.
    const dir = await root();
    const key = ephemeralKey();
    await mkdir(join(dir, "updates"), { recursive: true });
    await writeFile(
      join(dir, "updates", "candidate.json"),
      JSON.stringify({
        v: 1,
        lastCheckedAt: null,
        // Signed bytes say 0.1.0/1; the record claims 9.9.9/99.
        candidate: { version: "9.9.9", build: 99, nonce: NONCE, receipt: RECEIPT_FIXTURE, ...signedPair(manifestFor("0.1.0", 1), key) },
        residue: [],
      }),
      "utf8",
    );
    const service = serviceOver(dir, key);
    const state = await service.reverifyStaged();
    expect(state).toEqual({ kind: "feed-untrusted", detail: "identity-mismatch" });
  });

  it("takes build, size and digest from the VERIFIED manifest, not the record", async () => {
    const dir = await root();
    const key = ephemeralKey();
    await mkdir(join(dir, "updates"), { recursive: true });
    // A real, signed 5.0.0/50 manifest, and a staged file that matches it.
    const document = manifestFor("5.0.0", 50);
    await writeFile(
      join(dir, "updates", "candidate.json"),
      JSON.stringify({
        v: 1,
        lastCheckedAt: null,
        candidate: { version: "5.0.0", build: 50, nonce: NONCE, receipt: RECEIPT_FIXTURE, ...signedPair(document, key) },
        residue: [],
      }),
      "utf8",
    );
    const staged = join(dir, "updates", `relayium-5.0.0-50-${NONCE}.exe`);
    await writeFile(staged, PAYLOAD);
    await rewriteReceipt(join(dir, "updates", "candidate.json"), await receiptOf(staged));
    const service = serviceOver(dir, key, { version: "1.0.0", build: 2 });
    const state = await service.reverifyStaged();
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    // These came from the re-verified manifest.
    expect(state.candidate).toMatchObject({ version: "5.0.0", build: 50, sizeBytes: 64, sha256: SHA });
  });
});

describeOnPosix("the journal is never reset away", () => {
  it("refuses a corrupt document and leaves the file untouched", async () => {
    const dir = await root();
    await mkdir(join(dir, "updates"), { recursive: true });
    const path = join(dir, "updates", "candidate.json");
    await writeFile(path, "{ not json", "utf8");
    const journal = new UpdateJournal(dir, posixScopeProvider);
    await expect(journal.read()).rejects.toMatchObject({ code: "corrupt" });
    // Preserved, byte for byte: a refusal is not a repair.
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });

  it("surfaces a corrupt record as a refusal state, not as `nothing staged`", async () => {
    const dir = await root();
    await mkdir(join(dir, "updates"), { recursive: true });
    await writeFile(join(dir, "updates", "candidate.json"), '{"v":2}', "utf8");
    const service = serviceOver(dir, ephemeralKey());
    expect(await service.reverifyStaged()).toEqual({ kind: "journal-unavailable", reason: "corrupt" });
  });

  it("treats only ENOENT as empty", async () => {
    const dir = await root();
    // No file at all.
    const journal = new UpdateJournal(dir, posixScopeProvider);
    await expect(journal.read()).resolves.toMatchObject({ candidate: null, residue: [] });
  });

  it("serializes overlapping reads so none can publish a half-loaded state", async () => {
    const dir = await root();
    const key = ephemeralKey();
    await mkdir(join(dir, "updates"), { recursive: true });
    const document = manifestFor("5.0.0", 50);
    await writeFile(
      join(dir, "updates", "candidate.json"),
      JSON.stringify({
        v: 1,
        lastCheckedAt: 42,
        candidate: { version: "5.0.0", build: 50, nonce: NONCE, receipt: RECEIPT_FIXTURE, ...signedPair(document, key) },
        residue: [],
      }),
      "utf8",
    );
    const journal = new UpdateJournal(dir, posixScopeProvider);
    // Three concurrent reads, and a write racing them.
    const [a, b, c] = await Promise.all([
      journal.read(),
      journal.read(),
      journal.update((current) => ({ ...current, lastCheckedAt: 99 })),
    ]);
    // Every reader saw a COMPLETE document — never an empty one — and the
    // writer did not lose the candidate.
    for (const seen of [a, b, c]) {
      expect(seen.candidate?.build).toBe(50);
    }
    expect((await journal.read()).lastCheckedAt).toBe(99);
  });

  it("bounds the residue list rather than trusting its length", () => {
    const residue = Array.from({ length: 9 }, (_, i) => ({
      version: "1.0.0",
      build: i + 1,
      nonce: NONCE,
      attempts: 1,
      detail: "x",
      receipt: RECEIPT_FIXTURE,
      owned: true,
    }));
    expect(() =>
      parseJournal(JSON.stringify({ v: 1, lastCheckedAt: null, candidate: null, residue })),
    ).toThrow(/corrupt/);
  });
});

describeOnPosix("cleanup ownership survives a failed delete", () => {
  it("confirms absence before reporting `gone`", async () => {
    const dir = await root();
    await mkdir(join(dir, "updates"), { recursive: true });
    const identity = { version: "1.0.0", build: 3, nonce: NONCE };
    await writeFile(stagedPath(dir, identity), PAYLOAD);
    const receipt = await receiptOf(stagedPath(dir, identity));
    expect(await retireCandidate(dir, identity, receipt)).toEqual({ outcome: "gone" });
    expect(await readdir(join(dir, "updates"))).toEqual([]);
    // And a second retire of something already absent is still `gone`.
    expect(await retireCandidate(dir, identity, receipt)).toEqual({ outcome: "gone" });
  });

  it("refuses to retire a DIFFERENT object that took the same name", async () => {
    // Root's held-identity finding: the record still names the slot, but the
    // object in it is not the one this installation created.
    const dir = await root();
    await mkdir(join(dir, "updates"), { recursive: true });
    const identity = { version: "1.0.0", build: 3, nonce: NONCE };
    const path = stagedPath(dir, identity);
    await writeFile(path, PAYLOAD);
    const receipt = await receiptOf(path);
    await rm(path);
    await writeFile(path, "someone else's bytes", "utf8");

    expect(await retireCandidate(dir, identity, receipt)).toEqual({
      outcome: "residue",
      detail: "identity-changed",
    });
    expect(await readFile(path, "utf8")).toBe("someone else's bytes");
  });

  it("reports residue when the file is still there afterwards", async () => {
    const dir = await root();
    await mkdir(join(dir, "updates"), { recursive: true });
    const identity = { version: "1.0.0", build: 4, nonce: NONCE };
    // A DIRECTORY at the file's path: `rm` without `recursive` cannot remove
    // it, so the confirmation finds it still present — which is the shape a
    // locked file has on Windows.
    await mkdir(stagedPath(dir, identity), { recursive: true });
    const outcome = await retireCandidate(dir, identity, RECEIPT_FIXTURE);
    expect(outcome.outcome).toBe("residue");
  });

  it("keeps the record and records residue when a retire cannot confirm", async () => {
    const dir = await root();
    const key = ephemeralKey();
    await mkdir(join(dir, "updates"), { recursive: true });
    const identity = { version: "5.0.0", build: 50, nonce: NONCE };
    const document = manifestFor(identity.version, identity.build);
    await writeFile(
      join(dir, "updates", "candidate.json"),
      JSON.stringify({
        v: 1,
        lastCheckedAt: null,
        candidate: { version: identity.version, build: identity.build, nonce: NONCE, receipt: RECEIPT_FIXTURE, ...signedPair(document, key) },
        residue: [],
      }),
      "utf8",
    );
    // Undeletable: a directory where the staged file would be.
    await mkdir(stagedPath(dir, identity), { recursive: true });
    // Current build is newer, so `reverifyStaged` retires the candidate.
    const service = serviceOver(dir, key, { version: "9.0.0", build: 90 });
    await service.reverifyStaged();
    const after = JSON.parse(
      await readFile(join(dir, "updates", "candidate.json"), "utf8"),
    ) as { candidate: unknown; residue: { version: string; build: number; attempts: number }[] };
    // The residue is recorded AND the candidate record is retained: clearing it
    // would lose the only thing that can retry the deletion.
    expect(after.residue).toHaveLength(1);
    expect(after.residue[0]).toMatchObject({ version: "5.0.0", build: 50, attempts: 1 });
    expect(after.candidate).not.toBeNull();
    expect(await service.residue()).toHaveLength(1);
  });
});
