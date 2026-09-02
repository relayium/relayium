# shellcheck shell=bash
#
# Resolving a physical iOS device, starting a child that cannot prompt, waiting
# on one published fact, and reading one file back out of an app container.
#
# It is sourced, never executed: it defines functions and sets nothing that a
# caller has not asked for. `say` and `fail` come from `local-acceptance.sh`,
# which every caller sources first.
#
# ── what a caller gets ───────────────────────────────────────────────────────
#
#   * `noninteractive`                        — a child with no controlling
#     terminal and EOF on stdin, so nothing it starts can prompt for a password;
#   * `ios_device_facts` / `ios_read_device`  — ONE selector to ONE device, in
#     either identifier form Apple's own two tools print, refusing rather than
#     guessing;
#   * `ios_require_distinct_devices`          — the refusal that only exists
#     BECAUSE both forms are accepted;
#   * `ios_peer_name_mode`                    — whether the two devices announce
#     themselves under names that can tell them apart at all;
#   * `ios_published` / `ios_await_event`     — the start barrier: wait for one
#     published fact while its publisher is still alive, bounded, and matched on
#     marker AND tag AND role AND event;
#   * `ios_container_file` / `ios_sha256`     — the received bytes, pulled off
#     the receiving device and hashed, which is the one receiver claim a UI
#     cannot make;
#   * `ios_container_listing`                 — the same container enumerated,
#     read-only, for the failure that needs to say WHAT is there instead;
#   * `ios_ui_runner_bundle_id` / `ios_container_put` — the release: the one
#     thing this harness writes to a device, into the UI-TEST RUNNER's own
#     container, to let a holding receiving role finish;
#   * `ios_forbidden_command_hits`            — every command this harness may
#     never run, scanned out of a named file in COMMAND position;
#   * `ios_devicectl_shapes`                  — every `devicectl` subcommand a
#     file actually uses, so the permitted set is pinned rather than remembered;
#   * `ios_xcodebuild_launch_census`          — how many `xcodebuild` launches a
#     file starts and how many are still bare.

# ── a child that cannot ask the operator for anything ────────────────────────
#
# `</dev/null` alone is not enough and was tried. A backgrounded `xcodebuild`
# inherits the shell's CONTROLLING TERMINAL as well as its stdin, and a command
# started underneath it — Apple's own failure collection has reached for `sudo`
# — opens `/dev/tty` directly, which is a different file from stdin. The prompt
# then appears on the operator's terminal and the run stops until somebody
# notices. A harness meant to be startable from a queue cannot do that.
#
# `setsid(2)` is what changes it: a process in a fresh session has NO
# controlling terminal, so opening `/dev/tty` fails and there is nowhere for a
# prompt to go. macOS ships no `setsid(1)`, so the shim below is the portable
# form.
#
# What it must NOT change: the child's stdout and stderr still go wherever the
# caller redirected them, its exit status still reaches the caller's `wait`, and
# `$!` still names the command itself — `os.execvp` replaces the shim in place,
# so the PID the caller registers is the PID that must later be killed. Cleanup
# in `local-acceptance.sh` kills by exact PID and never by pattern, and a
# wrapper that added a process layer would quietly break that.
#
# One consequence, stated rather than discovered: a child in its own session is
# no longer in this shell's foreground process group, so a Ctrl-C at the
# terminal no longer reaches it DIRECTLY. It is still terminated, by the path
# this library has always relied on — the INT/TERM/HUP handlers run
# `terminate_children`, which sends TERM and then KILL to each registered PID.
#
# Usage, from the TOP-LEVEL shell, exactly like the bare command it replaces:
#
#   noninteractive xcodebuild … >"$log" 2>&1 &
#   pid=$!; register_child xcodebuild "$pid"
#
# `env VAR=… cmd` works unchanged: `execvp` is handed the whole argument vector.
ios_noninteractive_shim='import os, sys
try:
    os.setsid()
