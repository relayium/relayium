//go:build !(darwin || linux)

package inboxsend

import "errors"

// spoolSupported is false here: this platform has no free-space query wired
// up, so `inbox send --resumable` is refused before anything is encrypted
// rather than spooling without that guarantee.
const spoolSupported = false

var errSpoolUnsupported = errors.New("not available on this platform")

var freeDiskBytes = func(string) (uint64, error) { return 0, errSpoolUnsupported }
