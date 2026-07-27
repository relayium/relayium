# Native macOS R1-G1.5 — signing foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign the macOS app with a real Developer ID identity, move the bearer
token into the data-protection Keychain under a shared access group, and give
`apps/` its first CI coverage.

**Architecture:** Three independent changes that only combine at the end. The
Keychain switch is a query-shape change in `KeychainTokenStore` plus an
entitlement; the signing change is four build settings in the Xcode project; the
CI change is one new workflow with two jobs, one of which needs a certificate and
one of which does not. Nothing user-visible changes except a single forced
sign-out at the switch.

**Tech Stack:** Swift 5.9 / SwiftPM (`apps/RelayiumKit`), Xcode project
(`apps/mac/Relayium.xcodeproj`), GitHub Actions on macOS runners, `codesign` /
`security` command-line tools.

**Spec:** `docs/superpowers/specs/2026-07-27-native-macos-r1g1-5-signing-foundation-design.md`

## Global Constraints

- Team ID: `7PVYUG4YQS`. App ID: `com.relayium.mac` (already registered).
- Keychain access group: `7PVYUG4YQS.com.relayium.shared` in code;
  `$(AppIdentifierPrefix)com.relayium.shared` in the entitlements file.
- Signing is **manual** (`CODE_SIGN_STYLE = Manual`) with a **Developer ID
  Application** identity, in **both** Debug and Release configurations. Local and
  CI must use the same configuration.
- **No migration** is written for existing Keychain items. Anyone on a current
  build is signed out once. Do not add a fallback read of the legacy keychain.
- Every third-party GitHub Action is pinned to a full commit SHA with the version
  in a trailing comment, matching `.github/workflows/release.yml`.
- A missing CI secret must fail the job loudly with `::error::`. Never degrade
  silently to an unsigned build.
- Out of scope, do not add: notarization, Sparkle, `.dmg`, `/apps` page changes,
  Sign in with Apple, Universal Links.

## The certificate is not yet available

`security find-identity -v -p codesigning` on the development machine currently
reports **`0 valid identities found`**. No task in this plan may assume a signing
identity exists. Task 3 is the human step that creates one, and it blocks Tasks 4,
5 and 6.

Tasks 1 and 2 are fully executable today. Do them first — they are real progress
that does not wait on Apple.

### What is verifiable before the certificate exists

| Task | Verifiable now | Needs the certificate |
|---|---|---|
| 1 — CI `test` job | `swift test` locally; workflow YAML parses; the job runs green after a push | — |
| 2 — Keychain switch | new unit tests on the query shape; full `swift test` green; unsigned compile still succeeds | that the entitlement is actually honoured at runtime |
| 3 — certificate + secrets | — | everything |
| 4 — signing settings | the project still parses (`xcodebuild -list`) | that a signed build succeeds; the provisioning-profile question |
| 5 — CI `signed-build` job | YAML parses; shell syntax (`bash -n`) | that the job runs green |
| 6 — acceptance + docs | — | everything |

**GitHub Actions cannot be run locally for this workflow.** There is no macOS
container, and `act` cannot emulate a macOS runner. Every CI verification step in
this plan is "push the branch and read the run". That is the only way.

---

### Task 1: macOS CI — the `test` job

`apps/` has no CI today; the 141 tests in `swift test` have only ever run on a
developer's machine. This task adds the workflow and the one job that needs no
secrets, so it also runs on pull requests from forks.

**Files:**
- Create: `.github/workflows/macos.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: a workflow file that Task 5 extends with a second job named
  `signed-build`. Job name `test`; runner label `macos-15`.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/macos.yml`:

```yaml
name: macos
# apps/ is the only tree this covers, so the path filter keeps a web or server
# commit from starting a macOS runner. workflow_dispatch is the manual escape
# hatch for testing the workflow itself.
on:
  push:
    paths:
      - 'apps/**'
      - '.github/workflows/macos.yml'
  pull_request:
    paths:
      - 'apps/**'
      - '.github/workflows/macos.yml'
  workflow_dispatch:

jobs:
  # No secrets, so this runs on pull requests from forks like any other check.
  test:
    runs-on: macos-15
    steps:
      # Third-party actions are pinned to a full commit SHA (with the
      # human-readable version in a trailing comment) so a compromised or
      # retagged upstream release can't silently change what runs here.
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
      # Recorded in the log so a future failure can be compared against the
      # toolchain that produced the last green run.
      - name: Toolchain versions
        run: |
          xcodebuild -version
          swift --version
      - name: swift test
        working-directory: apps/RelayiumKit
        run: swift test
```

- [ ] **Step 2: Verify the file parses as YAML**

Run:

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/macos.yml')); print('yaml ok')"
```

Expected: `yaml ok`

- [ ] **Step 3: Verify the command the job runs actually passes locally**

Run:

```bash
cd apps/RelayiumKit && swift test 2>&1 | tail -3
```

Expected: `Executed 141 tests, with 1 test skipped and 0 failures`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/macos.yml
git commit -s -m "ci(apps): run swift test on macOS, the first CI apps/ has had

The 141 tests in RelayiumKit have only ever run on a developer's machine —
nothing stopped a push from breaking them. Path-filtered to apps/ so a web or
server commit doesn't start a macOS runner, and secret-free so pull requests
from forks run it too."
```

- [ ] **Step 5: Push and read the run**

```bash
git push -u origin docs/r1g1-5-signing-foundation-spec
gh run watch   # or read the run in the GitHub UI
```

Expected: the `test` job is green. If `gh` reports `HTTP 401`, run
`gh auth login` first — it is not authenticated on this machine.

---

### Task 2: Data-protection Keychain and the shared access group

`KeychainTokenStore` currently builds a query with neither
`kSecUseDataProtectionKeychain` nor `kSecAttrAccessGroup`
(`apps/RelayiumKit/Sources/RelayiumKit/Account/TokenStore.swift:26-30`), so the
token lands in the legacy login keychain where `kSecAttrAccessible` is not
enforced. This task changes the query shape and adds the entitlement. It does not
verify runtime behaviour — that is Task 6, after a certificate exists.

The access group is passed in rather than hardcoded, because `TokenStore` lives
in `RelayiumKit` and the constant belongs beside the other Keychain constants in
`RelayiumAppKit`'s `AppEnvironment`, which `RelayiumKit` cannot import.

**Files:**
- Modify: `apps/RelayiumKit/Sources/RelayiumKit/Account/TokenStore.swift:21-30`
- Modify: `apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift:8-9,65-71`
- Modify: `apps/mac/Relayium/Relayium.entitlements`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/TokenStoreTests.swift`
- Test: `apps/RelayiumKit/Tests/RelayiumKitTests/AppEnvironmentTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `KeychainTokenStore.init(service: String, account: String, accessGroup: String? = nil)`
  - `KeychainTokenStore.baseQuery: [String: Any]` — internal, `@testable`-visible
  - `AppEnvironment.keychainAccessGroup: String` = `"7PVYUG4YQS.com.relayium.shared"`

- [ ] **Step 1: Write the failing tests**

Add to `apps/RelayiumKit/Tests/RelayiumKitTests/TokenStoreTests.swift`:

```swift
    func testBaseQueryUsesDataProtectionKeychain() {
        let s = KeychainTokenStore(service: "svc", account: "acct")
        XCTAssertEqual(s.baseQuery[kSecUseDataProtectionKeychain as String] as? Bool, true)
    }

    func testBaseQueryCarriesTheAccessGroupWhenConfigured() {
        let s = KeychainTokenStore(service: "svc", account: "acct",
                                   accessGroup: "TEAMID.com.example.shared")
        XCTAssertEqual(s.baseQuery[kSecAttrAccessGroup as String] as? String,
                       "TEAMID.com.example.shared")
        // The identifying attributes must survive the addition.
        XCTAssertEqual(s.baseQuery[kSecAttrService as String] as? String, "svc")
        XCTAssertEqual(s.baseQuery[kSecAttrAccount as String] as? String, "acct")
    }

    func testBaseQueryOmitsTheAccessGroupWhenNotConfigured() {
        let s = KeychainTokenStore(service: "svc", account: "acct")
        XCTAssertNil(s.baseQuery[kSecAttrAccessGroup as String])
    }
```

