package storage

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// ErrInvalidKey is returned when a blob key contains characters outside the
// safe set. Callers pass unguessable random hex tokens, so a key that fails this
// check is a bug or an attack — never a legitimate object.
var ErrInvalidKey = errors.New("storage: invalid blob key")

// validKey restricts blob keys to an unambiguously safe character set. Callers
// pass unguessable random hex tokens, but excluding '/', '.' (so no '..') and
// any other separator means filepath.Join can never be steered outside the
// store directory — defense in depth even though current callers never pass
// attacker-controlled keys. A key must be non-empty.
var validKey = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// tmpPrefix marks in-progress writes; CleanupTemp reaps stale ones.
const tmpPrefix = ".tmp-"

// DiskStore writes each object to <dir>/<key[:2]>/<key>. The two-char shard
// keeps any single directory from accumulating too many files.
type DiskStore struct{ dir string }

func NewDiskStore(dir string) (*DiskStore, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
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

// UsedBytes reports the total size of the blobs this store holds, by walking
// the store directory.
//
// This is deliberately NOT storage.DiskUsage: that one reports the whole
// filesystem's occupancy (OS, logs, anything else on the volume), which is the
// wrong number to compare against a relayium-specific disk cap. A node that
// shares its volume with other software would otherwise report itself full
// while holding almost no blobs.
//
// In-progress temp files (tmpPrefix) are counted — they occupy the disk right
// now, and a cap check must see them. Entries that vanish mid-walk (a concurrent
// Delete, or a temp file renamed out from under us) are skipped rather than
// failing the whole total: a slightly stale gauge beats no gauge.
func (d *DiskStore) UsedBytes() (int64, error) {
	var total int64
	err := filepath.WalkDir(d.dir, func(_ string, e fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if e.IsDir() {
			return nil
		}
		info, ierr := e.Info()
		if ierr != nil {
			return nil // raced with a delete; skip this entry
		}
		total += info.Size()
		return nil
	})
	return total, err
}

func (d *DiskStore) Put(ctx context.Context, key string, r io.Reader) (int64, error) {
	if !validKey.MatchString(key) {
		return 0, ErrInvalidKey
	}
	shardDir, full := d.paths(key)
	if err := os.MkdirAll(shardDir, 0o700); err != nil {
		return 0, err
	}
	// Write to a temp file in the same dir, then atomically rename, so a
	// concurrent Get never observes a half-written object.
	tmp, err := os.CreateTemp(shardDir, tmpPrefix+"*")
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
	if !validKey.MatchString(key) {
		return nil, ErrInvalidKey
	}
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

func (d *DiskStore) GetRange(ctx context.Context, key string, start int64) (io.ReadCloser, error) {
	rc, err := d.Get(ctx, key)
	if err != nil {
		return nil, err
	}
	if start > 0 {
		// Get returns an *os.File, which is an io.Seeker.
		if _, err := rc.(io.Seeker).Seek(start, io.SeekStart); err != nil {
			rc.Close()
			return nil, err
		}
	}
	return rc, nil
}

func (d *DiskStore) Append(ctx context.Context, key string, offset int64, r io.Reader) (int64, error) {
	if !validKey.MatchString(key) {
		return 0, ErrInvalidKey
	}
	if offset < 0 {
		return 0, ErrOffsetMismatch
	}
	shardDir, full := d.paths(key)
	if err := os.MkdirAll(shardDir, 0o700); err != nil {
		return 0, err
	}
	f, err := os.OpenFile(full, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return 0, err
	}
	// Strict sequential append: the offset must be exactly the current end, so a
	// duplicate/stale chunk can't overwrite and a gap can't leave a hole. The
	// caller re-syncs from the returned size on a mismatch.
	if info.Size() != offset {
		return info.Size(), ErrOffsetMismatch
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return 0, err
	}
	n, err := io.Copy(f, r)
	if err != nil {
		return offset + n, err
	}
	return offset + n, nil
}

func (d *DiskStore) Delete(ctx context.Context, key string) error {
	if !validKey.MatchString(key) {
		return ErrInvalidKey
	}
	_, full := d.paths(key)
	if err := os.Remove(full); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// CleanupTemp removes orphaned ".tmp-*" files older than maxAge across every
// shard. Put writes to a temp file then renames; a crash between the two leaves
// an orphan that nothing else ever reaps. Safe to call at startup and on a
// schedule — the age guard avoids racing an in-flight Put. Returns the number of
// files removed.
func (d *DiskStore) CleanupTemp(maxAge time.Duration) (int, error) {
	cutoff := time.Now().Add(-maxAge)
	removed := 0
	shards, err := os.ReadDir(d.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	for _, shard := range shards {
		if !shard.IsDir() {
			continue
		}
		shardDir := filepath.Join(d.dir, shard.Name())
		entries, err := os.ReadDir(shardDir)
		if err != nil {
			continue // shard vanished or unreadable; skip
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasPrefix(e.Name(), tmpPrefix) {
				continue
			}
			info, err := e.Info()
			if err != nil || info.ModTime().After(cutoff) {
				continue
			}
			if os.Remove(filepath.Join(shardDir, e.Name())) == nil {
				removed++
			}
		}
	}
	return removed, nil
}
