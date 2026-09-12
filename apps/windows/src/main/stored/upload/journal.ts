// The local record of what this installation has uploaded, and what it is
// unsure about.
//
// ## Why a journal exists at all
//
// The server's `GET /api/files` lists an account's shares but carries NO
// manifest and no key, so it cannot tell the user what is in an object or let
// them open it. And `POST /api/uploads/{id}/finalize` answers 409 for every
// attempt after the first, WITHOUT the object id — so a finalize whose response
// is lost leaves an object that may exist and may be unreachable. Only a local
// record can hold the two things needed to recover from that: which key was
// used, and a proof of which object it was used for.
//
// ## No secrets, ever
//
// A record holds ids, counts, timestamps, the account it belongs to, and a
// SHA-256 digest of the sealed manifest. It does not hold the content key, the
// assembled `#k=` link, or any filename — the digest is what makes
// reconciliation exact, and it discloses nothing. The keys live in
// `custody.ts`, encrypted at rest.
//
// The digest is used rather than the sealed manifest itself for two reasons:
// the sealed manifest can approach the server's 64 KiB bound and this file is
// read whole, and a digest is sufficient for the only question asked of it —
// "is THIS object the one my init body created?" — because the manifest is
// AES-GCM under a per-upload random key at a fixed nonce, so a byte-identical
// sealed manifest cannot have come from anywhere else.
//
// ## Unknown finalizations are never evicted
//
// A `pending` or `ambiguous` record is retained without a lifetime, because it
// is the only thing that can ever resolve an object the user paid for. Bounding
// is applied to NEW admission instead: past the cap a new upload is refused
// rather than an old unknown being dropped.

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";

import { UPLOAD_STATES, type UploadState } from "../../../shared/ipc-contract.js";

/** How many records this installation keeps. Reached only by unresolved ones:
 *  a published record can be forgotten by the user, an unknown one cannot. */
export const MAX_RECORDS = 512;

/** The document is read whole, so it is bounded like every other input. */
export const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;

/**
 * One union, declared in the shared contract and re-exported here.
 *
 * It used to be declared in this file, which meant the screen at the far end of
 * the IPC saw only `string` — and mapped three of the four members.
 */
export type { UploadState };

export interface UploadRecord {
  readonly jobId: string;
  readonly accountId: string;
  readonly state: UploadState;
  /** The upload session id. Useless after finalize but part of the audit. */
  readonly uploadId: string | null;
  /** The published object id — set only in `published`. */
  readonly objectId: string | null;
  /** SHA-256 of the sealed manifest, hex. The reconciliation proof. */
  readonly manifestDigest: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly cipherBytes: number;
  readonly burnAfterRead: boolean;
  /** Unix seconds, from the server at finalize. 0 until then. */
  readonly expiresAt: number;
  /** Unix seconds, from the host's clock. */
  readonly createdAt: number;
  /** Why this record is `closed`, or `ambiguous`. A closed code, never a message. */
  readonly note: string | null;
}

interface JournalDocument {
  readonly v: 1;
  readonly records: readonly UploadRecord[];
}

export type JournalFailure =
  /** Present and not the documented shape. Never silently reset. */
  | "corrupt"
  | "too-large"
  /** The write could not be made durable. */
  | "unwritable"
  /** New admission is at its bound and every slot is an unresolved upload. */
  | "at-capacity";

