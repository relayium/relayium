import XCTest
@testable import RelayiumKit

/// The closed sets, and the property that makes them closed: an unknown value
/// THROWS rather than resolving to a default.
///
/// This is the whole "fail closed on unknown protocol values" requirement, and it
/// is asserted at the decoder rather than at a call site, because a call site can
/// be forgotten and a decoder cannot be bypassed.
final class InboxProtocolTests: XCTestCase {

    // MARK: - the vocabulary itself

    /// The server-visible set is exactly PRD §10 items 3-12. `encrypting` and
    /// `uploading` are sender-local: central cannot observe either, so this build
    /// must not be able to NAME one.
    func testTheStateSetIsTheServerSetAndExcludesSenderLocalPhases() {
        XCTAssertEqual(Set(InboxTaskState.allCases.map(\.rawValue)), [
            "queued", "notified", "downloading", "verifying", "saved",
            "attention_required", "expired", "revoked",
            "failed_retryable", "failed_terminal",
        ])
        XCTAssertNil(InboxTaskState(rawValue: "encrypting"))
        XCTAssertNil(InboxTaskState(rawValue: "uploading"))
    }

    func testTerminalStatesAreExactlyTheFourThatNeverTransition() {
        XCTAssertEqual(Set(InboxTaskState.allCases.filter(\.isTerminal).map(\.rawValue)),
                       ["saved", "expired", "revoked", "failed_terminal"])
    }

    /// Narrower than the transition table on purpose: a device that could report
    /// `queued` could reset its own backoff, and one that could report `expired`
    /// or `revoked` could forge central's judgement about time and authorization.
    func testDeviceReportableStatesExcludeCentralsOwnJudgements() {
        XCTAssertEqual(Set(InboxTaskState.allCases.filter(\.isDeviceReportable).map(\.rawValue)),
                       ["downloading", "verifying", "saved",
                        "attention_required", "failed_retryable", "failed_terminal"])
    }

    /// The device-submittable set is closed and contains no free-text member, so a
    /// file name cannot reach central even when this Mac is explaining exactly why
    /// saving failed.
    func testTheDeviceErrorSetIsClosedAndExcludesCentralOnlyCodes() {
        XCTAssertEqual(Set(InboxDeviceErrorCode.allCases.map(\.rawValue)), [
            "", "download_failed", "decrypt_failed", "verify_failed", "disk_full",
            "permission_denied", "directory_unavailable", "name_conflict",
            "user_declined", "unsupported", "internal",
        ])
        for central in InboxCentralErrorCode.allCases {
            XCTAssertNil(InboxDeviceErrorCode(rawValue: central.rawValue),
                         "a device must not be able to name \(central.rawValue)")
        }
    }

    /// A task READ back may legitimately carry a central-authored code, so the
    /// read type is a union — while the report path stays restricted to the device
    /// set by its own parameter type.
    func testTheReadUnionAcceptsBothAuthorsAndNothingElse() {
        XCTAssertEqual(InboxTaskErrorCode(rawValue: "disk_full"), .device(.diskFull))
        XCTAssertEqual(InboxTaskErrorCode(rawValue: "lease_expired"), .central(.leaseExpired))
        XCTAssertNil(InboxTaskErrorCode(rawValue: "something_else"))
        XCTAssertTrue(InboxTaskErrorCode(rawValue: "")!.isNone)
    }

    func testPolicyAndPresenceAreClosed() {
        XCTAssertEqual(Set(InboxAutoAccept.allCases.map(\.rawValue)), ["off", "ask", "auto"])
        XCTAssertEqual(Set(InboxPresence.allCases.map(\.rawValue)), ["online", "offline"])
        XCTAssertNil(InboxAutoAccept(rawValue: "sometimes"))
        XCTAssertNil(InboxPresence(rawValue: "unknown"))
    }

    /// Fixed values the wire depends on. Spelled out rather than derived, so a
    /// change to any of them is a deliberate edit that fails here first.
    func testProtocolConstantsMatchTheSpecification() {
        XCTAssertEqual(InboxProtocol.versions, [2])
        XCTAssertEqual(InboxProtocol.taskProtocolVersion, 2)
        XCTAssertEqual(InboxProtocol.keyAlgorithm, "x25519-sealedbox-v1")
        XCTAssertEqual(InboxProtocol.publicKeyBytes, 32)
        XCTAssertEqual(InboxProtocol.sealedBoxBytes, 80)
        XCTAssertEqual(InboxProtocol.claimTokenHeader, "X-Relayium-Inbox-Claim")
        XCTAssertEqual(InboxProtocol.capabilities,
                       ["inbox.receive.v2", "inbox.autoaccept.v1", "inbox.resume.v1",
                        "inbox.text.v1"])
    }

