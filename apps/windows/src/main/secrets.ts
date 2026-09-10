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
import { join, win32 } from "node:path";
import { validateSegment } from "./io/winpath.js";
import { RELAYIUM_ENVELOPE_V1 } from "./secret/envelope.js";
import { MAX_BLOB_BYTES } from "./secret/protocol.js";

const RELAYIUM_ENVELOPE_BYTES = RELAYIUM_ENVELOPE_V1.byteLength;

export interface SecretCipher {
  // Members may return a value or a Promise. The DPAPI path is a subprocess and
  // is necessarily async; other owners' existing synchronous fakes keep working
  // unchanged. Every call site awaits BEFORE bounding, writing or returning —
  // never comparing a Promise to a length or writing one to disk.
  isAvailable(): boolean | Promise<boolean>;
  encrypt(plaintext: string): Buffer | Promise<Buffer>;
  decrypt(ciphertext: Buffer): string | Promise<string>;
  /**
   * Optional richer read: the plaintext, plus whether it came from a format
   * that should be re-sealed.
   *
   * Separate from `decrypt` so existing ciphers need no change. A cipher cannot
   * perform the migration itself — see `get` — so it reports and the store acts.
   */
  openWithMigration?(ciphertext: Buffer): Promise<{ value: string; needsMigration: boolean }>;
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
 * The largest stored blob, which is not `MAX_SECRET_BYTES`.
 *
 * A cipher adds a nonce, a tag and a header, so a plaintext right at the
 * plaintext ceiling seals to something larger. Using one bound for both would
 * make a value this store agreed to WRITE unreadable on the way back — a bug
 * that appears only at the size boundary and looks like corruption.
 *
 * Expressed from the parts rather than as a literal, so the envelope overhead is
 * visible at the bound: the 5-byte `RLYM\x01` discriminator plus the helper's
 * maximum DPAPI blob. The previous value was sized for the old format and would
 * have rejected a valid new one.
 */
export const MAX_SEALED_BYTES = RELAYIUM_ENVELOPE_BYTES + MAX_BLOB_BYTES;

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

  /**
   * Resolves once every operation queued on every key has settled.
   *
   * Purely observational — nothing is cancelled, reordered, or written
   * differently because someone is watching. Quit needs it: a teardown that
   * drained the helper's ABANDONED work while an active `put` was still writing
   * would return with a temp file mid-rename.
   *
   * Joins the tails, then re-checks. A tail settling can be what lets the next
   * queued operation start, so a single pass could resolve while work it had
   * already seen was still producing more. It ends when a pass adds nothing new,
   * which is reachable because this only joins what was queued BEFORE it looked:
   * the caller fences new users first, so nothing keeps feeding it.
   *
   * There is deliberately no `busyKeys` counterpart. The map keeps a settled
   * tail per key forever — that is what makes the chain cheap — so its size
   * counts keys ever touched, not work in flight, and a number that looked like
   * a gauge and was not would be worse than no number. What a test needs is
   * whether this observably WAITS, and that is what its barrier asserts.
   */
  async waitIdle(): Promise<void> {
    for (;;) {
      const tails = [...this.chains.values()];
      if (tails.length === 0) return;
      await Promise.allSettled(tails);
      const after = [...this.chains.values()];
      if (after.length === tails.length && after.every((tail, i) => tail === tails[i])) return;
    }
  }

  /** Checked before every operation, never cached: availability is session state. */
  private async assertAvailable(): Promise<void> {
    if (!(await this.cipher.isAvailable())) throw new SecretStoreError("encryption-unavailable");
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
      // Closed reason only: an errno message can name the path it failed on,
      // and this value crosses into IPC.
      throw new SecretStoreError("unreadable");
    } finally {
      // The rename consumed the name on success; on every failure path the temp
      // file is ours and is removed.
      if (!renamed) await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Seal, and refuse a result this store could never read back.
   *
   * A blob larger than `MAX_SEALED_BYTES` would be written happily and then
   * rejected by `readDecrypted` on every future read — a value the store agreed
   * to store and cannot return, which looks like corruption and is not.
   */
  private async sealBounded(value: string): Promise<Buffer> {
    const sealed = await this.cipher.encrypt(value);
    if (sealed.byteLength > MAX_SEALED_BYTES) {
      sealed.fill(0);
      throw new SecretStoreError("too-large");
    }
    return sealed;
  }

  /** Refuse a decrypted value larger than this store would ever have accepted. */
  private assertPlaintextBounded(value: string): void {
    if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) throw new SecretStoreError("undecryptable");
  }

