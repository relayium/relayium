// "Open the folder", for a receive that has already saved.
//
// ## Why the renderer holds a token and not a path
//
// The page never learns where the files went. The user chose the folder in a
// native dialog that main put up, main kept the string, and what crosses back
// is 32 bytes of entropy that main can resolve and nobody else can guess.
//
// That is not ceremony. A renderer that held the path could put it on screen,
// into a message, or into a link — and a compromised one could do all three
// without a single new capability. There is no channel in this bridge that
// takes a path, and this is the surface that would have been the exception.
//
// ## Why this is separate from the room controller
//
// The room controller owns the transfer: manifests, consent, progress,
// outcome. This owns one button that exists AFTER the transfer is over, and it
// is driven by a push from main rather than by anything the room does. Keeping
// it apart means a reveal that fails cannot put a failure into the transfer's
// own state, where it would read as "the files did not arrive".

import { isReceiptToken, type ReceiveReceipt, type RevealOutcome, type RevealRefusal } from "../../shared/receive-receipt.js";

/** The privileged half, as this controller needs it. */
export interface RevealBridge {
  reveal(payload: { token: string }): Promise<unknown>;
  onReceipt(cb: (payload: unknown) => void): () => void;
}

/**
 * A pushed receipt, checked before it is believed.
 *
 * Main is trusted and this still validates, for the same reason every other
 * boundary in this app does: the check costs nothing, and a malformed value
 * reaching `reveal` would be sent back across IPC as a token. Anything that is
 * not exactly what main mints is dropped here rather than round-tripped.
 */
function receiptOf(payload: unknown): ReceiveReceipt | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { token, fileCount } = payload as { token?: unknown; fileCount?: unknown };
  if (!isReceiptToken(token)) return null;
  if (typeof fileCount !== "number" || !Number.isInteger(fileCount) || fileCount < 0) return null;
  return { token, fileCount };
}

/**
 * The outcome, checked the same way.
 *
 * An unrecognised shape becomes `failed` rather than an exception or a silent
 * success: the user pressed a button and something has to be said, and the one
 * thing that must never be said is "revealed" when nothing opened.
 */
const REFUSALS: readonly RevealRefusal[] = ["unknown", "stale", "fenced", "missing", "failed"];

function outcomeOf(value: unknown): RevealOutcome {
  if (typeof value !== "object" || value === null) return { kind: "refused", reason: "failed" };
  const { kind, reason } = value as { kind?: unknown; reason?: unknown };
  if (kind === "revealed") return { kind: "revealed" };
  if (kind === "refused" && REFUSALS.includes(reason as RevealRefusal)) {
    return { kind: "refused", reason: reason as RevealRefusal };
  }
  return { kind: "refused", reason: "failed" };
}

export class RevealController {
  #receipt = $state<ReceiveReceipt | null>(null);
  #busy = $state(false);
  #refusal = $state<RevealRefusal | null>(null);
  #release: (() => void) | null = null;

  constructor(private readonly bridge: RevealBridge) {}

  /**
   * Start listening. Returns the unsubscribe, and is idempotent — a second
   * call does not add a second listener, because the same emitter would then
   * deliver every receipt twice.
   */
  start(): () => void {
    this.#release ??= this.bridge.onReceipt((payload) => {
      const receipt = receiptOf(payload);
      if (receipt === null) return;
      this.#receipt = receipt;
      // A NEW receipt clears the previous refusal. The reason belonged to the
      // last button press; leaving it up next to a transfer that just finished
      // would report a failure that has not happened yet.
      this.#refusal = null;
    });
    return () => {
      this.#release?.();
      this.#release = null;
    };
  }

  /**
   * The receipt for a batch of exactly this many files, or none.
   *
   * The count is what binds a held token to the card asking for it. Only one
   * receipt is kept — the same shape the room's own last-outcome takes — so
   * without this a card reporting three saved files could be offered the token
   * from an earlier two-file transfer, and the button would open a folder that
   * is not the one the card is about.
   */
  receiptFor(fileCount: number): ReceiveReceipt | null {
    const held = this.#receipt;
    return held !== null && held.fileCount === fileCount ? held : null;
  }

  /** True while a reveal is running, so the button can say so and not stack. */
  get busy(): boolean {
    return this.#busy;
  }

  /**
   * Why the last reveal did not happen, from the closed set.
   *
   * Never the operating system's message: that routinely contains the path,
   * which is the one thing this whole arrangement keeps out of the renderer.
   */
  get refusal(): RevealRefusal | null {
    return this.#refusal;
  }

  /**
   * Ask main to show the folder.
   *
   * Never throws. A rejection from the bridge is a refusal like any other —
   * there is no caller above this that could do anything with an exception
   * except turn it into the same sentence.
   */
  async reveal(): Promise<void> {
    const held = this.#receipt;
    if (held === null || this.#busy) return;
    this.#busy = true;
    this.#refusal = null;
    try {
      const outcome = outcomeOf(await this.bridge.reveal({ token: held.token }));
      if (outcome.kind === "refused") {
        this.#refusal = outcome.reason;
        // `stale` and `unknown` mean this token will never work again: the
        // account or the document that authorised it is gone, or main has
        // forgotten it. The button is withdrawn rather than left to fail
        // identically on every further press.
        if (outcome.reason === "stale" || outcome.reason === "unknown") this.#receipt = null;
      }
    } catch {
      this.#refusal = "failed";
    } finally {
      this.#busy = false;
    }
  }

  // ## There is deliberately no `forget()` for an account change
  //
  // It would be wrong. A LAN receive nobody signed in for is `direct`, no
  // account authorised it, and an account change does not retire it — main's
  // `invalidateStale` keeps exactly those and drops the rest. A blanket clear
  // here would take away a button that still works.
  //
  // The account-bound ones are withdrawn on use instead: main answers `stale`
  // and `reveal` above drops the token. That is one press of a button that
  // says why, rather than a row that vanishes for reasons nobody can see.
}
