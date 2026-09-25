package account

// A password reset is how a person recovers a stolen device, and a password
// change is how they lock one out. Both used to revoke browser sessions only:
// every app and CLI bearer — a full account credential — survived them
// (OA-053 Q2, A29 N1). Now both revoke those bearers in the same transaction,
// keep browser sending identities (they authenticate nothing without a
// session), keep device rows, and refuse a bearer minted by a login or a
// device-code approval that raced the reset.

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
	"github.com/relayium/relayium/internal/inbox"
)

const failBearerRevoke = `CREATE TRIGGER inject_fault BEFORE DELETE ON cli_tokens BEGIN SELECT RAISE(ABORT, 'injected fault'); END`

// signedInEverywhere gives the victim an app bearer, a consumed CLI
// device-code bearer, an approved-but-unclaimed device-code login and a
// browser sending identity. It returns the raw app and CLI bearers, the
// unclaimed device code, and the browser identity's raw credential.
func signedInEverywhere(t *testing.T, svc *Service, u User, approving Session) (app, cli, unclaimedCode, browser string) {
	t.Helper()
	ctx := context.Background()
	st := sqliteOf(t, svc)
	now := svc.now().Unix()

	app, err := issueBearerNow(ctx, svc, u.ID, "Victim's iPhone")
	if err != nil {
		t.Fatal(err)
	}
	approve := func(userCode, deviceCode string) string {
		if err := st.CreateDeviceAuth(ctx, DeviceAuthRequest{
			UserCode: userCode, DeviceCodeHash: authx.HashToken(deviceCode), Status: "pending",
			CreatedAt: now, ExpiresAt: now + 600, DeviceName: "laptop",
		}); err != nil {
			t.Fatal(err)
		}
		raw := "rlm_cli_" + authx.RandToken()
		if _, _, ok, err := st.ApproveAndRegisterDeviceAuth(ctx, userCode, u.ID,
			authx.HashToken(approving.ID), raw, authx.NewID(), now); err != nil || !ok {
			t.Fatalf("approve %s: ok=%v err=%v", userCode, ok, err)
		}
		return raw
	}
	cli = approve("CLAI-MEDD", "claimed-device-code")
	if got, ok, err := st.ConsumeDeviceAuth(ctx, authx.HashToken("claimed-device-code"), now); err != nil || !ok || got != cli {
		t.Fatalf("claim: ok=%v err=%v", ok, err)
	}
	approve("UNCL-AIMD", "unclaimed-device-code")

	browser = "rlm_web_" + authx.RandToken()
	if _, err := st.RegisterBrowserDevice(ctx, BrowserDeviceRegistration{
		UserID: u.ID, DeviceID: authx.NewID(), TokenHash: authx.HashToken(browser),
		Name: "Web browser", At: now,
	}); err != nil {
		t.Fatal(err)
	}
	return app, cli, "unclaimed-device-code", browser
}

func bearerLive(t *testing.T, svc *Service, raw string) bool {
	t.Helper()
	_, _, ok, err := svc.store.GetCLITokenUser(context.Background(), authx.HashToken(raw))
	if err != nil {
		t.Fatal(err)
	}
	return ok
}

