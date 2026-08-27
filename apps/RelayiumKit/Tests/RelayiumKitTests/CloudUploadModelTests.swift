import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

private func sized(_ bytes: Int, name: String) -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("g2-up-\(UUID().uuidString)-\(name)")
    FileManager.default.createFile(atPath: url.path, contents: Data(repeating: 0, count: bytes))
    return url
}

private final class NoopTransport: ResumableTransport, @unchecked Sendable {
    func initUpload(header: [UInt8], purpose: UploadPurpose, burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        ("u", 1 << 20)
    }
    func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                    total: Int, token: String,
                    onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome { .committed(received: to) }
    func uploadOffset(uploadId: String, token: String) async throws -> Int { 0 }
    func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
        UploadResult(id: "u", expiresAt: 0)
    }
}

/// Stands in for a keychain that refuses to write. The upload it follows has
/// already succeeded on the server, which is the whole difficulty.
private struct FailingUploadKeyStore: StoredLinkKeyStore {
    func save(id: String, keyB64url: String) async throws { throw KeychainError.status(-25308) }
    func key(for id: String) async throws -> String? { throw KeychainError.status(-25308) }
    func remove(id: String) async throws { throw KeychainError.status(-25308) }
}

/// A save the app refuses on its own, before the keychain is reached at all —
/// an id it will not compose into an account name, or a key that is not the
/// base64url a `#k=` fragment can carry. Same difficulty as the keychain
/// failure above: the bytes are already on the server either way.
private struct RefusingUploadKeyStore: StoredLinkKeyStore {
    let error: StoredLinkKeyError
    func save(id: String, keyB64url: String) async throws { throw error }
    func key(for id: String) async throws -> String? { throw error }
    func remove(id: String) async throws { throw error }
}

@MainActor
final class CloudUploadModelTests: XCTestCase {
    private var keys = InMemoryStoredLinkKeyStore()

    override func setUp() { keys = InMemoryStoredLinkKeyStore() }

    private func makeModel(keyStore: StoredLinkKeyStore? = nil) -> CloudUploadModel {
        CloudUploadModel(uploader: CloudUploader(transport: NoopTransport()),
                         keyStore: keyStore ?? keys,
                         origin: "https://relayium.com")
    }

    /// An unknown cap offers everything and lets the server truncate — the same
    /// call the web makes, so a failed usage fetch never hides working options.
    func testUnknownRetentionCapOffersEveryTTL() {
        XCTAssertEqual(allowedTTLs(retentionSecs: 0), [3600, 86400, 259200, 604800, 1209600])
    }

    func testRetentionCapTruncatesTheChoices() {
        XCTAssertEqual(allowedTTLs(retentionSecs: 259200), [3600, 86400, 259200])
    }

    /// A cap below every option must still leave something selectable.
    func testTinyRetentionCapStillOffersTheShortestTTL() {
        XCTAssertEqual(allowedTTLs(retentionSecs: 60), [3600])
    }

    /// Applying a cap must also move a now-invalid selection, or the picker
    /// shows a value that is not in its own list.
    func testApplyingACapMovesAnOutOfRangeSelection() {
        let m = makeModel()
        m.ttl = 1209600
        m.applyRetentionCap(86400)
        XCTAssertEqual(m.ttlChoices, [3600, 86400])
        XCTAssertEqual(m.ttl, 86400)
    }

    /// Refuse locally rather than spending an upload to earn a 413.
    func testOversizeFileIsRefusedBeforeUploading() {
        let m = makeModel()
        m.maxFileSize = 1000
        m.pick([sized(2000, name: "big.bin")])
        guard case .failed(let msg) = m.state else { return XCTFail("expected refusal, got \(m.state)") }
        XCTAssertTrue(msg.contains("big.bin"), "the refusal must name the file: \(msg)")
    }

    /// An unknown cap must not refuse anything — 0 means "we don't know".
    func testUnknownMaxFileSizeRefusesNothing() {
        let m = makeModel()
        m.maxFileSize = 0
        m.pick([sized(5000, name: "whatever.bin")])
        guard case .picked = m.state else { return XCTFail("expected .picked, got \(m.state)") }
    }

