#if DEBUG
import Foundation
import RelayiumAppKit
import RelayiumKit

/// Deterministic Device Inbox launches for the iOS UI suite: Check now, driven
/// end to end with no network.
///
/// **It does not exist in a Release build.** The whole file is inside `#if DEBUG`,
/// and `UITestMode.makeInboxController()` answers nil in Release, so a shipped
/// binary contains neither the flags nor the stand-in transport — and what this
/// substitutes is the thing that decides what gets WRITTEN into the app's
/// container.
///
/// ## Why it drives the real receiver
///
/// A debug hook that set `InboxRuntimeState` or `InboxManualCheck` directly would
/// prove a label renders and nothing about whether Check now reaches the state
/// the label names. So this substitutes ONE seam — the transport — and the real
/// `InboxController`, its serial loop and its coalescing, the real enrolment, key
/// store, sealed box, v3 manifest decryptor, container destination planner,
/// commit and journal all run. The delivery the second check finds is built by
/// the production encryptors from a key sealed to the key this launch generated,
/// so "3 files saved" on screen means three files genuinely landed on disk.
///
/// It is the iOS counterpart of the macOS `UITestInbox`, reduced to the two
/// launches the iOS surface needs: `check` (automatic schedule stretched to an
/// hour, so every pass after launch is one the test asked for) and `ask` (two
/// deliveries held for an answer, so Check now can be shown to answer nothing on
/// the user's behalf).
///
/// ## Isolation
///
/// Every store is in memory or under a launch-owned directory: the device-key
/// history, the receive policy, the journal, message and conversation stores,
/// and the receive folder itself. The installed product's keychain items,
/// defaults and `Documents/Received` are unreachable from these launches.
enum UITestInbox {
    // nonlocalized: test-only launch arguments, absent from Release
    static let checkArgument = "--relayium-ui-testing-inbox-check"
    static let askArgument = "--relayium-ui-testing-inbox-ask"

    static let showsCheck = ProcessInfo.processInfo.arguments.contains(checkArgument)
    static let showsAsk = ProcessInfo.processInfo.arguments.contains(askArgument)

    enum Mode { case check, ask }

    static var mode: Mode { showsAsk ? .ask : .check }

    /// The account the signed-in acceptance fixture holds — `UITestAccountTransport`'s
    /// `/api/me` — so the controller's account binding is the app's own.
    // nonlocalized: an acceptance fixture account id
    static let accountID = "acct_uitest"
    // nonlocalized: the server-authenticated sender row for every fixture task
    static let senderDeviceID = "dev_sender_uitest"

    /// One private root per process, for the reason the macOS fixture records:
    /// XCTest can launch the next app before the previous one has released its
    /// journal handles, and a shared fixed path let a best-effort removal race it.
    private static let launchID = UUID().uuidString

    /// The mode's own controller, or nil when this launch is not an inbox one.
    @MainActor
    static func makeController() -> InboxController? {
        guard UITestMode.isActive, UITestMode.isSignedIn, showsCheck || showsAsk,
              let account = try? InboxAccountID(accountID),
              let journalRoot = supportDirectory("uitest-inbox-journal"),
              // Kept apart from the journal root for the reason the product keeps
              // them apart: a journal prune must never reach a message record.
              let messageRoot = supportDirectory("uitest-inbox-messages"),
              let conversationRoot = supportDirectory("uitest-inbox-conversations")
        else { return nil }

        let journals = InboxJournalStore(directory: journalRoot)
        let messages = InboxMessageStore(directory: messageRoot)
        let conversations = InboxConversationStore(directory: conversationRoot)
        let keys = InMemoryInboxDeviceKeyStore()
        // The PRODUCT's fixed-container folder types, over an in-memory policy
        // store and a launch-owned receive directory. The container store always
        // reports its marker, which is what makes the folder question absent on
        // iOS; only where the marker resolves is the fixture's.
        let receiveDirectory: @Sendable () throws -> URL = {
            let documents = try ReceiveDestination.documentsDirectory()
            // nonlocalized: an acceptance directory name, never displayed
            let root = documents
                .appendingPathComponent("uitest-inbox-receive", isDirectory: true)
                .appendingPathComponent(launchID, isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            return root
        }
        let store = ContainerInboxFolderStore(base: InMemoryInboxFolderStore())
        let folder = InboxReceiveFolder(
            store: store, bookmarking: ContainerInboxFolderBookmarking(directory: receiveDirectory))
        // Written through the product's own setter, so the fixture cannot start
        // in a state the app itself is unable to reach.
        try? folder.setReceivePolicy(mode == .ask ? .ask : .auto, account: account)

        let transport = UITestInboxTransport(mode: mode)
        return InboxController(runtime: InboxRuntime(
            folder: folder,
            makeEngine: { account, _ in
                InboxReceiveEngine(transport: transport, keys: keys, journals: journals,
                                   messages: messages, folder: folder, account: account)
            },
            notifier: nil,
            messageStore: { _ in messages },
            conversationStore: { _ in conversations },
            // The production sleeper with a stretched schedule: a real wait keeps
            // the main actor free for the UI under test, and an hour between
            // automatic passes means nothing below can be explained by the loop's
            // own timer rather than by the press being tested.
            sleeper: InboxTaskSleeper(),
            platform: AppEnvironment.iosInboxPlatform,
            capabilities: InboxProtocol.announcedCapabilities(presentingText: true),
            appVersion: "uitest",  // nonlocalized: a build label, never displayed
            backoff: InboxBackoff(idle: 3600, afterWork: 3600, first: 1, cap: 2,
                                  blocked: 3600)))
    }

    /// A directory of this launch's own under Application Support — never
    /// `temporaryDirectory` or `cachesDirectory`, which the system may purge: a
    /// journal is what stops a delivery being written twice.
    private static func supportDirectory(_ name: String) -> URL? {
        guard let support = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true) else { return nil }
        let directory = support
            .appendingPathComponent(name, isDirectory: true)
            .appendingPathComponent(launchID, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory,
                                                    withIntermediateDirectories: true)
            return directory
        } catch {
            return nil
        }
    }
}

