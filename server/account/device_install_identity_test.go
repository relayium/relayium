package account

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/relayium/relayium/authx"
)

// The macOS app keeps one opaque installation identifier across logout and
// offers it as a LOOKUP HINT when it starts a device-code login. These tests
// are the adversarial half of that contract: the identifier must never be an
// authenticator, never cross an account boundary, never adopt a row it was not
// approved for, and never leave two live bearers on one device row.
//
// Every case drives the real HTTP surface (or the real store transaction) —
// the hint travels start → approve → poll exactly as a shipped client sends it.

// startDeviceFlow performs POST /api/cli/device/start with an optional
// install_id (empty = a client that sends no hint at all, i.e. every CLI and
// every pre-1.1.3 app) and returns (user_code, device_code).
func startDeviceFlow(t *testing.T, ts *httptest.Server, installID string) (string, string) {
	t.Helper()
	body := ""
	if installID != "" {
		body = `{"install_id":"` + installID + `"}`
	}
	out := doJSONMap(t, ts.Client(), ts.URL+"/api/cli/device/start", nil, body)
	user, _ := out["user_code"].(string)
	device, _ := out["device_code"].(string)
	if user == "" || device == "" {
		t.Fatalf("start did not mint a code (install_id=%q): %+v", installID, out)
	}
	return user, device
}

// approveDeviceFlow is the browser half: the signed-in session confirms the code.
func approveDeviceFlow(t *testing.T, ts *httptest.Server, cookie *http.Cookie, userCode string) {
	t.Helper()
	out := doJSONMap(t, ts.Client(), ts.URL+"/api/cli/device/approve", cookie,
		`{"user_code":"`+userCode+`"}`)
	if out["status"] != "ok" {
		t.Fatalf("approve failed: %+v", out)
	}
}

// pollDeviceFlow returns the status and (on success) the bearer token.
func pollDeviceFlow(t *testing.T, ts *httptest.Server, deviceCode string) (string, string) {
	t.Helper()
	out := doJSONMap(t, ts.Client(), ts.URL+"/api/cli/device/poll", nil,
		`{"device_code":"`+deviceCode+`"}`)
	status, _ := out["status"].(string)
	token, _ := out["access_token"].(string)
	return status, token
}

// signInWithInstallID runs the whole flow and returns the issued bearer.
func signInWithInstallID(t *testing.T, ts *httptest.Server, cookie *http.Cookie, installID string) string {
	t.Helper()
	userCode, deviceCode := startDeviceFlow(t, ts, installID)
	approveDeviceFlow(t, ts, cookie, userCode)
	status, token := pollDeviceFlow(t, ts, deviceCode)
	if status != "ok" || token == "" {
		t.Fatalf("poll after approval: status=%q token empty=%v", status, token == "")
	}
	return token
}

func userIDFor(t *testing.T, store *SQLiteStore, email string) string {
	t.Helper()
	u, err := store.UpsertUserByEmail(context.Background(), email, "")
	if err != nil {
		t.Fatalf("resolve user %s: %v", email, err)
	}
	return u.ID
}

func devicesOf(t *testing.T, store *SQLiteStore, userID string) []Device {
	t.Helper()
	ds, err := store.ListDevices(context.Background(), userID)
	if err != nil {
		t.Fatalf("list devices: %v", err)
	}
	return ds
}

// tokenResolves reports whether a raw bearer still authenticates.
func tokenResolves(t *testing.T, store *SQLiteStore, raw string) (string, bool) {
	t.Helper()
	_, deviceID, ok, err := store.GetCLITokenUser(context.Background(), authx.HashToken(raw))
	if err != nil {
		t.Fatalf("resolve token: %v", err)
	}
	return deviceID, ok
}

// ---------------------------------------------------------------------------
// 1. The product behaviour this batch exists for.
// ---------------------------------------------------------------------------

