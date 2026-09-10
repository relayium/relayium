// Encrypted-at-rest storage for this installation's private values.
//
// ## What the platform cipher does and does not protect
//
// On Windows, Electron's `safeStorage` uses DPAPI, which derives its key from
// the signed-in **OS account**. That protects the stored bytes from another
// account on the machine, from a stolen disk, and from a backup copied
// elsewhere. It does **not** protect against code already running as this user:
// malware holding the user's token can call `CryptUnprotectData` exactly as this
// app does. Saying otherwise would be a claim this design does not earn.
//
// ## Fail closed
//
// `safeStorage.isEncryptionAvailable()` can answer false — a Linux session with
// no keyring, a profile where DPAPI is unavailable, a keychain the user
// declined. This store then refuses to write. There is no plaintext fallback: a
// bearer written in the clear is worse than one the user must obtain again, and
// a silent downgrade is the failure a security review never sees fire.
//
// ## Three failures that must not be collapsed into one
//
// `not-found`, `unreadable` (permission or IO) and `undecryptable` (the bytes
// are there and the cipher refused them) mean different things to a caller.
// Mapping all of them to "absent" is how an installation identity gets silently
// replaced because a file was briefly unreadable — minting a second identity for
// one machine, which is the exact outcome that value exists to prevent.
//
// ## Writes are atomic
//
// A secret is written to a fresh temp file, flushed, and renamed over the
// target. `writeFile` truncates first, so an interruption between truncate and
// write leaves a zero-length secret and no way back. Rename replaces in one
// step, so an interrupted write leaves the PREVIOUS valid value intact.

import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { validateSegment } from "./io/winpath.js";

export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

export type SecretFailure =
  | "encryption-unavailable"
  | "invalid-key"
  | "too-large"
  | "not-found"
  | "unreadable"
  | "undecryptable";

export class SecretStoreError extends Error {
  constructor(readonly code: SecretFailure, message?: string) {
    super(message ?? code);
    this.name = "SecretStoreError";
  }
}

/** Generous for a token or a 43-character identity; far below "unbounded". */
export const MAX_SECRET_BYTES = 64 * 1024;

/**
 * The ceiling for a SEALED file, which is not the same number.
 *
 * A cipher adds a nonce, a tag and — for DPAPI — a header, so a plaintext right
 * at `MAX_SECRET_BYTES` seals to something larger. Using one bound for both
 * would make a value this store agreed to WRITE unreadable on the way back,
 * which is the worst shape of bug: it appears only at the size boundary and
 * looks like corruption. The margin is deliberately generous; the real values
 * here are a bearer token and a 43-character identity.
 */
export const MAX_SEALED_BYTES = MAX_SECRET_BYTES + 4096;

/**
 * A key names a file, so it is validated as a filename before becoming one.
 * Reusing the receive path's validator rather than inventing a second rule: a
 * name this app would refuse to receive is one it must refuse to store.
 */
function assertKey(key: string): void {
  const verdict = validateSegment(key);
  if (!verdict.ok) throw new SecretStoreError("invalid-key", `refused secret key (${verdict.reason})`);
}

const errno = (err: unknown): string | undefined => (err as NodeJS.ErrnoException)?.code;

export class SecretStore {
  /** One chain per key: concurrent writers to one secret would otherwise race
   *  their temp files onto the same target in an order nobody chose. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly directory: string,
    private readonly cipher: SecretCipher,
  ) {}

  private serialize<T>(key: string, body: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.then(body, body);
    this.chains.set(key, run.catch(() => undefined));
    return run;
  }

  /** Checked before every operation, never cached: availability is session state. */
  private assertAvailable(): void {
    if (!this.cipher.isAvailable()) throw new SecretStoreError("encryption-unavailable");
  }

  private fileFor(key: string): string {
    assertKey(key);
    return join(this.directory, `${key}.bin`);
  }

  private async writeAtomic(path: string, sealed: Buffer): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    // O_EXCL: the temp name is ours alone, so nothing pre-existing — including
    // a symlink planted at that path — can be opened or followed here.
    const handle = await open(
      temp,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );

