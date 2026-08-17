import Combine
import Foundation
import RelayiumAppKit
import RelayiumKit

/// **The two halves of a Device Inbox delivery, each assembled exactly as the
/// macOS app assembles its own.**
///
/// ## What these exist to prove
///
/// The Device Inbox shipped on macOS with only its receiving half wired to a
/// surface: a Mac could take a delivery a browser started and could not start
/// one itself. Adding `DeviceSendSection` fixes the surface; these two hosts are
/// what turn that into evidence, by running the sender and the receiver as two
/// SEPARATE PROCESSES against a real server and comparing the names, sizes and
/// SHA-256 digests of what one handed over with what the other wrote to disk.
///
/// Both are built through `AppEnvironment`, from the same factories
/// `RelayiumApp` calls, for the reason the other hosts in this module are: a
/// peer that assembled its own approximation would be evidence about this file.
/// What differs from the app is only what a headless process cannot have — a
/// keychain-backed folder bookmark store becomes the in-memory one, and the
/// account arrives as a bearer the launcher minted rather than through a sign-in
/// form.
///
/// ## Two device rows, not one
///
/// A delivery is sealed to ONE device's current public key, and
/// `InboxSendCandidate.candidates(from:)` removes the sending device from its own
/// target list. So a run needs two device rows on one account, which is what two
/// `POST /api/auth/native/login` calls with different `deviceName`s produce. A
/// single shared bearer would authenticate as one row, and the sender would
/// correctly report that this account has nobody to send to.

// MARK: - the receiving Mac

/// A resident Device Inbox receiver: the real `InboxController`, the real
/// engine, the real journal, writing into a directory the run owns.
@MainActor
public final class AppInboxReceiverHost {
    private let controller: InboxController
    private let session: AccountSession
    private let bridge: InboxSessionBridge
    private let receiveRoot: URL
    private let folderStore = InMemoryInboxFolderStore()

    /// - Parameters:
    ///   - receiveRoot: this run's own directory. Never Downloads: an acceptance
    ///     receiver that wrote into the machine's real receive folder would mix
    ///     its files with the owner's.
    ///   - journalRoot: also the run's own, so a delivery this run journals
    ///     cannot be mistaken for a durable one belonging to the installed app.
    public init(origin: URL, bearer: String, receiveRoot: URL, journalRoot: URL) throws {
        self.receiveRoot = receiveRoot
        try FileManager.default.createDirectory(at: receiveRoot,
                                                withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: journalRoot,
                                                withIntermediateDirectories: true)

        let folder = InboxReceiveFolder(store: folderStore)
        let keys = InMemoryInboxDeviceKeyStore()
        let makeEngine = AppEnvironment.makeInboxEngineFactory(
            baseURL: origin, keys: keys,
            journalStore: { account in
                InboxJournalStore(directory: journalRoot
                    .appendingPathComponent(account.value, isDirectory: true))
            },
            // Under the run's own journal root for the same reason the journals
            // are: a message this acceptance peer receives must not land in the
            // installed app's store, where it would look like the owner's own.
            messageStore: { account in
                InboxMessageStore(directory: journalRoot
                    .appendingPathComponent(account.value, isDirectory: true)
                    .appendingPathComponent("messages", isDirectory: true))
            },
            folderStore: folderStore)
        controller = InboxController(runtime: InboxRuntime(
            folder: folder, makeEngine: makeEngine,
            messageStore: { account in
                InboxMessageStore(directory: journalRoot
                    .appendingPathComponent(account.value, isDirectory: true)
                    .appendingPathComponent("messages", isDirectory: true))
            },
            // No notifier and no reveal: a headless peer has no notification
            // centre and must never hand a received path to the Finder. The
            // defaults are the honest ones — `openNotificationSettings` reports
            // that it could not.
            platform: AppEnvironment.inboxPlatform, appVersion: "acceptance"))

        // The credential reaches the session the way the app's does — through a
        // token store `restore()` reads — so the account state this receiver
        // adopts is produced by the shipped `AccountSession`, not written here.
        let store = InMemoryTokenStore()
        try store.save(bearer)
        session = AppEnvironment.makeSession(baseURL: origin, tokenStore: store)
        bridge = InboxSessionBridge(controller: controller)
        bridge.observe(session.$state, bearer: { [session] in session.bearerToken })
    }

