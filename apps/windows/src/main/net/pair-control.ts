// Minting a pairing code. The one request in this app that carries the bearer
// on the user's behalf, so it is the one that has to be most careful.
//
// ## Why main, and not the renderer
//
// `POST /api/pair` requires a session (`createPair` in
// `web/src/lib/transfer-link.ts` surfaces a 401 as a re-login prompt). The bearer
// lives in main and never crosses to the renderer — that is the property that
// makes a script foothold in the renderer survivable — so the request is made
// here and the renderer receives a code and an expiry, never a token.
//
// ## What the renderer can express: nothing
//
// There is no parameter. The renderer asks "mint me a code"; the URL, the
// method, the header and the body are all fixed here. This is deliberately NOT
// a generic authenticated-request channel, because that is what a
// renderer-supplied URL plus a bearer would be.
//
// ## The bearer goes to exactly one origin
//
// The URL is built from the compiled origin and then re-parsed and compared
// against it before the request is sent. Redirects are refused. A 302 to another
// host, followed with an `Authorization` header attached, hands the bearer to
// whoever controls the target — and the client would report success.
//
// ## Nothing here is logged
//
// Not the token, not the minted code. The code is a short-lived shared secret
// that admits a peer to a room; a log line carrying it is a log line that grants
// access to the transfer.

import { PAIR_CODE_LENGTH, type PairMintResult } from "../../shared/ipc-contract.js";
import { DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES } from "./transport.js";

/** Why a mint did not produce a code. Each is a different sentence to the user,
 *  which is the whole reason they are separate values. */
export type PairMintRefusal =
  | "signed-out"
  | "quota"
  | "unverified"
  | "rate-limited"
  | "unavailable";

const REFUSAL_BY_STATUS: Record<number, PairMintRefusal> = {
  401: "signed-out",
  403: "unverified",
  402: "quota",
  429: "rate-limited",
};

export class PairControl {
  constructor(
    private readonly origin: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /**
   * Mint one code.
   *
   * `bearer` is passed in rather than read here: this class holds no store and
   * no session, so it cannot accidentally mint under an identity the caller did
   * not intend. The caller (`AppService`) is what captures and re-checks the
   * account epoch and the document generation around it.
   *
   * `signal` lets the caller abandon the request when the authority that
   * started it goes away, rather than leaving a privileged authenticated
   * request running for an answer nobody may install.
   */
  async mint(bearer: string, signal?: AbortSignal): Promise<PairMintResult> {
    const url = `${this.origin}/api/pair`;
    // Built from the compiled origin above, and checked here anyway. The check
    // is what makes that decision binding rather than advisory.
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return { ok: false, refusal: "unavailable" };
    }
    if (target.origin !== this.origin) return { ok: false, refusal: "unavailable" };

    let response: Response;
    try {
      response = await this.fetchImpl(target.toString(), {
        method: "POST",
        headers: {
          accept: "application/json",
          // The only place this header is attached in the whole app.
          authorization: `Bearer ${bearer}`,
        },
        redirect: "error",
        signal: this.deadline(signal),
      });
    } catch {
      // No status line: network, deadline, or a refused redirect. Reported as
      // one thing because the user's next action is the same for all three.
      return { ok: false, refusal: "unavailable" };
    }

    if (!response.ok) {
      const refusal = REFUSAL_BY_STATUS[response.status];
      // A denial the server chose to explain wins over the status alone, so a
      // 403 that says "quota" is reported as quota rather than as unverified.
      const explained = await this.deniedReason(response);
      return { ok: false, refusal: explained ?? refusal ?? "unavailable" };
    }

    let body: unknown;
    try {
      body = JSON.parse(await this.readBounded(response));
    } catch {
      return { ok: false, refusal: "unavailable" };
    }
    const minted = narrowMint(body);
    // A 200 whose body is not a code is not a success. Reporting it as one
    // would put an unusable string on screen and call it a pairing code.
    return minted ?? { ok: false, refusal: "unavailable" };
  }

  /** A `relayDenied`-style explanation in a non-2xx body, when there is one. */
  private async deniedReason(response: Response): Promise<PairMintRefusal | null> {
    try {
      const body = JSON.parse(await this.readBounded(response)) as { reason?: unknown };
      if (body?.reason === "quota" || body?.reason === "unverified") return body.reason;
    } catch {
      // Not a JSON body, or over the ceiling. The status stands on its own.
    }
    return null;
  }

  private deadline(caller: AbortSignal | undefined): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return caller ? AbortSignal.any([timeout, caller]) : timeout;
  }

  /** Counted read against the ceiling; the stream is cancelled the moment it is
   *  exceeded rather than draining a body already refused. */
  private async readBounded(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("pair response exceeds the ceiling");
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
}

/**
 * Narrow the minted code, or refuse it.
 *
 * ## Exactly six digits, not "digits up to a ceiling"
 *
 * A looser parser here would disagree with every other check in the system:
 * `isValidCode` in `web/src/lib/pair-code`, `isWellFormedCode` in
 * `signaling-socket.ts`, and `ValidCodeFormat` on the server all mean exactly
 * six. A seven-digit string accepted here would be rendered as the user's code
 * and then refused by main the moment it tried to open the room — a code on
 * screen that cannot work.
 *
 * ## The expiry has to be real
 *
 * Defaulting a missing or malformed `expiresAt` to `0` produced a code the UI
 * immediately described as expired. That is not a safe default, it is a wrong
 * one: the code is live, the server minted it, and the screen says it is dead.
 * A response with no usable expiry is a response this build does not understand,
 * so it is refused rather than displayed with an invented one.
 */
export function narrowMint(raw: unknown): PairMintResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const shaped = raw as { code?: unknown; expiresAt?: unknown };
  if (typeof shaped.code !== "string") return null;
  if (!new RegExp(`^[0-9]{${PAIR_CODE_LENGTH}}$`).test(shaped.code)) return null;
  const expiresAt = shaped.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0) return null;
  return { ok: true, code: shaped.code, expiresAt };
}
