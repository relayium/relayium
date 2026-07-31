import Foundation
import RelayiumKit

/// The subset of `RealtimeConnection` this model drives.
///
/// The concrete type needs WebRTC and a live peer, so nothing above it could be
/// tested without this seam — the same move `ResumableTransport` was for the
/// cloud uploader.
public protocol RealtimePeerConnection: AnyObject {
    var onSAS: ((String) -> Void)? { get set }
    var onOpen: (() -> Void)? { get set }
    var onManifest: (([FileMeta]) -> Void)? { get set }
    var onFileChunk: (([UInt8]) -> Void)? { get set }
    var onProgress: ((Int) -> Void)? { get set }
    var onDone: ((Bool) -> Void)? { get set }
    /// Accept/reject/complete. `complete` is how a sender — which never
    /// receives a DONE frame of its own — learns the batch landed.
    var onControl: ((RealtimeControl) -> Void)? { get set }
    var onClose: (() -> Void)? { get set }
    var onError: ((Error) -> Void)? { get set }

    func start()
    func send(sources: [PlaintextSource], metas: [FileMeta])
    /// Tell the peer the whole batch arrived and verified (CTRL_COMPLETE).
    func complete()
    func close()
}

public enum RealtimeState: Equatable {
    case idle
    case minting
    case showingCode(String, expiresAt: Int64)
    case joining(String)
    case connecting
    /// Blocking on purpose: nothing is sent and nothing is written until the
    /// local user confirms the phrase matches the other device's.
    case verifying(sas: String)
    case transferring(done: Int, total: Int)
    case completed([URL])
    case failed(String)
}

@MainActor
public final class RealtimeSessionModel: ObservableObject {
    @Published public private(set) var state: RealtimeState = .idle
    /// Files named by the incoming manifest, shown while transferring.
    @Published public private(set) var incoming: [FileMeta] = []
    /// Shared with the view so an OS handoff can prefill the same field without
    /// auto-joining or replacing an active connection.
    @Published public var joinCode: String = ""
    /// Where a received transfer is written. The pane sets it from a save panel.
    public var saveDirectory: URL = FileManager.default
        .urls(for: .downloadsDirectory, in: .userDomainMask).first
        ?? FileManager.default.temporaryDirectory

    private let pairClient: PairCodeClient
    private let iceClient: ICEConfigClient
    /// Async because building a real connection means connecting to signaling
    /// and waiting for the other device to appear on the code — there is no peer
    /// id to construct one with until then.
    private let makeConnection: (_ code: String, _ role: Role, _ iceServers: ICEConfig) async throws -> RealtimePeerConnection

    private var connection: RealtimePeerConnection?
    private var writer: ManifestWriter?
    private var pendingSend: (sources: [PlaintextSource], metas: [FileMeta])?
    private var totalBytes = 0
    /// Operation identity: a callback from a session the user has left must not
    /// repaint a screen they have moved past.
    private var generation = 0

    public init(pairClient: PairCodeClient,
                iceClient: ICEConfigClient,
                makeConnection: @escaping (String, Role, ICEConfig) async throws -> RealtimePeerConnection) {
        self.pairClient = pairClient
        self.iceClient = iceClient
        self.makeConnection = makeConnection
    }

    /// A live session the quit guard must not let die silently.
    public var isBusy: Bool {
        switch state {
        case .idle, .failed, .completed: return false
        default: return true
        }
    }

    public var canJoin: Bool { isCompletePairingCode(joinCode) }

    public func updateJoinCode(_ raw: String) {
        joinCode = normalizedPairingCode(raw)
    }

    // MARK: - starting a session

    /// Sender side: mint a code to show. Requires the bearer — the code's owner
    /// pays for traffic relayed through it.
    public func mintCode(token: String) async {
        generation += 1
        let g = generation
        state = .minting
        do {
            let minted = try await pairClient.mint(token: token)
            guard g == generation else { return }
            state = .showingCode(minted.code, expiresAt: minted.expiresAt)
        } catch {
            guard g == generation else { return }
            state = .failed(ErrorCopy.message(for: error))
        }
    }

