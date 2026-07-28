# Native relay pool — nearest-relay selection on macOS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the macOS client measure the six-relay pool `/api/ice` already
advertises and converge with its peer on the nearest common relay, instead of
always using the single legacy TURN in Frankfurt.

**Architecture:** Four units split on one line — whether they can be tested
without WebRTC. `RelayChoice` (pure selection), `RelayRttMessage` (wire
encoding) and `RelayNegotiator` (state + signalling) hold every decision and are
fully unit-tested; `RelayProbe` is left holding a stopwatch and no branches, and
is the only piece that needs a live allocation.

**Tech Stack:** Swift 5.9 / SwiftPM, XCTest, WebRTC (`RTCPeerConnection`,
`RTCIceTransportPolicy`).

**Spec:** `docs/superpowers/specs/2026-07-28-native-relay-pool-design.md`

## Global Constraints

- **The algorithm is copied, not invented.** `RelayChoice.pick` must match
  `web/src/lib/ice.ts`'s `pickRelay` decision for decision, and
  `RelayRttMessage` must produce exactly `{"relayRtt": {"<id>": <ms>}}` — the
  web and the Mac are each other's peers, and a difference here means they
  choose different relays and the connection fails looking like a network fault.
- **Symmetry is the load-bearing property.** `pick(a, b) == pick(b, a)` for all
  inputs. It is what removes the negotiation round; if it breaks, nothing else
  in this design works.
- **The pool is an optimisation, never a requirement.** Every failure path —
  empty pool, unanswered relay, no common relay, deadline elapsed, peer on an
  older build — falls back to today's `iceServers`. A transfer must never fail
  *because* of this feature.
- `relayChoiceDeadline = 800ms`, `relayProbeTimeout = 4s`. **The 800 ms has no
  measurement behind it** — keep it a named constant and leave the comment
  saying so.
- **Callback ownership hazard:** `RealtimeConnection.init`
  (`Realtime/RealtimeConnection.swift:145`) assigns `signaling.onSignal`,
  clobbering any earlier handler. `RelayNegotiator` therefore owns `onSignal`
  only *before* the connection is constructed, and must not expect it
  afterwards. Task 7 must keep that order.

## File structure

| File | Responsibility |
|---|---|
| `Sources/RelayiumKit/Realtime/RelayChoice.swift` | **new** — pure symmetric selection |
| `Sources/RelayiumKit/Realtime/RelayRttMessage.swift` | **new** — `{relayRtt:…}` ↔ `JSONValue` |
| `Sources/RelayiumKit/Account/ICEClient.swift` | modify — decode `relays`, return `ICEConfig` |
| `Sources/RelayiumKit/Realtime/RealtimeConnection.swift` | modify — `iceTransportPolicy` parameter |
| `Sources/RelayiumAppKit/RelayProbe.swift` | **new** — one relay's Allocate round trip (WebRTC) |
| `Sources/RelayiumAppKit/RelayNegotiator.swift` | **new** — both maps, exchange, bounded wait |
| `Sources/RelayiumAppKit/RealtimeConnectionFactory.swift` | modify — orchestration |
| `Sources/RelayiumAppKit/RealtimeSessionModel.swift` | modify — `makeConnection` closure widens |

Tasks 1–4 are pure Kit and fully testable. Tasks 5–7 touch WebRTC. Task 8 is
acceptance.

---

### Task 1: `RelayChoice` — the symmetric selection

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Realtime/RelayChoice.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/RelayChoiceTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces: `RelayChoice.pick(mine: [String: Int], theirs: [String: Int]) -> String?`

- [ ] **Step 1: Write the failing tests**

These are `web/src/lib/ice.test.ts`'s cases, plus the symmetry property the web
only spot-checks. Create `RelayChoiceTests.swift`:

```swift
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
    func testIsSymmetricOverManyInputs() {
        var rng = SystemRandomNumberGenerator()
        let ids = ["a", "b", "c", "d", "e", "f"]
        for _ in 0..<500 {
            var mine: [String: Int] = [:], theirs: [String: Int] = [:]
            for id in ids {
                if Bool.random(using: &rng) { mine[id] = Int.random(in: 1...300, using: &rng) }
                if Bool.random(using: &rng) { theirs[id] = Int.random(in: 1...300, using: &rng) }
            }
            XCTAssertEqual(RelayChoice.pick(mine: mine, theirs: theirs),
                           RelayChoice.pick(mine: theirs, theirs: mine),
                           "asymmetric for mine=\(mine) theirs=\(theirs)")
        }
    }
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/RelayiumKit && swift test --filter RelayChoiceTests
```
Expected: FAIL — `cannot find 'RelayChoice' in scope`.

- [ ] **Step 3: Write the implementation**

Create `Sources/RelayiumKit/Realtime/RelayChoice.swift`:

