import Combine
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - what a view would be watching
//
// Same recorder and same reason as the three suites beside this one: every
// positive change is observed through the projection's own `@Published` value,
// because a model that assigned the right batch without publishing it is a
// screen that never repaints — and because the NEGATIVE property this batch
// cares most about, "a duplicate or stale event repaints nothing", has no other
// observable form.

private final class BatchLog: @unchecked Sendable {
    private let lock = NSLock()
    private var _values: [[LinkFileBatch]] = []
    private var subscription: AnyCancellable?

    @MainActor
    init(_ model: LinkFilePresentationModel) {
        subscription = model.$batches.sink { [weak self] value in self?.record(value) }
    }

    private func record(_ value: [LinkFileBatch]) {
        lock.lock()
        _values.append(value)
        lock.unlock()
    }

    /// Note that `$batches` replays the current value on subscription, so the
    /// first entry is always the list the model held when this log attached.
    var count: Int { lock.lock(); defer { lock.unlock() }; return _values.count }
}

@MainActor
final class LinkSessionPresentationFileTests: XCTestCase {

    // MARK: - helpers

    private func meta(_ name: String, _ size: Int, path: String? = nil) -> FileMeta {
        FileMeta(name: name, size: size, path: path)
    }

    /// The manifest most tests use: two files, one of them inside a dropped
    /// folder, 300 bytes in total.
    private var manifest: [FileMeta] {
        [meta("a.txt", 100), meta("b.txt", 200, path: "inner/b.txt")]
    }

    private func url(_ path: String) -> URL { URL(fileURLWithPath: path) }

    /// The projection alone. No bridge, no runtime, no attempt: this suite is
    /// about what one ordered event stream turns into, and the wiring that
    /// carries it is `LinkSessionAttemptTests`'.
    private func rig() -> LinkFilePresentationModel { LinkFilePresentationModel() }

    /// An inbound batch that has been offered and has moved.
    private func offered(_ model: LinkFilePresentationModel,
                         batch: Int = 7,
                         files: [FileMeta]? = nil) {
        model.apply(.file(.inboundOffer(batch: batch, files: files ?? manifest)))
    }

    /// An outbound batch, which can only ever enter through the command path.
    private func enqueued(_ model: LinkFilePresentationModel,
                          batch: Int = 3,
                          files: [FileMeta]? = nil) {
        model.recordOutgoingBatch(batch, files: files ?? manifest)
    }

    private func projected(_ model: LinkFilePresentationModel, _ id: Int) throws -> LinkFileBatch {
        try XCTUnwrap(model.batch(id), "batch \(id) is not projected")
    }

    // MARK: - 1. what a screen opens as

    func testTheInitialProjectionHasNothingInIt() {
        let model = rig()

        XCTAssertTrue(model.batches.isEmpty)
        XCTAssertTrue(model.inbound.isEmpty)
        XCTAssertTrue(model.outbound.isEmpty)
        XCTAssertTrue(model.offers.isEmpty)
        XCTAssertNil(model.laneFailure)
        XCTAssertFalse(model.isFileLaneFailed)
        XCTAssertFalse(model.isSessionEnded)
    }

    /// The other lane and the connection are not this projection's, exactly as
    /// the file lane is not the session projection's.
    func testTheConnectionAndTheConversationAreNotProjectedHere() {
        let model = rig()
        let log = BatchLog(model)

        model.apply(.sas("123456"))
        model.apply(.opened(peerId: "peer", sas: "123456"))
        model.apply(.text(.status(.open)))
        model.apply(.text(.received("hello")))
        model.apply(.text(.failed(.laneTerminal)))

        XCTAssertTrue(model.batches.isEmpty)
        XCTAssertNil(model.laneFailure)
        XCTAssertEqual(log.count, 1, "nothing repainted the transfer list")
    }

    // MARK: - 2. an inbound offer

