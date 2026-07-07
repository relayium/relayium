package secure

import (
	"encoding/hex"
	"testing"
)

func TestIdentityFingerprintStable(t *testing.T) {
	id, err := NewIdentity()
	if err != nil {
		t.Fatalf("new identity: %v", err)
	}
	if len(id.TLSCert.Certificate) == 0 {
		t.Fatal("no cert der")
	}
	if _, err := hex.DecodeString(id.Fingerprint); err != nil || len(id.Fingerprint) != 64 {
		t.Fatalf("fingerprint not 32-byte hex: %q", id.Fingerprint)
	}
}

func TestCommitRoundtripAndReject(t *testing.T) {
	nonce, _ := NewNonce()
	fp := "aa11bb22"
	c := Commit(fp, nonce)
	if !VerifyCommit(c, fp, nonce) {
		t.Fatal("valid commit rejected")
	}
	if VerifyCommit(c, "deadbeef", nonce) {
		t.Fatal("wrong fingerprint accepted")
	}
	bad := make([]byte, len(nonce))
	copy(bad, nonce)
	bad[0] ^= 1
	if VerifyCommit(c, fp, bad) {
		t.Fatal("wrong nonce accepted")
	}
}

func TestSASOrderIndependentAnd6Digits(t *testing.T) {
	a := "00ff00ff"
	b := "ffee00aa"
	s1 := SAS(a, b)
	s2 := SAS(b, a)
	if s1 != s2 {
		t.Fatalf("SAS not order-independent: %s vs %s", s1, s2)
	}
	if len(s1) != 6 {
		t.Fatalf("SAS not 6 digits: %q", s1)
	}
	for _, r := range s1 {
		if r < '0' || r > '9' {
			t.Fatalf("SAS not decimal: %q", s1)
		}
	}
}
