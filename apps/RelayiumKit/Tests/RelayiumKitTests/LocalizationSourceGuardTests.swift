import XCTest
@testable import RelayiumAppKit

/// The regression guard: user-facing English cannot go back into the source.
///
/// Everything else in this suite checks what the catalogs contain. This checks
/// what the CODE contains, because the failure mode localization work actually
/// has is not a bad translation — it is the next feature adding
/// `Text("Try again")` to a view and nobody noticing until an Arabic user sees
/// one English button in the middle of an Arabic screen. SwiftUI's automatic
/// localization of string literals does not save that case here: the catalogs
/// live in the `RelayiumAppKit` package bundle, and a literal in the app target
/// resolves against the app's main bundle, finds nothing, and renders the
/// English verbatim — silently, and in every language.
///
/// A literal that genuinely must stay verbatim (a UTI, a defaults key, a brand
/// name, a build diagnostic) is allowed with an explicit
/// `// nonlocalized: <reason>` marker on the line or just above it. The marker
/// is the point: it makes each exception a decision somebody wrote down.
final class LocalizationSourceGuardTests: XCTestCase {

    /// Directories whose Swift files must not contain user-facing English.
    private var scannedRoots: [URL] {
        // …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file>
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // RelayiumKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // RelayiumKit
        let apps = packageRoot.deletingLastPathComponent()
        return [
            packageRoot.appendingPathComponent("Sources/RelayiumAppKit"),
            apps.appendingPathComponent("mac/Relayium"),
        ]
    }

    func testNoUserFacingEnglishLiteralsInTheAppOrViewModelLayer() throws {
        var offenders: [String] = []
        var scannedFiles = 0

        for root in scannedRoots {
            // A missing root means a rename moved the code out from under this
            // guard, which is exactly when it stops protecting anything.
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory),
                  isDirectory.boolValue else {
                XCTFail("scanned root is missing: \(root.path)")
                continue
            }
            for file in try swiftFiles(under: root) {
                scannedFiles += 1
                let source = try String(contentsOf: file, encoding: .utf8)
                let lines = source.components(separatedBy: "\n")
                for (number, line) in lines.enumerated() {
                    // The marker counts on the line itself or on the line above,
                    // so a wrapped call can carry its reason on its own line
                    // instead of trailing off the right edge.
                    let previous = number > 0 ? lines[number - 1] : ""
                    guard !isExempt(line), !isExempt(previous) else { continue }
                    for literal in stringLiterals(in: stripComment(line))
                    where looksLikeUserFacingEnglish(literal) {
                        offenders.append("\(file.lastPathComponent):\(number + 1): “\(literal)”")
                    }
                }
            }
        }

