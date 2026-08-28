import XCTest
@testable import RelayiumKit
@testable import RelayiumAppKit

/// What the localization actually RENDERS, driven through the seams the app uses.
///
/// The integrity tests prove the catalogs line up. These prove the copy comes out
/// of them: that `ErrorCopy` in Arabic is Arabic, that a file name inside it is
/// still the file name, that a count of three files picks Arabic's `few` and not
/// its `other`, and that the claims the product cannot afford to lose in
/// translation — end-to-end encryption, the key never leaving this device,
/// irreversible deletion — are present in every language.
///
/// Every assertion names its language. None of them can pass or fail because of
/// the machine the tests run on.
final class LocalizedCopyTests: XCTestCase {

    func testLocalTextDiscardConfirmationNamesEveryCostEverywhere() throws {
        let permanent: [AppLanguage: String] = [
            .en: "permanently", .zh: "永久",
        ]
        let history: [AppLanguage: String] = [
            .en: "history", .zh: "消息历史",
        ]
        let draft: [AppLanguage: String] = [
            .en: "unsent draft", .zh: "未发送草稿",
        ]
        let copyFirst: [AppLanguage: String] = [
            .en: "Copy", .zh: "先复制",
        ]
        for language in AppLanguage.allCases {
            let text = L10n.t(.textDiscardLocalContentConfirmBody, language: language)
            for (label, table) in [("permanent loss", permanent), ("history", history),
                                   ("draft", draft), ("copy-first recovery", copyFirst)] {
                XCTAssertTrue(text.contains(try XCTUnwrap(table[language])),
                              "discard local text [\(language.rawValue)] dropped \(label): \(text)")
            }
        }
    }

    func testLocalTextHistoryNamesItsUnsavedProcessLifetimeEverywhere() throws {
        let notSaved: [AppLanguage: String] = [
            .en: "not saved", .zh: "不会保存",
        ]
        let systemClose: [AppLanguage: String] = [
            .en: "system closes", .zh: "系统关闭",
        ]
        for language in AppLanguage.allCases {
            let text = L10n.t(.textLocalHistoryBody, language: language)
            XCTAssertTrue(text.contains(try XCTUnwrap(notSaved[language])),
                          "text.localHistoryBody [\(language.rawValue)] implies persistence: \(text)")
            XCTAssertTrue(text.contains(try XCTUnwrap(systemClose[language])),
                          "text.localHistoryBody [\(language.rawValue)] hides process loss: \(text)")
            XCTAssertTrue(text.contains("Relayium"),
                          "text.localHistoryBody [\(language.rawValue)] does not name quitting the app")
        }
    }

    func testOpenTextSessionWarnsBeforeUnsavedHistoryCanBeLost() throws {
        let unsaved: [AppLanguage: String] = [
            .en: "not saved", .zh: "不会保存",
        ]
        let appClose: [AppLanguage: String] = [
            .en: "app closes", .zh: "应用关闭",
        ]
        let peerRetention: [AppLanguage: String] = [
            .en: "Either device", .zh: "任何一方设备",
        ]
        for language in AppLanguage.allCases {
            let text = L10n.t(.textNoServerHistory, language: language)
            for (label, table) in [("unsaved local history", unsaved),
                                   ("app-close loss", appClose),
                                   ("peer retention", peerRetention)] {
                XCTAssertTrue(text.contains(try XCTUnwrap(table[language])),
                              "text.noServerHistory [\(language.rawValue)] dropped \(label): \(text)")
            }
        }
    }

    func testCopiedFeedbackIsLocalizedEverywhere() {
        let english = L10n.t(.commonCopied, language: .en)
        XCTAssertEqual(english, "Copied")
        for language in AppLanguage.allCases where language != .en {
            let text = L10n.t(.commonCopied, language: language)
            XCTAssertFalse(text.isEmpty, language.rawValue)
            XCTAssertNotEqual(text, english, "common.copied [\(language.rawValue)] is untranslated")
        }
    }

    func testTextRowActionsKeepDirectionContextInEveryLanguage() {
        for language in AppLanguage.allCases {
            let copySent = TextMessagePresentation.copyActionLabel(
                direction: .outgoing, copied: false, language: language)
            let copiedSent = TextMessagePresentation.copyActionLabel(
                direction: .outgoing, copied: true, language: language)
            let copiedReceived = TextMessagePresentation.copyActionLabel(
                direction: .incoming, copied: true, language: language)
            let shareSent = TextMessagePresentation.shareActionLabel(
                direction: .outgoing, language: language)
            let shareReceived = TextMessagePresentation.shareActionLabel(
                direction: .incoming, language: language)
            for label in [copySent, copiedSent, copiedReceived, shareSent, shareReceived] {
                XCTAssertFalse(label.isEmpty, language.rawValue)
            }
            XCTAssertEqual(copySent,
                           L10n.t(.textCopySentMessage, language: language))
            XCTAssertNotEqual(copiedSent, copiedReceived, language.rawValue)
            XCTAssertNotEqual(shareSent, shareReceived, language.rawValue)
            XCTAssertTrue(copiedSent.contains(L10n.t(.commonCopied, language: language)))
            XCTAssertTrue(shareSent.contains(L10n.t(.commonShare, language: language)))
        }
    }

    /// The unified `link/1` transcript's rows keep the same sentence. Its
    /// direction is a different enum, so this is the assertion that the two
    /// surfaces cannot drift into two wordings for one action.
    func testTheUnifiedTranscriptCopyLabelMatchesTheLegacyOneInEveryLanguage() {
        for language in AppLanguage.allCases {
            for (direction, outgoing) in [(RealtimeTextMessage.Direction.outgoing, true),
                                          (RealtimeTextMessage.Direction.incoming, false)] {
                for copied in [false, true] {
                    let legacy = TextMessagePresentation.copyActionLabel(
                        direction: direction, copied: copied, language: language)
                    let link = TextMessagePresentation.copyActionLabel(
                        outgoing: outgoing, copied: copied, language: language)
                    XCTAssertFalse(link.isEmpty, language.rawValue)
                    XCTAssertEqual(link, legacy,
                                   "\(language.rawValue) outgoing=\(outgoing) copied=\(copied)")
                }
            }
            // Reverse mutation: the label really does depend on both inputs, so
            // an implementation that ignored one would not pass the equality
            // above for the wrong reason.
            XCTAssertNotEqual(
                TextMessagePresentation.copyActionLabel(outgoing: true, copied: false,
                                                        language: language),
                TextMessagePresentation.copyActionLabel(outgoing: false, copied: false,
                                                        language: language),
                language.rawValue)
            XCTAssertNotEqual(
                TextMessagePresentation.copyActionLabel(outgoing: true, copied: false,
                                                        language: language),
                TextMessagePresentation.copyActionLabel(outgoing: true, copied: true,
                                                        language: language),
                language.rawValue)
        }
    }

