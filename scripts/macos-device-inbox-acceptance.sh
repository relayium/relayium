#!/bin/bash
# **A whole Device Inbox conversation between two native macOS processes**,
# against a real throwaway Relayium server.
#
# What this proves, and what it deliberately does not:
#
#   * PROVES that two macOS processes, each running the app's OWN receiving half
#     AND its own sending half — the same `InboxController`, the same
#     `InboxSendModel`, the same `InboxSendCoordinator`, the same `inbox/1`
#     client, the same durable `InboxConversationStore`, and the same three
#     seams `RelayiumApp` uses to join the two halves — hold ONE bidirectional
#     conversation: A sends text and a mixed, nested file batch to B, and B
#     sends text and files back to A over the same production paths.
#   * PROVES the delivery end to end in the only three terms that distinguish a
#     real transfer from a plausible one: the file NAMES and PATHS, the byte
#     SIZES and the per-file SHA-256 digests the sender computed before sending
#     are the ones found on the receiver's disk afterwards.
#   * PROVES the text end to end in the only term that matters for a message:
#     the receiving Mac holds the EXACT string, read back through the product's
#     own `InboxController.message(for:)` accessor rather than off the wire.
#   * PROVES the sender's own durable history reaches `saved` — the one arrival
#     claim in this feature — for every direction and both content kinds.
#   * PROVES the receiver's files are in the run's own folder, not in anybody's
#     Downloads.
#   * PROVES the ADVERSARIAL case, twice and in two different ways: a third
#     macOS process on the SAME account that has not enrolled as a receiver is
#     never a sendable target, and `InboxSendModel` itself refuses a delivery
#     addressed to it rather than accepting it and losing it. The model refuses
#     it in TWO places and the run asserts both: `selectTarget` will not BIND a
#     blocked row, and the send guard then refuses a send with nothing aimed at.
#   * PROVES a genuine COMPETING send is still refused: two sends issued into
#     one staging slot, the second refused by the product's own
#     `alreadySending` guard, the first completing anyway, and the refused
#     message never reaching either Mac.
#   * PROVES local deletion is LOCAL: one row and then a whole conversation
#     erased on A, with A's Relayium-owned message bodies gone from disk, A's
#     received FILES untouched on disk, and B's history byte-identical
#     throughout.
#   * PROVES it survives reconstruction: each endpoint is torn down and rebuilt
#     as a NEW PROCESS over the SAME persistent root, after which deleted
#     history does not come back and retained history is unchanged.
#   * Does NOT drive a built App's UI. The macOS built-App session paths are
#     `scripts/macos-ui-session-acceptance.sh`; this one is about the transport,
#     the two halves of the product model, and the durable stores between them.
#
# Why it had to exist at all: the macOS Device Inbox shipped with only its
# receiving half wired to a surface, so every existing check could pass while "a
# Mac can send to another Mac" was false. 1.2.11 then made each conversation a
# single bidirectional, erasable surface — and a one-way fixed batch cannot fail
# in any of the ways THAT can. Nothing but two real endpoints, each holding its
# own durable store, can.
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

