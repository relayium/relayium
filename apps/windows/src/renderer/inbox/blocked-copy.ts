// Why a delivery stopped, said the way macOS says it.
//
// `InboxStatus.blocked` has always carried `reason: InboxFailureCode`, and the
// page rendered one generic sentence for all sixteen of them. So a person whose
// disk was full, whose receive folder had gone away, or who had declined the
// delivery themselves would read the same words. Two of those three are things
// they could have fixed in a minute.
//
// ## Not a live defect today, and saying so matters
//
// `InboxFacade.state()` returns `unavailable`, `disabled`, `receiving` or
// `idle` — never `blocked`. So nothing currently PUTS the app in this state and
// no user has read the generic sentence. This closes a latent gap: the surface,
// the status and the reason all exist, the page threw the reason away, and the
// day something starts producing the state that would have shipped as the
// behaviour. It is written now because the alternative is discovering it from a
// user who cannot tell a full disk from a delivery they declined.
//
// ## The wording is macOS's, not a Windows answer to the same question
//
// `InboxCopy.text(for:)` in `RelayiumAppKit` maps its blocker codes to ten
// sentences, and `InboxRuntimeFailure` adds enrolment and key. Those exact
// sentences are reused here, in both maintained languages, with "this Mac"
// becoming "this PC" and nothing else changed.
//
// The web client is not a reference for this: the browser never receives an
// Inbox delivery, so it has no receive-side journal and has never had to answer
// this. macOS is the only other client that has.
//
// ## Codes macOS has no twin for take macOS's own fallback
//
// Windows's `InboxFailureCode` and macOS's blocker vocabulary are not the same
// set. Where a code corresponds, the sentence is macOS's. Where it does not —
// `retention-full`, `reconcile-blocked`, `account-changed` — it takes the
// sentence macOS uses when it cannot identify a reason, rather than a new one
// written for Windows. A Windows vocabulary richer than the Mac's would be a
// fresh divergence, which is the opposite of what naming these was for.
import type { InboxFailureCode } from "../../shared/ipc-contract.js";

/**
 * Total over `InboxFailureCode`, so a code added to the contract without a
 * sentence is a compile error rather than a blank explanation.
 */
export const BLOCKED_KEY = {
  // --- macOS has these, word for word --------------------------------------
  "key-unavailable": "inboxBlockedKey",
  "verification-failed": "inboxBlockedVerify",
  "length-mismatch": "inboxBlockedVerify",
  "manifest-refused": "inboxBlockedUnsupported",
  "storage-unreadable": "inboxBlockedDirectory",
  cancelled: "inboxBlockedDeclined",
  "not-enrolled": "inboxBlockedEnrolment",
  // Four transports, one honest sentence: "couldn't be downloaded, it will be
  // tried again" is true of all of them, and the difference between a refused
  // redirect and a refused origin is not one a person can act on.
  transport: "inboxBlockedDownload",
  "redirect-refused": "inboxBlockedDownload",
  "origin-refused": "inboxBlockedDownload",
  "server-refused": "inboxBlockedDownload",

  // --- no macOS twin, so macOS's fallback ----------------------------------
  "account-changed": "inboxBlockedInternal",
  "helper-failed": "inboxBlockedInternal",
  "retention-full": "inboxBlockedInternal",
  "reconcile-blocked": "inboxBlockedInternal",
  internal: "inboxBlockedInternal",
} as const satisfies Record<InboxFailureCode, string>;
