#!/usr/bin/env bash
# scripts/test/db-rollback-harness.sh — the SQLite rollback evidence gate.
#
# ## What this exists to catch
#
# deploy/auto-deploy.sh swaps a new server binary in and, when the new one
# fails its health check, puts the PREVIOUS binary back and points it at the
# same SQLite file the new one has already opened, migrated and written to.
# Nothing else in this repository exercises that direction. Every migration
# test in server/account runs one binary FORWARD over an old file; not one of
# them hands a NEWER file to an OLDER binary, which is the only direction a
# rollback takes.
#
# So this harness does the real thing. It builds two REAL server binaries — one
# from the commit named in server/ROLLBACK-FLOOR, one from this worktree — and
# drives ONE shared database through:
#
#     1. floor   create + write
#     2. HEAD    reopen + write        (also writes a pending billing journal)
#     3. floor   reopen + read + write (the rollback)
#     4. HEAD    reopen + read + write + validate
#
# Every write and almost every read goes through the server's PUBLIC HTTP
# surface, because that is what an operator's users are actually doing across a
# rollback. Direct sqlite3 access is used in exactly two roles, both marked
# below: stable fixture setup that has no public endpoint, and final invariants
# read straight out of the tables.
#
# ## What makes a green run mean something
#
# A staged harness fails silently in one characteristic way: a stage stops
# running and nothing notices. Three separate things stop that here.
#
#   * Every stage appends a row to a LEDGER naming its index, its role, the
#     commit it was built from and the sha256 of the binary that actually
#     served it — read back off the RUNNING process, not off the plan. The
#     final check requires exactly four rows in order, alternating floor and
#     HEAD, with the floor rows' digest equal to each other, the HEAD rows'
#     digest equal to each other, and the two digests DIFFERENT. One binary
#     playing both parts is the failure that would make every other assertion
#     here vacuous, and it is checked first.
#
#   * Every stage re-reads the account's cumulative traffic BEFORE it writes
#     and requires the exact byte total the previous stages left behind. The
#     upload sizes are distinct and non-additive, so a skipped, repeated or
#     reordered stage lands on a number no other arrangement produces.
#
#   * The final assertion is an EXACT equality on cumulative bytes, taken twice
#     from two independent places: the server's own /api/me/usage, and the
#     usage_monthly rows underneath it. A lost meter and a double-counted meter
#     both fail, by amount, in the direction they happened.
#
# ## Network
#
# This harness is NOT offline, and does not pretend to be. What is actually
# true, claim by claim:
#
#   * THE BUILDS MAY REACH THE NETWORK. GOFLAGS=-mod=readonly forbids EDITING
#     go.mod/go.sum; it does not forbid downloading. Any module missing from the
#     local module cache is fetched from the configured Go module proxy. The
#     floor build is the likelier one to fetch: the CI cache in
#     .github/workflows/go.yml is keyed on HEAD's server/go.sum, and the floor
#     commit's graph is not necessarily the same one.
#   * INTEGRITY IS PINNED BY go.sum, not by the absence of a network. Each tree
#     carries its own go.sum and the go command verifies every module it
#     downloads against the go.sum of the tree being built. A module whose
#     contents do not match fails the build.
#   * NO MODULE FILE MAY BE EDITED. That is what -mod=readonly does buy, and it
#     is the property this harness actually needs: each binary is built from its
#     OWN pinned dependency graph, and a floor whose graph no longer resolves
#     fails loudly instead of being silently rewritten into one that does.
#   * TOOLCHAIN DOWNLOAD IS THE ONE THING GENUINELY FORBIDDEN. GOTOOLCHAIN=local
#     pins both builds to the installed toolchain, so a tree whose go.mod asks
#     for a newer Go fails rather than fetching one.
#   * THE RUNTIME CHECKS MAKE NO EXTERNAL CALLS. Every server instance runs with
#     -release-check=false, so no instance polls github.com; no Stripe key is
#     configured, so the billing paths have no provider to call; the stage-3
#     journal read is the operator LIST path, which decodes a local row and
#     exits; and the one email-shaped step runs under -mail-transport
#     dev-log-links, which writes the link to the log instead of sending it.
#
# ## Time
#
# /api/me/usage reports the CURRENT UTC month, while this run occupies real
# time. A run that straddled a month boundary would watch the reported total
# reset to zero mid-flight and report it as an accounting mismatch — a false red
# that blames the rollback for the calendar. The month-window gate below runs
# after the builds, refuses to start the stages too close to the boundary, and
# pins the period every later usage observation must belong to.

set -euo pipefail

# ── plumbing ────────────────────────────────────────────────────────────────

readonly ME="db-rollback-harness"

fail() { printf '%s: FAIL: %s\n' "$ME" "$*" >&2; exit 1; }
say()  { printf '%s: %s\n' "$ME" "$*"; }
step() { printf '\n%s: ── %s ──\n' "$ME" "$*"; }

# The calendar's own failure, given a name so it can never be read as an
# accounting result. Anything that reaches this has left the UTC month the
# stages were gated into, which invalidates every /api/me/usage comparison in
# the run — the numbers are not wrong, they are answers about a different
# period. Reviewers and CI logs both need that distinction, because "traffic
# 12308 != 61490" and "the month changed underneath us" call for opposite
# responses: one is a rollback defect, the other is a re-run.
readonly PERIOD_BOUNDARY_ERROR="UTC-PERIOD-BOUNDARY"
fail_period_boundary() { fail "$PERIOD_BOUNDARY_ERROR: $*"; }

need_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required and not on PATH${2:+ ($2)}"
}

# sha256 of a file, as bare hex. macOS ships shasum, Linux sha256sum.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

sha256_of_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

need_tool git
need_tool go
need_tool curl
need_tool jq
need_tool sqlite3 "the final invariants are read straight out of the database"
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 \
  || fail "neither sha256sum nor shasum is available; binary identity cannot be recorded"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)" || fail "not inside a git work tree"
readonly SCRIPT_DIR REPO

readonly FLOOR_RECORD="$REPO/server/ROLLBACK-FLOOR"

# ── the floor record ────────────────────────────────────────────────────────
#
# Parsed here in shell as well as in Go (parseRollbackFloor,
# server/rollback_floor_test.go) and by the same rule: blank and #-comment
# lines are ignored, and EXACTLY ONE `commit <40 lowercase hex>` line must
# remain. The duplication is deliberate. This reader has to reject a bad floor
# before the harness spends two builds on it, and two readers that disagree are
# caught by CI running both in the same job.

