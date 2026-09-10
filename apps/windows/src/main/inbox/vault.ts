// The message vault: invariant 8's storage half.
//
// ## What lives here and why it is not the receive folder
//
// A text delivery has no file name — `inbox-manifest.ts` says so explicitly:
// `name` is ABSENT for text, "not empty, absent — because text has no name and a
// receiver must never be handed a string it could be tempted to treat as a
// destination". So a message cannot be written through the native helper, which
// addresses everything by manifest index and file name. It goes here instead:
// an account-scoped, authenticated, ciphertext-only store.
//
// ## The three rules this file exists to keep
//
//  1. **Ciphertext only.** Every record is sealed by `atrest.ts` with the
//     account key and the record kind bound as associated data, so a record
//     cannot be replayed into another account's directory or read as another
//     kind. Nothing plaintext is ever written, and there is no fallback that
//     would write plaintext if sealing failed.
//  2. **Record before index.** The record file is written and durable BEFORE the
//     index names it. The other order produces an index entry pointing at a file
//     that does not exist, which is indistinguishable from corruption.
//  3. **`unreadable` is never "start fresh".** A record that fails
//     authentication, or one the index names but that is missing, is reported.
//     Silently treating either as "no messages" is how a store loses the user's
//     history while looking healthy — the exact failure this whole path exists
//     to avoid.
import { AT_REST_KEY_BYTES, AtRestError, open as openRecord, seal as sealRecord } from "./atrest.js";
import type { AccountContext } from "./account.js";

/** Records retained at once. The vault is a message store, not a log. */
export const MAX_VAULT_RECORDS = 512;

/**
 * Largest message this store will accept, in bytes.
 *
 * Mirrors `INBOX_MANIFEST_MAX_TEXT_BYTES`. Stated as its own constant rather
 * than reached through the runtime bundle because the vault must be able to
 * refuse an oversized record with no bundle loaded — a store that could only
 * enforce its bound when a dependency happened to be available would not be
 * enforcing one.
 */
export const MAX_VAULT_TEXT_BYTES = 65536;

const VAULT_VERSION = 1;
/** Bound on every identifier a record may carry. */
const MAX_ID_LENGTH = 256;

export type VaultFailure =
  | "unreadable"
  | "missing-record"
  | "too-large"
  | "vault-full"
  | "not-found"
  | "malformed";

export class VaultError extends Error {
  constructor(
    readonly code: VaultFailure,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "VaultError";
  }
}

/**
 * The filesystem this vault uses.
 *
 * Injected for the same reason the journal injects one: the store's rules are
 * about ordering and atomicity, and proving them must not require a real disk.
 * `writeAtomic` is a contract, not a hint — a torn record is a record that fails
 * authentication and can never be recovered.
 */
