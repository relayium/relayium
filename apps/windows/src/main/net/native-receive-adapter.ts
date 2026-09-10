// The boundary between "bytes arrived" and "the file is saved".
//
// ## Two implementations, and which one ships
//
// `NativeHelperDestination` wraps the accepted `NativeHelperClient` and is the
// PRODUCTION path: a real child process with Win32 no-replace primitives behind
// it. `LeaseReceiveAdapter` wraps `ReceiveLease`, whose `publish()` refuses — it
// stages bytes and cannot move them to their final names.
//
// The lease adapter is deliberately NOT a fallback. A build that quietly used it
// when the helper failed to spawn would stage a whole transfer and then report a
// save it never performed. It is reachable only by explicit injection (tests)
// and on the non-Windows path, where it exists to REFUSE truthfully rather than
// to substitute.
//
// ## The one thing this boundary exists to make unlie-able
//
// Publication is a separate, terminal, explicitly-reported step. Every other
// arrangement makes the same mistake somewhere else: a `close()` that resolves
// when the last chunk is written means "ciphertext transferred", and a UI that
// renders it as "saved" is claiming something no code has done. The user's
// chosen filenames do not exist until `publish` says they do.
//
// ## Errors do not survive IPC, so failures are not sent as errors
//
// Electron serialises a rejection by its message and drops every custom
// property. `NativeHelperError` carries three things a person acts on — a stable
// code, whether bytes were left on disk, and the receipt when publication
// succeeded and only cleanup failed — and all three would arrive as prose. So
// `publish()` RESOLVES with a `PublishReport` that has a `failed` variant, and
// the mapping happens here, where the typed error still exists.

import type { PublishFailureReason, PublishReport } from "../../shared/ipc-contract.js";
import { ReceiveLease, ReceiveLeaseError, type LeasePublisher } from "../io/receive-lease.js";
import {
  NativeHelperClient,
  NativeHelperError,
  type NativeHelperClientOptions,
  type NativePublishReport,
  type NativeReceiveDestination,
} from "../io/native-helper-client.js";

/**
 * The operations a receive destination must be able to perform.
 *
 * Indices, never paths: the caller refers to files by their position in the
 * manifest already validated. That is what makes a compromised renderer unable
 * to name a destination, and it is preserved verbatim across this boundary.
 */
export interface NativeReceiveAdapter {
  readonly fileCount: number;
  /** Refuse if this destination does not belong to the named authority. Belt
   *  and braces against the caller's own bookkeeping. */
  assertAuthority(authorityId: string): void;
  begin(index: number): Promise<void>;
  write(index: number, chunk: Uint8Array): Promise<void>;
  finish(index: number): Promise<void>;
  /**
   * Move the staged batch to the user's chosen names.
   *
   * The ONLY operation whose success means "saved". Always RESOLVES — with a
   * receipt, a truthful `partial`, or a typed `failed`.
   */
  publish(): Promise<PublishReport>;
  /** Terminal and idempotent. REJECTS when cleanup could not be confirmed, so a
   *  caller cannot mistake residue for a clean teardown. */
  cancel(): Promise<void>;
}

/** The helper's codes, narrowed to the sentences this product can show. The
 *  helper's own message is never forwarded — it can contain a path. */
const FAILURE_BY_CODE: Record<string, PublishFailureReason> = {
  "helper-unavailable": "helper-unavailable",
  "helper-timeout": "timeout",
  protocol: "internal",
  busy: "internal",
  cancelled: "cancelled",
  "manifest-refused": "internal",
  "authority-changed": "internal",
  "length-exceeded": "io-failed",
  "length-short": "io-failed",
  "short-write": "io-failed",
  "publish-failed": "io-failed",
  "cleanup-uncertain": "cleanup-uncertain",
  residue: "cleanup-uncertain",
  "io-failed": "io-failed",
  internal: "internal",
};

const toReport = (native: NativePublishReport): PublishReport =>
  native.status === "complete"
    ? { status: "complete", publishedCount: native.publishedCount, total: native.total }
    : {
        status: "partial",
        publishedCount: native.publishedCount,
        total: native.total,
        failedIndex: native.failedIndex,
        reason: native.reason,
      };

