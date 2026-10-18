package account

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

// Controlled-interleaving regressions for the two revocation races found in
// review (R1, R2). No sleeps: a Store wrapper parks the login handler at the
// exact instant AFTER the WebAuthn assertion has been verified and its
// ceremony row consumed, and BEFORE the session is minted. The revocation runs
// while it is parked, then the handler is released.

type pausedSessionStore struct {
	Store
	reached, release chan struct{}
	once             sync.Once
}

func (p *pausedSessionStore) underlying() Store { return p.Store }

func (p *pausedSessionStore) CreateAdminSession(ctx context.Context, token, credentialID string, generation, now int64) error {
	// Only the first mint (the login under test) is parked; later mints in
	// the same test pass straight through.
	p.once.Do(func() {
		close(p.reached)
		<-p.release
	})
	return p.Store.CreateAdminSession(ctx, token, credentialID, generation, now)
}

type raceResult struct {
	status int
	cookie string
	err    error
}

// startPausedLogin begins a real passkey login against a paused store and
// returns once the handler is parked just before minting.
func startPausedLogin(t *testing.T) (svc *Service, st *SQLiteStore, p *pausedSessionStore, done chan raceResult) {
	t.Helper()
	st = newTestStore(t)
	p = &pausedSessionStore{Store: st, reached: make(chan struct{}), release: make(chan struct{})}
	svc = NewService(p, nil, Config{BaseURL: "http://example.test", AdminUser: "admin", AdminEnabled: true})
	ts := serveAdminForTest(t, svc)
	k := adminTestPasskey(t, svc)
	rp, _ := svc.adminRP()

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
	if err := json.NewDecoder(bresp.Body).Decode(&opts); err != nil {
		t.Fatal(err)
	}
	bresp.Body.Close()
	freq, _ := http.NewRequest("POST", ts.URL+"/admin/passkey/login/finish",
		strings.NewReader(k.auth.assertBody(t, rp.Config.RPID, svc.selfOrigin(), opts.PublicKey.Challenge, k.handle)))
	freq.Header.Set("Content-Type", "application/json")
	freq.Header.Set("Origin", svc.selfOrigin())
	for _, c := range bresp.Cookies() {
		freq.AddCookie(c)
	}
	done = make(chan raceResult, 1)
	go func() {
		resp, err := ts.Client().Do(freq)
		if err != nil {
			done <- raceResult{err: err}
			return
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, resp.Body)
		r := raceResult{status: resp.StatusCode}
		for _, c := range resp.Cookies() {
			if c.Name == adminCookie {
				r.cookie = c.Value
			}
		}
		done <- r
	}()
	select {
	case <-p.reached:
	case r := <-done:
		t.Fatalf("login did not reach the session mint (status %d, err %v)", r.status, r.err)
	case <-time.After(15 * time.Second):
		t.Fatal("login never reached the session mint")
	}
	// At this point the assertion is verified and the ceremony row is gone.
	if n := adminRowCount(t, st, "admin_passkey_ceremonies"); n != 0 {
		t.Fatalf("ceremony not yet consumed at the pause point (%d rows)", n)
	}
	return svc, st, p, done
}

