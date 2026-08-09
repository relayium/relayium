import Foundation
import CryptoKit
@preconcurrency import RelayiumKit

/// The account this Mac is receiving for, and the credential it is doing it with.
///
/// Both together, because either one changing is a different device as far as the
/// inbox is concerned: the keys, the folder grant and the policy are account-
/// scoped, and the claim/lease/report calls are bearer-scoped. A generation keyed
/// on only one of them would let a re-issued credential go on working under a
/// claim the old one took, or let a second account inherit the first's pass.
public struct InboxAccountIdentity: Equatable, Sendable {
    public let accountID: String
    /// Held privately for as long as one generation lives and dropped with it.
    /// It is never published, never logged, never part of a rendered value, and
    /// never written anywhere that outlives the process.
    public let bearer: String

    public init(accountID: String, bearer: String) {
        self.accountID = accountID
        self.bearer = bearer
    }
}

/// A held delivery rendered without decrypting or exposing its manifest.
///
/// The task id remains the response handle, while size and expiry give multiple
/// rows stable, non-content-bearing differences a person can use when deciding.
public struct InboxAskItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let ciphertextBytes: Int64
    public let expiresAt: Int64

    public init(id: String, ciphertextBytes: Int64, expiresAt: Int64) {
        self.id = id
        self.ciphertextBytes = ciphertextBytes
        self.expiresAt = expiresAt
    }
}

/// One run of the receive loop, and the thing every asynchronous result is
/// checked against before it may touch published state.
///
/// `credential` is a one-way DIGEST, not the bearer. The controller has to be able
/// to notice that the credential changed; it does not have to be able to
/// reproduce it, and this value ends up inside an `Equatable` struct that a test
/// or a debugger will print. SHA-256, truncated: an identity comparison, not
/// authentication.
public struct InboxGeneration: Equatable, Sendable {
    public let account: InboxAccountID
    public let credential: String
    public let sequence: Int

    public static func digest(of bearer: String) -> String {
        SHA256.hash(data: Data(bearer.utf8)).prefix(8)
            .map { String(format: "%02x", $0) }.joined()  // nonlocalized: a hex digest
    }
}

/// Something the user's own action could not do. Closed, and separate from
/// `InboxRuntimeState`: a refused folder choice does not change what the inbox IS,
/// it is feedback on one button press.
public enum InboxSettingsError: String, Equatable, Sendable, CaseIterable {
    /// The chosen directory failed its create-and-remove probe, so it was not
    /// stored as a grant.
    case folderNotWritable
    /// macOS would not produce security-scoped bookmark data for it.
    case folderBookmarkFailed
    /// Receiving was switched on with no folder chosen.
    case noFolderChosen
    /// The accept/decline could not be delivered to central.
    case askResponseFailed
    /// macOS would not open its own notification settings for this app.
    ///
    /// Here for the reason the whole batch exists: the alternative is a button
    /// that does nothing when pressed, which is indistinguishable from a broken
    /// product and leaves the user with no idea where to go instead.
    case notificationSettingsUnavailable
}

/// What a folder chooser and a status line need to say about the grant.
public struct InboxFolderSummary: Equatable, Sendable {
    /// The chosen directory, when one resolved. `nil` both when none was ever
    /// chosen and when the stored grant will not resolve — the two are told apart
    /// by `isChosen`, never by this being empty.
    public let url: URL?
    /// Whether a grant is stored at all.
    public let isChosen: Bool
    /// Why it is not usable right now, when it is not.
    public let problem: InboxFolderProblem?

    public static let none = InboxFolderSummary(url: nil, isChosen: false, problem: nil)

    public init(url: URL?, isChosen: Bool, problem: InboxFolderProblem?) {
        self.url = url
        self.isChosen = isChosen
        self.problem = problem
    }

    init(state: InboxFolderState, isChosen: Bool) {
        switch state {
        case .absent:
            self.init(url: nil, isChosen: isChosen, problem: nil)
        case .usable(let url):
            self.init(url: url, isChosen: true, problem: nil)
        case .unavailable(let problem):
            self.init(url: nil, isChosen: isChosen, problem: problem)
        }
    }
}

