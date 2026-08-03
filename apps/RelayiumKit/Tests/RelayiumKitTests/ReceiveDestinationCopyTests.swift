import XCTest
@testable import RelayiumKit
@testable import RelayiumAppKit

/// The five sentences iOS may not borrow from macOS, and the three it must.
///
/// `ErrorCopy` was written behind an `NSOpenPanel`: four of its
/// `DownloadDestinationError` arms end by sending the user back to the picker,
/// and two of those also describe *the folder you chose*. R3-A receives into one
/// app-owned folder and shows no picker, so borrowing any of the five would
/// leave the user holding a refusal plus an instruction they cannot carry out —
/// or, for `unsafeName`, a claim about a choice they never made.
///
/// Every language is asserted in both directions: that the shared copy really
/// does give the picker advice here, and that the iOS copy really does replace
/// it with something doable. A one-sided check would keep passing if the whole
/// mapping silently fell back to `ErrorCopy`. The other direction is checked
/// too — `ENOSPC`, `incomplete` and `exceedsManifest` name no picker and must
/// keep coming out of `ErrorCopy` byte for byte, or the two platforms drift.
final class ReceiveDestinationCopyTests: XCTestCase {

    /// Per language, all verbatim from the catalogs: the phrase the SHARED copy
    /// uses to send the user to a folder picker; the phrase the shared
    /// `unsafeName` uses to describe a folder the iOS user never chose; the
    /// shared `systemError` phrase, which is a different sentence from the
    /// picker one; the phrase that names the Files app in the replacements; and
    /// the fragment of the shared "won't merge" reason that has to survive into
    /// the directory message.
    private struct Expectation {
        let language: AppLanguage
        let pickerAdvice: String
        let chosenFolder: String
        let tryAnotherFolder: String
        let filesApp: String
        let mergeReason: String
    }

    private let expectations: [Expectation] = [
        .init(language: .en, pickerAdvice: "Choose another folder",
              chosenFolder: "outside the folder you chose",
              tryAnotherFolder: "Try another folder",
              filesApp: "Files app", mergeReason: "half-finished download"),
        .init(language: .de, pickerAdvice: "Wähle einen anderen Ordner",
              chosenFolder: "außerhalb des gewählten Ordners",
              tryAnotherFolder: "Versuch einen anderen Ordner",
              filesApp: "„Dateien“", mergeReason: "halb fertigen Download"),
        .init(language: .fr, pickerAdvice: "Choisissez un autre dossier",
              chosenFolder: "hors du dossier choisi",
              tryAnotherFolder: "Essayez un autre dossier",
              filesApp: "app Fichiers", mergeReason: "téléchargement inachevé"),
        .init(language: .es, pickerAdvice: "Elige otra carpeta",
              chosenFolder: "fuera de la carpeta que elegiste",
              tryAnotherFolder: "Prueba con otra carpeta",
              filesApp: "app Archivos", mergeReason: "descarga a medias"),
        .init(language: .pt, pickerAdvice: "Escolha outra pasta",
              chosenFolder: "fora da pasta que escolheu",
              tryAnotherFolder: "Tente outra pasta",
              filesApp: "app Ficheiros", mergeReason: "transferência a meio"),
        .init(language: .ja, pickerAdvice: "別のフォルダを選んでください",
              chosenFolder: "選んだフォルダの外",
              tryAnotherFolder: "別のフォルダをお試しください",
              filesApp: "「ファイル」App", mergeReason: "中断したダウンロード"),
        .init(language: .ko, pickerAdvice: "다른 폴더를 선택하세요",
              chosenFolder: "선택한 폴더 바깥",
              tryAnotherFolder: "다른 폴더로 시도하세요",
              filesApp: "파일 앱", mergeReason: "중단된 다운로드"),
        .init(language: .zh, pickerAdvice: "请另选一个文件夹",
              chosenFolder: "你所选文件夹之外",
              tryAnotherFolder: "请换一个文件夹",
              filesApp: "「文件」App", mergeReason: "半途而废的下载"),
        .init(language: .ar, pickerAdvice: "اختر مجلدًا آخر",
              chosenFolder: "خارج المجلد الذي اخترته",
              tryAnotherFolder: "جرّب مجلدًا آخر",
              filesApp: "«الملفات»", mergeReason: "تنزيل غير مكتمل"),
    ]

