import Foundation
// @preconcurrency for the same reason `AccountSession` needs it: RelayiumKit
// predates strict concurrency and marks nothing Sendable, and this type hands
// its billing service to work that runs across suspension points.
@preconcurrency import RelayiumKit

/// Why an in-app purchase did not end in an entitlement.
///
/// It carries a TYPED value rather than a rendered sentence, deliberately. This
/// batch ships no purchase surface and no copy, and inventing nine strings for a
/// screen that does not exist is how a catalog acquires wording nobody ever read
/// against a real failure. The layer that makes this reachable owns the copy;
/// what belongs here is the distinction it will need to write it.
public enum AppleSubscriptionFailure: Equatable {
    /// Relayium's server answered, and the answer was a refusal — or the
    /// exchange with it never completed.
    case billing(AppleBillingError)
    /// The store's own catalog, purchase or reconcile call failed, or the
    /// billing service raised something this layer has no case for.
    ///
    /// Carries the error's TYPE name and nothing else. A StoreKit error's
    /// message is not ours to show, and its associated values can name a
    /// product, an account or a receipt.
    case unexpected(type: String)
    /// The server says this account may not start an App Store purchase, because
    /// something else already pays for its entitlement.
    ///
    /// Not a `billing` case, because nothing was refused — the refusal happened
    /// here, before any request, from an answer the catalog read already
    /// carried. `blockedBy` is the server's own vocabulary (`"stripe"`,
    /// `"admin"`, `"multiple"`), and `""` means the eligibility answer is
    /// unknown, which is treated as "no" rather than as "yes".
    case purchaseNotAllowed(blockedBy: String)
    /// The offer on screen no longer matches the server's catalog. Found by the
    /// fresh read every purchase makes immediately before the sale: the product
    /// was retired, the mapping behind its identifier changed, or the server
    /// answered for a different app entirely.
    ///
    /// Truthful about both halves: nothing was charged — no account token was
    /// fetched and the store was never asked — and nothing on screen can be
    /// retried as-is, because what the screen shows is no longer what the
    /// server sells. The repair is to reload the offers.
    case selectionChanged
    /// The server has closed its global App Store purchase gate. Nobody may
    /// start a new purchase against this deployment right now.
    ///
    /// Its own case rather than a `purchaseNotAllowed` with some new
    /// `blockedBy` value, because it is not a statement about this account at
    /// all: nothing owns this user's entitlement, nothing is double-billed, and
    /// there is nothing for them to cancel anywhere. Folding it into that case
    /// would put "your subscription is managed elsewhere" in front of somebody
    /// whose subscription is managed nowhere.
    ///
    /// Nothing was charged — the gate is re-read before the store is ever asked
    /// — and it is temporary by construction: the operator reopens the gate and
    /// the next load offers the same products again.
    case purchasesPaused
}

/// What Relayium's server made of one submitted transaction.
///
/// This type exists to make the finish policy a property of a value rather than
/// of a control-flow path somebody has to re-derive at each call site. There is
/// exactly one place that decides whether a transaction may be finished, and it
/// is ``permitsFinish`` below.
public enum AppleSubmission: Equatable {
    /// A decoded 200. The server has durably recorded this exact JWS, or
    /// idempotently converged on a state that already accounts for it — that is
    /// what `applied: false` means, and it is still an acceptance.
    case accepted(AppleTransactionResult)
    case refused(AppleSubscriptionFailure)

    /// **The only condition under which a store transaction may be finished.**
    ///
    /// Finishing tells the store to stop redelivering a transaction. That
    /// redelivery is the *only* automatic path by which a purchase somebody has
    /// already paid for can reach their Relayium account after something went
    /// wrong, and it is not recoverable from the app: nothing on the device can
    /// re-mint a JWS the store has been told to forget.
    ///
    /// So the rule is asymmetric on purpose. A decoded 200 is proof; everything
    /// else is not, including the refusals that look permanent:
    ///
    ///  * **transport failure** — the server may have applied it and the answer
    ///    been lost on the way back, or it may never have arrived;
    ///  * **an undecodable 200** — something answered, and it is not known what;
    ///  * **400 `invalid_transaction`** — includes a product this deployment has
    ///    no mapping for. A mapping is a row in the server's own catalog, and
    ///    adding it is exactly the repair that should make the next redelivery
    ///    land;
    ///  * **401** — the session expired mid-purchase. Signing back in repairs it;
    ///  * **403 `token_mismatch`** — the purchase belongs to another Relayium
    ///    account. Signing in as that account repairs it, and finishing here
    ///    would destroy the transaction that account is waiting for;
    ///  * **409 `subscription_owned`** — one App Store subscription, one
    ///    Relayium account. Ownership is server state, and server state can be
    ///    corrected;
    ///  * **409 `apple_subscription_conflict`** — this Relayium account already
    ///    has another live Apple subscription. The new transaction must remain
    ///    available while the paid conflict is resolved;
    ///  * **429**, **500** — try again later, by definition;
    ///  * **503 `verifier_unavailable`** — this deployment cannot verify
    ///    anything yet. It is the shipping default TODAY, so finishing on it
    ///    would silently discard every purchase made before the trust roots are
    ///    configured;
    ///  * **any other non-200** — the case where the least is known.
    ///
    /// The cost of being wrong in the other direction is a transaction the store
    /// keeps re-offering, which is visible, harmless, and self-correcting the
    /// moment a submission is accepted.
    ///
    /// ## The two independent reasons a 200 permits a finish
    ///
    /// `applied` and `dispatchResolved` answer **different questions**, and the
    /// rule is their disjunction rather than their conjunction:
    ///
    ///  * `applied` says *this exact JWS was durably recorded by this call*;
    ///  * `dispatchResolved` says *the purchase attempt this transaction belongs
    ///    to has reached a settled state on the server* — the fact is accounted
    ///    for, whether or not this particular call is what recorded it.
    ///
    /// **The previous rule required `applied`, and that was wrong.** After the
    /// cancellation-recovery batch the server answers the real, ordinary triplet
    /// `applied=false, dispatchPending=false, dispatchResolved=true` when it
    /// converges on a transaction it has **already** accounted for — a
    /// redelivery of something a previous submission recorded. Requiring
    /// `applied` made that a permanent non-finish: the store would redeliver the
    /// same transaction forever, and every redelivery would receive the same
    /// answer. A transaction the server says is resolved is exactly the one that
    /// no longer needs redelivering.
    ///
    /// **`dispatchPending && !dispatchResolved` is the one shape that must never
    /// finish, and `applied` does not rescue it.** A dispatch still pending and
    /// not yet resolved means an arm may still be open — the server has not
    /// settled whose purchase this is or whether another sheet can still charge.
    /// Finishing there discards the redelivery that reconciliation depends on,
    /// so it is refused even when this call recorded the JWS.
    public var permitsFinish: Bool {
        if case .accepted(let result) = self {
            return result.dispatchResolved || (result.applied && !result.dispatchPending)
        }
        return false
    }
}

/// One thing the purchase surface can offer: the server's half and the store's
/// half of the same product, joined.
///
/// **Neither half is sufficient and neither may be substituted for the other.**
/// Which Relayium tier a product grants, and what that tier is called, is the
/// server's answer — a device that decided it could grant itself anything. What
/// it costs, in the currency and formatting of the storefront the user is
/// actually in, is Apple's answer, and re-deriving it here would put a price on
/// screen that Apple never agreed to.
public struct AppleSubscriptionOffer: Equatable, Identifiable, Sendable {
    /// The server's row: plan id, plan name, billing cycle, tier rank.
    public let product: AppleCatalogProduct
    /// The store's own localized product: display name, description, price.
    public let store: SubscriptionOffer

    /// The App Store product identifier, which both halves agree on — it is
    /// what the catalog was asked for and what the store answered about.
    public var id: String { product.productId }

    public init(product: AppleCatalogProduct, store: SubscriptionOffer) {
        self.product = product
        self.store = store
    }
}

/// What the purchase surface is showing.
public enum AppleSubscriptionState: Equatable {
    /// This build has nothing to sell: the server's catalog holds no live
    /// mapping for this bundle, or the store recognised none of the identifiers
    /// it does hold. Distinct from a failure — nothing went wrong, there is
    /// simply nothing on sale — and the state in which no purchase call is
    /// possible.
    case unavailable
    /// The server is not selling to ANYBODY right now — an operator has closed
    /// the global purchase gate. Distinct from `.unavailable`, which says this
    /// deployment has nothing mapped for this build: that is a standing fact
    /// about the catalog, this is a temporary one about the server, and the two
    /// warrant different sentences. Also distinct from `.failed`: nothing went
    /// wrong and nothing needs retrying.
    ///
    /// **Restoring stays reachable in this state**, which is the whole reason
    /// it is a state of the SURFACE rather than a reason offers are missing: a
    /// user whose purchase is stuck is exactly who reaches for restore, and a
    /// pause on new sales must not take that away from somebody who has already
    /// paid.
    case purchasesPaused
    case idle
    case loadingOffers
    case purchasing(productID: String)
    /// The store delivered a transaction and the server is deciding. Nothing has
    /// been finished at this point, and nothing will be unless it answers 200.
    case submitting
    case restoring
    /// Ask to Buy, or a bank approval. No transaction exists yet, so nothing was
    /// submitted and nothing was finished. If it is approved it arrives through
    /// the update stream like any other delivery.
    case deferred
    /// A restore found nothing this Apple ID owns for this app. Distinct from a
    /// failure: nothing went wrong, there is simply nothing to restore.
    case nothingToRestore
    /// The server accepted a transaction and reported this entitlement. It is
    /// still not what grants access — see the type's note on authority.
    case completed(AppleTransactionResult)
    case failed(AppleSubscriptionFailure)
}

