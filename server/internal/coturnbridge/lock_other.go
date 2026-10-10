//go:build !unix

package coturnbridge

import (
	"errors"
	"os"
)

// lockDir: the spool lock needs flock; there is no unlocked fallback.
func lockDir(string) (*os.File, error) {
	return nil, errors.New("coturnbridge: the spool lock is only supported on unix")
}
