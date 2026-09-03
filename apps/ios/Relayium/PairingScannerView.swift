import AVFoundation
import SwiftUI
import UIKit
import RelayiumAppKit
import RelayiumKit

/// **What a scan is allowed to produce, and it is never a session.**
///
/// A pairing code and, when the link carried one, the mode the sender started
/// in. Both are hints toward a field the user still has to press Join under —
/// there is deliberately no case here for "and connect".
///
/// `Sendable` because a result crosses `sessionQueue` on its way out: delivery
/// waits inside the queued stop and hops back to the main actor from there.
struct PairingScanResult: Equatable, Sendable {
    let code: String
    let mode: TransferMode?
}

/// **The trust boundary of this whole feature, in one pure function.**
///
/// A QR code is arbitrary attacker-chosen bytes printed by anybody. It arrives
/// with no origin, no signature and no user intent beyond "this rectangle was in
/// front of the camera", which makes it strictly weaker evidence than a tapped
/// Universal Link — the OS at least verified the domain for those.
///
/// So it is admitted through the narrowest gate the app already has, and adds
/// nothing to it:
///
///  1. It must parse as a `URL`. Not a code, not a bare six digits, not a
///     `relayium://` scheme — a scheme is unauthenticated, and accepting one
///     here would give a printed sticker the reach an Associated Domain is
///     supposed to gate.
///  2. It must satisfy `parseAppDeepLink`, which is the SAME policy the
///     Universal Link handler uses: `https`, `relayium.com`, no userinfo, port
///     443 or none, and one of two known paths. Nothing about the scanner
///     widens it, and no second origin list exists in this file to drift from
///     it.
///  3. It must be the realtime arm, WITH a complete six-digit code. A
///     `/cross-network` link with no fragment parses fine and means "open the
///     pairing screen" — which is where the user already is, so as a scan it is
///     nothing. A `/d/` stored-download link is a different feature reached from
///     a different screen, and silently redirecting a scanner into it is exactly
///     the kind of surprise a printed code should not be able to cause.
///
/// A mode hint rides through because `parseAppDeepLink` has already validated
/// it to one of two enum cases; it selects a segmented control the user can
/// immediately change and carries no authority. Anything else — a malformed
/// URL, a foreign host, a five-digit code, a second `c` parameter, plain text,
/// a wall of junk — yields `nil`, and `nil` changes nothing on the screen.
enum PairingScanPolicy {
    /// A QR code can carry a few kilobytes. Nothing this app accepts is longer
    /// than a short URL, so an oversized payload is refused before it reaches
    /// URL parsing rather than after — a bound on adversarial input costs one
    /// comparison and removes a whole class of question about what the parsers
    /// downstream do with megabytes.
    static let maximumPayloadLength = 512

    static func result(for payload: String) -> PairingScanResult? {
        guard !payload.isEmpty, payload.count <= maximumPayloadLength,
              let url = URL(string: payload) else {
            return nil
        }
        switch parseAppDeepLink(url) {
        case let .realtimeWithMode(code, mode):
            return PairingScanResult(code: code, mode: mode)
        case let .realtime(code?):
            return PairingScanResult(code: code, mode: nil)
        // A code-less pairing link, a stored download, and everything the
        // shared policy already refused. None of them is a join code.
        case .realtime(nil), .download, nil:
            return nil
        }
    }
}

/// **One mounted lifetime of the scanner sheet.**
///
/// Every asynchronous step in the model below — the system permission alert, the
/// capture-graph build — resumes at a point where the screen that asked for it
/// may no longer exist, and neither step can be cancelled from outside. So each
/// one carries the activation it started under and compares it against the
/// mounted one before touching published state, the camera, or the caller. The
/// id is monotonic, so a dismissed activation can never be confused with a later
/// one that happens to occupy the same slot.
///
/// `Sendable` because it is also the stamp a queued capture start carries across
/// to `sessionQueue`, where it is compared against `CaptureRunPermit` below.
private struct ScannerActivation: Equatable, Sendable {
    let id: UInt64
}

