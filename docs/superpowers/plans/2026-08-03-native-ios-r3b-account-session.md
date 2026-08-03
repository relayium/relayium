# Native iOS R3-B — account session — Implementation Plan

Date: 2026-08-03

**Goal:** Add a native iOS account tab — password sign-in, launch restore, the
in-flight/rejected/unverified/pending-deletion/unavailable states, a read-only
usage summary, refresh and safe sign-out — beside the anonymous stored-link
receive R3-A shipped, without gating that receive on an account.

**Architecture:** The macOS account stack, reused whole. `AccountSession`,
`AccountClient`, `UsagePresentation`, `ErrorCopy` and `L10n` are unchanged
behaviorally; the package gains two small, pure, testable types — a per-platform
keychain configuration and a sign-in form-state derivation — and the iOS app
target gains four view files. The session switch lives inside the account tab
only; nothing above the tab bar reads `session.state`.

**Tech stack:** Swift 5.9 / SwiftPM local package, SwiftUI lifecycle, iOS 16
minimum, XCTest.

**Spec:** `docs/superpowers/specs/2026-08-03-native-ios-r3b-account-session-design.md`

## Global constraints

- **The macOS keychain identity does not move.** `com.relayium.mac` /
  `bearer-token` / `7PVYUG4YQS.com.relayium.shared`, byte for byte, for the
  bearer token *and* the stored-link key store that shares that service.
- **iOS names no access group.** Service `com.relayium.app`, account
  `bearer-token`, `accessGroup` **nil**. `apps/ios/Relayium/Relayium.entitlements`
  stays an empty `<dict/>`.
- **Anonymous receive survives.** The receive tab is rendered unconditionally,
  references no `AccountSession`, and its requests carry no `Authorization`
  header.
- **No credential in a log or a URL.** No `print`, `NSLog`, `os_log`,
  `debugPrint` or `dump` anywhere in `apps/ios/Relayium` or
  `Sources/RelayiumAppKit`. The reactivation token stays in the URL **fragment**
  and the URL keeps no query component.
- **No dead controls.** Sign in with Apple, browser/device login, device
  management, stored-file management, upload/send, realtime/LAN, Universal
  Links, Share Extension, background `URLSession`, notifications and IAP are out
  of scope and must not appear as disabled, greyed or "coming soon" anything.
- **Nine languages, always.** Every new string lands in all nine catalogs in the
  same commit. `Info.plist`'s `CFBundleLocalizations` is unchanged. No
  user-facing English literal in Swift sources; a genuinely verbatim literal
  carries `// nonlocalized: <reason>`.
- **Layout by construction.** No fixed font sizes, no fixed frames, no
  left/right — leading/trailing only.
- **No availability claim.** No `DEVELOPMENT_TEAM`, no provisioning profile, no
  new entitlement, no signing. `apps/mac/release-readiness.json` stays
  `approved: false`. No web, server, AASA or `relayium-ops` change.
- **English commit messages**, one per task.

## File structure

| File | Responsibility |
|---|---|
| `apps/RelayiumKit/Sources/RelayiumAppKit/KeychainConfiguration.swift` | **new** — where a credential lives, as data; `KeychainConfiguration` + `KeychainPlatform` |
| `apps/RelayiumKit/Sources/RelayiumAppKit/SignInPresentation.swift` | **new** — which session states the sign-in form owns, and what it shows |
| `apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift` | the per-platform factory; `makeSession`/`makeStoredLinkKeyStore` wired through it |
| `apps/RelayiumKit/Sources/RelayiumKit/Account/TokenStore.swift` | **comment only** — its `accessGroup` doc says the app always passes the shared group, which stops being true |
| `apps/RelayiumKit/Sources/RelayiumKit/Account/StoredLinkKeyStore.swift` | **comment only** — the same stale sentence on its initializer |
| `apps/RelayiumKit/Sources/RelayiumAppKit/Localization/L10nKey.swift` | three new keys |
| `apps/RelayiumKit/Sources/RelayiumAppKit/Resources/*.lproj/Localizable.strings` | those three keys ×9, and one corrected string ×9 |
| `apps/ios/Relayium/RelayiumApp.swift` | app-scoped `AccountSession`, root is `RootView` |
| `apps/ios/Relayium/RootView.swift` | **new** — the two-tab shell; never reads `session.state` |
| `apps/ios/Relayium/AccountTab.swift` | **new** — the whole session switch |
| `apps/ios/Relayium/SignInView.swift` | **new** — the form, one call site |
| `apps/ios/Relayium/AccountSummaryView.swift` | **new** — the ready state, read-only |
| `apps/RelayiumKit/Tests/RelayiumKitTests/AppEnvironmentTests.swift` | keychain policy, both platforms, on either host |
| `apps/RelayiumKit/Tests/RelayiumKitTests/SignInPresentationTests.swift` | **new** — the form-state mapping |
| `apps/RelayiumKit/Tests/RelayiumKitTests/AccountSessionTests.swift` | sign-out failure, stale launch restore, credentials never in a URL |
| `apps/RelayiumKit/Tests/RelayiumKitTests/CloudDownloadModelTests.swift` | anonymous receive sends no credential |
| `apps/RelayiumKit/Tests/RelayiumKitTests/LocalizedCopyTests.swift` | the corrected string, and a Mac-free account surface in nine languages |
| `apps/RelayiumKit/Tests/RelayiumKitTests/IOSSurfaceGuardTests.swift` | **new** — logging, deferred features, the nineteen platform-naming keys, form and launch-restore call sites, entitlements |
| `README.md` | truthful delivery status |

`apps/ios/Relayium.xcodeproj` needs **no** edit: the target uses a
`PBXFileSystemSynchronizedRootGroup`, so the four new Swift files are picked up
by path. `.github/workflows/macos.yml` needs no edit either — its `ios-build`
job already triggers on `apps/**`.

## Tasks

### Task 1: Per-platform keychain configuration

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/KeychainConfiguration.swift`
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift`
- Modify (comment only): `apps/RelayiumKit/Sources/RelayiumKit/Account/TokenStore.swift`
- Modify (comment only): `apps/RelayiumKit/Sources/RelayiumKit/Account/StoredLinkKeyStore.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/AppEnvironmentTests.swift`

**Interfaces:**
- Produces: `KeychainConfiguration(service:account:accessGroup:)`,
  `KeychainPlatform.macOS/.iOS`,
  `AppEnvironment.keychainConfiguration(for:) -> KeychainConfiguration`,
  `AppEnvironment.currentKeychainPlatform`,
  `AppEnvironment.keychainConfiguration`,
  `AppEnvironment.makeTokenStore(_:) -> KeychainTokenStore`,
  `AppEnvironment.makeStoredLinkKeyStore(_:) -> KeychainStoredLinkKeyStore`
  (both factories default to `keychainConfiguration`, so existing no-argument
  call sites are source-compatible).

- [ ] **Step 1: Write the failing tests**

Append to `AppEnvironmentTests.swift`, and add `import Security` plus
`@testable import RelayiumKit` at the top of that file (it currently imports
only `RelayiumAppKit`; `baseQuery` and `query(for:)` are internal seams in
`RelayiumKit`):

