import Foundation

/// What the Device Inbox surface should render right now, decided once from two
/// facts rather than re-derived by each host.
///
/// ## Why this is a type and not an `if` in the view
///
/// The Device Inbox is now rendered in two places — the main window's own
/// destination and the ⌘, tab — and the branch it takes is the difference
/// between offering an unattended-write consent and offering a way to sign in.
/// A rule written twice is a rule that can disagree with itself, and neither
/// copy would be reachable by a test.
///
/// ## The two facts, and why neither one alone is enough
///
/// `AccountGate` answers "is there a usable account", and `InboxController`'s
/// `isSignedIn` answers "has the receiver adopted one". They are normally the
/// same answer one turn apart, and there is one state in which they are not and
/// stay that way: an account whose id this build refuses to use as a keychain
/// item name leaves the controller with no generation at all while the session is
/// perfectly `ready`. In that state:
///
///  - rendering the full surface would offer a folder chooser and a policy
///    picker whose setters return immediately, which is the dead-control defect
///    this app has already shipped once;
///  - rendering the gate would hand `CapabilityGateView` an `.allowed` gate,
///    which it asserts on and draws nothing for.
///
/// So it is its own case. `statusOnly` renders the truthful status sentence and
/// the route to the account, and nothing that cannot work.
/// `Sendable` is deliberately absent: `AccountGate` is not, and a conformance
/// this type cannot honestly make is worse than the one call site it would save.
/// Everything here is main-actor work anyway.
public enum DeviceInboxEntry: Equatable {
    /// The complete product surface: status and recovery, the folder grant, the
    /// policy, the held questions, the results, residency and the notification
    /// warning.
    case surface
    /// An account is present and the receiver is not running for it — starting
    /// up, or stopped on a terminal identity failure. Status and the way to the
    /// account, and no control the controller would refuse.
    case statusOnly
    /// No usable account. The gate carries the executable route to one, which is
    /// the whole reason this destination stays visible signed out.
    case account(AccountGate)

    /// The mapping, total over both inputs.
    ///
    /// The `switch` carries **no `default`**: a new `AccountGate` case has to
    /// state whether it is something the Device Inbox can run under, rather than
    /// inheriting whichever arm happened to be last.
    public static func entry(gate: AccountGate, isSignedIn: Bool) -> DeviceInboxEntry {
        // The receiver's own answer wins wherever it is positive. It is the object
        // that actually holds the generation the folder grant, the policy and every
        // claim are scoped to, so "it is running" is a fact about the thing being
        // rendered rather than an inference from the session beside it.
        if isSignedIn { return .surface }
        switch gate {
        case .allowed:
            return .statusOnly
        case .loading, .signInRequired, .unavailable, .verifyEmail, .pendingDeletion:
            return .account(gate)
        }
    }
}
