import AppKit
import XCTest

/// **Window-only evidence for the reference layout: every browseable
/// destination and Settings, in both languages, both appearances and at both
/// ends of the supported window size.**
///
/// A screenshot on its own proves nothing: a capture run that quietly fell back
/// to English, opened in the machine's own appearance, never resized, or never
/// left the first destination would produce a folder of plausible attachments
/// and no finding. So every capture asserts what it claims to be before it
/// attaches anything:
///
///  - **the language**, from the rendered sidebar row rather than from the
///    argument that was passed;
///  - **the appearance**, from the pixels of the captured window — the argument
///    domain is what the app reads, and a value that did not take effect is
///    invisible in the launch arguments and obvious in the mean luminance;
///  - **the size**, from the window's own frame after the drag, including the
///    shipped 860×560 floor actually clamping a smaller request;
///  - **the destination**, from the detail surface's own identifier, so a row
///    that did not navigate cannot be captured as the screen it names.
///
/// Missing bitmap evidence FAILS. A capture suite that skipped would report
/// green while supplying nothing, which is the one outcome a visual gate must
/// not produce.
///
/// This class launches the product, so it is run deliberately and never while
/// somebody is using the installed app.
final class AppShellLayoutCaptureTests: XCTestCase {
    private var app: XCUIApplication!

    /// The shipped minimum, and a size with room for a wide window to prove the
    /// content column stays at its measure instead of stretching.
    private static let minimumSize = CGSize(width: 860, height: 560)
    private static let comfortableSize = CGSize(width: 1280, height: 820)

    /// Window geometry settles a frame or two after a drag, and a screenshot
    /// taken inside that window captures the old size.
    private static let settleTimeout: TimeInterval = 5

    /// Every browseable destination, by the `MacSurface` raw value the product
    /// identifies its row and its detail surface by. Identifiers rather than
    /// titles, because this suite renders two languages and a title match would
    /// only ever work in one of them.
    ///
    /// **Five rows, and Open a link is not one of them**: that destination is
    /// reached from a link the OS hands the app, so it has no row to click and
    /// is out of a sidebar walk's scope.
    private static let surfaces = ["lanTransfer", "crossNetworkTransfer",
                                   "storedSend", "deviceInbox", "account"]

    private struct Appearance {
        let dark: Bool
        var name: String { dark ? "dark" : "light" }
    }

    private struct Language {
        let code: String
        let locale: String
        /// What the LAN Transfer row must read. Asserted so a fallback to
        /// English cannot pass as a localized capture.
        let lanTransfer: String
    }

    private static let languages = [
        Language(code: "en", locale: "en_US", lanTransfer: "LAN Transfer"),
        Language(code: "zh-Hans", locale: "zh-Hans", lanTransfer: "局域网传输"),
    ]

    override func tearDownWithError() throws {
        app?.terminate()
        app = nil
    }

    // MARK: - the matrix

    /// One launch per language/appearance/size, and inside each the whole
    /// sidebar plus Settings — so eight launches produce every surface rather
    /// than eight copies of the first one.
    func testEverySurfaceRendersInBothLanguagesAppearancesAndSizes() throws {
        for language in Self.languages {
            for appearance in [Appearance(dark: false), Appearance(dark: true)] {
                for (size, sizeName) in [(Self.minimumSize, "minimum"),
                                         (Self.comfortableSize, "comfortable")] {
                    let cell = "\(language.code)-\(appearance.name)-\(sizeName)"

                    launch(language: language, appearance: appearance)
                    let window = productWindow()
                    XCTAssertTrue(window.waitForExistence(timeout: 20),
                                  "\(cell) produced no window")

                    let row = sidebarRow("lanTransfer", in: window)
                    XCTAssertTrue(row.waitForExistence(timeout: 15),
                                  "\(cell) produced a window with no LAN Transfer destination")
                    XCTAssertEqual((row.value as? String) ?? row.label, language.lanTransfer,
                                   "\(cell) did not render in the language it was launched in")

                    resize(window, to: size)
                    let measured = settledFrame(of: window, approaching: size)
                    XCTAssertEqual(measured.width, size.width, accuracy: 4,
                                   "\(cell) is \(measured.width)pt wide")
                    XCTAssertEqual(measured.height, size.height, accuracy: 4,
                                   "\(cell) is \(measured.height)pt tall")

                    for surface in Self.surfaces {
                        try capture(surface: surface, in: window,
                                    cell: cell, appearance: appearance)
                    }
                    try captureSettings(cell: cell, appearance: appearance)
                }
            }
        }
    }

