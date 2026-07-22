package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// nodeState is the node's persistent local identity. TURNSecret is generated
// once and never leaves the box except to central over TLS at registration.
type nodeState struct {
	NodeID        string `json:"nodeID"`
	TURNSecret    string `json:"turnSecret"`
	StorageSecret string `json:"storageSecret"`
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
	sk := make([]byte, 32)
	if _, rerr := rand.Read(sk); rerr != nil {
		return nodeState{}, rerr
	}
	st.StorageSecret = hex.EncodeToString(sk)
	if serr := saveState(dir, st); serr != nil {
		return nodeState{}, serr
	}
	return st, nil
}

// loadStateReadOnly reads <dir>/state.json without ever creating anything.
// Unlike loadState (used by the node process itself, which legitimately
// bootstraps a fresh identity on first run), the root-run `update` subcommand
// must never conjure state.json into existence: the node runs as an
// unprivileged service user while `update` runs as root, so persisting a
// missing file here would leave a root-owned state.json (and possibly a
// root-owned state dir, via saveState's MkdirAll) that the node itself can
// never read — silently turning a benign polling failure (no state yet, or a
// mistyped -state-dir) into a bricked node. A missing file is reported as a
// distinct, loud error instead: "this node is not registered yet", not an
// update failure.
func loadStateReadOnly(dir string) (nodeState, error) {
	b, err := os.ReadFile(statePath(dir))
	if err != nil {
		if os.IsNotExist(err) {
			return nodeState{}, fmt.Errorf("no state.json in %s: this node is not registered yet", dir)
		}
		return nodeState{}, err
	}
	var st nodeState
	if err := json.Unmarshal(b, &st); err != nil {
		return nodeState{}, err
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
