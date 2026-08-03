import XCTest
@testable import RelayiumKit

/// The device and stored-file half of `AccountClient`: the requests the Account
/// tab makes, and how their responses and failures map.
final class AccountManagementClientTests: XCTestCase {
    private func client() -> AccountClient {
        AccountClient(baseURL: URL(string: "https://relayium.test")!, session: StubURLProtocol.session())
    }
    override func tearDown() { StubURLProtocol.stub = nil; StubURLProtocol.lastRequest = nil }

    // MARK: - devices

    func testListDevicesSendsBearerToTheDevicesPath() async throws {
        StubURLProtocol.stub = .init(status: 200, body: Data(#"{"devices":[]}"#.utf8), check: { req in
            XCTAssertEqual(req.url?.path, "/api/devices")
            XCTAssertEqual(req.httpMethod, "GET")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer rlm_cli_T")
        })
        let devices = try await client().listDevices(token: "rlm_cli_T")
        XCTAssertEqual(devices, [])
    }

    /// The server emits Go's default capitalization here — the shape the web has
    /// always read. Decoding is pinned to that literal, not to a hand-written
    /// lowerCamel guess.
    func testListDevicesDecodesTheServersCapitalizedShape() async throws {
        let body = """
        {"devices":[
          {"ID":"d1","UserID":"u1","Name":"Ada's Mac","CreatedAt":1000,"LastSeenAt":2000,"Kind":"app","Current":true},
          {"ID":"d2","UserID":"u1","Name":"build-box","CreatedAt":900,"LastSeenAt":0,"Kind":"cli","Current":false}
        ]}
        """
        StubURLProtocol.stub = .init(status: 200, body: Data(body.utf8), check: nil)
        let devices = try await client().listDevices(token: "t")
        XCTAssertEqual(devices.count, 2)
        XCTAssertEqual(devices[0], AccountDevice(id: "d1", name: "Ada's Mac", createdAt: 1000,
                                                 lastSeenAt: 2000, kind: "app", current: true))
        XCTAssertEqual(devices[1].kind, "cli")
        XCTAssertFalse(devices[1].current)
        XCTAssertEqual(devices[1].lastSeenAt, 0)
    }

    /// A server that predates the `Current` marker must not make the whole tab
    /// fail to load — the list is still true, nothing is just marked as this one.
    func testListDevicesToleratesAMissingCurrentMarker() async throws {
        let body = #"{"devices":[{"ID":"d1","UserID":"u1","Name":"Mac","CreatedAt":1,"LastSeenAt":2,"Kind":"app"}]}"#
        StubURLProtocol.stub = .init(status: 200, body: Data(body.utf8), check: nil)
        let devices = try await client().listDevices(token: "t")
        XCTAssertEqual(devices.count, 1)
        XCTAssertFalse(devices[0].current)
    }

    func testListDevicesMapsUnauthorized() async {
        StubURLProtocol.stub = .init(status: 401, body: Data("unauthorized".utf8), check: nil)
        await XCTAssertThrowsErrorAsync(try await self.client().listDevices(token: "bad")) {
            XCTAssertEqual($0 as? AccountError, .invalidCredentials)
        }
    }

    func testListDevicesMapsRateLimited() async {
        StubURLProtocol.stub = .init(status: 429, body: Data(), check: nil)
        await XCTAssertThrowsErrorAsync(try await self.client().listDevices(token: "t")) {
            XCTAssertEqual($0 as? AccountError, .rateLimited)
        }
    }

    func testListDevicesMapsServerError() async {
        StubURLProtocol.stub = .init(status: 503, body: Data(), check: nil)
        await XCTAssertThrowsErrorAsync(try await self.client().listDevices(token: "t")) {
            XCTAssertEqual($0 as? AccountError, .server(status: 503))
        }
    }

    func testListDevicesMapsAnUndecodableBody() async {
        StubURLProtocol.stub = .init(status: 200, body: Data("not json".utf8), check: nil)
        await XCTAssertThrowsErrorAsync(try await self.client().listDevices(token: "t")) {
            XCTAssertEqual($0 as? AccountError, .decoding)
        }
    }