read_floor_commit() {
  local file=$1 line found="" n=0
  [ -f "$file" ] || fail "no floor record at $file"
  [ -s "$file" ] || fail "floor record $file is empty; a truncated record is not permission to skip this gate"
  case "$(cat "$file")" in
    *$'\r'*) fail "floor record $file contains a CR; it must use LF line endings" ;;
  esac
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    case "$line" in
      ''|'#'*) continue ;;
    esac
    if ! printf '%s' "$line" | grep -qE '^commit [0-9a-f]{40}$'; then
      fail "floor record $file line $n is neither a comment nor \`commit <40 lowercase hex>\`: $line"
    fi
    if [ -n "$found" ]; then
      fail "floor record $file line $n is a second commit line; the floor is exactly one commit"
    fi
    found=${line#commit }
  done < "$file"
  [ -n "$found" ] || fail "floor record $file names no commit"
  printf '%s' "$found"
}

FLOOR_COMMIT="$(read_floor_commit "$FLOOR_RECORD")"
readonly FLOOR_COMMIT

step "floor record"
say "floor commit: $FLOOR_COMMIT"

# Object validation, all local. Each of these is a distinct way the record can
# be wrong, and each one would otherwise surface as a confusing build error.
git -C "$REPO" cat-file -e "$FLOOR_COMMIT" 2>/dev/null \
  || fail "floor object $FLOOR_COMMIT is not in this repository. On a shallow clone, fetch full history (fetch-depth: 0)"
floor_type="$(git -C "$REPO" cat-file -t "$FLOOR_COMMIT")"
[ "$floor_type" = commit ] \
  || fail "floor $FLOOR_COMMIT is a $floor_type, not a commit; only a commit can be checked out and built"
git -C "$REPO" merge-base --is-ancestor "$FLOOR_COMMIT" HEAD \
  || fail "floor $FLOOR_COMMIT is not an ancestor of HEAD; a floor off this history is not a rollback target"
for want in server/main.go server/go.mod server/go.sum; do
  git -C "$REPO" cat-file -e "$FLOOR_COMMIT:$want" 2>/dev/null \
    || fail "floor $FLOOR_COMMIT has no $want, so no server binary can be built from it"
done
say "floor is a commit, an ancestor of HEAD, and carries a server tree ($(git -C "$REPO" rev-list --count "$FLOOR_COMMIT..HEAD") commits behind)"

# ── scratch state, and getting rid of it ────────────────────────────────────

RUN="$(mktemp -d "${TMPDIR:-/tmp}/relayium-rollback.XXXXXXXX")"
FLOOR_WT="$RUN/floor-worktree"
PIDS=""
readonly RUN FLOOR_WT

# Set on the final line of this script and nowhere else. Declared here, above
# the trap that reads it, so that an early death cannot hit it unbound under
# `set -u`.
REACHED_PASS=0

# One trap for every exit path, including the failures above's descendants.
# Ordered worst-consequence-first: a stray server holding the DB open outlives
# this run, a stray git worktree corrupts the NEXT run's `git worktree add`, and
# the temp tree is merely disk.
cleanup() {
  local status=$1 pid
  # Disarm both traps first: a signal path calls this and then exits, which
  # would otherwise re-enter through EXIT and kill an already-cleaned run.
  trap - EXIT INT TERM
  set +e
  for pid in $PIDS; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null
    fi
  done
  # Give each one a bounded moment to close the database, then insist.
  local waited=0
  while [ "$waited" -lt 50 ]; do
    local alive=0
    for pid in $PIDS; do
      kill -0 "$pid" 2>/dev/null && alive=1
    done
    [ "$alive" -eq 0 ] && break
    sleep 0.1
    waited=$((waited + 1))
  done
  for pid in $PIDS; do
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
  done
  if [ -d "$FLOOR_WT" ]; then
    git -C "$REPO" worktree remove --force "$FLOOR_WT" >/dev/null 2>&1
    rm -rf "$FLOOR_WT"
    git -C "$REPO" worktree prune >/dev/null 2>&1
  fi
  if [ "${RELAYIUM_ROLLBACK_KEEP:-0}" = 1 ]; then
    printf '%s: kept scratch tree %s (RELAYIUM_ROLLBACK_KEEP=1)\n' "$ME" "$RUN" >&2
  else
    rm -rf "$RUN"
  fi
  # Fail closed on a zero status that did not come from finishing. `$?` in the
  # EXIT trap is whatever the last command left behind, and several ways of
  # dying leave a 0 there — a bash SYNTAX ERROR in a function parsed late in
  # this file is the demonstrated one: the script aborts, no stage ever runs,
  # and without this the trap exits 0 and CI reports a green rollback gate that
  # tested nothing. REACHED_PASS is set only on the last line of the script, so
  # the only run that may report success is one that got there.
  if [ "$status" -eq 0 ] && [ "$REACHED_PASS" -ne 1 ]; then
    printf '%s: FAIL: exited 0 without reaching the PASS banner — the run stopped early (a bash
       syntax error, a return outside a function, or a stray successful exit). A rollback gate
       that did not run its stages must not report success.\n' "$ME" >&2
    status=1
  fi
  exit "$status"
}
# An interrupted run must not report success. `$?` inside a signal trap is the
# status of whatever command the signal happened to land on, which is routinely
# 0, so each signal's conventional 128+n status is stated rather than inherited.
trap 'cleanup "$?"' EXIT
trap 'cleanup 130' INT
trap 'cleanup 143' TERM

DB="$RUN/relayium.db"
BLOBS="$RUN/blobs"
STATIC="$RUN/static"
LEDGER="$RUN/stage-ledger.tsv"
readonly DB BLOBS STATIC LEDGER
mkdir -p "$BLOBS" "$STATIC"
: > "$LEDGER"

# Not a credential: this instance is created, used and deleted inside $RUN.
# It exists because the account-deletion path refuses to run without one, which
# is what the pending billing journal in stage 2 needs.
readonly HOLD_SECRET="rollback-harness-local-hold-secret"

# ── builds ──────────────────────────────────────────────────────────────────
#
# GOTOOLCHAIN=local: the build uses the toolchain that is installed and may not
# reach out for another one, so what CI compiles is what CI has.
#
# GOFLAGS=-mod=readonly: neither build may edit go.mod or go.sum, so each binary
# is built from its OWN pinned dependency graph. This is NOT an offline switch —
# see the Network section at the top of this file. Modules absent from the local
# cache are still downloaded from the module proxy; what -mod=readonly
# guarantees is that the graph is not rewritten to make a build succeed, and
# what each tree's go.sum guarantees is that whatever is downloaded is the
# pinned content.

