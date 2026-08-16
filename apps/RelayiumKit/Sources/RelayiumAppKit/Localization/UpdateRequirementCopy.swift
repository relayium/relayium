import Foundation
import RelayiumShareKit

/// The sentences the version policy renders, assembled where a test can reach them.
///
/// The views that draw these are SwiftUI, and a string built inside a `View`'s
/// body is unreachable from `swift test` — which for this feature would mean the
/// one screen a user sees when their build stops working has no assertion behind
/// its wording in either maintained language.
///
/// Every version number goes through `L10n.token`, for the reason recorded on
/// that function: a bare `1.2.4` dropped into a right-to-left sentence is laid
/// out against the surrounding text and can come apart. The maintained set is
/// English and Simplified Chinese, but the copy is rendered through the same
/// catalogs as everything else and the seven frozen locales still fall back to
/// English rather than to a raw key.
public enum UpdateRequirementPresentation {

    /// The blocking screen's sentence: what is running, what is required, what
    /// is available. All three, because two of them alone leave the reader
    /// unable to tell whether updating will actually fix it.
    public static func requiredBody(current: AppVersion?,
                                    policy: SupportedVersionPolicy,
                                    language: AppLanguage? = nil) -> String {
        L10n.t(.updateRequiredBody, [
            L10n.token(versionText(current, language: language), language: language),
            L10n.token(policy.minimumSupported.description, language: language),
            L10n.token(policy.latest.description, language: language),
        ], language: language)
    }

    /// The dismissible line's sentence. No requirement in it: nothing is wrong
    /// with this build, and saying "required" here is how a recommendation
    /// starts reading as a block.
    public static func recommendedBody(current: AppVersion?,
                                       policy: SupportedVersionPolicy,
                                       language: AppLanguage? = nil) -> String {
        L10n.t(.updateRecommendedBody, [
            L10n.token(versionText(current, language: language), language: language),
            L10n.token(policy.latest.description, language: language),
        ], language: language)
    }

    /// **The action label follows the mechanism, not the wording.**
    ///
    /// The direct build installs the update itself, through Sparkle, so "Update
    /// Now" is a promise it keeps. The App Store build cannot install anything:
    /// the most it can do is take the user to the App Store, and a button that
    /// said "Update Now" there would describe an install this app has no way to
    /// perform.
    public static func updateActionLabel(channel: AppDistributionChannel,
                                         language: AppLanguage? = nil) -> String {
        switch channel {
        case .directDownload: return L10n.t(.updateActionUpdate, language: language)
        case .macAppStore, .iosAppStore:
            return L10n.t(.updateActionOpenAppStore, language: language)
        }
    }

    /// A bundle that cannot say what version it is never reaches the blocking
    /// screen — `SupportedVersionState.evaluate` answers `.supported` for it —
    /// but the recommendation can still be rendered for one, so the placeholder
    /// exists rather than an empty gap in the middle of a sentence.
    // nonlocalized: an em dash placeholder for a missing bundle value
    private static let missingVersion = "—"

    private static func versionText(_ version: AppVersion?, language: AppLanguage?) -> String {
        version?.description ?? missingVersion
    }
}
