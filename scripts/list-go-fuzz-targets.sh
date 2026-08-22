#!/usr/bin/env bash
#
# list-go-fuzz-targets.sh — every Go fuzz target in the server module, derived.
#
# `go-fuzz-nightly.yml` runs one isolated job per fuzz target, and the list of
# targets is the one part of that arrangement nothing else can check. A
# hand-maintained list in the workflow would keep working forever: a target
# added and never listed is simply never fuzzed, every listed job stays green,
# and the only signal is the crash that campaign would have found. So the list
# is DERIVED here — from `go list` for the packages and `go test -list` for the
# targets inside them — and the workflow consumes what this prints.
#
# It fails closed, because the failure mode of a discovery step is silence:
#
#   * a `go` command that fails, so a build break cannot read as "no targets";
#   * zero targets found, which is either a deleted suite or a broken parse;
#   * a name that is not a well-formed `FuzzXxx`, or a package path that is not
#     a well-formed import path — those are ordinary test output (a `--- FAIL`
#     line, a build error, a `testing:` warning) being mistaken for a target,
#     and they would become a shell command in the campaign job;
#   * a duplicate (package, target) pair, which would run one target twice and
#     collide two jobs' artifact names;
#   * two distinct pairs whose generated matrix IDs collide. The ID flattens the
#     package path's separators, and that mapping is not injective — `a/b-c` and
#     `a-b/c` both become `a-b-c` — so unique pairs do not imply unique IDs, and
#     the ID is what names the job and its crasher artifact.
#
# It never fuzzes anything. Discovery has to be cheap and finite; the campaign
# has its own bounded budget per target.
#
# Usage:
#   scripts/list-go-fuzz-targets.sh            # human-readable, one per line
#   scripts/list-go-fuzz-targets.sh --json     # {"include":[…]} for an Actions matrix
#   scripts/list-go-fuzz-targets.sh --self-test  # prove the fail-closed checks fail
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: list-go-fuzz-targets.sh [--json|--self-test|--help]

  (no flag)   one "<target>  <package>" line per target, then a count.
  --json      a single-line GitHub Actions matrix object:
              {"include":[{"package":…,"target":…,"id":…}]}
  --self-test run this script against a fake `go`, and require the id-collision
              check to reject a package set the real module cannot produce.
              Compiles nothing and reads no Go source.
USAGE
}

MODE=human
case "${1-}" in
  "") ;;
  --json) MODE=json ;;
  --self-test) MODE='self-test' ;;
  -h|--help) usage; exit 0 ;;
  *) echo "list-go-fuzz-targets.sh: unknown argument $1" >&2; usage >&2; exit 2 ;;
esac

# Resolved from this script's own location, not from $PWD, so the campaign job,
# a developer shell and a pre-commit hook all enumerate the same module.
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$SCRIPT_DIR")"
MODULE_DIR="$REPO_ROOT/server"

# ── --self-test: the collision shape, against a `go` that can produce it ─────
#
# The id-collision check below is unfalsifiable against this repository: the
# real module has no two packages whose flattened paths collide, so the check
# is dead code that has never once been observed to fail — which is the same
# state a BROKEN check would be in. Adding a colliding pair of packages to
# `server/` to prove otherwise would leave a permanent oddity in production
# source for a test's benefit.
#
# So the proof runs against a FAKE `go`: one that answers the three questions
# this script asks — `go list -m`, `go list ./...`, `go test -list` — from a
# fixture, compiles nothing and reads no Go source. This script is then invoked
# for real, as a child process, with that `go` first on PATH; nothing about the
# code under test is stubbed or re-implemented here.
#
# Two cases, and the second is what makes the first mean anything: the same
# fixture with the collision removed must SUCCEED, and produce exactly the two
# ids expected. Without that control, a script that failed unconditionally — a
# typo in the fixture, a fake `go` that does not run — would pass case one and
# report the check working.
# Not `local`: the EXIT trap below runs after self_test has returned, when a
# local would already be out of scope — and `set -u` would then turn cleanup
# into a spurious failure that arrives AFTER the cases have all reported.
SELFTEST_DIR=""
self_test() {
  local work self fails=0
  SELFTEST_DIR="$(mktemp -d)"
  work="$SELFTEST_DIR"
  # Set before anything else can fail, and before the main flow's own trap
  # exists; --self-test returns without ever reaching that flow.
  trap 'rm -rf "$SELFTEST_DIR"' EXIT
  self="$SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")"

  mkdir -p "$work/bin"
  cat >"$work/bin/go" <<'FAKE_GO'
