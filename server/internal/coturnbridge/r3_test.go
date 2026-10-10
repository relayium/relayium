package coturnbridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/relayium/relayium/account"
)

// allocated returns the bytes allocated while f runs.
func allocated(f func()) uint64 {
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	f()
	runtime.ReadMemStats(&after)
	return after.TotalAlloc - before.TotalAlloc
}

// sparse creates a sparse file of n bytes.
func sparse(t *testing.T, p string, n int64) {
	t.Helper()
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(n); err != nil {
		t.Fatal(err)
	}
	f.Close()
}

// ---- C1: FIFO queue truly bounded ------------------------------------------

// Root R3 RED (copied assertion): one key added 10000 times in the same
// second left 10000 queue entries for a set of max 1.
func TestFifoRepeatedSameKeySameSecondBounded(t *testing.T) {
	s := newFifoSet[string](1)
	for range 10000 {
		s.Add("same", 100)
	}
	if s.Len() != 1 || len(s.q) > 66 {
		t.Fatalf("FIFO boundedness violated: configured1 map%d queue%d", s.Len(), len(s.q))
	}
	if s.evicted != 0 {
		t.Fatalf("a refresh evicted %d", s.evicted)
	}
}

// Clocks that go backwards, repeated keys and refreshes: the queue stays
// O(len(m)) after every call, eviction is in insertion order (a refresh moves
// a key to the back) and is counted exactly, expiry follows the stored time.
func TestFifoNonMonotonicCyclesBounded(t *testing.T) {
	const max = 8
	s := newFifoSet[int](max)
	for cycle := range 2000 {
		at := int64(1000 - cycle%37*13) // goes backwards and repeats
		s.Add(cycle%11, at)
		if s.Len() > max || len(s.q) > 2*s.Len()+64 {
			t.Fatalf("cycle %d: map %d queue %d", cycle, s.Len(), len(s.q))
		}
	}
	// Exact FIFO with a refresh.
	f := newFifoSet[string](2)
	f.Add("a", 5)
	f.Add("b", 1) // earlier time, later insertion
	f.Add("a", 5) // refresh: a moves behind b
	if n := f.Add("c", 9); n != 1 || f.Has("b") || !f.Has("a") || !f.Has("c") || f.evicted != 1 {
		t.Fatalf("eviction order/count: has a %v b %v c %v evicted %d", f.Has("a"), f.Has("b"), f.Has("c"), f.evicted)
	}
	// Expiry by stored time regardless of queue order.
	f.Expire(20, 10) // a@5 and c@9 are older than 10 s at 20
	if f.Len() != 0 || len(f.q) > 64 {
		t.Fatalf("expire: map %d queue %d", f.Len(), len(f.q))
	}
}

// ---- C2: bounded reads before allocation -----------------------------------

// Root R3 RED (copied assertion) plus preservation: a 64 MiB gone mark is
// never read; with room in corrupt/ it is archived intact, without room it
// stays in place unchanged and is counted unloaded.
func TestGoneOversizeNotReadAndPreserved(t *testing.T) {
	for _, room := range []bool{true, false} {
		t.Run(fmt.Sprintf("corruptRoom=%v", room), func(t *testing.T) {
			dir := t.TempDir()
			sp := &Spool{Dir: dir, MaxEntries: 5, MaxBytes: 65536}
			if !room {
				sp.CorruptMaxBytes = 1 << 20
			}
			name := strings.Repeat("a", 32) + spoolExt
			p := filepath.Join(dir, "gone", name)
			os.MkdirAll(filepath.Dir(p), 0o700)
			sparse(t, p, 64<<20) // present when the spool opens, as after a restart
			openSpool(t, sp)
			var got map[AllocKey]int64
			var err error
			n := allocated(func() { got, err = sp.LoadGone((&alerts{}).f) })
			if n > 8<<20 {
				t.Fatalf("oversized gone read before bound allocated %d bytes for rejected64MiB record", n)
			}
			if err != nil || len(got) != 0 {
				t.Fatalf("load: %v %d", err, len(got))
			}
			kept := p
			if room {
				kept = filepath.Join(dir, "corrupt", "gone-"+name)
				if _, err := os.Lstat(p); !os.IsNotExist(err) {
					t.Fatal("original still in gone/ after archiving")
				}
			}
			fi, err := os.Lstat(kept)
			if err != nil || fi.Size() != 64<<20 {
				t.Fatalf("evidence not preserved intact at %s: %v", kept, err)
			}
			_, _, corrupt, gone, _ := sp.Use()
			unloaded, _, _, _ := sp.Unloaded()
			if room && (corrupt.Files != 1 || corrupt.Bytes != 64<<20 || gone.Files != 0) {
				t.Fatalf("budgets %+v %+v", corrupt, gone)
			}
			if !room && (corrupt.Files != 0 || gone.Files != 1 || unloaded != 1) {
				t.Fatalf("budgets %+v %+v unloaded %d", corrupt, gone, unloaded)
			}
		})
	}
}