    /// The manifest travels verbatim — name, size and the folder-relative path
    /// that decides the shape of what lands on disk — and the total is its own
    /// arithmetic rather than anything the event carried.
    func testAnInboundOfferIsProjectedWithItsManifestVerbatim() throws {
        let model = rig()
        offered(model, batch: 7)

        let batch = try projected(model, 7)
        XCTAssertEqual(batch.id, 7)
        XCTAssertEqual(batch.direction, .inbound)
        XCTAssertEqual(batch.files, manifest, "the manifest is kept exactly")
        XCTAssertEqual(batch.files[1].path, "inner/b.txt")
        XCTAssertEqual(batch.totalBytes, 300)
        XCTAssertEqual(batch.transferredBytes, 0)
        XCTAssertEqual(batch.state, .offered)
        XCTAssertFalse(batch.isTerminal)
        XCTAssertEqual(model.offers.map(\.id), [7])
        XCTAssertEqual(model.inbound.map(\.id), [7])
        XCTAssertTrue(model.outbound.isEmpty)
    }

    /// A second offer for a batch that already exists is not a second batch, and
    /// it may not reset the one that is there.
    func testARepeatedInboundOfferNeitherDuplicatesNorResetsTheBatch() throws {
        let model = rig()
        offered(model, batch: 7)
        model.apply(.file(.inboundProgress(batch: 7, durableBytes: 120)))

        let log = BatchLog(model)
        offered(model, batch: 7, files: [meta("other.txt", 9)])

        XCTAssertEqual(model.batches.count, 1)
        let batch = try projected(model, 7)
        XCTAssertEqual(batch.files, manifest, "the first manifest stands")
        XCTAssertEqual(batch.transferredBytes, 120)
        XCTAssertEqual(batch.state, .transferring)
        XCTAssertEqual(log.count, 1, "and nothing repainted")
    }

    /// Batches keep the order they became known in, whichever direction they go.
    func testBatchesKeepTheOrderTheyBecameKnownIn() {
        let model = rig()
        offered(model, batch: 7)
        enqueued(model, batch: 3)
        offered(model, batch: 9)

        XCTAssertEqual(model.batches.map(\.id), [7, 3, 9])
        XCTAssertEqual(model.inbound.map(\.id), [7, 9])
        XCTAssertEqual(model.outbound.map(\.id), [3])
    }

    // MARK: - 3. progress

    /// Progress is what moves an offer onto the wire, and it is the whole
    /// manifest's durable prefix rather than the current file's.
    func testInboundProgressMovesTheOfferToTransferring() throws {
        let model = rig()
        offered(model, batch: 7)

        model.apply(.file(.inboundProgress(batch: 7, durableBytes: 100)))
        var batch = try projected(model, 7)
        XCTAssertEqual(batch.state, .transferring)
        XCTAssertEqual(batch.transferredBytes, 100)
        XCTAssertEqual(try XCTUnwrap(batch.fractionCompleted), 100.0 / 300.0, accuracy: 1e-9)
        XCTAssertTrue(model.offers.isEmpty, "an offer that is moving is not waiting for an answer")

        model.apply(.file(.inboundProgress(batch: 7, durableBytes: 300)))
        batch = try projected(model, 7)
        XCTAssertEqual(batch.transferredBytes, 300)
        XCTAssertEqual(try XCTUnwrap(batch.fractionCompleted), 1, accuracy: 1e-9)
        XCTAssertFalse(batch.isTerminal, "a full bar is not a result")
    }

    func testOutboundProgressMovesAQueuedBatchToTransferring() throws {
        let model = rig()
        enqueued(model, batch: 3)
        XCTAssertEqual(try projected(model, 3).state, .queued)

        model.apply(.file(.outboundProgress(batch: 3, sentBytes: 250)))

        let batch = try projected(model, 3)
        XCTAssertEqual(batch.state, .transferring)
        XCTAssertEqual(batch.transferredBytes, 250)
    }

    /// A resumed attempt restarts its own byte count and a rebased send window
    /// can report from further back. The driver already clamps; this is the
    /// second guard, because a bar that walks backwards is the most visible bug
    /// this projection can have.
    func testProgressIsMonotonicAndARegressionRepaintsNothing() throws {
        let model = rig()
        offered(model, batch: 7)
        model.apply(.file(.inboundProgress(batch: 7, durableBytes: 250)))

        let log = BatchLog(model)
        model.apply(.file(.inboundProgress(batch: 7, durableBytes: 100)))
        model.apply(.file(.inboundProgress(batch: 7, durableBytes: 250)))
        model.apply(.file(.inboundProgress(batch: 7, durableBytes: -5)))

        XCTAssertEqual(try projected(model, 7).transferredBytes, 250)
        XCTAssertEqual(log.count, 1, "a stale or duplicate report repaints nothing")
    }

