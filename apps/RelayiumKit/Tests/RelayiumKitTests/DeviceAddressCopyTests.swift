import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The address shown beside a device row is the one CENTRAL observed when that
/// credential was last used. It is not a location, not a claim the client made
/// about itself, and not something to invent when the server has none.
///
/// The distinction is the whole test file. This app also knows its own local
/// interface addresses — the LAN transfer page shows them — and rendering one of
/// those here would put a `192.168.x.x` under a heading that says "last used
/// from", about a device that may be on the other side of the world.
final class DeviceAddressCopyTests: XCTestCase {

    private func device(lastIP: String, name: String = "Mac", kind: String = "app",
                        current: Bool = false) -> AccountDevice {
        AccountDevice(id: "d1", name: name, createdAt: 1_780_000_000,
                      lastSeenAt: 1_780_090_000, kind: kind, current: current,
                      lastIP: lastIP)
    }

    // MARK: - decoding

    /// The field the server has emitted since the CLI device list was built.
    /// The native model simply never read it.
    func testTheDeviceRowDecodesTheServersLastIP() throws {
        let json = Data("""
        {"ID":"d1","Name":"Mac mini","CreatedAt":1780000000,"LastSeenAt":1780090000,
         "Kind":"app","Current":true,"LastIP":"203.0.113.9"}
        """.utf8)
        let decoded = try JSONDecoder().decode(AccountDevice.self, from: json)
        XCTAssertEqual(decoded.lastIP, "203.0.113.9")
    }

    /// A server that has never seen this credential used sends an empty string;
    /// an older one sends no field at all. Both mean the same thing and neither
    /// may fail the whole list.
    func testAnAbsentOrEmptyAddressDecodesAsNoAddress() throws {
        for body in [
            #"{"ID":"d1","Name":"Mac","Kind":"app"}"#,
            #"{"ID":"d1","Name":"Mac","Kind":"app","LastIP":""}"#,
        ] {
            let decoded = try JSONDecoder().decode(AccountDevice.self, from: Data(body.utf8))
            XCTAssertEqual(decoded.lastIP, "")
        }
    }

    /// The identifier this batch adds is a client-held lookup value the server
    /// never returns. If one ever appeared in a device response, the model must
    /// not carry it into the UI.
    func testTheDeviceRowHasNoFieldForAnInstallationIdentifier() throws {
        let json = Data("""
        {"ID":"d1","Name":"Mac","Kind":"app",
         "InstallID":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}
        """.utf8)
        let decoded = try JSONDecoder().decode(AccountDevice.self, from: json)
        let mirrored = Mirror(reflecting: decoded).children.compactMap(\.label)
        for label in mirrored {
            XCTAssertFalse(label.lowercased().contains("install"),
                           "AccountDevice carries \(label)")
        }
    }

    // MARK: - the sentence

    func testTheDetailLineCarriesTheServerObservedAddress() {
        let detail = AccountPresentation.deviceDetail(kind: "app",
                                                      lastSeenAt: 1_780_090_000,
                                                      createdAt: 1_780_000_000,
                                                      lastIP: "203.0.113.9",
                                                      language: .en)
        XCTAssertTrue(detail.contains("203.0.113.9"), detail)
    }

    /// No address, no sentence. A row that says "last seen at" with nothing
    /// after it, or with a placeholder, describes a fact the server does not
    /// have.
    func testNoAddressMeansNoAddressSentence() {
        for language in AppLanguage.allCases {
            let withAddress = AccountPresentation.deviceDetail(
                kind: "app", lastSeenAt: 1_780_090_000, createdAt: 1_780_000_000,
                lastIP: "203.0.113.9", language: language)
            let without = AccountPresentation.deviceDetail(
                kind: "app", lastSeenAt: 1_780_090_000, createdAt: 1_780_000_000,
                lastIP: "", language: language)
            XCTAssertNotEqual(withAddress, without, "\(language.rawValue)")
            // Built with the same bidi isolation the product applies, so this
            // asserts the rendered sentence rather than a simplified one that
            // happens to match in the eight left-to-right languages.
            let fragment = L10n.t(.accountDeviceLastAddress,
                                  [L10n.token("203.0.113.9", language: language)],
                                  language: language)
            XCTAssertTrue(withAddress.hasSuffix(fragment) || withAddress.contains(fragment),
                          "\(language.rawValue): \(withAddress)")
            XCTAssertFalse(without.contains("203.0.113"), "\(language.rawValue): \(without)")
            // The words as well as the value. A guard that only looked for the
            // address would pass a row rendering "last address " with nothing
            // after it — a sentence that promises a fact and then does not
            // state it, which is worse than saying nothing.
            let words = L10n.t(.accountDeviceLastAddress, [""], language: language)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            XCTAssertFalse(words.isEmpty, "\(language.rawValue) has no words around the address")
            XCTAssertFalse(without.contains(words),
                           "\(language.rawValue) renders an empty address sentence: \(without)")
        }
    }

    /// An address is server-issued opaque text, like a file id or a device name.
    /// Under Arabic it has to be isolated or the digits and dots reorder around
    /// the surrounding RTL sentence and the user reads a different address.
    func testTheAddressIsIsolatedUnderArabic() {
        let detail = AccountPresentation.deviceDetail(kind: "app", lastSeenAt: 1_780_090_000,
                                                      createdAt: 1_780_000_000,
                                                      lastIP: "203.0.113.9", language: .ar)
        XCTAssertTrue(detail.contains(L10n.token("203.0.113.9", language: .ar)),
                      "the address is not bidi-isolated: \(detail.debugDescription)")
    }

