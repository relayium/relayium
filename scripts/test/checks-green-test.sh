#!/bin/sh
# Tests for scripts/release/checks-green.sh — the gate that decides whether
# auto-release.yml may tag `main` — and for the workflow step that feeds it.
#
# auto-release.yml publishes binaries on a schedule with nobody watching, and
# the gate it had could be passed with no evidence at all:
#
#     bad="$(gh api ".../check-runs" --jq '…non-green…' || true)"
#     if [ -n "$bad" ]; then …refuse…; fi
#
# A read that never got an answer, a red check beyond the first page of 30 and
# a commit with no checks all produced the same empty string as an all-green
# commit. The suite is built around those three, in four layers:
#
#   1. THE OLD STEP, verbatim, run against a stub `gh`: it tags in each of the
#      three situations. Kept so the refusals below read as "the hole is
#      closed", and so nobody has to take the description of the hole on trust.
#   2. The script, over fixture files: every refusal it documents, and the
#      inputs it must keep accepting.
#   3. MUTATION: each refusal is removed from a copy of the script in turn, and
#      the input it exists for must then get through. A refusal whose removal
#      nothing notices is not protecting anything.
#   4. THE NEW STEP, extracted from the workflow file as it is on disk and run
#      against the same stub `gh` — because the old hole was in the YAML, not in
#      a script, and `|| true` is one convenience edit away from coming back.
#
# Everything is offline: no network, no token, no GitHub. POSIX sh like the
# script under test; the workflow steps are run with bash because that is what
# GitHub runs them with.
#   sh scripts/test/checks-green-test.sh
#
# Lives next to its subject and runs in CI — see .github/workflows/repo-hygiene.yml.
#
# SC2016 is off for the whole file: the single-quoted strings here are test
# names that quote `tag` in backticks, sed programs whose `$runs` and `$total`
# are jq variables inside the script being mutated, and patterns that must
# reach grep with a literal `$` — none of them is a forgotten expansion.
# shellcheck disable=SC2016
set -u

HERE=$(CDPATH='' cd -P -- "$(dirname -- "$0")" && pwd -P)
ROOT="$HERE/../.."
SCRIPT="$ROOT/scripts/release/checks-green.sh"
WORKFLOW="$ROOT/.github/workflows/auto-release.yml"
WORKFLOWS_DIR="$ROOT/.github/workflows"
STEP_NAME='Require the checks on this commit to be green'

TMPROOT=$(mktemp -d "${TMPDIR:-/tmp}/checks-green-test.XXXXXX")
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

for tool in jq bash; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "checks-green-test.sh: $tool is required and was not found" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Fixture helpers. A page is what the API returns per request:
#   { "total_count": N, "check_runs": [ … ] }
# and a fixture FILE is what `gh api --paginate` writes for this endpoint — one
# such document per page, back to back, nothing merged.
# ---------------------------------------------------------------------------
cr() {
  # cr ID NAME STATUS CONCLUSION   (CONCLUSION: a word, or `null`)
  if [ "$4" = null ]; then
    printf '{"id":%s,"name":"%s","status":"%s","conclusion":null,"app":{"slug":"github-actions"}}' "$1" "$2" "$3"
  else
    printf '{"id":%s,"name":"%s","status":"%s","conclusion":"%s","app":{"slug":"github-actions"}}' "$1" "$2" "$3" "$4"
  fi
}
page() {
  # page TOTAL RUN_JSON...
  _total=$1
  shift
  _runs=''
  for _r in "$@"; do
    if [ -z "$_runs" ]; then _runs=$_r; else _runs="$_runs,$_r"; fi
  done
  printf '{"total_count":%s,"check_runs":[%s]}\n' "$_total" "$_runs"
}
fx() { printf '%s\n' "$TMPROOT/fx-$1.json"; }

# This workflow's own job, as it looks while the gate step is running.
OWN_TAG=$(cr 900 tag in_progress null)

# Two pages, all green, own job in progress on the second.
{
  page 5 "$(cr 1 build completed success)" "$(cr 2 test completed success)" "$(cr 3 lint completed success)"
  page 5 "$(cr 4 interop completed success)" "$OWN_TAG"
} >"$(fx green-2p)"

# The defect, exactly: the only red check is on page 2.
{
  page 5 "$(cr 1 build completed success)" "$(cr 2 test completed success)" "$(cr 3 lint completed success)"
  page 5 "$(cr 4 interop completed failure)" "$OWN_TAG"
} >"$(fx red-p2)"

