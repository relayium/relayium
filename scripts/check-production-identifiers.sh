#!/usr/bin/env bash
#
# check-production-identifiers.sh — repo-hygiene guard.
#
# WHAT THIS GUARDS AGAINST
# -------------------------
# Relayium is a public repo for an end-to-end-encrypted file transfer product;
# an earlier incident found that development docs (docs/superpowers/) had
# accumulated real production operational detail — server paths, a production
# IP, coturn secrets context, node hostnames — that belongs in the private
# relayium-ops repo instead. That material was cleaned up and moved (see the
# "Plan B" repo-hygiene commits), but nothing stopped it from silently coming
# back in a future commit. This script is that stop.
#
# It scans every git-tracked, non-binary file for three classes of production
# identifier and fails if any is found:
#
#   1. IP literals that look like a real, routable, non-example address.
#   2. Production filesystem paths (/opt/relayium, /opt/relayium-ops,
#      /etc/letsencrypt/live/relayium) — these also catch the production
#      crontab line, which always invokes a script under /opt/relayium.
#   3. Internal per-node hostnames (node<N>.relayium.com, n<N>.relayium.com) —
#      NOT the legitimate public service endpoints (up/turn/relay.relayium.com).
#
# DO NOT DELETE THIS AS "NOISE": it has a near-zero false-positive rate by
# design (see the allowlists below, each with a reason) — if it fires, either
# a real identifier leaked, or a genuinely new fixture needs a narrow,
# commented addition to an allowlist. Do not widen the regexes/allowlists to
# make a real finding go away without understanding why it fired.
#
# USAGE: scripts/check-production-identifiers.sh   (run from anywhere in the repo)

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# This script's own source necessarily quotes the very literals and patterns
# it's checking for (the denylist, the allowlists, the regexes themselves as
# text) — exclude it from its own scan so it doesn't perpetually fail on
# itself. Nothing else is exempted this way.
SELF="scripts/check-production-identifiers.sh"
EXCLUDE_SELF=":(exclude)$SELF"

fail=0
say() { printf '%s\n' "$*"; }
violation() { say "  $1"; fail=1; }

say "== check-production-identifiers =="

# ---------------------------------------------------------------------------
# Class 1: IP literals
# ---------------------------------------------------------------------------
# 1a. Hard denylist: specific real production IPs that must never reappear
#     anywhere in the tree, under any circumstance. Exact-string match.
KNOWN_BAD_IPS=(
  92.119.124.16 64.188.27.178 96.44.136.22 43.157.184.137
  38.49.38.47 192.3.116.43 117.72.88.55
)

say "-- known production IPs --"
bad_ip_pattern=$(IFS='|'; echo "${KNOWN_BAD_IPS[*]}")
if hits=$(git grep -nE "$bad_ip_pattern" -- . "$EXCLUDE_SELF" 2>/dev/null); then
  say "FAIL: known real production IP found in the tree:"
  while IFS= read -r line; do violation "$line"; done <<<"$hits"
else
  say "  ok (none found)"
fi

# 1b. General heuristic: any IPv4 literal that is NOT one of —
#       - RFC1918 private (10/8, 172.16/12, 192.168/16)
#       - loopback (127/8)
#       - link-local (169.254/16, incl. the cloud-metadata address)
#       - carrier-grade NAT (100.64/10)
#       - unspecified (0.0.0.0)
#       - RFC5737 documentation ranges (192.0.2/24, 198.51.100/24, 203.0.113/24)
#       - the explicit ALLOWED_IPS below
#     is flagged as an unexpected public IP — the kind of thing a real
#     production address looks like.
#
# ALLOWED_IPS: specific, already-pervasive test/placeholder addresses in this
# codebase, individually verified to carry no production meaning (well-known
# public DNS resolvers; "obviously fake" sequential/repeated-digit addresses
# used throughout server/web tests and docs/superpowers design docs;
# example.com's real IP). This is a short, explicit list — not a wildcard —
# so a genuinely new public IP still gets caught.
ALLOWED_IPS=(
  8.8.8.8 1.1.1.1 9.9.9.9            # public DNS resolvers (SSRF-guard fixtures)
  1.2.3.4 2.2.2.2 3.3.3.3 5.5.5.5 7.7.7.7 5.6.7.8   # obviously-fake placeholders
  93.184.216.34                       # example.com
)

say "-- unexpected public IP literals --"
ip_regex='[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}'
ip_hits="$(git grep -noE "$ip_regex" -- . "$EXCLUDE_SELF" 2>/dev/null || true)"

