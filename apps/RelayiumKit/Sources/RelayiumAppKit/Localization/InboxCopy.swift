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
        case .savedMessage:
            return L10n.t(.inboxSavedMessage, language: language)
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
        case .signedOut, .loading, .disabled, .ready, .working, .saved, .savedMessage:
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

/// A completed delivery, described by what actually arrived.
///
/// ## What changed, and why the old rule was the wrong rule
///
/// This used to render a COUNT — "1 file saved · 12 KB · 9 Aug 2026 at 14:05" —
/// on the reasoning that a file name is the user's own content and the window
/// might be on a shared screen. That reasoning is correct about a NOTIFICATION,
/// which macOS draws on a locked screen without being asked, and
/// `inbox.savedFiles` still serves exactly that and still names nothing.
///
/// It was the wrong rule for this list. Recently received is a list a person
/// opened, on their own Mac, to answer one question: *what arrived?* Answered
/// with a count it cannot distinguish two deliveries from each other, so three
/// rows reading "1 file saved" beside three identical buttons was a list with no
/// information in it — the user had to open Finder to learn what the list was
/// for. The name is theirs, they are looking at it deliberately, and withholding
/// it protected nothing that the folder one click away did not already reveal.
public enum InboxReceiptPresentation {
    /// How many names a row prints before it stops.
    ///
    /// Three, because the row is one line in a grouped `Form` beside a size and
    /// a date, and a delivery of forty files would otherwise set a paragraph.
    /// The remainder is counted rather than dropped: a row that silently
    /// truncated would be a list that under-reports what landed on the disk.
    static let namedFileLimit = 3

    /// “brief.txt · notes.md · 1.2 MB · 9 Aug 2026 at 14:05”.
    ///
    /// The names, then the size, then the time — what arrived, how much of it,
    /// and when, in the order a person asks.
    public static func summary(_ receipt: InboxReceipt,
                               language: AppLanguage? = nil) -> String {
        L10n.detail(names(receipt, language: language) + [
            L10n.bytes(receipt.byteCount, language: language),
            L10n.date(receipt.savedAt, dateStyle: .medium, timeStyle: .short,
                      language: language),
        ], language: language)
    }

    /// The file names this row prints, with the overflow counted.
    ///
    /// Each name is a `L10n.token`, which is not decoration: a file name dropped
    /// into an Arabic row is laid out against the surrounding right-to-left text
    /// by the bidi algorithm, which can move a leading `../` or an extension to
    /// the far end of the name. The isolate makes the run resolve on its own.
    ///
    /// A receipt with no committed paths cannot exist — `InboxReceipt.make`
    /// fails closed on an empty committed list — but the count is still the
    /// honest fallback rather than an empty row if one ever did.
    static func names(_ receipt: InboxReceipt,
                      language: AppLanguage? = nil) -> [String] {
        guard receipt.kind != .message else {
            // A message has no name to print and its TEXT is not printed here.
            // The row says what arrived; reading it is a deliberate act in a
            // surface the user opened, not something a list does on their behalf
            // in a window that may be on a shared screen.
            return [L10n.t(.inboxSavedMessage, language: language)]
        }
        let all = receipt.urls.map(\.lastPathComponent)
        guard !all.isEmpty else {
            return [L10n.plural(.inboxSavedFiles, receipt.fileCount, language: language)]
        }
        let shown = all.prefix(namedFileLimit).map { L10n.token($0, language: language) }
        guard all.count > namedFileLimit else { return shown }
        return shown + [L10n.t(.inboxMoreFiles,
                               [L10n.number(all.count - namedFileLimit, language: language)],
                               language: language)]
    }

    /// The accessible name of the section's ONE Show in Finder control.
    ///
    /// Visible, every Finder button in this app reads "Show in Finder", which is
    /// right to look at and useless to hear — the finding `AccountPresentation`
    /// fixed for device rows. This one is spoken with the folder it opens,
    /// because that is the fact that distinguishes it from every other Finder
    /// action in the window.
    public static func revealFolderLabel(_ folder: InboxFolderSummary,
                                         language: AppLanguage? = nil) -> String {
        L10n.t(.inboxRevealFolderAction,
               [InboxFolderPresentation.description(folder, language: language)],
               language: language)
    }

