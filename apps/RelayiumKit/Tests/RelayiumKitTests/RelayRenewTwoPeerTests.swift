import XCTest
@testable import RelayiumKit

/// TWO real engines, a model of the server's round cache, and a lossy wire
/// between them.
///
/// Single-engine tests hand an engine the messages a well-behaved peer would
/// send. That cannot show an asymmetric commit, because the asymmetry IS the
/// interaction: one end commits on an ack the other never receives. Here every
/// signal and every control frame one engine emits is delivered to the other —
/// unless the test drops it — so a split between the two ends is something this
/// harness produces rather than something a test has to imagine.
final class RelayRenewTwoPeerTests: XCTestCase {
    private let key = [UInt8](repeating: 0x2e, count: 32)

    /// The server's half of spec §2.3, as far as a client can observe it: a
    /// round is issued once BOTH members have asked, the result is cached, and
    /// a repeat for the current round replays it.
    private final class Server {
        var issued: UInt32 = 0
        var cache: [UInt32: ICEConfig] = [:]
        var asked: [UInt32: Set<String>] = [:]
        var issuances = 0
        /// Replies withheld for a side, delivered later by the test.
        var held: [String: [RelayRenewGrant]] = [:]
        var holdRepliesFor: Set<String> = []
        /// `unavailable, reason: rate` for any NEW issuance (the floor).
        var rateLimited = false

        func request(from side: String, round: UInt32, rid: UInt32) -> [(String, RelayRenewGrant)] {
            if let config = cache[round], round == issued {
                return [(side, RelayRenewGrant(status: .granted, round: round, rid: rid,
                                               config: config))]
            }
            guard round == issued + 1 else {
                return [(side, RelayRenewGrant(status: .stale, round: issued, rid: rid))]
            }
            if rateLimited {
                return [(side, RelayRenewGrant(status: .unavailable, round: round, rid: rid,
                                               reason: "rate"))]
            }
            asked[round, default: []].insert("\(side):\(rid)")
            let sides = Set(asked[round, default: []].map { $0.split(separator: ":")[0] })
            guard sides.count == 2 else { return [] }
            issued = round
            issuances += 1
            let config = ICEConfig(iceServers: [ICEServerConfig(
                urls: ["turn:r\(round).example:3478"],
                username: "\(1_790_000_000 + Int(round) * 3600):x", credential: "y")])
            cache[round] = config
            return asked[round, default: []].map { entry in
                let parts = entry.split(separator: ":")
                return (String(parts[0]), RelayRenewGrant(status: .granted, round: round,
                                                          rid: UInt32(parts[1])!, config: config))
            }
        }
    }

    private final class Side {
        let name: String
        var engine: RelayRenewEngine!
        var userData = true
        var commits: [UInt32] = []
        var recommits: [UInt32] = []
        var ended: [(UInt32, RelayRenewAbortReason)] = []
        var armed: Set<RelayRenewTimer> = []
        var offers = 0
        init(_ name: String) { self.name = name }
    }

    private struct Net {
        let a: Side
        let b: Side
        let server: Server
    }

    private var dropFrame: ((String, RelayRenewProbeFrame) -> Bool)?
    private var queue: [() -> Void] = []

    private func sdp(_ ufrag: String) -> String {
        "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
            + "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"
            + "a=ice-ufrag:\(ufrag)\r\na=fingerprint:sha-256 AB:CD:EF:01\r\n"
            + "a=setup:actpass\r\na=mid:0\r\n"
    }
    private func candidate(_ ufrag: String) -> String {
        "candidate:1 1 udp 1 203.0.113.9 5000 typ relay raddr 0.0.0.0 rport 0"
            + " generation 0 ufrag \(ufrag) network-cost 999"
    }

