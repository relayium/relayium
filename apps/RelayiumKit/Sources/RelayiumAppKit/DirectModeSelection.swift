import Foundation

/// Files or text, for the one Direct surface iOS has.
///
/// A pairing code does not encode what the sender meant to move, so somebody has
/// to say — and saying it twice would be two answers to one question. On macOS
/// that answer lives in `TransferPresence`, which also arbitrates which of two
/// destinations *renders* the running session. iOS has one Direct tab and no
/// nearby roster, so there is nothing to arbitrate and what is left is the
/// narrower question this type answers: which mode is showing, and when may it
/// change.
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
}
