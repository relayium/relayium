import Foundation

/// Every localizable string the native clients render, named once.
///
/// This enum is the CANON. `LocalizationIntegrityTests` walks `allCases` against
/// all nine catalogs and fails on a key that any catalog is missing, and walks
/// each catalog's own keys back against this enum and fails on one that nothing
/// references. So a string cannot be added to a `.strings` file and forgotten in
/// code, or added in code and forgotten in eight languages.
///
/// It also removes the class of bug that a bare string key invites: a typo in
/// `"account.filesHedaing"` compiles, ships, and renders the typo.
public enum L10nKey: String, CaseIterable, Sendable {

    // MARK: - Shared controls

    case commonCancel = "common.cancel"
    case commonClear = "common.clear"
    case commonCopy = "common.copy"
    case commonCopied = "common.copied"
    case commonDone = "common.done"
    case commonJoin = "common.join"
    case commonSend = "common.send"
    case commonAccept = "common.accept"
    case commonReject = "common.reject"
    case commonRevoke = "common.revoke"
    case commonDelete = "common.delete"
    case commonDismiss = "common.dismiss"
    case commonRefresh = "common.refresh"
    case commonSignOut = "common.signOut"
    case commonTryAgain = "common.tryAgain"
    case commonStarting = "common.starting"
    case commonCode = "common.code"
    case commonChooseFilesOrFolders = "common.chooseFilesOrFolders"
    case commonEndSession = "common.endSession"
    /// The system share sheet. iOS reveals nothing and drags nothing out; this
    /// is how a finished transfer reaches the rest of the device.
    case commonShare = "common.share"
    /// %@ — a formatted date/time. Technical only in the sense that it is data:
    /// it is rendered through `L10n.date`, so it is already in this language.
    case commonExpires = "common.expires"

    // MARK: - Presentation formats
    //
    // In the catalog so a language can reorder them. Arabic puts the percent
    // sign on the other side, and French wants a space before it.

    /// %@ — an already-formatted number.
    case formatPercent = "format.percent"
    /// %1$@ number, %2$@ unit symbol (B/KB/MB/…, never translated).
    case formatBytes = "format.bytes"
    /// %1$@ and %2$@ joined by the middot the whole product uses for details.
    case formatDetailPair = "format.detailPair"
    /// %1$@ the step's number, %2$@ the step. In the catalog so the numeral,
    /// its separator and their order are the language's business — `"\(n). "`
    /// is English punctuation, and one of the nine reads right to left.
    case formatHelpStep = "format.helpStep"

    // MARK: - App lifecycle, menus

    case appCheckForUpdates = "app.checkForUpdates"

    // MARK: - Settings (macOS ⌘,)
    //
    // The login-item rows are FIVE states rather than a switch and a message,
    // because "registered but held for approval" is neither on nor an error —
    // and because `notFound` is two different situations with opposite remedies.
    // A bundle in Applications that the system holds no record for can ask to be
    // registered; a translocated one, or one on a disk image, cannot, and
    // telling its owner to move it to Applications when it is already there was
    // the dead end this set of keys now avoids.

    case settingsGeneral = "settings.general"
    case settingsUpdates = "settings.updates"
    case settingsOpenAtLogin = "settings.openAtLogin"
    case settingsOpenAtLoginBody = "settings.openAtLoginBody"
    case settingsLoginNeedsApproval = "settings.loginNeedsApproval"
    /// The bundle is somewhere macOS will not manage. Renamed from
    /// `settings.loginUnavailable`, which named a state ("unavailable") rather
    /// than the situation, and so was rendered for the case it does not describe.
    case settingsLoginUnmanagedLocation = "settings.loginUnmanagedLocation"
    /// The system reports no record for a bundle that IS in an Applications
    /// folder — an ordinary situation with a working remedy, not a failure.
    case settingsLoginUnconfirmed = "settings.loginUnconfirmed"
    /// The non-interactive state line that replaces the switch in the two states
    /// that have no working switch. Never a greyed `Toggle`.
    case settingsLoginNotRegistered = "settings.loginNotRegistered"
    case settingsLoginTryRegistration = "settings.loginTryRegistration"
    /// The third outcome of an explicit registration: the call succeeded and the
    /// system still reports nothing. Neither a success nor a failure, so it
    /// borrows neither sentence — and it says outright that nothing was removed.
    case settingsLoginStillUnconfirmed = "settings.loginStillUnconfirmed"
    case settingsLoginRefused = "settings.loginRefused"
    case settingsOpenLoginItems = "settings.openLoginItems"
    case settingsAutomaticUpdates = "settings.automaticUpdates"
    case settingsAutomaticUpdatesBody = "settings.automaticUpdatesBody"
    /// %@ — a date and time already formatted in the user's own locale.
    case settingsLastChecked = "settings.lastChecked"
    case settingsNeverChecked = "settings.neverChecked"
    case settingsCheckNow = "settings.checkNow"

    /// The Share extension is registered by installing the app but is OFF until
    /// the user enables it — macOS ships every third-party sharing extension
    /// disabled. Without saying so, the feature is invisible and looks broken.
    case settingsShareExtension = "settings.shareExtension"
    case settingsShareExtensionBody = "settings.shareExtensionBody"
    case settingsOpenExtensionSettings = "settings.openExtensionSettings"
    /// %1$@ marketing version, %2$@ build number. Both are digits, never
    /// translated; the key exists so a language can order the two around them.
    case settingsVersion = "settings.version"

    case quitTitle = "quit.title"
    case quitBody = "quit.body"
    case quitLocalTextTitle = "quit.localTextTitle"
    case quitLocalTextBody = "quit.localTextBody"
    case quitTransferAndLocalTextBody = "quit.transferAndLocalTextBody"
    case quitNow = "quit.now"
    case quitStay = "quit.stay"

    // MARK: - Menu bar

    /// %1$@ plan name, %2$@ traffic used.
    case menubarPlanUsage = "menubar.planUsage"
    case menubarLoadingAccount = "menubar.loadingAccount"
    case menubarSigningIn = "menubar.signingIn"
    case menubarSignedInUnreachable = "menubar.signedInUnreachable"
    /// %@ — the account's email address, never translated.
    case menubarEmailUnverified = "menubar.emailUnverified"
    case menubarPendingDeletion = "menubar.pendingDeletion"
    case menubarNotSignedIn = "menubar.notSignedIn"
    case menubarResumeNearby = "menubar.resumeNearby"
    case menubarPauseNearby = "menubar.pauseNearby"
    case menubarOpenToSeeTransfer = "menubar.openToSeeTransfer"
    case menubarOpen = "menubar.open"
    /// %1$@ and %2$@ are the literal diagnostic tokens `ok` / `FAILED`.
    case menubarCoreStatus = "menubar.coreStatus"
    case menubarQuit = "menubar.quit"

    // MARK: - Background receive status

    case nearbyStatusOff = "nearby.status.off"
    case nearbyStatusPaused = "nearby.status.paused"
    case nearbyStatusJoining = "nearby.status.joining"
    case nearbyStatusReady = "nearby.status.ready"
    case nearbyStatusReconnecting = "nearby.status.reconnecting"
    case nearbyStatusReceivingFiles = "nearby.status.receivingFiles"
    case nearbyStatusMessageSession = "nearby.status.messageSession"

    // MARK: - Account states
    //
    // Shared: the macOS Account destination and the iOS Account tab both render
    // these. The two keys that used to head this group — `content.haveLink` and
    // `content.nearbyOrCode` — were the old macOS root's two choices, and left
    // with the root picker they labelled.

    case contentAccountLoadFailed = "content.accountLoadFailed"
    case contentCheckEmailTitle = "content.checkEmailTitle"
    /// %@ — the account's email address.
    ///
    /// Says *come back here* rather than "open relayium.com": the link in the
    /// email is the only web step in the flow, and the app is where the session
    /// is created afterwards.
    case contentCheckEmailBody = "content.checkEmailBody"
    /// The action on the check-email screen. It replaces `content.openRelayium`,
    /// which sent the user to a website to compensate for the app having no way
    /// to ask for another email — which it now has.
    case contentResendVerification = "content.resendVerification"
    /// The request is in flight. Labelled, for the same reason every other busy
    /// state in the app is: a bare spinner reads as nothing to VoiceOver.
    case contentResendVerificationBusy = "content.resendVerificationBusy"
    /// What a 200 from the resend endpoint actually establishes: the server
    /// accepted the request. It answers 200 whether or not it sent anything (see
    /// `AccountClient.resendVerification`), so the copy claims acceptance and
    /// names the spam folder rather than promising a delivery it cannot observe.
    case contentResendVerificationSent = "content.resendVerificationSent"
    case contentPendingDeletionTitle = "content.pendingDeletionTitle"
    /// %@ — the purge date.
    case contentPendingDeletionBody = "content.pendingDeletionBody"
    case contentReactivate = "content.reactivate"
    case contentBackToSignIn = "content.backToSignIn"
    /// The iOS receive tab, and the iOS account tab. macOS has no tab bar —
    /// `nav.*` names its five sidebar destinations — so these two keys are
    /// rendered by `apps/ios/Relayium` alone. `download.heading` ("Receive
    /// files") is a screen title, too long for a tab item.
    case tabReceive = "tab.receive"
    /// The iOS send tab. A third register again: `upload.heading` ("Send files")
    /// is a screen title and `common.send` is the button that starts a transfer,
    /// while this names a place in the tab bar.
    case tabSend = "tab.send"
    case tabAccount = "tab.account"
    case tabDirect = "tab.direct"

    // MARK: - Navigation
    //
    // The macOS sidebar. Five rows, all visible at once, each with a one-line
    // subtitle — so what a destination does is readable before it is opened
    // rather than after. The subtitles are also the rows' accessibility hints,
    // which is why each one is a sentence and not a fragment.
    //
    // They are also, since the page headings went, the ONLY place a destination
    // is named and explained. Nothing on the screen itself repeats them.

