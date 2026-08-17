#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
artifact_root=${1:?usage: build-macos-engineering-candidate.sh /absolute/artifact/root}

case "$artifact_root" in
  /*) ;;
  *) printf '%s\n' "artifact root must be absolute" >&2; exit 2 ;;
esac
case "$artifact_root" in
  /|/Users|/Users/*/code|"$repo"|"$repo"/*) printf '%s\n' "refusing unsafe artifact root" >&2; exit 2 ;;
esac

sha=$(git -C "$repo" rev-parse --short=8 HEAD)
case "$(basename -- "$artifact_root")" in
  *-"$sha") ;;
  *) printf '%s\n' "artifact folder must end with current commit $sha" >&2; exit 2 ;;
esac

mkdir -p "$artifact_root"
marker="$artifact_root/.relayium-engineering-artifact-root"
if [ -e "$marker" ]; then
  test "$(cat "$marker")" = "relayium-engineering-artifacts-v1" || {
    printf '%s\n' "artifact marker is invalid" >&2; exit 2;
  }
else
  printf '%s\n' "relayium-engineering-artifacts-v1" > "$marker"
fi

# Never delete a caller path. Every invocation receives a fresh generated
# directory beneath the marker-guarded artifact root.
derived=$(mktemp -d "$artifact_root/DerivedData.engineering.XXXXXX")
xcodebuild \
  -project "$repo/apps/mac/Relayium.xcodeproj" \
  -scheme Relayium \
  -configuration Release \
  -xcconfig "$repo/apps/mac/Engineering/Engineering.xcconfig" \
  -derivedDataPath "$derived" \
  build

app="$derived/Build/Products/Release/Relayium.app"
test -d "$app"
test "$(defaults read "$app/Contents/Info" CFBundleIdentifier)" = "com.relayium.mac.engineering"
codesign --verify --deep --strict "$app"
printf '%s\n' "$app"
