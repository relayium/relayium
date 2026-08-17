import Foundation

/// The Device Inbox v3 encrypted manifest — the small authenticated JSON
/// document a sender seals at frame 0 of a delivery, describing what the frames
/// after it contain.
///
/// This is the Swift third of one codec. The other two are
/// `server/internal/inboxmanifest` and `web/src/lib/inbox-manifest.ts`, and all
/// three are checked against the same frozen vectors in
/// `Tests/Fixtures/device-inbox-manifest-v3-vectors.json`.
///
/// It is DELIBERATELY separate from `StoredManifest`, the shared Stored-Wire
/// manifest. Those bytes are frozen and interop-tested across unrelated
/// products; teaching them a content kind would change what a public share
/// object looks like. This one is free to be stricter, and is.
///
/// **Invariants.**
///
///  1. KIND IS SEALED. Content kind exists here and nowhere else. Central holds
///     ciphertext, so a message and a file delivery are indistinguishable to
///     it, to its logs, and to its operators.
///  2. ONE KIND PER DELIVERY. A mixed manifest is refused, not partly honoured:
///     a receiver would otherwise have to write half a delivery into the user's
///     receive folder and half into the message store.
///  3. CANONICAL OR REFUSED. There is exactly ONE byte sequence per manifest.
///     `decode` re-encodes what it parsed and requires equality, so reordered
///     keys, duplicates, whitespace and dropped fields are all refusals.
///  4. AEAD IS NOT VALIDATION. Decryption proves who wrote the bytes and says
///     nothing about whether their numbers and names are safe to act on.
///  5. TEXT IS NOT IN HERE. A message's bytes travel in the encrypted frames
///     like any other payload; the manifest carries only its length.
public enum InboxManifest {
    /// The only manifest version this codec reads or writes.
    ///
    /// v1 had no version field at all — it was `{"files":[…]}`, the shared
    /// Stored-Wire shape. That is why the version is checked first and why its
    /// absence is a refusal: a v1 document must fail as an unsupported version,
    /// not as a manifest with no items.
    public static let version = 3

    /// Item-count bounds. The maximum matches the shared manifest's, so a
    /// folder that can be shared can also be sent to a device.
    public static let maxItems = 1000
    public static let minItems = 1

    /// One file name, in UTF-8 BYTES: the filesystem limit this eventually
    /// meets is a byte limit, not a character one.
    public static let maxNameBytes = 1024

    /// "/"-separated components in one name. A name may be a relative path so a
    /// folder send keeps its shape; this stops a thousand-deep demanded tree.
    public static let maxPathDepth = 64

    /// JavaScript's exact-integer ceiling, and therefore the protocol's: one of
    /// the three implementations of this codec runs in a browser, and a size
    /// only Swift and Go could hold exactly would decode differently there.
    public static let maxSafeInteger = 9_007_199_254_740_991

    /// Message length bounds, in UTF-8 bytes of the message itself. 1 because
    /// an empty message is not a message and a receiver asked to commit one
    /// would have to invent something to show; 64 KiB because that is far more
    /// than anyone types and small enough to hold in memory to display.
    public static let minTextBytes = 1
    public static let maxTextBytes = 65536
}

/// The closed content-kind set. A delivery is files or it is a message; there is
/// no third value and no "unknown" that a receiver could guess at.
public enum InboxManifestKind: String, Codable, Equatable, Sendable, CaseIterable {
    case file
    case text
}

/// Why a manifest was refused. A closed set rather than message text, so a
/// caller branches on the reason and the frozen vectors pin each clause.
public enum InboxManifestError: Error, Equatable, Sendable {
    case version
    case itemCount
    case unknownKind
    case mixedKinds
    case name
    case textName
    case textItemCount
    case size
    case totalOverflow
    case malformed
    case notCanonical
}

/// One entry. `name` is present for a file and `nil` for text — not empty, nil —
/// because text has no name and a receiver must never be handed a string it
/// could be tempted to treat as a destination.
public struct InboxManifestItem: Equatable, Sendable {
    public let kind: InboxManifestKind
    public let name: String?
    public let size: Int

    public init(kind: InboxManifestKind, name: String? = nil, size: Int) {
        self.kind = kind
        self.name = name
        self.size = size
    }
}

/// The whole document.
public struct InboxManifestV2: Equatable, Sendable {
    public let items: [InboxManifestItem]

