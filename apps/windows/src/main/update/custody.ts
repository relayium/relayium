// Custody: the capability that owns update staging, and the receipts it issues.
//
// ## Ownership is an OBJECT, not a name and not a flag
//
// Every defect here had the same shape: an effect authorized by something that
// was not the thing being acted on. `rm(derivedPath)` deletes whatever answers
// to that name. A nonce makes the name unguessable but still names a slot, and a
// "we created it" boolean recorded next to that slot says nothing about what is
// in the slot NOW — between two runs the file can be renamed away and different
// bytes left behind.
//
// So a receipt carries the IDENTITY of the object the exclusive create returned
// (`posix:<dev>:<ino>`; a Windows adapter supplies volume serial plus file ID).
// Deletion re-reads the identity at the name and proceeds only on a match.
// Anything else — absent, changed, redirected — is preserved and reported. An
// unsigned journal therefore cannot authorize deleting anything: it can only
// name a slot inside a directory this app holds, and the object in that slot
// still has to be the one the receipt describes.
//
// ## The invariants a real Windows adapter must provide
//
// From the accepted native `internal/winio` primitives, which demonstrate them
// for the receive sink: a root opened once and traversed handle-relative via
// `OBJECT_ATTRIBUTES.RootDirectory`; directory handles without
// `FILE_SHARE_DELETE`, which is what makes held ancestors un-renameable;
// `FILE_OPEN_REPARSE_POINT` plus an explicit reparse refusal on the handle; and
// deletion targeting the handle rather than a name.
//
// What that reference does NOT establish, and this module must not borrow: its
// root is a USER-SELECTED receive destination taken as the initial authority,
// whereas update staging is anchored in a root the APP owns; holding a root and
// a child does not pin the root's own ANCESTORS; and nothing in it makes
// launching an executable by path safe (see `contracts.ts`).
//
// ## No portable fallback on Windows
//
// Node cannot express any of those invariants: no handle-relative create, no
// reparse-refusing open, no delete-by-handle, no handle-relative rename. So on
// `win32` the default provider REFUSES and the update core is inert until an
// adapter is wired.
//
// What goes through this interface, precisely: every MUTATION of staging —
// create, write, delete, rename — and every read of the journal. One read does
// not: `service.ts` opens and stats a staged file directly to compute an
// advisory digest for a staleness check. It is a read inside a directory this
// scope has just verified, it is never an authority, and the install authority
// is `PlatformInstaller.installVerified`, which re-verifies size, hash and
// Authenticode through a handle it holds (`contracts.ts`).
//
// The POSIX implementation is the non-Windows platforms' real implementation,
// not a stand-in. It pins what Node can pin — `O_NOFOLLOW` at the leaf, a held
// directory descriptor whose identity is re-compared around every mutation, and
// effects only on objects whose identity matches a receipt — and it DETECTS a
// redirected directory rather than claiming to have prevented one.

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

/** The outcome of removing something. `residue` means the caller still owns it. */
export type RetireOutcome =
  /** Confirmed absent: removed, or never there. */
  | { readonly outcome: "gone" }
  /** Not confirmed absent. The caller must RETAIN the ownership record. */
  | { readonly outcome: "residue"; readonly detail: string };

export type CustodyRefusal =
  /** This platform has no adapter that can own a directory safely. */
  | "no-platform-scope"
  /** A reparse point, symlink, or a directory that is no longer the one held. */
  | "redirected"
  | "not-a-directory"
  /** The name is taken. Nothing was created, so nothing is owned. */
  | "exists"
  | "bad-name"
  | "too-large"
  | "io";

export class CustodyError extends Error {
  constructor(
    readonly code: CustodyRefusal,
    readonly detail: string | null = null,
    /** Identity of an object this call DID create before failing. The caller
     *  owns it and must record it; it is not deleted here, because the failure
     *  is precisely that the directory could not be trusted. */
    readonly receipt: string | null = null,
  ) {
    super(detail === null ? `update custody: ${code}` : `update custody: ${code}: ${detail}`);
    this.name = "CustodyError";
  }
}

/**
 * A file this process created exclusively, and still owns.
 *
 * `path` is reachable only from here: a caller that wants to hash, reveal or
 * install a staged file has to hold the receipt that proves the file is ours.
 */
