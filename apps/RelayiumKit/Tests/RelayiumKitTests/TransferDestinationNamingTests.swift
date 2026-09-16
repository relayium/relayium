import XCTest
@testable import RelayiumAppKit
@testable import RelayiumShareKit

/// **One name per transfer destination, in both maintained languages, on every
/// surface the native apps put it on.**
///
/// This is the native half of the invariant `i18n-transfer-product-names.test.ts`
/// holds for the web tables. It exists because the web guard could not see the
/// defect that mattered most: three platforms named the SAME destination three
/// different things, and only one of the three was in a file that suite reads.
///
/// | destination | web | macOS | iOS |
/// |---|---|---|---|
/// | cross-network | `Cross-network transfer` | `Cross-network Transfer` | `Pairing` |
/// | stored link | `Share a link` | `Share a link` | `Share Link` |
///
/// **`Direct` was not merely a third name**, and that part of the original
/// argument stands. `MacSurface.lanTransfer`'s own comment records that the
/// client CANNOT TELL whether a session's path is direct or relayed, and the
/// destination this once labelled routinely runs over TURN. A name that claims
/// a direct path is worse than an inconsistent one, and the same word sat above
/// the LAN row as a sidebar section header. Neither may come back.
///
/// ## The correction of 2026-09-16, and why the direction reversed
///
/// A round of this suite also required the two browsing surfaces to be named
/// after the pairing CODE — `Pairing Transfer` / `配对传输` — on the argument
/// that a destination should not be named after the network it does or does not
/// need. Shipped, that read as the opposite of what it claimed: the one question
/// in front of these two rows is whether the devices must share a network, and
/// the row that answers "no" was the only one whose name said nothing about
/// networks at all. The owner could not recognise the cross-network product
/// under it. The web restored `Cross-network transfer` / `跨网络传输` first, and
/// the macOS sidebar row follows it here, so a person moving between the site
/// and the app is looking at one product.
///
/// **The pairing code did not stop being the mechanism.** It is what the screen
/// is made of, what its own card is called (`workspace.pairingHeading`), and how
/// the LAN screen's recovery sentence tells a stuck reader to reach the other
/// destination. What changed is that the mechanism no longer stands in for the
/// destination's NAME on the surface somebody browses.
///
/// **iOS keeps `Pairing`**, and that is a recorded divergence rather than an
/// oversight: a tab item is abbreviated where a sidebar row is not, and
/// retitling an iOS tab belongs to the iOS objective and its own layout review.
/// `tab.direct` is pinned below so it cannot drift back to a path claim in the
/// meantime.
///
/// ## What is asserted, and what deliberately is not
///
/// The browsing **name** must say which network reach the destination has, and
/// must never claim a direct path or name the transport. The **subtitles** must
/// keep the facts the names do not carry — a shared network is not required for
/// the cross-network destination, and the LAN one needs one.
///
/// Keys are NOT renamed and this suite would not notice if they were: `L10nKey`
/// spells `nav.crossNetwork` and `tab.direct` exactly as it did before, which is
/// PROJECT-GOVERNANCE's "preserve the localization architecture and stable
/// message keys". A stable key with the right words in it is the cheap version
/// of this change; a key rename would have touched every catalog and every
/// consumer for no user-visible gain.
final class TransferDestinationNamingTests: XCTestCase {

    /// The words each language uses for a destination, and the words it may not.
    private struct Tokens {
        /// How this language says "pairing" — the mechanism, and the iOS tab.
        let pairing: String
        /// How this language names the link-sharing destination.
        let shareLink: String
        /// This language's own name for the same-network destination.
        let lan: [String]
        /// What the browsing name for the cross-network destination must say.
        let crossNetworkName: String
        /// Names that may never return to EITHER live destination: a claimed
        /// direct path, and the transport.
        let stalePathClaim: [String]
        /// The name the cross-network destination briefly carried, which hid the
        /// one fact a person chooses on. It is the mechanism, not the product.
        let staleCrossNetworkName: String
        /// The jargon that shipped on the stored destination, web-side.
        let staleStored: [String]
        /// The reach-another-network fact, which the subtitle spells out.
        let crossNetwork: String
        /// The needs-one-network fact, which is what LAN's subtitle is for.
        let sameNetwork: String
    }

