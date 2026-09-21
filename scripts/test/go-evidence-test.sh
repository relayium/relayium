#!/bin/sh
# Tests for scripts/release/go-evidence.sh — the gate that refuses to let
# auto-release.yml tag `main` unless the GO lane (.github/workflows/go.yml)
# succeeded on the server tree being released — and for the workflow step that
# calls it.
#
# The gate before it (scripts/release/checks-green.sh) proves that whatever ran
# on HEAD is green. It cannot see a lane that never ran: go.yml is
# path-filtered, HEAD is usually a docs commit, and on such a commit the HEAD
# gate passes on the web and hygiene checks alone. The suite is built around
# that, in six layers:
#
#   1. THE HOLE: the HEAD gate, unchanged, passes a commit on which no Go check
#      ran — and the new gate refuses the same situation.
#   2. `judge`, over fixture files: which run counts on one commit, and every
#      way the evidence can be unusable.
#   3. `require`, in real throw-away git repositories against a stub `gh`: where
#      the evidence may sit (E, a later tree-identical commit, HEAD), where it
#      may NOT (an older tree, a commit on the path whose tree differs), the
#      cap, and every read that fails.
#   4. MUTATION: each refusal is removed from a copy of the script in turn, and
#      the input it exists for must then get a different answer. A refusal
#      whose removal nothing notices is not protecting anything.
#   5. THE STEP, extracted from auto-release.yml as it is on disk and run
#      against the stub `gh`, then read: no `|| true`, no continue-on-error,
#      not conditioned on `force`, same condition as the tagging step, before it.
#   6. DRIFT: the script's pathspec list against go.yml's `on.push.paths`, and
#      the two properties of go.yml that make a run-level `success` mean
#      something (no job-level `if:`, no continue-on-error).
#
# Everything is offline: no network, no token, no GitHub. POSIX sh like the
# script under test; the workflow step is run with bash because that is what
# GitHub runs it with. git is the real one: the rule under test is a rule about
# history.
#   sh scripts/test/go-evidence-test.sh
#
# Lives next to its subject and runs in CI — see .github/workflows/repo-hygiene.yml.
#
# SC2016 is off for the whole file: the single-quoted strings here are sed
# programs whose `$runs`, `$sha` and `$total` are jq or shell variables inside
# the script being mutated, and patterns that must reach grep with a literal
# `$` — none of them is a forgotten expansion.
# shellcheck disable=SC2016
set -u

HERE=$(CDPATH='' cd -P -- "$(dirname -- "$0")" && pwd -P)
ROOT="$HERE/../.."
SCRIPT="$ROOT/scripts/release/go-evidence.sh"
HEAD_GATE="$ROOT/scripts/release/checks-green.sh"
WORKFLOW="$ROOT/.github/workflows/auto-release.yml"
GO_WORKFLOW="$ROOT/.github/workflows/go.yml"
HEAD_STEP_NAME='Require the checks on this commit to be green'
STEP_NAME='Require a successful go.yml run for the server tree being released'

TMPROOT=$(mktemp -d "${TMPDIR:-/tmp}/go-evidence-test.XXXXXX")
trap 'rm -rf "$TMPROOT"' EXIT
trap 'rm -rf "$TMPROOT"; exit 1' INT HUP TERM

fail=0
ok() { printf '  ok   %s\n' "$1"; }
bad() {
  printf '  FAIL %s\n' "$1"
  fail=1
}
assert_eq() {
  # assert_eq NAME GOT WANT
  if [ "$2" = "$3" ]; then ok "$1"; else
    bad "$1"
    printf '       want [%s] got [%s]\n' "$3" "$2"
  fi
}
assert_rc() {
  # assert_rc NAME GOT WANT
  if [ "$2" = "$3" ]; then ok "$1"; else
    bad "$1"
    printf '       want rc=%s got rc=%s\n' "$3" "$2"
    printf '%s\n' "${out:-}" | sed 's/^/       > /' | tail -n 8
    sed 's/^/       | /' "$TMPROOT/err" | tail -n 5
  fi
}
assert_has() {
  # assert_has NAME HAYSTACK NEEDLE
  case $2 in
    *"$3"*) ok "$1" ;;
    *)
      bad "$1"
      printf '       want it to contain [%s]\n       got [%s]\n' "$3" "$2"
      ;;
  esac
}
assert_lacks() {
  # assert_lacks NAME HAYSTACK NEEDLE
  case $2 in
    *"$3"*)
      bad "$1"
      printf '       must not contain [%s]\n       got [%s]\n' "$3" "$2"
      ;;
    *) ok "$1" ;;
  esac
}

for tool in jq bash git; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "go-evidence-test.sh: $tool is required and was not found" >&2
    exit 1
  fi
done
: >"$TMPROOT/err"

# The repositories below must not depend on whoever runs the suite: no global
# config (signing, hooks, templates), a fixed identity, and dates that move
# forward one second per commit so that every ordering is deterministic.
GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_NOSYSTEM=1
GIT_AUTHOR_NAME='release-gate-test'
GIT_AUTHOR_EMAIL=test@example.invalid
GIT_COMMITTER_NAME='release-gate-test'
GIT_COMMITTER_EMAIL=test@example.invalid
export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
clock=1790000000
tick() {
  clock=$((clock + 1))
  GIT_AUTHOR_DATE="$clock +0000"
  GIT_COMMITTER_DATE="$clock +0000"
  export GIT_AUTHOR_DATE GIT_COMMITTER_DATE
}

# ---------------------------------------------------------------------------
# Fixture helpers. A page is what the API returns per request:
#   { "total_count": N, "workflow_runs": [ … ] }
# and a fixture FILE is what `gh api --paginate` writes for this endpoint — one
# such document per page, back to back, nothing merged.
# ---------------------------------------------------------------------------
GO_PATH='.github/workflows/go.yml'
# The commit the offline `judge` fixtures are about, and one they are not.
Q=1111111111111111111111111111111111111111
OTHER=2222222222222222222222222222222222222222
T1='2026-09-20T10:00:00Z'
T2='2026-09-20T11:00:00Z'
T3='2026-09-20T12:00:00Z'

wr() {
  # wr ID SHA EVENT STATUS CONCLUSION STARTED [CREATED] [PATH]
  # CONCLUSION: a word, or `null`. CREATED defaults to STARTED.
  _created=${7:-$6}
  _path=${8:-$GO_PATH}
  if [ "$5" = null ]; then _c=null; else _c="\"$5\""; fi
  printf '{"id":%s,"name":"go","head_sha":"%s","head_branch":"main","path":"%s","event":"%s","status":"%s","conclusion":%s,"run_attempt":1,"created_at":"%s","run_started_at":"%s"}' \
    "$1" "$2" "$_path" "$3" "$4" "$_c" "$_created" "$6"
}
page() {
  # page TOTAL RUN_JSON...
  _total=$1
  shift
  _runs=''
  for _r in "$@"; do
    if [ -z "$_runs" ]; then _runs=$_r; else _runs="$_runs,$_r"; fi
  done
  printf '{"total_count":%s,"workflow_runs":[%s]}\n' "$_total" "$_runs"
}
fx() { printf '%s\n' "$TMPROOT/fx-$1.json"; }

page 1 "$(wr 10 "$Q" push completed success "$T1")" >"$(fx push-success)"
page 1 "$(wr 10 "$Q" workflow_dispatch completed success "$T1")" >"$(fx dispatch-success)"
page 0 >"$(fx no-runs)"
page 1 "$(wr 10 "$Q" push in_progress null "$T1")" >"$(fx in-progress)"
page 1 "$(wr 10 "$Q" push queued null "$T1")" >"$(fx queued)"
for conclusion in failure cancelled timed_out action_required stale startup_failure neutral skipped; do
  page 1 "$(wr 10 "$Q" push completed "$conclusion" "$T1")" >"$(fx "c-$conclusion")"
done
# A conclusion without a finished status does not happen — and is not green if
# it ever does.
page 1 "$(wr 10 "$Q" push in_progress success "$T1")" >"$(fx success-not-completed)"

