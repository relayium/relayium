import Foundation
import RelayiumKit
import RelayiumShareKit

/// One sentence per state of a device send, and never an optimistic one.
///
/// The same shape and the same reason as `InboxCopy.swift`: two `switch`
/// statements over one state enum are two places for a case to go missing, and
/// the send screen renders these states in more than one place.
///
/// **What no branch here may produce.** There is exactly one arrival sentence,
/// `send.stateSaved`, and it is reachable from exactly one input:
/// `.tracking(.saved)`, which is central reporting that a target device
/// authenticated, verified and atomically committed the delivery. The three
/// local phases — staging, uploading, creating — have their own sentences and
/// none of them says the file has landed. `InboxSendCopyTests` asserts that as a
/// property over every case rather than by reading this file.
///
/// **And what no sentence carries.** No file name, no path, no device id, no
/// task id and no server text: a rejection contributes a token this protocol
/// already defines, and a status contributes a number.
public enum InboxSendPresentation {

    // MARK: - what a send is doing

    public static func status(for activity: InboxSendActivity,
                              language: AppLanguage? = nil) -> String {
        switch activity {
        case .staged:
            return L10n.t(.sendStateStaged, language: language)
        case .preparing:
            return L10n.t(.sendStatePreparing, language: language)
        case .uploading:
            // Deliberately not a percentage: the caller renders the bar, and a
            // sentence that counted bytes would be the one most likely to be
            // mistaken for progress toward an arrival.
            return L10n.t(.sendStateUploading, language: language)
        case .creating:
            return L10n.t(.sendStateCreating, language: language)
        case .tracking(let state):
            return text(for: state, language: language)
        case .unknown:
            return L10n.t(.sendStateUnknown, language: language)
        case .stopped(let failure):
            return text(for: failure, language: language)
        }
    }

    /// Central's own state, in the words a sender needs.
    ///
    /// `queued` and `notified` are separate because they answer different
    /// questions — has the device been reached at all — and collapsing them
    /// would make an offline target indistinguishable from one that is simply
    /// busy.
    public static func text(for state: InboxTaskState,
                            language: AppLanguage? = nil) -> String {
        switch state {
        case .queued:            return L10n.t(.sendStateQueued, language: language)
        case .notified:          return L10n.t(.sendStateNotified, language: language)
        case .downloading:       return L10n.t(.sendStateDownloading, language: language)
        case .verifying:         return L10n.t(.sendStateVerifying, language: language)
        case .saved:             return L10n.t(.sendStateSaved, language: language)
        case .attentionRequired: return L10n.t(.sendStateAttention, language: language)
        case .expired:           return L10n.t(.sendStateExpired, language: language)
        case .revoked:           return L10n.t(.sendStateRevoked, language: language)
        case .failedRetryable:   return L10n.t(.sendStateFailedRetryable, language: language)
        case .failedTerminal:    return L10n.t(.sendStateFailedTerminal, language: language)
        }
    }

    /// Why an attempt stopped, and what it did NOT do.
    ///
    /// The distinction the coordinator draws — definitive versus ambiguous — is
    /// carried into the copy rather than flattened: a user who is told a
    /// delivery may still exist behaves differently from one told it does not.
    public static func text(for failure: InboxSendFailure,
                            language: AppLanguage? = nil) -> String {
        switch failure {
        case .notADelivery:
            return L10n.t(.sendErrorNotADelivery, language: language)
        case .contentKeyMissing:
            return L10n.t(.sendErrorContentKey, language: language)
        case .uploadFailed:
            return L10n.t(.sendErrorUpload, language: language)
        case .targetMissing:
            return L10n.t(.sendErrorTargetMissing, language: language)
        case .targetUnavailable(let block):
            return text(for: block, language: language)
        case .textUnsupported:
            // The sentence the unsupported-capability block already carries:
            // that build cannot do this, and updating it may fix it. Reused
            // rather than minted, so one condition does not acquire two
            // explanations depending on which action discovered it.
            return L10n.t(.sendBlockUnsupportedCapability, language: language)
        case .unsendableContent:
            // Nothing left this device and nothing will: the names or sizes
            // themselves are what no receiver would accept. It reads as the
            // staging refusal because that is where the user's remedy is —
            // choose something else — rather than on the other machine.
            return L10n.t(.sendRefusalStaging, language: language)
        case .staleTargetKey:
            return L10n.t(.sendErrorStaleKey, language: language)
        case .sealFailed:
            return L10n.t(.sendErrorSeal, language: language)
        case .refused(let rejection):
            return text(for: rejection, language: language)
        case .rejected:
            // The status is deliberately absent from the sentence. It is a
            // number only a maintainer can act on, and the user's remedy is the
            // same either way.
            return L10n.t(.sendErrorRefused, language: language)
        case .notAuthorized:
            return L10n.t(.sendErrorNotAuthorized, language: language)
        case .recoveryStateWriteFailed:
            return L10n.t(.sendErrorRecoveryWrite, language: language)
        case .recoveryStateReadFailed:
            return L10n.t(.sendErrorRecoveryRead, language: language)
        case .noTaskCreated:
            return L10n.t(.sendErrorNoTask, language: language)
        case .unknownOutcome:
            return L10n.t(.sendStateUnknown, language: language)
        }
    }

