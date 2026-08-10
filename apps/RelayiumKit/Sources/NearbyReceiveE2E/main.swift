import Foundation
import RelayiumAppKit
import RelayiumKit
import WebRTC

// Live PASSIVE-RECEIVE E2E over the production signalling hub.
//
// The existing RealtimeE2E harness builds both peers by hand, which proves the
// transport but says nothing about the thing that actually has to work for a
// user: the app is sitting there, nobody has clicked anything, an offer arrives,
// and it is answered. That path runs through the residency socket, the
// persistent signal listener, the offer classifier, the inbound reservation, the
// buffer handoff and the real `RealtimeSessionModel` — none of which the manual
// harness touches.
//
// So the RECEIVER here is the app's own machinery, assembled exactly as
// `RelayiumApp` assembles it (`AppEnvironment.make*`), and the SENDER is a plain
// peer that dials it. Nothing clicks Accept; nothing selects a device.
//
//   swift run NearbyReceiveE2E [baseURL]                  in-process, self-contained
//   swift run NearbyReceiveE2E [baseURL] --send-to NAME   sender-only, see below
//
// Not a unit test — needs the network.
//
// ⚠️ The two modes differ in what they touch:
//
// * Default (in-process) mode mutates nothing outside this process. It joins the
//   ephemeral code-less rendezvous room, mints nothing, and its receiver writes
//   into a temporary directory it deletes on the way out.
// * `--send-to` mode sends a real file to a real running Relayium.app, which
//   writes it to THAT MAC'S REAL DOWNLOADS FOLDER — passive receive has no
//   prompt, which is the property being evidenced. The file is named per run
//   (`nearby-receive-e2e-<runTag>.txt`) so it can never collide with, or be
//   confused for, an earlier run's leftover, and the exact path to delete is
//   printed. This process cannot clean it up: it is on the receiving side.

func log(_ message: String) {
    FileHandle.standardError.write(Data("[\(Date())] \(message)\n".utf8))
}

let arguments = Array(CommandLine.arguments.dropFirst())

/// Options that take a separate value. Parsing has to know about them, or the
/// value is left looking like the positional base URL: `--send-to "MacBook Pro"`
/// used to make "MacBook Pro" the first argument not starting with `--`, and
/// therefore the base URL — which `URL(string:)` rejects for a name with a
/// space (crashing on the force-unwrap) and silently accepts as a relative URL
/// for one without, dialling nowhere.
private let valuedOptions: Set<String> = ["--send-to"]

private func parseArguments(_ arguments: [String]) -> (baseURL: String?, sendTo: String?) {
    var sendTo: String?
    var positional: [String] = []
    var index = 0
    while index < arguments.count {
        let argument = arguments[index]
        if valuedOptions.contains(argument) {
            guard index + 1 < arguments.count else {
                log("\(argument) needs a value")
                exit(2)
            }
            if argument == "--send-to" { sendTo = arguments[index + 1] }
            index += 2
            continue
        }
        if argument.hasPrefix("--") {
            index += 1
            continue
        }
        positional.append(argument)
        index += 1
    }
    return (positional.first, sendTo)
}

/// Rejected rather than force-unwrapped: a bad argument should say what is wrong
/// with it, not trap.
private func requireBaseURL(_ raw: String) -> URL {
    guard let url = URL(string: raw), let scheme = url.scheme,
          scheme == "http" || scheme == "https", url.host != nil else {
        log("not a usable base URL: \"\(raw)\" — expected e.g. https://relayium.com")
        exit(2)
    }
    return url
}