  put(key: string, value: string): Promise<void> {
    return this.serialize(key, async () => {
      await this.assertAvailable();
      const path = this.fileFor(key);
      if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
        throw new SecretStoreError("too-large");
      }
      // Awaited before the write: a Promise must never reach the filesystem.
      await this.writeAtomic(path, await this.sealBounded(value));
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
      await this.assertAvailable();
      const path = this.fileFor(key);
      const existing = await this.readDecrypted(path);
      if (existing.kind === "ok") {
        this.assertPlaintextBounded(existing.value);
        // Migrated here too, for the same reason `get` does it: the install ID
        // is read through THIS method, so skipping it would leave the one value
        // most likely to predate the helper permanently on the old format.
        if (existing.needsMigration) await this.reseal(path, existing.value);
        return { created: false, value: existing.value };
      }
      if (existing.kind === "unreadable") throw new SecretStoreError("unreadable");
      if (existing.kind === "undecryptable") throw new SecretStoreError("undecryptable");
      // Without this the helper being unavailable would fall through to the
      // write below and MINT A SECOND IDENTITY for a machine that already has
      // one — the exact silent replacement this store exists to prevent.
      if (existing.kind === "encryption-unavailable") throw new SecretStoreError("encryption-unavailable");
      if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) throw new SecretStoreError("too-large");
      // Awaited before the write: a Promise must never reach the filesystem.
      await this.writeAtomic(path, await this.sealBounded(value));
      return { created: true, value };
    });
  }

  private async readDecrypted(
    path: string,
  ): Promise<
    | { kind: "ok"; value: string; needsMigration: boolean }
    | { kind: "not-found" }
    | { kind: "unreadable" }
    | { kind: "undecryptable" }
    | { kind: "encryption-unavailable" }
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
      if (this.cipher.openWithMigration) {
        const opened = await this.cipher.openWithMigration(sealed);
        return { kind: "ok", value: opened.value, needsMigration: opened.needsMigration };
      }
      return { kind: "ok", value: await this.cipher.decrypt(sealed), needsMigration: false };
    } catch (err) {
      // A helper that could not be run is a TRANSIENT fact about this machine;
      // "these bytes will not decrypt" is a permanent fact about the data. The
      // caller decides very different things on each — retry versus tell the
      // user their identity is unrecoverable — so a catch-all that flattened
      // them would have made the sign-in path unable to tell a missing binary
      // from a lost key.
      if (err instanceof SecretStoreError && err.code === "encryption-unavailable") {
        return { kind: "encryption-unavailable" };
      }
      return { kind: "undecryptable" };
    }
  }

  get(key: string): Promise<string> {
    return this.serialize(key, async () => {
      await this.assertAvailable();
      const path = this.fileFor(key);
      const result = await this.readDecrypted(path);
      if (result.kind !== "ok") throw new SecretStoreError(result.kind);
      this.assertPlaintextBounded(result.value);
      if (result.needsMigration) await this.reseal(path, result.value);
      return result.value;
    });
  }

  /**
   * Re-seal a legacy blob in the current format.
   *
   * ## Why this is here and not a call to `put`
   *
   * Every operation on a key runs inside that key's chain. Calling `put` from
   * inside `get` would enqueue behind the `get` still running, and the chain
   * would await itself — a deadlock on the sign-in path. The write is therefore
   * performed directly, in the section already held.
   *
   * Holding that section is also what makes the migration safe against a
   * concurrent sign-in: no `put` for this key can interleave, so this cannot
   * overwrite a newly stored token with the stale plaintext it just read.
   *
   * ## Verified before it replaces anything
   *
   * The legacy blob is the only readable copy at this moment. It is replaced
   * only after the new bytes have been sealed AND read back, because the defect
   * that started all of this was a write that reported success and could not be
   * read afterwards. Any failure leaves the old bytes untouched and is
   * swallowed deliberately: the READ succeeded, and failing a caller because an
   * optimisation failed would turn a working sign-in into an error.
   */
  private async reseal(path: string, value: string): Promise<void> {
    try {
      const sealed = await this.sealBounded(value);
      const verify = this.cipher.openWithMigration
        ? (await this.cipher.openWithMigration(sealed)).value
        : await this.cipher.decrypt(sealed);
      if (verify !== value) return;
      await this.writeAtomic(path, sealed);
    } catch {
      // Not migrated. The old bytes remain, and the caller still gets its value.
    }
  }

  /** Absent is success — `delete` states an end state, not an action taken. */
  delete(key: string): Promise<void> {
    return this.serialize(key, async () => {
      await rm(this.fileFor(key), { force: true });
    });
  }
}

