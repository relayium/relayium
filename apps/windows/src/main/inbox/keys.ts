// This device's inbox key history.
//
// ## Where the private halves live
//
// In `SecretStore` — DPAPI on Windows — and nowhere else. The CLI's Go
// equivalent (`server/internal/inboxclient/keystore.go`) writes
// `PrivateKey: EncodeKeyBytes(kp.Private[:])` into a JSON file protected by file
// mode alone; that is appropriate for a CLI and is not appropriate here, where
// the app already has an encrypted store. No key material touches a plain file.
//
// The whole history is ONE secret value. At the retention bound below, 64
// records of roughly 250 bytes is about 16 KB, comfortably inside
// `MAX_SECRET_BYTES` (64 KiB) — so this is a measured fit rather than a hope.
//
// ## Why old keys are kept
//
// A pending task names the key it was sealed to (`Task.TargetKeyID` /
// `TargetKeyGeneration`). Discarding a superseded key makes every task still
// queued against it permanently undecryptable, so history is retained and
// rotation is additive.
//
// ## Why the bound REFUSES instead of evicting
//
// Evicting the oldest record to make room would silently destroy the ability to
// open a task that is still pending. Refusing to append is visible and
// recoverable — the operator can clear settled tasks — whereas a silent drop
// surfaces later as an undecryptable delivery with no explanation.
import type { AccountContext } from "./account.js";
import type { InboxRuntime } from "./runtime-contract.js";

/**
 * The account-scoped secret slot.
 *
 * FLAT, with no separator. `SecretStore` validates a key with
 * `validateSegment` — the receive path's FILENAME validator — because a key
 * names a file. A slash is rejected as `separator-in-segment`, so an earlier
 * `inbox/<accountKey>/keys` could never have been written at all: enrolment
 * would have failed on the first `put` with `invalid-key`.
 *
 * The account digest is 32 hex characters, so the whole slot is well inside the
 * segment length bound and contains only characters the validator accepts.
 */
export function keySlotFor(accountKey: string): string {
  return `inbox-keys-${accountKey}`;
}

/** Matches the Go client's `maxKeyHistory`, so both agree on retention. */
export const MAX_KEY_HISTORY = 64;

export interface InboxKeyRecord {
  /** Central's id, empty between append and registration. */
  readonly keyID: string;
  readonly generation: number;
  readonly algorithm: string;
  /** base64url, no padding. */
  readonly publicKey: string;
  readonly createdAt: number;
}

/** A record plus its private half. Never returned by a listing accessor. */
interface StoredKeyRecord extends InboxKeyRecord {
  readonly privateKey: string;
}

interface KeyFile {
  readonly v: number;
  readonly keys: readonly StoredKeyRecord[];
}

const KEY_FILE_VERSION = 1;

export type KeyFailure =
  | "retention-full"
  | "duplicate-public-key"
  | "unknown-key"
  | "invalid-key-id"
  | "already-bound"
  | "duplicate-key-id"
  | "pending-deliveries"
  | "unreadable"
  | "not-enrolled";

/** Bounds and shape for an id central issues. */
const MAX_KEY_ID_LENGTH = 128;
const KEY_ID_SHAPE = /^[A-Za-z0-9_.:-]+$/;

export class InboxKeyError extends Error {
  constructor(readonly code: KeyFailure, message?: string) {
    super(message ?? code);
    this.name = "InboxKeyError";
  }
}

/** The narrow slice of SecretStore this needs, so tests need no Electron. */
export interface SecretSlot {
  get(key: string): Promise<string>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Read the `code` off a SecretStoreError-shaped rejection.
 *
 * Structural rather than an `instanceof`: `secrets.ts` is outside this lease and
 * this module must not import it merely to name a class, and the injected slot
 * in tests is not that class either.
 */
function secretFailureCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

export class InboxKeyStore {
  private readonly slot: string;
  /**
   * Serialises the WHOLE read-modify-write.
   *
   * `SecretStore` already serialises per key, but that only makes each `put`
   * atomic — it does nothing for a read-then-write pair. Two concurrent
   * `append` calls both read the same history, each writes its own record onto
   * it, and the second write DISCARDS the first key: a private half generated,
   * possibly published, and then lost. The lock has to span the read and the
   * write, so it lives here.
   */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    context: AccountContext,
    private readonly secrets: SecretSlot,
    private readonly runtime: InboxRuntime,
  ) {
    // Account-scoped by construction: two accounts cannot collide, and the key
    // is the account DIGEST so no account identifier becomes a secret name.
    this.slot = keySlotFor(context.accountKey);
  }

