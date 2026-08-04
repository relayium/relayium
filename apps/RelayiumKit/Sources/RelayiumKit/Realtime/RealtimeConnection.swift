import Foundation
import os
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
    private static let iceLog = Logger(subsystem: "com.relayium", category: "ice")
    private static let textLog = Logger(subsystem: "com.relayium", category: "text")
    public enum ConnectionError: Error, Equatable {
        /// The peer declined the offer because it is already mid-transfer.
        case peerBusy
        /// A text connection reached SDP without the peer confirming exact
        /// capability text/1. Never send kind 9 speculatively to an old peer.
        case unsupportedPeer
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
        case textSendBufferFull
        case textSendFailed
        case textReceiveBufferFull
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
    /// One authenticated text body and its framed byte count.
    public var onText: ((String, Int) -> Void)?
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
    private let generation: RealtimeGeneration
    private let localCapabilities: [String]
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
    private var textSender: RealtimeTextSender?
    private var textReceiver: RealtimeTextReceiver?
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
    private var pendingControls: [RealtimeControl] = []
    /// Initiators may learn peer consent before their user finishes comparing
    /// the SAS. Hold ciphertext only; local confirmation drains it in order.
    private var pendingTextFrames: [Data] = []
    private var pendingTextBytes = 0
    private var textSASConfirmedLocally = false
    /// Set before responder ACCEPT is sent, so inbound decryption is enabled
    /// before the initiator can react to that control frame.
    private var textAcceptedLocally = false

    public static let textSendBufferMaximum: UInt64 = 1 << 20
    /// Match the session's token-bucket burst: a peer that sends a 21st frame
    /// before verification is not allowed to turn deferred delivery into a
    /// post-confirmation rate-limit failure.
    private static let pendingTextFrameMaximum = 20
    private static let pendingTextByteMaximum = 4 << 20

    public var textBufferedAmount: UInt64 {
        queue.sync { channel?.bufferedAmount ?? 0 }
    }

    public init(signaling: SignalingClient,
                peerId: String,
                role: Role,
                iceServers: [RTCIceServer],
                iceTransportPolicy: RTCIceTransportPolicy = .all,
                generation: RealtimeGeneration = .file,
                localCapabilities: [String] = []) {
        self.signaling = signaling
        self.peerId = peerId
        self.role = role
        self.generation = generation
        self.localCapabilities = localCapabilities
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

        // Claimed with a token rather than by assigning `onSignal`, so that
        // `closeLocked`/`deinit` can hand the slot back without being able to
        // erase a *newer* connection's handler. Two connections overlap on one
        // socket routinely — the nearby room's socket is shared and a session
        // ends while the next is already being built — and this side of that
        // race is unordered: an old connection's close, or its deallocation, can
        // land at any point after the new one installed itself.
        self.signalToken = signaling.installSignalHandler { [weak self] from, data in
            guard let self, from == self.peerId,
                  signalGeneration(data) == self.generation else { return }
            self.queue.async { self.handleSignal(data) }
        }
    }

    /// Which installation of `signaling.onSignal` is ours. Written once, here in
    /// `init` before any other thread can reach this object, and only ever read.
    private var signalToken: SignalHandlerToken?

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
                            data: sdpSignal(
                                kind: "offer",
                                sdp: sdp.sdp,
                                commit: self.handshake.selfCommitBase64,
                                generation: self.generation,
                                caps: self.localCapabilities
                            )
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
                            data: sdpSignal(
                                kind: "answer",
                                sdp: sdp.sdp,
                                commit: self.handshake.selfCommitBase64,
                                generation: self.generation,
                                caps: self.localCapabilities
                            )
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
            if generation == .text, !peerKeyDelivered,
               !peerCaps(from: data).contains("text/1") {
                onError?(ConnectionError.unsupportedPeer)
                closeLocked()
                return
            }
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
                        self.signaling.sendSignal(
                            to: self.peerId,
                            data: taggedSignal(
                                revealField(self.handshake.reveal()),
                                generation: self.generation
                            )
                        )
                    }
                }
            }
        }

        if let ice = parseICE(data) {
            Self.iceLog.notice(
                "remote candidate generation=\(String(describing: self.generation), privacy: .public) relay=\(ice.candidate.contains(" typ relay"), privacy: .public)"
            )
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
                if generation == .text {
                    textSender = RealtimeTextSender()
                    textReceiver = RealtimeTextReceiver()
                } else {
                    receiver = RealtimeReceiver(sessionKey: result.keys.recv)
                }
                peerKeyDelivered = true
                onSAS?(result.sas)
                // Responder learns the peer key from the reveal and only now
                // discloses its own; the initiator already revealed on the answer.
                if role == .responder {
                    signaling.sendSignal(
                        to: peerId,
                        data: taggedSignal(
                            revealField(handshake.reveal()),
                            generation: generation
                        )
                    )
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
        for control in pendingControls {
            _ = channel.sendData(
                RTCDataBuffer(data: Data([control.rawValue]), isBinary: true)
            )
        }
        pendingControls = []
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
            case .accept:
                accepted = true
                drainPendingTextFramesIfReady()
            case .reject: rejected = true
            case .complete: break
            }
            onControl?(control)
            return
        }
        if generation == .text {
            if role == .initiator, accepted, !textSASConfirmedLocally {
                guard pendingTextFrames.count < Self.pendingTextFrameMaximum,
                      pendingTextBytes + data.count <= Self.pendingTextByteMaximum else {
                    onError?(ConnectionError.textReceiveBufferFull)
                    closeLocked()
                    return
                }
                pendingTextFrames.append(data)
                pendingTextBytes += data.count
            } else {
                processTextFrame(bytes)
            }
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
            case .pending:
                // A non-final piece of a fragmented logical chunk: authenticated
                // and buffered by the receiver, but nothing is written, hashed or
                // acked until the whole chunk has arrived.
                break
            case .resume:
                // RESUME_START is part of the resume-reconnect path, out of scope
                // for this fresh-connect shell.
                break
            }
        } catch {
            onError?(error)
        }
    }

    private func processTextFrame(_ bytes: [UInt8]) {
        // Before consent or local SAS confirmation, inspect no plaintext.
        let mayReceive = (role == .responder && textAcceptedLocally)
            || (role == .initiator && accepted && textSASConfirmedLocally)
        guard mayReceive, let keys, let textReceiver else { return }
        do {
            let body = try textReceiver.receive(
                frame: bytes,
                key: deriveTextKey(sessionKey: keys.recv)
            )
            onText?(body, bytes.count)
        } catch {
            Self.textLog.error(
                "receive failed error=\(String(describing: error), privacy: .public) frameBytes=\(bytes.count, privacy: .private)"
            )
            onError?(error)
            closeLocked()
        }
    }

    private func drainPendingTextFramesIfReady() {
        guard role == .initiator, accepted, textSASConfirmedLocally else { return }
        let frames = pendingTextFrames
        pendingTextFrames = []
        pendingTextBytes = 0
        for frame in frames where !closed {
            processTextFrame([UInt8](frame))
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

    public func confirmTextSAS() {
        queue.async { [weak self] in
            guard let self, self.generation == .text, self.role == .initiator,
                  !self.closed else { return }
            self.textSASConfirmedLocally = true
            self.drainPendingTextFramesIfReady()
        }
    }

    public func acceptText() {
        queue.async { [weak self] in
            guard let self, self.generation == .text, self.role == .responder,
                  !self.closed else { return }
            self.textAcceptedLocally = true
            self.sendControlLocked(.accept)
        }
    }

    public func rejectText() {
        queue.async { [weak self] in
            guard let self, self.generation == .text, !self.closed else { return }
            self.sendControlLocked(.reject)
            self.closeLocked()
        }
    }

    private func sendControl(_ c: RealtimeControl) {
        queue.async { [weak self] in
            self?.sendControlLocked(c)
        }
    }

    private func sendControlLocked(_ c: RealtimeControl) {
        guard let ch = channel, !closed else { return }
        guard ch.readyState == .open else {
            if !pendingControls.contains(c) { pendingControls.append(c) }
            return
        }
        _ = ch.sendData(RTCDataBuffer(data: Data([c.rawValue]), isBinary: true))
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

    /// Queue ownership serializes the sender's nonce/order state even when the
    /// UI submits twice in quick succession.
    public func sendText(_ body: String, completion: @escaping (Error?) -> Void) {
        queue.async { [weak self] in
            guard let self, self.generation == .text, !self.closed,
                  let channel = self.channel, channel.readyState == .open,
                  let keys = self.keys, let sender = self.textSender else {
                completion(ConnectionError.notReady)
                return
            }
            let maySend = (self.role == .initiator
                && self.accepted
                && self.textSASConfirmedLocally)
                || (self.role == .responder && self.textAcceptedLocally)
            guard maySend else {
                completion(ConnectionError.notReady)
                return
            }
            guard channel.bufferedAmount <= Self.textSendBufferMaximum else {
                completion(ConnectionError.textSendBufferFull)
                return
            }
            do {
                let sent = try sender.enqueueFrame(
                    body: body,
                    key: deriveTextKey(sessionKey: keys.send)
                ) { frame in
                    channel.sendData(
                        RTCDataBuffer(data: Data(frame), isBinary: true)
                    )
                }
                guard sent else {
                    completion(ConnectionError.textSendFailed)
                    return
                }
                completion(nil)
            } catch {
                completion(error)
            }
        }
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
        releaseSignalSlot()
        onClose?()
    }

    /// Give the slot back, but only if it is still ours. A connection that
    /// closes after a newer one has claimed the socket must leave that newer
    /// handler alone — clearing it strands the new session, which then waits
    /// forever for an answer nobody will route to it.
    private func releaseSignalSlot() {
        guard let signalToken else { return }
        signaling.removeSignalHandler(signalToken)
    }

    /// Safety net for a caller that drops its last reference without calling
    /// `close()`: makes sure WebRTC's `pc`/`channel` never hold `self` as a
    /// (non-ARC-tracked, from the C++ layer's point of view) delegate past this
    /// instance's lifetime, and that the signalling slot is handed back if it is
    /// still ours. The handler itself captures `self` weakly, so a slot we no
    /// longer own was never a route into a dead object — the reason to release
    /// here is to leave the socket answerable, not to defuse a dangling call.
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
        releaseSignalSlot()
    }
}

// MARK: - RTCPeerConnectionDelegate

extension RealtimeConnection: RTCPeerConnectionDelegate {
    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}

    public func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}

    public func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}

    public func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}

    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        Self.iceLog.notice(
            "connection state generation=\(String(describing: self.generation), privacy: .public) state=\(String(describing: newState), privacy: .public)"
        )
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        Self.iceLog.notice(
            "gathering state generation=\(String(describing: self.generation), privacy: .public) state=\(String(describing: newState), privacy: .public)"
        )
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        Self.iceLog.notice(
            "local candidate generation=\(String(describing: self.generation), privacy: .public) relay=\(candidate.sdp.contains(" typ relay"), privacy: .public)"
        )
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            self.signaling.sendSignal(
                to: self.peerId,
                data: taggedSignal(
                    iceSignal(
                        candidate.sdp,
                        sdpMid: candidate.sdpMid,
                        sdpMLineIndex: candidate.sdpMLineIndex
                    ),
                    generation: self.generation
                )
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