except OSError:
    # setsid(2) refuses for a process that is already a process-GROUP leader,
    # which is what bash makes an async child when the caller enabled job
    # control. That process is NOT detached: a group leader still holds its
    # session and the controlling terminal that goes with it, which is the file
    # a prompt is written to. So it is reported rather than passed over —
    # saying nothing would reproduce the original defect while every guard in
    # the tree went on claiming it was fixed.
    sys.stderr.write(
        "relayium: %s could not be detached from the controlling terminal "
        "(job control is on in the calling shell). Its stdin is still EOF, but "
        "a command started underneath it could still prompt on the terminal.\n"
        % sys.argv[1])
os.execvp(sys.argv[1], sys.argv[1:])'

noninteractive() {
  command -v python3 >/dev/null 2>&1 || {
    say "python3 is required to start acceptance children without a controlling terminal"
    exit 1
  }
  exec python3 -c "$ios_noninteractive_shim" "$@" </dev/null
}

# ── resolving ONE selector to ONE device ─────────────────────────────────────
#
# One physical iPhone has TWO identifiers and the two tools an operator reaches
# for print DIFFERENT ones:
#
#   xcrun devicectl list devices        -> the CoreDevice identifier, a UUID
#   xcodebuild -showdestinations …      -> the HARDWARE UDID, either the modern
#                                          8-16 hexadecimal shape or 40 hex
#
# Both are accepted, in either case, and what is handed to `xcodebuild` is
# ALWAYS the resolved hardware UDID, because that is the value
# `-destination "platform=iOS,id="` is matched against. Until this resolution
# existed the selector was compared against `devicectl`'s `identifier` and then
# handed to `xcodebuild` unchanged: a hardware UDID was refused as an unknown
# device before anything was built, and a CoreDevice identifier was refused by
# `xcodebuild` only AFTER a full `build-for-testing`.
#
# No real identifier appears in this file or in any fixture that drives it. A
# device UDID is a stable identifier for a piece of somebody's hardware and a
# harness has no reason to carry one in its source.
#
# Ambiguity is refused rather than resolved, and the exit status IS the finding:
#
#   3  nothing matched
#   4  more than one DEVICE matched
#   5  the matched device publishes no hardware UDID, so it cannot be an
#      `xcodebuild` destination at all
#
# Never a default, never a prefix match, never a "first connected".
ios_device_facts() {
  python3 - "$1" "$2" <<'PY'
import json, sys

with open(sys.argv[1]) as handle:
    payload = json.load(handle)
selector = sys.argv[2].strip().lower()

matches = {}
for device in payload.get("result", {}).get("devices", []):
    properties = device.get("hardwareProperties") or {}
    identifier = (device.get("identifier") or "").strip()
    hardware = (properties.get("udid") or "").strip()
    if selector and identifier and identifier.lower() == selector:
        matched = "its CoreDevice identifier"
    elif selector and hardware and hardware.lower() == selector:
        matched = "its hardware UDID"
    else:
        continue
    # Keyed on the CoreDevice identifier, so one device listed twice stays one
    # device while two DEVICES stay two matches and are refused below.
    matches[identifier or hardware] = (device, hardware, matched)

if not matches:
    sys.exit(3)
if len(matches) > 1:
    sys.exit(4)
device, hardware, matched = list(matches.values())[0]
if not hardware:
    sys.exit(5)

properties = device.get("hardwareProperties") or {}
model = properties.get("productType") or ""
platform = properties.get("platform") or ""
# The same three families `AppEnvironment.deviceFamilyName(forModelIdentifier:)`
# derives, from the same kind of identifier, so the name the launcher tells a
# runner to look for is the name the peer's app actually announces.
family = "iPhone"
for candidate in ("iPhone", "iPad", "iPod"):
    if model.startswith(candidate):
        family = "iPod touch" if candidate == "iPod" else candidate
        break
name = (device.get("deviceProperties") or {}).get("name") or "<unnamed>"
print("%s\t%s\t%s\t%s\t%s\t%s" % (family, model, platform, name, hardware, matched))
PY
}

