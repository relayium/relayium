// Package cloud is the CLI-side client for account-bound cloud transfer:
// credential storage, device-code login, and up/down over HTTP.
package cloud

import (
	"encoding/json"
	"os"
	"path/filepath"
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
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func Clear(configDir string) error {
	err := os.Remove(filepath.Join(configDir, credsFile))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
