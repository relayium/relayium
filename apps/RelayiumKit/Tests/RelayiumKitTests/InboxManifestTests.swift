import Foundation
import XCTest
@testable import RelayiumKit

final class InboxManifestTests: XCTestCase {
    private func bytes(_ s: String) -> [UInt8] { Array(s.utf8) }
    private func text(_ b: [UInt8]) -> String { String(decoding: b, as: UTF8.self) }

    // MARK: - the canonical form

    func testEncodeIsTheOneCanonicalSpelling() throws {
        let m = try InboxManifest.files([(name: "b.txt", size: 2), (name: "a.txt", size: 1)])
        // Key order is fixed, item order is the SENDER's (not sorted), and there
        // is no whitespace anywhere.
        XCTAssertEqual(
            text(try InboxManifest.encode(m)),
            #"{"v":2,"items":[{"kind":"file","name":"b.txt","size":2},{"kind":"file","name":"a.txt","size":1}]}"#)
    }

    func testTextEncodesWithNoNameKeyAtAll() throws {
        let encoded = text(try InboxManifest.encode(try InboxManifest.text(size: 11)))
        XCTAssertEqual(encoded, #"{"v":2,"items":[{"kind":"text","size":11}]}"#)
        // Absent, not empty. An empty string is something a receiver could be
        // tempted to treat as a destination; an absent key cannot be.
        XCTAssertFalse(encoded.contains("name"))
    }

    /// The escaping rules the three implementations share. Getting any of these
    /// wrong produces bytes that decrypt fine and then fail a canonical-form
    /// check on another platform, halfway through a real delivery.
    ///
    /// Only characters a VALID name can contain appear here. The encoder also
    /// escapes the backslash, tab, newline and the rest of the C0 controls, but
    /// the name rule refuses all of those outright, so no manifest can reach
    /// those branches — they stay
    /// in the encoder as the shared written rule and as defence in depth, not
    /// as reachable behaviour. Go asserts those branches directly instead.
    func testEscapingMatchesJSONStringify() throws {
        for (name, escaped) in [
            (#"say "hi""#, #"say \"hi\""#),
            // NOT escaped, unlike Go's own encoder: these are the ones that
            // would silently diverge across languages.
            ("a<b>&c", "a<b>&c"),
            ("a\u{202e}b", "a\u{202e}b"),
            ("a\u{2028}b", "a\u{2028}b"),
            ("a/b", "a/b"),
            ("发票 2026.pdf", "发票 2026.pdf"),
        ] {
            let m = try InboxManifest.files([(name: name, size: 1)])
            XCTAssertEqual(text(try InboxManifest.encode(m)),
                           #"{"v":2,"items":[{"kind":"file","name":"\#(escaped)","size":1}]}"#,
                           "escaping \(name)")
        }
    }

    func testEncodeDecodeRoundTrips() throws {
        for m in [
            try InboxManifest.files([(name: "a/b/c.txt", size: 0)]),
            try InboxManifest.files([(name: "发票 2026.pdf", size: InboxManifest.maxSafeInteger)]),
            try InboxManifest.text(size: InboxManifest.maxTextBytes),
        ] {
            let encoded = try InboxManifest.encode(m)
            let back = try InboxManifest.decode(encoded)
            XCTAssertEqual(back, m)
            XCTAssertEqual(try InboxManifest.encode(back), encoded)
        }
    }

    // MARK: - fail-closed clauses

    private func assertRefused(_ json: String, _ want: InboxManifestError,
                               _ message: String = "", file: StaticString = #filePath,
                               line: UInt = #line) {
        do {
            _ = try InboxManifest.decode(bytes(json))
            XCTFail("accepted \(json). \(message)", file: file, line: line)
        } catch let e as InboxManifestError {
            XCTAssertEqual(e, want, "\(json). \(message)", file: file, line: line)
        } catch {
            XCTFail("unexpected \(error) for \(json)", file: file, line: line)
        }
    }

    /// The version is decided BEFORE anything else, so a v1 document — which has
    /// no `v` and an unknown `files` key — is diagnosed as a version problem
    /// rather than as a stray field.
    func testVersionFailsClosed() {
        assertRefused(#"{"files":[{"name":"a.txt","size":1}]}"#, .version, "the v1 shape")
        assertRefused(#"{"v":1,"items":[{"kind":"file","name":"a.txt","size":1}]}"#, .version)
        assertRefused(#"{"v":3,"items":[{"kind":"file","name":"a.txt","size":1}]}"#, .version,
                      "a future version is refused, never downgraded")
        assertRefused(#"{"items":[{"kind":"file","name":"a.txt","size":1}]}"#, .version)
        assertRefused(#"{"v":0,"items":[{"kind":"file","name":"a.txt","size":1}]}"#, .version)
    }

    func testSingleKindPerDelivery() {
        assertRefused(#"{"v":2,"items":[{"kind":"file","name":"a.txt","size":1},{"kind":"text","size":5}]}"#,
                      .mixedKinds)
        assertRefused(#"{"v":2,"items":[{"kind":"text","size":5},{"kind":"file","name":"a.txt","size":1}]}"#,
                      .mixedKinds, "the reverse order is the same rule")
        // A single stray item at the end of a long run: a check that only
        // compared neighbours, or only looked at the first two items, would pass
        // the two cases above and let this one through.
        var items = Array(repeating: InboxManifestItem(kind: .file, name: "f", size: 1), count: 39)
        items.append(InboxManifestItem(kind: .text, size: 1))
        XCTAssertThrowsError(try InboxManifest.validate(InboxManifestV2(items: items))) {
            XCTAssertEqual($0 as? InboxManifestError, .mixedKinds)
        }
    }

    func testTextIsExactlyOneUnnamedBoundedItem() {
        assertRefused(#"{"v":2,"items":[{"kind":"text","size":5},{"kind":"text","size":6}]}"#,
                      .textItemCount, "two messages have no frame boundary between them")
        assertRefused(#"{"v":2,"items":[{"kind":"text","name":"note.txt","size":5}]}"#, .textName)
        for size in [0, -1, InboxManifest.maxTextBytes + 1, InboxManifest.maxSafeInteger] {
            XCTAssertThrowsError(try InboxManifest.text(size: size), "text size \(size)") {
                XCTAssertEqual($0 as? InboxManifestError, .size)
            }
        }
        for size in [InboxManifest.minTextBytes, 1024, InboxManifest.maxTextBytes] {
            XCTAssertNoThrow(try InboxManifest.text(size: size), "text size \(size)")
        }
    }

    func testNameRejectsTraversalAndControlCharacters() {
        for bad in [
            "", "../etc/passwd", "a/../../b.txt", "./a.txt", "a/..",
            "/etc/passwd", "/a", "C:/Windows/a.dll", "C:a.dll",
            #"a\b.txt"#, #"..\a.txt"#, "a//b.txt", "a/b/",
            "a\u{00}b.txt", "a\nb.txt", "a\rb.txt", "a\u{1b}b.txt", "a\u{7f}b.txt",
            String(repeating: "a", count: InboxManifest.maxNameBytes + 1),
            String(repeating: "é", count: InboxManifest.maxNameBytes / 2 + 1),
            String(repeating: "a/", count: InboxManifest.maxPathDepth) + "b",
        ] {
            XCTAssertThrowsError(try InboxManifest.files([(name: bad, size: 1)]), "name \(bad.debugDescription)") {
                XCTAssertEqual($0 as? InboxManifestError, .name, bad.debugDescription)
            }
        }
        // The boundary cases that must PASS, so the rule is a rule and not a ban
        // on ordinary names.
        for ok in [
            "a.txt", "trip/day 1/IMG_0001.jpg", "a..b.txt", ".hidden", "发票 2026.pdf",
            String(repeating: "a", count: InboxManifest.maxNameBytes),
            String(repeating: "a/", count: InboxManifest.maxPathDepth - 1) + "b",
        ] {
            XCTAssertNoThrow(try InboxManifest.files([(name: ok, size: 1)]), ok.debugDescription)
        }
    }

    func testSizesAndTotalsAreBounded() {
        XCTAssertThrowsError(try InboxManifest.files([(name: "a", size: -1)])) {
            XCTAssertEqual($0 as? InboxManifestError, .size)
        }
        XCTAssertThrowsError(try InboxManifest.files([(name: "a", size: InboxManifest.maxSafeInteger + 1)])) {
            XCTAssertEqual($0 as? InboxManifestError, .size)
        }
        // Each item fits; the SUM does not. This is the one an item-at-a-time
        // bound misses, and it is what a receiver would preallocate against.
        XCTAssertThrowsError(try InboxManifest.files([
            (name: "a", size: InboxManifest.maxSafeInteger), (name: "b", size: 1),
        ])) { XCTAssertEqual($0 as? InboxManifestError, .totalOverflow) }
        // Two Int.max-adjacent values whose sum wraps: a naive `total + size >
        // max` check would see a NEGATIVE total and call it small.
        XCTAssertThrowsError(try InboxManifest.files([
            (name: "a", size: Int.max), (name: "b", size: Int.max),
        ])) { XCTAssertNotNil($0 as? InboxManifestError) }
        // Zero is legal: an empty file is a real file.
        XCTAssertNoThrow(try InboxManifest.files([(name: "a", size: 0)]))
    }

    func testItemCountIsBounded() {
        XCTAssertThrowsError(try InboxManifest.files([])) {
            XCTAssertEqual($0 as? InboxManifestError, .itemCount)
        }
        let at = Array(repeating: (name: "f", size: 1), count: InboxManifest.maxItems)
        XCTAssertNoThrow(try InboxManifest.files(at))
        XCTAssertThrowsError(try InboxManifest.files(at + [(name: "f", size: 1)])) {
            XCTAssertEqual($0 as? InboxManifestError, .itemCount)
        }
    }

    func testUnknownFieldsAreRefusedNotIgnored() {
        assertRefused(#"{"v":2,"note":"hi","items":[{"kind":"file","name":"a.txt","size":1}]}"#, .malformed)
        assertRefused(#"{"v":2,"items":[{"kind":"file","name":"a.txt","size":1,"path":"/tmp"}]}"#, .malformed)
        // The one that matters: a sender must not be able to smuggle the message
        // body into the structure every receiver parses first.
        assertRefused(#"{"v":2,"items":[{"kind":"text","size":5,"text":"hello"}]}"#, .malformed)
        assertRefused(#"{"v":2,"items":[{"kind":"file","name":"a.txt","size":1}],"key":"AAAA"}"#, .malformed)
    }

    func testNonCanonicalDocumentsAreRefused() {
        assertRefused(#"{"items":[{"kind":"file","name":"a.txt","size":1}],"v":2}"#, .notCanonical,
                      "manifest keys reordered")
        assertRefused(#"{"v":2,"items":[{"size":1,"kind":"file","name":"a.txt"}]}"#, .notCanonical,
                      "item keys reordered")
        assertRefused(#"{"v": 2, "items": [{"kind": "file", "name": "a.txt", "size": 1}]}"#, .notCanonical,
                      "pretty printed")
        assertRefused("{\"v\":2,\"items\":[{\"kind\":\"file\",\"name\":\"a.txt\",\"size\":1}]}\n",
                      .notCanonical, "trailing newline")
        assertRefused(#"{"v":2,"items":[{"kind":"file","name":"a.txt","size":1,"size":2}]}"#, .notCanonical,
                      "a duplicated key where the last would win")
        assertRefused(#"{"v":2,"items":[{"kind":"file","name":"a\/b.txt","size":1}]}"#, .notCanonical,
                      "an escaped solidus")
        assertRefused(#"{"v":2,"items":[{"kind":"file","name":"a\u003cb.txt","size":1}]}"#, .notCanonical,
                      "a needlessly escaped character")
    }

    func testMalformedDocumentsAreRefused() {
        assertRefused("", .malformed)
        assertRefused("not json", .malformed)
        assertRefused(#"[{"kind":"file","name":"a.txt","size":1}]"#, .malformed, "an array document")
        assertRefused(#"{"v":2,"items":{"kind":"file","name":"a.txt","size":1}}"#, .malformed)
        assertRefused(#"{"v":2,"items":["a.txt"]}"#, .malformed)
        assertRefused(#"{"v":2,"items":[{"kind":"file","name":"a.txt","size":"1"}]}"#, .malformed)
        assertRefused(#"{"v":2,"items":[{"kind":"file","name":"a.txt","size":1.5}]}"#, .malformed)
        assertRefused(#"{"v":2,"items":[{"kind":"file","name":"a.txt","size":1}"#, .malformed, "truncated")
        // A second document appended to the first. Without a whole-input parse
        // this would decode as its first value and the rest would vanish.
        assertRefused(
            #"{"v":2,"items":[{"kind":"file","name":"a.txt","size":1}]}{"v":2,"items":[{"kind":"text","size":1}]}"#,
            .malformed)
    }

    func testUnknownKindIsNeverGuessedAt() {
        assertRefused(#"{"v":2,"items":[{"kind":"folder","name":"a","size":1}]}"#, .unknownKind)
        assertRefused(#"{"v":2,"items":[{"name":"a.txt","size":1}]}"#, .unknownKind, "absent")
        assertRefused(#"{"v":2,"items":[{"kind":"File","name":"a.txt","size":1}]}"#, .unknownKind,
                      "kind is case-sensitive")
        assertRefused(#"{"v":2,"items":[{"kind":"","name":"a.txt","size":1}]}"#, .unknownKind)
    }

    /// The sender-side half. A codec that only checked on the way IN would seal
    /// a traversal name happily and leave the refusal to the receiver — after
    /// the upload, and only if the receiver is this careful.
    func testEncodeRefusesToProduceAnInvalidManifest() {
        for m in [
            InboxManifestV2(items: [InboxManifestItem(kind: .file, name: "../a", size: 1)]),
            InboxManifestV2(items: [InboxManifestItem(kind: .file, name: "a", size: 1),
                                    InboxManifestItem(kind: .text, size: 1)]),
            InboxManifestV2(items: []),
            InboxManifestV2(items: [InboxManifestItem(kind: .text, name: "n", size: 1)]),
        ] {
            XCTAssertThrowsError(try InboxManifest.encode(m))
        }
    }

    func testKindAndTotalReadBackWhatWasSealed() throws {
        let m = try InboxManifest.files([(name: "a", size: 1), (name: "b", size: 41)])
        XCTAssertEqual(m.kind, .file)
        XCTAssertEqual(m.totalSize, 42)
        let t = try InboxManifest.text(size: 11)
        XCTAssertEqual(t.kind, .text)
        XCTAssertEqual(t.totalSize, 11)
    }

    // MARK: - the frozen cross-language vectors

    /// One file, three ecosystems: this test, Go's `vectors_test.go` and the
    /// TypeScript `inbox-manifest.test.ts` read the SAME bytes, so an
    /// implementation that drifts fails here rather than on a user's device
    /// halfway through a delivery.
    private func vectors() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "device-inbox-manifest-v2-vectors",
                                                  withExtension: "json"))
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private static let reasons: [String: InboxManifestError] = [
        "version": .version, "itemCount": .itemCount, "unknownKind": .unknownKind,
        "mixedKinds": .mixedKinds, "name": .name, "textName": .textName,
        "textItemCount": .textItemCount, "size": .size, "totalOverflow": .totalOverflow,
        "malformed": .malformed, "notCanonical": .notCanonical,
    ]

    /// The constants, before the documents. A bound that drifted here would make
    /// every vector below pass against the wrong rule.
    func testVectorBoundsMatchThisImplementation() throws {
        let v = try vectors()
        XCTAssertEqual(v["version"] as? Int, InboxManifest.version)
        let bounds = try XCTUnwrap(v["bounds"] as? [String: Any])
        XCTAssertEqual(bounds["maxItems"] as? Int, InboxManifest.maxItems)
        XCTAssertEqual(bounds["minItems"] as? Int, InboxManifest.minItems)
        XCTAssertEqual(bounds["maxNameBytes"] as? Int, InboxManifest.maxNameBytes)
        XCTAssertEqual(bounds["maxPathDepth"] as? Int, InboxManifest.maxPathDepth)
        XCTAssertEqual(bounds["maxSafeInteger"] as? Int, InboxManifest.maxSafeInteger)
        XCTAssertEqual(bounds["minTextBytes"] as? Int, InboxManifest.minTextBytes)
        XCTAssertEqual(bounds["maxTextBytes"] as? Int, InboxManifest.maxTextBytes)
    }

    func testVectorsAccept() throws {
        let cases = try XCTUnwrap(try vectors()["accept"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty, "no accept vectors were loaded")
        for tc in cases {
            let name = tc["name"] as? String ?? "?"
            let canonical = try XCTUnwrap(tc["canonical"] as? String, name)
            // DECODE: the frozen bytes must parse to exactly the stated shape.
            let m = try InboxManifest.decode(bytes(canonical))
            XCTAssertEqual(m.kind?.rawValue, tc["kind"] as? String, name)
            XCTAssertEqual(m.totalSize, tc["total"] as? Int, name)
            let want = try XCTUnwrap(tc["items"] as? [[String: Any]], name)
            XCTAssertEqual(m.items.count, want.count, name)
            for (i, w) in want.enumerated() where i < m.items.count {
                XCTAssertEqual(m.items[i].kind.rawValue, w["kind"] as? String, "\(name) item \(i)")
                XCTAssertEqual(m.items[i].name, w["name"] as? String, "\(name) item \(i)")
                XCTAssertEqual(m.items[i].size, w["size"] as? Int, "\(name) item \(i)")
            }
            // ENCODE: and this implementation must produce those exact bytes
            // from that shape. Decoding alone would let a lenient encoder pass.
            XCTAssertEqual(text(try InboxManifest.encode(m)), canonical, name)
        }
    }

    func testVectorsRefuse() throws {
        let cases = try XCTUnwrap(try vectors()["refuse"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty, "no refuse vectors were loaded")
        for tc in cases {
            let name = tc["name"] as? String ?? "?"
            let json = try XCTUnwrap(tc["json"] as? String, name)
            let reasonToken = try XCTUnwrap(tc["reason"] as? String, name)
            let want = try XCTUnwrap(Self.reasons[reasonToken], "unmapped reason \(reasonToken)")
            do {
                _ = try InboxManifest.decode(bytes(json))
                XCTFail("accepted a document the vectors refuse: \(name)")
            } catch let e as InboxManifestError {
                // `anyRefusal` vectors are ones the three JSON parsers cannot
                // all observe identically. They must still be refused — only
                // the clause is allowed to differ.
                if tc["anyRefusal"] as? Bool == true { continue }
                XCTAssertEqual(e, want, name)
            } catch {
                XCTFail("unexpected \(error) for \(name)")
            }
        }
    }

    /// The bounds that would make the fixture enormous if spelled out — a
    /// thousand items, a kilobyte name, a sixty-four-deep path — built from the
    /// same frozen numbers.
    func testVectorsGenerated() throws {
        let cases = try XCTUnwrap(try vectors()["generated"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty, "no generated vectors were loaded")
        for tc in cases {
            let name = tc["name"] as? String ?? "?"
            var entries: [(name: String, size: Int)]
            if let count = tc["count"] as? Int {
                entries = Array(repeating: (name: "f", size: 1), count: count)
            } else if let nameBytes = tc["nameBytes"] as? Int {
                entries = [(name: String(repeating: "a", count: nameBytes), size: 1)]
            } else if let depth = tc["depth"] as? Int {
                entries = [(name: String(repeating: "a/", count: depth - 1) + "b", size: 1)]
            } else {
                XCTFail("generated vector \(name) describes nothing to build")
                continue
            }
            let reasonToken = try XCTUnwrap(tc["reason"] as? String, name)
            if reasonToken == "accept" {
                let m = try InboxManifest.files(entries)
                // Round-trips too: a bound only `validate` honoured would still
                // break a real delivery at encode or decode time.
                XCTAssertNoThrow(try InboxManifest.decode(try InboxManifest.encode(m)), name)
                continue
            }
            let want = try XCTUnwrap(Self.reasons[reasonToken], "unmapped reason \(reasonToken)")
            XCTAssertThrowsError(try InboxManifest.files(entries), name) {
                XCTAssertEqual($0 as? InboxManifestError, want, name)
            }
        }
    }
}
