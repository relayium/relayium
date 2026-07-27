# Native macOS R1-G2.5 — Sign in with Apple — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Sign in with Apple** button in the Mac app that delegates the login
to relayium.com and collects an `rlm_cli_` bearer through the existing device
authorization flow.

**Architecture:** No Apple-specific client code and no new server endpoint. The
app calls `POST /api/cli/device/start`, opens `/device?code=…` in an
`ASWebAuthenticationSession`, polls `POST /api/cli/device/poll`, and hands the
returned token to `AccountSession` exactly as a password login would.

**Tech Stack:** Swift 5.9 / SwiftPM, XCTest, SwiftUI + `AuthenticationServices`,
Go (one HTML template string).

**Spec:** `docs/superpowers/specs/2026-07-27-native-macos-r1g2-5-sign-in-with-apple-design.md`

## Global Constraints

- **No server logic changes.** The only Go touched is the `/device` page's
  wording. No new endpoint, no new field, no behaviour change.
- **No signing configuration changes.** The G1.5 profile, entitlements and CI
  secret stand unchanged. A binary carrying `com.apple.developer.applesignin` is
  killed at launch on this distribution channel — do not add it.
- Poll timings come from the server, not from constants here:
  `interval` (5) and `expires_in` (600) arrive in the `start` response
  (`server/account/deviceauth.go:16-17,75-81`).
- The token is handed out **exactly once** (`ConsumeDeviceAuth`); a second poll
  after success returns `expired`. Never poll again after `ok`.
- `AccountSession`'s existing states, guards and keychain handling are reused
  as-is. This round adds one entry point, not a second notion of being signed in.

## File structure

| File | Responsibility |
|---|---|
| `Sources/RelayiumKit/Account/DeviceAuthClient.swift` | **new** — the two endpoints behind a protocol, plus pure response parsing |
| `Sources/RelayiumAppKit/BrowserLoginModel.swift` | **new** — start → poll loop → outcome, with cancellation |
| `Sources/RelayiumAppKit/AccountSession.swift` | modify — `adoptBearer(_:)` |
| `Sources/RelayiumAppKit/ErrorCopy.swift` | modify — denied / expired |
| `apps/mac/Relayium/BrowserSignIn.swift` | **new** — `ASWebAuthenticationSession` presentation |
| `apps/mac/Relayium/LoginView.swift` | modify — the button |
| `server/account/devicepage.go` | modify — caller-neutral wording |

Tasks 1–4 are testable layers. Task 5 is the window-bound part. Task 6 is the web
copy. Task 7 is acceptance.

---