    /// Nine, so a language added to `AppLanguage` without a row here fails
    /// instead of quietly going unchecked.
    func testEveryShippedLanguageIsCovered() {
        XCTAssertEqual(Set(expectations.map(\.language)), Set(AppLanguage.allCases))
    }

    /// Every re-worded case, so a case added to the iOS formatter without a row
    /// here is not silently untested either. `systemError` appears three times
    /// because it is three different answers.
    private var reworded: [DownloadDestinationError] {
        [
            .fileExists(name: "notes.txt"),
            .directoryExists(name: "relayium-abc123"),
            .unsafeName("../../escape.txt"),
            .systemError(EACCES),
            .systemError(EPERM),
            .systemError(EIO),
        ]
    }

    // MARK: - the shared copy is what it is here for

    /// The negative assertions below only mean something if the shared strings
    /// still say what this whole file exists to replace. Asserted first, per
    /// language, and per case — including the two the shared copy gets wrong
    /// about iOS rather than merely unhelpful (`unsafeName`'s *folder you
    /// chose*), and `systemError`, whose picker sentence is worded differently
    /// from the other four and would otherwise go unchecked.
    ///
    /// This is also the guard on the macOS side of the seam: none of these
    /// `error.destination.*` strings was touched, in any of the nine catalogs.
    func testTheSharedCopyStillGivesTheAdviceThisFileReplaces() {
        for e in expectations {
            func shared(_ error: DownloadDestinationError) -> String {
                ErrorCopy.message(for: error, language: e.language)
            }
            for error: DownloadDestinationError in [.fileExists(name: "a.txt"),
                                                    .directoryExists(name: "a"),
                                                    .systemError(EACCES),
                                                    .systemError(EPERM)] {
                XCTAssertTrue(shared(error).contains(e.pickerAdvice),
                              "\(e.language.rawValue): the shared copy for \(error) no longer "
                              + "gives the picker advice this test exists to replace — "
                              + shared(error))
            }
            XCTAssertTrue(shared(.unsafeName("x")).contains(e.chosenFolder),
                          "\(e.language.rawValue): the shared unsafeName copy no longer claims a "
                          + "folder the user chose — \(shared(.unsafeName("x")))")
            XCTAssertTrue(shared(.systemError(EIO)).contains(e.tryAnotherFolder),
                          "\(e.language.rawValue): the shared systemError copy no longer sends "
                          + "the user to another folder — \(shared(.systemError(EIO)))")
        }
    }

    // MARK: - no re-worded case may name a picker

    /// The one claim that has to hold for all five at once, in all nine: nothing
    /// the iOS user reads points at a folder picker, in either of the two
    /// wordings the shared catalog uses for one.
    func testNoRewordedCaseSendsAnIOSUserToAFolderPicker() {
        for e in expectations {
            for error in reworded {
                let ios = ReceiveDestinationCopy.message(for: error, language: e.language)
                XCTAssertFalse(ios.contains(e.pickerAdvice),
                               "\(e.language.rawValue) still sends an iOS user to a folder "
                               + "picker for \(error): \(ios)")
                XCTAssertFalse(ios.contains(e.tryAnotherFolder),
                               "\(e.language.rawValue) still offers another folder for "
                               + "\(error): \(ios)")
                XCTAssertNotEqual(ios, ErrorCopy.message(for: error, language: e.language),
                                  "\(e.language.rawValue) fell back to the shared copy for "
                                  + "\(error)")
            }
        }
    }

