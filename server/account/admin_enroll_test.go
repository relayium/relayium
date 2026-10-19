package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Enrollment: terminal grant -> browser creates a PENDING credential -> the
// terminal approves the exact fingerprint. Real WebAuthn bodies from the
// software authenticator throughout.

type enrollRig struct {
	t      *testing.T
	ts     *httptest.Server
	svc    *Service
	st     *SQLiteStore
	clk    *time.Time
	auth   *testAuthenticator
	rpID   string
	origin string
}

func newEnrollRig(t *testing.T) *enrollRig {
	t.Helper()
	st := newTestStore(t)
	svc := NewService(st, nil, Config{BaseURL: "http://example.test", AdminUser: "admin", AdminEnabled: true})
	now := time.Unix(1_700_000_000, 0)
	clk := &now
	svc.now = func() time.Time { return *clk }
	origin, rpID, err := AdminRelyingParty("http://example.test")
	if err != nil {
		t.Fatal(err)
	}
	return &enrollRig{t: t, ts: serveAdminForTest(t, svc), svc: svc, st: st, clk: clk,
		auth: newTestAuthenticator(t), rpID: rpID, origin: origin}
}

func (r *enrollRig) start(name string) AdminEnrollmentGrant {
	r.t.Helper()
	g, err := r.st.AdminAuth().StartEnrollment(context.Background(), name, r.origin, r.rpID, 0, r.clk.Unix(), "cli:test")
	if err != nil {
		r.t.Fatal(err)
	}
	return g
}

func (r *enrollRig) post(path string, body any) (int, map[string]any) {
	r.t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", r.ts.URL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", r.origin)
	resp, err := r.ts.Client().Do(req)
	if err != nil {
		r.t.Fatal(err)
	}
	defer resp.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// begin returns the creation challenge (and the raw options for inspection).
func (r *enrollRig) begin(grant string) (int, string, map[string]any) {
	r.t.Helper()
	code, out := r.post("/admin/enroll/begin", map[string]string{"grant": grant})
	pk, _ := out["publicKey"].(map[string]any)
	ch, _ := pk["challenge"].(string)
	return code, ch, out
}

func (r *enrollRig) finish(grant, credentialJSON string) (int, map[string]any) {
	r.t.Helper()
	return r.post("/admin/enroll/finish", map[string]any{"grant": grant, "credential": json.RawMessage(credentialJSON)})
}

// enrollPending runs start/begin/finish honestly and returns the grant and the
// fingerprint the page would show.
func (r *enrollRig) enrollPending(name string) (AdminEnrollmentGrant, string) {
	r.t.Helper()
	g := r.start(name)
	code, ch, _ := r.begin(g.Grant)
	if code != http.StatusOK || ch == "" {
		r.t.Fatalf("begin: %d", code)
	}
	code, out := r.finish(g.Grant, r.auth.registerBody(r.t, r.rpID, r.origin, ch))
	if code != http.StatusOK {
		r.t.Fatalf("finish: %d %v", code, out)
	}
	fp, _ := out["fingerprint"].(string)
	if fp == "" || out["enrollment"] != g.ID {
		r.t.Fatalf("finish response: %v", out)
	}
	return g, fp
}

// loginWith attempts a real passkey login with auth.
func (r *enrollRig) loginWith(auth *testAuthenticator, handle []byte) int {
	r.t.Helper()
	resp := passkeyLoginHTTP(r.t, r.ts, r.svc, func(c string) string {
		return auth.assertBody(r.t, r.rpID, r.origin, c, handle)
	})
	resp.Body.Close()
	return resp.StatusCode
}

