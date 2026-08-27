import XCTest
#if canImport(UserNotifications)
import UserNotifications
#endif
@testable import RelayiumAppKit

/// Denied notification authorization, from the platform status through to the
/// sentence a person reads.
///
/// The defect this covers was silence. On an installed build whose notification
/// authorization had been refused, a delivery landed on disk correctly and the
/// banner was discarded with nothing said anywhere — no status, no warning, and
/// no way to change it from inside the app. Every assertion below is one link in
/// the chain that now ends that silence.
final class InboxNotificationPermissionTests: XCTestCase {

    // MARK: - the platform mapping

    #if canImport(UserNotifications)
    /// The three statuses that are not a problem, and the one that is.
    ///
    /// `provisional` sits with `authorized` on purpose: a provisional banner is
    /// still DELIVERED, quietly, to Notification Centre. Telling that user their
    /// notifications are off would be false, and the button offered with it would
    /// send them to fix something that is not broken.
    func testTheAuthorizationStatusesMapToWhatTheUserIsActuallyGetting() {
        XCTAssertEqual(InboxNotificationPermission(authorizationStatus: .notDetermined),
                       .notDetermined)
        XCTAssertEqual(InboxNotificationPermission(authorizationStatus: .authorized), .allowed)
        XCTAssertEqual(InboxNotificationPermission(authorizationStatus: .provisional), .allowed)
        XCTAssertEqual(InboxNotificationPermission(authorizationStatus: .denied), .denied)
    }

    /// **A status this build cannot name reads as denied, not as allowed.**
    ///
    /// The pairing that makes it truthful rather than merely cautious:
    /// `InboxNotifier` switches over this same value and posts NOTHING for
    /// `denied`, so an unrecognised status produces a Mac that shows no banner and
    /// a pane that says no banner will be shown. Mapping it to `allowed` would
    /// reproduce the original defect exactly — a discarded banner, and a surface
    /// claiming everything is fine.
    ///
    /// Driven through `rawValue` because a future macOS is precisely what this
    /// arm is for, and no enum case exists yet to write it with.
    func testAnUnrecognisedStatusIsTreatedAsDeniedRatherThanAsWorking() {
        for raw in [4, 17, 99] {
            guard let status = UNAuthorizationStatus(rawValue: raw) else {
                return XCTFail("UNAuthorizationStatus refused raw value \(raw)")
            }
            XCTAssertEqual(InboxNotificationPermission(authorizationStatus: status), .denied,
                           "status \(raw) was treated as a working notification path")
        }
    }

    /// Every status the SDK defines today produces a permission, and none of them
    /// produces `unmeasured` — which means "nothing has asked yet" and would be a
    /// lie coming back from an answer.
    func testEveryDefinedStatusProducesAMeasuredPermission() {
        for raw in 0...3 {
            guard let status = UNAuthorizationStatus(rawValue: raw) else { continue }
            XCTAssertNotEqual(InboxNotificationPermission(authorizationStatus: status),
                              .unmeasured, "status \(raw) reported as unmeasured")
        }
    }
    #endif

    // MARK: - what is worth telling a person

    /// Exactly one of the four states is an attention state.
    ///
    /// Stated over `allCases` rather than as three separate assertions, so a case
    /// added later has to make a decision here instead of silently defaulting to
    /// "not worth mentioning".
    func testOnlyDeniedIsSomethingToTellThePersonAbout() {
        let attention = InboxNotificationPermission.allCases.filter(\.needsAttention)
        XCTAssertEqual(attention, [.denied])
    }

    /// Nothing is rendered for the three states that are not a problem.
    ///
    /// `unmeasured` matters most here: it is the value every launch starts on, so
    /// a notice produced for it would put "notifications are off" in front of
    /// every user for the interval before the first answer comes back.
    func testNoNoticeIsRenderedUntilThereIsSomethingWrong() {
        for permission in [InboxNotificationPermission.unmeasured, .notDetermined, .allowed] {
            XCTAssertNil(InboxNotificationPermissionPresentation.notice(for: permission),
                         "\(permission.rawValue) rendered a warning")
        }
    }

