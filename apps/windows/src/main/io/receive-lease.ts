// The privileged half of receiving files: one lease, one chosen folder.
//
// ## What a lease is
//
// A capability handle. The renderer never names a filesystem path — it opens a
// lease against a folder the *user* chose in a native dialog, and afterwards
// refers to files only by their index in the plan that lease already validated.
// A compromised renderer can ask to write the wrong file of a batch the user
// accepted; it cannot ask to write somewhere else, because no channel carries a
// destination.
//
// ## Staging is ORIGIN control, and it is not containment
//
// This distinction was previously stated wrongly here, so it is stated
// precisely now.
//
// What staging does: on `open`, the lease creates ONE directory it owns — a
// random name, created with `mkdir` so an existing entry is an error rather
// than something to reuse — and every file is written inside it under an
// opaque, index-derived name. During the whole streaming phase there is
// therefore no manifest-supplied path component on disk at all, so a junction,
// a symlink, a reserved device name or a case collision has no name to act on.
// The validated names are held in memory and applied only at publish. That is
// control over where names COME FROM.
//
// What staging does NOT do: contain writes to a directory tree. Every path here
// is a resolved STRING. The `realpath` check below is a check at one instant;
// afterwards the staging root and every one of its ancestors can be renamed or
// swapped by another process, and this code would keep writing through the
// swapped component without noticing. Real containment needs handle-relative
// opens against a pinned ancestor chain, which Node does not expose. Until the
// native helper lands (see DURABLE-PARITY.md), that exposure is present and
// unmitigated — not reduced by staging.
//
// ## Publish is deliberately NOT implemented here
//
// Moving the staged tree to its final names requires two guarantees Node's API
// cannot give on Windows: containment that survives a directory being swapped
// mid-operation, and a create-or-fail rename that cannot replace an existing
// file. `fs.rename` silently overwrites; an `lstat` check before it is a race,
// not a guarantee. Rather than ship that race behind a reassuring name,
// `publish()` refuses unless a publisher backed by real Win32 primitives is
// supplied, and none is in this slice. The staged bytes are complete, verified
// and enumerable; what is missing is stated as missing. See DURABLE-PARITY.md.

import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { planManifest, type ManifestEntry, type PlannedFile } from "./plan.js";

/** Above the 192 KiB wire chunk plus its framing, and far below "unbounded". */
export const MAX_CHUNK_BYTES = 256 * 1024;

export type LeaseError =
  | "root-missing"
  | "root-not-directory"
  | "root-not-canonical"
  | "staging-unavailable"
  | "manifest-refused"
  | "authority-changed"
  | "lease-closed"
  | "busy"
  | "out-of-order"
  | "no-open-file"
  | "chunk-too-large"
  | "length-exceeded"
  | "length-short"
  | "short-write"
  | "incomplete"
  | "publish-unsupported"
  | "io-failed";

export class ReceiveLeaseError extends Error {
  constructor(readonly code: LeaseError, message?: string) {
    super(message ?? code);
    this.name = "ReceiveLeaseError";
  }
}

interface OpenFile {
  readonly index: number;
  readonly handle: FileHandle;
  readonly stagedPath: string;
  written: number;
}

export interface StagedFile {
  /** The validated destination components this file is FOR. Never yet on disk. */
  readonly segments: readonly string[];
  readonly stagedPath: string;
  readonly size: number;
}

/** A publisher able to move staged files to their final names with real
 *  no-replace, containment-checked Windows primitives. None ships in slice 1. */
export interface LeasePublisher {
  publish(root: string, staged: readonly StagedFile[]): Promise<readonly string[]>;
}

async function canonicalRoot(rootPath: string): Promise<string> {
  if (!isAbsolute(rootPath)) throw new ReceiveLeaseError("root-not-canonical");
  let real: string;
  try {
    real = await realpath(rootPath);
  } catch {
    throw new ReceiveLeaseError("root-missing");
  }
  const stats = await lstat(real).catch(() => null);
  if (!stats) throw new ReceiveLeaseError("root-missing");
  if (!stats.isDirectory()) throw new ReceiveLeaseError("root-not-directory");
  if (resolve(real) !== real) throw new ReceiveLeaseError("root-not-canonical");
  return real;
}

const contains = (root: string, child: string): boolean =>
  child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);

export class ReceiveLease {
  private current: OpenFile | null = null;
  private readonly staged: StagedFile[] = [];
  private nextIndex = 0;
  /** Set the instant cancellation is requested, before any await. Every
   *  operation re-reads it after each await, so an operation that was already
   *  running cannot publish state into a lease that is being torn down. */
  private cancelled = false;
  private closed = false;
  /** The WHOLE teardown, cached, so every caller of `cancel()` waits for the
   *  cleanup and not merely for the in-flight operation to unwind. */
  private cancellation: Promise<void> | null = null;
  /** Serialises the terminal operations against each other, so `publish` cannot
   *  run twice or race a cancel that is deleting the bytes it is publishing. */
  private terminal: Promise<unknown> | null = null;
  /** Serialises mutating operations. Two concurrent `writeChunk` calls could
   *  otherwise both pass the remaining-length check before either incremented
   *  the counter, and together write past the declared size. */
  private tail: Promise<unknown> = Promise.resolve();
  private inFlight = 0;

