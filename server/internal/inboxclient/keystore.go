package inboxclient

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/relayium/relayium/internal/inbox"
)

// The device's X25519 private-key history.
//
// WHY A HISTORY AND NOT A KEY. Central binds a task to the key it was sealed to
// at creation time (protocol doc §11.4). A rotation therefore does not
// invalidate work already queued: the superseded key is still the only thing
// that can open those tasks. Keeping just "the current key" would silently
// strand every task queued before the last rotation — the exact failure PRD
// §16.2 asks about. Records are retained by SERVER key id and generation so a
// claim naming TargetKeyID resolves to the right private key with no guessing.
//
// WHY THE RECORD IS WRITTEN BEFORE THE KEY IS PUBLISHED. Append() returns only
// once the private key is durably on disk (invariant 2). If registration then
// fails, or its response is lost, the worst case is an unpublished local key —
// recoverable. The reverse order's worst case is a published public key whose
// private half never reached the disk, which makes every task sealed to it
// permanently undecryptable, by anybody, forever.

const keysFile = "keys.json"

// keyStoreVersion is bumped only for an incompatible on-disk change. An unknown
// version is refused rather than parsed optimistically: guessing at a future
// format could mean writing a file that a newer build treats as authoritative
// while it is missing keys.
const keyStoreVersion = 1

// maxKeyHistory bounds the retained history. Rotations are rare (a fresh key is
// minted only on enable, or when the server's current key is not locally
// usable), and a task cannot outlive the ciphertext it references — bounded by
// the account's plan retention, which is measured in days. Sixty-four
// generations is therefore far beyond any decryptable window while still keeping
// the file bounded.
const maxKeyHistory = 64

