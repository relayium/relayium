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
    public var permitsFinish: Bool {
        if case .accepted = self { return true }
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
    /// `AccountSession.refresh()`, injected rather than reimplemented. It is
    /// what makes the server's answer — not this model's — what the app renders.
    private let refreshAccount: @MainActor () async -> Void

    private var updateTask: Task<Void, Never>?
    private var generation = 0

    public init(store: SubscriptionStore,
                billing: AppleBillingService,
                bundleID: String,
                bearer: @escaping @MainActor () -> String?,
                refreshAccount: @escaping @MainActor () async -> Void) {
        self.store = store
        self.billing = billing
        self.bundleID = bundleID
        self.bearer = bearer
        self.refreshAccount = refreshAccount
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
        guard let token = currentBearer() else {
            // Nothing was asked of the store. A signed-out purchase has no
            // account to attribute to, and StoreKit would happily complete it.
            state = .failed(.billing(.notSignedIn))
            return
        }
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

        let dispatch: ApplePurchaseDispatch
        do {
            dispatch = try await billing.dispatchApplePurchase(bundleID: bundleID,
                                                               productID: productID,
                                                               token: token)
        } catch {
            guard !superseded(g) else { return }
            state = .failed(Self.failure(for: error))
            return
        }
        guard !superseded(g) else { return }

        let outcome: StorePurchaseOutcome
        do {
            outcome = try await store.purchase(productID: productID,
                                               appAccountToken: dispatch.appAccountToken)
        } catch {
            guard !superseded(g) else { return }
            state = .failed(Self.failure(for: error))
            return
        }
        guard !superseded(g) else { return }

        switch outcome {
        case .userCancelled:
            // The whole meaning of cancelling is that nothing happened. No
            // submission, no finish, and no error the user did not cause.
            state = .idle
        case .pending:
            state = .deferred
        case .delivered(let delivery):
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
            for await delivery in stream {
                if Task.isCancelled { return }
                guard let self else { return }
                await self.handle(update: delivery)
            }
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
        let submission: AppleSubmission
        do {
            // The JWS goes over as the store produced it. Nothing between here
            // and the request body touches it.
            let result = try await billing.submitAppleTransaction(
                signedTransactionInfo: delivery.jws,
                signedRenewalInfo: delivery.renewalJWS,
                token: token)
            submission = .accepted(result)
        } catch {
            submission = .refused(Self.failure(for: error))
        }
        guard submission.permitsFinish else { return submission }
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

    private func begin() -> Int {
        generation += 1
        return generation
    }

    private func superseded(_ g: Int) -> Bool { generation != g }

    /// Map a thrown value onto the typed failure, keeping the server's own
    /// vocabulary intact and reducing everything else to a type name.
    private static func failure(for error: Error) -> AppleSubscriptionFailure {
        if let billing = error as? AppleBillingError {
            if case .purchaseAuthorityManaged(let provider) = billing {
                return .purchaseNotAllowed(blockedBy: provider)
            }
            return .billing(billing)
        }
        return .unexpected(type: String(describing: type(of: error)))
    }
}
