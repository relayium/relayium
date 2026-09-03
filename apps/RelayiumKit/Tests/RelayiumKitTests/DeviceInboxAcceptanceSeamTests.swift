import CryptoKit
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit
@testable import RelayiumShareKit

/// **The offline gate on the two-device Device Inbox acceptance harness.**
///
/// `scripts/ios-device-inbox-acceptance.sh` starts one role of
/// `apps/ios/RelayiumUITests/DeviceInboxAcceptanceUITests.swift` on each of two
/// physical devices and reads their bounded `RELAYIUM-DEVICE-INBOX` lines back
/// through `scripts/lib/device_pair_channel.py`. Almost nothing that harness
/// claims can be checked without the hardware — but the seams it depends on
/// can, and each guard here is a defect class that has already cost a physical
/// run in this repository's history: a launch argument that would have changed
/// the very configuration under proof, a digest anchored to bytes nothing
/// stages, a start ordering asserted in prose while two `xcodebuild` sessions
/// contended for Automation Mode, and a green run built on a suite that seeds
/// history offline instead of moving bytes.
///
/// The launcher's own `--self-test` is EXECUTED here, so its resolution,
/// barrier, scan and choreography cases sit behind the same `swift test` gate
/// as everything else; the source pins below cover only what a self-test
/// cannot see about itself — call-site wiring, cross-file agreement, and
/// orderings.
final class DeviceInboxAcceptanceSeamTests: XCTestCase {

    // MARK: - the launcher's own offline gates, RUN

    /// `--self-test` is executed here, not described. It proves the device
    /// resolution, the inbox-marker grammar (including the pair/inbox marker
    /// separation), the start barrier's discrimination, the exact environment
    /// list, the single test selector, the pinned digest and the
    /// non-interactivity scans — none of which needs a device.
    func testTheLauncherPassesEveryOneOfItsOwnNonDeviceGates() throws {
        let script = try RepoRoot.url("scripts/ios-device-inbox-acceptance.sh")
        let process = Process()
        // `/bin/bash` deliberately, which on macOS is 3.2: the harness is
        // started with `#!/bin/bash`, and a bash-4-only expansion in it is a
        // RUNTIME failure that `bash -n` does not catch.
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [script.path, "--self-test"]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        process.standardInput = FileHandle.nullDevice
        try process.run()
        let produced = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let text = String(decoding: produced, as: UTF8.self)
        XCTAssertEqual(process.terminationStatus, 0, """
            the Device Inbox launcher does not pass its own no-device self-test:
            \(text)
            """)
        XCTAssertTrue(text.contains("non-device cases OK"),
                      "the self-test reported success without saying what it checked:\n\(text)")
    }

    // MARK: - the launch, which decides what the run is even about

    /// **The launch is the shipped one.** `--relayium-ui-testing` would flip
    /// `UITestMode.isActive` and take the run off the production account path;
    /// `--relayium-transfer-origin` admits loopback only, and loopback on an
    /// iPhone is that iPhone; the fresh-received-folder argument would delete
    /// received files this harness is forbidden to touch. The one Debug-only
    /// argument the SENDER adds stages the brief and does nothing else — and it
    /// must be exactly the argument the product's Debug arm parses, absent from
    /// Release along with its parser.
    func testThePhysicalLaunchIsTheShippedOneWithOnlyTheSendersStagingArgument() throws {
        let suiteCode = try Self.codeOnly(Self.suiteSource())
        XCTAssertFalse(suiteCode.contains("\"--relayium-ui-testing\""), """
            the acceptance suite passes --relayium-ui-testing, so the run would prove a \
            test configuration rather than the installed product.
            """)
        XCTAssertFalse(suiteCode.contains("\"--relayium-transfer-origin\""),
                       "the acceptance suite passes an origin seam a physical run must not use")
        XCTAssertFalse(suiteCode.contains("fresh-received-folder"), """
            the acceptance suite empties the receiving folder. Deleting the previous \
            brief is an operator step, exactly like Automation Mode — never something \
            this harness does to keep itself green.
            """)
        let launcher = try Self.codeOnly(Self.launcherSource(), comment: "#")
        for banned in ["relayium-ui-testing", "transfer-origin", "fresh-received-folder"] {
            XCTAssertFalse(launcher.contains(banned),
                           "the launcher names \(banned) outside a comment")
        }

        // The staging argument, end to end: the suite passes it, the Debug arm
        // parses it, and the Release arm contains neither it nor a parser.
        let argument = "--relayium-ui-testing-pending-fixture"
        XCTAssertTrue(suiteCode.contains("\"\(argument)\""),
                      "the sender no longer stages the brief; its Files-picker step is empty")
        let mode = try RepoRoot.text("apps/ios/Relayium/UITestMode.swift")
        let arms = mode.components(separatedBy: "\n    #else\n")
        XCTAssertEqual(arms.count, 2, """
            UITestMode no longer has exactly one #if DEBUG / #else split, so this guard \
            cannot tell the Debug arm from the shipped one.
            """)
        XCTAssertTrue(arms[0].contains(argument),
                      "UITestMode's Debug arm no longer declares \(argument), so it is inert")
        XCTAssertFalse(arms[1].contains(argument),
                       "\(argument) appears in UITestMode's RELEASE arm")
    }

