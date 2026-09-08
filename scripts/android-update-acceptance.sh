#!/usr/bin/env bash
#
# **The update check, on a real emulator, against a real HTTP server.**
#
#   ./scripts/android-update-acceptance.sh
#
# `UpdateAcceptanceTest` drives the real `MainActivity`, the real
# `UpdateChecker` and the real OkHttp client. The only thing substituted is
# WHERE the feed comes from: this script serves a throwaway one on the host and
# points the app at it through the debug feed override — the same fenced seam
# `Backend` uses for the backend origin, and it exists for the same reason.
# 0.1.1 is the FIRST build with an updater, so without it the "an update is
# available" branch cannot be reached on a device at all until something newer
# is already public, and the branch that matters most would ship untested.
#
# ## Why one instrumentation run per scenario
#
# The feed URL is resolved ONCE, when the ViewModel is constructed, exactly as
# it is in production. So each scenario sets the property to a different path
# and runs a single test method against it. That keeps the product's own
# resolution unchanged rather than adding a runtime switch it does not have.
#
# ## What is served
#
#   /future.json   versionCode 999 — the only state that offers a download
#   /current.json  this build's own versionCode — up to date
#   /error.json    HTTP 500 — must render as an error, never as up to date
#   /slow.json     headers, then a long pause — so Cancel has something to cancel
#
# ## The mandatory precheck
#
# Every test asserts the app RESOLVED this run's feed before believing any
# answer it shows. `UpdateEndpoint.readDebugOverride` reads a non-public class
# reflectively and fails closed to production, so a run that skipped this could
# read the real feed and report whatever it says as though the test produced it.
#
# Nothing here downloads or installs anything: the download test intercepts the
# real ACTION_VIEW Intent with an ActivityMonitor that blocks the launch.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"

adb="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}/platform-tools/adb"
serial="${ANDROID_SERIAL:-}"
gradle_bin="${RELAYIUM_GRADLE:-$repo/apps/android/gradlew}"
app_id="com.relayium.android.debug"
test_pkg="$app_id.test"
runner="androidx.test.runner.AndroidJUnitRunner"
klass="com.relayium.android.UpdateAcceptanceTest"
out_dir="${RELAYIUM_UPDATE_OUT:-$repo/apps/android/build/update-acceptance}"
feed_port="${RELAYIUM_FEED_PORT:-8181}"
# The emulator's route to the host loopback. `UpdateEndpoint` accepts only these
# names, and only in a debug build.
feed_host="${RELAYIUM_FEED_HOST:-10.0.2.2}"

say() { printf '%s\n' "$*" >&2; }
fail() { say "ERROR: $*"; exit 1; }

[ -x "$adb" ] || fail "adb not found at $adb; set ANDROID_HOME or ANDROID_SDK_ROOT"
devices="$("$adb" devices | awk 'NR>1 && $2=="device" {print $1}')"
[ -n "$devices" ] || fail "no attached device; start an emulator first"
[ -n "$serial" ] || serial="$(printf '%s\n' "$devices" | head -1)"
printf '%s\n' "$devices" | grep -qx "$serial" || fail "ANDROID_SERIAL=$serial not attached ($devices)"
adbs() { "$adb" -s "$serial" "$@"; }

mkdir -p "$out_dir"

# The version the app itself reports, read from the build file rather than
# written down twice: `current.json` has to advertise exactly this or the
# up-to-date scenario proves nothing.
version_name="$(sed -n 's/^ *versionName = "\(.*\)"/\1/p' "$repo/apps/android/app/build.gradle.kts" | head -1)"
version_code="$(sed -n 's/^ *versionCode = \([0-9]*\)/\1/p' "$repo/apps/android/app/build.gradle.kts" | head -1)"
[ -n "$version_name" ] && [ -n "$version_code" ] || fail "could not read versionName/versionCode"
say "== app under test: $version_name ($version_code) =="

say "== building the debug APK and its instrumentation =="
[ -x "$gradle_bin" ] || gradle_bin="gradle"
( cd "$repo/apps/android" && "$gradle_bin" -Prelayium.android=true \
    :app:assembleDebug :app:assembleDebugAndroidTest >/dev/null ) \
  || fail "the Android build failed"
app_apk="$repo/apps/android/app/build/outputs/apk/debug/app-debug.apk"
test_apk="$repo/apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
adbs install -r -t "$app_apk" >/dev/null || fail "could not install the app"
adbs install -r -t "$test_apk" >/dev/null || fail "could not install the instrumentation"

# ── the throwaway feed ──────────────────────────────────────────────────────

feed_py="$out_dir/feed-server.py"
cat > "$feed_py" <<'PYEOF'
import http.server, json, sys, threading, time

VERSION_NAME = sys.argv[2]
VERSION_CODE = int(sys.argv[3])
FUTURE_NAME, FUTURE_CODE = "9.9.9", 999

