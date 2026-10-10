package coturnbridge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
)

// ---- helpers ----------------------------------------------------------------

func sid(i int) string { return fmt.Sprintf("0070000000000%05d", i) }

// newAllocs returns n sealed allocations (sessions 1..n) of tE1.
func newAllocs(t *testing.T, n int) []*Alloc {
	t.Helper()
	tr := NewTracker("coturn-central", (&alerts{}).f)
	for i := 1; i <= n; i++ {
		tr.ApplyEvents(tE1, []Event{{Kind: KindNew, Username: tUser, SessionID: sid(i)},
			{Kind: KindTraffic, Username: tUser, SessionID: sid(i), Bytes: uint64(10 * i)}}, 1)
	}
	return sealedAt(tr, 2)
}

func openSpool(t *testing.T, sp *Spool) {
	t.Helper()
	if err := sp.Open(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sp.Close() })
}

// tree returns path → sha256 of every regular file under dir except the lock.
func tree(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			t.Fatal(err)
		}
		if d.IsDir() || d.Name() == ".lock" {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(b)
		rel, _ := filepath.Rel(dir, p)
		out[rel] = hex.EncodeToString(sum[:])
		return nil
	})
	return out
}

func listDir(t *testing.T, dir string) []string {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var n []string
	for _, e := range ents {
		n = append(n, e.Name())
	}
	sort.Strings(n)
	return n
}

func bareConfig(dir string) Config {
	return Config{RelayID: "coturn-central", Realm: "relayium.com", RedisAddr: "127.0.0.1:1", CentralURL: "http://127.0.0.1:1",
		Token: "t", SpoolDir: dir, Epoch: &fakeEpoch{}}
}

func readStatus(t *testing.T, dir string) Status {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "status.json"))
	if err != nil {
		t.Fatal(err)
	}
	var st Status
	if err := json.Unmarshal(b, &st); err != nil {
		t.Fatal(err)
	}
	return st
}

// ---- tiers, refusal, admission -------------------------------------------

// Tier assignment is sticky: a key placed in overflow stays there for life,
// even after primary room returns, and is reloaded from there.
func TestSpoolTierSticky(t *testing.T) {
	dir := t.TempDir()
	sp := &Spool{Dir: dir, MaxEntries: 1, MaxBytes: 64 << 10, OverflowMaxEntries: 2}
	openSpool(t, sp)
	a := newAllocs(t, 3)
	for _, x := range a {
		if err := sp.Put(x); err != nil {
			t.Fatal(err)
		}
	}
	if tier, on, _ := sp.TierOf(a[0].Key); tier != TierPrimary || !on {
		t.Fatal("first not primary")
	}
	for _, x := range a[1:] {
		if tier, _, _ := sp.TierOf(x.Key); tier != TierOverflow {
			t.Fatal("past primary not overflow")
		}
	}
	if err := sp.Put(newAllocs(t, 4)[3]); !errors.Is(err, ErrSpoolFull) {
		t.Fatalf("fourth: %v", err)
	}
	if err := sp.Remove(a[0].Key); err != nil {
		t.Fatal(err)
	}
	if err := sp.Put(a[1]); err != nil { // update after primary room returned
		t.Fatal(err)
	}
	if tier, _, _ := sp.TierOf(a[1].Key); tier != TierOverflow {
		t.Fatal("key migrated")
	}
	if got := recordFilesOnDisk(t, dir); got != 2 {
		t.Fatalf("%d records", got)
	}
	if _, err := os.Stat(filepath.Join(dir, overflowSD, sp.name(a[1].Key))); err != nil {
		t.Fatal(err)
	}
	sp.Close()
	sp2 := &Spool{Dir: dir, MaxEntries: 1, MaxBytes: 64 << 10, OverflowMaxEntries: 2}
	openSpool(t, sp2)
	got, err := sp2.Load((&alerts{}).f)
	if err != nil || len(got) != 2 {
		t.Fatalf("reload %d %v", len(got), err)
	}
	if tier, on, _ := sp2.TierOf(a[2].Key); tier != TierOverflow || !on {
		t.Fatal("reload tier")
	}
	tiers, _, _, _, _ := sp2.Use()
	if tiers[TierPrimary] != (TierUse{}) || tiers[TierOverflow].Files != 2 || tiers[TierOverflow].Keys != 2 {
		t.Fatalf("accounting %+v", tiers)
	}
}