### Task 1: `DeviceAuthClient`

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Account/DeviceAuthClient.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/DeviceAuthClientTests.swift`

**Interfaces:**
- Consumes: `AccountError` for transport failures.
- Produces:
  - `public struct DeviceAuthStart: Equatable { public let userCode, deviceCode: String; public let verificationURL: URL; public let interval: Int; public let expiresIn: Int }`
  - `public enum DevicePollOutcome: Equatable { case pending, denied, expired, ok(token: String, accountEmail: String) }`
  - `public protocol DeviceAuthClient { func start() async throws -> DeviceAuthStart; func poll(deviceCode: String) async throws -> DevicePollOutcome }`
  - `public struct HTTPDeviceAuthClient: DeviceAuthClient`
  - `func parseDeviceStart(_ data: Data) throws -> DeviceAuthStart`
  - `func parseDevicePoll(_ data: Data) throws -> DevicePollOutcome`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import RelayiumKit

final class DeviceAuthClientTests: XCTestCase {
    /// The server's own field names. Getting one wrong fails at runtime with a
    /// decode error that says nothing about which key was missing.
    func testParsesTheStartResponse() throws {
        let json = """
        {"user_code":"WDJB-MJHT","device_code":"dc_abc","verification_uri":"https://relayium.com/device",
         "interval":5,"expires_in":600}
        """.data(using: .utf8)!
        let s = try parseDeviceStart(json)
        XCTAssertEqual(s.userCode, "WDJB-MJHT")
        XCTAssertEqual(s.deviceCode, "dc_abc")
        XCTAssertEqual(s.verificationURL, URL(string: "https://relayium.com/device")!)
        XCTAssertEqual(s.interval, 5)
        XCTAssertEqual(s.expiresIn, 600)
    }

    /// All four poll outcomes arrive as HTTP 200 with a `status` field — a poll
    /// that treated non-200 as the signal would hang forever on `pending`.
    func testParsesEveryPollOutcome() throws {
        XCTAssertEqual(try parseDevicePoll(#"{"status":"authorization_pending"}"#.data(using: .utf8)!), .pending)
        XCTAssertEqual(try parseDevicePoll(#"{"status":"denied"}"#.data(using: .utf8)!), .denied)
        XCTAssertEqual(try parseDevicePoll(#"{"status":"expired"}"#.data(using: .utf8)!), .expired)
        XCTAssertEqual(
            try parseDevicePoll(#"{"status":"ok","access_token":"rlm_cli_x","account_email":"a@b.c"}"#.data(using: .utf8)!),
            .ok(token: "rlm_cli_x", accountEmail: "a@b.c"))
    }

    /// An unknown status must not be read as success. A future server state that
    /// silently mapped to `.ok` would sign the user in with an empty token.
    func testUnknownStatusIsRejected() {
        XCTAssertThrowsError(try parseDevicePoll(#"{"status":"something_new"}"#.data(using: .utf8)!))
    }

    /// `ok` without a token is a server bug, and adopting "" would land the app
    /// in .ready with a bearer that 401s on the next request.
    func testOkWithoutATokenIsRejected() {
        XCTAssertThrowsError(try parseDevicePoll(#"{"status":"ok","account_email":"a@b.c"}"#.data(using: .utf8)!))
    }

    /// The prefilled approval URL is what makes this one click rather than a
    /// transcription exercise.
    func testApprovalURLCarriesTheUserCode() throws {
        let json = """
        {"user_code":"WDJB-MJHT","device_code":"d","verification_uri":"https://relayium.com/device",
         "interval":5,"expires_in":600}
        """.data(using: .utf8)!
        let s = try parseDeviceStart(json)
        XCTAssertEqual(s.approvalURL.absoluteString, "https://relayium.com/device?code=WDJB-MJHT")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/RelayiumKit && swift test --filter DeviceAuthClientTests 2>&1 | grep -E "error:" | head -3
```

Expected: `cannot find 'parseDeviceStart' in scope`.

- [ ] **Step 3: Write the implementation**

Create `apps/RelayiumKit/Sources/RelayiumKit/Account/DeviceAuthClient.swift`:

