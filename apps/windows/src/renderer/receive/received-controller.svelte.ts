// Files a finished receive wrote, and the two things a person does with one.
//
// ## Why this is separate from the reveal controller beside it
//
// `RevealController` holds ONE token for a whole batch and opens the folder.
// This holds one token per FILE and either drags it out or shows that file. The
// two answer different questions — "where did this go" and "give me this one" —
// and a single object holding both would have to decide, on every refusal,
// which of the two the message was about.
//
// ## The page never learns a path
//
// `relativePath` is relative to a root the page was never given, so it is safe
// to show and useless to anyone who obtains it. The drag itself is main's: the
// page says which token, and main starts an OS drag for a file it re-checks
// first.

import type {
  ReceivedAction,
  ReceivedActionOutcome,
  ReceivedItemView,
} from "../../shared/received-drag.js";

/** The privileged half, as this controller needs it. */
export interface ReceivedBridge {
  act(payload: { action: ReceivedAction; token: string }): Promise<unknown>;
  onItems(cb: (payload: unknown) => void): () => void;
}

/** Why the last action did not happen, from the closed set. */
export type ReceivedRefusal = Exclude<ReceivedActionOutcome["kind"], "started" | "revealed">;

const REFUSALS: readonly ReceivedRefusal[] = ["unknown-token", "missing", "unavailable", "failed"];

/**
 * A pushed item, checked before it is believed.
 *
 * Main is trusted and this still validates, for the same reason every other
 * boundary here does: a malformed value reaching `act` would be sent back
 * across IPC as a token.
 */
function itemOf(value: unknown): ReceivedItemView | null {
  if (typeof value !== "object" || value === null) return null;
  const { token, name, relativePath, size } = value as Record<string, unknown>;
  if (typeof token !== "string" || token.length === 0) return null;
  if (typeof name !== "string" || name.length === 0) return null;
  if (typeof relativePath !== "string" || relativePath.length === 0) return null;
  // An absolute path is not something this contract produces. If one ever
  // arrived it would be a path reaching the page, so it is dropped rather than
  // rendered.
  if (relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) return null;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return null;
  return { token, name, relativePath, size };
}

function outcomeOf(value: unknown): ReceivedActionOutcome {
  if (typeof value !== "object" || value === null) return { kind: "failed" };
  const { kind } = value as { kind?: unknown };
  if (kind === "started" || kind === "revealed") return { kind };
  if (typeof kind === "string" && REFUSALS.includes(kind as ReceivedRefusal)) {
    return { kind: kind as ReceivedRefusal };
  }
  return { kind: "failed" };
}

export class ReceivedController {
  items = $state<readonly ReceivedItemView[]>([]);
  /** The token of the action in flight, so one row can say so. */
  busy = $state<string | null>(null);
  refusal = $state<ReceivedRefusal | null>(null);

  #release: (() => void) | null = null;

  constructor(private readonly bridge: ReceivedBridge) {}

  /**
   * Start listening. Idempotent — a second call does not add a second
   * listener, which would deliver every announcement twice.
   */
  start(): () => void {
    this.#release ??= this.bridge.onItems((payload) => {
      if (!Array.isArray(payload)) return;
      const items = payload.map(itemOf).filter((item): item is ReceivedItemView => item !== null);
      if (items.length === 0) return;
      // A NEW receive replaces the last one's list. Appending would leave rows
      // from an earlier transfer beside the one the screen is reporting, and
      // their tokens may already have been retired.
      this.items = items;
      this.refusal = null;
    });
    return () => {
      this.#release?.();
      this.#release = null;
    };
  }

  /** Forget everything. The tokens belong to a transfer, not to the screen. */
  clear(): void {
    this.items = [];
    this.refusal = null;
  }

  /**
   * Drag one file out, or show it.
   *
   * Never throws. A rejection from the bridge is a refusal like any other;
   * there is nothing above this that could do more with an exception than turn
   * it into the same sentence.
   */
  async act(action: ReceivedAction, token: string): Promise<void> {
    if (this.busy !== null) return;
    this.busy = token;
    this.refusal = null;
    try {
      const outcome = outcomeOf(await this.bridge.act({ action, token }));
      if (outcome.kind !== "started" && outcome.kind !== "revealed") {
        this.refusal = outcome.kind;
        // `unknown-token` means this token will never work again: the document
        // or the account that owned it is gone. The row is withdrawn rather
        // than left to fail identically on every further press.
        if (outcome.kind === "unknown-token") {
          this.items = this.items.filter((item) => item.token !== token);
        }
      }
    } catch {
      this.refusal = "failed";
    } finally {
      this.busy = null;
    }
  }
}