# The same resolution, with each refusal said in terms of what the operator can
# do about it. The selector is echoed back only where it is the finding.
#
#   ios_read_device <devices.json> <selector> <label> <project>
ios_read_device() {
  local snapshot="$1" selector="$2" label="$3" project="$4" facts="" status=0
  facts="$(ios_device_facts "$snapshot" "$selector")" || status=$?
  case "$status" in
    0) ;;
    3) fail \
      "$label ($selector) matches no device in this Mac's list. Connect it, unlock it,
     trust this Mac, and copy EITHER identifier out of EITHER tool — both forms are
     accepted here:
       xcrun devicectl list devices
       xcodebuild -showdestinations -project $project -scheme Relayium" ;;
    4) fail \
      "$label ($selector) matches MORE THAN ONE connected device. This run will not choose
     between them: name each device by an identifier that belongs to it alone." ;;
    5) fail \
      "$label resolves to a device that publishes no hardware UDID, and xcodebuild names
     its destinations by exactly that value. Reconnect the device, unlock it, and check
     it is fully paired with this Mac." ;;
    *) fail "$label could not be resolved against the device list (status $status)" ;;
  esac
  printf '%s' "$facts"
}

# ── the refusal that has to be re-made AFTER resolution ──────────────────────
#
# A plain string comparison catches `--device-a X --device-b X`. It cannot catch
# `--device-a <CoreDevice identifier> --device-b <hardware UDID of the same
# phone>` — two different strings naming ONE device, which is reachable
# precisely BECAUSE both forms are accepted. Unrefused, a harness would run both
# halves of a two-device acceptance on one device and report a green result
# about a delivery that never left it.
ios_require_distinct_devices() {
  local resolved_a="$1" resolved_b="$2" how_a="${3:-a selector}" how_b="${4:-a selector}"
  [ "$resolved_a" != "$resolved_b" ] || {
    say "--device-a and --device-b resolve to the SAME physical device: --device-a named"
    say "it by $how_a and --device-b by $how_b. Two physical endpoints are the whole"
    say "point of this run, and one device cannot be both ends of a delivery."
    exit 1
  }
}

# ── two devices that announce the SAME name ─────────────────────────────────
#
# `AppEnvironment.deviceName()` answers the device FAMILY on iOS — "iPhone",
# "iPad", "iPod touch" — rather than the name the owner gave the device. That is
# a privacy property of the product and it is correct: the code-less room is
# keyed by the public address the hub observes, so it can hold strangers, and
# broadcasting "Lily's iPad" into it would be worse than broadcasting "iPad".
#
# It also means a valid pair of test devices can announce the SAME string. That
# is a supported pair rather than a refusal, and what changes is only how a
# roster row may be justified — see `DevicePairRosterChoice`. Nothing renames a
# device: there is no name override and no product seam behind this.
ios_peer_name_mode() {
  [ "$1" = "$2" ] && { printf 'shared'; return 0; }
  printf 'distinct'
}

# ── the structured-output channel, and the barrier built on it ───────────────

# One published fact, or a refusal. Never a default and never a retry.
#
#   ios_published <channel.py> <log> <tag> <role> <event>
ios_published() {
  python3 "$1" extract --log "$2" --tag "$3" --role "$4" --event "$5"
}

