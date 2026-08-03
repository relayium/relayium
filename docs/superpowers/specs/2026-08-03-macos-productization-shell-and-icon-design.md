# macOS productization — desktop shell and app icon — design

Date: 2026-08-03
Milestone: first macOS productization correction. Client-only. No release
approval, no version bump, no server/web/ops change.

**This slice is an engineering correction, not a launch.** Under
`PROJECT-GOVERNANCE.md` § "Native product launch definition" (added 2026-08-03),
macOS is not launched until product completeness, designed UI quality, a
demonstrated reason to install, release completeness and comparative evidence
all pass. This slice moves three of those five and closes none of them. Nothing
built here may be described as launched, complete, or publicly available; the
resulting artifact is an **engineering build**. The gaps that remain are
enumerated in "Remaining launch gaps" below rather than left implicit.

Topology: **Claude–Codex collaboration mode**, owner-directed. Codex frames and
controls the task; Claude is the sole author of this document, of the
implementation plan and of the implementation itself, and runs the local gates
and a distinct post-implementation self-review of the actual diff. Codex then
performs the independent review, the validation pass, one final English delivery
commit, the push to `main`, the CI verification, and the download-and-verify of
the signed engineering DMG. **Claude never commits and never pushes.** Every task
in the plan ends in evidence, not in a commit.

Because Codex reviews rather than co-authors, the product decisions this design
would otherwise defer are *taken* here with explicit revisit triggers, so the
plan is executable and the decisions are reviewable as written — see "Decisions
taken" at the end.

## The report this answers

The owner installed the latest signed DMG and reported four things: it feels
**rough**, **functionally incomplete**, **visually simplistic**, and it has
**no icon**. Each of those maps to something concrete in this tree.

**No icon.** `apps/mac/Relayium.xcodeproj/project.pbxproj:167` and `:197` both
set `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon` and
`ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME = AccentColor`, and there is no
asset catalog anywhere in the repository — `find . -name '*.xcassets' -o -name
'*.icns' -o -name 'AppIcon*'` returns nothing. Both settings name assets that do
not exist, so `actool` compiles nothing, `CFBundleIconName` is never written,
and the Dock, Finder, ⌘-Tab, Notification Center, the About box and the DMG
window all fall back to the generic application placeholder. This is not a
polish gap; it is a missing build input.

**Functionally incomplete.** `ContentView.swift:20-21` switches the *entire root
view* on `session.state`. A user who is not signed in never sees the app: they
see a sign-in form with two collapsed `DisclosureGroup`s beneath it
(`ContentView.swift:43` "I have a link", `:53` "Nearby device or pairing code").
Every capability that genuinely works signed out — anonymous stored-link
receive, pairing-code join, and both directions of nearby transfer — is
reachable only by first noticing that the two grey triangles under the password
field are not decoration. The app *has* the features; the shell hides them
behind an account it does not need.

**Rough / visually simplistic.** The signed-in shell is a `TabView` with three
tabs (`ContentView.swift:94-129`) inside a window whose default size is
420×460 and whose floor is 380×420 (`RelayiumApp.swift:178`,
`ContentView.swift:132`). At 380pt wide, `DirectHubPane` stacks a segmented
picker, the whole nearby roster, a staging drop zone, the pairing-code
mint/join pair and the verification explainer into one scrolling column. There
is no card, no grouping, no hierarchy above `Text(...).font(.headline)`, and
four hardcoded font sizes (`DirectPane.swift:92`, `RealtimeTextPane.swift:84`,
`RealtimeFileSessionView.swift:52`, `RealtimeTextSessionView.swift:53`). It
reads as an iPhone app that was compiled for the Mac.

## Outcome

Relayium for Mac opens as a desktop application: a real icon in the Dock, and a
window whose left column names every thing the app can do, all five of them
visible at once, whether or not anyone is signed in. Nearby transfer, joining a
pairing code and opening a stored link are ordinary destinations that work with
no account and say so. Creating a stored link and creating a pairing code are
gated — and where they are gated they explain *why* in one sentence and offer
the action that actually fixes it, instead of a greyed button.

Nothing about the wire, the transport, the crypto, the sandbox, the signing
chain, Sparkle, or the nine localizations changes. This is a shell, an icon and
a component vocabulary.

An icon and a sidebar are not, by themselves, a reason to install anything. What
makes this slice worth shipping is stated as a measurable claim below and
verified by hand, not asserted.

## Native versus Web: the benchmark this slice must move

Governance requires that the installed app "deliver a materially better
experience than the Web product" in the important workflows it offers. That is a
comparison, so it needs a method and a number rather than an adjective.

**Method.** For each workflow, count the **user actions** — clicks, keystroke
runs (one field entry counts as one), drags, panel confirmations, window
switches — from *app or browser at rest* to *task complete*. Count them three
times: today's Web client at `relayium.com`, the currently shipped macOS build
(commit `6bd7c61b`), and the build this slice produces. Record whether the
workflow is reachable **while signed out**, and which native mechanism (Finder
drag/drop, `NSOpenPanel`, menu-bar residency, `UNUserNotificationCenter`,
`onOpenURL`, reveal-in-Finder, drag-out file promise) carries the difference.

**The claim.** Every mechanism in the right-hand column already exists in this
tree — `FileDropZone` (drag/drop and `NSOpenPanel`), `MenuBarExtra` +
`LanDiscoveryModel.startResident()` (residency), `TransferNotificationCenter`
(notifications), `RelayiumApp.onOpenURL` (deep links), `ReceivedResultView`
(reveal-in-Finder and drag-out file promises). None of them is new here. What is
new is that they stop being **unreachable**: today four of the six workflows
below are either behind a sign-in form the capability does not need, or inside a
collapsed `DisclosureGroup` under it. A native advantage the user cannot find is
not an advantage. That — not the icon — is this slice's product argument, and it
is why the acceptance pass measures the middle column rather than trusting it.

**Predictions are internal and stay internal.** The table below is a *hypothesis
recorded before measuring*, kept in this design document only, so that a wrong
guess is visible to the reviewer instead of being quietly retro-fitted to
whatever the measurement produces. It is **not** repository evidence and **must
not** be copied into `apps/README.md`, the root `README.md`,
`release-readiness.json` or any other public surface. Only figures that were
actually observed on a running client are written to the repository; a workflow
that could not be measured is recorded as not measured, with the reason.

<!-- INTERNAL HYPOTHESIS — not repository evidence, not for apps/README.md. -->

