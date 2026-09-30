import Foundation
import XCTest
@testable import RelayiumAppKit

/// A-L11: a `#k=` link on the clipboard is the plaintext key. Every Copy of one
/// goes through a single helper per platform, and that helper applies
/// `CapabilityLinkClipboard`: local-only and expiring on iOS, transient and
/// concealed on macOS.
final class CapabilityLinkClipboardTests: XCTestCase {

    // MARK: - the policy

    func testIOSCopiesAreLocalOnlyAndExpireWithinMinutes() {
        XCTAssertTrue(CapabilityLinkClipboard.localOnly,
                      "a key-bearing link must not be offered to Universal Clipboard")
        let now = Date(timeIntervalSince1970: 1_000_000)
        let expiry = CapabilityLinkClipboard.expiration(from: now)
        XCTAssertGreaterThan(expiry, now, "an expiry in the past drops the copy immediately")
        XCTAssertLessThanOrEqual(expiry.timeIntervalSince(now), 60 * 60,
                                 "a key must not linger on the pasteboard for hours")
        XCTAssertGreaterThanOrEqual(expiry.timeIntervalSince(now), 60,
                                    "too short to switch apps and paste")
    }

    func testMacCopiesWriteTheLinkThenBothMarkerTypes() {
        let link = "https://relayium.example/f/abc#k=secret"  // nonlocalized: fixture
        let entries = CapabilityLinkClipboard.macEntries(for: link)
        XCTAssertEqual(entries.first?.type, "public.utf8-plain-text",
                       "the link must be readable as ordinary text")
        XCTAssertEqual(entries.first?.value, link)
        let types = entries.map(\.type)
        XCTAssertTrue(types.contains("org.nspasteboard.TransientType"))
        XCTAssertTrue(types.contains("org.nspasteboard.ConcealedType"))
        XCTAssertEqual(entries.filter { $0.value == link }.count, 1,
                       "only the text type carries the link; markers are empty")
    }

    // MARK: - the call sites

    /// The four Copy actions that hand out a `#k=` capability (or the CLI
    /// command embedding one) call the helper, and no app source writes a
    /// `link`/`command` value to the pasteboard directly.
    func testEveryKeyBearingCopyGoesThroughTheHelper() throws {
        let callers = [
            "apps/ios/Relayium/SendView.swift": ["copyCapabilityLink(link)"],
            "apps/ios/Relayium/AccountSummaryView.swift": ["copyCapabilityLink(link)"],
            "apps/mac/Relayium/UploadPane.swift": ["copyCapabilityLink(link)",
                                                   "copyCapabilityLink(command)"],
            "apps/mac/Relayium/AccountView.swift": ["copyCapabilityLink(link)"],
        ]
        for (path, calls) in callers {
            let text = try RepoRoot.text(path)
            for call in calls {
                XCTAssertTrue(text.contains(call), "\(path) no longer calls \(call)")
            }
        }
        for root in ["apps/ios/Relayium", "apps/mac/Relayium"] {
            let dir = try RepoRoot.directory(root)
            let names = try FileManager.default.subpathsOfDirectory(atPath: dir.path)
                .filter { $0.hasSuffix(".swift") }
            XCTAssertGreaterThan(names.count, 10, "found no sources under \(root)")
            for name in names {
                let text = try RepoRoot.text(of: dir.appendingPathComponent(name))
                for raw in ["UIPasteboard.general.string = link",
                            "setString(link, forType:", "setString(command, forType:"] {
                    XCTAssertFalse(text.contains(raw),
                                   "\(root)/\(name) copies a key-bearing value raw: \(raw)")
                }
            }
        }
    }

    /// The helpers actually apply the policy rather than only being named.
    func testTheHelpersApplyThePolicy() throws {
        let ios = try RepoRoot.text("apps/ios/Relayium/CapabilityLinkPasteboard.swift")
        XCTAssertTrue(ios.contains(".localOnly: CapabilityLinkClipboard.localOnly"))
        XCTAssertTrue(ios.contains(".expirationDate: CapabilityLinkClipboard.expiration(from:"))
        XCTAssertTrue(ios.contains("UIPasteboard.general.setItems("))

        let mac = try RepoRoot.text("apps/mac/Relayium/CapabilityLinkPasteboard.swift")
        XCTAssertTrue(mac.contains("board.clearContents()"))
        XCTAssertTrue(mac.contains("CapabilityLinkClipboard.macEntries(for: link)"))
        XCTAssertTrue(mac.contains("board.setString(entry.value, forType:"))
    }
}
