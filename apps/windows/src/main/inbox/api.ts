// The Inbox API client: bearer requests, and one bounded ciphertext stream.
//
// ## Why this mirrors BoundedTransport instead of extending it
//
// `src/main/net/transport.ts` already gets the rules right — origin pinned,
// `redirect: "error"`, bounded body, deadline. It is POST/JSON-only with no
// custom headers and no streaming, and it is outside this lease, so the rules
// are reproduced here and asserted by tests rather than widened there.
//
// ## Every wire name comes from `wire.ts`
//
// The server serialises PascalCase and reads camelCase request bodies. Nothing
// in this file spells a field name inline.
import {
  CLAIM_TOKEN_HEADER,
  ERR_STALE_CLAIM,
  ERR_TASK_TERMINAL,
  MAX_CLAIM_BATCH,
  MAX_ERROR_BODY_BYTES,
  TASK_STATES,
  type TaskState,
  type WireDelivery,
  type WireTask,
} from "./wire.js";

export const MAX_JSON_RESPONSE_BYTES = 256 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/**
 * Bounds time-to-first-byte on the ciphertext stream.
 *
 * A body legitimately runs for as long as the transfer needs, so it must NOT
 * have an overall deadline — but a server that accepts the request and then
 * never sends a header would otherwise hang forever. The caller's signal bounds
 * the body; this bounds the wait for it to start.
 */
export const DEFAULT_BLOB_HEADER_TIMEOUT_MS = 30_000;

export type ApiFailureCode =
  | "origin-refused"
  | "redirect-refused"
  | "server-refused"
  | "stale-claim"
  | "task-terminal"
  | "network"
  | "timeout"
  | "too-large"
  | "malformed"
  | "resume-restart";

export class InboxApiError extends Error {
  constructor(
    readonly code: ApiFailureCode,
    /** The server's own stable `error` token, when it supplied one. */
    readonly serverCode?: string,
    readonly status?: number,
    /** The task the server echoed with a 409, when it echoed one. */
    readonly task?: WireTask,
  ) {
    // No server text and no URL: both are remote input on a path ending in a
    // log. The code and the status are the whole message.
    super(serverCode !== undefined ? `${code}: ${serverCode}` : code);
    this.name = "InboxApiError";
  }
}

export interface ClaimResult {
  readonly deliveries: readonly WireDelivery[];
  /** What central says a lease lasts. Followed, never assumed. */
  readonly leaseSeconds: number;
}

export interface BlobStream {
  readonly body: ReadableStream<Uint8Array>;
  /** True only for a 206 whose Content-Range agreed with the request. */
  readonly partial: boolean;
  /** Total object size the server reported in Content-Range, or null for a 200. */
  readonly totalBytes: number | null;
}

/**
 * The account this client speaks for, captured once.
 *
 * ## Why the bearer is captured and not fetched per call
 *
 * An earlier version took `bearer: () => Promise<string>` and read it on every
 * request. That reintroduces exactly what the account invariant forbids: a
 * token read AFTER an await can belong to an account that replaced the one the
 * operation started under, so a delivery claimed for account A could be
 * reported, or its blob fetched, as account B.
 *
 * The bearer is therefore part of an immutable captured context. Rotating a
 * token means constructing a new client, which is the same rule the rest of the
 * Inbox follows for an account change.
 */
export interface CapturedApiContext {
  /** The one origin credentials may reach. */
  readonly origin: string;
  readonly deviceID: string;
  /** Captured, not looked up. */
  readonly bearer: string;
  /** The account epoch this context was captured at. */
  readonly epoch: number;
}

export interface InboxApiOptions {
  readonly context: CapturedApiContext;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly blobHeaderTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A safe non-negative integer. Rejects floats, NaN, and anything past 2^53-1. */
function safeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/** Bounded identifier: present, a string, and not unbounded. */
const MAX_ID_BYTES = 256;
function boundedID(value: unknown, required: boolean): string | null {
  if (typeof value !== "string") return null;
  if (value.length > MAX_ID_BYTES) return null;
  if (required && value.length === 0) return null;
  return value;
}

const BASE64_STD = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64_URL = /^[A-Za-z0-9_-]*$/;

/**
 * Release a response body without reading it.
 *
 * Every refusal path calls this. Throwing while the body is still open leaks the
 * connection: the socket stays reserved until GC, and under a keep-alive agent
 * that starves the pool. An earlier version left the body open on the
 * redirect-refused and resume-restart paths, which are precisely the paths a
 * hostile or broken server can drive repeatedly.
 */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body was already closed or errored; nothing further to release.
  }
}