# Same shape, still running instead of red.
{
  page 5 "$(cr 1 build completed success)" "$(cr 2 test completed success)" "$(cr 3 lint completed success)"
  page 5 "$(cr 4 interop queued null)" "$OWN_TAG"
} >"$(fx pending-p2)"

page 4 "$(cr 1 build completed success)" "$(cr 2 docs completed neutral)" \
  "$(cr 3 macos completed skipped)" "$OWN_TAG" >"$(fx neutral-skipped)"

# No own job at all (the script is also usable outside the workflow).
page 1 "$(cr 1 build completed success)" >"$(fx green-no-tag)"

# A page went missing: the API says 5, three arrived.
page 5 "$(cr 1 build completed success)" "$(cr 2 test completed success)" \
  "$(cr 3 lint completed success)" >"$(fx dropped-page)"

# More runs than the API admits to.
page 1 "$(cr 1 build completed success)" "$(cr 2 test completed success)" >"$(fx surplus)"

# The check set changed between the two requests.
{
  page 3 "$(cr 1 build completed success)" "$(cr 2 test completed success)"
  page 4 "$(cr 3 lint completed success)"
} >"$(fx total-disagrees)"

# Pages shifted under the reader: run 2 arrives twice, run 3 never does, and the
# COUNT still adds up. Only the ids give it away.
{
  page 3 "$(cr 1 build completed success)" "$(cr 2 test completed success)"
  page 3 "$(cr 2 test completed success)"
} >"$(fx shifted-page)"

page 0 >"$(fx empty-set)"
page 1 "$OWN_TAG" >"$(fx only-tag)"
# A previous auto-release run that refused this commit left a FAILED `tag` run on
# it (another check suite, same name), next to the one in progress now.
page 3 "$(cr 1 build completed success)" "$(cr 899 tag completed failure)" "$OWN_TAG" >"$(fx two-tags)"
page 2 "$(cr 899 tag completed failure)" "$OWN_TAG" >"$(fx only-tags)"

# The exclusion is the name `tag`, exactly.
page 3 "$(cr 1 build completed success)" "$(cr 2 tag-images completed failure)" "$OWN_TAG" >"$(fx tag-prefix)"
page 3 "$(cr 1 build completed success)" "$(cr 2 retag completed failure)" "$OWN_TAG" >"$(fx tag-suffix)"
page 3 "$(cr 1 build completed success)" "$(cr 2 Tag completed failure)" "$OWN_TAG" >"$(fx tag-case)"

# A conclusion without a finished status does not happen — and is not green if
# it ever does.
page 2 "$(cr 1 build in_progress success)" "$OWN_TAG" >"$(fx success-not-completed)"

# What a failed read leaves behind.
: >"$(fx empty-file)"
printf '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n</body>\r\n</html>\r\n' >"$(fx html)"
printf '{"total_count":2,"check_runs":[{"id":1,"name":"build","status":"completed","conclu' >"$(fx truncated)"
# A complete page 1 followed by a page 2 that was cut off mid-body.
{
  page 5 "$(cr 1 build completed success)" "$(cr 2 test completed success)" "$(cr 3 lint completed success)"
  printf '{"total_count":5,"check_runs":[{"id":4,"name":"interop","status":"compl'
} >"$(fx truncated-p2)"
# What gh really writes to stdout on an HTTP error (observed: 401, 422).
printf '{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest","status":"401"}\n' >"$(fx api-error)"
printf '{"check_runs":[%s]}\n' "$(cr 1 build completed success)" >"$(fx no-total)"
printf '{"total_count":1}\n' >"$(fx no-runs)"
printf '{"total_count":"1","check_runs":[%s]}\n' "$(cr 1 build completed success)" >"$(fx string-total)"
printf '[]\n' >"$(fx array-root)"
printf 'null\n' >"$(fx null-root)"
printf '{"total_count":1,"check_runs":["build"]}\n' >"$(fx run-not-object)"
printf '{"total_count":1,"check_runs":[{"id":1,"status":"completed","conclusion":"success"}]}\n' >"$(fx run-no-name)"
printf '{"total_count":1,"check_runs":[{"name":"build","status":"completed","conclusion":"success"}]}\n' >"$(fx run-no-id)"

