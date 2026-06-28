package main

import (
	"crypto/rand"
	"encoding/hex"
	"flag"
	"log"
	"mime"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/account"
	"github.com/relayium/relayium/internal/signal"
)

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
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
	flag.Parse()

	// Not in Go's built-in MIME table; the PWA manifest should be served as JSON.
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")

	hub := signal.NewHub()
	handle := signal.ServeWS(hub, newID)

	store, dbErr := account.OpenSQLite(*dbPath)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ctx := r.Context()
		room := signal.RoomKey(r)
		handle(ctx, c, room)
		_ = c.Close(websocket.StatusNormalClosure, "")
	})

	if dbErr != nil {
		log.Printf("WARNING: open db: %v — account features disabled; LAN transfer unaffected", dbErr)
	} else {
		var mailer account.Mailer = &account.LogMailer{Log: log.Default()}
		if *smtpAddr != "" {
			mailer = &account.SMTPMailer{Addr: *smtpAddr, From: *smtpFrom}
		}
		acct := account.NewService(store, mailer, account.Config{
			BaseURL:        *baseURL,
			SessionTTL:     720 * time.Hour, // 30 days
			MagicTTL:       15 * time.Minute,
			GoogleClientID: *googleID,
			GoogleSecret:   *googleSecret,
			GoogleRedirect: *baseURL + "/api/auth/google/callback",
		})
		mux.Handle("/api/", acct.Routes())
	}

	mux.Handle("/", http.FileServer(http.Dir(*static)))

	log.Printf("relayium signaling server listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
