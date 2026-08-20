package account

import (
	"bytes"
	"context"
	"testing"
)

// Pair-room retention (owner decision, 2026-08-20).
//
// The retired rule gave a joined room no deadline at all — math.MaxInt64 on the
// room and on every object in it — and production grew four current-Free objects
// sitting there days past the one day their account was entitled to. The rule
// now is the one every other stored object already follows: the ciphertext lives
// for the ACCOUNT PLAN's retention window.
//
// These tests pin the six things that rule has to get right at once, plus the
// migration that repairs the rows the old rule wrote.

// The snapshot is taken when the room OPENS, from the owner's plan. Free first,
// because Free is the plan the defect was found on.
func TestPairRoomSnapshotsFreeRetentionAtCreation(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("440001", "")
	id := h.preUpload(t, "440001", bytes.Repeat([]byte("F"), 1024), 1)

	room := h.roomOf(t, id)
	if room.RetentionSecs != pairRoomFreeRetention {
		t.Fatalf("free room snapshot = %d, want %d", room.RetentionSecs, pairRoomFreeRetention)
	}
	// Before anyone joins, the snapshot changes nothing: the room is still bounded
	// by the JOIN deadline, which is much shorter. Retention is what a joined room
	// gets, not a floor an unjoined one is promoted to.
	if want := pairRoomJoinDeadline(room); room.ExpiresAt != want {
		t.Fatalf("unjoined expiry = %d, want the join deadline %d", room.ExpiresAt, want)
	}

	h.join(t, "440001")
	room = h.roomOf(t, id)
	if want := room.JoinedAt + pairRoomFreeRetention; room.ExpiresAt != want {
		t.Fatalf("joined expiry = %d, want %d", room.ExpiresAt, want)
	}
	if room.ExpiresAt == pairRoomLegacyNoDeadline {
		t.Fatal("a joined Free room is still unbounded")
	}
	// The object carries exactly what the room carries. They are projected in one
	// transaction and must never be read apart.
	sf, err := h.store.GetStoredFile(context.Background(), id)
	if err != nil {
		t.Fatalf("stored file: %v", err)
	}
	if sf.ExpiresAt != room.ExpiresAt {
		t.Fatalf("object expiry %d != room expiry %d", sf.ExpiresAt, room.ExpiresAt)
	}
}

// ...and a paid plan gets the window it is paying for. Pro, seven days.
func TestPairRoomSnapshotsPaidRetentionAtCreation(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	// The Pro numbers the product actually sells (settings.go defaultPlans).
	h.setPlan(t, Plan{ID: "pro", Name: "Pro", StorageBytes: 5 << 30,
		TrafficBytes: 100 << 30, RetentionSecs: 604800, DailyQuotaBytes: 34 << 30})

	h.mintCode("440002", "")
	id := h.preUpload(t, "440002", bytes.Repeat([]byte("P"), 1024), 1)
	room := h.roomOf(t, id)
	if room.RetentionSecs != 604800 {
		t.Fatalf("pro room snapshot = %d, want 604800", room.RetentionSecs)
	}

	h.join(t, "440002")
	room = h.roomOf(t, id)
	if want := room.JoinedAt + 604800; room.ExpiresAt != want {
		t.Fatalf("joined Pro expiry = %d, want %d", room.ExpiresAt, want)
	}
	// Six days in, a Pro transfer is still there where a Free one would be five
	// days gone. That difference IS the entitlement.
	h.advance(6 * 24 * 3600)
	h.svc.SweepPairRooms(ctx, h.now)
	if status, _ := h.getAnon(t, "/api/files/"+id+"/blob"); status != 200 {
		t.Fatalf("Pro ciphertext six days in: %d, want 200", status)
	}
	h.advance(2 * 24 * 3600)
	h.svc.SweepPairRooms(ctx, h.now)
	if status, _ := h.getAnon(t, "/api/files/"+id+"/blob"); status == 200 {
		t.Fatal("Pro ciphertext is still readable eight days in")
	}
}

