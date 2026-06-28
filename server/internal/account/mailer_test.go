package account

import (
	"bytes"
	"context"
	"log"
	"testing"
)

func TestLogMailerWritesLink(t *testing.T) {
	var buf bytes.Buffer
	m := &LogMailer{Log: log.New(&buf, "", 0)}
	if err := m.SendMagicLink(context.Background(), "f@example.com", "https://relayium.com/api/auth/magic/verify?token=abc"); err != nil {
		t.Fatalf("send: %v", err)
	}
	if !bytes.Contains(buf.Bytes(), []byte("token=abc")) || !bytes.Contains(buf.Bytes(), []byte("f@example.com")) {
		t.Fatalf("log missing link/email: %q", buf.String())
	}
}
