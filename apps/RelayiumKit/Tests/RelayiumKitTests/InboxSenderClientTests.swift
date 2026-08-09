import XCTest
@testable import RelayiumKit

/// The sender half of the Device Inbox API, asserted against the REQUEST that
/// leaves rather than against the client's own model of it.
///
/// Every test here reads `StubURLProtocol.observed` — the requests that actually
/// reached the transport — because the assertion that matters most is an
/// ABSENCE: no content key, no file name, no destination path, no private key.
/// An absence hides in the request the test forgot to look at, never in the one
/// it inspected.
final class InboxSenderClientTests: XCTestCase {

    private let base = URL(string: "https://relayium.test")!
    private let device = "DEVICE0123456789"
    private let task = "TASK0123456789ab"

    private func client() -> InboxSenderClient {
        InboxSenderClient(baseURL: base, token: "bearer-token-value",
                          session: StubURLProtocol.session())
    }

    private func sendRequest(idempotencyKey: String = "k",
                             storedFileID: String = "STORED0123456789",
                             wrappedKey: String? = nil,
                             targetKeyID: String = "KEY0123456789ab",
                             targetKeyGeneration: Int64 = 3) throws -> InboxSendRequest {
        let box = try wrappedKey ?? InboxKeyMaterial.sealContentKey(
            algorithm: InboxProtocol.keyAlgorithm,
            targetPublicKey: InboxKeyMaterial.encode(
                try InboxKeyMaterial.generateKeyPair().publicKey),
            contentKey: generateStoreKey())
        return try InboxSendRequest(idempotencyKey: idempotencyKey, storedFileID: storedFileID,
                                    wrappedKey: box, targetKeyID: targetKeyID,
                                    targetKeyGeneration: targetKeyGeneration)
    }

    /// A task body in the server's own capitalization, so the strict decoder is
    /// exercised on the shape central actually sends.
    private func taskBody(state: String = "queued", errorCode: String = "",
                          terminal: Bool = false) -> [String: Any] {
        [
            "ID": task, "TargetDeviceID": device, "SourceDeviceID": "",
            "IdempotencyKey": "k", "StoredFileID": "STORED0123456789",
            "State": state, "ErrorCode": errorCode, "CiphertextBytes": 4096,
            "WrapAlgorithm": InboxProtocol.keyAlgorithm,
            "TargetKeyID": "KEY0123456789ab", "TargetKeyGeneration": 3,
            "Attempts": 0, "NextAttemptAt": 0, "LeaseExpiresAt": 0,
            "CreatedAt": 100, "UpdatedAt": 100, "ExpiresAt": 86500,
            "NotifiedAt": 0, "SavedAt": 0, "TerminalAt": 0, "Terminal": terminal,
        ]
    }

