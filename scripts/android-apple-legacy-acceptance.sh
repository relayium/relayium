#!/usr/bin/env bash
#
# **The Android app on a real emulator ↔ a real Apple client, over a real
# pairing code, on a real server — on the SHIPPED pre-`link/1` wire.**
#
#   ./scripts/android-apple-legacy-acceptance.sh
#
# ## The cell nothing else fills
#
# `android-interop-acceptance.sh` pairs this app with a browser, and the
# browser speaks `link/1`: two lanes on one connection, an ordered abort
# barrier, five control bytes. The Apple clients do NOT speak it in a
# pairing-code room — `PeerCapabilityRegistry.LINK_PAIRING_ROOM_SUPPORT` is
# false on iOS — so every cross-network session between this app and an iPhone
# runs on the OLDER wire instead: one `data` channel, ONE generation per
# connection, a three-byte control set, no barrier and no resume.
#
# That wire is therefore the entire Android↔iPhone product, and nothing else in
# this repository exercises it end to end.
#
# ## What is real, and what the Apple half actually is
#
# * a real Relayium server built from ./server, on an ephemeral loopback port;
# * a real pairing code — minted through `/api/pair` for the rounds this app
#   JOINS, and minted BY THE APP through `TransferViewModel.createCrossNetworkLink`
#   for the rounds it CREATES;
# * the real debug APK on a real emulator, driven through its own
#   `MainActivity`/`TransferViewModel` (`LegacyInteropAcceptanceTest`), with
#   real OkHttp signalling, real native WebRTC and the real SAF stack;
# * on the other side, the UNCHANGED shipped `RealtimeConnection` from
#   `apps/RelayiumKit`, reached through the equally unchanged `PlainPeer`, and
#   driven by a small caller this script writes out below.
#
# **Read that last point precisely.** The Apple half is the shipped Swift
# TRANSPORT compiled from this repository, running on the host as a macOS
# process. It is NOT an iOS binary, not the iOS app, and not a device: it
# proves the two implementations agree on the wire, and it proves nothing about
# iOS packaging, lifecycle, backgrounding or UI. A real iPhone running the
# shipped app can join the same code against the same server without any source
# change, and that run — not this one — is what would license a claim about the
# App.
#
# Nothing on the Apple side is an Android-derived double. The caller composes
# no frame and writes no control byte; it joins a room, greets the peer the way
# `RealtimeConnectionFactory.connectInRoom` greets it, answers a manifest,
# confirms a conversation, and records what arrived. The two shipped modules
# are copied VERBATIM into the scratch package and every copy is checked by
# SHA-256 against the repository's own file, because `RelayiumPeerKit` is a
# target rather than a product and cannot otherwise be imported.
#
# ## What each round proves
#
# Both role assignments, because on this wire the role is the USER'S INTENT
# rather than a sorted hub id: the creator of the code offers and the joiner
# answers. A run that only ever joined would leave every session an Android
# user starts completely untested.
#
# Both generations, because a legacy connection carries files OR messages and
# never both, and the two are chosen by different evidence.
#
# Both directions of bytes, on SEPARATE connections. `RealtimeConnection.send`
# is one-shot (`alreadySending` exists because a second `RealtimeSender` would
# restart the nonce counter under one key), so a file round carries one
# direction and its twin runs on a fresh connection. Nothing here may be read
# as a claim that a legacy connection is reusable the way a link is.
#
# The payloads are the boundaries only two implementations disagree about: a
# body past the 192 KiB logical chunk, a ZERO-byte file in the middle of the
# stream, a multi-entry batch, a loose file beside a two-level folder so the
# receiver has to rebuild nested paths, and non-ASCII whitespace-significant
# text in both directions. Every file is compared by SHA-256 AND by the path it
# was rebuilt at, each computed independently on the two sides.
#
# The Apple-side batch is owned by the caller below rather than taken from
# `AcceptanceBatch`: that shipped fixture's largest entry is 96 000 bytes, under
# the logical chunk, so a round built on it would cross no fragment boundary
# while claiming one. The shipped module is not edited to fix that.
#
# And three adversarial paths, because the ones that differ from `link/1` are
# exactly the ones a user can reach: a decline (a COMPLETE in-band exchange —
# the connection must survive it), a mid-transfer cancel (no barrier exists, so
# the connection must close rather than let a cancelled transfer keep
# arriving), and a refused conversation. A reconnect round follows the cancel,
# because "it closed" is only half of what the product promises.
#
# ## What a green run does NOT prove
#
# An AOSP emulator image with no Google Play services, a host-local Swift
# process and loopback candidates. Not a phone, not an iPhone, not a real
# network, and not a race detector.
#
# ## Isolation
#
# `scripts/lib/local-acceptance.sh` owns every rule: ephemeral ports, one
# per-run temp root, tokens in the environment or a 0600 config file and never
# in argv, PID-exact cleanup with no `pkill`, loopback-only STUN. The app under
# test asserts its OWN resolved backend origin before it joins anything.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/local-acceptance.sh
source "$here/lib/local-acceptance.sh"

gradle_bin="${RELAYIUM_GRADLE:-$repo/apps/android/gradlew}"
swift_bin="${RELAYIUM_SWIFT:-swift}"
adb="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}/platform-tools/adb"
serial="${ANDROID_SERIAL:-}"

app_id="com.relayium.android.debug"
test_pkg="$app_id.test"
runner="androidx.test.runner.AndroidJUnitRunner"
# Only the APPLE half's own name is a constant here. The Android half's is read
# from the app at run time — see `await_report_field` below — because it is
# whatever `Build.MODEL` resolves to on the device under test ("Android SDK
# built for arm64" on the AOSP emulator), and a constant guessed here is a
# constant that can be wrong about the app.
apple_peer_name="relayium-apple"

# Deliberately not ASCII-only and deliberately whitespace-significant: the body
# rides an AEAD-sealed kind-9 frame, so anything that trims, normalises or
# re-encodes surfaces here rather than as a vague size difference.
android_message="$(printf '%b' "android → apple: 端到端 · 0123456789\n\tindented   ")"
apple_message="$(printf '%b' "apple → android: 你好 مرحبا 🌍 é\n\n\ttrailing   ")"

# `am instrument` arguments are re-split by the DEVICE shell — `adb shell`
# concatenates argv into ONE remote command line and host-side quoting does not
# survive it — so every payload with a tab, a newline or a non-ASCII character
# travels as hex and both halves decode it.
hex_of() { printf '%s' "$1" | od -An -tx1 | tr -d ' \n'; }
android_message_hex="$(hex_of "$android_message")"
apple_message_hex="$(hex_of "$apple_message")"

require_emulator() {
  [ -x "$adb" ] || fail "adb not found at $adb; set ANDROID_HOME or ANDROID_SDK_ROOT"
  local devices
  devices="$("$adb" devices | awk 'NR>1 && $2=="device" {print $1}')"
  [ -n "$devices" ] || fail "no attached device; start an emulator first (this run does not create one)"
  if [ -z "$serial" ]; then serial="$(printf '%s\n' "$devices" | head -1)"; fi
  printf '%s\n' "$devices" | grep -qx "$serial" \
    || fail "ANDROID_SERIAL=$serial is not among the attached devices: $devices"
  say "-- driving $serial"
  if "$adb" -s "$serial" shell pm list packages 2>/dev/null | grep -q 'com.google.android.gms'; then
    say "-- NOTE: this device has Google Play services; the CI image does not"
  fi
}

