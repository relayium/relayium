import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// What "Try Again" is allowed to mean on a stored download.
///
/// The receive path now separates a malformed link, a missing object, download
/// limiting, temporary server/storage unavailability, a dropped connection and a
/// corrupt or unsafe payload. Those distinctions are worth nothing if the
/// recovery affordance ignores them: macOS used to offer the same Try Again for
/// a 404 as for a dropped connection — and it re-ran `resolve()`, so after a
/// blob failure it walked the user back to a card they had already accepted —
/// while iOS offered nothing at all for a failure that a second tap would have
/// fixed.
///
/// Every assertion here is on the TYPED recovery, never on the sentence: the
/// shipped catalogs are free to change wording, and a policy that reads English
/// would be a policy that is wrong in Simplified Chinese.
@MainActor
final class CloudDownloadRecoveryPolicyTests: XCTestCase {
    private let parent = URL(fileURLWithPath: "/tmp/relayium-recovery-policy")

    /// The two transient outcomes, in both phases. `network` is a connection
    /// that dropped; `downloadUnavailable` is the service answering that it
    /// could not serve this right now. Neither classifies the link or payload as
    /// invalid, so repeating the interrupted phase is the available remedy.
    func testTransientCloudFailuresRepeatTheWorkOfTheirOwnPhase() {
        for error in [CloudError.network, .downloadUnavailable(status: 503),
                      .downloadUnavailable(status: 403)] {
            XCTAssertEqual(DownloadRecovery.after(error, phase: .resolving), .resolveLink,
                           "\(error) while resolving")
            XCTAssertEqual(DownloadRecovery.after(error, phase: .downloading(into: parent)),
                           .downloadAgain(into: parent), "\(error) while downloading")
        }
    }

    /// Everything else is terminal: repeating the identical request produces the
    /// identical answer, so an affordance promising otherwise is a lie the user
    /// pays for with taps.
    ///
    /// The list is deliberately exhaustive over the failures this path can
    /// actually reach — a limit that has not reset, an object that is gone, a
    /// credential problem on a flow that carries no credential, an unparseable
    /// body, a manifest that fails its integrity check, a manifest naming a path
    /// outside the destination, a destination that is already taken, and a
    /// stream that ended short.
    func testTerminalFailuresOfferNoRetryInEitherPhase() {
        let terminal: [Error] = [
            CloudError.notFound,
            CloudError.downloadLimited,
            CloudError.rateLimited,
            CloudError.dailyQuota,
            CloudError.monthlyTraffic,
            CloudError.unauthorized,
            CloudError.quota,
            CloudError.decoding,
            CloudError.server(status: 500),
            StoredWireError.invalidManifest,
            StoredWireError.truncatedStream,
            StoredWireError.lengthMismatch,
            StoredWireError.invalidKey,
            ManifestPathError.unsafePath("../escape.txt"),
            ManifestPathError.duplicatePath("A.txt"),
            DownloadDestinationError.directoryExists(name: "relayium-abc"),
            DownloadDestinationError.fileExists(name: "notes.txt"),
            DownloadDestinationError.incomplete,
        ]
        for error in terminal {
            XCTAssertEqual(DownloadRecovery.after(error, phase: .resolving), DownloadRecovery.none,
                           "\(error) while resolving")
            XCTAssertEqual(DownloadRecovery.after(error, phase: .downloading(into: parent)),
                           DownloadRecovery.none, "\(error) while downloading")
        }
    }
}

/// The same policy, proved where the user meets it: through the model, against a
/// stubbed server, with the retry actually re-running the work.
@MainActor
final class CloudDownloadRecoveryTests: XCTestCase {
    override func tearDown() {
        StubURLProtocol.router = nil
        StubURLProtocol.stub = nil
        StubURLProtocol.reset()
        super.tearDown()
    }

