package xfer

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/relayium/relayium/internal/inboxsend/sendlock"
)

// Tiny files use the normal atomic staging path. Spending extra filesystem
// operations on checkpoints for them can cost more than retransmitting them.
const minSyncCheckpointSize = 1 << 20

// A receiver keeps one in-flight checkpoint for an authorized sender and
// destination. It lives outside the manifest's filesystem namespace.
type syncCheckpoint struct {
	dir    string
	root   *os.Root
	lock   *sendlock.Lock
	active string
}

func openSyncCheckpoint(configDir, peer, destDir string, m Manifest) (*syncCheckpoint, error) {
	if configDir == "" || peer == "" {
		return nil, nil
	}
	var needed bool
	for _, f := range m.Files {
		if f.Size >= minSyncCheckpointSize {
			needed = true
			break
		}
	}
	if !needed {
		return nil, nil
	}
	base, err := filepath.Abs(destDir)
	if err != nil {
		return nil, err
	}
	base, err = filepath.EvalSymlinks(base)
	if err != nil {
		return nil, err
	}
	key := sha256.Sum256([]byte(peer + "\x00" + destKey(base)))
	dir := filepath.Join(configDir, "sync-"+hex.EncodeToString(key[:]))
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("sync checkpoint path is not a directory")
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	c := &syncCheckpoint{dir: dir, root: root}
	f, err := root.OpenFile("lock", os.O_CREATE|os.O_RDWR|oNoFollow, 0o600)
	if err != nil {
		c.close()
		return nil, err
	}
	c.lock, err = sendlock.AcquireFile(f)
	if err != nil {
		c.close()
		return nil, err
	}
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		c.close()
		return nil, err
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".part") && validDigest(strings.TrimSuffix(entry.Name(), ".part")) && entry.Type().IsRegular() {
			c.active = entry.Name()
			break
		}
	}
	return c, nil
}

func (c *syncCheckpoint) close() {
	if c != nil {
		c.lock.Release()
		_ = c.root.Close()
	}
}

func checkpointName(f FileEntry) string {
	key := sha256.Sum256([]byte(f.Path + "\x00" + f.SHA256))
	return hex.EncodeToString(key[:]) + ".part"
}

func (c *syncCheckpoint) offer(m Manifest, rs *ResumeState) int {
	if c == nil || c.active == "" {
		return -1
	}
	info, err := c.root.Lstat(c.active)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		return -1
	}
	for i, f := range m.Files {
		if f.Size < info.Size() || f.Size < minSyncCheckpointSize || checkpointName(f) != c.active {
			continue
		}
		for _, index := range rs.Skip {
			if index == i {
				_ = c.discard()
				return -1
			}
		}
		for j, entry := range rs.Entries {
			if entry.Index == i {
				rs.Entries[j].Have = info.Size()
				return i
			}
		}
		rs.Entries = append(rs.Entries, ResumeEntry{Index: i, Have: info.Size()})
		return i
	}
	return -1
}

func (c *syncCheckpoint) discard() error {
	if c.active == "" {
		return nil
	}
	err := c.root.Remove(c.active)
	if err == nil || errors.Is(err, os.ErrNotExist) {
		c.active = ""
		return nil
	}
	return err
}

func (c *syncCheckpoint) write(body io.Reader, f FileEntry, prefix string, offset int64,
	progress func(path string, received, total int64)) (string, error) {
	name := checkpointName(f)
	if c.active != name {
		if err := c.discard(); err != nil {
			return "", err
		}
		c.active = name
	}
	out, err := c.root.OpenFile(name, os.O_CREATE|os.O_RDWR|oNoFollow, 0o600)
	if err != nil {
		return "", err
	}
	defer out.Close()
	info, err := out.Stat()
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("sync checkpoint is not a regular file")
	}
	inside := offset > 0 && prefix == filepath.Join(c.dir, name)
	if inside && offset > info.Size() {
		return "", errors.New("sync checkpoint became shorter")
	}
	size := int64(0)
	if inside {
		size = offset
	}
	if err := out.Truncate(size); err != nil {
		return "", err
	}
	hash := sha256.New()
	if inside {
		if _, err := io.CopyN(hash, out, offset); err != nil {
			return "", err
		}
	} else if offset > 0 {
		in, err := os.OpenFile(prefix, os.O_RDONLY|oNoFollow, 0)
		if err != nil {
			return "", err
		}
		_, err = io.CopyN(io.MultiWriter(out, hash), in, offset)
		_ = in.Close()
		if err != nil {
			return "", err
		}
	}
	writer := io.MultiWriter(out, hash)
	if progress != nil {
		writer = io.MultiWriter(writer, &recvProgress{fn: progress, path: f.Path, received: offset, total: f.Size})
	}
	_, copyErr := io.CopyN(writer, body, f.Size-offset)
	if err := out.Sync(); err != nil {
		return "", err
	}
	if copyErr != nil {
		return "", copyErr
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func (c *syncCheckpoint) install(base, dest string, f FileEntry) error {
	if info, err := os.Lstat(dest); err == nil && !info.Mode().IsRegular() {
		return errors.New("sync destination is not a regular file")
	}
	dir := filepath.Dir(dest)
	if err := mkdirAllWithin(base, dir); err != nil {
		return err
	}
	if err := ensureWithin(base, dir); err != nil {
		return err
	}
	if err := c.root.Chmod(c.active, os.FileMode(f.Mode)&os.ModePerm); err != nil {
		return err
	}
	src := filepath.Join(c.dir, c.active)
	err := os.Rename(src, dest)
	if err == nil {
		c.active = ""
		return nil
	}
	_ = c.root.Chmod(c.active, 0o600)
	if !errors.Is(err, syscall.EXDEV) {
		return err
	}
	// Separate volumes still get an atomic install on the destination volume.
	in, err := c.root.Open(c.active)
	if err != nil {
		return err
	}
	stagedSum, staged, err := writeFileBody(in, base, dest, f, 0, nil)
	_ = in.Close()
	if err != nil {
		return err
	}
	defer os.Remove(staged)
	if stagedSum != f.SHA256 {
		return errors.New("checkpoint no longer matches the source digest")
	}
	if err := installStaged(staged, dest, true); err != nil {
		return err
	}
	_ = c.discard()
	return nil
}