func TestEnrollmentPendingKeyCannotSignInUntilTerminalApproval(t *testing.T) {
	r := newEnrollRig(t)
	g, fp := r.enrollPending("MacBook")
	e, _, _ := r.st.AdminAuth().Enrollment(context.Background(), g.ID)
	if e.State != enrollPending {
		t.Fatalf("state = %s, want pending", e.State)
	}
	if n, _ := r.st.CountAdminCredentials(context.Background()); n != 0 {
		t.Fatalf("pending enrollment wrote %d active credentials", n)
	}
	if code := r.loginWith(r.auth, e.UserHandle); code != http.StatusUnauthorized {
		t.Fatalf("pending key login: %d, want 401", code)
	}

	// Wrong fingerprint: refused, nothing written, still pending.
	ctx := context.Background()
	if _, err := r.st.AdminAuth().ApproveEnrollment(ctx, g.ID, "0000-0000-0000-0000-0000", r.origin, r.rpID, r.clk.Unix(), "cli:test"); !errors.Is(err, ErrAdminEnrollmentFP) {
		t.Fatalf("wrong fingerprint: %v", err)
	}
	// Wrong binding: refused.
	if _, err := r.st.AdminAuth().ApproveEnrollment(ctx, g.ID, fp, "https://other.example", "other.example", r.clk.Unix(), "cli:test"); !errors.Is(err, ErrAdminEnrollmentBinding) {
		t.Fatalf("wrong base URL: %v", err)
	}
	if n, _ := r.st.CountAdminCredentials(ctx); n != 0 {
		t.Fatal("a refused approval wrote a credential")
	}
	// Exact fingerprint (case/dash-insensitive) approves.
	c, err := r.st.AdminAuth().ApproveEnrollment(ctx, g.ID, strings.ToLower(strings.ReplaceAll(fp, "-", "")), r.origin, r.rpID, r.clk.Unix(), "cli:test")
	if err != nil {
		t.Fatal(err)
	}
	if AdminCredentialFingerprint(c) != fp {
		t.Fatalf("approved credential fingerprint %s != shown %s", AdminCredentialFingerprint(c), fp)
	}
	if code := r.loginWith(r.auth, e.UserHandle); code != http.StatusOK {
		t.Fatalf("approved key login: %d, want 200", code)
	}
	// Repeated approval fails.
	if _, err := r.st.AdminAuth().ApproveEnrollment(ctx, g.ID, fp, r.origin, r.rpID, r.clk.Unix(), "cli:test"); !errors.Is(err, ErrAdminEnrollmentState) {
		t.Fatalf("repeated approval: %v", err)
	}
	// The audit trail names the approval, with no grant in it.
	entries, _ := r.st.ListAudit(ctx, 50, 0, "")
	var sawStart, sawFinish, sawApprove bool
	for _, en := range entries {
		blob := en.Actor + en.Target + en.Changes + en.IP + en.Auth
		if strings.Contains(blob, g.Grant) {
			t.Fatalf("grant leaked into audit row %+v", en)
		}
		switch en.Action {
		case AuditPasskeyEnrollStart:
			sawStart = true
		case AuditPasskeyEnrollFinish:
			sawFinish = true
		case AuditPasskeyEnrollApprove:
			sawApprove = en.Auth == "cli" && en.IP == "local"
		}
	}
	if !sawStart || !sawFinish || !sawApprove {
		t.Fatalf("audit start/finish/approve = %v/%v/%v", sawStart, sawFinish, sawApprove)
	}
}

func TestEnrollmentGrantIsSingleUse(t *testing.T) {
	r := newEnrollRig(t)
	g, _ := r.enrollPending("one")
	if code, _, _ := r.begin(g.Grant); code != http.StatusBadRequest {
		t.Fatalf("begin after finish: %d", code)
	}
	other := newTestAuthenticator(t)
	if code, _ := r.finish(g.Grant, other.registerBody(t, r.rpID, r.origin, "AAAA")); code != http.StatusBadRequest {
		t.Fatalf("second finish: %d", code)
	}
	if code, _, _ := r.begin("not-a-grant"); code != http.StatusBadRequest {
		t.Fatalf("unknown grant: %d", code)
	}
}

