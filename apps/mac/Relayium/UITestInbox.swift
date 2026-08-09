#if DEBUG
import Foundation
import RelayiumAppKit
import RelayiumKit

/// Deterministic Device Inbox launches for the UI suite.
///
/// **It does not exist in a Release build.** The whole file is inside `#if DEBUG`,
/// so a shipped binary contains neither the flags nor the stub transport below —
/// the same compile-time absence `UITestMode` relies on, and for a sharper
/// reason: what this substitutes is the thing that decides what gets WRITTEN to
/// a user's disk.
///
/// ## Why these fixtures drive the real receiver
///
/// The obvious shortcut would be a debug hook that sets `InboxRuntimeState`
/// directly. That would be the "half-wired fixture" this workspace has already
/// been bitten by: it would prove that a label renders, and nothing about whether
/// the product can reach the state the label names. So instead each mode
/// substitutes ONE seam — the transport — and lets the real enrolment, the real
/// key store, the real sealed box, the real Stored Wire decryptor, the real
/// destination planner, the real `linkat` commit and the real journal run. The
/// ciphertext the result fixture serves is produced by the production encryptors
/// from a key sealed to the key this device generated during the launch, so a
/// completed result on screen means a file genuinely landed on disk.
///
/// ## Isolation
///
/// Every store this touches is either in memory or under a launch-owned
/// directory that is emptied first: the key history, the folder bookmark and
/// policy, the journal directory and the receive folder itself. Isolating one
/// store is not isolating the app — the installed product's keychain items,
/// defaults and receive folder must be unreachable from an acceptance launch.
enum UITestInbox {
    // nonlocalized: test-only launch arguments, absent from Release
    static let readyArgument = "--relayium-ui-testing-inbox-ready"
    static let attentionArgument = "--relayium-ui-testing-inbox-attention"
    static let workingArgument = "--relayium-ui-testing-inbox-working"
    static let resultArgument = "--relayium-ui-testing-inbox-result"
    static let askArgument = "--relayium-ui-testing-inbox-ask"

    static let showsReady = ProcessInfo.processInfo.arguments.contains(readyArgument)
    static let showsAttention = ProcessInfo.processInfo.arguments.contains(attentionArgument)
    static let showsWorking = ProcessInfo.processInfo.arguments.contains(workingArgument)
    static let showsResult = ProcessInfo.processInfo.arguments.contains(resultArgument)
    static let showsAsk = ProcessInfo.processInfo.arguments.contains(askArgument)

    static var isActive: Bool {
        showsReady || showsAttention || showsWorking || showsResult || showsAsk
    }

    /// The mode's own controller, or nil when this launch is not an inbox one.
    @MainActor
    static func makeController() -> InboxController? {
        guard UITestMode.isActive, isActive else { return nil }
        let folderStore = InMemoryInboxFolderStore()
        let keys = InMemoryInboxDeviceKeyStore()
        guard let root = launchDirectory("uitest-inbox-receive"),
              let journalRoot = launchDirectory("uitest-inbox-journal") else { return nil }
        let journals = InboxJournalStore(directory: journalRoot)

        // The attention fixture needs a grant that RESOLVES nowhere, which a real
        // bookmark cannot be made to do on demand — the seam the Phase 2A review
        // added for exactly this reason.
        let bookmarking: InboxFolderBookmarking = showsAttention
            ? UITestUnresolvableBookmarking() : UITestPathBookmarking()
        let folder = InboxReceiveFolder(store: folderStore, bookmarking: bookmarking)

        // Written through the product's own setters, so the fixture cannot end up
        // in a state the app itself is unable to reach. The attention mode stores
        // the grant directly because its bookmarking refuses to probe.
        let account = try? InboxAccountID(UITestInbox.accountID)
        if let account {
            if showsAttention {
                folderStore.setBookmarkData(Data(root.path.utf8), account: account)
                folderStore.setReceivePolicy(.auto, account: account)
            } else {
                _ = try? folder.chooseFolder(root, account: account)
                try? folder.setReceivePolicy(showsAsk ? .ask : .auto, account: account)
            }
        }

        let transport = UITestInboxTransport(mode: mode)
        return InboxController(runtime: InboxRuntime(
            folder: folder,
            makeEngine: { account, _ in
                InboxReceiveEngine(transport: transport, keys: keys, journals: journals,
                                   folder: folder, account: account)
            },
            notifier: nil,
            // The PRODUCTION sleeper, with the intervals scaled down. The first
            // version of this fixture used a sleeper that returned immediately,
            // which turned the loop into a tight main-actor cycle: the app stayed
            // alive but the settings window never rendered its status inside
            // twenty seconds, and four acceptance launches failed for a reason
            // that had nothing to do with the product. A real short wait keeps the
            // suite fast without starving the UI it exists to look at.
            sleeper: InboxTaskSleeper(),
            reveal: { _ in },
            platform: AppEnvironment.inboxPlatform,
            appVersion: "uitest",  // nonlocalized: a build label, never displayed
            backoff: InboxBackoff(idle: 1, afterWork: 1, first: 1, cap: 2, blocked: 1)))
    }

