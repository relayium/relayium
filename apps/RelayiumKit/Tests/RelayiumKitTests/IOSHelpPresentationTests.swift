import XCTest
@testable import RelayiumAppKit
@testable import RelayiumShareKit
import RelayiumKit

/// A20: the iOS help table — `HelpPresentation.topic(forIOS:)`.
///
/// Two kinds of assertion. The first half is the shape the macOS table is held
/// to (every browseable destination answers all six questions, in both
/// maintained languages, with no shared or placeholder strings). The second
/// half is what makes this an iOS table rather than the Mac one relabelled:
/// each network, privacy and billing sentence is pinned to the source that
/// makes it true on iOS, so a behaviour change that falsifies a sentence fails
/// here instead of shipping as confident, wrong help.
final class IOSHelpPresentationTests: XCTestCase {

    private static func keys(of topic: HelpTopic) -> [L10nKey] {
        [topic.purpose] + topic.steps
            + [topic.boundary, topic.destination, topic.failure, topic.recovery]
    }

    private func topic(_ surface: IOSSurface) throws -> HelpTopic {
        try XCTUnwrap(HelpPresentation.topic(forIOS: surface),
                      "\(surface.rawValue) has no iOS help")
    }

    private func en(_ key: L10nKey) -> String { L10n.t(key, language: .en) }
    private func zh(_ key: L10nKey) -> String { L10n.t(key, language: .zh) }

    // MARK: - shape

    func testEveryBrowseableIOSDestinationHasHelpAndTheSheetHasNone() throws {
        XCTAssertEqual(IOSSurface.browseable.count, 5)
        for surface in IOSSurface.browseable { _ = try topic(surface) }
        XCTAssertNil(HelpPresentation.topic(forIOS: .storedReceive))
    }

    func testEveryIOSTopicAnswersSixQuestionsWithItsOwnIOSStrings() throws {
        var seen = Set<String>()
        let macKeys = Set(MacSurface.allCases.compactMap(HelpPresentation.topic(for:))
            .flatMap(Self.keys(of:)).map(\.rawValue))
        for surface in IOSSurface.browseable {
            let keys = Self.keys(of: try topic(surface))
            XCTAssertEqual(keys.count, 8, "\(surface.rawValue) is not the six-answer shape")
            for key in keys {
                XCTAssertTrue(key.rawValue.hasPrefix("help.ios."),
                              "\(key.rawValue) is not an iOS help string")
                XCTAssertFalse(macKeys.contains(key.rawValue),
                               "\(key.rawValue) is the macOS answer on iOS")
                XCTAssertTrue(seen.insert(key.rawValue).inserted,
                              "\(key.rawValue) answers two questions")
            }
        }
    }

    func testBothMaintainedLanguagesDefineEveryIOSHelpStringThemselves() throws {
        for language in [AppLanguage.en, .zh] {
            let catalog = try XCTUnwrap(StringsCatalog.load(language))
            for surface in IOSSurface.browseable {
                for key in Self.keys(of: try topic(surface)) {
                    let text = try XCTUnwrap(catalog[key.rawValue],
                                             "\(language.rawValue) lacks \(key.rawValue)")
                    XCTAssertGreaterThan(text.count, 10, "\(key.rawValue) is a placeholder")
                }
            }
        }
    }

    func testThePurposeFitsTheCollapsedRow() throws {
        for surface in IOSSurface.browseable {
            let purpose = try topic(surface).purpose
            for language in [AppLanguage.en, .zh] {
                XCTAssertLessThanOrEqual(L10n.t(purpose, language: language).count, 160,
                                         "\(purpose.rawValue) [\(language.rawValue)]")
            }
        }
    }

    /// **The Mac's facts do not leak into iOS help.** "this Mac", Downloads, a
    /// folder you choose, the login setting and "with the window closed" are all
    /// true on macOS and false here.
    func testNoIOSHelpStringStatesAMacOnlyFact() throws {
        for surface in IOSSurface.browseable {
            for key in Self.keys(of: try topic(surface)) {
                let english = en(key), chinese = zh(key)
                for mac in ["Mac", "Downloads", "folder you choose", "Choose a folder",
                            "login setting", "window closed", "Finder"] {
                    XCTAssertFalse(english.contains(mac), "\(key.rawValue) says \(mac)")
                }
                for mac in ["Mac", "“下载”", "下载文件夹", "登录设置", "访达"] {
                    XCTAssertFalse(chinese.contains(mac), "\(key.rawValue) says \(mac)")
                }
            }
        }
    }