build_server() {
  local src=$1 out=$2 label=$3
  say "building $label server from $src"
  ( cd "$src" && GOTOOLCHAIN=local GOFLAGS=-mod=readonly go build -o "$out" ./ ) \
    || fail "building the $label server failed. If this is 'go.mod requires go >= X', the installed
       toolchain is older than go.mod asks for; GOTOOLCHAIN=local is deliberate — install the
       toolchain go.mod names rather than letting the build fetch one."
  [ -x "$out" ] || fail "$label build produced no executable at $out"
  # Read-only from here on: the digest recorded next is the thing every stage
  # re-checks, and it must not be possible to swap the file underneath it.
  chmod a-w "$out"
}

step "builds"
mkdir -p "$RUN/bin"
HEAD_COMMIT="$(git -C "$REPO" rev-parse HEAD)"
readonly HEAD_COMMIT

# HEAD comes from the WORKTREE, not from `git show HEAD`: an operator deploys
# what is on disk, and a rollback gate that silently ignored uncommitted server
# changes would pass for a tree nobody is going to run.
build_server "$REPO/server" "$RUN/bin/head" "HEAD ($HEAD_COMMIT)"

# The floor comes from its exact objects, through a detached worktree, so
# nothing in the current tree can leak into it.
git -C "$REPO" worktree add --detach "$FLOOR_WT" "$FLOOR_COMMIT" >/dev/null 2>&1 \
  || fail "could not create a worktree at the floor commit $FLOOR_COMMIT"
build_server "$FLOOR_WT/server" "$RUN/bin/floor" "floor ($FLOOR_COMMIT)"

FLOOR_BIN="$RUN/bin/floor"
HEAD_BIN="$RUN/bin/head"
FLOOR_SHA="$(sha256_of "$FLOOR_BIN")"
HEAD_SHA="$(sha256_of "$HEAD_BIN")"
readonly FLOOR_BIN HEAD_BIN FLOOR_SHA HEAD_SHA

say "floor binary sha256 $FLOOR_SHA"
say "HEAD  binary sha256 $HEAD_SHA"

# The one assumption every other check rests on. If these matched, both "roles"
# would be the same program and the whole rollback would be theatre.
[ "$FLOOR_SHA" != "$HEAD_SHA" ] \
  || fail "the floor and HEAD binaries are byte-identical ($FLOOR_SHA). Either the floor record
       names HEAD, or one build overwrote the other; either way nothing below tests a rollback."

# Recorded, not asserted: the two flag surfaces are a human-readable second
# view of "these are different programs", and the diff explains the per-binary
# flag mapping below.
flag_surface_digest() { { "$1" -h 2>&1 || true; } | sha256_of_stdin; }
say "floor flag-surface digest $(flag_surface_digest "$FLOOR_BIN")"
say "HEAD  flag-surface digest $(flag_surface_digest "$HEAD_BIN")"

# ── the month-window gate ───────────────────────────────────────────────────
#
# /api/me/usage answers for the CURRENT UTC month (server: periodOf(now), the
# 'YYYYMM' bucket, and currentMonthTraffic under it). Every cumulative-traffic
# assertion below is therefore a statement about one period. If the run crossed
# into the next month mid-flight, the reported total would drop back toward zero
# and the next stage would report a large accounting mismatch — blaming the
# rollback for the calendar. This is the classic once-a-month flake, and it is
# worth two things: not hitting it, and never MISREADING it if it happens.
#
# Placed here, after the builds, on purpose. The builds are the long and
# variable part of this script (two full server compilations, and the floor's
# module graph may need fetching); gating before them would measure the wrong
# interval and could still spend minutes and then straddle anyway. From this
# point on, what remains is the four stages.
#
# ## The margin, and why it is not the sum of the timeouts
#
# The obvious rule — "require at least as much month left as the per-stage
# timeouts can consume" — does not work here, and saying why is the point.
# Adding up every bound the stages can reach gives roughly 45 HTTP calls at
# their 30s and 60s curl ceilings plus four readiness waits, i.e. tens of
# minutes: more than the whole 20-minute job budget in
# .github/workflows/go.yml. A margin that size could never be satisfied, and
# waiting one out would blow the same budget. So the margin is not, and cannot
# be, a hard upper bound on the stages.
#
# What it is: a bound comfortably above what a run that is going to PASS
# actually takes. The four stages measure ~7s end to end; a passing run never
# approaches a curl ceiling, because every one of those ceilings is reached only
# by a hung server, which fails the run rather than slowly finishing it. 360s is
# ~50x the measured figure, and it is small enough that waiting a full one out
# still fits: worst case it adds 360s to a job whose checkout, setup, floor test
# and two builds have historically left well over half of the 20 minutes unused.
#
# The margin is the flake-avoidance half. The CORRECTNESS half is
# assert_stage_period below, which pins every later usage observation to the
# period recorded here — so a run that somehow crosses the boundary anyway fails
# by the name PERIOD_BOUNDARY_ERROR instead of arriving as a mysterious byte
# discrepancy. Neither half is trusted to be the only one.
readonly MONTH_GATE_MARGIN_SECONDS=360

# The settle interval added after a boundary wait, so the gate resumes plainly
# inside the new month rather than on its first second.
readonly MONTH_GATE_SETTLE_SECONDS=5

# A hard ceiling on how long this gate may ever sleep, independent of the margin
# above. By construction the wait can only be `remaining + settle` where
# remaining < MARGIN, so a needed wait above this is arithmetically impossible
# and means the boundary computation or the clock is wrong — in which case
# sleeping on it is the worst available response. It is also what keeps a
# mistaken margin from parking this job until the 20-minute timeout kills it.
readonly MONTH_GATE_MAX_WAIT_SECONDS=420

# next_utc_month_start <year> <month> — the unix second at which the given UTC
# month ends and the next one begins.
#
# Computed rather than asked of date(1): `date -d` and `date -r` disagree across
# GNU and BSD, and this must give the same answer on a developer's macOS and on
# ubuntu-latest. The body is the standard days_from_civil algorithm with the day
# fixed at 1 (so the `d - 1` term vanishes), which is exact for every month in
# the range this project can encounter and needs no leap-year special cases.
# It is cross-checked against the SERVER's own boundary — /api/me/usage's
# `resetsAt`, i.e. monthRange(period).end — at the first usage observation, so a
# drift between this arithmetic and the server's definition is caught rather
# than assumed away.
next_utc_month_start() {
  local y=$1 m=$2 yy era yoe mp doy doe days
  m=$((m + 1))
  if [ "$m" -gt 12 ]; then m=1; y=$((y + 1)); fi
  yy=$y
  [ "$m" -le 2 ] && yy=$((yy - 1))
  era=$((yy / 400))
  yoe=$((yy - era * 400))
  if [ "$m" -gt 2 ]; then mp=$((m - 3)); else mp=$((m + 9)); fi
  doy=$(((153 * mp + 2) / 5))
  doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
  days=$((era * 146097 + doe - 719468))
  printf '%s' $((days * 86400))
}

