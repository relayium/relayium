import Combine
import Foundation
import RelayiumAppKit
import RelayiumKit
import SwiftUI

#if DEBUG
/// One injected file selection, made once, by an object that owns its own
/// subscription and releases everything the moment it fires.
///
/// **Why it is not simply "call `chooseFiles` at launch".** `chooseFiles`
/// carries two refusals, and a signed-in acceptance launch is on the wrong side
/// of BOTH of them for a while. It refuses a selection with no ready account,
/// and the session restores asynchronously. It then refuses one while the
/// upload model is busy, and the ready account is exactly what starts the
/// recovery scan that holds `.checkingRecovery`. A selection injected into
/// either window is dropped silently — the same class of loss as the one this
/// replaces, not a new one — so the two publishers that own those refusals are
/// the trigger.
///
/// It never polls, sleeps, retries or times out. Every call below is a state
/// change the models themselves published, and the first one that satisfies
/// both refusals is the last one this object handles.
@MainActor
final class UITestPreselection {
    /// Held as optionals rather than `let`, because "one shot" has to be
    /// visible in the object graph and not only in a flag: after the selection
    /// is made this holds nothing it could make a second one from.
    private var send: SendSelectionModel?
    private var upload: CloudUploadModel?
    private var session: AccountSession?
    private var observation: AnyCancellable?

    init(send: SendSelectionModel, upload: CloudUploadModel, session: AccountSession) {
        self.send = send
        self.upload = upload
        self.session = session
    }

    /// Explicit cancellation, idempotent, and the only way this object stops.
    /// Safe before, during and after the one selection it makes.
    func cancel() {
        observation?.cancel()
        observation = nil
        send = nil
        upload = nil
        session = nil
    }

    func start() {
        guard let upload, let session else { return }
        // `.receive(on:)` is load-bearing rather than defensive. `@Published`
        // publishes in `willSet`, so a subscriber reached from that emission
        // reads the OLD value off the very model it is being told changed —
        // and `chooseFiles` would then consult a stale `upload.isBusy` and drop
        // the selection. One main-queue turn later the write has landed, which
        // is why the condition below is read from the models rather than from
        // an emitted value that has not been stored yet.
        //
        // This does NOT weaken `SendSelectionModel.observe`, which must stay
        // synchronous and does: that subscription is installed separately, at
        // app construction, and nothing here touches it.
        observation = Publishers.CombineLatest(session.$state, upload.$state)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.chooseOnceTheModelsWillAcceptIt() }
    }

    private func chooseOnceTheModelsWillAcceptIt() {
        guard let send, let upload, let session else { return }
        guard case .ready = session.state else { return }      // the account refusal
        guard case .idle = upload.state else { return }        // the busy refusal
        // Staged HERE rather than trusted to have been staged. The scene
        // `.task` that stages for the picker paths is not ordered against the
        // account becoming ready, and a URL whose bytes nobody wrote would
        // reach `store.replace` and leave the send screen showing a preparation
        // error instead of a pending row — an acceptance defect that reads as a
        // product defect.
        UITestMode.stagePendingFixture()
        guard let url = UITestMode.pendingFixtureURL(),
              FileManager.default.fileExists(atPath: url.path) else { return }
        // Cancelled BEFORE the callback, so the `.picked` state the selection
        // publishes cannot re-enter this.
        cancel()
        // The EXACT callback `SendView`'s `fileImporter` invokes, with the exact
        // shape it passes. Everything downstream of this line — the scope, the
        // expansion, the limits, the pending row, the send, the failure and the
        // recovery — is production code. Only the presentation is skipped.
        send.chooseFiles(.success([url]))
    }
}
#endif

/// Keeps simulator UI acceptance from joining the public Nearby rendezvous.
///
/// The launch argument is absent from Release builds: the shipped binary folds
/// this to `false`, so reachability cannot be disabled by a user or a link.
enum UITestMode {
    #if DEBUG
    static let isActive = ProcessInfo.processInfo.arguments.contains(
        "--relayium-ui-testing") // nonlocalized: test-only launch argument

    /// Whether this acceptance launch may become reachable.
    ///
    /// The same rule the Mac's `UITestMode.allowsResidency` records, and it has
    /// to be the same rule: the reason a simulator stays out of the room is that
    /// the production hub keys the code-less room by observed public address, so
    /// a resident acceptance build shares a roster with strangers behind that
    /// address. A loopback origin removes that — the hub is a server on this
    /// machine, bound where nothing off it can reach — rather than deciding to
    /// tolerate it.
    ///
    /// Every launch that resolves no loopback origin, which is every launch that
    /// passes none, resolves production and is refused here.
    static let allowsResidency = isActive && AppEnvironment.isLoopbackTransferOrigin

    /// Whether this launch should leave one deterministic file where the system
    /// document browser can reach it.
    ///
    /// It stages a file and nothing else. The picker the test then drives, the
    /// security scope it hands back, the expansion, the limits and the rendered
    /// pending row are all production code — the alternative, injecting a
    /// selection directly, would prove only that a list renders what it is
    /// given. A separate argument from `isActive` so the ordinary acceptance
    /// paths never write into the container at all.
    // nonlocalized: a test-only launch argument, absent from Release
    static let pendingFixtureArgument = "--relayium-ui-testing-pending-fixture"

