import Foundation
import RelayiumShareKit

/// The copy for a destination the user did not choose and cannot change.
///
/// `ErrorCopy` was written for macOS, where the destination came from an
/// `NSOpenPanel`. That single fact runs through five of its
/// `DownloadDestinationError` arms: four end by sending the user back to the
/// picker, and two of those also speak of *the folder you chose*. On iOS (R3-A)
/// the app receives into `Documents/Received`, there is no picker, and nobody
/// chose anything — so each of those sentences is either impossible to act on,
/// or simply false:
///
/// | case | what the shared copy says | why it does not hold on iOS |
/// |---|---|---|
/// | `fileExists` | *Choose another folder* | there is no second folder to choose |
/// | `directoryExists` | *Choose another folder* | as above |
/// | `unsafeName` | written *outside the folder you chose* | the user chose no folder |
/// | `systemError(EACCES/EPERM)` | *Choose another folder* | the folder is the app's own and fixed |
/// | `systemError(other)` | *Try another folder* | as above |
///
/// Each of the five is answered here with the same failure and the same reason,
/// and a recovery that exists on this platform: for the two collisions, the item
/// in the way can be renamed or removed in the Files app and the download
/// retried; for the two write failures, there is nothing to rearrange, so the
/// honest advice is retry and — if it persists — report it, with the errno kept
/// because it is the only diagnosable part; for an unsafe name, nothing about
/// the destination is relevant at all and the sender is the only fix.
///
/// What is deliberately NOT re-worded is everything whose advice does not
/// mention a folder the user picks: `systemError(ENOSPC)` (*free up space*),
/// `incomplete` and `exceedsManifest` (*ask the sender to try again*). Those go
/// to `ErrorCopy` byte for byte, as does every non-destination error, so the two
/// platforms cannot drift into explaining one rule two ways.
///
/// The success sentence lives here too (`savedLocation`), for the same reason
/// the failures do: it names the same fixed destination, and it has to name all
/// of it.
public enum ReceiveDestinationCopy {

    /// What the Files app calls the app's own container.
    ///
    /// Not a path this code ever writes to — it is the label the user navigates
    /// by, which is the app's display name, which is the brand.
    // nonlocalized: brand name, as the Files app labels the app's container
    public static let filesAppFolder = "Relayium"

    /// Which folder a failure is about, in the Files app.
    ///
    /// Two, because the two ways a receive can collide happen one level apart
    /// and telling the user the wrong one sends them somewhere the item is not.
    public enum Location {
        /// `Relayium` — where `ReceiveDestination.directory(inDocuments:)`
        /// collides, because the item in the way is occupying the name of the
        /// receive folder itself and therefore sits beside it, not inside it.
        case appFolder
        /// `Relayium/Received` — where `CloudDownloadModel.download(into:)`
        /// collides and where every write happens, because that is the parent
        /// every received file, container and folder is written into. Which is
        /// why it is also the folder the write failures name.
        case receiveFolder

        var path: String {
            switch self {
            case .appFolder:
                return filesAppFolder
            case .receiveFolder:
                // Slash-joined rather than a URL: this is a route through a
                // file browser shown to a person, not a path anything opens.
                return filesAppFolder + "/" + ReceiveDestination.folderName
            }
        }
    }

    /// Where the payload is, once it is there.
    ///
    /// The done state's sentence comes from here rather than from `L10n`
    /// directly for one reason: the route it names has to be the SAME route the
    /// failures name, built from the same two constants. Written out in the
    /// catalogs it was free to stop one level short — at `Relayium`, the app's
    /// own folder in Files — and send the user looking for their files in the
    /// folder that merely contains the folder they are in. `Received` is a real
    /// step in the Files app, not an implementation detail.
    ///
    /// `.receiveFolder` and not `.appFolder`, and not a third case: every byte a
    /// receive writes lands under `Relayium/Received`, which is exactly what
    /// `Location.receiveFolder` already means for the write failures.
    ///
    /// Interpolated through `L10n.token` for the same reason every value in
    /// `message(for:)` is — under Arabic the route is one unit, rather than
    /// three fragments the bidi algorithm is free to lay out in an order that
    /// is not the order of the folders.
    public static func savedLocation(language: AppLanguage? = nil) -> String {
        L10n.t(.downloadSavedLocation,
               [L10n.token(Location.receiveFolder.path, language: language)],
               language: language)
    }

    /// The message `ReceiveView` shows, for any error a receive can produce.
    ///
    /// Every interpolated value goes through `L10n.token`: a colliding or unsafe
    /// name is the user's own — or a sender's, which is worse — and the folder
    /// path and the errno are technical, so Arabic must lay each out as one unit
    /// instead of letting the bidi algorithm rearrange it around the sentence.
    /// Nothing raw reaches the screen.
    public static func message(for error: Error,
                               in location: Location = .receiveFolder,
                               language: AppLanguage? = nil) -> String {
        guard let destination = error as? DownloadDestinationError else {
            return ErrorCopy.message(for: error, language: language)
        }
        let folder = L10n.token(location.path, language: language)
        switch destination {
        case .fileExists(let name):
            return L10n.t(.errorDestinationFileExistsFilesApp,
                          [L10n.token(name, language: language), folder],
                          language: language)
        case .directoryExists(let name):
            return L10n.t(.errorDestinationDirectoryExistsFilesApp,
                          [L10n.token(name, language: language), folder],
                          language: language)
        case .unsafeName(let name):
            // The only one of the five that names no folder: the destination is
            // not what went wrong, the link is. Anything about where the app
            // receives into would be noise in front of the one useful sentence,
            // which is that the sender has to send a new link.
            return L10n.t(.errorDestinationUnsafeNameFilesApp,
                          [L10n.token(name, language: language)],
                          language: language)
        case .systemError(let code):
            // ENOSPC first, and to the SHARED key deliberately: "free up space
            // and try again" is true on both platforms and names no picker, so
            // a second copy of it could only drift from this one.
            if code == ENOSPC {
                return ErrorCopy.message(for: error, language: language)
            }
            if code == EACCES || code == EPERM {
                return L10n.t(.errorDestinationNotPermittedFilesApp, [folder],
                              language: language)
            }
            return L10n.t(.errorDestinationSystemErrorFilesApp,
                          [folder, L10n.token(String(code), language: language)],
                          language: language)
        // Listed rather than defaulted: a new destination error must be a
        // decision here, not a silent fall-through to advice that may name a
        // picker this platform does not have. These two are about the bytes
        // that arrived, not about where they were going, so they are the
        // shared copy's — unchanged, in every language.
        case .exceedsManifest, .incomplete:
            return ErrorCopy.message(for: error, language: language)
        }
    }
}
