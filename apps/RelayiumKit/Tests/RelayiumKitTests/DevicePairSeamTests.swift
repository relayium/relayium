import CryptoKit
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit
@testable import RelayiumShareKit

/// **The offline gate on a harness whose subject is two pieces of hardware.**
///
/// `scripts/ios-device-pair-acceptance.sh` and the three files in
/// `apps/ios/RelayiumUITests` drive two physical iOS devices. Almost nothing they
/// claim can be checked without those devices — but the parts that are NOT about
/// the hardware can be, and every one of them has cost a physical run at least
/// once in this repository's history:
///
///  * an identifier validated against one Apple tool and then spent on another;
///  * an ordering asserted in a comment rather than in code, so two `xcodebuild`
///    sessions contended for Automation Mode and the log blamed the wrong device;
///  * a launch argument that would have taken the device OUT of the room the run
///    existed to prove it was in;
///  * a selector naming a control the product does not draw.
///
/// So this file proves, with nothing plugged in: the roster rule by EXECUTING it,
/// the launcher's own gates by RUNNING them, and the seams the harness depends on
/// by reading both sides and comparing them. A source pin is used only where the
/// claim is genuinely about the text — "this file does not pass that argument" —
/// and never where it would be a weaker restatement of a rule that could be run.
/// A guard that cannot even find what it is about. Distinct from a failing
/// assertion: it means the harness moved, not that the harness is wrong.
struct DevicePairSeamError: Error, CustomStringConvertible {
    let description: String
}

final class DevicePairSeamTests: XCTestCase {

    // MARK: - the roster rule, executed rather than read

    /// **Every ambiguous room, in both naming modes, decided by the real rule.**
    ///
    /// ## Why this compiles a file instead of reading one
    ///
    /// The UI-test target is not a module this package can import, so most of
    /// this file is a source pin. A source pin is the right tool for "the
    /// harness still names the shipped identifier". It is the WRONG tool here,
    /// and the difference is not stylistic: reading `candidates > 1` in a file
    /// cannot distinguish a rule that requires exactly one candidate from one
    /// that requires at least one, and those two differ by precisely the defect
    /// the rule exists to prevent — a harness that taps a row while a third
    /// device is in the room and reports green.
    ///
    /// `DevicePairRosterChoice` is therefore written as a pure value with no
    /// XCTest, no XCUITest and no product dependency, so it can be compiled on
    /// its own and driven. That is what this does: one `swiftc` invocation over
    /// the harness file plus a generated driver, in a temporary directory, with
    /// no device, no simulator and no network.
    ///
    /// ## The matrix, and what each row is about
    ///
    /// Both naming modes against zero, one, two and three candidates, plus the
    /// two single-candidate refusals. The mixed-scope rows are the ones that
    /// would not occur to a reader of the rule: `(contained: 1, named: 2)` is a
    /// room the container scope under-reports, which a container-only count
    /// reads as a one-device room. Taking the maximum is what makes that a
    /// refusal, and this is where that is checked.
    func testTheRosterChoiceRefusesEveryAmbiguousRoomInBothNamingModes() throws {
        // naming | container scope | name scope | expected peer | outcome.
        // "!" marks a row the roster has disabled. The specs are the readable
        // form of a room, so a case that is wrong is wrong visibly rather than
        // inside an array of structs.
        let cases: [(String, String)] = [
            // ── shared: both devices announce one family name ───────────────
            //
            // The name is never treated as evidence of WHICH device, only
            // counted as a device.
            ("shared | | | iPad", "empty"),
            ("shared | iPad | iPad | iPad", "takeContained"),
            ("shared | | iPad | iPad", "takeNamed"),
            // A THIRD device, with every name in the room colliding. Refused by
            // the count, which is the whole reason the rule counts rather than
            // compares.
            ("shared | iPad,iPad | iPad,iPad | iPad", "ambiguous(contained: 2, named: 2)"),
            ("shared | iPad,iPad,iPad | | iPad", "ambiguous(contained: 3, named: 0)"),
            // Partial exposure, both ways round. The room has two devices and
            // the rule must say so rather than tapping the one it can see.
            ("shared | iPad | iPad,iPad | iPad", "ambiguous(contained: 1, named: 2)"),
            ("shared | iPad,iPad | iPad | iPad", "ambiguous(contained: 2, named: 1)"),
            // One candidate, not selectable. Tapping it would satisfy the step
            // and select nothing.
            ("shared | iPad! | | iPad", "notSelectable(label: \"iPad\")"),
            // `shared` does NOT consult the name, and this is the row that says
            // so: a row announcing something else entirely is still taken,
            // because in this mode the name distinguishes nothing and a check
            // that reads as identification while identifying nothing is worse
            // than no check. The proof that the two ends are the same two ends
            // is the equal verification code, not this.
            ("shared | Studio Mac | | iPad", "takeContained"),

            // ── distinct: the two devices announce different names ──────────
            ("distinct | iPad | iPad | iPad", "takeContained"),
            ("distinct | | iPad | iPad", "takeNamed"),
            ("distinct | | | iPad", "empty"),
            // The one thing the two modes disagree about.
            ("distinct | iPhone | | iPad", "notTheIntendedPeer(label: \"iPhone\")"),
            ("distinct | iPad! | | iPad", "notSelectable(label: \"iPad\")"),
            ("distinct | iPad,iPad | | iPad", "ambiguous(contained: 2, named: 0)"),
            // A stranger of the OTHER family. A rule that required uniqueness
            // only among rows already matching the name would never count it.
            ("distinct | iPad,iPhone | iPad | iPad", "ambiguous(contained: 2, named: 1)"),
            // An EMPTY expected name identifies nobody, so it refuses.
            //
            // This row pins the OUTCOME and deliberately does not claim to pin
            // the `!peerName.isEmpty` clause that produces it: with Foundation
            // imported, `"iPad".contains("")` is already false, so removing that
            // clause is a mutation this matrix cannot kill and it was observed
            // not to. The clause stays because the rule must not depend on which
            // `contains` overload a future edit resolves to — but the honest
            // statement of what is proved here is the refusal, not the guard.
            ("distinct | iPad | iPad | ", "notTheIntendedPeer(label: \"iPad\")"),
        ]

        var driver = """
        import Foundation

        func candidates(_ spec: String) -> [DevicePairRosterCandidate] {
            spec.split(separator: ",").map { entry in
                let raw = entry.trimmingCharacters(in: .whitespaces)
                let enabled = !raw.hasSuffix("!")
                return DevicePairRosterCandidate(
                    label: enabled ? raw : String(raw.dropLast()), isEnabled: enabled)
            }
        }


        """
        for (input, _) in cases {
            // Split on the bare bar and trim, never on " | ": an EMPTY field
            // between two bars leaves no room for the spaced separator to match
            // twice, so `"shared |  |  | iPad"` would silently parse as three
            // fields and the zero-candidate rows would drive the wrong rule.
            let parts = input.components(separatedBy: "|")
                .map { $0.trimmingCharacters(in: .whitespaces) }
            guard parts.count == 4 else {
                return XCTFail("malformed case spec: \(input)")
            }
            driver += """
            print(DevicePairRosterChoice.decide(naming: .\(parts[0]),
                contained: candidates("\(parts[1])"),
                named: candidates("\(parts[2])"),
                peerName: "\(parts[3])"))

            """
        }

        let produced = try runSwift(driver: driver,
                                    alongside: "DevicePairRosterChoice.swift")
        XCTAssertEqual(produced, cases.map(\.1), """
            the roster selection rule does not decide what this harness claims it decides. \
            Each line is one room: the naming mode, the two scopes' candidate labels \
            ("!" marks a disabled row), the expected peer name, and the outcome the rule \
            must reach. This is the one part of two-device roster selection that can be \
            proved without two devices, so a mismatch here is a defect that would otherwise \
            be found by a physical run tapping the wrong row.
            """)
    }

