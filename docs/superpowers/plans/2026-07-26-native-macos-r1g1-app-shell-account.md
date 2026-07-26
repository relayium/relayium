# Native macOS R1-G1 — app shell + account — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the two-file "core ready" macOS shell into a real app a person can sign into, that remembers them, and that shows their plan and usage.

**Architecture:** A new `RelayiumAppKit` target inside the existing `apps/RelayiumKit` package holds the `@MainActor` view-model layer (no SwiftUI import), so `swift test` covers it and R3's iOS app can reuse it. `apps/mac/Relayium/` keeps only SwiftUI views. `RelayiumAppKit` is vended through the **existing** `RelayiumKit` library product — a SwiftPM library product may contain several targets — so the Xcode app target links it with no `project.pbxproj` change.

**Tech Stack:** Swift 5.9 (SwiftPM, `swift-tools-version:5.9`), SwiftUI (macOS 13+), XCTest, `StubURLProtocol` for HTTP stubbing, Keychain via the Kit's `KeychainTokenStore`.

## Global Constraints

- Platform floor: `.macOS(.v13)`, `.iOS(.v16)`. `MACOSX_DEPLOYMENT_TARGET = 13.0`.
- Swift 5 language mode. The Kit has **no** `Sendable`/`@MainActor`/`actor` anywhere; do not add strict concurrency to make this round compile.
- `RelayiumAppKit` must **never** `import SwiftUI` — that is what keeps it testable and iOS-reusable.
- No new third-party dependencies.
- `KeychainTokenStore.load()` is synchronous and blocking, and may raise a system prompt: it runs off the main actor, never in `View.body` or an initializer.
- `Meter.cap == 0` means **unlimited**, not zero. No ratio is computed without checking first.
- `AccountError.invalidCredentials` from `fetchMe` is the **only** signal a stored token is bad. It clears the keychain and routes to logged-out; it is a normal transition, not a displayed error.
- No Kit error implements `LocalizedError`; every user-facing string comes from `ErrorCopy`.
- Commit messages: conventional style (`feat(native): …`, `test(native): …`), sign off with `git commit -s`.
- Bundle id stays `com.relayium.mac`; `DEVELOPMENT_TEAM` stays empty (Team ID arrives in G4/G5).

**Deliberate refinement vs the spec:** the spec listed `AppState.swift` and `AccountSession.swift` as separate files. Routing *is* the session state, so they merge into `AccountSession` (which gains a `.restoring` case) plus a small `AppEnvironment` for wiring. One state machine, one source of truth.

---

### Task 1: `RelayiumAppKit` target + `ErrorCopy`

**Files:**
- Modify: `apps/RelayiumKit/Package.swift`
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/ErrorCopy.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/ErrorCopyTests.swift`

**Interfaces:**
- Consumes: `AccountError`, `KeychainError` from `RelayiumKit`.
- Produces: `public enum ErrorCopy { public static func message(for error: Error) -> String }`

- [ ] **Step 1: Add the target to `Package.swift`**

Change the `products:` line and add the target. The product gains a second target rather than becoming a second product — that is what avoids touching `project.pbxproj`.

```swift
    products: [.library(name: "RelayiumKit", targets: ["RelayiumKit", "RelayiumAppKit"])],
```

Add after the `RelayiumKit` target:

```swift
        // @MainActor view-model layer for the native apps. Imports RelayiumKit and
        // Foundation, never SwiftUI — that is what keeps it unit-testable under
        // `swift test` and reusable by the iOS app in R3.
        .target(name: "RelayiumAppKit", dependencies: ["RelayiumKit"]),
```

And add it to the test target's dependencies:

```swift
        .testTarget(
            name: "RelayiumKitTests",
            dependencies: ["RelayiumKit", "RelayiumAppKit"],
            path: "Tests",
            resources: [.process("Fixtures")]
        ),
```

- [ ] **Step 2: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/ErrorCopyTests.swift`:

```swift
import XCTest
import RelayiumKit
@testable import RelayiumAppKit

private struct UnknownFailure: Error {}

final class ErrorCopyTests: XCTestCase {
    func testAccountErrorsAllMapToNonEmptyText() {
        let cases: [AccountError] = [
            .invalidCredentials, .rateLimited, .server(status: 503), .decoding, .network,
        ]
        for e in cases {
            XCTAssertFalse(ErrorCopy.message(for: e).isEmpty, "no copy for \(e)")
        }
    }
    func testServerErrorNamesTheStatus() {
        XCTAssertTrue(ErrorCopy.message(for: AccountError.server(status: 503)).contains("503"))
    }
    func testInvalidCredentialsTalksAboutEmailAndPassword() {
        let m = ErrorCopy.message(for: AccountError.invalidCredentials).lowercased()
        XCTAssertTrue(m.contains("email") && m.contains("password"))
    }
    func testKeychainErrorNamesTheStatusCode() {
        XCTAssertTrue(ErrorCopy.message(for: KeychainError.status(-25300)).contains("-25300"))
    }
    // The realtime rounds route ConnectionError, HandshakeError, RealtimeError and bare
    // WebRTC NSErrors through one ((Error) -> Void). The fallback must already be total.
    func testUnknownErrorStillProducesActionableText() {
        let m = ErrorCopy.message(for: UnknownFailure())
        XCTAssertFalse(m.isEmpty)
        XCTAssertTrue(m.contains("UnknownFailure"), "fallback should name the type for a bug report")
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/RelayiumKit && swift test --filter ErrorCopyTests`
Expected: FAIL — `no such module 'RelayiumAppKit'` or `cannot find 'ErrorCopy' in scope`.

