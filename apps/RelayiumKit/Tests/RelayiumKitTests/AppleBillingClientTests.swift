import XCTest
@testable import RelayiumKit
@testable import RelayiumAppKit

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

    // MARK: - dispatching a purchase

    func testThePurchaseDispatchCarriesOnlyBundleProductAndBearer() async throws {
        StubURLProtocol.stub = .init(
            status: 200,
            body: Data(#"{"appAccountToken":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","attemptId":"attempt-one"}"#.utf8),
            check: { req in
                XCTAssertEqual(req.url?.path, "/api/billing/apple/purchase-dispatch")
                XCTAssertEqual(req.httpMethod, "POST")
                XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer rlm_app_T")
                XCTAssertNil(req.url?.query)
            })
        let out = try await client().dispatchApplePurchase(
            bundleID: "com.relayium.mac", productID: "com.relayium.mac.pro.monthly",
            continuation: nil, token: "rlm_app_T")
        XCTAssertEqual(out.attemptId, "attempt-one")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(
            with: Data(StubURLProtocol.lastBodyBytes)) as? [String: String])
        XCTAssertEqual(body, ["bundleId": "com.relayium.mac",
                              "productId": "com.relayium.mac.pro.monthly"])
    }

    // MARK: - the continuation protocol on the wire

    /// **The initial arm: instance and arm identity present, secret ABSENT.**
    ///
    /// Absent rather than `null`. The server decodes with
    /// `DisallowUnknownFields` and selects the protocol on whether
    /// `appInstanceId` is present at all, so the exact key set is the contract —
    /// asserted as a whole dictionary, not key by key, because an extra key is
    /// as much a 400 as a missing one.
    func testTheInitialArmSendsTheInstanceAndArmButNoSecret() async throws {
        StubURLProtocol.stub = .init(
            status: 200,
            body: Data(#"{"appAccountToken":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","attemptId":"attempt-1","continuationSecret":"S3CR3T"}"#.utf8))
        let out = try await client().dispatchApplePurchase(
            bundleID: "com.relayium.mac", productID: "pro.monthly",
            continuation: ApplePurchaseContinuationFields(
                appInstanceID: "instance-A", armRequestID: "arm-1", continuationSecret: nil),
            token: "rlm_app_T")
        XCTAssertEqual(out.continuationSecret, "S3CR3T")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(
            with: Data(StubURLProtocol.lastBodyBytes)) as? [String: String])
        XCTAssertEqual(body, ["bundleId": "com.relayium.mac",
                              "productId": "pro.monthly",
                              "continuationProtocol": "attempt-id-v2",
                              "appInstanceId": "instance-A",
                              "armRequestId": "arm-1"])
        XCTAssertNil(body["continuationSecret"], "the compatibility fixture intentionally omits its initial secret")
    }

    /// A resume carries the secret, and the server does not re-issue one — which
    /// is what makes a lost resume response replayable without a second arm.
    func testAResumeSendsTheSecretAndGetsNoNewOne() async throws {
        StubURLProtocol.stub = .init(
            status: 200,
            body: Data(#"{"appAccountToken":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","attemptId":"attempt-1"}"#.utf8))
        let out = try await client().dispatchApplePurchase(
            bundleID: "com.relayium.mac", productID: "plus.monthly",
            continuation: ApplePurchaseContinuationFields(
                appInstanceID: "instance-A", armRequestID: "arm-2",
                continuationSecret: "S3CR3T"),
            token: "rlm_app_T")
        XCTAssertNil(out.continuationSecret)
        XCTAssertEqual(out.attemptId, "attempt-1", "a resume reuses the same attempt")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(
            with: Data(StubURLProtocol.lastBodyBytes)) as? [String: String])
        XCTAssertEqual(body, ["bundleId": "com.relayium.mac",
                              "productId": "plus.monthly",
                              "continuationProtocol": "attempt-id-v2",
                              "appInstanceId": "instance-A",
                              "armRequestId": "arm-2",
                              "continuationSecret": "S3CR3T"])
    }

    /// **Every field the outcome endpoint requires, and every outcome word.**
    ///
    /// The vocabulary is the server's own — `userCancelled`, `pending`,
    /// `failed`, `success` — and a value outside it is a 400, so it is asserted
    /// literally rather than derived from the case name at the assertion site.
    func testTheOutcomeReportCarriesEveryRequiredFieldAndVocabulary() async throws {
        let expected: [ApplePurchaseOutcome: String] = [
            .userCancelled: "userCancelled", .pending: "pending",
            .failed: "failed", .success: "success",
        ]
        XCTAssertEqual(expected.count, ApplePurchaseOutcome.allCases.count)
        for outcome in ApplePurchaseOutcome.allCases {
            StubURLProtocol.stub = .init(
                status: 200,
                body: Data(#"{"resumable":true}"#.utf8),
                check: { req in
                    XCTAssertEqual(req.url?.path, "/api/billing/apple/purchase-outcome")
                    XCTAssertEqual(req.httpMethod, "POST")
                    XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer rlm_app_T")
                    // The secret reaches the BODY and nothing else.
                    XCTAssertNil(req.url?.query)
                })
            _ = try await client().reportApplePurchaseOutcome(
                bundleID: "com.relayium.mac", attemptID: "attempt-1",
                continuation: ApplePurchaseContinuationFields(
                    appInstanceID: "instance-A", armRequestID: "arm-2",
                    continuationSecret: "S3CR3T"),
                outcome: outcome, token: "rlm_app_T")
            let body = try XCTUnwrap(JSONSerialization.jsonObject(
                with: Data(StubURLProtocol.lastBodyBytes)) as? [String: String])
            XCTAssertEqual(body, ["bundleId": "com.relayium.mac",
                                  "attemptId": "attempt-1",
                                  "appInstanceId": "instance-A",
                                  "armRequestId": "arm-2",
                                  "continuationSecret": "S3CR3T",
                                  "outcome": expected[outcome]])
        }
    }

    /// The server's answer is passed through as itself. **Only a cancellation is
    /// resumable**, and this client does not re-derive that from the outcome it
    /// sent — it reports what the server said.
    func testTheOutcomeAnswerIsTheServersOwnResumableVerdict() async throws {
        for resumable in [true, false] {
            StubURLProtocol.stub = .init(status: 200,
                                         body: Data("{\"resumable\":\(resumable)}".utf8))
            let answer = try await client().reportApplePurchaseOutcome(
                bundleID: "com.relayium.mac", attemptID: "attempt-1",
                continuation: ApplePurchaseContinuationFields(
                    appInstanceID: "i", armRequestID: "a", continuationSecret: "S"),
                outcome: .userCancelled, token: "t")
            XCTAssertEqual(answer, resumable)
        }
    }

    /// **A report with no secret is never sent.** An arm identity is spent once
    /// ever, so spending one on a request certain to be refused would burn the
    /// name this sheet has to report under.
    func testAReportWithNoSecretIsRefusedWithoutSpendingTheArm() async {
        StubURLProtocol.stub = .init(status: 200, body: Data(#"{"resumable":true}"#.utf8))
        for secret in [nil, ""] as [String?] {
            await XCTAssertThrowsErrorAsync(try await self.client().reportApplePurchaseOutcome(
                bundleID: "com.relayium.mac", attemptID: "attempt-1",
                continuation: ApplePurchaseContinuationFields(
                    appInstanceID: "i", armRequestID: "a", continuationSecret: secret),
                outcome: .userCancelled, token: "t")) {
                XCTAssertEqual($0 as? AppleBillingError, .continuationRejected)
            }
        }
        XCTAssertTrue(StubURLProtocol.lastBodyBytes.isEmpty, "a doomed report was sent anyway")
    }

    /// **The uniform capability refusal, on both endpoints.**
    ///
    /// `403 continuation_invalid` is deliberately its own case: what is unusable
    /// is this client's capability, not the attempt it was minted for, and the
    /// two have different repairs. It must never become a fresh one-shot
    /// dispatch — the capability being unusable says nothing about whether a
    /// sheet is open.
    func testTheUniformCapabilityRefusalIsItsOwnCase() async {
        StubURLProtocol.stub = .init(
            status: 403, body: Data(#"{"error":"continuation_invalid","provider":"apple"}"#.utf8))
        await XCTAssertThrowsErrorAsync(try await self.client().dispatchApplePurchase(
            bundleID: "com.relayium.mac", productID: "p",
            continuation: ApplePurchaseContinuationFields(
                appInstanceID: "i", armRequestID: "a", continuationSecret: "S"),
            token: "t")) {
            XCTAssertEqual($0 as? AppleBillingError, .continuationRejected)
        }
        StubURLProtocol.stub = .init(
            status: 403, body: Data(#"{"error":"continuation_invalid","provider":"apple"}"#.utf8))
        await XCTAssertThrowsErrorAsync(try await self.client().reportApplePurchaseOutcome(
            bundleID: "com.relayium.mac", attemptID: "attempt-1",
            continuation: ApplePurchaseContinuationFields(
                appInstanceID: "i", armRequestID: "a", continuationSecret: "S"),
            outcome: .userCancelled, token: "t")) {
            XCTAssertEqual($0 as? AppleBillingError, .continuationRejected)
        }

        // A proxy, WAF or captive portal may emit its own bare/HTML 403. It is
        // not server proof that this arm was superseded and must never retire
        // the only capability that can report a cancellation.
        StubURLProtocol.stub = .init(status: 403, body: Data("forbidden".utf8))
        await XCTAssertThrowsErrorAsync(try await self.client().reportApplePurchaseOutcome(
            bundleID: "com.relayium.mac", attemptID: "attempt-1",
            continuation: ApplePurchaseContinuationFields(
                appInstanceID: "i", armRequestID: "a", continuationSecret: "S"),
            outcome: .userCancelled, token: "t")) {
            XCTAssertEqual($0 as? AppleBillingError, .server(status: 403))
        }
    }

    /// **`409 purchase_outcome_required` is its own case, and it is not a charge.**
    ///
    /// It means a sheet this account armed has not said what StoreKit did. Kept
    /// apart from `purchaseAuthorityManaged` because the repair is the client's
    /// own — report the arm's outcome — rather than the server's resolution of
    /// an attempt this client cannot judge.
    func testAnArmedSheetAwaitingItsOutcomeIsItsOwnCase() async {
        StubURLProtocol.stub = .init(
            status: 409,
            body: Data(#"{"error":"purchase_outcome_required","provider":"apple"}"#.utf8))
        await XCTAssertThrowsErrorAsync(try await self.client().dispatchApplePurchase(
            bundleID: "com.relayium.mac", productID: "p",
            continuation: ApplePurchaseContinuationFields(
                appInstanceID: "i", armRequestID: "a", continuationSecret: "S"),
            token: "t")) {
            XCTAssertEqual($0 as? AppleBillingError, .purchaseOutcomeRequired)
        }
    }

    /// **No error this client raises carries the secret**, on either endpoint and
    /// on any status. An error is the value most likely to be logged.
    func testNoBillingErrorEverCarriesTheSecret() async {
        let secret = "TEST-SECRET-NOT-REAL"
        let fields = ApplePurchaseContinuationFields(
            appInstanceID: "instance-A", armRequestID: "arm-2", continuationSecret: secret)
        for status in [400, 401, 403, 409, 429, 500, 503] {
            StubURLProtocol.stub = .init(status: status, body: Data(#"{"error":"nope"}"#.utf8))
            do {
                _ = try await client().reportApplePurchaseOutcome(
                    bundleID: "com.relayium.mac", attemptID: "attempt-1",
                    continuation: fields, outcome: .userCancelled, token: "t")
                XCTFail("status \(status) did not fail")
            } catch {
                XCTAssertFalse(String(describing: error).contains(secret))
                XCTAssertFalse(String(reflecting: error).contains(secret))
            }
        }
        // And the field carrier itself, which is what an error path would print.
        XCTAssertFalse(String(describing: fields).contains(secret))
    }

    func testAnExistingAuthorityOrDispatchIsNotASecondPurchasePermission() async {
        let cases: [(String, AppleBillingError)] = [
            ("billing_authority_conflict",
             .initialArmRejected(code: "billing_authority_conflict", provider: "apple")),
            ("purchase_reconciliation_required",
             .purchaseAuthorityManaged(provider: "apple")),
        ]
        for (code, expected) in cases {
            StubURLProtocol.stub = .init(
                status: 409,
                body: Data("{\"error\":\"\(code)\",\"provider\":\"apple\"}".utf8))
            await XCTAssertThrowsErrorAsync(try await self.client().dispatchApplePurchase(
                bundleID: "com.relayium.mac", productID: "p", continuation: nil, token: "t")) {
                XCTAssertEqual($0 as? AppleBillingError, expected)
            }
        }
    }

    /// **`purchaseAuthorityManaged` has exactly one preimage, and that is what
    /// licenses its wording.**
    ///
    /// The case name reads like "another channel owns this account's billing",
    /// and the contract is narrower: `purchase-dispatch` raises it only for 409
    /// `purchase_reconciliation_required`, which the server emits from its
    /// unresolved-ATTEMPT branch. The two codes that really are account-level
    /// authority answers arrive as `initialArmRejected` and stay presentable as
    /// ownership. This pins the whole 409 vocabulary at once, so widening this
    /// case by adding a code to that branch cannot pass silently: every sentence
    /// above it is chosen on the strength of this mapping.
    func testTheUnresolvedAttemptCodeIsTheOnlyPreimageOfPurchaseAuthorityManaged() async {
        let vocabulary: [(String, AppleBillingError)] = [
            ("purchase_reconciliation_required", .purchaseAuthorityManaged(provider: "apple")),
            ("manage_with_apple", .initialArmRejected(code: "manage_with_apple", provider: "apple")),
            ("billing_authority_conflict",
             .initialArmRejected(code: "billing_authority_conflict", provider: "apple")),
            ("purchases_paused", .initialArmRejected(code: "purchases_paused", provider: "apple")),
            ("purchase_outcome_required", .purchaseOutcomeRequired),
            ("something_new", .server(status: 409)),
        ]
        for (code, expected) in vocabulary {
            StubURLProtocol.stub = .init(
                status: 409, body: Data("{\"error\":\"\(code)\",\"provider\":\"apple\"}".utf8))
            await XCTAssertThrowsErrorAsync(try await self.client().dispatchApplePurchase(
                bundleID: "com.relayium.mac", productID: "p", continuation: nil, token: "t")) {
                XCTAssertEqual($0 as? AppleBillingError, expected, "409 \(code) changed meaning")
            }
        }

        // And no other status may raise it. A 4xx/5xx that happens to carry the
        // same word is not this server's unresolved-attempt answer.
        for status in [400, 403, 429, 500, 503] {
            StubURLProtocol.stub = .init(
                status: status,
                body: Data(#"{"error":"purchase_reconciliation_required","provider":"apple"}"#.utf8))
            await XCTAssertThrowsErrorAsync(try await self.client().dispatchApplePurchase(
                bundleID: "com.relayium.mac", productID: "p", continuation: nil, token: "t")) {
                XCTAssertNotEqual($0 as? AppleBillingError,
                                  .purchaseAuthorityManaged(provider: "apple"),
                                  "status \(status) was read as an unresolved attempt")
            }
        }

        // The contract carried through to what the user reads, in both shipped
        // languages: an unresolved attempt is reconciliation, and the authority
        // conflict beside it is still ownership. Same 409, opposite sentences.
        for language in [AppLanguage.en, .zh] {
            XCTAssertEqual(
                AppleSubscriptionPresentation.message(
                    for: .billing(.purchaseAuthorityManaged(provider: "apple")), language: language),
                L10n.t(.subscriptionErrorReconciliation, language: language),
                "the unresolved-attempt refusal lost its sentence in \(language)")
            XCTAssertEqual(
                AppleSubscriptionPresentation.message(
                    for: .purchaseNotAllowed(blockedBy: "apple"), language: language),
                L10n.t(.subscriptionBlockedByAppleApp, language: language),
                "the authority conflict lost its sentence in \(language)")
        }
    }

    func testBareProxyStatusesAreNeverProofThatAnArmWasNotCreated() async {
        for status in [400, 409] {
            StubURLProtocol.stub = .init(status: status, body: Data("proxy refusal".utf8))
            await XCTAssertThrowsErrorAsync(try await self.client().dispatchApplePurchase(
                bundleID: "com.relayium.mac", productID: "p",
                continuation: ApplePurchaseContinuationFields(
                    appInstanceID: "i", armRequestID: "a", continuationSecret: "S"),
                token: "t")) {
                XCTAssertEqual($0 as? AppleBillingError, .server(status: status))
            }
        }
    }

    // MARK: - submitting a transaction

    /// Both independently signed documents are carried byte for byte.
    ///
    /// The server decodes with `DisallowUnknownFields` and refuses a value that
    /// is not equal to its own trimmed copy — because verifying a normalized
    /// copy of what a client sent means the bytes checked are not the bytes
    /// submitted. So this asserts the exact key set AND that the string is
    /// unchanged, rather than that the request "contains" the JWS.
    func testTheSubmissionSendsTransactionAndRenewalJWSUnchanged() async throws {
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
                                                      signedRenewalInfo: "renewal.jws.value",
                                                      token: "rlm_app_T")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(
            with: Data(StubURLProtocol.lastBodyBytes)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["signedTransactionInfo", "signedRenewalInfo"])
        XCTAssertEqual(object["signedTransactionInfo"] as? String, Self.jws,
                       "the JWS was not submitted byte for byte")
        XCTAssertEqual(object["signedRenewalInfo"] as? String, "renewal.jws.value")
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
            (409, "apple_subscription_conflict", .appleSubscriptionConflict),
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

    func testCanonicalReconciliationUnavailableIsRecoverable() async {
        StubURLProtocol.stub = .init(status: 503, body: Data(#"{"error":"reconciliation_unavailable"}"#.utf8))
        await XCTAssertThrowsErrorAsync(
            try await self.client().submitAppleTransaction(signedTransactionInfo: Self.jws, token: "t")) {
            XCTAssertEqual($0 as? AppleBillingError, .reconciliationUnavailable)
        }
    }

    func testA409ForAnUnresolvedDispatchCannotFinishTheStoreTransaction() async {
        StubURLProtocol.stub = .init(status: 409, body: Data(#"{"error":"purchase_reconciliation_required"}"#.utf8))
        do {
            _ = try await client().submitAppleTransaction(signedTransactionInfo: Self.jws, token: "t")
            XCTFail("409 was decoded as an accepted transaction")
        } catch {
            XCTAssertEqual(error as? AppleBillingError, .reconciliationUnavailable)
            XCTAssertFalse(AppleSubmission.refused(.billing(.reconciliationUnavailable)).permitsFinish)
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

    /// **The gate and the quota figures decode when they are there, and their
    /// absence is not a failure.**
    ///
    /// Both directions of compatibility live in this one test because both are
    /// real deployments. `catalogBody` above is exactly what a server that
    /// predates these fields sends, and it must still decode into a catalog this
    /// client can sell from — a self-hoster on an older build is the common
    /// case, and refusing their payload would leave the app unable to offer
    /// anything at all. A current server sends them, and they must arrive
    /// intact.
    func testTheGateAndQuotaFieldsDecodeAndTheirAbsenceIsNotAFailure() async throws {
        StubURLProtocol.stub = .init(status: 200, body: Data(Self.catalogBody.utf8))
        let old = try await client().appleCatalog(bundleID: "com.relayium.mac", token: "t")
        XCTAssertNil(old.purchases, "a server with no gate field decoded one anyway")
        XCTAssertFalse(old.purchasesArePaused, "a server with no gate field was read as paused")
        XCTAssertNil(old.products.first?.storageBytes)
        XCTAssertNil(old.products.first?.trafficBytes)

        StubURLProtocol.stub = .init(status: 200, body: Data(#"""
        {"bundleId":"com.relayium.mac",
         "products":[{"productId":"com.relayium.mac.plus.monthly","planId":"plus",
                      "planName":"Plus","cycle":"monthly","sortOrder":10,
                      "storageBytes":1073741824,"trafficBytes":21474836480}],
         "purchase":{"allowed":true,"blockedBy":""},
         "purchases":{"enabled":true,"reason":""}}
        """#.utf8))
        let current = try await client().appleCatalog(bundleID: "com.relayium.mac", token: "t")
        XCTAssertEqual(current.purchases, AppleCatalogPurchases(enabled: true, reason: ""))
        XCTAssertFalse(current.purchasesArePaused)
        XCTAssertEqual(current.products.first?.storageBytes, 1_073_741_824)
        XCTAssertEqual(current.products.first?.trafficBytes, 21_474_836_480)
    }

    /// What a PAUSED deployment answers with, decoded: the gate closed and no
    /// products at all. Both halves matter — the empty list is what stops the
    /// build that is already shipped, and the flag is what lets this one say why.
    func testAPausedCatalogDecodesAsPausedWithNoProducts() async throws {
        StubURLProtocol.stub = .init(status: 200, body: Data(#"""
        {"bundleId":"com.relayium.mac","products":[],
         "purchase":{"allowed":true,"blockedBy":""},
         "purchases":{"enabled":false,"reason":"paused"}}
        """#.utf8))
        let catalog = try await client().appleCatalog(bundleID: "com.relayium.mac", token: "t")
        XCTAssertTrue(catalog.products.isEmpty)
        XCTAssertTrue(catalog.purchasesArePaused)
        XCTAssertEqual(catalog.purchases?.reason, "paused")
        // The account's own eligibility is untouched by a global pause: a Stripe
        // subscriber must still be told where their subscription lives.
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