    /// Both sides end up here: the sender once a peer arrives on its code, the
    /// receiver as soon as it has one to join.
    public func join(code: String, role: Role = .responder) async {
        generation += 1
        let g = generation
        // A sender minted this code and is already displaying it; the other
        // device has to read it off that screen, so replacing it with
        // "Connecting…" removes the one thing the wait depends on — and the
        // wait could then only ever end in the peer timeout.
        //
        // A receiver typed a code instead of minting one and has nothing to
        // display, so it gets progress.
        if !isShowing(code) { state = .joining(code) }
        do {
            // Fetched once per attempt, not per retry: /api/ice is limited to
            // 5/min per IP because guessing a live code steals its TURN
            // credentials.
            let servers = try await iceClient.fetch(code: code)
            guard g == generation else { return }
            let c = try await makeConnection(code, role, servers)
            guard g == generation else { c.close(); return }
            wire(c, generation: g)
            connection = c
            state = .connecting
            c.start()
        } catch {
            guard g == generation else { return }
            // Deliberately before any connection attempt: without ICE servers a
            // connection would fail later and blame the network.
            state = .failed(ErrorCopy.message(for: error))
        }
    }

    private func isShowing(_ code: String) -> Bool {
        if case let .showingCode(shown, _) = state { return shown == code }
        return false
    }

    /// Queued until the SAS is confirmed — see `confirmSAS`.
    public func stageSend(sources: [PlaintextSource], metas: [FileMeta]) {
        pendingSend = (sources, metas)
        totalBytes = metas.reduce(0) { $0 + $1.size }
    }

    // MARK: - the SAS gate

    public func confirmSAS() {
        guard case .verifying = state else { return }
        state = .transferring(done: 0, total: totalBytes)
        if let p = pendingSend {
            connection?.send(sources: p.sources, metas: p.metas)
        }
    }

    /// Closes the connection rather than returning to a picker. A mismatched
    /// phrase is what a man-in-the-middle looks like, and offering "try again"
    /// on the same connection would invite accepting it the second time.
    public func rejectSAS() {
        teardown()
        state = .idle
    }

    public func cancel() {
        writer?.discard()
        teardown()
        state = .idle
    }

    // MARK: - wiring

    private func wire(_ c: RealtimePeerConnection, generation g: Int) {
        c.onSAS = { [weak self] sas in
            Task { @MainActor in self?.apply(g) { $0.state = .verifying(sas: sas) } }
        }
        c.onManifest = { [weak self] metas in
            Task { @MainActor in
                self?.apply(g) { m in
                    m.incoming = metas
                    m.totalBytes = metas.reduce(0) { $0 + $1.size }
                    m.state = .transferring(done: 0, total: m.totalBytes)
                    m.writer = try? ManifestWriter(
                        directory: m.saveDirectory,
                        files: metas.map { WritableFile(name: $0.name, size: $0.size) })
                }
            }
        }
        c.onFileChunk = { [weak self] bytes in
            Task { @MainActor in self?.apply(g) { try? $0.writer?.write(bytes) } }
        }
        c.onProgress = { [weak self] done in
            Task { @MainActor in
                self?.apply(g) { $0.state = .transferring(done: done, total: $0.totalBytes) }
            }
        }
        c.onDone = { [weak self] ok in
            Task { @MainActor in
                self?.apply(g) { m in
                    guard ok else {
                        // The DONE hash did not match what arrived. Files that
                        // look complete are worse than none.
                        m.writer?.discard()
                        m.state = .failed(ErrorCopy.message(for: RealtimeError.tamper))
                        return
                    }
                    let urls = (try? m.writer?.finish()) ?? nil
                    // Only once the bytes are actually on disk, matching the
                    // web receiver (transfer-session.svelte.ts:458). The sender
                    // has no DONE frame of its own and waits on exactly this.
                    m.connection?.complete()
                    m.state = .completed(urls ?? [])
                }
            }
        }
        c.onControl = { [weak self] control in
            Task { @MainActor in
                self?.apply(g) { m in
                    // The sending half's terminal state. `.accept`/`.reject` are
                    // consumed inside the connection's send path.
                    guard case .complete = control else { return }
                    m.state = .completed([])
                }
            }
        }
        c.onError = { [weak self] err in
            Task { @MainActor in
                self?.apply(g) { m in
                    m.writer?.discard()
                    m.state = .failed(ErrorCopy.message(for: err))
                }
            }
        }
        c.onClose = { [weak self] in
            Task { @MainActor in
                self?.apply(g) { m in
                    if case .transferring = m.state {
                        m.writer?.discard()
                        m.state = .failed("The other device disconnected.")
                    }
                }
            }
        }
    }

    /// Every callback goes through here, so the generation check exists once.
    private func apply(_ g: Int, _ body: (RealtimeSessionModel) -> Void) {
        guard g == generation else { return }
        body(self)
    }

    private func teardown() {
        generation += 1
        connection?.close()
        connection = nil
        writer = nil
        pendingSend = nil
        incoming = []
    }
}
