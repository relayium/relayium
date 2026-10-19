package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/go-webauthn/webauthn/webauthn"
)

// Test infrastructure for the Passkey-only admin console.
//
// Admin sign-in no longer has a password path, so the fixtures that used to
// POST /admin/login with a password now obtain a session the only way that
// exists: a registered passkey and a session bound to it. Two flavours:
//
//   - adminTestPasskey registers a REAL credential from a software
//     authenticator (testAuthenticator) whenever the service has a BaseURL, so
//     tests can drive actual login and step-up assertions over HTTP;
//   - services without a BaseURL (some handler-only tests) get a placeholder
//     credential row: enough for a session to validate, never enough to sign
//     an assertion.
//
// Every credential row here is written with seedAdminCredentialRow, i.e.
// directly into SQLite — exactly what production code can NOT do from the
// request path any more.

type adminTestKey struct {
	auth   *testAuthenticator // nil for a placeholder credential
	handle []byte
	credID string
}

var (
	adminTestKeys    sync.Map // *Service -> *adminTestKey
	adminTestServers sync.Map // test server URL -> *Service
)

// seedAdminCredentialRow inserts one admin_credentials row directly.
func seedAdminCredentialRow(t testing.TB, st Store, c AdminCredential) {
	t.Helper()
	if w, ok := st.(interface{ underlying() Store }); ok {
		st = w.underlying()
	}
	// *SQLiteStore itself, or a test wrapper embedding it.
	aa, ok := st.(interface{ AdminAuth() *AdminAuthStore })
	if !ok {
		t.Fatalf("seedAdminCredentialRow needs a SQLite-backed store, got %T", st)
	}
	if _, err := aa.AdminAuth().db.Exec(`INSERT INTO admin_credentials (id, user_handle, cred_json, name, created_at, last_used_at)
		VALUES (?, ?, ?, ?, ?, ?)`, c.ID, c.UserHandle, c.CredJSON, c.Name, c.CreatedAt, c.LastUsedAt); err != nil {
		t.Fatalf("seed admin credential: %v", err)
	}
}

// newRealAdminCredential builds a stored credential for auth exactly as a
// successful WebAuthn registration would, through the library itself.
func newRealAdminCredential(t testing.TB, s *Service, auth *testAuthenticator, handle []byte, name string) AdminCredential {
	t.Helper()
	tt, ok := t.(*testing.T)
	if !ok {
		t.Fatal("newRealAdminCredential needs *testing.T")
	}
	rp, err := s.adminRP()
	if err != nil {
		t.Fatalf("rp: %v", err)
	}
	user := &adminPasskeyUser{handle: handle, name: s.adminUser()}
	_, sess, err := rp.BeginRegistration(user, adminRegistrationOpts(nil)...)
	if err != nil {
		t.Fatalf("begin registration: %v", err)
	}
	req, _ := http.NewRequest("POST", "/", strings.NewReader(
		auth.registerBody(tt, rp.Config.RPID, s.selfOrigin(), sess.Challenge)))
	req.Header.Set("Content-Type", "application/json")
	cred, err := rp.FinishRegistration(user, *sess, req)
	if err != nil {
		t.Fatalf("finish registration: %v", err)
	}
	blob, _ := json.Marshal(cred)
	return AdminCredential{ID: b64url(cred.ID), UserHandle: handle, CredJSON: blob, Name: name, CreatedAt: s.now().Unix()}
}

// adminTestPasskey returns svc's test passkey, registering it on first use.
func adminTestPasskey(t *testing.T, svc *Service) *adminTestKey {
	t.Helper()
	if k, ok := adminTestKeys.Load(svc); ok {
		return k.(*adminTestKey)
	}
	handle, ok, err := svc.store.AdminUserHandle(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		handle, _ = randomBytes(32)
	}
	k := &adminTestKey{handle: handle}
	if _, _, err := AdminRelyingParty(svc.cfg.BaseURL); err == nil {
		k.auth = newTestAuthenticator(t)
		c := newRealAdminCredential(t, svc, k.auth, handle, "test-key")
		seedAdminCredentialRow(t, svc.store, c)
		k.credID = c.ID
	} else {
		k.credID = "placeholder-" + randomTestID(t)
		blob, _ := json.Marshal(webauthn.Credential{ID: []byte(k.credID), PublicKey: []byte{1}})
		seedAdminCredentialRow(t, svc.store, AdminCredential{ID: k.credID, UserHandle: handle, CredJSON: blob,
			Name: "placeholder", CreatedAt: svc.now().Unix()})
	}
	adminTestKeys.Store(svc, k)
	t.Cleanup(func() { adminTestKeys.Delete(svc) })
	return k
}

