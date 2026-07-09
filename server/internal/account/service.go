package account

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/relayium/relayium/internal/storage"
)

// RelayConfig is one TURN relay in the pool (RELAYIUM_TURN_RELAYS JSON). The
// client measures its RTT to each and both peers agree on the fastest common one.
// Each relay carries its own coturn static-auth-secret so relays can live on
// independent hosts. Leaving the pool empty keeps the legacy single-TURN behaviour.
type RelayConfig struct {
	ID     string   `json:"id"`
	Region string   `json:"region,omitempty"`
	URLs   []string `json:"urls"`           // turn:/turns: URLs for this relay
	STUN   string   `json:"stun,omitempty"` // optional stun: URL co-located with it
	Secret string   `json:"secret"`         // this relay's coturn static-auth-secret
}

type Config struct {
	BaseURL         string
	SessionTTL      time.Duration
	MagicTTL        time.Duration
	VerifyTTL       time.Duration // email verification link lifetime (default 24h)
	ResetTTL        time.Duration // password reset link lifetime (default 1h)
	STUNURLs        []string
	TURNURLs        []string
	TURNSecret      string
	TURNCredTTL     time.Duration
	TURNRelays      []RelayConfig // multi-relay pool; empty = legacy single TURN only
	GoogleClientID  string
	GoogleSecret    string
	GoogleRedirect  string
	EnableGoogle    bool
	EnableMagic     bool
	AdminUser       string
	AdminPassword   string
	AdminTOTPSecret string // base32 TOTP secret; empty disables admin 2FA
	// Stored-transfer limits (env/flag defaults; DB settings table overrides these live).
	MaxFileSize int64 // bytes
	DailyQuota  int64 // bytes per rolling 24h
	DefaultTTL  int64 // seconds
	MaxTTL      int64 // seconds
	// RelayMonthlyFree is the interim per-user monthly TURN-relay allowance in
	// bytes; superseded by a per-plan quota later.
	RelayMonthlyFree int64
}

type Service struct {
	store             Store
	mailer            Mailer
	cfg               Config
	now               func() time.Time
	fetchGoogleUser   func(ctx context.Context, code string) (sub, email, name string, verified bool, err error)
	adminSessions     map[string]int64 // token -> 过期 unix 秒
	adminMu           sync.Mutex
	adminTOTPMu       sync.Mutex
	adminTOTPLastStep int64 // last TOTP time-step accepted for admin login (replay guard)
	adminLogins       *loginThrottle
	pwLogins          *loginThrottle              // per email+IP failed password-login limiter
	magicRequests     *loginThrottle              // per email+IP magic-link request rate limiter
	verifyRequests    *loginThrottle              // per email+IP resend-verification limiter
	resetRequests     *loginThrottle              // per email+IP forgot-password limiter
	blobs             storage.BlobStore           // nil until SetBlobStore; stored-transfer disabled when nil
	pairCodeOwner     func(string) (string, bool) // resolves a live code to its owner userID; nil until wired
	// clientIP resolves the request's rate-limit key IP. Defaults to the
	// package clientIP (trusts XFF's left entry — legacy behavior kept so
	// existing tests are unchanged); main.go injects signal.IPExtractor.IP,
	// which only trusts XFF from configured/loopback proxies (H3).
	clientIP func(*http.Request) string
	// iceLimiter caps /api/ice attempts per IP (H1: brute-forcing the 6-digit
	// pairing code would steal a victim's TURN credentials). nil = unlimited.
	iceLimiter rateLimiter
	// registerLimiter caps POST /api/auth/register attempts per IP (H2a). nil = unlimited.
	registerLimiter rateLimiter
}

// rateLimiter is the minimal per-key limiter account needs; *signal.RateLimiter
// satisfies it. Declared locally so the account package need not import signal.
type rateLimiter interface{ Allow(key string) bool }

func NewService(store Store, mailer Mailer, cfg Config) *Service {
	svc := &Service{store: store, mailer: mailer, cfg: cfg, now: time.Now,
		adminSessions: map[string]int64{}, adminLogins: newLoginThrottle(),
		pwLogins: newLoginThrottle(), magicRequests: newLoginThrottle(),
		verifyRequests: newLoginThrottle(), resetRequests: newLoginThrottle()}
	svc.clientIP = clientIP
	svc.fetchGoogleUser = svc.realFetchGoogleUser
	return svc
}

