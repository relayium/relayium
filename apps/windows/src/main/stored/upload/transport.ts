// The four authenticated upload routes, and the two account routes history uses.
//
// Read from `server/account/uploads_resumable.go` and
// `server/account/files.go`'s `registerFileRoutes`, not from the Web wrapper's
// comments. The route table is authoritative; `uploads_resumable.go:1124`'s
// doc comment names a path (`/api/files/uploads/{id}`) that is not the mounted
// one.
//
// | Step | Request | Answer |
// |---|---|---|
// | init | `POST /api/uploads?burnAfterRead=0|1&ttl=<s>&size=<cipherBytes>` | `{uploadId, chunkSize}` |
// | append | `PATCH /api/uploads/{id}` + `Content-Range: bytes a-b/total` | `{received}`; 409 `{received}` |
// | status | `GET /api/uploads/{id}` | `{received}`; 404 once terminal |
// | finalize | `POST /api/uploads/{id}/finalize` | `{id, expiresAt}`; 409 once spent |
// | list | `GET /api/files` | `{files:[{id,size,createdAt,expiresAt,burnAfterRead,downloaded,downloadCount}]}` |
// | delete | `DELETE /api/files/{id}` | 204/404 |
//
// The init body is `uint32BE(len(encManifest)) ‖ encManifest`, read before any
// other check, and `files.go:26` bounds it at 64 KiB.
//
// ## What this transport will not do
//
//   * **No redirect, ever.** These requests carry the account BEARER, so
//     following a 3xx would hand the credential to whoever answered. That is
//     the opposite of the blob path's policy (`../transport.ts`), and the
//     difference is exactly the credential: an anonymous ciphertext fetch can
//     follow a bounded redirect safely, a bearer request cannot.
//   * **No cookies.** Node's fetch sends none; nothing here adds one.
//   * **No off-origin URL.** Every URL is composed from the captured
//     authority's origin, and the composed origin is re-checked before the
//     request goes out.
//   * **No `DELETE /api/uploads/{id}`.** It does not exist. An in-flight upload
//     cannot be cancelled server-side by this API at all, so a local cancel
//     must never claim the server erased anything.
//   * **No completion verifier and no `POST /api/files/{id}/complete`.** Those
//     belong to a pair-room object; a share has nothing for a receiver to end.

/** Bounded JSON answers. Every one of these documents is a handful of fields. */
export const MAX_JSON_BYTES = 512 * 1024;

/** `GET /api/files` grows with an account's share count, so it gets its own,
 *  larger ceiling: 1000 shares at ~120 bytes each is ~120 KiB. */
export const MAX_LIST_BYTES = 4 * 1024 * 1024;

export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/** An append carries up to a whole chunk, so it gets a longer budget than a
 *  metadata-sized request. The server's own bound is 10 minutes. */
export const DEFAULT_APPEND_TIMEOUT_MS = 120_000;

/**
 * The chunk size this client will accept from init.
 *
 * The server sends 8 MiB for a share and 1 MiB for a pair room. It is clamped
 * rather than trusted because it SIZES A BUFFER: a hostile or broken answer of
 * `chunkSize: 2 ** 40` would otherwise have this process allocate a terabyte
 * before the first byte is sent. Below the floor is equally refused — a
 * one-byte chunk would mean a PATCH per frame.
 */
export const MIN_ACCEPTED_CHUNK_BYTES = 64 * 1024;
export const MAX_ACCEPTED_CHUNK_BYTES = 8 * 1024 * 1024;
/** What the Web client falls back to when the answer carries no usable value. */
export const FALLBACK_CHUNK_BYTES = 8 * 1024 * 1024;

export type UploadTransportFailure =
  | "network"
  | "timeout"
  | "cancelled"
  | "redirect"
  | "too-large"
  | "malformed"
  /** A non-2xx this contract does not give its own outcome. `status` carries it. */
  | "http";

