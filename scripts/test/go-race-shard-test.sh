#!/bin/sh
# scripts/test/go-race-shard-test.sh — the properties `.github/workflows/go.yml`
# depends on when it splits the `server/account` race lane eight ways.
#
# ## What is actually at risk
#
# Eight jobs each run `go test -race -run "<their shard's regex>" ./account`.
# Nothing in that arrangement can notice a test that lands in NO shard. All
# eight jobs go green, the board goes green, and the test simply stopped being
# race-checked — silently, and for as long as nobody counts. A test landing in
# TWO shards is cheaper (wasted runner minutes) but is the same class of bug in
# the assignment, so both are asserted here.
#
# The regex matters as much as the assignment. `-run '^TestUser'` without the
# closing anchor also selects TestUserDelete and TestUserRename, so those tests
# would run in their own shard AND in TestUser's. Anchoring on both ends is
# what makes the eight `-run` patterns disjoint in fact and not just in
# intention.
#
# ## Why the shard assignment is pinned by value
#
# The FNV-1a hash in scripts/go-race-shard.go is a contract between CI runs,
# not an implementation detail: change it and every shard's contents change, so
# no shard's duration is comparable to its own previous run and a newly slow
# shard cannot be told from a reshuffled one. The golden cases below fail on any
# such change, which is the point — it should be a deliberate edit that breaks a
# test, not a silent refactor.
#
# Sections 8-12 cover what was added for the renewal lane and timing evidence:
# the weighted (longest-processing-time) planner against the recorded hosted
# renewal times, its tie breaks, exact selectors and refusal of every malformed
# weights file; scripts/go-race-timings.go's evidence and corpus refusals
# (missing PASS, subtest SKIP, failed or non-zero runs, unassigned tests,
# incomplete or mixed corpora); and the go.yml renewal step itself, cut out of
# the workflow and run against a canned stream to prove go test's status
# survives the pipe while the evidence is still written.
#
# POSIX sh plus `go run` of two stdlib-only files; section 12 also uses bash
# (the step's own shell) and lists a throw-away two-test module with -race. It
# never builds `./account`, so it belongs in the always-on repo-hygiene lane
# rather than behind the Go lane's path filter.

set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
helper="$root/scripts/go-race-shard.go"
# A snapshot of `go test -list '^Test' ./account`, taken 2026-08-21, when the
# package had 1904 top-level tests. It is deliberately a FIXED corpus and not a
# mirror of HEAD: the properties below hold for any list, and re-deriving the
# list here would mean compiling the whole account package in a lane that is
# meant to stay fast. The live list is checked on every CI run instead — the
# helper re-proves the partition each time a shard job invokes it.
corpus="$root/scripts/test/fixtures/account-top-level-tests-2026-08-21.txt"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

# Failures are tallied in a FILE, not a shell variable. `regex()` is invoked
# inside a command substitution, which runs in a subshell, so a variable
# incremented there is discarded when the subshell exits — the ✗ would print and
# the suite would still exit 0.
fail_log="$work/failures"
: > "$fail_log"
fail() {
  printf '%s\n' "$*" >> "$fail_log"
  printf '  ✗ %s\n' "$*" >&2
}
ok() { printf '  ✓ %s\n' "$*"; }

# shard <index> <shards> <names-file> — the assigned names, into $2's stdout.
#
# A refusal is reported with the helper's own reason rather than aborting the
# script: `set -e` would otherwise end the run with no output at all, and the
# helper's message ("the shards are not the input list", "shard 6 was assigned
# no tests") is the whole diagnosis.
shard() {
  if ! go run "$helper" -shard "$1" -shards "$2" -names-from "$3" -list 2>"$work/helper-err"; then
    fail "helper refused shard $1 of $2: $(tr '\n' ' ' < "$work/helper-err")"
    return 0
  fi
}

# regex <index> <shards> <names-file> — the emitted -run pattern.
regex() {
  if ! go run "$helper" -shard "$1" -shards "$2" -names-from "$3" 2>"$work/helper-err"; then
    fail "helper refused the regex for shard $1 of $2: $(tr '\n' ' ' < "$work/helper-err")"
    return 0
  fi
}

# expect_fail <description> -- <helper args...> — the helper must exit non-zero.
expect_fail() {
  desc=$1; shift 2
  if go run "$helper" "$@" >/dev/null 2>"$work/err"; then
    fail "$desc: the helper exited 0. $(cat "$work/err")"
  else
    ok "$desc"
  fi
}

echo "go-race-shard-test: assignment"

# ── 1. golden cases: the hash is pinned by value ────────────────────────────
#
# Each name is fed in alone so the shard it is REPORTED in is the shard the hash
# chose, with no interference from the partition's other invariants.
check_golden() {
  name=$1; shards=$2; want=$3
  # -where reports the hash's answer for one name. Going through -shard is not
  # possible here on purpose: a single name leaves seven shards empty, and the
  # helper refuses an empty shard.
  got=$(go run "$helper" -where "$name" -shards "$shards" 2>/dev/null || echo none)
  if [ "$got" = "$want" ]; then
    ok "FNV-1a: $name -> shard $want of $shards"
  else
    fail "FNV-1a: $name -> shard $got of $shards, want $want. The shard hash changed, which reshuffles every shard."
  fi
}
check_golden TestAccountDeleteIsIdempotent 8 4
check_golden TestBillingWebhookReplay      8 2
check_golden TestZeroLengthUpload          8 6
check_golden TestUser                      8 2
check_golden TestUserDelete                8 5
check_golden Test_underscore_name          8 4
check_golden TestUserDelete                3 2
check_golden Test_underscore_name          3 0

# ── 2. deterministic: same input, same output, every time ───────────────────
shard 3 8 "$corpus" > "$work/run1.txt"
shard 3 8 "$corpus" > "$work/run2.txt"
if cmp -s "$work/run1.txt" "$work/run2.txt"; then
  ok "same input twice produces the identical shard"
else
  fail "the assignment is not deterministic: two runs over the same list differ"
fi

# Order of the INPUT must not change the assignment either — the shard jobs get
# whatever order `go test -list` happens to emit.
sort -r "$corpus" > "$work/reversed.txt"
shard 3 8 "$work/reversed.txt" > "$work/run3.txt"
if cmp -s "$work/run1.txt" "$work/run3.txt"; then
  ok "reversing the input list does not move any test"
else
  fail "the assignment depends on input ORDER, so two shard jobs could disagree"
fi

echo "go-race-shard-test: the eight shards partition the corpus"

# ── 3. union == corpus, and every test assigned exactly once ────────────────
total=$(wc -l < "$corpus" | tr -d ' ')
if [ "$total" -eq 1904 ]; then
  ok "corpus is the recorded 1904 top-level tests"
else
  fail "corpus has $total names, want the recorded 1904"
fi

: > "$work/union.txt"
i=0
while [ "$i" -lt 8 ]; do
  shard "$i" 8 "$corpus" > "$work/shard$i.txt"
  count=$(wc -l < "$work/shard$i.txt" | tr -d ' ')
  if [ "$count" -eq 0 ]; then
    fail "shard $i was assigned no tests"
  fi
  cat "$work/shard$i.txt" >> "$work/union.txt"
  i=$((i + 1))
done

union_total=$(wc -l < "$work/union.txt" | tr -d ' ')
if [ "$union_total" -eq "$total" ]; then
  ok "the eight shards contain $union_total names, exactly the corpus size"
else
  fail "the eight shards contain $union_total names against a corpus of $total: some test is assigned twice or not at all"
fi

sort "$work/union.txt" > "$work/union-sorted.txt"
sort "$corpus" > "$work/corpus-sorted.txt"
if cmp -s "$work/union-sorted.txt" "$work/corpus-sorted.txt"; then
  ok "the union of the shards is exactly the corpus"
else
  missing=$(comm -23 "$work/corpus-sorted.txt" "$work/union-sorted.txt" | head -5 | tr '\n' ' ')
  extra=$(comm -13 "$work/corpus-sorted.txt" "$work/union-sorted.txt" | head -5 | tr '\n' ' ')
  fail "the shards are not the corpus. Assigned to no shard: ${missing:-none}. Not in the corpus: ${extra:-none}. A test in no shard is a test that stopped being race-checked, with eight green jobs."
fi

# Exactly once, stated independently of the counts above.
if [ -z "$(sort "$work/union.txt" | uniq -d)" ]; then
  ok "no test appears in more than one shard"
