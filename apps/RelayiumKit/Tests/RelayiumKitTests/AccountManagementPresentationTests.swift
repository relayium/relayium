import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The decisions the account-management surface makes before anything is drawn.
///
/// R3-D renders devices and stored files on iOS as well as macOS, and the parts
/// most easily got wrong are not layout. Which of three key states a stored row
/// is in decides whether a `#k=` link is handed to the share sheet at all. What a
/// revoke costs is a different sentence for the credential the user is holding
/// than for one on another device. And two devices with the same name are one
/// list to look at and two identical buttons to somebody using VoiceOver.
///
/// All three live in `AccountPresentation` rather than inside a `View`, so
/// `swift test` can drive them directly instead of asserting that a SwiftUI file
/// happens to contain a substring. The state machine underneath stays
/// `AccountManagementModel`'s: nothing here re-derives it.
final class AccountManagementPresentationTests: XCTestCase {

    private func device(_ id: String = "d1", name: String = "Ada's laptop",
                        kind: String = "app", lastSeen: Int64 = 1_767_000_000,
                        created: Int64 = 1_766_000_000,
                        current: Bool = false) -> AccountDevice {
        AccountDevice(id: id, name: name, createdAt: created, lastSeenAt: lastSeen,
                      kind: kind, current: current)
    }

    private func storedRow(_ id: String,
                           link: StoredLinkAvailability) -> StoredFileRow {
        StoredFileRow(file: StoredFileSummary(id: id, size: 1, createdAt: 0,
                                              expiresAt: 1, burnAfterRead: false,
                                              downloaded: false, downloadCount: 0),
                      link: link)
    }

    // MARK: - which stored rows can offer a link

    /// The single most consequential decision on the screen: a `#k=` link is the
    /// plaintext, so it may only be offered when this installation genuinely
    /// rebuilt one. Neither unavailable state may leak into the shareable arm.
    func testOnlyAKeyThisDeviceHoldsBecomesAShareableLink() {
        XCTAssertEqual(AccountPresentation.link(for: .available(link: "https://x/#k=abc")),
                       .shareable("https://x/#k=abc"))
        switch AccountPresentation.link(for: .keyNotOnThisMac) {
        case .shareable: XCTFail("a missing key produced a shareable link")
        default: break
        }
        switch AccountPresentation.link(for: .keyLookupFailed("keychain said no")) {
        case .shareable: XCTFail("an unreadable keychain produced a shareable link")
        default: break
        }
    }

    /// "The key is not here" and "the keychain would not answer" are opposite
    /// statements about what the user can do next: the first is permanent from
    /// this installation, the second may be one unlock away. Collapsing them
    /// would tell somebody a file is unrecoverable on the strength of a locked
    /// keychain — so they must not render the same sentence in any language.
    func testTheTwoUnavailableStatesSayDifferentThingsInEveryLanguage() {
        for language in AppLanguage.allCases {
            guard case let .unavailable(missing) =
                    AccountPresentation.link(for: .keyNotOnThisMac, language: language) else {
                return XCTFail("\(language.rawValue): a missing key is not the unavailable state")
            }
            guard case let .lookupFailed(failed) =
                    AccountPresentation.link(for: .keyLookupFailed("K"), language: language) else {
                return XCTFail("\(language.rawValue): a keychain failure is not its own state")
            }
            XCTAssertFalse(missing.isEmpty, language.rawValue)
            XCTAssertNotEqual(missing, failed,
                              "\(language.rawValue) says the same thing about both")
        }
    }

    /// The keychain's own words survive into the sentence. Dropping them would
    /// leave a failure nobody can act on or report.
    func testAKeychainFailureCarriesTheUnderlyingReason() {
        guard case let .lookupFailed(text) =
                AccountPresentation.link(for: .keyLookupFailed("keychain error -25308"),
                                         language: .en) else {
            return XCTFail("not the lookup-failed state")
        }
        XCTAssertTrue(text.contains("keychain error -25308"), text)
    }

