import XCTest
@testable import RelayiumKit

/// The two authenticated billing requests an in-app purchase makes, and the
/// exact vocabulary of answers they can come back with.
///
/// The error mapping is not decoration here. Everything above this layer decides
/// whether to FINISH a store transaction — an irreversible instruction to stop
/// redelivering something a user has paid for — on the strength of what this
/// client returned, so a refusal that arrived as the wrong case, or a failure
/// that arrived as a success, is a destroyed purchase.
final class AppleBillingClientTests: XCTestCase {
    private func client() -> AccountClient {
        AccountClient(baseURL: URL(string: "https://relayium.test")!,
                      session: StubURLProtocol.session())
    }

    override func setUp() { StubURLProtocol.reset() }
    override func tearDown() {
        StubURLProtocol.stub = nil
        StubURLProtocol.router = nil
        StubURLProtocol.reset()
    }

    /// One real JWS shape: three base64url segments separated by dots. Nothing
    /// in it needs JSON escaping, which is the property the body test relies on.
    private static let jws =
        "eyJhbGciOiJFUzI1NiIsIng1YyI6WyJNSUlF" + ".eyJ0cmFuc2FjdGlvbklkIjoiMjAwMDAwMDEifQ"
        + ".MEUCIQDf_-Ab0cD1ef2gh3IJ4kl5MN6op7QR8st9UV0wx1YZ2A"

    // MARK: - the account token