else
  fail "these tests are in more than one shard: $(sort "$work/union.txt" | uniq -d | head -5 | tr '\n' ' ')"
fi

# ── 4. pairwise disjoint, checked as pairs and not inferred ─────────────────
overlaps=0
i=0
while [ "$i" -lt 8 ]; do
  j=$((i + 1))
  while [ "$j" -lt 8 ]; do
    if [ -n "$(comm -12 "$work/shard$i.txt" "$work/shard$j.txt")" ]; then
      fail "shard $i and shard $j share tests: $(comm -12 "$work/shard$i.txt" "$work/shard$j.txt" | head -3 | tr '\n' ' ')"
      overlaps=$((overlaps + 1))
    fi
    j=$((j + 1))
  done
  i=$((i + 1))
done
[ "$overlaps" -eq 0 ] && ok "all 28 shard pairs are disjoint"

echo "go-race-shard-test: the emitted -run regex"

# ── 5. anchored on both ends, one alternation element per assigned test ─────
re=$(regex 3 8 "$corpus")
case "$re" in
  '^('*')$') ok "the regex is anchored: ^( ... )\$" ;;
  *) fail "the regex is not anchored on both ends: $(printf '%s' "$re" | cut -c1-40)... A missing trailing \$ makes ^TestUser also select TestUserDelete, so that test runs in two shards." ;;
esac

# Split the alternation back into names and compare to -list. This proves the
# regex says exactly what the assignment says: no name dropped by a quoting
# mistake, none added by a stray alternation.
printf '%s' "$re" | sed -e 's/^\^(//' -e 's/)\$$//' -e 's/|/\n/g' | sort > "$work/from-regex.txt"
sort "$work/shard3.txt" > "$work/shard3-sorted.txt"
if cmp -s "$work/from-regex.txt" "$work/shard3-sorted.txt"; then
  ok "the regex's alternation is exactly the shard's assigned tests"
else
  fail "the regex and the assignment disagree: $(diff "$work/shard3-sorted.txt" "$work/from-regex.txt" | head -4 | tr '\n' ' ')"
fi

# ── 6. regex metacharacters are escaped, not interpreted ────────────────────
#
# A Go test function name cannot currently contain one of these, so this is a
# guard on the misparse: if the -list output is ever read wrongly and a name
# arrives with a `.` or `+` in it, the shard must still select that one name
# rather than silently matching a different set.
cat > "$work/meta.txt" <<'NAMES'
TestPlain
TestDot.Suffix
TestPlus+One
TestParen(Group)
TestStar*Wild
TestBracket[Set]
NAMES
# Three shards, because all three are non-empty for this corpus and the helper
# refuses a shard that would run nothing.
found_escapes=0
i=0
while [ "$i" -lt 3 ]; do
  r=$(regex "$i" 3 "$work/meta.txt")
  case "$r" in
    *'\.'*|*'\+'*|*'\('*|*'\*'*|*'\['*) found_escapes=$((found_escapes + 1)) ;;
  esac
  case "$r" in
    *'Dot.Suffix'*) fail "an unescaped '.' survived into the regex, where it matches any character" ;;
    *'Plus+One'*)   fail "an unescaped '+' survived into the regex" ;;
    *'Star*Wild'*)  fail "an unescaped '*' survived into the regex" ;;
  esac
  i=$((i + 1))
done
if [ "$found_escapes" -gt 0 ]; then
  ok "regex metacharacters in test names are escaped"
else
  fail "no escaping was applied to names containing regex metacharacters"
fi

echo "go-race-shard-test: fails loud"

# ── 7. every invalid input is an error, never a silent empty run ────────────
: > "$work/empty.txt"
expect_fail "an empty test list is refused (it would make every shard run nothing)" -- \
  -shard 0 -shards 8 -names-from "$work/empty.txt"

printf 'ok  \tgithub.com/relayium/relayium/account\t0.070s\n' > "$work/noise.txt"
expect_fail "a list with no test names is refused" -- \
  -shard 0 -shards 8 -names-from "$work/noise.txt"

# ── 7a. a malformed Test-prefixed line is an error, not a silent drop ────────
#
# This is the failure mode the rest of this suite cannot see. The parser used to
# SKIP a line that started with "Test" but contained whitespace, so a malformed
# name vanished before the partition was computed. The partition then proved
# itself over the surviving names — union equal to the (reduced) input, all
# pairs disjoint, no empty shard — and every one of the checks above passed
# while a test the caller listed had stopped being race-checked.
#
# Each case below therefore pairs the malformed line with enough VALID names to
# keep the partition satisfiable, which is exactly the situation in which
# skipping would have gone unnoticed.
valid_three() {
  printf 'TestAlpha\nTestBeta\nTestGamma\n'
}

{ valid_three; printf 'TestFoo Bar\n'; } > "$work/malformed-space.txt"
expect_fail "a Test-prefixed line with a space is refused, not dropped" -- \
  -shard 0 -shards 3 -names-from "$work/malformed-space.txt"

{ valid_three; printf 'TestFoo\tBar\n'; } > "$work/malformed-tab.txt"
expect_fail "a Test-prefixed line with a tab is refused, not dropped" -- \
  -shard 0 -shards 3 -names-from "$work/malformed-tab.txt"

# Leading whitespace is the same failure wearing a disguise. The line claims a
# test name once trimmed, and go test never emits an indented name, so it is a
# misparse — and the ONLY safe response is to refuse it. Dropping it as summary
# output, which is what a raw `HasPrefix(text, "Test")` check does, is the
# silent omission this whole file exists to make impossible: not adopting the
# line is necessary but nowhere near sufficient.
{ valid_three; printf '  TestIndented\n'; } > "$work/malformed-indent.txt"
expect_fail "a Test-prefixed line with LEADING SPACES is refused, not dropped as summary output" -- \
  -shard 0 -shards 3 -names-from "$work/malformed-indent.txt"

{ valid_three; printf '\tTestTabIndented\n'; } > "$work/malformed-tab-indent.txt"
expect_fail "a Test-prefixed line with a LEADING TAB is refused, not dropped as summary output" -- \
  -shard 0 -shards 3 -names-from "$work/malformed-tab-indent.txt"

# Refusing is not enough on its own: a helper that refused but still emitted the
# name somewhere would be no better. Nothing may be assigned from that input.
#
# `go run` is invoked directly rather than through shard(), which reports a
# refusal as a suite failure — here the refusal is the expected outcome and was
# already asserted above, so only the OUTPUT is under test.
: > "$work/indent-union.txt"
i=0
while [ "$i" -lt 3 ]; do
  go run "$helper" -shard "$i" -shards 3 -names-from "$work/malformed-indent.txt" -list \
    >> "$work/indent-union.txt" 2>/dev/null || true
  i=$((i + 1))
done
if grep -q 'TestIndented' "$work/indent-union.txt"; then
  fail "'  TestIndented' was assigned to a shard; an indented line is a misparse, not a test name"
else
  ok "an indented line is not adopted as a test name either"
fi

# The positive control. Without it, a parser that refused EVERYTHING would pass
# every expect_fail above.
valid_three > "$work/valid-three.txt"
: > "$work/valid-union.txt"
i=0
while [ "$i" -lt 3 ]; do
  shard "$i" 3 "$work/valid-three.txt" >> "$work/valid-union.txt"
  i=$((i + 1))
done
if [ "$(wc -l < "$work/valid-union.txt" | tr -d ' ')" -eq 3 ]; then
  ok "the same three names without a malformed line are still accepted"
else
  fail "three valid names produced $(wc -l < "$work/valid-union.txt" | tr -d ' ') assignments, want 3: the parser now rejects legitimate input, and every 'fails loud' case above proves nothing"
fi

# And go test's own trailing summary must still be DROPPED rather than refused,
# or every real invocation of the helper would fail.
{ valid_three; printf 'ok  \tgithub.com/relayium/relayium/account\t0.070s\n'; } > "$work/with-summary.txt"
: > "$work/summary-union.txt"
i=0
while [ "$i" -lt 3 ]; do
  shard "$i" 3 "$work/with-summary.txt" >> "$work/summary-union.txt"
  i=$((i + 1))
done
if [ "$(wc -l < "$work/summary-union.txt" | tr -d ' ')" -ne 3 ]; then
  fail "a list ending in go test's 'ok' summary produced $(wc -l < "$work/summary-union.txt" | tr -d ' ') assignments, want the 3 real names"
elif grep -q 'relayium' "$work/summary-union.txt"; then
  fail "the 'ok <pkg> <duration>' summary line was assigned to a shard as if it were a test"