// ...and a plans row an admin has typoed BELOW the Free day cannot shorten a
// room. This is the one direction the creation path can get wrong that no later
// read can undo, because the snapshot is taken once and never re-read: without
// the floor it writes 3600 onto the room and that ciphertext — even a Free
// account's — is deleted an hour in, a day short of the shortest window the
// product sells.
func TestPairRoomSnapshotBelowFreeIsFlooredAtCreation(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	// A typo, not a tier. Relayium sells four windows and the shortest is a day.
	h.setPlan(t, Plan{ID: "typo", Name: "Typo", StorageBytes: 5 << 30,
		TrafficBytes: 100 << 30, RetentionSecs: 3600, DailyQuotaBytes: 34 << 30})
	if got := h.svc.pairRoomRetentionFor(ctx, h.userID); got != pairRoomFreeRetention {
		t.Fatalf("snapshot for a below-Free plan = %d, want the Free floor %d",
			got, pairRoomFreeRetention)
	}
	// The clamp has to be the thing under test, not a plan read that quietly
	// returned something else.
	if got := h.svc.planRetentionCap(ctx, h.userID); got != 3600 {
		t.Fatalf("planRetentionCap = %d, want the raw 3600; this test proves nothing", got)
	}

	h.mintCode("440009", "")
	id := h.preUpload(t, "440009", bytes.Repeat([]byte("T"), 1024), 1)
	room := h.roomOf(t, id)
	if room.RetentionSecs != pairRoomFreeRetention {
		t.Fatalf("room snapshot = %d, want the Free floor %d",
			room.RetentionSecs, pairRoomFreeRetention)
	}

	h.join(t, "440009")
	room = h.roomOf(t, id)
	if want := room.JoinedAt + pairRoomFreeRetention; room.ExpiresAt != want {
		t.Fatalf("joined expiry = %d, want a full Free day %d", room.ExpiresAt, want)
	}
	// The ciphertext is still there an hour in, which is the whole point: the typo
	// bought it a deletion the account was never opted into.
	h.advance(2 * 3600)
	h.svc.SweepPairRooms(ctx, h.now)
	if status, _ := h.getAnon(t, "/api/files/"+id+"/blob"); status != 200 {
		t.Fatalf("ciphertext two hours in: %d, want 200", status)
	}
}

// GENUINE PROGRESS MOVES THE DEADLINE. This is the half of the owner's original
// rule that had to survive the change: a slow upload that is still landing bytes
// keeps buying itself another full window, so it is never cut off mid transfer.
//
// The room is joined FIRST and the second file uploads afterwards, which is the
// real shape of the case — a receiver arrives while the sender is still sending.
func TestJoinedRoomProgressPushesTheRetentionDeadlineOut(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	h.mintCode("440003", "")
	idA := h.preUpload(t, "440003", bytes.Repeat([]byte("A"), 1024), 1)

	// A second file is already in flight — one chunk in — when the receiver joins.
	blobBInit := bytes.Repeat([]byte("B"), 2048)
	initStatus, uploadB, _ := h.initPairUpload(t, "440003", len(blobBInit), "")
	if initStatus != 200 {
		t.Fatalf("init B: %d", initStatus)
	}
	if got := h.patch(t, uploadB, blobBInit, 0, 1024, len(blobBInit)); got != 200 {
		t.Fatalf("patch B first chunk: %d", got)
	}

	h.join(t, "440003")

	room := h.roomOf(t, idA)
	atJoin := room.ExpiresAt
	if want := room.JoinedAt + pairRoomFreeRetention; atJoin != want {
		t.Fatalf("expiry at join = %d, want %d", atJoin, want)
	}

	// Most of the window goes by with the sender still working, then the second
	// file's last chunk commits. It was INITED before the join and finalizes after
	// — the protocol refuses a new init to a joined room, so this in-flight upload
	// is the only shape "progress after a join" can actually take.
	h.advance(pairRoomFreeRetention - 3600)
	blobB := bytes.Repeat([]byte("B"), 2048)
	if got := h.patch(t, uploadB, blobB, 1024, 2048, len(blobB)); got != 200 {
		t.Fatalf("patch after the join: %d", got)
	}
	status, idB := h.finalize(t, uploadB)
	if status != 200 {
		t.Fatalf("finalize after the join: %d", status)
	}

	room = h.roomOf(t, idA)
	if room.ExpiresAt <= atJoin {
		t.Fatalf("committed bytes did not move the deadline: %d -> %d", atJoin, room.ExpiresAt)
	}
	if want := room.LastUploadAt + pairRoomFreeRetention; room.ExpiresAt != want {
		t.Fatalf("expiry = %d, want last-upload plus the window %d", room.ExpiresAt, want)
	}
	if room.ExpiresAt == pairRoomLegacyNoDeadline {
		t.Fatal("progress made the room unbounded")
	}
	// The projection reaches the FIRST file too, which is the whole reason room and
	// objects move together: file A must not expire while file B is still arriving.
	for _, id := range []string{idA, idB} {
		sf, err := h.store.GetStoredFile(ctx, id)
		if err != nil {
			t.Fatalf("stored file %s: %v", id, err)
		}
		if sf.ExpiresAt != room.ExpiresAt {
			t.Fatalf("object %s expiry %d != room %d", id, sf.ExpiresAt, room.ExpiresAt)
		}
	}

	// An hour past where the ORIGINAL window ended, the transfer is still alive,
	// because real bytes bought it more time.
	h.advance(3600 + 60)
	h.svc.SweepPairRooms(ctx, h.now)
	if h.now <= atJoin {
		t.Fatal("the test never passed the original deadline")
	}
	if status, _ := h.getAnon(t, "/api/files/"+idA+"/blob"); status != 200 {
		t.Fatalf("an actively progressing transfer was cut off: %d", status)
	}
}