export class UploadTransportError extends Error {
  constructor(
    readonly code: UploadTransportFailure,
    readonly status: number | null = null,
  ) {
    super(status === null ? code : `${code}: ${String(status)}`);
    this.name = "UploadTransportError";
  }
  /** Whether a fresh attempt of the SAME request could plausibly differ. Note
   *  that finalize is excluded from this by its caller: it is once-only, so
   *  "retryable transport" and "safe to retry" are different questions. */
  get transient(): boolean {
    if (this.code === "network" || this.code === "timeout") return true;
    if (this.code !== "http" || this.status === null) return false;
    return this.status === 429 || this.status === 503 || (this.status >= 500 && this.status < 600);
  }
}

export interface InitReceipt {
  readonly uploadId: string;
  /** Already clamped into [MIN, MAX]. */
  readonly chunkSize: number;
}

export type AppendReceipt =
  /** `start === received`: the append happened. `received` may land INSIDE the
   *  chunk — the server commits partial chunks. */
  | { readonly outcome: "committed"; readonly received: number }
  /** 409: the server's offset differs from where this client tried to write —
   *  a gap, or the blob's own authoritative size after a duplicate. */
  | { readonly outcome: "offset"; readonly received: number };

export type FinalizeReceipt =
  /** The one and only 200. `id` is a NEW server-chosen object id. */
  | { readonly outcome: "finalized"; readonly id: string; readonly expiresAt: number }
  /**
   * 409 "already finalized".
   *
   * NOT success. The session was claimed terminally — by this client's own lost
   * attempt, by a racing one, or by a post-claim refusal that dropped the blob —
   * and the tombstone carries no id. Nothing in this API can tell those apart,
   * which is why the caller treats it as AMBIGUOUS and keeps the key.
   */
  | { readonly outcome: "already-finalized" };

export interface StoredFileRow {
  readonly id: string;
  readonly size: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly burnAfterRead: boolean;
  readonly downloaded: boolean;
  readonly downloadCount: number;
}

/**
 * The four calls the byte engine makes, as a STRUCTURAL interface.
 *
 * `UploadTransport` below is the only implementation this lane ships, but the
 * engine depends on this shape rather than on that class: a class with private
 * fields is nominal, so nothing else can satisfy it, and the offset algebra,
 * the retained replay window and the frame schedule are exactly the parts a
 * second sender should not have to write again.
 *
 * An implementation MUST classify its failures as `UploadTransportError` with
 * the codes above — that closed set is what `UploadEngine.classify` maps, and a
 * foreign error shape would arrive as `internal`.
 *
 * Deliberately narrow: `list` and `remove` are history's, not the engine's, so
 * they are not here. And nothing in this interface knows what an object IS —
 * the purpose, the manifest version and the retention are all decided by
 * whoever builds the `init` body.
 */
export interface UploadByteTransport {
  init(
    sealedManifest: Uint8Array,
    retention: UploadRetention,
    declaredCipherBytes: number,
    signal?: AbortSignal,
  ): Promise<InitReceipt>;
  append(
    uploadId: string,
    from: number,
    total: number,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<AppendReceipt>;
  status(uploadId: string, signal?: AbortSignal): Promise<{ received: number } | "gone">;
  finalize(uploadId: string, signal?: AbortSignal): Promise<FinalizeReceipt>;
}

export interface UploadRetention {
  readonly burnAfterRead: boolean;
  /** Seconds. The server clamps it and applies the plan cap. */
  readonly ttlSeconds: number;
}

const isAbort = (error: unknown): boolean => {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
};

const withDeadline = (timeoutMs: number, caller: AbortSignal | undefined): AbortSignal => {
  const deadline = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([deadline, caller]) : deadline;
};

/** The id grammar, restated from `web/src/lib/stored-file.ts` exactly as
 *  `../link.ts` restates it: an id is interpolated into three URLs, so a value
 *  like `../me` would compose a request at an endpoint this upload never
 *  authorised. Refused, never escaped. */
const OBJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export interface UploadTransportOptions {
  readonly fetchImpl?: typeof fetch;
  readonly requestTimeoutMs?: number;
  readonly appendTimeoutMs?: number;
}

export class UploadTransport implements UploadByteTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly appendTimeoutMs: number;

