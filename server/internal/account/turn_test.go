package account

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"testing"
)

func TestTurnCredentials(t *testing.T) {
	secret := "s3cr3t"
	token := "abc123"
	expiry := int64(1_000_000)
	urls := []string{"turn:turn.example.com:3478", "turns:turn.example.com:5349"}

	got := turnCredentials(secret, token, expiry, urls)

	wantUser := "1000000:abc123"
	if got.Username != wantUser {
		t.Fatalf("username = %q, want %q", got.Username, wantUser)
	}
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(wantUser))
	wantCred := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if got.Credential != wantCred {
		t.Fatalf("credential = %q, want %q", got.Credential, wantCred)
	}
	if fmt.Sprint(got.URLs) != fmt.Sprint(urls) {
		t.Fatalf("urls = %v, want %v", got.URLs, urls)
	}
}
