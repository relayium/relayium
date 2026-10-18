//go:build !unix

package account

import "os"

// checkAdminDBOwner has no portable ownership model to check off Unix.
func checkAdminDBOwner(string, os.FileInfo) error { return nil }
