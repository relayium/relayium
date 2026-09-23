#!/bin/sh
# go-evidence.sh — has the Go lane (.github/workflows/go.yml) actually verified
# the server tree auto-release.yml is about to tag?
#
# WHAT THIS GUARDS AGAINST
# ------------------------
# scripts/release/checks-green.sh proves that whatever ran on HEAD is green. It
# cannot prove that the Go lane ran AT ALL. auto-release.yml releases when
# `server/` changed since the last tag, but HEAD itself is usually a docs- or
# web-only commit, and go.yml is path-filtered: on such a HEAD it is never
# selected, emits no check run, and the HEAD gate passes on the web and hygiene
# checks alone. Observed on main, 2026-09-20: docs-only push tip 7d3b2923 —
# "29 check runs green", not one of them from go.yml — while every published
# binary is built from `server/`.
#
# WHERE THE EVIDENCE REALLY IS
# ----------------------------
# The obvious rule — "require a green go.yml run on E, the last commit that
# changed the Go lane's inputs" — is wrong for this repository, and was measured
# to be wrong before this was written. GitHub starts a push-triggered workflow
# ONCE PER PUSH, on the push TIP, with `paths:` evaluated against the whole
# push. main is pushed in batches, so the run for a server change lands on
# whichever commit happened to be the tip of that push:
#
#     E = e48c0d43 (server change)   no go.yml run, ever
#         fcc538bf (tip of the push) go.yml run 35568064134, success
#
# and nobody can create a run on E afterwards: `workflow_dispatch` takes a ref,
# not a commit. So the rule here is about the TREE, not about one commit:
#
#   A go.yml run on commit C is evidence for HEAD iff C lies on the ancestry
#   path from E to HEAD (E and HEAD included) AND
#   `git diff --quiet C HEAD -- <the Go lane's inputs>` says the two trees are
#   identical under those inputs. go.yml is itself one of those inputs, so such
#   a run executed the same workflow file over the same files.
#
# The identity is CHECKED per commit, not argued from how `git log` simplifies
# history: a commit on the path that is not identical (an `-s ours` merge can
# produce one) is skipped, counted and reported, and a run on it proves nothing.
#
# COMMANDS
# --------
#     go-evidence.sh paths
#         The Go lane's inputs as git pathspecs, one per line. This is go.yml's
#         `on.push.paths` with `server/**` written as `server`. The list is
#         explicit on purpose — go.yml's list is interleaved with long comments
#         and parsing YAML in sh on the release path is not a risk worth taking
#         — and scripts/test/go-evidence-test.sh fails when the two drift.
#
#     go-evidence.sh judge SHA FILE
#         Offline. FILE is the raw output of
#           gh api --paginate \
#             "repos/OWNER/REPO/actions/workflows/go.yml/runs?head_sha=SHA&per_page=100"
#         i.e. one `{ "total_count": N, "workflow_runs": [ … ] }` document per
#         page, back to back. Decides whether commit SHA carries green evidence.
#
#     go-evidence.sh require [REV]
#         The gate. Needs git with full history, `gh` with a token, and
#         GITHUB_REPOSITORY. Computes E for REV (default HEAD), walks the
#         candidates OLDEST FIRST (E itself first), fetches each one's go.yml
#         runs, judges them with `judge`, and stops at the first green one.
#
# WHICH RUN COUNTS (judge)
# ------------------------
# QUALIFYING runs are those with event `push` or `workflow_dispatch`. Both check
# out `head_sha` itself. `pull_request` runs never count — their head_sha is the
# PR head while the code they tested was the MERGE ref (17 such go.yml runs
# exist in this repository's history) — and neither does any other event.
# `head_branch` is deliberately not examined: the same sha is the same tree and
# the same go.yml whatever ref it was started from.
#
# Among the qualifying runs on SHA, the NEWEST ONE DECIDES, and only it:
#
#     newest = greatest (run_started_at, created_at, id), compared in that order
#
# The timestamps are required to be `YYYY-MM-DDTHH:MM:SSZ`, which is what makes
# comparing them as strings correct. `run_started_at` comes first because a
# re-run keeps its run id and its `created_at` but gets a new `run_started_at`,
# and the API reports a run in its LATEST attempt (observed: run 33361224263,
# attempt 1 failure, attempt 2 success, listed as success). So this is the same
# rule as the HEAD gate's `filter=latest`: the most recent execution over this
# tree is the one that counts. An older failure followed by a newer success
# passes; an older success followed by a NEWER failure does not — the last thing
# anyone learned about this tree is that it is red.
#
# GREEN is status `completed` AND conclusion `success`, nothing else. `neutral`
# and `skipped` are accepted for a single check run by the HEAD gate; for a
# whole workflow run they mean nothing ran. A run-level `success` does not by
# itself exclude a SKIPPED job, so scripts/test/go-evidence-test.sh also requires
# that go.yml declares no job-level `if:`.
#
# A candidate that is not green does not end the search: another tree-identical
# commit may carry the evidence. Every examined candidate's finding is reported.
# The converse is a known limit of a per-commit rule with an oldest-first walk
# that stops at the first green candidate: a NEWER red run on a LATER
# tree-identical commit is never looked at. When that commit is HEAD the HEAD
# gate sees its red check runs and refuses; when it is a commit in between (a
# go.yml dispatch that failed on an earlier tip), nothing here does.
#
# THE CAP (require)
# -----------------
# At most 100 candidates are considered. When the path from E to HEAD is longer,
# those are the 99 OLDEST (the push tip that carried E is normally within a few
# commits of E) plus HEAD ITSELF. HEAD is always among them on purpose: the
# remedy this script prints — dispatch go.yml on main — creates a run on the
# tip, and a remedy the gate would never look at is not a remedy. When nothing
# green is found the refusal says that the cap cut the walk short.
#
# VERDICT (judge and require)
# ---------------------------
#     exit 0   green. stdout: one line naming the run (and, for `require`, the
#              commit it is on, E, and how many candidates were looked at).
#     exit 1   no green evidence. judge: one line saying what was found on SHA.
#              require: a line naming E and HEAD, one line per candidate, and
#              the remedy.
#     exit 3   the evidence is unusable, so nothing was established: missing,
#              unreadable or empty file; not JSON; a page without `total_count`
#              or `workflow_runs` (an API error body looks like that); pages
#              that disagree on `total_count`; fewer or more runs than
#              `total_count`, or the same run twice; a run without a usable id,
#              head_sha, path, event, status, conclusion or timestamps; a run
#              whose head_sha is not SHA (evidence for a DIFFERENT commit); a
#              run whose path is not go.yml; and for `require` also: a shallow
#              clone, no E, `git diff` failing, or a fetch that failed.
#              Unusable evidence on ANY candidate refuses the release; it is
#              not skipped in the hope that a later candidate is readable.
#     exit 2   usage.
#
# There is no code path from "jq could not run", "gh failed" or "git failed" to
# exit 0.
#
# WHAT THIS CANNOT PROVE
# ----------------------
# That go.yml's `paths:` names every input of the Go suite (toolchain image,
# module proxy, the clock); that the jobs in go.yml are meaningful (deleting the
# race jobs still yields `success` — that is code review's job, and editing
# go.yml re-triggers it); or anything about a run GitHub never started.
#
# POSIX sh; needs jq, and for `require` git and gh. Used by
# .github/workflows/auto-release.yml and covered by
# scripts/test/go-evidence-test.sh (run in repo-hygiene.yml).
set -eu

