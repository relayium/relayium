#!/usr/bin/env bash
# scripts/publish-android-release.sh — publish one immutable Android APK release.
#
# Reusable for every future Android release, and deliberately NOT a CI workflow:
# signing happens outside this repository, so there is no signing secret here to
# upload and no automated job that could publish without a person holding the
# artifact.
#
# ## The one thing that must never go wrong
#
# GitHub's `latest` alias is REPOSITORY-WIDE. `web/public/install.sh` downloads
# the CLI from `releases/latest/download`, so a release that claims the alias
# turns `curl -fsSL https://relayium.com/install.sh | sh` into a 404 for every
# user, on a URL nothing in this repository can revise. It has already happened
# twice from macOS releases (see .github/workflows/macos-release.yml).
#
# `--latest=false` is the control. It is not the proof. The alias is read BEFORE
# and AFTER, both reads must SUCCEED, and they must return the same tag. A read
# that fails is not evidence of anything and is a hard error — the old version of
# this script treated a failed `gh api` as "no alias exists" and reported
# success, which is precisely the shape that hides the defect it was written to
# catch.
#
# ## Provenance
#
# The metadata must already be COMMITTED and must already describe THESE bytes.
# The script re-derives the hash, compares it against the committed manifest,
# checks that the on-disk manifest is byte-identical to the committed blob, and
# pins the release to an explicit full commit SHA. Without the `--target`, `gh`
# tags whatever the remote's default branch happens to be at that moment, which
# is not necessarily the tree the artifact came from.
#
# ## Order
#
# It publishes the release; it does NOT advance the website. Advancing the
# deployed site must not happen until the published asset has been downloaded
# and verified — a deployed feed advertising bytes that 404 is worse than no
# feed, because installed clients act on it.

set -euo pipefail

# Hardcoded, not a flag. The Android client only ever accepts a download URL
# under this exact repository (`UpdateFeed.isOfficialDownloadUrl`), so
# publishing anywhere else produces an asset no installed build will open — and
# a `--repo` flag is a way to publish official-looking bytes somewhere nobody is
# watching.
readonly REPO="relayium/relayium"

usage() {
  cat <<'USAGE'
Usage: publish-android-release.sh --apk <path> [--manifest <path>] [--target <sha>] [--dry-run]

Reads the COMMITTED web/android-release.json for the version, code and expected
SHA-256, verifies the APK matches it exactly, then creates the immutable
android-v<version> pre-release pinned to an explicit commit, with
--latest=false, and proves the repository-wide latest alias did not move.

  --apk       the signed APK to publish
  --manifest  default web/android-release.json beside this script; wherever it
              points, it must be tracked, committed and byte-identical to its
              committed blob
  --target    full 40-hex commit to tag; must equal the manifest repository HEAD
  --dry-run   run every check, create nothing
USAGE
}

APK=""
MANIFEST=""
TARGET=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --apk) APK="${2:?--apk needs a value}"; shift 2 ;;
    --manifest) MANIFEST="${2:?--manifest needs a value}"; shift 2 ;;
    --target) TARGET="${2:?--target needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unexpected argument $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$APK" ] || { echo "error: --apk is required" >&2; usage >&2; exit 2; }
