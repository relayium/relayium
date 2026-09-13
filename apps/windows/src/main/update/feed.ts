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
import { boundedGet, HttpError } from "../net/bounded-get.js";

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

/**
 * The transport, shared with everything else that reads a document off the
 * network. See `../net/bounded-get.ts`.
 *
 * Wrapped rather than used directly so this module's taxonomy does not move:
 * every `FeedFailure` a caller could already see, it still sees, with the same
 * status and detail. `untrusted` is this module's own and never comes from
 * here — a transport cannot tell you a signature is wrong.
 */
export interface FeedOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

async function get(
  fetchImpl: typeof fetch,
  url: string,
  max: number,
  timeoutMs: number,
  caller: AbortSignal | undefined,
): Promise<Uint8Array> {
  try {
    return await boundedGet(fetchImpl, url, max, timeoutMs, caller);
  } catch (error) {
    if (error instanceof HttpError) throw new FeedError(error.code, error.status, error.detail);
    throw new FeedError("network");
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
