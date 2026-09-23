package rzvous

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/signal"
)

// ProtoLink is the roster hint a peer sends on join to say "I accept a link
// hello as my first inbound frame and will announce link/1 myself"
// (A08-DESIGN §3.3). A server that supports hints echoes the accepted list on
// welcome and carries it on the peer's roster entry.
const ProtoLink = "link/1"

// Bounds on what JoinRoom will hold for a peer that speaks before this side's
// room view is complete (A08-DESIGN §10, "Early-signal capture"). A real peer
// sends one or two frames in that window; exceeding either bound is not a
// slow peer but a misbehaving one, so it fails the join rather than dropping
// frames -- dropping would silently reorder what the caller later replays.
const (
	MaxCapturedFrames = 64
	MaxCapturedBytes  = 256 << 10
)

// ErrCaptureOverflow means more signals arrived before the peer could be
// selected than JoinRoom will hold. The connection is closed.
var ErrCaptureOverflow = errors.New("rzvous: too many signals before the room view was complete")

// Room is the result of JoinRoom: the room as this side first saw it complete.
type Room struct {
	// Session carries the rest of the conversation. Signals it returns are the
	// ones that arrived after Captured.
	Session *Session
	SelfID  string
	PeerID  string
	// ServerHints is true when the server's welcome echoed ProtoLink back, i.e.
	// it supports roster hints. It can only be true when JoinRoom was asked to
	// send ProtoLink: a server echoes what was sent, not what it knows. False
	// with ProtoLink sent means a server that predates hints ("old hub").
	ServerHints bool
	// PeerHint is true when the selected peer's roster entry carries ProtoLink.
	// It is a hint, never a security input: the server authors it.
	PeerHint bool
	// Captured holds, in arrival order, the payloads of the signals the selected
	// peer sent before the peer was selected. The caller replays them before
	// reading Session. Signals from any other id are not included.
	Captured []json.RawMessage
}

// hintedEnvelope is signal.Envelope plus the join-time hint. Kept local so the
// client does not depend on a server-side field existing yet; json flattens
// the embedded envelope, and the outer field wins if the envelope ever gains
// its own "proto".
type hintedEnvelope struct {
	signal.Envelope
	Proto []string `json:"proto,omitempty"`
}

// hintFields are the only parts of a welcome/peers frame JoinRoom reads beyond
// signal.Envelope. Raw, so a malformed value degrades to "absent" instead of
// failing the frame (the same fail-to-absent rule the server applies).
type hintFields struct {
	Proto json.RawMessage `json:"proto"`
	Peers []struct {
		ID    string          `json:"id"`
		Proto json.RawMessage `json:"proto"`
	} `json:"peers"`
}

// hasProto reports whether raw is a JSON array of strings containing token
// byte-for-byte. Anything else -- absent, null, a string, mixed types -- is
// absent.
func hasProto(raw json.RawMessage, token string) bool {
	if len(raw) == 0 {
		return false
	}
	var list []string
	if err := json.Unmarshal(raw, &list); err != nil {
		return false
	}
	for _, p := range list {
		if p == token {
			return true
		}
	}
	return false
}

type capturedSignal struct {
	from string
	data json.RawMessage
}

// JoinRoom is Join for a caller that must not lose a peer's first words.
//
// It dials the rendezvous, joins with the given roster hint (proto; nil sends
// the exact join Join sends), and blocks until Welcome has identified this
// connection and a roster names another peer. Every signal that arrives before
// then is captured, bounded by MaxCapturedFrames and MaxCapturedBytes, and
// returned in Room.Captured when it came from the selected peer. The hub
// debounces rosters (up to 200 ms), so a peer that already had a roster naming
// us -- an older CLI sends its commit at once -- can speak before we know it
// exists. JoinRoom hands that frame to the caller in Room.Captured; Join
// keeps it too and replays it through Session.RecvSignal.
func JoinRoom(ctx context.Context, serverURL, code, name string, proto []string) (*Room, error) {
	conn, err := dialRendezvous(ctx, serverURL, code)
	if err != nil {
		return nil, err
	}
	s := &Session{conn: conn}
	fail := func(status websocket.StatusCode, reason string, err error) (*Room, error) {
		conn.Close(status, reason)
		return nil, err
	}

	sentLink := false
	for _, p := range proto {
		if p == ProtoLink {
			sentLink = true
		}
	}
	join, err := json.Marshal(hintedEnvelope{Envelope: signal.Envelope{Type: signal.TypeJoin, Name: name}, Proto: proto})
	if err != nil {
		return fail(websocket.StatusInternalError, "join", err)
	}
	if err := conn.Write(ctx, websocket.MessageText, join); err != nil {
		return fail(websocket.StatusInternalError, "join", err)
	}

	var (
		serverHints bool
		roster      []signal.Peer
		peerHints   map[string]bool
		captured    []capturedSignal
		capturedN   int
	)
	for {
		_, b, err := conn.Read(ctx)
		if err != nil {
			return fail(websocket.StatusInternalError, "handshake", err)
		}
		env, err := signal.DecodeEnvelope(b)
		if err != nil {
			return fail(websocket.StatusInternalError, "handshake", err)
		}
		switch env.Type {
		case signal.TypeSignal:
			capturedN += len(env.Data)
			if len(captured) >= MaxCapturedFrames || capturedN > MaxCapturedBytes {
				return fail(websocket.StatusPolicyViolation, "capture overflow",
					fmt.Errorf("%w (limit %d frames, %d bytes)", ErrCaptureOverflow, MaxCapturedFrames, MaxCapturedBytes))
			}
			captured = append(captured, capturedSignal{from: env.From, data: env.Data})
			continue
		case signal.TypeWelcome:
			s.selfID = env.Name
			var h hintFields
			_ = json.Unmarshal(b, &h) // malformed hint == absent
			serverHints = sentLink && hasProto(h.Proto, ProtoLink)
		case signal.TypePeers:
			roster = env.Peers
			var h hintFields
			_ = json.Unmarshal(b, &h)
			peerHints = make(map[string]bool, len(h.Peers))
			for _, p := range h.Peers {
				if hasProto(p.Proto, ProtoLink) {
					peerHints[p.ID] = true
				}
			}
		default:
			continue
		}
		// Welcome and roster are separate frames. Do not interpret a roster
		// until Welcome has identified this connection: under an unlucky write
		// schedule an empty selfID would make our own roster entry look like the
		// peer, causing signaling (including the handshake commit) to loop back.
		if s.selfID == "" || len(roster) == 0 {
			continue
		}
		s.peerID = ""
		for _, p := range roster {
			if p.ID != s.selfID {
				s.peerID = p.ID
				break
			}
		}
		if s.peerID == "" {
			continue
		}
		room := &Room{
			Session:     s,
			SelfID:      s.selfID,
			PeerID:      s.peerID,
			ServerHints: serverHints,
			PeerHint:    peerHints[s.peerID],
		}
		for _, c := range captured {
			if c.from == s.peerID {
				room.Captured = append(room.Captured, c.data)
			}
		}
		return room, nil
	}
}