    func testDeleteDeviceSendsBearerToTheDeviceId() async throws {
        StubURLProtocol.stub = .init(status: 200, body: Data(#"{"status":"ok"}"#.utf8), check: { req in
            XCTAssertEqual(req.url?.path, "/api/devices/d1")
            XCTAssertEqual(req.httpMethod, "DELETE")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer rlm_cli_T")
        })
        try await client().deleteDevice(id: "d1", token: "rlm_cli_T")
    }

    func testDeleteDeviceMapsAServerFailure() async {
        StubURLProtocol.stub = .init(status: 500, body: Data(), check: nil)
        await XCTAssertThrowsErrorAsync(try await self.client().deleteDevice(id: "d1", token: "t")) {
            XCTAssertEqual($0 as? AccountError, .server(status: 500))
        }
    }

    // MARK: - stored files

    func testListStoredFilesSendsBearerToTheFilesPath() async throws {
        StubURLProtocol.stub = .init(status: 200, body: Data(#"{"files":[]}"#.utf8), check: { req in
            XCTAssertEqual(req.url?.path, "/api/files")
            XCTAssertEqual(req.httpMethod, "GET")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer rlm_cli_T")
        })
        let files = try await client().listStoredFiles(token: "rlm_cli_T")
        XCTAssertEqual(files, [])
    }

    /// Only what the server actually knows: an opaque id, the ciphertext length,
    /// and the lifecycle. No name — it never had one.
    func testListStoredFilesDecodesServerKnownMetadataOnly() async throws {
        let body = """
        {"files":[
          {"id":"f1","size":1024,"createdAt":1000,"expiresAt":2000,"burnAfterRead":true,"downloaded":false,"downloadCount":0},
          {"id":"f2","size":5,"createdAt":10,"expiresAt":20,"burnAfterRead":false,"downloaded":true,"downloadCount":3}
        ]}
        """
        StubURLProtocol.stub = .init(status: 200, body: Data(body.utf8), check: nil)
        let files = try await client().listStoredFiles(token: "t")
        XCTAssertEqual(files, [
            StoredFileSummary(id: "f1", size: 1024, createdAt: 1000, expiresAt: 2000,
                              burnAfterRead: true, downloaded: false, downloadCount: 0),
            StoredFileSummary(id: "f2", size: 5, createdAt: 10, expiresAt: 20,
                              burnAfterRead: false, downloaded: true, downloadCount: 3),
        ])
    }

    func testListStoredFilesMapsUnauthorized() async {
        StubURLProtocol.stub = .init(status: 401, body: Data(), check: nil)
        await XCTAssertThrowsErrorAsync(try await self.client().listStoredFiles(token: "bad")) {
            XCTAssertEqual($0 as? AccountError, .invalidCredentials)
        }
    }

    func testDeleteStoredFileSendsBearerToTheFileId() async throws {
        StubURLProtocol.stub = .init(status: 200, body: Data(#"{"status":"ok"}"#.utf8), check: { req in
            XCTAssertEqual(req.url?.path, "/api/files/f1")
            XCTAssertEqual(req.httpMethod, "DELETE")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer rlm_cli_T")
        })
        let outcome = try await client().deleteStoredFile(id: "f1", token: "rlm_cli_T")
        XCTAssertEqual(outcome, .deleted)
    }

    /// The server 404s a stored file that is missing, expired, burned — or not
    /// the caller's. A bearer can only ever have listed its own, so from this
    /// screen a 404 means "already gone", and reporting an error for a row the
    /// user asked to remove, which IS removed, would be a lie. It is reported as
    /// distinct from a confirmed delete because a 404 is ALSO what a failed read
    /// on the server looks like, and the caller decides what to risk on that.
    func testDeleteStoredFileReportsNotFoundAsUnconfirmed() async throws {
        StubURLProtocol.stub = .init(status: 404, body: Data("not found".utf8), check: nil)
        let outcome = try await client().deleteStoredFile(id: "gone", token: "t")
        XCTAssertEqual(outcome, .alreadyGone)
    }

    func testDeleteStoredFileMapsAServerFailure() async {
        StubURLProtocol.stub = .init(status: 500, body: Data(), check: nil)
        await XCTAssertThrowsErrorAsync(try await self.client().deleteStoredFile(id: "f1", token: "t")) {
            XCTAssertEqual($0 as? AccountError, .server(status: 500))
        }
    }