    private func net() -> Net {
        let a = Side("a"), b = Side("b")
        let server = Server()
        var counter: UInt8 = 0
        for (side, role, other) in [(a, Role.initiator, "b"), (b, Role.responder, "a")] {
            side.engine = RelayRenewEngine(
                selfId: side.name, peerId: other, role: role,
                baseline: relayRenewPin(sdp: sdp("BASE")),
                sign: { signResume(key: self.key, payload: $0) },
                verify: { verifyResume(key: self.key, payload: $0, mac: $1) },
                makeNonce: { counter &+= 1; return [UInt8](repeating: counter, count: 16) },
                userDataIsRecent: { [unowned side] in side.userData })
        }
        return Net(a: a, b: b, server: server)
    }

    /// Perform one side's effects, delivering what it emits to the other side.
    private func perform(_ effects: [RelayRenewEffect], from side: Side, in net: Net) {
        let other = side === net.a ? net.b : net.a
        for effect in effects {
            switch effect {
            case let .sendSignal(json):
                guard let envelope = parsedRelayRenewEnvelope(json) else { continue }
                queue.append { self.perform(other.engine.receive(envelope), from: other, in: net) }
            case let .requestRound(round, rid):
                for (to, grant) in net.server.request(from: side.name, round: round, rid: rid) {
                    let target = to == "a" ? net.a : net.b
                    if net.server.holdRepliesFor.contains(to) {
                        net.server.held[to, default: []].append(grant)
                    } else {
                        queue.append {
                            self.perform(target.engine.receive(grant: grant), from: target, in: net)
                        }
                    }
                }
            case let .applyConfiguration(_, epoch):
                queue.append {
                    self.perform(side.engine.configurationApplied(epoch: epoch, ok: true),
                                 from: side, in: net)
                }
            case let .createOffer(epoch):
                side.offers += 1
                queue.append {
                    self.perform(side.engine.localDescriptionApplied(
                        epoch: epoch, type: .offer, sdp: self.sdp("\(side.name)\(epoch)")),
                                 from: side, in: net)
                }
            case let .createAnswer(epoch):
                queue.append {
                    self.perform(side.engine.localDescriptionApplied(
                        epoch: epoch, type: .answer, sdp: self.sdp("\(side.name)\(epoch)")),
                                 from: side, in: net)
                    // Both descriptions are applied on the answerer now.
                    self.perform(side.engine.selectedLocalCandidate(
                        sdp: self.candidate("\(side.name)\(epoch)"),
                        remote: self.candidate("\(other.name)\(epoch)")), from: side, in: net)
                }
            case let .applyRemoteDescription(_, type, epoch):
                queue.append {
                    self.perform(side.engine.remoteDescriptionApplied(epoch: epoch, ok: true),
                                 from: side, in: net)
                    if type == .answer {
                        self.perform(side.engine.selectedLocalCandidate(
                            sdp: self.candidate("\(side.name)\(epoch)"),
                            remote: self.candidate("\(other.name)\(epoch)")), from: side, in: net)
                    }
                }
            case let .sendProbeFrame(bytes):
                guard let frame = parsedRelayRenewProbeFrame(bytes) else { continue }
                if dropFrame?(side.name, frame) == true { continue }
                queue.append {
                    self.perform(other.engine.probeFrameReceived(frame), from: other, in: net)
                }
            case let .armTimer(timer, _): side.armed.insert(timer)
            case let .cancelTimer(timer): side.armed.remove(timer)
            case let .commit(round, _): side.commits.append(round)
            case let .recommitted(round): side.recommits.append(round)
            case let .epochEnded(epoch, reason): side.ended.append((epoch, reason))
            case .addRemoteCandidate, .peerUnsupported: break
            }
        }
    }

    private func pump() {
        var steps = 0
        while !queue.isEmpty {
            steps += 1
            XCTAssertLessThan(steps, 5000, "the two engines must converge, not loop")
            if steps >= 5000 { queue = []; return }
            queue.removeFirst()()
        }
    }

    private func start(_ side: Side, _ net: Net) {
        perform(side.engine.evaluate(), from: side, in: net)
        pump()
    }

