import Combine
import Foundation
import Network
import RelayiumAppKit
import RelayiumKit
// The local link's own advertisement, framing, channel and transport — the
// shipped iOS Nearby rendezvous, unchanged.
import RelayiumLocalPeerKit
import RelayiumPeerKit

// **The Apple half of Android ↔ Apple, in BOTH directions, on one real
// `_relayium._tcp` link.**
//
//   AppleNearbyBidirectionalPeer \
//     --role local-link-bidirectional \
//     --origin http://127.0.0.1:P --run-tag <tag> \
//     --receive-root <dir> --name <advertised name> \
//     --target-name <the Android device's advertised name> \
//     --plan <plan.json> [--dial-side apple|android]
//
//   AppleNearbyBidirectionalPeer --role dial-probe \
//     --origin http://127.0.0.1:P --run-tag <tag> \
//     --name <advertised name> --target-name <name>
//
// Secrets arrive in the ENVIRONMENT and never in argv, because argv on macOS is
// readable by every process this user runs:
//
//   RELAYIUM_ACCEPTANCE_CONTROL_TOKEN   the control API bearer (required)
//
// ## Why this executable exists, given `LocalTransferPeer --role local-link-peer`
//
// That role is the counterpart `scripts/android-nearby-apple-acceptance.sh`
// already drives, and it is RECEIVE-ONLY by construction: `LocalLinkPeerRun`
// finishes the moment an inbound batch commits, and the shipped peer's `/drive`
// route answers 409 for it. So the one direction it can evidence is
// Android → Apple, which it has. Nothing in the repository could make the
// SHIPPED Apple modules originate a local-link transfer against a second
// endpoint — which is exactly the half of the product an iPhone user spends
// most of their time in.
//
// ## What is production here, and what is not
//
// The composition below is `LocalLinkPeerHost`'s, line for line, and that is
// deliberate: the advertisement, the browse, the TXT record, the framing, the
// signalling channel, the capability registry, the link surface, the file lane,
// the text lane, the crypto and the receipt writer are all the product's own,
// reached through public API. Nothing here re-implements a wire.
//
// What is a POLICY rather than production is the short list `LinkCounterpart`
// already records — admitting an unsolicited link, confirming a pending SAS,
// accepting an offered batch, dismissing a finished one — plus the four
// decisions a person would make on screen and a test cannot: which device to
// select, when to press Connect, which files to send, and what to type. Each is
// a call into a public entry point the user's own tap reaches.
//
// Two things are composed here rather than taken from
// `LocalNearbyEnvironment.makeDiscoveryModel()`, for the reasons
// `LocalLinkPeerHost` gives:
//
//  * the advertised NAME, because that factory uses `AppEnvironment.deviceName()`
//    — one constant string per machine, and unusable for a roster assertion
//    that has to name THIS run on a shared build agent;
//  * `sameHostAcceptanceAllowsLoopback: true`, which is the same Debug-only
//    same-host seam `LocalLinkPeerHost` takes at `main.swift` 465–478. It
//    permits a same-host route and nothing else; `includePeerToPeer` stays
//    false, the browse keeps the shipped answer, and the Release build does not
//    compile the permissive branch at all.
//
// ## What a green run does NOT prove
//
// A Mac running the shipped modules is not an iPhone. This is evidence about
// the Apple IMPLEMENTATION, never about Apple hardware, and it must never be
// described as a physical-device result.

func log(_ message: String) {
    FileHandle.standardError.write(Data("[\(Date())] \(message)\n".utf8))
}

func fail(_ message: String) -> Never {
    log("fatal: \(message)")
    exit(2)
}

// MARK: - arguments

let rawArguments = Array(CommandLine.arguments.dropFirst())

func option(_ name: String) -> String? {
    guard let flag = rawArguments.firstIndex(of: name) else { return nil }
    let value = rawArguments.index(after: flag)
    guard value < rawArguments.endIndex else { fail("\(name) needs a value") }
    return rawArguments[value]
}

func require(_ name: String) -> String {
    guard let value = option(name), !value.isEmpty else { fail("\(name) is required") }
    return value
}

enum Role: String {
    /// The acceptance role: advertise, find the Android device by its exact
    /// advertised name, open one `link/1`, and drive BOTH directions over it.
    case bidirectional = "local-link-bidirectional"
    /// A standalone topology diagnostic, and NOT part of any acceptance.
    ///
    /// It answers one question in about twenty seconds instead of a whole
    /// round: can this host open a TCP stream to the service the Android
    /// instance advertises? The two halves of Bonjour fail separately and a
    /// host that can SEE an emulator's advertisement cannot be assumed to be
    /// able to REACH the address behind it. When the dial fails, the round
    /// above fails as a link that timed out, which is a true but expensive way
    /// to learn a network fact — so this exists to learn it cheaply.
    ///
    /// It dials through the product's own `NetworkLocalPeerTransport.connect`,
    /// with the product's own parameters, so a green probe is about the same
    /// route the round uses and not about a socket this file opened its own way.
    case dialProbe = "dial-probe"
}

/// Which side presses Connect.
///
/// Separate from which side sends BYTES, and the distinction is the point.
/// `apple` is the default because it is the assignment nothing has ever
/// exercised: `scripts/android-nearby-apple-acceptance.sh` has only ever had
/// Android dial. `android` is a documented fallback for a host that can see the
/// Android instance's advertisement but cannot open a stream to it — the reverse
/// DATA direction, which is what this acceptance is for, is delivered either
/// way, and the oracle records and asserts which assignment a run took rather
/// than letting the two look alike.
enum DialSide: String {
    case apple
    case android
}

enum Config {
    static let role: Role = {
        guard let role = Role(rawValue: require("--role")) else {
            fail("--role must be local-link-bidirectional or dial-probe")
        }
        return role
    }()

    /// **Validated by the product's own seam, not by a second parser here.**
    /// Reusing `AppEnvironment.loopbackTransferOrigin` means this process
    /// physically cannot address anything the app itself would refuse.
    static let origin: URL = {
        let raw = require("--origin")
        guard let origin = AppEnvironment.loopbackTransferOrigin(raw) else {
            fail("--origin \(raw) is not a loopback origin the app would accept")
        }
        return origin
    }()

