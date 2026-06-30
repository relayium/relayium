package signal

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"sync"
	"time"
)

// PairRegistry mints short numeric pairing codes for anonymous, login-free
// realtime rendezvous. Codes are in-memory only (no DB) and short-lived; a code
// becomes a 2-peer signaling room "c:<code>". now is injected for tests.
type PairRegistry struct {
	mu    sync.Mutex
	codes map[string]int64 // code -> unix expiry
	ttl   int64
	now   func() int64
}

func NewPairRegistry(ttlSeconds int64, now func() int64) *PairRegistry {
	return &PairRegistry{codes: make(map[string]int64), ttl: ttlSeconds, now: now}
}

// Mint returns a fresh 6-digit code not currently colliding with a live one,
// plus its unix expiry.
func (p *PairRegistry) Mint() (string, int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	for {
		code := randCode()
		if exp, ok := p.codes[code]; ok && exp > now {
			continue // collide with a still-live code; try again
		}
		exp := now + p.ttl
		p.codes[code] = exp
		return code, exp
	}
}

// Validate reports whether code exists and has not expired (expiry is exclusive).
func (p *PairRegistry) Validate(code string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	exp, ok := p.codes[code]
	return ok && exp > p.now()
}

func (p *PairRegistry) reap() {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	for c, exp := range p.codes {
		if exp <= now {
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
