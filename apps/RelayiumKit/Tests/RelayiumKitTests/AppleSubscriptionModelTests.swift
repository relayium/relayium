import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - fakes

/// An ordered record of everything the model did, across both dependencies.
///
/// Ordering is the point. "Submitted" and "finished" are both true of a correct
/// purchase and of a catastrophic one; the only thing that tells them apart is
/// which happened first.
private final class PurchaseJournal: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []
    func record(_ entry: String) {
        lock.lock(); entries.append(entry); lock.unlock()
    }
    var all: [String] {
        lock.lock(); defer { lock.unlock() }
        return entries
    }
    func count(_ entry: String) -> Int { all.filter { $0 == entry }.count }
}

/// A store with no store behind it: every outcome StoreKit can produce, on
/// demand, including the ones that need a real Apple ID and a sandbox account.
private final class FakeStore: SubscriptionStore, @unchecked Sendable {
    private let lock = NSLock()
    private let journal: PurchaseJournal

    private var _offers: Result<[SubscriptionOffer], Error> = .success([])
    private var _purchase: Result<StorePurchaseOutcome, Error> = .success(.userCancelled)
    private var _entitlements: [SignedStoreTransaction] = []
    private var _unfinished: [SignedStoreTransaction] = []
    private var _synchronize: Result<Void, Error> = .success(())
    private var _finished: [StoreTransactionID] = []
    private var _requestedIDs: [[String]] = []
    private var _appAccountTokens: [UUID] = []
    private var _continuation: AsyncStream<SignedStoreTransaction>.Continuation?
    private var _updateStreamsTerminated = 0
    private var _onPurchase: (@Sendable () -> Void)?
    private var _holdPurchase = false
    private var _holdSynchronize = false

    init(journal: PurchaseJournal) { self.journal = journal }

    // configuration
    func setOffers(_ value: Result<[SubscriptionOffer], Error>) { sync { _offers = value } }
    func setPurchase(_ value: Result<StorePurchaseOutcome, Error>) { sync { _purchase = value } }
    func setEntitlements(_ value: [SignedStoreTransaction]) { sync { _entitlements = value } }
    func setUnfinished(_ value: [SignedStoreTransaction]) { sync { _unfinished = value } }
    func setSynchronize(_ value: Result<Void, Error>) { sync { _synchronize = value } }
    /// Run something at the moment the store would be charging the user — the
    /// only place from which "the session ended while the sheet was open" can be
    /// staged truthfully.
    func setOnPurchase(_ body: (@Sendable () -> Void)?) { sync { _onPurchase = body } }
    func setHoldPurchase(_ value: Bool) { sync { _holdPurchase = value } }
    /// Park `synchronize()` until released, so an operation can be caught
    /// genuinely in flight rather than assumed to be.
    func setHoldSynchronize(_ value: Bool) { sync { _holdSynchronize = value } }

    // observation
    var finished: [StoreTransactionID] { sync { _finished } }
    var requestedIDs: [[String]] { sync { _requestedIDs } }
    var appAccountTokens: [UUID] { sync { _appAccountTokens } }
    var updateStreamsTerminated: Int { sync { _updateStreamsTerminated } }

    /// Push one delivery through the update stream, as a renewal or a
    /// redelivery would arrive.
    func deliverUpdate(_ transaction: SignedStoreTransaction) {
        sync { _continuation }?.yield(transaction)
    }

    // MARK: SubscriptionStore

    func offers(for productIDs: [String]) async throws -> [SubscriptionOffer] {
        journal.record("offers")
        sync { _requestedIDs.append(productIDs) }
        return try sync { _offers }.get()
    }

    func purchase(productID: String, appAccountToken: UUID) async throws -> StorePurchaseOutcome {
        journal.record("purchase")
        sync { _appAccountTokens.append(appAccountToken) }
        sync { _onPurchase }?()
        while sync({ _holdPurchase }) { await Task.yield() }
        return try sync { _purchase }.get()
    }

    func currentEntitlements() async -> [SignedStoreTransaction] {
        journal.record("currentEntitlements")
        return sync { _entitlements }
    }

    func unfinishedTransactions() async -> [SignedStoreTransaction] {
        journal.record("unfinished")
        return sync { _unfinished }
    }

    func updates() -> AsyncStream<SignedStoreTransaction> {
        journal.record("updates")
        return AsyncStream { continuation in
            sync { _continuation = continuation }
            continuation.onTermination = { [weak self] _ in
                self?.sync { self?._updateStreamsTerminated += 1 }
            }
        }
    }

    func synchronize() async throws {
        journal.record("synchronize")
        while sync({ _holdSynchronize }) { await Task.yield() }
        try sync { _synchronize }.get()
    }

    func finish(_ id: StoreTransactionID) async {
        journal.record("finish")
        sync { _finished.append(id) }
    }

    @discardableResult
    private func sync<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }
}

private enum CapabilityStoreFailure: Error { case unavailable }

/// A Keychain-shaped store whose first clear fails. This models the only
/// retirement failure that matters: the server has converged, but the local
/// credential cannot yet be removed.
private final class FailOnceClearCapabilityStore: ApplePurchaseCapabilityStoring {
    private let lock = NSLock()
    private var encoded: String?
    private var shouldFailClear = true

    func saveCapability(_ encoded: String) throws {
        lock.lock(); defer { lock.unlock() }
        self.encoded = encoded
    }

    func loadCapability() throws -> String? {
        lock.lock(); defer { lock.unlock() }
        return encoded
    }

    func clearCapability() throws {
        lock.lock(); defer { lock.unlock() }
        if shouldFailClear {
            shouldFailClear = false
            throw CapabilityStoreFailure.unavailable
        }
        encoded = nil
    }
}

private final class LockableCapabilityStore: ApplePurchaseCapabilityStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var encoded: String?
    private var writesFail = false

    func setWritesFail(_ value: Bool) {
        lock.lock(); writesFail = value; lock.unlock()
    }
    func saveCapability(_ encoded: String) throws {
        lock.lock(); defer { lock.unlock() }
        if writesFail { throw CapabilityStoreFailure.unavailable }
        self.encoded = encoded
    }
    func loadCapability() throws -> String? {
        lock.lock(); defer { lock.unlock() }
        return encoded
    }
    func clearCapability() throws {
        lock.lock(); defer { lock.unlock() }
        if writesFail { throw CapabilityStoreFailure.unavailable }
        encoded = nil
    }
}

private final class FailingOutcomeJournal: ApplePurchaseOutcomeJournal {
    func load(ownerAccountID: String) -> ApplePurchaseOutcomeJournalEntry? { nil }
    func save(_ entry: ApplePurchaseOutcomeJournalEntry) throws {
        throw CapabilityStoreFailure.unavailable
    }
    func clear(ownerAccountID: String) throws {
        throw CapabilityStoreFailure.unavailable
    }
}

private final class ReadFailWriteSucceedCapabilityStore: ApplePurchaseCapabilityStoring {
    private(set) var saves = 0
    func saveCapability(_ encoded: String) throws { saves += 1 }
    func loadCapability() throws -> String? { throw CapabilityStoreFailure.unavailable }
    func clearCapability() throws {}
}

/// Relayium's billing endpoints, scripted.
private final class FakeBilling: AppleBillingService, @unchecked Sendable {
    private let lock = NSLock()
    private let journal: PurchaseJournal

    private var _catalog: Result<AppleProductCatalog, Error>
    private var _catalogBundleIDs: [String] = []
    private var _catalogBearers: [String] = []
    private var _accountToken: Result<UUID, Error>
    private var _dispatches: [Result<ApplePurchaseDispatch, Error>] = []
    private var _submissions: [Result<AppleTransactionResult, Error>] = []
    private var _submittedJWS: [String] = []
    private var _submittedRenewalJWS: [String] = []
    private var _submittedBearers: [String] = []
    private var _accountTokenBearers: [String] = []
    /// Submissions from this 1-based call number onwards park until released.
    /// `nil` holds nothing.
    private var _holdSubmitAfter: Int?
    /// The continuation half of every dispatch, in order, including the `nil`s a
    /// legacy client sends. Recorded so a test can assert the exact wire shape.
    private var _dispatchContinuations: [ApplePurchaseContinuationFields?] = []
    private var _dispatchProductIDs: [String] = []
    private var _reports: [ReportedOutcome] = []
    private var _outcomeFailures: [Error] = []
    /// What a delivered report ANSWERS as `resumable`, consumed in order; the
    /// last repeats. Empty means the honest answer for the outcome that was
    /// reported. Scripted separately from the request so a test can drive the
    /// real server shape where a 200 says `resumable: false` to a cancellation.
    private var _outcomeResumables: [Bool] = []
    /// What the next dispatch answers as `continuationSecret`. `nil` is the
    /// LEGACY server: no capability is issued at all.
    private var _mintSecret: String?

    struct ReportedOutcome: Equatable {
        let attemptID: String
        let appInstanceID: String
        let armRequestID: String
        let secret: String?
        let outcome: ApplePurchaseOutcome
    }

    init(journal: PurchaseJournal, accountToken: UUID) {
        self.journal = journal
        self._accountToken = .success(accountToken)
        self._catalog = .success(Fixture.serverCatalog())
    }

    func setCatalog(_ value: Result<AppleProductCatalog, Error>) { sync { _catalog = value } }
    func setAccountToken(_ value: Result<UUID, Error>) { sync { _accountToken = value } }
    func setDispatches(_ values: [Result<ApplePurchaseDispatch, Error>]) {
        sync { _dispatches = values }
    }
    /// Answers, consumed in order. The last one repeats once the list runs out.
    func setSubmissions(_ values: [Result<AppleTransactionResult, Error>]) {
        sync { _submissions = values }
    }
    /// Park every submission after the first `calls` of them, so a test can
    /// catch one genuinely in flight and supersede the operation that started
    /// it. `holdSubmit(after: 0)` parks the first.
    func holdSubmit(after calls: Int) { sync { _holdSubmitAfter = calls } }
    func releaseSubmit() { sync { _holdSubmitAfter = nil } }

    func setMintedSecret(_ value: String?) { sync { _mintSecret = value } }
    /// Failures for `reportApplePurchaseOutcome`, consumed in order; the last
    /// repeats. Empty means every report succeeds.
    func setOutcomeFailures(_ values: [Error]) { sync { _outcomeFailures = values } }
    func setOutcomeResumables(_ values: [Bool]) { sync { _outcomeResumables = values } }

    var dispatchContinuations: [ApplePurchaseContinuationFields?] { sync { _dispatchContinuations } }
    var dispatchProductIDs: [String] { sync { _dispatchProductIDs } }
    var reports: [ReportedOutcome] { sync { _reports } }

    var catalogBundleIDs: [String] { sync { _catalogBundleIDs } }
    var catalogBearers: [String] { sync { _catalogBearers } }
    var submittedJWS: [String] { sync { _submittedJWS } }
    var submittedRenewalJWS: [String] { sync { _submittedRenewalJWS } }
    var submittedBearers: [String] { sync { _submittedBearers } }
    var accountTokenBearers: [String] { sync { _accountTokenBearers } }

    func appleCatalog(bundleID: String, token: String) async throws -> AppleProductCatalog {
        journal.record("catalog")
        sync {
            _catalogBundleIDs.append(bundleID)
            _catalogBearers.append(token)
        }
        return try sync { _catalog }.get()
    }

    func dispatchApplePurchase(bundleID: String, productID: String,
                               continuation: ApplePurchaseContinuationFields?,
                               token: String) async throws -> ApplePurchaseDispatch {
        journal.record("accountToken")
        sync {
            _accountTokenBearers.append(token)
            _dispatchContinuations.append(continuation)
            _dispatchProductIDs.append(productID)
        }
        let configured: Result<ApplePurchaseDispatch, Error>? = sync {
            guard let first = _dispatches.first else { return nil }
            if _dispatches.count > 1 { _dispatches.removeFirst() }
            return first
        }
        if let configured { return try configured.get() }
        return ApplePurchaseDispatch(appAccountToken: try sync { _accountToken }.get(),
                                     attemptId: "attempt-one",
                                     continuationSecret: sync { _mintSecret })
    }

    func reportApplePurchaseOutcome(bundleID: String,
                                    attemptID: String,
                                    continuation: ApplePurchaseContinuationFields,
                                    outcome: ApplePurchaseOutcome,
                                    token: String) async throws -> Bool {
        journal.record("outcome")
        sync { _reports.append(ReportedOutcome(attemptID: attemptID,
                                               appInstanceID: continuation.appInstanceID,
                                               armRequestID: continuation.armRequestID,
                                               secret: continuation.continuationSecret,
                                               outcome: outcome)) }
        if let failure: Error = sync({
            guard let first = _outcomeFailures.first else { return nil }
            if _outcomeFailures.count > 1 { _outcomeFailures.removeFirst() }
            return first
        }) { throw failure }
        if let scripted: Bool = sync({
            guard let first = _outcomeResumables.first else { return nil }
            if _outcomeResumables.count > 1 { _outcomeResumables.removeFirst() }
            return first
        }) { return scripted }
        return outcome.isResumable
    }

    func submitAppleTransaction(signedTransactionInfo: String,
                                token: String) async throws -> AppleTransactionResult {
        try await submitAppleTransaction(signedTransactionInfo: signedTransactionInfo,
                                         signedRenewalInfo: "",
                                         token: token)
    }

    func submitAppleTransaction(signedTransactionInfo: String,
                                signedRenewalInfo: String,
                                token: String) async throws -> AppleTransactionResult {
        journal.record("submit")
        sync {
            _submittedJWS.append(signedTransactionInfo)
            _submittedRenewalJWS.append(signedRenewalInfo)
            _submittedBearers.append(token)
        }
        // Recorded BEFORE parking, so a test can see this submission is in
        // flight and act while it is.
        let mine = sync { _submittedJWS.count }
        while sync({ _holdSubmitAfter.map { mine > $0 } ?? false }) { await Task.yield() }
        let next: Result<AppleTransactionResult, Error> = sync {
            guard let first = _submissions.first else { return .failure(AppleBillingError.network) }
            if _submissions.count > 1 { _submissions.removeFirst() }
            return first
        }
        return try next.get()
    }

    @discardableResult
    private func sync<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }
}

/// Something that is not an `AppleBillingError`, for the "anything else" arm.
private struct StoreFailure: Error {}

/// The fixtures, at file scope rather than as statics on the `@MainActor` test
/// case: a default argument is evaluated in a nonisolated context, so a
/// main-actor-isolated constant cannot be one.
private enum Fixture {
    static let catalog = ["com.relayium.plus.monthly", "com.relayium.pro.yearly"]
    /// The bundle identity the model reports itself as. It is the ONE thing the
    /// catalog request asserts, and the server narrows the answer with it.
    static let bundleID = "com.relayium.mac"