Add to `apps/RelayiumKit/Tests/RelayiumKitTests/AppEnvironmentTests.swift`:

```swift
    func testKeychainAccessGroupIsTheSharedTeamGroup() {
        // Shared, not the default per-app group: R3's iOS app reads the same
        // credential, and changing this later would cost a data migration.
        XCTAssertEqual(AppEnvironment.keychainAccessGroup,
                       "7PVYUG4YQS.com.relayium.shared")
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd apps/RelayiumKit && swift test 2>&1 | grep -E "error:|Executed [0-9]+ tests" | tail -5
```

Expected: compile errors — `'baseQuery' is inaccessible due to 'private'
protection level`, `extra argument 'accessGroup' in call`, and
`type 'AppEnvironment' has no member 'keychainAccessGroup'`.

- [ ] **Step 3: Write the implementation**

Replace lines 21-30 of `apps/RelayiumKit/Sources/RelayiumKit/Account/TokenStore.swift`:

```swift
/// Bearer token persistence in the data-protection keychain as a generic-password
/// item.
public final class KeychainTokenStore: TokenStore {
    private let service: String
    private let account: String
    private let accessGroup: String?

    /// `accessGroup` is nil-able because this type also runs in hosts that have
    /// no entitlement to name one — the SPM test host, chiefly. The app always
    /// passes `AppEnvironment.keychainAccessGroup`.
    public init(service: String, account: String, accessGroup: String? = nil) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }

    /// `kSecUseDataProtectionKeychain` is the load-bearing key: the legacy
    /// file-based login keychain treats `kSecAttrAccessible` as advisory, so
    /// without this the accessibility asked for in `save` is not enforced.
    /// Internal rather than private so the shape can be asserted by tests that
    /// have no entitlement to exercise the real keychain.
    var baseQuery: [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let accessGroup {
            q[kSecAttrAccessGroup as String] = accessGroup
        }
        return q
    }
```

The rest of the type (`save`, `load`, `clear`) is unchanged — they already build
on `baseQuery`.

In `apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift`, add the
constant next to the two existing Keychain constants at line 8-9:

```swift
    public static let keychainAccessGroup = "7PVYUG4YQS.com.relayium.shared"
```

and pass it at line 68:

```swift
            tokenStore: KeychainTokenStore(service: keychainService,
                                           account: keychainAccount,
                                           accessGroup: keychainAccessGroup),
```

In `apps/mac/Relayium/Relayium.entitlements`, add inside the top-level `<dict>`:

```xml
	<key>keychain-access-groups</key>
	<array>
		<string>$(AppIdentifierPrefix)com.relayium.shared</string>
	</array>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
cd apps/RelayiumKit && swift test 2>&1 | tail -3
```

Expected: `Executed 145 tests, with 1 test skipped and 0 failures`.

The one skip is still `testKeychainRoundTripIfAvailable`, and now for a sharper
reason: the SPM test host has no app bundle, so it has no entitlement, so a
data-protection keychain write returns `errSecMissingEntitlement` and the test
converts that to `XCTSkip`. This is expected. Do **not** try to make it pass.

- [ ] **Step 5: Verify the app still compiles**

Run:

```bash
xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build 2>&1 | tail -3
```

Expected: `** BUILD SUCCEEDED **`. Note this flag skips entitlements entirely, so
it proves the code compiles and proves nothing about the Keychain.

- [ ] **Step 6: Commit**