/// Whether a host may use the pre-continuation one-shot purchase protocol.
///
/// Released App Store builds require durable continuation. The legacy mode is
/// retained only for explicit compatibility fixtures and older hosts; it must
/// never be selected because a production keychain happened to be unavailable.
public enum ApplePurchaseDispatchPolicy: Equatable, Sendable {
    case legacyOneShot
    case durableContinuationRequired
}

/// The whole in-app purchase flow: offers, buying, restoring, and the ongoing
/// deliveries the store makes on its own.
///
/// ## What grants access
///
/// Nothing here. Not a `Product.PurchaseResult`, not a verified StoreKit
/// transaction, not `currentEntitlements`. A device is the thing being
/// authenticated, not the thing being trusted, and every local signal about a
/// purchase is produced on it. The entitlement comes from Relayium's server
/// verifying Apple's signature against trust roots the server was configured
/// with, resolving the account from a token the server itself minted, and
/// mapping the product through the server's own catalog. This model's job is to
/// carry a JWS to that endpoint and then ask the EXISTING session to reload —
/// `AccountSession.refresh()`, through the injected action below. What the user
/// sees is `/api/me`'s answer, exactly as it is today.
///
/// ## What it does not own
///
/// It holds no bearer, no user and no usage. It is given two closures: one that
/// reads the current bearer at the moment of use, and one that runs the refresh
/// the session already owns. A second copy of any of that state is a second
/// thing to invalidate on sign-out, and this type would be the one that got it
/// wrong — it is the only object here that keeps running while nobody is
/// looking at it.
///
/// ## Lifecycle
///
/// `startObservingUpdates()` claims one task; `stop()` cancels it and is called
/// from `deinit` as well, so no drain outlives the model. Every entry point
/// claims an operation generation, so a purchase that lands after a sign-out —
/// or after a second purchase started — writes no STATE.
///
/// It does not follow that a superseded operation does nothing. Supersession
/// governs the screen, and exactly one effect is exempt from it: the refresh
/// owed by a transaction that has been accepted and therefore already finished.
/// See ``refreshAfterAcceptance()``, which is where that asymmetry is argued.
@MainActor
public final class AppleSubscriptionModel: ObservableObject {
    @Published public private(set) var state: AppleSubscriptionState = .idle
    /// What may be offered: the server's live catalog joined to what the store
    /// actually knows about, in the order the deployment ranks its tiers. Empty
    /// until `loadOffers()` succeeds.
    @Published public private(set) var offers: [AppleSubscriptionOffer] = []
    /// Whether this account may start a purchase at all, as the SERVER decided.
    /// `nil` until a catalog has been read: unknown is not permission, and every
    /// purchase path re-checks it rather than trusting an optimistic default.
    @Published public private(set) var eligibility: AppleCatalogPurchase?

    /// The bundle identity this build ships as, sent with every catalog read.
    ///
    /// It replaces the compiled-in product list this type used to take. That is
    /// the whole point: product identifiers are the server's to state, and a
    /// binary carrying its own could be shipped pointing at a product no row
    /// maps — a failure that lands after the customer has been charged.
    private let bundleID: String
    private let store: SubscriptionStore
    private let billing: AppleBillingService
    /// The session's bearer, read at the moment of use. Never cached: a token
    /// captured at the start of a purchase can be revoked before the store
    /// finishes with the user.
    private let bearer: @MainActor () -> String?
    private let accountID: @MainActor () -> String?
    /// `AccountSession.refresh()`, injected rather than reimplemented. It is
    /// what makes the server's answer — not this model's — what the app renders.
    private let refreshAccount: @MainActor () async -> Void
    private let purchaseDispatchPolicy: ApplePurchaseDispatchPolicy

    /// Where this device's purchase-continuation capability is kept, and `nil`
    /// when this build has none.
    ///
    /// **`nil` is the LEGACY client, exactly and only.** It sends no capability
    /// fields and gets one dispatch per authority generation — byte-for-byte the
    /// behaviour of every released build, **including that build's defect**: it
    /// has no way to report an outcome, so a cancelled sheet is never released
    /// and the account can never buy again. `Transaction.updates` and `restore`
    /// do not repair that; they redeliver signed transactions, and a
    /// cancellation produces none. That deadlock is what the capability exists
    /// to remove.
    ///
    /// It is not a fallback this model may choose when something fails; it is
    /// the shape of a host that cannot store a secret at all.
    private let continuation: ApplePurchaseCapabilityRepository?
    private let outcomeJournal: ApplePurchaseOutcomeJournal?
    /// This installation's stable app-instance identity. Read once, because the
    /// server stores it verbatim and a second value would be a second instance.
    private let appInstanceID: String?

    private var updateTask: Task<Void, Never>?
    /// Serializes launch/sign-in recovery sweeps. SwiftUI restores the Relayium
    /// session and starts StoreKit observation in independent tasks, so both may
    /// request the same durable queue as an account becomes ready. One sweep is
    /// sufficient; a transaction refused by the server remains unfinished and
    /// is eligible for the next explicit sweep or StoreKit update.
    private var unfinishedSweepInProgress = false
    private var generation = 0
    /// Exactly one foreground purchase operation may own StoreKit at a time.
    /// Operation generations protect UI writes; they are not a mutex and must
    /// never be used to abandon a server arm merely because a catalog refresh
    /// became the newest screen operation.
    private var purchaseInProgress = false
    /// The one in-flight authorization, and **the only place the answer to "has
    /// the server armed a sheet for this attempt?" is kept.**
    ///
    /// MainActor state, deliberately, because after `store.purchase` throws the
    /// model has to decide whether an arm is open and owes an outcome. An
    /// adapter's error type cannot answer that: the adapter chooses it, anything
    /// between here and StoreKit can wrap it, and a fake could throw the same
    /// value on either side of the arm. This is written by this object, on this
    /// actor, at the instant the server answered.
    private var authorization: PurchaseAuthorization?
    /// Names each authorization, so a write that follows a suspension can never
    /// land on a value that has since been replaced or cleared.
    private var authorizationSeq = 0

    public init(store: SubscriptionStore,
                billing: AppleBillingService,
                bundleID: String,
                bearer: @escaping @MainActor () -> String?,
                accountID: @escaping @MainActor () -> String? = { nil },
                refreshAccount: @escaping @MainActor () async -> Void,
                continuation: ApplePurchaseCapabilityRepository? = nil,
                outcomeJournal: ApplePurchaseOutcomeJournal? = nil,
                appInstanceID: String? = nil,
                purchaseDispatchPolicy: ApplePurchaseDispatchPolicy = .legacyOneShot) {
        self.store = store
        self.billing = billing
        self.bundleID = bundleID
        self.bearer = bearer
        self.accountID = accountID
        self.refreshAccount = refreshAccount
        self.purchaseDispatchPolicy = purchaseDispatchPolicy
        // Both halves or neither. An instance id with nowhere to keep the secret
        // would send new-protocol requests it could never report the outcome of,
        // which is strictly worse than being a legacy client: it arms a sheet and
        // then deadlocks the account.
        if let continuation, let outcomeJournal, let appInstanceID,
           ApplePurchaseIdentity.isValid(appInstanceID) {
            self.continuation = continuation
            self.outcomeJournal = outcomeJournal
            self.appInstanceID = appInstanceID
        } else {
            self.continuation = nil
            self.outcomeJournal = nil
            self.appInstanceID = nil
        }
    }

    deinit {
        // `Task.cancel()` is safe from any isolation, and this is the only thing
        // that stops an adapter's underlying `Transaction.updates` subscription
        // when the model goes away without an explicit `stop()`.
        updateTask?.cancel()
    }

    /// Whether anything is currently on sale. False before the first successful
    /// load, and false in a deployment whose catalog holds no live mapping for
    /// this bundle.
    public var hasOffers: Bool { !offers.isEmpty }

    // MARK: - offers

    /// Load what may be sold: the server's live catalog, then the store's own
    /// localized products for exactly the identifiers it named.
    ///
    /// **The order is not interchangeable.** The catalog decides which
    /// identifiers exist; the store is asked about those and nothing else. A
    /// store queried first would have to be asked about a hard-coded list, which
    /// is the arrangement this method exists to remove.
    ///
    /// Signed out it asks nothing of either. The catalog read is authenticated —
    /// it reports what THIS account may buy — so there is no useful answer to
    /// fetch without a credential, and fetching one anyway would put a 401 in
    /// front of somebody who is simply not signed in yet.
    public func loadOffers() async {
        // The generation is claimed BEFORE the signed-out arm, not after it. A
        // load that starts while another is in flight has to supersede it either
        // way: without this, a signed-out load would write `.failed` and let the
        // older in-flight one paint offers over it afterwards.
        let g = begin()
        guard currentBearer() != nil else {
            offers = []
            eligibility = nil
            state = .failed(.billing(.notSignedIn))
            return
        }
        state = .loadingOffers
        do {
            // Re-read at the moment of use, like every other call here: a load
            // can be started and the session ended before it runs.
            guard let token = currentBearer() else {
                guard !superseded(g) else { return }
                offers = []
                eligibility = nil
                state = .failed(.billing(.notSignedIn))
                return
            }
            let catalog = try await billing.appleCatalog(bundleID: bundleID, token: token)
            guard !superseded(g) else { return }
            // Published even when there is nothing to sell: "you cannot buy here
            // because your subscription is managed elsewhere" is the answer a
            // deployment with an empty catalog still owes the user.
            eligibility = catalog.purchase
            // The global gate is read BEFORE the empty-catalog arm, because a
            // paused server answers with an empty catalog and the two mean
            // opposite things to a user: "there is nothing to subscribe to from
            // this app" is a statement about the product, and it is false when
            // the truth is "not right now". A server that sends no gate at all
            // is not paused, so an older deployment keeps the old wording.
            guard !catalog.purchasesArePaused else {
                offers = []
                state = .purchasesPaused
                return
            }
            guard !catalog.products.isEmpty else {
                offers = []
                state = .unavailable
                return
            }
            let loaded = try await store.offers(for: catalog.products.map(\.productId))
            guard !superseded(g) else { return }
            offers = Self.join(catalog: catalog.products, store: loaded)
            // A store that recognised none of the server's identifiers leaves
            // the user in the same place an empty catalog does — nothing to buy
            // — so it is reported the same way rather than as an idle screen
            // with no products on it.
            state = offers.isEmpty ? .unavailable : .idle
        } catch {
            guard !superseded(g) else { return }
            offers = []
            // Deliberately cleared. A stale "you may buy" left over from an
            // earlier load, beside a failure that may itself BE the eligibility
            // answer going missing, is the one combination that could put a live
            // purchase control on a screen whose state is unknown.
            eligibility = nil
            state = .failed(Self.failure(for: error))
        }
    }

