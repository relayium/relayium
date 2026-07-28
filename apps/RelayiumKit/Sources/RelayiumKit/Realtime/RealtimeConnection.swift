import Foundation
import WebRTC

/// Runs `RTCInitializeSSL()` exactly once for the process (a Swift file-scope
/// `let` is lazily initialized under a `dispatch_once`-style guard, so this is
/// thread-safe even with concurrent first callers). There is deliberately no
/// paired `RTCCleanupSSL()` anywhere in this file: per Google's own contract,
/// SSL init/cleanup is process-global, not per-connection — tearing it down
/// while ANY `RealtimeConnection` is still alive would break every other live
/// connection sharing the process.
private let rtcSSLInitialized: Void = { RTCInitializeSSL() }()

/// Call before touching any WebRTC SSL-dependent API. Cheap after the first call.
///
/// `package`, not `private`: `RelayProbe` (in the `RelayiumAppKit` target of
/// this same package) constructs its own `RTCPeerConnectionFactory` and needs
/// this same guard to have run first — `package` grants that without making it
/// public API outside the package, and without a second file-scope `let`
/// duplicating (and only weakly approximating) the "exactly once per process"
/// guarantee this one provides.
package func ensureRTCSSL() {
    _ = rtcSSLInitialized
}

/// True once the WebRTC framework is linked and a peer-connection factory can be
/// constructed. A link-time smoke check, independent of `RealtimeConnection` below.
public func webrtcAvailable() -> Bool {
    ensureRTCSSL()
    let factory = RTCPeerConnectionFactory()
    return String(describing: type(of: factory)) == "RTCPeerConnectionFactory"
}

/// Ties `RTCPeerConnection`/`RTCDataChannel` to the R1-E `SignalingClient` and the
/// R1-F pure modules (`HandshakeState`, `RealtimeSender`/`RealtimeReceiver`,
/// `SendWindow`/`AckPacer`, `RealtimeSignal`), mirroring `web/src/lib/webrtc.ts`'s
/// `connect()` (built on `webrtc-core.ts`'s `establish()`): offer/answer + ICE +
/// commit-then-reveal SAS handshake + DataChannel flow control.
///
/// ⚠️ INTEGRATION-TESTED, NOT UNIT-TESTED. This class needs two live WebRTC peers
/// to exercise (offer/answer exchange, ICE gathering, an open DataChannel) and is
/// verified by a live browser↔native E2E, not by `swift test`. The pieces it
/// composes — `HandshakeState`, `SendWindow`, `AckPacer`, `RealtimeSignal`,
/// `RealtimeSender`/`RealtimeReceiver`/`RealtimeWire` — ARE unit-tested (see
/// `Tests/RelayiumKitTests/`); this class only orchestrates them against WebRTC
/// and deliberately contains no cryptographic or flow-control logic of its own.
///
/// All callbacks fire on this connection's private serial queue, never on a
/// WebRTC-internal thread and never assumed to be the main thread — hop to your
/// own queue in the callback if you touch UI.
public final class RealtimeConnection: NSObject {
    public enum ConnectionError: Error, Equatable {
        /// The peer declined the offer because it is already mid-transfer.
        case peerBusy
        /// The underlying `RTCPeerConnection` reached `.failed`.
        case peerConnectionFailed
        /// An operation (e.g. `send`) was attempted before the handshake/channel
        /// were ready.
        case notReady
        /// `send(sources:metas:)` was called a second time on this connection.
        /// Refused rather than run: a fresh `RealtimeSender` restarts its
        /// AES-GCM nonce (seq) counter at 0 under the same session key, so a
        /// second send would reuse nonces already used by the first —
        /// catastrophic for GCM.
        case alreadySending
        /// The receiver sent CTRL_REJECT (or the connection closed) before
        /// accepting the batch; the data frames were never streamed.
        case rejected
        /// The receiver never accepted the batch, or stalled mid-transfer
        /// without acking, for longer than the wait deadline.
        case timedOut
    }

    // MARK: Public callbacks

