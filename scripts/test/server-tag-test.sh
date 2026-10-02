#!/bin/sh
# Tests for scripts/release/server-tag.sh — the tag selection and version
# arithmetic behind auto-release.yml.
#
# This suite exists for one incident. This repo tags two components: the server
# as `v0.18.0`, the macOS app as `macos-v1.1.3`. auto-release.yml asked
# `git describe --tags --abbrev=0` for "the last release", which answers with
# the newest tag of ANY family, and on 2026-08-12 that was the macOS app. The
# workflow then did version arithmetic on it and created `vmacos-v1.2.0`
# (run 31621252056); the release dispatched for that tag failed inside
# GoReleaser (run 31621273486) before publishing anything.
#
# The first fixture below is that repository shape — server tags, a NEWER macOS
# tag, and the malformed tag the incident left behind, which is now itself the
# newest tag and would poison the next run twice over. It asserts the selected
# tag, and that the exact call which caused the incident is now refused rather
# than turned into a version.
#
# The suite covers both ends of the tag rule, because fixing one leaves the
# other open: auto-release must not CREATE a tag that is not a server version,
# and release.yml must not BUILD AND SIGN one — a tag can also be pushed by
# hand, and workflow_dispatch can be pointed at a branch.
#
# Each case builds a real throwaway git repo, because the thing under test is a
# question about git's own tag and reachability behaviour — stubbing git would
# only assert that the fixtures agree with themselves. HOME and the system
# config are redirected so a developer's global git settings (signing, hooks,
# commit templates) cannot change the outcome. POSIX sh, like the script under
# test.
#   sh scripts/test/server-tag-test.sh
#
# Lives next to its subject and runs in CI — see .github/workflows/repo-hygiene.yml.
set -u

HERE=$(CDPATH='' cd -P -- "$(dirname -- "$0")" && pwd -P)
ROOT="$HERE/../.."
SCRIPT="$ROOT/scripts/release/server-tag.sh"
WORKFLOW="$ROOT/.github/workflows/auto-release.yml"
RELEASE_WORKFLOW="$ROOT/.github/workflows/release.yml"

TMPROOT=$(mktemp -d "${TMPDIR:-/tmp}/server-tag-test.XXXXXX")
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
# The oracle for "is this a server tag" is written out here rather than reused
# from the script, so a bug in the script's own matcher cannot make its output
# look valid to its own tests.
assert_canonical() {
  if printf '%s\n' "$2" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'; then ok "$1"; else
    bad "$1 (not a canonical server tag: [$2])"
  fi
}

# ---------------------------------------------------------------------------
# Fixture helpers. Deterministic identity and dates; no global config.
# ---------------------------------------------------------------------------
HOME="$TMPROOT/home"
XDG_CONFIG_HOME="$TMPROOT/home/.config"
GIT_CONFIG_NOSYSTEM=1
GIT_AUTHOR_NAME=test
GIT_AUTHOR_EMAIL=test@example.invalid
GIT_COMMITTER_NAME=test
GIT_COMMITTER_EMAIL=test@example.invalid
GIT_AUTHOR_DATE='2026-01-01T00:00:00+00:00'
GIT_COMMITTER_DATE='2026-01-01T00:00:00+00:00'
export HOME XDG_CONFIG_HOME GIT_CONFIG_NOSYSTEM
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
export GIT_AUTHOR_DATE GIT_COMMITTER_DATE
mkdir -p "$HOME"
# Pins the branch name across git versions and silences the default-branch hint.
printf '[init]\n\tdefaultBranch = main\n' >"$HOME/.gitconfig"

