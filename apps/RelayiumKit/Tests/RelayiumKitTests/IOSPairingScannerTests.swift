import XCTest
@testable import RelayiumAppKit
@testable import RelayiumShareKit

/// **The pairing QR scanner: what it may accept, what it must refuse, and the
/// declaration it earns.**
///
/// This feature is the first honest resolution of the protected-resource
/// blocker in `docs/ios-app-store-submission.md`. That record's whole point was
/// that `NSCameraUsageDescription` may not be added to make an upload check
/// pass — so the tests that matter here are not "the key exists" but "the key
/// describes something the app actually does, and only that".
///
/// ### Why half of this reads source and half runs code
///
/// The decision that carries the security weight — which QR payloads become a
/// join code — is `PairingScanPolicy`, and it lives in the iOS app target,
/// which no package test can import. What it delegates to does not:
/// `parseAppDeepLink` is `RelayiumAppKit`'s, it is the SAME gate the Universal
/// Link handler passes through, and every refusal the scanner owes is a refusal
/// that gate already makes. So the adversarial half below drives that gate for
/// real, with the exact payload classes a printed code can carry, and the
/// source half asserts the scanner is a funnel into it rather than a second
/// origin policy that could drift away from it.
///
/// That split is deliberate and it is a real bound: these tests would not catch
/// a `PairingScanPolicy` rewritten to parse URLs itself in a way the source
/// needles below still happen to match. What they do catch is the two failures
/// that have actually happened in this codebase — a second, looser origin list,
/// and a capability declared ahead of the feature.
///
/// ### What no test here can establish
///
/// No automated test may accept a system privacy alert, and none tries. That
/// the camera prompt is presented, that it renders this app's own sentence, and
/// that it renders the Chinese one on a Chinese device are physical
/// observations recorded in `docs/ios-app-store-submission.md`. Everything
/// below is the half that can be established without a device — which is the
/// half the blocker record was wrong about for five builds.
final class IOSPairingScannerTests: XCTestCase {

    // MARK: - paths and readers

    private static let appRoot = "apps/ios/Relayium"
    private static let scannerPath = "apps/ios/Relayium/PairingScannerView.swift"
    private static let directPath = "apps/ios/Relayium/DirectView.swift"
    private static let cameraKey = "NSCameraUsageDescription"

    private func scanner() throws -> String { try RepoRoot.text(Self.scannerPath) }
    private func direct() throws -> String { try RepoRoot.text(Self.directPath) }

    private func plist(_ relativePath: String) throws -> [String: Any] {
        try XCTUnwrap(
            try PropertyListSerialization.propertyList(
                from: try RepoRoot.data(relativePath), options: [], format: nil)
                as? [String: Any],
            "\(relativePath) is not a parseable property list")
    }

    private func infoPlistStrings(_ language: AppLanguage) throws -> [String: String] {
        let path = "\(Self.appRoot)/\(language.lproj).lproj/InfoPlist.strings"
        return try XCTUnwrap(
            try PropertyListSerialization.propertyList(
                from: try RepoRoot.data(path), options: [], format: nil) as? [String: String],
            "\(path) is not a parseable strings file")
    }

    /// Every Swift file both apps compile, app targets and shared package alike.
    /// A capture API added in `RelayiumAppKit` would reach the Mac too, which is
    /// exactly the shape the StoreKit linkage lesson in `IOSSurfaceGuardTests`
    /// was about.
    private func allProductSources() throws -> [(path: String, text: String)] {
        var found: [(String, String)] = []
        for root in ["apps/ios/Relayium", "apps/ios/RelayiumShare",
                     "apps/mac/Relayium", "apps/RelayiumKit/Sources"] {
            for file in try RepoRoot.swiftFiles(under: root) {
                found.append((file.lastPathComponent, try RepoRoot.text(of: file)))
            }
        }
        XCTAssertGreaterThan(found.count, 50, "the product source sweep reached almost nothing")
        return found
    }

    // MARK: - the gate the scanner funnels into, driven adversarially

    /// **Every payload class a printed QR code can carry, refused or accepted
    /// by the shared link gate.**
    ///
    /// These are executable rather than argued because a QR code is the weakest
    /// input this app has: no origin, no signature, and no user intent beyond
    /// "this rectangle was in front of the lens". A sticker on a wall must not
    /// be able to reach anything a typed six-digit code cannot.
    ///
    /// Note what is NOT here: a `.download` acceptance. `/d/` links parse fine
    /// and are a different feature reached from a different screen, so the
    /// scanner treats them as junk — asserted separately below, because the
    /// gate itself accepts them and the SCANNER is what narrows that.
    func testTheLinkGateRefusesEveryPayloadClassAPrintedCodeCanCarry() {
        let refused = [
            // Not a Relayium origin at all.
            "https://relayium.com.evil.example/cross-network#c=123456",
            "https://evil.example/cross-network#c=123456",
            "https://sub.relayium.com/cross-network#c=123456",
            // Userinfo, which is how a foreign host is made to read as this one.
            "https://relayium.com@evil.example/cross-network#c=123456",
            "https://user:pw@relayium.com/cross-network#c=123456",
            // A port that is not the one Associated Domains can deliver.
            "https://relayium.com:8443/cross-network#c=123456",
            "https://relayium.com:80/cross-network#c=123456",
            // An unauthenticated scheme. A printed sticker must not get the
            // reach a verified domain has.
            "relayium://cross-network#c=123456",
            "http://relayium.com/cross-network#c=123456",
            "javascript:alert(1)",
            "file:///etc/passwd",
            // The right origin, the wrong path.
            "https://relayium.com/#c=123456",
            "https://relayium.com/cross-network/extra#c=123456",
            "https://relayium.com/settings#c=123456",
            // The right everything, an unusable code.
            "https://relayium.com/cross-network#c=12345",
            "https://relayium.com/cross-network#c=1234567",
            "https://relayium.com/cross-network#c=12345a",
            "https://relayium.com/cross-network#c=",
            "https://relayium.com/cross-network#code=123456",
            "https://relayium.com/cross-network#c=123456&c=654321",
            "https://relayium.com/cross-network#c=123456&x=1",
            // Not a link.
            "123456",
            "hello world",
            "",
        ]
        for payload in refused {
            guard let url = URL(string: payload) else { continue }
            let link = parseAppDeepLink(url)
            switch link {
            case .realtime(.some), .realtimeWithMode:
                XCTFail("\(payload) yielded a usable join code")
            case .download, .realtime(nil), nil:
                continue
            }
        }
    }

    /// The two shapes a scan is allowed to produce, and the mode hint's bound.
    func testTheLinkGateAcceptsOnlyACompleteCodeAndAValidatedModeHint() throws {
        XCTAssertEqual(parseAppDeepLink(
            try XCTUnwrap(URL(string: "https://relayium.com/cross-network#c=004291"))),
                       .realtime(code: "004291"),
                       "a leading-zero code is an ordinary code and must survive intact")
        XCTAssertEqual(parseAppDeepLink(
            try XCTUnwrap(URL(string: "https://relayium.com/cross-network?mode=file#c=000000"))),
                       .realtimeWithMode(code: "000000", mode: .files))
        XCTAssertEqual(parseAppDeepLink(
            try XCTUnwrap(URL(string: "https://relayium.com/cross-network?mode=text#c=123456"))),
                       .realtimeWithMode(code: "123456", mode: .text))
        // An unrecognised or duplicated hint degrades to no hint rather than to
        // a refusal: the code is still good, and the picker is still the user's.
        for hint in ["?mode=video", "?mode=", "?mode=file&mode=text", "?mode=FILE"] {
            XCTAssertEqual(parseAppDeepLink(
                try XCTUnwrap(URL(string: "https://relayium.com/cross-network\(hint)#c=123456"))),
                           .realtime(code: "123456"),
                           "\(hint) was treated as authority rather than as a hint")
        }
        // And the round trip the feature exists for: what the sending device
        // draws is what the scanning device reads back.
        let link = try XCTUnwrap(pairingJoinURL(
            baseURL: try XCTUnwrap(URL(string: "https://relayium.com")),
            code: "428193", mode: .text))
        XCTAssertEqual(parseAppDeepLink(link), .realtimeWithMode(code: "428193", mode: .text))
    }

