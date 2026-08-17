package account

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/rsa"
	"encoding/binary"
	"errors"
	"fmt"
	"log"
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
	ApplePrivateKey      *ecdsa.PrivateKey // parsed .p8; nil when code exchange is off
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
	BillingHoldSecret   string
	// ReleaseCheck enables the hourly poll for a newer upstream release and the
	// admin notice built on it. On by default; RELAYIUM_RELEASE_CHECK=false
	// turns it off, and when off no request is made at all.
	ReleaseCheck bool
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
	// exchangeAppleNativeCode redeems a NATIVE app's one-time authorization code
	// as `clientID` — the Bundle ID audience already verified in the presented
	// identity token. Separate from the web hook rather than a widened version of
	// it: the two exchanges differ in client_id AND in redirect_uri (a native
	// authorization has none), and one hook would let a test that stubs the web
	// flow silently answer for the native one. Injectable for the same reason as
	// its sibling — the native path is verified end to end in tests without
	// touching Apple.
	exchangeAppleNativeCode func(ctx context.Context, clientID, code string) (idToken string, err error)
	// appleKey resolves Apple's signing public key for a given JWKS `kid`.
	// Injectable so tests verify tokens against a local key without touching the
	// network; the default fetches + caches Apple's public JWKS.
	appleKey func(ctx context.Context, kid string) (*rsa.PublicKey, error)
	// appleSecMu guards appleSecrets, the client_secret JWT cache. One entry per
	// Apple client id (Services ID for the web flow, Bundle ID for the app),
	// because Apple binds the secret's `sub` to the client redeeming the code —
	// a single shared entry would hand one client the other's secret. Each entry
	// is regenerated once it is within 2 minutes of its exp.
	appleSecMu   sync.Mutex
	appleSecrets map[string]appleSecret
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
	// pairCodes is the live pairing-code registry itself, wired by SetPairCodes.
	// pairCodeOwner answers "whose code is this" for /api/ice; this is the half
	// pre-upload needs, because a pair room's deadline MOVES and the code has to
	// move with it. nil disables pre-upload outright (pairRoomForUpload), which
	// is the honest behaviour: a room lifecycle whose codes still die at five
	// minutes binds ciphertext to a rendezvous nobody can reach.
	pairCodes PairCodes
	// clientIP resolves the request's rate-limit key IP. Defaults to the
	// package clientIP (trusts XFF's left entry — legacy behavior kept so
	// existing tests are unchanged); main.go injects signal.IPExtractor.IP,
	// which only trusts XFF from configured/loopback proxies (H3).
	clientIP func(*http.Request) string
	// iceLimiter is /api/ice's own REQUEST cap per IP (H1: brute-forcing the
	// 6-digit pairing code would steal a victim's TURN credentials). It bounds
	// requests, not distinct codes, so repeating one code is not free load.
	// nil = unlimited.
	iceLimiter rateLimiter
	// codeGuesses is the DISTINCT-pairing-code budget shared with /ws (one object
	// wired by main.go for both). /ws and /api/ice are two halves of one validity
	// oracle; with only the per-endpoint request caps above, an attacker split
	// guesses across them and got the sum. This is the cap on how many different
	// codes an address may try. nil = no distinct-guess cap (per-endpoint request
	// caps still apply).
	codeGuesses codeGuessLimiter
	// iceBreaker is the process-wide pairing-code brute-force breaker shared with
	// /ws. /api/ice only FEEDS it (every invalid non-empty code is recorded) and
	// no longer sheds anything on it: a valid code is served its credentials
	// whether the breaker is open or not, because shedding valid codes turned a
	// cheap guess-flood into a fleet-wide relay outage (see handleICE in turn.go).
	// /ws is where an open breaker actually sheds — invalid joins only.
	// nil disables this layer.
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
	// preUpload enables pair-room pre-upload: staging ciphertext against a
	// pairing code while its room waits for someone to join (pairroom.go).
	//
	// Off by default, and that default is load-bearing rather than cautious. The
	// owner's rule is that a joined transfer has NO deadline of any kind, so
	// nothing the server RUNS ever removes a joined room's ciphertext: it goes
	// when the receiver completes it (pairroom_complete.go), when the owning
	// account releases the room (pairroom_owner.go), or when that account is
	// deleted.
	//
	// Both feature-specific exits are now built and wired — the Web receiver posts
	// completions, and the account can list and release what is left. The flag
	// still stays off, because what remains is not a missing mechanism:
	//
	//   1. only a receiver whose destination commits the bytes to disk itself may
	//      complete (protocol §7.6), so every Firefox, Safari and phone receiver
	//      saves normally and completes nothing;
	//   2. the owner has not decided what becomes of a joined room nobody
	//      completes (a decline is deliberately NOT treated as a completion, no
	//      fallback expiry has been invented to stand in for one, and the release
	//      in (pairroom_owner.go) is a control somebody operates rather than an
	//      answer to this);
	//   3. the rollout gates for the storage commitment in (1)+(2) are open.
	//
	// Enabling it before then means the rooms in (1) are stored until their owner
	// hand-releases them. See pairroom.go's invariants 5 and 8.
	preUpload bool
	// pairJoins holds pairing-code joins the server observed on its own websocket
	// but could not persist. It is both a retry queue and, while an entry is in
	// it, the thing that stops a room being voided on a deadline that should
	// already have stopped. See pairJoinQueue.
	pairJoins pairJoinQueue
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
	// appleTx verifies App Store signed transactions against explicitly
	// configured trust roots and app identities (apple_transaction.go). nil is
	// the shipping default and means UNCONFIGURED: the intake route answers 503
	// rather than trusting anything, which is the only safe reading of "this
	// deployment has no Apple roots". Wired by SetAppleTransactionVerifier.
	appleTx            *AppleTransactionVerifier
	appleSubscriptions AppleSubscriptionReconciler
}

