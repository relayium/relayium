package account

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/rsa"
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/httpx"
	"github.com/relayium/relayium/internal/storage"
)

// ErrPendingDeletion signals that a login attempt (password, magic link, or
// OAuth) resolved to an account with a pending self-deletion (DeletedAt>0).
// No session may be issued for such an account — every session-issuing auth
// path must check this before calling IssueSession, since a frozen account
// getting a live session is a security bug, not just a UX one.
var ErrPendingDeletion = errors.New("account pending deletion")

// PendingDeletionError carries the reactivation details a frozen-login
// handler needs (purge deadline + a fresh single-use reactivate token)
// without a second user lookup. It wraps ErrPendingDeletion so
// errors.Is(err, ErrPendingDeletion) still matches at any call site;
// handlers that need the extra fields use errors.As.
type PendingDeletionError struct {
	PurgeAfter      int64
	ReactivateToken string
}

func (e *PendingDeletionError) Error() string { return ErrPendingDeletion.Error() }
func (e *PendingDeletionError) Unwrap() error { return ErrPendingDeletion }

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
	// RateLimitDivisor lowers the per-instance abuse thresholds (login lockouts
	// here; the signal rate limiters + GuessBreaker in main) for a round-robin
	// multi-instance deployment. Default 0/1 = no change (single instance, or an
	// IP-hash LB where the full threshold is already correct). See
	// PerInstanceThreshold and the multi-instance-state-migration doc in relayium-ops, §7.5.
	RateLimitDivisor int
	BaseURL          string
	SessionTTL       time.Duration
	MagicTTL         time.Duration
	VerifyTTL        time.Duration // email verification link lifetime (default 24h)
	ResetTTL         time.Duration // password reset link lifetime (default 1h)
	STUNURLs         []string
	TURNURLs         []string
	TURNSecret       string
	TURNCredTTL      time.Duration
	TURNRelays       []RelayConfig // multi-relay pool; empty = legacy single TURN only
	GoogleClientID   string
	GoogleSecret     string
	GoogleRedirect   string
	EnableGoogle     bool
	EnableMagic      bool
	// Sign in with Apple. EnableApple gates the /api/auth/apple/* routes (off by
	// default → dormant until an Apple developer account is configured).
	// AppleClientIDs is the aud allowlist: the app's Bundle ID (native SiwA) and
	// the web Services ID both present tokens, so both must be accepted.
	EnableApple    bool
	AppleClientIDs []string
	// Web Sign in with Apple. Distinct from the native flow: the browser button
	// runs the OAuth code flow, so the server needs the Services ID (web
	// client_id / aud) plus the .p8 signing key to mint the client_secret JWT.
	AppleServicesID      string            // web client_id; also belongs in AppleClientIDs
	AppleTeamID          string            // client_secret `iss`
	AppleKeyID           string            // .p8 Key ID; client_secret JWT header `kid`
	AppleRedirect        string            // derived: BaseURL + /api/auth/apple/web/callback
	ApplePrivateKey      *ecdsa.PrivateKey // parsed .p8; nil when web SiwA is off
	AppleDomainAssocFile string            // path to apple-developer-domain-association.txt
	AdminUser            string
	AdminPassword        string
	AdminTOTPSecret      string // base32 TOTP secret; empty disables admin 2FA
	// Stored-transfer limits (env/flag defaults; DB settings table overrides these live).
	MaxFileSize int64 // bytes
	// NodeTrafficDefault 是官方节点月度中继流量的默认上限（字节）；0 = 不限。
	NodeTrafficDefault int64
	DailyQuota         int64 // bytes per rolling 24h
	DefaultTTL         int64 // seconds
	MaxTTL             int64 // seconds
	// DefaultRetention is the admin default retention policy (0=burn, 1=ttl,
	// 2=count) applied when an upload request specifies none of
	// burnAfterRead/ttl/maxDownloads. See Settings.DefaultRetention.
	DefaultRetention int64
	// DefaultMaxDownloads is the download-count cap used by the count retention
	// policy, and the fallback for a non-positive explicit maxDownloads request.
	DefaultMaxDownloads int64
	// MaxMaxDownloads hard-bounds any resolved MaxDownloads; 0 = unbounded.
	MaxMaxDownloads int64
	// AccountGraceDays is the grace period (days) between a self-deletion
	// request and GC's hard purge of the account and its data (default 30).
	AccountGraceDays int64
	// AccountReminderDays is how many days before purge the one-time reminder
	// email is sent (default 3).
	AccountReminderDays int64
	// StorageDiskCap seeds SettingStorageDiskCap (global logical storage ceiling).
	StorageDiskCap int64
	// NodeToken is the fleet bootstrap bearer token relay nodes present to
	// /api/nodes/*. Empty disables the node API (endpoints return 404).
	NodeToken string
	// EnableUserNodes serves the per-user node token path (BYO nodes) even when
	// the shared fleet NodeToken is empty.
	EnableUserNodes bool
	// StripeSecretKey/StripeWebhookSecret/StripePortalConfig configure Stripe
	// billing (phase-2). StripeSecretKey empty disables billing entirely:
	// Service.biller stays nil, /api/billing/* return 404, and the webhook
	// endpoint returns 400.
	StripeSecretKey     string
	StripeWebhookSecret string
	StripePortalConfig  string
}

