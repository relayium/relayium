// What a finished receive hands the page so it can offer "show me the folder".
//
// ## Why a token and not a path
//
// The renderer never learns where anything was saved. The user chose that
// folder in a native dialog main opened, and main is the only side that has
// ever held the string; a page that could read it could also log it, put it in
// a diagnostic, or send it. So what crosses is an opaque handle to a directory
// main already knows, plus a count — which the page needs to write a sentence
// and which reveals nothing about what was received.
//
// Nothing here carries file NAMES either, for a narrower reason: a reveal opens
// a FOLDER, so a name would be a detail this channel has no use for, and the
// smallest contract that does the job is the one to ship. That is a statement
// about this contract only — the Device Inbox keeps a protected named history
// of its own, and diagnostics are a separate surface with separate rules.
//
// ## Why the reveal cannot take a path either
//
// The obvious alternative — main gives the page a path, the page gives it back
// to be opened — is worse than useless: it is an IPC channel that opens an
// arbitrary directory named by the renderer. The token indexes a directory main
// chose, so the channel's whole vocabulary is "the folder from that receipt",
// and a renderer cannot name anything else.
//
// Shared, so both sides compile against one definition. Types and one validator
// only: nothing here reads a file, opens a window, or imports from `node:`.

/**
 * An opaque handle to a directory MAIN holds.
 *
 * Deliberately not a branded alias over `string` with structural meaning: the
 * page must be able to store it and hand it back, and must be able to do
 * nothing else with it. Treat it as bytes.
 */
export type ReceiptToken = string;

/** What main gives the page when a receive has actually been published. */
export interface ReceiveReceipt {
  readonly token: ReceiptToken;
  /** How many files were published. For a sentence, not for addressing. */
  readonly fileCount: number;
}

/**
 * Why a reveal did not happen. A CLOSED set.
 *
 * Closed on purpose: the alternative is passing the operating system's own
 * error text to a surface, which is how a path, a user name or a volume label
 * reaches a screenshot. Each of these is a distinct thing the user can act on,
 * and none of them carries a detail from the machine.
 */
export type RevealRefusal =
  /** No such receipt: never issued, already dropped, or not this session's. */
  | "unknown"
  /** Issued, but for a different account or a document that has been replaced. */
  | "stale"
  /** The app is shutting down and is not starting new work. */
  | "fenced"
  /** The folder is no longer there, or is no longer a folder. */
  | "missing"
  /** It is there, and the system would not open it. */
  | "failed";

export type RevealOutcome =
  | { readonly kind: "revealed" }
  | { readonly kind: "refused"; readonly reason: RevealRefusal };

/**
 * The exact shape a token has, so an unexpected one is refused before it is
 * used to look anything up.
 *
 * 64 lowercase hex characters — 32 random bytes. The check is not a security
 * boundary by itself (the entropy is), but a value of the wrong shape is a
 * caller doing something other than handing back what it was given, and that is
 * worth refusing on sight rather than treating as a miss.
 */
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export const isReceiptToken = (value: unknown): value is ReceiptToken =>
  typeof value === "string" && TOKEN_PATTERN.test(value);

/** Bytes of entropy behind a token. Named here because both the minting side
 *  and the validator above have to agree about the length. */
export const RECEIPT_TOKEN_BYTES = 32;
