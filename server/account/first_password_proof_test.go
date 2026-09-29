package account

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

func firstPasswordFixture(t *testing.T) (*Service, *SQLiteStore, *capturingMailer, User, Session) {
	t.Helper()
	st := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(st, mail, Config{BaseURL: "https://relayium.com", SessionTTL: time.Hour})
	svc.now = func() time.Time { return time.Unix(10_000, 0) }
	u, err := st.UpsertUserByEmail(t.Context(), "proof@example.com", "Proof")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetEmailVerified(t.Context(), u.ID); err != nil {
		t.Fatal(err)
	}
	sess, err := svc.IssueSession(t.Context(), u.ID)
	if err != nil {
		t.Fatal(err)
	}
	return svc, st, mail, u, sess
}

func proofToken(t *testing.T, mail *capturingMailer) string {
	t.Helper()
	mail.mu.Lock()
	raw := mail.lastLink
	mail.mu.Unlock()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if u.Path != "/set-password" || u.RawQuery != "" {
		t.Fatalf("unsafe proof link %q", raw)
	}
	return newQuery(u.Fragment).Get("token")
}

func newQuery(fragment string) url.Values { v, _ := url.ParseQuery(fragment); return v }

func TestFirstPasswordProofBindsAccountEpochAndSingleUse(t *testing.T) {
	svc, st, mail, u, sess := firstPasswordFixture(t)
	if err := svc.RequestFirstPasswordProof(t.Context(), u); err != nil {
		t.Fatal(err)
	}
	raw := proofToken(t, mail)
	if raw == "" {
		t.Fatal("missing fragment token")
	}
	tok, ok, err := st.PeekEmailToken(t.Context(), hashTokenForTest(raw), "set-password", 10_000)
	if err != nil || !ok {
		t.Fatalf("peek: ok=%v err=%v", ok, err)
	}
	if tok.UserID != u.ID || tok.CredentialEpoch != 0 || tok.ExpiresAt != 10_300 {
		t.Fatalf("binding: %+v", tok)
	}

	other, _ := st.UpsertUserByEmail(t.Context(), "other@example.com", "Other")
	if err := svc.SetFirstPasswordWithProof(t.Context(), other, "other-session", raw, "freshpass12"); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("cross-account: %v", err)
	}
	if err := svc.SetFirstPasswordWithProof(t.Context(), u, sess.ID, raw, "freshpass12"); err != nil {
		t.Fatalf("set: %v", err)
	}
	if err := svc.SetFirstPasswordWithProof(t.Context(), u, sess.ID, raw, "anotherpass12"); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("replay: %v", err)
	}
	if _, err := svc.Login(t.Context(), u.Email, "freshpass12"); err != nil {
		t.Fatalf("login: %v", err)
	}
	if _, err := svc.Login(t.Context(), u.Email, "anotherpass12"); !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("replay changed password: %v", err)
	}
}

func hashTokenForTest(raw string) string { return authx.HashToken(raw) }

func TestFirstPasswordProofEpochRaceAndRollbackPreserveState(t *testing.T) {
	svc, st, mail, u, sess := firstPasswordFixture(t)
	if err := svc.RequestFirstPasswordProof(t.Context(), u); err != nil {
		t.Fatal(err)
	}
	raw := proofToken(t, mail)
	if _, err := st.db.Exec(`UPDATE users SET credential_epoch = credential_epoch + 1 WHERE id = ?`, u.ID); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetFirstPasswordWithProof(t.Context(), u, sess.ID, raw, "freshpass12"); !errors.Is(err, ErrCredentialsChanged) {
		t.Fatalf("epoch race: %v", err)
	}
	if _, ok, _ := st.PeekEmailToken(t.Context(), hashTokenForTest(raw), "set-password", 10_000); !ok {
		t.Fatal("epoch refusal spent proof")
	}
	if has, _ := st.HasPassword(t.Context(), u.ID); has {
		t.Fatal("epoch refusal set password")
	}

	if _, err := st.db.Exec(`UPDATE email_tokens SET credential_epoch = 1 WHERE token_hash = ?`, hashTokenForTest(raw)); err != nil {
		t.Fatal(err)
	}
	if _, err := st.db.Exec(`CREATE TRIGGER fail_password_identity BEFORE INSERT ON identities WHEN NEW.provider = 'password' BEGIN SELECT RAISE(ABORT, 'injected'); END`); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetFirstPasswordWithProof(t.Context(), u, sess.ID, raw, "freshpass12"); err == nil || !strings.Contains(err.Error(), "injected") {
		t.Fatalf("fault: %v", err)
	}
	if _, ok, _ := st.PeekEmailToken(context.Background(), hashTokenForTest(raw), "set-password", 10_000); !ok {
		t.Fatal("rollback spent proof")
	}
	if has, _ := st.HasPassword(t.Context(), u.ID); has {
		t.Fatal("rollback set password")
	}
}

func TestFirstPasswordProofRejectsExpiredAndWrongActionTokens(t *testing.T) {
	svc, st, mail, u, sess := firstPasswordFixture(t)
	if err := svc.RequestFirstPasswordProof(t.Context(), u); err != nil {
		t.Fatal(err)
	}
	raw := proofToken(t, mail)
	svc.now = func() time.Time { return time.Unix(10_301, 0) }
	if err := svc.SetFirstPasswordWithProof(t.Context(), u, sess.ID, raw, "freshpass12"); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("expired: %v", err)
	}
	if has, _ := st.HasPassword(t.Context(), u.ID); has {
		t.Fatal("expired proof set password")
	}

	resetRaw := "reset-action-token"
	if err := st.CreateEmailToken(t.Context(), EmailToken{TokenHash: authx.HashToken(resetRaw), UserID: u.ID, Email: u.Email, Purpose: "reset", CreatedAt: 10_301, ExpiresAt: 20_000}); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetFirstPasswordWithProof(t.Context(), u, sess.ID, resetRaw, "freshpass12"); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("wrong action: %v", err)
	}
	if _, ok, _ := st.PeekEmailToken(t.Context(), authx.HashToken(resetRaw), "reset", 10_301); !ok {
		t.Fatal("wrong-action attempt spent reset token")
	}
}
