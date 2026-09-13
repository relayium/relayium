// The two unauthenticated GETs a stored receive makes, and their bounds.
//
// ## No credential of any kind
//
// `GET /api/files/{id}/meta` and `GET /api/files/{id}/blob` are
// unauthenticated: `server/account/files.go` exposes them without a session
// because a stored link IS the capability, and the bytes behind them are AES-GCM
// under a key the server has never seen. So this transport attaches no bearer,
// no device identity and no cookie, and an account-free receive works signed
// out. Attaching one would tie a link fetch to this installation's identity for
// no gain — and would make the download path depend on a sign-in it does not
// need.
//
// `POST /api/files/{id}/complete` is NOT here. It is the pair-room completion
// capability, the one public per-object route that WRITES, and an ordinary share
// must never send it (`docs/protocol/relayium-pair-room-v1.md` §7.3). Nor is
// `DELETE /api/uploads/{id}`, which does not exist.
//
// ## Four bounds, because a client without them is the attack
//
//   * **The origin is the build's.** Both URLs are composed from `origin.ts` and
//     an id this app validated; the link cannot contribute a host. See `link.ts`.
//   * **Metadata follows no redirect; the blob follows a bounded one.**
//     `server/account/files.go` 302s a blob read to a fleet node whenever the
//     file is eligible, WITHOUT any opt-in header — the
//     `X-Relayium-Direct-Download` header gates only the BYO own-node case. A
//     client that refused every 3xx would therefore fail every download of an
//     unlimited file that happens to live on a fleet node. So the answer is a
//     different policy, not a different threshold: the request carries no
//     credential of any kind, so there is nothing a redirect could leak, and
//     the target must clear the boundary in `directDownloadVerdict` — https,
//     no userinfo, no fragment, no non-default port, and a host inside
//     `*.relayium.com` or the central host itself. Bounded hops, loop refusal,
//     and the previous body cancelled before the next hop. The BYO opt-in
//     header is deliberately ABSENT, so a BYO node stays on central's proxy
//     path and no user-advertised hostname is ever contacted.
//   * **Both bodies are bounded.** The metadata document by a fixed ceiling, the
//     blob by the exact ciphertext length the (authenticated) manifest implies.
//     A hostile or broken origin cannot turn one call into an allocation, or a
//     disk fill, of its choosing.
//   * **A stalled stream dies.** A whole-transfer deadline would kill a
//     legitimate large download, so the blob carries a per-read stall deadline
//     instead: bytes must keep arriving, and a connection that goes quiet fails
//     rather than pinning the transfer forever.

/** Ceiling on the metadata document.
 *
 *  Sized from what a legal manifest can be, not guessed: 1000 entries (the
 *  shared `MAX_FILES`) at the 1024-byte name ceiling is 1 MiB of names, plus
 *  JSON overhead, plus base64's 4/3 expansion — about 1.4 MiB. 2 MiB clears
 *  that and nothing else. */
export const MAX_META_BYTES = 2 * 1024 * 1024;

/** Deadline for the metadata request, which is one small document. */
export const DEFAULT_META_TIMEOUT_MS = 15_000;

/** How long the blob may go without delivering a byte. */
export const DEFAULT_STALL_MS = 60_000;

export type StoredTransportFailure =
  /** The request never reached a server: offline, DNS, connection refused. */
  | "network"
  /** The deadline or the stall watchdog fired. */
  | "timeout"
  /** The caller's own signal. Never reported as a fault. */
  | "cancelled"
  /** A redirect this client will not follow: metadata redirected at all, or a
   *  blob redirected somewhere outside the trusted boundary. */
  | "redirect"
  /** A body or a declared length past its ceiling. */
  | "too-large"
  /** A non-2xx answer. `status` carries which. */
  | "http"
  /** A 2xx answer that is not the documented document. */
  | "malformed";

export class StoredTransportError extends Error {
  constructor(
    readonly code: StoredTransportFailure,
    /** The HTTP status, for `http` only. Null otherwise — never a guess. */
    readonly status: number | null = null,
  ) {
    super(status === null ? code : `${code}: ${String(status)}`);
    this.name = "StoredTransportError";
  }
}

/**
 * The apex and the subdomain suffix of the operated fleet.
 *
 * The suffix INCLUDES the dot, which is the whole check: `evilrelayium.com`
 * and `relayium.com.evil.example` both fail it, and both pass a naive
 * `includes("relayium.com")`.
 */