WORKFLOW_FILE='go.yml'
WORKFLOW_PATH='.github/workflows/go.yml'
CAP=100

usage() {
  {
    echo "usage: $0 paths"
    echo "       $0 judge SHA WORKFLOW_RUNS_JSON_FILE"
    echo "       $0 require [REV]"
  } >&2
  exit 2
}

# unusable REASON — the evidence cannot establish anything. The reason goes to
# stdout for the caller's step summary and to stderr for the log.
unusable() {
  printf 'Go evidence unusable: %s\n' "$1"
  printf 'go-evidence.sh: refusing: %s\n' "$1" >&2
  exit 3
}

# The Go lane's inputs, as git pathspecs. KEEP IN STEP WITH go.yml's
# `on.push.paths`; scripts/test/go-evidence-test.sh compares the two.
lane_paths() {
  cat <<'PATHS'
server
scripts/go-race-shard.go
scripts/test/db-rollback-harness.sh
apps/RelayiumKit/Tests/Fixtures/device-inbox-manifest-v3-vectors.json
apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json
scripts/list-go-fuzz-targets.sh
.github/workflows/go-fuzz-nightly.yml
.github/workflows/go.yml
PATHS
}

is_sha() {
  case $1 in
    *[!0-9a-f]*) return 1 ;;
  esac
  [ "${#1}" -eq 40 ]
}