    // MARK: - the scanner is a funnel into that gate, not a second policy

    /// **`PairingScanPolicy` decides nothing about origins itself.**
    ///
    /// The failure this guards against is the one the codebase has already had
    /// once, in `parseTransferLink` versus `parseAppDeepLink`: two origin
    /// policies, one of them looser, and no way to tell from either file that
    /// the other exists. A scanner that grew its own host check would be a third,
    /// admitting printed codes the Universal Link handler refuses.
    func testTheScannerDelegatesToTheSharedLinkGateAndOwnsNoOriginPolicy() throws {
        let source = try scanner()
        XCTAssertTrue(source.contains("parseAppDeepLink(url)"),
                      "the scanner does not pass its payload through the shared gate")
        for reimplementation in ["relayium.com", "URLComponents", "url.host", "\"https\"",
                                 "isAppDeepLinkOrigin", "parseTransferLink", "://"] {
            XCTAssertFalse(codeLines(of: source).contains { $0.contains(reimplementation) },
                           "the scanner mentions \(reimplementation) in code, which means it "
                               + "is deciding origin policy a second time")
        }
        // Both refusals the scanner adds ON TOP of the gate, named explicitly
        // rather than falling out of a `default`.
        XCTAssertTrue(source.contains("case .realtime(nil), .download, nil:"),
                      "the scanner no longer refuses a code-less link and a stored download "
                          + "as an explicit, exhaustive case")
        XCTAssertTrue(source.contains("maximumPayloadLength"),
                      "an unbounded payload reaches URL parsing")
    }

    /// A scan reaches the join FIELD and never the join ACTION.
    ///
    /// This is the product invariant the whole feature turns on: a QR code is
    /// photographed by accident, and a scanner that connected would let a poster
    /// on a wall start a session on a phone that was merely pointed at it.
    func testAScanFillsTheFieldAndNothingInTheScannerCanStartASession() throws {
        let source = try scanner()
        for start in ["join(", "mintCode", "beginSession", "sessionStarting",
                      "RealtimeSessionModel", "RealtimeTextSessionModel", "AccountSession"] {
            XCTAssertFalse(source.contains(start),
                           "the scanner reaches for \(start); a scan must produce a code, "
                               + "not a connection")
        }

        let view = try direct()
        XCTAssertTrue(view.contains("PairingScannerView { result in"),
                      "DirectView no longer presents the scanner")
        XCTAssertTrue(view.contains("private func applyScan(_ result: PairingScanResult)"),
                      "the scan result is handled somewhere other than the one named seam")
        // The result goes through the SAME normalization a keystroke does, into
        // the same bindings — not into a raw assignment that would skip the
        // six-digit filter every other entry path uses.
        XCTAssertTrue(view.contains("case .files: file.updateJoinCode(result.code)"))
        XCTAssertTrue(view.contains("case .text:  text.updateJoinCode(result.code)"))
        // And the mode hint passes through the refusal the picker uses, so a
        // scan cannot switch modes under a live session.
        XCTAssertTrue(view.contains("modes.select(mode,"),
                      "the mode hint bypasses DirectModeSelection's own refusal")
        XCTAssertTrue(view.contains("sessionClaimed: presence.owner != nil)"))

        // The join action is not reachable from the scan seam. `applyScan` is
        // read as its own body so an unrelated `join` elsewhere in the file
        // cannot satisfy or break this.
        let body = try XCTUnwrap(view
            .components(separatedBy: "private func applyScan(_ result: PairingScanResult) {")
            .dropFirst().first?
            .components(separatedBy: "\n    }").first)
        for start in ["join(", "beginSession", "canJoin"] {
            XCTAssertFalse(body.contains(start), "applyScan reaches for \(start)")
        }
    }

    // MARK: - the camera, asked for late and used narrowly

    /// **One request, behind one tap, in one file.**
    ///
    /// The purpose string says the camera is for reading a pairing code. That is
    /// only true if nothing else in either app can open one — and this is the
    /// assertion that makes the sentence a fact about the binary rather than a
    /// claim about intent.
    func testTheOnlyCameraRequestInBothAppsSitsBehindTheScannerSTapToScan() throws {
        var requesters: [String] = []
        for (path, text) in try allProductSources()
        where codeLines(of: text).contains(where: { $0.contains("requestAccess(for: .video)") }) {
            requesters.append(path)
        }
        XCTAssertEqual(requesters, ["PairingScannerView.swift"],
                       "the camera is requested from \(requesters); the purpose string "
                           + "describes the pairing scanner and nothing else")

        let source = try scanner()
        // The request is inside `begin()`, `begin()` is reached from the sheet's
        // `.task`, and the sheet is presented by the Scan control. Each link of
        // that chain is what separates the system prompt from app launch.
        let begin = try XCTUnwrap(source
            .components(separatedBy: "func begin() async {").dropFirst().first?
            .components(separatedBy: "\n    }").first)
        XCTAssertTrue(begin.contains("requestAccess(for: .video)"),
                      "the request moved out of the one function the sheet gates")
        XCTAssertEqual(source.components(separatedBy: "requestAccess(for: .video)").count - 1, 1,
                       "the scanner requests camera access more than once")
        XCTAssertTrue(source.contains(".task { await model.begin() }"),
                      "the sheet no longer starts the camera through `begin()`")

        let view = try direct()
        XCTAssertTrue(view.contains("Button { isScanning = true } label:"),
                      "the scanner is presented by something other than an explicit control")
        XCTAssertTrue(view.contains(".sheet(isPresented: $isScanning)"),
                      "the scanner is no longer behind the tap that names it")
        // Nothing in the app opens the camera before that tap.
        for eager in ["AVCaptureDevice", "AVCaptureSession"] {
            let holders = try allProductSources()
                .filter { codeLines(of: $0.text).contains { $0.contains(eager) } }
                .map(\.path)
                .sorted()
            XCTAssertEqual(holders, ["PairingScannerView.swift"],
                           "\(eager) appears in \(holders)")
        }
    }

    /// **QR metadata only. No frame is captured, kept or sent anywhere.**
    ///
    /// `AVCaptureMetadataOutput` restricted to `.qr` is the whole reason the
    /// purpose string may say nothing is recorded or saved. A photo output, a
    /// movie output or a sample-buffer delegate would each make that sentence
    /// false, and none of them would look wrong in a diff.
    func testTheCaptureGraphReadsQRMetadataAndCapturesNoImagery() throws {
        let source = try scanner()
        XCTAssertTrue(source.contains("output.metadataObjectTypes = [.qr]"),
                      "the metadata output no longer restricts itself to QR codes")
        XCTAssertTrue(source.contains("availableMetadataObjectTypes.contains(.qr)"),
                      "the scanner starts a camera it has not established can read QR codes")
        for capture in ["AVCapturePhotoOutput", "AVCaptureMovieFileOutput",
                        "AVCaptureVideoDataOutput", "AVCaptureAudioDataOutput",
                        "AVCaptureAudioPreviewOutput", "AVAudioSession",
                        "for: .audio", "CMSampleBuffer", "CVPixelBuffer", "UIImage",
                        "PHPhotoLibrary", "UIImagePickerController"] {
            XCTAssertFalse(source.contains(capture),
                           "the scanner reaches for \(capture), which contradicts the purpose "
                               + "string's claim that nothing is recorded or saved")
        }
        // And nothing leaves the process: no disk, no network, no pasteboard.
        for exfiltration in ["write(to:", "FileManager", "URLSession", "UIPasteboard",
                             "Data(", ".appendingPathComponent"] {
            XCTAssertFalse(source.contains(exfiltration),
                           "the scanner reaches for \(exfiltration)")
        }
        // Nothing is logged either. A refused payload is attacker-controlled
        // text and a good one is a live pairing code; neither belongs in a log.
        for logging in ["print(", "NSLog(", "os_log(", "debugPrint(", "dump("] {
            XCTAssertFalse(source.contains(logging), "the scanner logs with \(logging)")
        }
    }