// rateLimiter is the minimal per-key limiter account needs; *signal.RateLimiter
// satisfies it. Declared locally so the account package need not import signal.
type rateLimiter interface{ Allow(key string) bool }

// codeGuessLimiter is the shared cross-endpoint distinct-pairing-code budget;
// *signal.CodeGuessLimiter satisfies it. Declared locally for the same reason as
// rateLimiter above. main.go wires the SAME object here and into the /ws route,
// which is the point: the budget is one per IP, not one per endpoint.
type codeGuessLimiter interface {
	// AllowCode records `code` as presented by `ip` and reports whether the
	// address stays within its distinct-candidate budget for the trailing window.
	// An empty code is not a guess and is always allowed.
	AllowCode(ip, code string) bool
}

// guessBreaker is the subset of *signal.GuessBreaker handleICE needs, declared
// locally for the same reason. In practice only RecordInvalid is called — to
// feed an invalid /api/ice code into the shared breaker; handleICE deliberately
// no longer sheds valid codes while the breaker is open (see turn.go). IsOpen
// stays in the interface because it is the breaker's read-only half and the next
// caller that wants to read the flood state should not have to widen this again.
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
	if cfg.BillingHoldSecret != "" {
		if configured, ok := store.(interface{ ConfigureBillingHoldSecret(string) error }); ok {
			if err := configured.ConfigureBillingHoldSecret(cfg.BillingHoldSecret); err != nil {
				panic("account: configure billing deletion hold: " + err.Error())
			}
		}
	}
	svc.adminPasskeyLogins = newLoginThrottle(maxFails)
	svc.clientIP = httpx.ClientIP
	svc.fetchGoogleUser = svc.realFetchGoogleUser
	svc.exchangeAppleCode = svc.realExchangeAppleCode
	svc.exchangeAppleNativeCode = svc.realExchangeAppleNativeCode
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
		client := NewStripeClient(cfg.StripeSecretKey, cfg.StripeWebhookSecret, cfg.StripePortalConfig)
		client.canonicalWebhookRefresh = true
		svc.biller = client
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
//
// This is the OWNER LOOKUP alone. A deployment that also runs pre-upload wires
// the registry itself with SetPairCodes, which covers this as well; the two are
// separate only because /api/ice has needed the lookup since long before there
// was a lifecycle to keep in step with it.
func (s *Service) SetPairCodeOwner(fn func(string) (string, bool)) { s.pairCodeOwner = fn }

// SetPairCodes wires the whole live pairing-code registry: the owner lookup
// /api/ice needs, and the lifetime control the pre-upload lifecycle needs.
//
// One call for both, because they must describe the SAME registry. A code's
// owner and a code's expiry answered by two different objects is how ciphertext
// ends up bound to a rendezvous whose credential has already been reissued.
func (s *Service) SetPairCodes(reg PairCodes) {
	s.pairCodes = reg
	s.pairCodeOwner = reg.OwnerOf
}

