#if DEBUG
import Foundation
import RelayiumAppKit

final class UITestSubscriptionStore: SubscriptionStore, @unchecked Sendable {
    func offers(for productIDs: [String]) async throws -> [SubscriptionOffer] {
        productIDs.compactMap { id in
            switch id {
            case UITestAccountTransport.monthlyProductID:
                return SubscriptionOffer(id: id, displayName: "Relayium Pro", // nonlocalized: deterministic UI-test StoreKit fixture
                                         description: "Monthly", displayPrice: "US$4.99") // nonlocalized: deterministic UI-test StoreKit fixture
            case UITestAccountTransport.yearlyProductID:
                return SubscriptionOffer(id: id, displayName: "Relayium Pro", // nonlocalized: deterministic UI-test StoreKit fixture
                                         description: "Yearly", displayPrice: "US$49.99") // nonlocalized: deterministic UI-test StoreKit fixture
            default: return nil
            }
        }
    }

    func purchase(productID: String, appAccountToken: UUID) async throws -> StorePurchaseOutcome {
        .delivered(SignedStoreTransaction(
            id: StoreTransactionID(rawValue: 9_002),
            jws: "eyJhbGciOiJFUzI1NiJ9.eyJ1aSI6Mn0.sig"))
    }

    func currentEntitlements() async -> [SignedStoreTransaction] { [] }
    func updates() -> AsyncStream<SignedStoreTransaction> { AsyncStream { _ in } }
    func synchronize() async throws {}
    func finish(_ id: StoreTransactionID) async {}
}
#endif