func adminRowCount(t *testing.T, st *SQLiteStore, table string) int {
	t.Helper()
	var n int
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func finishPaused(t *testing.T, p *pausedSessionStore, done chan raceResult) raceResult {
	t.Helper()
	close(p.release)
	r := <-done
	if r.err != nil {
		t.Fatal(r.err)
	}
	return r
}

// Control: with nothing revoked, the paused login completes normally.
func TestLoginRaceControlCompletes(t *testing.T) {
	svc, _, p, done := startPausedLogin(t)
	r := finishPaused(t, p, done)
	if r.status != http.StatusOK || r.cookie == "" || !svc.validAdmin(context.Background(), r.cookie) {
		t.Fatalf("control login: status %d cookie=%v", r.status, r.cookie != "")
	}
}

// R2: revoke-all lands after the assertion was verified and its ceremony
// consumed, before the session is minted. The login must not produce a live
// session — deleting ceremony rows could not have stopped it; the generation
// fence does.
func TestLoginRaceRevokeAllAfterVerifiedAssertion(t *testing.T) {
	svc, st, p, done := startPausedLogin(t)
	if _, err := st.AdminAuth().RevokeAllSessions(context.Background(), svc.now().Unix(), "cli:test"); err != nil {
		t.Fatal(err)
	}
	r := finishPaused(t, p, done)
	if r.status != http.StatusUnauthorized || r.cookie != "" {
		t.Fatalf("login completing after revoke-all: status %d, cookie issued=%v", r.status, r.cookie != "")
	}
	if n := adminRowCount(t, st, "admin_sessions"); n != 0 {
		t.Fatalf("revoke-all race left %d session rows", n)
	}
	// The key itself was not revoked: a fresh login works.
	if !svc.validAdmin(context.Background(), newTestAdminSession(t, svc)) {
		t.Fatal("a fresh passkey login after revoke-all must still work")
	}
}

// R1: the credential is revoked while the login is parked. The mint is refused
// atomically (no orphan row at all), and re-adding the very same credential ID
// later cannot revive anything.
func TestLoginRaceRevokedCredentialLeavesNoOrphan(t *testing.T) {
	svc, st, p, done := startPausedLogin(t)
	k := adminTestPasskey(t, svc)
	row, ok, err := st.GetAdminCredential(context.Background(), k.credID)
	if err != nil || !ok {
		t.Fatal("setup: credential missing")
	}
	if _, err := st.AdminAuth().RevokeCredential(context.Background(), k.credID, true, svc.now().Unix(), "cli:test"); err != nil {
		t.Fatal(err)
	}
	r := finishPaused(t, p, done)
	if r.status != http.StatusUnauthorized || r.cookie != "" {
		t.Fatalf("login for a revoked key: status %d, cookie issued=%v", r.status, r.cookie != "")
	}
	if n := adminRowCount(t, st, "admin_sessions"); n != 0 {
		t.Fatalf("revoked-key race left %d (orphan) session rows", n)
	}
	seedAdminCredentialRow(t, st, row) // the same ID comes back
	if n := adminRowCount(t, st, "admin_sessions"); n != 0 {
		t.Fatal("re-adding the credential created a session")
	}
}

// Revoking a DIFFERENT passkey also fences in-flight ceremonies (one global
// generation, deliberately conservative): the parked login fails and simply
// has to be retried; it never yields a session minted across a revocation.
func TestLoginRaceAnyRevocationFencesInFlightLogins(t *testing.T) {
	svc, st, p, done := startPausedLogin(t)
	other := newRealAdminCredential(t, svc, newTestAuthenticator(t), adminTestPasskey(t, svc).handle, "other")
	seedAdminCredentialRow(t, st, other)
	if _, err := st.AdminAuth().RevokeCredential(context.Background(), other.ID, false, svc.now().Unix(), "cli:test"); err != nil {
		t.Fatal(err)
	}
	if r := finishPaused(t, p, done); r.status != http.StatusUnauthorized || r.cookie != "" {
		t.Fatalf("login across an unrelated revocation: status %d", r.status)
	}
}

// Old-bug witness + fix at the store layer, without HTTP. The witness shows
// why an orphan row is dangerous (it revives when the ID comes back); the fix
// shows CreateAdminSession never writes one.
func TestCreateAdminSessionRefusesRevokedCredentialAndStaleGeneration(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	const now = int64(1_700_000_000)
	c := AdminCredential{ID: "cred-x", UserHandle: []byte("h"), CredJSON: []byte("{}"), Name: "x", CreatedAt: now}

	// Witness: the pre-fix behaviour (an unconditional INSERT for an absent
	// credential) is dead while the key is absent and LIVE again once re-added.
	if _, err := st.db.Exec(`INSERT INTO admin_sessions (token, auth, cred_fp, expires, last_step_up_at, created_at, last_seen_at, credential_id)
		VALUES (?, 'passkey', '', ?, 0, ?, ?, 'cred-x')`, authx.HashToken("orphan"), now+3600, now, now); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := st.AdminSession(ctx, "orphan", now); ok {
		t.Fatal("witness: orphan valid while key absent")
	}
	seedAdminCredentialRow(t, st, c)
	if _, ok, _ := st.AdminSession(ctx, "orphan", now); !ok {
		t.Fatal("witness expected the old orphan row to revive — the test no longer witnesses the bug")
	}
	if _, err := st.db.Exec(`DELETE FROM admin_sessions`); err != nil {
		t.Fatal(err)
	}

	gen, _ := st.AdminAuthGeneration(ctx)
	// Fix 1: revoked (absent) credential -> refused, nothing written.
	if _, err := st.AdminAuth().RevokeCredential(ctx, "cred-x", true, now, "cli:test"); err != nil {
		t.Fatal(err)
	}
	gen2, _ := st.AdminAuthGeneration(ctx)
	if gen2 != gen+1 {
		t.Fatalf("revoking a credential must advance the fence: %d -> %d", gen, gen2)
	}
	if err := st.CreateAdminSession(ctx, "late", "cred-x", gen2, now); !errors.Is(err, ErrAdminSessionRefused) {
		t.Fatalf("mint for revoked credential: %v", err)
	}
	seedAdminCredentialRow(t, st, c)
	if _, ok, _ := st.AdminSession(ctx, "late", now); ok {
		t.Fatal("a refused mint became valid after the ID was re-added")
	}
	// Fix 2: stale generation -> refused; current -> accepted.
	if err := st.CreateAdminSession(ctx, "stale", "cred-x", gen, now); !errors.Is(err, ErrAdminSessionRefused) {
		t.Fatalf("mint with a stale generation: %v", err)
	}
	for _, g := range []int64{-1, gen2 + 1} {
		if err := st.CreateAdminSession(ctx, "odd", "cred-x", g, now); !errors.Is(err, ErrAdminSessionRefused) {
			t.Fatalf("mint with generation %d: %v", g, err)
		}
	}
	if err := st.CreateAdminSession(ctx, "ok", "cred-x", gen2, now); err != nil {
		t.Fatalf("mint with current generation: %v", err)
	}
	if n := adminRowCount(t, st, "admin_sessions"); n != 1 {
		t.Fatalf("want exactly the one accepted session, got %d rows", n)
	}
}

// A ceremony row written by an older binary (no auth_generation column value)
// can never mint a session or confirm a step-up.
func TestPreFenceCeremonyFailsClosed(t *testing.T) {
	_, svc := newAdminServer(t, "admin", "on")
	st := svc.store.(*SQLiteStore)
	if _, err := st.db.Exec(`INSERT INTO admin_passkey_ceremonies (token, kind, session, name, expires) VALUES (?, 'login', '{}', '', ?)`,
		authx.HashToken("old-cer"), svc.now().Unix()+300); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "/admin/passkey/login/finish", nil)
	r.AddCookie(&http.Cookie{Name: passkeyCeremonyCookie, Value: "old-cer"})
	cer, ok := svc.takeCeremony(r)
	if !ok || cer.generation != -1 {
		t.Fatalf("pre-fence ceremony: ok=%v generation=%d, want -1", ok, cer.generation)
	}
	k := adminTestPasskey(t, svc)
	if _, err := svc.newAdminSession(context.Background(), k.credID, cer.generation); !errors.Is(err, ErrAdminSessionRefused) {
		t.Fatalf("pre-fence ceremony minted a session: %v", err)
	}
}