    /// Unvalidated. Use `InboxManifest.files`/`InboxManifest.text` to build one
    /// that is known to satisfy every bound, or call `InboxManifest.validate`.
    public init(items: [InboxManifestItem]) {
        self.items = items
    }

    /// The single kind of a VALID manifest.
    public var kind: InboxManifestKind? { items.first?.kind }

    /// Sum of item sizes. Meaningful only on a validated manifest, where the
    /// sum is already known not to overflow.
    public var totalSize: Int { items.reduce(0) { $0 &+ $1.size } }
}

extension InboxManifest {
    // MARK: - construction

    /// Build a validated file manifest. The constructors exist so no caller
    /// assembles a value and skips the bounds.
    public static func files(_ entries: [(name: String, size: Int)]) throws -> InboxManifestV2 {
        let m = InboxManifestV2(items: entries.map {
            InboxManifestItem(kind: .file, name: $0.name, size: $0.size)
        })
        try validate(m)
        return m
    }

    /// Build the one-item manifest for a message of `size` UTF-8 bytes.
    public static func text(size: Int) throws -> InboxManifestV2 {
        let m = InboxManifestV2(items: [InboxManifestItem(kind: .text, size: size)])
        try validate(m)
        return m
    }

    // MARK: - validation

    /// Apply every bound, in a fixed order, and throw on the FIRST violation.
    ///
    /// The order is part of the contract, matched by the Go and TypeScript
    /// codecs: version, then shape, then per-item rules, then the aggregate —
    /// so a v1 document is reported as a version problem rather than as
    /// whatever its items happen to look like.
    public static func validate(_ m: InboxManifestV2) throws {
        guard m.items.count >= minItems, m.items.count <= maxItems else {
            throw InboxManifestError.itemCount
        }
        let kind = m.items[0].kind
        // Checked against item 0 rather than against a permitted set, so "all
        // text except one file" and "all files except one text" are refused by
        // the same rule.
        guard m.items.allSatisfy({ $0.kind == kind }) else { throw InboxManifestError.mixedKinds }

        if kind == .text {
            // One message per delivery. A second text item would have no way to
            // be told apart from the first in the frame stream, since text
            // carries no name — the receiver would have to guess the boundary.
            guard m.items.count == 1 else { throw InboxManifestError.textItemCount }
            let it = m.items[0]
            guard it.name == nil else { throw InboxManifestError.textName }
            guard it.size >= minTextBytes, it.size <= maxTextBytes else {
                throw InboxManifestError.size
            }
            return
        }

        var total = 0
        for it in m.items {
            guard let name = it.name, isAcceptableName(name) else { throw InboxManifestError.name }
            // Zero is legal — an empty file is a real file — but negative is
            // not, and neither is a value a browser could not hold exactly.
            guard it.size >= 0, it.size <= maxSafeInteger else { throw InboxManifestError.size }
            let (next, overflowed) = total.addingReportingOverflow(it.size)
            guard !overflowed, next <= maxSafeInteger else { throw InboxManifestError.totalOverflow }
            total = next
        }
    }

    /// The traversal-and-control rule, deliberately PLATFORM-NEUTRAL: exactly
    /// these names are accepted on every receiver, so one manifest is accepted
    /// or refused identically everywhere. A name that only some of a user's
    /// devices would take is worse than one none of them would.
    ///
    /// Platform-specific hardening — Windows reserved device names, components
    /// ending in a dot or a space, case-insensitive collisions — belongs to the
    /// receiver's destination planner, which knows the filesystem it is about to
    /// write to. Those checks run after this one, never instead of it.
    ///
    /// Refused here: empty or over `maxNameBytes`; any C0 control or DEL, which
    /// can truncate a C string or rewrite a terminal line as the name is logged
    /// or displayed; a backslash anywhere, because "/" is the separator by
    /// protocol and a backslash means "separator" on Windows; a leading "/" or a
    /// drive prefix, both of which leave the receive folder entirely; and any
    /// "", "." or ".." component, which is traversal.
    static func isAcceptableName(_ name: String) -> Bool {
        let bytes = Array(name.utf8)
        guard !bytes.isEmpty, bytes.count <= maxNameBytes else { return false }
        for scalar in name.unicodeScalars where scalar.value < 0x20 || scalar.value == 0x7f {
            return false
        }
        if name.contains("\\") { return false }
        if bytes[0] == UInt8(ascii: "/") { return false }
        // "C:foo" is drive-relative and "C:/foo" drive-absolute on Windows; both
        // escape a receive folder there while looking ordinary here.
        if bytes.count >= 2, bytes[1] == UInt8(ascii: ":") { return false }
        let parts = name.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count <= maxPathDepth else { return false }
        for p in parts where p.isEmpty || p == "." || p == ".." {
            return false
        }
        return true
    }