newrepo() {
  # newrepo NAME → prints the repo path
  r="$TMPROOT/$1"
  mkdir -p "$r"
  git -C "$r" init -q
  printf '%s\n' "$r"
}
cmt() {
  # cmt REPO SUBJECT [BODY]
  if [ $# -ge 3 ]; then
    git -C "$1" commit -q --allow-empty -m "$2" -m "$3"
  else
    git -C "$1" commit -q --allow-empty -m "$2"
  fi
}
tg() { git -C "$1" tag "$2"; }

run() {
  # run REPO ARGS... → sets $out and $rc
  r=$1
  shift
  out=$(cd "$r" && sh "$SCRIPT" "$@" 2>"$TMPROOT/err")
  rc=$?
}

# ---------------------------------------------------------------------------
# The incident: two tag families, the macOS one newer, plus the malformed tag
# the failed run left at HEAD.
# ---------------------------------------------------------------------------
echo 'mixed tag families (the auto-release incident)'
mixed=$(newrepo mixed)
cmt "$mixed" 'chore: seed'
tg "$mixed" v0.17.0
cmt "$mixed" 'feat(cli): something shipped'
tg "$mixed" v0.18.0
cmt "$mixed" 'chore(app): macOS 1.1.3'
tg "$mixed" macos-v1.1.3
cmt "$mixed" 'fix(server): a server change worth releasing'
tg "$mixed" vmacos-v1.2.0

# What the old implementation asked git, and what it got back. Recorded so the
# failure below reads as "the trap is still there", not as an unexplained diff.
described=$(git -C "$mixed" describe --tags --abbrev=0)
assert_eq 'fixture reproduces the trap: git describe returns the wrong family' \
  "$described" 'vmacos-v1.2.0'

run "$mixed" latest
assert_rc 'latest succeeds' "$rc" 0
assert_eq 'latest selects the newest SERVER tag, not the newer macOS tag' "$out" 'v0.18.0'
assert_canonical 'latest returns a canonical tag' "$out"

# The revision argument is part of the interface, so it is exercised: asked
# about v0.18.0's history, the later macOS tags are not in it either.
run "$mixed" latest v0.18.0
assert_eq 'latest honours an explicit revision' "$out" 'v0.18.0'

run "$mixed" next v0.18.0
assert_rc 'next succeeds from the selected server tag' "$rc" 0
assert_eq 'next bumps the patch (no feat since v0.18.0)' "$out" 'v0.18.1'

# The exact call the incident made. It must now be refused outright, so that no
# path exists from a foreign tag to a created version.
run "$mixed" next "$described"
assert_rc 'next refuses the tag git describe returned' "$rc" 1
assert_eq 'next prints nothing when it refuses' "$out" ''

# ---------------------------------------------------------------------------
# Nothing that is not a server tag may be turned into a version.
# ---------------------------------------------------------------------------
echo 'non-canonical bases are rejected'
plain=$(newrepo plain)
cmt "$plain" 'chore: seed'
tg "$plain" v1.0.0
cmt "$plain" 'fix: later'
for base in \
  'macos-v1.1.3' \
  'macos-v1.0' \
  'vmacos-v1.2.0' \
  'v1.2' \
  'v1.2.3.4' \
  'v1.2.3-rc1' \
  'v1.2.3+build' \
  '1.2.3' \
  'v1.a.3' \
  'v' \
  ''; do
  run "$plain" next "$base"
  assert_rc "next rejects [$base]" "$rc" 1
done
run "$plain" next v1.0.0
assert_rc 'next accepts a canonical base' "$rc" 0
assert_eq 'next from v1.0.0' "$out" 'v1.0.1'

# A caller that asks for something else gets a usage error, not a default.
run "$plain" bogus
assert_rc 'an unknown mode is a usage error' "$rc" 2

# ---------------------------------------------------------------------------
# Selection order. Versions are numbers, not strings.
# ---------------------------------------------------------------------------
echo 'selection'
order=$(newrepo order)
cmt "$order" 'chore: seed'
tg "$order" v0.9.0
cmt "$order" 'feat: ten'
tg "$order" v0.10.0
cmt "$order" 'fix: after'
run "$order" latest
assert_eq 'v0.10.0 outranks v0.9.0 (numeric, not lexical)' "$out" 'v0.10.0'

# A tag on a branch that never landed is not a released version of this line.
unmerged=$(newrepo unmerged)
cmt "$unmerged" 'chore: seed'
tg "$unmerged" v0.1.0
git -C "$unmerged" checkout -q -b side
cmt "$unmerged" 'feat: never merged'
tg "$unmerged" v9.9.9
git -C "$unmerged" checkout -q main
cmt "$unmerged" 'fix: on the mainline'
run "$unmerged" latest
assert_eq 'latest ignores tags unreachable from the revision' "$out" 'v0.1.0'

# Refusing to invent a first version is the caller's job, so the answer here is
# an empty success, not an error and not a neighbouring family's tag.
foreign=$(newrepo foreign)
cmt "$foreign" 'chore: seed'
tg "$foreign" macos-v1.0
cmt "$foreign" 'chore: more'
tg "$foreign" macos-v1.1.3
run "$foreign" latest
assert_rc 'latest succeeds when only foreign tags exist' "$rc" 0
assert_eq 'latest prints nothing when only foreign tags exist' "$out" ''

untagged=$(newrepo untagged)
cmt "$untagged" 'chore: seed'
run "$untagged" latest
assert_rc 'latest succeeds in an untagged repo' "$rc" 0
assert_eq 'latest prints nothing in an untagged repo' "$out" ''

# ---------------------------------------------------------------------------
# Version arithmetic, anchored to the base tag.
# ---------------------------------------------------------------------------
echo 'bump semantics'
bump_case() {
  # bump_case NAME SUBJECT BODY WANT
  b=$(newrepo "bump-$1")
  cmt "$b" 'chore: seed'
  tg "$b" v0.5.2
  if [ -n "$3" ]; then cmt "$b" "$2" "$3"; else cmt "$b" "$2"; fi
  run "$b" next v0.5.2
  assert_eq "$1" "$out" "$4"
  assert_canonical "$1 is canonical" "$out"
}
bump_case feat 'feat: a new thing' '' v0.6.0
bump_case feat-scoped 'feat(cli): a new thing' '' v0.6.0
bump_case fix 'fix: a small thing' '' v0.5.3
bump_case chore 'chore: docs only' '' v0.5.3
bump_case bang 'refactor!: drop the old wire format' '' v0.6.0
bump_case breaking-body 'fix: subtle' 'BREAKING CHANGE: the wire format moved' v0.6.0

# The base tag bounds the range: a feat BEFORE it was already released and must
# not bump anything now. This is the property that broke silently when the base
# tag came from the wrong family.
anchor=$(newrepo anchor)
cmt "$anchor" 'chore: seed'
cmt "$anchor" 'feat: shipped in 0.5.2 already'
tg "$anchor" v0.5.2
cmt "$anchor" 'fix: since then'
run "$anchor" next v0.5.2
assert_eq 'commits before the base tag do not bump the version' "$out" 'v0.5.3'

# The shape that made `git log --format='%B' ... | grep -q 'BREAKING CHANGE'`
# lie. git logs newest first, so a breaking change in the NEWEST commit is the
# first thing grep sees: grep -q matches and exits, git takes SIGPIPE on the
# rest, and under the caller's `pipefail` the pipeline reports 141 — which
# reads as "no breaking change found" on exactly the histories that have one.
# The bodies are padded so the remaining output cannot fit in a pipe buffer;
# without that, git finishes writing before grep leaves and the bug hides.
long=$(newrepo long)
cmt "$long" 'chore: seed'
tg "$long" v0.5.2
pad=''
i=0
while [ "$i" -lt 40 ]; do
  pad="$pad body text that exists only to push this log past a pipe buffer,"
  i=$((i + 1))
done
i=0
while [ "$i" -lt 40 ]; do
  cmt "$long" "chore: filler $i" "$pad"
  i=$((i + 1))
done
cmt "$long" 'fix: last' 'BREAKING CHANGE: the wire format moved'
run "$long" next v0.5.2
assert_eq 'a breaking change is found without truncating a long log' "$out" 'v0.6.0'

# ---------------------------------------------------------------------------
# previous: the release-notes anchor GoReleaser is handed. On 2026-10-02 its own
# guess (the nearest tag of ANY family) made v0.27.0's notes the 11 commits since
# `macos-v1.4.5` instead of the 384 since v0.26.0.
# ---------------------------------------------------------------------------
echo 'previous (the release-notes anchor)'
rev_of() { git -C "$1" rev-parse "$2^{commit}"; }

fam=$(newrepo prev-family)
cmt "$fam" 'chore: seed'
tg "$fam" v0.25.0
cmt "$fam" 'feat: 0.26'
git -C "$fam" tag -a -m 'v0.26.0' v0.26.0
cmt "$fam" 'chore(app): macOS 1.4.5'
tg "$fam" macos-v1.4.5
cmt "$fam" 'fix: since the mac tag'
git -C "$fam" tag -a -m 'v0.27.0' v0.27.0
# The trap, reproduced: what GoReleaser's default asked git.
trap_prev=$(git -C "$fam" describe --tags --abbrev=0 'v0.27.0^')
assert_eq 'fixture reproduces the notes trap: the nearest tag is the macOS one' "$trap_prev" 'macos-v1.4.5'
run "$fam" previous v0.27.0 "$(rev_of "$fam" v0.27.0)"
assert_rc 'previous succeeds for a canonical tag at its own commit' "$rc" 0
assert_eq 'previous is the earlier SERVER release, not the newer macOS tag' "$out" 'v0.26.0'
assert_canonical 'previous returns a canonical tag' "$out"
run "$fam" previous v0.27.0
assert_eq 'previous defaults REV to HEAD (the checked-out tag)' "$out" 'v0.26.0'
run "$fam" previous v0.26.0 "$(rev_of "$fam" v0.26.0)"
assert_eq 'previous of an older release is the one before it (annotated tags peel)' "$out" 'v0.25.0'

# Several versions on one commit: each one's previous is the next lower, and a
# HIGHER version on the same commit is never the anchor of a lower one.
same=$(newrepo prev-same-commit)
cmt "$same" 'chore: seed'
tg "$same" v0.25.0
cmt "$same" 'feat: one commit, three versions'
tg "$same" v0.26.0
tg "$same" v0.27.0
tg "$same" v0.28.0
run "$same" previous v0.27.0
assert_eq 'same commit: v0.27.0 follows v0.26.0, ignoring v0.28.0 beside it' "$out" 'v0.26.0'
run "$same" previous v0.26.0
assert_eq 'same commit: v0.26.0 follows v0.25.0' "$out" 'v0.25.0'
run "$same" previous v0.28.0
assert_eq 'same commit: v0.28.0 follows v0.27.0' "$out" 'v0.27.0'

# A historical (re-)release is bounded below: a higher version reachable from
# it — an out-of-order number in its own history — is ignored.
hist=$(newrepo prev-history)
cmt "$hist" 'chore: seed'
tg "$hist" v0.26.0
cmt "$hist" 'chore: a mis-numbered old release'
tg "$hist" v0.30.0
cmt "$hist" 'fix: later'
tg "$hist" v0.27.0
run "$hist" previous v0.27.0
assert_eq 'a higher version earlier in history is not the previous release' "$out" 'v0.26.0'

# Numbers, not strings: v0.10.0 outranks v0.9.0, and a zero-padded `08` is
# eight (shell arithmetic would read it as invalid octal).
num=$(newrepo prev-numeric)
cmt "$num" 'chore: seed'
tg "$num" v0.9.0
cmt "$num" 'feat: ten'
tg "$num" v0.10.0
cmt "$num" 'feat: eleven'
tg "$num" v0.11.0
run "$num" previous v0.11.0
assert_eq 'numeric: v0.11.0 follows v0.10.0, not v0.9.0' "$out" 'v0.10.0'
oct=$(newrepo prev-octal)
cmt "$oct" 'chore: seed'
tg "$oct" v0.7.0
cmt "$oct" 'feat: padded'
tg "$oct" v0.08.0
cmt "$oct" 'feat: nine'
tg "$oct" v0.9.0
run "$oct" previous v0.9.0
assert_rc 'numeric: a zero-padded component is not octal' "$rc" 0
assert_eq 'numeric: v0.08.0 is eight, so it precedes v0.9.0' "$out" 'v0.08.0'

# Components past the shell's integer range, and zero-padded spellings: the
# comparison is decimal at any length, never test(1) on a whole component
# (status 2 there would read as "not lower" and keep a wrong anchor).
big=$(newrepo prev-bigint)
cmt "$big" 'chore: seed'
tg "$big" v0.27.0
cmt "$big" 'feat: a long minor'
tg "$big" v0.999999999999999999999999.0
cmt "$big" 'feat: one'
tg "$big" v1.0.0
run "$big" previous v1.0.0
assert_rc 'oversized components: previous succeeds' "$rc" 0
assert_eq 'oversized components: v0.999999999999999999999999.0 outranks v0.27.0 below v1.0.0' "$out" 'v0.999999999999999999999999.0'
run "$big" previous v0.999999999999999999999999.0 "$(rev_of "$big" v0.999999999999999999999999.0)"
assert_eq 'oversized current: the release below it is still found' "$out" 'v0.27.0'
same_len=$(newrepo prev-bigint-same-length)
cmt "$same_len" 'chore: seed'
tg "$same_len" v0.18446744073709551615.0
cmt "$same_len" 'feat: next'
tg "$same_len" v0.18446744073709551616.0
cmt "$same_len" 'feat: next again'
tg "$same_len" v0.18446744073709551617.0
run "$same_len" previous v0.18446744073709551617.0
assert_eq 'oversized, equal length: the first differing digit decides' "$out" 'v0.18446744073709551616.0'
pad=$(newrepo prev-padded)
cmt "$pad" 'chore: seed'
tg "$pad" v0.9.0
cmt "$pad" 'feat: ten, spelled twice'
tg "$pad" v0.010.0
tg "$pad" v0.10.0
cmt "$pad" 'feat: eleven'
tg "$pad" v0.11.0
run "$pad" previous v0.11.0
case $out in
  v0.10.0 | v0.010.0) ok 'zero-padded: ten (either spelling) precedes eleven' ;;
  *) bad "zero-padded: ten (either spelling) precedes eleven (got [$out])" ;;