for conclusion in failure cancelled timed_out action_required stale startup_failure; do
  page 2 "$(cr 1 build completed "$conclusion")" "$OWN_TAG" >"$(fx "c-$conclusion")"
done

check() {
  # check FIXTURE_NAME [SCRIPT] → sets $out and $rc; stderr in $TMPROOT/err
  out=$(sh "${2:-$SCRIPT}" "$(fx "$1")" 2>"$TMPROOT/err")
  rc=$?
}

# ---------------------------------------------------------------------------
# A stub `gh` and `git`, so that workflow steps can be run as written.
#
# The stub answers the one call the gate makes, the way the real CLI was
# observed to: WITHOUT --paginate only the first page comes back (that is the
# endpoint's default page of 30); WITH it, every page, one document after
# another; `--jq` filters each page; a transport failure prints to stderr,
# nothing to stdout, and exits 1.
# ---------------------------------------------------------------------------
STUB_BIN="$TMPROOT/bin"
mkdir -p "$STUB_BIN"
cat >"$STUB_BIN/gh" <<'STUB'
#!/bin/sh
# GH_STUB_MODE: ok | transport | http-error | dies-after-page-1 | drops-page-2
# GH_STUB_PAGES: newline-separated list of page files.
printf '%s\n' "$*" >>"$GH_STUB_LOG"
paginate=0
filter=''
while [ $# -gt 0 ]; do
  case $1 in
    --paginate) paginate=1 ;;
    --jq)
      shift
      filter=$1
      ;;
  esac
  shift
done
emit() {
  if [ -n "$filter" ]; then jq -r "$filter" "$1"; else cat "$1"; fi
}
first=$(printf '%s\n' "$GH_STUB_PAGES" | sed -n 1p)
case ${GH_STUB_MODE:-ok} in
  transport)
    echo 'Get "https://api.github.com/…/check-runs": dial tcp: i/o timeout' >&2
    exit 1
    ;;
  http-error)
    printf '{"message":"API rate limit exceeded","documentation_url":"https://docs.github.com/rest","status":"403"}\n'
    echo 'gh: API rate limit exceeded (HTTP 403)' >&2
    exit 1
    ;;
  dies-after-page-1)
    emit "$first"
    echo 'gh: HTTP 502' >&2
    exit 1
    ;;
  drops-page-2)
    emit "$first"
    exit 0
    ;;
esac
if [ "$paginate" -eq 1 ]; then
  printf '%s\n' "$GH_STUB_PAGES" | while IFS= read -r p; do
    [ -n "$p" ] && emit "$p"
  done
else
  emit "$first"
fi
STUB
cat >"$STUB_BIN/git" <<'STUB'
#!/bin/sh
# The gate step asks git exactly one thing.
if [ "$*" = 'rev-parse HEAD' ]; then
  echo 0123456789abcdef0123456789abcdef01234567
  exit 0
fi
echo "stub git: unexpected call: $*" >&2
exit 97
STUB
chmod +x "$STUB_BIN/gh" "$STUB_BIN/git"

# Single pages for the stub to serve.
page 5 "$(cr 1 build completed success)" "$(cr 2 test completed success)" "$(cr 3 lint completed success)" >"$TMPROOT/p1-green.json"
page 5 "$(cr 4 interop completed success)" "$OWN_TAG" >"$TMPROOT/p2-green.json"
page 5 "$(cr 4 interop completed failure)" "$OWN_TAG" >"$TMPROOT/p2-red.json"
page 5 "$(cr 4 interop in_progress null)" "$OWN_TAG" >"$TMPROOT/p2-pending.json"
page 1 "$OWN_TAG" >"$TMPROOT/p-only-tag.json"
NL='
'

run_step() {
  # run_step STEP_FILE MODE PAGE_FILE... → sets $rc, $log, $summary, $ghlog
  _step=$1
  _mode=$2
  shift 2
  _pages=''
  for _p in "$@"; do
    if [ -z "$_pages" ]; then _pages=$_p; else _pages="$_pages$NL$_p"; fi
  done
  : >"$TMPROOT/summary"
  : >"$TMPROOT/ghlog"
  # GitHub runs a `run:` block as `bash --noprofile --norc -eo pipefail {0}`,
  # from the repository root.
  (
    cd "$ROOT" &&
      PATH="$STUB_BIN:$PATH" \
        GH_STUB_MODE="$_mode" GH_STUB_PAGES="$_pages" GH_STUB_LOG="$TMPROOT/ghlog" \
        GH_TOKEN=unused GITHUB_REPOSITORY=relayium/relayium \
        GITHUB_STEP_SUMMARY="$TMPROOT/summary" \
        bash --noprofile --norc -eo pipefail "$_step"
  ) >"$TMPROOT/steplog" 2>&1
  rc=$?
  log=$(cat "$TMPROOT/steplog")
  summary=$(cat "$TMPROOT/summary")
  ghlog=$(cat "$TMPROOT/ghlog")
}