# read_utc_now sets NOW_EPOCH, NOW_PERIOD and PERIOD_END from a SINGLE date(1)
# call. One call matters: reading the epoch and the calendar fields separately
# could land on either side of the very boundary this gate exists to reason
# about, and would then produce a period that does not contain its own epoch.
read_utc_now() {
  local stamp y m
  stamp="$(date -u '+%s %Y %m')" || fail "could not read the current UTC time"
  read -r NOW_EPOCH y m <<<"$stamp"
  NOW_PERIOD="${y}${m}"
  PERIOD_END="$(next_utc_month_start "$((10#$y))" "$((10#$m))")"
}

step "month-window gate"

read_utc_now
month_left=$((PERIOD_END - NOW_EPOCH))
say "now $NOW_EPOCH is in UTC period $NOW_PERIOD, which ends at $PERIOD_END (${month_left}s left)"

if [ "$month_left" -lt "$MONTH_GATE_MARGIN_SECONDS" ]; then
  wait_for=$((month_left + MONTH_GATE_SETTLE_SECONDS))
  [ "$wait_for" -le "$MONTH_GATE_MAX_WAIT_SECONDS" ] \
    || fail_period_boundary "the gate computed a ${wait_for}s wait to clear period $NOW_PERIOD, above the
       ${MONTH_GATE_MAX_WAIT_SECONDS}s this job can afford. A wait can only be shorter than
       MONTH_GATE_MARGIN_SECONDS (${MONTH_GATE_MARGIN_SECONDS}s) plus settle, so this means the boundary
       arithmetic or the clock is wrong — not that the month is unusually long."
  say "only ${month_left}s left in period $NOW_PERIOD, under the ${MONTH_GATE_MARGIN_SECONDS}s margin;"
  say "waiting ${wait_for}s into the next period rather than straddling the boundary"
  sleep "$wait_for"
  read_utc_now
  month_left=$((PERIOD_END - NOW_EPOCH))
  say "resumed in UTC period $NOW_PERIOD with ${month_left}s left"
  # After a wait the fresh period is a whole month long, so falling short here
  # is not a tight-margin case; it means the wait did not do what it was for.
  [ "$month_left" -ge "$MONTH_GATE_MARGIN_SECONDS" ] \
    || fail_period_boundary "after waiting into period $NOW_PERIOD only ${month_left}s remain, still under the
       ${MONTH_GATE_MARGIN_SECONDS}s margin. The gate did not clear the boundary it was waiting on."
fi

# The period every later /api/me/usage observation must report. Recorded once,
# here, so that the stages compare against a decision this gate made rather than
# against whatever the clock happens to say when each assertion runs.
STAGE_PERIOD="$NOW_PERIOD"
STAGE_PERIOD_END="$PERIOD_END"
readonly STAGE_PERIOD STAGE_PERIOD_END
say "stages pinned to UTC period $STAGE_PERIOD (ends $STAGE_PERIOD_END)"

# ── running a server ────────────────────────────────────────────────────────

# supports_flag answers whether a binary declares a flag, by reading its own
# help output. The floor and HEAD do not necessarily accept the same flags —
# that is what a version gap means — and passing one an unknown flag is a fatal
# parse error, so the flag list is derived per binary rather than assumed.
supports_flag() {
  { "$1" -h 2>&1 || true; } | grep -qE "^[[:space:]]*-$2([[:space:]]|=|$)"
}

require_flag() {
  supports_flag "$1" "$2" \
    || fail "the $3 binary does not accept -$2, which this harness needs to run it in isolation.
       Adjust the harness deliberately; do not drop the isolation."
}

for bin_label in "$FLOOR_BIN:floor" "$HEAD_BIN:HEAD"; do
  bin=${bin_label%%:*}; label=${bin_label##*:}
  for f in addr db blob-dir static base-url billing-hold-secret release-check; do
    require_flag "$bin" "$f" "$label"
  done
done

port_is_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

pick_port() {
  local p
  for p in $(seq 21500 21700); do
    if port_is_free "$p"; then printf '%s' "$p"; return 0; fi
  done
  fail "no free localhost port in 21500-21700"
}

# start_server <binary> <port> <logfile> — sets STARTED_PID.
#
# Deliberately NOT `pid="$(start_server ...)"`. Command substitution runs the
# function in a SUBSHELL, so the append to PIDS below would be lost the moment
# it returned — and the background server, started inside that subshell, would
# be orphaned rather than tracked. The cleanup trap would then have an empty
# list and every failed run would leak a live server holding a deleted database
# open. Returning through a global is what keeps the trap's list complete.
start_server() {
  local bin=$1 port=$2 log=$3
  local -a args=(
    -addr "127.0.0.1:$port"
    -db "$DB"
    -blob-dir "$BLOBS"
    -static "$STATIC"
    -base-url "http://127.0.0.1:$port"
    -billing-hold-secret "$HOLD_SECRET"
    -release-check=false
  )
  # The verification and account-deletion tokens this harness needs are emailed,
  # and with no SMTP configured they are logged instead. A binary that has the
  # mail-transport selector redacts them unless dev-log-links is chosen; an
  # older one has no selector and logs them in full already. Asking the binary
  # rather than the version keeps this correct as the floor moves.
  if supports_flag "$bin" mail-transport; then
    args+=(-mail-transport dev-log-links)
  fi
  "$bin" "${args[@]}" >"$log" 2>&1 &
  STARTED_PID=$!
  PIDS="$PIDS $STARTED_PID"
}

stop_server() {
  local pid=$1 waited=0
  kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 100 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
    sleep 0.2
  fi
}

# wait_ready is the readiness half of each stage's gate. /api/config is served
# only after the store is open and the schema has been migrated, so a 200 here
# means this binary really did open THIS database — which is the whole question
# for the floor stages.
wait_ready() {
  local port=$1 pid=$2 log=$3 waited=0
  while [ "$waited" -lt 200 ]; do
    waited=$((waited + 1))
    if ! kill -0 "$pid" 2>/dev/null; then
      printf '%s: server pid %s exited before becoming ready; log follows\n' "$ME" "$pid" >&2
      sed -e 's/^/    | /' "$log" >&2
      fail "server exited during startup"
    fi
    if curl -fsS --max-time 2 "http://127.0.0.1:$port/api/config" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  printf '%s: server on port %s never became ready; log follows\n' "$ME" "$port" >&2
  sed -e 's/^/    | /' "$log" >&2
  fail "server did not become ready within 20s"
}

# ── stage identity ──────────────────────────────────────────────────────────

# running_exe reports the program path the kernel is running for a pid, read
# from the process table rather than from what this script intended to launch.
running_exe() { ps -o args= -p "$1" 2>/dev/null | awk 'NR==1 {print $1}'; }

STAGE_INDEX=0

# open_stage <role> — starts the stage's server, proves its identity and
# readiness, appends the ledger row, and exports STAGE_PORT / STAGE_PID.
open_stage() {
  local role=$1 bin want_sha commit
  case "$role" in
    floor) bin=$FLOOR_BIN; want_sha=$FLOOR_SHA; commit=$FLOOR_COMMIT ;;
    head)  bin=$HEAD_BIN;  want_sha=$HEAD_SHA;  commit=$HEAD_COMMIT ;;
    *) fail "unknown stage role $role" ;;
  esac
  STAGE_INDEX=$((STAGE_INDEX + 1))
  STAGE_PORT="$(pick_port)"
  STAGE_LOG="$RUN/stage${STAGE_INDEX}-${role}.log"
  start_server "$bin" "$STAGE_PORT" "$STAGE_LOG"
  STAGE_PID=$STARTED_PID
  wait_ready "$STAGE_PORT" "$STAGE_PID" "$STAGE_LOG"

  # Identity, taken from the RUNNING process. Two independent facts: the kernel
  # is running the file this stage meant to run, and that file still hashes to
  # what was recorded at build time. Together they refuse a stage that quietly
  # ran the other role's binary.
  local exe got_sha
  exe="$(running_exe "$STAGE_PID")"
  [ -n "$exe" ] || fail "stage $STAGE_INDEX ($role): could not read the running program for pid $STAGE_PID"
  [ "$exe" = "$bin" ] \
    || fail "stage $STAGE_INDEX ($role): pid $STAGE_PID is running $exe, not $bin"
  got_sha="$(sha256_of "$exe")"
  [ "$got_sha" = "$want_sha" ] \
    || fail "stage $STAGE_INDEX ($role): $exe hashes to $got_sha, want $want_sha — the binary
       changed underneath this run"

  # Readiness recorded as evidence, not just as a wait: the response body the
  # gate accepted is kept so a green run can be re-read later.
  local config
  config="$(curl -fsS --max-time 5 "http://127.0.0.1:$STAGE_PORT/api/config")" \
    || fail "stage $STAGE_INDEX ($role): /api/config did not answer after readiness"
  printf '%s' "$config" | jq -e 'has("maxFileSize") and has("dailyQuota")' >/dev/null \
    || fail "stage $STAGE_INDEX ($role): /api/config answered something that is not the config: $config"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$STAGE_INDEX" "$role" "$commit" "$got_sha" "$STAGE_PID" "$STAGE_PORT" "$exe" >> "$LEDGER"
  step "stage $STAGE_INDEX: $role ($commit) on port $STAGE_PORT, pid $STAGE_PID"
}

