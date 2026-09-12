// One bounded HTTP GET, for everything in this process that reads a document
// off the network.
//
// Extracted from `update/feed.ts`, where it was written and hardened, because a
// second caller now needs it: the client-policy source reads a document that
// decides whether this build may run. Copying sixty lines of network-facing
// code so the two could diverge is the worst option available — one of the two
// would eventually be the one missing a bound.
//
// What it guarantees, and each of these is a way to hurt a client if omitted:
//
//  * A deadline, so a hung origin cannot hold a start-up open for ever.
//  * `redirect: "error"`, so an origin cannot send this fetch somewhere else.
//  * A ceiling checked against `content-length` AND while reading, because a
//    declared length is a claim and the stream is the fact.
//  * A body abandoned on every failure path, so a refused response does not
//    leave a socket held.
//  * No authorization, no cookie, no user-agent override — nothing that
//    identifies this installation to the origin.
//
// `feed.ts` maps these codes onto its own taxonomy, unchanged, and its suite is
// the proof that moving this moved nothing.

export type HttpRefusal =
  | "network"
  | "timeout"
  | "cancelled"
  | "redirect"
  | "too-large"
  | "http"
  | "malformed";

export class HttpError extends Error {
  constructor(
    readonly code: HttpRefusal,
    readonly status: number | null = null,
    readonly detail: string | null = null,
  ) {
    super(status === null ? code : `${code}: ${String(status)}`);
    this.name = "HttpError";
  }
}

const isAbort = (error: unknown): boolean => {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
};

/** One bounded GET with no credential and no redirect. Owns its response body
 *  on every exit. */
export async function boundedGet(
  fetchImpl: typeof fetch,
  url: string,
  max: number,
  timeoutMs: number,
  caller: AbortSignal | undefined,
): Promise<Uint8Array> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = caller ? AbortSignal.any([deadline, caller]) : deadline;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      // The complete header set. No authorization, no cookie, no user agent
      // override, nothing that identifies this installation.
      headers: { accept: "application/octet-stream" },
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (isAbort(error)) {
      throw new HttpError(caller?.aborted === true ? "cancelled" : "timeout");
    }
    if (/redirect/i.test(String((error as Error)?.message))) throw new HttpError("redirect");
    throw new HttpError("network");
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const abandon = async (): Promise<void> => {
    if (reader !== null) {
      await reader.cancel().catch(() => undefined);
      return;
    }
    await response.body?.cancel().catch(() => undefined);
  };
  try {
    if (!response.ok) throw new HttpError("http", response.status);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > max) throw new HttpError("too-large");
    reader = response.body?.getReader() ?? null;
    if (reader === null) throw new HttpError("malformed", null, "no body");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > max) throw new HttpError("too-large");
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  } catch (error) {
    await abandon();
    if (error instanceof HttpError) throw error;
    if (isAbort(error)) throw new HttpError(caller?.aborted === true ? "cancelled" : "timeout");
    throw new HttpError("network");
  } finally {
    try {
      reader?.releaseLock();
    } catch {
      /* already released */
    }
  }
}

