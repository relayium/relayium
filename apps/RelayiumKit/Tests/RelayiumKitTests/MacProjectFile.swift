import XCTest

/// The macOS `project.pbxproj`, read as per-target build settings.
///
/// Several guards make claims about what the macOS project *configures* rather
/// than about what its code does — the hardened runtime, the signing style —
/// because those settings have no runtime an ordinary test can observe. They all
/// need the same thing: the settings of one named target's one named
/// configuration. This is that reader, extracted so there is one copy of it
/// rather than one per guard.
///
/// `IOSDistributionSigningTests` deliberately keeps its own: it matches
/// configuration blocks by `PRODUCT_BUNDLE_IDENTIFIER`, which works there and
/// cannot work here, because the App Store app and the direct app share
/// `com.relayium.mac` and both Share extensions share `com.relayium.mac.Share`
/// (`StoreKitLinkageTests`). Targets are therefore reached through their
/// `XCConfigurationList`, which names its configurations by object id.
struct MacProjectFile {
    enum Failure: Error, CustomStringConvertible {
        case unreadableStructure(String)

        var description: String {
            switch self {
            case .unreadableStructure(let detail): return detail
            }
        }
    }

    let text: String

    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → repo root.
    private static var repoRoot: URL {
        (0..<5).reduce(URL(fileURLWithPath: #filePath)) { url, _ in url.deletingLastPathComponent() }
    }

    static let path = "apps/mac/Relayium.xcodeproj/project.pbxproj"

    init() throws {
        text = try String(contentsOf: Self.repoRoot.appendingPathComponent(Self.path),
                          encoding: .utf8)
    }

    /// A parsed `XCBuildConfiguration`: its name, and its settings.
    struct Configuration {
        let name: String
        let settings: [String: String]
    }

    /// Every `XCBuildConfiguration` in the project, keyed by its object id.
    ///
    /// Split on the `isa` line, with the object id recovered from the
    /// *preceding* component's last `A1…` token, because a configuration is only
    /// useful here once it can be attributed to the target whose list names it.
    ///
    /// Multi-line settings such as `LD_RUNPATH_SEARCH_PATHS` contribute no
    /// ` = ` lines of their own and are skipped; `name = <configuration>;`
    /// closes the block.
    func configurationsByID() throws -> [String: Configuration] {
        let parts = text.components(separatedBy: "isa = XCBuildConfiguration;")
        var blocks: [String: Configuration] = [:]
        for index in 1..<max(parts.count, 1) {
            guard let id = parts[index - 1]
                .components(separatedBy: .whitespacesAndNewlines)
                .last(where: { $0.hasPrefix("A1") })
            else { continue }
            var settings: [String: String] = [:]
            var name = ""
            for line in parts[index].components(separatedBy: "\n") {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard let separator = trimmed.range(of: " = ") else { continue }
                let key = String(trimmed[trimmed.startIndex..<separator.lowerBound])
                let value = trimmed[separator.upperBound...]
                    .trimmingCharacters(in: CharacterSet(charactersIn: ";\" "))
                if key == "name" {
                    name = value
                    break
                }
                settings[key] = value
            }
            blocks[id] = Configuration(name: name, settings: settings)
        }
        // A structural tripwire, not a policy claim: if the file format moves
        // under this parser it returns an empty or tiny dictionary, and every
        // guard built on it would pass by finding nothing to check.
        guard blocks.count >= 10 else {
            throw Failure.unreadableStructure(
                "read \(blocks.count) build configurations from \(Self.path); "
                + "the parser no longer matches the project file")
        }
        return blocks
    }

    /// The configurations a named native target builds with, by configuration name.
    ///
    /// Exactly `Debug` and `Release` are required. A target that grew a third
    /// configuration, or lost one, fails here rather than letting a caller pass
    /// on the two configuration names it happens to ask about.
    func configurations(ofTarget target: String) throws -> [String: [String: String]] {
        let marker = "Build configuration list for PBXNativeTarget \"\(target)\" */ = {"
        guard let start = text.range(of: marker) else {
            throw Failure.unreadableStructure("no configuration list for \(target)")
        }
        let rest = text[start.upperBound...]
        guard let end = rest.range(of: "\n\t\t};") else {
            throw Failure.unreadableStructure("unterminated configuration list for \(target)")
        }
        let ids = rest[..<end.lowerBound].components(separatedBy: "\n")
            .compactMap { line -> String? in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard trimmed.hasPrefix("A1"), let space = trimmed.firstIndex(of: " ") else {
                    return nil
                }
                return String(trimmed[..<space])
            }

        let blocks = try configurationsByID()
        var byName: [String: [String: String]] = [:]
        for id in ids {
            guard let block = blocks[id] else {
                throw Failure.unreadableStructure(
                    "\(target) names configuration \(id), which has no block")
            }
            byName[block.name] = block.settings
        }
        guard Set(byName.keys) == ["Debug", "Release"] else {
            throw Failure.unreadableStructure(
                "\(target) no longer has exactly a Debug and a Release configuration")
        }
        return byName
    }
}