    /// v1 is gone, not deprioritised. The owner waived old-protocol
    /// compatibility, so this build must not announce a version or a receive
    /// capability it can no longer honour — announcing v1 would make central
    /// list this device to senders whose manifests it cannot decode.
    func testTheHistoricalProtocolIsNotAnnounced() {
        XCTAssertFalse(InboxProtocol.versions.contains(1))
        XCTAssertFalse(InboxProtocol.capabilities.contains(InboxCapability.receiveV1))
    }

    /// `inbox.text.v1` means "this receiver shows a message as a message". It is
    /// announced by the same commit that made that true and not one earlier: a
    /// sender reads the token to decide whether offering a text send to this
    /// device would be honest, so announcing it early is a lie that lands
    /// somebody's message in a downloads folder.
    ///
    /// This assertion was inverted when `InboxMessageStore` shipped. What backs
    /// the claim, and what would have to be removed before it could be inverted
    /// back: a message is committed whole to a per-account protected store
    /// (`InboxMessageStoreTests`), never to the receive folder
    /// (`InboxTextDeliveryTests`), and it is readable back as text through
    /// `InboxController.messages`.
    func testTextCapabilityIsAnnouncedBecauseAMessageIsStoredAsAMessage() {
        XCTAssertEqual(InboxCapability.textV1, "inbox.text.v1")
        XCTAssertTrue(InboxProtocol.capabilities.contains(InboxCapability.textV1))
    }

    /// One task per claim. A second task claimed before the first finishes could
    /// have its lease expire without ever starting, because deliveries are worked
    /// sequentially and their sizes are unbounded until TTL.
    func testAClaimLeasesExactlyOneTask() {
        XCTAssertEqual(InboxProtocol.claimBatch, 1)
    }

    // MARK: - fail-closed decoding

    private func decodeTask(_ json: String) throws -> InboxTask {
        try JSONDecoder().decode(InboxTask.self, from: Data(json.utf8))
    }

    private func taskJSON(state: String, terminal: Bool = false, savedAt: Int = 0,
                          material: String = "") -> String {
        """
        {"ID":"t1","TargetDeviceID":"device1","StoredFileID":"file1",
         "State":"\(state)","ErrorCode":"","CiphertextBytes":42,
         "WrapAlgorithm":"x25519-sealedbox-v1","TargetKeyID":"key1",
         "TargetKeyGeneration":1,"Attempts":0,"LeaseExpiresAt":99,"ExpiresAt":999,
         "SavedAt":\(savedAt),"Terminal":\(terminal)\(material)}
        """
    }

    func testAKnownTaskDecodes() throws {
        let task = try decodeTask(taskJSON(state: "downloading"))
        XCTAssertEqual(task.state, .downloading)
        XCTAssertEqual(task.ciphertextBytes, 42)
        XCTAssertFalse(task.isTerminal)
    }

