import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit
@testable import RelayiumShareKit

/// The words the in-app purchase surface says, and the rules that choose them.
///
/// **Why this is a test file at all.** Every decision here used to be the kind
/// that lives inside a SwiftUI view: which sentence a failure gets, whether a
/// row is "your current plan", whether a build may link out to the website. Each
/// one is a claim to a paying customer at the moment something is going wrong,
/// and none of them is observable from a screenshot in either shipped language.
final class AppleSubscriptionPresentationTests: XCTestCase {

    private func offer(_ id: String, plan: String, name: String, cycle: String,
                       price: String = "$1.99",
                       sortOrder: Int64 = 10,
                       storageBytes: Int64? = nil,
                       trafficBytes: Int64? = nil) -> AppleSubscriptionOffer {
        AppleSubscriptionOffer(
            product: AppleCatalogProduct(productId: id, planId: plan, planName: name,
                                         cycle: cycle, sortOrder: sortOrder,
                                         storageBytes: storageBytes,
                                         trafficBytes: trafficBytes),
            store: SubscriptionOffer(id: id, displayName: name, description: "d",
                                     displayPrice: price))
    }

    func testTierUpIsImmediateWhileTierDownAndCycleChangesWaitForRenewal() {
        let offers = [
            offer("plus.m", plan: "plus", name: "Plus", cycle: "monthly", sortOrder: 10),
            offer("pro.m", plan: "pro", name: "Pro", cycle: "monthly", sortOrder: 20),
            offer("pro.y", plan: "pro", name: "Pro", cycle: "yearly", sortOrder: 20),
            offer("max.m", plan: "max", name: "Max", cycle: "monthly", sortOrder: 30),
        ]
        let rows = AppleSubscriptionPresentation.offerRows(
            offers, currentPlanID: "pro", currentCycle: "monthly", language: .en)
        XCTAssertEqual(rows.map(\.changeEffect),
                       [.nextRenewal, .current, .nextRenewal, .immediateUpgrade])
    }

    func testNonAppleEntitlementNeverShowsAppleChangeEffects() {
        let offers = [offer("plus.m", plan: "plus", name: "Plus", cycle: "monthly", sortOrder: 10),
                      offer("max.m", plan: "max", name: "Max", cycle: "monthly", sortOrder: 30)]
        for provider in ["stripe", "admin", "multiple"] {
            let rows = AppleSubscriptionPresentation.offerRows(offers, currentPlanID: "plus",
                currentCycle: "monthly", entitlementProvider: provider, language: .en)
            XCTAssertEqual(rows.map(\.changeEffect), [.current, .newSubscription])
            XCTAssertEqual(AppleSubscriptionPresentation.effectText(rows[1].changeEffect, language: .en), "")
        }
    }

    func testRenewalAttentionStatesAreTruthfulAndDistinct() {
        func state(retry: Bool = false, grace: Bool = false, auto: Bool = true,
                   expiration: Int64 = 0, price: Int64 = -1) -> AppleRenewalInfo {
            AppleRenewalInfo(available: true, currentProductId: "plus.m", renewalProductId: "plus.m",
                             renewalAt: 100, inBillingRetry: retry, inGracePeriod: grace, graceUntil: 100,
                             autoRenewEnabled: auto, expirationIntent: expiration, priceIncreaseStatus: price)
        }
        XCTAssertEqual(AppleSubscriptionPresentation.renewalNotice(state(retry: true), rows: [], language: .en), L10n.t(.subscriptionBillingRetry, language: .en))
        XCTAssertEqual(AppleSubscriptionPresentation.renewalNotice(state(auto: false), rows: [], language: .en), L10n.t(.subscriptionAutoRenewOff, language: .en))
        XCTAssertEqual(AppleSubscriptionPresentation.renewalNotice(state(expiration: 2), rows: [], language: .en), L10n.t(.subscriptionExpiredAttention, language: .en))
        XCTAssertEqual(AppleSubscriptionPresentation.renewalNotice(state(price: 0), rows: [], language: .en), L10n.t(.subscriptionPriceConsent, language: .en))
        XCTAssertEqual(AppleSubscriptionPresentation.renewalNotice(state(retry: true, grace: true, auto: false), rows: [], language: .en), L10n.t(.subscriptionGrace, language: .en))
    }

    func testCanonicalReconciliationFailureIsRecoverableCopy() {
        XCTAssertEqual(AppleSubscriptionPresentation.notice(for: .failed(.billing(.reconciliationUnavailable)), language: .en),
                       .failure(L10n.t(.subscriptionErrorReconciliation, language: .en)))
    }