// Step-up fence: a step-up challenge issued before a revocation cannot
// confirm afterwards, even when the session survives (here an unrelated key
// is revoked). Control: the same flow with no revocation applies.
func TestStepUpChallengeIssuedBeforeRevocationIsRefused(t *testing.T) {
	for _, revoke := range []bool{false, true} {
		ts, svc, store, _ := newAdminAuditServer(t)
		cookie := adminLoginCookie(t, ts)
		other := newRealAdminCredential(t, svc, newTestAuthenticator(t), adminTestPasskey(t, svc).handle, "other")
		seedAdminCredentialRow(t, store, other)
		tok := pendingSettingsConfirm(t, ts, svc, cookie, "246")
		cer, assertion := passkeyStepUp(t, ts, svc, cookie)
		if revoke {
			if _, err := store.AdminAuth().RevokeCredential(context.Background(), other.ID, false, svc.now().Unix(), "cli:test"); err != nil {
				t.Fatal(err)
			}
			if !svc.validAdmin(context.Background(), cookie.Value) {
				t.Fatal("setup: the session's own key was not revoked, it must survive")
			}
		}
		form := url.Values{"confirm_token": {tok}, "factor_assertion": {assertion}}
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/admin/confirm", strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Origin", "http://example.test")
		req.AddCookie(cookie)
		req.AddCookie(cer)
		client := ts.Client()
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		applied := svc.ResolveSettings(t.Context()).DailyQuota == 246*1024*1024
		if revoke && (applied || resp.StatusCode != http.StatusUnauthorized) {
			t.Fatalf("step-up across a revocation: status %d applied=%v", resp.StatusCode, applied)
		}
		if !revoke && (!applied || resp.StatusCode != http.StatusFound) {
			t.Fatalf("control step-up: status %d applied=%v", resp.StatusCode, applied)
		}
	}
}

