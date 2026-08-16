import Foundation

/// A Relayium marketing version, ordered.
///
/// Deliberately NOT `OperatingSystemVersion`, `Bundle`'s string compare, or a
/// lexicographic one: `"1.2.10" < "1.2.9"` is true as text and false as a
/// product fact, and that single comparison is what decides whether this build
/// is allowed to run. So the ordering is numeric, component by component, with a
/// missing component read as zero — `1.2` and `1.2.0` are the same version.
///
/// Parsing is strict and total. A version this type cannot read is `nil` rather
/// than a best guess, because every caller here treats an unreadable version as
/// "do not act", and a lenient parse would turn `1.2.4-beta` into a number and
/// then compare it against a policy that meant something else.
public struct AppVersion: Comparable, Hashable, Sendable, CustomStringConvertible {
    /// Numeric components, in order. Always 1…4 of them, each non-negative.
    public let components: [Int]

    /// The exact text this was parsed from, so a rendered version reads as the
    /// product wrote it rather than as this type re-spells it.
    public let description: String

    /// The most digits one component may carry.
    ///
    /// A bound rather than `Int`'s, so a hostile or corrupt document cannot
    /// arrive with a 200-digit component and be compared at all.
    private static let maxComponentDigits = 9
    private static let maxComponents = 4

    /// Strict parse: digits and dots only, 1…4 components, no empty component,
    /// no sign, no build metadata, no leading zeros on a multi-digit component.
    ///
    /// Leading zeros are refused rather than normalized because `1.02` and `1.2`
    /// would then be one version written two ways, and the policy document is
    /// compared for equality in tests and staged by a script. One spelling.
    public init?(_ text: String) {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...Self.maxComponents).contains(parts.count) else { return nil }
        var values: [Int] = []
        values.reserveCapacity(parts.count)
        for part in parts {
            guard !part.isEmpty, part.count <= Self.maxComponentDigits,
                  part.allSatisfy(\.isASCII), part.allSatisfy(\.isNumber),
                  part.count == 1 || part.first != "0",
                  let value = Int(part) else { return nil }
            values.append(value)
        }
        components = values
        description = text
    }

    /// Component-wise, shorter padded with zeros.
    public static func < (lhs: AppVersion, rhs: AppVersion) -> Bool {
        let count = max(lhs.components.count, rhs.components.count)
        for index in 0..<count {
            let left = index < lhs.components.count ? lhs.components[index] : 0
            let right = index < rhs.components.count ? rhs.components[index] : 0
            if left != right { return left < right }
        }
        return false
    }

    /// `1.2` and `1.2.0` are the same version, so equality is the ordering's and
    /// not the text's — otherwise a policy that spelled a version with a
    /// trailing `.0` would read as a different one.
    public static func == (lhs: AppVersion, rhs: AppVersion) -> Bool {
        !(lhs < rhs) && !(rhs < lhs)
    }

    public func hash(into hasher: inout Hasher) {
        var normalized = components
        while normalized.count > 1, normalized.last == 0 { normalized.removeLast() }
        hasher.combine(normalized)
    }
}

/// **What the product says about which builds may run.**
///
/// Three versions and one build number, and nothing else — in particular **no
/// URL of any kind**. That absence is a security property, not an omission: this
/// document is fetched over the network, and a policy that could name where an
/// update comes from would be a remote redirect for the one action that installs
/// code on the user's Mac. Where an update comes from is decided by the shipped
/// updater (Sparkle's signed appcast in the direct build, the App Store in the
/// other), and this document can only ever decide WHETHER the app asks for one.
///
/// `minimumSupportedBuild` is the same decision expressed in `CFBundleVersion`,
/// which is what Sparkle's `sparkle:criticalUpdate` compares — the appcast and
/// this document are therefore one policy in two vocabularies, and
/// `stage-macos-release.mjs` derives the appcast's threshold from this file so
/// they cannot drift.
public struct SupportedVersionPolicy: Equatable, Sendable {
    /// Below this, the app must not run its product surfaces.
    public let minimumSupported: AppVersion
    /// Below this, the app says so and carries on.
    public let recommended: AppVersion
    /// The newest published version, for the sentence the user reads.
    public let latest: AppVersion
    /// `minimumSupported` as a `CFBundleVersion`, for the Sparkle appcast.
    public let minimumSupportedBuild: Int

