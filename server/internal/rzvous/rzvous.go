// Package rzvous is the CLI's rendezvous client: it speaks the existing
// signaling Envelope over a WebSocket to pair with one peer in a code room and
// relay opaque signal payloads to it. It carries no file bytes.
package rzvous

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"

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
		u.RawQuery = "code=" + url.QueryEscape(code)
	}
	conn, _, err := websocket.Dial(ctx, u.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("rendezvous dial: %w", err)
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
