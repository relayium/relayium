import Foundation
import RelayiumKit

public struct ParsedLink: Equatable {
    public let id: String
    public let keyB64url: String

    public init(id: String, keyB64url: String) {
        self.id = id
        self.keyB64url = keyB64url
    }
}

/// Parse `…/d/<id>#k=<key>`. Everything that cannot possibly work fails here,
/// before a network call: a missing fragment, a non-`/d/` path, an empty id.
/// The origin is not checked — a self-hosted deployment is a different host, and
/// the id and key are what matter.
public func parseTransferLink(_ s: String) -> ParsedLink? {
    let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed), let fragment = url.fragment else { return nil }
    guard let key = parseDownloadFragment(fragment) else { return nil }
    let parts = url.path.split(separator: "/", omittingEmptySubsequences: true)
    guard parts.count == 2, parts[0] == "d", !parts[1].isEmpty else { return nil }
    return ParsedLink(id: String(parts[1]), keyB64url: key)
}

public enum DownloadState: Equatable {
    case idle
    case resolving
    case ready(StoredManifest, expiresAt: Int64, burnAfterRead: Bool)
    case downloading(received: Int, total: Int)
    case done([URL])
    case failed(String)
}

@MainActor
public final class CloudDownloadModel: ObservableObject {
    @Published public private(set) var state: DownloadState = .idle
    @Published public var linkText: String = ""

    private let client: CloudClient
    private var task: Task<Void, Never>?
    private var generation = 0
    private var link: ParsedLink?
    private var key: [UInt8] = []

    public init(client: CloudClient) { self.client = client }

    public var isBusy: Bool {
        switch state {
        case .downloading, .resolving: return true
        default: return false
        }
    }

    /// Resolve the link: parse, fetch meta, decrypt the manifest. No token —
    /// anonymous download is what a share link is.
    public func resolve() {
        guard let parsed = parseTransferLink(linkText) else {
            state = .failed("That doesn't look like a Relayium link. It should look like https://relayium.com/d/…#k=…")
            return
        }
        generation += 1
        let g = generation
        link = parsed
        state = .resolving
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let k = try decodeStoreKey(parsed.keyB64url)
                let meta = try await self.client.fetchMeta(id: parsed.id)
                guard let enc = Data(base64Encoded: meta.encManifest) else { throw CloudError.decoding }
                let manifest = try decryptManifest(key: k, [UInt8](enc))
                await MainActor.run {
                    guard g == self.generation else { return }
                    self.key = k
                    self.state = .ready(manifest, expiresAt: meta.expiresAt,
                                        burnAfterRead: meta.burnAfterRead)
                }
            } catch {
                await MainActor.run {
                    guard g == self.generation else { return }
                    self.state = .failed(ErrorCopy.message(for: error))
                }
            }
        }
    }

    public func download(into parent: URL) {
        guard case .ready(let manifest, _, _) = state, let parsed = link else { return }
        generation += 1
        let g = generation
        let total = manifest.files.reduce(0) { $0 + $1.size }
        let k = key
        state = .downloading(received: 0, total: total)
        task = Task { [weak self] in
            guard let self else { return }
            var writer: ManifestWriter?
            do {
                let dir = manifest.files.count > 1
                    ? try destinationDirectory(parent: parent, id: parsed.id)
                    : parent
                let w = try ManifestWriter(directory: dir, manifest: manifest)
                writer = w
                var received = 0
                _ = try await self.client.download(id: parsed.id, key: k) { chunk in
                    try w.write(chunk)
                    received += chunk.count
                    let r = received
                    Task { @MainActor in
                        guard g == self.generation else { return }
                        self.state = .downloading(received: r, total: total)
                    }
                }
                let urls = try w.finish()
                await MainActor.run {
                    guard g == self.generation else { return }
                    self.state = .done(urls)
                }
            } catch {
                // A truncated file with a plausible name is worse than no file.
                writer?.discard()
                await MainActor.run {
                    guard g == self.generation else { return }
                    self.state = .failed(ErrorCopy.message(for: error))
                }
            }
        }
    }

    public func cancel() {
        task?.cancel()
        task = nil
        generation += 1
        state = .idle
    }
}