private let parsed = parseArguments(arguments)
let baseURL = requireBaseURL(parsed.baseURL ?? "https://relayium.com")
/// `--send-to <device name>` runs only the sender half, against a device already
/// in the room — the actual Relayium.app, launched and left alone. That is the
/// one thing an in-process receiver cannot evidence: that the SHIPPED app starts
/// residency on its own and answers an offer nobody there accepted.
let sendTo: String? = parsed.sendTo
let runTag = String(UUID().uuidString.prefix(8)).lowercased()
let receiverName = sendTo ?? "e2e-receiver-\(runTag)"
let senderName = "e2e-sender-\(runTag)"
let payload = Array("passive nearby receive :: the quick brown fox jumps over 0123456789".utf8)
/// Per run. In `--send-to` mode this lands in somebody's real Downloads folder,
/// where a fixed name would silently overwrite the previous run's evidence — and
/// leave a file nobody can attribute to a particular run.
let fileName = "nearby-receive-e2e-\(runTag).txt"
/// The flat single-file offer `--send-to` mode uses, unchanged.
let flatBatch: [(meta: FileMeta, bytes: [UInt8])] = [
    (FileMeta(name: fileName, size: payload.count, path: nil), payload),
]
/// The in-process offer: a loose file beside a two-level folder, i.e. a batch
/// with no single root — so the receiver has to build its fallback container AND
/// reconstruct the nested paths inside it. Distinct bytes per file, so a writer
/// that split the stream at the wrong boundary cannot pass.
let treeRoot = "tree-\(runTag)"
let mixedBatch: [(meta: FileMeta, bytes: [UInt8])] = [
    (FileMeta(name: fileName, size: payload.count, path: nil), payload),
    (FileMeta(name: "a.bin", size: 3, path: "\(treeRoot)/day1/a.bin"), [0xA1, 0xA2, 0xA3]),
    (FileMeta(name: "b.bin", size: 0, path: "\(treeRoot)/day1/empty/b.bin"), []),
    (FileMeta(name: "c.bin", size: 5, path: "\(treeRoot)/day2/c.bin"), [1, 2, 3, 4, 5]),
]
// Same-machine peers pair on host candidates; a public STUN helps gathering on
// some networks. No TURN: the receiving side is STUN-only by construction and a
// relay would make this test prove the wrong thing.
let senderICE = [RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])]

let outcome = Outcome()

final class Outcome: @unchecked Sendable {
    private let lock = NSLock()
    private var result: String?
    private let group = DispatchGroup()
    init() { group.enter() }
    func finish(_ value: String) {
        lock.lock()
        let first = result == nil
        if first { result = value }
        lock.unlock()
        if first { group.leave() }
    }
    func wait(then body: @escaping (String) -> Void) {
        group.notify(queue: .main) { [self] in
            lock.lock(); let value = result ?? "FAIL: no result"; lock.unlock()
            body(value)
        }
    }
}

// MARK: - the sender (a plain peer, not the app)

final class Sender: @unchecked Sendable {
    let signaling: SignalingClient
    private let lock = NSLock()
    private var fileConnection: RealtimeConnection?
    private var textConnection: RealtimeConnection?
    private var _peerId: String?
    private var _fileSAS: String?
    private var _textSAS: String?
    private var _sawComplete = false
    private var _textAccepted = false
    private var _textReady = false
    private var _textSent = false
    private var _fileClosed = false
    private var trace: SignalSubscription?
    private var fileCloseWaiters: [() -> Void] = []

    var peerId: String? { lock.lock(); defer { lock.unlock() }; return _peerId }
    var fileSAS: String? { lock.lock(); defer { lock.unlock() }; return _fileSAS }
    var textSAS: String? { lock.lock(); defer { lock.unlock() }; return _textSAS }
    var sawComplete: Bool { lock.lock(); defer { lock.unlock() }; return _sawComplete }
    var textAccepted: Bool { lock.lock(); defer { lock.unlock() }; return _textAccepted }