    /// Hands a launch the selection the document browser would have produced,
    /// without presenting it.
    ///
    /// **This does not replace the picker tests, and must not.**
    /// `testPendingSendNamesTheFileAndItsSizeBeforeTransfer` and
    /// `testASignedInStoredSendNamesTheFileItWouldUpload` exist to drive the
    /// real `fileImporter`, the real security scope and the real expansion, and
    /// they still do. The upload FAILURE path is not about any of that: it needs
    /// a pending file to exist so it can be sent and fail, and paying for a
    /// one-shot system-picker presentation to get one is what made that test
    /// lose hosted CI to a presentation race it was never testing.
    // nonlocalized: a test-only launch argument, absent from Release
    static let preselectFixtureArgument = "--relayium-ui-testing-preselect-fixture"
    static let preselectsPendingFixture = ProcessInfo.processInfo.arguments.contains(
        preselectFixtureArgument)
    /// Hands the same fixture to the app-scoped direct-transfer selection used
    /// by Nearby and pairing-code flows. Separate from the account-owned upload
    /// seam above: those are different production models with different gates,
    /// and one test argument must never inject into both.
    // nonlocalized: a test-only launch argument, absent from Release
    static let preselectDirectFixtureArgument =
        "--relayium-ui-testing-preselect-direct-fixture"
    static let preselectsDirectPendingFixture = ProcessInfo.processInfo.arguments.contains(
        preselectDirectFixtureArgument)
    /// Any fixture argument stages. A preselecting launch must not depend on a
    /// second argument being passed beside it to have something to select.
    static let stagesPendingFixture = ProcessInfo.processInfo.arguments.contains(
        pendingFixtureArgument) || preselectsPendingFixture || preselectsDirectPendingFixture


    /// Whether this launch already holds an account.
    ///
    /// Every signed-in surface — Send a link, the device and stored-file
    /// sections, and every completion that follows them — was unreachable from
    /// acceptance, because the suite could only ever be signed out. The account
    /// below is answered entirely in process: no request leaves the device, no
    /// real credential exists, and the bearer is a literal that no server would
    /// accept.
    /// Fails a chunk upload, so the recoverable-failure surface can be driven.
    // nonlocalized: a test-only launch argument, absent from Release
    static let failUploadArgument = "--relayium-ui-testing-fail-upload"
    static let failsUpload = ProcessInfo.processInfo.arguments.contains(failUploadArgument)

    /// Holds a chunk upload open so the in-flight surface can be driven.
    // nonlocalized: a test-only launch argument, absent from Release
    static let stallUploadArgument = "--relayium-ui-testing-stall-upload"
    static let stallsUpload = ProcessInfo.processInfo.arguments.contains(stallUploadArgument)

    // nonlocalized: a test-only launch argument, absent from Release
    static let signedInArgument = "--relayium-ui-testing-signed-in"
    /// Signed OUT, but with the account API answered — so the sign-in form can be
    /// filled in and succeed. `isSignedIn` seeds a bearer; this one does not.
    // nonlocalized: a test-only launch argument, absent from Release
    static let signInArgument = "--relayium-ui-testing-sign-in"
    static let answersAccountAPI = ProcessInfo.processInfo.arguments.contains(signInArgument)
    static let isSignedIn = ProcessInfo.processInfo.arguments.contains(signedInArgument)
    // nonlocalized: a test-only launch argument, absent from Release
    static let subscriptionsArgument = "--relayium-ui-testing-subscriptions"
    static let showsSubscriptions = ProcessInfo.processInfo.arguments.contains(
        subscriptionsArgument)

    @MainActor
    static func makeSubscriptionModel(
        bearer: @escaping @MainActor () -> String?,
        refreshAccount: @escaping @MainActor () async -> Void
    ) -> AppleSubscriptionModel? {
        guard showsSubscriptions, let transport = makeAccountTransport() else { return nil }
        return AppleSubscriptionModel(
            store: UITestSubscriptionStore(),
            billing: AppEnvironment.makeAppleBillingService(transport: transport),
            bundleID: UITestAccountTransport.bundleID,
            bearer: bearer,
            refreshAccount: refreshAccount)
    }

    /// Prefills the one long stored link whose acceptance path is about
    /// metadata retrieval and manifest decryption, not keyboard event delivery.
    ///
    /// The full UI suite runs on a shared simulator under heavy load. Injecting
    /// this 79-character value with `XCUIElement.typeText` dropped or delayed
    /// characters there while the dedicated keyboard/invalid-link tests stayed
    /// responsible for editing and submission. Keeping the fixture here makes
    /// the encrypted-link path deterministic without adding a shipped deep-link
    /// or clipboard shortcut.
    // nonlocalized: a test-only launch argument, absent from Release
    static let validDownloadLinkArgument = "--relayium-ui-testing-valid-download-link"
    // nonlocalized: 32 bytes of 0x11, base64url — an acceptance key, never real
    static let downloadKeyB64url = "ERERERERERERERERERERERERERERERERERERERERERE"

    @MainActor
    static func prefillValidDownloadLink(in model: CloudDownloadModel) {
        guard ProcessInfo.processInfo.arguments.contains(validDownloadLinkArgument) else {
            return
        }
        model.linkText = "https://relayium.com/d/obj_uitest#k=\(downloadKeyB64url)"
    }

    /// Prefills the one link the receive path must REFUSE, for the same reason
    /// the valid fixture above exists: in the test that uses it, the refused
    /// string is setup rather than subject.
    ///
    /// `testEditingARefusedLinkClearsTheRefusalWithIt` entered this value with
    /// `XCUIElement.typeText`, and hosted run 33020899047 read the real field
    /// back as `not ink` — input events lost between the tap and the
    /// assertion, on a shared simulator under the full UI suite's load. The
    /// property that test owns is that EDITING a refused link clears the
    /// refusal, so the string it starts from arrives deterministically and the
    /// one synthetic keystroke it still spends goes on the edit itself.
    ///
    /// Deliberately NOT extended to the neighbouring malformed-link and
    /// keyboard-Go tests. Entering a link with the real keyboard and submitting
    /// it are exactly what those two exist to prove.
    // nonlocalized: a test-only launch argument, absent from Release
    static let invalidDownloadLinkArgument = "--relayium-ui-testing-invalid-download-link"
    /// Refused by `parseTransferLink` for the plainest available reason — it is
    /// not a URL at all — so the refusal it produces is the product's own.
    // nonlocalized: acceptance input, never rendered as product copy
    static let invalidDownloadLinkText = "not a link"

