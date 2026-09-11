// Where a finished receive went, kept just long enough to show the user.
//
// ## What this is for
//
// A transfer that has been published is over: the lease is gone, the handle is
// closed, and nothing in this process holds the directory any more. That is
// correct for the receive machinery — its entries exist to be torn down — and
// it is exactly why "open the folder" had nowhere to read from. This keeps the
// one fact that outlives the resource, and nothing else.
//
// ## What it deliberately is NOT
//
// It is not a history, not a log, and not a record of what was received. It
// holds no file names, no sizes, no peer, no time the user can read back. It is
// a short, bounded map from an opaque token to a directory the USER chose in a
// native dialog main opened — which is the only kind of path that may ever be
// in it.
//
// It is also not a lease. Nothing here owns a handle, a child process or staged
// bytes, and losing an entry costs a button, not data. That is the whole reason
// it is a separate module: `AppService`'s map is built around the promise that
// every entry owns something that must be retired, and a path with nothing
// behind it would quietly break that.
//
// ## The one thing it CANNOT check, stated plainly
//
// **This module cannot tell whether a publication actually succeeded.** It is
// handed a directory and told a receive finished; it has no way to verify that,
// and it does not pretend to. "Register only after a successful publish" is a
// contract the CALLER keeps, and a green test here is not evidence the caller
// kept it. The wiring that mints is where that has to be proven.
import { randomBytes } from "node:crypto";

import {
  RECEIPT_TOKEN_BYTES,
  isReceiptToken,
  type ReceiptToken,
  type ReceiveReceipt,
  type RevealOutcome,
  type RevealRefusal,
} from "../../shared/receive-receipt.js";

/**
 * Who a receipt belongs to.
 *
 * The same three facts a receive lease is bound by, and for the same reasons: a
 * grant is authority the document that asked gave, and an account-authorised
 * destination stops being this account's the moment the account changes.
 */
export interface ReceiptOwner {
  readonly authority: "direct" | "account";
  /** The account epoch at the time. Ignored for `direct`, which no account
   *  authorised and no account change invalidates. */
  readonly epoch: number;
  /** The renderer document that asked for the receive. */
  readonly document: number;
}

export interface ReceiptRegistryDeps {
  /** Which document may act now. A reload replaces it. */
  readonly currentDocument: () => number;
  /** The current account epoch. */
  readonly currentEpoch: () => number;
  /** True while the app is shutting down and starting nothing new. */
  readonly admissionClosed: () => boolean;
  /** Is this still a usable directory? Production is a `stat`. */
  readonly directoryUsable: (directory: string) => Promise<boolean>;
  /**
   * Show a directory to the user.
   *
   * **Must THROW when it did not happen.** Electron's `shell.openPath` resolves
   * with a string — empty on success, an error message on failure — and an
   * adapter that awaits it and discards the result reports every failure as a
   * success. Turning that string into a throw is the adapter's job; this module
   * treats any rejection as `failed` and never looks at what it says, so the
   * operating system's own text cannot reach a surface.
   */
  readonly openDirectory: (directory: string) => Promise<void>;
  /** Test seam only. Production takes the crypto default below. */
  readonly newToken?: () => ReceiptToken;
}

/**
 * How many receipts are kept.
 *
 * Small on purpose. The user-facing need is "the folder from the transfer I
 * just did", and a handful of tabs or windows is the realistic upper bound. A
 * larger number would not buy a better button; it would keep paths in memory
 * for longer with nobody to show them to.
 */
export const RECEIPT_CAPACITY = 64;

interface Entry {
  readonly directory: string;
  readonly owner: ReceiptOwner;
}

export class ReceiptRegistry {
  /**
   * Insertion-ordered, which is what makes eviction DETERMINISTIC: at capacity
   * the oldest issued receipt is dropped, and a `Map` preserves that order for
   * free. Not a most-recently-used cache — a receipt is a fact with an age, and
   * reading one must not let it outlive a newer one.
   */
  readonly #entries = new Map<ReceiptToken, Entry>();
  readonly #deps: ReceiptRegistryDeps;
  /** Reveals that have been admitted and not yet finished. */
  readonly #inFlight = new Set<Promise<unknown>>();
  #fenced = false;
  #disposed = false;