  private async load(): Promise<readonly StoredKeyRecord[]> {
    let raw: string;
    try {
      raw = await this.secrets.get(this.slot);
    } catch (error) {
      // ONLY an explicit not-found means "this device has never enrolled".
      //
      // A catch-all here was a real defect: `undecryptable`, `unreadable`,
      // `invalid-key` and `encryption-unavailable` would all have become an
      // empty history, and the caller would then have generated and stored a
      // NEW key over a slot whose contents it simply could not read — orphaning
      // every pending delivery. `secrets.ts` warns about exactly this collapse
      // in its own header, and it separates those codes precisely so a caller
      // does not have to guess.
      if (secretFailureCode(error) === "not-found") return [];
      throw new InboxKeyError("unreadable", `key history is unavailable (${secretFailureCode(error) ?? "unknown"})`);
    }
    if (raw.length === 0) {
      // A present-but-empty slot is not a fresh device; it is a slot that lost
      // its contents. Refused rather than silently re-enrolled.
      throw new InboxKeyError("unreadable", "key history is present but empty");
    }
    let parsed: KeyFile;
    try {
      parsed = JSON.parse(raw) as KeyFile;
    } catch {
      throw new InboxKeyError("unreadable", "key history is not JSON");
    }
    if (parsed.v !== KEY_FILE_VERSION) {
      throw new InboxKeyError("unreadable", `key history is version ${String(parsed.v)}`);
    }
    if (!Array.isArray(parsed.keys)) throw new InboxKeyError("unreadable", "key history is malformed");
    return parsed.keys;
  }

  private async save(keys: readonly StoredKeyRecord[]): Promise<void> {
    await this.secrets.put(this.slot, JSON.stringify({ v: KEY_FILE_VERSION, keys }));
  }