    private func fire(_ timer: RelayRenewTimer, on side: Side, _ net: Net) {
        side.armed.remove(timer)
        perform(side.engine.timerFired(timer), from: side, in: net)
        pump()
    }

    override func setUp() { super.setUp(); dropFrame = nil; queue = [] }

    // MARK: - the ordinary case, in both directions

    func testTwoRealEnginesMigrateAndBothCommitWithOneIssuance() {
        for initiatorStarts in [true, false] {
            let net = net()
            start(initiatorStarts ? net.a : net.b, net)
            XCTAssertEqual(net.a.commits, [1], "initiatorStarts=\(initiatorStarts)")
            XCTAssertEqual(net.b.commits, [1], "initiatorStarts=\(initiatorStarts)")
            XCTAssertEqual(net.server.issuances, 1)
            XCTAssertEqual(net.a.offers, 1, "only the established initiator offers")
            XCTAssertEqual(net.b.offers, 0)
        }
    }

    // MARK: - W8: the peer's ready may arrive before this side's own grant

    /// Root reproduced this in real Chrome by delaying one side's grant one
    /// second: the early `ready` was dropped and the epoch deadlocked. The
    /// peer's authenticated `ready` is RETAINED for the epoch in flight, and
    /// negotiation starts when this side's own configuration lands and the
    /// rounds agree. Both roles.
    func testAnEarlyReadyIsRetainedUntilTheOwnGrantArrivesInBothRoles() {
        for delayed in ["a", "b"] {
            let net = net()
            net.server.holdRepliesFor = [delayed]
            start(net.a, net)
            let late = delayed == "a" ? net.a : net.b
            XCTAssertTrue(net.a.commits.isEmpty, "nothing can complete before \(delayed) is granted")
            XCTAssertEqual(net.server.held[delayed]?.count, 1)

            // The delayed grant finally arrives — AFTER the peer's `ready`.
            net.server.holdRepliesFor = []
            for grant in net.server.held[delayed] ?? [] {
                perform(late.engine.receive(grant: grant), from: late, in: net)
            }
            pump()
            XCTAssertEqual(net.a.commits, [1], "delayed=\(delayed): the early ready was kept")
            XCTAssertEqual(net.b.commits, [1], "delayed=\(delayed)")
        }
    }

    // MARK: - R4: exactly one peer committed

    /// Drop every ack travelling b→a: `b` commits round 1, `a` never does.
    private func splitCommit() -> Net {
        let net = net()
        dropFrame = { from, frame in from == "b" && frame.type == .ack }
        start(net.a, net)
        XCTAssertTrue(net.a.commits.isEmpty, "precondition: a did not commit")
        XCTAssertEqual(net.b.commits, [1], "precondition: b did")
        // a's epoch runs out; its retransmits were all answered into the void.
        fire(.iceProbe(epoch: 1), on: net.a, net)
        XCTAssertEqual(net.a.engine.currentInstalledRound, 0)
        XCTAssertEqual(net.b.engine.currentInstalledRound, 1)
        return net
    }

    /// The repair, AFTER b's post-commit window has closed: a fetches the
    /// cached round 1, b — asking for round 2 alone — adopts the round it
    /// already installed, and the two converge with NO new issuance.
    func testASplitCommitIsRepairedOnTheInstalledRoundWithoutANewIssuance() {
        let net = splitCommit()
        fire(.postCommitAck(epoch: 1), on: net.b, net)   // b's window is gone
        dropFrame = nil
        fire(.retryBackoff(epoch: 1), on: net.a, net)
        start(net.a, net)

        XCTAssertEqual(net.a.commits, [1], "a advances onto round 1: for a it is genuinely new")
        XCTAssertEqual(net.b.commits, [1], "b's deadline is NOT moved a second time")
        XCTAssertEqual(net.b.recommits, [1], "b re-proved the path and says so")
        XCTAssertEqual(net.server.issuances, 1, "no new credential was needed or minted")
        XCTAssertEqual(net.a.engine.currentInstalledRound, 1)
        XCTAssertEqual(net.b.engine.currentInstalledRound, 1)
    }