# ── reading what an endpoint says ────────────────────────────────────────────
#
# One checker with a mode rather than a dozen inline heredocs, because every
# assertion below has the same shape — take the endpoint's own `/observed`
# document, find the thing the product should have published, and if it is not
# there PRINT WHY before failing. A run that stops has to name which endpoint
# was missing what, or a timeout gets attributed to whichever side the script
# happened to poll first.
#
#   inbox_check <observed document> <mode> [mode args...]
#
# **The document is an argument here and an environment variable to python.** It
# reaches the checker through the environment so a several-kilobyte JSON blob
# stays out of the process table, and every mode's own arguments then stay
# positional and unambiguous even where they are optional. The assignment
# prefixes `python3` — an EXTERNAL command — rather than this function, because
# a prefix on a shell FUNCTION is one of the few pieces of scoping bash has
# changed between releases, and an acceptance helper must not depend on which
# release is installed.
#
# Nothing here can make a run pass. There is no mode that skips an assertion or
# invents a value: each one reads a field the peer published from a production
# model, or from bytes on its own disk, and the peer has no field this script
# could have asked it to fabricate.
inbox_check() {
  local doc="$1"
  shift
  RELAYIUM_INBOX_DOC="$doc" python3 - "$@" <<'PY'
import json, os, sys

mode = sys.argv[1]
rest = sys.argv[2:]

def die(*lines):
    for line in lines:
        if line:
            print("  - %s" % line, file=sys.stderr)
    sys.exit(1)

raw = os.environ.get("RELAYIUM_INBOX_DOC") or ""
if not raw:
    die("the endpoint answered nothing at all")
try:
    doc = json.loads(raw)
except ValueError:
    die("the endpoint did not answer JSON: %r" % raw[:200])

def conversation(peer):
    for entry in doc.get("conversations", []):
        if entry.get("peerDeviceID") == peer:
            return entry
    return None

def rows(peer):
    found = conversation(peer)
    return found.get("entries", []) if found else []

def summary():
    return json.dumps(doc.get("conversations", []), indent=1, sort_keys=True)[:4000]

if mode == "top":
    print(doc.get(rest[0], ""))

elif mode == "ready":
    missing = [key for key in ("signedIn", "folderChosen") if doc.get(key) is not True]
    if doc.get("policy") != "auto":
        missing.append("policy=auto")
    # Its OWN device row, asked of central. Without it nothing below can address
    # this endpoint or check who a delivery was attributed to.
    if not doc.get("selfDeviceID"):
        missing.append("selfDeviceID")
    if doc.get("storeIssue") is True:
        missing.append("a readable conversation store")
    if missing:
        die("the endpoint is not ready: missing %s" % ", ".join(missing),
            "settingsError: %s" % doc.get("settingsError"),
            "runtimeState: %s" % doc.get("runtimeState"))

elif mode == "candidate":
    name, want_sendable, want_text = rest[0], rest[1] == "true", rest[2] == "true"
    hit = [c for c in doc.get("candidates", []) if c.get("name") == name]
    if not hit:
        die("%s is not offered as a target at all" % name,
            "offered: %s" % [c.get("name") for c in doc.get("candidates", [])])
    found = hit[0]
    if found.get("sendable") is not want_sendable \
            or found.get("canReceiveText") is not want_text:
        die("%s is sendable=%s canReceiveText=%s; expected %s and %s"
            % (name, found.get("sendable"), found.get("canReceiveText"),
               want_sendable, want_text),
            "availability: %s" % found.get("availability"))

elif mode == "entry":
    peer, direction, kind = rest[0], rest[1], rest[2]
    want_text = rest[3] if len(rest) > 3 else ""
    want_state = rest[4] if len(rest) > 4 else ""
    hits = [e for e in rows(peer)
            if e.get("direction") == direction and e.get("kind") == kind
            and (not want_text or e.get("text") == want_text)
            and (not want_state or e.get("sentState") == want_state)]
    if len(hits) != 1:
        die("expected exactly one %s %s row%s%s in the conversation with %s, found %d"
            % (direction, kind,
               " holding %r" % want_text if want_text else "",
               " in state %s" % want_state if want_state else "",
               peer, len(hits)),
            summary())
    print(hits[0]["id"])

elif mode == "field":
    entry_id, name = rest[0], rest[1]
    hits = [e for c in doc.get("conversations", []) for e in c.get("entries", [])
            if e.get("id") == entry_id]
    if not hits:
        die("no row %s in any conversation" % entry_id, summary())
    value = hits[0].get(name)
    if value in (None, ""):
        die("row %s carries no %s" % (entry_id, name), json.dumps(hits[0], indent=1))
    print(value)

elif mode == "fingerprint":
    # A stable rendering of an entire conversation, for comparing one endpoint's
    # history against itself across another endpoint's deletion and across a
    # restart. Deliberately excludes read marks and names, which may legitimately
    # move, and includes the message BODIES, which may not.
    print("\n".join(sorted(
        "%s|%s|%s|%s|%s|%s" % (e.get("id"), e.get("direction"), e.get("kind"),
                               e.get("byteCount"), e.get("sentState") or "-",
                               e.get("text") or "-")
        for e in rows(rest[0]))))

elif mode == "ordered":
    stamps = [e.get("atMillis", 0) for e in rows(rest[0])]
    if len(stamps) < 2:
        die("the conversation with %s has %d row(s), so its order proves nothing"
            % (rest[0], len(stamps)))
    if any(a < b for a, b in zip(stamps, stamps[1:])):
        die("the timeline is not newest-first: %s" % stamps, summary())

elif mode == "bidirectional":
    found = [c for c in doc.get("conversations", []) if c.get("peerDeviceID") == rest[0]]
    if len(found) != 1:
        die("expected exactly ONE conversation with %s, found %d" % (rest[0], len(found)),
            summary())
    want = {("sent", "message"), ("sent", "files"),
            ("received", "message"), ("received", "files")}
    have = {(e.get("direction"), e.get("kind")) for e in found[0].get("entries", [])}
    if not want <= have:
        die("one bidirectional surface is missing %s" % sorted(want - have), summary())

elif mode == "count":
    # How many rows the conversation holds. Used before every fingerprint,
    # because a delivery's FILES appear on disk a moment before the row that
    # describes them is committed — and a fingerprint captured inside that window
    # would differ from the next one for a reason that is not a defect.
    peer, want = rest[0], int(rest[1])
    have = len(rows(peer))
    if have != want:
        die("the conversation with %s holds %d row(s), expected %d" % (peer, have, want),
            summary())

elif mode == "no-conversation":
    if conversation(rest[0]) is not None:
        die("a conversation with %s is still present" % rest[0], summary())

elif mode == "absent-text":
    hits = [e.get("id") for c in doc.get("conversations", [])
            for e in c.get("entries", []) if e.get("text") == rest[0]]
    if hits:
        die("a message this endpoint must never have holds rows %s" % hits, summary())

elif mode in ("landed", "landed-includes"):
    # The sender's own digests of the bytes it read, against the receiver's
    # digests of the files on its disk. Two independent walks of the same intent
    # — not one value copied into two places.
    #
    # `landed` also refuses an extra file; `landed-includes` does not, and is
    # used only where an earlier delivery has legitimately left files of its own
    # in the same root.
    sent = {(f["name"], f.get("path")): f
            for f in json.loads(rest[0]).get("receipts", [])}
    landed = {(f["name"], f.get("path")): f for f in doc.get("files", [])}
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
    if mode == "landed":
        extra = sorted(set(landed) - set(sent))
        if extra:
            problems.append("the receiving Mac wrote files nobody sent: %s" % (extra,))
    if problems:
        die(*problems)
    print("-- %d file(s) matched by name, path, size and SHA-256:" % len(sent),
          file=sys.stderr)
    for key, source in sorted(sent.items()):
        print("     %s  %8d  %s"
              % (source["sha256"][:16], source["size"], key[1] or key[0]), file=sys.stderr)

elif mode == "refused-send":
    # A `/drive` answer, for a send the PRODUCT must have refused.
    #
    # Every value read here is one `InboxSendModel` published about its own
    # state: whether it agreed to AIM at the device the endpoint named, the
    # block it states for that row, and the refusal its send guard produced.
    # The endpoint applies no sendability filter of its own and issues the send
    # either way, so an answer carrying a delivery instead would be a defect
    # this names rather than a step the launcher quietly skipped.
    want_block, want_refusal = rest[0], rest[1]
    problems = []
    if doc.get("ok") is True:
        problems.append("the send was not refused at all")
    if doc.get("selectionRefused") is not True:
        problems.append("the send model BOUND a device it must not aim at: %s"
                        % doc.get("target"))
    if doc.get("targetBlock") != want_block:
        problems.append("the model states block %r for that row, expected %r"
                        % (doc.get("targetBlock"), want_block))
    if doc.get("refusal") != want_refusal:
        problems.append("the send model refused with %r, expected %r"
                        % (doc.get("refusal"), want_refusal))
    if problems:
        problems.append(json.dumps(doc, indent=1, sort_keys=True)[:2000])
        die(*problems)
    print(doc.get("refusal"))

else:
    die("unknown check '%s'" % mode)
PY
}