    /// **Clean-room AVFoundation, because the oldest supported iPad has an A10.**
    ///
    /// `VisionKit`'s `DataScannerViewController` is the shorter way to write
    /// this and it is unavailable on every device without an A12, which
    /// includes the iPad (7th generation) this project supports. It would not
    /// fail to build; it would return `isSupported == false` at runtime on the
    /// hardware least able to type six digits quickly.
    func testTheScannerUsesPlainAVFoundationRatherThanA12OnlyVisionKit() throws {
        let source = try scanner()
        XCTAssertTrue(source.contains("import AVFoundation"))
        for a12Only in ["VisionKit", "DataScannerViewController", "RecognizedItem"] {
            XCTAssertFalse(source.contains(a12Only),
                           "\(a12Only) needs an A12; the oldest supported iPad has an A10")
        }
        // The declared floor, read rather than restated. `AVCaptureMetadataOutput`
        // and everything above are iOS 13 and earlier; the one newer API in the
        // file is behind an availability check.
        let project = try RepoRoot.text("apps/ios/Relayium.xcodeproj/project.pbxproj")
        XCTAssertTrue(project.contains("IPHONEOS_DEPLOYMENT_TARGET = 16.0;"),
                      "the deployment floor moved; re-derive which capture APIs are reachable")
        XCTAssertTrue(source.contains("if #available(iOS 17.0, *)"),
                      "the iOS 17 rotation API is used without an availability check")
        XCTAssertTrue(source.contains("connection.isVideoOrientationSupported"),
                      "there is no pre-iOS-17 path for preview orientation")
    }

    /// **The session stops on every exit, and one scan yields one result.**
    ///
    /// Four exits, and a camera left running on any of them is a privacy defect
    /// the user cannot see: the result, an explicit Cancel, the interactive
    /// dismissal, and the app leaving the foreground.
    func testCaptureStopsOnEveryExitAndCannotDeliverTwice() throws {
        let source = try scanner()
        XCTAssertTrue(source.contains(".onDisappear { model.end() }"),
                      "dismissing the sheet does not tear the session down")
        XCTAssertTrue(source.contains(".onChange(of: scenePhase)"),
                      "the camera keeps running behind the app switcher")
        XCTAssertTrue(source.contains("model.suspend()"))
        XCTAssertTrue(source.contains("session.stopRunning()"))
        // Stopped BEFORE the caller is told — and "stopped" is the session
        // queue having performed it, not the main actor having scheduled it.
        // The ordering that carries that is asserted by `deliveryViolations`
        // below, which is also run over source mutated to break it.
        let handled = try acceptedBranch(of: source)
        XCTAssertTrue(handled.contains("hasDelivered = true"))
        XCTAssertEqual(deliveryViolations(in: source), [],
                       "the accepted result no longer waits for the queued stop")

        // Two latches, and they are at different layers on purpose: the lock in
        // the delegate is taken before either main-actor hop is scheduled, and
        // the model re-checks because two hops can be in flight at once.
        XCTAssertTrue(source.contains("private var hasAccepted = false"),
                      "the delegate has no one-shot latch, so a burst of frames delivers "
                          + "the same code repeatedly")
        XCTAssertTrue(source.contains("lock.lock()"))
        XCTAssertTrue(source.contains("guard !hasDelivered else { return }"))
        // A refusal must not become a redraw storm under the user's typing.
        XCTAssertTrue(source.contains("lastRefusedPayload"),
                      "a junk code held in view republishes at frame rate")
    }

    // MARK: - the lifecycle, against dismissal and the app switcher

    /// **Every step that resumes after an `await` proves the sheet that asked
    /// for it is still on screen.**
    ///
    /// The defect these two tests were written for was real and not visible in
    /// a diff: `begin()` waits on `AVCaptureDevice.requestAccess`, which cannot
    /// be cancelled and is not interrupted by SwiftUI cancelling the `.task`
    /// that started it. Cancel the sheet or swipe it away while the system
    /// alert is up, tap Allow, and the continuation resumed into a model whose
    /// screen was gone — set `.running`, started capture, and left a camera on
    /// with nothing on screen that had asked for it. The configure wait had the
    /// same shape, and a metadata callback already in flight could deliver a
    /// scanned code into the join field afterwards.
    ///
    /// The fix is one comparison, and the assertions below are ORDERING
    /// assertions rather than presence ones for that reason: a guard that has
    /// drifted below the thing it is meant to gate reads exactly like a guard
    /// that works.
    func testEveryStepThatResumesAfterAnAwaitProvesItStillOwnsTheMountedSheet() throws {
        let source = try scanner()
        let proof = "guard isMounted(activation) else { return }"

        XCTAssertTrue(source.contains("private struct ScannerActivation: Equatable"),
                      "there is no activation token for a resumed step to compare itself against")
        XCTAssertTrue(source.contains(
            "private func isMounted(_ activation: ScannerActivation) -> Bool"))
        XCTAssertTrue(source.contains("mounted == activation"),
                      "isMounted no longer compares against the activation it was handed, so "
                          + "every proof below it is vacuous")

        // One activation at a time, taken before the first suspension. A second
        // live activation could satisfy the first one's proof.
        let begin = try body(of: "func begin() async {", in: source)
        XCTAssertTrue(begin.contains("guard mounted == nil,"),
                      "a second begin() can run while the first is still waiting on the "
                          + "system alert")
        XCTAssertTrue(begin.contains("activationsBegun += 1"),
                      "activation ids are not monotonic, so a dismissed one can be confused "
                          + "with a later mount")
        try assertOrder("mounted = activation",
                        before: "await AVCaptureDevice.requestAccess(for: .video)", in: begin,
                        "the permission wait starts before there is an activation to compare "
                            + "it against")

        // The permission wait. This guard is the whole distance between a
        // dismissed sheet and a camera turning on behind it.
        let afterRequest = try suffix(
            begin, after: "await AVCaptureDevice.requestAccess(for: .video)")
        for act in ["phase = .denied", "await configureAndStart(activation)"] {
            try assertOrder(proof, before: act, in: afterRequest,
                            "a permission answer that arrives after the sheet was dismissed "
                                + "still reaches `\(act)`")
        }

        // The configure wait, which is the same shape one layer down.
        let configure = try body(
            of: "private func configureAndStart(_ activation: ScannerActivation) async {",
            in: source)
        try assertOrder("await withCheckedContinuation", before: proof, in: configure,
                        "the capture graph is published before anything checks whose it is")
        for act in ["phase = Self.hasAVideoCamera", "receiver?.adopt(activation)",
                    "phase = .running", "startCaptureIfAllowed()"] {
            try assertOrder(proof, before: act, in: configure,
                            "a configure that completes after the sheet was dismissed still "
                                + "reaches `\(act)`")
        }
        // Both ways in — a fresh graph and one an earlier activation built —
        // reach that single proof rather than one of them returning early
        // above it, which is how the already-configured path used to start
        // capture having checked nothing.
        XCTAssertEqual(configure.components(separatedBy: proof).count - 1, 1,
                       "the two paths into a start no longer share one proof")
        XCTAssertFalse(configure.contains("startSession("),
                       "configureAndStart starts capture directly, bypassing the gate")
    }

