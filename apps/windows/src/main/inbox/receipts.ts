// The closed terminal facade: what a caller may learn about an outcome.
//
// ## Why this is a closed union and not an error string
//
// Everything that crosses out of the Inbox — to a log, to the renderer, to a
// crash report — passes through here. The types below carry stable codes,
// counts and booleans. There is no member that can hold a filesystem path, a
// private key, a server response body or a raw exception message, so no future
// caller can put one there by accident.
//
// The native helper already applies the same rule on its side of the boundary:
// its stderr carries codes and indices only. This is the host-side half.

/** Stable, host-visible failure classification. Never free text. */
export type InboxFailureCode =
  | "account-changed"
  | "not-enrolled"
  | "key-unavailable"
  | "storage-unreadable"
  | "manifest-refused"
  | "length-mismatch"
  | "verification-failed"
  | "transport"
  | "redirect-refused"
  | "origin-refused"
  | "server-refused"
  | "cancelled"
  | "helper-failed"
  | "retention-full"
  | "reconcile-blocked"
  | "internal";

/**
 * What happened to the bytes on the user's disk.
 *
 * `unknown` is a real answer and the honest one after a forced teardown: the
 * helper reports `residue` when a kill may have left staging behind, and this
 * side does not upgrade that to `none` because the process was observed to exit.
 */
export type ResidueState = "none" | "present" | "unknown";

export interface InboxFailure {
  readonly code: InboxFailureCode;
  /** The helper's or server's own stable code, when there was one. */
  readonly peerCode?: string;
  readonly residue: ResidueState;
}

/** The terminal outcome of one delivery. */
export type DeliveryReceipt =
  | {
      readonly kind: "saved";
      /** Every declared item landed. */
      readonly total: number;
      readonly residue: ResidueState;
      /**
       * The files are on disk but central has not been told yet.
       *
       * A lost acknowledgement is NOT a lost delivery, and reporting one as a
       * failure would be false in the direction that matters: the user's files
       * exist. The journal is left at `published`, whose reconciliation is
       * "replay the ACK" — never re-download, never re-publish.
       */
      readonly ackPending: boolean;
      /**
       * The durable record of this commit was written.
       *
       * `false` means the files exist but the `published` marker did not land,
       * so there is NO record for a later run to reconcile from. That is a
       * weaker position than `ackPending` alone: with the marker, recovery is
       * "replay the ACK"; without it, this side cannot prove the full publish
       * happened and must not claim replay durability it does not have.
       */
      readonly journalRecorded: boolean;
    }
  | {
      readonly kind: "saved-message";
      readonly residue: ResidueState;
      readonly ackPending: boolean;
      readonly journalRecorded: boolean;
    }
  // A partial carries no `ackPending`: it is never acknowledged at all.
  // `partial -> acked` is not a legal journal move, because telling central a
  // partial batch was complete is the one claim this path must never make.
  | {
      readonly kind: "partial";
      /** Items 0..savedCount-1 exist on disk. The prefix is authoritative. */
      readonly savedCount: number;
      readonly total: number;
      readonly failedIndex: number;
      /** The peer's stable code for the item that stopped the batch. */
      readonly reason: string;
      readonly residue: ResidueState;
      /** The `partial` marker was written. See `saved`. */
      readonly journalRecorded: boolean;
    }
  | {
      readonly kind: "refused";
      readonly failure: InboxFailure;
    };

/**
 * The one place a thrown value becomes a reportable failure.
 *
 * A caller must not put `String(error)` anywhere: a Node error message
 * routinely embeds the path that produced it, and a server rejection body is
 * remote text. So an unrecognised throw becomes `internal` with no detail at
 * all, which is less useful and cannot leak.
 */
export function asFailure(error: unknown, residue: ResidueState = "unknown"): InboxFailure {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return { code: "internal", residue };
  const mapped = MAPPED[code];
  if (mapped === undefined) return { code: "internal", residue };
  // `peerCode` is included only for codes that are themselves stable protocol
  // tokens — never for an errno or an internal string.
  return code.startsWith("E_")
    ? { code: mapped, peerCode: code, residue }
    : { code: mapped, residue };
}

/** Known codes, mapped explicitly. An unknown one is deliberately `internal`. */
const MAPPED: Readonly<Record<string, InboxFailureCode>> = {
  // Account and store.
  "account-changed": "account-changed",
  "not-enrolled": "not-enrolled",
  "unknown-key": "key-unavailable",
  "retention-full": "retention-full",
  unreadable: "storage-unreadable",
  "unsupported-version": "storage-unreadable",
  "key-unavailable": "key-unavailable",
  "duplicate-public-key": "key-unavailable",
  "total-mismatch": "verification-failed",
  "illegal-transition": "internal",
  "count-out-of-range": "verification-failed",
  "not-recorded": "internal",
  // Transport.
  network: "transport",
  timeout: "transport",
  "too-large": "transport",
  redirect: "redirect-refused",
  "bad-url": "origin-refused",
  "origin-refused": "origin-refused",
  "redirect-refused": "redirect-refused",
  "server-refused": "server-refused",
  "resume-restart": "transport",
  // Helper.
  "helper-unavailable": "helper-failed",
  "helper-timeout": "helper-failed",
  "cleanup-uncertain": "helper-failed",
  residue: "helper-failed",
  "short-write": "length-mismatch",
  "length-short": "length-mismatch",
  "length-exceeded": "length-mismatch",
  "publish-failed": "helper-failed",
  protocol: "verification-failed",
  cancelled: "cancelled",
  busy: "internal",
  "io-failed": "helper-failed",
  // Manifest.
  "manifest-refused": "manifest-refused",
};