// ...and only the SERVER's own committed bytes may move it. A deadline a client
// could push out by asking is not a deadline; it is the unbounded rule again
// with an extra round trip.
func TestReadsAndFailedUploadsDoNotMoveTheRetentionDeadline(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("440004", "")
	id := h.preUpload(t, "440004", bytes.Repeat([]byte("R"), 1024), 1)
	h.join(t, "440004")
	before := h.roomOf(t, id).ExpiresAt

	h.advance(3600)
	// A receiver reading the blob, repeatedly, and a duplicate join notification.
	for range 3 {
		if status, _ := h.getAnon(t, "/api/files/"+id+"/blob"); status != 200 {
			t.Fatalf("blob: %d", status)
		}
	}
	h.join(t, "440004")
	// An upload INIT that the protocol refuses because the room is already joined.
	if status, _, _ := h.initPairUpload(t, "440004", 1024, ""); status == 200 {
		t.Fatal("a joined room accepted a new upload init")
	}

	if got := h.roomOf(t, id).ExpiresAt; got != before {
		t.Fatalf("something that committed no bytes moved the deadline %d -> %d", before, got)
	}
}

// A receiver's completion still deletes immediately. The retention window is a
// ceiling on abandonment, never a floor that keeps delivered ciphertext around.
func TestCompletionStillDeletesImmediatelyUnderRetention(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	h.mintCode("440005", "")
	key := fileKeyN(41)
	id := h.preUploadCompletable(t, "440005", bytes.Repeat([]byte("C"), 1024), key)
	h.join(t, "440005")

	room := h.roomOf(t, id)
	sf, err := h.store.GetStoredFile(ctx, id)
	if err != nil {
		t.Fatalf("stored file: %v", err)
	}
	if room.ExpiresAt <= h.now {
		t.Fatal("the room was already over before the completion")
	}

	if resp, _ := h.completeWithKey(t, id, key); resp.StatusCode != 204 {
		t.Fatalf("completion: %d", resp.StatusCode)
	}
	// Gone NOW — not at the retention deadline, which is still a day away.
	if _, err := h.store.GetStoredFile(ctx, id); err == nil {
		t.Fatal("a completed object outlived its completion")
	}
	if h.blobExists(t, sf.BlobKey) {
		t.Fatal("a completed object's ciphertext is still on disk")
	}
	if r, found, _ := h.store.GetPairRoom(ctx, room.ID); found && r.ClosedAt == 0 {
		t.Fatal("the last object was completed and the room stayed open")
	}
}

