import Foundation
import RelayiumKit
import RelayiumShareKit

/// What the user is asked to do about a state, as a closed set.
///
/// Named here rather than decided in a view, for the reason the whole
/// `AppCopy.swift` file exists: two `switch` statements over one state enum is
/// two places for a case to go missing, and the menu bar and the Settings pane
/// render the same states. It is also the difference between a greyed-out control
/// and a route out of the problem — `MacSurfaceGuardTests` already refuses the
/// former elsewhere in this app.
public enum InboxRecovery: Equatable, Sendable {
    /// Pick a receive folder, or pick it again.
    case chooseFolder
    /// Try the whole thing now rather than waiting out the backoff.
    case retry
    /// Undo an explicit pause.
    case resume
    /// Answer the deliveries central is holding.
    case answer
}

/// One line per state, and never an optimistic one.
public enum InboxStatusPresentation {

    /// The status line. Rendered by BOTH the menu bar and Settings, so a state
    /// cannot describe itself differently depending on where it is seen.
    ///
    /// Note what is absent from every branch: a file name, a destination path and
    /// a task id. The menu bar is visible over a shared screen and this string is
    /// the widest-reaching one in the feature.
    public static func text(for state: InboxRuntimeState,
                            language: AppLanguage? = nil) -> String {
        switch state {
        case .signedOut:
            return L10n.t(.inboxStatusSignedOut, language: language)
        case .loading:
            return L10n.t(.inboxStatusLoading, language: language)
        case .disabled:
            return L10n.t(.inboxStatusDisabled, language: language)
        case .folderMissing:
            return L10n.t(.inboxStatusFolderMissing, language: language)
        case .ready(let policy):
            // Two different promises. `auto` says a file will land without the
            // user doing anything; `ask` says it will wait for them. Rendering
            // one for the other is a lie in whichever direction it goes.
            return L10n.t(policy == .auto ? .inboxStatusReadyAuto : .inboxStatusReadyAsk,
                          language: language)
        case .asking(let count):
            return L10n.plural(.inboxWaitingDeliveries, count, language: language)
        case .paused:
            return L10n.t(.inboxStatusPaused, language: language)
        case .working:
            return L10n.t(.inboxStatusWorking, language: language)
        case .attention(let attention):
            return text(for: attention, language: language)
        case .offline(let retry):
            guard let retry, retry > 0 else {
                return L10n.t(.inboxStatusOffline, language: language)
            }
            return L10n.t(.inboxStatusOfflineRetry,
                          [L10n.t(.inboxRetrySeconds, [L10n.number(retry, language: language)],
                                  language: language)],
                          language: language)
        case .saved(let files):
            return L10n.plural(.inboxSavedFiles, files, language: language)
        case .failed(let failure):
            return text(for: failure, language: language)
        }
    }

    /// The blocker's own sentence: what is wrong, and what clears it.
    public static func text(for attention: InboxAttention,
                            language: AppLanguage? = nil) -> String {
        switch attention {
        case .folder(let problem):
            switch problem {
            case .accessDenied:
                return L10n.t(.inboxFolderAccessDenied, language: language)
            case .unresolvable:
                return L10n.t(.inboxFolderUnresolvable, language: language)
            case .notWritable:
                return L10n.t(.inboxFolderNotWritable, language: language)
            case .staleRefreshFailed:
                return L10n.t(.inboxFolderStale, language: language)
            }
        case .delivery(let code):
            switch code {
            case .diskFull:            return L10n.t(.inboxBlockedDiskFull, language: language)
            case .permissionDenied:    return L10n.t(.inboxBlockedPermission, language: language)
            case .directoryUnavailable: return L10n.t(.inboxBlockedDirectory, language: language)
            case .nameConflict:        return L10n.t(.inboxBlockedNameConflict, language: language)
            case .downloadFailed:      return L10n.t(.inboxBlockedDownload, language: language)
            case .decryptFailed:       return L10n.t(.inboxBlockedDecrypt, language: language)
            case .verifyFailed:        return L10n.t(.inboxBlockedVerify, language: language)
            case .userDeclined:        return L10n.t(.inboxBlockedDeclined, language: language)
            case .unsupported:         return L10n.t(.inboxBlockedUnsupported, language: language)
            case .none, .internal:     return L10n.t(.inboxBlockedInternal, language: language)
            }
        }
    }

    public static func text(for failure: InboxRuntimeFailure,
                            language: AppLanguage? = nil) -> String {
        switch failure {
        case .enrolmentRefused: return L10n.t(.inboxFailedEnrolment, language: language)
        case .keyUnavailable:   return L10n.t(.inboxFailedKey, language: language)
        case .identity:         return L10n.t(.inboxFailedIdentity, language: language)
        case .unknown:          return L10n.t(.inboxFailedUnknown, language: language)
        }
    }

