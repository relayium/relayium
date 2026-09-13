// Who owns an incoming batch, and what ends it.
//
// ## The gap this fills
//
// `FileSink` has `write` and `close` and **no `abort`**. The shipping file
// session was written for a browser, where an abandoned download is the
// browser's problem. Here the bytes go through a privileged lease holding an
// open handle and a staging directory in a folder the user chose, so somebody
// has to be able to say "stop, and clean up" — and there is no method on the
// sink that means that.
//
// ## What ends a receive, and what deliberately does not
//
// Ends it: an explicit cancel, a declined batch, THIS batch's peer
// disconnecting, the link it belongs to being replaced or torn down, the user
// leaving the room, document revocation (reload or crash), and quit.
//
// Does **not** end it: hiding the window, minimising, losing focus, closing to
// tray — or an unrelated peer leaving the roster. A coordinator is bound to one
// peer and one link generation for exactly that reason.
//
// ## Three things this got wrong before, all reproduced
//
//   1. **A cleanup rejection resolved clean.** `cancel()` swallowed the lease's
//      failure, so a teardown that could not remove the user's staged bytes
//      reported success. Cleanup failures are now typed and propagated.
//   2. **`cancel()` settled while the picker was still open.** The lease did not
//      exist yet, so there was nothing to cancel and the promise resolved
//      immediately — then the picker returned and installed a live lease into a
//      room that was already gone. `cancel()` now JOINS the in-flight open.
//   3. **`file()` ignored the name and size it was given** and handed back the
//      next index regardless, so a manifest disagreement would write one file's
//      bytes under another's name. It is checked.

import type { FileSink, SaveTarget } from "../../../../../web/src/lib/filesink";
import type { PublishFailureReason, PublishReport } from "../../shared/ipc-contract.js";

/** The privileged half, as the renderer sees it. */
export interface ReceiveBridge {
  open(payload: {
    manifest: readonly { name: string; size: number }[];
    authority: "direct" | "account";
  }): Promise<{ cancelled: true } | { leaseId: string; files: number }>;
  begin(payload: { leaseId: string; index: number }): Promise<unknown>;
  write(payload: { leaseId: string; index: number; chunk: Uint8Array }): Promise<unknown>;
  finish(payload: { leaseId: string; index: number }): Promise<unknown>;
  publish(payload: { leaseId: string }): Promise<PublishReport>;
  cancel(payload: { leaseId: string }): Promise<unknown>;
}

export interface FileMetaLike {
  readonly name: string;
  readonly size: number;
}

/** The user closed the folder picker. A choice, not a failure. */
export class ReceiveCancelledError extends Error {
  constructor() {
    super("receive-cancelled");
    this.name = "ReceiveCancelledError";
  }
}

/** The batch did not match the manifest this lease was opened for. */
export class ManifestMismatchError extends Error {
  constructor(readonly index: number, readonly detail: string) {
    super(`manifest mismatch at ${index}: ${detail}`);
    this.name = "ManifestMismatchError";
  }
}

/**
 * Cleanup did not finish. Carries what was being cleaned up, because the whole
 * point is that bytes may still be in the user's folder.
 */
export class ReceiveCleanupError extends Error {
  constructor(readonly leaseId: string, override readonly cause: unknown) {
    super(`could not clean up receive ${leaseId}`);
    this.name = "ReceiveCleanupError";
  }
}

/**
 * Publication did not produce a complete receipt.
 *
 * Carries the counts when there are any: a `partial` genuinely wrote some files
 * under their final names, and a `failed` that happened AFTER a successful
 * publish still has a receipt to preserve. Reporting either as "nothing was
 * saved" is the lie this type exists to prevent.
 */
export class PartialPublicationError extends Error {
  constructor(
    readonly publishedCount: number,
    readonly total: number,
    /** The union, not a widened `string`: `PublishReport` already carries it
     *  as one, and widening here is what let the screen's map drift from it. */
    readonly reason: PublishFailureReason,
    /** Bytes may remain in the user's folder. */
    readonly residue: boolean = false,
  ) {
    super(`published ${publishedCount} of ${total}`);
    this.name = "PartialPublicationError";
  }
}