// Signing out and signing back in on the SAME Mac must land on the SAME device
// row — not a second one — and the old bearer must be dead the moment the new
// one exists. Before this batch every login minted authx.NewID(), so an owner
// who signed out twice had three rows for one machine.
func TestSameInstallationReusesItsDeviceRowAcrossLogoutAndLogin(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	cookie := loginCookie(t, ts, mail, "reuse@example.com")
	userID := userIDFor(t, store, "reuse@example.com")

	first := signInWithInstallID(t, ts, cookie, sampleInstallID)
	firstDevice, ok := tokenResolves(t, store, first)
	if !ok {
		t.Fatal("the first bearer does not authenticate")
	}

	// The app logs out (its bearer is revoked locally and server-side) and the
	// person signs in again from the same installation.
	second := signInWithInstallID(t, ts, cookie, sampleInstallID)
	secondDevice, ok := tokenResolves(t, store, second)
	if !ok {
		t.Fatal("the second bearer does not authenticate")
	}

	if devices := devicesOf(t, store, userID); len(devices) != 1 {
		t.Fatalf("one installation produced %d device rows: %+v", len(devices), devices)
	}
	if firstDevice != secondDevice {
		t.Fatalf("reauthentication moved to a new device row: %q -> %q", firstDevice, secondDevice)
	}
	if _, stillLive := tokenResolves(t, store, first); stillLive {
		t.Fatal("the replaced bearer still authenticates — rotation must be atomic and terminal")
	}
	if first == second {
		t.Fatal("reauthentication returned the same raw bearer")
	}
}

// A device row the owner has renamed keeps that name. Reuse must not overwrite
// account-visible state with whatever the login flow's fallback label is, or
// every re-login would silently rename the machine back to "CLI".
func TestReuseKeepsTheOwnersDeviceName(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	cookie := loginCookie(t, ts, mail, "rename@example.com")
	userID := userIDFor(t, store, "rename@example.com")

	signInWithInstallID(t, ts, cookie, sampleInstallID)
	device := devicesOf(t, store, userID)[0]
	if err := store.RenameDevice(context.Background(), device.ID, userID, "Lily's MacBook"); err != nil {
		t.Fatalf("rename: %v", err)
	}

	signInWithInstallID(t, ts, cookie, sampleInstallID)

	after := devicesOf(t, store, userID)
	if len(after) != 1 || after[0].Name != "Lily's MacBook" {
		t.Fatalf("reauthentication did not preserve the owner's name: %+v", after)
	}
}

// ---------------------------------------------------------------------------
// 2. The identifier is a hint, never a credential.
// ---------------------------------------------------------------------------

// Presenting a known installation identifier must not, on its own, produce a
// token. Only the approved flow does — that is the whole difference between a
// lookup hint and an authenticator.
func TestInstallIDAloneNeverReturnsATokenWithoutAFreshApproval(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	cookie := loginCookie(t, ts, mail, "hintonly@example.com")

	// A first, genuinely approved login, so the identifier is now bound to a
	// live device row with a live bearer.
	live := signInWithInstallID(t, ts, cookie, sampleInstallID)

	// A second flow that presents the same identifier and is NEVER approved.
	_, deviceCode := startDeviceFlow(t, ts, sampleInstallID)
	for i := 0; i < 3; i++ {
		status, token := pollDeviceFlow(t, ts, deviceCode)
		if status != "authorization_pending" {
			t.Fatalf("poll %d: an unapproved flow reported %q", i, status)
		}
		if token != "" {
			t.Fatal("an unapproved flow returned a token")
		}
	}
	// And it certainly must not have disturbed the live credential.
	if _, ok := tokenResolves(t, store, live); !ok {
		t.Fatal("an unapproved flow revoked the live bearer")
	}
}

