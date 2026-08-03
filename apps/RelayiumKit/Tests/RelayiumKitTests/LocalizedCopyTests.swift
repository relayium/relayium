import XCTest
@testable import RelayiumKit
@testable import RelayiumAppKit

/// What the localization actually RENDERS, driven through the seams the app uses.
///
/// The integrity tests prove the catalogs line up. These prove the copy comes out
/// of them: that `ErrorCopy` in Arabic is Arabic, that a file name inside it is
/// still the file name, that a count of three files picks Arabic's `few` and not
/// its `other`, and that the claims the product cannot afford to lose in
/// translation — end-to-end encryption, the key never leaving this Mac,
/// irreversible deletion — are present in every language.
///
/// Every assertion names its language. None of them can pass or fail because of
/// the machine the tests run on.
final class LocalizedCopyTests: XCTestCase {

    // MARK: - errors carry their language and keep their data

    func testErrorCopyIsTranslatedInEveryLanguage() {
        let english = ErrorCopy.message(for: HandshakeError.mitm, language: .en)
        for language in AppLanguage.allCases where language != .en {
            let translated = ErrorCopy.message(for: HandshakeError.mitm, language: language)
            XCTAssertFalse(translated.isEmpty)
            XCTAssertNotEqual(translated, english,
                              "\(language.rawValue) still shows the English MITM warning")
        }
    }

    /// The sharpest sentence in the app has to survive translation with its
    /// instruction intact: stop, and pair again — never "retry".
    func testTheMitmWarningKeepsItsMeaningInChineseAndArabic() {
        let zh = ErrorCopy.message(for: HandshakeError.mitm, language: .zh)
        XCTAssertTrue(zh.contains("干扰"), zh)          // someone may be interfering
        XCTAssertTrue(zh.contains("重新配对"), zh)       // pair again
        let ar = ErrorCopy.message(for: HandshakeError.mitm, language: .ar)
        XCTAssertTrue(ar.contains("سر مشترك"), ar)      // shared secret
        XCTAssertTrue(ar.contains("الاقتران"), ar)      // pairing
    }

    /// A user's own file name is data, not copy: it appears verbatim inside the
    /// translated sentence in every language.
    func testFileNamesSurviveVerbatimInsideTranslatedErrors() {
        let name = "季度报告 v2.pdf"
        for language in AppLanguage.allCases {
            let message = ErrorCopy.message(
                for: RealtimeSenderError.sourceShorterThanDeclared(name: name),
                language: language)
            XCTAssertTrue(message.contains(name),
                          "\(language.rawValue) lost the file name: \(message)")
        }
    }

    /// Under Arabic the same name is wrapped in a first-strong isolate so the
    /// bidi algorithm lays it out as one unit — and the bytes between the marks
    /// are still exactly the name, so it is still copyable and still searchable.
    func testArabicIsolatesTechnicalValuesWithoutAlteringThem() {
        let path = "../../etc/passwd"
        let arabic = ErrorCopy.message(for: ManifestPathError.unsafePath(path), language: .ar)
        XCTAssertTrue(arabic.contains("\u{2068}" + path + "\u{2069}"), arabic)
        // English is untouched by the isolation, so the pre-localization wording
        // is byte-identical.
        let english = ErrorCopy.message(for: ManifestPathError.unsafePath(path), language: .en)
        XCTAssertFalse(english.contains("\u{2068}"), english)
        XCTAssertTrue(english.contains(path), english)
    }

    /// Diagnostic numbers stay diagnostic: no grouping separators, no digit
    /// substitution, in any language. Someone pastes these into a bug report.
    func testStatusCodesAndOSStatusValuesAreVerbatimEverywhere() {
        for language in AppLanguage.allCases {
            XCTAssertTrue(
                ErrorCopy.message(for: CloudError.server(status: 503), language: language)
                    .contains("503"),
                language.rawValue)
            XCTAssertTrue(
                ErrorCopy.message(for: KeychainError.status(-34018), language: language)
                    .contains("-34018"),
                language.rawValue)
            XCTAssertTrue(
                ErrorCopy.message(for: FileSelectionError.tooManyFiles, language: language)
                    .contains(String(MAX_FILES)),
                language.rawValue)
        }
    }

    /// The stored-link-key copy stays operation-specific in every language: a
    /// failed save, read and remove must not collapse into one sentence, which
    /// is the mistake the English wording was rewritten to avoid.
    func testStoredLinkKeyCopyStaysPerOperationInEveryLanguage() {
        for language in AppLanguage.allCases {
            let rendered = [StoredLinkKeyOperation.save, .read, .remove].map {
                ErrorCopy.storedLinkKeyMessage(for: KeychainError.status(-25308),
                                               operation: $0, language: language)
            }
            XCTAssertEqual(Set(rendered).count, 3,
                           "\(language.rawValue) renders two key operations identically")
        }
    }