#!/usr/bin/env bash
# A `go` that answers only what list-go-fuzz-targets.sh asks, from the fixture
# at $FAKE_GO_FIXTURE: line 1 is the module path, and every later line is
# "<package> <target>…". Anything else is a loud failure rather than a silent
# empty answer, because an unanswered question here would look like a module
# with no fuzz targets.
set -euo pipefail
case "${1-}" in
  list)
    if [ "${2-}" = "-m" ]; then sed -n '1p' "$FAKE_GO_FIXTURE"; exit 0; fi
    sed -n '2,$p' "$FAKE_GO_FIXTURE" | awk 'NF { print $1 }'
    exit 0
    ;;
  test)
    # The real `go test -list` prints each package's target names and then the
    # `ok <package>` line that closes the block; that ordering is exactly what
    # this script's awk parser attributes names by.
    sed -n '2,$p' "$FAKE_GO_FIXTURE" | awk 'NF {
      for (i = 2; i <= NF; i++) print $i
      printf "ok  \t%s\t0.001s\n", $1
    }'
    exit 0
    ;;
esac
echo "fake go: unexpected invocation: $*" >&2
exit 1
FAKE_GO
  chmod +x "$work/bin/go"

  local status out err
  # probe <fixture text> — run the real script's --json form against the fake
  # `go`, and leave its status, stdout and stderr in $status/$out/$err.
  probe() {
    printf '%s\n' "$1" >"$work/fixture"
    status=0
    out="$(PATH="$work/bin:$PATH" FAKE_GO_FIXTURE="$work/fixture" "$self" --json 2>"$work/err")" \
      || status=$?
    err="$(cat "$work/err")"
  }
  fail() { printf '  x %s\n' "$*" >&2; fails=$((fails + 1)); }
  pass() { printf '  ok %s\n' "$*"; }

  # `a/b-c` and `a-b/c` are different packages. Both flatten to `a-b-c`, so both
  # produce the id `a-b-c-FuzzX` — unique pairs, one id, two jobs writing one
  # artifact name.
  probe 'example.test/m
example.test/m/a/b-c FuzzX
example.test/m/a-b/c FuzzX'
  if [ "$status" -eq 0 ]; then
    fail "two packages that flatten to one id were accepted, matrix: $out"
  elif ! printf '%s' "$err" | grep -q 'share one matrix id'; then
    fail "the colliding fixture failed, but not on the id check: $err"
  elif ! printf '%s' "$err" | grep -q 'a-b-c-FuzzX'; then
    fail "the id-collision report does not name the colliding id: $err"
  else
    pass "distinct packages whose flattened paths collide fail closed"
  fi

  # The control: one character different, no collision. It must pass, and the
  # exact matrix is pinned so an id that changed shape is a failure too.
  probe 'example.test/m
example.test/m/a/b-c FuzzX
example.test/m/a-b/d FuzzX'
  local want='{"include":[{"package":"example.test/m/a-b/d","target":"FuzzX","id":"a-b-d-FuzzX"},{"package":"example.test/m/a/b-c","target":"FuzzX","id":"a-b-c-FuzzX"}]}'
  if [ "$status" -ne 0 ]; then
    fail "the same fixture without the collision was rejected: $err"
  elif [ "$out" != "$want" ]; then
    fail "non-colliding fixture produced an unexpected matrix
  got  $out
  want $want"
  else
    pass "the same fixture without the collision produces two distinct ids"
  fi

  if [ "$fails" -ne 0 ]; then
    printf 'list-go-fuzz-targets.sh --self-test: %d case(s) failed\n' "$fails" >&2
    return 1
  fi
  printf 'list-go-fuzz-targets.sh --self-test: 2 case(s) passed\n'
}