    /// Sidebar section: the two destinations where the other person is present.
    case navSectionDirect = "nav.sectionDirect"
    /// Sidebar section: the destinations that go through a stored link.
    case navSectionLinks = "nav.sectionLinks"
    /// Sidebar section: what this Mac itself does while nobody is watching it.
    /// A section of its own rather than a row under Links, because the Device
    /// Inbox is neither a link nor a conversation with somebody present — it is
    /// this machine as a destination.
    case navSectionDevice = "nav.sectionDevice"
    case navNearby = "nav.nearby"
    case navPairingCodeSubtitle = "nav.pairingCodeSubtitle"
    case navStoredSend = "nav.storedSend"
    case navStoredSendSubtitle = "nav.storedSendSubtitle"
    /// The Open a link screen's window title. **No subtitle key**, because it
    /// has no sidebar row: it is reached by a `relayium.com` download link the
    /// OS handed this app, not browsed to, so there is no row for a subtitle to
    /// explain.
    case navStoredReceive = "nav.storedReceive"
    /// The Device Inbox row's subtitle, and therefore its accessibility hint.
    /// It has no title key of its own: the row renders `inbox.title`, so the
    /// sidebar, the menu bar and the window title cannot end up calling one
    /// feature three things.
    case navDeviceInboxSubtitle = "nav.deviceInboxSubtitle"
    case navAccount = "nav.account"
    case navAccountSubtitle = "nav.accountSubtitle"
    /// The sidebar list's accessibility label.
    case navA11ySections = "nav.a11ySections"
    /// Announced on the row whose destination is presenting a live session, so
    /// a VoiceOver user is not told to look for it on the wrong screen.
    case navA11yLiveSession = "nav.a11yLiveSession"
    /// The sidebar footer's heading. Background receive — what makes this Mac
    /// reachable — reports its own state beneath it.
    case navResidency = "nav.residency"
    /// The macOS LAN Transfer row: the other device is on this network.
    ///
    /// Its subtitle carries the limitation that rules the destination out —
    /// both sides have to be online at the same time — because that is what a
    /// person needs before committing to a live transport.
    case navLanTransfer = "nav.lanTransfer"
    case navLanTransferSubtitle = "nav.lanTransferSubtitle"
    /// The macOS Cross-network Transfer row: the other device is anywhere.
    ///
    /// Its subtitle has one more job than the others. The single question
    /// separating these two destinations is whether the devices must share a
    /// network, so this one says outright that they need not — and the screen
    /// repeats it in `crossNetwork.explain`, because a sidebar hint is not where
    /// somebody looks to confirm it.
    case navCrossNetwork = "nav.crossNetwork"
    case navCrossNetworkSubtitle = "nav.crossNetworkSubtitle"

    /// The Cross-network Transfer screen's own explanation, beside the pairing
    /// controls — the counterpart to `nearby.explain` on the LAN screen.
    case crossNetworkExplain = "crossNetwork.explain"

    /// Why a transfer screen's controls are inert.
    ///
    /// One `TransferPresence` arbitrates one session between the two transfer
    /// destinations, so the screen that does NOT own it has every control
    /// disabled. A greyed control with no stated reason is the dead end this
    /// app's design rules forbid, and it is a reason the user can act on: the
    /// sidebar marks the row the session is on.
    case transferBusyElsewhere = "transfer.busyElsewhere"

    // MARK: - Transfer surfaces (macOS)
    //
    // Two destinations, one connection method each, one live session between
    // them. The copy here carries one obligation the rest of the app does not:
    // the surfaces are unified per method and the shipped wire is not, so three
    // of these strings exist purely to say what a connection can and cannot
    // carry. They are deliberately plain about it — a user who is told
    // "messages need their own connection" can act; one who finds a composer
    // that silently does nothing cannot.
    //
    // The `workspace.` prefix is the namespace these strings shipped under and
    // is deliberately left alone: it names nothing on screen, and renaming
    // thirty keys across nine catalogs to rename a namespace is churn with a
    // translation-loss risk and no user-visible result.

    case workspaceSameNetworkHeading = "workspace.sameNetworkHeading"
    case workspacePairingHeading = "workspace.pairingHeading"
    case workspaceStagingHeading = "workspace.stagingHeading"
    /// Says the quiet part: nothing has to be chosen before connecting.
    case workspaceStagingOptional = "workspace.stagingOptional"
    case workspaceDropHint = "workspace.dropHint"
    /// The default intent on a chosen device — no selection required, which is
    /// why it is the prominent one.
    case workspaceSendMessage = "workspace.sendMessage"
    /// The Workspace's own version of `nearby.addFilesHint`, which says
    /// "above" — true on the iOS layout that still renders it, and false here,
    /// where staging sits under the two connection methods.
    case workspaceAddFilesHint = "workspace.addFilesHint"
    case workspaceSendMessageHint = "workspace.sendMessageHint"
    case workspaceSendFiles = "workspace.sendFiles"
    case workspaceCreateMessageCode = "workspace.createMessageCode"
    case workspaceCreateFileCode = "workspace.createFileCode"
    case workspaceCreateFileCodeHint = "workspace.createFileCodeHint"
    case workspaceJoinMessages = "workspace.joinMessages"
    case workspaceJoinFiles = "workspace.joinFiles"
    /// Why joining asks which kind: a code does not say what the peer who minted
    /// it chose, and a speculative offer is read by an older peer as the wrong
    /// kind entirely.
    case workspaceJoinKindHint = "workspace.joinKindHint"
    /// The bounded limitation, stated once before anything is connected.
    case workspaceOneConnectionNote = "workspace.oneConnectionNote"
    /// The same fact from inside a live session, per lane.
    case workspaceMessagesOnlyNote = "workspace.messagesOnlyNote"
    case workspaceFilesOnlyNote = "workspace.filesOnlyNote"
    /// The one exit from a live or terminal session, whichever route opened it.
    case workspaceLeaveSession = "workspace.leaveSession"
    /// A pairing-code session has no roster label to snapshot, so it says how
    /// the peer was reached rather than inventing a name for them.
    case workspaceSessionWithCode = "workspace.sessionWithCode"

    // MARK: - The unified link
    //
    // Copy for a `link/1` session: ONE connection carrying messages and repeated
    // file/folder batches behind ONE verification. Every string here is reachable
    // only while such a link is live or has just ended — a legacy session keeps
    // the one-lane notes above, and the two sets are never on screen together.

    /// The composer's placeholder. Present from the moment the link opens,
    /// because pressing Send is what opens the conversation.
    case linkComposerPlaceholder = "link.composerPlaceholder"
    case linkSend = "link.send"
    /// Under the composer: the two file verbs, side by side with it rather than
    /// behind a mode.
    case linkSendFile = "link.sendFile"
    case linkSendFolder = "link.sendFolder"
    /// The claim the whole batch exists to make, stated once inside a live link.
    case linkOneConnectionNote = "link.oneConnectionNote"
    /// While the peer is being asked to accept the first message.
    case linkWaitingForPeer = "link.waitingForPeer"
    /// The peer declined messages. The draft is handed back, not lost.
    case linkMessagesDeclined = "link.messagesDeclined"
    /// A command arrived before the link could take it.
    case linkNotReady = "link.notReady"
    /// The peer is asking to start a conversation on the open link.
    case linkConversationRequest = "link.conversationRequest"
    case linkAcceptMessages = "link.acceptMessages"
    case linkDeclineMessages = "link.declineMessages"

    /// The one verification boundary, and the promise that it is the only one.
    case linkVerifyTitle = "link.verifyTitle"
    case linkVerifyBody = "link.verifyBody"
    case linkVerifyMatches = "link.verifyMatches"
    case linkVerifyDiffers = "link.verifyDiffers"
    /// What is being held while the digits are unanswered.
    case linkVerifyHoldingFiles = "link.verifyHoldingFiles"

    /// Connection states, each naming what the user can do next.
    case linkConnecting = "link.connecting"
    case linkRequesting = "link.requesting"
    case linkOpenWith = "link.openWith"
    /// The room socket is gone but the link is not. Truthful about both halves.
    case linkSignalingLost = "link.signalingLost"

    /// Terminal reasons. One per observed transition, never a guess.
    case linkEndedRefused = "link.endedRefused"
    case linkEndedTimedOut = "link.endedTimedOut"
    case linkEndedUnavailable = "link.endedUnavailable"
    case linkEndedFailed = "link.endedFailed"
    case linkEndedClosed = "link.endedClosed"
    case linkEndedVerificationRejected = "link.endedVerificationRejected"
    case linkEndedRoomLost = "link.endedRoomLost"
    /// A relayed link reached the bound its TURN credential stated. Not a
    /// failure: the allocation the server issued has a lifetime, and the remedy
    /// is a new code rather than a retry that would end the same way.
    case linkEndedRelayExpired = "link.endedRelayExpired"
    case linkEndedRoomUnavailable = "link.endedRoomUnavailable"
    /// The last few minutes of a relayed link, said once while it still works.
    case linkRelayExpiringSoon = "link.relayExpiringSoon"

    /// The transfer list inside a link.
    case linkTransfersHeading = "link.transfersHeading"
    case linkBatchOffered = "link.batchOffered"
    case linkBatchQueued = "link.batchQueued"
    case linkBatchTransferring = "link.batchTransferring"
    case linkBatchFinished = "link.batchFinished"
    case linkBatchReceived = "link.batchReceived"
    case linkBatchFailed = "link.batchFailed"
    case linkBatchArmed = "link.batchArmed"
    case linkAcceptFiles = "link.acceptFiles"
    case linkDeclineFiles = "link.declineFiles"
    /// The whole conversation is local to this window and goes when it does.
    case linkHistoryIsLocal = "link.historyIsLocal"

    // MARK: - Capability gates
    //
    // What `CapabilityGateView` renders when a feature genuinely needs an
    // account. Each body names the REAL server-side reason — an account pays for
    // stored bytes, an account pays for the relayed traffic a minted code
    // reserves — and each ends by naming the half that needs no account, because
    // the most damaging thing the old shell did was imply the whole product did.
    // That final clause is load-bearing and is asserted in all nine languages.