    init() {
        signaling = SignalingClient.connect(
            wsBase: RealtimeConnectionFactory.signalingBase(baseURL),
            code: "",                       // the code-less room: no mint, no TURN
            name: senderName)
        // Uses the very primitive this round adds: a listener that coexists with
        // whatever connection currently owns `onSignal`, here purely as a trace
        // of what the wire actually carried.
        let subscription = signaling.addSignalListener { from, data in
            var kinds: [String] = []
            if let sdp = parseSDP(data) { kinds.append("sdp:\(sdp.type)") }
            if parseICE(data) != nil { kinds.append("ice") }
            if peerCommit(from: data) != nil { kinds.append("commit") }
            if peerReveal(from: data) != nil { kinds.append("reveal") }
            if parseBusy(data) { kinds.append("busy") }
            if !peerCaps(from: data).isEmpty { kinds.append("caps") }
            log("sender: <- \(kinds.isEmpty ? ["?"] : kinds) gen=\(signalGeneration(data)) from=\(from)")
        }
        trace = subscription
        signaling.onSelfId = { id, ip in log("sender: self=\(id) ip=\(ip)") }
        signaling.onClose = { log("sender: signalling closed") }
        signaling.onPeers = { [weak self] peers in
            guard let self,
                  let target = peers.first(where: { $0.name == receiverName }) else { return }
            self.lock.lock()
            let first = self._peerId == nil
            if first { self._peerId = target.id }
            self.lock.unlock()
            guard first else { return }
            log("sender: found receiver peer=\(target.id)")
        }
    }

    /// Phase 1: an unsolicited FILE offer. Nothing on the far side is expecting
    /// it and nobody there clicks anything.
    ///
    /// `batch` is what the offer carries. The in-process run sends a MIXED batch
    /// — a loose file beside a two-level folder — so the live path proves the
    /// thing unit tests cannot: that a real peer's `FileMeta.path` survives
    /// signalling, the handshake, the DataChannel and the receiver's writer as a
    /// rebuilt directory tree with the right bytes in the right leaves.
    /// `--send-to` mode keeps the single flat file, because that one lands in
    /// somebody's real Downloads folder and the printed cleanup line has to stay
    /// exactly true.
    func sendFile(to peerId: String, batch: [(meta: FileMeta, bytes: [UInt8])]) {
        let connection = RealtimeConnection(signaling: signaling, peerId: peerId,
                                            role: .initiator, iceServers: senderICE)
        lock.lock(); fileConnection = connection; lock.unlock()
        connection.onSAS = { [weak self] value in
            log("sender: file SAS=\(value)")
            guard let self else { return }
            lock.lock(); _fileSAS = value; lock.unlock()
        }
        connection.onOpen = {
            log("sender: file channel open — sending")
            // send() does a queue.sync internally, so it must not run on the
            // connection's own callback queue.
            DispatchQueue.global().async {
                connection.send(
                    sources: batch.map { DataSource(name: $0.meta.name, bytes: $0.bytes) },
                    metas: batch.map(\.meta))
            }
        }
        connection.onControl = { [weak self] control in
            log("sender: file control \(control)")
            guard let self, control == .complete else { return }
            lock.lock(); _sawComplete = true; lock.unlock()
        }
        connection.onError = { error in outcome.finish("FAIL: sender file \(error)") }
        connection.onClose = { [weak self] in
            log("sender: file connection closed")
            guard let self else { return }
            lock.lock()
            let waiters = fileCloseWaiters
            fileCloseWaiters = []
            _fileClosed = true
            lock.unlock()
            for waiter in waiters { waiter() }
        }
        connection.start()
    }