type Service struct {
	store           Store
	mailer          Mailer
	cfg             Config
	now             func() time.Time
	fetchGoogleUser func(ctx context.Context, code string) (sub, email, name string, verified bool, err error)
	// exchangeAppleCode swaps a web Sign in with Apple OAuth authorization code
	// for an identity token. Injectable like fetchGoogleUser; the default posts
	// to Apple's token endpoint using a client_secret JWT signed with
	// cfg.ApplePrivateKey (implemented in Task 3).
	exchangeAppleCode func(ctx context.Context, code string) (idToken string, err error)
	// appleKey resolves Apple's signing public key for a given JWKS `kid`.
	// Injectable so tests verify tokens against a local key without touching the
	// network; the default fetches + caches Apple's public JWKS.
	appleKey func(ctx context.Context, kid string) (*rsa.PublicKey, error)
	// appleSecMu guards appleSecTok/appleSecExp, the cached appleClientSecret()
	// JWT; regenerated once it's within 2 minutes of appleSecExp.
	appleSecMu  sync.Mutex
	appleSecTok string
	appleSecExp time.Time
	// Admin sessions and the TOTP replay guard now live in the store (persistent,
	// multi-instance safe) — no process-local session map or counter here anymore.
	// See the multi-instance-state-migration doc in relayium-ops.
	adminLogins *loginThrottle
	// adminPasskeyLogins is a SEPARATE bucket from adminLogins on purpose: if
	// passkey failures counted against the password bucket, an attacker could
	// spam failed passkey attempts to lock out the password fallback — the one
	// escape hatch when passkeys are unavailable.
	adminPasskeyLogins *loginThrottle
	// passkeyCeremonies now live in the store (admin_passkey_ceremonies, item #3),
	// spendable exactly once on any instance — no process-local map here.
	// pendingActions now live in the store (admin_pending_actions, item #2),
	// claimable exactly once on any instance — no process-local map here.
	pwLogins       *loginThrottle              // per email+IP failed password-login limiter
	magicRequests  *loginThrottle              // per email+IP magic-link request rate limiter
	verifyRequests *loginThrottle              // per email+IP resend-verification limiter
	resetRequests  *loginThrottle              // per email+IP forgot-password limiter
	deleteRequests *loginThrottle              // per user+IP account-deletion-request limiter
	blobs          storage.BlobStore           // nil until SetBlobStore; stored-transfer disabled when nil
	pairCodeOwner  func(string) (string, bool) // resolves a live code to its owner userID; nil until wired
	// clientIP resolves the request's rate-limit key IP. Defaults to the
	// package clientIP (trusts XFF's left entry — legacy behavior kept so
	// existing tests are unchanged); main.go injects signal.IPExtractor.IP,
	// which only trusts XFF from configured/loopback proxies (H3).
	clientIP func(*http.Request) string
	// iceLimiter caps /api/ice attempts per IP (H1: brute-forcing the 6-digit
	// pairing code would steal a victim's TURN credentials). nil = unlimited.
	iceLimiter rateLimiter
	// iceBreaker is the process-wide pairing-code brute-force breaker shared with
	// /ws. While it is open, /api/ice sheds credential issuance (STUN-only) so it
	// cannot be used as a validity oracle or a victim-billed credential tap during
	// a flood; invalid /api/ice codes also feed it. nil disables this layer.
	iceBreaker guessBreaker
	// registerLimiter caps POST /api/auth/register attempts per IP (H2a). nil = unlimited.
	registerLimiter rateLimiter
	// passkeyBeginLimiter caps admin passkey */begin calls per IP. The
	// (unauthenticated) login/begin creates a ceremony row each call and only
	// records a throttle fail on FINISH, so without this a begin-flood fills the
	// shared ceremony cap and starves legit passkey login/step-up. nil = unlimited.
	passkeyBeginLimiter rateLimiter
	// downloadLimiter caps GET /api/files/{id}/blob starts per IP. Every download
	// is proxied through central, so an unbounded request rate against a public
	// link amplifies central egress; this blunts a single source before the
	// monthly traffic gate (which reads eventually-consistent usage) reacts.
	// nil = unlimited.
	downloadLimiter rateLimiter
	// directDownload enables serving a fleet node's stored files by 302-redirecting
	// the client straight to <node.DownloadURL>/dl/{key}?t=<token>, so the bytes
	// bypass central (see docs/design-decentralized-stored-downloads.md). Opt-in
	// (default off) — a new data path; a kill-switch to fall back to full proxy.
	directDownload bool
	// uploadSem caps concurrent in-flight POST /api/files per account (M1).
	uploadSem *uploadSem
	// diskUsage reads the blob volume's current usage; nil disables the global
	// disk soft cap (M3b). blobDiskMax<=0 also disables it even if diskUsage is set.
	diskUsage   func() (used, total uint64, err error)
	blobDiskMax int64
	// nodeHTTP is used for central->node blob calls (RemoteBlobStore); a
	// ResponseHeaderTimeout guards against a stuck node, but there is
	// deliberately no total request timeout since blob bodies are large
	// streams.
	nodeHTTP *http.Client
	// allowPrivateNodeURLs disables the SSRF guard on node-supplied StorageURLs
	// (RELAYIUM_ALLOW_PRIVATE_NODE_URLS=true), for self-hosting the whole stack
	// on a private LAN.
	allowPrivateNodeURLs bool
	// pickN returns a random index in [0,n); overridable in tests for
	// deterministic node selection in placeUpload.
	pickN func(int) int
	// biller is the Stripe integration (phase-2 billing); nil when
	// cfg.StripeSecretKey is empty, in which case billing endpoints 404.
	biller Biller
}

