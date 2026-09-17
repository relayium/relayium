import UIKit
import XCTest

/// Rendered evidence for the reference-layout review: what the redesigned
/// surfaces actually look like, in both shipped languages, both appearances, at
/// an accessibility text size, signed out and signed in, and on whichever shell
/// the destination device draws.
///
/// **Nothing here is skippable.** A capture that cannot be taken, an appearance
/// that did not apply, a language that did not load, or a control that never
/// came within reach fails the test rather than quietly attaching a Light
/// English screenshot under a Dark Chinese name — which is the only failure mode
/// a screenshot suite really has.
///
/// Every claim is checked against the rendering rather than against the launch
/// argument that asked for it: the appearance from the captured pixels, the
/// language from copy only that language renders, the reading measure and the
/// touch floor from the frames the app reports.
final class ReferenceLayoutCaptureTests: XCTestCase {

    /// `Metrics.readingMeasure`, and the page gutter plus a card's own inset
    /// that sit inside it. A full-width control in a card is the column less
    /// twice that pair, on every device.
    private static let readingMeasure: CGFloat = 660
    private static let contentInset: CGFloat = 16 + 16
    /// `Metrics.hitTarget`, less a point for rounding in reported frames.
    private static let touchFloor: CGFloat = 43.5
    /// How far from a scroll edge an element has to be before iOS 26 stops
    /// fading it. Derived from a measured capture rather than chosen: the
    /// rejected label cleared the tab bar by about 11pt and the fade was still
    /// on it, while one row's height clear of an edge measured 5.10:1 for a
    /// role that read 2.10:1 inside the band.
    private static let fadeMargin: CGFloat = 44
    /// The Nearby task's own control, and the anchor the page scroller is
    /// resolved by. English, like every geometry probe in this file.
    private static let chooserLabel = "Choose Files or Folders…"
    /// The label the system audit named, in the language this proof launches in.
    private static let verificationLabel = "Compare verification codes with the other device"

    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    override func tearDownWithError() throws {
        app?.terminate()
    }

    // MARK: - the matrix

    func testEnglishLightCapturesEverySurface() throws {
        try captureEverySurface(language: .english, dark: false, name: "en-light")
    }

    func testEnglishDarkCapturesEverySurface() throws {
        try captureEverySurface(language: .english, dark: true, name: "en-dark")
    }

    func testSimplifiedChineseLightCapturesEverySurface() throws {
        try captureEverySurface(language: .simplifiedChinese, dark: false, name: "zh-light")
    }

    func testSimplifiedChineseDarkCapturesEverySurface() throws {
        try captureEverySurface(language: .simplifiedChinese, dark: true, name: "zh-dark")
    }

    /// The same surfaces at an accessibility content size, where a row that lays
    /// its label beside its value has to turn and a card that sized itself to
    /// its text has to grow.
    func testTheLargestTextSizeCapturesEverySurface() throws {
        try captureEverySurface(language: .english, dark: false,
                                contentSize: "UICTContentSizeCategoryAccessibilityXXL",
                                name: "en-light-axxxl")
    }

    /// The signed-in account and inbox, in both appearances.
    ///
    /// Most of what changed on the Account surface — the identity group, the
    /// device group and the stored-file group, each now a row group with its
    /// caption and its footnote — does not exist at all signed out, so a
    /// signed-out capture would review the sign-in form and call it the account
    /// screen.
    func testTheSignedInAccountAndInboxAreCapturedInBothAppearances() throws {
        for dark in [false, true] {
            launch(language: .english, dark: dark, signedIn: true)
            waitForShell(app)
            let name = dark ? "en-dark-signedin" : "en-light-signedin"

            openSurface(Shell.account, titled: Language.english.title(of: Shell.account))
            // The account fixture's own data, waited for BEFORE anything is
            // captured. A still-loading list and a signed-out screen both draw
            // an account-shaped page, and either would be attached as evidence
            // of the row groups without this.
            let email = app.staticTexts["person@example.com"].firstMatch
            XCTAssertTrue(email.waitForExistence(timeout: 30),
                          "the signed-in fixture's identity row never rendered")
            for device in ["Studio Mac", "Kitchen laptop"] {
                let row = app.staticTexts[device].firstMatch
                scrollUntilExists(row)
                XCTAssertTrue(row.exists,
                              "the device group never rendered the fixture's \(device) row")
            }
            for object in ["obj_uitest", "obj_nokey"] {
                let row = app.staticTexts[object].firstMatch
                scrollUntilExists(row)
                XCTAssertTrue(row.exists,
                              "the stored-file group never rendered the fixture's \(object) row")
            }
            captureColumn(name: "\(name)-account")

            openSurface(Shell.deviceInbox, titled: Language.english.title(of: Shell.deviceInbox))
            XCTAssertTrue(app.staticTexts["inbox-status"].waitForExistence(timeout: 20),
                          "the signed-in inbox never rendered its status group")
            captureColumn(name: "\(name)-deviceInbox")

            try assertCapturedAppearance(dark: dark)
            app.terminate()
        }
    }