    @MainActor
    static func prefillInvalidDownloadLink(in model: CloudDownloadModel) {
        guard ProcessInfo.processInfo.arguments.contains(invalidDownloadLinkArgument) else {
            return
        }
        model.linkText = invalidDownloadLinkText
    }

    /// A token store already holding the acceptance bearer, so `restore()` takes
    /// its normal “found a credential” path rather than a special one.
    static func makeSignedInTokenStore() -> TokenStore {
        let store = InMemoryTokenStore()
        try? store.save(UITestAccountTransport.bearer)
        return store
    }

    static func makeAccountTransport() -> URLSession? {
        guard isSignedIn || answersAccountAPI else { return nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UITestAccountTransport.self]
        return URLSession(configuration: configuration)
    }

    /// Holds Nearby in the state a destination failure leaves behind: off,
    /// with no pause anywhere.
    ///
    /// It asks the launch to skip both the pause the other acceptance paths
    /// take and the residency a shipped launch starts — which is not a fourth
    /// state invented for a test, but exactly the one a model that never became
    /// resident is already in.
    // nonlocalized: a test-only launch argument, absent from Release
    static let offReceivingArgument = "--relayium-ui-testing-off-receiving"
    static let showsOffReceiving = ProcessInfo.processInfo.arguments.contains(
        offReceivingArgument)

    /// 1,536 bytes, so the size the row must render is an exact, unambiguous
    /// `1.5 KB` rather than a value that depends on rounding.
    static let pendingFixtureName = "Relayium product brief.txt" // nonlocalized: a test fixture
    private static let pendingFixtureByteCount = 1_536





    /// Builds a deterministic failed Nearby file task, so the suite can prove the
    /// retained terminal surface still exposes the route back to the roster.
    // nonlocalized: a test-only launch argument, absent from Release
    static let terminalNearbyArgument = "--relayium-ui-testing-terminal-nearby"
    static let showsTerminalNearby = ProcessInfo.processInfo.arguments.contains(
        terminalNearbyArgument)

    @MainActor
    static func makeTerminalNearbyFileModel(
        verification: VerificationPreference
    ) -> RealtimeSessionModel? {
        guard showsTerminalNearby else { return nil }
        return RealtimeSessionModel(
            pairClient: UITestPairClient(),
            iceClient: UITestFailingICEClient(),
            requiresVerification: { verification.requiresSASConfirmation },
            makeConnection: { _, _, _ in throw AccountError.network }
        )
    }

    /// Holds the text pairing model on a deterministic terminal failure, so the
    /// suite can verify that cleanup — not a second start path — owns the page.
    // nonlocalized: a test-only launch argument, absent from Release
    static let terminalTextArgument = "--relayium-ui-testing-terminal-text"
    static let showsTerminalText = ProcessInfo.processInfo.arguments.contains(
        terminalTextArgument)


    /// Holds the FILE pairing surface on its generated code.
    ///
    /// The text half of this flow gained a runtime path in batch 107; the file
    /// half — the mode most people reach for — had none, so the join link's mode
    /// parameter was only ever proven for Text.
    // nonlocalized: a test-only launch argument, absent from Release
    static let fileCodeArgument = "--relayium-ui-testing-file-code"
    static let showsGeneratedFileCode = ProcessInfo.processInfo.arguments.contains(
        fileCodeArgument)

    @MainActor
    static func makeWaitingFileModel(verification: VerificationPreference) -> RealtimeSessionModel? {
        guard showsGeneratedFileCode else { return nil }
        return RealtimeSessionModel(
            pairClient: UITestPairClient(),
            iceClient: UITestWaitingICEClient(),
            requiresVerification: { verification.requiresSASConfirmation },
            makeConnection: { _, _, _ in throw AccountError.network }
        )
    }

    /// Holds the text pairing surface on its generated code.
    ///
    /// The pairing-code handoff is the flow the owner's 2026-08-07 review found
    /// broken — creating a text code jumped to Nearby and produced no visible
    /// join link — and iOS had no runtime evidence for it at all while macOS
    /// did. Minting succeeds locally and the ICE lookup then waits for the rest
    /// of the process, so the screen stays on the handoff state a person needs
    /// time to read and share. No network call is made.
    // nonlocalized: a test-only launch argument, absent from Release
    static let generatedTextCodeArgument = "--relayium-ui-testing-text-code"
    static let showsGeneratedTextCode = ProcessInfo.processInfo.arguments.contains(
        generatedTextCodeArgument)

    @MainActor
    static func makeRealtimeTextModel(
        verification: VerificationPreference
    ) -> RealtimeTextSessionModel? {
        guard showsGeneratedTextCode || showsTerminalText else { return nil }
        return RealtimeTextSessionModel(
            pairClient: UITestPairClient(),
            iceClient: UITestWaitingICEClient(),
            requiresVerification: { verification.requiresSASConfirmation },
            makeConnection: { _, _, _ in throw AccountError.network }
        )
    }


    /// A staging root of this launch's own, emptied before use.
    ///
    /// A cancelled upload stays resumable by design, so its staged bytes outlive
    /// the process — and therefore outlive the run. Without a root of its own an
    /// acceptance launch inherits the interrupted job the previous run left, and
    /// opens on Resume upload instead of a fresh selection. Same rule as the
    /// keychain: isolating one store is not isolating the app.
    static func pendingUploadRoot() -> URL? {
        // Application Support, deliberately. `IOSSurfaceGuardTests` refuses
        // temporaryDirectory, downloadsDirectory and cachesDirectory anywhere in
        // these sources, because a received file must never land somewhere the
        // system can purge or the user cannot find — and that guard reads the
        // whole file, not just the receive path. A staging root has no business
        // being an exception to it.
        guard isActive,
              let support = try? FileManager.default.url(
                for: .applicationSupportDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true) else { return nil }
        let root = support.appendingPathComponent("uitest-pending", isDirectory: true)
        try? FileManager.default.removeItem(at: root)
        return root
    }

