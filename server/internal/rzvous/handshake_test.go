package rzvous

import (
	"context"
	"encoding/base64"
	"encoding/json"
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
		h, err := DoHandshake(ctx, a, idA, []string{"1.2.3.4:5000"}, ModeFile)
		ch <- res{h, err}
	}()
	hb, err := DoHandshake(ctx, b, idB, []string{"5.6.7.8:6000"}, ModeFile)
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
		h, err := DoHandshake(ctx, a, idA, []string{"1.2.3.4:5000"}, ModeFile)
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

// An already-deployed binary sends no mode at all. It must read as a file peer,
// not as an unknown one, or every CLI in the field stops interoperating the
// moment one side upgrades.
func TestModeCompatibleTreatsAbsentAsFile(t *testing.T) {
	cases := []struct {
		self, peer string
		want       bool
	}{
		{ModeFile, "", true}, // new sender, old peer
		{"", ModeFile, true}, // old sender, new peer
		{"", "", true},       // two old peers
		{ModeFile, ModeFile, true},
		{ModeText, ModeText, true},
		{ModeText, "", false}, // text against an older peer -- must refuse
		{ModeText, ModeFile, false},
		{ModeFile, ModeText, false},
	}
	for _, c := range cases {
		if got := ModeCompatible(c.self, c.peer); got != c.want {
			t.Errorf("ModeCompatible(%q,%q) = %v, want %v", c.self, c.peer, got, c.want)
		}
	}
}

// Fail closed on anything outside the known set, including when BOTH sides send
// the same unknown value: agreeing on a mode neither end implements is not
// agreement, and equality alone would wave it through.
func TestModeCompatibleRejectsUnknownModes(t *testing.T) {
	for _, c := range [][2]string{
		{"banana", "banana"},
		{"banana", ModeFile},
		{ModeFile, "banana"},
		{ModeText, "banana"},
		{"FILE", ModeFile},                    // case-sensitive
		{" file", ModeFile},                   // no trimming
		{"file\x00", ModeFile},                // no truncation at a NUL
		{strings.Repeat("f", 4096), ModeFile}, // a peer-controlled string, unbounded
	} {
		if ModeCompatible(c[0], c[1]) {
			t.Errorf("ModeCompatible(%q,%q) = true, want false", c[0], c[1])
		}
	}
}

// The mode rides the COMMIT, which is the first message either side sends, so it
// is known before the reveal, before RaceDirect, and before any TLS connection.
func TestDoHandshakeCarriesTheMode(t *testing.T) {
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
		h, err := DoHandshake(ctx, a, idA, nil, ModeText)
		ch <- res{h, err}
	}()
	hb, err := DoHandshake(ctx, b, idB, nil, ModeText)
	if err != nil {
		t.Fatalf("handshake b: %v", err)
	}
	ra := <-ch
	if ra.err != nil {
		t.Fatalf("handshake a: %v", ra.err)
	}
	if ra.h.PeerMode != ModeText || hb.PeerMode != ModeText {
		t.Fatalf("PeerMode = %q / %q, want %q", ra.h.PeerMode, hb.PeerMode, ModeText)
	}
	// The handshake itself still agrees on everything it agreed on before.
	if ra.h.SAS != hb.SAS {
		t.Fatalf("SAS disagree: %s vs %s", ra.h.SAS, hb.SAS)
	}
	if ra.h.IsServer == hb.IsServer {
		t.Fatal("both peers picked the same TLS role")
	}
}

// A file-mode handshake must put NOTHING new on the wire: `omitempty` is what
// keeps an already-deployed peer seeing byte-identical commit JSON.
func TestFileModeAddsNothingToTheCommitWire(t *testing.T) {
	b, err := json.Marshal(hsMsg{Kind: "commit", Commit: "Yw=="})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "mode") {
		t.Fatalf("commit JSON carries a mode field when none was set: %s", b)
	}
	withText, err := json.Marshal(hsMsg{Kind: "commit", Commit: "Yw==", Mode: ModeText})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(withText), `"mode":"text"`) {
		t.Fatalf("text mode missing from commit JSON: %s", withText)
	}
}

// And a peer that sends a mode we do not understand is reported verbatim rather
// than normalised away, so the caller can refuse and say what it saw.
func TestDoHandshakeReportsAnUnknownPeerModeVerbatim(t *testing.T) {
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

	idB, _ := secure.NewIdentity()
	nonce, _ := secure.NewNonce()

	// Drive side A by hand, the way TestDoHandshakeAbortsOnCommitMismatch does.
	go func() {
		idA, _ := secure.NewIdentity()
		_ = sendHS(ctx, a, hsMsg{
			Kind:   "commit",
			Commit: base64.StdEncoding.EncodeToString(secure.Commit(idA.Fingerprint, nonce)),
			Mode:   "banana",
		})
		_, _ = recvHS(ctx, a, "commit")
		_ = sendHS(ctx, a, hsMsg{
			Kind:        "reveal",
			Fingerprint: idA.Fingerprint,
			Nonce:       base64.StdEncoding.EncodeToString(nonce),
		})
		_, _ = recvHS(ctx, a, "reveal")
	}()

	hb, err := DoHandshake(ctx, b, idB, nil, ModeFile)
	if err != nil {
		t.Fatalf("handshake b: %v", err)
	}
	if hb.PeerMode != "banana" {
		t.Fatalf("PeerMode = %q, want it reported verbatim", hb.PeerMode)
	}
	if ModeCompatible(ModeFile, hb.PeerMode) {
		t.Fatal("an unknown peer mode must not be compatible with file")
	}
}