// Both tiers full: a new allocation is refused before it is tracked
// (bounded memory), counted, kept as quarantine evidence and signalled with
// one aggregated alert; capacity freed later, the key is admitted again —
// never permanently blocked — with a stream gap marking the missed part.
func TestBridgeOverflowRefusalAndRecovery(t *testing.T) {
	h := newHarness(t, account.CoturnMeteringBillable)
	h.c.mode.Store("down")
	h.startWith(func(c *Config) { c.SpoolMaxEntries = 1; c.SpoolOverflowMaxEntries = 1; c.TombstonesMax = 64 })
	h.eventually("subscription", h.subscribed)
	u := h.c.username("g1")
	for i := 1; i <= 2; i++ {
		h.born(u, sid(i))
		h.redis.publish(chan4(u, sid(i), "total_traffic"), counters(uint64(100*i), 0))
	}
	h.eventually("two durable", func() bool { st := h.b.Status(); return st.Primary.Files == 1 && st.Overflow.Files == 1 })
	for i := 3; i <= 12; i++ {
		h.born(u, sid(i))
		h.redis.publish(chan4(u, sid(i), "traffic"), counters(7, 0))
	}
	h.eventually("refused and full", func() bool {
		st := h.b.Status()
		return st.RefusedNewKeys == 10 && st.RefusedEvents == 20 && st.RefusedEventBytes == 70 && st.SpoolState == "full" && st.AdmissionRequested
	})
	if n := len(h.b.Snapshot()); n != 2 {
		t.Fatalf("tracked %d: refused keys must not be held", n)
	}
	q, err := os.ReadFile(filepath.Join(h.dir, "quarantine.jsonl"))
	if err != nil || !strings.Contains(string(q), sid(3)) || !strings.Contains(string(q), "spool capacity exhausted") {
		t.Fatalf("refusal evidence: %v %q", err, q)
	}
	lines := 0
	for _, l := range strings.Split(h.logs.dump(), "\n") {
		if strings.Contains(l, "observations of new allocations refused") {
			lines++
		}
	}
	if lines != 1 {
		t.Fatalf("%d refusal alert lines, want one aggregated line", lines)
	}
	h.c.mode.Store("")
	h.eventually("durable ones delivered", func() bool { return h.c.billed() == 300 && len(h.b.Snapshot()) == 0 })
	h.redis.publish(chan4(u, sid(3), "traffic"), counters(5, 0))
	h.eventually("refused key admitted again", func() bool {
		for _, a := range h.b.Snapshot() {
			if a.Key.SessionID == sid(3) {
				return a.StreamGaps == 1 && a.StreamSum == 5
			}
		}
		return false
	})
}

// Refusal history is bounded: past TombstonesMax the oldest refused keys are
// forgotten (counted), so a later admission of such a key cannot be marked
// with a gap — counted, not hidden.
func TestRefusalHistoryBoundedAndCounted(t *testing.T) {
	h := newHarness(t, account.CoturnMeteringShadow)
	h.c.mode.Store("down")
	h.startWith(func(c *Config) { c.SpoolMaxEntries = 1; c.SpoolOverflowMaxEntries = -1; c.TombstonesMax = 3 })
	h.eventually("subscription", h.subscribed)
	u := h.c.username("g1")
	h.redis.publish(chan4(u, sid(1), "total_traffic"), counters(1, 0))
	h.eventually("one durable", func() bool { return h.b.Status().Primary.Files == 1 })
	for i := 2; i <= 9; i++ {
		h.redis.publish(chan4(u, sid(i), "traffic"), counters(1, 0))
	}
	h.eventually("eviction counted", func() bool { st := h.b.Status(); return st.RefusedNewKeys == 8 && st.TombstonesEvicted >= 5 })
	time.Sleep(200 * time.Millisecond) // several status writes later the counts are still exact
	if st := h.b.Status(); st.RefusedNewKeys != 8 || st.TombstonesEvicted != 5 {
		t.Fatalf("refused %d evicted %d, want 8 and exactly 5", st.RefusedNewKeys, st.TombstonesEvicted)
	}
}

// A key found in both tiers is never resolved by choice: both files are
// kept, the key is blocked (not loaded, not recreated by later events) and
// drain refuses as not exact.
func TestDuplicateKeyBothTiersPreservedAndBlocked(t *testing.T) {
	dir := t.TempDir()
	sp := &Spool{Dir: dir, MaxEntries: 5, MaxBytes: 64 << 10, OverflowMaxEntries: 5}
	if err := sp.Open(); err != nil {
		t.Fatal(err)
	}
	a := newAllocs(t, 1)[0]
	if err := sp.Put(a); err != nil {
		t.Fatal(err)
	}
	sp.Close()
	raw, _ := os.ReadFile(filepath.Join(dir, sp.name(a.Key)))
	os.WriteFile(filepath.Join(dir, overflowSD, sp.name(a.Key)), raw, 0o600)
	before := tree(t, dir)
	b, err := New(bareConfig(dir))
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	st := b.Status()
	if st.DuplicateKeys != 1 || st.UnloadedRecords != 2 || len(b.Snapshot()) != 0 {
		t.Fatalf("duplicate: %+v tracked %d", st, len(b.Snapshot()))
	}
	b.mu.Lock()
	b.tr.ApplyEvents(tE1, []Event{{Kind: KindTraffic, Username: tUser, SessionID: a.Key.SessionID, Bytes: 9}}, 5)
	b.mu.Unlock()
	if len(b.Snapshot()) != 0 {
		t.Fatal("blocked key recreated")
	}
	after := tree(t, dir)
	for _, n := range []string{sp.name(a.Key), filepath.Join(overflowSD, sp.name(a.Key))} {
		if before[n] == "" || after[n] != before[n] {
			t.Fatalf("%s changed or missing", n)
		}
	}
	if why, final := drainSpoolReady(st, st); !final || !strings.Contains(why, "both spool tiers") {
		t.Fatalf("drain: %q %v", why, final)
	}
}

