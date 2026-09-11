// Bounded reads of files the OS handed this process, and nothing else.
//
// This is deliberately NOT a path reader. It takes a path once, at staging,
// establishes what that path is, and from then on serves bounded ranges of the
// file it opened. A caller that has a handle cannot ask for a different file,
// and there is no method here that takes a path and returns bytes.
//
// ## What identity binding does, and what it does not
//
// At staging: `lstat` refuses a symlink or a reparse point Node reports as one,
// and refuses anything that is not a regular file or an ordinary directory.
// At open: the handle is `fstat`ed and required to be a regular file whose
// device, inode and size still match what staging saw. Every read re-checks the
// cached handle identity before it moves a byte.
//
// **On Windows the open is now reparse-proof; off Windows it is not.**
//
// Node offers no `O_NOFOLLOW` on Windows and no way to open a path with reparse
// traversal disabled, so between `lstat` and `open` a path component can in
// principle be replaced. That gap is why `relayium-io-helper --source-mode`
// exists: it opens the staged root and then each component relative to the
// handle above it with `FILE_OPEN_REPARSE_POINT`, refusing a reparse point
// everywhere including the root the user picked, and holds every ancestor
// without `FILE_SHARE_DELETE` so none can be renamed away under an open read.
// A final-path comparison would NOT have been enough: the traversal that
// reached the final component has already followed whatever the parents pointed
// at, and a path that looks right can be reached through a junction swapped in
// on the way.
//
// A provider is supplied by the caller. When there is one, bytes come from the
// helper and the reads are bound to an exact, nonzero `FILE_ID_INFO` that is
// replayed on every reopen. When there is none — every platform but Windows,
// and the tests — Node opens the file and this module claims only what the old
// comment claimed: the bytes come from a regular file whose device, inode, size
// and mtime have not changed since it was opened, and a symlink Node can see is
// refused. It does not claim the open itself was reparse-proof.
//
// ## Memory
//
// One buffer per read, at most `MAX_SELECTION_CHUNK`. Nothing is cached, no
// file is ever materialised, and a handle pool bounds how many files are open
// at once regardless of how many are staged.

import { open, lstat, stat, type FileHandle } from "node:fs/promises";
import type {
  NativeSourceHandle,
  NativeSourceProvider,
  SourceIdentity,
} from "./native-source.js";
import { MAX_SELECTION_CHUNK } from "../../shared/os-entry.js";

/**
 * Await `work`, but never past `deadline`.
 *
 * The timer is unref'd and cleared on the settling path, so a fast join leaves
 * nothing pending and a slow one cannot hold the process open by itself.
 */