    /// **Dismissal is permanent, the foreground is a precondition of every
    /// start, and a frame read a moment too late delivers nothing.**
    ///
    /// Three separate ways the same camera could outlive its screen, and one
    /// gate that answers all of them: `end()` clears the mounted activation, so
    /// nothing that resumes afterwards can match it; `suspend()` records the
    /// background rather than merely acting on it, so an answer landing behind
    /// the app switcher cannot start capture there; and the delegate stamps
    /// each decision with the activation whose camera read it, so a decision
    /// taken microseconds before dismissal is dropped at the lock and again at
    /// the main actor rather than filling the join field.
    func testDismissalIsPermanentAndNothingStartsOrDeliversOutsideItsActivation() throws {
        let source = try scanner()

        // One gate, holding everything a start depends on. Each of the four can
        // have changed while an `await` above it was suspended.
        let gate = try body(of: "private func startCaptureIfAllowed() {", in: source)
        XCTAssertTrue(gate.contains(
            "guard let activation = mounted, isSceneActive, isConfigured, "
                + "!hasDelivered else { return }"),
                      "the one start gate no longer proves all four of: a sheet is on screen, "
                          + "the app is in the foreground, the capture graph exists, and no "
                          + "result has already been committed — or it no longer BINDS the "
                          + "mounted activation, which is the stamp the queued start must carry")
        XCTAssertTrue(gate.contains("startSession(activation)"),
                      "the gate starts capture without handing over the activation it just "
                          + "proved, so nothing on the session queue can tell whose start it is")
        // And it is the only caller — the declaration, plus that one call.
        XCTAssertEqual(codeLines(of: source).filter { $0.contains("startSession(") }.count, 2,
                       "capture is started from somewhere other than the single gate")

        // Dismissal, and what makes it permanent.
        let end = try body(of: "func end() {", in: source)
        XCTAssertTrue(end.contains("mounted = nil"),
                      "dismissal does not invalidate the activation, so a continuation "
                          + "resuming afterwards still passes every proof above")
        XCTAssertTrue(end.contains("receiver?.disown()"),
                      "the delegate keeps its stamp after dismissal, so a frame still in the "
                          + "pipeline is turned into a live decision")
        XCTAssertTrue(end.contains("stopSession()"))

        // The app switcher. Recording it is the half that matters: the old
        // guard made this a no-op during `.requesting`, which is exactly the
        // window in which a permission answer is about to start the camera.
        let suspend = try body(of: "func suspend() {", in: source)
        try assertOrder("isSceneActive = false", before: "stopSession()", in: suspend,
                        "the session is stopped before the background is recorded")
        XCTAssertFalse(suspend.contains("guard "),
                       "suspend is conditional again, so leaving the foreground during the "
                           + "permission alert or the configure wait is not recorded and the "
                           + "answer starts the camera behind the app switcher")
        // Coming back may start the session this activation already configured
        // — the one late start that is legitimate — and it still goes through
        // the same gate.
        let resume = try body(of: "func resume() async {", in: source)
        try assertOrder("isSceneActive = true", before: "startCaptureIfAllowed()", in: resume,
                        "returning to the foreground tries to start before it is foreground")

        // The stale callback, refused twice: at the main actor…
        let handle = try body(
            of: "private func handle(_ decision: PairingMetadataReceiver.Decision,", in: source)
        for act in ["hasDelivered = true", "onResult(result)", "refusedSomething = true"] {
            try assertOrder("guard isMounted(activation) else { return }", before: act,
                            in: handle,
                            "a decision from a dismissed activation still reaches `\(act)`")
        }
        // …and at the lock, before the hop is even scheduled.
        let delivery = try body(of: "from connection: AVCaptureConnection) {", in: source)
        XCTAssertTrue(delivery.contains("let activation = self.activation"),
                      "the decision is not stamped with the activation whose camera read it")
        XCTAssertTrue(delivery.contains("if activation == nil || hasAccepted {"),
                      "a frame decoded after the delegate was disowned is still turned into "
                          + "a decision")
        XCTAssertTrue(delivery.contains("self.onDecision(activation, decision)"),
                      "the stamp is re-read on the main actor instead of travelling with the "
                          + "decision, which is the same race one hop later")

        let disown = try body(of: "func disown() {", in: source)
        XCTAssertTrue(disown.contains("activation = nil"))
        let adopt = try body(of: "func adopt(_ activation: ScannerActivation) {", in: source)
        for reset in ["self.activation = activation", "hasAccepted = false",
                      "lastRefusedPayload = nil"] {
            XCTAssertTrue(adopt.contains(reset),
                          "adopting a fresh activation does not \(reset), so the new "
                              + "viewfinder inherits the previous one's latches")
        }
    }

    // MARK: - the gap between proving a start and performing one

    /// **Everything the queued start must do, as a predicate that can also be
    /// run over deliberately broken source.**
    ///
    /// The defect this exists for survived two reviews because every assertion
    /// about it was true: `startCaptureIfAllowed` really did prove all four
    /// preconditions on the main actor, and it really was the only caller. What
    /// none of that said is WHEN. The four facts are main-actor state, the start
    /// is handed to `sessionQueue`, and `end()`/`suspend()` run on the main actor
    /// — so both can land entirely between the proof and the `startRunning` it
    /// authorized. The serial queue orders the later `stopRunning` behind that
    /// start, which is why the symptom is a camera that turns on with no sheet on
    /// screen and goes off again rather than one that stays on forever.
    ///
    /// So the invariants below are all about the two instants being different:
    /// stamp before enqueue, re-prove after it, revoke before any stop is
    /// scheduled, and compare the EXACT activation so a newer sheet's permit
    /// cannot authorize an older sheet's queued start.
    ///
    /// This is a function returning violations rather than a body of
    /// `XCTAssert`s because the test below feeds it mutated source and requires
    /// it to complain. A guard that cannot be shown to fail is not evidence.
    private func runPermitViolations(in source: String) -> [String] {
        var violations: [String] = []

        func body(_ declaration: String) -> String? {
            guard let opened = source.components(separatedBy: declaration).dropFirst().first,
                  let body = opened.components(separatedBy: "\n    }").first else {
                violations.append("`\(declaration)` is gone, so nothing about it is proved")
                return nil
            }
            return body
        }
        func requires(_ needle: String, in scope: String?, _ why: String) {
            guard let scope else { return }
            if !scope.contains(needle) { violations.append("`\(needle)` is missing: \(why)") }
        }
        func requiresOrder(_ first: String, before second: String,
                           in scope: String?, _ why: String) {
            guard let scope else { return }
            guard let earlier = scope.range(of: first), let later = scope.range(of: second) else {
                violations.append("`\(first)` or `\(second)` is missing: \(why)")
                return
            }
            if earlier.upperBound > later.lowerBound {
                violations.append("`\(first)` no longer precedes `\(second)`: \(why)")
            }
        }

        // The gate binds what it proved, so there is something to stamp.
        let gate = body("private func startCaptureIfAllowed() {")
        requires("guard let activation = mounted,", in: gate,
                 "the gate tests the mounted activation without binding it, so the queued "
                     + "start carries no identity and cannot be told from a later sheet's")
        requires("startSession(activation)", in: gate,
                 "the start is scheduled without the activation it was proved for")

        // The stamp, and the re-proof. The ordering IS the invariant here: the
        // same line above the `async` proves the enqueue instant, which is the
        // instant that was never in doubt.
        let start = body("private func startSession(_ activation: ScannerActivation) {")
        requiresOrder("permit.grant(activation)", before: "sessionQueue.async {", in: start,
                      "the start is enqueued before the permit authorizing it is written, so "
                          + "the block can execute against a permit that is not yet its own")
        requiresOrder("sessionQueue.async {",
                      before: "guard permit.authorizes(activation) else { return }", in: start,
                      "the activation is re-proved at ENQUEUE time rather than at execution "
                          + "time — a second copy of the gate one line lower, which says nothing "
                          + "about the instant the camera actually turns on")
        requiresOrder("guard permit.authorizes(activation) else { return }",
                      before: "session.startRunning()", in: start,
                      "the camera starts before the queued block re-proves the activation it "
                          + "was enqueued for, so a sheet dismissed in the gap still gets one")

        // The withdrawal, and the reason it cannot be one line later.
        let stop = body(Self.stopDeclaration)
        requiresOrder("permit.revoke()", before: "sessionQueue.async {", in: stop,
                      "the permit is withdrawn after the stop is scheduled. A start already in "
                          + "the queue is then still authorized, and a serial queue runs it "
                          + "BEFORE that stop — which turns the camera on and leaves it on")

        // The permit itself: stamped, not a boolean.
        requires("granted == activation",
                 in: body("func authorizes(_ activation: ScannerActivation) -> Bool {"),
                 "the permit answers whether SOME activation may start rather than whether "
                     + "THIS one may, so a newer sheet's permit authorizes an older sheet's "
                     + "queued start")
        requires("granted = nil", in: body("func revoke() {"),
                 "revoking does not clear the permit, so nothing invalidates a queued start")

        // And there is exactly one of each, so no path avoids all of the above.
        for (call, why) in [("startRunning()", "start"), ("stopRunning()", "stop")] {
            let count = codeLines(of: source).filter { $0.contains(call) }.count
            if count != 1 {
                violations.append("`\(call)` appears \(count) times: capture is \(why)ped from "
                                      + "somewhere other than the one guarded path")
            }
        }
        return violations
    }

