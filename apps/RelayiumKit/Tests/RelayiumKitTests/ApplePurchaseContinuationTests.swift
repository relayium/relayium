import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// **The purchase-continuation state machine, driven exhaustively.**
///
/// Every rule here is a money rule, and each test is named for the loss it
/// prevents rather than for the function it calls:
///
///  * a second concurrently authorized StoreKit sheet is a **double charge**;
///  * a cancellation that is never released is a **permanent zero-charge
///    deadlock** — the defect this whole protocol exists to remove;
///  * a capability on a second device, or in a backup, is **authority to re-arm
///    a sheet this device holds**.
///
/// The planner and the transitions are pure, so none of this needs a network, a
/// clock or StoreKit. `AppleSubscriptionModelTests` drives the same rules
/// through the real purchase path; these prove the rules themselves.
final class ApplePurchaseContinuationTests: XCTestCase {

    // Fixed, obviously-fake values. No real secret ever appears in this file.
    private let instance = "instance-A"
    private let secret = "TEST-SECRET-NOT-REAL"

    private func armed(arm: String = "arm-1", product: String = "pro.monthly")
        -> ApplePurchaseCapability {
        ApplePurchaseCapability(attemptID: "attempt-1", appInstanceID: instance, secret: secret,
                                armRequestID: arm, productID: product, phase: .armed)
    }

    private func cancelled(arm: String = "arm-1", product: String = "pro.monthly")
        -> ApplePurchaseCapability {
        var c = armed(arm: arm, product: product)
        c.phase = .cancelled
        return c
    }

    // MARK: - the initial arm

    /// The initial capability exists before the request, making both the request
    /// and its response exactly replayable.
    func testTheFirstArmIsPreparedBeforeDispatch() {
        let prepared = ApplePurchaseContinuation.prepared(
            ownerAccountID: "acct-A", appInstanceID: instance, secret: secret,
            armRequestID: "arm-1", productID: "pro.monthly")
        let plan = ApplePurchaseContinuation.plan(capability: prepared, productID: "pro.monthly",
                                                  appInstanceID: instance,
                                                  freshArmRequestID: "arm-1",
                                                  mayRecoverIfResolved: true)
        XCTAssertEqual(plan, .initialArm(prepared))
        XCTAssertEqual(prepared.phase, .preparing)
        XCTAssertEqual(prepared.attemptID, "")
        XCTAssertEqual(prepared.fields.continuationSecret, secret)
    }

    func testAConfirmedInitialArmKeepsThePrePersistedSecret() throws {
        let prepared = ApplePurchaseContinuation.prepared(
            ownerAccountID: "acct-A", appInstanceID: instance, secret: secret,
            armRequestID: "arm-1", productID: "pro.monthly")
        let confirmed = try XCTUnwrap(ApplePurchaseContinuation.confirmedInitialArm(
            prepared, attemptID: "attempt-1", serverSecret: nil))
        XCTAssertEqual(confirmed.phase, .armed)
        XCTAssertEqual(confirmed.attemptID, "attempt-1")
        XCTAssertEqual(confirmed.secret, secret)
        XCTAssertEqual(confirmed.ownerAccountID, "acct-A")
    }

    /// **A server that issues no secret leaves this client one-shot.**
    ///
    /// The alternative — inventing a capability — would make every later resume
    /// present material the server never minted, and a client that believed it
    /// could recover would keep trying instead of reconciling.
    func testALegacyServerAnswerCreatesNoCapability() {
        XCTAssertNil(ApplePurchaseContinuation.armed(
            attemptID: "attempt-1", appInstanceID: instance, secret: nil,
            armRequestID: "arm-1", productID: "pro.monthly"))
        XCTAssertNil(ApplePurchaseContinuation.armed(
            attemptID: "attempt-1", appInstanceID: instance, secret: "",
            armRequestID: "arm-1", productID: "pro.monthly"))
    }

    // MARK: - only cancellation is resumable

    /// **The central refusal.** `pending`, `failed` and `success` all lock, and a
    /// locked attempt is never resumable — none of them proves Apple will not
    /// charge, and re-arming on one authorizes a second sheet over a live one.
    ///
    /// Driven at **both** server answers, because the phase is their
    /// conjunction: a server that says `resumable: true` about a `success` must
    /// not produce a resumable client either.
    func testEveryOutcomeExceptCancellationLocks() {
        for outcome in ApplePurchaseOutcome.allCases {
            for serverResumable in [true, false] {
                let next = ApplePurchaseContinuation.applying(outcome, to: armed(),
                                                              forArm: "arm-1",
                                                              serverResumable: serverResumable)
                XCTAssertEqual(next?.phase,
                               outcome == .userCancelled && serverResumable ? .cancelled : .locked,
                               "\(outcome.rawValue) at resumable=\(serverResumable) reached the wrong phase")
            }
            XCTAssertEqual(outcome.isResumable, outcome == .userCancelled)
        }
        // Enumerated, so a fifth case added later is not silently untested.
        XCTAssertEqual(ApplePurchaseOutcome.allCases.count, 4)
    }

