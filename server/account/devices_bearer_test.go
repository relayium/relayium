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

// The device endpoints exist so a user can see and revoke every credential that
// can act as them. Until now only a browser session could reach them, which put
// the native app — whose whole credential IS one of the rows in that list —
// outside the one screen that can revoke it. These tests pin the bearer path,
// and pin the parts that must NOT move with it: POST stays session-only, a
// cookie caller is never "this device", and CSRF still guards cookie writes.

// deviceHarness mounts the production Routes()/middleware (not a bare handler),
// because auth and CSRF behaviour is exactly what is under test here.
type deviceHarness struct {
	ts    *httptest.Server
	svc   *Service
	store *SQLiteStore
}

func newDeviceHarness(t *testing.T) *deviceHarness {
	t.Helper()
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour,
		MagicTTL: 15 * time.Minute, EnableMagic: true,
	})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	return &deviceHarness{ts: ts, svc: svc, store: store}
}

// user creates an account and returns its id.
func (h *deviceHarness) user(t *testing.T, email string) string {
	t.Helper()
	u, err := h.store.UpsertUserByEmail(context.Background(), email, "Test")
	if err != nil {
		t.Fatalf("create user %s: %v", email, err)
	}
	return u.ID
}

// bearer mints a native-login-equivalent credential: a device row plus the CLI
// token bound to it, which is exactly what finishNativeLogin does.
func (h *deviceHarness) bearer(t *testing.T, userID, deviceName string) string {
	t.Helper()
	tok, err := h.svc.issueBearer(context.Background(), userID, deviceName)
	if err != nil {
		t.Fatalf("issue bearer: %v", err)
	}
	return tok
}

// cookie signs the user in the way a browser does, so the cookie path under
// test is a real session rather than a hand-made value.
func (h *deviceHarness) cookie(t *testing.T, userID string) *http.Cookie {
	t.Helper()
	sess := Session{
		ID: authx.RandToken(), UserID: userID,
		CreatedAt: time.Now().Unix(), ExpiresAt: time.Now().Add(time.Hour).Unix(),
	}
	if err := h.store.CreateSession(context.Background(), sess); err != nil {
		t.Fatalf("create session: %v", err)
	}
	return &http.Cookie{Name: sessionCookie, Value: sess.ID}
}

// expiredCookie is a real session row that has simply run out, which is how a
// browser cookie stops authenticating in production. UserFromAuth then falls
// through to the Authorization header, and that fall-through is the behaviour
// the "current device" marker has to follow.
func (h *deviceHarness) expiredCookie(t *testing.T, userID string) *http.Cookie {
	t.Helper()
	sess := Session{
		ID: authx.RandToken(), UserID: userID,
		CreatedAt: time.Now().Add(-2 * time.Hour).Unix(),
		ExpiresAt: time.Now().Add(-time.Hour).Unix(),
	}
	if err := h.store.CreateSession(context.Background(), sess); err != nil {
		t.Fatalf("create expired session: %v", err)
	}
	return &http.Cookie{Name: sessionCookie, Value: sess.ID}
}

func (h *deviceHarness) do(t *testing.T, method, path string, mutate func(*http.Request)) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, h.ts.URL+path, nil)
	if err != nil {
		t.Fatalf("build %s %s: %v", method, path, err)
	}
	if mutate != nil {
		mutate(req)
	}
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// deviceRow mirrors what the web already reads (Go's default capitalized field
// names), plus the Current marker this change adds.
type deviceRow struct {
	ID         string
	UserID     string
	Name       string
	CreatedAt  int64
	LastSeenAt int64
	Kind       string
	LastIP     string
	Current    bool
}