    // MARK: - the launch, which decides whether either device is in the room

    /// **The two arguments the physical harness must never pass.**
    ///
    /// `--relayium-ui-testing` makes `UITestMode.isActive` true, and
    /// `allowsResidency` is `isActive && isLoopbackTransferOrigin`. On the
    /// production origin a physical run resolves, that composition is FALSE, so
    /// `RelayiumApp` takes its `residency.pause()` arm and the device never joins
    /// the room. A harness that passed it would spend two devices proving that
    /// nothing arrives — and every assertion about an empty roster would pass.
    ///
    /// `--relayium-transfer-origin` admits loopback only, and `127.0.0.1` on an
    /// iPhone is that iPhone.
    func testThePhysicalLaunchPassesNoOriginAndNoUITestingArgument() throws {
        for name in Self.harnessFiles {
            let source = try Self.codeOnly(Self.uiTestSource(name))
            XCTAssertFalse(source.contains("\"--relayium-transfer-origin\""), """
                \(name) passes --relayium-transfer-origin. That seam admits loopback \
                origins only, and a loopback origin on a phone is that phone.
                """)
            XCTAssertFalse(source.contains("\"--relayium-ui-testing\""), """
                \(name) passes --relayium-ui-testing. On a production origin that makes \
                UITestMode.allowsResidency false, so RelayiumApp pauses residency and the \
                device is never in the room this run exists to prove it is in.
                """)
        }
        let launcher = try Self.codeOnly(Self.launcherSource(), comment: "#")
        XCTAssertFalse(launcher.contains("--relayium-transfer-origin"),
                       "the launcher passes an origin seam a physical run must not use")
        XCTAssertFalse(launcher.contains("\"--relayium-ui-testing\""),
                       "the launcher passes --relayium-ui-testing")
    }

    /// **Every Debug-only argument the harness passes is absent from Release.**
    ///
    /// Each of them is a real capability — writing a fixture into the container,
    /// injecting a selection nobody made, deleting a folder of received files —
    /// and the whole reason a physical acceptance may use them is that a shipped
    /// binary contains neither the argument nor its parser.
    func testEveryDebugOnlyArgumentTheHarnessPassesIsAbsentFromRelease() throws {
        let mode = try RepoRoot.text("apps/ios/Relayium/UITestMode.swift")
        let arms = mode.components(separatedBy: "\n    #else\n")
        XCTAssertEqual(arms.count, 2, """
            UITestMode no longer has exactly one #if DEBUG / #else split, so this guard \
            cannot tell the Debug arm from the shipped one.
            """)
        let debug = arms[0], release = arms[1]
        for argument in Self.debugOnlyArguments {
            XCTAssertTrue(debug.contains(argument), """
                the harness passes \(argument) and UITestMode's Debug arm no longer \
                declares it, so the argument is inert and the run would drive a screen \
                it did not set up.
                """)
            XCTAssertFalse(release.contains(argument), """
                \(argument) appears in UITestMode's RELEASE arm. A shipped launch must not \
                be able to stage a file, inject a selection nobody made, or delete a folder \
                of files somebody received.
                """)
        }
        // And the harness really does pass every one of them: a guard over an
        // argument nothing sends would be a tautology.
        let acceptance = try Self.codeOnly(Self.uiTestSource("DevicePairAcceptance.swift"))
        for argument in Self.debugOnlyArguments {
            XCTAssertTrue(acceptance.contains(argument),
                          "the harness no longer passes \(argument); this guard is empty")
        }
    }

    /// The `NSArgumentDomain` pin names the key the product actually reads.
    ///
    /// If it did not, the pin would be inert, the device would resolve the
    /// shipped default — advanced verification OFF — and every SAS assertion in
    /// the harness would become unreachable while the run still passed. The
    /// runners also read the setting back off the shipped toggle, so this is the
    /// second of two independent holds on the same defect.
    func testTheVerificationDefaultsKeyIsTheOneTheProductReads() throws {
        let acceptance = try Self.uiTestSource("DevicePairAcceptance.swift")
        XCTAssertTrue(
            acceptance.contains("verifyPeersDefaultsKey = \"\(VerificationPreference.defaultsKey)\""),
            """
            the harness pins a UserDefaults key the product does not read. \
            VerificationPreference.defaultsKey is "\(VerificationPreference.defaultsKey)".
            """)
        // The toggle's own label, which is how a runner reads the resolved
        // preference back. A copy change here is a harness change, and this is
        // where it is noticed rather than on two devices.
        XCTAssertTrue(acceptance.contains("verifyToggleLabel = \"\(L10n.t(.verifyToggle, language: .en))\""),
                      "the harness no longer names the shipped verification toggle")
    }

    // MARK: - the start barrier