| workflow | web (hypothesis) | `6bd7c61b` (hypothesis) | this build (hypothesis) | signed out? | native mechanism |
|---|---|---|---|---|---|
| Send files to a device on this network | 6 | 7 | 4 | yes | `FileDropZone` Finder drag/drop |
| Receive from a device on this network | 4 | 5 (behind a disclosure group) | 2 | yes | `LanDiscoveryModel.startResident()` + `MenuBarExtra` |
| Open a `#k=` link somebody sent | 5 | 6 (behind a disclosure group) | 3 | yes | `onOpenURL` + reveal-in-Finder |
| Join a pairing code | 5 | 6 (behind a disclosure group) | 3 | yes | `onOpenURL` |
| Create a pairing code | 5 | 5 | 4 | no | — |
| Send a stored link | 7 | 7 | 5 | no | `NSOpenPanel` + drag/drop |

These numbers are guesses by an agent that has not counted them. Their only job
is to make the acceptance pass falsifiable: if a measured count contradicts one,
the plan says so in a sentence and the *measured* number is what the repository
records.

**What this slice does *not* claim to beat the Web at.** Large or slow
transfers (no background `URLSession`: the transfer dies with the app, which the
quit guard warns about rather than fixes), any workflow that starts outside the
app (no Share extension, no Services entry, no Dock drop target, no Quick
Action), and resumable transfer. In those, native is at parity or behind, and
the launch gap register says so.

## Remaining launch gaps

Against the five governance launch criteria, after this slice ships:

| criterion | after this slice | what still blocks launch |
|---|---|---|
| Product completeness | five named destinations, each with designed empty/loading/failure/active states; every anonymous capability reachable signed out | no background transfer (a transfer dies with the app), no resumable transfer, no Settings scene, no in-app account deletion, no device naming, no Quick Look of received files, no update UI beyond the Sparkle menu item |
| Designed UI quality | native hierarchy, one component vocabulary, semantic type, a11y, light/dark, RTL, nine languages | no native-speaker review of eight languages; no automated UI test of any SwiftUI surface; the icon is reviewed at 16 pt only on whatever displays this machine actually has — a non-Retina comparison is a hardware dependency that may be unavailable and is then reported as unavailable, never as passed |
| A reason to install | the six-workflow benchmark above, to the extent it can actually be measured on this machine | entry points *outside* the app (Share extension, Services, Dock drop) are the largest untaken native advantage and are out of scope here; any workflow the by-hand pass cannot exercise (no peer device, no live link, no account) stays unmeasured and is recorded as unmeasured |
| Release completeness | unchanged: signing, notarization, DMG and appcast machinery already exist and stay untouched; CI produces one **signed, unnotarized** DMG from the delivery commit, which Codex verifies and hands to the owner as an engineering test build | no release approval (`release-readiness.json` stays `approved: false`), no version bump, no notarization submission, no published release, no public download-surface change, no upgrade-path test from the currently installed build |
| Comparative evidence | hands-on visual/product QA with fresh screenshots, plus whatever of the benchmark this machine could actually measure | the owner has not seen this build; owner installed-build feedback is part of acceptance and cannot be produced by this batch |

This table is the honest answer to "is macOS launched now": **no**, and these are
the reasons.

## Non-negotiable invariants

Recorded before implementation, per `PROJECT-GOVERNANCE.md`'s framing rule.

1. **No anonymous capability acquires an account dependency.** Anonymous
   stored-link receive, pairing-code *join*, nearby send and nearby receive
   reach the network with no `Authorization` header and no session object. This
   is a structural property of the view tree, not a comment: the shell never
   reads `session.state`, and the nearby and stored-receive destinations hold no
   reference to `AccountSession` or `bearerToken`. Enforced by a source guard
   (`MacSurfaceGuardTests`) *and* by transport-level assertions
   (`AnonymousCapabilityTests`).
2. **The app icon is derived from the shipped Relayium mark, not redesigned.**
   The glyph path data, the two gradients and their stops come from
   `web/public/favicon.svg` / `web/src/lib/Logo.svelte`, which today carry
   byte-identical artwork. The macOS-canvas rendition of that artwork lives in
   the app's own tree at `apps/mac/Brand/AppIcon.svg`, and a test reads that file
   **and both web files** and fails if any of the three disagree on the glyph or
   the gradients.
3. **Deep-link and incoming-session routing stay deterministic and lossless.**
   `https://relayium.com/d/<id>#k=` still lands on stored receive with the link
   resolved; `https://relayium.com/cross-network#c=<code>` still lands on the
   pairing code with **both** the file and the text model populated. An
   unsolicited nearby session selects the nearby destination in the unique main
   window; while that window is closed the arrival is reported by the existing
   notification and the menu bar — the app does not claim to raise a closed
   window by itself — and reopening the window lands on the nearby destination
   with the session on screen. The link→destination and incoming-kind→destination
   maps are pure functions with exhaustive tests.
4. **Model lifetimes do not move.** Every `@StateObject` in `RelayiumApp`
   stays app-scoped and constructed in the same order against the same shared
   `VerificationPreference`, `LanDiscoveryModel` and `InboundRoom`. The quit
   guard's `isTransferRunning`/`cancelTransfers` closures, `notifications.start()`
   and `lanDiscovery.startResident()` keep firing exactly once from the window
   scene's `.task`.
5. **Menu-bar residency is untouched.** `MenuBarExtra`, its status reporting,
   its pause/resume, its `openWindow(id: "main")` return path and its core
   diagnostic line are behaviorally unchanged. `MenuBarView.swift:53` keeps
   `openWindow(id: "main")` verbatim; what changes is only what that id resolves
   to — see invariant 12.
6. **Nine languages, always, including Arabic RTL.** Every new string lands in
   all nine catalogs in the same task that adds its `L10nKey` case; every key
   removed from the code is removed from all nine in the same task. No new user-facing English literal in Swift. Layout
   uses leading/trailing only — never left/right — and no layout direction is
   forced by hand.
7. **macOS 13.0 stays the floor.** Only APIs available in macOS 13.0 are used.
   In particular: no `ContentUnavailableView`, no `onChange(of:initial:)`, no
   `@Observable`, no `.symbolEffect`, no `.containerRelativeFrame`, no
   `.inspector`. Enforced by a source guard.
8. **No new capability claim.** No new entitlement, no `Info.plist` key other
   than `CFBundleIconName`, no `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`
   change, no Sparkle feed or key change, no `.github/workflows/macos.yml`
   change, and `apps/mac/release-readiness.json` stays `approved: false`.
9. **No fixed font sizes except the security and pairing codes.** Those two are
   the justified exception (below) and live in exactly one file. Enforced by a
   source guard that counts the files containing `.system(size:`.
