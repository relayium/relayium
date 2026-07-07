package connect

import (
	"context"
	"net"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/signal"
)

func TestEstablishFallsBackToRelay(t *testing.T) {
	// Relay server that just pairs and echoes via the real RelayHandler.
	deps := signal.RelayDeps{
		OwnerOf:   func(code string) (string, bool) { return "o", true },
		OverQuota: func(ctx context.Context, owner string) bool { return false },
		Record:    func(ctx context.Context, sid, owner, code string, b int64) {},
		NewID:     func() string { return "s" },
	}
	srv := httptest.NewServer(signal.RelayHandler(deps))
	defer srv.Close()
	serverURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	// No reachable peer candidate → direct fails fast → relay.
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	type out struct {
		c        net.Conn
		viaRelay bool
		err      error
	}
	// Peer B connects to the relay and echoes.
	go func() {
		bc, err := DialRelay(ctx, serverURL, "123456")
		if err != nil {
			return
		}
		defer bc.Close()
		buf := make([]byte, 4)
		bc.SetReadDeadline(time.Now().Add(2 * time.Second))
		if _, err := bc.Read(buf); err == nil {
			bc.Write(buf)
		}
	}()

	conn, viaRelay, err := Establish(ctx, EstablishParams{
		Listener:       ln,
		PeerCandidates: []string{"192.0.2.1:9"}, // unreachable (TEST-NET)
		DialTimeout:    200 * time.Millisecond,
		DirectWindow:   300 * time.Millisecond,
		ServerURL:      serverURL,
		Code:           "123456",
	})
	if err != nil {
		t.Fatalf("establish: %v", err)
	}
	if !viaRelay {
		t.Fatal("expected relay fallback")
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(2 * time.Second))
	conn.Write([]byte("ping"))
	buf := make([]byte, 4)
	if _, err := conn.Read(buf); err != nil || string(buf) != "ping" {
		t.Fatalf("relay echo = %q err=%v", buf, err)
	}
	_ = websocket.MessageBinary // keep import if adapter is in another file
}
