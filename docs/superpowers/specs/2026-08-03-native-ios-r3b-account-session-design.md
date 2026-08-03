# Native iOS R3-B — account session — design

Date: 2026-08-03
Milestone: R3-B, the second iOS vertical slice. Development only. Not public.

## Outcome

An iPhone or iPad user can sign in to their Relayium account with an email and a
password, see which plan they are on and how much of it they have used, refresh
those figures, and sign out — without losing the thing the app could already do.
The anonymous stored-link receive R3-A shipped keeps working exactly as it did,
for a user who never signs in at all.

That last clause is the point of the slice, not a footnote. A receive app that
starts demanding an account is a worse product than one with no account at all.
So the account arrives as a *second tab beside* the receive flow, never as a
gate in front of it, and that is a structural property of the view tree rather
than a promise in a comment: nothing above the tab bar ever reads
`session.state`.

Below the surface this reuses the account stack the macOS app has been running
since R1-G1 — `AccountSession`, `AccountClient`, `UsagePresentation`, `ErrorCopy`,
`L10n` — unchanged in every respect but one: where the bearer token is kept.
That one exception is the substance of the round, because a keychain identity is
the kind of decision that is cheap now and a data migration later.

## Non-negotiable invariants

Recorded before implementation because this slice sits on an authentication and
credential-storage boundary.

1. **Anonymous receive survives, with no token and no session.** The receive tab
   is rendered unconditionally, holds no reference to `AccountSession`, and its
   requests carry no `Authorization` header. Signing out, failing to sign in, or
   never signing in changes nothing about it.
2. **The macOS keychain identity does not move.** `com.relayium.mac` /
   `bearer-token` / `7PVYUG4YQS.com.relayium.shared` stay byte for byte what they
   are, including for the stored-link key store that shares that service. A
   changed service or access group on macOS would strand every existing user's
   credential and every saved `#k=` key, silently, on next launch.
3. **iOS names no access group.** Service `com.relayium.app`, account
   `bearer-token`, `accessGroup` **nil**. This build carries no
   `keychain-access-groups` entitlement — the entitlements file is empty and
   deliberately stays that way — so naming a group would fail with
   `errSecMissingEntitlement` on a real device. Beyond that it would *imply*
   cross-app credential sharing that this slice neither needs nor implements. An
   entitlement lands with the feature that requires it, never in advance.
4. **A credential never reaches a log or a URL.** The password rides in the POST
   body; the bearer rides in an `Authorization` header. No `print`, `NSLog`,
   `os_log` or `dump` exists anywhere in the app or view-model layer, and none is
   added. The one deliberate exception — the reactivation token — is in the URL
   **fragment**, which is not sent to the server and does not enter its access
   log; see below.