```swift
import Foundation

public struct DeviceAuthStart: Equatable {
    public let userCode: String
    public let deviceCode: String
    public let verificationURL: URL
    public let interval: Int
    public let expiresIn: Int

    /// The page with the code already filled in, so approving is one click
    /// instead of transcribing. `/device` reads `?code=` and auto-loads the
    /// request's details (`server/account/devicepage.go:151`).
    public var approvalURL: URL {
        var c = URLComponents(url: verificationURL, resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "code", value: userCode)]
        return c.url ?? verificationURL
    }
}

public enum DevicePollOutcome: Equatable {
    case pending
    case denied
    case expired
    case ok(token: String, accountEmail: String)
}

/// Every poll outcome is HTTP 200 with a `status` field, so the status code is
/// not the signal — a client that waited for a non-200 would poll until the
/// code expired and then report a timeout for a login that had succeeded.
func parseDevicePoll(_ data: Data) throws -> DevicePollOutcome {
    struct Body: Decodable { let status: String; let access_token: String?; let account_email: String? }
    guard let b = try? JSONDecoder().decode(Body.self, from: data) else { throw AccountError.decoding }
    switch b.status {
    case "authorization_pending": return .pending
    case "denied": return .denied
    case "expired": return .expired
    case "ok":
        // An empty token would land the session in .ready with a bearer that
        // 401s on the very next request. Refuse it here.
        guard let t = b.access_token, !t.isEmpty else { throw AccountError.decoding }
        return .ok(token: t, accountEmail: b.account_email ?? "")
    default:
        // Never guess. A future status read as success signs someone in wrongly.
        throw AccountError.decoding
    }
}

func parseDeviceStart(_ data: Data) throws -> DeviceAuthStart {
    struct Body: Decodable {
        let user_code: String; let device_code: String; let verification_uri: String
        let interval: Int; let expires_in: Int
    }
    guard let b = try? JSONDecoder().decode(Body.self, from: data),
          let url = URL(string: b.verification_uri) else { throw AccountError.decoding }
    return DeviceAuthStart(userCode: b.user_code, deviceCode: b.device_code,
                           verificationURL: url, interval: b.interval, expiresIn: b.expires_in)
}

/// The two calls of the device-authorization flow, behind a protocol so the poll
/// loop can be tested without a server.
public protocol DeviceAuthClient {
    func start() async throws -> DeviceAuthStart
    func poll(deviceCode: String) async throws -> DevicePollOutcome
}

public struct HTTPDeviceAuthClient: DeviceAuthClient {
    let baseURL: URL
    let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func start() async throws -> DeviceAuthStart {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/cli/device/start"))
        req.httpMethod = "POST"
        let (data, http) = try await send(req)
        guard http.statusCode == 200 else { throw statusError(http.statusCode) }
        return try parseDeviceStart(data)
    }

    public func poll(deviceCode: String) async throws -> DevicePollOutcome {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/cli/device/poll"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["device_code": deviceCode])
        let (data, http) = try await send(req)
        guard http.statusCode == 200 else { throw statusError(http.statusCode) }
        return try parseDevicePoll(data)
    }

    private func statusError(_ code: Int) -> AccountError {
        code == 429 ? .rateLimited : .server(status: code)
    }

    private func send(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw AccountError.network }
            return (data, http)
        } catch let e as AccountError { throw e }
        catch { throw AccountError.network }
    }
}
```

The request key is `device_code`, verified against `handleDevicePoll`
(`server/account/deviceauth.go:129-132`), which also rejects an empty one with
400. Worth stating because a mismatched key would not fail loudly — the handler
would 400 and a careless client would read that as "keep polling".

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/RelayiumKit && swift test --filter DeviceAuthClientTests 2>&1 | grep -E "Executed .* tests" | tail -1
```

Expected: `Executed 5 tests, with 0 failures`.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Account/DeviceAuthClient.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/DeviceAuthClientTests.swift
git commit -s -m "feat(kit): the device-authorization flow's two calls

start and poll, behind a protocol so the loop that drives them is testable
without a server. Every poll outcome arrives as HTTP 200 with a status field, so
the status code is not the signal — a client waiting for a non-200 would poll
until the code expired and then report a timeout for a login that worked.

Two decode refusals rather than guesses: an unknown status is an error instead of
success, and \`ok\` without a token is an error instead of an empty bearer that
would reach .ready and 401 on the next request."
```

---