- [ ] **Step 4: Write the implementation**

Create `apps/RelayiumKit/Sources/RelayiumAppKit/ErrorCopy.swift`:

```swift
import Foundation
import RelayiumKit

/// Every user-facing error string in the native apps.
///
/// No error type in RelayiumKit implements `LocalizedError`, so
/// `localizedDescription` on any of them is a useless type name. This is not a
/// polish layer — without it the UI has nothing to show.
///
/// The shape matters as much as the contents: G3 will route `ConnectionError`,
/// `HandshakeError`, `RealtimeError`, `RealtimeSenderError` and bare WebRTC
/// `NSError`s through a single `((Error) -> Void)` callback. Extending a layered
/// chain that already has a total fallback beats inventing one under pressure.
public enum ErrorCopy {
    public static func message(for error: Error) -> String {
        if let e = error as? AccountError {
            switch e {
            case .invalidCredentials:
                return "That email and password don't match an account."
            case .rateLimited:
                return "Too many attempts. Wait a minute, then try again."
            case .server(let status):
                return "The server returned an error (\(status)). Try again shortly."
            case .decoding:
                return "The server sent a response this version of the app doesn't understand. Updating may fix it."
            case .network:
                return "Couldn't reach the server. Check your internet connection."
            }
        }
        if let e = error as? KeychainError {
            switch e {
            case .status(let s):
                return "macOS wouldn't store your sign-in (keychain error \(s)). You'll stay signed in until you quit."
            }
        }
        // Total by construction: name the type so a bug report is actionable.
        return "Something went wrong (\(type(of: error)))."
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/RelayiumKit && swift test --filter ErrorCopyTests`
Expected: PASS, 5 tests.

- [ ] **Step 6: Run the whole suite to prove nothing regressed**

Run: `cd apps/RelayiumKit && swift test 2>&1 | tail -5`
Expected: 105 tests, 1 skip (`KeychainTokenStore` under the SPM host), 0 failures.

- [ ] **Step 7: Commit**

```bash
git add apps/RelayiumKit/Package.swift \
        apps/RelayiumKit/Sources/RelayiumAppKit/ErrorCopy.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/ErrorCopyTests.swift
git commit -s -m "feat(native): add RelayiumAppKit target with the error copy layer"
```

---

### Task 2: `UsagePresentation`

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/UsagePresentation.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/UsagePresentationTests.swift`

**Interfaces:**
- Consumes: `Meter` from `RelayiumKit` (`used: Int64`, `cap: Int64`, `isUnlimited: Bool`).
- Produces:
  - `public struct MeterDisplay: Equatable { public let usedText: String; public let capText: String; public let fraction: Double?; public let isUnlimited: Bool }`
  - `public enum UsagePresentation { public static func display(_ m: Meter) -> MeterDisplay; public static func bytesText(_ n: Int64) -> String; public static func resetText(resetsAt: Int64, now: Date) -> String }`

- [ ] **Step 1: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/UsagePresentationTests.swift`:

```swift
import XCTest
// @testable, not a plain import: `Meter`'s memberwise initializer is internal (the
// struct is public but declares no explicit `init`), so constructing one in a test
// needs testable access. Production code in RelayiumAppKit only *reads* Meter, which
// a plain import allows.
@testable import RelayiumKit
@testable import RelayiumAppKit

final class UsagePresentationTests: XCTestCase {
    // cap == 0 means unlimited. A bar that divides by cap breaks on exactly the
    // plans that matter most.
    func testUnlimitedMeterHasNoFraction() {
        let d = UsagePresentation.display(Meter(used: 2_097_152, cap: 0))
        XCTAssertTrue(d.isUnlimited)
        XCTAssertNil(d.fraction)
        XCTAssertEqual(d.capText, "Unlimited")
        XCTAssertEqual(d.usedText, "2.0 MB")
    }
    func testCappedMeterComputesFraction() {
        let d = UsagePresentation.display(Meter(used: 1_073_741_824, cap: 5_368_709_120))
        XCTAssertFalse(d.isUnlimited)
        XCTAssertEqual(d.fraction!, 0.2, accuracy: 0.0001)
        XCTAssertEqual(d.capText, "5.0 GB")
    }
    // Over-quota is a real server state; the bar must not exceed full.
    func testOverQuotaClampsToOne() {
        let d = UsagePresentation.display(Meter(used: 20, cap: 10))
        XCTAssertEqual(d.fraction!, 1.0, accuracy: 0.0001)
    }
    func testZeroUsedOnUnlimitedIsStillUnlimited() {
        let d = UsagePresentation.display(Meter(used: 0, cap: 0))
        XCTAssertTrue(d.isUnlimited)
        XCTAssertEqual(d.usedText, "0 B")
    }
    func testBytesTextUsesBinaryUnitsAndIsLocaleIndependent() {
        XCTAssertEqual(UsagePresentation.bytesText(0), "0 B")
        XCTAssertEqual(UsagePresentation.bytesText(512), "512 B")
        XCTAssertEqual(UsagePresentation.bytesText(1024), "1.0 KB")
        XCTAssertEqual(UsagePresentation.bytesText(1_048_576), "1.0 MB")
        XCTAssertEqual(UsagePresentation.bytesText(10_737_418_240), "10.0 GB")
    }
    // Days-remaining rather than a formatted date: no locale dependence, so the
    // assertion is stable on any machine and in CI.
    func testResetTextCountsWholeDays() {
        let now = Date(timeIntervalSince1970: 1_780_000_000)
        XCTAssertEqual(UsagePresentation.resetText(resetsAt: 1_780_000_000 + 5 * 86_400, now: now),
                       "Resets in 5 days")
        XCTAssertEqual(UsagePresentation.resetText(resetsAt: 1_780_000_000 + 86_400, now: now),
                       "Resets in 1 day")
        XCTAssertEqual(UsagePresentation.resetText(resetsAt: 1_780_000_000 + 3_600, now: now),
                       "Resets today")
    }
    func testResetTextInThePastReadsAsToday() {
        let now = Date(timeIntervalSince1970: 1_780_000_000)
        XCTAssertEqual(UsagePresentation.resetText(resetsAt: 1_779_000_000, now: now), "Resets today")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/RelayiumKit && swift test --filter UsagePresentationTests`
