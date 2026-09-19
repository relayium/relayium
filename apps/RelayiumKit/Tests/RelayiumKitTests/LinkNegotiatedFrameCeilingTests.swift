import XCTest
@testable import RelayiumKit

/// A transport that reports a per-message ceiling of its own.
///
/// Deliberately its own fake rather than a parameter on an existing one: every
/// test here is about a number the LANES have to ask the transport for, and the
/// point of a separate double is that `negotiatedMaxMessageBytes` is set BEFORE
/// the driver takes the transport over — which is the only moment a driver is
/// allowed to read it.
///
/// It also records every byte that left, per lane, so "no frame exceeded the
/// ceiling" is an assertion over the actual wire rather than over a producer's
/// intent.
final class CeilingTransport: LinkReplacementTransport, LinkLiveTransport, @unchecked Sendable {
    private let slots = NSLock()
    private let state = NSLock()

    private var _onReady: ((LinkIdentity) -> Void)?
    private var _onFrame: ((LinkLane, [UInt8]) -> Void)?
    private var _onError: ((Error) -> Void)?
    private var _onClose: (() -> Void)?

    var onReady: ((LinkIdentity) -> Void)? {
        get { slots.lock(); defer { slots.unlock() }; return _onReady }
        set { slots.lock(); defer { slots.unlock() }; _onReady = newValue }
    }
    var onFrame: ((LinkLane, [UInt8]) -> Void)? {
        get { slots.lock(); defer { slots.unlock() }; return _onFrame }
        set { slots.lock(); defer { slots.unlock() }; _onFrame = newValue }
    }
    var onError: ((Error) -> Void)? {
        get { slots.lock(); defer { slots.unlock() }; return _onError }
        set { slots.lock(); defer { slots.unlock() }; _onError = newValue }
    }
    var onClose: (() -> Void)? {
        get { slots.lock(); defer { slots.unlock() }; return _onClose }
        set { slots.lock(); defer { slots.unlock() }; _onClose = newValue }
    }

    private var _negotiated: Double

    /// What this transport's association negotiated. A plain leaf-guarded read:
    /// it must never enter a transport queue, because a lane asks for it from
    /// inside its own initializer and from an attach that is about to take a
    /// driver lock.
    var negotiatedMaxMessageBytes: Double {
        slots.lock(); defer { slots.unlock() }; return _negotiated
    }

    /// Defaults to `DEFAULT_MAX_FRAME_BYTES`, never `.infinity`: a double must
    /// not claim "no ceiling at all" by default. A test that wants an unbounded
    /// association says so.
    init(negotiated: Double = DEFAULT_MAX_FRAME_BYTES) { self._negotiated = negotiated }

    private var _sent: [(lane: LinkLane, bytes: [UInt8])] = []
    private var _closed = false

    func send(_ bytes: [UInt8], on lane: LinkLane) throws {
        state.lock()
        let closed = _closed
        if !closed { _sent.append((lane, bytes)) }
        state.unlock()
        if closed { throw LinkTransportError.closed }
    }

    func bufferedAmount(on lane: LinkLane) -> UInt64 { 0 }
    var isClosed: Bool { state.lock(); defer { state.unlock() }; return _closed }
    func close() { state.lock(); _closed = true; state.unlock() }
    func start() {}
    func receive(from: String, signal: JSONValue) {}

    func sent(on lane: LinkLane) -> [[UInt8]] {
        state.lock(); defer { state.unlock() }
        return _sent.filter { $0.lane == lane }.map(\.bytes)
    }

    func takeSent(on lane: LinkLane) -> [[UInt8]] {
        state.lock(); defer { state.unlock() }
        let taken = _sent.filter { $0.lane == lane }.map(\.bytes)
        _sent.removeAll { $0.lane == lane }
        return taken
    }

    /// Deliver one frame the way a live transport would.
    func deliver(_ lane: LinkLane, _ bytes: [UInt8]) { onFrame?(lane, bytes) }
}

