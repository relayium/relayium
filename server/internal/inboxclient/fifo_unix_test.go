//go:build unix

package inboxclient

import "syscall"

// makeFIFO creates a named pipe, the cheapest special file to plant in a test.
// A FIFO is the sharpest of the "not a regular file" cases: opening one for
// writing BLOCKS until a reader appears, so a receiver that opened path
// components without checking their type would hang forever rather than fail.
func makeFIFO(path string) error { return syscall.Mkfifo(path, 0o600) }
