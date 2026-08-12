#!/bin/sh
# server-tag.sh — which server version is released next, and from what.
#
# WHAT THIS GUARDS AGAINST
# ------------------------
# This repo carries more than one tag family. Server releases are tagged
# `v<major>.<minor>.<patch>`; the macOS app under apps/ is tagged `macos-v1.1.3`
# and friends by macos.yml, and nothing stops a future component from adding a
# third family. `git describe --tags --abbrev=0` does not know or care about any
# of that: it returns the most recent tag of ANY family reachable from HEAD.
#
# auto-release.yml used exactly that call, and on 2026-08-12 the macOS app was
# the more recently tagged component. So the server release picked up
# `macos-v1.1.3`, stripped a leading `v` that was not there, did integer
# arithmetic on the string `macos-v1` and created the tag `vmacos-v1.2.0`
# (run 31621252056). The release it dispatched for that tag then died inside
# GoReleaser (run 31621273486) before publishing anything — which is the only
# reason this was a bad tag rather than a bad release.
#
# Note what the blast radius would have been had the version arithmetic landed
# on a *plausible* string instead of an obviously broken one: every anchor in
# the release decision — "has server/ changed", the commit range in the notes,
# the commit count, the base for the next version — was derived from that same
# wrong tag. Selecting the wrong tag does not just misname a release, it
# computes the wrong release.
#
# So both halves are done here, and both are validated against the one shape a
# server tag may have:
#
#     latest [REV]        newest canonical server tag reachable from REV
#                         (default HEAD). Prints nothing and exits 0 when
#                         there is none — "I found no server tag" is a normal
#                         answer that the caller must handle, not an error.
#
#     next BASE [REV]     the version after BASE, from the conventional-commit
#                         subjects in BASE..REV (default HEAD). BASE must
#                         already be canonical; anything else is a hard error,
#                         because the incident above was arithmetic performed
#                         on a string that was never a server version.
#
#     validate-ref REF    prints the tag name and exits 0 when REF is
#                         `refs/tags/<canonical>`; fails otherwise. This is the
#                         other end of the same rule: fixing auto-release stops
#                         this repo from CREATING a bad tag, but release.yml
#                         builds and signs whatever tag reaches it, and a tag
#                         can also arrive by hand or from a mistyped
#                         workflow_dispatch. Answering both questions with one
#                         matcher is the point — a shape auto-release refuses to
#                         produce must not be a shape release.yml agrees to sign.
#
# CANONICAL means exactly ^v[0-9]+\.[0-9]+\.[0-9]+$ — no `macos-` or `vmacos-`
# prefix, no suffix, no two- or four-component versions. Tags of other families
# are not errors, they are simply not server releases: they are skipped.
#
# POSIX sh, no dependencies beyond git. Used by .github/workflows/auto-release.yml
# and covered by scripts/test/server-tag-test.sh (run in repo-hygiene.yml).
set -eu

usage() {
  echo "usage: $0 latest [REV]" >&2
  echo "       $0 next BASE_TAG [REV]" >&2
  echo "       $0 validate-ref REF" >&2
  exit 2
}

# is_canonical TAG — true when TAG is exactly ^v[0-9]+\.[0-9]+\.[0-9]+$.
#
# Done with shell pattern matching rather than a grep, so it forks nothing and
# cannot be affected by the caller's locale or grep flavour. `case` globs alone
# cannot express "one or more digits", hence the split-and-check.
is_canonical() {
  case $1 in
    v*) ;;
    *) return 1 ;;
  esac
  _v=${1#v}
  # Exactly three components: at least two dots ...
  case $_v in
    *.*.*) ;;
    *) return 1 ;;
  esac
  _maj=${_v%%.*}
  _rest=${_v#*.}
  _min=${_rest%%.*}
  _pat=${_rest#*.}
  # ... and no more than two.
  case $_pat in
    *.*) return 1 ;;
  esac
  for _c in "$_maj" "$_min" "$_pat"; do
    case $_c in
      '' | *[!0-9]*) return 1 ;;
    esac
  done
  return 0
}