    func testCompletedDeferredChangeUsesCanonicalRenewalFact() {
        let result = AppleTransactionResult(applied: true, planId: "plus", status: "active",
                                            expiresAt: 100, provider: "apple",
                                            currentProductId: "plus.monthly",
                                            autoRenewProductId: "pro.yearly", renewalAt: 100)
        XCTAssertEqual(AppleSubscriptionPresentation.notice(for: .completed(result), language: .en),
                       .success(L10n.t(.subscriptionEffectRenewal, language: .en)))
    }

    // MARK: - the distribution channel decides what may be offered

    /// **The compliance rule, stated once.** An App Store build sells in the app
    /// and may not send the user to a website to buy; a direct build has no
    /// in-app purchase and must keep the link it has always had.
    func testEachChannelOffersExactlyOneWayToChangeAPlan() {
        XCTAssertTrue(AppDistributionChannel.macAppStore.offersInAppPurchase)
        XCTAssertFalse(AppDistributionChannel.macAppStore.showsWebPlanHandoff)
        XCTAssertTrue(AppDistributionChannel.iosAppStore.offersInAppPurchase)
        XCTAssertFalse(AppDistributionChannel.iosAppStore.showsWebPlanHandoff)
        XCTAssertFalse(AppDistributionChannel.directDownload.offersInAppPurchase)
        XCTAssertTrue(AppDistributionChannel.directDownload.showsWebPlanHandoff)
    }

    func testSharedSubscriptionBodyDoesNotClaimTheIOSAppIsAMac() {
        let body = L10n.t(.subscriptionBody, language: .en)
        XCTAssertTrue(body.contains("this app"), body)
        XCTAssertFalse(body.contains("Mac"), body)
    }

    /// And neither channel can end up with both routes or with none. Two
    /// independent flags could; one derived from the other cannot.
    func testNoChannelOffersBothRoutesOrNeither() {
        for channel in AppDistributionChannel.allCases {
            XCTAssertNotEqual(channel.offersInAppPurchase, channel.showsWebPlanHandoff,
                              "\(channel) offers both routes to a plan change, or neither")
        }
    }

    // MARK: - offer rows

    /// The row carries the SERVER's plan name and the STORE's price, and the
    /// price is placed into a period sentence rather than reformatted.
    func testARowJoinsTheServersPlanNameToTheStoresPrice() {
        let rows = AppleSubscriptionPresentation.offerRows(
            [offer("p.m", plan: "pro", name: "Pro", cycle: "monthly", price: "US$4.99")],
            currentPlanID: "free", currentCycle: "monthly", language: .en)
        XCTAssertEqual(rows.map(\.productID), ["p.m"])
        XCTAssertEqual(rows.first?.title, "Pro")
        XCTAssertTrue(rows.first?.price.contains("US$4.99") == true,
                      "the store's own price was reformatted: \(rows.first?.price ?? "")")
        XCTAssertTrue(rows.first?.price.contains("month") == true)
    }

    /// The two periods are distinguishable, and an unrecognised one falls back
    /// to the bare price. A WRONG period beside a real number is a false
    /// statement about what the user is agreeing to pay; a missing one is merely
    /// incomplete, and the store's sheet states it again before charging.
    func testAnUnrecognisedCycleFallsBackToTheBarePriceRatherThanGuessing() {
        let monthly = AppleSubscriptionPresentation.price("$1", cycle: "monthly", language: .en)
        let yearly = AppleSubscriptionPresentation.price("$1", cycle: "yearly", language: .en)
        let unknown = AppleSubscriptionPresentation.price("$1", cycle: "weekly", language: .en)
        XCTAssertNotEqual(monthly, yearly)
        XCTAssertEqual(unknown, "$1")
    }

    /// The badge follows the account's own plan id AND billing period, both from
    /// `/api/me`.
    func testTheCurrentPlanBadgeFollowsTheAccountsOwnPlanAndCycle() {
        let offers = [offer("plus.m", plan: "plus", name: "Plus", cycle: "monthly"),
                      offer("pro.y", plan: "pro", name: "Pro", cycle: "yearly")]
        let rows = AppleSubscriptionPresentation.offerRows(offers, currentPlanID: "pro",
                                                           currentCycle: "yearly", language: .en)
        XCTAssertEqual(rows.map(\.isCurrentPlan), [false, true])
    }

    /// **The other billing period of the account's own tier is NOT current.**
    ///
    /// It is a different App Store product, a different commitment and a real
    /// charge. Marking it "current plan" tells a monthly subscriber they already
    /// hold the yearly plan they are reading about — and, because the badge also
    /// withdraws the button, takes away the only way they had to switch to it.
    func testTheSameTierOnTheOtherCycleIsManagedByApple() {
        let offers = [offer("pro.m", plan: "pro", name: "Pro", cycle: "monthly"),
                      offer("pro.y", plan: "pro", name: "Pro", cycle: "yearly")]
        let rows = AppleSubscriptionPresentation.offerRows(offers, currentPlanID: "pro",
                                                           currentCycle: "monthly", language: .en)
        XCTAssertEqual(rows.map(\.isCurrentPlan), [true, false])
        XCTAssertEqual(rows.map(\.offersSubscribe), [false, false])
    }

