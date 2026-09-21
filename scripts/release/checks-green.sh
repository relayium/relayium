#!/bin/sh
# checks-green.sh — may auto-release.yml tag this commit, judged from the check
# runs GitHub reports for it.
#
# WHAT THIS GUARDS AGAINST
# ------------------------
# auto-release.yml publishes binaries from `main` on a schedule, with nobody
# watching. Its own header calls the green-CI gate "load-bearing, not
# decorative" — and the gate it had could be passed without any evidence at all:
#
#     bad="$(gh api ".../commits/${sha}/check-runs" --jq '…non-green…' || true)"
#     if [ -n "$bad" ]; then …refuse…; fi
#
#   1. `|| true` turned a FAILED read into an empty string, and an empty string
#      meant "nothing is red". A request that never got an answer — DNS, TLS, a
#      timeout, a dropped connection — tagged the release. (An HTTP error that
#      carries a JSON body happened to refuse, but only because gh echoes that
#      body to stdout and it landed in `$bad`: an accident of one tool's output,
#      not a decision.)
#   2. The endpoint returns 30 runs per page and `main` carries more than that
#      (49 when this was written). Only page 1 was ever read, so a red or
#      still-running check on page 2 did not exist as far as the gate knew.
#   3. A commit with no check runs at all produced the same empty string as a
#      commit with every check green.
#
# All three fail OPEN, on the one path in this repository that ships artifacts
# to users without a human in it. So the rule here is the opposite one: the
# release is refused unless this script can positively account for every run
# the API says exists, and every one of them is green.
#
# INPUT
# -----
#     checks-green.sh FILE
#
# FILE is the raw output of
#
#     gh api --paginate "repos/OWNER/REPO/commits/SHA/check-runs?per_page=100"
#
# For this object-rooted endpoint `--paginate` does not merge anything: it
# writes one JSON document per page, back to back, each of the shape
# `{ "total_count": N, "check_runs": [ … ] }` with the SAME N on every page.
# That is exactly what is parsed here (`jq -s` reads the documents into one
# array). `gh api --slurp` would produce that array itself, but it only exists
# from gh 2.48 and nothing here needs it.
#
# The fetch deliberately stays outside this script: it needs a token and a
# network, and keeping it out is what lets every refusal below be tested offline
# from fixture files (scripts/test/checks-green-test.sh).
#
# The endpoint's default `filter=latest` is relied on, not overridden: after a
# re-run it reports the newest attempt of a check instead of the failed one it
# replaced. `filter=all` would make one flaky attempt block a release forever.
#
# VERDICT
# -------
#     exit 0   green. stdout: one line saying how many runs were examined.
#     exit 1   at least one run is not green. stdout: one line per offender,
#              `name: status/conclusion` (`pending` when there is no conclusion
#              yet) — the same lines the workflow has always put in its summary.
#     exit 3   the evidence is unusable, so greenness was never established:
#              missing, unreadable or empty file; not JSON (an HTML error page,
#              a truncated body); a page without `total_count` or `check_runs`
#              (an API error body looks like that); pages that disagree on
#              `total_count`; fewer or more runs than `total_count`, or the same
#              run twice (a dropped or shifted page); a run without an id, name
#              or status; or no run at all besides this workflow's own job.
#              stdout: one line with the reason.
#     exit 2   usage.
#
# Anything this script does not recognise as green ends in a refusal, including
# its own failures: there is no code path from "jq could not run" or "jq printed
# something unexpected" to exit 0.
#
# GREEN means status `completed` AND conclusion `success`, `neutral` or
# `skipped`. Queued and in-progress runs have a null conclusion and are not
# green: the point is to release something already verified, not to race it.
#
# THE ONE EXCLUSION is the run named exactly `tag` — auto-release.yml's own job,
# which is necessarily in progress while it asks this question. It is matched by
# name and nothing narrower ON PURPOSE: a previous auto-release run that refused
# this same commit left a FAILED `tag` run on it, in a different check suite, and
# matching only "my own run id" would let that refusal block every retry until
# someone pushed a new commit. The cost is that any other job named `tag`, in
# any workflow, would be invisible here; scripts/test/checks-green-test.sh
# fails if one is ever declared.
#
# POSIX sh; needs jq (preinstalled on GitHub's ubuntu runners). Used by
# .github/workflows/auto-release.yml and covered by
# scripts/test/checks-green-test.sh (run in repo-hygiene.yml).
set -eu