    /// Retires the file connection and waits for it to actually be gone.
    ///
    /// This used to be load-bearing for a reason that was itself a bug, and the
    /// note here described the app's position wrongly. `SignalingClient` has ONE
    /// `onSignal` slot; a `RealtimeConnection` claims it when it is built and
    /// gives it back on close. That clear used to be unconditional, so a file
    /// connection closing after a text connection had been built erased the text
    /// connection's handler: its peer's reveal vanished, and no SAS was ever
    /// derived. Sequencing the two was a way to avoid that ordering.
    ///
    /// The app was NOT exempt. Its persistent router is a subscription rather
    /// than the slot, so the router survived — but the app's own overlapping
    /// connections used the same slot and the same unconditional clear, and a
    /// stale close deafened the live session exactly as it did here. That is
    /// fixed at the source now: the slot is claimed with a token and released
    /// only by its current owner (`SignalingClient.installSignalHandler`).
    ///
    /// This is kept because it is still the right shape for a plain peer holding
    /// one socket — the two sessions are sequential by intent, and retiring the
    /// first makes that explicit rather than relying on the ownership rule to
    /// paper over an overlap nobody wanted.
    func retireFileConnection() async {
        // The lock work stays in a synchronous helper: taking an NSLock across a
        // suspension point is exactly the thing the concurrency checker warns
        // about, and here it is trivially avoidable.
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            guard let connection = beginFileRetirement(resume: { continuation.resume() }) else {
                continuation.resume()
                return
            }
            connection.close()
        }
    }

    /// Returns the connection to close, or nil when there is nothing to wait for.
    private func beginFileRetirement(resume: @escaping () -> Void) -> RealtimeConnection? {
        lock.lock(); defer { lock.unlock() }
        guard let connection = fileConnection, !_fileClosed else { return nil }
        fileCloseWaiters.append(resume)
        return connection
    }

    /// Phase 2: an unsolicited TEXT offer. It carries exact `text/1` alongside
    /// its SDP, which is what the receiver's classifier requires before it will
    /// answer at all.
    func openText(to peerId: String, body: String) {
        let connection = RealtimeConnection(
            signaling: signaling, peerId: peerId, role: .initiator,
            iceServers: senderICE, iceTransportPolicy: .all,
            generation: .text, localCapabilities: [TEXT_CAPABILITY])
        lock.lock(); textConnection = connection; lock.unlock()
        connection.onSAS = { [weak self] value in
            log("sender: text SAS=\(value)")
            guard let self else { return }
            lock.lock(); _textSAS = value; lock.unlock()
        }
        connection.onOpen = { [weak self] in
            // The initiator's own confirmation. With verification off this is
            // not a prompt anybody sees; it is what enables decryption — and it
            // is only reachable once the handshake has produced keys, which is
            // exactly why the send below cannot be triggered by ACCEPT alone.
            connection.confirmTextSAS()
            guard let self else { return }
            lock.lock(); _textReady = true; lock.unlock()
            self.sendTextIfReady(on: connection, body: body)
        }
        connection.onControl = { [weak self] control in
            log("sender: text control \(control)")
            guard let self, control == .accept else { return }
            lock.lock(); _textAccepted = true; lock.unlock()
            self.sendTextIfReady(on: connection, body: body)
        }
        connection.onError = { error in outcome.finish("FAIL: sender text \(error)") }
        connection.onClose = { log("sender: text connection closed") }
        connection.start()
    }

    /// ACCEPT and "this side can actually encrypt" arrive in either order, and
    /// both are required. The app's own model has the same two-sided wait; a
    /// harness that sends on ACCEPT alone races the handshake and fails
    /// `notReady` roughly whenever the peer is fast.
    private func sendTextIfReady(on connection: RealtimeConnection, body: String) {
        lock.lock()
        let go = _textAccepted && _textReady && !_textSent
        if go { _textSent = true }
        lock.unlock()
        guard go else { return }
        connection.sendText(body) { error in
            if let error { outcome.finish("FAIL: sender sendText \(error)") }
        }
    }

    func close() {
        lock.lock()
        let file = fileConnection
        let text = textConnection
        lock.unlock()
        file?.close()
        text?.close()
        signaling.close()
    }
}

// MARK: - the receiver (the app's own machinery)

@MainActor
final class Receiver {
    let discovery: LanDiscoveryModel
    let fileModel: RealtimeSessionModel
    let textModel: RealtimeTextSessionModel
    let receive: NearbyReceiveModel
    let saveDirectory: URL
    private let defaultsSuite: String
    private let defaults: UserDefaults

