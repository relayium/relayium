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
	"sync/atomic"
	"time"

	"github.com/mdp/qrterminal/v3"
	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
	"github.com/relayium/relayium/account"
	"github.com/relayium/relayium/internal/metering"
	"github.com/relayium/relayium/internal/signal"
	"github.com/relayium/relayium/internal/storage"
	"github.com/relayium/relayium/selfupdate"
)

const lanMaxPeers = 50 // LAN room peer cap (H4); tunable.

// releaseRepo is the GitHub repo the admin release check polls for the
// newest release tag. Same repo cmd/relayium-node/update.go:23 uses for its
// own updateRepo constant.
const releaseRepo = "relayium/relayium"

// sessionTTL 是登录会话的**绝对**有效期。没有空闲超时也没有滑动续期，所以这个数字
// 就是"一枚泄漏的 cookie 还能用多久"的上限，同时也是共用设备上"忘了登出"的窗口。
// 原来是 30 天，砍到 14 天：仍然覆盖正常使用节奏（两周内至少开一次），泄漏窗口减半。
//
// 只影响**新签发**的会话——已有的行在签发时就写死了 expires_at，按原值走完；
// cookie 的 Expires 取自同一个值，两边不会脱节。
const sessionTTL = 14 * 24 * time.Hour

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

// ── the deployment health surface ───────────────────────────────────────────
//
// The route patterns, the exact success bodies and the readiness failure modes
// below are the product half of an interface relayium-ops already depends on:
// its auto-deploy path polls http://127.0.0.1:8080/readyz after every restart
// and matches the body as a whole line, and a rollback is what happens when it
// does not. They are frozen in contracts/ops-deploy-v1.json, and
// ops_deploy_contract_test.go drives THESE handlers — not a copy of them —
// against that document.
//
// Extracted from main() for exactly that reason. Nothing else changed: same
// patterns, same order of checks, same statuses, same bodies, same timeout.

// healthzPath is the liveness route. `http.ServeMux` treats a pattern with no
// trailing slash as an exact match, so /healthz/ is deliberately NOT this route.
const healthzPath = "/healthz"

// readyzPath is the readiness route the deploy path polls.
const readyzPath = "/readyz"

// healthzBody and readyzBody are written WITHOUT a trailing newline. The deploy
// poll is `curl -sf ... | grep -qx ready`, which is satisfied either way — but
// the contract freezes what is actually sent, not what a particular consumer
// happens to tolerate.
//
// They are written for every method, including HEAD. net/http then suppresses
// the entity body of a HEAD response at the server, so a HEAD probe is accepted,
// answers 200 and carries the Content-Length — and delivers no bytes. That is
// the wire behaviour, and contracts/ops-deploy-v1.json's probe.bodylessMethods
// is where it is frozen.
const healthzBody = "ok"
const readyzBody = "ready"

// readyzDatabaseTimeout bounds the readiness database ping. It is deliberately
// short: a readiness probe that blocks is indistinguishable, to the deploy
// script's own timeout, from a server that never came up.
const readyzDatabaseTimeout = 2 * time.Second

// readinessProbe is the set of dependencies /readyz consults, resolved fresh on
// every request.
//
// A nil func is the "not available" state rather than a separate flag, so the
// two ways each dependency can be unready — absent, and present but failing —
// stay the two branches they have always been.
type readinessProbe struct {
	// pingDatabase is nil when the server started without a usable database.
	pingDatabase func(ctx context.Context) error
	// blobsReady is nil when the blob store is not open.
	blobsReady func() error
}

// registerHealthRoutes installs the liveness and readiness routes on mux.
//
// probe is called once per readiness request so that dependencies wired after
// registration are still observed.
func registerHealthRoutes(mux *http.ServeMux, probe func() readinessProbe) {
	mux.HandleFunc(healthzPath, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(healthzBody))
	})
	mux.HandleFunc(readyzPath, func(w http.ResponseWriter, r *http.Request) {
		p := probe()
		if p.pingDatabase == nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), readyzDatabaseTimeout)
		defer cancel()
		if err := p.pingDatabase(ctx); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		if p.blobsReady == nil {
			http.Error(w, "blob storage unavailable", http.StatusServiceUnavailable)
			return
		}
		if err := p.blobsReady(); err != nil {
			http.Error(w, "blob storage unavailable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(readyzBody))
	})
}

// defaultListenAddress is the central service's listen address when neither
// -addr nor RELAYIUM_ADDR overrides it. Its port is frozen in
// contracts/ops-deploy-v1.json: the deploy path's readiness poll and its
// post-restart API probe both address 127.0.0.1:8080 directly.
const defaultListenAddress = ":8080"