    /// Pair each catalog row with the store's product of the same identifier,
    /// **keeping the server's order** and dropping anything the store did not
    /// answer for.
    ///
    /// Dropping is the correct handling of a missing product and not a
    /// degradation: an identifier the store does not know cannot be priced,
    /// cannot be described, and cannot be purchased — it is a row whose App
    /// Store Connect record does not exist yet, or is not yet approved in this
    /// storefront. Rendering it would offer a purchase that fails at the sheet.
    ///
    /// The store's own ordering is discarded on purpose. It answers in whatever
    /// order it likes, while the server's order is the deployment's declared
    /// tier rank — the one a purchase screen should read down.
    private static func join(catalog: [AppleCatalogProduct],
                             store offers: [SubscriptionOffer]) -> [AppleSubscriptionOffer] {
        var byID: [String: SubscriptionOffer] = [:]
        for offer in offers { byID[offer.id] = offer }
        return catalog.compactMap { product in
            byID[product.productId].map { AppleSubscriptionOffer(product: product, store: $0) }
        }
    }

    // MARK: - buying

    /// Buy one of the loaded offers — the EXACT offer the screen displayed,
    /// re-verified against a fresh catalog immediately before the sale.
    ///
    /// The order of the guards is the security-relevant part. The catalog is
    /// re-read and the selection re-checked against it BEFORE the account token
    /// is fetched, and the token BEFORE the store is asked to charge anybody —
    /// so a selection the server no longer sells, a freshly blocked account, a
    /// signed-out user and a server that cannot mint a token all end with no
    /// purchase sheet and no money moved. A purchase started first and
    /// justified afterwards would be a payment with nowhere to land.
    public func purchase(productID: String) async {
        // Only something BOTH the server's catalog and the store answered for.
        // An identifier that was never loaded cannot be priced, cannot be
        // described, and would put a charge behind a product no row maps. The
        // whole displayed offer is kept, not just the identifier: it is what
        // the fresh catalog below is compared against, field for field.
        guard let selected = offers.first(where: { $0.id == productID }) else {
            state = .unavailable
            return
        }
        // The DISPLAYED eligibility answer, as a pre-flight: a screen already
        // known to be blocked is refused without a request. Unknown (nil) is
        // not permission — a failed load clears it. The authoritative re-check
        // is the fresh read below.
        guard eligibility?.allowed == true else {
            state = .failed(.purchaseNotAllowed(blockedBy: eligibility?.blockedBy ?? ""))
            return
        }
        // A production App Store build must be able to persist the capability
        // before it is allowed to arm a purchase. Silently falling back to the
        // legacy one-shot protocol on a locked or unavailable keychain recreates
        // the permanent cancellation deadlock this protocol was added to fix.
        // This guard precedes bearer, catalog, dispatch and StoreKit work: no
        // network authority is consumed and no purchase sheet can open.
        guard purchaseDispatchPolicy == .legacyOneShot ||
                (continuation != nil && appInstanceID != nil && currentAccountID() != nil) else {
            state = .failed(.billing(.continuationRejected))
            return
        }
        // Read both synchronously on MainActor, with no suspension between them.
        // They are one authority snapshot: combining account B with a token
        // captured from account A would bind the durable capability to the wrong
        // Relayium identity.
        guard let token = currentBearer() else {
            // Nothing was asked of the store. A signed-out purchase has no
            // account to attribute to, and StoreKit would happily complete it.
            state = .failed(.billing(.notSignedIn))
            return
        }
        let ownerAccountID = currentAccountID()
        if purchaseDispatchPolicy == .durableContinuationRequired,
           ownerAccountID == nil {
            state = .failed(.billing(.continuationRejected))
            return
        }
        guard !purchaseInProgress else { return }
        purchaseInProgress = true
        defer { purchaseInProgress = false }
        let g = begin()
        state = .purchasing(productID: productID)

        // The catalog, fresh from the server, immediately before anything can
        // be charged. The screen was rendered from a read that may be minutes
        // old, and every fact on it can have changed since: a Stripe
        // subscription started in a browser is exactly the double-billing the
        // eligibility re-check refuses, and a retired or remapped row is a
        // purchase the intake would refuse AFTER the money moved.
        let fresh: AppleProductCatalog
        do {
            fresh = try await billing.appleCatalog(bundleID: bundleID, token: token)
        } catch {
            guard !superseded(g) else { return }
            state = .failed(Self.failure(for: error))
            return
        }
        guard !superseded(g) else { return }
        guard fresh.bundleId == bundleID else {
            // The server resolved a different app identity than this build
            // ships as. Whatever it is selling, it is not what the screen
            // offered.
            state = .failed(.selectionChanged)
            return
        }
        // The global gate, re-read as part of the same fresh catalog and
        // checked BEFORE the row comparison below. This is the race the gate
        // exists to win: the screen was drawn while the server was selling, an
        // operator has closed it since, and the user has just pressed Subscribe.
        // Nothing has been charged at this point — no account token has been
        // fetched and the store has not been asked — and the paused answer is
        // reported as itself rather than as the `.selectionChanged` the empty
        // product list would otherwise produce.
        guard !fresh.purchasesArePaused else {
            state = .failed(.purchasesPaused)
            return
        }
        guard fresh.purchase.allowed else {
            state = .failed(.purchaseNotAllowed(blockedBy: fresh.purchase.blockedBy))
            return
        }
        // The EXACT displayed row must still be in the catalog — every field,
        // not just the identifier. A product whose plan mapping changed would
        // charge for a tier the user never saw beside the price they agreed to,
        // and that now includes the tier's quota: the row on screen states what
        // the plan grants, so a deployment that edited the figure between the
        // render and the sale is selling something the user did not read.
        guard fresh.products.contains(selected.product) else {
            state = .failed(.selectionChanged)
            return
        }

        guard currentBearer() == token,
              ownerAccountID == nil || currentAccountID() == ownerAccountID else {
            state = .failed(.billing(.notSignedIn))
            return
        }

        // **The arm now happens inside the store's own purchase call**, through
        // the authorization callback below. Everything the store must do that
        // can fail without Relayium's server knowing anything — resolving the
        // product with Apple, above all — happens BEFORE that callback runs,
        // and the sheet opens immediately after it returns.
        //
        // A product lookup that fails therefore leaves no dispatch, no
        // capability, and a purchase the same user may simply try again. While
        // the token was a plain parameter that lookup threw AFTER the arm, and
        // a post-arm throw is ambiguous about whether Apple charged, so it
        // locked the account out of buying anything at all.
        authorizationSeq += 1
        let authorizationID = authorizationSeq
        authorization = PurchaseAuthorization(id: authorizationID, productID: productID,
                                              token: token, ownerAccountID: ownerAccountID,
                                              generation: g)
        defer { if authorization?.id == authorizationID { authorization = nil } }

        let outcome: StorePurchaseOutcome
        do {
            outcome = try await store.purchase(
                productID: productID,
                authorize: { [weak self, authorizationID] in
                    // `weak`, because the store holds this for as long as a sheet
                    // a user may leave open: a model that has gone away has no
                    // attempt to arm for.
                    //
                    // **`authorizationID` is captured, not read back.** This
                    // callback authorizes exactly one attempt — the one it was
                    // minted inside — and says so in its own captured state. A
                    // callback that instead asked "what is the current
                    // authorization?" would answer for whichever attempt happened
                    // to be live when the adapter finally ran it, so an adapter
                    // that retained this past its own purchase could hand a
                    // LATER attempt's token to an EARLIER product's sheet, or put
                    // two sheets on one arm. Neither is a hypothetical an
                    // adapter's good behavior may be trusted to exclude.
                    guard let self else { throw StorePurchaseAuthorizationRefused.notAwaiting }
                    return try await self.authorizePurchase(authorizationID)
                })
        } catch {
            let attempt = closeAuthorization(authorizationID)
            // **Whether an arm exists is read from this object's own state,
            // never from the error.** An adapter chooses its error type,
            // anything in between may wrap it, and the same value can be thrown
            // on either side of the arm — so a type test here would be a guess
            // about money. `attempt.armed` was written by this model, on this
            // actor, at the instant the server answered.
            if let refused = attempt?.refusal {
                // This model refused, and the refusing code already did whatever
                // its refusal owed: released the arm it had just created, or
                // wrote the failure state itself. Neither may happen twice, and
                // the error the adapter surfaced for our own refusal is not the
                // reason the screen should show.
                guard !superseded(g) else { return }
                if case .failure(let failure) = refused { state = .failed(failure) }
                return
            }
            if let armed = attempt?.armed {
                // **The store threw after authorization, and that is not a
                // cancellation.** It is reported as `failed`, which locks the
                // attempt: an error says nothing about whether Apple will
                // charge, and re-arming on one is the double-charge path this
                // protocol exists to close.
                //
                // Reported BEFORE the supersession guard, and awaited: a newer
                // purchase must not find this arm still open, and dropping the
                // report because the screen moved on would leave the account
                // deadlocked on an arm nobody will ever resolve.
                await report(.failed, for: armed, token: token)
            }
            // Two shapes reach here with nothing reported, and they differ only
            // in what the NEXT attempt finds:
            //
            //  * nothing armed and nothing in flight — **nothing was ever
            //    dispatched.** The store failed before it asked for
            //    authorization, so there is no arm, no capability and nothing
            //    that could have charged; the same product may simply be chosen
            //    again. This is the whole reason the token became a callback.
            //  * an authorization still in flight when the store answered — a
            //    broken adapter that abandoned its own callback. This attempt
            //    holds no handle to report an arm under, and does not invent
            //    one. When that arm request lands it finds itself no longer
            //    awaited, returns no token and reports nothing at all: it can
            //    prove no token escaped through IT, but not that the arm is
            //    unused, because the persisted capability lets the next purchase
            //    replay this exact arm and become its legitimate waiter. So the
            //    arm is left authoritative — the replaying attempt resolves it
            //    if one exists, and otherwise it stays armed and the next
            //    purchase refuses rather than arming a second sheet.
            guard !superseded(g) else { return }
            state = .failed(Self.failure(for: error))
            return
        }
        let attempt = closeAuthorization(authorizationID)
        // `nil` when the store answered without ever asking for authorization,
        // and also when this model already reported an outcome for the arm and
        // the adapter answered around that refusal. Either way there is no open
        // arm a further outcome could belong to.
        let armed = attempt?.reported == true ? nil : attempt?.armed

        switch outcome {
        case .userCancelled:
            // **The one resumable outcome**, and the only one the server will
            // re-arm on. Reported before the supersession guard for the same
            // reason a thrown error is: this is what releases the dispatch.
            if let armed { await report(.userCancelled, for: armed, token: token) }
            guard !superseded(g) else { return }
            // The whole meaning of cancelling is that nothing happened. No
            // submission, no finish, and no error the user did not cause —
            // unless this model itself refused, in which case its own reason
            // stands rather than the idle screen an adapter answered around it
            // with.
            if let refused = attempt?.refusal {
                if case .failure(let failure) = refused { state = .failed(failure) }
            } else {
                state = .idle
            }
        case .pending:
            // Ask to Buy or a bank approval. It may still become a real charge,
            // so it LOCKS rather than releasing: `pending` is not `cancelled`,
            // and the server is told which one it was.
            if let armed { await report(.pending, for: armed, token: token) }
            guard !superseded(g) else { return }
            if let refused = attempt?.refusal {
                if case .failure(let failure) = refused { state = .failed(failure) }
            } else {
                state = .deferred
            }
        case .delivered(let delivery):
            // Reported only when an arm exists. A store that delivered without
            // ever authorizing has none, so there is no outcome to report and
            // none is invented — but the transaction is signed and that money is
            // real, so it is still submitted below rather than dropped.
            if let armed { await report(.success, for: armed, token: token) }
            guard !superseded(g) else { return }
            state = .submitting
            switch await settle(delivery) {
            case .accepted(let result):
                // NOT guarded on supersession, and this is the one place in this
                // type where that is deliberate. See `refreshAfterAcceptance()`.
                await refreshAfterAcceptance()
                guard !superseded(g) else { return }
                state = .completed(result)
            case .refused(let failure):
                // A refusal finished nothing and changed nothing on the server,
                // so a superseded one owes the screen nothing either.
                guard !superseded(g) else { return }
                state = .failed(failure)
            }
        }
    }

