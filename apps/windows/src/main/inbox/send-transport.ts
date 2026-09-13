// The sender's task HTTP. Account-scoped, and deliberately not the receiver's.
//
// This is the TASK half only: create, list, read, cancel, and the two reads
// eligibility needs. **The ciphertext upload is not here.** `device_task` uses
// the resumable route, and its adapter waits for the accepted S2 byte channel —
// inventing a parallel retry engine, or falling back to a whole-file POST that
// buffers the object, would be a second transport to disagree with the one that
// is coming.
//
// Every guard the receive client applies is applied here for the same reasons:
// a fixed origin the bearer may reach, `redirect: "error"` so no redirect can
// carry it elsewhere, a bounded body, and a deadline on every call.
import {
  CREATE_TASK_FIELDS,
  MAX_PENDING_TASKS_PER_DEVICE,
  isLegalIdempotencyKey,
  type CreateTaskRequest,
  type CreateTaskResult,
  type SenderTask,
} from "./send-wire.js";
import { TASK_STATES, type TaskState } from "./wire.js";

export const MAX_JSON_RESPONSE_BYTES = 256 * 1024;
export const MAX_ERROR_BODY_BYTES = 4 << 10;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** `GET .../inbox/tasks` is a bounded page, never an authoritative lookup. */
export const MAX_HISTORY_LIMIT = 100;

export type SendApiFailure =
  | "origin-refused"
  | "redirect-refused"
  | "server-refused"
  | "network"
  | "timeout"
  | "too-large"
  | "malformed";

export class SendApiError extends Error {
  constructor(
    readonly code: SendApiFailure,
    readonly serverCode?: string,
    readonly status?: number,
    /** The task a 409 echoed, when it echoed one. */
    readonly task?: SenderTask,
  ) {
    // No server text and no URL: both are remote input on a path ending in a log.
    super(serverCode !== undefined ? `${code}: ${serverCode}` : code);
    this.name = "SendApiError";
  }
}

/**
 * The account this sender speaks for, captured once.
 *
 * Captured rather than fetched per call, for the reason the receive client
 * states: a token read AFTER an await can belong to an account that replaced the
 * one the operation started under, so a task could be created under the wrong
 * account. Rotating means constructing a new client.
 */
export interface CapturedSendContext {
  readonly origin: string;
  /** The SENDING device's bearer. Central resolves the source device from it. */
  readonly bearer: string;
  readonly epoch: number;
}

export interface SendTransportOptions {
  readonly context: CapturedSendContext;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

const MAX_ID_BYTES = 256;
function boundedID(value: unknown, required: boolean): string | null {
  if (typeof value !== "string") return null;
  if (value.length > MAX_ID_BYTES) return null;
  if (required && value.length === 0) return null;
  return value;
}

export class SendTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: SendTransportOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get epoch(): number {
    return this.options.context.epoch;
  }

  /** Build a URL and refuse anything not on the pinned origin. */
  private url(suffix: string): URL {
    const { origin } = this.options.context;
    let target: URL;
    try {
      target = new URL(`${origin}${suffix}`);
    } catch {
      throw new SendApiError("origin-refused");
    }
    if (target.origin !== origin) throw new SendApiError("origin-refused");
    return target;
  }

  private deviceURL(deviceID: string, suffix: string): URL {
    return this.url(`/api/devices/${encodeURIComponent(deviceID)}${suffix}`);
  }

  private headers(json: boolean): Headers {
    const headers = new Headers({ accept: "application/json" });
    if (json) headers.set("content-type", "application/json");
    // Attached only after the origin check.
    headers.set("authorization", `Bearer ${this.options.context.bearer}`);
    return headers;
  }