    /// **The two runners of a phase are not started into automation together.**
    ///
    /// Starting a role starts an `xcodebuild` UI-test session, and that session
    /// must enable Automation Mode on its device before it can drive anything.
    /// Two started in the same breath contend for it: one device times out
    /// enabling automation and the other then fails for the only reason left —
    /// the peer never launched — with the log naming the wrong device and no
    /// product claim tested at all.
    ///
    /// The self-test proves `ios_await_event` DISCRIMINATES; it cannot see the
    /// call site being omitted or pointed at the wrong log. This pins the
    /// wiring: between the two `start_role` calls there is a gate, and there is
    /// no sleep.
    func testTheTwoRunnersOfAPhaseAreNotStartedIntoAutomationTogether() throws {
        let launcher = try Self.launcherSource()
        let starts = launcher.components(separatedBy: "\n  start_role ")
        XCTAssertEqual(starts.count, 3, """
            `run_phase` no longer starts exactly two roles, so this guard cannot see the \
            gap this barrier lives in.
            """)
        let between = starts[1]
        XCTAssertTrue(between.contains("ios_await_event"), """
            the second runner is started without waiting for the first to publish that its \
            app is up. Two xcodebuild sessions started together contend for Automation Mode \
            on their devices, and the run then fails on the wrong device for the wrong \
            reason.
            """)
        XCTAssertFalse(between.contains("sleep "), """
            there is a sleep between the two start_role calls. A sleep long enough for a \
            cold install is dead time on every other run, and it still cannot tell "still \
            installing" from "never launched".
            """)
        // The gate is matched on the ROLE as well as the event, and the role it
        // waits for is the one that was started first. Both Nearby roles publish
        // READY, so an event-only or wrong-role match would be opened by the very
        // runner the barrier exists to hold back.
        XCTAssertTrue(between.contains("\"$first_role\" \"$gate_event\" \"$first_pid\""), """
            the barrier does not wait on the FIRST role's own published event, or does not \
            watch that role's process. Either way it is not the gate it is written as.
            """)
    }

    /// The launcher's failure paths never wait out a publisher that has died.
    ///
    /// Status 1 from `ios_await_event` means "it exited and will never publish".
    /// A launcher that treated that as an ordinary timeout would report a
    /// minutes-long stall about a run that failed in its first seconds.
    func testAPublisherThatDiedIsNotWaitedOut() throws {
        let launcher = try Self.codeOnly(Self.launcherSource(), comment: "#")
        XCTAssertTrue(launcher.contains("1) fail \"$first_role exited before it was ready"),
                      "an exited publisher is no longer distinguished from a timeout")
        XCTAssertTrue(launcher.contains("2) fail \"$first_role did not become ready"),
                      "a timeout is no longer distinguished from an exited publisher")
    }

    // MARK: - the launcher's own offline gates, RUN

    /// **`--self-test` is executed here, not described.**
    ///
    /// It proves the device resolution, the channel grammar, the start barrier's
    /// discrimination, the phase plan, the non-interactivity scan and the
    /// bash-3.2 formatting path — none of which needs a device. Running it from
    /// `swift test` is what puts all of that behind the gate every other change
    /// in this repository already passes, rather than behind a command somebody
    /// has to remember.
    func testTheLauncherPassesEveryOneOfItsOwnNonDeviceGates() throws {
        let script = try RepoRoot.url("scripts/ios-device-pair-acceptance.sh")
        let process = Process()
        // `/bin/bash` deliberately, which on macOS is 3.2: the harness is
        // started with `#!/bin/bash`, and a bash-4-only expansion in it is a
        // RUNTIME failure that `bash -n` does not catch.
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [script.path, "--self-test"]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        // The child must not inherit this test runner's stdin.
        process.standardInput = FileHandle.nullDevice
        try process.run()
        let produced = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let text = String(decoding: produced, as: UTF8.self)
        XCTAssertEqual(process.terminationStatus, 0, """
            the two-device launcher does not pass its own no-device self-test:
            \(text)
            """)
        XCTAssertTrue(text.contains("non-device cases OK"),
                      "the self-test reported success without saying what it checked:\n\(text)")
    }

    // MARK: - the fixture, and the bytes the receiver must end up holding

    /// The digest the launcher compares against is the digest of the bytes the
    /// product stages.
    ///
    /// It is a CONSTANT in the launcher rather than something read back off the
    /// sending device, which is what makes the comparison a comparison and not
    /// an echo — and this is what keeps that constant honest. A fixture whose
    /// length or fill byte changed would otherwise leave a harness comparing
    /// every future run against a digest of bytes nothing writes any more.
    func testTheFixtureDigestIsTheDigestOfTheBytesTheProductStages() throws {
        let mode = try RepoRoot.text("apps/ios/Relayium/UITestMode.swift")
        XCTAssertTrue(mode.contains("pendingFixtureByteCount = 1_536"), """
            UITestMode no longer stages 1,536 bytes, so the launcher's digest is of a file \
            the product does not write.
            """)
        XCTAssertTrue(mode.contains("Data(repeating: 0x52, count: pendingFixtureByteCount)"), """
            UITestMode no longer fills the fixture with 0x52, so the launcher's digest is \
            of bytes the product does not write.
            """)
        let digest = Self.hexSHA256(of: Data(repeating: 0x52, count: 1_536))
        let launcher = try Self.launcherSource()
        XCTAssertTrue(launcher.contains("fixture_sha256=\"\(digest)\""), """
            the launcher compares received bytes against a digest that is not the digest of \
            1,536 bytes of 0x52. Expected \(digest).
            """)
    }

    /// The launcher reads the file back from where the product writes it, under
    /// the name the product gives it.
    func testTheReceivedFileIsReadBackFromWhereTheProductWritesIt() throws {
        let mode = try RepoRoot.text("apps/ios/Relayium/UITestMode.swift")
        XCTAssertTrue(mode.contains("pendingFixtureName = \"Relayium product brief.txt\""),
                      "UITestMode no longer stages the name the launcher pulls back")
        XCTAssertEqual(ReceiveDestination.folderName, "Received", """
            the product's receive folder is no longer "Received", so the launcher reads a \
            container path nothing writes to.
            """)
        let launcher = try Self.launcherSource()
        XCTAssertTrue(launcher.contains("fixture_name=\"Relayium product brief.txt\""),
                      "the launcher no longer names the staged fixture")
        XCTAssertTrue(
            launcher.contains("fixture_container_path=\"Documents/\(ReceiveDestination.folderName)/$fixture_name\""),
            """
            the launcher no longer reads the file back out of the product's own receive \
            folder inside the app container.
            """)
        // The receiving side is identified and hashed, and the failure is a
        // refusal rather than a downgrade to the UI's own claim.
        XCTAssertTrue(launcher.contains("require_received_bytes"),
                      "no phase verifies the received bytes at all")
        XCTAssertTrue(launcher.contains("this run will NOT report a pass"), """
            a failed container read no longer refuses; a harness that fell back to the \
            receiving app's own \"Saved\" would be trusting the sender's description of \
            bytes it never inspected.
            """)
    }

    // MARK: - the bytes, read while the receiver is alive AND after it exits

