package signal

import (
	"testing"
	"time"
)

func TestConnLimiterByteBudget(t *testing.T) {
	now := time.Unix(0, 0)
	l := newConnLimiter(func() time.Time { return now })
	const half = 512 * 1024
	if ok, _ := l.admit(half); !ok {
		t.Fatal("first 512 KiB should pass")
	}
	if ok, _ := l.admit(half); !ok {
		t.Fatal("second 512 KiB (=1 MiB exactly) should pass")
	}
	ok, reason := l.admit(1)
	if ok || reason != "signal budget exceeded" {
		t.Fatalf("over-budget frame must be refused, got ok=%v reason=%q", ok, reason)
	}
}

func TestConnLimiterRateBurst(t *testing.T) {
	now := time.Unix(0, 0)
	l := newConnLimiter(func() time.Time { return now })
	for i := 0; i < signalBurst; i++ {
		if ok, _ := l.admit(1); !ok {
			t.Fatalf("admit %d within burst should pass", i)
		}
	}
	ok, reason := l.admit(1)
	if ok || reason != "signal rate exceeded" {
		t.Fatalf("admit past burst at same instant must be rate-refused, got ok=%v reason=%q", ok, reason)
	}
}

func TestConnLimiterRefillsOverTime(t *testing.T) {
	now := time.Unix(0, 0)
	l := newConnLimiter(func() time.Time { return now })
	for i := 0; i < signalBurst; i++ {
		l.admit(1)
	}
	if ok, _ := l.admit(1); ok {
		t.Fatal("bucket should be empty at the same instant")
	}
	now = now.Add(time.Second) // +10 tokens
	if ok, _ := l.admit(1); !ok {
		t.Fatal("after 1s refill an admit should pass again")
	}
}

func TestConnLimiterNormalTrafficPasses(t *testing.T) {
	now := time.Unix(0, 0)
	l := newConnLimiter(func() time.Time { return now })
	for i := 0; i < 200; i++ {
		now = now.Add(200 * time.Millisecond) // 5 frames/s, well under refill; bytes stay tiny
		if ok, reason := l.admit(2000); !ok {
			t.Fatalf("normal small frame %d refused: %q", i, reason)
		}
	}
}