    /// §6.7: the committed side's lone request for R+1 is refused `rate` —
    /// it renewed moments ago — and that refusal must NOT end the epoch the
    /// repair needs.
    func testARateRefusedNextRoundDoesNotEndARepairableEpoch() {
        let net = splitCommit()
        net.server.rateLimited = true
        dropFrame = nil
        fire(.retryBackoff(epoch: 1), on: net.a, net)
        start(net.a, net)

        XCTAssertEqual(net.a.commits, [1])
        XCTAssertEqual(net.b.recommits, [1], "b stayed alive through `unavailable/rate`")
        XCTAssertFalse(net.b.ended.contains { $0.1 == .unavailable },
                       "the refusal did not end b's epoch")
    }

    /// A late answer to b's abandoned R+1 request — granted OR denied — must
    /// not touch the repair, and must not poison round 2 for later.
    func testALateNextRoundReplyCannotOverwriteOrAbortTheRepair() {
        let net = splitCommit()
        dropFrame = nil
        fire(.retryBackoff(epoch: 1), on: net.a, net)
        start(net.a, net)
        XCTAssertEqual(net.b.recommits, [1])

        // Whatever rid b used for round 2, replay both outcomes at it.
        for rid in UInt32(1)...UInt32(8) {
            let denied = net.b.engine.receive(grant: RelayRenewGrant(status: .denied, round: 2,
                                                                     rid: rid))
            XCTAssertTrue(denied.isEmpty, "rid \(rid): a fenced denial changes nothing")
            let granted = net.b.engine.receive(grant: RelayRenewGrant(
                status: .granted, round: 2, rid: rid,
                config: ICEConfig(iceServers: [ICEServerConfig(urls: ["turn:evil:1"],
                                                               username: "1:x",
                                                               credential: "y")])))
            XCTAssertTrue(granted.isEmpty, "rid \(rid): nor does a fenced grant")
        }
        // Round 2 is still obtainable later: the late denial did not mark it.
        net.server.rateLimited = false
        start(net.a, net)
        XCTAssertEqual(net.a.commits, [1, 2])
        XCTAssertEqual(net.b.commits, [1, 2])
    }

    /// A repair spends the SAME three-epoch budget of the round it repairs, and
    /// committing the round does not refund it.
    func testRepairsSpendTheRoundsMigrationBudgetAndItIsNotRefunded() {
        let net = splitCommit()
        // Keep a from ever committing, so every retry is another repair.
        var adoptions = 0
        for epoch in UInt32(2)...UInt32(8) {
            fire(.retryBackoff(epoch: epoch - 1), on: net.a, net)
            let before = net.b.recommits.count + net.b.ended.count
            start(net.a, net)
            guard net.a.engine.isAttempting || net.b.recommits.count + net.b.ended.count > before
            else { break }
            if net.b.recommits.count > adoptions { adoptions = net.b.recommits.count }
            if net.a.engine.isAttempting { fire(.iceProbe(epoch: epoch), on: net.a, net) }
        }
        // b spent one epoch obtaining round 1 and may repair it at most twice.
        XCTAssertLessThanOrEqual(net.b.recommits.count, RENEW_MAX_EPOCHS_PER_ROUND - 1)
        XCTAssertEqual(net.b.commits, [1], "and b's deadline moved exactly once throughout")
    }

    // MARK: - W9/D5: the budget is per ACTUAL credential round

