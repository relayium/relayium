import Foundation

/// The authenticated requests an in-app purchase needs from Relayium's server,
/// and the exact vocabulary of refusals they can answer with.
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
    /// What this build may sell, for the bundle identity it actually ships as.
    ///
    /// The catalog is the SERVER's, and asking for it is not a formality: an app
    /// that carried its own product identifiers could be shipped pointing at a
    /// product the server has no mapping for, and the failure would land after
    /// the customer had been charged. A binary cannot be corrected; a row can.
    func appleCatalog(bundleID: String, token: String) async throws -> AppleProductCatalog
    func dispatchApplePurchase(bundleID: String, productID: String,
                               token: String) async throws -> ApplePurchaseDispatch
    /// This account's stable App Store `appAccountToken`, minted on first ask.
    func appleAccountToken(token: String) async throws -> UUID
    /// Submit one signed App Store transaction, exactly as the store handed it
    /// over, and report what the server made of it.
    func submitAppleTransaction(signedTransactionInfo: String,
                                token: String) async throws -> AppleTransactionResult
    func submitAppleTransaction(signedTransactionInfo: String,
                                signedRenewalInfo: String,
                                token: String) async throws -> AppleTransactionResult
}

public struct ApplePurchaseDispatch: Codable, Equatable, Sendable {
    public let appAccountToken: UUID
    public let attemptId: String
    public init(appAccountToken: UUID, attemptId: String) {
        self.appAccountToken = appAccountToken
        self.attemptId = attemptId
    }
}

public extension AppleBillingService {
    func submitAppleTransaction(signedTransactionInfo: String,
                                signedRenewalInfo: String,
                                token: String) async throws -> AppleTransactionResult {
        try await submitAppleTransaction(signedTransactionInfo: signedTransactionInfo, token: token)
    }
}

/// What `GET /api/billing/apple/catalog` answered with on a 200: the products
/// this build may offer, and whether this account may buy one at all.
///
/// It mirrors `appleCatalogResponse` on the server field for field, and like
/// that type it deliberately carries **no entitlement and no price**. What the
/// caller currently holds is `/api/me`'s answer and stays there; what a product
/// costs is Apple's answer for the caller's storefront and comes from the store.
public struct AppleProductCatalog: Codable, Equatable, Sendable {
    /// The bundle identity the SERVER resolved. Echoed from its own configured
    /// allowlist rather than from the request, so it is never a value this
    /// client typed being reflected back as an accepted app identity.
    public var bundleId: String
    /// Every product a purchase would currently resolve for, in the order the
    /// deployment ranks its tiers. Empty means "nothing on sale for this app" —
    /// a real answer, distinct from the refusal an unconfigured server gives.
    public var products: [AppleCatalogProduct]
    public var purchase: AppleCatalogPurchase
    /// The DEPLOYMENT-WIDE gate: whether this server is selling App Store
    /// subscriptions to anybody at all right now.
    ///
    /// **Optional, and absent means open.** A server that predates the gate
    /// sends no such key, and a client that refused those payloads would stop
    /// selling against every self-hosted deployment that has not updated yet —
    /// the exact failure the optionality of ``NativeUser/entitlementProvider``
    /// exists to avoid. ``purchasesArePaused`` is the one place that reading is
    /// written down, so no call site re-derives it.
    ///
    /// Distinct from ``purchase``, which is about THIS account. Both can refuse
    /// a purchase and they refuse it for unrelated reasons, so neither may be
    /// rendered with the other's words.
    public var purchases: AppleCatalogPurchases? = nil

    /// Whether the server has closed the global gate.
    ///
    /// An absent field is NOT paused (an older server), and an unrecognised
    /// `reason` beside `enabled: false` is still paused — the flag is the
    /// decision and the reason is only how it is worded.
    public var purchasesArePaused: Bool { purchases?.enabled == false }

