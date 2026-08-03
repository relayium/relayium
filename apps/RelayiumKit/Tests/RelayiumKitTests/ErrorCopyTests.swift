import XCTest
import RelayiumKit
@testable import RelayiumAppKit

private struct UnknownFailure: Error {}

final class ErrorCopyTests: XCTestCase {
    func testAccountErrorsAllMapToNonEmptyText() {
        let cases: [AccountError] = [
            .invalidCredentials, .rateLimited, .server(status: 503), .decoding, .network,
        ]
        for e in cases {
            XCTAssertFalse(ErrorCopy.message(for: e, language: .en).isEmpty, "no copy for \(e)")
        }
    }
    func testServerErrorNamesTheStatus() {
        XCTAssertTrue(ErrorCopy.message(for: AccountError.server(status: 503), language: .en).contains("503"))
    }
    func testInvalidCredentialsTalksAboutEmailAndPassword() {
        let m = ErrorCopy.message(for: AccountError.invalidCredentials, language: .en).lowercased()
        XCTAssertTrue(m.contains("email") && m.contains("password"))
    }
    func testKeychainErrorNamesTheStatusCode() {
        XCTAssertTrue(ErrorCopy.message(for: KeychainError.status(-25300), language: .en).contains("-25300"))
    }
    /// The shared table's `KeychainError` copy is about the SIGN-IN it could not
    /// keep, and stays that way: `AccountSession` is its only caller, and for
    /// that caller every word of it is true.
    func testTheSharedKeychainCopyStaysAboutTheSignIn() {
        let m = ErrorCopy.message(for: KeychainError.status(-25300), language: .en).lowercased()
        XCTAssertTrue(m.contains("sign-in"), m)
        XCTAssertTrue(m.contains("quit"), m)
    }
    /// The same error type also reaches three stored-link-key paths, where that
    /// copy is false in every part: no sign-in was involved, nothing about the
    /// session changed, and quitting has nothing to do with it. Those paths get
    /// copy about the file's key — and keep the status, which is the only thing
    /// that makes a keychain refusal diagnosable.
    func testStoredLinkKeyCopyNeverBorrowsTheSignInWording() {
        for op in [StoredLinkKeyOperation.save, .read, .remove] {
            let m = ErrorCopy.storedLinkKeyMessage(for: KeychainError.status(-25308), operation: op, language: .en)
            assertSaysNothingAboutSigningIn(m, "the \(op) copy")
            XCTAssertTrue(m.contains("-25308"), "the keychain status was dropped for \(op): \(m)")
            XCTAssertTrue(m.lowercased().contains("keychain"), m)
            XCTAssertTrue(m.lowercased().contains("key"), m)
        }
    }
    /// Three separate statements, not one reworded once: "not written", "not
    /// readable" and "not removed" have different consequences for the user.
    func testEachStoredLinkKeyOperationSaysWhichOneFailed() {
        let save = ErrorCopy.storedLinkKeyMessage(for: KeychainError.status(-25308), operation: .save, language: .en)
        let read = ErrorCopy.storedLinkKeyMessage(for: KeychainError.status(-25308), operation: .read, language: .en)
        let remove = ErrorCopy.storedLinkKeyMessage(for: KeychainError.status(-25308), operation: .remove, language: .en)
        XCTAssertTrue(save.lowercased().contains("save"), save)
        XCTAssertTrue(read.lowercased().contains("read"), read)
        XCTAssertTrue(remove.lowercased().contains("remove"), remove)
        XCTAssertEqual(Set([save, read, remove]).count, 3, "two key operations share one message")
    }
    /// Only the two types these paths actually raise are contextualised.
    /// Anything else still falls through to the shared table, so this seam stays
    /// one branch per borrowed meaning rather than a second copy table to keep
    /// in step.
    func testStoredLinkKeyCopyDefersToTheSharedTableForEverythingElse() {
        for op in [StoredLinkKeyOperation.save, .read, .remove] {
            XCTAssertEqual(ErrorCopy.storedLinkKeyMessage(for: UnknownFailure(), operation: op, language: .en),
                           ErrorCopy.message(for: UnknownFailure(), language: .en))
        }
    }

