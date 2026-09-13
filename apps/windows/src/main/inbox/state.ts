// The closed runtime state union.
//
// ## Why a union and not a bag of booleans
//
// `enabled`, `enrolled`, `busy`, `error` as four independent fields make
// sixteen combinations, most of which cannot happen and none of which the
// compiler checks. Something eventually renders "receiving" and "disabled" at
// once, and the bug is in whoever forgot a condition rather than in a type.
//
// This is one discriminated union with an exhaustiveness check, so adding a
// state is a COMPILE error everywhere it is not handled. That is the whole
// point: the next state will be added by someone who has not read this file.
//
// ## What may travel in it
//
// The same rule `receipts.ts` states, and for the same reason: this crosses to
// logs and eventually to the renderer. Counts, bytes, stable codes and booleans
// only. There is no member here that can hold a file name, a destination path,
// a message body or a server string, so no future caller can put one there.
import type { InboxFailureCode, ResidueState } from "./receipts.js";

/** Progress on one delivery. Numbers only — never what is being received. */
export interface DeliveryProgress {
  /** Items in the manifest this delivery was accepted against. */
  readonly total: number;
  /** Items fully published so far. The authoritative prefix. */
  readonly published: number;
  /** Ciphertext bytes the server declared for the whole body. */
  readonly totalBytes: number;
  /** Ciphertext bytes accepted so far. */
  readonly receivedBytes: number;
  /** True for a message delivery, which lands in the vault rather than on disk. */
  readonly text: boolean;
}

/**
 * Everything the Inbox can be.
 *
 * `disabled` and `unavailable` are separate because they mean different things
 * to the user: one is a switch they can turn on, the other is this build not
 * implementing the feature yet. Conflating them would show a switch that does
 * nothing.
 */
export type InboxRuntimeState =
  /** The user has not enabled the Inbox. Nothing is enrolled. */
  | { readonly kind: "disabled" }
  /** The build cannot receive anything yet, so there is nothing to enable. */
  | { readonly kind: "unavailable"; readonly reason: InboxFailureCode }
  /** Enabled and enrolled, with nothing in flight. */
  | { readonly kind: "idle"; readonly pending: number }
  /** A delivery is in progress. */
  | { readonly kind: "receiving"; readonly progress: DeliveryProgress }
  /**
   * Work stopped and will not resume without a decision.
   *
   * `reconcile-blocked` is the case the journal's `blocked` reconciliation
   * produces: the process died with a publish in flight and nothing on this side
   * establishes what landed. Re-driving it could duplicate files; ACKing it
   * could claim a save that never happened. Neither is this code's call.
   */
  | {
      readonly kind: "blocked";
      readonly reason: InboxFailureCode;
      readonly residue: ResidueState;
      /** Deliveries waiting behind the block. */
      readonly pending: number;
    };

/**
 * The compiler's proof that every state is handled.
 *
 * Reached only if a `switch` over the union missed a member, which by then is a
 * type error at the call site. The throw exists for the JavaScript that runs
 * anyway when someone widens the union from an untyped edge.
 */
export function assertNever(value: never, what = "inbox state"): never {
  throw new Error(`${what}: unhandled variant ${JSON.stringify(value)}`);
}

/** Whether this state means the Inbox is doing work right now. */
export function isBusy(state: InboxRuntimeState): boolean {
  switch (state.kind) {
    case "receiving":
      return true;
    case "disabled":
    case "unavailable":
    case "idle":
    case "blocked":
      return false;
    default:
      return assertNever(state);
  }
}

/**
 * Whether this state may accept new deliveries.
 *
 * `blocked` is deliberately false. A block is a genuine stop: claiming more
 * work while an unreconciled delivery sits there would bury the thing that
 * needs a decision under things that do not.
 */
export function mayClaim(state: InboxRuntimeState): boolean {
  switch (state.kind) {
    case "idle":
      return true;
    case "disabled":
    case "unavailable":
    case "receiving":
    case "blocked":
      return false;
    default:
      return assertNever(state);
  }
}

/**
 * A stable, loggable label. No free text and nothing derived from a delivery.
 *
 * Written as an exhaustive switch rather than `state.kind` so that a new state
 * has to be given a label deliberately — the alternative is a state that logs
 * as its own internal name forever.
 */
export function describeState(state: InboxRuntimeState): string {
  switch (state.kind) {
    case "disabled":
      return "disabled";
    case "unavailable":
      return `unavailable:${state.reason}`;
    case "idle":
      return `idle:${state.pending}`;
    case "receiving":
      return `receiving:${state.progress.published}/${state.progress.total}`;
    case "blocked":
      return `blocked:${state.reason}:${state.residue}`;
    default:
      return assertNever(state);
  }
}