func decodeDevices(t *testing.T, resp *http.Response) []deviceRow {
	t.Helper()
	var body struct {
		Devices []deviceRow `json:"devices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode devices: %v", err)
	}
	return body.Devices
}

func withBearer(token string) func(*http.Request) {
	return func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+token) }
}

func TestListDevicesAcceptsABearerAndMarksItsOwnDevice(t *testing.T) {
	h := newDeviceHarness(t)
	h.svc.SetClientIP(func(*http.Request) string { return "203.0.113.19" })
	uid := h.user(t, "bearer@example.com")
	token := h.bearer(t, uid, "Ada's Mac")
	// A second credential, so "current" has to identify one row rather than
	// being trivially true for the only device present.
	h.bearer(t, uid, "Other Mac")

	resp := h.do(t, "GET", "/api/devices", withBearer(token))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("bearer list: got %d, want 200", resp.StatusCode)
	}
	devices := decodeDevices(t, resp)
	if len(devices) != 2 {
		t.Fatalf("got %d devices, want 2", len(devices))
	}
	var current []string
	for _, d := range devices {
		if d.Current {
			current = append(current, d.Name)
		}
	}
	if len(current) != 1 || current[0] != "Ada's Mac" {
		t.Fatalf("current devices = %v, want exactly [Ada's Mac]", current)
	}
	for _, d := range devices {
		if d.Name == "Ada's Mac" && (d.LastIP != "203.0.113.19" || d.LastSeenAt == 0) {
			t.Fatalf("current CLI lacks its server-observed address/use time: %+v", d)
		}
	}
}

func TestListDevicesStillWorksForACookieAndMarksNothingCurrent(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "cookie@example.com")
	h.bearer(t, uid, "Ada's Mac")
	c := h.cookie(t, uid)

	resp := h.do(t, "GET", "/api/devices", func(r *http.Request) { r.AddCookie(c) })
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("cookie list: got %d, want 200", resp.StatusCode)
	}
	devices := decodeDevices(t, resp)
	if len(devices) != 1 {
		t.Fatalf("got %d devices, want 1", len(devices))
	}
	// A browser holds a session cookie, not a device-bound token: there is no
	// "this device" for it, and claiming one would offer the wrong revoke.
	if devices[0].Current {
		t.Fatal("a cookie caller must not have a current device")
	}
	if devices[0].Name != "Ada's Mac" {
		t.Fatalf("name = %q, want Ada's Mac", devices[0].Name)
	}
}

// The web reads d.ID/d.Name/d.Kind/d.LastSeenAt off this response today. Adding
// a field must not rename the ones it already reads.
func TestListDevicesKeepsTheFieldNamesTheWebAlreadyReads(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "shape@example.com")
	token := h.bearer(t, uid, "Ada's Mac")

	resp := h.do(t, "GET", "/api/devices", withBearer(token))
	var raw struct {
		Devices []map[string]any `json:"devices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(raw.Devices) != 1 {
		t.Fatalf("got %d devices, want 1", len(raw.Devices))
	}
	for _, key := range []string{"ID", "Name", "Kind", "CreatedAt", "LastSeenAt", "LastIP", "Current"} {
		if _, ok := raw.Devices[0][key]; !ok {
			t.Errorf("device response is missing %q", key)
		}
	}
}

func TestDeleteDeviceAcceptsABearerAndRevokesItsToken(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "revoke@example.com")
	token := h.bearer(t, uid, "Ada's Mac")

	devices := decodeDevices(t, h.do(t, "GET", "/api/devices", withBearer(token)))
	if len(devices) != 1 {
		t.Fatalf("got %d devices, want 1", len(devices))
	}

	resp := h.do(t, "DELETE", "/api/devices/"+devices[0].ID, withBearer(token))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("bearer delete: got %d, want 200", resp.StatusCode)
	}
	// Deleting the device the token is bound to cascades the token: the app
	// must not be able to keep acting with a credential the user just revoked.
	after := h.do(t, "GET", "/api/devices", withBearer(token))
	if after.StatusCode != http.StatusUnauthorized {
		t.Fatalf("after self-revoke: got %d, want 401", after.StatusCode)
	}
	// And logout on the dead token stays idempotent, which is what lets the app
	// sign out locally without inventing a special case.
	out := h.do(t, "POST", "/api/auth/logout", withBearer(token))
	if out.StatusCode != http.StatusOK && out.StatusCode != http.StatusUnauthorized {
		t.Fatalf("logout after self-revoke: got %d, want 200 or 401", out.StatusCode)
	}
}