esac
run "$pad" previous v0.10.0 "$(rev_of "$pad" v0.10.0)"
assert_eq 'zero-padded: v0.010.0 equals v0.10.0, so it is not lower; v0.9.0 is' "$out" 'v0.9.0'

# A tag on a branch that never reached the released commit is not its previous.
side=$(newrepo prev-unmerged)
cmt "$side" 'chore: seed'
tg "$side" v0.26.0
git -C "$side" checkout -q -b side
cmt "$side" 'feat: never merged'
tg "$side" v0.26.5
git -C "$side" checkout -q main
cmt "$side" 'fix: mainline'
tg "$side" v0.27.0
run "$side" previous v0.27.0
assert_eq 'previous ignores a lower tag that is not reachable' "$out" 'v0.26.0'

# A hotfix line merged back: the highest lower version, not the nearest ancestor.
hot=$(newrepo prev-hotfix)
cmt "$hot" 'chore: seed'
tg "$hot" v0.20.0
git -C "$hot" checkout -q -b hotfix
# Three hotfix commits against one mainline commit to v0.21.0, so after the
# merge `git describe` (fewest commits since the tag) answers with the hotfix.
cmt "$hot" 'fix: hotfix 1'
cmt "$hot" 'fix: hotfix 2'
cmt "$hot" 'fix: hotfix 3'
tg "$hot" v0.20.1
git -C "$hot" checkout -q main
cmt "$hot" 'feat: 0.21'
tg "$hot" v0.21.0
cmt "$hot" 'chore: after 0.21'
cmt "$hot" 'chore: more after 0.21'
git -C "$hot" merge -q --no-ff -m 'merge hotfix' hotfix
cmt "$hot" 'feat: 0.22 after the merge'
tg "$hot" v0.22.0
near=$(git -C "$hot" describe --tags --abbrev=0 'v0.22.0^')
assert_eq 'fixture: the nearest tag after the hotfix merge is the hotfix' "$near" 'v0.20.1'
run "$hot" previous v0.22.0
assert_eq 'after a hotfix merge, previous is the highest lower release' "$out" 'v0.21.0'
run "$hot" previous v0.20.1 "$(rev_of "$hot" v0.20.1)"
assert_eq 'the hotfix release itself follows v0.20.0' "$out" 'v0.20.0'

