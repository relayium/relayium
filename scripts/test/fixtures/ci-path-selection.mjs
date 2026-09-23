// scripts/test/fixtures/ci-path-selection.mjs — the path-to-lane oracle, held
// once and read by two independent implementations.
//
// ## Why this is a fixture and not a second declaration of the lanes
//
// Nothing here says which paths a workflow watches. The workflows' own
// `on: push: paths:` lists are the only statement of that, and they stay the
// only one — a `.github/ci-lanes.json` restating them would be a drift surface
// whose equivalence test is harder to get right than the thing it guards.
//
// What this file holds is the OPPOSITE: a set of real repository paths and the
// exact set of path-filtered workflows each one must start. That is an oracle,
// not a declaration. It cannot drift into agreement with a broken filter,
// because it never reads a filter.
//
// ## Why two readers
//
// `scripts/test/ci-event-policy-test.mjs` compiles the filters with its own
// YAML parser and its own glob compiler. `scripts/ci/select-lanes.mjs` — the
// script the merge gate actually runs to decide which reusable lanes to call —
// carries a DIFFERENT, narrower reader (it extracts one `on.push.paths` block
// per file rather than parsing a whole workflow) and a different glob compiler,
// and `scripts/test/ci-lane-selector-test.mjs` judges it against these same
// rows.
//
// Two independent implementations judged against one oracle is real
// cross-validation. Had the matrix been copied into both tests, a copy-paste
// would have made them agree while both were wrong — and the merge gate would
// then be selecting lanes by a rule nothing had ever contradicted.
//
// Emptying one lane's `push.paths` must therefore fail in BOTH files, from one
// edit, for the same row. That is the property this file exists to create.
//
// ## Reading a row
//
//   [ realPath, exactSetOfPathFilteredWorkflows, why ]
//
// The SET is asserted, not membership: a filter that is too broad and one that
// is too narrow fail the same way. Six rows are deliberately empty — a path no
// filtered workflow may start. Workflows with no path filter at all
// (`compat.yml`, `repo-hygiene.yml`) are excluded by construction; they run on
// everything, so listing them would make every row say the same thing.
//
// Two entries below were spelled with constants where this array used to live.
// They are written out here because a fixture that imports its own subject is
// not a fixture; `ci-event-policy-test.mjs` asserts that its `FUZZ_INVENTORY`
// and `FUZZ_NIGHTLY` constants still appear in these rows, so the inlining
// cannot silently drift from the names the rest of that file reasons about.