    /// The denied notice carries all three parts, and none of them is empty.
    func testTheDeniedNoticeSaysWhatIsWrongExplainsItAndOffersAnAction() {
        guard let notice = InboxNotificationPermissionPresentation.notice(for: .denied) else {
            return XCTFail("a denied Mac renders nothing at all")
        }
        XCTAssertFalse(notice.title.isEmpty)
        XCTAssertFalse(notice.explanation.isEmpty)
        XCTAssertFalse(notice.actionLabel.isEmpty)
        XCTAssertNotEqual(notice.title, notice.explanation)
    }

    /// **The assertion the whole surface exists for.**
    ///
    /// A warning that said only "notifications are off" would be true and would
    /// still be a product failure: a person reading it in the Device Inbox pane
    /// reasonably concludes the Device Inbox has stopped working, when in fact
    /// every file sent to this Mac is still being received, decrypted and written
    /// to their folder. The explanation has to say so, in every language, and the
    /// two verbs are checked separately because a translation that keeps only one
    /// of them leaves the other claim unmade.
    func testEveryLanguagePromisesThatReceivingAndSavingStillWork() {
        // The seven archived languages' rows left with their catalogs. Both
        // shipped languages keep their own word for each verb, which is what
        // makes this stronger than a non-empty check.
        let receiving: [AppLanguage: [String]] = [.en: ["received"], .zh: ["接收"]]
        let saving: [AppLanguage: [String]] = [.en: ["saved"], .zh: ["保存"]]
        for language in AppLanguage.allCases {
            guard let notice = InboxNotificationPermissionPresentation
                .notice(for: .denied, language: language) else {
                return XCTFail("\(language.rawValue) renders no denied notice")
            }
            for word in receiving[language] ?? [] {
                XCTAssertTrue(notice.explanation.contains(word),
                              "\(language.rawValue) does not say deliveries are still received")
            }
            for word in saving[language] ?? [] {
                XCTAssertTrue(notice.explanation.contains(word),
                              "\(language.rawValue) does not say deliveries are still saved")
            }
        }
    }

    /// The notice is translated everywhere rather than falling back to English.
    func testTheDeniedNoticeIsTranslatedInEveryLanguage() {
        var titles: Set<String> = []
        var actions: Set<String> = []
        for language in AppLanguage.allCases {
            guard let notice = InboxNotificationPermissionPresentation
                .notice(for: .denied, language: language) else {
                return XCTFail("\(language.rawValue) renders no denied notice")
            }
            titles.insert(notice.title)
            actions.insert(notice.actionLabel)
        }
        XCTAssertEqual(titles.count, AppLanguage.allCases.count,
                       "two languages share the banner-blocked headline")
        XCTAssertEqual(actions.count, AppLanguage.allCases.count,
                       "two languages share the System Settings action")
    }

    /// The refusal of the action is its own sentence, in every language, and is
    /// never confused with the state that produced the button.
    func testTheUnopenableSettingsRefusalIsItsOwnTranslatedSentence() {
        for language in AppLanguage.allCases {
            let refusal = InboxSettingsErrorCopy.message(.notificationSettingsUnavailable,
                                                        language: language)
            XCTAssertFalse(refusal.isEmpty)
            let notice = InboxNotificationPermissionPresentation.notice(for: .denied,
                                                                        language: language)
            XCTAssertNotEqual(refusal, notice?.title,
                              "\(language.rawValue) reuses the state's headline as the refusal")
            for other in InboxSettingsError.allCases where other != .notificationSettingsUnavailable {
                XCTAssertNotEqual(refusal,
                                  InboxSettingsErrorCopy.message(other, language: language),
                                  "\(language.rawValue) gives two refusals the same sentence")
            }
        }
    }

    // MARK: - the route to THIS app's row

    /// **The recovery selects an app, not just a pane.**
    ///
    /// The defect this pins was found on an installed build: the bare pane URL
    /// re-opened System Settings on whichever notification row it was last left
    /// on — Google Chrome's, in the observed case — while the button claimed to
    /// have opened Relayium's. The whole URL is asserted rather than a fragment
    /// of it, because the exact string is what was verified against macOS 26.6:
    /// the scheme, the pane, the `id` parameter name and the identifier.
    func testTheRouteNamesTheAppWhoseNotificationRowMustBeSelected() {
        XCTAssertEqual(
            InboxNotificationSettingsRoute.url(forBundleIdentifier: "com.relayium.mac")?
                .absoluteString,
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
                + "?id=com.relayium.mac")
    }