    /// The one mistake that would corrupt two batches at once.
    func testProgressNeverCrossesBatchIds() throws {
        let model = rig()
        offered(model, batch: 7)
        offered(model, batch: 9)
        enqueued(model, batch: 3)

        model.apply(.file(.inboundProgress(batch: 7, durableBytes: 100)))
        model.apply(.file(.inboundProgress(batch: 9, durableBytes: 200)))
        model.apply(.file(.outboundProgress(batch: 3, sentBytes: 30)))

        XCTAssertEqual(try projected(model, 7).transferredBytes, 100)
        XCTAssertEqual(try projected(model, 9).transferredBytes, 200)
        XCTAssertEqual(try projected(model, 3).transferredBytes, 30)
    }

    /// A report whose direction disagrees with the batch it names belongs to
    /// nothing this projection knows, and it may not be applied to the batch
    /// that happens to share the number.
    func testAReportForTheWrongDirectionChangesNothing() throws {
        let model = rig()
        offered(model, batch: 7)

        let log = BatchLog(model)
        model.apply(.file(.outboundProgress(batch: 7, sentBytes: 100)))
        model.apply(.file(.outboundFinished(batch: 7, ok: true)))

        XCTAssertEqual(try projected(model, 7).state, .offered)
        XCTAssertEqual(try projected(model, 7).transferredBytes, 0)
        XCTAssertEqual(log.count, 1)
    }

    /// An outbound batch exists because `enqueue` returned it, and an inbound one
    /// because an offer arrived. Anything else names a batch this projection was
    /// never told about, and inventing one from a progress report would be a row
    /// with no manifest behind it.
    func testAReportForAnUnknownBatchChangesNothing() {
        let model = rig()
        let log = BatchLog(model)

        model.apply(.file(.inboundProgress(batch: 42, durableBytes: 10)))
        model.apply(.file(.outboundProgress(batch: 42, sentBytes: 10)))
        model.apply(.file(.inboundFinished(batch: 42, ok: true)))
        model.apply(.file(.outboundFinished(batch: 42, ok: true)))
        model.apply(.file(.batchesFailed([42])))
        model.apply(.received(LinkReceivedBatch(batch: 42, files: [url("/tmp/x")], container: nil)))

        XCTAssertTrue(model.batches.isEmpty)
        XCTAssertEqual(log.count, 1)
    }

    // MARK: - 4. results

    /// `ok: true` on the inbound side says the driver's destination committed.
    /// It does NOT carry where, and this projection may not pretend it does:
    /// only `received` proves a disk commit, and only it has URLs.
    func testInboundFinishedDoesNotFabricateACommittedReceive() throws {
        let model = rig()
        offered(model, batch: 7)

        model.apply(.file(.inboundFinished(batch: 7, ok: true)))

        let batch = try projected(model, 7)
        XCTAssertEqual(batch.state, .finished)
        XCTAssertTrue(batch.isTerminal)
        XCTAssertNil(batch.receivedFiles, "no URL may be invented")
        XCTAssertNil(batch.receivedContainer)
    }

    /// The ordinary order, which the runtime produces by construction: the
    /// commit callback fires inside `finalize`, so `received` is admitted before
    /// the `inboundFinished` that follows it.
    func testACommittedReceiveCarriesItsUrlsVerbatimAndSurvivesTheFinishedReport() throws {
        let model = rig()
        offered(model, batch: 7)
        model.apply(.file(.inboundProgress(batch: 7, durableBytes: 300)))

        let files = [url("/tmp/landing/inner/b.txt"), url("/tmp/landing/a.txt")]
        let container = url("/tmp/landing")
        model.apply(.received(LinkReceivedBatch(batch: 7, files: files, container: container)))

        var batch = try projected(model, 7)
        XCTAssertEqual(batch.state, .received(files: files, container: container))
        XCTAssertEqual(batch.receivedFiles, files, "in manifest order, verbatim")
        XCTAssertEqual(batch.receivedContainer, container)
        XCTAssertTrue(batch.isTerminal)

        let log = BatchLog(model)
        model.apply(.file(.inboundFinished(batch: 7, ok: true)))

        batch = try projected(model, 7)
        XCTAssertEqual(batch.receivedFiles, files, "the result the commit proved still stands")
        XCTAssertEqual(log.count, 1, "and the report that followed it repainted nothing")
    }