    /// The account the signed-in acceptance fixture holds. Matched to
    /// `UITestAccountTransport`'s `/api/me`, so the controller's own account
    /// binding is the one the rest of the app is signed in as.
    // nonlocalized: an acceptance fixture account id
    static let accountID = "acct_uitest"

    enum Mode { case ready, attention, working, result, ask }

    static var mode: Mode {
        if showsAttention { return .attention }
        if showsWorking { return .working }
        if showsResult { return .result }
        if showsAsk { return .ask }
        return .ready
    }

    /// A directory of this launch's own, emptied before use.
    ///
    /// Application Support, deliberately, and not `temporaryDirectory` or
    /// `cachesDirectory`: `IOSSurfaceGuardTests` refuses both anywhere in these
    /// sources, because a received file must never land somewhere the system can
    /// purge — and a journal even less so, since it is what stops a delivery
    /// being written twice.
    private static func launchDirectory(_ name: String) -> URL? {
        guard let support = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true) else { return nil }
        let directory = support.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}

/// A bookmark that is just the path. Enough for a real directory in a real
/// launch, and it never touches the sandbox's finite scope budget.
private struct UITestPathBookmarking: InboxFolderBookmarking {
    func bookmark(for url: URL) throws -> Data { Data(url.path.utf8) }
    func resolve(_ data: Data) throws -> (url: URL, isStale: Bool) {
        guard let path = String(data: data, encoding: .utf8) else {
            throw InboxFolderError.bookmarkFailed
        }
        return (URL(fileURLWithPath: path), false)
    }
    func startAccess(to url: URL) -> Bool { true }
    func stopAccess(to url: URL) {}
}

/// The grant that will not resolve: a folder deleted, renamed, or on a volume
/// that is not mounted.
private struct UITestUnresolvableBookmarking: InboxFolderBookmarking {
    func bookmark(for url: URL) throws -> Data { Data(url.path.utf8) }
    func resolve(_ data: Data) throws -> (url: URL, isStale: Bool) {
        throw InboxFolderError.bookmarkFailed
    }
    func startAccess(to url: URL) -> Bool { false }
    func stopAccess(to url: URL) {}
}

