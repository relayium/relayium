package storage

import (
	"context"
	"io"
	"os"
	"path/filepath"
)

// DiskStore writes each object to <dir>/<key[:2]>/<key>. The two-char shard
// keeps any single directory from accumulating too many files.
type DiskStore struct{ dir string }

func NewDiskStore(dir string) (*DiskStore, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &DiskStore{dir: dir}, nil
}

func (d *DiskStore) paths(key string) (shardDir, full string) {
	shard := key
	if len(key) >= 2 {
		shard = key[:2]
	}
	shardDir = filepath.Join(d.dir, shard)
	return shardDir, filepath.Join(shardDir, key)
}

func (d *DiskStore) Put(ctx context.Context, key string, r io.Reader) (int64, error) {
	shardDir, full := d.paths(key)
	if err := os.MkdirAll(shardDir, 0o755); err != nil {
		return 0, err
	}
	// Write to a temp file in the same dir, then atomically rename, so a
	// concurrent Get never observes a half-written object.
	tmp, err := os.CreateTemp(shardDir, ".tmp-*")
	if err != nil {
		return 0, err
	}
	tmpName := tmp.Name()
	n, err := io.Copy(tmp, r)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmpName) // propagate the reader/copy error (e.g. oversize abort)
		return 0, err
	}
	if err := os.Rename(tmpName, full); err != nil {
		os.Remove(tmpName)
		return 0, err
	}
	return n, nil
}

func (d *DiskStore) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	_, full := d.paths(key)
	f, err := os.Open(full)
	if os.IsNotExist(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return f, nil
}

func (d *DiskStore) Delete(ctx context.Context, key string) error {
	_, full := d.paths(key)
	if err := os.Remove(full); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