    /// Cancelling must land in a state the user can act from, not a stuck spinner.
    func testCancelReturnsToPicked() {
        let m = makeModel()
        let url = sized(10, name: "a.bin")
        m.pick([url])
        m.cancel()
        guard case .picked(let files) = m.state else { return XCTFail("expected .picked, got \(m.state)") }
        XCTAssertEqual(files.map(\.url), [url])
        XCTAssertFalse(m.isBusy)
    }

    /// The link is the only copy of the key; it must carry the fragment.
    func testDoneCarriesAFragmentLink() async {
        let m = makeModel()
        await m.applyOutcome(UploadOutcome(id: "abc", expiresAt: 99, keyB64url: "KEY"))
        guard case .done(let link, let exp, let warning) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(link, "https://relayium.com/d/abc#k=KEY")
        XCTAssertEqual(exp, 99)
        XCTAssertNil(warning)
    }

    func testFileDetailsSurviveUntilTheCompletedLinkAndClearWithTheSelection() async {
        let m = makeModel()
        m.pick([sized(17, name: "report.txt")])
        XCTAssertEqual(m.sessionFiles, [FileMeta(name: m.selectedFiles[0].name, size: 17)])

        await m.applyOutcome(UploadOutcome(id: "abc", expiresAt: 99, keyB64url: "KEY"))
        XCTAssertEqual(m.sessionFiles.map(\.size), [17])
        XCTAssertTrue(m.sessionFiles[0].name.hasSuffix("report.txt"))

        m.clearSelection()
        XCTAssertEqual(m.sessionFiles, [])
    }

    /// The key exists only in that link. Keeping it is what makes the Account
    /// tab able to hand the link back later instead of listing an object nobody
    /// on this device can open.
    func testASuccessfulUploadPersistsItsKeyForLaterReconstruction() async throws {
        let m = makeModel()
        await m.applyOutcome(UploadOutcome(id: "abc", expiresAt: 99, keyB64url: "KEY"))
        let stored = try await keys.key(for: "abc")
        XCTAssertEqual(stored, "KEY")
        XCTAssertEqual(buildDownloadLink(origin: "https://relayium.com", id: "abc", keyB64url: stored ?? ""),
                       "https://relayium.com/d/abc#k=KEY")
    }

    /// The bytes are already on the server. Turning a keychain failure into a
    /// failed upload would invite a retry that uploads them a second time, and
    /// hiding the link would throw away the only copy of the key there will ever
    /// be. So the link stays, and the warning says what did not happen.
    func testAKeyStoreFailureStillShowsTheLinkAndSaysSo() async {
        let m = makeModel(keyStore: FailingUploadKeyStore())
        await m.applyOutcome(UploadOutcome(id: "abc", expiresAt: 99, keyB64url: "KEY"))
        guard case .done(let link, _, let warning) = m.state else {
            return XCTFail("a successful upload was reported as \(m.state)")
        }
        XCTAssertEqual(link, "https://relayium.com/d/abc#k=KEY")
        XCTAssertNotNil(warning, "the user was not told the key was not kept")
    }

    /// And it says what actually failed. The keychain raises the same
    /// `KeychainError` the sign-in token store does, whose copy is "macOS
    /// wouldn't store your sign-in … you'll stay signed in until you quit" —
    /// three claims that are all false here. Nothing about the session changed;
    /// what was not written is this file's key, and this warning is the only
    /// place the user will ever be told so.
    func testAFailedKeySaveIsDescribedAsAKeySaveAndNotAsASignInProblem() async {
        let m = makeModel(keyStore: FailingUploadKeyStore())
        await m.applyOutcome(UploadOutcome(id: "abc", expiresAt: 99, keyB64url: "KEY"))
        guard case .done(_, _, let warning) = m.state else { return XCTFail("got \(m.state)") }
        let text = UploadPresentation.keyNotice(warning: warning).text
        assertSaysNothingAboutSigningIn(text, "the failed-key-save warning")
        XCTAssertTrue(text.lowercased().contains("save"), "it does not say the save failed: \(text)")
        XCTAssertTrue(text.lowercased().contains("keychain"), text)
        XCTAssertTrue(text.contains("-25308"), "the keychain status was dropped: \(text)")
        // The reason the warning exists at all, and unchanged by the rewording.
        XCTAssertTrue(text.contains("only available copy"), text)
    }

