package dltoken

import "testing"

func TestSignedTokenVerifiesBeforeExpiry(t *testing.T) {
	tok := Sign("nodesecret", "blobkey123", 1000, "abc")
	if !Verify("nodesecret", "blobkey123", 500, tok) {
		t.Fatal("a freshly signed token must verify for the same key/secret before expiry")
	}
}

func TestExpiredTokenRejected(t *testing.T) {
	tok := Sign("nodesecret", "blobkey123", 1000, "abc")
	if Verify("nodesecret", "blobkey123", 1001, tok) {
		t.Fatal("a token must be rejected once now is past exp")
	}
	// Exactly at exp is still valid (now <= exp).
	if !Verify("nodesecret", "blobkey123", 1000, tok) {
		t.Fatal("a token must still verify at exactly exp")
	}
}

func TestTokenBoundToKey(t *testing.T) {
	tok := Sign("nodesecret", "keyA", 1000, "abc")
	if Verify("nodesecret", "keyB", 500, tok) {
		t.Fatal("a token for keyA must not authorize keyB")
	}
}

func TestTokenBoundToSecret(t *testing.T) {
	tok := Sign("nodesecret", "blobkey123", 1000, "abc")
	if Verify("othersecret", "blobkey123", 500, tok) {
		t.Fatal("a token must not verify under a different node secret")
	}
}

func TestTamperedTokenRejected(t *testing.T) {
	tok := Sign("nodesecret", "blobkey123", 1000, "abc")
	// Forge a later expiry while keeping the original MAC: the MAC covers exp, so
	// this must fail (otherwise anyone could extend a token's life).
	forged := "9999999999." + "abc" + tok[len("1000.abc"):]
	if Verify("nodesecret", "blobkey123", 5000, forged) {
		t.Fatal("editing exp without re-signing must be rejected")
	}
}

func TestNonceExtractsTheNonce(t *testing.T) {
	tok := Sign("s", "k", 1000, "abc123")
	if got := Nonce(tok); got != "abc123" {
		t.Fatalf("Nonce = %q, want abc123", got)
	}
	if got := Nonce("garbage"); got != "" {
		t.Fatalf("Nonce of a malformed token must be empty, got %q", got)
	}
}

func TestMalformedTokenRejected(t *testing.T) {
	for _, bad := range []string{"", "onlyonepart", "a.b", "a.b.c.d", "notanumber.abc.mac"} {
		if Verify("nodesecret", "blobkey123", 500, bad) {
			t.Fatalf("malformed token %q must be rejected", bad)
		}
	}
}
