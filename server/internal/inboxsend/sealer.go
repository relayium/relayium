package inboxsend

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"sync/atomic"

	"golang.org/x/crypto/nacl/box"

	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/storecrypto"
)

// sealer is the ONLY holder of a send's content key (invariants N1/N2).
//
// It has no constructor from key bytes, no accessor that returns the key, and
// no method that seals at a caller-chosen seq: sealManifest() seals seq 0
// exactly once, and frame() seals seq 1, 2, … strictly in order. So within a
// process a (key, seq) pair cannot be sealed twice, and after a restart there
// is no key to seal with at all.
//
// The key is held ONLY inside closures. fmt prints a func as an address and
// never follows it, whereas it does print the bytes behind an unexported
// pointer field on some paths (a bad verb such as %s on the struct value
// dereferences it) and never calls Format on an unexported field of a parent
// struct. A struct that embeds a sealer, printed by accident with any verb,
// therefore cannot show key bytes. Format below also redacts the sealer itself.
type sealer struct {
	instance uint64
	manifest bool
	next     uint64
	spent    bool
	sealAt   func(seq uint64, pt []byte, framed bool) ([]byte, error)
	wrap     func(pub *[32]byte) ([]byte, error)
	wipe     func()
}

// sealObserver is a TEST-ONLY hook: when set, it is told every (sealer
// instance, seq) that is sealed, so a test can prove no pair repeats across
// every fault path. It never sees key material.
var sealObserver func(instance, seq uint64)

var sealerInstances atomic.Uint64

func newSealer() (*sealer, error) {
	k, err := storecrypto.GenerateKey()
	if err != nil {
		return nil, err
	}
	return &sealer{
		instance: sealerInstances.Add(1),
		next:     1,
		sealAt: func(seq uint64, pt []byte, framed bool) ([]byte, error) {
			if framed {
				return storecrypto.FrameChunk(k, seq, pt)
			}
			return storecrypto.SealManifest(k, pt)
		},
		wrap: func(pub *[32]byte) ([]byte, error) { return box.SealAnonymous(nil, k, pub, rand.Reader) },
		wipe: func() { clear(k) },
	}, nil
}

// Format redacts the sealer under every verb, so no diagnostic can print it.
func (s sealer) Format(f fmt.State, _ rune) { io.WriteString(f, "inboxsend.sealer{redacted}") }

var errSealerSpent = errors.New("inboxsend: content key already discarded")

func (s *sealer) observe(seq uint64) {
	if sealObserver != nil {
		sealObserver(s.instance, seq)
	}
}

// sealManifest seals the manifest plaintext at seq 0. Callable once.
func (s *sealer) sealManifest(pt []byte) ([]byte, error) {
	if s.spent {
		return nil, errSealerSpent
	}
	if s.manifest {
		return nil, errors.New("inboxsend: manifest already sealed under this key")
	}
	s.manifest = true
	s.observe(0)
	return s.sealAt(0, pt, false)
}

// frame seals the next plaintext chunk at the next seq and returns
// uint32BE(len)||ct.
func (s *sealer) frame(pt []byte) ([]byte, error) {
	if s.spent {
		return nil, errSealerSpent
	}
	if !s.manifest {
		return nil, errors.New("inboxsend: payload sealed before the manifest")
	}
	seq := s.next
	s.next++
	s.observe(seq)
	return s.sealAt(seq, pt, true)
}

// frames reports how many payload frames have been sealed.
func (s *sealer) frames() uint64 { return s.next - 1 }

// wrapTo seals the content key to a device public key (crypto_box_seal). This
// is NOT a nonce-bearing use of the content key: the sealed box has its own
// ephemeral key, so re-wrapping the same content key to a rotated device key
// seals no payload twice.
func (s *sealer) wrapTo(algorithm, publicKey string) (string, error) {
	if s.spent {
		return "", errSealerSpent
	}
	raw, err := inbox.ValidatePublicKey(algorithm, publicKey)
	if err != nil {
		return "", err
	}
	var pub [32]byte
	copy(pub[:], raw)
	sealed, err := s.wrap(&pub)
	if err != nil {
		return "", err
	}
	if len(sealed) != inbox.SealedBoxBytes {
		return "", errors.New("inboxsend: sealed key has the wrong length")
	}
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

// discard drops the key. Go gives no guarantee that no copy survives in memory
// (the AEAD key schedule, GC moves), so this is a best-effort overwrite plus
// making the sealer unusable — not a zeroization claim.
func (s *sealer) discard() {
	if s == nil || s.spent {
		return
	}
	s.wipe()
	s.spent = true
	s.sealAt, s.wrap, s.wipe = nil, nil, nil
}