    /// **Local resumability may never exceed the server's own answer.**
    ///
    /// A `200 {"resumable": false}` to a `userCancelled` report is not
    /// hypothetical: the server short-circuits an already-locked attempt to
    /// `Accepted: true, Resumable: false` whatever outcome was requested. Mapping
    /// that to `cancelled` because *this client* asked to cancel would plan a
    /// resume the server must refuse — while it still holds an attempt that may
    /// charge.
    func testACancellationTheServerCallsUnresumableLocksInstead() {
        let next = ApplePurchaseContinuation.applying(
            .userCancelled, to: armed(), forArm: "arm-1", serverResumable: false)
        XCTAssertEqual(next?.phase, .locked)
        // And the plan built from it opens nothing locally.
        XCTAssertEqual(ApplePurchaseContinuation.plan(capability: next, productID: "pro.monthly",
                                                      appInstanceID: instance,
                                                      freshArmRequestID: "arm-9",
                                                      mayRecoverIfResolved: false),
                       .blocked(.locked))
    }

    /// A locked attempt is **never locally resumable**, and the recovery plan is
    /// deliberately a different case rather than a resume that pretends it is.
    ///
    /// A resume asserts something — "the sheet I armed provably cannot charge".
    /// Nothing here asserts anything: the request presents the capability and a
    /// fresh identity, and the SERVER refuses while the attempt is unresolved.
    func testALockedAttemptIsNeverResumable() {
        var locked = armed()
        locked.phase = .locked
        let plan = ApplePurchaseContinuation.plan(capability: locked, productID: "pro.monthly",
                                                  appInstanceID: instance,
                                                  freshArmRequestID: "arm-9",
                                                  mayRecoverIfResolved: true)
        XCTAssertEqual(plan, .recoverIfResolved(locked, armRequestID: "arm-9",
                                                productID: "pro.monthly"))
        XCTAssertNotEqual(plan, .resume(locked, armRequestID: "arm-9",
                                        productID: "pro.monthly"),
                          "a locked attempt was planned as if it were locally resumable")
        // Without the one recovery pass, it is the offline refusal it always was,
        // and it refuses as `locked` rather than as the outstanding-sheet answer
        // — the two have different repairs.
        XCTAssertEqual(ApplePurchaseContinuation.plan(capability: locked, productID: "pro.monthly",
                                                      appInstanceID: instance,
                                                      freshArmRequestID: "arm-9",
                                                      mayRecoverIfResolved: false),
                       .blocked(.locked))
    }

    /// **Silence is not a cancellation.** A process that died with the sheet open
    /// leaves `armed`, and nothing in this type can turn "no report arrived" into
    /// permission to open another sheet.
    ///
    /// What it may do is ask. The recovery plan carries a fresh identity to the
    /// same compare-and-arm every purchase uses, and the server refuses it while
    /// that sheet's attempt is still unresolved.
    func testAnUnreportedSheetBlocksRatherThanReArming() {
        let plan = ApplePurchaseContinuation.plan(capability: armed(), productID: "pro.monthly",
                                                  appInstanceID: instance,
                                                  freshArmRequestID: "arm-9",
                                                  mayRecoverIfResolved: true)
        XCTAssertEqual(plan, .recoverIfResolved(armed(), armRequestID: "arm-9",
                                                productID: "pro.monthly"))
        XCTAssertNotEqual(plan, .resume(armed(), armRequestID: "arm-9",
                                        productID: "pro.monthly"),
                          "an outstanding sheet was planned as a local resume")
        XCTAssertEqual(ApplePurchaseContinuation.plan(capability: armed(), productID: "pro.monthly",
                                                      appInstanceID: instance,
                                                      freshArmRequestID: "arm-9",
                                                      mayRecoverIfResolved: false),
                       .blocked(.sheetOutstanding))
    }

    /// The recovery names the product the user actually chose, exactly as a
    /// resume does: convergence is exact on product, and the server repoints the
    /// replacement attempt at what is being authorized.
    func testARecoveryCarriesTheChosenProductAndAFreshIdentity() {
        var locked = armed(arm: "arm-spent", product: "pro.monthly")
        locked.phase = .locked
        XCTAssertEqual(ApplePurchaseContinuation.plan(capability: locked,
                                                      productID: "plus.monthly",
                                                      appInstanceID: instance,
                                                      freshArmRequestID: "arm-fresh",
                                                      mayRecoverIfResolved: true),
                       .recoverIfResolved(locked, armRequestID: "arm-fresh",
                                          productID: "plus.monthly"))
    }