func TestABearerCannotDeleteAnotherUsersDevice(t *testing.T) {
	h := newDeviceHarness(t)
	victim := h.user(t, "victim@example.com")
	attacker := h.user(t, "attacker@example.com")
	victimToken := h.bearer(t, victim, "Victim Mac")
	attackerToken := h.bearer(t, attacker, "Attacker Mac")

	victimDevices := decodeDevices(t, h.do(t, "GET", "/api/devices", withBearer(victimToken)))
	if len(victimDevices) != 1 {
		t.Fatalf("victim has %d devices, want 1", len(victimDevices))
	}
	target := victimDevices[0].ID

	resp := h.do(t, "DELETE", "/api/devices/"+target, withBearer(attackerToken))
	// The response deliberately does not distinguish "not yours" from "no such
	// device" — that is the existing no-existence-leak contract. What must hold
	// is that nothing was mutated.
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("cross-user delete: got %d, want the same 200 an unknown id gets", resp.StatusCode)
	}
	still := decodeDevices(t, h.do(t, "GET", "/api/devices", withBearer(victimToken)))
	if len(still) != 1 || still[0].ID != target {
		t.Fatalf("victim's device was mutated by another user: %+v", still)
	}
	// The victim's credential still works, so the token did not cascade either.
	if code := h.do(t, "GET", "/api/me", withBearer(victimToken)).StatusCode; code != http.StatusOK {
		t.Fatalf("victim token after cross-user delete: got %d, want 200", code)
	}
}

func TestABearerCannotRenameAnotherUsersDevice(t *testing.T) {
	h := newDeviceHarness(t)
	victim := h.user(t, "rvictim@example.com")
	attacker := h.user(t, "rattacker@example.com")
	victimToken := h.bearer(t, victim, "Victim Mac")
	attackerToken := h.bearer(t, attacker, "Attacker Mac")

	target := decodeDevices(t, h.do(t, "GET", "/api/devices", withBearer(victimToken)))[0].ID
	req, _ := http.NewRequest("PATCH", h.ts.URL+"/api/devices/"+target,
		strings.NewReader(`{"name":"pwned"}`))
	req.Header.Set("Authorization", "Bearer "+attackerToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatalf("patch: %v", err)
	}
	defer resp.Body.Close()

	still := decodeDevices(t, h.do(t, "GET", "/api/devices", withBearer(victimToken)))
	if still[0].Name != "Victim Mac" {
		t.Fatalf("device name = %q, want Victim Mac (another user renamed it)", still[0].Name)
	}
}

