import Combine
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - the deterministic runtime double
//
// The attempt's question is neither the runtime's nor the model's: ONE owner
// holds a runtime, a bridge and a presentation model together, forwards commands
// to the runtime without re-deciding anything, records exactly what the runtime
// accepted, and retires all three once.
//
// So the double below is a command RECORDER rather than a link: it logs what it
// was told, answers with whatever refusal a test asked for, and — this is the
// part that matters — gives a test a seam INSIDE `sendText`, which is where the
// only interesting race in this batch lives.

private final class FakeRuntime: LinkSessionCommands, @unchecked Sendable {

    enum Command: Equatable {
        case start
        case stop
        case openText
        case acceptText
        case rejectText
        case endText
        case sendText(String)
        case enqueueFiles([FileMeta])
        case pumpFiles
        case cancelQueuedBatch(Int)
        case cancelOutboundBatch
        case acceptInboundBatch
        case rejectInboundBatch
    }

    private let lock = NSLock()
    private var _log: [Command] = []
    private var _refusal: Error?
    private var _duringSend: (() -> Void)?
    private var _duringStart: (() -> Void)?
    private var _duringEnqueue: (() -> Void)?
    private var _nextBatch = 1

    var log: [Command] { lock.lock(); defer { lock.unlock() }; return _log }

    /// What every throwing command answers with, until it is cleared.
    var refusal: Error? {
        get { lock.lock(); defer { lock.unlock() }; return _refusal }
        set { lock.lock(); _refusal = newValue; lock.unlock() }
    }

    /// Runs INSIDE `sendText`, after the command was recorded and before it
    /// answers — which is the exact window in which a real link can end under a
    /// send that is already in flight.
    var duringSend: (() -> Void)? {
        get { lock.lock(); defer { lock.unlock() }; return _duringSend }
        set { lock.lock(); _duringSend = newValue; lock.unlock() }
    }

    /// Runs INSIDE `start`, so a test can state what must already have been
    /// wired by the time the attempt lets its runtime run.
    var duringStart: (() -> Void)? {
        get { lock.lock(); defer { lock.unlock() }; return _duringStart }
        set { lock.lock(); _duringStart = newValue; lock.unlock() }
    }

    /// The same window as `duringSend`, one lane over: a link that ends while an
    /// enqueue the lane has already accepted is on its way back.
    var duringEnqueue: (() -> Void)? {
        get { lock.lock(); defer { lock.unlock() }; return _duringEnqueue }
        set { lock.lock(); _duringEnqueue = newValue; lock.unlock() }
    }

    /// The id the next accepted enqueue answers with, exactly as a real lane
    /// answers one: the caller learns its batch number from the RETURN VALUE and
    /// from nowhere else.
    var nextBatch: Int {
        get { lock.lock(); defer { lock.unlock() }; return _nextBatch }
        set { lock.lock(); _nextBatch = newValue; lock.unlock() }
    }

    func count(of command: Command) -> Int { log.filter { $0 == command }.count }

    private func record(_ command: Command) { lock.lock(); _log.append(command); lock.unlock() }

    private func perform(_ command: Command) throws {
        record(command)
        if let refusal { throw refusal }
    }

    func start() {
        record(.start)
        duringStart?()
    }

    func stop() { record(.stop) }

    func openTextConversation() throws { try perform(.openText) }
    func acceptTextConversation() throws { try perform(.acceptText) }
    func rejectTextConversation() throws { try perform(.rejectText) }
    func endTextConversation() throws { try perform(.endText) }

    func sendText(_ body: String) throws {
        record(.sendText(body))
        duringSend?()
        if let refusal { throw refusal }
    }

    func enqueueFiles(files: [FileMeta],
                      stage: @escaping () throws -> [PlaintextSource]) throws -> Int {
        record(.enqueueFiles(files))
        duringEnqueue?()
        if let refusal { throw refusal }
        lock.lock()
        defer { lock.unlock() }
        let batch = _nextBatch
        _nextBatch += 1
        return batch
    }

    func pumpFiles() { record(.pumpFiles) }
    func cancelQueuedBatch(_ batch: Int) { record(.cancelQueuedBatch(batch)) }
    func cancelOutboundBatch() { record(.cancelOutboundBatch) }
    func acceptInboundBatch() { record(.acceptInboundBatch) }
    func rejectInboundBatch() { record(.rejectInboundBatch) }
}

// MARK: - what a view would be watching
//
// Same shape and same reason as the logs in the two presentation suites: every
// positive delivery is observed through the model's own `@Published` projection,
// because a model that assigned the right value without publishing it is a
// screen that never repaints. Lock-guarded and NOT `@MainActor`, so an
// implementation that published off the main actor could reach it and be caught.

private final class PublicationLog<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var _values: [Value] = []
    private var _alwaysOnMainThread = true
    private var expected = Int.max
    private var arrival: XCTestExpectation?
    private var subscription: AnyCancellable?

    @MainActor
    init(_ publisher: Published<Value>.Publisher) {
        subscription = publisher.sink { [weak self] value in self?.record(value) }
    }

    private func record(_ value: Value) {
        lock.lock()
        _alwaysOnMainThread = _alwaysOnMainThread && Thread.isMainThread
        _values.append(value)
        let reached = _values.count == expected
        let arrived = arrival
        lock.unlock()

        if reached { arrived?.fulfill() }
    }

    var values: [Value] { lock.lock(); defer { lock.unlock() }; return _values }
    var count: Int { lock.lock(); defer { lock.unlock() }; return _values.count }
    var alwaysOnMainThread: Bool {
        lock.lock(); defer { lock.unlock() }; return _alwaysOnMainThread
    }

    func expect(_ count: Int, _ description: String, in test: XCTestCase) -> XCTestExpectation {
        let waited = test.expectation(description: description)
        lock.lock()
        expected = count
        arrival = waited
        let already = _values.count >= count
        lock.unlock()

        if already { waited.fulfill() }
        return waited
    }

    func detach() { subscription = nil }
}

@MainActor
final class LinkSessionAttemptTests: XCTestCase {

    // MARK: - helpers

    /// Let every main-actor consumer that is already scheduled run, for the
    /// checks that assert something does NOT arrive. Not a sleep, and bounded: a
    /// no-repaint property has nothing to wait for.
    private func settle(_ turns: Int = 4) async {
        for _ in 0..<turns { await Task.yield() }
    }

