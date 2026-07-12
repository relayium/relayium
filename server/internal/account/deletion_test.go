package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"
)

// httptestPost issues a POST with an optional string body and cookie against
// the test server, using its default (redirect-following) client — fine here
// since none of these endpoints redirect.
func httptestPost(t *testing.T, url, body string, cookie *http.Cookie) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewBufferString(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	return resp
}

// httptestPostJSON POSTs a JSON-encoded body, no cookie — the confirm
// endpoint is unauthenticated by design (the token is the authorization).
func httptestPostJSON(t *testing.T, url string, v any) *http.Response {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	resp, err := http.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	return resp
}

// withCookie builds a *http.Cookie carrying the session, for httptestPost.
func withCookie(sessionID string) *http.Cookie {
	return &http.Cookie{Name: sessionCookie, Value: sessionID}
}

func TestDeleteRequestThenConfirm(t *testing.T) {
	ts, svc, store, mail := newFileServer(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "a@example.com", "")
	sess, _ := svc.IssueSession(ctx, u.ID)
	_ = store.CreateStoredFile(ctx, StoredFile{ID: newID(), UserID: u.ID, BlobKey: "bk", EncManifest: []byte("x"), Size: 1, ExpiresAt: 1 << 40, CreatedAt: 1})

	// request → sends a delete email token, no destructive action
	req := httptestPost(t, ts.URL+"/api/account/delete/request", "", withCookie(sess.ID))
	if req.StatusCode != 200 {
		t.Fatalf("request: %d", req.StatusCode)
	}
	rawToken := mail.lastDeleteToken(t) // capturing mailer exposes the token from the link it "sent"
	if u2, _ := store.GetUserByID(ctx, u.ID); u2.DeletedAt != 0 {
		t.Fatal("request must not set deleted_at")
	}

	// confirm → sets deleted_at/purge_after, purges transient data
	conf := httptestPostJSON(t, ts.URL+"/api/account/delete/confirm", map[string]string{"token": rawToken})
	if conf.StatusCode != 200 {
		t.Fatalf("confirm: %d", conf.StatusCode)
	}
	u3, _ := store.GetUserByID(ctx, u.ID)
	if u3.DeletedAt == 0 || u3.PurgeAfter <= u3.DeletedAt {
		t.Fatalf("confirm should schedule purge: %+v", u3)
	}
	if files, _ := store.ListStoredFilesByUser(ctx, u.ID); len(files) != 0 {
		t.Fatal("stored files should be purged on confirm")
	}
	if _, ok, _ := store.GetSession(ctx, sess.ID); ok {
		t.Fatal("sessions should be revoked on confirm")
	}
}

// TestDeleteRequestRequiresSession: no cookie → 401, and no mail sent.
func TestDeleteRequestRequiresSession(t *testing.T) {
	ts, _, _, mail := newFileServer(t)
	resp := httptestPost(t, ts.URL+"/api/account/delete/request", "", nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", resp.StatusCode)
	}
	if mail.lastDeleteLink != "" {
		t.Fatal("no email should be sent for an unauthenticated request")
	}
}

