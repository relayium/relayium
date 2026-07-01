package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
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
	smtpFrom := flag.String("smtp-from", envStr("RELAYIUM_SMTP_FROM", "no-reply@relayium.com"), "magic link From address")
	smtpUser := flag.String("smtp-user", envStr("RELAYIUM_SMTP_USER", ""), "SMTP username (set with -smtp-pass for authenticated providers; empty = unauthenticated relay)")
	smtpPass := flag.String("smtp-pass", envStr("RELAYIUM_SMTP_PASS", ""), "SMTP password (used with -smtp-user)")
	turnSecret := flag.String("turn-secret", envStr("RELAYIUM_TURN_SECRET", ""), "coturn static-auth-secret (empty disables TURN)")
	turnURLs := flag.String("turn-urls", envStr("RELAYIUM_TURN_URLS", ""), "comma-separated TURN URLs (e.g. turn:host:3478,turns:host:5349)")
	stunURLs := flag.String("stun-urls", envStr("RELAYIUM_STUN_URLS", "stun:stun.l.google.com:19302"), "comma-separated STUN URLs")
	redisAddr := flag.String("redis-addr", envStr("RELAYIUM_REDIS_ADDR", ""), "Redis host:port for coturn relay-byte metering (empty disables)")
	enableGoogle := flag.Bool("enable-google", envBool("RELAYIUM_ENABLE_GOOGLE", false), "enable Google OAuth login (disabled by default)")
	enableMagic := flag.Bool("enable-magic", envBool("RELAYIUM_ENABLE_MAGIC", false), "enable email magic-link login (disabled by default)")
	adminUser := flag.String("admin-user", envStr("RELAYIUM_ADMIN_USER", "admin"), "admin dashboard username at /admin (defaults to 'admin')")
	adminPass := flag.String("admin-pass", envStr("RELAYIUM_ADMIN_PASS", ""), "admin dashboard password at /admin (empty disables the dashboard)")
	adminTOTPSecret := flag.String("admin-totp-secret", envStr("RELAYIUM_ADMIN_TOTP_SECRET", ""), "base32 TOTP secret for admin 2FA (empty disables 2FA)")
	genAdminTOTP := flag.Bool("gen-admin-totp", false, "generate a new admin TOTP secret + QR and exit")
	blobDir := flag.String("blob-dir", envStr("RELAYIUM_BLOB_DIR", "./blobs"), "directory for stored-transfer ciphertext blobs")
	maxFileSize := flag.Int64("max-file-size", envInt64("RELAYIUM_MAX_FILE_SIZE", 50<<20), "stored-transfer max single-file size in bytes (default 50 MiB)")
	dailyQuota := flag.Int64("daily-quota", envInt64("RELAYIUM_DAILY_QUOTA", 200<<20), "stored-transfer per-account upload quota per 24h in bytes (default 200 MiB)")
	fileTTL := flag.Int64("file-ttl", envInt64("RELAYIUM_FILE_TTL", 86400), "stored-transfer default link TTL in seconds (default 1 day)")
	fileTTLMax := flag.Int64("file-ttl-max", envInt64("RELAYIUM_FILE_TTL_MAX", 604800), "stored-transfer max link TTL in seconds (default 7 days)")
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

	hub := signal.NewHub()
	handle := signal.ServeWS(hub, newID)

	// Anonymous, login-free pairing: short numeric codes for cross-network
	// realtime rendezvous. Pure in-memory — works even if the DB is unavailable.
	pairReg := signal.NewPairRegistry(300, func() int64 { return time.Now().Unix() }) // 5 min
	go pairReg.Run(context.Background(), time.Minute)
	pairLimiter := signal.NewRateLimiter(10, time.Minute, func() int64 { return time.Now().Unix() })
	go pairLimiter.Run(context.Background(), time.Minute)
	// Separate limiter for /ws code-join attempts: 30/min/IP caps brute-force of
	// the 10^6 code space while allowing a real recipient to reload a few times.
	wsCodeLimiter := signal.NewRateLimiter(30, time.Minute, func() int64 { return time.Now().Unix() })
	go wsCodeLimiter.Run(context.Background(), time.Minute)

	store, dbErr := account.OpenSQLite(*dbPath)

	// validateRoom gates token-rooms. Nil (DB unavailable) => token-rooms are
	// rejected, but LAN rooms (no ?room=) are unaffected.
	var validateRoom func(context.Context, string) bool

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		if code != "" && !wsCodeLimiter.Allow(signal.ClientIP(r)) {
			http.Error(w, "too many pairing attempts", http.StatusTooManyRequests)
			return
		}
		token := r.URL.Query().Get("room")
		room, maxPeers, lan, ok := signal.RoomFor(code, token,
			pairReg.Validate,
			func(t string) bool { return validateRoom != nil && validateRoom(r.Context(), t) },
		)
		if !ok {
			http.Error(w, "invalid or expired pairing code or transfer link", http.StatusForbidden)
			return
		}
		if lan {
			room = signal.RoomKey(r)
			maxPeers = 0 // LAN: unlimited
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ctx := r.Context()
		handle(ctx, c, room, maxPeers, signal.ClientIP(r))
		_ = c.Close(websocket.StatusNormalClosure, "")
	})
	mux.HandleFunc("POST /api/pair", signal.PairHandler(pairReg, pairLimiter))

	if dbErr != nil {
		log.Printf("WARNING: open db: %v — account features disabled; LAN transfer unaffected", dbErr)
	} else {
		var mailer account.Mailer = &account.LogMailer{Log: log.Default()}
		if *smtpAddr != "" {
			mailer = account.NewSMTPMailer(*smtpAddr, *smtpFrom, *smtpUser, *smtpPass)
		}
		acct := account.NewService(store, mailer, account.Config{
			BaseURL:         *baseURL,
			SessionTTL:      720 * time.Hour, // 30 days
			MagicTTL:        15 * time.Minute,
			TransferTTL:     time.Hour,
			GoogleClientID:  *googleID,
			GoogleSecret:    *googleSecret,
			GoogleRedirect:  *baseURL + "/api/auth/google/callback",
			STUNURLs:        splitURLs(*stunURLs),
			TURNURLs:        splitURLs(*turnURLs),
			TURNSecret:      *turnSecret,
			TURNCredTTL:     time.Hour,
			EnableGoogle:    *enableGoogle,
			EnableMagic:     *enableMagic,
			AdminUser:       *adminUser,
			AdminPassword:   *adminPass,
			AdminTOTPSecret: *adminTOTPSecret,
			MaxFileSize:     *maxFileSize,
			DailyQuota:      *dailyQuota,
			DefaultTTL:      *fileTTL,
			MaxTTL:          *fileTTLMax,
		})
		validateRoom = acct.ValidateTransferToken
		// Let /api/ice hand TURN credentials to anonymous pairing-code rooms too,
		// not just logged-in transfer tokens — otherwise code transfers are
		// STUN-only and fail across strict NATs.
		acct.SetPairCodeValidator(pairReg.Validate)
		if disk, derr := storage.NewDiskStore(*blobDir); derr != nil {
			log.Printf("WARNING: open blob dir %q: %v — stored transfers disabled", *blobDir, derr)
		} else {
			acct.SetBlobStore(disk)
			if err := acct.SeedSettings(context.Background()); err != nil {
				log.Printf("WARNING: seed settings: %v", err)
			}
			gc := &account.GC{
				Store: store,
				Blobs: disk,
				Now:   func() int64 { return time.Now().Unix() },
				Log:   log.Default(),
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
			go func() {
				if err := worker.Run(context.Background(), src); err != nil {
					log.Printf("metering worker stopped: %v", err)
				}
			}()
			log.Printf("metering: ingesting coturn relay stats from redis %s", *redisAddr)
		}
		mux.Handle("/api/", acct.Routes())
		acct.RegisterAdmin(mux)
	}

	mux.Handle("/", spaHandler(*static))

	log.Printf("relayium signaling server listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
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
