// Where an upload's content key lives, and when it may be forgotten.
//
// ## Persisted BEFORE the first request
//
// The key is written to `SecretStore` — encrypted at rest by the platform
// cipher — before `POST /api/uploads` is sent. The ordering is the whole point:
// an upload that reaches the server and then loses its key has produced
// ciphertext nobody can ever open, and a crash between init and the first
// journal write is exactly the window that would do it.
//
// ## What a slot holds, and what it does not
//
// The slot holds the base64url content key and the account it belongs to, and
// nothing else. Not the manifest, not a filename, not the assembled `#k=` link
// — a link is the key, so storing one would be storing the key twice under a
// name that looks harmless. `SecretStore`'s plaintext ceiling is 64 KiB and a
// slot is well under a hundred bytes, so the bound is never in play; the
// encManifest, which CAN approach 64 KiB, is deliberately not here (the journal
// keeps its digest instead).
//
// ## Retirement needs proof
//
// `retire` is called only when the published object is provably gone — a
// server 404 on delete, or an explicit user deletion that succeeded. It is
// NEVER called on sign-out, on a generic error, or because a job failed: a key
// deleted while its ciphertext still exists on the server is a share the user
// can never open again, which is silent data loss dressed as tidying up.

import { SecretStore, SecretStoreError } from "../../secrets.js";

/** Slot names are filenames, so they are one inert token. `SecretStore` runs
 *  `validateSegment` on them; this prefix keeps upload keys distinguishable
 *  from the bearer (`account-bearer`) and the install identity. */
const SLOT_PREFIX = "stored-upload-key-";

/** A job id is generated here, never taken from a peer, and is restricted to
 *  the alphabet that survives `validateSegment` unchanged. */
const JOB_ID = /^[A-Za-z0-9-]{1,64}$/;

export type CustodyFailure =
  /** The platform cipher is not available; nothing was written. */
  | "unavailable"
  /** The slot is not there. For `read`, that is a genuine loss. */
  | "missing"
  /** Present but unreadable or not the documented shape. Never "reset it". */
  | "corrupt"
  /** A slot for this job already exists; a second write would overwrite a key
   *  some ciphertext was produced under. */
  | "exists";

export class CustodyError extends Error {
  constructor(readonly code: CustodyFailure) {
    super(`upload key custody: ${code}`);
    this.name = "CustodyError";
  }
}

export interface HeldKey {
  readonly encodedKey: string;
  readonly accountId: string;
}

/** The shape stored in a slot. Versioned so a later field cannot be mistaken
 *  for a corrupt document. */
interface SlotDocument {
  readonly v: 1;
  readonly k: string;
  readonly a: string;
}

const slotFor = (jobId: string): string => {
  if (!JOB_ID.test(jobId)) throw new CustodyError("corrupt");
  return `${SLOT_PREFIX}${jobId}`;
};

const mapError = (error: unknown): CustodyError => {
  if (error instanceof CustodyError) return error;
  if (error instanceof SecretStoreError) {
    switch (error.code) {
      case "encryption-unavailable":
        return new CustodyError("unavailable");
      case "not-found":
        return new CustodyError("missing");
      default:
        // `undecryptable`, `unreadable`, `too-large`, `invalid-key`: present and
        // unusable. Strictly distinguished from missing, and never repaired.
        return new CustodyError("corrupt");
    }
  }
  return new CustodyError("corrupt");
};

export class UploadKeyCustody {
  constructor(private readonly secrets: SecretStore) {}

  /**
   * Write the key, refusing to overwrite one.
   *
   * `putIfAbsent`, not `put`: a retried job start that reused a job id would
   * otherwise replace the key that earlier ciphertext was produced under, and
   * every byte already on the server would become undecryptable. A collision is
   * an error, not something to resolve by preferring either value.
   */
  async hold(jobId: string, held: HeldKey): Promise<void> {
    const document: SlotDocument = { v: 1, k: held.encodedKey, a: held.accountId };
    try {
      const result = await this.secrets.putIfAbsent(slotFor(jobId), JSON.stringify(document));
      if (!result.created) throw new CustodyError("exists");
    } catch (error) {
      throw mapError(error);
    }
  }

  /**
   * Read a held key back, and refuse one that belongs to another account.
   *
   * The account check is not decoration: history is account-bound, and a slot
   * left by a previous sign-in must not hand its key to the current one.
   */
  async read(jobId: string, accountId: string): Promise<HeldKey> {
    let raw: string;
    try {
      raw = await this.secrets.get(slotFor(jobId));
    } catch (error) {
      throw mapError(error);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CustodyError("corrupt");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { v?: unknown }).v !== 1 ||
      typeof (parsed as { k?: unknown }).k !== "string" ||
      typeof (parsed as { a?: unknown }).a !== "string"
    ) {
      throw new CustodyError("corrupt");
    }
    const document = parsed as SlotDocument;
    if (document.k.length === 0) throw new CustodyError("corrupt");
    if (document.a !== accountId) throw new CustodyError("missing");
    return { encodedKey: document.k, accountId: document.a };
  }

  /** Whether a slot is there at all, without reading the key into a caller. */
  async holds(jobId: string, accountId: string): Promise<boolean> {
    try {
      await this.read(jobId, accountId);
      return true;
    } catch (error) {
      if (error instanceof CustodyError && error.code === "missing") return false;
      throw error;
    }
  }

  /**
   * Forget a key whose object is provably gone.
   *
   * The caller supplies the proof; this method only records the decision. It is
   * deliberately not reachable from a sign-out path or an error handler.
   */
  async retire(jobId: string, proof: "server-absent" | "user-deleted"): Promise<void> {
    void proof; // named in the signature so a caller must state one
    try {
      await this.secrets.delete(slotFor(jobId));
    } catch (error) {
      throw mapError(error);
    }
  }
}
