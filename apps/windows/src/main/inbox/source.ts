// The send-side chunk-source lease: invariant 7.
//
// ## Why a lease and not a path
//
// The renderer picks what to send. It cannot hand that choice to main as a
// filesystem path — a compromised renderer would then be naming arbitrary files
// for main to read and encrypt — and it cannot hand over the `File` object
// either, because a `File` does not survive IPC.
//
// So the renderer gets an OPAQUE LEASE ID and nothing else. Main owns the
// actual source: an `AsyncIterable` of plaintext chunks it created itself, from
// something the user genuinely chose. The id is a handle to that, and the only
// thing it can be used for is "send the thing I already picked". It names no
// path, carries no key, and is meaningless outside this process.
//
// ## One-shot, bounded, and expiring
//
// A lease is consumed exactly once: a second `take` of the same id fails rather
// than streaming the user's file twice. Leases are bounded in number and expire,
// because a renderer that creates them and never sends would otherwise pin every
// source it ever picked for the life of the process.
import { randomBytes } from "node:crypto";

/** Live leases at once. A registry, not an unbounded map. */
export const MAX_LIVE_LEASES = 32;

/** How long an unused lease survives. */
export const LEASE_TTL_MS = 10 * 60 * 1000;

/** Bytes in one plaintext chunk handed to the encryptor. */
export const MAX_SOURCE_CHUNK_BYTES = 192 * 1024;

export type SourceFailure =
  | "no-such-lease"
  | "already-taken"
  | "expired"
  | "too-many-leases"
  | "chunk-too-large"
  | "length-mismatch"
  | "malformed";

export class SourceLeaseError extends Error {
  constructor(
    readonly code: SourceFailure,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "SourceLeaseError";
  }
}

/** One item the user chose. `name` is a manifest name, never a path on disk. */
export interface SourceItem {
  /** Manifest name. May contain "/" for a folder send; never a local path. */
  readonly name: string;
  readonly size: number;
  /**
   * The plaintext bytes, in order.
   *
   * An `AsyncIterable` so nothing whole-file is ever in memory, and so the
   * source can be a stream, a picked file or a test fake without this file
   * knowing which.
   */
  chunks(signal: AbortSignal): AsyncIterable<Uint8Array>;
}

/** What a caller learns about a lease without consuming it. */
export interface SourceLeaseSummary {
  readonly id: string;
  readonly itemCount: number;
  readonly totalBytes: number;
  readonly expiresAt: number;
}

interface LeaseEntry {
  readonly id: string;
  readonly items: readonly SourceItem[];
  readonly totalBytes: number;
  readonly expiresAt: number;
  taken: boolean;
}

/**
 * The registry. One per main process.
 *
 * `now` is injected so expiry is provable without waiting for a wall clock, and
 * so a test cannot pass by being fast.
 */
export class SourceLeaseRegistry {
  private readonly leases = new Map<string, LeaseEntry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Live, unexpired leases. Expired entries are dropped as a side effect. */
  get size(): number {
    this.sweep();
    return this.leases.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.leases) {
      if (entry.expiresAt <= now) this.leases.delete(id);
    }
  }

  /**
   * Register what the user picked and return its opaque id.
   *
   * The id is random and unguessable rather than sequential: a sequential
   * handle would let anything able to send one IPC message enumerate the leases
   * belonging to other operations.
   */
  create(items: readonly SourceItem[]): SourceLeaseSummary {
    this.sweep();
    if (items.length === 0) throw new SourceLeaseError("malformed", "a lease with no items");
    if (this.leases.size >= MAX_LIVE_LEASES) {
      throw new SourceLeaseError("too-many-leases", `${this.leases.size} leases are already live`);
    }
    let totalBytes = 0;
    for (const item of items) {
      if (!Number.isSafeInteger(item.size) || item.size < 0) {
        throw new SourceLeaseError("malformed", "an item size is not a safe non-negative integer");
      }
      if (item.name.length === 0) throw new SourceLeaseError("malformed", "an item has no name");
      totalBytes += item.size;
      if (!Number.isSafeInteger(totalBytes)) {
        throw new SourceLeaseError("malformed", "the item sizes overflow an exact integer");
      }
    }
    const id = randomBytes(16).toString("hex");
    const entry: LeaseEntry = {
      id,
      items: Object.freeze([...items]),
      totalBytes,
      expiresAt: this.now() + LEASE_TTL_MS,
      taken: false,
    };
    this.leases.set(id, entry);
    return Object.freeze({ id, itemCount: items.length, totalBytes, expiresAt: entry.expiresAt });
  }

  /** Look at a lease without consuming it. */
  peek(id: string): SourceLeaseSummary {
    const entry = this.entry(id);
    return Object.freeze({
      id: entry.id,
      itemCount: entry.items.length,
      totalBytes: entry.totalBytes,
      expiresAt: entry.expiresAt,
    });
  }

  private entry(id: string): LeaseEntry {
    this.sweep();
    const entry = this.leases.get(id);
    if (entry === undefined) {
      // Expired and never-existed are the same answer on purpose: telling a
      // caller which one it was would let it learn that some other operation
      // once held that id.
      throw new SourceLeaseError("no-such-lease");
    }
    return entry;
  }

  /**
   * Consume a lease.
   *
   * One-shot: the entry is removed before the items are returned, so even a
   * caller that re-enters cannot stream the same source twice.
   */
  take(id: string): readonly SourceItem[] {
    const entry = this.entry(id);
    if (entry.taken) throw new SourceLeaseError("already-taken");
    entry.taken = true;
    this.leases.delete(id);
    return entry.items;
  }

  /** Drop a lease the user cancelled. Unknown ids are not an error here. */
  release(id: string): void {
    this.leases.delete(id);
  }

  /** Drop everything. Used when the account changes. */
  clear(): void {
    this.leases.clear();
  }
}

/**
 * Read one item's plaintext, enforcing the chunk bound and the declared size.
 *
 * ## Why the declared size is checked here
 *
 * The manifest the recipient verifies against is built from `item.size`. If the
 * source yielded a different number of bytes, the delivery would encrypt to a
 * length the manifest does not describe and the receiver would refuse it after
 * the whole thing had been uploaded. Failing at the source is the same verdict,
 * a great deal earlier, and it is the only place both numbers are visible.
 */
export async function* readItem(item: SourceItem, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  let seen = 0;
  for await (const chunk of item.chunks(signal)) {
    if (signal.aborted) throw new SourceLeaseError("malformed", "the source was aborted");
    if (chunk.byteLength > MAX_SOURCE_CHUNK_BYTES) {
      throw new SourceLeaseError("chunk-too-large", `a chunk of ${chunk.byteLength} bytes`);
    }
    seen += chunk.byteLength;
    if (seen > item.size) {
      // Refused mid-stream rather than at the end: a source that keeps yielding
      // is one this side must stop reading, not one to measure.
      throw new SourceLeaseError("length-mismatch", "the source yielded more bytes than it declared");
    }
    yield chunk;
  }
  if (seen !== item.size) {
    throw new SourceLeaseError("length-mismatch", "the source yielded fewer bytes than it declared");
  }
}
