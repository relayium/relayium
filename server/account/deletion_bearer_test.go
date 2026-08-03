package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

// POST /api/account/delete/request moved from RequireSession to RequireAuth so
// the native apps — which hold a rlm_cli_ bearer and never a session cookie —
// can start the existing double-opt-in deletion flow without a browser.
//
// The widening is the whole risk surface, so these tests pin both halves of it:
// what a bearer may now do (ask the server to email a confirm link to ITS OWN
// account's address, and nothing else), and what did not move with it (a
// missing or unusable credential is still 401, a cookie POST from a foreign
// Origin is still refused by CSRFGuard, and no request of any kind touches
// account state — only the link in the email can do that).

// deletionHarness mounts the production Routes()/middleware, because the auth
// and CSRF behaviour is precisely what is under test. Modelled on
// deviceHarness, with the capturing mailer the deletion flow needs.
type deletionHarness struct {
	ts    *httptest.Server
	svc   *Service
	store *SQLiteStore
	mail  *capturingMailer
}

func newDeletionHarness(t *testing.T) *deletionHarness {
	t.Helper()
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour,
		AccountGraceDays: 30,
	})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	return &deletionHarness{ts: ts, svc: svc, store: store, mail: mail}
}

func (h *deletionHarness) user(t *testing.T, email string) User {
	t.Helper()
	u, err := h.store.UpsertUserByEmail(context.Background(), email, "Test")
	if err != nil {
		t.Fatalf("create user %s: %v", email, err)
	}
	return u
}

// bearer mints exactly what a native login mints: a device row plus the CLI
// token bound to it.
func (h *deletionHarness) bearer(t *testing.T, userID, deviceName string) string {
	t.Helper()
	tok, err := h.svc.issueBearer(context.Background(), userID, deviceName)
	if err != nil {
		t.Fatalf("issue bearer: %v", err)
	}
	return tok
}

func (h *deletionHarness) cookie(t *testing.T, userID string) *http.Cookie {
	t.Helper()
	sess, err := h.svc.IssueSession(context.Background(), userID)
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	return &http.Cookie{Name: sessionCookie, Value: sess.ID}
}

// requestDeletion POSTs to the request endpoint with whatever the mutator puts
// on the request, and returns the response.
func (h *deletionHarness) requestDeletion(t *testing.T, mutate func(*http.Request)) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, h.ts.URL+"/api/account/delete/request", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if mutate != nil {
		mutate(req)
	}
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatalf("post delete/request: %v", err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// assertNotPending is the invariant every test here shares: asking is not
// deleting, whatever the request carried.
func (h *deletionHarness) assertNotPending(t *testing.T, userID string) {
	t.Helper()
	u, err := h.store.GetUserByID(context.Background(), userID)
	if err != nil {
		t.Fatalf("read user: %v", err)
	}
	if u.DeletedAt != 0 || u.PurgeAfter != 0 {
		t.Fatalf("requesting must not touch account state: deleted_at=%d purge_after=%d",
			u.DeletedAt, u.PurgeAfter)
	}
}

// A valid bearer reaches the endpoint, and the link goes to the address of the
// account that bearer belongs to — the one thing the generic 200 cannot tell a
// test on its own.
func TestDeleteRequestAcceptsABearerAndEmailsThatAccount(t *testing.T) {
	h := newDeletionHarness(t)
	u := h.user(t, "owner@example.com")
	token := h.bearer(t, u.ID, "Ada's iPhone")

	resp := h.requestDeletion(t, withBearer(token))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("bearer delete/request: got %d, want 200", resp.StatusCode)
	}
	// The same generic body the cookie path has always answered with: the send
	// outcome is not observable, so nothing here may become an oracle.
	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["status"] != "sent" {
		t.Fatalf("body = %+v, want the generic {\"status\":\"sent\"}", body)
	}

	if got := h.mail.deleteConfirmRecipient(); got != "owner@example.com" {
		t.Fatalf("confirm link addressed to %q, want the bearer's own account", got)
	}
	// And the link really is a usable delete token for THAT user, not merely a
	// well-formed URL.
	tok, ok, err := h.store.UseEmailToken(context.Background(),
		authx.HashToken(h.mail.lastDeleteToken(t)), "delete", h.svc.now().Unix())
	if err != nil {
		t.Fatalf("use delete token: %v", err)
	}
	if !ok || tok.UserID != u.ID || tok.Email != "owner@example.com" {
		t.Fatalf("token ok=%v user=%q email=%q, want a delete token for %s",
			ok, tok.UserID, tok.Email, u.ID)
	}
	h.assertNotPending(t, u.ID)
}