    /// The 6-digit-ish short authentication string, once both commits are
    /// verified and session keys are derived. The user compares this out of
    /// band to rule out a signaling-server-in-the-middle.
    public var onSAS: ((String) -> Void)?
    /// The DataChannel is open AND the handshake has derived session keys.
    public var onOpen: (() -> Void)?
    /// A decrypted BATCH frame: the incoming file list.
    public var onManifest: (([FileMeta]) -> Void)?
    /// A decrypted CHUNK frame's plaintext bytes, in wire order.
    public var onFileChunk: (([UInt8]) -> Void)?
    /// Cumulative bytes processed — advances on every acked receive and every
    /// transmitted send frame.
    public var onProgress: ((Int) -> Void)?
    /// A DONE frame arrived; the payload is whether its integrity hash matched.
    public var onDone: ((Bool) -> Void)?
    /// A raw (unencrypted) control byte — accept/reject/complete — arrived.
    /// Interpreting it is left to the caller; this class only transports it.
    public var onControl: ((RealtimeControl) -> Void)?
    /// The connection tore down (either side), fires at most once.
    public var onClose: (() -> Void)?
    public var onError: ((Error) -> Void)?

    // MARK: Wiring

    private let signaling: SignalingClient
    private let peerId: String
    private let role: Role
    private let handshake: HandshakeState

    /// Every delegate callback (WebRTC's own threads) and every signal handler
    /// hops onto this single serial queue before touching any mutable state
    /// below — the handshake/flow-control state is not otherwise thread-safe.
    private let queue = DispatchQueue(label: "im.relayium.RealtimeConnection")
    /// `send(sources:metas:)` runs its (documented-simplified) busy-poll loop
    /// here, never on `queue`, so it can't starve the ack/signal handlers that
    /// need `queue` to make progress.
    private let sendQueue = DispatchQueue(label: "im.relayium.RealtimeConnection.send", qos: .utility)

    private let factory: RTCPeerConnectionFactory
    private var pc: RTCPeerConnection?
    private var channel: RTCDataChannel?

    // MARK: State guarded by `queue`

    private var keys: SessionKeys?
    private var peerKeyDelivered = false
    private var receiver: RealtimeReceiver?
    private var sendWindow = SendWindow()
    private var ackPacer = AckPacer()
    private var written = 0
    private var sentTotal = 0
    private var openedSignaled = false
    private var closed = false
    /// One-shot guard for `send(sources:metas:)` — see
    /// `ConnectionError.alreadySending`.
    private var sendStarted = false
    /// Set when a CTRL_ACCEPT/CTRL_REJECT control frame arrives, gating the
    /// send path between the batch frame and the data frames (mirrors
    /// `web/src/lib/transfer-session.svelte.ts`'s `accepted` promise).
    private var accepted = false
    private var rejected = false

    public init(signaling: SignalingClient, peerId: String, role: Role, iceServers: [RTCIceServer], iceTransportPolicy: RTCIceTransportPolicy = .all) {
        self.signaling = signaling
        self.peerId = peerId
        self.role = role
        self.handshake = HandshakeState(role: role)
        ensureRTCSSL()
        self.factory = RTCPeerConnectionFactory()
        super.init()

        let config = RTCConfiguration()
        config.iceServers = iceServers
        config.sdpSemantics = .unifiedPlan
        // Relay-only on the cross-network path. ICE otherwise spends ~20s
        // failing direct candidate checks before falling back to the relay it
        // was always going to use; the caller decides, because a LAN room has
        // no relay to fall back to and must keep host candidates.
        config.iceTransportPolicy = iceTransportPolicy
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        self.pc = factory.peerConnection(with: config, constraints: constraints, delegate: self)

        signaling.onSignal = { [weak self] from, data in
            guard let self, from == self.peerId else { return }
            self.queue.async { self.handleSignal(data) }
        }
    }

    // MARK: - start

    /// Initiator: creates the DataChannel + offer. Responder: waits for the
    /// initiator's offer to arrive via `handleSignal`.
    public func start() {
        queue.async { [weak self] in self?.startLocked() }
    }

    private func startLocked() {
        guard !closed, let pc else { return }
        guard role == .initiator else { return }

        let dcConfig = RTCDataChannelConfiguration()
        dcConfig.isOrdered = true
        guard let dc = pc.dataChannel(forLabel: "data", configuration: dcConfig) else {
            onError?(ConnectionError.notReady)
            return
        }
        dc.delegate = self
        channel = dc

        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        pc.offer(for: constraints) { [weak self] sdp, error in
            guard let self else { return }
            self.queue.async {
                guard !self.closed else { return }
                guard let sdp, error == nil else {
                    self.onError?(error ?? ConnectionError.notReady)
                    return
                }
                pc.setLocalDescription(sdp) { error in
                    self.queue.async {
                        guard !self.closed else { return }
                        if let error {
                            self.onError?(error)
                            return
                        }
                        self.signaling.sendSignal(
                            to: self.peerId,
                            data: sdpSignal(kind: "offer", sdp: sdp.sdp, commit: self.handshake.selfCommitBase64)
                        )
                    }
                }
            }
        }
    }

