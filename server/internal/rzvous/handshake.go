package rzvous

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/relayium/relayium/internal/secure"
)

// Mode says what a peer intends to do with the connection. It rides the commit,
// which is the first message either side sends -- the earliest point either can
// know, and the only compatible one.
//
// encoding/json ignores fields it does not know, so an already-deployed binary
// drops this silently and reports "" (which normalises to ModeFile). That matters
// more than it looks: xfer's protocol is positional and validates no frame type,
// so a text frame delivered where a manifest is expected would unmarshal into an
// empty Manifest and the transfer would COMPLETE having moved nothing. Refusing
// on the mode -- before RaceDirect, before any TLS connection -- is what makes
// that silent success unreachable.
const (
	ModeFile = "file"
	ModeText = "text"
)

// ModeCompatible reports whether two peers want the same thing.
//
// An absent mode is a file peer: that is what every binary already in the field
// sends. Anything outside the known set is incompatible with everything,
// INCLUDING an identical copy of itself -- two ends agreeing on a mode neither
// implements is not agreement, and comparing for equality alone would wave it
// through. The value is peer-controlled, so it is matched exactly: no trimming,
// no case folding, no prefix matching.
func ModeCompatible(self, peer string) bool {
	a, aOK := knownMode(self)
	b, bOK := knownMode(peer)
	return aOK && bOK && a == b
}

func knownMode(m string) (string, bool) {
	switch m {
	case "", ModeFile:
		return ModeFile, true
	case ModeText:
		return ModeText, true
	default:
		return "", false
	}
}

type Handshake struct {
	PeerFingerprint string
	SAS             string
	PeerCandidates  []string
	IsServer        bool
	// What the peer said it wants this connection for, verbatim -- including a
	// value we do not know, so the caller can refuse and name what it saw. Empty
	// means the peer sent none, i.e. it predates this field.
	PeerMode string
}

type hsMsg struct {
	Kind        string   `json:"kind"`                 // "commit" | "reveal"
	Commit      string   `json:"commit,omitempty"`     // base64, kind=commit
	Mode        string   `json:"mode,omitempty"`       // kind=commit; omitted for ModeFile
	Fingerprint string   `json:"fp,omitempty"`         // hex, kind=reveal
	Nonce       string   `json:"nonce,omitempty"`      // base64, kind=reveal
	Candidates  []string `json:"candidates,omitempty"` // kind=reveal
}

func sendHS(ctx context.Context, s *Session, m hsMsg) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return s.SendSignal(ctx, b)
}

func recvHS(ctx context.Context, s *Session, want string) (hsMsg, error) {
	data, err := s.RecvSignal(ctx)
	if err != nil {
		return hsMsg{}, err
	}
	var m hsMsg
	if err := json.Unmarshal(data, &m); err != nil {
		return hsMsg{}, err
	}
	if m.Kind != want {
		return hsMsg{}, errors.New("rzvous: unexpected handshake message " + m.Kind)
	}
	return m, nil
}

// DoHandshake runs commit-then-reveal over the signal channel, pins the peer's
// cert fingerprint, exchanges TCP candidates, and derives the shared SAS.
// The mode is announced on the commit; the caller compares it with ModeCompatible
// and refuses before it dials anything.
func DoHandshake(ctx context.Context, s *Session, id *secure.Identity, localCandidates []string, mode string) (*Handshake, error) {
	nonce, err := secure.NewNonce()
	if err != nil {
		return nil, err
	}
	commit := secure.Commit(id.Fingerprint, nonce)
	// ModeFile is sent as an absent field, so a file handshake's commit JSON stays
	// byte-identical to what every deployed binary already sends and receives.
	wire := mode
	if wire == ModeFile {
		wire = ""
	}
	if err := sendHS(ctx, s, hsMsg{Kind: "commit", Commit: base64.StdEncoding.EncodeToString(commit), Mode: wire}); err != nil {
		return nil, err
	}
	peerCommitMsg, err := recvHS(ctx, s, "commit")
	if err != nil {
		return nil, err
	}
	peerCommit, err := base64.StdEncoding.DecodeString(peerCommitMsg.Commit)
	if err != nil {
		return nil, err
	}

	if err := sendHS(ctx, s, hsMsg{
		Kind:        "reveal",
		Fingerprint: id.Fingerprint,
		Nonce:       base64.StdEncoding.EncodeToString(nonce),
		Candidates:  localCandidates,
	}); err != nil {
		return nil, err
	}
	rev, err := recvHS(ctx, s, "reveal")
	if err != nil {
		return nil, err
	}
	peerNonce, err := base64.StdEncoding.DecodeString(rev.Nonce)
	if err != nil {
		return nil, err
	}
	if _, err := hex.DecodeString(rev.Fingerprint); err != nil {
		return nil, errors.New("rzvous: peer fingerprint not hex")
	}
	if !secure.VerifyCommit(peerCommit, rev.Fingerprint, peerNonce) {
		return nil, errors.New("rzvous: peer commitment mismatch — aborting (possible MITM)")
	}

	return &Handshake{
		PeerFingerprint: rev.Fingerprint,
		SAS:             secure.SAS(id.Fingerprint, rev.Fingerprint),
		PeerCandidates:  rev.Candidates,
		IsServer:        s.SelfID() < s.PeerID(),
		PeerMode:        peerCommitMsg.Mode,
	}, nil
}