/** Bounds on replies that are lists, so a hostile server cannot hand back a heap. */
export const MAX_KEYS_IN_REPLY = 256;
export const MAX_DEVICES_IN_REPLY = 512;
export const MAX_PENDING_LIMIT = 100;
/** Matches the shared device-identity ceiling. */
export const MAX_DEVICE_NAME_LENGTH = 64;

export interface EnrolRequest {
  readonly platform: string;
  readonly appVersion: string;
  readonly protocolVersions: readonly number[];
  readonly capabilities: readonly string[];
  readonly autoAccept: string;
  readonly receiveDirReady: boolean;
}

/** What central AGREED to, which is not necessarily what was asked for. */
export interface EnrolResult {
  readonly protocolVersion: number;
  readonly receiveCapability: string;
  readonly keyAlgorithm: string;
}

export interface WireDeviceKey {
  readonly ID: string;
  readonly Algorithm: string;
  readonly PublicKey: string;
  readonly Generation: number;
  readonly RevokedAt: number;
}

export interface WireDevice {
  readonly ID: string;
  readonly Name: string;
}

export interface PresenceResult {
  readonly presence: string;
  readonly intervalSeconds: number;
}

export interface PendingResult {
  readonly tasks: readonly WireTask[];
  readonly leaseSeconds: number;
  readonly heartbeatIntervalSecs: number;
}

export class InboxApi {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly blobHeaderTimeoutMs: number;

  constructor(private readonly options: InboxApiOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.blobHeaderTimeoutMs = options.blobHeaderTimeoutMs ?? DEFAULT_BLOB_HEADER_TIMEOUT_MS;
  }

  get epoch(): number {
    return this.options.context.epoch;
  }

  /**
   * Build a device-scoped URL and refuse anything not on the pinned origin.
   *
   * Ids come from central and are escaped anyway: a value that smuggled a path
   * segment would address a different endpoint with this device's bearer on it.
   */
  private url(suffix: string): URL {
    const { origin, deviceID } = this.options.context;
    let target: URL;
    try {
      target = new URL(`${origin}/api/devices/${encodeURIComponent(deviceID)}${suffix}`);
    } catch {
      throw new InboxApiError("origin-refused");
    }
    if (target.origin !== origin) throw new InboxApiError("origin-refused");
    return target;
  }

  private taskURL(taskID: string, suffix: string): URL {
    return this.url(`/inbox/tasks/${encodeURIComponent(taskID)}${suffix}`);
  }

  private headers(extra?: Record<string, string>): Headers {
    const headers = new Headers({ accept: "application/json" });
    // Attached only after the origin check above.
    headers.set("authorization", `Bearer ${this.options.context.bearer}`);
    for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
    return headers;
  }

