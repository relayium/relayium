import Foundation

/// **How the two devices in a two-physical-device run announce themselves to
/// each other, which decides how a roster row may be selected.**
///
/// `AppEnvironment.deviceName()` answers the device FAMILY on iOS — "iPhone",
/// "iPad", "iPod touch" — rather than the name the owner gave the device. That
/// is a privacy property of the product and it is correct: the code-less room is
/// keyed by the public address the hub observes, so it can hold strangers, and
/// broadcasting "Lily's iPad" into it would be worse than broadcasting "iPad".
///
/// It also means a valid pair of test devices can announce the SAME string, and
/// the two announced names then carry different amounts of information:
///
///  - `distinct` — one iPhone and one iPad. The family name is decisive WITHIN
///    the pair, so a row carrying it is evidence about which device it is, and
///    the suite keeps requiring it;
///  - `shared` — two iPads. The name is the same on both ends and on any
///    stranger of the same family, so a name match distinguishes nothing. A
///    check that reads as identification while identifying nothing is worse than
///    no check, because a reader believes it. So `shared` does not consult the
///    name at all and identifies the peer the only two ways that remain: the
///    room holds exactly ONE selectable device row, and — the actual proof —
///    both ends independently derive the same short-authentication string, which
///    the launcher requires equal.
///
/// The mode is decided by the launcher from the two RESOLVED device records and
/// handed in, never guessed here, and it never changes what a device is CALLED:
/// there is no device-name override, no debug seam and no product change behind
/// it. See `scripts/ios-device-pair-acceptance.sh`.
enum DevicePairPeerNaming: String {
    /// The two devices announce different family names.
    case distinct
    /// Both devices announce the same family name.
    case shared
}

/// **One roster candidate, reduced to the two facts the decision needs.**
///
/// A value rather than a live `XCUIElement` on purpose. Every property read off
/// an element is another full accessibility-hierarchy snapshot, and a rule that
/// re-reads `label` and `isEnabled` while it decides is a rule evaluating a
/// roster that may have changed between its own clauses — which, on a live list
/// keyed to a room devices join and leave, is exactly the race that makes "the
/// wrong row got tapped" unreproducible. The caller snapshots once and the
/// decision is then pure.
struct DevicePairRosterCandidate: Equatable {
    let label: String
    let isEnabled: Bool

    init(label: String, isEnabled: Bool) {
        self.label = label
        self.isEnabled = isEnabled
    }
}

/// **Which roster row a runner may tap, or why it may tap none — the whole rule,
/// as a pure function.**
///
/// ## Why this is a value and not five `guard`s inside the wait
///
/// A two-physical-device harness has almost no automatic evidence available to
/// it: every claim it makes normally costs two phones, a build and a run. This
/// rule is the one part of roster selection that is decidable without a device,
/// so it is written where `swift test` can EXECUTE it — `DevicePairSeamTests`
/// compiles this file on its own and drives the zero, one, two and
/// three-candidate cases in both naming modes. A rule pinned only by reading its
/// source cannot tell "requires exactly one" from "requires at least one", and
/// those two differ by precisely the defect this exists to prevent.
///
/// ## Two scopes, and why the count is the MAXIMUM of them
///
/// Current `main` gives the roster exactly two queryable scopes, and this rule
/// reads both:
///
///  1. **contained** — `NearbyView.roster` draws every row inside one container
///     it labels `nearby.a11yDevices` ("Nearby devices"), and `actions(for:)`
///     is rendered OUTSIDE that container, so the container's buttons are the
///     device rows and nothing else;
///  2. **named** — buttons whose label carries the peer's announced family name.
///
/// There is deliberately no third, per-row identifier scope. The product on this
/// branch applies no `accessibilityIdentifier` to a roster row, so a scope
/// querying one would be a selector that can never match — and a rule that
/// counted it would read a two-device room as a one-device room whenever the
/// container scope was the one that failed.
///
/// Reading both is not belt-and-braces, and taking the MAXIMUM is not caution.
/// Partial exposure is the dangerous case: if SwiftUI publishes the container
/// for one row out of two, a container-only count reads a two-device room as a
/// one-device room and taps a row it cannot justify. `max` makes a candidate
/// that EITHER scope can see count against the run, so exposure can make this
/// rule refuse but can never make it choose.
///
/// The name scope is the WEAKER scope and is ordered last for it: in `shared`
/// mode it cannot distinguish the peer from a same-family stranger, and in
/// neither mode does it see a device announcing something else. It is a rescue
/// for a room the container scope could not enumerate, never a preference.
enum DevicePairRosterChoice: Equatable {

    /// Tap the single row the roster container held.
    case takeContained
    /// Tap the single row that carried the peer's announced name. Reached only
    /// when the container scope did not enumerate the room.
    case takeNamed
    /// No device row in either scope.
    case empty
    /// More than one candidate. Both counts are carried because which scope saw
    /// how many is the finding — a container count below the name count is
    /// partial exposure, not a smaller room.
    case ambiguous(contained: Int, named: Int)
    /// Exactly one candidate, and it cannot be selected. Tapping a disabled row
    /// would satisfy the step and select nothing.
    case notSelectable(label: String)
    /// Exactly one selectable candidate, in `distinct` mode, and it is not the
    /// device this run was told to expect.
    case notTheIntendedPeer(label: String)

    /// **The rule.** `contained` and `named` are the two scopes above, already
    /// snapshotted; `peerName` is the family name the launcher said the OTHER
    /// device announces, and it is consulted only in `distinct` mode.
    static func decide(naming: DevicePairPeerNaming,
                       contained: [DevicePairRosterCandidate],
                       named: [DevicePairRosterCandidate],
                       peerName: String) -> DevicePairRosterChoice {
        let candidates = max(contained.count, named.count)
        if candidates == 0 { return .empty }
        // Before anything is read off the one candidate, and deliberately: a
        // second device in the room is a refusal no property of the first can
        // rescue. This is the third-device rule, and it is a COUNT rather than a
        // name comparison, so three iPads are refused exactly as three
        // differently-named devices are.
        if candidates > 1 {
            return .ambiguous(contained: contained.count, named: named.count)
        }
        // Exactly one, in at least one of the two scopes, taken in order of how
        // much each one is worth. The container is the scope that sees a device
        // whatever it announces; the name is last, because it is the only one
        // that can be right about a stranger.
        let source: DevicePairRosterChoice =
            contained.count == 1 ? .takeContained : .takeNamed
        let chosen = contained.count == 1 ? contained[0] : named[0]
        guard chosen.isEnabled else { return .notSelectable(label: chosen.label) }
        // `shared` stops here, and the omission is the decision rather than an
        // oversight: both devices and any same-family stranger carry the same
        // string, so requiring it would pass for all three.
        if naming == .distinct {
            // An empty expected name can never identify anybody, so it refuses.
            //
            // Stated rather than left to the standard library. With Foundation
            // imported `contains("")` resolves to `range(of:)` and is already
            // false, so this clause changes nothing TODAY — which is exactly why
            // it is written down: the overload that answers an empty needle is
            // not a thing a two-device acceptance should be resting on, and
            // `DevicePairSeamTests` records that the matrix cannot prove this
            // clause rather than pretending it does.
            guard !peerName.isEmpty, chosen.label.contains(peerName) else {
                return .notTheIntendedPeer(label: chosen.label)
            }
        }
        return source
    }
}
