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

/// What the purchase surface would be showing, if there were one.
public enum AppleSubscriptionState: Equatable {
    /// This build has nothing to sell: no product identifiers configured, or a
    /// store that recognised none of them. The resting state of this batch, and
    /// the state in which no store and no billing call is ever made.
    case unavailable
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
    @Published public private(set) var state: AppleSubscriptionState
    /// What the store said is for sale. Empty until `loadOffers()`, and empty
    /// forever in a build with no catalog.
    @Published public private(set) var offers: [SubscriptionOffer] = []

    /// The product identifiers this build may sell. **Empty in this batch**, and
    /// that is what makes the whole feature inert: with no catalog, nothing here
    /// reaches the store or the billing service at all.
    private let catalog: [String]
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
                catalog: [String],
                bearer: @escaping @MainActor () -> String?,
                refreshAccount: @escaping @MainActor () async -> Void) {
        self.store = store
        self.billing = billing
        self.catalog = catalog
        self.bearer = bearer
        self.refreshAccount = refreshAccount
        // Stated at construction rather than discovered on first use: a surface
        // that asked "can I sell?" before loading anything would otherwise get
        // `.idle` from a build that can never sell.
        self.state = catalog.isEmpty ? .unavailable : .idle
    }

    deinit {
        // `Task.cancel()` is safe from any isolation, and this is the only thing
        // that stops an adapter's underlying `Transaction.updates` subscription
        // when the model goes away without an explicit `stop()`.
        updateTask?.cancel()
    }

    /// Whether this build has any product identifiers at all. False in this
    /// batch, so every caller of it is looking at an unreachable feature.
    public nonisolated var hasCatalog: Bool { !catalog.isEmpty }

    // MARK: - offers

    /// Load what the store will sell, localized by the store.
    ///
    /// With no catalog this touches NOTHING — not the store, not the billing
    /// service — and reports `.unavailable`. That is the shipping path today,
    /// and it is why this object can exist in a build with no StoreKit linked
    /// at all.
    public func loadOffers() async {
        guard !catalog.isEmpty else {
            offers = []
            state = .unavailable
            return
        }
        let g = begin()
        state = .loadingOffers
        do {
            let loaded = try await store.offers(for: catalog)
            guard !superseded(g) else { return }
            offers = loaded
            // A store that recognised none of the configured identifiers leaves
            // the user in the same place an empty catalog does — nothing to buy
            // — so it is reported the same way rather than as an idle screen
            // with no products on it.
            state = loaded.isEmpty ? .unavailable : .idle
        } catch {
            guard !superseded(g) else { return }
            offers = []
            state = .failed(Self.failure(for: error))
        }
    }

    // MARK: - buying

    /// Buy one of the loaded offers.
    ///
    /// The order of the guards is the security-relevant part. The account token
    /// is fetched BEFORE the store is asked to charge anybody, so a signed-out
    /// user, an expired session or a server that cannot mint a token all end
    /// with no purchase sheet and no money moved. A purchase started first and
    /// attributed afterwards would be a payment with nowhere to land.
    public func purchase(productID: String) async {
        guard !catalog.isEmpty else {
            state = .unavailable
            return
        }
        // Only something the store actually offered. An identifier that was
        // never loaded cannot be priced, cannot be described, and would put a
        // charge behind a product this build has never seen.
        guard offers.contains(where: { $0.id == productID }) else {
            state = .unavailable
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

        let appAccountToken: UUID
        do {
            appAccountToken = try await billing.appleAccountToken(token: token)
        } catch {
            guard !superseded(g) else { return }
            state = .failed(Self.failure(for: error))
            return
        }
        guard !superseded(g) else { return }

        let outcome: StorePurchaseOutcome
        do {
            outcome = try await store.purchase(productID: productID,
                                               appAccountToken: appAccountToken)
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
    public func restore() async {
        guard !catalog.isEmpty else {
            state = .unavailable
            return
        }
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
    /// Idempotent, and a no-op without a catalog: a build that sells nothing has
    /// no reason to hold a subscription to the store's renewals, and this is the
    /// half of the inertness claim that a source scan cannot make.
    public func startObservingUpdates() {
        guard updateTask == nil, !catalog.isEmpty else { return }
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

    private func settle(_ delivery: SignedStoreTransaction) async -> AppleSubmission {
        guard let token = currentBearer() else {
            return .refused(.billing(.notSignedIn))
        }
        let submission: AppleSubmission
        do {
            // The JWS goes over as the store produced it. Nothing between here
            // and the request body touches it.
            let result = try await billing.submitAppleTransaction(
                signedTransactionInfo: delivery.jws, token: token)
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
        if let billing = error as? AppleBillingError { return .billing(billing) }
        return .unexpected(type: String(describing: type(of: error)))
    }
}
