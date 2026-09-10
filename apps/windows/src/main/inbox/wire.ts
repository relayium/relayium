// The server's actual wire shapes for the Device Inbox.
//
// ## Every name here was read from the server, not chosen
//
// `server/account/deviceinbox_task.go` tags its view structs explicitly, and the
// tags are **PascalCase**: `json:"ID"`, `json:"TargetKeyID"`, `json:"EncManifest"`.
// An earlier version of the client guessed camelCase (`id`, `targetKeyId`), which
// would have failed to parse the very first real response — every field would
// have been absent and every delivery refused as malformed.
//
// The request bodies are the other way round: `handleReportInboxTask` decodes
// `json:"claimToken"`, `json:"state"`, `json:"errorCode"`, `json:"committed"` —
// camelCase. The two casings are not a mistake to normalise; they are what the
// server reads and writes, and this file exists so exactly one place has to know.
//
// Source: `server/account/deviceinbox_task.go` (`inboxTaskView`,
// `inboxDeliveryView`, `handleClaimInboxTasks`, `handleReportInboxTask`) and
// `server/internal/inbox/task.go` (state set, `MaxClaimBatch`).

/** Server task states. Sender-local phases are NOT in this set. */
export const TASK_STATES = [
  "queued",
  "notified",
  "downloading",
  "verifying",
  "saved",
  "attention_required",
  "expired",
  "revoked",
  "failed_retryable",
  "failed_terminal",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** States that never transition again. */
export const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set([
  "saved",
  "expired",
  "revoked",
  "failed_terminal",
]);

/**
 * `saved` is reachable ONLY from `verifying`.
 *
 * The server's own comment on the transition table: "No path exists from
 * `downloading` — 'the bytes arrived' is not 'the file is on disk'." A receiver
 * that reported `saved` straight after the download would be refused, and
 * rightly.
 */
export const SAVED_REQUIRES_PRIOR_STATE = "verifying" as const;

/** The server's claim batch ceiling. A reply may never exceed it. */
export const MAX_CLAIM_BATCH = 32;

/** The claim token header. Never a URL parameter. */
export const CLAIM_TOKEN_HEADER = "X-Relayium-Inbox-Claim";

/** Bounded rejection-body read, matching the Go client's `maxErrorBody`. */
export const MAX_ERROR_BODY_BYTES = 4 << 10;

/** Server error tokens this client acts on. */
export const ERR_STALE_CLAIM = "stale_claim";
export const ERR_TASK_TERMINAL = "task_terminal";

/**
 * A task as the server serialises it. Only the fields this client uses are
 * declared; the server sends more and the extras are ignored rather than
 * refused, because a server that adds a field must not break an older client.
 */
export interface WireTask {
  readonly ID: string;
  readonly SourceDeviceID: string;
  readonly IdempotencyKey: string;
  readonly State: TaskState;
  readonly ErrorCode: string;
  readonly CiphertextBytes: number;
  readonly WrapAlgorithm: string;
  readonly TargetKeyID: string;
  readonly TargetKeyGeneration: number;
  readonly CreatedAt: number;
  readonly ExpiresAt: number;
  readonly SavedAt: number;
  readonly Terminal: boolean;
}

export interface WireDelivery extends WireTask {
  /** Standard base64 (not base64url), matching `GET /api/files/{id}/meta`. */
  readonly EncManifest: string;
  /** Raw base64url, exactly `sealedBoxBytes` once decoded. */
  readonly WrappedKey: string;
  readonly ClaimToken: string;
}