usage() {
  echo "usage: $0 CHECK_RUNS_JSON_FILE" >&2
  exit 2
}

# unusable REASON — the evidence cannot establish anything. The reason goes to
# stdout for the caller's step summary and to stderr for the log.
unusable() {
  printf 'check-runs evidence unusable: %s\n' "$1"
  printf 'checks-green.sh: refusing: %s\n' "$1" >&2
  exit 3
}

[ $# -eq 1 ] || usage
file=$1

[ -f "$file" ] || unusable "no such file: $file"
[ -r "$file" ] || unusable "cannot read $file"
# An empty body is what a fetch that died before the first byte leaves behind.
[ -s "$file" ] || unusable "the check-runs response is empty"
command -v jq >/dev/null 2>&1 || unusable "jq is not installed"

tmp=$(mktemp "${TMPDIR:-/tmp}/checks-green.XXXXXX")
trap 'rm -f "$tmp"' EXIT

# The whole decision is one jq program over ALL pages at once. It answers with a
# verdict word on the first line — `green`, `red` or `unusable` — and the detail
# after it. Each refusal is a separate, single-line branch so that the test
# suite can remove them one at a time and prove each one is load-bearing.
#
# `-s` is part of the decision, not a convenience: without it jq would run the
# program once per page and could report on page 1 before failing to parse a
# truncated page 2. Slurped, a parse error anywhere yields no verdict at all.
# shellcheck disable=SC2016 # a jq program, not shell: $names are jq variables
program='
def green: .status == "completed" and (.conclusion == "success" or .conclusion == "neutral" or .conclusion == "skipped");
def wellformed: type == "object" and (.id | type) == "number" and (.name | type) == "string" and (.status | type) == "string" and ((.conclusion | type) == "string" or .conclusion == null);
def unusable(reason): "unusable", reason;
if length == 0 then unusable("the response contains no JSON document")
elif any(.[]; type != "object") then unusable("a page is not a JSON object")
elif any(.[]; (.total_count | type) != "number") then unusable("a page has no numeric total_count (an API error body looks like this)")
elif any(.[]; (.check_runs | type) != "array") then unusable("a page has no check_runs array")
elif ([.[].total_count] | unique | length) != 1 then unusable("pages disagree on total_count (\([.[].total_count] | map(tostring) | join(", "))): the check set changed while it was being read")
else
  .[0].total_count as $total
  | [.[].check_runs[]] as $runs
  | if any($runs[]; wellformed | not) then unusable("a check run has no usable id, name, status or conclusion")
    elif ($runs | length) != $total then unusable("examined \($runs | length) check runs across \(length) page(s) but the API reports total_count \($total): a page is missing")
    elif ($runs | map(.id) | unique | length) != ($runs | length) then unusable("the same check run appears more than once: pages shifted while they were being read")
    else
      [$runs[] | select(.name != "tag")] as $judged
      | if ($judged | length) == 0 then unusable("no check runs on this commit apart from the `tag` job of this workflow: nothing has verified it")
        else
          [$judged[] | select(green | not)] as $bad
          | if ($bad | length) > 0 then "red", ($bad[] | "\(.name): \(.status)/\(.conclusion // "pending")")
            else "green", "\($judged | length) check runs green (total_count \($total) across \(length) page(s); \($total - ($judged | length)) own `tag` job(s) excluded)"
            end
        end
    end
end
'

if ! out=$(jq -rs "$program" "$file" 2>"$tmp"); then
  unusable "the check-runs response is not valid JSON ($(head -n 1 "$tmp"))"
fi

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
    [ -n "$detail" ] || unusable "internal error: a green verdict without a count"
    printf '%s\n' "$detail"
    exit 0
    ;;
  red)
    [ -n "$detail" ] || unusable "internal error: a red verdict that names no check"
    printf '%s\n' "$detail"
    echo "checks-green.sh: refusing: checks are not green" >&2
    exit 1
    ;;
  unusable)
    unusable "${detail:-no reason given}"
    ;;
  *)
    unusable "internal error: unrecognised verdict from jq"
    ;;
esac