# ---------------------------------------------------------------------------
# 1. The old step. This is its `run:` block character for character, as it
#    stood before checks-green.sh existed, with only the final `exit 0` added
#    so that "fell through to the tagging steps" is observable.
# ---------------------------------------------------------------------------
echo 'the gate this replaces (kept as evidence of the hole)'
cat >"$TMPROOT/legacy-step.sh" <<'LEGACY'
set -euo pipefail
sha="$(git rev-parse HEAD)"
# A check that is queued or in progress counts as not-green: the point
# is to release something already verified, not to race it.
bad="$(gh api "repos/${GITHUB_REPOSITORY}/commits/${sha}/check-runs" \
         --jq '.check_runs[]
               | select(.name != "tag")
               | select(.conclusion != "success" and .conclusion != "neutral" and .conclusion != "skipped")
               | "\(.name): \(.status)/\(.conclusion // "pending")"' || true)"
if [ -n "$bad" ]; then
  {
    echo "### Release withheld — checks are not green on \`$sha\`"
    echo '```'
    printf '%s\n' "$bad"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
  echo "::error::main is not green; refusing to tag it"
  exit 1
fi
exit 0
LEGACY
run_step "$TMPROOT/legacy-step.sh" ok "$TMPROOT/p1-green.json" "$TMPROOT/p2-red.json"
assert_rc 'OLD gate: a red check on page 2 is never seen, and the commit is tagged' "$rc" 0
run_step "$TMPROOT/legacy-step.sh" ok "$TMPROOT/p1-green.json" "$TMPROOT/p2-pending.json"
assert_rc 'OLD gate: a still-running check on page 2 is never seen either' "$rc" 0
run_step "$TMPROOT/legacy-step.sh" transport "$TMPROOT/p1-green.json"
assert_rc 'OLD gate: a read that fails with no answer tags the commit' "$rc" 0
run_step "$TMPROOT/legacy-step.sh" ok "$TMPROOT/p-only-tag.json"
assert_rc 'OLD gate: a commit nothing has checked is tagged' "$rc" 0
# Sanity: the transcription is not simply incapable of refusing.
page 2 "$(cr 1 build completed failure)" "$OWN_TAG" >"$TMPROOT/p-red-on-1.json"
run_step "$TMPROOT/legacy-step.sh" ok "$TMPROOT/p-red-on-1.json"
assert_rc 'OLD gate: it did refuse a red check it could see' "$rc" 1

# ---------------------------------------------------------------------------
# 2. The script.
# ---------------------------------------------------------------------------
echo 'green'
check green-2p
assert_rc 'all green across two pages passes' "$rc" 0
assert_has 'the verdict says how many runs were examined' "$out" '4 check runs green'
assert_has 'the verdict names total_count and the page count' "$out" 'total_count 5 across 2 page(s)'
check neutral-skipped
assert_rc 'neutral and skipped are accepted' "$rc" 0
check green-no-tag
assert_rc 'a green set with no `tag` job passes' "$rc" 0
check two-tags
assert_rc 'an earlier refused `tag` run on the same commit does not block the retry' "$rc" 0

echo 'not green'
check red-p2
assert_rc 'a red check that exists only on page 2 refuses' "$rc" 1
assert_eq 'and is named, in the format the summary has always used' "$out" 'interop: completed/failure'
check pending-p2
assert_rc 'a queued check (null conclusion) refuses' "$rc" 1
assert_eq 'and is named as pending' "$out" 'interop: queued/pending'
for conclusion in failure cancelled timed_out action_required stale startup_failure; do
  check "c-$conclusion"
  assert_rc "conclusion [$conclusion] refuses" "$rc" 1
  assert_eq "conclusion [$conclusion] is named" "$out" "build: completed/$conclusion"
done
check success-not-completed
assert_rc 'a success conclusion on a run that is not completed refuses' "$rc" 1

echo 'the `tag` exclusion is exactly the name `tag`'
check green-2p
assert_lacks 'the own `tag` job in progress is ignored' "$out" 'tag:'
for f in tag-prefix:tag-images tag-suffix:retag tag-case:Tag; do
  check "${f%%:*}"
  assert_rc "a red check named [${f#*:}] is not excluded" "$rc" 1
  assert_eq "a red check named [${f#*:}] is named" "$out" "${f#*:}: completed/failure"
done

echo 'unusable evidence refuses (never "nothing is red")'
for f in \
  'empty-file:the check-runs response is empty' \
  'html:not valid JSON' \
  'truncated:not valid JSON' \
  'truncated-p2:not valid JSON' \
  'api-error:no numeric total_count' \
  'no-total:no numeric total_count' \
  'string-total:no numeric total_count' \
  'no-runs:no check_runs array' \
  'array-root:not a JSON object' \
  'null-root:not a JSON object' \
  'run-not-object:no usable id, name, status or conclusion' \
  'run-no-name:no usable id, name, status or conclusion' \
  'run-no-id:no usable id, name, status or conclusion' \
  'dropped-page:examined 3 check runs across 1 page(s) but the API reports total_count 5' \
  'surplus:examined 2 check runs across 1 page(s) but the API reports total_count 1' \
  'total-disagrees:pages disagree on total_count (3, 4)' \
  'shifted-page:appears more than once' \
  'empty-set:nothing has verified it' \
  'only-tag:nothing has verified it' \
  'only-tags:nothing has verified it'; do
  check "${f%%:*}"
  assert_rc "[${f%%:*}] refuses as unusable" "$rc" 3
  assert_has "[${f%%:*}] says why" "$out" "${f#*:}"
done

out=$(sh "$SCRIPT" "$TMPROOT/does-not-exist.json" 2>"$TMPROOT/err")
assert_rc 'a missing file refuses' "$?" 3
out=$(sh "$SCRIPT" "$TMPROOT" 2>"$TMPROOT/err")
assert_rc 'a directory refuses' "$?" 3
out=$(sh "$SCRIPT" 2>"$TMPROOT/err")
assert_rc 'no argument is a usage error, not a pass' "$?" 2
out=$(sh "$SCRIPT" "$(fx green-2p)" "$(fx green-2p)" 2>"$TMPROOT/err")
assert_rc 'two arguments is a usage error, not a pass' "$?" 2
# Without jq nothing can be established. PATH keeps only what the script needs
# before it reaches for jq.
mkdir -p "$TMPROOT/nojq"
for t in sh mktemp rm head; do
  tp=$(command -v "$t") && ln -s "$tp" "$TMPROOT/nojq/$t"
done
out=$(PATH="$TMPROOT/nojq" sh "$SCRIPT" "$(fx green-2p)" 2>"$TMPROOT/err")
assert_rc 'a runner without jq refuses' "$?" 3

# ---------------------------------------------------------------------------
# 3. Mutation. Every probe copies the script, removes one refusal with sed, and
#    requires two things: the edit really changed the file (a no-op mutation
#    exercises nothing), and the fixture that refusal exists for no longer gets
#    the verdict the suite above demands — i.e. the suite would go red.
# ---------------------------------------------------------------------------
echo 'mutation probes'
mutant_n=0
probe() {
  # probe LABEL FIXTURE WANT_RC WANT_TEXT SED_EXPR...
  _label=$1
  _fixture=$2
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
  check "$_fixture"
  case $out in *"$_want_text"*) _orig_text=yes ;; *) _orig_text=no ;; esac
  if [ "$rc" != "$_want_rc" ] || [ "$_orig_text" = no ]; then
    bad "mutation '$_label': the unmutated script does not meet the expectation being probed"
    return
  fi
  check "$_fixture" "$_m"
  case $out in *"$_want_text"*) _mut_text=yes ;; *) _mut_text=no ;; esac
  if [ "$rc" = "$_want_rc" ] && [ "$_mut_text" = yes ]; then
    bad "mutation '$_label' is caught (the mutant still gives rc=$rc on [$_fixture])"
  else
    ok "mutation '$_label' is caught ([$_fixture]: want rc=$_want_rc, mutant rc=$rc)"
  fi
}