export interface OwnedFile {
  readonly name: string;
  readonly path: string;
  /** Durable identity of the created object. Persist this; it is the only thing
   *  that makes a later delete provable. */
  readonly receipt: string;
  write(chunk: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  /** Release the handle. Ownership survives — the receipt can still discard. */
  close(): Promise<void>;
  /** Delete the exact object this receipt names, and confirm it. */
  discard(): Promise<RetireOutcome>;
}

/** A staging directory held open, under an app-owned root. */
export interface StagingScope {
  readonly directory: string;
  /** Mint a receipt. `CustodyError("exists")` means the name is taken and
   *  nothing is owned. */
  createExclusive(name: string): Promise<OwnedFile>;
  /** Identity of whatever is at `name` now, or null if nothing is. Refuses a
   *  symlink or a non-file rather than describing it. */
  identityOf(name: string): Promise<string | null>;
  /** Remove `name` ONLY while it is still the object `receipt` describes. */
  removeOwned(name: string, receipt: string): Promise<RetireOutcome>;
  /** Read a small file whole, refusing to follow a link and refusing anything
   *  over `maxBytes` BEFORE reading it. Null means absent. */
  readBounded(name: string, maxBytes: number): Promise<string | null>;
  /**
   * SHA-256 of an owned file, read while its identity still matches `receipt`.
   *
   * Null means absent, the wrong length, or a different object. Advisory — the
   * install authority re-verifies through its own held handle — but it is read
   * through the capability so a wired adapter reads through the handle it holds
   * rather than re-resolving a name.
   */
  hashOwned(name: string, receipt: string, expectedBytes: number): Promise<string | null>;
  /**
   * Publish `file` as `toName`, atomically, using the handle that WROTE it.
   *
   * Not `replace(fromName, toName)`. Once the temp's handle is closed, another
   * process can swap the object at that name, and two names give an
   * implementation nothing to authorize the rename with — holding the directory
   * does not pin the leaf. So the owned file is passed in: a conforming adapter
   * renames through that same handle (`FileRenameInfo` with `RootDirectory` set
   * to the staging handle) without closing or reopening it, after re-reading the
   * file identity through the handle and comparing it to the receipt.
   *
   * Ownership is RETAINED until the outcome is confirmed: a failed commit leaves
   * the caller holding a receipt it can still discard.
   */
  commit(file: OwnedFile, toName: string): Promise<void>;
  /** The path of a name inside this held scope, for a caller that has already
   *  established ownership. */
  pathFor(name: string): string;
  close(): Promise<void>;
}

export interface StagingScopeProvider {
  /**
   * Open `component` beneath the app-owned `appRoot`, creating it if needed.
   *
   * `appRoot` is the anchor and is trusted as given, exactly as the native
   * reference trusts its opened root. That is a statement about this app's own
   * data directory — never a user-selected path — and it does NOT assert that
   * the root's own ancestors are unredirected.
   */
  open(appRoot: string, component: string): Promise<StagingScope>;
}

/** One inert component. Restated here so the capability never depends on a
 *  caller having validated the name. */
const INERT = /^[A-Za-z0-9._-]{1,120}$/;

/** The receipt token shape, restated wherever one crosses a boundary. */
export const RECEIPT = /^[a-z]+:[0-9a-f]{1,32}:[0-9a-f]{1,32}$/;

const errno = (error: unknown): string => (error as NodeJS.ErrnoException)?.code ?? "unknown";

const assertInert = (name: string): void => {
  if (typeof name !== "string" || !INERT.test(name) || name === "." || name === "..") {
    throw new CustodyError("bad-name");
  }
};

/** Device and inode, as a durable token. A Windows adapter emits the same shape
 *  from the volume serial and the 128-bit file ID. */
const tokenOf = (info: { dev: number; ino: number }): string =>
  `posix:${info.dev.toString(16)}:${info.ino.toString(16)}`;

class PosixScope implements StagingScope {
  constructor(
    readonly directory: string,
    private readonly handle: FileHandle,
    private readonly identity: string,
  ) {}

  /** The held directory must still be what this name resolves to. Detection,
   *  not prevention — Node cannot operate relative to the descriptor. */
  private async assertHeld(): Promise<void> {
    let seen;
    try {
      seen = await lstat(this.directory);
    } catch (error) {
      throw new CustodyError("redirected", errno(error));
    }
    if (seen.isSymbolicLink() || !seen.isDirectory()) throw new CustodyError("redirected");
    if (tokenOf(seen) !== this.identity) throw new CustodyError("redirected", "swapped");
  }