    /// The window cannot be dragged below what the shell asks for, and the
    /// clamp is the product's promise rather than this test's arithmetic.
    func testTheWindowClampsToItsShippedMinimum() {
        launch(language: Self.languages[0], appearance: Appearance(dark: false))
        let window = productWindow()
        XCTAssertTrue(window.waitForExistence(timeout: 20))

        resize(window, to: CGSize(width: 600, height: 380))
        let measured = settledFrame(of: window, approaching: Self.minimumSize)
        XCTAssertEqual(measured.width, Self.minimumSize.width, accuracy: 4,
                       "the window went narrower than the shell's minimum")
        XCTAssertEqual(measured.height, Self.minimumSize.height, accuracy: 4,
                       "the window went shorter than the shell's minimum")
    }

    // MARK: - capturing one surface

    /// Navigate, prove the DETAIL surface arrived, then attach the window.
    ///
    /// The detail identifier rather than the row is what is asserted: a click
    /// that selected a row without changing the screen would otherwise be
    /// captured as the destination it never opened.
    private func capture(surface: String, in window: XCUIElement,
                         cell: String, appearance: Appearance) throws {
        let row = sidebarRow(surface, in: window)
        XCTAssertTrue(row.waitForExistence(timeout: 10),
                      "\(cell) has no sidebar row for \(surface)")
        row.click()

        let detail = window.descendants(matching: .any)["destination-\(surface)"].firstMatch
        XCTAssertTrue(detail.waitForExistence(timeout: 15),
                      "\(cell) clicked \(surface) and did not open its detail surface")

        try attach(window.screenshot(), named: "\(surface)-\(cell)",
                   appearance: appearance, cell: "\(surface)-\(cell)")
    }

    /// Settings is a SECOND window rather than a replacement, so it is captured
    /// as its own window and the shell is left open behind it.
    private func captureSettings(cell: String, appearance: Appearance) throws {
        let appMenu = app.menuBarItems.element(boundBy: 1)
        XCTAssertTrue(appMenu.waitForExistence(timeout: 10),
                      "\(cell) has no application menu to open Settings from")
        appMenu.click()
        let item = settingsItem(in: appMenu)
        guard item.waitForExistence(timeout: 5) else {
            appMenu.typeKey(.escape, modifierFlags: [])
            XCTFail("\(cell) has no Settings item; a Settings scene creates one")
            return
        }
        item.click()

        let settings = settingsWindow()
        XCTAssertTrue(settings.waitForExistence(timeout: 15),
                      "\(cell) opened no Settings window")
        try attach(settings.screenshot(), named: "settings-\(cell)",
                   appearance: appearance, cell: "settings-\(cell)")
        settings.buttons[XCUIIdentifierCloseWindow].click()
    }

    /// The Settings item is `Settings…` in English and 设置… in Simplified
    /// Chinese; matched on the prefix the two share with every localization of
    /// an AppKit Settings item — the ellipsis — rather than on either word.
    private func settingsItem(in menu: XCUIElement) -> XCUIElement {
        let ellipsis = NSPredicate(format: "label ENDSWITH %@", "…")
        return menu.menuItems.matching(ellipsis).element(boundBy: 0)
    }

    /// The smallest window the process owns once Settings is up: the shell is
    /// at least 860×560, and the Settings scene is narrower than that.
    private func settingsWindow() -> XCUIElement {
        app.windows.allElementsBoundByIndex
            .filter { $0.frame.width > 0 && $0.frame.width < Self.minimumSize.width }
            .min { $0.frame.width < $1.frame.width } ?? app.windows.firstMatch
    }

