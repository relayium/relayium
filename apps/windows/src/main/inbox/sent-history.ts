// Local presentation history, separate from delivery/recovery plans. Removing
// a row never cancels a task or releases ciphertext. Updates only edit existing
// rows, so a late delivery result cannot resurrect a row the user deleted.
import type { AccountContext } from "./account.js";
import { importAtRestKey, open, seal } from "./atrest.js";
import { validateRecord, type PresentationFiles } from "../features/inbox-presentation.js";
import { TASK_STATES, type InboxSentHistoryView, type InboxSentState } from "../../shared/ipc-contract.js";

export const MAX_SENT_HISTORY = 500;
export const MAX_SENT_HISTORY_BYTES = 4 * 1024 * 1024;
const STATES: readonly string[] = ["preparing", "unconfirmed", "cancelled", "refused", "removed", ...TASK_STATES];
function names(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("inbox history: invalid peers");
  const entries = Object.entries(value);
  if (entries.length > 1000 || entries.some(([id, name]) => !/^[A-Za-z0-9_-]{1,256}$/.test(id)
    || typeof name !== "string" || name.length > 256 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(name))) throw new Error("inbox history: invalid peers");
  return Object.fromEntries(entries);
}

function validate(value: unknown): InboxSentHistoryView {
  const fail = (): never => { throw new Error("inbox history: invalid record"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const entry = value as InboxSentHistoryView;
  if (typeof entry.id !== "string" || !/^job-[a-f0-9]+$/.test(entry.id) || entry.id.length > 64) return fail();
  if (typeof entry.peerID !== "string" || entry.peerID.length === 0 || entry.peerID.length > 256) return fail();
  if (entry.kind !== "file" && entry.kind !== "text") return fail();
  if (!STATES.includes(entry.state)) return fail();
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) return fail();
  const checked = validateRecord({ taskID: entry.id, receivedAt: entry.createdAt, text: entry.kind === "text",
    declared: entry.kind === "text" ? 1 : entry.items?.length, items: entry.items }, "invalid");
  if (entry.body !== null && (entry.kind !== "text" || typeof entry.body !== "string" ||
    new TextEncoder().encode(entry.body).byteLength !== entry.bytes)) return fail();
  if (entry.kind === "text" && (entry.bytes < 1 || entry.bytes > 65536)) return fail();
  if (entry.kind === "file" && checked.items.reduce((n, item) => n + item.size, 0) !== entry.bytes) return fail();
  return { id: entry.id, peerID: entry.peerID, kind: entry.kind, createdAt: entry.createdAt,
    bytes: entry.bytes, body: entry.body, items: checked.items, state: entry.state };
}

export class SentHistoryStore {
  private readonly path: string;
  private tail: Promise<unknown> = Promise.resolve();
  private key: Promise<CryptoKey> | null = null;
  private records: readonly InboxSentHistoryView[] | null = null;
  private deleted = new Set<string>();
  private peers: Record<string, string> = {};
  constructor(private readonly context: AccountContext, private readonly files: PresentationFiles,
    private readonly keyBytes: () => Promise<Uint8Array>) { this.path = `${context.directory}/sent-history.enc`; }

  private cryptoKey(): Promise<CryptoKey> {
    if (!this.key) {
      const key = this.keyBytes().then(importAtRestKey);
      this.key = key;
      void key.catch(() => { if (this.key === key) this.key = null; });
    }
    return this.key;
  }
  private serial<T>(body: () => Promise<T>): Promise<T> {
    const running = this.tail.then(body, body);
    this.tail = running.then(() => undefined, () => undefined); return running;
  }
  private async load(): Promise<readonly InboxSentHistoryView[]> {
    if (this.records) return this.records;
    let bytes: Uint8Array;
    try { bytes = await this.files.readFile(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return this.records = [];
      throw new Error("inbox history: unreadable");
    }
    if (bytes.byteLength > MAX_SENT_HISTORY_BYTES * 2) throw new Error("inbox history: too large");
    const plaintext = await open(await this.cryptoKey(), this.context.accountKey, "sent-history", bytes);
    if (plaintext.byteLength > MAX_SENT_HISTORY_BYTES) throw new Error("inbox history: too large");
    let doc: { v?: unknown; entries?: unknown; deleted?: unknown; peers?: unknown };
    try { doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as typeof doc; }
    catch { throw new Error("inbox history: malformed"); }
    if (!doc || doc.v !== 1 || !Array.isArray(doc.entries) || doc.entries.length > MAX_SENT_HISTORY) throw new Error("inbox history: malformed");
    const records = doc.entries.map(validate);
    const deleted = doc.deleted ?? [];
    if (!Array.isArray(deleted) || deleted.length > 10000 || deleted.some((id) => typeof id !== "string" || !/^job-[a-f0-9]{1,60}$/.test(id))) throw new Error("inbox history: malformed");
    this.deleted = new Set(deleted as string[]);
    if (records.some((entry) => this.deleted.has(entry.id))) throw new Error("inbox history: malformed");
    if (new Set(records.map((entry) => entry.id)).size !== records.length) throw new Error("inbox history: duplicate");
    this.peers = names(doc.peers ?? {});
    return this.records = records;
  }
  private async persist(records: readonly InboxSentHistoryView[], deleted = this.deleted, peers = this.peers): Promise<void> {
    const raw = new TextEncoder().encode(JSON.stringify({ v: 1, entries: records, deleted: [...deleted], peers }));
    if (raw.byteLength > MAX_SENT_HISTORY_BYTES) throw new Error("inbox history: too large");
    const bytes = await seal(await this.cryptoKey(), this.context.accountKey, "sent-history", raw);
    await this.files.mkdirp(this.context.directory); await this.files.writeAtomic(this.path, bytes);
    this.records = records;
    this.deleted = new Set(deleted);
    this.peers = peers;
  }
  peerNames(): Promise<Readonly<Record<string, string>>> {
    return this.serial(async () => { await this.load(); return { ...this.peers }; });
  }
  /** Authenticated account roster only; historical aliases never grant send authority. */
  rememberPeers(value: Readonly<Record<string, string>>): Promise<void> {
    const snapshot = names(value);
    return this.serial(async () => {
      const entries = await this.load();
      if (Object.entries(snapshot).every(([id, name]) => Object.hasOwn(this.peers, id) && this.peers[id] === name)) return;
      await this.persist(entries, this.deleted, names({ ...this.peers, ...snapshot }));
    });
  }
  list(): Promise<readonly InboxSentHistoryView[]> {
    return this.serial(async () => (await this.load()).map((entry) => validate(entry)));
  }
  record(input: InboxSentHistoryView): Promise<void> {
    // Copy before awaiting: the renderer/caller cannot mutate a queued record.
    let checked: InboxSentHistoryView;
    try { checked = validate(input); } catch (error) { return Promise.reject(error); }
    return this.serial(async () => {
      const entries = await this.load();
      if (this.deleted.has(checked.id)) return;
      if (entries.some((entry) => entry.id === checked.id)) return;
      if (entries.length >= MAX_SENT_HISTORY) throw new Error("inbox history: full");
      await this.persist([checked, ...entries]);
    });
  }
  update(id: string, change: { readonly state?: InboxSentState; readonly body?: string }): Promise<void> {
    const snapshot = { ...change };
    return this.serial(async () => {
      const records = await this.load();
      if (!records.some((entry) => entry.id === id)) return;
      await this.persist(records.map((entry) => entry.id === id ? validate({ ...entry, ...snapshot }) : entry));
    });
  }
  remove(ids: readonly string[]): Promise<void> {
    const snapshot = new Set(ids);
    return this.serial(async () => {
      const records = await this.load(); const next = records.filter((entry) => !snapshot.has(entry.id));
      const deleted = new Set([...this.deleted, ...records.filter((entry) => snapshot.has(entry.id)).map((entry) => entry.id)]);
      if (deleted.size > 10000) throw new Error("inbox history: too large");
      if (next.length !== records.length) await this.persist(next, deleted);
    });
  }
}