# The sed programs below are single-quoted on purpose: `$runs`, `$total` and
# `$judged` are jq variables in the script being edited, not shell variables.
{
  probe 'the count check is dropped' dropped-page 3 'total_count 5' \
    's/elif (\$runs | length) != \$total then/elif false then/'
  probe 'the count check is dropped (surplus runs)' surplus 3 'total_count 1' \
    's/elif (\$runs | length) != \$total then/elif false then/'
  probe 'only the first document is read' red-p2 1 'interop: completed/failure' \
    's/\[\.\[\]\.check_runs\[\]\] as \$runs/[.[0].check_runs[]] as $runs/'
  probe 'only the first document is read AND the count check is dropped' red-p2 1 'interop: completed/failure' \
    's/\[\.\[\]\.check_runs\[\]\] as \$runs/[.[0].check_runs[]] as $runs/' \
    's/elif (\$runs | length) != \$total then/elif false then/'
  probe 'the pages are no longer slurped' green-2p 0 '4 check runs green' \
    's/jq -rs /jq -r /'
  probe 'pages may disagree on total_count' total-disagrees 3 'pages disagree' \
    's/elif (\[\.\[\]\.total_count\] | unique | length) != 1 then/elif false then/'
  probe 'a run may appear twice' shifted-page 3 'more than once' \
    's/elif (\$runs | map(\.id) | unique | length) != (\$runs | length) then/elif false then/'
  probe 'the empty-set check is dropped (only the own job)' only-tag 3 'nothing has verified it' \
    's/if (\$judged | length) == 0 then/if false then/'
  probe 'the empty-set check is dropped (no runs at all)' empty-set 3 'nothing has verified it' \
    's/if (\$judged | length) == 0 then/if false then/'
  probe 'a null conclusion counts as green' pending-p2 1 'interop: queued/pending' \
    's/def green: \.status == "completed" and (/def green: (.conclusion == null or /'
  probe 'the completed-status requirement is dropped' success-not-completed 1 'build: in_progress/success' \
    's/def green: \.status == "completed" and (/def green: (/'
  probe 'failure is added to the green conclusions' c-failure 1 'build: completed/failure' \
    's/\.conclusion == "skipped")/.conclusion == "skipped" or .conclusion == "failure")/'
  probe 'the `tag` exclusion becomes a prefix match' tag-prefix 1 'tag-images: completed/failure' \
    's/select(\.name != "tag")/select(.name | startswith("tag") | not)/'
  probe 'the `tag` exclusion becomes a substring match' tag-suffix 1 'retag: completed/failure' \
    's/select(\.name != "tag")/select(.name | contains("tag") | not)/'
  probe 'the `tag` exclusion is removed' green-2p 0 '4 check runs green' \
    's/select(\.name != "tag")/select(true)/'
  probe 'an empty response is no longer refused up front' empty-file 3 'response is empty' \
    's/^\[ -s "\$file" \] || unusable .*$/:/'
  probe 'an unrecognised verdict passes' html 3 'not valid JSON' \
    's/^if ! out=\$(jq /if false \&\& ! out=$(jq /' \
    's/^set -eu$/set -e; out=""/' \
    's/^    unusable "internal error: unrecognised verdict from jq"$/    exit 0/'
}