// ---- drain: capacity is not loss (B1) --------------------------------------

// A busy spool — primary at its limit, records in overflow, both tiers full —
// whose cancelled sessions all have durable finals is an exact drain. A
// session whose final was refused is not: drain names it and never passes.
func TestDrainCapacityIsNotLoss(t *testing.T) {
	h := newHarness(t, account.CoturnMeteringBillable)
	h.c.mode.Store("down")
	h.startWith(func(c *Config) { c.SpoolMaxEntries = 2; c.SpoolOverflowMaxEntries = 1 })
	h.eventually("subscription", h.subscribed)
	_, _, _, err := drainState(h.dir)
	if err != nil {
		t.Fatal(err)
	}
	base, _, _, _ := drainState(h.dir)
	u := h.c.username("g1")
	cancelled := map[string]bool{}
	for i := 1; i <= 3; i++ {
		h.born(u, sid(i))
		h.redis.publish(chan4(u, sid(i), "total_traffic"), counters(uint64(10*i), 0))
		cancelled[sid(i)] = true
	}
	emptyAt := time.Now().UnixMilli()
	h.eventually("busy but exact", func() bool {
		st, recs, gone, err := drainState(h.dir)
		if err != nil || st.SpoolState != "full" || st.Overflow.Files != 1 {
			return false
		}
		spool, final := drainSpoolReady(st, base)
		return drainReady(tE1, emptyAt, cancelled, st, recs, gone) == "" && spool == "" && !final
	})
	// A fourth session whose final is refused.
	h.born(u, sid(4))
	h.redis.publish(chan4(u, sid(4), "total_traffic"), counters(40, 0))
	cancelled[sid(4)] = true
	h.eventually("refused final not exact", func() bool {
		st, recs, gone, err := drainState(h.dir)
		if err != nil {
			return false
		}
		spool, final := drainSpoolReady(st, base)
		return final && strings.HasPrefix(spool, "NOT EXACT") &&
			strings.Contains(drainReady(tE1, emptyAt, cancelled, st, recs, gone), "has no final")
	})
}

// Truncated recent finals keep drain waiting (named), they are not loss.
func TestRecentFinalsBoundedAndDrainRefuses(t *testing.T) {
	h := newHarness(t, account.CoturnMeteringShadow)
	h.startWith(func(c *Config) { c.RecentFinalsMax = 2 })
	h.eventually("subscription", h.subscribed)
	u := h.c.username("g1")
	for i := 1; i <= 3; i++ {
		h.born(u, sid(i))
		h.redis.publish(chan4(u, sid(i), "total_traffic"), counters(1, 0))
	}
	h.eventually("truncated", func() bool {
		st := h.b.Status()
		return st.RecentFinalsTruncated && len(st.RecentFinals) == 2 && len(h.b.Snapshot()) == 0
	})
	st := h.b.Status()
	if why, final := drainSpoolReady(st, st); final || !strings.Contains(why, "truncated") {
		t.Fatalf("drain: %q %v", why, final)
	}
}

// ---- archives: unique, never overwritten (B2/F5) ---------------------------

