import Foundation
import RelayiumAppKit
#if os(macOS)
import AppKit
#endif
// **The only `import StoreKit` in this repository, and the only one there may
// be.** `StoreKitBoundaryTests` reads every Swift source under `apps/` and fails
// if the framework is named anywhere outside this target, and it reads both
// Xcode projects and fails if any app target links this product. That is what
// makes the isolation a property of the build rather than of a convention.
import StoreKit

/// The real StoreKit 2 implementation of ``SubscriptionStore``.
///
/// ## Why it is a target of its own
///
/// Linking StoreKit into an app is not free of consequence: it is the framework
/// the App Store's own review tooling and the system's purchase machinery watch
/// for, and an app that links it is an app that claims to sell something. This
/// the App Store targets link this product while direct-distribution targets do
/// not. Product identifiers still arrive from Relayium's authenticated server
/// catalog; the adapter compiles none into a shipping binary.
///
/// ## What it deliberately does not decide
///
/// **Verification.** `VerificationResult` is passed through in both forms, and
/// an `.unverified` result is delivered exactly like a verified one. That is not
/// laxity, it is where the decision belongs: the device's verdict runs on the
/// device, and the server re-verifies the same JWS against trust roots it was
/// configured with before granting anything. Dropping unverified results here
/// would discard purchases for the most ordinary reason local verification fails
/// — a device whose clock is wrong — and would buy nothing, since a forged JWS
/// is refused by the server anyway and simply never gets finished.
///
/// **Anything about entitlements.** Nothing in this file reads a product's
/// price, tier or period to decide what a user may do. It converts store objects
/// into a string and an id, and finishes exactly the transaction it is told to.
///
/// ## Lifecycle
///
/// The actor retains the opaque `Transaction` values behind their ids, because
/// `finish()` can only be called on the object itself and the id is all that
/// crosses the seam. The table only ever grows by delivery and is read by
/// `finish`, so the thing it holds is bounded by what the store actually handed
/// over in this process.
public actor StoreKitSubscriptionStore: SubscriptionStore {
    public enum StoreKitStoreError: Error, Equatable {
        /// The store does not know this identifier — it is missing from App
        /// Store Connect, not approved for sale, or unavailable in this
        /// storefront.
        case productUnavailable
        /// A `Product.PurchaseResult` case that did not exist when this was
        /// written. Refused rather than guessed: the two existing non-delivery
        /// cases both mean "nothing was bought", and assuming that of an unknown
        /// one is how a real purchase gets dropped.
        case unknownPurchaseResult
    }

    /// Delivered transactions, by the id that crosses the seam.
    ///
    /// `Transaction.id` is the store's own identity for one transaction, so a
    /// redelivery of the same transaction replaces its own entry rather than
    /// accumulating a second one — and `finish(_:)` addresses exactly the object
    /// the id was minted from.
    private var delivered: [UInt64: Transaction] = [:]

#if os(macOS)
    public typealias PurchaseWindowProvider = @MainActor @Sendable () -> NSWindow?
    nonisolated private let purchaseWindow: PurchaseWindowProvider

    public init(purchaseWindow: @escaping PurchaseWindowProvider = { nil }) {
        self.purchaseWindow = purchaseWindow
    }
#else
    public init() {}
#endif

    // MARK: - catalog

    public func offers(for productIDs: [String]) async throws -> [SubscriptionOffer] {
        let products = try await Product.products(for: productIDs)
        // Auto-renewable subscriptions only. Relayium sells nothing else through
        // the App Store, and a consumable or non-consumable reaching the
        // purchase path would be a product the server's plan catalog has no row
        // for — a charge with no tier to grant.
        return products
            .filter { $0.type == .autoRenewable }
            .map {
                SubscriptionOffer(id: $0.id,
                                  displayName: $0.displayName,
                                  description: $0.description,
                                  // The store's own formatting for the user's
                                  // storefront. Never recomputed here.
                                  displayPrice: $0.displayPrice)
            }
    }

    // MARK: - buying

    public func purchase(productID: String,
                         appAccountToken: UUID) async throws -> StorePurchaseOutcome {
        guard let product = try await Product.products(for: [productID]).first else {
            throw StoreKitStoreError.productUnavailable
        }
        // The attribution token is the ONLY option passed. It is the value
        // Relayium's server minted for the authenticated account, and it is what
        // the server later reads out of Apple's signed payload to decide whose
        // purchase this is.
        let options: Set<Product.PurchaseOption> = [.appAccountToken(appAccountToken)]
#if os(macOS)
        let result = try await purchase(product: product, options: options)
#else
        let result = try await product.purchase(options: options)
#endif
        switch result {
        case .success(let verification):
            return .delivered(await record(verification))
        case .userCancelled:
            return .userCancelled
        case .pending:
            return .pending
        @unknown default:
            throw StoreKitStoreError.unknownPurchaseResult
        }
    }

#if os(macOS)
    /// Keep the non-Sendable AppKit window entirely on MainActor. StoreKit's
    /// window-bound overload arrived in macOS 15.2; Relayium's macOS 13–15.1
    /// users retain the API their systems provide. A missing window falls back
    /// rather than throwing after the server has already armed the purchase.
    @MainActor
    private func purchase(
        product: Product,
        options: Set<Product.PurchaseOption>
    ) async throws -> Product.PurchaseResult {
        if #available(macOS 15.2, *), let window = purchaseWindow() {
            return try await product.purchase(confirmIn: window, options: options)
        }
        return try await product.purchase(options: options)
    }
