// Device Inbox, sender half: everything about "may I send to this device, and
// what is truthfully happening to what I sent" that does not touch the DOM,
// the network or a key. Kept pure so every branch below is unit-testable.
//
// Protocol: docs/protocol/relayium-device-inbox-v1.md §§2, 5, 6, 9, 13, 14, 16.
// Product:  DEVICE-INBOX-PRD.md §6.1, §7, §8, §10.
//
// Two rules shape this whole file:
//
//  1. **Presence is advisory, capability is not.** An offline device that is
//     properly enrolled is a legitimate target — the task queues and lands when
//     it comes back (PRD §7.3). Only enrolment, revocation, key material,
//     capability and the device-owner's automatic-receive policy can make a
//     device unsendable. Collapsing the two would make "offline" mean
//     "rejected" and delete the reason the queue exists.
//  2. **Never say "sent".** PRD §10 is explicit: "ciphertext uploaded" and
//     "the target device saved it" must not share one vague state. So the
//     sender-local phases and the server states are different types here, and
//     `saved` is reachable only from the server's own `saved`.

/** The one wrap algorithm this protocol version defines (protocol §2). */
export const INBOX_KEY_ALGORITHM = "x25519-sealedbox-v1";

/** Raw X25519 public key length. A key of any other length is refused before it
 *  can be wrapped to (protocol §2, "Rejected public keys"). */
export const X25519_PUBLIC_KEY_BYTES = 32;

/** `inbox.receive.v1` — the capability central negotiates. A device central
 *  cannot describe must not appear as a send target (protocol §4). */
export const CAP_RECEIVE_V1 = "inbox.receive.v1";

/** Presence TTL is 90s against a 30s heartbeat (protocol §6). The sender polls
 *  the device list on a bounded timer so "online" is not indefinitely stale. */
export const DEVICE_REFRESH_MS = 30_000;

// ── The shapes /api/devices returns ────────────────────────────────────────

/** The active device key, `null` when there is none (protocol §9). */
export interface DeviceKeyView {
  ID: string;
  Algorithm: string;
  PublicKey: string;
  Generation: number;
  CreatedAt: number;
  SupersededAt: number;
  RevokedAt: number;
}

export type AutoAcceptPolicy = "off" | "ask" | "auto";

/** The additive `Inbox` subtree on each device row (protocol §9). `null` for
 *  every device that never enrolled — every browser, and any client build
 *  predating Phase 1A. */
export interface DeviceInboxView {
  Presence: string;
  LastHeartbeatAt: number;
  PresenceExpiresAt: number;
  HeartbeatIntervalSeconds: number;
  ProtocolVersion: number;
  Capabilities: string[];
  ReceiveCapability: string;
  AutoAccept: string;
  ReceiveDirReady: boolean;
  Platform: string;
  AppVersion: string;
  Revoked: boolean;
  CanReceive: boolean;
  RegisteredAt: number;
  Key: DeviceKeyView | null;
}

// ── Identifier hygiene ─────────────────────────────────────────────────────

/** Every id this module composes into a request path must be ONE inert token.
 *
 *  `encodeURIComponent` is not sufficient here and that is the whole reason this
 *  exists: it does not escape `.`, so a device or task id of `..` survives
 *  encoding intact and `/api/devices/../inbox/tasks` is a request aimed at an
 *  endpoint this send never authorised — resolved by the browser, a proxy or the
 *  server for its own reasons, none of which this client controls. Refusing is
 *  the only defence that does not depend on who normalises the path.
 *
 *  Deliberately wider than what the server issues (`authx.NewID()` — 32 hex) and
 *  identical to `stored-file.ts`'s rule, so the three ids a send handles obey one
 *  spelling. */
const INERT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** True when `id` is safe to interpolate into a request path. */
export function isInertId(id: unknown): id is string {
  return typeof id === "string" && INERT_ID_RE.test(id);
}

// ── Parsing a device row defensively ───────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function bool(v: unknown): boolean {
  return v === true;
}

/** Parse the `Key` subtree, or `null`.
 *
 *  Returns `null` rather than a partially-filled object for anything that is not
 *  a plain object: a key is either completely describable or absent, and a
 *  half-parsed one would flow into the seal as an empty `PublicKey`. */
function parseDeviceKey(raw: unknown): DeviceKeyView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const k = raw as Record<string, unknown>;
  return {
    ID: str(k.ID),
    Algorithm: str(k.Algorithm),
    PublicKey: str(k.PublicKey),
    Generation: num(k.Generation),
    CreatedAt: num(k.CreatedAt),
    SupersededAt: num(k.SupersededAt),
    RevokedAt: num(k.RevokedAt),
  };
}

