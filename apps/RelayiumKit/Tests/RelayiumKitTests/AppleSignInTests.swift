import XCTest
import RelayiumKit
@testable import RelayiumAppKit

/// Native Sign in with Apple, from the three angles a package test can reach:
/// the values the app derives before anything is sent, the WIRE it sends, and
/// the session states the answer produces — including the interleavings, which
/// are the same ones a password sign-in has and therefore have to hold here too.
@MainActor
final class AppleSignInTests: XCTestCase {

    private func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: Bundle.module.url(forResource: name, withExtension: "json")!)
    }

    private func session(store: TokenStore = InMemoryTokenStore()) -> AccountSession {
        AccountSession(
            client: AccountClient(baseURL: URL(string: "https://relayium.test")!,
                                  session: StubURLProtocol.session()),
            tokenStore: store,
            deviceName: "Test Device"
        )
    }

    /// Routes /api/me and /api/me/usage to their fixtures, everything else to
    /// the Apple endpoint's body.
    private func routeAppleLogin(_ body: Data) throws {
        let me = try fixture("me"), usage = try fixture("me-usage")
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/me":       return .init(status: 200, body: me)
            case "/api/me/usage": return .init(status: 200, body: usage)
            default:              return .init(status: 200, body: body)
            }
        }
    }

    private func signIn(_ s: AccountSession) async {
        await s.logInWithApple(idToken: "eyJhbGciOiJSUzI1NiJ9.identity.sig",
                               authorizationCode: "c-one-time",
                               nonce: "NONCE-1",
                               name: "Ada Lovelace")
    }

    override func tearDown() {
        StubURLProtocol.stub = nil
        StubURLProtocol.router = nil
        StubURLProtocol.reset()
    }

    // MARK: - the nonce

    /// Two taps, two nonces. A reused nonce would let a token captured from the
    /// first authorization be replayed into the second.
    func testEveryAttemptGetsItsOwnNonce() {
        let nonces = (0..<64).map { _ in AppleSignInAttempt.fresh().nonce }
        XCTAssertEqual(Set(nonces).count, nonces.count, "a nonce repeated across attempts")
        let ids = (0..<8).map { _ in AppleSignInAttempt.fresh().id }
        XCTAssertEqual(Set(ids).count, ids.count, "two attempts shared an identity")
    }

    /// base64url, unpadded: the value lands in a JWT claim and is compared as a
    /// string by the server, so `+`, `/` and `=` may not appear in it.
    func testTheNonceIsUnpaddedBase64URLOfEnoughRandomness() {
        let allowed = CharacterSet(charactersIn:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        for _ in 0..<32 {
            let nonce = AppleSignInAttempt.fresh().nonce
            XCTAssertNil(nonce.rangeOfCharacter(from: allowed.inverted),
                         "nonce is not base64url: \(nonce)")
            // 32 bytes → 43 unpadded base64 characters. Asserting the length
            // pins the entropy, which is the property that matters.
            XCTAssertEqual(nonce.count, 43, nonce)
        }
    }

    /// OAuth state correlates the callback to the attempt whose nonce is still
    /// held. Missing state fails closed just like a different attempt's state.
    func testOnlyTheMatchingStateBelongsToAnAttempt() {
        let id = UUID(uuidString: "E9D53E84-01D6-4EA0-B7A4-AC79AA0BC730")!
        let attempt = AppleSignInAttempt(id: id, nonce: "nonce")

        XCTAssertEqual(attempt.state, id.uuidString)
        XCTAssertTrue(attempt.matches(returnedState: id.uuidString))
        XCTAssertFalse(attempt.matches(returnedState: UUID().uuidString))
        XCTAssertFalse(attempt.matches(returnedState: nil))
    }

    // MARK: - reading the credential

    func testAValidCredentialIsReadAsUTF8() throws {
        let credential = try AppleSignInCredential.read(
            identityToken: Data("header.payload.signature".utf8),
            authorizationCode: Data("c-one-time".utf8))
        XCTAssertEqual(credential.idToken, "header.payload.signature")
        XCTAssertEqual(credential.authorizationCode, "c-one-time")
    }

    /// Each missing half names itself. Sending an empty string instead would
    /// buy a round trip and a rate-limit slot to be told the same thing.
    func testAMissingOrUnreadableFieldIsRefusedByName() {
        let token = Data("header.payload.signature".utf8)
        let code = Data("c-one-time".utf8)
        // 0xFF is not valid UTF-8 in any position.
        let notUTF8 = Data([0xFF, 0xFE, 0xFF])

        XCTAssertThrowsError(try AppleSignInCredential.read(identityToken: nil,
                                                            authorizationCode: code)) {
            XCTAssertEqual($0 as? AppleSignInError, .missingIdentityToken)
        }
        XCTAssertThrowsError(try AppleSignInCredential.read(identityToken: Data(),
                                                            authorizationCode: code)) {
            XCTAssertEqual($0 as? AppleSignInError, .missingIdentityToken)
        }
        XCTAssertThrowsError(try AppleSignInCredential.read(identityToken: notUTF8,
                                                            authorizationCode: code)) {
            XCTAssertEqual($0 as? AppleSignInError, .missingIdentityToken)
        }
        XCTAssertThrowsError(try AppleSignInCredential.read(identityToken: token,
                                                            authorizationCode: nil)) {
            XCTAssertEqual($0 as? AppleSignInError, .missingAuthorizationCode)
        }
        XCTAssertThrowsError(try AppleSignInCredential.read(identityToken: token,
                                                            authorizationCode: notUTF8)) {
            XCTAssertEqual($0 as? AppleSignInError, .missingAuthorizationCode)
        }
    }

    /// Apple sends a name on the FIRST authorization and never again, so the
    /// empty result is the normal one — and it must stay empty rather than
    /// becoming something invented from the address.
    func testTheNameIsFormattedFromWhatAppleSentOrLeftEmpty() {
        XCTAssertEqual(AppleSignInName.format(givenName: "Ada", familyName: "Lovelace"),
                       "Ada Lovelace")
        XCTAssertEqual(AppleSignInName.format(givenName: "Ada", familyName: nil), "Ada")
        XCTAssertEqual(AppleSignInName.format(givenName: nil, familyName: "Lovelace"), "Lovelace")
        XCTAssertEqual(AppleSignInName.format(givenName: nil, familyName: nil), "")
        XCTAssertEqual(AppleSignInName.format(givenName: "  ", familyName: "\n"), "")
        XCTAssertEqual(AppleSignInName.format(givenName: " Ada ", familyName: " Lovelace "),
                       "Ada Lovelace")
    }

    // MARK: - the wire

    /// The four values the server needs, in the body, under the names it reads.
    func testTheRequestCarriesAllFourValuesInTheBody() async throws {
        let sent = BodyRecorder()
        let login = try fixture("login-success")
        let me = try fixture("me"), usage = try fixture("me-usage")
        StubURLProtocol.reset()
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/me":       return .init(status: 200, body: me)
            case "/api/me/usage": return .init(status: 200, body: usage)
            default:
                // Read here rather than from the finished request: a body that
                // reaches a URLProtocol may arrive as a stream, and by the end
                // of the sign-in the last captured bytes belong to /api/me.
                sent.record(Data(StubURLProtocol.lastBodyBytes))
                return .init(status: 200, body: login)
            }
        }
        let s = session()
        await signIn(s)
        guard case .ready = s.state else { return XCTFail("setup failed, got \(s.state)") }

        let first = try XCTUnwrap(StubURLProtocol.observed.first)
        XCTAssertEqual(first.url?.path, "/api/auth/apple/native")
        XCTAssertEqual(first.httpMethod, "POST")
        let raw = try XCTUnwrap(sent.bodies.first)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: raw) as? [String: Any])
        XCTAssertEqual(body["idToken"] as? String, "eyJhbGciOiJSUzI1NiJ9.identity.sig")
        XCTAssertEqual(body["authorizationCode"] as? String, "c-one-time")
        XCTAssertEqual(body["nonce"] as? String, "NONCE-1")
        XCTAssertEqual(body["name"] as? String, "Ada Lovelace")
        // The endpoint has no deviceName field; sending one would look like a
        // feature and be read by nothing. The server names this device itself.
        XCTAssertNil(body["deviceName"])
    }

    /// The identity token and the one-time code are credentials for one
    /// exchange. Either in a URL would reach every proxy log, the server's
    /// access log and any Referer that followed.
    func testTheCredentialNeverAppearsInAURL() async throws {
        try routeAppleLogin(try fixture("login-success"))
        StubURLProtocol.reset()
        let s = session()
        await signIn(s)
        guard case .ready = s.state else { return XCTFail("setup failed, got \(s.state)") }

        XCTAssertFalse(StubURLProtocol.observed.isEmpty, "nothing was sent — the test proves nothing")
        for request in StubURLProtocol.observed {
            let url = request.url?.absoluteString ?? ""
            XCTAssertFalse(url.contains("identity.sig"), url)
            XCTAssertFalse(url.contains("c-one-time"), url)
            XCTAssertFalse(url.contains("NONCE-1"), url)
            XCTAssertNil(URLComponents(string: url)?.query, url)
            // …and not in a header either: only the bearer belongs in one, and
            // only after it has been issued.
            for (_, value) in request.allHTTPHeaderFields ?? [:] {
                XCTAssertFalse(value.contains("c-one-time"), value)
                XCTAssertFalse(value.contains("identity.sig"), value)
            }
        }
    }

    // MARK: - outcomes

    func testASuccessfulAppleSignInPersistsAndLoadsTheAccount() async throws {
        let store = InMemoryTokenStore()
        try routeAppleLogin(try fixture("login-success"))
        let s = session(store: store)

        await signIn(s)

        guard case let .ready(user, usage) = s.state else {
            return XCTFail("want ready, got \(s.state)")
        }
        // From /api/me, not from the login body: the 6-field login user has no
        // billing fields, so a session rendered from it would be half an account.
        XCTAssertEqual(user.planId, "pro")
        XCTAssertEqual(usage.plan.name, "Pro")
        XCTAssertEqual(try store.load(), "rlm_cli_TESTTOKEN")
    }

    /// The bearer the Apple exchange issued is the one the follow-up fetch must
    /// present. A stub that ignores headers would reach `.ready` either way.
    func testTheIssuedBearerAuthenticatesTheFollowUpFetch() async throws {
        try routeAppleLogin(try fixture("login-success"))
        let s = session()
        await signIn(s)
        XCTAssertEqual(StubURLProtocol.lastRequest?.value(forHTTPHeaderField: "Authorization"),
                       "Bearer rlm_cli_TESTTOKEN")
    }

    /// A frozen account gets the reactivation notice, and no credential.
    func testPendingDeletionIsItsOwnStateAndStoresNoToken() async throws {
        let store = InMemoryTokenStore()
        StubURLProtocol.stub = .init(status: 200, body: try fixture("login-pending-deletion"))
        let s = session(store: store)

        await signIn(s)

        XCTAssertEqual(s.state, .pendingDeletion(purgeAfter: 1_780_000_000,
                                                 reactivateToken: "react_abc"))
        XCTAssertNil(try store.load())
        XCTAssertNil(s.bearerToken)
    }

    /// The rejection the whole slice is about — and the one sentence it must
    /// never show. The user typed no email and no password, so the
    /// bad-credentials copy would name two fields they never touched.
    func testARejectedAppleCredentialNeverSaysWrongPassword() async throws {
        StubURLProtocol.stub = .init(status: 401, body: Data(#"{"error":"invalid_code"}"#.utf8))
        let s = session()

        await signIn(s)

        guard case let .failed(message) = s.state else { return XCTFail("got \(s.state)") }
        XCTAssertEqual(message, ErrorCopy.message(for: AccountError.appleRejected))
        XCTAssertNotEqual(message, ErrorCopy.message(for: AccountError.invalidCredentials))
        XCTAssertNil(s.bearerToken)
    }

    /// Every server refusal of the Apple credential is the same fact to the
    /// user, and none of them is a password problem.
    func testEveryServerRefusalMapsToTheAppleRejection() async throws {
        for code in ["invalid_token", "invalid_audience", "invalid_code", "token_mismatch"] {
            StubURLProtocol.stub = .init(status: 401, body: Data(#"{"error":"\#(code)"}"#.utf8))
            let s = session()
            await signIn(s)
            XCTAssertEqual(s.state, .failed(message: ErrorCopy.message(for: AccountError.appleRejected)),
                           "for \(code)")
        }
    }

    /// An exchange that could not be completed is not a rejection: nothing
    /// about the user's Apple ID is wrong, and its copy says a retry is worth
    /// making.
    func testAnUnavailableExchangeIsNotReportedAsARejection() async throws {
        for status in [502, 503] {
            StubURLProtocol.stub = .init(status: status,
                                         body: Data(#"{"error":"apple_unavailable"}"#.utf8))
            let s = session()
            await signIn(s)
            XCTAssertEqual(s.state,
                           .failed(message: ErrorCopy.message(for: AccountError.appleUnavailable)),
                           "for \(status)")
        }
    }

    /// A 400 means this app sent a body the endpoint could not use — a contract
    /// break, not an Apple refusal. It stays diagnosable rather than being
    /// folded into the rejection copy.
    func testAMalformedRequestIsReportedAsAServerStatus() async throws {
        StubURLProtocol.stub = .init(status: 400, body: Data(#"{"error":"invalid_request"}"#.utf8))
        let s = session()
        await signIn(s)
        XCTAssertEqual(s.state, .failed(message: ErrorCopy.message(for: AccountError.server(status: 400))))
    }

    /// A first authorization with no email has a device-side remedy. A raw 400
    /// would leave the user with no idea what to change.
    func testAMissingAppleEmailHasActionableCopy() async throws {
        StubURLProtocol.stub = .init(
            status: 400, body: Data(#"{"error":"no_email_first_signin"}"#.utf8))
        let s = session()

        await signIn(s)

        XCTAssertEqual(s.state,
                       .failed(message: ErrorCopy.message(for: AccountError.appleEmailUnavailable)))
        XCTAssertNotEqual(s.state,
                          .failed(message: ErrorCopy.message(for: AccountError.server(status: 400))))
    }

    /// A freshly issued bearer plus a server that cannot answer /api/me is a
    /// token in hand, not a rejected sign-in: offer a retry, keep the token.
    func testAFailedAccountLoadAfterAppleIsUnavailableNotFailed() async throws {
        let store = InMemoryTokenStore()
        let login = try fixture("login-success")
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/me": return .init(status: 503, body: Data())
            default:        return .init(status: 200, body: login)
            }
        }
        let s = session(store: store)

        await signIn(s)

        guard case .unavailable = s.state else { return XCTFail("want unavailable, got \(s.state)") }
        XCTAssertEqual(try store.load(), "rlm_cli_TESTTOKEN",
                       "a freshly issued token must be kept, not cleared")
    }

    /// A failure that never left the device may not be described as a refused
    /// sign-in, and it lands back on the form rather than on a retry screen.
    func testALocalAuthorizationFailureIsReportedWithoutTouchingTheNetwork() async {
        StubURLProtocol.reset()
        StubURLProtocol.router = { _ in
            XCTFail("a local Apple failure must not call the network")
            return .init(status: 500)
        }
        let s = session()

        s.reportAppleSignInFailure(AppleSignInError.missingAuthorizationCode)

        XCTAssertEqual(s.state,
                       .failed(message: ErrorCopy.message(for: AppleSignInError.missingAuthorizationCode)))
        XCTAssertEqual(StubURLProtocol.requestCount, 0)
        XCTAssertNil(s.bearerToken)
    }

    /// The four local failures each resolve a sentence of their own — no type
    /// name, and no reuse of the server's refusal copy.
    func testEveryLocalFailureHasItsOwnCopy() {
        let incomplete = ErrorCopy.message(for: AppleSignInError.missingIdentityToken)
        XCTAssertEqual(ErrorCopy.message(for: AppleSignInError.missingAuthorizationCode), incomplete)
        XCTAssertEqual(ErrorCopy.message(for: AppleSignInError.unexpectedCredential), incomplete)
        let failed = ErrorCopy.message(for: AppleSignInError.authorizationFailed)
        XCTAssertNotEqual(failed, incomplete)
        for message in [incomplete, failed] {
            XCTAssertFalse(message.contains("AppleSignInError"), message)
            XCTAssertNotEqual(message, ErrorCopy.message(for: AccountError.appleRejected))
            XCTAssertNotEqual(message, ErrorCopy.message(for: AccountError.invalidCredentials))
        }
    }

    // MARK: - operation identity
    //
    // The same interleavings a password sign-in has. An Apple sign-in reaches
    // `.ready` through the same tail, so it has to lose the same races.

    /// A sign-out that lands mid-exchange wins — and the late success must not
    /// write its token into the keychain afterwards.
    func testSignOutDuringAnInFlightAppleSignInWins() async throws {
        let store = InMemoryTokenStore()
        let login = try fixture("login-success")
        let me = try fixture("me"), usage = try fixture("me-usage")
        let gate = RequestGate()
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/me":       return .init(status: 200, body: me)
            case "/api/me/usage": return .init(status: 200, body: usage)
            case "/api/auth/logout": return .init(status: 200, body: Data())
            default:              gate.hold(); return .init(status: 200, body: login)
            }
        }
        let s = session(store: store)

        let signingIn = Task { await self.signIn(s) }
        await gate.reached()
        await s.logOut()
        gate.release()
        await signingIn.value

        XCTAssertEqual(s.state, .loggedOut,
                       "an Apple sign-in that finished after sign-out must not sign the user back in")
        XCTAssertNil(try store.load())
    }

    /// Two taps: the superseded one may not land on top of the newer one's
    /// outcome, even when it is the one that finishes last.
    func testAStaleAppleAttemptCannotOverwriteANewerOne() async throws {
        StubURLProtocol.reset()
        let login = try fixture("login-success")
        let me = try fixture("me"), usage = try fixture("me-usage")
        let gate = RequestGate()
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/me":       return .init(status: 200, body: me)
            case "/api/me/usage": return .init(status: 200, body: usage)
            default:
                // The FIRST authorization is the one held open, and it is the
                // one that gets rejected.
                guard StubURLProtocol.requestCount == 1 else {
                    return .init(status: 200, body: login)
                }
                gate.hold()
                return .init(status: 401, body: Data(#"{"error":"invalid_code"}"#.utf8))
            }
        }
        let s = session()

        let first = Task { await self.signIn(s) }
        await gate.reached()
        let second = Task { await self.signIn(s) }
        await Task.yield()
        gate.release()
        await second.value
        await first.value

        guard case .ready = s.state else {
            return XCTFail("the superseded attempt's rejection landed on top: \(s.state)")
        }
    }

    /// A window closing mid-authorization is not a rejected sign-in: nothing
    /// was saved, and the honest resting state is the form without an error the
    /// user did not cause.
    func testACancelledAppleSignInIsNotRenderedAsARejection() async throws {
        let gate = RequestGate()
        StubURLProtocol.router = { _ in gate.hold(); return .init(status: 503, body: Data()) }
        let s = session()

        let signingIn = Task { await self.signIn(s) }
        await gate.reached()
        signingIn.cancel()
        gate.release()
        await signingIn.value

        XCTAssertEqual(s.state, .loggedOut)
    }

    /// An Apple sign-in is a session-moving operation, so it clears a resend
    /// notice left over from the check-email screen — the same rule the other
    /// entry points follow.
    func testAnAppleSignInClearsAStaleResendNotice() async throws {
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/auth/email/resend": return .init(status: 200, body: Data(#"{"status":"sent"}"#.utf8))
            default: return .init(status: 200,
                                  body: Data(#"{"status":"verification_sent","email":"ada@example.com"}"#.utf8))
            }
        }
        let s = session()
        await s.register(email: "a@b.co", password: "pw12345678", displayName: "")
        await s.resendVerification(email: "ada@example.com")
        XCTAssertEqual(s.resendState, .requested)

        StubURLProtocol.router = { _ in .init(status: 401, body: Data(#"{"error":"invalid_code"}"#.utf8)) }
        await signIn(s)

        XCTAssertEqual(s.resendState, .idle)
    }

}

/// Collects request bodies from inside the stub's router, which runs on
/// URLSession's own thread — a captured local would be a data race.
private final class BodyRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [Data] = []

    func record(_ body: Data) {
        lock.lock(); defer { lock.unlock() }
        seen.append(body)
    }

    var bodies: [Data] {
        lock.lock(); defer { lock.unlock() }
        return seen
    }
}
