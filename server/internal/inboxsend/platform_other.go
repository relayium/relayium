//go:build !unix

package inboxsend

import "os"

func openRegular(path string) (*os.File, error) { return os.Open(path) }

// Windows cannot open a directory for fsync; the rename is still atomic.
const fsyncDirUnsupported = true
