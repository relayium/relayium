import Foundation
import XCTest

@testable import RelayiumKit

/// **The Swift half of the root Device Inbox admission contract.**
///
/// `contracts/device-inbox-admission-v1.json` is runtime-neutral: `InboxProtocol`
/// is not generated from it and it is not generated from `InboxProtocol`. This
/// file reads that one document through `RepoRoot` — the same resolver every
/// other repository-reading guard in this target uses — and compares it to the
/// closed sets this build already ships.
///
/// Three implementations read the same bytes and each compares them to its own
/// constants. Nothing is shared between the three readings, deliberately: a
/// common loader that misread the document would make all three agree with each
/// other about something none of them actually does.
///
/// ### Why this build can compare more than the browser can
///
/// `InboxTaskState`, `InboxDeviceErrorCode` and `InboxCentralErrorCode` are all
/// `CaseIterable`, so every set comparison below is EXACT in both directions
/// without reading any source: a case added here and to no other implementation
/// fails, and so does a contract member this build dropped. `InboxCapability` is
/// the one exception — it is a namespace of `static let`s, which nothing can
/// enumerate — so its completeness is read from `InboxProtocol.swift`'s own
/// source, and that scan fails loudly when it matches nothing rather than
/// reporting an empty set as agreement.
///
/// ### What is deliberately not compared
///
/// `InboxRejection`. It is the broad union of machine-readable `error` tokens
/// central can answer a REQUEST with, it is per-endpoint, and the browser folds
/// its own subset of it together with local failures like `cancelled` into one
/// presentation set. It is not one fact three implementations hold, and pinning
/// it here would freeze an HTTP surface rather than an admission vocabulary.
final class DeviceInboxAdmissionContractTests: XCTestCase {

    // MARK: - the document

    private static let path = "contracts/device-inbox-admission-v1.json"

    /// The closed top-level key set, sorted. Compared as an equality so an
    /// UNKNOWN fact and a DELETED one are both refused, in one assertion.
    private static let topLevelKeys = [
        "capabilityTokenSyntax", "capabilityTokens", "centralOnlyErrors", "consumers",
        "contract", "contractVersion", "deviceReportableErrors", "deviceReportableStates",
        "documentation", "keyAlgorithm", "noErrorValue", "protocolVersion",
        "requiredReceiveCapability", "stateTransitions", "taskStates", "terminalStates",
    ]

    /// The parsed document, or a failure naming what it wanted.
    ///
    /// `JSONSerialization` rather than `Decodable` on purpose: `Decodable`
    /// silently ignores a key no `CodingKeys` names, which is exactly the
    /// direction this test has to refuse.
    /// Never `XCTSkip`. A skipped test reports as "not a failure", which is the
    /// one outcome indistinguishable from a passing comparison — and a contract
    /// document that stopped being a JSON object is exactly when this target
    /// must be loud.
    private func contract() throws -> [String: Any] {
        let data = try RepoRoot.data(Self.path)
        let object = try JSONSerialization.jsonObject(with: data)
        return try XCTUnwrap(object as? [String: Any],
                             "\(Self.path) is not a JSON object")
    }

    private func strings(_ contract: [String: Any], _ key: String) throws -> [String] {
        try XCTUnwrap(contract[key] as? [String],
                      "\(Self.path): \(key) is missing or is not an array of strings")
    }

    private func string(_ contract: [String: Any], _ key: String) throws -> String {
        try XCTUnwrap(contract[key] as? String,
                      "\(Self.path): \(key) is missing or is not a string")
    }

    private func int(_ contract: [String: Any], _ key: String) throws -> Int {
        try XCTUnwrap(contract[key] as? Int, "\(Self.path): \(key) is missing or is not an integer")
    }

    private func transitions(_ contract: [String: Any]) throws -> [String: [String]] {
        try XCTUnwrap(contract["stateTransitions"] as? [String: [String]],
                      "\(Self.path): stateTransitions is missing or is not a map of string arrays")
    }

    // MARK: - the document alone

