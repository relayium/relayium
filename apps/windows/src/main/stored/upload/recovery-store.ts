// Complete ciphertext is durable BEFORE any upload session is opened. Names,
// manifest and session identity live only in an authenticated protected plan.
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { accountKeyOf } from "../../inbox/account.js";
import { importAtRestKey, newAtRestKeyBytes, open as decrypt, seal } from "../../inbox/atrest.js";
import { SecretStore, SecretStoreError } from "../../secrets.js";
import type { UploadDescriptor } from "./plan.js";
import type { UploadRetention } from "./transport.js";

const KEY_SLOT = "stored-upload-recovery-key";
const MAX_PLAN_BYTES = 2 * 1024 * 1024;
const JOB_ID = /^(?:u|job)-[a-f0-9]{32}$/;
const HEX = /^[a-f0-9]{64}$/;
const UPLOAD_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type RecoveryPhase = "preparing" | "ready" | "uploading" | "finalizing" | "published";
export interface RecoveryPlan {
  readonly v: 1;
  readonly jobId: string;
  readonly accountId: string;
  readonly origin: string;
  readonly createdAt: number;
  readonly descriptors: readonly UploadDescriptor[];
  readonly sealedManifest: string;
  readonly cipherBytes: number;
  readonly retention: UploadRetention;
  readonly phase: RecoveryPhase;
  readonly bodyDigest: string | null;
  readonly uploadId: string | null;
  readonly chunkSize: number | null;
  readonly objectId: string | null;
  readonly expiresAt: number;
  readonly revision: number;
}

export class RecoveryStoreError extends Error {
  constructor(readonly code: "corrupt" | "unavailable" | "conflict" | "incomplete" | "account" | "missing") {
    super(`upload recovery: ${code}`);
    this.name = "RecoveryStoreError";
  }
}

const legalInteger = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
function checked(raw: unknown, accountId: string, origin: string, jobId: string): RecoveryPlan {
  if (typeof raw !== "object" || raw === null) throw new RecoveryStoreError("corrupt");
  const p = raw as RecoveryPlan;
  if (p.accountId !== accountId || p.origin !== origin || p.jobId !== jobId) throw new RecoveryStoreError("account");
  if (p.v !== 1 || !JOB_ID.test(p.jobId) || !legalInteger(p.createdAt) || !legalInteger(p.cipherBytes)
    || !legalInteger(p.expiresAt) || !legalInteger(p.revision) || p.revision < 1
    || !["preparing", "ready", "uploading", "finalizing", "published"].includes(p.phase)
    || !Array.isArray(p.descriptors) || p.descriptors.length === 0
    || p.descriptors.some((d) => typeof d?.path !== "string" || !legalInteger(d.size))
    || typeof p.sealedManifest !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.sealedManifest)
    || Buffer.from(p.sealedManifest, "base64").length > 64 * 1024
    || typeof p.retention?.burnAfterRead !== "boolean" || !legalInteger(p.retention.ttlSeconds)
    || (p.bodyDigest !== null && (typeof p.bodyDigest !== "string" || !HEX.test(p.bodyDigest)))
    || (p.phase !== "preparing" && p.bodyDigest === null)
    || (p.uploadId !== null && (typeof p.uploadId !== "string" || !UPLOAD_ID.test(p.uploadId)))
    || (p.chunkSize !== null && (!legalInteger(p.chunkSize) || p.chunkSize < 64 * 1024 || p.chunkSize > 16 * 1024 * 1024))
    || (p.uploadId !== null && p.chunkSize === null)
    || (["finalizing", "published"].includes(p.phase) && p.uploadId === null)
    || (p.objectId !== null && (typeof p.objectId !== "string" || !UPLOAD_ID.test(p.objectId)))
    || (p.phase === "published" && p.objectId === null)) throw new RecoveryStoreError("corrupt");
  return p;
}

export class RecoveryStore {
  private key: Promise<CryptoKey> | null = null;
  private readonly changing = new Set<string>();
  constructor(private readonly directory: string, private readonly secrets: SecretStore) {}

