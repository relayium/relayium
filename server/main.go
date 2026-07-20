package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"mime"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/mdp/qrterminal/v3"
	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
	"github.com/relayium/relayium/internal/account"
	"github.com/relayium/relayium/internal/metering"
	"github.com/relayium/relayium/internal/signal"
	"github.com/relayium/relayium/internal/storage"
)

const lanMaxPeers = 50 // LAN room peer cap (H4); tunable.

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// splitURLs parses a comma-separated URL flag, trimming spaces and dropping empties.
func splitURLs(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// parseTURNRelays parses the RELAYIUM_TURN_RELAYS JSON array into a relay pool.
// A malformed value is logged and ignored (falling back to the single -turn-urls
// relay) rather than aborting startup — TURN is best-effort infrastructure.
func parseTURNRelays(s string) []account.RelayConfig {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	var relays []account.RelayConfig
	if err := json.Unmarshal([]byte(s), &relays); err != nil {
		log.Printf("relayium: ignoring RELAYIUM_TURN_RELAYS — invalid JSON: %v", err)
		return nil
	}
	return relays
}

func main() {
	// Load an optional .env file before computing flag defaults, so each flag
	// can fall back to a RELAYIUM_* variable. Precedence: explicit CLI flag >
	// real environment variable > .env file > built-in default. The .env path
	// itself comes from a real env var (it can't be in the not-yet-loaded file).
	if err := loadDotEnv(envStr("RELAYIUM_ENV_FILE", ".env")); err != nil {
		log.Printf("WARNING: read env file: %v", err)
	}

	addr := flag.String("addr", envStr("RELAYIUM_ADDR", ":8080"), "listen address")
	static := flag.String("static", envStr("RELAYIUM_STATIC", "../web/dist"), "static files directory")
	dbPath := flag.String("db", envStr("RELAYIUM_DB", "relayium.db"), "SQLite database path (':memory:' for ephemeral)")
	baseURL := flag.String("base-url", envStr("RELAYIUM_BASE_URL", "http://localhost:8080"), "public base URL for links/redirects")
	googleID := flag.String("google-id", envStr("RELAYIUM_GOOGLE_ID", ""), "Google OAuth client ID")
	googleSecret := flag.String("google-secret", envStr("RELAYIUM_GOOGLE_SECRET", ""), "Google OAuth client secret")
	smtpAddr := flag.String("smtp-addr", envStr("RELAYIUM_SMTP_ADDR", ""), "SMTP host:port (empty = log magic links instead of emailing)")
	smtpFrom := flag.String("smtp-from", envStr("RELAYIUM_SMTP_FROM", "noreply@relayium.com"), "magic link From address")
	smtpUser := flag.String("smtp-user", envStr("RELAYIUM_SMTP_USER", ""), "SMTP username (set with -smtp-pass for authenticated providers; empty = unauthenticated relay)")
	smtpPass := flag.String("smtp-pass", envStr("RELAYIUM_SMTP_PASS", ""), "SMTP password (used with -smtp-user)")
	turnSecret := flag.String("turn-secret", envStr("RELAYIUM_TURN_SECRET", ""), "coturn static-auth-secret (empty disables TURN)")
	turnURLs := flag.String("turn-urls", envStr("RELAYIUM_TURN_URLS", ""), "comma-separated TURN URLs (e.g. turn:host:3478,turns:host:5349)")
	stunURLs := flag.String("stun-urls", envStr("RELAYIUM_STUN_URLS", "stun:stun.l.google.com:19302"), "comma-separated STUN URLs")
	turnRelays := flag.String("turn-relays", envStr("RELAYIUM_TURN_RELAYS", ""), `JSON array of TURN relays for the multi-relay pool, e.g. [{"id":"asia-tok","region":"asia","urls":["turn:tok:3478"],"secret":"..."}]; empty uses -turn-urls only (see docs/coturn.md)`)
	redisAddr := flag.String("redis-addr", envStr("RELAYIUM_REDIS_ADDR", ""), "Redis host:port for coturn relay-byte metering (empty disables)")
	nodeToken := flag.String("node-token", envStr("RELAYIUM_NODE_TOKEN", ""), "fleet bootstrap bearer token for relay-node /api/nodes/* (empty disables the node API)")
	enableUserNodes := flag.Bool("enable-user-nodes", envBool("RELAYIUM_ENABLE_USER_NODES", true), "serve per-user BYO node tokens (account-bound relay/storage nodes)")
	enableGoogle := flag.Bool("enable-google", envBool("RELAYIUM_ENABLE_GOOGLE", false), "enable Google OAuth login (disabled by default)")
	enableApple := flag.Bool("enable-apple", envBool("RELAYIUM_ENABLE_APPLE", false), "enable Sign in with Apple (disabled by default)")
	appleClientIDs := flag.String("apple-client-ids", envStr("RELAYIUM_APPLE_CLIENT_IDS", ""), "comma-separated Apple aud allowlist: app Bundle ID + web Services ID")
	appleAppIDs := flag.String("apple-app-ids", envStr("RELAYIUM_APPLE_APP_IDS", ""), "comma-separated Apple appIDs (<TeamID>.<BundleID>) for the Universal Links AASA file; empty = 404")
	appleServicesID := flag.String("apple-services-id", envStr("RELAYIUM_APPLE_SERVICES_ID", ""), "Apple Services ID (web Sign in with Apple client_id)")
	appleTeamID := flag.String("apple-team-id", envStr("RELAYIUM_APPLE_TEAM_ID", ""), "Apple Team ID (client_secret issuer)")
	appleKeyID := flag.String("apple-key-id", envStr("RELAYIUM_APPLE_KEY_ID", ""), "Apple .p8 Key ID (client_secret JWT kid)")
	applePrivKeyFile := flag.String("apple-private-key-file", envStr("RELAYIUM_APPLE_PRIVATE_KEY_FILE", ""), "path to the Apple Sign in with Apple .p8 private key")
	appleDomainAssoc := flag.String("apple-domain-assoc-file", envStr("RELAYIUM_APPLE_DOMAIN_ASSOC_FILE", ""), "path to apple-developer-domain-association.txt")
	enableMagic := flag.Bool("enable-magic", envBool("RELAYIUM_ENABLE_MAGIC", false), "enable email magic-link login (disabled by default)")
	adminUser := flag.String("admin-user", envStr("RELAYIUM_ADMIN_USER", "admin"), "admin dashboard username at /admin (defaults to 'admin')")
	adminPass := flag.String("admin-pass", envStr("RELAYIUM_ADMIN_PASS", ""), "admin dashboard password at /admin (empty disables the dashboard)")
	adminTOTPSecret := flag.String("admin-totp-secret", envStr("RELAYIUM_ADMIN_TOTP_SECRET", ""), "base32 TOTP secret for admin 2FA (empty disables 2FA)")
	genAdminTOTP := flag.Bool("gen-admin-totp", false, "generate a new admin TOTP secret + QR and exit")
	blobDir := flag.String("blob-dir", envStr("RELAYIUM_BLOB_DIR", "./blobs"), "directory for stored-transfer ciphertext blobs")
	maxFileSize := flag.Int64("max-file-size", envInt64("RELAYIUM_MAX_FILE_SIZE", 1<<30), "stored-transfer max single-file size in bytes (default 1 GiB)")
	nodeTrafficDefault := flag.Int64("node-traffic-default", envInt64("RELAYIUM_NODE_TRAFFIC_DEFAULT", 1<<40), "default monthly relay-traffic cap per official node in bytes, 0 = unlimited (default 1 TiB)")
	dailyQuota := flag.Int64("daily-quota", envInt64("RELAYIUM_DAILY_QUOTA", 200<<20), "stored-transfer per-account upload quota per 24h in bytes (default 200 MiB)")
	fileTTL := flag.Int64("file-ttl", envInt64("RELAYIUM_FILE_TTL", 86400), "stored-transfer default link TTL in seconds (default 1 day)")
	fileTTLMax := flag.Int64("file-ttl-max", envInt64("RELAYIUM_FILE_TTL_MAX", 604800), "stored-transfer max link TTL in seconds (default 7 days)")
	defaultRetention := flag.Int64("default-retention", envInt64("RELAYIUM_DEFAULT_RETENTION", 0),
		"stored-transfer default retention policy when an upload requests none: 0=burn, 1=ttl, 2=count")
	defaultMaxDownloads := flag.Int64("default-max-downloads", envInt64("RELAYIUM_DEFAULT_MAX_DOWNLOADS", 5),
		"stored-transfer default download-count cap used by the count retention policy (default 5)")
	maxMaxDownloads := flag.Int64("max-max-downloads", envInt64("RELAYIUM_MAX_MAX_DOWNLOADS", 100),
		"stored-transfer hard ceiling on a requested download-count cap (default 100)")
	accountGraceDays := flag.Int64("account-grace-days", envInt64("RELAYIUM_ACCOUNT_GRACE_DAYS", 30),
		"grace period in days between a self-deletion request and GC's hard purge of the account (default 30)")
	accountReminderDays := flag.Int64("account-purge-reminder-days", envInt64("RELAYIUM_ACCOUNT_PURGE_REMINDER_DAYS", 3),
		"days before purge the one-time pre-purge reminder email is sent (default 3)")
	trustedProxies := flag.String("trusted-proxies", envStr("RELAYIUM_TRUSTED_PROXIES", ""), "comma-separated CIDRs (or IPs) of reverse proxies whose X-Forwarded-For is trusted; empty (default) ignores XFF and uses the direct peer IP")
	blobDiskMax := flag.Int64("blob-disk-max", envInt64("RELAYIUM_BLOB_DISK_MAX", 0),
		"global blob-volume high-water mark in bytes; new uploads 503 once used >= this (0 disables the global soft cap)")
	stripeSecretKey := flag.String("stripe-secret-key", envStr("RELAYIUM_STRIPE_SECRET_KEY", ""), "Stripe secret API key (sk_...); empty disables billing (/api/billing/* 404)")
	stripeWebhookSecret := flag.String("stripe-webhook-secret", envStr("RELAYIUM_STRIPE_WEBHOOK_SECRET", ""), "Stripe webhook signing secret (whsec_...)")
	stripePortalConfig := flag.String("stripe-portal-config", envStr("RELAYIUM_STRIPE_PORTAL_CONFIG", ""), "Stripe Billing Portal configuration id (empty uses the account default)")
	// Deprecated and ignored: relay bandwidth is now bounded by each account's
	// per-plan monthly traffic quota (billing plans phase-1), not this global
	// allowance. Kept as an accepted-but-unused flag/env so a deployment whose
	// service unit or .env still passes -relay-monthly-free /
	// RELAYIUM_RELAY_MONTHLY_FREE keeps booting (flag.Parse fatals on an unknown
	// flag). Safe to drop from the host config at leisure.
	_ = flag.Int64("relay-monthly-free", envInt64("RELAYIUM_RELAY_MONTHLY_FREE", 0),
		"deprecated: superseded by per-plan monthly traffic quota; accepted but ignored")
	flag.Parse()

	if *genAdminTOTP {
		if err := generateAdminTOTP(*adminUser); err != nil {
			log.Fatalf("generate admin TOTP: %v", err)
		}
		return
	}

	// Not in Go's built-in MIME table; the PWA manifest should be served as JSON.
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")

	// Config validation must not depend on DB availability: a malformed
	// RELAYIUM_ADMIN_TOTP_SECRET should fail fast on every normal startup,
	// regardless of whether SQLite opens successfully.
	if err := account.ValidateAdminTOTPSecret(*adminTOTPSecret); err != nil {
		log.Fatalf("%v", err)
	}
	if *adminTOTPSecret != "" && *adminPass == "" {
		log.Printf("WARNING: RELAYIUM_ADMIN_TOTP_SECRET set but admin password empty; /admin disabled, 2FA ignored")
	}

	// Web Sign in with Apple's .p8 key must parse at boot, not on the first
	// login attempt — a broken key should never ship a login button that 500s.
	var applePrivKey *ecdsa.PrivateKey
	if *applePrivKeyFile != "" {
		raw, err := os.ReadFile(*applePrivKeyFile)
		if err != nil {
			log.Fatalf("apple: reading private key file %q: %v", *applePrivKeyFile, err)
		}
		applePrivKey, err = account.LoadApplePrivateKey(raw)
		if err != nil {
			log.Fatalf("apple: parsing private key %q: %v", *applePrivKeyFile, err)
		}
	}
	if *enableApple && *appleServicesID != "" {
		var missing []string
		if *appleTeamID == "" {
			missing = append(missing, "RELAYIUM_APPLE_TEAM_ID")
		}
		if *appleKeyID == "" {
			missing = append(missing, "RELAYIUM_APPLE_KEY_ID")
		}
		if applePrivKey == nil {
			missing = append(missing, "RELAYIUM_APPLE_PRIVATE_KEY_FILE")
		}
		if len(missing) > 0 {
			log.Fatalf("apple: web Sign in with Apple requires %s", strings.Join(missing, ", "))
		}
		// The web id_token's aud is the Services ID; verifyAppleIDToken checks it
		// against AppleClientIDs. Without this, /api/auth/methods reports apple:true
		// and boot succeeds, but every web login fails at callback with "aud not in
		// allowlist" — a broken button that only fails once a real user tries it.
		allowed := false
		for _, id := range splitURLs(*appleClientIDs) {
			if id == *appleServicesID {
				allowed = true
				break
			}
		}
		if !allowed {
			log.Fatal("apple: RELAYIUM_APPLE_SERVICES_ID must be included in RELAYIUM_APPLE_CLIENT_IDS")
		}
	}

	// X-Forwarded-For is only trusted from configured reverse proxies; otherwise
	// the direct peer IP is authoritative (see signal.IPExtractor). This value
	// keys the pairing-code rate limits and the LAN room grouping.
	trustedNets, err := parseTrustedProxies(*trustedProxies)
	if err != nil {
		log.Fatalf("%v", err)
	}
	ipx := signal.NewIPExtractor(trustedNets)
	// Loopback is always trusted (same-host reverse proxy); additional non-loopback
	// proxy CIDRs come from -trusted-proxies. Logged so a misconfigured deployment
	// (real client IPs showing as the proxy address) is diagnosable from the boot log.
	log.Printf("client-IP: X-Forwarded-For trusted from loopback + %d configured proxy CIDR(s)", len(trustedNets))

	hub := signal.NewHub()
	handle := signal.ServeWS(hub, newID)
	// Per-IP concurrent /ws connection cap (H4). Acquired after the room is
	// resolved and before the websocket upgrade; released when the handler returns.
	ipConns := signal.NewIPConnLimiter()

	// Anonymous, login-free pairing: short numeric codes for cross-network
	// realtime rendezvous. Pure in-memory — works even if the DB is unavailable.
	pairReg := signal.NewPairRegistry(900, func() int64 { return time.Now().Unix() }) // 15 min
	go pairReg.Run(context.Background(), time.Minute)
	pairLimiter := signal.NewRateLimiter(10, time.Minute, func() int64 { return time.Now().Unix() })
	go pairLimiter.Run(context.Background(), time.Minute)
	// Separate limiter for /ws code-join attempts: 30/min/IP caps brute-force of
	// the 10^6 code space while allowing a real recipient to reload a few times.
	wsCodeLimiter := signal.NewRateLimiter(30, time.Minute, func() int64 { return time.Now().Unix() })
	go wsCodeLimiter.Run(context.Background(), time.Minute)
	// Global (non-per-IP) breaker on INVALID pairing-code join attempts: sheds
	// brute-force load and signals attacks. It never affects valid-code joins.
	guessBreaker := signal.NewGuessBreaker(200, time.Minute, 30*time.Second, func() int64 { return time.Now().Unix() })
	// H1: /api/ice pairing-code → TURN-credential endpoint. 5/min/IP.
	iceLimiter := signal.NewRateLimiter(5, time.Minute, func() int64 { return time.Now().Unix() })
	go iceLimiter.Run(context.Background(), time.Minute)
	// H2a: register endpoint (email-bomb + Sybil surface). 5/min/IP.
	registerLimiter := signal.NewRateLimiter(5, time.Minute, func() int64 { return time.Now().Unix() })
	go registerLimiter.Run(context.Background(), time.Minute)

	store, dbErr := account.OpenSQLite(*dbPath)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		if code != "" && !wsCodeLimiter.Allow(ipx.IP(r)) {
			http.Error(w, "too many pairing attempts", http.StatusTooManyRequests)
			return
		}
		room, maxPeers, lan, ok := signal.RoomFor(code, pairReg.Validate)
		if !ok {
			// Invalid/expired code = a guess. Feed the global breaker; when it is
			// open, shed with 429 and a throttled WARN. Valid codes are unaffected.
			if code != "" {
				if open, logNow := guessBreaker.RecordInvalid(); open {
					if logNow {
						log.Printf("WARNING: pairing-code guess breaker OPEN — shedding invalid /ws?code= joins")
					}
					http.Error(w, "too many pairing attempts", http.StatusTooManyRequests)
					return
				}
			}
			http.Error(w, "invalid or expired pairing code", http.StatusForbidden)
			return
		}
		if lan {
			room = ipx.RoomKey(r)
			maxPeers = lanMaxPeers // LAN: capped (was unlimited)
		}
		ip := ipx.IP(r)
		if !ipConns.Acquire(ip) {
			http.Error(w, "too many connections", http.StatusTooManyRequests)
			return
		}
		defer ipConns.Release(ip)
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ctx := r.Context()
		handle(ctx, c, room, maxPeers, ip)
		_ = c.Close(websocket.StatusNormalClosure, "")
	})
	if dbErr != nil {
		// /api/pair mints cross-network pairing codes owned by a logged-in user, so
		// without accounts it is simply not registered — LAN transfer is unaffected.
		log.Printf("WARNING: open db: %v — account features disabled; LAN transfer unaffected", dbErr)
	} else {
		var mailer account.Mailer = &account.LogMailer{Log: log.Default()}
		if *smtpAddr != "" {
			mailer = account.NewSMTPMailer(*smtpAddr, *smtpFrom, *smtpUser, *smtpPass)
		}
		acct := account.NewService(store, mailer, account.Config{
			BaseURL:              *baseURL,
			SessionTTL:           720 * time.Hour, // 30 days
			MagicTTL:             15 * time.Minute,
			VerifyTTL:            24 * time.Hour,
			ResetTTL:             time.Hour,
			GoogleClientID:       *googleID,
			GoogleSecret:         *googleSecret,
			GoogleRedirect:       *baseURL + "/api/auth/google/callback",
			STUNURLs:             splitURLs(*stunURLs),
			TURNURLs:             splitURLs(*turnURLs),
			TURNSecret:           *turnSecret,
			TURNRelays:           parseTURNRelays(*turnRelays),
			TURNCredTTL:          time.Hour,
			EnableGoogle:         *enableGoogle,
			EnableApple:          *enableApple,
			AppleClientIDs:       splitURLs(*appleClientIDs),
			AppleServicesID:      *appleServicesID,
			AppleTeamID:          *appleTeamID,
			AppleKeyID:           *appleKeyID,
			AppleRedirect:        *baseURL + "/api/auth/apple/web/callback",
			ApplePrivateKey:      applePrivKey,
			AppleDomainAssocFile: *appleDomainAssoc,
			EnableMagic:          *enableMagic,
			AdminUser:            *adminUser,
			AdminPassword:        *adminPass,
			AdminTOTPSecret:      *adminTOTPSecret,
			MaxFileSize:          *maxFileSize,
			NodeTrafficDefault:   *nodeTrafficDefault,
			DailyQuota:           *dailyQuota,
			DefaultTTL:           *fileTTL,
			MaxTTL:               *fileTTLMax,
			DefaultRetention:     *defaultRetention,
			DefaultMaxDownloads:  *defaultMaxDownloads,
			MaxMaxDownloads:      *maxMaxDownloads,
			AccountGraceDays:     *accountGraceDays,
			AccountReminderDays:  *accountReminderDays,
			NodeToken:            *nodeToken,
			EnableUserNodes:      *enableUserNodes,
			StripeSecretKey:      *stripeSecretKey,
			StripeWebhookSecret:  *stripeWebhookSecret,
			StripePortalConfig:   *stripePortalConfig,
		})
		// Wire /api/ice to validate anonymous pairing codes so it can hand out
		// TURN credentials for them — otherwise code transfers are STUN-only
		// and fail across strict NATs.
		acct.SetPairCodeOwner(pairReg.OwnerOf)
		acct.SetClientIP(ipx.IP) // H3: trusted-proxy-aware rate-limit keys
		acct.SetICELimiter(iceLimiter)
		acct.SetRegisterLimiter(registerLimiter)
		// /api/pair requires a logged-in owner: the receiver still joins the code
		// room anonymously via /ws?code= and /api/ice?code=, but minting a
		// cross-network rendezvous code needs an account for attribution.
		mux.HandleFunc("POST /api/pair", signal.PairHandler(pairReg, pairLimiter, ipx,
			func(r *http.Request) (string, bool) {
				u, ok := acct.UserFromRequest(r)
				return u.ID, ok
			}))
		// Relay-node register/heartbeat: bearer-authenticated (not cookie/CSRF),
		// so mounted directly on the root mux like /api/pair above. No-op when
		// NodeToken is unset.
		acct.RegisterNodeRoutes(mux)
		if disk, derr := storage.NewDiskStore(*blobDir); derr != nil {
			log.Printf("WARNING: open blob dir %q: %v — stored transfers disabled", *blobDir, derr)
		} else {
			acct.SetBlobStore(disk)
			// M3b: global disk soft cap over the blob volume (0 = disabled).
			if *blobDiskMax > 0 {
				blobPath := *blobDir
				acct.SetDiskGuard(func() (uint64, uint64, error) { return storage.DiskUsage(blobPath) }, *blobDiskMax)
				log.Printf("global blob-disk soft cap: 503 once %d bytes used on %s volume", *blobDiskMax, blobPath)
			}
			// Sweep temp files orphaned by a crash mid-Put (write→rename); the GC
			// never reaps these. Anything older than an hour can't be an in-flight
			// upload, so it is safe to delete at startup.
			if removed, cerr := disk.CleanupTemp(time.Hour); cerr != nil {
				log.Printf("WARNING: cleanup orphaned temp blobs: %v", cerr)
			} else if removed > 0 {
				log.Printf("cleaned up %d orphaned temp blob(s)", removed)
			}
			if err := acct.SeedSettings(context.Background()); err != nil {
				log.Printf("WARNING: seed settings: %v", err)
			}
			if err := acct.SeedPlans(context.Background()); err != nil {
				log.Printf("WARNING: seed plans: %v", err)
			}
			if err := acct.MigrateFreeTrafficCap(context.Background()); err != nil {
				log.Printf("WARNING: migrate free traffic cap: %v", err)
			}
			gc := &account.GC{
				Store:          store,
				Blobs:          disk,
				Now:            func() int64 { return time.Now().Unix() },
				Log:            log.Default(),
				BlobFor:        acct.BlobForNode,
				Mailer:         mailer,
				ReminderWindow: acct.ReminderWindowSeconds,
				ReactivateLink: acct.IssueReactivateLink,
				ReapSessions:   acct.ReapPendingUploads,
			}
			go gc.Run(context.Background(), 10*time.Minute)
			log.Printf("stored transfers enabled: blobs in %s", *blobDir)
		}
		if *redisAddr != "" {
			worker := &metering.Worker{
				Sink: store,
				Now:  func() int64 { return time.Now().Unix() },
				Log:  log.Default(),
			}
			src := metering.NewRedisSource(*redisAddr)
			// The Redis source now reconnects internally, so Run only returns on a
			// setup error; retry so a startup blip can't permanently disable
			// metering. It exits cleanly (nil) only if the context is cancelled.
			go func() {
				for {
					err := worker.Run(context.Background(), src)
					if err == nil {
						return
					}
					log.Printf("metering worker error, retrying in 5s: %v", err)
					time.Sleep(5 * time.Second)
				}
			}()
			// M2: warn if metering is enabled but the coturn→redis pipe goes silent
			// (routine restart / reconnect gap is the common blinding case).
			const meterSilenceWarn = 5 * time.Minute
			go worker.Watchdog(context.Background(), time.Minute, meterSilenceWarn)
			log.Printf("metering: ingesting coturn relay stats from redis %s", *redisAddr)
		}
		mux.Handle("/api/", acct.Routes())
		acct.RegisterAdmin(mux)
	}

	// Universal Links / Sign in with Apple domain association. A more specific
	// pattern than "/", so it wins over the SPA fallback. Dormant (404) until
	// RELAYIUM_APPLE_APP_IDS is set.
	mux.HandleFunc("GET /.well-known/apple-app-site-association", appleAppSiteAssociation(splitURLs(*appleAppIDs)))
	mux.HandleFunc("GET /.well-known/apple-developer-domain-association.txt", appleDomainAssociation(*appleDomainAssoc))

	mux.Handle("/", spaHandler(*static))

	// Explicit timeouts instead of http.ListenAndServe's unbounded defaults.
	// ReadHeaderTimeout caps the request-header read phase, which is the Slowloris
	// surface, and — crucially — stops applying once /ws is hijacked into a
	// long-lived WebSocket, so it can't sever active transfers. IdleTimeout
	// reaps keep-alive connections that go silent. We deliberately set no
	// ReadTimeout/WriteTimeout: those cover the whole request/response and would
	// kill open WebSockets mid-session (the ping/pong keepalive in the WS handler
	// detects dead peers instead).
	srv := &http.Server{
		Addr:              *addr,
		Handler:           securityHeaders(mux),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("relayium signaling server listening on %s", *addr)
	log.Fatal(srv.ListenAndServe())
}

// generateAdminTOTP creates a fresh TOTP secret for the admin dashboard,
// prints a scannable terminal QR plus the raw secret/otpauth URL, and
// returns without starting the server.
func generateAdminTOTP(adminUser string) error {
	if adminUser == "" {
		adminUser = "admin"
	}
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      "Relayium",
		AccountName: adminUser,
		Period:      30,
		Digits:      otp.DigitsSix,
		Algorithm:   otp.AlgorithmSHA1,
	})
	if err != nil {
		return err
	}
	fmt.Println("扫描下面的二维码，或手动输入密钥到你的验证器 App：")
	fmt.Println()
	qrterminal.GenerateHalfBlock(key.URL(), qrterminal.L, os.Stdout)
	fmt.Println()
	fmt.Println("Secret (base32):", key.Secret())
	fmt.Println("otpauth URL:    ", key.URL())
	fmt.Println()
	fmt.Println("把 Secret 填入 RELAYIUM_ADMIN_TOTP_SECRET 后重启服务即可启用 2FA。")
	return nil
}
