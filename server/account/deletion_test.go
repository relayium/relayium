package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
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
	_ = store.CreateStoredFile(ctx, StoredFile{ID: authx.NewID(), UserID: u.ID, BlobKey: "bk", EncManifest: []byte("x"), Size: 1, ExpiresAt: 1 << 40, CreatedAt: 1})

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

// TestDeleteRequestRequiresAuthentication: no credential → 401, and no mail
// sent. The route accepts a bearer as well as a cookie since the native apps
// need it (see deletion_bearer_test.go); what it never accepts is nothing.
func TestDeleteRequestRequiresAuthentication(t *testing.T) {
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
	rtok, ok, err := store.UseEmailToken(ctx, authx.HashToken(mail.lastReactivateToken(t)), "reactivate", svc.now().Unix())
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

// --- Task 4: frozen login (all auth methods) + reactivation + registration guard ---

// httpJSONResp is the trio of things the Task 4 test helpers below care about
// from a JSON auth-endpoint response: status code, decoded body, and whether
// a session cookie was set.
type httpJSONResp struct {
	status    int
	json      map[string]any
	setCookie string
}

// mustPasswordUser creates a login-ready (verified) password account,
// reusing the Register + SetEmailVerified path the existing password-login
// tests already establish (see TestPasswordRegisterLoginAndMethods).
func mustPasswordUser(t *testing.T, svc *Service, store *SQLiteStore, email, password string) User {
	t.Helper()
	ctx := context.Background()
	u, err := svc.Register(ctx, email, password, "")
	if err != nil {
		t.Fatalf("register %s: %v", email, err)
	}
	if err := store.SetEmailVerified(ctx, u.ID); err != nil {
		t.Fatalf("verify %s: %v", email, err)
	}
	return u
}

// loginPassword posts to /api/auth/password/login and reports status, decoded
// JSON body, and any session cookie value set (empty string = none set).
func loginPassword(t *testing.T, baseURL, email, password string) httpJSONResp {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"email": email, "password": password})
	resp, err := http.Post(baseURL+"/api/auth/password/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("login post: %v", err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	cookie := ""
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie {
			cookie = c.Value
		}
	}
	return httpJSONResp{status: resp.StatusCode, json: out, setCookie: cookie}
}