// SetClientIP overrides how per-IP rate-limit keys are derived. main.go
// injects the trusted-proxy-aware signal.IPExtractor.IP so a forged
// X-Forwarded-For from an untrusted peer can't dodge the throttles (H3).
func (s *Service) SetClientIP(fn func(*http.Request) string) {
	if fn != nil {
		s.clientIP = fn
	}
}

// SetICELimiter caps /api/ice REQUESTS at N/window/IP (H1: 5/min). This is the
// per-endpoint cap; the cap on distinct codes tried lives in
// SetCodeGuessLimiter. nil = unlimited.
func (s *Service) SetICELimiter(rl rateLimiter) { s.iceLimiter = rl }

// SetCodeGuessLimiter wires the pairing-code guess budget that /api/ice shares
// with /ws. main.go passes the same object to both, so five distinct codes is
// five across the pair of endpoints rather than five on each. nil = no
// distinct-guess cap.
func (s *Service) SetCodeGuessLimiter(l codeGuessLimiter) { s.codeGuesses = l }

// SetGuessBreaker wires the shared pairing-code brute-force detector (the same
// instance /ws feeds) so an invalid /api/ice code counts towards it too. Valid
// codes are served normally whether or not it is open. nil disables this layer.
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

// SetPreUpload toggles pair-room pre-upload (default off). Read pairroom.go's
// invariants 5 and 8 before turning it on.
//
// A joined room still has no deadline, and nothing here adds one. Its ciphertext
// goes when the receiver completes it (pairroom_complete.go), when the account
// releases the room (pairroom_owner.go), or when the account is deleted. The
// rollout gates are open because most receivers cannot complete at all (protocol
// §7.6) and what becomes of a room nobody completes is still the owner's to
// answer — so a deployment that turns this on is agreeing to hold that storage
// until somebody asks for it back.
//
// Off, `purpose=pair_room` is refused with 503 and no room is ever created, which
// is exactly the behaviour of a server that never heard of the feature. The
// completion route and the owner's two routes stay mounted either way and simply
// find nothing to complete or release, since without this flag no pair-room
// object can exist — and a deployment that turns the flag off after rooms exist
// must not thereby strand them.
func (s *Service) SetPreUpload(on bool) { s.preUpload = on }

// SetAppleTransactionVerifier wires (or clears, with nil) the App Store
// signed-transaction verifier.
//
// Injected rather than derived from Config for two reasons. It is the only
// arrangement in which a test can own its whole trust chain — its own root,
// intermediate, leaf and signed payloads — and prove the adversarial cases a
// hard-wired Apple root makes untestable. And it keeps the failure honest: a
// deployment builds the verifier from explicit configuration through
// NewAppleTransactionVerifier, which refuses a half-configured one outright,
// rather than a Config field that quietly produces a verifier trusting nothing.
//
// NOTHING CALLS THIS YET outside tests. Wiring startup configuration (trust
// roots, environment, bundle identities) is deliberately a later, separate
// step; until it happens the verifier stays nil, POST
// /api/billing/apple/transaction answers 503, and no Apple state can be
// created.
func (s *Service) SetAppleTransactionVerifier(v *AppleTransactionVerifier) { s.appleTx = v }

func (s *Service) SetAppleSubscriptionReconciler(v AppleSubscriptionReconciler) {
	s.appleSubscriptions = v
}

