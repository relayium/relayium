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
	// 有界重试。10^6 的空间比原来的 24^6 小得多，撞车不再是「微乎其微」而是「按活码
	// 数量线性上升」：1 万枚活码时单次碰撞约 1%，10 次全撞约 1e-20，仍然可以忽略。
	// 但这个循环是**持锁**跑的：一旦空间真的被占满，无界循环会把整个注册表锁死，
	// 所有人都铸不出码也验不了码——服务不是变慢而是停摆。
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

// CodeAlphabet is the character set pairing codes are drawn from: the ten
// decimal digits, nothing else.
//
// This is a deliberate reversal. The set used to be 24 characters
// ("ACDEFHJKMNPRTWXY23456789") chosen so that no two glyphs could be confused —
// B/8, G/6, S/5, Z/2, Q/O, U/V, I/L/1, O/0 each kept at most one member. That
// bought entropy (24^6 ≈ 1.91e8 against 10^6) and cost every other property a
// pairing code actually needs:
//
//   - On a phone — the single most common receiving device — a mixed
//     alphanumeric field opens the letter keyboard. Six digits open the numeric
//     keypad, which is the difference between a two-hand typing task and a
//     one-thumb one.
//   - Read aloud over a call (the channel the docs recommend for passing a code
//     out of band), "ACDEFHJKMNPRTWXY" has aural collisions the visual rules
//     never addressed: D/E/T/P and M/N. Digit names are markedly better on this
//     axis, though "no collisions at all" would be too strong a claim to make
//     for all nine shipped languages and every accent in them — English
//     five/nine over a poor line is the obvious counterexample. The point is
//     that ten digit names are far easier to disambiguate over voice than
//     sixteen letter names, not that they are perfect.
//   - "Which characters are excluded" is itself a thing users had to be told,
//     in every locale, on every surface. "Six digits" needs no explanation.
//
// What the lost entropy is traded against is not another alphabet but the two
// gates around the code: a 5-minute TTL (CodeTTLSeconds) and a ~5/min/IP join
// limiter. The global GuessBreaker is not a third gate of that kind — it sheds
// invalid-attempt load, it does not bound how many codes an attacker spread
// across many addresses can try. See CodeLen for the arithmetic and for what a
// hit actually buys.
//
// TestCodeAlphabet pins this set to exactly "0123456789". Removing 0 or 1 to
// revive the old O/I reasoning would silently make some server-issued codes
// untypable on clients that kept the digit keypad, so it is a test failure and
// not a judgement call.
const CodeAlphabet = "0123456789"

// CodeLen is the number of characters in a pairing code.
//
// 6 digits is 10^6 = 1e6 live-code space. That is small, and the gate that
// actually bounds guessing against it is the per-IP one:
//
//	shared distinct-code budget  ~5 codes/min/IP  across /ws AND /api/ice
//	                                              (CodeGuessLimiter)
//	per-endpoint request caps    ~5 req/min/IP    on each of /ws and /api/ice
//	                                              (repeated-request load only)
//	global GuessBreaker          200/min          (invalid attempts only; never
//	                                              denies a valid join)
//
// The first line is the one that bounds guessing, and it is stated per CODE for
// a reason: /ws and /api/ice are two halves of one validity oracle (a live code
// gets you into the room on the first and a turn: entry on the second), so while
// they held one request budget EACH, an attacker who alternated between them
// tried ~10 distinct codes a minute, not 5. They now share one CodeGuessLimiter
// object, and a code presented to both — which is exactly what a real receiver
// does — spends one slot, not two.
//
// Nominal per-IP exposure: ~5 distinct codes per minute for the 5-minute TTL is
// on the order of 25 guesses from one address against one live code —
// 25/1e6 = 0.0025%. Treat that as a design figure, not a proof: the window is
// trailing with one-second granularity, the budget is per-process and divided
// across instances (PerInstanceThreshold) rather than enforced globally, and an
// attacker with many addresses simply multiplies it — nothing here caps
// distributed guessing. The old format's comparable per-IP figure was 30/min
// over a 30-minute window: 900/24^6 ≈ 0.00047%. So the honest statement is that
// the new format is roughly 5.3x looser per IP, and that is the usability trade
// the owner approved — not a wash.
//
// The GuessBreaker does NOT cap distributed guessing and must not be described
// as if it did. It is fed only from the branch where a code was already refused,
// i.e. it is checked before RecordInvalid has any say over valid codes, so a
// guesser who hits a live code walks through an open breaker unaffected. Its job
// is detection and load shedding on the invalid majority — WARN plus 429 — not a
// ceiling of N guesses per TTL.
//
// What a hit buys moved when advanced verification became opt-in, and it is
// worse than this comment used to say. It buys rendezvous rights in the room,
// one TURN credential billed to the code's owner, and — if the sender has
// already queued files — the FILES THEMSELVES IN PLAINTEXT.
//
// Commit-reveal + AEAD are mandatory and fail closed, so a forged or missing
// commit aborts the session rather than downgrading it, and the relay never sees
// plaintext. What they do NOT do is establish that the peer who completed the
// handshake is the human the sender meant. That is the SAS's job, and with
// advanced verification off there is no SAS comparison, so a guesser who lands
// on a live code is simply treated as the intended recipient. Whatever the
// sender queued is then transferred to it and decrypted on its side.
//
// The browser's per-batch Accept prompt does not change that conclusion. It
// stops an unsolicited WRITE to the recipient's disk — the attacker has to click
// Accept — and clicking Accept is exactly what an attacker does. Read it as "no
// silent drive-by download", not as a confidentiality control. The native macOS
// app does not even have that step for files: the manifest is accepted and the
// files are written to the configured destination — Downloads unless the app was
// pointed somewhere else — once the link is ready.
//
// So the accurate one-line statement of the residual risk: a guessed live code
// can disclose queued file contents to an unintended recipient. What bounds it
// is the code space and the per-IP budget above — plus advanced verification,
// which is the only control that actually detects the wrong peer, and only when
// the two humans really compare the SAS out of band.
//
// CodeLen is the cheap dial if that probability ever needs to come down: one
// more digit divides every number above by 10.
const CodeLen = 6