    // MARK: - authorizing exactly one sheet

    /// **Mint the one attribution token this attempt may open a sheet with.**
    ///
    /// Called by the store adapter after it has resolved the product and
    /// immediately before it charges, which is the whole reason the arm moved in
    /// here: everything that can fail without Relayium's server knowing anything
    /// has already happened, and everything after this returns is ambiguous
    /// about money.
    ///
    /// **At-most-once is enforced here rather than trusted to the adapter, and
    /// the thing counted is the token, not the dispatch.** A second call for a
    /// sheet already armed is refused without a token; a second call while the
    /// first is still being arranged is refused; a call after `store.purchase`
    /// has answered is refused. None of them can produce a second arm, and none
    /// of them can produce a second permission to charge against the first.
    ///
    /// Handing the same token back to a repeat caller would look like the safe
    /// answer — one arm, one dispatch — and is not. `appAccountToken` attributes
    /// a purchase to an account; Apple does not treat it as an idempotency key.
    /// Two sheets carrying it are two purchases Apple may charge for, against
    /// one arm this model can report only one outcome for.
    ///
    /// **`callbackID` names the one attempt this call may answer for, and it is
    /// re-checked after every suspension.** The identity is what makes the
    /// preceding paragraph true across attempts rather than only within one:
    /// "the sheet already armed" must mean *this* callback's sheet, and "a call
    /// after `store.purchase` answered" must stay refused even when a different
    /// purchase has since installed an authorization that is perfectly open.
    /// Arming the server suspends, so the attempt can be closed or replaced
    /// while this call is inside it — and past that point no token may escape,
    /// because there is no longer anything that will report an outcome for it.
    /// It also reports nothing: losing its own waiter says nothing about
    /// whether another attempt has replayed and is now waiting on the very
    /// same arm, so the arm is left authoritative rather than released.
    private func authorizePurchase(_ callbackID: Int) async throws -> UUID {
        guard let attempt = authorization,
              attempt.id == callbackID,
              attempt.open else {
            // A callback the adapter retained past the attempt it belonged to —
            // either because nothing is waiting at all, or because what is
            // waiting is somebody ELSE's attempt. Arming for the first would
            // open a sheet nobody would ever report; answering for the second
            // would attribute this product's sheet to that attempt's arm.
            throw StorePurchaseAuthorizationRefused.notAwaiting
        }
        if attempt.armed != nil {
            // **This attempt already spent its one authorization, so it is
            // refused — the token is not handed back.**
            //
            // Answering with the same token would be the cheap-looking mistake
            // here, on the reasoning that one arm can only produce one dispatch.
            // The dispatch is not what costs money. `appAccountToken` is
            // *attribution*: Apple reads it to decide whose purchase this is,
            // and does not deduplicate purchases by it. So a second copy of that
            // token is a second permission to open a sheet, and two sheets are
            // two charges Apple may take — while `store.purchase` returns once
            // and this model reports exactly one outcome for the single arm
            // behind them. The second charge would then be money this attempt
            // has no outcome slot to report: one arm and one `store.purchase`
            // return do not map to two sheets.
            //
            // At-most-once therefore has to mean at most one *token*, not at
            // most one dispatch, and it is enforced here rather than trusted to
            // an adapter that has already demonstrated it asks twice.
            //
            // No release, and nothing reported from here. A sheet may be open on
            // this arm right now, and refusing a second one says nothing about
            // what the first will do. The refusal propagates as a throw out of
            // `store.purchase` like any other post-authorization failure, and
            // `purchase(productID:)` locks the attempt on the ambiguity — the
            // one direction that cannot charge somebody twice.
            guard attempt.refusal == nil else {
                // Already refused for a reason this model recorded and owes the
                // screen; that reason outranks this one.
                throw StorePurchaseAuthorizationRefused.refused
            }
            throw StorePurchaseAuthorizationRefused.alreadyAuthorized
        }
        guard !attempt.arming else {
            // A concurrent second request, while the server is still answering
            // the first. One sheet gets one dispatch.
            throw StorePurchaseAuthorizationRefused.alreadyInFlight
        }
        let id = callbackID
        note(id) { $0.arming = true }
        // Permission to open exactly one sheet, plus the arm identity that
        // permission is named by. Everything about the continuation capability —
        // planning, persisting, and failing closed — happens in here, and still
        // BEFORE the store is asked to charge anybody.
        let sheet = await arm(productID: attempt.productID, token: attempt.token,
                              ownerAccountID: attempt.ownerAccountID,
                              generation: attempt.generation)
        note(id) { $0.arming = false }
        guard let sheet else {
            // `arm` has already written the truthful failure state — or was
            // superseded and deliberately wrote none — and it armed nothing, so
            // there is nothing to report and nothing to release.
            note(id) { $0.refusal = .stateAlreadyWritten }
            throw StorePurchaseAuthorizationRefused.refused
        }
        guard isAwaiting(callbackID) else {
            // **A sheet was armed for an attempt that stopped waiting for it.**
            // The adapter answered — returned or threw — while this callback was
            // still suspended inside the arm request, so `store.purchase` has
            // already closed this attempt and may have been replaced by another.
            //
            // No token may be returned. The attempt that would have reported an
            // outcome for it is gone, and a later attempt's report would name a
            // different arm.
            //
            // **And nothing is reported — not even the cancellation this
            // callback can prove about itself.** "This callback has not
            // returned" proves no attribution token reached the store *through
            // it*; it does not prove this arm is unused. The capability is
            // persisted before the initial request, so while that request is in
            // flight the stored phase is still `preparing` — and a purchase
            // starting after the abandoning one ends replays that exact prepared
            // arm, which the server answers idempotently with the same arm and
            // the same token. That second purchase is then the legitimate
            // waiter, and it may already be opening a sheet on this arm.
            // Releasing it here would cancel THAT sheet and leave a later
            // attempt free to re-arm over a purchase Apple may charge for.
            // "Nobody is waiting on my attempt" is not "nobody is waiting on
            // this arm", and only the second would justify a release.
            //
            // So the arm stays authoritative and untouched. If a live waiter
            // holds it, that waiter alone obtains the token and reports the
            // outcome it actually observes. If none does, the capability stays
            // `armed` and the next purchase is refused pending reconciliation or
            // operator recovery — an availability loss confined to an adapter
            // that broke the callback contract, and the only side of this choice
            // that cannot spend somebody's money.
            throw StorePurchaseAuthorizationRefused.notAwaiting
        }
        note(id) { $0.armed = sheet }
        // Do not gate this boundary on `generation`. Once the server has armed a
        // sheet, a later catalog/UI operation may own the screen but cannot
        // erase the money-side obligation to obtain and report one StoreKit
        // outcome. `purchaseInProgress` prevents a second purchase from sharing
        // this arm; the account snapshot below prevents cross-account use.
        guard currentBearer() == attempt.token,
              attempt.ownerAccountID == nil
                || currentAccountID() == attempt.ownerAccountID else {
            // No StoreKit call has happened yet — the store is blocked on this
            // very call — so this is the same explicit cancellation it was
            // before the arm moved inside the sheet's own call. Release the
            // server arm under the authority snapshot that created it; if
            // delivery fails, the recorded outcome remains replayable.
            await report(.userCancelled, for: sheet, token: attempt.token)
            note(id) {
                $0.reported = true
                $0.refusal = .failure(.billing(.notSignedIn))
            }
            throw StorePurchaseAuthorizationRefused.refused
        }
        return sheet.dispatch.appAccountToken
    }

