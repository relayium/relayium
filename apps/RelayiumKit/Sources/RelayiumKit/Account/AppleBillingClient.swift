import Foundation

/// The two authenticated requests an in-app purchase needs from Relayium's
/// server, and the exact vocabulary of refusals they can answer with.
///
/// It is a protocol rather than the concrete `AccountClient` for the same reason
/// `AccountManagementService` is: the interesting behaviour of the orchestration
/// above it is what it does when a submission is refused, is slow, or lands
/// after the account changed — and none of that is reachable through a URL stub
/// alone. `AccountClient` conforms, so there is still one implementation of the
/// wire format.
///
/// Neither method takes or returns anything the caller may act on unilaterally.
/// The account token is minted by the SERVER (a client that chose its own could
/// point a purchase at somebody else's account), and the transaction result is
/// the server's own reading of a signature it verified — nothing here derives an
/// entitlement from anything the device knows.
public protocol AppleBillingService {
    /// This account's stable App Store `appAccountToken`, minted on first ask.
    func appleAccountToken(token: String) async throws -> UUID
    /// Submit one signed App Store transaction, exactly as the store handed it
    /// over, and report what the server made of it.
    func submitAppleTransaction(signedTransactionInfo: String,
                                token: String) async throws -> AppleTransactionResult
}

/// What `POST /api/billing/apple/transaction` answered with on a 200.
///
/// It mirrors `appleTransactionResult` on the server field for field, and like
/// that type it echoes nothing back — no JWS, no account token, no transaction
/// id. What it carries is the entitlement the caller now holds, which is the one
/// thing a client has any business reading off this endpoint.
public struct AppleTransactionResult: Codable, Equatable {
    /// False when the transaction was correct but older than what is already
    /// recorded — a redelivery of a previous period. The rest of this value then
    /// describes the CURRENT entitlement rather than what the stale event would
    /// have produced.
    ///
    /// Load-bearing for the finish policy in exactly one direction: `false` is
    /// still a decoded 200, and a decoded 200 is what proves the store's copy of
    /// this transaction has been durably accounted for. `AppleSubmission` in
    /// RelayiumAppKit is where that rule is written down.
    public var applied: Bool
    public var planId: String
    public var status: String
    public var expiresAt: Int64
    /// `"apple"`, or `"multiple"` when a Stripe subscription is live alongside.
    public var provider: String

    public init(applied: Bool, planId: String, status: String,
                expiresAt: Int64, provider: String) {
        self.applied = applied
        self.planId = planId
        self.status = status
        self.expiresAt = expiresAt
        self.provider = provider
    }
}

/// Every way the two billing requests can fail, kept apart because the caller
/// above them has to tell them apart.
///
/// Deliberately its own type rather than more cases on ``AccountError``. These
/// are answers to "what happened to this purchase", and folding them into the
/// type whose copy talks about emails, passwords and sign-in would put a
/// sentence about credentials on a refunded transaction. `AccountError` is also
/// switched over exhaustively by the app's copy layer, and this batch adds no
/// user-visible strings — see ``AppleSubscriptionFailure`` for where the typed
/// value is carried instead of a rendered sentence.
///
/// **None of these is ever a reason to finish a transaction.** The whole set is
/// "the server did not tell us, in a body we could read, that it took this
/// exact JWS" — including the ones that look permanent. `AppleSubmission` in
/// RelayiumAppKit is where that rule is written down, and why.
public enum AppleBillingError: Error, Equatable {
    /// 401 — the bearer is stale, revoked, or was never valid. Reported, never
    /// acted on: this layer does not own the session and may not end one.
    case notSignedIn
    /// 429.
    case rateLimited
    /// 400 `invalid_transaction` — the server refused the JWS itself. Its
    /// vocabulary is deliberately coarse: every cryptographic, identity and
    /// catalog refusal (including a product this deployment has no mapping for)
    /// arrives as this one code, because a per-reason answer is a tool for
    /// shaping the next attempt.
    case invalidTransaction
    /// 403 `token_mismatch` — the purchase carries another account's
    /// `appAccountToken`. The money moved; it just did not move for this
    /// Relayium account.
    case tokenMismatch
    /// 409 `subscription_owned` — this App Store subscription already has a
    /// different Relayium owner. Nothing was written.
    case subscriptionOwned
    /// 503 `verifier_unavailable` — this deployment holds no Apple trust roots
    /// and can verify nothing. The shipping default today.
    case verifierUnavailable
    /// Any other non-200, including a 400/403/409/503 whose body did not carry
    /// the documented code. "Unmapped" is not "harmless": an unrecognised
    /// refusal is the case where the least is known.
    case server(status: Int)
    /// A 200 whose body did not decode, or an account-token response that was
    /// not a UUID. The request may well have succeeded — that is exactly why
    /// this is a failure and not a success.
    case decoding
    /// `URLSession` never completed the exchange. The server may have applied
    /// the transaction and the answer been lost on the way back.
    case network
}