/// **The permit `sessionQueue` reads one statement before it starts the camera.**
///
/// `startCaptureIfAllowed` proves four things on the main actor and then hands
/// the start to a serial queue, because `startRunning` blocks for long enough to
/// drop frames if it ran on the main thread. Everything it proved was true at
/// ENQUEUE time, and none of it was ever a fact about EXECUTION time: `end()`
/// and `suspend()` also run on the main actor, so both can land entirely inside
/// that gap. The serial queue does order their `stopRunning` behind the queued
/// start, which bounds the damage — but "bounded" here means a camera that turns
/// on after its sheet is gone and is switched off again a whole `startRunning`
/// later, which is precisely what the four checks exist to prevent.
///
/// So the queued block is given no authority of its own. It carries the exact
/// activation it was enqueued for and re-reads this permit under a lock, on the
/// queue, immediately before `startRunning`:
///
///  * **`grant`** is the main actor stamping "this activation may start, as of
///    now". It is written only by `startSession`, one statement after the
///    four-way gate, and before the block that will read it is enqueued — so a
///    block can never observe a permit that has not yet been written for it.
///  * **`revoke`** is the main actor withdrawing that, SYNCHRONOUSLY, before any
///    stop is enqueued. `stopSession` is the single place a stop is scheduled,
///    so the withdrawal cannot be forgotten at a call site: dismissal, the app
///    switcher and delivery all reach it. Withdrawing it afterwards instead
///    would be the same defect one line further along — the queued start would
///    still be authorized, and the serial queue would run it BEFORE the stop.
///  * **`authorizes`** is the execution-time question, and it compares the exact
///    activation rather than asking whether some permit exists. A start enqueued
///    for activation 3 must not be authorized by activation 4's permit: the
///    sheet that asked for it is gone either way, and ids are monotonic so the
///    comparison cannot succeed by accident.
///
/// The lock is held for one field access and never across `startRunning`, so the
/// main actor is never blocked behind the camera.
///
/// **The one window this cannot close, and why it is bounded.** If the recheck
/// has already returned `true` when the main actor revokes, `startRunning` is
/// underway and AVFoundation cannot be asked to abort it. But `authorizes`
/// returning `true` means the revoke had not landed yet, which means the stop
/// that follows it had not been enqueued yet — so FIFO puts that stop directly
/// behind this start, and the camera is off again as soon as `startRunning`
/// returns. Closing even that would mean holding this lock across the blocking
/// call and taking it on the main actor, trading a bounded window for a hang.
private final class CaptureRunPermit: @unchecked Sendable {
    private let lock = NSLock()
    private var granted: ScannerActivation?

    /// Main actor, immediately after the four-way gate passes.
    func grant(_ activation: ScannerActivation) {
        lock.lock()
        granted = activation
        lock.unlock()
    }

    /// Main actor, synchronously, BEFORE a stop is enqueued.
    func revoke() {
        lock.lock()
        granted = nil
        lock.unlock()
    }

    /// `sessionQueue`, immediately before `startRunning`.
    func authorizes(_ activation: ScannerActivation) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return granted == activation
    }
}

/// **The capture delegate, deliberately not the model.**
///
/// `AVCaptureMetadataOutput` delivers on the queue it was handed and keeps
/// delivering for as long as the session runs — several times a second, and more
/// than once per frame when several codes are in view. Three properties have to
/// hold across all of that, and none is expressible on an `ObservableObject`
/// the view also drives:
///
///  * **At most one acceptance, ever.** The latch is taken under a lock rather
///    than on a `@MainActor` hop, because two callbacks can both be in flight
///    before either hop runs, and "we are on the main queue anyway" is a fact
///    about the queue this was installed with rather than a guarantee this type
///    can rely on.
///  * **A refusal must not become a redraw storm.** A junk code held in front of
///    the lens is rejected thirty times a second; republishing that would rebuild
///    the sheet under the user's own typing. Only a payload different from the
///    last refused one is reported.
///  * **A decision belongs to the activation whose camera read it.** Stopping a
///    session does not retract frames already decoded, so a decision can be
///    taken microseconds before dismissal and hop into a main actor where the
///    sheet is gone. Each one is therefore stamped, under the same lock that
///    takes the latch, with the activation this delegate was handed to — and
///    `disown()` drops the stamp so a decision taken after dismissal is refused
///    at the lock rather than at the main actor.
private final class PairingMetadataReceiver: NSObject, AVCaptureMetadataOutputObjectsDelegate {
    enum Decision {
        case accepted(PairingScanResult)
        /// Something was read and it was not a Relayium join code.
        case refused
    }