### Task 2: `BrowserLoginModel`

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/BrowserLoginModel.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/BrowserLoginModelTests.swift`

**Interfaces:**
- Consumes: `DeviceAuthClient`, `DeviceAuthStart`, `DevicePollOutcome` (Task 1).
- Produces:
  - `public enum BrowserLoginState: Equatable { case idle, starting, waiting(approvalURL: URL), failed(String) }`
  - `public final class BrowserLoginModel: ObservableObject` with `state`,
    `begin(onToken:)`, `cancel()`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

private final class StubDeviceAuth: DeviceAuthClient, @unchecked Sendable {
    var startResult: DeviceAuthStart = .init(userCode: "AAAA-BBBB", deviceCode: "dc",
                                             verificationURL: URL(string: "https://x.test/device")!,
                                             interval: 0, expiresIn: 600)
    var startError: Error?
    /// Consumed in order; the last one repeats.
    var pollScript: [DevicePollOutcome] = [.ok(token: "rlm_cli_t", accountEmail: "a@b.c")]
    private(set) var pollCount = 0

    func start() async throws -> DeviceAuthStart {
        if let e = startError { throw e }
        return startResult
    }
    func poll(deviceCode: String) async throws -> DevicePollOutcome {
        defer { pollCount += 1 }
        return pollScript[min(pollCount, pollScript.count - 1)]
    }
}

@MainActor
final class BrowserLoginModelTests: XCTestCase {
    func testHandsBackTheTokenAndExposesTheApprovalURL() async {
        let c = StubDeviceAuth()
        let m = BrowserLoginModel(client: c)
        var got: String?
        await m.begin { got = $0 }
        XCTAssertEqual(got, "rlm_cli_t")
    }

    /// The URL the sheet opens must carry the code, or the user has to type it.
    func testWaitingStateCarriesThePrefilledURL() async {
        let c = StubDeviceAuth()
        c.pollScript = [.pending, .ok(token: "t", accountEmail: "")]
        let m = BrowserLoginModel(client: c)
        var seen: URL?
        await m.begin { _ in seen = nil }
        // The approval URL is published before polling starts; capture it from
        // the state the sheet reads.
        XCTAssertTrue(c.pollCount >= 2, "should have polled past the pending result")
        _ = seen
    }

    /// Deny is a decision, not a failure to keep waiting for.
    func testStopsAndReportsOnDenied() async {
        let c = StubDeviceAuth()
        c.pollScript = [.denied]
        let m = BrowserLoginModel(client: c)
        var got: String?
        await m.begin { got = $0 }
        XCTAssertNil(got)
        guard case .failed(let msg) = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertFalse(msg.isEmpty)
        XCTAssertEqual(c.pollCount, 1, "must not keep polling after a denial")
    }

    func testStopsAndReportsOnExpired() async {
        let c = StubDeviceAuth()
        c.pollScript = [.expired]
        let m = BrowserLoginModel(client: c)
        await m.begin { _ in }
        guard case .failed = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(c.pollCount, 1)
    }

    /// A failing start is reported, not retried into a hang.
    func testReportsAStartFailure() async {
        let c = StubDeviceAuth()
        c.startError = AccountError.rateLimited
        let m = BrowserLoginModel(client: c)
        await m.begin { _ in }
        guard case .failed = m.state else { return XCTFail("got \(m.state)") }
        XCTAssertEqual(c.pollCount, 0)
    }

    /// Closing the sheet cancels the login. It is not an error and must not
    /// leave a poll loop running against a code nobody will approve.
    func testCancelStopsPollingAndReportsNothing() async {
        let c = StubDeviceAuth()
        c.pollScript = [.pending]
        let m = BrowserLoginModel(client: c)
        m.cancel()
        guard case .idle = m.state else { return XCTFail("got \(m.state)") }
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: `cannot find 'BrowserLoginModel' in scope`.

- [ ] **Step 3: Write the implementation**

```swift
import Foundation
import RelayiumKit

public enum BrowserLoginState: Equatable {
    case idle
    case starting
    case waiting(approvalURL: URL)
    case failed(String)
}

/// Drives start → poll → token. Knows nothing about how the browser is shown:
/// it publishes the URL to open and the caller presents it, which is what keeps
/// every decision in this file testable without a window.
@MainActor
public final class BrowserLoginModel: ObservableObject {
    @Published public private(set) var state: BrowserLoginState = .idle

    private let client: DeviceAuthClient
    private var generation = 0

    public init(client: DeviceAuthClient) { self.client = client }

