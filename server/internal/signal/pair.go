package signal

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"sync"
	"time"
)

// codeEntry is a live pairing code's expiry plus the userID that minted it.
type codeEntry struct {
	exp   int64
	owner string // userID that owns (and is billed for) this cross-network transfer
}

// PairRegistry mints short numeric pairing codes for realtime rendezvous. Codes
// are in-memory only and short-lived; a code becomes a 2-peer signaling room
// "c:<code>". Each code is owned by the logged-in user that minted it. now is
// injected for tests.
type PairRegistry struct {
	mu    sync.Mutex
	codes map[string]codeEntry
	ttl   int64
	now   func() int64
}

func NewPairRegistry(ttlSeconds int64, now func() int64) *PairRegistry {
	return &PairRegistry{codes: make(map[string]codeEntry), ttl: ttlSeconds, now: now}
}

// MintFor returns a fresh 6-digit code not colliding with a live one, bound to
// owner, plus its unix expiry.
func (p *PairRegistry) MintFor(owner string) (string, int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	for {
		code := randCode()
		if e, ok := p.codes[code]; ok && e.exp > now {
			continue // collide with a still-live code; try again
		}
		exp := now + p.ttl
		p.codes[code] = codeEntry{exp: exp, owner: owner}
		return code, exp
	}
}

// OwnerOf returns the owning userID of a live code, or ("", false) if the code
// is unknown or expired.
func (p *PairRegistry) OwnerOf(code string) (string, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, ok := p.codes[code]
	if !ok || e.exp <= p.now() {
		return "", false
	}
	return e.owner, true
}

// Validate reports whether code exists and has not expired (expiry is exclusive).
func (p *PairRegistry) Validate(code string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, ok := p.codes[code]
	return ok && e.exp > p.now()
}

func (p *PairRegistry) reap() {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	for c, e := range p.codes {
		if e.exp <= now {
			delete(p.codes, c)
		}
	}
}

// Run reaps expired codes every interval until ctx is cancelled.
func (p *PairRegistry) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.reap()
		}
	}
}

// randCode returns a uniformly random 6-digit string, zero-padded (leading
// zeros allowed, e.g. "042424").
func randCode() string {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		// crypto/rand failure is unrecoverable for a security-relevant code.
		panic(fmt.Sprintf("signal: crypto/rand: %v", err))
	}
	return fmt.Sprintf("%06d", n.Int64())
}