    // MARK: - the fixture, and the digest every physical comparison anchors to

    /// The digest the launcher requires is the digest of the bytes the product
    /// stages, read back from where the product writes them, under the name the
    /// product gives them. A constant in the launcher — never a value read off
    /// the sending device — is what makes the comparison a comparison and not
    /// an echo; this is what keeps that constant honest.
    func testTheFixtureAnchorsAgreeAcrossProductSuiteAndLauncher() throws {
        let mode = try RepoRoot.text("apps/ios/Relayium/UITestMode.swift")
        XCTAssertTrue(mode.contains("pendingFixtureByteCount = 1_536"),
                      "UITestMode no longer stages 1,536 bytes")
        XCTAssertTrue(mode.contains("Data(repeating: 0x52, count: pendingFixtureByteCount)"),
                      "UITestMode no longer fills the fixture with 0x52")
        XCTAssertTrue(mode.contains("pendingFixtureName = \"Relayium product brief.txt\""),
                      "UITestMode no longer stages the name both ends assert")

        let digest = SHA256.hash(data: Data(repeating: 0x52, count: 1_536))
            .map { String(format: "%02x", $0) }.joined()
        let launcher = try Self.launcherSource()
        XCTAssertTrue(launcher.contains("fixture_sha256=\"\(digest)\""), """
            the launcher's pinned digest is not the digest of 1,536 bytes of 0x52. \
            Expected \(digest).
            """)
        XCTAssertTrue(launcher.contains("fixture_name=\"Relayium product brief.txt\""),
                      "the launcher no longer names the staged fixture")
        XCTAssertEqual(ReceiveDestination.folderName, "Received",
                       "the product's receive folder moved out from under the launcher")
        XCTAssertTrue(
            launcher.contains(
                "fixture_container_path=\"Documents/\(ReceiveDestination.folderName)/$fixture_name\""),
            "the launcher no longer reads the brief out of the product's own receive folder")
        XCTAssertTrue(launcher.contains("bundle_id=\"com.relayium.mac\""),
                      "the launcher reads a container that is not the product's")

        let suite = try Self.suiteSource()
        XCTAssertTrue(suite.contains("name = \"Relayium product brief.txt\""),
                      "the suite asserts a file name the product does not stage")
        XCTAssertTrue(suite.contains("bundleID = \"com.relayium.mac\""),
                      "the suite names a bundle that is not the product's")
    }

    // MARK: - one vocabulary across the suite, the parser and the launcher

