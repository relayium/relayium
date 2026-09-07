import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit
@testable import RelayiumShareKit

/// The eleven sentences the iOS Device Inbox says differently, and the far
/// larger number it deliberately does not.
///
/// `IOSInboxCopy` is `ReceiveDestinationCopy`'s sibling: the shared status
/// presentation was written for a Mac, and a handful of its arms end by sending
/// the user to a folder panel that does not exist here, or describe a receiver
/// that keeps working with the window closed. Substituting too FEW would ship a
/// dead end; substituting too many is how two platforms come to explain one rule
/// two ways.
final class IOSInboxCopyTests: XCTestCase {

    /// **No sentence on the iOS Device Inbox may send the user to a folder
    /// picker, or promise a receiver that runs with the app closed.**
    ///
    /// This is the property, asserted over every state the surface can render
    /// rather than over the seven arms that were changed — so an arm added later
    /// is caught by the same test rather than by remembering to extend a list.
    func testNoIOSInboxSentenceNamesAPickerOrABackgroundReceiver() {
        // Phrases that are true on macOS and false here. Lower-cased, matched as
        // substrings, and drawn from the actual macOS catalogs rather than
        // invented — each one is a sentence the shared copy really says.
        let macOnly = ["choose another", "choose it again", "choose a folder",
                       "choose the folder", "macos refused", "reconnect the disk",
                       "this mac", "window is closed", "renamed"]
        for state in everyRenderableState() {
            for language in AppLanguage.allCases {
                let text = IOSInboxCopy.status(for: state, language: language).lowercased()
                XCTAssertFalse(text.isEmpty, "\(state) renders nothing in \(language.rawValue)")
                guard language == .en else { continue }
                for phrase in macOnly {
                    XCTAssertFalse(text.contains(phrase),
                                   "\(state) tells an iPhone user to \"\(phrase)\"")
                }
            }
        }
    }

    /// **`chooseFolder` is unreachable**, and that is the whole of the recovery
    /// override: the shared rule offers it for every folder problem and for two
    /// delivery codes, and a button this platform cannot draw on the exact
    /// screen a user is already stuck on is the dead control this app's design
    /// rules forbid.
    func testTheRecoveryOfferedIsNeverAFolderPicker() {
        for state in everyRenderableState() {
            let recovery = IOSInboxCopy.recovery(for: state)
            XCTAssertNotEqual(recovery, .chooseFolder,
                              "\(state) offers a folder picker that does not exist on iOS")
            // And a state the shared rule had nothing for still has nothing:
            // a recovery button on a healthy state invites a user to fix
            // something that is not broken.
            if InboxStatusPresentation.recovery(for: state) == nil {
                XCTAssertNil(recovery, "\(state) grew a recovery macOS does not offer")
            } else {
                XCTAssertNotNil(recovery, "\(state) lost the recovery macOS offers")
            }
            // Every label that IS offered renders in both languages.
            if let recovery {
                for language in AppLanguage.allCases {
                    XCTAssertFalse(IOSInboxCopy.label(for: recovery, language: language).isEmpty)
                }
            }
        }
        // The substitution is `retry`, which is honest: `retryNow()` re-inspects
        // the folder before it restarts, which is the re-check a re-grant would
        // have forced.
        XCTAssertEqual(IOSInboxCopy.recovery(for: .attention(.folder(.notWritable))), .retry)
        XCTAssertEqual(IOSInboxCopy.recovery(for: .attention(.delivery(.permissionDenied))),
                       .retry)
    }