async function withinDeadline(work: Promise<unknown>, deadline: number): Promise<void> {
  const ms = deadline - Date.now();
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    void work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

/** How many files stay open at once, however many are staged. */
export const MAX_OPEN_HANDLES = 8;

/** What staging established about a path. No content, ever. */
export interface FileIdentity {
  readonly size: number;
  readonly dev: number;
  /** `0` on filesystems that do not report one; then it is not compared. */
  readonly ino: number;
  readonly mtimeMs: number;
}

export type ExamineResult =
  | { readonly kind: "file"; readonly identity: FileIdentity }
  | { readonly kind: "directory" }
  | { readonly kind: "rejected"; readonly reason: "symlink" | "special" | "unreadable" };

/**
 * Reserved device and NT-namespace forms, refused LEXICALLY.
 *
 * This must run before `path.resolve` and before any filesystem call, and the
 * reason is specific: `\\.\C:\picked.txt` names an ORDINARY FILE through the
 * device namespace. `lstat` follows it happily and reports a regular file, so
 * an implementation that relied on `isFile()` being false for device paths —
 * as this one did — staged it. The only reliable refusal is the shape of the
 * string itself.
 *
 * Doing it first also means a named pipe or a device is never probed at all,
 * rather than being opened in order to discover what it is.
 *
 * Covers the Win32 device (`\\.\`) and extended-length/NT (`\\?\`)
 * prefixes, the reserved DOS names in any component — with or without an
 * extension, and with the trailing dots and spaces Win32 strips — and the POSIX
 * device roots, so the rule is the same rule on every platform this runs on.
 */
const DOS_RESERVED = new Set([
  "con", "prn", "aux", "nul", "conin$", "conout$",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

export function isReservedDevicePath(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0) return true;
  // Both separators, because Win32 accepts either in these prefixes.
  const unified = raw.replace(/\\/g, "/");
  if (unified.startsWith("//./") || unified.startsWith("//?/")) return true;
  if (unified === "//." || unified === "//?") return true;
  const lower = unified.toLowerCase();
  // POSIX device roots, so the same refusal holds off Windows too.
  if (lower === "/dev" || lower.startsWith("/dev/")) return true;
  if (lower === "/proc" || lower.startsWith("/proc/")) return true;
  if (lower === "/sys" || lower.startsWith("/sys/")) return true;
  for (const segment of unified.split("/")) {
    if (segment.length === 0) continue;
    // Win32 strips trailing dots and spaces, so `NUL   ` and `nul.` are `nul`.
    const trimmed = segment.replace(/[. ]+$/, "");
    const base = (trimmed.split(".")[0] ?? "").toLowerCase();
    if (DOS_RESERVED.has(base)) return true;
  }
  return false;
}

/**
 * What a path is, before anything is opened.
 *
 * `lstat` rather than `stat`, deliberately: `stat` follows, so it would report
 * the TARGET of a symlink and this would stage a file outside what the user
 * chose.
 */
export async function examine(path: string): Promise<ExamineResult> {
  // Lexical first, so a device or a pipe is never probed to find out.
  if (isReservedDevicePath(path)) return { kind: "rejected", reason: "special" };
  let info;
  try {
    info = await lstat(path);
  } catch {
    return { kind: "rejected", reason: "unreadable" };
  }
  if (info.isSymbolicLink()) return { kind: "rejected", reason: "symlink" };
  if (info.isDirectory()) return { kind: "directory" };
  if (!info.isFile()) {
    // Sockets, FIFOs, block and character devices. A `\\.\` device path lands
    // here too, which is why it is refused before anything is opened.
    return { kind: "rejected", reason: "special" };
  }
  return {
    kind: "file",
    identity: { size: info.size, dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs },
  };
}

/** Whether the thing now at `path` is still what staging examined. */
export function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  if (a.size !== b.size) return false;
  if (a.dev !== b.dev) return false;
  // `ino` is 0 on some Windows filesystems. Comparing it then would refuse
  // every read on those volumes; skipping it is stated rather than silent.
  if (a.ino !== 0 && b.ino !== 0 && a.ino !== b.ino) return false;
  return a.mtimeMs === b.mtimeMs;
}

/**
 * One opened file, however it was opened.
 *
 * The seam exists because the two strategies establish the SAME guarantee by
 * different means and neither can be described in the other's terms. Node binds
 * by device, inode, size and mtime re-read from the descriptor; the helper binds
 * by an exact, nonzero `FILE_ID_INFO` and by having walked every path component
 * relative to a handle it already held. Collapsing them into one shape would
 * mean one of the two claiming a check it does not perform.
 */
interface OpenSource {
  /**
   * At most `length` bytes from `position`.
   *
   * Fewer than asked for means the file is no longer what was staged; the
   * caller reports that rather than padding or calling it the end.
   */
  read(length: number, position: number): Promise<Uint8Array>;
  /** Whether this still refers to the file staging saw. */
  verify(expected: FileIdentity): Promise<boolean>;
  close(): Promise<void>;
}

export type ReadOutcome =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "changed" }
  | { readonly kind: "bad-range" }
  /**
   * The handle budget is full and every held descriptor is in use.
   *
   * Refused rather than exceeded. Evicting a file with a read in flight would
   * corrupt that read, and opening a ninth would make the bound a suggestion.
   * The serial encryptor never reaches this: it reads one file at a time, so
   * the others are idle and evictable.
   */
  | { readonly kind: "at-capacity" }
  | { readonly kind: "failed" };

/**
 * One file this process OWNS, in whatever state that ownership is in.
 *
 * The states matter because `leftover` must count ownership, not map
 * membership. An earlier shape counted `#open.size` after a bounded wait, so:
 *
 *   * an acquisition still in flight was invisible — no entry existed yet;
 *   * a close that had not settled was invisible — `#shut` deleted the entry
 *     BEFORE awaiting `close()`;
 *   * a close that REJECTED kept only an id, so the handle was unreachable and
 *     no later teardown could ever retry it.
 *
 * All three reported zero while a descriptor was still held. An entry now lives
 * from the moment an open is attempted until a close actually succeeds.
 */
type OwnedState = "acquiring" | "open" | "closing" | "failed-close";

