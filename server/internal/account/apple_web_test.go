package account

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"testing"
)

// genP8 produces a PKCS#8 PEM block like Apple's downloadable .p8 key.
func genP8(t *testing.T) ([]byte, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), key
}

func TestLoadAppleP8(t *testing.T) {
	pemBytes, want := genP8(t)
	got, err := loadAppleP8(pemBytes)
	if err != nil {
		t.Fatalf("loadAppleP8: %v", err)
	}
	if got.D.Cmp(want.D) != 0 {
		t.Fatal("parsed key does not match original")
	}
}

func TestLoadAppleP8_Malformed(t *testing.T) {
	if _, err := loadAppleP8([]byte("not a pem")); err == nil {
		t.Fatal("expected error on malformed .p8")
	}
}