func TestEnrollmentExpiryAndChallengeExpiry(t *testing.T) {
	r := newEnrollRig(t)
	// Challenge expiry: a creation challenge older than 5 minutes is dead and
	// the attempt burns it.
	g := r.start("slow")
	_, ch, _ := r.begin(g.Grant)
	*r.clk = r.clk.Add(adminEnrollChallengeTTL + time.Second)
	if code, _ := r.finish(g.Grant, r.auth.registerBody(t, r.rpID, r.origin, ch)); code != http.StatusBadRequest {
		t.Fatalf("finish with expired challenge: %d", code)
	}
	// Grant expiry: begin refused once the grant is past its TTL.
	*r.clk = r.clk.Add(adminEnrollmentDefaultTTL)
	if code, _, _ := r.begin(g.Grant); code != http.StatusBadRequest {
		t.Fatalf("begin with expired grant: %d", code)
	}
	// A pending credential that waits past expiry cannot be approved.
	g2, fp := r.enrollPending("late-approval")
	*r.clk = r.clk.Add(adminEnrollmentDefaultTTL + time.Second)
	if _, err := r.st.AdminAuth().ApproveEnrollment(context.Background(), g2.ID, fp, r.origin, r.rpID, r.clk.Unix(), "cli:test"); !errors.Is(err, ErrAdminEnrollmentExpired) {
		t.Fatalf("approve after expiry: %v", err)
	}
}

func TestEnrollmentRejectsCrossKindForeignOriginAndNoUV(t *testing.T) {
	r := newEnrollRig(t)
	// A login challenge (minted unauthenticated) cannot be spent at enrollment.
	breq, _ := http.NewRequest("POST", r.ts.URL+"/admin/passkey/login/begin", nil)
	breq.Header.Set("Origin", r.origin)
	bresp, _ := r.ts.Client().Do(breq)
	var lo struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	_ = json.NewDecoder(bresp.Body).Decode(&lo)
	bresp.Body.Close()

	cases := map[string]func(ch string) string{
		"login challenge": func(string) string { return r.auth.registerBody(t, r.rpID, r.origin, lo.PublicKey.Challenge) },
		"foreign origin": func(ch string) string {
			return r.auth.registerBodyFlags(t, r.rpID, "https://evil.example", ch, "webauthn.create", 0x45)
		},
		"wrong rp id": func(ch string) string {
			return r.auth.registerBodyFlags(t, "evil.example", r.origin, ch, "webauthn.create", 0x45)
		},
		"assertion type": func(ch string) string { return r.auth.registerBodyFlags(t, r.rpID, r.origin, ch, "webauthn.get", 0x45) },
		"no user verification": func(ch string) string {
			return r.auth.registerBodyFlags(t, r.rpID, r.origin, ch, "webauthn.create", 0x41)
		},
	}
	for name, body := range cases {
		g := r.start(name)
		code, ch, _ := r.begin(g.Grant)
		if code != http.StatusOK {
			t.Fatalf("%s: begin %d", name, code)
		}
		if code, out := r.finish(g.Grant, body(ch)); code != http.StatusBadRequest {
			t.Fatalf("%s: finish %d %v, want 400", name, code, out)
		}
		e, _, _ := r.st.AdminAuth().Enrollment(context.Background(), g.ID)
		if e.State != enrollIssued || e.Challenge != "" || e.CredID != "" {
			t.Fatalf("%s: failed finish left state=%s challenge=%v cred=%q", name, e.State, e.Challenge != "", e.CredID)
		}
	}
	if n, _ := r.st.CountAdminCredentials(context.Background()); n != 0 {
		t.Fatal("an adversarial enrollment produced a credential")
	}
}

func TestEnrollmentRepeatedFailuresCancelTheGrant(t *testing.T) {
	r := newEnrollRig(t)
	g := r.start("bad")
	for i := 0; i < adminEnrollMaxFinishFailures; i++ {
		_, ch, _ := r.begin(g.Grant)
		r.finish(g.Grant, r.auth.registerBodyFlags(t, r.rpID, "https://evil.example", ch, "webauthn.create", 0x45))
		r.svc.adminLogins = newLoginThrottle(adminLoginMaxFails) // isolate from the per-IP bucket
	}
	e, _, _ := r.st.AdminAuth().Enrollment(context.Background(), g.ID)
	if e.State != enrollCancelled {
		t.Fatalf("after %d bad finishes state = %s, want cancelled", adminEnrollMaxFinishFailures, e.State)
	}
}

func TestEnrollmentBoundToIssuingSite(t *testing.T) {
	r := newEnrollRig(t)
	g, err := r.st.AdminAuth().StartEnrollment(context.Background(), "staging", "https://staging.example", "staging.example", 0, r.clk.Unix(), "cli:test")
	if err != nil {
		t.Fatal(err)
	}
	if code, _, _ := r.begin(g.Grant); code != http.StatusConflict {
		t.Fatalf("grant for another site: begin %d, want 409", code)
	}
}