  private protectedKey(create = false): Promise<CryptoKey> {
    if (this.key) return this.key;
    this.key = (async () => {
      let encoded: string;
      try { encoded = await this.secrets.get(KEY_SLOT); }
      catch (error) {
        if (!(error instanceof SecretStoreError) || error.code !== "not-found") throw new RecoveryStoreError("unavailable");
        if (!create) throw new RecoveryStoreError("unavailable");
        // A missing key beside existing encrypted state is a recovery failure,
        // never permission to generate a replacement and silently rebaseline.
        const existing = await readdir(join(this.directory, "stored-recovery")).catch((failure: NodeJS.ErrnoException) => {
          if (failure.code === "ENOENT") return [];
          throw new RecoveryStoreError("unavailable");
        });
        if (existing.length) throw new RecoveryStoreError("unavailable");
        await this.secrets.putIfAbsent(KEY_SLOT, Buffer.from(newAtRestKeyBytes()).toString("base64"));
        encoded = await this.secrets.get(KEY_SLOT);
      }
      if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new RecoveryStoreError("unavailable");
      return importAtRestKey(new Uint8Array(Buffer.from(encoded, "base64")));
    })().catch((error) => { this.key = null; throw error; });
    return this.key;
  }

  private binding(accountId: string, origin: string, jobId: string): string {
    if (!accountId || !JOB_ID.test(jobId)) throw new RecoveryStoreError("account");
    try { if (new URL(origin).origin !== origin) throw new Error(); }
    catch { throw new RecoveryStoreError("account"); }
    return `${accountKeyOf(accountId)}:${origin}:${jobId}`;
  }

  private async folder(accountId: string, origin: string, jobId: string | null, create = false): Promise<string> {
    this.binding(accountId, origin, jobId ?? `u-${"0".repeat(32)}`);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let parent = await realpath(this.directory);
    for (const segment of ["stored-recovery", accountKeyOf(accountId), accountKeyOf(origin), ...(jobId ? [jobId] : [])]) {
      const next = join(parent, segment);
      if (create) await mkdir(next, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      let stat;
      try { stat = await lstat(next); } catch (error) {
        throw new RecoveryStoreError((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable");
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RecoveryStoreError("corrupt");
      const canonical = await realpath(next);
      const normalize = (p: string) => process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
      if (normalize(canonical) !== normalize(next)) throw new RecoveryStoreError("corrupt");
      parent = canonical;
    }
    return parent;
  }

  private async file(path: string): Promise<FileHandle> {
    const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      throw new RecoveryStoreError(error.code === "ENOENT" ? "missing" : "unavailable");
    });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new RecoveryStoreError("corrupt");
    let handle;
    try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch { throw new RecoveryStoreError("unavailable"); }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== before.ino || stat.dev !== before.dev) throw new RecoveryStoreError("corrupt");
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }

  async read(accountId: string, origin: string, jobId: string): Promise<RecoveryPlan> {
    const folder = await this.folder(accountId, origin, jobId);
    const handle = await this.file(join(folder, "plan.enc"));
    try {
      const bytes = new Uint8Array(MAX_PLAN_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_PLAN_BYTES) throw new RecoveryStoreError("corrupt");
      const plaintext = await decrypt(await this.protectedKey(), this.binding(accountId, origin, jobId), "stored-upload-recovery", bytes.subarray(0, size));
      return checked(JSON.parse(new TextDecoder().decode(plaintext)), accountId, origin, jobId);
    } catch (error) {
      if (error instanceof RecoveryStoreError) throw error;
      throw new RecoveryStoreError("corrupt");
    } finally { await handle.close(); }
  }

  private async write(plan: RecoveryPlan, folder: string): Promise<void> {
    checked(plan, plan.accountId, plan.origin, plan.jobId);
    const sealed = await seal(await this.protectedKey(), this.binding(plan.accountId, plan.origin, plan.jobId),
      "stored-upload-recovery", new TextEncoder().encode(JSON.stringify(plan)));
    if (sealed.length > MAX_PLAN_BYTES) throw new RecoveryStoreError("corrupt");
    const temp = join(folder, `plan-${randomBytes(12).toString("hex")}.tmp`);
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(sealed); await handle.sync(); }
    catch (error) { await handle.close(); await rm(temp, { force: true }); throw error; }
    await handle.close();
    try { await rename(temp, join(folder, "plan.enc")); }
    finally { await rm(temp, { force: true }); }
    // File fsync + atomic rename protects process restart. Directory durability
    // across power loss is NOT claimed on Windows's Node filesystem API.
  }

