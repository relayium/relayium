// Fetching the update metadata, and verifying it before believing any of it.
//
// ## The order is the whole security property
//
//   1. fetch the signature (small, bounded);
//   2. fetch the metadata bytes (bounded);
//   3. verify the DETACHED signature over those EXACT BYTES against a pinned
//      key;
//   4. and only then parse.
//
// Not "parse and then check the signature over what we parsed", which verifies
// a re-serialisation rather than the publisher's bytes, and not "parse to find
// out where the signature is", which takes a decision from an unverified
// document.
//
// ## No credential, no identifier, no redirect
//
// The check carries no bearer, no cookie, no query string and no header that
// distinguishes one installation from another: the request is the same for
// everybody, which is what makes an automatic check compatible with the privacy
// posture. Redirects are refused outright — the feed URL is fixed, so a
// redirect is either a misconfiguration or a redirection of trust.

import { assertSignedByPin, decodeSignature, TrustError, type UpdateTrust } from "./trust.js";
import { MAX_MANIFEST_BYTES, parseManifest, type UpdateManifest } from "./manifest.js";

/** A base64url Ed25519 signature is 86 bytes of text; the ceiling is generous
 *  for a trailing newline and nothing else. */
export const MAX_SIGNATURE_BYTES = 256;
export const DEFAULT_FEED_TIMEOUT_MS = 15_000;

export type FeedFailure =
  | "network"
  | "timeout"
  | "cancelled"
  | "redirect"
  | "too-large"
  | "http"
  /** The bytes are not signed by a pinned key, or no key is pinned. TERMINAL —
   *  never retried as unverified. */
  | "untrusted"
  /** Signed, but not a manifest this build understands. */
  | "malformed";

export class FeedError extends Error {
  constructor(
    readonly code: FeedFailure,
    readonly status: number | null = null,
    readonly detail: string | null = null,
  ) {
    super(status === null ? code : `${code}: ${String(status)}`);
    this.name = "FeedError";
  }
  /** Whether asking again could plausibly differ. False for `untrusted`, which
   *  is the point: a rejected signature is not cured by retrying. */
  get retryable(): boolean {
    if (this.code === "network" || this.code === "timeout") return true;
    if (this.code !== "http" || this.status === null) return false;
    return this.status === 429 || this.status >= 500;
  }
}

const isAbort = (error: unknown): boolean => {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
};

export interface FeedOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** One bounded GET with no credential and no redirect. Owns its response body
 *  on every exit. */
async function get(
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
      throw new FeedError(caller?.aborted === true ? "cancelled" : "timeout");
    }
    if (/redirect/i.test(String((error as Error)?.message))) throw new FeedError("redirect");
    throw new FeedError("network");
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
    if (!response.ok) throw new FeedError("http", response.status);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > max) throw new FeedError("too-large");
    reader = response.body?.getReader() ?? null;
    if (reader === null) throw new FeedError("malformed", null, "no body");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > max) throw new FeedError("too-large");
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
    if (error instanceof FeedError) throw error;
    if (isAbort(error)) throw new FeedError(caller?.aborted === true ? "cancelled" : "timeout");
    throw new FeedError("network");
  } finally {
    try {
      reader?.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/**
 * Re-authenticate metadata this process already holds.
 *
 * Used on restart. The stored bytes and signature go through the SAME pinned
 * key and the SAME strict parser as a fresh fetch, so a candidate left by an
 * earlier run derives its build, size, digest and URL from a re-verified
 * manifest — never from plain journal fields, which an attacker with local
 * write access can choose.
 */
export function verifySignedMetadata(
  trust: UpdateTrust,
  metadata: Uint8Array,
  signature: string,
): UpdateManifest {
  try {
    assertSignedByPin(metadata, decodeSignature(signature), trust);
  } catch (error) {
    throw new FeedError("untrusted", null, error instanceof TrustError ? error.code : null);
  }
  try {
    return parseManifest(metadata, trust, signature);
  } catch (error) {
    throw new FeedError("malformed", null, (error as { code?: string })?.code ?? null);
  }
}

/**
 * Read and verify the feed.
 *
 * Returns the manifest, or throws a `FeedError`. `untrusted` is terminal: the
 * caller must not retry it, must not fetch over another route, and must not ask
 * the user whether to proceed anyway.
 */
export async function readFeed(
  trust: UpdateTrust,
  options: FeedOptions = {},
  signal?: AbortSignal,
): Promise<UpdateManifest> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FEED_TIMEOUT_MS;
  // The signature first, so a metadata document is never even held without
  // something to check it against.
  const signatureBytes = await get(
    fetchImpl,
    trust.signatureUrl,
    MAX_SIGNATURE_BYTES,
    timeoutMs,
    signal,
  );
  const metadata = await get(fetchImpl, trust.feedUrl, MAX_MANIFEST_BYTES, timeoutMs, signal);
  const encoded = new TextDecoder().decode(signatureBytes).trim();
  try {
    // EXACT BYTES, before any decode.
    assertSignedByPin(metadata, decodeSignature(encoded), trust);
  } catch (error) {
    throw new FeedError("untrusted", null, error instanceof TrustError ? error.code : null);
  }
  try {
    return parseManifest(metadata, trust, encoded);
  } catch (error) {
    throw new FeedError("malformed", null, (error as { code?: string })?.code ?? null);
  }
}
