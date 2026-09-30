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

# ── The rest of the maintained public copy about the CLI ──
#
# The generated English/Chinese guides, how-tos and comparisons, the privacy
# and security pages, and the en/zh app strings outside cliPage must not
# repeat the claims the /cli page retracted. The patterns are the exact
# retired phrasings, not bare words: the corrected copy still says, truthfully,
# that an OLDER relayium's pairing is direct-only, and that daemon-direct
# push/sync never relays.
must_have "$TMPROOT/send" 'relay allowance'
must_have "$TMPROOT/pull" 'relayium pair\), or run relayium serve'
PUBLIC_CLI="$TMPROOT/public-cli"
{
  cat "$PAGES"
  for p in privacy security zh/privacy zh/security; do
    echo "web/public/$p/index.html"
  done
} >"$PUBLIC_CLI"
CLI_FALSE_EN='send ?/ ?receive (is|are) direct-only|CLI pairing (path )?is direct-only|CLI text is (a different, )?direct-only|modes are direct-only|Same direct-only rule as send|Direct only — free, or it fails|send ?/ ?receive never relays|CLI file and text transfers never use TURN|does not use or count against TURN|has no relay (fallback|path)|no relay fallback, by design|transfer modes — push, pull|CLI codes pair CLI to CLI|only ever pairs CLI to CLI|CLI-to-CLI only|a CLI code only pairs with another CLI|[Bb]oth ends must be the CLI|other end must be the CLI|direct CLI (transfers|paths)|CLI direct is unaffected|push ?/ ?pull (reuses|uses) your (own |existing )?SSH|reuses your SSH access|push over SSH tunnels|here or over SSH|RECEIVE side only|no CLI command that sends into an inbox|receive-only in the CLI|the CLI.s Inbox is the receiving side only|CLI paths connect directly; they never use a relay|while the CLI connects directly|daemon-direct CLI push/sync, and send / receive|between two online CLIs|Point -i at a passphrase-less key'
CLI_FALSE_ZH='send/receive (只走直连|是纯直连|绝不使用中继)|CLI 配对(码 send/receive )?只走直连|CLI 文本仅直连|CLI text 只支持直连|和 send 一样只走直连|只走直连——免费，否则失败|只能 CLI 对 CLI|CLI 的码只能和(另一个 )?CLI|两端都必须是 CLI|另一端必须是 CLI|命令行工具则始终直连|这些命令行路径始终直连|CLI 直连(不计入|不受影响)|同一网络传输与 CLI 不受影响|CLI 文件和文本传输都不使用 TURN|复用你现有的 SSH 权限|在 CLI 中只有接收侧|CLI 里它只有接收侧|CLI 上的收件箱只有接收这一侧|直连路径不按次收费：同一网络内的浏览器传输、CLI 的 daemon 直连 push/sync 与 send / receive|连接两台在线 CLI|用 -i 指向一把专供备份|CLI 的传输模式——push、pull'
while IFS= read -r page; do
  case $page in
    '') continue ;;
  esac
  [ -f "$ROOT/$page" ] || { bad "$page is listed but missing"; continue; }
  must_lack "$ROOT/$page" "$CLI_FALSE_EN"
  must_lack "$ROOT/$page" "$CLI_FALSE_ZH"
done <"$PUBLIC_CLI"
for f in "$ROOT/web/src/lib/i18n/en.ts" "$ROOT/web/src/lib/i18n/zh.ts"; do
  must_lack "$f" "$CLI_FALSE_EN"
  must_lack "$f" "$CLI_FALSE_ZH"
done
# …and the corrected facts are what those pages now say.
must_have "$ROOT/web/public/guides/send-a-file-to-someone/index.html" 'monthly traffic allowance of the account that minted the code'
must_have "$ROOT/web/public/zh/guides/send-a-file-to-someone/index.html" '生成配对码那个账号的每月流量额度'
must_have "$ROOT/web/public/guides/receive-files-from-the-command-line/index.html" 'can be relayium send or relayium pair, a Relayium app or the web page'
must_have "$ROOT/web/public/guides/transfer-files-from-terminal/index.html" 'relayium inbox send --to'
must_have "$ROOT/web/public/zh/guides/transfer-files-from-terminal/index.html" 'relayium inbox send --to'
must_have "$ROOT/web/public/security/index.html" 'CLI pairing-code sessions \(files, text and pair\) use TURN whenever the server issues a relay'
must_have "$ROOT/web/public/zh/security/index.html" 'CLI 配对码会话（文件、文本和 pair）只要服务器为该码签发了中继，就使用 TURN'
must_have "$ROOT/web/public/privacy/index.html" 'CLI pairing-code sessions \(files, text and pair\) use TURN'
must_have "$ROOT/web/src/lib/i18n/en.ts" "CLI.s server-to-server push/sync are unaffected"
must_have "$ROOT/web/src/lib/i18n/zh.ts" 'CLI 的服务器对服务器 push/sync 不受影响'

must_have "$ROOT/web/public/llms.txt" '1 hour, 1 day, 3 days, 7 days and 14 days'
must_have "$ROOT/web/public/llms.txt" 'subject to the plan'
must_have "$ROOT/web/public/llms.txt" 'usage accounting, not a separate charge'
must_have "$ROOT/README.md" 'five choices.*1 hour, 1 day, 3 days, 7 days and 14 days'
must_have "$ROOT/README.md" 'does not mean a per-transfer charge'

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "cli-public-truth: candidate help, the /cli page sources, the en/zh app strings and generated English/Chinese public truth agree"
