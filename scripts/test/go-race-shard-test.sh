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
# Pure POSIX sh and one `go run` of a stdlib-only file. It never builds
# `./account`, so it belongs in the always-on repo-hygiene lane rather than
# behind the Go lane's path filter.

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

echo
failures=$(wc -l < "$fail_log" | tr -d ' ')
if [ "$failures" -ne 0 ]; then
  printf 'go-race-shard-test: %d failure(s)\n' "$failures" >&2
  exit 1
fi
echo "go-race-shard-test: OK"
