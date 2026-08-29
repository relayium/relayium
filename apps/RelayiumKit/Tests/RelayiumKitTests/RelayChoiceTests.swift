import XCTest
@testable import RelayiumKit

final class RelayChoiceTests: XCTestCase {
    /// tok: max(30,200)=200; la: max(180,40)=180 → la wins on the better
    /// worst-case leg, even though tok is far faster for one side.
    func testMinimisesTheWorseOfTheTwoRTTs() {
        XCTAssertEqual(RelayChoice.pick(mine: ["tok": 30, "la": 180],
                                        theirs: ["tok": 200, "la": 40]), "la")
    }

    func testOnlyConsidersRelaysBothPeersMeasured() {
        // sg is fastest for me but the peer never measured it → ineligible.
        XCTAssertEqual(RelayChoice.pick(mine: ["sg": 10, "tok": 90],
                                        theirs: ["tok": 95]), "tok")
        XCTAssertNil(RelayChoice.pick(mine: ["sg": 10], theirs: ["tok": 95]))
        XCTAssertNil(RelayChoice.pick(mine: [:], theirs: [:]))
    }

    func testBreaksTiesBySumThenById() {
        // Both have max 100; tok sum=150 < la sum=200 → tok.
        XCTAssertEqual(RelayChoice.pick(mine: ["tok": 100, "la": 100],
                                        theirs: ["tok": 50, "la": 100]), "tok")
        // Identical worst-case AND sum → lowest id, the same on both sides.
        XCTAssertEqual(RelayChoice.pick(mine: ["b": 100, "a": 100],
                                        theirs: ["b": 100, "a": 100]), "a")
    }

    /// The property the whole design rests on: both peers feed the same two
    /// maps in opposite order and must reach the same relay, with no round of
    /// negotiation. Swift dictionaries iterate in an unspecified order, so this
    /// also pins that the result does not depend on iteration order.
    ///
    /// Seeded rather than system-random, and over three seeds rather than one
    /// unrepeatable draw: an asymmetry found here means two peers can build on
    /// different relays, so the counterexample has to survive being re-run.
    func testIsSymmetricOverManyInputs() {
        let ids = ["a", "b", "c", "d", "e", "f"]
        for seed in [0x5EED_5100, 0x5EED_5200, 0x5EED_5300] as [UInt64] {
            var rng = SplitMix64(seed: seed)
            for _ in 0..<500 {
                var mine: [String: Int] = [:], theirs: [String: Int] = [:]
                for id in ids {
                    if Bool.random(using: &rng) { mine[id] = Int.random(in: 1...300, using: &rng) }
                    if Bool.random(using: &rng) { theirs[id] = Int.random(in: 1...300, using: &rng) }
                }
                XCTAssertEqual(RelayChoice.pick(mine: mine, theirs: theirs),
                               RelayChoice.pick(mine: theirs, theirs: mine),
                               "asymmetric for seed \(seed) mine=\(mine) theirs=\(theirs)")
            }
        }
    }