    /// **Anything already owed outranks the recovery**, on both phases it can be
    /// planned from.
    ///
    /// An owed outcome is a statement about a sheet that really opened, and an
    /// already-recorded arm intent is a request the server may already have
    /// answered. Probing before either is discharged would ask about state this
    /// client has not finished describing.
    func testAnythingAlreadyOwedOutranksTheRecovery() {
        for phase in [ApplePurchaseCapability.Phase.armed, .locked] {
            var owed = armed()
            owed.phase = phase
            owed.unconfirmedOutcome = ApplePurchaseOutcomeIntent(armRequestID: "arm-1",
                                                                 outcome: .pending)
            XCTAssertEqual(ApplePurchaseContinuation.plan(capability: owed,
                                                          productID: "pro.monthly",
                                                          appInstanceID: instance,
                                                          freshArmRequestID: "arm-9",
                                                          mayRecoverIfResolved: true),
                           .replayOutcome(owed, armRequestID: "arm-1", outcome: .pending),
                           "\(phase.rawValue) probed the server with a report still owed")

            var recorded = armed()
            recorded.phase = phase
            recorded.unconfirmedResume = ApplePurchaseResumeIntent(armRequestID: "arm-2",
                                                                   productID: "plus.monthly")
            XCTAssertEqual(ApplePurchaseContinuation.plan(capability: recorded,
                                                          productID: "max.yearly",
                                                          appInstanceID: instance,
                                                          freshArmRequestID: "arm-9",
                                                          mayRecoverIfResolved: true),
                           .replayResume(recorded, armRequestID: "arm-2",
                                         productID: "plus.monthly"),
                           "\(phase.rawValue) minted a second identity over a recorded one")
        }
    }

    // MARK: - resume

    /// A cancelled attempt resumes with a **fresh** identity — never the spent
    /// one, which the server refuses for ever.
    func testAResumeMintsAFreshArmIdentity() {
        let plan = ApplePurchaseContinuation.plan(capability: cancelled(), productID: "pro.monthly",
                                                  appInstanceID: instance,
                                                  freshArmRequestID: "arm-2",
                                                  mayRecoverIfResolved: true)
        XCTAssertEqual(plan, .resume(cancelled(), armRequestID: "arm-2", productID: "pro.monthly"))
    }

    /// **Cross-product resume is valid, and the product must move with the arm.**
    ///
    /// A cancelled sheet is not a promise to buy the same thing next. Convergence
    /// is exact on product, so leaving the attempt naming the abandoned product
    /// makes a real charge for the new one land and then never resolve — a wedged
    /// account after real money moved, which is strictly worse than the deadlock
    /// this design removes.
    func testACrossProductResumeMovesTheProductWithTheArm() {
        let plan = ApplePurchaseContinuation.plan(capability: cancelled(product: "pro.monthly"),
                                                  productID: "plus.monthly",
                                                  appInstanceID: instance,
                                                  freshArmRequestID: "arm-2",
                                                  mayRecoverIfResolved: true)
        guard case let .resume(_, armRequestID, productID) = plan else {
            return XCTFail("expected a resume, got \(plan)")
        }
        XCTAssertEqual(armRequestID, "arm-2")
        XCTAssertEqual(productID, "plus.monthly")

        guard let confirmed = ApplePurchaseContinuation.confirmedArm(
            cancelled(product: "pro.monthly"), attemptID: "attempt-2",
            armRequestID: "arm-2", productID: "plus.monthly") else {
            return XCTFail("a valid authoritative attempt id was refused")
        }
        XCTAssertEqual(confirmed.productID, "plus.monthly")
        XCTAssertEqual(confirmed.armRequestID, "arm-2")
        XCTAssertEqual(confirmed.phase, .armed)
        // The server's attempt id is authoritative. It normally remains the
        // same, but another installation may already have resolved the stale
        // local attempt and caused this dispatch to create a replacement.
        XCTAssertEqual(confirmed.attemptID, "attempt-2")
        XCTAssertEqual(confirmed.secret, secret)
    }

    // MARK: - the lost resume response

    /// **A resume is recorded before it is sent**, and the recorded intent is
    /// what the next attempt replays.
    ///
    /// Without it a lost response is a permanent deadlock: the server would be
    /// armed under an identity this client never learned, so it could neither
    /// report that arm's outcome nor mint one the server would accept.
    func testALostResumeResponseReplaysTheSameArmAndProduct() {
        let intent = ApplePurchaseContinuation.recordingResumeIntent(
            cancelled(), armRequestID: "arm-2", productID: "plus.monthly")
        // The phase deliberately does NOT move: nothing is armed until the
        // server says so, and claiming `armed` here would block the very replay
        // this record exists to enable.
        XCTAssertEqual(intent.phase, .cancelled)

        // A different fresh identity is offered and deliberately ignored.
        let plan = ApplePurchaseContinuation.plan(capability: intent, productID: "plus.monthly",
                                                  appInstanceID: instance,
                                                  freshArmRequestID: "arm-99",
                                                  mayRecoverIfResolved: true)
        XCTAssertEqual(plan, .replayResume(intent, armRequestID: "arm-2",
                                           productID: "plus.monthly"))
    }

    /// The replay wins even when the user has since chosen a **different**
    /// product. Minting a second identity here is exactly the second-sheet
    /// authorization the arm binding exists to prevent.
    func testAnUnconfirmedResumeIsReplayedBeforeAnyNewProduct() {
        let intent = ApplePurchaseContinuation.recordingResumeIntent(
            cancelled(), armRequestID: "arm-2", productID: "plus.monthly")
        let plan = ApplePurchaseContinuation.plan(capability: intent, productID: "max.yearly",
                                                  appInstanceID: instance,
                                                  freshArmRequestID: "arm-99",
                                                  mayRecoverIfResolved: true)
        XCTAssertEqual(plan, .replayResume(intent, armRequestID: "arm-2",
                                           productID: "plus.monthly"))
    }