    /// Whether `id` still names the authorization this model is waiting on, and
    /// that authorization is still accepting one.
    ///
    /// Both halves are load-bearing and neither implies the other: a closed
    /// attempt may still be the current one, and an open attempt may be a
    /// different one entirely.
    private func isAwaiting(_ id: Int) -> Bool {
        guard let attempt = authorization else { return false }
        return attempt.id == id && attempt.open
    }

    /// Write back to the in-flight authorization only while it is still the same
    /// one. Every mutation here follows a suspension.
    private func note(_ id: Int, _ body: (inout PurchaseAuthorization) -> Void) {
        guard var attempt = authorization, attempt.id == id else { return }
        body(&attempt)
        authorization = attempt
    }

    /// Stop accepting authorization for this attempt, and hand back what it
    /// recorded. Called the moment `store.purchase` answers, so a callback the
    /// adapter kept is refused during the awaits that follow it.
    @discardableResult
    private func closeAuthorization(_ id: Int) -> PurchaseAuthorization? {
        guard var attempt = authorization, attempt.id == id else { return nil }
        attempt.open = false
        authorization = attempt
        return attempt
    }

    // MARK: - arming one sheet

    /// One authorized sheet, and the identity its outcome must be reported under.
    private struct ArmedSheet {
        let dispatch: ApplePurchaseDispatch
        /// `nil` for a legacy client: there is no capability, so there is
        /// nothing to report and nothing that could re-arm.
        let capability: ApplePurchaseCapability?
        /// The arm this sheet is open under. Held separately from the
        /// capability so a report is bound to the identity that was ACTUALLY
        /// opened, not to whatever the store has drifted to since.
        let armRequestID: String?
    }

    /// One purchase attempt's authorization, from the moment `store.purchase`
    /// is entered to the moment it answers.
    private struct PurchaseAuthorization {
        let id: Int
        let productID: String
        /// The bearer snapshot the arm is created under, and the one every
        /// report about it is sent under.
        let token: String
        let ownerAccountID: String?
        let generation: Int
        /// Non-nil once the server armed a sheet. **The fact that decides
        /// whether an outcome is owed.**
        var armed: ArmedSheet?
        /// True while the arm request is in flight, so a concurrent second
        /// authorization cannot start a second dispatch.
        var arming = false
        /// True once an outcome has already been reported for `armed` from
        /// inside the callback. One sheet gets one statement.
        var reported = false
        /// What this model decided when it refused, so the caller does not
        /// re-derive a reason from whatever error the adapter surfaced.
        var refusal: Refusal?
        /// Cleared the moment `store.purchase` answers. A callback retained past
        /// that point may not arm anything.
        var open = true

        enum Refusal {
            /// The refusing code already wrote the failure state itself, and
            /// armed nothing.
            case stateAlreadyWritten
            /// Refused with this failure, which the screen is still owed.
            case failure(AppleSubscriptionFailure)
        }
    }

