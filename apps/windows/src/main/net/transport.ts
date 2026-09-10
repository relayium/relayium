// The main process's only outbound HTTP path.
//
// ## Three bounds, because a client without them is the attack
//
//   * **Redirects are never followed.** `redirect: "error"`. A 302 to another
//     host, followed with an `Authorization` header attached, hands the bearer
//     to whoever controls the target — and the client would report success. The
//     server's device-auth endpoints do not redirect, so following one is not a
//     feature being given up.
//   * **Response bodies are bounded.** The body is read in chunks against a
//     ceiling instead of buffered whole, so a hostile or broken origin cannot
//     turn one call into an allocation of its choosing.
//   * **Every call has a deadline.** An `AbortSignal` timeout, so a stalled
//     connection fails instead of pinning a poll loop forever. Callers may add
//     their OWN signal on top of it: a cancelled sign-in aborts the request it
//     is still waiting on rather than letting it run to completion against a
//     decision that has already been made.
//
// ## Off-origin URLs are refused
//
// Callers pass a full URL, but it is parsed and its origin must equal this
// build's. The origin decision stays in `origin.ts`; this check is what makes
// that decision binding rather than advisory, so a caller that assembled a URL
// from a server-supplied value cannot reach another host with the bearer.

export const MAX_RESPONSE_BYTES = 256 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;

export type TransportFailure = "network" | "too-large" | "timeout" | "redirect" | "bad-url";

export class TransportError extends Error {
  constructor(readonly code: TransportFailure, message?: string) {
    super(message ?? code);
    this.name = "TransportError";
  }
}

export interface JSONResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * The caller's own cancellation, merged with this transport's deadline.
 *
 * `AbortSignal.any` rather than replacing the timeout: a caller that supplies a
 * signal must not silently lose the bound that stops a stalled connection from
 * pinning a poll loop forever.
 */
const withDeadline = (timeoutMs: number, caller: AbortSignal | undefined): AbortSignal => {
  const deadline = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([deadline, caller]) : deadline;
};

async function readBounded(response: Response): Promise<string> {
  // `Content-Length` is a hint from the peer, so it is used to refuse early but
  // never trusted as the actual limit — the counted read below is the real one.
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new TransportError("too-large");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new TransportError("too-large");
      }
      chunks.push(value);
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export class BoundedTransport {
  constructor(
    private readonly origin: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async postJSON(
    url: string,
    body: unknown | undefined,
    signal?: AbortSignal,
  ): Promise<JSONResponse> {
    // Callers inside this app build `${origin}${path}`; anything that does not
    // land on this build's origin is refused rather than sent.
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new TransportError("bad-url");
    }
    if (target.origin !== this.origin) throw new TransportError("bad-url");

    const headers: Record<string, string> = { accept: "application/json" };
    const init: RequestInit = {
      method: "POST",
      headers,
      redirect: "error",
      signal: withDeadline(this.timeoutMs, signal),
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(target.toString(), init);
    } catch (err) {
      const name = (err as Error)?.name;
      // A caller's abort and the deadline both surface as `AbortError`; the
      // caller that aborted already knows why, and the one that did not is
      // looking at a request that ran out of time either way.
      if (name === "TimeoutError" || name === "AbortError") throw new TransportError("timeout");
      // `redirect: "error"` surfaces as a TypeError from fetch; reported
      // distinctly so a redirect is never read as an ordinary network blip.
      if (/redirect/i.test(String((err as Error)?.message))) throw new TransportError("redirect");
      throw new TransportError("network", String((err as Error)?.message));
    }

    const text = await readBounded(response);
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    return { status: response.status, body: parsed };
  }
}