// The same key corrupt on two starts leaves two archived copies; budgets
// match the directory exactly. With corrupt/ full the original stays.
func TestCorruptArchiveUniqueNamesAndBudget(t *testing.T) {
	dir := t.TempDir()
	k := AllocKey{Epoch: tE1, SessionID: tSID}
	name := (&Spool{}).name(k)
	for i, body := range []string{"{first", "{second"} {
		os.MkdirAll(dir, 0o700)
		os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600)
		sp := &Spool{Dir: dir, MaxEntries: 5, MaxBytes: 64 << 10, CorruptMaxEntries: 2}
		if err := sp.Open(); err != nil {
			t.Fatal(err)
		}
		if _, err := sp.Load((&alerts{}).f); err != nil {
			t.Fatal(err)
		}
		_, _, corrupt, _, _ := sp.Use()
		if corrupt.Files != i+1 {
			t.Fatalf("start %d: corrupt files %d", i, corrupt.Files)
		}
		sp.Close()
	}
	got := listDir(t, filepath.Join(dir, "corrupt"))
	if len(got) != 2 || got[0] != name || got[1] != name+".1" {
		t.Fatalf("corrupt/ %v", got)
	}
	a, _ := os.ReadFile(filepath.Join(dir, "corrupt", name))
	b, _ := os.ReadFile(filepath.Join(dir, "corrupt", name+".1"))
	if string(a) != "{first" || string(b) != "{second" {
		t.Fatal("an archived copy was overwritten")
	}
	// Third start with corrupt/ full: the new bad record stays in place.
	os.WriteFile(filepath.Join(dir, name), []byte("{third"), 0o600)
	sp := &Spool{Dir: dir, MaxEntries: 5, MaxBytes: 64 << 10, CorruptMaxEntries: 2}
	openSpool(t, sp)
	if _, err := sp.Load((&alerts{}).f); err != nil {
		t.Fatal(err)
	}
	_, _, corrupt, _, _ := sp.Use()
	unloaded, _, _, _ := sp.Unloaded()
	if corrupt.Files != 2 || corrupt.Bytes != int64(len("{first")+len("{second")) || unloaded != 1 {
		t.Fatalf("budget %+v unloaded %d", corrupt, unloaded)
	}
	if c, _ := os.ReadFile(filepath.Join(dir, name)); string(c) != "{third" {
		t.Fatal("original not preserved when corrupt/ is full")
	}
	if !sp.room(TierPrimary) || sp.tiers[TierPrimary].Files != 1 {
		t.Fatalf("unloaded record must occupy its tier: %+v", sp.tiers[TierPrimary])
	}
}

// Two dead letters of the same key are two files; dead/ full keeps the live
// record.
func TestDeadLettersUniqueAndBounded(t *testing.T) {
	dir := t.TempDir()
	sp := &Spool{Dir: dir, MaxEntries: 5, MaxBytes: 64 << 10, DeadMaxEntries: 2}
	openSpool(t, sp)
	a := newAllocs(t, 2)
	for i := range 2 {
		if err := sp.Put(a[0]); err != nil {
			t.Fatal(err)
		}
		if err := sp.DeadLetter(a[0], fmt.Sprintf("conflict %d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if got := listDir(t, filepath.Join(dir, "dead")); len(got) != 2 || got[1] != got[0]+".1" {
		t.Fatalf("dead/ %v", got)
	}
	if err := sp.Put(a[1]); err != nil {
		t.Fatal(err)
	}
	if err := sp.DeadLetter(a[1], strings.Repeat("r", 5000)); !errors.Is(err, ErrArchiveFull) {
		t.Fatalf("dead full: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, sp.name(a[1].Key))); err != nil {
		t.Fatal("live record removed although dead/ is full")
	}
	_, dead, _, _, _ := sp.Use()
	var sum int64
	for _, n := range listDir(t, filepath.Join(dir, "dead")) {
		fi, _ := os.Stat(filepath.Join(dir, "dead", n))
		sum += fi.Size()
	}
	if dead.Files != 2 || dead.Bytes != sum {
		t.Fatalf("dead budget %+v vs %d", dead, sum)
	}
}

// ---- temps: metadata vs evidence (B2/F4) -----------------------------------

func TestStartupTempClassification(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, overflowSD), 0o700)
	allocJSON, _ := json.Marshal(newAllocs(t, 1)[0])
	statusJSON, _ := json.Marshal(Status{UpdatedUnix: 1790000000, Epoch: "x"})
	files := map[string][]byte{
		".tmp-status-123":                    []byte("{partial"),
		".tmp-legacy1":                       statusJSON,
		".tmp-record1":                       allocJSON,
		".tmp-empty":                         nil,
		filepath.Join(overflowSD, ".tmp-o1"): []byte("garbage"),
	}
	for n, b := range files {
		os.WriteFile(filepath.Join(dir, n), b, 0o600)
	}
	sp := &Spool{Dir: dir, MaxEntries: 5, MaxBytes: 64 << 10, OverflowMaxEntries: 5}
	openSpool(t, sp)
	_, removed, kept, meta := sp.Unloaded()
	if meta != 2 || removed != 1 || kept != 2 {
		t.Fatalf("meta %d removed %d kept %d", meta, removed, kept)
	}
	got := listDir(t, filepath.Join(dir, "corrupt"))
	want := []string{"tmp-overflow-o1", "tmp-record1"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("corrupt/ %v, want %v", got, want)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "corrupt", "tmp-record1")); string(b) != string(allocJSON) {
		t.Fatal("record temp content changed")
	}
	for _, n := range []string{".tmp-status-123", ".tmp-legacy1", ".tmp-empty", ".tmp-record1"} {
		if _, err := os.Lstat(filepath.Join(dir, n)); err == nil {
			t.Fatalf("%s left", n)
		}
	}
}

