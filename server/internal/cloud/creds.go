// Package cloud is the CLI-side client for account-bound cloud transfer:
// credential storage, device-code login, and up/down over HTTP.
package cloud

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
)

const credsFile = "credentials"

type Creds struct {
	Server       string `json:"server"`
	AccessToken  string `json:"access_token"`
	AccountEmail string `json:"account_email"`
}

func Load(configDir string) (Creds, bool, error) {
	b, err := os.ReadFile(filepath.Join(configDir, credsFile))
	if os.IsNotExist(err) {
		return Creds{}, false, nil
	}
	if err != nil {
		return Creds{}, false, err
	}
	var c Creds
	if err := json.Unmarshal(b, &c); err != nil {
		return Creds{}, false, err
	}
	return c, true, nil
}

func Save(configDir string, c Creds) error {
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return err
	}
	// MkdirAll/WriteFile only apply the mode when creating; enforce tight
	// perms unconditionally so a pre-existing dir/file (backup restore,
	// permissive umask, another tool) can't leave the token world-readable.
	if err := os.Chmod(configDir, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(configDir, credsFile)
	// Write to a fresh temp file (os.CreateTemp makes it 0600 and, being new, it
	// can't pre-exist with looser perms) then atomically rename into place.
	// WriteFile straight to `path` would, if credentials already existed
	// world-readable, hold the token bytes in that mode until the trailing Chmod.
	tmp, err := os.CreateTemp(configDir, credsFile+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath) // harmless no-op once the rename succeeds
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	// Flush before the rename: otherwise a crash shortly after can leave the
	// renamed file empty or torn on disk, i.e. a lost login.
	if err := fsyncFile(tmp); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	syncDir(configDir)
	return nil
}

// fsyncFile flushes a file to stable storage. A var so a test can inject a
// failure and prove nothing is published when the flush fails.
var fsyncFile = (*os.File).Sync

// syncDir fsyncs a directory so a rename into it is durable. Best effort:
// Windows cannot open a directory for sync, and a failure here cannot undo the
// rename that already happened.
func syncDir(dir string) {
	if runtime.GOOS == "windows" {
		return
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
}

func Clear(configDir string) error {
	err := os.Remove(filepath.Join(configDir, credsFile))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
