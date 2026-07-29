# Admin rollout panel: say what the state machine is actually doing

Date: 2026-07-29
Status: designed; not yet implemented

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

- **Fleet track:** per-node diagnosis of whatever is in flight, in three bands.
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

A fleet node in flight is in exactly one of three states. They are mutually
exclusive, they have different deadlines, and they call for opposite responses.
All of it is already computable from data the view model holds.

| Band | Test | Deadline that applies | Source |
|---|---|---|---|
| **Installing** | not on target, `UpdateStartedAt != 0` | `fleetInstallLimit` (1 h) since `UpdateStartedAt`; and `updateSilenceLimit` (15 min) since `LastSeenAt` | `rollout_fleet.go:252`, `:275` |
| **Command never landed** | not on target, `UpdateStartedAt == 0` | `updateSilenceLimit` (15 min) since `tr.StageStartedAt` | `rollout_fleet.go:263` |
| **Observing** | **on target** | `fleetFirstWindow` (6 h) for the canary, `fleetStepWindow` (30 min) otherwise, since `max(tr.StageStartedAt, UpdateStartedAt)` | `rollout_fleet.go:282-293` |

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
`tr.StageStartedAt` (`rollout_byo.go:40`, `:230`).

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

**Which limit the installing band shows.** That band has two deadlines —
`fleetInstallLimit` (1 h since `UpdateStartedAt`) and `updateSilenceLimit`
(15 min since `LastSeenAt`) — and showing both at once is noise, because a
heartbeating node resets its silence clock every 30 seconds and that limit is
therefore irrelevant to it. The rule: while the node's last heartbeat is within
`nodeOnlineWindow` (90 s), show the install limit; once it is older than that,
the node has gone quiet and the silence limit is the one about to fire, so show
that one instead and say the node has stopped heartbeating. One limit is shown
at a time, and it is always the one that will actually decide this node's fate.

### The rules are on the page, not in a help modal

One line of small text under the status, per track:

- Fleet: canary 观察 6 小时，之后每台 30 分钟；节点每 ~10 分钟来问一次。
- BYO: 每批观察 6 小时。

These are the numbers an operator otherwise has to know or ask. Printing them
costs one line and removes the question permanently.

### Bands are not styled as alarms

A slow link taking forty minutes to fetch a binary is normal. Rendering it in a
warning colour trains the operator to ignore the colour, so the two non-observing
bands state the elapsed time and the limit plainly and escalate visually only
once a limit is actually crossed.

### Controls follow status

At any moment exactly one of `暂停` / `继续` is meaningful: `rolling` → pause
only; `halted` → resume only; `complete` → neither. The invalid one is **not
rendered**, rather than rendered disabled. That is the existing principle in this
file, already applied to `回滚到上一版本`.

### `正在更新` becomes three labels

`安装中` / `等待节点开始` / `观察中`, matching the bands. `观察中` is the case
the current wording denies, and the one an operator is most likely to
misdiagnose.

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

Rendering tests assert the control set for `rolling`, `halted`, `complete` and
never-configured. One of them is the regression guard for the bug that prompted
this work: **`继续` must not appear while rolling, and `暂停` must not appear
while halted.**

The three band labels are asserted to differ from each other, so that a later
refactor collapsing them into one generic string fails a test rather than
silently restoring today's behaviour.

## Code shape

A new `server/account/rollout_status.go` holds the classifier and the next-step
calculator with its own test file: pure, no clock, no database, no HTTP. The
existing `admin_rollout.go` (529 lines) gains only the field wiring into
`rolloutPanelView` and `rolloutNodeView`; `admin_templates.go` gains the status
line, the rules line and the status-conditional controls.
