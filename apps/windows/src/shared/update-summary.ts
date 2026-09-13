// What the update pane is allowed to know.
//
// `src/main/update/state.ts` is the authority and this is its reduction for a
// renderer. The union there has EIGHTEEN kinds and this one has the same
// eighteen, in the same order, because every one is a different thing to tell a
// person and collapsing any two is how a screen says something untrue.
//
// ## Nothing free-form crosses
//
// The core's `reason` and `detail` fields are mostly closed codes, but not
// entirely: `QuiesceDecision.granted:false` carries a `reason: string` from the
// host's own consent adapter, and `install-deferred` interpolates it, so a
// string chosen by code outside this module can reach that field. The same is
// true of `not-resumed:${detail}`.
//
// So NO free-form string crosses this boundary — not as a headline, not as a
// secondary diagnostic, not in a tooltip. Main maps every reason onto the closed
// enum below and anything it does not recognise becomes `other`. A page renders
// a sentence it owns, keyed on a value from a set this file enumerates.
//
// That costs a little diagnostic detail and buys the guarantee that no path, no
// host name, no adapter message and no future field can arrive on screen or in a
// renderer log by accident.
//
// ## No authority travels outward
//
// The renderer never sends a URL, a path, a version or a digest, and never
// receives an address it could navigate to. `hasNotes` is a boolean; the release
// notes are opened by MAIN, from the signed manifest, behind the closed token
// below. Everything a delivery is made of comes from the re-verified signed
// manifest inside main.
//
// ## Nothing here claims an update happened
//
// `revealed` is the end of the unsigned path and means a file is on disk. The
// Windows flow ends in a launched installer or a revealed file — never in a
// replaced application — so no state in this contract may be rendered as
// "Relayium has been updated".

/**
 * Why something did not happen, as a CLOSED set.
 *
 * The union of the core's own failure codes — `JournalFailure`, `FeedFailure`,
 * `ArtifactFailure`, `InstallRefusal` and the service's own literals — plus one
 * fallback. Main maps; this file enumerates; the catalogue translates.
 *
 * `other` is deliberate and load-bearing: a newer core that adds a code must
 * render as a generic sentence rather than leak the raw token, and a mapping
 * that silently passed an unknown value through would be exactly that leak.
 */
export type UpdateReason =
  // --- transport, shared by the feed and the artifact ---------------------
  | "network"
  | "timeout"
  | "cancelled"
  | "http"
  | "redirect"
  | "too-large"
  /** A redirect to a host this build will not follow. */
  | "untrusted-host"
  /** Signed, but not a manifest this build understands. */
  | "malformed"
  /** Bytes shorter than declared, or a digest that did not match. */
  | "integrity"
  /** The staging directory could not hold the download. */
  | "staging"
  // --- the local record ---------------------------------------------------
  | "corrupt"
  | "unreadable"
  | "unwritable"
  /** The staging directory could not be established as this app's. */
  | "unowned"
  // --- install refusals ----------------------------------------------------
  /** The staged file is no longer the size or hash that was verified. */
  | "identity-changed"
  /** Authenticode named a publisher other than the expected one. */
  | "publisher"
  /** The file could not be held still while it was launched. */
  | "not-lockable"
  /** No publisher identity is pinned, so nothing may be run. */
  | "no-expected-publisher"
  /** This build has no resident lane to ask, so it will not install. */
  | "no-consent-adapter"
  /** Consent arrived after the user had already cancelled. */
  | "cancelled-late-grant"
  /** The app could not be confirmed resumed after an install attempt. */
  | "not-resumed"
  | "platform-error"
  /** Anything this build does not recognise. Rendered generically. */
  | "other";