    // MARK: - identifiers that must never reach a URL

    /// Ids come from the server, and they are composed into a DELETE path.
    ///
    /// `URL.appendingPathComponent` is NOT an escape hatch here: it leaves `/`
    /// and `.` alone, so an id of `../me` really does build
    /// `https://relayium.test/api/devices/../me`. Whether that lands on
    /// `/api/me` then depends on who resolves the dot segments — CFNetwork, a
    /// proxy, or the server's own router — which is not a question a destructive
    /// request should have an answer to. The client refuses the id instead.
    ///
    /// Each case asserts on the transport, not on the thrown error alone: the
    /// requirement is that nothing was SENT, and a client that threw after
    /// issuing the request would satisfy a weaker assertion.
    func testADeleteRefusesAnIdentifierThatCouldSteerThePath() async {
        let hostile = [
            "../me",                                 // the traversal itself
            "..",
            "a/b",                                   // an extra path segment
            "/api/me",                               // an absolute path
            "",                                      // no segment at all
            "a b",                                   // space
            "a?b", "a#b",                            // query/fragment delimiters
            "a%2fb",                                 // pre-encoded separator
            "ключ",                                  // non-ASCII
            "a\u{0}b",
            String(repeating: "a", count: 129),      // over-long
        ]
        for id in hostile {
            StubURLProtocol.requestCount = 0
            StubURLProtocol.lastRequest = nil
            StubURLProtocol.stub = .init(status: 200, body: Data(), check: nil)
            await XCTAssertThrowsErrorAsync(try await self.client().deleteDevice(id: id, token: "t")) {
                XCTAssertEqual($0 as? StoredLinkKeyError, .invalidIdentifier, "id \(id.debugDescription)")
            }
            XCTAssertEqual(StubURLProtocol.requestCount, 0,
                           "a request was sent for id \(id.debugDescription): \(String(describing: StubURLProtocol.lastRequest?.url))")

            StubURLProtocol.requestCount = 0
            await XCTAssertThrowsErrorAsync(try await self.client().deleteStoredFile(id: id, token: "t")) {
                XCTAssertEqual($0 as? StoredLinkKeyError, .invalidIdentifier, "id \(id.debugDescription)")
            }
            XCTAssertEqual(StubURLProtocol.requestCount, 0,
                           "a request was sent for id \(id.debugDescription)")
        }
    }

    /// The other half of the same rule: the refusal must be narrow enough that
    /// every id the server can actually issue still goes through. Device rows
    /// and stored objects are both `authx.NewID()` — 32 hex characters — and the
    /// accepted charset is deliberately wider so a future id format still works.
    func testADeleteStillAcceptsTheIdentifiersTheServerIssues() async throws {
        let real = ["0f9a1b2c3d4e5f60718293a4b5c6d7e8", "A-Za-z0-9_-",
                    String(repeating: "a", count: 128)]
        for id in real {
            StubURLProtocol.requestCount = 0
            StubURLProtocol.stub = .init(status: 200, body: Data(#"{"status":"ok"}"#.utf8), check: { req in
                XCTAssertEqual(req.url?.path, "/api/devices/\(id)")
            })
            try await client().deleteDevice(id: id, token: "t")
            XCTAssertEqual(StubURLProtocol.requestCount, 1, "id \(id) never reached the server")
        }
    }

    // MARK: - device classification

    /// Browser rows are the noise this list has to drop: they are registered
    /// automatically by the site and hold a session cookie, not a token that can
    /// be carried off a machine.
    func testOnlyCliAndAppDevicesHoldARevocableToken() {
        func device(kind: String) -> AccountDevice {
            AccountDevice(id: "d", name: "n", createdAt: 0, lastSeenAt: 0, kind: kind, current: false)
        }
        XCTAssertTrue(device(kind: "cli").holdsRevocableToken)
        XCTAssertTrue(device(kind: "app").holdsRevocableToken)
        XCTAssertFalse(device(kind: "browser").holdsRevocableToken)
        XCTAssertFalse(device(kind: "").holdsRevocableToken)
        XCTAssertFalse(device(kind: "something-new").holdsRevocableToken)
    }
}