    private let lock = NSLock()
    /// The activation this delegate currently belongs to, or `nil` between
    /// `disown()` and the next `adopt`. Read under the lock, on the delivery
    /// queue, at the instant the decision is taken.
    private var activation: ScannerActivation?
    private var hasAccepted = false
    private var lastRefusedPayload: String?
    private let onDecision: @MainActor (ScannerActivation, Decision) -> Void

    init(onDecision: @escaping @MainActor (ScannerActivation, Decision) -> Void) {
        self.onDecision = onDecision
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        // Every readable payload in the frame, not just the first. A frame that
        // happens to contain a poster's QR code beside the join code must not
        // be decided by whichever one the detector listed first.
        let payloads = metadataObjects
            .compactMap { $0 as? AVMetadataMachineReadableCodeObject }
            .filter { $0.type == .qr }
            .compactMap(\.stringValue)
        guard !payloads.isEmpty else { return }

        let decision: Decision?
        lock.lock()
        let activation = self.activation
        if activation == nil || hasAccepted {
            // Nothing owns this delegate, so nothing may be told. A frame that
            // was already in the pipeline when the sheet went away stops here.
            decision = nil
        } else if let accepted = payloads.lazy.compactMap(PairingScanPolicy.result(for:)).first {
            hasAccepted = true
            decision = .accepted(accepted)
        } else if let first = payloads.first, first != lastRefusedPayload {
            lastRefusedPayload = first
            decision = .refused
        } else {
            decision = nil
        }
        lock.unlock()

        guard let decision, let activation else { return }
        // Hopped rather than called. This delegate is installed on the main
        // queue, so the hop is one turn — but the isolation is then something
        // the compiler checks rather than something a comment asserts, and the
        // model on the other side stays `@MainActor` with no escape hatch.
        //
        // Two hops cannot race into a second acceptance: the latch above is
        // taken before either is scheduled, and `handle` re-checks its own.
        // The stamp travels with the decision rather than being re-read on the
        // other side, because by then it may describe a different sheet.
        Task { @MainActor in self.onDecision(activation, decision) }
    }

    /// Hand this delegate to a freshly mounted activation, which is also what
    /// lets a new viewfinder refuse a code the previous one refused.
    func adopt(_ activation: ScannerActivation) {
        lock.lock()
        self.activation = activation
        hasAccepted = false
        lastRefusedPayload = nil
        lock.unlock()
    }

    /// Dismissal. Taken before the session is asked to stop, so frames still in
    /// flight are decided into nothing.
    func disown() {
        lock.lock()
        activation = nil
        lock.unlock()
    }
}

/// The camera's authorization and capture lifecycle, as five states a screen can
/// actually draw.
///
/// **Nothing here runs before the user asks for it.** The model is inert until
/// `begin()`, `begin()` is reached only from the scanner sheet, and the sheet is
/// presented only by the Scan control — so `AVCaptureDevice.requestAccess` is
/// separated from app launch by an explicit tap on a button that says what it
/// does. An app that asked at launch would be asking before the user has any way
/// to know why.
@MainActor
final class PairingScannerModel: ObservableObject {
    enum Phase: Equatable {
        /// Nothing has been asked and nothing has been started.
        case idle
        /// The system alert is up, or authorization is being read.
        case requesting
        case running
        /// The four ways this cannot proceed, kept apart because they have four
        /// different remedies and only one of them is Settings.
        case denied
        case restricted
        case unavailable
        case failed
    }

    @Published private(set) var phase: Phase = .idle
    /// Set when a code was read and refused; cleared by the next acceptance or
    /// by leaving the sheet. Never a reason to stop capturing.
    @Published private(set) var refusedSomething = false

    let session = AVCaptureSession()