/** Parse the `Inbox` subtree of one `/api/devices` row, or `null`.
 *
 *  Every field is coerced to its declared type instead of being trusted, because
 *  the *consequences* of the fields differ wildly: `CanReceive: "false"` is
 *  truthy in JavaScript and would present a dead device as a send target, and a
 *  `Capabilities` that is not an array would throw inside a `.includes`. This is
 *  our own server, so this is a guard on a broken/substituted response and on a
 *  future field that changes shape — not a defence against the account. */
export function parseDeviceInbox(raw: unknown): DeviceInboxView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  return {
    Presence: str(v.Presence),
    LastHeartbeatAt: num(v.LastHeartbeatAt),
    PresenceExpiresAt: num(v.PresenceExpiresAt),
    HeartbeatIntervalSeconds: num(v.HeartbeatIntervalSeconds),
    ProtocolVersion: num(v.ProtocolVersion),
    Capabilities: Array.isArray(v.Capabilities) ? v.Capabilities.filter((c): c is string => typeof c === "string") : [],
    ReceiveCapability: str(v.ReceiveCapability),
    AutoAccept: str(v.AutoAccept),
    ReceiveDirReady: bool(v.ReceiveDirReady),
    Platform: str(v.Platform),
    AppVersion: str(v.AppVersion),
    Revoked: bool(v.Revoked),
    CanReceive: bool(v.CanReceive),
    RegisteredAt: num(v.RegisteredAt),
    Key: parseDeviceKey(v.Key),
  };
}

// ── May I send to this device? ─────────────────────────────────────────────

/** Why a device cannot be sent to. Each maps to one localized sentence that
 *  says what the USER can do about it — they are not collapsed because the
 *  remedies differ (enable it there, fix its key, clear the revocation…). */
export type SendBlock =
  | "not_enrolled" // no Device Inbox at all: a browser, or a client too old
  | "revoked" // enrolment revoked; a human must clear it from another device
  | "cannot_receive" // central says no: unsupported version, no active key
  | "unsupported_key" // key missing, wrong algorithm, or not a canonical 32-byte X25519 point
  | "unsupported_capability" // the negotiated receive capability is not one we can drive
  | "receive_off" // the device owner has automatic receive off (protocol §14)
  | "unknown_policy" // a policy string this build cannot reason about — fail closed
  | "unusable_id"; // an id that cannot be safely composed into a request path

/** Truthful qualifications on a send that IS allowed. Never suppressed: a card
 *  that is sendable but will not land unattended has to say so before the drop,
 *  not after. */
export type SendCaveat =
  | "queued_until_online" // offline but cryptographically able: the task waits
  | "needs_approval" // policy `ask`: a person at that machine must accept
  | "directory_not_ready"; // policy `auto`, but its receive folder was last reported unusable

export interface SendAvailability {
  sendable: boolean;
  /** Set exactly when `sendable` is false. */
  block?: SendBlock;
  /** Ordered, most-consequential first. Possibly empty. */
  caveats: SendCaveat[];
  online: boolean;
  /** The device owner's policy, `""` when unparseable. */
  policy: AutoAcceptPolicy | "";
}

function parsePolicy(raw: string): AutoAcceptPolicy | "" {
  return raw === "off" || raw === "ask" || raw === "auto" ? raw : "";
}

/** Is `s` canonical unpadded base64url of exactly `bytes` bytes?
 *
 *  Text-level only — the byte-level checks (length, low-order point) live in
 *  `device-seal.ts` next to the primitive that would misuse them. Both run: this
 *  one decides whether a CARD is sendable without loading libsodium, and the
 *  other decides whether a key may actually be wrapped to.
 *
 *  `length % 4 === 1` is impossible for base64, and the final-character mask
 *  rejects a spelling whose trailing bits are non-zero — the same strictness
 *  `base64.RawURLEncoding.Strict()` applies on the Go side, so one key has one
 *  spelling on every surface (WORKFLOW-LEARNINGS, 2026-08-08). */
export function isCanonicalB64Url(s: string, bytes: number): boolean {
  const want = Math.ceil((bytes * 8) / 6);
  if (s.length !== want || !/^[A-Za-z0-9_-]+$/.test(s)) return false;
  // Bits carried by the final character beyond the byte boundary must be zero.
  const spare = want * 6 - bytes * 8;
  if (spare === 0) return true;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(s[s.length - 1]);
  return last >= 0 && (last & ((1 << spare) - 1)) === 0;
}

/** Decide whether one device row may be sent to, and with what honest caveats.
 *
 *  Order matters. The blocks are checked from "this is not a Device Inbox at
 *  all" outwards to "it is, and its owner turned receiving off", so the sentence
 *  a user reads names the FIRST thing they would have to change. */