if [ -n "$ip_hits" ]; then
  flagged="$(printf '%s\n' "$ip_hits" | awk -F: -v allow="${ALLOWED_IPS[*]}" '
    BEGIN {
      n = split(allow, a, " ");
      for (i = 1; i <= n; i++) allowed[a[i]] = 1;
    }
    {
      # path:line:ip  (ip itself has no colons, so field 3.. is safe to rejoin)
      ip = $3;
      for (i = 4; i <= NF; i++) ip = ip ":" $i;

      split(ip, o, ".");
      valid = 1;
      for (i = 1; i <= 4; i++) if (o[i] > 255) valid = 0;
      if (!valid) next;

      if (o[1] == 10) next;                                   # RFC1918
      if (o[1] == 172 && o[2] >= 16 && o[2] <= 31) next;       # RFC1918
      if (o[1] == 192 && o[2] == 168) next;                    # RFC1918
      if (o[1] == 127) next;                                   # loopback
      if (o[1] == 169 && o[2] == 254) next;                    # link-local
      if (o[1] == 100 && o[2] >= 64 && o[2] <= 127) next;      # CGNAT
      if (ip == "0.0.0.0") next;                                # unspecified
      if (o[1] == 192 && o[2] == 0   && o[3] == 2)   next;     # RFC5737
      if (o[1] == 198 && o[2] == 51  && o[3] == 100) next;     # RFC5737
      if (o[1] == 203 && o[2] == 0   && o[3] == 113) next;     # RFC5737
      if (ip in allowed) next;

      print $0;
    }
  ')"
  if [ -n "$flagged" ]; then
    say "FAIL: unexpected public IP literal(s) — verify these are not real production addresses:"
    while IFS= read -r line; do violation "$line"; done <<<"$flagged"
  else
    say "  ok (all IP literals are private/loopback/documentation-range/allowlisted)"
  fi
else
  say "  ok (no IP literals found)"
fi

# ---------------------------------------------------------------------------
# Class 2: production filesystem paths
# ---------------------------------------------------------------------------
# Matches the exact production paths, not lookalikes like /opt/relayium-node
# (a legitimate third-party relay-node install path) — the character class
# after "relayium"/"relayium-ops" requires the path to end or continue with a
# separator, not another identifier character.
say "-- production filesystem paths --"
path_pattern='/opt/relayium(-ops)?([^A-Za-z0-9_-]|$)|/etc/letsencrypt/live/relayium([^A-Za-z0-9_-]|$)'
if hits=$(git grep -nE "$path_pattern" -- . "$EXCLUDE_SELF" 2>/dev/null); then
  say "FAIL: production filesystem path found (also catches the production crontab line, which always invokes a script under /opt/relayium):"
  while IFS= read -r line; do violation "$line"; done <<<"$hits"
else
  say "  ok (none found)"
fi

# ---------------------------------------------------------------------------
# Class 3: internal per-node hostnames
# ---------------------------------------------------------------------------
# node<N>.relayium.com / n<N>.relayium.com would identify a specific relay
# node's real hostname. up.relayium.com, turn.relayium.com, and
# relay.relayium.com are legitimate public service endpoints and don't match
# this pattern (no digit after the prefix), so they're never flagged.
#
# HOSTNAME_ALLOWLIST: three example hostnames (node3, node7, n5) already used
# pervasively as illustrative/test fixtures throughout server/ and
# docs/superpowers (e.g. paired with RFC5737 test IPs in cfdns_test.go) —
# clearly conventional placeholders, not real node identifiers. Any other
# node<N>/n<N> value is still flagged.
say "-- internal node hostnames --"
HOSTNAME_ALLOWLIST=(node3.relayium.com node7.relayium.com n5.relayium.com)
# NOTE: deliberately no \b — it's a GNU/PCRE extension that macOS's system
# regex (which `git grep -E` uses on Apple's git build) does not support and
# silently fails to match at all, which would make this check a no-op there.
# Boundaries are spelled out explicitly with POSIX-portable character classes.
host_line_pattern='(^|[^A-Za-z0-9_])(node[0-9]+|n[0-9]+)\.relayium\.com([^A-Za-z0-9_]|$)'
host_lines="$(git grep -nE "$host_line_pattern" -- . "$EXCLUDE_SELF" 2>/dev/null || true)"

if [ -n "$host_lines" ]; then
  flagged=""
  while IFS= read -r line; do
    tokens="$(printf '%s\n' "$line" | grep -oE '(node[0-9]+|n[0-9]+)\.relayium\.com' || true)"
    bad=0
    while IFS= read -r tok; do
      [ -z "$tok" ] && continue
      case " ${HOSTNAME_ALLOWLIST[*]} " in
        *" $tok "*) ;;
        *) bad=1 ;;
      esac
    done <<<"$tokens"
    [ "$bad" = 1 ] && flagged="${flagged}${line}"$'\n'
  done <<<"$host_lines"

  if [ -n "$flagged" ]; then
    say "FAIL: internal node hostname found (not on the known-fixture allowlist):"
    while IFS= read -r line; do [ -n "$line" ] && violation "$line"; done <<<"$flagged"
  else
    say "  ok (only known example hostnames found)"
  fi
else
  say "  ok (none found)"
fi

echo
if [ "$fail" -ne 0 ]; then
  say "check-production-identifiers: FAILED"
  exit 1
fi
say "check-production-identifiers: PASSED"