    /// POST, bearer in the header, no body, and nothing in the URL. WHICH
    /// account is the server's decision — read off the user the token resolves
    /// to — so there is no parameter here and there must never be one.
    func testTheAccountTokenIsPostedWithABearerAndNoParameters() async throws {
        StubURLProtocol.stub = .init(
            status: 200,
            body: Data(#"{"appAccountToken":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}"#.utf8),
            check: { req in
                XCTAssertEqual(req.url?.path, "/api/billing/apple/account-token")
                XCTAssertEqual(req.httpMethod, "POST")
                XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer rlm_app_T")
                XCTAssertNil(req.url?.query, "nothing about this request belongs in a URL")
            })
        let token = try await client().appleAccountToken(token: "rlm_app_T")
        XCTAssertEqual(token, UUID(uuidString: "3F2504E0-4F89-41D3-9A0C-0305E82C3301"))
        XCTAssertEqual(StubURLProtocol.requestCount, 1)
        XCTAssertTrue(StubURLProtocol.lastBodyBytes.isEmpty,
                      "the request carries no body — the bearer decides the account")
    }

    /// The bearer travels in the header and nowhere else. In a URL it reaches
    /// every proxy log, the server's access log, and any Referer.
    func testTheAccountTokenRequestKeepsTheBearerOutOfTheURL() async throws {
        StubURLProtocol.stub = .init(
            status: 200,
            body: Data(#"{"appAccountToken":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}"#.utf8))
        _ = try await client().appleAccountToken(token: "rlm_app_SECRET")
        for request in StubURLProtocol.observed {
            XCTAssertFalse(request.url?.absoluteString.contains("rlm_app_SECRET") ?? false,
                           "the bearer reached a URL: \(String(describing: request.url))")
        }
    }

    /// The parse is a requirement, not a convenience: the one thing this value
    /// is ever used for takes a `UUID`. A server answering something else must
    /// fail HERE, with nothing purchased, rather than at the point of sale.
    func testANonUUIDAccountTokenIsRefusedRatherThanCarried() async {
        for body in [#"{"appAccountToken":"not-a-uuid"}"#,
                     #"{"appAccountToken":""}"#,
                     #"{"token":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}"#,
                     "not json at all"] {
            StubURLProtocol.stub = .init(status: 200, body: Data(body.utf8))
            await XCTAssertThrowsErrorAsync(try await self.client().appleAccountToken(token: "t")) {
                XCTAssertEqual($0 as? AppleBillingError, .decoding, "body \(body)")
            }
        }
    }

    func testTheAccountTokenMapsEveryRefusal() async {
        let cases: [(Int, AppleBillingError)] = [
            (401, .notSignedIn), (429, .rateLimited),
            (403, .server(status: 403)), (500, .server(status: 500)),
            (503, .server(status: 503)),
        ]
        for (status, expected) in cases {
            StubURLProtocol.stub = .init(status: status, body: Data())
            await XCTAssertThrowsErrorAsync(try await self.client().appleAccountToken(token: "t")) {
                XCTAssertEqual($0 as? AppleBillingError, expected, "status \(status)")
            }
        }
    }

    // MARK: - submitting a transaction

    /// **The request body is one key, and its value is the JWS byte for byte.**
    ///
    /// The server decodes with `DisallowUnknownFields` and refuses a value that
    /// is not equal to its own trimmed copy — because verifying a normalized
    /// copy of what a client sent means the bytes checked are not the bytes
    /// submitted. So this asserts the exact key set AND that the string is
    /// unchanged, rather than that the request "contains" the JWS.
    func testTheSubmissionSendsExactlyOneFieldCarryingTheJWSUnchanged() async throws {
        StubURLProtocol.stub = .init(
            status: 200,
            body: Data(#"{"applied":true,"planId":"pro","status":"active","expiresAt":9,"provider":"apple"}"#.utf8),
            check: { req in
                XCTAssertEqual(req.url?.path, "/api/billing/apple/transaction")
                XCTAssertEqual(req.httpMethod, "POST")
                XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer rlm_app_T")
                XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
            })
        _ = try await client().submitAppleTransaction(signedTransactionInfo: Self.jws,
                                                      token: "rlm_app_T")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(
            with: Data(StubURLProtocol.lastBodyBytes)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["signedTransactionInfo"],
                       "the body carries something other than the one field the server accepts")
        XCTAssertEqual(object["signedTransactionInfo"] as? String, Self.jws,
                       "the JWS was not submitted byte for byte")
    }

    /// Whitespace is not tidied. A compact serialization has none in it, so a
    /// JWS carrying some is malformed rather than untidy — and the server, which
    /// compares against its own trimmed copy, is the one that must say so.
    /// Trimming here would submit bytes the caller never held.
    func testTheSubmissionDoesNotNormalizeTheJWS() async throws {
        let padded = " \(Self.jws)\n"
        StubURLProtocol.stub = .init(status: 400, body: Data(#"{"error":"invalid_request"}"#.utf8))
        await XCTAssertThrowsErrorAsync(
            try await self.client().submitAppleTransaction(signedTransactionInfo: padded,
                                                           token: "t")) { _ in }
        let object = try XCTUnwrap(JSONSerialization.jsonObject(
            with: Data(StubURLProtocol.lastBodyBytes)) as? [String: Any])
        XCTAssertEqual(object["signedTransactionInfo"] as? String, padded,
                       "the client trimmed the material the server verifies")
    }

    /// Neither the JWS nor the bearer may reach a URL. The JWS is transaction
    /// material and the bearer is a credential; both would be logged by every
    /// hop between here and the server.
    func testNeitherTheJWSNorTheBearerReachesAURL() async throws {
        StubURLProtocol.stub = .init(
            status: 200,
            body: Data(#"{"applied":true,"planId":"pro","status":"active","expiresAt":9,"provider":"apple"}"#.utf8))
        _ = try await client().submitAppleTransaction(signedTransactionInfo: Self.jws,
                                                      token: "rlm_app_SECRET")
        for request in StubURLProtocol.observed {
            let url = request.url?.absoluteString ?? ""
            XCTAssertFalse(url.contains("rlm_app_SECRET"), "the bearer reached a URL")
            XCTAssertFalse(url.contains("eyJhbGciOiJFUzI1NiIs"), "the JWS reached a URL")
        }
    }

    func testA200DecodesTheWholeEntitlement() async throws {
        StubURLProtocol.stub = .init(status: 200, body: Data("""
        {"applied":true,"planId":"plus","status":"active","expiresAt":1786000000,"provider":"apple"}
        """.utf8))
        let result = try await client().submitAppleTransaction(signedTransactionInfo: Self.jws,
                                                               token: "t")
        XCTAssertEqual(result, AppleTransactionResult(applied: true, planId: "plus",
                                                      status: "active", expiresAt: 1_786_000_000,
                                                      provider: "apple"))
    }

    /// `applied: false` is a SUCCESS — the server recognised the transaction and
    /// reports the current entitlement, because what was submitted was a
    /// redelivery of an older period. It is decoded as such rather than turned
    /// into a failure, and the finish policy above depends on that: a redelivery
    /// the server has converged on is exactly the case that may be finished.
    func testAnUnappliedRedeliveryIsStillADecodedSuccess() async throws {
        StubURLProtocol.stub = .init(status: 200, body: Data("""
        {"applied":false,"planId":"plus","status":"active","expiresAt":1786000000,"provider":"multiple"}
        """.utf8))
        let result = try await client().submitAppleTransaction(signedTransactionInfo: Self.jws,
                                                               token: "t")
        XCTAssertFalse(result.applied)
        XCTAssertEqual(result.planId, "plus")
        XCTAssertEqual(result.provider, "multiple")
    }

    /// A 200 nobody could read is not an acceptance. The request may well have
    /// been applied — which is precisely why it must not be treated as proven.
    func testAnUndecodable200IsAFailureRatherThanAnAcceptance() async {
        for body in ["", "not json", #"{"applied":true}"#, #"{"planId":"pro"}"#] {
            StubURLProtocol.stub = .init(status: 200, body: Data(body.utf8))
            await XCTAssertThrowsErrorAsync(
                try await self.client().submitAppleTransaction(signedTransactionInfo: Self.jws,
                                                               token: "t")) {
                XCTAssertEqual($0 as? AppleBillingError, .decoding, "body \(body.debugDescription)")
            }
        }
    }

    /// The three refusals the server states distinctly, plus the coarse one. It
    /// collapses every cryptographic, identity and catalog failure into
    /// `invalid_transaction` on purpose — a per-reason answer is a tool for
    /// shaping the next attempt — and the client preserves exactly that shape
    /// rather than inventing detail the server withheld.
    func testEachDocumentedRefusalCodeMapsToItsOwnCase() async {
        let cases: [(Int, String, AppleBillingError)] = [
            (400, "invalid_transaction", .invalidTransaction),
            (403, "token_mismatch", .tokenMismatch),
            (409, "subscription_owned", .subscriptionOwned),
            (503, "verifier_unavailable", .verifierUnavailable),
        ]
        for (status, code, expected) in cases {
            StubURLProtocol.stub = .init(status: status,
                                         body: Data(#"{"error":"\#(code)"}"#.utf8))
            await XCTAssertThrowsErrorAsync(
                try await self.client().submitAppleTransaction(signedTransactionInfo: Self.jws,
                                                               token: "t")) {
                XCTAssertEqual($0 as? AppleBillingError, expected, "\(status) \(code)")
            }
        }
    }

    /// A status the server documents, carrying a code it does not, is NOT that
    /// refusal. It is an unrecognised answer — a proxy, a WAF, a future
    /// deployment — and the honest report is the status itself.
    ///
    /// `invalid_request` is the sharp one: the server answers it for a malformed
    /// body, which says nothing about the transaction, so mapping it onto
    /// `invalidTransaction` would tell the layer above that a purchase was
    /// refused when what actually happened is that this client sent a bad
    /// request.
    func testAStatusWithoutItsDocumentedCodeStaysAnUnmappedServerFailure() async {
        let cases: [(Int, String)] = [
            (400, #"{"error":"invalid_request"}"#),
            (400, "bad request"),
            (403, #"{"error":"forbidden"}"#),
            (409, "conflict"),
            (503, #"{"error":"maintenance"}"#),
        ]
        for (status, body) in cases {
            StubURLProtocol.stub = .init(status: status, body: Data(body.utf8))
            await XCTAssertThrowsErrorAsync(
                try await self.client().submitAppleTransaction(signedTransactionInfo: Self.jws,
                                                               token: "t")) {
                XCTAssertEqual($0 as? AppleBillingError, .server(status: status),
                               "\(status) \(body)")
            }
        }
    }

    func testTheSubmissionMapsTheSharedRefusals() async {
        let cases: [(Int, AppleBillingError)] = [
            (401, .notSignedIn), (429, .rateLimited),
            (404, .server(status: 404)), (500, .server(status: 500)),
            (502, .server(status: 502)),
        ]
        for (status, expected) in cases {
            StubURLProtocol.stub = .init(status: status, body: Data())
            await XCTAssertThrowsErrorAsync(
                try await self.client().submitAppleTransaction(signedTransactionInfo: Self.jws,
                                                               token: "t")) {
                XCTAssertEqual($0 as? AppleBillingError, expected, "status \(status)")
            }
        }
    }

    /// A transport failure is this endpoint pair's own `.network`, not
    /// `AccountError.network`. The caller decides whether to finish a paid-for
    /// transaction on what it caught, and a value from the other enum is one it
    /// has no case for — it would fall through to "something unexpected" and
    /// lose the one fact that matters: the server may have applied this.
    func testATransportFailureIsThisEndpointsOwnNetworkCase() async {
        StubURLProtocol.stub = .init(status: 200, body: Data(),
                                     failure: URLError(.notConnectedToInternet))
        await XCTAssertThrowsErrorAsync(
            try await self.client().submitAppleTransaction(signedTransactionInfo: Self.jws,
                                                           token: "t")) {
            XCTAssertEqual($0 as? AppleBillingError, .network)
            XCTAssertNil($0 as? AccountError, "the shared account vocabulary leaked out")
        }
    }

    // MARK: - the catalog

    private static let catalogBody = """
    {"bundleId":"com.relayium.mac",
     "products":[{"productId":"com.relayium.mac.plus.monthly","planId":"plus",
                  "planName":"Plus","cycle":"monthly","sortOrder":10}],
     "purchase":{"allowed":true,"blockedBy":""}}
    """

    /// GET, bearer in the header, and the bundle identity as the ONE query
    /// parameter. It is the only thing this request asserts, and the server
    /// compares it against its own configured app list — so it can narrow the
    /// answer and never widen it.
    func testTheCatalogIsReadWithABearerAndExactlyOneBundleParameter() async throws {
        StubURLProtocol.stub = .init(
            status: 200,
            body: Data(Self.catalogBody.utf8),
            check: { req in
                XCTAssertEqual(req.url?.path, "/api/billing/apple/catalog")
                XCTAssertEqual(req.httpMethod, "GET")
                XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer rlm_app_T")
                let items = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)?
                    .queryItems ?? []
                XCTAssertEqual(items.map(\.name), ["bundleId"],
                               "the request carries something other than the bundle identity")
                XCTAssertEqual(items.first?.value, "com.relayium.mac")
                // The layer above re-reads this catalog immediately before a
                // sale to catch a row that changed since the screen was drawn;
                // a cached answer would defeat that read entirely.
                XCTAssertEqual(req.cachePolicy, .reloadIgnoringLocalCacheData,
                               "the catalog read may be answered by a URL cache")
            })

        let catalog = try await client().appleCatalog(bundleID: "com.relayium.mac",
                                                      token: "rlm_app_T")

        XCTAssertEqual(catalog.bundleId, "com.relayium.mac")
        XCTAssertEqual(catalog.products.map(\.productId), ["com.relayium.mac.plus.monthly"])
        XCTAssertEqual(catalog.products.first?.planName, "Plus")
        XCTAssertEqual(catalog.products.first?.cycle, "monthly")
        XCTAssertEqual(catalog.products.first?.sortOrder, 10)
        XCTAssertEqual(catalog.purchase, AppleCatalogPurchase(allowed: true, blockedBy: ""))
        XCTAssertTrue(StubURLProtocol.lastBodyBytes.isEmpty)
    }

    /// A bundle identifier carrying URL punctuation is ENCODED rather than
    /// pasted. Unencoded, `&` would split it into a second parameter — which the
    /// server refuses, but only because it counts them; the request should say
    /// what this method meant regardless.
    func testABundleIdentifierWithURLPunctuationIsEncodedNotSplit() async throws {
        StubURLProtocol.stub = .init(status: 200, body: Data(Self.catalogBody.utf8))
        _ = try? await client().appleCatalog(bundleID: "a&bundleId=b", token: "t")

        let url = try XCTUnwrap(StubURLProtocol.observed.first?.url)
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.count, 1, "the identifier became a second parameter: \(url)")
        XCTAssertEqual(items.first?.value, "a&bundleId=b")
    }

    func testTheCatalogRequestKeepsTheBearerOutOfTheURL() async throws {
        StubURLProtocol.stub = .init(status: 200, body: Data(Self.catalogBody.utf8))
        _ = try await client().appleCatalog(bundleID: "com.relayium.mac", token: "rlm_app_SECRET")
        for request in StubURLProtocol.observed {
            XCTAssertFalse(request.url?.absoluteString.contains("rlm_app_SECRET") ?? false,
                           "the bearer reached a URL: \(String(describing: request.url))")
        }
    }

    /// An empty product list is a real answer — a configured deployment with
    /// nothing mapped for this build — and must decode rather than throw. The
    /// refusal that means "this deployment can verify nothing" is a 503, and the
    /// two lead to different screens.
    func testAnEmptyCatalogDecodesAsAnAnswerRatherThanAFailure() async throws {
        StubURLProtocol.stub = .init(status: 200, body: Data(#"""
        {"bundleId":"com.relayium.mac","products":[],"purchase":{"allowed":true,"blockedBy":""}}
        """#.utf8))
        let catalog = try await client().appleCatalog(bundleID: "com.relayium.mac", token: "t")
        XCTAssertTrue(catalog.products.isEmpty)
        XCTAssertTrue(catalog.purchase.allowed)
    }

    /// A body this client cannot read is a failure, not an empty catalog. An
    /// unreadable answer silently becoming "nothing on sale" would render a
    /// working deployment as one with no products.
    func testAnUnreadableCatalogBodyIsADecodingFailure() async {
        for body in [#"{"bundleId":"com.relayium.mac"}"#,
                     #"{"products":[],"purchase":{"allowed":true,"blockedBy":""}}"#,
                     #"{"bundleId":"x","products":[],"purchase":{"allowed":true}}"#,
                     "not json at all"] {
            StubURLProtocol.stub = .init(status: 200, body: Data(body.utf8))
            await XCTAssertThrowsErrorAsync(
                try await self.client().appleCatalog(bundleID: "com.relayium.mac", token: "t")) {
                XCTAssertEqual($0 as? AppleBillingError, .decoding, "body \(body)")
            }
        }
    }

    /// Every refusal, in the vocabulary the surface above switches on. The two
    /// coded 400s are distinguished by their body, and a 400 carrying neither
    /// code is neither of them.
    func testTheCatalogMapsEveryRefusal() async {
        let cases: [(Int, String, AppleBillingError)] = [
            (400, #"{"error":"unknown_bundle"}"#, .unknownBundle),
            (400, #"{"error":"invalid_request"}"#, .server(status: 400)),
            (400, "", .server(status: 400)),
            (401, "", .notSignedIn),
            (429, "", .rateLimited),
            (503, #"{"error":"verifier_unavailable"}"#, .verifierUnavailable),
            (503, "", .server(status: 503)),
            (500, "", .server(status: 500)),
        ]
        for (status, body, expected) in cases {
            StubURLProtocol.stub = .init(status: status, body: Data(body.utf8))
            await XCTAssertThrowsErrorAsync(
                try await self.client().appleCatalog(bundleID: "com.relayium.mac", token: "t")) {
                XCTAssertEqual($0 as? AppleBillingError, expected, "status \(status) body \(body)")
            }
        }
    }

    func testACatalogTransportFailureIsThisEndpointsOwnNetworkCase() async {
        StubURLProtocol.stub = .init(status: 200, body: Data(),
                                     failure: URLError(.notConnectedToInternet))
        await XCTAssertThrowsErrorAsync(
            try await self.client().appleCatalog(bundleID: "com.relayium.mac", token: "t")) {
            XCTAssertEqual($0 as? AppleBillingError, .network)
            XCTAssertNil($0 as? AccountError, "the shared account vocabulary leaked out")
        }
    }

    /// The concrete client is what the app injects behind the protocol; if the
    /// conformance ever moved, every seam above would silently be talking to
    /// something else.
    func testTheAccountClientIsTheBillingService() {
        let service: AppleBillingService = client()
        XCTAssertTrue(service is AccountClient)
    }
}
