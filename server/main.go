package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"log"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/account"
	"github.com/relayium/relayium/internal/metering"
	"github.com/relayium/relayium/internal/signal"
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
	addr := flag.String("addr", ":8080", "listen address")
	static := flag.String("static", "../web/dist", "static files directory")
	dbPath := flag.String("db", "relayium.db", "SQLite database path (':memory:' for ephemeral)")
	baseURL := flag.String("base-url", "http://localhost:8080", "public base URL for links/redirects")
	googleID := flag.String("google-id", "", "Google OAuth client ID")
	googleSecret := flag.String("google-secret", "", "Google OAuth client secret")
	smtpAddr := flag.String("smtp-addr", "", "SMTP host:port (empty = log magic links instead of emailing)")
	smtpFrom := flag.String("smtp-from", "no-reply@relayium.com", "magic link From address")
	smtpUser := flag.String("smtp-user", "", "SMTP username (set with -smtp-pass for authenticated providers; empty = unauthenticated relay)")
	smtpPass := flag.String("smtp-pass", "", "SMTP password (used with -smtp-user)")
	turnSecret := flag.String("turn-secret", "", "coturn static-auth-secret (empty disables TURN)")
	turnURLs := flag.String("turn-urls", "", "comma-separated TURN URLs (e.g. turn:host:3478,turns:host:5349)")
	stunURLs := flag.String("stun-urls", "stun:stun.l.google.com:19302", "comma-separated STUN URLs")
	redisAddr := flag.String("redis-addr", "", "Redis host:port for coturn relay-byte metering (empty disables)")
	flag.Parse()

	// Not in Go's built-in MIME table; the PWA manifest should be served as JSON.
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")

	hub := signal.NewHub()
	handle := signal.ServeWS(hub, newID)

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
		var room string
		var maxPeers int
		if token := r.URL.Query().Get("room"); token != "" {
			if validateRoom == nil || !validateRoom(r.Context(), token) {
				http.Error(w, "invalid or expired transfer link", http.StatusForbidden)
				return
			}
			room = "t:" + token
			maxPeers = 2 // sender + receiver
		} else {
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

	if dbErr != nil {
		log.Printf("WARNING: open db: %v — account features disabled; LAN transfer unaffected", dbErr)
	} else {
		var mailer account.Mailer = &account.LogMailer{Log: log.Default()}
		if *smtpAddr != "" {
			mailer = account.NewSMTPMailer(*smtpAddr, *smtpFrom, *smtpUser, *smtpPass)
		}
		acct := account.NewService(store, mailer, account.Config{
			BaseURL:        *baseURL,
			SessionTTL:     720 * time.Hour, // 30 days
			MagicTTL:       15 * time.Minute,
			TransferTTL:    time.Hour,
			GoogleClientID: *googleID,
			GoogleSecret:   *googleSecret,
			GoogleRedirect: *baseURL + "/api/auth/google/callback",
			STUNURLs:       splitURLs(*stunURLs),
			TURNURLs:       splitURLs(*turnURLs),
			TURNSecret:     *turnSecret,
			TURNCredTTL:    time.Hour,
		})
		validateRoom = acct.ValidateTransferToken
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
	}

	mux.Handle("/", http.FileServer(http.Dir(*static)))

	log.Printf("relayium signaling server listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