    /// What to offer next, or nothing.
    ///
    /// `saved`, `working`, `ready`, `loading` and `signedOut` deliberately return
    /// `nil`: none of them is a problem, and a recovery button on a healthy state
    /// invites a user to fix something that is not broken.
    public static func recovery(for state: InboxRuntimeState) -> InboxRecovery? {
        switch state {
        case .folderMissing:
            return .chooseFolder
        case .paused:
            return .resume
        case .asking:
            return .answer
        case .offline:
            return .retry
        case .attention(.folder):
            // Every folder problem — refused scope, unresolvable, unwritable, a
            // failed stale refresh — is repaired by granting the folder again.
            // Retrying the same stored bookmark is the one thing that cannot help.
            return .chooseFolder
        case .attention(.delivery(let code)):
            switch code {
            case .permissionDenied, .directoryUnavailable:
                return .chooseFolder
            default:
                return .retry
            }
        case .failed:
            return .retry
        case .signedOut, .loading, .disabled, .ready, .working, .saved:
            return nil
        }
    }

    /// The label for a recovery control.
    public static func label(for recovery: InboxRecovery,
                             language: AppLanguage? = nil) -> String {
        switch recovery {
        case .chooseFolder: return L10n.t(.inboxChooseFolder, language: language)
        case .retry:        return L10n.t(.commonTryAgain, language: language)
        case .resume:       return L10n.t(.inboxResume, language: language)
        case .answer:       return L10n.t(.inboxAskHeading, language: language)
        }
    }
}

/// The three answers, named the way the user chose them.
public enum InboxPolicyPresentation {
    public static func label(for policy: InboxAutoAccept,
                            language: AppLanguage? = nil) -> String {
        switch policy {
        case .off:  return L10n.t(.inboxPolicyOff, language: language)
        case .ask:  return L10n.t(.inboxPolicyAsk, language: language)
        case .auto: return L10n.t(.inboxPolicyAuto, language: language)
        }
    }
}

/// A completed delivery, described without naming anything in it.
public enum InboxReceiptPresentation {
    /// “3 files · 1.2 MB · 9 Aug 2026 at 14:05”.
    ///
    /// A count, a size and a time. Not a file name: this row sits in a window a
    /// user may well have open while screen-sharing, and the name is one click
    /// away behind Show in Finder, which is an explicit act.
    public static func summary(_ receipt: InboxReceipt,
                               language: AppLanguage? = nil) -> String {
        L10n.detail([
            L10n.plural(.inboxSavedFiles, receipt.fileCount, language: language),
            L10n.bytes(receipt.byteCount, language: language),
            L10n.date(receipt.savedAt, dateStyle: .medium, timeStyle: .short,
                      language: language),
        ], language: language)
    }

    /// The accessible name of one result's Show in Finder control.
    ///
    /// Every row's visible button reads "Show in Finder", which is right to look
    /// at and useless to hear — the same finding `AccountPresentation` fixed for
    /// device rows. The spoken name carries the row's own summary.
    public static func revealActionLabel(_ receipt: InboxReceipt,
                                         language: AppLanguage? = nil) -> String {
        L10n.detail([L10n.t(.inboxReveal, language: language),
                     summary(receipt, language: language)], language: language)
    }
}

/// The folder line in Settings.
public enum InboxFolderPresentation {
    /// The chosen folder's own name, or the sentence that says there is none.
    ///
    /// `lastPathComponent` rather than the whole path: the path contains the
    /// user's short name and, if they chose something inside a project, other
    /// people's names too. The full path is available to them in Finder, from a
    /// control they press.
    public static func description(_ folder: InboxFolderSummary,
                                   language: AppLanguage? = nil) -> String {
        if let url = folder.url {
            return L10n.token(url.lastPathComponent, language: language)
        }
        if let problem = folder.problem {
            return InboxStatusPresentation.text(for: .folder(problem), language: language)
        }
        return L10n.t(.inboxFolderNone, language: language)
    }
}

/// One refused user action.
public enum InboxSettingsErrorCopy {
    public static func message(_ error: InboxSettingsError,
                               language: AppLanguage? = nil) -> String {
        switch error {
        case .folderNotWritable:   return L10n.t(.inboxErrorNotWritable, language: language)
        case .folderBookmarkFailed: return L10n.t(.inboxErrorBookmark, language: language)
        case .noFolderChosen:      return L10n.t(.inboxErrorNoFolder, language: language)
        case .askResponseFailed:   return L10n.t(.inboxErrorAskFailed, language: language)
        }
    }
}

/// What a banner is allowed to say.
///
/// The whole type is counts and closed codes. There is no branch here that can
/// reach a file name, a path, an account email, a device id, a task id, a bearer
/// or key material, because `InboxNotification` carries none of them — which is
/// the point of that enum having exactly three cases.
public enum InboxNotificationPresentation {
    public static func title(_ notification: InboxNotification,
                             language: AppLanguage? = nil) -> String {
        switch notification {
        case .saved:
            return L10n.t(.inboxNotifyTitleSaved, language: language)
        case .attention, .failed:
            return L10n.t(.inboxNotifyTitleAttention, language: language)
        }
    }

    public static func body(_ notification: InboxNotification,
                            language: AppLanguage? = nil) -> String {
        switch notification {
        case .saved(let files):
            return L10n.plural(.inboxSavedFiles, files, language: language)
        case .attention(let attention):
            return InboxStatusPresentation.text(for: attention, language: language)
        case .failed(let failure):
            return InboxStatusPresentation.text(for: failure, language: language)
        }
    }
}