export class JournalError extends Error {
  constructor(readonly code: JournalFailure) {
    super(`upload journal: ${code}`);
    this.name = "JournalError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const HEX_64 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Derived, not restated. A new member reaches this validator by existing. */
const STATES: ReadonlySet<string> = new Set<string>(UPLOAD_STATES);

function checkedRecord(raw: unknown): UploadRecord {
  if (!isRecord(raw)) throw new JournalError("corrupt");
  const jobId = raw["jobId"];
  const accountId = raw["accountId"];
  const state = raw["state"];
  const digest = raw["manifestDigest"];
  if (
    typeof jobId !== "string" ||
    !ID.test(jobId) ||
    typeof accountId !== "string" ||
    accountId.length === 0 ||
    typeof state !== "string" ||
    !STATES.has(state) ||
    typeof digest !== "string" ||
    !HEX_64.test(digest)
  ) {
    throw new JournalError("corrupt");
  }
  const numbers: Record<string, number> = {};
  for (const field of ["fileCount", "totalBytes", "cipherBytes", "expiresAt", "createdAt"]) {
    const value = raw[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new JournalError("corrupt");
    }
    numbers[field] = value;
  }
  const uploadId = raw["uploadId"];
  const objectId = raw["objectId"];
  const note = raw["note"];
  if (uploadId !== null && (typeof uploadId !== "string" || !ID.test(uploadId))) {
    throw new JournalError("corrupt");
  }
  if (objectId !== null && (typeof objectId !== "string" || !ID.test(objectId))) {
    throw new JournalError("corrupt");
  }
  if (note !== null && (typeof note !== "string" || note.length > 64)) {
    throw new JournalError("corrupt");
  }
  if (typeof raw["burnAfterRead"] !== "boolean") throw new JournalError("corrupt");
  // A published record without an id would be a record claiming a link it
  // cannot produce.
  if (state === "published" && typeof objectId !== "string") throw new JournalError("corrupt");
  return {
    jobId,
    accountId,
    state: state as UploadState,
    uploadId: typeof uploadId === "string" ? uploadId : null,
    objectId: typeof objectId === "string" ? objectId : null,
    manifestDigest: digest,
    fileCount: numbers["fileCount"] ?? 0,
    totalBytes: numbers["totalBytes"] ?? 0,
    cipherBytes: numbers["cipherBytes"] ?? 0,
    burnAfterRead: raw["burnAfterRead"],
    expiresAt: numbers["expiresAt"] ?? 0,
    createdAt: numbers["createdAt"] ?? 0,
    note: typeof note === "string" ? note : null,
  };
}

/**
 * The journal.
 *
 * Serialized on one promise chain, so two concurrent updates cannot read the
 * same document and write back two divergent versions — the last-writer-wins
 * bug that loses whichever upload finished second. Written through a temp file
 * and an atomic rename, with `fsync`, so a crash mid-write leaves the previous
 * document rather than half of the new one.
 */
export class UploadJournal {
  private chain: Promise<unknown> = Promise.resolve();
  private cached: UploadRecord[] | null = null;

  constructor(
    private readonly directory: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    /** The record cap. Injected only so the capacity rule can be exercised
     *  without writing (and fsyncing) five hundred records. */
    private readonly limit: number = MAX_RECORDS,
  ) {}

  private get path(): string {
    return join(this.directory, "stored-uploads.json");
  }

  private serialize<T>(body: () => Promise<T>): Promise<T> {
    const run = this.chain.then(body, body);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<UploadRecord[]> {
    if (this.cached !== null) return this.cached;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.cached = [];
        return this.cached;
      }
      throw new JournalError("corrupt");
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_JOURNAL_BYTES) throw new JournalError("too-large");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new JournalError("corrupt");
    }
    if (!isRecord(parsed) || parsed["v"] !== 1 || !Array.isArray(parsed["records"])) {
      throw new JournalError("corrupt");
    }
    // Strict: one bad record fails the read rather than being dropped. A
    // journal that silently loses the entry for an object the user paid for is
    // worse than one that refuses to load and says so.
    this.cached = (parsed["records"] as unknown[]).map(checkedRecord);
    return this.cached;
  }

