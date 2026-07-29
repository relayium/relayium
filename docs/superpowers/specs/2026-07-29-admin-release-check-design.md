# Admin panel: notice a new release instead of being told about it

Date: 2026-07-29
Status: designed; not yet implemented

## Background

Rolling a new node binary to the fleet requires the operator to already know the
version number and type it into a text field. Central never looks at what has
been released, even though the primitive has been sitting in the tree the whole
time: `selfupdate.LatestTag(ctx, o)` (`server/selfupdate/selfupdate.go:208`)
reads `releases/latest` from the GitHub API, and both the CLI's `update`
subcommand and the node's self-updater already call it. Only the admin panel
does not.

So the work here is mostly wiring, plus the judgement about when a one-click
rollout button may be offered at all.

## Scope

Central polls for the newest release, the admin panel shows a dismissible notice
when one is newer than what the fleet is targeting, and a button sets the target
and starts the rollout.

**Fleet track only.** The BYO track pushes to *users'* machines rather than ours;
a "saw a notification, pressed a button" path should not exist for those. Setting
a BYO target stays a deliberate, typed action. The two panels are deliberately
separate — `admin_templates.go` carries a comment warning against collapsing them
into one form — and this keeps them that way.

## The button is not offered while a rollout is in flight

This is the constraint the rest of the design hangs off, and it comes from an
existing behaviour that is safe under a typed form and unsafe under a button.

`setTargetVersion` (`server/account/rollout_gate.go:79-135`) has **no gate on the
track's current status** for the fleet path. It performs a whole-row
`PutRolloutTrack` that sets `Status: "rolling"` and `StageStartedAt: now`, and —
because the struct literal leaves them unset — writes `CurrentNodeID` and
`FirstNodeID` back to empty.

Pressing 设定目标版本 during a live rollout therefore **silently abandons it and
starts over**: a canary five hours and fifty minutes into its six-hour
observation window is discarded, with nothing shown to say so. That is defensible
when someone typed a version and pressed a button in a form; it is not defensible
one click from a notification that says "有新版本了，要更新吗？".

So the notice has two shapes, and the line between them is **whether a rollout
is in flight** — which is *not* the same question as `Status == "rolling"`:

| Fleet track | Notice |
|---|---|
| `complete`, never configured, or `halted` with `current_node_id` empty | Full notice with the rollout button |
| `rolling`, **or any status with `current_node_id` set** | Informational only — states the new version and that a rollout has not finished, **no button** |

**This table said `halted` gets the button, flatly, and that was wrong.**
`HaltRolloutTrack` (`rollout_store.go`) writes `status='halted'` and
deliberately does **not** clear `current_node_id`; the rollout panel depends on
that, because on a halted track the node that was in flight is still the one the
operator opened the panel to find. So a rollout an operator *paused* mid-canary
is `halted` with the canary still recorded — a rollout in flight in every sense
that matters here, differing from the live case only in that a human pressed
pause first. Offering the button there and pressing it produced
`{TargetVersion:v1.3.0 Status:rolling CurrentNodeID: FirstNodeID:}`: the canary
position gone and 恢复发布 unable to restore anything. Exactly the harm this
section exists to prevent, reached through the state the section itself blessed.

`ResumeRolloutTrack` and `CompleteRolloutTrack` both *do* clear
`current_node_id`, which is why the first row is a real state and not a
technicality: a track halted with nothing in flight has nothing to lose, and
gets the button.

The typed form is untouched: an operator who genuinely wants to repoint a live
or paused rollout can still do it there, deliberately.

### The handler asks the notice, it does not restate it

The button's predicate and the POST handler's guard are **one function call**,
not two implementations of one rule: `handleAdminReleaseRollout` calls
`releaseNotice(...)` and refuses unless `OfferButton`, then separately pins
*which* version was posted against the stored `LatestTag`. `OfferButton` answers
*whether*; the version equality answers *which*.

This is not a tidy-up. Every earlier version of that guard restated one axis of
the UI's rule in its own words, and each restatement was wrong about a state the
UI already handled correctly:

- `status != "rolling"` alone let a stale page repoint the fleet *backwards*
  after a completed rollout.
- Adding `version == LatestTag` alongside it still let a stale page post
  whenever the fleet target was **ahead** of GitHub's `releases/latest` — routine
  while a tag is published as a pre-release and rolled to the fleet first, or
  after a bad release is unpublished. The panel renders nothing in that state;
  the handler happily accepted `version=<LatestTag>` and downgraded the fleet
  (`nodes.go` sets `AllowDowngrade` automatically for a downgrade, so the nodes
  really do install the older build).

A restated predicate drifts from the thing it restates; a called one cannot. Any
condition added to `releaseNotice` from here reaches the handler for free.

This is the same principle the panel already applies twice, one step further
along. The first was "a button whose only possible outcome is a refusal is worse
than no button". This one is worse than a refusal, because it **succeeds** — and
the damage is invisible.

