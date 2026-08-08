package inboxclient

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/relayium/relayium/internal/inbox"
)

// Getting from "this machine has credentials" to "this machine holds the private
// half of the key senders are wrapping to".
//
// This is the part of Device Inbox where a mistake is unrecoverable rather than
// merely annoying. Central publishes a public key and senders seal content keys
// to it; if the matching private key is not on this disk, those tasks cannot be
// opened by anybody, ever. Two rules follow, and everything below exists to keep
// them:
//
//   - PERSIST BEFORE PUBLISH. A key is durable locally before it is registered.
//   - RECONCILE, DO NOT REGENERATE. A lost registration response is repaired by
//     asking central which id it gave the key we already hold — never by minting
//     a second key, which would abandon the first and could strand tasks already
//     sealed to it.

// ErrKeyUnrecoverable means central's active key cannot be made usable here and
// the device could not rotate onto one it holds. Continuing would advertise a
// device that silently cannot decrypt anything.
var ErrKeyUnrecoverable = errors.New("relayium inbox: this device cannot use or replace the public key central holds for it")

// EnsureUsableKey makes central's ACTIVE key one this device holds the private
// half of, and returns it.
//
// current is the active key from the enrolment response (nil when there is
// none). The four cases, in the order they are tried:
//
//  1. Central's active key is in the local history — nothing to do.
//  2. Central's active key matches a local private key whose server id was never
//     recorded (the registration response was lost). Bind the id; no new key.
//  3. Central has no active key. Publish the local one, or mint one if this
//     device has never had a key.
//  4. Central's active key is NOT locally usable — a restored backup, a wiped
//     state directory, a key registered by a different installation. Rotate onto
//     a fresh key with a compare-and-swap against the current id. This is a
//     recovery, and it is honest about its cost: tasks already sealed to the old
//     key stay sealed to it and will fail to decrypt here.
func EnsureUsableKey(ctx context.Context, c *Client, ks *KeyStore, current *Key, now time.Time) (Key, error) {
	if current != nil && current.Active() {
		if _, found, err := ks.ByKeyID(current.ID); err != nil {
			return Key{}, err
		} else if found {
			return *current, nil
		}
		if rec, found, err := ks.ByPublicKey(current.PublicKey); err != nil {
			return Key{}, err
		} else if found {
			if err := ks.BindKeyID(rec.PublicKey, current.ID, current.Generation); err != nil {
				return Key{}, err
			}
			return *current, nil
		}
		// Case 4: rotate away from a key this device cannot use.
		return rotateOnto(ctx, c, ks, current.ID, now)
	}
	// Case 3: central has no active key.
	return publishLocalOrNew(ctx, c, ks, now)
}

// publishLocalOrNew registers the newest local key, or mints one first.
//
// An unpublished local record is preferred over a fresh key: it may already be
// registered under an id whose response was lost, and reconcile() finds that out
// for certain instead of guessing.
func publishLocalOrNew(ctx context.Context, c *Client, ks *KeyStore, now time.Time) (Key, error) {
	rec, found, err := ks.Latest()
	if err != nil {
		return Key{}, err
	}
	if !found {
		return mintAndRegister(ctx, c, ks, "", now)
	}
	key, err := c.RegisterKey(ctx, rec.Algorithm, rec.PublicKey, "")
	if err != nil {
		// Both of these mean central's history disagrees with ours, and the
		// truth is on central's side. Read it rather than guessing.
		if code := ErrorCode(err); code == "stale_key_rotation" || code == "device_key_reused" {
			return reconcile(ctx, c, ks, now)
		}
		return Key{}, err
	}
	if err := bindRegistered(ks, rec.PublicKey, key); err != nil {
		return Key{}, err
	}
	return key, nil
}

// rotateOnto mints a fresh key and swaps it in against previousKeyID.
func rotateOnto(ctx context.Context, c *Client, ks *KeyStore, previousKeyID string, now time.Time) (Key, error) {
	key, err := mintAndRegister(ctx, c, ks, previousKeyID, now)
	if err == nil {
		return key, nil
	}
	// The compare-and-swap lost: something rotated the key between the enrolment
	// response and now. Re-read and try once from the current truth.
	if code := ErrorCode(err); code == "stale_key_rotation" {
		return reconcile(ctx, c, ks, now)
	}
	return Key{}, err
}

// mintAndRegister generates a key, makes it durable, and only then publishes it.
//
// The ordering is invariant 2 and is the whole reason this is not two lines: if
// the process dies after Append, an unpublished private key is a recoverable
// nuisance. If it died after RegisterKey but before Append, central would be
// handing senders a public key whose private half never existed.
func mintAndRegister(ctx context.Context, c *Client, ks *KeyStore, previousKeyID string, now time.Time) (Key, error) {
	kp, err := GenerateKeyPair()
	if err != nil {
		return Key{}, err
	}
	rec, err := ks.Append(kp, now)
	if err != nil {
		return Key{}, err
	}
	key, err := c.RegisterKey(ctx, rec.Algorithm, rec.PublicKey, previousKeyID)
	if err != nil {
		return Key{}, err
	}
	if err := bindRegistered(ks, rec.PublicKey, key); err != nil {
		return Key{}, err
	}
	return key, nil
}

// bindRegistered records central's id for a key, after checking central named
// the key we actually sent. A mismatch would mean the local private key does not
// belong to the published public key, so it is refused rather than stored.
func bindRegistered(ks *KeyStore, publicKey string, key Key) error {
	if key.PublicKey != publicKey {
		return fmt.Errorf("%w: central registered a different public key than the one submitted", ErrKeyUnrecoverable)
	}
	if key.Algorithm != inbox.KeyAlgX25519SealedBoxV1 {
		return fmt.Errorf("%w: central registered algorithm %q", ErrKeyUnrecoverable, key.Algorithm)
	}
	return ks.BindKeyID(publicKey, key.ID, key.Generation)
}

// reconcile reads central's key history and repairs the local record when a
// response was lost, or rotates once when central's active key is genuinely not
// ours.
//
// It is the ONLY place a second registration attempt is made, and it is bounded:
// one read, then at most one rotation. Looping here against a server that keeps
// disagreeing would mint keys forever.
func reconcile(ctx context.Context, c *Client, ks *KeyStore, now time.Time) (Key, error) {
	keys, err := c.ListKeys(ctx)
	if err != nil {
		return Key{}, err
	}
	var active *Key
	for i := range keys {
		if keys[i].Active() {
			active = &keys[i]
			break
		}
	}
	if active == nil {
		return Key{}, fmt.Errorf("%w: central reports no active key after a rotation conflict", ErrKeyUnrecoverable)
	}
	if _, found, err := ks.ByKeyID(active.ID); err != nil {
		return Key{}, err
	} else if found {
		return *active, nil
	}
	if rec, found, err := ks.ByPublicKey(active.PublicKey); err != nil {
		return Key{}, err
	} else if found {
		if err := ks.BindKeyID(rec.PublicKey, active.ID, active.Generation); err != nil {
			return Key{}, err
		}
		return *active, nil
	}
	key, err := mintAndRegister(ctx, c, ks, active.ID, now)
	if err != nil {
		return Key{}, fmt.Errorf("%w: %v", ErrKeyUnrecoverable, err)
	}
	return key, nil
}
