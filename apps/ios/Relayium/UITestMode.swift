import Foundation

/// Keeps simulator UI acceptance from joining the public Nearby rendezvous.
///
/// The launch argument is absent from Release builds: the shipped binary folds
/// this to `false`, so reachability cannot be disabled by a user or a link.
enum UITestMode {
    #if DEBUG
    static let isActive = ProcessInfo.processInfo.arguments.contains(
        "--relayium-ui-testing") // nonlocalized: test-only launch argument

    /// Whether this launch should leave one deterministic file where the system
    /// document browser can reach it.
    ///
    /// It stages a file and nothing else. The picker the test then drives, the
    /// security scope it hands back, the expansion, the limits and the rendered
    /// pending row are all production code — the alternative, injecting a
    /// selection directly, would prove only that a list renders what it is
    /// given. A separate argument from `isActive` so the ordinary acceptance
    /// paths never write into the container at all.
    // nonlocalized: a test-only launch argument, absent from Release
    static let pendingFixtureArgument = "--relayium-ui-testing-pending-fixture"
    static let stagesPendingFixture = ProcessInfo.processInfo.arguments.contains(
        pendingFixtureArgument)

    /// Holds Nearby in the state a destination failure leaves behind: off,
    /// with no pause anywhere.
    ///
    /// It asks the launch to skip both the pause the other acceptance paths
    /// take and the residency a shipped launch starts — which is not a fourth
    /// state invented for a test, but exactly the one a model that never became
    /// resident is already in.
    // nonlocalized: a test-only launch argument, absent from Release
    static let offReceivingArgument = "--relayium-ui-testing-off-receiving"
    static let showsOffReceiving = ProcessInfo.processInfo.arguments.contains(
        offReceivingArgument)

    /// 1,536 bytes, so the size the row must render is an exact, unambiguous
    /// `1.5 KB` rather than a value that depends on rounding.
    static let pendingFixtureName = "Relayium product brief.txt" // nonlocalized: a test fixture
    private static let pendingFixtureByteCount = 1_536

    /// Rewritten on every launch that asks for it, so a container surviving
    /// from an earlier run cannot leave a stale name or length behind.
    static func stagePendingFixture() {
        guard stagesPendingFixture,
              let documents = try? FileManager.default.url(
                for: .documentDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true) else { return }
        try? Data(repeating: 0x52, count: pendingFixtureByteCount).write(
            to: documents.appendingPathComponent(pendingFixtureName), options: .atomic)
    }
    #else
    static let isActive = false
    /// Folded to a constant, so a shipped launch always takes the residency
    /// branch and no argument can hold this device out of the room.
    static let showsOffReceiving = false

    /// In Release the whole idea is absent: the optimiser folds this to an
    /// empty call, and no argument can reach the container.
    static func stagePendingFixture() {}
    #endif
}
