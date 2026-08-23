#!/bin/bash

# Bounded, classified retry around `hdiutil verify`.
#
# Hosted macOS runners intermittently answer a verification of a freshly created
# image with
#   hdiutil: verify failed - Resource temporarily unavailable
# because another process still holds the image. That is a readiness race, not a
# defect in the image, so it is the only failure this helper retries. Every other
# failure keeps hdiutil's original output and original exit status and fails on
# the first attempt.
#
# Retrying is bounded by wall-clock time rather than a fixed attempt count, so a
# slow runner still gets its full readiness window while a permanently stuck one
# cannot stall a build. A separate attempt backstop bounds the loop even when the
# clock never advances, which a purely time-based bound cannot do.
#
# Configuration. Every value must be a non-negative decimal integer; anything
# else is rejected with status 78 (EX_CONFIG) before the first verification.
#   RELAYIUM_HDIUTIL_VERIFY_DEADLINE_SECONDS         retry window   (default 120)
#   RELAYIUM_HDIUTIL_VERIFY_INITIAL_BACKOFF_SECONDS  first backoff  (default 1)
#   RELAYIUM_HDIUTIL_VERIFY_MAX_BACKOFF_SECONDS      backoff cap    (default 8)
#   RELAYIUM_HDIUTIL_VERIFY_MAX_ATTEMPTS             attempt cap    (default 200)
# A deadline of 0 performs exactly one verification and never retries.

# Reject a configuration value that is not a non-negative decimal integer. The
# check is a glob rather than a regex so it behaves identically under Bash 3.2.
hdiutil_validate_config() {
  local name="$1"
  local value="$2"

  case "$value" in
    '' | *[!0-9]*)
      echo "error: $name must be a non-negative integer, got: '$value'" >&2
      return 1
      ;;
  esac

  return 0
}

# Drop leading zeros so later arithmetic cannot reinterpret a padded value such
# as 08 as an invalid octal literal.
hdiutil_normalize_integer() {
  local value="$1"

  while [ -n "${value#0}" ] && [ "${value#0}" != "$value" ]; do
    value="${value#0}"
  done

  printf '%s' "$value"
}

