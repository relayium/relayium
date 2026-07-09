package account

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
)

// TestRegisterConcurrentCanonicalCollisionExactlyOneWins reproduces the H2b
// TOCTOU race: N goroutines concurrently register distinct literal addresses
// that all canonicalize to the same Gmail mailbox (a+tagN@gmail.com folds to
// a@gmail.com for every N). Before InsertUserDedupedByCanonical made the
// check-then-insert atomic, a separate UserByCanonicalEmail check followed by
// UpsertUserByEmail let multiple goroutines all observe "not taken" before
// any of them inserted, so several registrations succeeded for what should be
// one Sybil-proof mailbox. Exactly one must now succeed; the rest must get
// ErrEmailTaken.
func TestRegisterConcurrentCanonicalCollisionExactlyOneWins(t *testing.T) {
	svc := newPwService(t)
	ctx := context.Background()

	const n = 20
	var wg sync.WaitGroup
	results := make([]error, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start // release all goroutines together to maximize overlap
			email := fmt.Sprintf("a+tag%c@gmail.com", 'a'+i)
			_, err := svc.Register(ctx, email, "longenough1", "")
			results[i] = err
		}(i)
	}
	close(start)
	wg.Wait()

	succeeded, taken, other := 0, 0, 0
	for _, err := range results {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrEmailTaken):
			taken++
		default:
			other++
			t.Errorf("unexpected error: %v", err)
		}
	}
	if succeeded != 1 {
		t.Fatalf("succeeded = %d, want exactly 1 (taken=%d, other=%d)", succeeded, taken, other)
	}
	if taken != n-1 {
		t.Fatalf("taken = %d, want %d", taken, n-1)
	}
}