  constructor(
    private readonly origin: string,
    private readonly bearer: string,
    options: UploadTransportOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.appendTimeoutMs = options.appendTimeoutMs ?? DEFAULT_APPEND_TIMEOUT_MS;
  }

  private url(path: string): string {
    const composed = `${this.origin}${path}`;
    // Belt and braces on a value assembled from the captured origin and an id
    // this module validated: if the composition somehow leaves this origin, it
    // does not go out with a bearer on it.
    let parsed: URL;
    try {
      parsed = new URL(composed);
    } catch {
      throw new UploadTransportError("malformed");
    }
    if (parsed.origin !== this.origin) throw new UploadTransportError("malformed");
    return composed;
  }

  private checkedId(id: string): string {
    if (!OBJECT_ID.test(id)) throw new UploadTransportError("malformed");
    return id;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { accept: "application/json", authorization: `Bearer ${this.bearer}`, ...extra };
  }

  private async send(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    caller: AbortSignal | undefined,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: "error", signal });
    } catch (error) {
      if (isAbort(error)) {
        throw new UploadTransportError(caller?.aborted === true ? "cancelled" : "timeout");
      }
      if (/redirect/i.test(String((error as Error)?.message))) {
        throw new UploadTransportError("redirect");
      }
      throw new UploadTransportError("network");
    }
  }

  /**
   * Read a bounded JSON body, and OWN it on every exit.
   *
   * The same discipline S1's metadata read had to be corrected into: a refusal
   * that returns without cancelling leaves a live body behind a settled call.
   */
  private async json(response: Response, max: number, caller: AbortSignal | undefined): Promise<unknown> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const abandon = async (): Promise<void> => {
      if (reader !== null) {
        await reader.cancel().catch(() => undefined);
        return;
      }
      await response.body?.cancel().catch(() => undefined);
    };
    try {
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > max) throw new UploadTransportError("too-large");
      reader = response.body?.getReader() ?? null;
      if (reader === null) return undefined;
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > max) throw new UploadTransportError("too-large");
        chunks.push(value);
      }
      if (total === 0) return undefined;
      const merged = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        merged.set(chunk, at);
        at += chunk.byteLength;
      }
      try {
        return JSON.parse(new TextDecoder().decode(merged));
      } catch {
        throw new UploadTransportError("malformed");
      }
    } catch (error) {
      await abandon();
      if (error instanceof UploadTransportError) throw error;
      if (isAbort(error)) {
        throw new UploadTransportError(caller?.aborted === true ? "cancelled" : "timeout");
      }
      throw new UploadTransportError("network");
    } finally {
      try {
        reader?.releaseLock();
      } catch {
        /* already released, or a read is still settling */
      }
    }
  }

  /** Drain and release a body whose content this caller does not read. */
  private static async drop(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
  }

  async init(
    sealedManifest: Uint8Array,
    retention: UploadRetention,
    declaredCipherBytes: number,
    signal?: AbortSignal,
  ): Promise<InitReceipt> {
    if (!Number.isSafeInteger(declaredCipherBytes) || declaredCipherBytes < 0) {
      throw new UploadTransportError("malformed");
    }
    if (!Number.isSafeInteger(retention.ttlSeconds) || retention.ttlSeconds < 0) {
      throw new UploadTransportError("malformed");
    }
    // `purpose` is deliberately absent: an omitted purpose is `share`, and a
    // share is the only thing this client uploads. Naming `pair_room` or
    // `device_task` here would be claiming an authorization model this code
    // does not implement.
    const query =
      `?burnAfterRead=${retention.burnAfterRead ? "1" : "0"}` +
      `&ttl=${String(retention.ttlSeconds)}&size=${String(declaredCipherBytes)}`;
    const body = new Uint8Array(4 + sealedManifest.byteLength);
    new DataView(body.buffer).setUint32(0, sealedManifest.byteLength, false);
    body.set(sealedManifest, 4);

    const response = await this.send(
      this.url(`/api/uploads${query}`),
      {
        method: "POST",
        headers: this.headers({ "content-type": "application/octet-stream" }),
        body: body as Uint8Array<ArrayBuffer>,
      },
      withDeadline(this.requestTimeoutMs, signal),
      signal,
    );
    if (!response.ok) {
      await UploadTransport.drop(response);
      throw new UploadTransportError("http", response.status);
    }
    const parsed = await this.json(response, MAX_JSON_BYTES, signal);
    if (!isRecord(parsed)) throw new UploadTransportError("malformed");
    const uploadId = parsed["uploadId"];
    if (typeof uploadId !== "string" || !OBJECT_ID.test(uploadId)) {
      // Refused, not escaped: this value is interpolated into every later URL.
      throw new UploadTransportError("malformed");
    }
    const declared = integer(parsed["chunkSize"]) ?? 0;
    const chunkSize =
      declared <= 0
        ? FALLBACK_CHUNK_BYTES
        : Math.min(Math.max(declared, MIN_ACCEPTED_CHUNK_BYTES), MAX_ACCEPTED_CHUNK_BYTES);
    return { uploadId, chunkSize };
  }

  async append(
    uploadId: string,
    from: number,
    total: number,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<AppendReceipt> {
    if (bytes.byteLength === 0) throw new UploadTransportError("malformed");
    if (!Number.isSafeInteger(from) || from < 0) throw new UploadTransportError("malformed");
    const end = from + bytes.byteLength - 1;
    const response = await this.send(
      this.url(`/api/uploads/${this.checkedId(uploadId)}`),
      {
        method: "PATCH",
        headers: this.headers({
          "content-type": "application/octet-stream",
          "content-range": `bytes ${String(from)}-${String(end)}/${String(total)}`,
        }),
        // `BodyInit` accepts a view over an `ArrayBuffer`; the DOM lib will not
        // widen `ArrayBufferLike` to it, and copying the chunk to satisfy the
        // type would double the per-append memory this whole design bounds.
        body: bytes as Uint8Array<ArrayBuffer>,
      },
      withDeadline(this.appendTimeoutMs, signal),
      signal,
    );
    if (response.status === 409) {
      const parsed = await this.json(response, MAX_JSON_BYTES, signal);
      const received = isRecord(parsed) ? integer(parsed["received"]) : null;
      if (received === null || received < 0) throw new UploadTransportError("malformed");
      return { outcome: "offset", received };
    }
    if (!response.ok) {
      await UploadTransport.drop(response);
      throw new UploadTransportError("http", response.status);
    }
    const parsed = await this.json(response, MAX_JSON_BYTES, signal);
    const received = isRecord(parsed) ? integer(parsed["received"]) : null;
    if (received === null || received < 0) throw new UploadTransportError("malformed");
    return { outcome: "committed", received };
  }

  /** The resume probe. Answers 404 once the session is terminal — including
   *  after a successful finalize — so it can confirm an offset but never a
   *  finalization. */
  async status(uploadId: string, signal?: AbortSignal): Promise<{ received: number } | "gone"> {
    const response = await this.send(
      this.url(`/api/uploads/${this.checkedId(uploadId)}`),
      { method: "GET", headers: this.headers() },
      withDeadline(this.requestTimeoutMs, signal),
      signal,
    );
    if (response.status === 404) {
      await UploadTransport.drop(response);
      return "gone";
    }
    if (!response.ok) {
      await UploadTransport.drop(response);
      throw new UploadTransportError("http", response.status);
    }
    const parsed = await this.json(response, MAX_JSON_BYTES, signal);
    const received = isRecord(parsed) ? integer(parsed["received"]) : null;
    if (received === null || received < 0) throw new UploadTransportError("malformed");
    return { received };
  }

  /**
   * Finalize, once.
   *
   * No body: a completion verifier is refused with 400 on a share, and an
   * ordinary share has no completion capability at all. Sending nothing is also
   * what every existing client sends, which keeps this additive in both
   * directions.
   */
  async finalize(uploadId: string, signal?: AbortSignal): Promise<FinalizeReceipt> {
    const response = await this.send(
      this.url(`/api/uploads/${this.checkedId(uploadId)}/finalize`),
      { method: "POST", headers: this.headers() },
      withDeadline(this.requestTimeoutMs, signal),
      signal,
    );
    if (response.status === 409) {
      await UploadTransport.drop(response);
      return { outcome: "already-finalized" };
    }
    if (!response.ok) {
      await UploadTransport.drop(response);
      throw new UploadTransportError("http", response.status);
    }
    const parsed = await this.json(response, MAX_JSON_BYTES, signal);
    if (!isRecord(parsed)) throw new UploadTransportError("malformed");
    const id = parsed["id"];
    const expiresAt = integer(parsed["expiresAt"]);
    if (typeof id !== "string" || !OBJECT_ID.test(id) || expiresAt === null) {
      throw new UploadTransportError("malformed");
    }
    return { outcome: "finalized", id, expiresAt };
  }

  /** The account's shares. Task-purpose objects are excluded server-side, so
   *  this is exactly the set with a link and a delete button. */
  async list(signal?: AbortSignal): Promise<readonly StoredFileRow[]> {
    const response = await this.send(
      this.url("/api/files"),
      { method: "GET", headers: this.headers() },
      withDeadline(this.requestTimeoutMs, signal),
      signal,
    );
    if (!response.ok) {
      await UploadTransport.drop(response);
      throw new UploadTransportError("http", response.status);
    }
    const parsed = await this.json(response, MAX_LIST_BYTES, signal);
    const files = isRecord(parsed) ? parsed["files"] : null;
    if (!Array.isArray(files)) throw new UploadTransportError("malformed");
    const out: StoredFileRow[] = [];
    for (const raw of files) {
      if (!isRecord(raw)) throw new UploadTransportError("malformed");
      const id = raw["id"];
      const size = integer(raw["size"]);
      const createdAt = integer(raw["createdAt"]);
      const expiresAt = integer(raw["expiresAt"]);
      const downloadCount = integer(raw["downloadCount"]);
      if (
        typeof id !== "string" ||
        !OBJECT_ID.test(id) ||
        size === null ||
        createdAt === null ||
        expiresAt === null ||
        downloadCount === null ||
        typeof raw["burnAfterRead"] !== "boolean" ||
        typeof raw["downloaded"] !== "boolean"
      ) {
        throw new UploadTransportError("malformed");
      }
      out.push({
        id,
        size,
        createdAt,
        expiresAt,
        burnAfterRead: raw["burnAfterRead"],
        downloaded: raw["downloaded"],
        downloadCount,
      });
    }
    return out;
  }

  /** Delete ONE object this account owns. 404 is reported as `absent`, which is
   *  the proof a retirement needs and is not an error. */
  async remove(id: string, signal?: AbortSignal): Promise<"deleted" | "absent"> {
    const response = await this.send(
      this.url(`/api/files/${this.checkedId(id)}`),
      { method: "DELETE", headers: this.headers() },
      withDeadline(this.requestTimeoutMs, signal),
      signal,
    );
    await UploadTransport.drop(response);
    if (response.status === 404) return "absent";
    if (!response.ok) throw new UploadTransportError("http", response.status);
    return "deleted";
  }
}