Expected: FAIL — `cannot find 'UsagePresentation' in scope`.

- [ ] **Step 3: Write the implementation**

Create `apps/RelayiumKit/Sources/RelayiumAppKit/UsagePresentation.swift`:

```swift
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/RelayiumKit && swift test --filter UsagePresentationTests`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumAppKit/UsagePresentation.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/UsagePresentationTests.swift
git commit -s -m "feat(native): render usage meters, treating cap == 0 as unlimited"
```

---

### Task 3: `AccountSession` — login, the three outcomes, and the 401 path

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/AccountSession.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/AccountSessionTests.swift`

**Interfaces:**
- Consumes: `AccountClient(baseURL:session:)`, `TokenStore`, `InMemoryTokenStore`, `LoginOutcome`, `NativeUser`, `UsageResponse`, `AccountError` from `RelayiumKit`; `ErrorCopy` from Task 1.
- Produces:
  - `public enum SessionState: Equatable { case restoring, loggedOut, authenticating, emailUnverified(email: String), pendingDeletion(purgeAfter: Int64, reactivateToken: String), ready(user: NativeUser, usage: UsageResponse), failed(message: String), unavailable(message: String) }`
  - `.failed` is *a sign-in attempt was rejected* → show the form again with the reason. `.unavailable` is *we hold a token but couldn't load the account* → offer retry. Collapsing the two would drop a user with a perfectly good token onto a sign-in form that cannot help them.
  - `@MainActor public final class AccountSession: ObservableObject` with `@Published public private(set) var state: SessionState`, `@Published public private(set) var isStale: Bool`, `public init(client: AccountClient, tokenStore: TokenStore, deviceName: String)`, `public func restore() async`, `public func logIn(email: String, password: String) async`, `public func refresh() async`, `public func logOut()`.

- [ ] **Step 1: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/AccountSessionTests.swift`:

```swift
import XCTest
import RelayiumKit
@testable import RelayiumAppKit

