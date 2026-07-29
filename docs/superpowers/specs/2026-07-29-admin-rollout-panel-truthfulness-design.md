# Admin rollout panel: say what the state machine is actually doing

Date: 2026-07-29
Status: implemented (`server/account/rollout_status.go`), corrected 2026-07-29 after review

**This document has now been wrong about `decideFleet` five times.** Every defect
found while implementing it was the same shape: a predicate written here (and
then in the code, and then in the tests) that had been hand-mirrored from the
state machine and had drifted from it. The corrections are folded into the text
below rather than appended, and the last section — *Pinning the panel to the
state machine* — is the structural answer, because a sixth restatement of "be
careful" would not be one.

## Background

The admin panel's node-release section shows a fleet rollout as
`发布中 · 1/5 台已在目标版本 · 正在更新：<node id> · 本阶段开始：<time>`, and
nothing else. From that display an operator cannot answer the only question that
matters: **is this progressing, or is it stuck?**

The two look identical. A canary that installed successfully and is being
observed for six hours renders exactly like a node that was commanded an hour
ago and never converged. The correct response to the first is to wait; to the
second, to go and look at the machine.

The panel also renders `暂停` and `继续` unconditionally, so pressing `继续` on a
rolling track returns `继续失败：该轨道当前不是已中止状态`. That refusal is
correct — resume only applies to a halted track — but the button should not have
been offered. The panel's own view model already states the principle
(`admin_rollout.go:48-49`): *"a button whose only possible outcome is a refusal
is worse than no button"*, and applies it to `回滚到上一版本`. It was never
applied to the pause/resume pair.

Finally, `正在更新` is applied to the track's `CurrentNodeID` for the whole
observation window, so a node that finished successfully keeps reading as
"updating" for six hours. That single word is the most direct cause of the
"is it stuck?" question.

## Scope

- **Fleet track:** per-node diagnosis of whatever is in flight — three timed
  bands, two terminal ones taken from what the node reported, and no band at all
  when the track is not running.
- **Both tracks:** the computed time of the next step, and the timing rules
  stated on the page.
- **Both tracks:** render only the controls that are valid in the current status.
- **Fleet track:** replace `正在更新` with wording that distinguishes the bands.

Out of scope, each its own round: automatic discovery of new upstream versions
with a one-click rollout, and a fleet equivalent of BYO's
`回滚到上一版本` control (the fleet track — the one carrying production relays —
currently requires typing a version from memory to roll back, while BYO gets a
button; `POST /admin/rollout/byo/rollback-previous` has no fleet counterpart).

## The state model this describes

### The precondition: the track must be running

**Nothing below applies unless `tr.Status == "rolling"`.** `decideFleet`'s step 1
(`rollout_fleet.go:166`) returns `wait` for a track in any other status, at every
clock, forever: a halted or completed track is **inert** and no node on it is
being timed.

This is not a formality, because `HaltRolloutTrack` (`rollout_store.go:122-127`)
does **not** clear `current_node_id` and **does** restamp `stage_started_at`.
A panel that derives a band from `CurrentNodeID` alone therefore reports, on a
paused canary, `观察中 · 不早于 <six hours after the pause>` — a window the pause
itself created — and on a paused node still behind the target, eventually,
`超过 1 小时 的上限，将在下一次轮询时中止`, which no poll can ever do to a track
that has already stopped. **An empty band is the truthful output there:** the
track-level line already says `已中止` and prints the halt reason, and the node
row still ranks to the top of the table (that ranking is driven by
`CurrentNodeID`, which is correct — on a halted track that node is exactly the
one the operator opened the panel to find). What must not survive the halt is the
clock, not the row.

`!tr.Emergency` is checked alongside it, for symmetry with the BYO path and for
whoever adds the next emergency path — not for a live bug: an emergency
short-circuits both state machines in `nodes.go` before the per-track dispatch,
so `decideFleet` is not reached at all while one is armed.

### The bands

Given a rolling track, the node holding the slot is in exactly one of the states
below. They are mutually exclusive, they have different deadlines, and they call
for opposite responses. **The order is `decideFleet`'s own order, and that is the
point** — see *mirror the order of the thing you describe*, below.

