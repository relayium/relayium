// The real filesystem under the Inbox stores.
//
// ## Where it may write, and why that is not a parameter
//
// Every path is derived from `AccountContext.directory`, which `captureAccount`
// composed from the host's own data root and a DIGEST of the account id. No
// caller passes a path in, the renderer never names one, and a path that does
// not resolve inside the account directory is refused rather than created.
// That is what stops a composed or traversing name from reaching the user's
// documents through a store that only ever meant to write its own records.
//
// ## The atomic write is `secrets.ts`'s discipline, not a new one
//
// `SecretStore.writeAtomic` established the shape and the reasons: `O_EXCL` so
// the temp name is ours alone and no pre-existing file or planted symlink can
// be opened at it; one owner for the temp file's whole lifetime, so a throw
// from `write` or `sync` cannot leave a stray `.tmp` holding real content that
// nothing will clean up; `sync` before the rename, so the bytes are on the
// platter before the name points at them. This is that shape, applied to the
// Inbox's own directory. It is deliberately a sibling rather than an import:
// `secrets.ts` belongs to another lease.
//
// ## What durability actually means here, and what it does NOT
//
// POSIX makes a rename durable by also syncing the DIRECTORY that contains it.
// Windows has no equivalent this API can reach, so `syncDirectory` below
// attempts it and reports exactly what happened rather than pretending the
// guarantee was obtained.
//
// The file's own `sync` still runs, so a crash cannot leave a TORN record. What
// is not guaranteed is that the RENAME survives a power loss, which would leave
// the previous version of that record in place.
//
// **That is not harmless, and an earlier version of this comment said it was.**
// Rolling a record back to its previous version can undo a `published` marker
// for a delivery whose files are already on the user's disk. The next run then
// sees no record of the publish, and a redelivery can duplicate those files.
// So the honest statement is: this layer provides atomic, non-torn records and
// a bounded rollback window on a rename that was not made durable. It does NOT
// provide crash-proof ordering between a commit and its marker, and nothing
// here should be read as claiming it does. What actually bounds that risk is
// central's own idempotency key and the journal's dedup horizon, neither of
// which is this file's to promise.
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import type { AccountContext } from "./account.js";

export class InboxFilesError extends Error {
  constructor(
    readonly code: "outside-account" | "unreadable" | "write-failed",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "InboxFilesError";
  }
}

/**
 * What a directory sync actually did.
 *
 * Three outcomes, not two. Collapsing them would report a real I/O error as
 * "this platform does not support it", which is how a failing disk gets read as
 * a known limitation.
 */
export interface DirectorySyncSupport {
  readonly attempted: boolean;
  readonly achieved: boolean;
  readonly outcome: "synced" | "unsupported" | "failed";
  /** The errno, when there was one. Never a path. */
  readonly code?: string;
}

/**
 * `VaultFiles` and `JournalFiles` over the real filesystem.
 *
 * One instance per account context. It holds no path of its own beyond the one
 * the context resolved, so two accounts cannot reach each other's records even
 * by mistake.
 */
export class InboxFiles {
  private readonly root: string;
  private lastDirectorySync: DirectorySyncSupport = {
    attempted: false,
    achieved: false,
    outcome: "unsupported",
  };

  constructor(context: AccountContext) {
    this.root = resolve(context.directory);
  }

  /** What the last atomic write managed to guarantee about its rename. */
  get directorySync(): DirectorySyncSupport {
    return this.lastDirectorySync;
  }

