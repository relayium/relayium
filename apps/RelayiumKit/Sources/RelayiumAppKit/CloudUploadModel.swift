import Foundation
import RelayiumKit

/// TTL options, mirroring the web's. An unknown cap (signed out, or a usage
/// fetch that failed) offers all of them: the server truncates anyway, and
/// hiding working options because a side request failed is the worse error.
///
/// A cap below the shortest option still yields the shortest one rather than an
/// empty picker — an empty list would leave nothing selectable and no way to send.
public func allowedTTLs(retentionSecs: Int64) -> [Int] {
    let all = [3600, 86400, 259200, 604800, 1209600]
    guard retentionSecs > 0 else { return all }
    let allowed = all.filter { Int64($0) <= retentionSecs }
    return allowed.isEmpty ? [all[0]] : allowed
}

public enum UploadState: Equatable {
    case idle
    /// The expanded file list, not the roots: a folder is only "picked" once we
    /// know what is in it, and `.picked([])` must be unreachable.
    case picked([SelectedFile])
    case uploading(sent: Int, total: Int)
    /// `keyWarning` is non-nil when the upload succeeded but this Mac could not
    /// keep the key. The link is still here — it is the only copy of that key —
    /// and the warning is what turns a silent future "this file's key is not on
    /// this Mac" into something the user could act on now, by copying it.
    case done(link: String, expiresAt: Int64, keyWarning: String?)
    case failed(String)
}

@MainActor
public final class CloudUploadModel: ObservableObject {
    @Published public private(set) var state: UploadState = .idle
    @Published public var ttl: Int = 86400
    @Published public var burnAfterRead: Bool = false
    /// 0 == unknown; the hint is advisory and the upload works without it.
    @Published public var maxFileSize: Int64 = 0
    @Published public private(set) var ttlChoices: [Int] = allowedTTLs(retentionSecs: 0)

    private let uploader: CloudUploader
    /// Where the key of every successful upload is kept, so the Account tab can
    /// rebuild this link later. The same store the account management model
    /// reads — one installation, one answer to "do I have this key".
    private let keyStore: StoredLinkKeyStore
    private let origin: String
    private var task: Task<Void, Never>?
    /// The files the user chose, kept so cancel() and reset() can return to a
    /// state they can act from instead of making them choose again.
    private var lastPicked: [SelectedFile] = []
    /// Operation identity, as in AccountSession: a late callback from a
    /// superseded upload must not repaint a screen the user has moved past.
    private var generation = 0

    public init(uploader: CloudUploader, keyStore: StoredLinkKeyStore, origin: String) {
        self.uploader = uploader
        self.keyStore = keyStore
        self.origin = origin
    }

    public var isBusy: Bool { if case .uploading = state { return true }; return false }

    /// Exposed for the superseded-callback test; nothing else should read it.
    var currentGeneration: Int { generation }

    public func applyRetentionCap(_ secs: Int64) {
        ttlChoices = allowedTTLs(retentionSecs: secs)
        if !ttlChoices.contains(ttl) { ttl = ttlChoices.last ?? 3600 }
    }

    /// Roots the user chose or dropped — files, folders, or a mix. Folders are
    /// expanded here, before anything is uploaded, so the per-file size gate and
    /// the file-count bound apply to what is actually going to be sent rather
    /// than to the handful of items that were selected.
    public func pick(_ urls: [URL]) {
        let selection: FileSelection
        do { selection = try expandSelection(urls) }
        catch {
            state = .failed(ErrorCopy.message(for: error))
            return
        }
        pick(selection)
    }

    public func pick(_ selection: FileSelection) {
        // A live upload is sending the bytes the CURRENT list describes.
        // Replacing it mid-flight would leave the progress bar, the manifest and
        // the files disagreeing. The panes disable their pickers while busy;
        // this is the guard that does not depend on a redraw.
        guard !isBusy else { return }
        if maxFileSize > 0 {
            for file in selection.files {
                let attrs = try? FileManager.default.attributesOfItem(atPath: file.url.path)
                let size = (attrs?[.size] as? NSNumber)?.int64Value ?? 0
                if size > maxFileSize {
                    state = .failed("\(file.name) is larger than this server accepts.")
                    return
                }
            }
        }
        guard !selection.files.isEmpty else {
            state = .failed(ErrorCopy.message(for: FileSelectionError.noFiles))
            return
        }
        lastPicked = selection.files
        state = .picked(selection.files)
    }

