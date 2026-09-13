// The device-task byte adapter.
//
// ## Why this exists and what it does NOT do
//
// `UploadByteTransport` is deliberately purpose-agnostic — its own header says
// "nothing in this interface knows what an object IS: the purpose, the manifest
// version and the retention are all decided by whoever builds the `init` body".
// `UploadTransport.init` therefore omits `purpose`, and says why: an omitted
// purpose is `share`, and naming `device_task` there would claim an
// authorization model that client does not implement.
//
// A Device Inbox delivery must be `purpose=device_task`: no link, no file-list
// row, 404 on the public endpoints even for its owner. So this supplies that
// one request and **delegates everything else unchanged** to the accepted
// transport. `append`, `status` and `finalize` carry the offset algebra, the
// partial-commit handling and the bounded retries that `UploadEngine` is built
// around; re-implementing any of it here would be the duplicate retry engine
// this design exists to avoid.
import {
  UploadTransportError,
  type AppendReceipt,
  type FinalizeReceipt,
  type InitReceipt,
  type UploadByteTransport,
  type UploadRetention,
} from "../stored/upload/transport.js";

/** Matches the accepted transport's own id grammar, and for the same reason. */
const OBJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_JSON_BYTES = 512 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MIN_ACCEPTED_CHUNK_BYTES = 64 * 1024;
const MAX_ACCEPTED_CHUNK_BYTES = 8 * 1024 * 1024;
const FALLBACK_CHUNK_BYTES = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The bytes half of a delivery.
 *
 * `inner` is the accepted `UploadTransport`, constructed by the caller from the
 * same captured origin and bearer. Only `init` differs.
 */
export class DeviceTaskByteTransport implements UploadByteTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly inner: UploadByteTransport,
    private readonly origin: string,
    private readonly bearer: string,
    options: { readonly fetchImpl?: typeof fetch; readonly requestTimeoutMs?: number } = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Begin a `device_task` object.
   *
   * The body is the accepted framing — `u32be(manifestLen) || sealedManifest` —
   * and the manifest is the DEDICATED v3 Inbox document, sealed by the caller.
   * Retention is still sent because the server clamps and applies its plan cap
   * to a task object exactly as it does to a share.
   */
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
    // `resolveUploadRetention` REFUSES a device-task init that asks for burn or a
    // download limit — a delivery's lifetime is its task's, and central will not
    // hand out an object whose retention describes something else. Refused here
    // so a caller finds out before an upload session, not as a 400 the engine
    // would have to classify.
    if (retention.burnAfterRead) throw new UploadTransportError("malformed");
    // `burnAfterRead` is sent explicitly as `0` rather than omitted, so this
    // request states the retention it wants instead of relying on a default.
    const query =
      `?purpose=device_task&burnAfterRead=0` +
      `&ttl=${String(retention.ttlSeconds)}&size=${String(declaredCipherBytes)}`;
    const body = new Uint8Array(4 + sealedManifest.byteLength);
    new DataView(body.buffer).setUint32(0, sealedManifest.byteLength, false);
    body.set(sealedManifest, 4);

    const target = this.url(`/api/uploads${query}`);
    let response: Response;
    try {
      response = await this.fetchImpl(target, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.bearer}`,
          accept: "application/json",
          "content-type": "application/octet-stream",
        },
        redirect: "error",
        body: body as Uint8Array<ArrayBuffer>,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)])
          : AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      // The accepted transport's own vocabulary: a caller abort and a deadline
      // are different outcomes, and only one of them is the user's doing.
      if (name === "AbortError") throw new UploadTransportError("cancelled");
      if (name === "TimeoutError") throw new UploadTransportError("timeout");
      if (/redirect/i.test(String((error as Error | null)?.message))) {
        throw new UploadTransportError("redirect");
      }
      throw new UploadTransportError("network");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new UploadTransportError("http", response.status);
    }
    let parsed: unknown;
    try {
      const text = await this.boundedText(response);
      parsed = JSON.parse(text);
    } catch {
      throw new UploadTransportError("malformed");
    }
    if (!isRecord(parsed)) throw new UploadTransportError("malformed");
    const uploadId = parsed["uploadId"];
    if (typeof uploadId !== "string" || !OBJECT_ID.test(uploadId)) {
      // Refused, not escaped: this value is interpolated into every later URL.
      throw new UploadTransportError("malformed");
    }
    const declared = typeof parsed["chunkSize"] === "number" && Number.isSafeInteger(parsed["chunkSize"])
      ? (parsed["chunkSize"] as number)
      : 0;
    const chunkSize =
      declared <= 0
        ? FALLBACK_CHUNK_BYTES
        : Math.min(Math.max(declared, MIN_ACCEPTED_CHUNK_BYTES), MAX_ACCEPTED_CHUNK_BYTES);
    return { uploadId, chunkSize };
  }

  // Unchanged, and deliberately so: the offset algebra, partial commits and
  // bounded retries live in the accepted transport and its engine.
  append(
    uploadId: string,
    from: number,
    total: number,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<AppendReceipt> {
    return this.inner.append(uploadId, from, total, bytes, signal);
  }

  status(uploadId: string, signal?: AbortSignal): Promise<{ received: number } | "gone"> {
    return this.inner.status(uploadId, signal);
  }

  finalize(uploadId: string, signal?: AbortSignal): Promise<FinalizeReceipt> {
    return this.inner.finalize(uploadId, signal);
  }

  private url(path: string): string {
    const composed = `${this.origin}${path}`;
    let parsed: URL;
    try {
      parsed = new URL(composed);
    } catch {
      throw new UploadTransportError("malformed");
    }
    // If the composition somehow leaves the captured origin, it does not go out
    // with a bearer on it.
    if (parsed.origin !== new URL(this.origin).origin) throw new UploadTransportError("malformed");
    return composed;
  }

  private async boundedText(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (reader === undefined) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > MAX_JSON_BYTES) throw new UploadTransportError("malformed");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
}
