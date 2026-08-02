// Package rzvous is the CLI's rendezvous client: it speaks the existing
// signaling Envelope over a WebSocket to pair with one peer in a code room and
// relay opaque signal payloads to it. It carries no file bytes.
package rzvous

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/signal"
)

type Session struct {
	conn   *websocket.Conn
	selfID string
	peerID string
}

func (s *Session) SelfID() string { return s.selfID }
func (s *Session) PeerID() string { return s.peerID }

// Join dials the rendezvous, announces the given nickname, and blocks until
// exactly one peer shares the room. An empty code joins the LAN room.
func Join(ctx context.Context, serverURL, code, name string) (*Session, error) {
	u, err := url.Parse(serverURL)
	if err != nil {
		return nil, err
	}
	u.Path = "/ws"
	if code != "" {
		// Check the shape here, not just at the server: a code that cannot be a
		// code (a made-up number, a typo'd character) costs a round trip only to
		// come back as an opaque 403, and "expected handshake response status
		// code 101 but got 403" tells the user nothing about what to type instead.
		if !signal.ValidCodeFormat(code) {
			// "issued by the server", not "issued by relayium.com": serverURL is
			// whatever --server points at, so naming the first-party host tells a
			// self-hoster their own instance's codes come from a service they
			// deliberately are not using.
			return nil, fmt.Errorf(
				"pairing code %q is not a valid code: codes are %s, and are issued by the server — one cannot be made up",
				code, signal.CodeFormatNote())
		}
		u.RawQuery = "code=" + url.QueryEscape(code)
	}
	conn, resp, err := websocket.Dial(ctx, u.String(), nil)
	if err != nil {
		return nil, dialError(err, resp)
	}
	s := &Session{conn: conn}

	if err := s.write(ctx, signal.Envelope{Type: signal.TypeJoin, Name: name}); err != nil {
		conn.Close(websocket.StatusInternalError, "join")
		return nil, err
	}
	for {
		env, err := s.read(ctx)
		if err != nil {
			conn.Close(websocket.StatusInternalError, "handshake")
			return nil, err
		}
		switch env.Type {
		case signal.TypeWelcome:
			s.selfID = env.Name
		case signal.TypePeers:
			for _, p := range env.Peers {
				if p.ID != s.selfID {
					s.peerID = p.ID
				}
			}
			if s.peerID != "" {
				return s, nil
			}
		}
	}
}

// dialError turns a failed rendezvous handshake into something the user can act
// on. The server states its reason in the response body ("invalid or expired
// pairing code", "too many pairing attempts"), but websocket.Dial's error keeps
// only the status code — so read the body coder/websocket buffers back into
// resp.Body on a failed handshake and lead with it.
func dialError(err error, resp *http.Response) error {
	if resp == nil {
		return fmt.Errorf("rendezvous dial: %w", err)
	}
	reason := serverReason(resp)
	switch resp.StatusCode {
	case http.StatusForbidden:
		if reason == "" {
			reason = "invalid or expired pairing code"
		}
		// Same reason as in Join: the issuer is whichever server this dial went
		// to, which for a self-hoster is their own.
		return fmt.Errorf("rendezvous dial: %s — a pairing code is issued by the server and lasts %d minutes, so ask for a fresh one", reason, signal.CodeTTLSeconds/60)
	case http.StatusTooManyRequests:
		if reason == "" {
			reason = "rate limited"
		}
		return fmt.Errorf("rendezvous dial: %s — wait a minute and retry", reason)
	}
	if reason != "" {
		return fmt.Errorf("rendezvous dial: %s (HTTP %d)", reason, resp.StatusCode)
	}
	return fmt.Errorf("rendezvous dial: %w", err)
}

// serverReason extracts a short one-line reason from a refused handshake's
// buffered body. The body is remote input, so take only the first line and cap
// it: a misconfigured proxy answering with an HTML error page must not paint the
// terminal with markup.
func serverReason(resp *http.Response) string {
	if resp.Body == nil {
		return ""
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	resp.Body.Close()
	line := strings.TrimSpace(string(b))
	if i := strings.IndexAny(line, "\r\n"); i >= 0 {
		line = strings.TrimSpace(line[:i])
	}
	if len(line) > 200 {
		line = line[:200] + "…"
	}
	if strings.ContainsAny(line, "<>") { // not a plain-text reason from our server
		return ""
	}
	return line
}

func (s *Session) SendSignal(ctx context.Context, data json.RawMessage) error {
	return s.write(ctx, signal.Envelope{Type: signal.TypeSignal, To: s.peerID, Data: data})
}

// RecvSignal returns the payload of the next signal envelope from the peer,
// skipping roster/presence frames.
func (s *Session) RecvSignal(ctx context.Context) (json.RawMessage, error) {
	for {
		env, err := s.read(ctx)
		if err != nil {
			return nil, err
		}
		if env.Type == signal.TypeSignal {
			return env.Data, nil
		}
	}
}

func (s *Session) Close() error { return s.conn.Close(websocket.StatusNormalClosure, "") }

func (s *Session) write(ctx context.Context, e signal.Envelope) error {
	b, err := signal.EncodeEnvelope(e)
	if err != nil {
		return err
	}
	return s.conn.Write(ctx, websocket.MessageText, b)
}

func (s *Session) read(ctx context.Context) (signal.Envelope, error) {
	_, b, err := s.conn.Read(ctx)
	if err != nil {
		return signal.Envelope{}, err
	}
	return signal.DecodeEnvelope(b)
}