/// Everything the controller reaches outside itself.
///
/// A struct of seams rather than concrete types, and every one of them is here
/// because the behaviour behind it decides whether a user's file is lost, written
/// twice, or reported as saved when it is not. The rule the Phase 2A review
/// recorded applies to the scheduler too: a branch with no seam is a branch whose
/// first execution is in production.
public struct InboxRuntime: Sendable {
    /// The grant and the policy. Read live rather than cached: Settings writes
    /// through the same object, so a change is visible to the next pass without
    /// a notification mechanism that could be missed.
    public var folder: InboxReceiveFolder
    /// Builds the engine for one identity. `async` and `throws` because the real
    /// one asks central which device row this credential authenticates as, and
    /// there is no honest local answer to that.
    public var makeEngine: @Sendable (InboxAccountID, String) async throws -> InboxReceiveEngine
    public var notifier: InboxNotifying?
    public var sleeper: InboxSleeping
    /// Show these paths in Finder. A seam so a test can prove that ONLY paths
    /// from a completed receipt ever reach it.
    public var reveal: @Sendable ([URL]) -> Void
    /// Ask the platform what its notification authorization currently is. The
    /// answer comes back asynchronously through
    /// `InboxController.updateNotificationPermission`, because
    /// `UNUserNotificationCenter` answers on its own queue.
    public var refreshNotificationPermission: @Sendable () -> Void
    /// Open this app's own row in the system's notification settings, returning
    /// whether the platform accepted it.
    ///
    /// **It takes nothing.** That is the security property, not an accident of
    /// convenience: a seam with no parameter is a seam no received file name,
    /// destination path or task id can be passed into, so the ban
    /// `InboxSurfaceGuardTests` places on launching received content cannot be
    /// evaded through this door. The URL it opens is a compile-time constant at
    /// the one call site that implements it.
    public var openNotificationSettings: @Sendable () -> Bool
    public var platform: String
    public var appVersion: String
    public var backoff: InboxBackoff
    /// How many completed receipts are kept for the Settings result list. Bounded
    /// because it holds local file URLs, which describe the user's own content.
    public var resultLimit: Int

    public init(folder: InboxReceiveFolder,
                makeEngine: @escaping @Sendable (InboxAccountID, String) async throws
                    -> InboxReceiveEngine,
                notifier: InboxNotifying? = nil,
                sleeper: InboxSleeping = InboxTaskSleeper(),
                reveal: @escaping @Sendable ([URL]) -> Void = { _ in },
                refreshNotificationPermission: @escaping @Sendable () -> Void = {},
                openNotificationSettings: @escaping @Sendable () -> Bool = { false },
                platform: String, appVersion: String,
                backoff: InboxBackoff = InboxBackoff(),
                resultLimit: Int = 10) {
        self.folder = folder
        self.makeEngine = makeEngine
        self.notifier = notifier
        self.sleeper = sleeper
        self.reveal = reveal
        self.refreshNotificationPermission = refreshNotificationPermission
        self.openNotificationSettings = openNotificationSettings
        self.platform = platform
        self.appVersion = appVersion
        self.backoff = backoff
        self.resultLimit = resultLimit
    }
}

/// What one pass produced, collected where the pass itself runs.
///
/// A lock-guarded box rather than main-actor hops from inside the engine's
/// callbacks. The difference is not style: a hop is a separate scheduling event,
/// so a receipt published that way can land AFTER the controller has already
/// decided what the pass meant — and the state the user sees would then be the
/// one from before their file arrived. Read synchronously once the pass returns,
/// there is exactly one ordering.
final class InboxPassRecord: @unchecked Sendable {
    private let lock = NSLock()
    private var _receipts: [InboxReceipt] = []
    private var _pending: [InboxTask] = []
    private var _sawPending = false
    private var _blocker: InboxDeviceErrorCode?

    var receipts: [InboxReceipt] { sync { _receipts } }
    var pending: [InboxTask] { sync { _pending } }
    var sawPending: Bool { sync { _sawPending } }
    var blocker: InboxDeviceErrorCode? { sync { _blocker } }

    func add(_ receipt: InboxReceipt) { sync { _receipts.append(receipt) } }
    func observe(pending: [InboxTask]) { sync { _pending = pending; _sawPending = true } }
    func block(_ code: InboxDeviceErrorCode) { sync { _blocker = code } }

    /// Non-`async` on purpose: taking an `NSLock` directly inside an `async`
    /// function is an error under the Swift 6 language mode.
    @discardableResult
    private func sync<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }
}