    /// **The exact product an account holds offers no Subscribe button.**
    /// Pressing it would be a second charge for what it is already paying for.
    func testTheExactHeldProductCannotBeBoughtAgain() {
        let rows = AppleSubscriptionPresentation.offerRows(
            [offer("pro.m", plan: "pro", name: "Pro", cycle: "monthly")],
            currentPlanID: "pro", currentCycle: "monthly", language: .en)
        XCTAssertEqual(rows.first?.isCurrentPlan, true)
        XCTAssertEqual(rows.first?.offersSubscribe, false)
    }

    /// **An empty plan id never matches.** It is what a signed-in account that
    /// has never subscribed carries, and marking a paid row as the current plan
    /// for such a user is exactly backwards.
    func testAnEmptyCurrentPlanMarksNothing() {
        let rows = AppleSubscriptionPresentation.offerRows(
            [offer("plus.m", plan: "", name: "Plus", cycle: "monthly")],
            currentPlanID: "", currentCycle: "", language: .en)
        XCTAssertEqual(rows.map(\.isCurrentPlan), [false])
        XCTAssertEqual(rows.map(\.offersSubscribe), [true])
    }

    /// **An unknown billing period never matches either**, even when the tier
    /// does. `""` is what a migrated source or a cancellation that carried no
    /// price leaves behind, and "we could not tell" is not "this is the one you
    /// are looking at". Failing this way leaves the row buyable, which is the
    /// safe direction: the alternative withdraws the button on the strength of a
    /// field nobody could read.
    func testAnUnknownCurrentCycleMarksNothingAndLeavesTheRowBuyable() {
        let offers = [offer("pro.m", plan: "pro", name: "Pro", cycle: "monthly"),
                      offer("pro.y", plan: "pro", name: "Pro", cycle: "yearly")]
        let rows = AppleSubscriptionPresentation.offerRows(offers, currentPlanID: "pro",
                                                           currentCycle: "", language: .en)
        XCTAssertEqual(rows.map(\.isCurrentPlan), [false, false])
        XCTAssertEqual(rows.map(\.offersSubscribe), [false, false])
    }

    // MARK: - what a tier grants, and which period it is billed on

    /// **The row states the tier's real quota, from the server's own figures.**
    /// A purchase screen that named a tier and a price and nothing else would be
    /// asking the reader to buy a word.
    func testARowStatesTheStorageAndTrafficTheServerSent() {
        let rows = AppleSubscriptionPresentation.offerRows(
            [offer("pro.m", plan: "pro", name: "Pro", cycle: "monthly",
                   storageBytes: 5 << 30, trafficBytes: 100 << 30)],
            currentPlanID: "", currentCycle: "", language: .en)
        let entitlements = rows.first?.entitlements
        XCTAssertNotNil(entitlements)
        XCTAssertTrue(entitlements?.contains("5.0 GB") == true, entitlements ?? "")
        XCTAssertTrue(entitlements?.contains("100.0 GB") == true, entitlements ?? "")
        XCTAssertTrue(entitlements?.contains("storage") == true, entitlements ?? "")
        XCTAssertTrue(entitlements?.contains("traffic") == true, entitlements ?? "")
    }

    /// A cap of 0 is the wire spelling of UNLIMITED — the same convention
    /// `/api/me/usage` publishes — and must read as the word, not as "0 B".
    func testAnUnlimitedCapReadsAsTheWordRatherThanZeroBytes() {
        let text = AppleSubscriptionPresentation.entitlements(
            storageBytes: 0, trafficBytes: 1 << 30, language: .en)
        XCTAssertEqual(text?.contains("0 B"), false, text ?? "")
        XCTAssertTrue(text?.contains(L10n.t(.usageUnlimited, language: .en)) == true, text ?? "")
    }

    /// **A server that sent no figures gets no sentence.** Zero-filling would
    /// advertise an unlimited plan on every deployment that predates the field,
    /// because 0 means unlimited — the most expensive possible default.
    func testAServerThatSentNoQuotaFiguresIsNotRenderedAsUnlimited() {
        let rows = AppleSubscriptionPresentation.offerRows(
            [offer("pro.m", plan: "pro", name: "Pro", cycle: "monthly")],
            currentPlanID: "", currentCycle: "", language: .en)
        XCTAssertNil(rows.first?.entitlements)
        XCTAssertNil(AppleSubscriptionPresentation.entitlements(storageBytes: 1, trafficBytes: nil))
        XCTAssertNil(AppleSubscriptionPresentation.entitlements(storageBytes: nil, trafficBytes: 1))
    }

