import Foundation
import RelayiumKit

/// Getting a picked photo or video out of the system provider and into a batch
/// this app can send, without ever holding a whole file in memory and without
/// ever leaking the bytes it copied.
///
/// The shape is forced by one constraint: `Transferable.transferRepresentation`
/// is a **static** property and `loadTransferable(type:)` takes only a type, so
/// nothing per-import can be handed to the import closure. A shared "current
/// batch" or a task-local read inside a system-invoked closure is exactly the
/// ambient state that breaks under supersession — two imports in flight would
/// write into each other's batch. So the flow splits at that seam, and the seam
/// is **ownership**:
///
///  - **Step 1**, reachable from the static closure, copies the provider's
///    temporary file into a fresh UUID directory this app owns and returns a
///    `PhotoCandidate` that OWNS that directory. It needs no context, because a
///    UUID directory needs no collision rule.
///  - **Step 2**, in `SendSelectionModel`, has all the context: it moves each
///    candidate into the current batch under a collision-safe name, in the
///    user's selection order.
///
/// The copy in step 1 must finish before the import closure returns, because the
/// provider deletes its temporary file at that moment. The move in step 2 is a
/// rename — inbox and batch are both under `<tmp>` deliberately — so a
/// multi-gigabyte video is not written twice.

/// How many items the Photos picker will hand back at once.
///
/// `MAX_FILES` (1000) is the wrong bound for this path: that bound is about what
/// a manifest can *describe*, and this path copies every byte out of the photo
/// library first. Because the picker itself enforces this, there is no "too many
/// photos" error string — a message for an unreachable case is a dead control
/// made of words.
public let PHOTO_IMPORT_MAX = 50

/// The byte budget for a staged file name. Far below `MANIFEST_MAX_NAME_BYTES`
/// (1024), so a staged name can never be the reason the app's own manifest is
/// refused by its own receive side.
private let STAGED_NAME_MAX_BYTES = 200

/// The name given to an item whose provider name yields nothing usable.
private let STAGED_NAME_FALLBACK_STEM = "photo"   // nonlocalized: a file name, not copy

/// Anything longer than this after the last dot is part of the name rather than
/// an extension. `.mov` and `.HEIC` are extensions; `file.this is a sentence`
/// is not, and truncating around it as though it were would eat the part the
/// user recognises.
private let STAGED_NAME_MAX_EXTENSION_BYTES = 16

public enum PhotoImportError: Error, Equatable {
    /// The picker returned an item that could not be decoded as a file at all.
    case unusable
    /// The candidate's bytes have already been moved into a batch or discarded.
    /// A second transfer must not be attempted against an empty directory.
    case ownershipReleased
}

/// The final name a picked item is staged under, inside one batch.
///
/// Pure, and therefore the part that gets the table-driven test. Uniqueness
/// within the batch is not cosmetic: `stageCloudFiles` puts the relative path in
/// `ManifestFile.name`, and two identical names would make this app produce a
/// manifest its own receiving side refuses with `error.manifest.duplicatePath`.
public func stagedFileName(suggested: String, taken: Set<String>) -> String {
    // 1. The leaf only, so a name containing a separator cannot escape the
    //    batch directory.
    var name = (suggested as NSString).lastPathComponent

    // 2. Strip what a file name may not carry, then trim.
    name = String(name.unicodeScalars.filter { scalar in
        !CharacterSet.controlCharacters.contains(scalar) && scalar != "/" && scalar != ":"
    })
    name = name.trimmingCharacters(in: .whitespacesAndNewlines)

    // 3. Split at the LAST dot. A name that is only an extension therefore
    //    yields an EMPTY stem — not a stem called "mov".
    var stem = name
    var ext = ""
    if let dot = name.range(of: ".", options: .backwards) {
        let candidate = String(name[dot.upperBound...])
        if !candidate.isEmpty, candidate.utf8.count <= STAGED_NAME_MAX_EXTENSION_BYTES {
            stem = String(name[..<dot.lowerBound])
            ext = "." + candidate
        }
    }

    // 4. Nothing may land hidden.
    while stem.hasPrefix(".") { stem.removeFirst() }
    stem = stem.trimmingCharacters(in: .whitespacesAndNewlines)

    // 5. An empty stem is what turns ".mov" into "photo.mov".
    if stem.isEmpty { stem = STAGED_NAME_FALLBACK_STEM }

    // 6-8. The stem is truncated PER ATTEMPT, so the byte cap holds after the
    //      collision suffix rather than merely before it, and truncation
    //      removes whole `Character`s — a byte slice can split a scalar or a
    //      grapheme cluster and leave a replacement character in the name.
    for attempt in 1...(taken.count + 1) {
        let suffix = attempt == 1 ? "" : " (\(attempt))"
        let candidate = fitted(stem: stem, suffix: suffix, ext: ext)
        if !taken.contains(candidate) { return candidate }
    }
    // Unreachable: every attempt carries a distinct suffix, so one of
    // `taken.count + 1` attempts is always free. Kept total rather than
    // trapping, because a naming rule must not be able to crash a send.
    return fitted(stem: stem, suffix: " (\(taken.count + 2))", ext: ext)
}