    case gateSendLinkTitle = "gate.sendLinkTitle"
    case gateSendLinkBody = "gate.sendLinkBody"
    case gateCreateCodeTitle = "gate.createCodeTitle"
    case gateCreateCodeBody = "gate.createCodeBody"
    /// Selects the Account destination. Distinct from `login.signIn`, which
    /// submits the form once the user is already looking at it.
    case gateSignIn = "gate.signIn"
    case gateCreateAccount = "gate.createAccount"
    /// Selects the Account destination for a user who already has an account and
    /// something to finish there — verifying an address, chiefly. Distinct from
    /// `gate.signIn`, which promises a form, and from `content.openRelayium`,
    /// which promised a website and no longer exists.
    case gateOpenAccount = "gate.openAccount"

    // MARK: - Sign in and create account
    //
    // One form, two modes. Registration happens IN THE APP against
    // `POST /api/auth/register`; the only web step in the flow is the link in
    // the verification email, which is the server's own confirmation endpoint.

    case loginEmail = "login.email"
    case loginPassword = "login.password"
    /// Mode-specific heading and explanation above the one account-access form.
    /// These make the screen explain the value of an account rather than
    /// presenting four unexplained fields as the whole product experience.
    case loginSignInTitle = "login.signInTitle"
    case loginSignInBody = "login.signInBody"
    case loginRegisterTitle = "login.registerTitle"
    case loginRegisterBody = "login.registerBody"
    /// The optional name field, offered only in create-account mode. Marked
    /// optional in the label itself, because a form that refuses a submission
    /// over a field nobody said was required is the more expensive mistake.
    case loginDisplayName = "login.displayName"
    case loginConfirmPassword = "login.confirmPassword"
    case loginSignIn = "login.signIn"
    /// A sign-in in flight, for the same reason as `account.restoring`.
    case loginSigningIn = "login.signingIn"
    /// A registration in flight. Separate from `login.signingIn` because they
    /// are different operations with different outcomes — this one ends on the
    /// check-email screen, never on an account.
    case loginCreatingAccount = "login.creatingAccount"
    /// The macOS browser device flow.
    ///
    /// It used to be labelled "Sign in with Apple", which was a claim about a
    /// mechanism the macOS app does not implement: it opens relayium.com in a
    /// sheet and polls `/api/cli/device/*` for an approval. The wording now
    /// names what actually happens.
    ///
    /// iOS ships the real system button instead (`SignInView`), and this key is
    /// not rendered there. The macOS app still cannot: a Developer ID build
    /// cannot carry `com.apple.developer.applesignin`, so the honest control on
    /// that platform stays a browser sign-in until a Mac App Store track exists.
    case loginBrowserSignIn = "login.browserSignIn"
    /// The submit button in create-account mode.
    case loginCreateAccount = "login.createAccount"
    /// The control that switches the form from sign-in into create-account mode.
    /// A different register from the button it reveals, so the two do not read as
    /// two ways to do the same thing.
    case loginNeedAccount = "login.needAccount"
    /// The form's own refusals, checked before any request goes out. There is no
    /// key for the password rule: it is the server's rule, so both sides say it
    /// through `error.account.passwordTooShort`.
    case loginErrorEmailMissing = "login.errorEmailMissing"
    case loginErrorPasswordsDiffer = "login.errorPasswordsDiffer"
    /// Separates the email/password form from Sign in with Apple.
    ///
    /// One word, and it is in the catalog rather than a literal because it is
    /// the shortest kind of copy that goes wrong silently: an English "or" in
    /// the middle of an Arabic screen. There is deliberately no key for the
    /// Apple button's own label — the system button carries Apple's wording,
    /// already localized and already correct for sign-in versus sign-up, and
    /// re-titling it would be both a guideline violation and a translation we
    /// would then own.
    case loginAppleDivider = "login.appleDivider"

    // MARK: - Direct hub and verification setting

    case hubTransferType = "hub.transferType"
    case hubFiles = "hub.files"
    case hubText = "hub.text"
    case hubTransferTypeHint = "hub.transferTypeHint"
    case verifyToggle = "verify.toggle"
    case verifyExplainWhat = "verify.explainWhat"
    case verifyExplainEncryption = "verify.explainEncryption"

    // MARK: - Single-session presence
    //
    // Nearby and Pairing code drive the SAME realtime models, so exactly one of
    // them presents a running session. These three are what the OTHER one says
    // instead of drawing a second copy of it with a second Cancel button. The
    // body names the reason rather than only the fact, because "already running"
    // on its own reads as a bug on the screen that is refusing to show it.

    case presenceBusyTitle = "presence.busyTitle"
    case presenceBusyBody = "presence.busyBody"
    /// Selects the destination that owns the session. Not a cancel and not a
    /// second Cancel — the whole point is that there is one of each.
    case presenceShowIt = "presence.showIt"

    // MARK: - Pairing-code file transfer

    case directSendHeading = "direct.sendHeading"
    case directCreateCode = "direct.createCode"
    case directReceiveHeading = "direct.receiveHeading"
    case directCreatingCode = "direct.creatingCode"
    case directGiveCode = "direct.giveCode"
    case pairingJoinLink = "pairing.joinLink"
    case pairingLinkCopied = "pairing.linkCopied"
    case pairingCodeExpiryNote = "pairing.codeExpiryNote"
    case directScanOnPhone = "direct.scanOnPhone"
    case directWaitingForDevice = "direct.waitingForDevice"
    case directChooseFilesFirst = "direct.chooseFilesFirst"
    case directModeMatchHint = "direct.modeMatchHint"
    /// Sits with the join field, which is rendered and enabled identically
    /// signed out. Only minting a code is gated, and only because the code's
    /// owner is billed for the relay capacity it reserves.
    case directJoinNoAccountNeeded = "direct.joinNoAccountNeeded"

    // MARK: - Direct, positioned and bounded (iOS)

    /// The honest limit of a peer-to-peer transfer, said where the user is
    /// deciding rather than after they have waited: both devices hold the
    /// connection, so a large file is slower and does not survive either of them
    /// leaving the app. The stored Send tab is the answer for that case, and
    /// this names it rather than leaving the user to infer it.
    case directLargeFilesTitle = "direct.largeFilesTitle"
    case directLargeFilesBody = "direct.largeFilesBody"
    case directOpenSend = "direct.openSend"
    /// Rendered while a transfer is actually moving. Distinct from
    /// `upload.keepOpen`, which is about one device and one upload.
    case directKeepBothOpen = "direct.keepBothOpen"
    /// What `ForegroundSessionCoordinator` says after ending a session the app
    /// could not carry into the background. Never an API name.
    case directInterrupted = "direct.interrupted"

    // MARK: - Live file session

    case sessionConnecting = "session.connecting"
    case sessionCheckMatches = "session.checkMatches"
    case sessionCheckMatchesBody = "session.checkMatchesBody"
    case sessionTheyMatch = "session.theyMatch"
    case sessionTheyDontMatch = "session.theyDontMatch"
    case sessionFilesSent = "session.filesSent"
    case sessionFilesReceived = "session.filesReceived"
    case sessionTransferProgress = "session.transferProgress"
    case sessionInvalidFileList = "session.invalidFileList"
    case sessionPeerDisconnected = "session.peerDisconnected"

    // MARK: - Stored upload

    case uploadHeading = "upload.heading"
    case uploadDropHint = "upload.dropHint"
    /// The empty state of the stored-send selection, whose explanation is
    /// `upload.dropHint` — the drop zone below it is the way out, so this names
    /// the state and the hint names the action rather than one string trying to
    /// do both.
    case storedSendIdleTitle = "storedSend.idleTitle"
    case uploadReady = "upload.ready"
    case uploadLinkReady = "upload.linkReady"
    case uploadSendAnother = "upload.sendAnother"

    // The CLI equivalent of a finished stored send, which the web has shown
    // since this feature existed and the Mac app had not.
    //
    // The warning is not decoration. Unquoted, everything from `#` onwards is a
    // shell comment, so pasting the bare link runs a command with the key
    // removed and fails complaining about something else — and the command, once
    // run, is written to a history file with the key in it.
    case storedSendCliHeading = "storedSend.cliHeading"
    case storedSendCliCopy = "storedSend.cliCopy"
    case storedSendCliWarning = "storedSend.cliWarning"
    case storedSendCliDocs = "storedSend.cliDocs"
    case uploadExpiresAfter = "upload.expiresAfter"
    case uploadBurnAfterRead = "upload.burnAfterRead"
    /// The foreground-only truth, rendered while an upload is in flight.
    ///
    /// R3-G changed what this has to say. There is still no background
    /// `URLSession` and iOS still stops the process when the user leaves — but
    /// the bytes are now staged on this device, so reopening the app offers to
    /// carry on. Both halves have to be in the sentence: a limitation the app
    /// stays silent about is one the user discovers by losing a transfer, and a
    /// recovery it stays silent about is one they never use.
    case uploadKeepOpen = "upload.keepOpen"
    /// Copying the selection into this app's own storage, before any upload.
    case uploadPreparing = "upload.preparing"
    /// Checking local disk and Keychain for an interrupted stored upload.
    case uploadCheckingRecovery = "upload.checkingRecovery"
    /// The heading of the offer made for a job that stopped.
    case uploadInterruptedTitle = "upload.interruptedTitle"
    /// %1$@ files, %2$@ size — what is waiting, and where it lives.
    case uploadInterruptedBody = "upload.interruptedBody"
    /// The reason it stopped, when there is one. %@ — the failure sentence.
    case uploadInterruptedReason = "upload.interruptedReason"
    case uploadResume = "upload.resume"
    /// Destructive: it deletes this device's copy of the user's files.
    case uploadDiscard = "upload.discard"
    /// The server dropped an idle session, so the upload starts over. Named
    /// because the progress bar is about to return to zero.
    case uploadRestarting = "upload.restarting"
    /// The upload finished but its staged copy could not be removed. Never a
    /// failed upload — the link works — and never silent either.
    case uploadCleanupFailed = "upload.cleanupFailed"
    case uploadKeyKept = "upload.keyKept"
    /// %@ — the stored-link-key failure sentence this warning leads with.
    case uploadKeyWarning = "upload.keyWarning"
    /// %@ — a user's own file name, never translated.
    case uploadFileTooLarge = "upload.fileTooLarge"