    /// **A receiving role holds its completed state before it presses Done, and
    /// the two roles that receive are the two roles that hold.**
    ///
    /// The ordering is the whole mechanism. `Done` on a completion screen is a
    /// PRODUCT action with its own consequences for what is on that device's
    /// disk, so a container read taken only after it lets one outcome — the file
    /// is gone — stand for "never written", "unreadable once automation ended"
    /// and "removed on the way out". Those are three findings owned by three
    /// different people.
    ///
    /// Pinned by position rather than by presence: a `holdForContainerRead` that
    /// had drifted BELOW the exit control would compile, run, pass, and prove
    /// exactly what the un-held version proved.
    func testAReceivingRoleHoldsItsCompletedStateBeforeItPressesDone() throws {
        let suite = try Self.codeOnly(Self.uiTestSource("DevicePairUITests.swift"))
        XCTAssertEqual(suite.components(separatedBy: "holdForContainerRead(").count - 1, 2, """
            exactly two roles receive a file — the Nearby resident and the pairing joiner — \
            and each must hold its completed state while the launcher reads the bytes off \
            that device.
            """)
        // Each receiving role, with the control that ENDS its session named
        // explicitly: the Nearby resident leaves the link, the pairing joiner
        // presses the legacy lane's Done.
        for (test, exit) in [
            ("testNearbyAcceptsThePhysicalPeerAndTransfersBothWays", "endLinkAndDismiss()"),
            ("testPairingCodeFilesFromThePhysicalPeerAreReceived", "DevicePair.doneLabel"),
        ] {
            let body = try Self.body(of: test, in: suite)
            guard let published = body.range(of: "emitDevicePair(.received"),
                  let held = body.range(of: "holdForContainerRead("),
                  let left = body.range(of: exit)
            else {
                return XCTFail("""
                    \(test) no longer publishes RECEIVED, holds for the container read, and \
                    ends its session — this guard cannot see the ordering it exists for.
                    """)
            }
            XCTAssertTrue(published.lowerBound < held.lowerBound, """
                \(test) holds for the container read BEFORE it publishes RECEIVED. The \
                launcher starts reading on that line, so the hold would be opened by \
                nothing and the read would race the rest of the test.
                """)
            XCTAssertTrue(held.lowerBound < left.lowerBound, """
                \(test) ends its session before it holds for the container read. The read \
                would then be taken after a product action that can change what is on that \
                device's disk, which is the ambiguity the hold exists to remove.
                """)
        }
    }

    /// **The link's exit is re-resolved against the screen on every pass, and
    /// never scrolled toward with an assertion.**
    ///
    /// `NearbyLinkWorkspaceView` draws ONE exit button whose title is
    /// `link.leaveConnection` while the connection is up and `common.done`
    /// once it is `.ended` — and either device ending the link ends it for
    /// both. The resident's `holdForContainerRead` sits between its last
    /// assertion and its exit, and the connector is free to finish inside that
    /// window, so the resident routinely reaches its exit with a workspace that
    /// is already ended and a button that already says Done.
    ///
    /// A helper that waited unconditionally for "End connection" would spend
    /// its whole budget on a control the product will never draw again and then
    /// fail. But resolving the title ONCE and then acting on that reading is
    /// the same defect one step later, and it is the one this guard exists for:
    /// between the reading and the tap sits `scrollUntilHittable`, which is
    /// seconds of gestures ending in `XCTAssertTrue(element.isHittable)`. A
    /// peer that ends the link inside those seconds — which it is entitled to
    /// do — makes the product correctly replace the title, and the assertion
    /// then fails a device that is showing exactly the right screen, reported
    /// as a control that "never became reachable". Both reds are owned by
    /// nothing and cost two people's hardware to reproduce.
    ///
    /// Guarded as source because the race is a race: a green offline run proves
    /// nothing about which title a physical device happened to be showing, or
    /// when it flipped. What is pinned is the SHAPE — one bounded loop over one
    /// deadline; EVERY reading of the replaceable control taken inside it and
    /// none outside it; no verdict passed from within it, so a legitimate title
    /// replacement can never be an error; a failure when the deadline expires
    /// with no exit resolved; and the terminal Done claim left outside the
    /// branch, where both paths must satisfy it exactly once.
    func testTheLinkExitIsResolvedAgainstTheScreenRatherThanAssumedLive() throws {
        let suite = try Self.codeOnly(Self.uiTestSource("DevicePairUITests.swift"))
        let exit = try XCTUnwrap(
            suite.components(separatedBy: "private func endLinkAndDismiss(")
                .dropFirst().first?.components(separatedBy: "\n    }").first,
            "DevicePairUITests no longer has one helper that ends the link and dismisses it")

        // 1. Both titles are queried, and neither is waited on with its own
        //    timer — a private wait on either is a wait the other cannot answer.
        for label in ["DevicePair.endConnectionLabel", "DevicePair.doneLabel"] {
            XCTAssertTrue(exit.contains(label), """
                the exit no longer queries \(label), so it can only recognise one of the \
                two titles the single exit button takes.
                """)
        }
        XCTAssertFalse(exit.contains("leave.waitForExistence"), """
            the exit waits for "End connection" on its own timer again. A link the peer \
            ended during the container-read hold never draws that title, so the wait \
            expires in full and reports a missing control on a device that is showing the \
            correct screen.
            """)

        // 2. The exit is ONE bounded loop, and it is the loop that observes the
        //    screen — both titles, reachability, and the deadline together.
        let split = exit.components(separatedBy: "\n        while ")
        XCTAssertEqual(split.count, 2, """
            the exit no longer drives exactly one loop of its own at the helper's body \
            level. Its whole correctness is that the screen is re-read between every \
            action it takes; zero loops means it acts on a single reading, and two mean \
            there is a second place where a reading can go stale unnoticed.
            """)
        let head = split.first ?? ""
        let afterWhile = (split.last ?? "").components(separatedBy: "\n        }")
        let loop = afterWhile.first ?? ""
        let tail = afterWhile.dropFirst().joined(separator: "\n        }")
        for observation in ["Date() < deadline", "leave.exists", "done.exists",
                            "leave.isHittable", "leave.tap()"] {
            XCTAssertTrue(loop.contains(observation), """
                the exit's loop no longer observes \(observation), so it cannot resolve \
                both of the screen's mutually exclusive exits against the one ceiling and \
                act on whichever it actually found.
                """)
        }

        // 3. THE STALE WINDOW, which is what this guard is for. Every reading
        //    of the control the product is ALLOWED to replace lives inside the
        //    loop that re-resolves it. Nothing outside may read it, scroll
        //    toward it, or press it on the strength of an older reading.
        for stale in ["leave.exists", "leave.isHittable", "leave.tap(",
                      "scrollUntilHittable(leave"] {
            XCTAssertFalse(head.contains(stale) || tail.contains(stale), """
                the exit reaches for "End connection" via `\(stale)` outside the loop that \
                re-resolves it, so it is acting on a reading taken earlier. The peer may \
                end the link at any instant after that reading — the workspace then \
                correctly replaces the title with Done — and this device would be driving \
                a control that no longer exists.
                """)
        }
        XCTAssertFalse(exit.contains("scrollUntilHittable(leave"), """
            the exit scrolls toward "End connection" with the ASSERTING helper, which is \
            the exact stale-element window: that helper spends up to eighteen gestures and \
            then fails with "never became reachable". A peer ending the link mid-scroll is \
            valid product behaviour and must not be able to produce that failure — the \
            replaceable control is chased one gesture at a time, re-reading the title \
            between them, and only the terminal Done is scrolled to with an assertion.
            """)

        // 4. No verdict is passed from inside the loop. While the exit is still
        //    resolving, a missing title is a state and not a failure.
        for verdict in ["XCTAssert", "XCTFail"] {
            XCTAssertTrue(loop.range(of: verdict) == nil, """
                the exit's loop passes a \(verdict) verdict on a screen it has not finished \
                resolving. Inside the loop, "End connection" being absent means the peer \
                ended the link — a legitimate title replacement — and the only thing \
                entitled to fail is the deadline.
                """)
        }

        // 5. That deadline still fails, so a workspace offering no exit at all
        //    is a red rather than a silent fall-through into the Done wait.
        XCTAssertTrue(tail.contains("XCTFail(") && tail.contains("DevicePair.settleBudget"), """
            the exit no longer fails when its budget expires having resolved neither exit. \
            A workspace showing neither title would then fall through to the terminal wait \
            and be diagnosed by whatever that timed out on, instead of by the check that \
            knows no exit was ever offered.
            """)

        // 6. The terminal claim belongs to BOTH paths, at the helper's own body
        //    level, and Done is pressed exactly once.
        for terminal in [
            "\n        XCTAssertTrue(done.waitForExistence(timeout: DevicePair.establishBudget)",
            "\n        scrollUntilHittable(done, in: app, file: file, line: line)",
            "\n        done.tap()",
        ] {
            let unindented = terminal.trimmingCharacters(in: .whitespacesAndNewlines)
            XCTAssertTrue(exit.contains(terminal), """
                "\(unindented)" is no longer at the helper's own body level, so it belongs \
                to one path through the exit rather than to both. Whichever title the \
                workspace was showing, this helper must still require Done, make it \
                genuinely hittable, and press it — that is the claim, and a branch that \
                skips it dismisses nothing.
                """)
        }
        XCTAssertEqual(exit.components(separatedBy: "done.tap()").count - 1, 1, """
            the exit presses Done from more than one place, so the two paths no longer \
            converge on the single terminal action this helper exists to perform.
            """)
    }

