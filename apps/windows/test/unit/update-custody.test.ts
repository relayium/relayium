// Custody, adversarially.
//
// One question runs through every case: WHAT DID THIS PROCESS ACTUALLY CREATE?
// A derived name is not an answer, and neither is a directory called `updates`.
// Root's three compiled failures were all the same mistake read three ways — a
// filesystem effect authorized by a name — so these tests check the effect, not
// the code path: the foreign bytes are still there, the external file is still
// there, and nothing is left on disk that no record owns.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CustodyError,
  defaultScopeProvider,
  failClosedScopeProvider,
  posixScopeProvider,
  type OwnedFile,
  type StagingScope,
  type StagingScopeProvider,
} from "../../src/main/update/custody.js";
import { UpdateJournal, parseJournal } from "../../src/main/update/journal.js";
import { UpdateService } from "../../src/main/update/service.js";
import { retireCandidate } from "../../src/main/update/staging.js";
import { PRODUCTION_TRUST_BASE, type UpdateTrust } from "../../src/main/update/trust.js";

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
  for (const scope of scopes.splice(0)) await scope.close();
  for (const dir of owned.splice(0)) {
    // A case that made staging read-only has to be made removable again.
    await chmod(join(dir, "data", "updates"), 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "relayium-update-custody-"));
  owned.push(dir);
  return dir;
}

const PAYLOAD = new Uint8Array(1024).fill(5);
const SHA = createHash("sha256").update(PAYLOAD).digest("hex");
const RELEASE = "https://github.com/relayium/relayium/releases/download/windows-v0.3.0/Setup.exe";
/** A fixed nonce for fixtures. Production mints one per attempt — see below. */
const NONCE = "0011223344556677";
const STAGED = `relayium-0.3.0-9-${NONCE}.exe`;
/** The name a predictable derivation WOULD have produced. Nothing may act on
 *  it: it is exactly the name an unrelated program might also have chosen. */
const GUESSABLE = "relayium-0.3.0-9.exe";

const stagedFiles = async (staging: string): Promise<string[]> =>
  (await readdir(staging)).filter((name) => name.endsWith(".exe"));

/** The receipt token the capability mints: the object's device and inode. */
async function receiptOf(path: string): Promise<string> {
  const info = await stat(path);
  return `posix:${info.dev.toString(16)}:${info.ino.toString(16)}`;
}

const claimDocument = (receipt: string | null, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    lastCheckedAt: null,
    candidate: null,
    pending: { version: "0.3.0", build: 9, nonce: NONCE, receipt },
    residue: [],
    ...extra,
  });

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

interface World {
  readonly service: UpdateService;
  readonly data: string;
  readonly staging: string;
  readonly journalPath: string;
}

/**
 * A service over a real data directory, with a real signed feed.
 *
 * `onBody` runs when the artifact request is served and `onSettled` after the
 * bytes are flushed — the two moments the ownership seams live between.
 */