[ -f "$APK" ] || { echo "error: $APK is not a file" >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
manifest="${MANIFEST:-$here/../web/android-release.json}"
[ -f "$manifest" ] || { echo "error: $manifest is missing" >&2; exit 2; }
# `pwd -P`, not `pwd`. Git reports a PHYSICAL path from `--show-toplevel`, so a
# logical path through a symlink (every macOS $TMPDIR is one: /var → /private/var)
# would not share a prefix with it, and the canonical-path check below would
# reject a perfectly correct manifest.
manifest="$(cd "$(dirname "$manifest")" && pwd -P)/$(basename "$manifest")"

# ── provenance ──────────────────────────────────────────────────────────────
#
# A manifest that is not committed describes a state no one can return to, and
# `--manifest` must never be a way around that: whatever it points at is held to
# the same rule as the canonical file.

repo_root="$(cd "$(dirname "$manifest")" && git rev-parse --show-toplevel 2>/dev/null | xargs -I{} sh -c 'cd "{}" && pwd -P' || true)"
if [ -z "$repo_root" ]; then
  echo "error: $manifest is not inside a Git work tree; release inputs must be committed" >&2
  exit 1
fi
rel="${manifest#"$repo_root"/}"

# CANONICAL, not merely tracked. `--manifest` exists so the accepting path can be
# exercised against a disposable repository, and a tracked copy at some other
# path would let it become a provenance bypass: the published document must be
# the one the website imports and `gen-pages` publishes, at its one real path.
readonly CANONICAL_REL="web/android-release.json"
if [ "$rel" != "$CANONICAL_REL" ]; then
  echo "error: $rel is not $CANONICAL_REL" >&2
  echo "       The published manifest must be the canonical document, in its own repository." >&2
  exit 1
fi

if ! git -C "$repo_root" ls-files --error-unmatch -- "$rel" >/dev/null 2>&1; then
  echo "error: $rel is not tracked in $repo_root; release inputs must be committed" >&2
  exit 1
fi

if [ -n "$(git -C "$repo_root" status --porcelain)" ]; then
  echo "error: $repo_root has uncommitted changes; publish only from a clean, committed tree" >&2
  git -C "$repo_root" status --short >&2
  exit 1
fi

# The bytes being read must be the bytes that were committed, not a copy that
# merely sits at a tracked path.
if ! git -C "$repo_root" show "HEAD:$rel" | cmp -s - "$manifest"; then
  echo "error: $rel on disk differs from its committed blob at HEAD" >&2
  exit 1
fi

HEAD_SHA="$(git -C "$repo_root" rev-parse HEAD)"
if [ -n "$TARGET" ]; then
  case "$TARGET" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*)
      [ "${#TARGET}" -eq 40 ] || { echo "error: --target must be a full 40-hex commit SHA" >&2; exit 2; } ;;
    *) echo "error: --target must be a full 40-hex commit SHA" >&2; exit 2 ;;
  esac
  if [ "$TARGET" != "$HEAD_SHA" ]; then
    echo "error: --target $TARGET is not the manifest repository HEAD $HEAD_SHA" >&2
    echo "       The tag must point at the commit that carries these release inputs." >&2
    exit 1
  fi
fi
TARGET="$HEAD_SHA"

# ── the committed contract ──────────────────────────────────────────────────

read_field() {
  # node rather than jq: node is already required to build this repository, jq
  # is not, and a missing tool at publish time is the worst moment to discover
  # a dependency.
  node -e '
    const fs = require("node:fs");
    const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = process.argv[2].split(".").reduce((o, k) => (o ?? {})[k], doc);
    if (value === undefined || value === null) { process.exit(3); }
    process.stdout.write(String(value));
  ' "$manifest" "$1"
}

if ! AVAILABLE="$(read_field android.available)" || [ "$AVAILABLE" != "true" ]; then
  echo "error: $rel does not advertise a release (available=${AVAILABLE:-missing})." >&2
  echo "       Run web/scripts/stage-android-release.mjs against this APK and commit it first." >&2
  exit 1
fi

VERSION="$(read_field android.versionName)"
CODE="$(read_field android.versionCode)"
WANT_SHA="$(read_field android.sha256)"
WANT_SIZE="$(read_field android.size)"
WANT_URL="$(read_field android.downloadUrl)"

TAG="android-v${VERSION}"
ASSET="Relayium-${VERSION}-${CODE}.apk"

GOT_SHA="$(shasum -a 256 "$APK" | awk '{print $1}')"
GOT_SIZE="$(wc -c < "$APK" | tr -d ' ')"

if [ "$GOT_SHA" != "$WANT_SHA" ]; then
  echo "error: APK sha256 $GOT_SHA does not match the committed metadata $WANT_SHA" >&2
  exit 1
fi
if [ "$GOT_SIZE" != "$WANT_SIZE" ]; then
  echo "error: APK size $GOT_SIZE does not match the committed metadata $WANT_SIZE" >&2
  exit 1
