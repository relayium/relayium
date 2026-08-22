package account

import (
	"bytes"
	"context"
	"log"
	"strings"
	"sync"
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

// secretToken is the string every default-mode assertion below hunts for. If it
// ever appears in a log line, a credential has leaked.
const secretToken = "s3cr3t-token-value"

// logMailerCalls exercises every Mailer method that carries a credential-bearing
// link, so a method added later without redaction fails these tests rather than
// quietly shipping.
func logMailerCalls(m *LogMailer, email, link string) []func() error {
	ctx := context.Background()
	return []func() error{
		func() error { return m.SendMagicLink(ctx, email, link) },
		func() error { return m.SendVerifyEmail(ctx, email, link) },
		func() error { return m.SendPasswordReset(ctx, email, link) },
		func() error { return m.SendAccountDeletionConfirm(ctx, email, link) },
		func() error { return m.SendAccountDeletionScheduled(ctx, email, 1700000000, link) },
		func() error { return m.SendAccountDeletionReminder(ctx, email, 1700000000, link) },
		func() error { return m.SendAccountDeleted(ctx, email) },
	}
}

// logMailerCallCount is how many credential-bearing entry points the assertions
// below must cover.
var logMailerCallCount = len(logMailerCalls(&LogMailer{}, "", ""))

// TestLogMailerRedactsByDefault is the core credential invariant (I1-I3): with
// RevealLinks unset, NO method may write the token, the query, the fragment or
// the full recipient address.
func TestLogMailerRedactsByDefault(t *testing.T) {
	const email = "founder@example.com"
	link := "https://relayium.com/api/auth/magic/verify?token=" + secretToken + "#frag-" + secretToken

	for i := 0; i < logMailerCallCount; i++ {
		var buf bytes.Buffer
		m := &LogMailer{Log: log.New(&buf, "", 0)}
		if err := logMailerCalls(m, email, link)[i](); err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
		got := buf.String()
		if got == "" {
			t.Fatalf("call %d wrote nothing; an operator must still see that mail happened", i)
		}
		for _, forbidden := range []string{secretToken, "token=", "#frag", "founder@example.com", "founder"} {
			if strings.Contains(got, forbidden) {
				t.Errorf("call %d leaked %q: %s", i, forbidden, got)
			}
		}
		if !strings.Contains(got, "f***@example.com") {
			t.Errorf("call %d should mask the local part, got: %s", i, got)
		}
	}
}

// TestLogMailerLogsOnlyThePath proves the retained fragment of a link is its
// path and nothing else — no host, no userinfo, no query (I3).
func TestLogMailerLogsOnlyThePath(t *testing.T) {
	var buf bytes.Buffer
	m := &LogMailer{Log: log.New(&buf, "", 0)}
	if err := m.SendVerifyEmail(context.Background(),
		"user@example.com",
		"https://alice:hunter2@relayium.com/verify-email?token="+secretToken); err != nil {
		t.Fatalf("send: %v", err)
	}
	got := buf.String()
	if !strings.Contains(got, "/verify-email") {
		t.Errorf("path should survive: %s", got)
	}
	for _, forbidden := range []string{secretToken, "relayium.com", "alice", "hunter2"} {
		if strings.Contains(got, forbidden) {
			t.Errorf("leaked %q: %s", forbidden, got)
		}
	}
}

// TestLogMailerNeverEchoesMalformedInput is the adversarial case (I4): a crafted
// address or link must not place ANY attacker-chosen byte in the log. Newlines
// and terminal escapes would otherwise forge log lines.
func TestLogMailerNeverEchoesMalformedInput(t *testing.T) {
	hostileEmails := []string{
		"not-an-email",
		"a@b@c",
		"",
		"victim@example.com\nAUG 01 12:00:00 relayium: FORGED ADMIN LOGIN ok",
		"victim@example.com\x1b[2J",
		"<script>alert(1)</script>@example.com",
	}
	hostileLinks := []string{
		"javascript:alert(1)",
		"::::not a url",
		"",
		"/relative/only?token=" + secretToken,
		"https://relayium.com/a\nFORGED: admin session granted",
		"file:///etc/passwd",
		"http://relayium.com/\x1b]0;pwned\a",
	}
	for _, email := range hostileEmails {
		for _, link := range hostileLinks {
			var buf bytes.Buffer
			m := &LogMailer{Log: log.New(&buf, "", 0)}
			for i, call := range logMailerCalls(m, email, link) {
				if err := call(); err != nil {
					t.Fatalf("call %d: %v", i, err)
				}
			}
			got := buf.String()
			if strings.Contains(got, secretToken) {
				t.Errorf("token leaked for email=%q link=%q: %s", email, link, got)
			}
			for _, forged := range []string{"FORGED", "script", "pwned", "/etc/passwd", "alert(1)"} {
				if strings.Contains(got, forged) {
					t.Errorf("echoed attacker bytes %q for email=%q link=%q: %s", forged, email, link, got)
				}
			}
			// One log line per call, always: an embedded newline that survived
			// would let a caller forge a second, authoritative-looking record.
			if n := strings.Count(got, "\n"); n != logMailerCallCount {
				t.Errorf("want %d lines, got %d for email=%q link=%q: %q",
					logMailerCallCount, n, email, link, got)
			}
		}
	}
}

// TestLogMailerRevealLinks documents the one deliberate escape hatch: with
// RevealLinks true the full recipient and full link are printed, which is why
// the transport that sets it is refused unless the deployment is provably local.
func TestLogMailerRevealLinks(t *testing.T) {
	var buf bytes.Buffer
	m := &LogMailer{Log: log.New(&buf, "", 0), RevealLinks: true}
	link := "http://localhost:8080/verify-email?token=" + secretToken
	if err := m.SendVerifyEmail(context.Background(), "f@example.com", link); err != nil {
		t.Fatalf("send: %v", err)
	}
	if !strings.Contains(buf.String(), link) || !strings.Contains(buf.String(), "f@example.com") {
		t.Fatalf("dev mode should print the full link and address: %q", buf.String())
	}
}

// syncBuffer is a bytes.Buffer that is safe to read while something else is
// writing. TestLogMailerZeroValueIsSafe has to redirect the PROCESS-WIDE
// default logger, and any goroutine left running by an earlier test in this
// package can log into it at the same time; a plain bytes.Buffer would be a
// data race between that write and this test's read.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// TestLogMailerZeroValueIsSafe: LogMailer{} must neither panic on its nil logger
// nor reveal anything (I1). The default logger is redirected so the assertion is
// about content, not about where it went.
func TestLogMailerZeroValueIsSafe(t *testing.T) {
	buf := &syncBuffer{}
	savedWriter, savedFlags := log.Default().Writer(), log.Default().Flags()
	log.Default().SetOutput(buf)
	log.Default().SetFlags(0)
	t.Cleanup(func() {
		log.Default().SetOutput(savedWriter)
		log.Default().SetFlags(savedFlags)
	})

	m := &LogMailer{} // zero value: nil Log, RevealLinks false
	for i, call := range logMailerCalls(m, "founder@example.com", "https://relayium.com/x?token="+secretToken) {
		if err := call(); err != nil {
			t.Fatalf("zero-value call %d returned %v, want nil", i, err)
		}
	}
	got := buf.String()
	if got == "" {
		t.Fatal("zero value should still record the events")
	}
	if strings.Contains(got, secretToken) || strings.Contains(got, "founder@example.com") {
		t.Fatalf("zero value must redact: %s", got)
	}
	if !strings.Contains(got, "f***@example.com") {
		t.Fatalf("zero value should still mask and record the recipient: %s", got)
	}
}

// TestLogMailerAlwaysReturnsNil pins the semantics every caller relies on (I9).
func TestLogMailerAlwaysReturnsNil(t *testing.T) {
	var buf bytes.Buffer
	for _, reveal := range []bool{false, true} {
		m := &LogMailer{Log: log.New(&buf, "", 0), RevealLinks: reveal}
		for i, call := range logMailerCalls(m, "bad input", "also bad") {
			if err := call(); err != nil {
				t.Errorf("reveal=%v call %d returned %v, want nil", reveal, i, err)
			}
		}
	}
}

func TestMaskEmail(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"founder@example.com", "f***@example.com"},
		{"f@example.com", "f***@example.com"},
		{"Full Name <founder@example.com>", "f***@example.com"},
		{"用户@example.com", "用***@example.com"},
		{"no-at-sign", redactedPlaceholder},
		{"", redactedPlaceholder},
		{"@example.com", redactedPlaceholder},
		{"founder@", redactedPlaceholder},
	} {
		if got := maskEmail(tc.in); got != tc.want {
			t.Errorf("maskEmail(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestLinkPath(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"https://relayium.com/verify-email?token=abc", "/verify-email"},
		{"http://127.0.0.1:8080/account/delete/confirm?token=abc#f", "/account/delete/confirm"},
		{"https://relayium.com", "/"},
		{"https://relayium.com/", "/"},
		{"/relative?token=abc", redactedPlaceholder},
		{"javascript:alert(1)", redactedPlaceholder},
		{"file:///etc/passwd", redactedPlaceholder},
		{"", redactedPlaceholder},
		{"http://relayium.com/a\nb", redactedPlaceholder},
	} {
		if got := linkPath(tc.in); got != tc.want {
			t.Errorf("linkPath(%q) = %q, want %q", tc.in, got, tc.want)
		}
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
	var _ Mailer = &LogMailer{} // the zero value is a usable, redacting Mailer
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
