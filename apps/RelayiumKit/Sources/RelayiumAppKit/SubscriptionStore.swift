import Foundation

/// The app's whole view of an in-app purchase store, with no `import StoreKit`
/// anywhere in it.
///
/// **Why a seam at all.** Everything worth getting right about a purchase is
/// ordering and refusal handling — submit before finish, never finish an
/// unaccepted transaction, do nothing at all while signed out — and none of it
/// is reachable through the real StoreKit, which needs a signed build, a
/// sandbox Apple ID and a product that exists in App Store Connect. Behind this
/// protocol the whole policy runs under `swift test` against a fake that can
/// deliver a pending purchase, a cancellation and a redelivery on demand.
///
/// **Why it is StoreKit-independent rather than StoreKit-shaped.** The one
/// implementation that imports StoreKit lives in its own SwiftPM target
/// (`RelayiumStoreKit`) which no app links in this batch. If the types crossing
/// this boundary were StoreKit's, that isolation would be decorative: every
/// consumer would need the framework to name the values. So a delivery is a
/// string and an id, and the opaque store object it came from never leaves the
/// adapter.
public protocol SubscriptionStore: Sendable {
    /// Localized offers for the given product identifiers, in whatever order
    /// and count the store answered with — an identifier the store does not
    /// know is simply absent, never invented.
    func offers(for productIDs: [String]) async throws -> [SubscriptionOffer]

    /// Buy one product, attributed to `appAccountToken`.
    ///
    /// The token is a parameter rather than something the adapter fetches
    /// because the adapter must not be able to choose it: it is minted by
    /// Relayium's server for the authenticated account, and a store layer that
    /// could supply its own would be able to attribute a purchase to an account
    /// nobody proved they hold.
    func purchase(productID: String, appAccountToken: UUID) async throws -> StorePurchaseOutcome

    /// Everything this Apple ID currently owns for this app, as signed
    /// transactions. The restore path's input.
    func currentEntitlements() async -> [SignedStoreTransaction]

    /// Renewals, refunds, upgrades, Ask-to-Buy approvals and anything the store
    /// could not deliver at the time it happened.
    ///
    /// A fresh sequence per call. The model calls it exactly once and cancels
    /// the task that drains it on shutdown, which is what stops an adapter's
    /// underlying subscription from outliving the object that asked for it.
    func updates() -> AsyncStream<SignedStoreTransaction>

    /// Ask the store to reconcile with the App Store account. May prompt for
    /// credentials, and throws when the user declines.
    func synchronize() async throws

    /// Tell the store this transaction has been dealt with, so it stops being
    /// redelivered.
    ///
    /// **The single most dangerous call in this file.** See
    /// ``AppleSubmission/permitsFinish`` for the one condition under which the
    /// model is allowed to make it. It takes an id rather than a delivery so
    /// that what is finished is exactly what was delivered — the adapter looks
    /// the id up in its own table and finishes that transaction, or nothing.
    func finish(_ id: StoreTransactionID) async
}

/// One purchasable product, already localized by the store.
///
/// `displayPrice` is the store's own formatting — currency, separators and
/// placement for the storefront the user is actually in. Nothing here goes
/// through Relayium's catalogs, and nothing here may be re-formatted: a price
/// this app rendered itself would be a price Apple did not agree to.
public struct SubscriptionOffer: Equatable, Identifiable, Sendable {
    /// The App Store product identifier. Also the id a purchase is started by.
    public let id: String
    public let displayName: String
    public let description: String
    public let displayPrice: String

    public init(id: String, displayName: String, description: String, displayPrice: String) {
        self.id = id
        self.displayName = displayName
        self.description = description
        self.displayPrice = displayPrice
    }
}

/// A store transaction's identity, opaque to everything above the adapter.
///
/// It exists so that a delivery can be carried around, submitted, and then
/// finished, without the transaction object itself — which only StoreKit can
/// name — ever crossing the seam.
public struct StoreTransactionID: Hashable, Sendable {
    public let rawValue: UInt64
    public init(rawValue: UInt64) { self.rawValue = rawValue }
}

/// What the store handed over: the compact JWS, and the handle that finishes it.
///
/// The JWS is carried as the store produced it and is submitted byte for byte.
/// It is transaction material, so it is never logged, never rendered and never
/// put in an error value.
public struct SignedStoreTransaction: Equatable, Sendable {
    public let id: StoreTransactionID
    public let jws: String
    public let renewalJWS: String

    public init(id: StoreTransactionID, jws: String, renewalJWS: String = "") {
        self.id = id
        self.jws = jws
        self.renewalJWS = renewalJWS
    }
}

/// The three ends a purchase attempt can reach.
///
/// Two of them carry nothing, and that is the point: a cancelled or a pending
/// purchase has produced no transaction, so there is nothing to submit and — the
/// half that matters — nothing that could be finished.
public enum StorePurchaseOutcome: Equatable, Sendable {
    case delivered(SignedStoreTransaction)
    /// Ask to Buy, or a bank approval. It may become a delivery later, and when
    /// it does it arrives through ``SubscriptionStore/updates()`` like any other.
    case pending
    case userCancelled
}
