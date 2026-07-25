// Package authx holds small, stateless token/id helpers shared across
// account (open) and, eventually, the commercial layer. Every function here
// is a pure function of its arguments — no package state, no receiver.
package authx

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
)

// RandToken returns a random 32-byte token, hex-encoded.
func RandToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("authx: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// HashToken returns the hex-encoded SHA-256 of raw.
func HashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// NewID returns a random 16-byte id, hex-encoded.
func NewID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("authx: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}