// The same identifier under a DIFFERENT account is a different device. A row
// may never be found, reused, replaced or revealed across an account boundary.
func TestTheSameInstallIDUnderTwoAccountsStaysTwoDevices(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)

	aliceCookie := loginCookie(t, ts, mail, "alice-install@example.com")
	aliceToken := signInWithInstallID(t, ts, aliceCookie, sampleInstallID)
	aliceID := userIDFor(t, store, "alice-install@example.com")

	bobCookie := loginCookie(t, ts, mail, "bob-install@example.com")
	bobToken := signInWithInstallID(t, ts, bobCookie, sampleInstallID)
	bobID := userIDFor(t, store, "bob-install@example.com")

	aliceDevices := devicesOf(t, store, aliceID)
	bobDevices := devicesOf(t, store, bobID)
	if len(aliceDevices) != 1 || len(bobDevices) != 1 {
		t.Fatalf("expected one device each: alice=%+v bob=%+v", aliceDevices, bobDevices)
	}
	if aliceDevices[0].ID == bobDevices[0].ID {
		t.Fatal("two accounts share one device row")
	}
	aliceDevice, aliceLive := tokenResolves(t, store, aliceToken)
	if !aliceLive {
		t.Fatal("the second account's login revoked the first account's bearer")
	}
	bobDevice, bobLive := tokenResolves(t, store, bobToken)
	if !bobLive {
		t.Fatal("the second account's bearer does not authenticate")
	}
	if aliceDevice == bobDevice {
		t.Fatal("both bearers point at one device row")
	}
	// Re-authenticating as Bob must leave Alice's row and bearer untouched.
	signInWithInstallID(t, ts, bobCookie, sampleInstallID)
	if _, ok := tokenResolves(t, store, aliceToken); !ok {
		t.Fatal("a cross-account reauthentication revoked another account's bearer")
	}
}

// The identifier is a client-held lookup value. Nothing that returns device
// rows may echo it back: it is not a secret, but publishing it invites treating
// it as one, and no client needs to read another installation's hint.
func TestDeviceListNeverEchoesTheInstallationIdentifier(t *testing.T) {
	ts, _, mail := newUserNodesServer(t)
	cookie := loginCookie(t, ts, mail, "noecho@example.com")
	signInWithInstallID(t, ts, cookie, sampleInstallID)

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/devices", nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("list devices: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	body := string(raw)
	if strings.Contains(body, sampleInstallID) {
		t.Fatalf("the device list echoed the installation identifier: %s", body)
	}
	for _, key := range []string{"InstallID", "install_id", "InstallationID"} {
		if strings.Contains(body, key) {
			t.Fatalf("the device list exposes %q: %s", key, body)
		}
	}
}