```swift
    // The macOS row cannot move: every existing installation's bearer token and
    // every stored-link key it saved lives under exactly these values.
    func testMacKeychainConfigurationIsTheHistoricalIdentity() {
        let c = AppEnvironment.keychainConfiguration(for: .macOS)
        XCTAssertEqual(c.service, "com.relayium.mac")
        XCTAssertEqual(c.account, "bearer-token")
        XCTAssertEqual(c.accessGroup, "7PVYUG4YQS.com.relayium.shared")
    }

    // iOS carries no keychain-access-groups entitlement, so naming a group
    // would be refused on a signed device build — and would claim a cross-app
    // credential share that does not exist.
    func testIOSKeychainConfigurationNamesTheAppAndNoAccessGroup() {
        let c = AppEnvironment.keychainConfiguration(for: .iOS)
        XCTAssertEqual(c.service, "com.relayium.app")
        XCTAssertEqual(c.account, "bearer-token")
        XCTAssertNil(c.accessGroup)
    }

    func testThePlatformsShareTheAccountAndDifferInService() {
        let mac = AppEnvironment.keychainConfiguration(for: .macOS)
        let ios = AppEnvironment.keychainConfiguration(for: .iOS)
        XCTAssertEqual(mac.account, ios.account)
        XCTAssertNotEqual(mac.service, ios.service)
    }

    // Every platform has a decision, and only the entitled one names a group.
    // Iterating allCases is what stops a future platform from being added
    // without one.
    func testEveryPlatformHasACompleteConfiguration() {
        for platform in KeychainPlatform.allCases {
            let c = AppEnvironment.keychainConfiguration(for: platform)
            XCTAssertFalse(c.service.isEmpty, "\(platform)")
            XCTAssertFalse(c.account.isEmpty, "\(platform)")
            if platform != .macOS {
                XCTAssertNil(c.accessGroup, "\(platform) must not name an access group")
            }
        }
    }

    // The dictionary the Security framework actually receives, for a platform
    // this host is not running.
    func testTokenStoreQueryOmitsTheAccessGroupOnIOS() {
        let store = AppEnvironment.makeTokenStore(AppEnvironment.keychainConfiguration(for: .iOS))
        XCTAssertEqual(store.baseQuery[kSecAttrService as String] as? String, "com.relayium.app")
        XCTAssertEqual(store.baseQuery[kSecAttrAccount as String] as? String, "bearer-token")
        XCTAssertNil(store.baseQuery[kSecAttrAccessGroup as String])
    }

    func testTokenStoreQueryCarriesTheTeamGroupOnMac() {
        let store = AppEnvironment.makeTokenStore(AppEnvironment.keychainConfiguration(for: .macOS))
        XCTAssertEqual(store.baseQuery[kSecAttrService as String] as? String, "com.relayium.mac")
        XCTAssertEqual(store.baseQuery[kSecAttrAccessGroup as String] as? String,
                       "7PVYUG4YQS.com.relayium.shared")
    }

    // The one host-dependent fact in the whole policy, kept to one assertion.
    func testCurrentPlatformMatchesTheCompiledPlatform() {
        #if os(iOS)
        XCTAssertEqual(AppEnvironment.currentKeychainPlatform, .iOS)
        #else
        XCTAssertEqual(AppEnvironment.currentKeychainPlatform, .macOS)
        #endif
    }

    // The stored-link keys share the bearer's service — the id charset refuses
    // separators specifically so no id can compose the bearer's account name.
    // One configuration is what keeps that relationship true on both platforms
    // instead of a future iOS upload slice inventing a second service.
    //
    // Both rows are asserted from THIS host, like the bearer's: a stored-link
    // query reachable only from the platform that runs it is exactly the half of
    // the policy that would go unchecked until someone shipped it.
    func testStoredLinkKeyQueryOnMacIsTheHistoricalIdentity() throws {
        let q = try AppEnvironment
            .makeStoredLinkKeyStore(AppEnvironment.keychainConfiguration(for: .macOS))
            .query(for: "0123456789abcdef0123456789abcdef")
        XCTAssertEqual(q[kSecAttrService as String] as? String, "com.relayium.mac")
        XCTAssertEqual(q[kSecAttrAccessGroup as String] as? String,
                       "7PVYUG4YQS.com.relayium.shared")
    }

    func testStoredLinkKeyQueryOnIOSOmitsTheAccessGroup() throws {
        let q = try AppEnvironment
            .makeStoredLinkKeyStore(AppEnvironment.keychainConfiguration(for: .iOS))
            .query(for: "0123456789abcdef0123456789abcdef")
        XCTAssertEqual(q[kSecAttrService as String] as? String, "com.relayium.app")
        XCTAssertNil(q[kSecAttrAccessGroup as String])
    }

    // And the no-argument call the app actually makes resolves to this host's
    // row, so the wiring is covered and not just the table.
    func testStoredLinkKeyStoreDefaultsToTheCurrentPlatform() throws {
        let q = try AppEnvironment.makeStoredLinkKeyStore()
            .query(for: "0123456789abcdef0123456789abcdef")
        XCTAssertEqual(q[kSecAttrService as String] as? String,
                       AppEnvironment.keychainConfiguration.service)
        XCTAssertEqual(q[kSecAttrAccessGroup as String] as? String,
                       AppEnvironment.keychainConfiguration.accessGroup)
    }

    // "In the fragment" and "not in the query" are different claims, and only
    // the second one keeps the token out of the server's access log.
    func testReactivateURLPutsNothingInTheQuery() {
        let url = AppEnvironment.reactivateWebURL(token: "react_abc")
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        XCTAssertNil(components?.query)
        XCTAssertEqual(components?.fragment?.contains("react_abc"), true)
    }
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/RelayiumKit && swift test --filter AppEnvironmentTests`
Expected: compile failure — `KeychainPlatform`, `keychainConfiguration(for:)`,
`makeTokenStore`, `currentKeychainPlatform` are undefined, and
`makeStoredLinkKeyStore` takes no argument and returns the `StoredLinkKeyStore`
protocol, which has no `query(for:)`.

- [ ] **Step 3: Add the configuration type**

Create `apps/RelayiumKit/Sources/RelayiumAppKit/KeychainConfiguration.swift`:

```swift
import Foundation

/// Where a bearer credential lives in the data-protection keychain.
///
/// A value rather than three loose constants because the answer is per
/// platform, and a per-platform answer spread across `#if` at each call site is
/// one no test can read. Everything here is inert data; the only compile-time
/// conditional in the whole policy is `AppEnvironment.currentKeychainPlatform`.
public struct KeychainConfiguration: Equatable, Sendable {
    public let service: String
    public let account: String
    /// `nil` means "this app's own default access group", which is the ONLY
    /// correct value on a host carrying no `keychain-access-groups` entitlement:
    /// naming a group without it fails with `errSecMissingEntitlement` (-34018)
    /// on a signed device build, and claims a cross-app credential share that
    /// does not exist.
    public let accessGroup: String?

    public init(service: String, account: String, accessGroup: String?) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }
}

/// The platforms the Relayium apps run on, as data.
///
/// `CaseIterable` so a test can prove every platform has a decision rather than
/// only the two somebody remembered to assert.
public enum KeychainPlatform: String, CaseIterable, Sendable {
    case macOS
    case iOS
}
```

- [ ] **Step 4: Wire `AppEnvironment` to it**

In `AppEnvironment.swift`, keep the three existing constants exactly as they are
— they are the macOS row's single source of literals, and the assertions that
pin them must keep passing — and add beside them:

```swift
    /// The iOS credential identity: this app's own bundle id, and NO access
    /// group. See `KeychainConfiguration.accessGroup`.
    public static let iosKeychainService = "com.relayium.app"

    public static func keychainConfiguration(for platform: KeychainPlatform) -> KeychainConfiguration {
        switch platform {
        case .macOS:
            return KeychainConfiguration(service: keychainService,
                                         account: keychainAccount,
                                         accessGroup: keychainAccessGroup)
        case .iOS:
            return KeychainConfiguration(service: iosKeychainService,
                                         account: keychainAccount,
                                         accessGroup: nil)
        }
    }

    /// The one compile-time conditional in the keychain policy.
    public static var currentKeychainPlatform: KeychainPlatform {
        #if os(iOS)
        return .iOS
        #else
        return .macOS
        #endif
    }

    public static var keychainConfiguration: KeychainConfiguration {
        keychainConfiguration(for: currentKeychainPlatform)
    }

    /// Built through the configuration so a test can assert the keychain query
    /// for a platform it is not running on.
    public static func makeTokenStore(
        _ configuration: KeychainConfiguration = keychainConfiguration
    ) -> KeychainTokenStore {
        KeychainTokenStore(service: configuration.service,
                           account: configuration.account,
                           accessGroup: configuration.accessGroup)
    }
```

Then replace the two construction sites:

```swift
    @MainActor
    public static func makeSession(baseURL: URL = productionBaseURL) -> AccountSession {
        AccountSession(
            client: AccountClient(baseURL: baseURL),
            tokenStore: makeTokenStore(),
            deviceName: deviceName()
        )
    }
```

```swift
    /// Takes a configuration for the same reason `makeTokenStore` does: both
    /// platforms' Security dictionaries have to be assertable from one host.
    /// The default is this platform's, so the app's call site does not change.
    public static func makeStoredLinkKeyStore(
        _ configuration: KeychainConfiguration = keychainConfiguration
    ) -> KeychainStoredLinkKeyStore {
        KeychainStoredLinkKeyStore(service: configuration.service,
                                   accessGroup: configuration.accessGroup)
    }
```

The concrete return type is what makes the wiring assertable; `KeychainStoredLinkKeyStore`
conforms to `StoredLinkKeyStore`, so `makeUploadModel(keyStore:)` and
`makeAccountManagementModel(keyStore:)` take it unchanged, and the existing
no-argument call in `apps/mac/Relayium/RelayiumApp.swift` still compiles as
written. On macOS both factories resolve to the identical values they pass today.

- [ ] **Step 5: Correct three comments this makes false**

Comment-only; no behavior changes. Each currently tells the next reader the
opposite of the new policy, which is worse than saying nothing.

In `apps/RelayiumKit/Sources/RelayiumKit/Account/TokenStore.swift`, replace the
`accessGroup` doc on `KeychainTokenStore.init`:

```swift
    /// `accessGroup` is nil-able because plenty of hosts have no entitlement to
    /// name one: the SPM test host, and the iOS app, which ships no
    /// `keychain-access-groups` entitlement and deliberately keeps its bearer in
    /// its own default group. The macOS app passes the shared team group. Both
    /// values come from `AppEnvironment.keychainConfiguration`.
```

In `apps/RelayiumKit/Sources/RelayiumKit/Account/StoredLinkKeyStore.swift`,
replace the matching doc on `KeychainStoredLinkKeyStore.init`:

```swift
    /// `accessGroup` is nil-able for the same reason as `KeychainTokenStore`'s:
    /// the SPM test host has no entitlement to name one, and neither does the
    /// iOS app, which keeps these keys in its own default group under its own
    /// service. macOS passes the shared team group. Both values come from
    /// `AppEnvironment.keychainConfiguration`, so these keys share the bearer
    /// token's service on whichever platform is running.
