package account

import (
	"bytes"
	"context"
	"log"
	"testing"
)

func TestNewSMTPMailerAuth(t *testing.T) {
	withAuth := NewSMTPMailer("smtp.example.com:587", "no-reply@x.com", "user@x.com", "pw")
	if withAuth.Auth == nil {
		t.Fatal("expected non-nil Auth when SMTP credentials are provided")
	}
	if withAuth.Addr != "smtp.example.com:587" || withAuth.From != "no-reply@x.com" {
		t.Fatalf("addr/from not carried through: %+v", withAuth)
	}
	noAuth := NewSMTPMailer("127.0.0.1:25", "no-reply@x.com", "", "")
	if noAuth.Auth != nil {
		t.Fatal("expected nil Auth for an unauthenticated relay (empty user)")
	}
}

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