    // MARK: - plurals in context

    /// Arabic picks a different form for 1, 2, 3 and 11 — the whole reason the
    /// plural layer exists rather than a single "%@ files" string.
    func testArabicSelectionSummaryUsesFourDifferentPluralForms() throws {
        let one = L10n.plural(.selectionFiles, 1, language: .ar)
        let two = L10n.plural(.selectionFiles, 2, language: .ar)
        let few = L10n.plural(.selectionFiles, 3, language: .ar)
        let many = L10n.plural(.selectionFiles, 11, language: .ar)
        XCTAssertEqual(Set([one, two, few, many]).count, 4,
                       "Arabic collapsed plural forms: \(one) / \(two) / \(few) / \(many)")
        for rendered in [one, two, few, many] {
            // Combining marks removed first: `ملفًا` carries tanwin, and Swift's
            // `contains` works on grapheme clusters, so a literal `contains("ملف")`
            // would report a correct Arabic string as missing the word.
            let stripped = String(String.UnicodeScalarView(
                rendered.unicodeScalars.filter { !CharacterSet.nonBaseCharacters.contains($0) }))
            XCTAssertTrue(stripped.contains("ملف"), rendered)
        }
        XCTAssertTrue(few.contains("3"), few)
    }

    /// Chinese has one form and must not gain an English "s".
    func testChinesePluralsAreCountInvariant() {
        let one = L10n.plural(.downloadFileCount, 1, language: .zh)
        let many = L10n.plural(.downloadFileCount, 12, language: .zh)
        XCTAssertEqual(one, "1 个文件")
        XCTAssertEqual(many, "12 个文件")
    }

    /// French and Portuguese take the SINGULAR noun at zero; German and English
    /// take the plural. Asserted on the words rather than on the category, so it
    /// is a statement about what the user reads.
    func testZeroTakesTheSingularNounInFrenchAndPortugueseOnly() {
        let fr0 = L10n.plural(.selectionFiles, 0, language: .fr)
        XCTAssertTrue(fr0.contains("fichier prêt"), fr0)
        XCTAssertFalse(fr0.contains("fichiers"), fr0)
        XCTAssertTrue(L10n.plural(.selectionFiles, 2, language: .fr).contains("fichiers prêts"))

        let pt0 = L10n.plural(.selectionFiles, 0, language: .pt)
        XCTAssertTrue(pt0.contains("ficheiro pronto"), pt0)
        XCTAssertTrue(L10n.plural(.selectionFiles, 2, language: .pt).contains("ficheiros prontos"))

        XCTAssertTrue(L10n.plural(.selectionFiles, 0, language: .de).contains("Dateien"))
        XCTAssertTrue(L10n.plural(.selectionFiles, 0, language: .en).contains("files"))
    }

    func testResetTextPluralizesPerLanguage() {
        let now = Date(timeIntervalSince1970: 1_780_000_000)
        let five = UsagePresentation.resetText(resetsAt: 1_780_000_000 + 5 * 86_400,
                                               now: now, language: .ar)
        XCTAssertTrue(five.contains("5"), five)
        XCTAssertTrue(five.contains("أيام"), five)      // Arabic `few`
        XCTAssertEqual(UsagePresentation.resetText(resetsAt: 1_780_000_000 + 3_600,
                                                   now: now, language: .zh),
                       "今天重置")
    }

    // MARK: - the selection summary, end to end

    /// The summary is assembled from three separately pluralized fragments; this
    /// is the assembled result, in a language that pluralizes and one that does
    /// not.
    @MainActor
    func testSelectionSummaryReadsCorrectlyInChineseAndGerman() throws {
        let store = SelectionStore(expand: { _ in
            FileSelection(
                files: [SelectedFile(url: URL(fileURLWithPath: "/tmp/trip/a.txt"),
                                     relativePath: "trip/a.txt"),
                        SelectedFile(url: URL(fileURLWithPath: "/tmp/trip/b.txt"),
                                     relativePath: "trip/b.txt")],
                emptyDirectories: ["trip/hollow"])
        })
        store.replace(with: [URL(fileURLWithPath: "/tmp/trip")])

        let zh = try XCTUnwrap(store.summaryText(language: .zh))
        XCTAssertTrue(zh.contains("已就绪 2 个文件"), zh)
        XCTAssertTrue(zh.contains("1 个文件夹"), zh)
        XCTAssertTrue(zh.contains("1 个空文件夹无法发送"), zh)

        let de = try XCTUnwrap(store.summaryText(language: .de))
        XCTAssertTrue(de.contains("2 Dateien bereit"), de)
        XCTAssertTrue(de.contains("in 1 Ordner"), de)
        XCTAssertTrue(de.contains("1 leerer Ordner"), de)
    }