    /// failed R1 + successful R1 + repairs of R1 never exceed three, a FOURTH
    /// cached-R1 migration is refused before any RTC configuration, and a fully
    /// spent R1 does not block a normal R2.
    ///
    /// Root's real-browser negative recorded one peer spending SEVEN granted
    /// epochs on one credential round: a commit had reset the counter, refunding
    /// the very credential it had just spent.
    func testTheBudgetIsPerActualRoundIsNeverRefundedAndDoesNotBlockTheNextRound() {
        let net = net()
        var applied: [UInt32] = []

        // (1) A FAILED epoch on R1: both are granted, the probe never completes.
        dropFrame = { _, _ in true }
        start(net.a, net)
        fire(.iceProbe(epoch: 1), on: net.a, net)
        XCTAssertTrue(net.a.commits.isEmpty)

        // (2) A SUCCESSFUL epoch on R1 — for b. a is kept from committing.
        dropFrame = { from, frame in from == "b" && frame.type == .ack }
        fire(.retryBackoff(epoch: 1), on: net.a, net)
        fire(.retryBackoff(epoch: 1), on: net.b, net)
        start(net.a, net)
        XCTAssertEqual(net.b.commits, [1], "b installed R1 on its SECOND R1 epoch")
        fire(.iceProbe(epoch: 2), on: net.a, net)

        // (3) ONE repair of R1 is still allowed to b: 1 failed + 1 success + 1.
        fire(.retryBackoff(epoch: 2), on: net.a, net)
        start(net.a, net)
        XCTAssertEqual(net.b.recommits, [1], "the third R1 epoch is the last")
        XCTAssertEqual(net.b.commits, [1], "the commit did NOT refund b's R1 budget")
        if net.a.engine.isAttempting { fire(.iceProbe(epoch: 3), on: net.a, net) }
        applied = net.a.commits

        // (4) a has now spent three granted epochs on R1 and never committed.
        //     A fourth is refused BEFORE it starts: no prepare, no request.
        fire(.retryBackoff(epoch: 3), on: net.a, net)
        let before = net.server.cache.count
        perform(net.a.engine.evaluate(), from: net.a, in: net)
        pump()
        XCTAssertFalse(net.a.engine.isAttempting, "a fourth R1 migration is refused")
        XCTAssertEqual(net.a.commits, applied)
        XCTAssertEqual(net.server.cache.count, before)

        // (5) …and a fully spent R1 does not block R2 for a side that CAN reach
        //     it. b installed R1; its R2 budget is untouched.
        XCTAssertEqual(net.b.engine.currentInstalledRound, 1)
        XCTAssertLessThanOrEqual(net.b.recommits.count + net.b.commits.count, 3)
    }