    /// A flat batch lands straight in the directory the application chose, and
    /// `nil` there is a real answer rather than a missing one.
    func testAFlatCommittedReceiveHasNoContainer() throws {
        let model = rig()
        offered(model, batch: 7)

        model.apply(.received(LinkReceivedBatch(batch: 7,
                                                files: [url("/tmp/a.txt")],
                                                container: nil)))

        let batch = try projected(model, 7)
        XCTAssertEqual(batch.state, .received(files: [url("/tmp/a.txt")], container: nil))
        XCTAssertNil(batch.receivedContainer)
    }

    /// The inverse order, which the runtime does not promise but which nothing
    /// in it forbids either. A commit is the strongest thing this projection can
    /// be told — those bytes ARE the user's files — so it upgrades a batch that
    /// was only reported finished rather than being dropped as late.
    func testACommittedReceiveThatArrivesAfterItsFinishedReportStillLands() throws {
        let model = rig()
        offered(model, batch: 7)
        model.apply(.file(.inboundFinished(batch: 7, ok: true)))
        XCTAssertEqual(try projected(model, 7).state, .finished)

        let files = [url("/tmp/late/a.txt")]
        model.apply(.received(LinkReceivedBatch(batch: 7, files: files, container: nil)))

        XCTAssertEqual(try projected(model, 7).receivedFiles, files)
    }

    /// Nothing takes a commit back. `finalize` returning is the moment the bytes
    /// stop being a transfer and become the user's files, and no later report
    /// may make a screen say otherwise.
    func testNothingCanTakeACommittedReceiveBack() throws {
        let model = rig()
        offered(model, batch: 7)
        let files = [url("/tmp/kept/a.txt")]
        model.apply(.received(LinkReceivedBatch(batch: 7, files: files, container: nil)))

        let log = BatchLog(model)
        model.apply(.file(.inboundFinished(batch: 7, ok: false)))
        model.apply(.file(.batchesFailed([7])))
        model.apply(.file(.inboundProgress(batch: 7, durableBytes: 10)))
        model.apply(.received(LinkReceivedBatch(batch: 7, files: [url("/tmp/other")], container: nil)))

        XCTAssertEqual(try projected(model, 7).receivedFiles, files)
        XCTAssertEqual(try projected(model, 7).state, .received(files: files, container: nil))
        XCTAssertEqual(log.count, 1)
    }

    func testAnInboundBatchThatDidNotCommitIsFailed() throws {
        let model = rig()
        offered(model, batch: 7)

        model.apply(.file(.inboundFinished(batch: 7, ok: false)))

        let batch = try projected(model, 7)
        XCTAssertEqual(batch.state, .failed)
        XCTAssertTrue(batch.isTerminal)
        XCTAssertNil(batch.receivedFiles)
    }

    func testAnOutboundBatchThePeerCompletedIsFinished() throws {
        let model = rig()
        enqueued(model, batch: 3)
        model.apply(.file(.outboundProgress(batch: 3, sentBytes: 300)))

        model.apply(.file(.outboundFinished(batch: 3, ok: true)))

        XCTAssertEqual(try projected(model, 3).state, .finished)
        XCTAssertEqual(try projected(model, 3).transferredBytes, 300)
    }

    /// A consent timeout, a cancel, a refusal, an ordered abort and a stranded
    /// batch are all the same answer to a screen: it did not go.
    func testAnOutboundBatchThatDidNotGoIsFailed() throws {
        let model = rig()
        enqueued(model, batch: 3)

        model.apply(.file(.outboundFinished(batch: 3, ok: false)))

        XCTAssertEqual(try projected(model, 3).state, .failed)
    }