  constructor(deps: ReceiptRegistryDeps) {
    this.#deps = deps;
  }

  /**
   * Record where a published receive landed.
   *
   * `directory` must be the root the USER chose in main's own native dialog —
   * the same string the destination was opened with. Nothing derived from a
   * renderer value may reach here, and nothing here joins, resolves or inspects
   * it: the native path guards judge what is written INSIDE that root, and this
   * module must not become a second, weaker opinion about paths.
   *
   * Returns `null` when there is nothing to hand out — disposed, or an empty
   * directory, which is a caller bug rather than a state to encode.
   */
  register(directory: string, owner: ReceiptOwner, fileCount: number): ReceiveReceipt | null {
    if (this.#disposed) return null;
    if (directory.length === 0) return null;
    // Deliberately NOT refused while fenced. A receive that completed during a
    // quit prompt really did complete, and if the user chooses Stay the button
    // should be there. `reveal` is what refuses while fenced, which is the
    // point where something would actually happen.
    const token = this.#deps.newToken?.() ?? randomBytes(RECEIPT_TOKEN_BYTES).toString("hex");
    // COPIED, never borrowed. The caller's object is its own, and a caller that
    // reuses or mutates one — an epoch bumped in place, a document reassigned —
    // would otherwise retroactively change who an already-issued receipt belongs
    // to, and a stale token would come back to life under a new document.
    const captured: ReceiptOwner = {
      authority: owner.authority,
      epoch: owner.epoch,
      document: owner.document,
    };
    this.#entries.set(token, { directory, owner: captured });
    while (this.#entries.size > RECEIPT_CAPACITY) {
      // `keys().next()` is the oldest insertion. One at a time, so the bound is
      // exact rather than approximately enforced.
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
    return { token, fileCount };
  }

  /**
   * Show the folder a receipt points at.
   *
   * Every refusal is a closed code and none of them carries a detail from the
   * machine. The order matters: shape, then existence, then identity, then the
   * fence, then the filesystem — so a token that was never valid is never used
   * to touch a disk, and a stale one is refused before anything is opened.
   */
  async reveal(token: unknown): Promise<RevealOutcome> {
    if (this.#disposed) return refuse("unknown");
    // Checked BEFORE the lookup: a value of the wrong shape is a caller doing
    // something other than handing back what it was given.
    if (!isReceiptToken(token)) return refuse("unknown");
    const entry = this.#entries.get(token);
    if (entry === undefined) return refuse("unknown");
    if (!this.#ownerCurrent(entry.owner)) {
      // Dropped, not merely refused. The account or the document that
      // authorised this is gone, so the receipt can never become valid again —
      // and keeping it would mean a later `resume` resurrecting it.
      this.#entries.delete(token);
      return refuse("stale");
    }
    // Both gates, at a NEW request. `#fenced` is this registry's own; the host's
    // is the authority — the app can be shutting down without this module
    // having been told, and declaring the dependency while never consulting it
    // is the same as not having it.
    if (this.#fenced || this.#deps.admissionClosed()) return refuse("fenced");

    const run = this.#open(entry.directory, entry.owner);
    // Tracked so a bounded quiesce can join what it admitted. Registered before
    // the first await, so a quiesce starting in the same tick cannot miss it.
    this.#inFlight.add(run);
    try {
      return await run;
    } finally {
      this.#inFlight.delete(run);
    }
  }

  async #open(directory: string, owner: ReceiptOwner): Promise<RevealOutcome> {
    let usable: boolean;
    try {
      usable = await this.#deps.directoryUsable(directory);
    } catch {
      // A stat that threw is not a stat that said yes.
      return refuse("missing");
    }
    // Re-checked here rather than trusted from registration time: the folder
    // may have been moved, renamed or unmounted since, and opening whatever now
    // sits at a stale path is exactly what must not happen.
    if (!usable) return refuse("missing");

    // The stat is an await, and everything can move across it.
    //
    // The identity checks in `reveal` happened BEFORE it. An account change, a
    // document swap or a `dispose` that lands while the filesystem is answering
    // would otherwise be followed by this method opening the old folder anyway
    // — the checks having passed against a world that no longer exists. So they
    // are made again, HERE, on the last line before the operating system is
    // asked to do anything.
    //
    // This is not the fence being re-evaluated. A reveal that was admitted and
    // is already running is allowed to finish, and nothing cancels an OS action
    // once it has been asked for. What must not happen is STARTING one on
    // behalf of an owner that has gone.
    if (this.#disposed) return refuse("unknown");
    if (!this.#ownerCurrent(owner)) return refuse("stale");

    try {
      await this.#deps.openDirectory(directory);
    } catch {
      // The error is deliberately NOT read. See `openDirectory`.
      return refuse("failed");
    }
    return { kind: "revealed" };
  }

  #ownerCurrent(owner: ReceiptOwner): boolean {
    if (owner.document !== this.#deps.currentDocument()) return false;
    // `direct` was authorised by nobody's account, so an account change does
    // not retire it — the same rule the receive leases follow.
    if (owner.authority === "account" && owner.epoch !== this.#deps.currentEpoch()) return false;
    return true;
  }

  /**
   * Stop starting reveals, without cancelling one that is running.
   *
   * The quit fence. A reveal already in progress is a window the user is about
   * to see; killing it would be a flicker with no benefit, and it holds nothing
   * that needs releasing.
   */
  fence(): void {
    this.#fenced = true;
  }

  /** The user stayed. Nothing is resurrected: tokens dropped while fenced were
   *  dropped because they could never be valid again. */
  resume(): void {
    if (this.#disposed) return;
    this.#fenced = false;
  }

  /**
   * Wait, bounded, for reveals already admitted.
   *
   * Reports what it JOINED rather than assuming. An unjoined reveal is not a
   * leak — there is no handle behind it — but saying "everything finished" when
   * something did not is the habit that hides real ones.
   */
  async quiesce(budgetMs: number): Promise<{ readonly joined: number; readonly unjoined: number }> {
    // Closing comes FIRST, and happens whether or not there is anything to
    // wait for. Quiescing is the caller saying "stop", and an empty registry
    // that answered "nothing to do" while still admitting the next request
    // would have reported a stop it did not perform. Only `resume` reopens.
    this.#fenced = true;
    const admitted = [...this.#inFlight];
    if (admitted.length === 0) return { joined: 0, unjoined: 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = Symbol("expired");
    const deadline = new Promise<typeof expired>((resolve) => {
      timer = setTimeout(() => resolve(expired), budgetMs);
    });
    try {
      const settled = await Promise.all(
        admitted.map(async (task) => {
          const outcome = await Promise.race([task.then(() => true, () => true), deadline]);
          return outcome === expired ? false : true;
        }),
      );
      const joined = settled.filter(Boolean).length;
      return { joined, unjoined: settled.length - joined };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Everything goes. The paths are the point: nothing keeps them past the
   *  process's useful life. */
  dispose(): void {
    this.#disposed = true;
    this.#entries.clear();
  }

  /** Drop every receipt an account change or a document swap has retired.
   *  Called by the wiring at those boundaries; `reveal` also drops lazily, so
   *  this is about not HOLDING a path, not about correctness of the answer. */
  invalidateStale(): void {
    for (const [token, entry] of [...this.#entries]) {
      if (!this.#ownerCurrent(entry.owner)) this.#entries.delete(token);
    }
  }

  /** For the wiring's own accounting and for tests. Never a path. */
  get size(): number {
    return this.#entries.size;
  }
}

const refuse = (reason: RevealRefusal): RevealOutcome => ({ kind: "refused", reason });