/// The resident Device Inbox: one scheduler, one pass at a time, one truthful
/// state.
///
/// ## Why this is an app-scoped object and not a view's `.task`
///
/// The whole product claim is that a Mac with its window closed still receives.
/// `applicationShouldTerminateAfterLastWindowClosed` is false here and the
/// `MenuBarExtra` keeps the process up, so "no window" is an ordinary running
/// state — and a loop owned by a view is a loop that stops the moment the user
/// closes the window they started it from. It must not be owned by the Settings
/// scene either, which is opened and closed independently of everything else.
///
/// ## The generation, and why it is the security boundary
///
/// Every asynchronous result — a completed pass, a receipt, a log event — is
/// checked against the generation that started it before it may touch published
/// state. A pass held open across a sign-out and a sign-in for another account
/// WILL eventually return, and without this check it would append account A's
/// receipt to account B's result list, raise a notification under B's session and
/// set B's status from A's work. The check is the only thing standing between
/// those two accounts; removing it is what `InboxControllerTests` mutation-checks.
///
/// ## What it deliberately does not own
///
/// The crypto, the lease, the journal, the collision rules and the filesystem.
/// All of that is `InboxReceiveEngine` and the types beneath it, which were
/// accepted separately. Nothing here re-derives "saved": the only source of a
/// saved claim is `InboxReceipt`, and the only source of a receipt is a journal
/// the commit itself wrote.
@MainActor
public final class InboxController: ObservableObject {

    // MARK: - published surface

    /// The single closed state every surface renders. Never `ready` by default
    /// and never `ready` by fall-through.
    @Published public private(set) var state: InboxRuntimeState = .signedOut
    /// The user's own answer, mirrored for the settings control.
    @Published public private(set) var policy: InboxAutoAccept = .off
    @Published public private(set) var folder: InboxFolderSummary = .none
    /// Completed deliveries, newest first, bounded.
    @Published public private(set) var results: [InboxReceipt] = []
    /// Tasks central is holding for an answer under `ask`. No names: the manifest
    /// is not decrypted until a task is claimed. Bounded ciphertext size and
    /// expiry remain available so two questions do not render as identical rows.
    @Published public private(set) var asking: [InboxAskItem] = []
    /// The last refusal of a user action, cleared by the next one.
    @Published public private(set) var settingsError: InboxSettingsError?
    /// Whether the user paused. Sticky across passes and across the window being
    /// closed; cleared only by an explicit resume.
    @Published public private(set) var isPaused = false
    /// Whether macOS will show a banner when a delivery lands.
    ///
    /// Deliberately NOT part of `state`: a denied Mac receives, decrypts and
    /// commits exactly as before, so folding this into the runtime state would
    /// make the status line report a broken inbox that is in fact working. It is
    /// also not account-scoped — see `reset()`, which leaves it alone on purpose.
    @Published public private(set) var notificationPermission: InboxNotificationPermission
        = .unmeasured

    // MARK: - private state

    private let runtime: InboxRuntime
    private let ledger = InboxNotificationLedger()
    /// The live credential. Private, and dropped by `signedOut`.
    private var identity: InboxAccountIdentity?
    private var generation: InboxGeneration?
    private var sequence = 0
    private var loop: Task<Void, Never>?
    /// Identity of the cached engine, so a policy change does not pay for another
    /// `currentDevice()` round trip while a sign-out does.
    private var engineIdentity: String?
    private var engine: InboxReceiveEngine?
    /// Invalidated the instant a pass returns, so a callback that hops in late
    /// cannot overwrite the state the completed pass just established.
    private var passToken = 0
    public init(runtime: InboxRuntime) {
        self.runtime = runtime
    }

    // MARK: - session

    /// The one entry point for who is signed in.
    ///
    /// Idempotent for an unchanged identity, which matters because the app calls
    /// it from a session publisher that republishes for unrelated reasons — a
    /// usage refresh, a plan change — and restarting the loop on each of those
    /// would cancel a delivery in progress every time the account screen
    /// refreshed.
    public func session(_ identity: InboxAccountIdentity?) {
        guard let identity else { return signedOut() }
        guard let account = try? InboxAccountID(identity.accountID) else {
            // An account id this build will not use as a keychain item name or a
            // defaults key. Fails closed rather than proceeding under a sanitized
            // guess at who the user is.
            stopLoop()
            self.identity = nil
            generation = nil
            reset()
            state = .failed(.identity)
            return
        }
        let credential = InboxGeneration.digest(of: identity.bearer)
        if let current = generation, current.account == account,
           current.credential == credential {
            return
        }
        self.identity = identity
        start(account: account, credential: credential, bearer: identity.bearer, reset: true)
    }

