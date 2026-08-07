import Foundation

/// Keeps simulator UI acceptance from joining the public Nearby rendezvous.
///
/// The launch argument is absent from Release builds: the shipped binary folds
/// this to `false`, so reachability cannot be disabled by a user or a link.
enum UITestMode {
    #if DEBUG
    static let isActive = ProcessInfo.processInfo.arguments.contains(
        "--relayium-ui-testing") // nonlocalized: test-only launch argument
    #else
    static let isActive = false
    #endif
}
