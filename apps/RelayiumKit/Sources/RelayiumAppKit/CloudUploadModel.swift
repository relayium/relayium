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
    case picked([URL])
    case uploading(sent: Int, total: Int)
    case done(link: String, expiresAt: Int64)
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
    private let origin: String
    private var task: Task<Void, Never>?
    /// The files the user chose, kept so cancel() and reset() can return to a
    /// state they can act from instead of making them choose again.
    private var lastPicked: [URL] = []
    /// Operation identity, as in AccountSession: a late callback from a
    /// superseded upload must not repaint a screen the user has moved past.
    private var generation = 0

    public init(uploader: CloudUploader, origin: String) {
        self.uploader = uploader
        self.origin = origin
    }

    public var isBusy: Bool { if case .uploading = state { return true }; return false }

    /// Exposed for the superseded-callback test; nothing else should read it.
    var currentGeneration: Int { generation }

    public func applyRetentionCap(_ secs: Int64) {
        ttlChoices = allowedTTLs(retentionSecs: secs)
        if !ttlChoices.contains(ttl) { ttl = ttlChoices.last ?? 3600 }
    }

    public func pick(_ urls: [URL]) {
        if maxFileSize > 0 {
            for u in urls {
                let attrs = try? FileManager.default.attributesOfItem(atPath: u.path)
                let size = (attrs?[.size] as? NSNumber)?.int64Value ?? 0
                if size > maxFileSize {
                    state = .failed("\(u.lastPathComponent) is larger than this server accepts.")
                    return
                }
            }
        }
        lastPicked = urls
        state = .picked(urls)
    }

    public func start(token: String) {
        guard case .picked(let urls) = state else { return }
        generation += 1
        let g = generation
        state = .uploading(sent: 0, total: 0)
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let sources: [PlaintextSource] = try urls.map { try FileURLSource(url: $0) }
                let outcome = try await self.uploader.upload(
                    sources: sources,
                    burnAfterRead: await self.burnAfterRead,
                    ttl: await self.ttl,
                    token: token,
                    onProgress: { sent, total in
                        Task { @MainActor in self.report(sent: sent, total: total, g: g) }
                    })
                await MainActor.run { self.finish(outcome, g: g) }
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

    func finish(_ o: UploadOutcome, g: Int) {
        guard g == generation else { return }
        applyOutcome(o)
    }

    func restore(g: Int) {
        guard g == generation else { return }
        state = lastPicked.isEmpty ? .idle : .picked(lastPicked)
    }

    func fail(_ error: Error, g: Int) {
        guard g == generation else { return }
        state = .failed(ErrorCopy.message(for: error))
    }

    /// Split out so the link construction is testable without a transfer.
    public func applyOutcome(_ o: UploadOutcome) {
        state = .done(link: buildDownloadLink(origin: origin, id: o.id, keyB64url: o.keyB64url),
                      expiresAt: o.expiresAt)
    }
}