5. **A stale async result cannot resurrect a signed-out session.** Every entry
   point on `AccountSession` claims a generation and every post-`await` write is
   guarded on still holding it. Sign-out bumps it first. This is existing,
   tested behavior; the slice adds the one entry point that was not yet covered
   (`restore()`'s cold path) rather than relaxing it.
6. **A failure to persist the token does not end the live session.**
   `sessionToken` in memory is the source of truth for an in-progress session;
   the keychain is persistence only. A swallowed `save()` failure must not be
   able to sign a working session out on the next refresh or the next
   `restore()`.
7. **A failed sign-out keeps the credential.** Deleting local state after the
   server refused revocation would leave a still-valid credential that can no
   longer be revoked from this device. The user is offered a retry instead.
8. **No availability claim.** The iOS simulator build stays unsigned, no
   `DEVELOPMENT_TEAM` and no provisioning profile is introduced, and
   `apps/mac/release-readiness.json` stays `approved: false`.

### Adversarial acceptance cases

These are the cases the design is *built around*, listed here so the tests are
not written to fit whatever the implementation turned out to do.

- **Sign out while a refresh is in flight, then let the refresh land.** The user
  must stay signed out, with no token in the store. Already covered for
  `refresh()` and `logIn()`; `restore()`'s cold path — read the store, then fetch
  — is the uncovered one and is added.
- **A keychain that refuses to save.** Sign in against a `TokenStore` whose
  `save` always throws: the session still reaches `.ready`, `bearerToken` is
  still non-nil, and neither `refresh()` nor `restore()` afterwards drops it to
  `.loggedOut`.
- **A sign-out the server refuses.** State becomes `.unavailable` with the
  sign-out-failed copy, the token is *still in the store*, `bearerToken` is still
  non-nil, and a second sign-out against a healthy server completes and clears
  it.
- **A wrong password, twice.** The typed email must still be there for the second
  attempt. The form is one view across `.loggedOut`, `.authenticating` and
  `.failed`, which is enforced by there being exactly one call site that can
  render it (see *Sign-in form identity*).
- **A receive with nobody signed in.** Resolve and download a stored link through
  a model built the way the app builds it, and assert every request that left
  carried no `Authorization` header.
- **A reactivation link.** The token is in the fragment, percent-encoded, and the
  URL has **no query component at all** — asserted directly, because "it is in
  the fragment" and "it is not in the query" are different statements and only
  the second one keeps it out of the server's log.

## Scope

In:

- a two-tab native structure: **Receive** (R3-A, unchanged) and **Account**;
- password sign-in, with the create-account hand-off to the web;
- launch restore, `.authenticating`, invalid credentials, email-unverified,
  pending-deletion, unavailable-with-retry, and the ready usage summary;
- explicit refresh and explicit sign-out, including the failure of each;
- a platform-correct keychain configuration, unit-testable for both platforms on
  either host;
- three new copy keys and one corrected shared string, in all nine languages.

Out, and deliberately not stubbed:

- Sign in with Apple, native or through a browser;
- browser/device-approval login (`BrowserLoginModel` is not linked into the iOS
  view layer);
- account device management and stored-file management;
- uploads/sending, realtime, LAN/nearby, ephemeral text;
- Universal Links / Associated Domains, Share Extension / App Groups;
- background `URLSession`, notifications, APNs;
- IAP/StoreKit, App Store distribution, app icon, release approval;
- any web, server, AASA or `relayium-ops` change.

**No dead controls.** Nothing above renders as a disabled button, a greyed row,
or a "coming soon". A control appears in the same diff as the behavior behind
it. A source guard enforces this by name (see *Testing*).

## Navigation structure

```
RelayiumApp
└─ RootView                       ← never reads session.state
   └─ TabView
      ├─ Receive   ReceiveView(model: download)      unchanged from R3-A
      └─ Account   AccountTab()                      the whole session switch
```

`RootView` carries `.task { await session.restore() }` and injects the session as
an environment object. That is the *only* call site, and a test asserts it — but
it is deliberately **not** a claim that the call runs once. SwiftUI decides when a
view's task runs: a rebuilt root, a re-created scene, or a later multi-scene
configuration can start it again, and no `Info.plist` key makes that impossible.
Designing on "it happens once" would be designing on something the framework does
not promise.

Safety comes from the session instead of from the count. `AccountSession` is
App-scoped, so every invocation reaches the same object, and `restore()` is
already re-entrant by construction: it returns immediately when an account is on
screen or a sign-in is in flight, turns a token-in-hand into a `refresh()` rather
than a cold start, and guards every post-`await` write on its operation
generation. That is the same machinery macOS's `WindowGroup` exercises with ⌘N
and window-reopen — reused unchanged and not weakened. One call site keeps the
wiring legible; the guards keep it correct.

Two tabs rather than a single screen with a header button, for a reason that is
about failure rather than taste: the account states include four full-screen
ones (`.restoring`, the two notices, `.unavailable`). If those lived at the root,
every sign-in, sign-out and server hiccup would replace the receive flow — and a
user watching a download would be thrown off it by an account refresh they did
not ask for. Confining the switch to one tab means the worst an account failure
can do is make *the account tab* unhappy.

## The account tab's states

`AccountTab` renders `session.state` and nothing else:

```
.restoring         labelled ProgressView (account.restoring)
.loggedOut ┐
.authenticating ├─ ONE branch → SignInView(form)
.failed(msg) ┘
.emailUnverified   notice · Open relayium.com (accountWebURL) · Back to sign in
.pendingDeletion   notice · Reactivate (reactivateWebURL(token:)) · Back to sign in
.unavailable(msg)  "Couldn't load your account" · msg · Try again · Sign out
.ready(user,usage) AccountSummaryView
```

Every hand-off to the web goes through SwiftUI's `@Environment(\.openURL)`. The
macOS app's `NSWorkspace.shared.open` is unavailable on iOS and `openURL` is the
platform-correct mechanism; no iOS source references `NSWorkspace`.

*Back to sign in* on the two notices is `logOut()`, exactly as on macOS: those
two states are reached holding no usable session, and the honest way back is to
drop it.

### Sign-in form identity

`LoginView`'s `@State` email and password must survive the transition into
`.authenticating` and back out into `.failed`, or every wrong password blanks
both fields and the user retypes their address. On macOS that is achieved by
writing all three states into one `switch` branch and deriving `errorMessage` /
`isBusy` as computed properties — correct, but the correctness lives in a
comment and nothing can test it.

R3-B moves the decision into the package, where a test can reach it:

```swift
public struct SignInFormState: Equatable {
    public let errorMessage: String?
    public let isBusy: Bool
}

public enum SignInPresentation {
    /// Non-nil for exactly the three states the sign-in form owns.
    public static func form(for state: SessionState) -> SignInFormState?
}
```

The view then has one `if let form = SignInPresentation.form(for: session.state)`
and therefore one structural identity for all three states — not because someone
remembered to keep the branches together, but because there is only one branch to
keep together. The mapping is asserted case by case, including that the other
five states return `nil`.

macOS keeps its existing derivation. Adopting `SignInPresentation` there is a
real simplification and is recorded as a follow-up rather than folded into this
slice's diff.

### The ready summary

Name (falling back to email), email, plan name, the subscription badge from
`UsagePresentation.subscriptionBadge` — never a raw Stripe status — a *Manage
plan* hand-off to `plansWebURL`, the traffic and storage meters from
`UsagePresentation.display`, the reset line from `UsagePresentation.resetText`,
the `isStale` notice, and Refresh / Sign out.

Nothing here is a device list or a file list. Both are R3-D, both need copy this
slice would otherwise have to correct (see *Copy that says Mac*), and neither is
rendered as an empty section promising a later version.

Refresh is `session.refresh()`. Sign out is `session.logOut()` in an unstructured
`Task`, not a `.task` modifier: a `.task` attached to the ready branch is
cancelled the moment the branch changes, which is what a successful sign-out
does — cancelling `client.logout` part-way through would leave the credential on
the device and on the server.

## Keychain policy

The credential's home is now a value, computed per platform, in one place:

```swift
public struct KeychainConfiguration: Equatable, Sendable {
    public let service: String
    public let account: String
    /// nil means "this app's default access group" — the only correct value on a
    /// host with no keychain-access-groups entitlement.
    public let accessGroup: String?
}

public enum KeychainPlatform: String, CaseIterable, Sendable { case macOS, iOS }
```

| | service | account | accessGroup |
|---|---|---|---|
| macOS | `com.relayium.mac` | `bearer-token` | `7PVYUG4YQS.com.relayium.shared` |
| iOS | `com.relayium.app` | `bearer-token` | **nil** |

The macOS row is exactly what `AppEnvironment` already holds; the existing
`keychainService` / `keychainAccount` / `keychainAccessGroup` constants remain
and become the macOS row's source, so the assertions that pin them keep passing
unchanged and there is still one literal per value.

`iOS` names no group because this app has no entitlement to name one. The
entitlements file stays `<dict/>`: adding `keychain-access-groups` would be a
claim to the OS that this app shares credentials with another, which is neither
true nor needed — R3-B has one app and one credential. On a signed device build
the request would be refused outright (`errSecMissingEntitlement`, `-34018`);
with `nil` the item lands in the app's own default group, which is what a
single-app credential wants.

The service differs because the bundle identifiers differ (`com.relayium.mac` vs
`com.relayium.app`) and because on iOS the *stored-link key store shares this
service* — its `kSecAttrAccount` is `stored-link-key:<id>` under the same
service, which is why its id charset refuses separators. Keeping both stores on
one configuration preserves that relationship on both platforms instead of
letting a future iOS upload slice invent a second service by accident. So
`makeStoredLinkKeyStore` takes a configuration too, defaulting to this
platform's — the app's call site is unchanged, and both platforms' stored-link
queries become assertable from one host, exactly like the bearer's. On macOS it
resolves to the identical two values it passes today, which the tests pin.

Three comments elsewhere become false the moment this lands and are corrected
with it: `KeychainTokenStore`'s and `KeychainStoredLinkKeyStore`'s initializers
both say "the app always passes `AppEnvironment.keychainAccessGroup`", and
`AppEnvironmentTests` justifies the shared group with "R3's iOS app reads the
same credential". Under R3-B iOS reads no such thing. A comment that documents
the opposite of the policy is worse than no comment, because the next reader
trusts it.

### Testable for both platforms, on either host

The compile-time conditional is reduced to a single property:

```swift
public static var currentKeychainPlatform: KeychainPlatform    // the only #if
public static func keychainConfiguration(for: KeychainPlatform) -> KeychainConfiguration
public static var keychainConfiguration: KeychainConfiguration
public static func makeTokenStore(_ c: KeychainConfiguration = keychainConfiguration) -> KeychainTokenStore
public static func makeStoredLinkKeyStore(_ c: KeychainConfiguration = keychainConfiguration) -> KeychainStoredLinkKeyStore
```

`keychainConfiguration(for:)` is pure. A test running under `swift test` on macOS
asserts the **iOS** row directly, and asserts that the resulting
`KeychainTokenStore.baseQuery` and `KeychainStoredLinkKeyStore.query(for:)`
really omit `kSecAttrAccessGroup` — internal seams that already exist for exactly
this reason. Both factories take the configuration so that neither platform's
real Security dictionary is reachable only from the platform that runs it; a
default-argument call additionally covers the wiring the app uses. None of those
assertions depends on the host OS. Only `currentKeychainPlatform` is
host-dependent, and it is pinned by a two-arm `#if` in the test, which is the
smallest possible surface for the one fact that genuinely cannot be
platform-neutral.

### What this does not fix

`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` is unchanged and correct here.
It does mean the token is unreadable before the first unlock after a reboot, and
`restore()` reads an unreadable item as "no token" and goes to `.loggedOut`. That
is unreachable in R3-B — the app only ever launches into the foreground, which
requires an unlocked device — and becomes reachable the moment R3-F adds
background launch. Recorded, not worked around: guessing at it now would mean
distinguishing "empty" from "locked" in a code path nothing can exercise.

## Localization

Three new keys, in all nine catalogs:

| Key | Why an existing key does not fit |
|---|---|
| `tab.receive` | macOS's `tab.link` labels a tab that both sends and receives; the iOS tab only receives, and `download.heading` ("Receive files") is a screen title, too long for a tab item |
| `account.restoring` | the launch-restore progress. macOS shows a bare `ProgressView`; a full-screen touch UI needs a label, and VoiceOver reads nothing from a bare spinner. `menubar.loadingAccount` says the right sentence under a key that names the wrong surface |
| `login.signingIn` | as above, for the in-flight sign-in. Same relationship to `menubar.signingIn` |

The two progress keys take the wording of their `menubar.*` counterparts
verbatim in every language, so the product does not acquire two ways of saying
the same thing.

### Copy that says Mac

Twenty catalog keys name a platform in all nine languages: nineteen say *Mac*,
and `error.keychain.signIn` says *macOS*. Exactly one of the twenty is reachable
from an iOS surface today:

**`error.manifest.duplicatePath`** — *"…on this Mac those are the same file…"*.
It is raised by manifest path validation during a **receive**, so R3-A already
made it reachable on iOS and R3-B keeps that path. The sentence's substance is
true on both platforms; only the noun is wrong. It is therefore *corrected in
place* in all nine catalogs — "this Mac" becomes the language's word for *this
device* — rather than duplicated under an `.ios` key. A second translation of one
sentence, differing by a noun, is worse than one correct sentence: macOS's
wording moves, and moves to something equally true there.

The remaining **nineteen** — the eighteen that still say Mac, and
`error.keychain.signIn`, which says macOS — are reachable only through features
this slice does not have, and are recorded against the slice that must fix them
rather than pre-emptively rewritten:

| Keys | Blocked behind | Fix with |
|---|---|---|
| `account.thisMac`, `account.revokeThisMac`, `account.keyNotOnThisMac`, `account.keyLookupFailed`, `account.keyCleanupWarning`, `account.bearerInvalid` | device + stored-file management | R3-D |
| `upload.keyKept`, `error.storedKey.badId.save`, `error.storedKey.badKey.save`, `error.storedLinkKey.invalidKey`, `error.plaintext.tooManyOpenFiles` | sending | R3-C |
| `nearby.explain`, `nearby.pausedBody`, `nearby.acceptanceNote`, `notify.incomingFiles`, `notify.incomingText`, `verify.explainEncryption`, `error.nearby.noAnswer` | realtime / nearby / notifications | R3-E, R3-F |
| `error.keychain.signIn` | nothing renders a token-persistence failure on either platform today (`AccountSession` swallows it with `try?`) | whichever slice first surfaces it, on both platforms at once |

A guard test asserts that no iOS source *references* any of those nineteen keys
by name — `error.keychain.signIn` included, because the design identifies it as
iOS-wrong and a guarded list that omitted it would be the one place the
identification stopped counting. So the list cannot rot into a lie by a future
slice quietly rendering one. The guard is by name and therefore cannot see the
ones `ErrorCopy` reaches indirectly — which is precisely why
`error.manifest.duplicatePath` was found by reachability review and is fixed
rather than listed.

### Everything else

No user-facing English literal exists in the new iOS sources;
`LocalizationSourceGuardTests` already scans `apps/ios/Relayium` and covers them
automatically. `Info.plist`'s nine `CFBundleLocalizations` are unchanged and
still asserted, which is what keeps an Arabic layout right-to-left.

## Accessibility and layout

- **Dynamic Type:** no fixed font sizes and no fixed frames in the new views. The
  account tab is a `ScrollView` that reflows; the meters are full-width and their
  label and value stack vertically rather than truncate at large sizes.
- **RTL:** leading/trailing only, never left/right. The meter's numeric value
  goes through `UsagePresentation`, which already emits Latin digits with the
  language's separator, and through `L10n.token` where a value is interpolated.
- **VoiceOver:** the restore and sign-in progress states carry text labels rather
  than bare spinners; each meter is one combined accessibility element, so it is
  read as "Traffic, 1 MB of 5 GB" rather than as a bare percentage with no idea
  what it measures; the sign-in button is hidden from the accessibility tree
  while it is replaced by the spinner, because opacity alone would leave it
  offering an action that is already running; the email field is
  `.textContentType(.username)` and the password `.textContentType(.password)`,
  so the system offers the keychain and reads them correctly.
- The error line on the form is ordinary text in reading order above the button,
  not a decoration after it.

## Testing

Package tests (`swift test`); the app target holds no logic worth testing
without UI.

**Keychain policy** — `AppEnvironmentTests`:
the macOS row is byte for byte the historical triple; the iOS row is
`com.relayium.app` / `bearer-token` / nil; the two platforms share the account
and differ in service; every `KeychainPlatform` case is covered by the factory
(so a future platform cannot be added without a decision); the **token store**
and the **stored-link key store** built from the iOS row both carry no
`kSecAttrAccessGroup` and name `com.relayium.app`, while both built from the
macOS row carry the team group and name `com.relayium.mac`; the default-argument
call resolves to this host's row, so the app's own wiring is covered too;
`currentKeychainPlatform` matches the compiled platform. Plus the reactivation
URL keeps the token in the fragment **and has no query**.

**Session behavior** — `AccountSessionTests`:
sign-out failure keeps the credential and lands on the retryable state, and a
second sign-out against a healthy server completes it; a stale `restore()`
completing after an explicit sign-out leaves the user signed out; a failing token
store leaves `bearerToken` live across both `refresh()` and `restore()`; the
credentials never appear in a request URL.

**Form identity** — `SignInPresentationTests`:
exactly `.loggedOut`, `.authenticating` and `.failed` produce a form; busy only
in `.authenticating`; the message only in `.failed`, and it is the message the
state carries; the other five states produce `nil`.

**Anonymous receive** — `CloudDownloadModelTests`:
a resolve plus a download emits no request carrying an `Authorization` header.

**Copy** — `LocalizedCopyTests`:
`error.manifest.duplicatePath` names no Mac in any of the nine languages and
still names the offending path; every key the iOS account surface renders is
Mac-free in all nine; the three new keys are non-empty in all nine and leave no
unsubstituted placeholder.

**Surface guard** — `IOSSurfaceGuardTests` (new):
neither the iOS sources nor the view-model layer contains a logging call
(`print`, `NSLog`, `os_log`, `debugPrint`, `dump`); no iOS source references a
deferred feature's type or API (`SignInWithAppleButton`,
`AuthenticationServices`, `BrowserLoginModel`, `AccountManagementModel`,
`CloudUploadModel`, `RealtimeSessionModel`, `RealtimeTextSessionModel`,
`LanDiscoveryModel`, `NearbyReceiveModel`, `UIPasteboard`, `onOpenURL`,
`UNUserNotificationCenter`, `StoreKit`, `NSWorkspace`); no reference to any of
the nineteen platform-naming copy keys; `ReceiveView.swift` names neither
`AccountSession` nor `bearerToken`; `RootView.swift` contains no `session.state`;
`SignInView` has exactly one call site; `session.restore()` has exactly one call
site and it is in `RootView.swift`; and the entitlements file is still an empty
dict.