if [ "$MODE" = "self-test" ]; then
  self_test
  exit $?
fi

if [ ! -f "$MODULE_DIR/go.mod" ]; then
  echo "list-go-fuzz-targets.sh: no Go module at $MODULE_DIR" >&2
  exit 1
fi
cd "$MODULE_DIR"

MODULE_PATH="$(go list -m)"
if [ -z "$MODULE_PATH" ]; then
  echo "list-go-fuzz-targets.sh: \`go list -m\` reported no module path" >&2
  exit 1
fi

# The packages are enumerated once, here, and then passed to `go test` by name.
# Letting `go test` expand `./...` a second time would mean the campaign could
# silently cover a different set than the one this script reported.
PACKAGES="$(go list ./...)"
if [ -z "$PACKAGES" ]; then
  echo "list-go-fuzz-targets.sh: \`go list ./...\` produced no packages" >&2
  exit 1
fi

LISTING="$(mktemp)"
trap 'rm -f "$LISTING"' EXIT

# `go test -list` compiles each test binary and prints the matching names; it
# runs nothing. Word splitting is the point — this is a package list.
# shellcheck disable=SC2086
if ! go test -list '^Fuzz' $PACKAGES >"$LISTING" 2>&1; then
  echo "list-go-fuzz-targets.sh: \`go test -list\` failed; the module does not build:" >&2
  cat "$LISTING" >&2
  exit 1
fi

# `go test` emits each package's output as one contiguous block: the target
# names it found, then the `ok <package>` (or `? <package> [no test files]`)
# line that closes the block. So the names are attributed to the package whose
# terminator follows them, and anything still pending at end of input is output
# this parser did not understand rather than a target.
PAIRS="$(
  awk '
    /^ok[ \t]/       { pkg = $2; for (i = 1; i <= n; i++) print pkg "\t" names[i]; n = 0; next }
    /^\?[ \t]/       { report_orphans(); next }
    /^Fuzz[A-Za-z0-9_]*$/ { names[++n] = $0; next }
    { printf "unrecognised line %d: %s\n", NR, $0 > "/dev/stderr"; exit 1 }
    END { report_orphans() }
    function report_orphans(  i) {
      if (n == 0) return
      for (i = 1; i <= n; i++) {
        printf "target %s belongs to no package block\n", names[i] > "/dev/stderr"
      }
      exit 1
    }
  ' "$LISTING"
)" || {
  echo "list-go-fuzz-targets.sh: \`go test -list\` printed output this script cannot attribute to a" >&2
  echo "package. Treating it as a target would put unreviewed text into the campaign's command line." >&2
  echo "Full output:" >&2
  cat "$LISTING" >&2
  exit 1
}

if [ -z "$PAIRS" ]; then
  echo "list-go-fuzz-targets.sh: no fuzz targets found in $MODULE_PATH." >&2
  echo "Every target was deleted, or this script stopped recognising them. Either way the nightly" >&2
  echo "campaign would run zero jobs and report green, so this is a failure and not an empty list." >&2
  exit 1
fi

# Sorted so two runs of the same tree produce byte-identical output, and a
# reordered source file cannot reorder an Actions matrix.
PAIRS="$(printf '%s\n' "$PAIRS" | LC_ALL=C sort)"

DUPES="$(printf '%s\n' "$PAIRS" | LC_ALL=C uniq -d)"
if [ -n "$DUPES" ]; then
  echo "list-go-fuzz-targets.sh: duplicate (package, target) pairs:" >&2
  printf '%s\n' "$DUPES" >&2
  echo "One target would be fuzzed twice and the two jobs would collide on one artifact name." >&2
  exit 1
fi

