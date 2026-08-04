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

    public init(file: RealtimeSessionModel, text: RealtimeTextSessionModel) {
        self.file = file
        self.text = text
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
        if ended { interruption = L10n.t(.directInterrupted) }
    }

    public func dismissInterruption() { interruption = nil }

    /// Called as a new session begins, so the notice cannot sit above a session
    /// it is not about.
    public func sessionStarting() { interruption = nil }
}