    /// **Get permission to open exactly one StoreKit sheet.**
    ///
    /// Returns `nil` after setting a truthful failure state; the caller then
    /// asks nothing of the store.
    ///
    /// The capability is persisted **before the initial request** and therefore
    /// before both the server arm and the sheet. That ordering makes a crash or
    /// lost response at either boundary an exact replay rather than an attempt
    /// armed against a capability nobody holds.
    private func arm(productID: String, token: String,
                     ownerAccountID: String?, generation g: Int) async -> ArmedSheet? {
        guard let continuation, let appInstanceID else {
            guard purchaseDispatchPolicy == .legacyOneShot else {
                state = .failed(.billing(.continuationRejected))
                return nil
            }
            // LEGACY: no capability fields, one dispatch, strict one-shot.
            do {
                let dispatch = try await billing.dispatchApplePurchase(
                    bundleID: bundleID, productID: productID, continuation: nil, token: token)
                return ArmedSheet(dispatch: dispatch, capability: nil, armRequestID: nil)
            } catch {
                guard !superseded(g) else { return nil }
                state = .failed(Self.failure(for: error))
                return nil
            }
        }
        guard let ownerAccountID else {
            state = .failed(.billing(.continuationRejected))
            return nil
        }

        // At most two passes, and the bound is deliberate rather than a `while`.
        // Pass one discharges at most one thing already owed — an unconfirmed
        // resume left by a lost response, or an outcome report recorded and
        // never confirmed — and pass two arms the product the user actually
        // chose. The two owed things are mutually exclusive by construction, and
        // discharging either clears it, so no input can make this loop again.
        //
        // Falling out of the loop is itself fail-closed: it means a pass
        // replayed something and the store could not persist the answer, so the
        // refusal below opens no sheet and the replay is simply owed again.
        //
        // The pass index is read for exactly one decision: only the first pass
        // may ask the server whether a local `armed`/`locked` capability has
        // outlived its attempt. See `mayRecoverIfResolved` on the planner.
        for pass in 0..<2 {
            guard currentBearer() == token, currentAccountID() == ownerAccountID else {
                state = .failed(.billing(.notSignedIn))
                return nil
            }
            var stored: ApplePurchaseCapability?
            switch continuation.read(ownerAccountID: ownerAccountID) {
            case .missing:
                stored = nil
            case .value(let value):
                stored = value
            case .unavailable:
                state = .failed(.billing(.continuationRejected))
                return nil
            }
            if purchaseDispatchPolicy == .durableContinuationRequired,
               stored?.ownerAccountID != nil,
               stored?.ownerAccountID != ownerAccountID {
                state = .failed(.billing(.continuationRejected))
                return nil
            }
            if purchaseDispatchPolicy == .durableContinuationRequired,
               stored != nil, stored?.ownerAccountID == nil {
                state = .failed(.billing(.continuationRejected))
                return nil
            }
            if stored == nil {
                guard let initialArm = ApplePurchaseIdentity.freshArmRequestID(),
                      let secret = ApplePurchaseIdentity.freshContinuationSecret() else {
                    state = .failed(.billing(.continuationRejected))
                    return nil
                }
                let prepared = ApplePurchaseContinuation.prepared(
                    ownerAccountID: ownerAccountID, appInstanceID: appInstanceID, secret: secret,
                    armRequestID: initialArm, productID: productID)
                do { try continuation.save(prepared) } catch {
                    state = .failed(.billing(.continuationRejected))
                    return nil
                }
                stored = prepared
            }
            if var capability = stored,
               let journaled = outcomeJournal?.load(ownerAccountID: ownerAccountID),
               journaled.attemptID == capability.attemptID,
               journaled.armRequestID == capability.armRequestID {
                capability.unconfirmedOutcome = ApplePurchaseOutcomeIntent(
                    armRequestID: journaled.armRequestID,
                    outcome: journaled.outcome)
                stored = capability
            }
            guard let freshArm = ApplePurchaseIdentity.freshArmRequestID() else {
                // The system CSPRNG refused. Arming with a guessable or empty
                // identity would spend the one name this sheet could report
                // under, so nothing is sent at all.
                state = .failed(.billing(.continuationRejected))
                return nil
            }
            let plan = ApplePurchaseContinuation.plan(capability: stored,
                                                      productID: productID,
                                                      appInstanceID: appInstanceID,
                                                      freshArmRequestID: freshArm,
                                                      mayRecoverIfResolved: pass == 0)
            switch plan {
            case let .blocked(refusal):
                // Both refusals fail closed, and neither is retried as a fresh
                // dispatch: a sheet whose outcome nobody reported may still
                // charge.
                //
                // **This is now the SECOND pass's answer.** On the first pass an
                // `armed`/`locked` capability is planned as `.recoverIfResolved`
                // instead, so reaching here means either that this same call has
                // already heard from the server about this attempt — a replayed
                // outcome it just applied — or that there is no capability at
                // all. In neither case is there anything left to ask, and a
                // refused recovery has already written its own truthful state
                // before returning, so it does not arrive here either.
                //
                // `sheetOutstanding` now means no outcome was ever RECORDED —
                // a sheet genuinely open, or a process that died between the
                // server arming and StoreKit answering. A recorded one is
                // replayed by the `.replayOutcome` case below and never reaches
                // here, which matters because reconciliation through
                // `Transaction.updates`/restore converges only the outcomes that
                // produced a signed transaction. A cancellation produces none,
                // so for that half of this state there is nothing to reconcile
                // with and the recorded replay is the only path back.
                state = .failed(.billing(refusal == .locked
                                         ? .continuationRejected
                                         : .purchaseOutcomeRequired))
                return nil

            case let .replayOutcome(capability, armID, outcome):
                // **Something is already owed, so nothing may be armed yet.**
                // This client recorded a report and never learned whether it
                // landed. It is replayed EXACTLY — same arm, same outcome, same
                // secret — which the server reads back idempotently rather than
                // as a second statement.
                //
                // No outcome is widened here. `deliver` applies the answer
                // through `applying(_:to:forArm:serverResumable:)`, which needs
                // BOTH the reported outcome and the server to be resumable
                // before the phase can become `cancelled`; a replayed `pending`,
                // `failed` or `success` therefore locks, and the next pass
                // refuses rather than arming.
                switch await deliver(outcome, for: capability, arm: armID, token: token) {
                case .undelivered:
                    guard !superseded(g) else { return nil }
                    // Fail closed, and truthfully: the server still has not
                    // heard what StoreKit did, which is exactly what
                    // `purchaseOutcomeRequired` says. The recorded intent
                    // survives, so the next attempt — or the next launch —
                    // replays this same report again.
                    state = .failed(.billing(.purchaseOutcomeRequired))
                    return nil
                case .superseded:
                    guard !superseded(g) else { return nil }
                    // Another installation owns the attempt now. The rejected
                    // arm is inert and has been retired locally, so the second
                    // bounded planning pass may prepare a fresh capability.
                    continue
                case .delivered:
                    guard !superseded(g) else { return nil }
                    // The stored phase now reflects the SERVER's answer. The
                    // second pass re-plans from it: `cancelled` becomes one
                    // fresh resume, and anything else becomes `.blocked`, which
                    // is refused above rather than armed here. Deciding it there
                    // keeps one place in this type that maps a refusal.
                    continue
                }

            case let .initialArm(prepared):
                do {
                    let dispatch = try await billing.dispatchApplePurchase(
                        bundleID: bundleID, productID: prepared.productID,
                        continuation: prepared.fields,
                        token: token)
                    guard let capability = ApplePurchaseContinuation.confirmedInitialArm(
                        prepared, attemptID: dispatch.attemptId,
                        serverSecret: dispatch.continuationSecret) else {
                        state = .failed(.billing(.continuationRejected))
                        return nil
                    }
                    // Persisted BEFORE the sheet. A save that fails must stop
                    // the purchase: opening a sheet whose outcome could never be
                    // reported is what deadlocks the account.
                    do { try continuation.save(capability) } catch {
                        state = .failed(.billing(.continuationRejected))
                        return nil
                    }
                    let armed = ArmedSheet(dispatch: dispatch, capability: capability,
                                           armRequestID: capability.armRequestID)
                    guard capability.productID == productID else {
                        let released = await report(.userCancelled, for: armed, token: token)
                        guard released else {
                            state = .failed(.billing(.purchaseOutcomeRequired))
                            return nil
                        }
                        continue
                    }
                    return armed
                } catch {
                    if prepared.phase == .preparing,
                       Self.provesInitialArmWasNotCreated(error) {
                        try? continuation.retire(ownerAccountID: ownerAccountID)
                    }
                    guard !superseded(g) else { return nil }
                    state = .failed(Self.failure(for: error))
                    return nil
                }

            case let .resume(capability, armID, product),
                 let .replayResume(capability, armID, product),
                 let .recoverIfResolved(capability, armID, product):
                // **One transport, three meanings, and the difference is the
                // server's to state — which is exactly why they share it.**
                //
                // `resume` asks to re-arm an attempt this client proved
                // cancelled; `recoverIfResolved` asks whether an `armed` or
                // `locked` attempt still exists at all; `replayResume` re-sends
                // whichever of the two was recorded and never answered. All
                // three carry the capability and a fresh arm identity to the one
                // atomic compare-and-arm, and in every one of them this client
                // asserts nothing about the old attempt: a 409/403 refusal
                // leaves it exactly where it was, and only a 200 — which the
                // server emits only when nothing unresolved remains for this
                // authority — may become a sheet. Writing a second dispatch path
                // for the recovery would duplicate the record-before-send,
                // adopt-before-sheet and save-or-refuse rules below, which are
                // the money rules.
                //
                // **Recorded before it is sent, on all three arms of this case.** A
                // replay is already recorded and re-recording it is a no-op with
                // the same bytes; a first resume must be recorded or a lost
                // response strands the account on an identity it never learned.
                //
                // **And a refusal is read the same way for all three**, because
                // the server does not vary it by plan either: its one
                // reconciliation code answers for an unresolved attempt whether
                // this client asked about an `armed` one, replayed a lost
                // request, or resumed a `cancelled` one. Mapping it is therefore
                // ``failure(for:)``'s job here as everywhere else, and an
                // earlier attempt to special-case this call site produced copy
                // that was false on the paths it did not cover.
                let intent = ApplePurchaseContinuation.recordingResumeIntent(
                    capability, armRequestID: armID, productID: product)
                do { try continuation.save(intent) } catch {
                    state = .failed(.billing(.continuationRejected))
                    return nil
                }
                let dispatch: ApplePurchaseDispatch
                do {
                    dispatch = try await billing.dispatchApplePurchase(
                        bundleID: bundleID, productID: product,
                        continuation: capability.fields(forArm: armID),
                        token: token)
                } catch {
                    guard !superseded(g) else { return nil }
                    state = .failed(Self.failure(for: error))
                    return nil
                }
                guard let confirmed = ApplePurchaseContinuation.confirmedArm(
                    intent, attemptID: dispatch.attemptId,
                    armRequestID: armID, productID: product) else {
                    state = .failed(.billing(.continuationRejected))
                    return nil
                }
                do { try continuation.save(confirmed) } catch {
                    state = .failed(.billing(.continuationRejected))
                    return nil
                }
                guard product == productID else {
                    // A replay discharged an older resume for a DIFFERENT
                    // product than the user just chose. That sheet is now armed
                    // and was never opened, so no charge is possible — and this
                    // client knows that more certainly than a real cancellation
                    // does. Report it as cancelled to release the dispatch, then
                    // let the second pass arm what was actually asked for.
                    let released = await report(
                        .userCancelled,
                        for: ArmedSheet(dispatch: dispatch, capability: confirmed,
                                        armRequestID: armID),
                        token: token)
                    guard released else {
                        state = .failed(.billing(.purchaseOutcomeRequired))
                        return nil
                    }
                    continue
                }
                return ArmedSheet(dispatch: dispatch, capability: confirmed, armRequestID: armID)
            }
        }
        // Both passes ran without arming the chosen product.
        state = .failed(.billing(.purchaseOutcomeRequired))
        return nil
    }

    /// **Tell the server what StoreKit did with the arm that was open.**
    ///
    /// Returns whether the server accepted the report AND called the attempt
    /// resumable — which requires a cancellation and the server's own agreement,
    /// and is false for everything else including a report that never landed.
    ///
    /// A legacy sheet reports nothing and answers `false`: there is no
    /// capability, so there is no dispatch to release and no second sheet this
    /// could authorize.
    ///
    /// **The report is written down before it is sent.** That ordering is the
    /// whole recovery property. A cancellation produces no signed transaction,
    /// so if the request or its response is lost there is nothing for
    /// `Transaction.updates` or `restore` to redeliver and *nothing* converges
    /// the attempt — the stored phase stays `armed` and every later purchase is
    /// refused for ever. Recording the intent first turns that permanent lockout
    /// into a replay the next attempt performs before it may plan anything.
    ///
    /// **Local state moves only if the report names the arm that is still
    /// open.** `applying(_:to:forArm:serverResumable:)` returns `nil` otherwise,
    /// and this drops it — that is what stops a late completion from an earlier
    /// sheet cancelling or retiring a newer one, across a restart as well as
    /// within a run, because both sides of that comparison come from the
    /// persisted value.
    @discardableResult
    private func report(_ outcome: ApplePurchaseOutcome,
                        for armed: ArmedSheet,
                        token: String) async -> Bool {
        guard let continuation, let capability = armed.capability,
              let armRequestID = armed.armRequestID else { return false }
        // Re-read rather than trusting the value captured before the sheet: a
        // concurrent path may have moved or retired the capability while the
        // user was inside StoreKit.
        let stored: ApplePurchaseCapability?
        switch continuation.read(ownerAccountID: capability.ownerAccountID) {
        case .value(let value): stored = value
        case .missing, .unavailable: stored = nil
        }
        if let stored, stored.armRequestID != armRequestID {
            // **Stale, so inert.** `armRequestID` moves only on an authoritative
            // 200, so the server has already superseded the arm this report is
            // about and nothing is waiting on it. Not sent, not recorded, and
            // nothing local moved.
            return false
        }
        if let stored,
           let recorded = ApplePurchaseContinuation.recordingOutcomeIntent(
               stored, outcome: outcome, forArm: armRequestID) {
            guard let owner = recorded.ownerAccountID else { return false }
            var persisted = false
            do {
                try outcomeJournal?.save(ApplePurchaseOutcomeJournalEntry(
                    ownerAccountID: owner, attemptID: recorded.attemptID,
                    armRequestID: armRequestID, outcome: outcome))
                persisted = true
            } catch {}
            do {
                try continuation.save(recorded)
                persisted = true
            } catch {}
            guard persisted else { return false }
            return await deliver(outcome, for: recorded,
                                 arm: armRequestID, token: token) == .delivered(resumable: true)
        }
        // Keychain could not supply a recordable current value, or a resume is
        // unconfirmed. Persist the non-secret outcome journal before sending;
        // never resurrect the captured secret into Keychain, because a
        // concurrent authoritative settlement may already have retired it.
        guard let owner = capability.ownerAccountID else { return false }
        do {
            try outcomeJournal?.save(ApplePurchaseOutcomeJournalEntry(
                ownerAccountID: owner, attemptID: capability.attemptID,
                armRequestID: armRequestID, outcome: outcome))
        } catch {
            return false
        }
        return await deliver(outcome, for: capability,
                             arm: armRequestID, token: token) == .delivered(resumable: true)
    }