func TestEnrollmentExcludesExistingCredentialsAndKeepsHandle(t *testing.T) {
	r := newEnrollRig(t)
	k := adminTestPasskey(t, r.svc)
	g := r.start("second")
	e, _, _ := r.st.AdminAuth().Enrollment(context.Background(), g.ID)
	if !bytes.Equal(e.UserHandle, k.handle) {
		t.Fatal("a new enrollment did not reuse the stable admin user handle")
	}
	_, _, out := r.begin(g.Grant)
	pk, _ := out["publicKey"].(map[string]any)
	excl, _ := pk["excludeCredentials"].([]any)
	found := false
	for _, x := range excl {
		if m, _ := x.(map[string]any); m["id"] == k.credID {
			found = true
		}
	}
	if !found {
		t.Fatalf("excludeCredentials %v lacks the registered key", excl)
	}
	sel, _ := pk["authenticatorSelection"].(map[string]any)
	if sel["userVerification"] != "required" || sel["residentKey"] != "required" {
		t.Fatalf("authenticatorSelection = %v", sel)
	}
}

func TestRevokeAllCancelsOpenEnrollments(t *testing.T) {
	r := newEnrollRig(t)
	issued := r.start("issued")
	pending, fp := r.enrollPending("pending")
	res, err := r.st.AdminAuth().RevokeAllSessions(context.Background(), r.clk.Unix(), "cli:test")
	if err != nil || res.Enrollments != 2 {
		t.Fatalf("revoke-all: %+v %v", res, err)
	}
	if code, _, _ := r.begin(issued.Grant); code != http.StatusBadRequest {
		t.Fatalf("begin on a cancelled grant: %d", code)
	}
	if _, err := r.st.AdminAuth().ApproveEnrollment(context.Background(), pending.ID, fp, r.origin, r.rpID, r.clk.Unix(), "cli:test"); !errors.Is(err, ErrAdminEnrollmentState) {
		t.Fatalf("approve after revoke-all: %v", err)
	}
}

func TestApproveRefusesForeignUserHandle(t *testing.T) {
	r := newEnrollRig(t)
	g, fp := r.enrollPending("first") // minted a fresh handle: no keys yet
	// Meanwhile a different key with a different handle got registered.
	seedAdminCredentialRow(t, r.st, AdminCredential{ID: "other", UserHandle: []byte("another-handle"), CredJSON: []byte("{}"), Name: "x"})
	if _, err := r.st.AdminAuth().ApproveEnrollment(context.Background(), g.ID, fp, r.origin, r.rpID, r.clk.Unix(), "cli:test"); !errors.Is(err, ErrAdminEnrollmentHandle) {
		t.Fatalf("approve with mismatched handle: %v", err)
	}
}

func TestEnrollPageIsNoStoreNoReferrerAndBodyBounded(t *testing.T) {
	r := newEnrollRig(t)
	resp, err := r.ts.Client().Get(r.ts.URL + "/admin/enroll")
	if err != nil {
		t.Fatal(err)
	}
	body := readAll(t, resp)
	resp.Body.Close()
	if resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("enroll page headers: %v", resp.Header)
	}
	if !strings.Contains(body, "location.hash") || !strings.Contains(body, "history.replaceState") {
		t.Fatal("enroll page does not read and strip the fragment grant")
	}
	big := strings.Repeat("x", adminEnrollBodyMax+1)
	req, _ := http.NewRequest("POST", r.ts.URL+"/admin/enroll/begin", strings.NewReader(`{"grant":"`+big+`"}`))
	req.Header.Set("Origin", r.origin)
	resp, _ = r.ts.Client().Do(req)
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body: %d", resp.StatusCode)
	}
	// Origin is required (fetch-only endpoint).
	req, _ = http.NewRequest("POST", r.ts.URL+"/admin/enroll/begin", strings.NewReader(`{"grant":"x"}`))
	resp, _ = r.ts.Client().Do(req)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("no Origin: %d", resp.StatusCode)
	}
}

