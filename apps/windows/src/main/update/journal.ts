// The local record of what has been staged — and what it is NOT allowed to be.
//
// ## It stores no authority and no path
//
// Two rules, both learned from review findings:
//
//   1. **No path.** A path read from this file would authorize a filesystem
//      call on whatever it named. The record holds an IDENTITY, and
//      `staging.ts` derives the one path that identity may have.
//   2. **No authority.** The plain fields here are a CACHE for display. The
//      authority for "this candidate is version X, build Y, of size Z, with
//      digest D" is the exact SIGNED METADATA BYTES plus their detached
//      signature, which are stored verbatim and re-verified against the pinned
//      key on every use. An earlier revision stored version/build/size/digest
//      as plain text and re-hashed the file against them, which authenticates
//      the FILE against the JOURNAL — so a tampered journal could present an
//      older, genuinely-signed installer as a new one and pass every check.
//
// ## A claim is INTENT until it carries a receipt
//
// A claim written before the exclusive create records only that a name was
// reserved: after a crash, "I meant to create this" and "I created this" leave
// identical bytes on disk. So the claim is written twice — intent, then the
// RECEIPT once the create has returned — and only a receipt authorizes a delete.
//
// The receipt is the created object's identity, not a flag. A flag would still
// be a statement about a NAME, and between two runs the file at that name can be
// renamed away and replaced. Recovery re-reads the identity at the name and acts
// only on a match; a claim with no receipt, or a receipt that no longer
// describes what is there, is retained as AMBIGUOUS residue and never removed.
//
// ## A corrupt journal is preserved, never reset
//
// The earlier `load()` set its cache flag before the read completed and turned
// every read or parse error into an empty document. Two consequences: an
// overlapping load could publish "nothing staged" and then a later write would
// overwrite a real candidate, and a transient read error silently discarded the
// record for a file still on disk. Now: one serialized load, a typed ENOENT is
// the only thing that means empty, and anything else REFUSES — the record and
// the files stay exactly as they are.

import { randomBytes } from "node:crypto";

import {
  CustodyError,
  RECEIPT,
  defaultScopeProvider,
  type StagingScope,
  type StagingScopeProvider,
} from "./custody.js";
import {
  JOURNAL_FILE_NAME,
  NONCE,
  STAGING_DIRECTORY_NAME,
  type StagedIdentity,
} from "./staging.js";

/** The document is read whole, so it is bounded. Signed metadata is at most
 *  64 KiB and its base64 about 88 KiB; 512 KiB leaves room for a residue list
 *  and nothing more. */
export const MAX_JOURNAL_BYTES = 512 * 1024;
/** How many unconfirmed deletions this installation will carry before it stops
 *  admitting new downloads. Bounded ADMISSION, never eviction. */
export const MAX_RESIDUE = 4;

/**
 * A staged candidate, as recorded.
 *
 * `metadata` and `signature` are the authority; `version` and `build` are an
 * index for deriving the path and for display, and are re-derived from the
 * verified manifest before anything acts on them.
 */
export interface JournalCandidate extends StagedIdentity {
  /** Identity of the staged object. Re-checked before any effect on it. */
  readonly receipt: string;
  /** Base64 of the exact signed metadata bytes. */
  readonly metadata: string;
  /** Base64url of the detached Ed25519 signature over those bytes. */
  readonly signature: string;
}

/**
 * A name reserved in owned staging BEFORE anything was created under it.
 *
 * The point is the ordering. An earlier revision recorded a candidate only
 * AFTER the download completed, so a crash — or an unwritable journal — between
 * the exclusive create and the commit left a file nothing owned: it could not be
 * cleaned up, and it could not be told apart from a file somebody else had put
 * there. The claim is written first, so an interrupted run leaves evidence of
 * exactly one name it was allowed to reclaim.
 */
export interface JournalClaim extends StagedIdentity {
  /**
   * Identity of the object the exclusive create returned, or null for intent.
   *
   * Null proves nothing. A token is checked against the object actually at the
   * name before anything is deleted — see the header.
   */
  readonly receipt: string | null;
}

/** A deletion that did not confirm. Retained until it does. */
export interface JournalResidue extends StagedIdentity {
  readonly attempts: number;
  readonly detail: string;
  /** Identity of the object this installation created, when it has one. */
  readonly receipt: string | null;
  /**
   * Whether this installation is known to have created what is there now.
   *
   * False means an interrupted run left something at a name it had claimed but
   * never confirmed creating, or the object at that name is no longer the one
   * the receipt describes. Either way it is REPORTED and never deleted:
   * preserving bytes that might not be ours is the safer half of an ambiguity
   * that cannot be resolved from here.
   */
  readonly owned: boolean;
}

export interface JournalDocument {
  readonly v: 1;
  readonly lastCheckedAt: number | null;
  readonly candidate: JournalCandidate | null;
  /** The name a download reserved but has not committed. */
  readonly pending: JournalClaim | null;
  readonly residue: readonly JournalResidue[];
}