    /// What became of one outcome report.
    private enum OutcomeReport: Equatable {
        /// The request never completed. The recorded intent stands and is owed
        /// again; **nothing local moved**, because silence is not a cancellation.
        case undelivered
        /// The server definitively rejected this exact arm capability. It has
        /// been superseded and was retired locally, so a fresh plan may begin.
        case superseded
        /// The server answered, and this is what it said about re-arming.
        case delivered(resumable: Bool)
    }

    /// Send one **recorded** outcome report and apply whatever the server said.
    ///
    /// Separate from ``report(_:for:token:)`` because a replay enters here
    /// directly: the intent it is replaying was recorded on some earlier attempt,
    /// possibly in an earlier process, and must not be re-derived from anything
    /// StoreKit says now.
    private func deliver(_ outcome: ApplePurchaseOutcome,
                         for capability: ApplePurchaseCapability,
                         arm armRequestID: String,
                         token: String) async -> OutcomeReport {
        let resumable: Bool
        do {
            resumable = try await billing.reportApplePurchaseOutcome(
                bundleID: bundleID,
                attemptID: capability.attemptID,
                continuation: capability.fields(forArm: armRequestID),
                outcome: outcome,
                token: token)
        } catch AppleBillingError.continuationRejected {
            // A uniform 403 is authoritative proof that this exact arm can no
            // longer move server state. Retire only if the persisted value is
            // still byte-for-byte the one whose report was rejected; a network
            // failure or any changed local value remains owed and fails closed.
            if retireCapabilityIfSuperseded(capability, arm: armRequestID) {
                return .superseded
            }
            return .undelivered
        } catch {
            // **Not delivered, so nothing local may move.** The server — which
            // also heard nothing — stays armed for the same reason. The recorded
            // intent is what makes this recoverable rather than terminal.
            return .undelivered
        }
        // Re-read again: this may be a replay planned from a value that has
        // since moved, and the answer must be applied to what is actually
        // stored.
        guard let continuation,
              case let .value(current) = continuation.read(
                ownerAccountID: capability.ownerAccountID),
              let next = ApplePurchaseContinuation.applying(outcome, to: current,
                                                            forArm: armRequestID,
                                                            serverResumable: resumable) else {
            return .delivered(resumable: resumable)
        }
        // A failed save leaves the intent recorded, so the next attempt replays
        // a report the server has already accepted — which it answers
        // idempotently rather than treating as a second statement.
        do {
            try continuation.save(next)
            if let owner = next.ownerAccountID {
                try outcomeJournal?.clear(ownerAccountID: owner)
            }
        } catch {
            // The independent non-secret journal remains and reconstructs the
            // owed report when Keychain becomes writable again.
        }
        return .delivered(resumable: resumable)
    }

    private func retireCapabilityIfSuperseded(_ capability: ApplePurchaseCapability,
                                              arm armRequestID: String) -> Bool {
        guard let continuation,
              case let .value(current) = continuation.read(ownerAccountID: capability.ownerAccountID),
              current.armRequestID == armRequestID,
              capability.unconfirmedOutcome?.armRequestID == armRequestID else {
            return false
        }
        // The outcome may exist only in the independent journal when Keychain
        // rejected the recording write. In that case planning reconstructs the
        // exact intent in memory while the stored capability is otherwise
        // byte-identical and still has a nil outcome. Accept only that one-field
        // absence; a different stored outcome or any other changed byte remains
        // owed and cannot be retired by this response.
        guard current.unconfirmedOutcome == nil ||
                current.unconfirmedOutcome == capability.unconfirmedOutcome else {
            return false
        }
        var expectedStored = capability
        expectedStored.unconfirmedOutcome = current.unconfirmedOutcome
        guard current == expectedStored else { return false }
        do {
            try continuation.retire(ownerAccountID: capability.ownerAccountID)
            // Retire first: in the journal-only recovery shape the journal is
            // the sole retry trigger, so clearing it before a failed Keychain
            // delete would recreate the permanent wedge. A journal left after
            // successful retirement is inert because reconstruction requires
            // the next capability's independently fresh attempt and arm ids.
            if let owner = capability.ownerAccountID {
                try? outcomeJournal?.clear(ownerAccountID: owner)
            }
            return true
        } catch {
            return false
        }
    }

    /// Retire the capability, on authoritative convergence and nothing else.
    ///
    /// Called when the server reports the attempt resolved. **Never on a clock,
    /// a TTL or a launch count** — a time-based release would re-open the
    /// double-charge window on a device whose clock is wrong.
    private func retireCapabilityIfResolved(_ result: AppleTransactionResult,
                                            ownerAccountID: String?) -> Bool {
        guard result.dispatchResolved, let continuation else { return true }
        switch continuation.read(ownerAccountID: ownerAccountID) {
        case .missing:
            return true
        case .unavailable:
            return false
        case .value(let capability):
            guard !result.dispatchResolvedAttemptId.isEmpty,
                  capability.attemptID == result.dispatchResolvedAttemptId else {
                return false
            }
        }
        do {
            try continuation.retire(ownerAccountID: ownerAccountID)
            return true
        } catch {
            // The server has converged, but a stale local capability would make
            // the next purchase fail closed forever. Keep the StoreKit
            // transaction unfinished so its guaranteed redelivery retries this
            // cleanup; never trade a transient Keychain error for permanent
            // local lockout.
            return false
        }
    }

    // MARK: - restoring

    /// Reconcile with the App Store and re-submit whatever this Apple ID owns.
    ///
    /// Same policy as a purchase, delivery for delivery: submit, finish only on
    /// a decoded 200, then one refresh if anything was accepted. Restoring is
    /// the path a user reaches for when something already went wrong, so it is
    /// the last place that should be allowed to finish a transaction the server
    /// has not taken.
    /// Deliberately NOT gated on the catalog or on eligibility. A restore
    /// submits what this Apple ID already owns; refusing to run one because
    /// nothing is currently on sale — or because a Stripe subscription blocks a
    /// NEW purchase — would strand a subscription the user has already paid for
    /// behind a product whose row was retired or a browser session they opened.
    public func restore() async {
        guard currentBearer() != nil else {
            // Deliberately before `synchronize()`: that call can prompt for App
            // Store credentials, and prompting for them in order to do nothing
            // with the result is worse than refusing up front.
            state = .failed(.billing(.notSignedIn))
            return
        }
        let g = begin()
        state = .restoring
        do {
            try await store.synchronize()
        } catch {
            guard !superseded(g) else { return }
            state = .failed(Self.failure(for: error))
            return
        }
        guard !superseded(g) else { return }

        let deliveries = await store.currentEntitlements()
        guard !superseded(g) else { return }
        guard !deliveries.isEmpty else {
            state = .nothingToRestore
            return
        }

        var accepted: AppleTransactionResult?
        var firstFailure: AppleSubscriptionFailure?
        // Deliberately NOT interrupted by supersession. Two reasons, and the
        // second is the load-bearing one:
        //
        //  * every submission re-reads the bearer inside `settle`, so if what
        //    superseded this restore was a sign-out, the remaining deliveries
        //    refuse on their own and finish nothing;
        //  * stopping half way would leave entitlements this restore had
        //    already read from the store unsubmitted, for no gain — the only
        //    thing supersession is entitled to take away is the screen.
        for delivery in deliveries {
            switch await settle(delivery) {
            case .accepted(let result): accepted = result
            case .refused(let failure): firstFailure = firstFailure ?? failure
            }
        }
        // One refresh for the whole restore, and only when something was
        // actually accepted — a refresh that follows nothing is a request that
        // can only report what the screen already shows.
        if accepted != nil {
            await refreshAfterAcceptance()
            // A restore is also the recovery path for a migrated Apple source
            // whose app scope was unknown. The accepted transaction may have
            // repaired that scope server-side, so refresh the catalog answer as
            // well as /api/me; otherwise the screen keeps showing its stale
            // "managed in another app" eligibility until it is reopened.
            if !superseded(g) {
                await refreshOffersAfterRestore(generation: g)
            }
        }
        guard !superseded(g) else { return }
        if let accepted {
            state = .completed(accepted)
        } else if let firstFailure {
            state = .failed(firstFailure)
        } else {
            state = .nothingToRestore
        }
    }

    // MARK: - ongoing deliveries

    /// Start draining the store's update stream.
    ///
    /// Idempotent, and deliberately NOT gated on a loaded catalog.
    ///
    /// The drain is what receives a renewal, a refund, an Ask-to-Buy approval
    /// and — the case that matters — a redelivery of a purchase an earlier
    /// submission never got accepted. Every one of those can arrive before any
    /// screen has asked for a catalog, and a purchase interrupted by a crash
    /// arrives at the NEXT launch. Gating it on offers would mean the app only
    /// hears about the transaction it has already been told about.
    public func startObservingUpdates() {
        guard updateTask == nil else { return }
        let stream = store.updates()
        updateTask = Task { [weak self] in
            guard let self else { return }
            // Subscribe to live updates first, then sweep StoreKit's durable
            // unfinished queue. A transaction completing across this launch
            // boundary is therefore present in at least one source. Duplicate
            // delivery is safe: server intake is idempotent by transaction id,
            // and `finish` addresses only the exact retained StoreKit object.
            await self.reconcileUnfinishedTransactions()
            for await delivery in stream {
                if Task.isCancelled { return }
                await self.handle(update: delivery)
            }
        }
    }