```

In `apps/RelayiumKit/Tests/RelayiumKitTests/AppEnvironmentTests.swift`, replace
the comment inside the existing `testKeychainAccessGroupIsTheSharedTeamGroup`
(the assertion itself does not change):

```swift
        // Shared, not the default per-app group — a macOS-only decision. The
        // iOS app does NOT read this credential: it carries no
        // keychain-access-groups entitlement and keeps its own bearer under
        // `com.relayium.app` with no group. Changing this value would cost every
        // existing macOS installation a data migration.
```

Leave every other Mac-mentioning comment and all user-facing Mac copy alone —
`StoredLinkKeyStore`'s type doc quotes the `account.keyNotOnThisMac` wording,
which is macOS copy Task 3 deliberately does not touch.

- [ ] **Step 6: Run the tests**

Run: `cd apps/RelayiumKit && swift test --filter AppEnvironmentTests`
Expected: PASS, including the four pre-existing constant assertions, unchanged.

- [ ] **Step 7: Run the whole suite**

Run: `cd apps/RelayiumKit && swift test`
Expected: PASS. `TokenStoreTests`, `StoredLinkKeyStoreTests` and the macOS app
build are unaffected; only the documented opt-in real-Keychain test may skip.

- [ ] **Step 8: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumAppKit/KeychainConfiguration.swift \
        apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift \
        apps/RelayiumKit/Sources/RelayiumKit/Account/TokenStore.swift \
        apps/RelayiumKit/Sources/RelayiumKit/Account/StoredLinkKeyStore.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/AppEnvironmentTests.swift
git commit -m "feat(apps): resolve the keychain identity per platform"
```

### Task 2: Sign-in form state

**Files:**
- Create: `apps/RelayiumKit/Sources/RelayiumAppKit/SignInPresentation.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/SignInPresentationTests.swift`

**Interfaces:**
- Consumes: `SessionState` (unchanged).
- Produces: `SignInFormState(errorMessage:isBusy:)`,
  `SignInPresentation.form(for:) -> SignInFormState?`.

- [ ] **Step 1: Write the failing test**

Create `apps/RelayiumKit/Tests/RelayiumKitTests/SignInPresentationTests.swift`:

```swift
import XCTest
import RelayiumKit
@testable import RelayiumAppKit

/// The form is ONE view across "typing", "signing in" and "that was wrong",
/// because its email and password are `@State` and each branch of a SwiftUI
/// `switch` is a distinct structural identity — a second branch blanks both
/// fields on every wrong password. Making that one `if let` in the view means
/// the decision lives here, where these assertions can reach it.
final class SignInPresentationTests: XCTestCase {
    private func fixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json"))
        return try JSONDecoder().decode(type, from: try Data(contentsOf: url))
    }

    private func readyState() throws -> SessionState {
        let me = try fixture("me", as: MeResponse.self)
        let usage = try fixture("me-usage", as: UsageResponse.self)
        return .ready(user: me.user, usage: usage)
    }

    func testTheFormOwnsExactlyThreeStates() throws {
        XCTAssertNotNil(SignInPresentation.form(for: .loggedOut))
        XCTAssertNotNil(SignInPresentation.form(for: .authenticating))
        XCTAssertNotNil(SignInPresentation.form(for: .failed(message: "nope")))

        XCTAssertNil(SignInPresentation.form(for: .restoring))
        XCTAssertNil(SignInPresentation.form(for: .emailUnverified(email: "a@b.co")))
        XCTAssertNil(SignInPresentation.form(for: .pendingDeletion(purgeAfter: 1,
                                                                  reactivateToken: "t")))
        XCTAssertNil(SignInPresentation.form(for: .unavailable(message: "down")))
        XCTAssertNil(SignInPresentation.form(for: try readyState()))
    }

    func testOnlyAnInFlightAttemptIsBusy() {
        XCTAssertEqual(SignInPresentation.form(for: .authenticating)?.isBusy, true)
        XCTAssertEqual(SignInPresentation.form(for: .loggedOut)?.isBusy, false)
        XCTAssertEqual(SignInPresentation.form(for: .failed(message: "nope"))?.isBusy, false)
    }

    // The message is the rejection the session carries, verbatim — the form does
    // not invent, translate or summarise it.
    func testOnlyARejectedAttemptCarriesAMessage() {
        XCTAssertEqual(SignInPresentation.form(for: .failed(message: "wrong password"))?.errorMessage,
                       "wrong password")
        XCTAssertNil(SignInPresentation.form(for: .loggedOut)?.errorMessage)
        XCTAssertNil(SignInPresentation.form(for: .authenticating)?.errorMessage)
    }

    // A busy form must never also be showing the previous attempt's rejection:
    // the fields are disabled and a request is in flight, so the error is about
    // something that is no longer happening.
    func testABusyFormShowsNoStaleRejection() {
        let busy = SignInPresentation.form(for: .authenticating)
        XCTAssertEqual(busy?.isBusy, true)
        XCTAssertNil(busy?.errorMessage)
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/RelayiumKit && swift test --filter SignInPresentationTests`
Expected: compile failure — `SignInPresentation` is undefined.

- [ ] **Step 3: Write the implementation**

Create `apps/RelayiumKit/Sources/RelayiumAppKit/SignInPresentation.swift`:

```swift
import Foundation

/// What the sign-in form should show, derived from the session state.
public struct SignInFormState: Equatable {
    /// The reason the last attempt was rejected, or `nil` when there is nothing
    /// to report.
    public let errorMessage: String?
    /// An attempt is in flight: the fields stay on screen, disabled, and the
    /// button is replaced in place rather than by a sibling view.
    public let isBusy: Bool

    public init(errorMessage: String?, isBusy: Bool) {
        self.errorMessage = errorMessage
        self.isBusy = isBusy
    }
}

/// The three states the sign-in form owns, and the five it does not.
///
/// This exists so the form has exactly ONE call site. Its typed email and
/// password are `@State`, and each branch of a SwiftUI `switch` is a distinct
/// structural identity — so rendering "signing in" from a second branch tears
/// the form down and rebuilds it, blanking both fields on every wrong password.
/// The macOS app keeps the three together by hand and explains it in a comment;
/// putting the decision here makes it one `if let` in the view, and makes the
/// mapping something `swift test` can read.
public enum SignInPresentation {
    /// Non-nil for exactly the three states the form owns. Exhaustive rather
    /// than `default:`, so a new `SessionState` case cannot silently fall into
    /// "show the form".
    public static func form(for state: SessionState) -> SignInFormState? {
        switch state {
        case .loggedOut:
            return SignInFormState(errorMessage: nil, isBusy: false)
        case .authenticating:
            return SignInFormState(errorMessage: nil, isBusy: true)
        case let .failed(message):
            return SignInFormState(errorMessage: message, isBusy: false)
        case .restoring, .emailUnverified, .pendingDeletion, .ready, .unavailable:
            return nil
        }
    }
}
```

- [ ] **Step 4: Run the test**

Run: `cd apps/RelayiumKit && swift test --filter SignInPresentationTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumAppKit/SignInPresentation.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/SignInPresentationTests.swift
git commit -m "feat(apps): derive the sign-in form state from the session"
```

### Task 3: Copy

**Files:**
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/Localization/L10nKey.swift`
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/Resources/{en,zh-Hans,ja,ko,de,fr,ar,es,pt}.lproj/Localizable.strings`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/LocalizedCopyTests.swift`

**Interfaces:**
- Produces: `L10nKey.tabReceive`, `.accountRestoring`, `.loginSigningIn`.

- [ ] **Step 1: Add the three keys to the canon**

In `L10nKey.swift`, beside their siblings:

```swift
    /// The iOS receive tab. `tab.link` labels a macOS tab that both sends and
    /// receives; this one only receives, and `download.heading`
    /// ("Receive files") is a screen title, too long for a tab item.
    case tabReceive = "tab.receive"
```
immediately after `case tabLink = "tab.link"`.

```swift
    /// Launch restore. macOS shows a bare `ProgressView`; a full-screen touch
    /// state needs a label, and VoiceOver reads nothing from a bare spinner.
    /// Same sentence as `menubar.loadingAccount` under a key that names the
    /// right surface.
    case accountRestoring = "account.restoring"
```
immediately after `case accountStaleFigures = "account.staleFigures"`.

```swift
    /// A sign-in in flight, for the same reason as `account.restoring`.
    case loginSigningIn = "login.signingIn"
```
immediately after `case loginSignIn = "login.signIn"`.

- [ ] **Step 2: Add the three strings to all nine catalogs**

`tab.receive` goes immediately after each catalog's `"tab.link"` line;
`login.signingIn` immediately after `"login.signIn"`; `account.restoring`
immediately after `"account.staleFigures"`. The two progress strings take their
`menubar.*` counterparts' wording verbatim, so the product does not acquire two
ways of saying one thing.

```
en:      "tab.receive" = "Receive";
         "login.signingIn" = "Signing in…";
         "account.restoring" = "Loading your account…";