export const FLEET_APEX = "relayium.com";
export const FLEET_HOST_SUFFIX = ".relayium.com";

/** Central -> node is one hop. Three leaves room for a deployment that adds a
 *  rewrite without letting a loop run — the same bound
 *  `apps/android/.../BlobRedirect.kt` uses. */
export const MAX_BLOB_REDIRECTS = 3;

export type RedirectRefusal =
  | "no-location"
  | "unparseable"
  | "insecure-scheme"
  | "userinfo"
  | "fragment"
  | "port"
  | "untrusted-host"
  | "loop"
  | "too-many-hops";

export type RedirectVerdict =
  | { readonly follow: true; readonly url: string }
  | { readonly follow: false; readonly reason: RedirectRefusal };

/** The 3xx statuses that carry a `Location` this client would act on. */
export const isRedirectStatus = (status: number): boolean =>
  status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

/**
 * Whether a blob download may follow this redirect, and to where.
 *
 * Pure and exported so the boundary is testable without a socket. Every clause
 * is a refusal this product needs:
 *
 *   * **https only.** No downgrade, ever — including the case where the current
 *     hop is already plaintext. A ciphertext body is not secret, but a
 *     plaintext hop is an attacker's chance to substitute one, and the AEAD
 *     failure that follows would look to the user like a corrupted file.
 *   * **No userinfo.** `https://user:pass@node/…` is a shape no node sends and
 *     a credential-carrying URL this client will not construct.
 *   * **No fragment.** The fragment is where a KEY lives in this product. A
 *     target carrying one is refused rather than stripped, because a client
 *     that quietly strips it is a client that could one day forward it.
 *   * **No non-default port.** A node advertises a public https DownloadURL;
 *     an odd port is not a shape the fleet serves, and admitting one widens the
 *     boundary to any service on a trusted host.
 *   * **A host inside the fleet, or central itself.** This is the clause the
 *     other clients do not have (see the mismatch note in the S1 evidence):
 *     macOS follows URLSession's automatic redirects with no host policy, and
 *     Android's `BlobRedirect` admits any https host because it opts into BYO.
 *     This build does not opt in, so it does not need to admit one.
 *   * **Bounded hops and no repeats**, so a loop is a refusal rather than a
 *     hang.
 *
 * A refusal is REPORTED, never worked around: the user is told the server
 * pointed somewhere this app would not follow, which is truthful and
 * actionable.
 */
export function directDownloadVerdict(input: {
  /** The URL that produced this redirect, for resolving a relative `Location`. */
  readonly current: string;
  readonly location: string | null;
  /** This build's own origin host, which is always admissible. */
  readonly centralHost: string;
  readonly hop: number;
  readonly visited: ReadonlySet<string>;
}): RedirectVerdict {
  if (input.hop >= MAX_BLOB_REDIRECTS) return { follow: false, reason: "too-many-hops" };
  const raw = input.location?.trim();
  if (raw === undefined || raw.length === 0) return { follow: false, reason: "no-location" };
  let target: URL;
  try {
    // Resolved against the current URL, which is how a relative `Location` is
    // defined. A scheme `URL` cannot parse, and `intent:`/`file:`/`data:`, are
    // caught by the https check below rather than reaching a request.
    target = new URL(raw, input.current);
  } catch {
    return { follow: false, reason: "unparseable" };
  }
  if (target.username !== "" || target.password !== "") return { follow: false, reason: "userinfo" };
  if (target.hash !== "") return { follow: false, reason: "fragment" };
  if (target.protocol !== "https:") return { follow: false, reason: "insecure-scheme" };
  if (target.port !== "" && target.port !== "443") return { follow: false, reason: "port" };
  const host = target.hostname.toLowerCase();
  const trusted =
    host === input.centralHost.toLowerCase() || host === FLEET_APEX || host.endsWith(FLEET_HOST_SUFFIX);
  if (!trusted) return { follow: false, reason: "untrusted-host" };
  const url = target.toString();
  if (input.visited.has(url)) return { follow: false, reason: "loop" };
  return { follow: true, url };
}

/** `GET /api/files/{id}/meta`, validated. Matches `web/src/lib/stored-file.ts`'s
 *  `StoredFileMeta`. */
