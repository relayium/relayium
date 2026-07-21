package account

import (
	"context"
	"fmt"
	"sync"
	"testing"
)

// The owner storage cap must hold under concurrency: N uploads racing at persist
// time must not collectively exceed the cap. Regression for the check-then-write
// race where each concurrent upload read the same pre-commit total and all
// committed (10×1GiB landing on a 1GiB plan).
func TestCreateStoredFileWithinStorageCapsIsAtomic(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "cap@example.com", "C")

	const cap = 1000
	const each = 300 // only 3 of these fit under the cap (3*300=900, a 4th busts it)
	const n = 12
	now := int64(1_800_000_000)

	var wg sync.WaitGroup
	var mu sync.Mutex
	accepted := 0
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			f := StoredFile{
				ID: fmt.Sprintf("f%d", i), UserID: u.ID, BlobKey: fmt.Sprintf("b%d", i),
				EncManifest: []byte("m"), Size: each, CreatedAt: now, ExpiresAt: now + 10000,
			}
			ok, reason, err := st.CreateStoredFileWithinStorageCaps(ctx, f, now, cap, 0)
			if err != nil {
				t.Errorf("unexpected err: %v", err)
				return
			}
			if ok {
				mu.Lock()
				accepted++
				mu.Unlock()
			} else if reason != "storage" {
				t.Errorf("reject reason: want storage, got %q", reason)
			}
		}(i)
	}
	wg.Wait()

	if accepted != 3 {
		t.Fatalf("want exactly 3 uploads accepted under a %d cap at %d each, got %d", cap, each, accepted)
	}
	used, err := st.CurrentStorage(ctx, u.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	if used > cap {
		t.Fatalf("SECURITY: live storage %d exceeds cap %d after concurrent uploads", used, cap)
	}
	if used != 900 {
		t.Fatalf("want 900 bytes stored, got %d", used)
	}
}

// The global disk cap is enforced the same way and reported as reason "global".
func TestCreateStoredFileWithinStorageCapsGlobal(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "g@example.com", "G")
	now := int64(1_800_000_000)

	// userCap unlimited (0), globalCap 500. First 200 fits, second 400 busts global.
	ok, _, err := st.CreateStoredFileWithinStorageCaps(ctx,
		StoredFile{ID: "a", UserID: u.ID, BlobKey: "ba", EncManifest: []byte("m"), Size: 200, CreatedAt: now, ExpiresAt: now + 10000},
		now, 0, 500)
	if err != nil || !ok {
		t.Fatalf("first insert: ok=%v err=%v", ok, err)
	}
	ok, reason, err := st.CreateStoredFileWithinStorageCaps(ctx,
		StoredFile{ID: "b", UserID: u.ID, BlobKey: "bb", EncManifest: []byte("m"), Size: 400, CreatedAt: now, ExpiresAt: now + 10000},
		now, 0, 500)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("second insert should have been rejected by the global cap")
	}
	if reason != "global" {
		t.Fatalf("reason: want global, got %q", reason)
	}
}