    /// The driver's retirement contract, from this side: `outboundFinished` and
    /// `batchesFailed` are mutually exclusive reports for one accepted batch, so
    /// whichever really arrives is the result — and a second one, if the contract
    /// were ever broken, may not overwrite the first.
    func testTheFirstResultForABatchIsTheOneThatStands() throws {
        let model = rig()
        enqueued(model, batch: 3)
        enqueued(model, batch: 4)

        model.apply(.file(.outboundFinished(batch: 3, ok: true)))
        model.apply(.file(.batchesFailed([3])))

        model.apply(.file(.batchesFailed([4])))
        model.apply(.file(.outboundFinished(batch: 4, ok: true)))

        XCTAssertEqual(try projected(model, 3).state, .finished, "a result is not undone by a loss")
        XCTAssertEqual(try projected(model, 4).state, .failed, "and a loss is not undone by a result")
    }

    /// `batchesFailed` names the queued and active work a terminal lane took
    /// with it, in one report, and it may not touch anything it did not name.
    func testBatchesFailedNamesExactlyTheWorkItLists() throws {
        let model = rig()
        enqueued(model, batch: 3)
        enqueued(model, batch: 4)
        enqueued(model, batch: 5)
        offered(model, batch: 7)
        model.apply(.file(.outboundProgress(batch: 3, sentBytes: 50)))

        model.apply(.file(.batchesFailed([3, 5])))

        XCTAssertEqual(try projected(model, 3).state, .failed)
        XCTAssertEqual(try projected(model, 3).transferredBytes, 50, "how far it got is still true")
        XCTAssertEqual(try projected(model, 4).state, .queued)
        XCTAssertEqual(try projected(model, 5).state, .failed)
        XCTAssertEqual(try projected(model, 7).state, .offered)
    }

    /// A terminal batch is terminal. Late progress for one is the ordinary shape
    /// of a report that was queued behind the result that retired it.
    func testLateProgressDoesNotResurrectATerminalBatch() throws {
        let model = rig()
        enqueued(model, batch: 3)
        offered(model, batch: 7)
        model.apply(.file(.outboundFinished(batch: 3, ok: true)))
        model.apply(.file(.inboundFinished(batch: 7, ok: false)))

        let log = BatchLog(model)
        model.apply(.file(.outboundProgress(batch: 3, sentBytes: 999)))
        model.apply(.file(.inboundProgress(batch: 7, durableBytes: 999)))

        XCTAssertEqual(try projected(model, 3).state, .finished)
        XCTAssertEqual(try projected(model, 3).transferredBytes, 0)
        XCTAssertEqual(try projected(model, 7).state, .failed)
        XCTAssertEqual(log.count, 1)
    }

    // MARK: - 5. the lane's own end

    /// The file lane going terminal is one report and it is absorbing: every
    /// batch that had no result gets one, and nothing this lane says afterwards
    /// starts, moves or revives anything.
    func testLaneTerminalFailureFailsEveryUnfinishedBatchAndIsAbsorbing() throws {
        let model = rig()
        enqueued(model, batch: 3)
        enqueued(model, batch: 4)
        offered(model, batch: 7)
        offered(model, batch: 9)
        model.apply(.file(.outboundFinished(batch: 4, ok: true)))
        model.apply(.file(.inboundProgress(batch: 9, durableBytes: 100)))

        model.apply(.file(.failed(.sendFailed)))

        XCTAssertEqual(model.laneFailure, .sendFailed)
        XCTAssertTrue(model.isFileLaneFailed)
        XCTAssertEqual(try projected(model, 3).state, .failed)
        XCTAssertEqual(try projected(model, 4).state, .finished, "a result already earned stands")
        XCTAssertEqual(try projected(model, 7).state, .failed)
        XCTAssertEqual(try projected(model, 9).state, .failed)
        XCTAssertEqual(try projected(model, 9).transferredBytes, 100)
        XCTAssertTrue(model.offers.isEmpty)

        let log = BatchLog(model)
        model.apply(.file(.failed(.linkEnded)))
        model.apply(.file(.inboundOffer(batch: 11, files: manifest)))
        model.apply(.file(.inboundProgress(batch: 9, durableBytes: 300)))
        model.apply(.file(.outboundProgress(batch: 3, sentBytes: 300)))
        model.apply(.file(.outboundFinished(batch: 3, ok: true)))
        model.recordOutgoingBatch(12, files: manifest)

        XCTAssertEqual(model.laneFailure, .sendFailed, "the failure that started it is the one kept")
        XCTAssertEqual(model.batches.map(\.id), [3, 4, 7, 9], "no batch is added after the lane ended")
        XCTAssertEqual(try projected(model, 3).state, .failed)
        XCTAssertEqual(try projected(model, 9).transferredBytes, 100)
        XCTAssertEqual(log.count, 1)
    }