adbs() { "$adb" -s "$serial" "$@"; }

acceptance_begin

say "== building the local server =="
( cd "$repo/server" && go build -o "$run_root/relayium-server" . ) \
  || fail "the local server failed to build"

say "== building the debug APK and its instrumentation =="
[ -x "$gradle_bin" ] || gradle_bin="gradle"
( cd "$repo/apps/android" && "$gradle_bin" -Prelayium.android=true \
    :app:assembleDebug :app:assembleDebugAndroidTest >"$run_root/gradle.log" 2>&1 ) \
  || fail "the Android build failed: $(tail -30 "$run_root/gradle.log")"
app_apk="$repo/apps/android/app/build/outputs/apk/debug/app-debug.apk"
test_apk="$repo/apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
[ -f "$app_apk" ] || fail "no debug APK at $app_apk"
[ -f "$test_apk" ] || fail "no instrumentation APK at $test_apk"

# ── the Apple half ──────────────────────────────────────────────────────────

peer_root="$run_root/apple-peer"
build_apple_peer() {
  say "== building the Apple half from unchanged shipped modules =="
  mkdir -p "$peer_root/Sources/LegacyApplePeer" "$peer_root/Sources/RelayiumPeerKit"
  local upstream="$repo/apps/RelayiumKit/Sources/RelayiumPeerKit"
  [ -d "$upstream" ] || fail "the shipped peer module is missing at $upstream"
  cp "$upstream"/*.swift "$peer_root/Sources/RelayiumPeerKit/"
  # "Unchanged" is CHECKED rather than asserted: the copy exists only because
  # `RelayiumPeerKit` is a target and not a product, and a harness that had
  # quietly edited the module under test would be exactly the fake peer this
  # run must not contain.
  local f
  for f in "$upstream"/*.swift; do
    local mirrored
    mirrored="$peer_root/Sources/RelayiumPeerKit/$(basename "$f")"
    [ "$(shasum -a 256 <"$f" | awk '{print $1}')" = "$(shasum -a 256 <"$mirrored" | awk '{print $1}')" ] \
      || fail "the mirrored $(basename "$f") is not byte-identical to the shipped module"
  done
  shasum -a 256 "$peer_root/Sources/RelayiumPeerKit"/*.swift >"$run_root/apple-peer-module-hashes.txt"

  write_apple_peer_package
  write_apple_peer_main
  ( cd "$peer_root" && "$swift_bin" build -c release >"$run_root/swift-build.log" 2>&1 ) \
    || fail "the Apple half failed to build: $(tail -40 "$run_root/swift-build.log")"
  apple_peer_bin="$peer_root/.build/release/LegacyApplePeer"
  [ -x "$apple_peer_bin" ] || fail "no Apple peer binary at $apple_peer_bin"
  say "-- the Apple half is the shipped RealtimeConnection, compiled here"
}

write_apple_peer_package() {
  cat >"$peer_root/Package.swift" <<PKGEOF
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "LegacyApplePeer",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(path: "$repo/apps/RelayiumKit"),
        .package(url: "https://github.com/stasel/WebRTC.git", exact: "150.0.0"),
    ],
    targets: [
        // A VERBATIM copy of the shipped \`RelayiumPeerKit\`, which the upstream
        // package declares as a target rather than a product and therefore
        // cannot be imported from outside it. Every file is SHA-256 checked
        // against the repository's own copy before this builds.
        .target(
            name: "RelayiumPeerKit",
            dependencies: [
                .product(name: "RelayiumKit", package: "RelayiumKit"),
                .product(name: "WebRTC", package: "WebRTC"),
            ],
            path: "Sources/RelayiumPeerKit"
        ),
        .executableTarget(
            name: "LegacyApplePeer",
            dependencies: [
                "RelayiumPeerKit",
                .product(name: "RelayiumKit", package: "RelayiumKit"),
                .product(name: "WebRTC", package: "WebRTC"),
            ],
            path: "Sources/LegacyApplePeer"
        ),
    ]
)
PKGEOF
}

# The caller. Small on purpose: everything it does that is not bookkeeping is a
# call into the shipped transport, and the two behaviours it reproduces from
# `RealtimeConnectionFactory.connectInRoom` — the roster-level `caps` hello in
# text mode, and refusing to offer a text connection before hearing exact
# `text/1` back — are room behaviour the shipped factory performs and
# `PlainPeer` does not.
write_apple_peer_main() {
  cat >"$peer_root/Sources/LegacyApplePeer/main.swift" <<'APPLEPEEREOF'
import Foundation
import RelayiumKit
import RelayiumAppKit
import RelayiumPeerKit
import WebRTC

// The APPLE half of the Android ↔ Apple legacy acceptance.
//
// A CALLER, not an implementation. Every byte on the wire is produced and
// consumed by the unchanged shipped `RealtimeConnection` reached through
// `PlainPeer.connect(to:role:mode:)`, and the only thing written here is the
// sequencing an app would otherwise do: join a code room, greet the peer the
// way `RealtimeConnectionFactory.connectInRoom` greets it, answer a manifest,
// confirm a conversation, and write down what actually arrived.
//
// Two things are deliberately reproduced from `connectInRoom` rather than
// invented, because they are room behaviour rather than wire behaviour and the
// shipped factory performs both:
//
//   * a ROSTER-level `caps` hello in `.text` mode. `PlainPeer` sends none, and
//     without it a peer choosing its generation from what was announced would
//     resolve to files and offer a wire this side filters out — which is a
//     property of the harness, not of the client under test.
//   * in `.text` mode as the offerer, WAITING for the peer's exact `text/1`
//     before connecting. The shipped factory refuses to offer without it.
//
// Nothing else is added. No frame is composed here, no control byte is written
// by hand, and no Android-derived expectation is encoded: the report is a
// record of what this side observed, and the shell compares the two halves.

struct Options {
    var origin: URL
    var code: String
    var name: String
    var peerName: String
    var role: Role
    var mode: RealtimeConnectionFactory.Mode
    /// send | send-held | send-declined | receive | text | expect-reject | expect-close
    var action: String
    var messageHex: String?
    var expectMessageHex: String?
    var reportPath: String
    var timeout: TimeInterval
    /// A file the OWNING shell creates once the app half has returned.
    ///
    /// The rounds whose endpoint is "the peer finished and let go" cannot be
    /// terminated by anything this side observes on the wire: a refusal arrives
    /// long before the app has checked what it wanted to check, and the RTC
    /// teardown that follows is the app being torn down, not the round
    /// succeeding. Waiting for a marker the parent writes is the only signal
    /// that actually means "the other half is done".
    var doneMarker: String?
}

func arg(_ name: String) -> String? {
    var it = CommandLine.arguments.makeIterator()
    while let a = it.next() {
        if a == "--\(name)" { return it.next() }
    }
    return nil
}

func require(_ name: String) -> String {
    guard let v = arg(name) else {
        FileHandle.standardError.write(Data("legacy-apple-peer: --\(name) is required\n".utf8))
        exit(2)
    }
    return v
}

func hexToString(_ hex: String) -> String {
    var bytes = [UInt8]()
    var index = hex.startIndex
    while index < hex.endIndex, let next = hex.index(index, offsetBy: 2, limitedBy: hex.endIndex) {
        bytes.append(UInt8(hex[index..<next], radix: 16) ?? 0)
        index = next
    }
    return String(decoding: bytes, as: UTF8.self)
}

let options = Options(
    origin: URL(string: require("origin"))!,
    code: require("code"),
    name: require("name"),
    peerName: require("peer"),
    role: require("role") == "initiator" ? .initiator : .responder,
    mode: require("mode") == "text" ? .text : .file,
    action: require("action"),
    messageHex: arg("message-hex"),
    expectMessageHex: arg("expect-message-hex"),
    reportPath: require("report"),
    timeout: TimeInterval(arg("timeout") ?? "240") ?? 240,
    doneMarker: arg("done-marker")
)

// Everything the shell compares, and nothing it has to infer.
final class Observations: @unchecked Sendable {
    private let lock = NSLock()
    private var fields: [String: Any] = [:]
    func set(_ key: String, _ value: Any) { lock.lock(); fields[key] = value; lock.unlock() }
    func append(_ key: String, _ value: Any) {
        lock.lock()
        var existing = fields[key] as? [Any] ?? []
        existing.append(value)
        fields[key] = existing
        lock.unlock()
    }
    func has(_ key: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return fields[key] != nil
    }
    func bool(_ key: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return fields[key] as? Bool ?? false
    }
    func write(to path: String) {
        lock.lock(); let snapshot = fields; lock.unlock()
        let data = try? JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys])
        try? (data ?? Data("{}".utf8)).write(to: URL(fileURLWithPath: path))
    }
}

/// The batch this caller offers.
///
/// **Caller-owned rather than `AcceptanceBatch.make`.** That shipped fixture is
/// right for what it was written for, but its largest entry is 96 000 bytes —
/// under the 192 KiB logical chunk — so a round built on it would cross no
/// fragment boundary at all while the comparison claimed one. Adapting it here
/// keeps the shipped module unchanged and puts the fixture where the claim is.
///
/// Every entry earns its place:
///
///  - a LOOSE file with no path, beside a two-level tree, so the receiver has
///    to build a container and rebuild nested paths inside it;
///  - a body over the logical chunk, so the stream genuinely fragments;
///  - a ZERO-byte file in the MIDDLE, which is the one a length-driven splitter
///    skips, after which every later file carries its neighbour's bytes under
///    its own name;
///  - distinct bytes per file, derived from its own index, so a receiver that
///    split one byte off produces the right names and sizes with wrong digests.
func legacyBatch(tag: String) -> [(meta: FileMeta, bytes: [UInt8])] {
    let tree = "tree-\(tag)"
    func entry(_ name: String, _ path: String?, seed: UInt64, size: Int)
        -> (meta: FileMeta, bytes: [UInt8]) {
        // A fixed 64-bit LCG, not `Data.random`: reproducible, so a failing run
        // can be re-derived from its tag and its digests re-checked by hand,
        // and non-repeating, so no two files and no two offsets carry the same
        // bytes.
        var state = seed &* 0x9E37_79B9_7F4A_7C15 &+ 0x1234_5678_9ABC_DEF
        var bytes = [UInt8]()
        bytes.reserveCapacity(size)
        for _ in 0..<size {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            bytes.append(UInt8((state >> 33) & 0xff))
        }
        return (FileMeta(name: name, size: bytes.count, path: path), bytes)
    }
    return [
        entry("note-\(tag).txt", nil, seed: 1, size: 74),
        entry("a.bin", "\(tree)/day1/a.bin", seed: 2, size: 3),
        entry("empty.bin", "\(tree)/day1/empty/empty.bin", seed: 3, size: 0),
        entry("c.bin", "\(tree)/day2/c.bin", seed: 4, size: 5),
        // Past the 192 KiB logical chunk, so the batch actually fragments.
        entry("bulk.bin", "\(tree)/day2/bulk.bin", seed: 5, size: 199_000),
    ]
}

/// A source that hands over its FIRST chunk and then holds.
///
/// **For the cancel round only, and it is what makes that round deterministic.**
/// A cancel has to land while a transfer is genuinely in flight. The receiving
/// side observes that honestly — it waits for its own durable receive progress
/// to pass zero — but a 199 KiB batch over loopback can finish INSIDE one
/// 50 ms poll gap, and then the cancel arrives at a batch that already
/// completed. The round would still pass or fail, but on whichever of the two
/// it happened to be, which is not evidence about cancelling.
///
/// A fixed sleep would not fix that: it would assert that time passed, not that
/// bytes are on the wire. Holding the SOURCE does — the peer has authenticated
/// and written a real chunk, and no more can arrive until this releases.
///
/// The shipped sender is untouched and is what reads this: `read` is called on
/// `RealtimeConnection.sendQueue`, a dedicated queue that already busy-polls,
/// so blocking there stalls this transfer and nothing else. The wait is bounded
/// and released by the connection closing, which is the very thing the round is
/// waiting to observe.
final class HeldSource: PlaintextSource, @unchecked Sendable {
    let name: String
    private let bytes: [UInt8]
    private var off = 0
    private let gate = DispatchSemaphore(value: 0)
    private var released = false
    private let lock = NSLock()

    var size: Int { bytes.count }

    init(name: String, bytes: [UInt8]) {
        self.name = name
        self.bytes = bytes
    }

    /// Let the rest of the file go. Idempotent; safe from any thread.
    func release() {
        lock.lock()
        let alreadyReleased = released
        released = true
        lock.unlock()
        if !alreadyReleased { gate.signal() }
    }

    func read(_ max: Int) throws -> [UInt8] {
        guard off < bytes.count else { return [] }
        if off > 0 {
            // Everything after the first chunk waits. Bounded, so a round that
            // never cancels ends as a failure rather than hanging the process.
            _ = gate.wait(timeout: .now() + 120)
        }
        let end = min(off + max, bytes.count)
        defer { off = end }
        return Array(bytes[off..<end])
    }
}

let observed = Observations()
observed.set("role", options.role == .initiator ? "initiator" : "responder")
observed.set("mode", options.mode == .text ? "text" : "file")
observed.set("action", options.action)
observed.set("complete", false)

func log(_ message: String) {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
}

// No public STUN and no relay: both peers are reachable on host candidates,
// and a run that reached the internet would not be the offline acceptance it
// claims to be.
let peer = PlainPeer(options: .init(
    baseURL: options.origin, code: options.code, name: options.name,
    iceServers: [], log: { log($0) }
))

let deadline = Date().addingTimeInterval(options.timeout)

func fail(_ reason: String) -> Never {
    observed.set("error", reason)
    observed.write(to: options.reportPath)
    log("legacy-apple-peer: \(reason)")
    peer.close()
    exit(1)
}

// ── the room, and the hello the shipped factory sends ───────────────────────

/// Signalled by the first terminal observation of the round.
let finished = DispatchSemaphore(value: 0)

/// One value behind one lock. The callbacks fire on the connection's private
/// serial queue while the main thread waits, so nothing here may be read or
/// mutated without it.
final class Locked<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ value: T) { self.value = value }
    func mutate(_ body: (inout T) -> Void) { lock.lock(); body(&value); lock.unlock() }
    func read<R>(_ body: (T) -> R) -> R { lock.lock(); defer { lock.unlock() }; return body(value) }
}

let announcedText = NSLock()
var peerAnnouncedText = false

/// Frames that arrived before the connection existed, in ARRIVAL ORDER.
///
/// `installSignalHandler` has exactly ONE slot — it assigns `_onSignal`
/// outright — so between joining the room and building the connection, this
/// handler is the only thing routing anything, and whatever it does not keep is
/// gone. The shipped `RealtimeConnectionFactory.make` buffers everything for
/// precisely this reason and replays it after `build`; a handler that only
/// looked for capabilities would drop the OFFER behind them.
///
/// That window is real, not theoretical: a peer whose lane choice comes from
/// this side's announcement can offer within milliseconds of the first hello,
/// and on this wire there is no `linkRequest` to prod it into offering again —
/// a lost offer is a round that sits out its deadline.
let pending = Locked<[(String, JSONValue)]>([])

// Installed BEFORE the room is even joined, so a hello or an offer that arrives
// in the same burst as the roster is kept; superseded by the connection's own
// handler, after which the buffer is replayed into it.
let capsToken = peer.signaling.installSignalHandler { from, data in
    if peerCaps(from: data).contains(TEXT_CAPABILITY) {
        announcedText.lock(); peerAnnouncedText = true; announcedText.unlock()
    }
    pending.mutate {
        // Bounded: a buffer that grew without limit would be a lever a room
        // full of traffic could pull. A conforming peer sends a handful.
        if $0.count < 256 { $0.append((from, data)) } else { observed.set("pendingOverflow", true) }
    }
}

Task {
    guard let peerId = await peer.awaitPeer(named: options.peerName,
                                            timeout: max(1, deadline.timeIntervalSinceNow)) else {
        fail("the Android peer named \(options.peerName) never joined the room")
    }
    observed.set("peerJoined", true)

    // The roster hello `connectInRoom` sends from its `.text` branch, and from
    // nowhere else. One-way and bounded: never a reply to an inbound hello, so
    // two clients cannot greet each other forever.
    @Sendable func advertiseText() async {
        for delay in [0.0, 0.25, 1.0] {
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            peer.signaling.sendSignal(to: peerId, data: capsField([TEXT_CAPABILITY]))
        }
    }

    // **The initiator advertises BEFORE connecting and the responder AFTER**,
    // and the asymmetry is the shipped order rather than a preference.
    //
    // An initiator must not offer a text connection until it has heard exact
    // `text/1` back, so its hellos have to go out first — and nothing can be
    // offered AT it in the meantime, because it is the side that offers.
    //
    // A responder is the opposite: its announcement is what tells the peer to
    // choose this generation and offer, so advertising before the connection
    // exists opens a window in which the answer arrives with only the buffering
    // handler installed. The buffer above would carry it, and closing the
    // window outright is still better than relying on the replay.
    if options.mode == .text {
        if options.role == .initiator {
            await advertiseText()
            // The shipped factory refuses to offer a text connection until it
            // has heard the exact capability back, because an older peer reads
            // a text offer as a file offer and waits for a manifest forever.
            let capsDeadline = Date().addingTimeInterval(5)
            while Date() < capsDeadline {
                announcedText.lock(); let heard = peerAnnouncedText; announcedText.unlock()
                if heard { break }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            announcedText.lock(); let heard = peerAnnouncedText; announcedText.unlock()
            observed.set("peerAnnouncedText", heard)
            if !heard { fail("the Android peer never announced \(TEXT_CAPABILITY)") }
            peer.signaling.sendSignal(to: peerId, data: capsField([TEXT_CAPABILITY]))
        }
    }

    var handlers = PlainPeer.Handlers()
    // The shipped splitter: `onFileChunk` delivers the batch as one
    // undifferentiated stream and the boundaries live in the manifest, which
    // is exactly where an off-by-one hides behind correct names and sizes.
    let received = Locked(BatchAccumulator())
    // Written when `connect` returns and read from callbacks that fire on the
    // connection's own queue. A plain `var` captured by those escaping closures
    // would be a data race on exactly the object they need most.
    let connectionBox = Locked<RealtimeConnection?>(nil)

    // Built BEFORE the connection exists, because the send has to be ARMED on
    // `onOpen` and that callback can fire before `connect` returns.
    //
    // A >192 KiB body (past the logical chunk boundary), a ZERO-byte file in
    // the middle of the stream, and a third entry so the global file sequence
    // advances across a batch. Bytes are derived per file, so a receiver that
    // split the stream one byte off produces the right names and the right
    // sizes with different digests.
    let sends = options.action == "send" || options.action == "send-held"
        || options.action == "send-declined"

    /// **A refusal is the POINT of this round, not the end of it.**
    ///
    /// A decline is a complete in-band exchange that leaves the connection
    /// usable, and the product's claim is exactly that — so the far side has to
    /// still be connected when it checks. Treating the refusal as terminal here
    /// closed the socket while the app was still holding it open to prove it
    /// could, and the app then correctly reported a connection that had ended.
    /// The harness was the thing that ended it.
    ///
    /// So on this action the refusal is only RECORDED, and the round ends on
    /// the peer's own teardown — which arrives when the app has finished its
    /// checks and released the session — or on the outer deadline, which fails
    /// the round rather than passing it on a timeout.
    let declineExpected = options.action == "send-declined"

    /// **Rounds that END with the peer going away.**
    ///
    /// A decline leaves the connection usable and the app then releases it; a
    /// cancel closes it on purpose. Either way the last thing this side sees is
    /// a teardown, and `PlainPeer` has no departure handling at all — it never
    /// sets `SignalingClient.onPeerLeft`, so a peer leaving reaches this
    /// process only as `RealtimeConnection` driving its `RTCPeerConnection` to
    /// `.failed` and reporting `peerConnectionFailed`.
    ///
    /// That is the product's correct behaviour for a LIVE session and the wrong
    /// classification for a round whose endpoint is the peer letting go. So on
    /// these two actions a transport failure is RECORDED rather than fatal —
    /// and it is deliberately not treated as evidence of anything either. What
    /// makes a controlled teardown distinguishable from a premature one is the
    /// APP's own record (it issued the cancel, it moved bytes first, it ended
    /// with no error), and only the comparison holds both halves.
    ///
    /// Every other action keeps an ordinary transport error fatal.
    let teardownExpected = declineExpected || options.action == "send-held"
        || options.action == "expect-reject" || options.action == "expect-close"
    let batch = sends ? legacyBatch(tag: options.name) : []
    // Only the LARGEST entry is held: the small ones ahead of it go out
    // normally, so the receiver reaches real progress before anything stalls.
    let held: [HeldSource] = options.action == "send-held"
        ? batch.filter { $0.bytes.count > 192 * 1024 }
               .map { HeldSource(name: $0.meta.name, bytes: $0.bytes) }
        : []
    if sends {
        // The PATH is reported beside the name and the digest, because it is
        // part of what a receiver has to get right: a receiver that flattened
        // the tree would produce identical names, sizes and digests.
        observed.set("sent", batch.map {
            ["name": $0.meta.name, "path": $0.meta.path as Any, "size": $0.bytes.count,
             "sha256": sha256Hex($0.bytes)]
        })
    }

    handlers.onOpen = { live in
        observed.set("opened", true)
        guard sends else { return }
        // **`onOpen` is the earliest legal moment to send, and there is no
        // second one.** It fires when the channel is open AND the handshake has
        // derived session keys, which is exactly what `streamOnSendQueue` reads
        // — ONCE. It takes `keys?.send` a single time and reports `notReady` if
        // it is nil, and by then `send(sources:metas:)` has already latched
        // `sendStarted`, so a retry would be refused as `alreadySending`. A
        // send armed before this point is therefore not delayed, it is LOST —
        // which is what the SECOND run of this lane actually observed: both
        // halves reached CONNECTED on the negotiated legacy profile and the
        // manifest never arrived. (The first run never connected at all; it
        // matched the peer on an invented name, which is a different defect
        // and proves nothing about this one.)
        //
        // `PlainPeer.send` is what makes calling it from here safe: `send` does
        // a `queue.sync` internally and this callback runs on that very queue,
        // so the helper's hop to a global queue is required, not decorative.
        if options.action == "send-held" {
            // Driven directly rather than through `PlainPeer.send`, because the
            // sources are held rather than plain byte arrays. The hop off this
            // callback's queue is the same one that helper performs, and for
            // the same reason: `send` does a `queue.sync` internally.
            let sources = batch.map { entry -> PlaintextSource in
                held.first { $0.name == entry.meta.name } ?? DataSource(name: entry.meta.name,
                                                                        bytes: entry.bytes)
            }
            let metas = batch.map(\.meta)
            DispatchQueue.global().async { live.send(sources: sources, metas: metas) }
        } else {
            peer.send(batch, on: live)
        }
    }

    handlers.onSAS = { sas in observed.set("sas", sas) }
    handlers.onManifest = { metas in
        observed.set("offered", metas.map { ["name": $0.name, "size": $0.size] })
        received.mutate { $0.expect(metas) }
        if options.action == "expect-reject" || options.action == "expect-close" {
            // Nothing to answer: the Android half is the one exercising the
            // adversarial path, and this side only records what happens to it.
            return
        }
        connectionBox.read { $0 }?.accept()
    }
    handlers.onChunk = { chunk in received.mutate { $0.append(chunk) } }
    handlers.onDone = { ok in
        observed.append("done", ok)
        // COMPLETE only once EVERY declared file has arrived and nothing has
        // arrived past them — the byte is a claim about the whole batch.
        if received.read({ $0.isSatisfied }) {
            observed.set("received", received.read { acc in
                acc.receipts.map {
                    ["name": $0.name, "path": $0.path as Any, "size": $0.size,
                     "sha256": $0.sha256]
                }
            })
            observed.set("trailingBytes", received.read { $0.trailingBytes })
            connectionBox.read { $0 }?.complete()
            finished.signal()
        }
    }
    handlers.onText = { body, _ in
        observed.set("messageIn", sha256Hex(Array(body.utf8)))
        observed.set("messageInBytes", Array(body.utf8).count)
        if let expected = options.expectMessageHex {
            observed.set("messageMatched", body == hexToString(expected))
        }
        finished.signal()
    }
    handlers.onControl = { control in
        observed.append("controls", "\(control)")
        // A SENDER's terminal observation is the receiver's COMPLETE: it is the
        // only byte that says the far side verified the whole batch, and
        // waiting on elapsed time instead would report a stalled round as
        // finished.
        if control == .complete {
            observed.set("peerCompleted", true)
            finished.signal()
        }
        if control == .reject {
            observed.set("rejected", true)
            if !declineExpected { finished.signal() }
        }
    }
    handlers.onError = { error in
        observed.append("errors", "\(error)")
        // **Terminal, and reported now rather than in five minutes.** The
        // shipped sender latches `sendStarted`, so a failed send is never
        // retried; a harness that kept waiting would burn its whole deadline
        // and then report a timeout, which names the symptom and hides the
        // cause.
        //
        // A REFUSAL is excluded on purpose: it is a legitimate outcome the peer
        // chose, and it is the EXPECTED one in the decline round. Whether it
        // was expected HERE is a question for the comparison, which holds both
        // halves' records; this side only records that it happened.
        if let failure = error as? RealtimeConnection.ConnectionError, failure == .rejected {
            observed.set("rejected", true)
            // See `declineExpected`: on the decline round this connection must
            // outlive the refusal, because staying usable IS the claim.
            if declineExpected { return }
        } else if teardownExpected {
            // Recorded, never fatal, and never evidence. See `teardownExpected`.
            observed.set("remoteTeardown", "\(error)")
        } else {
            observed.set("fatal", "\(error)")
        }
        finished.signal()
    }
    handlers.onClose = {
        observed.set("closed", true)
        // The teardown the cancel round is waiting for. Releasing here unblocks
        // the held read so the sender's own loop can unwind instead of sitting
        // out its bounded wait.
        for source in held { source.release() }
        // A close is a terminal observation for every action: for the
        // adversarial rounds it IS the expected outcome, and for the others it
        // ends the wait rather than leaving one running against a dead socket.
        finished.signal()
    }

    let live = peer.connect(to: peerId, role: options.role, mode: options.mode, handlers: handlers)
    connectionBox.mutate { $0 = live }

    // The connection has taken the slot. Handing our token back is a no-op once
    // it has (`removeSignalHandler` clears only if the token still owns it),
    // which is what stops a late release from stranding a live connection.
    peer.signaling.removeSignalHandler(capsToken)
    // Replayed in arrival order, exactly as `RealtimeConnectionFactory.make`
    // drains its own pending list. Nothing is filtered here: the connection's
    // handler already filters by peer and by generation, so a stray hello is a
    // harmless no-op and an offer that beat us is delivered.
    let buffered = pending.read { $0 }
    pending.mutate { $0.removeAll() }
    observed.set("replayedBeforeConnect", buffered.count)
    for (from, data) in buffered { peer.signaling.onSignal?(from, data) }

    if options.mode == .text, options.role == .responder {
        await advertiseText()
    }

    switch options.action {
    case "send":
        // Nothing here. The batch is armed on `onOpen` above, which is the only
        // moment the shipped sender can accept it.
        break
    case "text":
        if options.role == .initiator {
            // The shipped gate: an initiator may neither send nor surface
            // plaintext until it has seen the peer's ACCEPT and its own user
            // has confirmed the SAS.
            live.confirmTextSAS()
        } else {
            live.acceptText()
        }
        if let hex = options.messageHex {
            let body = hexToString(hex)
            // Give the activation exchange time to land; the send refuses with
            // `notReady` before it, which is the gate doing its job.
            // The activation gate refuses with `notReady` until the exchange
            // has landed, which is the gate doing its job — so this retries
            // until the send actually SUCCEEDS or the deadline passes, and
            // records which. A loop that recorded a digest whatever happened
            // would report a message that never entered the channel.
            var sent = false
            var lastFailure: String?
            while !sent, Date() < deadline {
                let done = DispatchSemaphore(value: 0)
                var failure: Error?
                live.sendText(body) { failure = $0; done.signal() }
                if done.wait(timeout: .now() + 10) == .timedOut {
                    lastFailure = "sendText never completed"
                    break
                }
                if let failure {
                    lastFailure = "\(failure)"
                    try? await Task.sleep(nanoseconds: 200_000_000)
                } else {
                    sent = true
                }
            }
            observed.set("messageSent", sent)
            if sent {
                observed.set("messageOut", sha256Hex(Array(body.utf8)))
            } else if let lastFailure {
                observed.append("errors", "message never entered the channel: \(lastFailure)")
            }
        }
    default:
        break
    }
}

// The connection outlives the setup task: it is driven entirely by callbacks,
// and exiting when the task returned would close the socket mid-transfer.
//
// The wait is on an EVENT with a deadline, never on elapsed time alone: the
// batch being satisfied, the peer's message arriving, or the connection
// closing. A timer that expired on its own would report a round as finished
// without anything having happened on the wire.
// Its RESULT is what `complete` reports: a deadline that expired with nothing
// having happened on the wire is a FAILED round, and a harness that reported it
// as finished would hand the comparison a record with no observations in it and
// let the oracle pass on emptiness.
// The parent's marker is a terminator for EVERY action, not only the two that
// need it: a round whose app half has already returned has nothing left to
// wait for, and burning the whole deadline afterwards would turn a fast
// failure into a slow one.
if let marker = options.doneMarker {
    Thread.detachNewThread {
        while !FileManager.default.fileExists(atPath: marker) {
            Thread.sleep(forTimeInterval: 0.25)
        }
        observed.set("peerHalfReturned", true)
        finished.signal()
    }
}

let signalled = finished.wait(timeout: .now() + options.timeout) == .success
// One short settle so a control or a message already in flight is recorded
// rather than raced by the exit.
Thread.sleep(forTimeInterval: 2)

if !signalled {
    observed.append("errors", "no terminal observation within \(Int(options.timeout))s")
}
// A text round additionally has to have got its OWN message onto the wire; the
// peer's message arriving says nothing about this side's send.
let sentIfRequired = options.action != "text" || options.messageHex == nil
    || observed.bool("messageSent")
if !sentIfRequired {
    observed.append("errors", "this side\'s message never entered the channel")
}
// The decline round has one more thing to have actually happened: the refusal
// itself. Without it the round ended for some other reason and proves nothing
// about declining.
// **What this round actually had to observe**, per action, rather than "the
// wait ended". A terminator can fire for a reason that has nothing to do with
// the objective — the parent's marker fires on a FAILED app half too — so
// completion is the objective, and the wait is only what stops it hanging.
let objectiveMet: Bool
switch options.action {
case "send":          objectiveMet = observed.bool("peerCompleted")
case "send-declined": objectiveMet = observed.bool("rejected")
// A cancel cuts the batch off, so there is no COMPLETE and no full receipt —
// and there is no single frame that is guaranteed to arrive either.
//
// The shipped lane queues its `0xff` and then closes the channel and DISPOSES
// the peer connection in the same turn. Ordering is a guarantee about frames
// that are delivered, not a promise that a queued one drains before the
// transport goes away, so requiring the refusal would be requiring luck.
// Requiring the teardown instead races the parent's marker. Either observation
// is real evidence that the peer acted; NEITHER is guaranteed, so this side
// accepts whichever it got.
//
// And neither one distinguishes a user's cancel from a peer dying underneath
// it. That is not decidable here at all — the app's own record settles it, in
// the comparison.
case "send-held", "expect-reject", "expect-close":
    objectiveMet = observed.bool("rejected") || observed.bool("closed")
        || observed.has("remoteTeardown")
case "receive":       objectiveMet = observed.has("received")
case "text":          objectiveMet = observed.has("messageIn") && observed.bool("messageSent")
default:              objectiveMet = signalled
}
if !objectiveMet {
    observed.append("errors", "the round never observed what it exists to observe")
}
// A fatal transport error is terminal whatever else was observed: a round that
// recorded `notReady` and then happened to see a close is not a round that
// worked.
let ok = objectiveMet && sentIfRequired && !observed.has("fatal")
observed.set("complete", ok)
observed.write(to: options.reportPath)
peer.close()
exit(ok ? 0 : 1)
APPLEPEEREOF
}

build_apple_peer
require_emulator

say "== installing =="
adbs install -r -t "$app_apk" >/dev/null || fail "could not install the app"
adbs install -r -t "$test_apk" >/dev/null || fail "could not install the instrumentation"

# ── one unchanged backend per round ─────────────────────────────────────────
#
# The server's per-IP join budget is PRODUCTION (`wsJoinPerIPPerMinute` is 5)
# and one round spends two joins from this one loopback address, so a run that
# shared a backend across ten rounds would have to sleep out the window between
# each — and a refusal, when it came, would read exactly like the protocol
# disagreement this run exists to detect. It would also make every round share
# one account and one registration budget.
#
# So each round gets its own server process, its own database, its own blob
# directory, its own account and its own log, in its own child directory under
# the run root. The BINARY is built once. Cleanup is PID-exact and every round's
# log is preserved beside the report it explains.
round_dir=""
round_server_pid=""

start_round_backend() {
  round_dir="$run_root/round-$round"
  mkdir -p "$round_dir/blobs" "$round_dir/no-static"
  server_port="$(free_port)"
  origin="http://127.0.0.1:$server_port"

  RELAYIUM_RELEASE_CHECK=false \
    "$run_root/relayium-server" \
      -addr "127.0.0.1:$server_port" \
      -db "$round_dir/relayium.db" \
      -blob-dir "$round_dir/blobs" \
      -static "$round_dir/no-static" \
      -stun-urls "$loopback_stun" \
      -mail-transport dev-log-links \
      >"$round_dir/server.log" 2>&1 &
  round_server_pid=$!
  register_child "server-$round" "$round_server_pid"

  local _
  for _ in $(seq 1 100); do
    curl -sf --max-time 5 "$origin/api/config" >/dev/null 2>&1 && break
    kill -0 "$round_server_pid" 2>/dev/null \
      || fail "the round-$round server exited before it was reachable"
    sleep 0.2
  done
  curl -sf --max-time 5 "$origin/api/config" >/dev/null 2>&1 \
    || fail "the round-$round server never became reachable"
  # Made against the SERVER, not against the string this script passed around: a
  # listener on any address but loopback would mean the run was reachable from
  # the network.
  grep -m1 'listening on' "$round_dir/server.log" | grep -q "127.0.0.1:$server_port" \
    || fail "the round-$round server is not listening on loopback"

  round_account
}

# One fresh account per round, through the product's own HTTP API. Passwords and
# bodies live in 0600 files under the round directory and never in argv, because
# `ps` is readable by every process on a CI runner.
round_account() {
  umask 077
  account_email="legacy-${run_tag}-r${round}@example.invalid"
  account_password="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
  printf '{"email":"%s","password":"%s"}' "$account_email" "$account_password" \
    >"$round_dir/register.json"
  curl -sf --max-time 20 -X POST "$origin/api/auth/register" \
    -H 'Content-Type: application/json' --data-binary "@$round_dir/register.json" >/dev/null \
    || fail "could not register the round-$round account"

  # `-mail-transport dev-log-links` logs the verification link instead of
  # sending one; reading it is the local equivalent of the user clicking it.
  # `grep -m1` rather than `grep | head`: under `pipefail` the head closing the
  # pipe can take grep down with SIGPIPE and turn a working read intermittent.
  local verify_token
  verify_token="$(grep -o -m1 'verify-email?token=[0-9a-f]*' "$round_dir/server.log" | cut -d= -f2)"
  [ -n "$verify_token" ] || fail "the round-$round server logged no verification token"
  # The password is CONFIRMED in this call; a registration password that is not
  # makes every later login a 401 that looks like a bad credential.
  printf '{"token":"%s","password":"%s"}' "$verify_token" "$account_password" \
    >"$round_dir/verify.json"
  curl -sf --max-time 20 -X POST "$origin/api/auth/email/verify" \
    -H 'Content-Type: application/json' --data-binary "@$round_dir/verify.json" >/dev/null \
    || fail "could not verify the round-$round account"

  printf '{"email":"%s","password":"%s","deviceName":"legacy-acceptance"}' \
    "$account_email" "$account_password" >"$round_dir/login.json"
  curl -sf --max-time 20 -X POST "$origin/api/auth/native/login" \
    -H 'Content-Type: application/json' --data-binary "@$round_dir/login.json" \
    -o "$round_dir/session.json" \
    || fail "could not sign the round-$round account in"
  account_token="$(python3 -c '
import json, sys
print(json.load(open(sys.argv[1])).get("token", ""))' "$round_dir/session.json")"
  [ -n "$account_token" ] || fail "the round-$round login answered no bearer token"
  printf 'header = "Authorization: Bearer %s"\n' "$account_token" >"$round_dir/auth.conf"

  # The emulator reaches the host's loopback as 10.0.2.2. The app's own
  # `Backend.resolve` PARSES this and accepts only an exact local origin; the
  # instrumentation asserts the resolved value before it joins anything.
  emulator_origin="http://10.0.2.2:$server_port"
  adbs shell setprop debug.relayium.backend "$emulator_origin" \
    || fail "could not point the app at $emulator_origin"
  [ "$(adbs shell getprop debug.relayium.backend | tr -d '\r')" = "$emulator_origin" ] \
    || fail "the backend property did not take"
}

# PID-exact, and only this round's child. The log stays.
stop_round_backend() {
  [ -n "$round_server_pid" ] || return 0
  kill "$round_server_pid" 2>/dev/null || true
  wait "$round_server_pid" 2>/dev/null || true
  round_server_pid=""
}

mint_code() {
  local body
  body="$(curl -sf --max-time 20 -X POST "$origin/api/pair" \
            --config "$round_dir/auth.conf" -H 'Content-Type: application/json' -d '{}')" \
    || return 1
  printf '%s' "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("code",""))'
}

# The oracle must be able to FAIL. Run before any round, so a comparison that
# had been reduced to a no-op is caught here rather than by passing ten rounds.
say "== proving the oracle rejects what it must =="
python3 "$repo/scripts/test/android-apple-legacy-oracle.py" --self-test \
  || fail "the comparison oracle does not reject mutated, missing or unfinished records"

# The app writes its report into its own INTERNAL files directory; `run-as` is
# the only way back out (`/sdcard/Android/data/<pkg>/files` is EACCES on this
# API level even for the owning uid).
pull_report() {
  local device_name="$1" out="$2"
  adbs exec-out run-as "$app_id" cat "files/$device_name" >"$out" 2>/dev/null || return 1
  [ -s "$out" ] || return 1
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$out" >/dev/null 2>&1 || return 1
  return 0
}

# **Require the field's actual SHAPE, never merely non-empty output.**
# Before the report exists, `run-as`'s own missing-file diagnostic arrives on
# stdout despite a local stderr redirect. `pull_report` already refuses
# anything that is not JSON, and this refuses anything that is JSON but does
# not yet carry the field — a watcher that accepted either would hand a
# diagnostic string to the Apple half and read the resulting silence as a
# protocol disagreement.
await_report_field() {
  local device_file="$1" out="$2" field="$3" pattern="$4"
  local deadline=$(( SECONDS + 180 )) value
  while [ "$SECONDS" -lt "$deadline" ]; do
    if pull_report "$device_file" "$out"; then
      value="$(python3 -c '
import json,sys
print(json.load(open(sys.argv[1])).get(sys.argv[2]) or "")' "$out" "$field")"
      if printf '%s' "$value" | grep -qE "$pattern"; then
        printf '%s' "$value"
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

json_of() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$1" "$2"; }

round=0
rounds_passed=0
seen_minter=0
seen_joiner=0
seen_files=0
seen_text=0

# ── one round ───────────────────────────────────────────────────────────────
#
# `intent` is the ANDROID side's: `minter` means the app creates the code and
# therefore offers, `joiner` means it types one in and answers. The Apple half
# takes the complementary role, and the two are never both offerers.
run_round() {
  local intent="$1" mode="$2" direction="$3" adversarial="${4:-}"
  round=$((round + 1))
  local label="round $round: android=$intent $mode/$direction${adversarial:+ [$adversarial]}"
  say "== $label =="

  start_round_backend

  # App data survives a reinstall, so a previous round's disposable tree would
  # otherwise still be there. `pm clear` before `am instrument`, never during:
  # the backend override is a system property and is unaffected.
  adbs shell pm clear "$app_id" >/dev/null 2>&1 \
    || fail "could not reset the app's data before $label"

  # Written the moment the app half returns. It is what tells the Apple half
  # that the round is over for rounds whose endpoint is the peer finishing and
  # letting go — a refusal arrives long before the app has checked anything, and
  # the RTC teardown after it is the app being torn down, not the round passing.
  local done_marker="$round_dir/instrument-done.marker"
  rm -f "$done_marker"
  local device_out="legacy-$round.json"
  local android_out="$run_root/android-$round.json"
  local apple_out="$run_root/apple-$round.json"
  local apple_role apple_action code=""

  if [ "$intent" = "minter" ]; then
    apple_role=responder
  else
    apple_role=initiator
    code="$(mint_code)" || fail "could not mint a pairing code for $label"
    printf '%s' "$code" | grep -qE '^[0-9]{6}$' || fail "the server did not return a six-digit code"
  fi

  case "$mode:$direction:$adversarial" in
    text:*:refuse-text) apple_action=expect-reject ;;
    text:*:*)           apple_action=text ;;
    file:receive:*)     apple_action=send ;;
    file:send:*)        apple_action=receive ;;
    *) fail "no Apple action for $mode/$direction" ;;
  esac
  # A decline must leave the connection usable, so the Apple half records the
  # refusal and keeps the socket open until the app has finished checking and
  # tears it down itself. See `declineExpected`.
  if [ "$adversarial" = "decline" ]; then apple_action=send-declined; fi
  # The cancel round holds its largest source after the first chunk, so the
  # cancel lands while a transfer is genuinely in flight rather than whenever a
  # 199 KiB batch happens to finish relative to a 50 ms poll. See `HeldSource`.
  if [ "$adversarial" = "cancel" ]; then apple_action=send-held; fi

  local instrument_args=(
    -e class com.relayium.android.LegacyInteropAcceptanceTest
    -e origin "$emulator_origin"
    -e intent "$intent"
    -e mode "$mode"
    -e direction "$direction"
    -e report "$device_out"
    -e message_out_hex "$android_message_hex"
    -e message_in_hex "$apple_message_hex"
  )
  [ -n "$adversarial" ] && instrument_args+=(-e adversarial "$adversarial")
  if [ "$intent" = "minter" ]; then
    instrument_args+=(-e account_email "$account_email" -e account_password "$account_password")
  else
    instrument_args+=(-e code "$code")
  fi

  local instrument_log="$run_root/instrument-$round.log"
  local apple_log="$run_root/apple-$round.log"
  local instrument_pid apple_pid instrument_status apple_status

  # The two halves are started in the order the ROOM requires. A minter's code
  # does not exist until the app has minted one, so the Android half goes first
  # and the Apple half waits on the code it publishes; a joiner's code came
  # from the server, so the Apple half may offer immediately.
  set +e
  adbs shell am instrument -w -r "${instrument_args[@]}" \
    "$test_pkg/$runner" >"$instrument_log" 2>&1 &
  instrument_pid=$!
  set -e
  # Registered IMMEDIATELY after `$!` and before anything that can fail. Both
  # background halves outlive this function on a `fail`, an INT or a hung
  # round, and `fail` never returns — so a registration deferred until after
  # the wait would be a registration that never happens on exactly the paths
  # that need it. This is also what makes the cleanup test able to prove they
  # did not survive: `register_child` emits the machine-readable line it reads.
  register_child "instrument-$round" "$instrument_pid"

  # The name the app ACTUALLY announces, read off the live ViewModel and
  # published before it joins anything. The Apple half matches on it exactly —
  # never on "the first other peer", which is a heuristic that is only ever
  # right by luck and hides the case where the app never joined at all.
  local android_name
  android_name="$(await_report_field "$device_out" "$android_out" deviceName '.')" \
    || { kill "$instrument_pid" 2>/dev/null || true
         fail "the app never published the name it announces: $(tail -20 "$instrument_log")"; }
  say "-- the app announces itself as \"$android_name\""

  if [ "$intent" = "minter" ]; then
    code="$(await_report_field "$device_out" "$android_out" mintedCode '^[0-9]{6}$')" \
      || { kill "$instrument_pid" 2>/dev/null || true
           fail "the app never published a six-digit code it minted: $(tail -20 "$instrument_log")"; }
    say "-- the app minted its own code and is offering on it"
  fi

  set +e
  "$apple_peer_bin" \
    --origin "$origin" --code "$code" \
    --name "$apple_peer_name" --peer "$android_name" \
    --role "$apple_role" --mode "$mode" --action "$apple_action" \
    --message-hex "$apple_message_hex" --expect-message-hex "$android_message_hex" \
    --report "$apple_out" --timeout 300 --done-marker "$done_marker" >"$apple_log" 2>&1 &
  apple_pid=$!
  register_child "apple-peer-$round" "$apple_pid"

  wait "$instrument_pid"; instrument_status=$?
  # BEFORE the status checks and unconditionally: a failed app half must release
  # the Apple half too, or a fast failure becomes a five-minute one.
  : >"$done_marker"
  wait "$apple_pid"; apple_status=$?
  set -e

  # FOUR independent conditions on the Android half, because each one alone has
  # a way of being true over a failed round: `adb`'s own exit (a transport
  # error never reaches the log), `INSTRUMENTATION_CODE: -1` (the harness ran to
  # completion), no per-test FAILURE/ERROR status (which -1 does NOT
  # distinguish), and the report's own `complete` flag, written last.
  [ "$instrument_status" -eq 0 ] \
    || fail "adb could not run the Android half of $label (exit $instrument_status): $(tail -20 "$instrument_log")"
  grep -q '^INSTRUMENTATION_CODE: -1$' "$instrument_log" \
    || fail "the Android half of $label did not run to completion: $(tail -40 "$instrument_log")"
  if grep -qE '^INSTRUMENTATION_STATUS_CODE: (-1|-2)$' "$instrument_log"; then
    fail "the Android half of $label FAILED: $(sed -n '/INSTRUMENTATION_STATUS: stack=/,/^INSTRUMENTATION_STATUS_CODE/p' "$instrument_log" | head -40)"
  fi
  [ "$apple_status" -eq 0 ] \
    || fail "the Apple half of $label failed (exit $apple_status): $(tail -40 "$apple_log")"

  pull_report "$device_out" "$android_out" \
    || fail "the Android half of $label wrote no readable observation"
  [ -f "$apple_out" ] || fail "the Apple half of $label wrote no observation"
  [ "$(json_of "$android_out" complete)" = "True" ] \
    || fail "the Android half of $label did not finish its round"
  [ "$(json_of "$apple_out" complete)" = "True" ] \
    || fail "the Apple half of $label did not finish its round"

  # The comparison is made by NEITHER half.
  python3 "$repo/scripts/test/android-apple-legacy-oracle.py" \
    "$android_out" "$apple_out" "$intent" "$mode" "$direction" "$adversarial" \
    || fail "$label did not agree"

  stop_round_backend
  case "$intent" in minter) seen_minter=1 ;; joiner) seen_joiner=1 ;; esac
  case "$mode" in file) seen_files=1 ;; text) seen_text=1 ;; esac
  rounds_passed=$((rounds_passed + 1))
  adbs shell am force-stop "$app_id" >/dev/null 2>&1 || true
  say "-- $label passed"
}

# Both roles × both generations × both byte directions, then the paths that
# differ from `link/1`, then the reconnect that shows the product still works
# after the one that closes a connection on purpose.
run_round joiner file receive
run_round joiner file send
run_round minter file receive
run_round minter file send
run_round joiner text both
run_round minter text both
run_round joiner file receive decline
run_round joiner file receive cancel
run_round joiner text both refuse-text
# A FRESH session after the round that closed one on purpose — a new backend, a
# new code and a new connection. It shows the product is still usable after a
# cancel; it is NOT a claim about one app instance surviving one, because
# `pm clear` resets the app between rounds. The same-controller continuity is
# covered by the JVM regressions, which drive one live controller across the
# whole failure.
run_round joiner file receive

[ "$seen_minter" = 1 ] || fail "no round exercised the app as the CREATOR of the code"
[ "$seen_joiner" = 1 ] || fail "no round exercised the app as the JOINER"
[ "$seen_files" = 1 ] || fail "no round exercised the file generation"
[ "$seen_text" = 1 ] || fail "no round exercised the message generation"

say ""
say "== $rounds_passed rounds passed against the shipped Apple transport =="
say "-- both roles, both generations, both byte directions, three adversarial"
say "   paths and a fresh session after the one that closes a connection"
say "-- the Apple half was the shipped RealtimeConnection compiled on this host,"
say "   NOT an iOS binary and NOT a device; module hashes in"
say "   $run_root/apple-peer-module-hashes.txt"

# The PASS line, and the last statement in the file. `scripts/lib/local-acceptance.sh`
# treats a zero exit that never reached this marker as a FAILURE, precisely so a
# run that fell out of the middle — a `return` from a helper, an early `exit 0`,
# an interrupt Bash could not deliver to a trap while waiting on a child —
# cannot be mistaken for a pass. Omitting it is how ten passing rounds reported
# exit 1.
completed=1
