import XCTest

/// The in-app purchase surface, driven through the app a person actually uses.
///
/// **What this adds over the package suites.** `AppleSubscriptionModelTests`
/// drives the whole purchase policy against a fake store, and
/// `AppleSubscriptionPresentationTests` pins every sentence it can produce in
/// nine languages. Neither can say whether any of it reaches a screen: a card
/// that fails to build, a row that renders no price, a Subscribe button that is
/// never enabled, a busy state nobody can see, or — the one that would be a
/// review rejection rather than a bug — a web pricing link sitting beside an
/// in-app purchase.
///
/// **Why it runs against the direct target's debug build.** The purchase surface
/// is one card, injected as an app-scoped model; whether a build HAS one is
/// decided by target membership, and the account screen's web hand-off is gated
/// on that model's presence as well as on the distribution channel. So injecting
/// a model here exercises exactly the shared source the App Store target
/// compiles — the card, the rows, the copy layer, the orchestration, and the
/// real `AccountClient` against an in-process transport — without a signed App
/// Store build, a sandbox Apple ID or a product record in App Store Connect,
/// none of which acceptance can have.
///
/// What it deliberately does NOT claim: that the App Store target links StoreKit
/// and the direct one does not. That is a linkage fact about two binaries, and
/// `StoreKitLinkageTests` reads the project file for it.
final class SubscriptionUITests: XCTestCase {
    private var app: XCUIApplication!

    private var offlineLaunchArguments: [String] {
        ["--relayium-ui-testing", "-AppleLanguages", "(en)",
         "-AppleLocale", "en_US", "-SUEnableAutomaticChecks", "NO"]
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
    }

    override func tearDownWithError() throws {
        app?.terminate()
    }

    /// Relayium's work area is the process's largest window — the cross-version
    /// contract `AppShellUITests` established, because macOS 15 does not expose
    /// the SwiftUI scene id and auxiliary windows can appear first.
    private var mainWindow: XCUIElement {
        app.windows.allElementsBoundByIndex.max {
            $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
        } ?? app.windows.firstMatch
    }

    private func element(_ identifier: String, in window: XCUIElement) -> XCUIElement {
        window.descendants(matching: .any)[identifier].firstMatch
    }

    /// The whole text of a surface, for assertions about what is NOT on it.
    /// Built from labels and values because SwiftUI splits a card across many
    /// elements and macOS 15 drops identifiers from some of them.
    private func visibleText(in window: XCUIElement) -> String {
        window.descendants(matching: .any).allElementsBoundByIndex
            .map { "\($0.label) \($0.value.map { String(describing: $0) } ?? "")" }
            .joined(separator: "\n")
    }

    /// The sidebar row, addressed the way the product identifies it, with the
    /// same spatial fallback the other suites use for macOS 15.
    private func sidebarAccount(in window: XCUIElement) -> XCUIElement {
        let stable = element("sidebar-account", in: window)
        if stable.exists { return stable }
        let dividing = window.frame.midX
        let visible = NSPredicate(format: "label == %@ OR value == %@", "Account", "Account")
        return window.descendants(matching: .any).matching(visible)
            .allElementsBoundByIndex.first { $0.frame.midX < dividing } ?? stable
    }

    /// Launch signed in with the purchase surface injected, and land on Account.
    @discardableResult
    private func openAccount(_ extraArguments: [String] = []) -> XCUIElement {
        app.launchArguments = offlineLaunchArguments
            + ["--relayium-ui-testing-signed-in", "--relayium-ui-testing-subscriptions"]
            + extraArguments
        app.launch()
        // A hosted runner can restore the last deliberate closed-window state;
        // Relayium stays alive in it by design, so process launch is not proof
        // the work window is visible. Recover the way a person does.
        if !app.windows.allElementsBoundByIndex.contains(where: {
            $0.frame.width >= 800 && $0.frame.height >= 500
        }) {
            let statusItem = app.statusItems.firstMatch
            XCTAssertTrue(statusItem.waitForExistence(timeout: 5),
                          "the resident app has no menu-bar recovery surface")
            statusItem.click()
            app.typeKey("o", modifierFlags: [])
        }
        let window = mainWindow
        XCTAssertTrue(window.waitForExistence(timeout: 20), "the product window did not open")
        let account = sidebarAccount(in: window)
        XCTAssertTrue(account.waitForExistence(timeout: 10), "the account destination is unreachable")
        account.click()
        XCTAssertTrue(window.staticTexts["person@example.com"].waitForExistence(timeout: 20),
                      "the signed-in account did not render")
        return window
    }

    // MARK: - the offers

