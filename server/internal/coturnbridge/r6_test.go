package coturnbridge

import (
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
)

// fakeClock is the bridge clock (Config.Now) under test control.
type fakeClock struct{ s atomic.Int64 }

func (c *fakeClock) now() time.Time { return time.Unix(c.s.Load(), 0) }
func (c *fakeClock) set(s int64)    { c.s.Store(s) }

// finalsLines returns the log lines about recent-finals eviction.
func finalsLines(h *harness) []string {
	var out []string
	for _, l := range strings.Split(h.logs.dump(), "\n") {
		if strings.Contains(l, "ALERT") && strings.Contains(l, "recent finals") {
			out = append(out, l)
		}
	}
	return out
}

// startFinals runs a bridge (shadow ledger, central up) on clock c with a
// recent-finals cap of 2.
func startFinals(t *testing.T, c *fakeClock) *harness {
	h := newHarness(t, account.CoturnMeteringShadow)
	h.startWith(func(cfg *Config) { cfg.RecentFinalsMax = 2; cfg.Now = c.now })
	h.eventually("subscription", h.subscribed)
	return h
}

// deliverFinals publishes n finals (sessions from..from+n-1) and waits until
// central has acknowledged them all through ReportOnce (spool empty).
func deliverFinals(h *harness, from, n int) {
	u := h.c.username("g1")
	for i := from; i < from+n; i++ {
		h.redis.publish(chan4(u, sid(i), "total_traffic"), counters(1, 0))
	}
	h.eventually("finals delivered", func() bool {
		for i := from; i < from+n; i++ {
			if !h.c.sawSession(sid(i)) {
				return false
			}
		}
		return len(h.b.Snapshot()) == 0 && recordFilesOnDisk(h.t, h.dir) == 0
	})
}

// R6 (Fable final-local finding, 100k run: 80000 eviction ALERT lines in
// 27 s): a burst of evictions at one clock second logs one line, not one per
// eviction. Old per-allocation logger: 198 lines for 200 finals with cap 2.
func TestRecentFinalsEvictionLogBounded(t *testing.T) {
	c := &fakeClock{}
	c.set(1000)
	h := startFinals(t, c)
	deliverFinals(h, 1, 200)
	time.Sleep(100 * time.Millisecond) // several flushes at the same clock second
	if n := len(finalsLines(h)); n != 1 {
		t.Fatalf("recent-finals eviction log not bounded: %d lines for 198 evictions at one clock second (want 1)", n)
	}
	st := h.b.Status()
	if !st.RecentFinalsTruncated || len(st.RecentFinals) != 2 {
		t.Fatalf("truncation state: %v %v", st.RecentFinalsTruncated, st.RecentFinals)
	}
	h.b.mu.Lock()
	until := h.b.truncatedUntil
	h.b.mu.Unlock()
	if until != 1000+forgetSecs {
		t.Fatalf("truncatedUntil %d, want %d", until, 1000+forgetSecs)
	}
	if why, final := drainSpoolReady(st, st); final || !strings.Contains(why, "truncated") {
		t.Fatalf("drain: %q %v", why, final)
	}
}

// The first eviction is reported at once; later ones are counted and reported
// together after 60 s — also when no further final arrives (idle flushes) —
// with the exact pending count; nothing more is logged once nothing is pending.
func TestRecentFinalsEvictionAggregatedTiming(t *testing.T) {
	c := &fakeClock{}
	c.set(1000)
	h := startFinals(t, c)
	deliverFinals(h, 1, 3) // 1 eviction: reported at once
	h.eventually("first line", func() bool { return len(finalsLines(h)) == 1 })
	if l := finalsLines(h)[0]; !strings.Contains(l, " 1 recent finals") {
		t.Fatalf("first line: %s", l)
	}
	deliverFinals(h, 4, 10) // 10 more evictions, same second: pending
	c.set(1059)
	time.Sleep(100 * time.Millisecond)
	if n := len(finalsLines(h)); n != 1 {
		t.Fatalf("%d lines at +59 s, want 1", n)
	}
	c.set(1060) // idle: no final arrives, a flush reports the pending count
	h.eventually("aggregate line", func() bool { return len(finalsLines(h)) == 2 })
	if l := finalsLines(h)[1]; !strings.Contains(l, " 10 recent finals") {
		t.Fatalf("aggregate line: %s", l)
	}
	c.set(1200)
	time.Sleep(100 * time.Millisecond)
	if n := len(finalsLines(h)); n != 2 {
		t.Fatalf("%d lines with nothing pending, want 2", n)
	}
	h.b.mu.Lock()
	until := h.b.truncatedUntil
	h.b.mu.Unlock()
	if until != 1000+forgetSecs { // the last eviction was at 1000
		t.Fatalf("truncatedUntil %d", until)
	}
}

// Clock at 0: the first eviction is still reported at once, and a burst at
// that second is still one line.
func TestRecentFinalsEvictionClockZero(t *testing.T) {
	c := &fakeClock{}
	c.set(1) // the harness's subscribed check needs a non-zero barrier time
	h := startFinals(t, c)
	c.set(0) // every eviction happens at clock 0
	deliverFinals(h, 1, 50)
	h.eventually("first line at clock 0", func() bool { return len(finalsLines(h)) >= 1 })
	time.Sleep(100 * time.Millisecond)
	if n := len(finalsLines(h)); n != 1 {
		t.Fatalf("%d lines for 48 evictions at clock 0, want 1", n)
	}
}

// A clock that goes back does not turn every eviction into a line, and the
// pending count is still reported 60 s (by the new clock) later.
func TestRecentFinalsEvictionClockBackwards(t *testing.T) {
	c := &fakeClock{}
	c.set(1000)
	h := startFinals(t, c)
	deliverFinals(h, 1, 3)
	h.eventually("first line", func() bool { return len(finalsLines(h)) == 1 })
	c.set(500)
	deliverFinals(h, 4, 20)
	time.Sleep(100 * time.Millisecond)
	if n := len(finalsLines(h)); n != 1 {
		t.Fatalf("%d lines after the clock went back, want 1 (no per-eviction lines)", n)
	}
	c.set(559)
	time.Sleep(100 * time.Millisecond)
	if n := len(finalsLines(h)); n != 1 {
		t.Fatalf("%d lines 59 s after the clock went back, want 1", n)
	}
	c.set(560)
	h.eventually("pending reported 60 s after the clock went back", func() bool { return len(finalsLines(h)) == 2 })
	if l := finalsLines(h)[1]; !strings.Contains(l, " 20 recent finals") {
		t.Fatalf("aggregate after the clock went back: %s", l)
	}
	h.b.mu.Lock()
	until := h.b.truncatedUntil
	h.b.mu.Unlock()
	if until != 500+forgetSecs {
		t.Fatalf("truncatedUntil %d, want %d (unchanged semantics: last eviction + 600)", until, 500+forgetSecs)
	}
}
