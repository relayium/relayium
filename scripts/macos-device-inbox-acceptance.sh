#!/bin/bash
# **A Device Inbox delivery from one native macOS sender to another native macOS
# receiver**, against a real throwaway Relayium server.
#
# What this proves, and what it deliberately does not:
#
#   * PROVES that a macOS process using the app's OWN send half — the same
#     `InboxSendModel`, the same `InboxSendCoordinator`, the same `inbox/1`
#     client the `DeviceSendSection` surface drives — can address, seal, upload
#     and complete a delivery to a SECOND macOS process running the app's own
#     resident receiver.
#   * PROVES it end to end in the only three terms that distinguish a real
#     transfer from a plausible one: the file NAMES, the byte SIZES and the
#     per-file SHA-256 digests the sender computed before sending are the ones
#     found on the receiver's disk afterwards.
#   * PROVES the receiver's files are in the run's own folder, not in anybody's
#     Downloads.
#   * PROVES the ADVERSARIAL case: a third macOS process on the SAME account
#     that has not enrolled as a receiver is never offered as a target, and a
#     delivery addressed to a device that is not receiving is refused rather
#     than accepted and lost. See the reverse assertions at the end.
#   * Does NOT drive a built App's UI. The macOS built-App session paths are
#     `scripts/macos-ui-session-acceptance.sh`; this one is about the transport
#     and the two halves of the product model.
#
# Why it had to exist at all: the macOS Device Inbox shipped with only its
# receiving half wired to a surface, so every existing check could pass while
# "a Mac can send to another Mac" was false. Nothing but two real processes can
# fail in the way that mattered.
#
# The isolation rules — ephemeral ports, one per-run root, tokens in the
# environment, PID-exact cleanup, no release check, loopback only — live in
# `lib/local-acceptance.sh` and are shared verbatim with the other runs.
#
# ── usage ────────────────────────────────────────────────────────────────────
#
#   scripts/macos-device-inbox-acceptance.sh

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/apps/RelayiumKit"
server_dir="$repo_root/server"

# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/local-acceptance.sh
source "$repo_root/scripts/lib/local-acceptance.sh"

acceptance_begin
acceptance_build "$server_dir" "$package_dir"
acceptance_start_server

# ── three device rows on one account ─────────────────────────────────────────
#
# A delivery is sealed to ONE device's current public key, and a sender is
# removed from its own target list — so a run with one bearer would authenticate
# both halves as the same device row and correctly report that this account has
# nobody to send to. Separate `native/login` calls with different `deviceName`s
# are what produce separate rows, which is exactly what two Macs signed in to one
# account produce.
#
# The third row never enrols as a receiver, and is the adversarial case below.
receiver_name="acceptance-mac-receiver-$run_tag"
sender_name="acceptance-mac-sender-$run_tag"
bystander_name="acceptance-mac-bystander-$run_tag"

acceptance_extra_devices=("$receiver_name" "$sender_name" "$bystander_name")
acceptance_create_account
receiver_token="${account_device_tokens[0]}"
sender_token="${account_device_tokens[1]}"
[ -n "$receiver_token" ] && [ -n "$sender_token" ] \
  || fail "the device logins answered no bearer"
say "-- three device rows exist on the acceptance account"

mkdir -p "$run_root/inbox-receive" "$run_root/inbox-send"

# ── the receiving Mac ────────────────────────────────────────────────────────
#
# Started FIRST and left to enrol: a device that has not published a key yet is
# correctly reported as unable to receive, so the sender polls for it rather
# than assuming it is there.
peer_env=("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN=$receiver_token")
start_peer inbox-receiver inbox-receiver --receive-root "$run_root/inbox-receive"
receiver_port="$peer_port"
assert_control_api_is_guarded "$receiver_port"
control "$receiver_port" POST /start >/dev/null

# It has to reach the state the product would render as ready before anything is
# addressed to it. A sender that raced this would be proving the wait rather than
# the delivery.
deadline=$((SECONDS + 90))
while [ "$SECONDS" -lt "$deadline" ]; do
  observed="$(control "$receiver_port" GET /observed)" || observed=""
  if printf '%s' "$observed" | grep -q '"signedIn":true' \
     && printf '%s' "$observed" | grep -q '"folderChosen":true'; then
    break
  fi
  sleep 1
done
printf '%s' "$observed" | grep -q '"signedIn":true' \
  || fail "the receiving Mac never adopted the account: $observed"
say "-- $receiver_name is receiving into $run_root/inbox-receive"

maybe_fault after-inbox-receiver

