package coturnbridge

import (
	"os"
)

// spoolFS is the spool's only path to the filesystem for writes. The real
// implementation is the OS; tests substitute one that injects errors at each
// step of the atomic-write protocol.
type spoolFS interface {
	CreateTemp(dir, pattern string) (spoolFile, error)
	Rename(oldpath, newpath string) error
	Remove(name string) error
	SyncDir(dir string) error
	OpenAppend(name string) (spoolFile, error)
}

type spoolFile interface {
	Name() string
	Chmod(os.FileMode) error
	Write([]byte) (int, error)
	Sync() error
	Close() error
}

type osFS struct{}

func (osFS) CreateTemp(dir, pattern string) (spoolFile, error) { return os.CreateTemp(dir, pattern) }
func (osFS) Rename(o, n string) error                          { return os.Rename(o, n) }
func (osFS) Remove(n string) error                             { return os.Remove(n) }
func (osFS) OpenAppend(n string) (spoolFile, error) {
	return os.OpenFile(n, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
}
func (osFS) SyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
