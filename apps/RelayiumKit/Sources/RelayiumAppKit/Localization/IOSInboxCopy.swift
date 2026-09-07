import Foundation
@preconcurrency import RelayiumKit
import RelayiumShareKit

/// The Device Inbox's copy, for a platform with no folder picker, no window and
/// no background receive.
///
/// This is `ReceiveDestinationCopy`'s sibling, and it exists for exactly the
/// reason that one does: `InboxStatusPresentation` was written for a Mac, and a
/// handful of its sentences end by sending the user to a folder panel that does
/// not exist here, or describe a receiver that keeps working with the window
/// closed. Each of those is either impossible to act on or simply false on
/// iPhone and iPad.
///
/// | shared arm | what it says | why it does not hold here |
/// |---|---|---|
/// | `.folder(.accessDenied)` | *macOS refused access… Choose it again* | no panel, no grant to renew |
/// | `.folder(.unresolvable)` | *renamed, or on a disk that isn't connected* | it is inside the app |
/// | `.folder(.notWritable)` | *or choose another one* | there is no other one |
/// | `.delivery(.permissionDenied)` | *Choose the folder again* | as above |
/// | `.delivery(.directoryUnavailable)` | *Reconnect the disk* | as above |
/// | `.delivery(.nameConflict)` | *Open your receive folder* (Finder) | the route is the Files app |
/// | `.delivery(.decryptFailed)` | *this Mac's key* | this device's key |
/// | `recovery(for:)` | `.chooseFolder` | a control this platform cannot draw |
///
/// **What is deliberately NOT re-worded** is every sentence whose advice names
/// no picker and no window: all ten status lines, every ask, `diskFull`,
/// `downloadFailed`, `verifyFailed`, `userDeclined`, `unsupported`,
/// `internal`, and all four runtime failures. Those go to
/// `InboxStatusPresentation` byte for byte, in both languages, so the two
/// platforms cannot drift into explaining one rule two ways.
///
/// `.folder(.staleRefreshFailed)` is the one shared arm kept for a different
/// reason: it is **unreachable** here. `ContainerInboxFolderBookmarking` always
/// answers `isStale: false`, so `InboxReceiveFolder.open` never takes that
/// branch. Substituting copy for a state that cannot occur would be inventing a
/// sentence nobody can ever read, so it falls through.
public enum IOSInboxCopy {

    /// The Files-app route every delivery lands under — `Relayium/Received`,
    /// built from the same two constants the stored-link receive names.
    ///
    /// Read through `ReceiveDestinationCopy.Location` rather than assembled
    /// here: a Device Inbox delivery and a stored-link download write into the
    /// SAME directory, and two spellings of one route is how a user ends up
    /// looking for their files in a folder that does not exist.
    public static func receiveFolderRoute(language: AppLanguage? = nil) -> String {
        L10n.token(ReceiveDestinationCopy.Location.receiveFolder.path, language: language)
    }

    /// Where deliveries land, as the folder section's explanation.
    public static func folderExplanation(language: AppLanguage? = nil) -> String {
        L10n.t(.inboxIOSFolderExplain, [receiveFolderRoute(language: language)],
               language: language)
    }

    /// The status line, with the platform's own answers for the arms above.
    ///
    /// Delegates for every other state rather than re-switching over
    /// `InboxRuntimeState`. A second full switch here would be a second place
    /// for "Ready to receive" to be decided, and the failure that matters in
    /// this feature is a screen claiming readiness that the receiver does not
    /// have.
    public static func status(for state: InboxRuntimeState,
                              language: AppLanguage? = nil) -> String {
        switch state {
        case .attention(let attention):
            return text(for: attention, language: language)
        case .failed(let failure):
            return text(for: failure, language: language)
        // Every other state's sentence names no picker, no window and no
        // machine, so it is the shared one. Listed rather than defaulted: a new
        // state has to state whether its macOS wording survives here.
        case .signedOut, .loading, .disabled, .folderMissing, .ready, .asking,
             .paused, .working, .offline, .saved, .savedMessage:
            return InboxStatusPresentation.text(for: state, language: language)
        }
    }

