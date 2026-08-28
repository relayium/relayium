import Foundation

/// Mint the attribution token for **one** purchase sheet, at the moment the
/// store is ready to open it.
///
/// The adapter still cannot choose this value: it is minted by Relayium's
/// server for the authenticated account, and a store layer that could supply
/// its own would be able to attribute a purchase to an account nobody proved
/// they hold. What a callback changes is only *when* it is asked for.
///
/// **Why a callback rather than a parameter.** Obtaining the token costs an
/// authenticated round trip that arms exactly one sheet on Relayium's server,
/// and once that arm exists every later failure is ambiguous about money: a
/// throw out of StoreKit says nothing about whether Apple charged, so it locks
/// the attempt rather than releasing it. But the adapter's own product lookup
/// is a call to Apple that fails routinely and *provably without charging* —
/// an identifier this storefront does not carry, a device with no network —
/// and as a plain parameter the token sat on the wrong side of that line: it
/// had already been minted, so a lookup failure locked the account out of
/// buying anything at all. Asking through a callback puts every provably
/// pre-sheet failure before the arm, and leaves no adapter-owned prerequisite
/// between the arm and StoreKit's own purchase call.
///
/// **That is not a claim that nothing after the arm can fail.**
/// `Product.purchase` is deliberately fallible and its failures are ambiguous
/// about money — StoreKit may throw with a charge already made — so everything
/// on that side of the callback still locks the attempt. What the callback
/// moves is only the provably-harmless work, so a routine lookup failure stops
/// being paid for with a permanent lockout.
///
/// **Calling this more than once does not produce a second token, ever.** The
/// value it returns is permission to open one sheet, and permission is what
/// costs money — Apple attributes a purchase by `appAccountToken` but does not
/// deduplicate by it, so two sheets carrying one token are two purchases it may
/// charge for, against a single arm the app can report only one outcome for. A
/// repeat call is therefore refused rather than answered from the arm that
/// already exists.
///
/// Throwing refuses the purchase: the adapter propagates the error and opens
/// no sheet.
public typealias StorePurchaseAuthorization = @Sendable () async throws -> UUID

/// Why the app refused to authorize a sheet the store was about to open.
///
/// **Nothing above the seam reads this to decide whether an arm exists.** The
/// app knows that from its own state; an error's type is chosen by the adapter,
/// can be wrapped by anything in between, and a fake could throw the same value
/// on either side of the arm. This exists so an adapter has something typed to
/// propagate and a test has something to name — so it carries no server
/// vocabulary and no transaction material.
public enum StorePurchaseAuthorizationRefused: Error, Equatable {
    /// There is no purchase attempt waiting for this authorization: it was
    /// never started, or it has already finished and the callback was retained
    /// past it. Nothing is armed, and nothing may be.
    case notAwaiting
    /// A second authorization was requested while the first was still being
    /// arranged. One sheet gets one dispatch, and one token.
    case alreadyInFlight
    /// This attempt has already been given its token. **No second one exists,
    /// and none is minted.**
    ///
    /// The token is attribution, not an idempotency key: Apple does not
    /// deduplicate purchases by `appAccountToken`, so handing the same value
    /// back a second time would be handing out a second permission to charge,
    /// against a single arm the app can only ever report one outcome for.
    case alreadyAuthorized
    /// The app refused, and has already recorded why. The reason stays above
    /// this seam rather than being encoded into an error the store could act on.
    case refused
}

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

    /// Buy one product, attributed to the token `authorize` mints.
    ///
    /// **The ordering is the contract, not an implementation detail.** An
    /// implementation must do everything that can fail without charging
    /// anybody — resolving the product, above all — BEFORE it calls
    /// `authorize`, and must invoke the store's own purchase path as the
    /// immediate next step after `authorize` returns, with no fallible
    /// prerequisite of its own left in between. Reaching that path may still
    /// suspend — the macOS adapter hops to MainActor and asks for a
    /// confirmation window — and that is allowed exactly because neither hop
    /// can throw and a missing window has a defined fallback rather than a
    /// failure. What may not remain on that side of the line is anything that
    /// can fail. The charge itself may of course throw; that failure is
    /// ambiguous about money and locks the attempt, which is exactly why
    /// nothing avoidable may join it there.
    /// ``StoreKitSubscriptionStore/resolveAuthorizeThenPurchase(resolve:unresolved:authorize:charge:)``
    /// is where the production path states that shape once, and
    /// `StoreKitLinkageTests` reads this file and the adapter's to check it is
    /// still the shape shipped.
    ///
    /// An implementation that never calls `authorize` has no attribution and
    /// must not open a sheet. If one does anyway, the caller still submits
    /// whatever transaction comes back — that money is real — but reports no
    /// purchase outcome, because there is no arm for an outcome to belong to.
    ///
    /// An implementation must call `authorize` exactly once. A second call is
    /// refused rather than answered, because the token is attribution and not
    /// an idempotency key: reusing it would give this call two sheets Apple may
    /// each charge for, and the caller one arm to report. If an implementation
    /// asks twice anyway, that refusal is ambiguous about money like any other
    /// post-authorization failure, and the attempt locks.
    func purchase(productID: String,
                  authorize: @escaping StorePurchaseAuthorization) async throws -> StorePurchaseOutcome

    /// Everything this Apple ID currently owns for this app, as signed
    /// transactions. The restore path's input.
    func currentEntitlements() async -> [SignedStoreTransaction]

    /// Transactions StoreKit still considers unfinished.
    ///
    /// This is a launch-recovery surface, not another entitlement oracle. The
    /// model submits every delivery to Relayium's server and finishes only a
    /// server-accepted transaction, exactly as it does for purchases, restores,
    /// and live updates.
    func unfinishedTransactions() async -> [SignedStoreTransaction]

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

public extension SubscriptionStore {
    /// Existing non-StoreKit adapters have no persistent transaction queue.
    /// The real adapter overrides this with `Transaction.unfinished`.
    func unfinishedTransactions() async -> [SignedStoreTransaction] { [] }
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