    /// Session configuration and `startRunning` block for long enough to drop
    /// frames on the main thread, which is why AVFoundation asks for a queue of
    /// one's own. Serial, so configure/start/stop cannot interleave.
    private let sessionQueue = DispatchQueue(label: "com.relayium.pairing-scanner.session")
    /// Carries the main actor's four-way gate across to that queue, because a
    /// gate passed at enqueue time says nothing about execution time.
    private let permit = CaptureRunPermit()
    private var receiver: PairingMetadataReceiver?
    private var isConfigured = false
    /// Set the instant a hand-off is COMMITTED — which is before the hand-off
    /// happens, because delivery waits for the session queue to switch the
    /// camera off first.
    ///
    /// Committing early is what makes that wait safe rather than a second race:
    /// during it, a late hop from a callback already in flight cannot start a
    /// second delivery, and `startCaptureIfAllowed` cannot restart capture
    /// underneath the stop being waited on.
    private var hasDelivered = false

    /// **The activation currently on screen, or `nil` for none.**
    ///
    /// This is the single fact every post-`await` step is required to prove
    /// something about, and the only thing `end()` has to do to make a step
    /// already in flight harmless. It is deliberately not derived from `phase`:
    /// `phase` describes what the sheet draws and is written by those very
    /// steps, so a step cannot use it to ask whether it is still allowed to
    /// write it.
    private var mounted: ScannerActivation?
    /// Monotonic, so an id is never reused and a stale comparison can never
    /// accidentally succeed against a later mount.
    private var activationsBegun: UInt64 = 0
    /// Whether the scene is in the foreground. Written by `suspend()`/`resume()`
    /// and read by the one function allowed to start capture, so an answer that
    /// arrives from the permission alert or the configure queue while the app is
    /// behind the app switcher cannot turn the camera on there.
    private var isSceneActive = true

    private let onResult: (PairingScanResult) -> Void

    init(onResult: @escaping (PairingScanResult) -> Void) {
        self.onResult = onResult
    }

    // MARK: - lifecycle