    // MARK: - every claim, pinned to the source that makes it true on iOS

    /// Same-network: Bonjour only, STUN only (never a relay, so never billed),
    /// and the Local Network permission the recovery names.
    func testTheSameNetworkClaimsMatchTheIOSComposition() throws {
        let lan = try topic(.lanTransfer)
        XCTAssertTrue(en(lan.boundary).contains("Bonjour"))
        XCTAssertTrue(en(lan.boundary).contains("never through a Relayium relay"))
        XCTAssertTrue(en(lan.boundary).contains("uses none of your plan"))
        // The link fetches the code-less ICE once and filters it to STUN.
        let link = try RepoRoot.text("apps/RelayiumKit/Sources/RelayiumAppKit/LinkWorkspaceModel.swift")
        XCTAssertTrue(link.contains("RealtimeConnectionFactory.nearbyICEServers(config.iceServers)"),
                      "the same-network link no longer filters its ICE servers — the "
                      + "'never through a relay' sentence may be false")
        XCTAssertEqual(RealtimeConnectionFactory.nearbyICEServers([
            ICEServerConfig(urls: ["turn:relay.example:3478", "stun:stun.example:3478"],
                            username: "u", credential: "c"),
            ICEServerConfig(urls: ["turns:relay.example:5349"], username: "u", credential: "c"),
        ]), [ICEServerConfig(urls: ["stun:stun.example:3478"])],
            "a relay (TURN) server reaches a same-network connection")
        // Bonjour, and the permission the recovery sends people to.
        let plist = try RepoRoot.text("apps/ios/Relayium/Info.plist")
        XCTAssertTrue(plist.contains("NSLocalNetworkUsageDescription"))
        XCTAssertTrue(plist.contains("_relayium._tcp"))
        XCTAssertTrue(en(lan.recovery).contains("Local Network"))
        // "each set of files waits for you to tap Accept" on a current peer.
        let workspace = try RepoRoot.text("apps/ios/Relayium/NearbyLinkWorkspaceView.swift")
        XCTAssertTrue(workspace.contains("link.acceptInboundBatch()"))
        XCTAssertTrue(workspace.contains("link.rejectInboundBatch()"))
        XCTAssertTrue(en(lan.destination).contains("Accept"))
        // "connects only after you tap Accept" — the inbound connection prompt
        // (A23) — and "older versions cannot send to this device" (L1: the iOS
        // app composes the listener-only receive model).
        XCTAssertTrue(try RepoRoot.text("apps/ios/Relayium/NearbyView.swift").contains("link.acceptInboundAsk()"),
                      "the connection prompt the help promises is gone")
        let app = try RepoRoot.text("apps/ios/Relayium/RelayiumApp.swift")
        XCTAssertTrue(app.contains("makeListeningOnlyNearbyReceiveModel"),
                      "iOS admits legacy senders again, so the help's 'older versions cannot send' is false")
        XCTAssertTrue(en(lan.destination).contains("Older versions of Relayium cannot send"))
    }

    /// Cross-network: creating needs an account because relayed bytes are billed
    /// to the creator; joining needs none.
    func testTheCrossNetworkBillingClaimMatchesTheGate() throws {
        let cross = try topic(.crossNetworkTransfer)
        XCTAssertTrue(en(cross.boundary).contains("billed to whoever created the code"))
        XCTAssertTrue(en(cross.boundary).contains("needs no account"))
        let view = try RepoRoot.text("apps/ios/Relayium/DirectView.swift")
        let create = try XCTUnwrap(view.components(separatedBy: "private func createCode()")
            .dropFirst().first?.components(separatedBy: "private func join()").first)
        XCTAssertTrue(create.contains("guard case let .allowed(access) = gate else"),
                      "creating a code no longer needs an account")
        let join = try XCTUnwrap(view.components(separatedBy: "private func join()")
            .dropFirst().first?.components(separatedBy: "private func regenerate()").first)
        XCTAssertFalse(join.contains("gate"), "joining a code now needs an account")
        XCTAssertTrue(en(.gateCreateCodeBody).contains("billed to the account that created it"),
                      "the gate and the help no longer say the same thing")
    }