  /**
   * Refuse anything that is not inside this account's directory.
   *
   * `relative` rather than a prefix test: a prefix comparison accepts a sibling
   * whose name merely starts with the root's, and accepts `..` segments that
   * resolve back out.
   */
  private assertInside(path: string, allowRoot = false): string {
    const target = resolve(path);
    const rel = relative(this.root, target);
    // The account root itself is a legitimate DIRECTORY operation — it is the
    // first thing a never-used profile has to create — and never a legitimate
    // file operation. So `mkdirp` may name it and read/write/remove may not.
    if (rel === "") {
      if (allowRoot) return target;
      throw new InboxFilesError("outside-account", "the account root is not a file");
    }
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new InboxFilesError("outside-account", "a path outside the account directory");
    }
    return target;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const target = this.assertInside(path);
    // A missing file is the caller's to interpret — the vault treats "no index
    // yet" as empty and everything else as unreadable — so the errno is passed
    // through rather than flattened.
    return new Uint8Array(await readFile(target));
  }

  async mkdirp(path: string): Promise<void> {
    const target = this.assertInside(path, true);
    await mkdir(target, { recursive: true, mode: 0o700 });
  }

  async remove(path: string): Promise<void> {
    const target = this.assertInside(path);
    await rm(target, { force: true });
  }

  /**
   * Write, then rename. Never in the other order and never in place.
   *
   * An in-place write is how a store loses a record it already had: the old
   * bytes are gone the moment the write starts, and a crash midway leaves
   * neither version. The rename is the only step that changes what the name
   * means, and it happens after the content is durable.
   */
  async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    const target = this.assertInside(path);
    const directory = resolve(target, "..");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomBytes(8).toString("hex")}.tmp`;

    // OWNERSHIP is what the O_EXCL open establishes. If it fails, the temp path
    // is NOT ours — the name may belong to something else entirely — and the
    // cleanup below must not remove it. A random name makes a collision
    // unlikely; it does not make the file ours.
    let owned = false;
    let renamed = false;
    try {
      const handle = await open(
        temp,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      owned = true;
      try {
        let offset = 0;
        while (offset < bytes.byteLength) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
          if (bytesWritten <= 0) throw new InboxFilesError("write-failed", "short write");
          offset += bytesWritten;
        }
        await handle.sync();
      } finally {
        await handle.close().catch(() => undefined);
      }
      await rename(temp, target);
      renamed = true;
      this.lastDirectorySync = await syncDirectory(directory);
    } catch (error) {
      if (error instanceof InboxFilesError) throw error;
      throw new InboxFilesError("write-failed", (error as Error).name);
    } finally {
      // The rename consumed the name on success. Otherwise it is removed ONLY
      // if the exclusive create actually gave it to us.
      if (owned && !renamed) await rm(temp, { force: true }).catch(() => undefined);
    }
  }
}

/**
 * Try to make a directory entry durable, and report honestly whether it worked.
 *
 * Not best-effort-and-silent: a caller that believed the rename was durable on
 * a platform that cannot do it would be relying on a guarantee it never had.
 * The result is recorded so a test can assert what this platform actually
 * provides instead of what the code hoped for.
 */
export async function syncDirectory(directory: string): Promise<DirectorySyncSupport> {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
  } catch (error) {
    const code = errnoOf(error);
    // Windows refuses to open a directory this way at all, and so does a POSIX
    // host for a directory it will not hand out read access to. Those are
    // "cannot"; anything else is a failure and is reported as one.
    const outcome =
      code === "EISDIR" || code === "EPERM" || code === "EACCES" || code === "ENOTSUP"
        ? ("unsupported" as const)
        : ("failed" as const);
    return { attempted: true, achieved: false, outcome, ...(code === undefined ? {} : { code }) };
  }
  try {
    await handle.sync();
    return { attempted: true, achieved: true, outcome: "synced" };
  } catch (error) {
    const code = errnoOf(error);
    // EINVAL/ENOTSUP from fsync on a directory is the platform saying it does
    // not do this. EIO is a disk saying something else entirely.
    const outcome =
      code === "EINVAL" || code === "ENOTSUP" || code === "EPERM"
        ? ("unsupported" as const)
        : ("failed" as const);
    return { attempted: true, achieved: false, outcome, ...(code === undefined ? {} : { code }) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