    /// The server's half of the catalog, in the order the deployment ranks its
    /// tiers — which is the order the model must preserve.
    static func products(_ ids: [String] = catalog) -> [AppleCatalogProduct] {
        ids.enumerated().map { index, id in
            AppleCatalogProduct(productId: id, planId: index == 0 ? "plus" : "pro",
                                planName: index == 0 ? "Plus" : "Pro",
                                cycle: index == 0 ? "monthly" : "yearly",
                                sortOrder: Int64(10 * (index + 1)),
                                storageBytes: Int64(index + 1) << 30,
                                trafficBytes: Int64(20 * (index + 1)) << 30)
        }
    }

    /// A server that IS selling, and says so. `purchases: nil` — the shape an
    /// older deployment sends — is a separate fixture below, because "no gate
    /// field" and "gate open" must be provably the same answer.
    static let gateOpen = AppleCatalogPurchases(enabled: true, reason: "")
    static let gatePaused = AppleCatalogPurchases(enabled: false, reason: "paused")

    static func serverCatalog(_ ids: [String] = catalog,
                              allowed: Bool = true,
                              blockedBy: String = "",
                              bundleId: String = bundleID,
                              products: [AppleCatalogProduct]? = nil,
                              purchases: AppleCatalogPurchases? = gateOpen) -> AppleProductCatalog {
        AppleProductCatalog(bundleId: bundleId, products: products ?? Self.products(ids),
                            purchase: AppleCatalogPurchase(allowed: allowed,
                                                           blockedBy: blockedBy),
                            purchases: purchases)
    }

    /// What a PAUSED deployment actually answers: the gate closed and no
    /// products at all, because zero products is what stops the already-shipped
    /// build starting a purchase.
    static func pausedCatalog() -> AppleProductCatalog {
        serverCatalog(products: [], purchases: gatePaused)
    }
    static let accountToken = UUID(uuidString: "3F2504E0-4F89-41D3-9A0C-0305E82C3301")!
    static let jws = "eyJhbGciOiJFUzI1NiJ9.eyJ0eCI6IjEifQ.SIG-not-touched_-~"
    static let delivery = SignedStoreTransaction(
        id: StoreTransactionID(rawValue: 7_001), jws: jws, renewalJWS: "renewal-jws")
    static let entitlement = AppleTransactionResult(
        applied: true, planId: "plus", status: "active",
        expiresAt: 1_786_000_000, provider: "apple")

    static func offers(_ ids: [String]) -> [SubscriptionOffer] {
        ids.map { SubscriptionOffer(id: $0, displayName: "Relayium", description: "d",
                                    displayPrice: "$1.00") }
    }

    /// Every class of refusal the finish policy enumerates, in one list, so a
    /// new one cannot be added to the client without landing here.
    static let everyRefusal: [AppleSubscriptionFailure] = [
        .billing(.network),                  // transport — the server may have applied it
        .billing(.decoding),                 // an answer nobody could read
        .billing(.invalidTransaction),       // 400, incl. an unmapped product
        .billing(.server(status: 400)),      // 400 with no documented code
        .billing(.notSignedIn),              // 401
        .billing(.tokenMismatch),            // 403
        .billing(.server(status: 403)),
        .billing(.subscriptionOwned),        // 409
        .billing(.appleSubscriptionConflict), // 409, another live Apple subscription
        .billing(.server(status: 409)),
        .billing(.rateLimited),              // 429
        .billing(.server(status: 500)),
        .billing(.verifierUnavailable),      // 503 — today's shipping default
        .billing(.server(status: 503)),
        .billing(.unknownBundle),            // 400 unknown_bundle — the wrong build
        .unexpected(type: "StoreFailure"),   // anything this layer has no case for
    ]
}

// MARK: - tests

/// The purchase orchestration: what it does with a delivered transaction, and —
/// far more importantly — what it refuses to do with one.
///
/// **The claim this file exists to defend.** Finishing a transaction tells the
/// App Store to stop redelivering it. That redelivery is the only automatic path
/// by which a purchase somebody has already paid for can reach their Relayium
/// account after something went wrong, and nothing on the device can recreate a
/// JWS the store has been told to forget. So the tests below are mostly
/// assertions that `finish` was NOT called — one per class of refusal, including
/// the ones that look permanent.
@MainActor
final class AppleSubscriptionModelTests: XCTestCase {

    /// One assembled model plus everything the test can drive it with.
    private struct Rig {
        let model: AppleSubscriptionModel
        let store: FakeStore
        let billing: FakeBilling
        let journal: PurchaseJournal
        let bearer: BearerBox
    }

    /// The session's credential, changeable mid-test — signing out while a
    /// purchase sheet is open is a real sequence, not a hypothetical one.
    private final class BearerBox: @unchecked Sendable {
        private let lock = NSLock()
        private var value: String?
        init(_ value: String?) { self.value = value }
        var current: String? { lock.lock(); defer { lock.unlock() }; return value }
        func set(_ new: String?) { lock.lock(); value = new; lock.unlock() }
    }

    private func makeRig(
        bearer: String? = "rlm_app_T",
        purchaseDispatchPolicy: ApplePurchaseDispatchPolicy = .legacyOneShot
    ) -> Rig {
        let journal = PurchaseJournal()
        let store = FakeStore(journal: journal)
        let billing = FakeBilling(journal: journal, accountToken: Fixture.accountToken)
        let box = BearerBox(bearer)
        let model = AppleSubscriptionModel(
            store: store, billing: billing, bundleID: Fixture.bundleID,
            bearer: { box.current },
            accountID: { "acct-A" },
            refreshAccount: { journal.record("refresh") },
            purchaseDispatchPolicy: purchaseDispatchPolicy)
        return Rig(model: model, store: store, billing: billing, journal: journal, bearer: box)
    }

    /// A rig that speaks the **continuation protocol**, over a capability store
    /// a test can inspect and pre-seed.
    ///
    /// `makeRig` above deliberately builds a LEGACY model instead — no
    /// capability, no instance — which is why every other test in this file goes
    /// on proving the shipped one-shot behaviour unchanged.
    private func makeContinuationRig(
        store capabilityStore: ApplePurchaseCapabilityStoring,
        bearer: String? = "rlm_app_T",
        appInstanceID: String = "instance-A",
        outcomeJournal: ApplePurchaseOutcomeJournal = InMemoryApplePurchaseOutcomeJournal()
    ) -> Rig {
        let journal = PurchaseJournal()
        let store = FakeStore(journal: journal)
        let billing = FakeBilling(journal: journal, accountToken: Fixture.accountToken)
        let box = BearerBox(bearer)
        let model = AppleSubscriptionModel(
            store: store, billing: billing, bundleID: Fixture.bundleID,
            bearer: { box.current },
            accountID: { "acct-A" },
            refreshAccount: { journal.record("refresh") },
            continuation: ApplePurchaseCapabilityRepository(store: capabilityStore),
            outcomeJournal: outcomeJournal,
            appInstanceID: appInstanceID)
        return Rig(model: model, store: store, billing: billing, journal: journal, bearer: box)
    }

    private func makeReadyContinuationRig(
        store capabilityStore: ApplePurchaseCapabilityStoring,
        appInstanceID: String = "instance-A"
    ) async -> Rig {
        let rig = makeContinuationRig(store: capabilityStore, appInstanceID: appInstanceID)
        rig.store.setOffers(.success(Fixture.offers(Fixture.catalog)))
        await rig.model.loadOffers()
        rig.store.setPurchase(.success(.delivered(Fixture.delivery)))
        rig.billing.setSubmissions([.success(Fixture.entitlement)])
        return rig
    }

    /// A rig whose offers are already loaded, which is the precondition every
    /// purchase has.
    ///
    /// The load ALWAYS runs signed in, and `bearer` is applied afterwards. The
    /// catalog read is authenticated now, so a rig built signed out could never
    /// have offers at all — and the signed-out cases below are about a session
    /// that ended after the screen was drawn, which is the sequence that
    /// actually happens.
    private func makeReadyRig(bearer: String? = "rlm_app_T") async -> Rig {
        let rig = makeRig()
        rig.store.setOffers(.success(Fixture.offers(Fixture.catalog)))
        await rig.model.loadOffers()
        rig.bearer.set(bearer)
        rig.store.setPurchase(.success(.delivered(Fixture.delivery)))
        rig.billing.setSubmissions([.success(Fixture.entitlement)])
        return rig
    }

    // MARK: - the finish rule, stated on its own

    /// The rule, isolated from every path that uses it. One arm permits it.
    func testOnlyAnAcceptedSubmissionPermitsFinish() {
        XCTAssertTrue(AppleSubmission.accepted(Fixture.entitlement).permitsFinish)
        // A decoded 200 is not enough: stale/ambiguous facts deliberately remain
        // available to updates/restore until a canonical apply succeeds.
        XCTAssertFalse(AppleSubmission.accepted(
            AppleTransactionResult(applied: false, planId: "free", status: "canceled",
                                   expiresAt: 0, provider: "apple")).permitsFinish)
        XCTAssertFalse(AppleSubmission.accepted(
            AppleTransactionResult(applied: true, planId: "pro", status: "active",
                                   expiresAt: 1_786_000_000, provider: "apple",
                                   dispatchPending: true, dispatchResolved: false)).permitsFinish)
        for failure in Fixture.everyRefusal {
            XCTAssertFalse(AppleSubmission.refused(failure).permitsFinish,
                           "\(failure) permits a finish")
        }
    }

    /// **Every one of the eight `(applied, dispatchPending, dispatchResolved)`
    /// shapes, enumerated rather than sampled.**
    ///
    /// The rule is `dispatchResolved || (applied && !dispatchPending)`, and it
    /// is written here as a table instead of as the expression again — a test
    /// that re-derives the implementation agrees with any bug the
    /// implementation has.
    ///
    /// Two rows are the reason this test exists, and neither is theoretical:
    ///
    ///  * `(false, false, true)` is the **exact triplet a production server
    ///    returns today** after the cancellation-recovery batch, when it
    ///    converges on a transaction it has already accounted for. The previous
    ///    `applied`-requiring rule answered `false` here, which meant StoreKit
    ///    redelivered that transaction forever and every redelivery got the same
    ///    answer. It MUST finish.
    ///  * `(true, true, false)` MUST NOT finish even though this call recorded
    ///    the JWS: a dispatch still pending and unresolved may still have an arm
    ///    open, and the redelivery is what reconciliation depends on.
    ///
    /// The pair `(false, true, false)` / `(true, true, false)` together state
    /// the unresolved-pending refusal for BOTH values of `applied`, and
    /// `(false, true, true)` / `(true, true, true)` state that `dispatchResolved`
    /// dominates `dispatchPending` either way.
    func testTheFinishRuleIsExhaustiveOverEveryDispatchShape() {
        // (applied, dispatchPending, dispatchResolved, may finish)
        let table: [(Bool, Bool, Bool, Bool)] = [
            (false, false, false, false),  // nothing recorded, nothing settled
            (false, false, true,  true),   // THE REAL PRODUCTION RESPONSE
            (false, true,  false, false),  // unresolved pending, not applied
            (false, true,  true,  true),   // resolved dominates pending
            (true,  false, false, true),   // recorded by this call, no dispatch question
            (true,  false, true,  true),   // both reasons at once
            (true,  true,  false, false),  // unresolved pending, applied does NOT rescue it
            (true,  true,  true,  true),   // resolved dominates pending
        ]
        for (applied, pending, resolved, expected) in table {
            let result = AppleTransactionResult(
                applied: applied, planId: "pro", status: "active",
                expiresAt: 1_786_000_000, provider: "apple",
                dispatchPending: pending, dispatchResolved: resolved)
            XCTAssertEqual(
                AppleSubmission.accepted(result).permitsFinish, expected,
                "applied=\(applied) dispatchPending=\(pending) dispatchResolved=\(resolved)")
        }
        // The table covers every combination exactly once, so a row silently
        // dropped in an edit is a failure rather than thinner coverage.
        XCTAssertEqual(Set(table.map { [$0.0, $0.1, $0.2] }).count, 8)
        // No refusal finishes, whatever the accepted table says.
        for failure in Fixture.everyRefusal {
            XCTAssertFalse(AppleSubmission.refused(failure).permitsFinish)
        }
    }