// The approval page describes what is being authorized. It must not turn into
// a channel that leaks another installation's identifier to the browser.
func TestPendingApprovalDetailsNeverExposeTheIdentifier(t *testing.T) {
	ts, _, mail := newUserNodesServer(t)
	cookie := loginCookie(t, ts, mail, "pending@example.com")
	userCode, _ := startDeviceFlow(t, ts, sampleInstallID)

	req, _ := http.NewRequest(http.MethodGet,
		ts.URL+"/api/cli/device/pending?user_code="+userCode, nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if strings.Contains(string(raw), sampleInstallID) {
		t.Fatalf("the pending view exposed the installation identifier: %s", raw)
	}
}

// ---------------------------------------------------------------------------
// 3. Failing closed: unknown, malformed, legacy and revoked identities.
// ---------------------------------------------------------------------------

// A malformed identifier is not a reason to refuse a login — the person at the
// keyboard did nothing wrong — but it must never be stored or matched. It
// behaves exactly like a client that sent no hint at all: a fresh device row,
// every time.
func TestAMalformedIdentifierIsIgnoredRatherThanStoredOrMatched(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	cookie := loginCookie(t, ts, mail, "malformed@example.com")
	userID := userIDFor(t, store, "malformed@example.com")

	const bad = "not-a-canonical-identifier"
	signInWithInstallID(t, ts, cookie, bad)
	signInWithInstallID(t, ts, cookie, bad)

	devices := devicesOf(t, store, userID)
	if len(devices) != 2 {
		t.Fatalf("a malformed hint was matched: %d rows %+v", len(devices), devices)
	}
	for _, d := range devices {
		if d.InstallID != "" {
			t.Fatalf("a malformed hint was persisted: %q", d.InstallID)
		}
	}
}

// A device row registered before this batch has no identifier. It keeps
// working, and a later login carrying an identifier must NOT guess that the
// legacy row is the same machine — a guess would move a live bearer onto a row
// nobody approved it for.
func TestALegacyDeviceRowIsNeverAdoptedByAnIdentifier(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	cookie := loginCookie(t, ts, mail, "legacy@example.com")
	userID := userIDFor(t, store, "legacy@example.com")

	// Exactly what a pre-1.1.3 app or any CLI does: no hint at all.
	legacyToken := signInWithInstallID(t, ts, cookie, "")
	legacyDevice, ok := tokenResolves(t, store, legacyToken)
	if !ok {
		t.Fatal("the legacy bearer does not authenticate")
	}

	// The upgraded app now presents an identifier for the first time.
	upgradedToken := signInWithInstallID(t, ts, cookie, sampleInstallID)
	upgradedDevice, ok := tokenResolves(t, store, upgradedToken)
	if !ok {
		t.Fatal("the upgraded bearer does not authenticate")
	}

	if upgradedDevice == legacyDevice {
		t.Fatal("an identifier adopted a legacy row it was never approved for")
	}
	if _, live := tokenResolves(t, store, legacyToken); !live {
		t.Fatal("registering an identifier revoked the legacy bearer")
	}
	if devices := devicesOf(t, store, userID); len(devices) != 2 {
		t.Fatalf("expected the legacy row plus one new row, got %+v", devices)
	}
	// And from here on the identifier is stable.
	again := signInWithInstallID(t, ts, cookie, sampleInstallID)
	if d, _ := tokenResolves(t, store, again); d != upgradedDevice {
		t.Fatalf("the identifier did not stabilise: %q -> %q", upgradedDevice, d)
	}
}

// Revocation is terminal for the credential AND for the association. A stale
// identifier left on a machine the owner revoked must not resurrect that row,
// re-attach its Device Inbox history, or make the revoked bearer live again.
func TestRevocationIsTerminalAndAStaleIdentifierCannotResurrectTheRow(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	cookie := loginCookie(t, ts, mail, "revoked@example.com")
	userID := userIDFor(t, store, "revoked@example.com")

	revokedToken := signInWithInstallID(t, ts, cookie, sampleInstallID)
	revokedDevice, _ := tokenResolves(t, store, revokedToken)

	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/devices/"+revokedDevice, nil)
	req.AddCookie(cookie)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}
	resp.Body.Close()
	if _, live := tokenResolves(t, store, revokedToken); live {
		t.Fatal("revocation did not kill the bearer")
	}

	// The machine still holds the identifier and signs in again. That requires
	// a fresh human approval, and it produces a NEW row — never the old one.
	freshToken := signInWithInstallID(t, ts, cookie, sampleInstallID)
	freshDevice, ok := tokenResolves(t, store, freshToken)
	if !ok {
		t.Fatal("the post-revocation bearer does not authenticate")
	}
	if freshDevice == revokedDevice {
		t.Fatal("a stale identifier resurrected the revoked device row")
	}
	if _, live := tokenResolves(t, store, revokedToken); live {
		t.Fatal("the revoked bearer came back to life")
	}
	if devices := devicesOf(t, store, userID); len(devices) != 1 {
		t.Fatalf("expected exactly the new row after revocation: %+v", devices)
	}
}

// ---------------------------------------------------------------------------
// 4. Preservation: what reuse must NOT destroy.
// ---------------------------------------------------------------------------