    /// The two billing periods are labelled distinctly, in every language, and
    /// an unrecognised one is left blank rather than guessed — the same rule the
    /// price sentence follows, for the same reason.
    func testTheBillingPeriodIsLabelledDistinctlyAndNeverGuessed() {
        for language in AppLanguage.allCases {
            let monthly = AppleSubscriptionPresentation.cycleLabel("monthly", language: language)
            let yearly = AppleSubscriptionPresentation.cycleLabel("yearly", language: language)
            XCTAssertFalse(monthly.isEmpty, "\(language.rawValue) has no monthly label")
            XCTAssertFalse(yearly.isEmpty, "\(language.rawValue) has no yearly label")
            XCTAssertNotEqual(monthly, yearly, "\(language.rawValue) cannot tell the periods apart")
        }
        XCTAssertEqual(AppleSubscriptionPresentation.cycleLabel("weekly", language: .en), "")
    }

    /// And the label reaches the row, so the two products of one tier are
    /// distinguishable by something other than their prices.
    func testEachRowCarriesItsOwnPeriodLabel() {
        let offers = [offer("pro.m", plan: "pro", name: "Pro", cycle: "monthly"),
                      offer("pro.y", plan: "pro", name: "Pro", cycle: "yearly")]
        let rows = AppleSubscriptionPresentation.offerRows(offers, currentPlanID: "",
                                                           currentCycle: "", language: .en)
        XCTAssertEqual(rows.map(\.cycleLabel), ["Monthly", "Yearly"])
    }

    /// The server's order is preserved. It is the deployment's declared tier
    /// rank, and it is what a purchase screen reads down.
    func testTheRowsKeepTheOrderTheyWereGivenIn() {
        let offers = [offer("a", plan: "plus", name: "Plus", cycle: "monthly"),
                      offer("b", plan: "pro", name: "Pro", cycle: "monthly"),
                      offer("c", plan: "max", name: "Max", cycle: "monthly")]
        XCTAssertEqual(
            AppleSubscriptionPresentation.offerRows(offers, currentPlanID: "",
                                                    currentCycle: "", language: .en)
                .map(\.productID),
            ["a", "b", "c"])
    }

    // MARK: - the notice for every state

    /// Every state the model can publish has a decided answer, and the two
    /// silent ones are silent deliberately: `.idle` is the ordinary screen with
    /// buttons on it, and "nothing on sale" replaces the list rather than
    /// sitting beside it.
    func testEveryStateHasADecidedNotice() {
        let everyState: [AppleSubscriptionState] = [
            .unavailable, .purchasesPaused, .idle, .loadingOffers,
            .purchasing(productID: "p"), .submitting,
            .restoring, .deferred, .nothingToRestore,
            .completed(AppleTransactionResult(applied: true, planId: "pro", status: "active",
                                              expiresAt: 1, provider: "apple")),
            .failed(.billing(.network)),
        ]
        for state in everyState {
            let notice = AppleSubscriptionPresentation.notice(for: state, language: .en)
            switch state {
            case .idle, .unavailable:
                XCTAssertNil(notice, "\(state) grew a message beside its own controls")
            default:
                let text = try? XCTUnwrap(notice?.text)
                XCTAssertFalse(text?.isEmpty ?? true, "\(state) has no words")
            }
        }
    }

    /// **"Apple charged" and "Relayium recorded it" are different sentences.**
    /// The gap between them is the one interval a user most needs the truth
    /// about, and reusing the first message there would be false.
    func testTheChargeAndTheConfirmationAreNotTheSameSentence() {
        let purchasing = AppleSubscriptionPresentation.notice(
            for: .purchasing(productID: "p"), language: .en)
        let submitting = AppleSubscriptionPresentation.notice(for: .submitting, language: .en)
        XCTAssertNotEqual(purchasing?.text, submitting?.text)
        XCTAssertEqual(purchasing.map { if case .progress = $0 { return true } else { return false } },
                       true)
        XCTAssertEqual(submitting.map { if case .progress = $0 { return true } else { return false } },
                       true)
    }

    /// Ask to Buy and an empty restore are INFORMATION, not errors. Nothing was
    /// charged in the first and nothing went wrong in either; rendering them in
    /// red would tell a parent's household that a working feature broke.
    func testWaitingForApprovalAndAnEmptyRestoreAreNotFailures() {
        for state in [AppleSubscriptionState.deferred, .nothingToRestore] {
            guard case .info = AppleSubscriptionPresentation.notice(for: state, language: .en) else {
                return XCTFail("\(state) is rendered as something other than information")
            }
        }
    }

    // MARK: - the global purchase gate