    private let tokens: [AppLanguage: Tokens] = [
        .en: Tokens(pairing: "pairing", shareLink: "share a link",
                    lan: ["lan"],
                    crossNetworkName: "cross-network",
                    stalePathClaim: ["direct", "realtime"],
                    staleCrossNetworkName: "pairing transfer",
                    staleStored: ["async"],
                    crossNetwork: "same network not required",
                    sameNetwork: "this network"),
        .zh: Tokens(pairing: "配对", shareLink: "分享链接",
                    lan: ["局域网"],
                    crossNetworkName: "跨网络",
                    stalePathClaim: ["直连", "实时传输"],
                    staleCrossNetworkName: "配对传输",
                    staleStored: ["异步"],
                    crossNetwork: "不要求同一网络",
                    sameNetwork: "同一网络"),
    ]

    private func t(_ key: L10nKey, _ language: AppLanguage) -> String {
        L10n.t(key, language: language).lowercased()
    }

    /// **The macOS row says which networks it reaches**, because that is the one
    /// question in front of it.
    ///
    /// `nav.crossNetwork` is both the sidebar row and the window title of the
    /// destination it opens. It carries this language's cross-network word, it
    /// does not carry the name that hid it (`Pairing Transfer` / `配对传输`), and
    /// it never claims a direct path or names the transport.
    func testTheCrossNetworkDestinationIsNamedAfterTheReachItHas() {
        for (language, tok) in tokens {
            let name = t(.navCrossNetwork, language)
            XCTAssertTrue(name.contains(tok.crossNetworkName),
                          "\(language) nav.crossNetwork = \"\(name)\" does not say this is the "
                          + "destination that reaches another network")
            XCTAssertFalse(name.contains(tok.staleCrossNetworkName),
                           "\(language) nav.crossNetwork = \"\(name)\" names the destination "
                           + "after its mechanism again, which is what hid the product")
            for stale in tok.stalePathClaim {
                XCTAssertFalse(name.contains(stale),
                               "\(language) nav.crossNetwork = \"\(name)\" claims a direct "
                               + "path or names the transport")
            }
        }
    }

    /// **The iOS tab keeps the mechanism**, and keeps it honestly.
    ///
    /// A tab item is abbreviated where a sidebar row is not, and renaming one
    /// belongs to the iOS objective. What must hold in the meantime is that it
    /// still names the pairing code rather than drifting back to `Direct` — the
    /// path claim this client cannot make. Recorded here so the divergence from
    /// `nav.crossNetwork` above is a decision with a reason rather than a drift.
    func testTheIOSTabStillNamesThePairingCodeAndClaimsNoPath() {
        for (language, tok) in tokens {
            let tab = t(.tabDirect, language)
            XCTAssertTrue(tab.contains(tok.pairing),
                          "\(language) tab.direct = \"\(tab)\" no longer names the pairing code")
            for stale in tok.stalePathClaim {
                XCTAssertFalse(tab.contains(stale),
                               "\(language) tab.direct = \"\(tab)\" claims a direct path or "
                               + "names the transport")
            }
        }
    }

    /// Every surface that NAMES the stored-link destination: the macOS sidebar
    /// row and destination heading (`nav.storedSend`) and the iOS tab item
    /// (`tab.send`), whose screen titles itself from `nav.storedSend` too.
    func testTheStoredLinkDestinationIsNamedAfterTheLinkOnBothPlatforms() {
        for (language, tok) in tokens {
            let mac = t(.navStoredSend, language)
            XCTAssertTrue(mac.contains(tok.shareLink),
                          "\(language) nav.storedSend = \"\(mac)\" does not name the "
                          + "link-sharing destination")
            // The iPhone tab is allowed to be shorter than the sidebar row — a
            // tab item is abbreviated and a row is not — but it has to be the
            // SAME product. "link" is the word that makes it so, and it is the
            // one the previous label ("Send" / "发送") did not have.
            let tab = t(.tabSend, language)
            let link = language == .en ? "link" : "链接"
            XCTAssertTrue(tab.contains(link),
                          "\(language) tab.send = \"\(tab)\" does not say what is being sent")
            for stale in tok.staleStored {
                XCTAssertFalse(tab.contains(stale) || mac.contains(stale),
                               "\(language) still calls the stored destination \"\(stale)\"")
            }
        }
    }

