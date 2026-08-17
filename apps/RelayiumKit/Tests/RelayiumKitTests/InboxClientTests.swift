import XCTest
@testable import RelayiumKit

/// The exact HTTP this device speaks, asserted request by request.
///
/// Two classes of assertion live here and they are different in kind. The first
/// is shape: method, path, headers, body keys — a client that got any of them
/// wrong would fail against the real server in a way no local test would notice.
/// The second is ABSENCE: no secret in a URL, no request at all for a claim this
/// build must not make. An absence is only assertable against a complete record
/// of what was sent, which is why `StubURLProtocol.observed` is reset per test.
final class InboxClientTests: XCTestCase {

    private let base = URL(string: "https://relayium.test")!
    private let deviceID = "device0123456789"
    private let token = "rlm_cli_secrettoken"

    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
        StubURLProtocol.router = nil
        StubURLProtocol.stub = nil
    }

    override func tearDown() {
        StubURLProtocol.router = nil
        StubURLProtocol.stub = nil
        super.tearDown()
    }

    private func client() throws -> InboxClient {
        try InboxClient(baseURL: base, deviceID: deviceID, token: token,
                        session: StubURLProtocol.session())
    }

    private func respond(_ status: Int, _ json: String) {
        StubURLProtocol.stub = .init(status: status, body: Data(json.utf8))
    }

    private func inboxJSON(autoAccept: String = "off", presence: String = "offline",
                           canReceive: Bool = false) -> String {
        """
        {"Presence":"\(presence)","LastHeartbeatAt":0,"PresenceExpiresAt":0,
         "HeartbeatIntervalSeconds":30,"ProtocolVersion":2,"Capabilities":["inbox.receive.v2"],
         "ReceiveCapability":"inbox.receive.v2","AutoAccept":"\(autoAccept)",
         "ReceiveDirReady":false,"Revoked":false,"CanReceive":\(canReceive),
         "RegisteredAt":1,"Key":null}
        """
    }

    private func keyJSON(id: String, generation: Int, publicKey: String) -> String {
        """
        {"ID":"\(id)","Algorithm":"x25519-sealedbox-v1","PublicKey":"\(publicKey)",
         "Generation":\(generation),"CreatedAt":1,"SupersededAt":0,"RevokedAt":0}
        """
    }

    private func taskJSON(state: String, savedAt: Int = 0, terminal: Bool = false,
                          delivery: Bool = false) -> String {
        let material = delivery
            ? #", "EncManifest":"AA","WrappedKey":"wk","ClaimToken":"ct""#
            : ""
        return """
        {"ID":"t1","TargetDeviceID":"\(deviceID)","StoredFileID":"file1",
         "State":"\(state)","ErrorCode":"","CiphertextBytes":42,
         "WrapAlgorithm":"x25519-sealedbox-v1","TargetKeyID":"k1",
         "TargetKeyGeneration":1,"Attempts":0,"LeaseExpiresAt":99,"ExpiresAt":999,
         "SavedAt":\(savedAt),"Terminal":\(terminal)\(material)}
        """
    }

    // MARK: - identity in the URL

    /// A device id is composed into every path, and `appendingPathComponent`
    /// percent-encodes neither `/` nor `.`. Refusing at CONSTRUCTION means a bad
    /// id costs no round trip and `URLSession` never sees it.
    func testATraversingDeviceIDIsRefusedBeforeAnyRequest() {
        XCTAssertThrowsError(try InboxClient(baseURL: base, deviceID: "../me", token: token,
                                             session: StubURLProtocol.session())) {
            XCTAssertEqual($0 as? InboxError, .invalidIdentifier)
        }
        XCTAssertEqual(StubURLProtocol.requestCount, 0)
    }

    /// Central mints task ids itself, which is exactly why this check is here: the
    /// client turns a REMOTE string into a path, and that conversion must not
    /// depend on a remote invariant staying true.
    func testATraversingTaskIDIsRefusedBeforeAnyRequest() async throws {
        let c = try client()
        do {
            _ = try await c.report(taskID: "../../me", claimToken: "t", state: .verifying,
                                   errorCode: .none, committed: false)
            XCTFail("a traversing task id reached the transport")
        } catch {
            XCTAssertEqual(error as? InboxError, .invalidIdentifier)
        }
        XCTAssertEqual(StubURLProtocol.requestCount, 0)
    }

    // MARK: - enrolment

    func testEnrolPutsTheAnnouncedShape() async throws {
        respond(200, """
        {"inbox":\(inboxJSON(autoAccept: "auto")),"protocolVersion":2,
         "receiveCapability":"inbox.receive.v2","keyAlgorithm":"x25519-sealedbox-v1"}
        """)
        let result = try await client().enrol(InboxEnrolRequest(
            platform: "darwin", appVersion: "1.2.3", autoAccept: .auto, receiveDirReady: true))

        let request = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.url?.path, "/api/devices/\(deviceID)/inbox")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(token)")
        let body = try XCTUnwrap(StubURLProtocol.bodyJSON(request))
        XCTAssertEqual(body["platform"] as? String, "darwin")
        XCTAssertEqual(body["autoAccept"] as? String, "auto")
        XCTAssertEqual(body["receiveDirReady"] as? Bool, true)
        XCTAssertEqual(body["protocolVersions"] as? [Int], [2])
        XCTAssertEqual(body["capabilities"] as? [String],
                       ["inbox.receive.v2", "inbox.autoaccept.v1", "inbox.resume.v1"])
        XCTAssertEqual(result.receiveCapability, "inbox.receive.v2")
    }

    /// The enrolment body is the request most likely to grow a field it must never
    /// have. Asserting the exact key set — rather than the keys we remembered to
    /// check — is what makes a future `privateKey` fail here.
    func testEnrolSendsExactlyTheNegotiationFieldsAndNothingElse() async throws {
        respond(200, """
        {"inbox":\(inboxJSON()),"protocolVersion":2,
         "receiveCapability":"inbox.receive.v2","keyAlgorithm":"x25519-sealedbox-v1"}
        """)
        _ = try await client().enrol(InboxEnrolRequest(platform: "darwin", appVersion: "1",
                                                       autoAccept: .off, receiveDirReady: false))
        let body = try XCTUnwrap(StubURLProtocol.bodyJSON(XCTUnwrap(StubURLProtocol.lastRequest)))
        XCTAssertEqual(Set(body.keys), ["platform", "appVersion", "protocolVersions",
                                        "capabilities", "autoAccept", "receiveDirReady"])
    }

    func testRegisterKeyOmitsPreviousKeyIDForAFirstRegistration() async throws {
        respond(200, "{\"key\":\(keyJSON(id: "k1", generation: 1, publicKey: "pub"))}")
        let key = try await client().registerKey(algorithm: InboxProtocol.keyAlgorithm,
                                                 publicKey: "pub", previousKeyID: nil)
        XCTAssertEqual(key.id, "k1")
        let body = try XCTUnwrap(StubURLProtocol.bodyJSON(XCTUnwrap(StubURLProtocol.lastRequest)))
        XCTAssertNil(body["previousKeyId"], "a first registration must not name a predecessor")
        XCTAssertEqual(body["publicKey"] as? String, "pub")
    }

    func testRegisterKeyCarriesThePredecessorOnARotation() async throws {
        respond(200, "{\"key\":\(keyJSON(id: "k2", generation: 2, publicKey: "pub2"))}")
        _ = try await client().registerKey(algorithm: InboxProtocol.keyAlgorithm,
                                           publicKey: "pub2", previousKeyID: "k1")
        let body = try XCTUnwrap(StubURLProtocol.bodyJSON(XCTUnwrap(StubURLProtocol.lastRequest)))
        XCTAssertEqual(body["previousKeyId"] as? String, "k1")
    }

    // MARK: - presence and queue

    func testHeartbeatCarriesTheFreshlyProbedDirectoryVerdict() async throws {
        respond(200, #"{"presence":"online","presenceExpiresAt":99,"heartbeatIntervalSeconds":30}"#)
        let result = try await client().heartbeat(receiveDirReady: false)
        XCTAssertEqual(result.presence, .online)
        XCTAssertEqual(result.heartbeatIntervalSeconds, 30)
        let request = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertEqual(request.url?.path, "/api/devices/\(deviceID)/inbox/heartbeat")
        XCTAssertEqual(try XCTUnwrap(StubURLProtocol.bodyJSON(request))["receiveDirReady"] as? Bool,
                       false)
    }

    func testPendingIsAGetWithALimitAndLeasesNothing() async throws {
        respond(200, "{\"tasks\":[\(taskJSON(state: "queued"))]}")
        let tasks = try await client().pending(limit: 1)
        XCTAssertEqual(tasks.map(\.id), ["t1"])
        let request = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/devices/\(deviceID)/inbox/pending")
        XCTAssertEqual(request.url?.query, "limit=1")
    }

    func testClaimPostsAMaximumAndReadsTheLease() async throws {
        respond(200, "{\"tasks\":[\(taskJSON(state: "downloading", delivery: true))],\"leaseSeconds\":300}")
        let claimed = try await client().claim(max: 1)
        XCTAssertEqual(claimed.leaseSeconds, 300)
        XCTAssertEqual(claimed.deliveries.first?.claimToken, "ct")
        let request = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertEqual(request.url?.path, "/api/devices/\(deviceID)/inbox/claim")
        XCTAssertEqual(try XCTUnwrap(StubURLProtocol.bodyJSON(request))["max"] as? Int, 1)
    }

    // MARK: - the ciphertext read

    /// The claim token travels in a HEADER, never in a URL. A query parameter
    /// would reach a proxy log, a browser history and an access log — three places
    /// a bearer for advancing a delivery has no business being.
    func testTheBlobReadCarriesBothCredentialsAndPutsNeitherInTheURL() async throws {
        StubURLProtocol.stub = .init(status: 200, body: Data([1, 2, 3]))
        _ = try await client().blob(taskID: "task1", claimToken: "claim-secret", offset: 0)
        let request = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertEqual(request.url?.path, "/api/devices/\(deviceID)/inbox/tasks/task1/blob")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(token)")
        XCTAssertEqual(request.value(forHTTPHeaderField: InboxProtocol.claimTokenHeader),
                       "claim-secret")
        let url = try XCTUnwrap(request.url?.absoluteString)
        XCTAssertFalse(url.contains("claim-secret"))
        XCTAssertFalse(url.contains(token))
    }

    func testAResumeSendsARangeAndReportsAPartialAnswer() async throws {
        StubURLProtocol.router = { _ in .init(status: 206, body: Data([9])) }
        let stream = try await client().blob(taskID: "task1", claimToken: "ct", offset: 4096)
        XCTAssertTrue(stream.isPartial)
        XCTAssertEqual(try XCTUnwrap(StubURLProtocol.lastRequest)
            .value(forHTTPHeaderField: "Range"), "bytes=4096-")
    }

    /// A resume answered with a full `200` is not a tail. The client reports it
    /// truthfully and the receiver restarts; splicing a fresh start into the middle
    /// of a stream would produce authenticated-looking garbage.
    func testAResumeAnsweredWithAFullBodyIsNotReportedAsPartial() async throws {
        StubURLProtocol.router = { _ in .init(status: 200, body: Data([9])) }
        let stream = try await client().blob(taskID: "task1", claimToken: "ct", offset: 4096)
        XCTAssertFalse(stream.isPartial)
    }

    func testARejectedBlobCarriesTheMachineReadableToken() async throws {
        StubURLProtocol.router = { _ in
            .init(status: 409, body: Data(#"{"error":"stale_claim"}"#.utf8))
        }
        do {
            _ = try await client().blob(taskID: "task1", claimToken: "ct", offset: 0)
            XCTFail("a 409 was treated as a stream")
        } catch {
            XCTAssertEqual((error as? InboxError)?.rejection, .staleClaim)
        }
    }

    // MARK: - reporting

    func testReportSendsTheClaimTokenStateAndCommitAssertion() async throws {
        respond(200, "{\"task\":\(taskJSON(state: "saved", savedAt: 5, terminal: true))}")
        _ = try await client().report(taskID: "t1", claimToken: "ct", state: .saved,
                                      errorCode: .none, committed: true)
        let request = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertEqual(request.url?.path, "/api/devices/\(deviceID)/inbox/tasks/t1/report")
        let body = try XCTUnwrap(StubURLProtocol.bodyJSON(request))
        XCTAssertEqual(body["claimToken"] as? String, "ct")
        XCTAssertEqual(body["state"] as? String, "saved")
        XCTAssertEqual(body["committed"] as? Bool, true)
        XCTAssertEqual(body["errorCode"] as? String, "")
    }

    /// Refused BEFORE a request exists. Central refuses it too, but a bug in this
    /// client should not even be able to attempt the claim.
    func testSavedWithoutTheCommitAssertionNeverReachesTheWire() async throws {
        StubURLProtocol.reset()
        do {
            _ = try await client().report(taskID: "t1", claimToken: "ct", state: .saved,
                                          errorCode: .none, committed: false)
            XCTFail("an unasserted saved reached the transport")
        } catch {
            XCTAssertEqual(error as? InboxError, .savedNotAsserted)
        }
        XCTAssertEqual(StubURLProtocol.requestCount, 0)
    }

    /// `expired` and `revoked` are central's judgements; `queued`/`notified` are
    /// its scheduling. A device that could report any of them could forge central's
    /// own account of events or reset its own backoff.
    func testAStateCentralDoesNotAcceptFromADeviceNeverReachesTheWire() async throws {
        for state in InboxTaskState.allCases where !state.isDeviceReportable {
            StubURLProtocol.reset()
            do {
                _ = try await client().report(taskID: "t1", claimToken: "ct", state: state,
                                              errorCode: .none, committed: false)
                XCTFail("\(state.rawValue) reached the transport")
            } catch {
                XCTAssertEqual(error as? InboxError, .stateNotDeviceReportable(state))
            }
            XCTAssertEqual(StubURLProtocol.requestCount, 0, "\(state.rawValue)")
        }
    }

    func testAcceptResolvesAnAttentionRequiredTask() async throws {
        respond(200, "{\"task\":\(taskJSON(state: "queued"))}")
        _ = try await client().accept(taskID: "t1", accept: true)
        let request = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertEqual(request.url?.path, "/api/devices/\(deviceID)/inbox/tasks/t1/accept")
        XCTAssertEqual(try XCTUnwrap(StubURLProtocol.bodyJSON(request))["accept"] as? Bool, true)
    }

    // MARK: - rejections

    func testARejectionCarriesStatusAndTokenAndNoServerText() async throws {
        respond(409, #"{"error":"device_inbox_revoked","detail":"a long explanation"}"#)
        do {
            _ = try await client().heartbeat(receiveDirReady: true)
            XCTFail("a 409 was accepted")
        } catch {
            guard case let .api(status, code)? = error as? InboxError else {
                return XCTFail("wrong error: \(error)")
            }
            XCTAssertEqual(status, 409)
            XCTAssertEqual(code, "device_inbox_revoked")
            XCTAssertEqual((error as? InboxError)?.rejection, .deviceInboxRevoked)
        }
    }

    /// An unrecognised token stays an opaque string rather than becoming one of
    /// the tokens this build branches on.
    func testAnUnrecognisedRejectionTokenIsNotMappedOntoAKnownOne() async throws {
        respond(409, #"{"error":"some_future_refusal"}"#)
        do {
            _ = try await client().heartbeat(receiveDirReady: true)
            XCTFail("a 409 was accepted")
        } catch {
            XCTAssertNil((error as? InboxError)?.rejection)
            XCTAssertEqual((error as? InboxError)?.status, 409)
        }
    }

    /// A non-JSON body yields no token at all rather than a fragment of server
    /// text, and the bounded read is what stops an unbounded body reaching a log.
    func testANonJSONRejectionYieldsNoTokenAndIsBounded() {
        XCTAssertEqual(InboxClient.errorToken(in: Data("not json at all".utf8)), "")
        let huge = Data(repeating: 0x41, count: InboxClient.maxErrorBody * 4)
        XCTAssertEqual(InboxClient.errorToken(in: huge), "")
    }

    func testATransportFailureCarriesNothingFromTheURL() async throws {
        StubURLProtocol.router = { _ in
            .init(status: 200, body: Data(), failure: URLError(.cannotConnectToHost))
        }
        do {
            _ = try await client().pending(limit: 1)
            XCTFail("a transport failure was accepted")
        } catch {
            XCTAssertEqual(error as? InboxError, .network)
        }
    }

    // MARK: - device discovery

    func testCurrentDeviceReturnsTheRowThisBearerAuthenticatesAs() async throws {
        respond(200, """
        {"devices":[{"ID":"other","Name":"Other","Kind":"mac","Current":false,"Inbox":null},
                    {"ID":"\(deviceID)","Name":"This Mac","Kind":"mac","Current":true,
                     "Inbox":\(inboxJSON(autoAccept: "auto", presence: "online", canReceive: true))}]}
        """)
        let row = try await client().currentDevice()
        XCTAssertEqual(row.id, deviceID)
        XCTAssertEqual(row.inbox?.autoAccept, .auto)
    }

    func testNoCurrentRowIsACredentialProblemNotATransientOne() async throws {
        respond(200, #"{"devices":[{"ID":"other","Name":"Other","Kind":"mac","Current":false,"Inbox":null}]}"#)
        do {
            _ = try await client().currentDevice()
            XCTFail("a list with no current row was accepted")
        } catch {
            XCTAssertEqual(error as? InboxError, .noCurrentDevice)
        }
    }
}
