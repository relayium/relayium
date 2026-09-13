// What arrived, by name — the record the foreground history reads.
//
// ## Why this exists at all, when the journal already records deliveries
//
// The journal is a DIAGNOSTIC record: counts, phases, timestamps, kept for
// crash reconciliation and pruned on its own schedule. It carries no file names
// by design, and putting them there would mean names in a record read by paths
// that have no business with user content and deleted by a rule nobody chose
// for their history.
//
// `DeliveryReceipt` is closed for the same kind of reason: `receipts.ts` states
// that no member may hold a path, a key or a server string, and that is what
// makes it safe to log.
//
// And the receiving FOLDER is not a source either. Re-reading it would report
// whatever is there now rather than what a delivery wrote, would name files the
// user put there themselves, and would need a filesystem reader in main that
// otherwise does not exist.
//
// So the names are captured at receive time, from the manifest the receiver has
// already decoded and validated, and kept in a store whose whole purpose is
// presentation.
//
// ## What a record holds, and what it deliberately does not
//
// Sensitive RELATIVE names — `webkitRelativePath`-shaped, exactly as the
// validated v3 manifest declared them. They are the sender's own file names and
// are treated as user content: sealed at rest, never logged, never in a failure
// string, never in telemetry.
//
// The receiving DIRECTORY is not here. It is main's, it is already in the
// grant, and `revealFolder` is what opens it — a second copy under another name
// is a second thing to leak.
//
// ## Only what was CONFIRMED published
//
// A partial delivery records the prefix that actually landed, never the whole
// manifest. Presenting a manifest as though it were all saved is precisely the
// reassuring lie the receive path spends its length avoiding, and the user
// would find out by opening the folder.
//
// ## Three rules this store is written to, each from an observed failure
//
//  1. **Only an explicit ENOENT means empty.** A catch-all around the read made
//     EACCES or EIO indistinguishable from "nothing has been received", and the
//     very next capture then OVERWROTE a history that could not be read. The
//     journal fixed exactly this and states why; this is the same rule, and the
//     negative control for it is a read that fails with EACCES.
//  2. **Nothing handed out is the store's own state.** `list` answers with a
//     fresh deep copy every time. A caller that edited an item's name used to
//     be editing the cache, so the next `list` returned the edit as though it
//     had been received that way — a history rewritten with no write.
//  3. **A record that is not presentable is REFUSED, never repaired.** Silently
//     truncating a name, clamping an item count or rewriting an invalid size
//     invents presentation metadata: the user is then shown a name no sender
//     ever sent. Both directions validate — a document on disk gets the same
//     treatment as a caller's record, because "written by an older build" and
//     "tampered with" are indistinguishable and neither is a licence to guess.

import { open as openRecord, seal as sealRecord } from "../inbox/atrest.js";
import type { AccountContext } from "../inbox/account.js";

/** The record's own version, so a later shape is refused rather than guessed. */
const PRESENTATION_VERSION = 1;

/**
 * Bounds, refused rather than evicted.
 *
 * The vault's rule and for the vault's reason: dropping the oldest record to
 * make room destroys something the user was shown. A refusal is visible and
 * recoverable; a silent eviction is neither.
 */
export const MAX_PRESENTATION_RECORDS = 500;

/**
 * The protocol's own limits, mirrored — not loosened.
 *
 * These names come from a manifest `inbox-manifest.ts` has already validated,
 * so a name that breaks its rule cannot have arrived through the receive path
 * and must not be persisted as though it had. The values are that module's
 * (`INBOX_MANIFEST_MAX_ITEMS`, `INBOX_MANIFEST_MAX_NAME_BYTES`,
 * `INBOX_MANIFEST_MAX_PATH_DEPTH`) and the checks below are its checks.
 *
 * Restated here rather than imported because `src/main/**` cannot import
 * `web/src/lib/**` (see `runtime-contract.ts` on TS6059), and reaching them
 * through the runtime bundle would make this store depend on a Vite artifact to
 * validate its own input. The duplication is deliberate, and it is a MIRROR:
 * this side may refuse what the protocol accepts, never the reverse.
 */