    init() throws {
        saveDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("relayium-nearby-e2e-\(runTag)")
        try FileManager.default.createDirectory(at: saveDirectory, withIntermediateDirectories: true)

        // A throwaway defaults domain: the preference must stay at its shipped
        // default (verification OFF) without touching whatever the person
        // running this has chosen.
        defaultsSuite = "com.relayium.nearby-e2e.\(runTag)"
        defaults = UserDefaults(suiteName: defaultsSuite)!
        let verification = VerificationPreference(defaults: defaults)

        // The room socket, under a name the sender can find. Everything else is
        // assembled exactly as RelayiumApp assembles it.
        discovery = LanDiscoveryModel(connect: {
            SignalingClient.connect(
                wsBase: RealtimeConnectionFactory.signalingBase(baseURL),
                code: "",
                name: receiverName)
        })
        let inboundRoom = InboundRoom()
        fileModel = AppEnvironment.makeRealtimeModel(
            baseURL: baseURL, verification: verification,
            nearby: discovery, inboundRoom: inboundRoom,
            // This harness drives the same-network path only; it never joins a
            // code, so the pairing room stays empty and the fallback builder
            // simply refuses.
            pairingRoom: LinkRoomHandle())
        fileModel.saveDirectory = saveDirectory
        textModel = AppEnvironment.makeRealtimeTextModel(
            baseURL: baseURL, verification: verification,
            nearby: discovery, inboundRoom: inboundRoom,
            // This harness drives the same-network path only; it never joins a
            // code, so the pairing room stays empty and the fallback builder
            // simply refuses.
            pairingRoom: LinkRoomHandle())
        receive = AppEnvironment.makeNearbyReceiveModel(
            fileModel: fileModel, textModel: textModel,
            discovery: discovery, inboundRoom: inboundRoom)
        receive.onSessionStarted = { kind in
            log("receiver: an unsolicited \(kind) session started — nothing was clicked")
        }
    }

    private var trace: SignalSubscription?

    func start() {
        // The one call RelayiumApp makes at launch.
        discovery.startResident()
        if let client = discovery.client {
            trace = client.addSignalListener { from, data in
                var kinds: [String] = []
                if let sdp = parseSDP(data) { kinds.append("sdp:\(sdp.type)") }
                if parseICE(data) != nil { kinds.append("ice") }
                if peerCommit(from: data) != nil { kinds.append("commit") }
                if peerReveal(from: data) != nil { kinds.append("reveal") }
                if parseBusy(data) { kinds.append("busy") }
                if !peerCaps(from: data).isEmpty { kinds.append("caps") }
                log("receiver: <- \(kinds.isEmpty ? ["?"] : kinds) gen=\(signalGeneration(data)) from=\(from)")
            }
        }
        log("receiver: resident, listening as \(receiverName)")
    }

    func teardown() {
        discovery.stop()
        defaults.removePersistentDomain(forName: defaultsSuite)
        try? FileManager.default.removeItem(at: saveDirectory)
    }
}

// MARK: - run

log("nearby receive E2E baseURL=\(baseURL) tag=\(runTag)")

let senderBox = SenderBox()
final class SenderBox: @unchecked Sendable {
    var sender: Sender?
}

/// Polls a condition on the main actor, the way a person watching the app would.
@MainActor
func waitFor(_ what: String, seconds: TimeInterval, _ ready: @MainActor () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if ready() { return true }
        try? await Task.sleep(nanoseconds: 200_000_000)
    }
    log("timed out waiting for \(what)")
    return false
}

let textBody = "passive text over the nearby room :: \(runTag)"