    /// A create central refused, by a token this protocol defines.
    ///
    /// Mapped onto the sentences that already exist for the same underlying
    /// facts — receiving switched off IS receiving switched off, whether it was
    /// discovered in the device list or at the create — so a user cannot be
    /// given two different explanations of one condition depending on how far
    /// the send got.
    public static func text(for rejection: InboxRejection,
                            language: AppLanguage? = nil) -> String {
        switch rejection {
        case .autoReceiveDisabled:
            return L10n.t(.sendBlockReceiveOff, language: language)
        case .deviceInboxNotRegistered:
            return L10n.t(.sendBlockNotEnrolled, language: language)
        case .deviceInboxRevoked:
            return L10n.t(.sendBlockRevoked, language: language)
        case .deviceCannotReceive:
            return L10n.t(.sendBlockCannotReceive, language: language)
        case .unsupportedProtocolVersion, .unsupportedCapability,
             .unsupportedAutoAcceptCapability:
            return L10n.t(.sendBlockUnsupportedCapability, language: language)
        case .unsupportedKeyAlgorithm, .unusablePublicKey, .malformedPublicKey,
             .deviceKeyReused:
            return L10n.t(.sendBlockUnsupportedKey, language: language)
        case .staleTargetKey, .staleKeyRotation:
            return L10n.t(.sendErrorStaleKey, language: language)
        case .idempotencyKeyConflict:
            return L10n.t(.sendErrorConflict, language: language)
        case .storedObjectAlreadyBound:
            return L10n.t(.sendErrorAlreadyBound, language: language)
        case .storedObjectUnavailable:
            return L10n.t(.sendErrorObjectUnavailable, language: language)
        case .inboxQueueFull:
            return L10n.t(.sendErrorQueueFull, language: language)
        case .staleClaim, .taskTerminal, .invalidTransition:
            // Central's own scheduling vocabulary. A sender cannot act on any of
            // them, and inventing three sentences it could not act on either
            // would be three ways of saying the same thing.
            return L10n.t(.sendErrorRefused, language: language)
        }
    }

    // MARK: - what a device can and cannot do

    public static func text(for block: InboxTargetBlock,
                            language: AppLanguage? = nil) -> String {
        switch block {
        case .unusableIdentifier:    return L10n.t(.sendBlockUnusableIdentifier, language: language)
        case .notEnrolled:           return L10n.t(.sendBlockNotEnrolled, language: language)
        case .revoked:               return L10n.t(.sendBlockRevoked, language: language)
        case .cannotReceive:         return L10n.t(.sendBlockCannotReceive, language: language)
        case .unsupportedCapability: return L10n.t(.sendBlockUnsupportedCapability, language: language)
        case .unsupportedKey:        return L10n.t(.sendBlockUnsupportedKey, language: language)
        case .receiveOff:            return L10n.t(.sendBlockReceiveOff, language: language)
        }
    }

    /// A qualification on a send that IS allowed. Never suppressed: a target
    /// that will not land unattended has to say so BEFORE the file is encrypted
    /// and uploaded, not after.
    public static func text(for caveat: InboxTargetCaveat,
                            language: AppLanguage? = nil) -> String {
        switch caveat {
        case .needsApproval:      return L10n.t(.sendCaveatNeedsApproval, language: language)
        case .directoryNotReady:  return L10n.t(.sendCaveatDirectoryNotReady, language: language)
        case .queuedUntilOnline:  return L10n.t(.sendCaveatQueuedUntilOnline, language: language)
        }
    }