    /// Every language says it, and none of them says "location".
    func testTheAddressSentenceExistsInEveryLanguageAndClaimsNoLocation() {
        for language in AppLanguage.allCases {
            let fragment = L10n.t(.accountDeviceLastAddress, ["203.0.113.9"], language: language)
            XCTAssertTrue(fragment.contains("203.0.113.9"), "\(language.rawValue): \(fragment)")
            XCTAssertNotEqual(fragment, L10nKey.accountDeviceLastAddress.rawValue,
                              "\(language.rawValue) falls back to the key")
        }
        // The card explains what the address is and is not, once, rather than
        // repeating a caveat on every row. English is asserted literally; the
        // other eight are covered by the catalog integrity guards plus the
        // language-specific phrases below.
        let note = L10n.t(.accountDevicesAddressNote, language: .en)
        XCTAssertTrue(note.contains("our server"), note)
        XCTAssertTrue(note.lowercased().contains("not a location"), note)
        for language in AppLanguage.allCases {
            let text = L10n.t(.accountDevicesAddressNote, language: language)
            XCTAssertNotEqual(text, L10nKey.accountDevicesAddressNote.rawValue,
                              "\(language.rawValue) falls back to the key")
            XCTAssertFalse(text.isEmpty, language.rawValue)
        }
    }

    /// Spot-checked in three scripts, so a copy-paste of the English into eight
    /// files fails rather than passing the "non-empty" bar.
    func testTheAddressCopyIsGenuinelyTranslated() {
        XCTAssertTrue(L10n.t(.accountDeviceLastAddress, ["203.0.113.9"], language: .zh)
            .contains("地址"))
        XCTAssertTrue(L10n.t(.accountDevicesAddressNote, language: .ja).contains("サーバー"))
        XCTAssertTrue(L10n.t(.accountDevicesAddressNote, language: .fr).contains("serveur"))
    }

    // MARK: - the accessible label

    /// macOS shows the address on the row, so the revoke button — whose visible
    /// label is the single word "Revoke" on every row — says it too. iOS does
    /// not show it, and its label must not gain a fact its row never displayed.
    func testTheRevokeLabelMirrorsWhatThePlatformsRowShows() {
        let d = device(lastIP: "203.0.113.9")
        let shown = AccountPresentation.revokeActionLabel(for: d, showsAddress: true, language: .en)
        let hidden = AccountPresentation.revokeActionLabel(for: d, language: .en)
        XCTAssertTrue(shown.contains("203.0.113.9"), shown)
        XCTAssertFalse(hidden.contains("203.0.113.9"), hidden)
    }

    func testTheRevokeLabelStillNamesTheDeviceAndItsDates() {
        let d = device(lastIP: "203.0.113.9", name: "Mac mini", current: true)
        let label = AccountPresentation.revokeActionLabel(for: d, showsAddress: true, language: .en)
        XCTAssertTrue(label.contains("Mac mini"), label)
        XCTAssertTrue(label.contains(L10n.t(.accountThisMac, language: .en)), label)
    }

    // MARK: - the surface

    /// The macOS row renders the SERVER's address. The local interface
    /// addresses this app can also enumerate belong to the LAN transfer page,
    /// where they describe this machine — putting one here would label a
    /// client-asserted address as the device's observed one.
    func testTheAccountViewRendersTheServerAddressAndNotALocalOne() throws {
        let view = try macSource("AccountView.swift")
        XCTAssertTrue(view.contains("lastIP: device.lastIP"),
                      "the device row does not pass the server-observed address")
        XCTAssertTrue(view.contains("showsAddress: true"),
                      "the revoke label does not mirror the row")
        XCTAssertTrue(view.contains("accountDevicesAddressNote"),
                      "the devices card does not say what the address is")
        for local in ["LocalNetworkAddress", "localAddresses", "interfaceAddress"] {
            XCTAssertFalse(view.contains(local),
                           "the account surface reaches for a local address (\(local))")
        }
    }

    /// And the copy layer takes the address as a parameter rather than reaching
    /// for one, so there is exactly one place an address can come from.
    func testTheCopyLayerNeverSourcesAnAddressItself() throws {
        let copy = try kitSource("RelayiumAppKit/Localization/AppCopy.swift")
        for local in ["LocalNetworkAddress", "getifaddrs", "localAddresses"] {
            XCTAssertFalse(copy.contains(local), "AppCopy sources an address itself (\(local))")
        }
    }

    // MARK: - helpers

    private var repoRoot: URL {
        (0..<5).reduce(URL(fileURLWithPath: #filePath)) { u, _ in u.deletingLastPathComponent() }
    }
    private func macSource(_ name: String) throws -> String {
        try String(contentsOf: repoRoot.appendingPathComponent("apps/mac/Relayium/\(name)"),
                   encoding: .utf8)
    }
    private func kitSource(_ path: String) throws -> String {
        try String(contentsOf: repoRoot.appendingPathComponent("apps/RelayiumKit/Sources/\(path)"),
                   encoding: .utf8)
    }
}