    /// **Both reads are taken, and the second is not conditional on the first.**
    ///
    /// The live read says the transfer wrote the right bytes. The post-exit read
    /// says a file the product told somebody they received survives them
    /// dismissing the receipt — a promise to a person, not a property of the
    /// harness. A revision that kept only the live one would turn this harness
    /// into an instrument that cannot see the very failure it was revised for.
    func testTheReceivedBytesAreReadBothWhileTheAppLivesAndAfterItExits() throws {
        let launcher = try Self.codeOnly(Self.launcherSource(), comment: "#")
        guard let live = launcher.range(of:
                "require_received_bytes \"$receiver_udid\" \"$receiver\" live none"),
              // The call site rather than its argument: what this guard is
              // about is the barrier's POSITION between the two reads, and the
              // ceiling it is given is a separate decision.
              let barrier = launcher.range(of: "\n  await_roles "),
              let after = launcher.range(of:
                "require_received_bytes \"$receiver_udid\" \"$receiver\" after-exit")
        else {
            return XCTFail("""
                the launcher no longer takes a live read, a role barrier and a post-exit \
                read; this guard cannot see the ordering that separates a receiver that \
                never wrote from one whose file did not survive being dismissed.
                """)
        }
        XCTAssertTrue(live.lowerBound < barrier.lowerBound, """
            the "live" read is taken after the phase waits for its runners to exit, so it \
            is not a live read at all.
            """)
        XCTAssertTrue(barrier.lowerBound < after.lowerBound, """
            the post-exit read is taken before the runners have exited, so it proves nothing \
            about a file surviving the product's own Done.
            """)
        XCTAssertEqual(launcher.components(separatedBy: "require_received_bytes ").count - 1, 2, """
            a receiving phase no longer takes exactly two container reads. Two is the point: \
            one failed read cannot distinguish the three ways a received file can be absent.
            """)
        // `live_read` records which world a post-exit failure happened in, and
        // it is only ever WRITTEN and PASSED. A fourth mention would most likely
        // be a branch, and the only branch worth writing here is one that skips
        // the second read — which is exactly what must not exist.
        XCTAssertEqual(launcher.components(separatedBy: "live_read").count - 1, 3, """
            the launcher tests its own record of whether the live read happened. The \
            post-exit read must be unconditional: a phase that skipped it because the live \
            read passed would report a pass on a file it never looked for again.
            """)
        XCTAssertTrue(launcher.contains("finding in the product's completion teardown"), """
            the launcher no longer attributes a post-exit failure that follows a passing \
            live read. Without it the two reads produce the same sentence as one, and the \
            second read's whole value is the sentence it can write.
            """)
    }

