package account

import (
	"context"
	"testing"
	"time"
)

// capturingMailer records the last link so the test can replay it.
type capturingMailer struct{ lastLink string }

func (m *capturingMailer) SendMagicLink(_ context.Context, _, link string) error {
	m.lastLink = link
	return nil
}

func newTestService(t *testing.T) (*Service, *capturingMailer) {
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

func TestMagicLinkRoundTripIssuesSession(t *testing.T) {
	svc, mail := newTestService(t)
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
	svc, _ := newTestService(t)
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