export const MAX_ITEMS_PER_RECORD = 1000;
export const MAX_NAME_BYTES = 1024;
export const MAX_PATH_DEPTH = 64;
/** Matches `MAX_INBOX_ID_LENGTH` on the IPC boundary. */
export const MAX_TASK_ID_LENGTH = 256;
/** The whole sealed document, so one delivery cannot grow the file unboundedly. */
export const MAX_PRESENTATION_BYTES = 4 * 1024 * 1024;
/**
 * A cheap ceiling applied to the SEALED bytes, before a decrypt is attempted.
 *
 * base64 in a JSON envelope is about 4/3 of the plaintext plus a fixed header,
 * so twice the plaintext cap cannot refuse a document this store itself wrote
 * while still bounding what a decrypt is asked to hold.
 */
export const MAX_SEALED_BYTES = 2 * MAX_PRESENTATION_BYTES;

/** One item that actually landed. A sensitive relative name and its size. */
export interface PresentedItem {
  readonly name: string;
  readonly size: number;
}

export interface PresentationRecord {
  readonly taskID: string;
  readonly receivedAt: number;
  /** True for a message, which lands in the vault rather than on disk. */
  readonly text: boolean;
  /**
   * How many items the delivery DECLARED.
   *
   * Kept beside the confirmed list so a partial is describable as a partial:
   * "3 of 7" is truthful, and a list of three presented alone is not.
   */
  readonly declared: number;
  /** Only the items confirmed published. Never the whole manifest. */
  readonly items: readonly PresentedItem[];
}

interface PresentationDocument {
  readonly v: number;
  readonly records: readonly PresentationRecord[];
}

/**
 * Why a call failed. Four distinct answers, because they are four distinct
 * situations and a caller acts differently on each.
 *
 *  * `unreadable` — the file is there and this process could not read or open
 *    it. NOT empty, and never recovered by starting fresh.
 *  * `malformed` — it opened and its CONTENT is not a valid document.
 *  * `invalid` — the record a CALLER handed in is not presentable. The caller's
 *    input is at fault; nothing on disk is.
 *  * `too-large` — a bound was reached. Nothing is wrong with either side.
 */
export type PresentationFailure = "unreadable" | "malformed" | "invalid" | "too-large";

export class PresentationError extends Error {
  constructor(
    readonly code: PresentationFailure,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "PresentationError";
  }
}

/** The filesystem slice this needs. Structurally `InboxFiles`. */
export interface PresentationFiles {
  readFile(path: string): Promise<Uint8Array>;
  writeAtomic(path: string, bytes: Uint8Array): Promise<void>;
  mkdirp(path: string): Promise<void>;
}

/**
 * One account's presentation history.
 *
 * One instance per `AccountContext`, like every other Inbox store: the context
 * is captured rather than looked up, so a record cannot be written into an
 * account that replaced the one the delivery began under.
 */
export class InboxPresentationStore {
  private readonly path: string;
  private key: CryptoKey | null = null;
  /** Deep-frozen. Nothing inside it is reachable for mutation by a caller. */
  private cache: readonly PresentationRecord[] | null = null;
  /** Serialises the whole read-modify-write, which `writeAtomic` does not. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly context: AccountContext,
    private readonly files: PresentationFiles,
    private readonly atRestKey: () => Promise<CryptoKey>,
  ) {
    this.path = `${context.directory}/presentation.enc`;
  }

  /**
   * Everything this account has been shown to have received, newest first.
   *
   * A fresh deep copy every call. The cache is the store's own state and is
   * never handed out: a caller that edited a returned item used to be editing
   * the history itself, which then read back as though it had arrived that way.
   */
  list(): Promise<readonly PresentationRecord[]> {
    return this.update(async () => copyAll(await this.load()));
  }

  /**
   * Record one delivery.
   *
   * Idempotent by task id: a replayed capture after a crash must not produce a
   * second entry for one delivery. Refused rather than evicting when full, and
   * refused outright when the record is not presentable — see rule 3.
   */
  record(entry: PresentationRecord): Promise<void> {
    return this.update(async () => {
      // Validated BEFORE the load, so a bad record cannot even cause a read of
      // a history it was never going to be allowed to join.
      //
      // INSIDE the body, not before it: a method that returns `Promise<void>`
      // and sometimes throws synchronously cannot be handled with `.catch`, and
      // the one caller that matters here — the receiver's delivered hook — must
      // be able to swallow a capture failure without it escaping as a throw
      // that fails a delivery whose files are already on disk.
      const validated = validateRecord(entry, "invalid");
      const records = await this.load();
      if (records.some((existing) => existing.taskID === validated.taskID)) return;
      if (records.length >= MAX_PRESENTATION_RECORDS) {
        throw new PresentationError("too-large", `${records.length} records are retained`);
      }
      await this.persist([validated, ...records]);
    });
  }

