// What a stored receive settles as, and the closed set of reasons it can fail.
//
// ## Outcomes are values, failures are values, and both are truthful
//
// The shapes here exist so no caller has to infer what happened. In particular
// `partially-saved` is a resolution rather than an error: the helper publishes
// in manifest order and stops at the first conflict, so some files can genuinely
// exist under their final names while the rest never will, and calling that
// success or failure is a lie in one direction. `residue` rides on every
// outcome that can carry it, because bytes possibly left on the user's disk is
// something the user must be told, not something to resolve away quietly.
//
// ## Nothing here carries content
//
// No filename, no path, no response body, no URL, no key material. Every field
// is a code from a closed set, a count or a boolean — so a report can be
// rendered, logged or attached to a bug report without leaking what was being
// transferred, where it was going or what would open it.

import type { ManifestRefusal } from "./manifest.js";

/** What this object turned out to be. Retained even when the transfer fails, so
 *  a later UI can say "that link expired" rather than "something went wrong". */
export interface StoredObjectFacts {
  readonly fileCount: number;
  readonly totalBytes: number;
  /**
   * The server deletes this object after one successful GET.
   *
   * Kept because it changes what a failure MEANS: a burn object can already be
   * gone by the time the local write finishes — the server deletes after
   * serving, which can complete before publication does — so a retry of the
   * same link will 404 and that is not a new fault. The client does not control
   * that deletion and must not imply it can.
   */
  readonly burnAfterRead: boolean;
  /** Unix seconds, as the server reported it. Unauthenticated. */
  readonly expiresAt: number;
}

export type StoredFailureCode =
  /** The link is not one this build will act on. See `StoredLinkRejection`. */
  | "link-invalid"
  /** The shared-protocol bundle is missing or unloadable. A build fault. */
  | "runtime-unavailable"
  /** 404. The TTL lapsed, another receiver burned it, or the GC ran. Nothing to
   *  do with this recipient's key or this object's integrity. */
  | "not-found"
  /** 403. */
  | "forbidden"
  /** 429. */
  | "rate-limited"
  /** Any other non-2xx, including 5xx. `status` carries which. */
  | "server-error"
  /** The request never reached a server. */
  | "network"
  /** A deadline or the stall watchdog. */
  | "timeout"
  /** Central answered with a redirect. Refused, not followed. */
  | "redirect-refused"
  /** A body or a declared length past its ceiling. */
  | "too-large"
  /** A 2xx answer that is not the documented document. */
  | "malformed-response"
  /** This build will not write this manifest. `refusal` says why. */
  | "manifest-refused"
  /** The ciphertext did not open, or did not match what the manifest declared:
   *  a wrong key, tampering, or a truncation. NOTHING was published. */
  | "integrity"
  /** The IO helper could not be started, or stopped speaking its protocol. */
  | "destination-unavailable"
  /** The helper accepted the lease and then failed a write, finish or count. */
  | "destination-io"
  /** The helper refused publication outright; no file reached its final name. */
  | "publish-failed"
  /** Publication never settled, or teardown could not be confirmed. */
  | "cleanup-uncertain"
  /** The destination stopped belonging to this transfer. */
  | "authority-changed"
  /** This process is already holding as many unfinished cleanups as it will,
   *  so it will not start a helper it cannot promise to own. The remedy is to
   *  retry the retained cleanups; see `CleanupRegistry`. */
  | "cleanup-capacity"
  /** A defect in this process. Never a network or user condition. */
  | "internal";

export interface StoredReceiveFailure {
  readonly code: StoredFailureCode;
  /** HTTP status, for the codes derived from one. Null otherwise. */
  readonly status: number | null;
  /** Which manifest shape was refused, for `manifest-refused` from this side. */
  readonly refusal: ManifestRefusal | null;
  /** True when bytes may remain on disk. Never a guess dressed as a `false`. */
  readonly residue: boolean;
  /**
   * Whether the WHOLE receive may be attempted again from the start.
   *
   * Never a resume. An interrupted body is not continued: the decryptor holds
   * partial frame state and the destination holds partial file state, so
   * "carry on from here" would decrypt under the wrong frame sequence. A retry
   * is a fresh link fetch, a fresh manifest and a fresh lease.
   *
   * True only for the transport faults that can genuinely differ next time —
   * the request never reached a server, timed out, was rate-limited, or the
   * server erred. FALSE after any AEAD or destination failure: an object whose
   * ciphertext did not authenticate will not authenticate on a second attempt
   * either, and offering a retry there suggests the key or the disk might be
   * fine when the evidence says otherwise.
   */
  readonly retryable: boolean;
  /**
   * A ticket for retrying a teardown that did not settle, or null.
   *
   * Null does not mean the disk is clean — `residue` says that. It means this
   * process holds nothing that could still finish the cleanup: either teardown
   * settled, or the helper had already exited (post-publication residue), or
   * the retained-cleanup cap was reached. See `cleanup.ts`.
   */
  readonly cleanupTicket: string | null;
  /**
   * What is known about publication.
   *
   * `"none"` is a PROOF, not a default: publication was never requested, or the
   * helper answered a well-formed refusal for the whole batch. `"unknown"` is
   * for the cases where this process genuinely cannot tell — the publish
   * request stopped being answered, or the helper claimed a prefix in a receipt
   * that could not be verified. A UI must not say "nothing was saved" for
   * `"unknown"`; the truthful statement is that the outcome could not be
   * confirmed and the folder should be checked.
   */
  readonly published: "none" | "unknown";
}

export type StoredReceiveReport =
  /** Every file exists under the name the manifest declared. */
  | {
      readonly status: "saved";
      readonly facts: StoredObjectFacts;
      readonly publishedCount: number;
      readonly residue: boolean;
      /** Set when teardown after a SUCCESSFUL publication did not settle. See
       *  `StoredReceiveFailure.cleanupTicket`. */
      readonly cleanupTicket: string | null;
    }
  /** A proper prefix of the manifest exists on disk. The rest never will. */
  | {
      readonly status: "partially-saved";
      readonly facts: StoredObjectFacts;
      readonly publishedCount: number;
      readonly total: number;
      readonly failedIndex: number;
      /** The helper's own stable code for the file that stopped it. */
      readonly reason: string;
      readonly residue: boolean;
      /** See `StoredReceiveFailure.cleanupTicket`. */
      readonly cleanupTicket: string | null;
    }
  /** The user closed the folder picker. Nothing was requested, nothing written. */
  | { readonly status: "declined" }
  /** The caller cancelled. Staging was torn down; nothing was published. */
  | {
      readonly status: "cancelled";
      readonly residue: boolean;
      /** See `StoredReceiveFailure.cleanupTicket`. */
      readonly cleanupTicket: string | null;
    }
  /** Publication did not complete. `failure.published` says whether "nothing
   *  was saved" is a proven statement or merely an unconfirmed one. */
  | { readonly status: "failed"; readonly failure: StoredReceiveFailure };

/**
 * The codes a fresh attempt could plausibly get past.
 *
 * One statement rather than a condition repeated at each throw site, so the
 * "network faults only" rule cannot drift between call sites.
 */
export function isRetryable(code: StoredFailureCode): boolean {
  return code === "network" || code === "timeout" || code === "server-error" || code === "rate-limited";
}