| Band | Test | Deadline that applies | Source |
|---|---|---|---|
| **(precondition)** | `tr.Status != "rolling"` (or `tr.Emergency`) → **no band at all** | none: the track is inert | `rollout_fleet.go:166` |
| **Reported a failure** | `UpdateResult` is `failed` or `rolled_back` | none — the track **halts** on the next poll | `rollout_fleet.go:228` |
| **Skipped** | `UpdateResult == "skipped"` | none — not a failure; the node's stage is over and the queue **advances without it** | `rollout_fleet.go:248` |
| **Gone quiet** | `UpdateStartedAt != 0` and no heartbeat for longer than `nodeOnlineWindow` (90 s) | `updateSilenceLimit` (15 min) since `LastSeenAt` | `rollout_fleet.go:252` |
| **Installing** | not on target, `UpdateStartedAt != 0` | `fleetInstallLimit` (1 h) since `UpdateStartedAt` | `rollout_fleet.go:275` |
| **Command never landed** | not on target, `UpdateStartedAt == 0` | `updateSilenceLimit` (15 min) since `tr.StageStartedAt` | `rollout_fleet.go:263` |
| **Observing** | **on target** | `fleetFirstWindow` (6 h) for the canary, `fleetStepWindow` (30 min) otherwise, since `max(tr.StageStartedAt, UpdateStartedAt)` | `rollout_fleet.go:282-293` |

**The two `UpdateResult` bands sit above every clock, because that is where
`decideFleet` has them.** A node reporting `failed` or `rolled_back` halts the
whole track (`:228`); a node reporting `skipped` declined the update, will never
reach the target, and its stage is over so the queue advances without it
(`:248`). Both are decisions, not clocks. Without them the panel says
`安装中 · 已 5 分钟 · 上限 1 小时` about a node that already reported `failed` —
answering "you have 55 minutes of headroom" about the machine that is stopping
the release.

Neither band needs a staleness test, because `decideFleet` has none: the result
is read off the node holding the slot, and `CommandNodeUpdate` clears
`nodes.update_result` when it commands that node (`rollout_store.go:315-326`), so
a result present on it belongs to *this* rollout. (The BYO track needs
`byoResultIsFailure` for exactly the reason the fleet track does not: it has no
`CurrentNodeID` to key on.) **Adding a check `decideFleet` does not have is the
same defect as omitting one it does.**

**The silence check is tested before the on-target branch — because that is where
`decideFleet` tests it.** `rollout_fleet.go:252` runs its silence halt above the
`if !onTarget(cur)` branch at `:255`, so a node that installed successfully and
then went dark during its six-hour observation window halts the whole track. An
earlier draft of this design put silence inside the installing band only, which
would have had the panel report `观察中，还有 5 小时` about a track `decideFleet`
had already halted — the panel lying in the band it presents as the safe one,
which is the exact failure this work exists to remove.

**Two thresholds are in play for silence and they are deliberately different.**
The panel *enters* the gone-quiet presentation at `nodeOnlineWindow` (90 s, the
same window the rest of the panel calls a node `离线`); the halt it cites at
`:252` fires at `updateSilenceLimit` (15 min). That is not a mismatch to be
"fixed" in either direction. The **deadline printed is always the halt's own**,
so nothing claims a limit that does not exist; the earlier entry only decides
when the panel starts showing the silence clock instead of the band's, and an
operator wants to know a machine has gone dark before the halt is fourteen
minutes away.

**Silence does not pause the clock the node was already running.** The two run in
parallel — `decideFleet` reads the same stamps whether or not the node
heartbeats — so a node past `fleetInstallLimit` that has been quiet for 91
seconds is one `decideFleet` **halts**, even though its silence clock has 14
minutes left. The gone-quiet presentation therefore overlays the band rather than
replacing it: it keeps the band's label (`安装中（已停止心跳）`), and it shows the
band's own deadline whenever that one has already expired.

The general rule that follows: **mirror the order of the thing you describe.**
Where the classifier's branch order matches `decideFleet`'s, the two cannot drift
apart by restructuring; where it does not, they can, silently.

Two details in that table are easy to get wrong and both are already documented
in the state machine:

**The observation window starts only once the node is on target.** Before that,
the node is installing and the two halt backstops apply instead. The six hours
are spent watching a node that already runs the new version — which is the whole
point of the window, and exactly what the current `正在更新` label denies.

**The window is measured from `max(StageStartedAt, UpdateStartedAt)`**, not from
`StageStartedAt` alone. `rollout_fleet.go:285-288` explains why: the two stamps
are written by different code paths, and a stale or zero `StageStartedAt` would
otherwise collapse a six-hour observation into seconds. The panel must use the
same rule, because a panel that miscomputes the window in that direction is
wrong in precisely the situation the operator most needs it.

The BYO track has no per-node in-flight concept — it commands a whole batch —
so it gets no bands. Its window is simpler: `byoBatchWindow` (6 h) from
`tr.StageStartedAt` (`rollout_byo.go:40`, `:230`). Three preconditions apply to
it, each for the same reason the fleet track's does — the panel must not time
something the state machine is not running:

- `tr.Status == "rolling"` and `!tr.Emergency`. An emergency short-circuits both
  state machines before the per-track dispatch, so there is no batch ladder
  running at all, and the panel two lines above already says `已跳过分批`.
- `tr.ByoBatch != 0`. `decideByo` gates the window on it (`rollout_byo.go:229-231`)
  because a **fresh** track opens its first batch immediately; reporting a
  six-hour wait there invents a delay the state machine does not have.
- At the widest batch (`byoBatches[len-1]`) the time is still right but the noun
  is not: there is no wider batch to open. `decideByo`'s ladder is exhausted
  (`:251-256`) and what the window's close brings is either completion or a
  re-sweep of whoever is still behind, so the label is not `下一批`.

## Two constraints that keep the panel honest

**The panel owns no thresholds.** `fleetFirstWindow`, `fleetStepWindow`,
`updateSilenceLimit`, `fleetInstallLimit` and `byoBatchWindow` are read from
`rollout_fleet.go` / `rollout_byo.go`. A panel carrying its own copies starts
lying the day someone tunes a constant, and a panel that lies is worse than one
that says nothing, because decisions get made from it.

**The panel describes; it never decides.** `decideFleet` and `decideByo` remain
the only authority. The panel states which window is running and when it closes;
it does not predict the outcome and must never re-implement the decision. If the
two could disagree, the operator would eventually believe the wrong one.

## What the panel says

### The next step is stated as "not before"

Both state machines are evaluated **only when some node polls**, and nodes poll
roughly every ten minutes (`install-node.sh:277`, `OnUnitActiveSec=10min`). Once
a window closes, the next command therefore lands somewhere in the following
0–10 minutes.

So the panel says **`不早于 11:54 UTC（还有 4 小时 21 分）`** — never a bare
timestamp, which would read as a promise and slip by ten minutes on every single
rollout. A panel whose predictions visibly miss teaches the operator to ignore
it.

The absolute time matches the UTC stamps the panel already prints; the relative
duration is the number an operator actually acts on. When the window has already
closed, there is no negative countdown — it reads `已到时间，等待下一次轮询`.

The same treatment applies to the halt deadlines in the two non-observing bands:
they are stated as facts and limits (`已 40 分钟 · 上限 60 分钟`), not as
predictions of when the track will halt.

**Only one limit is shown at a time, and it is always the one that will actually
decide this node's fate.** A node in flight is subject to two clocks at once —
its band's deadline, and the 15-minute silence backstop — and printing both is
noise, because a heartbeating node resets its silence clock every 30 seconds.

The rule: while the node's last heartbeat is within `nodeOnlineWindow` (90 s),
show the band's own deadline alone. Once the heartbeat is older than that, the
node has gone quiet and the silence limit **overlays** the band — it does not
replace it. The label keeps the band it came from (`观察中（已停止心跳）`,
`安装中（已停止心跳）`) so the operator can still see what it was doing when it
went dark, and the band's own clock is kept alongside the silence one whenever it
has already expired.

**Overlay, not replacement, and this correction cost a defect to learn.** An
earlier version of this section said the silence limit "is the one about to fire,
and the panel shows that one" — so the code returned early and discarded the
band's clock. A node already past `fleetInstallLimit` that then went quiet for
91 seconds therefore read as a calm two-minute silence, while `decideFleet` was
halting it on the install limit. The two clocks are not alternatives: whichever
has expired is the one that decides, and both can have. This was found by the
sweep described below, not by reading — see *Pinning the panel to the state
machine*.

