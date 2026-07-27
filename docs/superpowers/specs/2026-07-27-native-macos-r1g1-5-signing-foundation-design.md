# Native macOS R1-G1.5 — signing foundation — design

Real code signing for the macOS app, the Keychain switch that has been waiting
on a Team ID, and the repository's first macOS CI job. No notarization, no
packaging, nothing a user can download — those stay in G5.

## Background

R1-G1 shipped the app shell, login, and Keychain persistence (merged as
`40144d12`). It closed with three recorded debts (`a50876a5`), one of which was
this:

> `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` is advisory against the
> legacy login keychain; it needs the data-protection keychain, which needs the
> Team ID and access group that arrive in G5.

That debt is real. `KeychainTokenStore` (`apps/RelayiumKit/Sources/RelayiumKit/Account/TokenStore.swift:26-30`)
builds a query with neither `kSecUseDataProtectionKeychain` nor
`kSecAttrAccessGroup`, so every item lands in the legacy file-based login
keychain, where the accessibility attribute the code asks for is not enforced.
The bearer token — a credential with no expiry, minted by
`issueBearer` (`server/account/native.go:19`) — is therefore stored with weaker
protection than the code reads as if it has.

The second debt, WebRTC on a floating branch, is closed (`1ae87911`: WebRTC and
swift-sodium are now pinned to exact versions). The third — native sign-out
revoking nothing server-side — is untouched by this round and stays open.

The gate on the Keychain debt has now lifted: the Apple Developer Program
membership exists, and with it a Team ID (`7PVYUG4YQS`) and a registered App ID
for `com.relayium.mac`.

## Why this is its own sub-round

G1's decomposition (`2026-07-26-native-macos-r1g1-app-shell-account-design.md:23-31`)
put signing in G5, after G2–G4, gated on Apple Developer Program membership.
The membership arrived early, which makes the original ordering the wrong one:

- **The Keychain debt cannot be fixed without signing.** The data-protection
  keychain requires an access group under the team prefix, and
  `$(AppIdentifierPrefix)` only resolves when the app is signed with a real team
  identity. Under the current ad-hoc configuration (`CODE_SIGN_IDENTITY = "-"`)
  the switch fails with `errSecMissingEntitlement`. Left in G5, the debt would
  stand through all of G2, G3 and G4.
- **Ad-hoc signing actively costs time during manual acceptance.** A sandboxed,
  ad-hoc-signed binary ties a Keychain item's ACL to that binary's signature, so
  rebuilding between two launches can produce a false auto-login failure —
  documented at the end of `apps/README.md`. Every manual acceptance in G2–G4
  pays that tax until a stable signing identity exists.
- **The riskiest part of macOS release automation is the signing setup, not the
  notarization call.** Importing a `.p12` into a temporary keychain on a runner,
  unlocking it, and setting the partition list so `codesign` does not block on an
  authorization prompt nobody can click — that is where release pipelines fail.
  Doing it now, with no release pressure, leaves G5 as "add notarization and
  packaging to a pipeline that already signs".

Splitting also keeps the thing that should stay late, late: nothing in this round
produces an artifact for a user. Notarizing and publishing an app that cannot yet
transfer a file would invite people to download something useless.

## Updated R1-G decomposition

| Sub-round | Scope | Gated on |
|---|---|---|
| G1 | App shell, login, Keychain persistence, usage rendering | **done** (`40144d12`) |
| **G1.5** | Developer ID signing, `keychain-access-groups`, data-protection Keychain, first macOS CI job | **this spec** — Apple Developer Program membership |
| G2 | Cloud transfer UI: drag in → upload → `#k=` link; paste link → download → Reveal in Finder | G1 |
| G3 | Realtime transfer UI: pairing code, SAS confirmation, progress, Bonjour discovery | G1 + two Kit contract debts |
| G4 | Universal Links (`/d/*`, `/cross-network`) + user notifications | G2/G3, plus `RELAYIUM_APPLE_APP_IDS` |
| G5 | Notarization, Sparkle, `.dmg`, `/apps` page flip | G1.5 + G2/G3/G4 |

G2–G5 keep their numbers. Renumbering would invalidate the references already in
`apps/README.md`, in G1's spec, and in commit messages.

## Scope

**In:**

- `DEVELOPMENT_TEAM = 7PVYUG4YQS`, manual signing with a Developer ID
  Application identity, in both Debug and Release configurations.
- `keychain-access-groups` entitlement naming `$(AppIdentifierPrefix)com.relayium.shared`.
- `KeychainTokenStore` switched to the data-protection keychain, in that access
  group.
