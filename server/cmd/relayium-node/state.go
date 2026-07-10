package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
)

// nodeState is the node's persistent local identity. TURNSecret is generated
// once and never leaves the box except to central over TLS at registration.
type nodeState struct {
	NodeID     string `json:"nodeID"`
	TURNSecret string `json:"turnSecret"`
}

func statePath(dir string) string { return filepath.Join(dir, "state.json") }

// loadState reads <dir>/state.json, generating and persisting a fresh state
// (new TURNSecret, empty NodeID) on first run.
func loadState(dir string) (nodeState, error) {
	b, err := os.ReadFile(statePath(dir))
	if err == nil {
		var st nodeState
		if jerr := json.Unmarshal(b, &st); jerr != nil {
			return nodeState{}, jerr
		}
		return st, nil
	}
	if !os.IsNotExist(err) {
		return nodeState{}, err
	}
	secret := make([]byte, 32)
	if _, rerr := rand.Read(secret); rerr != nil {
		return nodeState{}, rerr
	}
	st := nodeState{TURNSecret: hex.EncodeToString(secret)}
	if serr := saveState(dir, st); serr != nil {
		return nodeState{}, serr
	}
	return st, nil
}

// saveState atomically writes <dir>/state.json with 0600 perms.
func saveState(dir string, st nodeState) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := statePath(dir) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, statePath(dir))
}