func randomTestID(t *testing.T) string {
	b, err := randomBytes(8)
	if err != nil {
		t.Fatal(err)
	}
	return b64url(b)
}

// newTestAdminSession mints a passkey session on svc and returns its token.
func newTestAdminSession(t *testing.T, svc *Service) string {
	t.Helper()
	k := adminTestPasskey(t, svc)
	gen, err := svc.store.AdminAuthGeneration(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	tok, err := svc.newAdminSession(context.Background(), k.credID, gen)
	if err != nil {
		t.Fatalf("new admin session: %v", err)
	}
	return tok
}

// adminSessionCookie is newTestAdminSession as a request cookie.
func adminSessionCookie(t *testing.T, svc *Service) *http.Cookie {
	t.Helper()
	return &http.Cookie{Name: adminCookie, Value: newTestAdminSession(t, svc)}
}

// serveAdminForTest mounts svc's admin routes on a fresh test server and
// remembers which service backs it, so URL-only fixtures can find it.
func serveAdminForTest(t *testing.T, svc *Service, extra ...func(*http.ServeMux)) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	for _, f := range extra {
		f(mux)
	}
	ts := httptest.NewServer(mux)
	adminTestServers.Store(ts.URL, svc)
	t.Cleanup(func() {
		adminTestServers.Delete(ts.URL)
		ts.Close()
	})
	return ts
}

// adminCookieForServer returns a fresh admin session cookie for the service
// behind ts (which must have been started with serveAdminForTest).
func adminCookieForServer(t *testing.T, ts *httptest.Server) *http.Cookie {
	t.Helper()
	v, ok := adminTestServers.Load(ts.URL)
	if !ok {
		t.Fatalf("test server %s was not started with serveAdminForTest", ts.URL)
	}
	return adminSessionCookie(t, v.(*Service))
}

// passkeyStepUp performs a real step-up assertion for svc's test passkey on
// ts and returns the ceremony cookie plus the assertion JSON to submit as
// factor_assertion with the confirmation.
func passkeyStepUp(t *testing.T, ts *httptest.Server, svc *Service, session *http.Cookie) (*http.Cookie, string) {
	t.Helper()
	k := adminTestPasskey(t, svc)
	if k.auth == nil {
		t.Fatal("passkeyStepUp needs a service with a BaseURL (real test passkey)")
	}
	req, _ := http.NewRequest("POST", ts.URL+"/admin/stepup/passkey/begin", nil)
	req.Header.Set("Origin", svc.selfOrigin())
	req.AddCookie(session)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("stepup begin: status %d", resp.StatusCode)
	}
	var opts struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&opts); err != nil {
		t.Fatal(err)
	}
	var cer *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == passkeyCeremonyCookie {
			cer = c
		}
	}
	if cer == nil {
		t.Fatal("stepup begin set no ceremony cookie")
	}
	rp, _ := svc.adminRP()
	return cer, k.auth.assertBody(t, rp.Config.RPID, svc.selfOrigin(), opts.PublicKey.Challenge, k.handle)
}

// confirmWithPasskey submits a pending confirmation with a real passkey
// step-up and returns the response (redirects not followed).
func confirmWithPasskey(t *testing.T, ts *httptest.Server, svc *Service, session *http.Cookie, token string) *http.Response {
	t.Helper()
	return confirmFormWithPasskey(t, ts, svc, session, url.Values{"confirm_token": {token}})
}

// confirmFormWithPasskey submits form (which carries confirm_token and any
// extra fields) to /admin/confirm with a real passkey assertion added.
func confirmFormWithPasskey(t *testing.T, ts *httptest.Server, svc *Service, session *http.Cookie, form url.Values) *http.Response {
	t.Helper()
	cer, assertion := passkeyStepUp(t, ts, svc, session)
	form.Set("factor_assertion", assertion)
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/admin/confirm", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", svc.selfOrigin())
	req.AddCookie(session)
	req.AddCookie(cer)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