    /// No account. Everything account-scoped is dropped from view state; nothing
    /// PERSISTED is touched, because the folder grant, the policy and the key
    /// history belong to the account that made them and a returning user expects
    /// them back.
    public func signedOut() {
        stopLoop()
        identity = nil
        generation = nil
        engine = nil
        engineIdentity = nil
        reset()
        state = .signedOut
    }

    /// Start a generation.
    ///
    /// `reset` separates the two callers. A different account or credential
    /// arrives with `true` and inherits nothing — not a result list, not a pause,
    /// not a notification memory. A restart under the SAME identity arrives with
    /// `false`: the user changing their policy has not undone the deliveries they
    /// already received, and has not resumed a pause they took deliberately.
    private func start(account: InboxAccountID, credential: String, bearer: String,
                       reset shouldReset: Bool) {
        // The loop being replaced, awaited by the new one before it runs.
        //
        // Cancelling is not enough on its own. A cancelled pass is still IN
        // FLIGHT: it may be mid-download, or between the `linkat` and the journal
        // write, and `InboxReceiver` is explicitly documented as the only thing
        // touching the receive directory at a time. Starting the next loop
        // immediately would put two passes into that directory at once and could
        // claim two tasks against one lease budget. So the new generation waits
        // for the old one to drain — its own generation guard makes it return
        // promptly — and until then the published state is already the new one,
        // so nothing about this is visible as a delay in the UI.
        let draining = loop
        stopLoop()
        if shouldReset { reset() }
        sequence += 1
        let generation = InboxGeneration(account: account, credential: credential,
                                         sequence: sequence)
        self.generation = generation
        // A new identity gets a new engine; a restart under the same identity
        // reuses the one already built.
        let engineKey = account.value + ":" + credential
        if engineIdentity != engineKey {
            engine = nil
            engineIdentity = engineKey
        }
        policy = runtime.folder.receivePolicy(account: account)
        refreshFolder()
        state = isPaused ? .paused : .loading
        loop = Task { [weak self] in
            await draining?.value
            await self?.run(generation, bearer: bearer)
        }
    }

    /// Restart under the same identity, invalidating any pass in flight.
    ///
    /// Used by every explicit change that makes a running pass obsolete: the
    /// policy, the folder, and the user's own Try again. It bumps the generation
    /// rather than merely waking the sleeper, because the pass that is running was
    /// started under the OLD answer — a delivery claimed while the policy said
    /// `auto` must not be allowed to finish writing after the user has said Off.
    private func restart() {
        guard let generation, let identity else { return }
        start(account: generation.account, credential: generation.credential,
              bearer: identity.bearer, reset: false)
    }

    private func reset() {
        results = []
        asking = []
        settingsError = nil
        isPaused = false
        folder = .none
        policy = .off
        ledger.reset()
        passToken += 1
        // `notificationPermission` is deliberately absent. Everything cleared
        // above belongs to ONE account — its receipts, its questions, its grant,
        // its answer. Notification authorization belongs to the app and to this
        // Mac: signing out, switching account or restarting the loop does not
        // change what macOS will do with a banner, and clearing it here would
        // blank a true warning at the exact moment a new generation starts.
    }

    private func stopLoop() {
        loop?.cancel()
        loop = nil
        runtime.sleeper.wake()
        passToken += 1
    }

    private func isCurrent(_ generation: InboxGeneration) -> Bool {
        self.generation == generation
    }

    // MARK: - the loop