zh-Hans: "tab.receive" = "接收";
         "login.signingIn" = "正在登录…";
         "account.restoring" = "正在载入账户…";
ja:      "tab.receive" = "受信";
         "login.signingIn" = "サインインしています…";
         "account.restoring" = "アカウントを読み込んでいます…";
ko:      "tab.receive" = "받기";
         "login.signingIn" = "로그인하는 중…";
         "account.restoring" = "계정을 불러오는 중…";
de:      "tab.receive" = "Empfangen";
         "login.signingIn" = "Anmeldung läuft…";
         "account.restoring" = "Konto wird geladen…";
fr:      "tab.receive" = "Recevoir";
         "login.signingIn" = "Connexion en cours…";
         "account.restoring" = "Chargement de votre compte…";
ar:      "tab.receive" = "استلام";
         "login.signingIn" = "جارٍ تسجيل الدخول…";
         "account.restoring" = "جارٍ تحميل حسابك…";
es:      "tab.receive" = "Recibir";
         "login.signingIn" = "Iniciando sesión…";
         "account.restoring" = "Cargando tu cuenta…";
pt:      "tab.receive" = "Receber";
         "login.signingIn" = "A iniciar sessão…";
         "account.restoring" = "A carregar a sua conta…";
```

- [ ] **Step 3: Correct the one Mac string an iOS surface already reaches**

`error.manifest.duplicatePath` is raised by manifest path validation during a
**receive**, so R3-A already made it reachable on iOS. Its substance is true on
both platforms; only the noun is wrong. Correct it **in place** in all nine
catalogs — the shared key, not a second `.ios` key — so macOS's wording moves to
something equally true there rather than the product carrying two translations
of one sentence that differ by a noun. Replace each existing line with:

```
en:      "error.manifest.duplicatePath" = "The transfer contains more than one file at “%@” — on this device those are the same file — so nothing was saved. Ask the sender to rename one of them.";
zh-Hans: "error.manifest.duplicatePath" = "这次传输在“%@”上包含了不止一个文件 — 在这台设备上它们是同一个文件 — 因此什么都没有保存。请让发送方为其中一个改名。";
ja:      "error.manifest.duplicatePath" = "この転送には「%@」のファイルが複数含まれています — このデバイスではそれらは同一のファイルです — そのため何も保存されませんでした。送信者にどちらかの名前を変えてもらってください。";
ko:      "error.manifest.duplicatePath" = "이 전송에는 “%@”에 해당하는 파일이 둘 이상 있습니다 — 이 기기에서는 같은 파일입니다 — 그래서 아무것도 저장하지 않았습니다. 보낸 사람에게 하나의 이름을 바꿔 달라고 하세요.";
de:      "error.manifest.duplicatePath" = "Die Übertragung enthält mehr als eine Datei unter „%@“ — auf diesem Gerät sind das dieselbe Datei — deshalb wurde nichts gesichert. Bitte die sendende Seite, eine davon umzubenennen.";
fr:      "error.manifest.duplicatePath" = "Le transfert contient plusieurs fichiers à « %@ » — sur cet appareil, c’est le même fichier — donc rien n’a été enregistré. Demandez à l’expéditeur d’en renommer un.";
ar:      "error.manifest.duplicatePath" = "يحتوي النقل على أكثر من ملف في «%@» — وهي على هذا الجهاز الملف نفسه — لذا لم يُحفظ شيء. اطلب من المُرسِل إعادة تسمية أحدها.";
es:      "error.manifest.duplicatePath" = "La transferencia contiene más de un archivo en «%@» —en este dispositivo son el mismo archivo—, así que no se guardó nada. Pídele a quien envía que renombre uno de ellos.";
pt:      "error.manifest.duplicatePath" = "A transferência contém mais do que um ficheiro em «%@» — neste dispositivo são o mesmo ficheiro — por isso nada foi guardado. Peça a quem envia que renomeie um deles.";
```

Do **not** touch the other eighteen keys that say Mac, or
`error.keychain.signIn`, which says macOS — nineteen in all. Each is blocked
behind a feature this slice does not have; the design document lists them against
the slice that must fix them, and Task 7's guard names all nineteen, so the list
cannot rot into a lie.

- [ ] **Step 4: Write the copy assertions**

Append to `LocalizedCopyTests.swift`:

```swift
    // MARK: - the iOS account surface says nothing about a Mac

    /// Every non-plural key the iOS account tab and its tab item render.
    /// Listed rather than derived: the point is that somebody decided this set
    /// is what iOS shows, and that a later addition to it is a decision too.
    private let iosAccountSurface: [L10nKey] = [
        .tabReceive, .tabAccount, .accountRestoring,
        .loginEmail, .loginPassword, .loginSignIn, .loginSigningIn, .loginCreateAccount,
        .contentAccountLoadFailed, .contentCheckEmailTitle, .contentCheckEmailBody,
        .contentOpenRelayium, .contentBackToSignIn,
        .contentPendingDeletionTitle, .contentPendingDeletionBody, .contentReactivate,
        .accountManagePlan, .accountTraffic, .accountStorage, .accountMeterOf,
        .accountStaleFigures, .accountSignOutFailed,
        .usageUnlimited, .usageResetsToday,
        .badgeTrial, .badgePaymentFailed, .badgeCanceled, .badgeUnpaid,
        .badgePaymentIncomplete, .badgePaused, .badgeInactive,
        .commonRefresh, .commonSignOut, .commonTryAgain,
    ]

    func testNothingTheIOSAccountSurfaceRendersNamesAMac() {
        for key in iosAccountSurface {
            for language in AppLanguage.allCases {
                let text = L10n.t(key, language: language)
                XCTAssertFalse(text.contains("Mac"),
                               "\(key.rawValue) [\(language.rawValue)]: \(text)")
                XCTAssertFalse(text.contains("macOS"),
                               "\(key.rawValue) [\(language.rawValue)]: \(text)")
            }
        }
        // The one plural the summary renders, driven through its own entry point.
        for language in AppLanguage.allCases {
            let text = L10n.plural(.usageResetsInDays, 3, language: language)
            XCTAssertFalse(text.contains("Mac"), "usage.resetsInDays [\(language.rawValue)]: \(text)")
        }
    }

    /// The three new keys are real copy in every language, not a key echoed
    /// back and not a template with an unsubstituted placeholder.
    func testTheNewIOSKeysAreTranslatedEverywhere() {
        for key in [L10nKey.tabReceive, .accountRestoring, .loginSigningIn] {
            for language in AppLanguage.allCases {
                let text = L10n.t(key, language: language)
                XCTAssertFalse(text.isEmpty, "\(key.rawValue) [\(language.rawValue)]")
                XCTAssertNotEqual(text, key.rawValue,
                                  "\(key.rawValue) [\(language.rawValue)] fell back to the key")
                XCTAssertFalse(text.contains("%@"), "\(key.rawValue) [\(language.rawValue)]: \(text)")
            }
        }
    }

    /// A receive refusal iOS can already hit. The sentence is true on both
    /// platforms; the noun was not, and the offending path still has to be in
    /// it or the user cannot act on it.
    func testTheDuplicatePathRefusalNamesNoPlatform() {
        for language in AppLanguage.allCases {
            let text = ErrorCopy.message(for: ManifestPathError.duplicatePath("t/a.txt"),
                                         language: language)
            XCTAssertFalse(text.contains("Mac"), "[\(language.rawValue)] \(text)")
            XCTAssertTrue(text.contains("t/a.txt"), "[\(language.rawValue)] \(text)")
        }
    }
```

- [ ] **Step 5: Run the localization suites**

Run: `cd apps/RelayiumKit && swift test --filter Localiz`
Expected: PASS — `LocalizationIntegrityTests` (every key in all nine, no
orphaned catalog key, placeholder signatures matching English) and the three new
assertions above.

- [ ] **Step 6: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumAppKit/Localization/L10nKey.swift \
        apps/RelayiumKit/Sources/RelayiumAppKit/Resources \
        apps/RelayiumKit/Tests/RelayiumKitTests/LocalizedCopyTests.swift
git commit -m "feat(apps): add the iOS account copy and drop a Mac-only noun"
```

### Task 4: Session adversarial coverage

No production change. `AccountSession`'s generation guard, its in-memory
`sessionToken`, and its keep-the-credential sign-out failure are the behaviors
this slice depends on; three of them are not yet pinned by a test.

