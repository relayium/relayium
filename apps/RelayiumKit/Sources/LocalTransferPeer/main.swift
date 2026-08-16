import Foundation
import RelayiumAppKit
import RelayiumKit
import RelayiumPeerKit

// The acceptance peer.
//
// One binary, four roles, and a loopback control API the launcher drives. It
// exists because XCUITest can drive exactly ONE app, so the second endpoint of
// any real transfer has to be a separate process — and because a transfer that
// "completed" is worth nothing as evidence unless both ends can state, in
// digests, what they believe passed between them.
//
//   LocalTransferPeer --role nearby-receiver --origin http://127.0.0.1:P \
//                     --name <room name> --receive-root <dir> --run-tag <tag>
//   LocalTransferPeer --role nearby-sender   --origin ... --name ... \
//                     --counterpart <name> --run-tag <tag>
//   LocalTransferPeer --role pair-sender     --origin ... --receive-root ... --run-tag ...
//   LocalTransferPeer --role pair-receiver   --origin ... --receive-root ... --run-tag ...
//
// Secrets arrive in the ENVIRONMENT and never in argv:
//   RELAYIUM_ACCEPTANCE_CONTROL_TOKEN   the control API bearer (required)
//   RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN   the account bearer a mint needs
//                                       (pair-sender only)
// argv on macOS is readable by every process this user runs, so a token there
// would be published to the whole session for the life of the run.

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
    case nearbyReceiver = "nearby-receiver"
    case nearbySender = "nearby-sender"
    case pairSender = "pair-sender"
    case pairReceiver = "pair-receiver"
    /// The `link/1` pairing surface, which is a different wire from the two
    /// above: `AppPairHost` drives the LEGACY code room, and nothing here could
    /// stand a real macOS link pairing room up against a second endpoint until
    /// this role existed. See `AppPairLinkHost`.
    case pairLink = "pair-link"
}

/// The launch configuration, resolved once.
///
/// A namespace rather than top-level `let`s because the run classes below close
/// over it, and Swift will not let a type capture a top-level binding in
/// `main.swift` — it is local to the implicit main function, however global it
/// looks.
enum Config {
    static let role: Role = {
        guard let role = Role(rawValue: require("--role")) else {
            fail("--role must be one of nearby-receiver, nearby-sender, "
                 + "pair-sender, pair-receiver, pair-link")
        }
        return role
    }()

    /// **Validated by the product's own seam, not by a second parser here.**
    ///
    /// If this had its own idea of what "loopback" means, an acceptance run
    /// could pass against an origin the app itself would refuse — which would
    /// make the suite evidence about this file rather than about the shipped
    /// rule. Reusing `AppEnvironment.loopbackTransferOrigin` means the peer
    /// physically cannot address anything the app would not.
    static let origin: URL = {
        let raw = require("--origin")
        guard let origin = AppEnvironment.loopbackTransferOrigin(raw) else {
            fail("--origin \(raw) is not a loopback origin the app would accept")
        }
        return origin
    }()

    static let runTag = require("--run-tag")

    /// Secrets arrive in the environment, never in argv: argv on macOS is
    /// readable by every process this user runs.
    static let controlToken: String = {
        let token = ProcessInfo.processInfo
            .environment["RELAYIUM_ACCEPTANCE_CONTROL_TOKEN"] ?? ""
        guard !token.isEmpty else {
            fail("RELAYIUM_ACCEPTANCE_CONTROL_TOKEN must be set in the environment")
        }
        return token
    }()

    static let receiveRoot: URL? = option("--receive-root").map { URL(fileURLWithPath: $0) }
}

let role = Config.role
let origin = Config.origin
let runTag = Config.runTag
let controlToken = Config.controlToken

extension Config {
    static let batch = AcceptanceBatch.make(runTag: runTag)
    static let sentReceipts = AcceptanceBatch.receipts(for: batch)
}

let batch = Config.batch
let sentReceipts = Config.sentReceipts

// MARK: - shared state

final class State: @unchecked Sendable {
    private let lock = NSLock()
    private var _phase = "idle"
    private var _detail: [String: String] = [:]
    private var _receipts: [FileReceipt] = []
    private var _failure: String?

    var phase: String { lock.lock(); defer { lock.unlock() }; return _phase }
    var failure: String? { lock.lock(); defer { lock.unlock() }; return _failure }

