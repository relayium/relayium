import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// Which of the account's devices may be sent to, and what has to be said out
/// loud about the ones that can.
///
/// The property under test throughout is TRUTHFULNESS, not permissiveness. Two
/// specific lies are what these tests exist to prevent:
///
///  * collapsing "offline" into "unavailable". An enrolled device that is
///    switched off is a legitimate target — the task queues and lands when it
///    comes back — and hiding it would delete the reason the queue exists;
///  * collapsing a refusal into a generic empty list. Each block below has a
///    different remedy (clear the revocation, turn receiving on, update that
///    build), so each stays its own value all the way to the UI layer.
///
/// Parity with the Web sender (`web/src/lib/device-inbox.ts`'s
/// `sendAvailability`) is deliberate and load-bearing: two surfaces that
/// disagree about whether a device is sendable would let a user watch a file
/// upload from one and be refused from the other.
final class InboxSendTargetTests: XCTestCase {

    private let deviceID = "DEVICE0123456789"
    private let keyID = "KEY0123456789abcd"

    /// A real, canonical, non-low-order X25519 public key. Generated rather
    /// than hard-coded so the eligibility rule is exercised against material
    /// `validatePublicKey` genuinely accepts.
    private func publicKey() throws -> String {
        InboxKeyMaterial.encode(try InboxKeyMaterial.generateKeyPair().publicKey)
    }

    private func key(id: String? = nil, algorithm: String = InboxProtocol.keyAlgorithm,
                     publicKey: String? = nil, generation: Int64 = 4,
                     supersededAt: Int64 = 0, revokedAt: Int64 = 0) throws -> InboxKey {
        InboxKey(id: id ?? keyID, algorithm: algorithm,
                 publicKey: try publicKey ?? self.publicKey(), generation: generation,
                 createdAt: 100, supersededAt: supersededAt, revokedAt: revokedAt)
    }

    private func row(id: String? = nil, isCurrent: Bool = false,
                     inbox: InboxView?) -> InboxDeviceRow {
        InboxDeviceRow(id: id ?? deviceID, name: "Studio", kind: "mac",
                       isCurrent: isCurrent, inbox: inbox)
    }

    private func view(presence: InboxPresence = .online,
                      capability: String = InboxCapability.receiveV1,
                      autoAccept: InboxAutoAccept = .auto,
                      receiveDirReady: Bool = true, revoked: Bool = false,
                      canReceive: Bool = true, registeredAt: Int64 = 100,
                      key: InboxKey?) -> InboxView {
        InboxView(presence: presence, lastHeartbeatAt: 100, presenceExpiresAt: 190,
                  heartbeatIntervalSeconds: 30, protocolVersion: 1,
                  capabilities: [InboxCapability.receiveV1],
                  receiveCapability: capability, autoAccept: autoAccept,
                  receiveDirReady: receiveDirReady, revoked: revoked,
                  canReceive: canReceive, registeredAt: registeredAt, key: key)
    }

    private func healthy() throws -> InboxDeviceRow {
        row(inbox: view(key: try key()))
    }

    // MARK: - the sendable case

    func testAnEnrolledOnlineAutomaticDeviceIsSendableWithNoCaveats() throws {
        let availability = InboxTargetEligibility.availability(for: try healthy())
        XCTAssertTrue(availability.sendable)
        XCTAssertNil(availability.block)
        XCTAssertEqual(availability.caveats, [])
        XCTAssertTrue(availability.online)
        XCTAssertEqual(availability.policy, .auto)
    }

    func testASendableRowBecomesATargetCarryingTheKeyASealWouldUse() throws {
        let row = try healthy()
        let target = try XCTUnwrap(InboxTargetEligibility.target(for: row))
        XCTAssertEqual(target.deviceID, deviceID)
        XCTAssertEqual(target.keyID, keyID)
        XCTAssertEqual(target.keyGeneration, 4)
        XCTAssertEqual(target.algorithm, InboxProtocol.keyAlgorithm)
        XCTAssertEqual(target.publicKey, row.inbox?.key?.publicKey)
    }

    // MARK: - presence is advisory, never a refusal

    func testAnOfflineDeviceStaysSendableAndSaysTheTaskWillWait() throws {
        let availability = InboxTargetEligibility
            .availability(for: row(inbox: view(presence: .offline, key: try key())))
        XCTAssertTrue(availability.sendable, """
            an offline but properly enrolled device is exactly what the queue is for; \
            refusing it would delete the product's reason to exist
            """)
        XCTAssertEqual(availability.caveats, [.queuedUntilOnline])
        XCTAssertFalse(availability.online)
    }

    // MARK: - caveats that must never be suppressed