# ── waiting for ONE published fact, while its publisher is still alive ───────
#
# **This is the thing that stops two runners racing each other into automation.**
#
# Starting a role starts an `xcodebuild` UI-test session, and that session has to
# enable Automation Mode on its device before it can drive anything. Two sessions
# started in the same breath contend for it: the first device times out enabling
# automation and the second then fails for the only reason left — the peer never
# launched — with the log naming the wrong device and no product claim tested at
# all.
#
# So a phase starts ONE role, waits here until that role has published a fact
# that could only be published by a running app on a resolved screen, and only
# then starts the second. A handshake through the run's own structured output,
# not a sleep: a sleep long enough to be safe on a cold install is dead time on
# every other run, and neither can tell "still installing" from "never launched".
#
# It never calls `fail` itself — the caller is what knows what a missing fact
# MEANS, and keeping the refusal at the call site is also what lets a no-device
# self-test drive this loop without terminating the run. The value goes to
# stdout; every explanation goes to stderr.
#
#   0  published — the value is on stdout
#   1  the publisher exited first — it will never publish, so do not wait
#   2  the budget was exhausted while it was still alive
#
#   ios_await_event <channel.py> <log> <tag> <role> <event> <pid> <limit>
ios_await_event() {
  local channel="$1" log="$2" tag="$3" role="$4" event="$5"
  local publisher_pid="$6" limit="$7"
  local value="" waited=0
  while [ "$waited" -lt "$limit" ]; do
    if value="$(ios_published "$channel" "$log" "$tag" "$role" "$event" 2>/dev/null)" \
       && [ -n "$value" ]; then
      say "-- $role published $event after ${waited}s"
      printf '%s' "$value"
      return 0
    fi
    value=""
    # A runner that has already exited will never publish, and waiting out the
    # budget would report a timeout about a run that failed a minute ago.
    if ! kill -0 "$publisher_pid" 2>/dev/null; then
      say "-- $role exited before publishing $event; its last 60 lines follow"
      tail -60 "$log" 2>/dev/null | sed 's/^/   /' >&2 || true
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
  say "-- $role did not publish $event within ${limit}s; its last 60 lines follow"
  tail -60 "$log" 2>/dev/null | sed 's/^/   /' >&2 || true
  return 2
}

# ── the one receiver claim a UI cannot make ─────────────────────────────────
#
# The receiving app renders what it committed — a name and a size in the legacy
# lane, a count and a total in the link workspace — and a run that stopped there
# would be trusting the sending side's own description of the bytes. So the file
# itself is pulled off the receiving device and hashed here, and compared with a
# digest this harness knows independently of either device.
#
# `--domain-type appDataContainer` reads the app's OWN container and nothing
# else on the device: it is the same domain Xcode's own container download uses,
# it works because the harness installs a development-signed build, and it is
# read-only. No `devicectl` verb that erases, uninstalls, reboots or unpairs
# appears anywhere in this harness — see the destructive-verb scan below.
#
#   ios_container_file <udid> <bundle id> <source path> <destination> [json]
ios_container_file() {
  local udid="$1" bundle="$2" source="$3" destination="$4" json="${5:-/dev/null}"
  xcrun devicectl device copy from \
    --device "$udid" \
    --domain-type appDataContainer \
    --domain-identifier "$bundle" \
    --source "$source" \
    --destination "$destination" \
    --json-output "$json" \
    --quiet
}

# The same container, enumerated rather than read.
#
# Only ever reached on a FAILED read, and it exists because "the file is not
# there" and "the file is there under another name" are different findings that
# a failed `copy from` reports identically. Read-only, like `copy from`, and
# best-effort: a listing that cannot be taken must not turn a byte-level finding
# into a harness error.
#
#   ios_container_listing <udid> <bundle id> <subdirectory> [json]
ios_container_listing() {
  local udid="$1" bundle="$2" subdirectory="$3" json="${4:-/dev/null}"
  xcrun devicectl device info files \
    --device "$udid" \
    --domain-type appDataContainer \
    --domain-identifier "$bundle" \
    --subdirectory "$subdirectory" \
    --recurse \
    --json-output "$json"
}

# ── the ONE thing this harness writes to a device ────────────────────────────
#
# A receiving role publishes RECEIVED and then HOLDS — it stays alive, on the
# screen the product reached, so the bytes can be read out of a LIVE app
# container. Something has to tell it the read is done, and nothing else in this
# harness travels Mac → device: the run's facts go out as launch environment,
# and the channel is the runner's stdout, which only travels the other way.
#
# So the launcher writes one small file into the UI-TEST RUNNER's own data
# container and the runner polls its own `Documents` for it. Deliberately the
# RUNNER's container and never the product's:
#
#   * the XCTest process runs INSIDE the runner app, so its own `Documents` is
#     the only container it can read at all — the app under test is a different
#     sandbox;
#   * writing into the app under test's container would put harness state in the
#     very directory whose contents are the thing being proved.
#
# It carries the run tag and nothing else. It is not destructive, not a product
# path, and not a device setting: it is one file in the automation runner's own
# sandbox, which `xcodebuild` reinstalls on every run anyway.
#
#   ios_container_put <udid> <bundle id> <local source> <destination> [json]
ios_container_put() {
  local udid="$1" bundle="$2" source="$3" destination="$4" json="${5:-/dev/null}"
  xcrun devicectl device copy to \
    --device "$udid" \
    --domain-type appDataContainer \
    --domain-identifier "$bundle" \
    --source "$source" \
    --destination "$destination" \
    --json-output "$json" \
    --quiet
}