    /// Confirming discharges the intent, so the next plan is an ordinary one.
    func testConfirmingAResumeDischargesTheIntent() {
        let intent = ApplePurchaseContinuation.recordingResumeIntent(
            cancelled(), armRequestID: "arm-2", productID: "plus.monthly")
        guard let confirmed = ApplePurchaseContinuation.confirmedArm(
            intent, attemptID: "attempt-1",
            armRequestID: "arm-2", productID: "plus.monthly") else {
            return XCTFail("a valid authoritative attempt id was refused")
        }
        XCTAssertNil(confirmed.unconfirmedResume)
        // The discharge is the point: the intent is gone, so the next plan is an
        // ordinary one about the arm that is now open — never a second replay.
        XCTAssertEqual(ApplePurchaseContinuation.plan(capability: confirmed,
                                                      productID: "plus.monthly",
                                                      appInstanceID: instance,
                                                      freshArmRequestID: "arm-3",
                                                      mayRecoverIfResolved: false),
                       .blocked(.sheetOutstanding))
        XCTAssertEqual(ApplePurchaseContinuation.plan(capability: confirmed,
                                                      productID: "plus.monthly",
                                                      appInstanceID: instance,
                                                      freshArmRequestID: "arm-3",
                                                      mayRecoverIfResolved: true),
                       .recoverIfResolved(confirmed, armRequestID: "arm-3",
                                          productID: "plus.monthly"))
    }

    // MARK: - stale arms

    /// **A report from an earlier sheet cannot move a newer one.**
    ///
    /// This is the schedule the arm binding closes: arm A, cancel A, resume to
    /// R1 (which MAY CHARGE), then a duplicate cancel for A arriving late. If
    /// that duplicate were applied, R1 would go back to cancelled and a second
    /// sheet could be armed alongside a live one.
    func testAStaleCancellationCannotReleaseANewerArm() {
        let live = armed(arm: "arm-R1", product: "plus.monthly")
        XCTAssertNil(ApplePurchaseContinuation.applying(.userCancelled, to: live, forArm: "arm-A",
                                                        serverResumable: true),
                     "a cancellation for an older arm moved the live one")
        // The newer arm's own report still applies.
        XCTAssertEqual(
            ApplePurchaseContinuation.applying(.userCancelled, to: live, forArm: "arm-R1",
                                               serverResumable: true)?.phase,
            .cancelled)
    }

    /// A late **success** from an earlier arm may not retire or lock a newer one
    /// either. The guard is about the arm, not about the outcome.
    func testAStaleSuccessCannotLockANewerArm() {
        let live = armed(arm: "arm-R2")
        for outcome in ApplePurchaseOutcome.allCases {
            XCTAssertNil(ApplePurchaseContinuation.applying(outcome, to: live, forArm: "arm-R1",
                                                            serverResumable: true),
                         "\(outcome.rawValue) from an old arm moved the live one")
        }
    }

    /// An outcome for an arm whose resume was never confirmed is dropped too:
    /// this client does not know that arm is the open sheet.
    func testAnOutcomeAgainstAnUnconfirmedResumeIsDropped() {
        let intent = ApplePurchaseContinuation.recordingResumeIntent(
            cancelled(), armRequestID: "arm-2", productID: "plus.monthly")
        XCTAssertNil(ApplePurchaseContinuation.applying(.userCancelled, to: intent,
                                                        forArm: intent.armRequestID,
                                                        serverResumable: true))
    }

    // MARK: - a report that was recorded and never confirmed delivered

    private func recorded(_ outcome: ApplePurchaseOutcome = .userCancelled,
                          arm: String = "arm-1") -> ApplePurchaseCapability {
        guard let value = ApplePurchaseContinuation.recordingOutcomeIntent(
                  armed(arm: arm), outcome: outcome, forArm: arm) else {
            XCTFail("the arm that is open refused its own report")
            return armed(arm: arm)
        }
        return value
    }

    /// **The lockout this record exists to remove, stated as the two plans it
    /// sits between.**
    ///
    /// A cancellation produces no signed transaction, so an undelivered report
    /// has nothing for `Transaction.updates` or `restore` to reconcile with. With
    /// no record the phase stays `armed` and every later purchase is refused for
    /// ever; with one, the next attempt replays the report instead.
    func testAnUnrecordedCancellationBlocksButARecordedOneReplays() {
        // Unrecorded, this client knows nothing: it may ask the server, and it
        // may not plan a local resume. Only the RECORDED half below replays.
        XCTAssertEqual(ApplePurchaseContinuation.plan(capability: armed(), productID: "pro.monthly",
                                                      appInstanceID: instance,
                                                      freshArmRequestID: "arm-9",
                                                      mayRecoverIfResolved: false),
                       .blocked(.sheetOutstanding),
                       "an unrecorded cancellation is the permanent lockout")
        XCTAssertEqual(ApplePurchaseContinuation.plan(capability: armed(), productID: "pro.monthly",
                                                      appInstanceID: instance,
                                                      freshArmRequestID: "arm-9",
                                                      mayRecoverIfResolved: true),
                       .recoverIfResolved(armed(), armRequestID: "arm-9",
                                          productID: "pro.monthly"),
                       "an unrecorded cancellation became a local resume")
        XCTAssertEqual(ApplePurchaseContinuation.plan(capability: recorded(), productID: "pro.monthly",
                                                      appInstanceID: instance,
                                                      freshArmRequestID: "arm-9",
                                                      mayRecoverIfResolved: true),
                       .replayOutcome(recorded(), armRequestID: "arm-1", outcome: .userCancelled),
                       "a recorded cancellation was not replayed")
    }

