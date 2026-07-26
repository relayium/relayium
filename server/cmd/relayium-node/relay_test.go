package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"testing"
)

// The node's AuthHandler must accept exactly the credential /api/ice mints:
// password = base64(HMAC-SHA1(secret, username)). This test pins that formula.
func TestLongTermPasswordMatchesCentral(t *testing.T) {
	secret := "sek"
	username := "6000:userX.123456"
	// central formula (account/turn.go turnCredentials)
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	want := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	if got := longTermPassword(secret, username); got != want {
		t.Fatalf("longTermPassword=%q want %q", got, want)
	}
}

func TestCredentialExpiry(t *testing.T) {
	// username "<expiry>:token" — expired if expiry < now.
	if !credentialExpired("100:userX.1", 200) {
		t.Fatal("should be expired")
	}
	if credentialExpired("300:userX.1", 200) {
		t.Fatal("should be valid")
	}
	if !credentialExpired("garbage", 200) {
		t.Fatal("malformed username treated as expired")
	}
}

// storageReport wraps storage.DiskUsage to report the node's blob-dir capacity
// for register/heartbeat; this pins its (total, free) arithmetic.
func TestStorageReport(t *testing.T) {
	total, free, err := storageReport(t.TempDir())
	if err != nil {
		t.Fatalf("storageReport: %v", err)
	}
	if total == 0 || free == 0 || free > total {
		t.Fatalf("implausible total=%d free=%d", total, free)
	}
}