    /// **The shared dominance table**, transcribed row for row from
    /// `DOMINANCE_TABLE` in `web/src/lib/ice.test.ts`.
    ///
    /// The Mac and the browser are routinely each other's peer, so a relay one
    /// of them retires early and the other keeps waiting for is the same
    /// divergence `pick` exists to prevent — reached through the gate instead of
    /// through the comparison. A row changed on one side and not the other is
    /// what this is here to fail on.
    ///
    /// `elapsed: nil` is "no sound lower bound available" — the state a room is
    /// in before its measurement reports that every probe has started, and the
    /// state it stays in for a measurement that never reports it at all. See
    /// the `Measure` contract on `RelayNegotiator`.
    ///
    /// One browser row has no counterpart here on purpose: a FRACTIONAL elapsed
    /// that rounds down onto the pick's worse leg. `performance.now()` returns a
    /// double and `measureRelay` rounds its result, so the browser has to make
    /// that comparison in the rounded domain or be out by half a millisecond in
    /// the unsafe direction; elapsed arrives here already integral, so the
    /// question cannot be asked. Every row that CAN be asked on both sides is
    /// below.
    func testMatchesTheBrowsersDominanceTable() {
        let rows: [(name: String, selected: String?, mine: [String: Int], theirs: [String: Int],
                    pool: [String], elapsed: Int?, expected: Bool)] = [
            ("no choice yet dominates nothing",
             nil, [:], [:], ["a", "b"], 10_000, false),
            ("a pick both maps carry, with every probe answered, needs no clock",
             "a", ["a": 20, "b": 90], ["a": 30, "b": 40], ["a", "b"], nil, true),
            ("an unfinished probe with no elapsed bound and no peer leg keeps waiting",
             "a", ["a": 20], ["a": 30], ["a", "b"], nil, false),
            ("a peer leg already worse than the pick's worst retires it with no clock",
             "a", ["a": 20], ["a": 30, "b": 31], ["a", "b"], nil, true),
            ("a peer leg EQUAL to the pick's worst does not: sum and id can still turn it",
             "a", ["a": 20], ["a": 30, "b": 30], ["a", "b"], nil, false),
            ("elapsed strictly past the pick's worst leg retires every unfinished probe",
             "a", ["a": 20], ["a": 30], ["a", "b"], 31, true),
            ("elapsed EQUAL to the pick's worst leg does not",
             "a", ["a": 20], ["a": 30], ["a", "b"], 30, false),
            ("one retired by the clock and one by the peer's leg is still dominance",
             "a", ["a": 20], ["a": 30, "c": 900], ["a", "b", "c"], 31, true),
            ("one relay short of the bound holds the whole room",
             "a", ["a": 20], ["a": 30, "c": 900], ["a", "b", "c"], 30, false),
            ("a pick the peer has not measured is not a pick at all",
             "b", ["a": 20, "b": 5], ["a": 30], ["a", "b"], 10_000, false),
            ("relays outside the pool are not probes and cannot hold the gate",
             "a", ["a": 20], ["a": 30, "z": 1], ["a"], nil, true),
        ]
        for row in rows {
            XCTAssertEqual(RelayChoice.dominates(selectedID: row.selected,
                                                 mine: row.mine,
                                                 theirs: row.theirs,
                                                 poolIDs: row.pool,
                                                 elapsedMs: row.elapsed),
                           row.expected,
                           row.name)
        }
    }

    /// **The property the rule may never violate**, over every state a
    /// three-relay pool can be in: a retired relay is one no round trip the
    /// bound still permits could have handed the room to.
    ///
    /// EXHAUSTIVE rather than sampled, and that is the point. This is the
    /// soundness argument for retiring a probe that has not answered — if it is
    /// wrong, two peers build on different relays — so a counterexample must be
    /// something a re-run reproduces, not something a seed happened to find
    /// once. Every `mine`/`theirs` assignment over `{absent, 10, 20, 30}` and
    /// every elapsed reading around those values is enumerated; the wider,
    /// sparser space is covered by the seeded sweep below.
    ///
    /// The inner loop grows ALL pending relays at once, not one at a time. That
    /// is the real future: several probes are outstanding together and land
    /// together, and a rule that only survives them arriving singly would not be
    /// sound.
    func testNeverRetiresARelayALegalRoundTripCouldWinWith() {
        let ids = ["a", "b", "c"]
        let values: [Int?] = [nil, 10, 20, 30]
        var states = 0, dominant = 0
        for m in assignments(ids, values) {
            for t in assignments(ids, values) {
                for elapsed in [nil, 0, 9, 10, 11, 20, 21, 29, 30, 31] as [Int?] {
                    states += 1
                    let selected = RelayChoice.pick(mine: m, theirs: t)
                    guard RelayChoice.dominates(selectedID: selected, mine: m, theirs: t,
                                                poolIDs: ids, elapsedMs: elapsed) else { continue }
                    dominant += 1
                    XCTAssertNotNil(selected, "dominance without a pick")
                    assertNoLegalGrowthMovesThePick(ids: ids, mine: m, theirs: t,
                                                    elapsed: elapsed, selected: selected)
                }
            }
        }
        // Guards the enumeration itself: a domain that silently stopped
        // producing dominant states would make every assertion above vacuous.
        XCTAssertEqual(states, 40_960)
        XCTAssertGreaterThan(dominant, 5_000, "the exhaustive sweep stopped reaching the rule")
    }