# ---------------------------------------------------------------------------
# 4. The step in auto-release.yml, as it is on disk.
# ---------------------------------------------------------------------------
echo 'auto-release.yml: the gate step, executed'
# The step: from its `- name:` line up to the next step.
awk -v name="      - name: $STEP_NAME" '
  $0 == name { instep = 1; print; next }
  instep && /^      - / { exit }
  instep { print }
' "$WORKFLOW" >"$TMPROOT/step.yml"
# Its `run: |` body, dedented.
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
# Nothing GitHub would have to substitute first: the block is runnable as-is,
# and no expression is interpolated into a script on the release path.
if grep -q '\${{' "$TMPROOT/step.sh"; then
  bad 'the run block contains no ${{ }} expression'
else
  ok 'the run block contains no ${{ }} expression'
fi

run_step "$TMPROOT/step.sh" ok "$TMPROOT/p1-green.json" "$TMPROOT/p2-green.json"
assert_rc 'all green across two pages: the step passes' "$rc" 0
assert_has 'it asked for every page' "$ghlog" '--paginate'
assert_has 'it asked for the largest page size' "$ghlog" 'per_page=100'
assert_has 'it asked about the commit it is about to tag' "$ghlog" \
  'repos/relayium/relayium/commits/0123456789abcdef0123456789abcdef01234567/check-runs'
