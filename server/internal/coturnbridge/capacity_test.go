package coturnbridge

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/account"
)

// C1 (pre-registered oracle): eight allocations close (coturn's final seen,
// no further counters will ever come) while central is down and the primary
// spool holds five. The bridge stops and a new process starts on the same
// directory with central back: every final is billed exactly once. Before
// the overflow tier the three allocations past the cap lived only in memory
// and were lost with the process (billed 15015 of 36036).
func TestColdKillOverflowNoFutureCounters(t *testing.T) {
	h := newHarness(t, account.CoturnMeteringBillable)
	h.c.mode.Store("down")
	h.startWith(func(c *Config) { c.SpoolMaxEntries = 5 })
	h.eventually("subscription", h.subscribed)
	u := h.c.username("g1")
	var want int64
	for i := 1; i <= 8; i++ {
		sid := fmt.Sprintf("0070000000000000%02d", i)
		h.born(u, sid)
		h.redis.publish(chan4(u, sid, "total_traffic"), counters(uint64(1001*i), 0))
		want += int64(1001 * i)
	}
	h.eventually("eight tracked", func() bool { return len(h.b.Snapshot()) == 8 })
	h.halt() // the process ends; nothing is kept but what is on disk

	h.c.mode.Store("")
	h.startWith(func(c *Config) { c.SpoolMaxEntries = 5 })
	h.eventually("everything loaded is settled", func() bool { return h.b.Status().LastReportOK > 0 && len(h.b.Snapshot()) == 0 })
	if got := h.c.billed(); got != want {
		t.Fatalf("billed %d, want %d", got, want)
	}
	if st := h.b.Status(); st.DeadLettered != 0 {
		t.Fatalf("dead letters: %+v", st)
	}
}

// C2 (pre-registered oracle): quarantine evidence never grows past its cap,
// not even by one line.
func TestQuarantineExactCap(t *testing.T) {
	dir := t.TempDir()
	sp := &Spool{Dir: dir, MaxEntries: 10, MaxBytes: 64 << 10}
	if err := sp.Open(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeSpool(sp) })
	rec := map[string]string{"reason": strings.Repeat("x", 100)}
	line, _ := json.Marshal(rec)
	n := int64(len(line) + 1)
	max := 2*n + n/2
	for i := range 3 {
		err := sp.AppendQuarantine(rec, max)
		if i < 2 && err != nil {
			t.Fatalf("line %d refused: %v", i, err)
		}
	}
	fi, err := os.Stat(filepath.Join(dir, "quarantine.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Size() > max {
		t.Fatalf("size %d exceeds max %d", fi.Size(), max)
	}
}
