package coturnbridge

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"syscall"
)

// faultFS is the OS with injectable failures at each step of the spool's
// write protocol. A rule fails op when match(path) is true; path is the temp
// file for create/chmod/write/sync/close, the target for rename, the file for
// remove/append, the directory for syncdir. Safe for concurrent use.
type faultFS struct {
	mu    sync.Mutex
	rules map[string]func(string) bool
	hits  map[string]int
}

var errInjected = &os.PathError{Op: "injected", Path: "-", Err: syscall.EIO}

func newFaultFS() *faultFS {
	return &faultFS{rules: map[string]func(string) bool{}, hits: map[string]int{}}
}

func (f *faultFS) fail(op string, match func(string) bool) {
	f.mu.Lock()
	f.rules[op] = match
	f.mu.Unlock()
}

func (f *faultFS) clear() {
	f.mu.Lock()
	f.rules = map[string]func(string) bool{}
	f.mu.Unlock()
}

func (f *faultFS) hit(op string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hits[op]
}

func (f *faultFS) check(op, path string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if m, ok := f.rules[op]; ok && (m == nil || m(path)) {
		f.hits[op]++
		return errInjected
	}
	return nil
}

func (f *faultFS) CreateTemp(dir, pattern string) (spoolFile, error) {
	if err := f.check("create", filepath.Join(dir, pattern)); err != nil {
		return nil, err
	}
	of, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return nil, err
	}
	return &faultFile{File: of, fs: f}, nil
}

func (f *faultFS) Rename(o, n string) error {
	if err := f.check("rename", n); err != nil {
		return err
	}
	return os.Rename(o, n)
}

func (f *faultFS) Remove(n string) error {
	if err := f.check("remove", n); err != nil {
		return err
	}
	return os.Remove(n)
}

func (f *faultFS) SyncDir(dir string) error {
	if err := f.check("syncdir", dir); err != nil {
		return err
	}
	return osFS{}.SyncDir(dir)
}

func (f *faultFS) OpenAppend(n string) (spoolFile, error) {
	if err := f.check("append", n); err != nil {
		return nil, err
	}
	of, err := osFS{}.OpenAppend(n)
	if err != nil {
		return nil, err
	}
	return &faultFile{File: of.(*os.File), fs: f}, nil
}

type faultFile struct {
	*os.File
	fs *faultFS
}

func (x *faultFile) Chmod(m os.FileMode) error {
	if err := x.fs.check("chmod", x.Name()); err != nil {
		return err
	}
	return x.File.Chmod(m)
}

func (x *faultFile) Write(b []byte) (int, error) {
	if err := x.fs.check("write", x.Name()); err != nil {
		return 0, err
	}
	return x.File.Write(b)
}

func (x *faultFile) Sync() error {
	if err := x.fs.check("sync", x.Name()); err != nil {
		return err
	}
	return x.File.Sync()
}

func (x *faultFile) Close() error {
	err := x.File.Close()
	if ferr := x.fs.check("close", x.Name()); ferr != nil && err == nil {
		return ferr
	}
	return err
}

// isInjected reports whether err is the injected fault.
func isInjected(err error) bool { return errors.Is(err, syscall.EIO) }