    func set(phase: String) {
        lock.lock(); _phase = phase; lock.unlock()
        log("phase: \(phase)")
    }

    func set(_ key: String, _ value: String) {
        lock.lock(); _detail[key] = value; lock.unlock()
    }

    func detail(_ key: String) -> String? {
        lock.lock(); defer { lock.unlock() }; return _detail[key]
    }

    func finish(receipts: [FileReceipt]) {
        lock.lock(); _receipts = receipts; _phase = "done"; lock.unlock()
        log("phase: done with \(receipts.count) receipt(s)")
    }

    func failed(_ reason: String) {
        lock.lock()
        if _failure == nil { _failure = reason; _phase = "failed" }
        lock.unlock()
        log("phase: failed — \(reason)")
    }

    func snapshot() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        var out: [String: Any] = ["phase": _phase, "role": Config.role.rawValue,
                                  "origin": Config.origin.absoluteString,
                                  "runTag": Config.runTag]
        for (key, value) in _detail { out[key] = value }
        if let _failure { out["failure"] = _failure }
        return out
    }

    func result() -> [String: Any] {
        lock.lock()
        let receipts = _receipts
        let phase = _phase
        let failure = _failure
        lock.unlock()
        var out: [String: Any] = [
            "phase": phase,
            "role": Config.role.rawValue,
            // The origin this process actually resolved, echoed back so the
            // launcher's assertion that the run was local is made against the
            // peer's own answer rather than against the string it passed in.
            "origin": Config.origin.absoluteString,
            "files": receipts.map { receipt -> [String: Any] in
                var entry: [String: Any] = ["name": receipt.name,
                                            "size": receipt.size,
                                            "sha256": receipt.sha256]
                if let path = receipt.path { entry["path"] = path }
                return entry
            },
        ]
        if let failure { out["failure"] = failure }
        return out
    }
}

let state = State()