  private async persist(records: readonly UploadRecord[]): Promise<void> {
    const document: JournalDocument = { v: 1, records };
    const text = JSON.stringify(document);
    if (Buffer.byteLength(text, "utf8") > MAX_JOURNAL_BYTES) throw new JournalError("too-large");
    await mkdir(this.directory, { recursive: true });
    const temp = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
    let renamed = false;
    try {
      // O_EXCL: the temp name is ours alone, so nothing pre-existing — a
      // planted symlink included — can be opened or followed here. Same
      // discipline as `SecretStore.writeAtomic`.
      const handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close().catch(() => undefined);
      }
      await rename(temp, this.path);
      renamed = true;
    } catch (error) {
      if (error instanceof JournalError) throw error;
      throw new JournalError("unwritable");
    } finally {
      if (!renamed) await rm(temp, { force: true }).catch(() => undefined);
    }
    this.cached = [...records];
  }

  /** Every record for one account. Account-bound: another sign-in's uploads are
   *  not this account's history and are never listed under it. */
  list(accountId: string): Promise<readonly UploadRecord[]> {
    return this.serialize(async () => {
      const records = await this.load();
      return records.filter((record) => record.accountId === accountId);
    });
  }

  get(jobId: string): Promise<UploadRecord | null> {
    return this.serialize(async () => {
      const records = await this.load();
      return records.find((record) => record.jobId === jobId) ?? null;
    });
  }

  /** Unresolved uploads, for a host that wants to offer reconciliation. */
  unresolved(accountId: string): Promise<readonly UploadRecord[]> {
    return this.serialize(async () => {
      const records = await this.load();
      return records.filter(
        (record) =>
          record.accountId === accountId && (record.state === "pending" || record.state === "ambiguous"),
      );
    });
  }

  /**
   * Admit a new upload, before init.
   *
   * Refuses at the cap rather than evicting: the records occupying it are
   * unknown finalizations, and dropping one destroys the only route to an
   * object that may exist. `closed` and `published` records are compacted away
   * first, because those the user can still see on the server.
   */
  admit(input: {
    readonly jobId: string;
    readonly accountId: string;
    readonly manifestDigest: string;
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly cipherBytes: number;
    readonly burnAfterRead: boolean;
  }): Promise<UploadRecord> {
    return this.serialize(async () => {
      const records = await this.load();
      if (records.some((record) => record.jobId === input.jobId)) throw new JournalError("corrupt");
      let next = records;
      if (next.length >= this.limit) {
        const unresolved = next.filter(
          (record) => record.state === "pending" || record.state === "ambiguous",
        );
        if (unresolved.length >= this.limit) throw new JournalError("at-capacity");
        // Oldest resolved records go; unknown ones never do.
        const resolved = next
          .filter((record) => record.state === "published" || record.state === "closed")
          .sort((a, b) => a.createdAt - b.createdAt);
        const drop = new Set(resolved.slice(0, next.length - this.limit + 1).map((r) => r.jobId));
        next = next.filter((record) => !drop.has(record.jobId));
      }
      const record: UploadRecord = {
        jobId: input.jobId,
        accountId: input.accountId,
        state: "pending",
        uploadId: null,
        objectId: null,
        manifestDigest: input.manifestDigest,
        fileCount: input.fileCount,
        totalBytes: input.totalBytes,
        cipherBytes: input.cipherBytes,
        burnAfterRead: input.burnAfterRead,
        expiresAt: 0,
        createdAt: this.now(),
        note: null,
      };
      await this.persist([...next, record]);
      return record;
    });
  }

  /** Move a record forward. The whole document is rewritten atomically. */
  update(
    jobId: string,
    patch: Partial<Pick<UploadRecord, "state" | "uploadId" | "objectId" | "expiresAt" | "note">>,
  ): Promise<UploadRecord> {
    return this.serialize(async () => {
      const records = await this.load();
      const index = records.findIndex((record) => record.jobId === jobId);
      const current = records[index];
      if (current === undefined) throw new JournalError("corrupt");
      const merged: UploadRecord = { ...current, ...patch };
      // The one invariant a patch must not break.
      if (merged.state === "published" && merged.objectId === null) throw new JournalError("corrupt");
      const next = [...records];
      next[index] = merged;
      await this.persist(next);
      return merged;
    });
  }

  /** Drop a record the user has finished with. Only ever called for a state
   *  whose object is provably gone — the caller owns that proof. */
  forget(jobId: string): Promise<void> {
    return this.serialize(async () => {
      const records = await this.load();
      await this.persist(records.filter((record) => record.jobId !== jobId));
    });
  }

  /** Test seam: drop the in-memory copy so the next read comes from disk. */
  resetCacheForTest(): void {
    this.cached = null;
  }
}