        XCTAssertGreaterThan(scannedFiles, 30,
                             "the scan found almost nothing — the roots are probably wrong")
        XCTAssertTrue(offenders.isEmpty,
                      "user-facing English literals must go through L10n, or carry an "
                      + "explicit `// nonlocalized: <reason>` marker:\n"
                      + offenders.joined(separator: "\n"))
    }

    /// The guard has to be able to FAIL, or it is decoration. Drive the same
    /// predicate over lines that stand in for the mistakes it exists to catch.
    func testTheGuardRejectsTheLiteralsItIsMeantToCatch() {
        let shouldBeCaught = [
            #"Text("Try again")"#,
            #"Button("Choose Files or Folders…") { }"#,
            #"alert.messageText = "A transfer is still running""#,
            #"return "The other device disconnected.""#,
            #"state = .failed("Couldn't reach the server. Check your connection.")"#,
        ]
        for line in shouldBeCaught {
            let caught = !isExempt(line) && stringLiterals(in: stripComment(line))
                .contains(where: looksLikeUserFacingEnglish)
            XCTAssertTrue(caught, "the guard would let this through: \(line)")
        }
    }

    /// And it has to tolerate the things that are legitimately verbatim, or the
    /// next person turns it off.
    func testTheGuardAllowsTechnicalAndMarkedLiterals() {
        let shouldPass = [
            #"UTType.fileURL.identifier"#,
            #"Image(systemName: "person.crop.circle")"#,
            #"panel.prompt = L10n.t(.pickerPrompt)"#,
            #"public static let defaultsKey = "com.relayium.verifyPeers""#,
            #"let path = "/api/cli/device/start""#,
            #"identifier: "relayium-transfer-\(UUID().uuidString)""#,
            #"Text("Relayium") // nonlocalized: brand"#,
            #"panel.message = "Choose a folder to save into"  // nonlocalized: covered above"#,
            #"if device.kind == "cli" {"#,
            #"filter.correctionLevel = "M""#,
            #"components.percentEncodedFragment = "account=pending_deletion&token=\(encoded)""#,
        ]
        for line in shouldPass {
            let caught = !isExempt(line) && stringLiterals(in: stripComment(line))
                .contains(where: looksLikeUserFacingEnglish)
            XCTAssertFalse(caught, "the guard is too strict: \(line)")
        }
    }

    // MARK: - the scan

    private func swiftFiles(under root: URL) throws -> [URL] {
        let contents = try FileManager.default.subpathsOfDirectory(atPath: root.path)
        return contents
            .filter { $0.hasSuffix(".swift") }
            .map { root.appendingPathComponent($0) }
            .sorted { $0.path < $1.path }
    }

    /// A line the guard is told to skip.
    private func isExempt(_ line: String) -> Bool {
        line.contains("nonlocalized:")
    }

    /// Drop a trailing `//` comment, ignoring `//` that falls inside a literal.
    private func stripComment(_ line: String) -> String {
        var inString = false
        var escaped = false
        let chars = Array(line)
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if escaped { escaped = false; i += 1; continue }
            if c == "\\" && inString { escaped = true; i += 1; continue }
            if c == "\"" { inString.toggle(); i += 1; continue }
            if !inString, c == "/", i + 1 < chars.count, chars[i + 1] == "/" {
                return String(chars[0..<i])
            }
            i += 1
        }
        return line
    }

    /// The string literals on one line, with interpolations replaced by a
    /// placeholder so `"\(count) files"` is still recognisable as English.
    private func stringLiterals(in line: String) -> [String] {
        var literals: [String] = []
        var current = ""
        var inString = false
        var escaped = false
        var interpolationDepth = 0
        let chars = Array(line)
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if interpolationDepth > 0 {
                if c == "(" { interpolationDepth += 1 }
                if c == ")" { interpolationDepth -= 1 }
                i += 1
                continue
            }
            if inString {
                if escaped {
                    escaped = false
                    if c == "(" { interpolationDepth = 1; current += "@" }
                    i += 1
                    continue
                }
                if c == "\\" { escaped = true; i += 1; continue }
                if c == "\"" { inString = false; literals.append(current); current = ""; i += 1; continue }
                current.append(c)
                i += 1
                continue
            }
            if c == "\"" { inString = true; current = "" }
            i += 1
        }
        return literals
    }

    /// Is this literal prose a user would read?
    ///
    /// Deliberately conservative in one direction only: it must not fire on
    /// identifiers, paths, UTIs, keys or format strings, because a guard with
    /// false positives gets disabled. It fires on a literal that has two or more
    /// words, at least one of them a real word, and no shape that marks it as
    /// machine vocabulary.
    private func looksLikeUserFacingEnglish(_ literal: String) -> Bool {
        let text = literal.trimmingCharacters(in: .whitespaces)
        guard text.count >= 8 else { return false }
        // Machine vocabulary: reverse-DNS keys, paths, URLs, query fragments,
        // UTIs and anything with no space at all.
        guard text.contains(" ") else { return false }
        if text.hasPrefix("/") || text.contains("://") || text.contains("=") { return false }
        if text.contains("com.relayium") || text.contains("public.") { return false }
        // Two or more alphabetic words, at least one of four letters or more.
        let words = text.split(whereSeparator: { !$0.isLetter })
        guard words.count >= 2, words.contains(where: { $0.count >= 4 }) else { return false }
        // Latin letters specifically: a Chinese or Arabic literal in the source
        // would be a different bug, and this guard is about English.
        let latin = words.allSatisfy { $0.allSatisfy { $0.isASCII } }
        return latin
    }
}