  pathFor(name: string): string {
    assertInert(name);
    return join(this.directory, name);
  }

  async createExclusive(name: string): Promise<OwnedFile> {
    const path = this.pathFor(name);
    await this.assertHeld();
    let file: FileHandle;
    try {
      file = await open(
        path,
        // O_NOFOLLOW as well as O_EXCL: a symlink planted at the name is
        // refused rather than followed, on the platforms that honour it.
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      const code = errno(error);
      throw new CustodyError(code === "EEXIST" || code === "ELOOP" ? "exists" : "io", code);
    }
    const receipt = tokenOf(await file.stat());
    try {
      await this.assertHeld();
    } catch (error) {
      // The directory stopped being ours between the check and the create. The
      // file is NOT deleted: this is exactly the position where a delete would
      // land somewhere unknown. The receipt travels with the refusal so the
      // caller records uncertain residue.
      await file.close().catch(() => undefined);
      throw new CustodyError("redirected", (error as CustodyError).detail, receipt);
    }
    return new PosixOwnedFile(name, path, file, receipt, this);
  }

  async identityOf(name: string): Promise<string | null> {
    const path = this.pathFor(name);
    await this.assertHeld();
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (errno(error) === "ENOENT") return null;
      throw new CustodyError("io", errno(error));
    }
    if (info.isSymbolicLink() || !info.isFile()) throw new CustodyError("redirected");
    return tokenOf(info);
  }

  async removeOwned(name: string, receipt: string): Promise<RetireOutcome> {
    return this.unlinkChecked(this.pathFor(name), receipt);
  }

  async readBounded(name: string, maxBytes: number): Promise<string | null> {
    const path = this.pathFor(name);
    await this.assertHeld();
    let file: FileHandle;
    try {
      file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      const code = errno(error);
      if (code === "ENOENT") return null;
      if (code === "ELOOP") throw new CustodyError("redirected", code);
      throw new CustodyError("io", code);
    }
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new CustodyError("redirected");
      // The size is checked THROUGH the handle and before any read, so an
      // oversized document is refused rather than read into memory first.
      if (info.size > maxBytes) throw new CustodyError("too-large");
      const buffer = Buffer.allocUnsafe(Number(info.size));
      let read = 0;
      while (read < buffer.byteLength) {
        const { bytesRead } = await file.read(buffer, read, buffer.byteLength - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return buffer.subarray(0, read).toString("utf8");
    } finally {
      await file.close().catch(() => undefined);
    }
  }

  async hashOwned(name: string, receipt: string, expectedBytes: number): Promise<string | null> {
    const path = this.pathFor(name);
    await this.assertHeld();
    let file: FileHandle;
    try {
      file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      const code = errno(error);
      if (code === "ENOENT") return null;
      if (code === "ELOOP") throw new CustodyError("redirected", code);
      throw new CustodyError("io", code);
    }
    try {
      const info = await file.stat();
      // Identity first: a different object of the right length would otherwise
      // be hashed and reported as this candidate's bytes.
      if (!info.isFile() || tokenOf(info) !== receipt || info.size !== expectedBytes) return null;
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1 << 20);
      for (;;) {
        const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) break;
        digest.update(buffer.subarray(0, bytesRead));
      }
      return digest.digest("hex");
    } finally {
      await file.close().catch(() => undefined);
    }
  }

  async commit(file: OwnedFile, toName: string): Promise<void> {
    const from = this.pathFor(file.name);
    const to = this.pathFor(toName);
    await this.assertHeld();
    // POSIX cannot rename through a descriptor. Re-reading the identity
    // immediately before the rename DETECTS a swapped leaf; it does not prevent
    // one, and the window between this check and `rename` is real. The Windows
    // adapter closes it by renaming the held handle; this does not, and says so.
    let current;
    try {
      current = await lstat(from);
    } catch (error) {
      throw new CustodyError("io", errno(error));
    }
    if (current.isSymbolicLink() || !current.isFile() || tokenOf(current) !== file.receipt) {
      throw new CustodyError("redirected", "identity-changed");
    }
    try {
      await rename(from, to);
    } catch (error) {
      throw new CustodyError("io", errno(error));
    }
  }