else
  ok "go test's trailing summary line is still dropped, not refused"
fi

expect_fail "-shard equal to -shards is out of range" -- \
  -shard 8 -shards 8 -names-from "$corpus"
expect_fail "a negative -shard is out of range" -- \
  -shard -1 -shards 8 -names-from "$corpus"
expect_fail "-shards 0 is refused" -- \
  -shard 0 -shards 0 -names-from "$corpus"
expect_fail "a missing names file is an error" -- \
  -shard 0 -shards 8 -names-from "$work/does-not-exist.txt"

printf 'TestDuplicated\nTestDuplicated\nTestOther\n' > "$work/dupe.txt"
expect_fail "a duplicated test name is refused" -- \
  -shard 0 -shards 3 -names-from "$work/dupe.txt"

# Fewer tests than shards leaves at least one shard empty, which would report
# success having run nothing.
printf 'TestOnlyOne\nTestOnlyTwo\n' > "$work/tiny.txt"
expect_fail "a shard that would run no tests is refused" -- \
  -shard 0 -shards 8 -names-from "$work/tiny.txt"

echo "go-race-shard-test: weighted mode (longest-processing-time first)"

# ── 8. the renewal plan from the real hosted PASS times ─────────────────────
#
# The inventory is read from the sources (no build in this lane); the CI jobs
# use the compiled list, which the planner checks against -pattern. The plan
# must be the one the research measured: 593.72s and 594.88s, the 0.00s test
# planned at 1 ms.
renew_weights="$root/scripts/go-race-timings-renewal.json"
renew_pattern='^(TestLinkRenew|TestLDRenew)'
grep -hoE '^func (TestLinkRenew|TestLDRenew)[A-Za-z0-9_]*' "$root"/server/cmd/relayium/*_test.go \
  | awk '{print $2}' > "$work/renew.txt"
wplan() {
  # wplan <weights> <names-file> <shards> <shard> [extra args] — weighted plan output.
  w=$1; n=$2; k=$3; i=$4; shift 4
  go run "$helper" -package ./cmd/relayium -pattern "$renew_pattern" -weights "$w" \
    -names-from "$n" -shards "$k" -shard "$i" "$@"
}
expect_wfail() {
  # expect_wfail <description> <weights> <names-file> <shards> [extra args]
  desc=$1; w=$2; n=$3; k=$4; shift 4
  if wplan "$w" "$n" "$k" 0 "$@" >/dev/null 2>"$work/err"; then
    fail "$desc: the helper exited 0. $(cat "$work/err")"
  else
    ok "$desc"
  fi
}
loads=$(wplan "$renew_weights" "$work/renew.txt" 2 0 -loads 2>"$work/renew-err" | tr '\n' ' ')
if [ "$loads" = "593721 594880 " ]; then
  ok "the renewal plan is 593.721s / 594.880s from the recorded hosted times"
else
  fail "the renewal plan loads are '$loads', want '593721 594880 ': $(cat "$work/renew-err")"
fi
if grep -q '0 listed test(s) without a measured weight' "$work/renew-err" \
  && grep -q '0 weight(s) name no listed test' "$work/renew-err"; then
  ok "every current renewal test has a recorded hosted weight"
else
  fail "the renewal weights and the renewal tests in the source disagree: $(cat "$work/renew-err")"
fi

# The two shards partition the list: union, disjoint, non-empty.
wplan "$renew_weights" "$work/renew.txt" 2 0 -list > "$work/r0.txt" 2>/dev/null || fail "renewal shard 0 refused"
wplan "$renew_weights" "$work/renew.txt" 2 1 -list > "$work/r1.txt" 2>/dev/null || fail "renewal shard 1 refused"
if [ -s "$work/r0.txt" ] && [ -s "$work/r1.txt" ] && [ -z "$(comm -12 "$work/r0.txt" "$work/r1.txt")" ] \
  && [ "$(sort "$work/r0.txt" "$work/r1.txt")" = "$(sort "$work/renew.txt")" ]; then
  ok "the two renewal shards are non-empty, disjoint and together every renewal test"
else
  fail "the renewal shards are not a partition of the renewal tests"
fi

# Input order cannot move a test: reversed and rotated lists give the same plan.
sort -r "$work/renew.txt" > "$work/renew-rev.txt"
awk 'NR % 3 == 0' "$work/renew.txt" > "$work/renew-rot.txt"
awk 'NR % 3 != 0' "$work/renew.txt" >> "$work/renew-rot.txt"
for shuffled in renew-rev renew-rot; do
  wplan "$renew_weights" "$work/$shuffled.txt" 2 0 -list > "$work/$shuffled-0.txt" 2>/dev/null || true
  if cmp -s "$work/r0.txt" "$work/$shuffled-0.txt"; then
    ok "a shuffled input ($shuffled) plans the same shard"
  else
    fail "the weighted plan depends on input order ($shuffled)"
  fi
done

# A new test joins (at the largest weight, so it is placed first) rather than
# being dropped, and a weight for a test that no longer exists is ignored and
# can never reach a selector.
{ cat "$work/renew.txt"; echo TestLinkRenewBrandNew; } > "$work/renew-new.txt"
: > "$work/renew-new-union.txt"
for i in 0 1; do
  wplan "$renew_weights" "$work/renew-new.txt" 2 "$i" -list >> "$work/renew-new-union.txt" 2>"$work/new-err" \
    || fail "a list with one new renewal test was refused: $(cat "$work/new-err")"
done
if grep -qx TestLinkRenewBrandNew "$work/renew-new-union.txt" \
  && [ "$(sort "$work/renew-new-union.txt")" = "$(sort "$work/renew-new.txt")" ] \
  && grep -q '1 listed test(s) without a measured weight planned at 129180 ms' "$work/new-err"; then
  ok "a new renewal test with no recorded time joins a shard at the largest recorded weight"
else
  fail "a new renewal test did not join the plan: $(cat "$work/new-err")"
fi
grep -v '^TestLinkRenewNeedsUserProgress$' "$work/renew.txt" > "$work/renew-gone.txt"
: > "$work/renew-gone-union.txt"
for i in 0 1; do
  wplan "$renew_weights" "$work/renew-gone.txt" 2 "$i" >> "$work/renew-gone-union.txt" 2>"$work/gone-err" || true
done
if ! grep -q NeedsUserProgress "$work/renew-gone-union.txt" && grep -q '1 weight(s) name no listed test' "$work/gone-err"; then
  ok "a weight for an unknown (deleted) test is ignored and reaches no selector"
else
  fail "a weight naming no listed test leaked into a selector or was not reported: $(cat "$work/gone-err")"
fi

# Tie breaks are stable: equal weights go heaviest-first by name, each to the
# lowest-index least-loaded shard. A, C -> 0 and B, D -> 1.
weights_doc() {
  # weights_doc <package> <pattern> <provenance-json> <tests-json> — a weights file on stdout.
  printf '{"schema":"relayium.go-test-weights/1","package":"%s","pattern":"%s","unit":"seconds","provenance":%s,"tests":%s}\n' "$1" "$2" "$3" "$4"
}
# Synthetic but well-formed provenance: these fixtures name run 101, which no
# hosted capture claims; real files name the run they were measured in.
prov='{"kind":"go-test-json-corpus","source":"synthetic run 101 job 2","sourceSHA":"0123456789abcdef0123456789abcdef01234567","toolchain":"go version go1.26.6 linux/amd64","runID":101,"runAttempt":1,"race":true,"count":1,"complete":true}'
weights_doc ./account '^Test' "$prov" '[{"name":"TestD","seconds":1},{"name":"TestB","seconds":1},{"name":"TestC","seconds":1},{"name":"TestA","seconds":1}]' > "$work/tie.json"
printf 'TestD\nTestC\nTestB\nTestA\n' > "$work/tie.txt"
t0=$(go run "$helper" -weights "$work/tie.json" -names-from "$work/tie.txt" -shards 2 -shard 0 -list 2>/dev/null | tr '\n' ' ')
t1=$(go run "$helper" -weights "$work/tie.json" -names-from "$work/tie.txt" -shards 2 -shard 1 -list 2>/dev/null | tr '\n' ' ')
if [ "$t0" = "TestA TestC " ] && [ "$t1" = "TestB TestD " ]; then
  ok "equal weights break ties by name, then by lowest shard index"
else
  fail "tie breaks: shard 0 '$t0', shard 1 '$t1'; want 'TestA TestC ' and 'TestB TestD '"
fi

# A selector is exact in weighted mode too: ^TestUser$ must not select
# TestUserDelete, and a metacharacter is escaped. TestUser (10) opens shard 0;
# TestUserRename (5) and TestUserDelete (4) both go to the lighter shard 1.
weights_doc ./account '^Test' "$prov" '[{"name":"TestUser","seconds":10},{"name":"TestUserDelete","seconds":4},{"name":"TestUserRename","seconds":5}]' > "$work/prefix.json"
printf 'TestUserDelete\nTestUser\nTestUserRename\n' > "$work/prefix.txt"
p0=$(go run "$helper" -weights "$work/prefix.json" -names-from "$work/prefix.txt" -shards 2 -shard 0 2>/dev/null || echo REFUSED)
p1=$(go run "$helper" -weights "$work/prefix.json" -names-from "$work/prefix.txt" -shards 2 -shard 1 2>/dev/null || echo REFUSED)
if [ "$p0" = '^(TestUser)$' ] && [ "$p1" = '^(TestUserDelete|TestUserRename)$' ] \
  && ! printf 'TestUserDelete\n' | grep -Eq "$p0" && ! printf 'TestUser\n' | grep -Eq "$p1"; then
  ok "weighted selectors are anchored: ^(TestUser)\$ does not select TestUserDelete, nor the reverse"
else
  fail "the weighted selectors are '$p0' and '$p1'; want '^(TestUser)\$' and '^(TestUserDelete|TestUserRename)\$'"
fi
# A listed name with no weight plans at the largest (1 s here) and ties go by
# name: TestA -> 0, TestDot.Suffix -> 1, whose '.' must be escaped.
weights_doc ./account '^Test' "$prov" '[{"name":"TestA","seconds":1}]' > "$work/meta-w.json"
printf 'TestDot.Suffix\nTestA\n' > "$work/meta-w.txt"
p1=$(go run "$helper" -weights "$work/meta-w.json" -names-from "$work/meta-w.txt" -shards 2 -shard 1 2>/dev/null || echo REFUSED)
if [ "$p1" = '^(TestDot\.Suffix)$' ] && ! printf 'TestDotXSuffix\n' | grep -Eq "$p1"; then
  ok "a weighted selector escapes regex metacharacters"
else
  fail "the weighted selector for shard 1 is '$p1'; want '^(TestDot\\.Suffix)\$'"
fi

# -plan-out records the whole compiled inventory, sorted, and this shard's names.
wplan "$renew_weights" "$work/renew-rev.txt" 2 1 -plan-out "$work/plan1.json" > /dev/null 2>&1 || fail "-plan-out refused"
if [ "$(grep -c '"Test' "$work/plan1.json")" -eq $(( $(wc -l < "$work/renew.txt") + $(wc -l < "$work/r1.txt") )) ] \
  && grep -q '"mode": "weighted"' "$work/plan1.json" && grep -q '"weightsSHA256": "[0-9a-f]\{64\}"' "$work/plan1.json"; then
  ok "-plan-out records the inventory, the assignment, the mode and the weights sha256"
else
  fail "-plan-out is incomplete: $(head -c 400 "$work/plan1.json")"
fi

echo "go-race-shard-test: a weights file is what it claims, or it is refused"

# ── 9. malformed weights are errors, never a silent fallback to FNV ─────────
bad_w() {
  # bad_w <description> <weights-json> [names-file]
  printf '%s\n' "$2" > "$work/bad.json"
  expect_wfail "$1" "$work/bad.json" "${3:-$work/renew.txt}" 2
}
rt='[{"name":"TestLinkRenewA","seconds":1},{"name":"TestLinkRenewB","seconds":2}]'
printf 'TestLinkRenewA\nTestLinkRenewB\n' > "$work/ab.txt"
weights_doc ./cmd/relayium "$renew_pattern" "$prov" "$rt" > "$work/good.json"
if wplan "$work/good.json" "$work/ab.txt" 2 0 >/dev/null 2>"$work/err"; then
  ok "the well-formed control weights file is accepted (so each refusal below is about its one defect)"
else
  fail "the control weights file was refused, so the refusals below prove nothing: $(cat "$work/err")"
fi
bad_w "a wrong schema is refused" "$(sed 's/go-test-weights\/1/go-test-weights\/2/' "$work/good.json")" "$work/ab.txt"
bad_w "an unknown field is refused" "$(sed 's/"unit":"seconds"/"unit":"seconds","extra":1/' "$work/good.json")" "$work/ab.txt"
bad_w "a weights file for another package is refused" "$(weights_doc ./account "$renew_pattern" "$prov" "$rt")" "$work/ab.txt"
bad_w "a weights file for another pattern is refused" "$(weights_doc ./cmd/relayium '^TestLinkRenew' "$prov" "$rt")" "$work/ab.txt"
bad_w "a unit other than seconds is refused" "$(sed 's/"unit":"seconds"/"unit":"ms"/' "$work/good.json")" "$work/ab.txt"
bad_w "a duplicated test name is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$prov" '[{"name":"TestLinkRenewA","seconds":1},{"name":"TestLinkRenewA","seconds":2}]')" "$work/ab.txt"
bad_w "a negative duration is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$prov" '[{"name":"TestLinkRenewA","seconds":-1}]')" "$work/ab.txt"
bad_w "a duration beyond six hours is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$prov" '[{"name":"TestLinkRenewA","seconds":21601}]')" "$work/ab.txt"
bad_w "an out-of-range number is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$prov" '[{"name":"TestLinkRenewA","seconds":1e400}]')" "$work/ab.txt"
bad_w "a string duration is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$prov" '[{"name":"TestLinkRenewA","seconds":"1"}]')" "$work/ab.txt"
bad_w "a missing duration is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$prov" '[{"name":"TestLinkRenewA"}]')" "$work/ab.txt"
bad_w "an empty test list is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$prov" '[]')" "$work/ab.txt"
bad_w "a name the pattern does not match is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$prov" '[{"name":"TestUnrelated","seconds":1}]')" "$work/ab.txt"
bad_w "a name with a space is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$prov" '[{"name":"TestLinkRenew A","seconds":1}]')" "$work/ab.txt"
bad_w "provenance without -race is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$(printf '%s' "$prov" | sed 's/"race":true/"race":false/')" "$rt")" "$work/ab.txt"
bad_w "provenance from an incomplete corpus is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$(printf '%s' "$prov" | sed 's/"complete":true/"complete":false/')" "$rt")" "$work/ab.txt"
bad_w "provenance with -count other than 1 is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$(printf '%s' "$prov" | sed 's/"count":1/"count":2/')" "$rt")" "$work/ab.txt"
bad_w "provenance with an unknown kind is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$(printf '%s' "$prov" | sed 's/"kind":"go-test-json-corpus"/"kind":"estimate"/')" "$rt")" "$work/ab.txt"
bad_w "provenance with a malformed source SHA is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$(printf '%s' "$prov" | sed 's/"sourceSHA":"[0-9a-f]*"/"sourceSHA":"not-a-sha"/')" "$rt")" "$work/ab.txt"
bad_w "provenance with a malformed toolchain is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$(printf '%s' "$prov" | sed 's/"toolchain":"[^"]*"/"toolchain":"not-a-toolchain"/')" "$rt")" "$work/ab.txt"
bad_w "provenance with run ID 0 is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$(printf '%s' "$prov" | sed 's/"runID":101/"runID":0/')" "$rt")" "$work/ab.txt"
bad_w "provenance with a negative run attempt is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$(printf '%s' "$prov" | sed 's/"runAttempt":1/"runAttempt":-1/')" "$rt")" "$work/ab.txt"
bad_w "provenance with a string run ID is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$(printf '%s' "$prov" | sed 's/"runID":101/"runID":"101"/')" "$rt")" "$work/ab.txt"
bad_w "provenance without a run ID is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$(printf '%s' "$prov" | sed 's/"runID":101,//')" "$rt")" "$work/ab.txt"
bad_w "a null field is refused, not read as zero" "$(weights_doc ./cmd/relayium "$renew_pattern" "$(printf '%s' "$prov" | sed 's/"runAttempt":1/"runAttempt":null/')" "$rt")" "$work/ab.txt"
bad_w "a duplicated JSON key is refused (the last value would win)" "$(weights_doc ./cmd/relayium "$renew_pattern" "$(printf '%s' "$prov" | sed 's/"race":true/"race":false,"race":true/')" "$rt")" "$work/ab.txt"
bad_w "a duplicated key inside a test entry is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$prov" '[{"name":"TestLinkRenewA","seconds":99,"seconds":1}]')" "$work/ab.txt"
bad_w "provenance without a source SHA is refused" "$(weights_doc ./cmd/relayium "$renew_pattern" "$(printf '%s' "$prov" | sed 's/"sourceSHA":"[0-9a-f]*"/"sourceSHA":""/')" "$rt")" "$work/ab.txt"
bad_w "trailing data after the object is refused" "$(cat "$work/good.json") {}" "$work/ab.txt"
expect_wfail "a missing weights file is an error" "$work/does-not-exist.json" "$work/ab.txt" 2
printf 'TestLinkRenewA\nTestUnrelated\n' > "$work/off-pattern.txt"
expect_wfail "a listed name outside -pattern is refused (a misparsed list)" "$work/good.json" "$work/off-pattern.txt" 2
printf 'TestLinkRenewA\n' > "$work/one.txt"
expect_wfail "a weighted shard that would run no tests is refused" "$work/good.json" "$work/one.txt" 2
printf 'TestLinkRenewA\nTestLinkRenewA\nTestLinkRenewB\n' > "$work/dup-list.txt"
expect_wfail "a duplicated listed name is refused in weighted mode" "$work/good.json" "$work/dup-list.txt" 2
expect_fail "-where refuses weighted mode (a weighted shard depends on the whole list)" -- \
  -where TestUser -weights "$work/good.json"
expect_fail "-loads without -weights is refused" -- -shard 0 -shards 8 -names-from "$corpus" -loads

echo "go-race-shard-test: timing evidence"

# ── 10. evidence from a go test -json stream, against the plan ──────────────
timings="$root/scripts/go-race-timings.go"
wplan "$work/good.json" "$work/ab.txt" 2 0 -plan-out "$work/plan-a.json" > /dev/null 2>&1 || fail "plan A refused"
wplan "$work/good.json" "$work/ab.txt" 2 1 -plan-out "$work/plan-b.json" > /dev/null 2>&1 || fail "plan B refused"
a_shard=$(tr -d ' \n' < "$work/plan-a.json" | grep -o '"assigned":\[[^]]*')
case "$a_shard" in
  *TestLinkRenewB*) a_name=TestLinkRenewB; b_name=TestLinkRenewA ;;
  *) a_name=TestLinkRenewA; b_name=TestLinkRenewB ;;
esac
ev_line() {
  # ev_line <action> <test> [elapsed] — one go test -json event.
  if [ -n "${3:-}" ]; then
    printf '{"Action":"%s","Package":"p","Test":"%s","Elapsed":%s}\n' "$1" "$2" "$3"
  else
    printf '{"Action":"%s","Package":"p","Test":"%s"}\n' "$1" "$2"
  fi
}
evidence() {
  # evidence <plan> <stream> <go-exit> <out> [flags] — runs the evidence subcommand.
  pl=$1; st=$2; ge=$3; o=$4; shift 4
  go run "$timings" evidence -lane renewal -plan "$pl" -json "$st" -source-sha 0123456789abcdef0123456789abcdef01234567 \
    -toolchain 'go version go1.26.6 linux/amd64' -run-id 101 -run-attempt 1 -race -count 1 -go-exit "$ge" \
    -out "$o" "$@"
}
expect_evidence() {
  # expect_evidence <description> <want: ok|fail> <plan> <stream> <go-exit> [flags]
  desc=$1; want=$2; pl=$3; st=$4; ge=$5; shift 5
  rm -f "$work/ev.json"
  if evidence "$pl" "$st" "$ge" "$work/ev.json" "$@" >/dev/null 2>"$work/ev-err"; then got=ok; else got=fail; fi
  if [ "$got" != "$want" ]; then
    fail "$desc: evidence exited $got, want $want. $(tr '\n' ' ' < "$work/ev-err")"
  elif [ ! -s "$work/ev.json" ]; then
    fail "$desc: no evidence file was written; a failed run must still leave its evidence"
  elif [ "$want" = fail ] && ! grep -q '"complete": false' "$work/ev.json"; then
    fail "$desc: the evidence of a refused run does not say complete=false"
  else
    ok "$desc"
  fi
}
{ ev_line run "$a_name"; printf '{"Action":"output","Package":"p","Test":"%s","Output":"--- PASS\\n"}\n' "$a_name"; ev_line pass "$a_name" 1.25; printf '{"Action":"pass","Package":"p","Elapsed":1.3}\n'; } > "$work/s-pass.json"
expect_evidence "every assigned test PASSes: complete evidence" ok "$work/plan-a.json" "$work/s-pass.json" 0 -require-pass -forbid-skip
if grep -q '"seconds": 1.25' "$work/ev.json" && grep -q '"sourceSHA": "0123456789abcdef0123456789abcdef01234567"' "$work/ev.json" \
  && grep -q '"inventorySHA256": "[0-9a-f]\{64\}"' "$work/ev.json" && grep -q '"race": true' "$work/ev.json" \
  && grep -q '"count": 1' "$work/ev.json" && grep -q '"shard": 0' "$work/ev.json" \
  && grep -q '"runID": 101' "$work/ev.json" && grep -q '"runAttempt": 1' "$work/ev.json"; then
  ok "the evidence records the duration, commit, run ID and attempt, inventory hash, -race, -count and shard"
else
  fail "the evidence is missing provenance: $(head -c 600 "$work/ev.json")"
fi
printf '{"Action":"pass","Package":"p","Elapsed":0.1}\n' > "$work/s-missing.json"
expect_evidence "an assigned test with no PASS is refused (missing PASS)" fail "$work/plan-a.json" "$work/s-missing.json" 0 -require-pass -forbid-skip
{ ev_line skip "$a_name/sub" 0; ev_line pass "$a_name" 1; } > "$work/s-subskip.json"
expect_evidence "a SUBTEST skip is refused under -forbid-skip" fail "$work/plan-a.json" "$work/s-subskip.json" 0 -require-pass -forbid-skip
expect_evidence "a subtest skip is recorded but allowed without -forbid-skip (the account lane)" ok "$work/plan-a.json" "$work/s-subskip.json" 0 -lane account
ev_line skip "$a_name" 0.01 > "$work/s-topskip.json"
expect_evidence "a top-level SKIP is refused under -require-pass -forbid-skip" fail "$work/plan-a.json" "$work/s-topskip.json" 0 -require-pass -forbid-skip
ev_line fail "$a_name" 2 > "$work/s-fail.json"
expect_evidence "a failed test is refused" fail "$work/plan-a.json" "$work/s-fail.json" 1 -require-pass -forbid-skip
expect_evidence "a non-zero go test exit is refused even when every test passed" fail "$work/plan-a.json" "$work/s-pass.json" 1 -require-pass -forbid-skip
{ ev_line pass "$a_name" 1; ev_line pass "$b_name" 1; } > "$work/s-extra.json"
expect_evidence "a top-level test outside this shard ran: the selector was not exact" fail "$work/plan-a.json" "$work/s-extra.json" 0 -require-pass -forbid-skip
{ ev_line pass "$a_name" 1; ev_line pass "$a_name" 1; } > "$work/s-dup.json"
expect_evidence "two results for one test under -count=1 are refused" fail "$work/plan-a.json" "$work/s-dup.json" 0 -require-pass -forbid-skip
{ ev_line pass "$a_name" 1; echo 'panic: not json'; } > "$work/s-nonjson.json"
expect_evidence "a line that is not a JSON event is refused" fail "$work/plan-a.json" "$work/s-nonjson.json" 0 -require-pass -forbid-skip
ev_line pass "$a_name" > "$work/s-noelapsed.json"
expect_evidence "a result with no elapsed time is refused" fail "$work/plan-a.json" "$work/s-noelapsed.json" 0 -require-pass -forbid-skip
sed 's/"schema": "relayium.go-race-plan\/1"/"schema": "x"/' "$work/plan-a.json" > "$work/plan-bad.json"
if evidence "$work/plan-bad.json" "$work/s-pass.json" 0 "$work/ev-bad.json" >/dev/null 2>&1; then
  fail "a plan with the wrong schema was accepted"
else
  ok "a plan with the wrong schema is refused"
fi

# Provenance the corpus could not check later is refused when it is recorded:
# the evidence is still written, marked incomplete.
for bad_flag in "-run-id 0" "-run-id abc" "-run-id 01" "-run-attempt 0" "-source-sha not-a-sha" "-toolchain not-a-toolchain" "-lane nonsense"; do
  # Word splitting is the point: each case is a flag and its value.
  # shellcheck disable=SC2086
  expect_evidence "evidence with $bad_flag is marked incomplete" fail "$work/plan-a.json" "$work/s-pass.json" 0 -require-pass -forbid-skip $bad_flag
done
expect_evidence "renewal evidence without -forbid-skip contradicts its lane" fail "$work/plan-a.json" "$work/s-pass.json" 0 -require-pass
if go run "$timings" evidence -lane renewal -plan "$work/plan-a.json" -json "$work/s-pass.json" -source-sha 0123456789abcdef0123456789abcdef01234567 \
  -toolchain 'go version go1.26.6 linux/amd64' -race -count 1 -go-exit 0 -require-pass -forbid-skip -out "$work/ev-norun.json" >/dev/null 2>&1; then
  fail "evidence with no run ID or attempt exited 0"
elif grep -q '"complete": false' "$work/ev-norun.json" && grep -q 'run-attempt' "$work/ev-norun.json"; then
  ok "evidence with no run ID or attempt is written but incomplete"
else
  fail "evidence with no run ID or attempt was not written as incomplete"
fi

# render passes every event's Output and every non-JSON line through, and
# reads to EOF so it never turns a failure into SIGPIPE.
render_out=$(go run "$timings" render < "$work/s-nonjson.json"; printf '{"Action":"output","Output":"=== RUN   TestX\\n"}\n' | go run "$timings" render)
case "$render_out" in
  *'panic: not json'*'=== RUN   TestX'*) ok "render prints Output and passes non-JSON lines through" ;;
  *) fail "render output was '$render_out'" ;;
esac

# The real go test -json format, not just the hand-written events above: a
# throw-away module with a PASS, a subtest SKIP and a top-level SKIP.
mod="$work/mod"
mkdir -p "$mod"
printf 'module example.com/m\n\ngo 1.21\n' > "$mod/go.mod"
cat > "$mod/m_test.go" <<'GO'
package m

import "testing"

func TestPass(t *testing.T)    {}
func TestSubSkip(t *testing.T) { t.Run("sub", func(t *testing.T) { t.Skip("reason") }) }
func TestTopSkip(t *testing.T) { t.Skip("reason") }
GO
printf 'TestPass\nTestSubSkip\nTestTopSkip\n' > "$work/mod-list.txt"
go run "$helper" -package ./m -names-from "$work/mod-list.txt" -shards 1 -shard 0 -plan-out "$work/mod-plan.json" > /dev/null 2>&1 \
  || fail "the module plan was refused"
(cd "$mod" && go test -count=1 -json ./... > "$work/mod-stream.json" 2>/dev/null) || fail "the throw-away module's go test failed"
expect_evidence "a real go test -json stream with skips is complete for a lane that allows skips" ok "$work/mod-plan.json" "$work/mod-stream.json" 0 -lane account
if grep -q '"TestSubSkip/sub"' "$work/ev.json" && grep -q '"action": "skip"' "$work/ev.json"; then
  ok "the real stream's subtest and top-level skips are recorded"
else
  fail "the real stream's skips were not recorded: $(head -c 600 "$work/ev.json")"
fi
expect_evidence "the same real stream is refused in the renewal lane" fail "$work/mod-plan.json" "$work/mod-stream.json" 0 -require-pass -forbid-skip

echo "go-race-shard-test: corpus"

# ── 11. a corpus is every shard of one run, complete, or nothing ────────────
{ ev_line pass "$b_name" 3.5; } > "$work/s-pass-b.json"
evidence "$work/plan-a.json" "$work/s-pass.json" 0 "$work/ev-a.json" -require-pass -forbid-skip 2>/dev/null || fail "evidence A refused"
evidence "$work/plan-b.json" "$work/s-pass-b.json" 0 "$work/ev-b.json" -require-pass -forbid-skip 2>/dev/null || fail "evidence B refused"
if go run "$timings" corpus -out "$work/corpus.json" -source 'test run 1 jobs 2 and 3' "$work/ev-b.json" "$work/ev-a.json" 2>"$work/corpus-err"; then
  ok "two complete shards of one run form a corpus"
else
  fail "a complete corpus was refused: $(cat "$work/corpus-err")"
fi
# The corpus is a weights file the planner accepts — the two tools agree.
if wplan "$work/corpus.json" "$work/ab.txt" 2 0 -loads > "$work/corpus-loads.txt" 2>"$work/err" \
  && [ "$(tr '\n' ' ' < "$work/corpus-loads.txt")" = "3500 1250 " ]; then
  ok "the planner accepts the corpus and plans by its measured durations"
else
  fail "the planner and the corpus disagree: loads '$(tr '\n' ' ' < "$work/corpus-loads.txt")'. $(cat "$work/err")"
fi
expect_corpus_fail() {
  # expect_corpus_fail <description> <reason-ERE> <evidence...> — refused, for that reason.
  desc=$1; why=$2; shift 2
  if go run "$timings" corpus -out "$work/corpus-bad.json" -source test "$@" >/dev/null 2>"$work/corpus-why"; then
    fail "$desc: the corpus was accepted"
  elif grep -Eq -- "$why" "$work/corpus-why"; then
    ok "$desc"
  else
    fail "$desc: refused, but not for /$why/: $(tr '\n' ' ' < "$work/corpus-why")"
  fi
}
expect_corpus_fail "an incomplete corpus (one shard of two) is refused" 'no evidence for shard 1 of 2' "$work/ev-a.json"
expect_corpus_fail "a corpus with a shard twice is refused" 'shard 0 appears twice' "$work/ev-a.json" "$work/ev-a.json"
sed 's/0123456789abcdef0123456789abcdef01234567/fedcba9876543210fedcba9876543210fedcba98/' "$work/ev-b.json" > "$work/ev-b-other.json"
expect_corpus_fail "a corpus mixing two commits is refused" 'does not describe the same run' "$work/ev-a.json" "$work/ev-b-other.json"
sed 's/"complete": true/"complete": false/' "$work/ev-b.json" > "$work/ev-b-incomplete.json"
expect_corpus_fail "a corpus with a shard that says it is incomplete is refused" 'says complete=false' "$work/ev-a.json" "$work/ev-b-incomplete.json"
sed 's/"race": true/"race": false/' "$work/ev-b.json" > "$work/ev-b-norace.json"
sed 's/"race": true/"race": false/' "$work/ev-a.json" > "$work/ev-a-norace.json"
expect_corpus_fail "a corpus measured without -race is refused" 'race=false' "$work/ev-a-norace.json" "$work/ev-b-norace.json"
sed 's/"TestLinkRenewA",$/"TestLinkRenewZ",/' "$work/ev-b.json" > "$work/ev-b-inv.json"
expect_corpus_fail "a corpus whose inventory does not hash to its recorded sha256 is refused" 'does not hash to its recorded sha256' "$work/ev-a.json" "$work/ev-b-inv.json"

# Forged records. The corpus must re-derive every fact from the record's own
# data, so each forgery below keeps `complete: true` and `problems: []` — the
# booleans a careless corpus would trust — and must still be refused for its
# own defect. forge rewrites top-level keys of an evidence file with raw JSON.
cat > "$work/forge.go" <<'GO'
//go:build ignore

package main

import (
	"encoding/json"
	"os"
	"strings"
)

func main() {
	raw, _ := os.ReadFile(os.Args[1])
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		panic(err)
	}
	for _, kv := range os.Args[3:] {
		k, v, _ := strings.Cut(kv, "=")
		if v == "DELETE" {
			delete(m, k)
		} else {
			m[k] = json.RawMessage(v)
		}
	}
	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(os.Args[2], out, 0o644); err != nil {
		panic(err)
	}
}
GO
forge() {
  # forge <in> <out> key=raw-json... — a forged copy of an evidence file.
  go run "$work/forge.go" "$@" 2>"$work/forge-err" || fail "forge $*: $(tr '\n' ' ' < "$work/forge-err")"
}
forged() {
  # forged <description> <reason-ERE> key=raw-json... — forge shard A only, then the corpus of A and B.
  desc=$1; why=$2; shift 2
  forge "$work/ev-a.json" "$work/ev-a-forged.json" "$@"
  expect_corpus_fail "$desc" "$why" "$work/ev-a-forged.json" "$work/ev-b.json"
}
# The reproduction Codex reported: FAIL then PASS for one test, fake commit and
# toolchain, complete=true. The FAIL must not be overwritten by the PASS.
forge "$work/ev-a.json" "$work/ev-a-mutant.json" "results=[{\"name\":\"$a_name\",\"action\":\"fail\",\"seconds\":1},{\"name\":\"$a_name\",\"action\":\"pass\",\"seconds\":9}]" \
  'sourceSHA="not-a-sha"' 'toolchain="not-a-toolchain"' 'complete=true' 'problems=[]'
forge "$work/ev-b.json" "$work/ev-b-mutant.json" "results=[{\"name\":\"$b_name\",\"action\":\"fail\",\"seconds\":1},{\"name\":\"$b_name\",\"action\":\"pass\",\"seconds\":9}]" \
  'sourceSHA="not-a-sha"' 'toolchain="not-a-toolchain"' 'complete=true' 'problems=[]'
expect_corpus_fail "the reported mutant (FAIL+PASS per test, fake commit and toolchain, complete=true) is refused" \
  'more than one result' "$work/ev-a-mutant.json" "$work/ev-b-mutant.json"
expect_corpus_fail "... and refused for its FAIL action too" 'action "fail" is not a PASS' "$work/ev-a-mutant.json" "$work/ev-b-mutant.json"
expect_corpus_fail "... and for its fake commit" 'sourceSHA "not-a-sha"' "$work/ev-a-mutant.json" "$work/ev-b-mutant.json"
expect_corpus_fail "... and for its fake toolchain" 'toolchain "not-a-toolchain"' "$work/ev-a-mutant.json" "$work/ev-b-mutant.json"
forged "a duplicated PASS result is refused" 'more than one result' \
  "results=[{\"name\":\"$a_name\",\"action\":\"pass\",\"seconds\":1},{\"name\":\"$a_name\",\"action\":\"pass\",\"seconds\":9}]"
forged "a FAIL result under complete=true is refused" 'action "fail"' "results=[{\"name\":\"$a_name\",\"action\":\"fail\",\"seconds\":1}]"
forged "an unknown action is refused" 'action "bogus"' "results=[{\"name\":\"$a_name\",\"action\":\"bogus\",\"seconds\":1}]"
forged "a missing result is refused" "assigned test $a_name has no result" 'results=[]'
forged "a result for an unassigned test is refused" "result for $b_name, which shard 0 was not assigned" \
  "results=[{\"name\":\"$a_name\",\"action\":\"pass\",\"seconds\":1},{\"name\":\"$b_name\",\"action\":\"pass\",\"seconds\":1}]"
forged "a negative duration is refused" 'outside \[0, 21600\]' "results=[{\"name\":\"$a_name\",\"action\":\"pass\",\"seconds\":-1}]"
forged "an unbounded duration is refused" 'outside \[0, 21600\]' "results=[{\"name\":\"$a_name\",\"action\":\"pass\",\"seconds\":1e9}]"
forged "a result without seconds is refused" 'seconds is missing or null' "results=[{\"name\":\"$a_name\",\"action\":\"pass\"}]"
forged "a SKIP in the renewal lane is refused" 'skipped in lane renewal' "results=[{\"name\":\"$a_name\",\"action\":\"skip\",\"seconds\":0}]"
forged "a skipped renewal subtest is refused" 'subtest .* skipped in lane renewal' "skippedSubtests=[\"$a_name/sub\"]"
forged "renewal evidence that turned its skip rules off is refused" 'lane renewal evidence says requirePass=false forbidSkip=false' \
  'requirePass=false' 'forbidSkip=false' "skippedSubtests=[\"$a_name/sub\"]"
forged "an unknown lane is refused" 'lane "other"' 'lane="other"'
forged "a go test exit of 1 under complete=true is refused" 'go test exited 1' 'goExit=1'
forged "count 2 is refused" 'count=2' 'count=2'
forged "a stale complete=true beside recorded problems is refused" 'with 1 problem' 'problems=["go test exited 1"]'
forged "a malformed commit is refused" 'sourceSHA "ABC"' 'sourceSHA="ABC"'
forged "a malformed toolchain is refused" 'toolchain "go1.26"' 'toolchain="go1.26"'
forged "run ID 0 is refused" 'run 0 attempt 1' 'runID=0'
forged "a negative attempt is refused" 'attempt -1' 'runAttempt=-1'
forged "a run ID beyond 2^53 is refused" 'is not a real GitHub run' 'runID=9007199254740993'
forged "a string run ID is refused" 'cannot unmarshal' 'runID="101"'
forged "a missing run ID is refused" 'runID is missing or null' 'runID=DELETE'
forged "a null run attempt is refused" 'runAttempt is missing or null' 'runAttempt=null'
forged "an unknown field is refused" 'unknown field' 'extra=1'
forged "a malformed weights digest is refused" 'with weights sha256' 'weightsSHA256="xyz"'
forged "a shard index outside the shard count is refused" 'shard 2 of 2' 'shard=2'
forged "planned loads of the wrong length are refused" 'plannedMS has 1 entries for 2 shards' 'plannedMS=[1]'
forged "an assignment outside the inventory is refused" 'outside the inventory' 'assigned=["TestLinkRenewZ"]'
forged "an unsorted inventory is refused" 'not sorted and unique' 'inventory=["TestLinkRenewB","TestLinkRenewA"]'
# One shard of a different attempt, or a different run, of the same commit.
forge "$work/ev-b.json" "$work/ev-b-attempt2.json" 'runAttempt=2'
expect_corpus_fail "shards from two attempts of one run are refused" 'does not describe the same run' "$work/ev-a.json" "$work/ev-b-attempt2.json"
forge "$work/ev-b.json" "$work/ev-b-run2.json" 'runID=102'
expect_corpus_fail "shards from two runs of one commit are refused" 'does not describe the same run' "$work/ev-a.json" "$work/ev-b-run2.json"
forge "$work/ev-b.json" "$work/ev-b-loads.json" 'plannedMS=[2000,999]'
expect_corpus_fail "shards that disagree on the planned loads are refused" 'does not describe the same run' "$work/ev-a.json" "$work/ev-b-loads.json"
# A duplicated key in the file text, where a map-based reader would keep the last.
sed 's/^  "goExit": 0,/  "goExit": 1, "goExit": 0,/' "$work/ev-a.json" > "$work/ev-a-dupkey.json"
expect_corpus_fail "a duplicated JSON key is refused" 'key "goExit" appears twice' "$work/ev-a-dupkey.json" "$work/ev-b.json"
# Both shards rewrite their assignment consistently: still a partition, but not
# the FNV one this mode claims, so an FNV corpus recomputes and refuses it.
printf 'TestAlpha\nTestBeta\nTestGamma\nTestDelta\nTestEpsilon\nTestZeta\n' > "$work/fnv6.txt"
for i in 0 1; do
  go run "$helper" -names-from "$work/fnv6.txt" -shards 2 -shard "$i" -plan-out "$work/fnv-plan$i.json" > "$work/fnv-re$i.txt" 2>/dev/null \
    || fail "the six-name FNV plan $i was refused"
  : > "$work/fnv-stream$i.json"
  for n in $(go run "$helper" -names-from "$work/fnv6.txt" -shards 2 -shard "$i" -list 2>/dev/null); do
    ev_line pass "$n" 0.5 >> "$work/fnv-stream$i.json"
  done
  go run "$timings" evidence -lane account -plan "$work/fnv-plan$i.json" -json "$work/fnv-stream$i.json" \
    -source-sha 0123456789abcdef0123456789abcdef01234567 -toolchain 'go version go1.26.6 linux/amd64' \
    -run-id 101 -run-attempt 1 -race -count 1 -go-exit 0 -out "$work/fnv-ev$i.json" 2>/dev/null || fail "FNV evidence $i refused"
done
# The account lane keeps the package's reasoned skips: a SKIP result and a
# skipped subtest are measured and accepted there.
first0=$(go run "$helper" -names-from "$work/fnv6.txt" -shards 2 -shard 0 -list 2>/dev/null | head -1)
skip_results=$(go run "$helper" -names-from "$work/fnv6.txt" -shards 2 -shard 0 -list 2>/dev/null \
  | awk -v f="$first0" 'BEGIN { printf "[" }
      { printf "%s{\"name\":\"%s\",\"action\":\"%s\",\"seconds\":0.5}", (NR > 1 ? "," : ""), $0, ($0 == f ? "skip" : "pass") }
      END { printf "]" }')
forge "$work/fnv-ev0.json" "$work/fnv-ev0-skip.json" "results=$skip_results" "skippedSubtests=[\"$first0/sub\"]"
if go run "$timings" corpus -out "$work/fnv-corpus.json" -source 'synthetic run 101' "$work/fnv-ev0-skip.json" "$work/fnv-ev1.json" 2>"$work/err"; then
  ok "an account corpus keeps a reasoned top-level SKIP and a skipped subtest"
else
  fail "an account corpus with a reasoned skip was refused: $(cat "$work/err")"
fi
moved=$(go run "$helper" -names-from "$work/fnv6.txt" -shards 2 -shard 1 -list 2>/dev/null | head -1)
a0=$(go run "$helper" -names-from "$work/fnv6.txt" -shards 2 -shard 0 -list 2>/dev/null; echo "$moved")
a1=$(go run "$helper" -names-from "$work/fnv6.txt" -shards 2 -shard 1 -list 2>/dev/null | grep -vx "$moved")
json_list() { printf '['; first=1; for n in $(printf '%s\n' "$@" | sort); do [ $first -eq 1 ] || printf ','; printf '"%s"' "$n"; first=0; done; printf ']'; }
json_results() { printf '['; first=1; for n in $(printf '%s\n' "$@" | sort); do [ $first -eq 1 ] || printf ','; printf '{"name":"%s","action":"pass","seconds":0.5}' "$n"; first=0; done; printf ']'; }
# Word splitting is the point: $a0 and $a1 are newline-separated name lists.
# shellcheck disable=SC2086
forge "$work/fnv-ev0.json" "$work/fnv-ev0-moved.json" "assigned=$(json_list $a0)" "results=$(json_results $a0)"
# shellcheck disable=SC2086
forge "$work/fnv-ev1.json" "$work/fnv-ev1-moved.json" "assigned=$(json_list $a1)" "results=$(json_results $a1)"
expect_corpus_fail "an FNV corpus whose assignment is not the hash's is refused" "FNV puts $moved in shard 1" \
  "$work/fnv-ev0-moved.json" "$work/fnv-ev1-moved.json"
if go run "$timings" corpus -out "$work/corpus-bad.json" "$work/ev-a.json" "$work/ev-b.json" >/dev/null 2>&1; then
  fail "a corpus without -source was accepted"
else
  ok "a corpus without a -source description is refused"
fi

echo "go-race-shard-test: the workflow's renewal step, as written"

# ── 12. the go.yml renewal step itself: plan, run, evidence, exit status ────
#
# The step is cut out of go.yml and run against a fake `go` that answers
# `go test -list` with two names and `go test -json` with a canned stream and
# exit status; every other `go` call (the two `go run`s, `go version`) is the
# real toolchain. This is the pipeline that has to keep go test's status
# through tee and render, and still leave evidence when it fails.
step="$work/step.sh"
awk '
  /name: go test -race \(A11 relay-renewal driver tests/ { found = 1; next }
  found && /^        run: \|/ { inrun = 1; next }
  inrun && /^      - / { exit }
  inrun { sub(/^          /, ""); print }
' "$root/.github/workflows/go.yml" | sed "s/'\\\${{ matrix.shard }}'/\"\\\$SHARD\"/g" > "$step"
# The literal `exit "$status"` is what is searched for, not an expansion.
# shellcheck disable=SC2016
if grep -q 'go-race-timings.go evidence' "$step" && grep -qF 'exit "$status"' "$step"; then
  ok "the renewal step was found in go.yml"
else
  fail "could not cut the renewal step out of go.yml: $(head -c 300 "$step")"
fi
real_go=$(command -v go)
mkdir -p "$work/fakebin" "$work/srv/cmd/relayium" "$work/scripts"
cp "$helper" "$timings" "$renew_weights" "$work/scripts/"
# The planner's own `go test -race -list` runs under `go run`, which puts the
# real toolchain first on its PATH, so the listed package is a real (tiny)
# module with the two renewal names; only the step's own race run is faked.
printf 'module fake\n\ngo 1.21\n' > "$work/srv/go.mod"
printf 'package main\n\nimport "testing"\n\nfunc TestLinkRenewA(t *testing.T) {}\nfunc TestLinkRenewB(t *testing.T) {}\nfunc TestOther(t *testing.T) {}\n' \
  > "$work/srv/cmd/relayium/x_test.go"
cat > "$work/fakebin/go" <<FAKE
#!/bin/sh
if [ "\$1" = test ]; then
  case " \$* " in
    *' -list '*) exec "$real_go" "\$@" ;;
    *) cat "\$FAKE_STREAM"; exit "\$FAKE_RC" ;;
  esac
fi
exec "$real_go" "\$@"
FAKE
chmod +x "$work/fakebin/go"
# The step records `git rev-parse HEAD`; the fake server tree is not a repository.
git_dir=$(git -C "$root" rev-parse --absolute-git-dir)
run_step() {
  # run_step <shard> <stream> <rc> — the step's exit status; evidence in $work/rt/go-race-timing.
  rm -rf "$work/rt"; mkdir -p "$work/rt"
  (cd "$work/srv" && PATH="$work/fakebin:$PATH" RUNNER_TEMP="$work/rt" SHARD=$1 GITHUB_RUN_ID=${RUN_ID-101} GITHUB_RUN_ATTEMPT=1 \
    FAKE_STREAM=$2 FAKE_RC=$3 GIT_DIR="$git_dir" bash "$step" >"$work/step-out" 2>&1) && echo 0 || echo $?
}
# The step reads the weights at ../scripts from server/; mirror that layout.
cp "$work/good.json" "$work/scripts/go-race-timings-renewal.json"
{ ev_line pass "$a_name" 1.25; } > "$work/step-pass.json"
rc=$(run_step 0 "$work/step-pass.json" 0)
if [ "$rc" = 0 ] && grep -q '"complete": true' "$work/rt/go-race-timing/evidence.json"; then
  ok "the step exits 0 with complete evidence when its shard PASSes"
else
  fail "the passing step exited $rc (want 0) or wrote no complete evidence: $(tail -5 "$work/step-out" | tr "\n" " ")"
fi
rc=$(run_step 0 "$work/step-pass.json" 1)
if [ "$rc" = 1 ] && [ -s "$work/rt/go-race-timing/evidence.json" ] && [ -s "$work/rt/go-race-timing/go-test.json" ]; then
  ok "go test's failure survives tee and render: the step exits 1 and still leaves its evidence and stream"
else
  fail "a failing go test made the step exit $rc (want 1), or lost the evidence"
fi
rc=$(run_step 0 "$work/s-subskip.json" 0)
if [ "$rc" != 0 ] && grep -q 'subtest .* skipped' "$work/rt/go-race-timing/evidence.json"; then
  ok "a subtest SKIP fails the renewal step even though go test exited 0"
else
  fail "a subtest SKIP left the renewal step at exit $rc"
fi
# The declarations the step greps must equal the compiled list: a declared
# test the compiler no longer sees (a build tag) fails the step.
printf '//go:build ignore\n\npackage main\n\nimport "testing"\n\nfunc TestLinkRenewTagged(t *testing.T) {}\n' \
  > "$work/srv/cmd/relayium/tagged_test.go"
rc=$(run_step 0 "$work/step-pass.json" 0)
if [ "$rc" != 0 ] && grep -q 'TestLinkRenewTagged is not in the compiled inventory' "$work/rt/go-race-timing/evidence.json"; then
  ok "a declared renewal test the compiler excludes fails the step"
else
  fail "a declared but build-excluded renewal test left the step at exit $rc"
fi
rm -f "$work/srv/cmd/relayium/tagged_test.go"
rc=$(RUN_ID='' run_step 0 "$work/step-pass.json" 0)
if [ "$rc" != 0 ] && grep -q 'run-id .* is not a positive decimal' "$work/rt/go-race-timing/evidence.json"; then
  ok "without a GitHub run ID the step fails rather than recording an unbound run"
else
  fail "a step with an empty GITHUB_RUN_ID exited $rc"
fi
rc=$(run_step 0 "$work/s-missing.json" 0)
if [ "$rc" != 0 ]; then
  ok "a missing PASS fails the renewal step even though go test exited 0"
else
  fail "a missing PASS left the renewal step green"
fi
echo
failures=$(wc -l < "$fail_log" | tr -d ' ')
if [ "$failures" -ne 0 ]; then
  printf 'go-race-shard-test: %d failure(s)\n' "$failures" >&2
  exit 1
fi
echo "go-race-shard-test: OK"