"Newer" reuses the ordering that already exists rather than growing a second
one — but it needs a one-line change first: `compareVersions`
(`selfupdate.go:168`) is **unexported**, and this code lives in package
`account`. Export it as `CompareVersions(a, b string) (int, bool)`, keeping the
`(result, ok)` shape so an unparseable version stays distinguishable from
"equal". It is the right home: version ordering belongs next to version parsing,
and it currently has no callers outside its own package, so exporting it changes
nothing that exists.

Reimplementing the comparison in `account` is the alternative, and it is the
wrong one for the reason this project keeps relearning: two copies of a rule
drift, and the one the operator sees is not always the one that decides.

A fleet track with no target configured shows the notice with copy saying so.

## The check only ever makes a positive claim

**It says "there is a newer version". It never says "you are up to date".**

Absence of the notice therefore asserts nothing. A failed request, a rate limit,
a DNS outage, a GitHub incident — each degrades to silence rather than to a false
statement of currency. A check that can fail must not be allowed to assert the
current state; this project has now shipped three separate defects whose shape
was a display claiming to know something it did not.

Silence is made legible by one muted line carrying the last *successful* check's
timestamp, so "no new version" and "has not checked successfully in three days"
are distinguishable at a glance.

That line has a third state and it must be spelled differently from the other
two: on a fresh deployment whose first check has not completed — or has failed —
there is no timestamp at all (`checked_at == 0`), and the line reads
`尚未成功检查过`. Rendering an empty timestamp, or omitting the line, would put
that state back in the same silence as "checked fine, nothing new", which is
exactly what this section exists to prevent.

## Polling

Hourly, with one check at startup, following `StorageProber.Run`
(`server/account/storage_prober.go:67-79`) — sweep once immediately, then on a
ticker until the context is cancelled.

Hourly is far inside GitHub's unauthenticated limit of 60 requests per hour per
IP, and a release matters on the scale of days. Note one interaction: central
restarts on every push to `main` because of auto-deploy, and each restart costs
one extra check. Bounded and negligible.

Each check carries its own 30s deadline (`context.WithTimeout` in the `Latest`
closure). `selfupdate.DefaultHTTPClient` sets no blanket `Client.Timeout` on
purpose — it is tuned for multi-MB archive downloads and bounds only connect,
TLS and time-to-first-byte — so a server that sends headers and then stalls the
body would hang this call indefinitely. `Run` calls `CheckOnce` **serially**, so
that is not one lost check: the ticker never fires again and the panel silently
stops updating for the life of the process. The deadline belongs at this call
site rather than in the shared client, because it is right for a few hundred
bytes of JSON and wrong for a release archive.

**Both the result and the dismissal are persisted**, in the same row.

An earlier draft kept the last successful tag in memory on the grounds that
losing it to a restart costs only one HTTP request. That is true and it is not
the whole story: central is built to run as **several instances** — admin
sessions and the TOTP replay guard were deliberately moved into the store for
exactly that reason, and `RateLimitDivisor` exists to split per-instance
thresholds across N of them. Process-local state would mean each instance polls
on its own schedule and, worse, that the `上次成功检查` line jumps around
depending on which instance served the page, while the dismissal beside it stays
consistent. A panel that is internally inconsistent about its own freshness is
the same defect as one that overstates it.

The cost of persisting is one write per successful check — hourly — and in
exchange the timestamp becomes a fact about the deployment rather than about
whichever process answered.

Failures keep the previous successful result rather than clearing it, and are
logged on transition only — first failure, then on each `ok`↔`fail` flip — so an
outage costs one log line rather than one per hour. Same shape as the storage
prober's reachability logging.

## Storage

`settings.value` is `INTEGER NOT NULL` (`sqlite.go:103-107`) and `GetSetting`
returns an `int64`, so neither the dismissed tag nor the last seen tag can live
there. They share a single-row table:

```sql
CREATE TABLE IF NOT EXISTS release_check (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  latest_tag    TEXT NOT NULL DEFAULT '',
  checked_at    INTEGER NOT NULL DEFAULT 0,
  dismissed_tag TEXT NOT NULL DEFAULT '',
  dismissed_at  INTEGER NOT NULL DEFAULT 0
);
```

`checked_at == 0` is the "never checked successfully" state — the third wording
above — and it is why the two halves are written by separate statements: a failed
check must leave `latest_tag`/`checked_at` exactly as they were, and a dismissal
must not disturb them either.

Rejected alternative: widening the settings store to hold text. That changes the
shared `Store` interface and every implementation for one string, and
`ListSettings` drives an admin settings view — the dismissed tag would appear
there as something an operator could edit, which it is not.

## Dismissal is per-version, visible, and reversible

Dismissing records the tag. The notice stays hidden while the newest release is
still that tag, and returns by itself when a newer one appears — the operator
never has to remember to re-enable anything.

A dismissal leaves a muted line in place of the notice: `已忽略 vX · 撤销`. A
dismissal that leaves no trace creates a state the operator cannot see they are
in and cannot find their way out of, which matters more here than usual because
it survives restarts.

## Self-hosters

The check is **on by default**, controlled by `RELAYIUM_RELEASE_CHECK`
(`false`/`0` disables), matching the naming of `RELAYIUM_DIRECT_DOWNLOAD`.

