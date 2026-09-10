// Downloading the installer into staging this app owns, and hashing it as it
// arrives.
//
// ## The host allowlist is EXACT, and it is not the fleet's
//
// A release asset is served with a 302 from `github.com` to a separate download
// host, so refusing every redirect would make the artifact unfetchable. Each
// hop is therefore judged against exact hostnames from `trust.ts` — not a
// suffix. `*.githubusercontent.com` would admit any subdomain anybody can be
// given, and this is an EXECUTABLE, not opaque ciphertext that fails an AEAD
// check when it is wrong.
//
// `src/main/stored/transport.ts`'s allowlist is deliberately not reused: it
// admits a whole suffix because a fleet node is any host under it. Sharing that
// list would silently widen what may hand this app an executable.
//
// ## Staging is held, and the file is created through a receipt
//
// This module no longer composes a path or opens one. It is handed a
// `StagingScope` — a staging directory the caller holds and that refuses to be
// a redirected one — and asks it for exclusive custody of the single derived
// name. Two consequences, both of which were defects before:
//
//   * a refused exclusive create means the name was ALREADY TAKEN, so this
//     download owns nothing at that name and the failure carries no receipt.
//     The caller must not delete what it never created.
//   * a create that succeeded carries its receipt out with the failure, so the
//     caller retires the exact object this download made — the same ownership
//     discipline the receive path's cleanup registry follows.

import { createHash } from "node:crypto";

import type { OwnedFile, StagingScope } from "./custody.js";
import type { UpdateManifest } from "./manifest.js";
import { stagedFileName, type StagedIdentity } from "./staging.js";
import type { UpdateTrust } from "./trust.js";

/** Central -> asset host is one hop. Two leaves room for a deployment that adds
 *  a rewrite without letting a loop run. */
export const MAX_ARTIFACT_HOPS = 2;
/** No byte may go more than this long without arriving. Not a whole-transfer
 *  deadline, which would kill a legitimately slow download. */
export const DEFAULT_STALL_MS = 60_000;

export type ArtifactFailure =
  | "network"
  | "timeout"
  | "cancelled"
  | "http"
  /** A redirect this build will not follow. `detail` names the refused host so
   *  the pin can be extended from evidence rather than from a guess. */
  | "untrusted-host"
  | "redirect"
  /** More bytes than the signed manifest declared. */
  | "too-large"
  /** Fewer bytes than declared, or a hash that does not match. */
  | "integrity"
  | "staging";

export class ArtifactError extends Error {
  constructor(
    readonly code: ArtifactFailure,
    readonly status: number | null = null,
    readonly detail: string | null = null,
  ) {
    super(detail === null ? code : `${code}: ${detail}`);
    this.name = "ArtifactError";
  }
  get retryable(): boolean {
    if (this.code === "network" || this.code === "timeout") return true;
    if (this.code !== "http" || this.status === null) return false;
    return this.status === 429 || this.status >= 500;
  }
}

export type HopVerdict =
  | { readonly follow: true; readonly url: string }
  | { readonly follow: false; readonly reason: string; readonly host: string | null };

export const isRedirectStatus = (status: number): boolean =>
  status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

/**
 * Whether a redirect may be followed, and to where.
 *
 * Pure and exported so the boundary is testable without a socket. EXACT host
 * membership, https only, no userinfo, no fragment, no non-default port, no
 * repeats, bounded hops. A refusal names the host it refused.
 */
export function hopVerdict(input: {
  readonly current: string;
  readonly location: string | null;
  readonly hosts: readonly string[];
  readonly hop: number;
  readonly visited: ReadonlySet<string>;
}): HopVerdict {
  if (input.hop >= MAX_ARTIFACT_HOPS) return { follow: false, reason: "too-many-hops", host: null };
  const raw = input.location?.trim();
  if (raw === undefined || raw.length === 0) return { follow: false, reason: "no-location", host: null };
  let target: URL;
  try {
    target = new URL(raw, input.current);
  } catch {
    return { follow: false, reason: "unparseable", host: null };
  }
  const host = target.hostname.toLowerCase();
  if (target.protocol !== "https:") return { follow: false, reason: "insecure-scheme", host };
  if (target.username !== "" || target.password !== "") {
    return { follow: false, reason: "userinfo", host };
  }
  if (target.hash !== "") return { follow: false, reason: "fragment", host };
  if (target.port !== "" && target.port !== "443") return { follow: false, reason: "port", host };
  // EXACT membership. A suffix test here would admit any subdomain of a shared
  // hosting domain.
  if (!input.hosts.includes(host)) return { follow: false, reason: "untrusted-host", host };
  const url = target.toString();
  if (input.visited.has(url)) return { follow: false, reason: "loop", host };
  return { follow: true, url };
}