```bash
git add apps/RelayiumKit/Sources/RelayiumKit/Account/TokenStore.swift \
        apps/RelayiumKit/Sources/RelayiumAppKit/AppEnvironment.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/TokenStoreTests.swift \
        apps/RelayiumKit/Tests/RelayiumKitTests/AppEnvironmentTests.swift \
        apps/mac/Relayium/Relayium.entitlements
git commit -s -m "fix(native): store the bearer token in the data-protection keychain

kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly is advisory against the legacy
login keychain, so the token was stored with weaker protection than the code
reads as if it has. kSecUseDataProtectionKeychain moves it somewhere the
attribute is enforced.

The access group is shared (…com.relayium.shared) rather than the default
per-app group so R3's iOS app can read the same credential; choosing it now
costs one string, choosing it later would cost a migration.

No migration for existing items: no signed build has ever been distributed, so
the affected population is empty. That stops being true the moment G5 ships."
```

---

### Task 3: HUMAN — create the certificate and set the CI secrets

**This task is not automatable and blocks Tasks 4, 5 and 6.** It runs on the
developer's machine and in the Apple Developer portal and GitHub settings. An
agent executing this plan must stop here and hand back.

**Files:** none in the repository.

**Interfaces:**
- Produces: a `Developer ID Application: … (7PVYUG4YQS)` identity in the login
  keychain; GitHub secrets `MACOS_SIGNING_CERT_P12_BASE64` and
  `MACOS_SIGNING_CERT_PASSWORD` on `relayium/relayium`.

- [ ] **Step 1: Confirm the starting state**

Run:

```bash
security find-identity -v -p codesigning
```

Expected today: `0 valid identities found`. If an identity is already listed,
skip to Step 4.

- [ ] **Step 2: Create the Developer ID Application certificate**

In Xcode: **Settings → Accounts → (Apple ID) → Manage Certificates… → `+` →
Developer ID Application**.

Two things that bite here:

- Only an **Account Holder** (or an Admin with the right granted) can create a
  Developer ID certificate. If the `+` menu does not offer it, the account lacks
  the role.
- Apple caps Developer ID Application certificates at **five per team**, and they
  cannot be freely revoked and recreated. Do not create one per machine — create
  one and export it.

- [ ] **Step 3: Verify the identity exists**

Run:

```bash
security find-identity -v -p codesigning
```

Expected: at least one line containing
`"Developer ID Application: … (7PVYUG4YQS)"`. Record the full string; Task 4
uses it.

- [ ] **Step 4: Export the identity as a `.p12`**

In **Keychain Access**, find the `Developer ID Application` certificate, expand
it so the private key is included, right-click → **Export 2 items…**, choose
Personal Information Exchange (`.p12`), and set a strong password. Save it
outside the repository — `~/Desktop/relayium-signing.p12` is fine and gets
deleted in Step 7.

Exporting the certificate **without** the private key produces a `.p12` that
imports cleanly on the runner and then fails at `codesign` with no useful error.
Make sure both items are selected.

- [ ] **Step 5: Set the GitHub secrets**

`gh` is not authenticated on this machine; authenticate first:

```bash
gh auth login -h github.com
```

Then:

```bash
base64 -i ~/Desktop/relayium-signing.p12 | gh secret set MACOS_SIGNING_CERT_P12_BASE64 --repo relayium/relayium
gh secret set MACOS_SIGNING_CERT_PASSWORD --repo relayium/relayium   # prompts for the value
```

The web UI equivalent is Settings → Secrets and variables → Actions → New
repository secret.

- [ ] **Step 6: Verify the secrets are set**

Run:

```bash
gh secret list --repo relayium/relayium
```

Expected: both `MACOS_SIGNING_CERT_P12_BASE64` and
`MACOS_SIGNING_CERT_PASSWORD` are listed. Values are never readable back — that
is by design.

- [ ] **Step 7: Delete the exported `.p12`**

```bash
rm -P ~/Desktop/relayium-signing.p12
```

The `.p12` plus its password is the whole signing identity. It is now in GitHub
secrets and in the login keychain; a third copy sitting on the Desktop is pure
risk.

- [ ] **Step 8: Write the runbook in relayium-ops**

