#!/usr/bin/env bash
#
# **Materialise a DISPOSABLE, verified copy of the Apple fixture package.**
#
#   ./prepare.sh <repo-root> <destination>
#
# This is the only supported way to build
# `scripts/fixtures/android-nearby-apple`. Building it in place fails, on
# purpose: the package declares a `RelayiumPeerKit` target whose sources are NOT
# in the repository, because they are a verbatim copy of an upstream target and
# a second checked-in copy of a module is a second thing to keep correct.
#
# What this does, in order:
#
#   1. copies the checked-in manifest and the fixture caller into <destination>;
#   2. copies `apps/RelayiumKit/Sources/RelayiumPeerKit/*.swift` verbatim, and
#      SHA-256 checks EVERY file against the repository's own copy. "Unchanged"
#      is checked rather than asserted: the copy exists only because
#      `RelayiumPeerKit` is a target and not a product, and a harness that had
#      quietly edited the module under test would be exactly the fake peer this
#      acceptance must not contain;
#   3. writes `module-hashes.txt` beside the package, so a run's evidence names
#      the exact bytes it compiled;
#   4. leaves the caller to run `swift build`, with
#      `RELAYIUM_KIT_PACKAGE_PATH` pointing at <repo-root>/apps/RelayiumKit —
#      the manifest's checkout-relative default does not resolve from a copy
#      that lives outside the repository.
#
# Nothing here writes into the repository. Nothing here edits an upstream file.
set -Eeuo pipefail

fail() { printf 'prepare: %s\n' "$*" >&2; exit 1; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ $# -eq 2 ] || fail "usage: $0 <repo-root> <destination>"
repo="$1"
dest="$2"

[ -d "$repo/apps/RelayiumKit" ] || fail "no RelayiumKit package under $repo"
upstream="$repo/apps/RelayiumKit/Sources/RelayiumPeerKit"
[ -d "$upstream" ] || fail "the shipped peer module is missing at $upstream"

# Refuses to build on top of an existing tree rather than merging into one: a
# leftover source file from an earlier layout would compile silently.
[ -e "$dest" ] && fail "$dest already exists; hand this a fresh directory"

mkdir -p "$dest/Sources/RelayiumPeerKit"
cp "$here/Package.swift" "$dest/Package.swift"
cp -R "$here/Sources/AppleNearbyBidirectionalPeer" "$dest/Sources/AppleNearbyBidirectionalPeer"

cp "$upstream"/*.swift "$dest/Sources/RelayiumPeerKit/"
for f in "$upstream"/*.swift; do
  mirrored="$dest/Sources/RelayiumPeerKit/$(basename "$f")"
  [ -f "$mirrored" ] || fail "the mirror is missing $(basename "$f")"
  [ "$(shasum -a 256 <"$f" | awk '{print $1}')" \
    = "$(shasum -a 256 <"$mirrored" | awk '{print $1}')" ] \
    || fail "the mirrored $(basename "$f") is not byte-identical to the shipped module"
done

# The fixture's OWN bytes are recorded beside the mirrored ones, so a report can
# name what the caller was as precisely as what the product was.
{
  shasum -a 256 "$dest/Sources/RelayiumPeerKit"/*.swift
  shasum -a 256 "$dest/Sources/AppleNearbyBidirectionalPeer"/*.swift
  shasum -a 256 "$dest/Package.swift"
} >"$dest/module-hashes.txt"

printf '%s\n' "$dest"