    // MARK: - the canonical form

    /// The ONE canonical byte sequence for `m`, after validating it.
    ///
    /// Hand-written rather than `JSONEncoder`, for the reason `StoredManifest`
    /// documents at length: on Darwin, `JSONEncoder` routes keyed output through
    /// `JSONSerialization`, whose key order is effectively hash-ordered, so
    /// encoding the same value twice in one process can produce two different
    /// byte sequences. A canonical form cannot be built on that. Go's encoder
    /// has its own divergence — it escapes `<`, `>`, `&` and U+2028/U+2029,
    /// which JavaScript does not — so all three write the bytes by hand.
    ///
    /// The rules: no whitespace, fixed key order (`v`, `items`; then `kind`,
    /// `name`, `size`), `name` omitted entirely for text, `"` `\` and the C0
    /// controls escaped (`\b \t \n \f \r` by name, the rest as lowercase
    /// `\u00xx`), everything else — DEL, C1 controls, bidi overrides and all
    /// non-ASCII — emitted raw as UTF-8, and `/` never escaped.
    public static func encode(_ m: InboxManifestV2) throws -> [UInt8] {
        try validate(m)
        var out = "{\"v\":\(version),\"items\":["
        for (i, it) in m.items.enumerated() {
            if i > 0 { out += "," }
            // `kind` is a closed set; no escapable character can occur in it.
            out += "{\"kind\":\"\(it.kind.rawValue)\""
            if it.kind == .file {
                out += ",\"name\":\""
                out += escapeInboxManifestString(it.name ?? "")
                out += "\""
            }
            out += ",\"size\":\(it.size)}"
        }
        out += "]}"
        return Array(out.utf8)
    }

    // MARK: - decoding