    /// The one thing a terminal lane cannot make untrue. A `finalize` that was
    /// already in flight when the lane failed commits afterwards, and the driver
    /// reports it: those bytes are on the user's disk, and a screen that said
    /// "failed" while the files sat in the receive folder would be lying about
    /// the only thing the user can check.
    func testACommitThatLandsAfterTheLaneFailedIsStillProjected() throws {
        let model = rig()
        offered(model, batch: 7)
        model.apply(.file(.inboundProgress(batch: 7, durableBytes: 300)))
        model.apply(.file(.failed(.laneFailed)))
        XCTAssertEqual(try projected(model, 7).state, .failed)

        let files = [url("/tmp/late/a.txt"), url("/tmp/late/inner/b.txt")]
        model.apply(.received(LinkReceivedBatch(batch: 7, files: files, container: url("/tmp/late"))))

        XCTAssertEqual(try projected(model, 7).receivedFiles, files)
        XCTAssertEqual(try projected(model, 7).receivedContainer, url("/tmp/late"))
        XCTAssertEqual(model.laneFailure, .laneFailed, "and the lane is still failed")
    }

    // MARK: - 6. the whole session's end

    /// `ended` is the runtime's last event, so a batch with no result will never
    /// get one — and both projections freeze on it.
    func testTheWholeSessionEndingFreezesTheFileProjection() throws {
        let model = rig()
        enqueued(model, batch: 3)
        offered(model, batch: 7)
        model.apply(.file(.inboundProgress(batch: 7, durableBytes: 120)))
        model.apply(.file(.outboundFinished(batch: 3, ok: true)))

        model.apply(.ended(.linkEnded))

        XCTAssertTrue(model.isSessionEnded)
        XCTAssertEqual(try projected(model, 3).state, .finished)
        XCTAssertEqual(try projected(model, 7).state, .failed, "it will never get a result now")

        let log = BatchLog(model)
        model.apply(.file(.inboundOffer(batch: 11, files: manifest)))
        model.apply(.file(.inboundProgress(batch: 7, durableBytes: 300)))
        model.apply(.file(.inboundFinished(batch: 7, ok: true)))
        model.apply(.file(.failed(.linkEnded)))
        model.apply(.received(LinkReceivedBatch(batch: 7, files: [url("/tmp/a")], container: nil)))
        model.apply(.ended(.stopped))
        model.recordOutgoingBatch(12, files: manifest)

        XCTAssertEqual(model.batches.map(\.id), [3, 7])
        XCTAssertEqual(try projected(model, 7).state, .failed)
        XCTAssertEqual(try projected(model, 7).transferredBytes, 120)
        XCTAssertNil(model.laneFailure, "an event after the end changes nothing at all")
        XCTAssertEqual(log.count, 1)
    }

    /// A lane that failed first keeps its reason across the end, because that is
    /// what a screen has to be able to explain afterwards.
    func testTheLaneFailureSurvivesTheSessionEnd() {
        let model = rig()
        model.apply(.file(.failed(.inboundBufferOverflow)))
        model.apply(.ended(.linkEnded))

        XCTAssertEqual(model.laneFailure, .inboundBufferOverflow)
        XCTAssertTrue(model.isSessionEnded)
    }

    // MARK: - 7. arithmetic

    /// A manifest is a peer's claim about sizes, so its total is arithmetic on
    /// numbers this side did not choose. It saturates rather than trapping.
    func testATotalThatWouldOverflowSaturatesRatherThanTrapping() throws {
        let model = rig()
        offered(model, batch: 7, files: [meta("a", .max), meta("b", .max), meta("c", 1)])

        XCTAssertEqual(try projected(model, 7).totalBytes, .max)
        XCTAssertEqual(try XCTUnwrap(try projected(model, 7).fractionCompleted), 0, accuracy: 1e-9)
    }