    // MARK: - geometry the reference is actually about

    /// The reading measure bounds and CENTRES the column when there is more
    /// width than it, and leaves the compact gutter exactly as it is when there
    /// is not.
    ///
    /// **The container is derived from the one frame that is real, because two
    /// plausible ones are not.** On the iPad split view the navigation bar and
    /// the page's own `ScrollView` both report the whole 1032pt window, while
    /// the content occupies 330..1032 — so measuring against either put a
    /// correctly centred control at midX 681 against a container at midX 516,
    /// out by exactly half the sidebar. The sidebar's `CollectionView` does
    /// report its real frame, so the viewport is taken from its trailing edge
    /// to the window's. Both earlier containers were guesses about the tree;
    /// this one is read off it.
    func testTheReadingMeasureBoundsAndCentresTheColumn() throws {
        launch(language: .english, dark: false)
        let layout = waitForShell(app)
        let title = Language.english.title(of: Shell.lanTransfer)
        openSurface(Shell.lanTransfer, titled: title)

        let chooser = app.buttons[Self.chooserLabel].firstMatch
        XCTAssertTrue(chooser.waitForExistence(timeout: 20),
                      "the Nearby task lost its chooser, so the column cannot be measured")
        // This also settles the split view: a sidebar still overlaying the
        // detail column leaves the control unhittable, so the run fails here
        // rather than measuring a column something is sitting on top of.
        scrollUntilHittable(chooser)

        // **The viewport is derived, because no element reports it.**
        //
        // The exported tree settles this: the page's `ScrollView` carries
        // `destination-lanTransfer` and measures the whole 1032pt window, and
        // so does the navigation bar — the content's region is the window's
        // safe area minus the visible sidebar, which nothing publishes as a
        // frame. The sidebar's own `CollectionView` DOES report truthfully
        // (10, 32, 320, 1334), so the regular viewport runs from its trailing
        // edge to the window's. Derived rather than hard-coded at 330: a
        // different iPad, orientation or split gives a different sidebar.
        let window = app.windows.firstMatch.frame
        let control = chooser.frame

        let sidebars = app.collectionViews.matching(identifier: "sidebar")
        let sidebarCount = layout == .regular ? sidebars.count : 0
        let sidebar = (layout == .regular && sidebarCount == 1)
            ? sidebars.firstMatch.frame : .zero

        let scrollers = app.scrollViews.containing(
            NSPredicate(format: "label == %@", Self.chooserLabel))
        let scrollerCount = layout == .compact ? scrollers.count : 0
        let scroller = (layout == .compact && scrollerCount == 1)
            ? scrollers.firstMatch.frame : .zero

        let container: CGRect = layout == .regular
            ? CGRect(x: sidebar.maxX, y: window.minY,
                     width: window.maxX - sidebar.maxX, height: window.height)
            : scroller

        // Everything a failure would need, attached BEFORE the first assertion.
        let hierarchy = XCTAttachment(string: """
            layout=\(layout)
            window=\(window)
            sidebars=\(sidebarCount) sidebar=\(sidebar)
            scrollers containing the chooser=\(scrollerCount) scroller=\(scroller)
            derived viewport=\(container)
            control=\(control)

            \(app.debugDescription)
            """)
        hierarchy.name = "reading-measure-hierarchy-\(layout)"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
        attach(name: "reading-measure-\(layout)")

        XCTAssertGreaterThan(control.width, 0, "the chooser reported no frame to measure")
        XCTAssertGreaterThan(container.width, 0,
                             "the viewport came out zero-width: \(container)")
        XCTAssertGreaterThan(container.height, 0,
                             "the viewport came out zero-height: \(container)")

        switch layout {
        case .regular:
            XCTAssertEqual(sidebarCount, 1,
                           "expected exactly one sidebar to derive the viewport from, "
                           + "found \(sidebarCount) — see the attached hierarchy")
            XCTAssertLessThan(sidebar.midX, window.midX,
                              "the sidebar is not the leading column: \(sidebar) in \(window)")
            XCTAssertGreaterThanOrEqual(control.minX, sidebar.maxX,
                                        "the chooser is inside the sidebar column — "
                                        + "control \(control), sidebar \(sidebar)")
            // A regular-width run is the only one that can observe the cap, so
            // it must actually be wide enough to. A narrow split-view column
            // fails here rather than passing through the compact branch and
            // leaving the cap uncovered by the whole matrix.
            XCTAssertGreaterThan(container.width, Self.readingMeasure,
                                 "the regular shell's detail column is only "
                                 + "\(container.width)pt wide, so this device cannot cover "
                                 + "the reading measure; run it at full width")
            XCTAssertLessThanOrEqual(control.width,
                                     Self.readingMeasure - 2 * Self.contentInset + 1,
                                     "a full-width control measured \(control.width)pt in a "
                                     + "\(container.width)pt column: the content is being "
                                     + "stretched to the column instead of capped")
            XCTAssertEqual(control.midX, container.midX, accuracy: 2,
                           "the capped column is not centred in its detail column — "
                           + "control \(control), viewport \(container)")
            XCTAssertGreaterThan(control.minX - container.minX, Self.contentInset + 1,
                                 "the column is capped but pinned to the leading edge, so the "
                                 + "gutters never grew")
        case .compact:
            XCTAssertEqual(scrollerCount, 1,
                           "expected exactly one scroller holding the chooser, "
                           + "found \(scrollerCount) — see the attached hierarchy")
            XCTAssertLessThanOrEqual(container.width, Self.readingMeasure,
                                     "a compact shell \(container.width)pt wide is past the "
                                     + "reading measure, so this branch is measuring the "
                                     + "wrong thing")
            XCTAssertEqual(control.minX - container.minX, Self.contentInset, accuracy: 2,
                           "the compact gutter is not the page gutter plus a card's inset")
        }
    }