// The grant never reaches the server log, even on failure paths.
func TestEnrollmentNeverLogsTheGrant(t *testing.T) {
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prev)
	r := newEnrollRig(t)
	g, _ := r.enrollPending("logged?")
	r.begin(g.Grant)
	r.finish(g.Grant, "{}")
	g2 := r.start("x")
	r.finish(g2.Grant, "{not json")
	if strings.Contains(buf.String(), g.Grant) || strings.Contains(buf.String(), g2.Grant) {
		t.Fatal("an enrollment grant appeared in the server log")
	}
}

// Two terminals approving the same pending credential at once (two separate
// database handles on one file, as two CLI processes would be): exactly one
// wins, exactly one credential row results.
func TestConcurrentApprovalIsExactlyOnce(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "relayium.db")
	st, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	svc := NewService(st, nil, Config{BaseURL: "http://example.test", AdminUser: "admin", AdminEnabled: true})
	ts := serveAdminForTest(t, svc)
	r := &enrollRig{t: t, ts: ts, svc: svc, st: st, auth: newTestAuthenticator(t), rpID: "example.test", origin: "http://example.test"}
	now := time.Now()
	r.clk = &now
	g, fp := r.enrollPending("race")

	const n = 4
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		a, err := OpenAdminAuthStore(path)
		if err != nil {
			t.Fatal(err)
		}
		defer a.Close()
		wg.Add(1)
		go func(i int, a *AdminAuthStore) {
			defer wg.Done()
			_, errs[i] = a.ApproveEnrollment(context.Background(), g.ID, fp, r.origin, r.rpID, time.Now().Unix(), "cli:test")
		}(i, a)
	}
	wg.Wait()
	wins := 0
	for _, e := range errs {
		if e == nil {
			wins++
		} else if !errors.Is(e, ErrAdminEnrollmentState) {
			t.Fatalf("losing approval failed for an unexpected reason: %v", e)
		}
	}
	if c, _ := st.CountAdminCredentials(context.Background()); wins != 1 || c != 1 {
		t.Fatalf("concurrent approvals: %d wins, %d credentials", wins, c)
	}
}

func TestOpenAdminAuthStoreRefusesMissingOrUninitialisedDatabase(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "nope.db")
	if _, err := OpenAdminAuthStore(missing); err == nil {
		t.Fatal("opened a database that does not exist")
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatal("OpenAdminAuthStore created a database file")
	}
	empty := filepath.Join(dir, "empty.db")
	if err := os.WriteFile(empty, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenAdminAuthStore(empty); err == nil {
		t.Fatal("opened a non-Relayium database")
	}
	for _, bad := range []string{"", ":memory:", "file:x.db", missing + "?mode=rw"} {
		if _, err := OpenAdminAuthStore(bad); err == nil {
			t.Fatalf("accepted DSN %q", bad)
		}
	}
}

// The local command's view touches only admin tables: opening it on a live
// server database leaves every customer row and the schema of every other
// table exactly as it was.
func TestOpenAdminAuthStoreTouchesOnlyAdminTables(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relayium.db")
	st, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpsertUserByEmail(context.Background(), "customer@example.com", "C"); err != nil {
		t.Fatal(err)
	}
	snapshot := func() string {
		var sb strings.Builder
		rows, err := st.db.Query(`SELECT type, name, COALESCE(sql,'') FROM sqlite_master WHERE name NOT LIKE 'admin_%' AND tbl_name NOT LIKE 'admin_%' ORDER BY name`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		for rows.Next() {
			var a, b, c string
			_ = rows.Scan(&a, &b, &c)
			sb.WriteString(a + b + c + "\n")
		}
		var users string
		_ = st.db.QueryRow(`SELECT group_concat(id || email || COALESCE(display_name,''), ',') FROM users`).Scan(&users)
		return sb.String() + users
	}
	before := snapshot()
	a, err := OpenAdminAuthStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.StartEnrollment(context.Background(), "k", "http://example.test", "example.test", 0, time.Now().Unix(), "cli:test"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.RevokeAllSessions(context.Background(), time.Now().Unix(), "cli:test"); err != nil {
		t.Fatal(err)
	}
	a.Close()
	if after := snapshot(); after != before {
		t.Fatalf("admin command changed non-admin schema or customer rows:\nbefore %s\nafter  %s", before, after)
	}
	st.Close()
}