# parse_version TAG — sets VER_MAJOR/VER_MINOR/VER_PATCH. Assumes is_canonical.
parse_version() {
  _v=${1#v}
  VER_MAJOR=${_v%%.*}
  _rest=${_v#*.}
  VER_MINOR=${_rest%%.*}
  VER_PATCH=${_rest#*.}
}

cmd_latest() {
  rev=${1:-HEAD}
  tmp=$(mktemp "${TMPDIR:-/tmp}/server-tag.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  # --merged: a tag on a branch that never landed is not a released version of
  # what is being built here. This is the reachability part of `git describe`,
  # and the only part of it worth keeping.
  git tag --list --merged "$rev" >"$tmp"

  # Highest canonical version wins, not the topologically nearest tag that
  # `git describe` would return. On a linear main those are the same tag; they
  # differ after a hotfix branch merges in behind a newer release, and there
  # the nearest-ancestor answer is a version already published — which would
  # recompute an existing number and abort the run.
  #
  # The comparison is arithmetic, per component, on purpose: sorting these as
  # text puts v0.9.0 above v0.10.0, and `sort -V` is not portable enough to
  # rely on for something that decides what gets published.
  best=''
  best_maj=-1
  best_min=-1
  best_pat=-1
  while IFS= read -r tag; do
    is_canonical "$tag" || continue
    parse_version "$tag"
    if [ "$VER_MAJOR" -gt "$best_maj" ] ||
      { [ "$VER_MAJOR" -eq "$best_maj" ] &&
        { [ "$VER_MINOR" -gt "$best_min" ] ||
          { [ "$VER_MINOR" -eq "$best_min" ] && [ "$VER_PATCH" -gt "$best_pat" ]; }; }; }; then
      best=$tag
      best_maj=$VER_MAJOR
      best_min=$VER_MINOR
      best_pat=$VER_PATCH
    fi
  done <"$tmp"

  # Silence is the answer when this repo has macOS tags but no server tag: the
  # caller must refuse to invent a first version, not fall back to a neighbour.
  [ -n "$best" ] || return 0
  printf '%s\n' "$best"
}

cmd_next() {
  base=${1:-}
  rev=${2:-HEAD}
  if ! is_canonical "$base"; then
    echo "server-tag.sh: refusing to compute a version from '$base': not a canonical server tag (want v<major>.<minor>.<patch>)" >&2
    return 1
  fi
  parse_version "$base"
  major=$VER_MAJOR
  minor=$VER_MINOR
  patch=$VER_PATCH

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/server-tag.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  # Written to files rather than piped into `grep -q`: grep stops reading at
  # the first match, git takes SIGPIPE for the rest, and the pipeline reports
  # 141. The caller runs with `pipefail`, so a *found* breaking change would
  # read as "no breaking change" precisely on the histories that have one.
  git log --format='%s' "$base..$rev" >"$tmp/subjects"
  git log --format='%B' "$base..$rev" >"$tmp/bodies"

  # Pre-1.0 semantics: a breaking change bumps the minor, because there is no
  # major to spend. feat does too; everything else is a patch.
  if grep -qE '^[a-z]+(\([^)]*\))?!:|^feat(\([^)]*\))?:' "$tmp/subjects" ||
    grep -q 'BREAKING CHANGE' "$tmp/bodies"; then
    minor=$((minor + 1))
    patch=0
  else
    patch=$((patch + 1))
  fi

  next="v${major}.${minor}.${patch}"
  # Unreachable given a canonical base and integer arithmetic — which is also
  # what would have been said about `vmacos-v1.2.0`. Assert it anyway; this is
  # the last point before something creates a tag.
  if ! is_canonical "$next"; then
    echo "server-tag.sh: computed version '$next' is not a canonical server tag" >&2
    return 1
  fi
  printf '%s\n' "$next"
}

# cmd_validate_ref REF — the release gate. REF is a full git ref, normally
# GITHUB_REF, which is `refs/tags/<name>` for both a tag push and a
# workflow_dispatch aimed at a tag, and `refs/heads/<name>` for one aimed at a
# branch. Requiring the `refs/tags/` prefix is therefore not decoration: it is
# what separates "re-run the build for v0.18.1", which must keep working, from
# "build main and sign it as a release", which must not.
#
# Only the ref is inspected. Whether the tag exists, points at what it did an
# hour ago, or is reachable from main are different questions, and none of them
# can be answered from a string; this is the shape check, and the shape check is
# what the incident needed.
cmd_validate_ref() {
  ref=${1:-}
  case $ref in
    # `?*` and not `*`: `refs/tags/` alone must not pass as a tag ref.
    refs/tags/?*) ;;
    *)
      echo "server-tag.sh: refusing to release from '$ref': not a tag ref (want refs/tags/v<major>.<minor>.<patch>)" >&2
      return 1
      ;;
  esac
  # A tag name may contain slashes, so `refs/tags/foo/v1.2.3` strips to
  # `foo/v1.2.3` — not canonical, and rejected below like any other shape.
  tag=${ref#refs/tags/}
  if ! is_canonical "$tag"; then
    echo "server-tag.sh: refusing to release from tag '$tag': not a canonical server tag (want v<major>.<minor>.<patch>)" >&2
    return 1
  fi
  printf '%s\n' "$tag"
}

[ $# -ge 1 ] || usage
mode=$1
shift
case $mode in
  latest) cmd_latest "$@" ;;
  next) cmd_next "$@" ;;
  validate-ref) cmd_validate_ref "$@" ;;
  *) usage ;;
esac
