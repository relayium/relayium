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
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(configDir, credsFile), b, 0o600)
}

func Clear(configDir string) error {
	err := os.Remove(filepath.Join(configDir, credsFile))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
