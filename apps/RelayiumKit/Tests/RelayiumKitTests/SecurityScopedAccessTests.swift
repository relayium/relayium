import XCTest
@testable import RelayiumAppKit

/// Records what the sandbox was actually asked for. Not `@MainActor`: the type
/// under test releases from `deinit`, which cannot touch isolated state.
private final class RecordingResource: SecurityScopedResourceAccessing, @unchecked Sendable {
    private let lock = NSLock()
    private var _started: [String] = []
    private var _stopped: [String] = []
    /// Paths whose start should fail, as a real denied scope would.
    let refuse: Set<String>

    init(refuse: Set<String> = []) { self.refuse = refuse }

    func startAccess(to url: URL) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if refuse.contains(url.path) { return false }
        _started.append(url.path)
        return true
    }
    func stopAccess(to url: URL) {
        lock.lock(); defer { lock.unlock() }
        _stopped.append(url.path)
    }
    var started: [String] { lock.lock(); defer { lock.unlock() }; return _started }
    var stopped: [String] { lock.lock(); defer { lock.unlock() }; return _stopped }
}

private func url(_ path: String) -> URL { URL(fileURLWithPath: path) }

final class SecurityScopedAccessTests: XCTestCase {

    func testReplaceStartsEveryDistinctURLOnce() {
        let r = RecordingResource()
        let a = SecurityScopedAccess(resource: r)
        let kept = a.replace(with: [url("/tmp/one"), url("/tmp/two")])
        XCTAssertEqual(kept.map(\.path), ["/tmp/one", "/tmp/two"])
        XCTAssertEqual(r.started, ["/tmp/one", "/tmp/two"])
        XCTAssertEqual(r.stopped, [])
    }

    /// Two spellings of one path take two sandbox extensions if started twice,
    /// and then need two stops. De-duplicating first — by the same standardized
    /// path `expandSelection` de-duplicates roots by — means one of each.
    func testTheSamePathTwiceInOneBatchStartsOnce() {
        let r = RecordingResource()
        let a = SecurityScopedAccess(resource: r)
        let kept = a.replace(with: [url("/tmp/one"), url("/tmp/./one"), url("/tmp/one")])
        XCTAssertEqual(kept.count, 1)
        XCTAssertEqual(r.started, ["/tmp/one"])
        a.clear()
        XCTAssertEqual(r.stopped, ["/tmp/one"])
    }

    /// The new batch is started BEFORE the old one is released, so a path that
    /// appears in both never drops to zero extensions in between.
    func testASecondReplaceStopsExactlyTheFirstBatch() {
        let r = RecordingResource()
        let a = SecurityScopedAccess(resource: r)
        a.replace(with: [url("/tmp/one"), url("/tmp/two")])
        a.replace(with: [url("/tmp/three")])
        XCTAssertEqual(r.started, ["/tmp/one", "/tmp/two", "/tmp/three"])
        XCTAssertEqual(r.stopped, ["/tmp/one", "/tmp/two"])
        XCTAssertEqual(a.heldURLs.map(\.path), ["/tmp/three"])
    }

    /// A refused start consumed no extension. Stopping it anyway is unbalanced
    /// in the other direction, and on a real sandbox that is not a no-op.
    func testARefusedStartIsNeverStopped() {
        let r = RecordingResource(refuse: ["/tmp/denied"])
        let a = SecurityScopedAccess(resource: r)
        let kept = a.replace(with: [url("/tmp/ok"), url("/tmp/denied")])
        // Both are still handed to the caller: the denied one fails visibly at
        // enumeration, with copy that names it.
        XCTAssertEqual(kept.map(\.path), ["/tmp/ok", "/tmp/denied"])
        XCTAssertEqual(a.startedURLs.map(\.path), ["/tmp/ok"])
        a.clear()
        XCTAssertEqual(r.stopped, ["/tmp/ok"])
    }

    func testClearIsIdempotent() {
        let r = RecordingResource()
        let a = SecurityScopedAccess(resource: r)
        a.replace(with: [url("/tmp/one")])
        a.clear(); a.clear()
        XCTAssertEqual(r.stopped, ["/tmp/one"])
        XCTAssertTrue(a.heldURLs.isEmpty)
    }

    /// The release path that must not be skippable. A `@MainActor` owner could
    /// not do this at all — a deinit cannot touch isolated state.
    func testDeallocationReleasesWhatWasHeld() {
        let r = RecordingResource()
        do {
            let a = SecurityScopedAccess(resource: r)
            a.replace(with: [url("/tmp/one"), url("/tmp/two")])
            XCTAssertEqual(r.stopped, [])
        }
        XCTAssertEqual(r.stopped.sorted(), ["/tmp/one", "/tmp/two"])
    }

    func testAnEmptyReplaceReleasesEverything() {
        let r = RecordingResource()
        let a = SecurityScopedAccess(resource: r)
        a.replace(with: [url("/tmp/one")])
        XCTAssertEqual(a.replace(with: []).count, 0)
        XCTAssertEqual(r.stopped, ["/tmp/one"])
    }
}