    /// The sibling keeps its own name, and the grouping above the two live
    /// destinations no longer claims a path neither can prove.
    func testTheLanSiblingKeepsItsNameAndTheGroupingClaimsNoDirectPath() {
        for (language, tok) in tokens {
            let lan = t(.navLanTransfer, language)
            XCTAssertTrue(tok.lan.contains(where: lan.contains),
                          "\(language) nav.lanTransfer = \"\(lan)\" lost the LAN name")
            XCTAssertFalse(lan.contains(tok.pairing),
                           "\(language) nav.lanTransfer now claims to be the pairing product")

            // `nav.sectionDirect` groups LAN Transfer and Cross-network
            // Transfer in the macOS sidebar. It said *Direct* / *直连* — over a row whose own
            // type comment states that this client cannot tell a direct path
            // from a relayed one, and under a heading a person reads as a claim
            // about how their file travels. What the two rows genuinely share is
            // that both sides have to be present.
            let section = t(.navSectionDirect, language)
            for stale in tok.stalePathClaim where stale == "direct" || stale == "直连" {
                XCTAssertFalse(section.contains(stale),
                               "the sidebar groups both live transfers under \"\(section)\", "
                               + "which claims the path is direct")
            }
        }
    }

    /// **What the names stopped carrying, the subtitles still do.**
    ///
    /// This is the half that makes the rename a rename rather than a deletion.
    /// The one question a person actually has in front of these two rows is
    /// whether the devices must share a network, and after the rename neither
    /// NAME answers it — so both subtitles must, and they are what the sidebar
    /// row's tooltip and accessibility hint render.
    func testTheSubtitlesStillAnswerTheNetworkQuestionTheNamesNoLongerDo() {
        for (language, tok) in tokens {
            let pairing = t(.navCrossNetworkSubtitle, language)
            XCTAssertTrue(pairing.contains(tok.crossNetwork),
                          "\(language) nav.crossNetworkSubtitle no longer says a shared network "
                          + "is not required: \"\(pairing)\"")
            let lan = t(.navLanTransferSubtitle, language)
            XCTAssertTrue(lan.contains(tok.sameNetwork),
                          "\(language) nav.lanTransferSubtitle no longer says which network: "
                          + "\"\(lan)\"")
        }
    }

    /// **Copy that POINTS AT a destination has to use the name that destination
    /// shows.**
    ///
    /// `help.lan.recovery` is the sentence a reader gets when the device they
    /// want never appears in the roster — the one place in the product that
    /// sends somebody from one transfer destination to the other. Through the
    /// `Pairing Transfer` round it went on naming "the Cross-network screen" in
    /// both languages while the sidebar row said something else entirely, so the
    /// reader was sent to a row that did not exist under that name. The name has
    /// since come back to the row; this is what stops the two halves parting
    /// again, in either direction.
    ///
    /// Asserted against `nav.crossNetwork` rather than against a literal, so the
    /// pointer follows the row's name rather than pinning a second copy of it.
    func testTheCopyThatSendsAReaderToTheOtherDestinationUsesItsShippedName() {
        for (language, tok) in tokens {
            let recovery = t(.helpLanRecovery, language)
            let name = t(.navCrossNetwork, language)
            XCTAssertTrue(recovery.contains(name),
                          "\(language) help.lan.recovery sends the reader somewhere that is not "
                          + "called \"\(name)\" anywhere in the app: \"\(recovery)\"")
            for stale in tok.stalePathClaim + [tok.staleCrossNetworkName] {
                XCTAssertFalse(recovery.contains(stale),
                               "\(language) help.lan.recovery still sends the reader to "
                               + "\"\(stale)\"")
            }
        }
    }

    /// Nearby is deliberately NOT renamed to match the web's LAN, and this
    /// records why rather than leaving it to look like an oversight.
    ///
    /// The iOS same-network destination is composed over Bonjour: it browses and
    /// publishes exactly `_relayium._tcp` on the local link this device joined
    /// (`NearbyView`'s own comment is the argument, and `nearby.iosExplain` is
    /// the user-facing version). The web and macOS rooms are hub-backed and
    /// group devices by the public address a rendezvous service observed, which
    /// can include a carrier or VPN gateway. Those are different sets of
    /// devices, so one name for both would be the inconsistency this suite
    /// exists to prevent, aimed the other way.
    func testTheIOSLocalDestinationKeepsItsOwnPlatformName() {
        for (language, tok) in tokens {
            let nearby = t(.navNearby, language)
            XCTAssertFalse(nearby.isEmpty)
            XCTAssertFalse(tok.lan.contains(where: nearby.contains),
                           "\(language) nav.nearby now claims the hub-backed LAN room's name "
                           + "for a Bonjour-only roster")
            // And the explanation that justifies the different name is present
            // and is the iOS one, not the shared room's.
            XCTAssertTrue(t(.nearbyIOSExplain, language).contains(
                "bonjour"),
                          "\(language) nearby.iosExplain no longer names the mechanism that "
                          + "makes this a different destination from the web's LAN room")
        }
    }
}