close_stage() {
  stop_server "$STAGE_PID"
  say "stage $STAGE_INDEX closed"
}

# ── HTTP helpers ────────────────────────────────────────────────────────────

api() { # api <method> <path> [json-body] — authenticated with $JAR
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -fsS --max-time 30 -b "$JAR" -c "$JAR" -X "$method" \
      -H 'content-type: application/json' -d "$body" "http://127.0.0.1:$STAGE_PORT$path"
  else
    curl -fsS --max-time 30 -b "$JAR" -c "$JAR" -X "$method" \
      "http://127.0.0.1:$STAGE_PORT$path"
  fi
}

anon() { # anon <method> <path> [json-body] — no session
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -fsS --max-time 30 -X "$method" -H 'content-type: application/json' \
      -d "$body" "http://127.0.0.1:$STAGE_PORT$path"
  else
    curl -fsS --max-time 30 -X "$method" "http://127.0.0.1:$STAGE_PORT$path"
  fi
}

# token_from_log pulls a one-time link's token out of the server log. The link
# is what the user would receive by email; with no SMTP configured the server
# logs it instead.
token_from_log() {
  local log=$1 path=$2 tok
  tok="$(grep -o "${path}?token=[0-9a-f]*" "$log" | tail -1 | cut -d= -f2)"
  [ -n "$tok" ] || {
    printf '%s: no %s token in %s; log follows\n' "$ME" "$path" "$log" >&2
    sed -e 's/^/    | /' "$log" >&2
    fail "could not read the emailed token from the server log"
  }
  printf '%s' "$tok"
}

readonly MANIFEST_BYTES=16

# make_body <ciphertext-bytes> <outfile> — one stored-transfer upload body:
# a 4-byte big-endian manifest length, that many opaque manifest bytes, then the
# ciphertext. The server meters exactly the ciphertext byte count.
make_body() {
  local n=$1 out=$2
  {
    printf '\000\000\000\020'
    head -c "$MANIFEST_BYTES" /dev/zero | tr '\0' 'M'
    head -c "$n" /dev/zero | tr '\0' 'C'
  } > "$out"
  local got
  got=$(wc -c < "$out" | tr -d ' ')
  [ "$got" -eq $((4 + MANIFEST_BYTES + n)) ] \
    || fail "built a $got-byte upload body for $n ciphertext bytes; expected $((4 + MANIFEST_BYTES + n))"
}

# maxDownloads is passed explicitly rather than left to the deployment default,
# which is burn-after-read: a burn object deletes itself on the first download,
# and this harness downloads earlier stages' files precisely to prove they
# survived a version change. Five is arbitrary and comfortably above the one
# download any file here receives.
readonly UPLOAD_MAX_DOWNLOADS=5

upload() { # upload <ciphertext-bytes> — echoes the stored file id
  local n=$1
  local body="$RUN/upload-$STAGE_INDEX-$n.bin"
  local resp
  make_body "$n" "$body"
  resp="$(curl -fsS --max-time 60 -b "$JAR" -X POST \
    -H 'content-type: application/octet-stream' --data-binary "@$body" \
    "http://127.0.0.1:$STAGE_PORT/api/files?maxDownloads=$UPLOAD_MAX_DOWNLOADS")" \
    || fail "stage $STAGE_INDEX: uploading $n bytes failed"
  printf '%s' "$resp" | jq -er '.id' 2>/dev/null \
    || fail "stage $STAGE_INDEX: upload answered $resp"
}

share_count() {
  api GET /api/files | jq -er '.files | length'
}

expect_eq() { # expect_eq <got> <want> <what>
  [ "$1" = "$2" ] || fail "$3: got $1, want $2"
  say "ok — $3 = $2"
}