async function world(options: {
  readonly dir?: string;
  readonly scope?: StagingScopeProvider;
  readonly onBody?: () => Promise<void> | void;
  readonly onSettled?: () => Promise<void> | void;
  readonly failCommit?: boolean;
} = {}): Promise<World> {
  const dir = options.dir ?? (await root());
  const data = join(dir, "data");
  await mkdir(data, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  const signature = sign(null, bytes, privateKey).toString("base64url");
  const trust: UpdateTrust = {
    ...PRODUCTION_TRUST_BASE,
    publicKeys: [jwk.x ?? ""],
    expectedPublisher: "CN=Relayium",
  };
  const fetchImpl = (async (url: string | URL): Promise<Response> => {
    const target = String(url);
    if (target.endsWith(".sig")) return new Response(signature, { status: 200 });
    if (target === trust.feedUrl) {
      return new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200 });
    }
    await options.onBody?.();
    return new Response(PAYLOAD as Uint8Array<ArrayBuffer>, { status: 200 });
  }) as unknown as typeof fetch;
  const plain = options.scope ?? posixScopeProvider;
  const base: StagingScopeProvider = options.failCommit
    ? {
        open: async (appRoot, component) => {
          const scope = await plain.open(appRoot, component);
          return Object.assign(Object.create(Object.getPrototypeOf(scope) as object), scope, {
            commit: async () => {
              throw new CustodyError("io", "EPERM");
            },
          }) as StagingScope;
        },
      }
    : plain;
  // A scope decorator that fires `onSettled` for the ARTIFACT only. The journal
  // writes through the same capability, so a blanket hook would fire on its
  // temp file too and break the check that has to succeed first.
  const provider: StagingScopeProvider =
    options.onSettled === undefined
      ? base
      : {
          open: async (appRoot, component) => {
            const scope = await base.open(appRoot, component);
            return {
              directory: scope.directory,
              pathFor: (name) => scope.pathFor(name),
              identityOf: (name) => scope.identityOf(name),
              removeOwned: (name, receipt) => scope.removeOwned(name, receipt),
              readBounded: (name, max) => scope.readBounded(name, max),
              hashOwned: (name, receipt, bytes) => scope.hashOwned(name, receipt, bytes),
              commit: (file, to) => scope.commit(file, to),
              close: () => scope.close(),
              createExclusive: async (name): Promise<OwnedFile> => {
                const file = await scope.createExclusive(name);
                if (!name.endsWith(".exe")) return file;
                return {
                  name: file.name,
                  path: file.path,
                  receipt: file.receipt,
                  write: (chunk) => file.write(chunk),
                  close: () => file.close(),
                  discard: () => file.discard(),
                  // The last thing the download does. Anything scheduled here
                  // lands strictly between "the bytes are ours" and "the record
                  // says so".
                  sync: async () => {
                    await file.sync();
                    await options.onSettled?.();
                  },
                };
              },
            } satisfies StagingScope;
          },
        };
  return {
    service: new UpdateService({
      trust,
      engineering: false,
      current: { version: "0.2.0", build: 7 },
      dataDirectory: data,
      verifier: { verify: async () => "signed-by-expected-publisher" },
      feed: { fetchImpl },
      artifact: { fetchImpl },
      scope: provider,
    }),
    data,
    staging: join(data, "updates"),
    journalPath: join(data, "updates", "candidate.json"),
  };
}

/** A held scope the suite closes for us: the descriptor is a capability. */
async function heldScope(data: string): Promise<StagingScope> {
  const scope = await posixScopeProvider.open(data, "updates");
  scopes.push(scope);
  return scope;
}

const readJournal = async (path: string) => parseJournal(await readFile(path, "utf8"));