    /// **A paused server is not a broken one, and not an empty product either.**
    ///
    /// Three things about the sentence matter, and each is a claim to somebody
    /// who was about to pay: it is INFORMATION rather than a failure (nothing
    /// went wrong, nothing was charged, there is nothing to retry), it says the
    /// state is temporary, and it says an existing subscription is unaffected —
    /// which is the second question anybody reading it asks.
    func testAPausedServerReadsAsTemporaryInformationRatherThanAFailure() {
        guard case .info(let text) = AppleSubscriptionPresentation.notice(
            for: .purchasesPaused, language: .en) else {
            return XCTFail("a paused server is rendered as something other than information")
        }
        XCTAssertTrue(text.contains("paused"), text)
        XCTAssertTrue(text.contains("temporary"), text)
        XCTAssertTrue(text.contains("unaffected"), text)
    }

    /// And it is NOT the "there is nothing to subscribe to" sentence. A paused
    /// deployment answers with an empty catalog, so the two states arrive at the
    /// surface looking identical; saying "there is nothing to subscribe to from
    /// this app" would be a false statement about the product rather than a true
    /// one about the moment.
    func testPausedAndNothingOnSaleAreDifferentSentences() {
        for language in AppLanguage.allCases {
            let paused = AppleSubscriptionPresentation.notice(
                for: .purchasesPaused, language: language)?.text
            let none = L10n.t(.subscriptionNone, language: language)
            XCTAssertNotNil(paused, "\(language.rawValue) has no paused sentence")
            XCTAssertNotEqual(paused, none,
                              "\(language.rawValue) says the same thing for both states")
        }
    }

    /// Losing the race against the operator — the screen was drawn while the
    /// server was selling, and Subscribe was pressed after it stopped — reads as
    /// the SAME sentence a user who arrived a second later would see. Nothing
    /// was charged, and a second differently-worded explanation would suggest
    /// something else had gone wrong.
    func testRacingThePauseSaysTheSameThingAsArrivingAfterIt() {
        XCTAssertEqual(AppleSubscriptionPresentation.message(for: .purchasesPaused, language: .en),
                       AppleSubscriptionPresentation.notice(for: .purchasesPaused,
                                                            language: .en)?.text)
    }

    func testACompletedPurchaseReadsAsSuccess() {
        let notice = AppleSubscriptionPresentation.notice(
            for: .completed(AppleTransactionResult(applied: true, planId: "pro", status: "active",
                                                   expiresAt: 1, provider: "apple")),
            language: .en)
        guard case .success = notice else {
            return XCTFail("a completed purchase does not read as success")
        }
    }

    // MARK: - failure copy

    /// **Every failure has its own sentence, and no two classes collapse into
    /// one except where that is argued.** The groups that DO share wording are
    /// pinned here too, so merging one more into them is a visible edit.
    ///
    /// `.billing(.initialArmRejected)` is the one case deliberately absent: it
    /// is a code CARRIER rather than a class, the model resolves its codes into
    /// `purchasesPaused`, `selectionChanged` or `purchaseNotAllowed` before this
    /// layer sees it, and pinning the wording of its unresolved fallback here
    /// would freeze an answer no path produces.
    func testEveryFailureClassIsWordedAndTheOverlapsAreTheIntendedOnes() {
        let everyFailure: [AppleSubscriptionFailure] = [
            .billing(.notSignedIn), .billing(.network), .billing(.rateLimited),
            .billing(.invalidTransaction), .billing(.decoding), .billing(.tokenMismatch),
            .billing(.subscriptionOwned), .billing(.appleSubscriptionConflict),
            .billing(.verifierUnavailable),
            .billing(.unknownBundle), .billing(.server(status: 418)),
            .billing(.reconciliationUnavailable), .billing(.purchaseOutcomeRequired),
            .billing(.continuationRejected),
            .billing(.purchaseAuthorityManaged(provider: "apple")),
            .unexpected(type: "StoreFailure"),
            .purchaseNotAllowed(blockedBy: "stripe"),
            .purchaseNotAllowed(blockedBy: "admin"),
            .purchaseNotAllowed(blockedBy: "apple"),
            .purchaseNotAllowed(blockedBy: ""),
            .purchasesPaused, .selectionChanged,
        ]
        var seen: [String: [String]] = [:]
        for failure in everyFailure {
            let text = AppleSubscriptionPresentation.message(for: failure, language: .en)
            XCTAssertFalse(text.isEmpty, "\(failure) has no words")
            seen[text, default: []].append(String(describing: failure))
        }
        // Two groups share wording, and each one is argued.
        //
        // 1. A refused JWS and an unreadable 200 are the same fact to the user,
        //    and have the same repair.
        // 2. The reconciliation family. Canonical status unavailable, a sheet
        //    whose outcome was never reported, a capability this device can no
        //    longer present, and an earlier attempt the server has not resolved
        //    are one fact on screen — Apple has not confirmed this yet — and one
        //    repair. `purchaseAuthorityManaged` is in this group and not beside
        //    the eligibility blocks despite its name: it carries only 409
        //    `purchase_reconciliation_required`, which is a statement about an
        //    unresolved ATTEMPT, so wording it as ownership would tell somebody
        //    who has never completed a purchase that they already subscribe.
        //
        // Nothing else may join either: in particular a purchase already
        // completed by Apple needs different recovery wording from a
        // pre-purchase eligibility block, and the eligibility blocks — which
        // assert a subscription DOES exist — may never collapse into group 2.
        let collapsed = seen.values.filter { $0.count > 1 }.map { $0.sorted() }.sorted { $0[0] < $1[0] }
        XCTAssertEqual(collapsed,
                       [["billing(RelayiumKit.AppleBillingError.continuationRejected)",
                         "billing(RelayiumKit.AppleBillingError.purchaseAuthorityManaged(provider: \"apple\"))",
                         "billing(RelayiumKit.AppleBillingError.purchaseOutcomeRequired)",
                         "billing(RelayiumKit.AppleBillingError.reconciliationUnavailable)"],
                        ["billing(RelayiumKit.AppleBillingError.decoding)",
                         "billing(RelayiumKit.AppleBillingError.invalidTransaction)"]],
                       "failure classes share wording that was not argued: \(collapsed)")
    }

