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
    func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        ("u", 1 << 20)
    }
    func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                    total: Int, token: String) async throws -> PatchOutcome { .committed(received: to) }
    func uploadOffset(uploadId: String, token: String) async throws -> Int { 0 }
    func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
        UploadResult(id: "u", expiresAt: 0)
    }
}

@MainActor
final class CloudUploadModelTests: XCTestCase {
    private func makeModel() -> CloudUploadModel {
        CloudUploadModel(uploader: CloudUploader(transport: NoopTransport()),
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
        guard case .picked(let urls) = m.state else { return XCTFail("expected .picked, got \(m.state)") }
        XCTAssertEqual(urls, [url])
        XCTAssertFalse(m.isBusy)
    }

    /// The link is the only copy of the key; it must carry the fragment.
    func testDoneCarriesAFragmentLink() {
        let m = makeModel()
        m.applyOutcome(UploadOutcome(id: "abc", expiresAt: 99, keyB64url: "KEY"))
        guard case .done(let link, let exp) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(link, "https://relayium.com/d/abc#k=KEY")
        XCTAssertEqual(exp, 99)
    }

    /// reset() from .done goes back to the picked files, so "send another" does
    /// not make the user re-choose what they already chose.
    func testResetReturnsToThePickedFiles() {
        let m = makeModel()
        let url = sized(10, name: "b.bin")
        m.pick([url])
        m.applyOutcome(UploadOutcome(id: "x", expiresAt: 1, keyB64url: "K"))
        m.reset()
        guard case .picked(let urls) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(urls, [url])
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
}
