//go:build windows

package storage

// flushDir is a no-op on Windows: os.Open gives a GENERIC_READ directory
// handle and FlushFileBuffers on it fails with Access is denied, which would
// fail every blob creation. NTFS journals directory metadata, and this
// package does not ship on Windows; only the Windows acceptance fixture
// builds it.
func flushDir(string) error { return nil }