    /// The stored-link key store an acceptance launch may use.
    ///
    /// **This is the more consequential half of the keychain isolation.**
    /// `AppEnvironment.makeStoredLinkKeyStore()` resolves the product's own
    /// keychain identity, so before this an acceptance launch could READ the
    /// installed app's stored-link keys — and a delete path calls `remove`,
    /// which would have destroyed real ones. In memory, so it also cannot
    /// outlive the process.
    ///
    /// Seeded only for a signed-in launch, and only for the object the account
    /// fixture describes, so the rebuildable arm of a stored row has something
    /// to rebuild from.
    static func makeStoredLinkKeyStore() -> StoredLinkKeyStore? {
        guard isActive else { return nil }
        let store = InMemoryStoredLinkKeyStore()
        guard isSignedIn else { return store }
        // nonlocalized: 32 zero bytes, base64url — an acceptance key, never real
        let key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        Task { try? await store.save(id: "obj_uitest", keyB64url: key) }
        return store
    }
    /// The keychain identity the Device Inbox's DEVICE KEY history may use.
    ///
    /// The same isolation the token store already gets, and for a sharper
    /// reason. `KeychainInboxDeviceKeyStore` is a read/write store of X25519
    /// private keys, keyed by account under the product's own service — so an
    /// acceptance launch resolving the shipped identity would read the installed
    /// app's device keys, and a generation change would WRITE over them. That is
    /// the installed product losing the ability to decrypt deliveries already
    /// sealed to it.
    ///
    /// Nil outside an acceptance launch, so a shipped build always resolves the
    /// product's own identity and cannot be pointed at a test one.
    static func inboxKeychainConfiguration() -> KeychainConfiguration? {
        guard isActive else { return nil }
        return AppEnvironment.isolatedKeychainConfiguration()
    }

