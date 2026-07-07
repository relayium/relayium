package rzvous

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/secure"
)

func TestDoHandshakeAgreesOnSASAndRoles(t *testing.T) {
	base := startHub(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	aCh := make(chan *Session, 1)
	go func() { s, _ := Join(ctx, base, "", "a"); aCh <- s }()
	b, err := Join(ctx, base, "", "b")
	if err != nil {
		t.Fatalf("join b: %v", err)
	}
	a := <-aCh

	idA, _ := secure.NewIdentity()
	idB, _ := secure.NewIdentity()

	type res struct {
		h   *Handshake
		err error
	}
	ch := make(chan res, 1)
	go func() {
		h, err := DoHandshake(ctx, a, idA, []string{"1.2.3.4:5000"})
		ch <- res{h, err}
	}()
	hb, err := DoHandshake(ctx, b, idB, []string{"5.6.7.8:6000"})
	if err != nil {
		t.Fatalf("handshake b: %v", err)
	}
	ra := <-ch
	if ra.err != nil {
		t.Fatalf("handshake a: %v", ra.err)
	}
	ha := ra.h

	if ha.SAS != hb.SAS {
		t.Fatalf("SAS disagree: %s vs %s", ha.SAS, hb.SAS)
	}
	if ha.PeerFingerprint != idB.Fingerprint || hb.PeerFingerprint != idA.Fingerprint {
		t.Fatal("pinned fingerprints wrong")
	}
	if ha.IsServer == hb.IsServer {
		t.Fatal("both peers picked the same TLS role")
	}
	if len(hb.PeerCandidates) != 1 || hb.PeerCandidates[0] != "1.2.3.4:5000" {
		t.Fatalf("b did not receive a's candidates: %v", hb.PeerCandidates)
	}
}

// TestDoHandshakeAbortsOnCommitMismatch is the anti-MITM regression guard: a
// peer that reveals a fingerprint/nonce that doesn't match the commit it sent
// must cause the honest side's DoHandshake to abort with an error and NO
// Handshake. If the VerifyCommit check is ever removed, DoHandshake would
// return a non-nil Handshake and this test fails.
func TestDoHandshakeAbortsOnCommitMismatch(t *testing.T) {
	base := startHub(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	aCh := make(chan *Session, 1)
	go func() { s, _ := Join(ctx, base, "", "a"); aCh <- s }()
	b, err := Join(ctx, base, "", "b")
	if err != nil {
		t.Fatalf("join b: %v", err)
	}
	a := <-aCh

	idA, _ := secure.NewIdentity()
	idB, _ := secure.NewIdentity()

	type res struct {
		h   *Handshake
		err error
	}
	ch := make(chan res, 1)
	go func() {
		h, err := DoHandshake(ctx, a, idA, []string{"1.2.3.4:5000"})
		ch <- res{h, err}
	}()

	// Drive b maliciously: commit to nonce1 but reveal nonce2 (a different nonce).
	nonce1, err := secure.NewNonce()
	if err != nil {
		t.Fatalf("nonce1: %v", err)
	}
	nonce2 := make([]byte, len(nonce1))
	copy(nonce2, nonce1)
	nonce2[0] ^= 0xff // flip a byte so nonce2 != nonce1 → reveal won't match commit

	if _, err := recvHS(ctx, b, "commit"); err != nil {
		t.Fatalf("b recv a's commit: %v", err)
	}
	if err := sendHS(ctx, b, hsMsg{
		Kind:   "commit",
		Commit: base64.StdEncoding.EncodeToString(secure.Commit(idB.Fingerprint, nonce1)),
	}); err != nil {
		t.Fatalf("b send commit: %v", err)
	}
	if _, err := recvHS(ctx, b, "reveal"); err != nil {
		t.Fatalf("b recv a's reveal: %v", err)
	}
	if err := sendHS(ctx, b, hsMsg{
		Kind:        "reveal",
		Fingerprint: idB.Fingerprint,
		Nonce:       base64.StdEncoding.EncodeToString(nonce2), // mismatches the commit
		Candidates:  nil,
	}); err != nil {
		t.Fatalf("b send bad reveal: %v", err)
	}

	ra := <-ch
	if ra.err == nil {
		t.Fatal("DoHandshake accepted a mismatched commitment (MITM not detected)")
	}
	if !strings.Contains(ra.err.Error(), "commitment mismatch") {
		t.Fatalf("wrong error, want commitment mismatch: %v", ra.err)
	}
	if ra.h != nil {
		t.Fatalf("DoHandshake returned a non-nil Handshake despite the abort: %+v", ra.h)
	}
}