    private func run(_ generation: InboxGeneration, bearer: String) async {
        var failures = 0
        var prepared = false

        while isCurrent(generation), !Task.isCancelled {
            if isPaused {
                publish(.paused, for: generation)
                await nap(runtime.backoff.idle, generation)
                continue
            }
            let policy = runtime.folder.receivePolicy(account: generation.account)
            self.policy = policy
            guard policy != .off else {
                // Off is announced, once, rather than simply going quiet. Central
                // keeps the last policy it was told, so a Mac that stopped
                // polling without saying so would still be offered to senders as
                // a target and would collect tasks nobody was ever going to work.
                // Best-effort and retried on the next tick: failing to reach
                // central is not a reason to spin, and the local answer is
                // already Off either way.
                if runtime.folder.stopAnnouncementPending(account: generation.account) {
                    do {
                        let engine = try await resolveEngine(generation, bearer: bearer)
                        guard isCurrent(generation) else { return }
                        try await engine.announceStopped(platform: runtime.platform,
                                                         appVersion: runtime.appVersion)
                        guard isCurrent(generation) else { return }
                        runtime.folder.setStopAnnouncementPending(false,
                                                                  account: generation.account)
                    } catch {
                        // Kept pending and retried on the next tick. The local
                        // answer is already Off either way, so an unreachable
                        // central is not a reason to spin or to fail loudly.
                        guard isCurrent(generation) else { return }
                    }
                }
                publish(.disabled, for: generation)
                await nap(runtime.backoff.idle, generation)
                continue
            }
            guard runtime.folder.hasFolder(account: generation.account) else {
                // Receiving is on with no grant to receive INTO. Never `ready`,
                // and never silently `off` either: the policy the user set is
                // still their answer, and this names what is missing.
                refreshFolder()
                publish(.folderMissing, for: generation)
                await nap(runtime.backoff.blocked, generation)
                continue
            }

            do {
                let engine = try await resolveEngine(generation, bearer: bearer)
                guard isCurrent(generation) else { return }
                if !prepared {
                    _ = try await engine.prepare(platform: runtime.platform,
                                                 appVersion: runtime.appVersion)
                    guard isCurrent(generation) else { return }
                    prepared = true
                }
                let delay = try await pass(engine, generation: generation, policy: policy)
                guard isCurrent(generation) else { return }
                failures = 0
                await nap(delay, generation)
            } catch {
                guard isCurrent(generation) else { return }
                failures += 1
                // A failed pass invalidates the enrolment assumption too: the
                // next attempt re-announces this device rather than assuming
                // central still holds what the last successful pass established.
                prepared = false
                let delay = runtime.backoff.delay(afterFailures: failures)
                if applyFailure(error, retryIn: delay) { return }
                await nap(delay, generation)
            }
        }
    }

    /// Build or reuse the engine for this generation.
    private func resolveEngine(_ generation: InboxGeneration, bearer: String) async throws
        -> InboxReceiveEngine {
        if let existing = engine { return existing }
        let built = try await runtime.makeEngine(generation.account, bearer)
        guard isCurrent(generation) else { throw CancellationError() }
        engine = built
        return built
    }

    /// One pass, with this generation's observers attached for exactly its
    /// duration. Returns how long to wait before the next one.
    private func pass(_ engine: InboxReceiveEngine, generation: InboxGeneration,
                      policy: InboxAutoAccept) async throws -> TimeInterval {
        passToken += 1
        let token = passToken
        let record = InboxPassRecord()
        var live = engine
        live.onReceipt = { [record] receipt in record.add(receipt) }
        live.onPending = { [record] tasks in record.observe(pending: tasks) }
        live.log = { [weak self, record] event in
            switch event {
            case .claimed:
                // The one live indicator, and the only callback that touches
                // published state before the pass returns. Guarded on BOTH the
                // generation and the pass token, so a late hop cannot overwrite
                // the state a finished pass established.
                Task { @MainActor in
                    guard let self, self.isCurrent(generation), self.passToken == token else {
                        return
                    }
                    self.state = .working
                }
            case .reported(_, let reported, let code):
                if reported == .attentionRequired || reported == .failedRetryable
                    || reported == .failedTerminal {
                    record.block(code)
                }
            default:
                break
            }
        }
        let result = try await live.pass()
        // Invalidate BEFORE reading the record, so nothing else can publish over
        // the decision about to be made.
        passToken += 1
        guard isCurrent(generation) else { return runtime.backoff.idle }
        return apply(result, record: record, generation: generation, policy: policy)
    }