// ABANDONMENT IS BOUNDED. This is the case the retired rule had no answer for
// and the one that produced the four production rows: a receiver joins, never
// completes (§7.6 — no browser receiver can), and the owner never releases.
//
// It ends at the plan deadline now, through the GC backstop that was already
// written. Nothing new deletes anything.
func TestAbandonedJoinedRoomIsReclaimedAtThePlanDeadline(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	h.mintCode("440006", "")
	id := h.preUpload(t, "440006", bytes.Repeat([]byte("Z"), 1024), 1)
	h.join(t, "440006")
	room := h.roomOf(t, id)
	sf, err := h.store.GetStoredFile(ctx, id)
	if err != nil {
		t.Fatalf("stored file: %v", err)
	}

	// One second short of the deadline, nothing may touch it.
	h.advance(room.ExpiresAt - h.now - 1)
	h.svc.SweepPairRooms(ctx, h.now)
	if r, found, _ := h.store.GetPairRoom(ctx, room.ID); !found || r.ClosedAt != 0 {
		t.Fatal("the sweep reclaimed a joined room one second early")
	}
	if !h.blobExists(t, sf.BlobKey) {
		t.Fatal("ciphertext deleted one second before its deadline")
	}

	// One second past it, the ordinary sweep collects it: room closed, row gone,
	// ciphertext gone, storage released.
	h.advance(2)
	h.svc.SweepPairRooms(ctx, h.now)
	r, found, _ := h.store.GetPairRoom(ctx, room.ID)
	if found && r.ClosedAt == 0 {
		t.Fatal("an abandoned joined room stayed open past its plan deadline")
	}
	if h.blobExists(t, sf.BlobKey) {
		t.Fatal("an abandoned joined room's ciphertext survived its plan deadline")
	}
	if _, err := h.store.GetStoredFile(ctx, id); err == nil {
		t.Fatal("the object row survived the reclamation, still holding storage quota")
	}
}

// NO RETROACTIVE PLAN CHANGE, in both directions. The snapshot is the room's,
// taken when it opened; a later upgrade or downgrade governs the NEXT room.
func TestAPlanChangeDoesNotReachBackwardsIntoAnExistingRoom(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()

	proPlan := Plan{ID: "pro", Name: "Pro", StorageBytes: 5 << 30,
		TrafficBytes: 100 << 30, RetentionSecs: 604800, DailyQuotaBytes: 34 << 30}
	freePlan := Plan{ID: "free", Name: "Free", StorageBytes: 100 << 20,
		TrafficBytes: 1 << 30, RetentionSecs: pairRoomFreeRetention}

	// Opened on Pro.
	h.setPlan(t, proPlan)
	h.mintCode("440007", "")
	idPro := h.preUpload(t, "440007", bytes.Repeat([]byte("O"), 1024), 1)
	h.join(t, "440007")
	proRoom := h.roomOf(t, idPro)
	if proRoom.RetentionSecs != 604800 {
		t.Fatalf("snapshot = %d, want Pro 604800", proRoom.RetentionSecs)
	}

	// The account downgrades to Free an hour later.
	h.advance(3600)
	h.setPlan(t, freePlan)

	// The existing room keeps every second it was entitled to. A live join back to
	// the account would have shortened it here from seven days to one, deleting a
	// customer's in-flight transfer six days early because they changed plan.
	again := h.roomOf(t, idPro)
	if again.RetentionSecs != 604800 || again.ExpiresAt != proRoom.ExpiresAt {
		t.Fatalf("the downgrade reached backwards: %d/%d, want %d/%d",
			again.RetentionSecs, again.ExpiresAt, proRoom.RetentionSecs, proRoom.ExpiresAt)
	}
	// The NEXT room opens on the plan the account actually holds now. Done before
	// the multi-day advance below, which outlives the harness session cookie.
	h.mintCode("440008", "")
	idFree := h.preUpload(t, "440008", bytes.Repeat([]byte("N"), 1024), 1)
	if got := h.roomOf(t, idFree).RetentionSecs; got != pairRoomFreeRetention {
		t.Fatalf("the room opened after the downgrade snapshot = %d, want %d", got, pairRoomFreeRetention)
	}

	// The upgrade direction is the same rule read the other way: the Free room
	// does not grow into Pro's window because the account upgrades afterwards.
	h.setPlan(t, proPlan)
	if got := h.roomOf(t, idFree).RetentionSecs; got != pairRoomFreeRetention {
		t.Fatalf("an upgrade reached backwards: snapshot = %d, want %d", got, pairRoomFreeRetention)
	}
	h.setPlan(t, freePlan)

	// Three days on — two days past the Free window the account now holds — the
	// ciphertext stored under Pro is still there. A live join back to the account
	// would have deleted it.
	h.advance(3 * 24 * 3600)
	h.svc.SweepPairRooms(ctx, h.now)
	if status, _ := h.getAnon(t, "/api/files/"+idPro+"/blob"); status != 200 {
		t.Fatalf("a downgrade deleted ciphertext stored under Pro: %d", status)
	}
	if got := h.roomOf(t, idPro).ExpiresAt; got != proRoom.ExpiresAt {
		t.Fatalf("the Pro room's deadline moved to %d, want %d", got, proRoom.ExpiresAt)
	}
}