    /// The same requirement for the failures the app raises itself. Their shared
    /// copy is `AccountClient`'s — an id refused BEFORE a DELETE was sent — and
    /// rendered here it was wrong twice: `invalidKey` said the key stored on
    /// this device is unreadable when this save stored nothing, and
    /// `invalidIdentifier` read as a refusal that stopped everything, on the
    /// screen that exists BECAUSE the upload succeeded.
    func testAKeySaveTheAppRefusesSaysSoWithoutDenyingTheUpload() async {
        for e in [StoredLinkKeyError.invalidKey, .invalidIdentifier] {
            let m = makeModel(keyStore: RefusingUploadKeyStore(error: e))
            await m.applyOutcome(UploadOutcome(id: "abc", expiresAt: 99, keyB64url: "KEY"))
            guard case .done(let link, _, let warning) = m.state else {
                return XCTFail("a successful upload was reported as \(m.state) for \(e)")
            }
            XCTAssertEqual(link, "https://relayium.com/d/abc#k=KEY",
                           "the only copy of the key was withheld for \(e)")
            let text = UploadPresentation.keyNotice(warning: warning).text
            assertSaysNothingAboutSigningIn(text, "the \(e) save warning")
            assertDoesNotDenyACompletedRequest(text, "the \(e) save warning")
            XCTAssertTrue(text.lowercased().contains("save"),
                          "it does not say the save failed for \(e): \(text)")
            XCTAssertFalse(text.lowercased().contains("stored on this mac"),
                           "it describes a key this save never stored for \(e): \(text)")
            XCTAssertTrue(text.contains("only available copy"), text)
        }
    }

    /// Each upload's key is stored under its own id, so a second upload does not
    /// overwrite the first one's way back in.
    func testEachUploadKeepsItsOwnKey() async throws {
        let m = makeModel()
        await m.applyOutcome(UploadOutcome(id: "abc", expiresAt: 99, keyB64url: "KEY"))
        await m.applyOutcome(UploadOutcome(id: "other", expiresAt: 1, keyB64url: "K2"))
        let first = try await keys.key(for: "abc")
        let second = try await keys.key(for: "other")
        XCTAssertEqual(first, "KEY")
        XCTAssertEqual(second, "K2")
    }

    /// The screen has moved on — cancelled, cleared, or a second upload started.
    /// The bytes still reached the server, so the key is still the only thing
    /// that could ever open them: it is kept even though nothing is repainted.
    func testASupersededOutcomeStillKeepsItsKey() async throws {
        let m = makeModel()
        m.pick([sized(10, name: "sup.bin")])
        let stale = m.currentGeneration
        m.cancel()                                   // bumps the generation
        await m.finish(UploadOutcome(id: "orphan", expiresAt: 1, keyB64url: "KEY"), g: stale)
        guard case .picked = m.state else {
            return XCTFail("a superseded outcome repainted the screen: \(m.state)")
        }
        let stored = try await keys.key(for: "orphan")
        XCTAssertEqual(stored, "KEY", "the key for an upload the server accepted was thrown away")
    }

    /// reset() from .done goes back to the picked files, so "send another" does
    /// not make the user re-choose what they already chose.
    func testResetReturnsToThePickedFiles() async {
        let m = makeModel()
        let url = sized(10, name: "b.bin")
        m.pick([url])
        await m.applyOutcome(UploadOutcome(id: "x", expiresAt: 1, keyB64url: "K"))
        m.reset()
        guard case .picked(let files) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(files.map(\.url), [url])
    }

    /// A callback from a superseded upload must not repaint a screen the user
    /// has already moved past — the guard AccountSession established.
    func testSupersededProgressIsIgnored() {
        let m = makeModel()
        m.pick([sized(10, name: "c.bin")])
        let stale = m.currentGeneration
        m.cancel()                                   // bumps the generation
        m.report(sent: 50, total: 100, g: stale)
        guard case .picked = m.state else {
            return XCTFail("a superseded callback repainted the screen: \(m.state)")
        }
    }