    /// Every argument substituted, in every language and every re-worded case. A
    /// translation that dropped `%2$@`, or a call site that passed one argument
    /// to a two-argument key, shows up on screen as a literal `%@` — or, worse,
    /// as `String(format:)` reading an argument nobody passed.
    func testNoRewordedMessageLeavesAPlaceholderOnScreen() {
        for e in expectations {
            for error in reworded {
                let ios = ReceiveDestinationCopy.message(for: error, language: e.language)
                XCTAssertFalse(ios.contains("%"),
                               "\(e.language.rawValue) left a placeholder in \(error): \(ios)")
                XCTAssertFalse(ios.isEmpty, "\(e.language.rawValue): \(error)")
                XCTAssertFalse(ios.hasPrefix("error.destination"),
                               "\(e.language.rawValue) rendered the raw key for \(error): \(ios)")
            }
        }
    }

    // MARK: - a taken file name

    func testAFileCollisionSendsTheUserToFilesInEveryLanguage() {
        let name = "notes.txt"
        for e in expectations {
            let ios = ReceiveDestinationCopy.message(
                for: DownloadDestinationError.fileExists(name: name), language: e.language)

            XCTAssertTrue(ios.contains(e.filesApp),
                          "\(e.language.rawValue) never names the Files app: \(ios)")
            XCTAssertTrue(ios.contains(name),
                          "\(e.language.rawValue) lost the colliding name: \(ios)")
            XCTAssertTrue(ios.contains(ReceiveDestination.folderName),
                          "\(e.language.rawValue) never says which folder to look in: \(ios)")
        }
    }

    // MARK: - a taken container

    /// The directory case has to do both things at once: keep the shared reason
    /// for refusing to merge — Relayium cannot tell a half-finished download
    /// from the user's own files — and still end somewhere the user can go.
    func testADirectoryCollisionKeepsTheSharedReasonAndAddsTheRecovery() {
        let name = "relayium-abc123"
        for e in expectations {
            let ios = ReceiveDestinationCopy.message(
                for: DownloadDestinationError.directoryExists(name: name), language: e.language)

            XCTAssertTrue(ios.contains(e.mergeReason),
                          "\(e.language.rawValue) dropped the reason it will not merge: \(ios)")
            XCTAssertTrue(ios.contains(e.filesApp), "\(e.language.rawValue): \(ios)")
            XCTAssertTrue(ios.contains(name), "\(e.language.rawValue): \(ios)")
        }
    }

    // MARK: - an unsafe name

    /// The one re-worded case that names no folder at all, and the reason it is
    /// re-worded is not the advice but the CLAIM: the shared sentence says the
    /// file would land outside the folder the user chose, and on iOS there was
    /// no choice. What survives is what is true and what helps — the link asked
    /// for a path the app will not write, nothing was saved, and only the sender
    /// can fix it.
    func testAnUnsafeNameBlamesTheLinkRatherThanAFolderTheUserNeverChose() {
        let unsafe = "../../etc/passwd"
        for e in expectations {
            let ios = ReceiveDestinationCopy.message(
                for: DownloadDestinationError.unsafeName(unsafe), language: e.language)

            XCTAssertFalse(ios.contains(e.chosenFolder),
                           "\(e.language.rawValue) still tells an iOS user they chose a folder: "
                           + ios)
            XCTAssertTrue(ios.contains(unsafe),
                          "\(e.language.rawValue) lost the unsafe path: \(ios)")
            // Nothing about the destination belongs in this one — the receive
            // folder is not what failed.
            XCTAssertFalse(ios.contains(ReceiveDestinationCopy.filesAppFolder + "/"),
                           "\(e.language.rawValue) names a folder irrelevant to this failure: "
                           + ios)
        }
    }

    // MARK: - the two write failures