def doc(name, code):
    return {
        "schema": 1,
        "android": {
            "available": True,
            "applicationId": "com.relayium.android",
            "versionCode": code,
            "versionName": name,
            "downloadUrl": (
                "https://github.com/relayium/relayium/releases/download/"
                f"android-v{name}/Relayium-{name}-{code}.apk"
            ),
            "sha256": "a" * 64,
            "size": 41184124,
            "notes": {"en": "Adds a manual update check.", "zh": "新增手动检查更新。"},
        },
    }

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        sys.stderr.write("feed: %s\n" % (a[0] % a[1:]))

    def _json(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/future"):
            self._json(doc(FUTURE_NAME, FUTURE_CODE))
        elif self.path.startswith("/current"):
            self._json(doc(VERSION_NAME, VERSION_CODE))
        elif self.path.startswith("/error"):
            body = b"<!doctype html><html><body>upstream failed</body></html>"
            self.send_response(500)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path.startswith("/slow"):
            # Headers now, body much later: the check is genuinely in flight
            # when Cancel is pressed, and its late answer must not publish.
            payload = json.dumps(doc(FUTURE_NAME, FUTURE_CODE)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.flush()
            time.sleep(4)
            try:
                self.wfile.write(payload)
            except Exception:
                pass
        else:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()

srv = http.server.ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1])), Handler)
srv.serve_forever()
PYEOF

say "== starting the throwaway feed on :$feed_port =="
# Refuse a port somebody else already owns. Binding failures here are silent to
# the driver — python exits, the tests still run, and they read whatever OTHER
# process is on that port. That would be a green run against a feed this script
# never wrote.
if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$feed_port" 2>/dev/null; then
  fail "port $feed_port is already in use; set RELAYIUM_FEED_PORT"
fi
python3 "$feed_py" "$feed_port" "$version_name" "$version_code" > "$out_dir/feed.log" 2>&1 &
feed_pid=$!
# Armed IMMEDIATELY, before the readiness wait: a failure between spawn and the
# first scenario must still stop the server rather than leave it holding a port.
trap 'kill "$feed_pid" 2>/dev/null || true' EXIT

# Readiness bound to THIS process: the port must come up AND the process must
# still be alive. A dead child with a lingering socket would otherwise read as
# ready.
feed_ready=0
for _ in $(seq 1 50); do
  kill -0 "$feed_pid" 2>/dev/null || break
  # Bounded inside curl too: without these the loop's own 50 iterations mean
  # nothing, because a single curl can hang far longer than the whole budget.
  if curl -fsS --connect-timeout 1 --max-time 2 -o /dev/null \
       "http://127.0.0.1:$feed_port/current.json" 2>/dev/null; then
    feed_ready=1; break
  fi
  sleep 0.2
done
[ "$feed_ready" -eq 1 ] || {
  say "--- feed log ---"; cat "$out_dir/feed.log" >&2 || true
  fail "the throwaway feed never became ready on :$feed_port"
}
say "   feed ready (pid $feed_pid)"

# ── snapshot BEFORE any mutation, and arm the restore first ─────────────────
orig_feed="$(adbs shell getprop debug.relayium.updatefeed | tr -d '\r')"
orig_locales="$(adbs shell cmd locale get-app-locales "$app_id" 2>/dev/null | tr -d '\r' \
  | sed -n 's/.*\[\([^]]*\)\].*/\1/p')"
density_dump="$(adbs shell wm density | tr -d '\r')"
orig_density_override="$(printf '%s\n' "$density_dump" | sed -n 's/^Override density: //p')"
orig_font="$(adbs shell settings get system font_scale | tr -d '\r')"
[ "$orig_font" = "null" ] && orig_font="1.0"

set_app_locale() {
  local tag="$1"
  if [ -n "$tag" ]; then
    adbs shell cmd locale set-app-locales "$app_id" --user 0 --locales "$tag"
  else
    adbs shell cmd locale set-app-locales "$app_id" --user 0
  fi
}

restore() {
  say "-- restoring the device and stopping the feed"
  # Reaped, not just signalled: an unwaited child would leave a zombie holding
  # the port for the next run in the same shell.
  kill "$feed_pid" 2>/dev/null || true
  wait "$feed_pid" 2>/dev/null || true
  if [ -n "$orig_density_override" ]; then
    adbs shell wm density "$orig_density_override" >/dev/null 2>&1 || true
  else
    adbs shell wm density reset >/dev/null 2>&1 || true
  fi
  adbs shell settings put system font_scale "$orig_font" >/dev/null 2>&1 || true
  set_app_locale "$orig_locales" >/dev/null 2>&1 || true
  if [ -n "$orig_feed" ]; then
    adbs shell setprop debug.relayium.updatefeed "$orig_feed" >/dev/null 2>&1 || true
  else
    adbs shell setprop debug.relayium.updatefeed '""' >/dev/null 2>&1 || true
  fi
  adbs shell am force-stop "$app_id" >/dev/null 2>&1 || true
}
trap restore EXIT

short_px="$(adbs shell wm size | tr -d '\r' | sed -n 's/^Physical size: //p' | head -1 \
  | awk -Fx '{print ($1<$2)?$1:$2}')"
[ -n "$short_px" ] || short_px=1080
dp320_density=$(( short_px * 160 / 320 ))