export const EMPTY_JOURNAL: JournalDocument = {
  v: 1,
  lastCheckedAt: null,
  candidate: null,
  pending: null,
  residue: [],
};

export type JournalFailure =
  /** Present and not the documented shape. The file is left alone. */
  | "corrupt"
  | "too-large"
  /** The read failed for a reason that is not "absent". */
  | "unreadable"
  | "unwritable"
  /** The staging directory could not be established as this app's, so the
   *  record was neither read nor written. */
  | "unowned";

export class JournalError extends Error {
  constructor(readonly code: JournalFailure) {
    super(`update journal: ${code}`);
    this.name = "JournalError";
  }
}

const VERSION = /^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A receipt token, or null when the field is allowed to be absent. */
function checkedReceipt(raw: Record<string, unknown>, nullable: boolean): string | null {
  const receipt = raw["receipt"];
  if (receipt === null || receipt === undefined) {
    if (nullable) return null;
    throw new JournalError("corrupt");
  }
  if (typeof receipt !== "string" || receipt.length > 96 || !RECEIPT.test(receipt)) {
    throw new JournalError("corrupt");
  }
  return receipt;
}

function checkedIdentity(raw: Record<string, unknown>): StagedIdentity {
  const version = raw["version"];
  const build = raw["build"];
  const nonce = raw["nonce"];
  if (typeof version !== "string" || !VERSION.test(version)) throw new JournalError("corrupt");
  if (!Number.isSafeInteger(build) || (build as number) <= 0) throw new JournalError("corrupt");
  // The nonce reaches a filesystem name, so it is checked here as strictly as
  // it is minted: sixteen lowercase hex characters, nothing else.
  if (typeof nonce !== "string" || !NONCE.test(nonce)) throw new JournalError("corrupt");
  return { version, build: build as number, nonce };
}

/**
 * Strict parse. Every unexpected shape is `corrupt`, and `corrupt` never means
 * "start again from empty".
 *
 * A `path` field is refused outright rather than ignored: its presence means
 * the document was written by a revision whose paths were authority, and
 * silently dropping it would make a downgrade of this code indistinguishable
 * from an upgrade.
 */
export function parseJournal(text: string): JournalDocument {
  if (Buffer.byteLength(text, "utf8") > MAX_JOURNAL_BYTES) throw new JournalError("too-large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JournalError("corrupt");
  }
  if (!isRecord(parsed) || parsed["v"] !== 1) throw new JournalError("corrupt");
  const lastCheckedAt = parsed["lastCheckedAt"];
  if (lastCheckedAt !== null && !Number.isSafeInteger(lastCheckedAt)) {
    throw new JournalError("corrupt");
  }
  const rawCandidate = parsed["candidate"];
  let candidate: JournalCandidate | null = null;
  if (rawCandidate !== null && rawCandidate !== undefined) {
    if (!isRecord(rawCandidate)) throw new JournalError("corrupt");
    if ("path" in rawCandidate) throw new JournalError("corrupt");
    const identity = checkedIdentity(rawCandidate);
    const metadata = rawCandidate["metadata"];
    const signature = rawCandidate["signature"];
    if (
      typeof metadata !== "string" ||
      metadata.length === 0 ||
      metadata.length > MAX_JOURNAL_BYTES ||
      !BASE64.test(metadata)
    ) {
      throw new JournalError("corrupt");
    }
    if (typeof signature !== "string" || !BASE64URL.test(signature) || signature.length > 256) {
      throw new JournalError("corrupt");
    }
    const receipt = checkedReceipt(rawCandidate, false);
    if (receipt === null) throw new JournalError("corrupt");
    candidate = { ...identity, receipt, metadata, signature };
  }
  const rawPending = parsed["pending"];
  let pending: JournalClaim | null = null;
  if (rawPending !== null && rawPending !== undefined) {
    if (!isRecord(rawPending)) throw new JournalError("corrupt");
    if ("path" in rawPending) throw new JournalError("corrupt");
    pending = { ...checkedIdentity(rawPending), receipt: checkedReceipt(rawPending, true) };
  }
  const rawResidue = parsed["residue"];
  const residue: JournalResidue[] = [];
  if (rawResidue !== undefined && rawResidue !== null) {
    if (!Array.isArray(rawResidue) || rawResidue.length > MAX_RESIDUE) {
      throw new JournalError("corrupt");
    }
    for (const entry of rawResidue) {
      if (!isRecord(entry)) throw new JournalError("corrupt");
      if ("path" in entry) throw new JournalError("corrupt");
      const identity = checkedIdentity(entry);
      const attempts = entry["attempts"];
      const detail = entry["detail"];
      if (!Number.isSafeInteger(attempts) || (attempts as number) < 0) {
        throw new JournalError("corrupt");
      }
      if (typeof detail !== "string" || detail.length > 64) throw new JournalError("corrupt");
      const owned = entry["owned"];
      if (typeof owned !== "boolean") throw new JournalError("corrupt");
      residue.push({
        ...identity,
        attempts: attempts as number,
        detail,
        receipt: checkedReceipt(entry, true),
        owned,
      });
    }
  }
  return { v: 1, lastCheckedAt: lastCheckedAt as number | null, candidate, pending, residue };
}