    /// The missing-key sentence is the one place the surface could imply the
    /// server could help. Every language has to keep saying it never had the key.
    func testTheMissingKeySentenceStillDeniesTheServerEverHadTheKey() {
        for language in AppLanguage.allCases {
            guard case let .unavailable(text) =
                    AccountPresentation.link(for: .keyNotOnThisMac, language: language) else {
                return XCTFail(language.rawValue)
            }
            XCTAssertTrue(text.contains("Relayium"),
                          "\(language.rawValue) dropped the claim about the servers: \(text)")
        }
    }

    /// A stale success badge is worse than no badge: after a reload, it may sit
    /// beside a row whose key can no longer be reconstructed. Row identity alone
    /// is therefore insufficient; the exact row must still be shareable.
    func testCopyAcknowledgementSurvivesOnlyForTheSameShareableRow() {
        let available = storedRow("f1", link: .available(link: "https://x/#k=abc"))
        let other = storedRow("f2", link: .available(link: "https://x/#k=def"))
        XCTAssertEqual(AccountPresentation.retainedCopiedFileID("f1", in: [available, other]),
                       "f1")
        XCTAssertNil(AccountPresentation.retainedCopiedFileID("missing", in: [available]))
        XCTAssertNil(AccountPresentation.retainedCopiedFileID("f1", in: [other]))
        XCTAssertNil(AccountPresentation.retainedCopiedFileID(
            "f1", in: [storedRow("f1", link: .keyNotOnThisMac)]))
        XCTAssertNil(AccountPresentation.retainedCopiedFileID(
            "f1", in: [storedRow("f1", link: .keyLookupFailed("locked"))]))
        XCTAssertNil(AccountPresentation.retainedCopiedFileID(nil, in: [available]))
    }

    // MARK: - naming a device

    func testAnUnnamedDeviceGetsTheLocalizedFallbackRatherThanABlank() {
        XCTAssertEqual(AccountPresentation.deviceName(device(name: ""), language: .fr),
                       L10n.t(.accountUnnamedDevice, language: .fr))
        XCTAssertEqual(AccountPresentation.deviceName(device(name: "Ada's laptop")),
                       "Ada's laptop")
    }

    /// A name that is only whitespace is a blank row with extra steps.
    func testAWhitespaceOnlyNameIsTreatedAsUnnamed() {
        XCTAssertEqual(AccountPresentation.deviceName(device(name: "   "), language: .en),
                       L10n.t(.accountUnnamedDevice, language: .en))
    }

    // MARK: - what a revoke costs

    /// Revoking the credential in your hand signs this app out; revoking another
    /// one does not. Rendering the wrong consequence is a confirmation dialog
    /// lying about what the destructive button does.
    func testTheRevokeConsequenceDistinguishesThisDeviceFromAnotherInEveryLanguage() {
        for language in AppLanguage.allCases {
            let mine = AccountPresentation.revokeConsequence(current: true, language: language)
            let theirs = AccountPresentation.revokeConsequence(current: false, language: language)
            XCTAssertFalse(mine.isEmpty, language.rawValue)
            XCTAssertNotEqual(mine, theirs,
                              "\(language.rawValue) warns the same way about both")
            XCTAssertEqual(mine, L10n.t(.accountRevokeThisMac, language: language))
            XCTAssertEqual(theirs, L10n.t(.accountRevokeOther, language: language))
        }
    }

    // MARK: - telling two rows apart without seeing them

    /// Two devices can carry the same name — the same model signed in twice is
    /// the ordinary case, not a corner one — and then the list is two identical
    /// "Revoke" buttons. The label has to carry enough to pick between them.
    func testTwoDevicesWithTheSameNameGetDistinguishableRevokeLabels() {
        let older = device("d1", name: "iPhone", lastSeen: 1_700_000_000)
        let newer = device("d2", name: "iPhone", lastSeen: 1_760_000_000)
        let a = AccountPresentation.revokeActionLabel(for: older, language: .en)
        let b = AccountPresentation.revokeActionLabel(for: newer, language: .en)
        XCTAssertNotEqual(a, b, "two same-named devices read identically: \(a)")
        XCTAssertTrue(a.contains("iPhone"), a)
        XCTAssertTrue(b.contains("iPhone"), b)
    }