    /// Called from the sheet, which the Scan button presents. This is the whole
    /// distance between the user's intent and the system prompt.
    func begin() async {
        // One activation at a time: a second `.task` while the first is still
        // waiting on the system alert would ask twice and race itself.
        guard mounted == nil, phase == .idle || phase == .failed else { return }
        activationsBegun += 1
        let activation = ScannerActivation(id: activationsBegun)
        mounted = activation

        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            await configureAndStart(activation)
        case .notDetermined:
            phase = .requesting
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            // The alert outlives the sheet. `requestAccess` cannot be
            // cancelled, and SwiftUI cancelling this `.task` on disappear does
            // not touch it, so Cancel or a swipe while the alert is up resumes
            // here with an answer about a screen that is gone. Publishing it or
            // acting on it would be the camera turning on with nothing on
            // screen that asked for it.
            guard isMounted(activation) else { return }
            guard granted else {
                phase = .denied
                return
            }
            await configureAndStart(activation)
        case .denied:
            phase = .denied
        case .restricted:
            phase = .restricted
        @unknown default:
            // An authorization state this build does not know is not a grant.
            phase = .denied
        }
    }

    /// Backgrounding, a phone call, another sheet: the camera goes off and the
    /// screen says nothing false about it. Resuming re-enters through the same
    /// start path rather than assuming the session survived.
    ///
    /// Unconditional on purpose. The old `phase == .running` guard made this a
    /// no-op during `.requesting`, which is exactly the window in which a
    /// permission answer is about to try to start capture — so leaving the
    /// foreground had to be recorded, not just acted on.
    ///
    /// Recording it stops a start that has not been enqueued yet. `stopSession`
    /// revoking the run permit is what stops one that already has.
    func suspend() {
        isSceneActive = false
        stopSession()
    }

    /// Coming back may restart the session this activation already configured,
    /// which is the one late start that IS legitimate. It still goes through the
    /// same gate as every other, so it cannot start one for a dismissed sheet.
    func resume() async {
        isSceneActive = true
        startCaptureIfAllowed()
    }

    /// Dismissal, and the result path. Idempotent, and the only place the
    /// session is torn down for good.
    ///
    /// Clearing `mounted` is what makes it permanent: every suspended step
    /// above compares against it, `startCaptureIfAllowed` refuses without it,
    /// and `handle` drops decisions stamped with it. Nothing here can be undone
    /// by a continuation resuming afterwards — only by a new `begin()`, which
    /// takes a new id.
    ///
    /// A start already sitting on `sessionQueue` is not a continuation and does
    /// not read `mounted` at all, so clearing it is not enough for that one:
    /// `stopSession` revokes the run permit synchronously, on this actor, before
    /// it schedules anything.
    func end() {
        mounted = nil
        receiver?.disown()
        stopSession()
        refusedSomething = false
        if !hasDelivered { phase = .idle }
    }

    /// Whether the step that started under `activation` is still the one on
    /// screen.
    private func isMounted(_ activation: ScannerActivation) -> Bool {
        mounted == activation
    }

    // MARK: - capture

    private func configureAndStart(_ activation: ScannerActivation) async {
        var configured = isConfigured
        if !configured {
            let receiver = self.receiver ?? makeReceiver()
            let session = self.session
            configured = await withCheckedContinuation { continuation in
                sessionQueue.async {
                    continuation.resume(returning: Self.configure(session, delegate: receiver))
                }
            }
            // A fact about `session`, not about the sheet: the graph stands
            // whether or not the activation that built it is still mounted, and
            // a later one may start it without building a second.
            if configured { isConfigured = true }
        }
        // Reached only across a suspension — the configure above, or the call
        // itself — and `end()` runs on this actor the moment one opens. So
        // nothing below this line may be assumed about the screen.
        guard isMounted(activation) else { return }
        guard configured else {
            // A device with no usable camera and a device whose camera refused
            // to open are different sentences, and the user can act on neither
            // by opening Settings.
            phase = Self.hasAVideoCamera ? .failed : .unavailable
            return
        }
        receiver?.adopt(activation)
        phase = .running
        startCaptureIfAllowed()
    }

    /// One delegate per model, built on first use rather than at init, so that
    /// nothing exists to receive frames before the user has asked for any.
    private func makeReceiver() -> PairingMetadataReceiver {
        let receiver = PairingMetadataReceiver { [weak self] activation, decision in
            self?.handle(decision, from: activation)
        }
        self.receiver = receiver
        return receiver
    }

    /// **The only place capture is allowed to start.**
    ///
    /// Four facts have to hold at the same instant, and each of them can have
    /// changed while some `await` above was suspended: a sheet is on screen, the
    /// app is in the foreground, the graph exists, and no result has been
    /// committed. Funnelling every start through one gate is what makes that
    /// reviewable — the alternative is four call sites each remembering four
    /// conditions, which is how the permission-wait and configure-wait races got
    /// in.
    ///
    /// **This proves them at enqueue time, and enqueue time is not when the
    /// camera turns on.** All four are main-actor state, so this gate is exact
    /// at the instant it runs and says nothing about the instant `startRunning`
    /// executes on `sessionQueue`. The mounted activation is therefore bound
    /// here rather than merely tested, and handed to `startSession` as the stamp
    /// the queued block must re-present — see `CaptureRunPermit`.
    private func startCaptureIfAllowed() {
        guard let activation = mounted, isSceneActive, isConfigured, !hasDelivered else { return }
        startSession(activation)
    }

    /// Whether this hardware has a camera at all — the simulator and an iPad
    /// with a covered/absent device both land here.
    private static var hasAVideoCamera: Bool {
        AVCaptureDevice.default(for: .video) != nil
    }

    /// Runs on `sessionQueue`. Returns whether the session can actually scan.
    ///
    /// `metadataObjectTypes` is set AFTER the output joins the session on
    /// purpose: before that the output advertises no available types and the
    /// assignment is dropped, which yields a running camera that never reports a
    /// single code.
    ///
    /// Idempotent, and that is load-bearing rather than tidy: two activations
    /// can both find `isConfigured == false` and both enqueue this, and a second
    /// `addInput` on a session that already has a video one is refused by
    /// `canAddInput` — which would turn a fast dismiss-and-reopen into a
    /// permanent `.failed` on a camera that works. The serial queue orders the
    /// two calls, so the second one sees the first one's graph and joins it.
    ///
    /// `nonisolated` because it is true: this runs on `sessionQueue`, never on
    /// the main actor. Inheriting the type's `@MainActor` made the compiler
    /// warn on every call — the isolation the annotation claimed was one the
    /// call site did not honour — and a build that warns about where its
    /// concurrency actually runs is a poor place to reason about a lifecycle
    /// race. It touches nothing but its two parameters, so saying so costs
    /// nothing.
    private nonisolated static func configure(
        _ session: AVCaptureSession,
        delegate: AVCaptureMetadataOutputObjectsDelegate
    ) -> Bool {
        if let output = session.outputs.compactMap({ $0 as? AVCaptureMetadataOutput }).first {
            output.setMetadataObjectsDelegate(delegate, queue: .main)
            return output.metadataObjectTypes.contains(.qr)
        }
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera,
                                                   for: .video, position: .back)
                ?? AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else {
            return false
        }
        let output = AVCaptureMetadataOutput()

        session.beginConfiguration()
        defer { session.commitConfiguration() }
        // Enough resolution to read a code across a desk, and deliberately not
        // more: this is the smallest preset that does the job, and a larger one
        // costs battery and thermal headroom on the oldest supported hardware
        // for no additional codes read.
        if session.canSetSessionPreset(.hd1280x720) {
            session.sessionPreset = .hd1280x720
        }
        guard session.canAddInput(input), session.canAddOutput(output) else { return false }
        session.addInput(input)
        session.addOutput(output)
        guard output.availableMetadataObjectTypes.contains(.qr) else { return false }
        output.metadataObjectTypes = [.qr]
        output.setMetadataObjectsDelegate(delegate, queue: .main)
        return true
    }

    /// **Enqueue-time proof, stamped here and re-proven where it is spent.**
    ///
    /// The caller has just established, on the main actor, that `activation` is
    /// mounted, foreground, configured and undelivered. That is the whole reason
    /// a permit may be stamped, and it is stamped BEFORE the block is enqueued
    /// so the block cannot run against a permit not yet written for it.
    ///
    /// Everything after `sessionQueue.async` happens at an unknown later time on
    /// another thread, with the main actor free to run `end()`, `suspend()` or a
    /// delivery in between — and each of those calls `stopSession`, which revokes
    /// synchronously. So the block asks again, holding the exact activation it
    /// was enqueued for, one statement before the camera turns on. A revoke that
    /// landed anywhere in the gap makes this a no-op instead of a camera running
    /// with nothing on screen that asked for it.
    private func startSession(_ activation: ScannerActivation) {
        let permit = self.permit
        let session = self.session
        permit.grant(activation)
        sessionQueue.async {
            // Execution time. Not the gate above, and not a re-read of main-actor
            // state — the stamp travels with the block, so a LATER activation's
            // permit cannot authorize this older start either.
            guard permit.authorizes(activation) else { return }
            guard !session.isRunning else { return }
            session.startRunning()
        }
    }

    /// Stopping withdraws the permit first, on the main actor, synchronously.
    ///
    /// The order is the invariant rather than a tidiness: a revoke that happened
    /// after the stop was scheduled would leave a start already sitting in the
    /// queue still authorized, and a serial queue runs it BEFORE this stop —
    /// turning the camera on and leaving it on. Doing it here rather than at each
    /// call site is what makes it hold for all three: dismissal, the app switcher
    /// and delivery.
    ///
    /// **`then` exists because scheduling a stop is not stopping one.**
    /// Everything this function does after `permit.revoke()` is scheduling:
    /// `stopRunning` blocks, which is the whole reason it is on this queue, so a
    /// caller that simply continued on the next line would run while the stop
    /// was still sitting in the queue. `then` is therefore the last statement
    /// INSIDE the enqueued block — after the stop has been performed, or after
    /// the queue has observed the session was already stopped, which is the same
    /// fact about the camera — and it hops to the main actor from there rather
    /// than being run on the queue.
    ///
    /// A hop and not a `sessionQueue.sync`, on purpose: waiting would block the
    /// main thread behind `stopRunning` and behind any configure or start
    /// already queued ahead of it. The hop costs one turn of the main actor, and
    /// during that turn `end()` may run — so a `then` that touches the sheet has
    /// to prove its activation again, exactly as every other resumed step does.
    ///
    /// The window this does not close is the one `CaptureRunPermit` names: a
    /// `startRunning` already underway keeps the camera on until it returns.
    /// FIFO puts this stop directly behind it, so `then` still runs after the
    /// stop rather than after the start.
    private func stopSession(then deliver: (@MainActor @Sendable () -> Void)? = nil) {
        permit.revoke()
        let session = self.session
        sessionQueue.async {
            if session.isRunning { session.stopRunning() }
            guard let deliver else { return }
            Task { @MainActor in deliver() }
        }
    }

    // MARK: - results

    private func handle(_ decision: PairingMetadataReceiver.Decision,
                        from activation: ScannerActivation) {
        // A decision was taken on the delivery queue and stamped there. By the
        // time its hop runs, the sheet it was read for may be gone — and a
        // result delivered then would fill the join field from a camera the
        // user had already dismissed, while a refusal would publish onto a
        // screen that is no longer showing a viewfinder.
        guard isMounted(activation) else { return }
        switch decision {
        case let .accepted(result):
            guard !hasDelivered else { return }
            hasDelivered = true
            refusedSomething = false
            // The camera is off before the caller is told, and "off" here means
            // the session queue has performed the stop — not that one was
            // scheduled. `stopSession` only revokes and enqueues, so telling the
            // caller on the next line would dismiss the sheet with a
            // `stopRunning` still queued behind it: the camera switching off
            // DURING the dismissal rather than before it.
            stopSession { [weak self] in
                guard let self else { return }
                // One main-actor turn later, and the stop it waited on took an
                // unbounded moment before that. A Cancel or a swipe anywhere in
                // that window clears `mounted`, and filling the join field from
                // a sheet the user has just dismissed is the defect the guard
                // at the top of this function refuses — the same one, arriving
                // one hop later.
                guard self.isMounted(activation) else { return }
                self.onResult(result)
            }
        case .refused:
            guard !hasDelivered else { return }
            refusedSomething = true
        }
    }
}