Steps 2, 4, 5 and 7 belong in a `macos-signing` runbook in the relayium-ops
repository, following the precedent of the release-signing runbook that
`.github/workflows/release.yml` already points at in its error message. Record
which Apple ID holds the certificate and when it expires (Developer ID
certificates last five years).

---

### Task 4: Signing settings, and the provisioning-profile question

**Blocked on Task 3.**

Four build settings change in each of the two target configurations. The
provisioning-profile question the spec left open is answered here, empirically,
before any CI work depends on the answer.

**Files:**
- Modify: `apps/mac/Relayium.xcodeproj/project.pbxproj:138-139,143` (Debug) and
  `:167-168,172` (Release)

**Interfaces:**
- Consumes: the identity from Task 3.
- Produces: a project that builds signed with no extra flags; a recorded answer
  to whether `keychain-access-groups` needs an embedded provisioning profile.

- [ ] **Step 1: Change the build settings**

In `apps/mac/Relayium.xcodeproj/project.pbxproj`, in **both** the Debug block
(lines 133-161) and the Release block (lines 162-190):

```
	CODE_SIGN_IDENTITY = "Developer ID Application";
	CODE_SIGN_STYLE = Manual;
	DEVELOPMENT_TEAM = 7PVYUG4YQS;
```

replacing the current `CODE_SIGN_IDENTITY = "-";`,
`CODE_SIGN_STYLE = Automatic;` and `DEVELOPMENT_TEAM = "";`.

Leave `ENABLE_HARDENED_RUNTIME = YES` (already set, and required for
notarization in G5) and `CODE_SIGN_ENTITLEMENTS` alone.

- [ ] **Step 2: Verify the project still parses**

Run:

```bash
xcodebuild -project apps/mac/Relayium.xcodeproj -list
```

Expected: the scheme `Relayium` is listed, no parse error. A corrupted
`project.pbxproj` fails here with `Unable to read project`.

- [ ] **Step 3: Build signed, and read the result carefully**

Run:

```bash
xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' -configuration Debug \
  -derivedDataPath /tmp/relayium-dd build 2>&1 | tail -20
```

Two outcomes, both informative:

- `** BUILD SUCCEEDED **` — manual signing works with no provisioning profile.
  This is the expected outcome. Continue to Step 4.
- A failure mentioning `provisioning profile` or
  `does not support provisioning profiles` — a profile **is** required. Do not
  work around it with `CODE_SIGNING_ALLOWED=NO`. Instead: create a Developer ID
  provisioning profile for `com.relayium.mac` in the Apple Developer portal,
  download it, double-click to install, and add
  `PROVISIONING_PROFILE_SPECIFIER = "<profile name>";` to both configurations.
  Then re-run this step. Record the outcome in the Task 6 README update, because
  a profile expires annually and someone has to own the renewal.

- [ ] **Step 4: Verify the signature and the entitlements landed**

Run:

```bash
APP=/tmp/relayium-dd/Build/Products/Debug/Relayium.app
codesign --verify --strict --verbose=2 "$APP"
codesign -d --entitlements - --xml "$APP" | plutil -convert xml1 -o - -
```

Expected: `valid on disk` and `satisfies its Designated Requirement`, and the
entitlements dump contains both `com.apple.security.app-sandbox` and
`7PVYUG4YQS.com.relayium.shared`.

If the access group prints as the literal `$(AppIdentifierPrefix)com.relayium.shared`
rather than expanded, the team was not applied — recheck `DEVELOPMENT_TEAM` in
Step 1.

- [ ] **Step 5: Verify the tests still pass**

Run:

```bash
cd apps/RelayiumKit && swift test 2>&1 | tail -3
```

Expected: `Executed 145 tests, with 1 test skipped and 0 failures`.

- [ ] **Step 6: Commit**