// After revoke-all, a pending confirmation is gone and the old cookie is dead;
// grace cannot apply anything either.
func TestPendingConfirmationFailsClosedAfterRevokeAll(t *testing.T) {
	ts, svc, store, _ := newAdminAuditServer(t)
	cookie := adminLoginCookie(t, ts)
	markStepUpForTest(t, svc, cookie.Value)
	tok := pendingSettingsConfirm(t, ts, svc, cookie, "135")
	before := svc.ResolveSettings(t.Context()).DailyQuota
	res, err := store.AdminAuth().RevokeAllSessions(context.Background(), svc.now().Unix(), "cli:test")
	if err != nil || res.Sessions == 0 || res.PendingActions == 0 {
		t.Fatalf("revoke-all: %+v %v", res, err)
	}
	resp := postAdminForm(t, ts, cookie, "/admin/confirm", url.Values{"confirm_token": {tok}})
	resp.Body.Close()
	if svc.ResolveSettings(t.Context()).DailyQuota != before || svc.validAdmin(context.Background(), cookie.Value) {
		t.Fatal("a confirmation or session survived revoke-all")
	}
}

// ---------------------------------------------------------------------------
// R3/R4: step-up with a DIFFERENT key than the one the session signed in with.
// Session A (signed in with key A) confirms a high-risk action with key B.

type pausedTouchStore struct {
	Store
	reached, release chan struct{}
	once             sync.Once
	before           func()
}

func (p *pausedTouchStore) underlying() Store { return p.Store }

// TouchAdminCredential is called by verifyStepUpPasskey AFTER the signature
// was verified and BEFORE it returns — the exact window of R3.
func (p *pausedTouchStore) TouchAdminCredential(ctx context.Context, id string, blob []byte, now int64) error {
	p.once.Do(func() {
		close(p.reached)
		<-p.release
	})
	return p.Store.TouchAdminCredential(ctx, id, blob, now)
}

type stepUpRig struct {
	ts      *httptest.Server
	svc     *Service
	st      *SQLiteStore
	session *http.Cookie
	keyB    *testAuthenticator
	credB   AdminCredential
	handle  []byte
}

func newStepUpRig(t *testing.T, wrap func(Store) Store) *stepUpRig {
	t.Helper()
	st := newTestStore(t)
	var store Store = st
	if wrap != nil {
		store = wrap(st)
	}
	svc := NewService(store, &capturingMailer{}, Config{BaseURL: "http://example.test", AdminUser: "admin", AdminEnabled: true})
	ts := serveAdminForTest(t, svc)
	a := adminTestPasskey(t, svc) // key A: the session's own
	keyB := newTestAuthenticator(t)
	credB := newRealAdminCredential(t, svc, keyB, a.handle, "key-B")
	seedAdminCredentialRow(t, st, credB)
	return &stepUpRig{ts: ts, svc: svc, st: st, session: adminSessionCookie(t, svc), keyB: keyB, credB: credB, handle: a.handle}
}

func (r *stepUpRig) fleetTokens(t *testing.T) int { return adminRowCount(t, r.st, "fleet_tokens") }

