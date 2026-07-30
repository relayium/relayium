# One node that cannot fetch a release should not stop the fleet

Date: 2026-07-30
Status: designed; not yet implemented

## Background

The v0.11.1 fleet rollout halted on a node in China that could not download
release archives from GitHub. Four of five nodes were on target; the fifth
stopped everyone. The immediate cause is fixed — that node now points at
central's release mirror — but the shape of the failure is not.

`resultForExitCode` (`server/cmd/relayium-node/update.go`) maps
`exitUpdateFailed` to `"failed"`, and `decideFleet` (`rollout_fleet.go:228`)
halts the track on `"failed"`. The exit code's own doc comment says what it
covers: *"download/checksum/signature failed"*.

**Those are three different events wearing one name.**

## The taxonomy

| What happened | What it tells you about the build | Correct response |
|---|---|---|
| **Could not obtain the bytes** — DNS, TLS, connection reset, 404 | Nothing. It is a property of that node's network. | Pass over this node, keep going |
| **Obtained them, verification failed** — checksum or signature | Either the release is broken or something served bytes that do not match the release key | **Halt, and say which** |
| **Installed, did not work** — restart failed, unhealthy | The build is bad on at least one machine | Halt (already `rolled_back`, already correct) |

Today the first two are indistinguishable, and both halt.

**This change is not a relaxation.** It splits a conflated signal and then moves
the two halves in opposite directions: unreachability stops halting the fleet,
and a verification failure becomes something the panel names as a verification
failure rather than as one more update error.

Doing only the first half would be worse than doing nothing. A signature
mismatch is the one category here that can be a security event, and if
"could not fetch" were routed to skip-and-continue while verification failures
kept sharing a name with it, the two would still be indistinguishable — except
that one of them would now sometimes be silently skipped.

The project already holds the underlying principle. `update.go`'s comment on
`"skipped"` says it exists so that a node declining locally does not leave
central to halt "the entire fleet rollout for a human, instead of skipping one
node". What was missing is that "cannot reach the release host" belongs on that
side of the line.

## What the node reports

`updateResults` (`server/account/nodes.go:290`) is a closed set —
`ok | failed | rolled_back | skipped` — validated on the way in. It gains one
member for "could not obtain the artifact". `selfupdate.Update` must return an
error the caller can classify: today a fetch failure and a checksum failure are
both plain errors, so the node cannot tell them apart to report them apart.
That classification is the substance of the node-side work.

**Deployment order is already correct and should stay stated:** central deploys
on every push to `main`, nodes only when a rollout reaches them, so central will
always accept the new value before any node can send it.

**The limitation worth writing down:** during the very rollout that ships this,
nodes still on the old binary report `failed` for a fetch failure. The
improvement applies to a node only once that node is running the new build.
The fleet gets there one release later, which is the ordinary cost of a
node-side protocol change and not a reason to add a compatibility shim.

## How the track finishes

A passed-over node is not a candidate, so the queue reaches the end. It must not
report a clean completion.

If a release is published with a broken asset, **every** node fails to fetch,
every one is passed over, and the queue finishes having updated nobody. A track
that showed a plain 完成 there would be a green panel over a rollout that did
nothing. That case is the entire reason this section exists.

### Recorded as a count, not as a fourth status

The obvious implementation is a new `status` value. It is the wrong one.

`status` is read as a predicate in a dozen places — `decideFleet`'s step 1,
`decideByo`, `rolloutStatusText`, the panel's control gating, the release
notice's in-flight rule, `HaltRolloutTrack`'s `WHERE`, `ResumeRolloutTrack`'s
`WHERE`. Every one of those is a switch on a string, and **eight defects in the
past week were a predicate that did not match the thing it described.** Adding a
fourth value to that vocabulary creates a dozen new opportunities for the ninth.

So: `status` stays `complete`, and the track row records **which nodes were
passed over and why**. The panel renders `完成，但 N 台未更新` from that list and
names each node with its reason. Nothing that switches on `status` changes
behaviour, and the operator-visible outcome — a completion that is visibly not
clean — is the same.

The one honest cost: code reading `Status == "complete"` and inferring "every
node updated" would still be wrong. It was already wrong before this change, for
the pre-existing `skipped` case.

## Retrying a node