assert_lacks 'it did not switch to filter=all' "$ghlog" 'filter='
assert_has 'a pass is written down too' "$summary" '4 check runs green'
assert_lacks 'a pass raises no error' "$log" '::error::'

run_step "$TMPROOT/step.sh" ok "$TMPROOT/p1-green.json" "$TMPROOT/p2-red.json"
assert_rc 'a red check only on page 2: the step refuses' "$rc" 1
assert_has 'loudly' "$log" '::error::main is not green; refusing to tag it'
assert_has 'with the heading the summary has always had' "$summary" \
  '### Release withheld — checks are not green on `0123456789abcdef0123456789abcdef01234567`'
assert_has 'and the check named in it' "$summary" 'interop: completed/failure'

run_step "$TMPROOT/step.sh" ok "$TMPROOT/p1-green.json" "$TMPROOT/p2-pending.json"
assert_rc 'a check still running on page 2: the step refuses' "$rc" 1
assert_has 'and names it as pending' "$summary" 'interop: in_progress/pending'

run_step "$TMPROOT/step.sh" transport "$TMPROOT/p1-green.json" "$TMPROOT/p2-green.json"
assert_rc 'the read fails with no answer: the step refuses' "$rc" 1
assert_has 'loudly' "$log" '::error::could not read the check runs'
assert_has 'and says so in the summary' "$summary" 'Release withheld — the check runs could not be read'

run_step "$TMPROOT/step.sh" http-error "$TMPROOT/p1-green.json" "$TMPROOT/p2-green.json"
assert_rc 'the API answers with an error: the step refuses' "$rc" 1
assert_has 'loudly' "$log" '::error::could not read the check runs'

run_step "$TMPROOT/step.sh" dies-after-page-1 "$TMPROOT/p1-green.json" "$TMPROOT/p2-red.json"
assert_rc 'the read dies after a complete, all-green page 1: the step refuses' "$rc" 1
assert_has 'loudly' "$log" '::error::could not read the check runs'

# gh reports success but a page never arrived. Only total_count can tell.
run_step "$TMPROOT/step.sh" drops-page-2 "$TMPROOT/p1-green.json" "$TMPROOT/p2-red.json"
assert_rc 'a page silently missing from a "successful" read: the step refuses' "$rc" 1
assert_has 'loudly' "$log" '::error::could not establish that main is green'
assert_has 'and says which evidence was short' "$summary" 'examined 3 check runs across 1 page(s) but the API reports total_count 5'

run_step "$TMPROOT/step.sh" ok "$TMPROOT/p-only-tag.json"
assert_rc 'a commit nothing has checked: the step refuses' "$rc" 1
assert_has 'and says so' "$summary" 'nothing has verified it'

echo 'auto-release.yml: the gate step, read'
# Comment lines are dropped first: the step explains at length what it must not
# do, and saying `|| true` is not doing it.
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
step_lacks 'no `|| true` (or `|| :`) anywhere in the gate step' '\|\|[[:space:]]*(true|:)([[:space:]]|[;)"]|$)'
step_lacks 'no continue-on-error on the gate step' 'continue-on-error'
step_lacks 'the decision is not made by a --jq filter in the YAML' '--jq'
step_lacks 'the check-runs filter is left at its default (latest)' 'filter='
step_has 'the gate step calls scripts/release/checks-green.sh' 'sh scripts/release/checks-green\.sh "\$runs"'
step_has 'the fetch requests pagination' 'gh api --paginate'
step_has 'the fetch requests 100 runs per page' 'check-runs\?per_page=100'
step_has 'the gate step runs with set -euo pipefail' '^[[:space:]]*set -euo pipefail$'