**Files:**
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/AccountSessionTests.swift`

- [ ] **Step 1: Add a thread-safe URL recorder**

At the bottom of the file, beside `RequestGate` and `FailingSaveTokenStore`:

```swift
/// Collects every URL that reached the transport. The stub's router runs on
/// URLSession's own thread, so a captured local array would be a data race.
final class URLRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [String] = []

    func record(_ url: URL?) {
        lock.lock(); defer { lock.unlock() }
        seen.append(url?.absoluteString ?? "")
    }

    var urls: [String] {
        lock.lock(); defer { lock.unlock() }
        return seen
    }
}
```

- [ ] **Step 2: Write the three failing-or-passing cases**

Append to the `AccountSessionTests` class:

```swift
    // A refused revocation must NOT delete local state: that would leave a
    // still-valid server credential nothing on this device can revoke. The user
    // is offered a retry instead, and the retry has to actually work.
    func testSignOutFailureKeepsTheCredentialAndOffersRetry() async throws {
        let store = InMemoryTokenStore()
        try store.save("rlm_cli_TESTTOKEN")
        try routeLoggedIn(loginBody: Data())
        let s = session(store: store)
        await s.restore()
        guard case .ready = s.state else { return XCTFail("setup failed, got \(s.state)") }

        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/auth/logout": return .init(status: 503, body: Data())
            default:                 return .init(status: 500, body: Data())
            }
        }
        await s.logOut()

        XCTAssertEqual(s.state, .unavailable(message: L10n.t(.accountSignOutFailed)))
        XCTAssertEqual(s.bearerToken, "rlm_cli_TESTTOKEN",
                       "the credential must survive so the revocation can be retried")
        XCTAssertEqual(try store.load(), "rlm_cli_TESTTOKEN")

        StubURLProtocol.router = { _ in .init(status: 200, body: Data()) }
        await s.logOut()

        XCTAssertEqual(s.state, .loggedOut)
        XCTAssertNil(s.bearerToken)
        XCTAssertNil(try store.load())
    }

    // restore()'s COLD path — read the store, then fetch — is the one entry
    // point the generation guard was never proved on. A sign-out that lands
    // while the launch fetch is in flight must win: otherwise the late success
    // writes `.ready` over it and puts the user back on an account screen whose
    // token was just cleared.
    func testSignOutDuringLaunchRestoreStaysSignedOut() async throws {
        let store = InMemoryTokenStore()
        try store.save("rlm_cli_TESTTOKEN")
        let gate = RequestGate()
        let me = try fixture("me"), usage = try fixture("me-usage")
        StubURLProtocol.router = { req in
            switch req.url?.path {
            case "/api/me":          gate.hold(); return .init(status: 200, body: me)
            case "/api/me/usage":    return .init(status: 200, body: usage)
            case "/api/auth/logout": return .init(status: 200, body: Data())
            default:                 return .init(status: 500, body: Data())
            }
        }
        let s = session(store: store)
        let restoring = Task { await s.restore() }
        await gate.reached()
        await s.logOut()            // the user signs out during the launch fetch
        gate.release()
        await restoring.value

        XCTAssertEqual(s.state, .loggedOut, "a launch restore must not undo a sign-out that beat it")
        XCTAssertNil(s.bearerToken)
        XCTAssertNil(try store.load())
    }

    // The password rides in the POST body and the bearer in a header. Either one
    // in a URL would reach every proxy log, the server's access log, and any
    // Referer that followed.
    func testCredentialsNeverAppearInARequestURL() async throws {
        let recorder = URLRecorder()
        let loginBody = try fixture("login-success")
        let me = try fixture("me"), usage = try fixture("me-usage")
        StubURLProtocol.router = { req in
            recorder.record(req.url)
            switch req.url?.path {
            case "/api/me":       return .init(status: 200, body: me)
            case "/api/me/usage": return .init(status: 200, body: usage)
            default:              return .init(status: 200, body: loginBody)
            }
        }
        let s = session(store: InMemoryTokenStore())
        await s.logIn(email: "person@example.com", password: "hunter2-correct-horse")
        guard case .ready = s.state else { return XCTFail("setup failed, got \(s.state)") }

        XCTAssertFalse(recorder.urls.isEmpty, "nothing was sent — the test proves nothing")
        for url in recorder.urls {
            XCTAssertFalse(url.contains("hunter2"), url)
            XCTAssertFalse(url.contains("person@example.com"), url)
            XCTAssertFalse(url.contains("rlm_cli_TESTTOKEN"), url)
            XCTAssertNil(URLComponents(string: url)?.query, url)
        }
    }
```

- [ ] **Step 3: Strengthen the two swallowed-save cases**

The invariant is that the *live session* survives a keychain that will not
persist, and "still `.ready`" is only half of it — the bearer has to still be
usable. Add one line to each of
`testSwallowedSaveErrorDoesNotCauseFalseLogoutOnRefresh` and
`testSwallowedSaveErrorDoesNotCauseFalseLogoutOnRestore`, immediately after the
final `guard case .ready` in each:

```swift
        XCTAssertNotNil(s.bearerToken, "the live session must still hold a usable bearer")
```

- [ ] **Step 4: Run them**

Run: `cd apps/RelayiumKit && swift test --filter AccountSessionTests`
Expected: PASS. If `testSignOutDuringLaunchRestoreStaysSignedOut` fails, that is
a real defect in `restore()`'s guard and is fixed there — not by relaxing the
assertion.

- [ ] **Step 5: Commit**

```bash
git add apps/RelayiumKit/Tests/RelayiumKitTests/AccountSessionTests.swift
git commit -m "test(apps): pin sign-out failure, launch-restore races, and credential leaks"
```

### Task 5: Anonymous receive sends no credential

**Files:**
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/CloudDownloadModelTests.swift`

- [ ] **Step 1: Write the failing-if-it-regresses test**

Append to the `CloudDownloadModelContainerTests` class, which already has
`makeModel`, `waitFor` and `tempDir`:

```swift
    /// Anonymous receive: nothing in this flow may authenticate.
    ///
    /// R3-B puts an account tab beside the receive tab, and the change that
    /// would be easiest to make and hardest to notice is a download that quietly
    /// starts requiring a session — it would keep working for whoever wrote it,
    /// and fail only for the users this app exists to serve. So assert the wire
    /// rather than the wiring: nothing that leaves carries a credential.
    func testAnAnonymousReceiveSendsNoCredential() async throws {
        let key = [UInt8](repeating: 7, count: 32)
        let files = [ManifestFile(name: "notes.txt", size: 4)]
        let m = try makeModel(files: files, key: key, contents: ["notes.txt": [1, 2, 3, 4]])

        // Wrap the router `makeModel` installed, so both the meta and the blob
        // request are observed without changing how the model is built.
        let recorder = RequestRecorder()
        let inner = try XCTUnwrap(StubURLProtocol.router)
        StubURLProtocol.router = { req in
            recorder.record(req)
            return inner(req)
        }

        m.linkText = "https://relayium.com/d/abc123#k=\(encodeStoreKey(key))"
        m.resolve()
        _ = await waitFor("the manifest to resolve",
                          { if case .ready = m.state { return true }; return false })
        m.download(into: try tempDir())
        _ = await waitFor("the download to finish",
                          { if case .done = m.state { return true }; return false })
        guard case .done = m.state else { return XCTFail("download failed: \(m.state)") }

        XCTAssertGreaterThanOrEqual(recorder.requests.count, 2,
                                    "meta and blob must both have been fetched")
        for request in recorder.requests {
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"),
                         request.url?.absoluteString ?? "")
            XCTAssertNil(URLComponents(string: request.url?.absoluteString ?? "")?.query,
                         request.url?.absoluteString ?? "")
        }
    }
```

And at the bottom of the file:

```swift
/// Collects the requests that reached the transport. The stub's router runs on
/// URLSession's own thread, so a captured local array would be a data race.
final class RequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [URLRequest] = []

    func record(_ request: URLRequest) {
        lock.lock(); defer { lock.unlock() }
        seen.append(request)
    }

    var requests: [URLRequest] {
        lock.lock(); defer { lock.unlock() }
        return seen
    }
}
```

- [ ] **Step 2: Run it**

Run: `cd apps/RelayiumKit && swift test --filter CloudDownloadModelContainerTests`
Expected: PASS on today's code — it is a regression guard for a capability that
already works, installed in the round that puts an account next to it.

- [ ] **Step 3: Commit**

```bash
git add apps/RelayiumKit/Tests/RelayiumKitTests/CloudDownloadModelTests.swift
git commit -m "test(apps): prove a stored-link receive sends no credential"
```

### Task 6: The iOS account tab

**Files:**
- Modify: `apps/ios/Relayium/RelayiumApp.swift`
- Create: `apps/ios/Relayium/RootView.swift`
- Create: `apps/ios/Relayium/AccountTab.swift`
- Create: `apps/ios/Relayium/SignInView.swift`
- Create: `apps/ios/Relayium/AccountSummaryView.swift`

**Interfaces:**
- Consumes: `AppEnvironment.makeSession()`, `AccountSession`,
  `SignInPresentation.form(for:)`, `SignInFormState`, `UsagePresentation`,
  `L10n`, and the three keys from Task 3.

- [ ] **Step 1: The shell**

Create `apps/ios/Relayium/RootView.swift`:

```swift
import SwiftUI
import RelayiumAppKit

/// The app's shell, and deliberately the dumbest file in it.
///
/// It never reads `session.state`. The receive flow R3-A shipped works with no
/// account, and the only way to keep that true in a slice that ADDS an account
/// is to make it structural: the tab bar and both tabs exist in every session
/// state, so signing out, failing to sign in, or never signing in cannot
/// remove, gate or rebuild the receive tab.
struct RootView: View {
    private enum Tab: Hashable { case receive, account }

    @EnvironmentObject private var session: AccountSession
    @ObservedObject var download: CloudDownloadModel
    @State private var selection: Tab = .receive

    var body: some View {
        TabView(selection: $selection) {
            ReceiveView(model: download)
                .tabItem { Label(L10n.t(.tabReceive), systemImage: "tray.and.arrow.down") }
                .tag(Tab.receive)

            AccountTab()
                .tabItem { Label(L10n.t(.tabAccount), systemImage: "person.crop.circle") }
                .tag(Tab.account)
        }
        // Launch restore. This is the ONE call site, which is what the surface
        // guard checks — not that it runs once. SwiftUI decides when a view's
        // task runs, and a rebuilt root, a re-created scene or a later
        // multi-scene setup can start it again; no Info.plist key makes that
        // impossible. Safety comes from the session instead: it is App-scoped,
        // so every invocation reaches the same object, and `restore()` is
        // re-entrant — early-returning on a live account or an in-flight
        // sign-in, refreshing rather than cold-starting when a token is held,
        // and guarding every post-await write on its operation generation.
        .task { await session.restore() }
    }
}
```

- [ ] **Step 2: Wire the app**

Replace the body of `apps/ios/Relayium/RelayiumApp.swift`, and update its doc
comment so it no longer says accounts are absent:

```swift
import SwiftUI
import RelayiumAppKit

/// R3-B: the second native iOS slice.
///
/// Two tabs. **Receive** is R3-A unchanged — an anonymous encrypted stored link,
/// no account involved. **Account** is password sign-in and a read-only usage
/// summary on the same `AccountSession` the macOS app runs. Sending, realtime,
/// device and file management, background transfer, the Share Extension and
/// notifications are later R3 slices and are deliberately absent rather than
/// stubbed.
///
/// Still no `onOpenURL`. Without Associated Domains — which this slice does not
/// claim, because the routing it would justify still does not exist — nothing
/// can deliver a URL to this app, so wiring the handler would be dead code that
/// reads like universal-link support.
@main
struct RelayiumApp: App {
    /// App-scoped rather than view-scoped, for the reason the macOS app scopes
    /// its models the same way: a download in flight must survive the view tree
    /// being rebuilt, and the session outlives any one screen.
    @StateObject private var download: CloudDownloadModel
    @StateObject private var session = AppEnvironment.makeSession()

    @MainActor
    init() {
        _download = StateObject(wrappedValue: AppEnvironment.makeDownloadModel())
    }

    var body: some Scene {
        WindowGroup {
            RootView(download: download)
                .environmentObject(session)
        }
    }
}
```

- [ ] **Step 3: The session switch**

Create `apps/ios/Relayium/AccountTab.swift`:

```swift
import SwiftUI
import RelayiumKit
import RelayiumAppKit

/// The whole account surface, and the only place in the app that reads
/// `session.state`.
///
/// Every hand-off goes through SwiftUI's `openURL`: the macOS app's
/// `NSWorkspace.shared.open` does not exist here, and this is the platform's
/// own mechanism rather than a UIKit call smuggled into a view.
struct AccountTab: View {
    @EnvironmentObject private var session: AccountSession
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            ScrollView {
                content
                    .padding()
                    // Leading, not centred: at the largest Dynamic Type sizes a
                    // centred column becomes a ragged edge on both sides.
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(L10n.t(.tabAccount))
        }
    }

    @ViewBuilder
    private var content: some View {
        // ONE call site for the form, so its typed email and password survive
        // every transition among .loggedOut, .authenticating and .failed.
        // Which states those are, and what each shows, is decided in
        // SignInPresentation, where a test can read it.
        if let form = SignInPresentation.form(for: session.state) {
            SignInView(form: form)
        } else {
            switch session.state {
            case .restoring:
                // Labelled rather than a bare spinner: VoiceOver reads nothing
                // from one, and on a full screen it says nothing to anybody.
                ProgressView { Text(L10n.t(.accountRestoring)) }

            case let .emailUnverified(email):
                notice(title: L10n.t(.contentCheckEmailTitle),
                       // The address is the user's own: isolated, not translated.
                       body: L10n.t(.contentCheckEmailBody, [L10n.token(email)]),
                       actionTitle: L10n.t(.contentOpenRelayium),
                       url: AppEnvironment.accountWebURL)

            case let .pendingDeletion(purgeAfter, reactivateToken):
                notice(title: L10n.t(.contentPendingDeletionTitle),
                       body: L10n.t(.contentPendingDeletionBody, [
                           L10n.date(Date(timeIntervalSince1970: TimeInterval(purgeAfter)),
                                     dateStyle: .medium, timeStyle: .none),
                       ]),
                       actionTitle: L10n.t(.contentReactivate),
                       // The token IS the button: a frozen account cannot sign
                       // in, and the fragment is what keeps the token out of the
                       // server's access log and out of any Referer.
                       url: AppEnvironment.reactivateWebURL(token: reactivateToken))

            case let .unavailable(message):
                // A token in hand that could not load an account. Offer a retry,
                // never a sign-in form — a form cannot fix a server being down.
                VStack(alignment: .leading, spacing: 12) {
                    Text(L10n.t(.contentAccountLoadFailed)).font(.headline)
                    Text(message)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(L10n.t(.commonTryAgain)) { Task { await session.refresh() } }
                        .buttonStyle(.borderedProminent)
                    Button(L10n.t(.commonSignOut)) { Task { await session.logOut() } }
                        .font(.callout)
                }

            case let .ready(user, usage):
                AccountSummaryView(user: user, usage: usage)

            case .loggedOut, .authenticating, .failed:
                // Unreachable: `SignInPresentation.form` is non-nil for exactly
                // these three, and the `if let` above took them. Listed rather
                // than defaulted so a new SessionState case is a compile error
                // here instead of a blank screen.
                EmptyView()
            }
        }
    }

    /// The two states reached holding no usable session. "Back to sign in" is a
    /// sign-out, exactly as on macOS: the honest way back is to drop what is
    /// held rather than to pretend it works.
    private func notice(title: String, body: String,
                        actionTitle: String, url: URL) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            Text(body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(actionTitle) { openURL(url) }
                .buttonStyle(.borderedProminent)
            Button(L10n.t(.contentBackToSignIn)) { Task { await session.logOut() } }
                .font(.callout)
        }
    }
}
```

- [ ] **Step 4: The form**

Create `apps/ios/Relayium/SignInView.swift`:

```swift
import SwiftUI
import RelayiumAppKit

/// The sign-in form. It owns the typed email and password as `@State`, so it
/// must stay ONE view across typing, signing in and "that was wrong" — see
/// `AccountTab`, which renders it from exactly one place for that reason.
///
/// Password only. Sign in with Apple and the browser device flow are later
/// slices, and a disabled button for either would be a promise this app cannot
/// keep.
struct SignInView: View {
    let form: SignInFormState

    @EnvironmentObject private var session: AccountSession
    @Environment(\.openURL) private var openURL
    @State private var email = ""
    @State private var password = ""

    private var canSubmit: Bool { !email.isEmpty && !password.isEmpty && !form.isBusy }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(spacing: 12) {
                TextField(L10n.t(.loginEmail), text: $email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField(L10n.t(.loginPassword), text: $password)
                    .textContentType(.password)
                    .submitLabel(.go)
                    .onSubmit(submit)
            }
            .textFieldStyle(.roundedBorder)
            .disabled(form.isBusy)

            if let message = form.errorMessage {
                // Ordinary text in reading order ABOVE the button, not a
                // decoration after it: it is what the user has to act on.
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Same slot either way, so the form does not jump while it submits.
            // The hidden button is also hidden from VoiceOver — opacity alone
            // leaves it in the accessibility tree, offering an action that is
            // already running.
            ZStack {
                Button(action: submit) {
                    Text(L10n.t(.loginSignIn)).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!canSubmit)
                .opacity(form.isBusy ? 0 : 1)
                .accessibilityHidden(form.isBusy)

                if form.isBusy {
                    ProgressView { Text(L10n.t(.loginSigningIn)) }
                }
            }

            Button(L10n.t(.loginCreateAccount)) { openURL(AppEnvironment.productionBaseURL) }
                .font(.callout)
                .disabled(form.isBusy)
        }
    }

    private func submit() {
        guard canSubmit else { return }
        Task { await session.logIn(email: email, password: password) }
    }
}
```

- [ ] **Step 5: The summary**

Create `apps/ios/Relayium/AccountSummaryView.swift`:

```swift
import SwiftUI
import RelayiumKit
import RelayiumAppKit

/// The signed-in account, read-only.
///
/// Read-only is the product decision, not a shortcut: changing a plan is a
/// billing write and lives on the web. The device list and the stored-file list
/// are R3-D and are absent rather than shown as empty sections promising a
/// later version.
struct AccountSummaryView: View {
    let user: NativeUser
    let usage: UsageResponse

    @EnvironmentObject private var session: AccountSession
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 2) {
                Text(user.displayName.isEmpty ? user.email : user.displayName)
                    .font(.title3.weight(.semibold))
                Text(user.email).foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(usage.plan.name).font(.headline)
                    // Both the "should this show at all" predicate and the
                    // wording live in UsagePresentation, where they are tested.
                    // A raw Stripe status must never reach this capsule.
                    if let badge = UsagePresentation.subscriptionBadge(
                        for: usage.plan.subscriptionStatus) {
                        Text(badge)
                            .font(.caption)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(.quaternary, in: Capsule())
                    }
                }
                Button(L10n.t(.accountManagePlan)) { openURL(AppEnvironment.plansWebURL) }
            }

            meter(L10n.t(.accountTraffic), UsagePresentation.display(usage.traffic))
            meter(L10n.t(.accountStorage), UsagePresentation.display(usage.storage))

            Text(UsagePresentation.resetText(resetsAt: usage.resetsAt, now: Date()))
                .font(.caption).foregroundStyle(.secondary)

            if session.isStale {
                Label(L10n.t(.accountStaleFigures), systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button(L10n.t(.commonRefresh)) { Task { await session.refresh() } }
            // An unstructured Task, NOT a `.task` modifier: a successful
            // sign-out removes this view, which would cancel a `.task` part-way
            // through `client.logout` and leave the credential on this device
            // AND valid on the server.
            Button(L10n.t(.commonSignOut), role: .destructive) {
                Task { await session.logOut() }
            }
        }
    }

    /// Label above value rather than beside it: at the largest Dynamic Type
    /// sizes a row truncates one of the two, and the figure is the point.
    @ViewBuilder
    private func meter(_ title: String, _ display: MeterDisplay) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.subheadline)
            Text(L10n.t(.accountMeterOf, [display.usedText, display.capText]))
                .font(.subheadline).foregroundStyle(.secondary)
            // No bar when unlimited: there is no ratio to draw.
            if let fraction = display.fraction {
                ProgressView(value: fraction)
            }
        }
        // One element, so VoiceOver reads "Traffic, 1 MB of 5 GB" instead of a
        // bare percentage with no idea what it measures.
        .accessibilityElement(children: .combine)
    }
}
```

- [ ] **Step 6: Build for the simulator**

Run:
```bash
xcodebuild -project apps/ios/Relayium.xcodeproj -scheme Relayium \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```
Expected: BUILD SUCCEEDED, with no project edit — the target's
file-system-synchronized group picks the four new files up by path.

- [ ] **Step 7: Run the source guard**

Run: `cd apps/RelayiumKit && swift test --filter LocalizationSourceGuardTests`
Expected: PASS — it already scans `apps/ios/Relayium`, so the new views are
covered automatically and any English literal in them fails here.

- [ ] **Step 8: Commit**

```bash
git add apps/ios/Relayium
git commit -m "feat(ios): add an account tab beside anonymous receive"
```

### Task 7: The surface guard

**Files:**
- Create: `apps/RelayiumKit/Tests/RelayiumKitTests/IOSSurfaceGuardTests.swift`

- [ ] **Step 1: Write it**