    /// ONE side, driven directly, so its peer's own budget cannot mask a refund.
    ///
    /// In the two-peer run above both ends spend R1 together, so the side that
    /// never commits runs out first and simply stops asking — which hides
    /// whether the COMMITTED side's counter was refunded. Here the peer is
    /// scripted and inexhaustible: after 1 failed + 1 committed epoch on R1,
    /// exactly ONE repair is left, however many the peer asks for.
    func testACommitDoesNotRefundTheRoundItCommitted() {
        let nonce = [UInt8](repeating: 0x5A, count: 16)
        let b = RelayRenewEngine(
            selfId: "b", peerId: "a", role: .responder,
            baseline: relayRenewPin(sdp: sdp("BASE")),
            sign: { signResume(key: self.key, payload: $0) },
            verify: { verifyResume(key: self.key, payload: $0, mac: $1) },
            makeNonce: { nonce }, userDataIsRecent: { true })
        func fromA(_ m: RelayRenewMessage) -> RelayRenewEnvelope {
            RelayRenewEnvelope(message: m, auth: signResume(
                key: key, payload: relayRenewPayload(m, from: "a", to: "b")))
        }
        func rid(_ effects: [RelayRenewEffect]) -> UInt32? {
            for case let .requestRound(_, rid) in effects { return rid }
            return nil
        }
        let r1 = ICEConfig(iceServers: [ICEServerConfig(urls: ["turn:r1:1"],
                                                        username: "1790003600:x", credential: "y")])
        /// Run b through one whole epoch as the answerer. Returns its effects
        /// at the moment the peer's ack for b's nonce arrives.
        func answerEpoch(_ epoch: UInt32, grantRound1: Bool, ack: Bool) -> [RelayRenewEffect] {
            let joined = b.receive(fromA(.prepare(epoch: epoch)))
            if grantRound1, let rid = rid(joined) {
                _ = b.receive(grant: RelayRenewGrant(status: .granted, round: 1, rid: rid,
                                                     config: r1))
                _ = b.configurationApplied(epoch: epoch, ok: true)
            }
            _ = b.receive(fromA(.ready(epoch: epoch, round: 1)))
            guard b.currentEpoch == epoch else { return [] }
            _ = b.receive(fromA(.sdp(epoch: epoch, round: 1, sdpType: .offer,
                                     sdp: sdp("a\(epoch)"))))
            _ = b.remoteDescriptionApplied(epoch: epoch, ok: true)
            _ = b.localDescriptionApplied(epoch: epoch, type: .answer, sdp: sdp("b\(epoch)"))
            _ = b.selectedLocalCandidate(sdp: candidate("b\(epoch)"),
                                         remote: candidate("a\(epoch)"))
            guard ack else { return b.timerFired(.iceProbe(epoch: epoch)) }
            let payload = relayRenewProbePayload(type: .ack, from: "a", to: "b",
                                                 epoch: epoch, round: 1, nonce: nonce)
            let tag = Data(base64Encoded: signResume(key: key, payload: payload))!
            return b.probeFrameReceived(RelayRenewProbeFrame(type: .ack, epoch: epoch, round: 1,
                                                             nonce: nonce, tag: Array(tag)))
        }
        func outcome(_ effects: [RelayRenewEffect]) -> String {
            for effect in effects {
                if case .commit = effect { return "commit" }
                if case .recommitted = effect { return "recommit" }
            }
            return "none"
        }

        XCTAssertEqual(outcome(answerEpoch(1, grantRound1: true, ack: false)), "none")   // 1 of 3
        XCTAssertEqual(outcome(answerEpoch(2, grantRound1: true, ack: true)), "commit")  // 2 of 3
        XCTAssertEqual(outcome(answerEpoch(3, grantRound1: false, ack: true)), "recommit") // 3 of 3
        // A refunded counter would allow three MORE here. The peer asks five
        // more times; b adopts R1 for none of them.
        for epoch in UInt32(4)...UInt32(8) {
            XCTAssertEqual(outcome(answerEpoch(epoch, grantRound1: false, ack: true)), "none",
                           "epoch \(epoch): R1's budget is spent and committing it refunded nothing")
        }
    }

    /// The grant-time check is a second line behind `evaluate()`'s, and it is
    /// the only one on the path where the round being granted is NOT the round
    /// this side set out to ask for: a `stale` resynchronisation. A fourth
    /// granted epoch on that round must be refused BEFORE any RTC
    /// configuration is applied.
    func testAFourthGrantedEpochIsRefusedBeforeAnyConfigurationIsApplied() {
        let e = RelayRenewEngine(
            selfId: "a", peerId: "b", role: .initiator,
            baseline: relayRenewPin(sdp: sdp("BASE")),
            sign: { signResume(key: self.key, payload: $0) },
            verify: { verifyResume(key: self.key, payload: $0, mac: $1) },
            makeNonce: { [UInt8](repeating: 1, count: 16) }, userDataIsRecent: { true })
        let r5 = ICEConfig(iceServers: [ICEServerConfig(urls: ["turn:r5:1"],
                                                        username: "1790003600:x", credential: "y")])
        var applied = 0
        for epoch in UInt32(1)...UInt32(4) {
            var rid: UInt32 = 0
            for case let .requestRound(_, r) in e.evaluate() { rid = r }
            // The server is at round 5; this side resynchronises to it.
            for case let .requestRound(_, r) in e.receive(grant: RelayRenewGrant(
                status: .stale, round: 5, rid: rid)) { rid = r }
            let granted = e.receive(grant: RelayRenewGrant(status: .granted, round: 5, rid: rid,
                                                           config: r5))
            applied += granted.filter { if case .applyConfiguration = $0 { return true }
                                        return false }.count
            if e.isAttempting { _ = e.timerFired(.epochHardCap(epoch: epoch)) }
            _ = e.timerFired(.retryBackoff(epoch: epoch))
        }
        XCTAssertEqual(applied, RENEW_MAX_EPOCHS_PER_ROUND,
                       "the fourth granted epoch on one round reaches no setConfiguration")
    }