describeOnPosix("a name this installation did not choose", () => {
  it("is never staged over, because the staged name carries a nonce", async () => {
    // Root's first compiled failure was a delete authorized by a DERIVED name.
    // The deeper fix is that the derived name is not guessable at all: a file
    // sitting at the name a previous design would have used is simply not this
    // download's business.
    const w = await world();
    await mkdir(w.staging, { recursive: true });
    expect((await w.service.check()).kind).toBe("update-available");
    await writeFile(join(w.staging, GUESSABLE), "preexisting must survive", "utf8");
    await w.service.download();
    await w.service.quiesce();

    expect(await readFile(join(w.staging, GUESSABLE), "utf8")).toBe("preexisting must survive");
    const journal = await readJournal(w.journalPath);
    expect(journal.candidate?.nonce).toMatch(/^[0-9a-f]{16}$/);
    expect(journal.candidate?.nonce).not.toBe("");
    // Two attempts never share a name, so one can never retire the other's.
    const names = (await stagedFiles(w.staging)).filter((name) => name !== GUESSABLE);
    expect(names).toHaveLength(1);
    expect(names[0]).toBe(`relayium-0.3.0-9-${journal.candidate?.nonce ?? ""}.exe`);
  });

  it("survives a fresh service that finds an unproven claim next to it", async () => {
    // Root's second RED, exactly: intent recorded, then a file at that name.
    // "I meant to create this" and "I created this" are identical on disk, so
    // the bytes are KEPT.
    const w = await world();
    await mkdir(w.staging, { recursive: true });
    await writeFile(join(w.staging, STAGED), "not ours", "utf8");
    await writeFile(w.journalPath, claimDocument(null), "utf8");

    const state = await w.service.reverifyStaged();
    await w.service.quiesce();

    expect(await readFile(join(w.staging, STAGED), "utf8")).toBe("not ours");
    // And it is reported rather than forgotten: ambiguous, retained, bounded.
    const journal = await readJournal(w.journalPath);
    expect(journal.pending).toBeNull();
    expect(journal.residue).toEqual([
      {
        version: "0.3.0",
        build: 9,
        nonce: NONCE,
        attempts: 0,
        detail: "unproven-claim",
        receipt: null,
        owned: false,
      },
    ]);
    // `owned: false` is the distinction that matters: it is reported, and it is
    // never a deletion this installation will retry.
    expect(state.kind).toBe("idle");
    w.service.resume();
    expect(await w.service.residue()).toMatchObject([{ owned: false, detail: "unproven-claim" }]);
  });

  it("blocks new work once ambiguity fills the bound, rather than evicting it", async () => {
    const w = await world();
    await mkdir(w.staging, { recursive: true });
    const residue = Array.from({ length: 4 }, (_, i) => ({
      version: "0.1.0",
      build: i + 1,
      nonce: NONCE,
      attempts: 0,
      detail: "unproven-claim",
      receipt: null,
      owned: false,
    }));
    await writeFile(
      w.journalPath,
      JSON.stringify({ v: 1, lastCheckedAt: null, candidate: null, pending: null, residue }),
      "utf8",
    );
    expect((await w.service.check()).kind).toBe("update-available");
    const state = await w.service.download();
    await w.service.quiesce();
    expect(state).toMatchObject({ kind: "blocked", reason: "unresolved-residue", count: 4 });
    expect(await stagedFiles(w.staging)).toEqual([]);
  });

  it("removes the file only when the receipt still describes it", async () => {
    const w = await world();
    await mkdir(w.staging, { recursive: true });
    await writeFile(join(w.staging, STAGED), "half a download", "utf8");
    await writeFile(w.journalPath, claimDocument(await receiptOf(join(w.staging, STAGED))), "utf8");

    const state = await w.service.reverifyStaged();
    await w.service.quiesce();

    expect(state.kind).toBe("idle");
    await expect(stat(join(w.staging, STAGED))).rejects.toThrow();
    expect((await readJournal(w.journalPath)).pending).toBeNull();
  });

  it("PRESERVES a replacement that took the claimed name", async () => {
    // Root's held-identity RED: a durable receipt, then the original renamed
    // away and different bytes left at the same name. The record names the
    // slot; it does not name what is in it.
    const w = await world();
    await mkdir(w.staging, { recursive: true });
    const path = join(w.staging, STAGED);
    await writeFile(path, "the original", "utf8");
    const receipt = await receiptOf(path);
    await rm(path);
    await writeFile(path, "a different file", "utf8");
    await writeFile(w.journalPath, claimDocument(receipt), "utf8");

    await w.service.reverifyStaged();
    await w.service.quiesce();

    expect(await readFile(path, "utf8")).toBe("a different file");
    const journal = await readJournal(w.journalPath);
    expect(journal.pending).toBeNull();
    expect(journal.residue).toMatchObject([{ detail: "identity-changed", owned: false }]);
  });

  it("drops an unproven claim cleanly when nothing was ever created", async () => {
    // The common crash window: the intent landed, the create never ran. There
    // is nothing at that nonce, so there is nothing ambiguous to retain.
    const w = await world();
    await mkdir(w.staging, { recursive: true });
    await writeFile(w.journalPath, claimDocument(null), "utf8");

    const state = await w.service.reverifyStaged();
    await w.service.quiesce();

    expect(state).toMatchObject({ kind: "idle" });
    const journal = await readJournal(w.journalPath);
    expect(journal.pending).toBeNull();
    expect(journal.residue).toEqual([]);
  });
});

