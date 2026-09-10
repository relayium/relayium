// The sender's wire vocabulary, read from the handlers rather than chosen.
//
// Sources: `server/account/deviceinbox_task.go` (`handleCreateInboxTask` at 245,
// `writeInboxTaskError` at 620) and `server/internal/inbox/task.go`.
//
// The receive side has its own `wire.ts` and is untouched. This exists because
// the sender's routes are ACCOUNT-scoped while the receiver's are device-self
// (`deviceinbox_task.go:53`), and collapsing them would put a device-self
// assumption on a route the browser is the primary caller of.
import type { TaskState, WireTask } from "./wire.js";

/**
 * A task as the SENDER reads it.
 *
 * `WireTask` is the receiver's subset and is frozen. The sender needs one more
 * field the server has always sent: `StoredFileID`. Without it a convergence
 * lookup can only match on the idempotency key, and a key that central says is
 * `idempotency_key_conflict` names a task built from a DIFFERENT request —
 * adopting it would record somebody else's delivery as this job's. Extending
 * here rather than editing `wire.js` keeps the receiver's contract untouched.
 */
export interface SenderTask extends WireTask {
  readonly StoredFileID: string;
}

/** `POST .../inbox/tasks` decodes STRICTLY. These are the only legal fields. */
export interface CreateTaskRequest {
  readonly idempotencyKey: string;
  readonly storedFileId: string;
  /** REQUIRED from v2 on: the zero value is not a version and is refused. */
  readonly protocolVersion: number;
  readonly wrapAlgorithm: string;
  readonly wrappedKey: string;
  readonly targetKeyId: string;
  readonly targetKeyGeneration: number;
}

/**
 * Strict decoding is load-bearing, not hygiene.
 *
 * The handler's own comment says so: it is what makes a request carrying
 * `contentKey`, `privateKey`, `fileName`, `kind` or `text` a 400 rather than a
 * field some later version might start honouring. Nothing may be added here
 * without the server adding it first.
 */
export const CREATE_TASK_FIELDS: readonly (keyof CreateTaskRequest)[] = Object.freeze([
  "idempotencyKey",
  "storedFileId",
  "protocolVersion",
  "wrapAlgorithm",
  "wrappedKey",
  "targetKeyId",
  "targetKeyGeneration",
]);

/** `printableASCIIToken`: no whitespace, no control characters, no non-ASCII. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
export function isLegalIdempotencyKey(value: string): boolean {
  if (value.length === 0 || value.length > MAX_IDEMPOTENCY_KEY_LENGTH) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code > 0x7e) return false;
  }
  return true;
}

/** `inbox.MaxPendingTasksPerDevice`. Unfinished rows per target device. */
export const MAX_PENDING_TASKS_PER_DEVICE = 256;

/**
 * Every refusal token the create path can answer with.
 *
 * Kept as a closed set because each one implies different client behaviour —
 * the handler's own comment: re-read the key, wait for the backoff, stop
 * entirely, or ask a human. Collapsing them into "the send failed" is what
 * makes a client retry something that can never succeed.
 */
export const SEND_REFUSALS = Object.freeze({
  senderDeviceRequired: "sender_device_required",
  unsupportedProtocolVersion: "unsupported_protocol_version",
  invalidIdempotencyKey: "invalid_idempotency_key",
  unsupportedKeyAlgorithm: "unsupported_key_algorithm",
  autoReceiveDisabled: "auto_receive_disabled",
  unsupportedAutoAcceptCapability: "unsupported_auto_accept_capability",
  deviceCannotReceive: "device_cannot_receive",
  deviceInboxRevoked: "device_inbox_revoked",
  staleTargetKey: "stale_target_key",
  idempotencyKeyConflict: "idempotency_key_conflict",
  storedObjectUnavailable: "stored_object_unavailable",
  storedObjectAlreadyBound: "stored_object_already_bound",
  inboxQueueFull: "inbox_queue_full",
} as const);

export type SendRefusal = (typeof SEND_REFUSALS)[keyof typeof SEND_REFUSALS];

