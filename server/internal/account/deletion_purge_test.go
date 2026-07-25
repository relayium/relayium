package account

import (
	"context"
	"io"
	"log"
	"testing"

	"github.com/relayium/relayium/internal/authx"
)

// TestGCPurgesDueAccountsAndArchives is the brief's Step-1 acceptance test:
// ListUsersToPurge only surfaces the due account, ArchiveAndPurgeUser removes
// it while leaving a not-yet-due account untouched, and its usage_monthly
// total lands in the anonymized usage_archive.
func TestGCPurgesDueAccountsAndArchives(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	due, _ := st.UpsertUserByEmail(ctx, "due@example.com", "")
	notyet, _ := st.UpsertUserByEmail(ctx, "later@example.com", "")
	_ = st.RecordMeter(ctx, due.ID, MeterUpload, 500, 1) // populates usage_monthly for a period
	_ = st.SetAccountDeletion(ctx, due.ID, 1, 100)       // purge_after=100
	_ = st.SetAccountDeletion(ctx, notyet.ID, 1, 1<<40)  // far future

	users, err := st.ListUsersToPurge(ctx, 200)
	if err != nil {
		t.Fatalf("list to purge: %v", err)
	}
	if len(users) != 1 || users[0].ID != due.ID {
		t.Fatalf("only the due user should be listed: %+v", users)
	}
	if err := st.ArchiveAndPurgeUser(ctx, due.ID, 200); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetUserByID(ctx, due.ID); err == nil {
		t.Fatal("purged user should be gone")
	}
	if _, err := st.GetUserByID(ctx, notyet.ID); err != nil {
		t.Fatal("not-yet user must survive")
	}
	up := archivedUploadBytes(t, st, periodOf(1))
	if up < 500 {
		t.Fatalf("usage should be archived, got %d", up)
	}
}

// archivedUploadBytes reads usage_archive directly — it has no user column
// (anonymized), so this is a test-only reader rather than production API.
func archivedUploadBytes(t *testing.T, st *SQLiteStore, period string) int64 {
	t.Helper()
	var n int64
	if err := st.db.QueryRowContext(context.Background(),
		`SELECT upload_bytes FROM usage_archive WHERE period=?`, period).Scan(&n); err != nil {
		t.Fatalf("read usage_archive: %v", err)
	}
	return n
}

// userLinkedTables enumerates EVERY table a live account can have rows in,
// keyed by user_id (or, for magic_tokens, matched by email since it has no
// user_id column) — the exhaustive FK-safe delete set ArchiveAndPurgeUser
// must clear. A regression that forgets one (e.g. email_tokens) would leave
// an orphan row here undetected by a narrower test.
var userLinkedTables = []struct {
	table string
	where string
}{
	{"identities", "user_id=?"},
	{"sessions", "user_id=?"},
	{"devices", "user_id=?"},
	{"usage_events", "user_id=?"},
	{"stored_files", "user_id=?"},
	{"upload_events", "user_id=?"},
	{"user_stats", "user_id=?"},
	{"usage_monthly", "user_id=?"},
	{"email_tokens", "user_id=?"},
	{"node_tokens", "user_id=?"},
	{"cli_tokens", "user_id=?"},
	{"cli_device_auth", "user_id=?"},
	{"nodes", "owner_type='user' AND owner_user_id=?"},
}