// A plan read that FAILS falls open to the longest bounded window, never to the
// unbounded one this whole change exists to remove.
func TestAFailedPlanReadFallsOpenToABoundedWindow(t *testing.T) {
	h := newPairHarness(t)
	f := h.withFlakyStore(t)
	ctx := context.Background()

	// The plan read is down for good, so this cannot accidentally be answered by a
	// later successful retry.
	f.failNext("GetPlan", -1)
	if got := h.svc.pairRoomRetentionFor(ctx, h.userID); got != pairRoomMaxRetention {
		t.Fatalf("snapshot after a failed plan read = %d, want the longest bounded window %d",
			got, pairRoomMaxRetention)
	}
	// The point of the fallback is that it is BOUNDED, not that it is generous.
	// planRetentionCap's own "no cap" answer is 0, and 0 reaching a room is how the
	// unbounded object came back.
	if h.svc.planRetentionCap(ctx, h.userID) != 0 {
		t.Fatal("planRetentionCap no longer reports 0 for a failed read; this test proves nothing")
	}
	r := PairRoom{CreatedAt: h.now, LastUploadAt: h.now, JoinedAt: h.now,
		RetentionSecs: h.svc.pairRoomRetentionFor(ctx, h.userID)}
	if got := pairRoomExpiry(r); got != h.now+pairRoomMaxRetention {
		t.Fatalf("expiry = %d, want %d", got, h.now+pairRoomMaxRetention)
	}
	if pairRoomExpiry(r) == pairRoomLegacyNoDeadline {
		t.Fatal("a failed plan read produced an unbounded deadline")
	}
}

// The pure rule, exhaustively, with no database in the way: every snapshot a row
// could possibly carry lands inside the window the product sells.
func TestPairRoomRetentionIsAlwaysBounded(t *testing.T) {
	base := PairRoom{CreatedAt: 1_000_000, LastUploadAt: 1_000_000, JoinedAt: 1_000_500}
	for _, tc := range []struct {
		name string
		secs int64
		want int64
	}{
		{"no snapshot (a pre-migration row)", 0, pairRoomFreeRetention},
		{"negative, from a corrupted write", -5, pairRoomFreeRetention},
		{"an admin typo far below every plan", 3600, pairRoomFreeRetention},
		{"one second, from a corrupted write", 1, pairRoomFreeRetention},
		{"one second below Free, the boundary", pairRoomFreeRetention - 1, pairRoomFreeRetention},
		{"free", 86400, 86400},
		{"plus", 259200, 259200},
		{"pro", 604800, 604800},
		{"max", 1209600, 1209600},
		{"an admin typo far above every plan", 1 << 40, pairRoomMaxRetention},
		{"the retired sentinel itself", pairRoomLegacyNoDeadline, pairRoomMaxRetention},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := base
			r.RetentionSecs = tc.secs
			if got := pairRoomRetention(r); got != tc.want {
				t.Fatalf("retention = %d, want %d", got, tc.want)
			}
			expiry := pairRoomExpiry(r)
			if expiry == pairRoomLegacyNoDeadline {
				t.Fatal("expiry is the retired sentinel")
			}
			if expiry != r.JoinedAt+tc.want {
				t.Fatalf("expiry = %d, want %d", expiry, r.JoinedAt+tc.want)
			}
			// Joining may never move a room's deadline backwards, whatever the
			// snapshot says — room and objects are projected from this one number.
			unjoined := r
			unjoined.JoinedAt = 0
			if expiry < pairRoomExpiry(unjoined) {
				t.Fatalf("joining moved the deadline backwards: %d < %d",
					expiry, pairRoomExpiry(unjoined))
			}
		})
	}
}

// A joined room with no committed bytes yet is measured from the JOIN, not from
// zero. Without that floor its ciphertext would be born expired in 1970.
func TestAJoinedRoomWithNoProgressIsMeasuredFromTheJoin(t *testing.T) {
	r := PairRoom{CreatedAt: 1_000_000, LastUploadAt: 0, JoinedAt: 1_000_060, RetentionSecs: 86400}
	if got, want := pairRoomExpiry(r), int64(1_000_060+86400); got != want {
		t.Fatalf("expiry = %d, want %d", got, want)
	}
}

