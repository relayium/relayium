#!/usr/bin/env bash
# Tests for `acceptance_build` in scripts/lib/local-acceptance.sh — where the
# SwiftPM build directory goes, and nothing else about the library.
#
# The property under test is a two-sided contract, and testing one side alone
# leaves the other open. Unset `RELAYIUM_ACCEPTANCE_SWIFT_SCRATCH` must reach
# `swift build` with NO `--scratch-path` at all, because every existing caller
# depends on SwiftPM's in-package `.build/`; set, it must reach BOTH invocations
# with the same absolute path, because the second one is the `--show-bin-path`
# query and a pair that disagreed would report a binary the first call never
# wrote there.
#
# The relative-path case is the one that would pass a weaker test and still be
# wrong: both `swift build` calls run inside `( cd "$package_dir" && … )`, so a
# relative value forwarded verbatim lands inside the package — the exact place
# the variable exists to avoid — while the argument still looks correct in a log.
#
# `swift` and `go` are stubs on PATH that record their argv and exit 0. This
# suite is about argument construction; a run that actually compiled would be
# the acceptance script itself, and it would take minutes to say less.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
library="$repo_root/scripts/lib/local-acceptance.sh"

failures=0
ok()  { printf 'ok   — %s\n' "$1"; }
bad() { printf 'FAIL — %s\n     %s\n' "$1" "$2"; failures=$((failures + 1)); }

work="$(mktemp -d "${TMPDIR:-/tmp}/local-acceptance-scratch-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# Canonicalized the same way `acceptance_set_swift_scratch` canonicalizes the
# value it is handed, because every expectation below is built from `$work`. A
# `TMPDIR` with a trailing slash makes `mktemp` return a path containing `//`,
# and comparing that raw path against the library's `cd`-and-`pwd` answer would
# fail on the separator alone while the argument under test was correct.
work="$(cd "$work" && pwd)"

# The stubs. `swift --show-bin-path` answers with a directory holding an
# executable `LocalTransferPeer`, which is what `acceptance_build` checks.
mkdir -p "$work/bin" "$work/binpath"
: >"$work/binpath/LocalTransferPeer"
chmod +x "$work/binpath/LocalTransferPeer"

cat >"$work/bin/swift" <<'STUB'
#!/usr/bin/env bash
printf 'swift'      >>"$SWIFT_ARGV_LOG"
for a in "$@"; do printf '\t%s' "$a" >>"$SWIFT_ARGV_LOG"; done
printf '\n' >>"$SWIFT_ARGV_LOG"
for a in "$@"; do
  [ "$a" = "--show-bin-path" ] && { printf '%s\n' "$SWIFT_BIN_PATH"; break; }
done
exit 0
STUB
cat >"$work/bin/go" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$work/bin/swift" "$work/bin/go"

# One `acceptance_build` call in a fresh shell, with the library sourced and the
# run-root globals its failure path reads already set. Echoes the recorded
# `swift` argv; the caller reads the exit status for the refusal cases.
#
# A subshell would not do: `fail` exits, and a case that asserts the run stops
# must observe a real exit status rather than a function that returned.
run_build() {
  local scratch_env="$1" package_dir="$2" log="$work/swift-argv.log"
  : >"$log"
  SWIFT_ARGV_LOG="$log" SWIFT_BIN_PATH="$work/binpath" \
  PATH="$work/bin:$PATH" \
  RELAYIUM_ACCEPTANCE_SWIFT_SCRATCH="$scratch_env" \
    bash -c '
      set -eu
      run_tag=test run_root="$2"
      # shellcheck source=/dev/null
      source "$1"
      [ -n "${RELAYIUM_ACCEPTANCE_SWIFT_SCRATCH:-}" ] || unset RELAYIUM_ACCEPTANCE_SWIFT_SCRATCH
      acceptance_build "$2" "$3"
    ' _ "$library" "$work" "$package_dir" 2>/dev/null
  local status=$?
  cat "$log"
  return $status
}

package="$work/package"
mkdir -p "$package"

# ── unset: the shipped default, and no --scratch-path anywhere ───────────────
argv="$(run_build "" "$package")" && status=0 || status=$?
if [ "$status" -ne 0 ]; then
  bad "unset builds" "acceptance_build exited $status"
elif printf '%s' "$argv" | grep -q -- '--scratch-path'; then
  bad "unset passes no --scratch-path" "argv was: $argv"
elif [ "$(printf '%s\n' "$argv" | grep -c '^swift')" -ne 2 ]; then
  bad "unset still runs both swift builds" "argv was: $argv"
else
  ok "unset leaves SwiftPM's in-package default untouched"
fi

# ── set to an absolute path: both invocations, same path ─────────────────────
outside="$work/scratch-absolute"
argv="$(run_build "$outside" "$package")" && status=0 || status=$?
expected="$(printf 'swift\tbuild\t--scratch-path\t%s' "$outside")"
if [ "$status" -ne 0 ]; then
  bad "absolute scratch builds" "acceptance_build exited $status"
elif [ "$(printf '%s\n' "$argv" | grep -c -- "^$expected	--product	LocalTransferPeer")" -ne 2 ]; then
  bad "both swift builds take the same --scratch-path" "argv was: $argv"
elif ! printf '%s\n' "$argv" | grep -q -- '--show-bin-path'; then
  bad "the bin-path query still runs" "argv was: $argv"
elif [ ! -d "$outside" ]; then
  bad "the scratch directory is created" "$outside does not exist"
else
  ok "a set scratch path reaches both swift build invocations"
fi

# ── set to a relative path: resolved, and NOT inside the package ─────────────
relative_parent="$work/relative-here"
mkdir -p "$relative_parent"
argv="$(cd "$relative_parent" && run_build "scratch-relative" "$package")" && status=0 || status=$?
if [ "$status" -ne 0 ]; then
  bad "relative scratch builds" "acceptance_build exited $status"
elif ! printf '%s\n' "$argv" | grep -q -- "--scratch-path	$relative_parent/scratch-relative"; then
  bad "a relative scratch path is resolved against the CALLER's directory" \
      "argv was: $argv"
elif [ -e "$package/scratch-relative" ]; then
  bad "a relative scratch path does not land inside the package" \
      "$package/scratch-relative exists"
else
  ok "a relative scratch path is made absolute before the package cd"
fi

# ── an uncreatable path fails the run rather than falling back ───────────────
blocker="$work/not-a-directory"
: >"$blocker"
argv="$(run_build "$blocker/scratch" "$package")" && status=0 || status=$?
if [ "$status" -eq 0 ]; then
  bad "an uncreatable scratch path refuses the run" \
      "acceptance_build exited 0; argv was: $argv"
elif printf '%s\n' "$argv" | grep -q '^swift'; then
  bad "an uncreatable scratch path refuses BEFORE building" "argv was: $argv"
else
  ok "an uncreatable scratch path fails instead of silently using the default"
fi

if [ "$failures" -ne 0 ]; then
  printf '\n%d check(s) failed\n' "$failures"
  exit 1
fi
printf '\nall checks passed\n'