    // MARK: - The iOS Send tab
    //
    // The gate above the send flow, and the two picker sources beneath it. The
    // gate exists because sending genuinely needs an account and receiving
    // genuinely does not, so each body says that asymmetry out loud rather than
    // leaving a greyed-out button to imply the whole product is gated.

    /// There is no existing "this needs an account" string: the account tab's
    /// copy is about *signing in*, which is the remedy, not the reason.
    case sendAccountTitle = "send.accountTitle"
    /// Names the honest asymmetry — uploads go to your account, receiving a link
    /// never needs one.
    case sendAccountBody = "send.accountBody"
    /// Selects the Account tab. It has never opened a browser, and now nothing
    /// on the account path does: `content.openRelayium` — the key that did — is
    /// gone, replaced by in-app registration and `content.resendVerification`.
    /// `gate.openAccount` is its macOS counterpart.
    case sendOpenAccount = "send.openAccount"
    /// "Signed in, but the account did not load" is a different sentence from
    /// "you need an account", and telling this user to sign in would be false.
    case sendAccountUnavailableBody = "send.accountUnavailableBody"
    /// The Photos button. `common.chooseFilesOrFolders` is reused verbatim for
    /// the Files button beside it.
    case sendChoosePhotos = "send.choosePhotos"
    /// Staging copies bytes out of the photo library and takes time; a bare
    /// spinner says nothing to VoiceOver.
    case sendPreparingPhotos = "send.preparingPhotos"

    // MARK: - The iOS share extension, and the draft it hands over

    /// The extension's own title. It names the product because the sheet it
    /// appears in belongs to another app entirely.
    case shareHeading = "share.heading"
    /// The disclosure the whole surface exists for: the files are COPIED, on
    /// this device, and nothing leaves it until Send is pressed in Relayium.
    /// Both halves are load-bearing — a user who thinks the share sheet
    /// uploaded something has been misled about where their file is.
    case shareDisclosure = "share.disclosure"
    /// The one action, and it names what actually happens: a copy onto this
    /// device. It must not promise to open Relayium — a Share Extension is not
    /// an extension point Apple lets open its containing app.
    case shareContinue = "share.continue"
    /// %@ — how many files have been copied so far. A count rather than a
    /// percentage: a shared folder's size is not known until it has been walked.
    case shareCopying = "share.copying"
    /// The terminal success state. Both halves are load-bearing: the files are
    /// SAVED, on this device, and nothing has been uploaded — and the next step
    /// is the user opening Relayium themselves, because the extension cannot.
    case shareSavedTitle = "share.savedTitle"
    case shareSavedBody = "share.savedBody"
    /// The Send tab's heading for work that arrived from another app.
    case shareWaitingTitle = "share.waitingTitle"
    /// %@ — a pluralized file count, already formatted.
    case shareWaitingBody = "share.waitingBody"
    /// Stated on both surfaces, and true on both: a complete draft is never
    /// expired, deleted on a timer, or uploaded on its own.
    case shareStaysHere = "share.staysHere"
    case shareUse = "share.use"
    /// Signed out. The draft is still visible and still safe; what it cannot do
    /// is become an upload, because an upload belongs to an account.
    case shareSignedOutBody = "share.signedOutBody"
    /// Something else on the Send tab would be overwritten. Naming the reason,
    /// rather than a disabled button with no explanation.
    case shareBusyBody = "share.busyBody"

    case ttlOneHour = "ttl.oneHour"
    case ttlOneDay = "ttl.oneDay"
    case ttlThreeDays = "ttl.threeDays"
    case ttlSevenDays = "ttl.sevenDays"
    case ttlFourteenDays = "ttl.fourteenDays"
    /// %@ — a raw second count, for a retention value the server offers that
    /// this build has no name for.
    case ttlSeconds = "ttl.seconds"

    // MARK: - Stored download

    case downloadHeading = "download.heading"
    case downloadLinkPlaceholder = "download.linkPlaceholder"
    case downloadOpen = "download.open"
    /// %1$@ file count, %2$@ total size.
    case downloadManifestSummary = "download.manifestSummary"
    case downloadBurnNotice = "download.burnNotice"
    case downloadSave = "download.save"
    case downloadSavePanelPrompt = "download.savePanelPrompt"
    case downloadBadLink = "download.badLink"
    /// The download action where there is no folder picker to open.
    ///
    /// Separate from `download.save` rather than shared with it: macOS's `Save…`
    /// promises a panel, and on iOS the destination is already decided, so the
    /// ellipsis would be a lie about what the next tap does.
    case downloadReceive = "download.receive"
    /// Labelled status for the two waits. macOS shows a bare spinner beside a
    /// pane the user is already reading; a touch screen showing only a spinner
    /// says nothing, and VoiceOver reads nothing at all.
    case downloadResolving = "download.resolving"
    case downloadInProgress = "download.inProgress"
    /// Where the files actually are, said once, after they are there. The
    /// counterpart of macOS's "Reveal in Finder" for a platform whose file
    /// browser is a separate app.
    ///
    /// %@ — the route through the Files app, `Relayium/Received`, supplied by
    /// `ReceiveDestinationCopy.savedLocation()` from the same constants the
    /// destination failures name and isolated as a technical token. Interpolated
    /// rather than written into each translation because the receive folder sits
    /// one level below the app's own folder, and a sentence that spelled the
    /// route out was free to stop at `Relayium` — which is where the files are
    /// not.
    case downloadSavedLocation = "download.savedLocation"
    /// What the receive surface says before a link is pasted. The second
    /// sentence is the reason this destination needs nothing from the user but
    /// the link: the key travels in the fragment, which never leaves the client.
    /// It replaces an `EmptyView()` — literally what this state used to render.
    case downloadIdleHint = "download.idleHint"
    /// The third of the three "needs no account" lines, and the one that carries
    /// the most weight: receiving a stored link is the capability the old
    /// sign-in-first shell hid most completely. Its clause must survive
    /// translation in all nine — it is the same sentence `gate.sendLinkBody`
    /// ends with, said where the capability actually is.
    case downloadNoAccountNeeded = "download.noAccountNeeded"

    // MARK: - Ephemeral text

    case textCreatingCode = "text.creatingCode"
    case textStartHeading = "text.startHeading"
    case textStartBody = "text.startBody"
    case textCreateCode = "text.createCode"
    case textGiveCode = "text.giveCode"
    case textConnecting = "text.connecting"
    case textCheckMatches = "text.checkMatches"
    case textCheckMatchesBody = "text.checkMatchesBody"
    case textWaitingAccept = "text.waitingAccept"
    /// %@ — the SAS, a technical token that is never translated.
    case textVerifiedPhrase = "text.verifiedPhrase"
    case textIncomingHeading = "text.incomingHeading"
    case textNothingDecrypted = "text.nothingDecrypted"
    case textSessionHeading = "text.sessionHeading"
    case textNoServerHistory = "text.noServerHistory"
    case textNoMessages = "text.noMessages"
    case textComposerLabel = "text.composerLabel"
    /// %1$@ draft byte count, %2$@ the limit.
    case textByteCounter = "text.byteCounter"
    case textClipboardNotice = "text.clipboardNotice"
    case textClipboardNoticeShort = "text.clipboardNoticeShort"
    case textClearHistory = "text.clearHistory"
    case textClearHistoryConfirmTitle = "text.clearHistory.confirmTitle"
    case textClearHistoryConfirmBody = "text.clearHistory.confirmBody"
    case textDiscardDraftConfirmTitle = "text.discardDraft.confirmTitle"
    case textDiscardDraftConfirmBody = "text.discardDraft.confirmBody"
    case textDiscardLocalContentConfirmTitle = "text.discardLocalContent.confirmTitle"
    case textDiscardLocalContentConfirmBody = "text.discardLocalContent.confirmBody"
    case textLocalHistoryHeading = "text.localHistoryHeading"
    case textLocalHistoryBody = "text.localHistoryBody"
    case textUnsentDraftHeading = "text.unsentDraftHeading"
    case textUnsentDraftBody = "text.unsentDraftBody"
    case textSent = "text.sent"
    case textReceived = "text.received"
    case textNotSent = "text.notSent"
    case textCopySentMessage = "text.copySentMessage"
    case textCopyReceivedMessage = "text.copyReceivedMessage"
    case textRefused = "text.refused"
    case textUnsupported = "text.unsupported"
    case textEnded = "text.ended"
    case textMessageTooLong = "text.messageTooLong"
    case textSendFailed = "text.sendFailed"
    case textSessionFailed = "text.sessionFailed"
    case textTooManyMessages = "text.tooManyMessages"
    case textSafetyLimits = "text.safetyLimits"

    // MARK: - Nearby pane