```bash
git add apps/mac/Relayium.xcodeproj/project.pbxproj
git commit -s -m "feat(mac): sign with Developer ID, manually, in both configurations

Manual in both places rather than automatic-locally / manual-on-CI: automatic
signing needs Xcode holding a logged-in Apple account, which a runner does not
have, so CI is manual regardless. Letting local stay automatic would mean local
builds are signed by a Development identity and CI builds by a Developer ID
one — and this round changes Keychain behaviour, which is sensitive to exactly
that difference."
```

---

### Task 5: macOS CI — the `signed-build` job

**Blocked on Task 3.**

Adds the job that imports the certificate and proves the entitlements survive a
real signed build. This is the regression gate the round exists to build: an
entitlement regression is invisible to a compile check and invisible to
`swift test`.

**Files:**
- Modify: `.github/workflows/macos.yml`

**Interfaces:**
- Consumes: the `test` job and workflow scaffolding from Task 1; the secrets from
  Task 3; the signing settings from Task 4.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add the job**

Append to `.github/workflows/macos.yml`, at the same indentation as `test:`:

```yaml
  # Needs the signing certificate, so it cannot run where secrets are
  # unavailable. This repository is public: a fork's pull request cannot read
  # repository secrets, and a job that tried would fail confusingly rather than
  # skip cleanly.
  signed-build:
    runs-on: macos-15
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
      # Materialize the Developer ID identity into a throwaway keychain. Fails
      # loudly if the secrets are unset so a build is never silently produced
      # unsigned once signing is expected.
      - name: Import signing certificate
        env:
          CERT_P12_BASE64: ${{ secrets.MACOS_SIGNING_CERT_P12_BASE64 }}
          CERT_PASSWORD: ${{ secrets.MACOS_SIGNING_CERT_PASSWORD }}
        run: |
          set -euo pipefail
          if [ -z "$CERT_P12_BASE64" ] || [ -z "$CERT_PASSWORD" ]; then
            echo "::error::MACOS_SIGNING_CERT_P12_BASE64 / MACOS_SIGNING_CERT_PASSWORD are not set — see the macos-signing runbook in relayium-ops"
            exit 1
          fi
          keychain="$RUNNER_TEMP/signing.keychain-db"
          keychain_pw="$(openssl rand -base64 24)"
          certfile="$RUNNER_TEMP/cert.p12"
          ( umask 077; printf '%s' "$CERT_P12_BASE64" | base64 --decode > "$certfile" )
          security create-keychain -p "$keychain_pw" "$keychain"
          security set-keychain-settings -lut 21600 "$keychain"
          security unlock-keychain -p "$keychain_pw" "$keychain"
          security import "$certfile" -k "$keychain" -P "$CERT_PASSWORD" \
            -T /usr/bin/codesign -T /usr/bin/security
          # Without a partition list, codesign blocks on a GUI authorization
          # prompt nobody can click and the job hangs until it times out.
          security set-key-partition-list -S apple-tool:,apple:,codesign: \
            -s -k "$keychain_pw" "$keychain" > /dev/null
          # Put it on the search list without evicting the default keychain.
          security list-keychains -d user -s "$keychain" \
            $(security list-keychains -d user | tr -d '"')
          rm -P "$certfile"
          security find-identity -v -p codesigning "$keychain"
      - name: Build (signed, Release)
        run: |
          xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
            -destination 'platform=macOS' -configuration Release \
            -derivedDataPath "$RUNNER_TEMP/dd" build
      # The reason this job exists. An entitlement regression compiles fine and
      # passes swift test; it shows up as a runtime Keychain failure weeks later
      # on somebody's machine.
      - name: Verify signature and entitlements
        run: |
          set -euo pipefail
          app="$RUNNER_TEMP/dd/Build/Products/Release/Relayium.app"
          codesign --verify --strict --verbose=2 "$app"
          ents="$(codesign -d --entitlements - --xml "$app" | plutil -convert xml1 -o - -)"
          printf '%s\n' "$ents"
          printf '%s' "$ents" | grep -q 'com.apple.security.app-sandbox' || {
            echo "::error::app-sandbox entitlement missing from the signed build"; exit 1; }
          printf '%s' "$ents" | grep -q '7PVYUG4YQS.com.relayium.shared' || {
            echo "::error::keychain access group missing or unexpanded in the signed build"; exit 1; }
      - name: Remove signing keychain
        if: always()
        run: security delete-keychain "$RUNNER_TEMP/signing.keychain-db" || true
```