# A JSON body built by python rather than by printf.
#
# The acceptance texts below are deliberately non-ASCII — the protocol measures a
# message in UTF-8 BYTES, and an all-ASCII fixture cannot tell a byte bound from
# a character bound — and hand-built JSON is exactly how a run ends up asserting
# on a string neither endpoint ever saw.
json_object() {
  python3 -c '
import json, sys
args = sys.argv[1:]
print(json.dumps(dict(zip(args[0::2], args[1::2]))))' "$@"
}

# The last `/observed` document a wait accepted.
#
# A GLOBAL rather than stdout, for the reason `start_peer` returns its port in
# one: `fail` inside a `$(…)` can only end the subshell, so a helper that both
# waits and prints would have an invisible failure path — which is the leak the
# library's own header was written about.
observed_doc=""

# Poll one endpoint until a check passes, or fail with that check's own reason.
#
#   await_check <label> <port> <seconds> <mode> [check args...]
await_check() {
  local label="$1" port="$2" limit="$3"
  shift 3
  local deadline=$((SECONDS + limit))
  observed_doc=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    observed_doc="$(control "$port" GET /observed)" || observed_doc=""
    if [ -n "$observed_doc" ] && inbox_check "$observed_doc" "$@" >/dev/null 2>&1; then
      # Once more, unsuppressed: for `landed` the check's own output IS the
      # digest evidence, and a run that only ever compared inside a silenced
      # poll has nothing to show for it.
      inbox_check "$observed_doc" "$@" >/dev/null
      return 0
    fi
    sleep 2
  done
  observed_doc="$(control "$port" GET /observed)" || observed_doc=""
  inbox_check "$observed_doc" "$@" >/dev/null \
    || fail "$label: '$*' never became true within ${limit}s"
  return 0
}