    /// The marker, the event set and the event VALUES are defined on both ends
    /// and pinned against each other, because the pair harness publishes
    /// through the same grammar and both vocabularies contain READY — and
    /// because the same event name carries a different value in each (the pair
    /// READY carries the run tag, the inbox READY the literal "1").
    func testTheChoreographyIsOneVocabularyAcrossSuiteParserAndLauncher() throws {
        let suite = try Self.suiteSource()
        let channel = try RepoRoot.text("scripts/lib/device_pair_channel.py")
        let launcher = try Self.launcherSource()

        XCTAssertTrue(suite.contains("marker = \"RELAYIUM-DEVICE-INBOX\""),
                      "the suite and the parser no longer share one marker")
        XCTAssertTrue(channel.contains("INBOX_MARKER = \"RELAYIUM-DEVICE-INBOX\""),
                      "the parser no longer defines the inbox marker")
        XCTAssertTrue(launcher.contains("marker=\"RELAYIUM-DEVICE-INBOX\""),
                      "the launcher no longer reads under the inbox marker")

        // Every event the launcher requires exists in the suite's own enum, so
        // a renamed case fails here rather than as a physical-run timeout.
        for (name, value) in [("ready", "READY"), ("receiving", "RECEIVING"),
                              ("peer", "PEER"), ("target", "TARGET"),
                              ("message", "MESSAGE"), ("name", "NAME"),
                              ("file", "FILE"), ("holding", "HOLDING"),
                              ("done", "DONE")] {
            XCTAssertTrue(suite.contains("case \(name) = \"\(value)\""),
                          "the suite no longer publishes \(value)")
        }
        XCTAssertTrue(
            launcher.contains("sender_events=\"READY TARGET MESSAGE NAME FILE DONE\""),
            "the launcher no longer requires the sender's full choreography")
        XCTAssertTrue(
            launcher.contains(
                "receiver_events=\"READY PEER RECEIVING MESSAGE NAME FILE HOLDING DONE\""),
            "the launcher no longer requires the receiver's full choreography")

        // The parser's inbox refinements are the suite's exact published
        // values, in the inbox marker's OWN table.
        XCTAssertTrue(channel.contains("\"RECEIVING\": re.compile(r\"\\Aauto\\Z\")"),
                      "the parser no longer holds RECEIVING to the suite's one value")
        XCTAssertTrue(channel.contains("\"FILE\": re.compile(r\"\\A(committed|saved)\\Z\")"),
                      "the parser no longer holds FILE to the two terminal states")
    }

    /// Every rendered English string the suite asserts is the shipped copy, so
    /// a copy change fails here visibly rather than burning a physical run on a
    /// control nobody draws.
    func testTheSuitesRenderedCopyIsTheShippedEnglish() throws {
        let suite = try Self.suiteSource()
        for (key, constant) in [(L10nKey.inboxPolicyAuto, "policyAutomatic"),
                                (.inboxStatusReadyAuto, "readyAutomatic"),
                                (.inboxSentStateSaved, "savedOnTarget")] {
            let english = L10n.t(key, language: .en)
            XCTAssertTrue(suite.contains("\(constant) = \"\(english)\""), """
                the suite's \(constant) is not the shipped English copy for \
                \(key.rawValue), which is now "\(english)".
                """)
        }
        // The two direction prefixes, up to their peer-name placeholder.
        let received = L10n.t(.inboxTimelineReceivedFrom, language: .en)
            .components(separatedBy: "%@")[0]
        let sent = L10n.t(.inboxTimelineSentTo, language: .en)
            .components(separatedBy: "%@")[0]
        XCTAssertTrue(suite.contains("receivedPrefix = \"\(received)\""),
                      "the suite's received-direction prefix is not \"\(received)\"")
        XCTAssertTrue(suite.contains("sentPrefix = \"\(sent)\""),
                      "the suite's sent-direction prefix is not \"\(sent)\"")
    }

    // MARK: - the start barrier and the digest window, pinned by position