If Task 4 Step 3 found that a provisioning profile is required, add this step
immediately before **Build**, and add `MACOS_PROVISIONING_PROFILE_BASE64` to the
secrets set in Task 3:

```yaml
      - name: Install provisioning profile
        env:
          PROFILE_BASE64: ${{ secrets.MACOS_PROVISIONING_PROFILE_BASE64 }}
        run: |
          set -euo pipefail
          if [ -z "$PROFILE_BASE64" ]; then
            echo "::error::MACOS_PROVISIONING_PROFILE_BASE64 is not set"; exit 1
          fi
          dir="$HOME/Library/MobileDevice/Provisioning Profiles"
          mkdir -p "$dir"
          ( umask 077; printf '%s' "$PROFILE_BASE64" | base64 --decode > "$dir/relayium.provisionprofile" )
```

- [ ] **Step 2: Verify the YAML and the shell**

Run:

```bash
python3 -c "import yaml; w=yaml.safe_load(open('.github/workflows/macos.yml')); print(sorted(w['jobs']))"
```

Expected: `['signed-build', 'test']`

Extract and syntax-check each `run:` block:

```bash
python3 - <<'PY'
import subprocess, yaml
w = yaml.safe_load(open('.github/workflows/macos.yml'))
for job, spec in w['jobs'].items():
    for i, step in enumerate(spec['steps']):
        if 'run' in step:
            r = subprocess.run(['bash', '-n'], input=step['run'], text=True,
                               capture_output=True)
            print(job, i, 'ok' if r.returncode == 0 else 'SYNTAX ERROR: ' + r.stderr)
PY
```

Expected: every line reports `ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/macos.yml
git commit -s -m "ci(apps): verify the signed build's entitlements on every apps/ change

An entitlement regression compiles fine and passes swift test — it surfaces as
a runtime Keychain failure on a user's machine much later. This job signs with
the real Developer ID identity and fails if app-sandbox or the shared keychain
access group is missing from the result.

Skipped on pull requests from forks, which cannot read repository secrets."
```

- [ ] **Step 4: Push and read the run**

```bash
git push
gh run watch
```

Expected: both `test` and `signed-build` are green, and the `signed-build` log
shows the entitlements dump containing `app-sandbox` and
`7PVYUG4YQS.com.relayium.shared`.

Failures to expect on a first run, and what each means:

| Symptom | Cause |
|---|---|
| `security: SecKeychainItemImport: MAC verification failed` | wrong `MACOS_SIGNING_CERT_PASSWORD` |
| `errSecInternalComponent` at `codesign` | the partition list step did not run, or ran against the wrong keychain |
| `No signing certificate "Developer ID Application" found` | the `.p12` was exported without its private key (Task 3, Step 4) |
| Job never starts | the path filter did not match — the push touched neither `apps/**` nor the workflow |

- [ ] **Step 5: Confirm the fork-PR skip by inspection**

There is no fork of this repository to test against, so this condition is
verified by reading it rather than by running it:

```
if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
```

Confirm both branches: a `push` event has no `pull_request` context and takes the
first disjunct; a same-repo pull request satisfies the second. Note in the
handoff that the first real fork PR is the true test.

---

### Task 6: Manual acceptance and documentation

**Blocked on Tasks 3, 4 and 5.**

The Keychain round trip is the one thing neither `swift test` nor CI can verify.
This task performs it by hand and updates the documentation that is now wrong.

**Files:**
- Modify: `apps/README.md` (the signing status line at :47, the build
  instructions, and the ad-hoc ACL caveat at the end)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Build and run**

```bash
xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium \
  -destination 'platform=macOS' -configuration Debug \
  -derivedDataPath /tmp/relayium-dd build
open /tmp/relayium-dd/Build/Products/Debug/Relayium.app
```