    /// **This layer, on its own, never words an unresolved attempt as
    /// ownership — in either shipped language, for any provider value.**
    ///
    /// `AppleSubscriptionModel` already maps `purchaseAuthorityManaged` onto the
    /// reconciliation answer, so today nothing arrives here carrying it. This is
    /// the second lock: `message(for:)` is public, a view or a future call site
    /// may present a raw `AppleBillingError`, and the case NAME reads like an
    /// authority conflict while its only wire preimage — 409
    /// `purchase_reconciliation_required` — is a statement about one purchase
    /// ATTEMPT that has not converged. Wording it from `provider` would tell a
    /// user who has never completed an App Store purchase that they already have
    /// a subscription, and send them to a Manage Subscriptions screen with
    /// nothing on it.
    ///
    /// The provider is varied deliberately: it is echoed from the body and names
    /// where the stuck attempt lives, so no value of it may select a sentence.
    func testAnUnresolvedAttemptIsNeverWordedAsOwnershipByThisLayerAlone() {
        for provider in ["apple", "stripe", "admin", "something_new", ""] {
            for language in [AppLanguage.en, .zh] {
                let shown = AppleSubscriptionPresentation.message(
                    for: .billing(.purchaseAuthorityManaged(provider: provider)), language: language)
                XCTAssertEqual(shown, L10n.t(.subscriptionErrorReconciliation, language: language),
                               "provider \(provider) lost the reconciliation sentence in \(language)")
                for owned: L10nKey in [.subscriptionBlockedByAppleApp, .subscriptionBlockedByWeb,
                                       .subscriptionBlockedByAdmin, .subscriptionBlockedByOther] {
                    XCTAssertNotEqual(shown, L10n.t(owned, language: language),
                                      "provider \(provider) was worded as \(owned) in \(language)")
                }
            }
        }
    }

    /// **The other half: a REAL authority refusal still names the channel that
    /// holds the subscription.** `manage_with_apple` and
    /// `billing_authority_conflict` are decided from the ACCOUNT and reach this
    /// layer as `.purchaseNotAllowed(blockedBy:)`. Softening either into the
    /// reconciliation sentence would hide the one screen where a user can stop a
    /// charge they are already paying.
    func testATrueAuthorityRefusalStillNamesTheChannelThatHoldsIt() {
        let expected: [String: L10nKey] = ["apple": .subscriptionBlockedByAppleApp,
                                           "stripe": .subscriptionBlockedByWeb,
                                           "admin": .subscriptionBlockedByAdmin,
                                           "": .subscriptionBlockedByOther]
        for (provider, key) in expected {
            for language in [AppLanguage.en, .zh] {
                let shown = AppleSubscriptionPresentation.message(
                    for: .purchaseNotAllowed(blockedBy: provider), language: language)
                XCTAssertEqual(shown, L10n.t(key, language: language),
                               "\(provider) lost its ownership sentence in \(language)")
                XCTAssertNotEqual(shown,
                                  L10n.t(.subscriptionErrorReconciliation, language: language),
                                  "\(provider) was softened into reconciliation in \(language)")
            }
        }
    }

    func testCompletedAppleConflictNamesThePostChargeRecovery() {
        let message = AppleSubscriptionPresentation.message(
            for: .billing(.appleSubscriptionConflict), language: .en)
        let preflight = AppleSubscriptionPresentation.message(
            for: .purchaseNotAllowed(blockedBy: "apple"), language: .en)

        XCTAssertNotEqual(message, preflight)
        XCTAssertTrue(message.contains("completed this purchase"), message)
        XCTAssertTrue(message.contains("retained"), message)
        XCTAssertTrue(message.contains("refund"), message)
        XCTAssertTrue(message.contains("restore"), message)
    }