    /// **Everything whose advice names no picker and no window is the SHARED
    /// copy, byte for byte, in both languages.**
    ///
    /// This is the half that stops the platforms drifting. `diskFull`,
    /// `downloadFailed`, `verifyFailed`, `userDeclined`, `unsupported` and
    /// `internal` are about the bytes or the sender, not about where they were
    /// going, so a second copy of them could only ever go out of step with this
    /// one.
    func testTheSharedArmsAreNotDuplicated() {
        let shared: [InboxDeviceErrorCode] = [.diskFull, .downloadFailed, .verifyFailed,
                                              .userDeclined, .unsupported]
        for code in shared {
            for language in AppLanguage.allCases {
                XCTAssertEqual(IOSInboxCopy.text(for: .delivery(code), language: language),
                               InboxStatusPresentation.text(for: .delivery(code),
                                                            language: language),
                               "\(code) has a second iOS copy that can drift")
            }
        }
        // `failedUnknown` is the one terminal failure kept shared: it says *this
        // version*, not *this Mac*, and that is true on both platforms.
        for language in AppLanguage.allCases {
            XCTAssertEqual(IOSInboxCopy.status(for: .failed(.unknown), language: language),
                           InboxStatusPresentation.text(for: .failed(.unknown),
                                                        language: language),
                           "the version-agnostic failure grew a second copy")
        }
        // And every status that is neither an `attention` nor a `failed`
        // delegates entirely — that is the majority of the surface.
        for state in everyRenderableState() {
            switch state {
            case .attention, .failed:
                continue
            default:
                for language in AppLanguage.allCases {
                    XCTAssertEqual(IOSInboxCopy.status(for: state, language: language),
                                   InboxStatusPresentation.text(for: state, language: language),
                                   "\(state) has an iOS copy it did not need")
                }
            }
        }
    }

    /// Every substituted arm really is substituted — in both languages, so a
    /// translation that was never written cannot fall back to the English that
    /// names a picker or a Mac.
    func testTheSubstitutedArmsDifferFromTheSharedOnesInBothLanguages() {
        let substituted: [InboxAttention] = [
            .folder(.accessDenied), .folder(.unresolvable), .folder(.notWritable),
            .folder(.staleRefreshFailed),
            .delivery(.permissionDenied), .delivery(.directoryUnavailable),
            .delivery(.nameConflict), .delivery(.decryptFailed),
            .delivery(.internal), .delivery(.none),
        ]
        for attention in substituted {
            for language in AppLanguage.allCases {
                let ios = IOSInboxCopy.text(for: attention, language: language)
                XCTAssertFalse(ios.isEmpty)
                XCTAssertNotEqual(ios,
                                  InboxStatusPresentation.text(for: attention,
                                                               language: language),
                                  "\(attention) still renders the macOS sentence in "
                                  + "\(language.rawValue)")
            }
        }
        // The three terminal failures that name the machine, and the fourth that
        // deliberately does not.
        for failure: InboxRuntimeFailure in [.enrolmentRefused, .keyUnavailable, .identity] {
            for language in AppLanguage.allCases {
                XCTAssertNotEqual(IOSInboxCopy.text(for: failure, language: language),
                                  InboxStatusPresentation.text(for: failure, language: language),
                                  "\(failure) still names a Mac in \(language.rawValue)")
            }
        }
        // And the keychain instruction in particular is gone: unlocking a
        // keychain is a macOS action, offered on the one screen where following
        // it decides whether anything is received at all.
        XCTAssertFalse(IOSInboxCopy.text(for: .keyUnavailable, language: .en)
                        .lowercased().contains("keychain"),
                       "the iOS key failure tells the user to unlock a keychain")
    }

    /// The folder explanation names the SAME Files-app route a stored-link
    /// receive names, built from the same two constants.
    ///
    /// Two spellings of one route is how a user ends up looking for their files
    /// in a folder that does not exist.
    func testTheFolderExplanationNamesTheOneFilesAppRoute() {
        for language in AppLanguage.allCases {
            let route = IOSInboxCopy.receiveFolderRoute(language: language)
            XCTAssertTrue(route.contains(ReceiveDestinationCopy.filesAppFolder))
            XCTAssertTrue(route.contains(ReceiveDestination.folderName))
            let explanation = IOSInboxCopy.folderExplanation(language: language)
            XCTAssertTrue(explanation.contains(ReceiveDestination.folderName),
                          "\(language.rawValue) does not say where a delivery lands")
            // The same route the download success sentence names.
            XCTAssertTrue(
                ReceiveDestinationCopy.savedLocation(language: language)
                    .contains(ReceiveDestination.folderName))
        }
    }

    /// **The foreground-only sentence exists, is complete in both languages, and
    /// says all three things.**
    ///
    /// It is the single most important sentence on this surface: every other one
    /// is true of macOS too. A user who sends a file to their locked phone is
    /// waiting for something that will not happen until they open the app, and
    /// this is the only place the product says so.
    func testTheForegroundOnlyStatementIsCompleteInBothLanguages() {
        for language in AppLanguage.allCases {
            let text = L10n.t(.inboxIOSForegroundOnly, language: language)
            XCTAssertFalse(text.isEmpty)
            XCTAssertNotEqual(text, L10nKey.inboxIOSForegroundOnly.rawValue,
                              "\(language.rawValue) falls through to the key")
        }
        // English says all three: only while open, not in the background, and
        // no notification — because a user who reads only the first would still
        // expect to be told when something arrives.
        let english = L10n.t(.inboxIOSForegroundOnly, language: .en).lowercased()
        XCTAssertTrue(english.contains("open"))
        XCTAssertTrue(english.contains("background"))
        XCTAssertTrue(english.contains("notification"))
    }