    /// EACCES and EPERM name the fixed folder and offer the only recovery that
    /// exists for it. The folder is named because the message is otherwise
    /// unplaceable — "Relayium can't write" says nothing about where — and the
    /// recovery is a retry and a report, because there is no second folder and
    /// pretending otherwise is what this file exists to stop.
    func testTheNotPermittedCasesNameTheFixedFolderInEveryLanguage() {
        for e in expectations {
            for code in [EACCES, EPERM] {
                let ios = ReceiveDestinationCopy.message(
                    for: DownloadDestinationError.systemError(code), language: e.language)

                XCTAssertTrue(ios.contains(e.filesApp),
                              "\(e.language.rawValue) (errno \(code)) never names the Files app: "
                              + ios)
                XCTAssertTrue(ios.contains("Relayium/Received"),
                              "\(e.language.rawValue) (errno \(code)) never names the receive "
                              + "folder: \(ios)")
            }
            // Same key for both, deliberately: they are one condition to the
            // user, and the errno is not diagnosable enough here to be worth
            // showing.
            XCTAssertEqual(
                ReceiveDestinationCopy.message(for: DownloadDestinationError.systemError(EACCES),
                                               language: e.language),
                ReceiveDestinationCopy.message(for: DownloadDestinationError.systemError(EPERM),
                                               language: e.language),
                e.language.rawValue)
        }
    }

    /// Any other errno keeps the number, because it is the only diagnosable part
    /// of the failure and the recovery it leads to is a bug report.
    func testAnyOtherSystemErrorKeepsTheErrnoAndTheFolder() {
        for e in expectations {
            for code in [EIO, EROFS, EDQUOT] {
                let ios = ReceiveDestinationCopy.message(
                    for: DownloadDestinationError.systemError(code), language: e.language)

                XCTAssertTrue(ios.contains(String(code)),
                              "\(e.language.rawValue) dropped errno \(code): \(ios)")
                XCTAssertTrue(ios.contains("Relayium/Received"),
                              "\(e.language.rawValue) never names the receive folder: \(ios)")
                XCTAssertTrue(ios.contains(e.filesApp),
                              "\(e.language.rawValue) never names the Files app: \(ios)")
            }
        }
    }

    /// Nine distinct translations, not English nine times. The catalogs are
    /// checked for completeness elsewhere; this checks that the LOOKUP for every
    /// re-worded key resolves per language rather than falling back.
    func testEveryRewordedMessageIsTranslatedInEveryLanguage() {
        let english = reworded.map { ReceiveDestinationCopy.message(for: $0, language: .en) }
        for language in AppLanguage.allCases where language != .en {
            let translated = reworded.map {
                ReceiveDestinationCopy.message(for: $0, language: language)
            }
            for (index, pair) in zip(translated, english).enumerated() {
                XCTAssertNotEqual(pair.0, pair.1,
                                  "\(language.rawValue) still shows the English copy for "
                                  + "\(reworded[index])")
            }
        }
    }

    // MARK: - which folder the item is actually in

    /// Two locations, one level apart, because the two ways a receive collides
    /// are one level apart. Naming the wrong one sends the user into a folder
    /// the item is not in — and in the `.appFolder` case, into something that in
    /// this very failure is not a folder at all.
    func testTheLocationDecidesWhichFolderPathIsNamed() {
        let inside = ReceiveDestinationCopy.message(
            for: DownloadDestinationError.fileExists(name: "notes.txt"),
            in: .receiveFolder, language: .en)
        XCTAssertTrue(inside.contains("Relayium/Received"), inside)

        // What `ReceiveDestination.directory(inDocuments:)` raises: the item is
        // occupying the receive folder's own name, so it sits BESIDE it.
        let beside = ReceiveDestinationCopy.message(
            for: DownloadDestinationError.fileExists(name: ReceiveDestination.folderName),
            in: .appFolder, language: .en)
        XCTAssertTrue(beside.contains("in Relayium,"), beside)
        XCTAssertFalse(beside.contains("Relayium/Received"),
                       "the item is beside the receive folder, not inside it: \(beside)")
    }