// One bearer resolves exactly one user. A second account existing — with its
// own bearer — must not be reachable from the first one's credential, and the
// only address any request can name is its own.
func TestDeleteRequestBearerActsOnlyForItsOwnAccount(t *testing.T) {
	h := newDeletionHarness(t)
	mine := h.user(t, "mine@example.com")
	theirs := h.user(t, "theirs@example.com")
	myToken := h.bearer(t, mine.ID, "My iPhone")
	h.bearer(t, theirs.ID, "Their Mac")

	if resp := h.requestDeletion(t, withBearer(myToken)); resp.StatusCode != http.StatusOK {
		t.Fatalf("got %d, want 200", resp.StatusCode)
	}
	if got := h.mail.deleteConfirmRecipient(); got != "mine@example.com" {
		t.Fatalf("confirm link addressed to %q, want mine@example.com", got)
	}
	h.assertNotPending(t, mine.ID)
	h.assertNotPending(t, theirs.ID)
}

// No credential, a malformed header, and a bearer that is simply not a token:
// each is 401, and none of them may cause mail to be sent.
func TestDeleteRequestWithoutAUsableCredentialIsUnauthorized(t *testing.T) {
	h := newDeletionHarness(t)
	u := h.user(t, "quiet@example.com")

	cases := []struct {
		name   string
		mutate func(*http.Request)
	}{
		{"no credential at all", nil},
		{"unknown bearer", withBearer("rlm_cli_not_a_real_token")},
		{"empty bearer", withBearer("")},
		{"malformed authorization header", func(r *http.Request) {
			r.Header.Set("Authorization", "rlm_cli_no_scheme")
		}},
		{"unknown session cookie", func(r *http.Request) {
			r.AddCookie(&http.Cookie{Name: sessionCookie, Value: "not-a-session"})
		}},
	}
	for _, c := range cases {
		resp := h.requestDeletion(t, c.mutate)
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s: got %d, want 401", c.name, resp.StatusCode)
		}
	}
	if n := h.mail.deleteConfirmSends(); n != 0 {
		t.Fatalf("%d confirm emails sent for unauthenticated requests, want 0", n)
	}
	h.assertNotPending(t, u.ID)
}

// A bearer whose account is already pending deletion is refused, exactly as it
// is everywhere else: UserFromAuth's central frozen-account guard is what the
// cookie path gets from ValidateSession, and widening this route must not have
// bought a frozen account a way back in.
func TestDeleteRequestRefusesABearerForAFrozenAccount(t *testing.T) {
	h := newDeletionHarness(t)
	u := h.user(t, "frozen@example.com")
	token := h.bearer(t, u.ID, "Ada's iPhone")
	if err := h.store.SetAccountDeletion(context.Background(), u.ID, 100, 100+30*86400); err != nil {
		t.Fatalf("set deletion: %v", err)
	}

	if resp := h.requestDeletion(t, withBearer(token)); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401 for a frozen account's bearer", resp.StatusCode)
	}
	if n := h.mail.deleteConfirmSends(); n != 0 {
		t.Fatalf("%d confirm emails sent for a frozen account, want 0", n)
	}
}

