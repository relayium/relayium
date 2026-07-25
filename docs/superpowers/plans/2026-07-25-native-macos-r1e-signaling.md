# Native macOS R1-E: Signaling module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `Signaling` module to `RelayiumKit` — a Swift WebSocket client for the `/ws` rendezvous hub that joins a code room, receives the self-id + peer roster, and relays opaque `signal` envelopes between peers. It is the transport the realtime path (R1-F) rides on; it does no WebRTC and no crypto itself.

**Architecture:** `Signaling` mirrors `web/src/lib/signaling.ts`'s `SignalingClient`. The wire is the Go `signal.Envelope` (`{type, from, to, name, ip, peers, data}`). The socket is abstracted behind a `WebSocketChannel` protocol (like the web's injectable `WsFactory`) so tests drive a fake socket and the real implementation wraps `URLSessionWebSocketTask`. The `data` field is opaque JSON (`json.RawMessage` server-side) — the module relays it untouched; R1-F owns its schema (SDP/ICE + commit-reveal). Interop is pinned by Codable field names matching the Go struct exactly and by round-tripping frozen envelope fixtures.

**Tech Stack:** Swift 5.9+, `URLSessionWebSocketTask` (real socket), XCTest with a fake `WebSocketChannel`. Reuses nothing from other modules except being in the same package. No new dependencies.

## This plan's place in R1

Cloud-first R1 sequence: R1-A `Crypto` ✓ → R1-B `StoredWire` ✓ → R1-C `Account` ✓ → R1-D `Cloud` ✓ → **R1-E `Signaling` (this plan)** → R1-F `Realtime` → R1-G UI+distribution. R1-F's `Realtime` uses this client to exchange WebRTC offers/answers/ICE and to run the commit-reveal SAS handshake (over `sendSignal`/`onSignal`), reusing R1-A `Crypto`.

## Grounding (verified against the server + web client)

- Envelope (`server/internal/signal/message.go`): `type Envelope { Type string; From string; To string; Name string; IP string; Peers []Peer; Data json.RawMessage }` with JSON tags `type, from, to, name, ip, peers, data` (all but `type` omitempty). `Peer { ID string json:"id"; Name string json:"name" }`. Message types: `join`, `welcome`, `peers`, `signal`.
- Flow (`web/src/lib/signaling.ts`): on socket open → send `{type:"join", name:<deviceName>}`. Inbound: `welcome` → self id is `e.name`, plus `e.ip` (server-observed public IP, "" if none); `peers` → `e.peers` roster; `signal` → `(e.from, e.data)` where `data` is opaque. Outbound signal: `{type:"signal", to:<peerId>, data:<opaque>}`. Send is best-effort — never throws when the socket is mid-reconnect (CLOSING/CLOSED); a dropped frame is re-aligned by a fresh join/peers after reconnect.
- URL (`server/internal/rzvous/rzvous.go` `Join`): connect to `<wsBase>/ws?code=<urlencoded code>`; an EMPTY code joins the LAN room, a non-empty code joins that code room. `wsBase` is `wss://relayium.com` in prod.
- The server stamps `from` on relayed `signal` frames; the client never sets `from`.

## Global Constraints

- **Envelope JSON matches the Go struct verbatim**: keys `type, from, to, name, ip, peers, data`; `peers` items `{id, name}`. Omit empty optional fields on encode (match Go `omitempty`) so `join`/`signal` frames are byte-reasonable, though the server tolerates extra nulls — the hard requirement is the peer/server can parse them.
- **`data` is opaque JSON**: the module never interprets it. Model it as an optional `JSONValue` (a Codable enum) so any valid JSON round-trips; R1-F converts its typed payloads ↔ `JSONValue`. Byte-exact preservation of `data` is NOT required (the server relays it as `json.RawMessage` and the peer parses it semantically).
- **Best-effort send**: sending on a non-open socket must NOT throw/crash; drop the frame silently (matches the web).
- **The socket is injectable**: all `SignalingClient` tests use a fake `WebSocketChannel`; the real `URLSessionWebSocketTask` wrapper is exercised by R1-F/R1-G integration, not unit tests.
- **Self id comes from `welcome.name`** (not a separate field) — an easy mismatch to get wrong.
- **Min platforms / cadence**: macOS 13, Swift 5.9; commit after every green test cycle; English commit messages.