# ---------------------------------------------------------------------------
# judge SHA FILE
# ---------------------------------------------------------------------------
judge() {
  sha=$1
  file=$2
  is_sha "$sha" || unusable "not a full lowercase commit id: $sha"
  [ -f "$file" ] || unusable "no such file: $file"
  [ -r "$file" ] || unusable "cannot read $file"
  # An empty body is what a fetch that died before the first byte leaves behind.
  [ -s "$file" ] || unusable "the workflow-runs response is empty"
  command -v jq >/dev/null 2>&1 || unusable "jq is not installed"

  jqerr=$(mktemp "${TMPDIR:-/tmp}/go-evidence-jq.XXXXXX")
  # The whole decision is one jq program over ALL pages at once (`-s`), answering
  # with a verdict word on the first line — `green`, `red` or `unusable` — and the
  # detail after it. Each refusal is a separate single-line branch so that the
  # test suite can remove them one at a time and prove each one is load-bearing.
  # shellcheck disable=SC2016 # a jq program, not shell: $names are jq variables
  program='
def ts: type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$");
def wellformed: type == "object" and (.id | type) == "number" and (.head_sha | type) == "string" and (.path | type) == "string" and (.event | type) == "string" and (.status | type) == "string" and ((.conclusion | type) == "string" or .conclusion == null) and (.created_at | ts) and (.run_started_at | ts);
def qualifying: .event == "push" or .event == "workflow_dispatch";
def green: .status == "completed" and .conclusion == "success";
def unusable(reason): "unusable", reason;
if length == 0 then unusable("the response contains no JSON document")
elif any(.[]; type != "object") then unusable("a page is not a JSON object")
elif any(.[]; (.total_count | type) != "number") then unusable("a page has no numeric total_count (an API error body looks like this)")
elif any(.[]; (.workflow_runs | type) != "array") then unusable("a page has no workflow_runs array")
elif ([.[].total_count] | unique | length) != 1 then unusable("pages disagree on total_count (\([.[].total_count] | map(tostring) | join(", "))): the run set changed while it was being read")
else
  .[0].total_count as $total
  | [.[].workflow_runs[]] as $runs
  | if any($runs[]; wellformed | not) then unusable("a workflow run has no usable id, head_sha, path, event, status, conclusion, created_at or run_started_at")
    elif ($runs | length) != $total then unusable("examined \($runs | length) workflow runs across \(length) page(s) but the API reports total_count \($total): a page is missing")
    elif ($runs | map(.id) | unique | length) != ($runs | length) then unusable("the same workflow run appears more than once: pages shifted while they were being read")
    elif any($runs[]; .head_sha != $sha) then unusable("the response contains a run for \(first($runs[] | select(.head_sha != $sha) | .head_sha)), not for the queried commit \($sha): evidence for a different commit")
    elif any($runs[]; .path != $path) then unusable("the response contains a run of \(first($runs[] | select(.path != $path) | .path)), not of \($path)")
    else
      [$runs[] | select(qualifying)] as $counted
      | if ($counted | length) == 0 then "red", (if ($runs | length) == 0 then "no go.yml run" else "no push or workflow_dispatch go.yml run (\($runs | length) run(s) of other events do not count: \([$runs[].event] | unique | join(", ")))" end)
        else
          ($counted | sort_by([.run_started_at, .created_at, .id]) | last) as $newest
          | (if ($counted | length) > 1 then "; the \(($counted | length) - 1) older run(s) on this commit do not count" else "" end) as $older
          | if ($newest | green) then "green", "go.yml run \($newest.id) (\($newest.event), attempt \($newest.run_attempt // "?")) completed/success\($older)"
            else "red", "newest go.yml run \($newest.id) (\($newest.event)) is \($newest.status)/\($newest.conclusion // "pending")\($older)"
            end
        end
    end
end
'
  if ! out=$(jq -rs --arg sha "$sha" --arg path "$WORKFLOW_PATH" "$program" "$file" 2>"$jqerr"); then
    reason=$(head -n 1 "$jqerr")
    rm -f "$jqerr"
    unusable "the workflow-runs response is not valid JSON ($reason)"
  fi
  rm -f "$jqerr"

  # First line is the verdict, the rest is the detail. Split with parameter
  # expansion rather than a pipe into head/sed, so nothing here can SIGPIPE.
  nl='
'
  verdict=${out%%"$nl"*}
  case $out in
    *"$nl"*) detail=${out#*"$nl"} ;;
    *) detail='' ;;
  esac

  case $verdict in
    green)
      [ -n "$detail" ] || unusable "internal error: a green verdict that names no run"
      printf '%s\n' "$detail"
      exit 0
      ;;
    red)
      [ -n "$detail" ] || unusable "internal error: a red verdict without a finding"
      printf '%s\n' "$detail"
      exit 1
      ;;
    unusable)
      unusable "${detail:-no reason given}"
      ;;
    *)
      unusable "internal error: unrecognised verdict from jq"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# require [REV]