This ships to anyone self-hosting Relayium, so being on by default is a change to
what their server does on the network. It is disclosed in two places:

- **A startup log line, printed unconditionally when the poller starts**, naming
  what it queries, how often, and the variable that turns it off. A self-hoster
  who never opens the docs still sees this. The house style already uses
  explanatory output this way — `requireSecureCentral`'s refusal message and
  `install-node.sh`'s echoes.

  It must name the host actually contacted, `api.github.com`, and not
  `github.com` (the download host, which this poller never reaches). It said
  `github.com` and that is a real cost, not a typo: the line's stated purpose is
  to let a self-hoster act on it, and an egress allowlist built from the wrong
  hostname fails **closed** — the check never succeeds and the panel, which only
  ever makes positive claims, just quietly says it has never checked. For the
  same reason the line says "at startup and then hourly": "hourly" undercounts
  what an operator watching their egress will see.
- **A section in `docs/self-hosting.md`** stating that it reads a public API
  only, uploads nothing about the instance, and that what GitHub can observe is
  the instance's egress IP asking on a timer.

When disabled, **no request is made at all** — not a request whose result is
discarded — and the panel renders no part of the notice, not even the
`尚未成功检查过` freshness line.

This document previously claimed that promise "has a test" when neither half
did. The panel half now does: `TestAdminNoticeAbsentWhenTheCheckIsDisabled`
builds a service with `ReleaseCheck: false` (its own, because
`newAdminSettingsServer` sets it true for every other test) and asserts the
dashboard contains neither `/admin/release/rollout` nor `尚未成功检查过`, with a
check result sitting in the store so the assertion is about the flag and not
about an empty database. The request half is structural rather than tested:
`main.go` only constructs and starts `ReleaseChecker` inside `if *releaseCheck`,
so there is no code path that could issue a discarded request.

## Code shape

- `server/selfupdate/selfupdate.go` — `compareVersions` → `CompareVersions`.
- `server/account/releasecheck.go` — the poller and the notice decision, the
  latter a pure function so it is testable without a clock, a database or HTTP.
- `server/account/releasecheck_test.go`
- `admin_rollout.go` gains the notice's view fields; `admin_templates.go` renders
  it above the fleet panel; one new POST route for dismiss/undo, and the button
  posts to the existing fleet target endpoint rather than a second one.
- A store method pair for the dismissal, plus the migration above.

## Testing

The decision function takes `(latestTag, lastCheckedAt, fleetTrack, dismissedTag)`
and returns what to render and whether the button is offered. Table-driven:

- newer + fleet idle → notice **with** button
- newer + fleet `rolling` → notice **without** button
- newer + fleet `halted` **with `current_node_id` set** (a paused rollout) →
  notice **without** button
- newer + fleet `halted` with `current_node_id` empty → notice **with** button
- newer + dismissed tag equal → nothing but the muted dismissed line
- newer + dismissed tag older → notice returns
- equal or older latest → nothing
- never checked successfully → nothing, the muted line reads `尚未成功检查过`,
  and **no copy asserting currency** appears in any state
- fleet target empty → notice with button, different copy

Plus one property over the whole state space, in the shape the rollout panel's
sweep established: **offering the button implies nothing is in flight on the
fleet track** — neither `status = 'rolling'` nor a non-empty `current_node_id`.
Per-case assertions are written from the same understanding as the code and
drift with it; a property over every state is what catches a later
"simplification" of the condition. The sweep's axes must include
`current_node_id`, because the version that swept only `status` is the one that
missed the paused rollout.

The handler is tested against the same states through the HTTP surface, since
the defect being guarded is precisely "the panel and the handler disagree":

- fleet ahead of `LatestTag` (pre-release rolled first, or a release
  unpublished) → no button rendered **and** a direct POST of `LatestTag` leaves
  the track untouched
- fleet paused mid-canary → no button rendered **and** a direct POST leaves
  `TargetVersion`/`Status`/`CurrentNodeID`/`FirstNodeID` exactly as they were
- a stale page posting an older version while the fleet is current → refused

Poller tests inject `selfupdate.Options.HTTP`:

- a failing request leaves `latest_tag` and `checked_at` exactly as they were —
  asserted by reading the row back, not by inspecting process state
- a dismissal does not disturb `latest_tag`/`checked_at`, and a successful check
  does not disturb the dismissal
- `RELAYIUM_RELEASE_CHECK` disabled renders **no** part of the notice —
  `TestAdminNoticeAbsentWhenTheCheckIsDisabled`, asserted through the rendered
  dashboard. That it issues no request is structural (`main.go` builds the
  poller only inside `if *releaseCheck`) rather than asserted against a
  transport; do not let this bullet imply a test that does not exist, which is
  what it did before.

## Out of scope

- Any automatic rollout. The button is always a human pressing it.
- The BYO track.
- Authenticating to the GitHub API. Unauthenticated is well inside the rate
  limit at this frequency, and a token would be a credential to store and rotate
  for no gain.
