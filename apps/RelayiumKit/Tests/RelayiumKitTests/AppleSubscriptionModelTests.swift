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
    private var _synchronize: Result<Void, Error> = .success(())
    private var _finished: [StoreTransactionID] = []
    private var _requestedIDs: [[String]] = []
    private var _appAccountTokens: [UUID] = []
    private var _continuation: AsyncStream<SignedStoreTransaction>.Continuation?
    private var _updateStreamsTerminated = 0
    private var _onPurchase: (@Sendable () -> Void)?
    private var _holdSynchronize = false

    init(journal: PurchaseJournal) { self.journal = journal }

    // configuration
    func setOffers(_ value: Result<[SubscriptionOffer], Error>) { sync { _offers = value } }
    func setPurchase(_ value: Result<StorePurchaseOutcome, Error>) { sync { _purchase = value } }
    func setEntitlements(_ value: [SignedStoreTransaction]) { sync { _entitlements = value } }
    func setSynchronize(_ value: Result<Void, Error>) { sync { _synchronize = value } }
    /// Run something at the moment the store would be charging the user — the
    /// only place from which "the session ended while the sheet was open" can be
    /// staged truthfully.
    func setOnPurchase(_ body: (@Sendable () -> Void)?) { sync { _onPurchase = body } }
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
        return try sync { _purchase }.get()
    }

    func currentEntitlements() async -> [SignedStoreTransaction] {
        journal.record("currentEntitlements")
        return sync { _entitlements }
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

/// Relayium's billing endpoints, scripted.
private final class FakeBilling: AppleBillingService, @unchecked Sendable {
    private let lock = NSLock()
    private let journal: PurchaseJournal

    private var _accountToken: Result<UUID, Error>
    private var _submissions: [Result<AppleTransactionResult, Error>] = []
    private var _submittedJWS: [String] = []
    private var _submittedBearers: [String] = []
    private var _accountTokenBearers: [String] = []
    /// Submissions from this 1-based call number onwards park until released.
    /// `nil` holds nothing.
    private var _holdSubmitAfter: Int?

    init(journal: PurchaseJournal, accountToken: UUID) {
        self.journal = journal
        self._accountToken = .success(accountToken)
    }

    func setAccountToken(_ value: Result<UUID, Error>) { sync { _accountToken = value } }
    /// Answers, consumed in order. The last one repeats once the list runs out.
    func setSubmissions(_ values: [Result<AppleTransactionResult, Error>]) {
        sync { _submissions = values }
    }
    /// Park every submission after the first `calls` of them, so a test can
    /// catch one genuinely in flight and supersede the operation that started
    /// it. `holdSubmit(after: 0)` parks the first.
    func holdSubmit(after calls: Int) { sync { _holdSubmitAfter = calls } }
    func releaseSubmit() { sync { _holdSubmitAfter = nil } }

    var submittedJWS: [String] { sync { _submittedJWS } }
    var submittedBearers: [String] { sync { _submittedBearers } }
    var accountTokenBearers: [String] { sync { _accountTokenBearers } }

    func appleAccountToken(token: String) async throws -> UUID {
        journal.record("accountToken")
        sync { _accountTokenBearers.append(token) }
        return try sync { _accountToken }.get()
    }

    func submitAppleTransaction(signedTransactionInfo: String,
                                token: String) async throws -> AppleTransactionResult {
        journal.record("submit")
        sync {
            _submittedJWS.append(signedTransactionInfo)
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
    static let accountToken = UUID(uuidString: "3F2504E0-4F89-41D3-9A0C-0305E82C3301")!
    static let jws = "eyJhbGciOiJFUzI1NiJ9.eyJ0eCI6IjEifQ.SIG-not-touched_-~"
    static let delivery = SignedStoreTransaction(
        id: StoreTransactionID(rawValue: 7_001), jws: jws)
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
        .billing(.server(status: 409)),
        .billing(.rateLimited),              // 429
        .billing(.server(status: 500)),
        .billing(.verifierUnavailable),      // 503 — today's shipping default
        .billing(.server(status: 503)),
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

    private func makeRig(catalog: [String] = Fixture.catalog,
                         bearer: String? = "rlm_app_T") -> Rig {
        let journal = PurchaseJournal()
        let store = FakeStore(journal: journal)
        let billing = FakeBilling(journal: journal, accountToken: Fixture.accountToken)
        let box = BearerBox(bearer)
        let model = AppleSubscriptionModel(
            store: store, billing: billing, catalog: catalog,
            bearer: { box.current },
            refreshAccount: { journal.record("refresh") })
        return Rig(model: model, store: store, billing: billing, journal: journal, bearer: box)
    }

    /// A rig whose offers are already loaded, which is the precondition every
    /// purchase has.
    private func makeReadyRig(bearer: String? = "rlm_app_T") async -> Rig {
        let rig = makeRig(bearer: bearer)
        rig.store.setOffers(.success(Fixture.offers(Fixture.catalog)))
        await rig.model.loadOffers()
        rig.store.setPurchase(.success(.delivered(Fixture.delivery)))
        rig.billing.setSubmissions([.success(Fixture.entitlement)])
        return rig
    }

    // MARK: - the finish rule, stated on its own

    /// The rule, isolated from every path that uses it. One arm permits it.
    func testOnlyAnAcceptedSubmissionPermitsFinish() {
        XCTAssertTrue(AppleSubmission.accepted(Fixture.entitlement).permitsFinish)
        // `applied: false` is a redelivery the server has converged on — still a
        // decoded 200, still finishable. This is the one non-obvious acceptance,
        // and treating it as a refusal would leave every renewal unfinished.
        XCTAssertTrue(AppleSubmission.accepted(
            AppleTransactionResult(applied: false, planId: "free", status: "canceled",
                                   expiresAt: 0, provider: "apple")).permitsFinish)
        for failure in Fixture.everyRefusal {
            XCTAssertFalse(AppleSubmission.refused(failure).permitsFinish,
                           "\(failure) permits a finish")
        }
    }

    // MARK: - the successful purchase, in order

    /// The whole ordering claim in one test: attribute, buy, SUBMIT, then finish,
    /// then reload the account from the server.
    ///
    /// `submit` before `finish` is the safety property. `refresh` after
    /// acceptance is the authority property — what the user ends up seeing is
    /// `/api/me`'s answer, not anything this model concluded.
    func testASuccessfulPurchaseSubmitsThenFinishesThenRefreshes() async {
        let rig = await makeReadyRig()
        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.journal.all,
                       ["offers", "accountToken", "purchase", "submit", "finish", "refresh"])
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
        XCTAssertEqual(rig.billing.submittedBearers, ["rlm_app_T"])
    }

    /// The account token is fetched BEFORE the store is asked to charge anyone.
    /// A server that cannot mint one leaves no purchase sheet and no money moved.
    func testAFailureToMintTheAccountTokenNeverReachesTheStore() async {
        let rig = await makeReadyRig()
        rig.billing.setAccountToken(.failure(AppleBillingError.server(status: 500)))
        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.journal.all, ["offers", "accountToken"])
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

        XCTAssertEqual(rig.journal.all, ["offers", "accountToken", "purchase"])
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

        XCTAssertEqual(rig.journal.all, ["offers", "accountToken", "purchase"])
        XCTAssertEqual(rig.model.state, .deferred)
        XCTAssertTrue(rig.store.finished.isEmpty)
        XCTAssertEqual(rig.journal.count("refresh"), 0)
    }

    // MARK: - signed out

    /// Signed out, nothing is asked of the store OR of the billing service. A
    /// purchase started here would be a charge with no account to attribute to,
    /// and StoreKit would complete it perfectly happily.
    func testASignedOutPurchaseTouchesNeitherDependency() async {
        let rig = await makeReadyRig(bearer: nil)
        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.journal.all, ["offers"], "a signed-out purchase reached a dependency")
        XCTAssertEqual(rig.model.state, .failed(.billing(.notSignedIn)))
    }

    /// An empty string is not a credential. Sending it would produce an
    /// `Authorization: Bearer ` header that can only be refused.
    func testAnEmptyBearerIsTreatedAsSignedOut() async {
        let rig = await makeReadyRig(bearer: "")
        await rig.model.purchase(productID: Fixture.catalog[0])
        XCTAssertEqual(rig.journal.all, ["offers"])
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

        XCTAssertEqual(rig.journal.all, ["offers", "accountToken", "purchase"])
        XCTAssertEqual(rig.model.state, .failed(.billing(.notSignedIn)))
        XCTAssertTrue(rig.store.finished.isEmpty)
    }

    // MARK: - the empty catalog

    /// **The shipping state of this batch.** With no product identifiers the
    /// feature is unavailable, and proving it is inert means proving that no
    /// call reaches either dependency — not that a flag says so.
    func testAnEmptyCatalogNeverTouchesTheStoreOrTheBillingService() async {
        let rig = makeRig(catalog: [])
        XCTAssertEqual(rig.model.state, .unavailable)
        XCTAssertFalse(rig.model.hasCatalog)

        await rig.model.loadOffers()
        await rig.model.purchase(productID: "com.relayium.plus.monthly")
        await rig.model.restore()
        rig.model.startObservingUpdates()

        XCTAssertEqual(rig.journal.all, [],
                       "an unavailable feature reached a dependency: \(rig.journal.all)")
        XCTAssertEqual(rig.model.state, .unavailable)
        XCTAssertTrue(rig.model.offers.isEmpty)
        XCTAssertTrue(rig.store.finished.isEmpty)
    }

    /// A store that recognises none of the configured identifiers leaves the
    /// user where an empty catalog does — nothing to buy — so it is reported the
    /// same way rather than as an idle screen with no products on it.
    func testAStoreThatKnowsNoneOfTheCatalogIsAlsoUnavailable() async {
        let rig = makeRig()
        rig.store.setOffers(.success([]))
        await rig.model.loadOffers()
        XCTAssertEqual(rig.model.state, .unavailable)
        XCTAssertTrue(rig.model.offers.isEmpty)
    }

    /// A product that was never offered cannot be priced or described, and a
    /// charge behind it would be for something this build has never seen.
    func testAProductThatWasNeverOfferedCannotBePurchased() async {
        let rig = await makeReadyRig()
        await rig.model.purchase(productID: "com.relayium.something.else")
        XCTAssertEqual(rig.journal.all, ["offers"])
        XCTAssertEqual(rig.model.state, .unavailable)
    }

    func testLoadOffersPublishesExactlyWhatTheStoreReturned() async {
        let rig = makeRig()
        rig.store.setOffers(.success(Fixture.offers([Fixture.catalog[0]])))
        await rig.model.loadOffers()
        XCTAssertEqual(rig.store.requestedIDs, [Fixture.catalog])
        XCTAssertEqual(rig.model.offers.map(\.id), [Fixture.catalog[0]])
        XCTAssertEqual(rig.model.state, .idle)
    }

    func testAFailedCatalogLoadClearsTheOffersRatherThanKeepingStaleOnes() async {
        let rig = makeRig()
        rig.store.setOffers(.success(Fixture.offers(Fixture.catalog)))
        await rig.model.loadOffers()
        XCTAssertEqual(rig.model.offers.count, 2)
        rig.store.setOffers(.failure(StoreFailure()))
        await rig.model.loadOffers()
        XCTAssertTrue(rig.model.offers.isEmpty)
        XCTAssertEqual(rig.model.state, .failed(.unexpected(type: "StoreFailure")))
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
                           ["offers", "accountToken", "purchase", "submit"],
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

    /// A redelivery the server converged on — `applied: false` — IS an
    /// acceptance, and is finished. Leaving it unfinished would make every
    /// renewal accumulate forever in the store's queue.
    func testAnUnappliedButAcceptedRedeliveryIsFinished() async {
        let rig = await makeReadyRig()
        let converged = AppleTransactionResult(applied: false, planId: "plus", status: "active",
                                               expiresAt: 1_786_000_000, provider: "apple")
        rig.store.setPurchase(.success(.delivered(Fixture.delivery)))
        rig.billing.setSubmissions([.success(converged)])
        await rig.model.purchase(productID: Fixture.catalog[0])

        XCTAssertEqual(rig.store.finished, [Fixture.delivery.id])
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
                       ["offers", "synchronize", "currentEntitlements",
                        "submit", "finish", "submit", "finish", "refresh"])
        XCTAssertEqual(rig.store.finished, [Fixture.delivery.id, second.id])
        XCTAssertEqual(rig.billing.submittedJWS, [Fixture.jws, "j2"])
        XCTAssertEqual(rig.model.state, .completed(Fixture.entitlement))
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

        XCTAssertEqual(rig.journal.all, ["offers"])
        XCTAssertEqual(rig.model.state, .failed(.billing(.notSignedIn)))
    }

    func testAFailedSynchronizeStopsTheRestore() async {
        let rig = await makeReadyRig()
        rig.store.setSynchronize(.failure(StoreFailure()))
        rig.store.setEntitlements([Fixture.delivery])
        await rig.model.restore()

        XCTAssertEqual(rig.journal.all, ["offers", "synchronize"])
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