    /// Parse, validate, and refuse anything that is not the canonical spelling
    /// of what was parsed (invariant 3).
    ///
    /// The canonical-form check is what makes this strict without a hand-written
    /// parser: a duplicate `"size"` key where the last wins, `{"items":…,"v":2}`
    /// in the wrong order, a trailing newline and an escaped `\/` are all things
    /// `JSONSerialization` absorbs silently and the re-encode catches.
    public static func decode(_ data: [UInt8]) throws -> InboxManifestV2 {
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: Data(data), options: [])
        } catch {
            throw InboxManifestError.malformed
        }
        guard let raw = object as? [String: Any] else { throw InboxManifestError.malformed }

        // The version is read FIRST, and that ordering is part of the contract
        // rather than an accident. A v1 document is `{"files":[…]}` — no `v` at
        // all. Refused by the unknown-key check below it would be "unknown
        // field: files", which is true and useless; refused here it is
        // "unsupported version", which a person can act on. All three
        // implementations of this codec agree on this order.
        guard let rawVersion = raw["v"] else { throw InboxManifestError.version }
        guard let declared = exactInt(rawVersion) else { throw InboxManifestError.malformed }
        guard declared == version else { throw InboxManifestError.version }

        for key in raw.keys where key != "v" && key != "items" {
            throw InboxManifestError.malformed
        }
        guard let rawItems = raw["items"] else { throw InboxManifestError.itemCount }
        guard let entries = rawItems as? [Any] else { throw InboxManifestError.malformed }

        // A structural pass over EVERY entry before any semantic rule, matching
        // the Go decoder, where types and unknown fields are settled by the
        // decoder itself before validation begins. Without this the two would
        // disagree about which complaint a doubly-broken document earns.
        var items: [InboxManifestItem] = []
        items.reserveCapacity(entries.count)
        for entry in entries {
            guard let o = entry as? [String: Any] else { throw InboxManifestError.malformed }
            for key in o.keys where key != "kind" && key != "name" && key != "size" {
                throw InboxManifestError.malformed
            }
            guard let rawKind = o["kind"] else { throw InboxManifestError.unknownKind }
            guard let kindText = rawKind as? String else { throw InboxManifestError.malformed }
            guard let kind = InboxManifestKind(rawValue: kindText) else {
                throw InboxManifestError.unknownKind
            }
            var name: String?
            if let rawName = o["name"] {
                guard let text = rawName as? String else { throw InboxManifestError.malformed }
                name = text
            }
            guard let rawSize = o["size"], let size = exactInt(rawSize) else {
                throw InboxManifestError.malformed
            }
            items.append(InboxManifestItem(kind: kind, name: name, size: size))
        }

        let m = InboxManifestV2(items: items)
        try validate(m)
        guard try encode(m) == data else { throw InboxManifestError.notCanonical }
        return m
    }

    // MARK: - the sealed frame

    /// Open a delivery's frame 0 and decode the manifest inside it.
    ///
    /// The AEAD unit is the one Stored-Wire already defines — sequence 0, opened
    /// with the delivery's content key — and v2 changes only the document it
    /// carries. That is why this opens the bytes and hands them to `decode`
    /// rather than reaching for `decryptManifestRaw`: the shared codec would
    /// parse them as a `StoredManifest`, which has no content kind and would
    /// read a message as a nameless file.
    ///
    /// The two failures are deliberately different types. An AEAD refusal is a
    /// `StoredWireError`, the same one every other frame in the delivery raises,
    /// so a caller classifies it as the transport/authentication problem it is.
    /// Everything the document itself gets wrong is an `InboxManifestError`,
    /// which is terminal: the seal opened, so those are the sender's own bytes
    /// and every later attempt reads exactly the same ones.
    public static func open(key: [UInt8], sealed: [UInt8]) throws -> InboxManifestV2 {
        guard let plaintext = RelayiumKit.open(key: key, seq: 0, ciphertext: sealed) else {
            throw StoredWireError.truncatedStream
        }
        return try decode(plaintext)
    }

    /// An exact integer, or `nil`.
    ///
    /// `JSONSerialization` hands back an `NSNumber` that remembers how the
    /// number was SPELLED: `2` arrives as a long long and `2.0`, `1e3` and `1.5`
    /// arrive as doubles. Refusing the float-typed ones here is what makes a
    /// non-integer spelling a decode failure rather than a silent truncation —
    /// and `Bool` bridges to `NSNumber` too, so `true` must not become 1.
    private static func exactInt(_ value: Any) -> Int? {
        guard let n = value as? NSNumber else { return nil }
        switch String(cString: n.objCType) {
        case "c", "C", "B", "f", "d": return nil // Bool, Float, Double
        default: return n.intValue
        }
    }
}

/// Escapes exactly like JavaScript's `JSON.stringify`: `"`, `\`, the named
/// control shorthands, and every other C0 scalar as `\u00XX` in lowercase hex.
/// Everything else — DEL (U+007F), C1 controls, bidi overrides like U+202E,
/// U+2028/U+2029 and all non-ASCII text — is emitted raw as UTF-8, and `/` is
/// never escaped.
///
/// Duplicated from `StoredManifest`'s equivalent rather than shared with it, on
/// purpose: the two manifests are separate formats whose bytes must be free to
/// evolve independently, and a shared helper is exactly the coupling that would
/// make a change to one silently change the other.
private func escapeInboxManifestString(_ s: String) -> String {
    var out = String.UnicodeScalarView()
    for scalar in s.unicodeScalars {
        switch scalar {
        case "\"":
            out.append("\\"); out.append("\"")
        case "\\":
            out.append("\\"); out.append("\\")
        case "\u{08}":
            out.append("\\"); out.append("b")
        case "\u{09}":
            out.append("\\"); out.append("t")
        case "\u{0A}":
            out.append("\\"); out.append("n")
        case "\u{0C}":
            out.append("\\"); out.append("f")
        case "\u{0D}":
            out.append("\\"); out.append("r")
        default:
            if scalar.value < 0x20 {
                let hex = String(scalar.value, radix: 16)
                out.append("\\"); out.append("u")
                for _ in 0..<(4 - hex.count) { out.append("0") }
                out.append(contentsOf: hex.unicodeScalars)
            } else {
                out.append(scalar)
            }
        }
    }
    return String(out)
}