// An oversized allocation record is rejected on its size without reading it.
func TestRecordOversizeNotRead(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(dir, 0o700)
	k := AllocKey{Epoch: tE1, SessionID: tSID}
	p := filepath.Join(dir, (&Spool{}).name(k))
	sparse(t, p, 64<<20)
	sp := &Spool{Dir: dir, MaxEntries: 5, MaxBytes: 65536}
	openSpool(t, sp)
	n := allocated(func() {
		if _, err := sp.Load((&alerts{}).f); err != nil {
			t.Fatal(err)
		}
	})
	if n > 8<<20 {
		t.Fatalf("oversized record read: %d bytes allocated", n)
	}
	if fi, err := os.Lstat(filepath.Join(dir, "corrupt", filepath.Base(p))); err != nil || fi.Size() != 64<<20 {
		t.Fatalf("oversized record not archived intact: %v", err)
	}
}

// drainState never reads an oversized record or gone mark whole: it names it.
func TestDrainStateOversizedNamedNotRead(t *testing.T) {
	for _, where := range []string{"primary", "overflow", "gone"} {
		t.Run(where, func(t *testing.T) {
			dir := t.TempDir()
			os.MkdirAll(filepath.Join(dir, "overflow"), 0o700)
			os.MkdirAll(filepath.Join(dir, "gone"), 0o700)
			st, _ := json.Marshal(Status{UpdatedUnix: 1, Limits: Limits{RecordMaxBytes: 65536}})
			os.WriteFile(filepath.Join(dir, "status.json"), st, 0o600)
			sub := map[string]string{"primary": "", "overflow": "overflow", "gone": "gone"}[where]
			sparse(t, filepath.Join(dir, sub, strings.Repeat("b", 32)+spoolExt), 64<<20)
			var err error
			n := allocated(func() { _, _, _, err = drainState(dir) })
			if n > 8<<20 {
				t.Fatalf("drainState read the oversized file: %d bytes", n)
			}
			if err == nil || !strings.Contains(err.Error(), "oversized") {
				t.Fatalf("not named: %v", err)
			}
		})
	}
}

// ---- C3: an unusable previous status refuses the start ---------------------