func deviceIDs(t *testing.T, svc *Service, userID string) map[string]bool {
	t.Helper()
	ds, err := svc.store.ListDevices(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, d := range ds {
		out[d.ID] = true
	}
	return out
}

func assertBearersRevokedRowsKept(t *testing.T, svc *Service, u User, before map[string]bool, app, cli, unclaimed, browser string) {
	t.Helper()
	if bearerLive(t, svc, app) || bearerLive(t, svc, cli) {
		t.Fatal("an app/CLI bearer survived the password change")
	}
	if raw, ok, err := sqliteOf(t, svc).ConsumeDeviceAuth(context.Background(),
		authx.HashToken(unclaimed), svc.now().Unix()); err != nil || ok || raw != "" {
		t.Fatalf("an approved but unclaimed device-code login was still claimable: ok=%v err=%v", ok, err)
	}
	if !bearerLive(t, svc, browser) {
		t.Fatal("the browser sending identity was revoked; it authenticates nothing without a session")
	}
	after := deviceIDs(t, svc, u.ID)
	for id := range before {
		if !after[id] {
			t.Fatalf("device row %s was deleted; revocation must keep rows (and their Inbox tasks)", id)
		}
	}
}

func TestPasswordResetRevokesAppAndCLIBearers(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	u, mine, stolen := victim(t, svc, m)
	app, cli, unclaimed, browser := signedInEverywhere(t, svc, u, mine)
	before := deviceIDs(t, svc, u.ID)
	epochBefore, _ := svc.store.CredentialEpoch(ctx, u.ID)
	if !bearerLive(t, svc, app) || !bearerLive(t, svc, cli) {
		t.Fatal("fixture: bearers should be live before the reset")
	}

	if _, err := svc.ResetPassword(ctx, resetLink(t, svc, m), "new-password-2"); err != nil {
		t.Fatal(err)
	}
	if live(t, svc, mine) || live(t, svc, stolen) {
		t.Fatal("a reset must still revoke every session")
	}
	assertBearersRevokedRowsKept(t, svc, u, before, app, cli, unclaimed, browser)
	if epoch, _ := svc.store.CredentialEpoch(ctx, u.ID); epoch != epochBefore+1 {
		t.Fatalf("credential_epoch %d, want %d", epoch, epochBefore+1)
	}
	// Signing in again works and is live.
	if again, err := issueBearerNow(ctx, svc, u.ID, "Victim's iPhone"); err != nil || !bearerLive(t, svc, again) {
		t.Fatalf("a fresh sign-in after the reset must work: %v", err)
	}
}

func TestPasswordChangeRevokesBearersAndKeepsTheCallersSession(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	u, mine, stolen := victim(t, svc, m)
	app, cli, unclaimed, browser := signedInEverywhere(t, svc, u, mine)
	before := deviceIDs(t, svc, u.ID)

	if err := svc.ChangePassword(ctx, u, mine.ID, "old-password-1", "new-password-2"); err != nil {
		t.Fatal(err)
	}
	if !live(t, svc, mine) {
		t.Fatal("the session that changed the password must stay signed in")
	}
	if live(t, svc, stolen) {
		t.Fatal("every other session must be revoked")
	}
	assertBearersRevokedRowsKept(t, svc, u, before, app, cli, unclaimed, browser)
}

// The adversarial case: a native login checks the old password, then a reset
// commits, then the login inserts its bearer. Without the epoch guard that
// bearer — minted from the password the reset just replaced — outlives it.
func TestLoginRacingAResetCannotMintABearer(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	u, _, _ := victim(t, svc, m)

	epoch, err := svc.store.CredentialEpochByEmail(ctx, "victim@example.com") // read before the password check
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.authenticate(ctx, "victim@example.com", "old-password-1"); err != nil {
		t.Fatal(err) // the old password is still right at this instant
	}
	before := deviceIDs(t, svc, u.ID)
	if _, err := svc.ResetPassword(ctx, resetLink(t, svc, m), "new-password-2"); err != nil {
		t.Fatal(err)
	}

	tok, err := svc.issueBearer(ctx, u.ID, "attacker", epoch)
	if !errors.Is(err, errCredentialsChanged) || tok != "" {
		t.Fatalf("a login that raced the reset minted a bearer: tok=%q err=%v", tok, err)
	}
	after := deviceIDs(t, svc, u.ID)
	if len(after) != len(before) {
		t.Fatalf("the refused login left a device row behind: %d rows, want %d", len(after), len(before))
	}
}

// A device-code approval validated by a session the reset then revokes must not
// mint a bearer: the store re-checks that session inside the transaction.
func TestDeviceApprovalByARevokedSessionMintsNothing(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	u, _, stolen := victim(t, svc, m)
	st := sqliteOf(t, svc)
	now := svc.now().Unix()
	if err := st.CreateDeviceAuth(ctx, DeviceAuthRequest{
		UserCode: "RACE-CODE", DeviceCodeHash: authx.HashToken("race-device-code"), Status: "pending",
		CreatedAt: now, ExpiresAt: now + 600,
	}); err != nil {
		t.Fatal(err)
	}
	before := deviceIDs(t, svc, u.ID)
	if _, err := svc.ResetPassword(ctx, resetLink(t, svc, m), "new-password-2"); err != nil {
		t.Fatal(err)
	}

	raw := "rlm_cli_" + authx.RandToken()
	_, _, ok, err := st.ApproveAndRegisterDeviceAuth(ctx, "RACE-CODE", u.ID,
		authx.HashToken(stolen.ID), raw, authx.NewID(), now)
	if !errors.Is(err, ErrApprovingSessionGone) || ok {
		t.Fatalf("approval by a revoked session: ok=%v err=%v", ok, err)
	}
	if bearerLive(t, svc, raw) {
		t.Fatal("approval by a revoked session minted a bearer")
	}
	if after := deviceIDs(t, svc, u.ID); len(after) != len(before) {
		t.Fatal("approval by a revoked session created a device row")
	}
}

func TestResetInterruptedAtBearerRevocationAppliesNothing(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	u, mine, stolen := victim(t, svc, m)
	app, cli, _, _ := signedInEverywhere(t, svc, u, mine)
	raw := resetLink(t, svc, m)

	armFault(t, svc, failBearerRevoke)
	_, err := svc.ResetPassword(ctx, raw, "new-password-2")
	disarmFault(t, svc)
	if err == nil || !strings.Contains(err.Error(), "injected fault") {
		t.Fatalf("the injected fault must surface, got %v", err)
	}
	if !live(t, svc, stolen) || !bearerLive(t, svc, app) || !bearerLive(t, svc, cli) || canLogin(svc, "new-password-2") {
		t.Fatal("a reset that failed at bearer revocation applied part of itself")
	}
	if _, err := svc.ResetPassword(ctx, raw, "new-password-2"); err != nil {
		t.Fatalf("the link must still work after the failed attempt: %v", err)
	}
	if bearerLive(t, svc, app) || bearerLive(t, svc, cli) {
		t.Fatal("the retried reset left a bearer live")
	}
}

// resetRightAfterPasswordRead is the real store with one change: the first
// time a login reads the stored password, a password reset commits right after
// that read — the interleaving a concurrent reset produces. No production code
// is hooked; the login entry points run unmodified on top of it.
type resetRightAfterPasswordRead struct {
	*SQLiteStore
	once  sync.Once
	reset func()
}

func (w *resetRightAfterPasswordRead) GetCredentials(ctx context.Context, email string) (string, string, bool, error) {
	uid, hash, ok, err := w.SQLiteStore.GetCredentials(ctx, email)
	w.once.Do(w.reset)
	return uid, hash, ok, err
}

func liveSessions(t *testing.T, st *SQLiteStore, userID string) int {
	t.Helper()
	var n int
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE user_id = ? AND revoked = 0`, userID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func raceResetIntoNextPasswordRead(t *testing.T, svc *Service, m *captureMailer) {
	t.Helper()
	raw := resetLink(t, svc, m)
	st := sqliteOf(t, svc)
	svc.store = &resetRightAfterPasswordRead{SQLiteStore: st, reset: func() {
		if _, err := svc.ResetPassword(context.Background(), raw, "new-password-2"); err != nil {
			t.Errorf("racing reset: %v", err)
		}
	}}
}

// Web password login: a session minted from the replaced password would be a
// live session after the reset, and could approve a device-code login.
func TestBrowserLoginRacingAResetGetsNoSession(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	u, _, _ := victim(t, svc, m)
	st := sqliteOf(t, svc)
	raceResetIntoNextPasswordRead(t, svc, m)

	sess, err := svc.Login(ctx, "victim@example.com", "old-password-1")
	if !errors.Is(err, ErrBadCredentials) || sess.ID != "" {
		t.Fatalf("a login that read the old password before the reset got a session: %+v %v", sess, err)
	}
	// Only the session the reset itself issued to the person resetting is live.
	if n := liveSessions(t, st, u.ID); n != 1 {
		t.Fatalf("%d live sessions after the raced login, want exactly the resetter's", n)
	}
}

// Native password login over HTTP, the real handler order.
func TestNativeLoginRacingAResetGetsNoBearer(t *testing.T) {
	svc, m := newTestService(t)
	u, _, _ := victim(t, svc, m)
	st := sqliteOf(t, svc)
	before := deviceIDs(t, svc, u.ID)
	raceResetIntoNextPasswordRead(t, svc, m)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/native/login",
		strings.NewReader(`{"email":"victim@example.com","password":"old-password-1","deviceName":"attacker"}`))
	svc.handleNativeLogin(rec, req)
	if rec.Code != http.StatusUnauthorized || strings.Contains(rec.Body.String(), "rlm_cli_") {
		t.Fatalf("native login that raced the reset: %d %s", rec.Code, rec.Body.String())
	}
	var bearers int
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM cli_tokens WHERE user_id = ?`, u.ID).Scan(&bearers); err != nil {
		t.Fatal(err)
	}
	if bearers != 0 {
		t.Fatalf("%d bearers exist after the raced native login, want 0", bearers)
	}
	if after := deviceIDs(t, svc, u.ID); len(after) != len(before) {
		t.Fatal("the refused native login left a device row")
	}
}