    public func start(token: String) {
        guard case .picked(let files) = state else { return }
        generation += 1
        let g = generation
        state = .uploading(sent: 0, total: 0)
        task = Task { [weak self] in
            guard let self else { return }
            do {
                // Through `stageCloudFiles`, not a second copy of it: the rule
                // that folder hierarchy rides in `ManifestFile.name` has to have
                // exactly one implementation, or the native upload and the thing
                // its interop test pins drift apart.
                let sources = try stageCloudFiles(files)
                let outcome = try await self.uploader.upload(
                    sources: sources,
                    burnAfterRead: self.burnAfterRead,
                    ttl: self.ttl,
                    token: token,
                    onProgress: { sent, total in
                        Task { @MainActor in self.report(sent: sent, total: total, g: g) }
                    })
                await self.finish(outcome, g: g)
            } catch is CancellationError {
                await MainActor.run { self.restore(g: g) }
            } catch {
                await MainActor.run { self.fail(error, g: g) }
            }
        }
    }

    /// Cancel and return to the files the user chose. Bumping the generation is
    /// the load-bearing half: an in-flight progress callback must not resume.
    public func cancel() {
        task?.cancel()
        task = nil
        generation += 1
        state = lastPicked.isEmpty ? .idle : .picked(lastPicked)
    }

    /// Forget the selection entirely — what "Clear" means. Distinct from
    /// `reset`, which deliberately keeps it so a failure does not make the user
    /// choose everything again. Refuses mid-upload: the bytes being sent are the
    /// ones this list describes.
    public func clearSelection() {
        guard !isBusy else { return }
        generation += 1
        lastPicked = []
        state = .idle
    }

    /// Back to a state the user can start from, after a success or a failure.
    public func reset() {
        generation += 1
        state = lastPicked.isEmpty ? .idle : .picked(lastPicked)
    }

    // MARK: - state transitions, each guarded by generation

    func report(sent: Int, total: Int, g: Int) {
        guard g == generation else { return }
        state = .uploading(sent: sent, total: total)
    }

    /// Persist the key, then present the link.
    ///
    /// The key is stored BEFORE the generation is checked, and deliberately so:
    /// by the time this runs the server has the bytes, whatever the screen is
    /// showing. If the user cancelled or started another upload in the meantime,
    /// nothing here should repaint — but the key is still the only thing that
    /// could ever open what was uploaded, so throwing it away because a view
    /// moved on would be losing data to a UI event.
    func finish(_ o: UploadOutcome, g: Int) async {
        var warning: String?
        do {
            try await keyStore.save(id: o.id, keyB64url: o.keyB64url)
        } catch {
            // Never a failed upload: the transfer succeeded, and reporting it as
            // a failure would invite a retry that sends every byte a second
            // time. The link itself is intact — and it is now the ONLY place
            // that key exists, which is the whole reason this is said loudly and
            // said here, on the last screen the link appears on.
            //
            // It leads with what failed rather than wrapping it, because the
            // stored-key copy already names the operation: the shared table's
            // `KeychainError` wording is the SIGN-IN store's, and a save that
            // never touched the session must not borrow it.
            warning = """
                \(ErrorCopy.storedLinkKeyMessage(for: error, operation: .save)) \
                The link below is the only available copy of the key — copy it now. \
                Relayium's servers never had the key, so this link can't be shown again.
                """
        }
        guard g == generation else { return }
        state = .done(link: buildDownloadLink(origin: origin, id: o.id, keyB64url: o.keyB64url),
                      expiresAt: o.expiresAt, keyWarning: warning)
    }

    func restore(g: Int) {
        guard g == generation else { return }
        state = lastPicked.isEmpty ? .idle : .picked(lastPicked)
    }

    func fail(_ error: Error, g: Int) {
        guard g == generation else { return }
        state = .failed(ErrorCopy.message(for: error))
    }

    /// A failure raised outside the upload — an unreadable selection, say. Not
    /// applied mid-upload: a picker error must not repaint a live transfer.
    public func fail(_ message: String) {
        guard !isBusy else { return }
        generation += 1
        state = .failed(message)
    }

    /// Split out so the link construction and key persistence are testable
    /// without a transfer.
    public func applyOutcome(_ o: UploadOutcome) async {
        await finish(o, g: generation)
    }
}