// pendingMint renders the high-risk token-mint confirmation and returns its token.
func (r *stepUpRig) pendingMint(t *testing.T) string {
	t.Helper()
	resp := postAdminForm(t, r.ts, r.session, "/admin/nodes/token", url.Values{"name": {"fixture"}})
	tok := extractConfirmToken(t, readAll(t, resp))
	resp.Body.Close()
	return tok
}

// confirmWithB starts a step-up, signs it with key B, and submits; returns a
// channel with the final status (the request may be parked by a wrapper).
func (r *stepUpRig) confirmWithB(t *testing.T, tok string) chan raceResult {
	t.Helper()
	req, _ := http.NewRequest("POST", r.ts.URL+"/admin/stepup/passkey/begin", nil)
	req.Header.Set("Origin", "http://example.test")
	req.AddCookie(r.session)
	resp, err := r.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var opts struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&opts); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	rp, _ := r.svc.adminRP()
	assertion := r.keyB.assertBody(t, rp.Config.RPID, "http://example.test", opts.PublicKey.Challenge, r.handle)
	form := url.Values{"confirm_token": {tok}, "factor_assertion": {assertion}}
	creq, _ := http.NewRequest("POST", r.ts.URL+"/admin/confirm", strings.NewReader(form.Encode()))
	creq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	creq.Header.Set("Origin", "http://example.test")
	creq.AddCookie(r.session)
	for _, c := range resp.Cookies() {
		creq.AddCookie(c)
	}
	done := make(chan raceResult, 1)
	go func() {
		client := r.ts.Client()
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
		cr, err := client.Do(creq)
		if err != nil {
			done <- raceResult{err: err}
			return
		}
		defer cr.Body.Close()
		_, _ = io.Copy(io.Discard, cr.Body)
		done <- raceResult{status: cr.StatusCode}
	}()
	return done
}

func (r *stepUpRig) revokeB(t *testing.T) {
	t.Helper()
	if _, err := r.st.AdminAuth().RevokeCredential(context.Background(), r.credB.ID, false, r.svc.now().Unix(), "cli:test"); err != nil {
		t.Fatal(err)
	}
}

// Control: an unrevoked B step-up applies exactly one token and opens grace.
func TestStepUpWithOtherKeyControlApplies(t *testing.T) {
	r := newStepUpRig(t, nil)
	res := <-r.confirmWithB(t, r.pendingMint(t))
	if res.err != nil || res.status != http.StatusOK || r.fleetTokens(t) != 1 {
		t.Fatalf("control: status %d tokens %d err %v", res.status, r.fleetTokens(t), res.err)
	}
	if !r.svc.stepUpFresh(context.Background(), r.session.Value) {
		t.Fatal("control: a successful step-up must open the grace window")
	}
}

// R3: B is revoked AFTER its assertion's signature was verified, BEFORE the
// verifier returned (paused in the credential write-back). Session A stays
// valid; the action must not be applied.
func TestStepUpRevokedKeyAfterCryptoVerificationIsRefused(t *testing.T) {
	var p *pausedTouchStore
	r := newStepUpRig(t, func(s Store) Store {
		p = &pausedTouchStore{Store: s, reached: make(chan struct{}), release: make(chan struct{})}
		return p
	})
	done := r.confirmWithB(t, r.pendingMint(t))
	select {
	case <-p.reached:
	case res := <-done:
		t.Fatalf("step-up never reached the post-verification write-back: %d %v", res.status, res.err)
	case <-time.After(15 * time.Second):
		t.Fatal("timeout")
	}
	r.revokeB(t)
	close(p.release)
	res := <-done
	if res.err != nil {
		t.Fatal(res.err)
	}
	if res.status != http.StatusUnauthorized || r.fleetTokens(t) != 0 {
		t.Fatalf("revoked-mid-verification step-up: status %d, tokens minted %d", res.status, r.fleetTokens(t))
	}
	if !r.svc.validAdmin(context.Background(), r.session.Value) {
		t.Fatal("session A must remain valid (only B was revoked)")
	}
	if r.svc.stepUpFresh(context.Background(), r.session.Value) {
		t.Fatal("a refused step-up left grace behind")
	}
}