    public init(minimumSupported: AppVersion,
                recommended: AppVersion,
                latest: AppVersion,
                minimumSupportedBuild: Int) {
        self.minimumSupported = minimumSupported
        self.recommended = recommended
        self.latest = latest
        self.minimumSupportedBuild = minimumSupportedBuild
    }

    /// The schema version this build understands. A document that announces a
    /// different one is refused rather than read optimistically: a future schema
    /// may move a field this build would then silently read as absent.
    public static let schema = 1

    /// The largest document this build will read, in bytes.
    ///
    /// The real one is a few hundred bytes. The bound exists so a compromised or
    /// misconfigured origin cannot hand a client an unbounded body to buffer.
    public static let maxDocumentBytes = 8 * 1024

    /// **The floor compiled into this build, and the reason a network outage
    /// cannot brick it.**
    ///
    /// Two jobs:
    ///
    ///  1. It is the policy in force when there is no valid remote or cached
    ///     one. It is chosen so that the build shipping it is itself supported —
    ///     `SupportedVersionSurfaceTests` refuses a floor above this app's own
    ///     version — so falling back to it can never block the app that carries
    ///     it. That is what "fail open" means here, concretely.
    ///  2. It is the level below which a remote document may not take the policy.
    ///     A served document may make the requirement STRICTER and never weaker,
    ///     so a replayed or rolled-back copy of an older policy cannot unblock a
    ///     client that this build already knows must stop.
    ///
    /// It is per build, so lowering the requirement for real is a thing a future
    /// release does by shipping a lower floor — not something an old binary can
    /// be talked into over the network.
    public static let embeddedFloor = SupportedVersionPolicy(
        minimumSupported: AppVersion("1.2.4")!,
        recommended: AppVersion("1.2.5")!,
        latest: AppVersion("1.2.7")!,
        minimumSupportedBuild: 11)
}

/// Why a served document was refused. Each case is a distinct failure a test
/// drives, rather than one `invalid` that could hide a rule that stopped running.
public enum SupportedVersionPolicyError: Error, Equatable, Sendable {
    /// Not JSON, not an object, or a required field is missing or the wrong type.
    case malformed
    /// The document is larger than this build will read.
    case tooLarge
    /// `schema` is not the one this build understands.
    case unsupportedSchema(Int)
    /// A version string this build cannot order.
    case unreadableVersion(String)
    /// `minimum > recommended`, `recommended > latest`, or a build number that
    /// is not a positive integer — a document that contradicts itself.
    case inconsistent
    /// The document would take the requirement BELOW this build's embedded
    /// floor: a rollback, whether hostile or an operator mistake.
    case weakerThanFloor
}

