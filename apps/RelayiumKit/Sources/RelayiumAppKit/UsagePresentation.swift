import Foundation
import RelayiumKit
import RelayiumShareKit

public struct MeterDisplay: Equatable {
    public let usedText: String
    public let capText: String
    /// `nil` when the plan is unlimited — there is no meaningful ratio to draw.
    public let fraction: Double?
    public let isUnlimited: Bool
}

public enum UsagePresentation {
    public static func display(_ m: Meter, language: AppLanguage? = nil) -> MeterDisplay {
        MeterDisplay(
            usedText: bytesText(m.used, language: language),
            capText: m.isUnlimited ? L10n.t(.usageUnlimited, language: language)
                                   : bytesText(m.cap, language: language),
            // Clamped: over-quota is a real server state and the bar must not overflow.
            fraction: m.isUnlimited ? nil : min(1.0, Double(m.used) / Double(m.cap)),
            isUnlimited: m.isUnlimited
        )
    }

    /// The badge shown next to the plan name, or `nil` when nothing should show.
    ///
    /// Two decisions live here, both of which were previously inside a SwiftUI view
    /// where no test could reach them. First the predicate: free accounts carry an
    /// empty status and an active subscription needs no annotation, so both are
    /// silent. Second the copy: `subscriptionStatus` is a raw Stripe status
    /// (`past_due`, `incomplete_expired`, …) and rendering it verbatim shows
    /// snake_case machine vocabulary to a paying customer at the exact moment
    /// something is wrong with their billing. Wording follows the web's
    /// (`web/src/lib/PlanCard.svelte` + `i18n/*.ts`) so the two surfaces agree in
    /// every language.
    public static func subscriptionBadge(for status: String,
                                         language: AppLanguage? = nil) -> String? {
        switch status {
        case "", "active":                       return nil
        case "trialing":                         return L10n.t(.badgeTrial, language: language)
        case "past_due":                         return L10n.t(.badgePaymentFailed, language: language)
        case "canceled":                         return L10n.t(.badgeCanceled, language: language)
        case "unpaid":                           return L10n.t(.badgeUnpaid, language: language)
        case "incomplete", "incomplete_expired": return L10n.t(.badgePaymentIncomplete, language: language)
        case "paused":                           return L10n.t(.badgePaused, language: language)
        // An unknown status is still not "active", so it must be visible — but as
        // words, not as whatever string a future Stripe version invents.
        default:                                 return L10n.t(.badgeInactive, language: language)
        }
    }

    /// Binary units, with Latin digits and this language's decimal separator.
    ///
    /// The unit symbols (`B`, `KB`, …) are technical and stay verbatim in every
    /// language; what the catalog owns is the separator between number and unit,
    /// so a right-to-left layout can put them in the order it wants.
    public static func bytesText(_ n: Int64, language: AppLanguage? = nil) -> String {
        L10n.bytes(n, language: language)
    }

    /// Whole days remaining rather than a formatted date: the figure a person
    /// actually wants, and it pluralizes per language rather than per English.
    public static func resetText(resetsAt: Int64, now: Date, language: AppLanguage? = nil) -> String {
        let seconds = Double(resetsAt) - now.timeIntervalSince1970
        guard seconds >= 86_400 else { return L10n.t(.usageResetsToday, language: language) }
        let days = Int(seconds / 86_400)
        return L10n.plural(.usageResetsInDays, days, language: language)
    }
}