// ---------------------------------------------------------------------------
// The migration: repairing the rows the retired rule already wrote.
// ---------------------------------------------------------------------------

// legacyPairRoom puts a room and its objects back into the exact shape the old
// invariant left them in — no snapshot, and the sentinel on both the room and
// every object — and clears the migration marker so the backfill can run again.
//
// The upgrade path this models is the real one: the column arrives by ALTER with
// DEFAULT 0, so an existing row reads as "no snapshot" and keeps the deadline the
// old rule gave it until migratePairRoomRetention rewrites both.
func (h *pairHarness) legacyPairRoom(t *testing.T, roomID string) {
	t.Helper()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`UPDATE pair_rooms SET retention_secs = 0, expires_at = ? WHERE id = ?`,
			[]any{pairRoomLegacyNoDeadline, roomID}},
		{`UPDATE stored_files SET expires_at = ? WHERE pair_room_id = ?`,
			[]any{pairRoomLegacyNoDeadline, roomID}},
		{`DELETE FROM schema_migrations WHERE id = ?`,
			[]any{"backfill_pair_room_retention"}},
	} {
		if _, err := h.store.db.Exec(q.sql, q.args...); err != nil {
			t.Fatalf("legacy setup %q: %v", q.sql, err)
		}
	}
}

func (h *pairHarness) rawRoom(t *testing.T, roomID string) (retention, expires int64) {
	t.Helper()
	if err := h.store.db.QueryRow(
		`SELECT retention_secs, expires_at FROM pair_rooms WHERE id = ?`, roomID,
	).Scan(&retention, &expires); err != nil {
		t.Fatalf("read room: %v", err)
	}
	return retention, expires
}

// The defect itself, end to end: four Free objects at math.MaxInt64. After the
// migration the room and its object are bounded, the bound is the Free window
// measured from the join, and the existing GC backstop can finally see them.
func TestMigrationBoundsALegacyJoinedFreeRoom(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	h.mintCode("450001", "")
	id := h.preUpload(t, "450001", bytes.Repeat([]byte("L"), 1024), 1)
	h.join(t, "450001")
	room := h.roomOf(t, id)
	sf, err := h.store.GetStoredFile(ctx, id)
	if err != nil {
		t.Fatalf("stored file: %v", err)
	}

	h.legacyPairRoom(t, room.ID)
	if _, expires := h.rawRoom(t, room.ID); expires != pairRoomLegacyNoDeadline {
		t.Fatalf("the legacy setup did not take: %d", expires)
	}

	if err := migratePairRoomRetention(h.store.db); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	retention, expires := h.rawRoom(t, room.ID)
	if retention != pairRoomFreeRetention {
		t.Fatalf("backfilled snapshot = %d, want the Free window %d", retention, pairRoomFreeRetention)
	}
	if expires == pairRoomLegacyNoDeadline {
		t.Fatal("a legacy joined room is still unbounded after the migration")
	}
	if want := room.JoinedAt + pairRoomFreeRetention; expires != want {
		t.Fatalf("expiry = %d, want the join plus the Free window %d", expires, want)
	}
	// The object moved with the room. A migration that bounded the room and left
	// its ciphertext immortal would have fixed the row and not the defect.
	migrated, err := h.store.GetStoredFile(ctx, id)
	if err != nil {
		t.Fatalf("stored file after migrate: %v", err)
	}
	if migrated.ExpiresAt != expires {
		t.Fatalf("object expiry %d != room expiry %d", migrated.ExpiresAt, expires)
	}

	// ...and the room is now reachable by the reclamation that was already there.
	// Nothing in the migration deletes anything; this is the ordinary sweep.
	h.advance(pairRoomFreeRetention + 1)
	h.svc.SweepPairRooms(ctx, h.now)
	if r, found, _ := h.store.GetPairRoom(ctx, room.ID); found && r.ClosedAt == 0 {
		t.Fatal("a migrated legacy room was still not reclaimable")
	}
	if h.blobExists(t, sf.BlobKey) {
		t.Fatal("the migrated room's ciphertext survived its bounded deadline")
	}
}