// R4: after a successful B step-up, revoking B ends the cached grace: the next
// high-risk action without a factor is refused, though A's login lives on.
func TestRevokingStepUpKeyEndsGrace(t *testing.T) {
	r := newStepUpRig(t, nil)
	if res := <-r.confirmWithB(t, r.pendingMint(t)); res.status != http.StatusOK || r.fleetTokens(t) != 1 {
		t.Fatalf("setup step-up: %d", res.status)
	}
	tok := r.pendingMint(t)
	r.revokeB(t)
	resp := postAdminForm(t, r.ts, r.session, "/admin/confirm", url.Values{"confirm_token": {tok}})
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized || r.fleetTokens(t) != 1 {
		t.Fatalf("factorless confirm after revoking the step-up key: status %d, tokens %d", resp.StatusCode, r.fleetTokens(t))
	}
	if !r.svc.validAdmin(context.Background(), r.session.Value) {
		t.Fatal("session A should survive the revocation of key B")
	}
}

// Old-bug witness for R4 at the store layer: a grace mark carrying a stale
// generation is refused, so a step-up verified before a revocation cannot
// record grace after it.
func TestStaleGenerationCannotRecordGrace(t *testing.T) {
	r := newStepUpRig(t, nil)
	gen, _ := r.st.AdminAuthGeneration(context.Background())
	r.revokeB(t)
	if ok, err := r.st.MarkAdminStepUp(context.Background(), r.session.Value, r.svc.now().Unix(), gen); err != nil || ok {
		t.Fatalf("stale-generation grace mark: ok=%v err=%v", ok, err)
	}
	if r.svc.stepUpFresh(context.Background(), r.session.Value) {
		t.Fatal("stale grace recorded")
	}
	// And grace recorded under the current generation dies with the next revocation.
	markStepUpForTest(t, r.svc, r.session.Value)
	if !r.svc.stepUpFresh(context.Background(), r.session.Value) {
		t.Fatal("setup: fresh grace")
	}
	other := newRealAdminCredential(t, r.svc, newTestAuthenticator(t), r.handle, "C")
	seedAdminCredentialRow(t, r.st, other)
	if _, err := r.st.AdminAuth().RevokeCredential(context.Background(), other.ID, false, r.svc.now().Unix(), "cli:test"); err != nil {
		t.Fatal(err)
	}
	if r.svc.stepUpFresh(context.Background(), r.session.Value) {
		t.Fatal("grace survived a credential revocation")
	}
}

type pausedMarkStore struct {
	Store
	before func()
	once   sync.Once
}

func (p *pausedMarkStore) underlying() Store { return p.Store }

func (p *pausedMarkStore) MarkAdminStepUp(ctx context.Context, token string, at, generation int64) (bool, error) {
	p.once.Do(func() {
		if p.before != nil {
			p.before()
		}
	})
	return p.Store.MarkAdminStepUp(ctx, token, at, generation)
}

// A revocation that lands while the action is being applied (after the final
// authorization, before grace is recorded) cannot recreate stale grace. The
// action itself was authorized before the revocation and is ordered before it.
func TestRevocationBeforeGraceMarkLeavesNoGrace(t *testing.T) {
	var p *pausedMarkStore
	r := newStepUpRig(t, func(s Store) Store {
		p = &pausedMarkStore{Store: s}
		return p
	})
	p.before = func() { r.revokeB(t) }
	res := <-r.confirmWithB(t, r.pendingMint(t))
	if res.status != http.StatusOK || r.fleetTokens(t) != 1 {
		t.Fatalf("action authorized before the revocation: status %d tokens %d", res.status, r.fleetTokens(t))
	}
	if r.svc.stepUpFresh(context.Background(), r.session.Value) {
		t.Fatal("grace was recorded after the step-up key was revoked")
	}
	tok := r.pendingMint(t)
	resp := postAdminForm(t, r.ts, r.session, "/admin/confirm", url.Values{"confirm_token": {tok}})
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized || r.fleetTokens(t) != 1 {
		t.Fatalf("factorless confirm after the race: %d tokens %d", resp.StatusCode, r.fleetTokens(t))
	}
}