// Reuse exists so a re-login does not orphan the machine's Device Inbox state.
// The enrolment, the whole registered-key history and the queued tasks all hang
// off the device id, so preserving the id is what preserves them — and this
// test says so directly rather than trusting the foreign keys.
func TestReauthenticationPreservesInboxEnrolmentKeysAndTasks(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	ctx := context.Background()
	cookie := loginCookie(t, ts, mail, "preserve@example.com")
	userID := userIDFor(t, store, "preserve@example.com")

	oldToken := signInWithInstallID(t, ts, cookie, sampleInstallID)
	deviceID, _ := tokenResolves(t, store, oldToken)

	if _, err := store.UpsertDeviceInbox(ctx, DeviceInbox{
		DeviceID: deviceID, UserID: userID, Platform: "darwin", AppVersion: "1.1.3",
		ProtocolVersion: 2, Capabilities: []string{"inbox.receive.v2"},
		ReceiveCapability: "inbox.receive.v2", AutoAccept: "ask",
		RegisteredAt: 100, UpdatedAt: 100,
	}); err != nil {
		t.Fatalf("enrol: %v", err)
	}
	first, err := store.RotateDeviceKey(ctx, DeviceKey{
		ID: "key-1", DeviceID: deviceID, UserID: userID, Algorithm: "x25519",
		PublicKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", Generation: 1, CreatedAt: 100,
	}, "")
	if err != nil {
		t.Fatalf("first key: %v", err)
	}
	if _, err := store.RotateDeviceKey(ctx, DeviceKey{
		ID: "key-2", DeviceID: deviceID, UserID: userID, Algorithm: "x25519",
		PublicKey: "HyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4", Generation: 2, CreatedAt: 200,
	}, first.ID); err != nil {
		t.Fatalf("rotate: %v", err)
	}
	// The queue references a live, unlimited-until-TTL Stored Object of this
	// account rather than duplicating ciphertext, so one has to exist.
	if err := store.CreateStoredFile(ctx, StoredFile{
		ID: "file-1", UserID: userID, BlobKey: "blob-1", EncManifest: []byte("opaque"),
		Size: 10, CreatedAt: 250, ExpiresAt: 1 << 40, Purpose: StoredPurposeDeviceTask,
	}); err != nil {
		t.Fatalf("stage ciphertext: %v", err)
	}
	task, _, err := store.CreateInboxTask(ctx, InboxTask{
		ID: "task-1", UserID: userID, TargetDeviceID: deviceID,
		IdempotencyKey: "idem-1", StoredFileID: "file-1", EncManifest: []byte("opaque"),
		WrapAlgorithm: "x25519-sealedbox", WrappedKey: "d3JhcHBlZA",
		TargetKeyID: "key-2", TargetKeyGeneration: 2, CiphertextBytes: 10,
		State: "queued", CreatedAt: 300, UpdatedAt: 300, ExpiresAt: 1 << 40,
	})
	if err != nil {
		t.Fatalf("queue task: %v", err)
	}

	newToken := signInWithInstallID(t, ts, cookie, sampleInstallID)
	newDevice, ok := tokenResolves(t, store, newToken)
	if !ok || newDevice != deviceID {
		t.Fatalf("reauthentication did not preserve the device id: %q -> %q (ok=%v)", deviceID, newDevice, ok)
	}
	if _, live := tokenResolves(t, store, oldToken); live {
		t.Fatal("the old bearer survived reauthentication")
	}

	inbox, found, err := store.GetDeviceInbox(ctx, deviceID, userID)
	if err != nil || !found {
		t.Fatalf("the Device Inbox enrolment did not survive: found=%v err=%v", found, err)
	}
	if inbox.AutoAccept != "ask" || inbox.ProtocolVersion != 2 {
		t.Fatalf("the enrolment was rewritten: %+v", inbox)
	}
	keys, err := store.ListDeviceKeys(ctx, deviceID, userID)
	if err != nil || len(keys) != 2 {
		t.Fatalf("the key history did not survive: %d keys, err=%v", len(keys), err)
	}
	active, hasActive, err := store.ActiveDeviceKey(ctx, deviceID, userID)
	if err != nil || !hasActive || active.ID != "key-2" {
		t.Fatalf("the active key changed: %+v hasActive=%v err=%v", active, hasActive, err)
	}
	got, found, err := store.GetInboxTask(ctx, task.ID, userID, 400)
	if err != nil || !found {
		t.Fatalf("the queued task did not survive: found=%v err=%v", found, err)
	}
	// Compared against the state the queue itself chose at creation (an `ask`
	// enrolment parks the task as attention_required), not a literal: the claim
	// is that reauthentication changed nothing, not that the task is in some
	// particular state.
	if got.TargetDeviceID != deviceID || got.State != task.State {
		t.Fatalf("the queued task was disturbed: want state %q on %q, got %+v",
			task.State, deviceID, got)
	}
}