    func testAnAskPolicyDeviceIsSendableButSaysAPersonMustAccept() throws {
        let availability = InboxTargetEligibility
            .availability(for: row(inbox: view(autoAccept: .ask, key: try key())))
        XCTAssertTrue(availability.sendable)
        XCTAssertEqual(availability.caveats, [.needsApproval])
    }

    func testAutomaticWithAnUnusableReceiveFolderSaysSoRatherThanReadingAsReady() throws {
        let availability = InboxTargetEligibility
            .availability(for: row(inbox: view(autoAccept: .auto, receiveDirReady: false,
                                               key: try key())))
        XCTAssertTrue(availability.sendable)
        XCTAssertEqual(availability.caveats, [.directoryNotReady], """
            central starts such a task at attention_required, so a card that read \
            as unattended delivery would be a lie the user finds out about later
            """)
    }

    func testAnAskDeviceThatIsAlsoOfflineReportsBothCaveatsApprovalFirst() throws {
        let availability = InboxTargetEligibility
            .availability(for: row(inbox: view(presence: .offline, autoAccept: .ask,
                                               key: try key())))
        XCTAssertEqual(availability.caveats, [.needsApproval, .queuedUntilOnline])
    }

    /// `ask` is about a person, `directory_not_ready` is about `auto`'s folder.
    /// A device on `ask` must not also be accused of a broken folder.
    func testTheDirectoryCaveatIsNotRaisedForAnAskDevice() throws {
        let availability = InboxTargetEligibility
            .availability(for: row(inbox: view(autoAccept: .ask, receiveDirReady: false,
                                               key: try key())))
        XCTAssertEqual(availability.caveats, [.needsApproval])
    }

    // MARK: - blocks, each its own value

    func testADeviceWithNoInboxAtAllIsNotEnrolled() {
        let availability = InboxTargetEligibility.availability(for: row(inbox: nil))
        XCTAssertFalse(availability.sendable)
        XCTAssertEqual(availability.block, .notEnrolled)
        XCTAssertNil(availability.policy)
    }

    func testAnInboxSubtreeThatWasNeverRegisteredIsNotEnrolled() throws {
        let availability = InboxTargetEligibility
            .availability(for: row(inbox: view(registeredAt: 0, key: try key())))
        XCTAssertEqual(availability.block, .notEnrolled)
    }

    func testARevokedEnrolmentIsItsOwnBlockAndOutranksEverythingBelowIt() throws {
        let availability = InboxTargetEligibility
            .availability(for: row(inbox: view(revoked: true, canReceive: false,
                                               key: try key())))
        XCTAssertEqual(availability.block, .revoked, """
            revoked must not be reported as cannot_receive: only a human at \
            another device can clear a revocation, and the remedies differ
            """)
    }

    func testCentralsOwnCanReceiveVerdictIsHonouredBeforeAnyKeyInspection() throws {
        let availability = InboxTargetEligibility
            .availability(for: row(inbox: view(canReceive: false, key: try key())))
        XCTAssertEqual(availability.block, .cannotReceive, """
            central may refuse for a reason this build cannot see; its verdict \
            must win over a local guess drawn from the key
            """)
    }

    func testAReceiveCapabilityThisBuildCannotDriveIsRefusedByName() throws {
        let availability = InboxTargetEligibility
            .availability(for: row(inbox: view(capability: "inbox.receive.v2",
                                               key: try key())))
        XCTAssertEqual(availability.block, .unsupportedCapability)
    }

    func testADeviceWithNoCurrentKeyCannotBeSealedTo() throws {
        let availability = InboxTargetEligibility.availability(for: row(inbox: view(key: nil)))
        XCTAssertEqual(availability.block, .unsupportedKey)
    }

    func testASupersededKeyIsNotACurrentTargetKey() throws {
        let availability = InboxTargetEligibility
            .availability(for: row(inbox: view(key: try key(supersededAt: 500))))
        XCTAssertEqual(availability.block, .unsupportedKey)
    }

    func testARevokedKeyIsNotACurrentTargetKey() throws {
        let availability = InboxTargetEligibility
            .availability(for: row(inbox: view(key: try key(revokedAt: 500))))
        XCTAssertEqual(availability.block, .unsupportedKey)
    }

    func testAKeyUnderAnotherWrapAlgorithmIsRefused() throws {
        let availability = InboxTargetEligibility
            .availability(for: row(inbox: view(key: try key(algorithm: "rsa-oaep-v1"))))
        XCTAssertEqual(availability.block, .unsupportedKey)
    }