# Wait for one endpoint to see another device as a target, ASKING AGAIN each
# time.
#
# Asking again is the honest way to wait: a device that has not published a key
# yet is correctly reported as unable to receive, and the account's device list
# is only re-read when something asks for it.
await_target() {
  local label="$1" port="$2" name="$3" sendable="$4" text="$5" limit="$6"
  local deadline=$((SECONDS + limit))
  observed_doc=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    control "$port" POST /drive "$(json_object command refresh-targets)" >/dev/null || true
    sleep 2
    observed_doc="$(control "$port" GET /observed)" || observed_doc=""
    if [ -n "$observed_doc" ] \
       && inbox_check "$observed_doc" candidate "$name" "$sendable" "$text" \
            >/dev/null 2>&1; then
      return 0
    fi
  done
  inbox_check "$observed_doc" candidate "$name" "$sendable" "$text" >/dev/null \
    || fail "$label never saw $name as sendable=$sendable canReceiveText=$text"
  return 0
}

# Drive one production command on an endpoint and hand back what it answered.
#
# The answer and the status are GLOBALS for the same reason `observed_doc` is.
#
# **Deliberately not `control`.** That helper uses `curl -sf`, which discards the
# BODY of any non-2xx reply — and `/drive` answers 400 with the reason it could
# not run the command and 409 when the peer's main actor did not respond in
# time. Through `-sf` all three of those arrive as the same empty string, so a
# run that stopped could only report `FAIL: ...: ` with nothing after the colon
# and the actual reason was lost with the response. Reading the body whatever the
# status is what lets a failure below name what the endpoint said.
drive_answer=""
drive_status=""
drive() {
  local port="$1"
  shift
  local body_file="$run_root/drive-answer.json"
  : > "$body_file"
  # Longer than the peer's own 10s main-actor budget, so a peer-side timeout
  # arrives as its own 409 rather than as a curl abort that cannot say whose.
  drive_status="$(curl -s --max-time 20 -o "$body_file" -w '%{http_code}' \
    -X POST "http://127.0.0.1:$port/drive" \
    -H "Authorization: Bearer $control_token" \
    -H 'Content-Type: application/json' \
    --data-binary "$(json_object "$@")")" || drive_status="${drive_status:-000}"
  drive_answer="$(cat "$body_file")"
}

# Tear one endpoint down and build it back from the SAME persistent root.
#
# **A new process, not an in-process rebuild.** Every host, every store, every
# in-memory grant and the whole `InboxController` generation are genuinely
# reconstructed, which is the only version of this that can show a tombstone
# outliving the object that wrote it — and the only one that exercises the
# import-on-start path where a deleted receipt would otherwise come back.
#
# `start_peer` registers the replacement in the run's PID registry; the dead PID
# stays there and cleanup skips it, so ownership remains exact.
restart_endpoint() {
  local label="$1" port="$2" root="$3" token="$4"
  control "$port" POST /shutdown >/dev/null || true
  local waited=0
  while [ "$waited" -lt 100 ]; do
    curl -sf --max-time 2 -H "Authorization: Bearer $control_token" \
      "http://127.0.0.1:$port/status" >/dev/null 2>&1 || break
    sleep 0.2
    waited=$((waited + 1))
  done
  peer_env=("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN=$token")
  start_peer "$label" inbox-endpoint --state-root "$root"
  control "$peer_port" POST /start >/dev/null
}

acceptance_begin
acceptance_build "$server_dir" "$package_dir"
acceptance_start_server

# ── three device rows on one account ─────────────────────────────────────────
#
# A delivery is sealed to ONE device's current public key, and a sender is
# removed from its own target list — so a run with one bearer would authenticate
# both endpoints as the same device row and correctly report that this account
# has nobody to send to. Separate `native/login` calls with different
# `deviceName`s are what produce separate rows, which is exactly what two Macs
# signed in to one account produce.
#
# The third row never enrols as a receiver, and is the adversarial case below.
endpoint_a_name="acceptance-mac-a-$run_tag"
endpoint_b_name="acceptance-mac-b-$run_tag"
bystander_name="acceptance-mac-bystander-$run_tag"

acceptance_extra_devices=("$endpoint_a_name" "$endpoint_b_name" "$bystander_name")
acceptance_create_account
a_token="${account_device_tokens[0]}"
b_token="${account_device_tokens[1]}"
[ -n "$a_token" ] && [ -n "$b_token" ] \
  || fail "the device logins answered no bearer"
say "-- three device rows exist on the acceptance account"

