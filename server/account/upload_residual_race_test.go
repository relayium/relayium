package account

// Real concurrency (goroutines behind one start barrier; meant for -race)
// between finalize, the cleanup producers, a pair room's void, GC drains and
// object deletion, on a real SQLite store, real handlers and a real node over
// HTTP. Whatever the interleaving, a residual has exactly one owner, is billed
// exactly once, and a refused or cleaned-up finalize never produces an object.

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"
)

// A finalize crashed after its terminal claim with a residual. Six actors race:
// the reaper, the set-based purge, a direct cleanup claim, two full GC sweeps
// and a client finalize retry. Every round ends with exactly 4200 billed, no
// object, no session, no blob, and the retry never answers 200.
func TestARacedResidualCleanupBillsExactlyOnce(t *testing.T) {
	const rounds = 12
	ctx := context.Background()
	for round := 0; round < rounds; round++ {
		h := newPairHarness(t)
		id, node, sess := stageResidual(t, h, false)
		claimDone(t, h, id)
		node.heal()
		h.advance(pendingUploadTTL + 1)
		now := h.now
		var start, wg sync.WaitGroup
		start.Add(1)
		var retryCode int
		actors := []func(){
			func() { h.svc.ReapPendingUploads(now) },
			func() { _ = h.store.PurgeDoneUploadSessions(ctx, now-pendingUploadTTL, now) },
			func() { _, _, _, _ = h.store.ClaimUploadSessionCleanup(ctx, id, now-pendingUploadTTL, now) },
			func() { gcSweep(h) },
			func() { gcSweep(h) },
			func() { retryCode, _ = finalizeHTTP(h, id) },
		}
		for _, a := range actors {
			wg.Add(1)
			go func(f func()) { defer wg.Done(); start.Wait(); f() }(a)
		}
		start.Done()
		wg.Wait()
		gcSweep(h)
		gcSweep(h)
		if retryCode == http.StatusOK {
			t.Errorf("RESURRECTION round %d: a finalize retry of a crashed, cleaned-up upload answered 200", round)
		}
		if got := h.uploadMetered(t); got != residualOnNode {
			t.Errorf("EXACTLY-ONCE round %d: metered %d, want exactly %d", round, got, residualOnNode)
		}
		if n := storedObjectsOn(t, h, sess.BlobKey); n != 0 {
			t.Errorf("RESURRECTION round %d: %d stored object(s) on the cleaned-up blob", round, n)
		}
		if h.sessionExists(t, id) {
			t.Errorf("CLEANUP round %d: the session survived", round)
		}
		if nodeBlobPresent(t, node.dir, sess.BlobKey) {
			t.Errorf("CLEANUP round %d: the blob survived", round)
		}
		if code, _ := finalizeHTTP(h, id); code != http.StatusNotFound {
			t.Errorf("TOMBSTONE round %d: finalize after cleanup %d, want 404", round, code)
		}
	}
}

// A LIVE finalize races the cleanup producers (driven as if it had stalled past
// the idle TTL: idleBefore in the future), two GC drains and the owner deleting
// the object the moment it appears. The node holds 4200, central recorded 1200.
// The allowed outcomes, per round:
//   - the finalize persisted its object: the 3000-byte residual is the
//     documented live-finalize residual and is NEVER billed (1200), and while
//     the object exists cleanup never destroys its blob;
//   - cleanup took the session first: the finalize is refused (5xx), no object
//     exists, and the residual is billed exactly once (4200).
//
// Nothing else, and never more than 4200.
func TestALiveFinalizeRacingCleanupAndDeleteNeverDoubleChargesOrResurrects(t *testing.T) {
	const rounds = 16
	ctx := context.Background()
	var persistedWins, cleanupWins int
	for round := 0; round < rounds; round++ {
		h := newPairHarness(t)
		id, node, sess := stageResidual(t, h, false)
		node.heal()
		now := h.now
		future := now + 10
		var start, wg sync.WaitGroup
		start.Add(1)
		stop := make(chan struct{})
		loop := func(f func()) func() {
			return func() {
				for {
					select {
					case <-stop:
						return
					default:
						f()
					}
				}
			}
		}
		actors := []func(){
			loop(func() { _, _, _, _ = h.store.ClaimUploadSessionCleanup(ctx, id, future, now) }),
			loop(func() { _ = h.store.PurgeDoneUploadSessions(ctx, future, now) }),
			loop(func() { gcSweep(h) }),
			loop(func() {
				var fid string
				if err := h.store.db.QueryRow(`SELECT id FROM stored_files WHERE blob_key = ?`, sess.BlobKey).Scan(&fid); err == nil {
					_ = deleteFileHTTP(h, fid)
				}
			}),
		}
		// Stagger: the other actors start 0..15 ms after the finalize, so the
		// rounds land on both sides of its claim->persist window.
		delay := time.Duration(round) * time.Millisecond
		for _, a := range actors {
			wg.Add(1)
			go func(f func()) { defer wg.Done(); start.Wait(); time.Sleep(delay); f() }(a)
		}
		var finCode int
		var finID string
		var fin sync.WaitGroup
		fin.Add(1)
		go func() { defer fin.Done(); start.Wait(); finCode, finID = finalizeHTTP(h, id) }()
		start.Done()
		fin.Wait()
		for i := 0; i < 3; i++ {
			gcSweep(h)
		}
		close(stop)
		wg.Wait()
		gcSweep(h)
		gcSweep(h)
		got := h.uploadMetered(t)
		objects := storedObjectsOn(t, h, sess.BlobKey)
		switch {
		case finCode == http.StatusOK && finID != "":
			persistedWins++
			if got != residualAcked {
				t.Errorf("POLICY round %d: the object persisted and metered %d, want %d (a live-finalize residual is never billed)", round, got, residualAcked)
			}
			if objects != 0 && !nodeBlobPresent(t, node.dir, sess.BlobKey) {
				t.Errorf("DESTROYED round %d: cleanup deleted a live object's blob", round)
			}
		case finCode >= 500:
			cleanupWins++
			if objects != 0 {
				t.Errorf("RESURRECTION round %d: a refused finalize left %d object(s)", round, objects)
			}
			if got != residualOnNode {
				t.Errorf("EXACTLY-ONCE round %d: cleanup won and metered %d, want exactly %d", round, got, residualOnNode)
			}
			if nodeBlobPresent(t, node.dir, sess.BlobKey) {
				t.Errorf("CLEANUP round %d: the blob survived", round)
			}
		default:
			t.Errorf("OUTCOME round %d: finalize answered %d (id %q)", round, finCode, finID)
		}
		if got > residualOnNode {
			t.Errorf("DOUBLE-CHARGE round %d: metered %d > %d", round, got, residualOnNode)
		}
	}
	t.Logf("outcomes: persisted=%d cleanup-first=%d", persistedWins, cleanupWins)
}