# The bundle identifier of the UI-test runner app this build produced.
#
# READ off the built product rather than composed from the project's
# `PRODUCT_BUNDLE_IDENTIFIER` plus the `.xctrunner` suffix Xcode appends. The
# suffix is Xcode's convention and not this repository's, and a harness that
# guessed it would write a release into a container that does not exist while
# reporting that it had released the runner.
#
# Exactly one runner app must be present. Zero and two are both refusals, for
# the same reason a device selector's are: there is no default and no first
# match.
#
#   3  no runner app in this derived-data tree
#   4  more than one, so which one is running is a guess
#   5  the runner app declares no bundle identifier
ios_ui_runner_bundle_id() {
  local derived="$1" candidate found="" identifier=""
  for candidate in "$derived"/Build/Products/*-iphoneos/*-Runner.app/Info.plist; do
    [ -f "$candidate" ] || continue
    if [ -n "$found" ]; then return 4; fi
    found="$candidate"
  done
  [ -n "$found" ] || return 3
  identifier="$(plutil -extract CFBundleIdentifier raw -o - "$found" 2>/dev/null)" || return 5
  [ -n "$identifier" ] || return 5
  printf '%s' "$identifier"
}

# The digest of a local file, as the bare hexadecimal string.
ios_sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

# ── the commands a physical harness may never run ────────────────────────────
#
# Three families, one scan, because they fail the same way — a run that stops
# halfway to ask a person something is a run nobody can put in a queue:
#
#   1. **anything that can raise a system authentication dialog.** The failure
#      path is the dangerous place: it is written in a hurry, by somebody who
#      wants more information, and it runs only when a run has already gone
#      wrong, so a prompt introduced there can sit unnoticed until it blocks a
#      queue at three in the morning;
#   2. **anything that changes a network setting.** Both ends have to be on the
#      network the fleet actually has, and a harness that could turn an
#      interface on would be proving something about a configuration it created;
#   3. **anything destructive to a device or a checkout.** Erasing, wiping,
#      restoring, rebooting or uninstalling are operator decisions taken
#      knowingly, never a harness's recovery step.
#
# Matched in COMMAND POSITION — at the start of a line, or after `;`, `&`, `|`,
# `(` or `$(` — which is what lets the pattern name what it forbids without
# banning its own text. Whole-line comments are stripped by the caller.
#
# `devicectl` is deliberately NOT in the list: a physical harness cannot resolve
# a device without it. What is forbidden instead is every one of its DESTRUCTIVE
# subcommands, matched wherever they appear. A ban list alone would be the weaker
# rule, though — it says nothing about a verb nobody thought to ban — so
# `ios_devicectl_shapes` below reports every shape a file actually uses and the
# caller's self-test pins the permitted set exactly.
ios_forbidden_command_pattern='(^|[;&|(]|\$\()[[:space:]]*(sudo|su|osascript|security|dscl|dseditgroup|sysdiagnose|spctl|authopen|csrutil|diskutil|installer|softwareupdate|systemsetup|networksetup|pmset|launchctl|DevToolsSecurity|nvram|kmutil|kextload|tccutil|log|scutil|ifconfig|route|airport|wdutil|dns-sd)([[:space:]]|$)'

# The destructive DEVICE verbs, matched anywhere rather than in command
# position: they arrive as `devicectl device erase`, never as a bare word at the
# start of a line, and the subcommand is the thing being forbidden.
ios_destructive_verb_pattern='(devicectl[[:space:]]+device[[:space:]]+(erase|uninstall|reboot|restart|restore|clearAppData|unpair)|simctl[[:space:]]+(erase|shutdown|delete))'

# A named file with continuation lines joined and comments removed.
ios_joined_source() {
  sed -e :a -e '/\\$/N; s/\\\n//; ta' "$1" | grep -v '^[[:space:]]*#'
}

# ── recursive deletes, which are a DIFFERENT rule ───────────────────────────
#
# A blanket ban would be wrong: a harness has to be able to remove its own
# `mktemp -d` scratch. So this reports the SITES rather than judging them, and
# the caller pins the exact set. That is the stronger rule anyway — "the only
# recursive delete in this file targets the run's own temporary root" is a claim
# a reviewer can check, where "there are none" would be a claim the file could
# not honour.
ios_recursive_delete_sites() {
  ios_joined_source "$1" \
    | grep -oE 'rm[[:space:]]+-[a-zA-Z]*[rR][a-zA-Z]*[[:space:]]+[^ ;&|)]+' \
    | sort -u | tr '\n' ';'
}

# Every forbidden command a named file actually runs, one per line with its
# line number, or nothing at all.
ios_forbidden_command_hits() {
  grep -v '^[[:space:]]*#' "$1" \
    | grep -nE "$ios_forbidden_command_pattern|$ios_destructive_verb_pattern" || true
}

# ── every `devicectl` shape a file uses, as an allow-list the caller pins ────
#
# The destructive-verb ban answers "does this file erase a device". It cannot
# answer "does this file do something to a device that nobody has thought
# about", which is the question that matters when a harness grows a new
# capability. So this reports the subcommand path of every `devicectl`
# invocation — the two words after it — sorted and de-duplicated, and the
# caller's self-test asserts the exact set. Adding a verb is then a visible,
# deliberate edit to a pinned string rather than a line nobody reviews.
#
# Comments are dropped first, so prose naming a verb this harness refuses to run
# does not enter the census.
ios_devicectl_shapes() {
  ios_joined_source "$1" \
    | grep -oE 'devicectl[[:space:]]+[a-zA-Z]+([[:space:]]+[a-zA-Z]+){0,2}' \
    | sed 's/^devicectl[[:space:]][[:space:]]*//; s/[[:space:]][[:space:]]*/ /g' \
    | sort -u | tr '\n' ';'
}