    /// `StoredLinkKeyError` needs the operation too. Its shared wording answers
    /// for `AccountClient`, which raises `invalidIdentifier` from its own id
    /// check BEFORE a DELETE is sent — "it was refused" is the whole truth
    /// there — and `invalidKey` describes bytes read back from the keychain.
    /// Both are false on a save: nothing was stored, and the save runs after the
    /// upload has already landed.
    func testStoredLinkKeyErrorsSayWhichKeyOperationFailed() {
        for e in [StoredLinkKeyError.invalidKey, .invalidIdentifier] {
            let save = ErrorCopy.storedLinkKeyMessage(for: e, operation: .save, language: .en)
            let read = ErrorCopy.storedLinkKeyMessage(for: e, operation: .read, language: .en)
            let remove = ErrorCopy.storedLinkKeyMessage(for: e, operation: .remove, language: .en)
            XCTAssertTrue(save.lowercased().contains("save"), "\(e) save: \(save)")
            XCTAssertTrue(read.lowercased().contains("read"), "\(e) read: \(read)")
            XCTAssertTrue(remove.lowercased().contains("remove"), "\(e) remove: \(remove)")
            XCTAssertEqual(Set([save, read, remove]).count, 3, "two \(e) operations share one message")
            for (m, op) in [(save, "save"), (read, "read"), (remove, "remove")] {
                assertSaysNothingAboutSigningIn(m, "the \(e) \(op) copy")
                assertDoesNotDenyACompletedRequest(m, "the \(e) \(op) copy")
            }
        }
    }

    /// The sharpest of the six. A failed SAVE must not describe a key sitting on
    /// this Mac: `invalidKey` on the way IN means no keychain item was written
    /// at all, so the shared sentence would send the user looking for something
    /// that does not exist — and the link on screen is the only copy there is.
    func testAKeySaveRefusalDoesNotDescribeAKeyThatWasNeverStored() {
        let m = ErrorCopy.storedLinkKeyMessage(for: StoredLinkKeyError.invalidKey, operation: .save, language: .en)
        XCTAssertFalse(m.lowercased().contains("stored on this mac"), m)
        XCTAssertNotEqual(m, ErrorCopy.message(for: StoredLinkKeyError.invalidKey, language: .en))
    }

    /// The read arm keeps the shared sentence, because that is the path it was
    /// written for: `checkedKey(fromStored:)` rejecting bytes the keychain
    /// returned. Asserted rather than assumed so the two copies of one sentence
    /// cannot drift apart unnoticed.
    func testTheReadArmKeepsTheWordingTheSharedTableWasWrittenFor() {
        XCTAssertEqual(ErrorCopy.storedLinkKeyMessage(for: StoredLinkKeyError.invalidKey, operation: .read, language: .en),
                       ErrorCopy.message(for: StoredLinkKeyError.invalidKey, language: .en))
    }

    /// And the shared table itself is untouched: `AccountClient`'s row-action
    /// check is not a key operation, and its copy — refused, manage it on the
    /// web, report it — is still what that path renders.
    func testTheSharedTableKeepsItsRowActionWordingForARefusedIdentifier() {
        let m = ErrorCopy.message(for: StoredLinkKeyError.invalidIdentifier, language: .en)
        XCTAssertTrue(m.lowercased().contains("refused"), m)
        XCTAssertTrue(m.contains("relayium.com"), m)
        for op in [StoredLinkKeyOperation.save, .read, .remove] {
            XCTAssertNotEqual(ErrorCopy.storedLinkKeyMessage(for: StoredLinkKeyError.invalidIdentifier,
                                                             operation: op, language: .en), m,
                              "the \(op) copy is still the row action's")
        }
    }
    /// Quota and rate-limit are the only two an upload user can act on, so they
    /// must not collapse into a generic message.
    func testCloudQuotaAndRateLimitAreDistinctAndActionable() {
        let quota = ErrorCopy.message(for: CloudError.quota, language: .en)
        let rate = ErrorCopy.message(for: CloudError.rateLimited, language: .en)
        XCTAssertNotEqual(quota, rate)
        XCTAssertTrue(quota.lowercased().contains("space") || quota.lowercased().contains("quota"))
        XCTAssertTrue(rate.lowercased().contains("wait") || rate.lowercased().contains("too many"))
    }

    /// The three 429s must read differently, and only one of them may suggest
    /// waiting — the other two reset tomorrow and next month.
    func testTheThree429sReadDifferently() {
        let wait = ErrorCopy.message(for: CloudError.rateLimited, language: .en)
        let daily = ErrorCopy.message(for: CloudError.dailyQuota, language: .en)
        let monthly = ErrorCopy.message(for: CloudError.monthlyTraffic, language: .en)
        XCTAssertEqual(Set([wait, daily, monthly]).count, 3)
        XCTAssertTrue(daily.lowercased().contains("tomorrow"))
        XCTAssertTrue(monthly.lowercased().contains("month"))
        // The gate is `used + this file > quota`, so one big file trips it with
        // nothing else sent today. Copy that blames past usage would misdirect.
        XCTAssertTrue(daily.lowercased().contains("single large file"))
    }

