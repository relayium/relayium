import RelayiumKit
import RelayiumShareKit

/// The one visible identity for a file across every native task state.
///
/// Untrusted manifest paths are sanitized before display. A name made entirely
/// from control or bidi-control characters must still occupy a labelled row,
/// but the unsafe original must never be restored as a fallback.
public enum FileIdentityPresentation {
    public static func name(for file: FileMeta,
                            language: AppLanguage? = nil) -> String {
        let safe = safeDisplayName(file.path ?? file.name)
        return safe.isEmpty ? L10n.t(.fileUnnamed, language: language) : safe
    }

    public static func name(for file: ManifestFile,
                            language: AppLanguage? = nil) -> String {
        let safe = safeDisplayName(file.name)
        return safe.isEmpty ? L10n.t(.fileUnnamed, language: language) : safe
    }
}