// Widening auth must not widen CSRF. A cookie-authenticated POST carrying a
// foreign Origin is still refused by CSRFGuard before it reaches the handler —
// the browser's exposure is byte-for-byte what it was.
func TestCrossOriginCookieDeleteRequestIsStillRejected(t *testing.T) {
	h := newDeletionHarness(t)
	u := h.user(t, "csrf@example.com")
	c := h.cookie(t, u.ID)

	resp := h.requestDeletion(t, func(r *http.Request) {
		r.AddCookie(c)
		r.Header.Set("Origin", "https://evil.example")
	})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin cookie request: got %d, want 403", resp.StatusCode)
	}
	if n := h.mail.deleteConfirmSends(); n != 0 {
		t.Fatalf("%d confirm emails sent for a cross-origin request, want 0", n)
	}
	h.assertNotPending(t, u.ID)

	// The same cookie from the site's own origin still works, so the 403 above
	// is the Origin check and not a broken cookie.
	same := h.requestDeletion(t, func(r *http.Request) {
		r.AddCookie(c)
		r.Header.Set("Origin", "http://example.test")
	})
	if same.StatusCode != http.StatusOK {
		t.Fatalf("same-origin cookie request: got %d, want 200", same.StatusCode)
	}
	if got := h.mail.deleteConfirmRecipient(); got != "csrf@example.com" {
		t.Fatalf("confirm link addressed to %q", got)
	}
}

// A bearer is not a browser credential: it carries no ambient authority, so a
// cross-origin Origin header on a bearer request is not CSRF and is not
// rejected. Pinned so the reasoning stays visible — CSRFGuard runs before auth
// and cannot tell the two apart, which is why the guard only fires on a
// mismatched Origin at all, and a bearer request from a native app never sets
// one in the first place.
func TestABearerRequestCarriesNoOriginAndIsUnaffectedByCSRF(t *testing.T) {
	h := newDeletionHarness(t)
	u := h.user(t, "native@example.com")
	token := h.bearer(t, u.ID, "Ada's iPhone")

	resp := h.requestDeletion(t, withBearer(token))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("got %d, want 200", resp.StatusCode)
	}
	if got := h.mail.deleteConfirmRecipient(); got != "native@example.com" {
		t.Fatalf("confirm link addressed to %q", got)
	}
}

// The full native round trip: a bearer asks, the emailed token confirms, and
// only THEN is anything destroyed. This is the claim the app's copy makes, so
// it is asserted end to end rather than inferred from the two halves.
// Built on newFileServer rather than the harness above: confirming purges
// stored objects, which reaches the blob store, and only that fixture has one.
func TestBearerRequestThenEmailedTokenConfirmsTheDeletion(t *testing.T) {
	ts, svc, store, mail := newFileServer(t)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "roundtrip@example.com", "Test")
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	token, err := svc.issueBearer(ctx, u.ID, "Ada's iPhone")
	if err != nil {
		t.Fatalf("issue bearer: %v", err)
	}
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: authx.NewID(), UserID: u.ID, BlobKey: "bk", EncManifest: []byte("x"),
		Size: 1, ExpiresAt: 1 << 40, CreatedAt: 1,
	}); err != nil {
		t.Fatalf("create stored file: %v", err)
	}

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/account/delete/request", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("request: %d", resp.StatusCode)
	}
	if before, _ := store.GetUserByID(ctx, u.ID); before.DeletedAt != 0 {
		t.Fatal("requesting must not set deleted_at")
	}
	if files, _ := store.ListStoredFilesByUser(ctx, u.ID); len(files) != 1 {
		t.Fatalf("requesting must not purge stored data: %d files left", len(files))
	}

	body := strings.NewReader(`{"token":"` + mail.lastDeleteToken(t) + `"}`)
	confirm, err := ts.Client().Post(ts.URL+"/api/account/delete/confirm", "application/json", body)
	if err != nil {
		t.Fatalf("confirm: %v", err)
	}
	defer confirm.Body.Close()
	if confirm.StatusCode != http.StatusOK {
		t.Fatalf("confirm: %d", confirm.StatusCode)
	}
	after, _ := store.GetUserByID(ctx, u.ID)
	if after.DeletedAt == 0 || after.PurgeAfter <= after.DeletedAt {
		t.Fatalf("confirm should schedule the purge: %+v", after)
	}
	if files, _ := store.ListStoredFilesByUser(ctx, u.ID); len(files) != 0 {
		t.Fatalf("confirm should purge stored data: %d files left", len(files))
	}
}