# Both fields are interpolated into a shell command and an artifact name by the
# campaign workflow. Validating the charset here is what makes that safe, and it
# is also the last chance to notice a parse that produced something else.
while IFS=$'\t' read -r pkg target; do
  if ! printf '%s' "$pkg" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9_./-]*$'; then
    echo "list-go-fuzz-targets.sh: $(printf '%q' "$pkg") is not a well-formed import path" >&2
    exit 1
  fi
  if ! printf '%s' "$target" | LC_ALL=C grep -Eq '^Fuzz[A-Za-z0-9_]*$'; then
    echo "list-go-fuzz-targets.sh: $(printf '%q' "$target") is not a well-formed fuzz target name" >&2
    exit 1
  fi
done <<<"$PAIRS"

# ── the matrix ID, and why it is checked separately from the pair ────────────
#
# The ID is the package path relative to the module with `/` flattened to `-`,
# then the target: short enough to read in a job label and in an artifact name,
# which is all it is for. `$MODULE_PATH` is stripped first because the full
# import path would make every ID begin with the same twenty characters.
#
# Flattening LOSES information. `a/b-c` and `a-b/c` are different packages and
# both flatten to `a-b-c`, so two unique (package, target) pairs can produce one
# ID — the uniq -d above cannot see it, because it compares the pairs. What that
# costs is not cosmetic: the ID names the crasher artifact, so two campaign jobs
# would upload `fuzz-crashers-<id>` under one name, and the finding from one
# target would overwrite or merge with the other's. The run stays green either
# way; the evidence is what is lost.
#
# So the IDs are generated once, here, and checked for collision on their own.
# This fails closed rather than disambiguating: an ID that has to be read in a
# job label is worth keeping stable and legible, and the fix — rename one of two
# packages that were always going to be confusable — belongs to whoever created
# the collision, not to a suffix this script invents.
ROWS="$(
  printf '%s\n' "$PAIRS" | while IFS=$'\t' read -r pkg target; do
    id="${pkg#"$MODULE_PATH"/}"
    # The module's root package strips to nothing, so it falls back to the
    # module's own name.
    [ "$id" = "$pkg" ] && id="$(basename -- "$MODULE_PATH")"
    id="${id//\//-}"
    printf '%s\t%s\t%s-%s\n' "$pkg" "$target" "$id" "$target"
  done
)"

ID_DUPES="$(printf '%s\n' "$ROWS" | cut -f3 | LC_ALL=C sort | LC_ALL=C uniq -d)"
if [ -n "$ID_DUPES" ]; then
  echo "list-go-fuzz-targets.sh: distinct fuzz targets share one matrix id:" >&2
  while IFS= read -r dupe; do
    [ -n "$dupe" ] || continue
    printf '  %s\n' "$dupe" >&2
    printf '%s\n' "$ROWS" | LC_ALL=C awk -F'\t' -v want="$dupe" '$3 == want { printf "      %s  %s\n", $2, $1 }' >&2
  done <<<"$ID_DUPES"
  echo "The id names the job and its crasher artifact, so those jobs would upload one artifact" >&2
  echo "between them and one target's minimized input would be lost. Rename a package so the" >&2
  echo "flattened paths differ." >&2
  exit 1
fi

COUNT="$(printf '%s\n' "$PAIRS" | wc -l | tr -d ' ')"

if [ "$MODE" = "human" ]; then
  printf '%s\n' "$PAIRS" | while IFS=$'\t' read -r pkg target; do
    printf '%s\t%s\n' "$target" "$pkg"
  done
  printf '%s fuzz target(s) in %s\n' "$COUNT" "$MODULE_PATH"
  exit 0
fi

# One line, so the caller can put it straight into GITHUB_OUTPUT. No JSON
# escaping is needed and none is done: every character that reaches here passed
# the charset check above, and the id is built only from those characters.
{
  printf '{"include":['
  first=1
  while IFS=$'\t' read -r pkg target id; do
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '{"package":"%s","target":"%s","id":"%s"}' "$pkg" "$target" "$id"
  done <<<"$ROWS"
  printf ']}\n'
}