# A release tag on a detached commit (on no branch at all).
det=$(newrepo prev-detached)
cmt "$det" 'chore: seed'
tg "$det" v0.27.0
git -C "$det" checkout -q --detach
cmt "$det" 'fix: detached release'
tg "$det" v0.27.1
git -C "$det" checkout -q main
run "$det" previous v0.27.1 "$(rev_of "$det" v0.27.1)"
assert_eq 'a detached release tag finds its previous release' "$out" 'v0.27.0'

# Refusals: no fallback, no empty first release, no other family.
first=$(newrepo prev-first)
cmt "$first" 'chore: seed'
tg "$first" macos-v1.4.5
cmt "$first" 'feat: first server release'
tg "$first" v0.1.0
run "$first" previous v0.1.0
assert_rc 'no earlier server release is an error' "$rc" 1
assert_eq 'no earlier server release prints nothing (never the macOS tag)' "$out" ''
lower_unreachable=$(newrepo prev-only-unreachable)
cmt "$lower_unreachable" 'chore: seed'
git -C "$lower_unreachable" checkout -q -b side
cmt "$lower_unreachable" 'feat: side'
tg "$lower_unreachable" v0.1.0
git -C "$lower_unreachable" checkout -q main
cmt "$lower_unreachable" 'feat: main'
tg "$lower_unreachable" v0.2.0
run "$lower_unreachable" previous v0.2.0
assert_rc 'a lower tag that is only on another branch is not a previous release' "$rc" 1