    /// The real source satisfies every one of them.
    func testTheQueuedStartIsStampedBeforeItIsEnqueuedAndReprovedBeforeItRuns() throws {
        XCTAssertEqual(try runPermitViolations(in: scanner()), [], """
            the scanner's capture start no longer holds the enqueue-time/execution-time \
            separation. Each line is one way a start proved on the main actor can still \
            reach `startRunning` after the sheet that proved it is gone.
            """)
    }

    /// **And the guard above is not vacuous: each defect it describes, applied
    /// to the real source, makes it complain.**
    ///
    /// Two of these are the exact edits a future reader would find reasonable.
    /// Hoisting the recheck above `sessionQueue.async` reads as "check it once,
    /// early"; moving `permit.revoke()` inside the block reads as "do the
    /// teardown together". Both restore the original defect in full, and neither
    /// changes what any other test in this file asserts.
    func testRemovingTheExecutionTimeRecheckOrRevokingAfterTheStopIsScheduledFails() throws {
        let source = try scanner()
        let recheck = "            guard permit.authorizes(activation) else { return }\n"
        let mutations: [(String, (String) -> String)] = [
            ("the execution-time recheck deleted",
             { $0.replacingOccurrences(of: recheck, with: "") }),
            ("the recheck hoisted to enqueue time, where the gate already ran",
             { $0.replacingOccurrences(of: recheck, with: "")
                 .replacingOccurrences(
                    of: "        permit.grant(activation)\n",
                    with: "        permit.grant(activation)\n"
                        + "        guard permit.authorizes(activation) else { return }\n") }),
            ("invalidation moved after the stop is scheduled",
             { $0.replacingOccurrences(
                of: "        permit.revoke()\n"
                    + "        let session = self.session\n"
                    + "        sessionQueue.async {\n",
                with: "        let session = self.session\n"
                    + "        sessionQueue.async {\n"
                    + "            permit.revoke()\n") }),
            ("the permit reduced to \"someone may start\"",
             { $0.replacingOccurrences(of: "granted == activation", with: "granted != nil") }),
        ]
        for (defect, mutate) in mutations {
            let mutated = mutate(source)
            XCTAssertTrue(mutated != source,
                          "the mutation for `\(defect)` changed nothing, so killing it proves "
                              + "nothing — the source it edits has moved")
            XCTAssertFalse(runPermitViolations(in: mutated).isEmpty,
                           "`\(defect)` passes the run-permit guard, so that guard would not "
                               + "have caught the defect it was written for")
        }
    }

    /// **The permit compiled on its own and driven through the interleaving that
    /// produced the defect.**
    ///
    /// The ordering guards above are source assertions, and source assertions
    /// cannot distinguish a permit that compares the exact activation from one
    /// that answers "somebody may start" — the two differ by one operator, and by
    /// precisely the case a reopened sheet produces. `CaptureRunPermit` is therefore
    /// written as a value with no AVFoundation, no SwiftUI and no product
    /// dependency, so it can be lifted out of the iOS target this package cannot
    /// import, compiled alone, and actually run.
    ///
    /// The last two rows are the race itself rather than a property of the type:
    /// a suspended serial queue stands in for `sessionQueue` with a start already
    /// enqueued, the main thread revokes in the gap exactly as `end()` does, and
    /// the queue is then released. `queue.suspend()` is what makes the
    /// interleaving deterministic instead of a race this would usually lose.
    func testTheRunPermitRefusesAStartInvalidatedBetweenItsEnqueueAndItsExecution() throws {
        XCTAssertEqual(try runPermitDriver(), Self.expectedPermitBehaviour, """
            the capture run permit does not behave the way the queued start relies on. Each \
            line is one instant in the gap between proving a start on the main actor and \
            performing it on the session queue.
            """)
    }

    /// The two ways to break it that source reading cannot see, each killed by
    /// running the type rather than by reading it.
    func testAPermitThatForgetsItsActivationOrItsRevocationFailsThatDriver() throws {
        // A permit that is merely "granted" rather than granted TO somebody: the
        // sheet is dismissed, a new one opens, and the new one's permit
        // authorizes the old one's queued start.
        let forgetful = try runPermitDriver {
            $0.replacingOccurrences(of: "granted == activation", with: "granted != nil")
        }
        XCTAssertNotEqual(forgetful, Self.expectedPermitBehaviour,
                          "a permit not stamped with the exact activation behaves identically "
                              + "to one that is, so this driver proves nothing about the stamp")
        XCTAssertTrue(
            forgetful.contains("a-later-activation-does-not-authorize-an-older-queued-start=true"),
            "the unstamped permit failed for some other reason than the one this case is "
                + "about; it produced \(forgetful)")

        // A revoke that does not revoke. `end()` and `suspend()` both rely on it
        // and neither would look any different.
        let inert = try runPermitDriver {
            $0.replacingOccurrences(of: "        granted = nil\n", with: "")
        }
        XCTAssertNotEqual(inert, Self.expectedPermitBehaviour)
        XCTAssertTrue(inert.contains("camera-started-after-invalidation-in-the-gap=true"),
                      "an inert revoke did not start the camera in the gap, so the driver's "
                          + "race case is not exercising the revoke; it produced \(inert)")
    }

    /// What the permit must answer at each instant. `=false` rows are the ones
    /// the defect got wrong.
    private static let expectedPermitBehaviour = [
        "a-fresh-grant-authorizes-its-own-activation=true",
        "revoked-before-the-queued-start-ran=false",
        "a-later-activation-does-not-authorize-an-older-queued-start=false",
        "the-later-activation-authorizes-its-own-start=true",
        "camera-started-after-invalidation-in-the-gap=false",
        "camera-started-when-the-permit-still-held=true",
    ]

    // MARK: - the gap between scheduling a stop and having stopped

    /// The stop's declaration, which now carries the completion delivery waits
    /// on. Written once because two predicates open its body by name.
    private static let stopDeclaration =
        "private func stopSession(then deliver: (@MainActor @Sendable () -> Void)? = nil) {"