    public init(bundleId: String, products: [AppleCatalogProduct],
                purchase: AppleCatalogPurchase,
                purchases: AppleCatalogPurchases? = nil) {
        self.bundleId = bundleId
        self.products = products
        self.purchase = purchase
        self.purchases = purchases
    }
}

/// Whether this deployment is selling at all, and why not when it is not.
public struct AppleCatalogPurchases: Codable, Equatable, Sendable {
    public var enabled: Bool
    /// `"paused"` when an operator closed the gate, `""` when enabled. A closed
    /// vocabulary rather than a sentence: the words belong to the surface that
    /// renders them, in the reader's own language.
    public var reason: String

    public init(enabled: Bool, reason: String) {
        self.enabled = enabled
        self.reason = reason
    }
}

/// One purchasable App Store product, and what the plan behind it is called.
public struct AppleCatalogProduct: Codable, Equatable, Sendable, Identifiable {
    /// The App Store product identifier — what the store is asked to load, and
    /// what a purchase is started by.
    public var productId: String
    public var planId: String
    /// The tier's display name, as this deployment names it.
    public var planName: String
    /// `"monthly"` or `"yearly"`. A vocabulary, not copy: the layer that renders
    /// it owns the words.
    public var cycle: String
    /// The tier's declared rank. Carried so a client can order tiers the way the
    /// deployment orders them, and tell an upgrade from a downgrade, without a
    /// second table of its own.
    public var sortOrder: Int64
    /// What the tier GRANTS, from the deployment's own `plans` row: the storage
    /// ceiling and the monthly relayed-traffic allowance, in bytes. `0` means
    /// unlimited, the same convention `/api/me/usage` publishes.
    ///
    /// **Optional for the same reason ``AppleProductCatalog/purchases`` is**: a
    /// server that predates these fields sends neither, and a client that
    /// refused those payloads could not sell against it at all. `nil` therefore
    /// means "this deployment did not say", which the purchase surface renders
    /// by saying nothing rather than by guessing a figure.
    ///
    /// They are the server's answer and never a compiled-in table. A tier's
    /// quota is editable in the admin console, so a binary carrying its own copy
    /// would eventually print a quantity the deployment does not grant, beside
    /// Apple's real price.
    public var storageBytes: Int64? = nil
    public var trafficBytes: Int64? = nil

    public var id: String { productId }

    public init(productId: String, planId: String, planName: String,
                cycle: String, sortOrder: Int64,
                storageBytes: Int64? = nil, trafficBytes: Int64? = nil) {
        self.productId = productId
        self.planId = planId
        self.planName = planName
        self.cycle = cycle
        self.sortOrder = sortOrder
        self.storageBytes = storageBytes
        self.trafficBytes = trafficBytes
    }
}

/// Whether this account may start an App Store purchase right now.
///
/// The answer is the server's because the rule is: an account already paying
/// through a provider the App Store cannot see must not be sold a second
/// subscription. A client that guessed would guess wrong in the expensive
/// direction.
public struct AppleCatalogPurchase: Codable, Equatable, Sendable {
    public var allowed: Bool
    /// Who owns the live entitlement when `allowed` is false — `"stripe"` or
    /// `"admin"`, the same vocabulary `/api/me`'s `entitlementProvider` uses.
    /// `""` when allowed. Never `"apple"`: an existing App Store subscription is
    /// exactly the case that stays purchasable, because changing tier inside the
    /// subscription group is itself a purchase.
    public var blockedBy: String

    public init(allowed: Bool, blockedBy: String) {
        self.allowed = allowed
        self.blockedBy = blockedBy
    }
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
    public var currentProductId: String
    public var autoRenewProductId: String
    public var renewalAt: Int64

    public init(applied: Bool, planId: String, status: String,
                expiresAt: Int64, provider: String,
                currentProductId: String = "", autoRenewProductId: String = "", renewalAt: Int64 = 0) {
        self.applied = applied
        self.planId = planId
        self.status = status
        self.expiresAt = expiresAt
        self.provider = provider
        self.currentProductId = currentProductId
        self.autoRenewProductId = autoRenewProductId
        self.renewalAt = renewalAt
    }