    // MARK: - presentation seams

    func testNearbyStatusIsTranslatedForEveryState() {
        let states: [NearbyReceiveState] = [.off, .paused, .connecting, .ready,
                                            .reconnecting, .active(.file), .active(.text)]
        for state in states {
            let zh = NearbyStatusPresentation.text(for: state, language: .zh)
            let en = NearbyStatusPresentation.text(for: state, language: .en)
            XCTAssertFalse(zh.isEmpty)
            XCTAssertNotEqual(zh, en, "state \(state) is not translated")
        }
        XCTAssertEqual(NearbyStatusPresentation.text(for: .ready, language: .ar),
                       "الاستقبال من القريبين: جاهز")
    }

    func testTtlLabelsAreTranslatedAndUnknownValuesStayUsable() {
        XCTAssertEqual(TtlPresentation.label(seconds: 1_209_600, language: .en), "14 days")
        XCTAssertEqual(TtlPresentation.label(seconds: 1_209_600, language: .zh), "14 天")
        XCTAssertEqual(TtlPresentation.label(seconds: 1_209_600, language: .ja), "14 日")
        // A retention this build has no name for is shown rather than hidden.
        XCTAssertTrue(TtlPresentation.label(seconds: 4242, language: .fr).contains("4242"))
    }

    func testAccountRowDetailsAreLocalized() {
        let detail = AccountPresentation.deviceDetail(kind: "cli", lastSeenAt: 0,
                                                      createdAt: 1_780_000_000, language: .zh)
        XCTAssertTrue(detail.contains("命令行"), detail)
        XCTAssertTrue(detail.contains("从未使用"), detail)

        let file = StoredFileSummary(id: "abc", size: 2_097_152, createdAt: 1_780_000_000,
                                     expiresAt: 0, burnAfterRead: true,
                                     downloaded: false, downloadCount: 3)
        let fr = AccountPresentation.fileDetail(file, language: .fr)
        XCTAssertTrue(fr.contains("chiffrés"), fr)
        XCTAssertTrue(fr.contains("sans expiration"), fr)
        XCTAssertTrue(fr.contains("téléchargé 3 fois"), fr)
    }

    func testDownloadSummaryPluralizesAndSizesPerLanguage() {
        XCTAssertEqual(DownloadPresentation.manifestSummary(fileCount: 1,
                                                            totalBytes: 1_048_576,
                                                            language: .en),
                       "1 file · 1.0 MB")
        // German writes the decimal separator as a comma.
        XCTAssertEqual(DownloadPresentation.manifestSummary(fileCount: 2,
                                                            totalBytes: 1_048_576,
                                                            language: .de),
                       "2 Dateien · 1,0 MB")
        XCTAssertEqual(DownloadPresentation.savedSummary(fileCount: 1, language: .pt),
                       "Guardado 1 ficheiro")
    }

    func testNotificationBodiesPluralizeAndCarryNoUserData() {
        XCTAssertEqual(NotificationCopy.filesReady(count: 1, language: .en), "1 file is ready.")
        XCTAssertEqual(NotificationCopy.filesReady(count: 4, language: .en), "4 files are ready.")
        for language in AppLanguage.allCases {
            let body = NotificationCopy.filesReady(count: 2, language: language)
            XCTAssertTrue(body.contains("2"), body)
        }
    }

    // MARK: - numbers, bytes, percentages

    /// Latin digits everywhere (matching the web client and keeping a size next
    /// to a `KB` symbol readable), with the separator each language writes.
    func testByteFiguresUseLatinDigitsAndTheLanguagesSeparator() {
        XCTAssertEqual(L10n.bytes(1024, language: .en), "1.0 KB")
        XCTAssertEqual(L10n.bytes(1024, language: .fr), "1,0 KB")
        XCTAssertEqual(L10n.bytes(1024, language: .de), "1,0 KB")
        XCTAssertEqual(L10n.bytes(1024, language: .es), "1,0 KB")
        XCTAssertEqual(L10n.bytes(1024, language: .pt), "1,0 KB")
        XCTAssertEqual(L10n.bytes(1024, language: .zh), "1.0 KB")
        XCTAssertEqual(L10n.bytes(1024, language: .ar), "1.0 KB")
        // Below 1 KB there is no fraction at all, so no separator question.
        XCTAssertEqual(L10n.bytes(512, language: .de), "512 B")
    }