/** Which build an update would replace or install. Facts only. */
export interface UpdateCandidateView {
  readonly version: string;
  readonly build: number;
  readonly sizeBytes: number;
  /**
   * Release notes exist AND main judged their address safe to open.
   *
   * A boolean, never the address. `false` covers both "the manifest named no
   * notes" and "it named something this build will not open", because the page
   * does the same thing in either case: it offers no link.
   */
  readonly hasNotes: boolean;
  /**
   * The verified digest, as optional DETAIL only.
   *
   * Never the primary statement. A dialog headlined with 64 hex characters
   * teaches people that security is something to squint at, and the decision
   * that matters here is not made by comparing digests by eye.
   */
  readonly sha256: string | null;
}

/** Why updates are off for this build. Both reasons, never collapsed. */
export type UpdateDisabledReason = "engineering-build" | "no-pin";

/**
 * Why this installation may not take on new state. Both reasons, never
 * collapsed: one is about leftovers, the other about the directory itself.
 */
export type UpdateBlockedReason = "unresolved-residue" | "staging-unowned";

/**
 * The eighteen states, reduced.
 *
 * Same discriminants and same order as `src/main/update/state.ts`. A reader
 * comparing the two files should find them line for line.
 */
export type UpdateStateView =
  | { readonly kind: "disabled"; readonly reason: UpdateDisabledReason }
  | { readonly kind: "idle"; readonly lastCheckedAt: number | null }
  | { readonly kind: "checking" }
  | { readonly kind: "up-to-date"; readonly checkedAt: number }
  | { readonly kind: "check-failed"; readonly reason: UpdateReason; readonly retryable: boolean }
  /** Not signed by a pinned key. TERMINAL: no download, no retry, no override. */
  | { readonly kind: "feed-untrusted" }
  | { readonly kind: "update-available"; readonly candidate: UpdateCandidateView }
  | {
      readonly kind: "downloading";
      readonly candidate: UpdateCandidateView;
      /**
       * Bytes written, as the CORE published them.
       *
       * Monotonic and bounded by the signed length — the core drops any count
       * that does not grow or that would exceed it. A renderer must never
       * advance this on a timer: an interpolated bar is a claim about bytes
       * nobody received.
       */
      readonly receivedBytes: number;
    }
  | { readonly kind: "verify-failed"; readonly candidate: UpdateCandidateView; readonly reason: UpdateReason }
  /** Verified bytes, expected publisher. The ONLY state that may install. */
  | { readonly kind: "ready"; readonly candidate: UpdateCandidateView }
  /** Verified bytes, no publisher signature. May REVEAL, never execute. */
  | { readonly kind: "ready-unsigned"; readonly candidate: UpdateCandidateView }
  /** Signed by someone else. Terminal, and a stronger signal than unsigned. */
  | { readonly kind: "publisher-mismatch"; readonly candidate: UpdateCandidateView }
  /** The publisher check could not RUN. Not `unsigned`, and not ready. */
  | { readonly kind: "verifier-unavailable"; readonly candidate: UpdateCandidateView }
  | { readonly kind: "installing"; readonly candidate: UpdateCandidateView }
  /** The resident side refused to be interrupted. Not an error. */
  | { readonly kind: "install-deferred"; readonly candidate: UpdateCandidateView; readonly reason: UpdateReason }
  /** The unsigned path's terminus: a file on disk. NOT an update. */
  | { readonly kind: "revealed"; readonly candidate: UpdateCandidateView }
  /** The local record could not be read or written. A refusal, not a reset. */
  | { readonly kind: "journal-unavailable"; readonly reason: UpdateReason }
  | {
      readonly kind: "blocked";
      readonly reason: UpdateBlockedReason;
      readonly count: number;
    };

export type UpdateStateKind = UpdateStateView["kind"];

/** Every kind, in the core's own order. The acceptance set. */
export const UPDATE_STATE_KINDS: readonly UpdateStateKind[] = [
  "disabled",
  "idle",
  "checking",
  "up-to-date",
  "check-failed",
  "feed-untrusted",
  "update-available",
  "downloading",
  "verify-failed",
  "ready",
  "ready-unsigned",
  "publisher-mismatch",
  "verifier-unavailable",
  "installing",
  "install-deferred",
  "revealed",
  "journal-unavailable",
  "blocked",
];