/**
 * How an outcome must be treated. The distinction the whole sender is built on.
 *
 *  - `definitive-refused` — central's transaction rolled back; no task can own
 *    the ciphertext, and this request can never succeed. The object is provably
 *    unbound, so it is released.
 *  - `definitive-retain` — central's transaction rolled back too, but the SAME
 *    request could succeed later: the target's queue drained, or this
 *    installation finished enrolling as a sender. Nothing is released, and the
 *    plan stays at `creating` so the retry is the identical request.
 *  - `definitive-keep-object` — refused, and the object must NOT be released:
 *    `stored_object_already_bound` says a task WE DID NOT CREATE owns those
 *    bytes, and `unauthorized`'s remedy is local and self-healing.
 *  - `converge` — positive evidence that this key already names a task.
 *  - `ambiguous` — the request never arrived or its answer was lost. A delivery
 *    MAY be live, so nothing may be released.
 */
export type OutcomeClass =
  | "definitive-refused"
  | "definitive-retain"
  | "definitive-keep-object"
  | "refused-before-replay"
  | "converge"
  | "ambiguous";

/**
 * Refusals `handleCreateInboxTask` produces BEFORE `CreateInboxTask` runs.
 *
 * This distinction is load-bearing and was missing. The idempotent replay is
 * checked INSIDE the store transaction, but the handler validates the protocol
 * version, the idempotency key's shape, the wrap algorithm and the sealed box's
 * length before it ever gets there. A refusal from that stretch therefore says
 * NOTHING about whether an earlier attempt under this key already committed —
 * the question was never asked. Treating one as definitive is how a retry after
 * a config change would release the ciphertext of a delivery that is already
 * queued on the target device.
 */
export const PRE_REPLAY_REFUSALS: ReadonlySet<string> = new Set([
  SEND_REFUSALS.senderDeviceRequired,
  SEND_REFUSALS.unsupportedProtocolVersion,
  SEND_REFUSALS.invalidIdempotencyKey,
  SEND_REFUSALS.unsupportedKeyAlgorithm,
  "malformed_wrapped_key",
]);

/**
 * Classify what central ANSWERED.
 *
 * This reads a server verdict only. A create whose answer was never read is not
 * a verdict at all, and the coordinator classifies that case itself — passing a
 * transport failure through here would map an unread answer onto
 * `definitive-refused` and release an object a live task may already own.
 */
export function classifyRefusal(token: string | undefined, status: number): OutcomeClass {
  if (status === 401 || status === 403) return "definitive-keep-object";
  // Checked before the replay was, so it is a verdict on THIS request only.
  if (token !== undefined && PRE_REPLAY_REFUSALS.has(token)) return "refused-before-replay";
  // A bare 400 is the handler's own field-presence check, which also runs before
  // the transaction. Same reasoning, and it carries no token to match on.
  if (status === 400 && token === undefined) return "refused-before-replay";
  // 5xx and a missing/unreadable answer are retryable: the write may still have
  // landed, which is exactly what "ambiguous" means.
  if (status >= 500) return "ambiguous";
  if (token === SEND_REFUSALS.idempotencyKeyConflict) return "converge";
  if (token === SEND_REFUSALS.storedObjectAlreadyBound) return "definitive-keep-object";
  // 429 is `inbox_queue_full` and the account rate limits. The target device has
  // `MAX_PENDING_TASKS_PER_DEVICE` unfinished rows and will drain them. Treating
  // it as definitively refused would delete the ciphertext and charge the user a
  // whole second upload for a condition that clears on its own.
  if (status === 429) return "definitive-retain";
  return "definitive-refused";
}

/** What one create answered. `created` is a CREATION FLAG, never a state. */
export interface CreateTaskResult {
  /** 201 -> true, a converged 200 -> false. Not the task's state. */
  readonly created: boolean;
  /** The task central actually holds. Its `State` is the authority. */
  readonly task: SenderTask;
}

/** The states a sender may see on a task it created. */
export function isTerminalForSender(state: TaskState): boolean {
  return state === "saved" || state === "expired" || state === "revoked" || state === "failed_terminal";
}