    /// **The catalog reaches the screen, joined the way it is meant to be.**
    ///
    /// The tier NAME comes from Relayium's server and the PRICE comes from the
    /// store, and both halves have to be on the row: a name with no price is
    /// unbuyable, and a price with no tier is meaningless. The per-period wording
    /// is asserted too, because a subscription row that states an amount without
    /// a period is a false statement about what the user is agreeing to pay.
    func testTheServerCatalogAndTheStorePricesRenderAsPurchasableRows() {
        let window = openAccount()

        XCTAssertTrue(window.staticTexts["Subscription"].waitForExistence(timeout: 20),
                      "the purchase surface never appeared")
        let monthly = element("subscription-buy-uitest.subscription.month", in: window)
        XCTAssertTrue(monthly.waitForExistence(timeout: 20),
                      "the monthly product from the server's catalog is not purchasable")
        XCTAssertTrue(element("subscription-buy-uitest.subscription.year", in: window).exists,
                      "the yearly product from the server's catalog is not purchasable")
        XCTAssertTrue(monthly.isEnabled,
                      "an eligible account cannot press Subscribe")

        let text = visibleText(in: window)
        XCTAssertTrue(text.contains("Pro"), "the row does not name the tier the server mapped")
        XCTAssertTrue(text.contains("US$4.99") && text.contains("US$49.99"),
                      "the store's own prices are not on the rows: \(text)")
        XCTAssertTrue(text.contains("per month") && text.contains("per year"),
                      "a subscription price is shown without its billing period")
        // Restore is always offered: it is the control a user reaches for when
        // something has already gone wrong.
        XCTAssertTrue(element("subscription-restore", in: window).exists,
                      "there is no way to restore an earlier purchase")
    }

    /// **No web pricing call to action beside an in-app purchase.**
    ///
    /// This is the App Store rule, and it is the one failure on this screen that
    /// would be a rejection rather than a defect. The negative is asserted from
    /// the whole surface's text rather than from one control, so a link that
    /// moved elsewhere on the card still fails.
    func testAPurchasingBuildOffersNoWebPricingCallToAction() {
        let window = openAccount()
        XCTAssertTrue(window.staticTexts["Subscription"].waitForExistence(timeout: 20))

        XCTAssertEqual(window.buttons.matching(
            NSPredicate(format: "label == %@", "Manage plan")).count, 0,
                       "the purchasing build still offers the website's plan page")
        XCTAssertFalse(visibleText(in: window).contains("Manage plan"),
                       "a web plan hand-off is still on the account screen")
    }

    /// **The privacy policy and the terms are visibly on the purchase surface.**
    ///
    /// The one requirement on this screen that is checked before the app is even
    /// run: an auto-renewing subscription has to be sold beside a functional
    /// link to both documents. `StoreKitLinkageTests` reads the card's source for
    /// the destinations; this is the half that source cannot claim — that the
    /// links reach a rendered screen, carry words rather than a fallen-through
    /// key, and are hittable.
    func testTheLegalLinksAreVisibleBesideThePurchase() {
        let window = openAccount()
        XCTAssertTrue(window.staticTexts["Subscription"].waitForExistence(timeout: 20))

        for identifier in ["subscription-privacy", "subscription-terms"] {
            let link = element(identifier, in: window)
            XCTAssertTrue(link.waitForExistence(timeout: 20),
                          "\(identifier) is not on the purchase surface")
            XCTAssertTrue(link.isHittable, "\(identifier) is on screen but cannot be clicked")
        }
        // The words themselves, so a link that rendered its own key still fails.
        // Not clicked: following it would hand the run to a browser, and what is
        // being asserted is that the surface offers them.
        let text = visibleText(in: window)
        XCTAssertTrue(text.contains("Privacy Policy"),
                      "the privacy link does not name the policy: \(text)")
        XCTAssertTrue(text.contains("Terms of Service"),
                      "the terms link does not name the terms: \(text)")
    }

    /// A purchase runs end to end through the real orchestration: the store
    /// delivers, the server accepts, the transaction is finished, the session
    /// reloads, and the surface says so.
    func testAPurchaseReachesAConfirmedSubscription() {
        let window = openAccount()
        let monthly = element("subscription-buy-uitest.subscription.month", in: window)
        XCTAssertTrue(monthly.waitForExistence(timeout: 20))
        monthly.click()

        let notice = element("subscription-notice", in: window)
        XCTAssertTrue(notice.waitForExistence(timeout: 20),
                      "a completed purchase reported nothing to the user")
        XCTAssertTrue(visibleText(in: window).contains("Your subscription is active"),
                      "the purchase completed without saying so")
        XCTAssertEqual(element("subscription-failure", in: window).exists, false,
                       "an accepted purchase rendered a failure")
    }

    /// **The server's refusal is rendered, and the control is genuinely
    /// disabled.** A user already paying through the web must not be sold a
    /// second subscription through a provider that cannot see the first, and
    /// "disabled" has to be true of the button rather than of a comment.
    func testAnAccountBilledOnTheWebIsToldWhyItCannotBuyHere() {
        let window = openAccount(["--relayium-ui-testing-subscription-blocked"])

        XCTAssertTrue(element("subscription-blocked", in: window).waitForExistence(timeout: 20),
                      "a blocked account is not told why it cannot subscribe")
        XCTAssertTrue(visibleText(in: window).contains("relayium.com"),
                      "the refusal does not say where the subscription is managed")
        let monthly = element("subscription-buy-uitest.subscription.month", in: window)
        XCTAssertTrue(monthly.waitForExistence(timeout: 10))
        XCTAssertFalse(monthly.isEnabled,
                       "a blocked account can still press Subscribe")
        // Restore stays available: it submits what this Apple ID already owns,
        // and a browser session must not strand a purchase already paid for.
        XCTAssertTrue(element("subscription-restore", in: window).isEnabled,
                      "a blocked account cannot restore an existing purchase")
    }
}