    /// Present, closed, ordered, duplicate-free and internally consistent —
    /// judged before anything is compared to this build, because an empty or
    /// truncated document would otherwise agree with it vacuously.
    func testTheContractDocumentIsWellFormed() throws {
        let c = try contract()

        XCTAssertEqual(c.keys.sorted(), Self.topLevelKeys,
                       "the contract's top-level keys are not the closed set this build knows. An "
                       + "extra key is a fact nothing here compares; a missing one is a fact no "
                       + "consumer compares any more.")
        XCTAssertEqual(try string(c, "contract"), "relayium.device-inbox.admission")
        XCTAssertEqual(try int(c, "contractVersion"), 1,
                       "a new contract version is a new file beside this one, never a rewrite of "
                       + "it: a consumer pinned to v1 must keep reading v1.")

        let documentation = try string(c, "documentation")
        XCTAssertEqual(documentation, "docs/DEVICE-INBOX-ADMISSION-CONTRACT.md")
        XCTAssertNoThrow(try RepoRoot.url(documentation),
                         "the contract points at a document that does not exist")

        let consumers = try strings(c, "consumers")
        XCTAssertEqual(consumers, ["go", "swift", "web"])
        XCTAssertTrue(consumers.contains("swift"), "this build is not a declared consumer")

        // Every list without a semantic order is strictly ascending, which is
        // both the determinism rule and the duplicate check.
        for key in ["consumers", "deviceReportableErrors", "centralOnlyErrors"] {
            let values = try strings(c, key)
            XCTAssertEqual(values, values.sorted(),
                           "\(key) is not in ascending order, so this document is not "
                           + "byte-determined by its facts")
            XCTAssertEqual(Set(values).count, values.count, "\(key) repeats a value")
        }

        // Every state list is a SUBSEQUENCE of taskStates: one deterministic
        // order rule that also refuses duplicates and unknown members.
        let states = try strings(c, "taskStates")
        XCTAssertEqual(Set(states).count, states.count, "taskStates repeats a state")
        let terminal = try strings(c, "terminalStates")
        let reportable = try strings(c, "deviceReportableStates")
        for (name, list) in [("terminalStates", terminal), ("deviceReportableStates", reportable)] {
            assertStateSubsequence(list, of: states, name: name)
        }

        let graph = try transitions(c)
        XCTAssertEqual(graph.keys.sorted(), states.sorted(),
                       "every state must be a transition key — terminal ones as an EMPTY list, so "
                       + "'has no successor' is stated rather than inferred from absence, which is "
                       + "what lets this build read terminality off the graph at all")
        for (from, targets) in graph {
            assertStateSubsequence(targets, of: states, name: "stateTransitions[\(from)]")
            XCTAssertFalse(targets.contains(from),
                           "stateTransitions[\(from)] contains a self-edge; a repeat of the "
                           + "current state is an idempotent no-op, not a transition")
        }

        // The terminal set and the graph are one fact written twice. They are
        // both present because this build has no transition table and reads
        // terminality from the set — so they are compared here, at the source.
        for state in states {
            XCTAssertEqual(terminal.contains(state), (graph[state] ?? []).isEmpty,
                           "state \(state) disagrees between terminalStates and the graph")
        }

        XCTAssertEqual(try string(c, "noErrorValue"), "",
                       "'nothing has gone wrong yet' is the absence of a token, not a token")
        let device = try strings(c, "deviceReportableErrors")
        let central = try strings(c, "centralOnlyErrors")
        XCTAssertFalse(device.contains(""), "the no-error value is stated once and is not a member")
        XCTAssertFalse(central.contains(""))
        XCTAssertTrue(Set(device).isDisjoint(with: Set(central)),
                      "a code is either a device's to submit or central's to write; a code that "
                      + "were both would let a device forge central's own account of events")

        // Capability entries: closed keys, declared consumers, ascending, and
        // conforming to the document's own syntax.
        let tokens = try capabilityEntries(c)
        XCTAssertEqual(tokens.map(\.token), tokens.map(\.token).sorted())
        XCTAssertEqual(Set(tokens.map(\.token)).count, tokens.count, "a capability token repeats")
        let syntax = try syntaxMatcher(c)
        let maxLength = try XCTUnwrap((c["capabilityTokenSyntax"] as? [String: Any])?["maxLength"] as? Int)
        for entry in tokens {
            XCTAssertTrue(syntax(entry.token),
                          "\(entry.token) does not match the contract's own capability syntax")
            XCTAssertLessThanOrEqual(entry.token.count, maxLength)
            XCTAssertFalse(entry.definedBy.isEmpty,
                           "\(entry.token) is defined by no consumer, so no test compares it")
            XCTAssertEqual(entry.definedBy, entry.definedBy.sorted())
            for consumer in entry.definedBy {
                XCTAssertTrue(consumers.contains(consumer),
                              "\(entry.token) names the unknown consumer \(consumer)")
            }
        }
        XCTAssertTrue(tokens.map(\.token).contains(try string(c, "requiredReceiveCapability")),
                      "requiredReceiveCapability is not one of the declared tokens")
    }

    // MARK: - the document against this build