/** Where this coordinator has got to. The owner retires it on `done`. */
export type ReceivePhase = "idle" | "opening" | "receiving" | "publishing" | "done" | "failed";

export class ReceiveCoordinator {
  readonly peerId: string;
  /** The link generation this batch belongs to. A later link is a different
   *  connection, and a batch cannot span one. */
  readonly linkGeneration: number;

  #bridge: ReceiveBridge;
  #manifest: readonly FileMetaLike[] = [];
  #leaseId: string | null = null;
  #cancelled = false;
  #cancellation: Promise<void> | null = null;
  /** The in-flight `open`, so `cancel` can join a picker that has not returned. */
  #opening: Promise<{ cancelled: true } | { leaseId: string; files: number }> | null = null;
  #nextIndex = 0;
  #phase: ReceivePhase = "idle";

  constructor(bridge: ReceiveBridge, peerId: string, linkGeneration: number) {
    this.#bridge = bridge;
    this.peerId = peerId;
    this.linkGeneration = linkGeneration;
  }

  get phase(): ReceivePhase {
    return this.#phase;
  }

  /** True once this coordinator can never do anything again — the owner drops
   *  it. `failed` is NOT terminal for ownership: its cleanup may still be
   *  running, and it stays held until that settles. */
  get retired(): boolean {
    return this.#phase === "done";
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  get leaseId(): string | null {
    return this.#leaseId;
  }

  /**
   * Open the folder picker and build the target for this batch.
   *
   * `authority: "direct"` — a LAN or pairing transfer has no account in it, so
   * it must not require a readable secret store or be cancelled by a sign-in.
   */
  async open(files: readonly FileMetaLike[]): Promise<SaveTarget> {
    if (this.#cancelled) throw new ReceiveCancelledError();
    this.#manifest = files.map((f) => ({ name: f.name, size: f.size }));
    this.#phase = "opening";

    // Registered BEFORE the await, so a cancel arriving while the user is
    // looking at the dialog has something to join rather than resolving into
    // the gap where no lease exists yet.
    const opening = this.#bridge.open({
      manifest: this.#manifest.map((f) => ({ name: f.name, size: f.size })),
      authority: "direct",
    });
    this.#opening = opening;

    let opened: Awaited<typeof opening>;
    try {
      opened = await opening;
    } finally {
      this.#opening = null;
    }

    if ("cancelled" in opened) {
      this.#phase = "done";
      throw new ReceiveCancelledError();
    }
    // A cancel that arrived while the picker was open owns this lease now; it
    // is joining `#opening` and will cancel whatever it produced.
    if (this.#cancelled) {
      this.#leaseId = opened.leaseId;
      throw new ReceiveCancelledError();
    }

    this.#leaseId = opened.leaseId;
    this.#phase = "receiving";
    return this.#target();
  }