#endif

    // MARK: - restoring and ongoing deliveries

    public func currentEntitlements() async -> [SignedStoreTransaction] {
        var out: [SignedStoreTransaction] = []
        for await verification in Transaction.currentEntitlements {
            out.append(await record(verification))
        }
        return out
    }

    public func unfinishedTransactions() async -> [SignedStoreTransaction] {
        var out: [SignedStoreTransaction] = []
        for await verification in Transaction.unfinished {
            out.append(await record(verification))
        }
        return out
    }

    /// A fresh stream per call, each backed by its own drain of
    /// `Transaction.updates`.
    ///
    /// `onTermination` cancels that drain. It is what makes the model's
    /// `stop()` — and its `deinit` — actually release the store subscription
    /// rather than leaving a task reading `Transaction.updates` forever with
    /// nowhere to yield to.
    public nonisolated func updates() -> AsyncStream<SignedStoreTransaction> {
        AsyncStream { continuation in
            let drain = Task {
                for await verification in Transaction.updates {
                    if Task.isCancelled { break }
                    continuation.yield(await self.record(verification))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in drain.cancel() }
        }
    }

    public func synchronize() async throws {
        try await AppStore.sync()
    }

    // MARK: - finishing

    /// Finish exactly the delivered transaction this id names, or nothing.
    ///
    /// An id that was never delivered here is a no-op rather than a lookup in
    /// some broader set: the caller's whole guarantee is that it finishes the
    /// transaction it submitted, and resolving an unknown id against the store
    /// at large would break that.
    public func finish(_ id: StoreTransactionID) async {
        guard let transaction = delivered[id.rawValue] else { return }
        await transaction.finish()
        // Dropped only after the store has been told. The table exists to answer
        // `finish`, and a finished transaction has no second answer to give.
        delivered.removeValue(forKey: id.rawValue)
    }

    // MARK: - crossing the seam

    /// Retain the opaque transaction and hand back the two values above this
    /// layer are allowed to see.
    ///
    /// `jwsRepresentation` comes off the `VerificationResult`, not off the
    /// unwrapped payload, because it is the compact JWS Apple signed — the
    /// bytes the server must check. Re-encoding the decoded transaction would
    /// produce a document with no signature over it.
    private func record(_ verification: VerificationResult<Transaction>) async -> SignedStoreTransaction {
        let transaction = verification.unsafePayloadValue
        delivered[transaction.id] = transaction
        let renewalJWS = await renewalInfoJWS(for: transaction)
        return SignedStoreTransaction(id: StoreTransactionID(rawValue: transaction.id),
                                      jws: verification.jwsRepresentation,
                                      renewalJWS: renewalJWS)
    }

    private func renewalInfoJWS(for transaction: Transaction) async -> String {
        do {
            guard let product = try await Product.products(for: [transaction.productID]).first,
                  let info = product.subscription else { return "" }
            for status in try await info.status where
                status.transaction.unsafePayloadValue.originalID == transaction.originalID {
                return status.renewalInfo.jwsRepresentation
            }
        } catch { return "" }
        return ""
    }
}
