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
	"strings"
	"testing"

	"github.com/relayium/relayium/authx"
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