interface Owned {
  /** Null only while `acquiring`. Retained through a failed close. */
  source: OpenSource | null;
  identity: FileIdentity | null;
  /** Reads in flight on this handle. A close waits for them. */
  inFlight: number;
  state: OwnedState;
  /** The close in flight, so a teardown can join it rather than guess. */
  closing: Promise<void> | null;
  /**
   * A release asked for while this was still `acquiring`.
   *
   * `release` used to return silently in that state, so the handle the open was
   * about to produce stayed open until a global dispose — a file the caller had
   * explicitly finished with, held for the life of the process.
   */
  releaseRequested: boolean;
}

/** What one open attempt achieved, so ownership is never ambiguous. */
type OpenAttempt =
  /** Opened, and it is what staging saw. */
  | { readonly kind: "opened"; readonly source: OpenSource; readonly identity: FileIdentity }
  /**
   * Opened, and it is NOT what staging saw.
   *
   * The source is handed back rather than closed here, so the caller closes it
   * through `#shut` — which is what retains a descriptor whose close FAILS and
   * keeps it counted. A strategy that tidied up after itself would make exactly
   * that case invisible.
   */
  | { readonly kind: "rejected"; readonly source: OpenSource }
  /** Nothing was opened; there is no descriptor to account for. */
  | { readonly kind: "none" };

/** Node's own descriptor. The portable path, and the only one off Windows. */
class NodeSource implements OpenSource {
  readonly #handle: FileHandle;
  constructor(handle: FileHandle) {
    this.#handle = handle;
  }
  async read(length: number, position: number): Promise<Uint8Array> {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await this.#handle.read(buffer, 0, length, position);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
  }
  /** `fstat` on the descriptor itself: no name is resolved to answer this. */
  async verify(expected: FileIdentity): Promise<boolean> {
    let now;
    try {
      now = await this.#handle.stat();
    } catch {
      return false;
    }
    if (!now.isFile()) return false;
    return sameIdentity(expected, { size: now.size, dev: now.dev, ino: now.ino, mtimeMs: now.mtimeMs });
  }
  close(): Promise<void> {
    return this.#handle.close();
  }
}

/**
 * A handle the helper opened by walking every component itself.
 *
 * ## Bytes and the change check come from different places, deliberately
 *
 * The BYTES come from the helper's handle, which no name resolution can
 * redirect: every component was opened relative to a handle already held, with
 * reparse traversal disabled, and the ancestors stay pinned for the life of the
 * source.
 *
 * The CHANGE check is still Node's `examine` on the path, because the helper
 * protocol has no stat verb and inventing one would mean re-proving a protocol
 * on Windows to answer a question this already answers safely. It is safe
 * because of which way it can fail: if a component were redirected between two
 * checks, `examine` describes a DIFFERENT file, the identity does not match, and
 * the read is refused. A redirected check can cost a spurious refusal; it cannot
 * cause the wrong bytes to be served, because the bytes never come from it.
 */