// The backfill reads the owner's plan where the schema can answer accurately —
// users.plan_id joined to plans.retention_secs, two plain columns, no service
// call — so a paying account's existing room is not clamped to Free.
func TestMigrationBackfillsFromTheOwnersPlan(t *testing.T) {
	h := newPairHarness(t)
	h.setPlan(t, Plan{ID: "pro", Name: "Pro", StorageBytes: 5 << 30,
		TrafficBytes: 100 << 30, RetentionSecs: 604800, DailyQuotaBytes: 34 << 30})
	h.mintCode("450002", "")
	id := h.preUpload(t, "450002", bytes.Repeat([]byte("P"), 1024), 1)
	h.join(t, "450002")
	room := h.roomOf(t, id)

	h.legacyPairRoom(t, room.ID)
	if err := migratePairRoomRetention(h.store.db); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	retention, expires := h.rawRoom(t, room.ID)
	if retention != 604800 {
		t.Fatalf("backfilled snapshot = %d, want Pro 604800", retention)
	}
	if want := room.JoinedAt + 604800; expires != want {
		t.Fatalf("expiry = %d, want %d", expires, want)
	}
}

// Where the join CANNOT answer — a deleted user, a plan_id no longer in the
// plans table — the backfill takes the conservative Free default rather than
// inventing an entitlement or leaving the row unbounded.
func TestMigrationFallsBackToFreeWhenThePlanIsUnknown(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("450003", "")
	id := h.preUpload(t, "450003", bytes.Repeat([]byte("U"), 1024), 1)
	h.join(t, "450003")
	room := h.roomOf(t, id)

	h.legacyPairRoom(t, room.ID)
	if _, err := h.store.db.Exec(
		`UPDATE users SET plan_id = 'a-plan-that-no-longer-exists' WHERE id = ?`, h.userID); err != nil {
		t.Fatalf("orphan the plan: %v", err)
	}
	if err := migratePairRoomRetention(h.store.db); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	retention, expires := h.rawRoom(t, room.ID)
	if retention != pairRoomFreeRetention {
		t.Fatalf("snapshot = %d, want the Free default %d", retention, pairRoomFreeRetention)
	}
	if expires == pairRoomLegacyNoDeadline {
		t.Fatal("a room whose plan could not be resolved is still unbounded")
	}
}