# ── two whole macOS endpoints ────────────────────────────────────────────────
#
# Each owns ONE persistent root holding its received files, the files it sends,
# its pending-upload staging area and every account-scoped store — journals,
# received bodies, sent bodies and the conversation index. That root is what the
# restart at the end reopens, so nothing below may write outside it.
a_root="$run_root/endpoint-a"
b_root="$run_root/endpoint-b"

peer_env=("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN=$a_token")
start_peer endpoint-a inbox-endpoint --state-root "$a_root"
a_port="$peer_port"
assert_control_api_is_guarded "$a_port"
control "$a_port" POST /start >/dev/null

peer_env=("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN=$b_token")
start_peer endpoint-b inbox-endpoint --state-root "$b_root"
b_port="$peer_port"
assert_control_api_is_guarded "$b_port"
control "$b_port" POST /start >/dev/null

# Both have to reach the state the product would render as ready before anything
# is addressed to either. A sender that raced this would be proving the wait
# rather than the delivery.
await_check endpoint-a "$a_port" 120 ready
a_device="$(inbox_check "$observed_doc" top selfDeviceID)"
a_account="$(inbox_check "$observed_doc" top accountID)"
a_accounts_root="$(inbox_check "$observed_doc" top accountsRoot)"

await_check endpoint-b "$b_port" 120 ready
b_device="$(inbox_check "$observed_doc" top selfDeviceID)"

[ -n "$a_device" ] && [ -n "$b_device" ] && [ "$a_device" != "$b_device" ] \
  || fail "the two endpoints did not authenticate as two distinct device rows"
[ -n "$a_account" ] && [ -n "$a_accounts_root" ] \
  || fail "endpoint A published no account-scoped store location"

a_messages="$a_accounts_root/$a_account/messages"
a_sent_messages="$a_accounts_root/$a_account/sent-messages"
say "-- two macOS endpoints are receiving: A=$a_device B=$b_device"

maybe_fault after-inbox-receiver

# ── the adversarial case, BEFORE the real one ────────────────────────────────
#
# A device on the same account that has never enrolled as a receiver must not be
# a sendable target. Asserted first, because it is the case a sender that simply
# listed `/api/devices` would pass by accident — and once the real conversation
# has run, both endpoints are enrolled and the distinction is gone.
#
# Proven twice, from two different heights. First the `inbox-sender` role, whose
# whole job is to wait for a target to become sendable and which therefore fails
# when one never does — the check this suite has always made.
peer_env=("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN=$a_token")
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

# Then the same refusal at the height 1.2.11 added: the composer OFFERS the row
# — a device whose owner turned receiving off is a device the user is looking
# for, and dropping it turns a two-second fix into "Relayium cannot see my Mac"
# — while marking it unable to receive, and `InboxSendModel` itself refuses the
# send. The endpoint aims WITHOUT a sendability filter of its own and issues the
# send whatever the model did with that aim, so both refusals below are the
# product's guards and not the harness's.
#
# **Two guards, because the model has two and the first one wins.**
# `InboxSendModel.selectTarget` refuses to BIND a blocked row at all — a
# selection whose Send button could only ever refuse is a dead end the user
# would have to discover by pressing it — so the composer never holds an aim at
# this device. The batch is staged and sent anyway, and the send guard then
# refuses it with nothing aimed at. That is why the refusal asserted here is
# `noTargetChosen` and not `targetUnavailable`: with `selectTarget` refusing the
# bind, and `adopt(_ rows:)` clearing a selection the moment its device stops
# being sendable, `rows` and `candidates` are only ever assigned together — so
# `InboxSendRefusal.targetUnavailable` is defensive code the model's own public
# API cannot reach, and asserting on it would be asserting on a string this
# product never produces. What a real user meets when a target goes away
# mid-send is the coordinator's `InboxSendFailure.targetUnavailable`, thrown
# against a FRESH device read, which is a different value on a different path.
await_target endpoint-a "$a_port" "$bystander_name" false false 120
say "-- endpoint A offers the never-enrolled device and marks it unable to receive"

drive "$a_port" command send-files name "$bystander_name" batch competing
[ "$drive_status" = "200" ] \
  || fail "endpoint A answered HTTP $drive_status to the adversarial send: $drive_answer"
bystander_refusal="$(inbox_check "$drive_answer" refused-send notEnrolled noTargetChosen)" \
  || fail "a send addressed to a non-receiving device was not refused by the product"
say "-- refused, correctly: the send model would not aim at a device that cannot" \
    "receive, and refused the send with $bystander_refusal"