// KeyRecord is one generation of device key material. PrivateKey is a local
// secret: it is written only through writeSecretFile and is never logged,
// printed, or sent anywhere.
type KeyRecord struct {
	// KeyID is central's id for this key. It is EMPTY between Append and the
	// registration response — that window is exactly what BindKeyID reconciles.
	KeyID      string `json:"keyId"`
	Generation int64  `json:"generation"`
	Algorithm  string `json:"algorithm"`
	PublicKey  string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`
	CreatedAt  int64  `json:"createdAt"`
}

// Published reports whether central has acknowledged this key.
func (r KeyRecord) Published() bool { return r.KeyID != "" }

type keyFile struct {
	Version int         `json:"version"`
	Keys    []KeyRecord `json:"keys"` // newest last
}

// KeyStore is the on-disk private-key history in dir (0700).
//
// Concurrency: every mutation is a read-modify-atomic-replace of one file. The
// foreground worker holds the process lock (see lock.go) and the one-shot
// commands run to completion, so there is no supported configuration in which
// two writers race. A future concurrent writer would lose an append, not corrupt
// the file.
type KeyStore struct{ dir string }

// NewKeyStore returns the store rooted at dir. The directory is created on the
// first write, not here, so a read-only command never materialises state.
func NewKeyStore(dir string) *KeyStore { return &KeyStore{dir: dir} }

func (s *KeyStore) path() string { return filepath.Join(s.dir, keysFile) }

// Load returns the retained history, oldest first. A missing file is an empty
// history, not an error: that is a device that has never enrolled.
func (s *KeyStore) Load() ([]KeyRecord, error) {
	b, err := os.ReadFile(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var f keyFile
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("relayium inbox: device key history is unreadable: %w", err)
	}
	if f.Version != keyStoreVersion {
		return nil, fmt.Errorf("relayium inbox: device key history is version %d, this build understands %d", f.Version, keyStoreVersion)
	}
	return f.Keys, nil
}

func (s *KeyStore) save(keys []KeyRecord) error {
	if len(keys) > maxKeyHistory {
		keys = keys[len(keys)-maxKeyHistory:]
	}
	b, err := json.MarshalIndent(keyFile{Version: keyStoreVersion, Keys: keys}, "", "  ")
	if err != nil {
		return err
	}
	return writeSecretFile(s.path(), b)
}

// Append durably records a newly generated key BEFORE it is published, and
// returns the stored record. The returned record has no KeyID yet; call
// BindKeyID once central names it.
//
// Appending a public key that is already present is refused: re-registering an
// existing key is a downgrade, not a rotation, and central refuses it too
// (`device_key_reused`). Catching it locally keeps the history and central's in
// agreement even when a caller retries badly.
func (s *KeyStore) Append(kp KeyPair, now time.Time) (KeyRecord, error) {
	keys, err := s.Load()
	if err != nil {
		return KeyRecord{}, err
	}
	pub := EncodeKeyBytes(kp.Public[:])
	for _, k := range keys {
		if k.PublicKey == pub {
			return KeyRecord{}, fmt.Errorf("relayium inbox: refusing to re-append a key already in this device's history")
		}
	}
	rec := KeyRecord{
		Algorithm:  inbox.KeyAlgX25519SealedBoxV1,
		PublicKey:  pub,
		PrivateKey: EncodeKeyBytes(kp.Private[:]),
		CreatedAt:  now.Unix(),
	}
	if err := s.save(append(keys, rec)); err != nil {
		return KeyRecord{}, err
	}
	return rec, nil
}

// BindKeyID records the id and generation central assigned to an already-durable
// key. Idempotent, so a retried registration that converges on the same key
// (central returns the existing row unchanged) does not fork the history.
func (s *KeyStore) BindKeyID(publicKey, keyID string, generation int64) error {
	keys, err := s.Load()
	if err != nil {
		return err
	}
	found := false
	for i := range keys {
		if keys[i].PublicKey == publicKey {
			keys[i].KeyID = keyID
			keys[i].Generation = generation
			found = true
			continue
		}
		// Two records must never claim one server key id: that would make
		// ByKeyID ambiguous and could hand the wrong private key to an unseal.
		if keys[i].KeyID == keyID {
			return fmt.Errorf("relayium inbox: key id already bound to a different local key")
		}
	}
	if !found {
		return fmt.Errorf("relayium inbox: no local private key matches the registered public key")
	}
	return s.save(keys)
}

// ByKeyID resolves the private key a task names. A task sealed to a key this
// device does not hold cannot be decrypted here at all, which the caller must
// report rather than retry.
func (s *KeyStore) ByKeyID(keyID string) (KeyPair, bool, error) {
	keys, err := s.Load()
	if err != nil {
		return KeyPair{}, false, err
	}
	for _, k := range keys {
		if k.KeyID != "" && k.KeyID == keyID {
			kp, err := k.pair()
			return kp, err == nil, err
		}
	}
	return KeyPair{}, false, nil
}

// ByPublicKey resolves a record by its published public key. This is the
// reconciliation path after a lost registration response: the private key is
// already durable, so the device asks central which id it gave that public key
// instead of minting a second one.
func (s *KeyStore) ByPublicKey(publicKey string) (KeyRecord, bool, error) {
	keys, err := s.Load()
	if err != nil {
		return KeyRecord{}, false, err
	}
	for _, k := range keys {
		if k.PublicKey == publicKey {
			return k, true, nil
		}
	}
	return KeyRecord{}, false, nil
}

// Latest returns the newest record, published or not.
func (s *KeyStore) Latest() (KeyRecord, bool, error) {
	keys, err := s.Load()
	if err != nil || len(keys) == 0 {
		return KeyRecord{}, false, err
	}
	return keys[len(keys)-1], true, nil
}

// pair decodes a record's key material.
func (r KeyRecord) pair() (KeyPair, error) {
	var kp KeyPair
	priv, err := DecodeKeyBytes(r.PrivateKey, 32)
	if err != nil {
		return KeyPair{}, err
	}
	pub, err := DecodeKeyBytes(r.PublicKey, inbox.X25519PublicKeyBytes)
	if err != nil {
		return KeyPair{}, err
	}
	copy(kp.Private[:], priv)
	copy(kp.Public[:], pub)
	return kp, nil
}

// Destroy removes the private-key history.
//
// Only `relayium inbox disable` calls this, and only AFTER central has confirmed
// the enrolment (and with it the published keys and every unfinished task) is
// cleared. Doing it in the other order would destroy the only thing that can
// decrypt tasks still queued server-side, turning a reversible "turn it off"
// into silent, permanent data loss for files already in flight.
func (s *KeyStore) Destroy() error {
	err := os.Remove(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return fsyncDir(s.dir)
}