10. **No invented capability copy.** Every sentence the new UI adds is a
    statement this tree can back. The two gate explanations name the real
    server-side reason (an account pays for stored bytes; an account pays for
    the relayed traffic a minted code reserves) — the same reasons already
    recorded in `ContentView.swift:40-52` and `RealtimeTextPane`'s
    `text.signInToCreate`.
11. **The shared package gains no icon tooling.**
    `apps/RelayiumKit/Package.swift` is **not** modified by this slice, and no
    `AppIconArtwork` or `AppIconGen` target is added to it. iOS and macOS share
    that package; a macOS icon renderer has no business in a cross-platform
    product graph, and an executable target there would be built by every
    consumer of the package. The artwork source and its renderer are app-local:
    `apps/mac/Brand/AppIcon.svg` and `apps/mac/tools/`.
12. **Exactly one main window, and it is unique by construction.** The main
    scene is `Window("Relayium", id: "main")` — a *unique* scene, available
    since macOS 13.0 — not a `WindowGroup`. Apple's documentation for
    `openWindow(id:)` is explicit that presenting a `Window` scene's identifier
    **orders the existing unique window to the front**, whereas presenting a
    `WindowGroup`'s identifier **creates another window**. App-scoped state does
    not fix that: two `WindowGroup` windows render two copies of the same model
    and therefore two Cancel buttons for one live transfer, however app-scoped
    the selection and the presence object are. Uniqueness is the fix; app scope
    is only what keeps the one window consistent across close/reopen.
    Consequences, all asserted: `WindowGroup` appears nowhere in
    `apps/mac/Relayium`; a `Window` scene contributes no File ▸ New Window item
    and no ⌘N; and `TransferQuitGuard` implements
    `applicationShouldTerminateAfterLastWindowClosed(_:) -> false`, so closing
    the unique window leaves the process — and therefore menu-bar residency, the
    room socket and any running transfer — alive.
13. **No artifact of this slice is described as launched.**
    `apps/mac/release-readiness.json`, `apps/README.md`, the root `README.md`,
    Codex's delivery commit message and every report call the result an
    **engineering build**, including the signed DMG that CI produces from that
    commit and that is handed to the owner explicitly as an engineering test
    build. `approved` stays `false`, no notarization is submitted, no release is
    published and no public download surface changes. This is the labeling rule
    from `PROJECT-GOVERNANCE.md` § "Native product launch definition"; a
    truthfulness regression against it is a blocking finding.

### Adversarial acceptance cases

Written before the tests, so the tests are not fitted to whatever the
implementation turns out to do.

- **Launch signed out and receive a link.** With no credential in the keychain,
  paste a `#k=` link, resolve it, save it. Assert every request that reached the
  transport carried no `Authorization` header, and that `requestCount` accounts
  for all of them.
- **Launch signed out and join a code.** `RealtimeSessionModel.join(code:)`
  against a fake channel with an empty token: the session reaches `connecting`,
  the signaling channel is opened, and nothing about the account is consulted.
- **Nearby with no account at all.** `ICEClient.fetch` on the nearby path sends
  no `Authorization`; `nearbyICEServers` still drops every TURN URL.
- **`.ready` with a nil bearer.** The gate must **not** say "sign in" — the user
  *is* signed in. It maps to the existing `account.bearerInvalid` remedy.
- **A stored send while the account is merely loading.** `.restoring` must show a
  loading state, not the sign-in gate. A gate that reads "sign in" during a
  600ms keychain read is a lie the user acts on.
- **A pairing-code deep link arriving while a nearby session is live.** Neither
  event cancels the other; the later one selects the destination; the live
  session keeps running and stays rendered by the destination that owns it.
- **Window closed mid-receive, then reopened.** Closing the window does not end
  the process (invariant 12), so the transfer keeps running; reopening from the
  menu bar rebuilds the view tree onto the nearby destination with the session
  on screen, because the reveal is `.task(id:)` on `activeKind` rather than
  `onChange`.
- **Trying to get a second window at all.** There is no path to one: the scene is
  a unique `Window`, so ⌘N and File ▸ New Window do not exist,
  `openWindow(id: "main")` from the menu bar orders the existing window forward
  rather than creating one, and a deep link arriving while the window is open
  reuses it. A source guard fails if `WindowGroup` reappears anywhere under
  `apps/mac/Relayium`, because uniqueness — not app-scoped state — is what makes
  "one live session, one Cancel button" true.
- **Closing the window while a transfer runs.** The process stays alive, the menu
  bar keeps reporting residency and status, and the quit guard still refuses a
  silent exit.
- **Arabic.** The sidebar is on the trailing edge, the destination content
  mirrors, and the pairing code — a technical token — still reads left to right
  inside its bidi isolate.

## Scope

In:

- a canonical derived artwork file at `apps/mac/Brand/AppIcon.svg` and an
  app-local, reproducible renderer under `apps/mac/tools/` that writes the seven
  tracked PNGs and the `Contents.json` beside them, using only tooling that
  ships with macOS and the Xcode command line tools;
- a real `Assets.xcassets` with a complete 10-slot macOS `AppIcon` derived from
  the shipped mark, plus the `AccentColor` the build settings already name;
- the main scene becoming the unique `Window("Relayium", id: "main")`, and
  `TransferQuitGuard` gaining
  `applicationShouldTerminateAfterLastWindowClosed(_:) -> false`;
- a `NavigationSplitView` shell with five always-visible destinations;
- three new pure types in `RelayiumAppKit` — destination routing, the account
  gate, and single-session presence — with exhaustive tests;
- a small reusable SwiftUI component set, and the destinations rebuilt on it;
- explicit empty / loading / failure / active states for all five destinations;
- desktop window sizing, sidebar sizing, and a bounded reading measure;
- accessibility: labels, hints, grouping, keyboard selection, VoiceOver-legible
  codes;
- 29 new copy keys ×9 languages, 5 removed keys ×9 languages. The removals are
  `content.haveLink`, `content.nearbyOrCode`, `tab.direct`, `tab.link` and
  `text.signInToCreate` — the last because `CapabilityGateView` replaces its
  hand-rolled hint with `gate.createCodeBody`, which covers both the file and
  the text lane. **`tab.account` and `tab.receive` must survive**: `RootView`
  and `AccountTab` in `apps/ios/Relayium` render them, and
  `LocalizationIntegrityTests` fails in both directions — on a catalog key
  nothing references *and* on a referenced key no catalog defines;
- truthful documentation updates in `apps/README.md`, root `README.md` and
  `apps/mac/release-readiness.json`, including the labeling rule (invariant 13);
- the native-versus-Web benchmark **method**, and afterwards whatever that method
  actually observed, plus the launch-gap register, recorded in `apps/README.md`
  as acceptance evidence rather than as a claim.

