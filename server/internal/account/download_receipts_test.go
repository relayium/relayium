package account

import (
	"context"
	"testing"
)

// ClaimDownloadReceipt is idempotent: the first claim of a nonce succeeds, a
// repeat fails — so reconciliation refunds exactly once.
func TestClaimDownloadReceiptIdempotent(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	if first, err := st.ClaimDownloadReceipt(ctx, "nonceA", 1000); err != nil || !first {
		t.Fatalf("first claim: first=%v err=%v, want true/nil", first, err)
	}
	if first, err := st.ClaimDownloadReceipt(ctx, "nonceA", 1001); err != nil || first {
		t.Fatalf("repeat claim: first=%v err=%v, want false/nil", first, err)
	}
}

// PruneDownloadReceipts removes rows older than the cutoff (freeing the nonce to
// be claimed again) but keeps recent ones (so a duplicate can't double-refund).
func TestPruneDownloadReceipts(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	st.ClaimDownloadReceipt(ctx, "old", 1000)
	st.ClaimDownloadReceipt(ctx, "recent", 5000)

	if err := st.PruneDownloadReceipts(ctx, 3000); err != nil {
		t.Fatalf("prune: %v", err)
	}
	// "old" (at=1000 < 3000) was pruned → claiming it again is a fresh first.
	if first, _ := st.ClaimDownloadReceipt(ctx, "old", 6000); !first {
		t.Fatal("pruned nonce must be claimable again")
	}
	// "recent" (at=5000 >= 3000) survived → still a duplicate.
	if first, _ := st.ClaimDownloadReceipt(ctx, "recent", 6000); first {
		t.Fatal("recent nonce must NOT have been pruned")
	}
}
