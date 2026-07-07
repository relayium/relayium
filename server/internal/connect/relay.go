package connect

import (
	"context"
	"net"
	"net/url"
	"time"

	"github.com/coder/websocket"
)

// DialRelay connects to the server relay for a code and presents it as a
// net.Conn carrying the raw byte stream (over binary WebSocket messages).
func DialRelay(ctx context.Context, serverURL, code string) (net.Conn, error) {
	u, err := url.Parse(serverURL)
	if err != nil {
		return nil, err
	}
	u.Path = "/relay"
	u.RawQuery = "code=" + url.QueryEscape(code)
	c, _, err := websocket.Dial(ctx, u.String(), nil)
	if err != nil {
		return nil, err
	}
	c.SetReadLimit(-1)
	// websocket.NetConn adapts a Conn to net.Conn; MessageBinary is the stream type.
	return websocket.NetConn(context.Background(), c, websocket.MessageBinary), nil
}

// EstablishParams configures Establish's direct-then-relay orchestration.
type EstablishParams struct {
	Listener       net.Listener
	PeerCandidates []string
	DialTimeout    time.Duration
	DirectWindow   time.Duration
	ServerURL      string
	Code           string
	RelayOnly      bool
	// PreferAccept makes RaceDirect converge on a single connection under glare;
	// set it to hs.IsServer (the lower-id peer prefers the connection it accepts).
	PreferAccept bool
}

// Establish returns a raw stream to the peer: a direct TCP connection when one
// can be raced within DirectWindow, otherwise the metered server relay.
func Establish(ctx context.Context, p EstablishParams) (net.Conn, bool, error) {
	if !p.RelayOnly {
		dctx, cancel := context.WithTimeout(ctx, p.DirectWindow)
		conn, err := RaceDirect(dctx, p.Listener, p.PeerCandidates, p.DialTimeout, p.PreferAccept)
		cancel()
		if err == nil {
			return conn, false, nil
		}
	}
	conn, err := DialRelay(ctx, p.ServerURL, p.Code)
	if err != nil {
		return nil, false, err
	}
	return conn, true, nil
}
