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
  ["server/account/pairroom.go", ["go.yml", "native-web-pairing.yml"],
    "server-only: no native runner may start"],
  ["server/go.mod", ["go.yml", "native-web-pairing.yml"],
    "the server module: still not a native trigger"],
  ["web/src/lib/pair.ts", ["native-web-pairing.yml", "web.yml"],
    "web-only: no native runner may start"],
  ["apps/mac/Relayium/AccountView.swift", ["macos.yml"],
    "macOS-only source: no iOS runner, and no pairing runner either. The acceptance builds "
    + "`server` and `apps/RelayiumKit` and serves the Web bundle; it never reads, compiles or "
    + "serves a file under apps/mac, so watching this tree would buy a 45-minute macOS runner "
    + "for evidence the run cannot produce. The app's logic lives in apps/RelayiumKit, which the "
    + "pairing filter does name"],
  ["apps/mac/scripts/package-dmg.sh", ["macos.yml"],
    "a macOS release script the macOS `test` job runs: macOS, not iOS, and not the pairing "
    + "acceptance, which does not package a DMG"],
  ["apps/ios/Relayium/RelayiumApp.swift", ["ios.yml"],
    "iOS-only source: no macOS signing lane, and — since the pairing filter was narrowed off "
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
  ["scripts/lib/local-acceptance.sh", ["ios.yml", "native-web-pairing.yml"],
    "the isolation library those acceptance runs are built from"],
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
  ["apps/android/app/src/main/kotlin/Main.kt", [],
    "a platform root that does not exist yet: no current workflow may adopt it. This is the "
    + "whole point of removing `apps/**` — the day somebody creates this file, the ONLY thing "
    + "that runs is what its own new workflow says, plus the unfiltered always-on gates"],
  ["apps/windows/Relayium/App.xaml.cs", [],
    "the same, for the other plausible future root"],
  ["scripts/android-emulator-acceptance.sh", [],
    "a future Android script: `scripts/**` in a macOS-runner workflow is how it would have "
    + "inherited a macOS runner without anybody choosing that"],
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
];