// CodeTTLSeconds is how long a minted pairing code stays valid — the value
// main.go hands NewPairRegistry, and the one the CLI's error copy quotes.
//
// It is exported for the same reason CodeLen and CodeAlphabet are: the CLI
// tells the user what a code is ("6 digits, and last 5 minutes") and every one
// of those numbers has to come from the same place as the behaviour, or the
// copy goes stale the first time the value moves.
//
// **这个 TTL 管的是"码还能不能用来会合"，不是一次传输能活多久。** 码只在 RoomFor
// 里被查一次（建立 WebSocket 的时候）；之后房间、信令、WebRTC 连接和正在传的文件
// 都不再看它，过期不会打断任何已经连上的会话。TURN 凭据另有自己的有效期。
//
// 5 分钟（曾经放宽到 30 分钟，现在收回来）：码空间从 24^6 缩到 10^6 之后，窗口宽度
// 直接决定在线爆破的命中率，见 CodeLen 里的算式。5 分钟足够读码/扫码并加入——码只
// 在**加入**那一刻被检查一次，挑文件、授权、来回沟通全都发生在加入之后，不受它约束。
// 这正是当初把窗口拉宽到 30 分钟时误判的地方：被拉长的其实是爆破窗口，而不是用户
// 可用的操作时间。
//
// 过期之后重新铸一枚码是一次点击；把窗口拉宽是永久放宽一个安全参数。要再压命中率，
// 加长 CodeLen 比继续缩短 TTL 便宜得多——多一位数字就是除以 10。
const CodeTTLSeconds int64 = 300

// randCode returns a uniformly random CodeLen-digit code over CodeAlphabet.
//
// Drawn per character with crypto/rand.Int over the alphabet length, so there is
// no modulo bias — 10 does not divide 256, which is exactly the case where the
// naive `randomByte % 10` skews 0-5 upward.
//
// Note it is built as a STRING of digits, never as an integer: "012345" and
// "000000" are ordinary codes, and any path that parses one into a number
// silently destroys 10% of the space.
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

// CodeFormatNote is the one phrase every first-party CLI surface uses to say
// what a pairing code is: "6 digits (0-9), valid 5 minutes".
//
// It exists so the CLI never restates CodeLen, CodeAlphabet or CodeTTLSeconds
// in prose. Three separate format strings used to interpolate those constants
// individually and each described the alphabet in its own words; when the
// format changed, "6 characters from ACDEFHJKMNPRTWXY23456789" was left behind
// in some of them and not others. One phrase, one place.
func CodeFormatNote() string {
	return fmt.Sprintf("%d digits (0-9), valid %d minutes", CodeLen, CodeTTLSeconds/60)
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