for cur in 'macos-v1.4.5' 'vmacos-v1.2.0' 'v1.2' 'v1.2.3-rc1' 'v1.2.3.4' 'refs/tags/v0.27.0' 'v' ''; do
  run "$fam" previous "$cur"
  assert_rc "previous rejects the current tag [$cur]" "$rc" 1
  assert_eq "previous prints nothing for [$cur]" "$out" ''
done
# Non-canonical tags AT the release commit: only the shape check refuses these
# (each exists and names the built commit, and v0.26.0 is reachable below them).
tg "$fam" v0.27.0-rc1
tg "$fam" macos-v1.4.6
for cur in v0.27.0-rc1 macos-v1.4.6; do
  run "$fam" previous "$cur" "$(rev_of "$fam" v0.27.0)"
  assert_rc "previous rejects [$cur] although it names the built commit" "$rc" 1
  assert_eq "previous prints nothing for [$cur] at the built commit" "$out" ''
done
run "$fam" previous
assert_rc 'previous without a current tag is a usage error' "$rc" 2
run "$fam" previous v0.27.0 HEAD extra
assert_rc 'previous with an extra argument is a usage error' "$rc" 2
run "$fam" previous v9.9.9
assert_rc 'previous refuses a canonical tag that does not exist' "$rc" 1
run "$fam" previous v0.27.0 "$(rev_of "$fam" v0.26.0)"
assert_rc 'previous refuses a tag that does not name the commit being released' "$rc" 1
assert_eq 'previous prints nothing for a tag/commit mismatch' "$out" ''
run "$fam" previous v0.27.0 not-a-revision
assert_rc 'previous refuses a revision that is not a commit' "$rc" 1
treetag=$(newrepo prev-tree-tag)
cmt "$treetag" 'chore: seed'
tg "$treetag" v0.1.0
cmt "$treetag" 'chore: more'
git -C "$treetag" tag v0.2.0 'HEAD^{tree}'
run "$treetag" previous v0.2.0
assert_rc 'previous refuses a tag that names a tree, not a commit' "$rc" 1