extension SupportedVersionPolicy {
    /// Read a served or cached document, refusing everything the app must not act on.
    ///
    /// Unknown keys — at the top level and inside `macos` — are ignored, which is
    /// what makes the schema extensible without a client change. Unknown keys are
    /// not, however, a way in: nothing here reads a URL, a host, a path, a
    /// signature or a command, whatever the document contains.
    ///
    /// - Parameter floor: the requirement this document may not go below. Always
    ///   `embeddedFloor` in the product; a parameter so the rejection itself is
    ///   testable without shipping a second floor.
    public static func decode(
        _ data: Data,
        floor: SupportedVersionPolicy = .embeddedFloor
    ) throws -> SupportedVersionPolicy {
        guard data.count <= maxDocumentBytes else { throw SupportedVersionPolicyError.tooLarge }
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw SupportedVersionPolicyError.malformed
        }
        guard let announced = integer(root["schema"]) else {
            throw SupportedVersionPolicyError.malformed
        }
        guard announced == schema else {
            throw SupportedVersionPolicyError.unsupportedSchema(announced)
        }
        guard let mac = root["macos"] as? [String: Any] else {
            throw SupportedVersionPolicyError.malformed
        }
        func version(_ key: String) throws -> AppVersion {
            guard let text = mac[key] as? String else { throw SupportedVersionPolicyError.malformed }
            guard let value = AppVersion(text) else {
                throw SupportedVersionPolicyError.unreadableVersion(text)
            }
            return value
        }
        let minimum = try version("minimumSupportedVersion")
        let recommended = try version("recommendedVersion")
        let latest = try version("latestVersion")
        guard let build = integer(mac["minimumSupportedBuild"]) else {
            throw SupportedVersionPolicyError.malformed
        }
        guard build > 0, minimum <= recommended, recommended <= latest else {
            throw SupportedVersionPolicyError.inconsistent
        }
        // The rollback gate. All three of the requirement-bearing fields, so a
        // document cannot weaken one while leaving the others alone. `latest` is
        // deliberately not here: it names what is published, not what is
        // required, and a release that is pulled legitimately lowers it.
        guard minimum >= floor.minimumSupported,
              recommended >= floor.recommended,
              build >= floor.minimumSupportedBuild else {
            throw SupportedVersionPolicyError.weakerThanFloor
        }
        return SupportedVersionPolicy(minimumSupported: minimum,
                                      recommended: recommended,
                                      latest: latest,
                                      minimumSupportedBuild: build)
    }

    /// A JSON integer, and nothing that merely looks like one.
    ///
    /// **`as? Int` alone is not enough, and `is Bool` is actively wrong here.**
    /// `JSONSerialization` hands back `NSNumber`, and every `NSNumber` bridges
    /// to `Bool` — so a guard written as `value as? Int, !(value is Bool)`
    /// rejects `1`, `11` and every other perfectly good integer. Measured
    /// exactly that way: every document in the decoding suite came back
    /// `.malformed`, including the one this product ships.
    ///
    /// The type id is the question that actually distinguishes them. `1.5` and
    /// `"11"` are refused by the value-preserving bridge below.
    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        return number as? Int
    }
}

/// What this build is, against the policy in force.
public enum SupportedVersionState: Equatable, Sendable {
    /// Nothing to say.
    case supported
    /// Below `recommended`: a dismissible sentence, never a block.
    case updateRecommended(policy: SupportedVersionPolicy)
    /// Below `minimumSupported`: the product surfaces do not run.
    case updateRequired(policy: SupportedVersionPolicy)

    public var isBlocking: Bool {
        if case .updateRequired = self { return true }
        return false
    }

    /// The policy this state was decided against, for the sentence it renders.
    public var policy: SupportedVersionPolicy? {
        switch self {
        case .supported:                       return nil
        case let .updateRecommended(policy):   return policy
        case let .updateRequired(policy):      return policy
        }
    }

    /// **The whole decision, and the only place it is made.**
    ///
    /// Compared on the MARKETING version, which is what the policy document and
    /// every user-facing sentence speak in. The build number is the appcast's
    /// vocabulary and stays there.
    ///
    /// `current` is optional because a bundle that cannot say what version it is
    /// exists — and the answer for it is `.supported`. Blocking a running app on
    /// a version it failed to READ would turn a packaging fault into a product
    /// that cannot be used at all, and it is the one input no update can fix.
    public static func evaluate(current: AppVersion?,
                                policy: SupportedVersionPolicy) -> SupportedVersionState {
        guard let current else { return .supported }
        if current < policy.minimumSupported { return .updateRequired(policy: policy) }
        if current < policy.recommended { return .updateRecommended(policy: policy) }
        return .supported
    }
}