func TestChangeInterruptedAtBearerRevocationAppliesNothing(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	u, mine, stolen := victim(t, svc, m)
	app, cli, _, _ := signedInEverywhere(t, svc, u, mine)

	armFault(t, svc, failBearerRevoke)
	err := svc.ChangePassword(ctx, u, mine.ID, "old-password-1", "new-password-2")
	disarmFault(t, svc)
	if err == nil || !strings.Contains(err.Error(), "injected fault") {
		t.Fatalf("the injected fault must surface, got %v", err)
	}
	if !live(t, svc, stolen) || !bearerLive(t, svc, app) || !bearerLive(t, svc, cli) || canLogin(svc, "new-password-2") {
		t.Fatal("a change that failed at bearer revocation applied part of itself")
	}
	if epoch, _ := svc.store.CredentialEpoch(ctx, u.ID); epoch != 0 {
		t.Fatalf("a failed change bumped credential_epoch to %d", epoch)
	}
}

// Revocation keeps what a device received: its row, its Inbox enrolment and
// key, and the tasks addressed to it (inbox_tasks cascades on device DELETE,
// which is exactly why revocation must not delete the row).
func TestPasswordChangeKeepsInboxEnrolmentAndTasks(t *testing.T) {
	h := newTaskHarness(t)
	u := h.user(t, "inbox-keep@example.test")
	target := h.enrolTarget(t, u, "target", inbox.AutoAcceptAuto, true)
	fileID := h.storedObject(t, u, 64, time.Hour)
	sender := h.bearer(t, u, "sender")
	created := h.createTask(t, target.deviceID, createOpts{idem: "keep-1", fileID: fileID,
		keyID: target.keyID, keyGen: target.keyGen, authMutate: withBearer(sender)})
	if created.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d", created.StatusCode)
	}
	taskID := decodeJSONBody(t, created)["task"].(map[string]any)["ID"].(string)

	if err := h.store.ChangePasswordAndRevokeSessions(t.Context(), u, "$2a$10$fixture", "", "no-current-session", 0); err != nil {
		t.Fatal(err)
	}
	var bearers int
	if err := h.store.db.QueryRow(`SELECT COUNT(*) FROM cli_tokens WHERE device_id = ?`, target.deviceID).Scan(&bearers); err != nil {
		t.Fatal(err)
	}
	if bearers != 0 {
		t.Fatal("the target device's bearer survived the change")
	}
	if ds := deviceIDsOf(t, h.store, u); !ds[target.deviceID] {
		t.Fatal("the target device row was deleted")
	}
	inboxes, err := h.store.ListDeviceInboxes(t.Context(), u)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := inboxes[target.deviceID]; !ok {
		t.Fatal("the Inbox enrolment was deleted")
	}
	keys, err := h.store.ActiveDeviceKeys(t.Context(), u)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := keys[target.deviceID]; !ok {
		t.Fatal("the device's Inbox key was deleted")
	}
	if _, ok, err := h.store.GetInboxTask(t.Context(), taskID, u, h.nowUnix()); err != nil || !ok {
		t.Fatalf("the task addressed to the device was deleted: ok=%v err=%v", ok, err)
	}
}