// TestArchiveAndPurgeUserClearsEveryLinkedTable seeds one row per table a
// live account can own (mirroring TestPurgeTransientUserData's fixture, plus
// the account-shell rows Task 2's transient purge deliberately leaves behind:
// identities, usage_events, user_stats, usage_monthly, email_tokens), then
// asserts ArchiveAndPurgeUser leaves zero rows in every single one and the
// users row itself is gone — the exhaustive FK-safe-delete-order check the
// task brief calls out (email_tokens is the one most likely to be missed).
func TestArchiveAndPurgeUserClearsEveryLinkedTable(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "full@example.com", "Full")

	if err := st.LinkIdentity(ctx, "email", u.Email, u.ID); err != nil {
		t.Fatalf("link identity: %v", err)
	}
	if err := st.CreateSession(ctx, Session{ID: authx.NewID(), UserID: u.ID, CreatedAt: 1, ExpiresAt: 1 << 40}); err != nil {
		t.Fatalf("create session: %v", err)
	}
	if err := st.CreateMagicToken(ctx, MagicToken{TokenHash: authx.HashToken("magic"), Email: u.Email, CreatedAt: 1, ExpiresAt: 1 << 40}); err != nil {
		t.Fatalf("create magic token: %v", err)
	}
	dev, err := st.UpsertDevice(ctx, Device{ID: authx.NewID(), UserID: u.ID, Name: "cli", Kind: "cli", CreatedAt: 1})
	if err != nil {
		t.Fatalf("upsert device: %v", err)
	}
	if err := st.CreateCLIToken(ctx, CLIToken{TokenHash: authx.HashToken("clitok"), UserID: u.ID, DeviceID: dev.ID, CreatedAt: 1}); err != nil {
		t.Fatalf("create cli token: %v", err)
	}
	if err := st.CreateDeviceAuth(ctx, DeviceAuthRequest{UserCode: "WDJB-MJHT", DeviceCodeHash: authx.HashToken("dev"), Status: "pending", CreatedAt: 1, ExpiresAt: 1 << 40}); err != nil {
		t.Fatalf("create device auth: %v", err)
	}
	if ok, err := st.ApproveDeviceAuth(ctx, "WDJB-MJHT", u.ID, authx.HashToken("approvedtok"), "rlm_cli_raw", 2); err != nil || !ok {
		t.Fatalf("approve device auth: ok=%v err=%v", ok, err)
	}
	if err := st.RecordUsage(ctx, UsageEvent{AllocID: authx.NewID(), Token: "t", UserID: u.ID, RelayedBytes: 10, RecordedAt: 1}); err != nil {
		t.Fatalf("record usage: %v", err)
	}
	if err := st.CreateStoredFile(ctx, StoredFile{ID: authx.NewID(), UserID: u.ID, BlobKey: "bk", EncManifest: []byte("x"), Size: 1, ExpiresAt: 1 << 40, CreatedAt: 1}); err != nil {
		t.Fatalf("create stored file: %v", err)
	}
	if err := st.RecordUpload(ctx, UploadEvent{ID: authx.NewID(), UserID: u.ID, Bytes: 1, UploadedAt: 1}); err != nil {
		t.Fatalf("record upload: %v", err)
	}
	if err := st.AddUploadStat(ctx, u.ID, 100); err != nil {
		t.Fatalf("add upload stat: %v", err)
	}
	if err := st.RecordMeter(ctx, u.ID, MeterUpload, 4096, 100); err != nil {
		t.Fatalf("record meter: %v", err)
	}
	if err := st.CreateEmailToken(ctx, EmailToken{TokenHash: authx.HashToken("verif"), UserID: u.ID, Email: u.Email, Purpose: "verify", CreatedAt: 1, ExpiresAt: 1 << 40}); err != nil {
		t.Fatalf("create email token: %v", err)
	}
	node, err := st.UpsertNode(ctx, Node{ID: authx.NewID(), OwnerType: "user", OwnerUserID: u.ID, URLs: []string{"turn:example:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1 << 40})
	if err != nil {
		t.Fatalf("upsert node: %v", err)
	}
	if err := st.CreateNodeToken(ctx, NodeToken{ID: authx.NewID(), TokenHash: authx.HashToken("nt"), UserID: u.ID, NodeID: node.ID, Name: "byo", CreatedAt: 1}); err != nil {
		t.Fatalf("create node token: %v", err)
	}

	// Sanity: every table actually has a row before purging, so the
	// post-purge zero-count assertions below are meaningful.
	for _, tbl := range userLinkedTables {
		if n := countRows(t, st, `SELECT COUNT(*) FROM `+tbl.table+` WHERE `+tbl.where, u.ID); n == 0 {
			t.Fatalf("fixture bug: %s has no row for user before purge", tbl.table)
		}
	}
	if countRows(t, st, `SELECT COUNT(*) FROM magic_tokens WHERE email=?`, u.Email) == 0 {
		t.Fatal("fixture bug: magic_tokens has no row for user before purge")
	}

	if err := st.SetAccountDeletion(ctx, u.ID, 1, 100); err != nil {
		t.Fatalf("schedule deletion: %v", err)
	}
	if err := st.ArchiveAndPurgeUser(ctx, u.ID, 200); err != nil {
		t.Fatalf("archive and purge: %v", err)
	}

	for _, tbl := range userLinkedTables {
		if n := countRows(t, st, `SELECT COUNT(*) FROM `+tbl.table+` WHERE `+tbl.where, u.ID); n != 0 {
			t.Fatalf("%s: %d rows survived purge, want 0", tbl.table, n)
		}
	}
	if n := countRows(t, st, `SELECT COUNT(*) FROM magic_tokens WHERE email=?`, u.Email); n != 0 {
		t.Fatalf("magic_tokens: %d rows survived purge, want 0", n)
	}
	if _, err := st.GetUserByID(ctx, u.ID); err == nil {
		t.Fatal("users row should be gone")
	}
	up := archivedUploadBytes(t, st, periodOf(100))
	if up < 4096 {
		t.Fatalf("usage_monthly should be archived into usage_archive, got %d", up)
	}
}

// TestArchiveAndPurgeUserSumsAcrossMultipleUsersSamePeriod: the archive
// upsert must fold, not overwrite, when a second user's purge lands in a
// period the archive already has totals for — otherwise the anonymized
// ledger would silently lose the first user's contribution.
func TestArchiveAndPurgeUserSumsAcrossMultipleUsersSamePeriod(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	a, _ := st.UpsertUserByEmail(ctx, "a@example.com", "")
	b, _ := st.UpsertUserByEmail(ctx, "b@example.com", "")

	_ = st.RecordMeter(ctx, a.ID, MeterUpload, 1000, 100)
	_ = st.RecordMeter(ctx, b.ID, MeterUpload, 2000, 100) // same period as a
	_ = st.SetAccountDeletion(ctx, a.ID, 1, 100)
	_ = st.SetAccountDeletion(ctx, b.ID, 1, 100)

	if err := st.ArchiveAndPurgeUser(ctx, a.ID, 200); err != nil {
		t.Fatalf("purge a: %v", err)
	}
	if err := st.ArchiveAndPurgeUser(ctx, b.ID, 200); err != nil {
		t.Fatalf("purge b: %v", err)
	}

	period := periodOf(100)
	if up := archivedUploadBytes(t, st, period); up != 3000 {
		t.Fatalf("archive should sum both users' totals for the shared period, got %d want 3000", up)
	}
}

// TestArchiveAndPurgeUserSkipsReactivatedAccount is the reactivation-race
// regression: GC snapshots a due account via ListUsersToPurge, then the user
// reactivates (ClearAccountDeletion zeroes purge_after) before GC reaches
// ArchiveAndPurgeUser. The guarded final delete must match nothing and roll the
// whole purge back, leaving the live account — and its data — fully intact.
func TestArchiveAndPurgeUserSkipsReactivatedAccount(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "revived@example.com", "Revived")
	_ = st.RecordMeter(ctx, u.ID, MeterUpload, 777, 100)
	_ = st.CreateStoredFile(ctx, StoredFile{ID: authx.NewID(), UserID: u.ID, BlobKey: "bk", EncManifest: []byte("x"), Size: 1, ExpiresAt: 1 << 40, CreatedAt: 1})
	_ = st.SetAccountDeletion(ctx, u.ID, 1, 100) // due at purge_after=100

	// User reactivates just before GC's purge fires.
	if err := st.ClearAccountDeletion(ctx, u.ID); err != nil {
		t.Fatalf("clear deletion: %v", err)
	}

	if err := st.ArchiveAndPurgeUser(ctx, u.ID, 200); err != nil {
		t.Fatalf("purge (should be a no-op): %v", err)
	}

	if _, err := st.GetUserByID(ctx, u.ID); err != nil {
		t.Fatal("reactivated account must survive the raced purge")
	}
	if n := countRows(t, st, `SELECT COUNT(*) FROM stored_files WHERE user_id=?`, u.ID); n != 1 {
		t.Fatalf("stored_files should be untouched by the aborted purge, got %d", n)
	}
	// The archive INSERT is inside the same transaction, so a rollback must also
	// undo it — no anonymized total should leak for a user who never purged.
	var archived int64
	_ = st.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_archive WHERE period=?`, periodOf(100)).Scan(&archived)
	if archived != 0 {
		t.Fatalf("aborted purge must not archive usage, got %d archive rows", archived)
	}
}

// TestGCSweepSendsReminderOnceThenPurges exercises the full sweep-level
// wiring: a user just inside the reminder window gets exactly one reminder
// email + MarkPurgeReminderSent (a second sweep before purge doesn't resend),
// then once purge_after elapses the next sweep hard-purges the account and
// sends the final "deleted" email — while an account nowhere near due is
// untouched by either pass.
func TestGCSweepSendsReminderOnceThenPurges(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	soon, _ := st.UpsertUserByEmail(ctx, "soon@example.com", "")
	far, _ := st.UpsertUserByEmail(ctx, "far@example.com", "")
	_ = st.SetAccountDeletion(ctx, soon.ID, 1, 1000) // purge_after=1000
	_ = st.SetAccountDeletion(ctx, far.ID, 1, 1<<40) // nowhere near due

	mailer := &captureMailer{}
	linkCalls := 0
	g := &GC{
		Store:          st,
		Now:            func() int64 { return 950 }, // 50s before purge_after
		Log:            log.New(io.Discard, "", 0),
		Mailer:         mailer,
		ReminderWindow: func(context.Context) int64 { return 100 }, // window covers [950,1050]
		ReactivateLink: func(_ context.Context, userID, email string) (string, error) {
			linkCalls++
			return "https://relayium.example/account/reactivate?token=fake-" + userID, nil
		},
	}

	// First sweep: soon is inside the reminder window and unreminded -> one
	// reminder email + purge_reminder_sent set. far is untouched.
	g.sweep(ctx)
	if mailer.deletionReminderLink == "" {
		t.Fatal("expected a reminder email to be sent")
	}
	if linkCalls != 1 {
		t.Fatalf("expected exactly one reactivate link minted, got %d", linkCalls)
	}
	u, err := st.GetUserByID(ctx, soon.ID)
	if err != nil {
		t.Fatalf("get soon user: %v", err)
	}
	// purge_reminder_sent isn't exposed on User; confirm via ListUsersToRemind
	// no longer returning this user.
	remind, _ := st.ListUsersToRemind(ctx, 950, 100)
	if len(remind) != 0 {
		t.Fatalf("reminder should fire once; still listed to remind: %+v", remind)
	}
	if u.PurgeAfter != 1000 {
		t.Fatalf("purge_after should be unchanged by the reminder pass, got %d", u.PurgeAfter)
	}

	// Second sweep at the same time: no resend (already marked sent), and
	// still not due for purge.
	g.sweep(ctx)
	if linkCalls != 1 {
		t.Fatalf("reminder must fire at most once; reactivate link minted %d times", linkCalls)
	}
	if _, err := st.GetUserByID(ctx, soon.ID); err != nil {
		t.Fatal("account not yet due should survive")
	}

	// Third sweep once purge_after has elapsed: hard purge + final email.
	g.Now = func() int64 { return 1000 }
	g.sweep(ctx)
	if _, err := st.GetUserByID(ctx, soon.ID); err == nil {
		t.Fatal("due account should be purged")
	}
	if mailer.accountDeletedCount != 1 {
		t.Fatalf("expected exactly one final deletion email, got %d", mailer.accountDeletedCount)
	}
	if _, err := st.GetUserByID(ctx, far.ID); err != nil {
		t.Fatal("far-future account must survive every pass")
	}
}