    /// Retry StoreKit's durable unfinished queue whenever a Relayium account
    /// becomes ready.
    ///
    /// The launch observer may run before keychain session restoration. Its
    /// signed-out sweep correctly submits nothing, but StoreKit does not promise
    /// another live update merely because Relayium later acquired a bearer. The
    /// app therefore calls this again on each ready account identity. Concurrent
    /// launch and sign-in calls collapse into one sweep.
    public func reconcileUnfinishedTransactions() async {
        guard currentBearer() != nil, !unfinishedSweepInProgress else { return }
        unfinishedSweepInProgress = true
        defer { unfinishedSweepInProgress = false }
        for delivery in await store.unfinishedTransactions() {
            if Task.isCancelled { return }
            await handle(update: delivery)
        }
    }

    /// Stop draining, and let go of the stream.
    ///
    /// Called from `deinit` as well. Nothing here waits for the task: cancelling
    /// is what breaks the `for await`, and the drain has no cleanup to run.
    public func stop() {
        updateTask?.cancel()
        updateTask = nil
    }

    /// One delivery the store made on its own — a renewal, a refund, a revoked
    /// purchase, an Ask-to-Buy approval, or a redelivery of something an earlier
    /// submission never got accepted.
    ///
    /// **It writes no state, and that is deliberate.** Nobody asked for this. A
    /// renewal landing at 3am must not repaint a purchase screen, and a refused
    /// background submission must not raise an error banner about an action the
    /// user did not take. What it does instead is exactly what an entitlement
    /// change should do: refresh the account, so every existing surface renders
    /// the server's own answer.
    ///
    /// The finish policy is the same one, through the same call. A redelivery is
    /// the mechanism this whole file exists to protect, so the path that
    /// consumes it may not be the one that gets it wrong.
    private func handle(update delivery: SignedStoreTransaction) async {
        // Signed out, this does nothing at all: there is no account to submit
        // against, and the store will redeliver after the next sign-in.
        guard currentBearer() != nil else { return }
        if case .accepted = await settle(delivery) {
            await refreshAfterAcceptance()
        }
    }

    // MARK: - the one submit-and-finish path

    /// Submit one delivery and, if and only if the server accepted it, finish it.
    ///
    /// Every path above reaches the store's `finish` through here and nowhere
    /// else. That is the structural half of the policy: there is one call site
    /// for the destructive operation, it sits inside the `accepted` arm, and the
    /// arm is chosen by ``AppleSubmission/permitsFinish`` rather than by
    /// whichever condition a caller remembered.
    ///
    /// The bearer is re-read here rather than carried in from the caller: a
    /// purchase sheet can sit open for minutes, and the credential that comes
    /// back must be the one the session holds NOW. If the session is gone,
    /// nothing is submitted and nothing is finished — the store keeps the
    /// transaction and offers it again after the next sign-in.
    /// Reload the account from the server, because a transaction was accepted
    /// and has therefore already been FINISHED.
    ///
    /// **This is the one thing in this type that supersession may not cancel**,
    /// and the asymmetry is the whole point of the method existing under its own
    /// name.
    ///
    /// Every other late write here is cosmetic: a stale `.failed` or
    /// `.completed` painted over a newer operation's screen is a lie about what
    /// the user is looking at, and dropping it costs nothing, because nothing
    /// happened that the app needs to know about. An acceptance is the opposite
    /// on both counts. By the time it is known, `settle` has already told the
    /// store to stop redelivering that transaction, and nothing on the device
    /// can produce the JWS again — so this refresh is not the epilogue of an
    /// operation nobody is watching, it is the only remaining path by which the
    /// entitlement the user has paid for reaches the app. Skipping it because a
    /// newer operation owns the screen leaves a live server-side subscription
    /// rendered as the old plan until something unrelated happens to reload.
    ///
    /// The reverse risk is a redundant `/api/me` pair, which is why the trade is
    /// not close.
    ///
    /// **Contract for the action that gets injected.** Because this can run for
    /// an operation the session has already moved on from — including one
    /// superseded by a sign-out — the closure must be safe and idempotent to
    /// call at any moment. `AccountSession.refresh()` is: it re-reads the
    /// credential it holds now, claims its own generation, and lands on
    /// `.loggedOut` when there is none.
    private func refreshAfterAcceptance() async {
        await refreshAccount()
    }

    /// Refresh only the offer/eligibility facts after an accepted restore while
    /// preserving the restore's final success state. Unlike `loadOffers()`, this
    /// does not claim a new generation or render loading/failure UI: the paid
    /// transaction was already accepted, so a secondary catalog failure must
    /// not turn that success into an apparent purchase failure.
    private func refreshOffersAfterRestore(generation g: Int) async {
        guard let token = currentBearer() else { return }
        do {
            let catalog = try await billing.appleCatalog(bundleID: bundleID, token: token)
            guard !superseded(g) else { return }
            eligibility = catalog.purchase
            guard !catalog.products.isEmpty else {
                offers = []
                return
            }
            let loaded = try await store.offers(for: catalog.products.map(\.productId))
            guard !superseded(g) else { return }
            offers = Self.join(catalog: catalog.products, store: loaded)
        } catch {
            guard !superseded(g) else { return }
            // Preserve the accepted restore's success state, but never preserve
            // a stale permission to buy. The visible offers remain disabled
            // while eligibility is unknown, and the next ordinary load retries.
            eligibility = nil
        }
    }

    private func settle(_ delivery: SignedStoreTransaction) async -> AppleSubmission {
        guard let token = currentBearer() else {
            return .refused(.billing(.notSignedIn))
        }
        let ownerAccountID = currentAccountID()
        let submission: AppleSubmission
        var localRetirementSucceeded = true
        do {
            // The JWS goes over as the store produced it. Nothing between here
            // and the request body touches it.
            let result = try await billing.submitAppleTransaction(
                signedTransactionInfo: delivery.jws,
                signedRenewalInfo: delivery.renewalJWS,
                token: token)
            submission = .accepted(result)
            // **Authoritative convergence, and the only thing that retires a
            // capability.** The server has settled this attempt, so the secret
            // can no longer authorize anything and keeping it is a stored credential
            // with no purpose. Nothing else releases it — not a clock, not a TTL,
            // not a launch count.
            //
            // Done here rather than on the purchase path because this is the one
            // place every route converges: a foreground purchase, a background
            // renewal through `Transaction.updates`, and a restore all settle here.
            localRetirementSucceeded = retireCapabilityIfResolved(
                result, ownerAccountID: ownerAccountID)
        } catch {
            submission = .refused(Self.failure(for: error))
        }
        guard submission.permitsFinish, localRetirementSucceeded else { return submission }
        await store.finish(delivery.id)
        return submission
    }

    // MARK: - helpers

    /// The current bearer, or nil when there is effectively none. An empty
    /// string is not a credential, and treating it as one would send an
    /// `Authorization: Bearer ` header that can only be refused.
    private func currentBearer() -> String? {
        guard let token = bearer(), !token.isEmpty else { return nil }
        return token
    }

    private func currentAccountID() -> String? {
        guard let id = accountID(), !id.isEmpty else { return nil }
        return id
    }

    private func begin() -> Int {
        generation += 1
        return generation
    }

    private func superseded(_ g: Int) -> Bool { generation != g }

    /// Map a thrown value onto the typed failure, keeping the server's own
    /// vocabulary intact and reducing everything else to a type name.
    private static func failure(for error: Error) -> AppleSubscriptionFailure {
        if let billing = error as? AppleBillingError {
            if case let .initialArmRejected(code, provider) = billing {
                switch code {
                case "purchases_paused": return .purchasesPaused
                case "product_unavailable": return .selectionChanged
                default: return .purchaseNotAllowed(blockedBy: provider ?? "apple")
                }
            }
            // **`purchaseAuthorityManaged` is not an ownership statement, on any
            // path, so this is not path-sensitive.** The client name is broader
            // than the fact: it carries exactly one server answer, the dispatch
            // endpoint's 409 `purchase_reconciliation_required`, and that code
            // is emitted from one branch only — the one that inspects an
            // EXISTING UNRESOLVED ATTEMPT. Either it is a legacy attempt armed
            // before the capability protocol, with nothing to present, or it is
            // a `locked` one whose StoreKit outcome was pending, an error, or
            // unknown. Both are one purchase that has not converged.
            //
            // The account-level conflicts — `manage_with_apple` and
            // `billing_authority_conflict` — are decided earlier in that same
            // handler, from the account's catalog eligibility, from a plan that
            // must be changed in an existing App Store subscription, or from a
            // billing authority another provider already holds. Never from an
            // attempt. They arrive above as `initialArmRejected`, and THOSE keep
            // the ownership notice, because for those it is true.
            //
            // So this maps onto `continuationRejected`, which is what is true
            // and is already worded: Apple has not confirmed this yet, and
            // reconciliation is what converges it. No case, key or copy is
            // added. Reading it as ownership instead would tell somebody who has
            // never completed an App Store purchase that they already have one,
            // and send them to a Manage Subscriptions screen with nothing on it.
            if case .purchaseAuthorityManaged = billing {
                return .billing(.continuationRejected)
            }
            return .billing(billing)
        }
        return .unexpected(type: String(describing: type(of: error)))
    }

    /// These responses are emitted only after the server has checked for an
    /// exact initial-arm replay. Receiving one therefore proves that this
    /// prepared identity did not create a purchase attempt and may be retired.
    private static func provesInitialArmWasNotCreated(_ error: Error) -> Bool {
        guard let billing = error as? AppleBillingError else { return false }
        switch billing {
        case .initialArmRejected:
            return true
        default:
            return false
        }
    }
}