    /// Measure the appearance from the bitmap, then keep the bitmap.
    ///
    /// **Both halves fail rather than skip.** A window that produced no
    /// readable bitmap has supplied no visual evidence, and a suite that
    /// reported that as a skip would be green with nothing in it.
    private func attach(_ shot: XCUIScreenshot, named name: String,
                        appearance: Appearance, cell: String) throws {
        let luminance = try meanLuminance(of: shot, cell: cell)
        if appearance.dark {
            XCTAssertLessThan(luminance, 0.35, "\(cell) rendered in a light appearance")
        } else {
            XCTAssertGreaterThan(luminance, 0.6, "\(cell) rendered in a dark appearance")
        }

        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    // MARK: - launching, navigating and sizing

    private func launch(language: Language, appearance: Appearance) {
        app?.terminate()
        app = XCUIApplication()
        app.launchArguments = [
            "--relayium-ui-testing", "--relayium-ui-testing-file-code",
            "-AppleLanguages", "(\(language.code))",
            "-AppleLocale", language.locale,
            // Read by AppKit out of the argument domain, so it changes this
            // process's appearance and never the machine's.
            "-AppleInterfaceStyle", appearance.dark ? "Dark" : "Light",
            "-SUEnableAutomaticChecks", "NO",
        ]
        app.launch()
        ensureProductWindowIsOpen()
    }

    /// A fresh runner may show Sparkle's one-time consent, and a reused runner
    /// may restore a closed-window state. Resolve either through the controls a
    /// person actually uses before any capture.
    private func ensureProductWindowIsOpen() {
        let sparkleDecline = app.buttons["Don’t Check"]
        if sparkleDecline.waitForExistence(timeout: 2) { sparkleDecline.click() }
        if app.windows.allElementsBoundByIndex.contains(where: {
            $0.frame.width >= 800 && $0.frame.height >= 500
        }) { return }

        let statusItem = app.statusItems.firstMatch
        XCTAssertTrue(statusItem.waitForExistence(timeout: 5),
                      "the resident app has no menu-bar recovery surface")
        statusItem.click()
        app.typeKey("o", modifierFlags: [])
        XCTAssertTrue(productWindow().waitForExistence(timeout: 10),
                      "the menu-bar recovery action did not restore the product window")
    }

    /// Sparkle and AppKit may create auxiliary windows before the shell, so the
    /// product window is selected by geometry — the largest one — exactly as
    /// `AppShellUITests` does.
    private func productWindow() -> XCUIElement {
        app.windows.allElementsBoundByIndex.max {
            $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
        } ?? app.windows.firstMatch
    }

    /// The stable identifier first; on a system that drops a combined List
    /// row's identifier, the row at that position in the sidebar HALF of the
    /// window — never the detail side, which carries the same words.
    private func sidebarRow(_ surface: String, in window: XCUIElement) -> XCUIElement {
        let stable = window.descendants(matching: .any)["sidebar-\(surface)"].firstMatch
        if stable.exists { return stable }
        guard let index = Self.surfaces.firstIndex(of: surface) else { return stable }
        let dividingX = window.frame.midX
        let sidebarRows = window.descendants(matching: .staticText).allElementsBoundByIndex
            .filter { $0.frame.midX < dividingX && $0.frame.height > 0 }
            .sorted { $0.frame.minY < $1.frame.minY }
        return index < sidebarRows.count ? sidebarRows[index] : stable
    }

    /// Drag the bottom-trailing corner by the difference, which is the only
    /// resize a UI test can perform: there is no API that sets a window's size,
    /// and asking for one would prove nothing about the shell's own floor.
    private func resize(_ window: XCUIElement, to size: CGSize) {
        let current = window.frame
        let corner = window.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 1))
        corner.press(forDuration: 0.2,
                     thenDragTo: corner.withOffset(
                        CGVector(dx: size.width - current.width,
                                 dy: size.height - current.height)))
    }

    /// The frame once it stops changing, or the last one read before the
    /// timeout. Polling rather than sleeping, so a fast machine does not pay
    /// for a slow one's settle time.
    private func settledFrame(of window: XCUIElement,
                              approaching target: CGSize) -> CGRect {
        let deadline = Date().addingTimeInterval(Self.settleTimeout)
        var frame = window.frame
        while Date() < deadline {
            if abs(frame.width - target.width) <= 4, abs(frame.height - target.height) <= 4 {
                return frame
            }
            usleep(150_000)
            frame = window.frame
        }
        return frame
    }

    /// The mean luminance of the captured window, on a coarse grid.
    ///
    /// A whole-window average is the right measure: the two appearances are
    /// near-inverses of each other, so the separation is enormous and no
    /// threshold has to be tuned to particular content.
    private func meanLuminance(of screenshot: XCUIScreenshot, cell: String) throws -> Double {
        guard let data = screenshot.image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: data) else {
            XCTFail("\(cell) produced no bitmap, so it is not visual evidence")
            throw CaptureFailure.noBitmap
        }
        let columns = 32
        let rows = 32
        var total = 0.0
        var samples = 0
        for column in 0..<columns {
            for row in 0..<rows {
                let x = bitmap.pixelsWide * column / columns
                let y = bitmap.pixelsHigh * row / rows
                guard let colour = bitmap.colorAt(x: x, y: y)?
                    .usingColorSpace(.sRGB) else { continue }
                total += 0.2126 * Double(colour.redComponent)
                    + 0.7152 * Double(colour.greenComponent)
                    + 0.0722 * Double(colour.blueComponent)
                samples += 1
            }
        }
        guard samples > 0 else {
            XCTFail("\(cell) produced no readable pixels, so it is not visual evidence")
            throw CaptureFailure.noPixels
        }
        return total / Double(samples)
    }

    private enum CaptureFailure: Error {
        case noBitmap
        case noPixels
    }
}