/**
 * The journal, serialized.
 *
 * ONE promise chain covers every read and every write, so two callers cannot
 * read the same document and write back divergent versions — and no caller can
 * observe a half-loaded state. The in-memory copy is only ever set from a
 * COMPLETED read or a completed write.
 */
export class UpdateJournal {
  private chain: Promise<unknown> = Promise.resolve();
  private cached: JournalDocument | null = null;

  constructor(
    private readonly dataDirectory: string,
    private readonly provider: StagingScopeProvider = defaultScopeProvider(),
  ) {}

  /**
   * Run `body` with the staging directory HELD.
   *
   * The record lives in the same directory as the artifact and gets the same
   * treatment: every read, write and rename goes through the capability, so a
   * wired Windows adapter cannot be bypassed by a naked path call here. A
   * redirected `updates` must not receive this file either, and a platform with
   * no adapter writes nothing at all.
   */
  private async withScope<T>(body: (scope: StagingScope) => Promise<T>): Promise<T> {
    let scope;
    try {
      scope = await this.provider.open(this.dataDirectory, STAGING_DIRECTORY_NAME);
    } catch (error) {
      throw new JournalError(error instanceof CustodyError ? "unowned" : "unreadable");
    }
    try {
      return await body(scope);
    } finally {
      await scope.close();
    }
  }

  private serialize<T>(body: () => Promise<T>): Promise<T> {
    const run = this.chain.then(body, body);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Read the document. Throws `JournalError` for anything but absence. */
  read(): Promise<JournalDocument> {
    return this.serialize(async () => {
      if (this.cached !== null) return this.cached;
      const text = await this.readHeld();
      // Absence is the ONLY thing that means "nothing staged". Anything else is
      // a read this process could not perform, and pretending it was empty is
      // how a real candidate gets overwritten.
      if (text === null) {
        this.cached = EMPTY_JOURNAL;
        return this.cached;
      }
      // Set only after a COMPLETED, VALID read.
      const parsed = parseJournal(text);
      this.cached = parsed;
      return parsed;
    });
  }

  /** Read, transform, write — all inside one serialized turn. */
  update(mutate: (current: JournalDocument) => JournalDocument): Promise<JournalDocument> {
    return this.serialize(async () => {
      const current = this.cached ?? (await this.readUnserialized());
      const next = mutate(current);
      await this.write(next);
      this.cached = next;
      return next;
    });
  }

  private async readUnserialized(): Promise<JournalDocument> {
    const text = await this.readHeld();
    return text === null ? EMPTY_JOURNAL : parseJournal(text);
  }

  /** Bounded read through the capability. Null means absent. */
  private async readHeld(): Promise<string | null> {
    try {
      return await this.withScope((scope) => scope.readBounded(JOURNAL_FILE_NAME, MAX_JOURNAL_BYTES));
    } catch (error) {
      if (error instanceof JournalError) throw error;
      if (error instanceof CustodyError) {
        throw new JournalError(error.code === "too-large" ? "too-large" : "unreadable");
      }
      throw new JournalError("unreadable");
    }
  }

  private async write(next: JournalDocument): Promise<void> {
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text, "utf8") > MAX_JOURNAL_BYTES) throw new JournalError("unwritable");
    return this.withScope((scope) => this.writeHeld(scope, text));
  }

  /**
   * Write through custody: exclusive temp, flush, then commit THAT file.
   *
   * The temp gets the same ownership discipline as the artifact, and publication
   * takes the owned file rather than two names — after a close, the object at a
   * temp name can be swapped, and holding the directory does not pin the leaf.
   * `commit` is also what keeps ownership until the outcome is confirmed, so a
   * failure still leaves a receipt this can discard. An earlier revision removed
   * the temp by path in a `finally` even when the exclusive create had FAILED,
   * deleting whatever answered to that name.
   */
  private async writeHeld(scope: StagingScope, text: string): Promise<void> {
    const temp = `${JOURNAL_FILE_NAME}.${randomBytes(6).toString("hex")}.tmp`;
    let file;
    try {
      file = await scope.createExclusive(temp);
    } catch {
      throw new JournalError("unwritable");
    }
    let committed = false;
    try {
      await file.write(Buffer.from(text, "utf8"));
      await file.sync();
      await scope.commit(file, JOURNAL_FILE_NAME);
      committed = true;
    } catch (error) {
      if (error instanceof JournalError) throw error;
      throw new JournalError("unwritable");
    } finally {
      if (!committed) await file.discard().catch(() => undefined);
      await file.close().catch(() => undefined);
    }
  }

  /** Test seam: forget the in-memory copy. */
  resetCacheForTest(): void {
    this.cached = null;
  }
}