    /// The full mechanism paragraph: what the room is, why it usually but not
    /// always means the user's own network, and that nothing is scanned. On the
    /// narrow platform it is the body of a collapsed disclosure rather than the
    /// first thing on the screen — at the largest accessibility content sizes it
    /// alone filled several screens before any control could be reached.
    case nearbyExplain = "nearby.explain"
    /// The one claim that may never be a tap away: the roster is grouped by
    /// public address, and a carrier, VPN or shared gateway puts strangers on
    /// that address. Always visible, and short enough to stay that way.
    case nearbySafetySummary = "nearby.safetySummary"
    /// The disclosure's own title, which has to say what is behind it — a
    /// chevron labelled nothing is a control nobody opens.
    case nearbyHowItWorks = "nearby.howItWorks"
    case nearbyLookAgain = "nearby.lookAgain"
    case nearbyResumeReceiving = "nearby.resumeReceiving"
    case nearbyPauseReceiving = "nearby.pauseReceiving"
    case nearbyPausedBody = "nearby.pausedBody"
    case nearbyListeningBody = "nearby.listeningBody"
    // Where an unsolicited transfer lands, which is the one part of the
    // listening explanation that is genuinely different per platform: macOS
    // writes to the user's Downloads folder, iOS into the app's own folder,
    // published through the Files app. One shared sentence would have to be
    // false somewhere, so the location is its own key and the paragraph above
    // keeps only what is true on both.
    case nearbySavedToDownloads = "nearby.savedToDownloads"
    case nearbySavedToAppFolder = "nearby.savedToAppFolder"
    case nearbyA11yReceiving = "nearby.a11yReceiving"

    // What this Mac IS on the network, which the receive surface could not say.
    //
    // Two questions somebody asks the moment the device they expect is missing
    // from the roster — "which of these is me?" and "am I even on the right
    // network?" — plus the two disclaimers without which the answers mislead.
    // The address list is read locally while listening and is never stored,
    // logged or transmitted, and rooms are grouped by the network path the
    // service observes rather than by anything shown here.

    /// %@ — the name the CURRENT room socket announced. Not the live system
    /// name: renaming the Mac changes that and not what the room was told.
    case nearbyAnnouncedAs = "nearby.announcedAs"
    case nearbyLocalAddressesHeading = "nearby.localAddressesHeading"
    /// %1$@ the address, %2$@ the interface it is on. Both technical values.
    case nearbyLocalAddressRow = "nearby.localAddressRow"
    case nearbyNoLocalAddresses = "nearby.noLocalAddresses"
    case nearbyAddressesPrivacyNote = "nearby.addressesPrivacyNote"
    case nearbyAddressesNotGroupingNote = "nearby.addressesNotGroupingNote"
    case nearbyA11yThisMac = "nearby.a11yThisMac"

    case nearbyEmptyRoster = "nearby.emptyRoster"
    case nearbyNamesDisclaimer = "nearby.namesDisclaimer"
    case nearbyA11yDevices = "nearby.a11yDevices"
    case nearbyA11yChooseDevice = "nearby.a11yChooseDevice"
    /// %@ — the peer's own device name, never translated.
    case nearbySendTo = "nearby.sendTo"
    /// %@ — the snapshotted peer label shown throughout an admitted session.
    case nearbySessionWith = "nearby.sessionWith"
    case nearbySessionPeerDisclaimer = "nearby.sessionPeerDisclaimer"
    /// %@ — the selection summary sentence.
    case nearbySelectionSendHint = "nearby.selectionSendHint"
    case nearbyAddFilesHint = "nearby.addFilesHint"
    case nearbyTextIntent = "nearby.textIntent"
    case nearbyStartMessageSession = "nearby.startMessageSession"
    case nearbyAcceptanceNote = "nearby.acceptanceNote"
    case nearbyBackToDevices = "nearby.backToDevices"
    case nearbyLeavingClearsHistory = "nearby.leavingClearsHistory"
    case nearbyDeviceGone = "nearby.deviceGone"
    case nearbyAddFilesFirst = "nearby.addFilesFirst"
    case nearbyReconnecting = "nearby.reconnecting"
    case nearbyUnnamedDevice = "nearby.unnamedDevice"
    case nearbySetupFailed = "nearby.setupFailed"
    /// Both directions, stated once where the roster is. The code-less room
    /// mints nothing and `/api/ice` answers it STUN-only, so neither sending nor
    /// receiving here ever reaches the transport with a credential.
    case nearbyNoAccountNeeded = "nearby.noAccountNeeded"

    // MARK: - Drop zone, picker, received result, QR

    case dropA11yLabel = "drop.a11yLabel"
    case dropA11yHint = "drop.a11yHint"
    case pickerPrompt = "picker.prompt"
    case fileUnnamed = "file.unnamed"
    case receivedRevealInFinder = "received.revealInFinder"
    case receivedDragHint = "received.dragHint"
    case receivedA11yDragHint = "received.a11yDragHint"
    case qrA11yLabel = "qr.a11yLabel"

    // MARK: - Notifications

    case notifyTitleComplete = "notify.title.complete"
    case notifyTitleFailed = "notify.title.failed"
    case notifyTitleMessage = "notify.title.message"
    case notifyTitleIncoming = "notify.title.incoming"
    case notifyUploadReady = "notify.uploadReady"
    case notifyFilesDelivered = "notify.filesDelivered"
    case notifyTransferStopped = "notify.transferStopped"
    case notifyNewMessage = "notify.newMessage"
    case notifyIncomingFiles = "notify.incomingFiles"
    case notifyIncomingText = "notify.incomingText"
    case notifyIncomingFailed = "notify.incomingFailed"

    // MARK: - In-app subscription (Mac App Store build)
    //
    // The purchase surface the App Store build renders in place of the direct
    // build's link to the website. Every string here describes a state the
    // orchestration can actually reach; `AppleSubscriptionPresentation` is the
    // one place that chooses between them, and its tests walk this list.
    //
    // Prices are deliberately absent from this catalog. What a subscription
    // costs is the store's own localized answer for the caller's storefront, and
    // the only thing owned here is the sentence it is placed into.

    case subscriptionHeading = "subscription.heading"
    case subscriptionBody = "subscription.body"
    case subscriptionLoading = "subscription.loading"
    /// Nothing on sale: no live mapping for this build, or a store that knows
    /// none of the products there are. Not an error — nothing went wrong.
    case subscriptionNone = "subscription.none"
    /// An operator has closed this deployment's global App Store purchase gate.
    /// Distinct from `subscriptionNone`: that is a standing fact about what this
    /// build has to sell, this is a temporary one about the server, and the
    /// sentence has to say so — and say that nothing already paid for is
    /// affected, which is the second question a reader asks.
    case subscriptionPaused = "subscription.paused"
    case subscriptionSubscribe = "subscription.subscribe"
    /// The billing period as a label of its own, beside the tier's name. The
    /// two products of one tier are otherwise told apart only by their prices,
    /// and what is being chosen there is a commitment length.
    case subscriptionCycleMonthly = "subscription.cycleMonthly"
    case subscriptionCycleYearly = "subscription.cycleYearly"
    /// %1$@ storage, %2$@ monthly traffic — both already formatted by
    /// `L10n.bytes`, or the "Unlimited" word for a cap of 0. The FIGURES come
    /// from the server's own plan row; nothing in the app carries a copy of what
    /// a tier grants. Worded to match the web pricing page's own perks line, so
    /// the same tier reads the same way in a browser and in the app.
    case subscriptionEntitlements = "subscription.entitlements"
    /// The badge on the offer whose tier this account already holds.
    case subscriptionCurrent = "subscription.current"
    /// %@ — the store's own formatted price, never reformatted here.
    case subscriptionPriceMonthly = "subscription.priceMonthly"
    /// %@ — the store's own formatted price, never reformatted here.
    case subscriptionPriceYearly = "subscription.priceYearly"
    case subscriptionPurchasing = "subscription.purchasing"
    /// The gap between "Apple charged" and "Relayium recorded it". Named
    /// separately from `purchasing` because it is the interval in which nothing
    /// may be cancelled and nothing is lost if it fails.
    case subscriptionSubmitting = "subscription.submitting"
    case subscriptionRestoring = "subscription.restoring"
    case subscriptionRestore = "subscription.restore"
    case subscriptionNothingToRestore = "subscription.nothingToRestore"
    /// Ask to Buy, or a bank approval. No transaction exists yet.
    case subscriptionDeferred = "subscription.deferred"
    case subscriptionCompleted = "subscription.completed"
    /// Opens the App Store's own subscription management — the only place an
    /// App Store subscription can be changed or cancelled.
    case subscriptionManage = "subscription.manage"
    case subscriptionManagedByApple = "subscription.managedByApple"
    /// The two legal links the purchase surface must carry, worded as the pages
    /// they open — Relayium's privacy policy and the terms the subscription is
    /// sold under. Each language uses the title its own copy of that page
    /// already has on relayium.com, so the label names the document the reader
    /// arrives at rather than a second name for it.
    case subscriptionPrivacy = "subscription.privacy"
    case subscriptionTerms = "subscription.terms"
    /// The four ways the server can refuse a purchase before one starts.
    case subscriptionBlockedByWeb = "subscription.blockedByWeb"
    case subscriptionBlockedByAdmin = "subscription.blockedByAdmin"
    case subscriptionBlockedByAppleApp = "subscription.blockedByAppleApp"
    case subscriptionBlockedByOther = "subscription.blockedByOther"
    case subscriptionErrorNotSignedIn = "subscription.errorNotSignedIn"
    case subscriptionErrorNetwork = "subscription.errorNetwork"
    case subscriptionErrorBusy = "subscription.errorBusy"
    case subscriptionErrorNotAccepted = "subscription.errorNotAccepted"
    case subscriptionErrorOtherAccount = "subscription.errorOtherAccount"
    case subscriptionErrorAlreadyLinked = "subscription.errorAlreadyLinked"
    /// Apple completed a second purchase which Relayium retained but could not
    /// attach while another Apple subscription is still live on the account.
    case subscriptionErrorAppleConflict = "subscription.errorAppleConflict"
    case subscriptionErrorNotReady = "subscription.errorNotReady"
    case subscriptionErrorWrongBuild = "subscription.errorWrongBuild"
    /// %@ — an HTTP status, isolated as a token.
    case subscriptionErrorServer = "subscription.errorServer"
    /// %@ — an error type name, isolated as a token.
    case subscriptionErrorStore = "subscription.errorStore"

    // MARK: - Account tab