    /// Runs to a terminal state. `onToken` fires once, on success only.
    public func begin(onToken: (String) -> Void) async {
        generation += 1
        let g = generation
        state = .starting
        do {
            let s = try await client.start()
            guard g == generation else { return }
            state = .waiting(approvalURL: s.approvalURL)
            let deadline = Date().addingTimeInterval(TimeInterval(s.expiresIn))
            while Date() < deadline {
                guard g == generation, !Task.isCancelled else { return }
                switch try await client.poll(deviceCode: s.deviceCode) {
                case .pending:
                    // The server sets the floor; polling faster earns a 429.
                    try await Task.sleep(nanoseconds: UInt64(s.interval) * 1_000_000_000)
                case .denied:
                    guard g == generation else { return }
                    state = .failed(ErrorCopy.message(for: DeviceAuthOutcomeError.denied))
                    return
                case .expired:
                    guard g == generation else { return }
                    state = .failed(ErrorCopy.message(for: DeviceAuthOutcomeError.expired))
                    return
                case .ok(let token, _):
                    guard g == generation else { return }
                    state = .idle
                    // The token is handed out exactly once; never poll again.
                    onToken(token)
                    return
                }
            }
            guard g == generation else { return }
            state = .failed(ErrorCopy.message(for: DeviceAuthOutcomeError.expired))
        } catch is CancellationError {
            guard g == generation else { return }
            state = .idle
        } catch {
            guard g == generation else { return }
            state = .failed(ErrorCopy.message(for: error))
        }
    }

    /// Closing the sheet. Bumping the generation is the load-bearing half: the
    /// poll loop is awaiting a sleep and must not resume into a live state.
    public func cancel() {
        generation += 1
        state = .idle
    }
}
```

Add the outcome error type to `RelayiumKit` (it is a wire outcome, not a UI
concern) in `DeviceAuthClient.swift`:

```swift
/// Terminal poll outcomes that are failures from the caller's point of view.
public enum DeviceAuthOutcomeError: Error, Equatable { case denied, expired }
```

- [ ] **Step 4: Run the tests to verify they pass**

Expected: `Executed 6 tests, with 0 failures`.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumAppKit/BrowserLoginModel.swift \
        apps/RelayiumKit/Sources/RelayiumKit/Account/DeviceAuthClient.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/BrowserLoginModelTests.swift
git commit -s -m "feat(native): drive the browser login's start-poll-token loop

Publishes the URL to open rather than opening it, which is what keeps every
decision here testable without a window. Deny and expire are terminal and stop
the loop — a denial polled through would keep asking a server that has already
answered. The interval comes from the server; polling faster earns a 429.

Cancel bumps the generation rather than only flipping state: the loop is
usually parked in a sleep, and it must not resume into a screen the user left."
```

---

### Task 3: `AccountSession.adoptBearer`

**Files:**
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/AccountSession.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/AccountSessionTests.swift`

**Interfaces:**
- Produces: `public func adoptBearer(_ token: String) async`

- [ ] **Step 1: Write the failing test**

Add to `AccountSessionTests`, following the existing stub-client pattern in that
file:

```swift
    /// A token obtained out of band must reach exactly the state a password
    /// login reaches — same fetch, same keychain write, same .ready.
    func testAdoptBearerReachesReadyAndPersists() async {
        let store = InMemoryTokenStore()
        let session = AccountSession(client: <stub returning a user and usage>,
                                     tokenStore: store, deviceName: "Test")
        await session.adoptBearer("rlm_cli_adopted")
        guard case .ready = session.state else { return XCTFail("got \(session.state)") }
        XCTAssertEqual(try store.load(), "rlm_cli_adopted")
    }

    /// A sign-out that lands while the account fetch is in flight wins, and the
    /// adopted token must not be written to the keychain afterwards.
    func testAdoptBearerHonoursASupersedingSignOut() async {
        // Drive the same superseded path the existing logIn tests use.
    }