```swift
import XCTest
@testable import RelayiumAppKit

/// What the iOS app is NOT allowed to contain.
///
/// Three failure modes, all of which look fine in a diff:
///
///  1. **A credential in a log.** One `print` in a view that renders a token is
///     a line nobody re-reads and no behavioral test can see.
///  2. **A dead control for a deferred feature.** A disabled "Sign in with
///     Apple", an empty device list, a greyed Send tab: each is a promise the
///     app cannot keep, and each reads as progress in review.
///  3. **Copy that names the wrong platform.** Nineteen catalog strings name a
///     platform — eighteen say Mac, and `error.keychain.signIn` says macOS.
///     Each is correct on macOS and false here, and each is blocked behind a
///     feature this app does not have — so rendering one has to be a decision
///     rather than an oversight.
///  4. **A feature quietly unwired.** Launch restore is not decoration: without
///     it a signed-in user meets the sign-in form every launch.
///
/// It scans source text rather than behavior on purpose: these are absences,
/// and an absence has no runtime to observe.
final class IOSSurfaceGuardTests: XCTestCase {

    /// …/apps/RelayiumKit/Tests/RelayiumKitTests/<this file> → …/apps
    private var appsRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // RelayiumKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // RelayiumKit
            .deletingLastPathComponent()   // apps
    }

    private var iosRoot: URL { appsRoot.appendingPathComponent("ios/Relayium") }

    /// The view-model layer, which is where a credential actually passes
    /// through: `AccountSession` holds the bearer, and `ErrorCopy` formats
    /// failures around it.
    private var appKitRoot: URL {
        appsRoot.appendingPathComponent("RelayiumKit/Sources/RelayiumAppKit")
    }

    /// Each source's CODE, with whole-line comments dropped.
    ///
    /// Load-bearing, not tidiness: these files explain what they deliberately do
    /// NOT do, so `RelayiumApp` says "no `onOpenURL`" and `ReceiveView` says the
    /// app never reads `UIPasteboard`. Scanning raw text would fail this guard on
    /// the very comments that document the absence it is checking for.
    ///
    /// Whole-line only — a trailing `//` is not stripped, so a deferred symbol
    /// named in a trailing comment still fails. That is the wanted direction:
    /// this guard may miss nothing, and may only be too strict in a case that is
    /// trivially fixed by moving the comment to its own line.
    private func sources() throws -> [(name: String, text: String)] {
        try sources(under: iosRoot, atLeast: 5)
    }

    private func sources(under root: URL, atLeast minimum: Int) throws
        -> [(name: String, text: String)] {
        let names = try FileManager.default.subpathsOfDirectory(atPath: root.path)
            .filter { $0.hasSuffix(".swift") }
            .sorted()
        // A rename that moved the sources out from under this guard is exactly
        // when it stops protecting anything.
        XCTAssertGreaterThanOrEqual(names.count, minimum,
                                    "found \(names.count) sources at \(root.path)")
        return try names.map { name in
            let raw = try String(contentsOf: root.appendingPathComponent(name), encoding: .utf8)
            let code = raw
                .components(separatedBy: "\n")
                .filter { line in
                    let trimmed = line.trimmingCharacters(in: .whitespaces)
                    return !trimmed.hasPrefix("//") && !trimmed.hasPrefix("*")
                        && !trimmed.hasPrefix("/*")
                }
                .joined(separator: "\n")
            return (name, code)
        }
    }

    /// Both roots, because the credential passes through both: the app renders
    /// the session, and `AccountSession`/`ErrorCopy` hold and format it.
    func testNothingInTheAppOrViewModelLayerLogs() throws {
        let scanned = try sources(under: iosRoot, atLeast: 5)
            + sources(under: appKitRoot, atLeast: 20)
        for (name, text) in scanned {
            for call in ["print(", "NSLog(", "os_log(", "debugPrint(", "dump("] {
                XCTAssertFalse(text.contains(call),
                               "\(name) contains \(call) — a credential must never reach a log")
            }
        }
    }

    func testNoDeferredFeatureIsReferenced() throws {
        // Each belongs to a later R3 slice. A reference means either a dead
        // control or a capability claimed before it works.
        let deferred = [
            "SignInWithAppleButton", "AuthenticationServices", "BrowserLoginModel",
            "AccountManagementModel", "CloudUploadModel", "RealtimeSessionModel",
            "RealtimeTextSessionModel", "LanDiscoveryModel", "NearbyReceiveModel",
            "UIPasteboard", "onOpenURL", "UNUserNotificationCenter", "StoreKit",
            "NSWorkspace",
        ]
        for (name, text) in try sources() {
            for symbol in deferred {
                XCTAssertFalse(text.contains(symbol), "\(name) references \(symbol)")
            }
        }
    }

    /// The nineteen keys whose wording names a platform: eighteen that say Mac,
    /// and `error.keychain.signIn`, which says macOS. The last one is on this
    /// list precisely because the design identifies it as iOS-wrong — a guarded
    /// list that left it out would be the one place that identification stopped
    /// counting.
    ///
    /// Guarded by NAME, so it cannot see the ones `ErrorCopy` reaches
    /// indirectly — which is why `error.manifest.duplicatePath`, the one an iOS
    /// receive can already hit, was corrected in the catalogs instead of listed
    /// here.
    func testNoPlatformNamingCopyKeyIsRenderedOnIOS() throws {
        let platformNaming: [L10nKey] = [
            .accountThisMac, .accountRevokeThisMac, .accountKeyNotOnThisMac,
            .accountKeyLookupFailed, .accountKeyCleanupWarning, .accountBearerInvalid,
            .uploadKeyKept, .errorStoredKeyBadIdSave, .errorStoredKeyBadKeySave,
            .errorStoredLinkKeyInvalidKey, .errorPlaintextTooManyOpenFiles,
            .nearbyExplain, .nearbyPausedBody, .nearbyAcceptanceNote,
            .notifyIncomingFiles, .notifyIncomingText, .verifyExplainEncryption,
            .errorNearbyNoAnswer,
            .errorKeychainSignIn,
        ]
        XCTAssertEqual(platformNaming.count, 19)
        for (name, text) in try sources() {
            for key in platformNaming {
                XCTAssertFalse(text.contains(".\(key)"),
                               "\(name) renders \(key.rawValue), whose wording names a platform")
            }
        }
    }

    /// Launch restore is wired, and wired in ONE place — the shell — so a
    /// second `.task` cannot start a competing cold start from inside a tab.
    ///
    /// This says nothing about how often SwiftUI runs that task, which is not
    /// something a source scan or an `Info.plist` can decide. `AccountSession`
    /// is App-scoped and `restore()` is re-entrant; `AccountSessionTests` owns
    /// proving that, and this owns proving the feature exists at all.
    func testLaunchRestoreIsWiredExactlyOnceInTheShell() throws {
        let all = try sources()
        let callSites = all
            .map { $0.text.components(separatedBy: "session.restore()").count - 1 }
            .reduce(0, +)
        XCTAssertEqual(callSites, 1, "launch restore must have exactly one call site")
        let root = try XCTUnwrap(all.first { $0.name == "RootView.swift" })
        XCTAssertTrue(root.text.contains("session.restore()"),
                      "the one call site belongs in the shell, not in a tab")
    }

    /// The receive flow must not acquire an account dependency: it is the one
    /// thing this app could already do, and it works signed out.
    func testTheReceiveFlowIsIndependentOfTheSession() throws {
        let all = try sources()
        let receive = try XCTUnwrap(all.first { $0.name == "ReceiveView.swift" })
        for symbol in ["AccountSession", "bearerToken"] {
            XCTAssertFalse(receive.text.contains(symbol),
                           "ReceiveView must not depend on \(symbol)")
        }
        let root = try XCTUnwrap(all.first { $0.name == "RootView.swift" })
        XCTAssertFalse(root.text.contains("session.state"),
                       "the shell must not switch on session state — that would gate the receive tab")
    }

    /// One call site is what keeps the typed email and password alive across
    /// .loggedOut → .authenticating → .failed.
    func testTheSignInFormHasExactlyOneCallSite() throws {
        let uses = try sources()
            .filter { $0.name != "SignInView.swift" }
            .map { $0.text.components(separatedBy: "SignInView(").count - 1 }
            .reduce(0, +)
        XCTAssertEqual(uses, 1,
                       "a second call site would give the form a second structural identity")
    }

    /// Empty is the claim: this app needs no capability, and an entitlement is
    /// a claim to the OS that lands with the feature requiring it. The nil
    /// keychain access group is the same decision, from the other side.
    func testTheEntitlementsFileIsStillEmpty() throws {
        let data = try Data(contentsOf: iosRoot.appendingPathComponent("Relayium.entitlements"))
        let plist = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
                as? [String: Any])
        XCTAssertTrue(plist.isEmpty, "iOS R3-B claims no capability: \(plist.keys.sorted())")
    }
}
```

- [ ] **Step 2: Run it**

Run: `cd apps/RelayiumKit && swift test --filter IOSSurfaceGuardTests`
Expected: PASS. A failure here is a real finding, not a threshold to raise.

- [ ] **Step 3: Commit**

```bash
git add apps/RelayiumKit/Tests/RelayiumKitTests/IOSSurfaceGuardTests.swift
git commit -m "test(ios): guard against logs, dead controls, and Mac-only copy"
```

### Task 8: Status and full acceptance

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the iOS status bullet**

Replace the `**iOS — in development, not public:**` bullet's body with a
truthful description of both slices, keeping the bullet's existing shape and its
closing sentence about what remains. The new text:

> a native SwiftUI app now exists at [`apps/ios`](apps/ios) and builds against
> the same shared Swift package. It receives an encrypted stored link without an
> account — paste the link, inspect the decrypted manifest and its
> delete-after-download warning, save the files into the app's own folder in the
> Files app, and hand the finished result to the system share sheet — and it can
> now sign in to a Relayium account with an email and password to see the plan
> and usage that account has, refresh it, and sign out. Receiving still needs no
> account. It ships the same nine languages. Everything else in the iOS plan —
> sending, realtime and nearby transfer, device and stored-file management,
> universal links, the Share Extension, background transfer, notifications, and
> App Store release — is still to be built, and there is no download to install.

Nothing else in `README.md` changes: no availability claim, no download link, no
change to the macOS release status.

- [ ] **Step 2: Run everything**

```bash
cd apps/RelayiumKit && swift test
```
Expected: PASS. Only `testKeychainRoundTripIfAvailable` may skip, and only for
its documented opt-in reason.

```bash
xcodebuild -scheme RelayiumKit -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
xcodebuild -project apps/ios/Relayium.xcodeproj -scheme Relayium \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium build
```
Expected: three BUILD SUCCEEDED. The macOS build is not optional — this round
changes `AppEnvironment` and the catalogs it renders.

```bash
plutil -lint apps/ios/Relayium/Info.plist apps/ios/Relayium/Relayium.entitlements \
  apps/RelayiumKit/Sources/RelayiumAppKit/Resources/*.lproj/Localizable.strings
apps/mac/scripts/test-release-readiness.sh
git diff --check
git status --short --untracked-files=all
```
Expected: all OK; the readiness manifest still `approved: false`; no whitespace
errors; the working tree shows only the intended files plus the pre-existing,
untouched `output/`.

- [ ] **Step 3: Install and launch on a simulator**

Boot an iPhone simulator, install the unsigned Debug build, launch it, and
confirm: it stays running; the tab bar shows both tabs; the Receive tab works
with nobody signed in; the Account tab shows the sign-in form; and under an
Arabic system language the account tab lays out right to left.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: describe the iOS account slice truthfully"
```

## Acceptance

1. `cd apps/RelayiumKit && swift test` — the full suite passes, including
   `AppEnvironmentTests`, `SignInPresentationTests`, `AccountSessionTests`,
   `CloudDownloadModelContainerTests`, `LocalizedCopyTests`,
   `LocalizationIntegrityTests`, `LocalizationSourceGuardTests` and
   `IOSSurfaceGuardTests`. Only the documented opt-in real-Keychain test skips.
2. macOS keychain constants are unchanged and asserted:
   `com.relayium.mac` / `bearer-token` / `7PVYUG4YQS.com.relayium.shared`, for
   the bearer store and the stored-link key store alike.
3. iOS resolves to `com.relayium.app` / `bearer-token` / **no** access group —
   asserted from the macOS host through the real `kSecAttrAccessGroup` query of
   **both** the token store and the stored-link key store, with the
   default-argument call covering the app's own wiring — and
   `Relayium.entitlements` is still an empty dict. The three comments that
   claimed the shared group was universal, or that iOS would read the macOS
   credential, now say what the policy actually is.
4. A stored-link receive completes with no session and emits no request carrying
   an `Authorization` header or a query component.
5. The sign-in form is rendered from exactly one call site, and the state
   mapping behind it is asserted case by case for all eight `SessionState`s.
   `session.restore()` likewise has exactly one call site and it is in
   `RootView.swift` — a claim about wiring, not about how often SwiftUI runs
   that task, which the session's re-entrancy guards and their tests cover
   instead.
6. A stale `restore()`, `refresh()` or `logIn()` completing after an explicit
   sign-out leaves the user signed out with no stored token.
7. A `TokenStore` that cannot save leaves the session `.ready` with a usable
   `bearerToken` across both `refresh()` and `restore()`.
8. A refused sign-out leaves the credential in memory and in the store, lands on
   `.unavailable` with the sign-out-failed copy, and a retry against a healthy
   server completes it.
9. No password, email or bearer appears in any request URL; the reactivation
   token is in the fragment and the URL has no query.
10. Nine languages complete, Arabic still RTL, `CFBundleLocalizations`
    unchanged, no user-facing English literal in the iOS sources, and nothing
    the iOS account surface renders says Mac or macOS in any language. No iOS
    source references any of the nineteen platform-naming keys,
    `error.keychain.signIn` included.
11. Three builds succeed — package for iOS, iOS app unsigned, macOS app — and
    `test-release-readiness.sh` still reports `approved: false`.

## Outstanding manual validation

Recorded rather than claimed:

- a real sign-in against the production account API from the simulator, and the
  device appearing in the web device list under a sensible name;
- the keychain round trip on a **signed device** build — neither the SPM host
  nor the simulator is one, and `errSecMissingEntitlement` is precisely the
  failure the nil access group exists to avoid;
- sign-out revocation observed server-side;
- VoiceOver and the largest Dynamic Type sizes on the account tab;
- Arabic right-to-left layout of the account tab specifically.

## Follow-ups this slice deliberately does not do

- Adopt `SignInPresentation` in the macOS `ContentView`, replacing its derived
  `loginError` / `isAuthenticating` — a real simplification, and a macOS view
  change this iOS slice has no business making.
- Surface a token-persistence failure to the user on both platforms, with copy
  that does not say macOS (`error.keychain.signIn`). Today the failure is
  swallowed on both, so the session silently ends at next launch.
- The eighteen catalog strings that still say Mac, each with the slice that first
  renders it: R3-C for sending, R3-D for device and file management, R3-E/R3-F
  for realtime and notifications. (`error.keychain.signIn`, the nineteenth
  guarded key, is the bullet above.)