func deviceIDsOf(t *testing.T, st *SQLiteStore, userID string) map[string]bool {
	t.Helper()
	ds, err := st.ListDevices(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, d := range ds {
		out[d.ID] = true
	}
	return out
}

// A change in flight from a session the owner is about to lock out: it has read
// and verified the old password when the owner's reset commits. Without the
// epoch condition the change then writes the attacker's password over the
// reset's, and the attacker signs in again with it.
func TestChangeRacingAResetCannotOverwriteIt(t *testing.T) {
	svc, m := newTestService(t)
	u, _, stolen := victim(t, svc, m)
	raceResetIntoNextPasswordRead(t, svc, m)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/password/change",
		strings.NewReader(`{"currentPassword":"old-password-1","newPassword":"attacker-password-3"}`))
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: stolen.ID})
	svc.handleChangePassword(rec, req, u)
	if rec.Code != http.StatusUnauthorized || strings.TrimSpace(rec.Body.String()) != "unauthorized" {
		t.Fatalf("a change overtaken by a reset answered %d %q, want 401 unauthorized", rec.Code, rec.Body.String())
	}
	if canLogin(svc, "attacker-password-3") {
		t.Fatal("the change overwrote the password the reset had just set")
	}
	if !canLogin(svc, "new-password-2") {
		t.Fatal("the reset's password no longer works")
	}
}

