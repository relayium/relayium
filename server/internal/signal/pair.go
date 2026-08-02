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
// gets ~900k guesses inside the 30-minute TTL, i.e. a ~0.47% chance at any given
// code (it was ~45% with 6 digits, and ~0.08% back when the TTL was 5 minutes —
// see CodeTTLSeconds for why that window was widened and what still bounds it).
// Shortening to 5 characters divides the space by 24 and was measured as not
// enough; lengthening the code was rejected on UX grounds. Both numbers are
// therefore load-bearing, and CodeLen is the cheap dial if this probability
// ever needs to come back down.
const CodeLen = 6

// CodeTTLSeconds is how long a minted pairing code stays valid — the value
// main.go hands NewPairRegistry, and the one the CLI's error copy quotes.
//
// It is exported for the same reason CodeLen and CodeAlphabet are: the CLI
// tells the user what a code is ("6 characters from …, and last 30 minutes")
// and every one of those numbers has to come from the same place as the
// behaviour, or the copy goes stale the first time the value moves. It was a
// bare 300 at the NewPairRegistry call site with the "5 minutes" typed out by
// hand in three separate strings.
//
// **这个 TTL 管的是"码还能不能用来会合"，不是一次传输能活多久。** 码只在 RoomFor
// 里被查一次（建立 WebSocket 的时候）；之后房间、信令、WebRTC 连接和正在传的文件
// 都不再看它，过期不会打断任何已经连上的会话。TURN 凭据另有自己的有效期。
//
// 30 分钟（原为 5 分钟）：5 分钟不够读码、挑文件、授权、两边来回沟通，而过期之后的
// 表现（连不上）和真正的连接故障长得一样。
//
// 代价是真实的：码空间 24^6 ≈ 1.91e8，/ws 加入限流 30 次/分钟/IP，窗口拉长 6 倍后
// 1000 IP 僵尸网络命中某个特定活码的概率从 ~0.08% 升到 ~0.47%。可接受是因为限流不是
// 唯一的闸：GuessBreaker 会整体甩掉持续爆破；猜中只换来会合权和一份记在码主人账上的
// TURN 凭据，拿不到明文（commit-reveal + SAS）；跨网自动发送还要码主人按一次确认。
// 要再压这个概率，加长 CodeLen 比缩短 TTL 便宜得多——多一个字符就是除以 24。
const CodeTTLSeconds int64 = 1800

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