    /// **The replay is planned before anything may be armed, and it carries the
    /// outcome VERBATIM.**
    ///
    /// Driven over every case, which is the proof that generalizing the record to
    /// all outcomes cannot widen one: a recorded `pending` replays as `pending`.
    func testEveryRecordedOutcomeReplaysAsItselfAndOnlyCancellationRearms() {
        for outcome in ApplePurchaseOutcome.allCases {
            let value = recorded(outcome)
            XCTAssertEqual(ApplePurchaseContinuation.plan(capability: value,
                                                          productID: "plus.monthly",
                                                          appInstanceID: instance,
                                                          freshArmRequestID: "arm-9",
                                                          mayRecoverIfResolved: true),
                           .replayOutcome(value, armRequestID: "arm-1", outcome: outcome),
                           "\(outcome.rawValue) did not replay as itself")
            // The server answers each report honestly, and only one of them can
            // reach a plan that opens a sheet.
            let answered = ApplePurchaseContinuation.applying(outcome, to: value, forArm: "arm-1",
                                                              serverResumable: outcome.isResumable)
            XCTAssertNil(answered?.unconfirmedOutcome, "the answer did not discharge the record")
            let next = ApplePurchaseContinuation.plan(capability: answered, productID: "plus.monthly",
                                                      appInstanceID: instance,
                                                      freshArmRequestID: "arm-9",
                                                      mayRecoverIfResolved: true)
            if outcome == .userCancelled {
                XCTAssertEqual(next, .resume(answered!, armRequestID: "arm-9",
                                             productID: "plus.monthly"))
            } else {
                // Never a local resume: a non-cancellation may only be carried
                // to the server as a question, and it is the offline refusal
                // once this call has already spent its one recovery pass.
                XCTAssertEqual(next, .recoverIfResolved(answered!, armRequestID: "arm-9",
                                                        productID: "plus.monthly"),
                               "\(outcome.rawValue) reached a plan that could arm")
                XCTAssertEqual(ApplePurchaseContinuation.plan(capability: answered,
                                                              productID: "plus.monthly",
                                                              appInstanceID: instance,
                                                              freshArmRequestID: "arm-9",
                                                              mayRecoverIfResolved: false),
                               .blocked(.locked),
                               "\(outcome.rawValue) did not fall back to the offline refusal")
            }
        }
    }

    /// **A record naming an arm the server has already superseded is inert.**
    ///
    /// `armRequestID` moves only on an authoritative 200, so such a record is
    /// about a sheet nobody is waiting on. It must not become a replay, and it
    /// must not stop the current arm from being refused on its own merits.
    func testAStaleRecordedOutcomeIsNotAPlan() {
        var stale = armed(arm: "arm-R1", product: "plus.monthly")
        stale.unconfirmedOutcome = ApplePurchaseOutcomeIntent(armRequestID: "arm-A",
                                                              outcome: .userCancelled)
        XCTAssertEqual(ApplePurchaseContinuation.plan(capability: stale, productID: "plus.monthly",
                                                      appInstanceID: instance,
                                                      freshArmRequestID: "arm-9",
                                                      mayRecoverIfResolved: false),
                       .blocked(.sheetOutstanding),
                       "a stale record released a newer arm")
        // With the recovery pass available it is still not a replay: the plan
        // presents a FRESH identity, never the superseded one the record names.
        XCTAssertEqual(ApplePurchaseContinuation.plan(capability: stale, productID: "plus.monthly",
                                                      appInstanceID: instance,
                                                      freshArmRequestID: "arm-9",
                                                      mayRecoverIfResolved: true),
                       .recoverIfResolved(stale, armRequestID: "arm-9",
                                          productID: "plus.monthly"),
                       "a stale record became a replay")
    }

    /// An authoritative arm move discharges any record for the arm it leaves
    /// behind, so a stale one cannot accumulate in a value that outlives launches.
    func testConfirmingAnArmDischargesTheRecordItLeavesBehind() {
        var value = recorded()
        value.unconfirmedResume = ApplePurchaseResumeIntent(armRequestID: "arm-2",
                                                            productID: "plus.monthly")
        guard let confirmed = ApplePurchaseContinuation.confirmedArm(
            value, attemptID: "attempt-1", armRequestID: "arm-2",
            productID: "plus.monthly") else {
            return XCTFail("a valid authoritative attempt id was refused")
        }
        XCTAssertNil(confirmed.unconfirmedOutcome)
        XCTAssertNil(confirmed.unconfirmedResume)
    }