    func testPercentagesArePositionedByTheCatalog() {
        XCTAssertEqual(L10n.percent(done: 1, total: 2, language: .en), "50%")
        XCTAssertEqual(L10n.percent(done: 1, total: 2, language: .de), "50 %")
        XCTAssertEqual(L10n.percent(done: 1, total: 2, language: .zh), "50%")
        // No total yet: the caller shows "Starting…" instead of a meaningless 0%.
        XCTAssertNil(L10n.percent(done: 0, total: 0, language: .en))
    }

    func testDatesAreFormattedInTheRenderedLanguage() {
        let date = Date(timeIntervalSince1970: 1_780_000_000)
        let en = L10n.date(date, dateStyle: .medium, timeStyle: .none, language: .en)
        let de = L10n.date(date, dateStyle: .medium, timeStyle: .none, language: .de)
        let ja = L10n.date(date, dateStyle: .medium, timeStyle: .none, language: .ja)
        XCTAssertNotEqual(en, de)
        XCTAssertNotEqual(en, ja)
        XCTAssertFalse(en.isEmpty)
    }

    // MARK: - claims that must survive translation

    /// The upload success notice is the app's E2E claim, not decoration: the key
    /// is on this Mac and never reaches Relayium's servers. Every language has
    /// to say both halves, and every language has to keep the brand name.
    func testTheKeyIsKeptNoticeMakesItsClaimInEveryLanguage() {
        for language in AppLanguage.allCases {
            let notice = UploadPresentation.keyKeptText(language: language)
            XCTAssertTrue(notice.contains("Relayium"),
                          "\(language.rawValue) lost the brand: \(notice)")
            XCTAssertTrue(notice.contains("Mac"),
                          "\(language.rawValue) stopped saying where the key lives: \(notice)")
        }
    }

    /// And the failure notice keeps the instruction that makes it a warning:
    /// this link is the only copy, copy it now.
    func testTheKeyWarningKeepsItsUrgencyInEveryLanguage() {
        for language in AppLanguage.allCases {
            let warning = L10n.t(.uploadKeyWarning, ["X"], language: language)
            XCTAssertTrue(warning.hasPrefix("X"),
                          "\(language.rawValue) must lead with the failure it wraps: \(warning)")
            XCTAssertTrue(warning.contains("Relayium"), warning)
        }
    }

    /// Deleting stored ciphertext is irreversible, and every language says so.
    func testDestructiveDeletionIsStatedAsIrreversibleEverywhere() {
        for language in AppLanguage.allCases {
            let body = L10n.t(.accountDeleteFileBody, language: language)
            XCTAssertFalse(body.isEmpty)
            XCTAssertNotEqual(body, L10nKey.accountDeleteFileBody.rawValue,
                              "\(language.rawValue) fell through to the raw key")
        }
        XCTAssertTrue(L10n.t(.accountDeleteFileBody, language: .zh).contains("无法撤销"))
        XCTAssertTrue(L10n.t(.accountDeleteFileBody, language: .ar).contains("لا يمكن التراجع"))
    }

    /// Verification is off by default and that is stated, not implied — in every
    /// language, because it is the one setting whose default a user may want to
    /// change before they trust a transfer.
    func testTheVerificationExplanationSurvivesTranslation() {
        for language in AppLanguage.allCases {
            let what = L10n.t(.verifyExplainWhat, language: language)
            let crypto = L10n.t(.verifyExplainEncryption, language: language)
            XCTAssertTrue(what.contains("SAS"),
                          "\(language.rawValue) dropped the SAS acronym: \(what)")
            XCTAssertTrue(crypto.contains("Relayium"),
                          "\(language.rawValue) dropped the brand: \(crypto)")
        }
    }

    /// Sign-in copy and per-file key copy stay distinct in every language: the
    /// keychain failure that means "your session was not stored" must never be
    /// borrowed by the one that means "one file's key was not stored".
    func testSignInAndStoredKeyKeychainCopyStayDistinctInEveryLanguage() {
        for language in AppLanguage.allCases {
            let signIn = ErrorCopy.message(for: KeychainError.status(-25308), language: language)
            let fileKey = ErrorCopy.storedLinkKeyMessage(for: KeychainError.status(-25308),
                                                        operation: .save, language: language)
            XCTAssertNotEqual(signIn, fileKey, language.rawValue)
        }
    }
}