    /// A row's explain control is a real 44pt target that does not sit on top of
    /// the row's own content, and the explanation it holds is genuinely folded.
    ///
    /// The Device Inbox status group is where the folded mechanism lives, so it
    /// is where the claim is checked rather than in a preview of the primitive.
    ///
    /// **Signed in, because the status group does not exist otherwise.**
    /// `DeviceInboxEntry.entry` sends a device with no account to the
    /// `.account` arm, which draws the sign-in gate and nothing else — so a
    /// signed-out launch waits twenty seconds for an `inbox-status` the product
    /// is correctly not drawing. The first iPhone capture run is the record of
    /// that: the attached screenshot is the gate.
    func testTheRowExplainControlIsAContainedTargetOverAFoldedExplanation() throws {
        launch(language: .english, dark: false, signedIn: true)
        waitForShell(app)
        openSurface(Shell.deviceInbox, titled: Language.english.title(of: Shell.deviceInbox))

        let status = app.staticTexts["inbox-status"].firstMatch
        XCTAssertTrue(status.waitForExistence(timeout: 30),
                      "the signed-in inbox never rendered the status group that holds the "
                      + "folded mechanism")
        let explain = app.buttons["row-explain"].firstMatch
        XCTAssertTrue(explain.waitForExistence(timeout: 10),
                      "the status row lost the control that holds its explanation")
        scrollUntilHittable(explain)

        XCTAssertGreaterThanOrEqual(explain.frame.height, Self.touchFloor,
                                    "the explain control is \(explain.frame.height)pt tall")
        XCTAssertGreaterThanOrEqual(explain.frame.width, Self.touchFloor,
                                    "the explain control is \(explain.frame.width)pt wide")
        XCTAssertFalse(explain.frame.intersects(status.frame),
                       "the explain control overlaps the status it belongs to: "
                       + "\(explain.frame) over \(status.frame)")

        // Folded means folded: absent, then present, then absent again.
        let explanation = app.staticTexts["row-explanation"].firstMatch
        XCTAssertFalse(explanation.exists, "the explanation is on the page rather than behind ⓘ")
        explain.tap()
        XCTAssertTrue(explanation.waitForExistence(timeout: 5),
                      "the explain control did not reveal its explanation")
        attach(name: "row-explain-open")
        explain.tap()
        XCTAssertTrue(waitForDisappearance(explanation),
                      "the explanation cannot be folded away again")
    }