    /// The release file's name is composed identically on both ends, and the
    /// launcher composes it through the channel rather than inline.
    ///
    /// A disagreement is silent: every receiving role would hold to its full
    /// ceiling while the launcher reported that it had released it. Slower on
    /// every run, and green.
    func testTheReleaseFileNameIsComposedIdenticallyOnBothEnds() throws {
        let channel = try RepoRoot.text("scripts/lib/device_pair_channel.py")
        let acceptance = try Self.uiTestSource("DevicePairAcceptance.swift")
        XCTAssertTrue(channel.contains("RELEASE_PREFIX = \"relayium-device-pair-release\""),
                      "the channel no longer composes the release file this harness writes")
        XCTAssertTrue(acceptance.contains("releaseFilePrefix = \"relayium-device-pair-release\""),
                      "the runner no longer looks for the release file the launcher writes")
        XCTAssertTrue(acceptance.contains("\"\\(releaseFilePrefix)-\\(tag)-\\(role)\""), """
            the runner no longer composes prefix-tag-role. The run tag is in the name so a \
            release left by an EARLIER run cannot open this run's hold.
            """)
        XCTAssertTrue(channel.contains("\"%s-%s-%s\" % (RELEASE_PREFIX, tag, role)"),
                      "the channel no longer composes prefix-tag-role")
        let launcher = try Self.codeOnly(Self.launcherSource(), comment: "#")
        XCTAssertTrue(launcher.contains("release-name --tag \"$run_tag\" --role \"$role\""), """
            the launcher composes the release file name itself instead of asking the channel \
            for it, so the two ends can drift apart without anything saying so.
            """)
        // And the runner requires the tag in the CONTENT too, which is what the
        // launcher writes.
        let held = try Self.codeOnly(acceptance)
        XCTAssertTrue(held.contains("== run.tag"), """
            the runner accepts a release file without checking that it carries THIS run's \
            tag, so a file left in a container that outlives one run could open the hold.
            """)
        XCTAssertTrue(launcher.contains("printf '%s' \"$run_tag\" >\"$body\""),
                      "the launcher no longer writes this run's tag into the release it sends")
    }

    /// The permitted `devicectl` shapes are pinned as a SET, not left to a ban
    /// list.
    ///
    /// A ban list answers "does this erase a device". It cannot answer "does
    /// this do something to a device nobody has thought about", which is the
    /// question a harness that grows a new capability actually faces. The census
    /// runs inside `--self-test`, which this target executes; what is pinned
    /// here is that it is still wired to both files.
    func testThePermittedDeviceCommandShapesAreStillPinned() throws {
        let launcher = try Self.codeOnly(Self.launcherSource(), comment: "#")
        XCTAssertTrue(launcher.contains("ios_devicectl_shapes \"${BASH_SOURCE[0]}\""),
                      "the self-test no longer censuses the launcher's own device commands")
        XCTAssertTrue(launcher.contains("ios_devicectl_shapes \"$repo_root/scripts/lib/ios-physical-device.sh\""),
                      "the self-test no longer censuses the library's device commands")
        // The one WRITE, named. Everything else this harness does to a device is
        // a read, and the write goes to the automation runner's own container —
        // never the app under test's, whose contents are the thing being proved.
        let library = try Self.codeOnly(Self.libSource(), comment: "#")
        XCTAssertEqual(library.components(separatedBy: "devicectl device copy to").count - 1, 1, """
            the library writes to a device somewhere other than the single release path, or \
            no longer writes at all. Either way this guard is describing something else.
            """)
        XCTAssertTrue(launcher.contains("ios_container_put \"$receiver_udid\"")
                        || launcher.contains("ios_container_put \"$udid\" \"$runner_bundle_id\""),
                      "the launcher's only device write no longer targets the runner container")
    }

    // MARK: - the two six-digit values

    /// The channel's bound on both digit events is the product's own length.
    ///
    /// `sas()` formats `%06u` and the pairing code's alphabet and length are the
    /// signalling protocol's. A parser that admitted a shorter or longer value
    /// would let the launcher compare two strings the product never derived —
    /// or hand a malformed one to a second `xcodebuild` process as environment.
    func testTheChannelBoundsBothDigitEventsAtTheProductsOwnLength() throws {
        XCTAssertEqual(sas(Array(repeating: 1, count: 32), Array(repeating: 2, count: 32)).count, 6,
                       "the product's SAS is no longer six digits")
        let channel = try RepoRoot.text("scripts/lib/device_pair_channel.py")
        XCTAssertTrue(channel.contains("\"PAIRING-CODE\": re.compile(r\"\\A[0-9]{6}\\Z\")"),
                      "the channel no longer holds a pairing code to exactly six digits")
        XCTAssertTrue(channel.contains("\"SAS\": re.compile(r\"\\A[0-9]{6}\\Z\")"),
                      "the channel no longer holds a SAS to exactly six digits")
        // And the runner's own emission bound agrees with the parser's.
        let acceptance = try Self.uiTestSource("DevicePairAcceptance.swift")
        XCTAssertTrue(acceptance.contains("static let digitCount = 6"),
                      "the runner no longer expects six digits on screen")
        XCTAssertTrue(acceptance.contains("marker = \"RELAYIUM-DEVICE-PAIR\""),
                      "the runner and the parser no longer share one marker")
        XCTAssertTrue(channel.contains("MARKER = \"RELAYIUM-DEVICE-PAIR\""),
                      "the parser and the runner no longer share one marker")
    }

    // MARK: - the two flows, as THIS platform composes them

    /// **A pairing code on iOS is the legacy lane, not the unified workspace.**
    ///
    /// `LINK_PAIRING_ROOM_SUPPORT` is false off macOS, so
    /// `linkRoomActive(isCodelessRoom: false)` answers false here and the app
    /// composes no pairing-code link at all. The two flows therefore have
    /// DIFFERENT vocabularies, and a harness that drove the workspace's controls
    /// against a code would time out on a screen this platform never draws.
    ///
    /// Pinned because it is a product fact the harness's whole pairing half
    /// depends on, and because it is exactly the kind of fact that changes under
    /// a feature that looks unrelated to a two-device run.
    func testAPairingCodeOnThisPlatformIsTheLegacyLane() {
        XCTAssertTrue(linkRoomActive(isCodelessRoom: true), """
            this build no longer answers link/1 in the code-less room, so the Nearby half \
            of the harness is driving a workspace that will not exist.
            """)
        #if os(macOS)
        XCTAssertTrue(LINK_PAIRING_ROOM_SUPPORT)
        #else
        XCTAssertFalse(LINK_PAIRING_ROOM_SUPPORT)
        #endif
        // The iOS answer, asserted directly rather than through the host
        // platform: `swift test` runs on macOS, so the constant above is the
        // Mac's. This is the sentence the harness depends on.
        let registry = try? RepoRoot.text(
            "apps/RelayiumKit/Sources/RelayiumKit/Realtime/PeerCapabilityRegistry.swift")
        XCTAssertNotNil(registry)
        XCTAssertTrue(registry?.contains("""
            #if os(macOS)
            public let LINK_PAIRING_ROOM_SUPPORT = true
            #else
            public let LINK_PAIRING_ROOM_SUPPORT = false
            #endif
            """) == true, """
            LINK_PAIRING_ROOM_SUPPORT is no longer macOS-only. If iOS now composes a \
            pairing-code link, the harness's pairing roles are driving the legacy lane's \
            controls against a workspace, and every one of their selectors is wrong.
            """)
    }

