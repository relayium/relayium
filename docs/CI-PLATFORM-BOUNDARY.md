# CI platform boundary

Which workflow owns which platform, what "shared" is allowed to mean, and what
has to exist before a new platform may claim a directory under `apps/`.

This document is the prose. `scripts/test/ci-event-policy-test.mjs` is the
enforcement, and where the two disagree the test is right — see
[CI architecture is executable policy, not prose](#ci-architecture-is-executable-policy-not-prose).

## Platform roots

A **platform root** is one directory under `apps/` holding one platform's app
source. Every root has exactly **one heavy owner**: the single workflow that
builds, tests, signs and releases it.

| Root                | Heavy owner            | Runner     |
| ------------------- | ---------------------- | ---------- |
| `apps/mac/`         | `.github/workflows/macos.yml` | `macos-15` |
| `apps/ios/`         | `.github/workflows/ios.yml`   | `macos-15` |
| `apps/RelayiumKit/` | *shared — see [below](#the-shared-swift-package-source-tests-and-fixtures)* | `macos-15` for its own suite |

Path filters in GitHub Actions are per-**workflow**, never per-job. No
arrangement of jobs, `if:` conditions or matrices inside one file can make two
platforms start on different trees. That is why macOS and iOS are two files: the
split had to be a **file** split to be real at all, and it is the reason the rule
below is stated as a property of filters rather than of jobs.

**Rules.**

1. One root, one heavy owner. Two owners is a second platform runner charged on
   every commit for no new evidence; zero owners is a platform that quietly
   stopped being built.
2. A heavy owner's filter must match its own root, and must match **no other
   platform root**. `apps/**` violates this by construction, which is exactly
   what it did before the macOS/iOS split: every iOS-only change started the
   macOS signing lane, and every macOS-only change started an iOS runner.
3. Non-owning workflows may watch a root only when files under it are genuine
   **inputs** to what they run — something the run reads, compiles or serves.
   "The workflow is about that platform" is not the test; `apps/mac/` fails it
   for the pairing acceptance, which speaks for the macOS app without reading a
   file from it. See [native-web-pairing](#the-one-cross-client-exception).

## Apple-shared vs truly cross-platform

These are different contracts and they get different mechanisms.

**Apple-shared** is `apps/RelayiumKit/`: one Swift package, linking WebRTC and
Sodium through SwiftPM, that **both** native apps compile against. A change there
can break either app alone, so it is deliberately listed in `macos.yml`'s filter
**and** in `ios.yml`'s, and it fans out to exactly those two. Nothing outside
macOS and iOS compiles it, so a future Android or Windows workflow watching it
would burn a runner on every Apple change and prove nothing.

**Truly cross-platform** is a *contract* two independent implementations must
agree on — today, the cross-language wire vectors. Those are not shared source;
they are a claim about bytes that Swift, TypeScript and any future client must
all keep. A contract like that gets a fast, always-on gate
([below](#fast-compatibility-gates-vs-heavy-builds)), never a per-platform build.

The distinction matters because the cheap mistake is to treat Apple-shared code
as cross-platform — adding it to every platform's filter — and the expensive one
is to treat a cross-platform contract as one platform's business, which is how a
new client ships against a wire nobody re-checked.

## The shared Swift package: source, tests and fixtures

`apps/RelayiumKit/` is one directory and **three different kinds of input**, and
treating it as one tree cost three macOS runners on every test-only commit.

| Part | Who compiles or reads it |
| ---- | ------------------------ |
| `Sources/**`, `Package.swift`, `Package.resolved` | both app targets, the pairing acceptance's `LocalTransferPeer`, and the package's own suite |
| `Tests/RelayiumKitTests/**` | the package's own suite, and nothing else |
| `Tests/Fixtures/**` | the package's own suite, plus **named** Go and Web tests |

`xcodebuild` compiles the package's **library products**, never its test target.
No release script under `apps/mac/scripts/` opens a file in it. `swift build
--product LocalTransferPeer` — all the pairing acceptance builds of the package —
does not build it either. So a file under `Tests/` is an input to exactly one
thing: `swift test`.

Until `swift-package.yml` existed, the repository's only unfiltered `swift test`
lived in `macos.yml`'s `test` job. That made the package's suite reachable *only*
by starting the macOS workflow, which made the package's tests something the
macOS filter had to name — and `ios.yml` and `native-web-pairing.yml` carried the
same tree for the same reason. Adding one XCTest case started two full
`xcodebuild` graphs, a simulator UI smoke, three acceptance runs and a 45-minute
Swift + Go + Chrome pairing runner, and **not one of them could observe the
change.**

### Ownership matrix

| Change | Starts (path-filtered workflows) |
| ------ | -------------------------------- |
| `Sources/**`, `Package.swift`, `Package.resolved` | `swift-package.yml`, `macos.yml`, `ios.yml`, `native-web-pairing.yml` |
| `Tests/RelayiumKitTests/**` (any test, guards included) | `swift-package.yml` |
| `Tests/Fixtures/device-inbox-manifest-v3-vectors.json` | `swift-package.yml`, `go.yml`, `web.yml` |
| `Tests/Fixtures/crypto-vectors.json` | `swift-package.yml`, `web.yml` |
| `Tests/Fixtures/realtime-wire-vectors.json` | `swift-package.yml`, `web.yml` |
| `Tests/Fixtures/store-wire-vectors.json`, `Tests/Fixtures/account/**` | `swift-package.yml` |

`compat.yml` and `repo-hygiene.yml` are unfiltered and run on **every** row
above, and on everything else. They are omitted for that reason, not because
they are optional.

`swift-package.yml` watches `apps/RelayiumKit/**` with **no exclusion** and runs
one job: the repository's **sole unfiltered `swift test`**. `ios.yml` still runs
five named `--filter` selectors over `apps/ios` guards — that is the *other*
direction, an `apps/ios/**` change, which `swift-package.yml` does not watch —
and `macos.yml` runs no `swift test` at all any more. The uniqueness is asserted
both structurally over the parsed workflows and as a text scan over every
workflow file on disk, because a workflow the policy does not parse can run
`swift test` just as well as one it does.

### The ordered negation, and why order is load-bearing

`macos.yml`, `ios.yml` and `native-web-pairing.yml` each keep
`apps/RelayiumKit/**` and follow it with:

```yaml
      - 'apps/RelayiumKit/**'
      - '!apps/RelayiumKit/Tests/**'
```

GitHub evaluates a `paths:` list **against each changed file, in order, and the
last pattern that matches decides**. A `!` entry excludes; a later positive entry
re-includes what an earlier `!` excluded; a file no pattern matches does not
match at all. Three consequences, each enforced rather than remembered:

* **Swapping the two lines silently undoes the exclusion** — the negation matches
  first and the positive immediately overrides it. Valid YAML, happy
  `actionlint`, and a diff that reads as a reordering.
* **A filter of nothing but `!` entries matches no file at all**, so its workflow
  never runs — which reports as *no check*, not as a red one. Every filtered
  workflow must carry at least one positive pattern.
* **A negation that is present, correctly ordered and simply wrong** — narrowed
  to `!…/Tests/Fixtures/**`, or pointing at a renamed directory — passes every
  literal list check. So the filters are compiled to regular expressions and
  evaluated against real file paths, in both directions: an ordinary test must
  reach no heavy lane, and the package's *source* must still reach all of them.

### Mixed diffs still start everything

A commit touching package **source and** package tests starts every heavy lane,
because the source file is still a positive match and **one matching file is
enough to start a workflow**. The isolation is about test-**only** and
fixture-**only** changes; it never makes a real source change cheaper to merge.
Three mixed diffs are asserted explicitly so a future "further optimisation"
cannot quietly turn it into a source-change skip:

| Diff | Starts |
| ---- | ------ |
| `Sources/…/SealedBox.swift` + `Tests/…/SealedBoxTests.swift` | `swift-package.yml`, `macos.yml`, `ios.yml`, `native-web-pairing.yml` |
| `Tests/…/InboxManifestTests.swift` + `Tests/Fixtures/device-inbox-manifest-v3-vectors.json` | `swift-package.yml`, `go.yml`, `web.yml` |
| `apps/mac/…/AccountView.swift` + `Tests/…/AeadTests.swift` | `macos.yml`, `swift-package.yml` |

### Why the pairing acceptance excludes the fixtures too

`native-web-pairing.yml`'s exclusion is `!apps/RelayiumKit/Tests/**`, and it does
**not** re-include `Tests/Fixtures/` below it.

The acceptance is the **live** half of the cross-client contract: it starts a
real server, mints a real pairing code through `/api/pair`, and drives a Swift
peer and a real headless Chrome against each other in both role assignments. It
reads no vector file, so a fixture edit cannot change its outcome — it would only
buy a 45-minute macOS runner for evidence the run cannot produce.

The **frozen-bytes** half of that same contract has its own owners, none of them
a macOS runner: `compat.yml` regenerates the vectors from the Web implementation
and requires zero diff, unfiltered, on every commit; and the Swift, Go and
TypeScript suites read the tracked bytes in their own lanes. Live agreement and
frozen agreement are separate evidence with separate owners, and collapsing them
into one filter is what put a seconds-long check behind a macOS runner before.

Re-inclusion is rejected explicitly rather than left to taste:
`apps/RelayiumKit/Tests/**`, `…/Tests/Fixtures/**`, `…/Tests/Fixtures/*` and
`…/Tests/Fixtures/*.json` are each named as forbidden entries in every filtered
workflow but the package's own.

### Why `go.yml` and `web.yml` name exact fixture paths

The fixtures live inside the subtree three heavy workflows exclude — and they are
genuine inputs to tests in **other languages**, which run in workflows that are
not macOS lanes. Those workflows name the individual files:

| Fixture | Read by | Named in |
| ------- | ------- | -------- |
| `device-inbox-manifest-v3-vectors.json` | `server/internal/inboxmanifest/vectors_test.go` | `go.yml` |
| `device-inbox-manifest-v3-vectors.json` | `web/src/lib/inbox-manifest.test.ts` | `web.yml` |
| `crypto-vectors.json` | `web/src/lib/caps-vectors.test.ts`, `web/src/lib/text-vectors.test.ts` | `web.yml` |
| `realtime-wire-vectors.json` | the same two Web suites | `web.yml` |

Each of those tests opens the file from disk and asserts its own implementation
still agrees with the frozen bytes, so the fixture is an input to that suite
exactly like a source file. Without the entry, a regenerated vector lands having
never run the Go or TypeScript half of the contract, and the failure surfaces
later against an innocent commit that happened to touch `server/**` or `web/**`.

**One path at a time, never the directory.** `store-wire-vectors.json` sits in
that same directory and is deliberately absent from both filters: its only
non-Swift consumer is `web/scripts/check-wire-vectors.mjs`, which runs in the
**unfiltered** `compat.yml` — and a workflow with no path filter cannot be made
to miss a file. Naming the directory would start the eight-shard Go race lane, or
the full web suite plus the accessibility scan and three headless-Chrome
journeys, on every Swift test edit.

The claim that these files are inputs is not taken on trust either. The policy
**reads the consuming source** and requires it to still name the fixture, so a
test that quietly stops reading its vector shows up as a filter charging a full
suite for a file nobody opens — the direction that decays without anyone editing
a workflow.

### The `contracts/` tree

`contracts/` now holds two documents:

| Contract | What it freezes | Consumers |
| -------- | --------------- | --------- |
| [`device-inbox-admission-v1.json`](DEVICE-INBOX-ADMISSION-CONTRACT.md) | the Device Inbox admission vocabulary three implementations must agree on | Go, Web, Swift |
| [`ops-deploy-v1.json`](OPS-DEPLOY-CONTRACT.md) | the product facts `relayium-ops`' auto-deploy path already assumes: build inputs, working directories, argv, artifacts, listener port, health surface | see [its own consumer table](OPS-DEPLOY-CONTRACT.md#consumers) — the document carries each reader's status, and this page deliberately does not restate it |

Both are root-level, versioned, runtime-neutral documents that their consumers
parse independently and compare to what they already ship. The second one's
consumer set is a **status** list — enforcement that is planned is recorded as
such rather than published as current — and `ops-deploy-contract-test.mjs` holds
that list to the readers that actually run. This page deliberately keeps no copy
of it, not even a count: a restatement here is a page nobody edits when a phase
lands, and no test reads English, so it would simply be wrong and stay wrong.
That is how these two came to contradict each other once already.

A contract tree is **truly cross-platform**, not Apple-shared, and it does not go
into a heavy Apple filter merely because Swift consumes it.

#### Why the consumer suites do *not* name it

The rule recorded here before the tree existed was the fixture rule above: every
workflow whose suite reads a file under it names that file in its own path
filter. Applied literally, that would have meant `go.yml`, `web.yml` and
`swift-package.yml` each naming the document. It was **not** adopted, and the
cost is the whole reason:

| Filter entry | What a JSON edit would then start |
| ------------ | --------------------------------- |
| `go.yml` | the **eight-shard** `-race` account lane, plus build, vet, suite and govulncheck |
| `web.yml` | the full Vite suite, `npm run build`, an accessibility scan and three headless-Chrome journeys |
| `swift-package.yml` | the whole package suite on a **paid** macOS runner — and a third filter entry, where the file's own rules require exactly two and no exclusion |

The fixture rule is right for the frozen vectors: those bytes are what the Go and
TypeScript manifest implementations are *reproduced against*, so a regenerated
vector genuinely needs the implementation's own suite. This document is read by
two `go test` functions, one Vitest file and one XCTest class — seconds of work —
and the same protection is available for a fraction of the cost.

#### What it starts instead

A cheap lane per **document** — not per tree. Each names exactly its own contract
and its own file, and runs the smallest commands that judge that document's
implementations:

`contracts.yml`, filtered to `contracts/device-inbox-admission-v1.json`:

| Job | Runner | Command |
| --- | ------ | ------- |
| `go-contract` | `ubuntu-latest` | `go test ./account/ -run '^TestDeviceInboxAdmissionContract' -count=1` |
| `web-contract` | `ubuntu-latest` | `npx vitest run src/lib/device-inbox-admission-contract.test.ts` |
| `swift-contract` | `macos-15` | `swift test --filter 'RelayiumKitTests.DeviceInboxAdmissionContractTests'` |

`ops-deploy-contract.yml`, filtered to `contracts/ops-deploy-v1.json`:

| Job | Runner | Command |
| --- | ------ | ------- |
| `go-contract` | `ubuntu-latest` | `go test ./ -run '^TestOpsDeployContract' -count=1` |

plus the two workflows that carry **no** path filter and therefore cannot be
routed around: `compat.yml` and `repo-hygiene.yml`. A contract-only edit starts
no macOS or iOS product build, no signing, no UI test, no native pairing
acceptance, no Go race lane and no browser acceptance — and, since the split, no
lane belonging to a document it did not change.

**The other direction is unchanged.** The three consumer tests live inside
`server/**`, `web/**` and `apps/RelayiumKit/**`, so an ordinary source change
still starts its own owning suite — and that suite still executes the consumer
test, because `go test ./...`, `npm test` and the unfiltered `swift test` all
contain it. Neither lane substitutes for the other: the contract lane catches a
document that stopped matching the code, the owning suites catch code that
stopped matching the document.

#### The third `swift test`, costed deliberately

`swift-contract` is a third host for `swift test` and a third paid macOS runner,
which `scripts/test/swift-ci-boundary-test.mjs` refused by name until this
commit. It is here because the alternatives were worse in both directions:
widening `swift-package.yml` spends the whole package suite on a document edit,
and omitting Swift lets a contract change land with two implementations compared
and the third not — the same "fails later against an innocent commit" shape the
fixture entries exist to prevent.

The cost is bounded where the boundary policy can see it. That file now requires
this host's `swift test` to carry a `--filter`, to select exactly the contract
test class, to run from the package directory, and to keep its filter out of
`apps/RelayiumKit/**`. The repository's **sole unfiltered** `swift test` is still
`swift-package.yml`'s, and that rule is untouched.

#### Why ownership moved from the tree to the document

The rule recorded here when the tree held one document was that a second would
join `contracts.yml` with no workflow edit at all — deliberately, and it was why
the filter was `contracts/**` rather than the file.

`contracts/ops-deploy-v1.json` refuted it. That document has **no** Swift and no
TypeScript consumer, so under the tree-wide filter every edit to it would have
started `web-contract` (an `npm ci` for a test that does not exist for it) and
`swift-contract` (a **paid** macOS runner and a cold SwiftPM resolve for a
document Swift never opens) to re-run two checks that cannot see it. That is the
same "charge a lane for a file nobody reads" shape the contract lane was created
to avoid, pointed the other way.

So each document names its own lane. What the tree-wide filter used to guarantee
for free — that a contract file cannot exist with no owner — is now asserted
directly: `contract-ci-policy-test.mjs` lists `contracts/` **on disk** and
requires every file in it to be started by exactly one lane. A third contract
added with no lane fails that rule on the commit that adds it.

#### Where the rules live

`scripts/test/contract-ci-policy-test.mjs` owns this tree's admission decision:
which lane a contract-only edit starts, which lanes it must not (including the
*other* contract's), that every file in the tree has exactly one owner, that the
owning suites still execute the consumer tests, that each consumer still opens
its document, and what each lane may cost — commands, working directories,
finite timeouts, read-only permissions, the absence of secrets, and which jobs
may hold a paid runner. It compiles each `paths:` list and evaluates it the way
GitHub does, ordered and last-match-wins, and 31 mutations prove every rule can
fail. `swift-ci-boundary-test.mjs` owns the Swift half;
`ci-event-policy-test.mjs` continues to own repository-wide trigger, concurrency
and runner-budget properties, and both contract lanes are in its governed
inventory and its runner-budget list.

#### The deploy contract's always-on half

`contracts/ops-deploy-v1.json` is the first contract whose consumers are not all
in filtered lanes, and deliberately so. Its declarative consumer,
`scripts/test/ops-deploy-contract-test.mjs`, needs no toolchain — no Go, no
`npm install`, no browser — so it runs in `repo-hygiene.yml`, which carries no
path filter.

That placement is the point rather than a convenience. The failure this contract
exists to catch is a **product** change: a build input renamed, a working
directory moved, an npm script gone, a new top-level tree the deploy would
silently record as shipped without rebuilding anything. Filtered to the contract,
the check would only ever run on commits that edit the contract — never on the
commit that invalidates it.

#### The next contract

What a new contract owes: its own consumer tests inside the trees their suites
already watch; a lane naming exactly that document, or an existing lane widened
to it with the cost argued; an entry in `OWNERSHIP` in
`contract-ci-policy-test.mjs`; registration in `ci-event-policy-test.mjs`'s
governed inventory, routing table and runner budgets; and a mutation proving each
of those can fail. Until the lane exists, the orphan rule fails — a contract that
starts nothing is a contract nobody re-checks.


## Fast compatibility gates vs heavy builds

Two kinds of CI work, two sets of rules:

|                | Fast compatibility gate        | Heavy platform build                 |
| -------------- | ------------------------------ | ------------------------------------ |
| Example        | `compat.yml`                   | `macos.yml`, `ios.yml`, `native-web-pairing.yml`, `swift-package.yml` |
| Runner         | `ubuntu-latest`                | `macos-15` (and any future platform runner) |
| Path filter    | **none** — always runs         | narrow, and names its real inputs    |
| Dependencies   | production closure only, from the lockfile | whatever the platform build needs |
| Duration       | seconds (~1.2s install, ~0.5s check) | minutes to tens of minutes     |
| May skip?      | never                          | when no owned tree changed           |

`compat.yml` carries `npm run test:vectors`: it regenerates
`apps/RelayiumKit/Tests/Fixtures/*-wire-vectors.json` from the Web
implementation and requires zero diff. If the Web wire moves and the fixtures do
not, every Swift vector suite keeps passing **against the old wire**, and the two
implementations have diverged with a green board.

That check used to be the first step of `native-web-pairing.yml`, which was wrong
twice over. It waited behind a macOS runner, a Go toolchain, a *full* `npm ci`
and a Chrome install for an answer that needs a checkout, Node and `web/`'s
**production** dependencies; and, worse, it sat **behind that workflow's path
filter**. A contract check that only runs when one platform's trees change is a
contract check the next platform bypasses simply by existing. So `compat.yml` has
no `paths:` at all, on either event, and it is fail-closed: finite timeout, no
`if:`, no `continue-on-error`, no retry, no placeholder job.

#### The fast lane is not dependency-free, and saying it was cost a red gate

This section used to say the gate needed "a checkout and Node", and `compat.yml`
said in a comment that it "never runs `npm ci`". Both were true until commit
`5619f062` added `gen-crypto-vectors.mjs` to the gate's table. That generator
imports `libsodium-wrappers` — a **production** dependency, not a `node:`
builtin — so from that commit the required gate could not run on a clean runner
at all. It was reviewed as green because a developer checkout already had
`web/node_modules` present; a fresh runner gets `ERR_MODULE_NOT_FOUND` before a
single byte is compared.

The lesson is not "install more". A required, always-on gate failing for a reason
unrelated to the contract it checks is the shortest path to somebody making it
advisory, so the install is scoped as tightly as it can be and still work:

```yaml
- name: Install the production dependency closure the generators import
  working-directory: web
  run: npm ci --ignore-scripts --omit=dev
```

- **`npm ci`, never `npm install`** — the tree is resolved from
  `package-lock.json` exactly and the lockfile is never rewritten in the job. A
  gate that compares frozen bytes is installed from frozen bytes.
- **`--omit=dev`** — 31 packages instead of the whole tree. The generators need
  `libsodium-wrappers`; they do not need Vite, Vitest, `svelte-check` or
  TypeScript.
- **`--ignore-scripts`** — nothing in that closure needs a lifecycle script, and
  two packages in it (`yargs`, `get-caller-file`) declare `prepare` scripts
  shelling out to `tsc` and `npm run compile`, which `--omit=dev` deliberately
  did not install.
- **No `cache: npm`.** Measured from tracked bytes with an empty npm cache, the
  install is ~1.2s against ~0.5s for the check itself. A `setup-node` cache
  restore-and-save round trip is not reliably cheaper than that, and it would put
  a shared mutable artifact in the path of the one check that gates every merge.

`scripts/test/ci-event-policy-test.mjs` asserts the install's presence, its
position **before** the gate command, its working directory and each of those
flags, and mutates the parsed workflow to prove every one of those assertions can
fail. The general rule the episode produced: **when a gate gains a generator, it
inherits that generator's imports** — check the dependency closure of what the
required lane actually executes, not what it executed when the lane was written.

#### Always-run and fail-closed is one half; the required status is the other

Everything described above about `compat.yml` — no path filter, finite timeout,
no `if:`, no `continue-on-error`, no retry, no placeholder job, and the pinned
dependency install that lets it run at all — is a property of the workflow
**file**, and it is enforced there and asserted by
`scripts/test/ci-event-policy-test.mjs`. It means the gate *starts* on every pull
request and every `main` push and *reports red* when the cross-language contract
breaks.

By itself that does not make a red result **block** a merge. That is a GitHub
**branch protection** rule on `main`; it lives in repository settings rather than
in this repository's source, and **no test here can see it** — which is why this
paragraph, and not an assertion, is where its state is recorded. The status
context is:

```
compat / wire-vectors
```

— the workflow's `name:` and the job key, joined the way GitHub renders a check.

**That context is now required on `main`.** As of **2026-08-21**, after PR #6
merged as `24a29ec6`, `main` protection is enabled and was verified by re-reading
the settings after the write: **strict** required status checks, **exactly one
required context**, bound to GitHub Actions **`app_id` 15368**; `enforce_admins`
false; force pushes and deletions disabled; no required reviews; no push
restrictions. The API reports the context as `wire-vectors` while the merge box
renders `compat / wire-vectors` — a **rendering difference, not a substituted
check**. The `app_id` binding is what stops a differently-owned check with the
same job name from satisfying the rule.

**What `app_id` covers, and what covers the rest.** The binding answers exactly
one substitution: a **differently owned** check — another GitHub App, or an
external service posting a commit status — publishing the context
`wire-vectors` and satisfying the requirement on behalf of a gate that never
ran. It cannot answer the **same-repository** case, because there the impostor
is not differently owned. A job key `wire-vectors` declared in a second workflow
in this repository is GitHub Actions, it is `app_id` 15368, and it reports the
same context name; which run the merge box reconciles the single requirement
against is not something this repository controls. A cheap unrelated lane could
then stand in for the contract gate, and it would report **green**, not missing.

That half is enforced in source, not in settings: **`scripts/test/ci-event-policy-test.mjs`
§6j asserts that `compat.yml` declares a job named `wire-vectors` and that no
other workflow file declares one.** It scans **every** `.github/workflows/*.yml`
file on disk rather than the list of workflows this policy parses, because
`release.yml`, `auto-release.yml` and anything added tomorrow can declare a job
name just as well as a governed workflow can. Both directions are asserted: the
positive half fails loudly if the job is renamed or `compat.yml` is gone, so
"nothing else declares it" can never pass in a tree where nothing declares it at
all. Renaming this job silently un-requires the gate, which is why the name is
pinned by a test.

The two are complementary and neither is optional: **`app_id` blocks a
differently-owned check of the same name; executable job-name uniqueness blocks
a same-repository, same-app GitHub Actions collision.** Neither is evidence
about the other, and the assertion is about the **name** — it is not evidence
that the context is required, which remains a settings property recorded in the
paragraph above.

So `compat.yml` **may** now be described as merge-required, because it is. Any
statement in this repository or its history that calls it an outstanding
operational requirement is **stale and superseded**.

**One piece of evidence is still missing, and is deliberately not claimed:** the
enforcement is verified by **settings read-back only**. No real pull request has
yet been observed showing the check as required in its merge box, and **no merge
has been observed blocked while the check is red**. That observation is tracked
as an open item (`docs/ARCHITECTURE-RESILIENCE.md` §9, P1) and should be closed
on the next real pull request rather than assumed from the settings.

**What belongs in the fast lane:** a check that is seconds long, needs no
platform runner, and asserts that two independent implementations of one wire
still agree. **What does not:** anything that builds or signs a platform
artifact, anything needing a macOS or Windows runner, and anything slow enough
that always-on would be expensive.

### The one cross-client exception

`native-web-pairing.yml` is not a platform owner. It is the only hosted job where
the macOS native client and a real browser have to agree with each other — a real
server, a real pairing code, the macOS link workspace in one process and a real
headless Chrome on the real built bundle in another, in both role assignments.

It therefore watches several trees it does not own, and every one of them is a
real input — something the run reads, compiles or serves:
`apps/RelayiumKit/**` **minus `!apps/RelayiumKit/Tests/**`** (the Swift half it
compiles: `swift build --product LocalTransferPeer` builds *products* and never
the package's test target), `web/**` (the bundle it `vite build`s and serves),
`server/**` (the real hub it starts), and the two scripts it actually sources —
`scripts/native-web-pairing-acceptance.sh` and `scripts/lib/local-acceptance.sh`,
named one file at a time. The exclusion, its ordering and the fact that the
fixtures are *not* re-included below it are covered
[above](#why-the-pairing-acceptance-excludes-the-fixtures-too).

It does **not** watch `apps/ios/**`. Nothing under that root is an input to the
run, so an iOS-only change would start a 45-minute macOS runner that builds
nothing it touched.

It does **not** watch `apps/mac/**` either, and that one is worth stating
plainly because it reads as a surprise: this is the *macOS* native-to-browser
acceptance, and the macOS app's own root does not start it. The reason is the
input test in rule 3. The script builds exactly two trees — `server` and
`apps/RelayiumKit` — and serves the Web bundle; no file under `apps/mac/` is
read, compiled or served by the run. The macOS app target is SwiftUI views over
`RelayiumAppKit`, which lives *inside* `apps/RelayiumKit/`, so the logic this
acceptance exercises does start it. A change to `apps/mac/` alone therefore
starts `macos.yml` — plus the two unfiltered always-on workflows, `compat.yml`
and `repo-hygiene.yml` — and no pairing runner.

Bare `apps/**` and bare `scripts/**` are both gone for the same reason, and
neither may come back: they would silently adopt a future Android or Windows
root, or a future Android or Windows script, into a macOS runner the day
somebody created it.

## Adding a platform: Android, Windows, anything next

A platform root and the workflow that owns it are created **in the same commit**.

* A root with no workflow is source nothing compiles, tests or signs. The board
  is green only because nobody asked.
* A workflow with no root is a placeholder that reports a green check for a
  platform that does not exist — worse than an absent check, because it reads as
  coverage.
* A workflow that only `echo`es is the same failure wearing a build's clothes.
  It must contain a real build or test command for its own root.

So the commit that first adds `apps/android/` must also add
`.github/workflows/android.yml` with a filter naming `apps/android/**` and a job
that really builds it — and must add the root and its owner to `PLATFORM_OWNERS`
in `scripts/test/ci-event-policy-test.mjs`, which is what binds it to the
trigger, concurrency and duplicate-run policy. `apps/android` and `apps/windows`
are already named there as *future* roots, so the absence-or-completeness rule is
live today: create either one alone and CI says so.

A new platform does **not** get `apps/RelayiumKit/**` in its filter (that package
is Apple-shared), and does **not** get its own copy of the wire-vector gate
(`compat.yml` already covers it, unfiltered, which is the point).

### Independent version, signing, release and store pipelines

Platform ownership is not only about which runner starts. Each platform keeps its
**own** version numbering, signing identity and material, release artifacts,
update feed and store submission path, and they are not shared or derived from
one another:

* macOS: Developer ID signing, Apple notarization and stapling, Gatekeeper
  assessment, the DMG, the Sparkle appcast, and an immutable GitHub Release.
* iOS: its own build numbering and App Store Connect / TestFlight path.
* The Go server and CLI: `.goreleaser.yaml`, its own tags, its own signed
  checksums.
* A future platform: its own equivalents, decided when it is added.

A shared version number or a shared release job would re-couple platforms that
the file split exists to keep separate — a macOS notarization failure must not be
able to block an iOS submission, and one platform's release cadence must not
force another's.

### Windows today is not a Windows app

Windows already has real, shipped support, and it is **not** a native app:

* the Go CLI and server cross-compile for `windows/amd64` and `windows/arm64`
  via `.goreleaser.yaml`, published as signed-checksum release archives;
* `web/src/lib/temp-downloader.ts` generates the PowerShell **temporary
  downloader** for the download page — verify the ECDSA release signature, check
  the archive's SHA-256 against that signed list, run the official CLI from a
  temp directory, delete it on every path;
* `web.yml` has a `windows-temporary-downloader` job on `windows-latest` that
  actually executes that script.

None of that is a platform root. `apps/windows/` does not exist, no native
Windows app is built or signed, and the rules above are what will apply on the
day one is. Do not read the existing Windows support as an owned platform root,
and do not read the absence of `windows.yml` as missing coverage for what ships
today.

## Concurrency, and never building the same commit twice

Every governed workflow uses the same rule, and
`scripts/test/ci-event-policy-test.mjs` asserts it verbatim:

```yaml
on:
  push:
    branches: [main]          # main only
  pull_request:

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

* **`push` is restricted to `main`.** Without it, a branch with an open pull
  request runs every workflow twice per commit against an identical tree — both
  green, and the duplicate is only visible if you count the runs. On a heavy
  platform build that is a doubled macOS bill for no new evidence.
* **The group key is the PR number**, so pushing three times to a branch leaves
  one live run instead of three. Every non-PR event falls back to
  `github.run_id`, which is unique per run, so nothing outside a pull request can
  cancel anything.
* **`github.ref` is the wrong fallback.** It puts every `main` run in one group,
  and GitHub cancels an older *pending* run in a group even with
  `cancel-in-progress: false`. Two quick merges would drop the first commit's
  verification, and `main` would show a *cancelled* check — which reads as
  "someone stopped it" rather than "this is untested".
* **`github.workflow` is part of the key**, so `macos.yml` and `ios.yml` never
  share a group, and a future platform's runs cannot cancel another platform's.

A new platform workflow copies this block unchanged.

## CI architecture is executable policy, not prose

Every rule in this document leaves the YAML **valid** when broken. `actionlint`
is happy with all of it:

* a filter widened back to `apps/**`;
* `apps/RelayiumKit/**` dropped from one of the two Apple filters;
* `continue-on-error: true` on the compatibility gate;
* a placeholder platform workflow whose only step is `echo`;
* the wire-vector command deleted, or duplicated into a second workflow;
* the concurrency group moved back to `github.ref`;
* `!apps/RelayiumKit/Tests/**` deleted, narrowed, widened until the package's own
  source stops triggering, or **moved one line up**, where it is overridden by
  the pattern it qualifies and does nothing;
* a positive glob added *below* that exclusion, re-including the fixtures into a
  45-minute macOS runner that never opens one;
* a filter left with nothing but `!` entries, so its workflow never runs at all —
  which reports as no check rather than as a red one;
* the unfiltered `swift test` deleted, filtered, or duplicated back into
  `macos.yml`;
* one of the four named fixture entries dropped from `go.yml` or `web.yml`, or
  the four replaced by the directory they live in;
* a new `macos-15` job landing in a governed workflow that `RUNNER_BUDGETS`
  covers nowhere.

The next signal after any of those is a cross-client regression reaching a user,
or a bill. So the boundary is asserted in code, on every pull request and every
`main` push, by two policies — `scripts/test/ci-event-policy-test.mjs` for the
repository-wide rules (triggers, concurrency, platform roots, runner budgets) and
`scripts/test/swift-ci-boundary-test.mjs` for who owns `apps/RelayiumKit/` — both
run from `repo-hygiene.yml`, which has no path filter of its own:

* platform roots discovered by **reading `apps/` from disk**, so a new root
  cannot be added without the policy noticing;
* path filters **compiled to regular expressions and evaluated against real file
  paths**, so "too broad" and "too narrow" fail the same way — a list comparison
  only ever catches the edit somebody already thought about;
* a **mutation suite** that breaks each property in a copy of the parsed
  workflows and requires the matching complaint by its own wording, because a
  policy check that cannot fail is the most expensive kind of green — including
  cases that assert an **absence**, so a marker appearing only in a `run:`
  block's shell comment cannot make a workflow look like a platform's owner;
* a **self-host check** in each policy: it asserts that `repo-hygiene.yml` still
  has an unfiltered, non-skippable, non-advisory job with a declared finite bound
  actually running its own command, and mutations prove that deleting, softening
  or skipping it is reported. Everything above is worth exactly what its
  execution is worth, and deleting one step is the cheapest way to silence all of
  it while the board stays green.

  Not every job in `repo-hygiene.yml` declares `timeout-minutes` yet; the ones
  hosting these two policies do, and only those are asserted.

Change the boundary and you change that file in the same commit. If this document
and the test disagree, the test is the boundary and this document is stale — fix
the document.

### What has been observed, and what has not

The `swift-package.yml` split, the three ordered exclusions and the four fixture
entries are asserted **locally**: `actionlint` accepts every workflow, the guard
tests pass, every new rule is broken in memory by its own mutation on every run,
eleven of them were additionally broken on disk in the real workflow files and
each produced its own diagnostic, and `swift test` was run once from
`apps/RelayiumKit` — 4320 tests, one skipped, no failures.

**No hosted run of `swift-package.yml` has been observed**, and no GitHub Actions
run of any kind has yet exercised the new filters. The claims above about which
workflows start for which change are derived from GitHub's documented
last-match-wins `paths:` semantics, compiled and evaluated by the guard tests —
not from a run log. Nothing here should be read as evidence that the hosted
behaviour has been confirmed; that is confirmed by the first pull request that
touches only `apps/RelayiumKit/Tests/`, and the checks it starts.

## See also

* `.github/workflows/compat.yml` — the always-on gate
* `.github/workflows/swift-package.yml` — the shared package's own suite, and the
  sole owner of an unfiltered `swift test`
* `scripts/test/swift-ci-boundary-test.mjs` — who owns `apps/RelayiumKit/`, in code
* `.github/workflows/contracts.yml` — the Device Inbox admission contract's lane
* `.github/workflows/ops-deploy-contract.yml` — the product↔ops deploy
  contract's lane
* `scripts/test/contract-ci-policy-test.mjs` — who owns each document in
  `contracts/`, what an edit to it may start, and what that lane may cost, in
  code
* `scripts/test/ops-deploy-contract-test.mjs` — the deploy contract's closed
  schema and its on-disk build boundary, run unfiltered on every commit
* `docs/DEVICE-INBOX-ADMISSION-CONTRACT.md` — the first root contract itself
* `docs/OPS-DEPLOY-CONTRACT.md` — the second, and the product half of the
  deployment interface
* `.github/workflows/macos.yml`, `.github/workflows/ios.yml` — the heavy owners
* `.github/workflows/native-web-pairing.yml` — the cross-client acceptance
* `.github/workflows/repo-hygiene.yml` — the unfiltered host that runs the
  policy guards listed here on every pull request and every `main` push
* `scripts/test/ci-event-policy-test.mjs` — trigger, concurrency, race-lane and
  platform-boundary policy, and the self-host check on its own execution
* `scripts/test/native-web-pairing-gate-test.mjs` — that the acceptance and the
  wire-vector gate are wired at all
* `docs/MACOS-RELEASE-POLICY.md` — the macOS release pipeline in detail
