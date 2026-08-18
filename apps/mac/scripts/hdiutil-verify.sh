#!/bin/bash

# Retry only the macOS disk-image race observed on hosted runners. A malformed
# or corrupt image must retain hdiutil's first failure and must never be retried.
verify_hdiutil_image() {
  local image="$1"
  local attempt=1
  local max_attempts=3
  local verify_output
  local verify_status

  while true; do
    if verify_output="$(hdiutil verify "$image" 2>&1)"; then
      if [ -n "$verify_output" ]; then
        printf '%s\n' "$verify_output"
      fi
      return 0
    else
      verify_status=$?
    fi

    if [ -n "$verify_output" ]; then
      printf '%s\n' "$verify_output" >&2
    fi
    if ! printf '%s\n' "$verify_output" | grep -Fq 'Resource temporarily unavailable'; then
      return "$verify_status"
    fi
    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "error: hdiutil verify remained temporarily unavailable after $max_attempts attempts" >&2
      return "$verify_status"
    fi

    echo "warning: hdiutil verify was temporarily unavailable; retrying ($attempt/$max_attempts)" >&2
    sleep 2
    attempt=$((attempt + 1))
  done
}