# A failed git query is a failure, not "no previous release" and not a guess.
# The wrapper fails exactly one git subcommand and is otherwise the real git.
fakebin="$TMPROOT/fake-git-bin"
mkdir -p "$fakebin"
real_git=$(command -v git)
# shellcheck disable=SC2016 # the wrapper's own expansions, written literally
{
  printf '#!/bin/sh\n'
  printf 'for a in "$@"; do\n'
  printf '  if [ "$a" = "$FAIL_GIT_SUBCOMMAND" ]; then\n'
  # PARTIAL: the real answer is written first, then the read fails — the
  # shape in which a swallowed error would still yield a plausible tag.
  printf '    [ -n "${FAIL_GIT_PARTIAL:-}" ] && "%s" "$@"\n' "$real_git"
  printf '    echo "fatal: unable to read refs: Input/output error" >&2\n'
  printf '    exit 128\n'
  printf '  fi\n'
  printf 'done\n'
  printf 'exec "%s" "$@"\n' "$real_git"
} >"$fakebin/git"
chmod +x "$fakebin/git"
failing_git() {
  # failing_git REPO SUBCOMMAND ARGS... → sets $out and $rc
  r=$1
  sub=$2
  shift 2
  out=$(cd "$r" && PATH="$fakebin:$PATH" FAIL_GIT_SUBCOMMAND=$sub sh "$SCRIPT" "$@" 2>"$TMPROOT/err")
  rc=$?
}
failing_git "$fam" never previous v0.27.0
assert_eq 'the failing-git wrapper is transparent when nothing fails (control)' "$out" 'v0.26.0'
for sub in tag rev-parse; do
  failing_git "$fam" "$sub" previous v0.27.0
  assert_rc "previous fails when git $sub fails (EIO)" "$rc" 1
  assert_eq "previous prints nothing when git $sub fails" "$out" ''
done
failing_git "$fam" tag previous v0.27.0
if grep -q 'could not list the tags reachable from' "$TMPROOT/err"; then
  ok 'a failed tag query is reported as a failed query, not as "no previous release"'
else
  bad 'a failed tag query is reported as a failed query, not as "no previous release"'
  sed 's/^/       | /' "$TMPROOT/err"
fi
out=$(cd "$fam" && PATH="$fakebin:$PATH" FAIL_GIT_SUBCOMMAND=tag FAIL_GIT_PARTIAL=1 sh "$SCRIPT" previous v0.27.0 2>"$TMPROOT/err")
rc=$?
assert_rc 'previous fails when the tag query fails after a complete-looking answer' "$rc" 1
assert_eq 'previous prints nothing when the tag query fails after a complete-looking answer' "$out" ''

# latest is unchanged by the new mode: still the newest server tag.
run "$fam" latest
assert_eq 'latest still returns the newest server tag' "$out" 'v0.27.0'

# ---------------------------------------------------------------------------
# The other end of the same rule: which refs release.yml agrees to build and
# sign. Fixing auto-release stops this repo from creating `vmacos-v1.2.0`; it
# does not stop that tag, or a hand-pushed one, from being built if it exists.
# ---------------------------------------------------------------------------
echo 'validate-ref (the release gate)'
for ref in \
  'refs/tags/v0.18.1' \
  'refs/tags/v0.0.0' \
  'refs/tags/v10.20.30'; do
  run "$plain" validate-ref "$ref"
  assert_rc "validate-ref accepts [$ref]" "$rc" 0
  assert_eq "validate-ref echoes the tag for [$ref]" "$out" "${ref#refs/tags/}"
  assert_canonical "validate-ref returns a canonical tag for [$ref]" "$out"
done

# The incident tag heads this list. Everything after it is a shape `next` also
# refuses, asserted here through the ref interface so the two ends cannot be
# fixed apart from each other; then the refs that are not tags at all, which is
# what a workflow_dispatch aimed at a branch delivers.
for ref in \
  'refs/tags/vmacos-v1.2.0' \
  'refs/tags/v1.2' \
  'refs/tags/v1.2.3.4' \
  'refs/tags/v1.2.3-rc1' \
  'refs/tags/v1.2.3+build' \
  'refs/tags/v1.2.3 ' \
  'refs/tags/macos-v1.1.3' \
  'refs/tags/1.2.3' \
  'refs/tags/v1.a.3' \
  'refs/tags/nested/v1.2.3' \
  'refs/tags/v' \
  'refs/tags/' \
  'refs/heads/main' \
  'refs/heads/feature/fleet-manual-push' \
  'refs/heads/v1.2.3' \
  'refs/pull/12/merge' \
  'v0.18.1' \
  ''; do
  run "$plain" validate-ref "$ref"
  assert_rc "validate-ref rejects [$ref]" "$rc" 1
  assert_eq "validate-ref prints nothing when it rejects [$ref]" "$out" ''
done

