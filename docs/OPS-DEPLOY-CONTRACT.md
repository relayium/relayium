# The product↔ops deployment interface contract

`contracts/ops-deploy-v1.json` freezes the facts about **this** repository that
`relayium-ops`' auto-deploy path already assumes.

Those assumptions were real before the document existed. They were string
literals in a shell script in a different repository: `web/`, `server/`,
`go.mod`, `go.sum`, `npm run build -- --outDir … --emptyOutDir`,
`go build -o … .`, `web/dist`, `web/releases`, `server/relayium-server`,
`127.0.0.1:8080`, `/readyz`, `ready`. Every one of them fails **silently** when
the product side moves:

* a product tree that grows outside `web/` and `server/` is deployed as source
  with no rebuilt artifact behind it — the deploy records the commit as shipped
  and rebuilds nothing;
* a renamed build script or output flag fails at build time, after the deploy
  has already decided the release is going out;
* a changed readiness body or status turns a healthy release into a rollback.

This is **phase A**: the product half publishes and proves the contract. The
`relayium-ops` consumer that reads it and enforces it against the deploy script
is a separate, serialized batch, and until it lands the cross-repository item is
not complete. Nothing in the deploy path reads this document yet, and nothing on
this side changed behaviour to create it.

## What is frozen, and only what is frozen

| Fact | Key |
| ---- | --- |
| Selective Web build inputs (`web/`) | `buildUnits[web].inputs` |
| npm dependency reinstall inputs (`web/package.json`, `web/package-lock.json`) | `buildUnits[webDependencies].inputs` |
| Selective server build inputs (`server/`, root `go.mod`, root `go.sum`) | `buildUnits[server].inputs` |
| Each build's working directory, manifest, program and argv | `buildUnits[*].workingDirectory`, `.manifest`, `.command` |
| Which artifact each build writes, and where | `buildUnits[*].produces`, `.command.outputFlag`, `artifacts` |
| The rebuild-anyway-when-the-output-is-gone rule | `buildUnits[*].rebuildWhenMissing` |
| What each repository-root entry does to a deploy | `repositoryRootEntries` |
| Default listener address, port, flag and environment variable | `listener` |
| Liveness/readiness routes, methods, statuses and exact bodies | `healthEndpoints` |
| Every readiness failure mode and the database ping's bound | `healthEndpoints[readiness].failureModes`, `.databaseTimeoutMilliseconds` |

### Deliberately absent

Everything the deploy path decides for itself: release directory naming, how
many releases are kept, the symlink swap and rollback sequence, the systemd
unit, the ops-side health-wait budget, promotion pins, and the post-restart API
probe. Those are operational policy, they change without the product changing,
and freezing them here would make an ops decision need a product release.

### It is a document, not a command source

`program` and `argv` are **data**. Nothing in this repository — and nothing the
ops consumer will add — executes a command string out of this file. A consumer
compares its own hardcoded invocation against these values and fails when they
disagree; it never spawns them.

## Consumers

`consumers` is a **status** list, not a membership list: each entry carries the
repository it lives in, whether its enforcement is `active` or `pending`, and the
reader that performs it. The `relayium-ops` half that reads this document and
enforces it against the deploy script does not exist yet, so it is recorded as
**pending** rather than published as current.

| Consumer | Status | Repository | Reader, and where it runs |
| -------- | ------ | ---------- | ------------------------- |
| `go` | active | `relayium` | `server/ops_deploy_contract_test.go` — the runtime half. `go.yml`'s `go test ./...` for source changes; `ops-deploy-contract.yml` for a contract-only edit |
| `ops` | pending | `relayium-ops` | none yet. Phase B adds the reader that compares the deploy script's own literals to this document, and flips this row to `active` |
| `product-policy` | active | `relayium` | `scripts/test/ops-deploy-contract-test.mjs` — the declarative half. `repo-hygiene.yml`, which carries **no** path filter |

The `Consumer` and `Status` columns of that table are checked, and exactly those
two. `ops-deploy-contract-test.mjs` matches every row of the literal form
`` | `id` | status | `` against `contracts/ops-deploy-v1.json`: a row whose status
disagrees with the document fails, and so does a row for an id the document does
not declare. The `Repository` and `Reader` columns are documentation — read as
free-form Markdown by a person, not by the test.

The rules that hold the roll to reality are in the JSON, not in this page: an
`active` consumer must name a reader and a `pending` one must not; a reader in
this repository must be tracked, must exist on disk, and must still name
`contracts/ops-deploy-v1.json` verbatim; and every reader that actually runs here
must appear on the roll as `active`. The policy carries its own list of those
local readers, so one cannot keep running while being dropped from the document.

Nothing checks the sentences around the table, here or anywhere else. Prose is
not an interface: a rule that held English phrases in a hand-picked set of files
to this document would fail on an ordinary sentence inside those files while a
stale restatement in any file outside them stayed invisible — an arbitrary regex
boundary, not a contract. The structured list is the one authority, and this page
deliberately keeps no count of it, so there is nothing here to go stale.

Those rules exist because the first version of this list did not have them. It
said `["go", "ops"]` — publishing the reader that did not exist yet, and omitting
the one running on every commit.