The restore assertion is about *wiring*, not frequency. Launch restore is a
feature — without it a signed-in user meets the sign-in form every launch — and
a second `.task` calling it from a tab would be a competing cold start. That one
call site is checkable; how often SwiftUI runs it is not, and
`AccountSessionTests` owns the re-entrancy instead.

It scans **code**, not comments. These files explain what they deliberately do
not do — `RelayiumApp` says it wires no `onOpenURL`, `ReceiveView` says it never
reads `UIPasteboard` — so a raw text scan would fail on exactly the comments
that document the absence being checked for.

**Build acceptance:**

- `swift test` in `apps/RelayiumKit` — full suite green, only the documented
  opt-in real-Keychain test may skip;
- `xcodebuild -scheme RelayiumKit -destination 'generic/platform=iOS Simulator'`;
- `xcodebuild -project apps/ios/Relayium.xcodeproj -scheme Relayium -destination
  'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`;
- `plutil -lint` on the iOS `Info.plist`, entitlements, and the nine catalogs;
- `apps/mac/scripts/test-release-readiness.sh` — still passing, still
  `approved: false`.

The existing `ios-build` CI job already triggers on `apps/**` and needs no
change; new Swift files are picked up without a project edit because the target
uses a file-system-synchronized group.

### Manual validation this slice does not claim

