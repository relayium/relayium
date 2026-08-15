import Foundation
import RelayiumShareKit

/// The three states a scene can be in, as this layer needs them.
///
/// A retyping of SwiftUI's `ScenePhase`, and the retyping is the point: the
/// decision below has to be reachable from `swift test`, and `ScenePhase` is a
/// SwiftUI type this package does not import. The app maps one to the other in a
/// single expression, which `IOSSurfaceGuardTests` pins — because the mapping is
/// exactly where this gets got wrong.
public enum AppLifecyclePhase: Equatable, Sendable {
    case active
    /// **Not** "leaving". A document picker, a share sheet, a `PhotosPicker`,
    /// Control Centre, an incoming call banner and the app switcher all produce
    /// this, and the app is still on screen and still connected in every one of
    /// them.
    case inactive
    case background
}

/// Foreground-only, enforced rather than only claimed by the copy.
///
/// This app declares no `UIBackgroundModes` and uses no background
/// `URLSession`, which is a deliberate deferral rather than an oversight — both
/// would be capabilities claimed for a feature that does not exist. The
/// consequence is that a direct session cannot survive the app being sent to the
/// background: the DataChannel goes with the process's foreground time, and what
/// the user returns to is a progress bar that has not moved and a peer that gave
/// up minutes ago. Owning that consequence means ending the session and saying
/// why, rather than letting it be discovered.
///
/// **`.inactive` is not `.background`,** and treating them alike is the defect
/// this type exists to make impossible. `.inactive` is what the system reports
/// while the file importer is up — which is to say, at the exact moment the user
/// is choosing the files they are about to send. An implementation that
/// cancelled there would cancel the session the user is in the middle of
/// setting up, every time, and would look like the picker being broken.
///
/// **Only a LIVE session is ended.** `isBusy` is false for a `.completed`
/// receive and for a text session that already reached a terminal state, and
/// both of those own something the user has not finished with: the received
/// files plus the share sheet built on them, and a transcript that exists in no
/// other copy. Cancelling a completed receive would run `writer.discard()` over
/// files the user has already been shown.
///
/// ## And it is the SINGLE owner of ending an open `link/1`
///
/// The unified link is subject to exactly the same physics as the two legacy
/// models — its lanes are an SCTP association on a `RTCPeerConnection` that goes
/// with the process's foreground time, and this app declares no
/// `UIBackgroundModes` — so it cannot survive backgrounding either. What is
/// different is how many places could plausibly end it, and that is why the
/// ownership is stated here rather than left to emerge:
///
///  - `NearbyResidencyCoordinator` stops the room on `.background`, and stopping
///    the room does **not** end an open link (`LinkWorkspaceModel` invariant 2 —
///    a healthy data channel survives signalling loss, and the model publishes
///    `signalingLost` instead of tearing down). So residency must not be the
///    thing that ends it either, and it is not: it hands `.background` on to
///    this object, after leaving the room, exactly as it already did for the two
///    legacy models.
///  - No view ends it on disappearance. `NearbyLinkWorkspaceView` is inside a
///    `TabView` that SwiftUI may tear down for a tab switch, and a link ended by
///    that would be a link ended by the user checking their plan.
///
/// One owner, one transition, one sentence. A second one would end the link
/// twice — harmless, `leave()` is idempotent — and, much worse, would report it
/// twice or report it from a place that could not say what happened.
///
/// **`.inactive` still does nothing here, and for the link it matters more, not
/// less.** The link's own file verbs open a document picker mid-session, which
/// is precisely `.inactive`. An implementation that ended the link there would
/// kill the connection at the moment the user is choosing what to send on it —
/// the exact defect this type was created for, on the one surface where choosing
/// happens *after* connecting.
@MainActor
public final class ForegroundSessionCoordinator: ObservableObject {

    /// The sentence explaining a session this object ended, or nil.
    ///
    /// It has to outlive the transition that caused it — the only moment anybody
    /// can read it is after the app is back on screen — so nothing clears it on
    /// `.active`. It goes when the user dismisses it, or when another session
    /// starts and it stops describing anything on screen.
    @Published public private(set) var interruption: String?

    private let file: RealtimeSessionModel
    private let text: RealtimeTextSessionModel
    /// The unified link, or nil where there is none to own.
    ///
    /// Deliberately **not defaulted**. A default would let a future composition
    /// build a link and forget to hand it over, and the failure would be silent:
    /// the app backgrounds, the room is left, the link keeps a connection that
    /// died with the foreground, and the user returns to a workspace that looks
    /// open. Writing `link: nil` is a decision; omitting the argument is an
    /// oversight, and the two must not look the same at the call site.
    private let link: LinkWorkspaceModel?

    public init(file: RealtimeSessionModel,
                text: RealtimeTextSessionModel,
                link: LinkWorkspaceModel?) {
        self.file = file
        self.text = text
        self.link = link
    }

    public func phaseChanged(to phase: AppLifecyclePhase) {
        guard phase == .background else { return }
        var ended = false
        if file.isBusy {
            // `cancel()`, not a bare state reset: a partly received file is
            // debris under a name the manifest chose, and the Files app would
            // show it beside the complete ones with nothing marking it short.
            file.cancel()
            ended = true
        }
        if text.isBusy {
            // `end()`, which closes the connection and keeps `history`. The
            // messages are already decrypted and already on screen, and this
            // model keeps no server-side copy by design — taking them away
            // because the app was backgrounded destroys the only one there is.
            text.end()
            ended = true
        }
        let endedALink = endLinkIfLive()
        if endedALink { ended = true }
        // The link's own sentence only when THIS transition took a link away.
        // Read from what was ended rather than from the link's current state: a
        // link that had already finished before the app was backgrounded leaves
        // `connection` at `.ended` too, and a legacy session interrupted on the
        // same launch would then be described as a lost conversation.
        if ended { interruption = L10n.t(endedALink ? .linkInterrupted : .directInterrupted) }
    }

    /// End an open or establishing link, and answer whether anything was ended.
    ///
    /// **`connection.isActive`, not `isOpen`.** An attempt that is `requesting`
    /// or `establishing` is a handshake with deadlines running against a peer
    /// that is answering, and leaving it to be resumed later would leave the peer
    /// waiting on an establishment this process cannot finish. `watching` is
    /// included by the same predicate and is unreachable on this platform — iOS
    /// composes no pairing-code link — which is why this asks the model's own
    /// question rather than enumerating states here.
    ///
    /// **A terminal link is deliberately left alone**, exactly as a `.completed`
    /// receive is: `isActive` is false for `.ended`, and that state is holding a
    /// transcript, a committed batch's saved paths and the reason it finished.
    /// `dismiss()` is the user's to press.
    ///
    /// `leave()` is idempotent, so the guard is about the interruption NOTICE
    /// rather than about safety: reporting an interruption for a link that had
    /// already ended would be the app claiming to have taken something away that
    /// the user had already been told about.
    /// The sentence it produces is `.linkInterrupted` rather than the shipped
    /// `.directInterrupted`, because the two describe different losses. The
    /// shipped one names a *direct session* and a partly received file that was
    /// removed. A link that ends takes the conversation with it as well, and this
    /// app keeps no copy of that anywhere — no server-side history by design — so
    /// "the direct session ended" would be accurate about the mechanism and
    /// misleading about what is gone.
    private func endLinkIfLive() -> Bool {
        guard let link, link.connection.isActive else { return false }
        link.leave()
        return true
    }

    public func dismissInterruption() { interruption = nil }

    /// Called as a new session begins, so the notice cannot sit above a session
    /// it is not about.
    public func sessionStarting() { interruption = nil }
}