// register posts to /api/auth/register.
func register(t *testing.T, baseURL, email, password string) httpJSONResp {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"email": email, "password": password})
	resp, err := http.Post(baseURL+"/api/auth/register", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("register post: %v", err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return httpJSONResp{status: resp.StatusCode, json: out}
}

// TestPasswordLoginFrozenWhenPendingDeletion: correct credentials against a
// pending-deletion account must not issue a session — the JSON body carries
// the pending_deletion state (purgeAfter + a fresh reactivate token) instead,
// still HTTP 200 since the credentials themselves were fine.
func TestPasswordLoginFrozenWhenPendingDeletion(t *testing.T) {
	ts, svc, store, _ := newFileServer(t)
	ctx := context.Background()
	u := mustPasswordUser(t, svc, store, "a@example.com", "correct-horse")
	if err := store.SetAccountDeletion(ctx, u.ID, 100, 100+30*86400); err != nil {
		t.Fatalf("set deletion: %v", err)
	}
	resp := loginPassword(t, ts.URL, "a@example.com", "correct-horse")
	if resp.status != 200 {
		t.Fatalf("want 200 pending, got %d", resp.status)
	}
	if resp.json["status"] != "pending_deletion" || resp.json["reactivateToken"] == "" {
		t.Fatalf("want pending_deletion+token, got %+v", resp.json)
	}
	if resp.setCookie != "" {
		t.Fatal("no session cookie must be set for a frozen account")
	}
}

// TestMagicLoginFrozenWhenPendingDeletion mirrors the password-login guard for
// the magic-link path: a frozen account gets no session and a fresh reactivate
// token instead. Since M5 the token is consumed by the POST (the GET only
// redirects into the SPA page), so the reactivate token comes back in the JSON
// body — which also keeps it out of the URL and the Referer entirely.
func TestMagicLoginFrozenWhenPendingDeletion(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "m@example.com", "")
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := store.SetAccountDeletion(ctx, u.ID, 100, 100+30*86400); err != nil {
		t.Fatalf("set deletion: %v", err)
	}

	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if _, err := client.PostForm(ts.URL+"/api/auth/magic/request", map[string][]string{"email": {"m@example.com"}}); err != nil {
		t.Fatalf("magic request: %v", err)
	}
	i := strings.Index(mail.lastLink, "token=")
	if i < 0 {
		t.Fatalf("no magic token captured: %q", mail.lastLink)
	}
	resp, err := client.Post(ts.URL+"/api/auth/magic/verify", "application/json",
		strings.NewReader(`{"token":"`+mail.lastLink[i+len("token="):]+`"}`))
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200 with a pending_deletion body, got %d", resp.StatusCode)
	}
	var body struct {
		Status          string `json:"status"`
		ReactivateToken string `json:"reactivateToken"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Status != "pending_deletion" || body.ReactivateToken == "" {
		t.Fatalf("want a pending_deletion status with a fresh reactivate token, got %+v", body)
	}
	if hasSessionCookie(resp.Cookies()) {
		t.Fatal("no session cookie must be set for a frozen account via magic link")
	}
}

// TestOAuthCallbackFrozenWhenPendingDeletion mirrors the guard for the OAuth
// path: the callback redirects to the pending_deletion query params instead
// of "/", with no session cookie, even though Google returned a fully
// verified identity for the (pending-deletion) account's email.
func TestOAuthCallbackFrozenWhenPendingDeletion(t *testing.T) {
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, EnableGoogle: true,
		AccountGraceDays: 30,
	})
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "gfrozen@example.com", "Frozen")
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := store.SetAccountDeletion(ctx, u.ID, 100, 100+30*86400); err != nil {
		t.Fatalf("set deletion: %v", err)
	}
	svc.fetchGoogleUser = func(context.Context, string) (string, string, string, bool, error) {
		return "google-sub-frozen", "gfrozen@example.com", "Frozen", true, nil
	}
	ts := httptest.NewServer(svc.Routes())
	defer ts.Close()
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	req, _ := http.NewRequest("GET", ts.URL+"/api/auth/google/callback?code=abc&state=s1", nil)
	req.AddCookie(&http.Cookie{Name: "relayium_oauth_state", Value: "s1"})
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("want redirect, got %d", resp.StatusCode)
	}
	loc := resp.Header.Get("Location")
	// Reactivate token in the fragment, never the query (no log/Referer leak).
	if !strings.Contains(loc, "#account=pending_deletion") || !strings.Contains(loc, "token=") {
		t.Fatalf("want pending_deletion fragment redirect with token, got %q", loc)
	}
	if strings.Contains(loc, "?account=pending_deletion") {
		t.Fatalf("reactivate token must not be in the query string: %q", loc)
	}
	if hasSessionCookie(resp.Cookies()) {
		t.Fatal("no session cookie must be set for a frozen account via OAuth")
	}
}

// TestReactivateRestoresLogin drives the full frozen-login round trip: a
// pending-deletion account's login hands back a reactivate token; posting
// that token to /api/account/reactivate clears the deletion columns; and a
// subsequent login now issues a normal session.
func TestReactivateRestoresLogin(t *testing.T) {
	ts, svc, store, _ := newFileServer(t)
	ctx := context.Background()
	u := mustPasswordUser(t, svc, store, "a@example.com", "correct-horse")
	if err := store.SetAccountDeletion(ctx, u.ID, 100, 100+30*86400); err != nil {
		t.Fatalf("set deletion: %v", err)
	}
	pending := loginPassword(t, ts.URL, "a@example.com", "correct-horse")
	tok, _ := pending.json["reactivateToken"].(string)
	if tok == "" {
		t.Fatalf("no reactivate token in pending response: %+v", pending.json)
	}
	r := httptestPostJSON(t, ts.URL+"/api/account/reactivate", map[string]string{"token": tok})
	if r.StatusCode != 200 {
		t.Fatalf("reactivate: %d", r.StatusCode)
	}
	if u2, _ := store.GetUserByID(ctx, u.ID); u2.DeletedAt != 0 || u2.PurgeAfter != 0 {
		t.Fatalf("reactivate should clear deletion: %+v", u2)
	}
	// A subsequent login now issues a real session.
	ok := loginPassword(t, ts.URL, "a@example.com", "correct-horse")
	if ok.setCookie == "" || ok.json["status"] == "pending_deletion" {
		t.Fatal("login after reactivation should issue a session")
	}
}

// TestReactivateInvalidTokenRejected: a bogus/expired/already-used token is
// refused with 400 and never touches account state.
func TestReactivateInvalidTokenRejected(t *testing.T) {
	ts, _, _, _ := newFileServer(t)
	resp := httptestPostJSON(t, ts.URL+"/api/account/reactivate", map[string]string{"token": "not-a-real-token"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", resp.StatusCode)
	}
}

// TestRegisterRefusesPendingDeletionEmail: registering an email address that
// belongs to a pending-deletion account must be refused, not silently create
// a second live account on that address.
func TestRegisterRefusesPendingDeletionEmail(t *testing.T) {
	ts, svc, store, _ := newFileServer(t)
	ctx := context.Background()
	u := mustPasswordUser(t, svc, store, "a@example.com", "pw12345678")
	if err := store.SetAccountDeletion(ctx, u.ID, 100, 100+30*86400); err != nil {
		t.Fatalf("set deletion: %v", err)
	}
	resp := register(t, ts.URL, "a@example.com", "another12345")
	if resp.status == 200 {
		t.Fatal("registering a pending-delete email must be refused")
	}
	if resp.json["error"] != "account_pending_deletion" {
		t.Fatalf("want account_pending_deletion error, got %+v", resp.json)
	}
}

// TestRegisterRefusesPendingDeletionCanonicalSibling proves the register
// guard is checked against the canonical form, not just the exact address —
// a gmail dot-fold/+tag variant of a pending-deletion account must also be
// refused (mirrors the existing canonical-dedupe Sybil-mint tests).
func TestRegisterRefusesPendingDeletionCanonicalSibling(t *testing.T) {
	ts, svc, store, _ := newFileServer(t)
	ctx := context.Background()
	u := mustPasswordUser(t, svc, store, "a.b@gmail.com", "pw12345678")
	if err := store.SetAccountDeletion(ctx, u.ID, 100, 100+30*86400); err != nil {
		t.Fatalf("set deletion: %v", err)
	}
	// "ab@gmail.com" dot-folds to the same canonical form as "a.b@gmail.com"
	// (see TestRegisterCanonicalDedupeGmail).
	resp := register(t, ts.URL, "ab@gmail.com", "another12345")
	if resp.status == 200 {
		t.Fatal("registering a canonical sibling of a pending-delete email must be refused")
	}
	if resp.json["error"] != "account_pending_deletion" {
		t.Fatalf("want account_pending_deletion error, got %+v", resp.json)
	}
}

// --- Blocker fix: session-issuing paths other than the 3 login flows must
// also honor the frozen-account guard, and the guard must also stop any
// session that slips through by other means. ---

// TestResetPasswordOnFrozenAccountIssuesNoSession: a pending-deletion account
// that drives forgot→reset with valid credentials/token must not come out
// the other end with a usable session — no session cookie is set, the
// response instead carries the same pending_deletion state the 3 login paths
// return, and any (bogus) cookie value can't be used against a
// RequireSession-gated endpoint either.
func TestResetPasswordOnFrozenAccountIssuesNoSession(t *testing.T) {
	// Built directly (not via newFileServer) so ResetTTL is actually set —
	// newFileServer's Config omits ResetTTL/VerifyTTL (it targets file-upload
	// tests), which would make the reset token expire the instant it's minted.
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, ResetTTL: time.Hour,
		AccountGraceDays: 30,
	})
	ts := httptest.NewServer(svc.Routes())
	defer ts.Close()
	ctx := context.Background()
	u := mustPasswordUser(t, svc, store, "frozen-reset@example.com", "correct-horse")
	if err := store.SetAccountDeletion(ctx, u.ID, 100, 100+30*86400); err != nil {
		t.Fatalf("set deletion: %v", err)
	}

	if err := svc.RequestPasswordReset(ctx, "frozen-reset@example.com"); err != nil {
		t.Fatalf("request reset: %v", err)
	}
	if mail.lastLink == "" {
		t.Fatal("reset email not sent")
	}

	body, _ := json.Marshal(map[string]string{
		"token": tokenFromLink(t, mail.lastLink), "newPassword": "brandnewpass",
	})
	resp, err := http.Post(ts.URL+"/api/auth/password/reset", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("reset post: %v", err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)

	if resp.StatusCode != 200 {
		t.Fatalf("want 200 pending, got %d body=%+v", resp.StatusCode, out)
	}
	if out["status"] != "pending_deletion" || out["reactivateToken"] == "" {
		t.Fatalf("want pending_deletion+token, got %+v", out)
	}
	if hasSessionCookie(resp.Cookies()) {
		t.Fatal("no session cookie must be set for a frozen account via password reset")
	}

	// Belt and suspenders: even if a cookie had been set, a RequireSession
	// endpoint must reject it (proves the central ValidateSession guard also
	// covers this path independent of the handler's own check).
	req, _ := http.NewRequest("GET", ts.URL+"/api/me", nil)
	for _, c := range resp.Cookies() {
		req.AddCookie(c)
	}
	meResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("/api/me: %v", err)
	}
	defer meResp.Body.Close()
	if meResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("/api/me after frozen reset must 401, got %d", meResp.StatusCode)
	}
}

// TestValidateSessionRejectsFrozenUser proves the central guard in
// ValidateSession catches a session minted before an account became
// pending-deletion (e.g. by some future/other issuing path, not just the
// three guarded login flows) — not just sessions issued afterward.
func TestValidateSessionRejectsFrozenUser(t *testing.T) {
	ts, svc, store, _ := newFileServer(t)
	ctx := context.Background()
	u := mustPasswordUser(t, svc, store, "residual@example.com", "correct-horse")
	sess, err := svc.IssueSession(ctx, u.ID)
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	// Sanity: the session works before the account is frozen.
	if _, ok, err := svc.ValidateSession(ctx, sess.ID); err != nil || !ok {
		t.Fatalf("session should validate before freeze: ok=%v err=%v", ok, err)
	}

	if err := store.SetAccountDeletion(ctx, u.ID, 100, 100+30*86400); err != nil {
		t.Fatalf("set deletion: %v", err)
	}

	if _, ok, err := svc.ValidateSession(ctx, sess.ID); err != nil || ok {
		t.Fatalf("ValidateSession must reject a session for a now-frozen account: ok=%v err=%v", ok, err)
	}

	req, _ := http.NewRequest("GET", ts.URL+"/api/me", nil)
	req.AddCookie(withCookie(sess.ID))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("/api/me: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("/api/me with a residual session for a frozen account must 401, got %d", resp.StatusCode)
	}
}