    /// `.receiveFolder` is the default, because it is where all but one of the
    /// collisions happen — and where every write that can fail with EACCES or an
    /// errno happens. Asserted rather than assumed, since getting it backwards
    /// would be invisible at every call site that omits the argument.
    func testTheDefaultLocationIsTheReceiveFolder() {
        for error: DownloadDestinationError in [.directoryExists(name: "photos"),
                                                .systemError(EACCES),
                                                .systemError(EIO)] {
            XCTAssertEqual(ReceiveDestinationCopy.message(for: error, language: .en),
                           ReceiveDestinationCopy.message(for: error, in: .receiveFolder,
                                                          language: .en),
                           "\(error)")
        }
    }

    // MARK: - where the files ended up

    /// The done state has to name the route the whole way down.
    ///
    /// `Relayium` and `Relayium/Received` are one tap apart in the Files app and
    /// only one of them contains anything: the app's own folder holds the
    /// receive folder, not the files. A success sentence that stopped at
    /// `Relayium` would be the one message the user acts on after a transfer
    /// they cannot see yet — and it would send them to an apparently empty
    /// folder. So this asserts both halves: the full route is there, and no
    /// `Relayium` is left standing on its own.
    func testTheDoneStateNamesTheFullRouteInEveryLanguage() {
        for e in expectations {
            let done = ReceiveDestinationCopy.savedLocation(language: e.language)

            XCTAssertTrue(done.contains("Relayium/Received"),
                          "\(e.language.rawValue) does not say where the files are: \(done)")
            // Every mention of the app folder must be part of the route. What
            // this catches is precisely the copy this test replaced: *in the
            // Relayium folder*, one level above the files.
            XCTAssertFalse(done.replacingOccurrences(of: "Relayium/Received", with: "")
                               .contains(ReceiveDestinationCopy.filesAppFolder),
                           "\(e.language.rawValue) names the app folder alone, which is not "
                           + "where the files are: \(done)")
            XCTAssertTrue(done.contains(e.filesApp),
                          "\(e.language.rawValue) never names the Files app: \(done)")
            XCTAssertFalse(done.contains("%"),
                           "\(e.language.rawValue) left a placeholder: \(done)")
            XCTAssertFalse(done.hasPrefix("download.savedLocation"),
                           "\(e.language.rawValue) rendered the raw key: \(done)")
        }
    }

    /// And it names it from the same source as the failures, rather than from a
    /// literal that can be edited in one place and not the other. Renaming the
    /// receive folder has to move both sentences or neither.
    func testTheDoneStateRouteIsTheSameOneTheFailuresName() {
        let route = ReceiveDestinationCopy.Location.receiveFolder.path
        XCTAssertEqual(route,
                       ReceiveDestinationCopy.filesAppFolder + "/"
                       + ReceiveDestination.folderName)
        for e in expectations {
            XCTAssertTrue(ReceiveDestinationCopy.savedLocation(language: e.language)
                            .contains(route), e.language.rawValue)
            XCTAssertTrue(ReceiveDestinationCopy.message(
                for: DownloadDestinationError.systemError(EACCES),
                language: e.language).contains(route), e.language.rawValue)
        }
    }

    /// Nine translations of it, not English nine times — the same guard the
    /// re-worded errors get, because the interpolation made this key a format
    /// string and a lookup that fell back would still substitute correctly.
    func testTheDoneStateIsTranslatedInEveryLanguage() {
        let english = ReceiveDestinationCopy.savedLocation(language: .en)
        for language in AppLanguage.allCases where language != .en {
            XCTAssertNotEqual(ReceiveDestinationCopy.savedLocation(language: language), english,
                              "\(language.rawValue) still shows the English copy")
        }
    }

    // MARK: - RTL