    /// Deny and expire are different events and must not share a message: one
    /// says a person refused, the other says nobody answered in time.
    func testDeviceAuthOutcomesReadDifferently() {
        let denied = ErrorCopy.message(for: DeviceAuthOutcomeError.denied, language: .en)
        let expired = ErrorCopy.message(for: DeviceAuthOutcomeError.expired, language: .en)
        XCTAssertNotEqual(denied, expired)
        XCTAssertFalse(denied.contains("DeviceAuthOutcomeError"), "fell through to the type-name fallback")
        XCTAssertFalse(expired.contains("DeviceAuthOutcomeError"), "fell through to the type-name fallback")
        // A timeout is nobody's mistake; it must not read as a rejection.
        XCTAssertFalse(expired.lowercased().contains("declined"))
    }

    /// The one error in this app that means someone may be attacking the user.
    /// It must not read as a network hiccup with a retry button.
    func testMitmSaysStopRatherThanRetry() {
        let m = ErrorCopy.message(for: HandshakeError.mitm, language: .en).lowercased()
        XCTAssertFalse(m.contains("try again"))
        XCTAssertFalse(m.contains("reconnect"))
        XCTAssertTrue(m.contains("again") ? m.contains("pair") : true,
                      "if it suggests anything, it must be pairing again — not reconnecting")
    }

    /// All four realtime families must have copy; a type name in this UI is a
    /// dead end for a user mid-transfer.
    func testEveryRealtimeErrorHasCopy() {
        let handshake: [HandshakeError] = [.mitm, .noCommitRecorded, .badBase64, .invalidKey]
        let realtime: [RealtimeError] = [.outOfOrder, .tamper, .legacyPeer, .unknownKind(9), .malformed]
        let sender: [RealtimeSenderError] = [.manifestTooLarge, .sourceShorterThanDeclared(name: "f")]
        for e in handshake {
            let m = ErrorCopy.message(for: e, language: .en)
            XCTAssertFalse(m.contains("HandshakeError"), "no copy for \(e)")
        }
        for e in realtime {
            let m = ErrorCopy.message(for: e, language: .en)
            XCTAssertFalse(m.contains("RealtimeError"), "no copy for \(e)")
        }
        for e in sender {
            let m = ErrorCopy.message(for: e, language: .en)
            XCTAssertFalse(m.contains("RealtimeSenderError"), "no copy for \(e)")
        }

        let connection: [RealtimeConnection.ConnectionError] = [
            .peerBusy, .unsupportedPeer, .peerConnectionFailed, .notReady,
            .alreadySending, .rejected, .timedOut, .textSendBufferFull,
            .textSendFailed, .textReceiveBufferFull,
        ]
        for e in connection {
            let m = ErrorCopy.message(for: e, language: .en)
            XCTAssertFalse(m.contains("ConnectionError"), "no copy for \(e)")
        }

        let factory: [RealtimeConnectionFactory.FactoryError] = [
            .noPeerAppeared, .unsupportedPeer,
        ]
        for e in factory {
            let m = ErrorCopy.message(for: e, language: .en)
            XCTAssertFalse(m.contains("FactoryError"), "no copy for \(e)")
        }

        let text: [RealtimeTextError] = [
            .invalidKey, .messageTooLarge(bytes: 1, limit: 0),
            .sequenceExhausted, .malformedFrame, .wrongKind,
            .outOfOrder(expected: 0, actual: 1), .authenticationFailed,
            .invalidUTF8(bytes: 1),
        ]
        for e in text {
            let m = ErrorCopy.message(for: e, language: .en)
            XCTAssertFalse(m.contains("RealtimeTextError"), "no copy for \(e)")
        }
    }

    /// A missing link has three plausible causes and the copy must not assert one.
    func testNotFoundNamesAllThreeCauses() {
        let m = ErrorCopy.message(for: CloudError.notFound, language: .en).lowercased()
        XCTAssertTrue(m.contains("expired"))
        XCTAssertTrue(m.contains("downloaded") || m.contains("burn"))
    }

    /// Integrity failures must not invite a retry — they are not transient.
    func testIntegrityFailuresDoNotInviteRetry() {
        for e in [StoredWireError.lengthMismatch, .truncatedStream] {
            let m = ErrorCopy.message(for: e, language: .en).lowercased()
            XCTAssertFalse(m.contains("try again"), "\(e) must not invite a retry")
        }
    }

    /// The download-side 429 has two possible causes — the per-IP download-start
    /// limiter and the sender account's monthly traffic gate — and the client
    /// cannot tell which fired without parsing server prose. So the copy names
    /// both and asserts neither, and it belongs to a RECIPIENT: a sentence about
    /// uploads describes work this user never did.
    func testDownloadLimitedNamesBothCausesWithoutClaimingEither() {
        let m = ErrorCopy.message(for: CloudError.downloadLimited, language: .en)
        let lower = m.lowercased()
        XCTAssertTrue(lower.contains("download"), m)
        XCTAssertTrue(lower.contains("monthly"), "the sender's allowance is the other cause")
        XCTAssertTrue(lower.contains("or "), "both causes, neither asserted")
        XCTAssertTrue(lower.contains("wait"), "the one 429 here that is worth waiting out")
        XCTAssertFalse(lower.contains("upload"), "the recipient did not upload anything")
    }