export function sendAvailability(deviceID: string, inbox: DeviceInboxView | null): SendAvailability {
  const policy = inbox ? parsePolicy(inbox.AutoAccept) : "";
  const online = inbox?.Presence === "online";
  const base = { caveats: [] as SendCaveat[], online, policy };
  const no = (block: SendBlock): SendAvailability => ({ ...base, sendable: false, block });

  if (!isInertId(deviceID)) return no("unusable_id");
  if (!inbox || inbox.RegisteredAt === 0) return no("not_enrolled");
  if (inbox.Revoked) return no("revoked");
  // Central's own answer to "may a task be sealed to this device" (protocol §9).
  // Checked before the key so a device that fails for a reason we cannot see
  // (protocol version, cleared enrolment) still gets central's verdict, not a
  // guess of ours.
  if (!inbox.CanReceive) return no("cannot_receive");
  if (inbox.ReceiveCapability !== CAP_RECEIVE_V1) return no("unsupported_capability");
  const key = inbox.Key;
  if (!key || key.RevokedAt !== 0 || key.SupersededAt !== 0) return no("unsupported_key");
  if (key.Algorithm !== INBOX_KEY_ALGORITHM) return no("unsupported_key");
  if (!isCanonicalB64Url(key.PublicKey, X25519_PUBLIC_KEY_BYTES)) return no("unsupported_key");
  if (!isInertId(key.ID) || key.Generation <= 0) return no("unsupported_key");
  if (policy === "") return no("unknown_policy");
  // `off` is refused by central with `auto_receive_disabled` and nothing is
  // stored (protocol §14) — so offering the drop target would be a lie the user
  // only discovers after encrypting and uploading a file.
  if (policy === "off") return no("receive_off");

  const caveats: SendCaveat[] = [];
  // `ask` holds the task at `attention_required` until a person at THAT machine
  // accepts. Sendable, but never presented as unattended delivery.
  if (policy === "ask") caveats.push("needs_approval");
  // `auto` with an unusable receive directory also starts `attention_required`
  // (protocol §14). The card must not read as ready.
  if (policy === "auto" && !inbox.ReceiveDirReady) caveats.push("directory_not_ready");
  if (!online) caveats.push("queued_until_online");
  return { ...base, sendable: true, caveats };
}

// ── Sender-local phases vs. server states ──────────────────────────────────

/** PRD §10 items 1-2. Central stores neither and refuses them by name
 *  (protocol §13); they exist only in this browser, for this attempt. */
export type LocalPhase = "encrypting" | "uploading" | "registering";

/** PRD §10 items 3-12 — the closed set of states central can hold. */
export const SERVER_TASK_STATES = [
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
export type ServerTaskState = (typeof SERVER_TASK_STATES)[number];

const SERVER_STATE_SET: ReadonlySet<string> = new Set(SERVER_TASK_STATES);

/** Is this a state central actually defines? A response naming anything else is
 *  a server this build does not understand: shown as an unknown state rather
 *  than rendered raw or silently mapped onto a friendlier neighbour. */
export function isServerTaskState(s: unknown): s is ServerTaskState {
  return typeof s === "string" && SERVER_STATE_SET.has(s);
}

/** States central cannot leave (protocol §13). Polling stops here. */
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "saved",
  "expired",
  "revoked",
  "failed_terminal",
]);

export function isTerminalTaskState(s: string): boolean {
  return TERMINAL_STATES.has(s);
}

/** The account-scoped task view (protocol §17). Deliberately has no field for
 *  the sealed key or the encrypted manifest: those reach only the target
 *  device, from the claim response. */
export interface InboxTaskView {
  ID: string;
  State: string;
  ErrorCode: string;
  CiphertextBytes: number;
  SavedAt: number;
  TerminalAt: number;
  Terminal: boolean;
  ExpiresAt: number;
  CreatedAt: number;
  UpdatedAt: number;
  TargetKeyID: string;
  TargetKeyGeneration: number;
}

/** Parse a task view, or `null` when it is unusable.
 *
 *  A task whose id could not be safely composed into a poll/cancel path is
 *  rejected outright rather than kept in a degraded form: keeping it would mean
 *  a card that shows progress it can never refresh or cancel. */
export function parseInboxTask(raw: unknown): InboxTaskView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  const id = str(t.ID);
  if (!isInertId(id)) return null;
  return {
    ID: id,
    State: str(t.State),
    ErrorCode: str(t.ErrorCode),
    CiphertextBytes: num(t.CiphertextBytes),
    SavedAt: num(t.SavedAt),
    TerminalAt: num(t.TerminalAt),
    // Trust the server's own terminal flag, but never at the expense of the
    // state table: either one saying "finished" stops the poll.
    Terminal: bool(t.Terminal) || isTerminalTaskState(str(t.State)),
    ExpiresAt: num(t.ExpiresAt),
    CreatedAt: num(t.CreatedAt),
    UpdatedAt: num(t.UpdatedAt),
    TargetKeyID: str(t.TargetKeyID),
    TargetKeyGeneration: num(t.TargetKeyGeneration),
  };
}

