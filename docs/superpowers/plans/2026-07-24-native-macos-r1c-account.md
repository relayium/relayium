# Native macOS R1-C: Account module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `Account` module to `RelayiumKit` — native email+password login against `POST /api/auth/native/login`, bearer-token persistence in the Keychain, and authenticated fetch of profile + usage/plan (`GET /api/me`, `GET /api/me/usage`) — plus the one server change that makes those reads reachable by a bearer client. This is what a later Cloud module (R1-D) and the macOS UI (R1-G) use to sign in and show quota.

**Architecture:** `Account` is a thin async HTTP client over `URLSession` plus Codable models mirroring the existing Go handlers, and a `TokenStore` abstraction (protocol + in-memory + Keychain implementations). It has no crypto/transport coupling to the other modules. Networking is tested with a `URLProtocol` stub returning canned JSON frozen from the real server response shapes — no live server, no golden-vector-from-web (this module speaks JSON APIs, not a byte-exact wire).

**Tech Stack:** Swift 5.9+, `URLSession` (async/await), `Security` (Keychain), XCTest with a `URLProtocol` stub. Server side: Go (net/http). No new dependencies.

## This plan's place in R1

Cloud-first R1 sequence: R1-A `Crypto` ✓ → R1-B `StoredWire` ✓ → **R1-C `Account` (this plan)** → R1-D `Cloud` (first working native transfer) → R1-E `Signaling` → R1-F `Realtime` → R1-G UI+distribution. R1-D's Cloud uploads/downloads authenticate with the bearer token this module stores; R1-G's UI drives login and renders the usage/plan this module fetches.

## Grounding (verified against the server)

- `POST /api/auth/native/login` (`server/internal/account/native.go`) — body `{email, password, deviceName}`. Responses:
  - `200 {token:"rlm_cli_…", user:{id,email,displayName,hasPassword,emailVerified,linkedMethods,…}}` on success.
  - `401 {error:"invalid credentials"}`; `403 {error:"email_unverified", email}`; `429 {error:"…"}`.
  - `200 {status:"pending_deletion", purgeAfter, reactivateToken}` for a frozen (soft-deleted) account.
- `GET /api/me` → `{user:{id,email,displayName,hasPassword,emailVerified,linkedMethods,onlyOwnNodes,planId,subscriptionStatus,subscriptionEnd,hasBilling,scheduledPlanId,scheduledCycle,billingCycle}}`.
- `GET /api/me/usage` → `{period,resetsAt,traffic:{used,cap},storage:{used,cap},plan:{id,name,storageBytes,trafficBytes,retentionSecs,priceMonthly,priceYearly,isTop,subscriptionStatus,subscriptionEnd,billingCycle,scheduledPlanId,scheduledPlanName,scheduledCycle}}`. `cap == 0` means unlimited.
- `RequireAuth` (`server/internal/account/auth.go:14`) accepts a session cookie **or** an `Authorization: Bearer` token; `RequireSession` (`handlers.go:297`) accepts a cookie only. `/api/me` and `/api/me/usage` are currently mounted with `RequireSession`, so a bearer-only native client cannot read them — Task 1 fixes that.

## Global Constraints

- **JSON field names match the Go handlers verbatim** (camelCase: `displayName`, `hasPassword`, `planId`, `subscriptionStatus`, `resetsAt`, `trafficBytes`, …). Codable structs use exactly these names (no `.convertFromSnakeCase`).
- **Bearer auth**: authenticated requests send `Authorization: Bearer <token>`. The token is the raw `rlm_cli_…` string from login.
- **Login is status+body sensitive**: `pending_deletion` is HTTP 200 with a `status` field, NOT an error status — inspect the body, not just the code.
- **`cap == 0` means unlimited** (do not render a progress bar / treat as "no limit"). Model it faithfully; don't coerce to a sentinel.
- **No secrets in logs**: never log the bearer token or password.
- **Testing without a live server**: all `AccountClient` tests use a `URLProtocol` stub; Keychain-touching tests use the in-memory `TokenStore` (the real `KeychainTokenStore` gets a guarded smoke test that skips if the keychain is unavailable in the test host).
- **Min platforms / cadence**: macOS 13, Swift 5.9; commit after every green test cycle; English commit messages. Go changes must keep `go test ./...` green.