    case accountManagePlan = "account.managePlan"
    case accountTraffic = "account.traffic"
    case accountStorage = "account.storage"
    /// %1$@ used, %2$@ cap.
    case accountMeterOf = "account.meterOf"
    case accountStaleFigures = "account.staleFigures"
    /// Launch restore. macOS shows a bare `ProgressView`; a full-screen touch
    /// state needs a label, and VoiceOver reads nothing from a bare spinner.
    /// Same sentence as `menubar.loadingAccount` under a key that names the
    /// right surface.
    case accountRestoring = "account.restoring"
    case accountDevicesHeading = "account.devicesHeading"
    case accountDevicesBody = "account.devicesBody"
    case accountNoDevices = "account.noDevices"
    case accountUnnamedDevice = "account.unnamedDevice"
    /// The badge on the row for the credential this app is holding.
    ///
    /// The key still spells *thisMac* because renaming it would rewrite nine
    /// catalogs for no user-visible gain; the WORDING is device-neutral from
    /// R3-D onwards, because iOS renders the same badge. `LocalizedCopyTests`
    /// pins the phrase itself in every language.
    case accountThisMac = "account.thisMac"
    /// Both lists load from one call, but each says which list is loading: a
    /// bare spinner reads as nothing to VoiceOver and says nothing to anybody on
    /// a screen with two lists on it.
    case accountLoadingDevices = "account.loadingDevices"
    case accountLoadingFiles = "account.loadingFiles"
    case accountSigningOut = "account.signingOut"
    case accountDeviceKindCli = "account.deviceKindCli"
    case accountDeviceKindApp = "account.deviceKindApp"
    case accountDeviceNeverUsed = "account.deviceNeverUsed"
    /// %@ — a formatted date.
    case accountDeviceLastUsed = "account.deviceLastUsed"
    /// %@ — a formatted date.
    case accountDeviceAdded = "account.deviceAdded"
    /// %@ — the last network address the SERVER observed this credential from,
    /// isolated rather than translated. Rendered only when the server has one;
    /// there is deliberately no "unknown" wording, because a row with no address
    /// simply does not say anything about one.
    case accountDeviceLastAddress = "account.deviceLastAddress"
    /// What that address is, said once under the list instead of as a caveat on
    /// every row. It must not promise a location: a NAT, mobile carrier or VPN
    /// address is the common case, not the exception.
    case accountDevicesAddressNote = "account.devicesAddressNote"
    /// %@ — the device's own name, never translated.
    case accountRevokeTitle = "account.revokeTitle"
    case accountRevokeThisMac = "account.revokeThisMac"
    case accountRevokeOther = "account.revokeOther"
    /// The revoke button's accessible label. %1$@ — the device's own name, never
    /// translated; %2$@ — its detail line, which is what tells two devices with
    /// the SAME name apart to somebody who cannot see the list.
    case accountRevokeDeviceLabel = "account.revokeDeviceLabel"
    case accountFilesHeading = "account.filesHeading"
    case accountFilesBody = "account.filesBody"
    case accountNoFiles = "account.noFiles"
    case accountCopyLink = "account.copyLink"
    case accountKeyNotOnThisMac = "account.keyNotOnThisMac"
    /// %@ — the keychain failure sentence.
    case accountKeyLookupFailed = "account.keyLookupFailed"
    case accountDeleteFileTitle = "account.deleteFileTitle"
    case accountDeleteFileBody = "account.deleteFileBody"
    /// The two stored-row actions' accessible labels. %@ — the object's
    /// server-issued id, isolated rather than translated. A list of rows whose
    /// only controls read "Share" and "Delete" is unusable without sight.
    case accountShareFileLabel = "account.shareFileLabel"
    case accountDeleteFileLabel = "account.deleteFileLabel"
    /// %@ — a formatted byte size.
    case accountFileEncryptedSize = "account.fileEncryptedSize"
    case accountFileNoExpiry = "account.fileNoExpiry"
    /// %@ — a formatted date.
    case accountFileExpires = "account.fileExpires"
    case accountFileBurn = "account.fileBurn"
    case accountFileDownloaded = "account.fileDownloaded"
    case accountFileNotDownloaded = "account.fileNotDownloaded"
    case accountFileDownloadedOnce = "account.fileDownloadedOnce"
    /// Device-neutral since the account-deletion slice: `AccountSession` renders
    /// it when a deletion request comes back 401, and that runs on iOS too, so
    /// the sentence may not say "Mac" any more.
    case accountBearerInvalid = "account.bearerInvalid"
    /// %1$@ stored-file id (technical), %2$@ the key-removal failure sentence.
    case accountKeyCleanupWarning = "account.keyCleanupWarning"
    case accountSignOutFailed = "account.signOutFailed"

    // MARK: - Deleting the account itself
    //
    // Every one of these is held to the same three claims, in all nine
    // languages, by `LocalizedCopyTests`: the confirmation still happens by
    // EMAIL, asking is NOT yet deleting, and what confirming destroys is stated
    // rather than implied. The wording is device-neutral — iOS renders these
    // too, so nothing here may name a platform.

    case accountDeleteAccountHeading = "account.deleteAccountHeading"
    /// %@ — the account's own email address, never translated.
    case accountDeleteAccountBody = "account.deleteAccountBody"
    /// The control that opens the confirmation, not the one that acts.
    case accountDeleteAccount = "account.deleteAccount"
    case accountDeleteAccountConfirmTitle = "account.deleteAccountConfirmTitle"
    /// %@ — the account's own email address. The one string that has to carry
    /// the whole consequence: which server-side access confirming revokes,
    /// what it erases, and that the account itself goes permanently once the
    /// grace period ends.
    case accountDeleteAccountConfirmBody = "account.deleteAccountConfirmBody"
    /// The destructive button INSIDE the confirmation. It is labelled with what
    /// pressing it actually does — send an email — because it does not delete
    /// anything, and a button reading "Delete" would be the app's own copy
    /// contradicting the sentence directly above it.
    case accountDeleteAccountConfirmAction = "account.deleteAccountConfirmAction"
    case accountDeleteAccountRequesting = "account.deleteAccountRequesting"
    /// %@ — the account's own email address. Says what was established (the
    /// server took the request) and not what was not: the endpoint answers the
    /// same way whether it mailed anything or throttled it.
    case accountDeleteAccountRequested = "account.deleteAccountRequested"

    // MARK: - Plan meters and badges

    case usageUnlimited = "usage.unlimited"
    case usageResetsToday = "usage.resetsToday"
    case badgeTrial = "badge.trial"
    case badgePaymentFailed = "badge.paymentFailed"
    case badgeCanceled = "badge.canceled"
    case badgeUnpaid = "badge.unpaid"
    case badgePaymentIncomplete = "badge.paymentIncomplete"
    case badgePaused = "badge.paused"
    case badgeInactive = "badge.inactive"

    // MARK: - Errors