/// Central, answered in process.
///
/// Registers whatever key the launch generated, so the delivery below is sealed
/// to this device's real key and decrypted by the real engine.
private final class UITestInboxTransport: InboxTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let mode: UITestInbox.Mode
    private var publicKey = ""
    private var ciphertext = Data()
    private var delivered = false
    /// How many pending reads have been answered. The first is the automatic
    /// pass at launch; every later one is a check the test pressed for.
    private var pendingReads = 0
    private var askAnswers: [String: Bool] = [:]

    init(mode: UITestInbox.Mode) { self.mode = mode }

    // nonlocalized: acceptance fixture identifiers, never displayed
    private static let deviceID = "dev_this"
    private static let taskID = "task_uitest"
    private static let keyID = "key_uitest"
    /// Three distinctly named, distinctly sized files, so the conversation can
    /// show that rows are told apart by what was written.
    // nonlocalized: acceptance fixture file names
    private static let fileNames = ["brief.txt", "notes.md", "diagram.svg"]

    /// The two deliveries the ask launch holds for an answer. Different sizes,
    /// so the rows can be told apart without a name.
    // nonlocalized: acceptance fixture identifiers, never displayed
    private static let askTasks = [
        InboxTask(id: "task_ask_one", sourceDeviceID: UITestInbox.senderDeviceID,
                  state: .attentionRequired, ciphertextBytes: 1_024, expiresAt: 4_102_444_800),
        InboxTask(id: "task_ask_two", sourceDeviceID: UITestInbox.senderDeviceID,
                  state: .attentionRequired, ciphertextBytes: 8_192, expiresAt: 4_102_444_800),
    ]

    @discardableResult
    private func sync<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }

    /// Central holds the check delivery only from the SECOND check on — the
    /// launch pass is read one, the first check read two — so the first check is
    /// genuinely empty rather than racing the delivery.
    private var offersDelivery: Bool {
        mode == .check && sync { pendingReads } >= 3
    }

    func currentDevice() async throws -> InboxDeviceRow {
        InboxDeviceRow(id: Self.deviceID, isCurrent: true)
    }

    func enrol(_ request: InboxEnrolRequest) async throws -> InboxEnrolResult {
        InboxEnrolResult(inbox: InboxView(presence: .online, autoAccept: request.autoAccept,
                                          receiveDirReady: request.receiveDirReady,
                                          canReceive: true, key: registeredKey()),
                         protocolVersion: InboxProtocol.versions[0],
                         receiveCapability: InboxCapability.receiveV3,
                         keyAlgorithm: InboxProtocol.keyAlgorithm)
    }

    private func registeredKey() -> InboxKey? {
        let encoded = sync { publicKey }
        guard !encoded.isEmpty else { return nil }
        return InboxKey(id: Self.keyID, algorithm: InboxProtocol.keyAlgorithm,
                        publicKey: encoded, generation: 1, createdAt: 0,
                        supersededAt: 0, revokedAt: 0)
    }

    func registerKey(algorithm: String, publicKey key: String,
                     previousKeyID: String?) async throws -> InboxKey {
        sync { publicKey = key }
        return InboxKey(id: Self.keyID, algorithm: algorithm, publicKey: key,
                        generation: 1, createdAt: 0, supersededAt: 0, revokedAt: 0)
    }

    func listKeys() async throws -> [InboxKey] { registeredKey().map { [$0] } ?? [] }

    @discardableResult
    func heartbeat(receiveDirReady: Bool) async throws -> InboxHeartbeatResult {
        InboxHeartbeatResult(presence: .online)
    }

    func goOffline() async throws {}

    func pending(limit: Int) async throws -> [InboxTask] {
        let read = sync { () -> Int in pendingReads += 1; return pendingReads }
        // Every pass after the launch pass is one the user asked for, held long
        // enough that Checking… — and the disabled control — can be observed.
        // Four seconds rather than the Mac fixture's 1.5: every XCUITest query
        // on the iOS simulator costs about a second, and a measured run saw the
        // shorter pass finish between the disabled read and the label read.
        if read > 1 { try await Task.sleep(nanoseconds: 4_000_000_000) }
        if mode == .ask {
            let answered = sync { askAnswers }
            return Self.askTasks.filter { answered[$0.id] == nil }
        }
        guard offersDelivery, !sync({ delivered }) else { return [] }
        return [InboxTask(id: Self.taskID, sourceDeviceID: UITestInbox.senderDeviceID,
                          state: .queued)]
    }

    func claim(max: Int) async throws -> (deliveries: [InboxDelivery], leaseSeconds: Int) {
        guard offersDelivery, !sync({ delivered }),
              let encoded = sync({ publicKey.isEmpty ? nil : publicKey }),
              let recipient = try? InboxKeyMaterial.decode(encoded,
                                                          expecting: InboxProtocol.publicKeyBytes)
        else { return (deliveries: [], leaseSeconds: 300) }

        // Built with the PRODUCTION encryptors from a fresh content key sealed to
        // the key this device just published, so a drift in the frame format,
        // the manifest or the sealed box fails this launch loudly.
        let files = Self.fileNames.enumerated().map { index, _ in
            [UInt8](repeating: 0x52, count: 2_048 * (index + 1))
        }
        let contentKey = generateStoreKey()
        guard let manifest = try? InboxManifest.files(zip(Self.fileNames, files).map {
                  (name: $0, size: $1.count)
              }),
              let encodedManifest = try? InboxManifest.encode(manifest),
              let sealed = sodium.box.seal(message: contentKey, recipientPublicKey: recipient)
        else { return (deliveries: [], leaseSeconds: 300) }
        let encManifest = seal(key: contentKey, seq: 0, plaintext: encodedManifest)
        let body = Data(encryptChunks(key: contentKey, files: files))
        sync { ciphertext = body }

        let task = InboxTask(id: Self.taskID, sourceDeviceID: UITestInbox.senderDeviceID,
                             storedFileID: "obj_uitest",  // nonlocalized: fixture id
                             state: .downloading, ciphertextBytes: Int64(body.count),
                             targetKeyID: Self.keyID)
        let delivery = InboxDelivery(task: task,
                                     encManifest: Data(encManifest).base64EncodedString(),
                                     wrappedKey: InboxKeyMaterial.encode(sealed),
                                     claimToken: "claim_uitest")  // nonlocalized: fixture token
        return (deliveries: [delivery], leaseSeconds: 300)
    }

    func blob(taskID: String, claimToken: String, offset: Int64) async throws -> InboxBlobStream {
        let stream = BoundedDataStream()
        stream.yield(sync { ciphertext })
        stream.finish()
        return InboxBlobStream(status: 200, isPartial: false, chunks: stream)
    }

    @discardableResult
    func report(taskID: String, claimToken: String, state: InboxTaskState,
                errorCode: InboxDeviceErrorCode, committed: Bool) async throws -> InboxTask {
        if state == .saved { sync { delivered = true } }
        return InboxTask(id: taskID, state: state, errorCode: .device(errorCode))
    }

    /// Central's own rule: only a task still held for an answer can be answered,
    /// once. The Check now test never calls this — which is the point it proves.
    @discardableResult
    func accept(taskID: String, accept: Bool) async throws -> InboxTask {
        let recorded = sync { () -> Bool in
            guard Self.askTasks.contains(where: { $0.id == taskID }),
                  askAnswers[taskID] == nil else { return false }
            askAnswers[taskID] = accept
            return true
        }
        // nonlocalized: central's wire error token
        guard recorded else { throw InboxError.api(status: 409, code: "invalid_transition") }
        return accept
            ? InboxTask(id: taskID, state: .queued)
            : InboxTask(id: taskID, state: .failedTerminal, errorCode: .device(.userDeclined))
    }

    func clearInbox() async throws {}
}
#endif
