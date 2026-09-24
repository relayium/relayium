//go:build !unix

package inboxsend

import "errors"

func mkfifo(string) error { return errors.New("no FIFOs on this platform") }