    /// The protocol tokens this build speaks.
    func testTheProtocolTokensMatchTheContract() throws {
        let c = try contract()
        XCTAssertEqual(InboxProtocol.keyAlgorithm, try string(c, "keyAlgorithm"))
        XCTAssertEqual(InboxProtocol.versions, [try int(c, "protocolVersion")],
                       "this build speaks a version set the contract does not freeze. v1 and v2 "
                       + "are absent by decision, not by oversight: there is no dual stack.")
        XCTAssertEqual(InboxProtocol.taskProtocolVersion, try int(c, "protocolVersion"),
                       "the version a SENDER declares and the frozen protocol version are one "
                       + "number in a build with no dual stack")
        XCTAssertEqual(InboxProtocol.sealedBoxBytes, 32 + 32 + 16,
                       "the wrapped-key length is fixed by the frozen key algorithm")
    }

    /// The capability vocabulary, exactly — including the completeness half,
    /// which no `CaseIterable` can give for a namespace of `static let`s.
    func testTheCapabilityTokensMatchTheContract() throws {
        let c = try contract()
        let frozen = try capabilityEntries(c)
            .filter { $0.definedBy.contains("swift") }
            .map(\.token)
            .sorted()

        let declared = [
            InboxCapability.receiveV1, InboxCapability.receiveV3, InboxCapability.textV1,
            InboxCapability.autoAcceptV1, InboxCapability.resumeV1,
        ].sorted()
        XCTAssertEqual(declared, frozen,
                       "the tokens this build names and the tokens the contract attributes to it "
                       + "differ. A token only one implementation knows is a private extension to "
                       + "a shared vocabulary.")

        // The list above is hand-written, because nothing can enumerate a
        // namespace of `static let`s — so on its own it would keep passing after
        // a SIXTH token was added beside it. This reads them from the source
        // instead, and fails when it finds nothing rather than reporting an
        // empty set as agreement.
        let source = try RepoRoot.text("apps/RelayiumKit/Sources/RelayiumKit/DeviceInbox/InboxProtocol.swift")
        let scanned = Set(capabilityLiterals(in: source))
        XCTAssertFalse(scanned.isEmpty,
                       "the capability-literal scan of InboxProtocol.swift matched nothing. An "
                       + "empty scan agrees with every contract there is: either those constants "
                       + "moved or the pattern no longer describes them.")
        XCTAssertEqual(scanned.sorted(), frozen,
                       "InboxProtocol.swift declares capability literals the contract does not "
                       + "freeze, or is missing ones it does")

        // The required receive capability is one this build actually announces —
        // in the BASE set, so it is announced by every build that links this
        // module, not only by one with a text surface.
        let required = try string(c, "requiredReceiveCapability")
        XCTAssertEqual(required, InboxCapability.receiveV3)
        XCTAssertTrue(InboxProtocol.capabilities.contains(required))
        XCTAssertTrue(InboxProtocol.announcedCapabilities(presentingText: false).contains(required))
        XCTAssertTrue(InboxProtocol.announcedCapabilities(presentingText: true).contains(required))

        // Every token this build could ever announce is spelled the way the
        // contract's syntax requires.
        let syntax = try syntaxMatcher(c)
        for token in InboxProtocol.announcedCapabilities(presentingText: true) {
            XCTAssertTrue(syntax(token), "announced token \(token) violates the contract's syntax")
        }
        for bad in ["inbox.receive", "inbox.v0", "inbox.v01", "Inbox.receive.v1", "v1", ""] {
            XCTAssertFalse(syntax(bad), "the contract's syntax accepts \(bad)")
        }
    }

    /// The state vocabulary and both of its subsets, exactly.
    func testTheTaskStatesTerminalityAndReportabilityMatchTheContract() throws {
        let c = try contract()
        let states = try strings(c, "taskStates")
        let terminal = try strings(c, "terminalStates")
        let reportable = try strings(c, "deviceReportableStates")
        let graph = try transitions(c)

        // Ordered, not merely set-equal: the contract's order is the PRD's, and
        // every other state list in the document is ordered by it.
        XCTAssertEqual(InboxTaskState.allCases.map(\.rawValue), states)

        for state in states {
            let parsed = try XCTUnwrap(InboxTaskState(rawValue: state),
                                       "this build cannot parse the frozen state \(state)")
            XCTAssertEqual(parsed.isTerminal, terminal.contains(state),
                           "this build says terminal(\(state))=\(parsed.isTerminal)")
            // The same fact read from Go's graph rather than from the redundant
            // set: this build has no transition table, and this is what checks
            // its terminality rule against the server's state machine.
            XCTAssertEqual(parsed.isTerminal, (graph[state] ?? []).isEmpty,
                           "this build's terminality for \(state) disagrees with the frozen graph")
            XCTAssertEqual(parsed.isDeviceReportable, reportable.contains(state),
                           "this build says deviceReportable(\(state))=\(parsed.isDeviceReportable)")
        }

        // Fails closed on everything else, the sender-local phases included.
        for other in ["encrypting", "uploading", "registering", "Saved", "done", ""] {
            XCTAssertNil(InboxTaskState(rawValue: other),
                         "this build accepts the off-contract state \(other)")
        }
    }