- `.github/workflows/macos.yml`: `swift test` plus a signed build whose
  entitlements are verified.
- `apps/README.md` updated — the signing status line, the build instructions, and
  the ad-hoc ACL caveat that no longer applies. The `CODE_SIGNING_ALLOWED=NO`
  quick build survives as a compile check and is documented as exactly that: it
  skips entitlements, so it can no longer answer any question about the sandbox
  or the Keychain.

**Out, each for a reason:**

- **Notarization, Sparkle, `.dmg`, `/apps` flip** — G5. This round ships no
  artifact to anyone.
- **Sign in with Apple.** G1 deferred it to "the first sub-round that has a Team
  ID", which is now literally this one. It stays out anyway: it is a login
  feature belonging to the account line of work, and folding it in would mix a
  user-visible behaviour change into a round whose entire value is that nothing
  user-visible changes. It moves to G2.
- **Universal Links** — G4. The value it was waiting on is now known and recorded
  below.
- **A migration for existing Keychain items** — see below.

## Signing configuration

`apps/mac/Relayium.xcodeproj/project.pbxproj` currently carries
`DEVELOPMENT_TEAM = ""`, `CODE_SIGN_STYLE = Automatic` and
`CODE_SIGN_IDENTITY = "-"` in both configurations. All three change: the team is
set, the style becomes `Manual`, and the identity becomes
`Developer ID Application`.

Manual in both places — locally and on CI — is a deliberate choice over the
easier "automatic locally, override on the command line in CI". Automatic
signing depends on Xcode holding a logged-in Apple account to request and
refresh provisioning profiles, which a GitHub-hosted runner does not have, so CI
must be manual regardless. Letting local development stay automatic would mean
local builds are signed by an Apple Development identity while CI builds are
signed by a Developer ID identity — two configurations, one of them unverified.
That is tolerable in general and not tolerable here: this round changes Keychain
behaviour, and Keychain ACL behaviour is sensitive to the signing identity. What
CI verifies must be what the developer runs.

**To verify before building on the assumption:** whether a Developer ID
provisioning profile must be embedded in the app for the `keychain-access-groups`
entitlement to be honoured. An access group under the app's own team prefix
should not require one, but "should not" is a weak position in Apple's signing
system. The implementation plan makes this its first empirical step — build, run,
observe whether `SecItemAdd` returns `errSecMissingEntitlement` — rather than
assuming either answer. If a profile turns out to be required, it expires
annually, which introduces a renewal owner question that this spec does not
prejudge.

## Keychain: the data-protection switch

The change is small. `baseQuery` in `TokenStore.swift:26-30` gains two keys:

- `kSecUseDataProtectionKeychain: true` — use the modern keychain, where
  `kSecAttrAccessible` is enforced rather than advisory.
- `kSecAttrAccessGroup: "7PVYUG4YQS.com.relayium.shared"` — a shared group rather
  than the default per-app group, so R3's iOS app can read the same credential
  without a second migration. Choosing the shared group now costs one string;
  choosing it later would cost a data migration for every signed-in user.

The entitlements file gains `keychain-access-groups` with
`$(AppIdentifierPrefix)com.relayium.shared`. `AppEnvironment.keychainService`
(`com.relayium.mac`) and `keychainAccount` (`bearer-token`) are unchanged —
`AppEnvironment.swift:8-9`.

**No migration is written for existing items.** After the switch, the item in the
legacy login keychain is invisible to the new queries; anyone running a current
build is silently signed out once and signs in again. The justification is that
the set of affected people is empty by construction: no signed build has ever
been distributed, so the only installs that exist are developer builds.

This justification has an expiry date, and it is worth stating plainly because
the next person to touch the Keychain layout will not have this conversation in
front of them: **once G5 ships a notarized build to real users, changing the
Keychain layout requires a migration.** The cheap option is available exactly
once, and this round is the last moment it is available.

The alternatives were a one-shot migration (read legacy, write new, delete
legacy) and a permanent dual-read fallback. The first writes code that no user
needs and that runs at most once; the second keeps the legacy path alive forever
to serve nobody.

## CI: the first macOS job

`apps/` has no CI coverage today. The 141 tests in `swift test` have only ever
run on a developer's machine, and nothing prevents a push from breaking
RelayiumKit. This round adds `.github/workflows/macos.yml`, triggered on `push`
and `pull_request` filtered to `apps/**` and the workflow file itself, plus
`workflow_dispatch`. Two jobs:

**`test`** — `runs-on: macos-latest`, runs `swift test`. Needs no secret, so it
runs on pull requests from forks like any other check.