    private func apply(_ result: InboxReceiveEngine.PassResult, record: InboxPassRecord,
                       generation: InboxGeneration, policy: InboxAutoAccept) -> TimeInterval {
        adopt(record.receipts, generation: generation)
        if record.sawPending { adoptPending(record.pending) }

        switch result {
        case .worked:
            if let receipt = record.receipts.last, !receipt.isReplay {
                // A REPLAY deliberately does not reach this arm. Its files are
                // real and its row belongs in the result list, but it landed at
                // the time the journal records — possibly weeks ago — and showing
                // "1 file saved" as the CURRENT status after a relaunch would
                // date somebody's old delivery to this moment.
                ledger.attentionCleared()
                state = .saved(files: receipt.fileCount)
            } else if let blocker = record.blocker {
                state = .attention(.delivery(blocker))
                announce(.attention(.delivery(blocker)))
            } else {
                // Worked something that produced neither a commit nor a reported
                // blocker: central took the task back, or the report itself
                // failed. Nothing was saved, so nothing may say so.
                state = .ready(policy)
            }
            // Deliveries arrive in batches and the sender is usually still
            // watching, so the next pass is soon rather than on the idle poll.
            return runtime.backoff.afterWork

        case .idle:
            if !asking.isEmpty {
                state = .asking(count: asking.count)
                return runtime.backoff.blocked
            }
            if let blocker = record.blocker ?? pendingBlocker(record.pending) {
                state = .attention(.delivery(blocker))
                announce(.attention(.delivery(blocker)))
                return runtime.backoff.blocked
            }
            ledger.attentionCleared()
            state = .ready(policy)
            return runtime.backoff.idle

        case .notReceiving(let folderState):
            folder = InboxFolderSummary(
                state: folderState,
                isChosen: runtime.folder.hasFolder(account: generation.account))
            switch folderState {
            case .absent:
                state = .folderMissing
            case .unavailable(let problem):
                state = .attention(.folder(problem))
                announce(.attention(.folder(problem)))
            case .usable:
                // `notReceiving` with a usable folder is a contradiction this
                // build cannot interpret. Fail closed rather than fall through to
                // a state that promises a sender their file will land.
                state = .failed(.unknown)
            }
            return runtime.backoff.blocked
        }
    }

    /// Map a thrown error onto a state. Returns whether it is terminal for this
    /// generation — that is, whether the loop should stop rather than back off.
    private func applyFailure(_ error: Error, retryIn delay: TimeInterval) -> Bool {
        let seconds = Int(delay.rounded())
        if error is CancellationError { return true }
        if error is InboxKeyStoreError {
            // A refusing or locked keychain is not something another pass fixes,
            // and retrying it forever hides it behind an "offline" that is untrue.
            return fail(.keyUnavailable)
        }
        if error is InboxEnrolment.Failure { return fail(.enrolmentRefused) }
        if let inbox = error as? InboxError {
            switch inbox {
            case .network:
                state = .offline(retryInSeconds: seconds)
                return false
            case .api(let status, _):
                if status == 401 || status == 403 { return fail(.identity) }
                if status >= 500 || status == 429 {
                    state = .offline(retryInSeconds: seconds)
                    return false
                }
                return fail(.unknown)
            case .noCurrentDevice, .invalidIdentifier:
                return fail(.identity)
            case .unsupportedByServer, .unknownProtocolValue:
                return fail(.enrolmentRefused)
            case .malformedResponse, .rangeIgnored, .stateNotDeviceReportable,
                 .savedNotAsserted:
                return fail(.unknown)
            }
        }
        if error is URLError {
            state = .offline(retryInSeconds: seconds)
            return false
        }
        // Anything at all this build cannot name. Not `ready`, and not `offline`
        // either: an unknown condition that reads as a working inbox is the exact
        // failure the closed state enum exists to prevent.
        return fail(.unknown)
    }

    private func fail(_ failure: InboxRuntimeFailure) -> Bool {
        state = .failed(failure)
        if ledger.shouldAnnounce(failure) { runtime.notifier?.deliver(.failed(failure)) }
        return true
    }

    /// Take this pass's receipts into the result list.
    ///
    /// The generation check here is a SECOND, deliberately redundant one: `pass`
    /// has already refused to call `apply` for a superseded generation, so today
    /// this can only be reached with a current one. It is kept because the cost of
    /// being wrong is one account's delivery appearing under another's session,
    /// and because a future second call site would otherwise inherit no guard at
    /// all. The consequence for evidence is recorded in
    /// `testALateCompletionForTheOldAccountCannotTouchTheNewOne`: removing either
    /// guard alone leaves the test green, so the mutation that proves the
    /// property removes BOTH.
    private func adopt(_ receipts: [InboxReceipt], generation: InboxGeneration) {
        guard isCurrent(generation), !receipts.isEmpty else { return }
        for receipt in receipts {
            results.removeAll { $0.taskID == receipt.taskID }
            results.insert(receipt, at: 0)
            if ledger.shouldAnnounce(receipt) {
                runtime.notifier?.deliver(.saved(files: receipt.fileCount))
            }
        }
        if results.count > runtime.resultLimit {
            results = Array(results.prefix(runtime.resultLimit))
        }
    }