// The orphan cleanup claim and a pair room's close race on one crashed
// finalize tombstone with a residual — both orders forced, then concurrent
// rounds. Exactly one owner, one obligation at the acknowledged floor, and
// after the drain exactly what the node holds.
func TestTheVoidAndTheOrphanClaimGiveAResidualOneOwner(t *testing.T) {
	ctx := context.Background()
	var claimWins, closeWins int
	for i := 0; i < 12; i++ {
		order := 0 // concurrent
		if i < 2 {
			order = 1 // claim, then close
		} else if i < 4 {
			order = 2 // close, then claim
		}
		h := newPairHarness(t)
		id, node, known, onNode := unreachableAfterCommit(t, h, fmt.Sprintf("39%04d", i))
		claimDone(t, h, id)
		sess := h.session(t, id)
		var ok bool
		var claimErr, closeErr error
		var wg sync.WaitGroup
		start := make(chan struct{})
		claimStart, closeStart := start, start
		if order != 0 {
			claimStart, closeStart = make(chan struct{}), make(chan struct{})
		}
		claimDoneCh, closeDoneCh := make(chan struct{}), make(chan struct{})
		wg.Add(2)
		go func() {
			defer wg.Done()
			defer close(claimDoneCh)
			<-claimStart
			_, _, ok, claimErr = h.store.ClaimUploadSessionCleanup(ctx, sess.ID, h.now, h.now)
		}()
		go func() {
			defer wg.Done()
			defer close(closeDoneCh)
			<-closeStart
			_, closeErr = h.store.ClosePairRoom(ctx, sess.PairRoomID, h.now, h.now+pairRoomBlobHold)
		}()
		switch order {
		case 0:
			close(start)
		case 1:
			close(claimStart)
			<-claimDoneCh
			close(closeStart)
		case 2:
			close(closeStart)
			<-closeDoneCh
			close(claimStart)
		}
		wg.Wait()
		if claimErr != nil || closeErr != nil {
			t.Fatalf("round %d: claim err %v, close err %v", i, claimErr, closeErr)
		}
		if ok {
			claimWins++
		} else {
			closeWins++
		}
		q := queuedFor(t, h, sess.BlobKey)
		if len(q) != 1 || q[0].BillUserID != h.userID || q[0].BilledThrough != known {
			t.Errorf("OWNERSHIP round %d (order %d, claim won=%v): queue %+v, want one obligation at floor %d", i, order, ok, q, known)
		}
		node.heal()
		h.advance(pairRoomBlobHold + 1)
		gcSweep(h)
		gcSweep(h)
		if got := h.uploadMetered(t); got != onNode {
			t.Errorf("ACCOUNTING round %d (order %d, claim won=%v): metered %d, want exactly %d", i, order, ok, got, onNode)
		}
	}
	if claimWins == 0 || closeWins == 0 {
		t.Errorf("the forced orders did not both happen: claim won %d, close won %d", claimWins, closeWins)
	}
}
