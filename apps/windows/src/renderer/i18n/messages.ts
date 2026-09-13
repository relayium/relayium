// Every string this client puts on screen, in the two maintained languages.
//
// ## Why these are here and not imported from `web/src/lib/i18n`
//
// The web catalogue is a page's vocabulary — routes, SEO copy, a download page,
// a browser's permission prompts. Almost none of it describes a desktop app that
// lives in a tray and talks about "this PC". Importing it would give this client
// a large catalogue of strings it must not use and a small number it needs, and
// the maintained-language gate would then be checking the wrong set.
//
// So this is its own catalogue, and it is deliberately small. Where a term is
// genuinely shared product vocabulary it uses the same words the web and Mac
// clients use, because a user who has seen one should recognise the other.
//
// ## The rule the type enforces
//
// `zh` is typed as the same key set as `en`, so a missing translation is a
// compile error rather than a silent English fallback in a Chinese UI. English
// is the source and the fallback; the supported-language policy requires both to
// be complete, and `i18n.test.ts` asserts it at runtime too.

export const en = {
  appName: "Relayium",

  navRealtime: "Transfer now",
  navLan: "Same network",
  navPair: "Pairing code",
  navStored: "Send a link",
  navInbox: "Device Inbox",
  navAccount: "Account",

  thisPc: "This PC",

  // --- Same network -------------------------------------------------------
  lanTitle: "Same network",
  /**
   * What the list actually IS, which is not what this used to say.
   *
   * It read "Send to a device on this network, with nothing going through a
   * server", and both halves overstated. Relayium never scans a network: it
   * asks its rendezvous service who else arrives from the same public address,
   * which is usually your Wi-Fi and sometimes is not. And whether the transfer
   * runs directly or over a Relayium relay depends on the network — this
   * screen's own help panel already says so (`helpLanBoundary`), and said the
   * opposite of the lede above it. What IS true either way is that Relayium
   * has no key, so that is the promise kept here.
   */
  lanSubtitle: "Send to another device that reaches the internet from the same address as this PC. Encrypted end to end, so Relayium cannot read it either way.",
  /**
   * Said beside the list, because it is a description of the list.
   *
   * macOS says the same thing in `nearby.safetySummary`. Deliberately not a
   * warning banner: the risk is real and ordinary, and an alarm gets dismissed
   * and teaches nothing. The previous screen said nothing at all — its help
   * panel mentioned the grouping only as a reason a device you EXPECT might be
   * missing, never as a reason one you do not expect might be present.
   */
  lanSafety:
    "Usually that address is your Wi-Fi. On a carrier network, a VPN, or a shared gateway it can include devices that are not yours, so check who you are sending to.",
  /** With the names it is about, as macOS puts `nearby.namesDisclaimer`. */
  lanNamesDisclaimer:
    "Names come from the other device and are not proof of who it is. Turn on \u201c{setting}\u201d in Settings to compare a code before anything is sent.",
  lanOff: "Receiving is off",
  // Says the whole consequence, because it is not obvious and it is not small.
  lanOffBody:
    "This PC is not in the same-network room, so it cannot be seen and cannot see other devices. Turn receiving on to find devices and send to them.",
  lanStart: "Start receiving",
  lanStop: "Stop receiving",
  lanJoining: "Joining…",
  lanEmpty: "No other devices yet",
  lanEmptyBody: "Open Relayium on another device on this network and it will appear here.",
  lanJoiningTitle: "Joining this network…",
  lanJoiningBody: "Looking for Relayium on this network.",
  lanReconnecting: "Reconnecting…",
  lanReconnectingBody: "The connection dropped. Trying again.",
  lanOffline: "Cannot reach Relayium",
  lanOfflineBody:
    "This PC could not join the same-network room, so it cannot see other devices or be seen by them. Check your connection.",
  lanRetry: "Try again",
  lanConnect: "Connect",
  lanUnsupported: "This device is running an older version and cannot connect.",
  lanDisconnect: "Disconnect",

  // --- Pairing code -------------------------------------------------------
  pairTitle: "Pairing code",
  pairSubtitle: "Transfer between networks using a short code.",
  pairCreate: "Create a code",
  pairCreating: "Creating…",
  pairYourCode: "Your code",
  pairEnterCode: "Enter a code",
  pairJoin: "Join",
  pairExpires: "Expires in {minutes} min",
  pairSignedOut: "Sign in to create a code. Joining someone else's code needs no account.",
  pairQuota: "You have used this month's relay allowance. You can still join a code someone else created.",
  pairUnverified: "Verify your email address to create a code.",
  pairRateLimited: "Too many attempts. Wait a moment and try again.",
  pairUnavailable: "Could not reach Relayium. Check your connection and try again.",
  pairBadCode: "A code is six digits.",
  pairRefused: "That code is not valid, or it has expired.",
  pairUnreachable:
    "Could not reach Relayium, so the code could not be checked. This is a connection problem, not a bad code.",

  // --- Connected ----------------------------------------------------------
  linkConnected: "Connected to {peer}",
  linkRequesting: "Asking {peer} to connect…",
  linkConnecting: "Connecting to {peer}…",
  linkInterrupted: "Connection to {peer} was interrupted",
  linkFailed: "Could not connect to {peer}",
  linkCancel: "Cancel",
  pairWaiting: "Waiting for the other device to join…",
  pairDisconnected: "Disconnected",
  pairDisconnectedBody:
    "You disconnected from this device. It is still in the room, so you can connect again.",
  pairReconnect: "Connect again",
  pairRegenerate: "Create a new code",
  pairExpired: "This code has expired",
  pairLeave: "Leave",
  linkSendFiles: "Send files",
  linkSendFolder: "Send a folder",
  linkDropHint: "or drop files here",
  linkMessage: "Message",
  textIncoming: "{peer} wants to start a conversation",
  textAccept: "Accept",
  textDecline: "Decline",
  textWaiting: "Waiting for the other device to accept…",
  textRefused: "The other device declined the conversation.",
  textPeerBusy: "The other device is busy.",
  textUnsupported: "The other device cannot hold a conversation.",
  textTooLong: "That message is too long to send.",
  /**
   * The two `TextErrorKey` members this client used to render as SILENCE.
   *
   * The chain that consumed the union covered four of its six named members,
   * and returned "" for the rest — so a message that could not be sent, and a
   * session closed because the peer sent too many, told the user nothing at
   * all. The wording is the web client's, which is accurate about the
   * mechanism: `flooding` is a rate-limit bucket, not a receive buffer, so
   * macOS's "before verification finished" would describe something else.
   */
  textFlooding: "The other device sent too many messages; the session was closed.",
  textFailed: "The message session failed.",
  textDropped: "That message was not sent. It is still in the box.",
  linkSend: "Send",
  linkVerifyTitle: "Check this code matches",
  linkVerifyBody: "Both devices should show the same code.",
  linkVerifyConfirm: "It matches",
  linkVerifyDecline: "It does not match",
  linkVerifyDeclined: "You said the codes did not match, so the connection was closed.",
  linkVerifyPending: "Waiting for the verification code…",
  linkStatusIdle: "Not connected",
  linkStatusRequesting: "Asking to connect",
  linkStatusConnecting: "Connecting",
  linkStatusOpen: "Connected",
  /**
   * THIS device is engaged, which is the opposite advice from `textPeerBusy`.
   *
   * Both used to be "The other device is busy." — wrong, not merely vague, in
   * the local case: it blames the peer for a link the user themselves has
   * open. macOS keeps the two apart for the same reason and says so, because
   * the sentence names the device it is about.
   */
  textSelfBusy: "This PC is already in another connection. End it, then try again.",
  linkStatusInterrupted: "Interrupted",
  linkStatusFailed: "Failed",

  // --- Why a link ended, and the two warnings that come before it ----------
  //
  // The workspace has published all three of these since Windows started using
  // it, and this client read none of them: a relay credential running out, or
  // a lost signalling socket meaning the link can never be rebuilt, was silent
  // — and when either ENDED the link it read as an unexplained "Failed".
  //
  // The wording is the WEB client's, not macOS's, and deliberately. macOS says
  // "start again from the device list" because its equivalent surface is
  // Nearby; Windows pairs by code, as the web does, so "start again" here
  // means make another code. macOS applies the same rule to itself — its
  // `endedUnavailable` and `endedUnavailableIOS` differ only because the
  // sentence names the device it is about.
  linkEndedRelay: "The relay time limit for this connection was reached. Start again to keep going.",
  linkEndedSignaling:
    "The connection to the pairing service was lost, so this link could not be restored. Start again.",
  /** A WARNING, not a state: the link is fully live and both lanes still work. */
  linkRelayExpiring:
    "This relayed connection is close to its time limit. Finish what is in flight, then start a new one.",
  /** Said BEFORE anything breaks, which is the only time it is any use. */
  linkRecoveryUnavailable:
    "Not connected to the pairing service, so this connection cannot be restored if it drops. Until then everything here keeps working, including new files and messages.",
  linkRestart: "Start again",

  // --- Receiving ----------------------------------------------------------
  recvIncoming: "{peer} wants to send {count} file(s)",
  recvAccept: "Choose where to save",
  recvDecline: "Decline",
  recvSaving: "Saving…",
  recvPartial: "Saved {done} of {total}. The rest could not be written.",
  recvCancelled: "Cancelled",
  // The honest interim state. Never rendered as a save.
  recvUnsupported:
    "This build can receive the files but cannot yet write them to their final names. Nothing was saved.",
  /**
   * A real write failure, and now ONLY that.
   *
   * This sentence used to be the answer for every partial publication failure
   * on Windows, because the helper's own wire codes reached this screen
   * untranslated and no branch could match them. A full disk, a file locked by
   * another program, a name already taken and a permission denial all said
   * "could not write to the folder you chose" — which for a full disk sends
   * somebody to check permissions on a folder that is perfectly fine.
   *
   * The two keys below it were written for exactly those cases and had never
   * once been reachable.
   */
  recvFailedPrefix: "Could not write to the folder you chose.",
  recvFailedPermission: "Relayium is not allowed to write to the folder you chose.",
  recvFailedConflict: "Some files already exist there under the same names.",
  recvFailedNoSpace: "There is not enough free space in that folder.",
  recvFailedInUse: "One of those files is open in another program. Close it, then receive again.",
  recvFailedGone: "That folder is no longer there. Choose another one and receive again.",
  /** The NAMES were validated before a byte was written, so what is too long
   *  is the destination this app was pointed at. */
  recvFailedNameTooLong: "The path inside that folder is too long for Windows. Choose a folder closer to the drive root.",
  recvFailedTimeout: "The save timed out.",
  recvFailedInternal: "The save could not be completed.",
  /** Not a failure at all. Saying "could not write" about a cancel is false. */
  recvFailedCancelled: "The save was cancelled.",
  /**
   * The one reason that most needed its own sentence and had none.
   *
   * `cleanup-uncertain` means the write may well have SUCCEEDED and only the
   * teardown could not confirm it. It used to fall through to "Could not write
   * to the folder you chose", which is not vague — it is a false statement
   * about the user's own disk. The residue line renders beside this, because
   * `residue` is true for exactly this case.
   */
  recvFailedUncertain:
    "The save did not finish cleanly, so Relayium cannot confirm which files were written.",
  recvResidue: "Some incomplete files may still be in that folder.",
  recvSavedCount: "Saved {done} of {total}",
  recvReveal: "Show in Explorer",
  /** The per-file list a finished receive announces. */
  recvFilesTitle: "Received files",
  /** The gate that stands in for a half this account cannot use. */
  gateSignedOutSendTitle: "Sending a link needs an account",
  gateSignedOutSendBody: "Links are hosted under your account, so this half needs you signed in. Opening a link somebody sent you does not.",
  /** The one action that ends being signed out. */
  gateSignIn: "Sign in",
  /**
   * On-screen help: six answers per screen.
   *
   * Every screen says what it is and hands over its controls, which leaves
   * somebody who does not already know what a pairing code is, or where a
   * received file goes, with nowhere to look but outside the app.
   */
  helpHeading: "Help",
  helpStepsHeading: "How it works",
  helpBoundaryHeading: "What Relayium can see",
  helpWhereHeading: "Where things end up",
  helpTroubleHeading: "If it doesn't work",
  helpShow: "Show how this screen works, what Relayium can see, and what to do when it doesn't work",
  helpHide: "Hide the details",
  /** Wording matches macOS's `error.selection.tooManyFiles` and the web's
   *  `tooManyFiles`, rather than a third sentence for the same refusal. */
  sendTooManyFiles:
    "That selection holds more than {max} files. Send fewer files, or zip the folder first.",
  dropUnreadable: "Some of what you dropped could not be read, so nothing was taken. Try again, or use the Choose files button.",
  inboxSendDropHint: "or drop files here",
  helpGuideLink: "Read the guide on relayium.com",
  helpGuideLinkFailed: "Could not open your browser.",
  helpLanPurpose: "Move files or send a message between two devices on the same network. No account, and nothing is stored on a server.",
  helpLanStep1: "Open Relayium on both devices and keep them on the same network.",
  helpLanStep2: "Choose the other device from the list, then send a message or send the files you have added.",
  helpLanStep3: "If verification is on, check that both screens show the same code before you accept.",
  helpLanBoundary: "Files are encrypted end to end: encrypted on this PC before they leave and decrypted only on the other device, so Relayium never has the key. What Relayium's service does is introduce the two devices to each other. Depending on the network the connection may run between the two devices, or a Relayium relay may carry it, and this PC cannot tell which \\u2014 it makes no difference to what Relayium can read.",
  helpLanWhere: "Files you receive are saved to the folder you choose when you accept them. A conversation lives only on the two devices and is discarded when the connection ends; nothing is kept on a server.",
  helpLanFailure: "The other device is not in the list. Devices are grouped by the network path Relayium's service observes, so a guest network, a VPN, or a router that keeps clients apart can put two devices on the same cable into different groups.",
  helpLanRecovery: "Check that both devices are receiving, turn off any VPN, and join the same network. If they still can't see each other, use a pairing code on the Cross-network screen instead \\u2014 that one needs no shared network.",
  helpPairPurpose: "Reach a device anywhere by passing on a six-digit code. The two devices do not have to be on the same network.",
  helpPairStep1: "Create a pairing code, then pass on the code, the link beside it, or the QR code.",
  helpPairStep2: "The other person enters that code in Relayium, opens the link, or scans the QR code.",
  helpPairStep3: "Check that both screens show the same code, then send messages and files on that one connection.",
  helpPairBoundary: "Files are encrypted on this PC before they leave and Relayium never has the key. Creating a code needs an account because the connection may have to be relayed, and those bytes are billed to whoever created the code. Entering a code somebody else created needs no account at all.",
  helpPairWhere: "Files you receive are saved to the folder you choose when you accept them. Messages stay on the two devices and are discarded when the connection ends. Nothing you send this way is stored on Relayium's servers.",
  helpPairFailure: "A pairing code lasts only a few minutes. After that the other device is told the code is invalid or expired, which is also what it sees if the code was mistyped.",
  helpPairRecovery: "Create a fresh code and pass on the new one. Anything you added is still here and does not have to be chosen again.",
  helpStoredPurpose: "Upload encrypted files once and hand out a link that keeps working while this PC is asleep or closed \\u2014 or open a link somebody sent you, which needs no account.",
  helpStoredStep1: "Choose files or folders, decide how long the link should keep working, and send.",
  helpStoredStep2: "Relayium encrypts everything on this PC before any of it is uploaded.",
  helpStoredStep3: "Share the link. The key that opens it travels inside the link and never reaches Relayium.",
  helpStoredBoundary: "The files are encrypted on this PC before any of them are uploaded. The key lives in the part of the link after the #, which a browser never sends to a server, so Relayium stores something it cannot read. Anyone holding the whole link can open the files, so treat it as the files themselves.",
  helpStoredWhere: "The encrypted files sit on Relayium's servers until the link expires or you delete them from the history below. Deleting them there breaks the link immediately. Files you open from somebody else's link are saved to the folder you choose.",
  helpStoredFailure: "A link that was shortened, wrapped by a chat app, or copied without the part after the # cannot be opened. What is missing is the key, not the file.",
  helpStoredRecovery: "Copy the link again from the history below and send it somewhere that keeps it intact. If it has already expired, send the files again.",
  helpInboxPurpose: "Give this PC an address of its own, so your other signed-in devices can send files straight to it.",
  helpInboxStep1: "Sign in to the same account here and on the device you want to send from.",
  helpInboxStep2: "Choose a folder on this PC, then decide whether deliveries are saved automatically or held for your answer.",
  helpInboxStep3: "Send to this PC from relayium.com or another signed-in device, and the files land in that folder.",
  helpInboxBoundary: "Deliveries are encrypted for this PC's own key, which never leaves it. Relayium holds the encrypted delivery until this PC collects it and cannot read what is inside, or tell you what the files are called.",
  helpInboxWhere: "Accepted deliveries land in the folder chosen above. Anything still waiting stays on the server until this PC collects it or it expires.",
  helpInboxFailure: "Nothing arrives while this PC is asleep, signed out, or Relayium is not running. It can receive only while it is running, and receiving can also be paused from the tray.",
  helpInboxRecovery: "Open Relayium and sign in to the same account, and whatever was waiting arrives. Turn on start at sign-in on the Account screen so it is running without you having to think about it.",
  helpAccountPurpose: "Your plan, what you have used this period, and the devices signed in to your account.",
  helpAccountStep1: "Create an account or sign in \\u2014 sending a link and the Device Inbox both need one.",
  helpAccountStep2: "See which plan you are on and how much of it you have used this period.",
  helpAccountStep3: "Review the devices signed in to your account and remove any you no longer use. Files you have stored are on the Stored links screen.",
  helpAccountBoundary: "Relayium holds your email address, which plan you are on, and how many bytes you have moved. It never holds the keys to your files, so nothing on this screen \\u2014 and nothing in Relayium's database \\u2014 can open them.",
  helpAccountWhere: "Signing a device out ends that device's session and nothing else; files it has already received stay on it. Stored files are removed from the Stored links screen, which breaks their links straight away.",
  helpAccountFailure: "Creating a pairing code and sending a link stop working once this period's allowance is spent. Same-network transfer, and connecting with a code somebody else created, are unaffected \\u2014 neither is billed to you.",
  helpAccountRecovery: "Wait for the period to roll over, or change plan. Same-network transfer keeps working either way, because it moves no bytes through Relayium.",
  /** Shows ONE file rather than the folder the batch went to. */
  recvShowFile: "Show",
  recvDragHint: "Drag a file out to copy it somewhere else.",
  recvActionMissing: "That file is no longer there. It may have been moved, renamed, or deleted since it arrived.",
  recvActionExpired: "That file is no longer available from here. Receive it again to get a fresh copy.",
  recvActionClosing: "Relayium is closing. Nothing was opened.",
  recvActionFailed: "That did not work. Nothing was opened.",
  recvRevealBusy: "Opening\u2026",
  /** Each refusal names a different situation, because each has a different
   *  next action. Never the operating system's own text, which carries the
   *  path this app deliberately keeps out of the page. */
  recvRevealMissing: "That folder is no longer there. It may have been moved, renamed, or on a drive that is now disconnected.",
  recvRevealExpired: "This no longer applies to the account signed in now.",
  recvRevealClosing: "Relayium is closing.",
  recvRevealFailed: "Windows could not open that folder.",

  // --- Account ------------------------------------------------------------
  accountTitle: "Account",
  accountSignedInAs: "Signed in as {email}",
  accountSignedOut: "Not signed in",
  accountWhy: "An account is needed to create a pairing code. Same-network transfers need no account.",
  accountSignIn: "Sign in",
  accountSignOut: "Sign out",
  accountCancel: "Cancel",
  accountRetry: "Try again",
  accountOpening: "Opening your browser…",
  accountEnterCode: "Enter this code in your browser",
  accountExpiresIn: "This code expires in {minutes} min.",
  accountStoreUnreadable:
    "Relayium cannot open its private storage on this PC, so signing in is unavailable. Same-network transfers still work.",

  // --- Why the account screen is showing a failure ------------------------
  //
  // One per `FailureReason`. They exist because the screen used to render
  // whatever string arrived — an Electron IPC rejection, or a sentence written
  // for a developer — to every user in every language.
  accountFailedUnreachable: "That could not be completed just now. Check your connection and try again.",
  accountFailedDeclined: "That sign-in was declined.",
  accountFailedExpired: "That code expired. Try signing in again.",
  /** Certain: a credential is on this PC and cancelling did not remove it. */
  accountFailedCredentialRemains:
    "Cancelling did not remove the sign-in credential it had already saved on this PC. Sign in and then sign out to clear it.",
  /** Uncertain, and says so rather than guessing in either direction. */
  accountFailedCredentialUncertain:
    "Cancelling could not check whether a sign-in credential was left on this PC. Sign in and then sign out to be sure it is cleared.",

  startingTitle: "Starting Relayium…",
  startingBody: "Preparing secure transfer.",
  startFailedTitle: "Relayium could not start",
  startFailedBody:
    "The encryption library could not be loaded, so transfers cannot run. Nothing has been sent or received.",
  startRetry: "Try again",

  // --- This build may no longer run -----------------------------------------
  //
  // Not an error and not a failure: the product has withdrawn support for this
  // version. Says what is required and what to do, and never blames the user or
  // their machine.
  unsupportedTitle: "This version of Relayium can no longer run",
  /** macOS's `update.recommendedTitle` / `recommendedBody` / `actionDismiss`,
   *  with "this Mac" becoming "this PC". Not a second answer to one question. */
  updateRecommendedTitle: "A newer Relayium is available",
  updateRecommendedBody: "This PC is running {current}. The current release is {latest}.",
  updateRecommendedDismiss: "Not now",
  unsupportedBody:
    "Relayium {current} is below the minimum supported version, {minimum}. Update to {latest} to continue. Nothing has been deleted, and your files and keys are untouched.",

  settingsTitle: "Settings",
  settingsVerify: "Ask me to check a verification code",
  settingsVerifyHelp:
    "Every connection is encrypted and authenticated either way. Turn this on to also compare a short code with the other device before anything is sent.",

  settingsUnreadable:
    "Relayium could not read its saved settings on this PC, so it does not know whether you asked to check verification codes. Until you choose below, it asks every time. Nothing has been changed on disk.",
  settingsSaveFailed: "That setting could not be saved.",

  settingsStartup: "Open Relayium at sign-in",
  settingsStartupHelp:
    "Relayium keeps running in the notification area, so it is ready to receive without opening it first.",
  settingsStartupOn: "Relayium starts when you sign in.",
  settingsStartupOff: "Relayium does not start when you sign in.",
  settingsStartupDisabled:
    "Relayium is listed in your startup programs but is turned off there, so it will not start. Turn it back on in Task Manager, under Startup apps.",
  settingsStartupOther: "Something else on this PC starts Relayium when you sign in.",
  settingsStartupUnreadable:
    "Windows could not be asked whether Relayium starts at sign-in, so this is unknown rather than off.",
  settingsStartupWriteFailed: "That could not be changed on this PC.",
  /**
   * The PROMPT failed, so nothing was attempted.
   *
   * Distinct from the sentence above it because the culprit is different:
   * `enable()` returns `consent-failed` when `askConsent()` throws, and
   * Windows refused nothing. Telling somebody their PC would not take the
   * change sends them to look for a machine problem that is not there.
   */
  settingsStartupConsentFailed:
    "Relayium could not ask you to confirm, so nothing was changed. Try the switch again.",

  // --- Stored ------------------------------------------------------------
  storedTitle: "Send a link",
  storedSubtitle: "Receive a file someone sent you as a link, or send one yourself.",
  storedReceiveHeading: "Receive from a link",
  storedReceiveBody:
    "Paste the link you were sent. Nothing is downloaded until you choose a folder.",
  storedLinkLabel: "Paste a link",
  storedReceiveAction: "Open link",
  storedCancel: "Cancel",
  storedRetry: "Try again",
  storedFromDeepLink: "A link was opened. Check it, then choose where to save.",
  storedProgress: "Saving… {percent}%",
  storedSaved: "Saved {count} file(s).",
  storedPartial: "Saved {count} of {total}. The rest could not be saved.",
  storedDeclined: "Nothing was downloaded.",
  storedCancelled: "Cancelled. Nothing was saved.",
  storedResidue: "Some partly-written files may still be in that folder.",
  storedUnconfirmed:
    "This could not be confirmed. Check the folder you chose before trying again.",
  storedFailedLinkInvalid: "That is not a Relayium link.",
  storedFailedNotFound: "That link has expired, or has already been used once.",
  storedFailedForbidden: "That link cannot be opened from this account.",
  storedFailedIntegrity:
    "The file did not match its link. Nothing was saved, and trying again will not help — ask the sender for a new link.",
  storedFailedNetwork: "Relayium could not be reached. Check your connection.",
  storedFailedRuntime: "This build could not load what it needs to open the link.",
  storedFailedGeneric: "That link could not be opened.",
  storedAtCapacity: "Finish or cancel a transfer before starting another.",
  storedTooLong: "That link is longer than any Relayium link.",
  storedUnavailable: "Relayium is shutting down.",
  storedRetained: "{count} folder(s) could not be cleaned up.",
  storedRetainedRetry: "Try cleaning up again",
  storedRetainedClean: "Cleaned up.",
  storedRetainedStuck: "Still could not be cleaned up.",
  storedRetainedUnavailable: "Not tried — Relayium is closing. The folder is still tracked.",


  // --- Device Inbox -------------------------------------------------------
  inboxTitle: "Device Inbox",
  inboxSubtitle: "Receive files and messages from your own devices, even when this window is closed.",

  // The switch, and what turning it on actually does. Said in full because it
  // is consent: enabling tells Relayium's server this PC can be sent to, and
  // picking the folder is the same act.
  inboxOffTitle: "Receiving is off",
  inboxOffBody:
    "Turn this on to let your other Relayium devices send files and messages to this PC. You choose the folder they arrive in, and you are asked before anything is saved.",
  inboxTurnOn: "Turn on receiving",
  // The WITHDRAWAL, not the Off policy. "Turn off receiving" beside an Off
  // radio that is already selected reads as a redundant second toggle for the
  // same thing; these are different acts. Off keeps the device enrolled and
  // tells central to refuse sends. This unenrols it entirely.
  inboxTurnOff: "Stop using Inbox on this PC",
  inboxOnTitle: "Receiving is on",
  // The resident promise, stated where it can be checked. This is the reason
  // the feature exists on a desktop client rather than in a browser tab.
  inboxBackgroundNote: "Deliveries keep arriving while this window is closed or while you are on another page.",
  inboxCanReceive: "This PC can receive files and messages.",
  inboxCanReceiveFiles: "This PC can receive files.",
  inboxCanReceiveText: "This PC can receive messages.",

  inboxNeedsAccountTitle: "Sign in to use the Device Inbox",
  inboxNeedsAccountBody: "The Device Inbox delivers to your own devices, so it needs the account they share.",
  inboxAccountUnreadableTitle: "This PC's secure storage could not be read",
  // Truthful about the consequence rather than reassuring: the enrolment may
  // well still be live, so this does not say receiving has stopped.
  inboxAccountUnreadableBody:
    "Relayium could not open the encrypted storage that holds this device's keys. Receiving cannot continue until it can, and your messages have not been deleted.",

  inboxFolderMissingTitle: "The receiving folder is not there",
  inboxFolderMissingBody:
    "Receiving is still on, but the folder you chose cannot be found — it may have been moved, renamed, or be on a drive that is disconnected. Choose it again to continue.",
  inboxChooseFolder: "Choose folder",
  inboxChangeFolder: "Change folder",
  inboxFolderChosen: "Files will arrive in the folder you chose.",

  inboxStartingBody: "Registering this PC with your account.",
  inboxIdleBody: "Nothing is waiting right now.",
  inboxReceivingTitle: "Receiving…",
  inboxReceivingBody: "A delivery is being saved.",
  inboxBlockedTitle: "Something needs a decision",
  // --- Why a delivery stopped ----------------------------------------------
  //
  // macOS's own sentences, reused rather than re-answered: `InboxCopy.text(for:)`
  // in `RelayiumAppKit`, with "this Mac" becoming "this PC". See
  // `inbox/blocked-copy.ts` for which Windows code takes which, and why the
  // codes macOS has no twin for take its fallback instead of a new sentence.
  inboxBlockedDirectory:
    "A delivery stopped because the receive folder wasn't available. Reconnect the disk, or choose another folder.",
  inboxBlockedDownload: "A delivery couldn't be downloaded. It will be tried again.",
  inboxBlockedVerify:
    "A delivery didn't match what the sender described, so nothing was saved. Ask them to send it again.",
  inboxBlockedDeclined: "You declined this delivery. Nothing was saved.",
  inboxBlockedUnsupported:
    "A delivery uses something this version doesn't support. Updating Relayium may fix it.",
  inboxBlockedInternal:
    "A delivery stopped for a reason this PC couldn't identify, so nothing was saved.",
  inboxBlockedKey:
    "This PC's receiving key is unavailable, so nothing can be decrypted. Sign in again, then try again.",
  inboxBlockedEnrolment:
    "Relayium couldn't set this PC up to receive. Updating to the latest version may fix it.",
  inboxOfflineTitle: "Cannot reach Relayium",
  inboxOfflineBody: "Trying again in {seconds}s.",
  inboxRetryNow: "Try again now",
  inboxUnavailableTitle: "Not available in this build",
  inboxUnavailableBody: "This build cannot receive deliveries yet, so there is nothing to switch on.",
  inboxWithdrawalPending:
    "Relayium could not tell the server this PC has stopped receiving. It will keep trying; until it succeeds, your other devices may still offer to send here.",

  inboxPendingHeading: "Waiting for you",
  inboxPendingEmpty: "Nothing is waiting.",
  inboxPendingItem: "{bytes} from one of your devices",
  inboxAccept: "Accept",
  inboxReject: "Decline",
  inboxAcceptedSaved: "Saved.",
  inboxAcceptedSavedMessage: "Message saved.",
  inboxAcceptedPartial: "Partly saved: {saved} of {total} files.",
  inboxAcceptedQueued: "Accepted. It will be received shortly.",
  inboxAcceptedBlocked: "This delivery needs a decision and was not received.",
  inboxAcceptedSettled: "That delivery is no longer waiting.",
  inboxAcceptedBusy: "Another delivery is being received. Try again in a moment.",
  inboxAcceptedRefused: "Not accepted — Relayium is closing.",
  inboxAckPending: "Saved. The server has not confirmed yet.",

  inboxMessagesHeading: "Messages",
  inboxMessagesEmpty: "No messages yet.",
  inboxMessageItem: "From one of your devices",
  inboxOpen: "Open",
  inboxClose: "Close",
  inboxCopy: "Copy",
  inboxCopied: "Copied",
  inboxCopyFailed: "Could not copy",
  inboxCopyFailedBody: "The message could not be read just now. Select the text above and copy it.",
  inboxDelete: "Delete",
  inboxMessageKept: "Messages stay on this PC until you delete them. Turning receiving off does not remove them.",

  inboxDeviceHeading: "This device",
  inboxDeviceUnnamed: "Not named yet",
  inboxRenameLabel: "Device name",
  inboxRename: "Rename",
  inboxRenamed: "Renamed.",

  inboxRetainedHeading: "Could not be cleaned up",
  inboxRetainedBody:
    "A delivery was stopped and Relayium could not confirm that the partly-written files were removed. You can ask it to try again.",
  inboxRetainedRetry: "Try cleanup again",
  // What each retained row says. One per `ResidueState`, because whether the
  // partly-written files are STILL THERE is the only part of this a person can
  // act on. The row used to show the teardown's error code instead — an
  // unbounded OS errno, so people read `EBUSY`.
  inboxRetainedResiduePresent: "Partly-written files are still on this PC.",
  inboxRetainedResidueNone: "Nothing was left on this PC, but the transfer was not closed cleanly.",
  inboxRetainedResidueUnknown: "Relayium could not check whether partly-written files were left on this PC.",

  inboxDeclined: "No folder was chosen, so nothing was turned on.",
  inboxEnabledNotice: "Receiving is on.",
  inboxDisabledNotice:
    "This PC is no longer set up to receive. Your messages and keys are untouched.",
  inboxRefused: "Not done — Relayium is closing.",
  inboxSuperseded: "That was replaced by a newer change, so nothing was altered.",
  inboxFailed: "That did not work. Relayium will try again on its own.",
  /**
   * Receiving is OFF on this device, so nothing will be tried again.
   *
   * The sentence above used to cover this, and its second half was the
   * problem: it promises an automatic retry, and with receiving off there is
   * nothing running to make one. A person told that waits for a delivery that
   * is never coming. macOS names the same case in `send.blockReceiveOff`.
   */
  inboxAcceptedNotEnabled:
    "Receiving is switched off on this PC, so nothing was collected. Turn it on above, then accept again.",



  // --- Device Inbox: policy, receipts, reveal -----------------------------
  inboxPolicyHeading: "When something is sent to this PC",
  inboxPolicyOff: "Don't send to this PC",
  inboxPolicyOffBody: "Your other devices will not offer to send here.",
  inboxPolicyAsk: "Ask me first",
  inboxPolicyAskBody: "Deliveries wait until you accept them. Nothing is saved without you.",
  inboxPolicyAuto: "Save automatically",
  // Said plainly, because it is the one choice that writes files unattended.
  inboxPolicyAutoBody:
    "Files from your own devices are saved to your folder as they arrive, without asking. You can change this at any time.",
  inboxPolicySetOff: "Your devices will no longer offer to send here.",
  inboxPolicySetAsk: "Deliveries will wait for you to accept them.",
  inboxPolicySetAuto: "Deliveries will be saved automatically.",
  inboxRevealFolder: "Open folder",
  inboxRevealFailed: "That folder could not be opened. It may have been moved or renamed.",

  inboxReceiptsHeading: "Received",
  inboxReceiptsEmpty: "Nothing has arrived yet.",
  inboxReceiptsUnavailable:
    "Your received deliveries could not be read just now. Nothing has been deleted — this is a problem reading the record.",
  // Counts, not names. The delivery record carries no file names by design.
  inboxReceiptFiles: "{published} of {total} file(s)",
  inboxReceiptMessage: "A message",
  inboxReceiptSaved: "Saved",
  inboxReceiptAckPending: "Saved, not yet confirmed",
  inboxReceiptPartial: "Partly saved",
  inboxReceiptWorking: "In progress",
  inboxReceiptFailed: "Did not finish",
  // Per row, and only when this delivery has no names of its own. The record
  // that carries them is written after the files are on disk, so a delivery can
  // be perfectly real and still have nothing to name — that is what this says,
  // rather than leaving a delivery looking as though it arrived empty.
  inboxReceiptUnnamed: "The file names for this delivery were not recorded. Open the folder to see what arrived.",
  inboxHistoryNamesUnavailable:
    "The file names could not be read just now. Nothing has been deleted — the deliveries below are still counted correctly, only their names are missing.",
  // "3 of 7" is the truth about a partial. Never the manifest presented whole.
  inboxHistoryPartial: "{saved} of {declared} saved",
  inboxHistoryMore: "and {count} more",
  inboxHistoryForget: "Remove from this list",
  inboxHistoryForgetHint: "Removes the record of what arrived. Your files are not touched.",

  // --- Device Inbox: send -------------------------------------------------
  inboxSendHeading: "Send to your devices",
  inboxSendBody:
    "Choose files, a folder or a message, then pick which of your devices to send to. Everything is encrypted on this PC and sealed to the device you chose, so the server never sees it.",
  inboxSendTargetsHeading: "Your devices",
  inboxSendNoTargets:
    "No other device on this account can receive right now. Turn Device Inbox on there and it will appear here.",
  inboxSendTargetsUnavailable:
    "Your devices could not be read just now. This is a problem reading the list, not a sign you have none.",
  inboxSendSignedOut: "Sign in to send to your devices.",
  inboxSendRefresh: "Refresh",
  inboxSendPickFiles: "Choose files",
  inboxSendPickFolder: "Choose folder",
  inboxSendPicked: "{count} file(s), {size}",
  inboxSendClear: "Clear",
  inboxSendModeFiles: "Files",
  inboxSendModeText: "Message",
  inboxSendMessagePlaceholder: "Type a message to send to your device",
  inboxSendStart: "Encrypt and send",
  inboxSendCancel: "Cancel",
  inboxSendSending: "Sending… {percent}%",
  inboxSendQueued: "Waiting",
  // Central's own refusals, each as the sentence it actually means.
  inboxSendTargetOff: "Receiving is off on that device",
  inboxSendTargetCannotReceive: "That device cannot receive deliveries",
  inboxSendTargetRevoked: "That device's inbox was withdrawn",
  inboxSendTargetNoKey: "That device has no usable key yet",
  inboxSendTargetNoText: "That device cannot receive messages",
  // --- What the OTHER device is doing with the delivery --------------------
  //
  // The server's ten task states, each as the sentence it actually means.
  //
  // These two used to be the whole vocabulary, chosen by `state === "acked" ||
  // state === "saved"` — where `acked` belongs to the RECEIVER's local journal
  // and can never appear here. So everything except `saved` said "waiting for
  // that device to collect it", including `expired`, `revoked` and
  // `failed_terminal`, which the server has recorded will never be collected.
  // Telling a sender their files are on their way when nothing was written is
  // the misleading state this vocabulary exists to end.
  //
  // macOS's sentences, reused rather than re-written: it has had all ten since
  // its send screen shipped, and two clients saying the same thing differently
  // about one delivery is two things to learn.
  inboxSendDelivered: "Saved on the other device.",
  inboxSendStateQueued: "Waiting for the other device.",
  inboxSendStateNotified: "The other device has been told about it.",
  inboxSendStateDownloading: "The other device is downloading it.",
  inboxSendStateVerifying: "The other device is checking it.",
  inboxSendStateAttention: "The other device needs attention before it can save this.",
  /** Not "waiting": nothing is coming, and nothing was saved. */
  inboxSendStateExpired: "This delivery expired before the other device took it. Nothing was saved.",
  inboxSendStateRevoked: "Receiving was revoked on the other device, so this wasn't delivered.",
  /** Distinct from terminal on purpose: one is over, the other is not. */
  inboxSendStateFailedRetryable: "The other device couldn't take it yet. It will try again.",
  inboxSendStateFailedTerminal: "The other device couldn't save this. Nothing was written there.",
  inboxSendCancelled: "Cancelled. Nothing was delivered.",
  // The distinction the whole outcome union exists for. Never softened.
  inboxSendUnknown: "Relayium could not confirm what happened",
  inboxSendUnknownBody:
    "The delivery may or may not have been created. Nothing has been discarded, so checking again is safe — it will settle the same delivery rather than sending a second one.",
  inboxSendCheckAgain: "Check again",
  inboxSendRefused: "That device did not take it",
  inboxSendOrphan:
    "Some encrypted data was left on the server and will be cleared automatically. There is nothing for you to do.",
  inboxSendRefusedUnavailable: "Not right now. Nothing was sent.",
  inboxSendRefusedCapacity: "Too many deliveries are already running. Wait for one to finish.",
  inboxSendRefusedNothing: "Choose something to send first.",
  inboxSendRefusedNoTarget: "Choose a device to send to first.",
  inboxSendRefusedManifest: "Those files cannot be sent together. Try choosing them again.",
  inboxSendRefusedGeneric: "That could not be started.",
  inboxSendRefusedUnresolvedFull:
    "Too many earlier deliveries are still unconfirmed. Check those first — Relayium will not start another until it can account for them, because forgetting one would lose the only way to find out what happened to it.",
  inboxSendUnresolvedHeading: "Deliveries Relayium could not confirm",
  inboxSendUnresolvedBody:
    "These may or may not have reached the device. Nothing has been discarded, so checking again is safe — it settles the same delivery rather than sending a second one. They stay here until they are settled.",
  inboxSendUnresolvedTo: "To {device}",

  // --- Send a link -------------------------------------------------------
  sendHeading: "Send a link",
  sendBody:
    "Choose files or a folder. They are encrypted on this PC before anything is uploaded, and the key travels in the link rather than to the server.",
  sendPickFiles: "Choose files",
  sendPickFolder: "Choose folder",
  sendPicked: "{count} file(s), {size}",
  sendNamesMore: "and {count} more",
  sendExpiryUnknown:
    "Your plan's limit on how long a link lasts could not be read just now, so this may be shortened when it is uploaded.",
  // The TRUE cap, from the plan — never the highest preset that happens to fit.
  // A three-day plan told "up to 1 day" understates what somebody pays for.
  sendExpiryCapped: "Your plan keeps a link for up to {duration}.",
  sendExpiryCapDays: "{count} day(s)",
  sendExpiryCapHours: "{count} hour(s)",
  sendExpiryCapMinutes: "{count} minute(s)",
  // The exact figure, when no larger unit divides the cap evenly.
  sendExpiryCapSeconds: "{count} second(s)",
  // The sub-day case, where the shortest offered choice is already longer than
  // the plan allows. Saying nothing here would promise longer than the truth.
  sendExpiryClamped:
    "This is longer than your plan keeps a link, so it will be shortened to {duration} when it is uploaded.",
  sendDropHint: "Or drop files and folders here",
  sendClear: "Clear",
  sendStart: "Encrypt and upload",
  sendCancel: "Cancel",
  sendUploading: "Uploading… {percent}%",
  sendBurn: "Delete after it is opened once",
  sendExpiry: "Link expires after",
  sendExpiryDays: "{days} day(s)",

  sendPublished: "Ready to share.",
  sendLinkLabel: "Link",
  sendCopy: "Copy link",
  sendCopied: "Copied",
  sendCopyFailed: "Could not copy",
  sendRecheckedPublished: "Confirmed — it is shared.",
  sendRecheckedUnknown: "Still could not be confirmed. Nothing was discarded.",
  // The distinction the whole outcome union exists for. Never softened.
  sendAmbiguous: "Relayium could not confirm what happened",
  sendAmbiguousBody:
    "The upload may or may not have completed. Nothing has been discarded and the key is still here, so you can check again.",
  sendCheckAgain: "Check again",
  sendFailed: "The upload did not finish",
  sendFailedBody: "Nothing was uploaded. You can try again.",
  sendCancelled: "Cancelled. Nothing was uploaded.",
  sendRefusedUnavailable:
    "Not right now. Relayium is either closing or could not confirm your account — nothing was uploaded.",
  sendRefusedCapacity: "Too many uploads are already running. Wait for one to finish.",
  sendRefusedSignedOut: "Sign in to send a link.",
  sendRefusedNothing: "Choose something to send first.",
  sendRefusedManifest: "Those files cannot be sent together. Try choosing them again.",
  sendRefusedGeneric: "That could not be started.",

  sendHistoryHeading: "Sent links",
  sendHistoryEmpty: "You have not sent anything yet.",
  sendHistoryUnavailable:
    "Your sent links could not be read just now. They have not been deleted — this is a problem reading them, not a missing history.",
  sendHistoryItem: "{count} file(s), {size}",
  sendHistoryPublished: "Shared",
  /**
   * The fourth state, which had no label and rendered as its own identifier.
   *
   * "Unfinished" rather than "Uploading": a row reaches the HISTORY list, and a
   * `pending` record there is one whose upload never settled — the bytes are
   * not necessarily still moving, and after a restart they certainly are not.
   */
  sendHistoryPending: "Unfinished",
  sendHistoryAmbiguous: "Unconfirmed",
  sendHistoryClosed: "Deleted",
  sendHistoryExpires: "Expires {when}",
  sendHistoryBurn: "Opens once",
  sendShowLink: "Show link",
  sendHideLink: "Hide link",
  sendDelete: "Delete",
  sendDeleted: "Deleted.",
  sendDeleteFailed: "It could not be deleted. Nothing was changed.",

  // --- Placeholders -------------------------------------------------------
  soonTitle: "Not in this build yet",
} as const;