// rateLimiter is the minimal per-key limiter account needs; *signal.RateLimiter
// satisfies it. Declared locally so the account package need not import signal.
type rateLimiter interface{ Allow(key string) bool }

// guessBreaker is the subset of *signal.GuessBreaker handleICE needs, declared
// locally for the same reason: IsOpen to shed while a flood is active, and
// RecordInvalid to feed an invalid /api/ice code into the shared breaker.
type guessBreaker interface {
	IsOpen() bool
	RecordInvalid() (open, logNow bool)
}

func NewService(store Store, mailer Mailer, cfg Config) *Service {
	// Per-instance lockout threshold: full for a single instance / IP-hash LB
	// (divisor 1), lowered for a round-robin LB. See PerInstanceThreshold.
	maxFails := PerInstanceThreshold(adminLoginMaxFails, cfg.RateLimitDivisor)
	svc := &Service{store: store, mailer: mailer, cfg: cfg, now: time.Now,
		adminLogins: newLoginThrottle(maxFails),
		pwLogins:    newLoginThrottle(maxFails), magicRequests: newLoginThrottle(maxFails),
		verifyRequests: newLoginThrottle(maxFails), resetRequests: newLoginThrottle(maxFails),
		deleteRequests: newLoginThrottle(maxFails),
		uploadSem:      newUploadSem(maxConcurrentUploadsPerUser)}
	svc.adminPasskeyLogins = newLoginThrottle(maxFails)
	svc.clientIP = httpx.ClientIP
	svc.fetchGoogleUser = svc.realFetchGoogleUser
	svc.exchangeAppleCode = svc.realExchangeAppleCode
	svc.appleKey = newAppleKeyStore().key
	svc.allowPrivateNodeURLs = os.Getenv("RELAYIUM_ALLOW_PRIVATE_NODE_URLS") == "true"
	svc.nodeHTTP = &http.Client{Transport: &http.Transport{
		ResponseHeaderTimeout: 15 * time.Second,
		// Block outbound calls to non-public addresses (SSRF via user-supplied
		// node StorageURL). Dial-time check also defeats DNS rebinding.
		DialContext: guardedDialContext(svc.allowPrivateNodeURLs),
		// no total timeout: blob bodies are large streams
	}}
	svc.pickN = func(n int) int {
		if n <= 0 {
			return 0
		}
		b := make([]byte, 8)
		_, _ = rand.Read(b)
		return int(binary.BigEndian.Uint64(b) % uint64(n))
	}
	if cfg.StripeSecretKey != "" {
		svc.biller = NewStripeClient(cfg.StripeSecretKey, cfg.StripeWebhookSecret, cfg.StripePortalConfig)
	}
	return svc
}