```swift
import Foundation

/// Picks the relay two peers should meet on, from the round-trip times each of
/// them measured.
///
/// Mirrors `pickRelay` in `web/src/lib/ice.ts` decision for decision. The Mac
/// and the browser are routinely each other's peer, and a disagreement here
/// does not degrade gracefully: each side allocates on a different relay and
/// the connection fails looking like a network problem.
public enum RelayChoice {
    /// The id minimising the *worse* of the two peers' RTTs, then their sum,
    /// then the id itself.
    ///
    /// Only relays BOTH peers measured are eligible: a relay one side could not
    /// reach is not a candidate however fast it is for the other.
    ///
    /// Pure and symmetric — `pick(a, b) == pick(b, a)`. That is what lets both
    /// peers arrive at the same answer by exchanging data rather than
    /// proposals. The final id comparison is not a cosmetic tie-break: without
    /// it, two peers whose maps tie could return different ids depending on
    /// dictionary iteration order, which is unspecified in Swift.
    public static func pick(mine: [String: Int], theirs: [String: Int]) -> String? {
        var best: String?
        var bestMax = Int.max
        var bestSum = Int.max
        for (id, m) in mine {
            guard let t = theirs[id] else { continue }
            let mx = max(m, t)
            let sum = m + t
            let better = mx < bestMax
                || (mx == bestMax && sum < bestSum)
                || (mx == bestMax && sum == bestSum && (best == nil || id < best!))
            if better {
                best = id
                bestMax = mx
                bestSum = sum
            }
        }
        return best
    }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd apps/RelayiumKit && swift test --filter RelayChoiceTests
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Realtime/RelayChoice.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/RelayChoiceTests.swift
git commit -s -m "feat(kit): the symmetric relay choice

Copied decision for decision from web/src/lib/ice.ts's pickRelay, because the
Mac and the browser are routinely each other's peer and a disagreement does not
degrade gracefully — each side allocates on a different relay and the failure
looks like a network fault.

The property test is the point. Symmetry is what removes the negotiation round:
both peers feed the same two maps in opposite order and must reach the same
relay. It also pins the id tie-break, without which a tie could resolve
differently on the two sides depending on dictionary iteration order."
```

---

### Task 2: `ICEConfig` — stop discarding the pool

**Files:**
- Modify: `apps/RelayiumKit/Sources/RelayiumKit/Account/ICEClient.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/ICEClientTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces: `RelayEntry { id: String, region: String?, iceServers: [ICEServerConfig] }`;
  `ICEConfig { iceServers: [ICEServerConfig], relays: [RelayEntry] }`;
  `ICEConfigClient.fetch(code:) async throws -> ICEConfig`.

- [ ] **Step 1: Read the file first**

`Sources/RelayiumKit/Account/ICEClient.swift` ends with a comment explaining
that `relays` is decoded away on purpose. That comment is what this task
deletes — read it before replacing it, so the reasons it gives are answered
rather than lost.

- [ ] **Step 2: Write the failing test**

Append to `Tests/RelayiumKitTests/ICEClientTests.swift`:

```swift
extension ICEClientTests {
    func testDecodesTheRelayPool() throws {
        let json = """
        {"iceServers":[{"urls":["stun:relayium.com:3478"]}],
         "relays":[
           {"id":"n1","iceServers":[{"urls":["turn:1.1.1.1:3478"],"username":"u","credential":"c"}]},
           {"id":"n3","region":"cn","iceServers":[{"urls":["turn:2.2.2.2:3478"],"username":"u","credential":"c"}]}
         ]}
        """.data(using: .utf8)!
        let cfg = try parseICEConfig(json)
        XCTAssertEqual(cfg.iceServers.count, 1)
        XCTAssertEqual(cfg.relays.map(\.id), ["n1", "n3"])
        XCTAssertEqual(cfg.relays[1].region, "cn")
        XCTAssertEqual(cfg.relays[0].iceServers[0].urls, ["turn:1.1.1.1:3478"])
    }

    /// A response with no pool is the LAN case and is completely normal.
    func testAbsentPoolIsAnEmptyPoolNotAFailure() throws {
        let json = #"{"iceServers":[{"urls":["stun:relayium.com:3478"]}]}"#.data(using: .utf8)!
        let cfg = try parseICEConfig(json)
        XCTAssertTrue(cfg.relays.isEmpty)
        XCTAssertEqual(cfg.iceServers.count, 1)
    }