// An absurd retention in the plans table cannot reintroduce an immortal object
// through the migration either. The clamp is on the write and on every read.
func TestMigrationClampsAnAbsurdPlanRetention(t *testing.T) {
	h := newPairHarness(t)
	h.setPlan(t, Plan{ID: "silly", Name: "Silly", StorageBytes: 5 << 30,
		TrafficBytes: 100 << 30, RetentionSecs: 1 << 40, DailyQuotaBytes: 34 << 30})
	h.mintCode("450004", "")
	id := h.preUpload(t, "450004", bytes.Repeat([]byte("S"), 1024), 1)
	h.join(t, "450004")
	room := h.roomOf(t, id)

	h.legacyPairRoom(t, room.ID)
	if err := migratePairRoomRetention(h.store.db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	retention, expires := h.rawRoom(t, room.ID)
	if retention != pairRoomMaxRetention {
		t.Fatalf("snapshot = %d, want the clamp %d", retention, pairRoomMaxRetention)
	}
	if want := room.JoinedAt + pairRoomMaxRetention; expires != want {
		t.Fatalf("expiry = %d, want %d", expires, want)
	}
}

// The mirror of the case above, and the one that LOSES data: a plans row typoed
// below the Free day. The ceiling alone would migrate 3600 onto every legacy
// room that account owns and delete even Free ciphertext an hour in — the exact
// early deletion this feature exists to prevent, arriving through the repair.
func TestMigrationFloorsAPlanRetentionBelowFree(t *testing.T) {
	h := newPairHarness(t)
	h.setPlan(t, Plan{ID: "typo", Name: "Typo", StorageBytes: 5 << 30,
		TrafficBytes: 100 << 30, RetentionSecs: 3600, DailyQuotaBytes: 34 << 30})
	h.mintCode("450008", "")
	id := h.preUpload(t, "450008", bytes.Repeat([]byte("T"), 1024), 1)
	h.join(t, "450008")
	room := h.roomOf(t, id)

	h.legacyPairRoom(t, room.ID)
	if err := migratePairRoomRetention(h.store.db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	retention, expires := h.rawRoom(t, room.ID)
	if retention != pairRoomFreeRetention {
		t.Fatalf("backfilled snapshot = %d, want the Free floor %d",
			retention, pairRoomFreeRetention)
	}
	if want := room.JoinedAt + pairRoomFreeRetention; expires != want {
		t.Fatalf("expiry = %d, want a full Free day %d", expires, want)
	}
	// The object moves with the room or the two disagree about the same bytes.
	var objExpires int64
	if err := h.store.db.QueryRow(
		`SELECT expires_at FROM stored_files WHERE id = ?`, id).Scan(&objExpires); err != nil {
		t.Fatalf("read object: %v", err)
	}
	if objExpires != expires {
		t.Fatalf("object expiry %d != room expiry %d", objExpires, expires)
	}
}

// A pair-room object whose room row is gone cannot be reached through the room
// loop, and one left at the sentinel would stay immortal with nothing that could
// ever bound it. It is measured from its own creation with the Free floor.
func TestMigrationBoundsAnOrphanedLegacyObject(t *testing.T) {
	h := newPairHarness(t)
	ctx := context.Background()
	h.mintCode("450005", "")
	id := h.preUpload(t, "450005", bytes.Repeat([]byte("O"), 1024), 1)
	h.join(t, "450005")
	room := h.roomOf(t, id)

	h.legacyPairRoom(t, room.ID)
	if _, err := h.store.db.Exec(`DELETE FROM pair_rooms WHERE id = ?`, room.ID); err != nil {
		t.Fatalf("orphan the object: %v", err)
	}
	if err := migratePairRoomRetention(h.store.db); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	sf, err := h.store.GetStoredFile(ctx, id)
	if err != nil {
		t.Fatalf("stored file: %v", err)
	}
	if sf.ExpiresAt == pairRoomLegacyNoDeadline {
		t.Fatal("an orphaned pair-room object is still unbounded")
	}
	if want := sf.CreatedAt + pairRoomFreeRetention; sf.ExpiresAt != want {
		t.Fatalf("orphan expiry = %d, want creation plus the Free window %d", sf.ExpiresAt, want)
	}
}

// The migration may move a sentinel row backwards and NOTHING else. A room whose
// deadline was legitimately earned — the ordinary post-fix case — must come out
// untouched, or the backfill is a second, unguarded mover of deadlines.
func TestMigrationLeavesLegitimateDeadlinesAlone(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("450006", "")
	id := h.preUpload(t, "450006", bytes.Repeat([]byte("K"), 1024), 1)
	h.join(t, "450006")
	room := h.roomOf(t, id)
	before, beforeExpiry := h.rawRoom(t, room.ID)

	if _, err := h.store.db.Exec(
		`DELETE FROM schema_migrations WHERE id = ?`, "backfill_pair_room_retention"); err != nil {
		t.Fatalf("clear marker: %v", err)
	}
	if err := migratePairRoomRetention(h.store.db); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	after, afterExpiry := h.rawRoom(t, room.ID)
	if after != before || afterExpiry != beforeExpiry {
		t.Fatalf("the migration touched a healthy room: %d/%d -> %d/%d",
			before, beforeExpiry, after, afterExpiry)
	}
}

// It runs exactly once, and running it again is a no-op. migrateOnce's marker is
// what makes the one backwards-moving write in the system unrepeatable.
func TestMigrationIsIdempotent(t *testing.T) {
	h := newPairHarness(t)
	h.mintCode("450007", "")
	id := h.preUpload(t, "450007", bytes.Repeat([]byte("I"), 1024), 1)
	h.join(t, "450007")
	room := h.roomOf(t, id)

	h.legacyPairRoom(t, room.ID)
	if err := migratePairRoomRetention(h.store.db); err != nil {
		t.Fatalf("first migrate: %v", err)
	}
	first, firstExpiry := h.rawRoom(t, room.ID)

	// A second call finds the marker and does nothing at all — including on a room
	// that has since moved on legitimately.
	if err := migratePairRoomRetention(h.store.db); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	second, secondExpiry := h.rawRoom(t, room.ID)
	if second != first || secondExpiry != firstExpiry {
		t.Fatalf("a repeat migration changed the room: %d/%d -> %d/%d",
			first, firstExpiry, second, secondExpiry)
	}
	var n int
	if err := h.store.db.QueryRow(
		`SELECT COUNT(*) FROM schema_migrations WHERE id = ?`,
		"backfill_pair_room_retention").Scan(&n); err != nil {
		t.Fatalf("marker: %v", err)
	}
	if n != 1 {
		t.Fatalf("migration marker count = %d, want exactly 1", n)
	}
}