@MainActor
final class AccountSessionTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: Bundle.module.url(forResource: name, withExtension: "json")!)
    }
    private func session(store: TokenStore) -> AccountSession {
        AccountSession(
            client: AccountClient(baseURL: URL(string: "https://relayium.test")!,
                                  session: StubURLProtocol.session()),
            tokenStore: store,
            deviceName: "Test Mac"
        )
    }
    override func tearDown() {
        StubURLProtocol.stub = nil
        StubURLProtocol.router = nil
        StubURLProtocol.lastRequest = nil
    }

    /// Routes /api/me and /api/me/usage to their fixtures, everything else to login.
    private func routeLoggedIn(loginBody: Data) throws {
        let me = try fixture("me"), usage = try fixture("me-usage")
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/me":       return .init(status: 200, body: me)
            case "/api/me/usage": return .init(status: 200, body: usage)
            default:              return .init(status: 200, body: loginBody)
            }
        }
    }

    func testEmptyStoreGoesToLoggedOutWithoutANetworkCall() async {
        let s = session(store: InMemoryTokenStore())
        StubURLProtocol.router = { _ in XCTFail("must not call the network"); return .init(status: 500) }
        await s.restore()
        XCTAssertEqual(s.state, .loggedOut)
        XCTAssertNil(StubURLProtocol.lastRequest)
    }

    func testSuccessfulLoginSavesTokenAndLandsReady() async throws {
        let store = InMemoryTokenStore()
        try routeLoggedIn(loginBody: try fixture("login-success"))
        let s = session(store: store)
        await s.logIn(email: "a@b.co", password: "pw")
        guard case let .ready(user, usage) = s.state else { return XCTFail("want ready, got \(s.state)") }
        XCTAssertEqual(user.planId, "pro")          // from /api/me — NOT from the login body
        XCTAssertEqual(usage.plan.name, "Pro")
        XCTAssertEqual(try store.load(), "rlm_cli_TESTTOKEN")
    }

    // 200 does not mean signed in. These two are the other halves of that.
    func testEmailUnverifiedIsItsOwnState() async throws {
        StubURLProtocol.stub = .init(status: 403, body: try fixture("login-unverified"))
        let s = session(store: InMemoryTokenStore())
        await s.logIn(email: "a@b.co", password: "pw")
        XCTAssertEqual(s.state, .emailUnverified(email: "a@b.co"))
    }
    func testPendingDeletionIsItsOwnState() async throws {
        StubURLProtocol.stub = .init(status: 200, body: try fixture("login-pending-deletion"))
        let s = session(store: InMemoryTokenStore())
        await s.logIn(email: "a@b.co", password: "pw")
        XCTAssertEqual(s.state, .pendingDeletion(purgeAfter: 1_780_000_000, reactivateToken: "react_abc"))
    }
    func testPendingDeletionStoresNoToken() async throws {
        let store = InMemoryTokenStore()
        StubURLProtocol.stub = .init(status: 200, body: try fixture("login-pending-deletion"))
        await session(store: store).logIn(email: "a@b.co", password: "pw")
        XCTAssertNil(try store.load())
    }

    func testBadCredentialsSurfaceCopyNotATypeName() async {
        StubURLProtocol.stub = .init(status: 401, body: Data(#"{"error":"nope"}"#.utf8))
        let s = session(store: InMemoryTokenStore())
        await s.logIn(email: "a@b.co", password: "wrong")
        guard case let .failed(message) = s.state else { return XCTFail("want failed, got \(s.state)") }
        XCTAssertEqual(message, ErrorCopy.message(for: AccountError.invalidCredentials))
    }

    // The only signal a stored token has gone bad.
    func testStaleTokenIsClearedAndRoutesToLoggedOut() async throws {
        let store = InMemoryTokenStore()
        try store.save("rlm_cli_STALE")
        StubURLProtocol.router = { _ in .init(status: 401, body: Data("unauthorized".utf8)) }
        let s = session(store: store)
        await s.restore()
        XCTAssertEqual(s.state, .loggedOut)
        XCTAssertNil(try store.load(), "a 401 must clear the keychain")
    }

    func testRestoreWithGoodTokenLandsReady() async throws {
        let store = InMemoryTokenStore()
        try store.save("rlm_cli_TESTTOKEN")
        try routeLoggedIn(loginBody: Data())
        let s = session(store: store)
        await s.restore()
        guard case .ready = s.state else { return XCTFail("want ready, got \(s.state)") }
    }

    // A network blip must not blank a working screen, and must not bounce the user
    // to a login form that would not help.
    func testNetworkFailureDuringRefreshKeepsLastGoodAndMarksStale() async throws {
        let store = InMemoryTokenStore()
        try store.save("rlm_cli_TESTTOKEN")
        try routeLoggedIn(loginBody: Data())
        let s = session(store: store)
        await s.restore()
        guard case .ready = s.state else { return XCTFail("setup failed") }

        StubURLProtocol.router = { _ in .init(status: 503, body: Data()) }
        await s.refresh()
        guard case .ready = s.state else { return XCTFail("must keep last-known-good, got \(s.state)") }
        XCTAssertTrue(s.isStale)
        XCTAssertNotNil(try store.load(), "a 503 is not a bad token — keep it")
    }

    // A token we still hold plus a server that is down is not a credentials problem.
    // Bouncing to a sign-in form would ask the user to fix something that is not broken.
    func testRestoreFailureIsUnavailableNotFailed() async throws {
        let store = InMemoryTokenStore()
        try store.save("rlm_cli_TESTTOKEN")
        StubURLProtocol.router = { _ in .init(status: 503, body: Data()) }
        let s = session(store: store)
        await s.restore()
        guard case let .unavailable(message) = s.state else { return XCTFail("want unavailable, got \(s.state)") }
        XCTAssertEqual(message, ErrorCopy.message(for: AccountError.server(status: 503)))
        XCTAssertNotNil(try store.load(), "a 503 is not a bad token — keep it")
    }

    func testLogOutClearsTokenAndState() async throws {
        let store = InMemoryTokenStore()
        try routeLoggedIn(loginBody: try fixture("login-success"))
        let s = session(store: store)
        await s.logIn(email: "a@b.co", password: "pw")
        s.logOut()
        XCTAssertEqual(s.state, .loggedOut)
        XCTAssertFalse(s.isStale)
        XCTAssertNil(try store.load())
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/RelayiumKit && swift test --filter AccountSessionTests`
Expected: FAIL — `cannot find 'AccountSession' in scope`.

- [ ] **Step 3: Write the implementation**

Create `apps/RelayiumKit/Sources/RelayiumAppKit/AccountSession.swift`:

```swift
import Foundation
import RelayiumKit

public enum SessionState: Equatable {
    case restoring
    case loggedOut
    case authenticating
    case emailUnverified(email: String)
    case pendingDeletion(purgeAfter: Int64, reactivateToken: String)
    case ready(user: NativeUser, usage: UsageResponse)
    /// A sign-in attempt was rejected — show the form again with the reason.
    case failed(message: String)
    /// We hold a token but could not load the account (server down, offline).
    /// Distinct from `.failed` on purpose: a sign-in form cannot fix this.
    case unavailable(message: String)
}

/// The whole account state machine. Routing *is* session state, so there is one
/// source of truth rather than a separate router.
///
/// Every Kit call it makes is `async`; every Kit callback it would ever adopt fires
/// off the main thread. Keeping this type `@MainActor` and doing the hopping here
/// means the SwiftUI views never think about threads.
@MainActor
public final class AccountSession: ObservableObject {
    @Published public private(set) var state: SessionState = .restoring
    /// Last refresh failed but the displayed user/usage is still the last known good.
    @Published public private(set) var isStale: Bool = false

    private let client: AccountClient
    private let tokenStore: TokenStore
    private let deviceName: String

    public init(client: AccountClient, tokenStore: TokenStore, deviceName: String) {
        self.client = client
        self.tokenStore = tokenStore
        self.deviceName = deviceName
    }

    /// Where a `loadAccount` call came from, which decides what a non-401 failure means.
    private enum LoadOrigin { case restore, login }

    public func restore() async {
        state = .restoring
        guard let token = await loadTokenOffMainActor(), !token.isEmpty else {
            state = .loggedOut
            return
        }
        await loadAccount(token: token, origin: .restore)
    }

    public func logIn(email: String, password: String) async {
        state = .authenticating
        do {
            let outcome = try await client.login(email: email, password: password, deviceName: deviceName)
            switch outcome {
            case let .success(token, _):
                // The 6-field LoginUser has no billing fields; only /api/me does. So a
                // successful login is always followed by a fetch, never rendered directly.
                try? tokenStore.save(token)
                await loadAccount(token: token, origin: .login)
            case let .emailUnverified(email):
                state = .emailUnverified(email: email)
            case let .pendingDeletion(purgeAfter, reactivateToken):
                state = .pendingDeletion(purgeAfter: purgeAfter, reactivateToken: reactivateToken)
            }
        } catch {
            state = .failed(message: ErrorCopy.message(for: error))
        }
    }

    public func refresh() async {
        guard let token = await loadTokenOffMainActor(), !token.isEmpty else {
            state = .loggedOut
            return
        }
        await loadAccount(token: token, origin: .restore)
    }

    public func logOut() {
        // A keychain clear failure must not strand the user in a signed-in UI: the
        // in-memory session is gone either way.
        try? tokenStore.clear()
        isStale = false
        state = .loggedOut
    }

    private func loadAccount(token: String, origin: LoadOrigin) async {
        do {
            let user = try await client.fetchMe(token: token)
            let usage = try await client.fetchUsage(token: token)
            state = .ready(user: user, usage: usage)
            isStale = false
        } catch AccountError.invalidCredentials {
            // The one and only signal that a stored token has gone bad.
            try? tokenStore.clear()
            isStale = false
            state = .loggedOut
        } catch {
            let message = ErrorCopy.message(for: error)
            if case .ready = state {
                isStale = true          // keep the last known good on screen
            } else {
                // A rejected sign-in belongs back on the form; a token that could not
                // be exchanged for an account belongs on a retry screen.
                state = origin == .login ? .failed(message: message) : .unavailable(message: message)
            }
        }
    }

    /// `KeychainTokenStore.load()` is a synchronous, blocking Keychain call whose first
    /// use can raise a system authorization prompt. It never runs on the main actor.
    private func loadTokenOffMainActor() async -> String? {
        let store = tokenStore
        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: try? store.load())
            }
        }
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/RelayiumKit && swift test --filter AccountSessionTests`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run the whole suite**

Run: `cd apps/RelayiumKit && swift test 2>&1 | tail -5`
Expected: 123 tests, 1 skip, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumAppKit/AccountSession.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/AccountSessionTests.swift
git commit -s -m "feat(native): account session state machine, all three login outcomes"
```

---

### Task 4: `AppEnvironment` — wiring

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/AppEnvironmentTests.swift`

**Interfaces:**
- Consumes: `AccountClient`, `KeychainTokenStore` from `RelayiumKit`; `AccountSession` from Task 3.
- Produces: `public enum AppEnvironment { public static let productionBaseURL: URL; public static let keychainService: String; public static let keychainAccount: String; public static func deviceName() -> String; @MainActor public static func makeSession(baseURL: URL) -> AccountSession }`

- [ ] **Step 1: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/AppEnvironmentTests.swift`:

```swift
import XCTest
@testable import RelayiumAppKit

final class AppEnvironmentTests: XCTestCase {
    func testProductionBaseURLIsTheServiceOrigin() {
        XCTAssertEqual(AppEnvironment.productionBaseURL.absoluteString, "https://relayium.com")
    }
    // Never empty: it becomes the device name in the user's device list on the web.
    func testDeviceNameIsNeverEmpty() {
        XCTAssertFalse(AppEnvironment.deviceName().isEmpty)
    }
    func testKeychainIdentityMatchesTheBundle() {
        XCTAssertEqual(AppEnvironment.keychainService, "com.relayium.mac")
        XCTAssertEqual(AppEnvironment.keychainAccount, "bearer-token")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/RelayiumKit && swift test --filter AppEnvironmentTests`
Expected: FAIL — `cannot find 'AppEnvironment' in scope`.

- [ ] **Step 3: Write the implementation**

Create `apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift`:

```swift
import Foundation
import RelayiumKit

/// Wiring: the few constants and factory calls the SwiftUI layer would otherwise
/// hard-code, kept here so tests and the iOS app in R3 can point elsewhere.
public enum AppEnvironment {
    public static let productionBaseURL = URL(string: "https://relayium.com")!
    public static let keychainService = "com.relayium.mac"
    public static let keychainAccount = "bearer-token"

    /// The user-visible computer name, so the web device list reads the way the
    /// person expects rather than showing a hostname they never chose.
    ///
    /// `Host` is a macOS API; this target also builds for iOS 16 (R3), where the
    /// device's own name is the right answer.
    public static func deviceName() -> String {
        #if os(macOS)
        let name = Host.current().localizedName ?? ""
        return name.isEmpty ? "Mac" : name
        #else
        let name = ProcessInfo.processInfo.hostName
        return name.isEmpty ? "iPhone" : name
        #endif
    }

    @MainActor
    public static func makeSession(baseURL: URL = productionBaseURL) -> AccountSession {
        AccountSession(
            client: AccountClient(baseURL: baseURL),
            tokenStore: KeychainTokenStore(service: keychainService, account: keychainAccount),
            deviceName: deviceName()
        )
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/RelayiumKit && swift test --filter AppEnvironmentTests`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/AppEnvironmentTests.swift
git commit -s -m "feat(native): app environment wiring for the macOS session"
```

---

### Task 5: SwiftUI shell — window, menu bar, and the three screens

**Files:**
- Modify: `apps/mac/Relayium/RelayiumApp.swift`
- Modify: `apps/mac/Relayium/ContentView.swift`
- Create: `apps/mac/Relayium/LoginView.swift`
- Create: `apps/mac/Relayium/AccountView.swift`
- Create: `apps/mac/Relayium/MenuBarView.swift`

**Interfaces:**
- Consumes: `AccountSession`, `SessionState`, `AppEnvironment`, `UsagePresentation`, `MeterDisplay` from `RelayiumAppKit`; `sodiumReady()`, `webrtcAvailable()` from `RelayiumKit`.
- Produces: nothing consumed by later tasks (Task 6 only changes build settings).

There is no unit test here — SwiftUI views in an `.xcodeproj` with no test target are verified by a successful build plus the manual pass in Task 6. That is exactly why every decision worth testing lives in `RelayiumAppKit`.

- [ ] **Step 1: Write `RelayiumApp.swift`**

Replace the whole file:

```swift
import SwiftUI
import RelayiumAppKit

@main
struct RelayiumApp: App {
    @StateObject private var session = AppEnvironment.makeSession()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(session)
                .task { await session.restore() }
        }
        .defaultSize(width: 420, height: 460)

        // Residency. In G1 this shows connection-independent state only; it exists
        // now so G3's persistent signaling socket has a home that does not require
        // restructuring the app around it later.
        MenuBarExtra("Relayium", systemImage: "paperplane") {
            MenuBarView().environmentObject(session)
        }
    }
}
```

- [ ] **Step 2: Write `ContentView.swift`**

Replace the whole file:

```swift
import SwiftUI
import RelayiumKit
import RelayiumAppKit