# A gate that does not run when the tagging step does is not a gate.
gate_if=$(grep -E '^        if: ' "$TMPROOT/step.yml" | head -n 1)
tag_if=$(awk '
  $0 == "      - name: Tag it" { instep = 1; next }
  instep && /^      - / { exit }
  instep && /^        if: / { print; exit }
' "$WORKFLOW")
if [ -n "$gate_if" ] && [ "$gate_if" = "$tag_if" ]; then
  ok 'the gate runs under exactly the condition the tagging step runs under'
else
  bad "the gate runs under exactly the condition the tagging step runs under (gate=[$gate_if] tag=[$tag_if])"
fi
line_of() {
  # line_of FIXED_STRING → first matching line number, or empty
  grep -n -F -- "$1" "$WORKFLOW" | head -n 1 | cut -d: -f1
}
gate_line=$(line_of "- name: $STEP_NAME")
tag_line=$(line_of 'git tag -a')
push_line=$(line_of 'git push origin')
dispatch_line=$(line_of 'gh workflow run release.yml')
if [ -n "$gate_line" ] && [ -n "$tag_line" ] && [ -n "$push_line" ] && [ -n "$dispatch_line" ] &&
  [ "$gate_line" -lt "$tag_line" ] && [ "$gate_line" -lt "$push_line" ] && [ "$gate_line" -lt "$dispatch_line" ]; then
  ok 'the gate runs before the tag is created, pushed or built'
else
  bad "the gate runs before the tag is created, pushed or built (gate=$gate_line tag=$tag_line push=$push_line dispatch=$dispatch_line)"
fi

# ---------------------------------------------------------------------------
# The exclusion is a NAME. GitHub names a check run after the job — its `name:`
# if it has one, its id otherwise — so any other job called `tag`, in any
# workflow, would be excluded from the gate along with this one, red or not.
# And if auto-release's own job stopped being called `tag`, the gate would see
# itself in progress and refuse every release.
# ---------------------------------------------------------------------------
echo 'nothing else may be called `tag`'
jobs_called_tag() {
  # jobs_called_tag FILE → prints a line per job whose check run would be `tag`
  awk '
    /^jobs:[[:space:]]*$/ { injobs = 1; next }
    injobs && /^[^[:space:]#]/ { injobs = 0 }
    !injobs { next }
    /^  [A-Za-z0-9_-]+:[[:space:]]*(#.*)?$/ {
      if (id != "" && ((named == "" && id == "tag") || named == "tag")) print FILENAME ": job " id
      id = $1; sub(/:.*$/, "", id); named = ""
      next
    }
    /^    name:/ {
      named = $0
      sub(/^    name:[[:space:]]*/, "", named)
      sub(/[[:space:]]*(#.*)?$/, "", named)
      gsub(/^["\047]|["\047]$/, "", named)
    }
    END { if (id != "" && ((named == "" && id == "tag") || named == "tag")) print FILENAME ": job " id }
  ' "$1"
}
others=''
for wf in "$WORKFLOWS_DIR"/*.yml "$WORKFLOWS_DIR"/*.yaml; do
  [ -f "$wf" ] || continue
  [ "$wf" = "$WORKFLOWS_DIR/auto-release.yml" ] && continue
  found=$(jobs_called_tag "$wf")
  [ -n "$found" ] && others="$others$found$NL"
done
if [ -z "$others" ]; then
  ok 'no other workflow declares a job whose check run would be named `tag`'
else
  bad 'no other workflow declares a job whose check run would be named `tag`'
  printf '%s' "$others" | sed 's/^/       | /'
fi
own=$(jobs_called_tag "$WORKFLOW" | grep -c .)
assert_eq "auto-release.yml's own job is still the one check run named \`tag\`" "$own" 1
# The detector itself, so that "found nothing" above means something.
printf 'name: x\non: push\njobs:\n  build:\n    name: tag\n    runs-on: x\n  other:\n    runs-on: x\n' >"$TMPROOT/wf-named.yml"
printf 'name: x\non: push\njobs:\n  build:\n    runs-on: x\n  tag:\n    runs-on: x\n' >"$TMPROOT/wf-id.yml"
printf 'name: tag\non:\n  push:\n    tags: [tag]\njobs:\n  tagger:\n    name: tag images\n    runs-on: x\n' >"$TMPROOT/wf-clean.yml"
assert_eq 'the detector sees a job NAMED tag' "$(jobs_called_tag "$TMPROOT/wf-named.yml" | grep -c .)" 1
assert_eq 'the detector sees a job with the ID tag' "$(jobs_called_tag "$TMPROOT/wf-id.yml" | grep -c .)" 1
assert_eq 'the detector is quiet about a workflow that merely mentions tag' "$(jobs_called_tag "$TMPROOT/wf-clean.yml" | grep -c .)" 0

if [ "$fail" -eq 0 ]; then
  echo 'all checks-green tests passed'
else
  echo 'checks-green tests FAILED'
fi
exit "$fail"