Mechanically the smallest thing that works: **clear that node's
`update_result`** and it becomes a candidate again, because the candidate set is
"online and not on target" and the result field is what excluded it.

That alone is not enough — on a finished track `decideFleet` returns `wait` at
step 1 because the status is not `rolling`. So retry is two writes: clear the
node's result, and put the track back to `rolling`. It does **not** touch the
target version and does **not** re-pick the canary; the retried node will be the
only candidate.

### And it refuses on a halted track

Putting the track back to `rolling` clears the halt. So a retry offered on a
passed-over node while the track is **halted for a different node's verification
failure** would walk around the rule this design just wrote, sideways: the button
sits on an innocent row, and pressing it restarts a rollout that stopped for a
reason nobody addressed.

**Retry therefore requires the track to be `complete`.** On a halted track the
only way forward stays the whole-track 继续, which is where the halt reason is
displayed and the confirmation says what it does.

This is the same hole as the two shipped in the past two days — a guard written
for one axis and not the other — found here by asking what state the *track* is
in rather than only what state the *row* is in. Both the button and the handler
check it.

### Retry is offered on passed-over rows only

Not on `failed`, not on `rolled_back`.

A passed-over node made **no judgement about the build** — it never got the
bytes, or it declined locally. Retrying it risks nothing: you fixed its network,
it tries again.

A `failed` or `rolled_back` node **did** judge the build: it verified the bytes
and they were wrong, or it installed them and could not stay healthy. The track
stopped for that reason. A one-click retry there is a shortest path around a
verification failure — the one category in this taxonomy that can be a security
event. That path stays the existing whole-track 继续, which carries a
confirmation and says it will re-batch from the start.

Same principle the panel already applies twice: do not build a one-click route
to an action that deserves deliberation. The first was a button whose only
outcome is a refusal; the second, a button that silently discards a rollout in
flight; this is the third.

**The button's absence is not the guard.** The handler re-reads the node's
result and refuses unless it is a passed-over one. A stale page or a direct POST
must not reach what the UI declines to offer — that exact hole shipped twice in
the past two days.

### The panel distinguishes why

`拿不到产物` and `本地前置条件` render differently on the row, because the
operator's next move differs: the first is "fix the network, retry", the second
usually means the node had its own reason to decline and retrying will do the
same thing again.

## Testing

**The taxonomy, table-driven against `decideFleet`** — already a pure function.
One case per `UpdateResult` value: passed-over advances the queue; verification
failure halts **with a reason naming it as a verification failure**; installed
-but-unhealthy halts; `ok` behaves exactly as before. The last is the regression
guard: the likeliest damage from splitting a signal is accidentally routing a
value that was already correct into the new branch.

**The no-op rollout has its own case.** Every node fails to fetch; assert the
track does **not** finish clean, that the passed-over list has every node in it,
and that the panel copy reflects it. This is the whole reason the previous
section exists, it only appears when *all* nodes fail, and no ordinary test
reaches it.

**Node side: assert the classification, not the message.** Two upstreams — one
returning 404, one returning correct-length wrong bytes — must produce different
exit codes. Asserting on error strings gives a test that goes red when someone
rewords a message and stays green when someone breaks the classification, which
is backwards.

**Retry, by refusal first**: no retry control renders on a `failed` or
`rolled_back` row, and — separately — the handler refuses a POST for such a node
even though the button is absent.

**Retry, refused on a halted track**: a passed-over node on a track halted for
*another* node's verification failure gets no button, and the handler refuses the
POST. Assert the track's status and halt reason are both untouched afterwards —
this is the sideways route around the rule, and it is invisible to any test that
only varies the row.

**Retry, positive path**: retrying a passed-over node on a `complete` track
clears its result, returns the track to `rolling`, and leaves `TargetVersion` and
`FirstNodeID` **unchanged**. A suite of refusals passes against a handler that
refuses everything; that gap shipped in the release-check work two days ago and
is not repeating here.

## Out of scope

- Changing `canaryRank`. Once an unreachable node no longer halts the track,
  picking it first costs one skip rather than the whole rollout, so the pick
  order needs no defending against this failure.
- Automatic retry. Every retry is a human deciding the underlying problem is
  fixed.
- The BYO track. Its ladder commands batches rather than single nodes and its
  failure accounting is a percentage; the same taxonomy may well apply, but it
  is a separate design.