    /// **Two apps get two different rows.**
    ///
    /// The assertion a route that dropped the binding could not survive: a
    /// constant URL — the shipped defect — passes any check that only looks for
    /// the pane identifier, and fails this one, because it hands both apps the
    /// same destination.
    func testADifferentAppRoutesToADifferentRow() {
        let relayium = InboxNotificationSettingsRoute.url(forBundleIdentifier: "com.relayium.mac")
        let chrome = InboxNotificationSettingsRoute.url(forBundleIdentifier: "com.google.Chrome")
        XCTAssertNotNil(relayium)
        XCTAssertNotNil(chrome)
        XCTAssertNotEqual(relayium, chrome,
                          "the route ignores which app it was asked for")
        XCTAssertTrue(relayium?.absoluteString.hasSuffix("?id=com.relayium.mac") ?? false)
        XCTAssertTrue(chrome?.absoluteString.hasSuffix("?id=com.google.Chrome") ?? false)
    }

    /// A build that cannot name itself gets NO url, and the seam then reports the
    /// refusal the pane renders as "open it yourself".
    ///
    /// The tempting fallback — the bare pane — is exactly the defect, and it
    /// would be applied in the one case where the app knows least about where it
    /// is about to send someone.
    func testABuildThatCannotNameItselfGetsNoRouteRatherThanTheBarePane() {
        XCTAssertNil(InboxNotificationSettingsRoute.url(forBundleIdentifier: nil))
        XCTAssertNil(InboxNotificationSettingsRoute.url(forBundleIdentifier: ""))
    }

    /// **Nothing but a bundle identifier can become a route.**
    ///
    /// The seam takes no argument, so nothing from a delivery can reach it today.
    /// This keeps that closed by construction rather than by the care of whoever
    /// writes the next call site: a path, a file name, a second query parameter
    /// or a fragment is refused outright instead of being escaped into something
    /// `NSWorkspace` would accept.
    func testNothingThatIsNotABundleIdentifierCanBecomeARoute() {
        let hostile = [
            "com.relayium.mac?id=com.google.Chrome",   // a second selection
            "com.relayium.mac&id=com.google.Chrome",   // the same, appended
            "com.relayium.mac#Notifications",          // a fragment
            "/Users/someone/Downloads/report.pdf",     // a received path
            "report from work.pdf",                    // a received file name
            "com.relayium.mac%2F..%2Fother",           // a pre-escaped traversal
            "com.relayium.mac/../other",               // the same, unescaped
            "com..relayium.mac",                       // an empty component
            ".com.relayium.mac",
            "com.relayium.mac.",
            "com.relayium.mać",                        // non-ASCII
            "com.relayium.mac\n",                      // a trailing control character
            " com.relayium.mac",
        ]
        for identifier in hostile {
            XCTAssertNil(InboxNotificationSettingsRoute.url(forBundleIdentifier: identifier),
                         "\(identifier) was accepted as an app identifier")
        }
    }

    /// The shapes a real identifier legitimately takes are still routable, so the
    /// guard above cannot be satisfied by refusing everything.
    func testOrdinaryBundleIdentifiersAreStillRoutable() {
        for identifier in ["com.relayium.mac", "com.relayium.mac.Share",
                           "com.apple.mail", "com-relayium.app2"] {
            XCTAssertNotNil(InboxNotificationSettingsRoute.url(forBundleIdentifier: identifier),
                            "\(identifier) is a valid bundle identifier and was refused")
        }
    }

    /// The notice never names a file, a path or an account. The Device Inbox pane
    /// can be open on a shared screen, and this section is rendered by the same
    /// rule as every other one in it.
    func testTheNoticeNamesNothingAboutWhatWasReceived() {
        for language in AppLanguage.allCases {
            guard let notice = InboxNotificationPermissionPresentation
                .notice(for: .denied, language: language) else { continue }
            let all = notice.title + notice.explanation + notice.actionLabel
            XCTAssertFalse(all.contains("/"), "\(language.rawValue) renders a path separator")
            XCTAssertFalse(all.contains("@"), "\(language.rawValue) renders an address")
        }
    }
}
