// The decisions the "advanced verification" preference actually changes.
//
// Kept as pure functions rather than inline conditions in App.svelte for one
// reason: what this preference does NOT change is a security claim, and a claim
// that only exists as a template expression can only be tested by grepping the
// template. These can be executed. `autoAcceptsIncomingFile` in particular has
// no parameters that could ever make it true — that is the point of it.
//
// The preference itself (storage, default) lives in verify-pref.svelte.ts.

import { shouldConfirmBeforeSend } from "./confirm-send";

/** The SAS to render, or "" for "render nothing". Every SAS render site in the
 *  app reads this rather than the workspace's raw code, so a new surface cannot
 *  forget the check and quietly put the code back on screen. */
export function shownSasCode(verifyOn: boolean, sasCode: string): string {
  return verifyOn ? sasCode : "";
}

/**
 * Whether a queued batch waits for an explicit "send to this peer" click.
 *
 * The bar exists because a cross-network joiner might be a code-guesser, and the
 * remedy it offered was "look at the SAS before you send". With the preference
 * off there is no SAS on screen, so the bar would be a confirmation with nothing
 * behind it — a click-through, which is worse than no prompt at all. LAN has
 * always auto-sent; a code room now matches it unless the user opts in.
 */
export function needsSendConfirmation(verifyOn: boolean, roomCode: string | null | undefined): boolean {
  return verifyOn && shouldConfirmBeforeSend(roomCode);
}

/**
 * Whether an incoming TEXT session request opens straight into the composer.
 *
 * Accepting is what installs the message listener, so nothing is decrypted any
 * earlier than the session already required — the step being skipped is the
 * human decision, not a cryptographic one.
 */
export function autoAcceptsIncomingText(verifyOn: boolean, status: string): boolean {
  return !verifyOn && status === "incomingRequest";
}

/**
 * Whether an incoming FILE offer is ever accepted without the user IN THIS
 * CLIENT. It is not, in any verification mode, and this function takes no
 * arguments that could change that.
 *
 * Scope matters: this is the browser's rule, not the product's. The native
 * macOS app accepts an incoming manifest itself and writes into its configured
 * destination — Downloads by default. Nor is the browser's click a
 * confidentiality control — an unintended recipient simply clicks Accept. It
 * keeps files off the disk of someone who did not ask for them.
 *
 * Two separate reasons for keeping it, either one sufficient:
 *   - It is content and save consent — "these bytes, this folder" — which is a
 *     different question from "is this peer who they say they are".
 *   - The click is the transient user gesture the File System Access / directory
 *     pickers require, and where the large-batch memory warning is shown. Skip
 *     it and the picker throws instead of opening.
 */
export function autoAcceptsIncomingFile(): false {
  return false;
}