    /// **Everything the accepted result must wait for, as a predicate that can
    /// also be run over deliberately broken source.**
    ///
    /// This defect is the mirror image of the queued-start one, and it survived
    /// for the same reason: every assertion about it was true. `handle` really
    /// did call `stopSession` before `onResult`, and those two lines in that
    /// order really do read as "capture stops, then the caller is told". What
    /// they never said is WHEN capture stops. `stopSession` revokes the permit
    /// synchronously — that half is a real fact — and then *enqueues*
    /// `stopRunning` on `sessionQueue`, because it blocks. So `onResult` on the
    /// next line dismissed the sheet with the stop still sitting in the queue,
    /// behind whatever configure or start was already there: the camera went off
    /// DURING the dismissal rather than before it, and the comment claiming
    /// otherwise was the only evidence for the claim.
    ///
    /// The invariants below are therefore all about the announcement being a
    /// CONSEQUENCE of the stop rather than a line after it. It lives inside the
    /// queued block, after the stop has been performed — or after the queue has
    /// observed the session was already stopped, which is the same fact about
    /// the camera and must not swallow the result. It hops to the main actor
    /// instead of running on the queue, and instead of the main actor waiting on
    /// the queue, which would be a hang behind `stopRunning`. And because that
    /// hop is a main-actor turn during which `end()` can run, it re-proves its
    /// activation before it touches the caller — the same refusal `handle` makes
    /// at its top, arriving one hop later.
    ///
    /// A function returning violations rather than a body of `XCTAssert`s
    /// because the test below feeds it mutated source and requires it to
    /// complain. A guard that cannot be shown to fail is not evidence.
    private func deliveryViolations(in source: String) -> [String] {
        var violations: [String] = []

        func requires(_ needle: String, in scope: String, _ why: String) {
            if !scope.contains(needle) { violations.append("`\(needle)` is missing: \(why)") }
        }
        func refuses(_ needle: String, in scope: String, _ why: String) {
            if codeLines(of: scope).contains(where: { $0.contains(needle) }) {
                violations.append("`\(needle)` is back: \(why)")
            }
        }
        func requiresOrder(_ first: String, before second: String,
                           in scope: String, _ why: String) {
            guard let earlier = scope.range(of: first), let later = scope.range(of: second) else {
                violations.append("`\(first)` or `\(second)` is missing: \(why)")
                return
            }
            if earlier.upperBound > later.lowerBound {
                violations.append("`\(first)` no longer precedes `\(second)`: \(why)")
            }
        }

        guard let opened = source
                .components(separatedBy: "case let .accepted(result):").dropFirst().first,
              let accepted = opened.components(separatedBy: "case .refused:").first else {
            violations.append("`handle` has no `.accepted` arm, so nothing here is proved")
            return violations
        }
        guard let stopOpened = source.components(separatedBy: Self.stopDeclaration)
                .dropFirst().first,
              let stop = stopOpened.components(separatedBy: "\n    }").first else {
            violations.append("`stopSession` no longer takes the completion delivery waits on, "
                                  + "so the result is announced against a stop that has only "
                                  + "been scheduled")
            return violations
        }

        // The hand-off is committed first, then it waits. Committing after the
        // wait would leave a window in which a second decision starts a second
        // delivery and the start gate happily restarts capture underneath it.
        requiresOrder("hasDelivered = true", before: "stopSession { [weak self] in", in: accepted,
                      "the delivery is committed after the wait it must survive, so a hop "
                          + "already in flight can begin a second one inside that window")
        // And it waits rather than continuing on the next line.
        refuses("stopSession()", in: accepted,
                "delivery schedules a stop and carries straight on, which is the defect itself: "
                    + "`stopSession` only revokes and enqueues, so the sheet dismisses with the "
                    + "`stopRunning` still queued behind it")
        requiresOrder("stopSession { [weak self] in", before: "onResult(result)", in: accepted,
                      "the caller is told outside the stop's completion, so nothing about the "
                          + "camera has been established when the join field is filled")
        requiresOrder("guard self.isMounted(activation) else { return }",
                      before: "self.onResult(result)", in: accepted,
                      "the completion delivers without re-proving its activation. The stop it "
                          + "waited on took an unbounded moment and the hop back costs a "
                          + "main-actor turn — a Cancel or a swipe anywhere in there means this "
                          + "fills the join field from a sheet the user has already dismissed")

        // The completion is the last thing the queued block does, and the stop
        // is the thing before it.
        requiresOrder("permit.revoke()", before: "sessionQueue.async {", in: stop,
                      "the completion becomes reachable before the permit is withdrawn")
        requiresOrder("sessionQueue.async {", before: "session.stopRunning()", in: stop,
                      "the stop is performed on the main actor, which is the block it was put "
                          + "on a queue to avoid")
        requiresOrder("session.stopRunning()", before: "Task { @MainActor in deliver() }",
                      in: stop,
                      "the completion runs before the stop it is supposed to be the consequence "
                          + "of, which is the scheduled-versus-performed defect moved one scope "
                          + "inwards")
        refuses("guard session.isRunning else { return }", in: stop,
                "a session the queue finds already stopped returns out of the whole block, so "
                    + "the completion never runs and an accepted scan is dropped rather than "
                    + "delivered late. Already stopped is the same fact about the camera as "
                    + "just stopped, and the caller is owed the result either way")
        refuses("sessionQueue.sync", in: stop,
                "the main actor waits on the session queue instead of being called back, which "
                    + "blocks the main thread behind `stopRunning` and behind any configure or "
                    + "start already queued ahead of it")

        // Textual order cannot say what is NESTED inside the queued block, and
        // that is the whole claim — so the announcement is pinned by its
        // indentation, which is what moving it out of the block would change.
        let announcements = codeLines(of: stop).filter { $0.contains("deliver()") }
        if announcements.count != 1 {
            violations.append("`deliver()` is called \(announcements.count) times: the "
                                  + "announcement is no longer the single last act of the "
                                  + "queued stop")
        } else if announcements[0] != "            Task { @MainActor in deliver() }" {
            violations.append("the announcement is `\(announcements[0])`: it is either outside "
                                  + "the queued block — where it says nothing about the stop — "
                                  + "or run on the session queue rather than hopped to the main "
                                  + "actor")
        }

        // One delivery, one place.
        let handoffs = codeLines(of: source).filter { $0.contains("onResult(result)") }.count
        if handoffs != 1 {
            violations.append("`onResult(result)` appears \(handoffs) times: the result reaches "
                                  + "the caller from somewhere other than the one waiting path")
        }
        return violations
    }

    /// The real source satisfies every one of them.
    func testTheAcceptedResultIsDeliveredOnlyAfterTheQueueHasStoppedTheSession() throws {
        XCTAssertEqual(try deliveryViolations(in: scanner()), [], """
            the accepted result no longer waits for the session queue to switch the camera off. \
            Each line is one way the sheet can dismiss with the `stopRunning` that was supposed \
            to precede it still sitting in the queue.
            """)
    }

    /// **And that guard is not vacuous: each defect it describes, applied to the
    /// real source, makes it complain.**
    ///
    /// The first row is literally the code this replaced, and it is the one a
    /// future reader is most likely to write back — `stopSession()` then
    /// `onResult(result)` is shorter, reads correctly, and every other test in
    /// this file still passes. The rest are the plausible tidying edits: hoist
    /// the callback, lift it out of the closure, drop the "we already checked
    /// this" guard, restore the early return, or make the wait a `sync`.
    func testDeliveringBeforeTheQueuedStopHasRunFails() throws {
        let source = try scanner()
        let delivery = try deliveryBlock(of: source)
        let performThenAnnounce = "            if session.isRunning { session.stopRunning() }\n"
            + "            guard let deliver else { return }\n"
            + "            Task { @MainActor in deliver() }\n"
        let mutations: [(String, (String) -> String)] = [
            ("the original: a stop scheduled, and the caller told on the next line",
             { $0.replacingOccurrences(
                of: delivery,
                with: "            stopSession()\n            onResult(result)\n") }),
            ("the announcement hoisted above the stop it is the consequence of",
             { $0.replacingOccurrences(
                of: performThenAnnounce,
                with: "            guard let deliver else { return }\n"
                    + "            Task { @MainActor in deliver() }\n"
                    + "            if session.isRunning { session.stopRunning() }\n") }),
            ("the announcement lifted out of the queued block",
             { $0.replacingOccurrences(
                of: "            guard let deliver else { return }\n"
                    + "            Task { @MainActor in deliver() }\n"
                    + "        }\n",
                with: "        }\n"
                    + "        guard let deliver else { return }\n"
                    + "        Task { @MainActor in deliver() }\n") }),
            ("the completion's activation re-proof dropped as already checked",
             { $0.replacingOccurrences(
                of: "                guard self.isMounted(activation) else { return }\n",
                with: "") }),
            ("the early return restored, so an already-stopped session drops the result",
             { $0.replacingOccurrences(
                of: "            if session.isRunning { session.stopRunning() }\n",
                with: "            guard session.isRunning else { return }\n"
                    + "            session.stopRunning()\n") }),
            ("the callback traded for the main actor waiting on the session queue",
             { $0.replacingOccurrences(of: "        sessionQueue.async {\n"
                                        + "            if session.isRunning",
                                       with: "        sessionQueue.sync {\n"
                                        + "            if session.isRunning") }),
        ]
        for (defect, mutate) in mutations {
            let mutated = mutate(source)
            XCTAssertTrue(mutated != source,
                          "the mutation for `\(defect)` changed nothing, so killing it proves "
                              + "nothing — the source it edits has moved")
            XCTAssertFalse(deliveryViolations(in: mutated).isEmpty,
                           "`\(defect)` passes the delivery guard, so that guard would not have "
                               + "caught the defect it was written for")
        }
    }

    // MARK: - the declaration, and the copy bound on it

