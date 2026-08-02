import Foundation

/// What a finished transfer offers the user: what to reveal, and what may be
/// dragged out to Finder or another app.
///
/// A view-model type rather than view code because "which URLs" is a decision
/// with a wrong answer. Dragging the individual files of a received folder out
/// would flatten the tree at the destination — the hierarchy the whole feature
/// exists for would be lost at the last step — so a foldered transfer offers its
/// root directory as the single drag item instead.
public struct ReceivedPayload: Equatable {
    /// Handed to `activateFileViewerSelecting`.
    public let revealURLs: [URL]
    /// Offered as drag sources, in order. Each is a complete, closed item.
    public let dragURLs: [URL]

    public init(revealURLs: [URL], dragURLs: [URL]) {
        self.revealURLs = revealURLs
        self.dragURLs = dragURLs
    }

    public var isEmpty: Bool { revealURLs.isEmpty && dragURLs.isEmpty }
}

/// Build the payload for a completed transfer.
///
/// `container` is non-nil when this transfer created its own directory (a
/// folder receive, or a multi-file cloud download). Then that directory IS the
/// result: revealing it selects one obvious thing, and dragging it moves the
/// whole tree in one piece.
///
/// Called ONLY after the writer's `finish()` has returned — that is what makes
/// these URLs complete and durable rather than a promise. Nothing builds a
/// payload from a transfer still in flight, and `files` being empty yields an
/// empty payload rather than a container the user could drag out half-written.
public func receivedPayload(files: [URL], container: URL?) -> ReceivedPayload {
    guard !files.isEmpty else { return ReceivedPayload(revealURLs: [], dragURLs: []) }
    if let container {
        return ReceivedPayload(revealURLs: [container], dragURLs: [container])
    }
    return ReceivedPayload(revealURLs: files, dragURLs: files)
}