func json(_ value: [String: Any], status: Int = 200) -> (status: Int, body: Data) {
    let data = (try? JSONSerialization.data(withJSONObject: value,
                                            options: [.sortedKeys]))
        ?? Data(#"{"error":"unencodable"}"#.utf8)
    return (status, data)
}

// MARK: - the roles

/// Nearby, receiving: the app's own machinery, resident, answering an offer
/// nobody there accepted.
///
/// **Two wires, one host.** A counterpart that never announced `link/1` reaches
/// the legacy nearby machinery; one that did reaches the link workspace. Which
/// arrives is decided by the peer before anybody dials, so this waits on both
/// and finishes on whichever produced a committed result. T2a's `PlainPeer`
/// drives the first; a built App drives the second.
@MainActor final class NearbyReceiverRun {
    let host: AppReceiverHost

    /// How long a run may wait with NOTHING having arrived.
    ///
    /// Deliberately measured from the last observed progress rather than from
    /// `start`, because the two callers have very different clocks: T2a dials
    /// within a second of `/start`, while a UI acceptance run has to boot a
    /// simulator, launch an app and drive a roster first. Extending a fixed
    /// ceiling to cover the slower caller would have weakened the faster one's
    /// stall detection; resetting it on real progress covers both without
    /// either waiting on the other's worst case.
    static let idleCeiling: TimeInterval = 240

    init(receiveRoot: URL, name: String) throws {
        host = try AppReceiverHost(options: .init(
            baseURL: Config.origin, name: name, receiveRoot: receiveRoot,
            defaultsSuite: "com.relayium.acceptance.\(Config.runTag)"))
        // Every link transition this side sees, in this peer's own log — which
        // a failed run retains and prints. A UI run's app is gone by the time
        // anybody reads the failure, so this is the only surviving account of
        // what the second endpoint actually did.
        host.linkCounterpart.logEvent = { log($0) }
    }

    func start() {
        host.start()
        state.set(phase: "resident")
        Task { @MainActor in
            var lastProgress = Date()
            var seen = ""
            while Date().timeIntervalSince(lastProgress) < Self.idleCeiling {
                if case .completed = host.fileModel.state {
                    state.finish(receipts: host.receipts())
                    return
                }
                if case let .failed(message) = host.fileModel.state {
                    return state.failed("legacy receive failed: \(message)")
                }
                // The link's own committed state. `received` is the only inbound
                // state that means bytes are on disk — `finished` is a report
                // this projection has seen no proof of, and its own doc says so.
                if let files = host.link.fileModel?.batches,
                   files.contains(where: { batch in
                       guard batch.direction == .inbound else { return false }
                       if case .received = batch.state { return true }
                       return false
                   }) {
                    state.finish(receipts: host.receipts())
                    return
                }
                // Any observable movement resets the stall clock — a link that is
                // establishing, digits that arrived, a message, a batch in
                // flight. An ORDERED fingerprint, not the fact dictionary's
                // `description`: a `[String: Any]` has no stable ordering, so
                // comparing two descriptions of identical state would report
                // progress at random and this ceiling would never fire.
                let progress = linkProgressFingerprint(host: host)
                if progress != seen {
                    seen = progress
                    lastProgress = Date()
                }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            state.failed("nothing arrived for \(Int(Self.idleCeiling))s: "
                         + linkProgressFingerprint(host: host))
        }
    }

    func teardown() { host.teardown() }
}

/// An ordered, stable rendering of everything about this link that can move.
///
/// Its only job is "did anything change since the last look", so it is built
/// from a fixed sequence of fields rather than from a dictionary. It is also
/// what a stalled run prints, which is why it names the phase and the batch
/// states rather than reducing them to a count.
@MainActor
func linkProgressFingerprint(host: AppReceiverHost) -> String {
    let batches = (host.link.fileModel?.batches ?? [])
        .map { "\($0.direction):\($0.state):\($0.transferredBytes)" }
        .joined(separator: ",")
    return "phase=\(host.link.connection)"
        + " epoch=\(host.linkEpoch())"
        + " sas=\(host.linkSAS() ?? "-")"
        + " messages=\(host.receivedMessages().count)"
        + " batches=[\(batches)]"
}

/// The live link view a UI acceptance run polls.
///
/// Separate from `/status` and `/result` on purpose: those two carry T2a's
/// contract, which is a fixed batch and a terminal `done`, and a UI run has
/// neither — it decides for itself when the file and the message it drove have
/// both arrived. Nothing here is derived: every value is read off the model the
/// production writer filled in.
@MainActor
func liveLinkFacts(host: AppReceiverHost) -> [String: Any] {
    func entries(_ receipts: [FileReceipt]) -> [[String: Any]] {
        receipts.map { receipt in
            var entry: [String: Any] = ["name": receipt.name, "size": receipt.size,
                                        "sha256": receipt.sha256]
            if let path = receipt.path { entry["path"] = path }
            return entry
        }
    }
    var out: [String: Any] = [
        "linkPhase": String(describing: host.link.connection),
        // **Which link these facts belong to.** A caller polling "has a SAS
        // arrived" has to be able to tell this link's digits from the previous
        // link's, because a resident counterpart serves several in one run and
        // the first version of this view could not — it answered a later poll
        // with an earlier link's residue and passed a test that had established
        // nothing.
        "epoch": host.linkEpoch(),
        "messages": host.receivedMessages(),
        "files": entries(host.receipts()),
        // Cumulative, across every link this process served. What a launcher
        // reads after the app has gone and the live link has been dismissed.
        "allMessages": host.allMessages(),
        "allFiles": entries(host.allReceipts()),
    ]
    if let sas = host.linkSAS() { out["sas"] = sas }
    if let batches = host.link.fileModel?.batches {
        out["batchStates"] = batches.map { "\($0.direction):\($0.state)" }
    }
    return out
}

/// Nearby, sending: a plain peer that dials the resident receiver by name.
final class NearbySenderRun: @unchecked Sendable {
    let peer: PlainPeer
    let counterpart: String

    init(name: String, counterpart: String) {
        self.counterpart = counterpart
        peer = PlainPeer(options: .init(
            baseURL: Config.origin, code: "", name: name,
            // **Empty, and that is the acceptance property.** Peers on one
            // machine pair on host candidates; a public STUN entry here would
            // send this machine's address to a third party on every run and
            // make an offline run depend on the internet.
            iceServers: [],
            log: { log($0) }))
    }

    func start() {
        Task {
            guard let peerId = await peer.awaitPeer(named: counterpart, timeout: 45) else {
                return state.failed("\(counterpart) never appeared in the code-less room")
            }
            state.set(phase: "offering")
            var handlers = PlainPeer.Handlers()
            handlers.onOpen = { [self] connection in
                peer.send(Config.batch, on: connection)
            }
            handlers.onControl = { control in
                // CTRL_COMPLETE is sent by the receiver only after its writer
                // finished and the batch verified, so this — not "we called
                // send()" — is the sending side's evidence that the far side
                // really wrote the bytes.
                guard control == .complete else { return }
                state.finish(receipts: Config.sentReceipts)
            }
            handlers.onError = { state.failed("sender: \($0)") }
            peer.connect(to: peerId, role: .initiator, handlers: handlers)
            state.set(phase: "connecting")
        }
    }

    func teardown() { peer.close() }
}

/// Pairing, sending: the app's own model mints a real code on the local server
/// and dials the peer that joins it.
@MainActor final class PairSenderRun {
    let host: AppPairHost
    init(receiveRoot: URL) throws {
        host = try AppPairHost(options: .init(
            baseURL: Config.origin, receiveRoot: receiveRoot,
            defaultsSuite: "com.relayium.acceptance.\(Config.runTag)"))
    }

    func start() {
        let bearer = ProcessInfo.processInfo
            .environment["RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN"] ?? ""
        guard !bearer.isEmpty else {
            return state.failed("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN is required to mint a code")
        }
        Task { @MainActor in
            // Staged BEFORE the code exists, exactly as the transfer surface
            // does it: `proceedAfterVerification` sends whatever is pending once
            // the handshake completes, and a selection staged afterwards would
            // race that.
            host.model.stageSend(
                sources: Config.batch.map {
                    DataSource(name: $0.meta.name, bytes: $0.bytes) as PlaintextSource
                },
                metas: Config.batch.map(\.meta))
            state.set(phase: "minting")
            await host.model.mintCode(token: bearer)
            guard case let .showingCode(code, _) = host.model.state else {
                return state.failed("mint did not produce a code: \(host.model.state)")
            }
            // Published for the launcher to hand to the joiner. A pairing code
            // is short-lived, single-use and useless without a peer on the same
            // hub — and this hub is bound to loopback.
            state.set("code", code)
            state.set(phase: "showing-code")
            await host.model.join(code: code, role: .initiator)
            let deadline = Date().addingTimeInterval(120)
            while Date() < deadline {
                if case .completed = host.model.state {
                    // The SENDER's completed state carries no received files;
                    // what it can state is what it handed over.
                    state.finish(receipts: Config.sentReceipts)
                    return
                }
                if case let .failed(message) = host.model.state {
                    return state.failed("pair send failed: \(message)")
                }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            state.failed("timed out sending over the pairing code")
        }
    }

    func teardown() { host.teardown() }
}

/// Pairing, receiving: the app's own model joins a code somebody typed.
@MainActor final class PairReceiverRun {
    let host: AppPairHost
    init(receiveRoot: URL) throws {
        host = try AppPairHost(options: .init(
            baseURL: Config.origin, receiveRoot: receiveRoot,
            defaultsSuite: "com.relayium.acceptance.\(Config.runTag)"))
    }

    func start(code: String) {
        guard isCompletePairingCode(code) else {
            return state.failed("not a pairing code: \(code)")
        }
        Task { @MainActor in
            state.set(phase: "joining")
            await host.model.join(code: code, role: .responder)
            let deadline = Date().addingTimeInterval(120)
            while Date() < deadline {
                if case .completed = host.model.state {
                    state.finish(receipts: host.receipts())
                    return
                }
                if case let .failed(message) = host.model.state {
                    return state.failed("pair receive failed: \(message)")
                }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            state.failed("timed out receiving over the pairing code")
        }
    }

    func teardown() { host.teardown() }
}

/// Pairing over `link/1`: the app's own unified workspace on a real code.
///
/// **Driven rather than scripted.** The other pair roles run to a fixed batch
/// and a terminal `done`; this one is polled and told what to do, because the
/// counterpart is a browser whose own timing the launcher owns. What it must
/// never do is answer for the app, so every value `/observed` reports is read
/// off the production models — see `AppPairLinkHost.observed`.
@MainActor final class PairLinkRun {
    let host: AppPairLinkHost

    init(receiveRoot: URL) throws {
        host = try AppPairLinkHost(options: .init(
            baseURL: Config.origin, receiveRoot: receiveRoot,
            defaultsSuite: "com.relayium.acceptance.\(Config.runTag)"))
        host.logEvent = { log($0) }
    }

    /// `create` mints a real code on the local server; `join` takes one the
    /// launcher read off the other endpoint.
    func start(action: String, code: String) {
        host.start()
        Task { @MainActor in
            switch action {
            case "create":
                let bearer = ProcessInfo.processInfo
                    .environment["RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN"] ?? ""
                guard !bearer.isEmpty else {
                    return state.failed("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN is required to mint a code")
                }
                state.set(phase: "minting")
                guard let minted = await host.createCode(token: bearer) else {
                    return state.failed("mint did not produce a code: \(host.fileModel.state)")
                }
                state.set("code", minted)
                state.set(phase: "watching")
            case "join":
                guard isCompletePairingCode(code) else {
                    return state.failed("not a pairing code: \(code)")
                }
                state.set("code", code)
                host.joinCode(code)
                state.set(phase: "watching")
            default:
                state.failed("--- unknown action \(action); expected create or join")
            }
        }
    }

    func teardown() { host.teardown() }
}

// MARK: - assembly

/// **No default.** `AppEnvironment.defaultLinkReceiveDirectory()` is the user's
/// Downloads folder, and a receiving role that silently fell back to it would
/// write real files into a real person's folder — the one outcome the isolation
/// rules for this fixture name explicitly.
func requireReceiveRoot() -> URL {
    guard let root = Config.receiveRoot else {
        fail("--receive-root is required for \(role.rawValue)")
    }
    return root
}

/// The assembled run, built on the main actor when `/start` arrives.
///
/// **Lazily, and that is a correctness requirement rather than a preference.**
/// Every receiving role is `@MainActor`, so assembling one means hopping to the
/// main actor — and on this executable the main actor IS the main thread, which
/// does not begin servicing work until `dispatchMain()` at the bottom of this
/// file. Assembling eagerly here and blocking on a semaphore until it finished
/// deadlocked on the first run: the main thread waited for a task that could
/// only run on the main thread.
@MainActor
final class RunBox {
    static let shared = RunBox()

    private var teardownRun: (() -> Void)?

    /// The live view `/observed` answers, installed by the roles that have one.
    ///
    /// A closure rather than a stored host, so a role with no link surface —
    /// every role but `nearby-receiver` today — answers "no live view" instead
    /// of an empty one that reads like a link that produced nothing.
    private var observeRun: (() -> [String: Any])?

    /// The roles a launcher can also SEND through. Nil for every role that runs
    /// to a fixed script, which is all of them but `pair-link`.
    private var driveRun: ((String, [String: Any]) -> [String: Any])?

    func observed() -> [String: Any]? { observeRun?() }

    func drive(_ command: String, _ body: [String: Any]) -> [String: Any]? {
        driveRun?(command, body)
    }

    /// Builds the role's run object and starts it. Any failure becomes a
    /// reported phase rather than an exit, so the launcher reads a `failed`
    /// status with a reason instead of losing the process.
    func start(body: Data) {
        do {
            switch Config.role {
            case .nearbyReceiver:
                let run = try NearbyReceiverRun(receiveRoot: requireReceiveRoot(),
                                                name: require("--name"))
                teardownRun = { run.teardown() }
                observeRun = { liveLinkFacts(host: run.host) }
                run.start()
            case .nearbySender:
                let run = NearbySenderRun(name: require("--name"),
                                          counterpart: require("--counterpart"))
                teardownRun = { run.teardown() }
                run.start()
            case .pairSender:
                let run = try PairSenderRun(receiveRoot: requireReceiveRoot())
                teardownRun = { run.teardown() }
                run.start()
            case .pairLink:
                let run = try PairLinkRun(receiveRoot: requireReceiveRoot())
                teardownRun = { run.teardown() }
                observeRun = { run.host.observed() }
                driveRun = { command, body in run.host.drive(command, body) }
                let parsed = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
                run.start(action: (parsed?["action"] as? String) ?? "join",
                          code: (parsed?["code"] as? String) ?? "")
            case .pairReceiver:
                let run = try PairReceiverRun(receiveRoot: requireReceiveRoot())
                teardownRun = { run.teardown() }
                let parsed = (try? JSONSerialization.jsonObject(with: body))
                    as? [String: Any]
                run.start(code: (parsed?["code"] as? String) ?? "")
            }
        } catch {
            state.failed("could not assemble \(Config.role.rawValue): \(error)")
        }
    }

    func teardown() {
        teardownRun?()
        teardownRun = nil
        observeRun = nil
        driveRun = nil
    }
}

/// Read the live view from the control queue, without hanging on the main one.
///
/// Every model this reports is `@MainActor`, and the control API's handlers run
/// on the listener's own queue — so the hop is unavoidable. It is BOUNDED, and
/// that is the part worth stating: a main actor stuck inside a link is exactly
/// the situation a caller is polling to diagnose, and an unbounded
/// `DispatchQueue.main.sync` would answer that by hanging the one API that could
/// have reported it. A timeout instead surfaces as a 409 the caller can print.
///
/// Returns nil for "no live view" — either the role has none, or the main actor
/// did not answer in time; the route distinguishes neither because the caller's
/// next move is the same in both cases: poll again, then print and fail.
func mainActorObservation(timeout: TimeInterval = 5) -> [String: Any]? {
    let ready = DispatchSemaphore(value: 0)
    let box = ObservationBox()
    Task { @MainActor in
        box.value = RunBox.shared.observed()
        ready.signal()
    }
    guard ready.wait(timeout: .now() + timeout) == .success else { return nil }
    return box.value
}

/// The same bounded hop, for a command rather than a read. See
/// `mainActorObservation` for why it is bounded.
func mainActorDrive(_ command: String, _ body: [String: Any],
                    timeout: TimeInterval = 10) -> [String: Any]? {
    let ready = DispatchSemaphore(value: 0)
    let box = ObservationBox()
    let payload = SendableBox(body)
    Task { @MainActor in
        box.value = RunBox.shared.drive(command, payload.value)
        ready.signal()
    }
    guard ready.wait(timeout: .now() + timeout) == .success else { return nil }
    return box.value
}

/// Carries a decoded JSON body across the hop above. `[String: Any]` is not
/// `Sendable`, and it is genuinely immutable here — decoded once by the route
/// handler and read once on the main actor — so the box states that rather than
/// leaving the compiler to assume otherwise.
final class SendableBox: @unchecked Sendable {
    let value: [String: Any]
    init(_ value: [String: Any]) { self.value = value }
}

/// A one-shot handoff across the queue boundary. Written on the main actor
/// before the semaphore is signalled and read only after that signal, so the
/// ordering the semaphore establishes is the whole synchronisation.
final class ObservationBox: @unchecked Sendable {
    var value: [String: Any]?
}

let control: LoopbackControlServer
do {
    control = try LoopbackControlServer(
        token: controlToken,
        routes: [
            .init(method: "POST", path: "/start") { body in
                guard state.phase == "idle" else {
                    return json(["error": "already started", "phase": state.phase], status: 409)
                }
                state.set(phase: "starting")
                Task { @MainActor in RunBox.shared.start(body: body) }
                return json(["ok": true])
            },
            .init(method: "GET", path: "/status") { _ in json(state.snapshot()) },
            // The live link view, for a caller that decides for itself when
            // enough has arrived. `/status` and `/result` are untouched: they
            // carry T2a's contract — a fixed batch and a terminal `done` — and a
            // UI acceptance run has neither.
            .init(method: "GET", path: "/observed") { _ in
                guard let facts = mainActorObservation() else {
                    return json(["error": "no live view for this role",
                                 "role": Config.role.rawValue], status: 409)
                }
                return json(facts)
            },
            // The launcher's own hand on the production send paths, for a role
            // whose counterpart is a browser the launcher is also driving. Only
            // `pair-link` answers; every other role runs to a fixed script and
            // says so rather than silently accepting a command it ignores.
            .init(method: "POST", path: "/drive") { body in
                let parsed = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
                let command = (parsed?["command"] as? String) ?? ""
                guard let answer = mainActorDrive(command, parsed ?? [:]) else {
                    return json(["error": "this role cannot be driven",
                                 "role": Config.role.rawValue], status: 409)
                }
                return json(answer, status: answer["error"] == nil ? 200 : 400)
            },
            .init(method: "GET", path: "/result") { _ in json(state.result()) },
            .init(method: "POST", path: "/shutdown") { _ in
                Task { @MainActor in RunBox.shared.teardown() }
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
    let port = try control.start()
    // The ONE line the launcher parses. On stdout, alone, so the launcher never
    // has to scrape the log for it.
    print("RELAYIUM_PEER_READY {\"port\":\(port),\"role\":\"\(role.rawValue)\"}")
    fflush(stdout)
    log("control API on 127.0.0.1:\(port) for \(role.rawValue) at \(origin)")
} catch {
    fail("could not start the control API: \(error)")
}

dispatchMain()