  /** Delete one record, because the user asked for that and nothing else. */
  remove(taskID: string): Promise<void> {
    return this.update(async () => {
      const records = await this.load();
      const next = records.filter((record) => record.taskID !== taskID);
      if (next.length !== records.length) await this.persist(next);
    });
  }

  private async persist(records: readonly PresentationRecord[]): Promise<void> {
    const document: PresentationDocument = { v: PRESENTATION_VERSION, records };
    const plaintext = new TextEncoder().encode(JSON.stringify(document));
    if (plaintext.byteLength > MAX_PRESENTATION_BYTES) {
      throw new PresentationError("too-large", `${plaintext.byteLength} bytes`);
    }
    const sealed = await sealRecord(await this.cryptoKey(), this.context.accountKey, "presentation", plaintext);
    await this.files.mkdirp(this.context.directory);
    await this.files.writeAtomic(this.path, sealed);
    this.cache = freezeAll(records);
  }

  private async load(): Promise<readonly PresentationRecord[]> {
    if (this.cache !== null) return this.cache;
    let sealed: Uint8Array;
    try {
      sealed = await this.files.readFile(this.path);
    } catch (error) {
      // ONLY an explicit ENOENT means "nothing has been recorded yet".
      //
      // The journal states why at length and this is the same rule: a catch-all
      // turned EACCES or EIO into an empty history, and the next capture then
      // overwrote the record that could not be read. A permission blip would
      // have silently destroyed the user's history of what they received.
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") {
        this.cache = Object.freeze([]);
        return this.cache;
      }
      throw new PresentationError("unreadable", `presentation is unavailable (${code ?? "unknown"})`);
    }
    // Bounded BEFORE the decrypt, which is the expensive step and the one that
    // would have to hold the whole document in memory.
    if (sealed.byteLength > MAX_SEALED_BYTES) {
      throw new PresentationError("too-large", `${sealed.byteLength} sealed bytes`);
    }
    let plaintext: Uint8Array;
    try {
      plaintext = await openRecord(await this.cryptoKey(), this.context.accountKey, "presentation", sealed);
    } catch {
      // Present and unopenable. NOT recovered by starting fresh: that would
      // silently discard the user's history, which is the failure this store
      // exists to avoid. The caller reports it as unavailable, which is a
      // different thing from empty.
      throw new PresentationError("unreadable");
    }
    if (plaintext.byteLength > MAX_PRESENTATION_BYTES) {
      throw new PresentationError("too-large", `${plaintext.byteLength} bytes`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      throw new PresentationError("malformed");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new PresentationError("malformed");
    }
    const document = parsed as { v?: unknown; records?: unknown };
    if (document.v !== PRESENTATION_VERSION) throw new PresentationError("malformed");
    if (!Array.isArray(document.records)) throw new PresentationError("malformed");
    // The count bound applies to what is READ as well as to what is written. A
    // document with more records than this store would ever write is not one it
    // may quietly truncate to a length it likes.
    if (document.records.length > MAX_PRESENTATION_RECORDS) {
      throw new PresentationError("too-large", `${document.records.length} records`);
    }
    // Every record validated with the same rule the write side uses. A name
    // that is too long, an item count past the ceiling or a size that is not an
    // exact non-negative integer is refused as malformed — never trimmed into
    // something presentable, which would show the user a name nobody sent.
    const records = (document.records as readonly unknown[]).map((record) =>
      validateRecord(record as PresentationRecord, "malformed"),
    );
    this.cache = freezeAll(records);
    return this.cache;
  }

  private async cryptoKey(): Promise<CryptoKey> {
    this.key ??= await this.atRestKey();
    return this.key;
  }

