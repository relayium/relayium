package cloud

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

var ErrInstallationUnsafe = errors.New("CLI installation identity is unsafe or malformed; left untouched")

// InstallationID returns a private, per-server random hint retained across
// logout. It authenticates nothing. Only an approved login can rotate a bearer.
func InstallationID(configDir, server string) (string, error) {
	if err := checkSecureServer(server); err != nil {
		return "", err
	}
	u, err := url.Parse(server)
	if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("invalid installation server URL")
	}
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)
	u.Path = strings.TrimRight(u.Path, "/")
	sum := sha256.Sum256([]byte(u.String()))
	dir := filepath.Join(configDir, "cli-installations")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !ownedPrivately(info) {
		return "", ErrInstallationUnsafe
	}
	path := filepath.Join(dir, hex.EncodeToString(sum[:]))
	id, err := readInstallationID(path)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	id = base64.RawURLEncoding.EncodeToString(raw[:])
	f, err := os.CreateTemp(dir, ".identity-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	if _, err := io.WriteString(f, id); err != nil {
		f.Close()
		return "", err
	}
	if err := fsyncFile(f); err != nil {
		f.Close()
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	// Atomic no-clobber publication. Concurrent creators read the winner; a
	// partially written identity is never visible and no winner is overwritten.
	if err := os.Link(f.Name(), path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return readInstallationID(path)
		}
		return "", err
	}
	syncDir(dir)
	return id, nil
}

func readInstallationID(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || !ownedPrivately(info) {
		return "", ErrInstallationUnsafe
	}
	f, err := openNoFollow(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !os.SameFile(st, info) {
		return "", ErrInstallationUnsafe
	}
	b, err := io.ReadAll(io.LimitReader(f, 44))
	if err != nil {
		return "", err
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(string(b))
	if len(b) != 43 || err != nil || len(raw) != 32 {
		return "", ErrInstallationUnsafe
	}
	return string(b), nil
}

// LockLogin serializes approval and credential publication across processes.
// The caller rechecks the credential after taking the kernel-released lock.
func LockLogin(configDir string) (*UpLock, error) {
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(configDir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, ErrInstallationUnsafe
	}
	// Match credential Save: an explicitly chosen existing directory is
	// tightened before any login state is published. Symlink roots refuse.
	if err := os.Chmod(configDir, 0o700); err != nil {
		return nil, err
	}
	info, err = os.Lstat(configDir)
	if err != nil {
		return nil, err
	}
	if !ownedPrivately(info) {
		return nil, ErrInstallationUnsafe
	}
	return lockFile(filepath.Join(configDir, "login.lock"))
}
