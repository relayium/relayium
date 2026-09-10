// Who an upload belongs to, captured once, and the fence that revokes it.
//
// ## Captured, never re-read
//
// An upload runs for minutes and touches an account's bearer, a device
// identity and one renderer document. Every one of those can change underneath
// it: a sign-out, a token rotation, a reload. Re-reading them per request would
// mean a job silently continuing under whatever identity happens to be current
// — finishing one account's upload with another's credential, or handing a key
// to a document that has already been replaced.
//
// So the authority is a FROZEN VALUE taken at job creation, and the fence below
// is the only thing that can end its validity. A change is a revocation, not a
// substitution: the job stops, and a new job under the new authority is the
// caller's decision to make.
//
// ## The bearer is injected, not fetched
//
// This module never reads `SecretStore`. The host captures the bearer and hands
// it in, which is what makes "captured" true — a getter would be a re-read with
// extra steps. The bearer never reaches a renderer; only the content key does,
// and only through `Fence.exposeKey`.

export interface AuthorityInput {
  readonly accountId: string;
  readonly deviceId: string;
  /** The renderer document that owns this job. One document, one job. */
  readonly documentId: string;
  /** This build's origin, from the host. A link can never contribute one. */
  readonly origin: string;
  /** The account bearer, captured. */
  readonly bearer: string;
}

export interface UploadAuthority {
  readonly accountId: string;
  readonly deviceId: string;
  readonly documentId: string;
  readonly origin: string;
  readonly bearer: string;
}

export type RevocationReason =
  /** The signed-in account changed, or signed out. */
  | "account-changed"
  /** The owning renderer document was destroyed or reloaded. */
  | "document-revoked"
  /** The job settled; the authority is spent. */
  | "job-settled"
  /** The caller cancelled. */
  | "cancelled";

export class AuthorityRevoked extends Error {
  constructor(readonly reason: RevocationReason) {
    super(`upload authority revoked: ${reason}`);
    this.name = "AuthorityRevoked";
  }
}

/** Every field must be present: an empty bearer or account id is not an
 *  authority, and discovering that at the first request would mean discovering
 *  it after a key had been generated and persisted. */
export function captureAuthority(input: AuthorityInput): UploadAuthority {
  for (const [field, value] of Object.entries(input)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`upload authority is missing ${field}`);
    }
  }
  try {
    if (new URL(input.origin).origin !== input.origin) throw new TypeError("origin is not an origin");
  } catch {
    throw new TypeError("upload authority origin is not a URL origin");
  }
  // Frozen so nothing downstream can rewrite the identity a job is running
  // under — including this module's own future callers.
  return Object.freeze({
    accountId: input.accountId,
    deviceId: input.deviceId,
    documentId: input.documentId,
    origin: input.origin,
    bearer: input.bearer,
  });
}

/**
 * The gate every request, every callback and every key exposure passes.
 *
 * `assert()` is called at the LAST moment before an irreversible or outward
 * act, not once at the top of a job: the whole point is that an await in the
 * middle of a job is where a revocation lands.
 */
export class Fence {
  private revoked: RevocationReason | null = null;
  /**
   * Aborted when this fence is revoked.
   *
   * The fence used to be a check-only gate, which left one request with no way
   * to be stopped: `UploadEngine.open` sends `POST /api/uploads` BEFORE the
   * engine (and therefore its own AbortController) exists, so a revocation
   * during init could only be noticed after the answer came back. A quiesce
   * that cannot reach the request it is quiescing is not a quiesce, so the
   * signal lives here — one per job, from before the first request to after the
   * last.
   */
  private readonly aborter = new AbortController();

  constructor(readonly authority: UploadAuthority) {}

  /** Fires on revocation. Every request a job makes is bound to this. */
  get signal(): AbortSignal {
    return this.aborter.signal;
  }

  get valid(): boolean {
    return this.revoked === null;
  }

  get reason(): RevocationReason | null {
    return this.revoked;
  }

  /** Idempotent, and first reason wins: a cancel that races a sign-out must not
   *  have its diagnosis overwritten by whatever arrives second. */
  revoke(reason: RevocationReason): void {
    if (this.revoked !== null) return;
    this.revoked = reason;
    // Aborted AFTER the reason is recorded, so a listener that inspects the
    // fence sees a consistent state.
    this.aborter.abort();
  }

  /** Throws once revoked. Used before a request, before publishing progress,
   *  and before handing out the content key. */
  assert(): void {
    if (this.revoked !== null) throw new AuthorityRevoked(this.revoked);
  }

  /**
   * Revoke unless the current identity still matches the captured one.
   *
   * The host calls this on a sign-in change. Comparing rather than adopting is
   * the point: an account that no longer matches ends the job.
   */
  reconcile(current: { readonly accountId: string; readonly deviceId: string }): void {
    if (
      current.accountId !== this.authority.accountId ||
      current.deviceId !== this.authority.deviceId
    ) {
      this.revoke("account-changed");
    }
  }

  /** The content key, released only to a live authority and only for the
   *  document that owns the job. */
  exposeKey(documentId: string, encodedKey: string): string {
    this.assert();
    if (documentId !== this.authority.documentId) {
      throw new AuthorityRevoked("document-revoked");
    }
    return encodedKey;
  }
}