    func testANonCanonicalPublicKeySpellingIsRefusedBeforeItCouldBeSealedTo() throws {
        // Valid base64url of the right length, but padded — one key must have
        // exactly one spelling or the identity comparisons stop being sound.
        let padded = try publicKey() + "="
        let availability = InboxTargetEligibility
            .availability(for: row(inbox: view(key: try key(publicKey: padded))))
        XCTAssertEqual(availability.block, .unsupportedKey)
    }

    func testALowOrderPublicKeyIsRefusedRatherThanSealedTo() throws {
        let zeros = InboxKeyMaterial.encode([UInt8](repeating: 0, count: 32))
        let availability = InboxTargetEligibility
            .availability(for: row(inbox: view(key: try key(publicKey: zeros))))
        XCTAssertEqual(availability.block, .unsupportedKey, """
            a low-order point drives the exchange to the all-zero shared secret, \
            so a content key "sealed" to it is readable by anybody
            """)
    }

    func testAKeyGenerationCentralNeverMintsIsRefused() throws {
        let availability = InboxTargetEligibility
            .availability(for: row(inbox: view(key: try key(generation: 0))))
        XCTAssertEqual(availability.block, .unsupportedKey)
    }

    func testAKeyIdThatCouldNotBecomeARequestFieldIsRefused() throws {
        let availability = InboxTargetEligibility
            .availability(for: row(inbox: view(key: try key(id: "../../etc"))))
        XCTAssertEqual(availability.block, .unsupportedKey)
    }

    func testADeviceIdThatCouldNotBecomeAPathComponentIsRefusedFirst() throws {
        let availability = InboxTargetEligibility
            .availability(for: row(id: "..", inbox: view(key: try key())))
        XCTAssertEqual(availability.block, .unusableIdentifier)
    }

    func testReceivingSwitchedOffIsRefusedHereRatherThanAfterTheUpload() throws {
        let availability = InboxTargetEligibility
            .availability(for: row(inbox: view(autoAccept: .off, key: try key())))
        XCTAssertFalse(availability.sendable)
        XCTAssertEqual(availability.block, .receiveOff, """
            central answers auto_receive_disabled and stores nothing, so offering \
            the target would waste an entire encrypted upload
            """)
    }

    // MARK: - a blocked row is never a seal target

    func testABlockedRowProducesNoTarget() throws {
        for row in [self.row(inbox: nil),
                    self.row(inbox: view(autoAccept: .off, key: try key())),
                    self.row(inbox: view(key: nil))] {
            XCTAssertNil(InboxTargetEligibility.target(for: row))
        }
    }

    // MARK: - the list

    func testTargetsKeepsOnlySendableRowsAndPreservesCentralsOrder() throws {
        let sendable = row(id: "AAAA0123456789ab", inbox: view(key: try key()))
        let off = row(id: "BBBB0123456789ab", inbox: view(autoAccept: .off, key: try key()))
        let offline = row(id: "CCCC0123456789ab",
                          inbox: view(presence: .offline, key: try key()))
        let targets = InboxTargetEligibility.targets(from: [sendable, off, offline])
        XCTAssertEqual(targets.map(\.deviceID), ["AAAA0123456789ab", "CCCC0123456789ab"])
    }

    /// This device is not a send destination for itself. It is excluded rather
    /// than blocked: nothing about it is wrong, it is simply not somewhere to
    /// send a file *from here*, and `isCurrentDevice` stays readable so a caller
    /// that wants it can still ask.
    func testTheSendingDeviceIsNotOfferedAsATargetToItself() throws {
        let mine = row(id: "AAAA0123456789ab", isCurrent: true, inbox: view(key: try key()))
        let other = row(id: "BBBB0123456789ab", inbox: view(key: try key()))
        XCTAssertEqual(InboxTargetEligibility.targets(from: [mine, other]).map(\.deviceID),
                       ["BBBB0123456789ab"])
        XCTAssertTrue(InboxTargetEligibility.availability(for: mine).isCurrentDevice)
        XCTAssertTrue(InboxTargetEligibility.availability(for: mine).sendable)
    }

    // MARK: - the durable target a plan records

    func testATargetBecomesTheDurablePlanTargetWithAFreshIdempotencyKey() throws {
        let target = try XCTUnwrap(InboxTargetEligibility.target(for: try healthy()))
        let durable = PendingUploadTarget(target)
        XCTAssertEqual(durable.deviceId, deviceID)
        XCTAssertEqual(durable.keyId, keyID)
        XCTAssertEqual(durable.keyGeneration, 4)
        XCTAssertTrue(InboxIdempotencyKey.isValid(durable.createIdempotencyKey))
        // The public key is deliberately NOT carried into durable state: the
        // seal reads the CURRENT key at send time, which is what makes a
        // rotation detectable instead of silently sealed to a stale key.
        XCTAssertNotEqual(durable.keyId, target.publicKey)
    }
}