  private update<T>(body: () => Promise<T>): Promise<T> {
    const run = this.tail.then(body, body);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * Validate one record, or refuse it.
 *
 * `code` is what a refusal is reported as: `invalid` when a caller handed it in,
 * `malformed` when it came off disk. The CHECKS are identical, deliberately —
 * a document written by a build with a different idea of what is presentable is
 * not more trustworthy than a caller with one.
 */
export function validateRecord(record: PresentationRecord, code: "invalid" | "malformed"): PresentationRecord {
  const fail = (why: string): never => {
    // The reason names the FIELD, never its value: these are the user's own
    // file names and this string can reach a log.
    throw new PresentationError(code, why);
  };
  if (record === null || typeof record !== "object" || Array.isArray(record)) fail("record is not an object");
  if (typeof record.taskID !== "string" || record.taskID.length === 0) fail("taskID is missing");
  if (record.taskID.length > MAX_TASK_ID_LENGTH) fail("taskID is too long");
  if (!Number.isSafeInteger(record.receivedAt) || record.receivedAt < 0) fail("receivedAt is not a timestamp");
  if (typeof record.text !== "boolean") fail("text is not a boolean");
  if (!Number.isSafeInteger(record.declared) || record.declared < 0) fail("declared is not a count");
  if (record.declared > MAX_ITEMS_PER_RECORD) fail("declared is past the item ceiling");
  if (!Array.isArray(record.items)) fail("items is not a list");
  if (record.items.length > MAX_ITEMS_PER_RECORD) fail("items is past the item ceiling");
  // The confirmed list is a SUBSET of what was declared. More published than
  // declared is not a partial and not a whole; it is a record that cannot be
  // presented truthfully either way.
  if (record.items.length > record.declared) fail("more items than were declared");
  // A message lands in the vault and has no names at all — `describeManifest`
  // refuses a text item that carries one, and a presentation record claiming
  // otherwise would be describing a delivery that could not have happened.
  if (record.text && record.items.length > 0) fail("a text delivery has no named items");
  const items = record.items.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) fail("item is not an object");
    if (!Number.isSafeInteger(item.size) || item.size < 0) fail("item size is not an exact count");
    const problem = nameProblem(item.name);
    if (problem !== null) fail(`item name: ${problem}`);
    return { name: item.name, size: item.size };
  });
  return { taskID: record.taskID, receivedAt: record.receivedAt, text: record.text, declared: record.declared, items };
}

/**
 * The protocol's own name rule, mirrored.
 *
 * Every clause is `inbox-manifest.ts`'s `nameProblemOf`, and the reasons are
 * its reasons: byte-measured length because the receiving filesystem's limit is
 * a byte limit; no C0 controls because they truncate a C string and rewrite a
 * terminal line as the name is displayed; no backslash because it means
 * "separator" on Windows and the same manifest would otherwise produce
 * different trees on different receivers; no absolute, drive-qualified or
 * dot-segment name because those escape the folder the user chose.
 *
 * Returns a reason, or null when the name is presentable.
 */
function nameProblem(name: unknown): string | null {
  if (typeof name !== "string") return "missing";
  if (name.length === 0) return "empty";
  if (!wellFormed(name)) return "not valid UTF-8";
  const bytes = new TextEncoder().encode(name);
  if (bytes.byteLength > MAX_NAME_BYTES) return "too long";
  for (let i = 0; i < name.length; i += 1) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return "control character";
  }
  if (name.includes("\\")) return "backslash";
  if (name.startsWith("/")) return "absolute path";
  // "C:foo" is drive-relative and "C:/foo" drive-absolute on Windows; both
  // escape a receive folder there while looking ordinary here. BYTE index 1,
  // matching Go's `name[1]` and Swift's `bytes[1]`.
  if (bytes.byteLength >= 2 && bytes[1] === 0x3a) return "drive-qualified path";
  const parts = name.split("/");
  if (parts.length > MAX_PATH_DEPTH) return "too deeply nested";
  for (const part of parts) {
    if (part === "") return "empty path component";
    if (part === "." || part === "..") return "dot path component";
  }
  return null;
}

/** True when every surrogate is paired. A lone one has no UTF-8 encoding. */
function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return false;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** The cache's own copy: deep-frozen, so no internal path can mutate it. */
function freezeAll(records: readonly PresentationRecord[]): readonly PresentationRecord[] {
  return Object.freeze(
    records.map((record) =>
      Object.freeze({
        ...record,
        items: Object.freeze(record.items.map((item) => Object.freeze({ ...item }))),
      }),
    ),
  );
}

/** A caller's copy: fresh objects, so editing one edits nothing of the store's. */
function copyAll(records: readonly PresentationRecord[]): PresentationRecord[] {
  return records.map((record) => ({
    taskID: record.taskID,
    receivedAt: record.receivedAt,
    text: record.text,
    declared: record.declared,
    items: record.items.map((item) => ({ name: item.name, size: item.size })),
  }));
}
