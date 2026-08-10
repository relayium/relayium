// shouldConfirmBeforeSend gates the auto-send flow: in a cross-network code room
// a joining peer could be a code-guesser, so the sender must confirm before the
// queued files are sent. On LAN (no code) auto-send stays frictionless.
export function shouldConfirmBeforeSend(roomCode: string | null | undefined): boolean {
  return !!roomCode;
}

/** What a release decision needs to know. All of it is already on screen; none
 *  of it is a preference. */
export interface ConfirmedSendState {
  /** Whether this batch is behind the send confirmation at all — the answer
   *  `shouldConfirmBeforeSend` (with the verification preference) gave. */
  confirmed: boolean;
  /** Whether the target speaks `link/1`, so the unified workspace — not a legacy
   *  transfer card — is what would carry its verification code. */
  unified: boolean;
  /** The peer the queued batch is addressed to. */
  targetPeerId: string;
  /** The peer of the LIVE link, or "" when there is none. */
  linkPeerId: string;
  /** The code actually rendered right now, or "" for "nothing on screen". */
  shownSas: string;
}

/**
 * Whether the confirmation bar's Send may release the queued batch YET.
 *
 * The bar is a stop with exactly one stated way to answer it: compare the
 * verification code on both devices. On the legacy path that code appears on the
 * transfer card as the connection comes up, which is how it has always worked.
 * On a unified target it appears in the workspace header — and the workspace does
 * not exist until something opens it.
 *
 * That gap is the hole this closes. A preselected batch (the OS share sheet, or
 * files picked before the code was minted) arms the bar the instant one peer
 * joins the room, which is BEFORE any link and therefore before any SAS. A Send
 * that worked there would hand the files to whoever joined first — the exact
 * code-guesser the bar was added for — while telling the user nothing they could
 * have checked. So it fails closed: opening the workspace is what puts the code
 * on screen, and only then is there something to compare and something to
 * release.
 *
 * The link's own peer is checked too, not just "a code exists": a code belonging
 * to some other link is not a code for this batch's recipient.
 */
export function canReleaseConfirmedSend(s: ConfirmedSendState): boolean {
  // No bar in force (LAN, or advanced verification off) means no stop to bypass.
  // Answering "no" here would strand a queue behind a control nobody rendered.
  if (!s.confirmed) return true;
  if (!s.unified) return true;
  return s.shownSas !== "" && s.linkPeerId !== "" && s.linkPeerId === s.targetPeerId;
}

/** What the workspace's standing release control needs to know. */
export interface QueuedReleaseState {
  /** The peer of the LIVE link, or "" when there is none. An ended link has no
   *  code left to compare and nothing to release over. */
  linkPeerId: string;
  /** How many files are still waiting to be sent. */
  queued: number;
  /** Whether new outbound intent to that peer is refused right now — a held
   *  link with no transport under it and no way to rebuild, legacy work in
   *  progress, anything the workspace's own exclusion rules say no to. */
  blocked: boolean;
}

/**
 * The peer the workspace's standing release control may act on, or "" for
 * "render nothing".
 *
 * ONE answer, read by the control's visibility branch AND by its handler, for
 * the same reason `canReleaseConfirmedSend` is read by both the button branch
 * and `confirmSend`: a control that is visible under one rule and acts under
 * another is a control that can be clicked to no effect.
 *
 * That is exactly what it replaces. The button rendered for any live link with
 * a queue, while the handler resolved its target out of the ROSTER — so when
 * the peer's signalling socket went away (or this page's own) the roster
 * emptied, the DataChannel carried on, the button stayed on screen, and
 * clicking it silently did nothing. The target is resolved from the LINK here,
 * which is the thing that is actually still there.
 *
 * It releases nothing by itself: it re-arms the send confirmation, and
 * `canReleaseConfirmedSend` still stands between that and the files.
 */
export function queuedReleaseTarget(s: QueuedReleaseState): string {
  if (s.linkPeerId === "" || s.queued <= 0 || s.blocked) return "";
  return s.linkPeerId;
}