private func fitted(stem: String, suffix: String, ext: String) -> String {
    var trimmed = stem
    let fixed = suffix.utf8.count + ext.utf8.count
    while trimmed.utf8.count + fixed > STAGED_NAME_MAX_BYTES, !trimmed.isEmpty {
        trimmed.removeLast()
    }
    guard trimmed.isEmpty else { return trimmed + suffix + ext }
    // 7. The extension alone consumed the budget. Fall back to the stem that
    //    always fits, and drop the extension if even that does not.
    let fallback = STAGED_NAME_FALLBACK_STEM + suffix
    return (fallback + ext).utf8.count <= STAGED_NAME_MAX_BYTES ? fallback + ext : fallback
}

/// One picked item, already copied out of the provider's temporary storage —
/// and the OWNER of the inbox directory it lives in.
///
/// A class, not a struct, because ownership has to be releasable exactly once
/// and **by ARC**. The framework can decode a `StagedPhotoFile` and then drop it
/// — a cancelled `loadTransferable`, a superseded import, a torn-down task — and
/// when it does, nothing in this app is ever called. `deinit` is the only
/// cleanup hook that survives that. It is also why there is NO runtime sweep of
/// a shared inbox: a sweep would race a provider callback still completing after
/// cancellation and delete a directory that is about to be filled.
///
/// Every filesystem operation on the owned directory happens under this
/// candidate's own lock, so `discard()` and `deinit` cannot delete the bytes out
/// from under a `moveOut(to:)` that is still copying them. That is the whole
/// reason the move lives here rather than in the staging area: only the owner
/// can serialise it against its own release.
public final class PhotoCandidate: @unchecked Sendable {
    /// The copied file, inside the owned directory.
    public let url: URL
    /// What the provider called it, unsanitized. Naming is step 2's decision.
    public let suggestedName: String

    private let directory: URL
    private let fileManager: FileManager
    private let lock = NSLock()
    private var released = false

    init(url: URL, suggestedName: String, directory: URL, fileManager: FileManager) {
        self.url = url
        self.suggestedName = suggestedName
        self.directory = directory
        self.fileManager = fileManager
    }

    /// Give up the directory now. Idempotent, and safe from any thread.
    ///
    /// The removal happens under the lock rather than after it, so a
    /// `moveOut(to:)` running concurrently either completes entirely first — and
    /// this then finds ownership already gone — or is refused before it touches
    /// a byte. There is no window in which both are working on the directory.
    public func discard() {
        lock.lock()
        defer { lock.unlock() }
        guard !released else { return }
        released = true
        try? fileManager.removeItem(at: directory)
    }