device_out="/sdcard/Android/media/$app_id/update-acceptance"
adbs shell rm -rf "$device_out" >/dev/null 2>&1 || true
adbs shell mkdir -p "$device_out" >/dev/null 2>&1 || true

failures=0

# scenario  feed-path  test-method
scenarios=(
  "future    /future.json   futureVersionOffersDownloadWithNotes"
  "current   /current.json  currentVersionReportsUpToDateAndOffersNothing"
  "error     /error.json    unreachableFeedReportsAnErrorAndNeverUpToDate"
  "intent    /future.json   downloadFiresRealViewIntent"
  "target    /future.json   downloadTargetsTheOfficialImmutableAsset"
  "nobrowser /future.json   noBrowserShowsCopyableUrl"
  "cancel    /slow.json     cancellingAStalledCheckReturnsToRestAndStaysThere"
  "idle      /current.json  rowNamesTheInstalledVersionAsAPreview"
)

# How many scenarios call screenshot(). Declared here so the expected total is
# derived rather than written down as a magic number: future, current, error,
# nobrowser, cancel and idle each capture one; intent and target do not.
screenshot_scenarios=6

# corner  locale  density  font
corners=(
  "en-default   en-US  reset            1.0"
  "en-320-font2 en-US  $dp320_density   2.0"
  "zh-320-font2 zh-CN  $dp320_density   2.0"
)

run_scenario() {
  local corner="$1" locale="$2" density="$3" font="$4" name="$5" path="$6" method="$7"
  local feed="http://$feed_host:$feed_port$path"
  local tag="$corner-$name"

  adbs shell am force-stop "$app_id" >/dev/null 2>&1 || true
  adbs shell setprop debug.relayium.updatefeed "$feed" || fail "could not set the feed prop"
  [ "$(adbs shell getprop debug.relayium.updatefeed | tr -d '\r')" = "$feed" ] \
    || fail "the feed property did not take"

  say "-- $tag ($locale, density $density, font $font) -> $path"
  local log="$out_dir/$tag.log"
  set +e
  adbs shell am instrument -w -r \
    -e class "$klass#$method" \
    -e relayium.feed "$feed" \
    -e relayium.corner "$corner" \
    -e relayium.out "$device_out" \
    "$test_pkg/$runner" > "$log" 2>&1
  local rc=$?
  set -e
  # The exit status is nearly meaningless here — `am instrument` returns 0 for a
  # crashed process, a missing instrumentation and an empty run alike — so the
  # verdict comes from the stream, judged by a program that requires POSITIVE
  # evidence that exactly one test finished OK. See lib/instrumentation-result.sh.
  if [ "$rc" -ne 0 ]; then
    say "   FAILED ($tag) — adb exited $rc; see $log"
    failures=$((failures + 1))
  elif ! "$here/lib/instrumentation-result.sh" "$log" 1 >/dev/null 2>"$log.verdict"; then
    say "   FAILED ($tag) — $(cat "$log.verdict")"
    failures=$((failures + 1))
  else
    say "   ok"
  fi
}

for corner_line in "${corners[@]}"; do
  # shellcheck disable=SC2086
  set -- $corner_line
  corner="$1"; locale="$2"; density="$3"; font="$4"

  say "== corner $corner =="
  if [ "$density" = "reset" ]; then
    adbs shell wm density reset >/dev/null
  else
    adbs shell wm density "$density" >/dev/null
  fi
  adbs shell settings put system font_scale "$font" >/dev/null
  set_app_locale "$locale" >/dev/null

  for scenario_line in "${scenarios[@]}"; do
    # shellcheck disable=SC2086
    set -- $scenario_line
    run_scenario "$corner" "$locale" "$density" "$font" "$1" "$2" "$3"
  done
done

say "== collecting screenshots =="
# A FRESH directory, and an exact expected count.
#
# "some PNGs exist" is not evidence: a stale directory from an earlier run
# satisfies it, and so does a partial pull. This run knows precisely how many
# screenshots it should have produced — one per screenshotting scenario per
# corner — so it asserts that number against a directory it just created, and a
# failed pull is a failure rather than a shrug.
screens_dir="$out_dir/screens"
rm -rf "$screens_dir"
mkdir -p "$screens_dir"
adbs pull "$device_out" "$screens_dir" >/dev/null 2>&1 \
  || fail "could not pull screenshots from $device_out"
shots="$(find "$screens_dir" -name '*.png' 2>/dev/null | wc -l | tr -d ' ')"
expected_shots=$(( ${#corners[@]} * screenshot_scenarios ))
[ "$shots" -eq "$expected_shots" ] \
  || fail "expected $expected_shots screenshots (${#corners[@]} corners x $screenshot_scenarios), found $shots in $screens_dir"
say "   $shots screenshot(s), as expected"

if [ "$failures" -gt 0 ]; then
  fail "$failures update-acceptance scenario(s) failed; logs in $out_dir"
fi
say "update acceptance: all scenarios passed across ${#corners[@]} configuration corners"
say "screenshots and logs: $out_dir"