```

Read `AccountSessionTests.swift` first and reuse its existing client stub rather
than inventing a second one — it already models `/api/me` and `/api/me/usage`.

- [ ] **Step 2: Run to verify it fails**

Expected: `value of type 'AccountSession' has no member 'adoptBearer'`.

- [ ] **Step 3: Write the implementation**

Insert into `AccountSession`, beside `logIn`:

```swift
    /// Adopt a bearer obtained outside this type — the browser login's device
    /// flow. Deliberately the same tail as `logIn`'s success branch: persist,
    /// then fetch, because the token alone carries no billing fields and a
    /// session rendered from it would be missing half the account screen.
    public func adoptBearer(_ token: String) async {
        let g = beginOperation()
        state = .authenticating
        guard !superseded(g) else { return }
        sessionToken = token
        try? tokenStore.save(token)
        await loadAccount(token: token, generation: g)
    }
```

- [ ] **Step 4: Run the suite**

```bash
cd apps/RelayiumKit && swift test 2>&1 | grep -E "Executed [0-9]+ tests" | tail -1
```

Expected: 0 failures.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumAppKit/AccountSession.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/AccountSessionTests.swift
git commit -s -m "feat(native): adopt a bearer obtained through the browser

One new entry point, deliberately sharing logIn's tail: persist to the keychain,
then fetch /api/me and /api/me/usage, because the token alone carries no billing
fields and an account screen rendered from it would be half empty.

Every existing guard is reused rather than reimplemented — the operation
identity, the frozen-account path, the keychain failure handling. This round
adds a way to arrive at a session, not a second kind of session."
```

---

### Task 4: Error copy

**Files:**
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/ErrorCopy.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/ErrorCopyTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
    /// Deny and expire are different things and must not share a message: one
    /// says a person refused, the other says nobody answered in time.
    func testDeviceAuthOutcomesReadDifferently() {
        let denied = ErrorCopy.message(for: DeviceAuthOutcomeError.denied)
        let expired = ErrorCopy.message(for: DeviceAuthOutcomeError.expired)
        XCTAssertNotEqual(denied, expired)
        XCTAssertFalse(denied.contains("DeviceAuthOutcomeError"))
        XCTAssertFalse(expired.contains("DeviceAuthOutcomeError"))
    }
```

- [ ] **Step 2: Run to verify it fails**

Expected: both assertions on the type name fail — the fallback returns
`Something went wrong (DeviceAuthOutcomeError).`

- [ ] **Step 3: Write the implementation**

Insert before the final fallback in `ErrorCopy.message(for:)`:

```swift
        if let e = error as? DeviceAuthOutcomeError {
            switch e {
            case .denied:
                return "That sign-in was declined in the browser. Try again if that wasn't you."
            case .expired:
                // Not a failure of theirs — nobody approved in time.
                return "The sign-in request timed out. Start again to get a new one."
            }
        }
```

- [ ] **Step 4: Run and commit**

```bash
cd apps/RelayiumKit && swift test --filter ErrorCopyTests 2>&1 | grep -E "Executed .* tests" | tail -1
git add apps/RelayiumKit/Sources/RelayiumAppKit/ErrorCopy.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/ErrorCopyTests.swift
git commit -s -m "feat(native): copy for a declined or timed-out browser sign-in

Two messages rather than one: a person declining and nobody answering in time
are different events, and only the first is worth a second thought."
```

---

### Task 5: The button and the sheet

**Files:**
- Create: `apps/mac/Relayium/BrowserSignIn.swift`
- Modify: `apps/mac/Relayium/LoginView.swift`

Views hold no logic; this task is presentation and wiring only.

- [ ] **Step 1: Write the presenter**

```swift
import AuthenticationServices
import AppKit