---

## File structure (R1-C)

Server:
- Modify: `server/internal/account/handlers.go` — switch `GET /api/me` and `GET /api/me/usage` from `RequireSession` to `RequireAuth`.
- Modify/Create: `server/internal/account/native_test.go` (or a sibling `*_test.go`) — a test that a bearer token can read `/api/me` and `/api/me/usage`.

Swift (`apps/RelayiumKit/`):
- Create: `Sources/RelayiumKit/Account/AccountModels.swift` — Codable models + `LoginOutcome` + `AccountError`.
- Create: `Sources/RelayiumKit/Account/AccountClient.swift` — the async HTTP client.
- Create: `Sources/RelayiumKit/Account/TokenStore.swift` — `TokenStore` protocol + `InMemoryTokenStore` + `KeychainTokenStore`.
- Create: `Tests/RelayiumKitTests/Support/StubURLProtocol.swift` — URLProtocol stub harness.
- Create: `Tests/RelayiumKitTests/AccountModelsTests.swift`, `AccountClientTests.swift`, `TokenStoreTests.swift`.
- Create: `Tests/Fixtures/account/login-success.json`, `login-unverified.json`, `login-pending-deletion.json`, `me.json`, `me-usage.json` — frozen server response shapes.
- Modify: `apps/RelayiumKit/Package.swift` — switch the test resources to a directory-level rule so all fixtures (existing + `account/`) are bundled (addresses the R1-B deferred note).

---

## Task 1: Server — make `/api/me` + `/api/me/usage` bearer-capable

**Files:**
- Modify: `server/internal/account/handlers.go:155-156`
- Modify: `server/internal/account/native_test.go` (add a test; create if absent)

**Interfaces:**
- Produces: `/api/me` and `/api/me/usage` reachable with `Authorization: Bearer rlm_cli_…`. Response shapes unchanged.

- [ ] **Step 1: Write the failing Go test**