  private classify(error: unknown): SendApiError {
    if (error instanceof SendApiError) return error;
    const name = (error as Error | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") return new SendApiError("timeout");
    if (/redirect/i.test(String((error as Error | null)?.message))) {
      return new SendApiError("redirect-refused");
    }
    return new SendApiError("network");
  }

  /** Read a rejection bounded, keeping only a token-shaped `error` and the task. */
  private async rejection(response: Response): Promise<{ code?: string; task?: SenderTask }> {
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
    method: "GET" | "POST" | "DELETE",
    target: URL,
    body: unknown,
    signal: AbortSignal,
  ): Promise<{ status: number; parsed: unknown }> {
    let response: Response;
    try {
      response = await this.fetchImpl(target.toString(), {
        method,
        headers: this.headers(body !== undefined),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw this.classify(error);
    }
    if (response.status < 200 || response.status >= 300) {
      const { code, task } = await this.rejection(response);
      throw new SendApiError("server-refused", code, response.status, task);
    }
    // Re-checked after the response: a redirect somehow followed would have
    // carried the bearer elsewhere.
    if (new URL(response.url === "" ? target.toString() : response.url).origin !== this.options.context.origin) {
      await response.body?.cancel().catch(() => undefined);
      throw new SendApiError("redirect-refused");
    }
    const reader = response.body?.getReader();
    if (reader === undefined) return { status: response.status, parsed: undefined };
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > MAX_JSON_RESPONSE_BYTES) throw new SendApiError("too-large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (chunks.length === 0) return { status: response.status, parsed: undefined };
    try {
      return { status: response.status, parsed: JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) };
    } catch {
      throw new SendApiError("malformed");
    }
  }

  private parseTask(value: unknown): SenderTask | null {
    if (!isRecord(value)) return null;
    const id = boundedID(value["ID"], true);
    const source = boundedID(value["SourceDeviceID"] ?? "", false);
    // The object this task BINDS. Read because the idempotency key alone cannot
    // prove a task found in the recent page is this job's delivery: central keys
    // a create on the key AND the request, so a row under our key that names
    // another object is somebody else's request, not our convergence target.
    const storedFileID = boundedID(value["StoredFileID"] ?? "", false);
    const idem = boundedID(value["IdempotencyKey"] ?? "", false);
    const errorCode = boundedID(value["ErrorCode"] ?? "", false);
    const wrapAlgorithm = boundedID(value["WrapAlgorithm"] ?? "", false);
    const targetKeyID = boundedID(value["TargetKeyID"] ?? "", false);
    const generation = safeInt(value["TargetKeyGeneration"] ?? 0);
    const ciphertextBytes = safeInt(value["CiphertextBytes"] ?? 0);
    const createdAt = safeInt(value["CreatedAt"] ?? 0);
    const expiresAt = safeInt(value["ExpiresAt"] ?? 0);
    const savedAt = safeInt(value["SavedAt"] ?? 0);
    const state = value["State"];
    const terminal = value["Terminal"];
    if (
      id === null || source === null || idem === null || errorCode === null || wrapAlgorithm === null ||
      storedFileID === null ||
      targetKeyID === null || generation === null || ciphertextBytes === null || createdAt === null ||
      expiresAt === null || savedAt === null || typeof terminal !== "boolean" ||
      typeof state !== "string" || !(TASK_STATES as readonly string[]).includes(state)
    ) {
      return null;
    }
    return {
      ID: id, SourceDeviceID: source, IdempotencyKey: idem, State: state as TaskState,
      ErrorCode: errorCode, CiphertextBytes: ciphertextBytes, WrapAlgorithm: wrapAlgorithm,
      TargetKeyID: targetKeyID, TargetKeyGeneration: generation, CreatedAt: createdAt,
      ExpiresAt: expiresAt, SavedAt: savedAt, Terminal: terminal, StoredFileID: storedFileID,
    };
  }

  /**
   * Create the task that binds the object to a delivery.
   *
   * `created` is read from the STATUS, not from a body field: 201 is a new task
   * and a converged 200 is the original one. Both carry the task that actually
   * owns the ciphertext, and its `State` is returned untouched — a converged 200
   * whose task is already `saved` says `saved`, not "queued".
   *
   * The body carries exactly the declared fields. The handler decodes strictly,
   * which is what makes a stray `contentKey` or `fileName` a 400 rather than a
   * field something later might honour.
   */
  async createTask(
    targetDeviceID: string,
    request: CreateTaskRequest,
    signal: AbortSignal,
  ): Promise<CreateTaskResult> {
    if (!isLegalIdempotencyKey(request.idempotencyKey)) throw new SendApiError("malformed");
    const body: Record<string, unknown> = {};
    for (const field of CREATE_TASK_FIELDS) body[field] = request[field];
    const { status, parsed } = await this.json(
      "POST",
      this.deviceURL(targetDeviceID, "/inbox/tasks"),
      body,
      signal,
    );
    if (!isRecord(parsed)) throw new SendApiError("malformed");
    const task = this.parseTask(parsed["task"]);
    if (task === null) throw new SendApiError("malformed");
    // Identity consistency: the task returned must be the one this request
    // named. A different idempotency key means central answered about another
    // delivery, and treating it as ours would record the wrong task id.
    if (task.IdempotencyKey.length > 0 && task.IdempotencyKey !== request.idempotencyKey) {
      throw new SendApiError("malformed");
    }
    return { created: status === 201, task };
  }

  /** One task, by id. The authority on its state. */
  async task(targetDeviceID: string, taskID: string, signal: AbortSignal): Promise<SenderTask> {
    const { parsed } = await this.json(
      "GET",
      this.deviceURL(targetDeviceID, `/inbox/tasks/${encodeURIComponent(taskID)}`),
      undefined,
      signal,
    );
    const task = this.parseTask(isRecord(parsed) ? parsed["task"] : null);
    if (task === null) throw new SendApiError("malformed");
    if (task.ID !== taskID) throw new SendApiError("malformed");
    return task;
  }

  /**
   * Recent tasks for a target.
   *
   * A bounded page, and the convergence lookup's only tool. ABSENCE HERE IS NOT
   * PROOF that no task exists — a row can fall outside the window, and a
   * timed-out create may still be committing.
   */
  async tasks(targetDeviceID: string, limit: number, signal: AbortSignal): Promise<readonly SenderTask[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_HISTORY_LIMIT) {
      throw new SendApiError("malformed");
    }
    const target = this.deviceURL(targetDeviceID, "/inbox/tasks");
    target.searchParams.set("limit", String(limit));
    const { parsed } = await this.json("GET", target, undefined, signal);
    const rows = isRecord(parsed) ? parsed["tasks"] : null;
    if (!Array.isArray(rows)) throw new SendApiError("malformed");
    if (rows.length > limit || rows.length > MAX_PENDING_TASKS_PER_DEVICE) {
      throw new SendApiError("malformed");
    }
    const out: SenderTask[] = [];
    for (const row of rows) {
      const task = this.parseTask(row);
      if (task === null) throw new SendApiError("malformed");
      out.push(task);
    }
    return Object.freeze(out);
  }

  /**
   * Ask central to cancel a delivery.
   *
   * Three answers, because central has three, and collapsing them would each
   * time report something false:
   *
   *  - `cancelled` — the row is gone and, when the task owned its ciphertext,
   *    `handleDeleteInboxTask` took the blob with it. The body is `{status:
   *    "ok"}` and carries no task, so there is nothing to echo back.
   *  - `terminal` — `task_terminal`. The delivery already ended.
   *  - `in-progress` — `invalid_transition`. `DeleteInboxTask` refuses a task in
   *    `downloading` or `verifying`: "once a receiver holds a live lease,
   *    neither its task nor its ciphertext is removed underneath it". That is a
   *    definite NO with a remedy — ask again once the lease lapses or the
   *    transfer finishes — and reporting it as a failed request would send a
   *    caller looking for a fault that did not happen.
   */
  async cancelTask(
    targetDeviceID: string,
    taskID: string,
    signal: AbortSignal,
  ): Promise<{ readonly outcome: "cancelled" | "terminal" | "in-progress"; readonly task: SenderTask | null }> {
    try {
      const { parsed } = await this.json(
        "DELETE",
        this.deviceURL(targetDeviceID, `/inbox/tasks/${encodeURIComponent(taskID)}`),
        undefined,
        signal,
      );
      return { outcome: "cancelled", task: this.parseTask(isRecord(parsed) ? parsed["task"] : null) };
    } catch (error) {
      if (error instanceof SendApiError && error.serverCode === "task_terminal") {
        return { outcome: "terminal", task: error.task ?? null };
      }
      if (error instanceof SendApiError && error.serverCode === "invalid_transition") {
        return { outcome: "in-progress", task: error.task ?? null };
      }
      throw error;
    }
  }

  /** The account's devices, for choosing a target. */
  async devices(signal: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    const { parsed } = await this.json("GET", this.url("/api/devices"), undefined, signal);
    const rows = isRecord(parsed) ? parsed["devices"] : null;
    if (!Array.isArray(rows)) throw new SendApiError("malformed");
    return Object.freeze(rows.filter(isRecord));
  }

  /** The target's registered keys. The seal must use the current one. */
  async targetKeys(targetDeviceID: string, signal: AbortSignal): Promise<readonly Record<string, unknown>[]> {
    const { parsed } = await this.json(
      "GET",
      this.deviceURL(targetDeviceID, "/inbox/keys"),
      undefined,
      signal,
    );
    const rows = isRecord(parsed) ? parsed["keys"] : null;
    if (!Array.isArray(rows)) throw new SendApiError("malformed");
    return Object.freeze(rows.filter(isRecord));
  }
}