/// The live camera, as a layer-backed view.
///
/// `layerClass` rather than a sublayer the view has to keep resized by hand:
/// the preview layer IS the view's layer, so rotation, split view and the
/// keyboard resizing the sheet are handled by ordinary layout.
private struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        view.backgroundColor = .black
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {
        guard view.previewLayer.session !== session else { return }
        view.previewLayer.session = session
    }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

        /// Forced, and safe by construction: `layerClass` above is what UIKit
        /// instantiates this view's layer from, so the cast can only fail if
        /// that line changed — which is a programmer error rather than a state
        /// a fallback could do anything useful with.
        var previewLayer: AVCaptureVideoPreviewLayer {
            // swiftlint:disable:next force_cast
            layer as! AVCaptureVideoPreviewLayer
        }

        /// Keep the preview upright. Detection itself does not care which way up
        /// the code is, but a preview rotated away from the device makes aiming
        /// impossible, which is the same failure from the user's side.
        override func layoutSubviews() {
            super.layoutSubviews()
            guard let connection = previewLayer.connection else { return }
            let orientation = window?.windowScene?.interfaceOrientation ?? .portrait
            if #available(iOS 17.0, *) {
                let angle = Self.rotationAngle(for: orientation)
                if connection.isVideoRotationAngleSupported(angle) {
                    connection.videoRotationAngle = angle
                }
            } else if connection.isVideoOrientationSupported,
                      let video = Self.videoOrientation(for: orientation) {
                connection.videoOrientation = video
            }
        }

        @available(iOS 17.0, *)
        private static func rotationAngle(for orientation: UIInterfaceOrientation) -> CGFloat {
            switch orientation {
            case .landscapeLeft: return 180
            case .landscapeRight: return 0
            case .portraitUpsideDown: return 270
            default: return 90
            }
        }

        private static func videoOrientation(
            for orientation: UIInterfaceOrientation
        ) -> AVCaptureVideoOrientation? {
            switch orientation {
            case .landscapeLeft: return .landscapeLeft
            case .landscapeRight: return .landscapeRight
            case .portraitUpsideDown: return .portraitUpsideDown
            case .portrait: return .portrait
            default: return nil
            }
        }
    }
}