# ---------------------------------------------------------------------------
require() {
  rev=$1
  for tool in git gh jq; do
    command -v "$tool" >/dev/null 2>&1 || unusable "$tool is not installed"
  done
  [ -n "${GITHUB_REPOSITORY:-}" ] || unusable "GITHUB_REPOSITORY is not set: there is no repository to ask"

  head=$(git rev-parse --verify --quiet "$rev^{commit}") || unusable "cannot resolve $rev to a commit"
  is_sha "$head" || unusable "git did not return a full commit id for $rev"
  # E is a question about history. A shallow clone answers it with whatever
  # commit happens to be the oldest one present.
  shallow=$(git rev-parse --is-shallow-repository) || unusable "cannot tell whether the clone is shallow"
  [ "$shallow" = false ] || unusable "the clone is shallow: the last commit that changed the Go lane's inputs cannot be determined"

  # The pathspecs become the positional parameters: quoted once, reused for
  # every git call below.
  set --
  while IFS= read -r p; do
    [ -n "$p" ] && set -- "$@" "$p"
  done <<PATHS
$(lane_paths)
PATHS
  [ $# -gt 0 ] || unusable "internal error: the Go lane's input list is empty"

  e=$(git log -1 --format=%H "$head" -- "$@") || unusable "git log failed while looking for the last change to the Go lane's inputs"
  [ -n "$e" ] || unusable "no commit reachable from $head ever changed the Go lane's inputs"
  is_sha "$e" || unusable "git did not return a full commit id for E"

  work=$(mktemp -d "${TMPDIR:-/tmp}/go-evidence.XXXXXX")
  trap 'rm -rf "$work"' EXIT

  # E first, then everything between E and HEAD, oldest first. For E == HEAD the
  # range is empty and E is the only candidate.
  {
    printf '%s\n' "$e"
    git rev-list --reverse --ancestry-path "$e..$head"
  } >"$work/all" || unusable "git rev-list failed while listing the commits from E to HEAD"
  total=$(awk 'NF { n++ } END { print n + 0 }' "$work/all") || unusable "cannot count the candidate commits"
  [ "$total" -ge 1 ] || unusable "internal error: no candidate commits"
  if [ "$total" -gt "$CAP" ]; then
    {
      head -n $((CAP - 1)) "$work/all"
      printf '%s\n' "$head"
    } >"$work/candidates"
  else
    cp "$work/all" "$work/candidates"
  fi

  examined=0
  skipped=0
  : >"$work/findings"
  while IFS= read -r c; do
    is_sha "$c" || unusable "git listed something that is not a commit id: $c"
    # Identical under the Go lane's inputs, or it is not evidence. Exit 1 means
    # "differs"; anything above that means git could not answer.
    # (stdin is the candidate list: nothing inside this loop may read it.)
    if git diff --quiet "$c" "$head" -- "$@" </dev/null; then
      :
    else
      drc=$?
      [ "$drc" -eq 1 ] || unusable "git diff failed (exit $drc) while comparing $c with $head"
      skipped=$((skipped + 1))
      printf '%s: skipped: NOT tree-identical to HEAD under the Go lane inputs, so a run on it proves nothing\n' "$c" >>"$work/findings"
      continue
    fi
    examined=$((examined + 1))
    runs="$work/runs-$c.json"
    # No fallback on this command. If the read fails there is no evidence, and no
    # evidence is not the same thing as no failures.
    if ! gh api --paginate \
      "repos/${GITHUB_REPOSITORY}/actions/workflows/${WORKFLOW_FILE}/runs?head_sha=${c}&per_page=100" \
      </dev/null >"$runs"; then
      unusable "could not read the go.yml runs for $c (gh api failed)"
    fi
    if finding=$(sh "$0" judge "$c" "$runs" 2>"$work/judge-err"); then
      printf '%s on %s, tree-identical to %s under the Go lane inputs (E = %s; %s of %s candidate(s) examined, %s skipped as not tree-identical)\n' \
        "$finding" "$c" "$head" "$e" "$examined" "$total" "$skipped"
      exit 0
    else
      jrc=$?
      if [ "$jrc" -ne 1 ]; then
        cat "$work/judge-err" >&2
        unusable "${finding:-judge exited $jrc without a reason} [commit $c]"
      fi
      printf '%s: %s\n' "$c" "$finding" >>"$work/findings"
    fi
  done <"$work/candidates"

  considered=$(awk 'NF { n++ } END { print n + 0 }' "$work/candidates") || unusable "cannot count the considered commits"
  printf 'no successful go.yml run covers the server tree of %s\n' "$head"
  printf 'E = %s is the last commit that changed the Go lane inputs (server/, go.yml, …); %s commit(s) from E to HEAD, %s considered, %s examined, %s skipped\n' \
    "$e" "$total" "$considered" "$examined" "$skipped"
  if [ "$total" -gt "$CAP" ]; then
    printf 'the walk was CUT SHORT by the cap of %s candidates: only the %s oldest commits and HEAD were considered\n' \
      "$CAP" "$((CAP - 1))"
  fi
  cat "$work/findings"
  printf 'remedy: dispatch go.yml on main (gh workflow run go.yml --ref main), wait for it to succeed, then run auto-release again — HEAD is always a candidate\n'
  echo "go-evidence.sh: refusing: no successful go.yml run on any tree-identical commit from $e to $head" >&2
  exit 1
}

[ $# -ge 1 ] || usage
cmd=$1
shift
case $cmd in
  paths)
    [ $# -eq 0 ] || usage
    lane_paths
    ;;
  judge)
    [ $# -eq 2 ] || usage
    judge "$1" "$2"
    ;;
  require)
    [ $# -le 1 ] || usage
    require "${1:-HEAD}"
    ;;
  *)
    usage
    ;;
esac