# ── reading the meter, in one period ────────────────────────────────────────
#
# Every cumulative-traffic figure in this run comes from here, and every one of
# them is checked to belong to the period the month-window gate pinned. The
# response is fetched ONCE and the number and the period are read out of that
# same body: asking for the total and then separately asking which period it was
# is exactly the race the gate exists to remove.
#
# read_usage deliberately runs in the CALLING shell rather than being consumed
# through `$(...)`. A `fail` inside command substitution exits only the subshell
# — the run would print the period-boundary message and then carry on to report
# the resulting empty string as a traffic mismatch, which is precisely the
# misdiagnosis this whole section is here to prevent.
USAGE_USED=""
USAGE_PERIOD=""
USAGE_RESETS_AT=""

read_usage() { # read_usage <what> — sets USAGE_USED / USAGE_PERIOD / USAGE_RESETS_AT
  local what=$1 body
  body="$(api GET /api/me/usage)" \
    || fail "stage $STAGE_INDEX: $what: GET /api/me/usage failed"
  USAGE_USED="$(printf '%s' "$body" | jq -er '.traffic.used')" \
    || fail "stage $STAGE_INDEX: $what: /api/me/usage has no .traffic.used: $body"
  USAGE_PERIOD="$(printf '%s' "$body" | jq -er '.period')" \
    || fail "stage $STAGE_INDEX: $what: /api/me/usage has no .period: $body"
  USAGE_RESETS_AT="$(printf '%s' "$body" | jq -er '.resetsAt')" \
    || fail "stage $STAGE_INDEX: $what: /api/me/usage has no .resetsAt: $body"
  assert_stage_period "$what"
}

# assert_stage_period is the correctness half of the month-window gate: the
# margin makes a straddle unlikely, this makes it legible. Both facts are
# checked, and they fail for different reasons:
#
#   * .period must be the period the gate pinned. This is the one that fires if
#     the run really did cross a UTC month boundary, and it fires at the FIRST
#     observation in the new month — before any comparison against a total
#     accumulated in the old one can be misread as a lost meter.
#   * .resetsAt must be the boundary this script computed for that period. The
#     server derives it independently (monthRange(period).end); this script
#     derives it from days_from_civil. They are two implementations of the same
#     calendar, and a disagreement means the gate has been reasoning about a
#     boundary the server does not share — in which case the margin above was
#     measured against the wrong instant and is worthless.
assert_stage_period() {
  local what=$1
  [ "$USAGE_PERIOD" = "$STAGE_PERIOD" ] \
    || fail_period_boundary "$what: /api/me/usage answered for period $USAGE_PERIOD, but the stages were
       gated into $STAGE_PERIOD. The run crossed a UTC month boundary, so its cumulative traffic
       figures describe two different periods and cannot be compared. This is a calendar event,
       not a rollback defect: re-run it."
  [ "$USAGE_RESETS_AT" = "$STAGE_PERIOD_END" ] \
    || fail_period_boundary "$what: the server ends period $USAGE_PERIOD at $USAGE_RESETS_AT, but this
       harness computed $STAGE_PERIOD_END. The month-window gate measured its margin against a
       boundary the server does not agree with, so the gate proves nothing."
}

expect_traffic() { # expect_traffic <want> <what>
  read_usage "$2"
  expect_eq "$USAGE_USED" "$1" "$2"
}

# ── the plan ────────────────────────────────────────────────────────────────
#
# Four upload sizes, deliberately not multiples or sums of one another, and two
# downloads whose sizes are two of the uploads. Every stage therefore moves the
# cumulative total to a value that no other subset of stages reaches, so a
# skipped, duplicated or reordered stage fails on the amount — not merely on
# the ledger shape.
readonly UP1=4099 UP2=8209 UP3=16411 UP4=32771

# Cumulative expectations, written out rather than accumulated in a loop so
# each one can be read against the stage list above.
readonly AFTER1_UP=$((UP1))                     AFTER1_DOWN=0
readonly AFTER2_UP=$((UP1 + UP2))               AFTER2_DOWN=0
readonly AFTER3_UP=$((UP1 + UP2 + UP3))         AFTER3_DOWN=$((UP2))
readonly AFTER4_UP=$((UP1 + UP2 + UP3 + UP4))   AFTER4_DOWN=$((UP2 + UP3))

readonly EMAIL_A="rollback-a@relayium.invalid"
readonly EMAIL_B="rollback-b@relayium.invalid"
readonly PASSWORD="rollback-harness-password"

JAR="$RUN/session.jar"

login() { # login <email> — fresh jar, so every stage re-authenticates
  : > "$JAR"
  local out
  out="$(anon POST /api/auth/password/login "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}")" \
    || fail "stage $STAGE_INDEX: login for $1 failed"
  # A frozen or unverified account answers 200 with a status field instead of a
  # user, and would otherwise look like a successful login with no session.
  printf '%s' "$out" | jq -e 'has("user")' >/dev/null \
    || fail "stage $STAGE_INDEX: login for $1 returned no session: $out"
  # Re-run with the cookie jar attached so the session cookie is captured.
  : > "$JAR"
  curl -fsS --max-time 30 -c "$JAR" -X POST -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}" \
    "http://127.0.0.1:$STAGE_PORT/api/auth/password/login" >/dev/null \
    || fail "stage $STAGE_INDEX: login for $1 failed on the session pass"
}

# ── stage 1: the floor CREATES the database and writes to it ────────────────

open_stage floor

[ -f "$DB" ] || fail "stage 1: the floor binary did not create $DB"
say "the floor binary created the database"

for email in "$EMAIL_A" "$EMAIL_B"; do
  anon POST /api/auth/register \
    "{\"email\":\"$email\",\"password\":\"$PASSWORD\",\"displayName\":\"rollback\"}" >/dev/null \
    || fail "stage 1: registering $email failed"
done
# Verification happens here, under the floor, for both accounts: it is the one
# step that needs an emailed token, and doing it once keeps every later stage on
# password login alone.
for email in "$EMAIL_A" "$EMAIL_B"; do
  # Matched on the line that names THIS address, so the two accounts' tokens
  # cannot be swapped by log ordering.
  tok="$(grep "verify email for $email:" "$STAGE_LOG" \
        | grep -o 'verify-email?token=[0-9a-f]*' | tail -1 | cut -d= -f2)"
  [ -n "$tok" ] || {
    sed -e 's/^/    | /' "$STAGE_LOG" >&2
    fail "stage 1: no verification token logged for $email"
  }
  anon POST /api/auth/email/verify "{\"token\":\"$tok\",\"password\":\"$PASSWORD\"}" >/dev/null \
    || fail "stage 1: verifying $email failed"
done
say "both accounts registered and verified under the floor binary"

login "$EMAIL_A"
USER_A="$(api GET /api/me | jq -er '.user.id')"
readonly USER_A
say "account A user id $USER_A"

expect_traffic 0 "stage 1 opening cumulative traffic"

FILE1="$(upload "$UP1")"
expect_traffic "$((AFTER1_UP + AFTER1_DOWN))" "stage 1 cumulative traffic after one upload"
expect_eq "$(share_count)" 1 "stage 1 share count"