    /// The self-repairing refusals say so. Most of these leave an unfinished
    /// transaction the App Store will deliver again — the money moved and the
    /// purchase is not lost — and a message that said only "something went
    /// wrong" would send a paying customer to support or to buying it twice.
    func testTheSelfRepairingRefusalsSayThePurchaseIsNotLost() {
        for failure: AppleSubscriptionFailure in [.billing(.network),
                                                  .billing(.invalidTransaction),
                                                  .billing(.decoding),
                                                  .billing(.verifierUnavailable)] {
            let text = AppleSubscriptionPresentation.message(for: failure, language: .en)
            XCTAssertTrue(text.contains("again"),
                          "\(failure) does not tell the user the store will offer it again: \(text)")
        }
    }

    /// The status code is carried, isolated as a token so it keeps its reading
    /// order inside a right-to-left sentence.
    func testAnUnmappedServerRefusalNamesItsStatus() {
        let text = AppleSubscriptionPresentation.message(for: .billing(.server(status: 418)),
                                                         language: .en)
        XCTAssertTrue(text.contains("418"), text)
    }

    // MARK: - eligibility

    /// Each provider the server can name gets its own sentence, because the
    /// ACTION differs: cancel it on the web, or nothing to do at all.
    func testEachBlockingProviderGetsItsOwnSentence() {
        let web = AppleSubscriptionPresentation.eligibilityNotice(
            AppleCatalogPurchase(allowed: false, blockedBy: "stripe"), language: .en)
        let admin = AppleSubscriptionPresentation.eligibilityNotice(
            AppleCatalogPurchase(allowed: false, blockedBy: "admin"), language: .en)
        let apple = AppleSubscriptionPresentation.eligibilityNotice(
            AppleCatalogPurchase(allowed: false, blockedBy: "apple"), language: .en)
        XCTAssertNotNil(web)
        XCTAssertNotNil(admin)
        XCTAssertNotNil(apple)
        XCTAssertNotEqual(web, admin)
        XCTAssertNotEqual(apple, web)
        XCTAssertNotEqual(apple, admin)
        XCTAssertTrue(web?.contains("relayium.com") == true,
                      "the web notice does not say where to cancel: \(web ?? "")")
        XCTAssertTrue(apple?.contains("restore") == true,
                      "the Apple notice does not offer the safe recovery path: \(apple ?? "")")
    }

    /// **An unrecognised provider is still a refusal.** This layer never turns
    /// "I do not know this value" into "go ahead and pay".
    func testAnUnrecognisedBlockingProviderStillRefuses() {
        let text = AppleSubscriptionPresentation.eligibilityNotice(
            AppleCatalogPurchase(allowed: false, blockedBy: "something_new"), language: .en)
        XCTAssertNotNil(text)
        XCTAssertFalse(text?.isEmpty ?? true)
    }

    /// Allowed, and unknown, are both silent — but for different reasons, and
    /// only one of them permits a purchase (which the model, not this layer,
    /// enforces). A "managed elsewhere" sentence beside a load that failed would
    /// be a guess.
    func testAnAllowedOrUnknownEligibilityShowsNoNotice() {
        XCTAssertNil(AppleSubscriptionPresentation.eligibilityNotice(
            AppleCatalogPurchase(allowed: true, blockedBy: ""), language: .en))
        XCTAssertNil(AppleSubscriptionPresentation.eligibilityNotice(nil, language: .en))
    }

    // MARK: - Apple-provider management

    /// The control leads to the App Store's own subscription list, so it belongs
    /// on screen exactly when there IS an App Store subscription — including the
    /// double-billed case, where it is the only way to stop the charge the user
    /// most wants stopped.
    func testTheAppleManagementControlFollowsTheLiveProvider() {
        XCTAssertTrue(AppleSubscriptionPresentation.showsAppleManagement(entitlementProvider: "apple"))
        XCTAssertTrue(AppleSubscriptionPresentation.showsAppleManagement(entitlementProvider: "multiple"))
        for other in ["", "stripe", "admin", "something_new"] {
            XCTAssertFalse(
                AppleSubscriptionPresentation.showsAppleManagement(entitlementProvider: other),
                "\(other) was offered an App Store subscription control")
        }
    }

