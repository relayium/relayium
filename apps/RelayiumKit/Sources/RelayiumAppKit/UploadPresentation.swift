import Foundation

/// What the "Link ready" screen says about the key that opens an upload.
///
/// One statement, chosen from what actually happened — never two. The two
/// possible facts contradict each other outright: either this Mac kept the key,
/// in which case the link on screen is reproducible from the Account tab, or it
/// did not, in which case that link is the only copy there will ever be. Saying
/// both, which is what a fixed line plus a conditional warning does, teaches the
/// user to believe neither.
public struct UploadKeyNotice: Equatable {
    public let text: String
    /// Whether this is the case the user has to act on now. The pane renders a
    /// warning with an icon rather than a grey footnote, because a footnote is
    /// exactly what someone closing a window does not read.
    public let isWarning: Bool

    public init(text: String, isWarning: Bool) {
        self.text = text
        self.isWarning = isWarning
    }
}

public enum UploadPresentation {
    /// Said when the key is safely on this Mac. It is the reassuring case and it
    /// is also the privacy claim: the key never reached Relayium, which is what
    /// makes the stored ciphertext unreadable to it.
    public static let keyKeptText = """
        The key is stored securely on this Mac and is never sent to Relayium's servers. \
        You can copy this link again from the Account tab.
        """

    /// `warning` is `UploadState.done`'s — non-nil exactly when the upload
    /// succeeded but this Mac could not keep the key.
    public static func keyNotice(warning: String?) -> UploadKeyNotice {
        guard let warning else {
            return UploadKeyNotice(text: keyKeptText, isWarning: false)
        }
        return UploadKeyNotice(text: warning, isWarning: true)
    }
}