/// **Reading the other device's join code with the camera.**
///
/// The sending half of this already exists: `DirectView` draws the code as six
/// digits and as a QR join link, and the receiving half was "type them in". On a
/// phone held next to a laptop that is the slowest part of the whole product,
/// and it is the part that goes wrong — a transposed digit fails with the same
/// message as an expired code.
///
/// Three things about this screen are structural, and each is a decision the
/// blocker record in `docs/ios-app-store-submission.md` turns on:
///
/// **The camera is asked for here and nowhere else.** There is one
/// `AVCaptureDevice.requestAccess` in the app, it is behind `begin()`, and
/// `begin()` is reached only from this sheet, which only the Scan control
/// presents. The purpose string the system draws describes exactly this.
///
/// **Every refusal keeps the six digits usable.** Denied, restricted, no camera
/// and a failed start each say what is true and name typing as the way on; the
/// field they point at is still on the screen underneath, untouched. Nothing
/// here disables it, and dismissing this sheet always lands back on it.
///
/// **A scan fills a field.** The result goes to the caller, which normalizes it
/// into the same binding the keyboard writes. There is no path from this file to
/// `join`.
struct PairingScannerView: View {
    let onResult: (PairingScanResult) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model: PairingScannerModel

    init(onResult: @escaping (PairingScanResult) -> Void) {
        self.onResult = onResult
        // The closure is captured by the model, so it is built here rather than
        // in `body`: a `StateObject` built from a view value would be rebuilt on
        // every redraw, and rebuilding this one restarts a camera session.
        _model = StateObject(wrappedValue: PairingScannerModel(onResult: onResult))
    }

