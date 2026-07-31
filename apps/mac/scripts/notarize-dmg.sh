#!/bin/bash

set -Eeuo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: notarize-dmg.sh /path/to/Relayium.dmg /path/to/evidence-directory

Required environment:
  MACOS_NOTARY_KEY_PATH   Path to an App Store Connect API private key (.p8)
  MACOS_NOTARY_KEY_ID     App Store Connect API key ID
  MACOS_NOTARY_ISSUER_ID  App Store Connect API issuer ID (team key)
EOF
}

if [ "$#" -ne 2 ]; then
  usage
  exit 64
fi

dmg_input="$1"
evidence_input="$2"

if [ ! -f "$dmg_input" ] || [ "${dmg_input##*.}" != "dmg" ]; then
  echo "error: input must be an existing .dmg: $dmg_input" >&2
  exit 66
fi

if [ ! -d "$evidence_input" ]; then
  echo "error: evidence directory does not exist: $evidence_input" >&2
  exit 73
fi

: "${MACOS_NOTARY_KEY_PATH:?MACOS_NOTARY_KEY_PATH is required}"
: "${MACOS_NOTARY_KEY_ID:?MACOS_NOTARY_KEY_ID is required}"
: "${MACOS_NOTARY_ISSUER_ID:?MACOS_NOTARY_ISSUER_ID is required}"

if [ ! -f "$MACOS_NOTARY_KEY_PATH" ]; then
  echo "error: API private key does not exist: $MACOS_NOTARY_KEY_PATH" >&2
  exit 66
fi

dmg="$(cd "$(dirname "$dmg_input")" && pwd -P)/$(basename "$dmg_input")"
evidence_dir="$(cd "$evidence_input" && pwd -P)"
submission_json="$evidence_dir/submission.json"
notary_log="$evidence_dir/notarization-log.json"

if [ -e "$submission_json" ] || [ -e "$notary_log" ]; then
  echo "error: refusing to overwrite existing notarization evidence in $evidence_dir" >&2
  exit 73
fi

# Reject a malformed or unsigned image before consuming one of Apple's daily
# submissions. A notarization ticket can be issued for an unsigned container,
# but Gatekeeper's top-level DMG assessment then reports "no usable signature."
codesign --verify --strict --verbose=2 "$dmg"
dmg_signature="$(codesign -d --verbose=4 "$dmg" 2>&1)"
if ! printf '%s\n' "$dmg_signature" | grep -q '^Timestamp='; then
  echo "error: disk image has no secure timestamp" >&2
  exit 65
fi
hdiutil verify "$dmg"

submit_result=0
xcrun notarytool submit "$dmg" \
  --key "$MACOS_NOTARY_KEY_PATH" \
  --key-id "$MACOS_NOTARY_KEY_ID" \
  --issuer "$MACOS_NOTARY_ISSUER_ID" \
  --wait \
  --timeout 45m \
  --output-format json > "$submission_json" || submit_result=$?

submission_id="$(
  plutil -extract id raw -o - "$submission_json" 2>/dev/null || true
)"
status="$(
  plutil -extract status raw -o - "$submission_json" 2>/dev/null || true
)"

# Apple recommends inspecting the log even for an accepted submission. Keep it
# as workflow evidence, and also retrieve it on a rejected submission whenever
# notarytool returned a submission ID.
if [ -n "$submission_id" ]; then
  xcrun notarytool log "$submission_id" "$notary_log" \
    --key "$MACOS_NOTARY_KEY_PATH" \
    --key-id "$MACOS_NOTARY_KEY_ID" \
    --issuer "$MACOS_NOTARY_ISSUER_ID" || true
fi

if [ "$submit_result" -ne 0 ] || [ "$status" != "Accepted" ]; then
  echo "error: Apple notarization was not accepted (status: ${status:-unknown})" >&2
  echo "submission metadata: $submission_json" >&2
  if [ -f "$notary_log" ]; then
    echo "notarization log: $notary_log" >&2
  fi
  exit 65
fi

xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
hdiutil verify "$dmg"

# Assess the final top-level artifact exactly as Gatekeeper does when a user
# opens a downloaded disk image.
spctl --assess \
  --type open \
  --context context:primary-signature \
  --verbose=4 \
  "$dmg"

# Stapling modifies the image, so the pre-notarization checksum is no longer
# valid. Replace it atomically only after every final verification passes.
checksum_path="$dmg.sha256"
checksum_tmp="$evidence_dir/Relayium.dmg.sha256"
checksum="$(shasum -a 256 "$dmg" | awk '{print $1}')"
printf '%s  %s\n' "$checksum" "$(basename "$dmg")" > "$checksum_tmp"
mv "$checksum_tmp" "$checksum_path"

echo "Notarized and stapled $dmg"
echo "Submission $submission_id"
echo "Evidence $evidence_dir"
echo "Checksum $checksum_path"