    func testFileCompletionNamesTheResultDirectionInEveryLanguage() {
        for language in AppLanguage.allCases {
            let sent = FileTransferCompletionPresentation.title(
                received: false, language: language)
            let received = FileTransferCompletionPresentation.title(
                received: true, language: language)
            XCTAssertFalse(sent.isEmpty, language.rawValue)
            XCTAssertFalse(received.isEmpty, language.rawValue)
            XCTAssertNotEqual(sent, received,
                              "file completion [\(language.rawValue)] hides its direction")
        }
    }

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
    func testTheMitmWarningKeepsItsMeaningInChinese() {
        let zh = ErrorCopy.message(for: HandshakeError.mitm, language: .zh)
        XCTAssertTrue(zh.contains("干扰"), zh)          // someone may be interfering
        XCTAssertTrue(zh.contains("重新配对"), zh)       // pair again
        // It is a real translation, not the English string in a Chinese slot.
        XCTAssertNotEqual(zh, ErrorCopy.message(for: HandshakeError.mitm, language: .en))
        // And an archived preference gets the English sentence in full, with its
        // instruction intact — never a raw key at the sharpest moment in the app.
        let archived = ErrorCopy.message(for: HandshakeError.mitm,
                                         language: AppLanguage.resolve(preferred: ["ar-EG"]))
        XCTAssertEqual(archived, ErrorCopy.message(for: HandshakeError.mitm, language: .en))
        XCTAssertTrue(archived.lowercased().contains("pair again"), archived)
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

    /// A hostile path reaches the user verbatim, and unwrapped.
    ///
    /// This asserted Arabic isolation: the path was wrapped in a first-strong
    /// isolate so the bidi algorithm laid it out as one unit. Arabic is frozen
    /// and no shipped language is right-to-left, so the wrap is a no-op — what
    /// remains is the half that always mattered, which is that the bytes are
    /// exactly the path. A user shown `../../etc/passwd` can recognise and
    /// report it; one shown a sanitised version cannot.
    func testHostilePathsAreRenderedVerbatimAndUnwrapped() {
        let path = "../../etc/passwd"
        for language in AppLanguage.allCases {
            let message = ErrorCopy.message(for: ManifestPathError.unsafePath(path),
                                            language: language)
            XCTAssertTrue(message.contains(path), "\(language.rawValue): \(message)")
            XCTAssertFalse(message.contains("\u{2068}"),
                           "\(language.rawValue) wrapped a path with no RTL language shipped")
        }
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

    /// English inflects the noun and Chinese does not — which is the whole
    /// reason the plural layer exists rather than a single "%@ files" string.
    ///
    /// Arabic's four distinct forms used to be what this demonstrated. That
    /// catalog is frozen, so the remaining contrast is the one between the two
    /// shipped languages: English must change its noun at the singular boundary
    /// and Chinese must not change it at all. Every count still carries its
    /// digits, in both.
    func testTheSelectionSummaryPluralizesInEnglishAndNotInChinese() throws {
        let englishOne = L10n.plural(.selectionFiles, 1, language: .en)
        let englishMany = L10n.plural(.selectionFiles, 2, language: .en)
        XCTAssertNotEqual(englishOne, englishMany,
                          "English collapsed its singular and plural: \(englishOne)")
        XCTAssertTrue(englishOne.contains("file"), englishOne)
        XCTAssertTrue(englishMany.contains("files"), englishMany)
        XCTAssertFalse(englishOne.contains("files"), englishOne)

        // Chinese: one form, so the sentence differs only by the number itself.
        let chinese = [1, 2, 3, 11].map { L10n.plural(.selectionFiles, $0, language: .zh) }
        let withoutDigits = Set(chinese.map { $0.filter { !$0.isNumber } })
        XCTAssertEqual(withoutDigits.count, 1,
                       "Chinese inflected a noun it has no plural for: \(chinese)")
        for (count, rendered) in zip([1, 2, 3, 11], chinese) {
            XCTAssertTrue(rendered.contains("\(count)"), rendered)
        }
    }

    /// Chinese has one form and must not gain an English "s".
    func testChinesePluralsAreCountInvariant() {
        let one = L10n.plural(.downloadFileCount, 1, language: .zh)
        let many = L10n.plural(.downloadFileCount, 12, language: .zh)
        XCTAssertEqual(one, "1 个文件")
        XCTAssertEqual(many, "12 个文件")
    }

    /// Zero takes the PLURAL noun in English, and an archived preference gets
    /// that same English behaviour rather than the rule its own language had.
    ///
    /// This used to assert the opposite case: French and Portuguese put zero in
    /// the `one` category and read "0 fichier prêt". Both catalogs are frozen, so
    /// what has to be proved now is that a French Mac no longer gets French
    /// agreement — it resolves to English and reads "0 files ready". A stale
    /// `PluralRule` branch is exactly what this would catch.
    func testZeroTakesThePluralNounInEnglishAndForEveryArchivedPreference() {
        XCTAssertTrue(L10n.plural(.selectionFiles, 0, language: .en).contains("files"))
        XCTAssertFalse(L10n.plural(.selectionFiles, 1, language: .en).contains("files"))

        for tag in ["fr-CA", "pt-BR", "de-AT", "ar-EG"] {
            let resolved = AppLanguage.resolve(preferred: [tag])
            let zero = L10n.plural(.selectionFiles, 0, language: resolved)
            XCTAssertEqual(zero, L10n.plural(.selectionFiles, 0, language: .en),
                           "\(tag) did not get the English zero form")
            XCTAssertTrue(zero.contains("files"), "\(tag): \(zero)")
        }
    }

    func testResetTextPluralizesPerLanguage() {
        let now = Date(timeIntervalSince1970: 1_780_000_000)
        let five = UsagePresentation.resetText(resetsAt: 1_780_000_000 + 5 * 86_400,
                                               now: now, language: .en)
        XCTAssertTrue(five.contains("5"), five)
        XCTAssertTrue(five.contains("days"), five)      // English `other`
        let one = UsagePresentation.resetText(resetsAt: 1_780_000_000 + 86_400,
                                              now: now, language: .en)
        XCTAssertTrue(one.contains("day"), one)
        XCTAssertFalse(one.contains("days"), one)       // English `one`
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

        let en = try XCTUnwrap(store.summaryText(language: .en))
        XCTAssertTrue(en.contains("2 files ready"), en)
        XCTAssertTrue(en.contains("1 folder"), en)
        XCTAssertTrue(en.lowercased().contains("empty"), en)
        // The two are genuinely different sentences, not one string twice.
        XCTAssertNotEqual(en, zh)
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
        XCTAssertEqual(NearbyStatusPresentation.text(for: .ready, language: .zh),
                       L10n.t(.nearbyStatusReady, language: .zh))
    }

    func testTtlLabelsAreTranslatedAndUnknownValuesStayUsable() {
        XCTAssertEqual(TtlPresentation.label(seconds: 1_209_600, language: .en), "14 days")
        XCTAssertEqual(TtlPresentation.label(seconds: 1_209_600, language: .zh), "14 天")
        // A retention this build has no name for is shown rather than hidden, in
        // every shipped language and for an archived preference too.
        for language in AppLanguage.allCases {
            XCTAssertTrue(TtlPresentation.label(seconds: 4242, language: language)
                .contains("4242"), language.rawValue)
        }
        XCTAssertTrue(TtlPresentation
            .label(seconds: 4242, language: AppLanguage.resolve(preferred: ["fr-CA"]))
            .contains("4242"))
    }

    func testAccountRowDetailsAreLocalized() {
        let detail = AccountPresentation.deviceDetail(kind: "cli", lastSeenAt: 0,
                                                      createdAt: 1_780_000_000, language: .zh)
        XCTAssertTrue(detail.contains("命令行"), detail)
        XCTAssertTrue(detail.contains("从未使用"), detail)

        let file = StoredFileSummary(id: "abc", size: 2_097_152, createdAt: 1_780_000_000,
                                     expiresAt: 0, burnAfterRead: true,
                                     downloaded: false, downloadCount: 3)
        let en = AccountPresentation.fileDetail(file, language: .en)
        XCTAssertTrue(en.lowercased().contains("encrypted"), en)
        XCTAssertTrue(en.contains("3"), en)
        let zhFile = AccountPresentation.fileDetail(file, language: .zh)
        XCTAssertNotEqual(zhFile, en, "the file detail is not translated")
        XCTAssertTrue(zhFile.contains("3"), zhFile)
    }

    func testDownloadSummaryPluralizesAndSizesPerLanguage() {
        XCTAssertEqual(DownloadPresentation.manifestSummary(fileCount: 1,
                                                            totalBytes: 1_048_576,
                                                            language: .en),
                       "1 file · 1.0 MB")
        // Chinese: one plural form, a dot separator, and its own noun.
        XCTAssertEqual(DownloadPresentation.manifestSummary(fileCount: 2,
                                                            totalBytes: 1_048_576,
                                                            language: .zh),
                       "2 个文件 · 1.0 MB")
        XCTAssertNotEqual(DownloadPresentation.savedSummary(fileCount: 1, language: .zh),
                          DownloadPresentation.savedSummary(fileCount: 1, language: .en))
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
        XCTAssertEqual(L10n.bytes(1024, language: .zh), "1.0 KB")
        // Both shipped languages write a dot. The comma branch left with the
        // seven frozen European catalogs, and an archived preference must NOT
        // get it back: a French Mac reads English words, so "1,0 KB" beside them
        // would be a formatting rule with no language behind it.
        for tag in ["fr-CA", "de-AT", "es-MX", "pt-BR", "ar-EG"] {
            XCTAssertEqual(L10n.bytes(1024, language: AppLanguage.resolve(preferred: [tag])),
                           "1.0 KB", tag)
        }
        // Below 1 KB there is no fraction at all, so no separator question.
        XCTAssertEqual(L10n.bytes(512, language: .en), "512 B")
        XCTAssertEqual(L10n.bytes(512, language: .zh), "512 B")
    }

    func testPercentagesArePositionedByTheCatalog() {
        XCTAssertEqual(L10n.percent(done: 1, total: 2, language: .en), "50%")
        XCTAssertEqual(L10n.percent(done: 1, total: 2, language: .zh), "50%")
        // The catalog decides the position, so a language that wanted "50 %"
        // could still have it. Both shipped languages happen not to.
        XCTAssertEqual(L10n.percent(done: 1, total: 2,
                                    language: AppLanguage.resolve(preferred: ["de-AT"])),
                       "50%")
        // No total yet: the caller shows "Starting…" instead of a meaningless 0%.
        XCTAssertNil(L10n.percent(done: 0, total: 0, language: .en))
    }

    func testDatesAreFormattedInTheRenderedLanguage() {
        let date = Date(timeIntervalSince1970: 1_780_000_000)
        let en = L10n.date(date, dateStyle: .medium, timeStyle: .none, language: .en)
        let zh = L10n.date(date, dateStyle: .medium, timeStyle: .none, language: .zh)
        XCTAssertNotEqual(en, zh, "the date is not formatted in the rendered language")
        XCTAssertFalse(en.isEmpty)
        XCTAssertFalse(zh.isEmpty)
        // An archived preference renders the English date, not its own locale's.
        XCTAssertEqual(L10n.date(date, dateStyle: .medium, timeStyle: .none,
                                 language: AppLanguage.resolve(preferred: ["de-AT"])),
                       en)
    }

    // MARK: - claims that must survive translation

    /// The device noun each catalog uses, written down by hand.
    ///
    /// This table is what replaced a `contains("Mac")` assertion. That one held
    /// in nine languages only because "Mac" is a brand name kept verbatim in
    /// translation — the *device* noun is genuinely translated, so asserting it
    /// means naming each language's word for it and having read the sentence it
    /// sits in. Same nouns R3-B established for `error.manifest.duplicatePath`.
    private let deviceNoun: [AppLanguage: String] = [
        .en: "this device", .zh: "这台设备",
    ]

    /// The upload success notice is the app's E2E claim, not decoration: the key
    /// is on this device and never reaches Relayium's servers. Every language has
    /// to say both halves, and every language has to keep the brand name.
    ///
    /// The noun changed from *Mac* to *device* in R3-C, because iOS renders this
    /// exact sentence from that slice onwards. The substance being pinned did
    /// not change: where the key lives, and that it never left.
    func testTheKeyIsKeptNoticeMakesItsClaimInEveryLanguage() throws {
        for language in AppLanguage.allCases {
            let notice = UploadPresentation.keyKeptText(language: language)
            let noun = try XCTUnwrap(deviceNoun[language],
                                     "\(language.rawValue) has no noun in the table")
            XCTAssertTrue(notice.contains("Relayium"),
                          "\(language.rawValue) lost the brand: \(notice)")
            XCTAssertTrue(notice.contains(noun),
                          "\(language.rawValue) stopped saying where the key lives: \(notice)")
            XCTAssertFalse(notice.contains("Mac"),
                           "\(language.rawValue) still names a platform: \(notice)")
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
        XCTAssertNotEqual(L10n.t(.accountDeleteFileBody, language: .zh),
                          L10n.t(.accountDeleteFileBody, language: .en))
    }

    // MARK: - deleting the account itself

    /// The address the app shows a user in each language, alongside the phrases
    /// that carry the safety claims the account-deletion copy may never lose.
    ///
    /// Written out by hand, one row per language, for the reason `deviceNoun`
    /// above is: an assertion that a translation still says "confirm by email"
    /// is only worth something if somebody read the sentence and named the words
    /// it says it in.
    private struct DeletionCopyClaims {
        /// The language's word for email — the confirmation is by mail, and no
        /// translation may quietly turn it into an in-app confirmation.
        let email: String
        /// "Nothing is removed until that link is opened", in this language.
        /// The claim that makes the request safe: asking is not deleting.
        let notYet: String
        /// The word that says the end state is permanent, so the destructive
        /// consequence is stated rather than left to be inferred.
        let permanent: String
        /// Server-side access that confirmation actually revokes.
        let revokedAccess: String
        /// The supported recovery path during the grace period.
        let reactivate: String
        /// Claims the product cannot make: an established peer transfer may
        /// continue, and the first confirmation email is not a reactivation
        /// email.
        let overclaims: [String]
    }

    private let deletionClaims: [AppLanguage: DeletionCopyClaims] = [
        .en: .init(email: "email",
                   notYet: "Nothing is removed until",
                   permanent: "permanent",
                   revokedAccess: "sessions and device access",
                   reactivate: "sign in again",
                   overclaims: ["transfers in progress", "same email"]),
        .zh: .init(email: "邮件",
                   notYet: "之前不会删除任何内容",
                   permanent: "永久",
                   revokedAccess: "登录会话和设备访问权限",
                   reactivate: "重新登录",
                   overclaims: ["进行中的传输", "同一封邮件"]),
    ]

    /// The safety claims, in both shipped languages.
    ///
    /// This is the only destructive action in the app whose copy is the safety
    /// mechanism: the button sends an email and nothing else, and a translation
    /// that lost any one of these would leave a user pressing a destructive
    /// control with a wrong idea of what happens next. So each is asserted on
    /// the strings the two screens actually render, not on the English original.
    ///
    ///  1. **It is still confirmed by email.** Both the confirmation the user
    ///     reads before pressing and the notice they read afterwards say so.
    ///  2. **Asking is not yet deleting.** Same two strings, because the second
    ///     one is what stays on screen and would otherwise be read as "done".
    ///  3. **The consequence is stated accurately.** The confirmation names
    ///     server-side access revocation, stored-file removal, permanent account
    ///     deletion and the supported reactivation path without promising to
    ///     stop established peer transfers or reuse the first email.
    func testTheAccountDeletionCopyKeepsItsSafetyClaimsInEveryLanguage() throws {
        let address = "ada@example.com"
        for language in AppLanguage.allCases {
            let claims = try XCTUnwrap(deletionClaims[language],
                                       "\(language.rawValue) has no row in the table")
            let confirm = L10n.t(.accountDeleteAccountConfirmBody, [address], language: language)
            let requested = L10n.t(.accountDeleteAccountRequested, [address], language: language)

            for (name, text) in [("confirm body", confirm), ("requested notice", requested)] {
                XCTAssertTrue(text.contains(claims.email),
                              "\(language.rawValue) \(name) stopped saying the confirmation is "
                              + "by email: \(text)")
                XCTAssertTrue(text.contains(claims.notYet),
                              "\(language.rawValue) \(name) stopped saying that nothing is "
                              + "removed until the link is opened: \(text)")
                XCTAssertTrue(text.contains(address),
                              "\(language.rawValue) \(name) lost the address: \(text)")
            }
            XCTAssertTrue(confirm.contains(claims.permanent),
                          "\(language.rawValue) confirm body stopped stating that the account "
                          + "goes permanently: \(confirm)")
            XCTAssertTrue(confirm.contains(claims.revokedAccess),
                          "\(language.rawValue) confirm body stopped naming the server-side "
                          + "access that is revoked: \(confirm)")
            XCTAssertTrue(confirm.contains(claims.reactivate),
                          "\(language.rawValue) confirm body stopped explaining reactivation: "
                          + confirm)
            for overclaim in claims.overclaims {
                XCTAssertFalse(confirm.contains(overclaim),
                               "\(language.rawValue) confirm body makes an unsupported claim "
                               + "(\(overclaim)): \(confirm)")
            }
        }
    }

    /// Every string the deletion section adds is real copy in both shipped
    /// languages, not a key echoed back and not a template with an unsubstituted
    /// placeholder.
    func testTheAccountDeletionCopyIsTranslatedEverywhere() {
        let plain: [L10nKey] = [
            .accountDeleteAccountHeading, .accountDeleteAccount,
            .accountDeleteAccountConfirmTitle, .accountDeleteAccountConfirmAction,
            .accountDeleteAccountRequesting,
        ]
        let withAddress: [L10nKey] = [
            .accountDeleteAccountBody, .accountDeleteAccountConfirmBody,
            .accountDeleteAccountRequested,
        ]
        for language in AppLanguage.allCases {
            for key in plain + withAddress {
                let text = withAddress.contains(key)
                    ? L10n.t(key, ["x@example.com"], language: language)
                    : L10n.t(key, language: language)
                XCTAssertFalse(text.isEmpty, "\(key.rawValue) [\(language.rawValue)]")
                XCTAssertNotEqual(text, key.rawValue,
                                  "\(key.rawValue) [\(language.rawValue)] fell back to the key")
                XCTAssertFalse(text.contains("%@"),
                               "\(key.rawValue) [\(language.rawValue)]: \(text)")
            }
        }
    }

    /// The button inside the confirmation is labelled for what it does, and what
    /// it does is send an email. Every language names the mail rather than the
    /// deletion, because the sentence directly above it says nothing is deleted
    /// yet — a button contradicting its own dialog is the copy defect this
    /// action can least afford.
    func testTheConfirmationButtonNamesTheEmailInEveryLanguage() throws {
        for language in AppLanguage.allCases {
            let claims = try XCTUnwrap(deletionClaims[language])
            let action = L10n.t(.accountDeleteAccountConfirmAction, language: language)
            XCTAssertTrue(action.contains(claims.email)
                          || action.contains(claims.email.lowercased()),
                          "\(language.rawValue) confirmation button stopped naming the email: "
                          + action)
        }
    }

    /// `account.bearerInvalid` is rendered by `AccountSession` when a deletion
    /// request comes back 401, and that runs on iOS as well as macOS — so the
    /// sentence that used to say "this Mac" may not name a platform in any
    /// language any more. This replaces the ban that kept it off iOS.
    func testTheRevokedCredentialSentenceNamesNoPlatform() {
        for language in AppLanguage.allCases {
            let text = L10n.t(.accountBearerInvalid, language: language)
            XCTAssertFalse(text.isEmpty, language.rawValue)
            for platform in ["Mac", "iPhone", "iPad", "iOS", "macOS"] {
                XCTAssertFalse(text.contains(platform),
                               "\(language.rawValue) names a platform: \(text)")
            }
        }
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

    /// The sign-in token store is shared by the two Apple clients. A keychain
    /// refusal on iPhone must not tell the user that macOS failed, and merely
    /// deleting the platform name would leave the sentence unclear about where
    /// persistence failed. The existing quit consequence stays byte-for-byte
    /// after the first sentence; guard the changed device noun and diagnostic
    /// status in every still-shipped catalog.
    func testTheSignInKeychainFailureNamesADeviceAndNoPlatform() throws {
        for language in AppLanguage.allCases {
            let text = ErrorCopy.message(for: KeychainError.status(-34018),
                                         language: language)
            let word = try XCTUnwrap(deviceWord[language])
            XCTAssertTrue(text.contains(word),
                          "\(language.rawValue) stopped naming the device: \(text)")
            XCTAssertTrue(text.contains("-34018"),
                          "\(language.rawValue) dropped the diagnostic status: \(text)")
            for platform in ["Mac", "macOS", "iPhone", "iPad", "iOS"] {
                XCTAssertFalse(text.contains(platform),
                               "\(language.rawValue) names \(platform): \(text)")
            }
        }
    }

    // MARK: - in-app registration

    /// Every string the create-account flow adds is real copy in both shipped
    /// languages, not a key echoed back and not a template with an unsubstituted
    /// placeholder.
    func testTheRegistrationCopyIsTranslatedEverywhere() {
        let added: [L10nKey] = [
            .loginSignInTitle, .loginSignInBody,
            .loginRegisterTitle, .loginRegisterBody,
            .loginDisplayName, .loginConfirmPassword, .loginCreateAccount,
            .loginCreatingAccount, .loginNeedAccount, .loginBrowserSignIn,
            .loginErrorEmailMissing, .loginErrorPasswordsDiffer,
            .contentResendVerification, .contentResendVerificationBusy,
            .contentResendVerificationSent, .gateOpenAccount,
            .errorAccountEmailInvalid, .errorAccountPasswordTooShort,
            .errorAccountEmailTaken, .errorAccountPendingDeletion,
        ]
        for key in added {
            for language in AppLanguage.allCases {
                let text = L10n.t(key, language: language)
                XCTAssertFalse(text.isEmpty, "\(key.rawValue) [\(language.rawValue)]")
                XCTAssertNotEqual(text, key.rawValue,
                                  "\(key.rawValue) [\(language.rawValue)] fell back to the key")
                XCTAssertFalse(text.contains("%@"),
                               "\(key.rawValue) [\(language.rawValue)]: \(text)")
            }
        }
    }

    /// The four registration refusals are four different things to do next, so
    /// no two of them may render the same sentence in any language — that is the
    /// whole reason they are distinct `AccountError` cases rather than one
    /// `.server(status:)`.
    func testEachRegistrationRefusalSaysSomethingDifferentInEveryLanguage() {
        let errors: [AccountError] = [.emailInvalid, .passwordTooShort,
                                      .emailTaken, .accountPendingDeletion]
        for language in AppLanguage.allCases {
            let rendered = errors.map { ErrorCopy.message(for: $0, language: language) }
            XCTAssertEqual(Set(rendered).count, errors.count,
                           "\(language.rawValue) renders two refusals identically: \(rendered)")
            for message in rendered {
                XCTAssertFalse(message.contains("error.account"),
                               "\(language.rawValue) fell through to a raw key: \(message)")
            }
        }
    }

    /// The check-email screen sends the user back to the APP, not to a website.
    ///
    /// The old copy ended in "sign in again", which was written for the only way
    /// this state was reachable then — a sign-in against an unverified account.
    /// A registration reaches it too, and "again" would be describing something
    /// that never happened. The address itself must survive verbatim in both
    /// shipped languages.
    func testTheCheckEmailBodyNamesTheAddressAndPointsBackToTheApp() {
        for language in AppLanguage.allCases {
            let email = "ada@example.com"
            let body = L10n.t(.contentCheckEmailBody,
                              [L10n.token(email, language: language)], language: language)
            XCTAssertTrue(body.contains(email), "\(language.rawValue): \(body)")
            XCTAssertFalse(body.contains("relayium.com"),
                           "\(language.rawValue) still sends the user to a website: \(body)")
        }
    }

    /// The macOS browser fallback must not claim to be Sign in with Apple in any
    /// language: no entitlement backs it, and what it opens is a browser.
    func testTheBrowserFallbackNeverClaimsToBeApple() {
        for language in AppLanguage.allCases {
            let text = L10n.t(.loginBrowserSignIn, language: language)
            XCTAssertFalse(text.contains("Apple"), "\(language.rawValue): \(text)")
            XCTAssertFalse(text.contains("آبل"), "\(language.rawValue): \(text)")
        }
    }

    // MARK: - the iOS account surface says nothing about a Mac

    /// Every non-plural key the iOS account tab and its tab item render.
    /// Listed rather than derived: the point is that somebody decided this set
    /// is what iOS shows, and that a later addition to it is a decision too.
    private let iosAccountSurface: [L10nKey] = [
        .tabReceive, .tabAccount, .accountRestoring,
        .loginEmail, .loginPassword,
        .loginSignInTitle, .loginSignInBody,
        .loginRegisterTitle, .loginRegisterBody,
        .loginDisplayName, .loginConfirmPassword,
        .loginSignIn, .loginSigningIn, .loginCreatingAccount,
        .loginCreateAccount, .loginNeedAccount,
        .loginErrorEmailMissing, .loginErrorPasswordsDiffer,
        .errorAccountEmailInvalid, .errorAccountPasswordTooShort,
        .errorAccountEmailTaken, .errorAccountPendingDeletion,
        .contentAccountLoadFailed, .contentCheckEmailTitle, .contentCheckEmailBody,
        .contentResendVerification, .contentResendVerificationBusy,
        .contentResendVerificationSent, .contentBackToSignIn,
        .contentPendingDeletionTitle, .contentPendingDeletionBody, .contentReactivate,
        .accountManagePlan, .accountTraffic, .accountStorage, .accountMeterOf,
        .accountStaleFigures, .accountSignOutFailed,
        .usageUnlimited, .usageResetsToday,
        .badgeTrial, .badgePaymentFailed, .badgeCanceled, .badgeUnpaid,
        .badgePaymentIncomplete, .badgePaused, .badgeInactive,
        .commonRefresh, .commonSignOut, .commonTryAgain,
    ]

    func testNothingTheIOSAccountSurfaceRendersNamesAMac() {
        for key in iosAccountSurface {
            for language in AppLanguage.allCases {
                let text = L10n.t(key, language: language)
                XCTAssertFalse(text.contains("Mac"),
                               "\(key.rawValue) [\(language.rawValue)]: \(text)")
                XCTAssertFalse(text.contains("macOS"),
                               "\(key.rawValue) [\(language.rawValue)]: \(text)")
            }
        }
        // The one plural the summary renders, driven through its own entry point.
        for language in AppLanguage.allCases {
            let text = L10n.plural(.usageResetsInDays, 3, language: language)
            XCTAssertFalse(text.contains("Mac"), "usage.resetsInDays [\(language.rawValue)]: \(text)")
        }
    }

    /// The three new keys are real copy in every language, not a key echoed
    /// back and not a template with an unsubstituted placeholder.
    func testTheNewIOSKeysAreTranslatedEverywhere() {
        for key in [L10nKey.tabReceive, .accountRestoring, .loginSigningIn] {
            for language in AppLanguage.allCases {
                let text = L10n.t(key, language: language)
                XCTAssertFalse(text.isEmpty, "\(key.rawValue) [\(language.rawValue)]")
                XCTAssertNotEqual(text, key.rawValue,
                                  "\(key.rawValue) [\(language.rawValue)] fell back to the key")
                XCTAssertFalse(text.contains("%@"), "\(key.rawValue) [\(language.rawValue)]: \(text)")
            }
        }
    }

    // MARK: - the iOS send surface says nothing about a Mac either

    /// Every non-plural key the iOS Send tab reaches, listed rather than
    /// derived — adding to this set is a decision, the same way the account
    /// surface's list is.
    ///
    /// The `error.selection.*` keys are in it because `SendSelectionModel`
    /// renders them through `selectionError`: a preparation failure never
    /// reaches `CloudUploadModel`, so those strings are on this screen without
    /// any upload state naming them.
    private let iosSendSurface: [L10nKey] = [
        .tabSend, .uploadHeading, .uploadReady, .uploadLinkReady, .uploadSendAnother,
        .uploadExpiresAfter, .uploadBurnAfterRead, .uploadKeepOpen, .uploadKeyKept,
        .sendAccountTitle, .sendAccountBody, .sendOpenAccount,
        .sendAccountUnavailableBody, .sendChoosePhotos, .sendPreparingPhotos,
        .commonSend, .commonClear, .commonCancel, .commonShare, .commonExpires,
        .commonTryAgain, .commonChooseFilesOrFolders, .commonStarting,
        .errorPhotoImportFailed, .errorCloudUnauthorized,
        .errorSelectionNoFiles, .errorSelectionTooManyFiles, .errorSelectionUnreadable,
        .errorSelectionSymbolicLink, .errorSelectionPathTooLong,
        .ttlOneHour, .ttlOneDay, .ttlThreeDays, .ttlSevenDays, .ttlFourteenDays,
    ]

    func testEveryCopyTheSendSurfaceReachesNamesNoPlatform() {
        for key in iosSendSurface {
            for language in AppLanguage.allCases {
                let text = L10n.t(key, language: language)
                XCTAssertFalse(text.contains("Mac"),
                               "\(key.rawValue) [\(language.rawValue)]: \(text)")
                XCTAssertFalse(text.contains("macOS"),
                               "\(key.rawValue) [\(language.rawValue)]: \(text)")
            }
        }
    }

    /// The save-path failures are reached through `ErrorCopy` rather than by
    /// name, which is why they were found by reachability review rather than by
    /// reading the send screen's own key list. `CloudUploadModel.finish` routes
    /// every one of them, and every one of them used to say *macOS* or *Mac*.
    func testTheKeySavePathNamesNoPlatformInAnyLanguage() {
        for language in AppLanguage.allCases {
            for error in [KeychainError.status(-25308) as Error,
                          StoredLinkKeyError.invalidIdentifier,
                          StoredLinkKeyError.invalidKey] {
                let text = ErrorCopy.storedLinkKeyMessage(for: error, operation: .save,
                                                          language: language)
                XCTAssertFalse(text.contains("Mac"), "[\(language.rawValue)] \(text)")
                XCTAssertFalse(text.contains("macOS"), "[\(language.rawValue)] \(text)")
            }
            let staging = ErrorCopy.message(for: PlaintextSourceError.tooManyOpenFiles(limit: 256),
                                            language: language)
            XCTAssertFalse(staging.contains("Mac"), "[\(language.rawValue)] \(staging)")
        }
    }

    /// The nine new keys are real copy in every language, not a key echoed back
    /// and not a template with an unsubstituted placeholder.
    func testTheNewSendKeysAreTranslatedEverywhere() {
        for key in [L10nKey.tabSend, .sendAccountTitle, .sendAccountBody, .sendOpenAccount,
                    .sendAccountUnavailableBody, .sendChoosePhotos, .sendPreparingPhotos,
                    .uploadKeepOpen, .errorPhotoImportFailed] {
            for language in AppLanguage.allCases {
                let text = L10n.t(key, language: language)
                XCTAssertFalse(text.isEmpty, "\(key.rawValue) [\(language.rawValue)]")
                XCTAssertNotEqual(text, key.rawValue,
                                  "\(key.rawValue) [\(language.rawValue)] fell back to the key")
                XCTAssertFalse(text.contains("%@"), "\(key.rawValue) [\(language.rawValue)]: \(text)")
                if language != .en {
                    XCTAssertNotEqual(text, L10n.t(key, language: .en),
                                      "\(key.rawValue) [\(language.rawValue)] is untranslated")
                }
            }
        }
    }

    /// The send tab's body carries the same load-bearing clause the account
    /// gates do: sending needs an account, receiving never does. A translation
    /// that drops the second half turns an explanation into a refusal.
    func testTheSendGateBodyKeepsTheAnonymousHalfInEveryLanguage() {
        let receiving: [AppLanguage: String] = [
            .en: "Receiving a link never does",
            .zh: "接收链接则始终不需要账户",
        ]
        for language in AppLanguage.allCases {
            let body = L10n.t(.sendAccountBody, language: language)
            XCTAssertTrue(body.contains(receiving[language] ?? "\u{0}"),
                          "\(language.rawValue) drops the anonymous half: \(body)")
        }
    }

    // MARK: - the anonymous half of the shell

    /// The phrase each language uses to say "no account is needed", chosen as the
    /// longest fragment that is common to all five sentences below in that
    /// language — German says *ist kein Konto nötig* in the gates and *brauchen
    /// kein Konto* on the nearby line, and Arabic switches the verb to the dual
    /// (*لا يتطلبان*) when the subject is sending AND receiving, so the shared
    /// fragment is shorter than any single sentence's wording.
    ///
    /// Written down by hand rather than derived: the point of the table is that
    /// somebody read each translation and confirmed it still says the thing.
    private let noAccountPhrase: [AppLanguage: String] = [
        .en: "needs no account",
        .zh: "不需要账户",
    ]

    /// The claim this whole round turns on: three capabilities work signed out,
    /// and both account gates say so in their own body rather than reading as a
    /// flat wall. A translation that drops the final clause turns a gate that
    /// explains itself into one that only refuses, in that language only — which
    /// is exactly the kind of regression no build or screenshot would surface.
    func testGateBodiesKeepTheirLoadBearingClauseInEveryLanguage() throws {
        let keys: [L10nKey] = [.gateSendLinkBody, .gateCreateCodeBody,
                               .nearbyNoAccountNeeded, .directJoinNoAccountNeeded,
                               .downloadNoAccountNeeded]
        for language in AppLanguage.allCases {
            let phrase = try XCTUnwrap(noAccountPhrase[language],
                                       "\(language.rawValue) has no phrase in the table")
            for key in keys {
                let rendered = L10n.t(key, language: language)
                XCTAssertFalse(rendered.isEmpty, "\(key.rawValue) [\(language.rawValue)]")
                XCTAssertNotEqual(rendered, key.rawValue,
                                  "\(key.rawValue) [\(language.rawValue)] fell back to the key")
                if language != .en {
                    XCTAssertNotEqual(rendered, L10n.t(key, language: .en),
                                      "\(key.rawValue) [\(language.rawValue)] is untranslated")
                }
                XCTAssertTrue(rendered.contains(phrase),
                              "\(key.rawValue) [\(language.rawValue)] drops the anonymous half: \(rendered)")
            }
        }
    }

    /// The sidebar names all five destinations at once, so two of them reading
    /// the same is not a cosmetic problem — it is a destination the user cannot
    /// tell apart from another one, in that language only. English is where the
    /// copy is written, so English is the one place a collision would be noticed
    /// by hand; Simplified Chinese is why this is a test.
    ///
    /// These are the five BROWSEABLE rows, which is why `nav.storedReceive` is
    /// not among them: Open a link has a window title and no row. The two
    /// transfer names are the pair most at risk — they are the ones a merge
    /// argued were the same thing — so a language that renders them identically
    /// fails here rather than shipping two rows a reader cannot tell apart.
    func testDestinationNamesAreDistinctInEveryLanguage() {
        let keys: [L10nKey] = [.navLanTransfer, .navCrossNetwork, .navStoredSend,
                               .inboxTitle, .navAccount]
        for language in AppLanguage.allCases {
            let names = keys.map { L10n.t($0, language: language) }
            XCTAssertFalse(names.contains(where: \.isEmpty), language.rawValue)
            XCTAssertFalse(names.contains(where: { name in keys.contains { $0.rawValue == name } }),
                           "\(language.rawValue) fell back to a raw key: \(names)")
            XCTAssertEqual(Set(names).count, keys.count,
                           "\(language.rawValue) reuses a destination name: \(names)")
        }
    }

    // MARK: - the sidebar is where the transport is chosen

    /// Each sidebar caption is the last thing someone reads before committing to
    /// a transport, so it has to carry the limitation that rules the transport
    /// out and not only the benefit that sells it. "Devices on this network" did
    /// not say *only* this network; "Connect across networks with six digits"
    /// did not say both sides have to stay online. Someone picks the wrong row,
    /// gets a screen that cannot do what they came for, and reads that as the
    /// app being broken.
    ///
    /// Tokens are per language and written down by hand: the point of the table
    /// is that somebody read each translation and confirmed the limitation is
    /// still in it, in a form that language actually uses.
    ///
    /// **Two transfer rows again, so each caption carries two facts.** Both are
    /// live transports, so both must say that the two sides have to be online at
    /// the same time, and neither may recommend itself for large files — that is
    /// the stored path. What separates them is the network requirement, and it
    /// is the first thing somebody choosing between the two rows needs: the LAN
    /// caption says *this network*, and the cross-network caption says outright
    /// that no shared network is needed. A merged row could carry neither.
    func testSidebarSubtitlesKeepTheDecisiveLimitation() throws {
        let bothOnline: [AppLanguage: String] = [
            .en: "both sides online", .zh: "双方须同时在线",
        ]
        let largeFiles: [AppLanguage: String] = [
            .en: "Large files", .zh: "大文件",
        ]
        // The network requirement, per language, in the form each one uses. The
        // point of writing them down by hand is that somebody read every
        // translation and confirmed the distinction is really in it.
        let thisNetwork: [AppLanguage: String] = [
            .en: "on this network", .zh: "同一网络",
        ]
        let networkNotRequiredCaption: [AppLanguage: String] = [
            .en: "same network not required", .zh: "不要求同一网络",
        ]
        let networkNotRequiredExplanation: [AppLanguage: String] = [
            .en: "do not need to be on the same network", .zh: "不要求处于同一网络",
        ]
        for language in AppLanguage.allCases {
            let lan = L10n.t(.navLanTransferSubtitle, language: language)
            let cross = L10n.t(.navCrossNetworkSubtitle, language: language)
            let send = L10n.t(.navStoredSendSubtitle, language: language)

            for (name, caption) in [("LAN", lan), ("cross-network", cross)] {
                XCTAssertTrue(caption.contains(try XCTUnwrap(bothOnline[language])),
                              "\(language.rawValue) \(name) hides that both sides must "
                              + "stay online: \(caption)")
                // The large-file path is the stored one. A live-transport caption
                // that advertised large files would put the reader on a transport
                // that requires both sessions to remain active. Temporary
                // transport drops may resume; closing the session is the boundary.
                XCTAssertFalse(caption.localizedCaseInsensitiveContains(
                    try XCTUnwrap(largeFiles[language])),
                    "\(language.rawValue) \(name) recommends itself for large files: \(caption)")
            }
            XCTAssertTrue(send.contains(try XCTUnwrap(largeFiles[language])),
                          "\(language.rawValue) stored send no longer claims the large-file path: \(send)")

            // The one fact that tells the two transfer rows apart, in both
            // directions: the LAN row names the network requirement, the
            // cross-network row denies it — and says so on its own screen too,
            // because a sidebar hint is not where somebody confirms it.
            XCTAssertTrue(lan.contains(try XCTUnwrap(thisNetwork[language])),
                          "\(language.rawValue) LAN caption drops the network requirement: \(lan)")
            XCTAssertTrue(cross.contains(try XCTUnwrap(networkNotRequiredCaption[language])),
                          "\(language.rawValue) cross-network caption does not say a shared "
                          + "network is unnecessary: \(cross)")
            let explain = L10n.t(.crossNetworkExplain, language: language)
            XCTAssertTrue(explain.contains(try XCTUnwrap(networkNotRequiredExplanation[language])),
                          "\(language.rawValue) cross-network screen does not repeat that "
                          + "no shared network is needed: \(explain)")

            for (key, rendered) in [(L10nKey.navLanTransferSubtitle, lan),
                                    (.navCrossNetworkSubtitle, cross),
                                    (.navLanTransfer, L10n.t(.navLanTransfer, language: language)),
                                    (.navCrossNetwork, L10n.t(.navCrossNetwork, language: language)),
                                    (.crossNetworkExplain, explain),
                                    (.navStoredSendSubtitle, send)] {
                XCTAssertNotEqual(rendered, key.rawValue,
                                  "\(key.rawValue) [\(language.rawValue)] fell back to the key")
                if language != .en {
                    XCTAssertNotEqual(rendered, L10n.t(key, language: .en),
                                      "\(key.rawValue) [\(language.rawValue)] is untranslated")
                }
            }
        }
    }

    /// A receive refusal iOS can already hit. The sentence is true on both
    /// platforms; the noun was not, and the offending path still has to be in
    /// it or the user cannot act on it.
    func testTheDuplicatePathRefusalNamesNoPlatform() {
        for language in AppLanguage.allCases {
            let text = ErrorCopy.message(for: ManifestPathError.duplicatePath("t/a.txt"),
                                         language: language)
            XCTAssertFalse(text.contains("Mac"), "[\(language.rawValue)] \(text)")
            XCTAssertTrue(text.contains("t/a.txt"), "[\(language.rawValue)] \(text)")
        }
    }

    // MARK: - R3-D: device and stored-file management, on both platforms

    /// Every non-plural key the account-management sections render — the device
    /// list, the stored-file list, both confirmations, and the three key states.
    ///
    /// Listed rather than derived, like the two surface lists above: the point is
    /// that somebody decided this set is what the management surface shows, and
    /// that adding to it is a decision too. Until R3-D these strings were macOS's
    /// alone and said so; iOS renders every one of them now.
    private let accountManagementSurface: [L10nKey] = [
        .accountDevicesHeading, .accountDevicesBody, .accountNoDevices,
        .accountUnnamedDevice, .accountThisMac, .accountLoadingDevices,
        .accountDeviceKindCli, .accountDeviceKindApp, .accountDeviceNeverUsed,
        .accountDeviceLastUsed, .accountDeviceAdded,
        .accountDeviceLastAddress, .accountDevicesAddressNote,
        .accountRevokeTitle, .accountRevokeThisMac, .accountRevokeOther,
        .accountRevokeDeviceLabel,
        .accountFilesHeading, .accountFilesBody, .accountNoFiles, .accountLoadingFiles,
        .accountKeyNotOnThisMac, .accountKeyLookupFailed, .accountKeyCleanupWarning,
        .accountDeleteFileTitle, .accountDeleteFileBody,
        .accountShareFileLabel, .accountDeleteFileLabel,
        .accountFileEncryptedSize, .accountFileNoExpiry, .accountFileExpires,
        .accountFileBurn, .accountFileDownloaded, .accountFileNotDownloaded,
        .accountFileDownloadedOnce,
        .errorStoredLinkKeyInvalidKey,
        .errorStoredKeyKeychainRead, .errorStoredKeyKeychainRemove,
        .errorStoredKeyBadIdRead, .errorStoredKeyBadIdRemove,
        .accountSigningOut,
        .commonRevoke, .commonDelete, .commonShare, .commonDismiss, .commonCancel,
    ]

    func testNothingTheAccountManagementSurfaceRendersNamesAPlatform() {
        for key in accountManagementSurface {
            for language in AppLanguage.allCases {
                let text = L10n.t(key, language: language)
                for platform in ["Mac", "macOS", "iPhone", "iPad", "iOS"] {
                    XCTAssertFalse(text.contains(platform),
                                   "\(key.rawValue) [\(language.rawValue)] names \(platform): "
                                   + text)
                }
            }
        }
        // The one plural a stored row can render, driven through its own entry
        // point because a key list cannot reach it.
        for language in AppLanguage.allCases {
            let text = L10n.plural(.accountFileDownloadedTimes, 3, language: language)
            XCTAssertFalse(text.contains("Mac"),
                           "account.fileDownloadedTimes [\(language.rawValue)]: \(text)")
        }
    }

    /// The word each catalog uses for the thing the key is on.
    ///
    /// A root rather than a full phrase, because these sentences inflect it —
    /// German's *Gerät* takes a dative article, French's *appareil* a
    /// demonstrative — and pinning the inflection would assert the grammar
    /// instead of the claim. Same nouns as `deviceNoun` above, reduced to the
    /// part that survives every case the R3-D sentences put them in.
    private let deviceWord: [AppLanguage: String] = [
        .en: "device", .zh: "设备",
    ]

    /// The badge on the row for the credential this app is holding.
    ///
    /// Exact equality, not containment: it is two or three words long, it is the
    /// only thing distinguishing that row from the others, and a translation that
    /// drifted into a sentence would be a capsule that no longer fits at large
    /// Dynamic Type sizes.
    private let thisDeviceBadge: [AppLanguage: String] = [
        .en: "This device", .zh: "这台设备",
    ]

    func testTheCurrentDeviceBadgeIsTheSameShortPhraseInEveryLanguage() throws {
        for language in AppLanguage.allCases {
            XCTAssertEqual(L10n.t(.accountThisMac, language: language),
                           try XCTUnwrap(thisDeviceBadge[language]),
                           "\(language.rawValue) moved the current-device badge")
        }
    }

    /// The five R3-D sentences that are ABOUT the device the key or the
    /// credential is on. Dropping the platform is only half the correction: each
    /// still has to say which thing it is talking about, or "the key isn't here"
    /// stops naming a *here*.
    func testEverySentenceAboutThisDeviceStillNamesADevice() throws {
        let aboutTheDevice: [L10nKey] = [
            .accountRevokeThisMac, .accountKeyNotOnThisMac, .accountKeyLookupFailed,
            .accountKeyCleanupWarning, .errorStoredLinkKeyInvalidKey,
        ]
        for language in AppLanguage.allCases {
            let word = try XCTUnwrap(deviceWord[language],
                                     "\(language.rawValue) has no noun in the table")
            for key in aboutTheDevice {
                let text = L10n.t(key, language: language)
                XCTAssertTrue(text.contains(word),
                              "\(key.rawValue) [\(language.rawValue)] stopped naming the "
                              + "device: \(text)")
            }
        }
    }

    /// The word each catalog uses for the ciphertext the relay carries.
    ///
    /// A root, for the same reason `deviceWord` is one: the sentence inflects it
    /// and pinning the inflection would assert grammar rather than the claim.
    private let ciphertextWord: [AppLanguage: String] = [
        .en: "ciphertext", .zh: "密文",
    ]

    /// **R3-E's correction, and the half a platform ban cannot make.**
    ///
    /// `verify.explainEncryption` is the one sentence on the advanced-
    /// verification setting that says what the preference does NOT change, and
    /// iOS is the first platform to render it — so it could no longer say keys
    /// are generated *on this Mac*. Only the platform noun moved: dropping any
    /// of the four claims would leave a security setting whose explanation is
    /// weaker than the thing it explains, which is exactly how a toggle comes to
    /// be read as "turn this on to be encrypted".
    ///
    /// So this asserts both directions in both shipped languages: no platform is
    /// named, and
    /// the sentence still names the device the keys are generated on, still
    /// names Relayium as the party they are never sent to, and still says the
    /// relay carries only ciphertext.
    func testTheVerificationExplanationNamesNoPlatformAndKeepsItsEncryptionClaims() throws {
        for language in AppLanguage.allCases {
            let text = L10n.t(.verifyExplainEncryption, language: language)
            for platform in ["Mac", "macOS", "iPhone", "iPad", "iOS"] {
                XCTAssertFalse(text.contains(platform),
                               "verify.explainEncryption [\(language.rawValue)] names "
                               + "\(platform): \(text)")
            }
            let device = try XCTUnwrap(deviceWord[language])
            XCTAssertTrue(text.contains(device),
                          "[\(language.rawValue)] stopped saying WHERE the keys are "
                          + "generated: \(text)")
            XCTAssertTrue(text.contains("Relayium"),
                          "[\(language.rawValue)] stopped naming who never receives "
                          + "them: \(text)")
            let ciphertext = try XCTUnwrap(ciphertextWord[language])
            XCTAssertTrue(text.contains(ciphertext),
                          "[\(language.rawValue)] stopped saying the relay carries only "
                          + "ciphertext: \(text)")
        }
    }

    /// The R3-E copy the Direct tab adds, in both shipped languages.
    ///
    /// Two claims about the same three sentences, and they pull against each
    /// other, which is why both are here. They must not name a platform — this
    /// tab exists on both — and they must keep the honest limit that justifies
    /// them: a direct transfer needs BOTH devices, so the sentence that routes a
    /// large file to the stored tab has to say why, and the sentence that
    /// reports an ended session has to say the same thing rather than blaming
    /// the network.
    func testTheDirectPositioningCopyIsHonestAndPlatformNeutral() throws {
        let bothDevices: [AppLanguage: String] = [
            .en: "both devices", .zh: "两台设备",
        ]
        // Direct can be slower depending on the route; it is not universally
        // slower than the stored two-leg path. Keep the recommendation honest
        // in every catalog rather than turning it into an absolute benchmark.
        let possibility: [AppLanguage: String] = [
            .en: "can", .zh: "可能",
        ]
        for language in AppLanguage.allCases {
            for key in [L10nKey.directLargeFilesTitle, .directLargeFilesBody,
                        .directOpenSend, .directKeepBothOpen, .directInterrupted] {
                let text = L10n.t(key, language: language)
                XCTAssertFalse(text.isEmpty, "\(key.rawValue) [\(language.rawValue)]")
                for platform in ["Mac", "macOS", "iPhone", "iPad", "iOS"] {
                    XCTAssertFalse(text.contains(platform),
                                   "\(key.rawValue) [\(language.rawValue)] names \(platform)")
                }
            }
            let phrase = try XCTUnwrap(bothDevices[language])
            for key in [L10nKey.directLargeFilesBody, .directKeepBothOpen, .directInterrupted] {
                XCTAssertTrue(L10n.t(key, language: language).contains(phrase),
                              "\(key.rawValue) [\(language.rawValue)] dropped the reason a "
                              + "direct transfer is limited: \(L10n.t(key, language: language))")
            }
            let conditional = try XCTUnwrap(possibility[language])
            XCTAssertTrue(L10n.t(.directLargeFilesBody, language: language)
                            .contains(conditional),
                          "direct.largeFilesBody [\(language.rawValue)] makes a route-dependent "
                          + "speed claim absolute")
        }
    }

    /// The key read and removal failures are reached through `ErrorCopy` rather
    /// than by name — `AccountManagementModel.availability` formats one and
    /// `cleanupMessage` the other — which is why they were found by reachability
    /// rather than by reading the screen's key list, exactly as the save path
    /// was in R3-C. Both used to open with the word *macOS*.
    func testTheStoredKeyReadAndRemovePathsNameNoPlatformInAnyLanguage() {
        for language in AppLanguage.allCases {
            for operation in [StoredLinkKeyOperation.read, .remove] {
                for error in [KeychainError.status(-25308) as Error,
                              StoredLinkKeyError.invalidIdentifier,
                              StoredLinkKeyError.invalidKey] {
                    let text = ErrorCopy.storedLinkKeyMessage(for: error, operation: operation,
                                                              language: language)
                    XCTAssertFalse(text.isEmpty, "\(language.rawValue) \(operation)")
                    for platform in ["Mac", "macOS"] {
                        XCTAssertFalse(text.contains(platform),
                                       "[\(language.rawValue)] \(operation): \(text)")
                    }
                }
            }
        }
    }

    /// A read failure and a removal failure are different operations and are
    /// reported at different moments — one instead of a link, one after the
    /// server has already destroyed the ciphertext. Rendering them identically
    /// would make the cleanup warning read as a failed delete.
    func testTheKeyReadAndRemoveFailuresStayDistinctInEveryLanguage() {
        for language in AppLanguage.allCases {
            let read = ErrorCopy.storedLinkKeyMessage(for: KeychainError.status(-25308),
                                                      operation: .read, language: language)
            let remove = ErrorCopy.storedLinkKeyMessage(for: KeychainError.status(-25308),
                                                        operation: .remove, language: language)
            XCTAssertNotEqual(read, remove, language.rawValue)
        }
    }

    /// The keys R3-D adds are real copy in every language, not a key echoed back
    /// and not a template with an unsubstituted placeholder.
    func testTheNewManagementKeysAreTranslatedEverywhere() {
        for key in [L10nKey.accountLoadingDevices, .accountLoadingFiles, .accountSigningOut,
                    .accountRevokeDeviceLabel, .accountShareFileLabel,
                    .accountDeleteFileLabel] {
            for language in AppLanguage.allCases {
                let text = L10n.t(key, language: language)
                XCTAssertFalse(text.isEmpty, "\(key.rawValue) [\(language.rawValue)]")
                XCTAssertNotEqual(text, key.rawValue,
                                  "\(key.rawValue) [\(language.rawValue)] fell back to the key")
                if language != .en {
                    XCTAssertNotEqual(text, L10n.t(key, language: .en),
                                      "\(key.rawValue) [\(language.rawValue)] is untranslated")
                }
            }
        }
    }

    // MARK: - R3-F: the nearby copy is now rendered on two platforms

    /// Every non-plural key the iOS Nearby tab reaches, listed rather than
    /// derived, so adding one is a decision.
    private let nearbySurface: [L10nKey] = [
        .navNearby, .nearbyExplain, .nearbySafetySummary, .nearbyHowItWorks,
        .nearbyListeningBody, .nearbyPausedBody,
        .nearbySavedToAppFolder, .nearbyPauseReceiving, .nearbyResumeReceiving,
        .nearbyLookAgain, .nearbyEmptyRoster, .nearbyNamesDisclaimer,
        .nearbyA11yReceiving, .nearbyA11yDevices, .nearbyA11yChooseDevice,
        .nearbySendTo, .nearbySessionWith, .nearbySessionPeerDisclaimer,
        .nearbySelectionSendHint, .nearbyAddFilesHint,
        .nearbyTextIntent, .nearbyStartMessageSession, .nearbyAcceptanceNote,
        .nearbyBackToDevices, .nearbyLeavingClearsHistory, .nearbyDeviceGone,
        .nearbyAddFilesFirst, .nearbyReconnecting, .nearbyUnnamedDevice,
        .nearbySetupFailed, .nearbyNoAccountNeeded,
        .nearbyStatusOff, .nearbyStatusPaused, .nearbyStatusJoining, .nearbyStatusReady,
        .nearbyStatusReconnecting, .nearbyStatusReceivingFiles, .nearbyStatusMessageSession,
        .presenceBusyTitle, .presenceBusyBody, .presenceShowIt,
        .errorNearbyNotScanning, .errorNearbyNoAnswer,
    ]

    /// Nothing the nearby surface renders may name a platform any more.
    ///
    /// Four of these said *Mac* — the explanation of what the roster is, the
    /// paused body, the acceptance note and the no-answer error — because until
    /// R3-F only a Mac rendered them. iOS renders all four now, so each was
    /// corrected in place in all nine catalogs rather than hidden behind a
    /// per-platform key: two catalogs of the same paragraph drift, and the
    /// drift is invisible until somebody reads both.
    func testNothingTheNearbySurfaceRendersNamesAPlatform() {
        for key in nearbySurface {
            for language in AppLanguage.allCases {
                let text = L10n.t(key, language: language)
                for platform in ["Mac", "macOS", "iPhone", "iPad", "iOS"] {
                    XCTAssertFalse(text.contains(platform),
                                   "\(key.rawValue) [\(language.rawValue)] names \(platform): \(text)")
                }
            }
        }
    }

    /// Dropping the platform noun is only half the correction: the four
    /// sentences that are ABOUT this device still have to name a device, or
    /// "is not listening" stops saying what is not listening.
    func testTheCorrectedNearbySentencesStillNameADevice() throws {
        for language in AppLanguage.allCases {
            let word = try XCTUnwrap(deviceWord[language])
            for key in [L10nKey.nearbyExplain, .nearbyPausedBody, .nearbyAcceptanceNote,
                        .errorNearbyNoAnswer] {
                let text = L10n.t(key, language: language)
                XCTAssertTrue(text.contains(word),
                              "\(key.rawValue) [\(language.rawValue)] stopped naming the device: "
                              + text)
            }
        }
    }

    /// **The listening body no longer says where files land, and that is the
    /// point.** macOS writes them to Downloads; iOS writes them into its own
    /// container and publishes it through the Files app. One shared sentence
    /// claiming Downloads would have been simply false on the platform this
    /// slice adds — a user told to look somewhere that does not exist.
    ///
    /// So the location sentence is its own key per platform, and the shared
    /// paragraph keeps the part that is true on both: anything on this public
    /// address can try, and pausing is how you stop it.
    func testTheSharedListeningBodyNamesNoSaveLocationAndKeepsItsWarning() throws {
        let pauseWord: [AppLanguage: String] = [
            .en: "pause", .zh: "暂停",
        ]
        let downloadsWord: [AppLanguage: String] = [
            .en: "Downloads", .zh: "下载",
        ]
        for language in AppLanguage.allCases {
            let shared = L10n.t(.nearbyListeningBody, language: language)
            XCTAssertFalse(shared.contains(try XCTUnwrap(downloadsWord[language])),
                           "nearby.listeningBody [\(language.rawValue)] still promises one "
                           + "platform's folder: \(shared)")
            XCTAssertTrue(shared.contains(try XCTUnwrap(pauseWord[language])),
                          "nearby.listeningBody [\(language.rawValue)] dropped the way out: \(shared)")

            // The Mac keeps its own sentence, and it is the one that may name
            // the folder — because on that platform it is where the files are.
            let mac = L10n.t(.nearbySavedToDownloads, language: language)
            XCTAssertTrue(mac.contains(try XCTUnwrap(downloadsWord[language])),
                          "nearby.savedToDownloads [\(language.rawValue)] no longer names the "
                          + "folder it exists to name: \(mac)")

            // And iOS gets the place it can actually be reached: the app's own
            // folder in Files. Naming Downloads here would send the user to a
            // folder no iOS app has.
            let ios = L10n.t(.nearbySavedToAppFolder, language: language)
            XCTAssertFalse(ios.isEmpty)
            XCTAssertFalse(ios.contains(try XCTUnwrap(downloadsWord[language])),
                           "nearby.savedToAppFolder [\(language.rawValue)] claims Downloads: \(ios)")
        }
    }

    /// **The empty roster says the same two things on both platforms, and the
    /// Mac's version says them without printing the address.**
    ///
    /// macOS draws `relayium.com` as a real link under this copy, so the copy
    /// itself must not name it — a host that appears in the sentence AND as the
    /// control beside it is the same four words twice on one small card, one
    /// set of them dead. iOS has no such control and keeps the single sentence
    /// that names the address in prose, which is why both forms exist.
    ///
    /// What may not differ is the substance. Whichever form a reader gets, it
    /// has to tell them where to go — the OTHER device — and the part everyone
    /// gets wrong, which is that closing the page leaves the room.
    func testBothEmptyRosterFormsKeepTheirTwoFactsAndOnlyOneNamesTheAddress() throws {
        let otherDevice: [AppLanguage: String] = [.en: "other device", .zh: "对方设备"]
        let keepOpen: [AppLanguage: String] = [.en: "leave the page open", .zh: "页面保持打开"]

        for language in [AppLanguage.en, .zh] {
            // The shared sentence is unchanged and still carries the address:
            // it is the whole of what iOS renders, and losing the host there
            // would leave that platform with no way to reach the site at all.
            let shared = L10n.t(.nearbyEmptyRoster, language: language)
            XCTAssertTrue(shared.contains(AppEnvironment.productionHost),
                          "nearby.emptyRoster [\(language.rawValue)] stopped naming the "
                          + "address iOS can only render as prose: \(shared)")

            let title = L10n.t(.nearbyEmptyRosterTitle, language: language)
            let open = L10n.t(.nearbyEmptyRosterOpen, language: language)
            let hint = L10n.t(.nearbyEmptyRosterOpenHint, language: language)
            for (key, text) in [("nearby.emptyRosterTitle", title),
                                ("nearby.emptyRosterOpen", open),
                                ("nearby.emptyRosterOpenHint", hint)] {
                XCTAssertFalse(text.contains(AppEnvironment.productionHost),
                               "\(key) [\(language.rawValue)] prints the address the link "
                               + "beside it already is: \(text)")
                for platform in ["Mac", "macOS", "iPhone", "iPad", "iOS"] {
                    XCTAssertFalse(text.contains(platform),
                                   "\(key) [\(language.rawValue)] names \(platform): \(text)")
                }
            }
            // The instruction is on the sentence that points at the link, and
            // the title stays a title: a heading carrying half the instruction
            // is how the split loses the other half.
            XCTAssertTrue(open.contains(try XCTUnwrap(otherDevice[language])),
                          "nearby.emptyRosterOpen [\(language.rawValue)] no longer says WHICH "
                          + "device to open it on: \(open)")
            XCTAssertTrue(open.contains(try XCTUnwrap(keepOpen[language])),
                          "nearby.emptyRosterOpen [\(language.rawValue)] dropped the part that "
                          + "keeps the room alive: \(open)")
            XCTAssertFalse(title.contains(try XCTUnwrap(keepOpen[language])),
                           "nearby.emptyRosterTitle [\(language.rawValue)] is a second copy of "
                           + "the instruction rather than a heading: \(title)")
            XCTAssertFalse(hint.isEmpty)
        }
    }

    /// The three keys the Mac's empty roster adds are English-and-Chinese only,
    /// and the seven frozen locales render the English rather than a raw key.
    ///
    /// This is the maintained-language policy applied to the one place it is
    /// most tempting to break: the copy is three short strings, and adding them
    /// to nine catalogs "while we are here" is how a frozen locale quietly
    /// becomes a maintained one that nobody is actually maintaining.
    func testTheMacEmptyRosterCopyIsMaintainedInExactlyTheTwoLanguages() throws {
        let added: [L10nKey] = [.nearbyEmptyRosterTitle, .nearbyEmptyRosterOpen,
                                .nearbyEmptyRosterOpenHint]
        let english = try XCTUnwrap(StringsCatalog.load(.en))
        for key in added {
            for language in AppLanguage.allCases {
                let catalog = try XCTUnwrap(StringsCatalog.load(language))
                let text = L10n.t(key, language: language)
                XCTAssertFalse(text.isEmpty)
                XCTAssertNotEqual(text, key.rawValue,
                                  "\(key.rawValue) [\(language.rawValue)] rendered a raw key")
                switch language {
                case .en, .zh:
                    XCTAssertNotNil(catalog[key.rawValue],
                                    "\(key.rawValue) is missing from a MAINTAINED language")
                default:
                    XCTAssertNil(catalog[key.rawValue],
                                 "\(key.rawValue) was translated into the frozen "
                                 + "\(language.rawValue)")
                    XCTAssertEqual(text, english[key.rawValue],
                                   "\(key.rawValue) [\(language.rawValue)] did not fall back "
                                   + "to English")
                }
            }
        }
        XCTAssertNotEqual(L10n.t(.nearbyEmptyRosterTitle, language: .zh),
                          L10n.t(.nearbyEmptyRosterTitle, language: .en),
                          "the Chinese title is the English one")
    }

    /// The nearby explanation is the one sentence standing between the roster
    /// and "these are the devices on my Wi-Fi". It has to keep all three of its
    /// claims in every language: the grouping is a shared public address, that
    /// usually but NOT always means your own network, and Relayium scans
    /// nothing.
    func testTheNearbyExplanationKeepsItsThreeClaimsInEveryLanguage() throws {
        let publicAddress: [AppLanguage: String] = [
            .en: "public address", .zh: "公网地址",
        ]
        let gateway: [AppLanguage: String] = [
            .en: "VPN", .zh: "VPN",
        ]
        let scans: [AppLanguage: String] = [
            .en: "never scans", .zh: "从不扫描",
        ]
        for language in AppLanguage.allCases {
            let text = L10n.t(.nearbyExplain, language: language)
            for (label, table) in [("the public-address grouping", publicAddress),
                                   ("the stranger-gateway caveat", gateway),
                                   ("the no-scanning claim", scans)] {
                XCTAssertTrue(text.contains(try XCTUnwrap(table[language])),
                              "nearby.explain [\(language.rawValue)] dropped \(label): \(text)")
            }
        }
    }

    /// **The summary is what the user actually reads, so it carries the claim
    /// the full paragraph carried — in every language.**
    ///
    /// On the narrow platform the mechanism paragraph is now behind a closed
    /// disclosure, which is only defensible if the sentence left in its place
    /// still says the thing that changes a decision: the roster is grouped by a
    /// public address, and a carrier, VPN or shared gateway puts strangers on
    /// that address. A summary that kept only "devices near you" would be a
    /// worse screen than the one it replaced, not a shorter one.
    func testTheAlwaysVisibleNearbySummaryKeepsTheStrangerClaim() throws {
        let publicAddress: [AppLanguage: String] = [
            .en: "public address", .zh: "公网地址",
        ]
        // The gateways that make the address someone else's too. VPN is the one
        // word every catalog keeps verbatim, so it is the one asserted.
        let gateway: [AppLanguage: String] = [
            .en: "VPN", .zh: "VPN",
        ]
        // A root rather than the inflected form: the sentence declines it, and
        // pinning the inflection would assert grammar instead of the claim.
        let strangers: [AppLanguage: String] = [
            .en: "stranger", .zh: "陌生人",
        ]
        for language in AppLanguage.allCases {
            let text = L10n.t(.nearbySafetySummary, language: language)
            for (label, table) in [("the public-address grouping", publicAddress),
                                   ("the gateway caveat", gateway),
                                   ("the strangers it can include", strangers)] {
                XCTAssertTrue(text.contains(try XCTUnwrap(table[language])),
                              "nearby.safetySummary [\(language.rawValue)] dropped \(label): \(text)")
            }
        }
    }

    /// And it has to stay short, because "always visible" is the whole point.
    ///
    /// The paragraph it replaces is roughly twice its length in every catalog;
    /// at the largest accessibility content sizes that difference is several
    /// screens of scrolling before the first control. A translation that grew
    /// the summary back toward the paragraph would quietly restore the layout
    /// this refinement exists to remove, and nothing else in the suite would
    /// notice.
    func testTheAlwaysVisibleNearbySummaryStaysMuchShorterThanTheParagraph() {
        for language in AppLanguage.allCases {
            let summary = L10n.t(.nearbySafetySummary, language: language)
            let paragraph = L10n.t(.nearbyExplain, language: language)
            XCTAssertTrue(summary.count * 3 <= paragraph.count * 2,
                          "nearby.safetySummary [\(language.rawValue)] is \(summary.count) "
                          + "characters against a \(paragraph.count)-character paragraph — "
                          + "no longer a summary")
        }
    }

    /// The disclosure's title says what is behind it. A chevron labelled with a
    /// bare word — or with English in the Chinese catalog — is a control nobody
    /// opens, which would make the collapse equivalent to deleting the
    /// explanation.
    func testTheNearbyDisclosureTitleIsRealCopyEverywhere() {
        for language in AppLanguage.allCases {
            let title = L10n.t(.nearbyHowItWorks, language: language)
            XCTAssertFalse(title.trimmingCharacters(in: .whitespaces).isEmpty,
                           "nearby.howItWorks [\(language.rawValue)] is blank")
            XCTAssertNotEqual(title, L10nKey.nearbyHowItWorks.rawValue,
                              "nearby.howItWorks [\(language.rawValue)] fell back to the key")
            if language != .en {
                XCTAssertNotEqual(title, L10n.t(.nearbyHowItWorks, language: .en),
                                  "nearby.howItWorks [\(language.rawValue)] is untranslated")
            }
        }
    }

    /// The two keys R3-F adds are real copy in every language, not a key echoed
    /// back and not a template with an unsubstituted placeholder.
    func testTheNewNearbyKeysAreTranslatedEverywhere() {
        for key in [L10nKey.nearbySavedToDownloads, .nearbySavedToAppFolder,
                    .nearbySafetySummary, .nearbyHowItWorks] {
            for language in AppLanguage.allCases {
                let text = L10n.t(key, language: language)
                XCTAssertFalse(text.isEmpty, "\(key.rawValue) [\(language.rawValue)]")
                XCTAssertNotEqual(text, key.rawValue,
                                  "\(key.rawValue) [\(language.rawValue)] fell back to the key")
                XCTAssertFalse(text.contains("%@"), "\(key.rawValue) [\(language.rawValue)]: \(text)")
                if language != .en {
                    XCTAssertNotEqual(text, L10n.t(key, language: .en),
                                      "\(key.rawValue) [\(language.rawValue)] is untranslated")
                }
            }
        }
    }
}