    private func adoptPending(_ tasks: [InboxTask]) {
        // A task central holds with NO error code is one waiting for the user's
        // answer under `ask`. A task holding an error code is a blocker, and the
        // two must not be merged: answering the second would be this machine
        // clearing a problem it has not fixed.
        asking = tasks
            .filter { $0.state == .attentionRequired && $0.errorCode.isNone }
            .map { InboxAskItem(id: $0.id, ciphertextBytes: $0.ciphertextBytes,
                                expiresAt: $0.expiresAt) }
    }

    private func pendingBlocker(_ tasks: [InboxTask]) -> InboxDeviceErrorCode? {
        for task in tasks where task.state == .attentionRequired {
            if case .device(let code) = task.errorCode, code != .none { return code }
        }
        return nil
    }

    private func announce(_ notification: InboxNotification) {
        guard case .attention(let attention) = notification,
              ledger.shouldAnnounce(attention) else { return }
        runtime.notifier?.deliver(notification)
    }

    private func publish(_ next: InboxRuntimeState, for generation: InboxGeneration) {
        guard isCurrent(generation) else { return }
        state = next
    }

    private func nap(_ seconds: TimeInterval, _ generation: InboxGeneration) async {
        guard isCurrent(generation) else { return }
        await runtime.sleeper.sleep(seconds)
    }

    // MARK: - the user's own controls

    /// Choose a receive folder. Does NOT turn receiving on: that stays the
    /// separate decision `InboxReceiveFolder` refuses to merge, and a folder
    /// chosen while the policy is Off leaves the policy Off.
    public func chooseFolder(_ url: URL) {
        guard let generation else { return }
        settingsError = nil
        do {
            try runtime.folder.chooseFolder(url, account: generation.account)
        } catch InboxFolderError.notWritable {
            settingsError = .folderNotWritable
            return
        } catch {
            settingsError = .folderBookmarkFailed
            return
        }
        refreshFolder()
        restart()
    }

    /// Forget the grant AND the policy together, for the reason `forget` records.
    public func removeFolder() {
        guard let generation else { return }
        settingsError = nil
        // Removing the grant also switches receiving off, so central has to be
        // told for the same reason an explicit Off does.
        if policy != .off {
            runtime.folder.setStopAnnouncementPending(true, account: generation.account)
        }
        runtime.folder.forget(account: generation.account)
        policy = .off
        refreshFolder()
        restart()
    }

    /// Off, Ask every time, or Automatically. Refused for the two non-`off`
    /// answers without a folder, and the refusal is reported rather than silently
    /// choosing one.
    public func setPolicy(_ next: InboxAutoAccept) {
        guard let generation else { return }
        settingsError = nil
        do {
            try runtime.folder.setReceivePolicy(next, account: generation.account)
        } catch {
            settingsError = .noFolderChosen
            return
        }
        // Only a CHANGE to Off is news for central.
        if next == .off, policy != .off {
            runtime.folder.setStopAnnouncementPending(true, account: generation.account)
        } else if next != .off {
            // A newer non-off announcement supersedes an unsent stop transition.
            runtime.folder.setStopAnnouncementPending(false, account: generation.account)
        }
        policy = next
        restart()
    }

    /// Stop claiming, without changing the user's stored answer. Sticky: it
    /// survives the window closing and every pass in between, and only `resume`
    /// clears it.
    public func pause() {
        guard generation != nil, !isPaused else { return }
        isPaused = true
        state = .paused
        runtime.sleeper.wake()
    }

    public func resume() {
        guard generation != nil, isPaused else { return }
        isPaused = false
        state = .loading
        runtime.sleeper.wake()
    }

    /// Try again now. The control that makes a bounded backoff bearable: without
    /// it, a user who has just fixed their folder waits out whatever interval the
    /// last failure earned.
    public func retryNow() {
        guard generation != nil else { return }
        settingsError = nil
        refreshFolder()
        restart()
    }