The active split is a cost decision. The `.mjs` half needs no toolchain — no Go,
no `npm install`, no browser — so it can run on **every** commit. That matters
more than it sounds: a `web/` or `server/` change that invalidates a declared
path, working directory, npm script or artifact is caught on the commit that
makes it, not on whatever unrelated commit next happens to touch the contract.
The Go half needs a Go toolchain, so it is filtered.

The Go half drives the **production** handlers — `registerHealthRoutes`, on a
real `http.ServeMux`, with the real route patterns. It deliberately declares no
handler of its own: a copy compared to a copy keeps passing after the server it
describes has changed, which is the failure this contract exists to remove. For
the method surface it goes further and drives them through a real
`httptest.Server` and `http.Client`, for the reason in the next section.

## How drift is detected rather than restated

A rule of the form "the working directory is `web`" restates the document in a
second place and then proves the two copies agree. Every rule is instead anchored
in something that is **not** the contract:

| Anchor | What it catches |
| ------ | --------------- |
| `git ls-files` | a declared input that no longer exists; a build output that became a committed file; a product tree added outside the declared rebuild roots |
| The repository root's real entries | a new top-level tree nobody classified — it would take the deploy's silent no-rebuild branch by default |
| `web/package.json`'s own `scripts` map | `npm run <script>` naming a script npm would exit non-zero on |
| A re-implementation of the deploy script's prefix matching | a prefix narrowed, negated or reaching outside its own tree |
| The real Go handlers and `http.ServeMux` | a changed status, body, route shape, failure branch or timeout |

Where a fact has no independent anchor — that Vite accepts `--outDir`, say — the
contract is the source of truth by construction, and what is checked is its
*structure*: that `outputFlag` appears exactly once in `argv` and is immediately
followed by the placeholder naming the artifact the build writes. Renaming the
flag in one place and not the other fails; renaming it in both is a declarative
change the ops consumer must then mirror, which is what phase B is for.

### Root-entry classification is a gate on purpose

`repositoryRootEntries` must list **exactly** what the repository root holds, and
each declared `effect` must equal the one the build inputs derive. Adding a
top-level tree therefore fails this policy until somebody says whether a deploy
should rebuild for it. Root entries change roughly never; the silent branch they
would otherwise take is a commit marked deployed with nothing rebuilt.

## Health endpoints in detail

| | `/healthz` | `/readyz` |
| --- | --- | --- |
| Success | `200`, body `ok`, **no** trailing newline | `200`, body `ready`, **no** trailing newline |
| Methods | any | any |
| HEAD | `200`, and **no entity body** | `200`, and **no entity body** |
| Route match | exact — `/healthz/` is not this route | exact |
| Dependencies | none; answers while the database is down | database, then blob store |
| Failure | — | `503` for all four modes, body `database unavailable\n` or `blob storage unavailable\n` |
| Bound | — | the database ping is given `2000 ms` |

The trailing-newline distinction is why `bodyTerminator` exists as a field. The
success bodies are written with `w.Write` and carry none; the failures go through
`http.Error`, which appends one. The deploy poll (`curl -sf … | grep -qx ready`)
tolerates either, but the contract freezes what is **sent**, not what one
consumer happens to accept.

### `successBody` is the non-HEAD wire body

`successStatus` applies to every method in `probe.methods`; `successBody` does
not. Go's `net/http` suppresses the entity body of a HEAD response **at the
server**, after the handler has already written it. So `HEAD /readyz` is
accepted, answers `200`, carries `Content-Length: 5` — and delivers **no bytes**.
A client reading the body gets nothing.

`probe.bodylessMethods` states that, and it is derived rather than chosen: the
declarative half requires it to be exactly `probe.methods ∩ {HEAD}`, because HEAD
is the only method the transport treats this way. `successBody` is therefore the
wire entity body for every **other** probed method.

This is also why the Go half drives the method surface through a real
`httptest.Server` and `http.Client` rather than an `httptest.ResponseRecorder`.
A recorder records what the *handler* wrote, so it reports `ready` for a HEAD
request every deployed client answers empty — a green test that is evidence
about the handler and not about the endpoint. The recorder stays where it is the
right seam: the readiness failure branches and the database bound, which need a
dependency state injected and assert the handler's own decision. Two tests hold
that line — one asserts the empty wire body, and one asserts that the two seams
**disagree** for HEAD, so a wire helper quietly reimplemented on a recorder fails
by name.

## CI ownership

`contracts/` now holds two contracts with different consumer sets, so ownership
is per **contract file** rather than per tree:

| Contract | Lane | Cost |
| -------- | ---- | ---- |
| `contracts/device-inbox-admission-v1.json` | `contracts.yml` | three jobs — Go, Web and a **paid** macOS Swift runner |
| `contracts/ops-deploy-v1.json` | `ops-deploy-contract.yml` | one Ubuntu job |

This contract has no Swift or TypeScript consumer. Had it joined the existing
lane, every edit to it would have started a paid macOS runner and a Vitest
install to re-run two checks that cannot see it. `contracts.yml`'s filter was
therefore narrowed from `contracts/**` to the exact Device Inbox inputs, and
`scripts/test/contract-ci-policy-test.mjs` now requires **every** file under
`contracts/` to be claimed by exactly one lane — so a third contract fails until
it has an owner, which is the protection the tree-wide filter used to provide.

See [the CI platform boundary](CI-PLATFORM-BOUNDARY.md) for the surrounding
rules.
