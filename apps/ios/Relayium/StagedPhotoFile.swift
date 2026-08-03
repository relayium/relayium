import CoreTransferable
import RelayiumAppKit

/// A picked photo or video, as a FILE.
///
/// `FileRepresentation`, never `DataRepresentation`: Apple's own guidance for
/// large or numerous items, and the difference between copying a 4 GB video and
/// loading it into memory. The importing closure MUST finish its copy before it
/// returns — the provider deletes `received.file` at that moment.
///
/// `transferRepresentation` is STATIC and `loadTransferable(type:)` takes only a
/// type, so nothing per-import can be injected here. That is why the only thing
/// this closure does is copy the provider file into a unique app-owned directory
/// that the returned `PhotoCandidate` then OWNS: if the framework decodes this
/// value and drops it — a cancelled load, a superseded import, a torn-down task
/// — ARC frees those bytes with no app code running. Which batch it belongs to,
/// what it is finally named, and whether the import that asked for it is still
/// current are decided in `SendSelectionModel`, where they can be tested. There
/// is no shared "current batch" and no TaskLocal.
///
/// Image first, then movie: that is the negotiation order.
struct StagedPhotoFile: Transferable {
    let candidate: PhotoCandidate

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            StagedPhotoFile(candidate: try PhotoInbox.take(received.file))
        }
        FileRepresentation(importedContentType: .movie) { received in
            StagedPhotoFile(candidate: try PhotoInbox.take(received.file))
        }
    }
}