    private enum CodingKeys: String, CodingKey { case applied, planId, status, expiresAt, provider, currentProductId, autoRenewProductId, renewalAt }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        applied = try c.decode(Bool.self, forKey: .applied)
        planId = try c.decode(String.self, forKey: .planId)
        status = try c.decode(String.self, forKey: .status)
        expiresAt = try c.decode(Int64.self, forKey: .expiresAt)
        provider = try c.decode(String.self, forKey: .provider)
        currentProductId = try c.decodeIfPresent(String.self, forKey: .currentProductId) ?? ""
        autoRenewProductId = try c.decodeIfPresent(String.self, forKey: .autoRenewProductId) ?? ""
        renewalAt = try c.decodeIfPresent(Int64.self, forKey: .renewalAt) ?? 0
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
    /// 409 `apple_subscription_conflict` — this Relayium account already has a
    /// different live Apple subscription, either in this app or another
    /// Relayium App Store app. Finishing would strand the newly charged
    /// transaction, so it remains pending for an operator/user resolution.
    case appleSubscriptionConflict
    /// The account is durably managed by another billing channel/app, or an
    /// earlier Apple dispatch is unresolved. It is not a transient retry.
    case purchaseAuthorityManaged(provider: String)
    /// 503 `verifier_unavailable` — this deployment holds no Apple trust roots
    /// and can verify nothing. The shipping default today.
    case verifierUnavailable
    /// Canonical App Store status could not be obtained yet. The transaction is
    /// deliberately unfinished and StoreKit will redeliver it for recovery.
    case reconciliationUnavailable
    /// 400 `unknown_bundle` — this server is not configured for the bundle
    /// identity this build ships as. Kept apart from `invalidTransaction`
    /// because it is not a statement about a purchase at all: it is the wrong
    /// BUILD talking to this deployment, and no retry and no repurchase fixes
    /// it. The app has nothing to sell and says so.
    case unknownBundle
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
	public func dispatchApplePurchase(bundleID: String, productID: String,
	                                  token: String) async throws -> ApplePurchaseDispatch {
		var req = URLRequest(url: baseURL.appendingPathComponent("api/billing/apple/purchase-dispatch"))
		req.httpMethod = "POST"
		req.setValue("application/json", forHTTPHeaderField: "Content-Type")
		req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		req.httpBody = try JSONEncoder().encode(ApplePurchaseDispatchRequest(bundleId: bundleID, productId: productID))
		let (data, resp) = try await appleSend(req)
		switch resp.statusCode {
		case 200:
			guard let body = try? JSONDecoder().decode(ApplePurchaseDispatchBody.self, from: data),
			      let uuid = UUID(uuidString: body.appAccountToken), !body.attemptId.isEmpty else {
				throw AppleBillingError.decoding
			}
			return ApplePurchaseDispatch(appAccountToken: uuid, attemptId: body.attemptId)
		case 401: throw AppleBillingError.notSignedIn
		case 409:
			let body = try? JSONDecoder().decode(AppleErrorBody.self, from: data)
			if body?.error == "billing_authority_conflict" || body?.error == "purchase_reconciliation_required" {
				throw AppleBillingError.purchaseAuthorityManaged(provider: body?.provider ?? "apple")
			}
			throw AppleBillingError.server(status: 409)
		case 429: throw AppleBillingError.rateLimited
		default: throw AppleBillingError.server(status: resp.statusCode)
		}
	}
    /// `GET /api/billing/apple/catalog?bundleId=…`.
    ///
    /// **The bundle identity is a parameter and is the caller's own.** It is the
    /// one thing this request asserts, and it can only ever NARROW the answer:
    /// the server compares it against its own configured app list and refuses
    /// anything else with `unknown_bundle`, so there is no value this method
    /// could send that makes a deployment describe an app it is not configured
    /// for. The response's `bundleId` is the server's copy, not this one.
    ///
    /// Built through `URLComponents` rather than by pasting a query string: a
    /// bundle identifier is reverse-DNS today, and a value carrying `&` would
    /// otherwise become a second parameter — which the server refuses, but only
    /// because it counts them. Percent-encoding it here means the request says
    /// what this method meant regardless.
    ///
    /// Nothing here logs, for the same reason nothing else in this file does:
    /// the bearer is a credential, and it reaches only the `Authorization`
    /// header.
    public func appleCatalog(bundleID: String, token: String) async throws -> AppleProductCatalog {
        var components = URLComponents(
            url: baseURL.appendingPathComponent("api/billing/apple/catalog"),
            resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "bundleId", value: bundleID)]
        guard let url = components?.url else {
            // A bundle identifier that cannot be put in a URL is not a request
            // worth sending. Reported as a decoding failure rather than a
            // network one: nothing left this device.
            throw AppleBillingError.decoding
        }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        // The caller re-reads this catalog immediately before a sale precisely
        // to catch a row that changed since the screen was drawn, so a cached
        // answer would defeat the read's whole purpose: what comes back must be
        // the server's CURRENT catalog, not whatever a URL cache still holds.
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await appleSend(req)
        switch resp.statusCode {
        case 200:
            guard let catalog = try? JSONDecoder().decode(AppleProductCatalog.self, from: data) else {
                throw AppleBillingError.decoding
            }
            return catalog
        case 400:
            // Two documented refusals share this status. `unknown_bundle` is the
            // one a correct client can provoke; `invalid_request` means this
            // method built a request the server would not read, which is a
            // defect here rather than a fact about the deployment.
            guard appleErrorCode(in: data) == "unknown_bundle" else {
                throw AppleBillingError.server(status: 400)
            }
            throw AppleBillingError.unknownBundle
        case 401: throw AppleBillingError.notSignedIn
        case 429: throw AppleBillingError.rateLimited
        case 503:
            guard appleErrorCode(in: data) == "verifier_unavailable" else {
                throw AppleBillingError.server(status: 503)
            }
            throw AppleBillingError.verifierUnavailable
        default:  throw AppleBillingError.server(status: resp.statusCode)
        }
    }

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
        try await submitAppleTransaction(signedTransactionInfo: signedTransactionInfo,
                                         signedRenewalInfo: "", token: token)
    }

    public func submitAppleTransaction(signedTransactionInfo: String,
                                       signedRenewalInfo: String,
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
            AppleTransactionSubmission(signedTransactionInfo: signedTransactionInfo,
                                       signedRenewalInfo: signedRenewalInfo))
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
	case 503 where appleErrorCode(in: data) == "reconciliation_unavailable":
		throw AppleBillingError.reconciliationUnavailable
        case 401: throw AppleBillingError.notSignedIn
        case 403:
            guard appleErrorCode(in: data) == "token_mismatch" else {
                throw AppleBillingError.server(status: 403)
            }
            throw AppleBillingError.tokenMismatch
        case 409:
            switch appleErrorCode(in: data) {
            case "subscription_owned": throw AppleBillingError.subscriptionOwned
            case "apple_subscription_conflict": throw AppleBillingError.appleSubscriptionConflict
            default: throw AppleBillingError.server(status: 409)
            }
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
private struct ApplePurchaseDispatchRequest: Encodable { let bundleId: String; let productId: String }
private struct ApplePurchaseDispatchBody: Decodable { let appAccountToken: String; let attemptId: String }

/// The whole request body of the transaction endpoint. One stored property, so
/// the encoded document has exactly one key — which is what the server's
/// `DisallowUnknownFields` decoder requires and what a hand-built dictionary
/// would leave to whoever edits the call site next.
private struct AppleTransactionSubmission: Encodable {
    let signedTransactionInfo: String
    let signedRenewalInfo: String
}

private struct AppleErrorBody: Decodable { let error: String; let provider: String? }