export type MessageKey = keyof typeof en;

export const zh: Record<MessageKey, string> = {
  appName: "Relayium",

  navRealtime: "立即传输",
  navLan: "同一网络",
  navPair: "配对码",
  navStored: "发送链接",
  navInbox: "设备收件箱",
  navAccount: "账户",

  thisPc: "这台电脑",

  lanTitle: "同一网络",
  lanSubtitle: "发送给与这台电脑从同一地址访问互联网的另一台设备。全程端到端加密，无论走哪条路径 Relayium 都无法读取。",
  lanSafety:
    "通常这个地址就是你的 Wi-Fi。但在运营商网络、VPN 或共用网关下，它也可能包含不属于你的设备，所以发送前请确认对方是谁。",
  lanNamesDisclaimer:
    "名称由对方设备提供，不能作为身份证明。可在设置中打开“{setting}”，在发送任何内容之前先核对验证码。",
  lanOff: "接收已关闭",
  lanOffBody:
    "这台电脑尚未加入同一网络的房间，所以别的设备看不到它，它也看不到别的设备。打开接收后才能发现设备并发送。",
  lanStart: "开始接收",
  lanStop: "停止接收",
  lanJoining: "正在加入…",
  lanEmpty: "还没有其他设备",
  lanEmptyBody: "在同一网络的另一台设备上打开 Relayium，它就会出现在这里。",
  lanJoiningTitle: "正在加入网络…",
  lanJoiningBody: "正在这个网络中查找 Relayium。",
  lanReconnecting: "正在重新连接…",
  lanReconnectingBody: "连接已断开，正在重试。",
  lanOffline: "无法连接 Relayium",
  lanOfflineBody: "这台电脑无法加入同一网络的房间，因此看不到其他设备，也不会被看到。请检查网络连接。",
  lanRetry: "重试",
  lanConnect: "连接",
  lanUnsupported: "这台设备的版本较旧，无法连接。",
  lanDisconnect: "断开",

  pairTitle: "配对码",
  pairSubtitle: "用一串短码在不同网络之间传输。",
  pairCreate: "创建配对码",
  pairCreating: "正在创建…",
  pairYourCode: "你的配对码",
  pairEnterCode: "输入配对码",
  pairJoin: "加入",
  pairExpires: "{minutes} 分钟后失效",
  pairSignedOut: "创建配对码需要登录。加入别人的配对码不需要账户。",
  pairQuota: "本月的中继流量已用完。你仍然可以加入别人创建的配对码。",
  pairUnverified: "请先验证邮箱地址，然后才能创建配对码。",
  pairRateLimited: "尝试次数过多，请稍候再试。",
  pairUnavailable: "无法连接 Relayium，请检查网络后重试。",
  pairBadCode: "配对码是六位数字。",
  pairRefused: "该配对码无效或已失效。",
  pairUnreachable: "无法连接 Relayium，因此没能校验这串配对码。这是网络问题，不是配对码有误。",

  linkConnected: "已连接到 {peer}",
  linkRequesting: "正在请求连接 {peer}…",
  linkConnecting: "正在连接 {peer}…",
  linkInterrupted: "与 {peer} 的连接已中断",
  linkFailed: "无法连接到 {peer}",
  linkCancel: "取消",
  pairWaiting: "正在等待另一台设备加入…",
  pairDisconnected: "已断开",
  pairDisconnectedBody: "你已与该设备断开连接。对方仍在房间中，可以重新连接。",
  pairReconnect: "重新连接",
  pairRegenerate: "重新创建配对码",
  pairExpired: "配对码已失效",
  pairLeave: "离开",
  linkSendFiles: "发送文件",
  linkSendFolder: "发送文件夹",
  linkDropHint: "也可以把文件拖到这里",
  linkMessage: "消息",
  textIncoming: "{peer} 想开始一段对话",
  textAccept: "接受",
  textDecline: "拒绝",
  textWaiting: "正在等待对方接受…",
  textRefused: "对方拒绝了这段对话。",
  textPeerBusy: "对方正忙。",
  textUnsupported: "对方无法进行对话。",
  textTooLong: "这条消息太长，无法发送。",
  textFlooding: "对方发得太快，会话已关闭。",
  textFailed: "消息会话失败。",
  textDropped: "这条消息没有发送成功，内容仍保留在输入框里。",
  linkSend: "发送",
  linkVerifyTitle: "核对这串验证码",
  linkVerifyBody: "两台设备上显示的验证码应当一致。",
  linkVerifyConfirm: "一致",
  linkVerifyDecline: "不一致",
  linkVerifyDeclined: "你选择了「不一致」，连接已关闭。",
  linkVerifyPending: "正在等待验证码…",
  linkStatusIdle: "未连接",
  linkStatusRequesting: "正在请求连接",
  linkStatusConnecting: "正在连接",
  linkStatusOpen: "已连接",
  textSelfBusy: "这台电脑已经在另一条连接中。请先结束它，然后重试。",
  linkStatusInterrupted: "已中断",
  linkStatusFailed: "连接失败",

  linkEndedRelay: "这条连接已到中继时限。请重新开始以继续。",
  linkEndedSignaling: "与配对服务的连接已断开，这条链路无法恢复。请重新开始。",
  linkRelayExpiring: "这条中继连接快到时限了。把手上的传完，然后重新建立一条。",
  linkRecoveryUnavailable:
    "当前未连接配对服务，这条连接一旦断开就无法恢复。在那之前这里的一切照常可用，包括新发的文件和消息。",
  linkRestart: "重新开始",

  recvIncoming: "{peer} 想发送 {count} 个文件",
  recvAccept: "选择保存位置",
  recvDecline: "拒绝",
  recvSaving: "正在保存…",
  recvPartial: "已保存 {done} / {total}，其余未能写入。",
  recvCancelled: "已取消",
  recvUnsupported: "此版本可以接收文件，但还不能把它们写入最终文件名。没有保存任何文件。",
  recvFailedPrefix: "无法写入你选择的文件夹。",
  recvFailedPermission: "Relayium 没有写入该文件夹的权限。",
  recvFailedConflict: "该文件夹中已存在同名文件。",
  recvFailedNoSpace: "该文件夹所在磁盘空间不足。",
  recvFailedInUse: "其中有文件正被其他程序占用。请关闭该程序后重新接收。",
  recvFailedGone: "该文件夹已经不存在了。请另选一个文件夹后重新接收。",
  recvFailedNameTooLong: "该文件夹内的路径超出了 Windows 的长度限制。请选择更靠近磁盘根目录的文件夹。",
  recvFailedTimeout: "保存超时。",
  recvFailedInternal: "保存未能完成。",
  recvFailedCancelled: "保存已取消。",
  recvFailedUncertain: "保存没有正常结束，Relayium 无法确认哪些文件已写入。",
  recvResidue: "该文件夹中可能仍残留未完成的文件。",
  recvSavedCount: "已保存 {done} / {total}",
  recvReveal: "在文件资源管理器中显示",
  recvFilesTitle: "已接收的文件",
  gateSignedOutSendTitle: "发送链接需要账户",
  gateSignedOutSendBody: "链接托管在你的账户下，因此这一半需要登录。打开别人发来的链接则不需要。",
  gateSignIn: "登录",
  helpHeading: "帮助",
  helpStepsHeading: "工作方式",
  helpBoundaryHeading: "Relayium 能看到什么",
  helpWhereHeading: "东西最后在哪里",
  helpTroubleHeading: "如果不成功",
  helpShow: "查看这个界面怎么用、Relayium 能看到什么，以及不成功时该怎么办",
  helpHide: "收起详细说明",
  sendTooManyFiles: "该选择包含的文件超过 {max} 个。请减少文件数量，或先把文件夹压缩。",
  dropUnreadable: "拖入的内容里有一部分读不出来，所以什么都没有接收。请重试，或改用「选择文件」按钮。",
  inboxSendDropHint: "也可以把文件拖到这里",
  helpGuideLink: "在 relayium.com 上阅读指南",
  helpGuideLinkFailed: "无法打开浏览器。",
  helpLanPurpose: "在同一网络的两台设备之间传文件或发消息。不需要账户，服务器上也不会留下任何内容。",
  helpLanStep1: "在两台设备上打开 Relayium，并让它们保持在同一网络中。",
  helpLanStep2: "从列表中选择另一台设备，然后发送消息，或发送你已添加的文件。",
  helpLanStep3: "若已开启验证，请先确认两边屏幕显示相同的代码，再点击接受。",
  helpLanBoundary: "文件是端到端加密的：在离开这台电脑之前就已加密，只有对方设备能解开，Relayium 始终没有密钥。Relayium 的服务做的是把两台设备互相引荐。根据网络状况，连接可能在两台设备之间建立，也可能由 Relayium 的中继承载，这台电脑无法分辨是哪一种——而这对 Relayium 能读到什么毫无影响。",
  helpLanWhere: "收到的文件会保存到你在接受时选择的文件夹。对话只存在于这两台设备上，连接结束即丢弃，服务器上不留任何内容。",
  helpLanFailure: "另一台设备不在列表里。设备是按 Relayium 服务观察到的网络路径分组的，因此访客网络、VPN，或者会隔离客户端的路由器，都可能把同一条网线上的两台设备分到不同的组。",
  helpLanRecovery: "确认两台设备都在接收，关闭 VPN，并加入同一个网络。若仍然互相看不到，改用“跨网络”界面的配对码——那条路不需要共享网络。",
  helpPairPurpose: "通过转达一个六位代码联系任何地方的设备。两台设备不必处于同一网络。",
  helpPairStep1: "创建配对码，然后把代码、旁边的链接或二维码转达给对方。",
  helpPairStep2: "对方在 Relayium 中输入该代码、打开链接，或扫描二维码。",
  helpPairStep3: "确认两边屏幕显示相同的代码，然后在这一条连接上收发消息和文件。",
  helpPairBoundary: "文件在离开这台电脑之前就已加密，Relayium 始终没有密钥。创建代码需要账户，因为连接可能需要中继，而这些流量计入创建代码的一方。输入别人创建的代码则完全不需要账户。",
  helpPairWhere: "收到的文件会保存到你在接受时选择的文件夹。消息只留在这两台设备上，连接结束即丢弃。通过这种方式发送的内容不会存储在 Relayium 的服务器上。",
  helpPairFailure: "配对码只有几分钟有效期。之后对方会看到代码无效或已过期——代码输错时看到的也是同一句。",
  helpPairRecovery: "创建一个新的代码并转达新的那个。你已添加的内容仍在，不需要重新选择。",
  helpStoredPurpose: "把加密后的文件上传一次，拿到一个在这台电脑休眠或关闭时仍然有效的链接；也可以打开别人发给你的链接，那不需要账户。",
  helpStoredStep1: "选择文件或文件夹，决定链接的有效时长，然后发送。",
  helpStoredStep2: "Relayium 会在上传任何内容之前，先在这台电脑上完成加密。",
  helpStoredStep3: "分享链接。打开它所需的密钥就在链接里，永远不会到达 Relayium。",
  helpStoredBoundary: "文件在上传之前就已在这台电脑上加密。密钥位于链接 # 之后的部分，浏览器永远不会把它发给服务器，因此 Relayium 存着的是它读不了的东西。拿到完整链接的人就能打开文件，所以请把链接本身当作文件来对待。",
  helpStoredWhere: "加密后的文件会留在 Relayium 的服务器上，直到链接过期，或你在下方的历史记录中删除它们。在那里删除会立刻使链接失效。从别人链接打开的文件，会保存到你选择的文件夹。",
  helpStoredFailure: "被缩短、被聊天应用包装，或复制时丢掉了 # 之后部分的链接无法打开。缺的是密钥，不是文件。",
  helpStoredRecovery: "从下方的历史记录重新复制链接，并发到一个不会改动它的地方。如果已经过期，请重新发送文件。",
  helpInboxPurpose: "给这台电脑一个属于它自己的地址，让你其他已登录的设备可以直接把文件送到这里。",
  helpInboxStep1: "在这台电脑和你要发送的设备上登录同一个账户。",
  helpInboxStep2: "在这台电脑上选择一个文件夹，然后决定投递是自动保存，还是等待你回应。",
  helpInboxStep3: "从 relayium.com 或另一台已登录的设备发送到这台电脑，文件就会落在那个文件夹里。",
  helpInboxBoundary: "投递是用这台电脑自己的密钥加密的，而该密钥从不离开本机。Relayium 会保存加密后的投递直到这台电脑取走，既读不了里面的内容，也无法告诉你文件叫什么。",
  helpInboxWhere: "已接受的投递会落在上面选定的文件夹里。仍在等待的内容会留在服务器上，直到这台电脑取走或它过期。",
  helpInboxFailure: "当这台电脑处于休眠、已登出，或 Relayium 未运行时，不会收到任何内容。它只能在运行时接收，并且也可以从托盘暂停接收。",
  helpInboxRecovery: "打开 Relayium 并登录同一个账户，等待中的内容就会到达。在账户界面打开“登录时启动”，它就会一直运行，不必你记着。",
  helpAccountPurpose: "你的方案、本周期的用量，以及登录到你账户的设备。",
  helpAccountStep1: "创建账户或登录——发送链接和设备收件箱都需要账户。",
  helpAccountStep2: "查看你当前的方案，以及本周期已使用多少。",
  helpAccountStep3: "检查登录到你账户的设备，移除不再使用的。已存储的文件在“存储链接”界面。",
  helpAccountBoundary: "Relayium 保存你的邮箱地址、你所用的方案，以及你传输了多少字节。它从不保存你文件的密钥，因此这个界面上的任何内容——以及 Relayium 数据库中的任何内容——都无法打开它们。",
  helpAccountWhere: "将设备登出只会结束该设备的会话，不影响其他；它已经收到的文件仍留在它上面。已存储的文件在“存储链接”界面移除，移除会立刻使其链接失效。",
  helpAccountFailure: "一旦本周期的额度用尽，创建配对码和发送链接将停止工作。同一网络的传输，以及使用别人创建的代码连接，都不受影响——两者都不计入你的账单。",
  helpAccountRecovery: "等待周期滚动，或更换方案。无论哪种方式，同一网络的传输都会继续工作，因为它不经过 Relayium 传输任何字节。",
  recvShowFile: "显示",
  recvDragHint: "将文件拖出即可复制到其他位置。",
  recvActionMissing: "该文件已不存在，可能在接收后被移动、重命名或删除。",
  recvActionExpired: "已无法从这里访问该文件。请重新接收以获取新的副本。",
  recvActionClosing: "Relayium 正在关闭，未打开任何内容。",
  recvActionFailed: "操作未能完成，未打开任何内容。",
  recvRevealBusy: "正在打开\u2026",
  recvRevealMissing: "该文件夹已不存在，可能已被移动、重命名，或所在的驱动器已断开。",
  recvRevealExpired: "该记录不属于当前登录的账户。",
  recvRevealClosing: "Relayium 正在关闭。",
  recvRevealFailed: "Windows 无法打开该文件夹。",

  accountTitle: "账户",
  accountSignedInAs: "已登录：{email}",
  accountSignedOut: "未登录",
  accountWhy: "创建配对码需要账户。同一网络的传输不需要账户。",
  accountSignIn: "登录",
  accountSignOut: "退出登录",
  accountCancel: "取消",
  accountRetry: "重试",
  accountOpening: "正在打开浏览器…",
  accountEnterCode: "在浏览器中输入这串代码",
  accountExpiresIn: "此代码将在 {minutes} 分钟后失效。",
  accountStoreUnreadable:
    "Relayium 无法在这台电脑上打开它的私有存储，因此暂时无法登录。同一网络的传输仍然可用。",

  accountFailedUnreachable: "此操作暂时无法完成。请检查网络连接后重试。",
  accountFailedDeclined: "这次登录被拒绝了。",
  accountFailedExpired: "这串代码已失效。请重新登录。",
  accountFailedCredentialRemains:
    "取消登录时，已保存在这台电脑上的登录凭据没能被清除。请登录后再退出登录，以清除它。",
  accountFailedCredentialUncertain:
    "取消登录时，无法确认这台电脑上是否残留了登录凭据。请登录后再退出登录，以确保它已被清除。",

  startingTitle: "正在启动 Relayium…",
  startingBody: "正在准备加密传输。",
  startFailedTitle: "Relayium 无法启动",
  startFailedBody: "加密库未能加载，因此无法进行传输。没有发送或接收任何内容。",
  startRetry: "重试",

  unsupportedTitle: "此版本的 Relayium 已无法运行",
  updateRecommendedTitle: "有新版 Relayium 可用",
  updateRecommendedBody: "这台电脑运行的是 {current}，当前发布版本是 {latest}。",
  updateRecommendedDismiss: "以后再说",
  unsupportedBody:
    "Relayium {current} 低于最低支持版本 {minimum}。请更新到 {latest} 后继续使用。没有任何内容被删除，你的文件和密钥不受影响。",

  settingsTitle: "设置",
  settingsVerify: "每次连接都让我核对验证码",
  settingsVerifyHelp:
    "无论是否开启，每条连接都是加密并经过认证的。开启后，在发送任何内容之前还会让你和对方核对一串短码。",

  settingsUnreadable:
    "Relayium 无法在这台电脑上读取已保存的设置，因此不知道你是否要求核对验证码。在你下面重新选择之前，每次连接都会询问。磁盘上的设置未被改动。",
  settingsSaveFailed: "该设置未能保存。",

  settingsStartup: "登录时启动 Relayium",
  settingsStartupHelp: "Relayium 会在通知区域继续运行，无需先打开就能接收。",
  settingsStartupOn: "登录时会启动 Relayium。",
  settingsStartupOff: "登录时不会启动 Relayium。",
  settingsStartupDisabled:
    "Relayium 已在启动项中，但已被禁用，因此不会启动。可在任务管理器的「启动应用」中重新启用。",
  settingsStartupOther: "此电脑上有其他设置会在登录时启动 Relayium。",
  settingsStartupUnreadable: "无法向 Windows 查询是否登录时启动，因此状态未知，而不是「关闭」。",
  settingsStartupWriteFailed: "该设置在这台电脑上未能更改。",
  settingsStartupConsentFailed: "Relayium 没能向你弹出确认，因此没有做任何更改。请再试一次。",

  storedTitle: "发送链接",
  storedSubtitle: "接收别人以链接发给你的文件，或者自己发送一个。",
  storedReceiveHeading: "从链接接收",
  storedReceiveBody: "粘贴收到的链接。在你选择文件夹之前，不会下载任何内容。",
  storedLinkLabel: "粘贴链接",
  storedReceiveAction: "打开链接",
  storedCancel: "取消",
  storedRetry: "重试",
  storedFromDeepLink: "已打开一个链接。确认后选择保存位置。",
  storedProgress: "正在保存…… {percent}%",
  storedSaved: "已保存 {count} 个文件。",
  storedPartial: "已保存 {count} / {total}，其余未能保存。",
  storedDeclined: "未下载任何内容。",
  storedCancelled: "已取消，未保存任何内容。",
  storedResidue: "该文件夹中可能仍有写了一半的文件。",
  storedUnconfirmed: "结果无法确认。请先检查你选择的文件夹，再决定是否重试。",
  storedFailedLinkInvalid: "这不是 Relayium 链接。",
  storedFailedNotFound: "该链接已过期，或已被使用过一次。",
  storedFailedForbidden: "此账户无法打开该链接。",
  storedFailedIntegrity:
    "文件与链接不匹配。没有保存任何内容，重试也无济于事——请让发送方重新发一个链接。",
  storedFailedNetwork: "无法连接 Relayium，请检查网络。",
  storedFailedRuntime: "此版本无法加载打开链接所需的组件。",
  storedFailedGeneric: "无法打开该链接。",
  storedAtCapacity: "请先完成或取消一个传输，再开始新的。",
  storedTooLong: "该链接超过了 Relayium 链接的长度。",
  storedUnavailable: "Relayium 正在退出。",
  storedRetained: "有 {count} 个文件夹未能清理。",
  storedRetainedRetry: "再次尝试清理",
  storedRetainedClean: "已清理。",
  storedRetainedStuck: "仍未能清理。",
  storedRetainedUnavailable: "未尝试：Relayium 正在关闭。该文件夹仍在跟踪中。",


  inboxTitle: "设备收件箱",
  inboxSubtitle: "接收来自你自己设备的文件和消息，即使此窗口已关闭。",

  inboxOffTitle: "接收已关闭",
  inboxOffBody:
    "打开后，你的其他 Relayium 设备就可以向这台电脑发送文件和消息。你来选择接收文件夹，保存任何内容前都会先征得你的同意。",
  inboxTurnOn: "打开接收",
  inboxTurnOff: "停止在这台电脑上使用收件箱",
  inboxOnTitle: "接收已打开",
  inboxBackgroundNote: "即使此窗口已关闭，或你正在其他页面，也会继续接收。",
  inboxCanReceive: "这台电脑可以接收文件和消息。",
  inboxCanReceiveFiles: "这台电脑可以接收文件。",
  inboxCanReceiveText: "这台电脑可以接收消息。",

  inboxNeedsAccountTitle: "登录后才能使用设备收件箱",
  inboxNeedsAccountBody: "设备收件箱只在你自己的设备之间投递，因此需要它们共用的账号。",
  inboxAccountUnreadableTitle: "无法读取这台电脑的加密存储",
  inboxAccountUnreadableBody:
    "Relayium 无法打开保存本设备密钥的加密存储。在此之前无法继续接收，你的消息不会被删除。",

  inboxFolderMissingTitle: "接收文件夹不存在",
  inboxFolderMissingBody:
    "接收仍处于打开状态，但找不到你选择的文件夹——它可能已被移动、重命名，或所在的磁盘已断开。重新选择即可继续。",
  inboxChooseFolder: "选择文件夹",
  inboxChangeFolder: "更换文件夹",
  inboxFolderChosen: "文件会保存到你选择的文件夹。",

  inboxStartingBody: "正在将这台电脑注册到你的账号。",
  inboxIdleBody: "当前没有待处理的内容。",
  inboxReceivingTitle: "正在接收…",
  inboxReceivingBody: "正在保存一次投递。",
  inboxBlockedTitle: "有内容需要你决定",
  inboxBlockedDirectory: "接收文件夹不可用，投递已停止。请重新连接磁盘，或另选一个文件夹。",
  inboxBlockedDownload: "有一项投递未能下载，稍后会重试。",
  inboxBlockedVerify: "投递内容与发送方的描述不符，因此未保存任何文件。请让对方重新发送。",
  inboxBlockedDeclined: "你拒绝了这次投递，未保存任何文件。",
  inboxBlockedUnsupported: "该投递使用了此版本不支持的内容。更新 Relayium 或可解决。",
  inboxBlockedInternal: "投递因这台电脑无法判定的原因而停止，未保存任何文件。",
  inboxBlockedKey: "这台电脑的接收密钥不可用，因此无法解密任何内容。请重新登录后重试。",
  inboxBlockedEnrolment: "Relayium 无法将这台电脑设置为接收设备。更新到最新版本或可解决。",
  inboxOfflineTitle: "无法连接 Relayium",
  inboxOfflineBody: "将在 {seconds} 秒后重试。",
  inboxRetryNow: "立即重试",
  inboxUnavailableTitle: "此版本尚未包含",
  inboxUnavailableBody: "此版本还不能接收投递，因此没有可开启的开关。",
  inboxWithdrawalPending:
    "Relayium 未能告知服务器这台电脑已停止接收。它会继续尝试；在此之前，你的其他设备可能仍会显示可以发送到这里。",

  inboxPendingHeading: "等待你处理",
  inboxPendingEmpty: "没有等待处理的内容。",
  inboxPendingItem: "来自你的某台设备，{bytes}",
  inboxAccept: "接受",
  inboxReject: "拒绝",
  inboxAcceptedSaved: "已保存。",
  inboxAcceptedSavedMessage: "消息已保存。",
  inboxAcceptedPartial: "部分保存：{total} 个文件中已保存 {saved} 个。",
  inboxAcceptedQueued: "已接受，稍后开始接收。",
  inboxAcceptedBlocked: "这次投递需要你的决定，尚未接收。",
  inboxAcceptedSettled: "该投递已不在等待中。",
  inboxAcceptedBusy: "正在接收另一次投递，请稍后再试。",
  inboxAcceptedRefused: "未接受：Relayium 正在关闭。",
  inboxAckPending: "已保存。服务器尚未确认。",

  inboxMessagesHeading: "消息",
  inboxMessagesEmpty: "还没有消息。",
  inboxMessageItem: "来自你的某台设备",
  inboxOpen: "打开",
  inboxClose: "关闭",
  inboxCopy: "复制",
  inboxCopied: "已复制",
  inboxCopyFailed: "无法复制",
  inboxCopyFailedBody: "此刻无法读取该消息。请选中上面的文本自行复制。",
  inboxDelete: "删除",
  inboxMessageKept: "消息会保留在这台电脑上，直到你删除它们。关闭接收不会删除消息。",

  inboxDeviceHeading: "本设备",
  inboxDeviceUnnamed: "尚未命名",
  inboxRenameLabel: "设备名称",
  inboxRename: "重命名",
  inboxRenamed: "已重命名。",

  inboxRetainedHeading: "未能清理",
  inboxRetainedBody:
    "一次投递被中断，Relayium 无法确认已写入的部分文件是否已被清除。你可以让它再试一次。",
  inboxRetainedRetry: "重试清理",
  inboxRetainedResiduePresent: "这台电脑上仍留有已写入的部分文件。",
  inboxRetainedResidueNone: "这台电脑上没有残留文件，但这次传输没有正常结束。",
  inboxRetainedResidueUnknown: "Relayium 无法确认这台电脑上是否残留了已写入的部分文件。",

  inboxDeclined: "未选择文件夹，因此没有打开任何功能。",
  inboxEnabledNotice: "接收已打开。",
  inboxDisabledNotice: "这台电脑已不再设置为接收。你的消息和密钥不受影响。",
  inboxRefused: "未执行：Relayium 正在关闭。",
  inboxSuperseded: "该操作已被更新的更改取代，因此未做任何改动。",
  inboxFailed: "操作未成功。Relayium 会自行重试。",
  inboxAcceptedNotEnabled: "这台电脑的接收已关闭，因此没有收取任何内容。请先在上方打开，然后重新接受。",



  inboxPolicyHeading: "当有内容发送到这台电脑时",
  inboxPolicyOff: "不要发送到这台电脑",
  inboxPolicyOffBody: "你的其他设备不会再提供发送到这里的选项。",
  inboxPolicyAsk: "先询问我",
  inboxPolicyAskBody: "投递会一直等待，直到你接受。没有你的同意不会保存任何内容。",
  inboxPolicyAuto: "自动保存",
  inboxPolicyAutoBody:
    "来自你自己设备的文件会在到达时直接保存到你的文件夹，不再询问。你可以随时更改。",
  inboxPolicySetOff: "你的设备将不再提供发送到这里的选项。",
  inboxPolicySetAsk: "投递会等待你接受。",
  inboxPolicySetAuto: "投递会自动保存。",
  inboxRevealFolder: "打开文件夹",
  inboxRevealFailed: "无法打开该文件夹。它可能已被移动或重命名。",

  inboxReceiptsHeading: "已接收",
  inboxReceiptsEmpty: "还没有收到任何内容。",
  inboxReceiptsUnavailable:
    "此刻无法读取你收到的投递记录。没有删除任何内容——这是读取记录的问题。",
  inboxReceiptFiles: "{total} 个文件中已保存 {published} 个",
  inboxReceiptMessage: "一条消息",
  inboxReceiptSaved: "已保存",
  inboxReceiptAckPending: "已保存，尚未确认",
  inboxReceiptPartial: "部分保存",
  inboxReceiptWorking: "进行中",
  inboxReceiptFailed: "未完成",
  inboxReceiptUnnamed: "这次投递的文件名没有记录下来。打开文件夹即可查看收到的内容。",
  inboxHistoryNamesUnavailable:
    "暂时读不到文件名。没有任何内容被删除——下面的投递数量仍然是准确的，只是缺少名称。",
  inboxHistoryPartial: "已保存 {saved}／共 {declared}",
  inboxHistoryMore: "还有 {count} 项",
  inboxHistoryForget: "从列表中移除",
  inboxHistoryForgetHint: "只移除“收到了什么”的记录，不会动你的文件。",

  // --- 设备收件箱：发送 ---------------------------------------------------
  inboxSendHeading: "发送到你的设备",
  inboxSendBody:
    "选择文件、文件夹或一段文字，再选择要发送到哪台设备。内容会先在这台电脑上加密，并只对你选中的设备封装，服务器无法看到。",
  inboxSendTargetsHeading: "你的设备",
  inboxSendNoTargets: "这个账号下暂时没有其他设备可以接收。在那台设备上打开设备收件箱后就会出现在这里。",
  inboxSendTargetsUnavailable: "暂时读不到你的设备列表。这是读取列表出了问题，并不表示你没有其他设备。",
  inboxSendSignedOut: "登录后即可发送到你的设备。",
  inboxSendRefresh: "刷新",
  inboxSendPickFiles: "选择文件",
  inboxSendPickFolder: "选择文件夹",
  inboxSendPicked: "{count} 个文件，{size}",
  inboxSendClear: "清除",
  inboxSendModeFiles: "文件",
  inboxSendModeText: "文字",
  inboxSendMessagePlaceholder: "输入要发送到设备的文字",
  inboxSendStart: "加密并发送",
  inboxSendCancel: "取消",
  inboxSendSending: "发送中… {percent}%",
  inboxSendQueued: "等待中",
  inboxSendTargetOff: "该设备已关闭接收",
  inboxSendTargetCannotReceive: "该设备无法接收投递",
  inboxSendTargetRevoked: "该设备的收件箱已被撤销",
  inboxSendTargetNoKey: "该设备还没有可用的密钥",
  inboxSendTargetNoText: "该设备无法接收文字",
  inboxSendDelivered: "已保存到对方设备。",
  inboxSendStateQueued: "正在等待对方设备。",
  inboxSendStateNotified: "已通知对方设备。",
  inboxSendStateDownloading: "对方设备正在下载。",
  inboxSendStateVerifying: "对方设备正在校验。",
  inboxSendStateAttention: "对方设备需要先处理一些问题才能保存。",
  inboxSendStateExpired: "这次投递在对方设备取走之前就已过期。没有保存任何内容。",
  inboxSendStateRevoked: "对方设备上的接收权限已被吊销，因此没有投递。",
  inboxSendStateFailedRetryable: "对方设备暂时无法取走。稍后会自动重试。",
  inboxSendStateFailedTerminal: "对方设备无法保存这次投递。那台设备上没有写入任何内容。",
  inboxSendCancelled: "已取消，未发送任何内容。",
  inboxSendUnknown: "Relayium 无法确认这次发送的结果",
  inboxSendUnknownBody:
    "这次投递可能已经创建，也可能没有。相关数据都已保留，因此再检查一次是安全的——它会确认同一次投递，而不会重复发送。",
  inboxSendCheckAgain: "再检查一次",
  inboxSendRefused: "该设备没有接收",
  inboxSendOrphan: "服务器上残留了一些加密数据，会被自动清理，你不需要做任何事。",
  inboxSendRefusedUnavailable: "暂时无法发送，未发送任何内容。",
  inboxSendRefusedCapacity: "同时进行的发送太多了，请等待其中一个完成。",
  inboxSendRefusedNothing: "请先选择要发送的内容。",
  inboxSendRefusedNoTarget: "请先选择要发送到哪台设备。",
  inboxSendRefusedManifest: "这些文件无法一起发送，请重新选择。",
  inboxSendRefusedGeneric: "无法开始发送。",
  inboxSendRefusedUnresolvedFull:
    "还有太多之前的发送没有确认结果。请先检查它们——在能够确认之前，Relayium 不会再开始新的发送，因为丢掉其中一条就等于失去了查明它结果的唯一途径。",
  inboxSendUnresolvedHeading: "无法确认结果的发送",
  inboxSendUnresolvedBody:
    "这些内容可能已经送达，也可能没有。相关数据都已保留，因此再检查一次是安全的——它会确认同一次投递，而不会重复发送。在确认之前，它们会一直留在这里。",
  inboxSendUnresolvedTo: "发送到 {device}",

  sendHeading: "发送链接",
  sendBody:
    "选择文件或文件夹。上传前会先在这台电脑上加密，密钥只存在于链接中，不会发送到服务器。",
  sendPickFiles: "选择文件",
  sendPickFolder: "选择文件夹",
  sendPicked: "{count} 个文件，{size}",
  sendNamesMore: "还有 {count} 项",
  sendExpiryUnknown: "暂时读不到你的套餐对链接有效期的限制，因此上传时可能会被缩短。",
  sendExpiryCapped: "你的套餐最多保留链接 {duration}。",
  sendExpiryCapDays: "{count} 天",
  sendExpiryCapHours: "{count} 小时",
  sendExpiryCapMinutes: "{count} 分钟",
  sendExpiryCapSeconds: "{count} 秒",
  sendExpiryClamped: "这比你的套餐保留链接的时间更长，上传时会被缩短为 {duration}。",
  sendDropHint: "也可以把文件或文件夹拖到这里",
  sendClear: "清除",
  sendStart: "加密并上传",
  sendCancel: "取消",
  sendUploading: "正在上传… {percent}%",
  sendBurn: "被打开一次后即删除",
  sendExpiry: "链接有效期",
  sendExpiryDays: "{days} 天",

  sendPublished: "可以分享了。",
  sendLinkLabel: "链接",
  sendCopy: "复制链接",
  sendCopied: "已复制",
  sendCopyFailed: "无法复制",
  sendRecheckedPublished: "已确认：已分享。",
  sendRecheckedUnknown: "仍无法确认。没有丢弃任何内容。",
  sendAmbiguous: "Relayium 无法确认结果",
  sendAmbiguousBody:
    "本次上传可能已完成，也可能没有。没有丢弃任何内容，密钥仍在，你可以再检查一次。",
  sendCheckAgain: "再检查一次",
  sendFailed: "上传未完成",
  sendFailedBody: "没有上传任何内容。你可以重试。",
  sendCancelled: "已取消，没有上传任何内容。",
  sendRefusedUnavailable:
    "暂时无法进行。Relayium 正在关闭，或者无法确认你的账号——没有上传任何内容。",
  sendRefusedCapacity: "同时进行的上传过多。请等待其中一个完成。",
  sendRefusedSignedOut: "登录后才能发送链接。",
  sendRefusedNothing: "请先选择要发送的内容。",
  sendRefusedManifest: "这些文件无法一起发送。请重新选择。",
  sendRefusedGeneric: "无法开始。",

  sendHistoryHeading: "已发送的链接",
  sendHistoryEmpty: "你还没有发送过任何内容。",
  sendHistoryUnavailable:
    "此刻无法读取你发送过的链接。它们并未被删除——这是读取问题，不是历史为空。",
  sendHistoryItem: "{count} 个文件，{size}",
  sendHistoryPublished: "已分享",
  sendHistoryPending: "未完成",
  sendHistoryAmbiguous: "未确认",
  sendHistoryClosed: "已删除",
  sendHistoryExpires: "{when} 过期",
  sendHistoryBurn: "只能打开一次",
  sendShowLink: "显示链接",
  sendHideLink: "隐藏链接",
  sendDelete: "删除",
  sendDeleted: "已删除。",
  sendDeleteFailed: "删除失败，没有做任何更改。",

  soonTitle: "此版本尚未包含",
};

export const CATALOGUES = { en, zh } as const;
export type Lang = keyof typeof CATALOGUES;