/** `saved` is EARNED (protocol §11.7): reachable only from `verifying` with an
 *  explicit device assertion that authenticated decryption, verification and the
 *  atomic local commit all succeeded, and central stamps `SavedAt` when it is.
 *  Requiring both here means a task whose state says `saved` without the
 *  timestamp — a partially-written row, a server this build does not
 *  understand — is not presented as delivered. */
export function isSaved(task: InboxTaskView | null): boolean {
  return !!task && task.State === "saved" && task.SavedAt > 0;
}

// ── Error vocabularies ─────────────────────────────────────────────────────

/** Task error tokens: the device-submittable closed set plus the four central
 *  writes itself (protocol §16). There is no free-text field anywhere in this
 *  protocol, so this list is exhaustive by construction — and rendering a
 *  server string instead of mapping through it is what this constant exists to
 *  make impossible. */
export const TASK_ERROR_CODES = [
  "download_failed",
  "decrypt_failed",
  "verify_failed",
  "disk_full",
  "permission_denied",
  "directory_unavailable",
  "name_conflict",
  "user_declined",
  "unsupported",
  "internal",
  "lease_expired",
  "attempts_exhausted",
  "key_revoked",
  "stored_object_unavailable",
] as const;
export type TaskErrorCode = (typeof TASK_ERROR_CODES)[number];

const TASK_ERROR_SET: ReadonlySet<string> = new Set(TASK_ERROR_CODES);

export function isTaskErrorCode(s: unknown): s is TaskErrorCode {
  return typeof s === "string" && TASK_ERROR_SET.has(s);
}

/** Codes `POST …/inbox/tasks` answers with (protocol §16), plus the local
 *  failures a send can produce before or instead of one. Both live in one union
 *  because the card shows one sentence either way, and the user cannot act on
 *  the distinction between "the upload failed" and "the queue refused it". */
export const SEND_ERROR_CODES = [
  // Central's create refusals.
  "auto_receive_disabled",
  "device_cannot_receive",
  "device_inbox_revoked",
  "stale_target_key",
  "idempotency_key_conflict",
  "stored_object_unavailable",
  "stored_object_already_bound",
  "inbox_queue_full",
  "unsupported_key_algorithm",
  "unsupported_auto_accept_capability",
  "malformed_wrapped_key",
  "invalid_idempotency_key",
  // Locally-decided failures.
  "upload_too_large", // 413
  "quota_exceeded", // 429
  "signed_out", // 401
  "network", // the request never reached a server
  "cancelled",
  "unsupported_key", // the target's key is not one this client may wrap to
  "no_files", // an empty or file-less drop
  "unknown",
] as const;
export type SendErrorCode = (typeof SEND_ERROR_CODES)[number];

const SEND_ERROR_SET: ReadonlySet<string> = new Set(SEND_ERROR_CODES);

/** Map a create response's `error` field onto our closed set.
 *
 *  An unrecognised token becomes `unknown`, which has its own honest sentence.
 *  It is never echoed: the field is machine-readable by contract, but this is
 *  the one place a future server string could reach the DOM, so it stops here. */
export function toSendErrorCode(raw: unknown): SendErrorCode {
  return typeof raw === "string" && SEND_ERROR_SET.has(raw) ? (raw as SendErrorCode) : "unknown";
}

/** Map an upload/create HTTP status onto the same set. */
export function httpSendErrorCode(status: number): SendErrorCode {
  if (status === 401 || status === 403) return "signed_out";
  if (status === 413) return "upload_too_large";
  if (status === 429) return "quota_exceeded";
  if (status === 0) return "network";
  return "unknown";
}

// ── Polling cadence ────────────────────────────────────────────────────────

/** First poll delay after a task is created, in ms. Short, because `queued →
 *  notified` happens as soon as the device's next poll lands. */
export const POLL_MIN_MS = 2_000;
/** Ceiling. A device on the queue's own retry backoff can be minutes away
 *  (protocol §15), so polling faster than this buys nothing. */
export const POLL_MAX_MS = 30_000;

/** Bounded exponential backoff for the sender's status poll.
 *
 *  Resets to `POLL_MIN_MS` whenever the observed state CHANGES, so an active
 *  delivery stays responsive while an idle queued task decays to one poll every
 *  30 seconds. `attempt` counts consecutive unchanged polls. */
export function pollDelay(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(POLL_MAX_MS, POLL_MIN_MS * 2 ** Math.min(n, 10));
}