    /// The Conversations caption and its Refresh are STACKED, and the control
    /// owns a real 44pt rectangle that does not sit on the paragraph.
    ///
    /// The defect this pins was found on a device, not in review: a paragraph
    /// beside a text action with a zero-minimum spacer rendered "onto a Mac"
    /// running straight into "Refresh". Checked in both shipped languages —
    /// Chinese has no spaces to break on, so it reaches the control sooner —
    /// and at an accessibility content size, where the paragraph is longest.
    func testTheConversationsCaptionAndRefreshNeverShareALine() throws {
        let cases: [(Language, String?, String)] = [
            (.english, nil, "en"),
            (.simplifiedChinese, nil, "zh"),
            (.english, "UICTContentSizeCategoryAccessibilityXXL", "en-axxxl"),
        ]
        for (language, contentSize, name) in cases {
            // Signed in: `DeviceInboxEntry.entry` draws Conversations only on
            // the `.surface` arm.
            launch(language: language, dark: false, contentSize: contentSize, signedIn: true)
            waitForShell(app)
            openSurface(Shell.deviceInbox, titled: language.title(of: Shell.deviceInbox))

            let refresh = app.buttons["inbox-devices-refresh"].firstMatch
            XCTAssertTrue(refresh.waitForExistence(timeout: 30),
                          "\(name): the Conversations group lost its refresh control")
            scrollUntilHittable(refresh)
            let explain = app.staticTexts["inbox-devices-explain"].firstMatch
            XCTAssertTrue(explain.exists,
                          "\(name): the Conversations caption is not addressable")

            let caption = explain.frame
            let action = refresh.frame
            XCTAssertFalse(action.intersects(caption),
                           "\(name): the refresh control overlaps the caption — "
                           + "\(action) over \(caption)")
            XCTAssertGreaterThanOrEqual(action.minY, caption.maxY - 1,
                                        "\(name): the control is beside the caption rather "
                                        + "than under it — caption \(caption), action \(action)")
            XCTAssertGreaterThanOrEqual(action.height, Self.touchFloor,
                                        "\(name): the refresh control is \(action.height)pt tall")
            XCTAssertGreaterThanOrEqual(action.width, Self.touchFloor,
                                        "\(name): the refresh control is \(action.width)pt wide")
            attach(name: "conversations-refresh-\(name)")
            app.terminate()
        }
    }