# ── A → B: the message ───────────────────────────────────────────────────────
#
# Non-ASCII on purpose. `sendText` measures a message in UTF-8 BYTES against the
# manifest's own bounds, and an all-ASCII fixture cannot tell a byte bound from a
# character bound.
a_text="A to B $run_tag · 中文 · ✓"
b_text="B to A $run_tag · 返信 · 🚀"
competing_text="competing $run_tag · this message must never be delivered"

await_target endpoint-a "$a_port" "$endpoint_b_name" true true 180
say "-- endpoint A can address endpoint B, which announces that it presents text"

drive "$a_port" command send-text name "$endpoint_b_name" text "$a_text"
case "$drive_answer" in
  *'"ok":true'*) : ;;
  *) fail "endpoint A would not send the message: $drive_answer" ;;
esac

# The SENDER's own durable row reaching `saved` is the only arrival claim this
# feature has: `notified` and `downloading` are states a receiver has been told
# about, not ones it has committed.
await_check endpoint-a "$a_port" 240 entry "$b_device" sent message "$a_text" saved
say "-- endpoint A's own history shows its message, saved on the other Mac"

# And the receiving Mac holds the exact string, read back through the production
# accessor rather than off the wire.
await_check endpoint-b "$b_port" 240 entry "$a_device" received message "$a_text"
say "-- endpoint B holds A's message byte for byte, attributed to A's device row"

# ── A → B: the mixed, nested batch ───────────────────────────────────────────
#
# A loose file beside a two-level folder with a zero-byte leaf in the MIDDLE of
# the stream and one file larger than a single frame — the shared
# `AcceptanceBatch`, unchanged, because that is the shape that forces a receiver
# to build a container, rebuild nested paths inside it and get an empty file
# right.
drive "$a_port" command send-files name "$endpoint_b_name" batch primary
case "$drive_answer" in
  *'"ok":true'*) : ;;
  *) fail "endpoint A would not send the file batch: $drive_answer" ;;
esac
a_primary="$drive_answer"

await_check endpoint-a "$a_port" 300 entry "$b_device" sent files "" saved
say "-- endpoint A's own history shows the batch it sent, saved on the other Mac"

await_check endpoint-b "$b_port" 300 landed "$a_primary"

# The bytes really are in files a person could open, in the run's own root and
# nowhere near anybody's Downloads folder.
[ -n "$(find "$b_root/receive" -type f -print -quit)" ] \
  || fail "the device delivery left no files in endpoint B's own receive root"
say "-- the delivery landed inside $b_root/receive"

# ── B → A: the same product paths, the other way ─────────────────────────────
await_target endpoint-b "$b_port" "$endpoint_a_name" true true 180

drive "$b_port" command send-text name "$endpoint_a_name" text "$b_text"
case "$drive_answer" in
  *'"ok":true'*) : ;;
  *) fail "endpoint B would not send the reply: $drive_answer" ;;
esac
await_check endpoint-b "$b_port" 240 entry "$a_device" sent message "$b_text" saved
await_check endpoint-a "$a_port" 240 entry "$b_device" received message "$b_text"
say "-- endpoint B's reply reached endpoint A, byte for byte, over the same paths"

drive "$b_port" command send-files name "$endpoint_a_name" batch reverse
case "$drive_answer" in
  *'"ok":true'*) : ;;
  *) fail "endpoint B would not send its file batch: $drive_answer" ;;
esac
b_reverse="$drive_answer"

await_check endpoint-b "$b_port" 300 entry "$a_device" sent files "" saved
await_check endpoint-a "$a_port" 300 landed "$b_reverse"
[ -n "$(find "$a_root/receive" -type f -print -quit)" ] \
  || fail "the reverse delivery left no files in endpoint A's own receive root"
say "-- the reverse delivery landed inside $a_root/receive"

# ── one bidirectional surface, in a stable order ─────────────────────────────
#
# Both halves of both directions in ONE conversation per peer, newest first, as
# `InboxConversationStore.conversations()` orders it. The ordering is asserted
# from the timestamps the store published rather than taken on trust.
await_check endpoint-a "$a_port" 60 bidirectional "$b_device"
await_check endpoint-a "$a_port" 60 ordered "$b_device"
await_check endpoint-b "$b_port" 60 bidirectional "$a_device"
await_check endpoint-b "$b_port" 60 ordered "$a_device"
say "-- each Mac holds ONE conversation with the other, sent and received, in order"

# ── a genuine competing send is still refused ────────────────────────────────
#
# Two sends issued into one staging slot in a single turn. `InboxSendModel` takes
# that slot synchronously before the first call returns, so the second call meets
# a staging task that is really in flight. Nothing simulates the contention and
# nothing reaches past the guard — which is why the FIRST send is required to
# complete: a guard broken by locking everything out would fail this half.
drive "$a_port" command send-competing name "$endpoint_b_name" text "$competing_text"
case "$drive_answer" in
  *'"ok":true'*) : ;;
  *) fail "endpoint A would not run the competing send: $drive_answer" ;;