    /// Unchanged from before: no iceServers at all is a configuration failure,
    /// because a peer connection with none fails later and far more obscurely.
    func testEmptyIceServersStillThrows() {
        XCTAssertThrowsError(try parseICEConfig(#"{"iceServers":[]}"#.data(using: .utf8)!))
    }
}
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd apps/RelayiumKit && swift test --filter ICEClientTests
```
Expected: FAIL — `cannot find 'parseICEConfig' in scope`.

- [ ] **Step 4: Write the implementation**

In `ICEClient.swift`, add the two types and the parser, change the protocol and
the HTTP client, and delete the trailing comment:

```swift
/// One relay in the pool `/api/ice` advertises alongside the legacy single
/// TURN. `id` is what the two peers exchange to agree on a relay.
public struct RelayEntry: Codable, Equatable {
    public let id: String
    public let region: String?
    public let iceServers: [ICEServerConfig]

    public init(id: String, region: String? = nil, iceServers: [ICEServerConfig]) {
        self.id = id
        self.region = region
        self.iceServers = iceServers
    }
}

/// Everything `/api/ice` returns: the servers to use when there is no better
/// choice, and the pool to choose from when there is.
public struct ICEConfig: Equatable {
    public let iceServers: [ICEServerConfig]
    public let relays: [RelayEntry]

    public init(iceServers: [ICEServerConfig], relays: [RelayEntry] = []) {
        self.iceServers = iceServers
        self.relays = relays
    }
}

/// An empty `iceServers` is a configuration failure, not an empty success: a
/// peer connection with no ICE servers fails later, and much more obscurely.
///
/// An empty `relays` is neither — it is the LAN case, and every caller treats
/// the pool as optional.
func parseICEConfig(_ data: Data) throws -> ICEConfig {
    struct Body: Decodable {
        let iceServers: [ICEServerConfig]?
        let relays: [RelayEntry]?
    }
    guard let b = try? JSONDecoder().decode(Body.self, from: data),
          let servers = b.iceServers, !servers.isEmpty else {
        throw AccountError.decoding
    }
    return ICEConfig(iceServers: servers, relays: b.relays ?? [])
}
```

Change the protocol and implementation:

```swift
public protocol ICEConfigClient {
    /// `code` is the live pairing code. TURN credentials and the relay pool
    /// come back only for a valid one, because relayed bytes bill to that
    /// code's owner; without it the response is STUN-only.
    func fetch(code: String) async throws -> ICEConfig
}
```

and in `HTTPICEClient.fetch`, replace `return try parseICEServers(data)` with
`return try parseICEConfig(data)`.

Delete `parseICEServers` and the explanatory comment at the foot of the file.

- [ ] **Step 5: Fix the call sites the compiler now rejects**

`RealtimeSessionModel.join` and its `makeConnection` closure type. In
`Sources/RelayiumAppKit/RealtimeSessionModel.swift`, change both occurrences of
`[ICEServerConfig]` in the `makeConnection` signature (the stored property at
line 58 and the `init` parameter at line 70) to `ICEConfig`. The body of `join`
needs no change — `servers` is simply a richer value now.

Update the stub factories in
`Tests/RelayiumKitTests/RealtimeSessionModelTests.swift` (`makeModel` and the
two gate-based models) and `StubICE.result` to
`ICEConfig(iceServers: [ICEServerConfig(urls: ["stun:s:3478"])])`.

- [ ] **Step 6: Run the whole suite**

```bash
cd apps/RelayiumKit && swift test
```
Expected: PASS, no failures.

- [ ] **Step 7: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Account/ICEClient.swift \
        apps/RelayiumKit/Sources/RelayiumAppKit/RealtimeSessionModel.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/ICEClientTests.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/RealtimeSessionModelTests.swift
git commit -s -m "feat(kit): decode the relay pool instead of discarding it

/api/ice has advertised six relays across four countries all along; the Kit
parsed them and threw them away, with a comment at the foot of the file
explaining that choosing between them was its own round. This is that round, so
the comment is replaced by the thing it was deferring.

An absent pool stays an empty pool rather than an error: that is the LAN case,
and every caller treats the pool as optional. An empty iceServers is still a
failure, for the reason it always was — a peer connection with none of them
fails later and far more obscurely."
```

---

### Task 3: `RelayRttMessage` — the wire shape

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Realtime/RelayRttMessage.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/RelayRttMessageTests.swift`

**Interfaces:**
- Consumes: `JSONValue` (`Signaling/SignalEnvelope.swift`).
- Produces: `RelayRttMessage.encode(_ rtt: [String: Int]) -> JSONValue`,
  `RelayRttMessage.decode(_ data: JSONValue) -> [String: Int]?`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import RelayiumKit

final class RelayRttMessageTests: XCTestCase {
    /// The exact shape App.svelte sends: {"relayRtt": {"<id>": <ms>}}.
    func testEncodesTheShapeTheWebSends() {
        let v = RelayRttMessage.encode(["n1": 42, "n3": 190])
        guard case let .object(root) = v, case let .object(map)? = root["relayRtt"] else {
            return XCTFail("got \(v)")
        }
        XCTAssertEqual(map.count, 2)
        XCTAssertEqual(map["n1"], .number(42))
        XCTAssertEqual(map["n3"], .number(190))
    }

    func testRoundTrips() {
        let original = ["n1": 42, "n3": 190]
        XCTAssertEqual(RelayRttMessage.decode(RelayRttMessage.encode(original)), original)
    }

    /// The signal channel carries other traffic — SDP, ICE candidates, renames.
    /// Anything that is not a relayRtt map must decode to nil rather than an
    /// empty map, or an unrelated message would look like "the peer measured
    /// nothing" and wipe a good map.
    func testUnrelatedSignalsDecodeToNil() {
        XCTAssertNil(RelayRttMessage.decode(.object(["rename": .string("Mac")])))
        XCTAssertNil(RelayRttMessage.decode(.string("hello")))
        XCTAssertNil(RelayRttMessage.decode(.null))
    }

    /// A peer on a future build may send ids we cannot interpret; take the
    /// numbers and ignore the rest rather than rejecting the whole map.
    func testSkipsNonNumericEntries() {
        let v = JSONValue.object(["relayRtt": .object(["n1": .number(10), "bad": .string("x")])])
        XCTAssertEqual(RelayRttMessage.decode(v), ["n1": 10])
    }
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/RelayiumKit && swift test --filter RelayRttMessageTests
```
Expected: FAIL — `cannot find 'RelayRttMessage' in scope`.

- [ ] **Step 3: Write the implementation**

```swift
import Foundation

/// The relay-RTT map as it travels on the signalling `signal` envelope.
///
/// The shape is fixed by `web/src/App.svelte`'s `broadcastRelayRtt`:
/// `{"relayRtt": {"<relay id>": <milliseconds>}}`. The Mac and the browser are
/// routinely each other's peer, so this is a wire format, not an internal
/// detail.
public enum RelayRttMessage {
    public static func encode(_ rtt: [String: Int]) -> JSONValue {
        .object(["relayRtt": .object(rtt.mapValues { .number(Double($0)) })])
    }

    /// Nil for anything that is not a relay-RTT map.
    ///
    /// Nil rather than an empty map on purpose: the signal channel also carries
    /// SDP, ICE candidates and renames, and an empty map would read as "the
    /// peer measured nothing" and overwrite a good one.
    public static func decode(_ data: JSONValue) -> [String: Int]? {
        guard case let .object(root) = data,
              case let .object(map)? = root["relayRtt"] else { return nil }
        var out: [String: Int] = [:]
        for (id, v) in map {
            // A peer on a newer build may add entries we do not understand.
            // Take the numbers and ignore the rest rather than discarding a map
            // that is mostly usable.
            if case let .number(ms) = v { out[id] = Int(ms) }
        }
        return out
    }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd apps/RelayiumKit && swift test --filter RelayRttMessageTests
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Realtime/RelayRttMessage.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/RelayRttMessageTests.swift
git commit -s -m "feat(kit): the relay-RTT signal message

The shape is fixed by web/src/App.svelte's broadcastRelayRtt, so this is a wire
format rather than an internal detail.

Decoding an unrelated signal returns nil, not an empty map. The channel also
carries SDP, candidates and renames, and an empty map would read as 'the peer
measured nothing' — overwriting a good map with the news that a rename
happened."
```

---

### Task 4: `RelayNegotiator` — hold both maps, converge, and give up on time

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/RelayNegotiator.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/RelayNegotiatorTests.swift`

**Interfaces:**
- Consumes: `RelayChoice.pick`, `RelayRttMessage`, `RelayEntry`, `SignalingClient`.
- Produces:
  - `RelayNegotiator(signaling: SignalingClient, pool: [RelayEntry], measure: @escaping ([RelayEntry]) async -> [String: Int])`
  - `func start()` — begins measurement in the background
  - `func handleSignal(from: String, data: JSONValue)`
  - `func peerJoined(_ peerId: String)`
  - `func waitForChoice(deadline: TimeInterval) async -> RelayEntry?`

The `measure` closure is injected so tests drive it without WebRTC; Task 6
supplies the real one.

- [ ] **Step 1: Write the failing tests**

```swift
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

private func pool(_ ids: [String]) -> [RelayEntry] {
    ids.map { RelayEntry(id: $0, iceServers: [ICEServerConfig(urls: ["turn:\($0):3478"])]) }
}

final class RelayNegotiatorTests: XCTestCase {
    private func negotiator(_ ids: [String],
                            mine: [String: Int]) -> (RelayNegotiator, FakeWebSocketChannel) {
        let ch = FakeWebSocketChannel()
        let sig = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        let n = RelayNegotiator(signaling: sig, pool: pool(ids), measure: { _ in mine })
        return (n, ch)
    }

    func testConvergesOnTheRelayBothPeersLike() async {
        let (n, _) = negotiator(["n1", "n3"], mine: ["n1": 200, "n3": 40])
        n.start()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["n1": 30, "n3": 50]))
        let chosen = await n.waitForChoice(deadline: 1.0)
        // n1: max(200,30)=200; n3: max(40,50)=50 → n3.
        XCTAssertEqual(chosen?.id, "n3")
    }

