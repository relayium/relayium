package rzvous

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/relayium/relayium/internal/secure"
)

type Handshake struct {
	PeerFingerprint string
	SAS             string
	PeerCandidates  []string
	IsServer        bool
}

type hsMsg struct {
	Kind        string   `json:"kind"`                 // "commit" | "reveal"
	Commit      string   `json:"commit,omitempty"`     // base64, kind=commit
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
func DoHandshake(ctx context.Context, s *Session, id *secure.Identity, localCandidates []string) (*Handshake, error) {
	nonce, err := secure.NewNonce()
	if err != nil {
		return nil, err
	}
	commit := secure.Commit(id.Fingerprint, nonce)
	if err := sendHS(ctx, s, hsMsg{Kind: "commit", Commit: base64.StdEncoding.EncodeToString(commit)}); err != nil {
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
	}, nil
}