**`signed-build`** — needs the signing certificate, so it is skipped where
secrets are unavailable:

```yaml
if: github.event_name != 'pull_request' ||
    github.event.pull_request.head.repo.full_name == github.repository
```

This is not a convenience. The repository is public; a fork's pull request cannot
read repository secrets, and a job that tried would fail confusingly rather than
skip cleanly.

The job materializes the certificate following the pattern `release.yml` already
proves: fail loudly with `::error::` if the secret is unset rather than silently
degrading to an unsigned build, write with `umask 077`, and delete in an
`if: always()` step. It then creates a temporary keychain, imports the `.p12`,
unlocks it, sets the partition list so `codesign` does not block on an
authorization prompt, and builds with `xcodebuild -configuration Release` —
without `CODE_SIGNING_ALLOWED=NO`, which skips entitlements entirely and would
defeat the purpose.

Two verifications follow, and they are the point of the job:

- `codesign --verify --strict` — the signature is valid.
- `codesign -d --entitlements -` — both `app-sandbox` and
  `keychain-access-groups` are present, with the expected access group string.

The second one is what makes this round's entitlement changes defensible over
time. An entitlement regression is invisible to a compile check and invisible to
`swift test`; it shows up as a runtime Keychain failure on somebody's machine
weeks later.

New secrets: `MACOS_SIGNING_CERT_P12_BASE64` and `MACOS_SIGNING_CERT_PASSWORD`.
The temporary keychain's own password is generated on the runner and never
stored. Third-party actions are pinned to full commit SHAs, as everywhere else in
`.github/workflows/`. The procedure for exporting the certificate and setting the
secrets belongs in a relayium-ops runbook, following the precedent set by
`release.yml`'s error message, which points at the release-signing runbook there.

## Testing

**What CI covers:** `swift test` (141 tests, 1 skip), signature validity, and
entitlement contents.

**What CI cannot cover, stated so it is not mistaken for coverage:** the actual
Keychain round trip. `testKeychainRoundTripIfAvailable`
(`Tests/RelayiumKitTests/TokenStoreTests.swift`) catches a failing `SecItemAdd`
and converts it to `XCTSkip` — it is the one skip in the current suite, because
the SPM test host has no app bundle. After this round it still skips, and for a
sharper reason: without an app bundle there is no entitlement, so a
data-protection keychain write returns `errSecMissingEntitlement`. Read/write
verification stays with the manual acceptance flow in `apps/README.md`.

An app-hosted XCTest target would close that gap and is deliberately not built:
it needs a GUI session on the runner, which costs more than the gap is worth for
a suite whose logic layer is already covered. This is recorded as a known
limitation, not silently accepted.

The manual acceptance flow gets easier in one specific way. The README's warning
about relaunching *the same build* — because an ad-hoc signature ties the
Keychain ACL to that exact binary — stops applying once a stable Developer ID
identity signs every build. That caveat is removed as part of this round rather
than left to mislead.

## Done when

- `swift test` passes with 0 failures, on CI and locally, with the Keychain round
  trip as its only skip (141 tests at the time of writing).
- `xcodebuild -configuration Release build` produces an app that passes
  `codesign --verify --strict`.
- `codesign -d --entitlements -` reports both `app-sandbox` and the
  `7PVYUG4YQS.com.relayium.shared` access group.
- Manual acceptance: sign in, quit, relaunch the app, auto-login succeeds —
  proving the round trip works in the new keychain.
- A pull request from a fork runs `test` and skips `signed-build`.
- `apps/README.md` no longer says signing is R1-G5, and no longer carries the
  ad-hoc ACL caveat.

## Prerequisites recorded for later rounds

- **G2** can implement Sign in with Apple: the entitlement it was blocked on
  needs only the Team ID, which now exists.
- **G4** needs the server's `RELAYIUM_APPLE_APP_IDS` set to
  `7PVYUG4YQS.com.relayium.mac`.
- **G5** additionally needs notarization credentials (an App Store Connect API
  key) and a Sparkle EdDSA signing key. Neither is required by this round, and
  neither should be added to CI before the round that uses it.

## Non-goals

- Any distributable artifact. No `.dmg`, no notarization, no download link.
- Fixing native sign-out revocation. `issueBearer` mints a fresh device row per
  login and `DELETE /api/devices/{id}` is session-only
  (`server/account/handlers.go:139`), so the app cannot revoke its own token.
  Real, unrelated to signing, and scoped separately.
- Any change to what the app does. A user of a G1.5 build sees exactly what a
  user of a G1 build saw, minus one sign-out at the switch.