    /// The fallback that keeps this feature from ever being the reason a
    /// transfer fails: a peer on an older build never sends a map.
    func testAPeerThatNeverAnswersLeavesNoChoice() async {
        let (n, _) = negotiator(["n1"], mine: ["n1": 10])
        n.start()
        let chosen = await n.waitForChoice(deadline: 0.2)
        XCTAssertNil(chosen)
    }

    func testAnEmptyPoolIsSkippedEntirely() async {
        let (n, ch) = negotiator([], mine: [:])
        n.start()
        let chosen = await n.waitForChoice(deadline: 0.2)
        XCTAssertNil(chosen)
        XCTAssertTrue(ch.sent.filter { $0.contains("relayRtt") }.isEmpty,
                      "nothing to advertise, so nothing should be sent")
    }

    /// Broadcast on measure-done and on peer-join, never in reply — that is
    /// what stops two peers echoing maps at each other forever.
    func testNeverRepliesToAReceivedMap() async {
        let (n, ch) = negotiator(["n1"], mine: ["n1": 10])
        n.start()
        _ = await n.waitForChoice(deadline: 0.3)   // let the measurement land
        let afterMeasure = ch.sent.filter { $0.contains("relayRtt") }.count
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["n1": 20]))
        XCTAssertEqual(ch.sent.filter { $0.contains("relayRtt") }.count, afterMeasure,
                       "receiving a map must not send one back")
    }

    /// An unrelated signal must not be mistaken for an empty measurement.
    func testAnUnrelatedSignalDoesNotClobberTheMap() async {
        let (n, _) = negotiator(["n1"], mine: ["n1": 10])
        n.start()
        n.handleSignal(from: "peer", data: RelayRttMessage.encode(["n1": 20]))
        n.handleSignal(from: "peer", data: .object(["rename": .string("Phone")]))
        let chosen = await n.waitForChoice(deadline: 0.5)
        XCTAssertEqual(chosen?.id, "n1")
    }
}
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/RelayiumKit && swift test --filter RelayNegotiatorTests
```
Expected: FAIL — `cannot find 'RelayNegotiator' in scope`.

- [ ] **Step 3: Write the implementation**

```swift
import Foundation
import RelayiumKit