export const PATH_MATRIX = [
  ["server/account/pairroom.go",
    ["android-interop.yml", "go.yml", "inbox-swift-interop.yml", "native-web-pairing.yml",
      "windows.yml"],
    "server-only: none of the three APP lanes may start — not macos.yml, not ios.yml, not "
    + "android.yml. That is a claim about app BUILD AND RELEASE lanes, not about runner "
    + "hardware: native-web-pairing.yml runs on a macOS runner of its own, because an "
    + "acceptance is a different thing from building an app. What does start is every lane "
    + "that COMPILES AND RUNS this server: go.yml, the two acceptances that drive it as the "
    + "signalling half of a real cross-client "
    + "transfer, and windows.yml, whose `realtime` job does the same and names `server/**` for "
    + "exactly that reason. So a change here can break any of them with no edit under apps/ at "
    + "all. Android joined this row when its interop lane stopped omitting its own inputs; "
    + "Windows joined it when its realtime job began compiling and running the real server. "
    + "inbox-swift-interop.yml joined it because its live class builds the whole relayium "
    + "binary and stands up the real account service: every server file is its input, and a "
    + "hand-kept list of 'inbox' paths was rejected for waiting on an innocent-commit failure"],
  ["server/go.mod",
    ["android-interop.yml", "go.yml", "inbox-swift-interop.yml", "native-web-pairing.yml",
      "windows.yml"],
    "the server module: still not a trigger for macos.yml, ios.yml or android.yml — the app "
    + "build and release lanes — and still an input to every lane that builds this module from "
    + "source: the two acceptances, one of which spends a macOS runner on it, and windows.yml's "
    + "realtime job alike, and the narrow Swift<->Go interop lane that builds it on macOS"],
  ["web/src/lib/pair.ts",
    ["android-interop.yml", "native-web-pairing.yml", "web.yml", "windows.yml"],
    "web-only in the sense that matters here: none of macos.yml, ios.yml or android.yml may "
    + "start — the app build and release lanes. native-web-pairing.yml does start, on a macOS "
    + "runner: both cross-client acceptances build and serve the Web bundle this file is compiled "
    + "into, and the peer they drive it against is a real native client, so a realtime-wire or "
    + "pairing change here breaks them directly. windows.yml is a NATIVE BUILD lane and is in "
    + "this set on purpose: the Windows client compiles this module out of `web/src/lib` rather "
    + "than vendoring a copy, which is why this row cannot claim that no native build starts"],
  ["apps/mac/Relayium/AccountView.swift", ["macos.yml", "swift-package.yml"],
    "macOS-only source: the macOS build lane, plus the package suite — which compiles nothing "
    + "under apps/mac and READS it: the Mac surface, privacy, signing and localization guards are "
    + "XCTest cases in apps/RelayiumKit, macos.yml runs no `swift test`, and until the package "
    + "lane watched this tree a Mac-only change ran none of them. No iOS runner, and no pairing "
    + "runner either. The acceptance builds "
    + "`server` and `apps/RelayiumKit` and serves the Web bundle; it never reads, compiles or "
    + "serves a file under apps/mac, so watching this tree would buy a 45-minute macOS runner "
    + "for evidence the run cannot produce. The app's logic lives in apps/RelayiumKit, which the "
    + "pairing filter does name"],
  ["apps/mac/scripts/package-dmg.sh", ["macos.yml", "swift-package.yml"],
    "a macOS release script the macOS `test` job runs: macOS, not iOS, and not the pairing "
    + "acceptance, which does not package a DMG. The package suite starts too, because its "
    + "filter is the whole apps/mac tree rather than a hand-kept list of the files its guards "
    + "open — that list is what drifted on the iOS side"],
  ["apps/ios/Relayium/RelayiumApp.swift", ["ios.yml", "swift-package.yml"],
    "iOS-only source: the iOS build lane, plus the package suite, whose guards read this tree "
    + "the way they read apps/mac. No macOS signing lane, and — since the pairing filter was narrowed off "
    + "`apps/**` — no 45-minute macOS pairing runner either. That acceptance builds "
    + "apps/RelayiumKit and the Web bundle; nothing under apps/ios is an input to it"],
  ["apps/RelayiumKit/Sources/RelayiumKit/Crypto/SealedBox.swift",
    ["ios.yml", "macos.yml", "native-web-pairing.yml", "swift-package.yml"],
    "SHARED source: both native workflows, or one app's break goes unseen — plus the pairing "
    + "acceptance that compiles it and the package's own suite. The rest of that package's "
    + "ownership, including the `!apps/RelayiumKit/Tests/**` exclusions the three heavy filters "
    + "now carry, is `scripts/test/swift-ci-boundary-test.mjs`"],
  ["scripts/ios-ui-session-acceptance.sh", ["ios.yml"],
    "the iOS built-App acceptance: the workflow that runs it, and only that one. The pairing "
    + "workflow does not source this script, and `scripts/**` is gone from its filter"],
  ["scripts/lib/local-acceptance.sh", ["android-interop.yml", "ios.yml", "native-web-pairing.yml"],
    "the isolation library those acceptance runs — Apple and Android alike — are built from"],
  ["scripts/local-transfer-cleanup-test.sh", ["ios.yml"],
    "the launcher's own failure-path test, run by the iOS job and by nothing else"],
  ["scripts/go-race-shard.go", ["go.yml"],
    "a Go helper: it used to start the macOS signing lane through `scripts/**`, and then the "
    + "macOS pairing runner through the same glob in the pairing filter. Both are gone"],
  ["scripts/list-go-fuzz-targets.sh", ["go.yml"],
    "the fuzz campaign's discovery script. It never runs on a pull request — the campaign is "
    + "scheduled — but it enumerates the Go module, so an edit to it must start the workflow "
    + "that proves that module still builds and that every fuzz target's seeds still pass. "
    + "Exactly go.yml: no native runner has any business starting for a Go helper"],
  [".github/workflows/go-fuzz-nightly.yml", ["go.yml"],
    "the campaign workflow itself. It is not in GOVERNED and has no path filter of its own — "
    + "it is scheduled — so nothing would otherwise run a single Go test on a commit that only "
    + "edits it, and its `-fuzz` invocation names targets that live in the Go module go.yml "
    + "compiles"],
  ["scripts/native-web-pairing-acceptance.sh", ["native-web-pairing.yml"],
    "the acceptance script itself: named one file at a time, so it starts its own workflow and "
    + "no other"],
  [".github/workflows/macos.yml", ["macos.yml"], "a workflow edit starts its own workflow only"],
  [".github/workflows/ios.yml", ["ios.yml"], "and the same for the new one"],
  [".github/workflows/go.yml", ["go.yml"], "and for an unrelated one"],
  [".github/workflows/android.yml", ["android.yml"],
    "and the Android build lane's own edit starts itself only"],
  [".github/workflows/android-interop.yml", ["android-interop.yml"],
    "and the Android interop lane's own edit starts itself only"],
  ["contracts/device-inbox-admission-v1.json", ["contracts.yml"],
    "the root contract tree: exactly its own lane, and no consumer suite. All three consumer "
    + "tests read this document, but each already lives in a tree its own workflow watches, so "
    + "naming it in go.yml, web.yml or swift-package.yml would spend the eight-shard race lane, "
    + "the full browser suite and a PAID macOS runner on a document two `go test` functions read "
    + "in milliseconds. What that lane must CONTAIN is "
    + "`scripts/test/contract-ci-policy-test.mjs`; this row is what keeps the lane inside THIS "
    + "file's governed inventory, because a workflow dropped from that list is bound by none of "
    + "the trigger, concurrency or runner-budget rules above"],
  [".github/workflows/contracts.yml", ["contracts.yml"],
    "and the contract lane's own edit starts itself only, like every other workflow here"],
  ["contracts/ops-deploy-v1.json", ["ops-deploy-contract.yml"],
    "the second root contract, and the reason `contracts.yml`'s filter is no longer "
    + "`contracts/**`. Exactly its own lane: NOT contracts.yml, whose web-contract job would "
    + "`npm ci` a Vitest closure for a test that does not exist here and whose swift-contract job "
    + "would take a PAID macOS runner for a document Swift never opens; and not go.yml, even "
    + "though its Go consumer lives under server/ — that test already runs inside `go test ./...` "
    + "on any real server change, and naming the document in go.yml's filter would start the "
    + "EIGHT-SHARD race lane for a JSON edit"],
  [".github/workflows/ops-deploy-contract.yml", ["ops-deploy-contract.yml"],
    "and the deploy contract lane's own edit starts itself only"],
  ["docs/OPS-DEPLOY-CONTRACT.md", [],
    "the deploy contract's prose. No job reads it, so no path-filtered workflow starts — the "
    + "always-on `repo-hygiene.yml` already fails when the contract points at a document that is "
    + "gone, which is the only claim this file carries. Deliberately NOT in the lane's filter, "
    + "for the same reason `docs/DEVICE-INBOX-ADMISSION-CONTRACT.md` is not in contracts.yml's"],
  ["apps/README.md", [],
    "documentation under apps/: not an input to any native build and not an input to the "
    + "pairing acceptance either, so NO path-filtered workflow starts. `apps/**` in the pairing "
    + "filter matched it only because it was coarse"],
  ["apps/android/app/src/main/kotlin/Main.kt", ["android-interop.yml", "android.yml"],
    "the Android platform root, which now exists: exactly its own two lanes — the build/unit/"
    + "lint gate and the emulator interop acceptance — and no Apple or web runner. This row used "
    + "to assert the empty set while the root was future; the day the root appeared, the ONLY "
    + "things that adopted it are the workflows created in the same commit"],
  ["apps/android/gradle/libs.versions.toml", ["android-interop.yml", "android.yml"],
    "the pinned Android catalog: an edit to a version must rebuild and re-prove the platform "
    + "that resolves it"],
  ["apps/windows/src/main/main.ts", ["windows.yml"],
    "the Windows client's privileged process: its own lane and nothing else. No Apple runner, "
    + "no Android build, no web suite. This row used to name a WinUI/C# path and expect [], "
    + "because the root did not exist and no workflow was allowed to adopt it; the root and "
    + "`windows.yml` were then created in the same commit, which is exactly what the "
    + "future-platform rule requires"],
  ["apps/windows/electron-builder.yml", ["windows.yml"],
    "the packaging configuration: the lane that builds the installer, and no other. A change "
    + "to how the EXE is produced must rebuild it"],
  ["scripts/android-interop-acceptance.sh", ["android-interop.yml"],
    "the Android acceptance run itself: its own lane and no other — `scripts/**` appears in no "
    + "filter, so it cannot inherit a macOS runner"],
  ["scripts/test/android-interop-oracle.py", ["android-interop.yml"],
    "the comparison every round of that acceptance is judged by — a RUNTIME input of the run, "
    + "not only a subject of its own mutation test in repo-hygiene. An edit to the rules that "
    + "produce the lane's one bit must re-run the real integration; the selector returning [] "
    + "for this path was measured, and is exactly the under-selection R17 exists to prevent"],
  ["scripts/android-ui-acceptance.sh", ["android-interop.yml"],
    "the offline UI matrix (join-form validation and the launch/recreation lifecycle across the "
    + "en/light and zh/dark/320dp/font2 corners), run in the SAME emulator boot as the wire "
    + "interop. Its own lane and no other — `scripts/**` is in no filter, so it cannot inherit a "
    + "macOS runner; and it drives no Web bundle or Go server, so it belongs to this workflow, "
    + "not web.yml or go.yml"],
  ["scripts/android-ui-session-acceptance.sh", ["android-interop.yml"],
    "the real-DocumentsUI session round (the join form, the system folder AND file pickers, an "
    + "Activity recreation mid-session, bytes both ways against the live browser peer) — the "
    + "evidence for the one thing the wire acceptance stubs. Same emulator boot, same lane and "
    + "no other; it builds the Web bundle and the Go server like the wire run, but those trees "
    + "already reach this workflow through `web/**`/`server/**`"],
  ["web/e2e/android-interop.mjs",
    ["android-interop.yml", "native-web-pairing.yml", "web.yml", "windows.yml"],
    "the browser half the acceptance drives. Three of the four lanes reach it through `web/**` "
    + "rather than by name — web.yml's own suite, the pairing acceptance that serves the "
    + "bundle, and the Android lane that drives this exact file — and windows.yml reaches it "
    + "through `web/e2e/**`, the whole directory rather than the files its realtime job imports "
    + "today, because that harness is shared and a filter that under-triggers is a Windows lane "
    + "which silently stops running. The Android filter used to name this ONE path out of web/ "
    + "while omitting the tree around it, which is how a workflow can watch its harness and miss "
    + "the product the harness exercises"],
  ["scripts/windows-package.ps1", [],
    "a future Windows packaging script: `scripts/**` in a macOS-runner workflow is how it would "
    + "have inherited a macOS runner without anybody choosing that"],
  ["scripts/windows-package.ps1", [],
    "and the same for a future Windows packaging script"],
  ["docs/billing-transparency.md", ["web.yml"],
    "a document that is TEST INPUT, which is why it is not in the empty-set group above. "
    + "`web/scripts/pages/billing-doc-pointers.test.mjs` reads this file and asserts every "
    + "`symbol` (`path:line`) pointer in it still resolves, and that test runs inside web.yml's "
    + "`npm test` step — so the document is an input to that suite exactly like a source file, "
    + "and an edit to it must start the suite that judges it. Exactly web.yml and nothing else: "
    + "no other governed workflow runs that test. Named one file at a time rather than through "
    + "`docs/**`, which would start the full web suite, the accessibility scan and three "
    + "headless-Chrome journeys for every unrelated document in the repository"],
  ["server/cmd/relayium/run.go",
    ["android-interop.yml", "go.yml", "inbox-swift-interop.yml", "native-web-pairing.yml",
      "web.yml", "windows.yml"],
    "a server source file that is ALSO web TEST INPUT. Every lane that compiles and runs this "
    + "server starts, as for any server file; web.yml starts as well because "
    + "`web/scripts/pages/cli-backup-integrity-recovery.test.mjs` reads reportExit's failure "
    + "line out of this file and asserts the SSH backup guide quotes it, and that test runs in "
    + "web.yml's `npm test` step. Only this one file: server/account/pairroom.go above must "
    + "still not start web.yml, so `server/cmd/relayium/**` would be the wrong fix. It also "
    + "starts inbox-swift-interop.yml: it dispatches the `inbox send`/`inbox sent` commands the "
    + "live Swift interop drives, which is exactly the known input design review refused to omit"],
  ["server/internal/inboxlive/central_test.go",
    ["android-interop.yml", "go.yml", "inbox-swift-interop.yml", "native-web-pairing.yml",
      "windows.yml"],
    "the Go half of the live CLI-sender -> native-receiver acceptance. It is build-tagged, so "
    + "no `go test ./...` lane ever compiles it, but it is under server/** like any server file "
    + "and starts every lane that watches that tree — among them the one lane that does run it"],
  ["apps/RelayiumKit/Tests/RelayiumKitTests/InboxCLISenderLiveInteropTests.swift",
    ["swift-package.yml"],
    "the Swift half of that acceptance: a package TEST file, so exactly the package lane, which "
    + "runs it forced. Not inbox-swift-interop.yml — that lane never watches apps/**, or one "
    + "Swift edit would start two macOS runners — and none of the three heavy Apple/pairing "
    + "lanes, whose ordered `!apps/RelayiumKit/Tests/**` exclusions keep a test edit off them"],
  ["scripts/ci/assert-swift-named-execution.mjs", ["inbox-swift-interop.yml"],
    "the named-execution proof both Swift<->Go interop steps run. It starts the narrow lane that "
    + "exercises it on a real log; swift-package.yml's four-entry filter deliberately does not "
    + "grow for it, and the script's own pass/skip/fail/missing cases run on every push in "
    + "repo-hygiene through scripts/test/swift-ci-boundary-test.mjs"],
];
