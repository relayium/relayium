import Foundation

/// Where a received transfer lands when the user never picks a folder.
///
/// macOS asks: `NSOpenPanel` returns a directory the user chose, and the
/// sandbox grants access to exactly that. iOS has no equivalent for a *default*
/// destination — a document picker per download would put a modal between the
/// user and every transfer — so the app owns one folder inside its own
/// container and publishes it to the Files app instead
/// (`UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace`).
///
/// That difference is why this exists as a seam rather than a line in a view.
/// The destination becomes FIXED, which turns "a name is already taken" from a
/// corner case into what happens the second time somebody opens the same link.
/// What meets it is not one blanket refusal: a single flat file whose name is
/// taken refuses, an opaque `relayium-<id>` container refuses rather than merge
/// into a box that should not already exist, and a received FOLDER steps aside
/// to `photos (2)` — because receiving a folder called `photos` twice is
/// ordinary. The invariant all three hold is the one that matters: nothing
/// already on disk is overwritten, merged into, or deleted.
///
/// Nothing here relaxes any of that. This resolves the PARENT directory and
/// hands it to `CloudDownloadModel.download(into:)`, which applies the same
/// rules on iOS as on macOS. What iOS does change is the COPY: the recovery
/// advice, wherever the shared wording sends the user to a folder picker that
/// does not exist here, and for an unsafe name the claim that they chose a
/// folder at all — see `ReceiveDestinationCopy` for the five cases and the three
/// it deliberately leaves shared.
public enum ReceiveDestination {

    /// The folder name inside `Documents`.
    ///
    /// Deliberately not localized, and it must stay that way. It is a path
    /// component the user sees in the Files app, but it is also the identity of
    /// everything already saved: a translated name would move the moment the
    /// user changed language, and every earlier download would be somewhere
    /// else under a name nothing looks for.
    // nonlocalized: on-disk directory name, must be stable across languages
    public static let folderName = "Received"

    /// The app's own `Documents`, from `FileManager` rather than a constructed
    /// path.
    ///
    /// Inside the iOS sandbox this is the app container's `Documents` — the one
    /// directory `UIFileSharingEnabled` exposes. It is asked for rather than
    /// assembled because the container path is assigned by the OS and changes
    /// between installs and OS versions; anything hard-coded is wrong on the
    /// next launch.
    public static func documentsDirectory(_ fileManager: FileManager = .default) throws -> URL {
        try fileManager.url(for: .documentDirectory, in: .userDomainMask,
                            appropriateFor: nil, create: true)
    }

    /// The received-files directory, created if it is not there yet.
    ///
    /// Split from `documentsDirectory` so the rule is testable without an iOS
    /// container: a test passes its own temporary directory and gets the same
    /// behaviour the app gets.
    ///
    /// Idempotent — `withIntermediateDirectories: true` accepts a directory
    /// that already exists, which is the normal case from the second download
    /// onwards. What it does NOT accept is something that is not a directory
    /// sitting at that name, and that is reported as a refusal rather than
    /// repaired: whatever is there belongs to the user, and this is not the
    /// code that gets to decide it is disposable.
    public static func directory(inDocuments documents: URL,
                                 fileManager: FileManager = .default) throws -> URL {
        let url = documents.appendingPathComponent(folderName, isDirectory: true)
        var isDirectory: ObjCBool = false
        if fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory) {
            guard isDirectory.boolValue else {
                throw DownloadDestinationError.fileExists(name: folderName)
            }
            return url
        }
        try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// The whole lookup, as the app performs it.
    public static func directory(_ fileManager: FileManager = .default) throws -> URL {
        try directory(inDocuments: documentsDirectory(fileManager), fileManager: fileManager)
    }
}