    /// **The two legal links the purchase surface is required to carry.**
    ///
    /// Apple's rule for an auto-renewing subscription is a *functional* link to
    /// the privacy policy and to the terms it is sold under, from the screen
    /// that sells it. This pins the halves a view cannot be trusted with: that
    /// the destinations are Relayium's own published pages rather than the
    /// pricing page or the App Store, and that they are two documents rather
    /// than one constant used twice.
    func testTheLegalDestinationsAreTheProductsOwnPolicyPages() {
        XCTAssertEqual(AppEnvironment.privacyWebURL.absoluteString,
                       "https://relayium.com/privacy/")
        XCTAssertEqual(AppEnvironment.termsWebURL.absoluteString,
                       "https://relayium.com/terms/")
        XCTAssertNotEqual(AppEnvironment.privacyWebURL, AppEnvironment.termsWebURL)
        // Neither is the plan page or Apple's — a legal link that led to either
        // would look present and satisfy nothing.
        for url in [AppEnvironment.privacyWebURL, AppEnvironment.termsWebURL] {
            XCTAssertNotEqual(url, AppEnvironment.plansWebURL)
            XCTAssertNotEqual(url, AppEnvironment.appleSubscriptionsURL)
        }
    }

    /// Each label is the title of the page it opens, in that language, and the
    /// two are never the same word. A catalog that copied one line over the
    /// other would give a reviewer two links reading "Privacy Policy" — the
    /// failure `LocalizationIntegrityTests` cannot see, because both keys are
    /// present and neither is empty.
    func testTheTwoLegalLabelsAreDistinctInEveryLanguage() {
        for language in AppLanguage.allCases {
            let privacy = L10n.t(.subscriptionPrivacy, language: language)
            let terms = L10n.t(.subscriptionTerms, language: language)
            XCTAssertNotEqual(privacy, terms,
                              "\(language) names both legal pages the same thing")
            for text in [privacy, terms] {
                XCTAssertFalse(text.isEmpty, "\(language)")
                XCTAssertFalse(text.hasPrefix("subscription."),
                               "\(language) fell through to the key: \(text)")
            }
        }
        // The English pair, spelled out, because these two are what App Store
        // review reads and they are the ones a rename would quietly change.
        XCTAssertEqual(L10n.t(.subscriptionPrivacy, language: .en), "Privacy Policy")
        XCTAssertEqual(L10n.t(.subscriptionTerms, language: .en), "Terms of Service")
    }

    /// It leads to Apple, not to Relayium. A Relayium page would show no
    /// subscription and no control that works.
    func testTheManagementDestinationIsApples() {
        XCTAssertEqual(AppEnvironment.appleSubscriptionsURL.host, "apps.apple.com")
        XCTAssertEqual(AppEnvironment.appleSubscriptionsURL.path, "/account/subscriptions")
        XCTAssertNotEqual(AppEnvironment.appleSubscriptionsURL.host,
                          AppEnvironment.productionBaseURL.host)
    }

    // MARK: - every language

    /// Both shipped catalogs, every new sentence, no key falling through to its
    /// own name. `LocalizationIntegrityTests` proves the keys EXIST everywhere; this
    /// proves the ones this surface actually renders resolve to words.
    func testEverySubscriptionSentenceResolvesInEveryLanguage() {
        let states: [AppleSubscriptionState] = [
            .loadingOffers, .purchasing(productID: "p"), .submitting, .restoring,
            .deferred, .nothingToRestore,
            .completed(AppleTransactionResult(applied: true, planId: "pro", status: "active",
                                              expiresAt: 1, provider: "apple")),
            .failed(.billing(.network)), .failed(.purchaseNotAllowed(blockedBy: "stripe")),
        ]
        for language in AppLanguage.allCases {
            for state in states {
                let text = AppleSubscriptionPresentation.notice(for: state, language: language)?.text
                let resolved = try? XCTUnwrap(text)
                XCTAssertFalse(resolved?.isEmpty ?? true, "\(language) \(state)")
                XCTAssertFalse(resolved?.hasPrefix("subscription.") ?? true,
                               "\(language) fell through to the key for \(state)")
            }
            for key: L10nKey in [.subscriptionHeading, .subscriptionBody, .subscriptionNone,
                                 .subscriptionSubscribe, .subscriptionCurrent,
                                 .subscriptionRestore, .subscriptionManage,
                                 .subscriptionManagedByApple,
                                 .subscriptionPrivacy, .subscriptionTerms] {
                let text = L10n.t(key, language: language)
                XCTAssertFalse(text.isEmpty, "\(language) \(key)")
                XCTAssertNotEqual(text, key.rawValue, "\(language) fell through for \(key)")
            }
            // The price sentences keep the store's own number intact in every
            // language — including the right-to-left one, where the token
            // wrapper is what stops the digits being re-ordered around it.
            for cycle in ["monthly", "yearly"] {
                let text = AppleSubscriptionPresentation.price("US$4.99", cycle: cycle,
                                                               language: language)
                XCTAssertTrue(text.contains("4.99"), "\(language) \(cycle): \(text)")
            }
        }
    }
}
