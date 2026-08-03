package account

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

// capturingMailer records the last link so the test can replay it, and counts
// sends so rate-limit tests can assert how many links actually went out.
type capturingMailer struct {
	mu       sync.Mutex
	lastLink string
	count    int

	// Deletion-flow captures (Task 3): kept distinct from lastLink/count so a
	// test can assert on the delete-confirm link, the post-confirm reactivate
	// link, and the scheduled purge time without racing other mailer calls.
	lastDeleteLink      string // confirm-deletion link from SendAccountDeletionConfirm
	lastDeleteEmail     string // address that link was sent to
	deleteRequests      int    // SendAccountDeletionConfirm calls
	lastReactivateLink  string // reactivate link from SendAccountDeletionScheduled/Reminder
	lastPurgeAt         int64
	deletionScheduled   int
	deletionReminders   int
	accountDeletedSends int
}

func (m *capturingMailer) SendMagicLink(_ context.Context, _, link string) error {
	m.mu.Lock()
	m.lastLink = link
	m.count++
	m.mu.Unlock()
	return nil
}

func (m *capturingMailer) SendVerifyEmail(_ context.Context, _, link string) error {
	m.mu.Lock()
	m.lastLink = link
	m.count++
	m.mu.Unlock()
	return nil
}

func (m *capturingMailer) SendPasswordReset(_ context.Context, _, link string) error {
	m.mu.Lock()
	m.lastLink = link
	m.count++
	m.mu.Unlock()
	return nil
}

func (m *capturingMailer) sends() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.count
}

func (m *capturingMailer) SendAccountDeletionConfirm(_ context.Context, email, link string) error {
	m.mu.Lock()
	m.lastDeleteEmail = email
	m.lastDeleteLink = link
	m.deleteRequests++
	m.mu.Unlock()
	return nil
}

// deleteConfirmSends reports how many delete-confirm emails were sent, under
// the same lock every field is written behind.
func (m *capturingMailer) deleteConfirmSends() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.deleteRequests
}

// deleteConfirmRecipient is the address the last delete-confirm link was
// addressed to. The endpoint answers the same generic 200 whatever happens, so
// this is the only place a test can see WHICH account a request actually acted
// for — which is the whole question a bearer-authenticated route raises.
func (m *capturingMailer) deleteConfirmRecipient() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lastDeleteEmail
}

func (m *capturingMailer) SendAccountDeletionScheduled(_ context.Context, _ string, purgeAt int64, reactivateLink string) error {
	m.mu.Lock()
	m.lastPurgeAt = purgeAt
	m.lastReactivateLink = reactivateLink
	m.deletionScheduled++
	m.mu.Unlock()
	return nil
}

func (m *capturingMailer) SendAccountDeletionReminder(_ context.Context, _ string, purgeAt int64, reactivateLink string) error {
	m.mu.Lock()
	m.lastPurgeAt = purgeAt
	m.lastReactivateLink = reactivateLink
	m.deletionReminders++
	m.mu.Unlock()
	return nil
}

func (m *capturingMailer) SendAccountDeleted(_ context.Context, _ string) error {
	m.mu.Lock()
	m.accountDeletedSends++
	m.mu.Unlock()
	return nil
}

// lastDeleteToken extracts the raw token from the last captured
// account-deletion confirm link ("...?token=<raw>"), failing the test if none
// was sent or the link has no token param.
func (m *capturingMailer) lastDeleteToken(t *testing.T) string {
	t.Helper()
	m.mu.Lock()
	link := m.lastDeleteLink
	m.mu.Unlock()
	i := strings.Index(link, "token=")
	if i < 0 {
		t.Fatalf("no delete-confirm token captured in link %q", link)
	}
	return link[i+len("token="):]
}

// lastReactivateToken extracts the raw token from the last captured
// reactivate link, analogous to lastDeleteToken.
func (m *capturingMailer) lastReactivateToken(t *testing.T) string {
	t.Helper()
	m.mu.Lock()
	link := m.lastReactivateLink
	m.mu.Unlock()
	i := strings.Index(link, "token=")
	if i < 0 {
		t.Fatalf("no reactivate token captured in link %q", link)
	}
	return link[i+len("token="):]
}

func newMagicTestService(t *testing.T) (*Service, *capturingMailer) {
	t.Helper()
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{
		BaseURL:    "https://relayium.com",
		SessionTTL: time.Hour,
		MagicTTL:   15 * time.Minute,
	})
	return svc, mail
}

// A malformed address (e.g. embedded CRLF for SMTP header injection) must be a
// silent no-op: no mail sent, no error leaked.
func TestRequestMagicLinkRejectsMalformedEmail(t *testing.T) {
	svc, mail := newMagicTestService(t)
	ctx := context.Background()
	for _, bad := range []string{
		"victim@example.com\r\nBcc: evil@x.com",
		"a@b.com\nSubject: hijack",
		"not-an-email",
		"",
	} {
		if err := svc.RequestMagicLink(ctx, bad); err != nil {
			t.Errorf("RequestMagicLink(%q) = %v, want silent nil", bad, err)
		}
	}
	if mail.sends() != 0 {
		t.Fatalf("mailer sent %d messages for malformed addresses; want 0", mail.sends())
	}
}

func TestMagicLinkRoundTripIssuesSession(t *testing.T) {
	svc, mail := newMagicTestService(t)
	ctx := context.Background()
	if err := svc.RequestMagicLink(ctx, "G@Example.com"); err != nil {
		t.Fatalf("request: %v", err)
	}
	// Extract token from the captured link.
	const marker = "token="
	i := indexOf(mail.lastLink, marker)
	if i < 0 {
		t.Fatalf("no token in link: %q", mail.lastLink)
	}
	token := mail.lastLink[i+len(marker):]
	sess, err := svc.VerifyMagicLink(ctx, token)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	u, ok, err := svc.ValidateSession(ctx, sess.ID)
	if err != nil || !ok {
		t.Fatalf("validate: ok=%v err=%v", ok, err)
	}
	if u.Email != "g@example.com" {
		t.Fatalf("email not normalized through flow: %q", u.Email)
	}
	// Token is single-use.
	if _, err := svc.VerifyMagicLink(ctx, token); err == nil {
		t.Fatalf("token reuse must fail")
	}
}

func TestExpiredSessionInvalid(t *testing.T) {
	svc, _ := newMagicTestService(t)
	ctx := context.Background()
	u, _ := svc.store.UpsertUserByEmail(ctx, "h@example.com", "H")
	base := time.Unix(1000, 0)
	svc.now = func() time.Time { return base }
	sess, _ := svc.IssueSession(ctx, u.ID)
	svc.now = func() time.Time { return base.Add(2 * time.Hour) } // past SessionTTL
	if _, ok, _ := svc.ValidateSession(ctx, sess.ID); ok {
		t.Fatalf("expired session must be invalid")
	}
}

// indexOf is a tiny helper to avoid importing strings in the test for one call.
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