    private func tempDir() throws -> URL {
        let d = FileManager.default.temporaryDirectory
            .appendingPathComponent("g2-recover-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    /// A resolvable link plus the exact bytes a real upload of it would produce.
    private struct Fixture {
        let id: String
        let key: [UInt8]
        let metaBody: Data
        let frames: [Data]
        var link: String { "https://relayium.com/d/\(id)#k=\(encodeStoreKey(key))" }
        var blobBody: Data { frames.reduce(into: Data()) { $0.append($1) } }
    }

    private func fixture(id: String, files: [ManifestFile],
                         contents: [String: [UInt8]] = [:],
                         key: [UInt8] = [UInt8](repeating: 11, count: 32)) throws -> Fixture {
        let enc = try encryptManifest(key: key, StoredManifest(files: files))
        let meta = StoredFileMeta(encManifest: Data(enc).base64EncodedString(),
                                  size: 0, burnAfterRead: false, expiresAt: 0)
        let encryptor = ChunkEncryptor(key: key, sources: files.map {
            DataSource(name: $0.name, bytes: contents[$0.name] ?? [])
        })
        var frames: [Data] = []
        while let frame = try encryptor.next() { frames.append(frame) }
        return Fixture(id: id, key: key, metaBody: try JSONEncoder().encode(meta), frames: frames)
    }

    private func model() -> CloudDownloadModel {
        CloudDownloadModel(client: CloudClient(baseURL: URL(string: "https://example.invalid")!,
                                               session: StubURLProtocol.session()))
    }

    private func waitFor(_ what: String, _ ready: @MainActor () -> Bool,
                         seconds: TimeInterval = 5) async {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if ready() { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for \(what)")
    }

    private func waitForFailure(_ model: CloudDownloadModel) async {
        await waitFor("the transfer to fail", { if case .failed = model.state { return true }; return false })
    }

    /// Resolve `fixture`'s link and assert it reached `.ready`.
    private func resolved(_ model: CloudDownloadModel, _ fixture: Fixture) async {
        model.linkText = fixture.link
        model.resolve()
        await waitFor("the manifest to resolve",
                      { if case .ready = model.state { return true }; return false })
    }

    // MARK: - resolution

    /// A dropped connection while fetching metadata: the link is fine, the key
    /// is fine, nothing was decrypted. Retrying repeats the resolution.
    func testAMetadataNetworkFailureRetriesResolution() async throws {
        let f = try fixture(id: "meta-net", files: [ManifestFile(name: "a.txt", size: 1)])
        let attempts = AttemptCounter()
        StubURLProtocol.router = { _ in
            attempts.next() == 1
                ? .init(status: 200, failure: URLError(.networkConnectionLost))
                : .init(status: 200, body: f.metaBody)
        }
        let m = model()
        m.linkText = f.link
        m.resolve()
        await waitForFailure(m)

        XCTAssertEqual(m.recovery, .resolveLink)
        XCTAssertTrue(m.canRetry)

        m.retry()
        await waitFor("the retried resolution to succeed",
                      { if case .ready = m.state { return true }; return false })
        XCTAssertEqual(m.recovery, DownloadRecovery.none, "a settled retry must not stay armed")
    }

    /// The service answering that it cannot serve this right now, before any
    /// byte of ciphertext exists.
    func testAMetadataUnavailableFailureRetriesResolution() async throws {
        let f = try fixture(id: "meta-503", files: [ManifestFile(name: "a.txt", size: 1)])
        let attempts = AttemptCounter()
        StubURLProtocol.router = { _ in
            attempts.next() == 1 ? .init(status: 503) : .init(status: 200, body: f.metaBody)
        }
        let m = model()
        m.linkText = f.link
        m.resolve()
        await waitForFailure(m)
        XCTAssertEqual(m.recovery, .resolveLink)

        m.retry()
        await waitFor("the retried resolution to succeed",
                      { if case .ready = m.state { return true }; return false })
    }

    /// A metadata request can wait on a network timeout for much longer than a
    /// person should be trapped on a locked receive surface. Cancel must return
    /// immediately and a response that arrives afterwards must not resurrect
    /// the abandoned manifest.
    func testCancelDuringResolutionReturnsToIdleAndIgnoresTheLateManifest() async throws {
        let f = try fixture(id: "cancel-resolve",
                            files: [ManifestFile(name: "late.txt", size: 1)])
        let gate = RequestGate()
        StubURLProtocol.router = { _ in
            gate.hold()
            return .init(status: 200, body: f.metaBody)
        }
        let m = model()
        m.linkText = f.link
        m.resolve()
        await gate.reached()
        var released = false
        defer { if !released { gate.release() } }

        guard case .resolving = m.state else {
            return XCTFail("metadata request never became active: \(m.state)")
        }
        m.cancel()
        XCTAssertEqual(m.state, .idle)
        XCTAssertFalse(m.isBusy)
        XCTAssertEqual(m.linkText, f.link, "Cancel should leave the editable link available")
        XCTAssertTrue(m.sessionFiles.isEmpty)
        XCTAssertEqual(m.recovery, DownloadRecovery.none)

        gate.release()
        released = true
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(m.state, .idle, "a late manifest resurrected the cancelled task")
        XCTAssertTrue(m.sessionFiles.isEmpty)
    }

    // MARK: - the transfer itself

    /// A failure during the blob repeats the DOWNLOAD, into the destination the
    /// user already chose — not the resolution they already accepted.
    func testABlobUnavailableFailureRetriesTheDownloadIntoTheSameDestination() async throws {
        let f = try fixture(id: "blob-503", files: [ManifestFile(name: "a.txt", size: 3)],
                            contents: ["a.txt": [1, 2, 3]])
        let blobAttempts = AttemptCounter()
        StubURLProtocol.router = { req in
            guard req.url?.path.hasSuffix("/blob") == true else {
                return .init(status: 200, body: f.metaBody)
            }
            return blobAttempts.next() == 1 ? .init(status: 503) : .init(status: 200, body: f.blobBody)
        }
        let m = model()
        await resolved(m, f)

        let parent = try tempDir()
        m.download(into: parent)
        await waitForFailure(m)
        XCTAssertEqual(m.recovery, .downloadAgain(into: parent))

        m.retry()
        await waitFor("the retried download to finish",
                      { if case .done = m.state { return true }; return false })
        guard case .done(let urls) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(try Data(contentsOf: urls[0]), Data([1, 2, 3]))
        XCTAssertEqual(m.recovery, DownloadRecovery.none)
    }

    /// **Adversarial:** the retry must not inherit the wreckage of the attempt
    /// it is repeating.
    ///
    /// A connection that drops mid-blob leaves a partly written container in the
    /// user's chosen folder. The download refuses to merge into an existing
    /// `relayium-<id>`, so if that container survived the failure the retry
    /// would fail on it forever — a retry button that can only ever fail once
    /// armed. The bytes matter too: a resumed-looking file made of one attempt's
    /// prefix and another's suffix is worse than no file.
    func testAPartialDownloadIsDiscardedBeforeTheRetryRewritesIt() async throws {
        let f = try fixture(id: "blob-partial",
                            files: [ManifestFile(name: "a.txt", size: 3),
                                    ManifestFile(name: "b.txt", size: 2)],
                            contents: ["a.txt": [1, 2, 3], "b.txt": [4, 5]])
        XCTAssertGreaterThan(f.frames.count, 1, "the fixture must be able to stop half way")
        let blobAttempts = AttemptCounter()
        StubURLProtocol.router = { req in
            guard req.url?.path.hasSuffix("/blob") == true else {
                return .init(status: 200, body: f.metaBody)
            }
            // First attempt: hand over everything but the last frame, then drop
            // the connection. Enough plaintext arrives to create the container
            // and write into it.
            return blobAttempts.next() == 1
                ? .init(status: 200, bodyChunks: Array(f.frames.dropLast()),
                        failure: URLError(.networkConnectionLost))
                : .init(status: 200, body: f.blobBody)
        }
        let m = model()
        await resolved(m, f)

        let parent = try tempDir()
        m.download(into: parent)
        await waitForFailure(m)

        XCTAssertEqual(m.recovery, .downloadAgain(into: parent))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: parent.path), [],
                       "a partly written container survived the failure it came from")

        m.retry()
        await waitFor("the retried download to finish",
                      { if case .done = m.state { return true }; return false })
        guard case .done(let urls) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: parent.path),
                       ["relayium-blob-partial"], "the retry must not leave a second container")
        XCTAssertEqual(urls.map(\.lastPathComponent), ["a.txt", "b.txt"])
        XCTAssertEqual(try Data(contentsOf: urls[0]), Data([1, 2, 3]))
        XCTAssertEqual(try Data(contentsOf: urls[1]), Data([4, 5]))
    }

    /// **Adversarial:** two taps on a button that is still on screen.
    ///
    /// The recovery is consumed synchronously, so the second tap finds nothing
    /// armed. Without that, two downloads would race into one destination: the
    /// loser refuses on the container the winner just created, and whichever
    /// settles last decides what the user is told about bytes they may or may
    /// not have.
    func testRepeatedRetryTapsCannotStartTwoDownloads() async throws {
        let f = try fixture(id: "double-tap", files: [ManifestFile(name: "a.txt", size: 3),
                                                     ManifestFile(name: "b.txt", size: 2)],
                            contents: ["a.txt": [1, 2, 3], "b.txt": [4, 5]])
        let blobAttempts = AttemptCounter()
        StubURLProtocol.router = { req in
            guard req.url?.path.hasSuffix("/blob") == true else {
                return .init(status: 200, body: f.metaBody)
            }
            return blobAttempts.next() == 1 ? .init(status: 503) : .init(status: 200, body: f.blobBody)
        }
        let m = model()
        await resolved(m, f)
        let parent = try tempDir()
        m.download(into: parent)
        await waitForFailure(m)
        XCTAssertTrue(m.canRetry)

        m.retry()
        XCTAssertFalse(m.canRetry, "the recovery must be spent before the second tap can read it")
        m.retry()
        m.retry()

        await waitFor("the retried download to finish",
                      { if case .done = m.state { return true }; return false })
        guard case .done(let urls) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: parent.path),
                       ["relayium-double-tap"])
        XCTAssertEqual(urls.map(\.lastPathComponent), ["a.txt", "b.txt"])
        XCTAssertEqual(blobAttempts.count, 2, "a second tap started another transfer")
    }

    /// The same guard one phase earlier: three taps on a failed resolution issue
    /// exactly one more request.
    func testRepeatedRetryTapsCannotStartTwoResolutions() async throws {
        let f = try fixture(id: "double-meta", files: [ManifestFile(name: "a.txt", size: 1)])
        let attempts = AttemptCounter()
        StubURLProtocol.router = { _ in
            attempts.next() == 1
                ? .init(status: 200, failure: URLError(.networkConnectionLost))
                : .init(status: 200, body: f.metaBody)
        }
        let m = model()
        m.linkText = f.link
        m.resolve()
        await waitForFailure(m)

        m.retry(); m.retry(); m.retry()
        await waitFor("the retried resolution to succeed",
                      { if case .ready = m.state { return true }; return false })
        // Settle: a duplicate request would arrive after the state did.
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(attempts.count, 2, "a second tap started another resolution")
    }

    // MARK: - terminal failures

    /// A malformed link never reaches the network, and no amount of retrying
    /// parses it.
    func testAMalformedLinkOffersNoRetry() {
        let m = model()
        m.linkText = "nonsense"
        m.resolve()
        guard case .failed = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(m.recovery, DownloadRecovery.none)
        XCTAssertFalse(m.canRetry)
        m.retry()
        guard case .failed = m.state else { return XCTFail("retry moved a terminal state: \(m.state)") }
    }

    /// 404, 429, an unparseable body and a manifest that fails its integrity
    /// check: four different final answers, none of which a second identical
    /// request changes. The retry entry point must be inert for all of them.
    func testTerminalMetadataFailuresOfferNoRetryAndRetryDoesNothing() async throws {
        let f = try fixture(id: "terminal", files: [ManifestFile(name: "a.txt", size: 1)])
        let wrongKeyMeta = try fixture(id: "terminal",
                                       files: [ManifestFile(name: "a.txt", size: 1)],
                                       key: [UInt8](repeating: 99, count: 32)).metaBody
        let cases: [(String, StubURLProtocol.Stub)] = [
            ("404", .init(status: 404)),
            ("429", .init(status: 429)),
            ("unparseable meta", .init(status: 200, body: Data("{".utf8))),
            // The manifest decrypts with the link's key or it does not: this one
            // was sealed under a different one.
            ("integrity", .init(status: 200, body: wrongKeyMeta)),
        ]
        for (name, stub) in cases {
            StubURLProtocol.router = { _ in stub }
            StubURLProtocol.reset()
            let m = model()
            m.linkText = f.link
            m.resolve()
            await waitForFailure(m)

            XCTAssertEqual(m.recovery, DownloadRecovery.none, name)
            XCTAssertFalse(m.canRetry, name)
            let before = StubURLProtocol.requestCount
            m.retry()
            try? await Task.sleep(nanoseconds: 100_000_000)
            XCTAssertEqual(StubURLProtocol.requestCount, before, "\(name): retry issued a request")
            guard case .failed = m.state else {
                return XCTFail("\(name): retry moved a terminal state to \(m.state)")
            }
        }
    }

    /// A manifest naming a path outside the destination is refused, and refusal
    /// is the answer — not something to try again. The failure happens in the
    /// download phase, which is exactly where a phase-only policy would wrongly
    /// arm a retry.
    func testAnUnsafeManifestOffersNoRetry() async throws {
        let f = try fixture(id: "unsafe", files: [ManifestFile(name: "../escape.txt", size: 1),
                                                  ManifestFile(name: "ok.txt", size: 1)],
                            contents: ["../escape.txt": [1], "ok.txt": [2]])
        StubURLProtocol.router = { req in
            req.url?.path.hasSuffix("/blob") == true
                ? .init(status: 200, body: f.blobBody)
                : .init(status: 200, body: f.metaBody)
        }
        let m = model()
        await resolved(m, f)
        let parent = try tempDir()
        m.download(into: parent)
        await waitForFailure(m)

        XCTAssertEqual(m.recovery, DownloadRecovery.none)
        XCTAssertFalse(m.canRetry)
        let before = StubURLProtocol.requestCount
        m.retry()
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(StubURLProtocol.requestCount, before, "retry issued a request")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: parent.path), [])
    }

    /// A destination that is already taken is a LOCAL problem with a local
    /// remedy — choose another folder on macOS, move the file out of
    /// `Relayium/Received` on iOS — and repeating the identical write would
    /// meet the identical name. The copy keeps saying so; the retry stays off.
    func testATakenDestinationOffersNoRetry() async throws {
        let f = try fixture(id: "taken", files: [ManifestFile(name: "notes.txt", size: 4)],
                            contents: ["notes.txt": [1, 2, 3, 4]])
        StubURLProtocol.router = { req in
            req.url?.path.hasSuffix("/blob") == true
                ? .init(status: 200, body: f.blobBody)
                : .init(status: 200, body: f.metaBody)
        }
        let parent = try tempDir()
        try Data("keep".utf8).write(to: parent.appendingPathComponent("notes.txt"))

        let m = model()
        await resolved(m, f)
        m.download(into: parent)
        await waitForFailure(m)

        XCTAssertEqual(m.recovery, DownloadRecovery.none)
        XCTAssertEqual(try String(contentsOf: parent.appendingPathComponent("notes.txt")), "keep")
    }

    // MARK: - stale recovery

    /// Cancel is a decision to stop, not a pause: nothing may stay armed behind
    /// it.
    func testCancelClearsRecovery() async throws {
        let f = try fixture(id: "cancel", files: [ManifestFile(name: "a.txt", size: 1)])
        StubURLProtocol.router = { _ in .init(status: 503) }
        let m = model()
        m.linkText = f.link
        m.resolve()
        await waitForFailure(m)
        XCTAssertTrue(m.canRetry)

        m.cancel()
        XCTAssertEqual(m.recovery, DownloadRecovery.none)
        XCTAssertEqual(m.state, .idle)
        m.retry()
        XCTAssertEqual(m.state, .idle, "a retry after cancel restarted abandoned work")
    }

    /// New work supersedes the old failure, so the recovery armed by that
    /// failure must not outlive it — least of all a `.downloadAgain` pointing at
    /// the destination of a transfer the user has moved on from.
    func testNewWorkClearsStaleRecovery() async throws {
        let f = try fixture(id: "stale", files: [ManifestFile(name: "a.txt", size: 3)],
                            contents: ["a.txt": [1, 2, 3]])
        let blobAttempts = AttemptCounter()
        StubURLProtocol.router = { req in
            guard req.url?.path.hasSuffix("/blob") == true else {
                return .init(status: 200, body: f.metaBody)
            }
            return blobAttempts.next() == 1 ? .init(status: 503) : .init(status: 200, body: f.blobBody)
        }
        let m = model()
        await resolved(m, f)
        let stale = try tempDir()
        m.download(into: stale)
        await waitForFailure(m)
        XCTAssertEqual(m.recovery, .downloadAgain(into: stale))

        // Resolving again is new work.
        m.resolve()
        XCTAssertEqual(m.recovery, DownloadRecovery.none, "a new resolution kept the old recovery")
        await waitFor("the manifest to resolve",
                      { if case .ready = m.state { return true }; return false })

        // So is a download into a different destination.
        let chosen = try tempDir()
        m.download(into: chosen)
        XCTAssertEqual(m.recovery, DownloadRecovery.none, "a new download kept the old recovery")
        await waitFor("the download to finish",
                      { if case .done = m.state { return true }; return false })
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: stale.path), [],
                       "the abandoned destination was written to")
    }

    /// **Adversarial:** changing the field and asking to open another link while
    /// a blob is in flight must not replace the visible task or its cancellation
    /// handle. The macOS surface used to allow exactly this; the first writer
    /// then continued invisibly after `task` was overwritten by the new resolve.
    func testASecondResolveCannotReplaceAnActiveDownload() async throws {
        let first = try fixture(id: "busy-first",
                                files: [ManifestFile(name: "first.txt", size: 3)],
                                contents: ["first.txt": [1, 2, 3]])
        let second = try fixture(id: "busy-second",
                                 files: [ManifestFile(name: "second.txt", size: 1)],
                                 contents: ["second.txt": [9]])
        let blobGate = RequestGate()
        let requests = RequestRecorder()
        StubURLProtocol.router = { request in
            requests.record(request)
            if request.url?.path == "/api/files/busy-first/blob" {
                blobGate.hold()
                return .init(status: 200, body: first.blobBody)
            }
            if request.url?.path == "/api/files/busy-second/meta" {
                return .init(status: 200, body: second.metaBody)
            }
            return .init(status: 200, body: first.metaBody)
        }

        let m = model()
        await resolved(m, first)
        let parent = try tempDir()
        m.download(into: parent)
        await blobGate.reached()
        var released = false
        defer { if !released { blobGate.release() } }
        guard case .downloading = m.state else {
            return XCTFail("the first download never became active: \(m.state)")
        }

        let before = requests.requests.count
        m.linkText = second.link
        m.resolve()
        try? await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertEqual(requests.requests.count, before,
                       "a second link issued a request over the active download")
        guard case .downloading = m.state else {
            return XCTFail("the second link replaced the visible task: \(m.state)")
        }

        blobGate.release()
        released = true
        await waitFor("the original download to finish",
                      { if case .done = m.state { return true }; return false })
        guard case .done(let urls) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(m.sessionFiles, [FileMeta(name: "first.txt", size: 3)])
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(urls.first)), Data([1, 2, 3]))
        XCTAssertFalse(requests.requests.contains { $0.url?.path.contains("busy-second") == true })
    }
    /// A refusal produced by PARSING the link describes text that no longer
    /// exists once the user edits it. Leaving it on screen puts stale guidance
    /// beside corrected input, telling the user they are still wrong.
    @MainActor
    func testEditingTheLinkClearsAParseRefusalButKeepsARetryableFailure() async {
        let download = CloudDownloadModel(
            client: CloudClient(baseURL: URL(string: "https://example.invalid")!,
                                session: StubURLProtocol.session()))
        download.linkText = "not a link"
        download.resolve()
        guard case .failed = download.state else {
            return XCTFail("a malformed link was not refused")
        }

        download.linkText = "not a lin"
        XCTAssertEqual(download.state, DownloadState.idle,
                       "the parse refusal outlived the text it described")

        // A failure the user could retry is about the transfer, not the string,
        // so it keeps its recovery rather than being erased by a keystroke.
        download.linkText = "still not a link"
        download.resolve()
        guard case .failed = download.state else {
            return XCTFail("a malformed link was not refused")
        }
        XCTAssertEqual(download.recovery, DownloadRecovery.none,
                       "a parse refusal must arm no retry")
    }
}

/// Counts attempts from URLSession's own thread, where a captured `var` would be
/// a data race.
final class AttemptCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    /// The number of this attempt, starting at 1.
    func next() -> Int {
        lock.lock(); defer { lock.unlock() }
        value += 1
        return value
    }

    var count: Int {
        lock.lock(); defer { lock.unlock() }
        return value
    }

}