    /// **The verification label's contrast, measured as a differential on the
    /// SAME element rather than argued from where it sits.**
    ///
    /// The system audit rejected `Compare verification codes with the other
    /// device` on Nearby in both appearances. That label is a `Toggle`'s, drawn
    /// in the platform label colour on `Palette.cardBackground`, so a chromatic
    /// defect would have to be in a pairing that measures about 15:1 — but an
    /// identical frame in two appearances is only SUPPORTIVE of a positional
    /// cause, never proof of one.
    ///
    /// So this proves it by moving the element. iOS 26 fades scroll content
    /// approaching the navigation bar and the floating tab bar; at rest this
    /// label ends about 11pt above the bar, inside that band. The test records
    /// where it rests, scrolls it clear of BOTH bands, and requires the
    /// `.contrast` audit to stop naming it. If it still fails clear of the
    /// fades, the cause is the colour and this test says so instead.
    ///
    /// The before-capture is attached either way, so the rested position stays
    /// in the record rather than being scrolled out of the evidence.
    func testTheVerificationLabelPassesContrastClearOfTheScrollEdgeFades() throws {
        // The one gate in this file, and it is the API's rather than a
        // capture's: `performAccessibilityAudit` does not exist before iOS 17,
        // which is a runtime this proof cannot run on at all. Every other
        // failure here still fails rather than skips. The acceptance devices are
        // iOS 26, so this never fires on them.
        guard #available(iOS 17.0, *) else {
            throw XCTSkip("the system accessibility audit needs iOS 17")
        }
        for dark in [false, true] {
            let name = dark ? "dark" : "light"
            launch(language: .english, dark: dark)
            waitForShell(app)
            let title = Language.english.title(of: Shell.lanTransfer)
            openSurface(Shell.lanTransfer, titled: title)

            let toggle = app.descendants(matching: .any)["verify-toggle"].firstMatch
            XCTAssertTrue(toggle.waitForExistence(timeout: 20),
                          "\(name): the verification setting did not render")

            // BEFORE — the rested position the audit rejected, preserved.
            let rested = toggle.frame
            attach(name: "verify-label-\(name)-before-rested")

            let navBottom = app.navigationBars[title].firstMatch.frame.maxY
            let barTop = app.tabBars.firstMatch.exists
                ? app.tabBars.firstMatch.frame.minY
                : app.windows.firstMatch.frame.maxY
            XCTAssertGreaterThan(barTop, navBottom,
                                 "\(name): no usable band between the two bars to measure in")

            // Clear of both fades. The margin is the measured band: on a real
            // light capture one text role inside the fade read 2.10:1 and the
            // next line clear of it read 5.10:1, and the rested label above
            // cleared the bar by only about 11pt.
            let margin = Self.fadeMargin
            var clear = false
            for _ in 0..<10 {
                let frame = toggle.frame
                if frame.minY > navBottom + margin && frame.maxY < barTop - margin {
                    clear = true
                    break
                }
                if frame.maxY >= barTop - margin { app.swipeUp() } else { app.swipeDown() }
            }
            XCTAssertTrue(clear,
                          "\(name): the verification label could not be brought clear of both "
                          + "scroll-edge fades — rested \(rested), now \(toggle.frame), "
                          + "nav ends \(navBottom), bar starts \(barTop)")

            // AFTER — the same element, clear of both bands.
            let moved = toggle.frame
            attach(name: "verify-label-\(name)-after-clear")

            var contrastFailures: [String] = []
            try app.performAccessibilityAudit(for: .contrast) { issue in
                contrastFailures.append(issue.element?.label ?? "")
                return true
            }
            let record = XCTAttachment(string:
                "appearance=\(name)\nrested=\(rested)\nclear=\(moved)\n"
                + "navBottom=\(navBottom) barTop=\(barTop) margin=\(margin)\n"
                + "contrast failures clear of the fades:\n"
                + contrastFailures.joined(separator: "\n"))
            record.name = "verify-label-\(name)-differential"
            record.lifetime = .keepAlways
            add(record)

            XCTAssertFalse(contrastFailures.contains(Self.verificationLabel),
                           "\(name): the verification label still fails contrast at "
                           + "\(moved), clear of both scroll-edge fades — so the cause is the "
                           + "colour rather than the position, and the palette is what has to "
                           + "change. Failures here: \(contrastFailures)")
            app.terminate()
        }
    }

    // MARK: - the two shipped languages

    private enum Language {
        case english, simplifiedChinese

        var argument: String {
            switch self {
            case .english:           return "(en)"
            case .simplifiedChinese: return "(zh-Hans)"
            }
        }

        var locale: String {
            switch self {
            case .english:           return "en_US"
            case .simplifiedChinese: return "zh_CN"
            }
        }

        /// The navigation title each destination renders, in this language,
        /// from the maintained catalog.
        ///
        /// All six, not a pair: an arrival asserted in English on a Chinese
        /// launch either fails for the wrong reason or — where the copy happens
        /// to match — passes without having read anything.
        func title(of surface: Shell.Surface) -> String {
            switch (surface.id, self) {
            case ("lanTransfer", .english):                  return "Nearby"
            case ("lanTransfer", .simplifiedChinese):        return "附近设备"
            case ("crossNetworkTransfer", .english):         return "Cross-network"
            case ("crossNetworkTransfer", .simplifiedChinese): return "跨网络"
            case ("storedSend", .english):                   return "Share a link"
            case ("storedSend", .simplifiedChinese):         return "分享链接"
            case ("deviceInbox", .english):                  return "Device Inbox"
            case ("deviceInbox", .simplifiedChinese):        return "设备收件箱"
            case ("account", .english):                      return "Account"
            case ("account", .simplifiedChinese):            return "账户"
            default:
                XCTFail("no title is pinned for \(surface.id) in \(argument)")
                return surface.title
            }
        }

        /// The presented stored-link screen's own title.
        var storedReceiveTitle: String {
            switch self {
            case .english:           return "Open a link"
            case .simplifiedChinese: return "打开链接"
            }
        }
    }

    // MARK: - launching, and proving the launch took

    private func launch(language: Language,
                        dark: Bool,
                        contentSize: String? = nil,
                        signedIn: Bool = false,
                        extra: [String] = []) {
        app = XCUIApplication()
        var arguments = ["--relayium-ui-testing",
                         "-AppleLanguages", language.argument,
                         "-AppleLocale", language.locale]
        if dark {
            // The app's own launch seam rather than `XCUIDevice.appearance`,
            // which leaves this app's scene Light on the supported runtimes —
            // see `UITestMode.forcedAppearance`.
            arguments.append("--relayium-ui-testing-dark-appearance")
        }
        if signedIn {
            arguments.append("--relayium-ui-testing-signed-in")
        }
        if let contentSize {
            arguments += ["-UIPreferredContentSizeCategoryName", contentSize]
        }
        app.launchArguments = arguments + extra
        app.launch()
    }

    /// Walk the five browseable destinations and the presented stored-link
    /// screen, prove the language and the appearance from what rendered, and
    /// attach a window screenshot of each.
    private func captureEverySurface(language: Language,
                                     dark: Bool,
                                     contentSize: String? = nil,
                                     name: String) throws {
        launch(language: language, dark: dark, contentSize: contentSize)
        waitForShell(app)

        for surface in Shell.browseable {
            // The arrival assertion is the language check: each of the six
            // titles below is read from the maintained catalog, so a launch
            // that fell back to English cannot reach the capture.
            openSurface(surface, titled: language.title(of: surface))
            captureColumn(name: "\(name)-\(surface.id)")
        }

        // The appearance, read off the pixels rather than off the argument,
        // while a redesigned surface is on screen.
        try assertCapturedAppearance(dark: dark)
        app.terminate()

        // The one surface that is presented rather than browsed to. It changed
        // with the rest — one scaffold, one gutter — so it is captured with the
        // rest, through the launch seam that raises it.
        launch(language: language, dark: dark, contentSize: contentSize,
               extra: ["--relayium-ui-testing-valid-download-link",
                       "--relayium-ui-testing-open-stored-link"])
        let done = app.buttons["stored-receive-done"].firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 30),
                      "the stored-link screen did not come up as a sheet")
        XCTAssertTrue(app.navigationBars[language.storedReceiveTitle].waitForExistence(timeout: 10),
                      "the stored-link sheet did not render its \(language.argument) title")
        captureColumn(name: "\(name)-storedReceive")
        // Dismissed the way a reader dismisses it, so the capture also records
        // that the sheet's own exit still works over the redesigned page.
        scrollUntilHittable(done)
        done.tap()
        XCTAssertTrue(waitForDisappearance(done),
                      "the stored-link sheet could not be dismissed")
    }

    /// The captured appearance, measured as the mean luminance of the app's own
    /// window.
    ///
    /// A Dark launch of these screens is a near-black page under cards a step
    /// above it; a Light one is white. The two are far enough apart that one
    /// threshold separates them with no tuning, and measuring the image is the
    /// only check that cannot pass on a launch where the argument was accepted
    /// and the appearance never applied.
    private func assertCapturedAppearance(dark: Bool) throws {
        let luminance = try meanLuminance(of: app.screenshot())
        if dark {
            XCTAssertLessThan(luminance, 0.35,
                              "a dark-appearance launch rendered at \(luminance) mean "
                              + "luminance, which is a Light screen under a Dark name")
        } else {
            XCTAssertGreaterThan(luminance, 0.55,
                                 "a light-appearance launch rendered at \(luminance) mean "
                                 + "luminance")
        }
    }

    private func meanLuminance(of screenshot: XCUIScreenshot) throws -> Double {
        let image = try XCTUnwrap(UIImage(data: screenshot.pngRepresentation),
                                  "the screenshot could not be decoded")
        let cgImage = try XCTUnwrap(image.cgImage, "the screenshot carries no bitmap")
        // Downsampled to one small buffer: this is a mean, and decoding a 3×
        // device screen at full size to compute one number is the slowest
        // possible way to get it.
        let side = 32
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        let context = try XCTUnwrap(CGContext(
            data: &pixels, width: side, height: side, bitsPerComponent: 8,
            bytesPerRow: side * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
            "the screenshot could not be sampled")
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: side, height: side))
        var total = 0.0
        for index in stride(from: 0, to: pixels.count, by: 4) {
            let red = Double(pixels[index]) / 255
            let green = Double(pixels[index + 1]) / 255
            let blue = Double(pixels[index + 2]) / 255
            total += 0.2126 * red + 0.7152 * green + 0.0722 * blue
        }
        return total / Double(side * side)
    }

    // MARK: - driving, and attaching

    /// Open a destination by identifier on whichever shell is drawn, asserting
    /// the arrival on the title this language actually renders.
    ///
    /// The shared `open(_:in:)` asserts each destination's ENGLISH title, which
    /// is right for every other suite and wrong for the half of this one that
    /// launches in Chinese, so the assertion is parameterised here over the same
    /// identifier-addressed rows.
    private func openSurface(_ surface: Shell.Surface, titled expected: String) {
        let layout = waitForShell(app)
        let row: XCUIElement
        switch layout {
        case .compact:
            row = compactTabRow(surface, in: app)
        case .regular:
            revealSidebar(app)
            row = app.descendants(matching: .any)["sidebar-\(surface.id)"].firstMatch
        }
        XCTAssertTrue(row.waitForExistence(timeout: 15),
                      "the \(layout) shell has no \(surface.id) destination")
        row.tap()
        XCTAssertTrue(app.navigationBars[expected].waitForExistence(timeout: 15),
                      "\(surface.id) did not render its screen titled \"\(expected)\"")
    }

    /// The top of a destination and, for the ones long enough to have one, what
    /// is below the fold — the device and stored-file groups sit there.
    private func captureColumn(name: String) {
        attach(name: name)
        app.swipeUp()
        app.swipeUp()
        attach(name: "\(name)-scrolled")
        app.swipeDown()
        app.swipeDown()
    }

    /// One window screenshot, kept whether the test passed or failed — a capture
    /// suite whose attachments are deleted on success has captured nothing.
    private func attach(name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func waitForDisappearance(_ element: XCUIElement,
                                      timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !element.exists { return true }
            _ = element.waitForExistence(timeout: 0.25)
        }
        return !element.exists
    }

    /// Scroll until the element can actually be tapped, and FAIL if it never
    /// can. A loop that runs out of swipes and returns quietly hands the next
    /// line a control that is off screen, which then fails somewhere else.
    /// Scroll until an element is in the hierarchy at all. Separate from the
    /// hittable form: a row below the fold is the thing being looked for here,
    /// and it does not have to be tappable to be captured.
    private func scrollUntilExists(_ element: XCUIElement, maxSwipes: Int = 10) {
        for _ in 0..<maxSwipes where !element.exists {
            app.swipeUp()
        }
    }

    private func scrollUntilHittable(_ element: XCUIElement,
                                     maxSwipes: Int = 10,
                                     file: StaticString = #filePath,
                                     line: UInt = #line) {
        for _ in 0..<maxSwipes where !element.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(element.isHittable,
                      "\(element) never came within reach after \(maxSwipes) swipes",
                      file: file, line: line)
    }
}