    /// The defaults domain the Device Inbox's receive POLICY may use.
    ///
    /// Isolating one store is not isolating the app — the rule
    /// `pendingUploadRoot` records. The policy is the user's standing consent to
    /// unattended writes, so an acceptance launch that wrote it into
    /// `UserDefaults.standard` would change what the installed product does when
    /// nobody is looking at it. A suite name of this launch's own, removed
    /// first, so one run cannot inherit the answer another established.
    static func inboxDefaults() -> UserDefaults? {
        // nonlocalized: a defaults suite name, never displayed. It is an
        // arbitrary private namespace rather than an identity, so it did NOT
        // follow the bundle id onto `com.relayium.mac`: nothing resolves it
        // from the bundle, no acceptance script names it, and renaming it would
        // only be churn. It is scoped to this launch and cleared on entry.
        let suite = "com.relayium.app.uitest-inbox"
        guard isActive, let defaults = UserDefaults(suiteName: suite) else { return nil }
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    /// A receive directory of this launch's own.
    ///
    /// The product receives into `Documents/Received`, which is also where a
    /// stored-link download lands and what `resetReceivedFolder` empties. An
    /// acceptance launch gets a sibling instead, so a Device Inbox run cannot
    /// delete or collide with what the stored-link acceptance path is asserting
    /// about in the same container.
    ///
    /// Nil outside an acceptance launch, so a shipped build always receives into
    /// the one folder it publishes to the Files app.
    static func inboxReceiveDirectory() -> (@Sendable () throws -> URL)? {
        guard isActive else { return nil }
        return {
            // Application Support is refused here for the reason the guard
            // refuses `temporaryDirectory` everywhere in this file: a received
            // file must land where the product puts received files. This is
            // Documents, beside `Received`, and therefore equally durable and
            // equally reachable from the Files app.
            let documents = try ReceiveDestination.documentsDirectory()
            // nonlocalized: an acceptance directory name, never displayed
            let root = documents.appendingPathComponent("uitest-inbox", isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            return root
        }
    }

    /// Opens the launch on the stored-link screen, which is no longer a tab.
    ///
    /// **Why acceptance needs a seam here at all.** Until 0.3.0 `storedReceive`
    /// was the first of five tabs and the destination the app launched on, so
    /// every stored-link test simply tapped it. It is not browseable any more —
    /// opening a link is something the OS hands this app, not somewhere a person
    /// sets out to go — and the two product routes that remain are a verified
    /// Universal Link, which no UI test process can deliver, and a stored-file
    /// row inside Account, which needs an account. The signed-OUT stored-link
    /// behaviour — a malformed link, the keyboard's Go key, a refusal corrected
    /// in place — has neither, and it is real product behaviour that would
    /// otherwise lose its runtime evidence entirely.
    ///
    /// **It forges nothing.** All it does is choose the destination
    /// `AppNavigationModel` starts on. `IOSShellModel` then applies its own
    /// rule to that destination like any other, which is what puts the screen
    /// up as a sheet over `lanTransfer` — so the presentation, the background
    /// underneath it and the dismissal are the product's, not this argument's.
    /// `testAStoredLinkOpenedFromTheAccountReturnsToTheSurfaceUnderneath` drives
    /// the same surface through the real Account route, so the seam is never the
    /// only evidence that presenting a stored link works.
    ///
    /// Nil outside an acceptance launch, and absent from Release, so no shipped
    /// launch can be started on a screen the user did not ask for.
    // nonlocalized: a test-only launch argument, absent from Release
    static let openStoredLinkArgument = "--relayium-ui-testing-open-stored-link"

    static func initialDestination() -> AppDestination? {
        guard isActive,
              ProcessInfo.processInfo.arguments.contains(openStoredLinkArgument)
        else { return nil }
        return .storedReceive
    }

    /// The keychain an acceptance launch may use — never the item the installed
    /// product wrote, and emptied before the session restores.
    ///
    /// Without this the suite reads whatever account this machine is in, so a
    /// signed-out assertion passes or fails by the workstation rather than by
    /// the product. Emptied on every launch as well as isolated, so one path
    /// cannot inherit an account another path established.
    static func makeTokenStore() -> TokenStore? {
        guard isActive else { return nil }
        if isSignedIn { return makeSignedInTokenStore() }
        let store = AppEnvironment.makeTokenStore(
            AppEnvironment.isolatedKeychainConfiguration())
        try? store.clear()
        return store
    }

    /// Where the fixture goes, and the ONE place either half of this seam names
    /// the container. Nil for every launch that did not ask for a fixture,
    /// which is every launch that passes neither argument.
    static func pendingFixtureURL() -> URL? {
        guard stagesPendingFixture,
              let documents = try? FileManager.default.url(
                for: .documentDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true) else { return nil }
        return documents.appendingPathComponent(pendingFixtureName)
    }

    /// Rewritten on every launch that asks for it, so a container surviving
    /// from an earlier run cannot leave a stale name or length behind.
    /// Idempotent, because the preselection seam re-stages rather than assuming
    /// the scene `.task` ran first.
    static func stagePendingFixture() {
        guard let url = pendingFixtureURL() else { return }
        try? Data(repeating: 0x52, count: pendingFixtureByteCount).write(
            to: url, options: .atomic)
    }

    /// The one-shot preselection this process owns, or nil when no launch asked
    /// for one. Retained deliberately: the object releases its own captures the
    /// instant it fires, so what survives here holds nothing and can select
    /// nothing.
    @MainActor private static var preselection: UITestPreselection?

    /// Installs it. A no-op without the argument, and a no-op in Release by
    /// construction rather than by a flag.
    @MainActor
    static func preselectPendingFixture(into send: SendSelectionModel,
                                        upload: CloudUploadModel,
                                        session: AccountSession) {
        guard preselectsPendingFixture else { return }
        // Explicit, and before the replacement exists: two live preselections
        // would be two selections racing into one model.
        preselection?.cancel()
        let one = UITestPreselection(send: send, upload: upload, session: session)
        preselection = one
        one.start()
    }

    /// Injects through the exact callback used by Nearby's `fileImporter`.
    /// Direct selection has no account or upload gate, so this is synchronous
    /// and deliberately does not share `UITestPreselection` with cloud sends.
    @MainActor
    static func preselectPendingFixture(into selection: DirectSendSelection) {
        guard preselectsDirectPendingFixture else { return }
        stagePendingFixture()
        guard let url = pendingFixtureURL(),
              FileManager.default.fileExists(atPath: url.path) else { return }
        selection.chooseFiles(.success([url]))
    }

    /// Whether this launch should start with an empty `Received` folder.
    ///
    /// **Why an acceptance launch needs this, and why it is not a weakening of
    /// the product rule.** iOS has no folder picker for a download: the
    /// destination is FIXED inside the container, and the product's answer to a
    /// name already taken is to REFUSE rather than overwrite. That is the right
    /// answer for a person, and it makes the completion path run exactly once
    /// per simulator: the second attempt legitimately fails on a file the first
    /// attempt legitimately kept. Clearing the folder before the app resolves it
    /// puts the launch back in the state a fresh install is in — it does not
    /// change what happens when the name IS taken, which
    /// `ReceiveDestinationTests` covers and this argument never reaches.
    // nonlocalized: a test-only launch argument, absent from Release
    static let freshReceivedFolderArgument = "--relayium-ui-testing-fresh-received-folder"
    static let startsWithAnEmptyReceivedFolder = ProcessInfo.processInfo.arguments
        .contains(freshReceivedFolderArgument)

    /// Removes only this app's own `Received` folder, and only inside a Debug
    /// launch that asked for it. Nothing outside the container is reachable
    /// from here: the path is resolved by `ReceiveDestination` from
    /// `FileManager`, never assembled.
    static func resetReceivedFolder() {
        guard startsWithAnEmptyReceivedFolder,
              let documents = try? ReceiveDestination.documentsDirectory() else { return }
        try? FileManager.default.removeItem(
            at: documents.appendingPathComponent(ReceiveDestination.folderName,
                                                 isDirectory: true))
    }
    /// **Dark appearance, asked for by the launch rather than by the device.**
    ///
    /// `XCUIDevice.shared.appearance` is the API this would otherwise use, and
    /// it does not work: setting it to `.dark` on Xcode 26.6 / iOS 26 leaves
    /// the simulator in Light, and a screenshot taken straight afterwards is
    /// Light. A contrast audit that believes it ran in Dark and did not is
    /// worse than no dark audit — it reports the Light findings under a Dark
    /// heading — so the appearance is a fact about the LAUNCH here, and
    /// `AppShellUITests` proves from a real screenshot that it took.
    ///
    /// `.preferredColorScheme` is the whole mechanism: it sets the trait for
    /// the scene, so every semantic UIKit colour, every asset appearance and
    /// every `Palette` role resolves exactly as it does on a device set to
    /// Dark. Nothing else in the app reads this.
    // nonlocalized: a test-only launch argument, absent from Release
    static let darkAppearanceArgument = "--relayium-ui-testing-dark-appearance"
    static let forcedColorScheme: ColorScheme? =
        ProcessInfo.processInfo.arguments.contains(darkAppearanceArgument) ? .dark : nil

    #else
    static let isActive = false
    /// `nil`, and unreachable: a shipped launch has no argument that could set
    /// it, so the scene keeps whatever appearance the device is in.
    static let forcedColorScheme: ColorScheme? = nil
    /// false, and unreachable: a shipped launch never takes the acceptance arm
    /// of the residency gate, because `isActive` is already false beside it.
    static let allowsResidency = false
    /// Folded to a constant, so a shipped launch always takes the residency
    /// branch and no argument can hold this device out of the room.
    static let showsOffReceiving = false

    /// In Release the whole idea is absent: the optimiser folds this to an
    /// empty call, and no argument can reach the container.
    static func stagePendingFixture() {}

    /// Likewise absent, and absent in the strongest sense this file has: the
    /// shipped half does not merely fold the seam to false, it contains no call
    /// into the send model's selection callback at all — so no shipped code
    /// path can put a selection in front of somebody who did not make one.
    @MainActor
    static func preselectPendingFixture(into send: SendSelectionModel,
                                        upload: CloudUploadModel,
                                        session: AccountSession) {}
    @MainActor
    static func preselectPendingFixture(into selection: DirectSendSelection) {}

    /// Likewise absent. A shipped launch has no argument that deletes anything
    /// a user has received, and this folds to an empty call.
    static func resetReceivedFolder() {}

    /// nil, so a shipped launch always resolves the product's own keychain
    /// identity and cannot be pointed at a test one.
    static func makeTokenStore() -> TokenStore? { nil }

    /// nil, so a shipped launch always keeps its stored-link keys where the
    /// product keeps them.
    static func makeStoredLinkKeyStore() -> StoredLinkKeyStore? { nil }

    /// nil, so a shipped launch always resolves the product's own keychain
    /// identity for its Device Inbox key history — the store whose contents are
    /// the only way already-sealed deliveries can be decrypted.
    static func inboxKeychainConfiguration() -> KeychainConfiguration? { nil }

    /// nil, so a shipped launch always keeps the user's receiving consent in the
    /// domain the product reads it from.
    static func inboxDefaults() -> UserDefaults? { nil }

    /// nil, so a shipped launch always receives into the one folder it publishes
    /// to the Files app, and no argument can redirect a delivery.
    static func inboxReceiveDirectory() -> (@Sendable () throws -> URL)? { nil }

    /// nil, so a shipped launch always opens on the destination the product
    /// chose, and no argument can start the app on a screen the user did not
    /// ask for.
    static func initialDestination() -> AppDestination? { nil }

    /// nil, so a shipped launch always stages where the product stages.
    static func pendingUploadRoot() -> URL? { nil }

    /// false, so a shipped launch can never be told it already holds an account.
    static let isSignedIn = false
    static let answersAccountAPI = false
    static let showsSubscriptions = false
    @MainActor
    static func makeSubscriptionModel(
        bearer: @escaping @MainActor () -> String?,
        refreshAccount: @escaping @MainActor () async -> Void
    ) -> AppleSubscriptionModel? { nil }
    static let stallsUpload = false
    static let failsUpload = false
    /// false, so a shipped launch always mints a real code over the network.
    static let showsGeneratedTextCode = false
    static let showsTerminalText = false
    static let showsTerminalNearby = false
    static let showsGeneratedFileCode = false
    static func makeAccountTransport() -> URLSession? { nil }

    /// nil, so shipped launches always construct the production realtime
    /// models and cannot select an acceptance-only terminal or waiting state.
    @MainActor
    static func makeTerminalNearbyFileModel(
        verification: VerificationPreference
    ) -> RealtimeSessionModel? { nil }

    @MainActor
    static func makeWaitingFileModel(
        verification: VerificationPreference
    ) -> RealtimeSessionModel? { nil }

    @MainActor
    static func makeRealtimeTextModel(
        verification: VerificationPreference
    ) -> RealtimeTextSessionModel? { nil }

    /// Folded to a no-op; no launch argument can prefill a shipped receive.
    @MainActor
    static func prefillValidDownloadLink(in model: CloudDownloadModel) {}

    /// Likewise. A shipped launch cannot be told to start a receive already
    /// holding a link — valid or refusable — that nobody pasted.
    @MainActor
    static func prefillInvalidDownloadLink(in model: CloudDownloadModel) {}

    #endif
}

#if DEBUG
/// Answers the four account reads in process, for acceptance only.
///
/// The bodies are JSON literals, each VALIDATED by decoding it through the very
/// model the app will decode it into. The models carry no public memberwise
/// initializer, so this cannot construct them directly — but validating keeps
/// the property that matters: a required field added to `NativeUser` or
/// `UsageResponse` drops the entry, refuses the endpoint and fails the path
/// loudly, which is exactly how the two fields missing from the first version
/// were found. Everything else on the path is production —
/// the same `AccountClient`, the same decoding, the same `AccountSession`
/// states, the same views.
///
/// An `/api/` path this does not model is REFUSED rather than answered with an
/// empty 200, so a surface that reaches an endpoint the fixture does not
/// describe fails loudly instead of rendering a plausible blank.
final class UITestAccountTransport: URLProtocol {
    // nonlocalized: a bearer no server would accept
    static let bearer = "uitest-bearer"
    // nonlocalized: an acceptance fixture, not a real address
    static let email = "person@example.com"
    // nonlocalized: an acceptance fixture row, absent from Release
    static let thisDeviceName = "Studio Mac"
    // nonlocalized: an acceptance fixture row, absent from Release
    static let otherDeviceName = "Kitchen laptop"
    // nonlocalized: acceptance fixture identifiers, absent from Release
    static let bundleID = "com.relayium.mac"
    static let monthlyProductID = "uitest.subscription.month"
    static let yearlyProductID = "uitest.subscription.year"

    /// JSON literals, each VALIDATED by decoding it through the very model the
    /// app will decode it into.
    ///
    /// The models carry no public memberwise initializer, so this cannot build
    /// them directly — but validating here keeps the property that matters: if a
    /// required field is added to `NativeUser` or `UsageResponse`, the decode
    /// below fails, the entry is dropped, the endpoint is refused, and the
    /// acceptance path fails loudly. A literal that merely looked plausible
    /// would instead render a stale account forever.
    private static var bodies: [String: Data] {
        var out: [String: Data] = [:]
        func offer<T: Decodable>(_ path: String, _ json: String, as type: T.Type) {
            let data = Data(json.utf8)
            guard (try? JSONDecoder().decode(type, from: data)) != nil else { return }
            out[path] = data
        }
        // Sign-in. Modelled so the ONE transition acceptance never drove — an
        // empty session becoming a real one through the form a person fills in —
        // can be driven without a server. Returns the 6-field login user shape,
        // not /api/me's 14-field one: a fixture that returned the wrong shape
        // here would prove the app tolerates a body no server sends.
        offer("/api/auth/native/login", """
            {"token":"\(bearer)","user":{"id":"acct_uitest","email":"\(email)",
            "displayName":"","hasPassword":true,"emailVerified":true,
            "linkedMethods":["password"]}}
            """, as: LoginSuccessBody.self)
        offer("/api/me", """
            {"user":{"id":"acct_uitest","email":"\(email)","displayName":"",
            "hasPassword":true,"emailVerified":true,"linkedMethods":["password"],
            "onlyOwnNodes":false,"planId":"free","subscriptionStatus":"none",
            "subscriptionEnd":0,"hasBilling":false,"scheduledPlanId":"","scheduledCycle":"","billingCycle":""}}
            """, as: MeResponse.self)
        offer("/api/me/usage", """
            {"period":"202608","resetsAt":0,
            "traffic":{"used":0,"cap":5368709120},
            "storage":{"used":0,"cap":1073741824},
            "plan":{"id":"free","name":"Free","storageBytes":1073741824,
            "trafficBytes":5368709120,"retentionSecs":604800,"priceMonthly":0,
            "priceYearly":0,"isTop":false,"subscriptionStatus":"none",
            "subscriptionEnd":0,"billingCycle":"","scheduledPlanId":"",
            "scheduledPlanName":"","scheduledCycle":""}}
            """, as: UsageResponse.self)
        offer("/api/billing/apple/catalog", """
            {"bundleId":"\(bundleID)","products":[
            {"productId":"\(monthlyProductID)","planId":"pro","planName":"Pro",
            "cycle":"monthly","sortOrder":20,
            "storageBytes":5368709120,"trafficBytes":107374182400},
            {"productId":"\(yearlyProductID)","planId":"pro","planName":"Pro",
            "cycle":"yearly","sortOrder":20,
            "storageBytes":5368709120,"trafficBytes":107374182400}],
            "purchase":{"allowed":true,"blockedBy":""},
            "purchases":{"enabled":true,"reason":""}}
            """, as: AppleProductCatalog.self)
        // A purchase token exists only after the server has durably acquired
        // billing authority and created its attempt. The StoreKit fixture must
        // therefore cross the same dispatch boundary as the shipping model.
        offer("/api/billing/apple/purchase-dispatch", """
            {"appAccountToken":"9b64af11-82b1-4fd5-bcc8-7e909465b45a",
            "attemptId":"attempt_uitest"}
            """, as: ApplePurchaseDispatch.self)
        // The transaction intake completes a purchase dispatched by the
        // server-authorized orchestration above.
        offer("/api/billing/apple/transaction", """
            {"applied":true,"planId":"pro","status":"active",
            "expiresAt":4102444800,"provider":"apple",
            "currentProductId":"\(monthlyProductID)",
            "autoRenewProductId":"\(monthlyProductID)","renewalAt":4102444800,
            "dispatchPending":false,"dispatchResolved":true}
            """, as: AppleTransactionResult.self)
        // Two rows, one of them this app's own: a list with a single anonymous
        // entry cannot show that Revoke is per-row, and "Revoke" alone is the
        // same word on every row — which is right to look at and useless to
        // hear. `AccountDevice` decodes the server's PascalCase keys.
        offer("/api/devices", """
            {"devices":[
            {"ID":"dev_this","Name":"\(thisDeviceName)","CreatedAt":1750000000,
            "LastSeenAt":1754600000,"Kind":"app","Current":true},
            {"ID":"dev_other","Name":"\(otherDeviceName)","CreatedAt":1740000000,
            "LastSeenAt":1754000000,"Kind":"cli","Current":false}]}
            """, as: DeviceListResponse.self)
        // One row, in the state a fresh launch is genuinely in: the key for an
        // object uploaded from somewhere else was never on this device, so the
        // link cannot be rebuilt here. That is the row's honest arm, and the one
        // where no hand-off may be offered at all.
        // Sign-out is a POST with no body. Modelled because it is the one way
        // out of a signed-in launch, and an unmodelled endpoint is refused —
        // which would have made a failed sign-out look like a product defect.
        out["/api/auth/logout"] = Data("{}".utf8)
        // Two objects, one of each arm. A row whose key is on this device can be
        // handed on; a row whose key never arrived cannot, and must say so. One
        // row alone would prove only whichever arm it happened to be in.
        offer("/api/files", """
            {"files":[
            {"id":"obj_uitest","size":1536,"createdAt":1754000000,
            "expiresAt":0,"burnAfterRead":false,"downloaded":false,
            "downloadCount":0},
            {"id":"obj_nokey","size":4096,"createdAt":1753000000,
            "expiresAt":0,"burnAfterRead":false,"downloaded":false,
            "downloadCount":0}]}
            """, as: StoredFileListResponse.self)
        return out
    }


    /// The three-step resumable upload, answered in process.
    ///
    /// A stored send is the one flow whose completion surface — the generated
    /// link, its Copy and Share, and Send another — cannot be reached without a
    /// server saying yes. Modelling it keeps the encryption, chunking, manifest
    /// and link construction as production code; only the transport is local.
    /// `received` is derived from the request's own `Content-Range`, so the
    /// uploader's resume arithmetic is exercised rather than short-circuited.
    private func uploadResponse(for url: URL, method: String) -> (Int, Data)? {
        let path = url.path
        if path == "/api/files/obj_uitest/meta", let body = Self.downloadMeta() {
            return (200, body)
        }
        if path == "/api/files/obj_uitest/blob", let body = Self.downloadBlob() {
            return (200, body)
        }
        if path == "/api/uploads", method == "POST" {
            return (200, Data(#"{"uploadId":"up_uitest","chunkSize":1048576}"#.utf8))
        }
        guard path.hasPrefix("/api/uploads/up_uitest") else { return nil }
        if path.hasSuffix("/finalize"), method == "POST" {
            // A far-future expiry, so the completion surface never renders an
            // already-expired link.
            return (200, Data(#"{"id":"obj_uitest","expiresAt":4102444800}"#.utf8))
        }
        if method == "PATCH" {
            // Held open, never answered, so the task stays in flight long enough
            // for a person to press Cancel. `stopLoading` is what ends it, which
            // is exactly what cancelling the upload triggers — so the product
            // path under test is the real one.
            if UITestMode.stallsUpload { Thread.sleep(forTimeInterval: 600) }
            // A server-side failure mid-transfer, which is the one an upload can
            // actually recover from: the staged bytes are still here, so the
            // product should offer to carry on rather than start over.
            if UITestMode.failsUpload { return (500, Data(#"{"error":"server"}"#.utf8)) }
            let range = request.value(forHTTPHeaderField: "Content-Range") ?? ""
            let received = Self.receivedAfter(contentRange: range)
            return (200, Data("{\"received\":\(received)}".utf8))
        }
        if method == "GET" { return (200, Data(#"{"received":0}"#.utf8)) }
        return nil
    }

    /// `bytes from-to/total` → `to + 1`, the byte count the server would hold
    /// after committing exactly what this request carried.
    static func receivedAfter(contentRange: String) -> Int {
        guard let slash = contentRange.firstIndex(of: "/"),
              let dash = contentRange.firstIndex(of: "-") else { return 0 }
        let to = contentRange[contentRange.index(after: dash)..<slash]
        return (Int(to) ?? -1) + 1
    }


    /// A stored object this device can actually decrypt.
    ///
    /// The metadata manifest and optional blob below are produced by the
    /// PRODUCTION encryptor from a fixed key. The iOS runtime test exercises the
    /// metadata/manifest half: if serialization or key handling drifts, opening
    /// the link fails loudly instead of a fixture quietly agreeing with itself.
    /// Blob framing and disk completion are covered by `CloudDownloadModelTests`
    /// and by macOS's runtime test, which actually presses Save. The key is a
    /// literal 32 bytes and the link carries that same value.
    static let downloadFileName = "brief.txt" // nonlocalized: an acceptance fixture
    private static let downloadPlaintext = [UInt8](repeating: 0x52, count: 1_536)

    private static var downloadKey: [UInt8] {
        // base64url → bytes, the same decoding the link parser performs.
        var s = UITestMode.downloadKeyB64url.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        return [UInt8](Data(base64Encoded: s) ?? Data())
    }

    private static func downloadMeta() -> Data? {
        let manifest = StoredManifest(files: [
            ManifestFile(name: downloadFileName, size: downloadPlaintext.count),
        ])
        guard let ct = try? encryptManifest(key: downloadKey, manifest) else { return nil }
        // Hand-written, like the other fixture bodies: `StoredFileMeta` carries
        // no public memberwise initializer, and validating by decoding through
        // it keeps the drift check the literals elsewhere rely on.
        let json = """
            {"encManifest":"\(Data(ct).base64EncodedString())",
            "size":\(downloadPlaintext.count),"burnAfterRead":false,
            "expiresAt":4102444800}
            """
        let data = Data(json.utf8)
        guard (try? JSONDecoder().decode(StoredFileMeta.self, from: data)) != nil else {
            return nil
        }
        return data
    }

    private static func downloadBlob() -> Data? {
        let encryptor = ChunkEncryptor(
            key: downloadKey,
            sources: [DataSource(name: downloadFileName, bytes: downloadPlaintext)])
        var out = Data()
        while let frame = ((try? encryptor.next()) ?? nil) { out.append(frame) }
        return out.isEmpty ? nil : out
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.path.hasPrefix("/api/") ?? false
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if let url = request.url,
           let (status, body) = uploadResponse(for: url, method: request.httpMethod ?? "GET") {
            return respond(url: url, status: status, body: body)
        }
        guard let url = request.url, let body = Self.bodies[url.path] else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        respond(url: url, status: 200, body: body)
    }

    private func respond(url: URL, status: Int, body: Data) {
        let response = HTTPURLResponse(
            url: url, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
#endif

#if DEBUG
/// Mints deterministically and never opens a connection.
private struct UITestPairClient: PairCodeClient {
    func mint(token: String) async throws -> MintedCode {
        if UITestMode.showsTerminalText { throw AccountError.network }
        return MintedCode(code: "483920", expiresAt: 4_102_444_800)
    }
}

/// Fails immediately, so a Nearby task reaches its terminal state at once.
private struct UITestFailingICEClient: ICEConfigClient {
    func fetch(code: String) async throws -> ICEConfig { throw AccountError.network }
}

/// Waits for the rest of the process, so the generated-code screen holds.
private struct UITestWaitingICEClient: ICEConfigClient {
    func fetch(code: String) async throws -> ICEConfig {
        try await Task.sleep(nanoseconds: 300_000_000_000)
        throw AccountError.network
    }
}
#endif
