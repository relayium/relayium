import Foundation
import RelayiumKit

public struct MeterDisplay: Equatable {
    public let usedText: String
    public let capText: String
    /// `nil` when the plan is unlimited — there is no meaningful ratio to draw.
    public let fraction: Double?
    public let isUnlimited: Bool
}

public enum UsagePresentation {
    public static func display(_ m: Meter) -> MeterDisplay {
        MeterDisplay(
            usedText: bytesText(m.used),
            capText: m.isUnlimited ? "Unlimited" : bytesText(m.cap),
            // Clamped: over-quota is a real server state and the bar must not overflow.
            fraction: m.isUnlimited ? nil : min(1.0, Double(m.used) / Double(m.cap)),
            isUnlimited: m.isUnlimited
        )
    }

    /// Binary units. `String(format:)` with no locale argument does not localize the
    /// decimal separator, so this is stable across machines and in CI.
    public static func bytesText(_ n: Int64) -> String {
        let units = ["B", "KB", "MB", "GB", "TB"]
        var value = Double(n)
        var unit = 0
        while value >= 1024 && unit < units.count - 1 {
            value /= 1024
            unit += 1
        }
        if unit == 0 { return "\(n) B" }
        return String(format: "%.1f %@", value, units[unit])
    }

    /// Whole days remaining rather than a formatted date: no locale dependence, and
    /// "resets in 5 days" is what a person actually wants to know.
    public static func resetText(resetsAt: Int64, now: Date) -> String {
        let seconds = Double(resetsAt) - now.timeIntervalSince1970
        guard seconds >= 86_400 else { return "Resets today" }
        let days = Int(seconds / 86_400)
        return days == 1 ? "Resets in 1 day" : "Resets in \(days) days"
    }
}