    /// And the one that signs this app out says so, in the label as well as in
    /// the confirmation — the label is what a VoiceOver user hears before they
    /// ever reach the dialog.
    func testTheCurrentDevicesRevokeLabelSaysItIsThisDevice() {
        let label = AccountPresentation.revokeActionLabel(for: device(current: true),
                                                          language: .en)
        XCTAssertTrue(label.contains(L10n.t(.accountThisMac, language: .en)), label)
        let other = AccountPresentation.revokeActionLabel(for: device(current: false),
                                                          language: .en)
        XCTAssertFalse(other.contains(L10n.t(.accountThisMac, language: .en)), other)
    }

    /// An unnamed device must not produce a label that names nothing at all.
    func testAnUnnamedDevicesRevokeLabelStillNamesSomething() {
        let label = AccountPresentation.revokeActionLabel(for: device(name: ""), language: .en)
        XCTAssertTrue(label.contains(L10n.t(.accountUnnamedDevice, language: .en)), label)
    }

    /// The two stored-row actions are a share and a destruction. They may not
    /// read alike, and each has to name the row it belongs to — a screen of
    /// "Share"/"Delete" pairs is unusable without sight.
    func testTheStoredRowActionsNameTheirFileAndDifferFromEachOther() {
        let copy = AccountPresentation.copyActionLabel(fileId: "abc123", copied: false,
                                                       language: .en)
        let copied = AccountPresentation.copyActionLabel(fileId: "abc123", copied: true,
                                                         language: .en)
        let share = AccountPresentation.shareActionLabel(fileId: "abc123", language: .en)
        let delete = AccountPresentation.deleteActionLabel(fileId: "abc123", language: .en)
        XCTAssertTrue(copy.contains("abc123"), copy)
        XCTAssertTrue(copied.contains("abc123"), copied)
        XCTAssertTrue(share.contains("abc123"), share)
        XCTAssertTrue(delete.contains("abc123"), delete)
        XCTAssertNotEqual(copy, copied)
        XCTAssertNotEqual(share, delete)
    }

    /// The id is a server-issued opaque token, so it is isolated rather than
    /// translated — under Arabic the bidi algorithm would otherwise be free to
    /// move part of it across the sentence.
    func testTheFileIdIsBidiIsolatedInArabic() {
        let label = AccountPresentation.deleteActionLabel(fileId: "abc123", language: .ar)
        XCTAssertTrue(label.contains("\u{2068}abc123\u{2069}"), label)
    }

    // MARK: - every label is real copy

    func testEveryManagementLabelIsRealCopyInEveryLanguage() {
        for language in AppLanguage.allCases {
            let labels = [
                AccountPresentation.revokeActionLabel(for: device(), language: language),
                AccountPresentation.revokeActionLabel(for: device(current: true),
                                                      language: language),
                AccountPresentation.copyActionLabel(fileId: "f", copied: false,
                                                    language: language),
                AccountPresentation.copyActionLabel(fileId: "f", copied: true,
                                                    language: language),
                AccountPresentation.shareActionLabel(fileId: "f", language: language),
                AccountPresentation.deleteActionLabel(fileId: "f", language: language),
            ]
            for label in labels {
                XCTAssertFalse(label.isEmpty, language.rawValue)
                XCTAssertFalse(label.contains("%@"),
                               "\(language.rawValue) left a placeholder: \(label)")
                XCTAssertFalse(label.contains("account."),
                               "\(language.rawValue) fell through to a raw key: \(label)")
            }
        }
    }
}