/// Presents the approval page and dismisses it when the caller says so.
///
/// `ASWebAuthenticationSession` is built around a callback scheme, and this flow
/// has no callback — the token arrives by polling. The scheme below is therefore
/// never reached, and the sheet is dismissed by `cancel()` once the poll
/// succeeds. That reads like a bug without this comment; it is the price of
/// getting an in-app sheet that shares Safari's cookies, so a user already
/// signed into relayium.com approves in one click.
@MainActor
final class BrowserSignInPresenter: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func present(_ url: URL, onDismiss: @escaping () -> Void) {
        let s = ASWebAuthenticationSession(url: url, callbackURLScheme: "relayium") { _, _ in
            // Reached only when the user closes the sheet: a closed sheet is a
            // cancelled login, never an error.
            onDismiss()
        }
        s.presentationContextProvider = self
        // Shared cookies, not ephemeral: an existing relayium.com session is
        // what turns this into one click.
        s.prefersEphemeralWebBrowserSession = false
        session = s
        s.start()
    }

    func dismiss() {
        session?.cancel()
        session = nil
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first ?? ASPresentationAnchor()
    }
}
```

- [ ] **Step 2: Add the button to `LoginView`**

Below the existing `Button("Sign in", action: submit)` (`LoginView.swift:46`),
inside the same form so the `@State` email and password survive:

```swift
                Divider()
                Button("Sign in with Apple") { startBrowserLogin() }
```

with the model and presenter held as `@StateObject` / `@State` on the view, and:

```swift
    private func startBrowserLogin() {
        Task {
            await browserLogin.begin { token in
                presenter.dismiss()
                Task { await session.adoptBearer(token) }
            }
        }
        // The sheet opens as soon as the model publishes the URL.
    }
```

Observe `browserLogin.state` and call `presenter.present(url) { browserLogin.cancel() }`
when it becomes `.waiting(approvalURL:)`. Use `task(id:)` rather than
`onChange(of:initial:)` — this app targets macOS 13 and the two-parameter
`onChange` needs 14 (learned in G2, `ContentView.swift`).

- [ ] **Step 3: Verify it compiles**

```bash
xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -E '\*\* BUILD|error:' | tail -3
```

Expected: `** BUILD SUCCEEDED **`. No `project.pbxproj` edit is needed — the
target uses a `PBXFileSystemSynchronizedRootGroup`, so files in `Relayium/` are
picked up automatically (learned in G2).

- [ ] **Step 4: Commit**

```bash
git add apps/mac/Relayium/BrowserSignIn.swift apps/mac/Relayium/LoginView.swift
git commit -s -m "feat(mac): Sign in with Apple, by way of the browser

The button says what the user wants rather than how it is delivered: the screen
already has a password form, so whoever presses this came for Apple, and the
page it opens leads with the Apple button.

ASWebAuthenticationSession is used as a container, not a callback pipeline —
this flow collects its token by polling, so the callback scheme is never
reached and the sheet is dismissed once the poll succeeds. It earns its place by
sharing Safari's cookies, which turns an existing relayium.com session into a
one-click approval."
```

---

### Task 6: The approval page's wording

**Files:**
- Modify: `server/account/devicepage.go:53`

- [ ] **Step 1: Change the copy**

The current sentence assumes a terminal:

```
Signed in as <strong>{{.Email}}</strong>. Confirm the code shown in your terminal to bind this login to your account.
```

Make it caller-neutral — the page already displays the requesting origin and user
agent below, which is the part that matters for judging the request:

```
Signed in as <strong>{{.Email}}</strong>. Confirm the code shown by the app or terminal that asked, to bind this login to your account.
```

Leave the warning below it alone: "full CLI access" is accurate — this is the
same token with the same powers, whoever asked for it.

- [ ] **Step 2: Verify the server still builds and its tests pass**

```bash
cd server && go build ./... && go test ./account/ 2>&1 | tail -3
```

Expected: no build errors, no test failures. Nothing asserts this sentence today
(checked), so a copy change should not move any test — if one does move, read it
before updating it, because it means the page is covered somewhere unexpected.

- [ ] **Step 3: Check the page renders**

```bash
cd server && go test ./account/ -run Device 2>&1 | tail -3
```

Expected: pass. The template is parsed at init, so a broken edit fails every
test in the package rather than only at request time.

- [ ] **Step 4: Commit**

```bash
git add server/account/devicepage.go
git commit -s -m "fix(web): the approval page has two kinds of caller now