describeOnPosix("a journal that fails after the bytes land", () => {
  it("destroys what it owns rather than orphaning it", async () => {
    // Root's second compiled failure: the .exe stayed and `residue()` said the
    // installation was clean. The commit is broken only AFTER the download has
    // succeeded, which is the seam a pre-download check cannot reach.
    const w = await world({
      onSettled: async () => {
        await rm(w.journalPath);
        await mkdir(w.journalPath);
      },
    });
    expect((await w.service.check()).kind).toBe("update-available");
    const state = await w.service.download();
    await w.service.quiesce();

    expect(state.kind).toBe("journal-unavailable");
    expect((await readdir(w.staging)).filter((n) => n.endsWith(".exe"))).toEqual([]);
  });

  it("retains a truthful residue when it cannot destroy them either", async () => {
    // Delete AND record both impossible: the honest outcome is a retained,
    // bounded residue that `residue()` actually reports.
    const w = await world({
      onSettled: async () => {
        await chmod(w.staging, 0o500);
      },
    });
    await w.service.check();
    const state = await w.service.download();
    await w.service.quiesce();

    expect(state.kind).toBe("journal-unavailable");
    expect(await stagedFiles(w.staging)).toHaveLength(1);
    const residue = await w.service.residue();
    expect(residue).toHaveLength(1);
    // OWNED residue: this installation created the file, so the deletion is one
    // it may retry. That is the difference from an unproven claim.
    expect(residue[0]).toMatchObject({ version: "0.3.0", build: 9, owned: true });
  });

  it("keeps the claim durable, so a later run can still reclaim the name", async () => {
    // The claim precedes the file; a commit failure must not erase it, because
    // it is the only record that can clean up after a crash.
    const w = await world({
      onSettled: async () => {
        await chmod(w.staging, 0o500);
      },
    });
    await w.service.check();
    await w.service.download();
    await w.service.quiesce();
    await chmod(w.staging, 0o700);

    const journal = await readJournal(w.journalPath);
    // The receipt names the created OBJECT, which is what lets the next run
    // tell it from anything that later takes the same name.
    expect(journal.pending?.receipt).toMatch(/^posix:[0-9a-f]+:[0-9a-f]+$/);
    expect(journal.pending).toMatchObject({ version: "0.3.0", build: 9 });
    expect(journal.candidate).toBeNull();
  });
});

describeOnPosix("a cancel between the bytes and the record", () => {
  it("does not leave an unrecorded file behind", async () => {
    // The fence lands exactly once the bytes are flushed and before the commit,
    // so the download owns a file no record will ever name.
    const w: { current?: World } = {};
    w.current = await world({
      onSettled: () => {
        void w.current?.service.quiesce();
      },
    });
    const service = w.current.service;
    await service.check();
    await service.download();
    await service.quiesce();

    expect((await readdir(w.current.staging)).filter((n) => n.endsWith(".exe"))).toEqual([]);
    const journal = await readJournal(w.current.journalPath);
    expect(journal.candidate).toBeNull();
    expect(journal.pending).toBeNull();
  });
});

describeOnPosix("a claim left by an interrupted run", () => {
  it("survives an unrelated journal write", async () => {
    // A later admission must not drop pending ownership: `check()` writes the
    // check time through the same document.
    const w = await world();
    await mkdir(w.staging, { recursive: true });
    await writeFile(join(w.staging, STAGED), "half a download", "utf8");
    const receipt = await receiptOf(join(w.staging, STAGED));
    await writeFile(w.journalPath, claimDocument(receipt), "utf8");
    await w.service.check();
    await w.service.quiesce();
    const journal = await readJournal(w.journalPath);
    expect(journal.pending).toEqual({ version: "0.3.0", build: 9, nonce: NONCE, receipt });
    expect(journal.lastCheckedAt).not.toBeNull();
  });
});

