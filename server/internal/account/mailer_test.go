package account

import (
	"bytes"
	"context"
	"log"
	"strings"
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

// captureMailer records the most recent link per kind for assertions.
type captureMailer struct {
	magic, verify, reset                 string
	deleteConfirm, deletionScheduledLink string
	deletionReminderLink                 string
	accountDeletedCount                  int
}

func (m *captureMailer) SendMagicLink(_ context.Context, _, link string) error {
	m.magic = link
	return nil
}
func (m *captureMailer) SendVerifyEmail(_ context.Context, _, link string) error {
	m.verify = link
	return nil
}
func (m *captureMailer) SendPasswordReset(_ context.Context, _, link string) error {
	m.reset = link
	return nil
}
func (m *captureMailer) SendAccountDeletionConfirm(_ context.Context, _, link string) error {
	m.deleteConfirm = link
	return nil
}
func (m *captureMailer) SendAccountDeletionScheduled(_ context.Context, _ string, _ int64, reactivateLink string) error {
	m.deletionScheduledLink = reactivateLink
	return nil
}
func (m *captureMailer) SendAccountDeletionReminder(_ context.Context, _ string, _ int64, reactivateLink string) error {
	m.deletionReminderLink = reactivateLink
	return nil
}
func (m *captureMailer) SendAccountDeleted(_ context.Context, _ string) error {
	m.accountDeletedCount++
	return nil
}

func TestCaptureMailerSatisfiesInterface(t *testing.T) {
	var _ Mailer = &captureMailer{}
	var _ Mailer = &LogMailer{Log: nil} // interface conformance only
}

// TestBuildMessageHeaders locks in the headers a strict filter (amavis) requires:
// Date and a domain-scoped Message-ID were missing originally and got the first
// verification emails quarantined as bad-header.
func TestBuildMessageHeaders(t *testing.T) {
	m := NewSMTPMailer("mail.relayium.com:587", "noreply@relayium.com", "", "")
	msg := string(m.buildMessage("user@example.com", "Verify your Relayium email", "text body", "<p>html body</p>"))
	for _, want := range []string{
		"From: noreply@relayium.com\r\n",
		"To: user@example.com\r\n",
		"Subject: Verify your Relayium email\r\n",
		"Date: ",
		"Message-ID: <",
		"@relayium.com>\r\n",
		"MIME-Version: 1.0\r\n",
		"Content-Type: multipart/alternative;",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("built message missing %q\n---\n%s", want, msg)
		}
	}
	// Message-ID must be unique per message (random token), so two builds differ.
	if m.buildMessage("user@example.com", "s", "t", "h") == nil {
		t.Fatal("nil message")
	}
	msgA := string(m.buildMessage("a@example.com", "s", "t", "h"))
	msgB := string(m.buildMessage("a@example.com", "s", "t", "h"))
	if idHeader(msgA) == "" || idHeader(msgA) == idHeader(msgB) {
		t.Errorf("Message-ID should be present and unique per message: %q vs %q", idHeader(msgA), idHeader(msgB))
	}
}

// idHeader returns the Message-ID header line value from a raw message, or "".
func idHeader(msg string) string {
	for _, line := range strings.Split(msg, "\r\n") {
		if strings.HasPrefix(line, "Message-ID:") {
			return line
		}
	}
	return ""
}

// smtpDomain falls back gracefully when the From address has no usable domain.
func TestSMTPDomainFallback(t *testing.T) {
	if d := smtpDomain("noreply@relayium.com", "mail.relayium.com:587"); d != "relayium.com" {
		t.Errorf("want relayium.com, got %q", d)
	}
	if d := smtpDomain("garbage-no-at", "mail.relayium.com:587"); d != "mail.relayium.com" {
		t.Errorf("want SMTP host fallback mail.relayium.com, got %q", d)
	}
	if d := smtpDomain("", ""); d != "localhost" {
		t.Errorf("want localhost fallback, got %q", d)
	}
}
