#!/usr/bin/env bash
# Real cross-UID file drag, ephemeral URI permission, and file-entry UI.
# Only an explicitly selected emulator is accepted; this fixture has no backend.
set -Eeuo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
serial="${ANDROID_SERIAL:?set ANDROID_SERIAL to the owned emulator}"
[[ "$serial" =~ ^emulator-[0-9]+$ ]] || { echo 'an emulator serial is required' >&2; exit 2; }
adb="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}/platform-tools/adb"
[ -x "$adb" ] || { echo 'Android SDK adb is missing' >&2; exit 2; }
[ "$("$adb" -s "$serial" shell getprop ro.kernel.qemu | tr -d '\r')" = 1 ] || {
  echo 'the selected device is not an emulator' >&2; exit 2;
}
out="${RELAYIUM_FILE_DROP_OUT:-$repo/apps/android/build/file-drop-acceptance}"
mkdir -p "$out"
collect() {
  local run_status=$?
  trap - EXIT
  "$adb" -s "$serial" pull "/sdcard/Android/data/com.relayium.android.debug/files/session-drop-acceptance" \
    "$out/screenshots" >/dev/null 2>&1 || true
  exit "$run_status"
}
trap collect EXIT
gradle="${RELAYIUM_GRADLE:-$repo/apps/android/gradlew}"
(cd "$repo/apps/android" && "$gradle" --no-daemon -Prelayium.android=true \
  :app:assembleDebug :app:assembleDebugAndroidTest) >"$out/gradle.log" 2>&1
"$adb" -s "$serial" install -r -t "$repo/apps/android/app/build/outputs/apk/debug/app-debug.apk"
"$adb" -s "$serial" install -r -t "$repo/apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
python3 - "$adb" "$serial" "$out/instrumentation.log" <<'PY'
import subprocess,sys
adb,serial,log=sys.argv[1:]
with open(log,'w') as output:
    child=subprocess.Popen([adb,'-s',serial,'shell','am','instrument','-w','-r','-e','class',
        'com.relayium.android.SessionFileDropAcceptanceTest',
        'com.relayium.android.debug.test/androidx.test.runner.AndroidJUnitRunner'],stdout=output,stderr=subprocess.STDOUT)
    try:
        result=child.wait(timeout=240)
    except subprocess.TimeoutExpired:
        child.terminate()
        child.wait(timeout=10)
        subprocess.run([adb,'-s',serial,'shell','am','force-stop','com.relayium.android.debug'],timeout=15,check=True)
        raise
    if result: sys.exit(result)
PY
bash "$here/lib/instrumentation-result.sh" "$out/instrumentation.log" 6