  /** Delete one name in the held scope while it is still the object `expected`
   *  describes, and confirm the absence. */
  async unlinkChecked(path: string, expected: string): Promise<RetireOutcome> {
    let current: string | null;
    try {
      await this.assertHeld();
      let info;
      try {
        info = await lstat(path);
      } catch (error) {
        if (errno(error) === "ENOENT") return { outcome: "gone" };
        return { outcome: "residue", detail: errno(error) };
      }
      if (info.isSymbolicLink() || !info.isFile()) {
        return { outcome: "residue", detail: "redirected" };
      }
      current = tokenOf(info);
    } catch (error) {
      return { outcome: "residue", detail: (error as CustodyError).code };
    }
    // The decisive comparison. A different object at the same name is somebody
    // else's file, whatever the record says.
    if (current !== expected) return { outcome: "residue", detail: "identity-changed" };
    try {
      await rm(path, { force: true });
    } catch {
      // Fall through: `rm` can fail for something already gone.
    }
    try {
      await stat(path);
    } catch (error) {
      if (errno(error) === "ENOENT") return { outcome: "gone" };
      return { outcome: "residue", detail: errno(error) };
    }
    return { outcome: "residue", detail: "still-present" };
  }

  async close(): Promise<void> {
    await this.handle.close().catch(() => undefined);
  }
}

class PosixOwnedFile implements OwnedFile {
  private open = true;

  constructor(
    readonly name: string,
    readonly path: string,
    private readonly handle: FileHandle,
    readonly receipt: string,
    private readonly scope: PosixScope,
  ) {}

  async write(chunk: Uint8Array): Promise<void> {
    // A short write is normal on a pipe-backed or interrupted descriptor, and a
    // dropped tail would only surface as a hash mismatch much later.
    let written = 0;
    while (written < chunk.byteLength) {
      const { bytesWritten } = await this.handle.write(chunk, written, chunk.byteLength - written);
      if (bytesWritten <= 0) throw new CustodyError("io", "short-write");
      written += bytesWritten;
    }
  }

  async sync(): Promise<void> {
    await this.handle.sync();
  }

  async close(): Promise<void> {
    if (!this.open) return;
    this.open = false;
    await this.handle.close().catch(() => undefined);
  }

  async discard(): Promise<RetireOutcome> {
    await this.close();
    return this.scope.unlinkChecked(this.path, this.receipt);
  }
}

export const posixScopeProvider: StagingScopeProvider = {
  async open(appRoot: string, component: string): Promise<StagingScope> {
    assertInert(component);
    try {
      // The app data root is this app's to create. It is the ANCHOR, trusted as
      // given — this establishes that it exists and is a directory, not that
      // its own ancestors are unredirected.
      await mkdir(appRoot, { recursive: true });
      const root = await stat(appRoot);
      if (!root.isDirectory()) throw new CustodyError("not-a-directory", "root");
    } catch (error) {
      if (error instanceof CustodyError) throw error;
      throw new CustodyError("io", errno(error));
    }
    const directory = join(appRoot, component);
    try {
      await mkdir(directory);
    } catch (error) {
      if (errno(error) !== "EEXIST") throw new CustodyError("io", errno(error));
    }
    const seen = await lstat(directory).catch((error: unknown) => {
      throw new CustodyError("io", errno(error));
    });
    // A symlink or reparse point here is the whole failure mode: the fixed name
    // `updates` says nothing about what it points at.
    if (seen.isSymbolicLink()) throw new CustodyError("redirected", "symlink");
    if (!seen.isDirectory()) throw new CustodyError("not-a-directory");
    let handle: FileHandle;
    try {
      handle = await open(
        directory,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
    } catch (error) {
      throw new CustodyError("io", errno(error));
    }
    const held = await handle.stat();
    if (tokenOf(held) !== tokenOf(seen)) {
      await handle.close().catch(() => undefined);
      throw new CustodyError("redirected", "swapped");
    }
    return new PosixScope(directory, handle, tokenOf(held));
  },
};

/**
 * The provider a build has when its platform has no adapter: it refuses.
 *
 * Nothing is created, nothing is deleted, and the update core reports a blocked
 * state rather than operating through a weaker mechanism.
 */
export const failClosedScopeProvider: StagingScopeProvider = {
  open: async () => {
    throw new CustodyError("no-platform-scope");
  },
};

/**
 * The provider for a platform.
 *
 * `win32` fails closed — see the header. Every other platform gets the POSIX
 * implementation, which is that platform's real implementation.
 */
export function defaultScopeProvider(
  platform: NodeJS.Platform = process.platform,
): StagingScopeProvider {
  return platform === "win32" ? failClosedScopeProvider : posixScopeProvider;
}
