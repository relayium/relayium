package selfupdate

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

// Golden vector produced by the real CI signing path — stock OpenSSL:
//
//	openssl ecparam -name prime256v1 -genkey -noout -out k.key
//	openssl ec -in k.key -pubout -out k.pub
//	printf 'abc123  relayium_linux_amd64.tar.gz\n' > checksums.txt
//	openssl dgst -sha256 -sign k.key -out checksums.txt.sig checksums.txt
//
// This pins the exact format `.goreleaser.yaml` signs with (ECDSA-P256, ASN.1/DER
// over sha256), so a future change that breaks openssl<->stdlib interop fails here
// instead of silently rejecting every real release (verification is fail-closed).
const (
	goldenPubPEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEhjZ2oZTG8X2YnDAu32q2tYN5w3Lq
liBF1HFOFzL742ZZamvotKfN9/5ZGlWeNXlA1/7QWXVGmvOMgkLRUtXbGQ==
-----END PUBLIC KEY-----`
	goldenData   = "abc123  relayium_linux_amd64.tar.gz\n"
	goldenSigB64 = "MEYCIQCXBo03fAyXTC3DvntBgTp76AYgPpZlfdXMFwFB4dXo2AIhAOA/9uEcqJYk1qdyYH0u/XDcHcBuchs2z/aqgC+sd2Xi"
)

func TestVerifyGoldenOpenSSLSignature(t *testing.T) {
	pub, err := parseECDSAPublicKey(goldenPubPEM)
	if err != nil {
		t.Fatalf("parse golden pub: %v", err)
	}
	sig, err := base64.StdEncoding.DecodeString(goldenSigB64)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyECDSASignature(pub, []byte(goldenData), sig); err != nil {
		t.Fatalf("golden OpenSSL signature must verify with the stdlib path: %v", err)
	}
	// Tampered checksums must be rejected (fail-closed).
	if err := verifyECDSASignature(pub, []byte(goldenData+"x"), sig); err == nil {
		t.Fatal("tampered checksums verified — signature check is not fail-closed")
	}
}

func TestParseECDSAPublicKeyRejectsBadInput(t *testing.T) {
	for _, bad := range []string{"", "not a pem", "-----BEGIN PUBLIC KEY-----\nZ\n-----END PUBLIC KEY-----"} {
		if _, err := parseECDSAPublicKey(bad); err == nil {
			t.Errorf("expected error for %q", bad)
		}
	}
}

// A signature from a DIFFERENT key must be rejected even though it's well-formed.
func TestVerifyRejectsWrongKey(t *testing.T) {
	k1, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	k2, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	data := []byte("checksums payload")
	h := sha256.Sum256(data)
	sig, err := ecdsa.SignASN1(rand.Reader, k1, h[:])
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyECDSASignature(&k1.PublicKey, data, sig); err != nil {
		t.Fatalf("same-key verify should pass: %v", err)
	}
	if err := verifyECDSASignature(&k2.PublicKey, data, sig); err == nil {
		t.Fatal("signature verified against the wrong public key")
	}
}
