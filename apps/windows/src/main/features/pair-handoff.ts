// The current pairing code, held in main so a join link can be built and copied
// without a renderer ever naming one.
//
// `net/pair-control.ts` mints and forgets: it returns a code to whoever asked
// and keeps nothing. That is right for a minter and insufficient for a
// clipboard, because a copy must be of the code that is on screen NOW — not one
// the renderer sent back, which is a string this process cannot vouch for.
//
// So this retains exactly one mint, builds the link from the build's configured
// origin, and copies from what it retained.
//
// ## A late mint must not revive a code the user has finished with
//
// `adopt` is called around an async mint, and the user can leave, regenerate or
// let the code expire while it is in flight. Every mint takes a TICKET before it
// starts; an answer whose ticket is no longer the current one is dropped. Without
// that, a slow mint lands after a Leave and puts a live QR back on screen for a
// room nobody is in.
//
// ## Generation ties the artefacts to the link
//
// A QR image and a "Copied" confirmation both belong to one code. `generation`
// increments on every mint and every invalidation so the renderer can discard a
// QR that finished rendering after the code changed — the same rule
// `web/src/lib/CodePairing.svelte` applies with its `cancelled` flag, and the
// same one `PairingCodeHandoffView` applies to its copy state.

import {
  PAIR_HANDOFF_CODE_LENGTH,
  PAIR_HANDOFF_FRAGMENT,
  PAIR_HANDOFF_PATH,
  PAIR_HANDOFF_IDLE,
  isPairHandoffAction,
  type PairCopyOutcome,
  type PairHandoffAction,
  type PairHandoffView,
} from "../../shared/pair-handoff.js";

/** Digits only, and exactly the minted length. The server's shape. */
const CODE = /^[0-9]+$/;

export interface PairHandoffDeps {
  /** The build's configured origin. Never a payload, never a renderer value. */
  readonly origin: string;
  /** The clipboard, written by MAIN. */
  writeClipboard(text: string): void;
  /** Which document may act. A code belongs to the page that minted it. */
  currentDocument(): number;
  /** The account epoch, re-checked at copy: a code outlives no sign-out. */
  accountEpoch(): number;
  onView?(view: PairHandoffView): void;
  /** Seconds. Injected so expiry is testable without waiting. */
  now?(): number;
  reportFailure?(err: unknown): void;
}

/** What a teardown found. */
export interface PairHandoffInventory {
  /** A code was still live when the teardown began. */
  readonly held: boolean;
}

/**
 * Build the join link, or refuse.
 *
 * The code is validated to the server's shape first, then the URL is rebuilt
 * and re-read: the path must be exactly the cross-network page, the query must
 * be EMPTY, and the fragment must be exactly `#c=<code>`. A query would put the
 * code into request logs and `Referer` headers, which is the whole reason the
 * web client puts it in the fragment.
 */
export function joinLinkFor(origin: string, code: string): string | null {
  if (typeof code !== "string" || code.length !== PAIR_HANDOFF_CODE_LENGTH) return null;
  if (!CODE.test(code)) return null;
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return null;
  }
  // A configured origin is a scheme, a host and a port. One carrying a path or
  // a query is not the value every link below is built on.
  if (base.origin !== origin) return null;
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  if (base.username !== "" || base.password !== "") return null;
  const url = new URL(`${origin}${PAIR_HANDOFF_PATH}${PAIR_HANDOFF_FRAGMENT}${code}`);
  if (url.origin !== base.origin) return null;
  if (url.pathname !== PAIR_HANDOFF_PATH) return null;
  if (url.search !== "") return null;
  if (url.hash !== `${PAIR_HANDOFF_FRAGMENT}${code}`) return null;
  return url.toString();
}

/** What a mint captured when it STARTED. Validated when its answer lands. */
interface Pending {
  readonly ticket: number;
  readonly epoch: number;
  readonly document: number;
}

interface Held {
  readonly code: string;
  readonly expiresAt: number;
  readonly link: string;
  readonly document: number;
  readonly epoch: number;
  readonly generation: number;
}

/** setTimeout saturates past this and fires at once. Clamp rather than misfire. */
const MAX_TIMER_MS = 2_147_483_647;

export class PairHandoffService {
  #held: Held | null = null;
  #generation = 0;
  /** The mint that may still install its answer. See the header. */
  #ticket = 0;
  /** What the in-flight mint captured at its start, or null. */
  #pending: Pending | null = null;
  /** The expiry push, and the generation it belongs to. */
  #timer: ReturnType<typeof setTimeout> | null = null;
  #timerGeneration = 0;
  #fenced = false;
  #disposed = false;