# ── the adversarial case, BEFORE the real one ────────────────────────────────
#
# A device on the same account that has never enrolled as a receiver must not be
# offered as a target. Asserted first, because it is the case a sender that
# simply listed `/api/devices` would pass by accident — and once the real
# delivery has run, both devices are enrolled and the distinction is gone.
peer_env=("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN=$sender_token")
start_peer inbox-sender-adversarial inbox-sender \
  --receive-root "$run_root/inbox-send-adversarial" \
  --counterpart "$bystander_name"
adversarial_port="$peer_port"
control "$adversarial_port" POST /start >/dev/null

deadline=$((SECONDS + 180))
adversarial_status=""
while [ "$SECONDS" -lt "$deadline" ]; do
  adversarial_status="$(control "$adversarial_port" GET /status)" || adversarial_status=""
  case "$adversarial_status" in
    *'"phase":"failed"'*) break ;;
    *'"phase":"done"'*) break ;;
  esac
  sleep 2
done
case "$adversarial_status" in
  *'"phase":"failed"'*)
    say "-- refused, correctly: a device that is not receiving is not a target"
    ;;
  *'"phase":"done"'*)
    fail "a delivery completed to a device that never enrolled as a receiver"
    ;;
  *)
    fail "the adversarial sender never reached a terminal phase: $adversarial_status"
    ;;
esac
control "$adversarial_port" POST /shutdown >/dev/null || true

# ── the real delivery: Mac → Mac ─────────────────────────────────────────────
peer_env=("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN=$sender_token")
start_peer inbox-sender inbox-sender \
  --receive-root "$run_root/inbox-send" \
  --counterpart "$receiver_name"
sender_port="$peer_port"
control "$sender_port" POST /start >/dev/null

deadline=$((SECONDS + 300))
sender_status=""
while [ "$SECONDS" -lt "$deadline" ]; do
  sender_status="$(control "$sender_port" GET /status)" || sender_status=""
  case "$sender_status" in
    *'"phase":"done"'*) break ;;
    *'"phase":"failed"'*)
      say "-- the sender reported: $sender_status"
      fail "the Mac-to-Mac device delivery failed"
      ;;
  esac
  sleep 2
done
case "$sender_status" in
  *'"phase":"done"'*) : ;;
  *) fail "the Mac-to-Mac device delivery did not complete: $sender_status" ;;
esac
say "-- the sending Mac reports the other device saved the delivery"

# ── the comparison ───────────────────────────────────────────────────────────
#
# The sender's own digests of the bytes it read, against the receiver's digests
# of the files on its disk. Two independent walks of the same intent — not one
# value copied into two places.
sender_result="$(control "$sender_port" GET /result)" \
  || fail "the sending Mac stopped answering its control API"
receiver_observed="$(control "$receiver_port" GET /observed)" \
  || fail "the receiving Mac stopped answering its control API"

python3 - "$sender_result" "$receiver_observed" <<'PY' \
  || fail "what the receiving Mac wrote is not what the sending Mac sent"
import json, sys

sent = {(f["name"], f.get("path")): f for f in json.loads(sys.argv[1]).get("files", [])}
landed_list = json.loads(sys.argv[2]).get("files", [])
landed = {(f["name"], f.get("path")): f for f in landed_list}

problems = []
if not sent:
    problems.append("the sender stated no receipts at all")
for key, source in sorted(sent.items()):
    target = landed.get(key)
    if target is None:
        problems.append("missing on the receiving Mac: %s" % (key,))
        continue
    if target["size"] != source["size"]:
        problems.append("%s: %d bytes sent, %d written"
                        % (key, source["size"], target["size"]))
    if target["sha256"] != source["sha256"]:
        problems.append("%s: digest %s sent, %s written"
                        % (key, source["sha256"][:16], target["sha256"][:16]))
extra = sorted(set(landed) - set(sent))
if extra:
    problems.append("the receiving Mac wrote files nobody sent: %s" % (extra,))

if problems:
    for problem in problems:
        print("  - %s" % problem, file=sys.stderr)
    sys.exit(1)

print("-- %d file(s) matched by name, size and SHA-256:" % len(sent), file=sys.stderr)
for key, source in sorted(sent.items()):
    print("     %s  %8d  %s"
          % (source["sha256"][:16], source["size"], key[1] or key[0]), file=sys.stderr)
PY

# The bytes really are in files a person could open, in the run's own root and
# nowhere near anybody's Downloads folder.
[ -n "$(find "$run_root/inbox-receive" -type f -print -quit)" ] \
  || fail "the device delivery left no files in its own receive root"
say "-- the delivery landed inside $run_root/inbox-receive"

control "$sender_port" POST /shutdown >/dev/null || true
control "$receiver_port" POST /shutdown >/dev/null || true

assert_run_was_local

completed=1
say ""
say "PASS: a native macOS sender delivered to a native macOS receiver over"
say "      inbox/1 against $origin, with matching names, sizes and SHA-256"
say "      digests, and a non-receiving device on the same account was refused."