    case errorAccountInvalidCredentials = "error.account.invalidCredentials"
    case errorAccountNotSignedIn = "error.account.notSignedIn"
    case errorAccountRateLimited = "error.account.rateLimited"
    /// %@ — an HTTP status, verbatim.
    case errorAccountServer = "error.account.server"
    case errorAccountDecoding = "error.account.decoding"
    case errorAccountNetwork = "error.account.network"
    /// The four registration refusals. Each names the remedy rather than the
    /// status code, because each has a different one.
    case errorAccountEmailInvalid = "error.account.emailInvalid"
    /// Rendered by the form's own check as well as by the server's 400 — one
    /// rule, one sentence.
    case errorAccountPasswordTooShort = "error.account.passwordTooShort"
    case errorAccountEmailTaken = "error.account.emailTaken"
    case errorAccountPendingDeletion = "error.account.pendingDeletion"
    /// Native Sign in with Apple. Four sentences for two very different kinds
    /// of failure, and none of them may reuse `error.account.invalidCredentials`
    /// — that one tells the user to check an email and a password, and an Apple
    /// authorization involves neither.
    ///
    /// The server refused the credential: the identity token, its audience, or
    /// the one-time authorization code. All of those are one fact to the user.
    case errorAppleRejected = "error.apple.rejected"
    /// The exchange could not be completed with Apple at all — an outage, or a
    /// server that holds no Apple key. The only one of the four worth retrying
    /// unchanged, so it is the only one that says so.
    case errorAppleUnavailable = "error.apple.unavailable"
    /// Apple returned no address for an identity that has not been linked here.
    /// The copy points to the system authorization record that can be reset;
    /// displaying server status 400 would give the user nothing to act on.
    case errorAppleEmailUnavailable = "error.apple.emailUnavailable"
    /// The authorization came back without the identity token or the one-time
    /// code, so nothing was sent. It may not describe a refusal: no server ever
    /// saw this attempt.
    case errorAppleIncompleteCredential = "error.apple.incompleteCredential"
    /// `AuthenticationServices` itself failed. Deliberately NOT rendered for a
    /// user who cancelled — cancelling asks for nothing to happen, and an error
    /// sentence is something happening.
    case errorAppleAuthorizationFailed = "error.apple.authorizationFailed"
    /// %@ — an OSStatus, verbatim.
    case errorKeychainSignIn = "error.keychain.signIn"
    /// %@ — an OSStatus, verbatim.
    case errorStoredKeyKeychainSave = "error.storedKey.keychain.save"
    case errorStoredKeyKeychainRead = "error.storedKey.keychain.read"
    case errorStoredKeyKeychainRemove = "error.storedKey.keychain.remove"
    case errorStoredKeyBadIdSave = "error.storedKey.badId.save"
    case errorStoredKeyBadIdRead = "error.storedKey.badId.read"
    case errorStoredKeyBadIdRemove = "error.storedKey.badId.remove"
    case errorStoredKeyBadKeySave = "error.storedKey.badKey.save"
    case errorStoredKeyBadKeyRemove = "error.storedKey.badKey.remove"
    case errorHandshakeMitm = "error.handshake.mitm"
    case errorPeerProtocol = "error.peer.protocol"
    case errorRealtimeTamper = "error.realtime.tamper"
    case errorRealtimeDropped = "error.realtime.dropped"
    case errorRealtimeLegacyPeer = "error.realtime.legacyPeer"
    case errorSenderManifestTooLarge = "error.sender.manifestTooLarge"
    case errorSenderInvalidManifest = "error.sender.invalidManifest"
    /// %@ — a user's own file name, never translated.
    case errorSenderSourceShorter = "error.sender.sourceShorter"
    /// %@ — a user's own file name, never translated.
    case errorSenderSourceLonger = "error.sender.sourceLonger"
    case errorConnectionPeerBusy = "error.connection.peerBusy"
    case errorConnectionUnsupportedPeer = "error.connection.unsupportedPeer"
    case errorConnectionFailed = "error.connection.failed"
    case errorConnectionAlreadySending = "error.connection.alreadySending"
    case errorConnectionRejected = "error.connection.rejected"
    case errorConnectionTimedOut = "error.connection.timedOut"
    case errorConnectionTextSendBufferFull = "error.connection.textSendBufferFull"
    case errorConnectionTextSendFailed = "error.connection.textSendFailed"
    case errorConnectionTextReceiveBufferFull = "error.connection.textReceiveBufferFull"
    case errorFactoryNoPeerAppeared = "error.factory.noPeerAppeared"
    case errorNearbyNotScanning = "error.nearby.notScanning"
    case errorNearbyNoAnswer = "error.nearby.noAnswer"
    /// %@ — the file-count limit, verbatim.
    case errorStagingFileCount = "error.staging.fileCount"
    case errorStagingUnreadable = "error.staging.unreadable"
    case errorTextAuthenticationFailed = "error.text.authenticationFailed"
    case errorTextOutOfOrder = "error.text.outOfOrder"
    case errorTextMessageTooLarge = "error.text.messageTooLarge"
    case errorTextInvalid = "error.text.invalid"
    case errorDeviceAuthDenied = "error.deviceAuth.denied"
    case errorDeviceAuthExpired = "error.deviceAuth.expired"
    /// %@ — a directory name, never translated.
    case errorDestinationDirectoryExists = "error.destination.directoryExists"
    /// %@ — a file name from the manifest, never translated.
    case errorDestinationUnsafeName = "error.destination.unsafeName"
    /// %@ — a file name, never translated.
    case errorDestinationFileExists = "error.destination.fileExists"
    /// %1$@ — a file name, never translated. %2$@ — the folder's path in the
    /// Files app, never translated.
    ///
    /// The first of the five `.filesApp` keys. Each answers a shared
    /// `error.destination.*` string that only makes sense behind a folder
    /// picker: four of them end in *choose another folder*, and two of those
    /// also speak of *the folder you chose*. iOS receives into one app-owned
    /// folder and offers no picker, so on that platform those sentences name an
    /// action the user cannot take, or describe a choice nobody made.
    ///
    /// All five preserve the underlying outcome and the rule behind it; what
    /// they change is only what the shared copy gets wrong on iOS. For the two
    /// collisions that is the RECOVERY: go to the named folder in Files, rename
    /// or remove the item that is in the way, and download again — while the
    /// refusal itself, and the reason a container will not be merged into, are
    /// carried over from the shared copy on purpose, so the two platforms do not
    /// drift into explaining one rule two ways. For `unsafeName` it is the
    /// PREMISE: the shared copy assumes a folder the user chose, which does not
    /// exist on this platform, so the replacement drops that premise rather than
    /// the verdict. For the two write failures it is again the RECOVERY, since
    /// the folder they name cannot be swapped for another. Used by
    /// `ReceiveDestinationCopy`; nothing on macOS reaches any of the five.
    case errorDestinationFileExistsFilesApp = "error.destination.fileExists.filesApp"
    /// %1$@ — a directory name, never translated. %2$@ — the folder's path in
    /// the Files app, never translated.
    case errorDestinationDirectoryExistsFilesApp = "error.destination.directoryExists.filesApp"
    case errorDestinationIncomplete = "error.destination.incomplete"
    case errorDestinationNoSpace = "error.destination.noSpace"
    case errorDestinationNotPermitted = "error.destination.notPermitted"
    /// %@ — an errno value, verbatim.
    case errorDestinationSystemError = "error.destination.systemError"
    /// %@ — the unsafe name or path the link asked for, never translated.
    ///
    /// The shared key says the file would land *outside the folder you chose*,
    /// which on iOS is false in its subject as well as its advice — no folder
    /// was chosen. This says what is actually wrong: the link asks for a path
    /// the app will not write. There is no folder in it at all, because the
    /// destination is not what failed and the sender is the only fix.
    case errorDestinationUnsafeNameFilesApp = "error.destination.unsafeName.filesApp"
    /// %@ — the receive folder's path in the Files app, never translated.
    ///
    /// The shared key ends in *choose another folder*. The folder here is the
    /// app's own and fixed, so the only honest recovery is to retry and, if it
    /// persists, report it.
    case errorDestinationNotPermittedFilesApp = "error.destination.notPermitted.filesApp"
    /// %1$@ — the receive folder's path in the Files app, never translated.
    /// %2$@ — an errno value, verbatim.
    ///
    /// As above, and it keeps the errno for the same reason the shared key does:
    /// it is the only diagnosable part, and here it is the thing worth putting
    /// in the report.
    case errorDestinationSystemErrorFilesApp = "error.destination.systemError.filesApp"
    /// %@ — a manifest path, never translated.
    case errorManifestUnsafePath = "error.manifest.unsafePath"
    /// %@ — a manifest path, never translated.
    case errorManifestDuplicatePath = "error.manifest.duplicatePath"
    /// %@ — a manifest path, never translated.
    case errorManifestPathCollision = "error.manifest.pathCollision"
    /// %@ — a user's own file name, never translated.
    case errorPlaintextUnreadable = "error.plaintext.unreadable"
    /// %@ — a user's own file name, never translated.
    case errorPlaintextReadFailed = "error.plaintext.readFailed"
    /// %@ — the process's open-file limit, verbatim.
    case errorPlaintextTooManyOpenFiles = "error.plaintext.tooManyOpenFiles"
    case errorSelectionNoFiles = "error.selection.noFiles"
    /// %@ — the file-count limit, verbatim.
    case errorSelectionTooManyFiles = "error.selection.tooManyFiles"
    /// %@ — a user's own file name, never translated.
    case errorSelectionUnreadable = "error.selection.unreadable"
    /// %@ — a user's own file name, never translated.
    case errorSelectionSymbolicLink = "error.selection.symbolicLink"
    /// %@ — a path, never translated.
    case errorSelectionPathTooLong = "error.selection.pathTooLong"
    /// A refused photo batch: one item could not be staged, so none of them
    /// were. `error.selection.unreadable` names a path the user never saw — the
    /// staged name is this app's own invention, not the one they chose in the
    /// Photos picker.
    case errorPhotoImportFailed = "error.photoImport.failed"
    /// The App Group container could not be resolved, so there is nowhere the
    /// app would ever find what was shared. Deliberately not "try again": a
    /// missing entitlement does not fix itself, and the honest remedy is to open
    /// Relayium and choose the files there.
    case errorShareUnavailable = "error.share.unavailable"
    /// The share carried nothing this product can send.
    case errorShareNothingUsable = "error.share.nothingUsable"
    /// %@ — a user's own file name, never translated.
    case errorShareDuplicatePath = "error.share.duplicatePath"
    /// Anything the filesystem or a provider refused. One sentence rather than
    /// an `NSError` domain: a code is not something a user can act on, and a
    /// path inside one would put their directory names on screen.
    case errorShareStorageFailed = "error.share.storageFailed"
    case errorCloudUnauthorized = "error.cloud.unauthorized"
    case errorCloudQuota = "error.cloud.quota"
    case errorCloudRateLimited = "error.cloud.rateLimited"
    case errorCloudDailyQuota = "error.cloud.dailyQuota"
    case errorCloudMonthlyTraffic = "error.cloud.monthlyTraffic"
    /// The download-side 429. Separate from `error.cloud.rateLimited` because
    /// that one is an uploader's, and from `error.cloud.monthlyTraffic` because
    /// the exhausted allowance is the SENDER's — the reader of this sentence
    /// cannot upgrade their way out of it.
    case errorCloudDownloadLimited = "error.cloud.downloadLimited"
    /// A stored download the service could not answer. Separate from
    /// `error.cloud.server` because that one only says the request failed, and
    /// the recipient's next question — is my link bad? — is exactly what this
    /// sentence has to answer. Deliberately carries no status: the number is on
    /// the error case for bug reports, and a sentence built around it reads as
    /// something the reader is supposed to act on.
    case errorCloudDownloadUnavailable = "error.cloud.downloadUnavailable"
    case errorCloudNotFound = "error.cloud.notFound"
    /// %@ — an HTTP status, verbatim.
    case errorCloudServer = "error.cloud.server"
    case errorCloudNetwork = "error.cloud.network"
    case errorCloudDecoding = "error.cloud.decoding"
    case errorStoredLinkKeyInvalidIdentifier = "error.storedLinkKey.invalidIdentifier"
    case errorStoredLinkKeyInvalidKey = "error.storedLinkKey.invalidKey"
    case errorStoredWireInvalidKey = "error.storedWire.invalidKey"
    case errorStoredWireCorrupt = "error.storedWire.corrupt"
    /// %@ — the failing Swift type's name, verbatim, so a bug report is actionable.
    case errorUnknown = "error.unknown"

    // MARK: - Device Inbox (macOS Settings, menu bar, notifications)
    //
    // Two rules run through every sentence below and are worth stating once.
    //
    //  1. **Nothing here may claim readiness the app cannot back up.** There is a
    //     separate line for every state, including the awkward ones — no folder,
    //     a revoked grant, a full disk, paused, offline — because a single
    //     optimistic label is how a receiver ends up telling a sender it can take
    //     a file when it cannot.
    //  2. **No sentence renders a file name or a path.** The notification bodies
    //     are counts, and the menu bar names no destination at all: a macOS
    //     notification preview is readable on a locked screen by anyone in the
    //     room. Only the Settings result list, which is on the user's own screen
    //     behind their own login, offers Show in Finder.