---

## File structure (R1-E)

- Create: `apps/RelayiumKit/Sources/RelayiumKit/Signaling/SignalEnvelope.swift` — `Envelope`, `Peer`, `JSONValue`, message-type constants.
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Signaling/WebSocketChannel.swift` — the `WebSocketChannel` protocol + `URLSessionWebSocketChannel` real impl.
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Signaling/SignalingClient.swift` — the client (connect/join/dispatch/sendSignal).
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/SignalEnvelopeTests.swift`, `SignalingClientTests.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/Support/FakeWebSocketChannel.swift`
- Create: `docs/protocol/relayium-signaling-v1.md` — frozen signaling protocol.

---

## Task 1: Freeze the signaling protocol doc

**Files:**
- Create: `docs/protocol/relayium-signaling-v1.md`

- [ ] **Step 1: Write the signaling spec**

Create `docs/protocol/relayium-signaling-v1.md`, verbatim from `server/internal/signal/message.go`, `web/src/lib/signaling.ts`, and `server/internal/rzvous/rzvous.go`:

```markdown
# Relayium signaling protocol v1 (authoritative)

The WebSocket rendezvous that pairs two peers in a code room and relays their
opaque WebRTC/crypto payloads. Transport only — the SDP/ICE and commit-reveal SAS
handshake ride inside `data` and are defined by the realtime layer, not here.

## Connection
- `GET <wsBase>/ws?code=<urlencoded code>` upgraded to a WebSocket.
- Empty code → the LAN room; non-empty code → that code room. A pairing-code room
  holds exactly two peers; the LAN room holds up to a server cap (currently 50),
  so the `peers` roster there may list more than one other peer.

## Envelope (every frame, both directions), JSON:
{ "type": string, "from"?: string, "to"?: string, "name"?: string,
  "ip"?: string, "peers"?: [{"id":string,"name":string}], "data"?: <any JSON> }
- `type` ∈ { "join", "welcome", "peers", "signal" }.
- All fields except `type` are optional (Go omitempty).

## Sequence
1. On open, the client sends `{"type":"join","name":<device nickname>}`.
2. Server replies `{"type":"welcome","name":<this client's peer id>,"ip":<server-observed public IP or "">}`.
   (The self peer id is carried in `name` on welcome.)
3. Server sends `{"type":"peers","peers":[{id,name},…]}` — the current room roster,
   and again whenever it changes.
4. To signal a peer: `{"type":"signal","to":<peer id>,"data":<opaque JSON>}`.
   The server relays it to that peer and stamps `from` = the sender's peer id.
   The client never sets `from`.

## Robustness
- Inbound frames are untrusted: a malformed / non-object / non-JSON frame is
  dropped, never crashes the receive loop.
- Sending on a socket that is not OPEN is a no-op (best-effort); a lost frame is
  re-aligned by the join/welcome/peers exchange after reconnect.
- `data` is never interpreted by the signaling layer.
```

- [ ] **Step 2: Commit**

```bash
git add docs/protocol/relayium-signaling-v1.md
git commit -m "docs(protocol): freeze relayium signaling protocol v1"
```

---

## Task 2: Signaling models — Envelope, Peer, JSONValue

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Signaling/SignalEnvelope.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/SignalEnvelopeTests.swift`

**Interfaces:**
- Produces:
  - `enum JSONValue: Codable, Equatable { case object([String: JSONValue]); case array([JSONValue]); case string(String); case number(Double); case bool(Bool); case null }`
  - `struct Peer: Codable, Equatable { let id: String; let name: String }`
  - `struct Envelope: Codable, Equatable { var type: String; var from: String?; var to: String?; var name: String?; var ip: String?; var peers: [Peer]?; var data: JSONValue? }` with `omitempty`-style optional encoding.
  - `enum SignalType { static let join="join", welcome="welcome", peers="peers", signal="signal" }`

- [ ] **Step 1: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/SignalEnvelopeTests.swift`:

```swift
import XCTest
@testable import RelayiumKit

final class SignalEnvelopeTests: XCTestCase {
    private let dec = JSONDecoder()
    private let enc = JSONEncoder()