    /// The accessible name of the MENU BAR's single Reveal item.
    ///
    /// **The one place a per-receipt Finder action survives, and it is not an
    /// oversight.** The Recently received list dropped its per-row buttons
    /// because every one of them opened the same folder beside rows that named
    /// nothing. The menu bar is the opposite situation: it offers exactly one
    /// item, for the newest delivery only (`InboxController.latestResult`), and
    /// it is read out of a menu with no surrounding list to give it context. So
    /// it keeps naming the delivery it acts on.
    public static func revealActionLabel(_ receipt: InboxReceipt,
                                         language: AppLanguage? = nil) -> String {
        L10n.detail([L10n.t(.inboxReveal, language: language),
                     summary(receipt, language: language)], language: language)
    }
}

/// The received-messages section: what its rows say ABOUT a message, never the
/// message.
///
/// **The body is not in this file, and that is the design.** Everything here is
/// a heading, a timestamp or a control name — the row's own text comes straight
/// off `InboxMessage.text` at the view, unformatted, untruncated and
/// unsummarised. A presentation helper that took the body would be a place for a
/// preview to be built, and a preview is the one thing a message must not have:
/// `InboxNotificationPresentation` above is deliberately unable to name one.
///
/// The split also keeps the two audiences apart. A banner macOS draws on a
/// locked screen says only that a message arrived; this section is a list
/// somebody opened their own Mac to read, so it shows the whole thing.
public enum InboxMessagePresentation {
    /// How many rows the section draws before it starts counting instead.
    ///
    /// A bound on the SECTION, not on the store. Nothing is deleted and nothing
    /// is hidden without being counted — `InboxMessageStore.all()` still returns
    /// every message, and `more` below states how many are held beyond these.
    /// The number is small because each row renders a body up to 64 KiB inside a
    /// `Form`, and a list that renders everything at once would make a Mac that
    /// has received a thousand messages unusable at the moment it is opened.
    public static let displayLimit = 20

    public static func heading(language: AppLanguage? = nil) -> String {
        L10n.t(.inboxMessagesHeading, language: language)
    }

    public static func explanation(language: AppLanguage? = nil) -> String {
        L10n.t(.inboxMessagesExplain, language: language)
    }

    /// When this Mac committed the message. The same shape the receipt rows use,
    /// so two lists in one window do not format one fact two ways.
    public static func receivedAt(_ message: InboxMessage,
                                  language: AppLanguage? = nil) -> String {
        L10n.date(message.receivedAt, dateStyle: .medium, timeStyle: .short,
                  language: language)
    }

    /// The messages this section draws, newest first.
    ///
    /// The order is the store's and is asserted rather than assumed: a reader
    /// looking for what just arrived looks at the top, and `InboxMessageStore`
    /// breaks a same-second tie on id so the list cannot reshuffle between two
    /// reads of an unchanged directory.
    public static func shown(_ messages: [InboxMessage]) -> [InboxMessage] {
        Array(messages.prefix(displayLimit))
    }

    /// "+7 more", or nil when everything this account holds is on screen.
    public static func more(_ messages: [InboxMessage],
                            language: AppLanguage? = nil) -> String? {
        let hidden = messages.count - displayLimit
        guard hidden > 0 else { return nil }
        return L10n.t(.inboxMoreMessages, [L10n.number(hidden, language: language)],
                      language: language)
    }

    /// The accessible name of one row's Copy control.
    ///
    /// Visible, the button is the compact Copy/Copied pair every other copy
    /// control in this app uses. Spoken, that is not enough: this pane contains a
    /// column of them, one per message, and "Copy" repeated twenty times names
    /// nothing. `text.copyReceivedMessage` is the existing sentence for exactly
    /// this — a received message's copy action — and it is reused rather than
    /// re-translated.
    public static func copyActionLabel(copied: Bool,
                                       language: AppLanguage? = nil) -> String {
        copied
            ? L10n.detail([L10n.t(.commonCopied, language: language),
                           L10n.t(.textReceived, language: language)], language: language)
            : L10n.t(.textCopyReceivedMessage, language: language)
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
        case .notificationSettingsUnavailable:
            return L10n.t(.inboxErrorNotificationSettings, language: language)
        }
    }
}