// A revoked Device Inbox enrolment is terminal by design. Reauthenticating the
// same installation must not quietly clear that revocation — it is not a new
// device, and re-enrolment is the owner's explicit act.
func TestReauthenticationDoesNotClearARevokedInboxEnrolment(t *testing.T) {
	ts, store, mail := newUserNodesServer(t)
	ctx := context.Background()
	cookie := loginCookie(t, ts, mail, "revoked-inbox@example.com")
	userID := userIDFor(t, store, "revoked-inbox@example.com")

	token := signInWithInstallID(t, ts, cookie, sampleInstallID)
	deviceID, _ := tokenResolves(t, store, token)
	if _, err := store.UpsertDeviceInbox(ctx, DeviceInbox{
		DeviceID: deviceID, UserID: userID, Platform: "darwin", ProtocolVersion: 2,
		Capabilities: []string{"inbox.receive.v2"}, ReceiveCapability: "inbox.receive.v2",
		AutoAccept: "off", RegisteredAt: 100, UpdatedAt: 100,
	}); err != nil {
		t.Fatalf("enrol: %v", err)
	}
	key, err := store.RotateDeviceKey(ctx, DeviceKey{
		ID: "revoked-key", DeviceID: deviceID, UserID: userID, Algorithm: "x25519",
		PublicKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", Generation: 1, CreatedAt: 100,
	}, "")
	if err != nil {
		t.Fatalf("register key: %v", err)
	}
	if _, ok, err := store.RevokeDeviceKey(ctx, deviceID, userID, key.ID, 200); err != nil || !ok {
		t.Fatalf("revoke key: ok=%v err=%v", ok, err)
	}

	signInWithInstallID(t, ts, cookie, sampleInstallID)

	inbox, found, err := store.GetDeviceInbox(ctx, deviceID, userID)
	if err != nil || !found {
		t.Fatalf("enrolment vanished: found=%v err=%v", found, err)
	}
	if inbox.RevokedAt == 0 {
		t.Fatal("reauthentication cleared a revoked Device Inbox enrolment")
	}
}

// ---------------------------------------------------------------------------
// 5. Collision and concurrency.
// ---------------------------------------------------------------------------

// One account may never hold two rows carrying the same identifier: that is the
// state in which "which row is this machine" has no answer, and a later login
// would have to guess. The database refuses it outright rather than leaving the
// application as the only guardian.
func TestOneAccountCannotHoldTwoRowsWithTheSameIdentifier(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "collide@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpsertDevice(ctx, Device{
		ID: "device-a", UserID: u.ID, Name: "A", Kind: "app", CreatedAt: 1,
		InstallID: sampleInstallID,
	}); err != nil {
		t.Fatalf("first row: %v", err)
	}
	if _, err := store.UpsertDevice(ctx, Device{
		ID: "device-b", UserID: u.ID, Name: "B", Kind: "app", CreatedAt: 2,
		InstallID: sampleInstallID,
	}); err == nil {
		t.Fatal("a duplicate identifier was accepted within one account")
	}
	// Legacy rows all carry the empty identifier, so the constraint must be
	// partial: any number of them coexist.
	for _, id := range []string{"legacy-1", "legacy-2", "legacy-3"} {
		if _, err := store.UpsertDevice(ctx, Device{
			ID: id, UserID: u.ID, Name: id, Kind: "cli", CreatedAt: 3,
		}); err != nil {
			t.Fatalf("legacy row %s refused: %v", id, err)
		}
	}
}