/** Where the artifact landed, and what it is. The receipt is the ownership. */
export interface StagedArtifact {
  readonly custody: OwnedFile;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * A download that failed, plus whatever custody it actually holds.
 *
 * `custody` is null when the exclusive create never succeeded — the decisive
 * case: there is a file at that name, this process did not make it, and nothing
 * may delete it. When custody IS held the partial file is still not deleted
 * here; the caller decides, because only the caller knows whether a durable
 * claim also has to be cleared.
 */
export class ArtifactDownloadFailed extends Error {
  constructor(
    override readonly cause: ArtifactError,
    readonly custody: OwnedFile | null,
    /**
     * Identity of an object the create made before the capability refused.
     *
     * The narrow case where a file exists and this download owns NEITHER a
     * usable handle nor a trustworthy directory. It is not deleted — that is the
     * position where a delete lands somewhere unknown — so the caller records it
     * as uncertain residue.
     */
    readonly orphan: string | null = null,
  ) {
    super(cause.message);
    this.name = "ArtifactDownloadFailed";
  }
}

export interface ArtifactOptions {
  readonly fetchImpl?: typeof fetch;
  readonly stallMs?: number;
  /**
   * How many bytes have been SUCCESSFULLY WRITTEN, so far.
   *
   * Called only after a `custody.write` has returned, never on receipt from the
   * network: a chunk that arrived and was not written is not progress, and
   * reporting it would let a stalled disk look like a moving download.
   *
   * "Written" means the write returned — handed to the OS — and NOT that the
   * bytes survive a power loss. `sync()` runs once, after the final hash, so
   * every count reported before then describes data that is still only as
   * durable as the filesystem cache. A caller must not present this as bytes
   * safely stored.
   *
   * It is a count and nothing more. It says nothing about integrity — the hash
   * is compared at the end — and nothing about completion; a download that
   * reaches the declared length can still fail on its digest. A caller that
   * treated the final call as success would be verifying nothing.
   *
   * Monotonic and never past `manifest.artifactBytes`, because the ceiling is
   * checked before the write that a report follows.
   *
   * A throw here cannot fail the download. The observer is told what happened;
   * it does not get a say in whether it happened.
   */
  readonly onProgress?: (writtenBytes: number) => void;
}

/**
 * Hand the observer a number, and let nothing it does matter.
 *
 * A listener that throws must not fail a download, skip the cleanup that owns
 * the bytes, or change what is verified. Swallowing here is the whole point.
 */
function report(observer: ((written: number) => void) | undefined, written: number): void {
  if (observer === undefined) return;
  try {
    observer(written);
  } catch {
    /* an observer's failure is the observer's */
  }
}

const isAbort = (error: unknown): boolean => {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
};

/**
 * Fetch the artifact into the held scope, streaming a SHA-256 as it goes.
 *
 * The manifest is the authority on both the length and the hash, and the
 * manifest was signed — so the ceiling here is not a guess and the comparison
 * at the end is not against something the server also chose. A body that runs
 * long is cut mid-flight; a body that stops short fails at the end.
 */
export async function downloadArtifact(
  manifest: UpdateManifest,
  trust: UpdateTrust,
  scope: StagingScope,
  identity: StagedIdentity,
  /**
   * Called once the exclusive create has RETURNED and before a byte is written.
   *
   * This is where the caller makes its ownership durable. It runs here rather
   * than after the download because a crash in between must leave a record that
   * says "created", not one that says "intended to create" — the two are
   * identical on disk otherwise. A rejection aborts the download and the file
   * is handed back with the failure.
   */
  onHeld: (receipt: string) => Promise<void>,
  options: ArtifactOptions = {},
  signal?: AbortSignal,
): Promise<StagedArtifact> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) throw new ArtifactDownloadFailed(new ArtifactError("cancelled"), null);
    signal.addEventListener("abort", onAbort, { once: true });
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
    }, stallMs);
  };
  const release = (): void => {
    clearStall();
    if (signal) signal.removeEventListener("abort", onAbort);
  };
  const fault = (error: unknown, status: number | null = null): ArtifactError => {
    if (error instanceof ArtifactError) return error;
    if (isAbort(error)) {
      if (stalled) return new ArtifactError("timeout");
      return new ArtifactError(signal?.aborted === true ? "cancelled" : "timeout");
    }
    return new ArtifactError("network", status);
  };

  // The name is derived from the caller's identity by the one function that
  // derives names — a server-chosen filename is a server-chosen path component,
  // and the nonce in that identity is what makes the name this run's alone.
  let custody: OwnedFile | null = null;
  let orphan: string | null = null;

  try {
    try {
      // Exclusive: nothing pre-existing is opened, followed or truncated. A
      // refusal here means the name is not ours, and `custody` stays null.
      custody = await scope.createExclusive(stagedFileName(identity));
    } catch (error) {
      // A create that succeeded and was THEN refused hands back the identity of
      // what it made, so the caller can keep it rather than delete it.
      orphan = (error as { receipt?: string | null } | null)?.receipt ?? null;
      throw new ArtifactError(
        "staging",
        null,
        (error as { code?: string } | null)?.code ?? "open",
      );
    }
    // The receipt is recorded before anything is written into the file. A
    // failure here is a STAGING failure, not a network one: the caller's
    // ownership record is what could not be made durable.
    try {
      await onHeld(custody.receipt);
    } catch (error) {
      throw new ArtifactError("staging", null, (error as { code?: string } | null)?.code ?? "receipt");
    }

    let url = manifest.artifactUrl;
    const visited = new Set<string>([url]);
    let response: Response;
    for (let hop = 0; ; hop += 1) {
      armStall();
      try {
        response = await fetchImpl(url, {
          method: "GET",
          // No credential of any kind. A release asset is public, and a bearer
          // on a redirect chain is a credential handed to whoever answered.
          headers: { accept: "application/octet-stream" },
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        throw fault(error);
      }
      clearStall();
      if (!isRedirectStatus(response.status)) break;
      await response.body?.cancel().catch(() => undefined);
      const verdict = hopVerdict({
        current: url,
        location: response.headers.get("location"),
        hosts: trust.artifactHosts,
        hop,
        visited,
      });
      if (!verdict.follow) {
        throw new ArtifactError(
          verdict.reason === "untrusted-host" ? "untrusted-host" : "redirect",
          null,
          verdict.host ?? verdict.reason,
        );
      }
      visited.add(verdict.url);
      url = verdict.url;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ArtifactError("http", response.status);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > manifest.artifactBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ArtifactError("too-large");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ArtifactError("network", null, "no body");

    const digest = createHash("sha256");
    let received = 0;
    try {
      for (;;) {
        armStall();
        const { done, value } = await reader.read();
        clearStall();
        if (signal?.aborted === true) throw new ArtifactError("cancelled");
        if (done) break;
        if (value === undefined || value.byteLength === 0) continue;
        received += value.byteLength;
        if (received > manifest.artifactBytes) throw new ArtifactError("too-large");
        digest.update(value);
        await custody.write(value);
        // AFTER the write, and only then. Also after the ceiling check above,
        // so a report can never exceed the signed length.
        report(options.onProgress, received);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw fault(error);
    }
    // A short body is an integrity failure, not a network one: the signed
    // manifest said how long it would be.
    if (received !== manifest.artifactBytes) {
      throw new ArtifactError("integrity", null, "short");
    }
    const sha256 = digest.digest("hex");
    if (sha256 !== manifest.artifactSha256) throw new ArtifactError("integrity", null, "hash");
    // Flushed before anyone is told it is there.
    await custody.sync();
    return { custody, path: custody.path, bytes: received, sha256 };
  } catch (error) {
    throw new ArtifactDownloadFailed(fault(error), custody, orphan);
  } finally {
    release();
    // The handle is released either way; the RECEIPT is not, so a failed
    // download's file can still be discarded by the caller that owns it.
    await custody?.close();
  }
}