export const UPDATE_DISABLED_REASONS: readonly UpdateDisabledReason[] = ["engineering-build", "no-pin"];
export const UPDATE_BLOCKED_REASONS: readonly UpdateBlockedReason[] = ["unresolved-residue", "staging-unowned"];

/**
 * What could not be confirmed deleted, as COUNTS — and whether it was READ.
 *
 * The three cases are distinct because `{total: 0}` over a failed read is a
 * claim that nothing is outstanding, which is the one thing an unread residue
 * cannot say. `unread` is the state before anyone asked; `failed` is the state
 * after asking did not work.
 *
 * No name, no nonce, no path, no per-entry detail. `ambiguous` is the subset the
 * core reports as `owned: false` — bytes that might not be this installation's,
 * never deleted and never retried automatically.
 *
 * There is deliberately no resolution action. The core offers none, so the pane
 * can only explain; a button that could not work would be worse than none.
 */
export type UpdateResidueView =
  | { readonly kind: "unread" }
  | { readonly kind: "failed" }
  | { readonly kind: "read"; readonly total: number; readonly ambiguous: number };

/**
 * Which actions the CURRENT state permits.
 *
 * Computed in main from the core's own predicates, not re-derived in a page: a
 * second opinion about whether a build may execute an installer is exactly the
 * opinion that must not exist twice. A page renders these as enabled/disabled
 * and never infers an affordance from `kind`.
 */
export interface UpdateActionsView {
  readonly canCheck: boolean;
  readonly canDownload: boolean;
  /** True only for `ready`. Mirrors `canInstall` in the core. */
  readonly canInstall: boolean;
  /** True only for `ready-unsigned`. Mirrors `canReveal` in the core. */
  readonly canReveal: boolean;
  /** Release notes exist and main judged the address openable. */
  readonly canOpenNotes: boolean;
  /** An action is admitted right now, so every button is disabled. */
  readonly busy: boolean;
}

/** Everything the pane renders, as one snapshot. */
export interface UpdateSummaryView {
  readonly state: UpdateStateView;
  readonly actions: UpdateActionsView;
  readonly residue: UpdateResidueView;
  /** This build, so the pane can say what it is running. */
  readonly currentVersion: string;
}

/** The actions a renderer may name. A closed set; none carries an argument. */
export type UpdateAction = "check" | "download" | "install" | "reveal";

export const UPDATE_ACTIONS: readonly UpdateAction[] = ["check", "download", "install", "reveal"];

export function isUpdateAction(value: unknown): value is UpdateAction {
  return value === "check" || value === "download" || value === "install" || value === "reveal";
}

/**
 * The one place this pane may send somebody outside the app.
 *
 * A closed token, not a URL. MAIN holds the address — from the re-verified
 * SIGNED manifest, never from a page — and re-validates it before opening:
 * HTTPS only, the production feed's own origin, and no embedded credentials. A
 * channel that accepted a URL from a renderer would be script-triggered browser
 * navigation, which `hardenContents` denies outright everywhere else.
 */
export type UpdateExternalTarget = "release-notes";

export function isUpdateExternalTarget(value: unknown): value is UpdateExternalTarget {
  return value === "release-notes";
}

/** The view before main has answered. `disabled` is today's shipped truth. */
export const UPDATE_SUMMARY_LOADING: UpdateSummaryView = Object.freeze({
  state: Object.freeze({ kind: "disabled" as const, reason: "no-pin" as const }),
  actions: Object.freeze({
    canCheck: false,
    canDownload: false,
    canInstall: false,
    canReveal: false,
    canOpenNotes: false,
    busy: false,
  }),
  residue: Object.freeze({ kind: "unread" as const }),
  currentVersion: "",
});