    /// Adopt the account, grant the folder, and switch unattended receiving on —
    /// in that order, and each step WAITED FOR rather than assumed.
    ///
    /// **The waiting is the correctness.** Both `chooseFolder` and `setPolicy`
    /// are account-scoped and begin `guard let generation else { return }`, so a
    /// grant issued before the session has been adopted is silently discarded —
    /// which is exactly what the first run of this host did: it reported a
    /// receiver that was signed in, had no folder, and sat in `disabled` while a
    /// sender two hundred lines away was told there was nobody to send to. The
    /// product has the same ordering and cannot hit it, because a person cannot
    /// press Choose folder before the surface has rendered.
    ///
    /// Both refusals are surfaced rather than swallowed: `settingsError` is what
    /// the pane renders, and an acceptance receiver that ignored it would report
    /// a silent misconfiguration as a delivery failure.
    public func start() async -> String? {
        await session.restore()
        guard await waitFor({ [controller] in controller.isSignedIn }) else {
            return "the receiver never adopted the account: \(session.state)"
        }
        controller.chooseFolder(receiveRoot)
        if let problem = controller.settingsError {
            return "the receive folder was refused: \(problem)"
        }
        guard await waitFor({ [controller] in controller.folder.isChosen }) else {
            return "the receive folder was not recorded"
        }
        controller.setPolicy(.auto)
        if let problem = controller.settingsError {
            return "unattended receiving was refused: \(problem)"
        }
        guard await waitFor({ [controller] in controller.policy == .auto }) else {
            return "unattended receiving was not recorded"
        }
        return nil
    }

    /// Poll a main-actor condition with a real ceiling.
    ///
    /// A ceiling rather than an unbounded wait, because every caller above turns
    /// a timeout into a NAMED failure — and an acceptance receiver that hung
    /// would be reported by the launcher as a delivery that never arrived, which
    /// is the wrong diagnosis for a receiver that never started.
    private func waitFor(_ condition: @escaping () -> Bool,
                         seconds: TimeInterval = 30) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return condition()
    }

    public var state: InboxRuntimeState { controller.state }
    /// The grant this receiver is actually holding, as the pane would report it.
    public var folderIsUsable: Bool { controller.folder.isChosen }
    public var policy: InboxAutoAccept { controller.policy }
    public var settingsError: String? { controller.settingsError.map { String(describing: $0) } }
    public var isSignedIn: Bool { controller.isSignedIn }

    /// Every file this receiver has actually written, read back OFF DISK.
    ///
    /// Off disk rather than out of the receipt list, and that is the whole
    /// point: a receiver that recorded a delivery it never committed would
    /// produce a perfect receipt list. What is compared at the end is what a
    /// person opening the folder would find.
    public func receipts() -> [FileReceipt] {
        guard let files = FileManager.default.enumerator(
            at: receiveRoot, includingPropertiesForKeys: [.isRegularFileKey]) else { return [] }
        var out: [FileReceipt] = []
        for case let url as URL in files {
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]))?
                .isRegularFile == true else { continue }
            guard let digest = sha256Hex(contentsOf: url),
                  let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize
            else { continue }
            out.append(FileReceipt(name: url.lastPathComponent,
                                   path: relativePath(of: url),
                                   size: size, sha256: digest))
        }
        return out.sorted { $0.name < $1.name }
    }

    /// The path under the receive root, or nil for a file that landed loose.
    ///
    /// A delivery's manifest can carry nested paths, and a receiver that
    /// flattened a tree would otherwise produce receipts a name-and-digest
    /// comparison accepts.
    private func relativePath(of url: URL) -> String? {
        let root = receiveRoot.standardizedFileURL.path
        let path = url.standardizedFileURL.path
        guard path.hasPrefix(root + "/") else { return nil }
        let relative = String(path.dropFirst(root.count + 1))
        return relative.contains("/") ? relative : nil
    }

    public func teardown() {
        controller.signedOut()
    }
}

// MARK: - the sending Mac

/// The macOS Device Inbox sender, assembled from the same factory the app uses.
@MainActor
public final class AppInboxSenderHost {
    private let deliveries: InboxSendModel
    private let session: AccountSession
    private let stagingRoot: URL