    static let runTag = require("--run-tag")
    static let name = require("--name")
    static let targetName = require("--target-name")

    static let dialSide: DialSide = {
        guard let raw = option("--dial-side") else { return .apple }
        guard let side = DialSide(rawValue: raw) else {
            fail("--dial-side must be apple or android")
        }
        return side
    }()

    /// Secrets arrive in the environment, never in argv.
    static let controlToken: String = {
        let token = ProcessInfo.processInfo
            .environment["RELAYIUM_ACCEPTANCE_CONTROL_TOKEN"] ?? ""
        guard !token.isEmpty else {
            fail("RELAYIUM_ACCEPTANCE_CONTROL_TOKEN must be set in the environment")
        }
        return token
    }()

    /// Passed explicitly and never allowed to default: the macOS overload of
    /// `makeLinkWorkspaceModel` defaults to the user's Downloads folder, and a
    /// run that fell back to it would write real files into a real person's
    /// folder.
    static let receiveRoot: URL = {
        URL(fileURLWithPath: require("--receive-root"))
    }()

    /// The batch and the message this side sends, from a FILE.
    ///
    /// Not argv, and for two independent reasons: the message is non-ASCII and
    /// whitespace-significant, and a value that had to survive a shell's
    /// quoting is not a value anything can compare exactly afterwards; and a
    /// manifest with three entries and their source paths is not an argument
    /// list. The launcher writes it, this reads it, and neither ever has to
    /// escape anything.
    static let plan: Plan = {
        let path = require("--plan")
        guard let data = FileManager.default.contents(atPath: path) else {
            fail("could not read the plan at \(path)")
        }
        do {
            let plan = try JSONDecoder().decode(Plan.self, from: data)
            guard !plan.files.isEmpty else { fail("the plan declares no files") }
            guard !plan.message.isEmpty else { fail("the plan declares no message") }
            return plan
        } catch {
            fail("the plan at \(path) is not the expected document: \(error)")
        }
    }()
}

/// What this side sends. The digests are deliberately ABSENT: a sender that
/// published its own hashes into the report would be answering the question the
/// receiver's receipt is the only honest answer to.
struct Plan: Decodable {
    struct Entry: Decodable {
        /// The manifest name, exactly as the peer must see it.
        let name: String
        /// The manifest path — `nil` for a loose file, and for a batch that
        /// carries a folder the FULL relative path including the leaf, which is
        /// the convention `Filename.resolveRelativePath` and
        /// `LinkCounterpart.liveReceipts` both already use.
        let path: String?
        /// An absolute path the launcher staged. Read through the product's own
        /// `FileURLSource`, which pins the descriptor.
        let source: String
    }

    let files: [Entry]
    let message: String
}

// MARK: - shared state

/// The launcher-visible phase and details, behind a lock because the control
/// API's handlers run on the listener's own queue and everything they report is
/// written from the main actor.
final class State: @unchecked Sendable {
    private let lock = NSLock()
    private var _phase = "idle"
    private var _detail: [String: String] = [:]
    private var _receipts: [FileReceipt] = []
    private var _messages: [String] = []
    private var _failure: String?

    var phase: String { lock.lock(); defer { lock.unlock() }; return _phase }

    func set(phase: String) {
        lock.lock()
        // A terminal failure is never overwritten by a later transition: the
        // first cause is the diagnosis, and a phase written after it would
        // rename a failed run.
        guard _failure == nil else { lock.unlock(); return }
        _phase = phase
        lock.unlock()
        log("phase: \(phase)")
    }

    func set(_ key: String, _ value: String) {
        lock.lock(); _detail[key] = value; lock.unlock()
    }

    /// The terminal record, frozen. Called once the link has ended, so the
    /// receipts and the transcript are the archive rather than a live read.
    func freeze(receipts: [FileReceipt], messages: [String]) {
        lock.lock(); _receipts = receipts; _messages = messages; lock.unlock()
        log("froze \(receipts.count) receipt(s) and \(messages.count) message(s)")
    }

    func failed(_ reason: String) {
        lock.lock()
        if _failure == nil { _failure = reason; _phase = "failed" }
        lock.unlock()
        log("phase: failed — \(reason)")
    }

    func snapshot() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        var out: [String: Any] = ["phase": _phase,
                                  "role": Config.role.rawValue,
                                  "origin": Config.origin.absoluteString,
                                  "dialSide": Config.dialSide.rawValue,
                                  "runTag": Config.runTag]
        for (key, value) in _detail { out[key] = value }
        if let _failure { out["failure"] = _failure }
        return out
    }

    /// The terminal document the oracle judges.
    ///
    /// `files` is what THIS side received, read off the model a production
    /// writer filled in; `manifest` is what this side ENQUEUED, which is state
    /// rather than a receipt and carries no digest.
    func result() -> [String: Any] {
        lock.lock()
        let receipts = _receipts
        let messages = _messages
        let phase = _phase
        let failure = _failure
        let detail = _detail
        lock.unlock()
        var out: [String: Any] = [
            "phase": phase,
            "role": Config.role.rawValue,
            "dialSide": Config.dialSide.rawValue,
            // The origin this process actually RESOLVED, echoed back so the
            // launcher's "this run was local" assertion is made against the
            // peer's own answer rather than against the string it passed in.
            "origin": Config.origin.absoluteString,
            "files": entries(receipts),
            "messages": messages,
        ]
        // Read only for the role that HAS a plan. `Config.plan` is a lazy
        // `require`, so touching it in the probe role would abort the process
        // for a missing argument that role does not take.
        if Config.role == .bidirectional {
            out["manifest"] = Config.plan.files.map { entry -> [String: Any] in
                var row: [String: Any] = ["name": entry.name]
                if let path = entry.path { row["path"] = path }
                return row
            }
        }
        for (key, value) in detail { out[key] = value }
        if let failure { out["failure"] = failure }
        return out
    }
}

func entries(_ receipts: [FileReceipt]) -> [[String: Any]] {
    receipts.map { receipt in
        var entry: [String: Any] = ["name": receipt.name,
                                    "size": receipt.size,
                                    "sha256": receipt.sha256]
        if let path = receipt.path { entry["path"] = path }
        return entry
    }
}