  constructor(private readonly deps: PairHandoffDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Math.floor(Date.now() / 1000);
  }

  /**
   * The current snapshot, with expiry applied at READ time.
   *
   * A held code whose deadline has passed is already idle here, so a caller
   * cannot observe a live view for a dead code even if nothing has ticked.
   */
  view(): PairHandoffView {
    const held = this.#held;
    if (held === null) return Object.freeze({ kind: "idle" as const, generation: this.#generation });
    // Identity is re-checked HERE, not only at copy. A read is how the link
    // reaches a screen, so a handoff whose account or document has moved must
    // not survive one — waiting for a callback to arrive first would mean the
    // window between the change and the notification hands the previous
    // account's link to the current page.
    if (this.#stale(held) || this.#expired(held)) {
      this.#invalidate();
      return Object.freeze({ kind: "idle" as const, generation: this.#generation });
    }
    return Object.freeze({
      kind: "live" as const,
      code: held.code,
      expiresAt: held.expiresAt,
      link: held.link,
      generation: held.generation,
    });
  }

  /** True while a live code is retained. For the quit risk snapshot. */
  get held(): boolean {
    return this.view().kind === "live";
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Take a ticket BEFORE an async mint starts, capturing what it starts under.
   *
   * The epoch and the document are captured HERE. Taking only a ticket left a
   * mint that began under one account free to be stamped with whatever account
   * happened to be current when it landed — every later check passed, because
   * every later check read "now".
   *
   * It also supersedes the current code IMMEDIATELY. A regenerate that left the
   * old QR and link on screen until the new mint returned was offering a code
   * the user had just replaced.
   */
  beginMint(): number {
    this.#ticket += 1;
    if (this.#disposed || this.#fenced) {
      // Not admitting. The ticket still moves, so anything already in flight is
      // orphaned — but nothing HELD is dropped. A fence is the state a quit
      // prompt is decided in, and losing the user's code before they have
      // answered is exactly what it exists to prevent.
      this.#pending = null;
      return this.#ticket;
    }
    this.#pending = {
      ticket: this.#ticket,
      epoch: this.deps.accountEpoch(),
      document: this.deps.currentDocument(),
    };
    if (this.#held !== null) {
      this.#invalidate();
      this.#publish();
    }
    return this.#ticket;
  }

  /**
   * Install a minted code, if its ticket is still the current one.
   *
   * Returns whether it was adopted, so a caller is told rather than left to
   * assume. A mint that lost its ticket — the user left, regenerated, signed
   * out — installs nothing.
   */
  adopt(ticket: number, code: string, expiresAt: number, document: number): boolean {
    if (this.#disposed || this.#fenced) return false;
    const pending = this.#pending;
    if (pending === null || pending.ticket !== ticket || ticket !== this.#ticket) return false;
    // The caller's own claim must agree with what the mint started under, and
    // BOTH must still be current. The captured epoch is the one that matters:
    // stamping this code with `accountEpoch()` would label an old account's
    // code with whoever is signed in now.
    if (pending.document !== document) return false;
    if (pending.document !== this.deps.currentDocument()) return false;
    if (pending.epoch !== this.deps.accountEpoch()) return false;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) return false;
    const link = joinLinkFor(this.deps.origin, code);
    if (link === null) return false;
    this.#pending = null;
    this.#generation += 1;
    this.#held = {
      code,
      expiresAt,
      link,
      document: pending.document,
      epoch: pending.epoch,
      generation: this.#generation,
    };
    this.#arm(expiresAt, this.#generation);
    this.#publish();
    return true;
  }

  /**
   * The user left the room, regenerated, or the code was superseded.
   *
   * The TICKET moves first, and that is the whole point. Clearing the held code
   * alone left a mint already in flight free to adopt afterwards — same
   * document, same account, so every other check passed — and a slow answer
   * landing after a Leave put a live QR back on screen for a room nobody is in.
   */
  invalidate(): void {
    this.#ticket += 1;
    this.#pending = null;
    if (this.#held === null) return;
    this.#invalidate();
    this.#publish();
  }

  /** The account moved. A code belongs to the account that minted it. */
  onAccountChanged(): void {
    // The ticket moves too: a mint in flight under the old account must not
    // install under the new one.
    this.#ticket += 1;
    this.#pending = null;
    this.#invalidate();
    this.#publish();
  }

  /** A document was destroyed or reloaded. */
  revokeDocument(document: number): void {
    this.#ticket += 1;
    this.#pending = null;
    if (this.#held !== null && this.#held.document !== document) {
      this.#publish();
      return;
    }
    this.#invalidate();
    this.#publish();
  }

  /** Close admissions before a quit question. Nothing held is dropped. */
  fence(): void {
    this.#fenced = true;
  }

  /** The user stayed. A code that expired meanwhile stays expired. */
  resume(): void {
    if (this.#disposed) return;
    this.#fenced = false;
    // Re-read, so a code that died during the prompt is reported as gone rather
    // than silently reappearing.
    this.#publish();
  }

  /**
   * Stop and report. Bounded by construction: nothing here is asynchronous.
   *
   * The held code is dropped — a pairing code is a short-lived shared secret and
   * a quit is the end of its usefulness — and the inventory says whether one was
   * live, so a quit prompt can mention it.
   */
  quiesce(): PairHandoffInventory {
    this.#fenced = true;
    const inventory = { held: this.held };
    this.#ticket += 1;
    this.#invalidate();
    this.#publish();
    return inventory;
  }

  /** Terminal. */
  dispose(): PairHandoffInventory {
    const inventory = this.quiesce();
    this.#disposed = true;
    return inventory;
  }

  // -------------------------------------------------------------------------
  // The one action
  // -------------------------------------------------------------------------

  /**
   * Put the CURRENT join link on the clipboard.
   *
   * The token carries nothing. The link is rebuilt here from the retained code
   * — not taken from an argument, and not trusted from the last publish — so a
   * renderer cannot choose what lands on somebody's clipboard.
   *
   * The document and the account are re-checked at the moment of the copy: a
   * page that reloaded did not ask for this, and a code minted by an account
   * that has since signed out is not this account's to share.
   */
  copy(action: PairHandoffAction, document: number): PairCopyOutcome {
    if (this.#disposed || this.#fenced) return { kind: "unavailable" };
    if (!isPairHandoffAction(action)) return { kind: "unavailable" };
    if (document !== this.deps.currentDocument()) return { kind: "unavailable" };
    const held = this.#held;
    if (held === null) return { kind: "no-code" };
    if (this.#expired(held)) {
      this.#invalidate();
      this.#publish();
      return { kind: "expired" };
    }
    if (held.document !== document) return { kind: "unavailable" };
    if (held.epoch !== this.deps.accountEpoch()) return { kind: "unavailable" };
    const link = joinLinkFor(this.deps.origin, held.code);
    if (link === null) return { kind: "unavailable" };
    try {
      this.deps.writeClipboard(link);
    } catch (err) {
      this.deps.reportFailure?.(err);
      return { kind: "unavailable" };
    }
    // The generation travels with the confirmation, so a "Copied" belongs to
    // this link and disappears when the code changes.
    return { kind: "copied", generation: held.generation };
  }

  // -------------------------------------------------------------------------

  #expired(held: Held): boolean {
    return held.expiresAt <= this.now();
  }

  /** The account or the document has moved under a held code. */
  #stale(held: Held): boolean {
    return held.epoch !== this.deps.accountEpoch() || held.document !== this.deps.currentDocument();
  }

  /**
   * Publish idle WHEN the code expires, rather than when somebody next looks.
   *
   * Without this the countdown reached zero and the QR stayed on screen until a
   * read or a copy happened to notice. A page showing a dead code is showing
   * something it cannot honour, and no observer was going to ask.
   *
   * Generation-guarded so a timer armed for a previous code cannot clear a
   * newer one, and unref'd so it never holds the process open by itself.
   */
  #arm(expiresAt: number, generation: number): void {
    this.#clearTimer();
    const ms = Math.min(MAX_TIMER_MS, Math.max(0, (expiresAt - this.now()) * 1000));
    const timer = setTimeout(() => {
      if (this.#disposed) return;
      // The guards that make a late timer harmless.
      if (this.#timerGeneration !== generation) return;
      if (this.#held === null || this.#held.generation !== generation) return;
      this.#invalidate();
      this.#publish();
    }, ms);
    timer.unref?.();
    this.#timer = timer;
    this.#timerGeneration = generation;
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  #invalidate(): void {
    this.#clearTimer();
    if (this.#held !== null) this.#generation += 1;
    this.#held = null;
  }

  #publish(): void {
    if (this.#disposed) return;
    try {
      this.deps.onView?.(this.view());
    } catch (err) {
      this.deps.reportFailure?.(err);
    }
  }
}

/** The view a page holds before main has answered. */
export const PAIR_HANDOFF_LOADING = PAIR_HANDOFF_IDLE;