// Two approvals of the same installation racing each other must converge on one
// device row with exactly ONE live bearer. Two rows would split the machine's
// identity; two live bearers would mean a logout that only half revokes.
func TestTwoConcurrentApprovalsConvergeOnOneRowAndOneLiveBearer(t *testing.T) {
	dsn := filepath.Join(t.TempDir(), "concurrent-approvals.sqlite")
	store, err := OpenSQLite(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	peer, err := OpenSQLite(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { peer.Close() })
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "race@example.com", "")
	if err != nil {
		t.Fatal(err)
	}

	const attempts = 6
	raws := make([]string, attempts)
	var wg sync.WaitGroup
	errs := make([]error, attempts)
	for i := 0; i < attempts; i++ {
		raws[i] = "rlm_cli_race_" + string(rune('a'+i))
		if err := store.CreateDeviceAuth(ctx, DeviceAuthRequest{
			UserCode:       "RACE-" + string(rune('A'+i)),
			DeviceCodeHash: authx.HashToken("race-code-" + string(rune('a'+i))),
			Status:         "pending", CreatedAt: 1, ExpiresAt: 1 << 40,
			DeviceName: "Mac", InstallID: sampleInstallID,
		}); err != nil {
			t.Fatal(err)
		}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			writer := store
			if i%2 == 1 {
				writer = peer
			}
			_, _, ok, approveErr := writer.ApproveAndRegisterDeviceAuth(
				ctx, "RACE-"+string(rune('A'+i)), u.ID, raws[i],
				"fresh-"+string(rune('a'+i)), int64(100+i))
			if approveErr != nil {
				errs[i] = approveErr
			} else if !ok {
				errs[i] = fmt.Errorf("approval %d was not accepted", i)
			}
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("concurrent approval %d failed: %v", i, err)
		}
	}

	devices, err := store.ListDevices(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(devices) != 1 {
		t.Fatalf("racing approvals produced %d device rows: %+v", len(devices), devices)
	}
	live := 0
	liveRaw := ""
	for _, raw := range raws {
		_, deviceID, ok, err := store.GetCLITokenUser(ctx, authx.HashToken(raw))
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			live++
			liveRaw = raw
			if deviceID != devices[0].ID {
				t.Fatalf("a live bearer points at %q, not the surviving row %q", deviceID, devices[0].ID)
			}
		}
	}
	if live != 1 {
		t.Fatalf("%d bearers are live after racing approvals; exactly one must be", live)
	}
	consumed := 0
	for i, raw := range raws {
		got, ok, err := store.ConsumeDeviceAuth(
			ctx, authx.HashToken("race-code-"+string(rune('a'+i))), 200)
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			consumed++
			if got != liveRaw || got != raw {
				t.Fatalf("poll handed out superseded bearer %q; live bearer is %q", got, liveRaw)
			}
		}
	}
	if consumed != 1 {
		t.Fatalf("%d racing approvals remained pollable; exactly one must be", consumed)
	}
}

// ApproveAndRegisterDeviceAuth reads the device row and then writes it, with no
// retry, because every read-write transaction on the write pool begins with
// BEGIN IMMEDIATE. That is a property of the DSN, not of the function, so it is
// pinned here: relaxing it would silently turn the safe read-then-write into an
// interleaving that the partial unique index can only refuse.
func TestTheWritePoolStillTakesItsWriteLockUpFront(t *testing.T) {
	source, err := os.ReadFile("sqlite.go")
	if err != nil {
		t.Fatalf("read sqlite.go: %v", err)
	}
	if !strings.Contains(string(source), `+"&_txlock=immediate"`) {
		t.Fatal("the write pool no longer begins transactions with BEGIN IMMEDIATE; " +
			"ApproveAndRegisterDeviceAuth's read-then-write depends on it")
	}
}

// ---------------------------------------------------------------------------
// 6. Migration of a database that predates the identifier.
// ---------------------------------------------------------------------------