describeOnPosix("a redirected staging directory", () => {
  it("cannot be used to delete an external file", async () => {
    // Root's third compiled failure. `updates` is a junction/symlink to a
    // directory that is not ours; the fixed lexical name proves nothing.
    const dir = await root();
    const data = join(dir, "data");
    const outside = join(dir, "outside");
    await mkdir(data, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(data, "updates"), "dir");
    const victim = join(outside, STAGED);
    await writeFile(victim, "outside must survive", "utf8");

    const outcome = await retireCandidate(
      data,
      { version: "0.3.0", build: 9, nonce: NONCE },
      await receiptOf(victim),
    );
    expect(outcome).toEqual({ outcome: "residue", detail: "redirected" });
    expect(await readFile(victim, "utf8")).toBe("outside must survive");
  });

  it("blocks a download instead of writing into it", async () => {
    const dir = await root();
    const data = join(dir, "data");
    const outside = join(dir, "outside");
    await mkdir(data, { recursive: true });
    await mkdir(outside, { recursive: true });
    const w = await world({ dir });
    expect((await w.service.check()).kind).toBe("update-available");
    // Redirect only after the check, so the journal already exists.
    await rm(join(data, "updates"), { recursive: true, force: true });
    await symlink(outside, join(data, "updates"), "dir");

    const state = await w.service.download();
    await w.service.quiesce();
    expect(state).toEqual({
      kind: "blocked",
      reason: "staging-unowned",
      count: 0,
      detail: "redirected",
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses to open a scope over a symlink at all", async () => {
    const dir = await root();
    const data = join(dir, "data");
    await mkdir(join(dir, "elsewhere"), { recursive: true });
    await mkdir(data, { recursive: true });
    await symlink(join(dir, "elsewhere"), join(data, "updates"), "dir");
    await expect(posixScopeProvider.open(data, "updates")).rejects.toMatchObject({
      code: "redirected",
    });
  });
});

describeOnPosix("a scope refuses what it did not create", () => {
  it("will not follow or delete a symlink planted at the staged name", async () => {
    const dir = await root();
    const data = join(dir, "data");
    await mkdir(data, { recursive: true });
    const victim = join(dir, "victim.txt");
    await writeFile(victim, "must survive", "utf8");
    const scope = await heldScope(data);
    await symlink(victim, join(scope.directory, STAGED));

    await expect(scope.createExclusive(STAGED)).rejects.toMatchObject({ code: "exists" });
    expect(await scope.removeOwned(STAGED, "posix:0:0")).toEqual({
      outcome: "residue",
      detail: "redirected",
    });
    expect(await readFile(victim, "utf8")).toBe("must survive");
    await scope.close();
  });

  it("will not COMMIT a temp whose object was swapped after the write", async () => {
    // The contract root named: two names give an implementation nothing to
    // authorize a rename with. `commit` takes the owned file, and a swapped
    // leaf is refused rather than published.
    const dir = await root();
    const data = join(dir, "data");
    await mkdir(data, { recursive: true });
    const scope = await heldScope(data);
    const file = await scope.createExclusive("candidate.json.aabbccddeeff.tmp");
    await file.write(Buffer.from('{"v":1}', "utf8"));
    await file.sync();
    await file.close();
    await rm(file.path);
    await writeFile(file.path, "somebody else's temp", "utf8");

    await expect(scope.commit(file, "candidate.json")).rejects.toMatchObject({
      code: "redirected",
      detail: "identity-changed",
    });
    // Not published, and the swapped file is still there to be looked at.
    await expect(stat(join(scope.directory, "candidate.json"))).rejects.toThrow();
    expect(await readFile(file.path, "utf8")).toBe("somebody else's temp");
    await scope.close();
  });

  it("hashes only while the object still matches the receipt", async () => {
    const dir = await root();
    const data = join(dir, "data");
    await mkdir(data, { recursive: true });
    const scope = await heldScope(data);
    const file = await scope.createExclusive(STAGED);
    const payload = Buffer.from("installer bytes");
    await file.write(payload);
    await file.sync();
    await file.close();
    const expected = createHash("sha256").update(payload).digest("hex");

    expect(await scope.hashOwned(STAGED, file.receipt, payload.byteLength)).toBe(expected);
    // A different object of the SAME length is not this candidate's bytes.
    await rm(file.path);
    await writeFile(file.path, Buffer.alloc(payload.byteLength, 0x41));
    expect(await scope.hashOwned(STAGED, file.receipt, payload.byteLength)).toBeNull();
    await scope.close();
  });

  it("will not discard an object that replaced the one it created", async () => {
    const dir = await root();
    const data = join(dir, "data");
    await mkdir(data, { recursive: true });
    const scope = await heldScope(data);
    const file = await scope.createExclusive(STAGED);
    await file.write(new Uint8Array([1, 2, 3]));
    await file.close();
    // Replaced by something else with the same name: the receipt names an
    // object, not a string.
    await rm(file.path);
    await writeFile(file.path, "a different file", "utf8");

    expect(await file.discard()).toEqual({ outcome: "residue", detail: "identity-changed" });
    expect(await readFile(file.path, "utf8")).toBe("a different file");
    await scope.close();
  });

  it("rejects a name that is not one inert component", async () => {
    const dir = await root();
    const data = join(dir, "data");
    await mkdir(data, { recursive: true });
    const scope = await heldScope(data);
    for (const name of ["../escape.exe", "sub/dir.exe", "..", ""]) {
      await expect(scope.createExclusive(name)).rejects.toBeInstanceOf(CustodyError);
    }
    await scope.close();
  });
});

describeOnPosix("the journal is written and read through custody too", () => {
  it("discards only the temp it created when the commit fails", async () => {
    // The earlier revision removed the temp by PATH in a `finally`, even when
    // the exclusive create had failed — the same ownership bug, on the temp.
    const w = await world({ failCommit: true });
    await mkdir(w.staging, { recursive: true });
    const bystander = join(w.staging, "candidate.json.deadbeefdead.tmp");
    await writeFile(bystander, "not the journal's temp", "utf8");

    expect((await w.service.check()).kind).toBe("journal-unavailable");
    await w.service.quiesce();

    expect(await readFile(bystander, "utf8")).toBe("not the journal's temp");
    // Its own temp is gone, through the receipt that created it.
    const temps = (await readdir(w.staging)).filter((name) => name.endsWith(".tmp"));
    expect(temps).toEqual(["candidate.json.deadbeefdead.tmp"]);
  });

  it("refuses a symlinked record instead of following it", async () => {
    const dir = await root();
    const data = join(dir, "data");
    const outside = join(dir, "elsewhere.json");
    await mkdir(join(data, "updates"), { recursive: true });
    await writeFile(outside, '{"v":1,"lastCheckedAt":7,"candidate":null,"pending":null,"residue":[]}', "utf8");
    await symlink(outside, join(data, "updates", "candidate.json"));

    const journal = new UpdateJournal(data, posixScopeProvider);
    await expect(journal.read()).rejects.toMatchObject({ code: "unreadable" });
  });

  it("refuses an oversized record on its SIZE, before reading it", async () => {
    const dir = await root();
    const data = join(dir, "data");
    await mkdir(join(data, "updates"), { recursive: true });
    // Larger than MAX_JOURNAL_BYTES. The old path read the whole file first and
    // only then compared, which is the read an attacker controls the size of.
    await writeFile(join(data, "updates", "candidate.json"), "x".repeat(600 * 1024), "utf8");

    const journal = new UpdateJournal(data, posixScopeProvider);
    await expect(journal.read()).rejects.toMatchObject({ code: "too-large" });
  });
});

describeOnPosix("Windows has no portable implementation", () => {
  it("fails closed rather than falling back to path checks", async () => {
    // The POSIX scope is the POSIX platforms' implementation, not a stand-in
    // for the Windows adapter: `win32` gets a refusal until one is wired.
    expect(defaultScopeProvider("win32")).toBe(failClosedScopeProvider);
    expect(defaultScopeProvider("darwin")).toBe(posixScopeProvider);
    await expect(defaultScopeProvider("win32").open("C:/data", "updates")).rejects.toMatchObject({
      code: "no-platform-scope",
    });
  });

  it("makes the whole feature inert rather than partly operable", async () => {
    // Without an adapter nothing may be owned, so the record cannot be written
    // either and the refusal surfaces at the CHECK. That is the honest shape:
    // no staging, no journal, no download, and no state that implies otherwise.
    const w = await world({ scope: failClosedScopeProvider });
    expect(await w.service.check()).toEqual({ kind: "journal-unavailable", reason: "unowned" });
    const state = await w.service.download();
    await w.service.quiesce();
    expect(state.kind).toBe("journal-unavailable");
    await expect(stat(w.journalPath)).rejects.toThrow();
    await expect(readdir(w.staging)).rejects.toThrow();
  });
});

describeOnPosix("admission is bounded by everything outstanding", () => {
  it("refuses a new download while a claim cannot be settled", async () => {
    const w = await world();
    await mkdir(w.staging, { recursive: true });
    await writeFile(join(w.staging, STAGED), "stuck", "utf8");
    const heldReceipt = await receiptOf(join(w.staging, STAGED));
    await writeFile(
      w.journalPath,
      JSON.stringify({
        v: 1,
        lastCheckedAt: null,
        candidate: null,
        pending: { version: "0.3.0", build: 9, nonce: NONCE, receipt: heldReceipt },
        residue: [
          { version: "0.1.0", build: 1, nonce: NONCE, attempts: 1, detail: "x", receipt: null, owned: true },
          { version: "0.1.1", build: 2, nonce: NONCE, attempts: 1, detail: "x", receipt: null, owned: true },
          { version: "0.1.2", build: 3, nonce: NONCE, attempts: 1, detail: "x", receipt: null, owned: true },
        ],
      }),
      "utf8",
    );
    expect((await w.service.check()).kind).toBe("update-available");
    // The held claim's file cannot be removed, so the claim stays outstanding.
    await chmod(w.staging, 0o500);
    const state = await w.service.download();
    await w.service.quiesce();
    await chmod(w.staging, 0o700);
    expect(state).toMatchObject({ kind: "blocked", reason: "unresolved-residue" });
    // Nothing was touched: the claim plus three residues fill the bound.
    expect(await readFile(join(w.staging, STAGED), "utf8")).toBe("stuck");
  });
});