    func testAnUnknownStateIsRefusedRatherThanDefaulted() {
        XCTAssertThrowsError(try decodeTask(#"{"ID":"t1","State":"teleporting"}"#)) { error in
            XCTAssertEqual(error as? InboxError, .unknownProtocolValue(field: .taskState))
        }
    }

    /// The specific trap: `encrypting` is a REAL product state, so a permissive
    /// decoder would find it plausible. Central never stores it, so a task row
    /// claiming it is a server this build cannot follow.
    func testASenderLocalStateIsRefusedByName() {
        XCTAssertThrowsError(try decodeTask(#"{"ID":"t1","State":"uploading"}"#)) { error in
            XCTAssertEqual(error as? InboxError, .unknownProtocolValue(field: .taskState))
        }
    }

    func testAnUnknownErrorCodeIsRefused() {
        XCTAssertThrowsError(
            try decodeTask(#"{"ID":"t1","State":"queued","ErrorCode":"gremlins"}"#)) { error in
            XCTAssertEqual(error as? InboxError, .unknownProtocolValue(field: .errorCode))
        }
    }

    func testAnUnknownPresenceOrPolicyIsRefused() {
        let view = #"{"Presence":"maybe","AutoAccept":"off"}"#
        XCTAssertThrowsError(try JSONDecoder().decode(InboxView.self, from: Data(view.utf8))) {
            XCTAssertEqual($0 as? InboxError, .unknownProtocolValue(field: .presence))
        }
        let policy = #"{"Presence":"online","AutoAccept":"whenever"}"#
        XCTAssertThrowsError(try JSONDecoder().decode(InboxView.self, from: Data(policy.utf8))) {
            XCTAssertEqual($0 as? InboxError, .unknownProtocolValue(field: .autoAccept))
        }
    }

    /// A `saved` row with `Terminal:false` is still terminal here. The STATE is
    /// what the transition table is written against, so a server flag that
    /// disagreed with it must not be able to make a finished task look live.
    func testTerminalityFollowsTheStateEvenWhenTheFlagDisagrees() throws {
        let task = try decodeTask(taskJSON(state: "saved", savedAt: 7))
        XCTAssertTrue(task.isTerminal)
    }

    /// The claim response is the only place the sealed key, the manifest and the
    /// claim token appear. They decode alongside the task rather than as a nested
    /// object, matching central's flattened view.
    func testTheDeliveryDecodesItsClaimMaterialAlongsideTheTask() throws {
        let json = taskJSON(
            state: "downloading",
            material: #", "EncManifest":"AAAA","WrappedKey":"abc","ClaimToken":"tok""#)
        let delivery = try JSONDecoder().decode(InboxDelivery.self, from: Data(json.utf8))
        XCTAssertEqual(delivery.task.id, "t1")
        XCTAssertEqual(delivery.encManifest, "AAAA")
        XCTAssertEqual(delivery.wrappedKey, "abc")
        XCTAssertEqual(delivery.claimToken, "tok")
    }

    /// A key row records superseded and revoked separately. Collapsing them would
    /// either strand tasks queued before a rotation or keep trusting a key a human
    /// withdrew.
    func testSupersededAndRevokedAreDistinctFromActive() throws {
        func key(_ json: String) throws -> InboxKey {
            try JSONDecoder().decode(InboxKey.self, from: Data(json.utf8))
        }
        let base = #""ID":"k","Algorithm":"x25519-sealedbox-v1","PublicKey":"p","Generation":1,"CreatedAt":1"#
        XCTAssertTrue(try key("{\(base),\"SupersededAt\":0,\"RevokedAt\":0}").isActive)
        XCTAssertFalse(try key("{\(base),\"SupersededAt\":9,\"RevokedAt\":0}").isActive)
        XCTAssertFalse(try key("{\(base),\"SupersededAt\":0,\"RevokedAt\":9}").isActive)
    }

    func testMissingRequiredTaskAndDeliveryFieldsAreRefused() throws {
        let task = taskJSON(state: "downloading")
        let requiredTaskFields = ["TargetDeviceID", "StoredFileID", "CiphertextBytes",
                                  "WrapAlgorithm", "TargetKeyID", "TargetKeyGeneration",
                                  "Attempts", "LeaseExpiresAt", "ExpiresAt", "SavedAt", "Terminal"]
        for field in requiredTaskFields {
            var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(task.utf8)) as? [String: Any])
            object.removeValue(forKey: field)
            let data = try JSONSerialization.data(withJSONObject: object)
            XCTAssertThrowsError(try JSONDecoder().decode(InboxTask.self, from: data), field)
        }

        var delivery = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(task.utf8)) as? [String: Any])
        delivery["EncManifest"] = "AAAA"
        delivery["WrappedKey"] = "abc"
        delivery["ClaimToken"] = "tok"
        for field in ["EncManifest", "WrappedKey", "ClaimToken"] {
            var missing = delivery
            missing.removeValue(forKey: field)
            let data = try JSONSerialization.data(withJSONObject: missing)
            XCTAssertThrowsError(try JSONDecoder().decode(InboxDelivery.self, from: data), field)
        }
    }

    func testMissingRequiredInboxAndKeyFieldsAreRefused() throws {
        let inbox: [String: Any] = [
            "Presence": "offline", "LastHeartbeatAt": 0, "PresenceExpiresAt": 0,
            "HeartbeatIntervalSeconds": 30, "ProtocolVersion": 1,
            "Capabilities": ["inbox.receive.v2"],
            "ReceiveCapability": "inbox.receive.v2", "AutoAccept": "off",
            "ReceiveDirReady": false, "Revoked": false, "CanReceive": true,
            "RegisteredAt": 1, "Key": NSNull(),
        ]
        for field in inbox.keys where field != "Key" {
            var missing = inbox
            missing.removeValue(forKey: field)
            let data = try JSONSerialization.data(withJSONObject: missing)
            XCTAssertThrowsError(try JSONDecoder().decode(InboxView.self, from: data), field)
        }

        let key: [String: Any] = [
            "ID": "key1", "Algorithm": "x25519-sealedbox-v1", "PublicKey": "pub",
            "Generation": 1, "CreatedAt": 1, "SupersededAt": 0, "RevokedAt": 0,
        ]
        for field in key.keys {
            var missing = key
            missing.removeValue(forKey: field)
            let data = try JSONSerialization.data(withJSONObject: missing)
            XCTAssertThrowsError(try JSONDecoder().decode(InboxKey.self, from: data), field)
        }
    }
}
