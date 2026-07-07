package rzvous

import (
	"context"
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