/// What the peer actually received, reassembled in manifest order.
private final class ReceivedFiles {
    var files: [[UInt8]] = [[]]
    var finalized = 0

    func openFile(_ index: Int) {
        while files.count <= index { files.append([]) }
    }
    func write(_ index: Int, _ bytes: [UInt8]) {
        openFile(index)
        files[index] += bytes
    }
}

/// The negotiated per-message ceiling, followed all the way to the wire.
///
/// ## Why this file exists separately from `LinkMessageCeilingTests`
///
/// Everything here is expressed in terms of the API that already existed, so it
/// can be compiled and RUN against unmodified production code. That is what
/// makes it a negative control rather than a description of the patch: each
/// test below fails on the original `LinkFileDriver`/`LinkTextDriver`/
/// `LinkFileSession`, which ignore what the transport negotiated and size every
/// outbound frame from a `let` fixed at construction.
///
/// The parser itself and the two real WebRTC transports' wiring are in
/// `LinkMessageCeilingTests`, which names new API and therefore cannot compile
/// against the baseline at all.
final class LinkNegotiatedFrameCeilingTests: XCTestCase {

    private let C = CHUNK_SIZE
    private let ownerSendKey = [UInt8](repeating: 0x51, count: 32)
    private let ownerRecvKey = [UInt8](repeating: 0x52, count: 32)

    private func meta(_ name: String, _ size: Int) -> FileMeta { FileMeta(name: name, size: size) }

    // MARK: - a real sender over a transport with a ceiling

    private struct Rig {
        let owner: LinkLaneOwner
        let transport: CeilingTransport
        let identity: LinkIdentity
        let codecs: LinkCodecs
        /// The receiving half of the SAME link, as a real session: mirrored
        /// codecs, so everything the owner seals really authenticates and every
        /// fragment really reassembles.
        let peer: LinkFileSession
        let received: ReceivedFiles
        let events: FileEvents
    }

