import Foundation
import WebRTC

/// True once the WebRTC framework is linked and a peer-connection factory can be
/// constructed. A link-time smoke check, independent of `RealtimeConnection` below.
public func webrtcAvailable() -> Bool {
    RTCInitializeSSL()
    let factory = RTCPeerConnectionFactory()
    let ok = String(describing: type(of: factory)) == "RTCPeerConnectionFactory"
    RTCCleanupSSL()
    return ok
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
    /// `send(files:)` runs its (documented-simplified) busy-poll loop here,
    /// never on `queue`, so it can't starve the ack/signal handlers that need
    /// `queue` to make progress.
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

    public init(signaling: SignalingClient, peerId: String, role: Role, iceServers: [RTCIceServer]) {
        self.signaling = signaling
        self.peerId = peerId
        self.role = role
        self.handshake = HandshakeState(role: role)
        RTCInitializeSSL()
        self.factory = RTCPeerConnectionFactory()
        super.init()

        let config = RTCConfiguration()
        config.iceServers = iceServers
        config.sdpSemantics = .unifiedPlan
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

    // MARK: - Send

    /// Seals the manifest + file bytes with the derived session key and streams
    /// them over the DataChannel, gated by `SendWindow` (receiver ack credit) and
    /// the SCTP send buffer.
    public func send(files: [(meta: FileMeta, data: [UInt8])]) {
        sendQueue.async { [weak self] in self?.sendOnSendQueue(files: files) }
    }

    private func sendOnSendQueue(files: [(meta: FileMeta, data: [UInt8])]) {
        guard let sendKey = queue.sync(execute: { self.keys?.send }) else {
            queue.async { [weak self] in self?.onError?(ConnectionError.notReady) }
            return
        }
        let sender = RealtimeSender(sessionKey: sendKey)
        do {
            let batch = try sender.batchFrame(files.map { $0.meta })
            transmit(batch)
            for frame in sender.dataFrames(files) {
                if queue.sync(execute: { self.closed }) { return }
                transmit(frame)
            }
        } catch {
            queue.async { [weak self] in self?.onError?(error) }
        }
    }

    /// SIMPLIFICATION: gates each frame by busy-polling `SendWindow.maySend` and
    /// the DataChannel's `bufferedAmount` rather than awaiting
    /// `didChangeBufferedAmount`/a completion signal. Acceptable for this
    /// integration shell (per the task brief); a production driver should await
    /// the async signal instead of polling.
    private func transmit(_ frame: [UInt8]) {
        while true {
            let (ready, isClosed) = queue.sync { () -> (Bool, Bool) in
                guard !self.closed else { return (false, true) }
                guard let channel = self.channel else { return (false, false) }
                return (self.sendWindow.maySend && channel.bufferedAmount <= UInt64(FLOW_WINDOW), false)
            }
            if isClosed { return }
            if ready { break }
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