export interface StoredObjectMeta {
  /** The sealed manifest — AEAD frame 0 — as standard base64. */
  readonly encManifest: string;
  /** The server's ciphertext accounting. Unauthenticated: a hint, never a gate. */
  readonly size: number;
  /** Deleted by the server after one successful GET. */
  readonly burnAfterRead: boolean;
  /** Unix seconds. Unauthenticated, and retained for a truthful UI. */
  readonly expiresAt: number;
}

/**
 * What a receive needs from the server, as an interface.
 *
 * `StoredTransport` is the only implementation and the only one that will ship;
 * the interface exists because the class holds private state, which makes it
 * unusable as a seam. A test drives an adversarial source through this — a body
 * that stops mid-frame, a 404 between the metadata read and the blob read — and
 * `receive.ts` depends on the interface so no such test can accidentally reach
 * the network.
 */
export interface StoredObjectSource {
  meta(id: string, signal?: AbortSignal): Promise<StoredObjectMeta>;
  /** `maxBytes` is the exact ciphertext length the manifest implies. */
  blob(id: string, maxBytes: number, signal?: AbortSignal): Promise<StoredBlobBody>;
}

/** A bounded pull over the ciphertext body. `null` ends it. */
export interface StoredBlobBody {
  read(): Promise<Uint8Array | null>;
  /** Idempotent. Releases the connection; never throws. */
  close(): Promise<void>;
}

const isAbort = (error: unknown): boolean => {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
};

/** The caller's cancellation merged with a deadline, so a caller that supplies
 *  a signal does not silently lose the bound that stops a stalled connection. */
const withDeadline = (timeoutMs: number, caller: AbortSignal | undefined): AbortSignal => {
  const deadline = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([deadline, caller]) : deadline;
};

function asBytes(value: Uint8Array | undefined): Uint8Array | null {
  return value === undefined || value.byteLength === 0 ? null : value;
}

/** Reject a 2xx metadata body that is not the documented shape. Every field is
 *  checked, because one missing field means a different document — and guessing
 *  what it meant is how a client starts trusting a server it cannot parse. */
function checkedMeta(body: unknown): StoredObjectMeta {
  if (body === null || typeof body !== "object") throw new StoredTransportError("malformed");
  const record = body as Record<string, unknown>;
  const encManifest = record["encManifest"];
  const size = record["size"];
  const burnAfterRead = record["burnAfterRead"];
  const expiresAt = record["expiresAt"];
  if (typeof encManifest !== "string" || encManifest.length === 0) {
    throw new StoredTransportError("malformed");
  }
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new StoredTransportError("malformed");
  }
  if (typeof burnAfterRead !== "boolean") throw new StoredTransportError("malformed");
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)) {
    throw new StoredTransportError("malformed");
  }
  return { encManifest, size, burnAfterRead, expiresAt };
}

export interface StoredTransportOptions {
  readonly fetchImpl?: typeof fetch;
  readonly metaTimeoutMs?: number;
  readonly stallMs?: number;
}

export class StoredTransport implements StoredObjectSource {
  private readonly fetchImpl: typeof fetch;
  private readonly metaTimeoutMs: number;
  private readonly stallMs: number;

  constructor(
    /** This build's origin. Supplied by the host, never by a link. */
    private readonly origin: string,
    options: StoredTransportOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.metaTimeoutMs = options.metaTimeoutMs ?? DEFAULT_META_TIMEOUT_MS;
    this.stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  }

  /** The URL for one validated id. `encodeURIComponent` on a value that already
   *  passed `link.ts`'s grammar: belt and braces, and the reason no caller
   *  assembles one of these itself. */
  private url(id: string, leaf: "meta" | "blob"): string {
    return `${this.origin}/api/files/${encodeURIComponent(id)}/${leaf}`;
  }