    /// **The receiver is started alone, and the sender only after the
    /// receiver's own RECEIVING line.** Two `xcodebuild` sessions started in
    /// the same breath contend for Automation Mode; the gate is the receiver's
    /// published fact, not a sleep, and it watches the receiver's process. The
    /// self-test proves the barrier DISCRIMINATES; this pins the call site.
    func testTheReceiverIsStartedFirstAndGatedOnItsOwnReceivingLine() throws {
        let body = try Self.deliveryBody()
        guard let startReceiver = body.range(of: "start_role \"$receiver_udid\" receiver"),
              let gate = body.range(of:
                "await_inbox_event \"$receiver_log\" receiver RECEIVING \"$receiver_pid\""),
              let startSender = body.range(of: "start_role \"$sender_udid\" sender")
        else {
            return XCTFail("""
                run_delivery no longer starts the receiver, gates on RECEIVING and then \
                starts the sender; this guard cannot see the ordering it exists for.
                """)
        }
        XCTAssertTrue(startReceiver.lowerBound < gate.lowerBound,
                      "the RECEIVING gate sits before the receiver it waits on is started")
        XCTAssertTrue(gate.lowerBound < startSender.lowerBound, """
            the sender is started before the receiver has published RECEIVING, so the two \
            runners contend for Automation Mode and the receiving app may not be \
            foreground when the delivery lands.
            """)
        let between = body[startReceiver.upperBound..<startSender.lowerBound]
        XCTAssertFalse(between.contains("sleep "), """
            there is a sleep between the two start_role calls. A sleep long enough for a \
            cold install is dead time on every other run, and it still cannot tell "still \
            installing" from "never launched".
            """)
        XCTAssertEqual(body.components(separatedBy: "\n  start_role ").count - 1, 2, """
            run_delivery no longer starts exactly two roles. One delivery is one \
            direction; a third start would be a reverse run nobody asked for.
            """)
    }

    /// **The container read happens inside the receiver's foreground hold.**
    /// HOLDING is published after both arrivals committed and before the fixed
    /// window; the digest is taken then, and DONE — the window elapsing on its
    /// own — is awaited only afterwards. A read taken after the runner exits
    /// could not distinguish bytes never written from bytes removed on the way
    /// out, which is exactly the finding the pair harness's history is about.
    func testTheDigestIsTakenInsideTheHoldWindowAndDoneIsRequiredAfterIt() throws {
        let body = try Self.deliveryBody()
        guard let holding = body.range(of:
                "await_inbox_event \"$receiver_log\" receiver HOLDING"),
              let read = body.range(of: "require_received_bytes"),
              let done = body.range(of:
                "await_inbox_event \"$receiver_log\" receiver DONE")
        else {
            return XCTFail("""
                run_delivery no longer gates on HOLDING, reads the bytes and awaits DONE; \
                this guard cannot see the window it exists for.
                """)
        }
        XCTAssertTrue(holding.lowerBound < read.lowerBound, """
            the container read is taken before the receiver has published HOLDING, so it \
            races the delivery instead of reading a held, committed state.
            """)
        XCTAssertTrue(read.lowerBound < done.lowerBound, """
            DONE is awaited before the container read, so the read happens after the \
            receiving app may have finished and exited — the one window in which a \
            missing file cannot be attributed.
            """)
        let launcher = try Self.codeOnly(Self.launcherSource(), comment: "#")
        XCTAssertEqual(launcher.components(separatedBy: "ios_container_file ").count - 1, 1,
                       "the launcher no longer takes exactly one container read")
    }

    // MARK: - what the launcher may never do

    /// The launcher writes NOTHING to any device — no release file, no
    /// container write, nothing. The receiver's hold is fixed and elapses on
    /// its own; the pair harness's release mechanism is deliberately not
    /// inherited. And one run is one direction: nothing here re-runs itself
    /// with the roles exchanged.
    func testTheLauncherWritesNothingToADeviceAndDrivesOneDirectionOnly() throws {
        let launcher = try Self.codeOnly(Self.launcherSource(), comment: "#")
        XCTAssertFalse(launcher.contains("ios_container_put"),
                       "the launcher writes into a device container")
        XCTAssertFalse(launcher.contains("release-name"),
                       "the launcher composes a release file; the inbox hold is fixed")
        XCTAssertFalse(launcher.contains("devicectl device copy to"),
                       "the launcher copies something onto a device")
        XCTAssertFalse(launcher.contains("--directions"), """
            the launcher grew a directions switch. Reversing the roles is a second run an \
            operator starts deliberately, with the receiving device's folder precondition \
            re-established by hand.
            """)
    }