extension AccountClient: AppleBillingService {
    /// `POST /api/billing/apple/account-token`.
    ///
    /// POST rather than GET because the first call MINTS the token, and because
    /// a GET would additionally be cacheable — the wrong property for a value
    /// that names exactly one account. The bearer decides which account; there
    /// is no parameter, and there must never be one.
    ///
    /// The response is parsed into a `UUID` rather than passed on as a string,
    /// and the parse is a REQUIREMENT rather than a convenience: the only thing
    /// this value is ever used for is `Product.PurchaseOption.appAccountToken`,
    /// which takes a `UUID`. Doing it here means a server that ever answered
    /// something else fails at the boundary, with nothing purchased, instead of
    /// at the point of sale.
    ///
    /// Nothing here logs. The token maps to exactly one account, which is
    /// precisely what does not belong in a line that outlives the request.
    public func appleAccountToken(token: String) async throws -> UUID {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/billing/apple/account-token"))
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await appleSend(req)
        switch resp.statusCode {
        case 200:
            guard let body = try? JSONDecoder().decode(AppleAccountTokenBody.self, from: data),
                  let uuid = UUID(uuidString: body.appAccountToken) else {
                throw AppleBillingError.decoding
            }
            return uuid
        case 401: throw AppleBillingError.notSignedIn
        case 429: throw AppleBillingError.rateLimited
        default:  throw AppleBillingError.server(status: resp.statusCode)
        }
    }

    /// `POST /api/billing/apple/transaction`.
    ///
    /// **The body is one field, and the field is verbatim.** The server decodes
    /// with `DisallowUnknownFields` and refuses a value that is not equal to its
    /// own trimmed copy, because verifying a normalized copy of what a client
    /// sent means the bytes checked are not the bytes submitted. So this method
    /// composes `{"signedTransactionInfo": <jws>}` and does nothing else to the
    /// string: no trimming, no re-encoding, no second key. A caller cannot add
    /// one either — the parameter is a `String`, not a dictionary.
    ///
    /// **Nothing about the purchase is asserted by the client.** The device's
    /// own StoreKit verification result is not sent and is not asked for; the
    /// tier, the account and the signature are all the server's to decide. That
    /// is why there is no product id, no price and no plan in this request.
    ///
    /// Nothing here logs. The JWS is transaction material and the bearer is a
    /// credential; neither reaches a URL, a header other than `Authorization`,
    /// or any error value this throws.
    public func submitAppleTransaction(signedTransactionInfo: String,
                                       token: String) async throws -> AppleTransactionResult {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/billing/apple/transaction"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        // JSONEncoder over a one-field type, so the document cannot grow a key
        // by accident and the JWS is escaped by the same rules the server's
        // decoder reads. Base64url and `.` need no escaping either way, so the
        // bytes between the quotes are the bytes handed over.
        req.httpBody = try JSONEncoder().encode(
            AppleTransactionSubmission(signedTransactionInfo: signedTransactionInfo))
        let (data, resp) = try await appleSend(req)
        switch resp.statusCode {
        case 200:
            guard let result = try? JSONDecoder().decode(AppleTransactionResult.self, from: data) else {
                throw AppleBillingError.decoding
            }
            return result
        case 400:
            // The server answers `invalid_request` for a malformed body and
            // `invalid_transaction` for one it could not verify or map. Both are
            // refusals; only the second says anything about the purchase, and a
            // body carrying neither code is not one of them.
            guard appleErrorCode(in: data) == "invalid_transaction" else {
                throw AppleBillingError.server(status: 400)
            }
            throw AppleBillingError.invalidTransaction
        case 401: throw AppleBillingError.notSignedIn
        case 403:
            guard appleErrorCode(in: data) == "token_mismatch" else {
                throw AppleBillingError.server(status: 403)
            }
            throw AppleBillingError.tokenMismatch
        case 409:
            guard appleErrorCode(in: data) == "subscription_owned" else {
                throw AppleBillingError.server(status: 409)
            }
            throw AppleBillingError.subscriptionOwned
        case 429: throw AppleBillingError.rateLimited
        case 503:
            guard appleErrorCode(in: data) == "verifier_unavailable" else {
                throw AppleBillingError.server(status: 503)
            }
            throw AppleBillingError.verifierUnavailable
        default:  throw AppleBillingError.server(status: resp.statusCode)
        }
    }

    /// `send(_:)`, with the transport failure mapped into this endpoint pair's
    /// own vocabulary instead of `AccountError`'s.
    ///
    /// The distinction is not cosmetic: a caller of these two methods decides
    /// whether to finish a store transaction on the strength of what it caught,
    /// and a `.network` from the shared enum would be a value it has no case
    /// for. Everything else `send` can raise is a status code, handled above.
    private func appleSend(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            return try await send(req)
        } catch {
            throw AppleBillingError.network
        }
    }

    /// The `error` field of a JSON error body, or nil when the body is not one.
    private func appleErrorCode(in data: Data) -> String? {
        (try? JSONDecoder().decode(AppleErrorBody.self, from: data))?.error
    }
}

/// The 200 body of the account-token endpoint: `{"appAccountToken": "<uuid>"}`.
private struct AppleAccountTokenBody: Decodable { let appAccountToken: String }

/// The whole request body of the transaction endpoint. One stored property, so
/// the encoded document has exactly one key — which is what the server's
/// `DisallowUnknownFields` decoder requires and what a hand-built dictionary
/// would leave to whoever edits the call site next.
private struct AppleTransactionSubmission: Encodable { let signedTransactionInfo: String }

private struct AppleErrorBody: Decodable { let error: String }