struct ContentView: View {
    @EnvironmentObject private var session: AccountSession

    var body: some View {
        Group {
            switch session.state {
            case .restoring, .authenticating:
                ProgressView().controlSize(.large)
            case .loggedOut:
                LoginView()
            case .failed(let message):
                LoginView(errorMessage: message)
            case .unavailable(let message):
                // We still hold a valid-looking token — offer a retry, not a form.
                VStack(spacing: 12) {
                    Text("Couldn't load your account").font(.headline)
                    Text(message).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Try again") { Task { await session.refresh() } }
                        .keyboardShortcut(.defaultAction)
                    Button("Sign out") { session.logOut() }.buttonStyle(.link)
                }
            case .emailUnverified(let email):
                noticeView(
                    title: "Check your email",
                    body: "We sent a verification link to \(email). Verify it, then sign in again.",
                    actionTitle: "Open relayium.com"
                )
            case .pendingDeletion(let purgeAfter, _):
                noticeView(
                    title: "This account is scheduled for deletion",
                    body: "It will be erased after \(Date(timeIntervalSince1970: TimeInterval(purgeAfter)).formatted(date: .abbreviated, time: .omitted)). Reactivate it on the web to keep it.",
                    actionTitle: "Reactivate on relayium.com"
                )
            case let .ready(user, usage):
                AccountView(user: user, usage: usage)
            }
        }
        .frame(minWidth: 380, minHeight: 420)
        .padding()
    }