Recorded as outstanding rather than asserted:

- a real sign-in against the production account API from the simulator, and the
  device appearing in the web device list under a sensible name;
- the keychain round trip on a *signed device* build — the SPM host and the
  simulator both differ from it, and `errSecMissingEntitlement` is precisely the
  failure the nil access group exists to avoid;
- sign-out revocation observed server-side;
- VoiceOver and the largest Dynamic Type sizes on the account tab;
- Arabic right-to-left layout of the account tab specifically.

## Open risks

- **The device name iOS reports.** `AppEnvironment.deviceName()` falls back to
  `ProcessInfo.processInfo.hostName` off macOS, which on iOS is not the name the
  user gave the device. `UIDevice.current.name` is not the answer either — since
  iOS 16 it returns the model name unless entitled — so the web device list may
  show something unhelpful. Left as is: it is honest, needs no entitlement, and
  the fix belongs with R3-D, where the device list is actually rendered.
- **A silently unsaved token.** A `save()` failure keeps the session alive but
  loses it at next launch, with nothing said. Both platforms behave this way
  today. Surfacing it needs a shared, non-blocking notice and correct copy
  (`error.keychain.signIn` currently says macOS), which is a change to the macOS
  UI as well and is out of this slice.
- **Keychain items outlive an uninstall on iOS.** A reinstall can therefore find
  a session the user thought they had removed. Standard platform behavior, not
  specific to Relayium, and not worked around here.
- **No re-validation on foreground.** The account figures go stale while the app
  is backgrounded and only an explicit Refresh updates them. Deliberate: a
  refresh on every foreground would be a network call the user did not ask for
  and another way for a stale result to fight a sign-out.

## Later milestones

**The order changed, and saying so is part of the record.** R3-A listed R3-B as
*link handoff* — Associated Domains plus `parseAppDeepLink` routing. This round
took the account session instead. Link handoff moves down to R3-G, beside the
other work that turns on a trust decision: Associated Domains is an entitlement
and a public claim about a domain, and the honest place for it is the release
that makes the claim visible, not a development build nobody can install. The
rest of R3-A's order stands:

- **R3-C — sending.** Files/Photos picker → `CloudUploadModel`, then the Share
  Extension.
- **R3-D — account management.** Device list, stored-file management, and the six
  `account.*` strings that say Mac.
- **R3-E — realtime.** Pairing code, LAN/nearby, SAS verification.
- **R3-F — lifecycle.** Background `URLSession`, resume, notifications, APNs.
- **R3-G — release.** Universal Links, icons, IAP, App Store submission, and only
  then any website availability change.