  #target(): SaveTarget {
    return {
      label: "the folder you chose",
      // Load-bearing. The helper publishes the batch at `done`, so nothing
      // reaches the user's chosen names until then — and `bundled` is what makes
      // "saved N of M" honest instead of claiming per-file delivery.
      bundled: true,
      // `delivery` stays at the conservative default until publication is
      // genuinely the native helper's. Claiming `localCommit` while `publish`
      // still refuses would be the most misleading field in this object.
      file: (name: string, size: number) => this.#file(name, size),
      done: () => this.#done(),
    };
  }

  /**
   * One sink, for the file the manifest says comes next.
   *
   * The name and size are CHECKED rather than ignored. The lease validated and
   * planned destination names from the manifest it was opened with and now
   * refers to them by index — so if the sender's batch and that manifest ever
   * disagree, an unchecked index writes one file's bytes into another file's
   * planned name. Nothing downstream would notice: the sizes are enforced
   * per-index by the lease, and the user would get a correctly-sized file with
   * the wrong contents under a name they recognise.
   */
  async #file(name: string, size: number): Promise<FileSink> {
    const leaseId = this.#requireLease();
    const index = this.#nextIndex;
    const expected = this.#manifest[index];
    if (!expected) {
      throw new ManifestMismatchError(index, `manifest has ${this.#manifest.length} file(s)`);
    }
    if (expected.name !== name || expected.size !== size) {
      throw new ManifestMismatchError(
        index,
        `expected ${JSON.stringify(expected.name)} (${expected.size}B)`,
      );
    }
    this.#nextIndex += 1;

    await this.#guarded(() => this.#bridge.begin({ leaseId, index }));
    let closed = false;
    return {
      write: async (chunk: Uint8Array) => {
        if (closed) throw new Error("write after close");
        await this.#guarded(() => this.#bridge.write({ leaseId, index, chunk }));
      },
      // `close` means STAGED, never saved. Publication is a separate step.
      close: async () => {
        if (closed) return;
        closed = true;
        await this.#guarded(() => this.#bridge.finish({ leaseId, index }));
      },
    };
  }

  /**
   * The terminal step, and the only one that means "saved".
   *
   * Resolves only on `complete`. A `partial` REJECTS carrying the truthful
   * count — some files genuinely exist under their final names and the rest
   * never will, and reporting that as either outcome is a lie in one direction.
   */
  async #done(): Promise<void> {
    const leaseId = this.#requireLease();
    this.#phase = "publishing";
    let report: PublishReport;
    try {
      report = await this.#bridge.publish({ leaseId });
    } catch (err) {
      // Main retired the lease whatever happened, so there is nothing left here
      // to cancel; it also ran its own cleanup and records any residue.
      this.#leaseId = null;
      this.#phase = "failed";
      throw err;
    }
    // Main forgets the lease whatever the outcome, so nothing may cancel it now.
    this.#leaseId = null;
    if (report.status === "complete") {
      this.#phase = "done";
      return;
    }
    this.#phase = "failed";
    if (report.status === "partial") {
      throw new PartialPublicationError(report.publishedCount, report.total, report.reason);
    }
    // `failed` still carries a receipt when publication succeeded and only the
    // teardown after it did not.
    throw new PartialPublicationError(
      report.published?.publishedCount ?? 0,
      report.published?.total ?? 0,
      report.reason,
      report.residue,
    );
  }

  /**
   * Abandon this receive. Idempotent, and safe from every path.
   *
   * **Rejects** with `ReceiveCleanupError` when the staged bytes could not be
   * removed. It used to swallow that, which meant a teardown reporting success
   * over a folder it had left files in — the exact failure the lifetime rules
   * exist to make impossible. Callers that genuinely cannot act on it still
   * have to say so with a `.catch`, which is a decision rather than a default.
   *
   * Joins an in-flight picker rather than resolving past it. A cancel that
   * returned while `open` was still pending left the picker to install a live
   * lease into a room that no longer existed.
   */
  cancel(): Promise<void> {
    if (this.#cancellation) return this.#cancellation;
    this.#cancelled = true;
    this.#cancellation = (async () => {
      // The picker, if one is open. Its result — a lease id — is what has to be
      // cancelled, and it does not exist yet.
      const opening = this.#opening;
      if (opening) await opening.catch(() => undefined);

      const leaseId = this.#leaseId;
      this.#leaseId = null;
      if (!leaseId) {
        if (this.#phase !== "done") this.#phase = "done";
        return;
      }
      try {
        await this.#bridge.cancel({ leaseId });
        this.#phase = "done";
      } catch (err) {
        this.#phase = "failed";
        throw new ReceiveCleanupError(leaseId, err);
      }
    })();
    return this.#cancellation;
  }

  #requireLease(): string {
    if (this.#cancelled) throw new ReceiveCancelledError();
    const leaseId = this.#leaseId;
    if (!leaseId) throw new Error("no open receive");
    return leaseId;
  }

  /** Re-checks cancellation after the await, not only before it. */
  async #guarded<T>(body: () => Promise<T>): Promise<T> {
    if (this.#cancelled) throw new ReceiveCancelledError();
    const result = await body();
    if (this.#cancelled) throw new ReceiveCancelledError();
    return result;
  }
}