// SetBlobStore wires the ciphertext blob backend for stored transfers. Called
// once at startup when the DB (and thus account features) are available.
func (s *Service) SetBlobStore(b storage.BlobStore) { s.blobs = b }

// SetDiskGuard enables the global blob-volume soft cap (M3b): when usage reports
// used >= maxBytes, new uploads are refused with 503. maxBytes<=0 or a nil usage
// func disables the guard. usage errors fail open (log + allow).
func (s *Service) SetDiskGuard(usage func() (used, total uint64, err error), maxBytes int64) {
	s.diskUsage = usage
	s.blobDiskMax = maxBytes
}

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

// SetGuessBreaker wires the shared pairing-code brute-force breaker (the same
// instance /ws feeds) so /api/ice sheds credential issuance while it is open and
// feeds it invalid codes. nil disables this layer.
func (s *Service) SetGuessBreaker(b guessBreaker) { s.iceBreaker = b }

// SetRegisterLimiter caps POST /api/auth/register per IP (H2a: 5/min). nil = unlimited.
func (s *Service) SetRegisterLimiter(rl rateLimiter) { s.registerLimiter = rl }

// SetPasskeyBeginLimiter caps admin passkey */begin per IP. nil = unlimited.
func (s *Service) SetPasskeyBeginLimiter(rl rateLimiter) { s.passkeyBeginLimiter = rl }

// SetDownloadLimiter caps GET /api/files/{id}/blob starts per IP. nil = unlimited.
func (s *Service) SetDownloadLimiter(rl rateLimiter) { s.downloadLimiter = rl }

// SetDirectDownload toggles direct-from-node downloads for fleet nodes that
// advertise a DownloadURL (default off → central proxies every download).
func (s *Service) SetDirectDownload(on bool) { s.directDownload = on }

// Store returns the account data store. Exported so the commercial
// admin/billing layer (billing.go, admin.go, admin_rollout.go,
// plan_enforce.go — slated to move to a private repo, see server/ext) can
// reach the Store methods it calls without account depending on that layer.
// Deliberately NOT part of ext.AdminHost: Store is a ~90-method surface and
// its type is defined here in account, so putting it in AdminHost would
// force ext to import account — which cycles back against account's own
// `var _ ext.AdminHost = (*Service)(nil)` assertion. See server/ext/ext.go's
// package doc for the full reasoning.
func (s *Service) Store() Store { return s.store }