func TestUnusableStatusRefusesStartAndIsPreserved(t *testing.T) {
	cases := map[string]func(t *testing.T, p string){
		"truncated": func(t *testing.T, p string) {
			os.WriteFile(p, []byte(`{"possiblyLostAtRisk":19,"refusedEvents":42`), 0o600)
		},
		"oversized": func(t *testing.T, p string) { sparse(t, p, statusReadMaxBytes+1) },
		"notStatus": func(t *testing.T, p string) { os.WriteFile(p, []byte(`{}`), 0o600) },
		"readError": func(t *testing.T, p string) { os.MkdirAll(filepath.Join(p, "x"), 0o700) },
	}
	for name, make := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			p := filepath.Join(dir, "status.json")
			make(t, p)
			os.WriteFile(filepath.Join(dir, ".tmp-record1"), []byte("evidence"), 0o600)
			before := tree(t, dir)
			for range 2 { // a retry is refused the same way: nothing was taken or changed
				b, err := New(bareConfig(dir))
				if b != nil {
					b.Close()
				}
				if err == nil || !strings.Contains(err.Error(), "cannot be used") || !strings.Contains(err.Error(), "left unchanged") {
					t.Fatalf("existing unreadable status was accepted and risk counters erased: %v", err)
				}
			}
			if after := tree(t, dir); fmt.Sprint(after) != fmt.Sprint(before) {
				t.Fatalf("refused start changed files:\n%v\n%v", before, after)
			}
			// R4: the status is read only under the writer lock (R3 read it
			// before locking, so a finishing writer's last status could be
			// replaced by a stale early read — TestStatusReadUnderWriterLock).
			// The lock file is therefore the one permitted addition; no
			// directory is created, nothing else changes, and the refused
			// start released the lock (no second writer is left holding it).
			names := map[string]bool{}
			for _, n := range listDir(t, dir) {
				names[n] = true
			}
			if !names[".lock"] {
				t.Fatal("the status was not read under the lock")
			}
			for _, n := range []string{"overflow", "dead", "corrupt", "gone"} {
				if names[n] {
					t.Fatalf("refused start created %s/", n)
				}
			}
			lk, err := lockDir(dir)
			if err != nil {
				t.Fatalf("refused start left the lock held: %v", err)
			}
			lk.Close()
		})
	}
	// A readable status: its counters carry, and are never doubled.
	dir := t.TempDir()
	st, _ := json.Marshal(Status{UpdatedUnix: 1, PossiblyLostAtRisk: 19, RefusedEvents: 42, AtRisk: 2})
	os.WriteFile(filepath.Join(dir, "status.json"), st, 0o600)
	for i := range 3 {
		b, err := New(bareConfig(dir))
		if err != nil {
			t.Fatal(err)
		}
		if got := b.Status(); got.PossiblyLostAtRisk != 21 || got.RefusedEvents != 42 {
			t.Fatalf("start %d: possiblyLost %d refusedEvents %d, want 21 and 42", i, got.PossiblyLostAtRisk, got.RefusedEvents)
		}
		b.Close()
	}
	// No status at all is a first start.
	b, err := New(bareConfig(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	b.Close()
}

// ---- C4: admission control off is effective --------------------------------

func TestAdmissionControlOffAndSignal(t *testing.T) {
	for _, mode := range []string{"off", "signal"} {
		t.Run(mode, func(t *testing.T) {
			h := newHarness(t, account.CoturnMeteringShadow)
			h.c.mode.Store("down")
			h.startWith(func(c *Config) { c.SpoolMaxEntries = 1; c.SpoolOverflowMaxEntries = -1; c.AdmissionControl = mode })
			h.eventually("subscription", h.subscribed)
			u := h.c.username("g1")
			h.redis.publish(chan4(u, sid(1), "total_traffic"), counters(1, 0))
			h.redis.publish(chan4(u, sid(2), "total_traffic"), counters(1001, 0))
			h.eventually("full, refusal counted", func() bool {
				st := h.b.Status()
				return st.SpoolState == "full" && st.RefusedNewKeys == 1 && st.RefusedEventBytes == 1001
			})
			st := h.b.Status()
			if st.AdmissionControl != mode || st.AdmissionRequested != (mode == "signal") || !strings.Contains(st.AdmissionReason, "no free spool entry") {
				t.Fatalf("%s: %+v", mode, st)
			}
			if logged := h.logs.has("closing coturn relay admission is requested"); logged != (mode == "signal") {
				t.Fatalf("%s: closure-request log %v", mode, logged)
			}
		})
	}
	cfg := bareConfig(t.TempDir())
	cfg.AdmissionControl = "enforce"
	if _, err := New(cfg); err == nil || !strings.Contains(err.Error(), "not implemented") {
		t.Fatalf("enforce accepted: %v", err)
	}
}

// ---- C5: every class over its limit refuses the start ----------------------

func TestOverBudgetArchivesRefuseStart(t *testing.T) {
	cases := []struct {
		name, flag string
		setup      func(t *testing.T, dir string)
		cfg        func(*Config)
	}{
		{"dead", "-spool-dead-max-entries 1", func(t *testing.T, dir string) {
			os.WriteFile(filepath.Join(dir, "dead", "x1"), []byte("d1"), 0o600)
			os.WriteFile(filepath.Join(dir, "dead", "x2"), []byte("d2"), 0o600)
		}, func(c *Config) { c.SpoolDeadMaxEntries = 1 }},
		{"corruptFiles", "-spool-corrupt-max-entries 1", func(t *testing.T, dir string) {
			os.WriteFile(filepath.Join(dir, "corrupt", "c1"), []byte("c1"), 0o600)
			os.WriteFile(filepath.Join(dir, "corrupt", "c2"), []byte("c2"), 0o600)
		}, func(c *Config) { c.SpoolCorruptMaxEntries = 1 }},
		{"corruptBytes", "-spool-corrupt-max-bytes 100", func(t *testing.T, dir string) {
			os.WriteFile(filepath.Join(dir, "corrupt", "c1"), make([]byte, 101), 0o600)
		}, func(c *Config) { c.SpoolCorruptMaxBytes = 100 }},
		{"quarantine", "-quarantine-max-bytes 10", func(t *testing.T, dir string) {
			os.WriteFile(filepath.Join(dir, "quarantine.jsonl"), []byte("{\"a\":12345}\n"), 0o600)
		}, func(c *Config) { c.QuarantineMaxBytes = 10 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			for _, d := range []string{"overflow", "dead", "corrupt", "gone"} {
				os.MkdirAll(filepath.Join(dir, d), 0o700)
			}
			tc.setup(t, dir)
			os.WriteFile(filepath.Join(dir, ".tmp-record1"), []byte("evidence"), 0o600)
			os.WriteFile(filepath.Join(dir, ".tmp-empty"), nil, 0o600)
			os.WriteFile(filepath.Join(dir, "0000badbadbadbadbadbadbadbadbad0"+spoolExt), []byte("{bad"), 0o600)
			before := tree(t, dir)
			cfg := bareConfig(dir)
			tc.cfg(&cfg)
			_, err := New(cfg)
			if !errors.Is(err, ErrSpoolOverLimit) || !strings.Contains(err.Error(), "(limit "+tc.flag+")") ||
				!strings.Contains(err.Error(), "records and evidence were left unchanged") {
				t.Fatalf("over budget start: %v", err)
			}
			if after := tree(t, dir); fmt.Sprint(after) != fmt.Sprint(before) {
				t.Fatalf("files changed:\n%v\n%v", before, after)
			}
		})
	}
}

// Root R3 reviewer case (copied assertion): an unreadable record left in
// place because corrupt/ is full is never overwritten by a later event of
// the same key, and that key is not placed in the other tier either.
func TestUnloadedEvidenceCannotBeOverwritten(t *testing.T) {
	for _, sub := range []string{"", "overflow"} {
		t.Run("tier="+sub, func(t *testing.T) {
			dir := t.TempDir()
			os.MkdirAll(filepath.Join(dir, "corrupt"), 0o700)
			os.MkdirAll(filepath.Join(dir, "overflow"), 0o700)
			os.WriteFile(filepath.Join(dir, "corrupt", "existing"), []byte("evidence"), 0o600)
			k := AllocKey{Epoch: tE1, SessionID: tSID}
			name := (&Spool{}).name(k)
			bad := filepath.Join(dir, sub, name)
			body := []byte("{unreadable-unique-financial-evidence")
			os.WriteFile(bad, body, 0o600)
			cfg := bareConfig(dir)
			cfg.SpoolCorruptMaxEntries = 1
			b, err := New(cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer b.Close()
			b.mu.Lock()
			b.tr.ApplyEvents(tE1, []Event{{Kind: KindTraffic, Username: tUser, SessionID: tSID, Bytes: 7}}, 123)
			b.flushLocked()
			st := b.st
			b.mu.Unlock()
			if after, _ := os.ReadFile(bad); string(after) != string(body) {
				t.Fatal("unloaded financial evidence overwritten by same-key event")
			}
			if len(b.Snapshot()) != 0 {
				t.Fatal("unloaded key admitted into another tier creating conflicting evidence")
			}
			if st.RefusedNewKeys != 1 || st.RefusedEventBytes != 7 || st.UnloadedRecords != 1 {
				t.Fatalf("refusal not counted: %+v", st)
			}
			other := filepath.Join(dir, map[string]string{"": "overflow", "overflow": ""}[sub], name)
			if _, err := os.Lstat(other); !os.IsNotExist(err) {
				t.Fatal("record written in the other tier")
			}
		})
	}
}

// An unreadable gone mark left in place is never replaced by a new mark of
// that name; the user-linked record stays (retried) rather than being removed
// without a durable mark of its own.
func TestUnreadableGoneMarkLeftIsNotReplaced(t *testing.T) {
	dir := t.TempDir()
	sp := &Spool{Dir: dir, MaxEntries: 5, MaxBytes: 65536, CorruptMaxEntries: 1}
	openSpool(t, sp)
	os.WriteFile(filepath.Join(dir, "corrupt", "existing"), []byte("x"), 0o600)
	sp.Close()
	sp = &Spool{Dir: dir, MaxEntries: 5, MaxBytes: 65536, CorruptMaxEntries: 1}
	a := newAllocs(t, 1)[0]
	mark := filepath.Join(dir, "gone", sp.name(a.Key))
	os.WriteFile(mark, []byte("{bad mark"), 0o600)
	openSpool(t, sp)
	if _, err := sp.LoadGone((&alerts{}).f); err != nil {
		t.Fatal(err)
	}
	if err := sp.Put(a); err != nil {
		t.Fatal(err)
	}
	if err := sp.MarkGone(a.Key, 5); !errors.Is(err, ErrKeyBlocked) {
		t.Fatalf("mark over a left unreadable mark: %v", err)
	}
	if b, _ := os.ReadFile(mark); string(b) != "{bad mark" {
		t.Fatal("unreadable gone mark replaced")
	}
	if _, err := os.Stat(filepath.Join(dir, sp.name(a.Key))); err != nil {
		t.Fatal("record removed without its own durable mark")
	}
}
