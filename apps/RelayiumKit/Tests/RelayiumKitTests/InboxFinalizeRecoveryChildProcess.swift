import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The CHILD half of `testLiveProcessKilledAfterCentralCommittedRecoversOnce`:
/// run only as a separate `xctest` process, which the parent SIGKILLs while
/// central holds the answer to a finalize it has already committed. A class of
/// its own so the live class's named-execution proof never sees a skip.
@MainActor
final class InboxFinalizeRecoveryChildProcess: XCTestCase {
    /// The child: only ever run as a separate xctest process by the parent.
    func testChildProcessAttempt() async throws {
        guard let metaPath = ProcessInfo.processInfo.environment["RELAYIUM_FINALIZE_CHILD_META"] else {
            throw XCTSkip("child phase of testLiveProcessKilledAfterCentralCommittedRecoversOnce")  // nonlocalized
        }
        let meta = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf:
            URL(fileURLWithPath: metaPath))) as? [String: String])
        let root = URL(fileURLWithPath: meta["root"]!)
        let s = InboxFinalizeRecoveryLiveTests.Sender(root: root, keys: InboxFinalizeRecoveryLiveTests.FileKeyStore(dir: root.appendingPathComponent("keys")))
        let url = URL(string: meta["url"]!)!
        let session = URLSession(configuration: .ephemeral)
        let coordinator = InboxSendCoordinator(
            store: s.store, keys: s.keys,
            uploader: CloudUploader(transport: HTTPResumableTransport(baseURL: url, session: session)),
            sender: InboxSenderClient(baseURL: url, token: meta["token"]!, session: session),
            finalizePolicy: FinalizeRecoveryPolicy())
        let plan = try XCTUnwrap(s.store.ownedDevicePlan(jobId: meta["job"]!))
        _ = try? await coordinator.deliver(plan, token: meta["token"]!)  // blocks on the held answer
        XCTFail("the child was expected to be killed while central held its answer")
    }

}