func main() {
	// Load an optional .env file before computing flag defaults, so each flag
	// can fall back to a RELAYIUM_* variable. Precedence: explicit CLI flag >
	// real environment variable > .env file > built-in default. The .env path
	// itself comes from a real env var (it can't be in the not-yet-loaded file).
	if err := loadDotEnv(envStr("RELAYIUM_ENV_FILE", ".env")); err != nil {
		log.Printf("WARNING: read env file: %v", err)
	}

	addr := flag.String("addr", envStr("RELAYIUM_ADDR", defaultListenAddress), "listen address")
	static := flag.String("static", envStr("RELAYIUM_STATIC", "../web/dist"), "static files directory")
	dbPath := flag.String("db", envStr("RELAYIUM_DB", "relayium.db"), "SQLite database path (':memory:' for ephemeral)")
	baseURL := flag.String("base-url", envStr("RELAYIUM_BASE_URL", "http://localhost:8080"), "public base URL for links/redirects")
	googleID := flag.String("google-id", envStr("RELAYIUM_GOOGLE_ID", ""), "Google OAuth client ID")
	googleSecret := flag.String("google-secret", envStr("RELAYIUM_GOOGLE_SECRET", ""), "Google OAuth client secret")
	smtpAddr := flag.String("smtp-addr", envStr("RELAYIUM_SMTP_ADDR", ""), "SMTP host:port (empty = log magic links instead of emailing)")
	smtpFrom := flag.String("smtp-from", envStr("RELAYIUM_SMTP_FROM", "noreply@relayium.com"), "magic link From address")
	smtpUser := flag.String("smtp-user", envStr("RELAYIUM_SMTP_USER", ""), "SMTP username (set with -smtp-pass for authenticated providers; empty = unauthenticated relay)")
	smtpPass := flag.String("smtp-pass", envStr("RELAYIUM_SMTP_PASS", ""), "SMTP password (used with -smtp-user)")
	mailTransport := flag.String("mail-transport", envStr("RELAYIUM_MAIL_TRANSPORT", mailTransportAuto),
		`mail transport: "auto" (SMTP when -smtp-addr is set, otherwise a REDACTED log), "smtp" (require SMTP; refuse to boot without -smtp-addr), or "dev-log-links" (print full credential links; requires no SMTP and a literal local base URL — local development only)`)
	turnSecret := flag.String("turn-secret", envStr("RELAYIUM_TURN_SECRET", ""), "coturn static-auth-secret (empty disables TURN)")
	turnURLs := flag.String("turn-urls", envStr("RELAYIUM_TURN_URLS", ""), "comma-separated TURN URLs (e.g. turn:host:3478,turns:host:5349)")
	// 默认留空：见下面 defaultSTUNFrom 的注释——默认值不再是第三方 STUN。
	stunURLs := flag.String("stun-urls", envStr("RELAYIUM_STUN_URLS", ""), "comma-separated STUN URLs (empty: derived from -turn-urls, since coturn answers STUN on the same host:port)")
	turnRelays := flag.String("turn-relays", envStr("RELAYIUM_TURN_RELAYS", ""), `JSON array of TURN relays for the multi-relay pool, e.g. [{"id":"asia-tok","region":"asia","urls":["turn:tok:3478"],"secret":"..."}]; empty uses -turn-urls only`)
	redisAddr := flag.String("redis-addr", envStr("RELAYIUM_REDIS_ADDR", ""), "Redis host:port for coturn relay-byte metering (empty disables)")
	nodeToken := flag.String("node-token", envStr("RELAYIUM_NODE_TOKEN", ""), "fleet bootstrap bearer token for relay-node /api/nodes/* (empty disables the node API)")
	enableUserNodes := flag.Bool("enable-user-nodes", envBool("RELAYIUM_ENABLE_USER_NODES", true), "serve per-user BYO node tokens (account-bound relay/storage nodes)")
	directDownload := flag.Bool("direct-download", envBool("RELAYIUM_DIRECT_DOWNLOAD", false), "redirect stored downloads straight to fleet nodes that advertise a public DownloadURL (default off = central proxies)")
	enablePreUpload := flag.Bool("enable-preupload", envBool("RELAYIUM_ENABLE_PREUPLOAD", false), "let a sender stage encrypted files against a pairing code while its room waits for a peer (default OFF. Before a peer joins, the room's own joinability deadlines govern. Once a peer joins, that ciphertext is retained for the room owner plan's retention snapshot, clamped to 1-14 days and measured from the later of the join and the last upload byte the server committed, so a transfer that is still moving bytes is never cut off by the clock. It ends sooner in three ways: the receiver completes it (server/account/pairroom_complete.go), the owning account releases the whole room by hand (GET /api/pair-rooms, DELETE /api/pair-rooms/{id}, server/account/pairroom_owner.go), or the account is deleted. Plan for the second: only a receiver whose browser writes the files to disk itself can complete at all, so every Firefox, Safari and phone receiver saves normally and completes nothing, and those abandoned rooms are reclaimed when their retention window runs out. See server/account/pairroom.go)")
	releaseCheck := flag.Bool("release-check", envBool("RELAYIUM_RELEASE_CHECK", true), "ask GitHub hourly for the newest release and offer it in /admin (default on; sends no instance data)")
	enableGoogle := flag.Bool("enable-google", envBool("RELAYIUM_ENABLE_GOOGLE", false), "enable Google OAuth login (disabled by default)")
	enableApple := flag.Bool("enable-apple", envBool("RELAYIUM_ENABLE_APPLE", false), "enable Sign in with Apple (disabled by default)")
	appleClientIDs := flag.String("apple-client-ids", envStr("RELAYIUM_APPLE_CLIENT_IDS", ""), "comma-separated Apple aud allowlist: app Bundle ID + web Services ID")
	appleAppIDs := flag.String("apple-app-ids", envStr("RELAYIUM_APPLE_APP_IDS", ""), "comma-separated Apple appIDs (<TeamID>.<BundleID>) for the Universal Links AASA file; empty = 404")
	appleServicesID := flag.String("apple-services-id", envStr("RELAYIUM_APPLE_SERVICES_ID", ""), "Apple Services ID (web Sign in with Apple client_id)")
	appleTeamID := flag.String("apple-team-id", envStr("RELAYIUM_APPLE_TEAM_ID", ""), "Apple Team ID (client_secret issuer)")
	appleKeyID := flag.String("apple-key-id", envStr("RELAYIUM_APPLE_KEY_ID", ""), "Apple .p8 Key ID (client_secret JWT kid)")
	applePrivKeyFile := flag.String("apple-private-key-file", envStr("RELAYIUM_APPLE_PRIVATE_KEY_FILE", ""), "path to the Apple Sign in with Apple .p8 private key")
	appleDomainAssoc := flag.String("apple-domain-assoc-file", envStr("RELAYIUM_APPLE_DOMAIN_ASSOC_FILE", ""), "path to apple-developer-domain-association.txt")
	// App Store PURCHASES, which share nothing with the Sign in with Apple flags
	// above — no Team ID, no .p8, no client secret. Empty (the default) means no
	// verifier is built, and BOTH App Store routes answer 503: the authenticated
	// intake POST /api/billing/apple/transaction and Apple's own
	// POST /api/apple/notifications. Set, the file must be complete or the server
	// refuses to boot. See server/apple_store.go.
	appleStoreConfig := flag.String("apple-store-config-file", envStr("RELAYIUM_APPLE_STORE_CONFIG_FILE", ""), "path to the App Store verifier's JSON config (environment, app identities, Apple root CA file); empty = OFF, and both POST /api/billing/apple/transaction and POST /api/apple/notifications answer 503")
	appleServerIssuer := flag.String("apple-server-api-issuer-id", envStr("RELAYIUM_APPLE_SERVER_API_ISSUER_ID", ""), "App Store Server API issuer id; required with App Store billing")
	appleServerKeyID := flag.String("apple-server-api-key-id", envStr("RELAYIUM_APPLE_SERVER_API_KEY_ID", ""), "App Store Server API key id; required with App Store billing")
	appleServerKeyFile := flag.String("apple-server-api-private-key-file", envStr("RELAYIUM_APPLE_SERVER_API_PRIVATE_KEY_FILE", ""), "App Store Server API ES256 .p8 key; required with App Store billing")
	appleServerAPIProbe := flag.Bool("apple-server-api-probe", false, "probe App Store Server API credentials and TEST delivery for every configured app/environment, then exit")
	appleServerAPIProbeEnvironment := flag.String("apple-server-api-probe-environment", "all", "probe target: all, Production, or Sandbox (used only with -apple-server-api-probe)")
	enableMagic := flag.Bool("enable-magic", envBool("RELAYIUM_ENABLE_MAGIC", false), "enable email magic-link login (disabled by default)")
	adminUser := flag.String("admin-user", envStr("RELAYIUM_ADMIN_USER", "admin"), "admin dashboard username at /admin (defaults to 'admin')")
	adminPass := flag.String("admin-pass", envStr("RELAYIUM_ADMIN_PASS", ""), "admin dashboard password at /admin (empty disables the dashboard)")
	adminTOTPSecret := flag.String("admin-totp-secret", envStr("RELAYIUM_ADMIN_TOTP_SECRET", ""), "base32 TOTP secret for admin 2FA (empty disables 2FA)")
	genAdminTOTP := flag.Bool("gen-admin-totp", false, "generate a new admin TOTP secret + QR and exit")
	blobDir := flag.String("blob-dir", envStr("RELAYIUM_BLOB_DIR", "./blobs"), "directory for stored-transfer ciphertext blobs")
	maxFileSize := flag.Int64("max-file-size", envInt64("RELAYIUM_MAX_FILE_SIZE", 1<<30), "stored-transfer max single-file size in bytes (default 1 GiB)")
	nodeTrafficDefault := flag.Int64("node-traffic-default", envInt64("RELAYIUM_NODE_TRAFFIC_DEFAULT", 1<<40), "default monthly relay-traffic cap per official node in bytes, 0 = unlimited (default 1 TiB)")
	rateLimitDivisor := flag.Int("rate-limit-divisor", int(envInt64("RELAYIUM_RATE_LIMIT_DIVISOR", 1)),
		"split per-instance abuse thresholds (login lockout, /api/ice, register, /ws, pairing breaker) across N round-robin instances; leave 1 for a single instance or an IP-hash LB (see the multi-instance-state-migration doc in relayium-ops, §7.5)")
	dailyQuota := flag.Int64("daily-quota", envInt64("RELAYIUM_DAILY_QUOTA", 200<<20), "stored-transfer per-account upload quota per 24h in bytes (default 200 MiB)")
	fileTTL := flag.Int64("file-ttl", envInt64("RELAYIUM_FILE_TTL", 86400), "stored-transfer default link TTL in seconds (default 1 day)")
	// Must be >= the longest plan retention (Max = 14 days in defaultPlans), or
	// this global clamp silently caps a paying user below what their plan — and
	// the pricing page — promises. planRetentionCap narrows it per tier; this is
	// only the outer bound. NOTE: SeedSettings writes this into the settings
	// table on FIRST boot only, so on an existing deployment the admin backend's
	// value wins and has to be raised there too.
	fileTTLMax := flag.Int64("file-ttl-max", envInt64("RELAYIUM_FILE_TTL_MAX", 1209600), "stored-transfer max link TTL in seconds (default 14 days — the longest plan retention)")
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
	// Deliberately long by default: the audit trail is read AFTER an incident,
	// and incidents surface late. See account.auditRetentionDefault.
	//
	// This window is NOT scoped to machine-written rows: shortening it deletes
	// ADMIN audit rows of that age too (the machine-row ceiling is the only
	// part that spares human rows). And it only takes effect at all when
	// stored transfers are enabled — GC, which runs the prune, is constructed
	// solely in that branch below.
	auditRetentionDays := flag.Int64("audit-retention-days", envInt64("RELAYIUM_AUDIT_RETENTION_DAYS", 730),
		"how long admin audit-log rows are kept, in days (default 730 = 2 years; 0 uses the built-in default); applies to ADMIN rows too, and only runs when stored transfers are enabled")
	trustedProxies := flag.String("trusted-proxies", envStr("RELAYIUM_TRUSTED_PROXIES", ""), "comma-separated CIDRs (or IPs) of reverse proxies whose X-Forwarded-For is trusted; empty (default) ignores XFF and uses the direct peer IP")
	blobDiskMax := flag.Int64("blob-disk-max", envInt64("RELAYIUM_BLOB_DISK_MAX", 0),
		"global blob-volume high-water mark in bytes; new uploads 503 once used >= this (0 disables the global soft cap)")
	stripeSecretKey := flag.String("stripe-secret-key", envStr("RELAYIUM_STRIPE_SECRET_KEY", ""), "Stripe secret API key (sk_...); empty disables billing (/api/billing/* 404)")
	stripeWebhookSecret := flag.String("stripe-webhook-secret", envStr("RELAYIUM_STRIPE_WEBHOOK_SECRET", ""), "Stripe webhook signing secret (whsec_...)")
	stripePortalConfig := flag.String("stripe-portal-config", envStr("RELAYIUM_STRIPE_PORTAL_CONFIG", ""), "required dedicated Stripe Billing Portal configuration id; plan switching disabled and cancellation at period end")
	billingHoldSecret := flag.String("billing-hold-secret", envStr("RELAYIUM_BILLING_HOLD_SECRET", ""), "HMAC secret for bounded post-deletion billing holds")
	billingDeletionRefund := flag.String("billing-deletion-refund", "", "operator-only: cancellation outbox id whose audited manual resource must be refunded, then exit")
	billingDeletionMetered := flag.String("billing-deletion-metered", "", "operator-only: cancellation outbox id whose metered subscription must be reconciled and canceled, then exit")
	billingDeletionList := flag.String("billing-deletion-list", "", "operator-only: list sanitized cancellation evidence for one outbox id, then exit")
	billingDeletionResource := flag.String("billing-deletion-resource", "", "operator-only: exact kind:id journal resource selected for -billing-deletion-refund")
	billingDeletionActor := flag.String("billing-deletion-actor", "", "operator-only: accountable actor for a manual billing refund")
	billingDeletionReason := flag.String("billing-deletion-reason", "", "operator-only: audited reason for a manual billing refund")
	billingDuplicateList := flag.String("billing-duplicate-list", "", "operator-only: list sanitized duplicate-refund evidence for one job or duplicate subscription, then exit")
	billingDuplicateRefund := flag.String("billing-duplicate-refund", "", "operator-only: resolve one durable manual duplicate refund job or subscription, then exit")
	billingDuplicateActor := flag.String("billing-duplicate-actor", "", "operator-only: accountable actor for a duplicate refund")
	billingDuplicateReason := flag.String("billing-duplicate-reason", "", "operator-only: audited reason for a duplicate refund")
	billingDuplicateExpectedLiabilityRevision := flag.Int64("billing-duplicate-expected-liability-revision", -1, "operator-only: exact liability revision printed by -billing-duplicate-list")
	billingDuplicateExpectedDigest := flag.String("billing-duplicate-expected-digest", "", "operator-only: exact liability digest printed by -billing-duplicate-list")
	billingAppleLegacyList := flag.String("billing-apple-legacy-list", "", "operator-only: list sanitized recovery evidence for one legacy Apple attempt id or account email, then exit")
	billingAppleLegacyRelease := flag.String("billing-apple-legacy-release", "", "operator-only: release one evidence-approved legacy Apple attempt id or account email, then exit")
	billingAppleLegacyActor := flag.String("billing-apple-legacy-actor", "", "operator-only: accountable actor for a legacy Apple purchase release")
	billingAppleLegacyReason := flag.String("billing-apple-legacy-reason", "", "operator-only: owner-approved reason for a legacy Apple purchase release")
	billingAppleLegacyExpectedDigest := flag.String("billing-apple-legacy-expected-digest", "", "operator-only: exact digest printed by -billing-apple-legacy-list")
	// Deprecated and ignored: relay bandwidth is now bounded by each account's
	// per-plan monthly traffic quota (billing plans phase-1), not this global
	// allowance. Kept as an accepted-but-unused flag/env so a deployment whose
	// service unit or .env still passes -relay-monthly-free /
	// RELAYIUM_RELAY_MONTHLY_FREE keeps booting (flag.Parse fatals on an unknown
	// flag). Safe to drop from the host config at leisure.
	_ = flag.Int64("relay-monthly-free", envInt64("RELAYIUM_RELAY_MONTHLY_FREE", 0),
		"deprecated: superseded by per-plan monthly traffic quota; accepted but ignored")
	flag.Parse()
	if *stripeSecretKey != "" && *stripePortalConfig == "" {
		log.Fatal("RELAYIUM_STRIPE_PORTAL_CONFIG is required when Stripe billing is enabled")
	}
	if (*stripeSecretKey != "" || *appleStoreConfig != "") && *billingHoldSecret == "" {
		log.Fatal("RELAYIUM_BILLING_HOLD_SECRET is required when provider billing is enabled")
	}

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

	// Mail transport is resolved here, for the same reason: a contradictory
	// mail configuration must be a failed boot on every startup, not a surprise
	// the first time someone asks for a password reset. The plan is also what
	// authorizes plaintext links, so it is decided once, before anything else
	// can read the flags.
	mailCfg, err := planMail(*mailTransport, *smtpAddr, *smtpFrom, *smtpUser, *baseURL)
	if err != nil {
		log.Fatalf("mail: %v", err)
	}
	log.Print(mailCfg.Summary)
	for _, w := range mailCfg.Warnings {
		log.Print(w)
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

	// App Store transaction verification, read and BUILT here — for the same
	// reason as the .p8 above, and one more. A trust file that is missing, a
	// bundle id that is a typo or an environment that is spelled "production"
	// must fail on every startup, not on the first purchase; and the deployment
	// that discovers it must not be the one whose customer has already paid.
	// Nothing is installed yet: the account service does not exist here, and the
	// verifier only reaches it below (appleStore.install). An unconfigured
	// deployment — every current one — gets the zero value and no verifier at
	// all, which is what keeps POST /api/billing/apple/transaction on 503.
	appleStore, err := loadAppleStore(*appleStoreConfig)
	if err != nil {
		// The message already names the rule and the file; it is not wrapped
		// again here, because a boot failure is read in a hurry.
		log.Fatalf("%v", err)
	}
	var appleSubscriptionAPI *account.AppleServerAPIClient
	if appleStore.verifier != nil {
		if *appleServerIssuer == "" || *appleServerKeyID == "" || *appleServerKeyFile == "" {
			log.Fatal("App Store billing requires RELAYIUM_APPLE_SERVER_API_ISSUER_ID, RELAYIUM_APPLE_SERVER_API_KEY_ID, and RELAYIUM_APPLE_SERVER_API_PRIVATE_KEY_FILE")
		}
		raw, readErr := os.ReadFile(*appleServerKeyFile)
		if readErr != nil {
			log.Fatalf("apple: reading App Store Server API key: %v", readErr)
		}
		key, keyErr := account.LoadApplePrivateKey(raw)
		if keyErr != nil {
			log.Fatalf("apple: parsing App Store Server API key: %v", keyErr)
		}
		appleSubscriptionAPI, err = account.NewAppleServerAPIClient(account.AppleServerAPIConfig{IssuerID: *appleServerIssuer, KeyID: *appleServerKeyID, PrivateKey: key}, appleStore.verifier)
		if err != nil {
			log.Fatalf("apple: App Store Server API configuration: %v", err)
		}
	}
	if *appleServerAPIProbe {
		if appleSubscriptionAPI == nil || len(appleStore.probeApps) == 0 {
			log.Fatal("apple probe: App Store verifier, API credentials, and at least one app are required")
		}
		selected, selectErr := account.ParseAppleProbeEnvironment(*appleServerAPIProbeEnvironment)
		if selectErr != nil {
			log.Fatalf("apple probe: %v", selectErr)
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(len(appleStore.probeApps)*len(appleStore.verifier.Environments()))*2*time.Minute)
		defer cancel()
		if err := appleSubscriptionAPI.ProbeTestNotificationsFor(ctx, appleStore.probeApps, selected, os.Stdout); err != nil {
			log.Fatalf("apple probe: %v", err)
		}
		return
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
	// Pre-upload lifecycle hook. A pairing code whose sender staged files while
	// waiting has ciphertext bound to it with a five-minute join deadline, and the
	// only trustworthy witness that somebody actually joined is this server's own
	// view of the room — see account.Service.MarkPairRoomJoined for why a client
	// claim is not acceptable here.
	//
	// Held behind an atomic because /ws is registered before the account service
	// exists (and the service does not exist at all when the database is down, in
	// which case a code room simply has no pre-uploaded ciphertext to bind). The
	// observer runs on the connection's read goroutine, so the actual work is
	// handed to a goroutine: a database write must never delay a peer's join.
	var pairJoined atomic.Pointer[func(code string)]
	handle := signal.ServeWSObserved(hub, newID, func(room string, peers int) {
		if peers < 2 {
			return // the minter's own connection; nobody has joined yet
		}
		// The prefix alone is not proof. A LAN room's name is the client's IP
		// address, and an IPv6 address can legitimately begin "c:" (e.g. "c::1"),
		// so the remainder has to actually be a pairing code before this is
		// treated as one. Cheap, and it keeps every LAN join off the database.
		code, isPair := strings.CutPrefix(room, signal.PairRoomPrefix)
		if !isPair || !signal.ValidCodeFormat(code) {
			return
		}
		if fn := pairJoined.Load(); fn != nil {
			go (*fn)(code)
		}
	})
	// Per-IP concurrent /ws connection cap (H4). Acquired after the room is
	// resolved and before the websocket upgrade; released when the handler returns.
	ipConns := signal.NewIPConnLimiter()
	// Global concurrent /ws connection cap (L8), independent of client IP: the
	// per-IP cap above stops one address from hogging the server, but an
	// attacker who rotates source IPs gets a fresh budget from every new one,
	// and nothing bounded the sum. See signal.maxGlobalConns for the derivation.
	//
	// Deliberately NOT wrapped in account.PerInstanceThreshold like the rate
	// limiters below: dividing reconstructs a correct global figure only for
	// something that resets over a time window, so round-robin skew averages
	// out every cycle (see PerInstanceThreshold's doc). A live concurrency
	// gauge has no window to average over — a connection opened on instance A
	// simply stays counted there for its whole (possibly hours-long) lifetime,
	// so an unlucky run of routing could park one instance well above n/N with
	// nothing to correct it. IPConnLimiter above is the same kind of gauge and
	// is likewise never divided; this follows that precedent. The tradeoff:
	// in a round-robin multi-instance deployment this cap is enforced
	// per-process rather than truly globally (each instance can independently
	// admit up to maxGlobalConns), so the effective ceiling is instances ×
	// maxGlobalConns. sticky/IP-hash routing (the deployment's recommended
	// setup per PerInstanceThreshold's doc) avoids this entirely, and even
	// round-robin still bounds the total to a small multiple of the intended
	// figure rather than leaving it unbounded.
	globalConns := signal.NewGlobalConnLimiter()

	// Short codes for cross-network realtime rendezvous. Minting one requires a
	// signed-in account: POST /api/pair resolves a session cookie (web) or a CLI
	// bearer token, so the code has an owner to attribute relay usage to (see
	// pairUser and the route registration below). JOINING the code's room is
	// anonymous — the receiver signs in nowhere, it just presents the code to
	// /ws?code= and /api/ice?code=. A code is exactly signal.CodeLen decimal
	// digits (signal.CodeAlphabet), so every client can offer a numeric keypad
	// and the copy can say "six digits" without listing an alphabet. Note this is
	// NOT the same six digits as the SAS: the code admits you to the room, the
	// SAS authenticates the peer keys.
	// Pure in-memory — works even if the DB is unavailable.
	// TTL 是 signal.CodeTTLSeconds（5 分钟），理由写在那个常量上；导出成常量是因为
	// CLI 的报错文案要照着说「有效 5 分钟」，行为和文案必须取自同一个来源。
	pairReg := signal.NewPairRegistry(signal.CodeTTLSeconds, func() int64 { return time.Now().Unix() })
	go pairReg.Run(context.Background(), time.Minute)
	// div lowers the per-instance thresholds below for a round-robin multi-instance
	// deployment; 1 (the default, and correct for a single instance or an IP-hash
	// LB) leaves them unchanged. See account.PerInstanceThreshold / spec §7.5.
	div := *rateLimitDivisor
	pairLimiter := signal.NewRateLimiter(account.PerInstanceThreshold(10, div), time.Minute, func() int64 { return time.Now().Unix() })
	go pairLimiter.Run(context.Background(), time.Minute)
	// Separate limiter for /ws code-join attempts. The budget and the reasoning
	// live on wsJoinPerIPPerMinute (wsroute.go), next to the handler that spends
	// it; it is deliberately the same figure as iceLimiter below.
	wsCodeLimiter := signal.NewRateLimiter(account.PerInstanceThreshold(wsJoinPerIPPerMinute, div), time.Minute, func() int64 { return time.Now().Unix() })
	go wsCodeLimiter.Run(context.Background(), time.Minute)
	// Global (non-per-IP) breaker on INVALID pairing-code join attempts: sheds
	// brute-force load and signals attacks. It never affects valid-code joins —
	// which is also why it is not a ceiling on guessing (see GuessBreaker).
	// The breaker is global (not per-IP), so IP-hash routing can't consolidate it
	// across instances — dividing its trip threshold is the main use of the divisor.
	guessBreaker := signal.NewGuessBreaker(account.PerInstanceThreshold(200, div), time.Minute, 30*time.Second, func() int64 { return time.Now().Unix() })
	// H1: /api/ice pairing-code → TURN-credential endpoint. Per-endpoint REQUEST
	// cap, 5/min/IP — same figure as the /ws request cap so neither endpoint is
	// the looser path for repeated-request load.
	iceLimiter := signal.NewRateLimiter(account.PerInstanceThreshold(5, div), time.Minute, func() int64 { return time.Now().Unix() })
	go iceLimiter.Run(context.Background(), time.Minute)
	// The cross-endpoint cap on how many DIFFERENT codes one address may try.
	// ONE object, wired into both /ws (below) and /api/ice (SetCodeGuessLimiter):
	// they are two halves of a single validity oracle, and while each held its own
	// budget an attacker who split guesses between them got the sum — about 10
	// candidates a minute from one address against a 1e6 code space, twice the
	// number the design claimed. Sharing the object is the fix; do not give either
	// endpoint its own. Per-process, like every limiter here (see
	// PerInstanceThreshold for the multi-instance caveat).
	codeGuessBudget := signal.NewCodeGuessLimiter(account.PerInstanceThreshold(pairingGuessesPerIPPerMinute, div), time.Minute, func() int64 { return time.Now().Unix() })
	go codeGuessBudget.Run(context.Background(), time.Minute)
	// H2a: register endpoint (email-bomb + Sybil surface). 5/min/IP.
	registerLimiter := signal.NewRateLimiter(account.PerInstanceThreshold(5, div), time.Minute, func() int64 { return time.Now().Unix() })
	go registerLimiter.Run(context.Background(), time.Minute)

	// Admin passkey */begin: 10/min/IP is generous for a human (one begin per
	// login) yet caps a begin-flood that would otherwise fill the ceremony table.
	passkeyBeginLimiter := signal.NewRateLimiter(account.PerInstanceThreshold(10, div), time.Minute, func() int64 { return time.Now().Unix() })
	go passkeyBeginLimiter.Run(context.Background(), time.Minute)

	// Blob downloads are proxied through central, so bound the per-IP request rate
	// on the public /api/files/{id}/blob endpoint. 120/min/IP is generous for a
	// human (or a resuming multi-GET download of one big file) yet blunts a single
	// source hammering a public link to amplify central egress. Metering (charged
	// to the file owner) is the primary cap; this is defence-in-depth against a
	// burst before the eventually-consistent traffic gate reacts.
	downloadLimiter := signal.NewRateLimiter(account.PerInstanceThreshold(120, div), time.Minute, func() int64 { return time.Now().Unix() })
	go downloadLimiter.Run(context.Background(), time.Minute)

	store, dbErr := account.OpenSQLite(*dbPath)
	if *billingAppleLegacyList != "" {
		if dbErr != nil || store == nil {
			log.Fatal("Apple legacy purchase evidence: database unavailable")
		}
		evidence, err := account.ListAppleLegacyPurchaseRecoveryEvidence(context.Background(), store, *billingAppleLegacyList)
		if err != nil {
			log.Fatalf("Apple legacy purchase evidence: %v", err)
		}
		log.Printf("Apple legacy purchase evidence: attempt=%s bundle=%s product=%s state=%s continuation=%q authority_environment=%q authority_epoch=%d subjects=%d sources=%d renewals=%d external_subjects=%d incidents=%d eligible=%t blockers=%v digest=%s", evidence.AttemptID, evidence.BundleID, evidence.ProductID, evidence.AttemptState, evidence.ContinuationState, evidence.AuthorityEnvironment, evidence.AuthorityEpoch, evidence.SubjectCount, evidence.SourceCount, evidence.RenewalCount, evidence.ExternalSubjectCount, evidence.IncidentCount, evidence.Eligible, evidence.Blockers, evidence.Digest)
		return
	}
	if *billingAppleLegacyRelease != "" {
		if dbErr != nil || store == nil {
			log.Fatal("Apple legacy purchase release: database unavailable")
		}
		result, err := account.ReleaseAppleLegacyPurchase(context.Background(), store, *billingAppleLegacyRelease, *billingAppleLegacyActor, *billingAppleLegacyReason, *billingAppleLegacyExpectedDigest)
		if err != nil {
			log.Fatalf("Apple legacy purchase release: %v", err)
		}
		log.Printf("Apple legacy purchase release: attempt=%s next_authority_epoch=%d status=succeeded", result.AttemptID, result.Epoch)
		return
	}
	if *billingDuplicateList != "" {
		if dbErr != nil || store == nil {
			log.Fatal("billing duplicate list: database unavailable")
		}
		evidence, err := account.ListDuplicateRefundEvidence(context.Background(), store, *billingDuplicateList)
		if err != nil {
			log.Fatalf("billing duplicate list: %v", err)
		}
		log.Printf("billing duplicate evidence: job=%s duplicate_subscription=%s canonical_subscription=%s invoice=%s state=%s canceled=%t resolution=%s attempts=%d revision=%d liability_revision=%d liability_digest=%s manual_reason=%s has_error=%t payments=%d action=%s action_state=%s action_generation=%d", evidence.JobID, evidence.DuplicateSubscriptionID, evidence.CanonicalSubscriptionID, evidence.InvoiceID, evidence.State, evidence.SubscriptionCanceled, evidence.Resolution, evidence.Attempts, evidence.Revision, evidence.LiabilityRevision, evidence.LiabilityDigest, evidence.ManualReason, evidence.HasError, len(evidence.Payments), evidence.ActionID, evidence.ActionState, evidence.ActionGeneration)
		for _, liability := range evidence.Liabilities {
			log.Printf("billing duplicate invoice: invoice=%s status=%s amount_paid=%d manual_reason=%s payments=%d", liability.InvoiceID, liability.Status, liability.AmountPaid, liability.ManualReason, len(liability.Payments))
			for _, payment := range liability.Payments {
				log.Printf("billing duplicate payment: invoice=%s invoice_payment=%s type=%s payment_intent=%s payment_record=%s charge=%s amount=%d refunded=%d", liability.InvoiceID, payment.InvoicePaymentID, payment.PaymentType, payment.PaymentIntentID, payment.PaymentRecordID, payment.ChargeID, payment.AmountPaid, payment.AmountRefunded)
			}
		}
		return
	}
	if *billingDuplicateRefund != "" {
		if dbErr != nil || store == nil || *stripeSecretKey == "" {
			log.Fatal("billing duplicate refund: database or Stripe unavailable")
		}
		result, err := account.ResolveDuplicateRefund(context.Background(), store, account.NewStripeClient(*stripeSecretKey, *stripeWebhookSecret, *stripePortalConfig), *billingDuplicateRefund, *billingDuplicateActor, *billingDuplicateReason, *billingDuplicateExpectedLiabilityRevision, *billingDuplicateExpectedDigest)
		if err != nil {
			log.Fatalf("billing duplicate refund: %v", err)
		}
		log.Printf("billing duplicate refund: action=%s state=%s", result.ActionID, result.State)
		return
	}
	if *billingDeletionList != "" {
		if dbErr != nil || store == nil {
			log.Fatalf("billing deletion list: database unavailable")
		}
		evidence, err := account.ListBillingDeletionManualEvidence(context.Background(), store, *billingDeletionList)
		if err != nil {
			log.Fatalf("billing deletion list: %v", err)
		}
		log.Printf("billing deletion evidence: outbox=%s subject=%s generation=%d state=%s cutoff=%d resources=%d", evidence.OutboxID, evidence.SubjectID, evidence.Generation, evidence.State, evidence.CreatedAt, len(evidence.Resources))
		for _, resource := range evidence.Resources {
			log.Printf("billing deletion resource: kind=%s id=%s status=%s created=%d manual=%t terminal=%t", resource.Kind, resource.ID, resource.Status, resource.ProviderCreatedAt, resource.Manual, resource.Terminal)
		}
		return
	}
	if *billingDeletionRefund != "" {
		if dbErr != nil || store == nil {
			log.Fatalf("billing deletion refund: database unavailable")
		}
		if *stripeSecretKey == "" {
			log.Fatal("billing deletion refund: Stripe is not configured")
		}
		result, err := account.ResolveBillingDeletionRefund(context.Background(), store, account.NewStripeClient(*stripeSecretKey, *stripeWebhookSecret, *stripePortalConfig), *billingDeletionRefund, *billingDeletionResource, *billingDeletionActor, *billingDeletionReason)
		if err != nil {
			log.Fatalf("billing deletion refund: %v", err)
		}
		log.Printf("billing deletion refund: action=%s refund=%s status=%s", result.ActionID, result.RefundID, result.Status)
		return
	}
	if *billingDeletionMetered != "" {
		if dbErr != nil || store == nil || *stripeSecretKey == "" {
			log.Fatal("billing deletion metered reconciliation: database or Stripe unavailable")
		}
		if err := account.ResolveBillingDeletionMetered(context.Background(), store, account.NewStripeClient(*stripeSecretKey, *stripeWebhookSecret, *stripePortalConfig), *billingDeletionMetered, *billingDeletionResource, *billingDeletionActor, *billingDeletionReason); err != nil {
			log.Fatalf("billing deletion metered reconciliation: %v", err)
		}
		log.Printf("billing deletion metered reconciliation: outbox=%s resource=%s status=succeeded", *billingDeletionMetered, *billingDeletionResource)
		return
	}
	var readyBlobs *storage.DiskStore

	mux := http.NewServeMux()
	// Liveness and readiness. The bodies, statuses, exact route patterns and the
	// two-second database bound are frozen in contracts/ops-deploy-v1.json,
	// because the production deploy path polls /readyz and treats anything else
	// as a failed release. The closure is read PER REQUEST, not captured once:
	// readyBlobs is still nil here and is assigned further down, so a probe that
	// snapshotted it would report "blob storage unavailable" forever.
	registerHealthRoutes(mux, func() readinessProbe {
		probe := readinessProbe{}
		if dbErr == nil && store != nil {
			probe.pingDatabase = store.Ping
		}
		if readyBlobs != nil {
			probe.blobsReady = readyBlobs.Ready
		}
		return probe
	})
	mux.HandleFunc("/ws", wsRoute{
		reqLimiter:   wsCodeLimiter,
		guessBudget:  codeGuessBudget,
		guessBreaker: guessBreaker,
		ipx:          ipx,
		validate:     pairReg.Validate,
		globalConns:  globalConns,
		ipConns:      ipConns,
		handle:       handle,
		lanMaxPeers:  lanMaxPeers,
	}.handler())
	if dbErr != nil {
		// /api/pair mints cross-network pairing codes owned by a logged-in user, so
		// without accounts it is simply not registered — LAN transfer is unaffected.
		log.Printf("WARNING: open db: %v — account features disabled; LAN transfer unaffected", dbErr)
	} else {
		// The ONLY production construction of a link-revealing LogMailer. Its
		// RevealLinks value comes from the validated plan above, never from a
		// flag read here — see planMail for the three conditions that must hold
		// together before it can be true.
		var mailer account.Mailer = &account.LogMailer{Log: log.Default(), RevealLinks: mailCfg.RevealLinks}
		if mailCfg.UseSMTP {
			mailer = account.NewSMTPMailer(*smtpAddr, *smtpFrom, *smtpUser, *smtpPass)
		}
		acct := account.NewService(store, mailer, account.Config{
			RateLimitDivisor:     div,
			BaseURL:              *baseURL,
			SessionTTL:           sessionTTL,
			MagicTTL:             15 * time.Minute,
			VerifyTTL:            24 * time.Hour,
			ResetTTL:             time.Hour,
			GoogleClientID:       *googleID,
			GoogleSecret:         *googleSecret,
			GoogleRedirect:       *baseURL + "/api/auth/google/callback",
			STUNURLs:             defaultSTUNFrom(splitURLs(*stunURLs), splitURLs(*turnURLs)),
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
			BillingHoldSecret:    *billingHoldSecret,
			ReleaseCheck:         *releaseCheck,
		})
		if *stripeSecretKey != "" {
			if err := acct.ValidateStripeCatalog(context.Background()); err != nil {
				log.Fatalf("Stripe catalog preflight: %v", err)
			}
		}
		// The live pairing-code registry, whole. Two things need it, and they need
		// to be looking at the SAME object:
		//
		//   - /api/ice resolves an anonymous code to its owner so it can hand out
		//     TURN credentials for it — otherwise code transfers are STUN-only and
		//     fail across strict NATs.
		//   - the pre-upload lifecycle keeps a code alive for as long as the room
		//     it names is joinable, and takes it away when that room is void. A
		//     code that expired on its own five-minute mint TTL while its upload
		//     was still running would leave ciphertext behind a credential nobody
		//     can present (server/account/pairroom.go, syncPairCode).
		acct.SetPairCodes(pairReg)
		// Pre-upload (staging ciphertext against a waiting code) is opt-in and off
		// by default: turning it on is a standing storage commitment, not a
		// half-built feature. Both feature-specific exits are built and tested.
		//
		// Receiver completion stays the authoritative end of a joined room: its
		// ciphertext goes when the receiver completes it (pairroom_complete.go),
		// when the account releases the room (pairroom_owner.go), or when the
		// account is deleted. Only a receiver whose browser writes files to disk
		// itself may complete, so every Firefox, Safari and phone receiver saves
		// its files and completes nothing.
		//
		// Those rooms are no longer held forever. A joined room also carries the
		// owner plan's retention snapshot as a deadline, refreshed by genuine
		// committed upload progress (server/account/pairroom.go,
		// pairRoomJoinedExpiry), so a transfer that is still moving bytes is never
		// cut off by the clock while an abandoned room is reclaimed when its
		// retention window runs out. The commitment is bounded by that window.
		acct.SetPreUpload(*enablePreUpload)
		if *enablePreUpload {
			log.Printf("pairing-code pre-upload: ENABLED - a joined room's ciphertext is retained for the room owner plan's retention snapshot, and genuine upload progress refreshes that deadline; it goes sooner when its receiver completes it, when the account releases the room (DELETE /api/pair-rooms/{id}), or when the account is deleted. Receivers that cannot write files to disk themselves (Firefox, Safari, phones) save normally and complete nothing, so those abandoned rooms are reclaimed when their retention window runs out")
		}
		// Now that the lifecycle owner exists, let the /ws join observer above
		// reach it. Bounded context: this is a background write, and a stuck
		// database must not leave a goroutine per join alive forever.
		//
		// The failure is REPORTED here rather than swallowed inside the account
		// layer, and it is not the end of the matter: MarkPairRoomJoined queues an
		// observation it could not persist, the retry loop below finishes it, and
		// until it does the room is not voided on the deadline it should already
		// have shed. The websocket join itself is never affected — the peers are
		// connected either way; what is at stake is only the ciphertext staged for
		// them.
		markJoined := func(code string) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := acct.MarkPairRoomJoined(ctx, code); err != nil {
				log.Printf("pairing code %s was joined but the lifecycle write failed (queued for retry): %v", code, err)
			}
		}
		pairJoined.Store(&markJoined)
		// Short ticker, not the ten-minute GC: a queued join holds its code's only
		// room slot until it lands, and the room it belongs to is held out of every
		// void path meanwhile. Nothing expires the observation itself (see
		// pairJoinQueue), so this is about landing it promptly, not beating a clock.
		//
		// Started whatever -enable-preupload says, on purpose. The queue only ever
		// receives an entry when a room exists to be joined, so with the feature off
		// this is a map read every fifteen seconds — and a queue that can fill with
		// no drainer running is worth a great deal more than that. It also keeps
		// rooms opened before the flag was turned OFF from losing their joins.
		go acct.RunPairJoinRetries(context.Background(), 15*time.Second)
		acct.SetClientIP(ipx.IP) // H3: trusted-proxy-aware rate-limit keys
		acct.SetICELimiter(iceLimiter)
		// The same object the /ws route holds: one distinct-code budget per IP
		// across both validity oracles, not one per endpoint.
		acct.SetCodeGuessLimiter(codeGuessBudget)
		acct.SetGuessBreaker(guessBreaker) // shared /ws breaker: /api/ice feeds it, /ws sheds on it
		acct.SetRegisterLimiter(registerLimiter)
		acct.SetPasskeyBeginLimiter(passkeyBeginLimiter)
		acct.SetDownloadLimiter(downloadLimiter)
		acct.SetDirectDownload(*directDownload)
		// The App Store verifier, if one was configured. Installed HERE, after
		// everything it depends on has already been read and validated: by this
		// point a broken configuration has long since ended the process, so the
		// only two outcomes left are a service with a fully-built verifier and a
		// service that never heard of one. There is no partially-activated state
		// to reason about, and no order in which a purchase could be verified
		// against half a configuration.
		appleStore.install(acct)
		if appleSubscriptionAPI != nil {
			acct.SetAppleSubscriptionReconciler(appleSubscriptionAPI)
			go acct.RunAppleSubscriptionReconciler(context.Background(), 15*time.Minute)
		}
		// Notification retention is account storage maintenance, not blob-storage
		// maintenance. Keep it outside the stored-transfers branch so deployments
		// that deliberately disable file storage still bound completed Apple
		// subscription identifiers. Unfinished work is never age-pruned.
		appleNotificationPruner := &account.AppleNotificationPruner{
			Store: store,
			Now:   func() int64 { return time.Now().Unix() },
			Log:   log.Default(),
		}
		go appleNotificationPruner.Run(context.Background(), 10*time.Minute)
		// /api/pair requires a logged-in owner: the receiver still joins the code
		// room anonymously via /ws?code= and /api/ice?code=, but minting a
		// cross-network rendezvous code needs an account for attribution. The
		// owner may authenticate with a session cookie (web) or a CLI bearer
		// token — pairUser accepts either.
		//
		// acct.PairMintRefusal is B3's gate (server/account/pairmint.go): an owner
		// whose monthly combined traffic allowance is spent gets no code, because
		// with that meter empty BOTH cross-network paths are closed to them and the
		// digits would name a rendezvous they cannot complete. It runs here rather
		// than only on the choose screen because this is the authoritative place —
		// the Web preflight can be stale by the time the button is clicked, and a
		// CLI/bearer client never asks it. It fails OPEN on a read error.
		mux.Handle("POST /api/pair", acct.CSRFGuard(signal.PairHandler(pairReg, pairLimiter, ipx, pairUser(acct), acct.PairMintRefusal)))
		// Relay-node register/heartbeat: bearer-authenticated (not cookie/CSRF),
		// so mounted directly on the root mux like /api/pair above. No-op when
		// NodeToken is unset.
		acct.RegisterNodeRoutes(mux)
		if disk, derr := storage.NewDiskStore(*blobDir); derr != nil {
			log.Printf("WARNING: open blob dir %q: %v — stored transfers disabled", *blobDir, derr)
		} else {
			readyBlobs = disk
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
				SweepPairRooms: acct.SweepPairRooms,
				AuditRetention: *auditRetentionDays * 86400,
			}
			go gc.Run(context.Background(), 10*time.Minute)
			// Placement's other precondition. Node liveness comes from the
			// heartbeat, which travels node→central; blob writes travel
			// central→node. A node with its blob port shut satisfies the first
			// and fails the second, so without this it keeps being handed
			// uploads that can only ever 500.
			prober := &account.StorageProber{
				Store: store,
				Now:   time.Now,
				Probe: acct.ProbeNodeStorage,
				Log:   log.Default(),
			}
			go prober.Run(context.Background(), 2*time.Minute)
			log.Printf("stored transfers enabled: blobs in %s", *blobDir)
		}
		if *releaseCheck {
			// Printed unconditionally, because this ships to self-hosters and it
			// changes what their server does on the network. It reads a public API
			// and uploads nothing about the instance; what GitHub can observe is
			// this machine's egress IP asking on a timer.
			//
			// It names api.github.com, which is the host actually contacted
			// (selfupdate's defaultAPIBase) — NOT github.com, which is only the
			// download host and is never reached by this poller. The stated
			// purpose of this line is to let a self-hoster act on it, and an
			// egress allowlist built from the wrong hostname fails closed: the
			// check silently never succeeds and /admin quietly says it has never
			// checked. It also says "at startup and then hourly", because
			// ReleaseChecker.Run checks once immediately and central restarts on
			// every deploy — "hourly" undercounts the requests it will see.
			log.Printf("release check enabled: asking api.github.com at startup and then hourly for the newest %s release, to offer it in /admin. "+
				"No instance data is sent. Set RELAYIUM_RELEASE_CHECK=false to turn it off.", releaseRepo)
			checker := &account.ReleaseChecker{
				Store: store,
				Now:   time.Now,
				Latest: func(ctx context.Context) (string, error) {
					// Per-check deadline. selfupdate.DefaultHTTPClient sets NO
					// blanket Client.Timeout on purpose — it is tuned for
					// multi-MB archive downloads and bounds only the fast phases
					// (connect, TLS, time-to-first-byte) — so a server that
					// sends headers and then stalls the body wedges this call
					// forever, and Run calls CheckOnce SERIALLY: the poller
					// never ticks again and the panel silently stops updating.
					// This request is a few hundred bytes of JSON, so a deadline
					// on the whole request is right here even though it would
					// be wrong for a download.
					ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
					defer cancel()
					return selfupdate.LatestTag(ctx, selfupdate.Options{Repo: releaseRepo})
				},
				Log: log.Default(),
			}
			go checker.Run(context.Background(), time.Hour)
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
		acct.RegisterDevicePage(mux) // GET /device on the root mux (see RegisterDevicePage)

		if *stripeSecretKey != "" {
			// Periodic safety net for a MISSED customer.subscription.deleted webhook:
			// Stripe stops retrying an undeliverable event after ~3 days, which would
			// leave a canceled user on a paid plan forever. This sweep downgrades any
			// Stripe-paid user whose subscription no longer exists on Stripe. Webhooks
			// remain the primary, immediate path; this is the eventual-consistency net.
			go func() {
				t := time.NewTicker(6 * time.Hour)
				defer t.Stop()
				acct.ReconcileStripeSubscriptions(context.Background())
				acct.ReconcileBillingCancellations(context.Background())
				acct.ReconcileDuplicateRefunds(context.Background())
				for range t.C {
					acct.ReconcileStripeSubscriptions(context.Background())
					acct.ReconcileBillingCancellations(context.Background())
					acct.ReconcileDuplicateRefunds(context.Background())
				}
			}()
		}
	}

	// Universal Links / Sign in with Apple domain association. A more specific
	// pattern than "/", so it wins over the SPA fallback. Dormant (404) until
	// RELAYIUM_APPLE_APP_IDS is set.
	// Release mirror for hosts that cannot reach github.com (see release_mirror.go).
	mux.HandleFunc("GET "+mirrorPrefix, handleReleaseMirror)
	mux.HandleFunc("GET /.well-known/apple-app-site-association", appleAppSiteAssociation(splitURLs(*appleAppIDs)))
	mux.HandleFunc("GET /.well-known/apple-developer-domain-association.txt", appleDomainAssociation(*appleDomainAssoc))

	mux.Handle("/", spaHandler(*static))

	// Hash the SPA's inline scripts once at startup so the CSP can drop
	// 'unsafe-inline' from script-src without a per-request nonce on the static
	// shell (which is served as a plain file). Recomputed from the built files,
	// so a Vite rebuild never silently breaks the policy.
	spaHashes := spaScriptHashes(*static)

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
		Handler:           securityHeaders(spaHashes, mux),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	warnInsecureCookieConfig(*baseURL, *addr)
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