- [ ] **Step 2: Perform the acceptance run**

1. Sign in with a real account. **Expect to be signed out first** if this machine
   had a previous build signed in — that is the deliberate one-time cost of
   skipping a migration, not a bug.
2. Confirm the account screen renders plan, traffic and storage.
3. Quit the app entirely (⌘Q, not just closing the window).
4. Relaunch **the same build**.
5. Confirm auto-login succeeds with no Keychain prompt.

Step 5 is the whole point: it proves the token round-trips through the
data-protection keychain under the shared access group.

If a Keychain access prompt appears, do not click through it and call the test
passed — record it. It means the item's ACL did not come out as expected and the
access group configuration needs another look.

- [ ] **Step 3: Confirm the item landed in the right keychain**

```bash
security find-generic-password -s com.relayium.mac -a bearer-token 2>&1 | head -3
```

Expected: `The specified item could not be found in the keychain.` — this
command searches the **legacy** keychain, and the item is no longer there. That
error is the success condition. Finding the item means the switch did not take
effect.

- [ ] **Step 4: Update `apps/README.md`**

Three changes:

1. Replace the closing line — `Real Developer ID signing + notarization is a
   later round (R1-G5); for now CODE_SIGN_IDENTITY = "-" and
   CODE_SIGNING_ALLOWED=NO keep local builds ad-hoc.` — with a statement that
   builds are signed with a Developer ID identity under Team `7PVYUG4YQS`,
   manually in both configurations, and that **notarization and distribution**
   remain R1-G5.
2. Keep the `CODE_SIGNING_ALLOWED=NO` quick build, and label it precisely: it is
   a compile check, it skips entitlements, and it therefore cannot answer any
   question about the sandbox or the Keychain.
3. Delete the final paragraph about relaunching the same build because an ad-hoc
   signature ties the Keychain ACL to that binary. It no longer applies. In its
   place, record the two things a future round needs to know:
   - the Keychain round trip is covered by manual acceptance only, because the
     SPM test host has no app bundle and therefore no entitlement; an app-hosted
     XCTest target would close the gap but needs a GUI session on the runner,
     which costs more than the gap is worth;
   - if Task 4 Step 3 required a provisioning profile, name it and record its
     expiry.

- [ ] **Step 5: Verify the documented commands actually work**

Run each command block quoted in the edited section of `apps/README.md`.
Expected: each succeeds as documented. A README that documents a command nobody
ran is how the ad-hoc caveat survived past its usefulness.

- [ ] **Step 6: Commit**

```bash
git add apps/README.md
git commit -s -m "docs(apps): builds are signed now, and the ad-hoc caveat is gone

The warning about relaunching the same build applied to ad-hoc signatures
tying a Keychain ACL to one binary; a stable Developer ID identity removes it.
Records what replaced it: the Keychain round trip is manual-acceptance-only,
because the SPM test host has no bundle and so no entitlement."
```

---

## Self-review

**Spec coverage.** Every section of the design maps to a task: signing
configuration → Task 4; Keychain switch → Task 2 (code) and Task 6 (verification);
CI → Tasks 1 and 5; testing and Done-when → Tasks 2, 4, 5, 6; README → Task 6.
The spec's "verify before assuming" instruction about the provisioning profile is
Task 4 Step 3, with both outcomes written out. The certificate prerequisite,
absent from the spec because the spec assumed it existed, is Task 3.

**Done-when coverage.** `swift test` green on CI and locally → Tasks 1, 2;
`codesign --verify --strict` → Tasks 4, 5; entitlements dump → Tasks 4, 5; manual
auto-login acceptance → Task 6; fork PR behaviour → Task 5 Step 5; README no
longer says signing is G5 → Task 6.

**Known gaps, stated rather than hidden.** The fork-PR skip is verified by
inspection, not execution. The Keychain round trip is verified by hand, not by
any automated suite. Both are recorded in the tasks that own them.