    /// And it must not collapse into either upload 429 it sits next to.
    func testDownloadLimitedIsDistinctFromTheUploadLimits() {
        let download = ErrorCopy.message(for: CloudError.downloadLimited, language: .en)
        let rate = ErrorCopy.message(for: CloudError.rateLimited, language: .en)
        let monthly = ErrorCopy.message(for: CloudError.monthlyTraffic, language: .en)
        XCTAssertEqual(Set([download, rate, monthly]).count, 3)
    }

    func testEveryCloudErrorHasCopy() {
        let cases: [CloudError] = [
            .unauthorized, .quota, .rateLimited, .dailyQuota, .monthlyTraffic,
            .downloadLimited, .notFound, .server(status: 500), .network, .decoding,
        ]
        for e in cases {
            let m = ErrorCopy.message(for: e, language: .en)
            XCTAssertFalse(m.isEmpty, "no copy for \(e)")
            XCTAssertFalse(m.contains("CloudError"), "\(e) fell through to the type-name fallback")
        }
    }

    /// The refusal has to explain itself — the spec calls a bare refusal a bug.
    func testDirectoryExistsExplainsWhyItWontMerge() {
        let m = ErrorCopy.message(for: DownloadDestinationError.directoryExists(name: "relayium-abc"), language: .en)
        XCTAssertTrue(m.contains("relayium-abc"))
        XCTAssertTrue(m.lowercased().contains("merge"))
    }

    /// A manifest that tries to escape the destination is refused by name, so a
    /// bug report can say which entry did it.
    func testUnsafeNameIsReportedWithTheOffendingName() {
        let m = ErrorCopy.message(for: DownloadDestinationError.unsafeName("../escape.txt"), language: .en)
        XCTAssertTrue(m.contains("../escape.txt"))
    }

    /// Every path-policy and selection refusal has to reach real copy rather
    /// than the type-name fallback — these are the messages a user sees when a
    /// folder send or receive is refused, and "Something went wrong
    /// (ManifestPathError)" is not one.
    func testFolderTransferRefusalsAllHaveCopy() {
        let cases: [Error] = [
            ManifestPathError.unsafePath("../escape.txt"),
            ManifestPathError.duplicatePath("t/a.txt"),
            ManifestPathError.pathCollision("t/a/b"),
            FileSelectionError.noFiles,
            FileSelectionError.tooManyFiles,
            FileSelectionError.unreadable("gone.txt"),
            FileSelectionError.symbolicLink("box/out"),
            FileSelectionError.pathTooLong("deep/…"),
        ]
        for e in cases {
            let m = ErrorCopy.message(for: e, language: .en)
            XCTAssertFalse(m.isEmpty, "no copy for \(e)")
            XCTAssertFalse(m.contains("Error)"), "\(e) fell through to the type-name fallback: \(m)")
        }
    }

    /// The refusal names the offending path, so the user can find and remove it
    /// rather than re-picking everything and hoping.
    func testFolderRefusalsNameTheOffendingItem() {
        XCTAssertTrue(ErrorCopy.message(for: ManifestPathError.unsafePath("../escape.txt"), language: .en)
            .contains("../escape.txt"))
        XCTAssertTrue(ErrorCopy.message(for: FileSelectionError.symbolicLink("box/out"), language: .en)
            .contains("box/out"))
        XCTAssertTrue(ErrorCopy.message(for: FileSelectionError.unreadable("gone.txt"), language: .en)
            .contains("gone.txt"))
    }

    /// An empty folder gets its own answer. "Choose between 1 and 1000 files"
    /// is baffling advice for someone who did choose a folder.
    func testEmptySelectionSaysWhyAnEmptyFolderCannotBeSent() {
        let m = ErrorCopy.message(for: FileSelectionError.noFiles, language: .en)
        XCTAssertTrue(m.lowercased().contains("empty folder"), m)
        XCTAssertNotEqual(m, ErrorCopy.message(for: RealtimeStagingError.fileCount, language: .en))
    }

    // The realtime rounds route ConnectionError, HandshakeError, RealtimeError and bare
    // WebRTC NSErrors through one ((Error) -> Void). The fallback must already be total.
    func testUnknownErrorStillProducesActionableText() {
        let m = ErrorCopy.message(for: UnknownFailure(), language: .en)
        XCTAssertFalse(m.isEmpty)
        XCTAssertTrue(m.contains("UnknownFailure"), "fallback should name the type for a bug report")
    }
}