### The rules are on the page, not in a help modal

One line of small text under the status, per track:

- Fleet: canary 观察 6 小时，之后每台 30 分钟；节点每 ~10 分钟来问一次，所以下发会落在窗口关闭之后的十分钟内。
- BYO: 每批观察 6 小时，之后自动放宽到下一档；节点每 ~10 分钟来问一次。

Both are emitted by `fleetRulesText` / `byoRulesText`, which build them from the
constants — so the durations above are illustrative of the current values, not a
second copy of them.

These are the numbers an operator otherwise has to know or ask. Printing them
costs one line and removes the question permanently.

### Bands are not styled as alarms

A slow link taking forty minutes to fetch a binary is normal. Rendering it in a
warning colour trains the operator to ignore the colour, so the non-observing
bands state the elapsed time and the limit plainly and escalate visually only
once a limit is actually crossed.

**The observing band never escalates at all.** A crossed limit means opposite
things in different bands: in the observing band it is the window's *successful*
end — the canary did its six hours and is waiting up to ten minutes for a poll —
while in the installing band it is a node about to be aborted. Rendering both in
the same red is the same mistake as colouring the slow link, one level up.

So the escalation is driven by an explicit `rolloutNodeStatus.Alarm`, **not** by
`Overdue`: `Overdue` says a limit has passed, `Alarm` says a human is needed.
They coincide in the installing, command-never-landed and gone-quiet bands; they
differ in the observing band, where `Alarm` is never set; and the two
`UpdateResult` bands set `Alarm` with no `Overdue` at all, because there is no
clock left for them to run out of. The `skipped` band sets it too — nothing
failed, but the node is permanently left behind the fleet and only a human closes
that out, so its label says `已跳过（不是失败）` in as many words.

**The in-flight tag renders only when there is a label**, with no fallback word.
There used to be one — `更新中` — for a row holding the slot with nothing being
timed, which is precisely the state a halted track leaves behind. Printing the
one word this whole document exists to remove, in the single case where the panel
knows nothing is happening, is worse than printing nothing.

### Controls follow status

At any moment exactly one of `暂停` / `继续` is meaningful: `rolling` → pause
only; `halted` → resume only; `complete` → neither. The invalid one is **not
rendered**, rather than rendered disabled. That is the existing principle in this
file, already applied to `回滚到上一版本`.

### `正在更新` becomes a label per band

`安装中` / `等待节点开始` / `观察中` for the three timed bands, plus `更新失败` /
`已回滚` / `已跳过（不是失败）` for the states `decideFleet` decides on rather
than times — and **nothing at all** when the track is not rolling. `观察中` is
the case the old wording denied, and the one an operator is most likely to
misdiagnose.

## Pinning the panel to the state machine

Everything above is a description of `decideFleet` written by hand, which is
precisely how this document was wrong five times. Prose cannot fix that; a
comparison against the authority can.

`decideFleet` and `fleetNodeStatus` are both pure functions over the same facts,
so a table-driven test sweeps `(status, emergency, UpdateResult, on-target,
canary identity, stage/update/last-seen offsets)`, builds a `RolloutTrack` and a
one-node `[]NodeSnapshot`, and runs **both** over the identical tuple. It asserts
three relations rather than any hand-written expectation:

1. When `decideFleet` returns an action other than `wait`, the panel must not be
   **calm** — a non-empty band with neither `Alarm` nor `Overdue`, i.e. the
   sentence "a clock is running and it has time left". That sentence is a lie
   about a track that is halting or advancing past this node.
2. When `decideFleet` waits at `now` **and still waits arbitrarily far in the
   future on the same data**, nothing is being timed at all — the track is inert
   — and the panel must print no band. This is the property the halted track
   breaks, and it is derived rather than asserted: inertness is read off the
   state machine, not restated from `tr.Status`.
3. When `decideFleet` is still waiting, the panel must not claim a limit has
   passed. This is what a wrong window looks like: a healthy canary marked
   overdue at 31 minutes because the panel guessed the 30-minute window where the
   state machine gave it six hours.

