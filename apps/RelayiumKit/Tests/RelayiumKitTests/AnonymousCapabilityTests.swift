import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// Transport-level proof that the three capabilities this round claims work
/// without an account really do reach the network without one.
///
/// The claim is made in the UI — the shell renders unconditionally, two
/// destinations hold no account reference, and three lines of copy say "needs no
/// account" in nine languages. `MacSurfaceGuardTests` can only prove those
/// surfaces do not *name* the account. What it cannot prove is that the code
/// underneath them does not send a credential anyway, which is the assertion
/// that decides whether the copy is true.
///
/// So these tests are deliberately not about views. They drive the real models
/// and the real clients over a stubbed transport and then read **every** request
/// that reached it, asserting the absence of a credential in each of the four
/// places one could hide: an `Authorization` header, userinfo in the URL, a
/// query parameter, and — for the signaling socket — the frames sent on open.
@MainActor
final class AnonymousCapabilityTests: XCTestCase {
    private let stubBaseURL = URL(string: "https://relayium.test")!

    override func tearDown() {
        StubURLProtocol.router = nil
        StubURLProtocol.stub = nil
        StubURLProtocol.reset()
        super.tearDown()
    }

    /// Every request the stub saw, so a header cannot hide in a request the
    /// assertion forgot to look at. The count is the load-bearing half: without
    /// it this passes just as happily when nothing was sent at all, or when a
    /// fourth request slipped past carrying whatever the first three did not.
    private func assertNoCredential(_ requests: [URLRequest], count: Int,
                                    file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(requests.count, count,
                       "unaccounted requests: \(requests.compactMap(\.url?.path))",
                       file: file, line: line)
        for r in requests {
            XCTAssertNil(r.value(forHTTPHeaderField: "Authorization"),
                         "\(r.url?.path ?? "?") sent Authorization", file: file, line: line)
            XCTAssertNil(r.url?.user, file: file, line: line)
            XCTAssertNil(r.url?.password, file: file, line: line)
            XCTAssertFalse(r.url?.query?.lowercased().contains("token") ?? false,
                           "\(r.url?.path ?? "?") put a token in the query", file: file, line: line)
        }
    }