/// Central, answered in process.
///
/// It holds one delivery, and it BUILDS that delivery from the public key this
/// launch's own device registered — which is what makes the result fixture a
/// real decrypt rather than a fixture agreeing with itself.
private final class UITestInboxTransport: InboxTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let mode: UITestInbox.Mode
    private var publicKey: String = ""
    private var ciphertext = Data()
    private var delivered = false
    /// Retained so the stalled stream is never finished. `working` is a state a
    /// person has to be able to LOOK at, which means the pass has to still be in
    /// it when the assertion runs.
    private var heldStream: AsyncThrowingStream<Data, Error>.Continuation?

    init(mode: UITestInbox.Mode) { self.mode = mode }

    // nonlocalized: acceptance fixture identifiers, never displayed
    private static let deviceID = "dev_this"
    private static let taskID = "task_uitest"
    private static let fileName = "brief.txt"

    @discardableResult
    private func sync<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }

    func currentDevice() async throws -> InboxDeviceRow {
        InboxDeviceRow(id: Self.deviceID, isCurrent: true)
    }

    func enrol(_ request: InboxEnrolRequest) async throws -> InboxEnrolResult {
        InboxEnrolResult(inbox: InboxView(presence: .online, autoAccept: request.autoAccept,
                                          receiveDirReady: request.receiveDirReady,
                                          canReceive: true, key: registeredKey()),
                         protocolVersion: InboxProtocol.versions[0],
                         receiveCapability: InboxCapability.receiveV1,
                         keyAlgorithm: InboxProtocol.keyAlgorithm)
    }

    private func registeredKey() -> InboxKey? {
        let encoded = sync { publicKey }
        guard !encoded.isEmpty else { return nil }
        // nonlocalized: an acceptance fixture key id
        return InboxKey(id: "key_uitest", algorithm: InboxProtocol.keyAlgorithm,
                        publicKey: encoded, generation: 1, createdAt: 0,
                        supersededAt: 0, revokedAt: 0)
    }

    func registerKey(algorithm: String, publicKey key: String,
                     previousKeyID: String?) async throws -> InboxKey {
        sync { publicKey = key }
        // nonlocalized: an acceptance fixture key id
        return InboxKey(id: "key_uitest", algorithm: algorithm, publicKey: key,
                        generation: 1, createdAt: 0, supersededAt: 0, revokedAt: 0)
    }

    func listKeys() async throws -> [InboxKey] { registeredKey().map { [$0] } ?? [] }

    @discardableResult
    func heartbeat(receiveDirReady: Bool) async throws -> InboxHeartbeatResult {
        InboxHeartbeatResult(presence: .online)
    }

    func goOffline() async throws {}

    func pending(limit: Int) async throws -> [InboxTask] {
        if mode == .ask {
            return [
                InboxTask(id: "task_ask_one", state: .attentionRequired,
                          ciphertextBytes: 1_024, expiresAt: 4_102_444_800),
                InboxTask(id: "task_ask_two", state: .attentionRequired,
                          ciphertextBytes: 8_192, expiresAt: 4_102_444_800)
            ]
        }
        guard mode == .working || mode == .result, !sync({ delivered }) else { return [] }
        return [InboxTask(id: Self.taskID, state: .queued)]
    }

    func claim(max: Int) async throws -> (deliveries: [InboxDelivery], leaseSeconds: Int) {
        guard mode == .working || mode == .result, !sync({ delivered }) else {
            return (deliveries: [], leaseSeconds: 300)
        }
        guard let encoded = sync({ publicKey.isEmpty ? nil : publicKey }),
              let recipient = try? InboxKeyMaterial.decode(encoded,
                                                          expecting: InboxProtocol.publicKeyBytes)
        else { return (deliveries: [], leaseSeconds: 300) }

        // Built with the PRODUCTION encryptors from a fresh content key, sealed
        // to the key this device just published. Nothing here reproduces the
        // decryptor's own arithmetic, so a drift in the frame format, the
        // manifest serialization or the sealed box fails the fixture loudly
        // instead of quietly agreeing with itself.
        let bytes = [UInt8](repeating: 0x52, count: 2_048)
        let contentKey = generateStoreKey()
        let manifest = StoredManifest(files: [ManifestFile(name: Self.fileName,
                                                           size: bytes.count)])
        guard let encManifest = try? encryptManifest(key: contentKey, manifest),
              let sealed = sodium.box.seal(message: contentKey, recipientPublicKey: recipient)
        else { return (deliveries: [], leaseSeconds: 300) }
        let body = Data(encryptChunks(key: contentKey, files: [bytes]))
        sync { ciphertext = body }

        let task = InboxTask(id: Self.taskID, storedFileID: "obj_uitest",  // nonlocalized: fixture id
                             state: .downloading, ciphertextBytes: Int64(body.count),
                             targetKeyID: "key_uitest")  // nonlocalized: fixture id
        let delivery = InboxDelivery(task: task,
                                     encManifest: Data(encManifest).base64EncodedString(),
                                     wrappedKey: InboxKeyMaterial.encode(sealed),
                                     claimToken: "claim_uitest")  // nonlocalized: fixture token
        return (deliveries: [delivery], leaseSeconds: 300)
    }

    func blob(taskID: String, claimToken: String, offset: Int64) async throws -> InboxBlobStream {
        let body = sync { ciphertext }
        if mode == .working {
            // Opened, never finished. The pass stays inside the download, which
            // is what makes `working` a state the suite can look at rather than
            // one it has to catch.
            let stream = AsyncThrowingStream<Data, Error> { continuation in
                sync { heldStream = continuation }
            }
            return InboxBlobStream(status: 200, isPartial: false, chunks: stream)
        }
        let stream = AsyncThrowingStream<Data, Error> { continuation in
            continuation.yield(body)
            continuation.finish()
        }
        return InboxBlobStream(status: 200, isPartial: false, chunks: stream)
    }

    @discardableResult
    func report(taskID: String, claimToken: String, state: InboxTaskState,
                errorCode: InboxDeviceErrorCode, committed: Bool) async throws -> InboxTask {
        if state == .saved { sync { delivered = true } }
        return InboxTask(id: taskID, state: state, errorCode: .device(errorCode))
    }

    @discardableResult
    func accept(taskID: String, accept: Bool) async throws -> InboxTask {
        InboxTask(id: taskID, state: accept ? .queued : .failedTerminal)
    }

    func clearInbox() async throws {}
}
#endif