    func testDecodeWelcome() throws {
        let e = try dec.decode(Envelope.self, from: Data(#"{"type":"welcome","name":"peerA","ip":"1.2.3.4"}"#.utf8))
        XCTAssertEqual(e.type, "welcome"); XCTAssertEqual(e.name, "peerA"); XCTAssertEqual(e.ip, "1.2.3.4")
    }
    func testDecodePeers() throws {
        let e = try dec.decode(Envelope.self, from: Data(#"{"type":"peers","peers":[{"id":"a","name":"Mac"},{"id":"b","name":"Phone"}]}"#.utf8))
        XCTAssertEqual(e.peers?.map(\.id), ["a", "b"])
        XCTAssertEqual(e.peers?.map(\.name), ["Mac", "Phone"])
    }
    func testDecodeSignalWithOpaqueData() throws {
        let e = try dec.decode(Envelope.self, from: Data(#"{"type":"signal","from":"a","data":{"kind":"offer","sdp":"v=0"}}"#.utf8))
        XCTAssertEqual(e.type, "signal"); XCTAssertEqual(e.from, "a")
        guard case let .object(o)? = e.data, case let .string(k)? = o["kind"] else { return XCTFail("data not object") }
        XCTAssertEqual(k, "offer")
    }
    func testEncodeJoinOmitsEmptyFields() throws {
        let e = Envelope(type: "join", name: "Mac")
        let s = String(data: try enc.encode(e), encoding: .utf8)!
        // only type + name present; no from/to/ip/peers/data keys
        XCTAssertTrue(s.contains("\"type\":\"join\""))
        XCTAssertTrue(s.contains("\"name\":\"Mac\""))
        XCTAssertFalse(s.contains("\"from\""))
        XCTAssertFalse(s.contains("\"data\""))
        XCTAssertFalse(s.contains("\"peers\""))
    }
    func testEncodeSignalRoundTrips() throws {
        let e = Envelope(type: "signal", to: "b", data: .object(["kind": .string("ice"), "n": .number(3)]))
        let back = try dec.decode(Envelope.self, from: try enc.encode(e))
        XCTAssertEqual(back, e)
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `swift test --filter SignalEnvelopeTests`
Expected: FAIL — types undefined.

- [ ] **Step 3: Implement the models**

Create `apps/RelayiumKit/Sources/RelayiumKit/Signaling/SignalEnvelope.swift`:

```swift
import Foundation

public enum SignalType {
    public static let join = "join"
    public static let welcome = "welcome"
    public static let peers = "peers"
    public static let signal = "signal"
}

/// Opaque JSON payload carried in a signal's `data`. The signaling layer never
/// interprets it; the realtime layer converts its typed payloads to/from this.
public indirect enum JSONValue: Codable, Equatable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON")
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        }
    }
}

public struct Peer: Codable, Equatable {
    public let id: String
    public let name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}

public struct Envelope: Codable, Equatable {
    public var type: String
    public var from: String?
    public var to: String?
    public var name: String?
    public var ip: String?
    public var peers: [Peer]?
    public var data: JSONValue?

    public init(type: String, from: String? = nil, to: String? = nil, name: String? = nil,
                ip: String? = nil, peers: [Peer]? = nil, data: JSONValue? = nil) {
        self.type = type; self.from = from; self.to = to; self.name = name
        self.ip = ip; self.peers = peers; self.data = data
    }
    // Codable synthesises key names == property names (type/from/to/name/ip/peers/data),
    // and JSONEncoder omits nil optionals by default — matching Go's omitempty.
}
```

> Note on `bool` before `number`: JSON `true`/`false` must decode as `.bool`, not `.number` — Swift's `Double` decode rejects `true`, but ordering `bool` first is the safe, explicit choice. `.number(Double)` covers ints and floats; since `data` is semantically parsed by the peer (not byte-compared), integer-vs-double re-encoding is irrelevant.

- [ ] **Step 4: Run it to verify it passes**

Run: `swift test --filter SignalEnvelopeTests` → PASS. Full `swift test` → all green.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Signaling/SignalEnvelope.swift apps/RelayiumKit/Tests/RelayiumKitTests/SignalEnvelopeTests.swift
git commit -m "feat(native): Signaling envelope + Peer + JSONValue models (matches Go signal.Envelope)"
```

---

## Task 3: `WebSocketChannel` protocol + `URLSessionWebSocketChannel`

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Signaling/WebSocketChannel.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/Support/FakeWebSocketChannel.swift`

**Interfaces:**
- Produces:
  - `protocol WebSocketChannel: AnyObject { var onOpen: (() -> Void)? { get set }; var onText: ((String) -> Void)? { get set }; var onClose: (() -> Void)? { get set }; func send(_ text: String); func close(); var isOpen: Bool { get } }`
  - `final class URLSessionWebSocketChannel: WebSocketChannel` wrapping `URLSessionWebSocketTask` (real).
  - Test support: `final class FakeWebSocketChannel: WebSocketChannel` (records sent frames; lets tests fire onOpen/onText/onClose).

- [ ] **Step 1: Write the fake + a smoke test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/Support/FakeWebSocketChannel.swift`:

```swift
import Foundation
@testable import RelayiumKit

final class FakeWebSocketChannel: WebSocketChannel {
    var onOpen: (() -> Void)?
    var onText: ((String) -> Void)?
    var onClose: (() -> Void)?
    private(set) var sent: [String] = []
    private(set) var closed = false
    var isOpen: Bool = false

    func send(_ text: String) { if isOpen { sent.append(text) } }
    func close() { closed = true; isOpen = false; onClose?() }

    // Test drivers:
    func fireOpen() { isOpen = true; onOpen?() }
    func fireText(_ t: String) { onText?(t) }
    func fireRemoteClose() { isOpen = false; onClose?() }
}
```

Create `apps/RelayiumKit/Tests/RelayiumKitTests/WebSocketChannelTests.swift`:

```swift
import XCTest
@testable import RelayiumKit

final class WebSocketChannelTests: XCTestCase {
    func testFakeRecordsSendsOnlyWhenOpen() {
        let ch = FakeWebSocketChannel()
        ch.send("dropped")           // not open yet → dropped (best-effort)
        ch.fireOpen()
        ch.send("kept")
        XCTAssertEqual(ch.sent, ["kept"])
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `swift test --filter WebSocketChannelTests`
Expected: FAIL — `WebSocketChannel` undefined.

- [ ] **Step 3: Implement the protocol + real channel**

Create `apps/RelayiumKit/Sources/RelayiumKit/Signaling/WebSocketChannel.swift`:

```swift
import Foundation

/// The minimal socket surface SignalingClient needs. Abstracted so tests inject
/// a fake and the real implementation wraps URLSessionWebSocketTask.
public protocol WebSocketChannel: AnyObject {
    var onOpen: (() -> Void)? { get set }
    var onText: ((String) -> Void)? { get set }
    var onClose: (() -> Void)? { get set }
    var isOpen: Bool { get }
    func send(_ text: String)
    func close()
}

/// Real WebSocket over URLSessionWebSocketTask. Connects on init; drives a
/// receive loop that forwards text frames to onText and ends on error/close.
public final class URLSessionWebSocketChannel: NSObject, WebSocketChannel, URLSessionWebSocketDelegate {
    public var onOpen: (() -> Void)?
    public var onText: ((String) -> Void)?
    public var onClose: (() -> Void)?
    public private(set) var isOpen = false

    private var task: URLSessionWebSocketTask!
    private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)

    public init(url: URL) {
        super.init()
        task = session.webSocketTask(with: url)
        task.resume()
        receive()
    }

    private func receive() {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let msg):
                if case let .string(s) = msg { self.onText?(s) }
                self.receive()   // keep reading
            case .failure:
                self.markClosed()
            }
        }
    }
    private func markClosed() {
        guard isOpen || task != nil else { return }
        isOpen = false
        onClose?()
    }

    public func send(_ text: String) {
        guard isOpen else { return }          // best-effort; drop when not open
        task.send(.string(text)) { _ in }     // fire-and-forget; a lost frame is re-aligned after reconnect
    }
    public func close() { isOpen = false; task.cancel(with: .goingAway, reason: nil) }

    // URLSessionWebSocketDelegate:
    public func urlSession(_ s: URLSession, webSocketTask: URLSessionWebSocketTask,
                           didOpenWithProtocol proto: String?) { isOpen = true; onOpen?() }
    public func urlSession(_ s: URLSession, webSocketTask: URLSessionWebSocketTask,
                           didCloseWith code: URLSessionWebSocketTask.CloseCode, reason: Data?) { markClosed() }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `swift test --filter WebSocketChannelTests` → PASS. Full `swift test` → all green.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Signaling/WebSocketChannel.swift apps/RelayiumKit/Tests/RelayiumKitTests/Support/FakeWebSocketChannel.swift apps/RelayiumKit/Tests/RelayiumKitTests/WebSocketChannelTests.swift
git commit -m "feat(native): WebSocketChannel protocol + URLSessionWebSocketTask impl + fake"
```

---

## Task 4: `SignalingClient`

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Signaling/SignalingClient.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/SignalingClientTests.swift`

**Interfaces:**
- Consumes: `Envelope`/`Peer`/`JSONValue` (Task 2), `WebSocketChannel`/`FakeWebSocketChannel` (Task 3).
- Produces:
  - `final class SignalingClient` with `init(channel: WebSocketChannel, name: String)`; callbacks `onSelfId`, `onPeers`, `onSignal`, `onClose`; `sendSignal(to:data:)`.
  - A convenience `static func connect(wsBase: URL, code: String, name: String) -> SignalingClient` building `URLSessionWebSocketChannel` at `<wsBase>/ws?code=<code>`.

- [ ] **Step 1: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/SignalingClientTests.swift`:

```swift
import XCTest
@testable import RelayiumKit

final class SignalingClientTests: XCTestCase {
    func testJoinsOnOpen() {
        let ch = FakeWebSocketChannel()
        _ = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        XCTAssertEqual(ch.sent.count, 1)
        let e = try! JSONDecoder().decode(Envelope.self, from: Data(ch.sent[0].utf8))
        XCTAssertEqual(e.type, "join"); XCTAssertEqual(e.name, "Mac")
    }
    func testWelcomeDeliversSelfIdAndIp() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var selfId = ""; var ip = ""
        c.onSelfId = { selfId = $0; ip = $1 }
        ch.fireOpen()
        ch.fireText(#"{"type":"welcome","name":"peerA","ip":"9.9.9.9"}"#)
        XCTAssertEqual(selfId, "peerA"); XCTAssertEqual(ip, "9.9.9.9")
    }
    func testPeersDelivered() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var got: [Peer] = []; c.onPeers = { got = $0 }
        ch.fireOpen()
        ch.fireText(#"{"type":"peers","peers":[{"id":"a","name":"A"}]}"#)
        XCTAssertEqual(got, [Peer(id: "a", name: "A")])
    }
    func testSignalDeliversFromAndData() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var from = ""; var data: JSONValue?
        c.onSignal = { from = $0; data = $1 }
        ch.fireOpen()
        ch.fireText(#"{"type":"signal","from":"b","data":{"kind":"offer"}}"#)
        XCTAssertEqual(from, "b")
        guard case let .object(o)? = data, case .string("offer")? = o["kind"] else { return XCTFail() }
    }
    func testSendSignalWrapsToAndData() throws {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        ch.fireOpen()
        ch.sent.removeAll()   // drop the join frame
        c.sendSignal(to: "b", data: .object(["kind": .string("ice")]))
        let e = try JSONDecoder().decode(Envelope.self, from: Data(ch.sent[0].utf8))
        XCTAssertEqual(e.type, "signal"); XCTAssertEqual(e.to, "b")
        guard case let .object(o)? = e.data, case .string("ice")? = o["kind"] else { return XCTFail() }
        XCTAssertNil(e.from)   // client never sets from
    }
    func testMalformedInboundIsIgnored() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var signalled = false; c.onSignal = { _, _ in signalled = true }
        ch.fireOpen()
        ch.fireText("not json"); ch.fireText("[]"); ch.fireText(#"{"type":123}"#)
        XCTAssertFalse(signalled)   // no crash, no dispatch
    }
    func testCloseFires() {
        let ch = FakeWebSocketChannel(); let c = SignalingClient(channel: ch, name: "Mac")
        var closed = false; c.onClose = { closed = true }
        ch.fireOpen(); ch.fireRemoteClose()
        XCTAssertTrue(closed)
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `swift test --filter SignalingClientTests`
Expected: FAIL — `SignalingClient` undefined.

- [ ] **Step 3: Implement the client**

Create `apps/RelayiumKit/Sources/RelayiumKit/Signaling/SignalingClient.swift`:

```swift
import Foundation

/// WebSocket rendezvous client: joins a code room, surfaces the self id + peer
/// roster, relays opaque `signal` payloads. Mirrors web/src/lib/signaling.ts.
public final class SignalingClient {
    public var onSelfId: ((String, String) -> Void)?   // (selfPeerId, serverObservedIP)
    public var onPeers: (([Peer]) -> Void)?
    public var onSignal: ((String, JSONValue) -> Void)? // (fromPeerId, data)
    public var onClose: (() -> Void)?

    private let channel: WebSocketChannel
    private let name: String
    private let enc = JSONEncoder()
    private let dec = JSONDecoder()

    public init(channel: WebSocketChannel, name: String) {
        self.channel = channel
        self.name = name
        channel.onOpen = { [weak self] in self?.sendJoin() }
        channel.onText = { [weak self] t in self?.handle(t) }
        channel.onClose = { [weak self] in self?.onClose?() }
    }

    /// Build a real client at `<wsBase>/ws?code=<code>` (empty code → LAN room).
    public static func connect(wsBase: URL, code: String, name: String) -> SignalingClient {
        var comps = URLComponents(url: wsBase.appendingPathComponent("ws"), resolvingAgainstBaseURL: false)!
        if !code.isEmpty { comps.queryItems = [.init(name: "code", value: code)] }
        let ch = URLSessionWebSocketChannel(url: comps.url!)
        return SignalingClient(channel: ch, name: name)
    }

    public func sendSignal(to: String, data: JSONValue) {
        send(Envelope(type: SignalType.signal, to: to, data: data))
    }

    private func sendJoin() { send(Envelope(type: SignalType.join, name: name)) }

    private func send(_ e: Envelope) {
        guard let d = try? enc.encode(e), let s = String(data: d, encoding: .utf8) else { return }
        channel.send(s)   // WebSocketChannel.send is itself best-effort (no-op when closed)
    }

    private func handle(_ text: String) {
        // Untrusted inbound: a malformed frame is dropped, never crashes the loop.
        guard let e = try? dec.decode(Envelope.self, from: Data(text.utf8)) else { return }
        switch e.type {
        case SignalType.welcome:
            if let id = e.name { onSelfId?(id, e.ip ?? "") }
        case SignalType.peers:
            if let p = e.peers { onPeers?(p) }
        case SignalType.signal:
            if let from = e.from, let data = e.data { onSignal?(from, data) }
        default:
            break
        }
    }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `swift test --filter SignalingClientTests` → PASS (7 tests). Full `swift test` → all green.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Signaling/SignalingClient.swift apps/RelayiumKit/Tests/RelayiumKitTests/SignalingClientTests.swift
git commit -m "feat(native): SignalingClient (join/welcome/peers/signal over WebSocketChannel)"
```

---

## Self-review (against the spec)

- **Spec coverage:** signaling protocol doc → Task 1; Envelope/Peer/JSONValue matching the Go struct → Task 2; socket abstraction (protocol + real URLSessionWebSocketTask + fake) → Task 3; the client (join-on-open, welcome→selfId, peers, signal, sendSignal, best-effort send, malformed-drop, close) → Task 4.
- **Placeholder scan:** none — every code step has complete code.
- **Type consistency:** `Envelope`/`Peer`/`JSONValue`/`SignalType` defined once (Task 2), reused by the client (Task 4). `WebSocketChannel`/`FakeWebSocketChannel` (Task 3) reused by the client tests (Task 4). Self id read from `welcome.name`; client never sets `from`; `sendSignal` sets only `to`+`data`.

## Interop / correctness safety

Signaling speaks the exact Go `signal.Envelope` (field names pinned by Task 2's decode tests against real frames), so a native client joins the same `/ws` code room a browser/CLI peer joins and their `signal` payloads relay unchanged. Unit tests drive a fake socket (deterministic); the real `URLSessionWebSocketChannel` is exercised by R1-F/R1-G against the live hub. The `data` opacity means R1-F can evolve its SDP/ICE/handshake schema without touching this layer.

## Next

R1-F (`Realtime`): native WebRTC (`stasel/WebRTC`) over this signaling channel — the commit-reveal SAS handshake (reusing R1-A `Crypto`), the DataChannel with the ACK credit-window flow control matching the browser, and the `WireVersion` guard; plus the browser↔native E2E interop harness.