    /// Under Arabic every interpolation is wrapped in a first-strong isolate,
    /// and the bytes between the marks are still exactly what was passed — so a
    /// hostile name cannot rearrange the sentence around it, and the user can
    /// still read and copy the value they have to act on or report.
    func testArabicIsolatesEveryInterpolationWithoutAlteringIt() {
        // U+202E RIGHT-TO-LEFT OVERRIDE, escaped rather than typed: a sender can
        // put one in a file name, and this source file should not carry one.
        let name = "\u{202E}report.pdf"
        func isolated(_ value: String) -> String { "\u{2068}" + value + "\u{2069}" }

        let collision = ReceiveDestinationCopy.message(
            for: DownloadDestinationError.fileExists(name: name), language: .ar)
        XCTAssertTrue(collision.contains(isolated(name)), collision)
        XCTAssertTrue(collision.contains(isolated("Relayium/Received")), collision)

        let unsafe = ReceiveDestinationCopy.message(
            for: DownloadDestinationError.unsafeName(name), language: .ar)
        XCTAssertTrue(unsafe.contains(isolated(name)), unsafe)

        let notPermitted = ReceiveDestinationCopy.message(
            for: DownloadDestinationError.systemError(EACCES), language: .ar)
        XCTAssertTrue(notPermitted.contains(isolated("Relayium/Received")), notPermitted)

        // Two in one sentence: the folder and the errno, each its own unit, so
        // neither is reordered into the other.
        let systemError = ReceiveDestinationCopy.message(
            for: DownloadDestinationError.systemError(EIO), language: .ar)
        XCTAssertTrue(systemError.contains(isolated("Relayium/Received")), systemError)
        XCTAssertTrue(systemError.contains(isolated(String(EIO))), systemError)

        // The success sentence too: the route is a technical value in Arabic
        // prose exactly as it is in the failures, and a route the bidi algorithm
        // reordered would read as folders in an order that does not exist.
        let done = ReceiveDestinationCopy.savedLocation(language: .ar)
        XCTAssertTrue(done.contains(isolated("Relayium/Received")), done)
        for language in AppLanguage.allCases where language != .ar {
            XCTAssertFalse(ReceiveDestinationCopy.savedLocation(language: language)
                            .contains("\u{2068}"),
                           "\(language.rawValue) wrapped a technical value it should not have")
        }
    }

    // MARK: - everything else is the shared copy

    /// The seam is exactly as wide as the platform difference and no wider. A
    /// full disk is a full disk on both platforms, and *free up space and try
    /// again* names no picker; the incomplete cases are about the bytes that
    /// arrived, not about where they were going. Those must come out of
    /// `ErrorCopy` byte for byte, in every language — along with every error
    /// that is not a destination error at all — so the two platforms cannot
    /// drift into explaining one rule two ways.
    func testEverythingWithoutAPlatformDifferenceIsHandedStraightToErrorCopy() {
        let others: [Error] = [
            DownloadDestinationError.systemError(ENOSPC),
            DownloadDestinationError.incomplete,
            DownloadDestinationError.exceedsManifest,
            CloudError.downloadLimited,
            CloudError.notFound,
            HandshakeError.mitm,
            ManifestPathError.unsafePath("../../etc/passwd"),
        ]
        for language in AppLanguage.allCases {
            for error in others {
                XCTAssertEqual(ReceiveDestinationCopy.message(for: error, language: language),
                               ErrorCopy.message(for: error, language: language),
                               "\(language.rawValue) re-worded \(error) for no reason")
            }
        }
    }

    /// ENOSPC specifically, spelled out: it is a `systemError` like the two that
    /// ARE re-worded, so it is the one case where the routing could plausibly be
    /// got wrong in either direction, and the assertion above would still pass
    /// if the iOS catalog happened to hold a byte-identical copy of the shared
    /// string. This pins the KEY.
    func testAFullDiskUsesTheSharedNoSpaceStringItself() {
        for language in AppLanguage.allCases {
            XCTAssertEqual(
                ReceiveDestinationCopy.message(for: DownloadDestinationError.systemError(ENOSPC),
                                               language: language),
                L10n.t(.errorDestinationNoSpace, language: language),
                language.rawValue)
        }
    }
}