/// Owns the two relay-RTT maps for one session and turns them into a choice.
///
/// Both peers measure the pool, swap maps over signalling, and run the same
/// symmetric `RelayChoice.pick` — so there is no negotiation round here, only
/// an exchange. `waitForChoice` exists because the maps may not have met yet
/// when the connection needs building.
///
/// Measurement is injected rather than owned: everything in this type is a
/// decision, and decisions are worth testing without a live TURN allocation.
public final class RelayNegotiator: @unchecked Sendable {
    private let signaling: SignalingClient
    private let pool: [RelayEntry]
    private let measure: ([RelayEntry]) async -> [String: Int]

    private let lock = NSLock()
    private var mine: [String: Int] = [:]
    private var theirs: [String: Int] = [:]
    private var peers: Set<String> = []
    private var waiters: [CheckedContinuation<Void, Never>] = []

    public init(signaling: SignalingClient,
                pool: [RelayEntry],
                measure: @escaping ([RelayEntry]) async -> [String: Int]) {
        self.signaling = signaling
        self.pool = pool
        self.measure = measure
    }

    /// Begin measuring. Returns immediately; the work runs detached so the
    /// caller can go on waiting for a peer, which is the window this uses.
    public func start() {
        guard !pool.isEmpty else { return }
        Task { [self] in
            let rtt = await measure(pool)
            lock.lock()
            mine = rtt
            let targets = peers
            lock.unlock()
            for p in targets { send(to: p) }
            wake()
        }
    }

    public func peerJoined(_ peerId: String) {
        lock.lock()
        peers.insert(peerId)
        let haveMine = !mine.isEmpty
        lock.unlock()
        // Only worth sending once there is something to say; `start`'s
        // completion covers the other ordering.
        if haveMine { send(to: peerId) }
    }

    public func handleSignal(from: String, data: JSONValue) {
        guard let map = RelayRttMessage.decode(data) else { return }
        lock.lock()
        theirs = map
        lock.unlock()
        // Deliberately no reply. Broadcasts happen on measure-done and on
        // peer-join; answering here would have two peers echoing maps forever.
        wake()
    }