/// What a person is told when macOS will not show a banner, and what they are
/// offered about it.
public struct InboxNotificationNotice: Equatable, Sendable {
    /// What is actually true right now.
    public let title: String
    /// **The half that stops this being alarming.** Banners are off; receiving is
    /// not. A warning that said only the first would tell a user their Device
    /// Inbox is broken when every file sent to this Mac is still landing in their
    /// folder, and the likeliest response to that is to stop using the feature.
    public let explanation: String
    /// The route out.
    public let actionLabel: String

    public init(title: String, explanation: String, actionLabel: String) {
        self.title = title
        self.explanation = explanation
        self.actionLabel = actionLabel
    }
}

/// Whether the banner permission is worth saying anything about, and what.
///
/// One entry point returning an optional rather than three parallel functions:
/// the three strings are only ever rendered together, and a caller that could ask
/// for the title without asking whether there is anything to report is a caller
/// that can put a warning on a Mac whose notifications work.
public enum InboxNotificationPermissionPresentation {
    public static func notice(for permission: InboxNotificationPermission,
                              language: AppLanguage? = nil) -> InboxNotificationNotice? {
        switch permission {
        case .unmeasured, .notDetermined, .allowed:
            // Nothing to report, and three different reasons for it: nothing has
            // asked yet, macOS has not been asked yet, and macOS said yes. None
            // of them is a problem the user can or should act on.
            return nil
        case .denied:
            return InboxNotificationNotice(
                title: L10n.t(.inboxBannersBlocked, language: language),
                explanation: L10n.t(.inboxBannersBlockedBody, language: language),
                actionLabel: L10n.t(.inboxOpenNotificationSettings, language: language))
        }
    }
}

/// What a banner is allowed to say.
///
/// The whole type is counts and closed codes. There is no branch here that can
/// reach a file name, a path, an account email, a device id, a task id, a bearer
/// or key material, because `InboxNotification` carries none of them — which is
/// the point of that enum's four cases carrying, between them, one count and two
/// closed codes. `savedMessage`, the case a preview would belong to, carries
/// nothing at all.
///
/// Neither half interpolates. Every arm returns a catalog lookup or delegates to
/// another closed-code renderer, so there is no `\(…)` anywhere in this type for
/// a value to enter through — asserted as text by `InboxSurfaceGuardTests`.
public enum InboxNotificationPresentation {
    public static func title(_ notification: InboxNotification,
                             language: AppLanguage? = nil) -> String {
        switch notification {
        case .saved:
            return L10n.t(.inboxNotifyTitleSaved, language: language)
        case .savedMessage:
            // The same sentence the menu bar and the receipt row use, because
            // there is exactly one true thing to say about a message on a locked
            // screen and all three surfaces have to say it identically.
            return L10n.t(.inboxSavedMessage, language: language)
        case .attention, .failed:
            return L10n.t(.inboxNotifyTitleAttention, language: language)
        }
    }

    public static func body(_ notification: InboxNotification,
                            language: AppLanguage? = nil) -> String {
        switch notification {
        case .saved(let files):
            return L10n.plural(.inboxSavedFiles, files, language: language)
        case .savedMessage:
            // Where to read it, and nothing about it. The `saved` arm above
            // renders a COUNT because a count is a fact about files that costs a
            // passer-by nothing; a message has no such fact — not its length, not
            // its sender, not its first words — so this half spends itself on the
            // route instead. `savedMessage` carries no associated value, so there
            // is nothing here a call site could substitute in.
            return L10n.t(.inboxNotifyBodyMessage, language: language)
        case .attention(let attention):
            return InboxStatusPresentation.text(for: attention, language: language)
        case .failed(let failure):
            return InboxStatusPresentation.text(for: failure, language: language)
        }
    }
}