    /// The pairing roles name the legacy lane's controls and the Nearby roles
    /// name the workspace's, with no crossing.
    ///
    /// The two verification gates in particular are different screens with
    /// different words — "Compare this code" against "Check this matches" — and
    /// a role that reached for the other one's would wait out its budget on a
    /// live, healthy connection.
    func testTheTwoFlowsDoNotShareEachOthersVocabulary() throws {
        let vocabulary = try Self.uiTestSource("DevicePairAcceptance.swift")
        for (key, constant) in [
            (L10nKey.linkVerifyTitle, "verifyTitle"),
            (.linkVerifyMatches, "verifyMatchesLabel"),
            (.linkConnectToDevice, "connectLabel"),
            (.linkAcceptFiles, "acceptFilesLabel"),
            (.linkComposerLabel, "composerLabel"),
            (.sessionCheckMatches, "legacyVerifyTitle"),
            (.sessionTheyMatch, "legacyMatchesLabel"),
            (.directCreateCode, "createCodeLabel"),
            (.directGiveCode, "giveCodeHeading"),
            (.textCreateCode, "textCreateCodeLabel"),
            (.textGiveCode, "textGiveCodeHeading"),
            (.textCheckMatches, "textVerifyTitle"),
            (.textIncomingHeading, "textIncomingHeading"),
            (.textSessionHeading, "textSessionHeading"),
            (.commonJoin, "joinLabel"),
            (.commonAccept, "acceptLabel"),
            (.commonEndSession, "endSessionLabel"),
            (.nearbyA11yDevices, "rosterContainerLabel"),
            (.linkA11yTransfers, "transfersLabel"),
            (.gateCreateCodeTitle, "createCodeGateTitle"),
        ] {
            let english = L10n.t(key, language: .en)
            XCTAssertTrue(vocabulary.contains("\(constant) = \"\(english)\""), """
                the harness's \(constant) is not the shipped English copy for \
                \(key.rawValue), which is now "\(english)". A physical run would wait out \
                its budget against a control it can never find.
                """)
        }
    }

    // MARK: - what the launcher starts, and what exists to be started

