import Foundation

/// Files or text, for the one Direct surface iOS has.
///
/// Neither a pairing code nor a roster entry encodes what the sender meant to
/// move, so somebody has to say — and saying it twice would be two answers to
/// one question. On macOS that answer lives in `TransferPresence`, alongside the
/// arbitration of which destination *renders* the running session.
///
/// iOS keeps the two apart, and R3-F is where that stopped being incidental: it
/// gained a second direct surface, so it needs the arbitration too, and it takes
/// it from the same `TransferPresence` — through the `claim(_:)` overload that
/// answers ownership only. The mode stays here, because this is where the R3-E
/// lock lives, and a second copy of the answer over there would be free to
/// disagree with it.
///
/// **The lock is derived, never cached.** `isLocked` takes the two model states
/// and is asked again on every read, because a stored flag would be a second
/// answer to a question `RealtimeSessionModel` and `RealtimeTextSessionModel`
/// already answer exactly — free to drift, and the drift is a segmented control
/// that lets the user switch away from a running transfer. That neither stops it
/// nor shows it; it leaves a live session and its Cancel button on a screen
/// nobody is looking at.
///
/// The two *terminal* states lock it too, which is the part worth stating out
/// loud. A `.completed` receive still owns its result and its share sheet, and a
/// text session's `.ended` still owns the transcript that exists nowhere else.
/// Both are things the user has not finished with, so the mode stays where they
/// are until they clear the session themselves.
@MainActor
public final class DirectModeSelection: ObservableObject {
    @Published public private(set) var mode: TransferMode

    public init(mode: TransferMode = .files) {
        self.mode = mode
    }

    /// True while either model owns a session — live or terminal-and-retained.
    ///
    /// Written as "not idle" rather than as a list of the states that lock,
    /// deliberately: a new state added to either enum locks the picker by
    /// default, which is the safe direction. Opting one back out is then an
    /// explicit edit here rather than an omission somewhere else.
    public static func isLocked(file: RealtimeState, text: RealtimeTextState) -> Bool {
        file != .idle || text != .idle
    }

    /// The only way the mode changes.
    ///
    /// It re-reads the two states rather than trusting a flag, because a
    /// `.disabled` modifier is a courtesy and not the mechanism: SwiftUI still
    /// owns the binding behind a disabled control, and a rebuilt view, a
    /// restored scene or a future deep link can all write one.
    public func select(_ mode: TransferMode, file: RealtimeState, text: RealtimeTextState) {
        guard !Self.isLocked(file: file, text: text) else { return }
        self.mode = mode
    }

    /// A session nobody chose a mode for.
    ///
    /// Unconditional, and that is not a hole in the lock — it is what the lock
    /// is for. `select` protects the *user's* choice from moving under a session
    /// they started. An unsolicited nearby offer is the opposite case: there is
    /// no user choice to protect, the session's kind is a fact on the wire, and
    /// the alternative is a file transfer arriving while the picker sits on Text
    /// and rendering nothing at all — with the picker by then locked, because a
    /// model is busy.
    ///
    /// Called synchronously as the offer is admitted, before the responder is
    /// built. See `AppRouting.claimIncoming`, which is the only caller and keeps
    /// this write beside the two that must happen with it.
    public func adopt(forIncoming kind: NearbyReceiveKind) {
        mode = (kind == .text) ? .text : .files
    }
}