    /// Where things land: one route, spelled the way every other iOS sentence
    /// spells it.
    func testEveryReceiveDestinationSentenceNamesTheOneReceiveFolder() throws {
        let route = ReceiveDestinationCopy.Location.receiveFolder.path
        XCTAssertEqual(route, "Relayium/Received")
        for surface in [IOSSurface.lanTransfer, .crossNetworkTransfer, .deviceInbox] {
            let key = try topic(surface).destination
            XCTAssertTrue(en(key).contains(route), "\(key.rawValue) names another folder")
            XCTAssertTrue(zh(key).contains(route), "\(key.rawValue) [zh] names another folder")
        }
        let app = try RepoRoot.text("apps/ios/Relayium/RelayiumApp.swift")
        XCTAssertTrue(app.contains("{ try InboxContainerFolder.directory() }"),
                      "the Device Inbox no longer receives into the container folder")
    }

    /// The two iOS lifecycle facts the help repeats: an upload never continues in
    /// the background, and the Device Inbox receives only while the app is open.
    func testTheForegroundOnlyClaimsMatchWhatTheAppAlreadySays() throws {
        XCTAssertTrue(en(try topic(.storedSend).failure)
            .contains("it never continues in the background"))
        XCTAssertTrue(en(.uploadKeepOpen).contains("it never continues in the background"))
        XCTAssertTrue(en(try topic(.deviceInbox).failure).contains("only while it is open"))
        XCTAssertTrue(en(.inboxIOSForegroundOnly).contains("only while it is open"))
        let plist = try RepoRoot.text("apps/ios/Relayium/Info.plist")
        XCTAssertFalse(plist.contains("UIBackgroundModes"),
                       "the app gained a background mode — the foreground-only help is stale")
    }

    // MARK: - links and placement

    func testEveryIOSGuideLinkResolvesToAPublishedPage() throws {
        for surface in IOSSurface.browseable {
            guard case let .localizedGuide(slug)? = try topic(surface).guide else { continue }
            for language in AppLanguage.allCases {
                let url = HelpPresentation.url(for: .localizedGuide(slug: slug), language: language)
                let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                XCTAssertNoThrow(try RepoRoot.url("web/public/" + path + "/index.html"),
                                 "\(slug) [\(language.rawValue)] points at nothing")
            }
        }
        XCTAssertNil(try topic(.account).guide)
    }

    /// Every iOS destination draws its card exactly once, the Account tab
    /// included.
    func testTheIOSDestinationsDrawTheirHelp() throws {
        for (file, surface) in [("NearbyView.swift", "lanTransfer"),
                                ("DirectView.swift", "crossNetworkTransfer"),
                                ("SendView.swift", "storedSend"),
                                ("DeviceInboxView.swift", "deviceInbox"),
                                ("AccountTab.swift", "account")] {
            let text = try RepoRoot.text("apps/ios/Relayium/" + file)
            XCTAssertEqual(text.components(separatedBy: "IOSHelpCard(surface: .\(surface))").count - 1,
                           1, "\(file) does not draw its help exactly once")
        }
        let card = try RepoRoot.text("apps/ios/Relayium/Components/IOSHelpCard.swift")
        XCTAssertTrue(card.contains("HelpPresentation.topic(forIOS: surface)"),
                      "the iOS card reads the macOS table")
        XCTAssertFalse(card.contains("DisclosureGroup("))
        XCTAssertTrue(card.contains(".accessibilityValue("), "the expanded state is not spoken")
        XCTAssertTrue(card.contains("minHeight: Metrics.hitTarget"))
        XCTAssertFalse(card.contains(".lineLimit("), "help text can be truncated")
    }
}