// Now returns the current time as seen by this service. It is a thin
// delegate to the injectable clock (s.now, defaulted to time.Now in
// NewService and overridden directly by tests — see e.g. admin_test.go)
// rather than a new clock of its own, so callers that switch from s.now()
// to s.Now() keep observing whatever clock the test wired in. Exported for
// the same reason as Store; not part of ext.AdminHost only because nothing
// about it needs to be — unlike Store/Cfg/ResolveSettings it returns a
// stdlib type, so it could be added there too, and is (see AdminHost.Now).
func (s *Service) Now() time.Time { return s.now() }

// Cfg returns the service's static configuration. Exported for the same
// reason as Store. Deliberately NOT part of ext.AdminHost: Config is
// defined here in account (like Store), so exposing it through AdminHost
// would force ext to import account and cycle, for the same reason
// Store is excluded — see Store's doc comment.
func (s *Service) Cfg() Config { return s.cfg }

// AdminLogins returns the admin login-lockout throttle. Exported for the
// same reason as Store. Cannot be part of ext.AdminHost: *loginThrottle is
// unexported, so ext could not even name the return type.
func (s *Service) AdminLogins() *loginThrottle { return s.adminLogins }

// passkeyBeginAllowed reports whether this IP may start another passkey ceremony,
// writing a 429 and returning false when the per-IP begin budget is exhausted.
func (s *Service) passkeyBeginAllowed(w http.ResponseWriter, r *http.Request) bool {
	if s.passkeyBeginLimiter != nil && !s.passkeyBeginLimiter.Allow(s.clientIP(r)) {
		httpx.WriteJSON(w, http.StatusTooManyRequests, map[string]string{"error": "尝试过于频繁，请稍后再试"})
		return false
	}
	return true
}

func (s *Service) IssueSession(ctx context.Context, userID string) (Session, error) {
	now := s.now()
	sess := Session{
		ID:        authx.RandToken(),
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
	// Central frozen-account guard (blocker fix): a session that somehow got
	// minted for a pending-deletion account (DeletedAt>0) — whether through a
	// gap in one of the per-endpoint guards below, or a session that predates
	// the deletion request outliving PurgeTransientUserData's revoke — must
	// stop being usable the moment the account is frozen. This is the last
	// line of defense: it covers every RequireSession/UserFromRequest-gated
	// endpoint regardless of how the session was issued, not just the three
	// login paths. Treated identically to an expired session so callers don't
	// need a new branch. Reactivation (POST /api/account/reactivate) does not
	// go through ValidateSession — it's token-authorized — so this can't block
	// the only path that clears DeletedAt.
	if u.DeletedAt > 0 {
		return User{}, false, nil
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
	// Reject malformed addresses (e.g. embedded CRLF) before they reach the
	// mailer — defense in depth against SMTP header injection. Silent to keep the
	// endpoint's anti-enumeration behaviour.
	if _, err := mail.ParseAddress(email); err != nil {
		return nil
	}
	raw := authx.RandToken()
	now := s.now()
	tok := MagicToken{
		TokenHash: authx.HashToken(raw),
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
	tok, ok, err := s.store.UseMagicToken(ctx, authx.HashToken(rawToken), s.now().Unix())
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
	// Frozen-login guard (Task 4): a pending-deletion account must not get a
	// live session via magic link. Mint a fresh reactivate token right here,
	// while we still have u — handleMagicVerify has no other way to recover
	// the account's email from just the (now-consumed) magic token.
	if u.DeletedAt > 0 {
		raw, terr := s.issueReactivateToken(ctx, u.ID, u.Email)
		if terr != nil {
			return Session{}, terr
		}
		return Session{}, &PendingDeletionError{PurgeAfter: u.PurgeAfter, ReactivateToken: raw}
	}
	if err := s.store.LinkIdentity(ctx, "email", tok.Email, u.ID); err != nil {
		return Session{}, err
	}
	// Pre-hijack defense: a password planted on this email while it was
	// unverified is untrusted once ownership is proven via the magic link.
	if err := s.dropUnverifiedPassword(ctx, u.ID); err != nil {
		return Session{}, err
	}
	if err := s.store.SetEmailVerified(ctx, u.ID); err != nil {
		return Session{}, err
	}
	return s.IssueSession(ctx, u.ID)
}