    /// `resolve` and `download` run a stubbed URLSession round trip off the main
    /// actor, so the test waits for the state rather than for the actor to drain.
    private func waitFor(_ what: String,
                         _ ready: @MainActor () -> Bool,
                         seconds: TimeInterval = 5) async {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if ready() { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for \(what)")
    }

    private func tempDir() throws -> URL {
        let d = FileManager.default.temporaryDirectory
            .appendingPathComponent("anon-cap-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    // MARK: - stored link: resolve and download

    /// Built with no session object in scope at all — there is no
    /// `AccountSession` in this test, so a credential could only appear if the
    /// download path invented one.
    ///
    /// The client is constructed exactly as `AppEnvironment.makeDownloadModel`
    /// constructs it on macOS (`CloudDownloadModel(client: CloudClient(baseURL:))`,
    /// no `errorCopy` override), with the stub session injected — that factory
    /// takes no session parameter, and adding one to production code to make a
    /// test reach it would be the wrong direction.
    func testStoredLinkResolveAndDownloadCarryNoCredential() async throws {
        StubURLProtocol.reset()
        let key = [UInt8](repeating: 7, count: 32)
        let plaintext = Array("hello".utf8)
        let files = [ManifestFile(name: "note.txt", size: plaintext.count)]
        let enc = try encryptManifest(key: key, StoredManifest(files: files))
        let metaBody = try JSONEncoder().encode(
            StoredFileMeta(encManifest: Data(enc).base64EncodedString(),
                           size: 0, burnAfterRead: false, expiresAt: 0))
        var blobBody = Data()
        let encryptor = ChunkEncryptor(key: key,
                                       sources: [DataSource(name: "note.txt", bytes: plaintext)])
        while let frame = try encryptor.next() { blobBody.append(frame) }
        StubURLProtocol.router = { req in
            req.url?.path.hasSuffix("/blob") == true
                ? .init(status: 200, body: blobBody)
                : .init(status: 200, body: metaBody)
        }

        let model = CloudDownloadModel(
            client: CloudClient(baseURL: stubBaseURL, session: StubURLProtocol.session()))
        model.linkText = "\(stubBaseURL.absoluteString)/d/abc#k=\(encodeStoreKey(key))"
        model.resolve()
        await waitFor("the link to resolve") { if case .ready = model.state { return true }; return false }
        model.download(into: try tempDir())
        await waitFor("the file to be saved") { if case .done = model.state { return true }; return false }

        XCTAssertNotNil(model.received)
        // Three, not two, and named rather than guessed: `resolve` fetches the
        // meta to decrypt the manifest, `CloudClient.download` fetches it again
        // to compute the expected plaintext total (its truncation defence), and
        // then streams the blob. The number is not the point — that no request
        // escapes the assertion is.
        assertNoCredential(StubURLProtocol.observed, count: 3)
        XCTAssertEqual(StubURLProtocol.observed.compactMap(\.url?.path),
                       ["/api/files/abc/meta", "/api/files/abc/meta", "/api/files/abc/blob"])
    }

    // MARK: - nearby: the code-less ICE fetch

    /// The same-network path asks `/api/ice` with no code, which is what makes
    /// the response STUN-only server-side — and `nearbyICEServers` drops every
    /// TURN URL and credential regardless, so the guarantee is a property of
    /// this client rather than a promise about the server.
    func testNearbyICEFetchCarriesNoCredentialAndDropsTURN() async throws {
        StubURLProtocol.reset()
        let body = Data("""
        {"iceServers":[{"urls":["stun:stun.relayium.test:3478"]},
                       {"urls":["turn:turn.relayium.test:3478"],"username":"u","credential":"c"}]}
        """.utf8)
        StubURLProtocol.router = { _ in .init(status: 200, body: body) }

        let config = try await HTTPICEClient(baseURL: stubBaseURL,
                                             session: StubURLProtocol.session()).fetch(code: "")
        assertNoCredential(StubURLProtocol.observed, count: 1)   // the ICE fetch, nothing else
        // Code-less: the empty code IS the mechanism, so there must be no query
        // at all rather than an empty one.
        XCTAssertNil(StubURLProtocol.observed.first?.url?.query)

        let nearby = RealtimeConnectionFactory.nearbyICEServers(config.iceServers)
        XCTAssertFalse(nearby.contains { server in
            server.urls.contains { $0.hasPrefix("turn:") || $0.hasPrefix("turns:") }
        }, "the nearby path must never relay")
        XCTAssertTrue(nearby.allSatisfy { $0.username == nil && $0.credential == nil },
                      "a credential carried past here is the one way nearby could use a relay")
        XCTAssertFalse(nearby.isEmpty, "STUN must survive the filter")
    }

    // MARK: - pairing code: joining somebody else's code

    func testPairingCodeJoinConsultsNoAccount() async throws {
        StubURLProtocol.reset()
        StubURLProtocol.router = { _ in
            .init(status: 200, body: Data(#"{"iceServers":[{"urls":["stun:s:3478"]}]}"#.utf8))
        }
        let channel = FakeWebSocketChannel()
        let signaling = SignalingClient(channel: channel, name: "Test Mac")
        let connection = AnonymousStubConnection()
        let model = RealtimeSessionModel(
            // Minting is the gated half. A join that reached this would be the
            // bug the whole destination split exists to prevent.
            pairClient: RefusingPairClient(),
            iceClient: HTTPICEClient(baseURL: stubBaseURL, session: StubURLProtocol.session()),
            requiresVerification: { false },
            makeConnection: { _, _, _ in
                // Standing in for `RealtimeConnectionFactory.make`, which opens
                // the signaling socket. Opening it is what sends the join frame.
                channel.fireOpen()
                return connection
            })

        await model.join(code: "123456")

        XCTAssertEqual(model.state, .connecting)
        XCTAssertTrue(channel.isOpen, "the signaling channel must open with no account")
        XCTAssertTrue(connection.started)
        // The socket itself: the hub is told a device name and a room, never a
        // credential. `selfId` is still nil because the hub has not welcomed us.
        XCTAssertNil(signaling.selfId)
        let frames = channel.sent.joined(separator: " ").lowercased()
        for secret in ["token", "bearer", "authorization", "password"] {
            XCTAssertFalse(frames.contains(secret), "the join frame carried \(secret)")
        }
        assertNoCredential(StubURLProtocol.observed, count: 1)   // the ICE fetch, nothing else
    }
}

// MARK: - stubs

/// Minting is the account-backed half of the pairing-code destination; a join
/// must never touch it.
private final class RefusingPairClient: PairCodeClient, @unchecked Sendable {
    func mint(token: String) async throws -> MintedCode {
        XCTFail("joining a code must not mint one")
        return MintedCode(code: "000000", expiresAt: 0)
    }
}

/// Stands in for the WebRTC connection, which needs a live peer.
private final class AnonymousStubConnection: RealtimePeerConnection, @unchecked Sendable {
    var onSAS: ((String) -> Void)?
    var onOpen: (() -> Void)?
    var onManifest: (([FileMeta]) -> Void)?
    var onFileChunk: (([UInt8]) -> Void)?
    var onProgress: ((Int) -> Void)?
    var onDone: ((Bool) -> Void)?
    var onText: ((String, Int) -> Void)?
    var onControl: ((RealtimeControl) -> Void)?
    var onClose: (() -> Void)?
    var onError: ((Error) -> Void)?

    private(set) var started = false

    func start() { started = true }
    func send(sources: [PlaintextSource], metas: [FileMeta]) {}
    func accept() {}
    func reject() {}
    func complete() {}
    func confirmTextSAS() {}
    func acceptText() {}
    func rejectText() {}
    func sendText(_ body: String, completion: @escaping (Error?) -> Void) { completion(nil) }
    var textBufferedAmount: UInt64 { 0 }
    func close() {}
}
