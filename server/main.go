package main

import (
	"crypto/rand"
	"encoding/hex"
	"flag"
	"log"
	"mime"
	"net/http"

	"github.com/coder/websocket"
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
	flag.Parse()

	// Not in Go's built-in MIME table; the PWA manifest should be served as JSON.
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")

	hub := signal.NewHub()
	handle := signal.ServeWS(hub, newID)

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
	mux.Handle("/", http.FileServer(http.Dir(*static)))

	log.Printf("relayium signaling server listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
