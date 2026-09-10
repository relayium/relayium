// The boundary between "bytes arrived" and "the file is saved".
//
// ## Why this is an interface and not an implementation
//
// `apps/windows/native/**` belongs to the native-core lane, and its wire schema
// is live but not accepted. Nothing here reads, imports or edits it. What this
// file does is fix the SHAPE of the boundary — deliberately the same five
// operations the helper already speaks (`open`/`begin`/`finish`/`publish`/
// `cancel`, plus chunk frames) — so root can swap the accepted helper in behind
// it without reshaping either side.
//
// ## The one thing this boundary exists to make unlie-able
//
// Publication is a separate, terminal, explicitly-reported step. Every other
// arrangement makes the same mistake in a different place: a `close()` that
// resolves when the last chunk is written means "ciphertext transferred", and a
// UI that renders it as "saved" is claiming something no code has done. The
// user's chosen filenames do not exist until `publish` says they do.
//
// `partial` is why the report is a value rather than a boolean. The helper
// publishes in manifest order and stops at the first conflict, so some files can
// genuinely exist under their final names while the rest never will. Reporting
// that as success or as failure is a lie in one direction or the other, so it is
// neither.

import type { PublishReport } from "../../shared/ipc-contract.js";
import { ReceiveLease, ReceiveLeaseError, type LeasePublisher } from "../io/receive-lease.js";

/**
 * The operations a receive destination must be able to perform.
 *
 * Indices, never paths: the caller refers to files by their position in the
 * manifest the lease already validated. That is the property that makes a
 * compromised renderer unable to name a destination, and it is preserved
 * verbatim across this boundary.
 */
export interface NativeReceiveAdapter {
  /** How many files this destination is holding open. */
  readonly fileCount: number;
  /**
   * Refuse if this destination does not belong to the named authority.
   *
   * Belt and braces against the caller's own bookkeeping: the service looks a
   * lease up in its map and then asks the LEASE whether it agrees. A map that
   * had drifted — an id reused, an entry re-registered under a rotated epoch —
   * is caught here rather than silently driving one transfer's handle under
   * another's identity. Carried across this boundary unchanged from the
   * accepted foundation.
   */
  assertAuthority(authorityId: string): void;
  begin(index: number): Promise<void>;
  /** Returns bytes the OS accepted — never the count the sender declared. */
  write(index: number, chunk: Uint8Array): Promise<void>;
  finish(index: number): Promise<void>;
  /**
   * Move the staged batch to the user's chosen names.
   *
   * The ONLY operation whose success means "saved". Resolves with a truthful
   * report; a `partial` is a resolution, not a rejection, because the caller
   * has to render the count.
   */
  publish(): Promise<PublishReport>;
  /** Terminal, idempotent, and reachable from every abandonment path. */
  cancel(): Promise<void>;
}

/**
 * Today's implementation: staging is real, publication is not.
 *
 * `ReceiveLease.publish()` rejects with `publish-unsupported` unless it is given
 * a publisher backed by real Win32 no-replace primitives, and none ships yet.
 * That refusal is surfaced as a refusal — it is never rendered as a save, and it
 * is never softened into a `partial` (which would claim some files WERE
 * published). An honest "this build cannot complete the save" is the correct
 * interim behaviour and the whole reason the report type is explicit.
 *
 * This is interim. Full native publication remains owed by the wider task; root
 * integrates the accepted helper behind this same interface.
 */
export class LeaseReceiveAdapter implements NativeReceiveAdapter {
  constructor(
    private readonly lease: ReceiveLease,
    /** Supplied once the native helper is integrated. Absent today. */
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
    // `close()` is the completeness check — every planned file staged, none
    // still open — and it is deliberately separate from publication. A lease
    // that stopped early fails here rather than publishing a short batch.
    const staged = await this.lease.close();
    const published = await this.lease.publish(this.publisher);
    if (published.length === staged.length) {
      return { status: "complete", publishedCount: published.length, total: staged.length };
    }
    // A publisher that stopped short. The count is what it actually wrote, and
    // the failing index is the next one in manifest order.
    return {
      status: "partial",
      publishedCount: published.length,
      total: staged.length,
      failedIndex: published.length,
      reason: "publish-stopped",
    };
  }

  async cancel(): Promise<void> {
    await this.lease.cancel();
  }
}

export { ReceiveLeaseError };