    private func offMain(_ work: @escaping @Sendable () -> Void) async {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                work()
                continuation.resume()
            }
        }
    }

    /// One attempt over one recorder, plus the sink the attempt handed its
    /// runtime — which is the ONLY way anything reaches the model, and therefore
    /// the only thing a test needs in order to play the runtime's event stream.
    private func rig(_ runtime: FakeRuntime = FakeRuntime())
    -> (attempt: LinkSessionAttempt, runtime: FakeRuntime,
        publish: @Sendable (LinkSessionRuntimeEvent) -> Void) {
        var sink: (@Sendable (LinkSessionRuntimeEvent) -> Void)?
        let attempt = LinkSessionAttempt { publish in
            sink = publish
            return runtime
        }
        guard let sink else {
            XCTFail("the attempt must build its runtime through the supplied factory")
            return (attempt, runtime, { _ in })
        }
        return (attempt, runtime, sink)
    }

    /// Open the link itself, since most of what a command does is only
    /// meaningful under an authenticated one.
    private func open(_ publish: @Sendable (LinkSessionRuntimeEvent) -> Void,
                      _ attempt: LinkSessionAttempt) async {
        let log = PublicationLog(attempt.model.$phase)
        let opened = log.expect(2, "the link opens", in: self)
        publish(.opened(peerId: "peer-attempt", sas: "424242"))
        await fulfillment(of: [opened], timeout: 5)
        log.detach()
    }

    /// The manifest the transfer tests enqueue and are offered: two files, one
    /// of them inside a dropped folder.
    private var manifest: [FileMeta] {
        [FileMeta(name: "a.txt", size: 100),
         FileMeta(name: "b.txt", size: 200, path: "inner/b.txt")]
    }

    /// An open link with an open conversation, which is the state every send
    /// test wants to be in.
    private func openConversation(_ publish: @Sendable (LinkSessionRuntimeEvent) -> Void,
                                  _ attempt: LinkSessionAttempt) async {
        await open(publish, attempt)
        let log = PublicationLog(attempt.model.$textStatus)
        let arrived = log.expect(2, "the conversation opens", in: self)
        publish(.text(.status(.open)))
        await fulfillment(of: [arrived], timeout: 5)
        log.detach()
    }

    // MARK: - 1. one owner, assembled in one order

    /// The runtime is built through the factory, started exactly once, and
    /// everything it says on the way up reaches the model in the order it said
    /// it — including what it published before there was a model at all.
    ///
    /// The two publications here are the two moments that exist before an
    /// attempt is finished assembling: one from inside the factory, one from
    /// inside `start`. Neither may be lost and neither may overtake the other.
    ///
    /// What this does NOT claim is that `start()` being the initializer's last
    /// statement is load-bearing. It is not, and honestly so: the bridge buffers
    /// whatever precedes its binding, which is exactly the property it was built
    /// for, so an attempt that started earlier would still lose nothing. Starting
    /// last is the clearer order, not the mechanism.
    func testNothingTheRuntimeSaysWhileTheAttemptIsAssemblingIsLostOrReordered() async {
        let runtime = FakeRuntime()
        var sink: (@Sendable (LinkSessionRuntimeEvent) -> Void)?
        runtime.duringStart = { sink?(.opened(peerId: "peer-start", sas: "222222")) }

        let attempt = LinkSessionAttempt { publish in
            sink = publish
            publish(.sas("111111"))
            return runtime
        }

        let log = PublicationLog(attempt.model.$phase)
        let arrived = log.expect(3, "both events arrive, in order", in: self)
        await fulfillment(of: [arrived], timeout: 5)

        XCTAssertEqual(log.values, [.establishing(sas: nil),
                                    .establishing(sas: "111111"),
                                    .open(peerId: "peer-start", sas: "222222")])
        XCTAssertEqual(runtime.count(of: .start), 1, "started once")
        XCTAssertTrue(log.alwaysOnMainThread)
    }

    /// The attempt's model is the one its own bridge paints, and events produced
    /// off the main thread still land on the main actor — the whole reason the
    /// bridge is between them.
    func testEventsFromABackgroundProducerPaintTheAttemptsModelOnTheMainActor() async {
        let (attempt, _, publish) = rig()
        let log = PublicationLog(attempt.model.$phase)
        let arrived = log.expect(3, "both events arrive", in: self)

        await offMain {
            publish(.sas("246810"))
            publish(.opened(peerId: "peer-bg", sas: "246810"))
        }
        await fulfillment(of: [arrived], timeout: 5)

        XCTAssertTrue(log.alwaysOnMainThread, "every publication must be on the main thread")
        XCTAssertEqual(attempt.model.phase, .open(peerId: "peer-bg", sas: "246810"))
    }

    // MARK: - 2. commands are forwarded, not re-decided

    /// Each command reaches the runtime exactly once, in the order it was made,
    /// and the body travels verbatim.
    func testEveryTextCommandReachesTheRuntimeOnceAndInOrder() async throws {
        let (attempt, runtime, publish) = rig()
        await openConversation(publish, attempt)

        try attempt.openTextConversation()
        try attempt.acceptTextConversation()
        try attempt.rejectTextConversation()
        try attempt.sendText("  a body kept exactly  ")
        try attempt.endTextConversation()

        XCTAssertEqual(runtime.log, [.start, .openText, .acceptText, .rejectText,
                                     .sendText("  a body kept exactly  "), .endText])
    }

    /// The lane's own refusal reaches the caller unwrapped. Re-wrapping it would
    /// hide which layer answered, and this owner answers nothing of its own while
    /// it is live.
    func testALaneRefusalPropagatesUnwrapped() async {
        let (attempt, runtime, publish) = rig()
        await openConversation(publish, attempt)
        runtime.refusal = LinkTextDriverError.backpressured

        XCTAssertThrowsError(try attempt.sendText("too fast")) { error in
            XCTAssertEqual(error as? LinkTextDriverError, .backpressured)
        }
        XCTAssertThrowsError(try attempt.openTextConversation()) { error in
            XCTAssertEqual(error as? LinkTextDriverError, .backpressured)
        }
    }

    /// The runtime decides whether a message may be sent, and this owner does not
    /// pre-empt that decision with a reading of its own screen state. A composer
    /// that is greyed out is a view concern; a command that never reached the lane
    /// because presentation state disagreed with the lane's would be a second,
    /// silently divergent policy.
    func testACommandIsForwardedEvenWhenTheProjectedLaneLooksClosed() async {
        let (attempt, runtime, publish) = rig()
        await open(publish, attempt)

        XCTAssertFalse(attempt.model.canSendText, "no conversation is open")
        runtime.refusal = LinkSessionRuntimeError.notReady

        XCTAssertThrowsError(try attempt.sendText("anyway")) { error in
            XCTAssertEqual(error as? LinkSessionRuntimeError, .notReady)
        }
        XCTAssertEqual(runtime.count(of: .sendText("anyway")), 1,
                       "the lane, not this owner, is what refuses")
    }

    // MARK: - 3. the outgoing transcript entry

    /// One accepted send, one entry, verbatim — and only after the runtime
    /// accepted it. Duplicates and empties are kept for the same reason inbound
    /// ones are: the lane owns every content policy, and a second one here could
    /// only disagree with the authoritative one.
    func testAnAcceptedSendAppendsExactlyOneVerbatimOutgoingEntry() async throws {
        let (attempt, _, publish) = rig()
        await openConversation(publish, attempt)

        let log = PublicationLog(attempt.model.$textMessages)
        let bodies = ["hello", "hello", "", "  spaced  "]
        for body in bodies { try attempt.sendText(body) }

        XCTAssertEqual(attempt.model.textMessages.map(\.body), bodies)
        XCTAssertEqual(attempt.model.textMessages.map(\.direction),
                       Array(repeating: .outgoing, count: bodies.count))
        XCTAssertEqual(log.count, bodies.count + 1, "one publication per accepted send")

        let ids = attempt.model.textMessages.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count, "ids are distinct")
        XCTAssertEqual(ids, ids.sorted(), "and increasing")
    }

    /// A refusal appends nothing at all. Showing a message the lane never took is
    /// the one transcript bug a user cannot recover from: they believe it was
    /// delivered.
    func testARefusedSendAppendsNothing() async {
        let (attempt, runtime, publish) = rig()
        await openConversation(publish, attempt)

        let log = PublicationLog(attempt.model.$textMessages)
        for refusal in [LinkTextDriverError.backpressured, .transportUnavailable,
                        .refused(.notOpen), .protectedSendFailed, .laneTerminal] {
            runtime.refusal = refusal
            XCTAssertThrowsError(try attempt.sendText("never sent"))
        }

        XCTAssertTrue(attempt.model.textMessages.isEmpty)
        XCTAssertEqual(log.count, 1, "nothing repainted the transcript")
    }

    /// Outgoing and incoming entries share one id space and one order, so a view
    /// can render the conversation by id alone.
    func testOutgoingAndIncomingEntriesShareOneIncreasingIdSpace() async throws {
        let (attempt, _, publish) = rig()
        await openConversation(publish, attempt)

        let log = PublicationLog(attempt.model.$textMessages)
        try attempt.sendText("mine")

        let arrived = log.expect(3, "the peer answers", in: self)
        publish(.text(.received("theirs")))
        await fulfillment(of: [arrived], timeout: 5)

        try attempt.sendText("mine again")

        XCTAssertEqual(attempt.model.textMessages.map(\.body), ["mine", "theirs", "mine again"])
        XCTAssertEqual(attempt.model.textMessages.map(\.direction),
                       [.outgoing, .incoming, .outgoing])
        let ids = attempt.model.textMessages.map(\.id)
        XCTAssertEqual(ids, ids.sorted())
        XCTAssertEqual(Set(ids).count, 3)
    }

    /// The projection's own terminal states win over an accepted send. A real
    /// runtime cannot produce this pair — it refuses every command once its
    /// session or its lane is over — so this is defence in depth against the one
    /// visible failure it guards: a transcript that grew on a screen that had
    /// already reported the session, or the lane, finished.
    func testAnAcceptedSendCannotGrowATranscriptWhoseSessionHasEnded() async throws {
        let (attempt, runtime, publish) = rig()
        await openConversation(publish, attempt)

        let messages = PublicationLog(attempt.model.$textMessages)
        let phases = PublicationLog(attempt.model.$phase)
        let ended = phases.expect(2, "the session ends", in: self)
        publish(.ended(.linkEnded))
        await fulfillment(of: [ended], timeout: 5)

        try attempt.sendText("after the end")

        XCTAssertEqual(runtime.count(of: .sendText("after the end")), 1,
                       "the command is still forwarded — refusing it is the runtime's job")
        XCTAssertTrue(attempt.model.textMessages.isEmpty,
                      "but an ended session's transcript does not grow")
        XCTAssertEqual(messages.count, 1)
    }

    /// The same guard for the lane's own terminal state.
    func testAnAcceptedSendCannotGrowATranscriptWhoseLaneHasFailed() async throws {
        let (attempt, runtime, publish) = rig()
        await openConversation(publish, attempt)

        let messages = PublicationLog(attempt.model.$textMessages)
        let statuses = PublicationLog(attempt.model.$textStatus)
        let failed = statuses.expect(2, "the lane fails", in: self)
        publish(.text(.failed(.laneTerminal)))
        await fulfillment(of: [failed], timeout: 5)

        try attempt.sendText("after the failure")

        XCTAssertEqual(runtime.count(of: .sendText("after the failure")), 1)
        XCTAssertTrue(attempt.model.textMessages.isEmpty,
                      "a failed lane's transcript does not grow")
        XCTAssertEqual(messages.count, 1)
    }

    // MARK: - 4. retirement

    /// Retirement stops the runtime and drops the stream, once, however many
    /// times it is asked.
    func testRetirementStopsTheRuntimeAndSilencesTheStreamExactlyOnce() async {
        let (attempt, runtime, publish) = rig()
        await open(publish, attempt)

        let phases = PublicationLog(attempt.model.$phase)
        let retirements = PublicationLog(attempt.$isRetired)

        attempt.retire()
        attempt.retire()
        attempt.retire()

        XCTAssertEqual(runtime.count(of: .stop), 1, "the runtime is stopped once")
        XCTAssertTrue(attempt.isRetired)
        XCTAssertEqual(retirements.values, [false, true], "and it publishes once")

        publish(.text(.received("after retirement")))
        publish(.ended(.stopped))
        await settle()

        XCTAssertEqual(phases.count, 1, "a retired attempt paints nothing more")
        XCTAssertTrue(attempt.model.textMessages.isEmpty)
        XCTAssertEqual(attempt.model.phase, .open(peerId: "peer-attempt", sas: "424242"),
                       "the model freezes at the last thing the link actually reported")
    }

    /// A stale attempt accepts no command at all: each throws the terminal error
    /// and none of them reaches the runtime it used to own.
    func testARetiredAttemptRefusesEveryCommandWithoutReachingItsRuntime() async {
        let (attempt, runtime, publish) = rig()
        await openConversation(publish, attempt)
        attempt.retire()

        let log = PublicationLog(attempt.model.$textMessages)
        let commands: [(String, () throws -> Void)] = [
            ("open", { try attempt.openTextConversation() }),
            ("accept", { try attempt.acceptTextConversation() }),
            ("reject", { try attempt.rejectTextConversation() }),
            ("end", { try attempt.endTextConversation() }),
            ("send", { try attempt.sendText("into nothing") }),
        ]
        for (name, command) in commands {
            XCTAssertThrowsError(try command(), name) { error in
                XCTAssertEqual(error as? LinkSessionRuntimeError, .ended, name)
            }
        }

        XCTAssertEqual(runtime.log, [.start, .stop], "no command reached the runtime")
        XCTAssertTrue(attempt.model.textMessages.isEmpty)
        XCTAssertEqual(log.count, 1)
    }

    /// A view that reacts to retirement by retiring — the ordinary shape of a
    /// screen that tears itself down when its session is over — must not run the
    /// teardown twice.
    ///
    /// This is a real hazard rather than a hypothetical one: `@Published`
    /// publishes in `willSet`, so a subscriber runs BEFORE the new value is
    /// stored and a guard that reads the published property alone still sees
    /// "not retired". Left uncaught it is a double teardown at best and an
    /// unbounded recursion at worst.
    func testRetiringFromInsideTheRetirementPublicationDoesNotRunTheTeardownTwice() async {
        let (attempt, runtime, publish) = rig()
        await open(publish, attempt)

        // `dropFirst` because subscribing replays the CURRENT value: without it
        // the re-entry would happen here, at subscription time, and the test
        // would pass without the publication it is about ever occurring.
        var reentered = false
        let subscription = attempt.$isRetired.dropFirst().sink { _ in
            guard !reentered else { return }
            reentered = true
            attempt.retire()
        }
        defer { subscription.cancel() }

        attempt.retire()

        XCTAssertTrue(reentered, "the subscriber really ran inside the publication")
        XCTAssertEqual(runtime.count(of: .stop), 1, "the runtime is stopped exactly once")
        XCTAssertTrue(attempt.isRetired)
    }

    /// What this owner will ACCEPT is its own answer, and it is not the same
    /// question as what the link last reported. The model keeps saying the lane
    /// was open, because that is the last true thing it was told; the attempt
    /// says no, because it will refuse.
    func testTheAttemptAnswersWhatItWillAcceptRatherThanWhatTheLinkReported() async {
        let (attempt, _, publish) = rig()
        await openConversation(publish, attempt)

        XCTAssertTrue(attempt.canSendText)
        attempt.retire()

        XCTAssertTrue(attempt.model.canSendText, "the projection keeps its last true reading")
        XCTAssertFalse(attempt.canSendText, "and the command owner answers for itself")
    }

    // MARK: - 5. adversarial: a link that ends under a command in flight

    /// The link ends — from another thread, mid-send — and the send is
    /// nevertheless accepted. The message really did go, so it has to appear, and
    /// it has to appear exactly once and before the end that followed it.
    ///
    /// This is the ordering the whole design rests on: the command runs to
    /// completion on the main actor, so no bridge delivery can interleave between
    /// the runtime's answer and the entry that answer earns.
    func testASendAcceptedAsTheLinkEndsIsRecordedOnceAndBeforeTheEnd() async throws {
        let (attempt, runtime, publish) = rig()
        await openConversation(publish, attempt)

        let messages = PublicationLog(attempt.model.$textMessages)
        let phases = PublicationLog(attempt.model.$phase)

        // The end is produced from a background thread WHILE the send is inside
        // the runtime, and this send is accepted anyway.
        runtime.duringSend = {
            let done = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                publish(.text(.failed(.linkEnded)))
                publish(.ended(.linkEnded))
                done.signal()
            }
            done.wait()
        }

        try attempt.sendText("it really went")

        XCTAssertEqual(attempt.model.textMessages.map(\.body), ["it really went"],
                       "an accepted send is recorded even as the link ends under it")
        XCTAssertEqual(attempt.model.phase, .open(peerId: "peer-attempt", sas: "424242"),
                       "the end had not been projected yet — the command did not yield")

        let ended = phases.expect(2, "the end is projected afterwards", in: self)
        await fulfillment(of: [ended], timeout: 5)
        await settle()

        XCTAssertEqual(attempt.model.phase, .ended(.linkEnded))
        XCTAssertEqual(attempt.model.textMessages.map(\.body), ["it really went"],
                       "and it is still there, exactly once")
        XCTAssertEqual(messages.count, 2, "one publication for the one entry")
    }

    /// The same race, refused. Nothing may be recorded for a message the lane
    /// did not take, however the link was ending at that moment.
    func testASendRefusedAsTheLinkEndsRecordsNothing() async {
        let (attempt, runtime, publish) = rig()
        await openConversation(publish, attempt)

        let messages = PublicationLog(attempt.model.$textMessages)
        runtime.refusal = LinkTextDriverError.linkEnded
        runtime.duringSend = {
            let done = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                publish(.ended(.linkEnded))
                done.signal()
            }
            done.wait()
        }

        XCTAssertThrowsError(try attempt.sendText("never went")) { error in
            XCTAssertEqual(error as? LinkTextDriverError, .linkEnded)
        }
        await settle()

        XCTAssertTrue(attempt.model.textMessages.isEmpty)
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(attempt.model.phase, .ended(.linkEnded))
    }

    /// Retirement lands in the middle of a flood of events from another thread.
    /// Whatever was in flight, the outcome is one stop, no delivery after the
    /// retirement, and a model that is not repainted by an attempt that no longer
    /// owns anything.
    func testRetirementUnderABackgroundEventFloodSettlesOnce() async {
        let (attempt, runtime, publish) = rig()
        await open(publish, attempt)

        let messages = PublicationLog(attempt.model.$textMessages)
        let flooding = expectation(description: "the flood finishes")
        DispatchQueue.global().async {
            for index in 0..<400 { publish(.text(.received("flood \(index)"))) }
            flooding.fulfill()
        }

        attempt.retire()
        await fulfillment(of: [flooding], timeout: 10)
        await settle(16)

        XCTAssertEqual(runtime.count(of: .stop), 1)
        XCTAssertTrue(attempt.isRetired)
        XCTAssertTrue(messages.alwaysOnMainThread)
        // Whatever the bridge had already delivered before `retire` ran is
        // legitimate; what may NOT happen is a delivery after it. The transcript
        // is therefore allowed to be short, and must not keep growing.
        let settledCount = attempt.model.textMessages.count
        await settle(16)
        XCTAssertEqual(attempt.model.textMessages.count, settledCount,
                       "nothing arrives after retirement")
        XCTAssertLessThan(settledCount, 400, "and the flood was cut off")
    }

    // MARK: - 6. the transfer
    //
    // The same three questions as the conversation, one lane over: does the
    // command reach the runtime unchanged, is what the runtime ANSWERED the only
    // thing recorded, and does a retired attempt reach nothing at all.

    /// Six forwarding calls, each once, in the order they were made, with the
    /// manifest and the batch number travelling verbatim.
    func testEveryFileCommandReachesTheRuntimeOnceAndInOrder() async throws {
        let (attempt, runtime, publish) = rig()
        await open(publish, attempt)

        _ = try attempt.enqueueFiles(files: manifest, stage: { [] })
        attempt.pumpFiles()
        attempt.acceptInboundBatch()
        attempt.rejectInboundBatch()
        attempt.cancelQueuedBatch(4)
        attempt.cancelOutboundBatch()

        XCTAssertEqual(runtime.log, [.start, .enqueueFiles(manifest), .pumpFiles,
                                     .acceptInboundBatch, .rejectInboundBatch,
                                     .cancelQueuedBatch(4), .cancelOutboundBatch])
    }

    /// The lane answers the CALLER with the batch id, so the caller is the only
    /// thing that can create the row. One accepted enqueue, one row, with the
    /// manifest it was given and the id the lane returned.
    func testAnAcceptedEnqueueRecordsTheReturnedBatchAndItsManifestExactlyOnce() async throws {
        let (attempt, runtime, publish) = rig()
        await open(publish, attempt)
        runtime.nextBatch = 12

        let log = PublicationLog(attempt.fileModel.$batches)
        let batch = try attempt.enqueueFiles(files: manifest, stage: { [] })

        XCTAssertEqual(batch, 12, "the lane's own answer reaches the caller")
        XCTAssertEqual(attempt.fileModel.batches.count, 1)
        let projected = try XCTUnwrap(attempt.fileModel.batch(12))
        XCTAssertEqual(projected.direction, .outbound)
        XCTAssertEqual(projected.files, manifest)
        XCTAssertEqual(projected.totalBytes, 300)
        XCTAssertEqual(projected.state, .queued)
        XCTAssertEqual(log.count, 2, "one publication for the one row")
    }

    /// A refusal records nothing at all. A row for a batch the lane never took
    /// is the transfer-list equivalent of a message a user believes was
    /// delivered, and the id would be one the lane never issued.
    func testARefusedEnqueueRecordsNothing() async {
        let (attempt, runtime, publish) = rig()
        await open(publish, attempt)

        let log = PublicationLog(attempt.fileModel.$batches)
        for refusal in [LinkSessionRuntimeError.notReady, LinkSessionRuntimeError.ended] {
            runtime.refusal = refusal
            XCTAssertThrowsError(try attempt.enqueueFiles(files: manifest, stage: { [] })) {
                XCTAssertEqual($0 as? LinkSessionRuntimeError, refusal, "unwrapped")
            }
        }
        runtime.refusal = LinkLaneOwnerError.transportUnavailable
        XCTAssertThrowsError(try attempt.enqueueFiles(files: manifest, stage: { [] })) {
            XCTAssertEqual($0 as? LinkLaneOwnerError, .transportUnavailable,
                           "the lane owner's own refusal, unwrapped")
        }

        XCTAssertTrue(attempt.fileModel.batches.isEmpty)
        XCTAssertEqual(log.count, 1, "nothing repainted the transfer list")
    }

    /// The five void verbs return nothing because their refusal IS the absence
    /// of the action, so none of them may be read here as a result. A cancelled
    /// batch is cancelled when the lane says so, not when a user asked.
    func testTheVoidFileVerbsRecordNothing() async throws {
        let (attempt, runtime, publish) = rig()
        await open(publish, attempt)
        runtime.nextBatch = 5
        let batch = try attempt.enqueueFiles(files: manifest, stage: { [] })

        let log = PublicationLog(attempt.fileModel.$batches)
        attempt.pumpFiles()
        attempt.cancelQueuedBatch(batch)
        attempt.cancelOutboundBatch()
        attempt.acceptInboundBatch()
        attempt.rejectInboundBatch()

        XCTAssertEqual(attempt.fileModel.batch(batch)?.state, .queued,
                       "an asked-for cancel is not a result")
        XCTAssertEqual(runtime.count(of: .cancelQueuedBatch(batch)), 1,
                       "and the command still reached the lane")
        XCTAssertEqual(log.count, 1)
    }

    /// A stale attempt takes no file command either: the throwing one answers
    /// with the terminal error and the five void ones are inert, and none of
    /// them reaches the runtime it used to own.
    func testARetiredAttemptRefusesEveryFileCommandWithoutReachingItsRuntime() async throws {
        let (attempt, runtime, publish) = rig()
        await open(publish, attempt)
        _ = try attempt.enqueueFiles(files: manifest, stage: { [] })
        attempt.retire()

        let log = PublicationLog(attempt.fileModel.$batches)
        XCTAssertThrowsError(try attempt.enqueueFiles(files: manifest, stage: { [] })) { error in
            XCTAssertEqual(error as? LinkSessionRuntimeError, .ended)
        }
        attempt.pumpFiles()
        attempt.cancelQueuedBatch(1)
        attempt.cancelOutboundBatch()
        attempt.acceptInboundBatch()
        attempt.rejectInboundBatch()

        XCTAssertEqual(runtime.log, [.start, .enqueueFiles(manifest), .stop],
                       "no file command reached the runtime after retirement")
        XCTAssertEqual(attempt.fileModel.batches.count, 1, "and nothing was recorded")
        XCTAssertEqual(log.count, 1)
    }

    /// The file lane's mirror of the send race: the link ends from another
    /// thread while an enqueue the lane has already accepted is on its way back.
    /// The batch really was queued, so it has to appear, exactly once and before
    /// the end.
    func testAnEnqueueAcceptedAsTheLinkEndsIsRecordedOnceAndBeforeTheEnd() async throws {
        let (attempt, runtime, publish) = rig()
        await open(publish, attempt)
        runtime.nextBatch = 9

        let batches = PublicationLog(attempt.fileModel.$batches)
        let ends = PublicationLog(attempt.fileModel.$isSessionEnded)
        runtime.duringEnqueue = {
            let done = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                publish(.file(.failed(.linkEnded)))
                publish(.ended(.linkEnded))
                done.signal()
            }
            done.wait()
        }

        let batch = try attempt.enqueueFiles(files: manifest, stage: { [] })

        XCTAssertEqual(batch, 9)
        XCTAssertEqual(attempt.fileModel.batch(9)?.state, .queued,
                       "the end had not been projected yet — the command did not yield")

        let ended = ends.expect(2, "the end is projected afterwards", in: self)
        await fulfillment(of: [ended], timeout: 5)
        await settle()

        XCTAssertTrue(attempt.fileModel.isSessionEnded)
        XCTAssertEqual(attempt.fileModel.batches.map(\.id), [9], "still there, exactly once")
        XCTAssertEqual(attempt.fileModel.batch(9)?.state, .failed,
                       "and a batch the ended session will never finish has its answer")
        XCTAssertTrue(batches.alwaysOnMainThread)
    }

    // MARK: - 7. two projections, one stream

    /// Both projections are painted by the SAME ordered delivery: there is one
    /// bridge, one binding and one hop, and the file events go through it rather
    /// than through a second path of their own.
    func testFileAndTextEventsArePaintedByTheOneOrderedStream() async {
        let (attempt, _, publish) = rig()
        await open(publish, attempt)
        let files = manifest

        let batches = PublicationLog(attempt.fileModel.$batches)
        let arrived = batches.expect(3, "the offer and its progress arrive", in: self)
        await offMain {
            publish(.file(.inboundOffer(batch: 7, files: files)))
            publish(.text(.received("between the two")))
            publish(.file(.inboundProgress(batch: 7, durableBytes: 100)))
        }
        await fulfillment(of: [arrived], timeout: 5)

        XCTAssertEqual(attempt.fileModel.batch(7)?.transferredBytes, 100)
        XCTAssertEqual(attempt.fileModel.batch(7)?.state, .transferring)
        XCTAssertEqual(attempt.model.textMessages.map(\.body), ["between the two"],
                       "the conversation was painted from the same stream")
        XCTAssertTrue(batches.alwaysOnMainThread)
    }

    /// And it is painted in PUBLICATION order, which is observable because a
    /// report that arrives before the offer it belongs to names a batch that
    /// does not exist yet and is dropped. Two independent hops could deliver
    /// these the other way round and the progress would stick.
    func testTheFileProjectionSeesTheStreamInPublicationOrder() async {
        let (attempt, _, publish) = rig()
        await open(publish, attempt)
        let files = manifest

        let batches = PublicationLog(attempt.fileModel.$batches)
        let arrived = batches.expect(2, "the offer arrives", in: self)
        await offMain {
            publish(.file(.inboundProgress(batch: 7, durableBytes: 100)))
            publish(.file(.inboundOffer(batch: 7, files: files)))
        }
        await fulfillment(of: [arrived], timeout: 5)
        await settle()

        XCTAssertEqual(attempt.fileModel.batch(7)?.state, .offered)
        XCTAssertEqual(attempt.fileModel.batch(7)?.transferredBytes, 0,
                       "a report that preceded its own batch was dropped, not reordered")
    }

    /// A file lane that failed closed leaves a live link carrying a live
    /// conversation, and the two projections say exactly that. This is the whole
    /// reason they are two objects.
    func testAFailedFileLaneDoesNotFreezeTheConversation() async throws {
        let (attempt, _, publish) = rig()
        await openConversation(publish, attempt)
        let batch = try attempt.enqueueFiles(files: manifest, stage: { [] })

        let batches = PublicationLog(attempt.fileModel.$batches)
        let failed = batches.expect(2, "the file lane fails", in: self)
        publish(.file(.failed(.laneFailed)))
        await fulfillment(of: [failed], timeout: 5)

        XCTAssertEqual(attempt.fileModel.laneFailure, .laneFailed)
        XCTAssertEqual(attempt.fileModel.batch(batch)?.state, .failed)
        XCTAssertFalse(attempt.model.isEnded, "the link is untouched")
        XCTAssertTrue(attempt.canSendText)

        try attempt.sendText("still talking")
        XCTAssertEqual(attempt.model.textMessages.map(\.body), ["still talking"])
    }

    /// The whole session ending freezes BOTH, and nothing after it moves either.
    func testTheWholeSessionEndingFreezesBothProjections() async throws {
        let (attempt, _, publish) = rig()
        await openConversation(publish, attempt)
        let batch = try attempt.enqueueFiles(files: manifest, stage: { [] })
        let files = manifest

        let phases = PublicationLog(attempt.model.$phase)
        let ended = phases.expect(2, "the session ends", in: self)
        publish(.ended(.linkEnded))
        await fulfillment(of: [ended], timeout: 5)

        XCTAssertTrue(attempt.model.isEnded)
        XCTAssertTrue(attempt.fileModel.isSessionEnded)
        XCTAssertEqual(attempt.fileModel.batch(batch)?.state, .failed)

        await offMain {
            publish(.file(.inboundOffer(batch: 77, files: files)))
            publish(.file(.outboundFinished(batch: batch, ok: true)))
            publish(.text(.received("after the end")))
        }
        await settle()

        XCTAssertEqual(attempt.fileModel.batches.map(\.id), [batch])
        XCTAssertEqual(attempt.fileModel.batch(batch)?.state, .failed)
        XCTAssertTrue(attempt.model.textMessages.isEmpty)
    }

    /// Retirement silences the file projection exactly as it silences the text
    /// one: the stream is dropped before the teardown can produce anything, so
    /// the transfer list freezes at the last thing the link actually reported.
    func testRetirementSilencesTheFileProjectionToo() async throws {
        let (attempt, _, publish) = rig()
        await open(publish, attempt)
        let batch = try attempt.enqueueFiles(files: manifest, stage: { [] })
        let files = manifest

        attempt.retire()
        await offMain {
            publish(.file(.inboundOffer(batch: 99, files: files)))
            publish(.file(.outboundFinished(batch: batch, ok: true)))
            publish(.ended(.stopped))
        }
        await settle()

        XCTAssertEqual(attempt.fileModel.batches.map(\.id), [batch])
        XCTAssertEqual(attempt.fileModel.batch(batch)?.state, .queued)
        XCTAssertFalse(attempt.fileModel.isSessionEnded,
                       "a retired attempt paints nothing more, including the end")
    }

    /// The session ends in the middle of a flood of file events from another
    /// thread. Whatever was in flight, the list settles once: nothing is left
    /// spinning, and nothing arrives afterwards.
    func testAWholeSessionEndInsideAFileEventFloodSettlesOnce() async {
        let (attempt, _, publish) = rig()
        await open(publish, attempt)
        let files = manifest

        let started = DispatchSemaphore(value: 0)
        let flooding = expectation(description: "the flood finishes")
        DispatchQueue.global().async {
            for index in 0..<400 {
                publish(.file(.inboundOffer(batch: index, files: files)))
                publish(.file(.inboundProgress(batch: index, durableBytes: 100)))
                if index == 4 { started.signal() }
            }
            flooding.fulfill()
        }
        started.wait()
        publish(.ended(.stopped))
        await fulfillment(of: [flooding], timeout: 10)
        await settle(16)

        XCTAssertTrue(attempt.fileModel.isSessionEnded)
        XCTAssertGreaterThanOrEqual(attempt.fileModel.batches.count, 5,
                                    "what was published before the end was kept")
        XCTAssertTrue(attempt.fileModel.batches.allSatisfy(\.isTerminal),
                      "nothing is left spinning on a session that has ended")

        let settled = attempt.fileModel.batches
        await settle(16)
        XCTAssertEqual(attempt.fileModel.batches, settled, "and nothing arrives after the end")
    }

    // MARK: - 8. lifetime

    /// The attempt owns all three, and releasing it releases all three. Nothing
    /// below it keeps the screen — or the runtime — alive on its own.
    ///
    /// Deliberately WITHOUT retiring first: `invalidate` releases the bridge's
    /// stored handler, so retiring would hide a binding that had started
    /// capturing the model strongly. Dropped live, the bridge is still holding
    /// its wrapper when the model has to go away.
    func testTheAttemptReleasesEverythingItOwnsWhenItGoesAway() async {
        weak var observedModel: LinkSessionPresentationModel?
        weak var observedFileModel: LinkFilePresentationModel?
        weak var observedRuntime: FakeRuntime?
        do {
            let runtime = FakeRuntime()
            let (attempt, _, publish) = rig(runtime)
            observedModel = attempt.model
            observedFileModel = attempt.fileModel
            observedRuntime = runtime

            let log = PublicationLog(attempt.model.$phase)
            let arrived = log.expect(2, "the attempt is live", in: self)
            publish(.opened(peerId: "peer-lifetime", sas: "808080"))
            await fulfillment(of: [arrived], timeout: 5)
            XCTAssertTrue(attempt.model.isOpen)
            log.detach()
        }
        await settle()

        XCTAssertNil(observedModel, "the attempt was the model's only owner")
        XCTAssertNil(observedFileModel, "and the file projection's")
        XCTAssertNil(observedRuntime, "and the runtime's")
    }

    /// Retirement is explicit, and a dropped attempt is not retirement. Pinned
    /// because the alternative — cleaning up in `deinit` — would end a live link
    /// from whichever thread happened to release the last reference, which is the
    /// one boundary that cannot promise main-actor isolation.
    func testDroppingAnAttemptDoesNotRetireIt() async {
        let runtime = FakeRuntime()
        do {
            _ = rig(runtime)
        }
        await settle()

        XCTAssertEqual(runtime.count(of: .stop), 0,
                       "a deallocation must not stop a runtime")
    }

    // MARK: - 8b. what the room is told
    //
    // Two facts from the one ordered delivery, and no stream. The room acts on
    // them — it releases `LinkAdmission` when nothing else will — so the cost of
    // an extra one is a second release, and the cost of a missing one is a room
    // stuck on a link that no longer exists.

    /// Both facts, in delivery order, and nothing else. Everything a projection
    /// paints — digits, conversation, transfer, committed batch — is deliberately
    /// not a room's business and must not reach it.
    func testTheRoomHearsOnlyTheOpenAndTheEnd() async {
        let (attempt, _, publish) = rig()
        var heard: [LinkSessionLifecycle] = []
        attempt.onLifecycle = { heard.append($0) }

        publish(.sas("424242"))
        publish(.opened(peerId: "peer-room", sas: "424242"))
        publish(.text(.status(.open)))
        publish(.file(.outboundProgress(batch: 1, sentBytes: 10)))
        publish(.received(LinkReceivedBatch(batch: 1, files: [], container: nil)))
        publish(.ended(.linkEnded))
        await settle()

        XCTAssertEqual(heard, [.opened(peerId: "peer-room"), .ended(.linkEnded)])
    }

    /// The end is announced ONCE. A second release can land on an establishment
    /// that has already begun for somebody else, and that peer is then refused
    /// for the rest of the session.
    func testTheEndIsAnnouncedToTheRoomExactlyOnce() async {
        let (attempt, _, publish) = rig()
        var ends = 0
        attempt.onLifecycle = { if case .ended = $0 { ends += 1 } }

        publish(.opened(peerId: "peer-room", sas: "424242"))
        publish(.ended(.establishmentClosed))
        publish(.ended(.linkEnded))
        publish(.ended(.stopped))
        await settle()

        XCTAssertEqual(ends, 1, "terminal means terminal for the room too")
    }

    /// Both projections already show what the link reported by the time the room
    /// hears it. The room's handler is where the next establishment begins, so a
    /// screen repainted after that would be painting for a session that has
    /// already been replaced.
    func testBothProjectionsAreSettledBeforeTheRoomIsTold() async {
        let (attempt, _, publish) = rig()
        var phaseWhenTold: LinkSessionConnectionPhase?
        var fileTerminalWhenTold: Bool?
        attempt.onLifecycle = { event in
            guard case .ended = event else { return }
            phaseWhenTold = attempt.model.phase
            fileTerminalWhenTold = attempt.fileModel.isSessionEnded
        }

        publish(.opened(peerId: "peer-room", sas: "424242"))
        publish(.ended(.linkEnded))
        await settle()

        XCTAssertEqual(phaseWhenTold, .ended(.linkEnded),
                       "the conversation projection is already terminal")
        XCTAssertEqual(fileTerminalWhenTold, true,
                       "and so is the transfer projection")
    }

    /// A retired attempt says nothing to its room. Retirement is the room's own
    /// act — it is the caller of `retire()` — so an announcement would be this
    /// object telling an owner something that owner just did, and it would arrive
    /// after that owner had already moved on.
    func testARetiredAttemptTellsItsRoomNothing() async {
        let (attempt, _, publish) = rig()
        var heard: [LinkSessionLifecycle] = []
        attempt.onLifecycle = { heard.append($0) }
        publish(.opened(peerId: "peer-room", sas: "424242"))
        await settle()
        XCTAssertEqual(heard, [.opened(peerId: "peer-room")])

        attempt.retire()
        publish(.ended(.stopped))
        await settle()

        XCTAssertEqual(heard, [.opened(peerId: "peer-room")],
                       "the bridge is silenced before anything can be produced")
    }

    /// An attempt nobody owns behaves exactly as it always did. Every screen-only
    /// test in this file leaves the hook nil, and that has to stay a supported
    /// shape rather than a latent crash.
    func testAnAttemptWithNoRoomIsUnaffected() async {
        let (attempt, _, publish) = rig()

        publish(.opened(peerId: "peer-room", sas: "424242"))
        publish(.ended(.linkEnded))
        await settle()

        XCTAssertEqual(attempt.model.phase, .ended(.linkEnded))
    }

    // MARK: - 9. nothing here is reachable from production

    /// Comments stripped, so a rule about code is not satisfied — or broken — by
    /// prose.
    private func code(_ source: String) -> String {
        source
            .components(separatedBy: "\n")
            .map { line -> String in
                guard let marker = line.range(of: "//") else { return line }
                return String(line[line.startIndex..<marker.lowerBound])
            }
            .joined(separator: "\n")
    }

    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → …/apps
    private var appsRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    /// Every Swift source under the app targets, as code with comments removed.
    private func appSources() throws -> [(name: String, code: String)] {
        let roots = [appsRoot.appendingPathComponent("RelayiumKit/Sources"),
                     appsRoot.appendingPathComponent("ios"),
                     appsRoot.appendingPathComponent("mac")]
        var sources: [(String, String)] = []
        for root in roots {
            guard FileManager.default.fileExists(atPath: root.path) else { continue }
            let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?
                .compactMap { $0 as? URL }
                .filter { $0.pathExtension == "swift" }
            for file in try XCTUnwrap(files) {
                sources.append((file.lastPathComponent,
                                code((try? String(contentsOf: file, encoding: .utf8)) ?? "")))
            }
        }
        XCTAssertGreaterThan(sources.count, 50, "the scan really reached the app sources")
        return sources
    }

    /// Both flags are still false, and the ONLY thing that builds an attempt is
    /// `LinkSessionFactory` — which nothing reaches either: no view, no app
    /// target, no environment. `LinkSessionFactoryTests` owns the second half of
    /// that sentence; this half is that no other file may build one at all.
    func testTheAttemptStaysUnreachableFromProduction() throws {
        XCTAssertFalse(LINK_BUILD_SUPPORT)
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)

        for source in try appSources() where source.name != "LinkSessionFactory.swift" {
            XCTAssertFalse(source.code.contains("LinkSessionAttempt("),
                           "\(source.name) constructs a link session attempt")
        }
    }

    /// ONE owner, structurally: the attempt is the only app source that builds a
    /// bridge or either projection, the only one that binds the stream, and the
    /// only one that records what a command earned. A second builder would be a
    /// second lifetime for the same screen — two things able to retire, or to
    /// fail to retire, one attempt.
    func testOnlyTheAttemptOwnsTheBridgeBothProjectionsAndWhatCommandsEarned() throws {
        // The symbol, and the ONE file that is allowed to contain it because it
        // declares the thing.
        let owned: [(symbol: String, declaredIn: String)] = [
            ("LinkSessionEventBridge(", "LinkSessionEventBridge.swift"),
            ("LinkSessionPresentationModel(", "LinkSessionPresentationModel.swift"),
            ("LinkFilePresentationModel(", "LinkFilePresentationModel.swift"),
            ("recordOutgoing(", "LinkSessionPresentationModel.swift"),
            ("recordOutgoingBatch(", "LinkFilePresentationModel.swift"),
        ]
        // Deliberately NOT a scan for `bind(to:`: `LinkLaneOwner` has one of its
        // own and the string alone cannot tell them apart. What makes a second
        // binding of THIS bridge unreachable is that no other app source may
        // even name the type — the entry above — and that both projection
        // sources are pinned free of it in their own suites.
        for source in try appSources() where source.name != "LinkSessionAttempt.swift" {
            for entry in owned where source.name != entry.declaredIn {
                XCTAssertFalse(source.code.contains(entry.symbol),
                               "\(source.name) reaches for \(entry.symbol), which is the attempt's")
            }
        }
    }

    /// The one binding, in the one place, through the bridge's structural
    /// weak-owner API — so the attempt's own stream cannot keep the attempt
    /// alive, and both projections are painted by that single delivery rather
    /// than by a path each.
    func testTheAttemptIsWhatBindsTheStreamAndFansItOut() throws {
        let url = appsRoot
            .appendingPathComponent("RelayiumKit/Sources/RelayiumAppKit/LinkSessionAttempt.swift")
        let source = code(try String(contentsOf: url, encoding: .utf8))
        XCTAssertFalse(source.isEmpty, "the attempt source must be readable")

        XCTAssertTrue(source.contains("bind(to: self)"),
                      "the owner must arrive as the handler's parameter")
        XCTAssertEqual(source.components(separatedBy: "bind(to:").count - 1, 1,
                       "exactly one binding for one attempt")
    }

    /// The command owner forwards; it does not build a link. No key, no codec,
    /// no identity, no transport and no crypto policy belongs in this layer —
    /// everything it can act on arrives already authenticated, through the
    /// factory it was handed.
    func testTheAttemptBuildsNoKeyCodecIdentityOrTransport() throws {
        let url = appsRoot
            .appendingPathComponent("RelayiumKit/Sources/RelayiumAppKit/LinkSessionAttempt.swift")
        let source = code(try String(contentsOf: url, encoding: .utf8))
        XCTAssertFalse(source.isEmpty, "the attempt source must be readable")

        for forbidden in ["LinkCodecs", "LinkIdentity", "LinkSessionRuntime(", "WebRTC",
                          "Sodium", "SecureBytes", "LinkLaneOwner", "LinkRecoveryCoordinator"] {
            XCTAssertFalse(source.contains(forbidden),
                           "the attempt must not name \(forbidden)")
        }
        XCTAssertFalse(source.contains("deinit"),
                       "retirement is explicit, not a side effect of deallocation")
    }

    /// And the projection still owns no command surface of its own: it records
    /// what the attempt tells it and calls nothing back.
    func testThePresentationModelStillSendsNothing() throws {
        let url = appsRoot
            .appendingPathComponent("RelayiumKit/Sources/RelayiumAppKit/LinkSessionPresentationModel.swift")
        let source = code(try String(contentsOf: url, encoding: .utf8))
        XCTAssertFalse(source.isEmpty, "the model source must be readable")

        for forbidden in ["LinkSessionCommands", "LinkSessionRuntime(", "LinkSessionAttempt"] {
            XCTAssertFalse(source.contains(forbidden),
                           "the projection must not name \(forbidden)")
        }
    }
}
