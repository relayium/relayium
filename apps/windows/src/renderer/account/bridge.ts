// The preload surface the account screen uses. Declared, not inferred.
//
// Written down here for the same reason `InboxBridge` is written down in
// `inbox-controller.svelte.ts`: the renderer's view of the preload is otherwise
// a `globalThis` cast, and a cast agrees with whatever is on the other side
// right up until it doesn't. A declared surface makes a channel that was
// renamed, removed or given a different payload a compile error.
//
// ## Everything here is closed
//
// Every argument is a closed token or an opaque server id, and every return
// value comes from `src/shared/account-summary.ts`. In particular:
//
// * The renderer NEVER sends a URL. `manage` names a destination with a closed
//   token and main owns the mapping to an address on this build's own origin.
//   A channel that took a URL from a page would be script-triggered browser
//   navigation carrying the user's real session.
// * The renderer NEVER sends a device NAME as an identity. It sends the `id` of
//   a row it was given, and main resolves that id against the list main itself
//   holds. A page cannot address a device main is not currently showing it.
// * There is no channel here that returns a bearer, an origin, an IP address or
//   an inbox key, because there is no such value in the contract to return.

import type {
  AccountExternalTarget,
  AccountMutationOutcome,
  AccountResendOutcome,
  AccountSectionName,
  AccountSummaryView,
} from "../../shared/account-summary.js";

export interface AccountSummaryBridge {
  /** The snapshot main currently holds. Never triggers a read by itself. */
  state(): Promise<AccountSummaryView>;
  /**
   * Ask main to read again.
   *
   * `section` omitted means all three, read concurrently and independently. A
   * named section is how a failed card retries WITHOUT disturbing the two
   * beside it that succeeded.
   */
  refresh(payload: { section?: AccountSectionName }): Promise<AccountSummaryView>;
  rename(payload: { id: string; name: string }): Promise<AccountMutationOutcome>;
  revoke(payload: { id: string }): Promise<AccountMutationOutcome>;
  /**
   * Ask the server to send the verification email again.
   *
   * Takes no argument, and that is the point: main reads the address from the
   * profile the server returns for the credential main holds. See the header —
   * the renderer never supplies an identity it was not handed.
   */
  resendVerification(): Promise<AccountResendOutcome>;
  /** Open the fixed account page in the user's browser. Main validates it. */
  manage(payload: { target: AccountExternalTarget }): Promise<{ ok: boolean }>;
  /** Main pushed a new snapshot — an account change, or a read landing. */
  onState(cb: (payload: unknown) => void): () => void;
}