    /// Move the owned file to `destination` and give up ownership — ONE
    /// operation, under this candidate's lock.
    ///
    /// Ownership transfers only after the move succeeds. On failure this throws
    /// and the candidate still owns, and still cleans up, its directory: a
    /// transient move failure must not leak a video. On success the emptied
    /// directory is removed here, so a later `discard()` or `deinit` is a no-op
    /// and can never delete a file that now belongs to the batch.
    ///
    /// It is a move rather than a copy because the inbox and the batch root are
    /// both under `<tmp>` deliberately, which makes this a rename.
    /// `FileManager.moveItem` stays correct if that ever stops holding on some
    /// future volume layout — it would just be slow.
    func moveOut(to destination: URL) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !released else { throw PhotoImportError.ownershipReleased }
        try fileManager.moveItem(at: url, to: destination)
        released = true
        try? fileManager.removeItem(at: directory)
    }

    deinit { discard() }
}

/// `<tmp>/PhotoInbox` — where step 1 puts what it copied out of a provider.
public enum PhotoInbox {
    /// Flat and launch-independent on purpose: step 1 cannot know which launch
    /// or which import it belongs to, because the static representation that
    /// calls it carries no context at all.
    public static func directory(_ fileManager: FileManager = .default) throws -> URL {
        let url = fileManager.temporaryDirectory.appendingPathComponent("PhotoInbox")
        try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// The narrow function the static representation calls, and its ONLY job:
    /// copy the provider's file to a unique location this app owns, right now,
    /// before the transfer callback returns — the provider deletes its file at
    /// that moment. Each candidate gets its own UUID directory, so this step
    /// needs no collision rule at all, which is what lets it be context-free.
    public static func take(_ providerFile: URL,
                            in inbox: URL? = nil,
                            _ fileManager: FileManager = .default) throws -> PhotoCandidate {
        let root = try inbox ?? directory(fileManager)
        let owned = root.appendingPathComponent(UUID().uuidString)
        try fileManager.createDirectory(at: owned, withIntermediateDirectories: true)
        // The on-disk name only has to be safe and short enough for the
        // filesystem; the FINAL name is step 2's decision, and the provider's
        // own spelling is preserved verbatim in `suggestedName` for it.
        let suggested = providerFile.lastPathComponent
        let destination = owned.appendingPathComponent(stagedFileName(suggested: suggested,
                                                                     taken: []))
        do {
            try fileManager.copyItem(at: providerFile, to: destination)
        } catch {
            // Nothing owns this directory yet, so it is this function's to undo.
            try? fileManager.removeItem(at: owned)
            throw error
        }
        return PhotoCandidate(url: destination, suggestedName: suggested,
                              directory: owned, fileManager: fileManager)
    }

    /// Remove everything in the inbox. Called EXACTLY ONCE, at app-scoped model
    /// construction, before any import can exist — it is for leftovers from a
    /// launch that crashed and nothing else. **There is no runtime sweep**,
    /// because one would race a provider callback still completing after
    /// cancellation and delete a directory that is about to be filled.
    public static func sweepLeftovers(_ inbox: URL? = nil,
                                      _ fileManager: FileManager = .default) {
        guard let root = inbox ?? (try? directory(fileManager)) else { return }
        let contents = (try? fileManager.contentsOfDirectory(at: root,
                                                             includingPropertiesForKeys: nil))
            ?? []
        for item in contents { try? fileManager.removeItem(at: item) }
    }
}

/// One import's staged files, and the names already used inside it.
public final class PhotoStagingBatch: @unchecked Sendable {
    public let url: URL
    private let lock = NSLock()
    private var taken: Set<String> = []

    init(url: URL) { self.url = url }

    func reserve(_ suggested: String) -> String {
        lock.lock()
        defer { lock.unlock() }
        let name = stagedFileName(suggested: suggested, taken: taken)
        taken.insert(name)
        return name
    }

