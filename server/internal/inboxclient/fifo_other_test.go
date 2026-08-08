//go:build !unix

package inboxclient

import "errors"

// makeFIFO has no portable equivalent here; the FIFO case is skipped.
func makeFIFO(path string) error { return errors.New("named pipes are not available on this platform") }