/** The production destination. */
export class NativeHelperDestination implements NativeReceiveAdapter {
  constructor(private readonly client: NativeReceiveDestination) {}

  static async open(options: NativeHelperClientOptions): Promise<NativeHelperDestination> {
    return new NativeHelperDestination(await NativeHelperClient.open(options));
  }

  get fileCount(): number {
    return this.client.fileCount;
  }

  assertAuthority(authorityId: string): void {
    this.client.assertAuthority(authorityId);
  }

  begin(index: number): Promise<void> {
    return this.client.begin(index);
  }

  write(index: number, chunk: Uint8Array): Promise<void> {
    return this.client.write(index, chunk);
  }

  finish(index: number): Promise<void> {
    return this.client.finish(index);
  }

  async publish(): Promise<PublishReport> {
    try {
      return toReport(await this.client.publish());
    } catch (err) {
      return describeFailure(err);
    }
  }

  cancel(): Promise<void> {
    // Deliberately propagated. `cancel` rejecting is how the helper reports a
    // teardown that may have left bytes behind, and swallowing it here would be
    // the silent loss this whole path exists to prevent.
    return this.client.cancel();
  }
}

/**
 * The portable destination. Stages truthfully; cannot publish.
 *
 * Reachable by explicit injection and on the non-Windows path. Never a fallback
 * for a helper that failed to start — see the header.
 */
export class LeaseReceiveAdapter implements NativeReceiveAdapter {
  constructor(
    private readonly lease: ReceiveLease,
    /** Only ever supplied by a test exercising publication itself. */
    private readonly publisher?: LeasePublisher,
  ) {}

  get fileCount(): number {
    return this.lease.files.length;
  }

  assertAuthority(authorityId: string): void {
    this.lease.assertAuthority(authorityId);
  }

  async begin(index: number): Promise<void> {
    await this.lease.beginFile(index);
  }

  async write(index: number, chunk: Uint8Array): Promise<void> {
    await this.lease.writeChunk(index, chunk);
  }

  async finish(index: number): Promise<void> {
    await this.lease.finishFile(index);
  }

  async publish(): Promise<PublishReport> {
    try {
      // `close()` is the completeness check — every planned file staged, none
      // still open — and it is deliberately separate from publication.
      const staged = await this.lease.close();
      const published = await this.lease.publish(this.publisher);
      if (published.length === staged.length) {
        return { status: "complete", publishedCount: published.length, total: staged.length };
      }
      return {
        status: "partial",
        publishedCount: published.length,
        total: staged.length,
        failedIndex: published.length,
        reason: "publish-stopped",
      };
    } catch (err) {
      // `publish-unsupported` is this adapter's honest answer, surfaced as a
      // named failure and never softened into a `partial` — which would claim
      // some files WERE written under their final names.
      if (err instanceof ReceiveLeaseError && err.code === "publish-unsupported") {
        return { status: "failed", reason: "unsupported", residue: true };
      }
      return describeFailure(err);
    }
  }

  async cancel(): Promise<void> {
    await this.lease.cancel();
  }
}

/**
 * Turn a thrown failure into something that survives IPC.
 *
 * `residue` defaults to TRUE for anything unrecognised. An unknown failure is
 * precisely the case where this process cannot say the user's folder is clean,
 * and defaulting to `false` would be a guess dressed as a fact.
 */
export function describeFailure(err: unknown): PublishReport {
  if (err instanceof NativeHelperError) {
    const published = err.publishReport;
    return {
      status: "failed",
      reason: FAILURE_BY_CODE[err.code] ?? "internal",
      residue: err.residue,
      // Preserved: those files exist under their final names, and an error
      // about cleanup must not report them as unsaved.
      ...(published
        ? { published: { publishedCount: published.publishedCount, total: published.total } }
        : {}),
    };
  }
  return { status: "failed", reason: "internal", residue: true };
}

export { ReceiveLeaseError, NativeHelperError };
export type { NativeReceiveDestination };