Out, and deliberately not stubbed:

- any change to `apps/RelayiumKit/Package.swift`, and any icon target in the
  shared package (invariant 11);
- any server, web runtime or `relayium-ops` change;
- any change to `apps/mac/scripts/*` behaviour or to the web runtime;
- any predicted, projected or otherwise unobserved figure in a public document;
- release approval, notarization, publication, appcast, version bump;
- new entitlements, new Sparkle behavior, new `Info.plist` keys beyond
  `CFBundleIconName`;
- background `URLSession`, resumable transfer, device identity, iOS work;
- a DMG background or volume icon (release packaging is not in this slice);
- a Settings scene / preferences window;
- redesigning the Relayium mark, the web client, or any copy that is not new.

**No dead controls.** Nothing above renders as a greyed button with no
explanation. Where a capability is unavailable, the app states the reason and
offers the action that resolves it. `UploadPane.swift:26`'s bare
`.disabled(token.isEmpty)` is exactly the pattern being removed.

## Part 1 — the app icon

### Why derive rather than draw

The mark already exists and is already consistent across the product:
`web/public/favicon.svg` and `web/src/lib/Logo.svelte` carry the same rounded
square, the same two gradients and the same two-arrow glyph, and `Logo.svelte`
says so in a comment ("kept in sync with /favicon.svg, which carries the same
artwork"). The icon is therefore a *rendering* problem, not a design problem:
take that artwork, place it on Apple's macOS icon grid, and rasterize the seven
sizes the platform asks for.

### Where the artwork lives, and what renders it

Three files, all inside the macOS app's own tree, and **none** of them in the
shared Swift package:

- `apps/mac/Brand/AppIcon.svg` — the canonical derived artwork. It is the web
  mark's glyph path, its two gradients and its stroke, re-expressed on the
  documented macOS canvas (1024 square, an 824 body inset by 100, corner radius
  185.4). It is a text file, so a human can open it, a reviewer can diff it, and
  a test can read it.
- `apps/mac/tools/render-app-icon.swift` — the renderer. A single-file Swift
  script run by the toolchain that is already required to build this app
  (`xcrun swift apps/mac/tools/render-app-icon.swift <appiconset path>`), using
  only CoreGraphics and ImageIO — both system frameworks. It reads
  `AppIcon.svg`, not a duplicated Swift constant, so there is exactly one place
  the artwork is written down.
- `apps/mac/tools/README.md` — the one command, and the statement that it is run
  by hand and never by a test or a build phase.

**Why not a SwiftPM target.** The obvious alternative — `AppIconArtwork` and
`AppIconGen` targets in `apps/RelayiumKit/Package.swift` — is rejected on
purpose. That package is the *shared* library behind both the macOS and the iOS
app; an icon renderer for one platform does not belong in a cross-platform
product graph, an `executableTarget` there is built by every consumer of the
package, and it would make `Package.swift` a file this slice edits for a reason
that has nothing to do with the product's code. Keeping the tool app-local costs
one script and buys an unchanged package manifest.

**Reproducibility, without pretending to be byte-exact.** The command is
deterministic in inputs and explicit in invocation: same SVG, same script, same
output paths, never a side effect of `swift test` or of `xcodebuild`. What it is
*not* is guaranteed byte-identical across macOS releases — CoreGraphics
rasterization is a system service and may legitimately change. So the PNGs are
tracked in git as the reviewed artifact, the tool is how they are regenerated,
and the tests assert *structure* (dimensions, alpha topology, colour family at
named sample points), never bytes. Regenerating and finding a byte diff with no
structural diff is a toolchain change, not a regression.

### Geometry

The artwork is a 64-unit artboard. Apple's macOS app-icon grid puts the icon
body in an 824×824 rounded square centred on a 1024×1024 canvas, corner radius
185.4. Expressed as ratios of the canvas edge, so every size renders from the
same numbers:

| quantity | ratio of canvas edge | value at 1024 |
|---|---|---|
| body inset | 100/1024 = 0.09765625 | 100 |
| body size | 824/1024 = 0.8046875 | 824 |
| corner radius | 185.4/1024 = 0.181054688 | 185.4 |
| artboard unit | 0.8046875/64 = 0.0125732422 | 12.875 |
| glyph stroke (5.5 units) | — | 70.8125 |

Two deliberate deviations from a literal copy of the SVG, each recorded rather
than absorbed:

- **The corner radius follows Apple, not the SVG.** The web mark uses `rx=15` on
  64 (23.4%); Apple's grid is 22.5% of the body. The *container* is a platform
  shape — an icon that does not sit on the system's squircle reads as foreign in
  a Dock. The artwork inside it is unchanged.
- **No baked drop shadow.** Apple's own template carries one, but a shadow
  rasterized into the alpha channel cannot adapt to a light or dark Dock, and
  recent Apple tooling moves shadow generation to the system. The mark's own
  top sheen already reads as dimensional. Revisit trigger: if the icon reads
  flat against system icons in the by-hand Dock check, add the shadow as a
  single named constant in the renderer.

### Colours

Taken verbatim from the mark:

- body gradient, `userSpaceOnUse` (0,0)→(64,64): `#a94bff` @0 → `#635bff` @1;
- sheen, (0,0)→(0,64): white at 0.22 alpha @0 → white at 0 alpha @0.55;
- glyph: `#ffffff`, stroke width 5.5, round caps, round joins;
- glyph path, byte for byte:
  `M16 25h25.5M35 17.5 42.5 25 35 32.5M48 39H22.5M29 31.5 21.5 39l7.5 7.5`

### Slots

Ten `Contents.json` entries over seven distinct PNGs — 16pt, 32pt, 128pt, 256pt
and 512pt, each at 1× and 2×, so 32/256/512 are each referenced twice. A slot
list that is short by one is the classic way an icon looks correct in the Dock
and blank in the About box, so completeness is asserted rather than eyeballed.

Completeness is not a preference here. Apple's own configuration guidance —
<https://developer.apple.com/documentation/xcode/configuring-your-app-icon/> —
states that macOS, unlike iOS, requires an asset for **every** size in the set
rather than deriving the rest from a single large image. That is the reason this
slice tracks seven PNGs and asserts ten slots instead of shipping one 1024 and
trusting Xcode to downsample.

### `AccentColor`

`ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME = AccentColor` is already set in
both configurations, so the colorset must exist or the setting stays dangling.
Its value is the web client's **action** accent, not its decorative one:
`web/src/app.css:26` `--accent-action: #6d28d9` for light and `:140`
`#7c3aed` for dark, chosen there specifically because it is the fill that
carries white text at an accessible contrast (`app.css:18-21` records the
measurement). Using `--accent` (`#aa3bff`) would import a colour the web itself
documents as failing contrast for that job.

Recorded trade-off: an app that ships `AccentColor` overrides the user's system
accent for its own controls. That is accepted here for cross-client brand
coherence (governance decision principle 5). Revisit trigger: an owner or user
report that the app ignores their chosen system accent — the remedy is to
delete the colorset and the two build-setting lines that name it.

### How it reaches the bundle

`apps/mac/Relayium` is a `PBXFileSystemSynchronizedRootGroup`
(`project.pbxproj:29-39`) whose only membership exception is `Info.plist`.
Anything added under that folder joins the target by path, so the catalog needs
**no** `.pbxproj` edit — the same property the iOS R3-B slice relied on.

That same property is why `apps/mac/Brand/` and `apps/mac/tools/` are siblings
of `apps/mac/Relayium/` rather than children of it: source artwork and a
developer script must **not** be copied into the shipped bundle. Their location
outside the synchronized root is load-bearing, and the asset test asserts both
sides of it — the catalog is inside `apps/mac/Relayium/`, and `AppIcon.svg` is
not.

`CFBundleIconName` is nevertheless written into `Info.plist` explicitly.
`GENERATE_INFOPLIST_FILE = NO` with a hand-maintained `INFOPLIST_FILE` means the
key normally arrives by merging `actool`'s partial plist, and a silent failure of
that merge is indistinguishable from a missing icon. Writing it by hand costs one
line and makes the acceptance check unambiguous.

## Part 2 — the information architecture

### Destinations

Five, always visible, in a `NavigationSplitView` sidebar. Two sections plus a
standalone account row:

| section | destination | works signed out | SF Symbol |
|---|---|---|---|
| Direct | **Nearby** | yes, both directions | `dot.radiowaves.left.and.right` |
| Direct | **Pairing code** | join yes, create no | `number` |
| Links | **Send a link** | no | `link.badge.plus` |
| Links | **Open a link** | yes | `arrow.down.doc` |
| — | **Account** | it *is* the sign-in | `person.crop.circle` |

Each row carries a compact subtitle in the sidebar, wrapping to a second line
when needed, so the destination is understandable before it is opened rather
than after. This replaces every nested disclosure: there are no
`DisclosureGroup`s left in the macOS app.

The files/text choice stays a mode *within* Nearby and Pairing code — as it is
today (`DirectHubPane.swift:23-30`) — rather than becoming a sixth destination,
because "who is on the other end" and "what am I sending" are orthogonal and the
owner's destination list names five.

### What the shell may and may not know

The shell renders the split view unconditionally and **never switches on
`session.state`**. Only three of the five destinations read the session at all:

- **Nearby** — no session reference of any kind;
- **Open a link** — no session reference of any kind;
- **Pairing code** — reads the gate for the *create* half only; the join half is
  rendered and enabled identically whether or not anyone is signed in;
- **Send a link** — reads the gate;
- **Account** — owns the whole session switch.

### The account gate

A new pure type in `RelayiumAppKit` replaces four ad-hoc patterns: the root
switch in `ContentView`, `UploadPane`'s `.disabled(token.isEmpty)`,
`RealtimeTextPane`'s hand-rolled `if token.isEmpty` hint, and the
`session.bearerToken ?? ""` empty-string sentinel threaded through three panes.

```swift
public struct AccountAccess: Equatable, Sendable {
    public let token: String
    public let retentionSecs: Int64
}

public enum AccountGate: Equatable {
    case allowed(AccountAccess)
    case loading
    case signInRequired
    case unavailable(message: String)
    case verifyEmail(email: String)
    case pendingDeletion(purgeAfter: Int64, reactivateToken: String)
}
```

The mapping, total over `SessionState`:

| session state | gate | remedy the UI offers |
|---|---|---|
| `.restoring` | `.loading` | none — a spinner and `account.restoring` |
| `.authenticating` | `.loading` | none |
| `.loggedOut` | `.signInRequired` | **Sign in** (selects Account), Create account (web) |
| `.failed` | `.signInRequired` | same — the reason belongs on the form, not here |
| `.unavailable(m)` | `.unavailable(m)` | **Try again** → `session.refresh()` |
| `.emailUnverified(e)` | `.verifyEmail(e)` | Open Relayium |
| `.pendingDeletion(p,t)` | `.pendingDeletion(p,t)` | Reactivate (tokenised web URL) |
| `.ready` + non-empty bearer | `.allowed(...)` | — |
| `.ready` + nil/empty bearer | `.unavailable(account.bearerInvalid)` | Try again |

That last row is the case worth naming: a signed-in user with a momentarily
unreadable bearer must never be told to sign in. `account.bearerInvalid` already
exists and already says the true thing ("This Mac's sign-in is no longer valid.
Sign out and sign in again.").

`retentionSecs` rides in `.allowed` because the stored-send destination needs it
for `CloudUploadModel.applyRetentionCap` and it is only knowable from
`.ready`'s usage payload — today that plumbing lives inline in
`ContentView.swift:117-119`.

### Truthful gate copy

Two gated capabilities, two explanations, each naming the real reason:

- **Send a link** — "A link stores the encrypted file on Relayium's servers until
  it expires, so it is billed to an account. Relayium never receives the key.
  Opening a link somebody sent you needs no account."
- **Create a code** — "Creating a code reserves relay capacity that is billed to
  the account that created it. Joining a code somebody else created needs no
  account."

Both end by naming the anonymous half, because the most damaging thing the old
shell did was imply the whole product needed an account. The three anonymous
destinations each carry the matching one-liner
(`nearby.noAccountNeeded`, `download.noAccountNeeded`,
`direct.joinNoAccountNeeded`).

### Single-session presence

`TransferPresence` solves exactly one problem, and it is worth stating narrowly
because an earlier draft of this design over-claimed for it: **inside the unique
window, which of the two direct destinations presents the live session.** It is
not, and cannot be, a defence against a second window; that is invariant 12's
job, and only scene uniqueness achieves it.

Nearby and Pairing code drive the **same** `RealtimeSessionModel` and
`RealtimeTextSessionModel`. Split across two destinations, both would render one
live session, each with its own Cancel — the exact hazard `DirectHubPane`'s
`nearbySession` flag guards against today (`DirectHubPane.swift:16-19`). That
local flag generalizes into an app-scoped, testable type:

```swift
public enum TransferMode: Equatable, CaseIterable, Sendable { case files, text }

@MainActor
public final class TransferPresence: ObservableObject {
    @Published public private(set) var owner: AppDestination?
    @Published public var mode: TransferMode
    public func claim(_ destination: AppDestination, mode: TransferMode)
    public func release(_ destination: AppDestination)
    public func releaseAll()
    public func rendersSession(_ destination: AppDestination) -> Bool
}
```

Rules, all tested: a claim by the owner is idempotent; a claim by a second
destination while one is held is refused (the models already refuse a second
session — this only stops the *rendering* from forking); an incoming session
claims `.nearby` and sets the mode from its kind; returning to `.idle` releases.
The destination that does not own the session shows
`presence.busyTitle`/`presence.busyBody` with a **Show it** button that selects
the owner, rather than a second copy of the session.

### Routing

```swift
public enum AppDestination: String, CaseIterable, Hashable, Sendable {
    case nearby, pairingCode, storedSend, storedReceive, account
}

public enum AppRouting {
    public static func destination(for link: AppDeepLink) -> AppDestination
    public static func destination(forIncoming kind: NearbyReceiveKind) -> AppDestination
}
```

- `.download(url)` → `.storedReceive`
- `.realtime(code:)` → `.pairingCode`
- `.file` / `.text` → `.nearby`

Exhaustiveness comes from the compiler for `AppDeepLink` (the function is a
`switch` with no `default`) and from `CaseIterable` plus a count assertion for
`NearbyReceiveKind`, which gains that conformance.

Determinism contract, stated because "the last one wins" is only acceptable if
nothing else is mutated on the way: both the deep-link handler and the incoming
handler perform exactly one assignment to an app-scoped
`AppNavigationModel.selection`, derived from a pure function of their own input.
Neither reads the other's state, neither cancels a session, and neither clears
the other's pending work. The selection is therefore a function of event order
alone, and every field-population side effect (the join code into both realtime
models, the link text into the download model) is idempotent.

Selection is app-scoped rather than `@State` so that it survives the window's
view tree: closing the unique window and reopening it from the menu bar returns
to the destination the user (or a deep link, or an incoming session) last
selected, and a session that started while the window was closed is on screen
when it comes back. App scope buys continuity across close/reopen — it does not
buy single-window behaviour, which comes from the scene being a unique `Window`.

### Window and layout

| property | today | new |
|---|---|---|
| scene | `WindowGroup(id: "main")` (`RelayiumApp.swift:140`) | `Window("Relayium", id: "main")` — unique, macOS 13.0 |
| last window closed | terminates by default | `applicationShouldTerminateAfterLastWindowClosed` → `false`; the menu bar keeps the process |
| default size | 420 × 460 | 1040 × 700 |
| minimum size | 380 × 420 | 860 × 560 |
| sidebar width | — | min 208, ideal 224, max 288 |
| content measure | full width | prose/forms capped at 720pt and leading-aligned; rosters/lists use the remaining width |

The 720pt cap is a reading-measure decision, not a compatibility one: the
explainer paragraphs in `nearby.explain` and the gate bodies run to several
lines, and prose set at 1000pt is unreadable. The remaining width belongs to the
content that benefits from it — the device roster, the stored-file list, the
device list.

Every destination is a `DestinationScaffold`: a title, an optional subtitle, and
a scrolling body of `SectionCard`s. The scaffold owns the padding, the measure
cap and the `.navigationTitle`, so five screens cannot drift apart.

### The four states, per destination

| destination | empty | loading | failure | active |
|---|---|---|---|---|
| Nearby | roster empty (`nearby.emptyRoster`) / no staged files | joining the room; re-scanning | reconnecting banner; `receive.lastFailure`; staging error | live file or text session |
| Pairing code | idle mint/join form | minting (`direct.creatingCode`) | `.failed` message inline | code + QR + waiting; live session |
| Send a link | no selection (`upload.dropHint`) | uploading with % and Cancel | failed with Try again | link ready with key notice |
| Open a link | nothing pasted (`download.idleHint`) | resolving; downloading with % | bad link / failed inline | manifest, then saved result |
| Account | signed out (the form) | `.restoring` spinner + label | `.unavailable` retry; per-row errors | plan, meters, devices, files |

These are not new behaviours — every one of them already exists in a model. What
is new is that each has a designed surface instead of an `EmptyView()`
(`DownloadPane.swift:19-20`) or a bare `ProgressView()`.

### Components

Seven small reusable views, all in `apps/mac/Relayium/Components/`:

- `DestinationScaffold` — title, subtitle, measure, scroll, navigation title;
- `SectionCard` — a titled group on `Color(nsColor: .controlBackgroundColor)`
  with a 10pt radius; the app's only container chrome;
- `EmptyStateView` — symbol, title, body, optional action (hand-rolled, because
  `ContentUnavailableView` is macOS 14);
- `InlineMessage` — `.info` / `.warning` / `.failure`, replacing the ~14 ad-hoc
  `Text(...).foregroundStyle(.red)` sites;
- `CapabilityGateView` — renders an `AccountGate` that is not `.allowed`;
- `SecurityCodeText` — the pairing code and the SAS, and the **only** file in the
  app containing `.system(size:`;
- `StatusBadge` — a dot-plus-label for residency and session state.

### The one justified fixed size

`SecurityCodeText` keeps 34pt for a pairing code and 26pt for a verification
phrase, monospaced, semibold. The justification is functional, not aesthetic:
both are transcribed by a human from this screen onto another device, often
across a room, and both must present a stable digit grid that cannot reflow or
shrink under a container. Everything else in the app uses semantic text styles.
Consolidating the four existing sites into one view is what makes the "exactly
one file contains `.system(size:`" guard possible.

### Accessibility

- Sidebar is a `List(selection:)` — full keyboard navigation for free; the list
  carries `nav.a11ySections`, each row a label plus its subtitle as a hint, and
  a live session adds `nav.a11yLiveSession` as a trait-bearing badge.
- Every `SectionCard` is `.accessibilityElement(children: .contain)` with its
  title as label — the pattern `NearbyPane.swift:150-151` already uses.
- `SecurityCodeText` sets an accessibility label of the digits separated by
  spaces, so VoiceOver reads "4 0 2 9 1 7" rather than "four hundred two
  thousand nine hundred seventeen". Digits are data, marked
  `// nonlocalized: digits`.
- Primary action per destination carries `.keyboardShortcut(.defaultAction)`;
  destructive confirmations keep their existing `confirmationDialog` roles.
- All colour-carried meaning is paired with a symbol (`InlineMessage` and
  `StatusBadge` always render an SF Symbol beside the text).
- No information conveyed by animation; nothing depends on hover.
- Existing `docs/TESTING-accessibility.md` conventions are followed for the
  by-hand pass.

## Testing

### New Swift tests

| suite | what it proves |
|---|---|
| `AppRoutingTests` | every deep link and every incoming kind maps to one destination; `AppDestination` has exactly five cases; selection is a single assignment |
| `AccountGateTests` | the mapping is total over `SessionState`; `.ready` + empty bearer → `.unavailable(account.bearerInvalid)`, never `.signInRequired`; `.restoring` → `.loading` |
| `TransferPresenceTests` | claim/release/idempotence/refusal; incoming claims `.nearby` and sets the mode; `rendersSession` is true for exactly one destination |
| `AnonymousCapabilityTests` | stored-link resolve **and** download, the nearby ICE fetch, and a pairing-code join all reach the transport with no `Authorization` header and no credential in the URL, built through `AppEnvironment` with no session |
| `AppIconArtworkTests` | **source parity across three files, no new module**: the glyph `d`, both gradients and the stroke width in `apps/mac/Brand/AppIcon.svg` are identical to those in `web/public/favicon.svg` **and** `web/src/lib/Logo.svelte`; the mac SVG carries the four expected subpaths and the two documented deviations (Apple's corner-radius ratio, the 1024/824/100 canvas) and no others; `apps/RelayiumKit/Package.swift` contains neither `AppIconArtwork` nor `AppIconGen` |
| `AppIconAssetTests` | 10 mac slots, exactly the required idiom/size/scale set; every filename exists; seven distinct PNGs; each PNG's IHDR dimensions equal size×scale at 8-bit depth; alpha 0 outside the squircle corner, alpha 255 at the body centre and on the straight edge; the centre pixel is the gradient and a glyph sample is white; `AccentColor.colorset` exists with both appearances; `Info.plist` names `CFBundleIconName = AppIcon`; the catalog is inside the synchronized root and `AppIcon.svg` is outside it; the built `Assets.car` check is gate 5 |
| `MacSurfaceGuardTests` | the shell contains no `session.state`/`AccountSession`; nearby and stored-receive views contain no `AccountSession`/`bearerToken`; exactly one file contains `.system(size:`; no macOS 14+ symbol appears; no `DisclosureGroup` remains; all five destination view files exist; **no file under `apps/mac/Relayium` contains `WindowGroup`**; `RelayiumApp.swift` declares `Window("Relayium", id: "main")` and `applicationShouldTerminateAfterLastWindowClosed` returning `false`; `MenuBarView.swift` still contains `openWindow(id: "main")` |

### Extended existing tests

- `LocalizedCopyTests` — the two gate bodies and the three "no account needed"
  lines render translated in all nine languages and keep their load-bearing
  clause; the five destination names are non-empty and distinct in all nine.
- `LocalizationIntegrityTests` — unchanged code, but it is what fails if any of
  the 29 new keys misses a catalog or any of the 5 removed keys is left behind
  in a catalog after leaving the code.
- `LocalizationSourceGuardTests` — unchanged code; it already scans
  `apps/mac/Relayium` recursively, so the ~18 new view files are covered.

### Gates

1. `cd apps/RelayiumKit && swift test` — full suite, 0 failures.
2. `node apps/mac/scripts/check-release-readiness.mjs` — valid, still
   unapproved; `apps/mac/scripts/test-release-readiness.sh` passes.
3. **iOS compile evidence, because this slice edits shared code.** The removed
   and added `L10nKey` cases and their nine catalogs live in `RelayiumAppKit`,
   which the iOS app compiles against, so macOS-only gates are not sufficient:
   a generic-iOS build of the shared package **and** an unsigned iOS app build
   must both succeed locally, mirroring the `ios-build` job in
   `.github/workflows/macos.yml`.
4. Unsigned universal build:
   `xcodebuild -project apps/mac/Relayium.xcodeproj -scheme Relayium
   -destination 'platform=macOS' ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO
   CODE_SIGNING_ALLOWED=NO build`, then
   `lipo "$app/Contents/MacOS/Relayium" -verify_arch arm64 x86_64`.
5. Icon/plist validation on that product: `Contents/Resources/Assets.car`
   exists; `plutil -extract CFBundleIconName raw Contents/Info.plist` prints
   `AppIcon`; `assetutil --info Contents/Resources/Assets.car` lists an
   `AppIcon` image set with all seven pixel sizes.
6. Localization validation on that product: nine `.lproj` inside the embedded
   `RelayiumKit_RelayiumAppKit.bundle`; `CFBundleLocalizations` still lists nine.
7. Sandbox check with a plain Debug build (not `CODE_SIGNING_ALLOWED=NO`, which
   skips entitlements): `codesign -d --entitlements - "$APP" | grep app-sandbox`.
8. Signed CI/DMG — `.github/workflows/macos.yml` is unchanged and must keep
   passing unmodified: the `signed-build` job's strict `codesign --verify`, the
   entitlement dump, `resign-sparkle.sh`, and `package-dmg.sh` with its
   mounted-app signature check. `Assets.car` is an ordinary sealed resource under
   `Contents/Resources`; it introduces no new signing surface. Claude cannot run
   this gate: it exists only after the delivery commit reaches `main`, so it is
   **Codex's** to verify, together with downloading the `relayium-macos-<sha>`
   artifact for that exact SHA and checking it. No notarization is submitted by
   this slice, which means the DMG's Gatekeeper assessment is expected to report
   an unnotarized artifact — that expected result is recorded honestly rather
   than presented as a pass.

### macOS visual and manual checks (the simulator-equivalent)

macOS has no simulator, so the equivalent is a driven local build. Full list in
the plan's acceptance section, where every row records **run**, **failed**, or
**unavailable** with the missing hardware, peer, account or credential named —
this design assumes no second Mac, no non-Retina display, no real account, no
peer device and no live stored link exist until one is demonstrated to. The
shape is:

- Dock, Finder, ⌘-Tab, About box and Get Info all show the icon at 16/32/128/512.
- Three window sizes: the 860×560 floor, the 1040×700 default, and full screen.
- Window uniqueness: ⌘N and File ▸ New Window are absent; the Window menu never
  lists two Relayium windows; the menu bar's "open Relayium" brings the same
  window forward with its selection intact.
- Close the window: the process survives, the menu-bar item keeps reporting
  residency, and a running transfer keeps running.
- Three languages by `defaults write com.relayium.mac AppleLanguages`:
  `en`, `zh-Hans`, `ar` — the last for mirrored layout with an unmirrored code.
- Signed out: all five destinations reachable; nearby, join and open-a-link
  fully usable; the two gates readable and their remedies live.
- Signed in: stored send, account, devices and stored files unchanged in
  behaviour.
- Deep links: `open 'https://relayium.com/cross-network#c=123456'` and a real
  `#k=` link, with the window both open and closed.
- VoiceOver pass over the sidebar and one live session.
- Increase Contrast and Reduce Transparency both on.
- The six-workflow native-versus-Web benchmark, counted by hand three times —
  the Web client in a browser, a build of baseline `6bd7c61b`, and this build —
  with only observed counts recorded in the repository and every unmeasurable
  workflow named as unmeasured.
- Fresh screenshots of every state that carries a claim, at the default window
  size, in `en` and `ar`, in light and dark.

### What this slice does not claim

- No screen has been reviewed by a native speaker in any of the eight
  non-English languages.
- No signed Release build is exercised by this design; the CI expectations above
  are expectations, not evidence.
- The SwiftUI surfaces remain untested by machine — every automated assertion is
  on a model, a presentation seam, a source property or an asset file. That is
  the tree's existing boundary and this slice does not move it.
- The icon has not been reviewed at 16pt on a Retina and a non-Retina display
  side by side; that is in the by-hand list, not in a test, and it is a hardware
  dependency that may simply be unavailable — in which case the row is reported
  as unavailable rather than skipped silently.
- No workflow that needs a second device, a real account, a live stored link or
  Apple credentials is assumed to be exercisable. Each such row is reported by
  name as run, failed or unavailable.
- Nothing in this slice is verified against a signed, notarized, installed build
  by Claude. The signed DMG is produced by CI after Codex's delivery commit and
  verified by Codex; until then every statement here is about a local
  development build.

## Risks

1. **`actool` partial-plist merge.** If the icon were to depend only on the
   merge, a silent failure would look identical to no icon. Mitigated by writing
   `CFBundleIconName` by hand and by asserting `Assets.car` in the built product.
2. **Synchronized-group assumption.** If Xcode does not classify `.xcassets`
   under a `PBXFileSystemSynchronizedRootGroup` into the Resources phase, the
   catalog silently does not compile. Gate 5 catches it; the fallback is an
   explicit `PBXBuildFile` entry, which is a contained `.pbxproj` edit.
3. **A large view-layer diff.** Roughly 18 new and 10 modified view files. The
   compensating control is that no behaviour moves into the view layer: every
   decision that is not layout goes into a tested `RelayiumAppKit` type.
4. **Rasterizer drift.** Any pixel-exact comparison across macOS versions is
   fragile, so the icon tests assert *structure* (dimensions, alpha topology,
   colour family at named sample points) rather than bytes, and regeneration is
   an explicit command rather than a test side effect.
5. **A unique `Window` and a closed window's event delivery.** `Window` is the
   correct scene, but the deep-link handler and the incoming-session reveal both
   live in the window's content, so a URL that arrives while the unique window
   is *closed* may or may not rebuild it depending on how SwiftUI reopens a
   unique scene. This is exactly what the by-hand deep-link rows (window open
   **and** closed) are for. If a closed-window deep link does not reach
   `onOpenURL`, the bounded fallback is the pattern this file already uses for
   the quit guard: the window scene's existing `.task` hands the delegate a
   closure, and `TransferQuitGuard.application(_:open:)` calls it to bring the
   unique window forward before forwarding the URL to the app-scoped
   `AppDeepLinkRouter`. It is not a reason to keep `WindowGroup`, which trades a
   handled edge case for a rendering bug on the main path.
6. **`applicationShouldTerminateAfterLastWindowClosed` changes quit
   behaviour.** After this slice, closing the window no longer quits the app —
   which is the point (menu-bar residency), and matches what the menu bar and
   the room socket already assume, but it is a visible behaviour change for the
   owner's installed build and is called out here rather than discovered. Quit
   remains ⌘Q and the quit guard still governs it.
7. **The icon renderer is a script, not a build product.** Nothing in CI or in
   `xcodebuild` runs `apps/mac/tools/render-app-icon.swift`, so the tracked PNGs
   and `apps/mac/Brand/AppIcon.svg` can drift apart without a build failing.
   Mitigated by `AppIconArtworkTests` asserting SVG↔web parity and
   `AppIconAssetTests` asserting the PNGs' structure against the slot table; the
   residual risk — an SVG edit that is never re-rendered — is named here and is
   a review item, not an automated one.
8. **`AccentColor` overrides the system accent.** Recorded above with a revisit
   trigger.
9. **Stale documentation.** `apps/README.md` and two `release-readiness.json`
   evidence strings assert a 380pt minimum width. They are corrected; a missed
   one would be a truthfulness regression, which is a blocking finding under
   `PROJECT-GOVERNANCE.md`'s quality rules.

## Decisions taken

An implementation plan cannot be executable while product questions are open, so
each of these routine, reversible choices is taken here with its revisit trigger
attached, rather than deferred into implementation where it would be made
silently. They are taken as **proposals under review**: Codex frames and reviews
this batch, and any of them may be overturned in the review pass without
re-planning the slice.

1. **Icon shadow: none.** A shadow rasterized into the alpha channel cannot
   adapt to a light or dark Dock, and recent Apple tooling generates it at the
   system level. *Revisit if* the by-hand Dock comparison reads flat beside
   system icons — the remedy is one named constant in the renderer.
2. **`AccentColor`: the brand action colour** (`#6d28d9` light, `#7c3aed`
   dark). The colorset must exist anyway or
   `ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME` stays dangling, and
   cross-client brand coherence is decision principle 5. *Revisit if* a user or
   the owner reports that the app ignores their chosen system accent — the
   remedy is deleting the colorset and the two build-setting lines that name it.
3. **Default destination: `.nearby`.** It is the flagship desktop capability,
   it needs no account, and it is the one the Web client cannot do well.
   `.storedReceive` would privilege the most common inbound task, but inbound
   arrives by deep link, which routes itself. *Revisit if* the benchmark's
   measured step counts show receive-a-link is the dominant workflow.
4. **Sidebar footer: read-only.** It reports residency; pause/resume stays in
   Nearby and in the menu bar. A third control site for one toggle is worse
   than a longer path to it. *Revisit if* the by-hand pass finds residency
   unclear without a control beside it.
5. **Window minimum: 860×560.** "Desktop-scale" is the point of the slice, and
   the 380pt floor is what produced the iPhone-app-on-a-Mac report. *Revisit if*
   the by-hand pass at the floor shows the sidebar plus a 720pt measure does not
   fit, in which case the floor moves rather than the measure.
6. **Where the SwiftUI surfaces stay untested by machine.** This tree has no UI
   test target and this slice does not add one; every automated assertion is on
   a model, a presentation seam, a source property or an asset file. *Revisit
   when* a launch-blocking UI regression escapes the by-hand pass — that is the
   evidence that would justify the target.
</content>
</invoke>