// ReconcileAppleSubscriptions is the missed-notification backstop. External
// calls live only in this bounded sweep; request enforcement uses local clocks.
func (s *Service) ReconcileAppleSubscriptions(ctx context.Context) {
	lister, ok := s.Store().(interface {
		ListAppleSubscriptionSources(context.Context, string, int) ([]SubscriptionSource, error)
	})
	if !ok {
		return
	}
	canonical, ok := s.appleSubscriptions.(interface {
		CanonicalSubscriptionByIdentity(context.Context, AppleSubscriptionIdentity, time.Time) (AppleSubscriptionCanonical, error)
	})
	if !ok {
		return
	}
	now := s.now()
	var refreshed, failed int
	const pageSize = 100
	after := ""
	for {
		sources, err := lister.ListAppleSubscriptionSources(ctx, after, pageSize)
		if err != nil {
			log.Printf("apple subscription sweep: list failed")
			return
		}
		for _, src := range sources {
			identity, ok := appleIdentityFromSource(src)
			if !ok {
				failed++
				continue
			}
			fact, err := canonical.CanonicalSubscriptionByIdentity(ctx, identity, now)
			if err != nil {
				failed++
				continue
			}
			// The environment-qualified subscription binding is the sweep's
			// lookup authority. When Apple includes appAccountToken it must still
			// resolve through the durable subject/tombstone map and agree; a
			// missing token cannot broaden the already-bound identity.
			if fact.Transaction.AppAccountToken != "" {
				owner, owned, ownerErr := s.appleTokenOwner(ctx, fact.Transaction.AppAccountToken)
				if ownerErr != nil || !owned || owner.ID != src.UserID {
					failed++
					continue
				}
			}
			var product AppleProduct
			if !appleTransactionIsTerminal(fact.Transaction) {
				product, ok, err = s.Store().AppleProductPlan(ctx, fact.Transaction.BundleID, fact.Transaction.ProductID)
			}
			if err != nil || (!ok && !appleTransactionIsTerminal(fact.Transaction)) {
				failed++
				continue
			}
			ren := appleRenewalState(src.UserID, fact.Transaction, fact.Renewal, now)
			atomic, ok := s.Store().(interface {
				ApplyAuthorizedAppleLifecycle(context.Context, SourceEvent, AppleRenewalState, string, string) (SubscriptionApply, error)
			})
			if !ok {
				return
			}
			if _, err = atomic.ApplyAuthorizedAppleLifecycle(ctx, appleSourceEventWithRenewal(src.UserID, fact.Transaction, product, ren, now), ren, fact.Transaction.AppAccountToken, fact.Transaction.Environment); err != nil {
				failed++
				continue
			}
			refreshed++
		}
		if len(sources) < pageSize {
			break
		}
		after = sources[len(sources)-1].UserID
	}
	if failed > 0 {
		log.Printf("apple subscription sweep: refreshed=%d failed=%d", refreshed, failed)
	}
}

func (s *Service) RunAppleSubscriptionReconciler(ctx context.Context, interval time.Duration) {
	s.ReconcileAppleSubscriptions(ctx)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.ReconcileAppleSubscriptions(ctx)
		}
	}
}

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

// SetNow overrides the service's clock. In-package tests inject a fixed
// clock by assigning s.now directly (e.g. admin_test.go, apple_test.go) and
// keep doing so — that still works, and this doesn't replace it. SetNow
// exists for code that will no longer be in-package: once the commercial
// admin/billing tests move to relayium-cloud (see server/ext's package doc),
// direct field assignment stops compiling, and this is the supported
// alternative — a mechanical `svc.now = fn` -> `svc.SetNow(fn)` at that
// point, nothing more.
func (s *Service) SetNow(fn func() time.Time) {
	if fn != nil {
		s.now = fn
	}
}

// Cfg returns the service's static configuration. Exported for the same
// reason as Store. Deliberately NOT part of ext.AdminHost: Config is
// defined here in account (like Store), so exposing it through AdminHost
// would force ext to import account and cycle, for the same reason
// Store is excluded — see Store's doc comment.
func (s *Service) Cfg() Config { return s.cfg }

// AdminLoginLocked, AdminLoginRecordFail, and AdminLoginReset wrap the admin
// login-lockout throttle (s.adminLogins, a *loginThrottle) for ip. They
// replace a bare AdminLogins() accessor deliberately: *loginThrottle and its
// locked/recordFail/reset methods are all unexported (throttle.go), so an
// accessor returning the type would be exported in name only — nothing on
// the far side of the returned value would be callable once the caller is
// in a different package. Wrapping instead keeps the throttle itself
// private and applies the clock internally, so callers don't separately
// thread s.Now() through (matching how the unexported call sites read
// before this file existed). All three are in ext.AdminHost: their
// signatures are ip string / bool, no account-defined type to cycle on.
func (s *Service) AdminLoginLocked(ip string) bool { return s.adminLogins.locked(ip, s.now()) }
func (s *Service) AdminLoginRecordFail(ip string)  { s.adminLogins.recordFail(ip, s.now()) }
func (s *Service) AdminLoginReset(ip string)       { s.adminLogins.reset(ip) }

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
