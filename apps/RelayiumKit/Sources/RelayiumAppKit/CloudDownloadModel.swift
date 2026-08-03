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
/// before a network call: a missing fragment, a non-`/d/` path, an id this app
/// will not act on. The origin is not checked — a self-hosted deployment is a
/// different host, and the id and key are what matter.
///
/// The id comes from whoever produced the link — a sender, a page, a chat
/// message, an OS handoff — and is composed into `/api/files/<id>/meta` and
/// `/api/files/<id>/blob`, so it gets the same `StoredObjectID` rule an id
/// issued by the server does. The path split alone is not that rule: it removes
/// separators, but `URL.path` DECODES first, so `%2E%2E`, `%3F`, `%23`, `%0A`
/// and `%00` deliver `..`, `?`, `#`, a newline and a NUL into a single path
/// component, where nothing downstream is looking for them any more.
///
/// Refused, not repaired: an id that is not one inert token names an object
/// this app cannot vouch for, and rewriting it would only produce a link to
/// something the sender did not share.
public func parseTransferLink(_ s: String) -> ParsedLink? {
    let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed), let fragment = url.fragment else { return nil }
    guard let key = parseDownloadFragment(fragment) else { return nil }
    let parts = url.path.split(separator: "/", omittingEmptySubsequences: true)
    guard parts.count == 2, parts[0] == "d",
          let id = try? StoredObjectID.checked(String(parts[1])) else { return nil }
    return ParsedLink(id: id, keyB64url: key)
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
    /// The directory this download created, if it created one. See
    /// `RealtimeSessionModel.receivedContainer` for why it is not folded into
    /// the state case.
    @Published public private(set) var receivedContainer: URL?

    /// Reveal/drag-out targets for a finished download, or nil. Non-nil only in
    /// `.done`, which is reached only after the writer's `finish()` returned.
    public var received: ReceivedPayload? {
        guard case let .done(urls) = state, !urls.isEmpty else { return nil }
        return receivedPayload(files: urls, container: receivedContainer)
    }

    private let client: CloudClient
    private let errorCopy: (Error) -> String
    private var task: Task<Void, Never>?
    private var generation = 0
    private var link: ParsedLink?
    private var key: [UInt8] = []

    /// `errorCopy` exists for one difference and defaults to no difference at
    /// all: macOS picks a destination per transfer, so `ErrorCopy`'s "choose
    /// another folder" is actionable there, while iOS receives into one
    /// app-owned folder where that sentence names an action the user cannot
    /// take. The recovery step is the platform's; the rules that produced the
    /// failure are not, and none of them live behind this seam.
    public init(client: CloudClient,
                errorCopy: @escaping (Error) -> String = { ErrorCopy.message(for: $0) }) {
        self.client = client
        self.errorCopy = errorCopy
    }

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
            state = .failed(L10n.t(.downloadBadLink))
            return
        }
        generation += 1
        let g = generation
        link = parsed
        // A new link is a new transfer: the last one's directory must not stay
        // behind as this one's Reveal target.
        receivedContainer = nil
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
                    self.state = .failed(self.errorCopy(error))
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
        receivedContainer = nil
        state = .downloading(received: 0, total: total)
        task = Task { [weak self] in
            guard let self else { return }
            var writer: ManifestWriter?
            do {
                let files = manifest.files.map { WritableFile(name: $0.name, size: $0.size) }
                // Three shapes, in the order they are decided:
                //
                // * a folder (any nested name) → its own directory, named after
                //   the sent folder, via `openReceiveWriter`. This covers the
                //   ONE-file folder too: `photos/a.jpg` alone is still a folder.
                // * several flat files → the opaque `relayium-<id>` box this
                //   download has always used, refusing to merge into an existing
                //   one.
                // * a single flat file → straight into the chosen folder,
                //   unchanged.
                let w: ManifestWriter
                let container: URL?
                if hasNestedPaths(files) {
                    let opened = try openReceiveWriter(parent: parent, files: files,
                                                       fallbackName: "relayium-\(parsed.id)")
                    w = opened.writer
                    container = opened.container
                } else if files.count > 1 {
                    let dir = try destinationDirectory(parent: parent, id: parsed.id)
                    // Through the shared helper: the directory exists from the
                    // line above, and this path used to abandon it empty on
                    // every rejected manifest — one per bad link, in the folder
                    // the user picked.
                    //
                    // The helper is not the only thing holding that up any more
                    // (`ManifestWriter` now cleans up an owned container itself,
                    // on every failure it can reach), and the redundancy is
                    // deliberate. Going through it is still the rule, because
                    // "the caller creates a directory and something else is
                    // responsible for removing it" is precisely the split that
                    // produced the bug.
                    w = try openWriterInOwnedContainer(dir, files: files)
                    container = dir.url
                } else {
                    w = try ManifestWriter(directory: parent, files: files)
                    container = nil
                }
                writer = w
                await MainActor.run {
                    guard g == self.generation else { return }
                    self.receivedContainer = container
                }
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
                    self.state = .failed(self.errorCopy(error))
                }
            }
        }
    }

    public func cancel() {
        task?.cancel()
        task = nil
        generation += 1
        receivedContainer = nil
        state = .idle
    }
}
