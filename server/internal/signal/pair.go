package signal

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"strings"
	"sync"
	"time"
)

// codeEntry is a live pairing code's expiry plus the userID that minted it.
type codeEntry struct {
	exp   int64
	owner string // userID that owns (and is billed for) this cross-network transfer
}

// PairRegistry mints short pairing codes for realtime rendezvous. Codes
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

// MintFor returns a fresh code not colliding with a live one, bound to owner,
// plus its unix expiry. Returns ("", 0) if it could not find a free code — see
// maxMintAttempts; callers must treat that as a failure, not as a valid code.
func (p *PairRegistry) MintFor(owner string) (string, int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	// 有界重试。24^6 的空间里活码撞车的概率微乎其微，但这个循环是**持锁**跑的：
	// 一旦（因为字母表被改小、TTL 被改大、或者纯粹的 bug）空间真的被占满，无界循环
	// 会把整个注册表锁死，所有人都铸不出码也验不了码——服务不是变慢而是停摆。
	// 撞满 maxMintAttempts 次就放弃并返回失败，让调用方回一个 5xx。
	for i := 0; i < maxMintAttempts; i++ {
		code := randCode()
		if e, ok := p.codes[code]; ok && e.exp > now {
			continue // collide with a still-live code; try again
		}
		exp := now + p.ttl
		p.codes[code] = codeEntry{exp: exp, owner: owner}
		return code, exp
	}
	return "", 0
}

// 铸码时容忍的碰撞次数。10 次全撞意味着码空间已被活码填满到 ~100%，那是配置事故
// 而不是运气问题，继续重试没有意义。
const maxMintAttempts = 10

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

// CodeAlphabet is the character set pairing codes are drawn from: 16 letters
// plus the digits 2-9, 24 characters in all.
//
// Every character that can be mistaken for another one is gone, in BOTH
// directions — that is the whole point, and it is why the set cannot be extended
// casually:
//
//	B/8  G/6  S/5  Z/2  Q/O  U/V   → B G S Z Q U V dropped (8 6 5 2 kept)
//	I/1  L/1  O/0                  → I L O dropped, and 0 and 1 with them
//
// A code is read off a screen and typed on another device (or read aloud), so a
// single ambiguous glyph costs a failed join and a retry. Aural collisions
// (D/E/T/P, M/N) are knowingly accepted: the primary channels are the share link
// and the QR code.
//
// TestCodeAlphabet pins this set. Do not add characters back without redoing
// that reasoning — "0 and 1 are unambiguous now that O/I/L are gone" is true but
// was explicitly declined, to keep the set defensible on its own terms.
const CodeAlphabet = "ACDEFHJKMNPRTWXY23456789"

// CodeLen is the number of characters in a pairing code.
//
// 6 characters over a 24-character alphabet is 24^6 ≈ 1.91e8 — about 191x the
// old 6-digit space (1e6). That ratio is what makes online guessing impractical:
// the join limiter allows 30 attempts per minute per IP, so a 1000-IP botnet
// gets ~150k guesses inside the 5-minute TTL, i.e. a ~0.08% chance at any given
// code (it was ~45% before). Shortening to 5 characters divides the space by 24
// and was measured as not enough; lengthening the code was rejected on UX
// grounds. Both numbers are therefore load-bearing.
const CodeLen = 6

// randCode returns a uniformly random CodeLen-character code over CodeAlphabet.
//
// Drawn per character with crypto/rand.Int over the alphabet length, so there is
// no modulo bias — 24 does not divide 256, which is exactly the case where the
// naive `randomByte % 24` skews the first eight characters upward.
func randCode() string {
	n := big.NewInt(int64(len(CodeAlphabet)))
	b := make([]byte, CodeLen)
	for i := range b {
		k, err := rand.Int(rand.Reader, n)
		if err != nil {
			// crypto/rand failure is unrecoverable for a security-relevant code.
			panic(fmt.Sprintf("signal: crypto/rand: %v", err))
		}
		b[i] = CodeAlphabet[k.Int64()]
	}
	return string(b)
}

// ValidCodeFormat reports whether s is shaped like a pairing code. Callers use
// it to reject junk before it reaches the registry, so a guessing flood cannot
// fill logs (or a map key) with arbitrary attacker-chosen strings.
func ValidCodeFormat(s string) bool {
	if len(s) != CodeLen {
		return false
	}
	for i := 0; i < len(s); i++ {
		if !strings.ContainsRune(CodeAlphabet, rune(s[i])) {
			return false
		}
	}
	return true
}
