package inboxclient

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Persistent Device Inbox configuration.
//
// This is the local half of the PRD §8 permission model. Automatic receive is
// DEFAULT OFF and becomes true only through `relayium inbox enable --dir`, which
// requires the user to name a real, writable destination. Nothing here can be
// reached by a sender, a capability link, or a task: it is state the machine's
// own operator wrote.
//
// PAUSE IS NOT DISABLE. Paused is local scheduling state — "stop taking work for
// now" — and leaves the enrolment, the keys and the queued tasks intact, so
// resuming needs no server round trip and loses nothing. Disable is the
// destructive, server-confirmed teardown (see Config.Enabled and
// KeyStore.Destroy). Collapsing the two would make an operator's temporary stop
// silently revoke keys and terminate queued deliveries.

const configFile = "config.json"

// configVersion is refused rather than upgraded on mismatch, for the same reason
// as the key store: silently reinterpreting an unknown layout risks acting on a
// misread receive directory.
const configVersion = 1

// Config is what `enable`, `pause`, `resume` and `disable` persist and the
// worker reads. It holds no secret: the bearer token stays in the existing
// credentials file, and private keys stay in keys.json.
type Config struct {
	Version int `json:"version"`
	// DeviceID is the row this machine's bearer authenticates as, cached at
	// enable time so `status` can be honest while offline. It is re-checked
	// against central on every worker start; a mismatch (a re-login minted a new
	// device) fails closed rather than acting on a stale id.
	DeviceID string `json:"deviceId"`
	// Server is the account server the enrolment belongs to. Self-hosting is
	// supported, so this is compared against the credential's server and a
	// mismatch is refused rather than silently retargeted.
	Server string `json:"server"`
	// Dir is the fixed receive directory, stored fully resolved (absolute, with
	// symlinks evaluated) so a later swap of a symlinked ancestor cannot silently
	// redirect where files land.
	Dir string `json:"dir"`
	// Enabled is the explicit opt-in. False means the worker refuses to run and
	// no task will ever be written to disk by this machine.
	Enabled bool `json:"enabled"`
	// Paused suspends claiming and presence without touching the server state.
	Paused bool `json:"paused"`
	// AutoAccept is the policy announced to central: `auto` for an enabled
	// device. Recorded locally so `status` can report what this machine asked
	// for even when central is unreachable.
	AutoAccept string `json:"autoAccept"`
	EnabledAt  int64  `json:"enabledAt"`
	UpdatedAt  int64  `json:"updatedAt"`
}

// Store is the local state directory for the Device Inbox, normally
// <configDir>/inbox. It owns the configuration, the private-key history, the
// per-task journals and the worker lock.
type Store struct{ dir string }

// NewStore roots a Store at dir.
func NewStore(dir string) *Store { return &Store{dir: dir} }

// StoreDir returns the Device Inbox state directory inside a CLI config dir.
func StoreDir(configDir string) string { return filepath.Join(configDir, "inbox") }

// Dir returns the state directory path.
func (s *Store) Dir() string { return s.dir }

// Keys returns the private-key history store.
func (s *Store) Keys() *KeyStore { return NewKeyStore(s.dir) }

// Journals returns the per-task crash-journal store.
func (s *Store) Journals() *JournalStore { return NewJournalStore(filepath.Join(s.dir, "tasks")) }

// LockPath is the file whose exclusive lock marks a running worker.
func (s *Store) LockPath() string { return filepath.Join(s.dir, "worker.lock") }

func (s *Store) configPath() string { return filepath.Join(s.dir, configFile) }

// LoadConfig reads the configuration. found is false for a device that has never
// enabled the inbox, which is a legitimate state every command must handle
// rather than an error.
func (s *Store) LoadConfig() (cfg Config, found bool, err error) {
	b, rerr := os.ReadFile(s.configPath())
	if errors.Is(rerr, os.ErrNotExist) {
		return Config{}, false, nil
	}
	if rerr != nil {
		return Config{}, false, rerr
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return Config{}, false, fmt.Errorf("relayium inbox: configuration is unreadable: %w", err)
	}
	if cfg.Version != configVersion {
		return Config{}, false, fmt.Errorf("relayium inbox: configuration is version %d, this build understands %d", cfg.Version, configVersion)
	}
	return cfg, true, nil
}

// SaveConfig atomically replaces the configuration at 0600.
func (s *Store) SaveConfig(cfg Config, now time.Time) error {
	cfg.Version = configVersion
	cfg.UpdatedAt = now.Unix()
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return writeSecretFile(s.configPath(), b)
}

// ClearConfig removes the configuration entirely, used by `disable` once the
// server side is confirmed cleared.
func (s *Store) ClearConfig() error {
	err := os.Remove(s.configPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return fsyncDir(s.dir)
}

// Ensure creates the state directory with 0700.
func (s *Store) Ensure() error { return ensureSecretDir(s.dir) }
