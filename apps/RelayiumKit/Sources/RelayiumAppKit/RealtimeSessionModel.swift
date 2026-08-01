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
    /// One authenticated kind-9 message and its framed byte count.
    var onText: ((String, Int) -> Void)? { get set }
    /// Accept/reject/complete. `complete` is how a sender — which never
    /// receives a DONE frame of its own — learns the batch landed.
    var onControl: ((RealtimeControl) -> Void)? { get set }
    var onClose: (() -> Void)? { get set }
    var onError: ((Error) -> Void)? { get set }

    func start()
    func send(sources: [PlaintextSource], metas: [FileMeta])
    func accept()
    func reject()
    /// Tell the peer the whole batch arrived and verified (CTRL_COMPLETE).
    func complete()
    /// Latch local SAS confirmation before an initiator may decrypt text.
    func confirmTextSAS()
    func acceptText()
    func rejectText()
    func sendText(_ body: String, completion: @escaping (Error?) -> Void)
    var textBufferedAmount: UInt64 { get }
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
    private var pendingReceive = false
    private var sasConfirmed = false
    private var totalBytes = 0
    private var completedIncomingFiles = 0
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
        guard sources.count == metas.count, let total = try? validateRealtimeFiles(metas) else {
            pendingSend = nil
            totalBytes = 0
            state = .failed("The selected file list is invalid. Choose the files again.")
            return
        }
        pendingSend = (sources, metas)
        totalBytes = total
    }

    // MARK: - the SAS gate

    public func confirmSAS() {
        guard case .verifying = state else { return }
        sasConfirmed = true
        if let p = pendingSend {
            state = .transferring(done: 0, total: totalBytes)
            connection?.send(sources: p.sources, metas: p.metas)
        } else if pendingReceive {
            startPendingReceive()
        } else {
            // The peer may not have staged its manifest yet. Keep progress on
            // screen; `onManifest` will install the writer and send ACCEPT.
            state = .transferring(done: 0, total: 0)
        }
    }

    private func startPendingReceive() {
        guard pendingReceive else { return }
        do {
            writer = try ManifestWriter(
                directory: saveDirectory,
                files: incoming.map { WritableFile(name: $0.name, size: $0.size) })
            completedIncomingFiles = 0
            state = .transferring(done: 0, total: totalBytes)
            connection?.accept()
        } catch {
            connection?.reject()
            writer?.discard()
            teardown()
            state = .failed(ErrorCopy.message(for: error))
        }
    }

    private func failReceive(_ error: Error) {
        connection?.reject()
        writer?.discard()
        teardown()
        state = .failed(ErrorCopy.message(for: error))
    }

    /// Closes the connection rather than returning to a picker. A mismatched
    /// phrase is what a man-in-the-middle looks like, and offering "try again"
    /// on the same connection would invite accepting it the second time.
    public func rejectSAS() {
        connection?.reject()
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
            Task { @MainActor in
                self?.apply(g) {
                    $0.sasConfirmed = false
                    $0.state = .verifying(sas: sas)
                }
            }
        }
        c.onManifest = { [weak self] metas in
            Task { @MainActor in
                self?.apply(g) { m in
                    do {
                        m.totalBytes = try validateRealtimeFiles(metas)
                        m.incoming = metas
                        m.pendingReceive = true
                        if m.sasConfirmed {
                            m.startPendingReceive()
                        }
                    } catch {
                        m.failReceive(error)
                    }
                }
            }
        }
        c.onFileChunk = { [weak self] bytes in
            Task { @MainActor in
                self?.apply(g) { m in
                    do {
                        guard let writer = m.writer else { throw DownloadDestinationError.incomplete }
                        try writer.write(bytes)
                    } catch {
                        m.failReceive(error)
                    }
                }
            }
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
                        m.failReceive(RealtimeError.tamper)
                        return
                    }
                    m.completedIncomingFiles += 1
                    guard m.completedIncomingFiles <= m.incoming.count else {
                        m.failReceive(DownloadDestinationError.exceedsManifest)
                        return
                    }
                    guard m.completedIncomingFiles == m.incoming.count else { return }
                    let urls: [URL]
                    do {
                        guard let writer = m.writer else { throw DownloadDestinationError.incomplete }
                        urls = try writer.finish()
                    } catch {
                        m.failReceive(error)
                        return
                    }
                    // Only once the bytes are actually on disk, matching the
                    // web receiver (transfer-session.svelte.ts:458). The sender
                    // has no DONE frame of its own and waits on exactly this.
                    m.connection?.complete()
                    m.state = .completed(urls)
                }
            }
        }
        c.onControl = { [weak self] control in
            Task { @MainActor in
                self?.apply(g) { m in
                    switch control {
                    case .complete:
                        m.state = .completed([])
                    case .reject:
                        m.writer?.discard()
                        m.state = .failed(
                            ErrorCopy.message(for: RealtimeConnection.ConnectionError.rejected)
                        )
                    case .accept:
                        break
                    }
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
                    if m.isBusy {
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
        pendingReceive = false
        completedIncomingFiles = 0
        sasConfirmed = false
        incoming = []
    }
}