    private func createAndSendAnswer() {
        guard !closed, let pc else { return }
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        pc.answer(for: constraints) { [weak self] sdp, error in
            guard let self else { return }
            self.queue.async {
                guard !self.closed else { return }
                guard let sdp, error == nil else {
                    self.onError?(error ?? ConnectionError.notReady)
                    return
                }
                pc.setLocalDescription(sdp) { error in
                    self.queue.async {
                        guard !self.closed else { return }
                        if let error {
                            self.onError?(error)
                            return
                        }
                        self.signaling.sendSignal(
                            to: self.peerId,
                            data: sdpSignal(kind: "answer", sdp: sdp.sdp, commit: self.handshake.selfCommitBase64)
                        )
                    }
                }
            }
        }
    }

    // MARK: - Signal handling (always on `queue`)

    private func handleSignal(_ data: JSONValue) {
        guard !closed, let pc else { return }

        // Record BEFORE handling the SDP — the anti-MITM ordering: answering an
        // offer sends our commit, and the peer's commit must already be on file
        // if a reveal arrives in the same signaling burst.
        if let commit = peerCommit(from: data) {
            try? handshake.recordPeerCommit(commit)
        }

        if let (type, sdp) = parseSDP(data) {
            let desc = RTCSessionDescription(type: type == "offer" ? .offer : .answer, sdp: sdp)
            pc.setRemoteDescription(desc) { [weak self] error in
                guard let self else { return }
                self.queue.async {
                    guard !self.closed else { return }
                    if let error {
                        self.onError?(error)
                        return
                    }
                    if type == "offer" {
                        self.createAndSendAnswer()
                    } else if type == "answer" {
                        // Initiator now holds the responder's commit — safe to reveal.
                        self.signaling.sendSignal(to: self.peerId, data: revealField(self.handshake.reveal()))
                    }
                }
            }
        }

        if let ice = parseICE(data) {
            let candidate = RTCIceCandidate(sdp: ice.candidate, sdpMLineIndex: ice.sdpMLineIndex ?? 0, sdpMid: ice.sdpMid)
            pc.add(candidate) { _ in
                // A candidate arriving before remoteDescription is set, or after
                // close, is non-fatal — mirrors webrtc-core.ts's addIceCandidate catch.
            }
        }

        if let reveal = peerReveal(from: data), !peerKeyDelivered {
            do {
                let result = try handshake.verifyPeerReveal(reveal)
                keys = result.keys
                receiver = RealtimeReceiver(sessionKey: result.keys.recv)
                peerKeyDelivered = true
                onSAS?(result.sas)
                // Responder learns the peer key from the reveal and only now
                // discloses its own; the initiator already revealed on the answer.
                if role == .responder {
                    signaling.sendSignal(to: peerId, data: revealField(handshake.reveal()))
                }
                maybeSignalOpen()
            } catch {
                // A commit mismatch means the key was chosen after seeing ours, or
                // was tampered in flight: abort hard rather than silently opening
                // the channel, which would defeat the SAS entirely.
                onError?(error)
                closeLocked()
            }
        }

        if parseBusy(data) {
            onError?(ConnectionError.peerBusy)
            closeLocked()
        }
    }

    private func maybeSignalOpen() {
        guard !openedSignaled, keys != nil, let channel, channel.readyState == .open else { return }
        openedSignaled = true
        onOpen?()
    }

    // MARK: - Inbound DataChannel messages (always on `queue`)

    private func handleInboundData(_ data: Data) {
        let bytes = [UInt8](data)

        if let ackedTotal = parseAck(bytes) {
            sendWindow.recordAck(Int(ackedTotal))
            return
        }
        if let control = parseControl(bytes) {
            switch control {
            case .accept: accepted = true
            case .reject: rejected = true
            case .complete: break
            }
            onControl?(control)
            return
        }
        guard let receiver else { return } // handshake not complete yet — drop

        do {
            switch try receiver.feed(bytes) {
            case .batch(let files):
                onManifest?(files)
            case .chunk(let d):
                onFileChunk?(d)
                written += d.count
                onProgress?(written)
                if let ackTotal = ackPacer.onWritten(total: written), let channel {
                    _ = channel.sendData(RTCDataBuffer(data: Data(ackFrame(Double(ackTotal))), isBinary: true))
                }
            case .done(let ok):
                onDone?(ok)
            case .resume:
                // RESUME_START is part of the resume-reconnect path, out of scope
                // for this fresh-connect shell.
                break
            }
        } catch {
            onError?(error)
        }
    }