# Several runs on one commit: the newest decides.
page 2 "$(wr 10 "$Q" push completed failure "$T1")" "$(wr 11 "$Q" workflow_dispatch completed success "$T2")" >"$(fx older-failure-newer-success)"
page 2 "$(wr 10 "$Q" push completed cancelled "$T1")" "$(wr 11 "$Q" workflow_dispatch completed success "$T2")" >"$(fx older-cancelled-newer-success)"
page 2 "$(wr 10 "$Q" push completed success "$T1")" "$(wr 11 "$Q" workflow_dispatch completed failure "$T2")" >"$(fx older-success-newer-failure)"
page 2 "$(wr 10 "$Q" push completed success "$T1")" "$(wr 11 "$Q" workflow_dispatch in_progress null "$T2")" >"$(fx older-success-newer-in-progress)"
# The API lists newest first; the decision must not depend on the order.
page 2 "$(wr 11 "$Q" workflow_dispatch completed failure "$T2")" "$(wr 10 "$Q" push completed success "$T1")" >"$(fx newer-failure-listed-first)"
# A RE-RUN keeps its id and created_at and gets a new run_started_at. Run 10 was
# created first, but it was re-run LAST, after run 11 had succeeded, and that
# attempt failed. By id or by created_at run 11 looks newer; it is not.
page 2 "$(wr 11 "$Q" workflow_dispatch completed success "$T2" "$T2")" "$(wr 10 "$Q" push completed failure "$T3" "$T1")" >"$(fx rerun-of-older-id-fails-last)"
# Same start second: created_at, then the id, break the tie.
page 2 "$(wr 10 "$Q" push completed success "$T2" "$T1")" "$(wr 11 "$Q" push completed failure "$T2" "$T2")" >"$(fx tie-created-at)"
page 2 "$(wr 10 "$Q" push completed success "$T2")" "$(wr 11 "$Q" push completed failure "$T2")" >"$(fx tie-id)"
# The newer run is on page 2: once red, once green.
{
  page 2 "$(wr 10 "$Q" push completed success "$T1")"
  page 2 "$(wr 11 "$Q" push completed failure "$T2")"
} >"$(fx newer-failure-on-p2)"
{
  page 2 "$(wr 10 "$Q" push completed failure "$T1")"
  page 2 "$(wr 11 "$Q" push completed success "$T2")"
} >"$(fx green-2p)"

# Events that never count.
page 1 "$(wr 10 "$Q" pull_request completed success "$T1")" >"$(fx pull-request-only)"
page 1 "$(wr 10 "$Q" schedule completed success "$T1")" >"$(fx schedule-only)"
# A green pull_request run must not outvote, or hide, a red push run.
page 2 "$(wr 10 "$Q" push completed failure "$T1")" "$(wr 11 "$Q" pull_request completed success "$T2")" >"$(fx push-failure-newer-pr-success)"
page 2 "$(wr 10 "$Q" push completed success "$T1")" "$(wr 11 "$Q" pull_request completed failure "$T2")" >"$(fx push-success-newer-pr-failure)"

# Evidence for a different commit, and of a different workflow.
page 1 "$(wr 10 "$OTHER" push completed success "$T1")" >"$(fx other-sha)"
page 2 "$(wr 10 "$Q" push completed success "$T1")" "$(wr 11 "$OTHER" push completed success "$T2")" >"$(fx mixed-sha)"
page 1 "$(wr 10 "$Q" push completed success "$T1" "$T1" .github/workflows/web.yml)" >"$(fx other-path)"
page 1 "$(wr 10 "$Q" push completed success "$T1" "$T1" '.github/workflows/go.yml@refs/heads/main')" >"$(fx path-with-ref)"

# Pages that do not add up.
page 2 "$(wr 10 "$Q" push completed success "$T1")" >"$(fx dropped-page)"
page 1 "$(wr 10 "$Q" push completed success "$T1")" "$(wr 11 "$Q" push completed success "$T2")" >"$(fx surplus)"
{
  page 2 "$(wr 10 "$Q" push completed success "$T2")"
  page 3 "$(wr 11 "$Q" push completed success "$T1")"
} >"$(fx total-disagrees)"
# Pages shifted under the reader: run 10 arrives twice, the run that failed
# never does, and the COUNT still adds up. Only the ids give it away.
{
  page 2 "$(wr 10 "$Q" push completed success "$T2")"
  page 2 "$(wr 10 "$Q" push completed success "$T2")"
} >"$(fx shifted-page)"

# What a failed read leaves behind.
: >"$(fx empty-file)"
printf '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n</html>\r\n' >"$(fx html)"
printf '{"total_count":1,"workflow_runs":[{"id":10,"head_sha":"%s","status":"completed","conclu' "$Q" >"$(fx truncated)"
{
  page 2 "$(wr 10 "$Q" push completed success "$T1")"
  printf '{"total_count":2,"workflow_runs":[{"id":11,"head_sha":"%s","status":"compl' "$Q"
} >"$(fx truncated-p2)"
printf '{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest","status":"401"}\n' >"$(fx api-error)"
printf '{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}\n' >"$(fx api-404)"
printf '{"workflow_runs":[%s]}\n' "$(wr 10 "$Q" push completed success "$T1")" >"$(fx no-total)"
printf '{"total_count":1}\n' >"$(fx no-array)"
printf '{"total_count":"1","workflow_runs":[%s]}\n' "$(wr 10 "$Q" push completed success "$T1")" >"$(fx string-total)"
printf '[]\n' >"$(fx array-root)"
printf 'null\n' >"$(fx null-root)"
printf '{"total_count":1,"workflow_runs":["go"]}\n' >"$(fx run-not-object)"
printf '{"total_count":1,"workflow_runs":[{"id":10,"path":"%s","event":"push","status":"completed","conclusion":"success","created_at":"%s","run_started_at":"%s"}]}\n' "$GO_PATH" "$T1" "$T1" >"$(fx run-no-sha)"
printf '{"total_count":1,"workflow_runs":[{"head_sha":"%s","path":"%s","event":"push","status":"completed","conclusion":"success","created_at":"%s","run_started_at":"%s"}]}\n' "$Q" "$GO_PATH" "$T1" "$T1" >"$(fx run-no-id)"
printf '{"total_count":1,"workflow_runs":[{"id":10,"head_sha":"%s","path":"%s","status":"completed","conclusion":"success","created_at":"%s","run_started_at":"%s"}]}\n' "$Q" "$GO_PATH" "$T1" "$T1" >"$(fx run-no-event)"
# Timestamps that cannot be compared as strings cannot decide which run is newest.
page 1 "$(wr 10 "$Q" push completed success 'yesterday')" >"$(fx bad-started-at)"
page 1 "$(wr 10 "$Q" push completed success "$T1" '2026-09-20T10:00:00+04:00')" >"$(fx offset-created-at)"

judge() {
  # judge FIXTURE_NAME [SCRIPT] [SHA] → sets $out and $rc; stderr in $TMPROOT/err
  out=$(sh "${2:-$SCRIPT}" judge "${3:-$Q}" "$(fx "$1")" 2>"$TMPROOT/err")
  rc=$?
}