let state = State()

func json(_ value: [String: Any], status: Int = 200) -> (status: Int, body: Data) {
    let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
        ?? Data(#"{"error":"unencodable"}"#.utf8)
    return (status, data)
}

// MARK: - the host

/// The shipped local-link Nearby composition, plus the four choices a person
/// would make on screen.
///
/// Assembled exactly as `LocalLinkPeerHost` assembles it — same factories, same
/// arguments, same order, same `activate` inside `prepare` — because the whole
/// value of this fixture is that the Apple side of the wire is the product's.
/// What it ADDS to that host is a send surface: `selectAndConnect`,
/// `send(message:)` and `sendPlan()` are three public entry points the user's
/// own taps reach, and nothing else.
@MainActor final class BidirectionalHost {

    /// Published on `/status`, so a failing run can say what it advertised
    /// rather than leaving that to be inferred from a roster that never named it.
    let advertisement: LocalPeerAdvertisement
    let discovery: LanDiscoveryModel
    /// Retained because `LanDiscoveryModel.observer` is weak. It answers a
    /// legacy offer with the tagged `busy` this build's peers understand rather
    /// than leaving one to wait out its own timeout in silence.
    let receive: NearbyReceiveModel
    let link: LinkWorkspaceModel
    let counterpart: LinkCounterpart

    private let receiveRoot: URL
    private let defaults: UserDefaults
    private let defaultsSuite: String
    /// The sources for the batch this side sends, staged ONCE.
    ///
    /// Held for the life of the host rather than rebuilt per attempt:
    /// `FileURLSource` pins a descriptor, and re-staging would reopen the PATH —
    /// the check-then-use the pin exists to remove. `LinkWorkspaceModel`'s own
    /// `enqueue` re-stages from this array for every attempt it makes, and
    /// copies of the struct share the descriptor without sharing an offset.
    private var stagedSources: [PlaintextSource] = []
    private var stagedFiles: [FileMeta] = []

    init() throws {
        receiveRoot = Config.receiveRoot
        try FileManager.default.createDirectory(at: receiveRoot,
                                                withIntermediateDirectories: true)
        // Scoped by role as well as run tag, for the reason `LocalLinkPeerHost`
        // records: a run may start a second peer process, and two processes
        // sharing a defaults domain erase each other's on teardown.
        defaultsSuite = "com.relayium.acceptance.\(Config.runTag).\(Config.role.rawValue)"
        guard let defaults = UserDefaults(suiteName: defaultsSuite) else {
            throw AppReceiverHost.HostError.unusableDefaultsSuite(defaultsSuite)
        }
        self.defaults = defaults
        // The shipped default is verification OFF, read from a throwaway domain
        // so the run does not inherit whatever the person running it chose.
        let verification = VerificationPreference(defaults: defaults)

        advertisement = LocalPeerAdvertisement(
            identity: LocalPeerAdvertisement.mintIdentity(),
            name: Config.name,
            capabilities: LocalNearbyEnvironment.advertisedCapabilities)
        let advertisement = self.advertisement
        discovery = LanDiscoveryModel(prepare: {
            let channel = LocalPeerSignalingChannel(
                advertisement: advertisement,
                // The Debug-only same-host seam, taken for the same reason
                // `LocalLinkPeerHost` takes it: both endpoints of this
                // acceptance may be reached over this host's own addresses, and
                // the shipped default prohibits a route classified as loopback.
                // Either side may listen or dial, so both opt in. It permits
                // that route and nothing else — `includePeerToPeer` stays
                // false, and the browse keeps the shipped answer.
                transport: NetworkLocalPeerTransport(sameHostAcceptanceAllowsLoopback: true))
            let client = SignalingClient(channel: channel, name: advertisement.name)
            // Armed in `activate`, not here: a local transport can be ready
            // synchronously and would otherwise announce a roster into
            // callbacks `LanDiscoveryModel` has not installed yet.
            return PreparedNearbyConnection(client: client,
                                            activate: { channel.begin() })
        })

        receive = AppEnvironment.makeListeningOnlyNearbyReceiveModel(
            discovery: discovery, inboundRoom: InboundRoom())

        let root = receiveRoot
        link = AppEnvironment.makeLinkWorkspaceModel(
            baseURL: Config.origin, verification: verification, nearby: discovery,
            // No code is watched on this path: the local link IS the code-less
            // room, and this composition has no pairing surface.
            pairingRoom: LinkRoomHandle(),
            receiveDirectory: { root })
        counterpart = LinkCounterpart(link: link)
    }

    /// Headless answers before advertising, for the reason `AppReceiverHost
    /// .start` gives: a peer can dial the instant the listener is ready, and an
    /// admission gate installed afterwards would race the first offer.
    func start() {
        counterpart.start()
        discovery.startResident()
    }

    // MARK: what the launcher drives

    /// The device this round is for, by the strictest rule the topology allows.
    ///
    /// The match must be UNIQUE. Two devices answering to one name means the
    /// round cannot say which one it chose, and passing anyway would be
    /// reporting a coin toss — the same rule `NearbyLanAcceptanceTest.device`
    /// applies on the Android side.
    func target() -> NearbyDevice? {
        let matches = discovery.devices.filter { $0.name == Config.targetName }
        return matches.count == 1 ? matches[0] : nil
    }

    /// Select the device and press Connect, through the two public entry points
    /// a tap on a roster row reaches.
    ///
    /// `canLink` is checked FIRST and separately: a peer that has not announced
    /// exact `link/1` is not a degraded link, it is a peer this feature does not
    /// include, and `connect` would refuse it silently. Refusing here instead
    /// means the run says WHICH precondition failed.
    func selectAndConnect(_ device: NearbyDevice) -> String? {
        guard link.canLink(peerId: device.id) else {
            return "the Android device did not announce exact link/1, so no link may be asked for"
        }
        discovery.select(device.id)
        guard discovery.selectedId == device.id else {
            return "the discovery model refused the selection; the device left the roster"
        }
        guard link.connect(peerId: device.id, peerLabel: device.name) else {
            return "the link surface refused Connect (phase \(link.connection),"
                + " error \(link.actionError ?? "-"))"
        }
        return nil
    }

    /// One message, through the composer's own entry point. Reports whether the
    /// model TOOK it, so nothing infers acceptance from having called it.
    func send(message body: String) -> Bool { link.send(message: body) }

    /// Stage the plan and enqueue it as ONE batch on the live link.
    ///
    /// Staging opens every source before the first is enqueued, so a plan with
    /// an unreadable entry fails as that rather than half-sending a batch the
    /// receiver has already consented to.
    func sendPlan() -> String? {
        guard stagedFiles.isEmpty else { return "the plan has already been enqueued" }
        var files: [FileMeta] = []
        var sources: [PlaintextSource] = []
        for entry in Config.plan.files {
            let url = URL(fileURLWithPath: entry.source)
            let source: FileURLSource
            do {
                // `name` overrides what the source reports so the manifest name
                // is the launcher's, not the staged file's basename.
                source = try FileURLSource(url: url, name: entry.name)
            } catch {
                return "could not stage \(entry.name): \(error)"
            }
            files.append(FileMeta(name: entry.name, size: source.size, path: entry.path))
            sources.append(source)
        }
        stagedFiles = files
        stagedSources = sources
        link.send(files: files, sources: sources)
        if let error = link.actionError {
            return "the link surface refused the batch: \(error)"
        }
        return nil
    }

    // MARK: what the launcher reads

    /// How many OUTBOUND batches this side's peer has reported complete.
    ///
    /// `finished` and nothing else. For an outbound batch that is the whole
    /// truth — the peer took it — and unlike an empty `sendProgress` it cannot
    /// also mean cancelled or failed.
    func sentBatches() -> Int {
        (link.fileModel?.batches ?? [])
            .filter { $0.direction == .outbound && $0.state == .finished }
            .count
    }

    /// How many INBOUND batches committed to this side's disk.
    ///
    /// `received` and nothing else, for the reason `LinkFileBatchState`
    /// records: `finished` on an inbound batch is a report this projection has
    /// seen no proof of, and only `received` carries the URLs a receipt is read
    /// from.
    func receivedBatches() -> Int {
        (link.fileModel?.batches ?? [])
            .filter { batch in
                guard batch.direction == .inbound else { return false }
                if case .received = batch.state { return true }
                return false
            }
            .count
    }

    /// Whether any batch in either direction ended with no result. Reported so
    /// a round that will never complete fails as a failed batch rather than as
    /// a wait that ran out.
    func failedBatch() -> String? {
        for batch in link.fileModel?.batches ?? [] where batch.state == .failed {
            return "\(batch.direction):failed(batch \(batch.id))"
        }
        return nil
    }

    func roster() -> [[String: Any]] {
        discovery.devices.map {
            ["id": $0.id, "name": $0.name, "supportsLink": $0.supportsLink]
        }
    }

    /// The live view, read off the models the production writers filled in.
    /// Nothing here is derived or remembered.
    func observed() -> [String: Any] {
        var out: [String: Any] = [
            "linkPhase": String(describing: link.connection),
            "hasSession": link.hasSession,
            "room": String(describing: discovery.state),
            // Which link these facts belong to. A caller polling "has a SAS
            // arrived" has to be able to tell this link's digits from a previous
            // link's residue.
            "epoch": counterpart.current.epoch,
            "roster": roster(),
            "selectedId": discovery.selectedId ?? "",
            "messages": counterpart.current.messages,
            "allMessages": counterpart.allMessages(),
            "files": entries(counterpart.receipts()),
            "allFiles": entries(counterpart.allReceipts()),
            "sentBatches": sentBatches(),
            "receivedBatches": receivedBatches(),
        ]
        if let sas = counterpart.current.sas { out["sas"] = sas }
        if let error = link.actionError { out["actionError"] = error }
        if let batches = link.fileModel?.batches {
            out["batchStates"] = batches.map { "\($0.direction):\($0.state)" }
        }
        if let text = link.textModel { out["textStatus"] = String(describing: text.textStatus) }
        return out
    }

    /// End the link. Called only when the launcher says the Android half has
    /// finished asserting against it — see the barrier note in
    /// `scripts/android-nearby-apple-bidirectional-acceptance.sh`.
    func release() {
        link.leave()
    }

    /// Withdraw the advertisement. Called only after the Android half has
    /// checked its own roster, because this is what makes this device disappear
    /// from it — correctly, and therefore raceably.
    func stopAdvertising() {
        discovery.stop()
    }

    func teardown() {
        link.leave()
        discovery.stop()
        defaults.removePersistentDomain(forName: defaultsSuite)
        try? FileManager.default.removeItem(at: receiveRoot)
    }
}

// MARK: - the acceptance run

/// The phase machine, and the watchdog that stops it waiting forever.
///
/// Every transition below is a CONDITION on a model the product wrote, never an
/// elapsed time: `resident` is the lifecycle's own readiness edge, `discovered`
/// is an exact unique roster match, `linked` is `.open(sas)`, and `complete` is
/// a batch count in each direction. A fixed sleep would prove nothing about any
/// of them.
@MainActor final class Run {
    let host: BidirectionalHost

    /// How many INBOUND batches this side must see before the round is
    /// complete, declared by the launcher because it is the launcher that
    /// decides how many the Android half sends.
    ///
    /// Android's own send surface is `ActionResultContracts.OpenMultipleDocuments`
    /// driven through the REAL DocumentsUI, and this harness taps ONE document
    /// per visit, so the Android half sends one batch per file. That is a
    /// property of driving the real picker rather than of the wire, and it is
    /// extra coverage rather than less: several batches on ONE link is a path a
    /// single-batch round never takes.
    let expectedInbound: Int

    /// From the last observed PROGRESS, not from `start`.
    ///
    /// The gaps here are legitimately long — the Android half drives a real
    /// system folder picker, which is a separate Activity — so this is
    /// deliberately generous, and it is refreshed by every control command as
    /// well as by every model change. What it exists to stop is an
    /// UNBOUNDED wait: a round whose peer never appeared must fail as that,
    /// naming the last thing it saw, rather than hanging until a launcher's own
    /// timeout kills it with no diagnosis.
    static let idleCeiling: TimeInterval = 300

    private var lastProgress = Date()
    private var fingerprint = ""
    private var announcedResident = false
    private var announcedDiscovered = false
    private var announcedLinked = false
    private var dialled = false
    private var connectAsked = false
    private var announcedComplete = false
    private var finished = false
    private var observers: Set<AnyCancellable> = []

    /// The ending of an attempt that died BEFORE the link opened, captured from
    /// the publisher rather than from the poll.
    ///
    /// `@Published` publishes in `willSet` and `LinkCounterpart` dismisses the
    /// workspace on the NEXT main-actor turn, so `.ended` can come and go
    /// between two 200 ms samples — a round then spent its whole remaining
    /// bound waiting for a link that had already failed, which is exactly what
    /// the first live round did.
    private var endingBeforeLink: LinkWorkspaceEnding?

    /// The HIGH-WATER marks, and this is a fix rather than a nicety.
    ///
    /// Both counts are derived from `link.fileModel`, which `dismiss()`
    /// RELEASES — so a `/result` read after `/release` (which is exactly when
    /// the launcher reads it) saw the periodic publisher below overwrite two
    /// completed-batch counts with zero. The counts are monotonic within a link
    /// by nature: `finished` and `received` are terminal states, and a batch
    /// that completed does not un-complete. Only the projection they were read
    /// from goes away, so the peak is the honest value to publish and the live
    /// read is the honest thing to take it from.
    private var peakSent = 0
    private var peakReceived = 0

    init(expectedInbound: Int) throws {
        host = try BidirectionalHost()
        self.expectedInbound = max(1, expectedInbound)
        // Forced HERE rather than left to the first `/files`. `Config.plan` is a
        // lazy `require`, so an unreadable or malformed plan would otherwise
        // abort the process in the middle of a round that had already spent an
        // install and a link — long after the launcher could have said what was
        // wrong with its own document.
        state.set("plannedFiles", String(Config.plan.files.count))
        // Every link transition this side sees. The Android half is gone by the
        // time anybody reads a failure, so this is the surviving account.
        host.counterpart.logEvent = { log($0) }
    }

    private func connectionChanged(_ connection: LinkWorkspaceConnection) {
        guard case let .ended(ending) = connection, !announcedLinked else { return }
        state.set("endingBeforeLink", String(describing: ending))
        // Recorded for EVERY assignment, acted on for one.
        //
        // With `--dial-side apple` this side makes exactly one attempt —
        // `beginInitiator` does not retry, and the request path's nine retries
        // all settle into a single ending — so a terminal ending before the link
        // opened is the answer and the round is over. With `--dial-side android`
        // the PEER owns the attempt and `LinkRoomRouter` legitimately retries,
        // so failing on the first ending would end a round that was about to
        // succeed. There the ending is a diagnostic and nothing more.
        guard Config.dialSide == .apple, connectAsked else { return }
        endingBeforeLink = ending
    }

    /// Any control command counts as progress: the launcher is sequencing
    /// something this side cannot observe (a Gradle install, a DocumentsUI
    /// round trip), and a watchdog that ignored that would kill a healthy run.
    func touch() { lastProgress = Date() }

    func start() {
        // Installed BEFORE the room opens, for the reason `LinkCounterpart.start`
        // gives about its own answers: a peer can be dialling the instant the
        // listener is ready, and an observer attached afterwards would miss the
        // first edge it exists to see.
        host.link.$connection
            .sink { [weak self] connection in
                MainActor.assumeIsolated { self?.connectionChanged(connection) }
            }
            .store(in: &observers)
        host.start()
        state.set(phase: "advertising")
        state.set("peerName", host.advertisement.name)
        state.set("peerIdentity", host.advertisement.identity)
        state.set("targetName", Config.targetName)
        state.set("expectedInboundBatches", String(expectedInbound))
        touch()
        Task { @MainActor in await self.pump() }
    }

    private func pump() async {
        while !finished {
            step()
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
    }

    private func step() {
        guard state.phase != "failed" else { finished = true; return }

        // Before anything else: an attempt that has already ended is an ANSWER,
        // and reporting it now rather than at the idle ceiling is the difference
        // between a named failure and five minutes of silence.
        if let ending = endingBeforeLink {
            return state.failed(
                "the link ended as \(ending) before it ever opened, on the "
                + "\(Config.dialSide.rawValue) dial assignment. "
                + "room=\(host.discovery.state) roster=[\(rosterFingerprint())] "
                + "err=\(host.link.actionError ?? "-")")
        }

        // ── readiness, then identity, then the dial ─────────────────────────
        if !announcedResident, case .joined = host.discovery.state {
            announcedResident = true
            state.set(phase: "resident")
            touch()
        }

        if announcedResident, !announcedDiscovered, let device = host.target() {
            announcedDiscovered = true
            state.set("targetId", device.id)
            state.set("targetSupportsLink", device.supportsLink ? "true" : "false")
            state.set(phase: "discovered")
            touch()
        }

        if connectAsked, announcedDiscovered, !dialled, Config.dialSide == .apple {
            dialled = true
            guard let device = host.target() else {
                return state.failed("the Android device left the roster before Connect")
            }
            state.set(phase: "dialing")
            if let refusal = host.selectAndConnect(device) {
                return state.failed(refusal)
            }
            touch()
        }

        if connectAsked, !announcedLinked, case let .open(sas) = host.link.connection {
            announcedLinked = true
            state.set("sas", sas)
            state.set(phase: "linked")
            touch()
        }

        // ── a batch that will never complete is an ANSWER ───────────────────
        if let failure = host.failedBatch() {
            return state.failed("a batch ended with no result: \(failure)")
        }

        // ── the two directions ──────────────────────────────────────────────
        peakSent = max(peakSent, host.sentBatches())
        peakReceived = max(peakReceived, host.receivedBatches())
        let sent = peakSent
        let received = peakReceived
        if announcedLinked, !announcedComplete, sent >= 1, received >= expectedInbound {
            announcedComplete = true
            state.set(phase: "complete")
            touch()
        }

        // ── the diagnosis a timeout would otherwise have to be inferred from ─
        //
        // Narrow on purpose: phases, counts, a roster of names, and the link's
        // own error KEY. No SDP, no candidate, no key, no SAS beyond the field
        // above, no message body and no file content.
        let roster = rosterFingerprint()
        let now = "room=\(host.discovery.state) link=\(host.link.connection)"
            + " roster=[\(roster)] sent=\(sent) received=\(received)"
            + " err=\(host.link.actionError ?? "-")"
        if now != fingerprint {
            fingerprint = now
            state.set("room", String(describing: host.discovery.state))
            state.set("roster", roster)
            state.set("sentBatches", String(sent))
            state.set("receivedBatches", String(received))
            log("progress: \(now)")
            touch()
        }

        // Terminal phases are not watched: after `/release` the link is
        // deliberately over and after `/stop-advertising` the roster is
        // deliberately empty, so "nothing moved" is the expected condition
        // rather than a failure.
        guard state.phase != "released", state.phase != "stopped" else { return }
        guard Date().timeIntervalSince(lastProgress) < Self.idleCeiling else {
            return state.failed(
                "nothing moved for \(Int(Self.idleCeiling))s at phase \(state.phase): \(now)")
        }
    }

    /// The roster as names plus what each announced, sorted so a change is a
    /// change rather than a reordering.
    private func rosterFingerprint() -> String {
        host.discovery.devices
            .map { "\($0.name)/\($0.supportsLink ? "link" : "legacy")" }
            .sorted().joined(separator: ",")
    }

    // MARK: the launcher's commands

    func connect() -> [String: Any] {
        guard announcedDiscovered else {
            return ["error": "the Android device has not been discovered yet",
                    "phase": state.phase]
        }
        connectAsked = true
        touch()
        return ["ok": true, "dialSide": Config.dialSide.rawValue]
    }

    func message() -> [String: Any] {
        guard announcedLinked else {
            return ["error": "there is no open link to send a message on", "phase": state.phase]
        }
        guard host.send(message: Config.plan.message) else {
            return ["error": "the composer refused the message",
                    "actionError": host.link.actionError ?? "-"]
        }
        state.set("messageSent", "true")
        touch()
        // The LENGTH, never the body: a log is a durable artifact and a message
        // is content.
        log("sent this side's message (\(Config.plan.message.utf8.count) bytes)")
        return ["ok": true, "bytes": Config.plan.message.utf8.count]
    }

    func files() -> [String: Any] {
        guard announcedLinked else {
            return ["error": "there is no open link to send a batch on", "phase": state.phase]
        }
        if let refusal = host.sendPlan() { return ["error": refusal] }
        state.set("batchEnqueued", "true")
        touch()
        return ["ok": true, "files": Config.plan.files.count]
    }

    /// End the link and FREEZE what it produced.
    ///
    /// The freeze reads `allReceipts`/`allMessages`, which is the only honest
    /// total once a link has ended: `LinkCounterpart` archives a link's record
    /// on `.ended` and then dismisses the workspace, which releases the very
    /// models the live read comes from.
    func release() -> [String: Any] {
        host.release()
        state.set(phase: "releasing")
        touch()
        Task { @MainActor in
            // Bounded, and a wait on a CONDITION: the archive is written by the
            // counterpart's own `.ended` observer, so freezing before it has
            // run would record an empty link.
            let deadline = Date().addingTimeInterval(30)
            while self.host.link.connection.isActive, Date() < deadline {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            state.freeze(receipts: self.host.counterpart.allReceipts(),
                         messages: self.host.counterpart.allMessages())
            // Read AFTER the link ended: "the room survived its own transfer"
            // is a claim about the roster once the session is gone, and reading
            // it while the link was up would be a claim about nothing.
            let roster = self.host.discovery.devices
                .map { $0.name }.sorted().joined(separator: ",")
            state.set("rosterAfterLink", roster)
            state.set("targetStillListed", self.host.target() != nil ? "true" : "false")
            state.set(phase: "released")
            self.touch()
        }
        return ["ok": true]
    }

    func stopAdvertising() -> [String: Any] {
        host.stopAdvertising()
        state.set(phase: "stopped")
        touch()
        return ["ok": true]
    }

    func observed() -> [String: Any] { host.observed() }

    func teardown() {
        finished = true
        host.teardown()
    }
}

// MARK: - the topology probe

/// A standalone diagnostic, and NOT an acceptance. See `Role.dialProbe`.
///
/// Bonjour's two halves fail separately, and the one this round depends on that
/// nothing else exercises is the DIAL: a host that can SEE an instance's
/// advertisement has not thereby shown it can open a stream to the address
/// behind it. Learning that from a full round costs an install, a boot and a
/// thirty-second establishment; learning it here costs about half a minute.
///
/// ## Every conclusion is POSITIVE, and the fourth one is "no conclusion"
///
/// The first version of this probe inferred `open` from "no close within the
/// window", which is not an observation of anything: a connection still in
/// `.preparing` on an unanswered SYN neither closes nor connects, and a close
/// can just as easily be an application-level close after a perfectly reachable
/// handshake. Both readings were reported as one word. So this reports what
/// `NWConnection`'s own state machine SAID, and distinguishes not knowing:
///
///  * `ready` — the TCP connection was established to the resolved service.
///    Positive. It is NOT a claim that a `link/1` would succeed over it; only
///    the round itself shows that;
///  * `failed` — refused, or the route could not be used, with the framework's
///    own error. Positive;
///  * `waiting` — the path cannot currently be satisfied, with the error. Also
///    positive, and distinct from a refusal: the framework is still retrying;
///  * `indeterminate` — still `.preparing` at the bound. **No conclusion.** An
///    unanswered SYN looks exactly like this, and so does a slow one.
///
/// The full ordered transition list and any bytes received are reported beside
/// the verdict as secondary facts. Neither is the verdict.
///
/// ## What this dials with, and what it does not touch
///
/// The endpoint is the product's own service triple — `LOCAL_PEER_SERVICE_TYPE`
/// and `LOCAL_PEER_SERVICE_DOMAIN`, addressed by the identity, which is what
/// `NetworkLocalPeerTransport.connect(to:)` builds. The PARAMETERS are
/// reconstructed here rather than taken from the product, because
/// `NetworkLocalPeerTransport.parameters(_:)` is `internal` and this package is
/// outside its module: `.tcp`, `includePeerToPeer = false`, and an empty
/// `prohibitedInterfaceTypes` — the same three answers its DEBUG same-host
/// branch resolves. That reconstruction is why this is a private DIAGNOSTIC
/// rather than transport acceptance, and it is stated here so a green probe is
/// never read as evidence about the product's own dial. No product module is
/// modified or reached into.
@MainActor final class ProbeRun {
    private let host: BidirectionalHost
    private let queue = DispatchQueue(label: "com.relayium.acceptance.dialprobe")
    private var connection: NWConnection?
    private var finished = false

    /// Long enough for a browse to land, and for a SYN to be answered or
    /// refused; bounded so an unroutable address is reported as a diagnosis
    /// rather than hung on.
    static let discoveryDeadline: TimeInterval = 60
    static let dialWindow: TimeInterval = 30

    init() throws {
        host = try BidirectionalHost()
    }

    func start() {
        host.start()
        state.set(phase: "advertising")
        state.set("peerName", host.advertisement.name)
        state.set("targetName", Config.targetName)
        state.set("dialWindowSeconds", String(Int(Self.dialWindow)))
        Task { @MainActor in await self.run() }
    }

    private func run() async {
        let deadline = Date().addingTimeInterval(Self.discoveryDeadline)
        while Date() < deadline, host.target() == nil, !finished {
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        guard !finished else { return }
        guard let device = host.target() else {
            let roster = host.discovery.devices.map(\.name).sorted().joined(separator: ",")
            // The probe could not RUN, which is a different thing from a route
            // it could not use, so this is the one path that fails the process.
            return state.failed(
                "no unique device named \(Config.targetName) was discovered in "
                + "\(Int(Self.discoveryDeadline))s; the roster held [\(roster)]")
        }
        state.set("targetId", device.id)
        state.set("discovered", "true")
        state.set(phase: "dialing")

        let observation = DialObservation()
        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = false
        // The same route the DEBUG same-host branch permits, and nothing wider.
        parameters.prohibitedInterfaceTypes = []
        let endpoint = NWEndpoint.service(name: device.id,
                                          type: LOCAL_PEER_SERVICE_TYPE,
                                          domain: LOCAL_PEER_SERVICE_DOMAIN,
                                          interface: nil)
        let connection = NWConnection(to: endpoint, using: parameters)
        self.connection = connection
        connection.stateUpdateHandler = { observation.record($0) }
        connection.start(queue: queue)
        // Secondary, and never the verdict: a peer that says nothing back is
        // behaving exactly as the channel's inbound grace requires of it.
        receive(on: connection, into: observation)

        let settle = Date().addingTimeInterval(Self.dialWindow)
        while Date() < settle, !observation.isSettled, !finished {
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        guard !finished else { return }

        let verdict = observation.verdict()
        state.set("dial", verdict.name)
        state.set("dialTransitions", observation.transitionList())
        state.set("bytesReceived", String(observation.byteCount()))
        if let detail = verdict.detail { state.set("dialError", detail) }
        state.set("dialParameters",
                  "reconstructed: tcp, includePeerToPeer=false, prohibitedInterfaceTypes=[]")
        // `done` for every ANSWER, including a negative one: the probe worked,
        // and conflating "the route is unusable" with "the probe broke" is how a
        // definite negative gets read as a harness fault.
        state.set(phase: "done")
        log("dial verdict: \(verdict.name) after \(Int(Self.dialWindow))s window")
    }

    private func receive(on connection: NWConnection, into observation: DialObservation) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) {
            [weak self] data, _, complete, error in
            if let data, !data.isEmpty { observation.add(bytes: data.count) }
            guard error == nil, !complete else { return }
            guard let self else { return }
            Task { @MainActor in
                guard !self.finished, let live = self.connection else { return }
                self.receive(on: live, into: observation)
            }
        }
    }

    func observed() -> [String: Any] { host.observed() }

    func teardown() {
        finished = true
        connection?.stateUpdateHandler = nil
        connection?.cancel()
        connection = nil
        host.teardown()
    }
}

/// What `NWConnection`'s state machine said, in order, read from the main actor.
///
/// Every transition is kept rather than only the last: `preparing → waiting →
/// preparing` and `preparing → ready` are different answers, and a probe that
/// reported one state would make them look alike.
final class DialObservation: @unchecked Sendable {
    struct Verdict {
        let name: String
        let detail: String?
    }

    private let lock = NSLock()
    private var transitions: [String] = []
    private var reachedReady = false
    private var failure: String?
    private var waiting: String?
    private var bytes = 0

    /// Whether a POSITIVE answer has arrived, so the caller can stop waiting
    /// early rather than always spending the whole window.
    var isSettled: Bool {
        lock.lock(); defer { lock.unlock() }
        return reachedReady || failure != nil
    }

    func record(_ state: NWConnection.State) {
        lock.lock()
        switch state {
        case .setup:
            transitions.append("setup")
        case .preparing:
            transitions.append("preparing")
        case .ready:
            transitions.append("ready")
            reachedReady = true
        case let .waiting(error):
            transitions.append("waiting(\(error))")
            // The FIRST reason, because a path that cannot be satisfied reports
            // the same error repeatedly and the first is the cause.
            if waiting == nil { waiting = "\(error)" }
        case let .failed(error):
            transitions.append("failed(\(error))")
            if failure == nil { failure = "\(error)" }
        case .cancelled:
            transitions.append("cancelled")
        @unknown default:
            transitions.append("unknown")
        }
        // Bounded: a path that flaps must not grow this without limit.
        if transitions.count > 64 { transitions.removeFirst() }
        lock.unlock()
    }

    func add(bytes count: Int) {
        lock.lock(); bytes += count; lock.unlock()
    }

    func byteCount() -> Int {
        lock.lock(); defer { lock.unlock() }; return bytes
    }

    func transitionList() -> String {
        lock.lock(); defer { lock.unlock() }
        return transitions.joined(separator: " → ")
    }

    /// **`ready` before `failed`, and the order is the point.** A connection
    /// that was established and then closed proves the route exists; reporting
    /// the later close as the verdict is precisely the "application close after
    /// a reachable handshake" that the previous version of this probe could not
    /// tell from an unroutable address.
    func verdict() -> Verdict {
        lock.lock(); defer { lock.unlock() }
        if reachedReady { return Verdict(name: "ready", detail: nil) }
        if let failure { return Verdict(name: "failed", detail: failure) }
        if let waiting { return Verdict(name: "waiting", detail: waiting) }
        return Verdict(name: "indeterminate",
                       detail: "still preparing at the bound; no conclusion")
    }
}

// MARK: - the process

/// The one live object, reached from the control API's queue through the
/// bounded hops below.
@MainActor enum RunBox {
    static var acceptance: Run?
    static var probe: ProbeRun?
}

/// Read the live view from the control queue, without hanging on the main one.
///
/// Every model reported here is `@MainActor` and the control API's handlers run
/// on the listener's own queue, so the hop is unavoidable. It is BOUNDED, and
/// that is the part worth stating: a main actor stuck inside a link is exactly
/// the situation a caller is polling to diagnose, and an unbounded
/// `DispatchQueue.main.sync` would answer that by hanging the one API that
/// could have reported it.
func onMainActor(timeout: TimeInterval = 10,
                 _ body: @escaping @MainActor () -> [String: Any]) -> [String: Any]? {
    let ready = DispatchSemaphore(value: 0)
    let box = ObservationBox()
    Task { @MainActor in
        box.value = body()
        ready.signal()
    }
    guard ready.wait(timeout: .now() + timeout) == .success else { return nil }
    return box.value
}

/// A one-shot handoff across the queue boundary. Written on the main actor
/// before the semaphore is signalled and read only after that signal, so the
/// ordering the semaphore establishes is the whole synchronisation.
final class ObservationBox: @unchecked Sendable {
    var value: [String: Any]?
}

/// The main-actor command surface, or a 409 naming the role that has none.
func command(_ name: String,
             _ body: @escaping @MainActor (Run) -> [String: Any]) -> (status: Int, body: Data) {
    guard Config.role == .bidirectional else {
        return json(["error": "this role cannot be driven", "role": Config.role.rawValue,
                     "command": name], status: 409)
    }
    guard let answer = onMainActor({
        guard let run = RunBox.acceptance else { return ["error": "the run has not started"] }
        return body(run)
    }) else {
        return json(["error": "the main actor did not answer in time", "command": name,
                     "phase": state.phase], status: 409)
    }
    return json(answer, status: answer["error"] == nil ? 200 : 400)
}

let controlServer: LoopbackControlServer
do {
    controlServer = try LoopbackControlServer(
        token: Config.controlToken,
        routes: [
            .init(method: "POST", path: "/start") { _ in
                guard state.phase == "idle" else {
                    return json(["error": "already started", "phase": state.phase], status: 409)
                }
                state.set(phase: "starting")
                Task { @MainActor in
                    do {
                        switch Config.role {
                        case .bidirectional:
                            let run = try Run(
                                expectedInbound: Int(option("--expect-inbound-batches") ?? "") ?? 1)
                            RunBox.acceptance = run
                            run.start()
                        case .dialProbe:
                            let probe = try ProbeRun()
                            RunBox.probe = probe
                            probe.start()
                        }
                    } catch {
                        state.failed("the peer could not be composed: \(error)")
                    }
                }
                return json(["ok": true])
            },
            .init(method: "GET", path: "/status") { _ in json(state.snapshot()) },
            // The live link view, for a caller that decides for itself when
            // enough has arrived. `/result` is the terminal document and is
            // deliberately different: it reads the ARCHIVE, which is the only
            // honest total once the link has been dismissed.
            .init(method: "GET", path: "/observed") { _ in
                guard let facts = onMainActor({
                    if let run = RunBox.acceptance { return run.observed() }
                    if let probe = RunBox.probe { return probe.observed() }
                    return ["error": "the run has not started"]
                }) else {
                    return json(["error": "the main actor did not answer in time",
                                 "phase": state.phase], status: 409)
                }
                return json(facts)
            },
            .init(method: "GET", path: "/result") { _ in json(state.result()) },
            .init(method: "POST", path: "/connect") { _ in command("connect") { $0.connect() } },
            .init(method: "POST", path: "/message") { _ in command("message") { $0.message() } },
            .init(method: "POST", path: "/files") { _ in command("files") { $0.files() } },
            // The FIRST barrier: this side stops holding the link only when the
            // launcher has seen the Android half finish asserting against it.
            .init(method: "POST", path: "/release") { _ in command("release") { $0.release() } },
            // The SECOND barrier, and separate for the reason the two-Android
            // round records: withdrawing this advertisement removes this device
            // from the Android half's list — correctly — so it must not happen
            // while that half is still checking it.
            .init(method: "POST", path: "/stop-advertising") { _ in
                command("stop-advertising") { $0.stopAdvertising() }
            },
            .init(method: "POST", path: "/shutdown") { _ in
                Task { @MainActor in
                    RunBox.acceptance?.teardown()
                    RunBox.probe?.teardown()
                }
                // Answered before exiting, so the launcher sees a clean 200
                // rather than a connection reset it would have to treat as
                // indistinguishable from a crash.
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { exit(0) }
                return json(["ok": true])
            },
        ],
        log: { log($0) })
} catch {
    fail("could not open the control socket: \(error)")
}

do {
    let port = try controlServer.start()
    // The ONE line the launcher parses. On stdout, alone, so the launcher never
    // has to scrape the log for it.
    print("RELAYIUM_PEER_READY {\"port\":\(port),\"role\":\"\(Config.role.rawValue)\"}")
    fflush(stdout)
    log("control API on 127.0.0.1:\(port) for \(Config.role.rawValue) at \(Config.origin)")
} catch {
    fail("could not start the control API: \(error)")
}

dispatchMain()