// Registering a device is what native login already did when it minted the
// bearer. Letting a bearer POST here would let one credential mint device rows
// for its own account with no session — extra surface for no gain.
func TestRegisterDeviceStaysSessionOnly(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "post@example.com")
	token := h.bearer(t, uid, "Ada's Mac")

	req, _ := http.NewRequest("POST", h.ts.URL+"/api/devices",
		strings.NewReader(`{"id":"devX","name":"Nope"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bearer POST /api/devices: got %d, want 401", resp.StatusCode)
	}

	// The cookie path is unchanged.
	c := h.cookie(t, uid)
	req, _ = http.NewRequest("POST", h.ts.URL+"/api/devices",
		strings.NewReader(`{"id":"devX","name":"Browser"}`))
	req.AddCookie(c)
	req.Header.Set("Content-Type", "application/json")
	resp, err = h.ts.Client().Do(req)
	if err != nil {
		t.Fatalf("post with cookie: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("cookie POST /api/devices: got %d, want 200", resp.StatusCode)
	}
}

// Widening auth must not widen CSRF: a cookie-authenticated DELETE carrying a
// foreign Origin is still refused before it reaches the handler.
func TestCrossOriginCookieDeleteIsStillRejected(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "csrf@example.com")
	token := h.bearer(t, uid, "Ada's Mac")
	target := decodeDevices(t, h.do(t, "GET", "/api/devices", withBearer(token)))[0].ID
	c := h.cookie(t, uid)

	resp := h.do(t, "DELETE", "/api/devices/"+target, func(r *http.Request) {
		r.AddCookie(c)
		r.Header.Set("Origin", "https://evil.example")
	})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin cookie delete: got %d, want 403", resp.StatusCode)
	}
	if still := decodeDevices(t, h.do(t, "GET", "/api/devices", withBearer(token))); len(still) != 1 {
		t.Fatalf("device count = %d, want 1 (the rejected request still mutated)", len(still))
	}
}

// The native app's own bearer, on a request a browser session also
// authenticated. UserFromAuth resolves the COOKIE, so the caller is the browser
// and the response contract says no row is current — even though the bearer is
// the same user's and its device really is in the list. Marking it would label
// a row on a session's list from a credential that request was not admitted
// under, and put "this Mac" next to a revoke the caller never asked for.
func TestAValidCookieBeatsASameUserBearerAndMarksNothingCurrent(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "both@example.com")
	token := h.bearer(t, uid, "Ada's Mac")

	devices := decodeDevices(t, h.do(t, "GET", "/api/devices", func(r *http.Request) {
		r.AddCookie(h.cookie(t, uid))
		r.Header.Set("Authorization", "Bearer "+token)
	}))
	if len(devices) != 1 || devices[0].Name != "Ada's Mac" {
		t.Fatalf("list = %+v, want the one device", devices)
	}
	if devices[0].Current {
		t.Fatal("a cookie-authenticated request marked a device current from a same-user bearer")
	}
}

// The other half of the same rule, and the reason it is a cookie-VALIDITY check
// rather than a cookie-PRESENCE one: an expired cookie authenticates nothing, so
// UserFromAuth falls through to the bearer and the caller really is that device.
// A stale cookie left in a native client's jar must not cost it the marker.
func TestAnExpiredCookieFallsThroughToTheBearerAndMarksItsDevice(t *testing.T) {
	h := newDeviceHarness(t)
	uid := h.user(t, "stale@example.com")
	token := h.bearer(t, uid, "Ada's Mac")
	h.bearer(t, uid, "Other Mac") // so "current" has to pick one row

	resp := h.do(t, "GET", "/api/devices", func(r *http.Request) {
		r.AddCookie(h.expiredCookie(t, uid))
		r.Header.Set("Authorization", "Bearer "+token)
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expired cookie + bearer: got %d, want 200", resp.StatusCode)
	}
	devices := decodeDevices(t, resp)
	var current []string
	for _, d := range devices {
		if d.Current {
			current = append(current, d.Name)
		}
	}
	if len(current) != 1 || current[0] != "Ada's Mac" {
		t.Fatalf("current devices = %v, want exactly [Ada's Mac]", current)
	}
}

// A request can carry a cookie for one account and a bearer for another;
// UserFromAuth resolves the cookie, so the list is the cookie owner's. The
// foreign bearer must contribute nothing to it — including the "this device"
// marker, which sits next to the most destructive button on the screen.
//
// (Device ids are unique per row, so a foreign id could not match one of these
// rows anyway. The userID comparison in bearerDeviceID is the guard that keeps
// that true if the listing ever changes; this test pins the observable half.)
func TestAForeignBearerAlongsideACookieMarksNothingCurrent(t *testing.T) {
	h := newDeviceHarness(t)
	owner := h.user(t, "owner@example.com")
	other := h.user(t, "other@example.com")
	h.bearer(t, owner, "Owner Mac")
	otherToken := h.bearer(t, other, "Other Mac")

	devices := decodeDevices(t, h.do(t, "GET", "/api/devices", func(r *http.Request) {
		r.AddCookie(h.cookie(t, owner))
		r.Header.Set("Authorization", "Bearer "+otherToken)
	}))
	if len(devices) != 1 || devices[0].Name != "Owner Mac" {
		t.Fatalf("list = %+v, want only the cookie owner's device", devices)
	}
	if devices[0].Current {
		t.Fatal("a device was marked current from another user's bearer")
	}
}