    /// **A report that could never be applied is never recorded either**, so it
    /// is never sent: an arm that is not the open one, and an arm nobody knows is
    /// open because its resume was never confirmed.
    func testARecordIsRefusedForAnythingButTheOpenArm() {
        XCTAssertNil(ApplePurchaseContinuation.recordingOutcomeIntent(
            armed(arm: "arm-R1"), outcome: .userCancelled, forArm: "arm-A"))
        let unconfirmed = ApplePurchaseContinuation.recordingResumeIntent(
            cancelled(), armRequestID: "arm-2", productID: "plus.monthly")
        XCTAssertNil(ApplePurchaseContinuation.recordingOutcomeIntent(
            unconfirmed, outcome: .userCancelled, forArm: unconfirmed.armRequestID))
    }

    /// **An unconfirmed resume outranks a record**, and replaying it makes the
    /// record stale rather than leaving two things owed. This is the ordering
    /// that lets a value written by some other build converge.
    func testAnUnconfirmedResumeOutranksARecordedOutcome() {
        var both = recorded()
        both.unconfirmedResume = ApplePurchaseResumeIntent(armRequestID: "arm-2",
                                                           productID: "plus.monthly")
        XCTAssertEqual(ApplePurchaseContinuation.plan(capability: both, productID: "max.yearly",
                                                      appInstanceID: instance,
                                                      freshArmRequestID: "arm-9",
                                                      mayRecoverIfResolved: true),
                       .replayResume(both, armRequestID: "arm-2", productID: "plus.monthly"))
    }

    /// **The record survives a restart**, which is the crash this whole
    /// mechanism exists for: the report was recorded, the process died before the
    /// answer arrived, and the next launch still owes it.
    func testARecordedOutcomeSurvivesARestart() throws {
        let store = InMemoryApplePurchaseCapabilityStore()
        let before = recorded(.userCancelled)
        try ApplePurchaseCapabilityRepository(store: store).save(before)

        let after = try XCTUnwrap(ApplePurchaseCapabilityRepository(store: store).load())
        XCTAssertEqual(after, before)
        XCTAssertEqual(after.unconfirmedOutcome,
                       ApplePurchaseOutcomeIntent(armRequestID: "arm-1", outcome: .userCancelled))
        XCTAssertEqual(ApplePurchaseContinuation.plan(capability: after, productID: "pro.monthly",
                                                      appInstanceID: instance,
                                                      freshArmRequestID: "arm-9",
                                                      mayRecoverIfResolved: true),
                       .replayOutcome(after, armRequestID: "arm-1", outcome: .userCancelled))
    }

    /// The record is carried through the same error and log paths as the rest of
    /// the capability, so it is covered by the same redaction.
    func testARecordedOutcomeIsRenderedWithoutTheSecret() {
        let value = recorded(.pending)
        for rendered in [String(describing: value), value.debugDescription,
                         String(reflecting: value)] {
            XCTAssertFalse(rendered.contains(secret), "a description leaked the secret")
            XCTAssertTrue(rendered.contains("pending"), "the recorded outcome was not rendered")
            XCTAssertTrue(rendered.contains("<redacted>"))
        }
    }

    /// **An upgrade must not silently drop a live capability.**
    ///
    /// The stored value gains a field, and the build that reads it is not always
    /// the build that wrote it. A decode failure here would read as "no
    /// capability at all", which plans a FIRST arm — against a server that may
    /// still hold an armed dispatch. The field is optional precisely so this
    /// stays a `nil`, not a failure.
    func testACapabilityWrittenBeforeTheRecordExistedStillDecodes() throws {
        let store = InMemoryApplePurchaseCapabilityStore()
        // Exactly the shape the preceding build wrote: no `unconfirmedOutcome`.
        try store.saveCapability("""
        {"attemptID":"attempt-1","appInstanceID":"\(instance)","secret":"\(secret)",\
        "armRequestID":"arm-1","productID":"pro.monthly","phase":"cancelled"}
        """)
        let loaded = try XCTUnwrap(ApplePurchaseCapabilityRepository(store: store).load())
        XCTAssertNil(loaded.unconfirmedOutcome)
        XCTAssertEqual(loaded.phase, .cancelled)
        XCTAssertEqual(ApplePurchaseContinuation.plan(capability: loaded, productID: "pro.monthly",
                                                      appInstanceID: instance,
                                                      freshArmRequestID: "arm-9",
                                                      mayRecoverIfResolved: true),
                       .resume(loaded, armRequestID: "arm-9", productID: "pro.monthly"),
                       "an upgraded client lost a live capability")
    }

    // MARK: - restart persistence