    // MARK: - Receiver control replies

    /// The receiver accepts the incoming batch: sends CTRL_ACCEPT so the sender
    /// begins streaming data frames. Call this from `onManifest`. Mirrors the web
    /// receiver sending `ACCEPT` on the user's accept click.
    public func accept() { sendControl(.accept) }
    /// The receiver rejects the incoming batch (CTRL_REJECT); the sender aborts.
    public func reject() { sendControl(.reject) }
    /// The receiver signals it received and verified the whole batch (CTRL_COMPLETE).
    public func complete() { sendControl(.complete) }

    private func sendControl(_ c: RealtimeControl) {
        queue.async { [weak self] in
            guard let self, let ch = self.channel, !self.closed else { return }
            _ = ch.sendData(RTCDataBuffer(data: Data([c.rawValue]), isBinary: true))
        }
    }

    // MARK: - Send

    /// How long the send path will wait for a stalled step (the receiver's
    /// accept/reject decision, or forward progress while streaming data frames)
    /// before giving up. Mirrors the 60s stall timeout in
    /// `web/src/lib/transfer-session.svelte.ts`'s `creditGate`.
    private static let sendStallTimeout: TimeInterval = 60

    /// Streaming send: each file is read as it goes rather than taken whole up
    /// front, so what this holds is one chunk instead of one transfer.
    ///
    /// `metas` is what the receiver sees in the manifest; `sources` must be in
    /// the same order and declare the same sizes.
    public func send(sources: [PlaintextSource], metas: [FileMeta]) {
        let alreadyStarted = queue.sync { () -> Bool in
            if self.sendStarted { return true }
            self.sendStarted = true
            return false
        }
        guard !alreadyStarted else {
            queue.async { [weak self] in self?.onError?(ConnectionError.alreadySending) }
            return
        }
        sendQueue.async { [weak self] in self?.streamOnSendQueue(sources: sources, metas: metas) }
    }

    /// The only send path. A whole-transfer twin taking `[(FileMeta, [UInt8])]`
    /// used to sit beside this one; it was removed once nothing called it,
    /// because it was a public door back into the peak-memory-equals-transfer
    /// behaviour this replaced.
    private func streamOnSendQueue(sources: [PlaintextSource], metas: [FileMeta]) {
        guard let sendKey = queue.sync(execute: { self.keys?.send }) else {
            queue.async { [weak self] in self?.onError?(ConnectionError.notReady) }
            return
        }
        let sender = RealtimeSender(sessionKey: sendKey)
        do {
            guard transmit(try sender.batchFrame(metas)) else { return }
            guard waitForAccept() else { return }

            // One sender for both halves: seq is global, so the producer must
            // continue the counter batchFrame already advanced.
            let producer = RealtimeFrameProducer(sender: sender, sources: sources,
                                                 declaredSizes: metas.map(\.size))
            // `RealtimeFrameProducer.next()` drains its own reads; this pool is
            // for the other half — `transmit` builds a `Data` and an
            // `RTCDataBuffer` per frame, and this loop does not return until the
            // whole transfer is out. Not unit-testable (this class needs two
            // live peers); the guard is the live 512 MB footprint run.
            while true {
                let more = try autoreleasepool { () throws -> Bool in
                    guard let frame = try producer.next() else { return false }
                    if queue.sync(execute: { self.closed }) { return false }
                    return transmit(frame)
                }
                if !more { return }
            }
        } catch {
            queue.async { [weak self] in self?.onError?(error) }
        }
    }

    /// Busy-polls (on `sendQueue`, never `queue`) until the receiver has
    /// accepted or rejected the batch, the connection closes, or the stall
    /// deadline elapses. Returns `true` only on acceptance.
    private func waitForAccept() -> Bool {
        let deadline = Date().addingTimeInterval(Self.sendStallTimeout)
        while true {
            let (accepted, rejected, isClosed) = queue.sync { () -> (Bool, Bool, Bool) in
                (self.accepted, self.rejected, self.closed)
            }
            if isClosed { return false }
            if rejected {
                queue.async { [weak self] in self?.onError?(ConnectionError.rejected) }
                return false
            }
            if accepted { return true }
            if Date() >= deadline {
                queue.async { [weak self] in self?.onError?(ConnectionError.timedOut) }
                return false
            }
            Thread.sleep(forTimeInterval: 0.005)
        }
    }