# ---------------------------------------------------------------------------
# release.yml wiring. The gate is only a gate if it runs BEFORE the steps that
# make this job trusted — the signing key and GoReleaser — so its position is
# asserted, not just its presence.
# ---------------------------------------------------------------------------
echo 'release.yml wiring'
line_of() {
  # line_of PATTERN → first matching line number, or empty
  grep -n -- "$1" "$RELEASE_WORKFLOW" | head -n 1 | cut -d: -f1
}
gate=$(line_of 'server-tag.sh validate-ref')
keystep=$(line_of 'Materialize release signing key')
gorel=$(line_of 'goreleaser/goreleaser-action@')
if [ -n "$gate" ]; then
  ok 'release.yml validates its ref through server-tag.sh'
else
  bad 'release.yml validates its ref through server-tag.sh'
fi
if [ -n "$gate" ] && [ -n "$keystep" ] && [ "$gate" -lt "$keystep" ]; then
  ok 'the gate runs before the signing key is materialized'
else
  bad "the gate runs before the signing key is materialized (gate=$gate key=$keystep)"
fi
if [ -n "$gate" ] && [ -n "$gorel" ] && [ "$gate" -lt "$gorel" ]; then
  ok 'the gate runs before GoReleaser'
else
  bad "the gate runs before GoReleaser (gate=$gate goreleaser=$gorel)"
fi

# The release-notes range: computed by `previous` before the key exists, and
# handed to GoReleaser explicitly — not left to its nearest-tag guess.
pin=$(line_of 'id: tags')
# shellcheck disable=SC2016 # the workflow's literal text
prevcall=$(line_of 'server-tag.sh previous "$current" "$GITHUB_SHA"')
if [ -n "$prevcall" ] && [ -n "$pin" ] && [ "$pin" -lt "$prevcall" ] &&
  [ "$(grep -c 'id: tags' "$RELEASE_WORKFLOW")" = 1 ]; then
  ok 'release.yml computes the previous tag in the one step whose id is tags, from the built commit'
else
  bad "release.yml computes the previous tag in the one step whose id is tags (id=$pin previous=$prevcall)"
fi
if [ -n "$prevcall" ] && [ -n "$keystep" ] && [ "$prevcall" -lt "$keystep" ]; then
  ok 'the previous tag is established before the signing key is materialized'
else
  bad "the previous tag is established before the signing key is materialized (previous=$prevcall key=$keystep)"