    /// The harness holds no credential and names no device. It deliberately has
    /// nothing to redact: both sessions are established BY HAND, once, in the
    /// product's own keychain, and a UDID is a stable identifier for a piece of
    /// somebody's hardware that a retained log has no use for.
    func testTheHarnessCarriesNoCredentialAndNamesNoDevice() throws {
        for (name, source) in [("the launcher", try Self.launcherSource()),
                               ("the acceptance suite", try Self.suiteSource())] {
            for banned in ["PASSWORD", "BEARER", "_TOKEN", "SECRET", "API_KEY"] {
                XCTAssertFalse(source.contains(banned),
                               "\(name) names \(banned); this harness signs nothing in")
            }
            XCTAssertNil(source.range(of: "\\b[0-9a-fA-F]{40}\\b", options: .regularExpression),
                         "\(name) contains what looks like a 40-character device UDID")
        }
    }

    // MARK: - what the launcher starts, and what exists to be started

    /// Both role tests the launcher names exist in the physical acceptance
    /// suite — `-only-testing:` a missing name installs the app, runs nothing
    /// and exits zero — and the offline inbox suite is never cited: it seeds
    /// history through stores and proves no delivery, and a launcher that
    /// started it would report a green run about bytes nothing moved.
    func testTheRolesExistInTheAcceptanceSuiteAndTheOfflineSuiteIsNeverCited() throws {
        let launcher = try Self.launcherSource()
        let suite = try Self.suiteSource()
        var named: [String] = []
        for line in launcher.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            for prefix in ["receiver_test=\"", "sender_test=\""]
            where trimmed.hasPrefix(prefix) {
                named.append(String(trimmed.dropFirst(prefix.count).dropLast()))
            }
        }
        XCTAssertEqual(named.count, 2,
                       "the launcher no longer names exactly two role tests (\(named))")
        for name in named {
            XCTAssertTrue(suite.contains("func \(name)("), """
                the launcher runs -only-testing: on "\(name)", which the acceptance suite \
                does not declare. xcodebuild would install the app, run nothing and exit \
                zero — a run that passed having driven no device.
                """)
        }
        XCTAssertFalse(launcher.contains("DeviceInboxShellUITests"), """
            the launcher cites the offline inbox shell suite, whose runs seed history \
            through stores and move no bytes; a green result from it is not delivery \
            evidence.
            """)
        // And the two roles are the two the suite refuses to be launched as
        // anything else.
        for role in ["sender", "receiver"] {
            XCTAssertTrue(suite.contains("requireRun(role: Role.\(role))"),
                          "the suite no longer guards its \(role) role")
        }
    }

    // MARK: - the environment contract and the peer identification

    /// What the launcher exports is what the suite reads, name for name. The
    /// exact-list half lives in `--self-test`; this is the cross-file half a
    /// launcher-only scan cannot make.
    func testTheEnvironmentContractMatchesTheSuitesOwnReader() throws {
        let launcher = try Self.launcherSource()
        let suite = try Self.suiteSource()
        XCTAssertTrue(suite.contains("environment[\"RELAYIUM_DEVICE_INBOX_\\(name)\"]"),
                      "the suite no longer reads the RELAYIUM_DEVICE_INBOX_ environment")
        for short in ["TAG", "ROLE", "MESSAGE", "PEER_ID",
                      "PEER_BUDGET_SECONDS", "DELIVERY_BUDGET_SECONDS"] {
            XCTAssertTrue(launcher.contains("TEST_RUNNER_RELAYIUM_DEVICE_INBOX_\(short)="),
                          "the launcher no longer exports \(short)")
        }
        for read in ["value(\"TAG\")", "value(\"ROLE\")", "value(\"MESSAGE\")",
                     "value(\"PEER_ID\")", "\"PEER_BUDGET_SECONDS\"",
                     "\"DELIVERY_BUDGET_SECONDS\""] {
            XCTAssertTrue(suite.contains(read),
                          "the suite no longer reads \(read), so that export is inert")
        }
    }

    /// The peer is matched as the COMPLETE identifier at both ends — ids may
    /// contain dots, so `bar.foo` must never satisfy a run that named `foo` —
    /// a missing id refuses a multi-row list rather than guessing, and the
    /// launcher checks each runner's published id against the one it was
    /// given, so swapped ids fail with that diagnosis.
    func testThePeerIdentificationIsExactRefusingAndCheckedAgainstTheGivenIds() throws {
        let suite = try Self.suiteSource()
        XCTAssertTrue(suite.contains("A11y.rowPrefix + wanted"),
                      "the suite no longer composes the complete row identifier")
        XCTAssertTrue(suite.contains("$0.identifier == exact"), """
            the suite no longer matches the COMPLETE identifier. Ids may contain dots, so \
            a suffix match sends a real delivery to a device nobody named.
            """)
        XCTAssertTrue(suite.contains("candidates.count == 1"),
                      "the single-row rule is gone; an unnamed peer must mean exactly one row")
        XCTAssertTrue(suite.contains("candidates.count > 1"),
                      "the multi-row refusal is gone; two rows must refuse, not guess")

        let launcher = try Self.codeOnly(Self.launcherSource(), comment: "#")
        XCTAssertTrue(launcher.contains("[ \"$published_target\" = \"$sender_peer_id\" ]"), """
            the launcher accepts --sender-peer-id and never compares it with the row the \
            sender actually selected — a documented remedy that does nothing, which is the \
            exact defect the old harness's history records.
            """)
        XCTAssertTrue(launcher.contains("[ \"$published_peer\" = \"$receiver_peer_id\" ]"),
                      "the launcher never compares the receiver's opened conversation")
        XCTAssertTrue(launcher.contains("[ \"$published_target\" != \"$published_peer\" ]"), """
            the launcher no longer refuses a run whose two ends name one directory id — \
            one device cannot be both ends of a delivery.
            """)
    }

    // MARK: - an incomplete run cannot print PASS

    /// `local-acceptance.sh`'s EXIT trap refuses a zero status that did not
    /// reach the last line; this pins the launcher's half of that contract.
    func testAnIncompleteRunCannotPrintPass() throws {
        let launcher = try Self.codeOnly(Self.launcherSource(), comment: "#")
        XCTAssertEqual(launcher.components(separatedBy: "completed=1").count - 1, 1, """
            the launcher sets its completion flag more than once, so a run that stopped \
            early could still be reported as complete.
            """)
        let lines = launcher.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        XCTAssertEqual(lines.suffix(2), ["completed=1", "say \"PASS\""], """
            PASS is not the last thing this script does after marking the run complete, \
            so a step added after it could fail on a run that already claimed to have \
            passed.
            """)
    }

    // MARK: - the sources these guards are about

    private static func launcherSource() throws -> String {
        try RepoRoot.text("scripts/ios-device-inbox-acceptance.sh")
    }

    private static func suiteSource() throws -> String {
        try RepoRoot.text("apps/ios/RelayiumUITests/DeviceInboxAcceptanceUITests.swift")
    }

    /// `run_delivery`'s own body, so an ordering guard is about the one
    /// delivery rather than about function definitions elsewhere in the file.
    private static func deliveryBody() throws -> String {
        let launcher = try codeOnly(launcherSource(), comment: "#")
        let parts = launcher.components(separatedBy: "\nrun_delivery() {")
        guard parts.count == 2, let end = parts[1].range(of: "\n}\n") else {
            throw DevicePairSeamError(description: """
                the launcher no longer declares exactly one run_delivery function, so the \
                ordering guards have nothing to read.
                """)
        }
        return String(parts[1][..<end.lowerBound])
    }

    /// A source with its whole-line comments dropped: every file in this
    /// harness explains at length what it deliberately does NOT do, and raw
    /// text would fail on the sentence promising the absence being checked.
    private static func codeOnly(_ raw: String, comment: String = "//") -> String {
        raw
            .components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix(comment) }
            .joined(separator: "\n")
    }
}