/// Sender-only: offer a file to a device already sitting in the room, and let
/// its CTRL_COMPLETE be the evidence. That control frame is sent by the receiver
/// only after its writer finished and the batch verified, so seeing it means the
/// far side really wrote the bytes — without anybody there accepting anything.
///
/// ⚠️ Writing those bytes is the point, and it happens on the OTHER machine, in
/// the real destination that app is configured with — Downloads by default. This
/// process has no way to remove it, so it names the file per run and prints the
/// exact path to delete.
@MainActor
func runAgainstLiveApp(_ deviceName: String) async {
    log("sender-only: offering files to \"\(deviceName)\" — nothing there will be clicked")
    log("sender-only: ⚠️ this WRITES A REAL FILE on \"\(deviceName)\", into that app's "
        + "download destination (~/Downloads unless it was changed). "
        + "It is named \(fileName) for this run and this process cannot delete it.")
    let sender = Sender()
    senderBox.sender = sender
    guard await waitFor("\"\(deviceName)\" to appear in the room", seconds: 30,
                        { sender.peerId != nil }),
          let peerId = sender.peerId else {
        outcome.finish("FAIL: \"\(deviceName)\" is not in the code-less room")
        return
    }
    sender.sendFile(to: peerId, batch: flatBatch)
    guard await waitFor("the far side to report the batch complete", seconds: 60,
                        { sender.sawComplete }) else {
        outcome.finish("FAIL: the far side never confirmed the transfer")
        return
    }
    log("sender-only: complete, SAS=\(sender.fileSAS ?? "nil")")
    log("sender-only: CLEAN UP on \"\(deviceName)\": rm ~/Downloads/\(fileName)")
    outcome.finish("PASS")
}