    /// The name one device is offered under, or the localized stand-in.
    ///
    /// Trimmed rather than merely checked for empty, and for the reason
    /// `AccountPresentation.deviceName` is: central defaults a missing name to
    /// `""` and promises nothing about whitespace, so a device named with three
    /// spaces would otherwise be a blank, tappable row that sends a file
    /// somewhere the user cannot identify. It reuses the account tab's own
    /// stand-in, because two different phrases for "this device has no name"
    /// inside one app would read as two different conditions.
    public static func name(of candidate: InboxSendCandidate,
                            language: AppLanguage? = nil) -> String {
        let name = candidate.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return L10n.t(.accountUnnamedDevice, language: language) }
        return L10n.token(name, language: language)
    }

    /// Central's own label for what a device IS, in the account tab's words.
    ///
    /// Shared with `AccountPresentation.deviceDetail` deliberately: the same
    /// device appears in both lists, and a Mac described as "App" in one place
    /// and something else in the other would read as two devices.
    public static func kind(of candidate: InboxSendCandidate,
                            language: AppLanguage? = nil) -> String {
        // nonlocalized: central's own device-kind token, never displayed
        L10n.t(candidate.kind == "cli" ? .accountDeviceKindCli : .accountDeviceKindApp,
               language: language)
    }

    /// The detail line under one device's name: what it is, whether it is
    /// reachable now, and every truthful qualification, in the order they matter.
    ///
    /// The kind leads, and it is not decoration: two Macs signed in under the
    /// same account routinely carry the same name, and this line is the only
    /// thing separating them before the user commits their files to one of them.
    /// A blocked device says what it is too — the remedy is on that machine, and
    /// "Command line" is what tells the user which machine to go to.
    public static func detail(for candidate: InboxSendCandidate,
                              language: AppLanguage? = nil) -> String {
        var parts = [kind(of: candidate, language: language)]
        guard candidate.isSendable else {
            parts.append(text(for: candidate.availability.block ?? .cannotReceive,
                              language: language))
            return L10n.detail(parts, language: language)
        }
        parts.append(L10n.t(candidate.availability.online ? .sendTargetOnline : .sendTargetOffline,
                            language: language))
        parts.append(contentsOf: candidate.availability.caveats.map { text(for: $0, language: language) })
        return L10n.detail(parts, language: language)
    }

    /// The whole device list's own state, or nil when the list itself is the
    /// answer.
    public static func text(for directory: InboxSendDirectory,
                            language: AppLanguage? = nil) -> String? {
        switch directory {
        case .idle, .loaded:
            return nil
        case .loading:
            return L10n.t(.sendDeviceLoading, language: language)
        case .unavailable(.notAuthorized):
            return L10n.t(.sendDeviceUnauthorized, language: language)
        case .unavailable(.unreachable):
            return L10n.t(.sendDeviceUnreachable, language: language)
        }
    }

    // MARK: - refusals of one action

    public static func text(for refusal: InboxSendRefusal,
                            language: AppLanguage? = nil) -> String {
        switch refusal {
        case .noSelection:       return L10n.t(.sendRefusalNoSelection, language: language)
        case .noTargetChosen:    return L10n.t(.sendRefusalNoTarget, language: language)
        case .targetUnavailable(let block): return text(for: block, language: language)
        case .notSignedIn:       return L10n.t(.sendRefusalNotSignedIn, language: language)
        case .stagingFailed:     return L10n.t(.sendRefusalStaging, language: language)
        case .keyStorageFailed:  return L10n.t(.sendRefusalKeyStorage, language: language)
        case .alreadySending:    return L10n.t(.sendRefusalAlreadySending, language: language)
        case .messageEmpty:      return L10n.t(.sendRefusalMessageEmpty, language: language)
        case .messageTooLong:    return L10n.t(.sendRefusalMessageTooLong, language: language)
        // The same sentence the unsupported-capability block carries: that
        // build cannot do this, and updating it may fix it. Reused rather than
        // minted, so one condition does not acquire two explanations depending
        // on which action discovered it.
        case .textUnsupported:   return L10n.t(.sendBlockUnsupportedCapability, language: language)
        }
    }

    public static func text(for error: InboxSendActionError,
                            language: AppLanguage? = nil) -> String {
        switch error {
        case .cancelRefused: return L10n.t(.sendCancelRefused, language: language)
        }
    }

    // MARK: - controls

    /// The label of one recovery control.
    ///
    /// Three of the six reuse the app's existing vocabulary rather than minting
    /// a synonym: a second word for Try again in one corner of one screen is a
    /// second thing to translate and a second thing to keep consistent.
    public static func label(for action: InboxSendAction,
                             language: AppLanguage? = nil) -> String {
        switch action {
        case .send:           return L10n.t(.commonSend, language: language)
        case .retry:          return L10n.t(.commonTryAgain, language: language)
        case .stopAttempt:    return L10n.t(.sendActionStop, language: language)
        case .cancelDelivery: return L10n.t(.sendActionCancelDelivery, language: language)
        case .discard:        return L10n.t(.uploadDiscard, language: language)
        case .dismiss:        return L10n.t(.commonDone, language: language)
        }
    }

    /// The SPOKEN name of one recovery control.
    ///
    /// Every card carries the same two or three words — Try again, Discard — so
    /// a screen with three outstanding deliveries offers a VoiceOver user three
    /// identical buttons, one of which deletes their only local copy of a file.
    /// The device and the contents are what tell them apart, exactly as the
    /// account tab's Revoke and Delete rows already do.
    public static func actionLabel(for action: InboxSendAction, on item: InboxSendItem,
                                   language: AppLanguage? = nil) -> String {
        L10n.detail([label(for: action, language: language),
                     targetName(of: item, language: language),
                     summary(of: item, language: language)], language: language)
    }

    /// The warning a destructive action has to carry, or nil.
    public static func warning(for action: InboxSendAction, on item: InboxSendItem,
                               language: AppLanguage? = nil) -> String? {
        guard InboxSendActions.warnsDeliveryMayStillArrive(action, for: item) else { return nil }
        return L10n.t(.sendDiscardMayArrive, language: language)
    }

    // MARK: - which kind of send

    /// The name of one route, as the chooser renders it.
    public static func label(for route: SendRoute, language: AppLanguage? = nil) -> String {
        switch route {
        case .link:   return L10n.t(.sendLinkHeading, language: language)
        case .device: return L10n.t(.sendDeviceHeading, language: language)
        }
    }

    /// What choosing that route actually does — including, for the link, the
    /// part a person has to know before they pick it: anybody holding the link
    /// can open the files.
    public static func explanation(for route: SendRoute,
                                   language: AppLanguage? = nil) -> String {
        switch route {
        case .link:   return L10n.t(.sendLinkExplain, language: language)
        case .device: return L10n.t(.sendDeviceExplain, language: language)
        }
    }

    // MARK: - one send, described

    /// The device a send is going to, named when it is known and described
    /// honestly when it is not.
    ///
    /// A recovered plan records the device ID and deliberately not its name — a
    /// name is central's to change — so this says "a device on your account"
    /// rather than rendering an identifier at somebody.
    public static func targetName(of item: InboxSendItem,
                                  language: AppLanguage? = nil) -> String {
        // Trimmed for the reason `name(of:)` is: a whitespace-only name is a
        // blank card that says nothing about where the user's files are going.
        let name = (item.targetName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            return L10n.t(.sendDeviceUnknownTarget, language: language)
        }
        return L10n.token(name, language: language)
    }

    /// "3 files · 1.2 MB", the same pair the picker line uses.
    public static func summary(of item: InboxSendItem, language: AppLanguage? = nil) -> String {
        L10n.detail([
            L10n.plural(.selectionFiles, item.fileCount, language: language),
            L10n.bytes(Int64(item.byteCount), language: language),
        ], language: language)
    }

    /// The accessible name of one send's row.
    ///
    /// Every card's controls read the same words — Try again, Discard — which is
    /// right to look at and useless to hear. The spoken name carries the device,
    /// what is in the delivery and what it is doing.
    public static func accessibilityLabel(of item: InboxSendItem,
                                          language: AppLanguage? = nil) -> String {
        L10n.detail([targetName(of: item, language: language),
                     summary(of: item, language: language),
                     status(for: item.activity, language: language)], language: language)
    }
}
