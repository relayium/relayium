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
/// | pairing code | `Cross-network` | `Cross-network Transfer` | **`Direct`** |
/// | stored link | `Async` / `Download link` | `Send a link` | **`Send`** |
///
/// **`Direct` was not merely a third name.** `MacSurface.lanTransfer`'s own
/// comment records that the client CANNOT TELL whether a session's path is
/// direct or relayed, and the destination this labelled routinely runs over
/// TURN. A tab that claims a direct path is worse than an inconsistent one, and
/// the same word sat above the LAN row as a sidebar section header.
///
/// ## What is asserted, and what deliberately is not
///
/// The **names** must agree and must not name the mechanism. The **subtitles**
/// must keep the facts the names stopped carrying — a shared network is not
/// required for the pairing destination, and the LAN one needs one — because
/// "stop naming it after the network" and "stop mentioning the network" are
/// different changes and only the first was wanted.
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
        /// How this language says "pairing".
        let pairing: String
        /// How this language names the link-sharing destination.
        let shareLink: String
        /// This language's own name for the same-network destination.
        let lan: [String]
        /// Names that shipped on the pairing destination and may never return.
        let stalePairing: [String]
        /// The jargon that shipped on the stored destination, web-side.
        let staleStored: [String]
        /// The reach-another-network fact, which is no longer in the name.
        let crossNetwork: String
        /// The needs-one-network fact, which is what LAN's subtitle is for.
        let sameNetwork: String
    }

    private let tokens: [AppLanguage: Tokens] = [
        .en: Tokens(pairing: "pairing", shareLink: "share a link",
                    lan: ["lan"],
                    stalePairing: ["direct", "cross-network", "realtime"],
                    staleStored: ["async"],
                    crossNetwork: "same network not required",
                    sameNetwork: "this network"),
        .zh: Tokens(pairing: "配对", shareLink: "分享链接",
                    lan: ["局域网"],
                    stalePairing: ["直连", "跨网络传输", "实时传输"],
                    staleStored: ["异步"],
                    crossNetwork: "不要求同一网络",
                    sameNetwork: "同一网络"),
    ]

    private func t(_ key: L10nKey, _ language: AppLanguage) -> String {
        L10n.t(key, language: language).lowercased()
    }

    /// Every surface that NAMES the pairing-code destination: the macOS sidebar
    /// row and its destination heading (`nav.crossNetwork`), and the iOS tab
    /// item and its navigation title (`tab.direct`).
    func testThePairingDestinationIsNamedAfterPairingOnBothPlatforms() {
        for (language, tok) in tokens {
            for key in [L10nKey.navCrossNetwork, .tabDirect] {
                let name = t(key, language)
                XCTAssertTrue(name.contains(tok.pairing),
                              "\(language) \(key.rawValue) = \"\(name)\" does not name the "
                              + "pairing destination")
                for stale in tok.stalePairing {
                    XCTAssertFalse(name.contains(stale),
                                   "\(language) \(key.rawValue) = \"\(name)\" names the "
                                   + "destination after its mechanism, or claims a direct path")
                }
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

            // `nav.sectionDirect` groups LAN Transfer and Pairing Transfer in
            // the macOS sidebar. It said *Direct* / *直连* — over a row whose own
            // type comment states that this client cannot tell a direct path
            // from a relayed one, and under a heading a person reads as a claim
            // about how their file travels. What the two rows genuinely share is
            // that both sides have to be present.
            let section = t(.navSectionDirect, language)
            for stale in tok.stalePairing where stale == "direct" || stale == "直连" {
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