    /// Answer a task central is holding under `ask`.
    ///
    /// Only ever from this method, which only ever runs from a control the user
    /// pressed. Nothing in the engine or the loop can answer for them —
    /// `requeueRecovered` explicitly refuses to touch a held task.
    public func respond(toAsk taskID: String, accept: Bool) {
        guard let generation, let engine,
              let question = asking.first(where: { $0.id == taskID }) else {
            return
        }
        settingsError = nil
        asking.removeAll { $0.id == taskID }
        state = asking.isEmpty ? .loading : .asking(count: asking.count)
        let sleeper = runtime.sleeper
        Task { @MainActor [weak self] in
            do {
                try await engine.respond(toAsk: taskID, accept: accept)
            } catch {
                guard let self, self.isCurrent(generation) else { return }
                self.settingsError = .askResponseFailed
                // Put it back: the question is still open, and a device that
                // silently dropped it would leave the sender waiting forever on
                // an answer this Mac believes it gave.
                if !self.asking.contains(where: { $0.id == taskID }) {
                    self.asking.append(question)
                }
                self.state = .asking(count: self.asking.count)
                return
            }
            guard let self, self.isCurrent(generation) else { return }
            sleeper.wake()
        }
    }

    /// Show a completed delivery in Finder.
    ///
    /// Refuses anything that is not in this generation's own result list. That is
    /// the whole guard: a URL cannot reach the Finder unless it came from a
    /// journal the commit wrote, was adopted under the current generation, and is
    /// still known. An arbitrary path handed to this method does nothing.
    public func reveal(_ receipt: InboxReceipt) {
        guard let known = results.first(where: { $0.taskID == receipt.taskID }),
              !known.urls.isEmpty else { return }
        runtime.reveal(known.urls)
    }

    /// The newest completed delivery, for the menu bar's single Reveal item.
    public var latestResult: InboxReceipt? { results.first }

    // MARK: - notification authorization

    /// Ask the platform again.
    ///
    /// Called when the Device Inbox pane appears and every time the app becomes
    /// active, which is the pair that covers the journey this exists for: the
    /// user reads the warning, presses the button, changes the switch in System
    /// Settings, and comes back. macOS publishes no change notification for
    /// notification authorization, so re-asking at those two moments is the whole
    /// mechanism — there is no event to subscribe to.
    ///
    /// Safe to call on every activation, unlike `refreshFolder`: that one costs a
    /// real create-and-remove probe inside the user's own folder, while this is an
    /// asynchronous read that writes nothing anywhere.
    public func refreshNotificationPermission() {
        runtime.refreshNotificationPermission()
    }

    /// The platform's answer, from whatever asked for it.
    ///
    /// Not guarded by a generation. This is an app-and-Mac fact rather than an
    /// account-scoped one, so an answer that arrives across a sign-out is still
    /// the correct answer — the generation guards exist to stop ONE account's
    /// work being shown under another's, and this belongs to neither.
    public func updateNotificationPermission(_ next: InboxNotificationPermission) {
        guard notificationPermission != next else { return }
        notificationPermission = next
        // A refusal saying System Settings could not be opened describes a problem
        // the user no longer has, and its section is about to disappear anyway.
        // Leaving it standing would be the stale-message version of exactly the
        // untruth this state was added to remove. Only that one refusal is
        // cleared: an unrelated message the user has not read yet is not this
        // measurement's to discard.
        if !next.needsAttention, settingsError == .notificationSettingsUnavailable {
            settingsError = nil
        }
    }

    /// Take the user to this app's notification settings.
    ///
    /// Reports the refusal rather than swallowing it. A button that does nothing
    /// when pressed is exactly the defect this batch was opened for, and "System
    /// Settings would not open" is a sentence a person can act on, while silence
    /// is not.
    public func openNotificationSettings() {
        settingsError = runtime.openNotificationSettings()
            ? nil : .notificationSettingsUnavailable
    }

    /// Re-measure the grant. Costs a real create-and-remove probe, so it is
    /// called on an explicit action or when a surface appears — never per redraw.
    public func refreshFolder() {
        guard let generation else {
            folder = .none
            return
        }
        let isChosen = runtime.folder.hasFolder(account: generation.account)
        folder = InboxFolderSummary(state: runtime.folder.inspect(account: generation.account),
                                    isChosen: isChosen)
    }

    /// For surfaces that must not read the loop's transient states to decide
    /// whether an account is present at all.
    public var isSignedIn: Bool { generation != nil }
}