    private func noticeView(title: String, body: String, actionTitle: String) -> some View {
        VStack(spacing: 12) {
            Text(title).font(.headline)
            Text(body).multilineTextAlignment(.center).foregroundStyle(.secondary)
            Button(actionTitle) { NSWorkspace.shared.open(AppEnvironment.productionBaseURL) }
            Button("Back to sign in") { session.logOut() }.buttonStyle(.link)
        }
    }
}
```

- [ ] **Step 3: Write `LoginView.swift`**

```swift
import SwiftUI
import RelayiumAppKit

struct LoginView: View {
    var errorMessage: String? = nil

    @EnvironmentObject private var session: AccountSession
    @State private var email = ""
    @State private var password = ""

    private var canSubmit: Bool { !email.isEmpty && !password.isEmpty }

    var body: some View {
        VStack(spacing: 16) {
            Text("Relayium").font(.largeTitle.weight(.semibold))

            VStack(spacing: 8) {
                TextField("Email", text: $email)
                    .textContentType(.username)
                    .disableAutocorrection(true)
                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .onSubmit { submit() }
            }
            .textFieldStyle(.roundedBorder)
            .frame(maxWidth: 280)

            if let errorMessage {
                Text(errorMessage)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button("Sign in", action: submit)
                .keyboardShortcut(.defaultAction)
                .disabled(!canSubmit)

            Button("Create an account on relayium.com") {
                NSWorkspace.shared.open(AppEnvironment.productionBaseURL)
            }
            .buttonStyle(.link)
        }
    }

    private func submit() {
        guard canSubmit else { return }
        Task { await session.logIn(email: email, password: password) }
    }
}
```

- [ ] **Step 4: Write `AccountView.swift`**

```swift
import SwiftUI
import RelayiumKit
import RelayiumAppKit

struct AccountView: View {
    let user: NativeUser
    let usage: UsageResponse

