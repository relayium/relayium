// What the pairing handoff surface is allowed to know.
//
// The join link is the mac's: `<origin>/cross-network#c=<code>`, the form
// `web/src/lib/transfer-link.ts` builds and `parseCodeParam` reads. The code
// lives in the FRAGMENT and never in a query, so it does not reach a server log
// or a `Referer` header — and that is a property of every link this contract
// carries, enforced where the link is built rather than asserted here.
//
// ## The link contains an origin, and that is fine
//
// A join link without one would not be a link. What must not cross is
// AUTHORITY: no bearer, no token, no storage handle, no arbitrary address the
// renderer chose. The origin here is the build's configured one, and the only
// variable part is a six-digit code already on screen.
//
// ## The clipboard takes a token, not a payload
//
// `PairHandoffAction` is closed and carries nothing. Main rebuilds the link
// from the code it itself retained, so a renderer cannot put a string of its
// choosing on the user's clipboard — the rule `ipc-contract.ts` already states
// for saved messages and stored links.

/** The six-digit shape the server mints and `isWellFormedCode` accepts. */
export const PAIR_HANDOFF_CODE_LENGTH = 6;

/** The page a join link targets. `CROSS_PATH` in `web/src/lib/transfer-link.ts`. */
export const PAIR_HANDOFF_PATH = "/cross-network";

/** The fragment prefix. A query would put the code in logs; this does not. */
export const PAIR_HANDOFF_FRAGMENT = "#c=";

/**
 * A live code and the link that carries it.
 *
 * `generation` increments on every mint and every invalidation. It is what ties
 * a rendered QR and a "Copied" confirmation to ONE link: both are artefacts of
 * a specific code, never of the component slot they happen to occupy, and a
 * regenerate that left either behind would be showing the previous code.
 */
export interface PairHandoffLive {
  readonly kind: "live";
  readonly code: string;
  /** Unix seconds. The copy action refuses past this, and so does the view. */
  readonly expiresAt: number;
  /** `<origin>/cross-network#c=<code>`, built and validated in MAIN. */
  readonly link: string;
  readonly generation: number;
}

/**
 * Nothing to hand off.
 *
 * One state for "never minted", "left", "regenerating" and "expired", because
 * the surface does the same thing in all four: it shows nothing. The PairPage
 * above it already says which, and saying it twice in different words is how
 * two components come to disagree.
 */
export interface PairHandoffIdle {
  readonly kind: "idle";
  readonly generation: number;
}

export type PairHandoffView = PairHandoffLive | PairHandoffIdle;

/** The only action. Closed, and it carries nothing at all. */
export type PairHandoffAction = "copy-join-link";

export function isPairHandoffAction(value: unknown): value is PairHandoffAction {
  return value === "copy-join-link";
}

/**
 * How a copy ended.
 *
 * `expired` and `no-code` are distinct: one had a code that ran out, the other
 * never had one. A person who just watched a countdown reach zero is told the
 * first, which is the true sentence.
 */
export type PairCopyOutcome =
  | { readonly kind: "copied"; readonly generation: number }
  | { readonly kind: "no-code" }
  | { readonly kind: "expired" }
  /** A stale document or account, a fence, or a teardown. Nothing was copied. */
  | { readonly kind: "unavailable" };

export const PAIR_HANDOFF_IDLE: PairHandoffView = Object.freeze({ kind: "idle", generation: 0 });