    // MARK: - what the "Link ready" screen says about the key

    /// After a successful save the key IS on this device and the Account tab can
    /// hand the link back, so the screen must not say the link is the only copy
    /// of it. That statement was true before this store existed and is false
    /// now, which is worse than vague: it tells the user to treat a recoverable
    /// link as irreplaceable, and it contradicts the warning shown when the save
    /// really did fail.
    ///
    /// What this pins is WHERE the key lives and that it never left — not the
    /// word "Mac", which was only ever assertable across the nine catalogs that
    /// then shipped because a brand name survives translation verbatim. The same notice is rendered on
    /// iOS from R3-C onwards, so the noun that was platform-true is now
    /// platform-false, and the substance is unchanged.
    func testTheSuccessNoticeSaysTheKeyIsKeptOnThisDeviceAndNeverSent() {
        let notice = UploadPresentation.keyNotice(warning: nil)
        XCTAssertFalse(notice.isWarning)
        XCTAssertTrue(notice.text.contains("this device"), notice.text)
        XCTAssertTrue(notice.text.contains("never sent to Relayium"), notice.text)
        XCTAssertFalse(notice.text.contains("Mac"), notice.text)
        XCTAssertFalse(notice.text.lowercased().contains("only"),
                       "the success copy still claims the link is the only copy: \(notice.text)")
    }

    /// Exactly one statement is shown, so the two can never contradict each
    /// other on screen: a warning replaces the reassurance rather than joining
    /// it.
    func testTheWarningReplacesTheSuccessNoticeRatherThanJoiningIt() {
        let notice = UploadPresentation.keyNotice(warning: "the key was not kept")
        XCTAssertTrue(notice.isWarning)
        XCTAssertEqual(notice.text, "the key was not kept")
        XCTAssertNotEqual(notice.text, UploadPresentation.keyKeptText())
    }

    /// And the failure path really does carry the instruction the success path
    /// must not: this is the last moment that key exists anywhere but the link
    /// on screen.
    func testOnlyTheFailedSaveTellsTheUserToCopyTheLinkNow() async {
        let m = makeModel(keyStore: FailingUploadKeyStore())
        await m.applyOutcome(UploadOutcome(id: "abc", expiresAt: 99, keyB64url: "KEY"))
        guard case .done(_, _, let warning) = m.state else { return XCTFail("got \(m.state)") }
        let notice = UploadPresentation.keyNotice(warning: warning)
        XCTAssertTrue(notice.isWarning)
        XCTAssertTrue(notice.text.contains("only available copy"), notice.text)
        XCTAssertTrue(notice.text.lowercased().contains("copy it now"), notice.text)
    }

    // MARK: - advisory caps, applied as one pair

    func testApplyingCapsNarrowsTheTTLChoices() {
        let m = makeModel()
        m.apply(UploadCaps(retentionSecs: 86_400, maxFileSize: 0))
        XCTAssertEqual(m.ttlChoices, [3600, 86400])
    }

    /// The pair is applied and cleared together, so a size gate cannot outlive
    /// the retention it arrived with.
    func testApplyingAnUnknownCapTurnsBothOff() {
        let m = makeModel()
        m.apply(UploadCaps(retentionSecs: 3600, maxFileSize: 1000))
        XCTAssertEqual(m.ttlChoices, [3600])
        XCTAssertEqual(m.maxFileSize, 1000)
        m.apply(.unknown)
        XCTAssertEqual(m.ttlChoices, [3600, 86400, 259200, 604800, 1209600])
        XCTAssertEqual(m.maxFileSize, 0)
    }

    /// A cap is a limit; the chosen TTL is a preference. Narrowing pulls the
    /// selection down only when it no longer fits, and widening again never
    /// moves it back — the user's choice is theirs.
    func testApplyingCapsMovesTheSelectedTTLOnlyWhenItNoLongerFits() {
        let m = makeModel()
        m.ttl = 604_800
        m.apply(UploadCaps(retentionSecs: 86_400, maxFileSize: 0))
        XCTAssertEqual(m.ttl, 86_400)
        m.apply(.unknown)
        XCTAssertEqual(m.ttl, 86_400, "widening the cap must not re-pick for the user")
    }
}
