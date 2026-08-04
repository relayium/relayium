import Foundation
import RelayiumShareKit

/// What the "Link ready" screen says about the key that opens an upload.
///
/// One statement, chosen from what actually happened — never two. The two
/// possible facts contradict each other outright: either this device kept the
/// key, in which case the link on screen is reproducible from the Account tab,
/// or it did not, in which case that link is the only copy there will ever be.
/// Saying both, which is what a fixed line plus a conditional warning does,
/// teaches the user to believe neither.
public struct UploadKeyNotice: Equatable {
    public let text: String
    /// Whether this is the case the user has to act on now. The pane renders a
    /// warning with an icon rather than a grey footnote, because a footnote is
    /// exactly what someone closing a window does not read.
    public let isWarning: Bool

    public init(text: String, isWarning: Bool) {
        self.text = text
        self.isWarning = isWarning
    }
}

public enum UploadPresentation {
    /// Said when the key is safely on this device. It is the reassuring case and
    /// it is also the privacy claim: the key never reached Relayium, which is
    /// what makes the stored ciphertext unreadable to it.
    ///
    /// A function rather than the constant it used to be, because it is one of
    /// the two statements the localization has to keep TRUE in every language:
    /// "stored on this device" and "never sent to Relayium's servers" are the
    /// E2E guarantee, not marketing.
    ///
    /// The noun is *device*, not *Mac*: the same sentence is rendered on iOS
    /// from R3-C onwards, and what it has to keep true is where the key lives —
    /// not which platform is reading it.
    public static func keyKeptText(language: AppLanguage? = nil) -> String {
        L10n.t(.uploadKeyKept, language: language)
    }

    /// `warning` is `UploadState.done`'s — non-nil exactly when the upload
    /// succeeded but this device could not keep the key. It arrives already
    /// localized (`CloudUploadModel` builds it through `ErrorCopy`), so it is
    /// passed through rather than looked up again.
    public static func keyNotice(warning: String?, language: AppLanguage? = nil) -> UploadKeyNotice {
        guard let warning else {
            return UploadKeyNotice(text: keyKeptText(language: language), isWarning: false)
        }
        return UploadKeyNotice(text: warning, isWarning: true)
    }
}

/// Retention choices, named.
///
/// Lives beside the other presentation seams rather than in the pane: the same
/// five values are offered by the web and will be offered by iOS, and a `[Int:
/// String]` dictionary inside a SwiftUI view is a table no test can reach.
public enum TtlPresentation {
    public static func label(seconds: Int, language: AppLanguage? = nil) -> String {
        switch seconds {
        case 3600:      return L10n.t(.ttlOneHour, language: language)
        case 86_400:    return L10n.t(.ttlOneDay, language: language)
        case 259_200:   return L10n.t(.ttlThreeDays, language: language)
        case 604_800:   return L10n.t(.ttlSevenDays, language: language)
        case 1_209_600: return L10n.t(.ttlFourteenDays, language: language)
        default:
            // A retention the server offers and this build has no name for.
            // Shown as the raw seconds rather than hidden, so a new plan tier
            // is usable before the app catches up.
            return L10n.t(.ttlSeconds, [L10n.token(String(seconds), language: language)],
                          language: language)
        }
    }
}