# True only when hdiutil itself reported a failed operation whose reason is the
# transient-resource condition, for example:
#   hdiutil: verify failed - Resource temporarily unavailable
# A line that merely contains the phrase is not a readiness signal: it may be a
# path, a volume name, or a message from another tool, and retrying it would
# turn a permanent failure into a long stall. The line therefore has to carry
# hdiutil's own single-word operation prefix, and the phrase has to be the start
# of the failure reason rather than text buried inside it.
#
# The scan uses a here-string loop rather than a pipeline, so the verdict is
# decided in this shell and `set -o pipefail` at the call site cannot influence
# a classification that must depend only on the text.
hdiutil_failure_is_transient() {
  local output="$1"
  local line
  local operation
  local reason
  local rest

  while IFS= read -r line; do
    # Tolerate CRLF-style output without letting the carriage return defeat the
    # reason comparison below.
    line="${line%$'\r'}"

    case "$line" in
      'hdiutil: '*' failed - '*) ;;
      *) continue ;;
    esac

    operation="${line#hdiutil: }"
    operation="${operation%% failed - *}"
    case "$operation" in
      '' | *[[:space:]]*) continue ;;
    esac

    reason="${line#* failed - }"
    while [ "$reason" != "${reason%[[:space:]]}" ]; do
      reason="${reason%[[:space:]]}"
    done

    # The phrase must open the reason and end on a token boundary. A plain
    # reason and a detailed one such as "... unavailable (35)" both qualify,
    # while a path whose first segment happens to be the phrase does not.
    case "$reason" in
      'Resource temporarily unavailable')
        return 0
        ;;
      'Resource temporarily unavailable'*)
        rest="${reason#Resource temporarily unavailable}"
        case "$rest" in
          /* | [[:alnum:]]*) ;;
          *) return 0 ;;
        esac
        ;;
    esac
  done <<<"$output"

  return 1
}

# Best-effort context for the first classified readiness failure, recorded once
# per verification so a long retry window cannot flood the log. Everything here
# is advisory: it helps identify the process still holding the image, and none
# of it may influence the retry decision, so the caller discards its status.
# `lsof -S` bounds a kernel call that could otherwise block on an unresponsive
# mount, and `-w` suppresses warning noise about unreadable paths.
hdiutil_log_lock_diagnostics() {
  local image="$1"

  echo "note: collecting one-shot hdiutil readiness diagnostics for $image" >&2
  if command -v mount >/dev/null 2>&1; then
    mount >&2 2>/dev/null || true
  fi
  if command -v hdiutil >/dev/null 2>&1; then
    hdiutil info >&2 2>/dev/null || true
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -w -S 2 -- "$image" >&2 2>/dev/null || true
  fi
}

verify_hdiutil_image() {
  local image="$1"
  local deadline_seconds
  local initial_backoff
  local max_backoff
  local max_attempts
  local config_ok=true
  local started_at
  local now
  local elapsed
  local remaining
  local backoff
  local pause
  local attempt=0
  local diagnostics_logged=false
  local output
  local status

  deadline_seconds="${RELAYIUM_HDIUTIL_VERIFY_DEADLINE_SECONDS-120}"
  initial_backoff="${RELAYIUM_HDIUTIL_VERIFY_INITIAL_BACKOFF_SECONDS-1}"
  max_backoff="${RELAYIUM_HDIUTIL_VERIFY_MAX_BACKOFF_SECONDS-8}"
  max_attempts="${RELAYIUM_HDIUTIL_VERIFY_MAX_ATTEMPTS-200}"

  # Validate the complete configuration before spending a single verification,
  # so a typo cannot silently degrade the readiness window instead of failing.
  # Every offending value is reported, not just the first.
  hdiutil_validate_config RELAYIUM_HDIUTIL_VERIFY_DEADLINE_SECONDS \
    "$deadline_seconds" || config_ok=false
  hdiutil_validate_config RELAYIUM_HDIUTIL_VERIFY_INITIAL_BACKOFF_SECONDS \
    "$initial_backoff" || config_ok=false
  hdiutil_validate_config RELAYIUM_HDIUTIL_VERIFY_MAX_BACKOFF_SECONDS \
    "$max_backoff" || config_ok=false
  hdiutil_validate_config RELAYIUM_HDIUTIL_VERIFY_MAX_ATTEMPTS \
    "$max_attempts" || config_ok=false

  if [ "$config_ok" != true ]; then
    return 78
  fi

  deadline_seconds="$(hdiutil_normalize_integer "$deadline_seconds")"
  initial_backoff="$(hdiutil_normalize_integer "$initial_backoff")"
  max_backoff="$(hdiutil_normalize_integer "$max_backoff")"
  max_attempts="$(hdiutil_normalize_integer "$max_attempts")"

  # A zero initial backoff would spin without yielding the image to whoever
  # holds it, and a cap below the initial backoff is self-contradictory.
  if [ "$initial_backoff" -lt 1 ]; then
    initial_backoff=1
  fi
  if [ "$max_backoff" -lt "$initial_backoff" ]; then
    max_backoff="$initial_backoff"
  fi

  started_at="$(date +%s)"
  backoff="$initial_backoff"

  while true; do
    attempt=$((attempt + 1))

    # Capture status separately from the assignment: `local output="$(...)"`
    # would report the status of `local`, not of hdiutil.
    status=0
    output="$(hdiutil verify "$image" 2>&1)" || status=$?

    if [ "$status" -eq 0 ]; then
      if [ -n "$output" ]; then
        printf '%s\n' "$output"
      fi
      return 0
    fi

    if [ -n "$output" ]; then
      printf '%s\n' "$output" >&2
    fi

    if ! hdiutil_failure_is_transient "$output"; then
      return "$status"
    fi

    if [ "$diagnostics_logged" = false ]; then
      diagnostics_logged=true
      hdiutil_log_lock_diagnostics "$image" || true
    fi

    now="$(date +%s)"
    elapsed=$((now - started_at))
    if [ "$elapsed" -lt 0 ]; then
      # A backwards clock step must not extend or shorten the window silently;
      # treat it as no progress and let the attempt cap bound the loop.
      elapsed=0
    fi
    remaining=$((deadline_seconds - elapsed))

    if [ "$remaining" -le 0 ]; then
      echo "error: hdiutil verify remained temporarily unavailable for ${deadline_seconds}s across $attempt attempts" >&2
      return "$status"
    fi

    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "error: hdiutil verify remained temporarily unavailable after $attempt attempts" >&2
      return "$status"
    fi

    pause="$backoff"
    if [ "$pause" -gt "$remaining" ]; then
      pause="$remaining"
    fi

    echo "warning: hdiutil verify was temporarily unavailable; retrying in ${pause}s (attempt $attempt, ${remaining}s of the ${deadline_seconds}s readiness window left)" >&2
    sleep "$pause"

    backoff=$((backoff * 2))
    if [ "$backoff" -gt "$max_backoff" ]; then
      backoff="$max_backoff"
    fi
  done
}