    var body: some View {
        NavigationStack {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .navigationTitle(L10n.t(.pairingScanTitle))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(L10n.t(.commonCancel)) { dismiss() }
                    }
                }
        }
        .task { await model.begin() }
        // Dismissal by any route — Cancel, the swipe, or the successful scan
        // below — goes through one teardown.
        .onDisappear { model.end() }
        .onChange(of: scenePhase) { phase in
            // The camera must not keep running behind the app switcher, and it
            // must come back when the user does.
            if phase == .active {
                Task { await model.resume() }
            } else {
                model.suspend()
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .idle, .requesting:
            ProgressView { Text(L10n.t(.pairingScanRequesting)) }
        case .running:
            viewfinder
        // Four states, four sentences, and two headings — the permission pair
        // and the hardware pair are different diagnoses, and offering Settings
        // for a device with no camera would be advice that cannot work.
        case .denied:
            unavailable(title: L10n.t(.pairingScanDeniedTitle),
                        message: L10n.t(.pairingScanDeniedBody),
                        offersSettings: true)
        case .restricted:
            unavailable(title: L10n.t(.pairingScanDeniedTitle),
                        message: L10n.t(.pairingScanRestrictedBody),
                        offersSettings: false)
        case .unavailable:
            unavailable(title: L10n.t(.pairingScanUnavailableTitle),
                        message: L10n.t(.pairingScanUnavailableBody),
                        offersSettings: false)
        case .failed:
            unavailable(title: L10n.t(.pairingScanUnavailableTitle),
                        message: L10n.t(.pairingScanFailedBody),
                        offersSettings: false)
        }
    }

    private var viewfinder: some View {
        VStack(spacing: Metrics.inner) {
            CameraPreview(session: model.session)
                .clipShape(RoundedRectangle(cornerRadius: Metrics.corner, style: .continuous))
                // Live video carries no text, so without this VoiceOver reaches
                // an unlabelled rectangle and the screen has no content at all.
                .accessibilityElement()
                .accessibilityLabel(L10n.t(.pairingScanViewfinderLabel))
                .accessibilityHint(L10n.t(.pairingScanHint))
            Text(L10n.t(.pairingScanHint))
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            // Said only after something was actually read and refused. Silence
            // would be indistinguishable from a camera that is not working.
            if model.refusedSomething {
                InlineMessage(.warning, L10n.t(.pairingScanRejected))
            }
        }
        .padding()
    }

    /// One shape for all four ways this cannot scan. The sentence differs; the
    /// structure — what is true, then the way on — does not.
    private func unavailable(title: String,
                             message: String,
                             offersSettings: Bool) -> some View {
        VStack(alignment: .leading, spacing: Metrics.inner) {
            SectionCard(title) {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if offersSettings, let settings = URL(string: UIApplication.openSettingsURLString) {
                    Link(destination: settings) {
                        Text(L10n.t(.pairingScanOpenSettings)).frame(maxWidth: .infinity)
                    }
                    .borderedAction()
                    .controlSize(.large)
                }
                // The way back to the field that still works, named rather than
                // left to the navigation bar.
                Button { dismiss() } label: {
                    Text(L10n.t(.commonDone)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
            Spacer(minLength: 0)
        }
        .padding()
    }
}