    /// **The whole capability survives a restart, byte for byte**, including the
    /// unconfirmed resume — which is what makes the replay rule work across the
    /// crash it exists for.
    func testACapabilitySurvivesARestartWithItsArmBinding() throws {
        let store = InMemoryApplePurchaseCapabilityStore()
        let before = ApplePurchaseContinuation.recordingResumeIntent(
            cancelled(arm: "arm-1"), armRequestID: "arm-2", productID: "plus.monthly")
        try ApplePurchaseCapabilityRepository(store: store).save(before)

        // A brand-new repository over the same store is what a relaunch is.
        let after = try XCTUnwrap(ApplePurchaseCapabilityRepository(store: store).load())
        XCTAssertEqual(after, before)
        XCTAssertEqual(after.unconfirmedResume?.armRequestID, "arm-2")
        // And the stale-arm guard still holds against the restored value.
        XCTAssertNil(ApplePurchaseContinuation.applying(.userCancelled, to: after,
                                                        forArm: "arm-1", serverResumable: true))
    }

    /// A stored value this build cannot read fails **closed** — treated as no
    /// capability, which refuses a resume, rather than as a reason to crash a
    /// purchase surface.
    func testAnUnreadableStoredCapabilityFailsClosed() throws {
        let store = InMemoryApplePurchaseCapabilityStore()
        try store.saveCapability("{not json")
        XCTAssertNil(ApplePurchaseCapabilityRepository(store: store).load())
    }

    // MARK: - retirement

    /// Retirement is explicit and total. **Nothing here is time-based**: there is
    /// no TTL, no clock and no launch counter in this type, so a device with a
    /// wrong clock cannot release a capability early.
    func testRetirementClearsTheStoredCapability() throws {
        let store = InMemoryApplePurchaseCapabilityStore()
        let repository = ApplePurchaseCapabilityRepository(store: store)
        try repository.save(armed())
        XCTAssertNotNil(repository.load())
        try repository.retire()
        XCTAssertNil(repository.load())
        XCTAssertNil(try store.loadCapability())
    }

    // MARK: - storage rules

    /// **The persisted form carries the secret and therefore must be Keychain
    /// only.** Asserted as a property of the encoded value: it is one opaque
    /// blob, so there is no non-secret half anybody could be tempted to put in
    /// `UserDefaults` beside it.
    func testTheEncodedCapabilityIsOneSecretBearingBlob() throws {
        let store = InMemoryApplePurchaseCapabilityStore()
        try ApplePurchaseCapabilityRepository(store: store).save(armed())
        let encoded = try XCTUnwrap(try store.loadCapability())
        XCTAssertTrue(encoded.contains(secret),
                      "the stored blob is the secret-bearing one, so it is Keychain-only")
    }

    func testAccountScopedRepositoryKeepsIndependentCapabilities() throws {
        let a = InMemoryApplePurchaseCapabilityStore()
        let b = InMemoryApplePurchaseCapabilityStore()
        let repository = ApplePurchaseCapabilityRepository(
            storeForOwner: { $0 == "acct-A" ? a : b })
        let capabilityA = ApplePurchaseCapability(
            attemptID: "attempt-A", ownerAccountID: "acct-A",
            appInstanceID: instance, secret: secret, armRequestID: "arm-A",
            productID: "pro.monthly", phase: .armed)
        let capabilityB = ApplePurchaseCapability(
            attemptID: "attempt-B", ownerAccountID: "acct-B",
            appInstanceID: instance, secret: secret, armRequestID: "arm-B",
            productID: "pro.monthly", phase: .armed)

        try repository.save(capabilityA)
        try repository.save(capabilityB)

        XCTAssertEqual(repository.load(ownerAccountID: "acct-A")?.attemptID,
                       capabilityA.attemptID)
        XCTAssertEqual(repository.load(ownerAccountID: "acct-B")?.attemptID,
                       "attempt-B")
        try repository.retire(ownerAccountID: "acct-A")
        XCTAssertNil(repository.load(ownerAccountID: "acct-A"))
        XCTAssertNotNil(repository.load(ownerAccountID: "acct-B"))
    }

    func testFileOutcomeJournalSurvivesReconstructionAndClearsExactlyOneOwner() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("outcomes.json")
        let first = FileApplePurchaseOutcomeJournal(url: url)
        let a = ApplePurchaseOutcomeJournalEntry(
            ownerAccountID: "acct-A", attemptID: "attempt-A",
            armRequestID: "arm-A", outcome: .userCancelled)
        let b = ApplePurchaseOutcomeJournalEntry(
            ownerAccountID: "acct-B", attemptID: "attempt-B",
            armRequestID: "arm-B", outcome: .pending)
        try first.save(a)
        try first.save(b)