export interface VaultFiles {
  readFile(path: string): Promise<Uint8Array>;
  writeAtomic(path: string, bytes: Uint8Array): Promise<void>;
  mkdirp(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** What the index knows about a record. Never the message itself. */
export interface VaultRecordMeta {
  readonly id: string;
  /** The delivery this message arrived as, for journal reconciliation. */
  readonly taskID: string;
  /** Central's device id for the sender, when the delivery carried one. */
  readonly sourceDeviceID: string;
  /** Plaintext length. The message bytes live in the record, not here. */
  readonly bytes: number;
  readonly receivedAt: number;
}

interface VaultIndexDocument {
  readonly v: number;
  readonly records: readonly VaultRecordMeta[];
}

interface VaultRecordDocument {
  readonly v: number;
  readonly id: string;
  /** base64 of the message plaintext. */
  readonly text: string;
}

function boundedID(value: string, what: string): string {
  if (value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new VaultError("malformed", `${what} is empty or unbounded`);
  }
  return value;
}

/**
 * An account's message store.
 *
 * One instance per `AccountContext`, like every other Inbox store: the context
 * is captured, never looked up, so a record cannot be written into an account
 * that replaced the one the operation began under.
 */
export class MessageVault {
  private readonly directory: string;
  private readonly indexPath: string;
  private key: CryptoKey | null = null;
  private cache: readonly VaultRecordMeta[] | null = null;
  /** Serialises read-modify-write so two saves cannot lose one another. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly context: AccountContext,
    private readonly files: VaultFiles,
    private readonly keyBytes: () => Promise<Uint8Array>,
  ) {
    this.directory = `${context.directory}/vault`;
    this.indexPath = `${this.directory}/index.enc`;
  }

  private recordPath(id: string): string {
    return `${this.directory}/${id}.enc`;
  }

  private async atRestKey(): Promise<CryptoKey> {
    if (this.key !== null) return this.key;
    const raw = await this.keyBytes();
    if (raw.byteLength !== AT_REST_KEY_BYTES) {
      throw new VaultError("unreadable", "the at-rest key is the wrong length");
    }
    const { importAtRestKey } = await import("./atrest.js");
    this.key = await importAtRestKey(raw);
    return this.key;
  }

  /** Serialise one read-modify-write against every other. */
  private update<T>(body: () => Promise<T>): Promise<T> {
    const run = this.tail.then(body, body);
    // The chain must survive a rejection, or one failed save would wedge the
    // vault for the rest of the process's life.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async loadIndex(): Promise<readonly VaultRecordMeta[]> {
    if (this.cache !== null) return this.cache;
    let sealed: Uint8Array;
    try {
      sealed = await this.files.readFile(this.indexPath);
    } catch {
      // No index yet is the ONLY case that legitimately reads as empty: nothing
      // has ever been saved. A present-but-unopenable index is not this case
      // and is handled below.
      this.cache = [];
      return this.cache;
    }
    let plaintext: Uint8Array;
    try {
      plaintext = await openRecord(await this.atRestKey(), this.context.accountKey, "vault-index", sealed);
    } catch (error) {
      // Deliberately NOT recovered by starting fresh. See rule 3.
      throw new VaultError(
        "unreadable",
        error instanceof AtRestError ? `vault index: ${error.code}` : "vault index failed authentication",
      );
    }
    let document: VaultIndexDocument;
    try {
      document = JSON.parse(new TextDecoder().decode(plaintext)) as VaultIndexDocument;
    } catch {
      throw new VaultError("unreadable", "vault index is not JSON");
    }
    if (document.v !== VAULT_VERSION || !Array.isArray(document.records)) {
      throw new VaultError("unreadable", "vault index is malformed");
    }
    this.cache = Object.freeze([...document.records]);
    return this.cache;
  }

  private async persistIndex(records: readonly VaultRecordMeta[]): Promise<void> {
    const document: VaultIndexDocument = { v: VAULT_VERSION, records: [...records] };
    const sealed = await sealRecord(
      await this.atRestKey(),
      this.context.accountKey,
      "vault-index",
      new TextEncoder().encode(JSON.stringify(document)),
    );
    await this.files.mkdirp(this.directory);
    await this.files.writeAtomic(this.indexPath, sealed);
    this.cache = Object.freeze([...records]);
  }

  /** What is in the vault. Metadata only — no message bytes are opened. */
  async list(): Promise<readonly VaultRecordMeta[]> {
    return this.update(() => this.loadIndex());
  }

  /**
   * Save one message.
   *
   * The record is written first and the index second. A crash between the two
   * leaves an orphan record file — invisible, harmless, and recoverable — while
   * the other order would leave the index naming a message that does not exist.
   */
  async saveText(args: {
    readonly id: string;
    readonly taskID: string;
    readonly sourceDeviceID: string;
    readonly plaintext: Uint8Array;
    readonly now: number;
  }): Promise<VaultRecordMeta> {
    const id = boundedID(args.id, "record id");
    const taskID = boundedID(args.taskID, "task id");
    if (args.sourceDeviceID.length > MAX_ID_LENGTH) {
      throw new VaultError("malformed", "source device id is unbounded");
    }
    if (args.plaintext.byteLength > MAX_VAULT_TEXT_BYTES) {
      throw new VaultError("too-large", `message is ${args.plaintext.byteLength} bytes`);
    }
    return this.update(async () => {
      const records = await this.loadIndex();
      const existing = records.find((r) => r.id === id);
      if (existing !== undefined) {
        // Idempotent by record id: a replayed save after a crash must not
        // produce a second copy of the same message.
        return existing;
      }
      if (records.length >= MAX_VAULT_RECORDS) {
        // Refused rather than evicted. Dropping the oldest message to make room
        // for a new one destroys something the user was shown and may not have
        // read; that is a product decision, not a storage one.
        throw new VaultError("vault-full", `${records.length} messages are retained`);
      }

      const document: VaultRecordDocument = {
        v: VAULT_VERSION,
        id,
        text: Buffer.from(args.plaintext).toString("base64"),
      };
      const sealed = await sealRecord(
        await this.atRestKey(),
        this.context.accountKey,
        "vault-record",
        new TextEncoder().encode(JSON.stringify(document)),
      );
      await this.files.mkdirp(this.directory);
      // Record first. See the doc comment.
      await this.files.writeAtomic(this.recordPath(id), sealed);

      const meta: VaultRecordMeta = {
        id,
        taskID,
        sourceDeviceID: args.sourceDeviceID,
        bytes: args.plaintext.byteLength,
        receivedAt: args.now,
      };
      await this.persistIndex([...records, meta]);
      return meta;
    });
  }

  /**
   * Open one message.
   *
   * A record the index names but that cannot be read is `missing-record` or
   * `unreadable` — never an empty message. The distinction matters to the
   * caller: one means the file is gone, the other means its contents cannot be
   * trusted, and neither is something to paper over.
   */
  async openText(id: string): Promise<Uint8Array> {
    return this.update(async () => {
      const records = await this.loadIndex();
      const meta = records.find((r) => r.id === id);
      if (meta === undefined) throw new VaultError("not-found", "no such message");

      let sealed: Uint8Array;
      try {
        sealed = await this.files.readFile(this.recordPath(id));
      } catch {
        throw new VaultError("missing-record", "the index names a record that is not on disk");
      }
      let plaintext: Uint8Array;
      try {
        plaintext = await openRecord(await this.atRestKey(), this.context.accountKey, "vault-record", sealed);
      } catch (error) {
        throw new VaultError(
          "unreadable",
          error instanceof AtRestError ? `vault record: ${error.code}` : "vault record failed authentication",
        );
      }
      let document: VaultRecordDocument;
      try {
        document = JSON.parse(new TextDecoder().decode(plaintext)) as VaultRecordDocument;
      } catch {
        throw new VaultError("unreadable", "vault record is not JSON");
      }
      if (document.v !== VAULT_VERSION || typeof document.text !== "string") {
        throw new VaultError("unreadable", "vault record is malformed");
      }
      if (document.id !== id) {
        // The record authenticated but names a different id, so the index and
        // the record disagree about what this file is.
        throw new VaultError("unreadable", "vault record identifies a different message");
      }
      const bytes = new Uint8Array(Buffer.from(document.text, "base64"));
      if (bytes.byteLength !== meta.bytes) {
        // Three independently derived numbers must agree; two here, and the
        // manifest's total upstream.
        throw new VaultError("unreadable", "vault record length disagrees with the index");
      }
      return bytes;
    });
  }

  /**
   * Remove one message.
   *
   * Index first this time, and deliberately: an entry removed before its record
   * leaves an orphan file, while a record removed before its entry leaves the
   * index pointing at nothing — which `openText` would have to report as
   * corruption. Orphan beats phantom in both directions.
   */
  async remove(id: string): Promise<void> {
    return this.update(async () => {
      const records = await this.loadIndex();
      if (!records.some((r) => r.id === id)) throw new VaultError("not-found", "no such message");
      await this.persistIndex(records.filter((r) => r.id !== id));
      try {
        await this.files.remove(this.recordPath(id));
      } catch {
        // The index no longer names it, so the file is unreachable either way.
        // Reporting a cleanup failure as a save failure would be worse.
      }
    });
  }
}
