import Foundation

/// Being reachable, in the order it has to happen in.
///
/// ## Why this is an object rather than three modifiers
///
/// Joining the code-less room is what advertises this device as reachable: from
/// that instant any peer on the same observed public address can dial it and the
/// listener will answer without asking. Three things therefore have to be true
/// *before* the socket opens, and they are all orderings — which is exactly what
/// a `.task` and two `.onChange`s in a scene body cannot express and no test can
/// reach.
///
///  1. **The receive folder exists and the model knows about it.**
///     `RealtimeSessionModel.saveDirectory` defaults to Downloads, which inside
///     an iOS container is a directory nobody has. Joining first means a peer
///     that dials immediately gets a session that handshakes, accepts a manifest
///     and only then discovers it has nowhere to write — with the sender already
///     transmitting. If the folder cannot be resolved, the room is not joined at
///     all: unreachable is a state the user can be told about and retry;
///     reachable-and-unable-to-write is one they find out about afterwards.
///  2. **Leaving the room happens before the session cleanup.** This app claims
///     no background mode, so `.background` ends live sessions
///     (`ForegroundSessionCoordinator`). Ending them while still in the room
///     leaves a window in which this device is listed, is dialable, and cannot
///     answer.
///  3. **`.inactive` does nothing at all.** A document picker, a share sheet and
///     the app switcher all produce it, which is to say it is produced at the
///     moment the user is choosing what to send. Not "the session survives" —
///     *nothing happens*, down to not touching the filesystem.
///
/// ## What it deliberately does not own
///
/// Whether the user has paused. `LanDiscoveryModel` already holds that, sticky
/// across a stop and a restart, and a second flag here would be free to disagree
/// with the model that actually decides whether a socket opens. `isPaused`
/// forwards rather than caches.
@MainActor
public final class NearbyResidencyCoordinator: ObservableObject {

    /// Why this device is not listening, or nil. Retryable by construction: the
    /// only thing that can produce it is something in the user's own Files app
    /// occupying the name `Received`, which this code may not tidy away.
    @Published public private(set) var destinationError: String?

    private let discovery: LanDiscoveryModel
    private let fileModel: RealtimeSessionModel
    private let foreground: ForegroundSessionCoordinator
    private let resolveDestination: () throws -> URL

    /// `resolveDestination` is injected because the failure that matters cannot
    /// be staged against the real one: it needs a non-directory sitting at
    /// `Documents/Received` inside an iOS container.
    public init(discovery: LanDiscoveryModel,
                fileModel: RealtimeSessionModel,
                foreground: ForegroundSessionCoordinator,
                resolveDestination: @escaping () throws -> URL = {
                    try ReceiveDestination.directory()
                }) {
        self.discovery = discovery
        self.fileModel = fileModel
        self.foreground = foreground
        self.resolveDestination = resolveDestination
    }

    /// Forwarded, never cached. The model's pause is what decides whether a
    /// socket opens, so it is also what the UI must be reading.
    public var isPaused: Bool { discovery.isPaused }

    // MARK: - lifecycle

    public func phaseChanged(to phase: AppLifecyclePhase) {
        switch phase {
        case .active:
            // `startResident` is idempotent and refuses to override a pause, so
            // returning to the foreground repeatedly cannot open a second room
            // or undo a decision the user made.
            join()
        case .inactive:
            // Nothing. See the type comment: this is the picker, and the app is
            // still on screen and still connected.
            break
        case .background:
            // The room first, and only then the sessions. Reversing these two
            // lines leaves this device listed and dialable with its transfer
            // already torn down.
            discovery.stop()
            foreground.phaseChanged(to: .background)
        }
    }

    // MARK: - the user's own controls

    /// Try again after a destination failure. The cause lives in the Files app,
    /// so the app cannot fix it and must not make the user relaunch.
    public func retry() { join() }

    /// Look again — the explicit "I want to see the roster now" act.
    ///
    /// It clears a pause, exactly as the macOS pane's button does: a user who
    /// asks to see devices is asking to be in the room, and a pause the user
    /// can only leave through one specific control is a trap. That is also what
    /// keeps a paused receiver able to *send*, since sending reaches through the
    /// same socket.
    public func refresh() {
        guard installDestination() else { return }
        discovery.start()
    }

    /// Stop listening. Sticky in the model, so it survives a background/restore
    /// cycle and every idempotent `startResident` in between.
    public func pause() { discovery.pause() }

    /// Start listening again — with the destination re-checked first, because
    /// resuming is the moment this device becomes dialable again.
    public func resume() {
        guard installDestination() else { return }
        discovery.resume()
        // Covers the case where residency was never established at all — a
        // pause taken before the first `.active`, which `resume` alone would
        // leave `.off`.
        discovery.startResident()
    }

    // MARK: - the order

    private func join() {
        guard installDestination() else { return }
        discovery.startResident()
    }

    /// Resolve the receive folder and hand it to the model. Returns whether the
    /// caller may go on to advertise this device.
    ///
    /// Run on every join rather than once: it is idempotent, it costs one
    /// `createDirectory`, and it recreates a folder the user deleted from the
    /// Files app between two foregrounds — which is a thing they can do and
    /// which would otherwise fail the next incoming transfer instead.
    private func installDestination() -> Bool {
        do {
            fileModel.saveDirectory = try resolveDestination()
            destinationError = nil
            return true
        } catch {
            // `.appFolder`, not the receive folder: the only failure this can
            // see is something occupying the name `Received`, which puts it
            // BESIDE the receive folder rather than inside it.
            destinationError = ReceiveDestinationCopy.message(for: error, in: .appFolder)
            return false
        }
    }
}