    /// The error vocabulary, exactly and in both directions.
    func testTheErrorCodesMatchTheContract() throws {
        let c = try contract()
        let noError = try string(c, "noErrorValue")
        let device = try strings(c, "deviceReportableErrors")
        let central = try strings(c, "centralOnlyErrors")

        // `CaseIterable` makes this exact without reading any source: a case
        // added here and nowhere else fails, and so does a dropped one.
        XCTAssertEqual(InboxDeviceErrorCode.allCases.map(\.rawValue).sorted(),
                       ([noError] + device).sorted(),
                       "the codes this DEVICE may submit differ from the frozen set")
        XCTAssertEqual(InboxCentralErrorCode.allCases.map(\.rawValue).sorted(), central.sorted(),
                       "the codes this build attributes to CENTRAL differ from the frozen set")

        XCTAssertEqual(InboxDeviceErrorCode.none.rawValue, noError)
        XCTAssertTrue(InboxTaskErrorCode(rawValue: noError)?.isNone == true)

        // The read model legitimately spans both authors; the report path does
        // not. Splitting them is what keeps "what may I say" and "what may I be
        // told" from collapsing into one permissive set.
        for code in device + central {
            XCTAssertNotNil(InboxTaskErrorCode(rawValue: code),
                            "this build cannot read the frozen error code \(code) off a task")
        }
        for code in central {
            XCTAssertNil(InboxDeviceErrorCode(rawValue: code),
                         "this build could SUBMIT \(code), which the contract reserves to central")
        }
        for code in ["none", "unknown", "lease-expired", "Internal", " "] {
            XCTAssertNil(InboxTaskErrorCode(rawValue: code),
                         "this build accepts the off-contract error code \(code)")
        }
    }

    // MARK: - helpers

    private struct CapabilityEntry {
        let token: String
        let definedBy: [String]
    }

    private func capabilityEntries(_ contract: [String: Any]) throws -> [CapabilityEntry] {
        let raw = try XCTUnwrap(contract["capabilityTokens"] as? [[String: Any]],
                                "\(Self.path): capabilityTokens is missing or malformed")
        return try raw.map { entry in
            XCTAssertEqual(entry.keys.sorted(), ["definedBy", "token"],
                           "a capabilityTokens entry has keys \(entry.keys.sorted())")
            return CapabilityEntry(
                token: try XCTUnwrap(entry["token"] as? String),
                definedBy: try XCTUnwrap(entry["definedBy"] as? [String]))
        }
    }

    /// The contract's capability syntax, compiled, as a predicate.
    private func syntaxMatcher(_ contract: [String: Any]) throws -> (String) -> Bool {
        let syntax = try XCTUnwrap(contract["capabilityTokenSyntax"] as? [String: Any])
        let pattern = try XCTUnwrap(syntax["pattern"] as? String)
        let maxLength = try XCTUnwrap(syntax["maxLength"] as? Int)
        let regex = try NSRegularExpression(pattern: pattern)
        return { token in
            guard token.count <= maxLength else { return false }
            let range = NSRange(token.startIndex..<token.endIndex, in: token)
            return regex.firstMatch(in: token, range: range) != nil
        }
    }

    /// Every `inbox.…` capability literal a non-comment line of `source` assigns.
    ///
    /// Whole-line comments are dropped first: `InboxProtocol.swift` explains
    /// each token in prose directly above it, and a raw scan would answer the
    /// prose. The prose uses backticks rather than quotes, but the filter is
    /// what makes that a property of this test rather than a coincidence.
    private func capabilityLiterals(in source: String) -> [String] {
        let code = source
            .components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
        guard let regex = try? NSRegularExpression(pattern: "\"(inbox\\.[a-z0-9.]*v[0-9]+)\"") else {
            return []
        }
        let range = NSRange(code.startIndex..<code.endIndex, in: code)
        return regex.matches(in: code, range: range).compactMap { match in
            Range(match.range(at: 1), in: code).map { String(code[$0]) }
        }
    }

    /// A list of states must appear in `taskStates` order — deterministic, and
    /// a duplicate or unknown member check at the same time.
    private func assertStateSubsequence(_ values: [String], of order: [String], name: String) {
        var last = -1
        for value in values {
            guard let at = order.firstIndex(of: value) else {
                return XCTFail("\(name) names \(value), which is not a declared task state")
            }
            XCTAssertGreaterThan(at, last, "\(name) lists \(value) out of taskStates order, or twice")
            last = at
        }
    }
}
