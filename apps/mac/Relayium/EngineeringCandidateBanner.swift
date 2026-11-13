import SwiftUI

/// A permanent, non-dismissible identity boundary for the isolated candidate.
/// This is a technical build label rather than localized product prose: its
/// exact address is part of the safety signal and must be identical everywhere.
struct EngineeringCandidateBanner: View {
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "wrench.and.screwdriver.fill")
            Text(identity) // nonlocalized: build identity
                .font(.system(.caption, design: .monospaced, weight: .bold))
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .foregroundStyle(.black)
        .background(Color.yellow)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("engineering-local-server-banner")
    }

    private var identity: String {
#if RELAYIUM_ENGINEERING_CANDIDATE
        "ENGINEERING · LOCAL SERVER · 127.0.0.1:18080" // nonlocalized: compile-time engineering identity
#else
        "ENGINEERING · PRIVATE TEST · relayium.com" // nonlocalized: compile-time engineering identity
#endif
    }
}