    /// Every new iOS key renders in both maintained languages and never falls
    /// through to its own name.
    ///
    /// `LocalizationIntegrityTests` already asserts that every key is DEFINED.
    /// This is the other half for the keys this slice added: that a lookup
    /// actually returns that language's own catalog entry rather than the
    /// English fallback, which is the failure a missing zh-Hans translation
    /// produces and which no English-reading reviewer would notice.
    func testEveryNewIOSKeyIsTranslatedRatherThanFallingBack() {
        let added: [L10nKey] = [
            .inboxIOSExplain, .inboxIOSSignedOutBody, .inboxIOSPolicyExplain,
            .inboxIOSForegroundOnly, .inboxIOSFolderExplain, .inboxIOSFolderAccessDenied,
            .inboxIOSFolderUnresolvable, .inboxIOSFolderNotWritable,
            .inboxIOSBlockedPermission, .inboxIOSBlockedDirectory,
            .inboxIOSBlockedNameConflict, .inboxIOSBlockedDecrypt,
            .inboxIOSBlockedInternal, .inboxIOSFailedEnrolment, .inboxIOSFailedKey,
            .inboxIOSFailedIdentity,
            .inboxIOSConversationsEmpty, .inboxIOSOpenConversation,
            .tabDeviceInbox, .navIOSDeviceInboxSubtitle,
        ]
        for key in added {
            let english = L10n.t(key, language: .en)
            let chinese = L10n.t(key, language: .zh)
            XCTAssertFalse(english.isEmpty)
            XCTAssertNotEqual(english, key.rawValue, "\(key.rawValue) has no English")
            XCTAssertNotEqual(chinese, key.rawValue, "\(key.rawValue) has no Simplified Chinese")
            XCTAssertNotEqual(chinese, english,
                              "\(key.rawValue) falls back to English in zh-Hans")
        }
    }

    /// The iOS Device Inbox subtitle makes neither of the two promises the macOS
    /// one makes, in either language.
    func testTheIOSSidebarSubtitleClaimsNoFolderAndNoBackgroundReceive() {
        for language in AppLanguage.allCases {
            let ios = L10n.t(.navIOSDeviceInboxSubtitle, language: language)
            let mac = L10n.t(.navDeviceInboxSubtitle, language: language)
            XCTAssertNotEqual(ios, mac,
                              "\(language.rawValue) reuses the macOS Device Inbox subtitle")
            XCTAssertFalse(ios.isEmpty)
        }
        let english = L10n.t(.navIOSDeviceInboxSubtitle, language: .en).lowercased()
        XCTAssertFalse(english.contains("folder you choose"),
                       "the subtitle promises a folder picker this platform has none of")
        XCTAssertFalse(english.contains("window"),
                       "the subtitle promises receiving with the window closed")
    }

    /// Every state the iOS surface can put on screen. Written out rather than
    /// derived, because `InboxRuntimeState` carries payloads and the payloads
    /// are what several of these sentences turn on.
    private func everyRenderableState() -> [InboxRuntimeState] {
        var states: [InboxRuntimeState] = [
            .signedOut, .loading, .disabled, .folderMissing,
            .ready(.auto), .ready(.ask), .asking(count: 1), .asking(count: 3),
            .paused, .working, .offline(retryInSeconds: nil),
            .offline(retryInSeconds: 30), .saved(files: 1), .saved(files: 4), .savedMessage,
        ]
        for problem: InboxFolderProblem in [.accessDenied, .unresolvable, .notWritable,
                                            .staleRefreshFailed] {
            states.append(.attention(.folder(problem)))
        }
        for code in InboxDeviceErrorCode.allCases {
            states.append(.attention(.delivery(code)))
        }
        for failure in InboxRuntimeFailure.allCases {
            states.append(.failed(failure))
        }
        return states
    }
}