    @EnvironmentObject private var session: AccountSession

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 2) {
                Text(user.displayName.isEmpty ? user.email : user.displayName).font(.title2.weight(.semibold))
                Text(user.email).foregroundStyle(.secondary)
            }

            HStack {
                Text(usage.plan.name).font(.headline)
                if usage.plan.subscriptionStatus != "active" && !usage.plan.subscriptionStatus.isEmpty {
                    Text(usage.plan.subscriptionStatus)
                        .font(.caption).padding(.horizontal, 6).padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                }
                Spacer()
                // macOS ships as a direct download, so billing is compliant on the web.
                // The app shows the tier read-only and hands off.
                Button("Manage plan") { NSWorkspace.shared.open(AppEnvironment.productionBaseURL) }
            }

            meter("Traffic", UsagePresentation.display(usage.traffic))
            meter("Storage", UsagePresentation.display(usage.storage))

            Text(UsagePresentation.resetText(resetsAt: usage.resetsAt, now: Date()))
                .font(.caption).foregroundStyle(.secondary)

            if session.isStale {
                Label("Showing the last known figures — couldn't reach the server.", systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Spacer()

            HStack {
                Button("Refresh") { Task { await session.refresh() } }
                Spacer()
                Button("Sign out") { session.logOut() }
            }
        }
    }

    @ViewBuilder
    private func meter(_ title: String, _ d: MeterDisplay) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title).font(.subheadline)
                Spacer()
                Text("\(d.usedText) of \(d.capText)").font(.subheadline).foregroundStyle(.secondary)
            }
            // No bar when unlimited: there is no ratio to draw.
            if let fraction = d.fraction {
                ProgressView(value: fraction)
            }
        }
    }
}
```

- [ ] **Step 5: Write `MenuBarView.swift`**

```swift
import SwiftUI
import RelayiumKit
import RelayiumAppKit

struct MenuBarView: View {
    @EnvironmentObject private var session: AccountSession
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        switch session.state {
        case let .ready(user, usage):
            Text(user.email)
            Text("\(usage.plan.name) — \(UsagePresentation.display(usage.traffic).usedText) used")
        default:
            Text("Not signed in")
        }
        Divider()
        // The R1-A acceptance signal, kept reachable: proves the Kit is linked and
        // both native cores initialized in the shipped bundle.
        Text("Core: \(sodiumReady() ? "ok" : "FAILED") · WebRTC: \(webrtcAvailable() ? "ok" : "FAILED")")
        Divider()
        Button("Quit Relayium") { NSApplication.shared.terminate(nil) }
            .keyboardShortcut("q")
    }
}
```

- [ ] **Step 6: Build**

Run:
```bash
cd /Users/lily/code/relayium/relayium
xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build 2>&1 | tail -20
```
Expected: `** BUILD SUCCEEDED **`.

If it fails with `no such module 'RelayiumAppKit'`, the package product in Task 1 Step 1 was not updated to list both targets — fix that, then delete `~/Library/Developer/Xcode/DerivedData/Relayium-*` and rebuild so Xcode re-resolves the local package.

- [ ] **Step 7: Commit**

```bash
git add apps/mac/Relayium/
git commit -s -m "feat(mac): sign-in, account and menu-bar UI on RelayiumAppKit"
```

---

### Task 6: App Sandbox + manual acceptance

**Files:**
- Create: `apps/mac/Relayium/Relayium.entitlements`
- Modify: `apps/mac/Relayium.xcodeproj/project.pbxproj` (two `XCBuildConfiguration` blocks)
- Modify: `apps/README.md`

**Interfaces:**
- Consumes: the app built in Task 5.
- Produces: nothing — this is the round's last task.

- [ ] **Step 1: Write the entitlements file**

Create `apps/mac/Relayium/Relayium.entitlements`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.app-sandbox</key>
	<true/>
	<key>com.apple.security.network.client</key>
	<true/>
	<key>com.apple.security.files.user-selected.read-write</key>
	<true/>
	<key>com.apple.security.files.downloads.read-write</key>
	<true/>
</dict>
</plist>
```

