package account

import (
	"context"
	"errors"
	"io"
	"log"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/storage"
)

// setHook installs a settle seam for one test and removes it afterwards.
func setHook(t *testing.T, hook *func(context.Context) error, fn func(context.Context) error) {
	t.Helper()
	*hook = fn
	t.Cleanup(func() { *hook = nil })
}

var errSeam = errors.New("injected at settle seam")

// Deterministic point (a): after the meter write, before the floor moves. A
// cancellation or failure there must roll the meter write back with the
// transaction, and the next settle must bill the residual exactly once. The
// hook's `fired` flag proves the point was actually reached.
func TestSettleBlobBillingAbortedBetweenMeterAndFloorBillsExactlyOnce(t *testing.T) {
	for _, mode := range []string{"cancel", "fail"} {
		t.Run(mode, func(t *testing.T) {
			st := newTestStore(t)
			bg := context.Background()
			u, _ := st.UpsertUserByEmail(bg, "seam-a-"+mode+"@example.com", "")
			const key = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a"
			if err := enqueueBilledNodeDeleteOn(bg, st.db, key, "", 100, 0, u.ID, MeterUpload, 10000, 1200); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(bg)
			defer cancel()
			fired := false
			setHook(t, &settleBlobAfterMeterHook, func(context.Context) error {
				fired = true
				if mode == "cancel" {
					cancel()
					return nil
				}
				return errSeam
			})
			if _, err := st.SettleBlobBilling(ctx, key, "", 4200, 100); err == nil {
				t.Fatal("the aborted settle reported success")
			}
			if !fired {
				t.Fatal("the seam between the meter write and the floor update never fired")
			}
			p, ok := pendingRow(t, st, key, "")
			if got := gcMeteredUpload(t, st, u.ID); got != 0 || !ok || p.BilledThrough != 1200 {
				t.Fatalf("after the abort: metered=%d floor=%d queued=%v, want 0 / 1200 / true (rolled back)", got, p.BilledThrough, ok)
			}
			settleBlobAfterMeterHook = nil
			for i := 0; i < 2; i++ {
				if _, err := st.SettleBlobBilling(bg, key, "", 4200, 100); err != nil {
					t.Fatal(err)
				}
			}
			if got := gcMeteredUpload(t, st, u.ID); got != 3000 {
				t.Fatalf("metered %d after the retries, want exactly 3000", got)
			}
		})
	}
}

// Deterministic point (b): an owed bill claimed (its row deleted inside the
// transaction) but not yet metered. Aborting there must put the claim back, and
// the next GC pass must bill it exactly once.
func TestSettleOwedBillsAbortedBetweenClaimAndMeterBillsExactlyOnce(t *testing.T) {
	for _, mode := range []string{"cancel", "fail"} {
		t.Run(mode, func(t *testing.T) {
			st := newTestStore(t)
			bg := context.Background()
			u, _ := st.UpsertUserByEmail(bg, "seam-b-"+mode+"@example.com", "")
			for _, b := range []int64{500, 700} {
				if err := st.EnqueueUnbilledMeter(bg, UnbilledMeter{UserID: u.ID, Kind: MeterUpload, Bytes: b, At: 100, Reason: "seam"}); err != nil {
					t.Fatal(err)
				}
			}
			g := &GC{Store: st, Now: func() int64 { return 100 }, Log: log.New(io.Discard, "", 0)}
			ctx, cancel := context.WithCancel(bg)
			defer cancel()
			fired := 0
			setHook(t, &settleOwedAfterClaimHook, func(context.Context) error {
				fired++
				if fired > 1 {
					return nil // only the first claim is aborted
				}
				if mode == "cancel" {
					cancel()
					return nil
				}
				return errSeam
			})
			g.settleOwedBills(ctx)
			if fired == 0 {
				t.Fatal("the seam between the claim and the meter write never fired")
			}
			var left, leftBytes int64
			if err := st.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(bytes),0) FROM unbilled_meter WHERE user_id = ?`, u.ID).Scan(&left, &leftBytes); err != nil {
				t.Fatal(err)
			}
			got := gcMeteredUpload(t, st, u.ID)
			if left == 0 || got+leftBytes != 1200 {
				t.Fatalf("after the abort: metered=%d still owed=%d (rows %d), want the aborted claim back and nothing lost or doubled", got, leftBytes, left)
			}
			settleOwedAfterClaimHook = nil
			g.settleOwedBills(bg)
			g.settleOwedBills(bg)
			if got := gcMeteredUpload(t, st, u.ID); got != 1200 {
				t.Fatalf("metered %d after the retries, want exactly 1200", got)
			}
		})
	}
}

// A row whose blob delete landed but whose own DELETE failed stays queued, and
// is moved to the back — like every other row an attempt leaves in place —
// instead of keeping its old place. B (on a node that is down) is queued
// first and A second; after one drain both are still queued, and A, whose
// clear failed AFTER B was moved back, must now be behind B.
func TestAQueueRowWhoseClearFailsGoesToTheBack(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	disk, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const a, b = "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a", "1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b"
	if _, err := disk.Put(ctx, a, strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	if err := enqueueNodeDeleteOn(ctx, st.db, b, "down", 100, 0); err != nil {
		t.Fatal(err)
	}
	if err := enqueueNodeDeleteOn(ctx, st.db, a, "", 100, 0); err != nil {
		t.Fatal(err)
	}
	flaky := newFlakyStore(st)
	flaky.failNext("DeletePendingNodeDelete", 1)
	blobFor := func(_ context.Context, nodeID string) (storage.BlobStore, error) {
		if nodeID == "" {
			return disk, nil
		}
		return nil, errors.New("node down")
	}
	g := &GC{Store: flaky, BlobFor: blobFor, Now: func() int64 { return 1000 }, Log: log.New(io.Discard, "", 0)}
	order := func() []string {
		all, err := st.ListPendingNodeDeletes(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, p := range all {
			out = append(out, p.BlobKey)
		}
		return out
	}
	if o := order(); len(o) != 2 || o[0] != b {
		t.Fatalf("initial order %v, want %s first", o, b)
	}
	g.drainPending(ctx)
	if flaky.callCount("DeletePendingNodeDelete") != 1 {
		t.Fatal("the clear was never attempted")
	}
	if _, err := disk.Get(ctx, a); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("A's blob delete did not land: %v", err)
	}
	if o := order(); len(o) != 2 || o[0] != b || o[1] != a {
		t.Fatalf("retry order after the failed clear = %v, want [%s %s]: the row whose clear failed kept its old place", o, b, a)
	}
	g.drainPending(ctx)
	if o := order(); len(o) != 1 || o[0] != b {
		t.Fatalf("queue after the next drain = %v, want only the down node's %s", o, b)
	}
}