Every offset in the sweep is derived from a named constant, so tuning one moves
the state machine, the panel and the sweep together. The test calls `decideFleet`
— **the only place in the panel's code that may**, and it is a test:
`admin_rollout.go` and `rollout_status.go` must never call it, because two
authorities means the operator eventually believes the wrong one.

This sweep catches three of the four fleet defects found on this work — the
missing rolling gate, the missing `UpdateResult` bands, and the canary fallback —
plus one nobody had noticed (silence hiding an already-expired install limit).
It does **not** catch the fourth, the observing band styling itself as an alarm;
that one is held by `TestFleetNodeStatusObservingNeverAlarms`, because it is a
presentation choice rather than a disagreement with `decideFleet`.

**Where the sweep is weaker than its size suggests**, recorded because a test
believed to cover more than it does is how this document went wrong five times:

- The tuple space is one node that is always the current node, so
  `Action == "update"` is structurally unreachable — the pick step is only
  reached when that node is `skipped`, which also removes it from the candidate
  set. `halt` and `complete` are exercised in bulk; `update` is not exercised at
  all.
- The invariant is one-sided: it forbids a calm panel where the machine acts, but
  a panel that returned an empty status for *everything* would pass it. What
  stops that is the sibling per-band tests, not this one. The two halves are
  complementary and neither is sufficient.
- `!in.Emergency` in the precondition is not constrained here at all, because
  `decideFleet` has no emergency model — the short-circuit lives above it in
  `nodes.go`. `TestFleetNodeStatusPrintsNothingOnAnInertTrack` is what holds it.

## Testing

Two pure functions — a band classifier and a next-step calculator — taking
`(track, node snapshot, now)` and returning a description. Pure like
`decideFleet`, so a six-hour window is an integer in a test rather than a wait.

- Each band at its boundary, in particular that a node **exactly on target** is
  `观察中` and not `安装中`.
- Window selection: canary gets 6 h, every later node 30 min.
- **A stale `StageStartedAt` does not collapse the window.** Construct one left
  over from a previous stage with a later `UpdateStartedAt` and assert the full
  window is still reported. This is the trap `rollout_fleet.go:285-288` records;
  the panel computing it wrongly is the same defect in a second place.
- Expected values are **computed from the constants**, never written as literals,
  so tuning `fleetFirstWindow` moves the state machine, the panel and the test
  together.
- A closed window reports `已到时间，等待下一次轮询`, never a negative countdown.
- A track that is not `rolling` (or is in an emergency) produces **no** status at
  all, with a rolling control case alongside it so the assertion cannot pass
  because the input was empty for some unrelated reason.
- `failed` / `rolled_back` produce a terminal band that offers no deadline and
  says the track stops because of this node; `skipped` produces one that says it
  is not a failure and offers no deadline either.
- The observing band never sets `Alarm`, including once its window has closed,
  while a node past `fleetInstallLimit` sets both `Alarm` and `Overdue`.

Rendering tests assert the control set for `rolling`, `halted`, `complete` and
never-configured. One of them is the regression guard for the bug that prompted
this work: **`继续` must not appear while rolling, and `暂停` must not appear
while halted.** Two more cover the same ground from the page's side: a paused
track still lists the node that was in flight but prints no band, no deadline and
no `更新中`; and a BYO track at its widest batch prints the window without
calling it `下一批`.

The three band labels are asserted to differ from each other, so that a later
refactor collapsing them into one generic string fails a test rather than
silently restoring today's behaviour.

## Code shape

A new `server/account/rollout_status.go` holds the classifier and the next-step
calculator with its own test file: pure, no clock, no database, no HTTP. The
existing `admin_rollout.go` (529 lines) gains only the field wiring into
`rolloutPanelView` and `rolloutNodeView`; `admin_templates.go` gains the status
line, the rules line and the status-conditional controls.

The classifier's input is built by one constructor, `newFleetNodeInput(track,
snapshot, onTarget)`, used by both the panel and the sweep above. A second
transcription of the mapping would be one more place for the panel and the state
machine to drift apart, which is the failure mode this whole document is about.