// Status writes use their own temp prefix.
func TestStatusTempPrefix(t *testing.T) {
	ff := newFaultFS()
	ff.fail("rename", func(p string) bool { return filepath.Base(p) == "status.json" })
	dir := t.TempDir()
	cfg := bareConfig(dir)
	cfg.fs = ff
	if _, err := New(cfg); err == nil || !strings.Contains(err.Error(), "status.json cannot be written") {
		t.Fatalf("start with unwritable status: %v", err)
	}
	if ff.hit("rename") != 1 {
		t.Fatal("status write not attempted")
	}
	for _, n := range listDir(t, dir) {
		if strings.HasPrefix(n, tmpPrefix) {
			t.Fatalf("temp left: %s", n)
		}
	}
	// The status temp is created with the status prefix.
	ff2 := newFaultFS()
	ff2.fail("create", func(p string) bool { return strings.HasPrefix(filepath.Base(p), statusTmpPrefix) })
	cfg.fs = ff2
	if _, err := New(cfg); err == nil || ff2.hit("create") != 1 {
		t.Fatalf("status temp prefix: %v hits %d", err, ff2.hit("create"))
	}
}

// ---- startup over limits (B3/F6) -------------------------------------------

func TestOverLimitStartupLeavesEvidenceUnchanged(t *testing.T) {
	dir := t.TempDir()
	sp := &Spool{Dir: dir, MaxEntries: 5, MaxBytes: 64 << 10}
	if err := sp.Open(); err != nil {
		t.Fatal(err)
	}
	for _, a := range newAllocs(t, 3) {
		if err := sp.Put(a); err != nil {
			t.Fatal(err)
		}
	}
	sp.Close()
	os.WriteFile(filepath.Join(dir, ".tmp-record9"), []byte("evidence"), 0o600)
	os.WriteFile(filepath.Join(dir, ".tmp-empty"), nil, 0o600)
	os.WriteFile(filepath.Join(dir, "0000badbadbadbadbadbadbadbadbad0"+spoolExt), []byte("{bad"), 0o600)
	before := tree(t, dir)
	cfg := bareConfig(dir)
	cfg.SpoolMaxEntries, cfg.SpoolOverflowMaxEntries = 2, -1
	_, err := New(cfg)
	if !errors.Is(err, ErrSpoolOverLimit) || !strings.Contains(err.Error(), "4 primary records (limit -spool-max-entries 2)") ||
		!strings.Contains(err.Error(), "records and evidence were left unchanged") {
		t.Fatalf("over limit: %v", err)
	}
	after := tree(t, dir)
	if fmt.Sprint(before) != fmt.Sprint(after) {
		t.Fatalf("files changed:\n%v\n%v", before, after)
	}
	cfg.SpoolMaxEntries = 4
	b, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if len(b.Snapshot()) != 3 {
		t.Fatalf("loaded %d", len(b.Snapshot()))
	}
}

// ---- lock ------------------------------------------------------------------

func TestSpoolLockExclusive(t *testing.T) {
	dir := t.TempDir()
	b, err := New(bareConfig(dir))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := New(bareConfig(dir)); !errors.Is(err, ErrSpoolLocked) {
		t.Fatalf("second bridge: %v", err)
	}
	sp := &Spool{Dir: dir, MaxEntries: 5, MaxBytes: 64 << 10}
	if err := sp.Open(); !errors.Is(err, ErrSpoolLocked) {
		t.Fatalf("direct open: %v", err)
	}
	b.Close()
	b2, err := New(bareConfig(dir))
	if err != nil {
		t.Fatal(err)
	}
	b2.Close()
}

// ---- injected write faults (I1) --------------------------------------------

