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
//
// A state.json written before storageSecret existed decodes with an empty
// StorageSecret. That empty string is the blob API's bearer and the dltoken
// HMAC key, so leaving it empty means "Authorization: Bearer " (or a token
// MACed with an empty key) is accepted. Back-fill it here, persisted before the
// node serves anything; the node reports it to central on the registration
// that follows every start, which is how central learns the new secret.
func loadState(dir string) (nodeState, error) {
	b, err := os.ReadFile(statePath(dir))
	if err == nil {
		var st nodeState
		if jerr := json.Unmarshal(b, &st); jerr != nil {
			return nodeState{}, jerr
		}
		if st.StorageSecret == "" {
			sk, rerr := randomSecret()
			if rerr != nil {
				return nodeState{}, rerr
			}
			st.StorageSecret = sk
			if serr := saveState(dir, st); serr != nil {
				return nodeState{}, fmt.Errorf("persist back-filled storage secret: %w", serr)
			}
		}
		return st, nil
	}
	if !os.IsNotExist(err) {
		return nodeState{}, err
	}
	turn, rerr := randomSecret()
	if rerr != nil {
		return nodeState{}, rerr
	}
	st := nodeState{TURNSecret: turn}
	if st.StorageSecret, rerr = randomSecret(); rerr != nil {
		return nodeState{}, rerr
	}
	if serr := saveState(dir, st); serr != nil {
		return nodeState{}, serr
	}
	return st, nil
}

// randomSecret returns 32 bytes from crypto/rand, hex-encoded — the encoding
// every node secret in state.json uses.
func randomSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
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