esac
case "$drive_answer" in
  *'"first"'*) fail "the FIRST of two competing sends was refused: $drive_answer" ;;
esac
case "$drive_answer" in
  *'"second":"alreadySending"'*)
    say "-- refused, correctly: a second send issued into a live staging slot"
    ;;
  *)
    fail "a competing send was not refused by the product's own guard: $drive_answer"
    ;;
esac

await_check endpoint-b "$b_port" 300 landed-includes "$drive_answer"
say "-- the send that won the race completed, with matching digests on the other Mac"

# Nothing about the refused message exists anywhere: not on the Mac that was
# told no, and not on the Mac it was addressed to.
await_check endpoint-b "$b_port" 60 absent-text "$competing_text"
observed_doc="$(control "$a_port" GET /observed)" \
  || fail "endpoint A stopped answering its control API"
inbox_check "$observed_doc" absent-text "$competing_text" \
  || fail "endpoint A recorded a refused message as if it had been sent"
say "-- the refused message reached neither endpoint's history"

# ── both timelines have settled, and hold exactly what was sent ──────────────
#
# Five rows each: A sent a message and two batches and received a message and a
# batch; B is its mirror. Asserted before anything is deleted for two reasons —
# it is the shape claim itself, and a delivery's FILES land on disk a moment
# before the row describing them is committed, so a history fingerprint taken
# inside that window would move for a reason that is not a defect.
await_check endpoint-a "$a_port" 180 count "$b_device" 5
await_check endpoint-b "$b_port" 180 count "$a_device" 5
say "-- both Macs hold five rows: two of their own sends, three deliveries in"

# ── deletion is LOCAL: one row ───────────────────────────────────────────────
#
# What A must lose, what must leave A's disk, and what B must keep — all three
# read before anything is deleted, so the comparison afterwards is against an
# observation rather than an expectation.
observed_doc="$(control "$a_port" GET /observed)" || fail "endpoint A stopped answering"
a_received_text_id="$(inbox_check "$observed_doc" \
  entry "$b_device" received message "$b_text")" \
  || fail "endpoint A does not hold the message it is about to delete"
a_received_body="$(inbox_check "$observed_doc" \
  field "$a_received_text_id" messageID)" \
  || fail "endpoint A's received message row names no protected body"
[ -f "$a_messages/$a_received_body.json" ] \
  || fail "the received body was not on disk before deletion: $a_messages/$a_received_body.json"

observed_doc="$(control "$b_port" GET /observed)" || fail "endpoint B stopped answering"
b_before="$(inbox_check "$observed_doc" fingerprint "$a_device")"
[ -n "$b_before" ] || fail "endpoint B has no conversation with A to retain"

drive "$a_port" command delete-entry peer "$b_device" id "$a_received_text_id"
case "$drive_answer" in
  *'"tombstoned":true'*) : ;;
  *) fail "endpoint A did not record a tombstone for $a_received_text_id: $drive_answer" ;;
esac

# `deleteTimelineEntry` refreshes the published list before it returns, so this
# is a read rather than a wait — and it is asserted on the BODY, because a row
# that lost its text while keeping its place would still be a deletion that had
# not happened.
observed_doc="$(control "$a_port" GET /observed)" || fail "endpoint A stopped answering"
inbox_check "$observed_doc" absent-text "$b_text" \
  || fail "the row endpoint A deleted is still in its conversation"
[ ! -f "$a_messages/$a_received_body.json" ] \
  || fail "endpoint A deleted a row and left its protected body on disk"
say "-- one row deleted on A, and its Relayium-owned body is gone from A's disk"

# Deletion is never a recall. B is untouched.
drive "$b_port" command refresh
observed_doc="$(control "$b_port" GET /observed)" || fail "endpoint B stopped answering"
b_after_row="$(inbox_check "$observed_doc" fingerprint "$a_device")"
[ "$b_before" = "$b_after_row" ] \
  || fail "endpoint A's local deletion changed endpoint B's history"
say "-- endpoint B's own history is unchanged: the deletion was local, not a recall"

# ── deletion is LOCAL: the whole conversation ────────────────────────────────
observed_doc="$(control "$a_port" GET /observed)" || fail "endpoint A stopped answering"
a_sent_text_id="$(inbox_check "$observed_doc" \
  entry "$b_device" sent message "$a_text" saved)" \
  || fail "endpoint A no longer holds the message it sent"
a_sent_body="$(inbox_check "$observed_doc" \
  field "$a_sent_text_id" sentMessageID)" \
  || fail "endpoint A's sent message row names no protected body"