  async create(input: Omit<RecoveryPlan, "v" | "phase" | "bodyDigest" | "uploadId" | "chunkSize" | "objectId" | "expiresAt" | "revision">): Promise<{
    readonly append: (bytes: Uint8Array) => Promise<void>;
    readonly finish: () => Promise<RecoveryPlan>;
    readonly close: () => Promise<void>;
  }> {
    await this.protectedKey(true); // no files until key custody is available
    const folder = await this.folder(input.accountId, input.origin, input.jobId, true);
    const plan: RecoveryPlan = { ...input, v: 1, phase: "preparing", bodyDigest: null, uploadId: null, chunkSize: null, objectId: null, expiresAt: 0, revision: 1 };
    checked(plan, plan.accountId, plan.origin, plan.jobId);
    const handle = await open(join(folder, "cipher.bin"), "wx", 0o600);
    let total = 0;
    let closed = false;
    let operation: Promise<unknown> | null = null;
    let closing = false;
    let descriptorClose: Promise<void> | null = null;
    const hash = createHash("sha256");
    const closeHandle = (): Promise<void> => {
      closed = true;
      descriptorClose ??= handle.close();
      return descriptorClose;
    };
    const close = async () => {
      closing = true;
      if (operation) await operation.catch(() => undefined);
      await closeHandle();
    };
    const perform = <T>(body: () => Promise<T>): Promise<T> => {
      if (closed || closing || operation) return Promise.reject(new RecoveryStoreError("conflict"));
      const active = body().finally(() => { if (operation === active) operation = null; });
      operation = active;
      return active;
    };
    try { await this.write(plan, folder); } catch (error) { await close(); throw error; }
    return {
      append: (bytes) => perform(async () => {
          if (total + bytes.length > plan.cipherBytes) throw new RecoveryStoreError("corrupt");
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, total + offset);
            if (!bytesWritten) throw new RecoveryStoreError("unavailable");
            offset += bytesWritten;
          }
          hash.update(bytes); total += bytes.length;
      }),
      finish: () => perform(async () => {
          if (total !== plan.cipherBytes) throw new RecoveryStoreError("incomplete");
          await handle.sync(); await closeHandle();
          const ready: RecoveryPlan = { ...plan, phase: "ready", bodyDigest: hash.digest("hex"), revision: 2 };
          await this.write(ready, folder);
          return ready;
      }), close,
    };
  }

  /** Verify the full body BEFORE an init/status request or a resume. */
  async verify(plan: RecoveryPlan, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (plan.phase === "preparing" || !plan.bodyDigest) throw new RecoveryStoreError("incomplete");
    const folder = await this.folder(plan.accountId, plan.origin, plan.jobId);
    const handle = await this.file(join(folder, "cipher.bin"));
    try {
      signal?.throwIfAborted();
      if ((await handle.stat()).size !== plan.cipherBytes) throw new RecoveryStoreError("corrupt");
      const hash = createHash("sha256");
      const buffer = new Uint8Array(1024 * 1024);
      let total = 0;
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
        signal?.throwIfAborted();
        if (!bytesRead) break;
        total += bytesRead;
        if (total > plan.cipherBytes) throw new RecoveryStoreError("corrupt");
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (total !== plan.cipherBytes || hash.digest("hex") !== plan.bodyDigest) throw new RecoveryStoreError("corrupt");
    } finally { await handle.close(); }
  }

  async list(accountId: string, origin: string): Promise<readonly RecoveryPlan[]> {
    let parent: string;
    try {
      parent = await this.folder(accountId, origin, null);
    } catch (error) {
      if (error instanceof RecoveryStoreError && error.code === "missing") return [];
      throw error;
    }
    const entries = await readdir(parent, { withFileTypes: true });
    const jobs = entries.filter((entry) => JOB_ID.test(entry.name));
    if (jobs.length > 512) throw new RecoveryStoreError("conflict");
    const plans: RecoveryPlan[] = [];
    for (const entry of jobs) {
      try { plans.push(await this.read(accountId, origin, entry.name)); }
      catch (error) {
        if (!(error instanceof RecoveryStoreError) || error.code !== "missing") throw error;
        const folder = await this.folder(accountId, origin, entry.name);
        // An empty directory contains no recovery data. Never remove it here:
        // a new preparation could still be about to create its first file.
        if ((await readdir(folder)).length !== 0) throw new RecoveryStoreError("corrupt");
      }
    }
    return plans;
  }

  /** The desktop's single-instance owner serializes writes; revision checking
   * also refuses a stale UI snapshot after another action replaced its plan. */
  async update(plan: RecoveryPlan, delta: Partial<Pick<RecoveryPlan, "phase" | "uploadId" | "chunkSize" | "objectId" | "expiresAt">>): Promise<RecoveryPlan> {
    if (this.changing.has(plan.jobId)) throw new RecoveryStoreError("conflict");
    this.changing.add(plan.jobId);
    try {
      const current = await this.read(plan.accountId, plan.origin, plan.jobId);
      if (current.revision !== plan.revision) throw new RecoveryStoreError("conflict");
      const transitions: Record<RecoveryPhase, readonly RecoveryPhase[]> = {
        preparing: [], ready: ["uploading"], uploading: ["uploading", "finalizing"],
        finalizing: ["finalizing", "published"], published: [],
      };
      if (!delta.phase || !transitions[current.phase].includes(delta.phase)) throw new RecoveryStoreError("conflict");
      const next = { ...current, ...delta, revision: current.revision + 1 };
      await this.write(next, await this.folder(plan.accountId, plan.origin, plan.jobId));
      return next;
    } finally { this.changing.delete(plan.jobId); }
  }

  async range(plan: RecoveryPlan, offset: number, length: number): Promise<Uint8Array> {
    if (!legalInteger(offset) || !legalInteger(length) || length > 16 * 1024 * 1024 || offset + length > plan.cipherBytes) {
      throw new RecoveryStoreError("corrupt");
    }
    const folder = await this.folder(plan.accountId, plan.origin, plan.jobId);
    const handle = await this.file(join(folder, "cipher.bin"));
    try {
      const bytes = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        const result = await handle.read(bytes, read, length - read, offset + read);
        if (!result.bytesRead) throw new RecoveryStoreError("corrupt");
        read += result.bytesRead;
      }
      return bytes;
    } finally { await handle.close(); }
  }

  /** Caller has established publication or obtained snapshot-bound explicit
   * discard consent. Never recursively remove an arbitrary directory tree. */
  async remove(plan: RecoveryPlan): Promise<void> {
    if (this.changing.has(plan.jobId)) throw new RecoveryStoreError("conflict");
    this.changing.add(plan.jobId);
    try {
      const current = await this.read(plan.accountId, plan.origin, plan.jobId);
      if (current.revision !== plan.revision) throw new RecoveryStoreError("conflict");
      const folder = await this.folder(plan.accountId, plan.origin, plan.jobId);
      const entries = await readdir(folder);
      if (entries.some((name) => name !== "cipher.bin" && name !== "plan.enc" && !/^plan-[a-f0-9]{24}\.tmp$/.test(name))) {
        throw new RecoveryStoreError("conflict");
      }
      for (const name of entries) {
        const handle = await this.file(join(folder, name)); await handle.close();
      }
      for (const name of entries.filter((name) => name !== "plan.enc")) await rm(join(folder, name));
      await rm(join(folder, "plan.enc"));
      await rmdir(folder);
    } finally { this.changing.delete(plan.jobId); }
  }
}