'Confirm the code shown in your terminal' was written when the CLI was the only
thing that asked. The Mac app now opens this page itself, so for half its
traffic the sentence describes something the reader is not doing — on the one
screen in the flow where we are asking them to be suspicious.

The warning below is unchanged: it is the same token with the same powers
whoever asked for it."
```

---

### Task 7: Acceptance

**Blocked on Tasks 1–6.** Nothing here is automatable: the flow needs a real
Apple ID, a real browser and a signed build.

- [ ] **Step 1: Build signed**

```bash
xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' -configuration Debug \
  -derivedDataPath /tmp/relayium-g25 build 2>&1 | grep -E '\*\* BUILD|error:' | tail -2
open /tmp/relayium-g25/Build/Products/Debug/Relayium.app
```

`CODE_SIGNING_ALLOWED=NO` cannot be used — it skips entitlements, and the
keychain write at the end of this flow needs them.

- [ ] **Step 2: The criterion**

Sign into relayium.com with Apple in a browser first. Then, in the app, press
**Sign in with Apple**, approve, and confirm the app shows **that account's**
files and usage — not an empty account. A second account here means the App ID
grouping is wrong and nothing else will report it.

- [ ] **Step 3: One-click path**

With an existing relayium.com session in Safari, the sheet should open straight
to the approval page with the code prefilled — no re-authentication.

- [ ] **Step 4: Not Apple-specific**

Sign in through the same button using a password account. The transport does not
care which method the web used, and this proves it.

- [ ] **Step 5: Deny**

Press Deny on the approval page. The app reports it and offers to try again;
polling stops immediately rather than running to the ten-minute expiry.

- [ ] **Step 6: Close the sheet**

Close it without approving. Nothing is reported, the login form stays usable,
and no poll loop survives — check that pressing the button again starts cleanly.

- [ ] **Step 7: Persistence**

Quit and relaunch. Auto-login works, proving the adopted bearer reached the
keychain exactly as a password login's does.

- [ ] **Step 8: Record and commit**

Add the six results to the round's notes in `apps/README.md` if anything
surprised you; otherwise commit nothing here and report.

---

## Self-review

**Spec coverage.** `DeviceAuthClient` → Task 1. `BrowserLoginModel` → Task 2.
`adoptBearer` → Task 3. Error copy → Task 4. Button and sheet → Task 5. `/device`
wording → Task 6. All six acceptance items → Task 7. Zero server-logic, signing
and CI changes → enforced by the Global Constraints and by Task 5 Step 3's note
that no `pbxproj` edit is needed.

**Placeholder scan.** Two steps deliberately say *read the existing code first*
rather than quoting it: Task 1 Step 3's `device_code` request key, and Task 3
Step 1's reuse of `AccountSessionTests`'s existing client stub. Both are cases
where quoting from memory would be worse than a two-minute read, and both name
exactly what to look for.

**Type consistency.** `DeviceAuthStart` / `DevicePollOutcome` / `DeviceAuthClient`
(Task 1) are what Task 2 consumes; `DeviceAuthOutcomeError` is introduced in
Task 2 Step 3 in the Kit file from Task 1 and consumed by Task 4;
`adoptBearer(_:)` (Task 3) is called by Task 5.

**Known gap.** Task 2's `testWaitingStateCarriesThePrefilledURL` as written
checks the poll count rather than the published URL, because the model reaches
`.idle` before the assertion runs. Tighten it when implementing: capture
`state` inside the `onToken` closure, or expose the last approval URL. The
prefilled URL is what makes this one click, so it deserves a real assertion.