class HelperSource implements OpenSource {
  readonly #handle: NativeSourceHandle;
  readonly #path: string;
  constructor(handle: NativeSourceHandle, path: string) {
    this.#handle = handle;
    this.#path = path;
  }
  async read(length: number, position: number): Promise<Uint8Array> {
    const { bytes } = await this.#handle.read(position, length);
    return bytes;
  }
  async verify(expected: FileIdentity): Promise<boolean> {
    const now = await examine(this.#path);
    return now.kind === "file" && sameIdentity(expected, now.identity);
  }
  async close(): Promise<void> {
    // `failed-close` is the helper still HOLDING the handle, which is exactly
    // what the caller's retained-entry accounting exists to record.
    if ((await this.#handle.close()) === "failed-close") {
      throw new Error("the helper did not release the handle");
    }
  }
}

/**
 * Open through Node, and establish what was opened from the descriptor.
 *
 * `lstat` again immediately before the open. It does not close the race — see
 * the header — but it refuses a path that has BECOME a symlink since staging,
 * which is the cheap half of the protection.
 */
async function openThroughNode(path: string, expected: FileIdentity): Promise<OpenAttempt> {
  const before = await examine(path);
  if (before.kind !== "file" || !sameIdentity(expected, before.identity)) return { kind: "none" };
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    return { kind: "none" };
  }
  const source = new NodeSource(handle);
  let opened;
  try {
    opened = await handle.stat();
  } catch {
    return { kind: "rejected", source };
  }
  const identity = { size: opened.size, dev: opened.dev, ino: opened.ino, mtimeMs: opened.mtimeMs };
  if (!opened.isFile() || !sameIdentity(expected, identity)) return { kind: "rejected", source };
  return { kind: "opened", source, identity };
}

/**
 * The open files, bounded, keyed by an opaque id the caller owns.
 *
 * The reader never sees a token: the feature maps token → id → path, so a
 * capability and a file handle are separate things and neither is derivable
 * from the other.
 */
export class SelectionReader {
  /** Every file owned right now, in any state. */
  readonly #owned = new Map<string, Owned>();
  /** Insertion order is the eviction order. */
  readonly #order: string[] = [];
  /** Whole operations in flight — acquisition AND read. */
  readonly #operations = new Set<Promise<unknown>>();
  /** One acquisition per id, so two concurrent reads cannot open two handles. */
  readonly #acquiring = new Map<string, Promise<Owned | null>>();
  /**
   * Admissions taken but not yet represented by an entry.
   *
   * The bound has to be enforced SYNCHRONOUSLY against total ownership, or a
   * burst of concurrent reads all pass a check none of them has yet affected —
   * twelve opens beginning under a cap of eight.
   */
  #reserved = 0;
  #disposed = false;
  /**
   * The helper, when this platform has one. Null means Node opens the files.
   *
   * Supplied rather than constructed here so this module stays testable off
   * Windows and so the decision about whether a native guarantee exists is made
   * in ONE place — `createNativeSourceProvider`, which answers null off Windows
   * and fails closed on it.
   */
  readonly #native: NativeSourceProvider | null;
  /**
   * What the helper said each file WAS, the first time it opened it.
   *
   * A file may be reopened after an eviction, and between the two opens the
   * name can come to mean something else. The first identity is replayed as the
   * expected one, so a reopen that lands on a different object is refused
   * terminally rather than read.
   */
  readonly #bound = new Map<string, SourceIdentity>();

  constructor(native: NativeSourceProvider | null = null) {
    this.#native = native;
  }

  /**
   * Files this process still holds, in ANY state.
   *
   * Acquiring, open, closing and failed-close all count: each is a descriptor
   * this process is responsible for, and a teardown reporting only the settled
   * ones would claim a release it had not achieved.
   */
  get openCount(): number {
    return this.#owned.size;
  }

  /** Read one bounded range. Every check happens before a byte moves. */
  async read(
    id: string,
    path: string,
    expected: FileIdentity,
    offset: number,
    length: number,
  ): Promise<ReadOutcome> {
    if (this.#disposed) return { kind: "failed" };
    if (!Number.isSafeInteger(offset) || offset < 0) return { kind: "bad-range" };
    if (!Number.isSafeInteger(length) || length <= 0) return { kind: "bad-range" };
    if (length > MAX_SELECTION_CHUNK) return { kind: "bad-range" };
    if (offset >= expected.size) return { kind: "bad-range" };

    // Registered BEFORE the acquisition, so a teardown in the same tick finds
    // this operation rather than an empty set.
    let settle!: () => void;
    const operation = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.#operations.add(operation);
    try {
      const entry = await this.#acquire(id, path, expected);
      if (entry === "at-capacity") return { kind: "at-capacity" };
      if (entry === null || entry.source === null) return { kind: "changed" };
      if (this.#disposed) return { kind: "failed" };

      // Clamped to the size staging measured. A file that grew is not read past
      // what was declared; one that shrank fails the identity check.
      const want = Math.min(length, expected.size - offset);
      entry.inFlight += 1;
      try {
        const bytes = await entry.source.read(want, offset);
        if (bytes.length !== want) {
          // Short of what the size says is available. Reported, never padded
          // and never passed off as the end: a truncated send that calls itself
          // complete is the failure this refuses.
          return { kind: "changed" };
        }
        return { kind: "bytes", bytes };
      } catch {
        return { kind: "failed" };
      } finally {
        entry.inFlight -= 1;
        if (entry.state === "closing" && entry.inFlight === 0) await this.#shut(id, entry);
      }
    } finally {
      this.#operations.delete(operation);
      settle();
    }
  }

  /** The open handle for `id`, opening it if needed. Single-flight per id. */
  async #acquire(
    id: string,
    path: string,
    expected: FileIdentity,
  ): Promise<Owned | null | "at-capacity"> {
    const pending = this.#acquiring.get(id);
    if (pending !== undefined) return pending;
    const held = this.#owned.get(id);
    if (held !== undefined && held.state === "open" && held.source !== null) {
      if (!(await held.source.verify(expected))) {
        await this.#release(id);
        return null;
      }
      return held;
    }
    if (held !== undefined) return null; // closing or failed-close: not usable

    // ## The bound, enforced before anything is opened
    //
    // Counted over TOTAL ownership — acquiring, open, closing and failed-close
    // — plus reservations taken in this same tick. A slot is freed by actually
    // closing an idle file and waiting for it, never by dropping one or by
    // evicting one with a read in flight.
    if (this.#totalOwned() >= MAX_OPEN_HANDLES) {
      const freed = await this.#evictOne();
      // Re-checked synchronously after the await, and the reservation below is
      // taken with nothing awaited in between.
      if (!freed || this.#totalOwned() >= MAX_OPEN_HANDLES) return "at-capacity";
    }
    this.#reserved += 1;

    const run = this.#openFresh(id, path, expected).finally(() => {
      this.#reserved -= 1;
      if (this.#acquiring.get(id) === run) this.#acquiring.delete(id);
    });
    this.#acquiring.set(id, run);
    return run;
  }

  /** Every descriptor this process is responsible for, plus pending admissions. */
  #totalOwned(): number {
    return this.#owned.size + this.#reserved;
  }

