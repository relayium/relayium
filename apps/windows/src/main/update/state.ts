// What the user is told, as a closed set.
//
// ## The primary message is never a hash
//
// `details` exists for the version, the size and — optionally — the verified
// SHA-256. None of it is the primary statement. A dialog whose headline is 64
// hex characters teaches the user that security is something to squint at, and
// the one decision that matters here is not made by comparing digests by eye.
//
// ## `unavailable` is not `unsigned`
//
// They are different states with different affordances, because a check that
// could not run is not a check that found nothing. `verifier-unavailable`
// offers NOTHING — no install, no reveal — since this build cannot say what it
// downloaded.
//
// ## Nothing here claims a completed update
//
// `revealed` is the end of the unsigned path, and it says the installer is on
// disk and the user must run it. It does not say the app was updated, because
// it was not: macOS's Sparkle flow ends in a replaced application, and this one
// ends in a file. Reporting them the same way would be the false parity claim.

import type { PublisherVerdict } from "./contracts.js";

export interface CandidateFacts {
  readonly version: string;
  readonly build: number;
  readonly sizeBytes: number;
  readonly notesUrl: string | null;
  /** Optional detail only — see the header. */
  readonly sha256: string | null;
}

export type UpdateState =
  /** Updates are off for this build: engineering, or no pinned key. */
  | { readonly kind: "disabled"; readonly reason: "engineering-build" | "no-pin" }
  | { readonly kind: "idle"; readonly lastCheckedAt: number | null }
  | { readonly kind: "checking" }
  | { readonly kind: "up-to-date"; readonly checkedAt: number }
  /** The check did not complete. Retryable, and says so. */
  | { readonly kind: "check-failed"; readonly reason: string; readonly retryable: boolean }
  /**
   * The feed was not signed by a pinned key. TERMINAL: no download is offered,
   * no retry is offered, and there is no "continue anyway".
   */
  | { readonly kind: "feed-untrusted"; readonly detail: string | null }
  | { readonly kind: "update-available"; readonly candidate: CandidateFacts }
  | {
      readonly kind: "downloading";
      readonly candidate: CandidateFacts;
      readonly receivedBytes: number;
    }
  /** The bytes did not match the signed manifest. The file is retired. */
  | { readonly kind: "verify-failed"; readonly candidate: CandidateFacts; readonly reason: string }
  /** Verified bytes, verified publisher. The only state that may install. */
  | { readonly kind: "ready"; readonly candidate: CandidateFacts }
  /**
   * Verified bytes, no publisher signature. The app may REVEAL the file and
   * must never execute it.
   *
   * ## What the copy for this state may and may not say
   *
   * It must say the installer carries no publisher identity, because Relayium
   * has no code-signing certificate — a fact about us, not about the download,
   * and not something the user can fix.
   *
   * It must NOT promise a specific Windows reaction. Microsoft's own guidance
   * (learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation)
   * is that reputation is not granted by certificate type — EV no longer confers
   * it by default — so signing establishes identity and does NOT guarantee the
   * absence of a warning. And an unknown unsigned binary is not universally a
   * click-through prompt: Smart App Control can BLOCK it outright, with no
   * "run anyway" at all. So the copy describes what we did and did not verify
   * and leaves the platform's decision to the platform.
   *
   * It must never tell a user to turn a protection off.
   */
  | { readonly kind: "ready-unsigned"; readonly candidate: CandidateFacts }
  /** Signed by someone else. A stronger signal than unsigned. Terminal. */
  | { readonly kind: "publisher-mismatch"; readonly candidate: CandidateFacts }
  /** The publisher check could not run. Not `unsigned`, and not ready. */
  | { readonly kind: "verifier-unavailable"; readonly candidate: CandidateFacts }
  /** The user asked to install and the app is quiescing / launching. */
  | { readonly kind: "installing"; readonly candidate: CandidateFacts }
  /** The resident side refused to be interrupted. Not an error. */
  | { readonly kind: "install-deferred"; readonly candidate: CandidateFacts; readonly reason: string }
  /** The unsigned path's terminus: the file is on disk and shown to the user.
   *  NOT an update. */
  | { readonly kind: "revealed"; readonly candidate: CandidateFacts }
  /**
   * The local record could not be read, or is not the shape this code writes.
   *
   * A REFUSAL, not a reset: the record and any staged file are left exactly as
   * they are. An earlier revision turned every read error into an empty
   * document, which could overwrite a real candidate.
   */
  | { readonly kind: "journal-unavailable"; readonly reason: string }
  /**
   * Work is refused because this installation cannot safely own new state.
   *
   * `unresolved-residue`: deletions it could not confirm, or a claim it could
   * not settle. Bounded ADMISSION — nothing is evicted to make room.
   *
   * `staging-unowned`: the staging directory could not be established as this
   * app's — it is redirected, or this platform has no adapter that can hold one
   * (see `custody.ts`). Nothing is created and nothing is deleted, which is the
   * honest state for a build that cannot prove what it would be writing into.
   */
  | {
      readonly kind: "blocked";
      readonly reason: "unresolved-residue" | "staging-unowned";
      readonly count: number;
      readonly detail: string | null;
    };

/** Which states may lead to running an installer. Exactly one. */
export const canInstall = (state: UpdateState): boolean => state.kind === "ready";

/** Which states may reveal a file. Exactly one, and only for manual
 *  distribution — it never executes anything, and the state it leads to
 *  (`revealed`) never claims an update happened. */
export const canReveal = (state: UpdateState): boolean => state.kind === "ready-unsigned";

/** The verdict-to-state mapping, so the four publisher answers cannot be
 *  collapsed by accident at a call site. */
export function stateForVerdict(verdict: PublisherVerdict, candidate: CandidateFacts): UpdateState {
  switch (verdict) {
    case "signed-by-expected-publisher":
      return { kind: "ready", candidate };
    case "unsigned":
      return { kind: "ready-unsigned", candidate };
    case "signed-by-other-publisher":
      return { kind: "publisher-mismatch", candidate };
    case "unavailable":
      return { kind: "verifier-unavailable", candidate };
  }
}