    func release(_ name: String) {
        lock.lock()
        defer { lock.unlock() }
        taken.remove(name)
    }
}

/// `<tmp>/PhotoImports/<launch UUID>/<batch UUID>/` — where step 2 assembles
/// what will actually be sent.
///
/// `tmp`, not `Documents`: `Documents` is published to the Files app by
/// `UIFileSharingEnabled`, so staging copies there would litter the folder the
/// user browses for *received* files. `tmp` is the documented place for files
/// that need not persist, and — the operational reason — it puts the inbox and
/// the batch on one filesystem, which is what makes step 2 a rename.
///
/// A per-launch root makes leftover cleanup provably safe: the sweep deletes
/// every *sibling* of this launch's directory, and a live batch is always inside
/// the directory the sweep excludes by construction. A plain non-isolated class
/// with a lock, for the same `deinit` reason as `SecurityScopedAccess`.
public final class PhotoStagingArea: @unchecked Sendable {
    /// This launch's directory. Everything this area creates lives inside it.
    public let launchRoot: URL

    private let fileManager: FileManager
    private let lock = NSLock()
    private var live: PhotoStagingBatch?

    public init(root: URL? = nil, fileManager: FileManager = .default) {
        let base = root ?? fileManager.temporaryDirectory.appendingPathComponent("PhotoImports")
        self.launchRoot = PhotoStagingArea.launchRoot(in: base)
        self.fileManager = fileManager
        // Best effort, and re-attempted by `makeBatch()` with intermediates:
        // a construction that could throw would make the whole send model
        // failable for a directory that is created again on first use anyway.
        try? fileManager.createDirectory(at: launchRoot, withIntermediateDirectories: true)
    }

    /// A fresh per-launch directory name under `base`. Pure: creation is the
    /// caller's, so a sweep can name this launch without having to make it.
    public static func launchRoot(in base: URL) -> URL {
        base.appendingPathComponent(UUID().uuidString)
    }

    /// Remove every sibling of the live launch directory. Best effort: a
    /// leftover that cannot be deleted is a wasted temporary file, not a
    /// failure worth refusing an import over.
    public static func sweepOtherLaunches(under base: URL,
                                          keeping current: URL,
                                          fileManager: FileManager = .default) {
        let contents = (try? fileManager.contentsOfDirectory(at: base,
                                                             includingPropertiesForKeys: nil))
            ?? []
        let keep = current.standardizedFileURL.path
        for item in contents where item.standardizedFileURL.path != keep {
            try? fileManager.removeItem(at: item)
        }
    }

    public func makeBatch() throws -> PhotoStagingBatch {
        let url = launchRoot.appendingPathComponent(UUID().uuidString)
        try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        return PhotoStagingBatch(url: url)
    }

    /// Move `candidate`'s file into `batch` under a collision-safe name.
    ///
    /// The move and the ownership release are the candidate's own single
    /// operation (`moveOut(to:)`), so nothing here can race a concurrent
    /// `discard()`. A throwing move leaves the candidate owning its cleanup and
    /// gives the reserved name back, so a later item can still use it.
    @discardableResult
    public func adopt(_ candidate: PhotoCandidate, into batch: PhotoStagingBatch) throws -> URL {
        let name = batch.reserve(candidate.suggestedName)
        let destination = batch.url.appendingPathComponent(name)
        do {
            try candidate.moveOut(to: destination)
        } catch {
            batch.release(name)
            throw error
        }
        return destination
    }

    /// Make `batch` the live one, removing whatever was live before. That is
    /// what "a new selection replaces the old one" means on disk.
    public func adoptBatch(_ batch: PhotoStagingBatch) {
        lock.lock()
        let previous = live
        live = batch
        lock.unlock()
        if let previous, previous !== batch { try? fileManager.removeItem(at: previous.url) }
    }

    /// Remove one batch — what supersession and partial failure both need. A
    /// single `removeItem`, which is the whole reason a batch has its own
    /// directory.
    public func discard(_ batch: PhotoStagingBatch) {
        lock.lock()
        if live === batch { live = nil }
        lock.unlock()
        try? fileManager.removeItem(at: batch.url)
    }

    public func clear() { release() }

    private func release() {
        lock.lock()
        let previous = live
        live = nil
        lock.unlock()
        if let previous { try? fileManager.removeItem(at: previous.url) }
    }

    deinit { release() }
}