    /// The English fallback and the English catalog are one sentence, and the
    /// Chinese one is a translation rather than a copy.
    ///
    /// The same two failure modes `IOSLocalNetworkPermissionTests` catches for
    /// the local-network key, applied to the key this batch adds: iOS renders
    /// the plist value for an unmatched language and the catalog for a matched
    /// one, so drift means two different promises about one permission.
    func testTheCameraPurposeStringIsOneSentenceInBothPlacesAndRealChinese() throws {
        let fallback = try XCTUnwrap(
            try plist("\(Self.appRoot)/Info.plist")[Self.cameraKey] as? String)
        let english = try XCTUnwrap(try infoPlistStrings(.en)[Self.cameraKey])
        let chinese = try XCTUnwrap(try infoPlistStrings(.zh)[Self.cameraKey])

        XCTAssertEqual(english, fallback,
                       "the English catalog and the Info.plist fallback say different things")
        XCTAssertNotEqual(chinese, english, "zh-Hans repeats the English sentence verbatim")
        XCTAssertTrue(chinese.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) },
                      "zh-Hans carries no Han characters")
        XCTAssertFalse(english.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) },
                       "the English catalog carries Han characters")
        for text in [english, chinese] {
            XCTAssertTrue(text.contains("Relayium"), "an unnamed sentence reads as the system's")
            for marker in ["TODO", "FIXME", "XXX", "TBD", "PLACEHOLDER", "待翻译", "占位"] {
                XCTAssertFalse(text.localizedCaseInsensitiveContains(marker),
                               "the copy still carries the \(marker) placeholder")
            }
        }
    }

    /// **The sentence describes reading a pairing code, and claims nothing
    /// else.**
    ///
    /// This is the bound the blocker record exists to defend. An overclaiming
    /// purpose string is its own review risk, and here it would also contradict
    /// the App Privacy answers: this app collects no photos, no video and no
    /// audio, so a sentence implying any of them would be false in a second
    /// place.
    func testNeitherCameraPurposeStringClaimsAnyCaptureBeyondReadingACode() throws {
        let english = try XCTUnwrap(try infoPlistStrings(.en)[Self.cameraKey])
        let chinese = try XCTUnwrap(try infoPlistStrings(.zh)[Self.cameraKey])

        // Word-bounded, so a future sentence is judged on the word it uses.
        // `record` is deliberately absent from this list: the English sentence
        // says nothing IS recorded, and banning the word would ban the denial
        // along with the claim.
        for word in ["photo", "photos", "video", "videos", "microphone", "audio",
                     "album", "library", "upload", "uploads", "face", "scanning your"] {
            let pattern = "\\b\(NSRegularExpression.escapedPattern(for: word))\\b"
            XCTAssertNil(english.range(of: pattern,
                                       options: [.regularExpression, .caseInsensitive]),
                         "the English camera string claims \(word)")
        }
        for substring in ["照片", "相册", "视频", "录像", "麦克风", "录音", "上传", "人脸"] {
            XCTAssertFalse(chinese.contains(substring),
                           "the Chinese camera string claims \(substring)")
        }
        // And it says the thing it is FOR. A sentence that avoided every banned
        // word by describing nothing would pass the half above.
        for required in ["camera", "code"] {
            XCTAssertTrue(english.localizedCaseInsensitiveContains(required),
                          "the English camera string never mentions the \(required)")
        }
        for required in ["摄像头", "二维码"] {
            XCTAssertTrue(chinese.contains(required),
                          "the Chinese camera string never mentions \(required)")
        }
    }

    // MARK: - the screen, in two languages

    /// Every sentence the scanner draws comes from the catalog, in both shipped
    /// languages, and each refusal names typing as the way on.
    ///
    /// The last half is the product requirement rather than a localization one:
    /// denied, restricted, no-camera and failed-to-start are four different true
    /// statements, and a reader who gets any of them must still be told the
    /// six-digit field works.
    func testEverySentenceTheScannerDrawsIsLocalizedAndKeepsTypingAvailable() throws {
        let source = try scanner()
        for key in [L10nKey.pairingScanTitle, .pairingScanHint, .pairingScanViewfinderLabel,
                    .pairingScanRequesting, .pairingScanDeniedTitle, .pairingScanDeniedBody,
                    .pairingScanRestrictedBody, .pairingScanUnavailableTitle,
                    .pairingScanUnavailableBody, .pairingScanFailedBody,
                    .pairingScanOpenSettings, .pairingScanRejected] {
            XCTAssertTrue(source.contains("L10n.t(.\(keyCase(key)))"),
                          "the scanner does not render \(key.rawValue)")
        }
        // The two the join card renders, not the sheet.
        for key in [L10nKey.pairingScanCode, .pairingScanFilled] {
            XCTAssertTrue(try direct().contains("L10n.t(.\(keyCase(key)))"),
                          "DirectView does not render \(key.rawValue)")
        }

        // Every refusal names the field that still works, in both languages.
        for key in [L10nKey.pairingScanDeniedBody, .pairingScanRestrictedBody,
                    .pairingScanUnavailableBody, .pairingScanFailedBody] {
            XCTAssertTrue(L10n.t(key, language: .en).localizedCaseInsensitiveContains("six digits"),
                          "\(key.rawValue) leaves an English reader with no way on")
            XCTAssertTrue(L10n.t(key, language: .zh).contains("六位"),
                          "\(key.rawValue) leaves a Chinese reader with no way on")
        }
        // Only `denied` offers Settings, because it is the only one a person can
        // change there. Telling somebody with no camera to open Settings is
        // advice that cannot work.
        XCTAssertTrue(L10n.t(.pairingScanDeniedBody, language: .en)
                        .localizedCaseInsensitiveContains("settings"))
        for key in [L10nKey.pairingScanRestrictedBody, .pairingScanUnavailableBody,
                    .pairingScanFailedBody] {
            XCTAssertFalse(L10n.t(key, language: .en).localizedCaseInsensitiveContains("settings"),
                           "\(key.rawValue) offers a remedy its state does not have")
        }
        XCTAssertTrue(source.contains("offersSettings: true"))
        XCTAssertEqual(source.components(separatedBy: "offersSettings: true").count - 1, 1,
                       "Settings is offered from more than the one state that can use it")

        // The success line says Join is still owed. It is the copy half of the
        // never-auto-join rule, and it must read that way in both languages.
        XCTAssertTrue(L10n.t(.pairingScanFilled, language: .en)
                        .localizedCaseInsensitiveContains("join"))
        XCTAssertTrue(L10n.t(.pairingScanFilled, language: .zh).contains("加入"))
        // A refusal says nothing was changed, because a silent refusal looks
        // exactly like a scanner that ate the digits already typed.
        XCTAssertTrue(L10n.t(.pairingScanRejected, language: .en)
                        .localizedCaseInsensitiveContains("nothing was changed"))
    }

    /// The viewfinder is not an unlabelled rectangle to VoiceOver, and no
    /// English literal is drawn anywhere in the sheet.
    func testTheScannerIsUsableWithoutSightAndDrawsNoUntranslatedCopy() throws {
        let source = try scanner()
        XCTAssertTrue(source.contains(".accessibilityLabel(L10n.t(.pairingScanViewfinderLabel))"),
                      "live video with no label is a screen VoiceOver reads as empty")
        XCTAssertTrue(source.contains(".accessibilityHint(L10n.t(.pairingScanHint))"))

        // Any `Text("…")` or `Label("…"` with a literal is untranslated copy.
        for shape in ["Text(\"", "Label(\"", "navigationTitle(\"", "accessibilityLabel(\""] {
            XCTAssertFalse(source.contains(shape),
                           "the scanner draws a literal through \(shape)")
        }
    }

    // MARK: - helpers

    /// Source lines that are not whole-line comments.
    ///
    /// This file's needles include things the scanner's own documentation
    /// discusses at length — `relayium.com`, `://`, the refused payload
    /// classes — so a raw substring scan would answer the prose rather than the
    /// code, which is the failure `BannedTestShape` was written for.
    private func codeLines(of source: String) -> [String] {
        source.components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
    }

    /// The body of one declaration, so an assertion about one function cannot
    /// be satisfied by a line somewhere else in the file — which for the
    /// lifecycle tests above is the whole point: `guard isMounted(activation)`
    /// appearing *somewhere* proves nothing about the path that skipped it.
    private func body(of declaration: String,
                      in source: String,
                      file: StaticString = #filePath,
                      line: UInt = #line) throws -> String {
        let opened = try XCTUnwrap(source.components(separatedBy: declaration).dropFirst().first,
                                   "the scanner has no `\(declaration)`",
                                   file: file, line: line)
        return try XCTUnwrap(opened.components(separatedBy: "\n    }").first,
                             "`\(declaration)` has no body this test can read",
                             file: file, line: line)
    }

    /// Everything after a needle, for assertions about what a step is allowed
    /// to do once it is back from a suspension.
    private func suffix(_ body: String,
                        after needle: String,
                        file: StaticString = #filePath,
                        line: UInt = #line) throws -> String {
        let range = try XCTUnwrap(body.range(of: needle),
                                  "`\(needle)` is missing", file: file, line: line)
        return String(body[range.upperBound...])
    }

    /// Both needles are present, and in that order. A guard below the thing it
    /// gates reads identically to one above it unless the order is asserted.
    private func assertOrder(_ first: String,
                             before second: String,
                             in body: String,
                             _ why: String,
                             file: StaticString = #filePath,
                             line: UInt = #line) throws {
        let earlier = try XCTUnwrap(body.range(of: first),
                                    "`\(first)` is missing", file: file, line: line)
        let later = try XCTUnwrap(body.range(of: second),
                                  "`\(second)` is missing", file: file, line: line)
        XCTAssertTrue(earlier.upperBound <= later.lowerBound, why, file: file, line: line)
    }

    /// One top-level declaration's full text, brace to brace.
    ///
    /// The scanner imports `UIKit`, `SwiftUI` and `AVFoundation`, none of which
    /// this host can compile, so the permit is lifted OUT of it rather than
    /// compiled with it. Nested braces are indented, so the first `"\n}\n"` after
    /// the keyword is the declaration's own closing brace.
    private func topLevelDeclaration(_ opening: String,
                                     in source: String,
                                     file: StaticString = #filePath,
                                     line: UInt = #line) throws -> String {
        let start = try XCTUnwrap(source.range(of: "\n\(opening)"),
                                  "the scanner has no top-level `\(opening)`",
                                  file: file, line: line)
        let rest = source[start.lowerBound...].dropFirst()
        let close = try XCTUnwrap(rest.range(of: "\n}\n"),
                                  "`\(opening)` has no top-level closing brace",
                                  file: file, line: line)
        return String(rest[..<close.upperBound])
    }

    /// The permit's two types, plus the driver, as one `main.swift`.
    ///
    /// One file because top-level statements are only allowed in `main.swift`
    /// and both types are `private` — file scope is what lets the driver reach
    /// them without editing the product's access control to suit a test.
    private func permitSubject(mutating: ((String) -> String)?) throws -> String {
        let source = try scanner()
        let types = """
        import Foundation

        \(try topLevelDeclaration("private struct ScannerActivation", in: source))
        \(try topLevelDeclaration("private final class CaptureRunPermit", in: source))
        /// A reference box: a `DispatchQueue.async` closure is `@Sendable` and
        /// may not mutate a captured local.
        final class Started: @unchecked Sendable { var value = false }

        """
        guard let mutating else { return types + Self.permitDriver }
        let mutated = mutating(types)
        XCTAssertTrue(mutated != types,
                      "the permit mutation changed nothing, so the driver would re-prove the "
                          + "real behaviour and call it a kill")
        return mutated + Self.permitDriver
    }

    /// The driver: four questions about the permit as a value, then the race.
    private static let permitDriver = """
    func say(_ name: String, _ answer: Bool) { print("\\(name)=\\(answer)") }

    /// The interleaving itself, made deterministic by holding the queue: a start
    /// enqueued under a valid permit, the main thread revoking in the gap, and
    /// only then the queue released to run what it was handed.
    func startedCamera(invalidatingInTheGap: Bool) -> Bool {
        let permit = CaptureRunPermit()
        let activation = ScannerActivation(id: 7)
        let queue = DispatchQueue(label: "session")
        let started = Started()

        queue.suspend()
        permit.grant(activation)
        queue.async {
            guard permit.authorizes(activation) else { return }
            started.value = true
        }
        if invalidatingInTheGap { permit.revoke() }
        queue.resume()
        queue.sync {}
        return started.value
    }

    /// Wrapped in a function because a top-level `let` may not have a private
    /// type, and the permit is private exactly as the product declares it.
    func drive() {
        let permit = CaptureRunPermit()
        let first = ScannerActivation(id: 1)
        let second = ScannerActivation(id: 2)

        permit.grant(first)
        say("a-fresh-grant-authorizes-its-own-activation", permit.authorizes(first))

        // `end()` or `suspend()`, before the queued block reached its recheck.
        permit.revoke()
        say("revoked-before-the-queued-start-ran", permit.authorizes(first))

        // Dismissed, reopened. The new sheet's permit must not authorize the old
        // sheet's start, which is still sitting in the queue.
        permit.grant(second)
        say("a-later-activation-does-not-authorize-an-older-queued-start",
            permit.authorizes(first))
        say("the-later-activation-authorizes-its-own-start", permit.authorizes(second))

        say("camera-started-after-invalidation-in-the-gap",
            startedCamera(invalidatingInTheGap: true))
        say("camera-started-when-the-permit-still-held",
            startedCamera(invalidatingInTheGap: false))
    }
    drive()

    """

    /// Compile the permit alone and run it, returning its output lines.
    ///
    /// Nothing here touches the repository: the extracted text is written into a
    /// fresh temporary directory that is removed whether the case passed or not.
    private func runPermitDriver(mutating: ((String) -> String)? = nil,
                                 file: StaticString = #filePath,
                                 line: UInt = #line) throws -> [String] {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-capture-permit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let main = root.appendingPathComponent("main.swift")
        try permitSubject(mutating: mutating).write(to: main, atomically: true, encoding: .utf8)

        let binary = root.appendingPathComponent("permit")
        let compile = Process()
        compile.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        compile.arguments = ["swiftc", "-Onone", main.path, "-o", binary.path]
        let diagnostics = Pipe()
        compile.standardError = diagnostics
        compile.standardOutput = Pipe()
        try compile.run()
        let reported = diagnostics.fileHandleForReading.readDataToEndOfFile()
        compile.waitUntilExit()
        guard compile.terminationStatus == 0 else {
            XCTFail("""
                the capture run permit does not compile on its own:
                \(String(decoding: reported, as: UTF8.self))
                It is deliberately free of AVFoundation, SwiftUI and UIKit so that its rule \
                can be executed here rather than only read out of the file.
                """, file: file, line: line)
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

    /// The `.accepted` arm of `handle`, arm to arm.
    private func acceptedBranch(of source: String,
                                file: StaticString = #filePath,
                                line: UInt = #line) throws -> String {
        let opened = try XCTUnwrap(
            source.components(separatedBy: "case let .accepted(result):").dropFirst().first,
            "the scanner no longer has an `.accepted` arm", file: file, line: line)
        return try XCTUnwrap(opened.components(separatedBy: "case .refused:").first,
                             "the `.accepted` arm is not followed by the `.refused` one",
                             file: file, line: line)
    }

    /// The whole `stopSession { … }` call in `handle`, brace to brace.
    ///
    /// Read out of the source rather than typed here, so the mutation that
    /// replaces it with the pre-fix two-liner does not have to reproduce the
    /// comments inside it — and so it keeps working when they are reworded.
    private func deliveryBlock(of source: String,
                               file: StaticString = #filePath,
                               line: UInt = #line) throws -> String {
        let opening = "            stopSession { [weak self] in"
        let start = try XCTUnwrap(source.range(of: opening),
                                  "delivery no longer waits on a `stopSession` completion",
                                  file: file, line: line)
        let rest = source[start.lowerBound...]
        let close = try XCTUnwrap(rest.range(of: "\n            }\n"),
                                  "the delivery block has no closing brace at its own indent",
                                  file: file, line: line)
        return String(rest[..<close.upperBound])
    }

    /// The Swift case name for a key, derived from the key rather than typed
    /// twice: `pairing.scanHint` is `pairingScanHint`.
    private func keyCase(_ key: L10nKey) -> String {
        let parts = key.rawValue.components(separatedBy: ".")
        return parts.enumerated()
            .map { index, part in
                index == 0 ? part : part.prefix(1).uppercased() + part.dropFirst()
            }
            .joined()
    }
}