    /// The same property over a wider, sparser value space than exhaustion can
    /// reach — 300 ms legs, four relays, elapsed well past every leg — driven by
    /// a SEEDED generator.
    ///
    /// `SystemRandomNumberGenerator` would make a failure here a one-off: the
    /// counterexample scrolls past in CI output and the next run draws a
    /// different draw. The seed is in the source and in the failure message, so
    /// a red run is re-runnable by construction.
    func testSeededSweepNeverRetiresARelayALegalRoundTripCouldWinWith() {
        let ids = ["a", "b", "c", "d"]
        for seed in [0x5EED_0001, 0x5EED_0002, 0x5EED_0003] as [UInt64] {
            var rng = SplitMix64(seed: seed)
            for iteration in 0..<3_000 {
                var mine: [String: Int] = [:], theirs: [String: Int] = [:]
                for id in ids {
                    if Int.random(in: 0..<5, using: &rng) != 0 {
                        mine[id] = Int.random(in: 1...300, using: &rng)
                    }
                    if Int.random(in: 0..<5, using: &rng) != 0 {
                        theirs[id] = Int.random(in: 1...300, using: &rng)
                    }
                }
                let elapsed: Int? = Bool.random(using: &rng)
                    ? Int.random(in: 0...320, using: &rng) : nil
                let selected = RelayChoice.pick(mine: mine, theirs: theirs)
                guard RelayChoice.dominates(selectedID: selected, mine: mine, theirs: theirs,
                                            poolIDs: ids, elapsedMs: elapsed) else { continue }
                XCTAssertNotNil(selected, "dominance without a pick, seed \(seed) iteration \(iteration)")
                assertNoLegalGrowthMovesThePick(ids: ids, mine: mine, theirs: theirs,
                                                elapsed: elapsed, selected: selected,
                                                context: "seed \(seed) iteration \(iteration)")
            }
        }
    }

    /// Every assignment of `values` to `ids`, with `nil` meaning "not measured".
    private func assignments(_ ids: [String], _ values: [Int?]) -> [[String: Int]] {
        var out: [[String: Int]] = [[:]]
        for id in ids {
            out = out.flatMap { partial -> [[String: Int]] in
                values.map { value in
                    guard let value else { return partial }
                    var next = partial
                    next[id] = value
                    return next
                }
            }
        }
        return out
    }

    /// For a state the rule called dominant: no assignment of still-legal round
    /// trips to the pending relays — grown together, which is what really
    /// happens — may move the pick.
    private func assertNoLegalGrowthMovesThePick(ids: [String],
                                                 mine: [String: Int],
                                                 theirs: [String: Int],
                                                 elapsed: Int?,
                                                 selected: String?,
                                                 context: String = "",
                                                 file: StaticString = #filePath,
                                                 line: UInt = #line) {
        let pending = ids.filter { mine[$0] == nil }
        guard !pending.isEmpty else { return }
        // What the bound still permits. An unfinished probe has been running for
        // at least `elapsed`, and truncation is monotone, so it can report
        // `elapsed` but never less. With no bound, anything at all.
        let legal = elapsed.map { [$0, $0 + 1, $0 + 7, 9_000] } ?? [0, 1, 5, 60, 300, 5_000]
        for combination in assignments(pending, legal.map { Optional($0) }) where combination.count == pending.count {
            var grown = mine
            for (id, rtt) in combination { grown[id] = rtt }
            XCTAssertEqual(RelayChoice.pick(mine: grown, theirs: theirs), selected,
                           """
                           retired \(combination) \(context)
                           mine=\(mine) theirs=\(theirs) elapsed=\(String(describing: elapsed))
                           """,
                           file: file, line: line)
        }
    }

    /// Mirrors `relayDominanceElapsedMs`: the first elapsed reading at which the
    /// strict rule is certain to hold, and not one millisecond earlier.
    func testDominanceElapsedMsIsTheFirstInstantTheStrictRuleHolds() {
        for worst in [0, 1, 30, 199, 4_321] {
            let at = RelayChoice.dominanceElapsedMs(worstLegMs: worst)
            XCTAssertTrue(RelayChoice.dominates(selectedID: "a", mine: ["a": worst], theirs: ["a": worst],
                                                poolIDs: ["a", "b"], elapsedMs: at))
            XCTAssertFalse(RelayChoice.dominates(selectedID: "a", mine: ["a": worst], theirs: ["a": worst],
                                                 poolIDs: ["a", "b"], elapsedMs: at - 1))
        }
    }
}

/// A seeded, reproducible generator for the property tests above.
///
/// SplitMix64: four lines, no state to get wrong, and the whole sequence is a
/// function of the seed. What it buys is that a property failure is a bug
/// report rather than an anecdote — the seed is in the source and in the
/// message, so the exact counterexample comes back on the next run and on
/// anyone else's machine.
struct SplitMix64: RandomNumberGenerator {
    private var state: UInt64

    init(seed: UInt64) { state = seed }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
