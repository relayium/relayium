package account

import (
	"sync"
	"sync/atomic"
	"testing"
)

func TestUploadSemAcquireReleaseAndCap(t *testing.T) {
	s := newUploadSem(5)
	for i := 0; i < 5; i++ {
		if !s.acquire("u1") {
			t.Fatalf("acquire #%d for u1 should succeed", i+1)
		}
	}
	if s.acquire("u1") {
		t.Fatal("6th acquire for u1 should fail (at max)")
	}
	s.release("u1")
	if !s.acquire("u1") {
		t.Fatal("acquire after release should succeed")
	}
}

func TestUploadSemIsolatesAccounts(t *testing.T) {
	s := newUploadSem(5)
	for i := 0; i < 5; i++ {
		if !s.acquire("u1") {
			t.Fatalf("acquire #%d for u1 should succeed", i+1)
		}
	}
	if !s.acquire("u2") {
		t.Fatal("u2 should be unaffected by u1 being at max")
	}
}

func TestUploadSemPrunesAtZero(t *testing.T) {
	s := newUploadSem(5)
	s.acquire("u3")
	s.release("u3")
	if len(s.inflight) != 0 {
		t.Fatalf("expected inflight map entry pruned at zero, got len=%d", len(s.inflight))
	}
}

// TestUploadSemConcurrent hammers a single key from many goroutines with the
// real sync.Mutex and asserts the observed concurrent holder count never
// exceeds max, and settles back to zero. Run with -race.
func TestUploadSemConcurrent(t *testing.T) {
	s := newUploadSem(5)
	const n = 50
	const key = "cu"

	var current int64 // number of goroutines currently holding a slot
	var peak int64

	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			for {
				if s.acquire(key) {
					break
				}
			}
			cur := atomic.AddInt64(&current, 1)
			for {
				p := atomic.LoadInt64(&peak)
				if cur <= p || atomic.CompareAndSwapInt64(&peak, p, cur) {
					break
				}
			}
			atomic.AddInt64(&current, -1)
			s.release(key)
		}()
	}
	wg.Wait()

	if peak > maxConcurrentUploadsPerUser {
		t.Fatalf("observed peak concurrency %d exceeds max %d", peak, maxConcurrentUploadsPerUser)
	}

	s.mu.Lock()
	remaining := s.inflight[key]
	s.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("expected 0 inflight after all goroutines finished, got %d", remaining)
	}
}