    /// SIMPLIFICATION: gates each frame by busy-polling `SendWindow.maySend` and
    /// the DataChannel's `bufferedAmount` rather than awaiting
    /// `didChangeBufferedAmount`/a completion signal. Acceptable for this
    /// integration shell (per the task brief); a production driver should await
    /// the async signal instead of polling.
    ///
    /// Bounded by the same stall deadline as `waitForAccept()` so a receiver
    /// that stops acking (window never opens back up) doesn't spin forever —
    /// mirrors the web's `creditGate` stall timeout. Returns `false` (having
    /// already reported `onError`) on close or timeout without sending.
    @discardableResult
    private func transmit(_ frame: [UInt8]) -> Bool {
        let deadline = Date().addingTimeInterval(Self.sendStallTimeout)
        while true {
            let (ready, isClosed) = queue.sync { () -> (Bool, Bool) in
                guard !self.closed else { return (false, true) }
                guard let channel = self.channel else { return (false, false) }
                return (self.sendWindow.maySend && channel.bufferedAmount <= UInt64(FLOW_WINDOW), false)
            }
            if isClosed { return false }
            if ready { break }
            if Date() >= deadline {
                queue.async { [weak self] in self?.onError?(ConnectionError.timedOut) }
                return false
            }
            Thread.sleep(forTimeInterval: 0.005)
        }
        queue.sync {
            guard !self.closed, let channel = self.channel else { return }
            if channel.sendData(RTCDataBuffer(data: Data(frame), isBinary: true)) {
                self.sendWindow.recordSent(frame.count)
                self.sentTotal += frame.count
                self.onProgress?(self.sentTotal)
            }
        }
        return true
    }

    // MARK: - Close

    public func close() {
        queue.async { [weak self] in self?.closeLocked() }
    }

    private func closeLocked() {
        guard !closed else { return }
        closed = true
        channel?.delegate = nil
        channel = nil
        pc?.delegate = nil
        pc?.close()
        signaling.onSignal = nil
        onClose?()
    }

    /// Safety net for a caller that drops its last reference without calling
    /// `close()`: makes sure WebRTC's `pc`/`channel` never hold `self` as a
    /// (non-ARC-tracked, from the C++ layer's point of view) delegate past this
    /// instance's lifetime, and that `signaling` can't invoke a dead handler.
    ///
    /// Deliberately does NOT call `close()`/`closeLocked()` via `queue`:
    /// `close()`'s `queue.async { [weak self] ... }` forms a *new* weak
    /// reference to `self`, and on an `NSObject` subclass the Objective-C
    /// runtime traps ("Cannot form weak reference ... in the process of
    /// deallocation") if that happens once `deinit` has started — confirmed
    /// empirically, not a theoretical concern. `queue.sync` isn't safe either:
    /// if this is the very last strong reference and it was released while
    /// already executing on `queue` (e.g. inside a `queue.async` closure that
    /// captured `self` strongly), a nested `queue.sync` here would deadlock.
    /// By the time `deinit` runs, no strong reference to `self` can remain —
    /// ARC guarantees that — so nothing else can be concurrently mutating this
    /// state via a legitimate strong-ref path, and it's safe to tear down
    /// directly without hopping onto `queue` at all.
    deinit {
        channel?.delegate = nil
        channel = nil
        pc?.delegate = nil
        pc?.close()
        signaling.onSignal = nil
    }
}

// MARK: - RTCPeerConnectionDelegate

extension RealtimeConnection: RTCPeerConnectionDelegate {
    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}

    public func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}

    public func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}

    public func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}

    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}

    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}

    public func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            self.signaling.sendSignal(
                to: self.peerId,
                data: iceSignal(candidate.sdp, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex)
            )
        }
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    public func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            dataChannel.delegate = self
            self.channel = dataChannel
            self.maybeSignalOpen()
        }
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        queue.async { [weak self] in
            guard let self else { return }
            switch newState {
            case .failed:
                self.onError?(ConnectionError.peerConnectionFailed)
                self.closeLocked()
            case .closed:
                self.closeLocked()
            default:
                break
            }
        }
    }
}

// MARK: - RTCDataChannelDelegate

extension RealtimeConnection: RTCDataChannelDelegate {
    public func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            if dataChannel.readyState == .open {
                self.maybeSignalOpen()
            }
        }
    }

    public func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            self.handleInboundData(buffer.data)
        }
    }
}