// A live database upgrades in place: both columns appear with the empty
// default on every existing row, the partial unique index is created after
// them, and running the whole thing twice changes nothing.
func TestInstallIDMigrationUpgradesALegacyDatabaseIdempotently(t *testing.T) {
	db := rawMigDB(t)
	// The pre-1.1.3 shapes, reduced to what this migration touches.
	if _, err := db.Exec(`CREATE TABLE devices (
	  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
	  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL DEFAULT 0,
	  kind TEXT NOT NULL DEFAULT '', last_ip TEXT NOT NULL DEFAULT '')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE cli_device_auth (
	  user_code TEXT PRIMARY KEY, device_code_hash TEXT NOT NULL UNIQUE,
	  status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"old-1", "old-2"} {
		if _, err := db.Exec(
			`INSERT INTO devices (id, user_id, name, created_at) VALUES (?, 'u1', ?, 1)`,
			id, id); err != nil {
			t.Fatal(err)
		}
	}

	for pass := 1; pass <= 2; pass++ {
		if err := migrateInstallID(db); err != nil {
			t.Fatalf("migration pass %d: %v", pass, err)
		}
	}

	rows, err := db.Query(`SELECT id, install_id FROM devices ORDER BY id`)
	if err != nil {
		t.Fatalf("legacy rows are unreadable after migration: %v", err)
	}
	defer rows.Close()
	seen := 0
	for rows.Next() {
		var id, installID string
		if err := rows.Scan(&id, &installID); err != nil {
			t.Fatal(err)
		}
		if installID != "" {
			t.Fatalf("migration invented an identifier for %s: %q", id, installID)
		}
		seen++
	}
	if seen != 2 {
		t.Fatalf("migration lost rows: %d of 2 remain", seen)
	}
	if _, err := db.Exec(
		`INSERT INTO cli_device_auth (user_code, device_code_hash, status, created_at, expires_at, install_id)
		 VALUES ('AAAA-BBBB', 'h', 'pending', 1, 2, ?)`, sampleInstallID); err != nil {
		t.Fatalf("the request table did not gain the column: %v", err)
	}
	// The partial unique index is live on the migrated table.
	if _, err := db.Exec(
		`INSERT INTO devices (id, user_id, name, created_at, install_id) VALUES ('new-1', 'u1', 'n', 1, ?)`,
		sampleInstallID); err != nil {
		t.Fatalf("first identifier row refused: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO devices (id, user_id, name, created_at, install_id) VALUES ('new-2', 'u1', 'n', 1, ?)`,
		sampleInstallID); err == nil {
		t.Fatal("the migrated database accepted a duplicate identifier")
	}
}

// The start request carries the hint. A body that is absent (every CLI), empty,
// or carries an unknown field must still mint a code — this endpoint is the
// first call an unauthenticated client ever makes and cannot become stricter.
func TestDeviceStartStillAcceptsClientsThatSendNoIdentifier(t *testing.T) {
	ts, _, _ := newUserNodesServer(t)
	for _, body := range []string{"", "{}", `{"device_name":"laptop"}`} {
		out := doJSONMap(t, ts.Client(), ts.URL+"/api/cli/device/start", nil, body)
		if out["user_code"] == "" || out["device_code"] == "" {
			t.Fatalf("start refused body %q: %+v", body, out)
		}
	}
}

// The stored request keeps the identifier it was started with, and approval
// reads it in the same transaction as the pending→approved transition — so a
// second request cannot slip its own identifier between the read and the write
// and have the browser approve a row it never saw.
func TestApprovalBindsTheIdentifierTheRequestWasStartedWith(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	u, err := store.UpsertUserByEmail(ctx, "bound-install@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CreateDeviceAuth(ctx, DeviceAuthRequest{
		UserCode: "WDJB-MJHT", DeviceCodeHash: authx.HashToken("dev"), Status: "pending",
		CreatedAt: 1, ExpiresAt: 1 << 40, InstallID: sampleInstallID,
	}); err != nil {
		t.Fatal(err)
	}
	got, _, ok, err := store.ApproveAndRegisterDeviceAuth(ctx, "WDJB-MJHT", u.ID, "raw", "bound-device", 2)
	if err != nil || !ok {
		t.Fatalf("approve: ok=%v err=%v", ok, err)
	}
	if got.InstallID != sampleInstallID {
		t.Fatalf("approval lost the bound identifier: %q", got.InstallID)
	}
	stored, found, err := store.GetDeviceAuthByUserCode(ctx, "WDJB-MJHT")
	if err != nil || !found {
		t.Fatalf("read back: found=%v err=%v", found, err)
	}
	if stored.InstallID != sampleInstallID {
		t.Fatalf("the request did not retain its identifier: %q", stored.InstallID)
	}
}