    // ONE owner for the temp file's whole lifetime. An earlier shape closed the
    // handle in a `finally` but only removed the file if the RENAME failed, so a
    // throw from `write` or `sync` left an encrypted secret sitting in a stray
    // `.tmp` that nothing would ever clean up or read.
    let renamed = false;
    try {
      try {
        let offset = 0;
        while (offset < sealed.byteLength) {
          const { bytesWritten } = await handle.write(sealed, offset, sealed.byteLength - offset);
          if (bytesWritten <= 0) throw new SecretStoreError("unreadable", "short write");
          offset += bytesWritten;
        }
        await handle.sync();
      } finally {
        await handle.close().catch(() => undefined);
      }
      await rename(temp, path);
      renamed = true;
    } catch (err) {
      if (err instanceof SecretStoreError) throw err;
      throw new SecretStoreError("unreadable", String((err as Error).message));
    } finally {
      // The rename consumed the name on success; on every failure path the temp
      // file is ours and is removed.
      if (!renamed) await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  put(key: string, value: string): Promise<void> {
    return this.serialize(key, async () => {
      this.assertAvailable();
      const path = this.fileFor(key);
      if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
        throw new SecretStoreError("too-large");
      }
      await this.writeAtomic(path, this.cipher.encrypt(value));
    });
  }

  /**
   * Create only if absent, and report which happened.
   *
   * The create-once primitive behind a stable installation identity: two
   * concurrent callers race, exactly one writes, and the loser reads back the
   * winner's value instead of overwriting it.
   *
   * ## The exact scope of that guarantee
   *
   * Within ONE `SecretStore` instance. It is a read followed by a write,
   * serialised by the in-memory chain above — not an atomic filesystem
   * operation, and NOT a guarantee across processes. Two Relayium processes
   * calling this simultaneously could both observe "absent" and the second
   * would win the rename.
   *
   * That is sound here only because the app holds a single-instance lock and
   * exits when it does not own it, so a second process never reaches this code.
   * If that ever stops being true — a helper process, a background service —
   * this needs a real cross-process no-replace create, not a comment.
   */
  putIfAbsent(key: string, value: string): Promise<{ created: boolean; value: string }> {
    return this.serialize(key, async () => {
      this.assertAvailable();
      const path = this.fileFor(key);
      const existing = await this.readDecrypted(path);
      if (existing.kind === "ok") return { created: false, value: existing.value };
      if (existing.kind === "unreadable") throw new SecretStoreError("unreadable");
      if (existing.kind === "undecryptable") throw new SecretStoreError("undecryptable");
      if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) throw new SecretStoreError("too-large");
      await this.writeAtomic(path, this.cipher.encrypt(value));
      return { created: true, value };
    });
  }

  private async readDecrypted(
    path: string,
  ): Promise<
    | { kind: "ok"; value: string }
    | { kind: "not-found" }
    | { kind: "unreadable" }
    | { kind: "undecryptable" }
  > {
    let sealed: Buffer;
    try {
      sealed = await readFile(path);
    } catch (err) {
      // ENOENT alone means absent. A permission or IO error is a different
      // fact, and treating it as absent is what silently replaces a secret.
      return errno(err) === "ENOENT" ? { kind: "not-found" } : { kind: "unreadable" };
    }
    if (sealed.byteLength > MAX_SEALED_BYTES) return { kind: "unreadable" };
    try {
      return { kind: "ok", value: this.cipher.decrypt(sealed) };
    } catch {
      return { kind: "undecryptable" };
    }
  }

  get(key: string): Promise<string> {
    return this.serialize(key, async () => {
      this.assertAvailable();
      const result = await this.readDecrypted(this.fileFor(key));
      if (result.kind === "ok") return result.value;
      throw new SecretStoreError(result.kind);
    });
  }

  /** Absent is success — `delete` states an end state, not an action taken. */
  delete(key: string): Promise<void> {
    return this.serialize(key, async () => {
      await rm(this.fileFor(key), { force: true });
    });
  }
}

/** The production adapter. Imported lazily so unit tests never load Electron
 *  and never raise a keychain prompt on a developer's machine. */
export async function electronCipher(): Promise<SecretCipher> {
  const { safeStorage } = await import("electron");
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
  };
}