fi
if [ "$(basename "$APK")" != "$ASSET" ]; then
  echo "error: APK is named $(basename "$APK") but must be published as $ASSET" >&2
  exit 1
fi
EXPECT_URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
if [ "$WANT_URL" != "$EXPECT_URL" ]; then
  echo "error: metadata downloadUrl is $WANT_URL, expected $EXPECT_URL" >&2
  exit 1
fi

# ── the artifact itself ─────────────────────────────────────────────────────
#
# Hash equality proves the file is the one the manifest describes. It proves
# nothing about what that file IS. The publisher therefore re-observes the APK
# with the SDK — signature, certificate, package, versionCode, versionName — and
# compares every field against the committed document. Staging verified an
# artifact at one moment; this is the moment that becomes permanent.
if ! node "$here/../web/scripts/check-android-publish.mjs" --manifest "$manifest" --apk "$APK"; then
  echo "error: the APK does not match the committed manifest; refusing to publish" >&2
  exit 1
fi

echo "publish-android-release: $TAG / $ASSET"
echo "  sha256 $GOT_SHA"
echo "  size   $GOT_SIZE"
echo "  repo   $REPO"
echo "  target $TARGET"

# ── the alias, before ───────────────────────────────────────────────────────
#
# Three outcomes, and they must stay three. A successful read naming a tag, a
# successful read finding no alias (HTTP 404, a legitimate repository state),
# and a FAILED read — rate limit, auth, network — which proves nothing and must
# never be reported as either of the first two.

read_latest_tag() {
  local out err status
  err="$(mktemp)"
  if out="$(gh api "repos/${REPO}/releases/latest" --jq .tag_name 2>"$err")"; then
    rm -f "$err"
    printf '%s' "$out"
    return 0
  fi
  status=1
  if grep -qiE 'HTTP 404|Not Found' "$err"; then status=44; fi
  cat "$err" >&2
  rm -f "$err"
  return "$status"
}

# Status captured explicitly rather than read from `$?` after the branch: `$?`
# in an `elif` is easy to invalidate with one inserted command, and this
# distinction — read failed vs. no alias — is the whole point.
set +e
LATEST_BEFORE="$(read_latest_tag)"
LATEST_RC=$?
set -e
if [ "$LATEST_RC" -eq 0 ]; then
  echo "  latest alias before: $LATEST_BEFORE"
elif [ "$LATEST_RC" -eq 44 ]; then
  echo "error: no release currently holds the 'latest' alias." >&2
  echo "       The CLI installer resolves releases/latest, so this repository is expected to have one." >&2
  echo "       Refusing to publish until that is explained." >&2
  exit 1
else
  echo "error: could not READ the latest alias; refusing to publish blind." >&2
  exit 1
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "dry run: would create $TAG as a PRE-RELEASE at $TARGET with --latest=false, then re-read the alias"
  exit 0
fi

# ── publish ─────────────────────────────────────────────────────────────────

# Does the tag already exist? "Not found" and "the request failed" are different
# answers, and only the first one means it is safe to create.
tag_state() {
  local err
  err="$(mktemp)"
  if gh api "repos/${REPO}/releases/tags/${TAG}" >/dev/null 2>"$err"; then
    rm -f "$err"; return 0          # exists
  fi
  if grep -qiE 'HTTP 404|Not Found' "$err"; then rm -f "$err"; return 44; fi
  cat "$err" >&2; rm -f "$err"; return 1
}

CHECKSUM_FILE="$(mktemp -d)/${ASSET}.sha256"
printf '%s  %s\n' "$GOT_SHA" "$ASSET" > "$CHECKSUM_FILE"

set +e
tag_state
TAG_STATE=$?
set -e

