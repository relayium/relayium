#!/bin/sh
# Release gate for the CLI's public command contract.
#
# With no argument it builds the candidate from server/. release.yml passes the
# exact binary built from the tag before any signing key is materialized. The
# other half of the gate reads the committed generated English/Chinese pages:
# those are what production will serve after an explicit product promotion.
set -eu

HERE=$(CDPATH='' cd -P -- "$(dirname -- "$0")" && pwd -P)
ROOT="$HERE/../.."
TMPROOT=$(mktemp -d "${TMPDIR:-/tmp}/relayium-cli-truth.XXXXXX")
trap 'rm -rf "$TMPROOT"' EXIT
trap 'rm -rf "$TMPROOT"; exit 1' INT HUP TERM

if [ "$#" -gt 1 ]; then
  echo "usage: $0 [candidate-relayium-binary]" >&2
  exit 2
fi

if [ "$#" -eq 1 ]; then
  BIN=$1
else
  BIN="$TMPROOT/relayium"
  (cd "$ROOT/server" && go build -o "$BIN" ./cmd/relayium)
fi

if [ ! -x "$BIN" ]; then
  echo "cli-public-truth: candidate binary is not executable: $BIN" >&2
  exit 1
fi

"$BIN" --help >"$TMPROOT/top"
"$BIN" help push >"$TMPROOT/push"
"$BIN" help sync >"$TMPROOT/sync"
"$BIN" help pull >"$TMPROOT/pull"

fail=0
bad() { echo "cli-public-truth: $1" >&2; fail=1; }
must_have() { grep -Eqi -- "$2" "$1" || bad "$1 is missing: $2"; }
must_lack() { grep -Eqi -- "$2" "$1" && bad "$1 still contains: $2"; return 0; }

must_have "$TMPROOT/push" 'relayium://host'
must_have "$TMPROOT/push" 'no SSH'
must_lack "$TMPROOT/push" 'user@|host:path|(^|[[:space:]])-i([[:space:]]|,)|(^|[[:space:]])-p([[:space:]]|,)'
must_have "$TMPROOT/sync" 'relayium://host'
must_have "$TMPROOT/sync" 'SSH destinations are disabled'
must_lack "$TMPROOT/sync" 'user@|host:path|(^|[[:space:]])-i([[:space:]]|,)|(^|[[:space:]])-p([[:space:]]|,)'
must_have "$TMPROOT/pull" 'unavailable'
must_have "$TMPROOT/pull" 'SSH transfers are currently disabled'
must_lack "$TMPROOT/top" 'relayium pull[[:space:]]+<'

PAGES="$TMPROOT/pages"
(
  cd "$ROOT"
  git ls-files web/public | awk '
    /^web\/public\/(guides|how-to|compare)\/[^\/]+\/index\.html$/ ||
    /^web\/public\/zh\/(guides|how-to|compare)\/[^\/]+\/index\.html$/ ||
    /^web\/public\/cli\.html$/ { print }
  ' | sort -u
) >"$PAGES"

if [ ! -s "$PAGES" ]; then
  bad "no generated English/Chinese public pages were found"
else
  while IFS= read -r page; do
    case $page in
      '') continue ;;
    esac
    if grep -Eqi -- '<code[^>]*>relayium pull|relayium (push|sync)[^<[:cntrl:]]*(user@|[[:alnum:].-]+:backups)|relayium (push|sync)[[:space:]]+(-i|-p)|push/pull over SSH|SSH push/pull|SSH-based push/pull' "$ROOT/$page"; then
      bad "$page publishes a retired SSH/pull command or capability"
    fi
  done <"$PAGES"
fi

must_have "$ROOT/web/public/llms.txt" '1 hour, 1 day, 3 days, 7 days and 14 days'
must_have "$ROOT/web/public/llms.txt" 'subject to the plan'
must_have "$ROOT/web/public/llms.txt" 'usage accounting, not a separate charge'
must_have "$ROOT/README.md" 'five choices.*1 hour, 1 day, 3 days, 7 days and 14 days'
must_have "$ROOT/README.md" 'does not mean a per-transfer charge'

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "cli-public-truth: candidate help and generated English/Chinese public truth agree"