// SetBlobStore wires the ciphertext blob backend for stored transfers. Called
// once at startup when the DB (and thus account features) are available.
func (s *Service) SetBlobStore(b storage.BlobStore) { s.blobs = b }

// SetPairCodeOwner wires the pairing-code registry so /api/ice can resolve a
// live code to its owning account — TURN is issued (and relay billed) for that
// owner. Called once at startup.
func (s *Service) SetPairCodeOwner(fn func(string) (string, bool)) { s.pairCodeOwner = fn }

// SetClientIP overrides how per-IP rate-limit keys are derived. main.go
// injects the trusted-proxy-aware signal.IPExtractor.IP so a forged
// X-Forwarded-For from an untrusted peer can't dodge the throttles (H3).
func (s *Service) SetClientIP(fn func(*http.Request) string) {
	if fn != nil {
		s.clientIP = fn
	}
}

// SetICELimiter caps /api/ice at N/window/IP (H1: 5/min). nil = unlimited.
func (s *Service) SetICELimiter(rl rateLimiter) { s.iceLimiter = rl }

// SetRegisterLimiter caps POST /api/auth/register per IP (H2a: 5/min). nil = unlimited.
func (s *Service) SetRegisterLimiter(rl rateLimiter) { s.registerLimiter = rl }

func randToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("account: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func (s *Service) IssueSession(ctx context.Context, userID string) (Session, error) {
	now := s.now()
	sess := Session{
		ID:        randToken(),
		UserID:    userID,
		CreatedAt: now.Unix(),
		ExpiresAt: now.Add(s.cfg.SessionTTL).Unix(),
	}
	if err := s.store.CreateSession(ctx, sess); err != nil {
		return Session{}, err
	}
	return sess, nil
}

func (s *Service) ValidateSession(ctx context.Context, sessionID string) (User, bool, error) {
	sess, ok, err := s.store.GetSession(ctx, sessionID)
	if err != nil || !ok {
		return User{}, false, err
	}
	if s.now().Unix() >= sess.ExpiresAt {
		return User{}, false, nil
	}
	u, err := s.store.GetUserByID(ctx, sess.UserID)
	if err != nil {
		return User{}, false, err
	}
	return u, true, nil
}

// UserFromRequest resolves the logged-in user from the session cookie, or
// (User{}, false) when the cookie is absent or invalid. Unlike RequireSession it
// writes no response — callers decide how to treat an anonymous request.
func (s *Service) UserFromRequest(r *http.Request) (User, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return User{}, false
	}
	u, ok, err := s.ValidateSession(r.Context(), c.Value)
	if err != nil || !ok {
		return User{}, false
	}
	return u, true
}

func (s *Service) RequestMagicLink(ctx context.Context, email string) error {
	email = normEmail(email)
	raw := randToken()
	now := s.now()
	tok := MagicToken{
		TokenHash: hashToken(raw),
		Email:     email,
		CreatedAt: now.Unix(),
		ExpiresAt: now.Add(s.cfg.MagicTTL).Unix(),
	}
	if err := s.store.CreateMagicToken(ctx, tok); err != nil {
		return err
	}
	link := fmt.Sprintf("%s/api/auth/magic/verify?token=%s", s.cfg.BaseURL, url.QueryEscape(raw))
	return s.mailer.SendMagicLink(ctx, email, link)
}

func (s *Service) VerifyMagicLink(ctx context.Context, rawToken string) (Session, error) {
	tok, ok, err := s.store.UseMagicToken(ctx, hashToken(rawToken), s.now().Unix())
	if err != nil {
		return Session{}, err
	}
	if !ok {
		return Session{}, fmt.Errorf("invalid or expired token")
	}
	u, err := s.store.UpsertUserByEmail(ctx, tok.Email, "")
	if err != nil {
		return Session{}, err
	}
	if err := s.store.LinkIdentity(ctx, "email", tok.Email, u.ID); err != nil {
		return Session{}, err
	}
	if err := s.store.SetEmailVerified(ctx, u.ID); err != nil {
		return Session{}, err
	}
	return s.IssueSession(ctx, u.ID)
}