- [ ] **Step 2: Point both build configurations at it**

In `apps/mac/Relayium.xcodeproj/project.pbxproj`, find the two `XCBuildConfiguration` blocks that contain `PRODUCT_BUNDLE_IDENTIFIER = com.relayium.mac;` (one Debug, one Release). Add this line to **each**, immediately after the `CODE_SIGN_STYLE = Automatic;` line:

```
				CODE_SIGN_ENTITLEMENTS = Relayium/Relayium.entitlements;
```

Keep the existing tab indentation — `project.pbxproj` uses tabs, and a space-indented line is a diff-noise trap for the next person.

- [ ] **Step 3: Build ad-hoc signed, so the entitlements actually apply**

`CODE_SIGNING_ALLOWED=NO` skips signing entirely, which means entitlements are **not** applied and the app runs unsandboxed. A headless build with that flag can never verify this task. Build with the project's ad-hoc identity instead:

```bash
cd /Users/lily/code/relayium/relayium
xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' -configuration Debug build 2>&1 | tail -10
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Verify the sandbox is really on the binary**

```bash
APP=$(ls -d ~/Library/Developer/Xcode/DerivedData/Relayium-*/Build/Products/Debug/Relayium.app | head -1)
codesign -d --entitlements - "$APP" 2>/dev/null | grep -c "app-sandbox"
```
Expected: `1`. A `0` means the entitlements path in Step 2 is wrong — the build will still succeed, which is exactly why this check exists.

- [ ] **Step 5: Manual acceptance (the part no test can reach)**

`KeychainTokenStore` is skipped under the SPM test host; R1-C deferred its verification to the first round with a real app bundle (`docs/superpowers/plans/2026-07-24-native-macos-r1c-account.md:716`). This closes it. Run every step and record the result:

```bash
open "$APP"
```

1. The window shows the sign-in form (not a spinner that never resolves).
2. Sign in with a real relayium.com account. Expect: plan name, traffic and storage figures, and a "Resets in N days" line matching the web dashboard.
3. Confirm an unlimited meter (`cap == 0`) renders "Unlimited" with **no** progress bar.
4. Quit (⌘Q) and reopen. Expect: signed in without retyping anything — this is the Keychain round-trip that has never run outside a test.
5. Click the menu-bar icon. Expect: the email, plan, and `Core: ok · WebRTC: ok`.
6. Sign out, then reopen the app. Expect: back to the sign-in form.
7. Turn off Wi-Fi, click Refresh. Expect: the figures stay on screen with the staleness note — not a blank screen, not a bounce to sign-in.
8. Sign in with a deliberately wrong password. Expect: "That email and password don't match an account." — not a type name.

- [ ] **Step 6: Update `apps/README.md`**

The README currently describes the app as rendering `Text(RelayiumKit.sodiumReady() ...)`. Replace that paragraph's description of the shell with the real one, and add the sandbox note:

```markdown
## macOS app

`apps/mac/Relayium.xcodeproj` (bundle id `com.relayium.mac`,
`MACOSX_DEPLOYMENT_TARGET = 13.0`) is a SwiftUI app over the local `RelayiumKit`
package. Views live in the app target; all logic worth testing lives in the
`RelayiumAppKit` target inside that package and is covered by `swift test`.

It is sandboxed (`Relayium/Relayium.entitlements`: network client, user-selected
files, Downloads). Note that `CODE_SIGNING_ALLOWED=NO` **skips entitlements** —
a build with that flag runs unsandboxed, so use a plain `-configuration Debug`
build when the sandbox is what you are testing:

    xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
      -destination 'platform=macOS' -configuration Debug build

    codesign -d --entitlements - "$APP" | grep app-sandbox   # proves it applied
```

Also update the stale round reference at the end of that file: "Real Developer ID
signing + notarization is a later round (R1-F)" is from the pre-reorder numbering
— it is **R1-G5** now.

- [ ] **Step 7: Commit**

```bash
git add apps/mac/Relayium/Relayium.entitlements \
        apps/mac/Relayium.xcodeproj/project.pbxproj \
        apps/README.md
git commit -s -m "feat(mac): enable App Sandbox; document the signing-flag trap"
```

---

## Done when

- `cd apps/RelayiumKit && swift test` → 126 tests, 1 skip, 0 failures.
- `xcodebuild ... CODE_SIGNING_ALLOWED=NO build` → `** BUILD SUCCEEDED **`.
- `codesign -d --entitlements -` on a Debug build reports `app-sandbox`.
- All eight manual acceptance steps pass, including the relaunch that proves the Keychain round-trip R1-C could not verify.