Add to `server/internal/account/native_test.go` a test that logs in via `handleNativeLogin` (or mints a bearer via the test store) and then calls `/api/me` and `/api/me/usage` with `Authorization: Bearer <token>`, asserting `200`. Follow the existing test patterns in this package (they construct a `Service` with a fake store — reuse that harness; grep `func Test` in `internal/account/*_test.go` for the setup helper). Example skeleton (adapt to the package's existing helpers):

```go
func TestBearerCanReadMeAndUsage(t *testing.T) {
    s, _ := newTestService(t)               // use the package's existing helper
    uid := seedVerifiedUser(t, s, "a@b.co", "pw123456")  // existing helper or inline
    token, err := s.issueBearer(context.Background(), uid, "App")
    if err != nil { t.Fatal(err) }
    for _, path := range []string{"/api/me", "/api/me/usage"} {
        req := httptest.NewRequest("GET", path, nil)
        req.Header.Set("Authorization", "Bearer "+token)
        rr := httptest.NewRecorder()
        s.Routes().ServeHTTP(rr, req)        // or the exact mux used in other tests
        if rr.Code != http.StatusOK {
            t.Fatalf("%s with bearer: got %d, want 200", path, rr.Code)
        }
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestBearerCanReadMeAndUsage -v`
Expected: FAIL with 401 (routes are `RequireSession`, which ignores the bearer header).

- [ ] **Step 3: Switch the two routes to `RequireAuth`**

In `server/internal/account/handlers.go`, change:

```go
	mux.HandleFunc("GET /api/me", s.RequireSession(s.handleMe))
	mux.HandleFunc("GET /api/me/usage", s.RequireSession(s.handleMeUsage))
```
to:
```go
	// RequireAuth (session cookie OR bearer) so native/app clients that hold a
	// rlm_cli_ bearer — not a session cookie — can read their own profile and
	// quota. Both are GET reads; bearer requests carry no ambient auth so there
	// is no CSRF surface. The web (cookie) path is unaffected: RequireAuth tries
	// the session cookie first.
	mux.HandleFunc("GET /api/me", s.RequireAuth(s.handleMe))
	mux.HandleFunc("GET /api/me/usage", s.RequireAuth(s.handleMeUsage))
```

(`handleMe`/`handleMeUsage` already have the `func(w, r, u User)` signature `RequireAuth` expects — no handler change needed. Leave the mutating device routes and everything else as `RequireSession`.)

- [ ] **Step 4: Run the test + the package suite**

Run: `cd server && go test ./internal/account/ -run TestBearerCanReadMeAndUsage -v` → PASS.
Then: `cd server && go test ./internal/account/` → all PASS (confirm no existing test regressed; the web session path still works because RequireAuth tries the cookie first).

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/handlers.go server/internal/account/native_test.go
git commit -m "feat(account): allow bearer auth on GET /api/me and /api/me/usage for native clients"
```

---

## Task 2: Swift — Account models + fixtures + directory-level resources

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Account/AccountModels.swift`
- Create: `apps/RelayiumKit/Tests/Fixtures/account/{login-success,login-unverified,login-pending-deletion,me,me-usage}.json`
- Modify: `apps/RelayiumKit/Package.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/AccountModelsTests.swift`

**Interfaces:**
- Produces:
  - `struct NativeUser: Codable, Equatable { id, email, displayName, hasPassword, emailVerified: Bool; planId, subscriptionStatus, billingCycle: String; ... }`
  - `struct MeResponse: Codable, Equatable { let user: NativeUser }`
  - `struct UsageResponse: Codable, Equatable { period: Int; resetsAt: Int64; traffic, storage: Meter; plan: PlanInfo }` with `struct Meter: Codable, Equatable { used, cap: Int64 }` and `struct PlanInfo: Codable, Equatable { id, name: String; storageBytes, trafficBytes, retentionSecs, priceMonthly, priceYearly: Int64; isTop: Bool; ... }`
  - `enum LoginOutcome: Equatable { case success(token: String, user: NativeUser); case emailUnverified(email: String); case pendingDeletion(purgeAfter: Int64, reactivateToken: String) }`
  - `enum AccountError: Error, Equatable { case invalidCredentials, rateLimited, server(status: Int), decoding, network }`

- [ ] **Step 1: Freeze the fixtures**

Create these files (exact server shapes; keep them minimal but complete). `apps/RelayiumKit/Tests/Fixtures/account/login-success.json`:

```json
{ "token": "rlm_cli_TESTTOKEN", "user": { "id": "u_1", "email": "a@b.co", "displayName": "Ada", "hasPassword": true, "emailVerified": true, "linkedMethods": ["password"], "onlyOwnNodes": false, "planId": "free", "subscriptionStatus": "", "subscriptionEnd": 0, "hasBilling": false, "scheduledPlanId": "", "scheduledCycle": "", "billingCycle": "" } }
```

`login-unverified.json`: `{ "error": "email_unverified", "email": "a@b.co" }`
`login-pending-deletion.json`: `{ "status": "pending_deletion", "purgeAfter": 1780000000, "reactivateToken": "react_abc" }`
`me.json`: `{ "user": { "id":"u_1","email":"a@b.co","displayName":"Ada","hasPassword":true,"emailVerified":true,"linkedMethods":["password"],"onlyOwnNodes":false,"planId":"pro","subscriptionStatus":"active","subscriptionEnd":1790000000,"hasBilling":true,"scheduledPlanId":"","scheduledCycle":"","billingCycle":"monthly" } }`
`me-usage.json`:

```json
{ "period": 678, "resetsAt": 1780000000,
  "traffic": { "used": 1048576, "cap": 5368709120 },
  "storage": { "used": 2097152, "cap": 0 },
  "plan": { "id":"pro","name":"Pro","storageBytes":10737418240,"trafficBytes":5368709120,"retentionSecs":604800,"priceMonthly":900,"priceYearly":9000,"isTop":false,"subscriptionStatus":"active","subscriptionEnd":1790000000,"billingCycle":"monthly","scheduledPlanId":"","scheduledPlanName":"","scheduledCycle":"" } }
```

- [ ] **Step 2: Switch Package.swift test resources to a directory rule**

In `apps/RelayiumKit/Package.swift`, replace the per-file resource list on the test target:
```swift
    resources: [.process("Fixtures/crypto-vectors.json"), .process("Fixtures/store-wire-vectors.json")]
```
with a single directory rule so all current and future fixtures (including `Fixtures/account/*.json`) are bundled:
```swift
    resources: [.process("Fixtures")]
```
`.process` on the directory copies every file under `Fixtures/` (flattening subfolders into the bundle root), so `Bundle.module.url(forResource: "me", withExtension: "json")` resolves regardless of the `account/` subfolder. (This also clears the R1-B deferred note about fragile per-file declarations.)

- [ ] **Step 3: Write the failing decoding test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/AccountModelsTests.swift`:

```swift
import XCTest
@testable import RelayiumKit

final class AccountModelsTests: XCTestCase {
    private func fixture<T: Decodable>(_ name: String, _ type: T.Type) throws -> T {
        let url = Bundle.module.url(forResource: name, withExtension: "json")!
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
    }
    func testDecodeMe() throws {
        let me = try fixture("me", MeResponse.self)
        XCTAssertEqual(me.user.email, "a@b.co")
        XCTAssertEqual(me.user.planId, "pro")
        XCTAssertEqual(me.user.billingCycle, "monthly")
        XCTAssertTrue(me.user.hasBilling)
    }
    func testDecodeUsageUnlimitedStorage() throws {
        let u = try fixture("me-usage", UsageResponse.self)
        XCTAssertEqual(u.traffic.cap, 5_368_709_120)
        XCTAssertEqual(u.storage.cap, 0)          // 0 = unlimited
        XCTAssertEqual(u.plan.name, "Pro")
        XCTAssertFalse(u.plan.isTop)
    }
    func testDecodeLoginSuccess() throws {
        let ok = try fixture("login-success", LoginSuccessBody.self)  // see AccountModels
        XCTAssertEqual(ok.token, "rlm_cli_TESTTOKEN")
        XCTAssertEqual(ok.user.planId, "free")
    }
}
```

- [ ] **Step 4: Run it to verify it fails**

Run: `swift test --filter AccountModelsTests`
Expected: FAIL — models undefined.

- [ ] **Step 5: Implement the models**

Create `apps/RelayiumKit/Sources/RelayiumKit/Account/AccountModels.swift`:

```swift
import Foundation

public struct NativeUser: Codable, Equatable {
    public var id: String
    public var email: String
    public var displayName: String
    public var hasPassword: Bool
    public var emailVerified: Bool
    public var linkedMethods: [String]
    public var onlyOwnNodes: Bool
    public var planId: String
    public var subscriptionStatus: String
    public var subscriptionEnd: Int64
    public var hasBilling: Bool
    public var scheduledPlanId: String
    public var scheduledCycle: String
    public var billingCycle: String
}

public struct MeResponse: Codable, Equatable { public let user: NativeUser }

public struct Meter: Codable, Equatable {
    public var used: Int64
    public var cap: Int64                      // 0 == unlimited
    public var isUnlimited: Bool { cap == 0 }
}

public struct PlanInfo: Codable, Equatable {
    public var id: String
    public var name: String
    public var storageBytes: Int64
    public var trafficBytes: Int64
    public var retentionSecs: Int64
    public var priceMonthly: Int64
    public var priceYearly: Int64
    public var isTop: Bool
    public var subscriptionStatus: String
    public var subscriptionEnd: Int64
    public var billingCycle: String
    public var scheduledPlanId: String
    public var scheduledPlanName: String
    public var scheduledCycle: String
}

public struct UsageResponse: Codable, Equatable {
    public var period: Int
    public var resetsAt: Int64
    public var traffic: Meter
    public var storage: Meter
    public var plan: PlanInfo
}

/// The 200-success login body (`{token, user}`). Decoded only on the 200 path.
public struct LoginSuccessBody: Codable, Equatable {
    public var token: String
    public var user: NativeUser
}

public enum LoginOutcome: Equatable {
    case success(token: String, user: NativeUser)
    case emailUnverified(email: String)
    case pendingDeletion(purgeAfter: Int64, reactivateToken: String)
}

public enum AccountError: Error, Equatable {
    case invalidCredentials      // 401
    case rateLimited             // 429
    case server(status: Int)     // other non-2xx
    case decoding                // body didn't match the expected shape
    case network                 // URLSession transport error
}
```

- [ ] **Step 6: Run it to verify it passes**

Run: `swift test --filter AccountModelsTests` → PASS. Then full `swift test` → all green (existing 31 + 3 new), and confirm the crypto/store-wire vectors STILL load after the `.process("Fixtures")` change (run `swift test --filter StoreKeyTests` and `--filter AeadTests` — both must pass, proving the directory resource rule didn't break existing fixture lookup).

- [ ] **Step 7: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Account/AccountModels.swift apps/RelayiumKit/Tests/Fixtures/account apps/RelayiumKit/Package.swift apps/RelayiumKit/Tests/RelayiumKitTests/AccountModelsTests.swift
git commit -m "feat(native): Account Codable models + fixtures; directory-level test resources"
```

---

## Task 3: Swift — `AccountClient.login` + URLProtocol stub

**Files:**
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/Support/StubURLProtocol.swift`
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Account/AccountClient.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/AccountClientTests.swift`

**Interfaces:**
- Consumes: models (Task 2).
- Produces:
  - `public struct AccountClient { init(baseURL: URL, session: URLSession = .shared) }`
  - `func login(email: String, password: String, deviceName: String) async throws -> LoginOutcome`

- [ ] **Step 1: Write the URLProtocol stub harness**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/Support/StubURLProtocol.swift`:

```swift
import Foundation

/// Intercepts URLSession requests and returns a canned (status, body). Install
/// via a URLSessionConfiguration whose protocolClasses = [StubURLProtocol].
final class StubURLProtocol: URLProtocol {
    struct Stub { let status: Int; let body: Data; let check: ((URLRequest) -> Void)? }
    nonisolated(unsafe) static var stub: Stub?
    nonisolated(unsafe) static var lastRequest: URLRequest?

    static func session() -> URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: cfg)
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lastRequest = request
        Self.stub?.check?(request)
        let s = Self.stub ?? Stub(status: 500, body: Data(), check: nil)
        let resp = HTTPURLResponse(url: request.url!, statusCode: s.status,
                                   httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: s.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/AccountClientTests.swift`:

```swift
import XCTest
@testable import RelayiumKit

final class AccountClientTests: XCTestCase {
    private func client() -> AccountClient {
        AccountClient(baseURL: URL(string: "https://relayium.test")!, session: StubURLProtocol.session())
    }
    private func data(_ name: String) throws -> Data {
        try Data(contentsOf: Bundle.module.url(forResource: name, withExtension: "json")!)
    }
    override func tearDown() { StubURLProtocol.stub = nil; StubURLProtocol.lastRequest = nil }

    func testLoginSuccess() async throws {
        StubURLProtocol.stub = .init(status: 200, body: try data("login-success"), check: { req in
            XCTAssertEqual(req.url?.path, "/api/auth/native/login")
            XCTAssertEqual(req.httpMethod, "POST")
        })
        let outcome = try await client().login(email: "a@b.co", password: "pw", deviceName: "Mac")
        guard case let .success(token, user) = outcome else { return XCTFail("want success") }
        XCTAssertEqual(token, "rlm_cli_TESTTOKEN")
        XCTAssertEqual(user.planId, "free")
    }
    func testLoginInvalidCredentials() async {
        StubURLProtocol.stub = .init(status: 401, body: Data(#"{"error":"invalid credentials"}"#.utf8), check: nil)
        await XCTAssertThrowsErrorAsync(try await self.client().login(email: "a@b.co", password: "x", deviceName: "Mac")) {
            XCTAssertEqual($0 as? AccountError, .invalidCredentials)
        }
    }
    func testLoginEmailUnverified() async throws {
        StubURLProtocol.stub = .init(status: 403, body: try data("login-unverified"), check: nil)
        let outcome = try await client().login(email: "a@b.co", password: "pw", deviceName: "Mac")
        XCTAssertEqual(outcome, .emailUnverified(email: "a@b.co"))
    }
    func testLoginPendingDeletion() async throws {
        StubURLProtocol.stub = .init(status: 200, body: try data("login-pending-deletion"), check: nil)
        let outcome = try await client().login(email: "a@b.co", password: "pw", deviceName: "Mac")
        XCTAssertEqual(outcome, .pendingDeletion(purgeAfter: 1_780_000_000, reactivateToken: "react_abc"))
    }
    func testLoginRateLimited() async {
        StubURLProtocol.stub = .init(status: 429, body: Data(#"{"error":"too many"}"#.utf8), check: nil)
        await XCTAssertThrowsErrorAsync(try await self.client().login(email: "a@b.co", password: "x", deviceName: "Mac")) {
            XCTAssertEqual($0 as? AccountError, .rateLimited)
        }
    }
}

/// Small async throwing-assert helper (XCTAssertThrowsError has no async form).
func XCTAssertThrowsErrorAsync<T>(_ expr: @autoclosure () async throws -> T,
                                  _ handler: (Error) -> Void, file: StaticString = #file, line: UInt = #line) async {
    do { _ = try await expr(); XCTFail("expected throw", file: file, line: line) }
    catch { handler(error) }
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `swift test --filter AccountClientTests`
Expected: FAIL — `AccountClient` undefined.

- [ ] **Step 4: Implement `AccountClient.login`**

Create `apps/RelayiumKit/Sources/RelayiumKit/Account/AccountClient.swift`:

```swift
import Foundation

public struct AccountClient {
    let baseURL: URL
    let session: URLSession
    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL; self.session = session
    }

    public func login(email: String, password: String, deviceName: String) async throws -> LoginOutcome {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/auth/native/login"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject:
            ["email": email, "password": password, "deviceName": deviceName])
        let (data, resp) = try await send(req)
        switch resp.statusCode {
        case 200:
            // 200 is EITHER success {token,user} OR pending_deletion {status,...}.
            if let pd = try? JSONDecoder().decode(PendingDeletionBody.self, from: data),
               pd.status == "pending_deletion" {
                return .pendingDeletion(purgeAfter: pd.purgeAfter, reactivateToken: pd.reactivateToken)
            }
            guard let ok = try? JSONDecoder().decode(LoginSuccessBody.self, from: data) else {
                throw AccountError.decoding
            }
            return .success(token: ok.token, user: ok.user)
        case 403:
            guard let b = try? JSONDecoder().decode(ErrorBody.self, from: data), b.error == "email_unverified" else {
                throw AccountError.server(status: 403)
            }
            return .emailUnverified(email: b.email ?? email)
        case 401: throw AccountError.invalidCredentials
        case 429: throw AccountError.rateLimited
        default:  throw AccountError.server(status: resp.statusCode)
        }
    }

    func send(_ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw AccountError.network }
            return (data, http)
        } catch let e as AccountError { throw e }
        catch { throw AccountError.network }
    }
}

private struct PendingDeletionBody: Decodable { let status: String; let purgeAfter: Int64; let reactivateToken: String }
private struct ErrorBody: Decodable { let error: String; let email: String? }
```

- [ ] **Step 5: Run it to verify it passes**

Run: `swift test --filter AccountClientTests` → PASS (5 tests). Full `swift test` → all green.

- [ ] **Step 6: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Account/AccountClient.swift apps/RelayiumKit/Tests/RelayiumKitTests/AccountClientTests.swift apps/RelayiumKit/Tests/RelayiumKitTests/Support/StubURLProtocol.swift
git commit -m "feat(native): AccountClient.login with status/body-aware outcome mapping"
```

---

## Task 4: Swift — `AccountClient.fetchMe` + `fetchUsage` (bearer)

**Files:**
- Modify: `apps/RelayiumKit/Sources/RelayiumKit/Account/AccountClient.swift`
- Modify: `apps/RelayiumKit/Tests/RelayiumKitTests/AccountClientTests.swift`

**Interfaces:**
- Consumes: `login` + models.
- Produces:
  - `func fetchMe(token: String) async throws -> NativeUser`
  - `func fetchUsage(token: String) async throws -> UsageResponse`

- [ ] **Step 1: Write the failing test**

Add to `AccountClientTests.swift`:

```swift
    func testFetchMeSendsBearerAndDecodes() async throws {
        StubURLProtocol.stub = .init(status: 200, body: try data("me"), check: { req in
            XCTAssertEqual(req.url?.path, "/api/me")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer rlm_cli_TESTTOKEN")
        })
        let user = try await client().fetchMe(token: "rlm_cli_TESTTOKEN")
        XCTAssertEqual(user.planId, "pro")
        XCTAssertEqual(user.subscriptionStatus, "active")
    }
    func testFetchUsageSendsBearerAndDecodes() async throws {
        StubURLProtocol.stub = .init(status: 200, body: try data("me-usage"), check: { req in
            XCTAssertEqual(req.url?.path, "/api/me/usage")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer rlm_cli_TESTTOKEN")
        })
        let u = try await client().fetchUsage(token: "rlm_cli_TESTTOKEN")
        XCTAssertTrue(u.storage.isUnlimited)
        XCTAssertEqual(u.plan.name, "Pro")
    }
    func testFetchMeUnauthorizedThrows() async {
        StubURLProtocol.stub = .init(status: 401, body: Data("unauthorized".utf8), check: nil)
        await XCTAssertThrowsErrorAsync(try await self.client().fetchMe(token: "bad")) {
            XCTAssertEqual($0 as? AccountError, .invalidCredentials)
        }
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `swift test --filter AccountClientTests/testFetchMeSendsBearerAndDecodes`
Expected: FAIL — `fetchMe` undefined.

- [ ] **Step 3: Implement fetchMe/fetchUsage**

Append to `AccountClient.swift`:

```swift
extension AccountClient {
    public func fetchMe(token: String) async throws -> NativeUser {
        try await authedGet("api/me", token: token, as: MeResponse.self).user
    }
    public func fetchUsage(token: String) async throws -> UsageResponse {
        try await authedGet("api/me/usage", token: token, as: UsageResponse.self)
    }

    private func authedGet<T: Decodable>(_ path: String, token: String, as: T.Type) async throws -> T {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "GET"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await send(req)
        switch resp.statusCode {
        case 200:
            guard let v = try? JSONDecoder().decode(T.self, from: data) else { throw AccountError.decoding }
            return v
        case 401: throw AccountError.invalidCredentials   // stale/invalid bearer
        case 429: throw AccountError.rateLimited
        default:  throw AccountError.server(status: resp.statusCode)
        }
    }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `swift test --filter AccountClientTests` → PASS (8 tests). Full `swift test` → all green.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Account/AccountClient.swift apps/RelayiumKit/Tests/RelayiumKitTests/AccountClientTests.swift
git commit -m "feat(native): AccountClient.fetchMe + fetchUsage with bearer auth"
```

---

## Task 5: Swift — `TokenStore` (protocol + in-memory + Keychain)

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumKit/Account/TokenStore.swift`
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/TokenStoreTests.swift`

**Interfaces:**
- Produces:
  - `public protocol TokenStore { func save(_ token: String) throws; func load() throws -> String?; func clear() throws }`
  - `public final class InMemoryTokenStore: TokenStore` (test/dev)
  - `public final class KeychainTokenStore: TokenStore { init(service: String, account: String) }` (real, `Security` framework, `kSecClassGenericPassword`)

- [ ] **Step 1: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/TokenStoreTests.swift`:

```swift
import XCTest
@testable import RelayiumKit

final class TokenStoreTests: XCTestCase {
    func testInMemoryRoundTrip() throws {
        let s = InMemoryTokenStore()
        XCTAssertNil(try s.load())
        try s.save("rlm_cli_x")
        XCTAssertEqual(try s.load(), "rlm_cli_x")
        try s.save("rlm_cli_y")           // overwrite
        XCTAssertEqual(try s.load(), "rlm_cli_y")
        try s.clear()
        XCTAssertNil(try s.load())
    }
    func testKeychainRoundTripIfAvailable() throws {
        let s = KeychainTokenStore(service: "com.relayium.mac.test", account: "bearer")
        try? s.clear()
        do {
            try s.save("rlm_cli_kc")
        } catch {
            throw XCTSkip("keychain unavailable in this test host: \(error)")
        }
        XCTAssertEqual(try s.load(), "rlm_cli_kc")
        try s.clear()
        XCTAssertNil(try s.load())
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `swift test --filter TokenStoreTests`
Expected: FAIL — types undefined.

- [ ] **Step 3: Implement TokenStore**

Create `apps/RelayiumKit/Sources/RelayiumKit/Account/TokenStore.swift`:

```swift
import Foundation
import Security

public protocol TokenStore {
    func save(_ token: String) throws
    func load() throws -> String?
    func clear() throws
}

public final class InMemoryTokenStore: TokenStore {
    private var token: String?
    public init() {}
    public func save(_ token: String) throws { self.token = token }
    public func load() throws -> String? { token }
    public func clear() throws { token = nil }
}

public enum KeychainError: Error, Equatable { case status(OSStatus) }

/// Bearer token persistence in the login keychain as a generic-password item.
public final class KeychainTokenStore: TokenStore {
    private let service: String
    private let account: String
    public init(service: String, account: String) { self.service = service; self.account = account }

    private var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    public func save(_ token: String) throws {
        let data = Data(token.utf8)
        SecItemDelete(baseQuery as CFDictionary)      // idempotent overwrite
        var add = baseQuery
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.status(status) }
    }

    public func load() throws -> String? {
        var q = baseQuery
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = out as? Data else { throw KeychainError.status(status) }
        return String(data: data, encoding: .utf8)
    }

    public func clear() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError.status(status) }
    }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `swift test --filter TokenStoreTests` → PASS (in-memory always; keychain passes or SKIPs gracefully). Full `swift test` → all green.

> If the keychain test SKIPS in the SPM test host (no app bundle / entitlement), that is expected and acceptable — the `KeychainTokenStore` is exercised for real by the macOS app in R1-G. The in-memory store is what the other modules' tests use.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Account/TokenStore.swift apps/RelayiumKit/Tests/RelayiumKitTests/TokenStoreTests.swift
git commit -m "feat(native): TokenStore protocol + in-memory + Keychain implementations"
```

---

## Self-review (against the spec)

- **Spec coverage:** server bearer-enable for `/api/me`+`/api/me/usage` → Task 1; Codable models mirroring the exact Go shapes → Task 2; `login` with 200/401/403/429/pending_deletion mapping → Task 3; bearer-authed `fetchMe`/`fetchUsage` → Task 4; Keychain token persistence → Task 5. `cap==0`→unlimited modelled in `Meter.isUnlimited`. Directory-level test resources (clears R1-B deferred note) → Task 2 Step 2.
- **Placeholder scan:** none — every code step carries complete code. Task 1's Go test uses the package's existing helper names (`newTestService`/`seedVerifiedUser`) which the implementer must map to the real helpers in `internal/account/*_test.go` — flagged explicitly as "adapt to the package's existing helpers," not a silent gap.
- **Type consistency:** `NativeUser`, `MeResponse`, `UsageResponse`, `Meter`, `PlanInfo`, `LoginSuccessBody`, `LoginOutcome`, `AccountError` defined once (Task 2) and reused (Tasks 3–4). `AccountClient` (Task 3) extended in Task 4. `TokenStore` (Task 5) is independent. `StubURLProtocol` (Task 3) reused in Task 4. Field names match the Go handlers verbatim.

## Interop / correctness safety

Unlike Crypto/StoredWire (byte-exact wire), Account speaks JSON APIs, so the safety net is: (1) Codable field names copied verbatim from the Go handlers and pinned by fixtures frozen from those exact shapes; (2) the `URLProtocol` stub asserts the request path, method, and `Authorization` header so a wrong endpoint/verb/missing-bearer fails a test; (3) the server change has a Go test proving bearer reads return 200 and the existing session path still works. The one thing tests cannot catch is server drift — if the Go handler shape changes, the fixtures must be re-frozen (call it out in R1-G when wiring the real UI).

## Next

R1-D (`Cloud`): stream the R1-B `StoredWire` codec over `URLSession` background sessions to the stored-transfer upload/download endpoints, authenticating with the bearer token this module persists, following 302s to nodes — the first working native transfer, interoperable with web/CLI `#k=` links.