[ -f "$a_sent_messages/$a_sent_body.json" ] \
  || fail "the sent body was not on disk before deletion"

# The files a person already received are NOT history. Recorded exactly, so that
# "deletion touched no user file" is a comparison rather than a claim.
a_files_before="$(cd "$a_root/receive" && find . -type f | sort)"
[ -n "$a_files_before" ] || fail "endpoint A received no files to protect"

drive "$a_port" command delete-conversation peer "$b_device"
case "$drive_answer" in
  *'"ok":true'*) : ;;
  *) fail "endpoint A would not delete the conversation: $drive_answer" ;;
esac

drive "$a_port" command refresh
observed_doc="$(control "$a_port" GET /observed)" || fail "endpoint A stopped answering"
inbox_check "$observed_doc" no-conversation "$b_device" \
  || fail "endpoint A still holds a conversation it deleted"
[ ! -f "$a_sent_messages/$a_sent_body.json" ] \
  || fail "endpoint A deleted a conversation and left an outgoing body on disk"
a_files_after="$(cd "$a_root/receive" && find . -type f | sort)"
[ "$a_files_before" = "$a_files_after" ] \
  || fail "deleting local history removed a file the other Mac had already delivered"
say "-- the whole conversation is gone from A, its bodies are gone from A's disk,"
say "   and every file A had already received is still exactly where it was"

drive "$b_port" command refresh
observed_doc="$(control "$b_port" GET /observed)" || fail "endpoint B stopped answering"
b_after_all="$(inbox_check "$observed_doc" fingerprint "$a_device")"
[ "$b_before" = "$b_after_all" ] \
  || fail "endpoint A erasing its whole conversation changed endpoint B's history"
say "-- endpoint B still holds the entire conversation, unchanged"

# ── tear both endpoints down and build them back ─────────────────────────────
#
# New processes over the SAME persistent roots. Adopting an account re-runs the
# startup import with `importLegacy: true` — the flat message replay and the
# journal receipt replay, the two sources a deleted row is most likely to come
# back through — and both have to be refused by the tombstones this run wrote.
#
# Whether a durable plan also survives for the sent-history recovery path to find
# depends on where the coordinator released it, so this does not assert that one
# ran. What it asserts either way is the outcome: after the rebuild, nothing
# deleted is back, in the index or on disk.
restart_endpoint endpoint-a-restarted "$a_port" "$a_root" "$a_token"
a_port="$peer_port"
await_check endpoint-a-restarted "$a_port" 180 ready
drive "$a_port" command refresh
observed_doc="$(control "$a_port" GET /observed)" || fail "the restarted endpoint A stopped answering"
inbox_check "$observed_doc" no-conversation "$b_device" \
  || fail "history endpoint A deleted came back after it was rebuilt"
[ ! -f "$a_messages/$a_received_body.json" ] \
  || fail "a deleted received body came back after endpoint A was rebuilt"
[ ! -f "$a_sent_messages/$a_sent_body.json" ] \
  || fail "a deleted outgoing body was written back by the recovery path"
a_files_restart="$(cd "$a_root/receive" && find . -type f | sort)"
[ "$a_files_before" = "$a_files_restart" ] \
  || fail "rebuilding endpoint A changed the files already on its disk"
say "-- endpoint A rebuilt from its own root: nothing deleted came back, no file moved"

restart_endpoint endpoint-b-restarted "$b_port" "$b_root" "$b_token"
b_port="$peer_port"
await_check endpoint-b-restarted "$b_port" 180 ready
drive "$b_port" command refresh
observed_doc="$(control "$b_port" GET /observed)" || fail "the restarted endpoint B stopped answering"
b_restarted="$(inbox_check "$observed_doc" fingerprint "$a_device")"
[ "$b_before" = "$b_restarted" ] \
  || fail "endpoint B's retained history did not survive being rebuilt"
inbox_check "$observed_doc" bidirectional "$a_device" \
  || fail "endpoint B's rebuilt conversation is no longer bidirectional"
say "-- endpoint B rebuilt from its own root: the whole conversation is still there"

control "$a_port" POST /shutdown >/dev/null || true
control "$b_port" POST /shutdown >/dev/null || true

assert_run_was_local

completed=1
say ""
say "PASS: two native macOS endpoints held one bidirectional Device Inbox"
say "      conversation over inbox/1 against $origin — text and mixed nested"
say "      files in both directions, matching names, paths, sizes and SHA-256"
say "      digests, sender-side saved state, a non-receiving device refused"
say "      twice, a genuine competing send refused while the first completed,"
say "      local-only deletion of one row and of a whole conversation, and no"
say "      resurrection after both endpoints were torn down and rebuilt."