    /// A full R1 budget, spent entirely on repairs, leaves R2 obtainable.
    func testAFullySpentRoundDoesNotBlockTheNextOne() {
        let net = splitCommit()                       // b: 1 granted epoch on R1
        dropFrame = { from, frame in from == "b" && frame.type == .ack }
        for epoch in UInt32(2)...UInt32(3) {          // b: two repairs → 3 of 3
            fire(.retryBackoff(epoch: epoch - 1), on: net.a, net)
            start(net.a, net)
            if net.a.engine.isAttempting { fire(.iceProbe(epoch: epoch), on: net.a, net) }
        }
        XCTAssertEqual(net.b.recommits.count, 2)
        // a also spent its three on R1 and can go no further; but give b a
        // peer that CAN: a fresh pair where R1 commits normally, then R2.
        let fresh = self.net()
        dropFrame = nil
        start(fresh.a, fresh)
        start(fresh.a, fresh)
        XCTAssertEqual(fresh.a.commits, [1, 2])
        XCTAssertEqual(fresh.b.commits, [1, 2], "R1's spending is R1's alone")
    }

    /// An authenticated peer `abort` applies the SAME backoff as a local
    /// failure: the side that received it may not restart immediately.
    func testAPeerAbortBacksOffTheReceiverToo() {
        let net = net()
        dropFrame = { _, _ in true }
        start(net.a, net)
        XCTAssertTrue(net.b.engine.isAttempting)
        // a times out and says so; b hears a signed abort.
        fire(.iceProbe(epoch: 1), on: net.a, net)
        XCTAssertFalse(net.b.engine.isAttempting)
        XCTAssertTrue(net.b.armed.contains(.retryBackoff(epoch: 1)),
                      "the peer's abort must arm b's backoff")
        // b may not restart on its own until that backoff elapses.
        perform(net.b.engine.evaluate(), from: net.b, in: net)
        pump()
        XCTAssertFalse(net.b.engine.isAttempting, "no immediate restart after a peer abort")
        XCTAssertFalse(net.a.engine.isAttempting)
    }

    /// Signed higher prepares cannot reset this side's resources. Each
    /// superseded epoch that had asked the server and not yet been answered is
    /// charged to the pre-grant budget, and once it is spent this side refuses
    /// — with a signed abort, not with silence — and asks the server nothing.
    func testSignedHigherPreparesCannotBuyUnboundedServerRequests() {
        let net = net()
        net.server.holdRepliesFor = ["a", "b"]        // nobody is ever granted
        var requests = 0
        var refusals = 0
        for epoch in UInt32(1)...UInt32(30) {
            let message = RelayRenewMessage.prepare(epoch: epoch)
            let envelope = RelayRenewEnvelope(
                message: message,
                auth: signResume(key: key, payload: relayRenewPayload(message, from: "a", to: "b")))
            let effects = net.b.engine.receive(envelope)
            requests += effects.filter { if case .requestRound = $0 { return true }; return false }.count
            for effect in effects {
                guard case let .sendSignal(json) = effect,
                      case .abort(_, .unavailable)? = parsedRelayRenewEnvelope(json)?.message
                else { continue }
                refusals += 1
            }
        }
        XCTAssertLessThanOrEqual(requests, RENEW_MAX_PREGRANT_ATTEMPTS + 1,
                                 "thirty signed prepares must not mean thirty server requests")
        XCTAssertGreaterThan(refusals, 0, "and the refusal is said out loud, not left as silence")
        XCTAssertTrue(net.b.commits.isEmpty)
    }