// TestDeleteConfirmInvalidToken: a bogus token is rejected with 400, and never
// touches account state.
func TestDeleteConfirmInvalidToken(t *testing.T) {
	ts, _, store, _ := newFileServer(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "b@example.com", "")

	resp := httptestPostJSON(t, ts.URL+"/api/account/delete/confirm", map[string]string{"token": "not-a-real-token"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", resp.StatusCode)
	}
	if u2, _ := store.GetUserByID(ctx, u.ID); u2.DeletedAt != 0 {
		t.Fatal("bogus token must not schedule deletion")
	}
}

// scheduledMailFailMailer is a capturingMailer whose SendAccountDeletionScheduled
// always fails, to prove confirm treats that send as best-effort.
type scheduledMailFailMailer struct{ capturingMailer }

func (m *scheduledMailFailMailer) SendAccountDeletionScheduled(_ context.Context, _ string, purgeAt int64, reactivateLink string) error {
	// Still record what would have been sent (so the test can read the
	// reactivate link) but report the send as failed.
	m.mu.Lock()
	m.lastPurgeAt = purgeAt
	m.lastReactivateLink = reactivateLink
	m.mu.Unlock()
	return errors.New("smtp down")
}

// TestDeleteConfirmSurvivesScheduledEmailFailure: when the scheduled-deletion
// email fails to send, confirm must still return 200, the account must still
// be scheduled (deleted_at/purge_after set), and a reactivate token must exist
// so reactivation stays possible despite the send failure.
func TestDeleteConfirmSurvivesScheduledEmailFailure(t *testing.T) {
	store := newTestStore(t)
	mail := &scheduledMailFailMailer{}
	svc := NewService(store, mail, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour,
		AccountGraceDays: 30,
	})
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "d@example.com", "")

	if err := svc.RequestAccountDeletion(ctx, u.ID, u.Email); err != nil {
		t.Fatalf("request: %v", err)
	}
	rawToken := mail.lastDeleteToken(t)

	// Confirm directly against the service (a failing SMTP send must be
	// non-fatal — the handler would surface it as 500 only if the service
	// returned an error, which it must not).
	if err := svc.ConfirmAccountDeletion(ctx, rawToken); err != nil {
		t.Fatalf("confirm must not error on scheduled-email failure: %v", err)
	}
	u2, _ := store.GetUserByID(ctx, u.ID)
	if u2.DeletedAt == 0 || u2.PurgeAfter <= u2.DeletedAt {
		t.Fatalf("deletion must still be scheduled: %+v", u2)
	}
	// A reactivate token must exist and be usable for this user.
	rtok, ok, err := store.UseEmailToken(ctx, hashToken(mail.lastReactivateToken(t)), "reactivate", svc.now().Unix())
	if err != nil {
		t.Fatalf("use reactivate token: %v", err)
	}
	if !ok || rtok.UserID != u.ID {
		t.Fatalf("expected a usable reactivate token for user %s, got ok=%v tok=%+v", u.ID, ok, rtok)
	}
}

// TestDeleteConfirmIdempotent: confirming twice (e.g. an email client
// prefetching the link, or the user clicking it twice) must not re-run the
// purge or blow up — the token is single-use so the second confirm attempt
// uses a *fresh* first-confirm token replay path: we simulate "already
// pending" by calling ConfirmAccountDeletion twice with two separately issued
// tokens for the same account, and asserting the second call is a no-op that
// doesn't re-send SendAccountDeletionScheduled or reset purge_after.
func TestDeleteConfirmIdempotent(t *testing.T) {
	ts, svc, store, mail := newFileServer(t)
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "c@example.com", "")
	sess, _ := svc.IssueSession(ctx, u.ID)

	req := httptestPost(t, ts.URL+"/api/account/delete/request", "", withCookie(sess.ID))
	if req.StatusCode != 200 {
		t.Fatalf("request: %d", req.StatusCode)
	}
	tok1 := mail.lastDeleteToken(t)
	conf1 := httptestPostJSON(t, ts.URL+"/api/account/delete/confirm", map[string]string{"token": tok1})
	if conf1.StatusCode != 200 {
		t.Fatalf("first confirm: %d", conf1.StatusCode)
	}
	u2, _ := store.GetUserByID(ctx, u.ID)
	firstPurgeAfter := u2.PurgeAfter
	sentAfterFirst := mail.deletionScheduled

	// Issue and use a second delete token directly against the service (the
	// account is already pending, so a second real request/confirm round trip
	// exercises the idempotent branch in ConfirmAccountDeletion).
	if err := svc.RequestAccountDeletion(ctx, u.ID, u.Email); err != nil {
		t.Fatalf("second request: %v", err)
	}
	tok2 := mail.lastDeleteToken(t)
	if err := svc.ConfirmAccountDeletion(ctx, tok2); err != nil {
		t.Fatalf("second confirm: %v", err)
	}
	u3, _ := store.GetUserByID(ctx, u.ID)
	if u3.PurgeAfter != firstPurgeAfter {
		t.Fatalf("idempotent confirm must not reschedule purge: first=%d second=%d", firstPurgeAfter, u3.PurgeAfter)
	}
	if mail.deletionScheduled != sentAfterFirst {
		t.Fatalf("idempotent confirm must not re-send the scheduled email: want %d sends, got %d", sentAfterFirst, mail.deletionScheduled)
	}
}