// resetThenAnotherReset commits a second reset right after the first reset's
// transaction and before the first reset issues its session.
// (A plain flag, not sync.Once: the second reset runs through this same
// wrapper, and a re-entrant Once.Do would wait on itself.)
type resetThenAnotherReset struct {
	*SQLiteStore
	fired  bool
	second func()
}

func (w *resetThenAnotherReset) ResetPasswordWithToken(ctx context.Context, tokenHash string, now int64, passwordHash string) (ResetOutcome, string, int64, error) {
	outcome, uid, epoch, err := w.SQLiteStore.ResetPasswordWithToken(ctx, tokenHash, now, passwordHash)
	if !w.fired {
		w.fired = true
		w.second()
	}
	return outcome, uid, epoch, err
}

func TestResetSessionIsNotIssuedPastALaterReset(t *testing.T) {
	ctx := context.Background()
	svc, m := newTestService(t)
	u, _, _ := victim(t, svc, m)
	st := sqliteOf(t, svc)
	first := resetLink(t, svc, m)
	second := resetLink(t, svc, m)
	var secondSess Session
	svc.store = &resetThenAnotherReset{SQLiteStore: st, second: func() {
		var err error
		if secondSess, err = svc.ResetPassword(ctx, second, "second-password-4"); err != nil {
			t.Errorf("second reset: %v", err)
		}
	}}

	sess, err := svc.ResetPassword(ctx, first, "first-password-3")
	if !errors.Is(err, ErrCredentialsChanged) || sess.ID != "" {
		t.Fatalf("the first reset issued a session after a later reset: %+v %v", sess, err)
	}
	if n := liveSessions(t, st, u.ID); n != 1 || !live(t, svc, secondSess) {
		t.Fatalf("%d live sessions, want only the later reset's", n)
	}
}