Task { @MainActor in
    if let deviceName = sendTo {
        await runAgainstLiveApp(deviceName)
        return
    }

    let receiver: Receiver
    do {
        receiver = try Receiver()
    } catch {
        outcome.finish("FAIL: receiver setup \(error)")
        return
    }
    receiver.start()

    // Give residency a moment to actually join before the sender looks for it;
    // the roster is broadcast on join, so an early sender just waits.
    try? await Task.sleep(nanoseconds: 1_500_000_000)
    let sender = Sender()
    senderBox.sender = sender

    guard await waitFor("the sender to find the receiver in the room", seconds: 30,
                        { sender.peerId != nil }),
          let peerId = sender.peerId else {
        outcome.finish("FAIL: the receiver never appeared in the room roster")
        receiver.teardown()
        return
    }

    // ── phase 1: an unsolicited file offer ───────────────────────────────────
    // A MIXED batch: one loose file plus a two-level folder, so this proves the
    // production receive path rebuilds a directory tree from `FileMeta.path`
    // rather than merely writing N files.
    log("phase 1: offering a loose file and a nested folder with nobody expecting it")
    sender.sendFile(to: peerId, batch: mixedBatch)
    guard await waitFor("the receive to complete", seconds: 60, {
        if case .completed = receiver.fileModel.state { return true }
        if case .failed = receiver.fileModel.state { return true }
        return false
    }) else {
        outcome.finish("FAIL: timeout waiting for the file receive")
        receiver.teardown()
        return
    }
    guard case let .completed(urls) = receiver.fileModel.state else {
        outcome.finish("FAIL: receiver file state=\(receiver.fileModel.state)")
        receiver.teardown()
        return
    }
    // Where the batch landed. A multi-root batch has no folder name to take, so
    // the receiver builds its own container; everything is asserted RELATIVE to
    // that, which is also how a wrong container (or none) shows up as a failure
    // rather than as a path that happens to contain the right suffix.
    let container = receiver.fileModel.receivedContainer
    let base = (container ?? receiver.saveDirectory).standardized.path
    let relativePaths = urls.map { url -> String in
        let p = url.standardized.path
        return p.hasPrefix(base + "/") ? String(p.dropFirst(base.count + 1)) : p
    }
    // Manifest order, with the folder rebuilt — not four files side by side.
    let expectedPaths = mixedBatch.map { $0.meta.path ?? $0.meta.name }
    let pathsMatch = relativePaths == expectedPaths
    // Every file's bytes, not just the first: a writer that split the stream one
    // byte off would still produce the right count of files with the right names.
    let bytesMatch = zip(urls, mixedBatch).allSatisfy { url, entry in
        (try? Data(contentsOf: url)).map { [UInt8]($0) == entry.bytes } ?? false
    } && urls.count == mixedBatch.count
    // The drag-out payload is the container, so the whole tree can leave in one
    // piece rather than being flattened at the destination.
    let dragMatch = receiver.fileModel.received?.dragURLs == [container].compactMap { $0 }
    let fileSASMatch = !receiver.fileModel.sasCode.isEmpty
        && receiver.fileModel.sasCode == sender.fileSAS
    log("phase 1: urls=\(urls.count) container=\(container?.lastPathComponent ?? "nil") "
        + "paths=\(relativePaths) pathsMatch=\(pathsMatch) bytesMatch=\(bytesMatch) "
        + "dragMatch=\(dragMatch) sasMatch=\(fileSASMatch) "
        + "receiverSAS=\(receiver.fileModel.sasCode) senderSAS=\(sender.fileSAS ?? "nil") "
        + "senderSawComplete=\(sender.sawComplete)")
    guard pathsMatch, bytesMatch, dragMatch, fileSASMatch, sender.sawComplete else {
        outcome.finish("FAIL: phase 1 paths=\(pathsMatch) bytes=\(bytesMatch) drag=\(dragMatch) "
                       + "sas=\(fileSASMatch) complete=\(sender.sawComplete)")
        receiver.teardown()
        return
    }

    // The session has to hand the listener back, or the first transfer is the
    // last one this app ever accepts.
    receiver.fileModel.cancel()
    guard await waitFor("the listener to become ready again", seconds: 15,
                        { receiver.receive.state == .ready }) else {
        outcome.finish("FAIL: the listener did not return to ready after a completed receive")
        receiver.teardown()
        return
    }
    log("phase 1: listener is ready again")

    // ── phase 2: an unsolicited text offer, on the same socket ───────────────
    // The sender's file connection has to be fully retired first — see
    // `retireFileConnection`.
    await sender.retireFileConnection()
    log("phase 2: offering a text session with nobody expecting it")
    sender.openText(to: peerId, body: textBody)
    var lastTextState = ""
    guard await waitFor("the text message to arrive", seconds: 30, {
        let described = "\(receiver.textModel.state)"
        if described != lastTextState {
            lastTextState = described
            log("receiver: text state=\(described)")
        }
        return receiver.textModel.history.contains { $0.direction == .incoming }
    }) else {
        outcome.finish("FAIL: timeout waiting for the text receive "
                       + "(state=\(receiver.textModel.state) accepted=\(sender.textAccepted))")
        receiver.teardown()
        return
    }
    let received = receiver.textModel.history.last { $0.direction == .incoming }
    // Both sides, compared — not merely "the sender derived something". The SAS
    // is the only thing in this feature that says anything about WHO the peer
    // is, so an assertion that never compares the two halves would pass just as
    // happily against a session with a man in the middle.
    let receiverTextSAS: String? = {
        if case let .open(sas) = receiver.textModel.state { return sas }
        return nil
    }()
    let textSASMatch = receiverTextSAS != nil
        && !receiverTextSAS!.isEmpty
        && receiverTextSAS == sender.textSAS
    log("phase 2: state=\(receiver.textModel.state) body==sent=\(received?.body == textBody) "
        + "receiverTextSAS=\(receiverTextSAS ?? "nil") senderTextSAS=\(sender.textSAS ?? "nil") "
        + "sasMatch=\(textSASMatch)")
    guard received?.body == textBody, textSASMatch else {
        outcome.finish("FAIL: phase 2 body=\(received?.body ?? "nil") sas=\(textSASMatch)")
        receiver.teardown()
        return
    }

    receiver.textModel.end()
    _ = await waitFor("the listener to become ready after the text session", seconds: 15,
                      { receiver.receive.state == .ready })
    log("receiver: final receive state=\(receiver.receive.state)")
    outcome.finish(receiver.receive.state == .ready
                   ? "PASS"
                   : "FAIL: listener ended at \(receiver.receive.state)")
    receiver.teardown()
}

outcome.wait { result in
    log("=== RESULT: \(result) ===")
    senderBox.sender?.close()
    exit(result == "PASS" ? 0 : 1)
}
dispatchMain()