    /// Why the inbox stopped, when it is not the folder and not the network.
    ///
    /// Three of the four name the machine, and `keyUnavailable` also tells the
    /// user to unlock their KEYCHAIN — a macOS action with no iOS equivalent, on
    /// the one screen where following it is the difference between receiving and
    /// not. `unknown` is the exception and stays shared: it says *this version*,
    /// which is true on both platforms.
    public static func text(for failure: InboxRuntimeFailure,
                            language: AppLanguage? = nil) -> String {
        switch failure {
        case .enrolmentRefused: return L10n.t(.inboxIOSFailedEnrolment, language: language)
        case .keyUnavailable:   return L10n.t(.inboxIOSFailedKey, language: language)
        case .identity:         return L10n.t(.inboxIOSFailedIdentity, language: language)
        case .unknown:
            return InboxStatusPresentation.text(for: failure, language: language)
        }
    }

    /// The blocker's own sentence.
    ///
    /// The seven substituted arms are listed by name and everything else
    /// delegates — including `.folder(.staleRefreshFailed)`, which is
    /// unreachable here. No `default` on either switch: a new folder problem or
    /// a new device error code has to state whether its macOS advice survives on
    /// this platform, rather than inheriting an answer that may send the user to
    /// a picker.
    public static func text(for attention: InboxAttention,
                            language: AppLanguage? = nil) -> String {
        switch attention {
        case .folder(let problem):
            switch problem {
            case .accessDenied:
                return L10n.t(.inboxIOSFolderAccessDenied, language: language)
            case .unresolvable:
                return L10n.t(.inboxIOSFolderUnresolvable, language: language)
            case .notWritable:
                return L10n.t(.inboxIOSFolderNotWritable, language: language)
            case .staleRefreshFailed:
                // **Unreachable here, and answered anyway.**
                // `ContainerInboxFolderBookmarking` always reports
                // `isStale: false`, so `InboxReceiveFolder.open` never takes
                // this branch. It is given the platform's own generic
                // folder sentence rather than the macOS one — which says
                // *Choose the folder again* — because "cannot happen" is a
                // property of today's composition, and a latent arm that would
                // send a user to a picker if it ever did happen is not worth
                // keeping for the sake of one fewer substitution.
                return L10n.t(.inboxIOSFolderAccessDenied, language: language)
            }
        case .delivery(let code):
            switch code {
            case .permissionDenied:
                return L10n.t(.inboxIOSBlockedPermission, language: language)
            case .directoryUnavailable:
                return L10n.t(.inboxIOSBlockedDirectory, language: language)
            case .nameConflict:
                return L10n.t(.inboxIOSBlockedNameConflict, language: language)
            case .decryptFailed:
                return L10n.t(.inboxIOSBlockedDecrypt, language: language)
            case .none, .internal:
                // The fail-closed arm, and it names the machine: *a reason this
                // Mac couldn't identify*. Substituted for the same reason the
                // others are, and it is the arm an unrecognised condition falls
                // into — so it is the one most likely to be the sentence a user
                // actually meets.
                return L10n.t(.inboxIOSBlockedInternal, language: language)
            // Listed rather than defaulted. Every one of these is about the
            // bytes or the sender, not about where they were going or which
            // machine they were going to, so its advice is true on both
            // platforms and a second copy could only drift from this one.
            case .diskFull, .downloadFailed, .verifyFailed, .userDeclined, .unsupported:
                return InboxStatusPresentation.text(for: attention, language: language)
            }
        }
    }

    /// What to offer next, or nothing.
    ///
    /// **`.chooseFolder` can never be returned**, and that is the whole of this
    /// method. The shared rule offers it for every folder problem and for two
    /// delivery codes, on the sound macOS reasoning that re-granting is the one
    /// repair that helps; here there is no grant, so the button would be a dead
    /// control on the exact screen a user is already stuck on.
    ///
    /// What replaces it is `.retry`, which is honest: the folder is the app's
    /// own directory and the conditions that break it — no space, something in
    /// the way, a container the system is briefly refusing — are the conditions
    /// a retry genuinely re-tests. `retryNow()` re-inspects the folder before it
    /// restarts, which is exactly the re-check a re-grant would have forced.
    public static func recovery(for state: InboxRuntimeState) -> InboxRecovery? {
        guard let shared = InboxStatusPresentation.recovery(for: state) else { return nil }
        return shared == .chooseFolder ? .retry : shared
    }

    /// The label for a recovery control. Delegates entirely: `.chooseFolder` is
    /// unreachable through `recovery(for:)` above, so no label here can name a
    /// picker.
    public static func label(for recovery: InboxRecovery,
                             language: AppLanguage? = nil) -> String {
        InboxStatusPresentation.label(for: recovery, language: language)
    }
}