login "$EMAIL_B"
USER_B="$(api GET /api/me | jq -er '.user.id')"
readonly USER_B
say "account B user id $USER_B"

close_stage

# ── fixture setup between stages 1 and 2 ────────────────────────────────────
#
# DIRECT SQLITE, and the only write of its kind here. Account B needs Stripe
# history for its deletion to enqueue a billing cancellation, and there is no
# public endpoint that creates one without a live Stripe account. Both rows are
# exactly what the real flows write; the deletion itself, in stage 2, goes
# through the public HTTP surface like everything else.
#
# The server is stopped, so this touches a file nobody has open.
sqlite3 "$DB" <<SQL || fail "seeding account B's Stripe history failed"
INSERT OR IGNORE INTO stripe_customer_history(user_id, customer_id, created_at)
  VALUES('$USER_B', 'cus_rollbackharness', 1000);
INSERT OR IGNORE INTO billing_purchase_attempts(
    id, user_id, provider, product_id, state, provider_subscription_id, epoch, created_at)
  VALUES('att_rollbackharness', '$USER_B', 'stripe', 'plan_pro', 'resolved',
         'sub_rollbackharness', 1, 1000);
SQL
say "seeded account B's Stripe history (fixture: no public endpoint creates one without a live provider)"

# ── stage 2: HEAD reopens the floor's database and writes ───────────────────

open_stage head

login "$EMAIL_A"
expect_traffic "$((AFTER1_UP + AFTER1_DOWN))" "stage 2 opening cumulative traffic (what stage 1 left)"
expect_eq "$(share_count)" 1 "stage 2 opening share count"

FILE2="$(upload "$UP2")"
expect_traffic "$((AFTER2_UP + AFTER2_DOWN))" "stage 2 cumulative traffic"
expect_eq "$(share_count)" 2 "stage 2 share count"

# The pending billing-deletion journal, written by HEAD through the public
# double-opt-in deletion flow. Nothing here contacts Stripe: the outbox row is
# enqueued locally and only a configured reconciler would ever call out, and
# this instance has no Stripe key at all.
login "$EMAIL_B"
api POST /api/account/delete/request '{}' >/dev/null || fail "stage 2: account B deletion request failed"
DEL_TOKEN="$(token_from_log "$STAGE_LOG" "account/delete/confirm")"
anon POST /api/account/delete/confirm "{\"token\":\"$DEL_TOKEN\"}" >/dev/null \
  || fail "stage 2: account B deletion confirm failed"

OUTBOX_ID="$(sqlite3 "$DB" \
  "SELECT id FROM billing_cancellation_outbox WHERE billing_subject_id='$USER_B' AND state='pending';")"
[ -n "$OUTBOX_ID" ] \
  || fail "stage 2: HEAD's account deletion left no pending billing cancellation for account B, so
       there is no newer journal for the floor to be handed"
readonly OUTBOX_ID
say "HEAD wrote pending billing cancellation $OUTBOX_ID for account B"

OUTBOX_VERSION="$(sqlite3 "$DB" \
  "SELECT json_extract(progress_json, '\$.version') FROM billing_cancellation_outbox WHERE id='$OUTBOX_ID';")"
say "its progress journal is version ${OUTBOX_VERSION:-<none>}"

close_stage

# ── stage 3: THE ROLLBACK — the floor reopens HEAD's migrated database ──────
#
# Two separate proofs, in the order an operator would hit them.

step "stage 3 pre-flight: the floor binary reads HEAD's pending billing journal"

# The operator read path. It opens the database — running every migration on the
# way — decodes the pending progress journal STRICTLY, prints it, and exits. It
# takes no Stripe key and makes no provider call, so this is the newer journal
# shape being parsed by the older binary and nothing else.
FLOOR_JOURNAL_OUT="$RUN/floor-billing-deletion-list.log"
if ! "$FLOOR_BIN" -db "$DB" -billing-deletion-list "$OUTBOX_ID" >"$FLOOR_JOURNAL_OUT" 2>&1; then
  sed -e 's/^/    | /' "$FLOOR_JOURNAL_OUT" >&2
  fail "the floor binary could not read the pending billing-deletion journal HEAD wrote. A
       rollback would strand that account's cancellation."
fi
grep -q "billing deletion evidence: outbox=$OUTBOX_ID subject=$USER_B .* state=pending" "$FLOOR_JOURNAL_OUT" \
  || { sed -e 's/^/    | /' "$FLOOR_JOURNAL_OUT" >&2
       fail "the floor binary did not report the pending journal for $OUTBOX_ID"; }