    /// A negative size cannot make a total go backwards into a fraction nobody
    /// can render.
    func testANegativeSizeCannotProduceANegativeFraction() throws {
        let model = rig()
        offered(model, batch: 7, files: [meta("a", -100)])

        model.apply(.file(.inboundProgress(batch: 7, durableBytes: 10)))

        let batch = try projected(model, 7)
        XCTAssertGreaterThanOrEqual(batch.transferredBytes, 0)
        if let fraction = batch.fractionCompleted {
            XCTAssertGreaterThanOrEqual(fraction, 0)
            XCTAssertLessThanOrEqual(fraction, 1)
        }
    }

    /// An empty manifest has no fraction to show rather than a division by zero.
    func testAZeroByteManifestHasNoFractionRatherThanADivisionByZero() throws {
        let model = rig()
        offered(model, batch: 7, files: [meta("empty", 0)])

        XCTAssertEqual(try projected(model, 7).totalBytes, 0)
        XCTAssertNil(try projected(model, 7).fractionCompleted)

        model.apply(.file(.inboundFinished(batch: 7, ok: true)))
        XCTAssertEqual(try projected(model, 7).state, .finished, "and it can still finish")
    }

    /// Progress past the total is a disagreement between the driver and a
    /// manifest, and the number the driver reported is kept exactly as it came.
    /// Only the fraction — which is this projection's own arithmetic — is bounded.
    func testProgressBeyondTheTotalIsKeptVerbatimAndTheFractionIsBounded() throws {
        let model = rig()
        offered(model, batch: 7)

        model.apply(.file(.inboundProgress(batch: 7, durableBytes: 900)))

        XCTAssertEqual(try projected(model, 7).transferredBytes, 900)
        XCTAssertEqual(try XCTUnwrap(try projected(model, 7).fractionCompleted), 1, accuracy: 1e-9)
    }

    // MARK: - 8. what only the attempt owner knows

    /// An outbound batch exists because the runtime ACCEPTED an enqueue and
    /// answered with its id. Recording the same one twice would be two rows for
    /// one transfer.
    func testAnOutgoingBatchIsRecordedOnceWithItsManifest() throws {
        let model = rig()
        enqueued(model, batch: 3)

        let log = BatchLog(model)
        model.recordOutgoingBatch(3, files: [meta("different.txt", 1)])

        XCTAssertEqual(model.batches.count, 1)
        XCTAssertEqual(try projected(model, 3).files, manifest)
        XCTAssertEqual(try projected(model, 3).direction, .outbound)
        XCTAssertEqual(try projected(model, 3).state, .queued)
        XCTAssertEqual(log.count, 1)
    }