  private async send(
    url: string,
    accept: string,
    signal: AbortSignal,
    /**
     * `"error"` for metadata, which must never redirect. `"manual"` for the
     * blob, so the 3xx is HANDED BACK and judged by `directDownloadVerdict`
     * instead of being followed by the runtime, which would apply no boundary
     * of its own.
     */
    redirect: "error" | "manual",
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method: "GET",
        // The complete header set. No bearer, no cookie, no referer, and
        // deliberately no `X-Relayium-Direct-Download`: that header opts into a
        // BYO own-node redirect to a user-advertised hostname, and this client
        // does not follow one. Omitting it keeps BYO objects on central's
        // proxy path, which is always correct if slower.
        headers: { accept },
        redirect,
        signal,
      });
    } catch (error) {
      // A cancelled request rejects here too, and it is not a network fault:
      // telling the caller the server was unreachable would put a retry in
      // front of a user who has left.
      if (isAbort(error)) {
        throw new StoredTransportError(signal.aborted && !isTimeout(signal) ? "cancelled" : "timeout");
      }
      // `redirect: "error"` surfaces as a TypeError; reported distinctly so a
      // refused redirect is never read as an ordinary network blip.
      if (/redirect/i.test(String((error as Error)?.message))) {
        throw new StoredTransportError("redirect");
      }
      throw new StoredTransportError("network");
    }
  }

  async meta(id: string, signal?: AbortSignal): Promise<StoredObjectMeta> {
    const merged = withDeadline(this.metaTimeoutMs, signal);
    const response = await this.send(this.url(id, "meta"), "application/json", merged, "error");
    // Every exit from here owns the response body.
    //
    // A refusal used to `throw` straight out of the checks below, which left a
    // live body — and therefore a live connection — behind a method that had
    // already settled. Root's real-HTTP probe caught it: a server that sends
    // headers plus one byte and then parks kept the response OPEN 100ms after
    // `too-large` rejected, with this side's 5s deadline no longer watching
    // anything. The non-ok early return had the identical shape. So the checks
    // are inside a `try`, cancellation is unconditional on the way out, and the
    // reader's lock is released in a `finally` once it exists.
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const abandon = async (): Promise<void> => {
      // Through the READER once one exists: acquiring it locks the stream, and
      // `body.cancel()` on a locked stream throws instead of cancelling.
      if (reader !== null) {
        await reader.cancel().catch(() => undefined);
        return;
      }
      await response.body?.cancel().catch(() => undefined);
    };
    try {
      if (!response.ok) throw new StoredTransportError("http", response.status);
      // `Content-Length` is a hint from the peer, used to refuse early but never
      // trusted as the limit — the counted read below is the real one.
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > MAX_META_BYTES) {
        throw new StoredTransportError("too-large");
      }
      reader = response.body?.getReader() ?? null;
      if (reader === null) throw new StoredTransportError("malformed");
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > MAX_META_BYTES) throw new StoredTransportError("too-large");
        chunks.push(value);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(concat(chunks, total)));
      } catch {
        throw new StoredTransportError("malformed");
      }
      return checkedMeta(parsed);
    } catch (error) {
      await abandon();
      if (error instanceof StoredTransportError) throw error;
      if (isAbort(error)) {
        throw new StoredTransportError(signal?.aborted === true ? "cancelled" : "timeout");
      }
      throw new StoredTransportError("network");
    } finally {
      // After a completed read the stream is closed and this frees the lock;
      // after `abandon` the reader is already released and this is a no-op.
      // Wrapped because releasing a reader with a read still pending throws,
      // and no exit above must be turned into a different failure by cleanup.
      try {
        reader?.releaseLock();
      } catch {
        /* already released, or a read is still settling */
      }
    }
  }

  /**
   * Start the ciphertext read.
   *
   * `maxBytes` is the exact ciphertext length the manifest implies — computed,
   * not taken from the server — so a body that runs past it is refused mid-flight
   * instead of being written to the user's disk. A stream that stops SHORT is
   * caught elsewhere and cannot be caught here: only the decryptor's
   * `end(expected)` can tell a truncation on a frame boundary from a clean end.
   */
  async blob(id: string, maxBytes: number, signal?: AbortSignal): Promise<StoredBlobBody> {
    // No deadline on the request itself beyond the caller's signal: the stall
    // watchdog below is what bounds a live body, and a fixed deadline here
    // would kill a legitimate large download.
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) throw new StoredTransportError("cancelled");
      signal.addEventListener("abort", abort, { once: true });
    }
    let stall: ReturnType<typeof setTimeout> | null = null;
    let stalled = false;
    const clearStall = (): void => {
      if (stall !== null) {
        clearTimeout(stall);
        stall = null;
      }
    };
    const armStall = (): void => {
      clearStall();
      stall = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, this.stallMs);
    };
    const release = (): void => {
      clearStall();
      if (signal) signal.removeEventListener("abort", abort);
    };

    // The hop loop. Central answers a 302 to a fleet node for any eligible
    // unlimited object, with no opt-in header, so this is the ORDINARY path and
    // not an exception — but every hop is judged before it is made.
    const central = this.url(id, "blob");
    const centralHost = new URL(this.origin).hostname;
    let response: Response;
    let replayed = false;
    for (;;) {
      let url = central;
      const visited = new Set<string>([central]);
      let followed = false;
      for (let hop = 0; ; hop += 1) {
        try {
          armStall();
          response = await this.send(url, "application/octet-stream", controller.signal, "manual");
        } catch (error) {
          release();
          throw retarget(error, stalled, signal);
        }
        clearStall();
        if (!isRedirectStatus(response.status)) break;
        // The previous body is cancelled before the next request, so a hop
        // never leaves a connection open behind it.
        await response.body?.cancel().catch(() => undefined);
        const verdict = directDownloadVerdict({
          current: url,
          location: response.headers.get("location"),
          centralHost,
          hop,
          visited,
        });
        if (!verdict.follow) {
          release();
          throw new StoredTransportError("redirect");
        }
        visited.add(verdict.url);
        url = verdict.url;
        followed = true;
      }
      // A fleet redirect hands out a ONE-SHOT token, so a request that was
      // replayed underneath us — a retried idle connection — comes back 403
      // from the node. Nothing has been streamed at this point, so central is
      // asked once more for a fresh token. Bounded to a single extra attempt,
      // and only after a redirect was actually followed: a 403 straight from
      // central is a real refusal, not a spent token. This is the only retry in
      // the whole receive path, and it cannot run after a byte has reached the
      // decryptor because it happens before this function returns a body.
      if (response.status === 403 && followed && !replayed) {
        replayed = true;
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      break;
    }
    if (!response.ok) {
      release();
      await response.body?.cancel().catch(() => undefined);
      throw new StoredTransportError("http", response.status);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes) {
      release();
      await response.body?.cancel().catch(() => undefined);
      throw new StoredTransportError("too-large");
    }
    const reader = response.body?.getReader();
    if (!reader) {
      release();
      throw new StoredTransportError("malformed");
    }

    let received = 0;
    let finished = false;
    return {
      read: async (): Promise<Uint8Array | null> => {
        // Loops rather than returning per read, because a zero-length chunk is
        // not the end of a body: `done` is. Returning an empty array as data
        // would make every caller handle a third case, and treating it as the
        // end would truncate the stream on a peer's harmless flush.
        for (;;) {
          if (finished) return null;
          armStall();
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await reader.read();
          } catch (error) {
            finished = true;
            release();
            throw retarget(error, stalled, signal);
          }
          clearStall();
          // Re-checked AFTER the read: the case that matters is the read that
          // was in flight when the signal fired and resolves afterwards,
          // holding a chunk whose plaintext would otherwise reach the disk.
          if (signal?.aborted === true) {
            finished = true;
            release();
            await reader.cancel().catch(() => undefined);
            throw new StoredTransportError("cancelled");
          }
          if (result.done) {
            finished = true;
            release();
            return null;
          }
          const bytes = asBytes(result.value);
          if (bytes === null) continue; // empty chunk: the stall watchdog still applies
          received += bytes.byteLength;
          if (received > maxBytes) {
            finished = true;
            release();
            await reader.cancel().catch(() => undefined);
            throw new StoredTransportError("too-large");
          }
          return bytes;
        }
      },
      close: async (): Promise<void> => {
        finished = true;
        release();
        await reader.cancel().catch(() => undefined);
      },
    };
  }
}

/** True when this signal's own abort came from `AbortSignal.timeout`. */
function isTimeout(signal: AbortSignal): boolean {
  return (signal.reason as { name?: unknown } | null)?.name === "TimeoutError";
}

/** Turn an abort into the reason it actually had: the stall watchdog, the
 *  caller, or a transport fault. Guessing here is how a cancellation gets
 *  reported as a network error and offered a retry. */
function retarget(error: unknown, stalled: boolean, caller: AbortSignal | undefined): StoredTransportError {
  if (error instanceof StoredTransportError) {
    if (error.code === "cancelled" || error.code === "timeout") {
      return new StoredTransportError(stalled ? "timeout" : caller?.aborted === true ? "cancelled" : error.code);
    }
    return error;
  }
  if (isAbort(error)) {
    if (stalled) return new StoredTransportError("timeout");
    return new StoredTransportError(caller?.aborted === true ? "cancelled" : "timeout");
  }
  return new StoredTransportError("network");
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