    public init(origin: URL, bearer: String, stagingRoot: URL) throws {
        self.stagingRoot = stagingRoot
        try FileManager.default.createDirectory(at: stagingRoot,
                                                withIntermediateDirectories: true)
        // `drafts: nil`, exactly as `RelayiumApp` passes it: a draft store is the
        // authority to delete another process's only copy of a file, and nothing
        // here can have come from one.
        //
        // **The content-key store is in memory, and that is a property of this
        // PROCESS rather than a shortcut.** The shipped store is a keychain item
        // in `7PVYUG4YQS.com.relayium.shared`, and an access group is an
        // entitlement — a peer binary that is not signed into that group cannot
        // write there, which the first run of this host reported honestly as
        // `keyStorageFailed` before a single byte moved. Substituting the store
        // keeps every other thing on the path production: the same
        // `PendingUploadStore.prepare`, the same generated content key, the same
        // seal to the target's public key, the same upload and the same create.
        // What it does NOT do is outlive the process, which is exactly right for
        // an acceptance run and exactly wrong for the app.
        deliveries = AppEnvironment.makeInboxSendModel(
            baseURL: origin,
            pending: PendingUploadSupport(store: PendingUploadStore(root: stagingRoot),
                                          keys: InMemoryStoredLinkKeyStore()))
        let store = InMemoryTokenStore()
        try store.save(bearer)
        session = AppEnvironment.makeSession(baseURL: origin, tokenStore: store)
        deliveries.observe(session.$state)
    }

    /// Restore the account and read its device list.
    public func start() async {
        await session.restore()
        refreshTargets()
    }

    /// Read the account's devices again.
    ///
    /// Explicit, and polled by the caller rather than by a timer inside the
    /// model, because the receiving Mac enrols asynchronously: a device that has
    /// not published a key yet is correctly reported as unable to receive, and
    /// the honest way to wait for it is to ask again.
    public func refreshTargets() {
        deliveries.refreshTargets(token: session.bearerToken ?? "")
    }

    public var directory: InboxSendDirectory { deliveries.directory }
    public var targetNames: [String] { deliveries.candidates.map(\.name) }
    public var sendableTargetNames: [String] {
        deliveries.candidates.filter(\.isSendable).map(\.name)
    }
    public var items: [InboxSendItem] { deliveries.items }
    public var refusal: InboxSendRefusal? { deliveries.refusal }

    /// The one device this run means, chosen by the name its login gave it.
    ///
    /// By name rather than "the only other row", because a machine that has run
    /// this suite before may carry rows from earlier runs on the same account —
    /// and a target picked by position would then address one of those.
    @discardableResult
    public func selectTarget(named name: String) -> Bool {
        guard let candidate = deliveries.candidates.first(where: { $0.name == name }),
              candidate.isSendable else { return false }
        deliveries.selectTarget(candidate.id)
        return deliveries.selectedTargetID == candidate.id
    }

    /// Stage the batch on disk and hand it to the model's own send path.
    ///
    /// The files are written into this run's own directory first, because a
    /// device send reads real files: `PendingUploadStore.prepare` copies them
    /// into the app's staging root, and a fabricated in-memory selection would
    /// be a send this model has never actually been asked to perform.
    public func send(batch: [(meta: FileMeta, bytes: [UInt8])]) throws {
        let source = stagingRoot.appendingPathComponent("outgoing", isDirectory: true)
        var selected: [SelectedFile] = []
        for entry in batch {
            let relative = entry.meta.path ?? entry.meta.name
            let url = source.appendingPathComponent(relative)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try Data(entry.bytes).write(to: url)
            selected.append(SelectedFile(url: url, relativePath: relative,
                                         byteCount: Int64(entry.bytes.count)))
        }
        deliveries.send(files: selected, sourceDraftId: nil,
                        token: session.bearerToken ?? "")
    }

    /// What the one send is doing, in the sentence the product would render.
    public var activity: InboxSendActivity? { deliveries.items.first?.activity }

    /// Whether the delivery has reached the state that means the OTHER device
    /// has written the files. `saved` and nothing weaker: `notified` and
    /// `downloading` are the states a receiver has been told about, not ones it
    /// has committed.
    public var isSaved: Bool {
        guard case .tracking(let state)? = activity else { return false }
        return state == .saved
    }

    /// A delivery that can never reach `saved`, with the reason.
    public var terminalFailure: String? {
        switch activity {
        case .stopped(let failure)?:
            return String(describing: failure)
        case .tracking(let state)? where state.isTerminal && state != .saved:
            return String(describing: state)
        case .unknown?:
            return "unknown"
        default:
            return nil
        }
    }

    public func teardown() {}
}