    private func json(_ object: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: object)
    }

    override func tearDown() {
        StubURLProtocol.stub = nil
        StubURLProtocol.router = nil
        super.tearDown()
    }

    // MARK: - URLs, method and credential

    func testTheDeviceListIsReadFromTheAccountRoute() async throws {
        StubURLProtocol.reset()
        StubURLProtocol.stub = .init(status: 200, body: json([
            "devices": [["ID": device, "Name": "Mac", "Kind": "mac", "Current": false]],
        ]))
        let devices = try await client().devices()
        XCTAssertEqual(devices.map(\.id), [device])
        let request = try XCTUnwrap(StubURLProtocol.observed.last)
        XCTAssertEqual(request.url?.absoluteString, "https://relayium.test/api/devices")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"),
                       "Bearer bearer-token-value")
    }

    func testEachTaskRouteIsTheExactAccountScopedURLAndMethod() async throws {
        let cases: [(String, String, () async throws -> Void)] = [
            ("POST", "https://relayium.test/api/devices/\(device)/inbox/tasks", {
                _ = try await self.client().createTask(targetDeviceID: self.device,
                                                       try self.sendRequest())
            }),
            ("GET", "https://relayium.test/api/devices/\(device)/inbox/tasks/\(task)", {
                _ = try await self.client().task(targetDeviceID: self.device, taskID: self.task)
            }),
            ("GET", "https://relayium.test/api/devices/\(device)/inbox/tasks?limit=25", {
                _ = try await self.client().tasks(targetDeviceID: self.device, limit: 25)
            }),
            ("DELETE", "https://relayium.test/api/devices/\(device)/inbox/tasks/\(task)", {
                try await self.client().cancelTask(targetDeviceID: self.device, taskID: self.task)
            }),
        ]
        for (method, url, call) in cases {
            StubURLProtocol.reset()
            StubURLProtocol.stub = .init(status: method == "POST" ? 201 : 200, body: json([
                "task": taskBody(), "created": true, "tasks": [taskBody()], "status": "ok",
            ]))
            try await call()
            let request = try XCTUnwrap(StubURLProtocol.observed.last)
            XCTAssertEqual(request.httpMethod, method)
            XCTAssertEqual(request.url?.absoluteString, url)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"),
                           "Bearer bearer-token-value")
        }
    }

    /// An unbounded list is a different request from a bounded one, and central
    /// treats `limit=0` as "no limit". Not sending the parameter at all is the
    /// honest way to ask for the default.
    func testAnUnboundedListSendsNoLimitParameter() async throws {
        StubURLProtocol.reset()
        StubURLProtocol.stub = .init(status: 200, body: json(["tasks": [taskBody()]]))
        _ = try await client().tasks(targetDeviceID: device, limit: 0)
        XCTAssertEqual(StubURLProtocol.observed.last?.url?.absoluteString,
                       "https://relayium.test/api/devices/\(device)/inbox/tasks")
    }

    // MARK: - the create body

    /// THE privacy assertion. Six keys, named exactly, and nothing else.
    func testTheCreateBodyHasExactlySixKeysAndNoPlaintext() async throws {
        StubURLProtocol.reset()
        StubURLProtocol.stub = .init(status: 201, body: json(["task": taskBody(),
                                                              "created": true]))
        let request = try sendRequest()
        _ = try await client().createTask(targetDeviceID: device, request)

        let sent = try XCTUnwrap(StubURLProtocol.bodyJSON(
            try XCTUnwrap(StubURLProtocol.observed.last)))
        XCTAssertEqual(Set(sent.keys), [
            "idempotencyKey", "storedFileId", "wrapAlgorithm", "wrappedKey",
            "targetKeyId", "targetKeyGeneration",
        ])
        XCTAssertEqual(sent["idempotencyKey"] as? String, request.idempotencyKey)
        XCTAssertEqual(sent["storedFileId"] as? String, request.storedFileID)
        XCTAssertEqual(sent["wrapAlgorithm"] as? String, InboxProtocol.keyAlgorithm)
        XCTAssertEqual(sent["wrappedKey"] as? String, request.wrappedKey)
        XCTAssertEqual(sent["targetKeyId"] as? String, request.targetKeyID)
        XCTAssertEqual(sent["targetKeyGeneration"] as? Int64, 3)
    }

    /// The same absence, stated as the names a careless future field would take.
    /// Checked across EVERY request this client makes, not only the create.
    func testNoRequestCarriesAContentKeyFileNameOrPath() async throws {
        StubURLProtocol.reset()
        StubURLProtocol.stub = .init(status: 201, body: json(["task": taskBody(),
                                                              "created": true,
                                                              "tasks": [taskBody()],
                                                              "devices": []]))
        let sender = client()
        _ = try? await sender.devices()
        _ = try? await sender.tasks(targetDeviceID: device, limit: 5)
        // The create is LAST on purpose: `StubURLProtocol` keeps one captured
        // body, so the request whose body is inspected below has to be the one
        // that ran most recently.
        _ = try? await sender.createTask(targetDeviceID: device, try sendRequest())

        let forbidden = ["contentKey", "content_key", "key", "privateKey", "secretKey",
                         "fileName", "filename", "name", "path", "destinationPath",
                         "manifest", "plaintext"]
        for request in StubURLProtocol.observed {
            let url = request.url?.absoluteString ?? ""
            for field in forbidden {
                XCTAssertFalse(url.contains(field), "\(field) appeared in the URL \(url)")
            }
        }
        // The one request with a body is the create; its keys are pinned above,
        // and this restates the rule in the terms a regression would take.
        let body = try XCTUnwrap(StubURLProtocol.bodyJSON(
            try XCTUnwrap(StubURLProtocol.observed.last(where: { $0.httpMethod == "POST" }))))
        for field in forbidden where field != "key" {
            XCTAssertNil(body[field], "\(field) reached the create body")
        }
    }

    /// A retried create converges: central answers `200`, and the client reports
    /// `created == false` so a sender does not announce a second delivery.
    func testAConvergedRetryIsReportedAsNotCreated() async throws {
        StubURLProtocol.reset()
        StubURLProtocol.stub = .init(status: 200, body: json(["task": taskBody(),
                                                              "created": false]))
        let result = try await client().createTask(targetDeviceID: device, try sendRequest())
        XCTAssertFalse(result.created)
        XCTAssertEqual(result.task.id, task)
    }

    /// A body whose `created` flag contradicts the status is refused rather than
    /// believed. Either answer alone could be a proxy or a stale build; a sender
    /// that trusted the flag over the status would report a delivery twice.
    func testAStatusAndFlagThatDisagreeAreRefused() async throws {
        for (status, created) in [(201, false), (200, true), (202, false)] {
            StubURLProtocol.reset()
            StubURLProtocol.stub = .init(status: status, body: json(["task": taskBody(),
                                                                     "created": created]))
            await XCTAssertThrowsErrorAsync(
                try await self.client().createTask(targetDeviceID: self.device,
                                                   try self.sendRequest())) {
                XCTAssertEqual($0 as? InboxError, .malformedResponse)
            }
        }
    }

    /// A successful-looking response must describe the exact create request.
    /// Otherwise an ambiguous retry could attach the durable plan to another
    /// task and falsely report that this delivery converged.
    func testACreateResponseForDifferentMaterialIsRefused() async throws {
        let mismatches: [(String, Any)] = [
            ("TargetDeviceID", "OTHERDEVICE0123"),
            ("IdempotencyKey", "other-key"),
            ("StoredFileID", "OTHERSTORED0123"),
            ("WrapAlgorithm", "x25519-sealedbox-v2"),
            ("TargetKeyID", "OTHERKEY0123456"),
            ("TargetKeyGeneration", 4),
        ]
        for (field, value) in mismatches {
            var task = taskBody()
            task[field] = value
            StubURLProtocol.reset()
            StubURLProtocol.stub = .init(status: 201, body: json([
                "task": task, "created": true,
            ]))
            await XCTAssertThrowsErrorAsync(
                try await self.client().createTask(targetDeviceID: self.device,
                                                   try self.sendRequest())) {
                XCTAssertEqual($0 as? InboxError, .malformedResponse)
            }
        }
    }

    // MARK: - refusals before a request exists

    func testAnInvalidIdempotencyKeyIsRefusedWithoutBuildingARequest() throws {
        let tooLong = String(repeating: "a", count: InboxIdempotencyKey.maxLength + 1)
        // Space and DEL are outside the server's printable-ASCII rule; a
        // multi-byte scalar is one Character but three BYTES against its bound.
        for key in ["", " ", "has space", "tab\tted", "new\nline", tooLong,
                    "\u{7f}", "ключ", "emoji😀"] {
            XCTAssertThrowsError(try InboxSendRequest(
                idempotencyKey: key, storedFileID: "STORED0123456789",
                wrappedKey: try validBox(), targetKeyID: "KEY0123456789ab",
                targetKeyGeneration: 1),
                "the idempotency key \(key.debugDescription) was accepted") {
                XCTAssertEqual($0 as? InboxError, .invalidIdempotencyKey)
            }
        }
        // Exactly at the bound is accepted: the rule is a bound, not a margin.
        XCTAssertNoThrow(try InboxSendRequest(
            idempotencyKey: String(repeating: "a", count: InboxIdempotencyKey.maxLength),
            storedFileID: "STORED0123456789", wrappedKey: try validBox(),
            targetKeyID: "KEY0123456789ab", targetKeyGeneration: 1))
    }

    func testAMintedIdempotencyKeyIsAcceptedByItsOwnRule() {
        for _ in 0..<32 {
            let key = InboxIdempotencyKey.mint()
            XCTAssertTrue(InboxIdempotencyKey.isValid(key), "minted an unusable key: \(key)")
            XCTAssertNotEqual(key, InboxIdempotencyKey.mint())
        }
    }

    func testAnIdentifierThatCouldSteerAURLIsRefused() throws {
        for bad in ["../me", "a/b", "a.b", "", "a?b", "a#b", "a b",
                    String(repeating: "x", count: 129)] {
            XCTAssertThrowsError(try InboxSendRequest(
                idempotencyKey: "k", storedFileID: bad, wrappedKey: try validBox(),
                targetKeyID: "KEY0123456789ab", targetKeyGeneration: 1)) {
                XCTAssertEqual($0 as? InboxError, .invalidIdentifier)
            }
            XCTAssertThrowsError(try InboxSendRequest(
                idempotencyKey: "k", storedFileID: "STORED0123456789",
                wrappedKey: try validBox(), targetKeyID: bad, targetKeyGeneration: 1)) {
                XCTAssertEqual($0 as? InboxError, .invalidIdentifier)
            }
        }
    }

    /// A target device id is chosen per call here, not fixed at construction, so
    /// it is checked on the way into every path — and nothing is sent when it is
    /// refused.
    func testAnInvalidTargetDeviceIdNeverReachesTheTransport() async throws {
        for bad in ["../other", "a/b", ""] {
            StubURLProtocol.reset()
            StubURLProtocol.stub = .init(status: 200, body: Data())
            await XCTAssertThrowsErrorAsync(
                try await self.client().createTask(targetDeviceID: bad, try self.sendRequest())) {
                XCTAssertEqual($0 as? InboxError, .invalidIdentifier)
            }
            await XCTAssertThrowsErrorAsync(
                try await self.client().cancelTask(targetDeviceID: bad, taskID: self.task)) {
                XCTAssertEqual($0 as? InboxError, .invalidIdentifier)
            }
            XCTAssertEqual(StubURLProtocol.requestCount, 0,
                           "a refused device id still produced a request")
        }
    }

    func testAnInvalidTaskIdNeverReachesTheTransport() async throws {
        StubURLProtocol.reset()
        StubURLProtocol.stub = .init(status: 200, body: Data())
        await XCTAssertThrowsErrorAsync(
            try await self.client().task(targetDeviceID: self.device, taskID: "../secrets")) {
            XCTAssertEqual($0 as? InboxError, .invalidIdentifier)
        }
        XCTAssertEqual(StubURLProtocol.requestCount, 0)
    }

    func testAMalformedWrappedKeyIsRefused() throws {
        let real = try validBox()
        let raw = try InboxKeyMaterial.decode(real, expecting: InboxProtocol.sealedBoxBytes)
        for bad in [real + "=", String(real.dropLast()), real + "A", "",
                    InboxKeyMaterial.encode(Array(raw.dropLast())),
                    InboxKeyMaterial.encode(raw + [0]),
                    real.replacingOccurrences(of: "-", with: "+")] where bad != real {
            XCTAssertThrowsError(try InboxSendRequest(
                idempotencyKey: "k", storedFileID: "STORED0123456789",
                wrappedKey: bad, targetKeyID: "KEY0123456789ab", targetKeyGeneration: 1),
                "the wrapped key \(bad.debugDescription) was accepted") {
                XCTAssertEqual($0 as? InboxError, .invalidWrappedKey)
            }
        }
    }

    func testAnUnknownWrapAlgorithmIsRefused() throws {
        XCTAssertThrowsError(try InboxSendRequest(
            idempotencyKey: "k", storedFileID: "STORED0123456789",
            wrapAlgorithm: "x25519-sealedbox-v2", wrappedKey: try validBox(),
            targetKeyID: "KEY0123456789ab", targetKeyGeneration: 1)) {
            XCTAssertEqual($0 as? InboxError, .unsupportedWrapAlgorithm)
        }
    }

    func testANonPositiveKeyGenerationIsRefused() throws {
        for generation in Int64(-1)...0 {
            XCTAssertThrowsError(try InboxSendRequest(
                idempotencyKey: "k", storedFileID: "STORED0123456789",
                wrappedKey: try validBox(), targetKeyID: "KEY0123456789ab",
                targetKeyGeneration: generation)) {
                XCTAssertEqual($0 as? InboxError, .invalidKeyGeneration)
            }
        }
    }

    // MARK: - reading responses

    /// Fail closed: a state this build does not know is a server behaviour it
    /// cannot honour, and reporting it as anything at all would be a guess.
    func testAnUnknownTaskStateIsRefused() async throws {
        StubURLProtocol.reset()
        StubURLProtocol.stub = .init(status: 200,
                                     body: json(["task": taskBody(state: "teleporting")]))
        await XCTAssertThrowsErrorAsync(
            try await self.client().task(targetDeviceID: self.device, taskID: self.task)) {
            XCTAssertEqual($0 as? InboxError, .unknownProtocolValue(field: .taskState))
        }
    }

    func testAnUnknownErrorCodeIsRefused() async throws {
        StubURLProtocol.reset()
        StubURLProtocol.stub = .init(status: 200,
                                     body: json(["task": taskBody(errorCode: "gremlins")]))
        await XCTAssertThrowsErrorAsync(
            try await self.client().task(targetDeviceID: self.device, taskID: self.task)) {
            XCTAssertEqual($0 as? InboxError, .unknownProtocolValue(field: .errorCode))
        }
    }

    /// A central-authored code on a task the SENDER reads is legitimate — the
    /// union is what the read model is for.
    func testACentralAuthoredErrorCodeIsAccepted() async throws {
        StubURLProtocol.reset()
        StubURLProtocol.stub = .init(status: 200, body: json([
            "task": taskBody(state: "failed_terminal", errorCode: "attempts_exhausted",
                             terminal: true),
        ]))
        let read = try await client().task(targetDeviceID: device, taskID: task)
        XCTAssertEqual(read.errorCode, .central(.attemptsExhausted))
        XCTAssertTrue(read.isTerminal)
    }

    /// A rejection contributes its status and the machine-readable token, from a
    /// BOUNDED prefix. Nothing else of the body travels.
    func testARejectionCarriesOnlyItsStatusAndToken() async throws {
        StubURLProtocol.reset()
        StubURLProtocol.stub = .init(status: 409, body: json([
            "error": "stored_object_already_bound",
            "detail": "/Users/someone/Documents/tax-return.pdf",
        ]))
        await XCTAssertThrowsErrorAsync(
            try await self.client().createTask(targetDeviceID: self.device,
                                               try self.sendRequest())) {
            XCTAssertEqual($0 as? InboxError,
                           .api(status: 409, code: "stored_object_already_bound"))
        }
    }

    /// An oversized rejection body is not parsed past the bound, and never
    /// echoed. The token is simply absent, and the status alone is reported.
    func testAnOversizedRejectionBodyYieldsNoToken() async throws {
        StubURLProtocol.reset()
        var padded: [String: Any] = ["error": "invalid_idempotency_key"]
        padded["pad"] = String(repeating: "x", count: InboxClient.maxErrorBody * 2)
        StubURLProtocol.stub = .init(status: 400, body: json(padded))
        await XCTAssertThrowsErrorAsync(
            try await self.client().createTask(targetDeviceID: self.device,
                                               try self.sendRequest())) {
            XCTAssertEqual($0 as? InboxError, .api(status: 400, code: ""))
        }
    }

    func testABodyOfTheWrongShapeIsRefused() async throws {
        StubURLProtocol.reset()
        StubURLProtocol.stub = .init(status: 200, body: Data("not json".utf8))
        await XCTAssertThrowsErrorAsync(
            try await self.client().tasks(targetDeviceID: self.device, limit: 0)) {
            XCTAssertEqual($0 as? InboxError, .malformedResponse)
        }
    }

    // MARK: - helpers

    private func validBox() throws -> String {
        try InboxKeyMaterial.sealContentKey(
            algorithm: InboxProtocol.keyAlgorithm,
            targetPublicKey: InboxKeyMaterial.encode(
                try InboxKeyMaterial.generateKeyPair().publicKey),
            contentKey: generateStoreKey())
    }
}