grep -q "billing deletion resource: kind=subscription id=sub_rollbackharness" "$FLOOR_JOURNAL_OUT" \
  || { sed -e 's/^/    | /' "$FLOOR_JOURNAL_OUT" >&2
       fail "the floor binary decoded the journal but lost its resources, so the shape did not
       survive the rollback intact"; }
say "the floor binary decoded HEAD's journal and reported it pending, resources intact"

open_stage floor

login "$EMAIL_A"
expect_traffic "$((AFTER2_UP + AFTER2_DOWN))" "stage 3 opening cumulative traffic (what HEAD left)"
expect_eq "$(share_count)" 2 "stage 3 opening share count"

# Read back the ciphertext HEAD stored, byte for byte, through the floor binary.
# This is the rollback's real question for stored transfers: a user's existing
# share must still download after the binary goes backwards.
DL2="$RUN/stage3-download.bin"
curl -fsS --max-time 60 -o "$DL2" "http://127.0.0.1:$STAGE_PORT/api/files/$FILE2/blob" \
  || fail "stage 3: the floor binary could not serve the file HEAD stored"
expect_eq "$(wc -c < "$DL2" | tr -d ' ')" "$UP2" "stage 3 downloaded size of HEAD's file"
cmp -s <(head -c "$UP2" /dev/zero | tr '\0' 'C') "$DL2" \
  || fail "stage 3: the ciphertext the floor served differs from what HEAD stored"
say "ok — the floor served HEAD's ciphertext byte for byte"

FILE3="$(upload "$UP3")"
expect_traffic "$((AFTER3_UP + AFTER3_DOWN))" "stage 3 cumulative traffic"
expect_eq "$(share_count)" 3 "stage 3 share count"

close_stage

# ── stage 4: HEAD takes the database back and validates ─────────────────────

open_stage head

login "$EMAIL_A"
expect_traffic "$((AFTER3_UP + AFTER3_DOWN))" "stage 4 opening cumulative traffic (what the floor left)"
expect_eq "$(share_count)" 3 "stage 4 opening share count"

DL3="$RUN/stage4-download.bin"
curl -fsS --max-time 60 -o "$DL3" "http://127.0.0.1:$STAGE_PORT/api/files/$FILE3/blob" \
  || fail "stage 4: HEAD could not serve the file the rolled-back floor stored"
expect_eq "$(wc -c < "$DL3" | tr -d ' ')" "$UP3" "stage 4 downloaded size of the floor's file"
cmp -s <(head -c "$UP3" /dev/zero | tr '\0' 'C') "$DL3" \
  || fail "stage 4: the ciphertext HEAD served differs from what the rolled-back floor stored"
say "ok — HEAD served the rolled-back floor's ciphertext byte for byte"

FILE4="$(upload "$UP4")"
expect_traffic "$((AFTER4_UP + AFTER4_DOWN))" "stage 4 cumulative traffic"
expect_eq "$(share_count)" 4 "stage 4 share count"

# The first file, written by the floor before HEAD ever touched this database,
# must still be listed and readable four stages later.
curl -fsS --max-time 30 "http://127.0.0.1:$STAGE_PORT/api/files/$FILE1/meta" >/dev/null \
  || fail "stage 4: the file the floor wrote in stage 1 is no longer readable"
say "ok — stage 1's file still resolves under HEAD"

# Captured while this stage's server is still up, so the final accounting is
# read from a running binary whose identity the ledger already records — rather
# than from an extra, unplanned fifth server that the ledger checks below would
# then have to make an exception for.
#
# One request, not two: the earlier version read the total and then made a
# SECOND call for the period it belonged to, which is the one place a boundary
# could slip between a number and its own label.
read_usage "final accounting snapshot"
FINAL_HTTP_TRAFFIC="$USAGE_USED"
FINAL_PERIOD="$USAGE_PERIOD"
readonly FINAL_HTTP_TRAFFIC FINAL_PERIOD

close_stage

# ── final invariants ────────────────────────────────────────────────────────

step "final invariants"

# 1. The ledger: four stages, in order, alternating, each served by the binary
#    its role names. This is what a deleted, duplicated or reordered stage
#    breaks first.
rows="$(wc -l < "$LEDGER" | tr -d ' ')"
expect_eq "$rows" 4 "stage ledger row count"

expected_plan="1 floor $FLOOR_SHA
2 head $HEAD_SHA
3 floor $FLOOR_SHA
4 head $HEAD_SHA"
actual_plan="$(awk -F'\t' '{print $1, $2, $4}' "$LEDGER")"
[ "$actual_plan" = "$expected_plan" ] || {
  printf '%s: ledger:\n%s\n%s: wanted:\n%s\n' "$ME" "$actual_plan" "$ME" "$expected_plan" >&2
  fail "the stage ledger is not floor,HEAD,floor,HEAD served by the matching binaries"
}
say "ok — ledger is floor,HEAD,floor,HEAD with the matching binary digests"

# Every stage ran as its own process on its own port: two rows sharing a pid
# would mean one server answered for two stages.
distinct_pids="$(awk -F'\t' '{print $5}' "$LEDGER" | sort -u | wc -l | tr -d ' ')"
expect_eq "$distinct_pids" 4 "distinct server processes across the four stages"

# 2. The accounting, as stage 4's own server reported it. Exact equality: a
#    lost meter and a double-counted meter both fail here, by the amount they
#    were wrong.
expect_eq "$FINAL_HTTP_TRAFFIC" "$((AFTER4_UP + AFTER4_DOWN))" "final cumulative traffic over HTTP"

# 3. The same accounting, read straight out of the table the server reads,
#    split by direction so an upload counted as a download cannot cancel out.
#
#    Summed over EVERY period, deliberately, and this stays that way now that
#    the month-window gate exists. The two are not redundant, they are opposite
#    kinds of check: the gate plus assert_stage_period make the HTTP figures a
#    statement about ONE period and refuse the run if that stops being true,
#    while these totals are period-independent and therefore survive whatever
#    the calendar or the gate does. If the guard above were ever weakened or
#    removed, these would still hold; scoping them to the current period would
#    make the whole accounting depend on the guard being correct.
sql_up="$(sqlite3 "$DB" "SELECT COALESCE(SUM(upload_bytes),0) FROM usage_monthly WHERE user_id='$USER_A';")"
sql_down="$(sqlite3 "$DB" "SELECT COALESCE(SUM(download_bytes),0) FROM usage_monthly WHERE user_id='$USER_A';")"
expect_eq "$sql_up" "$AFTER4_UP" "usage_monthly cumulative upload bytes"
expect_eq "$sql_down" "$AFTER4_DOWN" "usage_monthly cumulative download bytes"

# The HTTP figures above are one period's; these are all periods'. They agree
# only because the run stayed inside the period the gate pinned, which is the
# fact worth printing next to them.
expect_eq "$FINAL_PERIOD" "$STAGE_PERIOD" "final usage period is the period the stages were gated into"

# 4. Every stage's stored file is still there, still the size it was written at.
for pair in "$FILE1:$UP1" "$FILE2:$UP2" "$FILE3:$UP3" "$FILE4:$UP4"; do
  id=${pair%%:*}; want=${pair##*:}
  got="$(sqlite3 "$DB" "SELECT size FROM stored_files WHERE id='$id';")"
  expect_eq "${got:-<missing>}" "$want" "stored size of $id"
done

# 5. The pending journal HEAD wrote is still pending, and still the shape it
#    was: the rollback must not have consumed, rewritten or dropped it.
final_state="$(sqlite3 "$DB" "SELECT state FROM billing_cancellation_outbox WHERE id='$OUTBOX_ID';")"
expect_eq "$final_state" "pending" "billing cancellation state after the round trip"
final_version="$(sqlite3 "$DB" "SELECT json_extract(progress_json,'\$.version') FROM billing_cancellation_outbox WHERE id='$OUTBOX_ID';")"
expect_eq "$final_version" "${OUTBOX_VERSION}" "billing cancellation journal version after the round trip"

# 6. The database itself. A rollback that leaves a structurally damaged file is
#    a data-loss event that every check above could still pass.
integrity="$(sqlite3 "$DB" 'PRAGMA integrity_check;')"
expect_eq "$integrity" "ok" "sqlite integrity_check after the round trip"

step "PASS"
say "floor $FLOOR_COMMIT and HEAD $HEAD_COMMIT round-tripped one database through four stages"
say "cumulative traffic $FINAL_HTTP_TRAFFIC bytes = $AFTER4_UP up + $AFTER4_DOWN down, exact"
say "every usage observation belonged to UTC period $STAGE_PERIOD"

# Last line, deliberately: this is what tells the EXIT trap the run finished
# rather than stopped. Nothing may be added below it.
REACHED_PASS=1