if [ "$TAG_STATE" -eq 0 ]; then
  # Immutable: an existing tag is never replaced, and there is no --clobber
  # anywhere in this script. Either it already holds these exact bytes at this
  # exact commit — a safe rerun — or a person has to look.
  echo "release $TAG already exists; verifying it is this release"
  existing_commit="$(gh api "repos/${REPO}/git/ref/tags/${TAG}" --jq '.object.sha')"
  if [ "$existing_commit" != "$TARGET" ]; then
    # An annotated tag points at a tag object; dereference before judging.
    existing_commit="$(gh api "repos/${REPO}/git/tags/${existing_commit}" --jq '.object.sha' 2>/dev/null || echo "$existing_commit")"
  fi
  [ "$existing_commit" = "$TARGET" ] || {
    echo "error: $TAG already targets $existing_commit, not $TARGET" >&2; exit 1; }

  draft="$(gh api "repos/${REPO}/releases/tags/${TAG}" --jq '.draft')"
  [ "$draft" = "false" ] || { echo "error: $TAG exists but is a draft" >&2; exit 1; }

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  gh release download "$TAG" --repo "$REPO" --pattern "$ASSET" --dir "$tmp"
  existing_sha="$(shasum -a 256 "$tmp/$ASSET" | awk '{print $1}')"
  if [ "$existing_sha" != "$GOT_SHA" ]; then
    echo "error: $TAG already exists and holds DIFFERENT bytes ($existing_sha)." >&2
    echo "       A published release is immutable; publish a new version instead." >&2
    exit 1
  fi
  echo "existing $TAG is byte-identical at the same commit; nothing to create"
elif [ "$TAG_STATE" -eq 44 ]; then
  # `--latest=false` keeps the CLI installer's alias where it is; `--prerelease`
  # labels the preview honestly; `--target` pins the tag to the commit that
  # carries the committed metadata rather than to whatever the default branch is.
  gh release create "$TAG" \
    "$APK#$ASSET" \
    "$CHECKSUM_FILE#${ASSET}.sha256" \
    --repo "$REPO" \
    --target "$TARGET" \
    --latest=false \
    --prerelease \
    --title "Relayium for Android ${VERSION} (preview)" \
    --notes "Public preview, distributed as a direct APK. No Google Play listing, no Play Services and no Play Billing.

Open the APK on the device to install it; Android asks you to confirm. An update
can only replace an installed Relayium if it carries the same signing
certificate — Relayium itself never downloads or installs anything.

SHA-256: ${GOT_SHA}

---

公开预览版，以 APK 直接分发。没有 Google Play 上架，不依赖 Play 服务与 Play 结算。

在设备上打开该 APK 即可安装，由 Android 请你确认。只有签名证书与已安装版本一致
时，更新才能覆盖安装——Relayium 自身不会下载或安装任何内容。"
else
  echo "error: could not determine whether $TAG already exists; refusing to publish blind." >&2
  exit 1
fi

# ── the alias, after ────────────────────────────────────────────────────────
#
# The proof. Runs on BOTH branches, because a release that already existed never
# passed through the flag at all.

set +e
LATEST_AFTER="$(read_latest_tag)"
AFTER_RC=$?
set -e
if [ "$AFTER_RC" -eq 0 ]; then
  if [ "$LATEST_AFTER" = "$TAG" ]; then
    echo "error: $TAG took the repository-wide 'latest' alias." >&2
    echo "       https://relayium.com/install.sh resolves releases/latest and is now broken." >&2
    echo "       Clear the alias on GitHub before doing anything else." >&2
    exit 1
  fi
  if [ "$LATEST_AFTER" != "$LATEST_BEFORE" ]; then
    echo "error: the latest alias moved from $LATEST_BEFORE to $LATEST_AFTER during this publish." >&2
    exit 1
  fi
  echo "latest alias still $LATEST_AFTER (unchanged)"
else
  echo "error: could not READ BACK the latest alias after publishing." >&2
  echo "       The release exists; verify manually that $LATEST_BEFORE still holds the alias." >&2
  exit 1
fi

echo
echo "Published. The website is NOT updated by this script."
echo "Next, in this order:"
echo "  1. download ${EXPECT_URL} and confirm its sha256 is ${GOT_SHA}"
echo "  2. only then advance the deployed site, so the feed never advertises bytes that 404"