# ---------------------------------------------------------------------------
# A stub `gh`. It answers the one call the gate makes — the go.yml runs for one
# head_sha — from a directory: SHA.json is the response (absent: the API's real
# answer for a commit with no run, `total_count` 0), SHA.fail is a response
# after which gh exits 1 the way it does on a transport or HTTP error. Anything
# else the gate might ask is an error, as is asking without --paginate.
# ---------------------------------------------------------------------------
STUB_BIN="$TMPROOT/bin"
mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/gh" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >>"$GH_STUB_LOG"
url=''
paginate=0
for a in "$@"; do
  case $a in
    --paginate) paginate=1 ;;
    repos/*) url=$a ;;
  esac
done
case $url in
  "repos/relayium/relayium/actions/workflows/go.yml/runs?head_sha="*"&per_page=100") ;;
  *)
    echo "stub gh: unexpected call: $*" >&2
    exit 97
    ;;
esac
if [ "$paginate" -ne 1 ]; then
  echo "stub gh: called without --paginate: $*" >&2
  exit 98
fi
sha=${url#*head_sha=}
sha=${sha%%&*}
if [ -f "$GH_STUB_DIR/$sha.fail" ]; then
  cat "$GH_STUB_DIR/$sha.fail"
  echo 'gh: HTTP 502' >&2
  exit 1
fi
if [ -f "$GH_STUB_DIR/$sha.json" ]; then
  cat "$GH_STUB_DIR/$sha.json"
else
  printf '{"total_count":0,"workflow_runs":[]}\n'
fi
STUB
chmod +x "$STUB_BIN/gh"

stub_n=0
new_stub() {
  # new_stub → sets $stub to a fresh, empty response directory
  stub_n=$((stub_n + 1))
  stub="$TMPROOT/stub-$stub_n"
  mkdir -p "$stub"
}
green_on() {
  # green_on DIR SHA
  page 1 "$(wr 500 "$2" push completed success "$T1")" >"$1/$2.json"
}
req() {
  # req REPO REV STUB_DIR [SCRIPT] → sets $out, $rc, $ghlog, $asked
  : >"$TMPROOT/ghlog"
  out=$(
    cd "$1" &&
      PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$3" GH_STUB_LOG="$TMPROOT/ghlog" \
        GH_TOKEN=unused GITHUB_REPOSITORY=relayium/relayium \
        sh "${4:-$SCRIPT}" require "$2" 2>"$TMPROOT/err"
  )
  rc=$?
  ghlog=$(cat "$TMPROOT/ghlog")
  asked=$(grep -c . "$TMPROOT/ghlog")
}

# ---------------------------------------------------------------------------
# Repositories.
# ---------------------------------------------------------------------------
commit_file() {
  # commit_file REPO PATH CONTENT MESSAGE → prints the new commit id
  mkdir -p "$1/$(dirname -- "$2")"
  printf '%s\n' "$3" >"$1/$2"
  tick
  git -C "$1" add -- "$2" >/dev/null
  git -C "$1" commit -q -m "$4" >/dev/null
  git -C "$1" rev-parse HEAD
}

# LIN — the shape main really has: a server change, then docs commits, one of
# which was the tip of the push (that is where GitHub put the go.yml run).
#
#   A (server v1 + go.yml) - B (docs) - S (server v2) - D1 - D2 - D3
#                                       E                   ^tip  ^HEAD
LIN="$TMPROOT/lin"
git init -q -b main "$LIN"
mkdir -p "$LIN/server" "$LIN/.github/workflows"
printf 'package main // v1\n' >"$LIN/server/main.go"
printf 'name: go\n' >"$LIN/.github/workflows/go.yml"
tick
git -C "$LIN" add -A >/dev/null
git -C "$LIN" commit -q -m 'server v1' >/dev/null
LIN_A=$(git -C "$LIN" rev-parse HEAD)
LIN_B=$(commit_file "$LIN" docs/a.md one 'docs')
LIN_S=$(commit_file "$LIN" server/main.go 'package main // v2' 'server v2')
LIN_D1=$(commit_file "$LIN" docs/a.md two 'docs')
LIN_D2=$(commit_file "$LIN" web/x.ts three 'web')
LIN_D3=$(commit_file "$LIN" docs/a.md four 'docs')

# OURS — a commit ON the path from E to HEAD whose server tree is NOT HEAD's.
# C changes server/ on a side branch; the merge M keeps main's side (`-s ours`),
# so M is identical to D and git's history simplification walks M → D → S.
#
#   X - S (E) - D ------- M (HEAD, server == S)
#         \              /
#          C (server v3)
OURS="$TMPROOT/ours"
git init -q -b main "$OURS"
commit_file "$OURS" server/main.go 'package main // v1' 'server v1' >/dev/null
OURS_S=$(commit_file "$OURS" server/main.go 'package main // v2' 'server v2')
git -C "$OURS" checkout -q -b side
OURS_C=$(commit_file "$OURS" server/main.go 'package main // v3, abandoned' 'server v3')
git -C "$OURS" checkout -q main
OURS_D=$(commit_file "$OURS" docs/a.md one 'docs')
tick
git -C "$OURS" merge -q -s ours -m 'merge side, keeping main' side >/dev/null 2>&1
OURS_M=$(git -C "$OURS" rev-parse HEAD)

# LONG — more commits between E and HEAD than the gate will look at: E and 120
# commits that do not touch the Go lane.
LONG="$TMPROOT/long"
git init -q -b main "$LONG"
LONG_E=$(commit_file "$LONG" server/main.go 'package main // v1' 'server v1')
long_tree=$(git -C "$LONG" rev-parse 'HEAD^{tree}')
long_parent=$LONG_E
printf '%s\n' "$LONG_E" >"$TMPROOT/long-commits"
i=0
while [ "$i" -lt 120 ]; do
  tick
  long_parent=$(git -C "$LONG" commit-tree -p "$long_parent" -m "docs $i" "$long_tree")
  printf '%s\n' "$long_parent" >>"$TMPROOT/long-commits"
  i=$((i + 1))
done
git -C "$LONG" reset -q --hard "$long_parent"
LONG_HEAD=$long_parent
LONG_99=$(sed -n 99p "$TMPROOT/long-commits")   # the last of the 99 oldest
LONG_100=$(sed -n 100p "$TMPROOT/long-commits") # the first one never looked at
LONG_105=$(sed -n 105p "$TMPROOT/long-commits")

# SHALLOW — LIN without its history.
SHALLOW="$TMPROOT/shallow"
git clone -q --depth 1 "file://$LIN" "$SHALLOW" >/dev/null 2>&1
SHALLOW_HEAD=$(git -C "$SHALLOW" rev-parse HEAD)

if [ -n "$LIN_D3" ] && [ -n "$OURS_M" ] && [ "$OURS_M" != "$OURS_D" ] && [ -n "$LONG_105" ] && [ "$SHALLOW_HEAD" = "$LIN_D3" ]; then
  ok 'the test repositories were built'
else
  bad 'the test repositories were built'
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. The hole.
# ---------------------------------------------------------------------------
echo 'the hole: the HEAD gate cannot see a lane that never ran'
# What a docs-only push tip looks like to the HEAD gate (the real one was
# 7d3b2923, 29 runs): web, hygiene and docs checks, all green — and nothing from
# go.yml, because go.yml was never selected for this commit.
cr() { printf '{"id":%s,"name":"%s","status":"completed","conclusion":"success"}' "$1" "$2"; }
printf '{"total_count":5,"check_runs":[%s,%s,%s,%s,%s]}\n' \
  "$(cr 1 web-build)" "$(cr 2 vitest)" "$(cr 3 repo-hygiene)" "$(cr 4 docs-links)" "$(cr 5 test)" >"$TMPROOT/head-green-no-go.json"
out=$(sh "$HEAD_GATE" "$TMPROOT/head-green-no-go.json" 2>"$TMPROOT/err")
assert_rc 'HEAD gate (e93ca52c, unchanged): green checks on HEAD, the Go lane never ran → it PASSES' "$?" 0
assert_has 'and reports only what it saw' "$out" '5 check runs green'
new_stub
req "$LIN" "$LIN_D3" "$stub"
assert_rc 'NEW gate: the same situation — no go.yml run anywhere from E to HEAD → it REFUSES' "$rc" 1

# ---------------------------------------------------------------------------
# 2. judge.
# ---------------------------------------------------------------------------
echo 'judge: green'
judge push-success
assert_rc 'a successful push run passes' "$rc" 0
assert_has 'the verdict names the run' "$out" 'go.yml run 10 (push, attempt 1) completed/success'
judge dispatch-success
assert_rc 'a successful workflow_dispatch run passes' "$rc" 0
judge older-failure-newer-success
assert_rc 'an older failed run and a NEWER successful one on the same commit pass' "$rc" 0
assert_has 'and the verdict says the older one did not count' "$out" 'go.yml run 11 (workflow_dispatch, attempt 1) completed/success; the 1 older run(s) on this commit do not count'
judge older-cancelled-newer-success
assert_rc 'an older cancelled run and a newer successful one pass' "$rc" 0
judge green-2p
assert_rc 'the newer success may be on page 2' "$rc" 0
judge push-success-newer-pr-failure
assert_rc 'a red pull_request run does not count against a green push run either' "$rc" 0

echo 'judge: not green'
judge no-runs
assert_rc 'no run at all refuses' "$rc" 1
assert_eq 'and says so' "$out" 'no go.yml run'
judge in-progress
assert_rc 'a run in progress refuses' "$rc" 1
assert_eq 'and is named as pending' "$out" 'newest go.yml run 10 (push) is in_progress/pending'
judge queued
assert_rc 'a queued run refuses' "$rc" 1
for conclusion in failure cancelled timed_out action_required stale startup_failure neutral skipped; do
  judge "c-$conclusion"
  assert_rc "conclusion [$conclusion] refuses" "$rc" 1
  assert_eq "conclusion [$conclusion] is named" "$out" "newest go.yml run 10 (push) is completed/$conclusion"
done
judge success-not-completed
assert_rc 'a success conclusion on a run that is not completed refuses' "$rc" 1
judge older-success-newer-failure
assert_rc 'an older success and a NEWER failure on the same commit refuse' "$rc" 1
assert_has 'naming the newer run' "$out" 'newest go.yml run 11 (workflow_dispatch) is completed/failure'
judge older-success-newer-in-progress
assert_rc 'an older success and a newer run still in progress refuse' "$rc" 1
judge newer-failure-listed-first
assert_rc 'the order of the list does not decide' "$rc" 1
judge newer-failure-on-p2
assert_rc 'a newer failure that exists only on page 2 refuses' "$rc" 1
judge rerun-of-older-id-fails-last
assert_rc 'a re-run (older id, older created_at, NEWEST run_started_at) that failed refuses' "$rc" 1
assert_has 'naming the re-run' "$out" 'newest go.yml run 10 (push) is completed/failure'
judge tie-created-at
assert_rc 'same run_started_at: the later created_at decides' "$rc" 1
judge tie-id
assert_rc 'same run_started_at and created_at: the higher id decides' "$rc" 1

echo 'judge: only push and workflow_dispatch count'
judge pull-request-only
assert_rc 'a successful pull_request run is not evidence (it tested the merge ref, not this commit)' "$rc" 1
assert_has 'and the refusal names the event it ignored' "$out" 'no push or workflow_dispatch go.yml run (1 run(s) of other events do not count: pull_request)'
judge schedule-only
assert_rc 'nor is any other event' "$rc" 1
judge push-failure-newer-pr-success
assert_rc 'a newer green pull_request run does not hide a red push run' "$rc" 1
assert_has 'the push run is the one named' "$out" 'newest go.yml run 10 (push) is completed/failure'

echo 'judge: unusable evidence refuses (never "there is a green run")'
for f in \
  'empty-file|the workflow-runs response is empty' \
  'html|not valid JSON' \
  'truncated|not valid JSON' \
  'truncated-p2|not valid JSON' \
  'api-error|no numeric total_count' \
  'api-404|no numeric total_count' \
  'no-total|no numeric total_count' \
  'string-total|no numeric total_count' \
  'no-array|no workflow_runs array' \
  'array-root|not a JSON object' \
  'null-root|not a JSON object' \
  'run-not-object|no usable id, head_sha' \
  'run-no-sha|no usable id, head_sha' \
  'run-no-id|no usable id, head_sha' \
  'run-no-event|no usable id, head_sha' \
  'bad-started-at|no usable id, head_sha' \
  'offset-created-at|no usable id, head_sha' \
  'dropped-page|examined 1 workflow runs across 1 page(s) but the API reports total_count 2' \
  'surplus|examined 2 workflow runs across 1 page(s) but the API reports total_count 1' \
  'total-disagrees|pages disagree on total_count (2, 3)' \
  'shifted-page|appears more than once' \
  "other-sha|contains a run for $OTHER, not for the queried commit $Q" \
  "mixed-sha|contains a run for $OTHER, not for the queried commit $Q" \
  'other-path|contains a run of .github/workflows/web.yml, not of .github/workflows/go.yml' \
  'path-with-ref|not of .github/workflows/go.yml'; do
  judge "${f%%|*}"
  assert_rc "[${f%%|*}] refuses as unusable" "$rc" 3
  assert_has "[${f%%|*}] says why" "$out" "${f#*|}"
done
# The same green file, asked about another commit.
judge push-success "$SCRIPT" "$OTHER"
assert_rc 'green evidence presented for a DIFFERENT commit refuses as unusable' "$rc" 3

out=$(sh "$SCRIPT" judge "$Q" "$TMPROOT/does-not-exist.json" 2>"$TMPROOT/err")
assert_rc 'a missing file refuses' "$?" 3
out=$(sh "$SCRIPT" judge "$Q" "$TMPROOT" 2>"$TMPROOT/err")
assert_rc 'a directory refuses' "$?" 3
out=$(sh "$SCRIPT" judge 1111111 "$(fx push-success)" 2>"$TMPROOT/err")
assert_rc 'an abbreviated commit id refuses (a prefix is not an identity)' "$?" 3
out=$(sh "$SCRIPT" judge "$Q" 2>"$TMPROOT/err")
assert_rc 'a missing argument is a usage error, not a pass' "$?" 2
out=$(sh "$SCRIPT" 2>"$TMPROOT/err")
assert_rc 'no command is a usage error, not a pass' "$?" 2
out=$(sh "$SCRIPT" approve 2>"$TMPROOT/err")
assert_rc 'an unknown command is a usage error, not a pass' "$?" 2
mkdir -p "$TMPROOT/nojq"
for t in sh mktemp rm head cat; do
  tp=$(command -v "$t") && ln -s "$tp" "$TMPROOT/nojq/$t"
done
out=$(PATH="$TMPROOT/nojq" sh "$SCRIPT" judge "$Q" "$(fx push-success)" 2>"$TMPROOT/err")
assert_rc 'a runner without jq refuses' "$?" 3

# ---------------------------------------------------------------------------
# 3. require.
# ---------------------------------------------------------------------------
echo 'require: where the evidence may be'
new_stub
green_on "$stub" "$LIN_S"
req "$LIN" "$LIN_D3" "$stub"
assert_rc 'a successful run on E passes' "$rc" 0
assert_has 'the verdict names the commit the run is on' "$out" "completed/success on $LIN_S"
assert_has 'and E, and how far it looked' "$out" "E = $LIN_S; 1 of 4 candidate(s) examined, 0 skipped"
assert_eq 'it stopped at the first green candidate' "$asked" 1

# The real shape (E = e48c0d43 had no run; the push tip fcc538bf had it).
new_stub
green_on "$stub" "$LIN_D2"
req "$LIN" "$LIN_D3" "$stub"
assert_rc 'a successful run on a LATER tree-identical commit, none on E, passes' "$rc" 0
assert_has 'the verdict names that commit' "$out" "completed/success on $LIN_D2"
assert_has 'and how far it looked' "$out" '3 of 4 candidate(s) examined'
assert_eq 'E was asked about first' "$(printf '%s\n' "$ghlog" | sed -n 1p | grep -c "head_sha=$LIN_S&")" 1
assert_has 'every read asks for every page' "$ghlog" '--paginate'
assert_has 'of the go.yml workflow runs' "$ghlog" 'repos/relayium/relayium/actions/workflows/go.yml/runs?head_sha='

new_stub
green_on "$stub" "$LIN_D3"
req "$LIN" "$LIN_D3" "$stub"
assert_rc 'a successful run on HEAD itself (what the remedy produces) passes' "$rc" 0
assert_eq 'after asking about every older candidate' "$asked" 4

echo 'require: E == HEAD'
new_stub
green_on "$stub" "$LIN_S"
req "$LIN" "$LIN_S" "$stub"
assert_rc 'E == HEAD with a successful run passes' "$rc" 0
assert_has 'one candidate' "$out" '1 of 1 candidate(s) examined'
new_stub
req "$LIN" "$LIN_S" "$stub"
assert_rc 'E == HEAD and the Go lane never ran refuses' "$rc" 1
new_stub
page 1 "$(wr 500 "$LIN_S" push in_progress null "$T1")" >"$stub/$LIN_S.json"
req "$LIN" "$LIN_S" "$stub"
assert_rc 'E == HEAD and the run is still in progress refuses' "$rc" 1

echo 'require: no evidence'
new_stub
req "$LIN" "$LIN_D3" "$stub"
assert_rc 'no go.yml run on any candidate refuses' "$rc" 1
assert_has 'the refusal names HEAD' "$out" "no successful go.yml run covers the server tree of $LIN_D3"
assert_has 'and E, as the last change to the lane inputs' "$out" "E = $LIN_S is the last commit that changed the Go lane inputs"
assert_has 'and how many commits it looked at' "$out" '4 commit(s) from E to HEAD, 4 considered, 4 examined, 0 skipped'
for c in "$LIN_S" "$LIN_D1" "$LIN_D2" "$LIN_D3"; do
  assert_has 'and what it found on each of them' "$out" "$c: no go.yml run"
done
assert_has 'and the remedy' "$out" 'remedy: dispatch go.yml on main'
assert_eq 'every candidate was asked about' "$asked" 4

new_stub
page 1 "$(wr 500 "$LIN_D2" push in_progress null "$T1")" >"$stub/$LIN_D2.json"
req "$LIN" "$LIN_D3" "$stub"
assert_rc 'the only run is still in progress: refuses' "$rc" 1
assert_has 'and says where and what' "$out" "$LIN_D2: newest go.yml run 500 (push) is in_progress/pending"
new_stub
page 1 "$(wr 500 "$LIN_D2" push completed failure "$T1")" >"$stub/$LIN_D2.json"
req "$LIN" "$LIN_D3" "$stub"
assert_rc 'the only run failed: refuses' "$rc" 1
assert_has 'and says where and what' "$out" "$LIN_D2: newest go.yml run 500 (push) is completed/failure"
new_stub
page 1 "$(wr 500 "$LIN_D2" push completed cancelled "$T1")" >"$stub/$LIN_D2.json"
req "$LIN" "$LIN_D3" "$stub"
assert_rc 'the only run was cancelled: refuses' "$rc" 1
new_stub
page 1 "$(wr 500 "$LIN_D2" pull_request completed success "$T1")" >"$stub/$LIN_D2.json"
req "$LIN" "$LIN_D3" "$stub"
assert_rc 'the only run is a pull_request run: refuses' "$rc" 1
assert_has 'and says it did not count' "$out" "$LIN_D2: no push or workflow_dispatch go.yml run"

# A red candidate does not end the search; a later tree-identical one may be green.
new_stub
page 1 "$(wr 500 "$LIN_S" push completed failure "$T1")" >"$stub/$LIN_S.json"
green_on "$stub" "$LIN_D3"
req "$LIN" "$LIN_D3" "$stub"
assert_rc 'a failed run on E and a successful run on HEAD (the remedy) pass' "$rc" 0
# …but the newest-run rule is per commit: success then a NEWER failure on the
# same commit makes that commit fail, and nothing else is green.
new_stub
page 2 "$(wr 500 "$LIN_D2" push completed success "$T1")" "$(wr 501 "$LIN_D2" workflow_dispatch completed failure "$T2")" >"$stub/$LIN_D2.json"
req "$LIN" "$LIN_D3" "$stub"
assert_rc 'an older success and a NEWER failure on the only commit with runs: refuses' "$rc" 1
new_stub
page 2 "$(wr 500 "$LIN_D2" push completed failure "$T1")" "$(wr 501 "$LIN_D2" workflow_dispatch completed success "$T2")" >"$stub/$LIN_D2.json"
req "$LIN" "$LIN_D3" "$stub"
assert_rc 'an older failure and a NEWER success on the same commit: passes' "$rc" 0

echo 'require: where the evidence may NOT be'
# Green runs on the OLD server tree prove nothing about this one.
new_stub
green_on "$stub" "$LIN_A"
green_on "$stub" "$LIN_B"
req "$LIN" "$LIN_D3" "$stub"
assert_rc 'successful runs only on commits BEFORE E (another server tree) refuse' "$rc" 1
assert_lacks 'and those commits were never even asked about' "$ghlog" "$LIN_A"
assert_lacks 'neither of them' "$ghlog" "$LIN_B"
# A commit on the path from E to HEAD with a different server tree.
new_stub
green_on "$stub" "$OURS_C"
req "$OURS" "$OURS_M" "$stub"
assert_rc 'a successful run on a commit from E to HEAD that is NOT tree-identical refuses' "$rc" 1
assert_has 'E is the last change that survives in HEAD' "$out" "E = $OURS_S is the last commit"
assert_has 'the commit is reported as skipped' "$out" "$OURS_C: skipped: NOT tree-identical to HEAD"
assert_has 'and counted' "$out" '4 commit(s) from E to HEAD, 4 considered, 3 examined, 1 skipped'
assert_lacks 'and never asked about' "$ghlog" "$OURS_C"
new_stub
green_on "$stub" "$OURS_D"
req "$OURS" "$OURS_M" "$stub"
assert_rc 'in the same history, a run on a tree-identical commit passes' "$rc" 0
# Evidence for a different sha, served for a candidate.
new_stub
page 1 "$(wr 500 "$LIN_A" push completed success "$T1")" >"$stub/$LIN_S.json"
req "$LIN" "$LIN_D3" "$stub"
assert_rc 'a response whose run is for a DIFFERENT commit refuses as unusable' "$rc" 3
assert_has 'and says which' "$out" "contains a run for $LIN_A, not for the queried commit $LIN_S"

echo 'require: the cap'
new_stub
green_on "$stub" "$LONG_105"
req "$LONG" "$LONG_HEAD" "$stub"
assert_rc 'evidence only beyond the 99 oldest of 121 candidates refuses' "$rc" 1
assert_has 'and says the walk was cut short' "$out" 'CUT SHORT by the cap of 100 candidates: only the 99 oldest commits and HEAD were considered'
assert_has 'with the numbers' "$out" '121 commit(s) from E to HEAD, 100 considered, 100 examined, 0 skipped'
assert_eq 'exactly 100 reads were made' "$asked" 100
assert_has 'the 99th oldest was asked about' "$ghlog" "head_sha=$LONG_99&"
assert_lacks 'the 100th was not' "$ghlog" "head_sha=$LONG_100&"
assert_has 'HEAD was' "$ghlog" "head_sha=$LONG_HEAD&"
new_stub
green_on "$stub" "$LONG_HEAD"
req "$LONG" "$LONG_HEAD" "$stub"
assert_rc 'beyond the cap HEAD is still a candidate, so the remedy still works' "$rc" 0
new_stub
green_on "$stub" "$LONG_99"
req "$LONG" "$LONG_HEAD" "$stub"
assert_rc 'evidence on the 99th oldest passes' "$rc" 0

echo 'require: reads that fail refuse (they are not "no run")'
new_stub
: >"$stub/$LIN_S.fail"
green_on "$stub" "$LIN_D2"
req "$LIN" "$LIN_D3" "$stub"
assert_rc 'a read that fails with no answer refuses, even though a later candidate is green' "$rc" 3
assert_has 'and says which read' "$out" "could not read the go.yml runs for $LIN_S"
new_stub
green_on "$stub" "$LIN_S"
mv "$stub/$LIN_S.json" "$stub/$LIN_S.fail"
req "$LIN" "$LIN_D3" "$stub"
assert_rc 'a read that dies AFTER a complete green page refuses' "$rc" 3
for f in api-error html truncated truncated-p2 empty-file; do
  new_stub
  cp "$(fx "$f")" "$stub/$LIN_S.json"
  green_on "$stub" "$LIN_D2"
  req "$LIN" "$LIN_D3" "$stub"
  assert_rc "a [$f] response for one candidate refuses, even though a later candidate is green" "$rc" 3
  assert_has "[$f] names the commit" "$out" "[commit $LIN_S]"
done
new_stub
page 2 "$(wr 500 "$LIN_S" push completed success "$T1")" >"$stub/$LIN_S.json"
req "$LIN" "$LIN_D3" "$stub"
assert_rc 'a page silently missing from a "successful" read refuses' "$rc" 3
assert_has 'and says which evidence was short' "$out" 'examined 1 workflow runs across 1 page(s) but the API reports total_count 2'

echo 'require: preconditions'
new_stub
green_on "$stub" "$SHALLOW_HEAD"
req "$SHALLOW" HEAD "$stub"
assert_rc 'a shallow clone refuses (E cannot be determined), even with a green run on HEAD' "$rc" 3
assert_has 'and says so' "$out" 'the clone is shallow'
assert_eq 'before asking GitHub anything' "$asked" 0
new_stub
req "$LIN" does-not-exist "$stub"
assert_rc 'a revision that does not exist refuses' "$rc" 3
NOLANE="$TMPROOT/nolane"
git init -q -b main "$NOLANE"
commit_file "$NOLANE" docs/a.md one 'docs' >/dev/null
new_stub
req "$NOLANE" HEAD "$stub"
assert_rc 'a history that never touched the Go lane inputs refuses' "$rc" 3
assert_has 'and says so' "$out" "ever changed the Go lane's inputs"
new_stub
green_on "$stub" "$LIN_S"
out=$(cd "$LIN" && PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$stub" GH_STUB_LOG="$TMPROOT/ghlog" \
  env -u GITHUB_REPOSITORY sh "$SCRIPT" require "$LIN_D3" 2>"$TMPROOT/err")
assert_rc 'without GITHUB_REPOSITORY there is nobody to ask: refuses' "$?" 3
out=$(cd "$LIN" && sh "$SCRIPT" require a b 2>"$TMPROOT/err")
assert_rc 'two revisions is a usage error, not a pass' "$?" 2

# ---------------------------------------------------------------------------
# 4. Mutation. Every probe copies the script, removes one refusal with sed, and
#    requires two things: the edit really changed the file (a no-op mutation
#    exercises nothing), and the case that refusal exists for no longer gets the
#    verdict the suite above demands — i.e. the suite would go red.
# ---------------------------------------------------------------------------
echo 'mutation probes'
run_case() {
  # run_case CASE SCRIPT → sets $out and $rc.  CASE is j:FIXTURE or r:NAME.
  case $1 in
    j:*) judge "${1#j:}" "$2" ;;
    r:green-on-e)
      new_stub
      green_on "$stub" "$LIN_S"
      req "$LIN" "$LIN_D3" "$stub" "$2"
      ;;
    r:green-off-path)
      new_stub
      green_on "$stub" "$OURS_C"
      req "$OURS" "$OURS_M" "$stub" "$2"
      ;;
    r:green-beyond-cap)
      new_stub
      green_on "$stub" "$LONG_105"
      req "$LONG" "$LONG_HEAD" "$stub" "$2"
      ;;
    r:green-on-head-beyond-cap)
      new_stub
      green_on "$stub" "$LONG_HEAD"
      req "$LONG" "$LONG_HEAD" "$stub" "$2"
      ;;
    r:read-dies-after-green-page)
      new_stub
      green_on "$stub" "$LIN_S"
      mv "$stub/$LIN_S.json" "$stub/$LIN_S.fail"
      req "$LIN" "$LIN_D3" "$stub" "$2"
      ;;
    r:error-body-then-green)
      new_stub
      cp "$(fx api-error)" "$stub/$LIN_S.json"
      green_on "$stub" "$LIN_D2"
      req "$LIN" "$LIN_D3" "$stub" "$2"
      ;;
    r:shallow-green-head)
      new_stub
      green_on "$stub" "$SHALLOW_HEAD"
      req "$SHALLOW" HEAD "$stub" "$2"
      ;;
    r:failed-on-only-candidate)
      new_stub
      page 1 "$(wr 500 "$LIN_S" push completed failure "$T1")" >"$stub/$LIN_S.json"
      req "$LIN" "$LIN_S" "$stub" "$2"
      ;;
    *)
      out="unknown case $1"
      rc=99
      ;;
  esac
}
mutant_n=0
probe() {
  # probe LABEL CASE WANT_RC WANT_TEXT SED_EXPR...
  _label=$1
  _case=$2
  _want_rc=$3
  _want_text=$4
  shift 4
  mutant_n=$((mutant_n + 1))
  _m="$TMPROOT/mutant-$mutant_n.sh"
  cp "$SCRIPT" "$_m"
  for _expr in "$@"; do
    cp "$_m" "$_m.before"
    sed "$_expr" "$_m.before" >"$_m"
    if cmp -s "$_m" "$_m.before"; then
      bad "mutation '$_label' changes the script (no-op: $_expr)"
      return
    fi
  done
  run_case "$_case" "$SCRIPT"
  case $out in *"$_want_text"*) _orig_text=yes ;; *) _orig_text=no ;; esac
  if [ "$rc" != "$_want_rc" ] || [ "$_orig_text" = no ]; then
    bad "mutation '$_label': the unmutated script does not meet the expectation being probed (rc=$rc)"
    return
  fi
  run_case "$_case" "$_m"
  case $out in *"$_want_text"*) _mut_text=yes ;; *) _mut_text=no ;; esac
  if [ "$rc" = "$_want_rc" ] && [ "$_mut_text" = yes ]; then
    bad "mutation '$_label' is caught (the mutant still gives rc=$rc on [$_case])"
  else
    ok "mutation '$_label' is caught ([$_case]: want rc=$_want_rc, mutant rc=$rc)"
  fi
}

{
  # judge — the evidence rules.
  probe 'the count check is dropped' j:dropped-page 3 'total_count 2' \
    's/elif (\$runs | length) != \$total then/elif false then/'
  probe 'the count check is dropped (surplus runs)' j:surplus 3 'total_count 1' \
    's/elif (\$runs | length) != \$total then/elif false then/'
  probe 'only the first document is read' j:newer-failure-on-p2 1 'run 11 (push) is completed/failure' \
    's/\[\.\[\]\.workflow_runs\[\]\] as \$runs/[.[0].workflow_runs[]] as $runs/'
  probe 'only the first document is read AND the count check is dropped' j:newer-failure-on-p2 1 'run 11 (push) is completed/failure' \
    's/\[\.\[\]\.workflow_runs\[\]\] as \$runs/[.[0].workflow_runs[]] as $runs/' \
    's/elif (\$runs | length) != \$total then/elif false then/'
  probe 'the pages are no longer slurped' j:green-2p 0 'go.yml run 11' \
    's/jq -rs /jq -r /'
  probe 'pages may disagree on total_count' j:total-disagrees 3 'pages disagree' \
    's/elif (\[\.\[\]\.total_count\] | unique | length) != 1 then/elif false then/'
  probe 'a run may appear twice' j:shifted-page 3 'more than once' \
    's/elif (\$runs | map(\.id) | unique | length) != (\$runs | length) then/elif false then/'
  probe 'a run for a different commit is accepted' j:other-sha 3 'evidence for a different commit' \
    's/elif any(\$runs\[\]; \.head_sha != \$sha) then/elif false then/'
  probe 'a run for a different commit is accepted (next to a real one)' j:mixed-sha 3 'evidence for a different commit' \
    's/elif any(\$runs\[\]; \.head_sha != \$sha) then/elif false then/'
  probe 'a run of a different workflow file is accepted' j:other-path 3 'not of .github/workflows/go.yml' \
    's/elif any(\$runs\[\]; \.path != \$path) then/elif false then/'
  probe 'timestamps are no longer validated' j:bad-started-at 3 'no usable id' \
    's/ and (\.created_at | ts) and (\.run_started_at | ts);/;/'
  probe 'an API error body is read as "no runs"' j:api-error 3 'no numeric total_count' \
    's/elif any(\.\[\]; (\.total_count | type) != "number") then/elif false then/' \
    's/elif any(\.\[\]; (\.workflow_runs | type) != "array") then/elif false then/' \
    's/\.\[0\]\.total_count as \$total/(.[0].total_count \/\/ 0) as $total/' \
    's/\[\.\[\]\.workflow_runs\[\]\] as \$runs/[.[].workflow_runs[]?] as $runs/'
  # judge — which run counts.
  probe 'pull_request runs count' j:pull-request-only 1 'no push or workflow_dispatch' \
    's/^def qualifying: .*$/def qualifying: true;/'
  probe 'a green pull_request run outvotes a red push run' j:push-failure-newer-pr-success 1 'run 10 (push) is completed/failure' \
    's/^def qualifying: .*$/def qualifying: true;/'
  probe 'the OLDEST run decides instead of the newest' j:older-success-newer-failure 1 'run 11 (workflow_dispatch) is completed/failure' \
    's/ | sort_by(\[\.run_started_at, \.created_at, \.id\]) | last) as \$newest/ | sort_by([.run_started_at, .created_at, .id]) | first) as $newest/'
  probe 'ANY green run decides instead of the newest' j:older-success-newer-failure 1 'run 11 (workflow_dispatch) is completed/failure' \
    's/ | if (\$newest | green) then / | if any($counted[]; green) then /'
  probe 'the list order decides (no sort)' j:newer-failure-listed-first 1 'run 11 (workflow_dispatch) is completed/failure' \
    's/ | sort_by(\[\.run_started_at, \.created_at, \.id\]) | last) as \$newest/ | last) as $newest/'
  probe 'newest is decided by run id alone (a re-run is missed)' j:rerun-of-older-id-fails-last 1 'run 10 (push) is completed/failure' \
    's/sort_by(\[\.run_started_at, \.created_at, \.id\])/sort_by(.id)/'
  probe 'created_at no longer breaks a tie' j:tie-created-at 1 'run 11 (push) is completed/failure' \
    's/sort_by(\[\.run_started_at, \.created_at, \.id\])/sort_by([.run_started_at, -.id])/'
  probe 'the id no longer breaks a tie' j:tie-id 1 'run 11 (push) is completed/failure' \
    's/sort_by(\[\.run_started_at, \.created_at, \.id\])/sort_by([.run_started_at, .created_at, -.id])/'
  probe 'a null conclusion counts as green' j:in-progress 1 'in_progress/pending' \
    's/^def green: .*$/def green: .conclusion == null or (.status == "completed" and .conclusion == "success");/'
  probe 'the completed-status requirement is dropped' j:success-not-completed 1 'in_progress/success' \
    's/^def green: .*$/def green: .conclusion == "success";/'
  probe 'failure is added to the green conclusions' j:c-failure 1 'completed/failure' \
    's/^def green: .*$/def green: .status == "completed" and (.conclusion == "success" or .conclusion == "failure");/'
  probe 'cancelled is added to the green conclusions' j:c-cancelled 1 'completed/cancelled' \
    's/^def green: .*$/def green: .status == "completed" and (.conclusion == "success" or .conclusion == "cancelled");/'
  probe 'skipped is added to the green conclusions' j:c-skipped 1 'completed/skipped' \
    's/^def green: .*$/def green: .status == "completed" and (.conclusion == "success" or .conclusion == "skipped");/'
  probe 'no run at all counts as green' j:no-runs 1 'no go.yml run' \
    's/      | if (\$counted | length) == 0 then "red", /      | if ($counted | length) == 0 then "green", /'
  probe 'an empty response is no longer refused up front' j:empty-file 3 'response is empty' \
    's/^  \[ -s "\$file" \] || unusable .*$/  :/'
  probe 'an unrecognised verdict passes' j:html 3 'not valid JSON' \
    's/^  if ! out=\$(jq /  if false \&\& ! out=$(jq /' \
    's/^set -eu$/set -e; out=""/' \
    's/^      unusable "internal error: unrecognised verdict from jq"$/      exit 0/'
  # require — where evidence may be, and reads that fail.
  probe 'tree identity is no longer checked' r:green-off-path 1 'skipped: NOT tree-identical' \
    's/^    if git diff --quiet "\$c" "\$head" -- "\$@" <\/dev\/null; then$/    if true; then/'
  probe 'a git diff that says "differs" is treated as identical' r:green-off-path 1 'skipped: NOT tree-identical' \
    's/^      continue$/      :/'
  probe 'the cap is removed' r:green-beyond-cap 1 'CUT SHORT' \
    's/^  if \[ "\$total" -gt "\$CAP" \]; then$/  if false; then/'
  probe 'beyond the cap HEAD is no longer a candidate' r:green-on-head-beyond-cap 0 'completed/success' \
    "s/^      printf '%s\\\\n' \"\\\$head\"\$/      :/"
  probe 'E itself is no longer a candidate' r:green-on-e 0 'completed/success' \
    "s/^    printf '%s\\\\n' \"\\\$e\"\$/    :/"
  probe 'a failed read is no longer refused' r:read-dies-after-green-page 3 'could not read the go.yml runs' \
    's/^      unusable "could not read the go.yml runs for \$c (gh api failed)"$/      :/'
  probe 'unusable evidence on one candidate is skipped instead of refusing' r:error-body-then-green 3 'no numeric total_count' \
    's/^      if \[ "\$jrc" -ne 1 \]; then$/      if false; then/'
  probe 'a shallow clone is accepted' r:shallow-green-head 3 'the clone is shallow' \
    's/^  \[ "\$shallow" = false \] || unusable .*$/  :/'
  probe 'a red finding falls through to a pass' r:failed-on-only-candidate 1 'completed/failure' \
    's/^  exit 1$/  exit 0/'
}

# ---------------------------------------------------------------------------
# 5. The step in auto-release.yml, as it is on disk.
# ---------------------------------------------------------------------------
echo 'auto-release.yml: the Go-evidence step, executed'
awk -v name="      - name: $STEP_NAME" '
  $0 == name { instep = 1; print; next }
  instep && /^      - / { exit }
  instep { print }
' "$WORKFLOW" >"$TMPROOT/step.yml"
awk '
  /^        run: \|$/ { inrun = 1; next }
  inrun && /^          / { sub(/^          /, ""); print; next }
  inrun && /^[[:space:]]*$/ { print ""; next }
  inrun { exit }
' "$TMPROOT/step.yml" >"$TMPROOT/step.sh"
if [ -s "$TMPROOT/step.sh" ]; then
  ok "the step \"$STEP_NAME\" exists and has a run block"
else
  bad "the step \"$STEP_NAME\" exists and has a run block"
fi
if grep -q '\${{' "$TMPROOT/step.sh"; then
  bad 'the run block contains no ${{ }} expression'
else
  ok 'the run block contains no ${{ }} expression'
fi

# The step calls the script by its repository path, so the repository it runs
# in gets a copy (untracked: it changes no commit, and no tree the gate compares).
mkdir -p "$LIN/scripts/release"
cp "$SCRIPT" "$LIN/scripts/release/go-evidence.sh"
run_step() {
  # run_step STUB_DIR → sets $rc, $log, $summary, $ghlog
  : >"$TMPROOT/summary"
  : >"$TMPROOT/ghlog"
  # GitHub runs a `run:` block as `bash --noprofile --norc -eo pipefail {0}`,
  # from the repository root.
  (
    cd "$LIN" &&
      PATH="$STUB_BIN:$PATH" GH_STUB_DIR="$1" GH_STUB_LOG="$TMPROOT/ghlog" \
        GH_TOKEN=unused GITHUB_REPOSITORY=relayium/relayium \
        GITHUB_STEP_SUMMARY="$TMPROOT/summary" \
        bash --noprofile --norc -eo pipefail "$TMPROOT/step.sh"
  ) >"$TMPROOT/steplog" 2>&1
  rc=$?
  log=$(cat "$TMPROOT/steplog")
  summary=$(cat "$TMPROOT/summary")
  ghlog=$(cat "$TMPROOT/ghlog")
}

new_stub
green_on "$stub" "$LIN_D2"
run_step "$stub"
assert_rc 'a successful go.yml run on the push tip, none on E or HEAD: the step passes' "$rc" 0
assert_has 'a pass is written down' "$summary" "Go evidence for \`$LIN_D3\`: go.yml run 500 (push, attempt 1) completed/success on $LIN_D2"
assert_lacks 'a pass raises no error' "$log" '::error::'
assert_has 'it asked for every page' "$ghlog" '--paginate'
assert_has 'it asked for the largest page size' "$ghlog" 'per_page=100'
assert_has 'it asked about go.yml runs by commit' "$ghlog" "repos/relayium/relayium/actions/workflows/go.yml/runs?head_sha=$LIN_S&per_page=100"

new_stub
run_step "$stub"
assert_rc 'the Go lane never ran on this server tree: the step refuses' "$rc" 1
assert_has 'loudly' "$log" '::error::the Go lane never succeeded on the server tree'
assert_has 'with the withheld heading, on HEAD' "$summary" \
  "### Release withheld — no successful go.yml run covers the server tree on \`$LIN_D3\`"
assert_has 'naming E' "$summary" "E = $LIN_S is the last commit that changed the Go lane inputs"
assert_has 'and what was found on a candidate' "$summary" "$LIN_D2: no go.yml run"
assert_has 'and the remedy' "$summary" 'remedy: dispatch go.yml on main'

new_stub
page 1 "$(wr 500 "$LIN_D2" push in_progress null "$T1")" >"$stub/$LIN_D2.json"
run_step "$stub"
assert_rc 'the go.yml run is still in progress: the step refuses' "$rc" 1
assert_has 'and names it as pending' "$summary" 'is in_progress/pending'

new_stub
page 1 "$(wr 500 "$LIN_D2" push completed failure "$T1")" >"$stub/$LIN_D2.json"
run_step "$stub"
assert_rc 'the go.yml run failed: the step refuses' "$rc" 1
assert_has 'and names it' "$summary" 'is completed/failure'

new_stub
: >"$stub/$LIN_S.fail"
green_on "$stub" "$LIN_D2"
run_step "$stub"
assert_rc 'a read fails with no answer: the step refuses' "$rc" 1
assert_has 'loudly' "$log" '::error::could not establish that the Go lane verified the server tree'
assert_has 'and says so in the summary' "$summary" 'Release withheld — the Go evidence could not be established'

new_stub
cp "$(fx api-error)" "$stub/$LIN_S.fail"
run_step "$stub"
assert_rc 'the API answers with an error: the step refuses' "$rc" 1
assert_has 'as unestablished, not as "no run"' "$summary" 'the Go evidence could not be established'

new_stub
page 2 "$(wr 500 "$LIN_S" push completed success "$T1")" >"$stub/$LIN_S.json"
run_step "$stub"
assert_rc 'a page silently missing from a "successful" read: the step refuses' "$rc" 1
assert_has 'and says which evidence was short' "$summary" 'but the API reports total_count 2'

echo 'auto-release.yml: the Go-evidence step, read'
# Comment lines are dropped first: the step explains at length what it must not
# do, and saying `force` is not being conditioned on it.
code=$(grep -v '^[[:space:]]*#' "$TMPROOT/step.yml")
step_has() {
  # step_has NAME ERE
  if printf '%s\n' "$code" | grep -Eq -- "$2"; then ok "$1"; else bad "$1"; fi
}
step_lacks() {
  # step_lacks NAME ERE
  if printf '%s\n' "$code" | grep -Eq -- "$2"; then
    bad "$1"
    printf '%s\n' "$code" | grep -En -- "$2" | sed 's/^/       | /'
  else
    ok "$1"
  fi
}
step_lacks 'no `|| true` (or `|| :`) anywhere in the step' '\|\|[[:space:]]*(true|:)([[:space:]]|[;)"]|$)'
step_lacks 'no continue-on-error on the step' 'continue-on-error'
step_lacks 'the step is not conditioned on, and never mentions, `force`' 'force'
step_lacks 'the decision is not made by a --jq filter in the YAML' '--jq'
step_has 'the step calls scripts/release/go-evidence.sh require on the commit it is about to tag' \
  'sh scripts/release/go-evidence\.sh require "\$sha"'
step_has 'that commit is HEAD' 'sha="\$\(git rev-parse HEAD\)"'
step_has 'the step runs with set -euo pipefail' '^[[:space:]]*set -euo pipefail$'
step_has 'every refusal path exits non-zero' '^[[:space:]]*exit 1$'

# The script is part of the gate: the same convenience edit must not reopen it.
script_code=$(grep -v '^[[:space:]]*#' "$SCRIPT")
if printf '%s\n' "$script_code" | grep -Eq -- '\|\|[[:space:]]*(true|:)([[:space:]]|[;)"]|$)'; then
  bad 'no `|| true` (or `|| :`) anywhere in go-evidence.sh'
else
  ok 'no `|| true` (or `|| :`) anywhere in go-evidence.sh'
fi
if printf '%s\n' "$script_code" | grep -Fq -- 'gh api --paginate'; then
  ok 'the fetch in go-evidence.sh requests pagination'
else
  bad 'the fetch in go-evidence.sh requests pagination'
fi

# A gate that does not run when the tagging step does is not a gate.
step_if() {
  # step_if STEP_NAME → that step's `if:` line
  awk -v name="      - name: $1" '
    $0 == name { instep = 1; next }
    instep && /^      - / { exit }
    instep && /^        if: / { print; exit }
  ' "$WORKFLOW"
}
gate_if=$(step_if "$STEP_NAME")
tag_if=$(step_if 'Tag it')
if [ -n "$gate_if" ] && [ "$gate_if" = "$tag_if" ]; then
  ok 'the step runs under exactly the condition the tagging step runs under'
else
  bad "the step runs under exactly the condition the tagging step runs under (gate=[$gate_if] tag=[$tag_if])"
fi
assert_eq 'and so does the HEAD gate, which is still there' "$(step_if "$HEAD_STEP_NAME")" "$tag_if"
line_of() {
  # line_of FIXED_STRING → first matching line number, or empty
  grep -n -F -- "$1" "$WORKFLOW" | head -n 1 | cut -d: -f1
}
head_gate_line=$(line_of "- name: $HEAD_STEP_NAME")
gate_line=$(line_of "- name: $STEP_NAME")
tag_line=$(line_of 'git tag -a')
push_line=$(line_of 'git push origin')
dispatch_line=$(line_of 'gh workflow run release.yml')
if [ -n "$head_gate_line" ] && [ -n "$gate_line" ] && [ -n "$tag_line" ] && [ -n "$push_line" ] && [ -n "$dispatch_line" ] &&
  [ "$head_gate_line" -lt "$gate_line" ] &&
  [ "$gate_line" -lt "$tag_line" ] && [ "$gate_line" -lt "$push_line" ] && [ "$gate_line" -lt "$dispatch_line" ]; then
  ok 'the step runs after the HEAD gate and before the tag is created, pushed or built'
else
  bad "the step runs after the HEAD gate and before the tag is created, pushed or built (head-gate=$head_gate_line gate=$gate_line tag=$tag_line push=$push_line dispatch=$dispatch_line)"
fi
# E is a question about history; the checkout must bring it.
if grep -Eq '^[[:space:]]*fetch-depth:[[:space:]]*0([[:space:]]|$)' "$WORKFLOW"; then
  ok 'auto-release.yml checks out full history (fetch-depth: 0)'
else
  bad 'auto-release.yml checks out full history (fetch-depth: 0)'
fi

# ---------------------------------------------------------------------------
# 6. Drift. The pathspec list in the script is go.yml's `on.push.paths`, by
#    hand. If go.yml gains an input the script does not know, E is computed
#    from too little and a run on a commit that differs in that input would be
#    accepted as evidence.
# ---------------------------------------------------------------------------
echo 'the pathspec list is go.yml'"'"'s on.push.paths'
push_paths() {
  # push_paths WORKFLOW_FILE → on.push.paths as git pathspecs, one per line.
  # `X/**` is the directory X. Any other glob has no pathspec this suite is
  # willing to guess at, and is printed as UNTRANSLATABLE so the lists differ.
  awk '
    /^on:[[:space:]]*$/ { inon = 1; next }
    inon && /^[^[:space:]#]/ { inon = 0 }
    !inon { next }
    /^  push:[[:space:]]*$/ { inpush = 1; next }
    inpush && /^  [^[:space:]#]/ { inpush = 0; inpaths = 0 }
    !inpush { next }
    /^    paths:[[:space:]]*$/ { inpaths = 1; next }
    inpaths && /^[[:space:]]*(#.*)?$/ { next }
    inpaths && /^      - / {
      p = $0
      sub(/^      - /, "", p)
      sub(/[[:space:]]+#.*$/, "", p)
      sub(/[[:space:]]+$/, "", p)
      gsub(/^["\047]|["\047]$/, "", p)
      if (p ~ /\/\*\*$/) sub(/\/\*\*$/, "", p)
      if (p ~ /[*?\[\]!]/) p = "UNTRANSLATABLE:" p
      print p
      next
    }
    inpaths { inpaths = 0 }
  ' "$1"
}
want_paths=$(push_paths "$GO_WORKFLOW" | LC_ALL=C sort)
got_paths=$(sh "$SCRIPT" paths | LC_ALL=C sort)
assert_eq "go-evidence.sh paths == go.yml's on.push.paths (with server/** as server)" "$got_paths" "$want_paths"
assert_eq 'and that list is not empty' "$([ -n "$want_paths" ] && echo non-empty)" non-empty
assert_has 'it contains the server tree' "
$got_paths
" "
server
"
# go.yml being one of its own inputs is what makes "a run on a tree-identical
# commit" a run of the SAME workflow file.
assert_has 'it contains go.yml itself' "
$got_paths
" "
.github/workflows/go.yml
"
# The detector itself, so that "the lists agree" above means something.
printf 'name: go\non:\n  push:\n    branches:\n      - main\n    paths:\n      - '"'"'server/**'"'"'\n      # a comment\n      - "scripts/x.go"  # trailing\n\n      - scripts/y.sh\n  workflow_dispatch:\njobs:\n  test:\n    runs-on: x\n' >"$TMPROOT/wf-paths.yml"
assert_eq 'the parser reads quoted, commented and bare entries' "$(push_paths "$TMPROOT/wf-paths.yml" | tr '\n' ' ')" 'server scripts/x.go scripts/y.sh '
printf 'name: go\non:\n  push:\n    paths:\n      - '"'"'server/**'"'"'\n      - '"'"'apps/**/*.json'"'"'\n      - '"'"'!server/docs/**'"'"'\njobs:\n  test:\n    runs-on: x\n' >"$TMPROOT/wf-glob.yml"
assert_eq 'a glob or a negation it cannot translate is flagged, not guessed' "$(push_paths "$TMPROOT/wf-glob.yml" | grep -c '^UNTRANSLATABLE:')" 2
printf 'name: web\non:\n  pull_request:\n    paths:\n      - '"'"'web/**'"'"'\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: x\n' >"$TMPROOT/wf-other-event.yml"
assert_eq "another event's paths are not push paths" "$(push_paths "$TMPROOT/wf-other-event.yml" | grep -c .)" 0

echo 'a run-level success on go.yml means every job ran and passed'
# A run concludes `success` when its jobs succeeded OR WERE SKIPPED, and when a
# failing job or step was marked continue-on-error. go-evidence.sh reads only
# the run-level conclusion, so go.yml must not be able to produce either.
go_jobs() {
  # go_jobs FILE → one line per job id
  awk '
    /^jobs:[[:space:]]*$/ { injobs = 1; next }
    injobs && /^[^[:space:]#]/ { injobs = 0 }
    injobs && /^  [A-Za-z0-9_-]+:[[:space:]]*(#.*)?$/ { id = $1; sub(/:.*$/, "", id); print id }
  ' "$1"
}
job_level_ifs() {
  # job_level_ifs FILE → every job-level `if:` line
  awk '
    /^jobs:[[:space:]]*$/ { injobs = 1; next }
    injobs && /^[^[:space:]#]/ { injobs = 0 }
    injobs && /^    if:/ { print FILENAME ":" FNR ": " $0 }
  ' "$1"
}
njobs=$(go_jobs "$GO_WORKFLOW" | grep -c .)
if [ "$njobs" -ge 1 ]; then
  ok "go.yml declares jobs ($njobs)"
else
  bad 'go.yml declares jobs'
fi
found=$(job_level_ifs "$GO_WORKFLOW")
if [ -z "$found" ]; then
  ok 'go.yml declares no job-level `if:` (a skipped job cannot hide behind a successful run)'
else
  bad 'go.yml declares no job-level `if:` (a skipped job cannot hide behind a successful run)'
  printf '%s\n' "$found" | sed 's/^/       | /'
fi
found=$(grep -n -E '^[[:space:]]*continue-on-error[[:space:]]*:' "$GO_WORKFLOW")
if [ -z "$found" ]; then
  ok 'go.yml uses no continue-on-error (a failure cannot be reported as success)'
else
  bad 'go.yml uses no continue-on-error (a failure cannot be reported as success)'
  printf '%s\n' "$found" | sed 's/^/       | /'
fi
printf 'name: go\non: push\njobs:\n  test:\n    runs-on: x\n    steps:\n      - run: x\n        if: failure()\n  race:\n    if: github.ref == '"'"'refs/heads/main'"'"'\n    runs-on: x\n' >"$TMPROOT/wf-if.yml"
assert_eq 'the detector sees a job-level if' "$(job_level_ifs "$TMPROOT/wf-if.yml" | grep -c .)" 1
assert_eq 'the detector counts jobs' "$(go_jobs "$TMPROOT/wf-if.yml" | grep -c .)" 2
assert_eq 'the detector is quiet about a step-level if' "$(job_level_ifs "$TMPROOT/wf-paths.yml" | grep -c .)" 0

if [ "$fail" -eq 0 ]; then
  echo 'all go-evidence tests passed'
else
  echo 'go-evidence tests FAILED'
fi
exit "$fail"
