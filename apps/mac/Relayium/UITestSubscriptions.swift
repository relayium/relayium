#if DEBUG
import Foundation
import RelayiumAppKit

/// A store with no store behind it, for acceptance launches only.
///
/// **The whole file is inside `#if DEBUG`,** like `UITestMode` and for the same
/// reason: a shipped binary must contain neither this type nor the identifiers
/// it answers about. It imports no StoreKit — it does not need to, because
/// `SubscriptionStore` is expressed in plain values, which is exactly what that
/// seam exists for.
///
/// What it makes reachable that nothing else can: the purchase surface's own
/// states. A real store needs a signed build, a sandbox Apple ID, an App Store
/// Connect product and a network; behind this fake, the offers list, the price
/// rows, the busy states, the acceptance and the refusal are all driven by
/// production code — the model, the copy layer and the real `AccountClient` over
/// the in-process transport — in a launch that reaches nothing outside itself.
///
/// It deliberately does NOT model a refund, a renewal or an Ask-to-Buy
/// approval. Those arrive through the update stream and are covered by the
/// package's own tests against a far more capable fake; repeating them here
/// would be a second, weaker copy of a covered claim.
final class UITestSubscriptionStore: SubscriptionStore, @unchecked Sendable {
    /// Answers for exactly the two identifiers the fixture's catalog names, and
    /// for nothing else — so a build that asked about something the server did
    /// not name would render an empty list rather than an invented product.
    func offers(for productIDs: [String]) async throws -> [SubscriptionOffer] {
        productIDs.compactMap { id in
            switch id {
            case UITestAccountTransport.monthlyProductID:
                // nonlocalized: an acceptance fixture price, absent from Release
                return SubscriptionOffer(id: id, displayName: "Relayium Pro",
                                         description: "Monthly", displayPrice: "US$4.99")
            case UITestAccountTransport.yearlyProductID:
                // nonlocalized: an acceptance fixture price, absent from Release
                return SubscriptionOffer(id: id, displayName: "Relayium Pro",
                                         description: "Yearly", displayPrice: "US$49.99")
            default:
                return nil
            }
        }
    }

    /// A delivered purchase. The JWS is a shaped literal and is submitted to the
    /// fixture transport byte for byte, so the model's real submit-then-finish
    /// path runs.
    func purchase(productID: String, appAccountToken: UUID) async throws -> StorePurchaseOutcome {
        // nonlocalized: an acceptance fixture, not a real transaction
        .delivered(SignedStoreTransaction(id: StoreTransactionID(rawValue: 9_001),
                                          jws: "eyJhbGciOiJFUzI1NiJ9.eyJ1aSI6MX0.sig"))
    }

    func currentEntitlements() async -> [SignedStoreTransaction] { [] }

    /// An empty stream that never finishes, matching what a real adapter hands
    /// back: the model's drain task holds it for the life of the process.
    func updates() -> AsyncStream<SignedStoreTransaction> {
        AsyncStream { _ in }
    }

    func synchronize() async throws {}

    func finish(_ id: StoreTransactionID) async {}
}
#endif