    final class FileEvents: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [LinkFileDriverEvent] = []
        func append(_ event: LinkFileDriverEvent) { lock.lock(); items.append(event); lock.unlock() }
        var all: [LinkFileDriverEvent] { lock.lock(); defer { lock.unlock() }; return items }
    }

    /// - Parameters:
    ///   - negotiated: what the INITIAL transport advertises.
    ///   - localPolicy: the lane's own cap. `DEFAULT_MAX_FRAME_BYTES` unless a
    ///     test is specifically about local policy, because that is what
    ///     production passes and what makes the transport's number the only
    ///     thing under test.
    private func rig(negotiated: Double,
                     localPolicy: Double = DEFAULT_MAX_FRAME_BYTES) -> Rig {
        let codecs = LinkCodecs(sendKey: ownerSendKey, recvKey: ownerRecvKey)
        let identity = LinkIdentity(peerId: "peer-b", role: .initiator, sas: "123456",
                                    codecs: codecs)
        let transport = CeilingTransport(negotiated: negotiated)
        let events = FileEvents()
        let owner = LinkLaneOwner(
            identity: identity,
            transport: transport,
            scheduler: FakeLinkScheduler(),
            destinationFactory: { _, _ in FakeDestination() },
            ackInterval: 1,
            maxFrameBytes: localPolicy,
            sendBufferPollInterval: 0.01,
            onTextEvent: { _ in },
            onFileEvent: { events.append($0) })
        let peer = LinkFileSession(codecs: LinkCodecs(sendKey: ownerRecvKey,
                                                      recvKey: ownerSendKey),
                                   ackInterval: 1)
        return Rig(owner: owner, transport: transport, identity: identity, codecs: codecs,
                   peer: peer, received: ReceivedFiles(), events: events)
    }

    /// Run one side's effects the way a driver must: depth first, so a write is
    /// reported back before the next protected frame is admitted. That IS the
    /// receive FIFO the session requires.
    private func feed(_ rig: Rig, _ effects: [LinkFileSessionEffect]) {
        for effect in effects {
            switch effect {
            case let .sendFrame(frame):
                // Through the COORDINATOR's route, which is the one that stays
                // correct across a transport swap. `CeilingTransport.deliver`
                // would go through the slot the file driver installed on the
                // INITIAL transport, and the driver drops a frame whose
                // transport is no longer current — so a replacement's answers
                // would silently reach nobody.
                rig.owner.routeCurrentFrame(lane: .file, bytes: frame)
            case .armConsentTimeout(_, .inbound):
                feed(rig, rig.peer.acceptInbound())
            case let .createDestination(batch, _):
                feed(rig, rig.peer.didCreateDestination(batch: batch))
            case let .openFile(batch, index, checkpoint):
                rig.received.openFile(index)
                feed(rig, rig.peer.didPersist(batch: batch, checkpoint: checkpoint))
            case let .persistChunk(batch, bytes, checkpoint):
                rig.received.write(checkpoint.index, bytes)
                feed(rig, rig.peer.didPersist(batch: batch, checkpoint: checkpoint))
            case let .finalizeDestination(batch):
                rig.received.finalized += 1
                feed(rig, rig.peer.didFinalizeDestination(batch: batch))
            case let .abortDestination(batch):
                XCTFail("nothing in a clean transfer aborts a destination (\(batch))")
            default:
                continue   // timers and credit signalling belong to a real driver
            }
        }
    }

    /// Move everything the owner put on the file lane into the peer, and
    /// everything the peer answered back, until both are quiescent.
    ///
    /// - Returns: every frame the owner put on the FILE lane, in order.
    @discardableResult
    private func runTransfer(_ rig: Rig, on transport: CeilingTransport? = nil) -> [[UInt8]] {
        let wireTransport = transport ?? rig.transport
        var wire: [[UInt8]] = []
        for _ in 0..<4000 {
            rig.owner.settle()
            let outbound = wireTransport.takeSent(on: .file)
            if outbound.isEmpty { return wire }
            wire += outbound
            for frame in outbound { feed(rig, rig.peer.admitFrame(frame)) }
        }
        XCTFail("the transfer never became quiescent")
        return wire
    }

    /// A folder send big enough that its MANIFEST alone cannot fit a 64 KiB
    /// message: 1000 entries with realistic nested paths.
    ///
    /// This is the shape `LinkFileSession.pump` used to seal with
    /// `batchFrames(head.files)` and no ceiling at all — the largest frame the
    /// lane ever produces, and the FIRST one it sends.
    private func bigManifest() -> [FileMeta] {
        (0..<MAX_FILES).map { index in
            FileMeta(name: String(format: "part-%08d.bin", index),
                     size: 0,
                     path: "shoot/2026-09-19/camera-a/raw/sequence-\(index)/part-\(index).bin")
        }
    }

    // ── the manifest ────────────────────────────────────────────────────────

    /// A manifest too large for the negotiated message size is FRAGMENTED, not
    /// sent whole.
    ///
    /// The original code reached `codecs.fileSender.batchFrames(head.files)`
    /// with the default allowance, so this emitted one `BATCH_ENC` of about
    /// 120 KB at a peer that can receive 64 KiB. Fixing only the file
    /// producer would have left exactly this frame oversized.
    func testALargeManifestIsFragmentedToWhatTheConnectionNegotiated() throws {
        let r = rig(negotiated: 65_536)
        let files = bigManifest()

        _ = try r.owner.enqueueFiles(files: files, stage: { [] })
        r.owner.pumpFiles()
        r.owner.settle()

        let wire = r.transport.sent(on: .file)
        XCTAssertFalse(wire.isEmpty, "the manifest was sent")
        let biggest = wire.map(\.count).max() ?? 0
        XCTAssertLessThanOrEqual(biggest, 65_536,
                                 "a frame of \(biggest) B cannot be sent to a peer that "
                                 + "negotiated 65 536")
        XCTAssertTrue(wire.contains { $0.first == RealtimeKind.batchPart },
                      "a manifest this size has to be cut into pieces")
        XCTAssertTrue(wire.contains { $0.first == RealtimeKind.batchEnc },
                      "and terminated by the final piece")

        // The receiving half of the same link reassembles it, which is what
        // proves the fragmentation is the protocol's and not a truncation.
        for frame in wire { feed(r, r.peer.admitFrame(frame)) }
        XCTAssertEqual(r.peer.inboundFiles, files, "byte-exact, in manifest order")
        XCTAssertFalse(r.peer.laneFailed)
    }

    // ── file bytes ──────────────────────────────────────────────────────────

    /// Every frame of a complete multi-file transfer fits the negotiated
    /// ceiling, and every byte arrives.
    ///
    /// 65 536 is the RFC 8841 default — the ceiling a peer that advertises
    /// nothing imposes — and the local policy here is production's own
    /// `DEFAULT_MAX_FRAME_BYTES` (192 KiB + 21), so the ONLY thing that can
    /// bound these frames is the number the transport reports.
    func testAWholeTransferFitsA65536CeilingAndArrivesByteExact() throws {
        try assertCompleteTransfer(ceiling: 65_536)
    }

    /// The same at an awkward, unaligned ceiling. 8117 is not a power of two,
    /// is not a multiple of the chunk size and leaves 8096 usable bytes, so a
    /// 192 KiB chunk lands on 25 pieces with a short tail — the case an
    /// off-by-one in the piece arithmetic shows up in.
    func testAWholeTransferFitsAn8117CeilingAndArrivesByteExact() throws {
        try assertCompleteTransfer(ceiling: 8_117)
    }

    private func assertCompleteTransfer(ceiling: Double,
                                        file: StaticString = #filePath,
                                        line: UInt = #line) throws {
        let r = rig(negotiated: ceiling)
        let first = WireVectors.content(2 * C + 7, seed: 71)
        let second = WireVectors.content(40, seed: 72)
        let files = [meta("one.bin", first.count), meta("two.bin", second.count)]

        let batch = try r.owner.enqueueFiles(files: files, stage: {
            [DataSource(name: "one.bin", bytes: first), DataSource(name: "two.bin", bytes: second)]
        })
        r.owner.pumpFiles()
        let wire = runTransfer(r)

        let biggest = wire.map(\.count).max() ?? 0
        XCTAssertLessThanOrEqual(Double(biggest), ceiling,
                                 "a \(biggest) B frame does not fit a \(ceiling) B message",
                                 file: file, line: line)
        XCTAssertTrue(wire.contains { $0.first == RealtimeKind.chunkPart },
                      "a 192 KiB chunk has to be cut at this ceiling",
                      file: file, line: line)
        XCTAssertEqual(r.received.files, [first, second],
                       "byte-exact through a real producer, fragmented and reassembled",
                       file: file, line: line)
        XCTAssertEqual(WireVectors.sha256Hex(r.received.files.flatMap { $0 }),
                       WireVectors.sha256Hex(first + second),
                       "and the content hash matches, so no piece was lost or reordered",
                       file: file, line: line)
        XCTAssertEqual(r.received.finalized, 1, "finalised exactly once", file: file, line: line)
        XCTAssertFalse(r.peer.laneFailed, file: file, line: line)
        XCTAssertFalse(r.owner.isFileTerminal, file: file, line: line)
        XCTAssertTrue(r.events.all.contains(.outboundFinished(batch: batch, ok: true)),
                      "the batch completed", file: file, line: line)
    }

    // ── a replacement that negotiates LESS ──────────────────────────────────

    /// A rebuild negotiates its own association. One that settled on LESS binds
    /// the next producer, the next manifest and the next message — the
    /// establishment-time number must not survive the swap.
    ///
    /// The initial transport here reports `.infinity` on purpose: nothing about
    /// this test can be explained by the first connection's ceiling.
    func testAReplacementNegotiatingLessBindsTheNextProducerAndManifest() throws {
        let body = WireVectors.content(2 * C + 7, seed: 73)
        // A manifest far too large for one 64 KiB message, with a real file
        // behind it, so BOTH the session's own sealing and the producer's are
        // under whatever bound is in force.
        var files = (0..<(MAX_FILES - 1)).map { index in
            FileMeta(name: String(format: "part-%08d.bin", index),
                     size: 0,
                     path: "shoot/2026-09-19/camera-a/raw/sequence-\(index)/part-\(index).bin")
        }
        files.append(meta("two.bin", body.count))
        let stage: () -> [PlaintextSource] = {
            files.map { DataSource(name: $0.name, bytes: $0.size == 0 ? [] : body) }
        }

        // The control: the SAME batch on an association that reports no ceiling
        // really does go out in whole chunks. Without this the assertion below
        // could be satisfied by a transfer that was always small.
        let unbounded = rig(negotiated: .infinity)
        _ = try unbounded.owner.enqueueFiles(files: files, stage: stage)
        unbounded.owner.pumpFiles()
        let control = runTransfer(unbounded).map(\.count).max() ?? 0
        XCTAssertGreaterThan(control, 65_536,
                             "an unbounded association carries whole chunks, so what "
                             + "changes below is the negotiated ceiling and nothing else")

        // The subject: the link is established on that same unbounded
        // association, and only then rebuilt onto one that negotiated 65 536.
        let r = rig(negotiated: .infinity)
        // BOTH halves rebuild, which is what a real gap does. Telling only the
        // sender would leave the receiving session in the old generation, and
        // the batch would be refused for a reason that has nothing to do with
        // what is under test.
        _ = r.owner.onTransportLost(r.identity)
        r.owner.settle()
        _ = r.peer.transportGap()
        let replacement = CeilingTransport(negotiated: 65_536)
        try r.owner.onAttach(r.identity, replacement)
        r.owner.settle()
        feed(r, r.peer.didAttachReplacementTransport())
        _ = replacement.takeSent(on: .file)

        _ = try r.owner.enqueueFiles(files: files, stage: stage)
        r.owner.pumpFiles()
        let after = runTransfer(r, on: replacement)

        XCTAssertFalse(after.isEmpty, "the replacement carried the batch")
        let biggest = after.map(\.count).max() ?? 0
        XCTAssertLessThanOrEqual(biggest, 65_536,
                                 "a \(biggest) B frame went out on a transport that "
                                 + "negotiated 65 536 — the establishment-time ceiling "
                                 + "survived the swap")
        XCTAssertTrue(after.contains { $0.first == RealtimeKind.batchPart },
                      "the MANIFEST is bound by the replacement too, not just the producer")
        XCTAssertTrue(after.contains { $0.first == RealtimeKind.chunkPart },
                      "and so is the next producer")
        XCTAssertEqual(r.received.files.count, files.count,
                       "every file of the batch was opened")
        XCTAssertEqual(r.received.files.last, body,
                       "byte-exact through the replacement's own fragmentation")
        XCTAssertEqual(r.received.finalized, 1)
        XCTAssertFalse(r.owner.isFileTerminal)
        XCTAssertFalse(r.peer.laneFailed)
    }

    // ── the conversation ────────────────────────────────────────────────────

    /// One conversation, both halves, with the transport the local driver is on
    /// reporting a ceiling.
    private struct Conversation {
        let driver: LinkTextDriver
        let identity: LinkIdentity
        let peer: LinkTextDriver
        let peerIdentity: LinkIdentity
        let peerTransport: CeilingTransport
        let peerEvents: TextEvents
    }

    private func conversation(on transport: CeilingTransport) -> Conversation {
        let codecs = LinkCodecs(sendKey: ownerSendKey, recvKey: ownerRecvKey)
        let identity = LinkIdentity(peerId: "peer-b", role: .initiator, sas: "123456",
                                    codecs: codecs)
        let driver = LinkTextDriver(identity: identity, transport: transport,
                                    scheduler: FakeLinkScheduler(),
                                    sendBufferPollInterval: 0.01,
                                    onEvent: { _ in })
        // The peer half of the SAME conversation: mirrored codecs, so a frame
        // this driver seals is one the peer really authenticates — which is how
        // a spent nonce becomes visible rather than inferred.
        let peerCodecs = LinkCodecs(sendKey: ownerRecvKey, recvKey: ownerSendKey)
        let peerTransport = CeilingTransport()
        let peerEvents = TextEvents()
        let peerIdentity = LinkIdentity(peerId: "peer-a", role: .responder,
                                        sas: "123456", codecs: peerCodecs)
        let peer = LinkTextDriver(identity: peerIdentity,
                                  transport: peerTransport,
                                  scheduler: FakeLinkScheduler(),
                                  sendBufferPollInterval: 0.01,
                                  onEvent: { peerEvents.append($0) })
        return Conversation(driver: driver, identity: identity, peer: peer,
                            peerIdentity: peerIdentity,
                            peerTransport: peerTransport, peerEvents: peerEvents)
    }

    private func open(_ c: Conversation, over transport: CeilingTransport,
                      peerTransport: CeilingTransport? = nil,
                      file: StaticString = #filePath, line: UInt = #line) throws {
        let back = peerTransport ?? c.peerTransport
        try c.driver.open()
        c.driver.settle()
        for frame in transport.takeSent(on: .text) { c.peer.admitTextFrame(frame) }
        c.peer.settle()
        try c.peer.accept()
        c.peer.settle()
        for frame in back.takeSent(on: .text) { c.driver.admitTextFrame(frame) }
        c.driver.settle()
        XCTAssertEqual(c.driver.status, .open, file: file, line: line)
    }

    /// The largest plaintext a 65 536 B message can carry is 65 515
    /// (`LINK_TEXT_FRAME_OVERHEAD` is 21). One byte more.
    private var justTooLongFor65536: String { String(repeating: "a", count: 65_516) }

    /// A message the CONNECTION cannot carry is refused before the sender is
    /// touched, so the refusal costs no nonce and the conversation survives it.
    ///
    /// Text does not fragment: an oversized frame here is not a slow send, it is
    /// a nonce burned on bytes the channel refuses, and nothing — not a retry,
    /// not a replacement transport — can repair the sequence hole that leaves.
    /// Local policy is production's own `DEFAULT_MAX_FRAME_BYTES`, so the only
    /// thing that can refuse this message is the number the transport reports.
    func testAnOversizedMessageIsRefusedBeforeItSpendsANonce() throws {
        let transport = CeilingTransport(negotiated: 65_536)
        let c = conversation(on: transport)
        try open(c, over: transport)
        _ = transport.takeSent(on: .text)

        XCTAssertThrowsError(try c.driver.send(justTooLongFor65536)) {
            assertSizeRefusal($0)
        }
        c.driver.settle()
        XCTAssertTrue(transport.sent(on: .text).allSatisfy { $0.count <= 1 },
                      "nothing protected left the wire")
        XCTAssertFalse(c.driver.isTerminal, "a size refusal is not a lane failure")
        XCTAssertEqual(c.driver.status, .open, "and the conversation is still usable")

        // THE nonce assertion. If the refusal had reached the sender, the peer
        // would be expecting a sequence number that never arrives, and this
        // message would be rejected rather than received.
        try c.driver.send("after")
        c.driver.settle()
        for frame in transport.takeSent(on: .text) { c.peer.admitTextFrame(frame) }
        XCTAssertEqual(c.peerEvents.received.map(\.utf8.count), [5],
                       "the refused message spent no nonce")
        XCTAssertEqual(c.peerEvents.received.last, "after")
        XCTAssertFalse(c.peer.isTerminal, "and the peer's receive sequence is intact")
    }

    /// The same message, on a rebuild that negotiated LESS than the association
    /// it replaces: accepted before, refused after.
    ///
    /// The first transport reports `.infinity` on purpose — nothing here can be
    /// explained by a ceiling that was always in force.
    func testAReplacementNegotiatingLessBindsTheNextMessage() throws {
        let initial = CeilingTransport(negotiated: .infinity)
        let c = conversation(on: initial)
        try open(c, over: initial)
        _ = initial.takeSent(on: .text)

        // The unbounded association really does carry it.
        try c.driver.send(justTooLongFor65536)
        c.driver.settle()
        for frame in initial.takeSent(on: .text) { c.peer.admitTextFrame(frame) }
        // Compared by LENGTH: a failure that printed 65 KB of "a" would bury
        // every other assertion in the run.
        XCTAssertEqual(c.peerEvents.received.map(\.utf8.count), [65_516],
                       "the first association carried this message whole")

        // BOTH halves rebuild, which is what a real gap does.
        _ = c.driver.onTransportLost(c.identity)
        c.driver.settle()
        _ = c.peer.onTransportLost(c.peerIdentity)
        c.peer.settle()
        let replacement = CeilingTransport(negotiated: 65_536)
        let peerReplacement = CeilingTransport()
        try c.driver.onAttach(c.identity, replacement)
        c.driver.settle()
        try c.peer.onAttach(c.peerIdentity, peerReplacement)
        c.peer.settle()
        XCTAssertFalse(c.driver.isTerminal,
                       "a rebuild ends the conversation, it does not fail the lane")

        // A rebuild deliberately does not carry a conversation over: consent
        // was given on a transport that no longer exists. So it is reopened,
        // over the replacement, and it is the REPLACEMENT's ceiling that must
        // bind what follows.
        _ = replacement.takeSent(on: .text)
        _ = peerReplacement.takeSent(on: .text)
        try open(c, over: replacement, peerTransport: peerReplacement)
        _ = replacement.takeSent(on: .text)

        XCTAssertThrowsError(try c.driver.send(justTooLongFor65536)) {
            assertSizeRefusal($0)
        }
        c.driver.settle()
        XCTAssertTrue(replacement.sent(on: .text).allSatisfy { $0.count <= 1 },
                      "nothing protected left the wire")

        try c.driver.send("after")
        c.driver.settle()
        for frame in replacement.takeSent(on: .text) { c.peer.admitTextFrame(frame) }
        XCTAssertEqual(c.peerEvents.received.last, "after",
                       "and the refusal across the rebuild spent no nonce either")
        XCTAssertFalse(c.peer.isTerminal)
    }

    private func assertSizeRefusal(_ error: Error,
                                   file: StaticString = #filePath, line: UInt = #line) {
        guard case let LinkTextDriverError.refused(inner)? = error as? LinkTextDriverError,
              case .tooLong = inner else {
            return XCTFail("expected a size refusal, got \(error)", file: file, line: line)
        }
    }

    final class TextEvents: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [LinkTextDriverEvent] = []
        func append(_ event: LinkTextDriverEvent) { lock.lock(); items.append(event); lock.unlock() }
        var received: [String] {
            lock.lock(); defer { lock.unlock() }
            return items.compactMap { if case let .received(body) = $0 { return body } else { return nil } }
        }
    }

    // ── a peer this side cannot transfer to at all ──────────────────────────

    /// A ceiling below `MIN_PIECE_BYTES` cannot carry a conforming piece, so
    /// the batch cannot be sent at ALL. The lane fails closed, the user is told
    /// which batches died, and NOTHING goes on the wire — an oversized frame
    /// would be refused by the peer's channel after this side had already spent
    /// the nonce that sealed it.
    func testAPeerCeilingTooSmallToCarryAPieceFailsClosedWithoutSendingAFrame() throws {
        let r = rig(negotiated: 100)

        let batch = try r.owner.enqueueFiles(files: [meta("a.bin", 64)], stage: {
            [DataSource(name: "a.bin", bytes: [UInt8](repeating: 7, count: 64))]
        })
        r.owner.pumpFiles()
        r.owner.settle()

        XCTAssertEqual(r.transport.sent(on: .file), [],
                       "not one frame may be sealed for a connection that cannot carry it")
        XCTAssertTrue(r.owner.isFileTerminal, "and the lane fails closed rather than stalling")
        XCTAssertTrue(r.events.all.contains(.batchesFailed([batch])),
                      "the user is told exactly which work died")
    }
}