// confirmPasskeyOn is confirmWithPasskey for a server started with
// serveAdminForTest: the business-logic tests behind a confirmation page used
// to submit the admin password as the factor; they now present a real passkey
// assertion, the only factor there is.
func confirmPasskeyOn(t *testing.T, ts *httptest.Server, session *http.Cookie, token string) *http.Response {
	t.Helper()
	v, ok := adminTestServers.Load(ts.URL)
	if !ok {
		t.Fatalf("test server %s was not started with serveAdminForTest", ts.URL)
	}
	return confirmWithPasskey(t, ts, v.(*Service), session, token)
}

// confirmFormPasskeyOn is confirmFormWithPasskey for a serveAdminForTest server.
func confirmFormPasskeyOn(t *testing.T, ts *httptest.Server, session *http.Cookie, form url.Values) *http.Response {
	t.Helper()
	v, ok := adminTestServers.Load(ts.URL)
	if !ok {
		t.Fatalf("test server %s was not started with serveAdminForTest", ts.URL)
	}
	return confirmFormWithPasskey(t, ts, v.(*Service), session, form)
}

// passkeyLoginHTTP performs a real passkey login for svc's test passkey over
// HTTP and returns the response of the finish call (body unread).
func passkeyLoginHTTP(t *testing.T, ts *httptest.Server, svc *Service, sign func(challenge string) string) *http.Response {
	t.Helper()
	breq, _ := http.NewRequest("POST", ts.URL+"/admin/passkey/login/begin", nil)
	breq.Header.Set("Origin", svc.selfOrigin())
	bresp, err := ts.Client().Do(breq)
	if err != nil {
		t.Fatal(err)
	}
	var opts struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	_ = json.NewDecoder(bresp.Body).Decode(&opts)
	bresp.Body.Close()
	if bresp.StatusCode != http.StatusOK {
		t.Fatalf("login begin: status %d", bresp.StatusCode)
	}
	if sign == nil {
		k := adminTestPasskey(t, svc)
		rp, _ := svc.adminRP()
		sign = func(c string) string { return k.auth.assertBody(t, rp.Config.RPID, svc.selfOrigin(), c, k.handle) }
	}
	freq, _ := http.NewRequest("POST", ts.URL+"/admin/passkey/login/finish", strings.NewReader(sign(opts.PublicKey.Challenge)))
	freq.Header.Set("Content-Type", "application/json")
	freq.Header.Set("Origin", svc.selfOrigin())
	for _, c := range bresp.Cookies() {
		freq.AddCookie(c)
	}
	resp, err := ts.Client().Do(freq)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

// registerBodyFlags is testAuthenticator.registerBody with explicit
// authenticator-data flags and origin, for adversarial enrollment cases
// (0x45 = UP|UV|AT is the honest value; 0x41 drops UV).
func (a *testAuthenticator) registerBodyFlags(t *testing.T, rpID, origin, challenge, typ string, flags byte) string {
	t.Helper()
	cd := a.clientData(typ, challenge, origin)
	ad := a.authData(t, rpID, flags, true)
	att := cborEnc(t, map[string]any{"fmt": "none", "attStmt": map[string]any{}, "authData": ad})
	body, _ := json.Marshal(map[string]any{
		"id": b64url(a.credID), "rawId": b64url(a.credID), "type": "public-key",
		"response": map[string]any{"clientDataJSON": b64url(cd), "attestationObject": b64url(att)},
	})
	return string(body)
}

// markStepUpForTest opens the grace window on tok under the CURRENT auth
// generation, as a just-verified passkey step-up would.
func markStepUpForTest(t *testing.T, svc *Service, tok string) {
	t.Helper()
	gen, err := svc.store.AdminAuthGeneration(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := svc.store.MarkAdminStepUp(context.Background(), tok, svc.now().Unix(), gen); err != nil || !ok {
		t.Fatalf("mark step-up: ok=%v err=%v", ok, err)
	}
}