fi
# The GoReleaser step's own block: from its `uses:` line to the next step.
gorel_block=$(awk -v start="$gorel" 'NR == start { inblk = 1; print; next }
  inblk && /^      - / { exit }
  inblk { print }' "$RELEASE_WORKFLOW")
# shellcheck disable=SC2016 # the workflow's literal text
for want in 'GORELEASER_CURRENT_TAG: ${{ steps.tags.outputs.current }}' \
  'GORELEASER_PREVIOUS_TAG: ${{ steps.tags.outputs.previous }}'; do
  if printf '%s\n' "$gorel_block" | grep -qxF "          $want"; then
    ok "GoReleaser's own env carries [$want]"
  else
    bad "GoReleaser's own env carries [$want]"
  fi
done
if grep -n 'GORELEASER_\(CURRENT\|PREVIOUS\)_TAG' "$RELEASE_WORKFLOW" | grep -v '^[0-9]*:          GORELEASER_' | grep -q .; then
  bad 'GORELEASER_CURRENT_TAG/PREVIOUS_TAG are set only in the GoReleaser step'
else
  ok 'GORELEASER_CURRENT_TAG/PREVIOUS_TAG are set only in the GoReleaser step'
fi

# The step itself, RUN: its script extracted from release.yml and executed in
# a real repository, so what it writes for GoReleaser is observed, not read.
pin_script="$TMPROOT/pin-step.sh"
awk 'index($0, "- name: Pin the current and previous server release tags") { found = 1; next }
  found && !inrun && /^        run: \|$/ { inrun = 1; next }
  found && inrun && /^          / { sub(/^          /, ""); print; next }
  found && inrun && /^[[:space:]]*$/ { print ""; next }
  found && inrun { exit }' "$RELEASE_WORKFLOW" >"$pin_script"
pinrepo=$(newrepo pin-step)
cmt "$pinrepo" 'chore: seed'
tg "$pinrepo" v0.26.0
cmt "$pinrepo" 'chore(app): macOS 1.4.5'
tg "$pinrepo" macos-v1.4.5
cmt "$pinrepo" 'fix: release'
tg "$pinrepo" v0.27.0
cmt "$pinrepo" 'chore: after the release'
mkdir -p "$pinrepo/scripts/release"
cp "$SCRIPT" "$pinrepo/scripts/release/server-tag.sh"
run_pin() {
  # run_pin REF SHA [FAIL_GIT_SUBCOMMAND] → sets $rc; outputs in $TMPROOT/pin-out
  : >"$TMPROOT/pin-out"
  (cd "$pinrepo" && GITHUB_REF=$1 GITHUB_SHA=$2 GITHUB_OUTPUT="$TMPROOT/pin-out" \
    GITHUB_STEP_SUMMARY="$TMPROOT/pin-summary" FAIL_GIT_SUBCOMMAND=${3:-never} PATH="$fakebin:$PATH" \
    sh "$pin_script" >"$TMPROOT/pin-log" 2>&1)
  rc=$?
}
tagsha=$(rev_of "$pinrepo" v0.27.0)
if [ -s "$pin_script" ] && grep -q 'server-tag.sh previous' "$pin_script"; then
  ok 'the pin step script was extracted from release.yml'
else
  bad 'the pin step script was extracted from release.yml'
fi
run_pin refs/tags/v0.27.0 "$tagsha"
assert_rc 'the pin step succeeds for a canonical tag at its own commit' "$rc" 0
assert_eq 'the pin step hands GoReleaser exactly current and previous' "$(cat "$TMPROOT/pin-out")" \
  "$(printf 'current=v0.27.0\nprevious=v0.26.0')"
run_pin refs/tags/v0.27.0 "$(rev_of "$pinrepo" HEAD)"
assert_rc 'the pin step fails when the built commit is not the tag'"'"'s' "$rc" 1
assert_eq 'the pin step writes nothing when the built commit is not the tag'"'"'s' "$(cat "$TMPROOT/pin-out")" ''
run_pin refs/heads/main "$tagsha"
assert_rc 'the pin step fails for a branch ref' "$rc" 1
assert_eq 'the pin step writes nothing for a branch ref' "$(cat "$TMPROOT/pin-out")" ''
run_pin refs/tags/v0.27.0 "$tagsha" tag
assert_rc 'the pin step fails when the tag query fails (EIO)' "$rc" 1
assert_eq 'the pin step writes nothing when the tag query fails' "$(cat "$TMPROOT/pin-out")" ''
run_pin refs/tags/v0.26.0 "$(rev_of "$pinrepo" v0.26.0)"
assert_rc 'the pin step fails when there is no earlier server release' "$rc" 1
assert_eq 'the pin step writes nothing when there is no earlier server release' "$(cat "$TMPROOT/pin-out")" ''

# `v*` is the filter that let `vmacos-v1.2.0` start a build. The glob is not
# trusted to be sufficient — that is what the gate above is for — but it must
# not be widened back to matching another tag family.
if grep -qE "^[[:space:]]*-[[:space:]]*'v\*'[[:space:]]*$" "$RELEASE_WORKFLOW"; then
  bad "release.yml's tag filter is back to 'v*' (matches vmacos-v1.2.0)"
else
  ok "release.yml's tag filter is narrower than 'v*'"
fi

# Manual dispatch is the only way to re-run a tag whose first build failed:
# a tag pushed by auto-release with GITHUB_TOKEN starts nothing by itself.
# Removing it would be a worse failure than the one being fixed here.
if grep -q 'workflow_dispatch' "$RELEASE_WORKFLOW"; then
  ok 'release.yml can still be dispatched to re-run a failed tag'
else
  bad 'release.yml can still be dispatched to re-run a failed tag'
fi

# This workflow holds the signing key, so a floating action tag here would be
# an unreviewed third party inside it.
unpinned=$(grep -E '^[[:space:]]*-?[[:space:]]*uses:' "$RELEASE_WORKFLOW" |
  grep -Ev '@[0-9a-f]{40}([[:space:]]|$)')
if [ -z "$unpinned" ]; then
  ok 'every action in release.yml is pinned to a full commit SHA'
else
  bad 'every action in release.yml is pinned to a full commit SHA'
  printf '%s\n' "$unpinned" | sed 's/^/       | /'
fi

# ---------------------------------------------------------------------------
# The workflow must keep asking this script, not git describe. Without this the
# fix is one convenience edit away from being undone.
# ---------------------------------------------------------------------------
echo 'auto-release.yml wiring'
# Comments are stripped before the search: the workflow explains at length why
# it must not make this call, and saying so is not making it.
if sed 's/#.*$//' "$WORKFLOW" | grep -q 'git describe'; then
  bad 'auto-release.yml no longer calls git describe'
  sed 's/#.*$//' "$WORKFLOW" | grep -n 'git describe' | sed 's/^/       | /'
else
  ok 'auto-release.yml no longer calls git describe'
fi
if grep -q 'server-tag.sh latest' "$WORKFLOW"; then
  ok 'auto-release.yml selects its base tag through server-tag.sh'
else
  bad 'auto-release.yml selects its base tag through server-tag.sh'
fi
if grep -q 'server-tag.sh next' "$WORKFLOW"; then
  ok 'auto-release.yml computes the next version through server-tag.sh'
else
  bad 'auto-release.yml computes the next version through server-tag.sh'
fi

if [ "$fail" -eq 0 ]; then
  echo 'all server-tag tests passed'
else
  echo 'server-tag tests FAILED'
fi
exit "$fail"