  private classify(error: unknown): InboxApiError {
    if (error instanceof InboxApiError) return error;
    const name = (error as Error | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") return new InboxApiError("timeout");
    // A redirect matters more here than elsewhere: following one would carry the
    // bearer to whatever host the response named.
    if (/redirect/i.test(String((error as Error | null)?.message))) {
      return new InboxApiError("redirect-refused");
    }
    return new InboxApiError("network");
  }

  /** Read a rejection body bounded, keeping only a token-shaped `error`. */
  private async rejection(response: Response): Promise<{ code?: string; task?: WireTask }> {
    const reader = response.body?.getReader();
    if (reader === undefined) return {};
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > MAX_ERROR_BODY_BYTES) break;
        chunks.push(value);
      }
    } finally {
      // Released whatever happened, including a mid-read throw.
      await reader.cancel().catch(() => undefined);
    }
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
      if (!isRecord(parsed)) return {};
      const token = parsed["error"];
      const code =
        typeof token === "string" && token.length > 0 && token.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(token)
          ? token
          : undefined;
      const task = this.parseTask(parsed["task"]);
      return code === undefined ? (task === null ? {} : { task }) : task === null ? { code } : { code, task };
    } catch {
      return {};
    }
  }

  private async json(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    target: URL,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const headers = this.headers(body === undefined ? undefined : { "content-type": "application/json" });
    let response: Response;
    try {
      response = await this.fetchImpl(target.toString(), {
        method,
        headers,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw this.classify(error);
    }
    if (response.status < 200 || response.status >= 300) {
      const { code, task } = await this.rejection(response);
      // Two server tokens have meanings the caller must act on rather than
      // merely report.
      if (code === ERR_STALE_CLAIM) throw new InboxApiError("stale-claim", code, response.status, task);
      if (code === ERR_TASK_TERMINAL) throw new InboxApiError("task-terminal", code, response.status, task);
      throw new InboxApiError("server-refused", code, response.status, task);
    }
    const reader = response.body?.getReader();
    if (reader === undefined) return undefined;
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > MAX_JSON_RESPONSE_BYTES) throw new InboxApiError("too-large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (total === 0) return undefined;
    try {
      return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as unknown;
    } catch {
      throw new InboxApiError("malformed");
    }
  }

  /** Validate one task view. Returns null rather than a partly-filled object. */
  private parseTask(value: unknown): WireTask | null {
    if (!isRecord(value)) return null;
    const id = boundedID(value["ID"], true);
    // Absent is legitimate; a WRONG TYPE is not, and an earlier version quietly
    // substituted "" for both — so a number where a string belonged became an
    // empty idempotency key and defeated dedup.
    const source = boundedID(value["SourceDeviceID"] ?? "", false);
    const idem = boundedID(value["IdempotencyKey"] ?? "", false);
    const state = value["State"];
    const errorCode = boundedID(value["ErrorCode"] ?? "", false);
    const wrapAlgorithm = boundedID(value["WrapAlgorithm"] ?? "", false);
    const targetKeyID = boundedID(value["TargetKeyID"], true);
    const generation = safeInt(value["TargetKeyGeneration"]);
    const ciphertextBytes = safeInt(value["CiphertextBytes"]);
    const createdAt = safeInt(value["CreatedAt"]);
    const expiresAt = safeInt(value["ExpiresAt"] ?? 0);
    const savedAt = safeInt(value["SavedAt"] ?? 0);
    const terminal = value["Terminal"];
    if (
      id === null || source === null || idem === null || errorCode === null ||
      wrapAlgorithm === null || targetKeyID === null || generation === null ||
      ciphertextBytes === null || createdAt === null || expiresAt === null ||
      savedAt === null || typeof terminal !== "boolean" ||
      typeof state !== "string" || !(TASK_STATES as readonly string[]).includes(state)
    ) {
      return null;
    }
    return {
      ID: id,
      SourceDeviceID: source,
      IdempotencyKey: idem,
      State: state as TaskState,
      ErrorCode: errorCode,
      CiphertextBytes: ciphertextBytes,
      WrapAlgorithm: wrapAlgorithm,
      TargetKeyID: targetKeyID,
      TargetKeyGeneration: generation,
      CreatedAt: createdAt,
      ExpiresAt: expiresAt,
      SavedAt: savedAt,
      Terminal: terminal,
    };
  }

  private parseDelivery(value: unknown): WireDelivery | null {
    const task = this.parseTask(value);
    if (task === null || !isRecord(value)) return null;
    const encManifest = value["EncManifest"];
    const wrappedKey = value["WrappedKey"];
    const claimToken = boundedID(value["ClaimToken"], true);
    if (
      claimToken === null ||
      typeof encManifest !== "string" || encManifest.length === 0 || !BASE64_STD.test(encManifest) ||
      typeof wrappedKey !== "string" || wrappedKey.length === 0 || !BASE64_URL.test(wrappedKey)
    ) {
      return null;
    }
    return { ...task, EncManifest: encManifest, WrappedKey: wrappedKey, ClaimToken: claimToken };
  }

  /**
   * Claim pending deliveries.
   *
   * The reply is bounded by what was ASKED FOR and by the server's own
   * `MaxClaimBatch`: a server returning more than either is not one to keep
   * parsing.
   */
  async claim(max: number, signal: AbortSignal): Promise<ClaimResult> {
    if (!Number.isSafeInteger(max) || max <= 0 || max > MAX_CLAIM_BATCH) {
      throw new InboxApiError("malformed");
    }
    const parsed = await this.json("POST", this.url("/inbox/claim"), { max }, signal);
    if (!isRecord(parsed)) throw new InboxApiError("malformed");
    const tasks = parsed["tasks"];
    if (!Array.isArray(tasks)) throw new InboxApiError("malformed");
    if (tasks.length > max || tasks.length > MAX_CLAIM_BATCH) throw new InboxApiError("malformed");
    const leaseSeconds = safeInt(parsed["leaseSeconds"]);
    // A zero or absurd lease is not something to follow: it would make every
    // claim instantly expired or effectively unbounded.
    if (leaseSeconds === null || leaseSeconds === 0 || leaseSeconds > 24 * 60 * 60) {
      throw new InboxApiError("malformed");
    }
    const deliveries: WireDelivery[] = [];
    for (const entry of tasks) {
      const delivery = this.parseDelivery(entry);
      if (delivery === null) throw new InboxApiError("malformed");
      deliveries.push(delivery);
    }
    return { deliveries, leaseSeconds };
  }

  /**
   * Report progress. The CLAIM TOKEN TRAVELS IN THE BODY.
   *
   * An earlier version accepted the token and discarded it, so every call would
   * have been answered `409 stale_claim` — the server checks
   * `if in.ClaimToken == ""` first.
   *
   * The returned task is the server's, and it is the authority. `state` and
   * `committed` are what this device ASSERTS; whether the task actually reached
   * `saved` is what comes back. In particular `saved` is reachable only from
   * `verifying`, and only when `committed` is true — the server will not take
   * "the bytes arrived" for "the file is on disk".
   */
  async report(
    taskID: string,
    claimToken: string,
    state: TaskState,
    committed: boolean,
    errorCode: string,
    signal: AbortSignal,
  ): Promise<WireTask> {
    if (claimToken.length === 0) throw new InboxApiError("stale-claim");
    if (!(TASK_STATES as readonly string[]).includes(state)) throw new InboxApiError("malformed");
    const parsed = await this.json(
      "POST",
      this.taskURL(taskID, "/report"),
      // camelCase: this is what `handleReportInboxTask` decodes.
      { claimToken, state, errorCode, committed },
      signal,
    );
    if (!isRecord(parsed)) throw new InboxApiError("malformed");
    const task = this.parseTask(parsed["task"]);
    if (task === null) throw new InboxApiError("malformed");
    return task;
  }

  /**
   * Open the ciphertext, resuming at `offset`.
   *
   * ## The caller's signal is required
   *
   * A body has no overall deadline — it runs as long as the transfer needs — so
   * the ONLY thing that can stop it is the caller's abort. Making the signal
   * optional meant a stalled body could hang forever with nothing to cancel it.
   * The header wait is bounded separately.
   *
   * ## A 206 is not enough on its own
   *
   * `Content-Range` is parsed and required to start at the requested offset. A
   * server answering 206 with a range starting somewhere else would otherwise
   * have its bytes written at the caller's offset — a file of exactly the right
   * length, wrong in the middle, which no length check catches. A resume
   * answered 200 is the same hazard and is refused as `resume-restart`.
   *
   * Every refusal releases the body before throwing.
   */
  async blob(
    taskID: string,
    claimToken: string,
    offset: number,
    expectedTotal: number,
    signal: AbortSignal,
  ): Promise<BlobStream> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new InboxApiError("malformed");
    if (!Number.isSafeInteger(expectedTotal) || expectedTotal < 0) throw new InboxApiError("malformed");
    if (offset > expectedTotal) throw new InboxApiError("malformed");
    const target = this.taskURL(taskID, "/blob");
    const extra: Record<string, string> = { [CLAIM_TOKEN_HEADER]: claimToken };
    if (offset > 0) extra["range"] = `bytes=${offset}-`;

    let response: Response;
    try {
      response = await this.fetchImpl(target.toString(), {
        method: "GET",
        headers: this.headers(extra),
        redirect: "error",
        // Time-to-first-byte only. The caller's signal bounds the body itself.
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.blobHeaderTimeoutMs)]),
      });
    } catch (error) {
      throw this.classify(error);
    }

    if (response.status < 200 || response.status >= 300) {
      const { code, task } = await this.rejection(response);
      if (code === ERR_STALE_CLAIM) throw new InboxApiError("stale-claim", code, response.status, task);
      throw new InboxApiError("server-refused", code, response.status, task);
    }
    // Re-checked after the response: a redirect fetch somehow followed would
    // have carried the bearer elsewhere.
    if (new URL(response.url === "" ? target.toString() : response.url).origin !== this.options.context.origin) {
      await discard(response);
      throw new InboxApiError("redirect-refused");
    }

    const partial = response.status === 206;
    if (offset > 0 && !partial) {
      await discard(response);
      throw new InboxApiError("resume-restart");
    }

    let totalBytes: number | null = null;
    if (partial) {
      const range = this.parseContentRange(response.headers.get("content-range"));
      if (range === null || range.start !== offset) {
        // A 206 whose range does not begin where we asked is a splice waiting
        // to happen.
        await discard(response);
        throw new InboxApiError("malformed");
      }
      if (range.total !== null && range.total !== expectedTotal) {
        await discard(response);
        throw new InboxApiError("malformed");
      }
      totalBytes = range.total;
    }

    const body = response.body;
    if (body === null) throw new InboxApiError("malformed");
    return { body, partial, totalBytes };
  }


  // -------------------------------------------------------------------------
  // Lifecycle
  //
  // Every shape below was read from the handler, not guessed. Where a handler
  // decodes STRICTLY (`DecodeStrictJSONBody`), an extra or misnamed field is a
  // 400 rather than an ignored key, so these bodies carry exactly the declared
  // fields and nothing else.
  //
  //   PUT    /api/devices/{id}/inbox                deviceinbox.go:150 strict
  //   POST   /api/devices/{id}/inbox/keys           deviceinbox.go:274 strict
  //   GET    /api/devices/{id}/inbox/keys           deviceinbox.go:310
  //   POST   /api/devices/{id}/inbox/heartbeat      deviceinbox.go:368 strict, empty body legal
  //   POST   /api/devices/{id}/inbox/offline        deviceinbox.go:409 no body
  //   DELETE /api/devices/{id}/inbox                handlers.go:188
  //   GET    /api/devices/{id}/inbox/pending        deviceinbox_task.go:449
  //   POST   /api/devices/{id}/inbox/tasks/{t}/accept  deviceinbox_task.go:577 strict
  //   PATCH  /api/devices/{id}                      handlers.go:172 / :445
  //   GET    /api/devices                           account-scoped list
  // -------------------------------------------------------------------------

  /**
   * Enrol this device's inbox.
   *
   * The server NEGOTIATES rather than accepts: the protocol version, the
   * capability set, the auto-accept policy and its capability, the platform and
   * the app version are each validated, and any of them can refuse. What comes
   * back is what was AGREED, which is why the agreed values are returned rather
   * than the ones that were asked for.
   */
  async enrol(args: EnrolRequest, signal: AbortSignal): Promise<EnrolResult> {
    const body = {
      platform: args.platform,
      appVersion: args.appVersion,
      protocolVersions: [...args.protocolVersions],
      capabilities: [...args.capabilities],
      autoAccept: args.autoAccept,
      receiveDirReady: args.receiveDirReady,
    };
    const parsed = await this.json("PUT", this.url("/inbox"), body, signal);
    if (!isRecord(parsed)) throw new InboxApiError("malformed");
    const protocolVersion = safeInt(parsed["protocolVersion"]);
    const receiveCapability = boundedID(parsed["receiveCapability"], true);
    const keyAlgorithm = boundedID(parsed["keyAlgorithm"], true);
    if (protocolVersion === null || receiveCapability === null || keyAlgorithm === null) {
      throw new InboxApiError("malformed");
    }
    return { protocolVersion, receiveCapability, keyAlgorithm };
  }

  /** Withdraw the enrolment. The device stops being a send target. */
  async deleteInbox(signal: AbortSignal): Promise<void> {
    await this.json("DELETE", this.url("/inbox"), undefined, signal);
  }

  /**
   * Register a public key, optionally rotating away from a previous one.
   *
   * `previousKeyId` is sent only when rotating: the handler decodes strictly,
   * and the empty string is what "no previous key" means to `RotateDeviceKey`.
   */
  async registerKey(
    algorithm: string,
    publicKey: string,
    previousKeyID: string,
    signal: AbortSignal,
  ): Promise<WireDeviceKey> {
    const parsed = await this.json(
      "POST",
      this.url("/inbox/keys"),
      { algorithm, publicKey, previousKeyId: previousKeyID },
      signal,
    );
    if (!isRecord(parsed)) throw new InboxApiError("malformed");
    const key = this.parseDeviceKey(parsed["key"]);
    if (key === null) throw new InboxApiError("malformed");
    return key;
  }

  /** Every key central holds for this device, active and revoked. */
  async listKeys(signal: AbortSignal): Promise<readonly WireDeviceKey[]> {
    const parsed = await this.json("GET", this.url("/inbox/keys"), undefined, signal);
    if (!isRecord(parsed)) throw new InboxApiError("malformed");
    const keys = parsed["keys"];
    if (!Array.isArray(keys)) throw new InboxApiError("malformed");
    if (keys.length > MAX_KEYS_IN_REPLY) throw new InboxApiError("malformed");
    const out: WireDeviceKey[] = [];
    for (const entry of keys) {
      const key = this.parseDeviceKey(entry);
      if (key === null) throw new InboxApiError("malformed");
      out.push(key);
    }
    return Object.freeze(out);
  }

  /**
   * Refresh presence.
   *
   * A missing enrolment is 404 and a revoked one is 409 — the handler
   * distinguishes them deliberately, so a client does not retry a heartbeat it
   * can never satisfy. Both arrive here as `server-refused` carrying the
   * server's own token.
   */
  async heartbeat(receiveDirReady: boolean, signal: AbortSignal): Promise<PresenceResult> {
    const parsed = await this.json(
      "POST",
      this.url("/inbox/heartbeat"),
      { receiveDirReady },
      signal,
    );
    if (!isRecord(parsed)) throw new InboxApiError("malformed");
    const presence = boundedID(parsed["presence"], true);
    if (presence === null) throw new InboxApiError("malformed");
    const intervalSeconds = safeInt(parsed["heartbeatIntervalSeconds"] ?? 0);
    return { presence, intervalSeconds: intervalSeconds ?? 0 };
  }

  /** Say this device is going away. No body: the handler reads none. */
  async offline(signal: AbortSignal): Promise<void> {
    await this.json("POST", this.url("/inbox/offline"), undefined, signal);
  }

  /**
   * What is waiting, without claiming any of it.
   *
   * Deliberately separate from `claim`: `pending` hands out no sealed content
   * key and takes no lease, so a UI can show what has arrived without starting
   * work on it.
   */
  async pending(limit: number, signal: AbortSignal): Promise<PendingResult> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_PENDING_LIMIT) {
      throw new InboxApiError("malformed");
    }
    const target = this.url("/inbox/pending");
    target.searchParams.set("limit", String(limit));
    const parsed = await this.json("GET", target, undefined, signal);
    if (!isRecord(parsed)) throw new InboxApiError("malformed");
    const tasks = parsed["tasks"];
    if (!Array.isArray(tasks)) throw new InboxApiError("malformed");
    if (tasks.length > limit) throw new InboxApiError("malformed");
    const out: WireTask[] = [];
    for (const entry of tasks) {
      const task = this.parseTask(entry);
      if (task === null) throw new InboxApiError("malformed");
      out.push(task);
    }
    const leaseSeconds = safeInt(parsed["leaseSeconds"] ?? 0) ?? 0;
    const heartbeatIntervalSecs = safeInt(parsed["heartbeatIntervalSecs"] ?? 0) ?? 0;
    return { tasks: Object.freeze(out), leaseSeconds, heartbeatIntervalSecs };
  }

  /**
   * Accept or DECLINE a held delivery. `accept: false` is the decline.
   *
   * No claim token, by design: under the `ask` policy the task is held by
   * nobody until a person at this device decides, so there is no lease to
   * present. The handler decodes strictly, so the body carries `accept` alone.
   */
  async accept(taskID: string, accept: boolean, signal: AbortSignal): Promise<WireTask> {
    const parsed = await this.json("POST", this.taskURL(taskID, "/accept"), { accept }, signal);
    if (!isRecord(parsed)) throw new InboxApiError("malformed");
    const task = this.parseTask(parsed["task"]);
    if (task === null) throw new InboxApiError("malformed");
    return task;
  }

  /**
   * This device's row, found through the account-scoped list.
   *
   * There is no `GET /api/devices/{id}`; the list marks exactly one row
   * `Current` for the credential that asked. The row's id is then required to
   * MATCH the captured device id — a `Current` row naming a different device
   * would mean this client's bearer belongs to something other than the device
   * it believes it is, and acting on it would enrol or rename the wrong machine.
   */
  async currentDevice(signal: AbortSignal): Promise<WireDevice> {
    const { origin } = this.options.context;
    let target: URL;
    try {
      target = new URL(`${origin}/api/devices`);
    } catch {
      throw new InboxApiError("origin-refused");
    }
    if (target.origin !== origin) throw new InboxApiError("origin-refused");
    const parsed = await this.json("GET", target, undefined, signal);
    if (!isRecord(parsed)) throw new InboxApiError("malformed");
    const rows = parsed["devices"];
    if (!Array.isArray(rows)) throw new InboxApiError("malformed");
    if (rows.length > MAX_DEVICES_IN_REPLY) throw new InboxApiError("malformed");
    for (const row of rows) {
      if (!isRecord(row) || row["Current"] !== true) continue;
      const id = boundedID(row["ID"], true);
      const name = boundedID(row["Name"] ?? "", false);
      if (id === null || name === null) throw new InboxApiError("malformed");
      if (id !== this.options.context.deviceID) throw new InboxApiError("malformed");
      return { ID: id, Name: name };
    }
    throw new InboxApiError("malformed");
  }

  /**
   * Rename this device.
   *
   * Whitespace is collapsed here and NOTHING else is. The server refuses a name
   * it would have to alter — `Acceptable` compares `Sanitize(name)` against the
   * whitespace-collapsed original and returns `invalid_device_name` when they
   * differ — precisely so a person does not end up looking at a row whose name
   * they did not type. Pre-sanitizing on this side would defeat that: the user
   * would silently get the altered name instead of being told.
   */
  async renameDevice(name: string, normalize: (value: string) => string, signal: AbortSignal): Promise<string> {
    const cleaned = normalize(name);
    if (cleaned.length === 0 || cleaned.length > MAX_DEVICE_NAME_LENGTH) {
      throw new InboxApiError("malformed");
    }
    await this.json("PATCH", this.url(""), { name: cleaned }, signal);
    return cleaned;
  }

  private parseDeviceKey(value: unknown): WireDeviceKey | null {
    if (!isRecord(value)) return null;
    const id = boundedID(value["ID"], true);
    const algorithm = boundedID(value["Algorithm"], true);
    const publicKey = value["PublicKey"];
    const generation = safeInt(value["Generation"]);
    if (
      id === null || algorithm === null || generation === null ||
      typeof publicKey !== "string" || publicKey.length === 0 || !BASE64_URL.test(publicKey)
    ) {
      return null;
    }
    const revokedAt = safeInt(value["RevokedAt"] ?? 0) ?? 0;
    return { ID: id, Algorithm: algorithm, PublicKey: publicKey, Generation: generation, RevokedAt: revokedAt };
  }

  /** Parse `bytes <start>-<end>/<total|*>`. Null when it is not that. */
  private parseContentRange(
    header: string | null,
  ): { start: number; end: number; total: number | null } | null {
    if (header === null) return null;
    const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header.trim());
    if (match === null) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = match[3] === "*" ? null : Number(match[3]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return null;
    if (total !== null && (!Number.isSafeInteger(total) || end >= total)) return null;
    return { start, end, total };
  }
}