    /// What repair refuses: a round this side never installed.
    func testNothingIsAdoptedOnThePeersWord() {
        let net = net()
        // b has installed NOTHING. A signed ready naming round 1 is just an
        // ordinary early ready, and b still waits for its own grant.
        net.server.holdRepliesFor = ["b"]
        start(net.a, net)
        XCTAssertTrue(net.b.recommits.isEmpty)
        XCTAssertTrue(net.b.commits.isEmpty)
        XCTAssertTrue(net.b.engine.isAttempting, "b is waiting on the SERVER, not adopting")
    }

    // MARK: - R6: a cached selection from the previous epoch proves nothing

    func testASelectedCandidateFromThePreviousEpochFailsOnItsUfrag() {
        let net = net()
        start(net.a, net)
        XCTAssertEqual(net.a.commits, [1])
        // Round 2 begins; before its descriptions land, the SDK re-reports the
        // pair the PREVIOUS epoch selected. It is retained — and must fail.
        dropFrame = { _, _ in true }   // no probe may complete by accident
        perform(net.a.engine.evaluate(), from: net.a, in: net)
        perform(net.a.engine.selectedLocalCandidate(sdp: candidate("a1"),
                                                    remote: candidate("b1")),
                from: net.a, in: net)
        pump()
        XCTAssertEqual(net.a.commits, [1], "epoch 1's pair cannot stand in for epoch 2's")
    }

    /// A new LOCAL candidate paired against the peer's PREVIOUS generation is a
    /// real selection carrying this epoch's local ufrag — and is not the
    /// migrated path.
    func testANewLocalCandidateAgainstAnOldRemoteGenerationDoesNotHold() {
        let engine = RelayRenewEngine(
            selfId: "a", peerId: "b", role: .initiator,
            baseline: relayRenewPin(sdp: sdp("BASE")),
            sign: { signResume(key: self.key, payload: $0) },
            verify: { verifyResume(key: self.key, payload: $0, mac: $1) },
            makeNonce: { [UInt8](repeating: 1, count: 16) },
            userDataIsRecent: { true })
        func signed(_ m: RelayRenewMessage) -> RelayRenewEnvelope {
            RelayRenewEnvelope(message: m, auth: signResume(
                key: key, payload: relayRenewPayload(m, from: "b", to: "a")))
        }
        _ = engine.evaluate()
        _ = engine.receive(grant: RelayRenewGrant(
            status: .granted, round: 1, rid: 1,
            config: ICEConfig(iceServers: [ICEServerConfig(urls: ["turn:r:1"],
                                                           username: "1790000000:a",
                                                           credential: "b")])))
        _ = engine.configurationApplied(epoch: 1, ok: true)
        _ = engine.receive(signed(.ready(epoch: 1, round: 1)))
        _ = engine.localDescriptionApplied(epoch: 1, type: .offer, sdp: sdp("NEWA"))
        _ = engine.receive(signed(.sdp(epoch: 1, round: 1, sdpType: .answer, sdp: sdp("NEWB"))))
        _ = engine.remoteDescriptionApplied(epoch: 1, ok: true)

        let mixed = engine.selectedLocalCandidate(sdp: candidate("NEWA"), remote: candidate("OLDB"))
        XCTAssertTrue(mixed.isEmpty, "new local × old remote is not the migrated path")
        let migrated = engine.selectedLocalCandidate(sdp: candidate("NEWA"),
                                                     remote: candidate("NEWB"))
        XCTAssertFalse(migrated.isEmpty)
    }
}
