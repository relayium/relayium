package signal

import "testing"

func TestIPConnLimiterCapsPerIP(t *testing.T) {
	l := NewIPConnLimiter()
	for i := 0; i < maxConnsPerIP; i++ {
		if !l.Acquire("1.2.3.4") {
			t.Fatalf("acquire %d under cap should succeed", i)
		}
	}
	if l.Acquire("1.2.3.4") {
		t.Fatal("acquire past the per-IP cap must fail")
	}
	// Releasing frees a slot.
	l.Release("1.2.3.4")
	if !l.Acquire("1.2.3.4") {
		t.Fatal("after a release a new acquire should succeed")
	}
}

func TestIPConnLimiterPerIPIsolation(t *testing.T) {
	l := NewIPConnLimiter()
	for i := 0; i < maxConnsPerIP; i++ {
		l.Acquire("1.1.1.1")
	}
	if !l.Acquire("2.2.2.2") {
		t.Fatal("a different IP must have its own independent budget")
	}
}

func TestIPConnLimiterPrunesEmptyEntries(t *testing.T) {
	l := NewIPConnLimiter()
	l.Acquire("9.9.9.9")
	l.Release("9.9.9.9")
	if _, ok := l.n["9.9.9.9"]; ok {
		t.Fatal("fully-released IP must be pruned from the map")
	}
}