# ── every `xcodebuild` a file starts, and whether it can reach a terminal ────
#
# The scan above proves a file runs no command that can ask for admin
# credentials. That is not sufficient on its own: a backgrounded `xcodebuild`
# inherits the shell's controlling terminal, and Apple's own failure collection
# has reached for `sudo` underneath it. So the property is also enforced one
# level down.
#
# A LAUNCH is a command-position `xcodebuild` — optionally behind `env`, which
# is how a runner's facts are passed out of argv — carrying a `-destination`.
# Continuation lines are joined first, so the second line of a multi-line
# invocation is not a launch of its own, and comments are dropped, so prose that
# tells an operator to run `xcodebuild -showdestinations` does not count.
ios_xcodebuild_launch_pattern='^[[:space:]]*(noninteractive[[:space:]]+)?(env[[:space:]].*[[:space:]])?xcodebuild[[:space:]].*[[:space:]]-destination[[:space:]]'
ios_xcodebuild_guarded_pattern='^[[:space:]]*noninteractive[[:space:]]'

# How many launches there are, and how many of them are still bare. Both halves
# are reported together on purpose: "0 bare" from a file that launches nothing is
# the reading that would let a scan rot into a tautology.
ios_xcodebuild_launch_census() {
  local all bare
  all="$(ios_joined_source "$1" | grep -cE "$ios_xcodebuild_launch_pattern" || true)"
  bare="$(ios_joined_source "$1" | grep -E "$ios_xcodebuild_launch_pattern" \
    | grep -cvE "$ios_xcodebuild_guarded_pattern" || true)"
  printf '%s launches, %s bare' "$all" "$bare"
}