    /// The chosen relay, waiting up to `deadline` for both maps to arrive.
    /// Nil means "use whatever the caller already had" — an empty pool, a peer
    /// that never answered, no relay in common, or simply not in time.
    public func waitForChoice(deadline: TimeInterval) async -> RelayEntry? {
        if let e = current() { return e }
        guard !pool.isEmpty else { return nil }
        await withTaskGroup(of: Void.self) { group in
            group.addTask { [self] in
                await withCheckedContinuation { c in
                    lock.lock()
                    // Re-check inside the lock: the answer may have arrived
                    // between current() above and here.
                    if chosenIDLocked() != nil { lock.unlock(); c.resume(); return }
                    waiters.append(c)
                    lock.unlock()
                }
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(deadline * 1_000_000_000))
            }
            await group.next()
            group.cancelAll()
        }
        return current()
    }

    private func current() -> RelayEntry? {
        lock.lock(); defer { lock.unlock() }
        guard let id = chosenIDLocked() else { return nil }
        return pool.first { $0.id == id }
    }

    private func chosenIDLocked() -> String? {
        RelayChoice.pick(mine: mine, theirs: theirs)
    }

    private func send(to peerId: String) {
        lock.lock(); let m = mine; lock.unlock()
        guard !m.isEmpty else { return }
        signaling.sendSignal(to: peerId, data: RelayRttMessage.encode(m))
    }

    private func wake() {
        lock.lock()
        guard chosenIDLocked() != nil else { lock.unlock(); return }
        let pending = waiters
        waiters = []
        lock.unlock()
        for c in pending { c.resume() }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd apps/RelayiumKit && swift test --filter RelayNegotiatorTests
```
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumAppKit/RelayNegotiator.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/RelayNegotiatorTests.swift
git commit -s -m "feat(native): hold both relay maps and converge on time

Both peers measure, swap maps, and run the same symmetric pick — so this is an
exchange, not a negotiation. waitForChoice exists because the maps may not have
met by the time the connection has to be built, and a bounded wait is better
than either hanging or guessing.

Measurement is injected rather than owned. Everything in this type is a
decision, and decisions are worth testing without a live TURN allocation; the
part that cannot be tested that way is left holding a stopwatch in its own file.

Receiving a map never sends one back. Broadcasts fire on measure-done and on
peer-join, which covers both orderings without two peers echoing at each other
until the deadline."
```

---

### Task 5: `iceTransportPolicy` on the connection

**Files:**
- Modify: `apps/RelayiumKit/Sources/RelayiumKit/Realtime/RealtimeConnection.swift:130-149`

**Interfaces:**
- Produces: `RealtimeConnection.init(signaling:peerId:role:iceServers:iceTransportPolicy:)`
  with `iceTransportPolicy: RTCIceTransportPolicy = .all`.

- [ ] **Step 1: Add the parameter**

In the initializer, add a defaulted parameter and apply it:

```swift
    public init(signaling: SignalingClient, peerId: String, role: Role,
                iceServers: [RTCIceServer],
                iceTransportPolicy: RTCIceTransportPolicy = .all) {
```

and in the body, after `config.sdpSemantics = .unifiedPlan`:

```swift
        // Relay-only on the cross-network path. ICE otherwise spends ~20s
        // failing direct candidate checks before falling back to the relay it
        // was always going to use; the caller decides, because a LAN room has
        // no relay to fall back to and must keep host candidates.
        config.iceTransportPolicy = iceTransportPolicy
```

The default is `.all` so every existing caller — and the E2E driver — keeps its
current behaviour.

- [ ] **Step 2: Verify the package still builds and the suite is unchanged**

```bash
cd apps/RelayiumKit && swift build && swift test
```
Expected: build succeeds; the same test count as before this task, 0 failures.

- [ ] **Step 3: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Realtime/RealtimeConnection.swift
git commit -s -m "feat(kit): let the caller choose the ICE transport policy

Defaulted to .all, so nothing changes for existing callers. The cross-network
path wants relay-only — ICE otherwise spends about twenty seconds failing
direct candidate checks before falling back to the relay it was always going to
use — but a LAN room has no relay to fall back to and must keep its host
candidates, so this is the caller's decision rather than a constant."
```

---

### Task 6: `RelayProbe` — the one part that needs WebRTC

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/RelayProbe.swift`

**Interfaces:**
- Consumes: `RelayEntry`, WebRTC.
- Produces: `RelayProbe.measureAll(_ pool: [RelayEntry], timeout: TimeInterval) async -> [String: Int]`,
  suitable as `RelayNegotiator`'s `measure` closure.

- [ ] **Step 1: Write the implementation**

There is no test step here, and the file says why. Its whole behaviour is
"start a stopwatch, stop it when a relay candidate arrives" — there is no
branch to assert, and nothing short of a live allocation exercises it.

```swift
import Foundation
import WebRTC
import RelayiumKit

/// Times the TURN Allocate round trip to each relay in the pool.
///
/// ⚠️ NOT UNIT-TESTED, deliberately. Every decision this feature makes lives in
/// `RelayChoice` and `RelayNegotiator`, which are pure and covered; what is
/// left here is a stopwatch and no branches, and nothing short of a live
/// allocation would exercise it. Keep it that way — logic that arrives in this
/// file becomes logic nothing can test.
///
/// Mirrors `measureRelay` in `web/src/lib/ice.ts`: a relay-only peer connection
/// with just this relay's servers, timed from `setLocalDescription` to the
/// first `typ relay` candidate. The absolute number carries fixed overhead, but
/// it is the same overhead for every relay, so comparison is valid.
public enum RelayProbe {
    /// Measures the whole pool concurrently, so the wall clock is the slowest
    /// single relay rather than their sum. Relays that do not answer within
    /// `timeout` are absent from the result, which makes them ineligible.
    public static func measureAll(_ pool: [RelayEntry],
                                  timeout: TimeInterval = 4) async -> [String: Int] {
        await withTaskGroup(of: (String, Int?).self) { group in
            for entry in pool {
                group.addTask { (entry.id, await measure(entry, timeout: timeout)) }
            }
            var out: [String: Int] = [:]
            for await (id, ms) in group where ms != nil { out[id] = ms }
            return out
        }
    }

    private static func measure(_ entry: RelayEntry, timeout: TimeInterval) async -> Int? {
        let factory = RTCPeerConnectionFactory()
        let config = RTCConfiguration()
        config.iceServers = entry.iceServers.map { c in
            if let u = c.username, let p = c.credential {
                return RTCIceServer(urlStrings: c.urls, username: u, credential: p)
            }
            return RTCIceServer(urlStrings: c.urls)
        }
        config.sdpSemantics = .unifiedPlan
        // Relay-only so nothing but the TURN path is being timed.
        config.iceTransportPolicy = .relay

        let delegate = FirstRelayCandidate()
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = factory.peerConnection(with: config, constraints: constraints,
                                              delegate: delegate) else { return nil }
        defer { pc.close() }

        // A data channel gives the offer an m-line, without which ICE gathers
        // nothing at all and every relay would look unreachable.
        _ = pc.dataChannel(forLabel: "probe", configuration: RTCDataChannelConfiguration())

        let start = Date()
        guard let offer = try? await pc.offer(for: constraints) else { return nil }
        try? await pc.setLocalDescription(offer)
        guard await delegate.wait(timeout: timeout) else { return nil }
        return Int(Date().timeIntervalSince(start) * 1000)
    }
}

/// Resumes once, on the first `typ relay` candidate.
private final class FirstRelayCandidate: NSObject, RTCPeerConnectionDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var cont: CheckedContinuation<Bool, Never>?
    private var fired = false

    func wait(timeout: TimeInterval) async -> Bool {
        await withTaskGroup(of: Bool.self) { group in
            group.addTask { [self] in
                await withCheckedContinuation { c in
                    lock.lock()
                    if fired { lock.unlock(); c.resume(returning: true); return }
                    cont = c
                    lock.unlock()
                }
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                return false
            }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
    }

    func peerConnection(_ pc: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        guard candidate.sdp.contains(" typ relay") else { return }
        lock.lock()
        let c = cont
        cont = nil
        fired = true
        lock.unlock()
        c?.resume(returning: true)
    }

    // Unused delegate requirements.
    func peerConnection(_ pc: RTCPeerConnection, didChange s: RTCSignalingState) {}
    func peerConnection(_ pc: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ pc: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ pc: RTCPeerConnection) {}
    func peerConnection(_ pc: RTCPeerConnection, didChange s: RTCIceConnectionState) {}
    func peerConnection(_ pc: RTCPeerConnection, didChange s: RTCIceGatheringState) {}
    func peerConnection(_ pc: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ pc: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
```

- [ ] **Step 2: Verify it builds**

```bash
cd apps/RelayiumKit && swift build && swift test
```
Expected: build succeeds; test count unchanged, 0 failures.

- [ ] **Step 3: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumAppKit/RelayProbe.swift
git commit -s -m "feat(native): time the Allocate round trip to each relay

Mirrors measureRelay in web/src/lib/ice.ts — a relay-only peer connection with
one relay's servers, timed to its first typ relay candidate. The whole pool is
measured concurrently, so the cost is the slowest relay rather than their sum,
and a relay that does not answer is simply absent and therefore ineligible.

No unit test, and the file says so at the top. Every decision this feature makes
lives in RelayChoice and RelayNegotiator, which are pure and covered; what is
left here is a stopwatch with no branches. The note asks the next person to keep
it that way, because logic that lands in this file is logic nothing can test."
```

---

### Task 7: Wire it into the factory

**Files:**
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/RealtimeConnectionFactory.swift`

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: `RealtimeConnectionFactory.make(code:role:config:baseURL:deviceName:peerTimeout:)`
  taking `config: ICEConfig` where it previously took `iceServers: [ICEServerConfig]`.

- [ ] **Step 1: Read the ordering hazard first**

`RealtimeConnection.init` assigns `signaling.onSignal`, replacing whatever was
there. `RelayNegotiator` needs `onSignal` to receive the peer's map. The order
below is therefore not stylistic: negotiate first, construct second. Wiring the
negotiator after the connection would silently disable it — no error, just a
relay choice that never converges and a fallback every time.

- [ ] **Step 2: Rewrite `make`**

```swift
    /// How long a connection waits for the two peers' relay measurements to
    /// meet before giving up and using the advertised servers.
    ///
    /// 800 ms is a guess. Nobody has measured this fleet's round trips from a
    /// real client, and this constant is the first thing to revisit once
    /// someone has — see the design doc's note.
    public static let relayChoiceDeadline: TimeInterval = 0.8

    public static func make(code: String,
                            role: Role,
                            config: ICEConfig,
                            baseURL: URL,
                            deviceName: String,
                            peerTimeout: TimeInterval = 120) async throws -> RealtimePeerConnection {
        let signaling = SignalingClient.connect(wsBase: signalingBase(baseURL),
                                                code: code, name: deviceName)
        // Start measuring immediately: the sender is about to spend real time
        // waiting for a peer, and that window is free.
        let negotiator = RelayNegotiator(signaling: signaling, pool: config.relays,
                                         measure: { await RelayProbe.measureAll($0) })
        signaling.onSignal = { from, data in negotiator.handleSignal(from: from, data: data) }
        negotiator.start()

        let peerId = try await firstPeer(on: signaling, timeout: peerTimeout)
        negotiator.peerJoined(peerId)

        let chosen = await negotiator.waitForChoice(deadline: relayChoiceDeadline)
        let servers = (chosen?.iceServers ?? config.iceServers).map(rtcServer)
        // Relay-only only when a relay was actually chosen. Falling back to the
        // advertised set means possibly no relay at all (a LAN room), and
        // forcing .relay there would leave ICE with nothing to gather.
        let policy: RTCIceTransportPolicy = chosen != nil ? .relay : .all
        // Constructed last on purpose: this call takes over signaling.onSignal,
        // which the negotiator needed until now.
        return RealtimeConnection(signaling: signaling, peerId: peerId, role: role,
                                  iceServers: servers, iceTransportPolicy: policy)
    }
```

- [ ] **Step 3: Fix the app's call site**

In `Sources/RelayiumAppKit/AppEnvironment.swift`, the `makeConnection` closure
passed to `RealtimeSessionModel` now receives an `ICEConfig`; forward it as
`config:` instead of `iceServers:`. The parameter name changes; nothing else
does.

- [ ] **Step 4: Verify**

```bash
cd apps/RelayiumKit && swift build && swift test
cd ../.. && xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' -configuration Debug build 2>&1 | grep -E 'error:|\*\* BUILD' | tail -2
```
Expected: suite passes; `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumAppKit/RealtimeConnectionFactory.swift \
        apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift
git commit -s -m "feat(native): choose the nearest relay before connecting

Measurement starts the moment signalling connects, because the sender is about
to spend real time waiting for a peer and that window is free. The connection
then waits up to 800ms for the two maps to meet.

The ordering is load-bearing rather than stylistic: RealtimeConnection's
initialiser takes over signaling.onSignal, which is exactly the callback the
negotiator needs. Constructing it before the choice is settled would disable
the feature silently — no error, just a fallback on every transfer.

Relay-only is applied only when a relay was actually chosen. The fallback set
may contain no relay at all on a LAN room, and forcing .relay there would leave
ICE with nothing to gather."
```

---

### Task 8: Acceptance

## OUTCOME, recorded 2026-07-28

**Not exercised.** Every item below needs two real peers on different networks;
none was run. This is a record of a decision, not a result.

| Item | Result |
|---|---|
| Cross-network Mac → browser, chosen relay id matches on both sides | not exercised |
| Fallback against a peer on a build without this change | not exercised |
| Record the RTT numbers and replace the 800 ms guess | not exercised |
| LAN room (no code, empty pool) still connects with host candidates | not exercised |

So `relayChoiceDeadline = 800ms` remains what the design said it was: a guess
with no measurement behind it.

### What review caught instead

Nothing here was found by running the code. It was found by reading it, and two
of the three were defects in this plan's own text rather than in the
implementation:

1. **Task 4** — the plan's `waitForChoice` raced a `withCheckedContinuation`
   against `Task.sleep` inside a `withTaskGroup`. Cancellation does not resume a
   suspended continuation and the group awaits every child at scope exit, so on
   the "nobody answers" path — the fallback this whole feature depends on — it
   hung forever, silently. Found by the implementer, reproduced standalone,
   rewritten.
2. **Task 6** — the plan handed the same rejected shape to a second task, which
   used it. Caught in review by noticing that `RelayNegotiator` already carried
   a comment warning against exactly that pattern, written by the same
   implementer one task earlier.
3. **Task 7** — during the wait, `onSignal` belongs to the negotiator, which
   silently drops anything that is not a relay-RTT map. A peer's SDP offer
   arriving in that window was lost permanently, with no error. The window was
   microseconds before this round widened it. A browser peer never blocks on
   the choice, so it sends its offer immediately — this was a real silent hang
   against the web client. Now buffered and replayed.

### What is still unknown

The three above were reachable by reading. These are not:

- Whether two peers actually converge on the same relay id in practice. The
  algorithm is symmetric and property-tested, but nothing has confirmed the
  Mac and the browser agree on a live pairing.
- Whether 800 ms is enough for the joining side, whose `firstPeer` returns
  immediately and whose whole measurement must therefore fit inside the
  deadline — while `RelayProbe`'s own per-relay timeout is 4 s. One unreachable
  relay in the pool plausibly disables the feature for both peers on every
  transfer. This is written up as a deferred minor and is the first thing a
  real run would answer.
- Whether relay-only transport breaks anything that works today. The fallback
  keeps `.all`, and that is traced and reviewed, but not observed.

---

## Original plan


**Blocked on Tasks 1–7.** Needs a signed Debug build and two real peers.

- [ ] **Cross-network Mac → browser** completes, and the Mac's chosen relay id
  matches the one the browser picked. Both sides run the same algorithm over the
  same maps, so a mismatch means the copy is not faithful and is a
  stop-everything result — it would mean every transfer since has been relying
  on ICE to paper over a disagreement.
- [ ] **Fallback:** the same transfer against a peer on a build without this
  change still completes.
- [ ] **Record the numbers.** Log both RTT maps and the chosen id once per
  session, and put the observed spread in the design doc. `relayChoiceDeadline`
  is a guess until this happens.
- [ ] **LAN room** (no code, empty pool) still connects, with host candidates —
  the regression `.relay` would cause if it leaked outside the chosen-relay
  case.

**Record the result honestly, including "not exercised" if it is not run.** See
R1-G3's Task 11 for the format and for why: three defects there were reachable
only by connecting two real peers, and unticked boxes are how a skipped step
becomes an assumed-passing one.

---

## Self-review

**Spec coverage.** Decode the pool → Task 2. Symmetric selection → Task 1. Wire
message → Task 3. Exchange, convergence and the bounded wait → Task 4.
Relay-only transport → Tasks 5 and 7. Measurement → Task 6. Orchestration and
the model's widened closure → Tasks 2 and 7. Every fallback row in the spec's
table has a test in Task 4 except "a relay does not answer", which is Task 6's
absent-key behaviour and is asserted indirectly by Task 4's empty-map cases.
Acceptance → Task 8.

**Placeholder scan.** No TBDs. The one deliberately unresolved value,
`relayChoiceDeadline = 800ms`, is named as a guess in the constant's own
comment, in the spec, and in Task 8's acceptance item — not left implicit.

**Type consistency.** `ICEConfig`/`RelayEntry` (Task 2) are used with the same
field names in Tasks 4, 6 and 7. `RelayChoice.pick(mine:theirs:)` keeps its
argument labels in Tasks 1 and 4. `RelayNegotiator`'s `measure` closure type
`([RelayEntry]) async -> [String: Int]` matches `RelayProbe.measureAll`'s
signature in Tasks 4, 6 and 7. `RealtimeConnection.init`'s new parameter is
named `iceTransportPolicy` in Tasks 5 and 7.