  /** Run a read-modify-write with exclusive ownership of the slot. */
  private exclusive<T>(body: () => Promise<T>): Promise<T> {
    const run = this.tail.then(body, body);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Public halves only, oldest first. */
  async history(): Promise<readonly InboxKeyRecord[]> {
    const keys = await this.load();
    return keys.map(({ privateKey: _ignored, ...rest }) => rest);
  }

  /** The newest record, or null when this device has never enrolled. */
  async current(): Promise<InboxKeyRecord | null> {
    const keys = await this.load();
    const last = keys[keys.length - 1];
    if (last === undefined) return null;
    const { privateKey: _ignored, ...rest } = last;
    return rest;
  }

  /**
   * Generate and durably append a key, returning its public half.
   *
   * Appended BEFORE the caller publishes it, so a crash between append and
   * registration leaves a key this device can still open deliveries with —
   * the opposite ordering would publish a key whose private half was lost.
   * `keyID` is empty until `bindKeyID` reconciles central's name for it.
   */
  async append(now: number): Promise<InboxKeyRecord> {
    return this.exclusive(() => this.appendLocked(now));
  }

  private async appendLocked(now: number): Promise<InboxKeyRecord> {
    const keys = await this.load();
    if (keys.length >= MAX_KEY_HISTORY) {
      throw new InboxKeyError(
        "retention-full",
        `key history holds ${MAX_KEY_HISTORY} records; refusing to evict one that a pending task may need`,
      );
    }
    const pair = await this.runtime.generateKeyPair();
    const publicKey = this.runtime.encodeKey(pair.publicKey);
    if (keys.some((k) => k.publicKey === publicKey)) {
      // Re-registering an existing key is a downgrade, not a rotation, and
      // central refuses it too. Caught here so the two histories agree.
      throw new InboxKeyError("duplicate-public-key");
    }
    const record: StoredKeyRecord = {
      keyID: "",
      generation: (keys[keys.length - 1]?.generation ?? 0) + 1,
      algorithm: this.runtime.constants.keyAlgorithm,
      publicKey,
      privateKey: this.runtime.encodeKey(pair.privateKey),
      createdAt: now,
    };
    await this.save([...keys, record]);
    const { privateKey: _ignored, ...rest } = record;
    return rest;
  }

  /** Record central's id for an already-appended public key. */
  async bindKeyID(publicKey: string, keyID: string): Promise<void> {
    return this.exclusive(() => this.bindKeyIDLocked(publicKey, keyID));
  }

  private async bindKeyIDLocked(publicKey: string, keyID: string): Promise<void> {
    // Shape first. An empty or unbounded id would be written straight into the
    // history and then used to select a decryption key; an id central never
    // issued cannot match a task, so a malformed one silently orphans the key.
    if (keyID.length === 0) throw new InboxKeyError("invalid-key-id", "key id is empty");
    if (keyID.length > MAX_KEY_ID_LENGTH) {
      throw new InboxKeyError("invalid-key-id", `key id exceeds ${MAX_KEY_ID_LENGTH} characters`);
    }
    if (!KEY_ID_SHAPE.test(keyID)) throw new InboxKeyError("invalid-key-id", "key id has unexpected characters");

    const keys = await this.load();
    const at = keys.findIndex((k) => k.publicKey === publicKey);
    const existing = at >= 0 ? keys[at] : undefined;
    if (existing === undefined) throw new InboxKeyError("unknown-key");

    if (existing.keyID.length > 0) {
      // IMMUTABLE once bound. Rebinding to a different id would silently
      // re-point this device's private key at another key's deliveries; the
      // same id is a harmless retry of the same registration.
      if (existing.keyID === keyID) return;
      throw new InboxKeyError(
        "already-bound",
        "a key id is bound once; rebinding would re-point a private key at another key's deliveries",
      );
    }
    if (keys.some((k) => k.keyID === keyID)) {
      // Two records claiming one id makes key selection ambiguous, and the
      // wrong choice is an undecryptable delivery with no explanation.
      throw new InboxKeyError("duplicate-key-id");
    }

    const updated = [...keys];
    updated[at] = { ...existing, keyID };
    await this.save(updated);
  }

  /**
   * Open a sealed content key using the key the task names.
   *
   * Selected by `keyID` rather than by "the current key": a task queued before
   * a rotation was sealed to the older one, and using the newest would fail to
   * open a delivery that is perfectly valid.
   */
  async openSealedContentKey(keyID: string, sealed: Uint8Array): Promise<Uint8Array> {
    const keys = await this.load();
    if (keys.length === 0) throw new InboxKeyError("not-enrolled");
    const record = keys.find((k) => k.keyID === keyID && k.keyID.length > 0);
    if (record === undefined) throw new InboxKeyError("unknown-key", "no retained key matches the task");
    const privateKey = this.runtime.decodeKey(record.privateKey);
    return this.runtime.openSealedContentKey(sealed, privateKey);
  }

  /**
   * Destroy this account's key history.
   *
   * ## Not on sign-out
   *
   * Signing out is reversible and routine; destroying the private history is
   * neither. A key discarded here makes every delivery still queued against it
   * permanently undecryptable, so this is reachable only for an explicit
   * account removal or an explicit Inbox disable — and even then it refuses
   * while deliveries are pending, unless the caller states plainly that it is
   * discarding them.
   */
  async forget(args: {
    readonly reason: "account-removed" | "inbox-disabled";
    /** Deliveries this device could still be asked to decrypt. */
    readonly pendingDeliveries: number;
    /** Required to proceed with pending deliveries; makes the loss deliberate. */
    readonly discardPendingDeliveries?: boolean;
  }): Promise<void> {
    if (args.pendingDeliveries > 0 && args.discardPendingDeliveries !== true) {
      throw new InboxKeyError(
        "pending-deliveries",
        `${args.pendingDeliveries} deliveries still need these keys; refusing to destroy them for ${args.reason}`,
      );
    }
    return this.exclusive(async () => {
      await this.secrets.delete(this.slot);
    });
  }
}