    /// The production shape again, driven through the **whole purchase path**
    /// rather than asserted on the value in isolation.
    ///
    /// `testAnUnappliedRedeliveryRemainsAvailableForReconciliation` above is its
    /// deliberate opposite: same `applied=false`, but nothing resolved, so the
    /// transaction stays with the store. The two together are what separate "not
    /// applied" from "not settled".
    func testAResolvedStaleAcceptanceFinishesTheTransaction() async {
        let rig = await makeReadyRig()
        let resolvedStale = AppleTransactionResult(applied: false, planId: "plus", status: "active",
                                                   expiresAt: 1_786_000_000, provider: "apple",
                                                   dispatchPending: false, dispatchResolved: true)
        rig.store.setPurchase(.success(.delivered(Fixture.delivery)))
        rig.billing.setSubmissions([.success(resolvedStale)])
        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.store.finished, [Fixture.delivery.id],
                       "a resolved acceptance was left for endless redelivery")
        XCTAssertEqual(rig.model.state, .completed(resolvedStale))
    }

    // MARK: - the successful purchase, in order

    /// The whole ordering claim in one test: re-read the catalog, attribute,
    /// buy, SUBMIT, then finish, then reload the account from the server.
    ///
    /// The second `catalog` is the point-of-sale re-check — the sale proceeds
    /// only because the fresh answer still carries the displayed offer. `submit`
    /// before `finish` is the safety property. `refresh` after acceptance is
    /// the authority property — what the user ends up seeing is `/api/me`'s
    /// answer, not anything this model concluded.
    func testASuccessfulPurchaseSubmitsThenFinishesThenRefreshes() async {
        let rig = await makeReadyRig()
        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.journal.all,
                       ["catalog", "offers", "catalog", "accountToken", "purchase",
                        "submit", "finish", "refresh"])
        XCTAssertEqual(rig.model.state, .completed(Fixture.entitlement))
        XCTAssertEqual(rig.store.finished, [Fixture.delivery.id])
    }

    /// The purchase is attributed with the SERVER's token, and the JWS reaches
    /// the server exactly as the store produced it.
    func testThePurchaseCarriesTheServerTokenAndSubmitsTheJWSUnchanged() async {
        let rig = await makeReadyRig()
        rig.store.setPurchase(.success(.delivered(Fixture.delivery)))
        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.store.appAccountTokens, [Fixture.accountToken],
                       "the purchase was attributed with something other than the server's token")
        XCTAssertEqual(rig.billing.accountTokenBearers, ["rlm_app_T"])
        XCTAssertEqual(rig.billing.submittedJWS, [Fixture.jws],
                       "the JWS was altered between the store and the server")
        XCTAssertEqual(rig.billing.submittedRenewalJWS, ["renewal-jws"],
                       "the renewal JWS was altered or omitted between the store and the server")
        XCTAssertEqual(rig.billing.submittedBearers, ["rlm_app_T"])
    }

    /// The account token is fetched BEFORE the store is asked to charge anyone.
    /// A server that cannot mint one leaves no purchase sheet and no money moved.
    func testAFailureToMintTheAccountTokenNeverReachesTheStore() async {
        let rig = await makeReadyRig()
        rig.billing.setAccountToken(.failure(AppleBillingError.server(status: 500)))
        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.journal.all, ["catalog", "offers", "catalog", "accountToken"])
        XCTAssertEqual(rig.model.state, .failed(.billing(.server(status: 500))))
        XCTAssertTrue(rig.store.finished.isEmpty)
    }

    // MARK: - nothing happened

    /// Cancelling means nothing happened: no submission, no finish, no refresh,
    /// and no error the user did not cause.
    func testACancelledPurchaseSubmitsNothingAndFinishesNothing() async {
        let rig = await makeReadyRig()
        rig.store.setPurchase(.success(.userCancelled))
        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.journal.all, ["catalog", "offers", "catalog", "accountToken", "purchase"])
        XCTAssertEqual(rig.model.state, .idle)
        XCTAssertTrue(rig.store.finished.isEmpty)
        XCTAssertEqual(rig.journal.count("refresh"), 0)
    }

    /// Ask to Buy produces no transaction, so there is nothing to submit and —
    /// the half that matters — nothing that could be finished. If it is approved
    /// later it arrives through the update stream like any other delivery.
    func testAPendingPurchaseSubmitsNothingAndFinishesNothing() async {
        let rig = await makeReadyRig()
        rig.store.setPurchase(.success(.pending))
        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.journal.all, ["catalog", "offers", "catalog", "accountToken", "purchase"])
        XCTAssertEqual(rig.model.state, .deferred)
        XCTAssertTrue(rig.store.finished.isEmpty)
        XCTAssertEqual(rig.journal.count("refresh"), 0)
    }

    /// A client outcome is not provider authority. Once the server emitted a
    /// dispatch, a modified client must not turn Cancel or Ask to Buy into a
    /// second StoreKit sheet.
    ///
    /// This drives the LEGACY model, which has no capability and therefore no
    /// way to report an outcome at all. For `pending` the store still redelivers
    /// if it becomes a charge; for `userCancelled` **nothing recovers it** —
    /// there is no signed transaction for `Transaction.updates` or `restore` to
    /// carry — which is the deadlock the continuation protocol exists to remove.
    /// Refusing the second sheet is still correct here: a legacy client cannot
    /// prove the first one is closed.
    func testAnUnresolvedDispatchNeverOpensASecondStoreKitSheet() async {
        for firstOutcome in [StorePurchaseOutcome.userCancelled, .pending] {
            let rig = await makeReadyRig()
            rig.store.setPurchase(.success(firstOutcome))
            rig.billing.setDispatches([
                .success(ApplePurchaseDispatch(appAccountToken: Fixture.accountToken,
                                               attemptId: "attempt-one")),
                .failure(AppleBillingError.purchaseAuthorityManaged(provider: "apple")),
            ])

            await rig.model.purchase(productID: Fixture.catalog[0])
            await rig.model.purchase(productID: Fixture.catalog[0])

            XCTAssertEqual(rig.journal.count("purchase"), 1,
                           "\(firstOutcome) opened a second StoreKit sheet")
            XCTAssertEqual(rig.model.state,
                           .failed(.purchaseNotAllowed(blockedBy: "apple")))
            XCTAssertTrue(rig.store.finished.isEmpty)
        }
    }

    func testDurableContinuationPolicyRefusesBeforeDispatchWhenCapabilityIsUnavailable() async {
        let rig = makeRig(purchaseDispatchPolicy: .durableContinuationRequired)
        rig.billing.setCatalog(.success(Fixture.serverCatalog()))
        rig.store.setOffers(.success(Fixture.offers(Fixture.catalog)))
        await rig.model.loadOffers()

        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.model.state, .failed(.billing(.continuationRejected)))
        XCTAssertTrue(rig.billing.dispatchContinuations.isEmpty)
        XCTAssertEqual(rig.journal.count("accountToken"), 0)
        XCTAssertEqual(rig.journal.count("purchase"), 0)
        XCTAssertTrue(rig.store.appAccountTokens.isEmpty)
    }

    func testCapabilityReadFailureNeverOverwritesAnUnknownExistingSecret() async {
        let capabilityStore = ReadFailWriteSucceedCapabilityStore()
        let rig = makeContinuationRig(store: capabilityStore)
        rig.store.setOffers(.success(Fixture.offers(Fixture.catalog)))
        await rig.model.loadOffers()

        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.model.state, .failed(.billing(.continuationRejected)))
        XCTAssertEqual(capabilityStore.saves, 0)
        XCTAssertTrue(rig.billing.dispatchContinuations.isEmpty)
        XCTAssertEqual(rig.journal.count("purchase"), 0)
    }

    // MARK: - signed out

    /// Signed out, nothing is asked of the store OR of the billing service. A
    /// purchase started here would be a charge with no account to attribute to,
    /// and StoreKit would complete it perfectly happily.
    func testASignedOutPurchaseTouchesNeitherDependency() async {
        let rig = await makeReadyRig(bearer: nil)
        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.journal.all, ["catalog", "offers"], "a signed-out purchase reached a dependency")
        XCTAssertEqual(rig.model.state, .failed(.billing(.notSignedIn)))
    }

    /// An empty string is not a credential. Sending it would produce an
    /// `Authorization: Bearer ` header that can only be refused.
    func testAnEmptyBearerIsTreatedAsSignedOut() async {
        let rig = await makeReadyRig(bearer: "")
        await rig.model.purchase(productID: Fixture.catalog[0])
        XCTAssertEqual(rig.journal.all, ["catalog", "offers"])
        XCTAssertEqual(rig.model.state, .failed(.billing(.notSignedIn)))
    }

    /// **Signing out while the purchase sheet is open.** The store delivers, and
    /// by then there is no session to submit under. Nothing is submitted and —
    /// the load-bearing half — nothing is finished, so the store keeps the
    /// transaction and offers it again after the next sign-in.
    func testSigningOutMidPurchaseSubmitsNothingAndFinishesNothing() async {
        let rig = await makeReadyRig()
        // The session ends at the moment the store is charging, which is the
        // only truthful place to stage it: everything before that point still
        // had a credential.
        let box = rig.bearer
        rig.store.setOnPurchase { box.set(nil) }
        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.journal.all, ["catalog", "offers", "catalog", "accountToken", "purchase"])
        XCTAssertEqual(rig.model.state, .failed(.billing(.notSignedIn)))
        XCTAssertTrue(rig.store.finished.isEmpty)
    }

    // MARK: - the catalog is the server's

    /// **The identifiers come from the server, and the store is asked about
    /// exactly those.** This is the property that replaced a compiled-in list:
    /// a build cannot offer a product the deployment has no mapping for, because
    /// it never learns such a product's identifier.
    func testTheStoreIsAskedForExactlyWhatTheServerNamed() async {
        let rig = makeRig()
        rig.billing.setCatalog(.success(Fixture.serverCatalog(["only.one"])))
        rig.store.setOffers(.success(Fixture.offers(["only.one"])))

        await rig.model.loadOffers()

        XCTAssertEqual(rig.billing.catalogBundleIDs, [Fixture.bundleID])
        XCTAssertEqual(rig.store.requestedIDs, [["only.one"]],
                       "the store was asked about something the server did not name")
        XCTAssertEqual(rig.model.offers.map(\.id), ["only.one"])
        XCTAssertEqual(rig.model.state, .idle)
    }

    /// The catalog read is authenticated with the credential held AT THE MOMENT
    /// of the call — never a captured one.
    func testTheCatalogIsReadWithTheSessionsCurrentBearer() async {
        let rig = makeRig()
        await rig.model.loadOffers()
        XCTAssertEqual(rig.billing.catalogBearers, ["rlm_app_T"])
    }

    /// Signed out, nothing is asked of either dependency: the catalog answer is
    /// per-account, so there is no useful one to fetch, and a 401 in front of
    /// somebody who has simply not signed in yet is not an answer.
    func testASignedOutLoadTouchesNeitherDependency() async {
        let rig = makeRig(bearer: nil)
        await rig.model.loadOffers()

        XCTAssertEqual(rig.journal.all, [], "a signed-out load reached a dependency")
        XCTAssertEqual(rig.model.state, .failed(.billing(.notSignedIn)))
        XCTAssertTrue(rig.model.offers.isEmpty)
        XCTAssertNil(rig.model.eligibility)
    }

    /// A configured deployment with no live mapping for this build. Nothing went
    /// wrong, so it is not a failure — and the store is never asked, because
    /// there is nothing to ask it about.
    func testAnEmptyServerCatalogIsUnavailableAndNeverReachesTheStore() async {
        let rig = makeRig()
        rig.billing.setCatalog(.success(Fixture.serverCatalog([])))

        await rig.model.loadOffers()

        XCTAssertEqual(rig.journal.all, ["catalog"], "the store was asked about nothing")
        XCTAssertEqual(rig.model.state, .unavailable)
        XCTAssertTrue(rig.model.offers.isEmpty)
        // The eligibility answer still lands: "you cannot buy here because your
        // subscription is managed elsewhere" is owed even with nothing on sale.
        XCTAssertEqual(rig.model.eligibility?.allowed, true)
    }

    /// A store that recognises none of the server's identifiers leaves the user
    /// where an empty catalog does — nothing to buy — so it is reported the same
    /// way rather than as an idle screen with no products on it.
    func testAStoreThatKnowsNoneOfTheCatalogIsAlsoUnavailable() async {
        let rig = makeRig()
        rig.store.setOffers(.success([]))
        await rig.model.loadOffers()
        XCTAssertEqual(rig.model.state, .unavailable)
        XCTAssertTrue(rig.model.offers.isEmpty)
    }

    /// A product the SERVER named but the store does not know is dropped rather
    /// than rendered. It is a mapping whose App Store Connect record does not
    /// exist yet, or is not approved in this storefront; offering it would put a
    /// purchase behind a sheet that cannot open.
    func testAProductTheStoreDoesNotKnowIsDroppedAndTheRestSurvive() async {
        let rig = makeRig()
        rig.store.setOffers(.success(Fixture.offers([Fixture.catalog[1]])))

        await rig.model.loadOffers()

        XCTAssertEqual(rig.model.offers.map(\.id), [Fixture.catalog[1]])
        XCTAssertEqual(rig.model.state, .idle)
    }

    /// The SERVER's order is what the surface reads down — the deployment's own
    /// tier rank — regardless of the order the store answered in.
    func testTheServersTierOrderSurvivesTheStoresOwnOrdering() async {
        let rig = makeRig()
        rig.store.setOffers(.success(Fixture.offers(Fixture.catalog.reversed())))

        await rig.model.loadOffers()

        XCTAssertEqual(rig.model.offers.map(\.id), Fixture.catalog)
        XCTAssertEqual(rig.model.offers.map(\.product.planName), ["Plus", "Pro"])
    }

    /// A product that was never offered cannot be priced or described, and a
    /// charge behind it would be for something this build has never seen.
    func testAProductThatWasNeverOfferedCannotBePurchased() async {
        let rig = await makeReadyRig()
        await rig.model.purchase(productID: "com.relayium.something.else")
        XCTAssertEqual(rig.journal.all, ["catalog", "offers"])
        XCTAssertEqual(rig.model.state, .unavailable)
    }

    func testAFailedStoreLoadClearsTheOffersRatherThanKeepingStaleOnes() async {
        let rig = makeRig()
        rig.store.setOffers(.success(Fixture.offers(Fixture.catalog)))
        await rig.model.loadOffers()
        XCTAssertEqual(rig.model.offers.count, 2)
        rig.store.setOffers(.failure(StoreFailure()))
        await rig.model.loadOffers()
        XCTAssertTrue(rig.model.offers.isEmpty)
        XCTAssertEqual(rig.model.state, .failed(.unexpected(type: "StoreFailure")))
    }

    /// **A failed catalog read clears the eligibility answer too.** A stale
    /// "you may buy", left beside a failure that may itself BE the eligibility
    /// answer going missing, is the one combination that could leave a live
    /// purchase control on a screen whose state is unknown.
    func testAFailedCatalogReadClearsEligibilityAsWellAsOffers() async {
        let rig = makeRig()
        await rig.model.loadOffers()
        XCTAssertEqual(rig.model.eligibility?.allowed, true)

        rig.billing.setCatalog(.failure(AppleBillingError.network))
        await rig.model.loadOffers()

        XCTAssertNil(rig.model.eligibility)
        XCTAssertTrue(rig.model.offers.isEmpty)
        XCTAssertEqual(rig.model.state, .failed(.billing(.network)))
    }

    /// The wrong BUILD talking to this deployment. It is not a statement about a
    /// purchase, so it must not be reported as one.
    func testAnUnknownBundleIsReportedAsItsOwnFailure() async {
        let rig = makeRig()
        rig.billing.setCatalog(.failure(AppleBillingError.unknownBundle))
        await rig.model.loadOffers()
        XCTAssertEqual(rig.model.state, .failed(.billing(.unknownBundle)))
    }

    // MARK: - eligibility is the server's answer, re-checked at the point of sale

    /// **The server said no, and no purchase is started.** The screen was
    /// rendered from a catalog read that may be minutes old; a Stripe
    /// subscription begun in a browser since then is exactly the double-billing
    /// this refuses. Nothing reaches the store, so nothing is charged.
    func testAPurchaseTheServerBlockedNeverReachesTheStore() async {
        let rig = makeRig()
        rig.billing.setCatalog(.success(
            Fixture.serverCatalog(allowed: false, blockedBy: "stripe")))
        rig.store.setOffers(.success(Fixture.offers(Fixture.catalog)))
        await rig.model.loadOffers()

        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.journal.all, ["catalog", "offers"],
                       "a blocked purchase reached a dependency: \(rig.journal.all)")
        XCTAssertEqual(rig.model.state, .failed(.purchaseNotAllowed(blockedBy: "stripe")))
        XCTAssertTrue(rig.store.finished.isEmpty)
    }

    /// **Unknown is not permission**, and the two halves are cleared together so
    /// the state cannot be reached from the other direction either: a failed
    /// catalog read drops the offers AND the eligibility answer, so there is
    /// nothing to press and nothing that could be mistaken for a yes.
    func testAFailedCatalogReadLeavesNothingPurchasable() async {
        let rig = await makeReadyRig()
        rig.billing.setCatalog(.failure(AppleBillingError.network))
        await rig.model.loadOffers()
        XCTAssertNil(rig.model.eligibility)
        XCTAssertTrue(rig.model.offers.isEmpty)

        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.model.state, .unavailable)
        XCTAssertTrue(rig.store.appAccountTokens.isEmpty,
                      "a purchase started with no eligibility answer")
        XCTAssertTrue(rig.store.finished.isEmpty)
    }

    /// And the guard itself, exercised directly: offers present, eligibility
    /// explicitly absent. Unreachable through `loadOffers` by construction —
    /// which is the point — so it is staged here rather than assumed.
    func testTheEligibilityGuardRefusesWhenTheAnswerIsAbsent() async {
        let rig = makeRig()
        rig.billing.setCatalog(.success(Fixture.serverCatalog(allowed: false, blockedBy: "")))
        rig.store.setOffers(.success(Fixture.offers(Fixture.catalog)))
        await rig.model.loadOffers()

        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.model.state, .failed(.purchaseNotAllowed(blockedBy: "")))
        XCTAssertTrue(rig.store.appAccountTokens.isEmpty)
    }

    /// A restore is deliberately NOT gated on eligibility. It submits what this
    /// Apple ID already owns, and refusing to run one because a browser session
    /// blocks a NEW purchase would strand a subscription already paid for.
    func testARestoreRunsEvenWhenANewPurchaseIsBlocked() async {
        let rig = makeRig()
        rig.billing.setCatalog(.success(
            Fixture.serverCatalog(allowed: false, blockedBy: "stripe")))
        await rig.model.loadOffers()
        rig.store.setEntitlements([Fixture.delivery])
        rig.billing.setSubmissions([.success(Fixture.entitlement)])

        await rig.model.restore()

        XCTAssertEqual(rig.store.finished, [Fixture.delivery.id])
        XCTAssertEqual(rig.model.state, .completed(Fixture.entitlement))
    }

    // MARK: - the global purchase gate

    /// A paused deployment reads as PAUSED, not as "nothing on sale".
    ///
    /// The two arrive at this layer looking identical — a paused server answers
    /// with an empty product list, because that is what stops the build that is
    /// already in the App Store — so the gate flag is the only thing that can
    /// tell them apart. The store is never asked for products, since there are
    /// none to ask about.
    func testAPausedServerLoadsAsPausedRatherThanNothingOnSale() async {
        let rig = makeRig()
        rig.billing.setCatalog(.success(Fixture.pausedCatalog()))

        await rig.model.loadOffers()

        XCTAssertEqual(rig.model.state, .purchasesPaused)
        XCTAssertTrue(rig.model.offers.isEmpty)
        XCTAssertEqual(rig.journal.all, ["catalog"])
    }

    /// **A server that sends no gate field at all is not paused.** That is every
    /// deployment older than the field, including self-hosted ones, and treating
    /// the absence as "closed" would stop them selling anything the moment this
    /// client shipped.
    func testAServerWithNoGateFieldStillSells() async {
        let rig = makeRig()
        rig.billing.setCatalog(.success(Fixture.serverCatalog(purchases: nil)))
        rig.store.setOffers(.success(Fixture.offers(Fixture.catalog)))

        await rig.model.loadOffers()

        XCTAssertEqual(rig.model.state, .idle)
        XCTAssertEqual(rig.model.offers.map(\.id), Fixture.catalog)
    }

    /// Resuming is a plain reload away: nothing about the pause is remembered
    /// locally, so the next load offers exactly what it offered before.
    func testResumingTheGateRestoresTheSameOffers() async {
        let rig = makeRig()
        rig.store.setOffers(.success(Fixture.offers(Fixture.catalog)))
        rig.billing.setCatalog(.success(Fixture.pausedCatalog()))
        await rig.model.loadOffers()
        XCTAssertEqual(rig.model.state, .purchasesPaused)

        rig.billing.setCatalog(.success(Fixture.serverCatalog()))
        await rig.model.loadOffers()

        XCTAssertEqual(rig.model.state, .idle)
        XCTAssertEqual(rig.model.offers.map(\.id), Fixture.catalog)
    }

    /// **Losing the race against the operator costs the user nothing.**
    ///
    /// The screen was drawn while the server was selling and Subscribe is
    /// pressed after the gate closed. The point-of-sale re-read catches it
    /// BEFORE the account token is minted and before the store is asked, so
    /// nothing is charged and nothing is finished — and the refusal is reported
    /// as the pause it is rather than as the `.selectionChanged` the empty
    /// product list alone would produce.
    func testRacingThePauseRefusesTheSaleBeforeAnythingCanBeCharged() async {
        let rig = await makeReadyRig()
        rig.billing.setCatalog(.success(Fixture.pausedCatalog()))

        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.model.state, .failed(.purchasesPaused))
        XCTAssertEqual(rig.journal.all, ["catalog", "offers", "catalog"])
        XCTAssertTrue(rig.store.appAccountTokens.isEmpty)
        XCTAssertTrue(rig.store.finished.isEmpty)
    }

    /// **Restoring works while new purchases are paused.** The person reaching
    /// for it has already paid, and a pause on SELLING must never become a pause
    /// on honouring what was sold.
    func testARestoreRunsWhileNewPurchasesArePaused() async {
        let rig = makeRig()
        rig.billing.setCatalog(.success(Fixture.pausedCatalog()))
        await rig.model.loadOffers()
        XCTAssertEqual(rig.model.state, .purchasesPaused)
        rig.store.setEntitlements([Fixture.delivery])
        rig.billing.setSubmissions([.success(Fixture.entitlement)])

        await rig.model.restore()

        XCTAssertEqual(rig.store.finished, [Fixture.delivery.id])
        XCTAssertEqual(rig.model.state, .completed(Fixture.entitlement))
        XCTAssertEqual(rig.journal.count("refresh"), 1)
    }

    /// **And so does a delivery the store makes on its own.** A renewal, an
    /// Ask-to-Buy approval or a redelivery of an unaccepted purchase all arrive
    /// through the update stream, all represent money that has already moved,
    /// and none of them is a new purchase. The gate is not consulted anywhere on
    /// this path.
    func testAStoreDeliveryIsSubmittedAndFinishedWhilePurchasesArePaused() async {
        let rig = makeRig()
        rig.billing.setCatalog(.success(Fixture.pausedCatalog()))
        await rig.model.loadOffers()
        rig.billing.setSubmissions([.success(Fixture.entitlement)])
        rig.model.startObservingUpdates()

        rig.store.deliverUpdate(Fixture.delivery)
        await waitFor(rig) { $0.journal.count("refresh") == 1 }

        XCTAssertEqual(rig.billing.submittedJWS, [Fixture.jws])
        XCTAssertEqual(rig.store.finished, [Fixture.delivery.id])
        rig.model.stop()
    }

    /// What a tier grants travels from the server through the model untouched,
    /// so the row the surface words is describing the deployment's own figures.
    func testTheServersQuotaFiguresReachTheOffers() async {
        let rig = await makeReadyRig()
        XCTAssertEqual(rig.model.offers.map(\.product.storageBytes),
                       [1 << 30, 2 << 30])
        XCTAssertEqual(rig.model.offers.map(\.product.trafficBytes),
                       [20 << 30, 40 << 30])
    }

    // MARK: - the sale is re-checked against a fresh catalog

    /// **Allowed when the screen was drawn, blocked by the time of the click.**
    /// A Stripe subscription started in a browser in between is exactly the
    /// double-billing the point-of-sale re-read exists to refuse. Nothing
    /// reaches the account token or the store, so nothing can be charged.
    func testAPurchaseBlockedSinceTheScreenWasDrawnIsRefusedByTheFreshCatalog() async {
        let rig = await makeReadyRig()
        rig.billing.setCatalog(.success(
            Fixture.serverCatalog(allowed: false, blockedBy: "stripe")))

        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.journal.all, ["catalog", "offers", "catalog"],
                       "a freshly blocked purchase went past the re-check")
        XCTAssertEqual(rig.model.state, .failed(.purchaseNotAllowed(blockedBy: "stripe")))
        XCTAssertTrue(rig.store.appAccountTokens.isEmpty)
        XCTAssertTrue(rig.store.finished.isEmpty)
    }

    /// The selected product was retired between the screen and the click. What
    /// remains on sale is not what the user agreed to, so nothing is bought —
    /// a purchase of a retired row is exactly the one the server's intake would
    /// refuse AFTER the money moved.
    func testAProductRetiredSinceTheScreenWasDrawnIsNotPurchased() async {
        let rig = await makeReadyRig()
        rig.billing.setCatalog(.success(Fixture.serverCatalog([Fixture.catalog[1]])))

        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.journal.all, ["catalog", "offers", "catalog"],
                       "a retired selection went past the re-check")
        XCTAssertEqual(rig.model.state, .failed(.selectionChanged))
        XCTAssertTrue(rig.store.appAccountTokens.isEmpty)
        XCTAssertTrue(rig.store.finished.isEmpty)
    }

    /// The identifier survived but the mapping behind it changed — a different
    /// tier, name or cycle than the screen showed. The comparison is the WHOLE
    /// displayed row, not the identifier: buying through it would charge for a
    /// tier the user never saw beside the price they agreed to.
    func testAProductWhoseMappingChangedIsNotPurchasedAsDisplayed() async {
        let rig = await makeReadyRig()
        var remapped = Fixture.products()
        remapped[0].planId = "max"
        remapped[0].planName = "Max"
        rig.billing.setCatalog(.success(Fixture.serverCatalog(products: remapped)))

        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.journal.all, ["catalog", "offers", "catalog"],
                       "a remapped selection went past the re-check")
        XCTAssertEqual(rig.model.state, .failed(.selectionChanged))
        XCTAssertTrue(rig.store.appAccountTokens.isEmpty)
        XCTAssertTrue(rig.store.finished.isEmpty)
    }

    /// The fresh answer names a different app than this build ships as. Whatever
    /// that catalog sells — even if it carries the same product identifiers — it
    /// is not what the screen offered, and nothing is bought from it.
    func testAFreshCatalogForTheWrongBundleStopsThePurchase() async {
        let rig = await makeReadyRig()
        rig.billing.setCatalog(.success(Fixture.serverCatalog(bundleId: "com.relayium.ios")))

        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.journal.all, ["catalog", "offers", "catalog"],
                       "a wrong-bundle answer went past the re-check")
        XCTAssertEqual(rig.model.state, .failed(.selectionChanged))
        XCTAssertTrue(rig.store.appAccountTokens.isEmpty)
        XCTAssertTrue(rig.store.finished.isEmpty)
    }

    /// A failed point-of-sale re-read stops the purchase with the billing
    /// failure itself — never optimistically proceeds on the stale screen.
    func testAFailedFreshCatalogReadStopsThePurchase() async {
        let rig = await makeReadyRig()
        rig.billing.setCatalog(.failure(AppleBillingError.network))

        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.journal.all, ["catalog", "offers", "catalog"])
        XCTAssertEqual(rig.model.state, .failed(.billing(.network)))
        XCTAssertTrue(rig.store.appAccountTokens.isEmpty)
    }

    // MARK: - no refusal ever finishes

    /// **The central table.** One delivered transaction, one refusal, per class.
    /// None of them may finish it, and none of them may refresh the account —
    /// there is nothing new for the server to report.
    ///
    /// The permanent-looking ones are here deliberately. A `token_mismatch` is
    /// repaired by signing in as the account that owns the purchase; an
    /// `invalid_transaction` from an unmapped product is repaired by a row in
    /// the server's catalog; a `verifier_unavailable` is repaired by configuring
    /// trust roots — which is the shipping default today, so finishing on it
    /// would silently discard every purchase made before that happens. In every
    /// case the repair is only worth anything if the store still has the
    /// transaction to redeliver.
    func testNoRefusalClassEverFinishesATransaction() async {
        let refusals: [Error] = [
            AppleBillingError.network,
            AppleBillingError.decoding,
            AppleBillingError.invalidTransaction,
            AppleBillingError.server(status: 400),
            AppleBillingError.notSignedIn,
            AppleBillingError.tokenMismatch,
            AppleBillingError.server(status: 403),
            AppleBillingError.subscriptionOwned,
            AppleBillingError.appleSubscriptionConflict,
            AppleBillingError.server(status: 409),
            AppleBillingError.rateLimited,
            AppleBillingError.server(status: 500),
            AppleBillingError.verifierUnavailable,
            AppleBillingError.server(status: 503),
            StoreFailure(),
        ]
        for refusal in refusals {
            let rig = await makeReadyRig()
            rig.store.setPurchase(.success(.delivered(Fixture.delivery)))
            rig.billing.setSubmissions([.failure(refusal)])
            await rig.model.purchase(productID: Fixture.catalog[0])

            XCTAssertEqual(rig.journal.all,
                           ["catalog", "offers", "catalog", "accountToken", "purchase", "submit"],
                           "\(refusal) produced a finish or a refresh")
            XCTAssertTrue(rig.store.finished.isEmpty, "\(refusal) finished a transaction")
            guard case .failed = rig.model.state else {
                return XCTFail("\(refusal) did not end in a failure: \(rig.model.state)")
            }
        }
    }

    /// The same table, one level up: the typed failure the state carries names
    /// the server's own refusal rather than collapsing everything into one.
    func testEachRefusalIsReportedAsItself() async {
        let cases: [(Error, AppleSubscriptionFailure)] = [
            (AppleBillingError.verifierUnavailable, .billing(.verifierUnavailable)),
            (AppleBillingError.tokenMismatch, .billing(.tokenMismatch)),
            (AppleBillingError.subscriptionOwned, .billing(.subscriptionOwned)),
            (AppleBillingError.appleSubscriptionConflict, .billing(.appleSubscriptionConflict)),
            (AppleBillingError.invalidTransaction, .billing(.invalidTransaction)),
            (AppleBillingError.decoding, .billing(.decoding)),
            (StoreFailure(), .unexpected(type: "StoreFailure")),
        ]
        for (thrown, expected) in cases {
            let rig = await makeReadyRig()
            rig.store.setPurchase(.success(.delivered(Fixture.delivery)))
            rig.billing.setSubmissions([.failure(thrown)])
            await rig.model.purchase(productID: Fixture.catalog[0])
            XCTAssertEqual(rig.model.state, .failed(expected))
        }
    }

    /// A decoded success that did not atomically apply is not enough authority
    /// to consume StoreKit's only recovery copy.
    func testAnUnappliedRedeliveryRemainsAvailableForReconciliation() async {
        let rig = await makeReadyRig()
        let converged = AppleTransactionResult(applied: false, planId: "plus", status: "active",
                                               expiresAt: 1_786_000_000, provider: "apple")
        rig.store.setPurchase(.success(.delivered(Fixture.delivery)))
        rig.billing.setSubmissions([.success(converged)])
        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertTrue(rig.store.finished.isEmpty)
        XCTAssertEqual(rig.model.state, .completed(converged))
    }

    // MARK: - nothing local grants access

    /// **No local store result is ever turned into an entitlement.**
    ///
    /// The store delivered a genuine, successful purchase; the server refused
    /// it. The model must report the refusal and must NOT refresh — because a
    /// refresh is the only thing that changes what the app shows, and there is
    /// nothing new for the server to say. What it ends up holding is a failure,
    /// not a plan derived from the offer that was bought.
    func testADeliveredPurchaseTheServerRefusedGrantsNothing() async {
        let rig = await makeReadyRig()
        rig.store.setPurchase(.success(.delivered(Fixture.delivery)))
        rig.billing.setSubmissions([.failure(AppleBillingError.verifierUnavailable)])
        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.journal.count("refresh"), 0,
                       "a refused purchase reloaded the account as though something changed")
        XCTAssertEqual(rig.model.state, .failed(.billing(.verifierUnavailable)))
    }

    /// And on the accepted path, what it reports is the SERVER's answer verbatim
    /// — not the offer's id, name or price.
    func testTheCompletedStateCarriesTheServersAnswerAndNothingLocal() async {
        let rig = await makeReadyRig()
        let serverAnswer = AppleTransactionResult(applied: true, planId: "max", status: "active",
                                                  expiresAt: 42, provider: "multiple")
        rig.store.setPurchase(.success(.delivered(Fixture.delivery)))
        rig.billing.setSubmissions([.success(serverAnswer)])
        // The offer says nothing about a plan, and deliberately cannot: the
        // purchased product id is not the tier, the server's catalog is.
        await rig.model.purchase(productID: Fixture.catalog[0])
        XCTAssertEqual(rig.model.state, .completed(serverAnswer))
    }

    // MARK: - ongoing deliveries

    /// A renewal arriving on its own is submitted, finished and followed by a
    /// refresh — and touches NO published state. Nobody asked for it, so it must
    /// not repaint a screen or raise a banner; the refresh is how every existing
    /// surface learns, from the server.
    func testAnOngoingDeliveryIsSettledWithoutTouchingTheScreen() async {
        let rig = await makeReadyRig()
        rig.model.startObservingUpdates()
        let stateBefore = rig.model.state

        rig.store.deliverUpdate(Fixture.delivery)
        await waitFor(rig) { $0.journal.count("refresh") == 1 }

        XCTAssertEqual(rig.store.finished, [Fixture.delivery.id])
        XCTAssertEqual(rig.model.state, stateBefore, "a background renewal repainted the screen")
    }

    func testStartupSweepSettlesAnUnfinishedTransaction() async {
        let rig = await makeReadyRig()
        rig.store.setUnfinished([Fixture.delivery])
        let stateBefore = rig.model.state

        rig.model.startObservingUpdates()
        await waitFor(rig) { $0.journal.count("refresh") == 1 }

        XCTAssertEqual(rig.store.finished, [Fixture.delivery.id])
        XCTAssertEqual(rig.billing.submittedJWS, [Fixture.jws])
        XCTAssertEqual(rig.model.state, stateBefore)
        XCTAssertEqual(rig.journal.count("unfinished"), 1)
    }

    /// A converged server response is not enough to finish while the local
    /// capability remains stuck in Keychain. StoreKit redelivery supplies the
    /// deterministic retry; the second sweep clears first and only then
    /// finishes the transaction.
    func testRetirementFailureLeavesTransactionForDeterministicRedelivery() async throws {
        let capabilityStore = FailOnceClearCapabilityStore()
        let repository = ApplePurchaseCapabilityRepository(store: capabilityStore)
        try repository.save(ApplePurchaseCapability(
            attemptID: "attempt-A",
            ownerAccountID: "acct-A",
            appInstanceID: "instance-A",
            secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            armRequestID: "arm-A",
            productID: Fixture.catalog[0],
            phase: .locked))
        let rig = makeContinuationRig(store: capabilityStore)
        let resolved = AppleTransactionResult(
            applied: true, planId: "plus", status: "active",
            expiresAt: 1_786_000_000, provider: "apple",
            dispatchPending: false, dispatchResolved: true,
            dispatchResolvedAttemptId: "attempt-A")
        rig.billing.setSubmissions([.success(resolved)])
        rig.store.setUnfinished([Fixture.delivery])

        await rig.model.reconcileUnfinishedTransactions()

        XCTAssertTrue(rig.store.finished.isEmpty,
                      "a failed local retirement discarded StoreKit redelivery")
        XCTAssertNotNil(repository.load())

        await rig.model.reconcileUnfinishedTransactions()

        XCTAssertEqual(rig.store.finished, [Fixture.delivery.id])
        XCTAssertNil(repository.load())
        XCTAssertEqual(rig.billing.submittedJWS, [Fixture.jws, Fixture.jws])
    }

    func testUnfinishedTransactionIsRetriedAfterLaunchSessionRestoration() async {
        let rig = makeRig(bearer: nil)
        rig.store.setUnfinished([Fixture.delivery])
        rig.billing.setSubmissions([.success(Fixture.entitlement)])

        rig.model.startObservingUpdates()
        await waitFor(rig) { $0.journal.count("updates") == 1 }
        XCTAssertTrue(rig.billing.submittedJWS.isEmpty)
        XCTAssertTrue(rig.store.finished.isEmpty)

        rig.bearer.set("rlm_app_restored")
        await rig.model.reconcileUnfinishedTransactions()

        XCTAssertEqual(rig.billing.submittedJWS, [Fixture.jws])
        XCTAssertEqual(rig.store.finished, [Fixture.delivery.id])
        XCTAssertEqual(rig.journal.count("refresh"), 1)
    }

    /// A refused background submission finishes nothing and says nothing. The
    /// transaction stays with the store, which is the whole redelivery
    /// mechanism this policy exists to protect.
    func testARefusedOngoingDeliveryLeavesTheTransactionForRedelivery() async {
        let rig = await makeReadyRig()
        rig.billing.setSubmissions([.failure(AppleBillingError.verifierUnavailable)])
        rig.model.startObservingUpdates()
        let stateBefore = rig.model.state

        rig.store.deliverUpdate(Fixture.delivery)
        await waitFor(rig) { $0.billing.submittedJWS.count == 1 }

        XCTAssertTrue(rig.store.finished.isEmpty)
        XCTAssertEqual(rig.journal.count("refresh"), 0)
        XCTAssertEqual(rig.model.state, stateBefore,
                       "a background refusal raised an error about an action nobody took")
    }

    /// Signed out, a delivery is left entirely alone — not submitted, not
    /// finished. The store offers it again after the next sign-in.
    func testAnOngoingDeliveryWhileSignedOutIsLeftAlone() async {
        let rig = await makeReadyRig()
        rig.model.startObservingUpdates()
        rig.bearer.set(nil)

        rig.store.deliverUpdate(Fixture.delivery)
        // Nothing to wait FOR, so wait for the stream to have been drained at
        // all and then assert the absence.
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(rig.billing.submittedJWS.isEmpty)
        XCTAssertTrue(rig.store.finished.isEmpty)
    }

    /// One drain, however many times it is asked for.
    func testObservingUpdatesIsIdempotent() async {
        let rig = await makeReadyRig()
        rig.model.startObservingUpdates()
        rig.model.startObservingUpdates()
        rig.model.startObservingUpdates()
        XCTAssertEqual(rig.journal.count("updates"), 1)
    }

    /// **The drain does not outlive the model.** `stop()` cancels the task,
    /// which ends the `for await`, which terminates the stream — and the
    /// adapter's `onTermination` is what releases the underlying store
    /// subscription. Without this, every model ever built keeps a task reading
    /// `Transaction.updates` forever.
    func testStoppingTerminatesTheUpdateStream() async {
        let rig = await makeReadyRig()
        rig.model.startObservingUpdates()
        XCTAssertEqual(rig.store.updateStreamsTerminated, 0)

        rig.model.stop()
        await waitFor(rig) { $0.store.updateStreamsTerminated == 1 }
        XCTAssertEqual(rig.store.updateStreamsTerminated, 1,
                       "the update drain survived the model being stopped")
    }

    // MARK: - restore

    /// Reconcile first, then submit every entitlement under the same policy,
    /// then ONE refresh for the whole restore.
    func testRestoreSynchronizesSubmitsEachEntitlementAndRefreshesOnce() async {
        let rig = await makeReadyRig()
        let second = SignedStoreTransaction(id: StoreTransactionID(rawValue: 7_002), jws: "j2")
        rig.store.setEntitlements([Fixture.delivery, second])
        rig.billing.setSubmissions([.success(Fixture.entitlement)])
        await rig.model.restore()

        XCTAssertEqual(rig.journal.all,
                       ["catalog", "offers", "synchronize", "currentEntitlements",
                        "submit", "finish", "submit", "finish", "refresh",
                        "catalog", "offers"])
        XCTAssertEqual(rig.store.finished, [Fixture.delivery.id, second.id])
        XCTAssertEqual(rig.billing.submittedJWS, [Fixture.jws, "j2"])
        XCTAssertEqual(rig.model.state, .completed(Fixture.entitlement))
    }

    func testAcceptedRestoreRefreshesPurchaseEligibilityWithoutReplacingSuccess() async {
        let rig = await makeReadyRig()
        XCTAssertEqual(rig.model.eligibility, Fixture.serverCatalog().purchase)
        rig.billing.setCatalog(.success(Fixture.serverCatalog(allowed: false, blockedBy: "apple")))
        rig.store.setEntitlements([Fixture.delivery])
        rig.billing.setSubmissions([.success(Fixture.entitlement)])

        await rig.model.restore()

        XCTAssertEqual(rig.model.eligibility,
                       AppleCatalogPurchase(allowed: false, blockedBy: "apple"))
        XCTAssertEqual(rig.model.state, .completed(Fixture.entitlement),
                       "catalog refresh replaced an accepted restore with secondary UI state")
        XCTAssertEqual(rig.journal.count("catalog"), 2,
                       "restore did not re-read the eligibility it may have repaired")
    }

    func testAcceptedRestoreClearsStaleEligibilityWhenItsRefreshFails() async {
        let rig = await makeReadyRig()
        XCTAssertEqual(rig.model.eligibility, Fixture.serverCatalog().purchase)
        rig.billing.setCatalog(.failure(AppleBillingError.network))
        rig.store.setEntitlements([Fixture.delivery])
        rig.billing.setSubmissions([.success(Fixture.entitlement)])

        await rig.model.restore()

        XCTAssertNil(rig.model.eligibility,
                     "a failed refresh left the pre-restore permission to buy active")
        XCTAssertEqual(rig.model.state, .completed(Fixture.entitlement),
                       "a secondary catalog failure replaced an accepted restore")
        XCTAssertEqual(rig.journal.count("catalog"), 2)
    }

    /// A restore is what a user reaches for when something has already gone
    /// wrong, so it is the last place that may finish an unaccepted
    /// transaction.
    func testRestoreFinishesNothingWhenTheServerRefuses() async {
        let rig = await makeReadyRig()
        rig.store.setEntitlements([Fixture.delivery])
        rig.billing.setSubmissions([.failure(AppleBillingError.tokenMismatch)])
        await rig.model.restore()

        XCTAssertTrue(rig.store.finished.isEmpty)
        XCTAssertEqual(rig.journal.count("refresh"), 0)
        XCTAssertEqual(rig.model.state, .failed(.billing(.tokenMismatch)))
    }

    /// One accepted delivery among refusals still finishes only itself, and the
    /// refresh happens because something really was accepted.
    func testRestoreFinishesOnlyTheDeliveriesTheServerAccepted() async {
        let rig = await makeReadyRig()
        let second = SignedStoreTransaction(id: StoreTransactionID(rawValue: 7_002), jws: "j2")
        rig.store.setEntitlements([Fixture.delivery, second])
        rig.billing.setSubmissions([.failure(AppleBillingError.invalidTransaction),
                                    .success(Fixture.entitlement)])
        await rig.model.restore()

        XCTAssertEqual(rig.store.finished, [second.id],
                       "a refused delivery was finished alongside an accepted one")
        XCTAssertEqual(rig.journal.count("refresh"), 1)
        XCTAssertEqual(rig.model.state, .completed(Fixture.entitlement))
    }

    func testRestoreWithNothingOwnedSaysSoRatherThanFailing() async {
        let rig = await makeReadyRig()
        rig.store.setEntitlements([])
        await rig.model.restore()
        XCTAssertEqual(rig.model.state, .nothingToRestore)
        XCTAssertEqual(rig.journal.count("refresh"), 0)
    }

    /// `synchronize()` can prompt for App Store credentials. Refusing a
    /// signed-out restore BEFORE that prompt means the user is never asked to
    /// authenticate with Apple in order to achieve nothing.
    func testASignedOutRestoreNeverPromptsTheStore() async {
        let rig = await makeReadyRig(bearer: nil)
        rig.store.setEntitlements([Fixture.delivery])
        await rig.model.restore()

        XCTAssertEqual(rig.journal.all, ["catalog", "offers"])
        XCTAssertEqual(rig.model.state, .failed(.billing(.notSignedIn)))
    }

    func testAFailedSynchronizeStopsTheRestore() async {
        let rig = await makeReadyRig()
        rig.store.setSynchronize(.failure(StoreFailure()))
        rig.store.setEntitlements([Fixture.delivery])
        await rig.model.restore()

        XCTAssertEqual(rig.journal.all, ["catalog", "offers", "synchronize"])
        XCTAssertEqual(rig.model.state, .failed(.unexpected(type: "StoreFailure")))
        XCTAssertTrue(rig.store.finished.isEmpty)
    }

    // MARK: - overlapping operations

    /// A restore that lands after a purchase started must not paint over it.
    /// Same rule every other model in this layer follows: the last operation to
    /// start is the only one allowed to finish.
    func testAnEarlierOperationCannotWriteOverALaterOne() async {
        let rig = await makeReadyRig()
        rig.store.setEntitlements([])
        // Park the restore inside `synchronize()` so it is genuinely in flight
        // rather than assumed to be.
        rig.store.setHoldSynchronize(true)
        let restore = Task { await rig.model.restore() }
        await waitFor(rig) { $0.journal.count("synchronize") == 1 }

        await rig.model.purchase(productID: Fixture.catalog[0])
        XCTAssertEqual(rig.model.state, .completed(Fixture.entitlement))

        rig.store.setHoldSynchronize(false)
        await restore.value
        XCTAssertEqual(rig.model.state, .completed(Fixture.entitlement),
                       "a superseded restore wrote over the purchase that replaced it")
    }

    // MARK: - supersession may silence a screen, never a refresh

    /// **An acceptance that arrives after its operation was superseded still
    /// refreshes the account.**
    ///
    /// This is the case where the two rules pull in opposite directions, and
    /// getting it wrong is unrecoverable. By the time `settle` returns
    /// `.accepted` the transaction has ALREADY been finished — the store has
    /// been told to stop redelivering it, and nothing on the device can produce
    /// that JWS again. So the refresh is not this operation's cosmetic epilogue;
    /// it is the only remaining thing that can carry the server's new answer
    /// into the app. Skipping it because a newer operation owns the screen
    /// leaves a user who has paid, whose server-side entitlement is live, and
    /// whose app shows the old plan until something unrelated happens to reload.
    ///
    /// What supersession still governs is the state WRITE, which is asserted
    /// here too: the newer operation's screen survives untouched.
    func testAnAcceptedPurchaseRefreshesEvenWhenItWasSupersededMidSubmission() async {
        let rig = await makeReadyRig()
        rig.billing.holdSubmit(after: 0)
        let purchase = Task { await rig.model.purchase(productID: Fixture.catalog[0]) }
        await waitFor(rig) { $0.billing.submittedJWS.count == 1 }
        // The transaction is with the server and its fate is not yet known.
        XCTAssertTrue(rig.store.finished.isEmpty)

        // A newer foreground operation claims the generation and the screen. It
        // owns no entitlements, so it submits nothing of its own.
        rig.store.setEntitlements([])
        await rig.model.restore()
        XCTAssertEqual(rig.model.state, .nothingToRestore)

        rig.billing.releaseSubmit()
        await purchase.value

        XCTAssertEqual(rig.store.finished, [Fixture.delivery.id],
                       "the accepted transaction was not finished")
        XCTAssertEqual(rig.journal.count("refresh"), 1,
                       "a finished, server-accepted transaction never reached the "
                       + "server-authoritative refresh")
        XCTAssertEqual(rig.model.state, .nothingToRestore,
                       "the superseded purchase wrote over the newer operation's state")
    }

    /// The same rule across a multi-entitlement restore: the first delivery is
    /// accepted and finished, the operation is superseded while the second is in
    /// flight, and the refresh the first one earned still happens exactly once.
    ///
    /// The second delivery is REFUSED here on purpose. It is the shape that
    /// makes the obligation belong to the acceptance rather than to the last
    /// answer: nothing about the final submission says a refresh is owed, and
    /// one is owed anyway.
    func testASupersededRestoreStillRefreshesForWhatItAlreadyAccepted() async {
        let rig = await makeReadyRig()
        let second = SignedStoreTransaction(id: StoreTransactionID(rawValue: 7_002), jws: "j2")
        rig.store.setEntitlements([Fixture.delivery, second])
        rig.billing.setSubmissions([.success(Fixture.entitlement),
                                    .failure(AppleBillingError.verifierUnavailable)])
        rig.billing.holdSubmit(after: 1)

        let restore = Task { await rig.model.restore() }
        await waitFor(rig) { $0.billing.submittedJWS.count == 2 }
        XCTAssertEqual(rig.store.finished, [Fixture.delivery.id],
                       "the first entitlement was not accepted and finished before the hold")

        // Something else claims the generation and the screen. `loadOffers` is
        // used because it submits nothing, so the journal below is entirely the
        // restore's.
        await rig.model.loadOffers()
        XCTAssertEqual(rig.model.state, .idle)

        rig.billing.releaseSubmit()
        await restore.value

        XCTAssertEqual(rig.journal.count("refresh"), 1,
                       "an accepted, finished entitlement lost its refresh to a later "
                       + "delivery being superseded")
        XCTAssertEqual(rig.store.finished, [Fixture.delivery.id],
                       "the refused second delivery was finished")
        XCTAssertEqual(rig.model.state, .idle,
                       "the superseded restore wrote over the newer operation's state")
    }

    /// And the obligation is genuinely tied to ACCEPTANCE, not to being
    /// superseded: a superseded operation whose every submission was refused
    /// finishes nothing and refreshes nothing.
    func testASupersededOperationWithNoAcceptanceRefreshesNothing() async {
        let rig = await makeReadyRig()
        rig.store.setEntitlements([Fixture.delivery])
        rig.billing.setSubmissions([.failure(AppleBillingError.verifierUnavailable)])
        rig.billing.holdSubmit(after: 0)

        let restore = Task { await rig.model.restore() }
        await waitFor(rig) { $0.billing.submittedJWS.count == 1 }
        await rig.model.loadOffers()

        rig.billing.releaseSubmit()
        await restore.value

        XCTAssertEqual(rig.journal.count("refresh"), 0,
                       "a superseded operation that accepted nothing still refreshed")
        XCTAssertTrue(rig.store.finished.isEmpty)
        XCTAssertEqual(rig.model.state, .idle)
    }

    // MARK: - helpers

    /// Poll until a condition about the rig holds, or give up.
    ///
    /// The update stream is drained by a detached task, so its effects land
    /// after the yield returns; there is no completion to await.
    private func waitFor(_ rig: Rig, _ condition: (Rig) -> Bool,
                        file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<200 {
            if condition(rig) { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("condition never held", file: file, line: line)
    }
}

// MARK: - the purchase-continuation protocol, through the real purchase path

/// The cancellation-recovery protocol driven end to end.
///
/// `ApplePurchaseContinuationTests` proves the state machine's rules in
/// isolation. This proves the **purchase path actually uses them**: that a
/// cancellation is reported and released, that a resume reuses the attempt, that
/// `pending` and a thrown store error lock instead, and that a legacy build is
/// byte-for-byte unchanged.
extension AppleSubscriptionModelTests {

    /// **A legacy build sends no capability fields at all.**
    ///
    /// The additive protocol is server-first, so an already-released client must
    /// keep getting exactly one dispatch and its old one-shot safety. Asserted as
    /// `nil` on the wire rather than as "some fields missing".
    func testALegacyBuildSendsNoContinuationFields() async {
        let rig = await makeReadyRig()
        await rig.model.purchase(productID: Fixture.catalog[0])
        XCTAssertEqual(rig.billing.dispatchContinuations, [nil])
        XCTAssertTrue(rig.billing.reports.isEmpty,
                      "a legacy client reported an outcome it has no capability for")
    }

    /// The initial arm's identity and secret are persisted before the request,
    /// so losing the request or its response is exactly replayable.
    func testTheInitialArmPersistsTheCapabilityBeforeTheSheet() async throws {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)
        await rig.model.purchase(productID: Fixture.catalog[0])

        let sent = try XCTUnwrap(rig.billing.dispatchContinuations.first ?? nil)
        XCTAssertEqual(sent.appInstanceID, "instance-A")
        let sentSecret = try XCTUnwrap(sent.continuationSecret)
        XCTAssertTrue(ApplePurchaseIdentity.isValid(sent.armRequestID))

        let stored = try XCTUnwrap(ApplePurchaseCapabilityRepository(store: capabilityStore).load())
        XCTAssertEqual(stored.appInstanceID, "instance-A")
        XCTAssertEqual(stored.armRequestID, sent.armRequestID,
                       "the stored arm is not the one the sheet was opened under")
        XCTAssertEqual(stored.secret, sentSecret)
    }

    func testALostInitialResponseReplaysTheExactPreparedArm() async throws {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)
        rig.billing.setDispatches([
            .failure(AppleBillingError.network),
            .success(ApplePurchaseDispatch(appAccountToken: Fixture.accountToken,
                                           attemptId: "attempt-replayed"))
        ])

        await rig.model.purchase(productID: Fixture.catalog[0])
        let prepared = try XCTUnwrap(
            ApplePurchaseCapabilityRepository(store: capabilityStore).load())
        XCTAssertEqual(prepared.phase, .preparing)
        XCTAssertEqual(prepared.attemptID, "")
        XCTAssertEqual(rig.journal.count("purchase"), 0,
                       "a lost dispatch response opened StoreKit")

        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.billing.dispatchContinuations.count, 2)
        XCTAssertEqual(rig.billing.dispatchContinuations[0],
                       rig.billing.dispatchContinuations[1],
                       "the retry did not replay the exact prepared capability")
        XCTAssertEqual(rig.billing.dispatchProductIDs,
                       [Fixture.catalog[0], Fixture.catalog[0]])
        XCTAssertEqual(rig.journal.count("purchase"), 1,
                       "the replay opened anything other than one sheet")
    }

    func testADeterministicInitialRejectionRetiresThePreparedIdentity() async throws {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)
        rig.billing.setDispatches([
            .failure(AppleBillingError.initialArmRejected(
                code: "manage_with_apple", provider: "apple")),
            .success(ApplePurchaseDispatch(appAccountToken: Fixture.accountToken,
                                           attemptId: "attempt-two"))
        ])
        rig.store.setPurchase(.success(.userCancelled))

        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertNil(ApplePurchaseCapabilityRepository(store: capabilityStore).load())

        await rig.model.purchase(productID: Fixture.catalog[1])

        XCTAssertEqual(rig.billing.dispatchProductIDs,
                       [Fixture.catalog[0], Fixture.catalog[1]])
        XCTAssertEqual(rig.journal.count("purchase"), 1)
    }

    func testCancellationSurvivesKeychainWriteFailureThroughOutcomeJournal() async throws {
        let capabilityStore = LockableCapabilityStore()
        let outcomeJournal = InMemoryApplePurchaseOutcomeJournal()
        let journal = PurchaseJournal()
        let store = FakeStore(journal: journal)
        let billing = FakeBilling(journal: journal, accountToken: Fixture.accountToken)
        let bearer = BearerBox("rlm_app_A")
        let repository = ApplePurchaseCapabilityRepository(store: capabilityStore)
        let model = AppleSubscriptionModel(
            store: store, billing: billing, bundleID: Fixture.bundleID,
            bearer: { bearer.current }, accountID: { "acct-A" },
            refreshAccount: {}, continuation: repository,
            outcomeJournal: outcomeJournal, appInstanceID: "instance-A",
            purchaseDispatchPolicy: .durableContinuationRequired)
        store.setOffers(.success(Fixture.offers(Fixture.catalog)))
        await model.loadOffers()
        store.setPurchase(.success(.userCancelled))
        store.setOnPurchase { capabilityStore.setWritesFail(true) }

        await model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(repository.load()?.phase, .armed)
        XCTAssertNotNil(outcomeJournal.load(ownerAccountID: "acct-A"))

        capabilityStore.setWritesFail(false)
        store.setOnPurchase(nil)
        await model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(billing.dispatchContinuations.count, 2)
        XCTAssertEqual(journal.count("purchase"), 2)
        XCTAssertEqual(repository.load()?.phase, .cancelled)
        XCTAssertNil(outcomeJournal.load(ownerAccountID: "acct-A"))
    }

    func testCancellationSurvivesJournalFailureThroughKeychainIntent() async throws {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = makeContinuationRig(
            store: capabilityStore, outcomeJournal: FailingOutcomeJournal())
        rig.store.setOffers(.success(Fixture.offers(Fixture.catalog)))
        await rig.model.loadOffers()
        rig.store.setPurchase(.success(.userCancelled))

        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.billing.reports.map(\.outcome), [.userCancelled])
        XCTAssertEqual(ApplePurchaseCapabilityRepository(
            store: capabilityStore).load()?.phase, .cancelled)
    }

    func testResolvedSubmissionRetiresTheAccountSnapshotNotTheNewSession() async throws {
        let capabilityStoreA = InMemoryApplePurchaseCapabilityStore()
        let capabilityStoreB = InMemoryApplePurchaseCapabilityStore()
        let repository = ApplePurchaseCapabilityRepository(
            storeForOwner: { $0 == "acct-A" ? capabilityStoreA : capabilityStoreB })
        try repository.save(ApplePurchaseCapability(
            attemptID: "attempt-B", ownerAccountID: "acct-B",
            appInstanceID: "instance-A",
            secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            armRequestID: "arm-B", productID: Fixture.catalog[0],
            phase: .cancelled))
        let journal = PurchaseJournal()
        let store = FakeStore(journal: journal)
        let billing = FakeBilling(journal: journal, accountToken: Fixture.accountToken)
        let bearer = BearerBox("rlm_app_A")
        let account = BearerBox("acct-A")
        let model = AppleSubscriptionModel(
            store: store, billing: billing, bundleID: Fixture.bundleID,
            bearer: { bearer.current }, accountID: { account.current },
            refreshAccount: {}, continuation: repository,
            outcomeJournal: InMemoryApplePurchaseOutcomeJournal(),
            appInstanceID: "instance-A",
            purchaseDispatchPolicy: .durableContinuationRequired)
        store.setOffers(.success(Fixture.offers(Fixture.catalog)))
        await model.loadOffers()
        store.setPurchase(.success(.delivered(Fixture.delivery)))
        billing.setSubmissions([.success(AppleTransactionResult(
            applied: true, planId: "plus", status: "active",
            expiresAt: 1_786_000_000, provider: "apple",
            dispatchPending: false, dispatchResolved: true,
            dispatchResolvedAttemptId: "attempt-one"))])
        billing.holdSubmit(after: 1)

        let purchase = Task { await model.purchase(productID: Fixture.catalog[0]) }
        for _ in 0..<200 where billing.submittedJWS.isEmpty { await Task.yield() }
        bearer.set("rlm_app_B")
        account.set("acct-B")
        billing.releaseSubmit()
        await purchase.value

        XCTAssertNil(repository.load(ownerAccountID: "acct-A"))
        XCTAssertNotNil(repository.load(ownerAccountID: "acct-B"),
                        "A's response retired B's independent capability")
        XCTAssertEqual(store.finished, [Fixture.delivery.id])
    }

    func testAContinuationCapabilityCannotCrossRelayiumAccounts() async throws {
        let capabilityStoreA = InMemoryApplePurchaseCapabilityStore()
        let capabilityStoreB = InMemoryApplePurchaseCapabilityStore()
        let capabilityRepository = ApplePurchaseCapabilityRepository(
            storeForOwner: { $0 == "acct-A" ? capabilityStoreA : capabilityStoreB })
        let journal = PurchaseJournal()
        let store = FakeStore(journal: journal)
        let billing = FakeBilling(journal: journal, accountToken: Fixture.accountToken)
        let bearer = BearerBox("rlm_app_A")
        let account = BearerBox("acct-A")
        let model = AppleSubscriptionModel(
            store: store, billing: billing, bundleID: Fixture.bundleID,
            bearer: { bearer.current }, accountID: { account.current },
            refreshAccount: {},
            continuation: capabilityRepository,
            outcomeJournal: InMemoryApplePurchaseOutcomeJournal(),
            appInstanceID: "instance-A",
            purchaseDispatchPolicy: .durableContinuationRequired)
        store.setOffers(.success(Fixture.offers(Fixture.catalog)))
        await model.loadOffers()
        store.setPurchase(.success(.userCancelled))
        await model.purchase(productID: Fixture.catalog[0])
        XCTAssertEqual(billing.dispatchContinuations.count, 1)

        bearer.set("rlm_app_B")
        account.set("acct-B")
        await model.loadOffers()
        await model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(model.state, .idle)
        XCTAssertEqual(billing.dispatchContinuations.count, 2)
        XCTAssertEqual(journal.count("purchase"), 2)
        XCTAssertNotNil(capabilityRepository.load(ownerAccountID: "acct-A"))
        XCTAssertNotNil(capabilityRepository.load(ownerAccountID: "acct-B"))
    }

    func testConcurrentPurchaseCallsShareNeitherArmNorStoreKitSheet() async {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)
        rig.store.setPurchase(.success(.userCancelled))
        rig.store.setHoldPurchase(true)

        let first = Task { await rig.model.purchase(productID: Fixture.catalog[0]) }
        await waitFor(rig) { $0.journal.count("purchase") == 1 }
        let second = Task { await rig.model.purchase(productID: Fixture.catalog[1]) }
        await Task.yield()

        XCTAssertEqual(rig.journal.count("purchase"), 1)
        XCTAssertEqual(rig.billing.dispatchContinuations.count, 1)

        rig.store.setHoldPurchase(false)
        await first.value
        await second.value
        XCTAssertEqual(rig.journal.count("purchase"), 1)
        XCTAssertEqual(rig.billing.dispatchContinuations.count, 1)
    }

    /// **Cancel, then buy again — the defect this whole protocol exists for.**
    ///
    /// The cancellation is reported under the arm that was open, and the second
    /// purchase resumes the SAME attempt with a FRESH arm identity and the
    /// secret. Before this protocol the second purchase was refused for ever.
    func testACancelledPurchaseCanBeResumedWithAFreshArm() async throws {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)

        rig.store.setPurchase(.success(.userCancelled))
        await rig.model.purchase(productID: Fixture.catalog[0])
        XCTAssertEqual(rig.model.state, .idle)

        let cancellation = try XCTUnwrap(rig.billing.reports.first)
        XCTAssertEqual(cancellation.outcome, .userCancelled)
        XCTAssertEqual(cancellation.attemptID, "attempt-one")
        let initial = try XCTUnwrap(rig.billing.dispatchContinuations.first ?? nil)
        let initialSecret = try XCTUnwrap(initial.continuationSecret)
        XCTAssertEqual(cancellation.secret, initialSecret)
        let firstArm = cancellation.armRequestID
        XCTAssertEqual(ApplePurchaseCapabilityRepository(store: capabilityStore).load()?.phase,
                       .cancelled)

        rig.store.setPurchase(.success(.delivered(Fixture.delivery)))
        await rig.model.purchase(productID: Fixture.catalog[0])

        let resume = try XCTUnwrap(rig.billing.dispatchContinuations.last ?? nil)
        XCTAssertEqual(resume.continuationSecret, initialSecret,
                       "a resume must present the capability")
        XCTAssertNotEqual(resume.armRequestID, firstArm,
                          "a spent arm identity was re-presented")
        XCTAssertTrue(ApplePurchaseIdentity.isValid(resume.armRequestID))
        XCTAssertEqual(rig.model.state, .completed(Fixture.entitlement))
    }

    /// Another installation may have completed the attempt named by this
    /// device's cancelled capability. The next dispatch then creates a new
    /// attempt. Its id is authoritative and must be persisted before StoreKit
    /// opens, otherwise the outcome is reported to the resolved old attempt and
    /// the new one remains armed account-wide.
    func testAResumeAdoptsAReplacementAttemptBeforeReportingItsOutcome() async throws {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)

        rig.store.setPurchase(.success(.userCancelled))
        await rig.model.purchase(productID: Fixture.catalog[0])

        rig.billing.setDispatches([.success(ApplePurchaseDispatch(
            appAccountToken: Fixture.accountToken,
            attemptId: "attempt-replacement"))])
        rig.store.setPurchase(.success(.userCancelled))
        await rig.model.purchase(productID: Fixture.catalog[0])

        let reports = try reports(rig.billing, count: 2)
        XCTAssertEqual(reports[0].attemptID, "attempt-one")
        XCTAssertEqual(reports[1].attemptID, "attempt-replacement",
                       "the replacement attempt was left armed by a report to the stale id")
        let stored = try XCTUnwrap(
            ApplePurchaseCapabilityRepository(store: capabilityStore).load())
        XCTAssertEqual(stored.attemptID, "attempt-replacement")
        XCTAssertEqual(stored.phase, .cancelled)
    }

    /// **A cancelled sheet is not a promise to buy the same thing next.**
    ///
    /// The resume names the product the user actually chose, and the stored
    /// capability moves with it — convergence is exact on product, so an attempt
    /// left naming the abandoned one charges correctly and then never resolves.
    func testACancelledPurchaseCanResumeOnADifferentProduct() async throws {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)

        rig.store.setPurchase(.success(.userCancelled))
        await rig.model.purchase(productID: Fixture.catalog[0])

        rig.store.setPurchase(.success(.delivered(Fixture.delivery)))
        await rig.model.purchase(productID: Fixture.catalog[1])

        XCTAssertEqual(rig.billing.dispatchProductIDs.last, Fixture.catalog[1])
        let stored = try XCTUnwrap(ApplePurchaseCapabilityRepository(store: capabilityStore).load())
        XCTAssertEqual(stored.productID, Fixture.catalog[1],
                       "the attempt still names the abandoned product")
        XCTAssertEqual(stored.attemptID, "attempt-one", "a resume must not mint a new attempt")
    }

    /// **`pending` locks, and locked is terminal.** Ask to Buy may still become a
    /// real charge, so it is reported as `pending` — never as a cancellation —
    /// and the next purchase is refused rather than arming a second sheet.
    func testAPendingPurchaseLocksAndNeverReArms() async throws {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)

        rig.store.setPurchase(.success(.pending))
        await rig.model.purchase(productID: Fixture.catalog[0])
        XCTAssertEqual(rig.model.state, .deferred)
        XCTAssertEqual(rig.billing.reports.map(\.outcome), [.pending])
        XCTAssertEqual(ApplePurchaseCapabilityRepository(store: capabilityStore).load()?.phase,
                       .locked)

        let dispatchesBefore = rig.billing.dispatchContinuations.count
        rig.store.setPurchase(.success(.delivered(Fixture.delivery)))
        await rig.model.purchase(productID: Fixture.catalog[0])
        XCTAssertEqual(rig.billing.dispatchContinuations.count, dispatchesBefore,
                       "a locked attempt armed another sheet")
        XCTAssertEqual(rig.model.state, .failed(.billing(.continuationRejected)))
    }

    /// **A thrown store error is not a cancellation.** It is reported as
    /// `failed`, which locks — an error says nothing about whether Apple charged.
    func testAThrownStoreErrorLocksRatherThanReleasing() async throws {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)

        struct StoreFailure: Error {}
        rig.store.setPurchase(.failure(StoreFailure()))
        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.billing.reports.map(\.outcome), [.failed])
        XCTAssertEqual(ApplePurchaseCapabilityRepository(store: capabilityStore).load()?.phase,
                       .locked)
    }

    /// A delivered purchase reports `success`, which also locks: the attempt is
    /// resolved by the transaction, not by re-arming.
    func testADeliveredPurchaseReportsSuccess() async {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)
        await rig.model.purchase(productID: Fixture.catalog[0])
        XCTAssertEqual(rig.billing.reports.map(\.outcome), [.success])
    }

    /// **Silence is not a cancellation.** A process that died with the sheet open
    /// leaves `armed`, and a relaunch must refuse rather than open a second one.
    ///
    /// This is the case where **nothing was recorded** — the process died before
    /// StoreKit answered, so there is no report to replay. The refusal is the
    /// outcome-required answer. If the sheet had completed, the store redelivers
    /// the transaction and reconciliation converges it; if it was cancelled and
    /// the report was recorded, `testALostCancellationIsReplayedBeforeOneFreshArm`
    /// covers the replay instead.
    func testARestartWithAnUnreportedSheetRefusesToArmAgain() async throws {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        try ApplePurchaseCapabilityRepository(store: capabilityStore).save(
            ApplePurchaseCapability(attemptID: "attempt-one", appInstanceID: "instance-A",
                                    secret: "TEST-SECRET-NOT-REAL", armRequestID: "arm-crashed",
                                    productID: Fixture.catalog[0], phase: .armed))
        // A brand-new model over the same store is what a relaunch is.
        let rig = await makeReadyContinuationRig(store: capabilityStore)
        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertTrue(rig.billing.dispatchContinuations.isEmpty,
                      "a crashed sheet was silently re-armed")
        XCTAssertEqual(rig.model.state, .failed(.billing(.purchaseOutcomeRequired)))
    }

    /// **A lost resume response is replayed with the SAME arm and product**, so
    /// the server reads its own answer back instead of authorizing a second
    /// sheet under an identity this client would otherwise never have learned.
    func testALostResumeResponseReplaysTheSameArm() async throws {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)

        rig.store.setPurchase(.success(.userCancelled))
        await rig.model.purchase(productID: Fixture.catalog[0])

        // The resume's response is lost.
        rig.billing.setDispatches([.failure(AppleBillingError.network)])
        rig.store.setPurchase(.success(.delivered(Fixture.delivery)))
        await rig.model.purchase(productID: Fixture.catalog[0])
        let attempted = try XCTUnwrap(rig.billing.dispatchContinuations.last ?? nil)
        let intent = try XCTUnwrap(
            ApplePurchaseCapabilityRepository(store: capabilityStore).load()?.unconfirmedResume)
        XCTAssertEqual(intent.armRequestID, attempted.armRequestID,
                       "the arm that was sent was not recorded for replay")

        // The retry replays it byte for byte.
        rig.billing.setDispatches([])
        await rig.model.purchase(productID: Fixture.catalog[0])
        let replayed = try XCTUnwrap(rig.billing.dispatchContinuations.last ?? nil)
        XCTAssertEqual(replayed.armRequestID, intent.armRequestID,
                       "a second logical sheet was armed after a lost response")
        XCTAssertEqual(rig.billing.dispatchProductIDs.last, intent.productID)
    }

    // MARK: - a report that was recorded and never confirmed delivered

    /// The outcome reports the server received, checked for length first.
    ///
    /// Subscripting `reports` directly **traps** when a regression sends fewer of
    /// them, which aborts the whole run instead of failing one test — and a
    /// mutation battery cannot read a crash. This records the real count as a
    /// failure and stops just this test.
    private func reports(_ billing: FakeBilling, count: Int,
                         file: StaticString = #filePath,
                         line: UInt = #line) throws -> [FakeBilling.ReportedOutcome] {
        let all = billing.reports
        XCTAssertEqual(all.count, count, "unexpected number of outcome reports",
                       file: file, line: line)
        return try XCTUnwrap(all.count == count ? all : nil, file: file, line: line)
    }

    /// **An undelivered outcome report moves nothing local, but it is written
    /// down.**
    ///
    /// The phase staying `armed` is the fail-closed half and was always right.
    /// The recorded intent is the half that was missing: a cancellation produces
    /// **no signed transaction**, so there is nothing for `Transaction.updates`
    /// or `restore` to redeliver and *nothing* reconciles the attempt. Without
    /// the record, one dropped packet left this account refused for ever.
    func testAnUndeliveredOutcomeReportStaysArmedAndIsRecordedForReplay() async throws {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)

        rig.billing.setOutcomeFailures([AppleBillingError.network])
        rig.store.setPurchase(.success(.userCancelled))
        await rig.model.purchase(productID: Fixture.catalog[0])

        let armed = try XCTUnwrap(ApplePurchaseCapabilityRepository(store: capabilityStore).load())
        XCTAssertEqual(armed.phase, .armed, "an undelivered cancellation was believed anyway")
        let sent = try XCTUnwrap(rig.billing.dispatchContinuations.last ?? nil)
        XCTAssertEqual(armed.unconfirmedOutcome,
                       ApplePurchaseOutcomeIntent(armRequestID: sent.armRequestID,
                                                  outcome: .userCancelled),
                       "the report was not recorded, so nothing can ever replay it")
    }

    /// **The lost cancellation is replayed on the next attempt, and only then is
    /// one fresh sheet armed.**
    ///
    /// The exact schedule the correction exists for: cancel, lose the report,
    /// come back. The replay must be the SAME arm, the SAME outcome and the SAME
    /// secret, must precede any new arm, and must produce exactly one new sheet.
    func testALostCancellationIsReplayedBeforeOneFreshArm() async throws {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)

        rig.billing.setOutcomeFailures([AppleBillingError.network])
        rig.store.setPurchase(.success(.userCancelled))
        await rig.model.purchase(productID: Fixture.catalog[0])
        let firstArm = try XCTUnwrap(rig.billing.dispatchContinuations.last ?? nil).armRequestID
        XCTAssertEqual(rig.journal.count("purchase"), 1)

        // The server is reachable again, and the user tries the other product.
        rig.billing.setOutcomeFailures([])
        rig.store.setPurchase(.success(.delivered(Fixture.delivery)))
        await rig.model.purchase(productID: Fixture.catalog[1])

        // Report identity: the replay is byte-for-byte the report that was lost.
        let sent = try reports(rig.billing, count: 3)
        XCTAssertEqual(sent[1], sent[0], "the replay was not the identical report")
        XCTAssertEqual(sent[0].armRequestID, firstArm)
        XCTAssertEqual(sent[0].outcome, .userCancelled)
        // Exactly one fresh arm followed, for the product actually chosen.
        XCTAssertNotEqual(sent[2].armRequestID, firstArm,
                          "the new sheet reused a spent arm identity")
        XCTAssertEqual(sent[2].outcome, .success)
        XCTAssertEqual(rig.billing.dispatchProductIDs, [Fixture.catalog[0], Fixture.catalog[1]])
        XCTAssertEqual(rig.billing.dispatchContinuations.count, 2,
                       "the replay armed a dispatch of its own")
        XCTAssertEqual(rig.journal.count("purchase"), 2,
                       "the replay opened a StoreKit sheet, or a second one was armed")
    }

    /// **A lost RESPONSE is the same client fact as a lost request, and the
    /// replay is idempotent.**
    ///
    /// The server recorded the cancellation and the answer never arrived, so it
    /// answers the replay `resumable: true` again rather than treating it as a
    /// second statement — which is what `continuation_state IN (armed,cancelled)`
    /// on both the read and the write predicate gives. The client must send the
    /// identical request, including the attempt and the secret, and arm once.
    func testALostSuccessfulResponseReplaysIdempotentlyOnTheSameArm() async throws {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)

        // Delivered and applied by the server; only the answer was lost.
        rig.billing.setOutcomeFailures([AppleBillingError.decoding])
        rig.store.setPurchase(.success(.userCancelled))
        await rig.model.purchase(productID: Fixture.catalog[0])

        rig.billing.setOutcomeFailures([])
        rig.billing.setOutcomeResumables([true])   // the idempotent re-acceptance
        rig.store.setPurchase(.success(.delivered(Fixture.delivery)))
        await rig.model.purchase(productID: Fixture.catalog[0])

        let sent = try reports(rig.billing, count: 3)
        XCTAssertEqual(sent[1], sent[0],
                       "the replay differed from the report whose answer was lost")
        XCTAssertEqual(sent[0].attemptID, sent[1].attemptID)
        XCTAssertEqual(sent[0].secret, sent[1].secret)
        XCTAssertEqual(rig.journal.count("purchase"), 2, "more than one fresh sheet was opened")
        XCTAssertEqual(rig.model.state, .completed(Fixture.entitlement))
    }

    /// **The record survives a relaunch**, which is the crash this mechanism
    /// exists for: recorded, process died, and the next launch still owes it.
    ///
    /// A brand-new model over the same capability store is what a restart is.
    func testARecordedCancellationIsReplayedAfterARestart() async throws {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let first = await makeReadyContinuationRig(store: capabilityStore)
        first.billing.setOutcomeFailures([AppleBillingError.network])
        first.store.setPurchase(.success(.userCancelled))
        await first.model.purchase(productID: Fixture.catalog[0])
        let lost = try XCTUnwrap(first.billing.reports.last)

        // Relaunch: a different model, a different fake server, the same store.
        let restarted = await makeReadyContinuationRig(store: capabilityStore)
        restarted.store.setPurchase(.success(.delivered(Fixture.delivery)))
        await restarted.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(restarted.billing.reports.first, lost,
                       "the relaunched app did not replay the report it owed")
        XCTAssertEqual(restarted.journal.count("purchase"), 1,
                       "the relaunched app opened more than one sheet")
        XCTAssertEqual(restarted.billing.dispatchContinuations.count, 1,
                       "a dispatch was armed before the owed report was answered")
    }

    /// **A replay that still fails opens no sheet**, and the report stays owed.
    ///
    /// Fail-closed, truthfully: `purchaseOutcomeRequired` is exactly "the server
    /// has not been told what StoreKit did". Nothing is armed and StoreKit is
    /// never asked.
    func testAReplayThatStillFailsOpensNoSheet() async throws {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)

        rig.billing.setOutcomeFailures([AppleBillingError.network])
        rig.store.setPurchase(.success(.userCancelled))
        await rig.model.purchase(productID: Fixture.catalog[0])
        let recorded = try XCTUnwrap(
            ApplePurchaseCapabilityRepository(store: capabilityStore).load()?.unconfirmedOutcome)

        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.model.state, .failed(.billing(.purchaseOutcomeRequired)))
        XCTAssertEqual(rig.journal.count("purchase"), 1, "a sheet opened while a report was owed")
        XCTAssertEqual(rig.billing.dispatchContinuations.count, 1, "a second dispatch was armed")
        // **Attempted once, then it gives up for this attempt.** An undelivered
        // replay must fail closed immediately rather than fall through to the
        // planner again: retrying inside one purchase spends the user's time on
        // a server that is not answering, and the only thing that could then end
        // the loop is its own bound.
        let sent = try reports(rig.billing, count: 2)
        XCTAssertEqual(sent[1], sent[0], "the replay was not the identical report")
        XCTAssertEqual(ApplePurchaseCapabilityRepository(store: capabilityStore).load()?.unconfirmedOutcome,
                       recorded, "the still-owed report was forgotten")
    }

    /// A 403 for the exact recorded arm is not a transport failure: the server
    /// proves another installation superseded it. Retiring that inert local
    /// capability must allow one fresh arm rather than replaying forever.
    func testARejectedOutcomeReplayRetiresTheSupersededArmAndStartsFresh() async throws {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)

        rig.billing.setOutcomeFailures([AppleBillingError.network])
        rig.store.setPurchase(.success(.userCancelled))
        await rig.model.purchase(productID: Fixture.catalog[0])
        let stale = try XCTUnwrap(rig.billing.reports.last)

        rig.billing.setDispatches([.success(ApplePurchaseDispatch(
            appAccountToken: Fixture.accountToken,
            attemptId: "attempt-after-takeover"))])
        rig.billing.setOutcomeFailures([
            AppleBillingError.continuationRejected,
            AppleBillingError.network,
        ])
        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.billing.dispatchContinuations.count, 2,
                       "the superseded local arm remained a permanent lock")
        let sent = try reports(rig.billing, count: 3)
        XCTAssertEqual(sent[1], stale, "the owed report was not replayed exactly")
        XCTAssertEqual(sent[2].attemptID, "attempt-after-takeover")
        let current = try XCTUnwrap(ApplePurchaseCapabilityRepository(store: capabilityStore).load())
        XCTAssertEqual(current.attemptID, "attempt-after-takeover")
        XCTAssertNotEqual(current.armRequestID, stale.armRequestID)
    }

    /// The non-secret journal is an intentional second persistence path. If the
    /// Keychain write failed while recording the outcome, a later 403 must still
    /// retire the otherwise-identical inert capability rather than wedge forever.
    func testARejectedJournalOnlyOutcomeReplayRetiresTheSupersededArm() async throws {
        let capabilityStore = LockableCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)

        rig.billing.setOutcomeFailures([AppleBillingError.network])
        rig.store.setOnPurchase { capabilityStore.setWritesFail(true) }
        rig.store.setPurchase(.success(.userCancelled))
        await rig.model.purchase(productID: Fixture.catalog[0])
        capabilityStore.setWritesFail(false)
        rig.store.setOnPurchase(nil)

        let persistedWithoutOutcome = try XCTUnwrap(
            ApplePurchaseCapabilityRepository(store: capabilityStore).load())
        XCTAssertNil(persistedWithoutOutcome.unconfirmedOutcome)
        XCTAssertEqual(rig.journal.count("outcome"), 1)

        // The first genuine supersession response arrives while Keychain is
        // unwritable. Retirement fails, so the journal must remain able to
        // reconstruct and replay the exact owed outcome on the next attempt.
        capabilityStore.setWritesFail(true)
        rig.billing.setOutcomeFailures([AppleBillingError.continuationRejected])
        await rig.model.purchase(productID: Fixture.catalog[0])
        XCTAssertEqual(rig.billing.dispatchContinuations.count, 1)
        XCTAssertEqual(
            ApplePurchaseCapabilityRepository(store: capabilityStore).load()?.attemptID,
            persistedWithoutOutcome.attemptID)

        capabilityStore.setWritesFail(false)
        rig.billing.setDispatches([.success(ApplePurchaseDispatch(
            appAccountToken: Fixture.accountToken,
            attemptId: "attempt-after-journal-takeover"))])
        rig.billing.setOutcomeFailures([
            AppleBillingError.continuationRejected,
            AppleBillingError.network,
        ])
        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.billing.dispatchContinuations.count, 2)
        let current = try XCTUnwrap(ApplePurchaseCapabilityRepository(store: capabilityStore).load())
        XCTAssertEqual(current.attemptID, "attempt-after-journal-takeover")
        XCTAssertNotEqual(current.armRequestID, persistedWithoutOutcome.armRequestID)
    }

    /// **The server's `resumable: false` is authoritative, even for a
    /// cancellation this client is certain of.**
    ///
    /// `RecordAppleBillingPurchaseOutcome` short-circuits an already-locked
    /// attempt to `Accepted: true, Resumable: false` whatever outcome was
    /// requested. Believing the request instead of the answer would plan a resume
    /// the server must refuse, while it still holds an attempt that may charge.
    func testAServerThatRefusesToResumeNeverAllowsARearm() async {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)

        rig.billing.setOutcomeResumables([false])
        rig.store.setPurchase(.success(.userCancelled))
        await rig.model.purchase(productID: Fixture.catalog[0])
        XCTAssertEqual(ApplePurchaseCapabilityRepository(store: capabilityStore).load()?.phase,
                       .locked, "a cancellation the server refused to resume was believed anyway")

        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.model.state, .failed(.billing(.continuationRejected)))
        XCTAssertEqual(rig.journal.count("purchase"), 1, "a second sheet was armed")
        XCTAssertEqual(rig.billing.dispatchContinuations.count, 1)
    }

    /// The same rule through the REPLAY path: a lost report whose replay is
    /// answered `resumable: false` locks and arms nothing.
    func testAReplayTheServerRefusesToResumeLocksRatherThanArming() async {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)

        rig.billing.setOutcomeFailures([AppleBillingError.network])
        rig.store.setPurchase(.success(.userCancelled))
        await rig.model.purchase(productID: Fixture.catalog[0])

        rig.billing.setOutcomeFailures([])
        rig.billing.setOutcomeResumables([false])
        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(ApplePurchaseCapabilityRepository(store: capabilityStore).load()?.phase, .locked)
        XCTAssertEqual(rig.model.state, .failed(.billing(.continuationRejected)))
        XCTAssertEqual(rig.journal.count("purchase"), 1, "a sheet opened after a refused replay")
        XCTAssertEqual(rig.billing.dispatchContinuations.count, 1)
    }

    /// **Generalizing the record to every outcome cannot widen one.**
    ///
    /// `pending` and a thrown store error are recorded and replayed **as
    /// themselves**, the server answers them honestly, and both lock. This is the
    /// proof that a replay path built for cancellations did not become a way for
    /// any other outcome to reach a second sheet.
    func testALostNonCancellationReplaysAsItselfAndStaysLocked() async throws {
        for (label, outcome, purchase) in [
            ("pending", ApplePurchaseOutcome.pending,
             Result<StorePurchaseOutcome, Error>.success(.pending)),
            ("thrown", ApplePurchaseOutcome.failed, .failure(AppleBillingError.network)),
        ] {
            let capabilityStore = InMemoryApplePurchaseCapabilityStore()
            let rig = await makeReadyContinuationRig(store: capabilityStore)
            rig.billing.setOutcomeFailures([AppleBillingError.network])
            rig.store.setPurchase(purchase)
            await rig.model.purchase(productID: Fixture.catalog[0])

            XCTAssertEqual(
                ApplePurchaseCapabilityRepository(store: capabilityStore).load()?.unconfirmedOutcome?.outcome,
                outcome, "\(label) was not recorded as itself")

            rig.billing.setOutcomeFailures([])
            await rig.model.purchase(productID: Fixture.catalog[0])

            let sent = try reports(rig.billing, count: 2)
            XCTAssertEqual(sent[1], sent[0], "\(label) did not replay as itself")
            XCTAssertEqual(ApplePurchaseCapabilityRepository(store: capabilityStore).load()?.phase,
                           .locked, "\(label) reached a resumable phase")
            XCTAssertEqual(rig.model.state, .failed(.billing(.continuationRejected)))
            XCTAssertEqual(rig.journal.count("purchase"), 1,
                           "\(label) armed a second sheet")
            XCTAssertEqual(rig.billing.dispatchContinuations.count, 1)
        }
    }

    /// **A record naming an older arm cannot touch a newer one.**
    ///
    /// `armRequestID` moves only on an authoritative 200, so the server has
    /// already superseded the arm this record is about. It is neither replayed
    /// nor sent, and the live arm is refused on its own merits.
    func testAStaleRecordedOutcomeCannotReleaseANewerArm() async throws {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        try ApplePurchaseCapabilityRepository(store: capabilityStore).save(
            ApplePurchaseCapability(
                attemptID: "attempt-one", appInstanceID: "instance-A",
                secret: "TEST-SECRET-NOT-REAL", armRequestID: "arm-live",
                productID: Fixture.catalog[0], phase: .armed,
                unconfirmedOutcome: ApplePurchaseOutcomeIntent(armRequestID: "arm-old",
                                                                outcome: .userCancelled)))
        let rig = await makeReadyContinuationRig(store: capabilityStore)

        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.model.state, .failed(.billing(.purchaseOutcomeRequired)))
        XCTAssertTrue(rig.billing.reports.isEmpty, "a stale record was sent to the server")
        XCTAssertTrue(rig.billing.dispatchContinuations.isEmpty, "a stale record armed a dispatch")
        XCTAssertEqual(rig.journal.count("purchase"), 0, "a stale record opened a sheet")
        XCTAssertEqual(ApplePurchaseCapabilityRepository(store: capabilityStore).load()?.armRequestID,
                       "arm-live", "the live arm was moved by a stale record")
    }

    /// **The capability is retired on authoritative convergence, and only then.**
    /// The server reporting the dispatch resolved is what releases it — never a
    /// clock, a TTL or a launch count.
    func testTheCapabilityIsRetiredOnlyWhenTheServerResolvesTheAttempt() async {
        let capabilityStore = InMemoryApplePurchaseCapabilityStore()
        let rig = await makeReadyContinuationRig(store: capabilityStore)

        // An accepted-but-unresolved answer keeps it: the attempt is still open.
        rig.billing.setSubmissions([.success(AppleTransactionResult(
            applied: true, planId: "pro", status: "active", expiresAt: 1_786_000_000,
            provider: "apple", dispatchPending: false, dispatchResolved: false))])
        await rig.model.purchase(productID: Fixture.catalog[0])
        XCTAssertNotNil(ApplePurchaseCapabilityRepository(store: capabilityStore).load(),
                        "the capability was retired before the attempt resolved")

        // The resolved answer retires it.
        let resolved = await makeReadyContinuationRig(store: capabilityStore)
        resolved.billing.setSubmissions([.success(AppleTransactionResult(
            applied: false, planId: "pro", status: "active", expiresAt: 1_786_000_000,
            provider: "apple", dispatchPending: false, dispatchResolved: true,
            dispatchResolvedAttemptId: "attempt-one"))])
        resolved.model.startObservingUpdates()
        resolved.store.deliverUpdate(Fixture.delivery)
        await waitFor(resolved) { $0.journal.count("submit") >= 1 }
        XCTAssertNil(ApplePurchaseCapabilityRepository(store: capabilityStore).load(),
                     "a resolved attempt left its capability behind")
    }
}
