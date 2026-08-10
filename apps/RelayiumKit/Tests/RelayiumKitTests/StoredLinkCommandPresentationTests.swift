import XCTest
@testable import RelayiumAppKit

/// The macOS half of a command the web has always shown, held to the web's
/// behaviour case for case.
///
/// The cases below are the ones `web/src/lib/temp-downloader.test.ts` drives
/// through `shQuote`/`downCommand`, transcribed rather than paraphrased. Two
/// clients that print a command for the same link must print the SAME command:
/// a user comparing the page and the app should not have to work out which of
/// two spellings is the one that works.
///
/// Pure string work, so this needs no shell, no network and no view — which is
/// the point of it being a presentation type rather than a `Text` built inline.
final class StoredLinkCommandPresentationTests: XCTestCase {

    private let key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    private var link: String { "https://relayium.com/d/abc123#k=\(key)" }

    // MARK: - the fragment, which is the whole reason this exists

    func testTheWholeLinkIncludingItsFragmentStaysOneShellWord() {
        XCTAssertEqual(PosixShellQuoting.quote(link), "'\(link)'")
        XCTAssertEqual(StoredLinkCommandPresentation.downCommand(link: link),
                       "relayium down '\(link)'")
    }

    /// The defect the quoting prevents, stated as the thing that must not
    /// happen: unquoted, everything from `#` is a comment and the key is gone.
    func testTheCommandNeverPresentsTheFragmentOutsideQuotes() {
        let command = StoredLinkCommandPresentation.downCommand(link: link)
        let fragment = try! XCTUnwrap(command.range(of: "#k="))
        let quoteBefore = try! XCTUnwrap(command.range(of: "'"))
        XCTAssertLessThan(quoteBefore.lowerBound, fragment.lowerBound,
                          "the key would be read as a shell comment")
        XCTAssertTrue(command.hasSuffix("'"))
    }

    // MARK: - byte-for-byte with the web

    /// `web/src/lib/temp-downloader.test.ts`: "neutralises a quote smuggled into
    /// a hand-crafted link". The expected strings are that file's, verbatim.
    func testASmuggledQuoteIsEscapedExactlyAsTheWebEscapesIt() {
        let hostile = "https://relayium.com/d/x#k=a';rm -rf ~;'"
        XCTAssertEqual(PosixShellQuoting.quote(hostile),
                       "'https://relayium.com/d/x#k=a'\\'';rm -rf ~;'\\'''")
        XCTAssertEqual(PosixShellQuoting.quote("a'b"), "'a'\\''b'")
    }

    /// The same file's third case: shell metacharacters are inert, because a
    /// single-quoted word expands nothing.
    func testShellMetacharactersAreCarriedThroughInert() {
        XCTAssertEqual(PosixShellQuoting.quote("$(id) `id` && echo pwned"),
                       "'$(id) `id` && echo pwned'")
        for hostile in ["$HOME", "`id`", "$(id)", "a && b", "a; b", "a|b", "a\nb", "a\\b"] {
            let quoted = PosixShellQuoting.quote(hostile)
            XCTAssertTrue(quoted.hasPrefix("'") && quoted.hasSuffix("'"))
            XCTAssertEqual(unquoteSingleQuotedWord(quoted), hostile,
                           "\(hostile) does not survive the round trip as one word")
        }
    }

    /// Every quoted result is a single word, proved by parsing it back the way a
    /// POSIX shell would rather than by eye.
    func testEveryQuotedValueParsesBackToExactlyItself() {
        for value in [link, "", "'", "''", "a'b", "a'''b", "plain",
                      "https://relayium.com/d/x#k=a';rm -rf ~;'"] {
            XCTAssertEqual(unquoteSingleQuotedWord(PosixShellQuoting.quote(value)), value)
        }
    }

    /// An empty value still produces a word rather than nothing, which is what
    /// keeps the command's argument count fixed.
    func testAnEmptyValueStillProducesOneWord() {
        XCTAssertEqual(PosixShellQuoting.quote(""), "''")
    }

    // MARK: - the command's shape

    /// No destination argument, deliberately. This is the equivalent of what the
    /// window just did, not a builder for where to put the file.
    func testTheCommandIsTheVerbAndTheQuotedLinkAndNothingElse() {
        let command = StoredLinkCommandPresentation.downCommand(link: link)
        XCTAssertTrue(command.hasPrefix("relayium down "))
        XCTAssertEqual(command.components(separatedBy: " ").count, 3,
                       "the verb, the sub-command and one quoted argument")
        XCTAssertFalse(command.hasSuffix(" ."),
                       "a destination the app cannot know must not be invented")
    }

    /// A self-hosted deployment's link is carried verbatim: nothing here
    /// rewrites, shortens or canonicalises the origin.
    func testASelfHostedLinkIsReproducedExactly() {
        let hosted = "https://files.example.org/d/id#k=k"
        XCTAssertEqual(StoredLinkCommandPresentation.downCommand(link: hosted),
                       "relayium down '\(hosted)'")
    }

    // MARK: - a POSIX single-quote parser, for the assertions above

    /// Reads one single-quoted shell word the way `sh` does, and returns nil if
    /// the input is not exactly one. Deliberately strict: it accepts only the
    /// `'…'` and `'\''` forms this module emits, so a result that needed any
    /// other shell rule to be one word fails rather than passing.
    private func unquoteSingleQuotedWord(_ text: String) -> String? {
        var result = ""
        var characters = Array(text)
        var index = 0
        while index < characters.count {
            guard characters[index] == "'" else { return nil }
            index += 1
            while index < characters.count, characters[index] != "'" {
                result.append(characters[index])
                index += 1
            }
            guard index < characters.count else { return nil }   // unterminated
            index += 1
            // Between two quoted runs only an escaped literal quote may appear;
            // anything else would be a word boundary or an unquoted expansion.
            if index < characters.count, characters[index] != "'" {
                guard characters[index] == "\\", index + 1 < characters.count,
                      characters[index + 1] == "'" else { return nil }
                result.append("'")
                index += 2
            }
        }
        return result
    }
}