// Every step of the atomic write can fail. A failure before the rename
// leaves no record; a failure after it (directory fsync) may leave the file,
// which is counted but the write is still reported as failed. Recovery is a
// normal successful write.
func TestSpoolInjectedWriteFaults(t *testing.T) {
	for _, op := range []string{"create", "chmod", "write", "sync", "close", "rename", "syncdir"} {
		t.Run(op, func(t *testing.T) {
			dir := t.TempDir()
			ff := newFaultFS()
			sp := &Spool{Dir: dir, MaxEntries: 5, MaxBytes: 64 << 10, fs: ff}
			openSpool(t, sp)
			a := newAllocs(t, 1)[0]
			ff.fail(op, nil)
			if err := sp.Put(a); !isInjected(err) {
				t.Fatalf("Put: %v", err)
			}
			tiers, _, _, _, _ := sp.Use()
			onDisk := recordFilesOnDisk(t, dir)
			if n := tiers[TierPrimary].Files + tiers[TierOverflow].Files; n != onDisk {
				t.Fatalf("accounting %d vs disk %d", n, onDisk)
			}
			if wantFile := op == "syncdir"; (onDisk == 1) != wantFile {
				t.Fatalf("record on disk %d after %s fault", onDisk, op)
			}
			for _, e := range listDir(t, dir) {
				if strings.HasPrefix(e, tmpPrefix) {
					t.Fatalf("temp left: %s", e)
				}
			}
			ff.clear()
			if err := sp.Put(a); err != nil {
				t.Fatal(err)
			}
			tiers, _, _, _, _ = sp.Use()
			if tiers[TierPrimary].Files != 1 || recordFilesOnDisk(t, dir) != 1 {
				t.Fatal("recovery")
			}
		})
	}
}