/**
 * Where `relayium-secret-helper.exe` is, and nowhere else.
 *
 * Two fixed locations, chosen by whether the app is packaged. Never `PATH`,
 * never a relative guess, never an environment override: this process is about
 * to hand it the account bearer, so "whichever one we found" is not an
 * acceptable answer to which binary that is.
 */
export function secretHelperPath(packaged: boolean, resourcesPath: string, appRoot: string): string {
  // `win32.join`, not the ambient one. These are Windows paths and this
  // function is unit-tested on macOS and Linux, where the host module joins
  // with `/` and yields `C:\app\resources/relayium-secret-helper.exe` — the
  // same latent defect `storage.ts` documents. Identical on Windows, correct
  // everywhere.
  return packaged
    ? win32.join(resourcesPath, "relayium-secret-helper.exe")
    : win32.join(appRoot, "native", "build", "relayium-secret-helper.exe");
}

/**
 * The cipher this platform actually uses.
 *
 * **Windows** goes through the helper: DPAPI keyed on the user's own account,
 * persisted by Windows rather than by a Chromium preference committed at a
 * clean shutdown. Windows run 34466025680 showed the latter loses the identity
 * on any forced termination before that commit.
 *
 * **Everywhere else** keeps the existing platform cipher. The helper is a
 * Windows binary and DPAPI is a Windows API; there is nothing here to port, and
 * development on macOS or Linux must not start reaching for a keychain it has
 * no reason to touch.
 */
export async function platformCipher(): Promise<SecretCipher> {
  if (process.platform !== "win32") return electronCipher();

  const { app } = await import("electron");
  const [{ DpapiCipher }, { spawnHelperTransport }, { VersionedCipher }, { electronLegacyReader }] =
    await Promise.all([
      import("./secret/dpapi-cipher.js"),
      import("./secret/helper-transport.js"),
      import("./secret/versioned-cipher.js"),
      import("./secret/legacy-cipher.js"),
    ]);

  const executable = secretHelperPath(app.isPackaged, process.resourcesPath, app.getAppPath());
  const versioned = new VersionedCipher(
    new DpapiCipher(
      spawnHelperTransport({
        executable,
        timeoutMs: SECRET_HELPER_TIMEOUT_MS,
        // Closed reasons only. This is a log, not a surface, and it never
        // receives payload bytes.
        reportFailure: (reason) => console.error(`[secret-helper] ${reason}`),
      }),
    ),
    await electronLegacyReader(),
  );

  return {
    // The helper is present or it is not; there is no partial availability to
    // report, and probing it here would spawn a process on every check.
    isAvailable: () => true,
    encrypt: (plaintext) => versioned.seal(plaintext),
    decrypt: async (sealed) => {
      const opened = await versioned.open(sealed);
      if (opened.kind === "ok") return opened.value;
      throw new SecretStoreError(opened.kind === "undecryptable" ? "undecryptable" : "encryption-unavailable");
    },
    openWithMigration: async (sealed) => {
      const opened = await versioned.open(sealed);
      if (opened.kind === "ok") return { value: opened.value, needsMigration: opened.needsMigration };
      throw new SecretStoreError(opened.kind === "undecryptable" ? "undecryptable" : "encryption-unavailable");
    },
  };
}

/** Generous for a DPAPI round trip; short enough that a hung helper is a failure. */
const SECRET_HELPER_TIMEOUT_MS = 15_000;

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