    /// An id an inbound offer already claimed is not an outbound batch. The two
    /// spaces are the same one, and the runtime never issues a collision — this
    /// is the guard that keeps a broken producer from turning one batch into
    /// another rather than into a second row.
    func testAnOutgoingBatchCannotTakeOverAnInboundId() throws {
        let model = rig()
        offered(model, batch: 7)

        model.recordOutgoingBatch(7, files: [meta("mine.txt", 1)])

        XCTAssertEqual(model.batches.count, 1)
        XCTAssertEqual(try projected(model, 7).direction, .inbound)
        XCTAssertEqual(try projected(model, 7).files, manifest)
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

    /// Nothing but its ONE owner constructs one, including when macOS reaches
    /// it through the production Workspace.
    func testTheFileProjectionKeepsOneConstructionPath() throws {
        // `LINK_BUILD_SUPPORT` is deliberately NOT asserted here. This suite's
        // subject is not the flag, and its value is per platform: a claim about
        // it in nineteen unrelated files is nineteen places to get the iOS
        // branch wrong. `PeerCapabilityRegistryTests` owns that contract, value
        // and source both.
        XCTAssertFalse(LINK_TRANSPORT_REPLACEMENT_SUPPORTED)

        let roots = [appsRoot.appendingPathComponent("RelayiumKit/Sources"),
                     appsRoot.appendingPathComponent("ios"),
                     appsRoot.appendingPathComponent("mac")]
        var scanned = 0
        for root in roots {
            guard FileManager.default.fileExists(atPath: root.path) else { continue }
            let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?
                .compactMap { $0 as? URL }
                .filter { $0.pathExtension == "swift"
                    && $0.lastPathComponent != "LinkFilePresentationModel.swift"
                    && $0.lastPathComponent != "LinkSessionAttempt.swift" }
            for file in try XCTUnwrap(files) {
                scanned += 1
                let text = code((try? String(contentsOf: file, encoding: .utf8)) ?? "")
                XCTAssertFalse(text.contains("LinkFilePresentationModel("),
                               "\(file.lastPathComponent) constructs a file presentation model")
                XCTAssertFalse(text.contains("recordOutgoingBatch("),
                               "\(file.lastPathComponent) records an outbound batch")
            }
        }
        XCTAssertGreaterThan(scanned, 50, "the scan really reached the app sources")
    }

    /// The projection sends nothing, ends nothing and builds nothing. It has no
    /// runtime to call, no bridge to invalidate, and no key, codec, identity or
    /// transport anywhere in it.
    func testTheFileProjectionSendsNothingAndBuildsNoLink() throws {
        let url = appsRoot
            .appendingPathComponent("RelayiumKit/Sources/RelayiumAppKit/LinkFilePresentationModel.swift")
        let source = code(try String(contentsOf: url, encoding: .utf8))
        XCTAssertFalse(source.isEmpty, "the projection source must be readable")

        for forbidden in ["LinkSessionCommands", "LinkSessionRuntime(", "LinkSessionAttempt",
                          "LinkSessionEventBridge", "LinkCodecs", "LinkIdentity", "WebRTC",
                          "Sodium", "SecureBytes", "LinkLaneOwner", "LinkFileDriver(",
                          "FileManager", "invalidate(", "deinit"] {
            XCTAssertFalse(source.contains(forbidden),
                           "the file projection must not name \(forbidden)")
        }
    }

    // MARK: - reading order

    /// The transfer list only grows, so the batch the user just started belongs
    /// at the top. The stored array must not move: every update path indexes it,
    /// and `batch(_:)` resolves an id against it.
    func testBatchesAreReadNewestFirstWhileStorageStaysChronological() {
        let model = rig()
        enqueued(model, batch: 1, files: [meta("first.txt", 1)])
        offered(model, batch: 2, files: [meta("second.txt", 2)])
        enqueued(model, batch: 3, files: [meta("third.txt", 3)])

        XCTAssertEqual(model.batches.map(\.id), [1, 2, 3],
                       "storage stays in the order the batches became known")
        XCTAssertEqual(model.batchesNewestFirst.map(\.id), [3, 2, 1])
        // Reverse mutation: the two answers must not be the same list. A model
        // that returned `batches` unchanged would satisfy the assertion above
        // only because three ids happen to be there.
        XCTAssertNotEqual(model.batchesNewestFirst.map(\.id), model.batches.map(\.id))
        // …and the reading order carries the WHOLE row, not just an id order.
        XCTAssertEqual(model.batchesNewestFirst.first?.files.map(\.name), ["third.txt"])
        XCTAssertEqual(model.batches.last?.files.map(\.name), ["third.txt"])

        // A later arrival goes to the FRONT of the reading order and the BACK of
        // storage, which is the property a one-shot list could fake.
        offered(model, batch: 4, files: [meta("fourth.txt", 4)])
        XCTAssertEqual(model.batchesNewestFirst.map(\.id), [4, 3, 2, 1])
        XCTAssertEqual(model.batches.map(\.id), [1, 2, 3, 4])
        XCTAssertEqual(model.batch(4)?.files.map(\.name), ["fourth.txt"],
                       "id lookup still resolves against the stored order")
    }

    /// One entry reads the same in both directions. Without this a reversal that
    /// silently dropped to an empty list would still pass a "not equal" check
    /// somewhere else.
    func testASingleBatchReadsIdenticallyInBothOrders() {
        let model = rig()
        enqueued(model, batch: 9, files: [meta("only.txt", 1)])
        XCTAssertEqual(model.batchesNewestFirst.map(\.id), [9])
        XCTAssertEqual(model.batchesNewestFirst.map(\.id), model.batches.map(\.id))
        XCTAssertTrue(LinkFilePresentationModel().batchesNewestFirst.isEmpty)
    }
}
