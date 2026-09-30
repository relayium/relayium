#!/bin/sh
# Release gate for the CLI's public command contract.
#
# With no argument it builds the candidate from server/. release.yml passes the
# exact binary built from the tag before any signing key is materialized. The
# other half of the gate reads the committed generated English/Chinese pages:
# those are what production will serve after an explicit product promotion.
#
# /cli itself is not a generated page: it is the SPA route, rendered from the
# cliPage copy in web/src/lib/i18n/{en,zh}.ts plus web/src/lib/cli-page-data.ts,
# and served to non-rendering crawlers from the `cli` export of
# web/scripts/pages/content/spa-pages.mjs. The third half of the gate reads
# exactly those sources (there is no web/public/cli.html to scan).
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
"$BIN" help pair >"$TMPROOT/pair"
"$BIN" help send >"$TMPROOT/send"
"$BIN" help inbox >"$TMPROOT/inbox"
"$BIN" help up >"$TMPROOT/up"
"$BIN" help update >"$TMPROOT/update"

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
    /^web\/public\/zh\/(guides|how-to|compare)\/[^\/]+\/index\.html$/ { print }
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

# ── /cli: the binary's own help, then the page sources that must agree with it ──
#
# The help half pins the facts the page claims, so a later CLI change that
# retracts one of them fails here instead of leaving the page stale.
must_have "$TMPROOT/pair" '--dest DIR'
must_have "$TMPROOT/pair" '--accept'
must_have "$TMPROOT/pair" 'app or the web page|Relayium app or the'
must_have "$TMPROOT/send" 'whenever the server issues a TURN relay'
must_have "$TMPROOT/send" "relay allowance"
must_have "$TMPROOT/inbox" 'relayium inbox send --to'
must_have "$TMPROOT/up" "plan's cap still applies"
must_have "$TMPROOT/update" 'downgrade guard'
must_have "$TMPROOT/top" 'relayium pair \[code\]'
must_have "$TMPROOT/top" 'whoami, up,'

# block FILE START_REGEX END_REGEX: the lines from START up to (not including)
# the next END, so an assertion reads the /cli copy and not the whole locale.
block() {
  awk -v s="$2" -v e="$3" '
    !on && $0 ~ s { on = 1; print; next }
    on && $0 ~ e { exit }
    on { print }
  ' "$1"
}
CLI_EN="$TMPROOT/cli-en"
CLI_ZH="$TMPROOT/cli-zh"
CLI_SEO="$TMPROOT/cli-seo"
CLI_DATA="$ROOT/web/src/lib/cli-page-data.ts"
block "$ROOT/web/src/lib/i18n/en.ts" '^  cliPage: [{]' '^  [A-Za-z]+: [{]' >"$CLI_EN"
block "$ROOT/web/src/lib/i18n/zh.ts" '^  cliPage: [{]' '^  [A-Za-z]+: [{]' >"$CLI_ZH"
block "$ROOT/web/scripts/pages/content/spa-pages.mjs" '^export const cli = [{]' '^export const ' >"$CLI_SEO"
for f in "$CLI_EN" "$CLI_ZH" "$CLI_SEO"; do
  [ -s "$f" ] || bad "could not extract the /cli copy into $f"
done

for f in "$CLI_EN" "$CLI_ZH" "$CLI_SEO" "$CLI_DATA"; do
  # SSH push/pull are retired (D-M10); the page must not offer them.
  must_lack "$f" 'relayium pull|SSH push/pull|push/pull over SSH|SSH-based push/pull|SSH identity|SSH port|relayium (push|sync)[^"`]*user@'
  # Every pairing-code peer can be an app or the web page (help.go sendUsage).
  must_lack "$f" 'both ends must be the CLI|other end must be the CLI|两端都必须是 CLI'
  # Pairing-code sessions relay whenever a TURN relay is issued.
  must_lack "$f" 'direct-only|never relays|Direct; only a rendezvous handshake|只走直连|直连；只有会合握手经过'
  # The CLI sends into a Device Inbox (inbox send).
  must_lack "$f" 'RECEIVE side only|no CLI command that sends into an inbox|只有接收侧|没有任何 CLI 命令能往收件箱里发送'
done
must_have "$CLI_DATA" 'key: "pair", id: "pair"'
must_have "$CLI_DATA" '"--dest <dir>", who: "pair"'
must_have "$CLI_DATA" '"--accept", who: "pair"'
must_have "$CLI_DATA" 'whoami · up · pair · send · text'
must_have "$CLI_SEO" 'title: "pair"'
for f in "$CLI_EN" "$CLI_ZH" "$CLI_SEO"; do
  must_have "$f" 'relayium pair'
  must_have "$f" 'relayium inbox send'
  must_have "$f" 'RELAYIUM_ALLOW_UNSIGNED=1'
done
must_have "$CLI_EN" 'traffic allowance of the account that minted the code'
must_have "$CLI_ZH" '生成配对码那个账号'
must_have "$CLI_SEO" 'traffic allowance of the account that minted the code'
# --ttl is any duration, clamped by the server; not a fixed menu.
must_lack "$CLI_EN" 'Choose 1h, 1d, 3d, 7d or 14d|choices above your plan'
must_have "$CLI_EN" 'at least a minute and at most your plan'
must_have "$CLI_ZH" '至少保留一分钟、最多保留到套餐的留存上限'
# sync --delete without --allow-delete is ignored and reported, not refused.
must_lack "$CLI_EN" 'the delete is refused'
must_have "$CLI_EN" 'the delete is ignored and reported'
must_have "$CLI_ZH" '否则删除会被忽略并回报给你'
# update --force also defeats the downgrade guard and the floor.
must_have "$CLI_EN" 'downgrade guard and the minimum-version floor'
must_have "$CLI_ZH" '降级保护和最低版本下限'

must_have "$ROOT/web/public/llms.txt" '1 hour, 1 day, 3 days, 7 days and 14 days'
must_have "$ROOT/web/public/llms.txt" 'subject to the plan'
must_have "$ROOT/web/public/llms.txt" 'usage accounting, not a separate charge'
must_have "$ROOT/README.md" 'five choices.*1 hour, 1 day, 3 days, 7 days and 14 days'
must_have "$ROOT/README.md" 'does not mean a per-transfer charge'

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "cli-public-truth: candidate help, the /cli page sources and generated English/Chinese public truth agree"