    /// Every test name the launcher asks for exists in the suite.
    ///
    /// `-only-testing:` a name that does not exist is not an error `xcodebuild`
    /// reports usefully: it installs the app, boots the session, runs nothing
    /// and exits successfully. A phase would then "pass" having driven no
    /// device at all — which is the one failure a green two-device log could
    /// never be read as.
    func testEveryRoleTheLauncherStartsExistsInTheSuite() throws {
        let launcher = try Self.launcherSource()
        let suite = try Self.uiTestSource("DevicePairUITests.swift")
        var named: [String] = []
        for line in launcher.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            for prefix in ["first_test=\"", "second_test=\""] where trimmed.hasPrefix(prefix) {
                named.append(String(trimmed.dropFirst(prefix.count).dropLast()))
            }
        }
        XCTAssertEqual(named.count, 6, """
            the launcher no longer names exactly six role tests (it names \(named.count): \
            \(named)), so this guard is no longer looking at every role it starts.
            """)
        for name in named {
            XCTAssertTrue(suite.contains("func \(name)("), """
                the launcher runs -only-testing: on "\(name)", which DevicePairUITests does \
                not declare. xcodebuild would install the app, run nothing, and exit zero — \
                a phase that passed having driven no device.
                """)
        }
        // And every role string the launcher passes is one the suite refuses to
        // be launched as anything else.
        for role in ["nearby-resident", "nearby-connector",
                     "pair-file-generator", "pair-file-joiner",
                     "pair-text-generator", "pair-text-joiner"] {
            XCTAssertTrue(launcher.contains("\"\(role)\""),
                          "the launcher no longer starts the \(role) role")
            XCTAssertTrue(suite.contains("requireDevicePairRun(role: \"\(role)\")"), """
                DevicePairUITests has no role guard for \(role), so a runner launched as one \
                half could silently drive the other.
                """)
        }
    }

    /// A receiving role asks for the empty folder a fresh install has, unless
    /// the operator said not to — and the operator's choice really reaches it.
    ///
    /// The launcher parses `--keep-received`; a flag that never left the shell
    /// would be a setting the operator believed they had changed. This is the
    /// thread from the flag to the launch argument.
    func testTheOperatorsReceivedFolderChoiceReachesTheDevice() throws {
        let launcher = try Self.codeOnly(Self.launcherSource(), comment: "#")
        XCTAssertTrue(launcher.contains("--keep-received) keep_received=1"),
                      "the launcher no longer accepts --keep-received")
        XCTAssertTrue(
            launcher.contains("TEST_RUNNER_RELAYIUM_DEVICE_PAIR_KEEP_RECEIVED=\"$keep_received\""),
            """
            --keep-received is parsed and never passed to the runner, so a device would \
            empty a folder of received files the operator asked it to keep.
            """)
        let acceptance = try Self.codeOnly(Self.uiTestSource("DevicePairAcceptance.swift"))
        XCTAssertTrue(acceptance.contains("value(\"KEEP_RECEIVED\") == \"1\""),
                      "the runner ignores the operator's --keep-received choice")
        let suite = try Self.codeOnly(Self.uiTestSource("DevicePairUITests.swift"))
        XCTAssertTrue(suite.contains("freshReceivedFolder: !run.keepsReceivedFolder"), """
            a receiving role no longer honours the operator's choice; it either always \
            deletes or never does.
            """)
        XCTAssertEqual(
            suite.components(separatedBy: "freshReceivedFolder: !run.keepsReceivedFolder").count - 1,
            2, """
            exactly two roles receive a file — the Nearby resident and the pairing joiner — \
            and both must resolve this the same way.
            """)
    }

    // MARK: - what a failed run may do to diagnose itself

    /// The harness holds no credential and names no device.
    ///
    /// A UDID is a stable identifier for a piece of somebody's hardware, and a
    /// retained acceptance log has no use for one. A credential is worse: this
    /// harness deliberately has nothing to redact, because the generating device
    /// is signed in BY HAND once and the app uses the product's own keychain.
    func testTheHarnessCarriesNoCredentialAndNamesNoDevice() throws {
        var sources: [(String, String)] = [("the launcher", try Self.launcherSource()),
                                           ("the device library", try Self.libSource()),
                                           ("the channel", try RepoRoot.text(
                                                "scripts/lib/device_pair_channel.py"))]
        for name in Self.harnessFiles {
            sources.append((name, try Self.uiTestSource(name)))
        }
        for (name, source) in sources {
            for banned in ["PASSWORD", "BEARER", "_TOKEN", "SECRET", "API_KEY"] {
                XCTAssertFalse(source.contains(banned), """
                    \(name) names \(banned). This harness signs nothing in and holds no \
                    credential: the generating device is signed in by hand, once, and the \
                    app uses the product's own keychain.
                    """)
            }
            // A real 40-hex or modern `00008xxx-` UDID. The self-test fixtures
            // use shapes, not anybody's hardware.
            XCTAssertNil(source.range(of: "\\b[0-9a-fA-F]{40}\\b", options: .regularExpression),
                         "\(name) contains what looks like a 40-character device UDID")
        }
    }

    /// Neither the launcher nor its library can run a command that raises a
    /// system authentication dialog or destroys a device.
    ///
    /// The scan itself lives in the library and is executed by `--self-test`,
    /// which this target runs above. What is pinned here is that the scan is
    /// still WIRED — a self-test that stopped calling it would keep reporting
    /// the same cheerful total.
    func testTheNonInteractivityScanIsStillWired() throws {
        let launcher = try Self.codeOnly(Self.launcherSource(), comment: "#")
        XCTAssertTrue(launcher.contains("ios_forbidden_command_hits \"${BASH_SOURCE[0]}\""),
                      "the self-test no longer scans the launcher itself")
        XCTAssertTrue(launcher.contains("ios_forbidden_command_hits \"$repo_root/scripts/lib/ios-physical-device.sh\""),
                      "the self-test no longer scans the library")
        XCTAssertTrue(launcher.contains("ios_xcodebuild_launch_census"), """
            the self-test no longer counts xcodebuild launches. A bare one inherits this \
            shell's controlling terminal, and Apple's own failure collection has reached \
            for sudo underneath it.
            """)
        // Every launch goes through the detaching shim.
        XCTAssertTrue(launcher.contains("noninteractive xcodebuild"),
                      "the build is started without detaching it from the terminal")
        XCTAssertTrue(launcher.contains("noninteractive env"),
                      "a role is started without detaching it from the terminal")
        let library = try Self.libSource()
        XCTAssertTrue(library.contains("os.setsid()"), """
            the detaching shim no longer starts a new session, so a child still holds a \
            controlling terminal and a prompt has somewhere to go.
            """)
    }

    /// A run that did not reach its end never prints PASS.
    ///
    /// `local-acceptance.sh`'s EXIT trap refuses a zero status that did not come
    /// from reaching the last line. This pins the launcher's half of that: the
    /// completion flag is set on the last line and nowhere else, and PASS is
    /// printed after it.
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
            PASS is not the last thing this script does after marking the run complete, so \
            a phase added after it would be able to fail on a run that already claimed to \
            have passed.
            """)
    }

    // MARK: - compiling one harness file on its own

    /// Compile `alongside` together with `driver`, run it, and return its output
    /// lines.
    ///
    /// The driver is written as `main.swift` because top-level statements are
    /// only allowed in a file with that name. Nothing here touches the
    /// repository: both files are copied into a fresh temporary directory, which
    /// is removed afterwards whether the case passed or not.
    private func runSwift(driver: String, alongside name: String) throws -> [String] {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-roster-choice-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let subject = root.appendingPathComponent(name)
        try Self.uiTestSource(name).write(to: subject, atomically: true, encoding: .utf8)
        let main = root.appendingPathComponent("main.swift")
        try driver.write(to: main, atomically: true, encoding: .utf8)

        let binary = root.appendingPathComponent("subject")
        let compile = Process()
        compile.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        compile.arguments = ["swiftc", "-Onone", subject.path, main.path, "-o", binary.path]
        let compileErrors = Pipe()
        compile.standardError = compileErrors
        compile.standardOutput = Pipe()
        try compile.run()
        let diagnostics = compileErrors.fileHandleForReading.readDataToEndOfFile()
        compile.waitUntilExit()
        guard compile.terminationStatus == 0 else {
            XCTFail("""
                \(name) does not compile on its own:
                \(String(decoding: diagnostics, as: UTF8.self))
                It is deliberately free of XCTest, XCUITest and every product module so that \
                its rule can be executed here rather than only read.
                """)
            return []
        }

        let run = Process()
        run.executableURL = binary
        let output = Pipe()
        run.standardOutput = output
        run.standardError = Pipe()
        try run.run()
        let produced = output.fileHandleForReading.readDataToEndOfFile()
        run.waitUntilExit()
        return String(decoding: produced, as: UTF8.self)
            .components(separatedBy: "\n")
            .filter { !$0.isEmpty }
    }

    // MARK: - the sources these guards are about

    /// The harness's three UI-test files. Named rather than globbed, so a file
    /// added to the target without being considered here is a visible omission.
    private static let harnessFiles = ["DevicePairAcceptance.swift",
                                       "DevicePairRosterChoice.swift",
                                       "DevicePairUITests.swift"]

    /// Exactly what the harness's launch passes beyond the language pin and the
    /// preference pin, and nothing else.
    private static let debugOnlyArguments = [
        "--relayium-ui-testing-preselect-direct-fixture",
        "--relayium-ui-testing-fresh-received-folder",
    ]

    /// One test's own text, so an ordering guard is about that test rather than
    /// about the file.
    ///
    /// Bounded at the next declaration at the same indentation. A guard that
    /// searched the whole file would be satisfied by a line in a DIFFERENT role,
    /// which is precisely the mistake an ordering rule exists to catch.
    private static func body(of test: String, in source: String) throws -> String {
        guard let start = source.range(of: "func \(test)(") else {
            throw DevicePairSeamError(description: """
                DevicePairUITests no longer declares \(test), so the launcher is starting a \
                role that does not exist and this ordering guard has nothing to read.
                """)
        }
        let rest = source[start.upperBound...]
        guard let end = rest.range(of: "\n    func ") else { return String(rest) }
        return String(rest[..<end.lowerBound])
    }

    private static func uiTestSource(_ name: String) throws -> String {
        try RepoRoot.text("apps/ios/RelayiumUITests/\(name)")
    }

    private static func launcherSource() throws -> String {
        try RepoRoot.text("scripts/ios-device-pair-acceptance.sh")
    }

    private static func libSource() throws -> String {
        try RepoRoot.text("scripts/lib/ios-physical-device.sh")
    }

    /// A source with its whole-line comments dropped.
    ///
    /// Every file in this harness explains at length what it deliberately does
    /// NOT do, and names the very mechanisms these guards assert the absence of.
    /// Raw text would fail on the sentence promising the absence being checked.
    private static func codeOnly(_ raw: String, comment: String = "//") -> String {
        raw
            .components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix(comment) }
            .joined(separator: "\n")
    }

    /// SHA-256, as `shasum -a 256` prints it — which is what the launcher runs
    /// on the file it pulls off the receiving device.
    private static func hexSHA256(of data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