    case inboxTitle = "inbox.title"
    case inboxExplain = "inbox.explain"
    case inboxSignedOut = "inbox.signedOut"
    case inboxSignedOutBody = "inbox.signedOutBody"

    // The folder grant. Separate from the policy in the copy as well as in the
    // storage, because the whole product invariant is that they are two
    // decisions.
    case inboxFolderHeading = "inbox.folderHeading"
    case inboxFolderExplain = "inbox.folderExplain"
    case inboxFolderNone = "inbox.folderNone"
    case inboxChooseFolder = "inbox.chooseFolder"
    case inboxChangeFolder = "inbox.changeFolder"
    case inboxRemoveFolder = "inbox.removeFolder"
    /// The system folder picker's own message and confirm button.
    case inboxPickerMessage = "inbox.pickerMessage"
    case inboxPickerPrompt = "inbox.pickerPrompt"

    case inboxPolicyHeading = "inbox.policyHeading"
    case inboxPolicyExplain = "inbox.policyExplain"
    case inboxPolicyOff = "inbox.policyOff"
    case inboxPolicyAsk = "inbox.policyAsk"
    case inboxPolicyAuto = "inbox.policyAuto"

    // One line per state. `L10nKey` is `CaseIterable` and the integrity test
    // walks it, so a state added without its sentence fails the suite rather
    // than rendering a raw key on somebody's menu bar.
    case inboxStatusSignedOut = "inbox.statusSignedOut"
    case inboxStatusLoading = "inbox.statusLoading"
    case inboxStatusDisabled = "inbox.statusDisabled"
    case inboxStatusFolderMissing = "inbox.statusFolderMissing"
    case inboxStatusReadyAuto = "inbox.statusReadyAuto"
    case inboxStatusReadyAsk = "inbox.statusReadyAsk"
    case inboxStatusPaused = "inbox.statusPaused"
    case inboxStatusWorking = "inbox.statusWorking"
    case inboxStatusOffline = "inbox.statusOffline"
    /// %@ — an already-formatted duration such as “30 seconds”.
    case inboxStatusOfflineRetry = "inbox.statusOfflineRetry"
    /// %@ — a whole number of seconds, already formatted in this language.
    case inboxRetrySeconds = "inbox.retrySeconds"

    // Why the folder cannot be used, and what to do about it. Four causes, four
    // different actions; collapsing them is how a stalled inbox looks fine.
    case inboxFolderAccessDenied = "inbox.folderAccessDenied"
    case inboxFolderUnresolvable = "inbox.folderUnresolvable"
    case inboxFolderNotWritable = "inbox.folderNotWritable"
    case inboxFolderStale = "inbox.folderStale"

    // Why one delivery stopped. The closed device error codes, one sentence each.
    case inboxBlockedDiskFull = "inbox.blockedDiskFull"
    case inboxBlockedPermission = "inbox.blockedPermission"
    case inboxBlockedDirectory = "inbox.blockedDirectory"
    case inboxBlockedNameConflict = "inbox.blockedNameConflict"
    case inboxBlockedDownload = "inbox.blockedDownload"
    case inboxBlockedDecrypt = "inbox.blockedDecrypt"
    case inboxBlockedVerify = "inbox.blockedVerify"
    case inboxBlockedDeclined = "inbox.blockedDeclined"
    case inboxBlockedUnsupported = "inbox.blockedUnsupported"
    case inboxBlockedInternal = "inbox.blockedInternal"

    // Terminal, per generation.
    case inboxFailedEnrolment = "inbox.failedEnrolment"
    case inboxFailedKey = "inbox.failedKey"
    case inboxFailedIdentity = "inbox.failedIdentity"
    case inboxFailedUnknown = "inbox.failedUnknown"

    case inboxPause = "inbox.pause"
    case inboxResume = "inbox.resume"
    case inboxReveal = "inbox.reveal"
    /// The menu bar's route to the Device Inbox.
    ///
    /// It replaces `inbox.openSettings`, and the rename is the point rather than
    /// tidiness: the item used to promise a settings window, which was the only
    /// full surface the feature had. It now opens the main window on the Device
    /// Inbox destination, so a title naming Settings would send the user
    /// somewhere the click no longer goes.
    case inboxOpenDeviceInbox = "inbox.openDeviceInbox"

    case inboxAskHeading = "inbox.askHeading"
    case inboxAskExplain = "inbox.askExplain"
    case inboxAskAccept = "inbox.askAccept"
    case inboxAskDecline = "inbox.askDecline"

    case inboxResultsHeading = "inbox.resultsHeading"
    case inboxResultsEmpty = "inbox.resultsEmpty"

    // Refusals of one user action, distinct from what the inbox IS.
    case inboxErrorNotWritable = "inbox.errorNotWritable"
    case inboxErrorBookmark = "inbox.errorBookmark"
    case inboxErrorNoFolder = "inbox.errorNoFolder"
    case inboxErrorAskFailed = "inbox.errorAskFailed"
    case inboxErrorNotificationSettings = "inbox.errorNotificationSettings"

    case inboxNotifyTitleSaved = "inbox.notifyTitleSaved"
    case inboxNotifyTitleAttention = "inbox.notifyTitleAttention"

    /// macOS will not show a delivery banner.
    ///
    /// The body is the load-bearing half: it has to say that receiving and saving
    /// are unaffected, because a user who reads only the headline concludes the
    /// Device Inbox has stopped working when in fact every file is still landing
    /// in their folder.
    case inboxBannersBlocked = "inbox.bannersBlocked"
    case inboxBannersBlockedBody = "inbox.bannersBlockedBody"
    case inboxOpenNotificationSettings = "inbox.openNotificationSettings"

    /// Open at Login is how residency RESUMES after a Mac login. It is
    /// deliberately not presented as evidence that the inbox is ready now, which
    /// is a different claim and one this checkbox cannot make.
    case inboxLoginNote = "inbox.loginNote"

    // MARK: - Help, below the controls on every browseable destination
    //
    // Three steps and one common question per screen, chosen to be short: every
    // string here is nine translations, and help nobody reads because it is long
    // is worse than help that stops at the useful part. Not collapsible — this
    // app's rules ban `DisclosureGroup`, and for the reason the root view once
    // demonstrated: a capability hidden behind a triangle is a capability nobody
    // finds.
    //
    // `help.guideLink` is rendered only where a maintained document actually
    // exists (`HelpPresentation.topic`), so it is one label rather than five.

    case helpHeading = "help.heading"
    case helpStepsHeading = "help.stepsHeading"
    case helpGuideLink = "help.guideLink"

    case helpLanStep1 = "help.lan.step1"
    case helpLanStep2 = "help.lan.step2"
    case helpLanStep3 = "help.lan.step3"
    case helpLanQuestion = "help.lan.question"
    case helpLanAnswer = "help.lan.answer"

    case helpCrossStep1 = "help.cross.step1"
    case helpCrossStep2 = "help.cross.step2"
    case helpCrossStep3 = "help.cross.step3"
    case helpCrossQuestion = "help.cross.question"
    case helpCrossAnswer = "help.cross.answer"

    case helpStoredSendStep1 = "help.storedSend.step1"
    case helpStoredSendStep2 = "help.storedSend.step2"
    case helpStoredSendStep3 = "help.storedSend.step3"
    case helpStoredSendQuestion = "help.storedSend.question"
    case helpStoredSendAnswer = "help.storedSend.answer"

    case helpInboxStep1 = "help.inbox.step1"
    case helpInboxStep2 = "help.inbox.step2"
    case helpInboxStep3 = "help.inbox.step3"
    case helpInboxQuestion = "help.inbox.question"
    case helpInboxAnswer = "help.inbox.answer"

    case helpAccountStep1 = "help.account.step1"
    case helpAccountStep2 = "help.account.step2"
    case helpAccountStep3 = "help.account.step3"
    case helpAccountQuestion = "help.account.question"
    case helpAccountAnswer = "help.account.answer"
}

/// Keys whose value depends on a count.
///
/// Separate from `L10nKey` because their catalog entries are a FAMILY —
/// `selection.files.one`, `selection.files.other`, and for Arabic four more —
/// and the integrity test has to check a different thing for them: exactly the
/// categories `PluralRule` says the language can produce, no more and no fewer.
public enum PluralKey: String, CaseIterable, Sendable {
    /// %@ — the count.
    case selectionFiles = "selection.files"
    /// %@ — the count.
    case selectionFolders = "selection.folders"
    /// %@ — the count.
    case selectionEmptyFolders = "selection.emptyFolders"
    /// %@ — the count.
    case downloadFileCount = "download.fileCount"
    /// %@ — the count.
    case downloadSavedFiles = "download.savedFiles"
    /// %@ — the count.
    case notifyFilesReady = "notify.filesReady"
    /// %@ — the count.
    case accountFileDownloadedTimes = "account.fileDownloadedTimes"
    /// %@ — the count.
    case usageResetsInDays = "usage.resetsInDays"
    /// %@ — how many ITEMS the share sheet handed over.
    ///
    /// Deliberately not `downloadFileCount`. A provider is one thing the user
    /// shared, and a shared folder is one provider and a thousand files — so
    /// "3 files" for three providers is a number this extension has not measured
    /// and, before the walk, cannot know. The copying label counts staged files
    /// and is measured; this one counts what the sheet handed over and says so.
    case shareItemCount = "share.itemCount"
    /// %@ — how many files one Device Inbox delivery durably saved. A COUNT,
    /// never a list: this string reaches a notification banner, which macOS shows
    /// on a locked screen.
    case inboxSavedFiles = "inbox.savedFiles"
    /// %@ — how many deliveries central is holding for the user's answer.
    case inboxWaitingDeliveries = "inbox.waitingDeliveries"

    /// The catalog key for one category of this plural.
    public func key(_ category: PluralCategory) -> String {
        "\(rawValue).\(category.rawValue)"
    }
}