  private constructor(
    readonly id: string,
    readonly authorityId: string,
    private readonly root: string,
    private readonly stagingDirectory: string,
    readonly files: readonly PlannedFile[],
  ) {}

  static async open(args: {
    readonly id: string;
    readonly authorityId: string;
    readonly rootPath: string;
    readonly manifest: readonly ManifestEntry[];
  }): Promise<ReceiveLease> {
    const plan = planManifest(args.manifest);
    if (!plan.ok) {
      throw new ReceiveLeaseError("manifest-refused", `manifest refused: ${plan.failure.kind}`);
    }
    const root = await canonicalRoot(args.rootPath);

    // Created, never adopted: `mkdir` without `recursive` fails with EEXIST, so
    // this lease made this directory rather than reusing one that was already
    // there. That is a claim about ORIGIN, not about access — any process
    // running as this user can still open it, and the random name is not a
    // secret. What it buys is that no pre-existing junction, symlink or
    // hostile entry is adopted as the staging root.
    const staging = join(root, `.relayium-incoming-${randomBytes(12).toString("hex")}`);
    try {
      await mkdir(staging);
    } catch (err) {
      throw new ReceiveLeaseError("staging-unavailable", String((err as Error).message));
    }
    // A point-in-time check, not a containment guarantee: it proves the
    // directory just created is under the root AT THIS INSTANT and nothing
    // more. Everything else is written
    // inside this resolved path under names we generate.
    const realStaging = await realpath(staging);
    if (!contains(root, realStaging)) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw new ReceiveLeaseError("staging-unavailable", "staging escaped root");
    }
    return new ReceiveLease(args.id, args.authorityId, root, realStaging, plan.files);
  }

  assertAuthority(authorityId: string): void {
    if (authorityId !== this.authorityId) throw new ReceiveLeaseError("authority-changed");
  }

  /** Checked before an operation starts AND after every await inside one. */
  private assertLive(): void {
    if (this.cancelled || this.closed) throw new ReceiveLeaseError("lease-closed");
  }

  /**
   * Run `body` with exclusive ownership of the lease.
   *
   * Refusing overlap rather than queueing it: two overlapping writes on one file
   * have no correct order, and silently serialising them would let a caller with
   * a bug produce a file whose bytes are in an order nobody chose.
   */
  private async exclusive<T>(body: () => Promise<T>): Promise<T> {
    if (this.inFlight > 0) throw new ReceiveLeaseError("busy");
    this.assertLive();
    this.inFlight += 1;
    const run = (async () => {
      try {
        return await body();
      } finally {
        this.inFlight -= 1;
      }
    })();
    // Kept so `cancel` can join whatever is running before it deletes anything.
    this.tail = run.catch(() => undefined);
    return run;
  }

  private stagedPathFor(index: number): string {
    // Opaque and index-derived: no manifest-supplied character reaches disk
    // during streaming.
    return join(this.stagingDirectory, `${index}.part`);
  }

  async beginFile(index: number): Promise<void> {
    return this.exclusive(async () => {
      if (this.current) throw new ReceiveLeaseError("out-of-order", "previous file still open");
      if (index !== this.nextIndex) throw new ReceiveLeaseError("out-of-order");
      if (!this.files[index]) throw new ReceiveLeaseError("out-of-order");

      const stagedPath = this.stagedPathFor(index);
      const handle = await open(
        stagedPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      ).catch((err: NodeJS.ErrnoException) => {
        throw new ReceiveLeaseError("io-failed", String(err.message));
      });

      // Re-check AFTER the await. A cancel that arrived while the file was being
      // created must not leave an open descriptor and a part file behind it.
      if (this.cancelled || this.closed) {
        await handle.close().catch(() => undefined);
        await rm(stagedPath, { force: true }).catch(() => undefined);
        throw new ReceiveLeaseError("lease-closed");
      }
      this.current = { index, handle, stagedPath, written: 0 };
    });
  }

  /**
   * Append one bounded chunk, and require the filesystem to have taken all of
   * it.
   *
   * `FileHandle.write` reports `bytesWritten`, and a partial write is a real
   * outcome. Trusting the request length instead would advance the counter past
   * bytes that are not on disk, and the file would then satisfy the exact-length
   * check while being short — the precise failure the length check exists to
   * catch.
   */
  async writeChunk(index: number, chunk: Uint8Array): Promise<void> {
    return this.exclusive(async () => {
      const file = this.current;
      if (!file) throw new ReceiveLeaseError("no-open-file");
      if (file.index !== index) throw new ReceiveLeaseError("out-of-order");
      if (chunk.byteLength > MAX_CHUNK_BYTES) throw new ReceiveLeaseError("chunk-too-large");

      const planned = this.files[index]!;
      if (file.written + chunk.byteLength > planned.size) {
        throw new ReceiveLeaseError("length-exceeded");
      }

      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await file.handle.write(chunk, offset, chunk.byteLength - offset);
        // A write that moves nothing will never move anything; looping would
        // spin forever, so it is reported rather than retried.
        if (bytesWritten <= 0) throw new ReceiveLeaseError("short-write");
        offset += bytesWritten;
        file.written += bytesWritten;
        if (this.cancelled || this.closed) throw new ReceiveLeaseError("lease-closed");
      }
    });
  }

  /** Close the staged file — only if it is exactly as long as declared. */
  async finishFile(index: number): Promise<void> {
    return this.exclusive(async () => {
      const file = this.current;
      if (!file) throw new ReceiveLeaseError("no-open-file");
      if (file.index !== index) throw new ReceiveLeaseError("out-of-order");
      const planned = this.files[index]!;
      if (file.written !== planned.size) {
        this.current = null;
        await file.handle.close().catch(() => undefined);
        await rm(file.stagedPath, { force: true }).catch(() => undefined);
        throw new ReceiveLeaseError("length-short");
      }

      await file.handle.sync();
      await file.handle.close();
      this.current = null;
      if (this.cancelled || this.closed) throw new ReceiveLeaseError("lease-closed");
      this.staged.push({ segments: planned.segments, stagedPath: file.stagedPath, size: planned.size });
      this.nextIndex += 1;
    });
  }

  /**
   * Normal completion. Succeeds only when every planned file is staged.
   *
   * A lease that stops early is `incomplete`, never a quiet success: reporting
   * otherwise is exactly the "ciphertext arrived is not saved" confusion the
   * product refuses to make elsewhere.
   */
  async close(): Promise<readonly StagedFile[]> {
    // After a cancel the staged bytes are gone, so a length check alone would
    // happily report success over files that no longer exist.
    if (this.cancelled) throw new ReceiveLeaseError("lease-closed");
    if (this.staged.length !== this.files.length || this.current) {
      await this.cancel();
      throw new ReceiveLeaseError("incomplete");
    }
    this.closed = true;
    await this.tail;
    return this.staged;
  }

  /**
   * Cancel: refuse further work immediately, wait for whatever is mid-await to
   * unwind, then remove everything this lease owns.
   *
   * Ordering is the point. Setting the flag before joining means no new
   * operation starts; joining before deleting means the in-flight one is not
   * racing the teardown for the same FILE DESCRIPTOR.
   *
   * Only the descriptor is pinned. The staging PATH is not: the `rm` below
   * resolves a string, and an ancestor swapped between now and then redirects
   * it. A previous checkpoint described this lease as descriptor-pinned as
   * though that covered the path too. It does not, and the residual is recorded
   * in DURABLE-PARITY.md rather than implied away here.
   */
  cancel(): Promise<void> {
    // Cached in full. An earlier shape had the second caller await only the
    // in-flight operation, so it returned while the first caller was still
    // deleting — and a test that checked the directory was gone could pass or
    // fail depending on which caller it happened to await.
    if (this.cancellation) return this.cancellation;
    this.cancelled = true;
    this.cancellation = (async () => {
      await this.tail;
      await this.terminal?.catch(() => undefined);

      const file = this.current;
      this.current = null;
      if (file) await file.handle.close().catch(() => undefined);

      // Everything in this directory was put there by this lease, so a
      // recursive removal cannot reach a file it does not own — provided the
      // path still resolves to that directory, which is the ancestor-swap
      // exposure named above and not something this line can check. Failures
      // are surfaced, not swallowed: a lease that could not clean up has left
      // bytes on the user's disk and the UI must be able to say so.
      await rm(this.stagingDirectory, { recursive: true, force: true });
    })();
    return this.cancellation;
  }

  /**
   * Move staged files to their final names.
   *
   * Refuses without a publisher built on Win32 primitives that can guarantee
   * no-replace creation and containment under concurrent modification. See the
   * header: shipping `fs.rename` here would be an overwrite bug wearing a safe
   * name.
   */
  publish(publisher?: LeasePublisher): Promise<readonly string[]> {
    if (this.cancelled) return Promise.reject(new ReceiveLeaseError("lease-closed"));
    // One terminal operation at a time. Two concurrent publishes would each see
    // a complete staging set and race for the same destination names.
    if (this.terminal) return Promise.reject(new ReceiveLeaseError("busy"));
    if (!publisher) return Promise.reject(new ReceiveLeaseError("publish-unsupported"));
    if (this.staged.length !== this.files.length) {
      return Promise.reject(new ReceiveLeaseError("incomplete"));
    }
    const run = (async () => {
      // Re-checked after the guards above, because `cancel` may have been
      // called while this function was being entered.
      if (this.cancelled) throw new ReceiveLeaseError("lease-closed");
      return publisher.publish(this.root, this.staged);
    })();
    this.terminal = run.catch(() => undefined);
    return run;
  }

  get stagedFiles(): readonly StagedFile[] {
    return this.staged;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** Test/diagnostic only: the directory this lease owns. */
  get staging(): string {
    return this.stagingDirectory;
  }
}