  /**
   * Close one idle file and wait for it, freeing a slot.
   *
   * Returns whether a slot actually became free. A file with a read in flight
   * is never chosen: evicting it would corrupt the read that is using it.
   */
  async #evictOne(): Promise<boolean> {
    const victim = this.#order.find((candidate) => {
      const entry = this.#owned.get(candidate);
      return entry !== undefined && entry.state === "open" && entry.inFlight === 0;
    });
    if (victim === undefined) return false;
    const before = this.#owned.size;
    await this.#release(victim);
    return this.#owned.size < before;
  }

  /** Open one file, once. Only ever reached through the single-flight above. */
  async #openFresh(id: string, path: string, expected: FileIdentity): Promise<Owned | null> {
    if (this.#disposed) return null;
    // The entry exists from the moment an open is ATTEMPTED, so a teardown
    // during the open counts it rather than seeing an empty registry.
    const entry: Owned = {
      source: null,
      identity: null,
      inFlight: 0,
      state: "acquiring",
      closing: null,
      releaseRequested: false,
    };
    this.#owned.set(id, entry);
    this.#order.push(id);
    try {
      const attempt =
        this.#native === null
          ? await openThroughNode(path, expected)
          : await this.#openThroughHelper(id, path, expected);
      if (attempt.kind === "none") {
        this.#forget(id, entry);
        return null;
      }
      if (attempt.kind === "rejected") {
        // Owned from here: closing is what releases it, and a failed close is
        // retained rather than dropped.
        entry.source = attempt.source;
        await this.#shut(id, entry);
        return null;
      }
      entry.source = attempt.source;
      entry.identity = attempt.identity;
      entry.state = "open";
      // A release asked for while this was acquiring is honoured now, rather
      // than leaving the handle open until a global teardown.
      if (entry.releaseRequested || this.#disposed) {
        await this.#shut(id, entry);
        return null;
      }
      return entry;
    } catch {
      this.#forget(id, entry);
      return null;
    }
  }

  /**
   * Open through the helper, binding the result to what it first was.
   *
   * The cheap half runs first and unchanged: `examine` refuses a path that has
   * BECOME a symlink since staging without spending a subprocess round trip on
   * it. What the helper adds is the half Node cannot do — every component opened
   * relative to a handle already held, so no ancestor can redirect the open.
   */
  async #openThroughHelper(id: string, path: string, expected: FileIdentity): Promise<OpenAttempt> {
    const native = this.#native;
    if (native === null) return { kind: "none" };
    const before = await examine(path);
    if (before.kind !== "file" || !sameIdentity(expected, before.identity)) return { kind: "none" };
    let handle: NativeSourceHandle;
    try {
      // The bound identity is replayed on every reopen. A mismatch rejects the
      // open inside the provider and never yields a handle, which is why this
      // returns `none` rather than `rejected`.
      handle = await native.open(path, this.#bound.get(id));
    } catch {
      return { kind: "none" };
    }
    const source = new HelperSource(handle, path);
    if (handle.size !== expected.size) return { kind: "rejected", source };
    this.#bound.set(id, handle.identity);
    return { kind: "opened", source, identity: before.identity };
  }

  /** Drop an entry that never came to own a descriptor. */
  #forget(id: string, entry: Owned): void {
    if (this.#owned.get(id) !== entry) return;
    if (entry.source !== null) return; // owned; only a close may remove it
    this.#owned.delete(id);
    const at = this.#order.indexOf(id);
    if (at >= 0) this.#order.splice(at, 1);
  }

  /** Close one file. A read in flight finishes first. */
  async release(id: string): Promise<void> {
    await this.#release(id);
  }

  async #release(id: string): Promise<void> {
    const entry = this.#owned.get(id);
    if (entry === undefined) return;
    if (entry.state === "acquiring") {
      // MARKED, not ignored. `#openFresh` closes it as soon as it has a handle.
      entry.releaseRequested = true;
      return;
    }
    if (entry.inFlight > 0) {
      entry.state = "closing";
      return;
    }
    await this.#shut(id, entry);
  }

  /**
   * Close, and only forget once the close has actually SUCCEEDED.
   *
   * Deleting the entry before awaiting `close()` made a hanging close invisible,
   * and a rejected one unreachable. The handle is retained on failure so a later
   * teardown can retry it — an id alone could never release anything.
   */
  async #shut(id: string, entry: Owned): Promise<void> {
    if (this.#owned.get(id) !== entry) return;
    const source = entry.source;
    if (source === null) {
      this.#forget(id, entry);
      return;
    }
    if (entry.closing !== null) {
      await entry.closing;
      return;
    }
    entry.state = "closing";
    const run = source.close().then(
      () => {
        // Released. Only now is the entry gone.
        if (this.#owned.get(id) === entry) {
          this.#owned.delete(id);
          const at = this.#order.indexOf(id);
          if (at >= 0) this.#order.splice(at, 1);
        }
      },
      () => {
        // Still owned, and the HANDLE is kept so a retry has something to act
        // on. Counted in `openCount` and in `leftover`.
        entry.state = "failed-close";
        entry.closing = null;
      },
    );
    entry.closing = run;
    await run;
  }

  /** Try again on every handle whose close previously rejected. */
  async #retryFailed(deadline: number): Promise<void> {
    const failed = [...this.#owned].filter(([, entry]) => entry.state === "failed-close");
    if (failed.length === 0) return;
    await withinDeadline(
      Promise.allSettled(failed.map(([id, entry]) => this.#shut(id, entry))),
      deadline,
    );
  }

  /**
   * Close everything, terminally.
   *
   * `leftover` is every descriptor still owned once the bounded join is over —
   * acquiring, open, closing and failed-close alike.
   */
  async disposeAll(budgetMs = 5_000): Promise<{ readonly leftover: number }> {
    this.#disposed = true;
    return this.closeAll(budgetMs);
  }

  /**
   * Close every handle, but stay USABLE.
   *
   * The recoverable half of a teardown. A quit prompt the user answers with
   * Stay must leave a staged selection readable: marking the reader terminally
   * disposed there made every later read fail for the life of the process.
   * Handles are re-opened on the next read, with the identity check applied
   * again — recovery is a re-verification, not a weakening.
   */
  async closeAll(budgetMs = 5_000): Promise<{ readonly leftover: number }> {
    // ONE deadline across every join below.
    const deadline = Date.now() + Math.max(0, budgetMs);

    // Operations first: acquisition and read, not read alone.
    await withinDeadline(Promise.allSettled([...this.#operations]), deadline);
    // Then the closes, inside the SAME deadline and concurrently.
    await withinDeadline(
      Promise.allSettled([...this.#owned.keys()].map((id) => this.#release(id))),
      deadline,
    );
    // Anything the first pass left closing, plus a retry of failed closes.
    await withinDeadline(
      Promise.allSettled(
        [...this.#owned].map(([, entry]) => entry.closing ?? Promise.resolve()),
      ),
      deadline,
    );
    await this.#retryFailed(deadline);
    await withinDeadline(
      Promise.allSettled([...this.#owned.keys()].map((id) => this.#release(id))),
      deadline,
    );
    // The truth after the bounded join: everything still owned, in any state.
    return { leftover: this.#owned.size };
  }

  /** A directory that is a real directory, for the walk. Never follows. */
  static async isWalkableDirectory(path: string): Promise<boolean> {
    const result = await examine(path);
    return result.kind === "directory";
  }

  /** The real path's device+inode, for cycle detection during a walk. */
  static async directoryIdentity(path: string): Promise<string | null> {
    try {
      const info = await stat(path);
      if (!info.isDirectory()) return null;
      return `${String(info.dev)}:${String(info.ino)}`;
    } catch {
      return null;
    }
  }
}
