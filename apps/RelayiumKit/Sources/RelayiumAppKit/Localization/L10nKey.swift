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

    // MARK: - App lifecycle, menus

    case appCheckForUpdates = "app.checkForUpdates"
    case quitTitle = "quit.title"
    case quitBody = "quit.body"
    case quitCancelAndQuit = "quit.cancelAndQuit"
    case quitKeepTransferring = "quit.keepTransferring"

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

    // MARK: - Window shell

    case contentHaveLink = "content.haveLink"
    case contentNearbyOrCode = "content.nearbyOrCode"
    case contentAccountLoadFailed = "content.accountLoadFailed"
    case contentCheckEmailTitle = "content.checkEmailTitle"
    /// %@ — the account's email address.
    case contentCheckEmailBody = "content.checkEmailBody"
    case contentOpenRelayium = "content.openRelayium"
    case contentPendingDeletionTitle = "content.pendingDeletionTitle"
    /// %@ — the purge date.
    case contentPendingDeletionBody = "content.pendingDeletionBody"
    case contentReactivate = "content.reactivate"
    case contentBackToSignIn = "content.backToSignIn"
    case tabDirect = "tab.direct"
    case tabLink = "tab.link"
    case tabAccount = "tab.account"

    // MARK: - Sign in

    case loginEmail = "login.email"
    case loginPassword = "login.password"
    case loginSignIn = "login.signIn"
    case loginSignInWithApple = "login.signInWithApple"
    case loginCreateAccount = "login.createAccount"

    // MARK: - Direct hub and verification setting

    case hubTransferType = "hub.transferType"
    case hubFiles = "hub.files"
    case hubText = "hub.text"
    case hubTransferTypeHint = "hub.transferTypeHint"
    case verifyToggle = "verify.toggle"
    case verifyExplainWhat = "verify.explainWhat"
    case verifyExplainEncryption = "verify.explainEncryption"

    // MARK: - Pairing-code file transfer

    case directSendHeading = "direct.sendHeading"
    case directDropHint = "direct.dropHint"
    case directCreateCode = "direct.createCode"
    case directReceiveHeading = "direct.receiveHeading"
    case directCreatingCode = "direct.creatingCode"
    case directGiveCode = "direct.giveCode"
    case directScanOnPhone = "direct.scanOnPhone"
    case directWaitingForDevice = "direct.waitingForDevice"
    case directChooseFilesFirst = "direct.chooseFilesFirst"

    // MARK: - Live file session

    case sessionConnecting = "session.connecting"
    case sessionCheckMatches = "session.checkMatches"
    case sessionCheckMatchesBody = "session.checkMatchesBody"
    case sessionTheyMatch = "session.theyMatch"
    case sessionTheyDontMatch = "session.theyDontMatch"
    case sessionTransferComplete = "session.transferComplete"
    case sessionInvalidFileList = "session.invalidFileList"
    case sessionPeerDisconnected = "session.peerDisconnected"

    // MARK: - Stored upload

    case uploadHeading = "upload.heading"
    case uploadDropHint = "upload.dropHint"
    case uploadReady = "upload.ready"
    case uploadLinkReady = "upload.linkReady"
    case uploadSendAnother = "upload.sendAnother"
    case uploadExpiresAfter = "upload.expiresAfter"
    case uploadBurnAfterRead = "upload.burnAfterRead"
    case uploadKeyKept = "upload.keyKept"
    /// %@ — the stored-link-key failure sentence this warning leads with.
    case uploadKeyWarning = "upload.keyWarning"
    /// %@ — a user's own file name, never translated.
    case uploadFileTooLarge = "upload.fileTooLarge"

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

    // MARK: - Ephemeral text

    case textCreatingCode = "text.creatingCode"
    case textStartHeading = "text.startHeading"
    case textStartBody = "text.startBody"
    case textCreateCode = "text.createCode"
    case textSignInToCreate = "text.signInToCreate"
    case textJoinHeading = "text.joinHeading"
    case textJoinHint = "text.joinHint"
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
    case textLocalHistoryHeading = "text.localHistoryHeading"
    case textLocalHistoryBody = "text.localHistoryBody"
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

    case nearbyHeading = "nearby.heading"
    case nearbyExplain = "nearby.explain"
    case nearbyDropHint = "nearby.dropHint"
    case nearbyLookAgain = "nearby.lookAgain"
    case nearbyResumeReceiving = "nearby.resumeReceiving"
    case nearbyPauseReceiving = "nearby.pauseReceiving"
    case nearbyPausedBody = "nearby.pausedBody"
    case nearbyListeningBody = "nearby.listeningBody"
    case nearbyA11yReceiving = "nearby.a11yReceiving"
    case nearbyEmptyRoster = "nearby.emptyRoster"
    case nearbyNamesDisclaimer = "nearby.namesDisclaimer"
    case nearbyA11yDevices = "nearby.a11yDevices"
    case nearbyA11yChooseDevice = "nearby.a11yChooseDevice"
    /// %@ — the peer's own device name, never translated.
    case nearbySendTo = "nearby.sendTo"
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

    // MARK: - Drop zone, picker, received result, QR

    case dropA11yLabel = "drop.a11yLabel"
    case dropA11yHint = "drop.a11yHint"
    case pickerPrompt = "picker.prompt"
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

    // MARK: - Account tab

    case accountManagePlan = "account.managePlan"
    case accountTraffic = "account.traffic"
    case accountStorage = "account.storage"
    /// %1$@ used, %2$@ cap.
    case accountMeterOf = "account.meterOf"
    case accountStaleFigures = "account.staleFigures"
    case accountDevicesHeading = "account.devicesHeading"
    case accountDevicesBody = "account.devicesBody"
    case accountNoDevices = "account.noDevices"
    case accountUnnamedDevice = "account.unnamedDevice"
    case accountThisMac = "account.thisMac"
    case accountDeviceKindCli = "account.deviceKindCli"
    case accountDeviceKindApp = "account.deviceKindApp"
    case accountDeviceNeverUsed = "account.deviceNeverUsed"
    /// %@ — a formatted date.
    case accountDeviceLastUsed = "account.deviceLastUsed"
    /// %@ — a formatted date.
    case accountDeviceAdded = "account.deviceAdded"
    /// %@ — the device's own name, never translated.
    case accountRevokeTitle = "account.revokeTitle"
    case accountRevokeThisMac = "account.revokeThisMac"
    case accountRevokeOther = "account.revokeOther"
    case accountFilesHeading = "account.filesHeading"
    case accountFilesBody = "account.filesBody"
    case accountNoFiles = "account.noFiles"
    case accountCopyLink = "account.copyLink"
    case accountKeyNotOnThisMac = "account.keyNotOnThisMac"
    /// %@ — the keychain failure sentence.
    case accountKeyLookupFailed = "account.keyLookupFailed"
    case accountDeleteFileTitle = "account.deleteFileTitle"
    case accountDeleteFileBody = "account.deleteFileBody"
    /// %@ — a formatted byte size.
    case accountFileEncryptedSize = "account.fileEncryptedSize"
    case accountFileNoExpiry = "account.fileNoExpiry"
    /// %@ — a formatted date.
    case accountFileExpires = "account.fileExpires"
    case accountFileBurn = "account.fileBurn"
    case accountFileDownloaded = "account.fileDownloaded"
    case accountFileNotDownloaded = "account.fileNotDownloaded"
    case accountFileDownloadedOnce = "account.fileDownloadedOnce"
    case accountBearerInvalid = "account.bearerInvalid"
    /// %1$@ stored-file id (technical), %2$@ the key-removal failure sentence.
    case accountKeyCleanupWarning = "account.keyCleanupWarning"
    case accountSignOutFailed = "account.signOutFailed"

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
    case errorDestinationIncomplete = "error.destination.incomplete"
    case errorDestinationNoSpace = "error.destination.noSpace"
    case errorDestinationNotPermitted = "error.destination.notPermitted"
    /// %@ — an errno value, verbatim.
    case errorDestinationSystemError = "error.destination.systemError"
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
    case errorCloudUnauthorized = "error.cloud.unauthorized"
    case errorCloudQuota = "error.cloud.quota"
    case errorCloudRateLimited = "error.cloud.rateLimited"
    case errorCloudDailyQuota = "error.cloud.dailyQuota"
    case errorCloudMonthlyTraffic = "error.cloud.monthlyTraffic"
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

    /// The catalog key for one category of this plural.
    public func key(_ category: PluralCategory) -> String {
        "\(rawValue).\(category.rawValue)"
    }
}