// Through the bridge: a final whose record write fails after the rename (an
// ambiguous commit) is never sent while the failure lasts; the status says
// at risk; once writes work it is delivered and billed exactly once.
func TestBridgeAmbiguousCommitNotSendable(t *testing.T) {
	ff := newFaultFS()
	h := newHarness(t, account.CoturnMeteringBillable)
	h.startWith(func(c *Config) { c.fs = ff })
	h.eventually("subscription", h.subscribed)
	u := h.c.username("g1")
	ff.fail("syncdir", nil)
	h.born(u, tSID)
	h.redis.publish(chan4(u, tSID, "total_traffic"), counters(321, 0))
	h.eventually("at risk", func() bool { return h.b.Status().AtRisk == 1 && recordFilesOnDisk(t, h.dir) == 1 })
	time.Sleep(300 * time.Millisecond)
	if h.c.sawSession(tSID) {
		t.Fatal("a snapshot whose write was not confirmed durable was delivered")
	}
	st := h.b.Status()
	if st.StatusWriteFailures == 0 || !strings.Contains(st.LastError, "status.json not written") {
		t.Fatalf("status write failure not named: %+v", st)
	}
	ff.clear()
	h.eventually("delivered once", func() bool { return h.c.billed() == 321 && len(h.b.Snapshot()) == 0 })
	h.eventually("no longer at risk", func() bool { return h.b.Status().AtRisk == 0 })
	if ev, _ := h.c.ledgerRows(); ev != 1 {
		t.Fatalf("%d usage events, want 1", ev)
	}
	n := 0
	for _, l := range strings.Split(h.logs.dump(), "\n") {
		if strings.Contains(l, "status.json not written") {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("%d status-failure alert lines within a minute, want 1 (aggregated)", n)
	}
}

// A settled record whose removal fails stays on disk (with its ACK); after a
// restart it is recognised as settled and removed, never charged again.
func TestBridgeRemoveFaultNoDoubleCharge(t *testing.T) {
	ff := newFaultFS()
	h := newHarness(t, account.CoturnMeteringBillable)
	h.startWith(func(c *Config) { c.fs = ff })
	h.eventually("subscription", h.subscribed)
	u := h.c.username("g1")
	ff.fail("remove", func(p string) bool { return strings.HasSuffix(p, spoolExt) })
	h.born(u, tSID)
	h.redis.publish(chan4(u, tSID, "total_traffic"), counters(500, 0))
	h.eventually("billed, record kept", func() bool { return h.c.billed() == 500 && h.logs.has("spool remove for") })
	h.halt()
	ff.clear()
	h.startWith(func(c *Config) { c.fs = ff })
	h.eventually("removed at restart", func() bool { return recordFilesOnDisk(t, h.dir) == 0 && len(h.b.Snapshot()) == 0 })
	if got := h.c.billed(); got != 500 {
		t.Fatalf("billed %d after restart, want 500", got)
	}
}

// ---- gone privacy in the overflow tier -------------------------------------

// The gone mark is durable before the user-linked record is removed, in the
// overflow tier too; if the mark cannot be written the record stays.
func TestGoneMarkBeforeDeleteOverflow(t *testing.T) {
	dir := t.TempDir()
	ff := newFaultFS()
	sp := &Spool{Dir: dir, MaxEntries: 1, MaxBytes: 64 << 10, OverflowMaxEntries: 1, fs: ff}
	openSpool(t, sp)
	a := newAllocs(t, 2)
	for _, x := range a {
		if err := sp.Put(x); err != nil {
			t.Fatal(err)
		}
	}
	rec := filepath.Join(dir, overflowSD, sp.name(a[1].Key))
	ff.fail("rename", func(p string) bool {
		return strings.Contains(p, string(filepath.Separator)+"gone"+string(filepath.Separator))
	})
	if err := sp.MarkGone(a[1].Key, 3); !isInjected(err) {
		t.Fatalf("mark: %v", err)
	}
	if _, err := os.Stat(rec); err != nil {
		t.Fatal("record removed without a durable gone mark")
	}
	ff.clear()
	ff.fail("remove", func(p string) bool { return p == rec })
	if err := sp.MarkGone(a[1].Key, 3); !isInjected(err) {
		t.Fatalf("mark+remove: %v", err)
	}
	sp.Close()
	// Crash window: mark and record both exist; the mark wins at start.
	b, err := New(bareConfig(dir))
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if _, err := os.Stat(rec); !os.IsNotExist(err) {
		t.Fatal("overflow record survived its gone mark")
	}
	for _, x := range b.Snapshot() {
		if x.Key == a[1].Key {
			t.Fatal("gone key loaded")
		}
	}
}

// ---- clean-shutdown lifecycle (B4) ------------------------------------------

func TestCleanShutdownLifecycle(t *testing.T) {
	ff := newFaultFS()
	h := newHarness(t, account.CoturnMeteringBillable)
	h.startWith(func(c *Config) { c.fs = ff })
	h.eventually("subscription", h.subscribed)
	u := h.c.username("g1")
	ff.fail("rename", func(p string) bool { return strings.HasSuffix(p, spoolExt) })
	h.born(u, tSID)
	h.redis.publish(chan4(u, tSID, "traffic"), counters(9, 0))
	h.eventually("at risk", func() bool { return h.b.Status().AtRisk == 1 })
	h.halt() // graceful stop with one allocation not durable
	st := readStatus(t, h.dir)
	if st.CleanShutdown || st.AtRisk != 1 || st.PossiblyLostAtRisk != 0 {
		t.Fatalf("stop with at-risk: %+v", st)
	}
	raw, _ := os.ReadFile(filepath.Join(h.dir, "status.json"))

	// A start whose first status cannot be written refuses; status unchanged.
	ff.clear()
	ff.fail("rename", func(p string) bool { return filepath.Base(p) == "status.json" })
	cfg := bareConfig(h.dir)
	cfg.fs = ff
	if _, err := New(cfg); err == nil {
		t.Fatal("started without a writable status")
	}
	if now, _ := os.ReadFile(filepath.Join(h.dir, "status.json")); string(now) != string(raw) {
		t.Fatal("status changed by a refused start")
	}
	// The next start counts the loss once and clears cleanShutdown at once.
	ff.clear()
	b, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	st = readStatus(t, h.dir)
	if st.PossiblyLostAtRisk != 1 || st.CleanShutdown || st.AtRisk != 0 {
		t.Fatalf("first status of the new run: %+v", st)
	}
	b.Close()
	st = readStatus(t, h.dir)
	if !st.CleanShutdown || st.PossiblyLostAtRisk != 1 {
		t.Fatalf("clean stop: %+v", st)
	}
	for range 2 { // further restarts never add it again
		b, err := New(cfg)
		if err != nil {
			t.Fatal(err)
		}
		if b.Status().PossiblyLostAtRisk != 1 {
			t.Fatalf("double counted: %d", b.Status().PossiblyLostAtRisk)
		}
		b.Close()
	}
	// A crash (no Close) while nothing is at risk adds nothing either.
	b, _ = New(cfg)
	b.spool.Close() // the lock dies with the process; no clean status written
	b2, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer b2.Close()
	if b2.Status().PossiblyLostAtRisk != 1 {
		t.Fatalf("crash without at-risk counted: %d", b2.Status().PossiblyLostAtRisk)
	}
}

// ---- segment byte bound -----------------------------------------------------

func TestSegmentByteBound(t *testing.T) {
	h := newHarness(t, account.CoturnMeteringShadow)
	h.startWith(func(c *Config) { c.SegmentMaxBytes = 600; c.BarrierInterval = 200 * time.Millisecond })
	h.eventually("subscription", h.subscribed)
	u := h.c.username("g1")
	for i := 1; i <= 10; i++ {
		h.redis.publish(chan4(u, sid(i), "traffic"), counters(1, 1))
	}
	h.eventually("segment over its byte bound quarantined", func() bool {
		st := h.b.Status()
		return st.QuarantinedSegments >= 1 && st.QuarantineBytes > 0 && h.logs.has("segment overflow")
	})
	if len(h.b.Snapshot()) != 0 {
		t.Fatal("quarantined segment applied")
	}
}

// ---- delivery order ---------------------------------------------------------

func TestSelectOldestMatchesFullSort(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	for trial := range 50 {
		all := map[AllocKey]*Alloc{}
		n := r.Intn(300)
		for i := range n {
			k := AllocKey{Epoch: tE1, SessionID: sid(i)}
			all[k] = &Alloc{Key: k, LastSentUnix: int64(r.Intn(5))}
		}
		ok := func(k AllocKey, a *Alloc) bool { return a.LastSentUnix != 3 }
		for _, b := range []int{0, 1, 4, 64} {
			var want []*Alloc
			for k, a := range all {
				if ok(k, a) {
					want = append(want, a)
				}
			}
			sort.Slice(want, func(i, j int) bool {
				if want[i].LastSentUnix != want[j].LastSentUnix {
					return want[i].LastSentUnix < want[j].LastSentUnix
				}
				return want[i].Key.String() < want[j].Key.String()
			})
			if len(want) > b {
				want = want[:b]
			}
			got := selectOldest(all, b, ok)
			if len(got) != len(want) {
				t.Fatalf("trial %d b %d: %d vs %d", trial, b, len(got), len(want))
			}
			for i := range got {
				if got[i] != want[i] {
					t.Fatalf("trial %d b %d: order differs at %d", trial, b, i)
				}
			}
		}
	}
}

// BenchmarkReportSelect100k: one delivery page selection over 100k tracked
// allocations (in memory only). Report with -bench; the total for a full
// 100k backlog is about 1563 pages of this.
func BenchmarkReportSelect100k(b *testing.B) {
	all := map[AllocKey]*Alloc{}
	for i := range 100000 {
		k := AllocKey{Epoch: tE1, SessionID: fmt.Sprintf("%018d", i)}
		all[k] = &Alloc{Key: k, LastSentUnix: int64(i % 7)}
	}
	ok := func(AllocKey, *Alloc) bool { return true }
	selectOldest(all, 64, ok) // warm the key cache
	b.ResetTimer()
	for range b.N {
		selectOldest(all, 64, ok)
	}
}

// ---- limits ------------------------------------------------------------------

func TestEffectiveLimitsDefaults(t *testing.T) {
	l, err := EffectiveLimits(bareConfig(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	if l.PrimaryEntries != 100000 || l.OverflowEntries != 2048 || l.RecordMaxBytes != 64<<10 || l.AtRiskMax != 1024 ||
		l.DeadEntries != 10000 || l.GoneEntries != 102048 || l.TombstonesMax != 102048 || l.RecentFinalsMax != 20000 ||
		l.SegmentMaxBytes != 64<<20 || l.WrittenMaxBytes <= 0 {
		t.Fatalf("%+v", l)
	}
	cfg := bareConfig(t.TempDir())
	cfg.SpoolOverflowMaxEntries = -1
	if l, _ := EffectiveLimits(cfg); l.OverflowEntries != 0 {
		t.Fatal("negative overflow must disable the tier")
	}
	_ = context.Background
}

// The largest valid allocation record is far below the accepted 64 KiB.
func TestMaxValidRecordFitsAcceptedLimit(t *testing.T) {
	u := "99999999999999999999:" + strings.Repeat("a", 128) + "." + strings.Repeat("b", 128)
	big := uint64(1) << 62
	a := &Alloc{Key: AllocKey{Epoch: Epoch{BootID: strings.Repeat("b", 64), PID: 1 << 30, StartTicks: big}, SessionID: tSID},
		Username: u, StreamSum: big, LiveSnapshot: big, Final: big, FinalSeen: true, State: "ended_unfinalized", StreamGaps: 1<<32 - 1,
		FirstObservedUnix: 1 << 62, StartKnown: true, SeenUnix: 1 << 62, MissingListings: 1 << 30, FirstGen: 1<<64 - 1,
		AckSeq: big, AckAccepted: big, AckStatus: "rejected", LastSentUnix: 1 << 62, EndedUnix: 1 << 62}
	tr := NewTracker(strings.Repeat("r", 64), nil)
	s := a.snapshot(tr.RelayID, 1<<62)
	s.Seq = big
	s.Hash = s.ComputeHash()
	a.Snap = s
	b, _ := json.Marshal(a)
	if len(b) >= 64<<10 || len(b) > 4096 {
		t.Fatalf("max valid record %d bytes", len(b))
	}
	t.Logf("max valid record layout: %d bytes (accepted limit %d)", len(b), 64<<10)
	dir := t.TempDir()
	sp := &Spool{Dir: dir, MaxEntries: 1, MaxBytes: int64(len(b)) - 1}
	openSpool(t, sp)
	if err := sp.Put(a); err == nil || !strings.Contains(err.Error(), "bytes") {
		t.Fatalf("over the record limit: %v", err)
	}
}