        let afterRestart = FileApplePurchaseOutcomeJournal(url: url)
        XCTAssertEqual(afterRestart.load(ownerAccountID: "acct-A"), a)
        XCTAssertEqual(afterRestart.load(ownerAccountID: "acct-B"), b)
        try afterRestart.clear(ownerAccountID: "acct-A")
        XCTAssertNil(first.load(ownerAccountID: "acct-A"))
        XCTAssertEqual(first.load(ownerAccountID: "acct-B"), b)
    }

    /// **The secret never reaches a description**, which is what carries a value
    /// into logs, error messages and test failure output. Swift's synthesized
    /// description of a struct prints every stored property, so this is written
    /// out rather than inherited.
    func testNoDescriptionEverPrintsTheSecret() {
        let capability = ApplePurchaseContinuation.recordingResumeIntent(
            armed(), armRequestID: "arm-2", productID: "plus.monthly")
        for rendered in [String(describing: capability), capability.debugDescription,
                         String(reflecting: capability)] {
            XCTAssertFalse(rendered.contains(secret), "a description leaked the secret")
            XCTAssertTrue(rendered.contains("<redacted>"))
        }
        // The wire type and the dispatch response are carried through the same
        // error paths and are redacted for the same reason.
        let fields = capability.fields
        XCTAssertFalse(String(describing: fields).contains(secret))
        XCTAssertFalse(String(reflecting: fields).contains(secret))
        let dispatch = ApplePurchaseDispatch(appAccountToken: UUID(), attemptId: "attempt-1",
                                             continuationSecret: secret)
        XCTAssertFalse(String(describing: dispatch).contains(secret))
        XCTAssertFalse(String(reflecting: dispatch).contains(secret))
        // A dispatch that genuinely carries no secret says so, rather than
        // rendering the same `<redacted>` as one that does.
        XCTAssertTrue(String(describing: ApplePurchaseDispatch(
            appAccountToken: UUID(), attemptId: "a")).contains("nil"))
    }

    /// **The Keychain item is non-synchronizing and this-device-only.**
    ///
    /// Both are the binding the capability claims: it proves *the same app
    /// instance on the same device*, and an item that synced through iCloud
    /// Keychain or survived a backup restore would hand a second Mac authority
    /// to re-arm a sheet this one holds.
    func testTheCapabilityKeychainItemNeverLeavesThisDevice() {
        let store = AppEnvironment.makeApplePurchaseCapabilityStore(
            KeychainConfiguration(service: "com.relayium.mac", account: "bearer-token",
                                  accessGroup: "TEAM.com.relayium.shared"))
        XCTAssertEqual(store.baseQuery[kSecAttrSynchronizable as String] as? Bool, false,
                       "the capability may sync to another Mac")
        XCTAssertEqual(KeychainTokenStore.accessibility,
                       kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
        XCTAssertEqual(store.baseQuery[kSecUseDataProtectionKeychain as String] as? Bool, true,
                       "without this the accessibility asked for is only advisory")
        // **No access group.** A group is a share, and the Share extension holds
        // no bearer and buys nothing; a capability two processes can read is one
        // two of them could present.
        XCTAssertNil(store.baseQuery[kSecAttrAccessGroup as String])
        // Its OWN account, so a sign-out that clears the bearer cannot take the
        // capability with it — losing the secret is the one failure this
        // protocol cannot recover from.
        XCTAssertEqual(store.baseQuery[kSecAttrAccount as String] as? String,
                       "apple-purchase-capability")
        XCTAssertNotEqual(store.baseQuery[kSecAttrAccount as String] as? String, "bearer-token")
        // And distinct from the app-instance identity and the installation
        // identity, so none of the three can be rotated on another's behalf.
        let instanceStore = AppEnvironment.makeAppleAppInstanceStore(
            KeychainConfiguration(service: "com.relayium.mac", account: "bearer-token",
                                  accessGroup: nil))
        XCTAssertEqual(instanceStore.baseQuery[kSecAttrAccount as String] as? String,
                       "apple-app-instance-id")
        XCTAssertNotEqual(AppEnvironment.appleAppInstanceAccount,
                          AppEnvironment.installationIdentityAccount)
        XCTAssertNotEqual(AppEnvironment.appleAppInstanceAccount,
                          AppEnvironment.applePurchaseCapabilityAccount)
    }

    // MARK: - identities

    /// Arm identities are fresh, unguessable, and in the exact character set the
    /// server accepts — so a malformed one can never spend an identity on a 400.
    func testFreshArmIdentitiesAreDistinctAndServerValid() throws {
        var seen = Set<String>()
        for _ in 0..<64 {
            let id = try XCTUnwrap(ApplePurchaseIdentity.freshArmRequestID())
            XCTAssertTrue(ApplePurchaseIdentity.isValid(id))
            XCTAssertTrue(seen.insert(id).inserted, "an arm identity repeated")
        }
    }

    /// The predicate mirrors the server's `validAppleContinuationID`: non-empty,
    /// at most 128 characters, every byte in `0x21…0x7e`.
    func testTheIdentityPredicateMatchesTheServers() {
        XCTAssertFalse(ApplePurchaseIdentity.isValid(""))
        XCTAssertFalse(ApplePurchaseIdentity.isValid(String(repeating: "a", count: 129)))
        XCTAssertTrue(ApplePurchaseIdentity.isValid(String(repeating: "a", count: 128)))
        XCTAssertFalse(ApplePurchaseIdentity.isValid("has space"))
        XCTAssertFalse(ApplePurchaseIdentity.isValid("tab\there"))
        XCTAssertFalse(ApplePurchaseIdentity.isValid("new\nline"))
        XCTAssertFalse(ApplePurchaseIdentity.isValid("caf\u{00e9}"), "non-ASCII is refused")
        XCTAssertTrue(ApplePurchaseIdentity.isValid("A-Za-z0-9_-~!"))
    }
}
