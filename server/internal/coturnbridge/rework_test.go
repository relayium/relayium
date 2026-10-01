package coturnbridge

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
	"github.com/relayium/relayium/internal/coturnbridge/wire"
)

// psdListing renders a complete psd dump (print_sessions format).
func psdListing(sessions ...PSDSession) string {
	var b strings.Builder
	b.WriteString("\n")
	for i, s := range sessions {
		fmt.Fprintf(&b, "    %d) id=%s, user <%s>:\n      realm: relayium.com\n      started %d secs ago\n      expiring in 500 secs\n", i+1, s.SessionID, s.Username, s.StartedAgo)
		fmt.Fprintf(&b, "      client protocol UDP, relay protocol UDP\n      usage: rp=1, rb=%d, sp=1, sb=0\n       rate: r=0, s=0, total=0 (bytes per sec)\n\n", s.Bytes)
	}
	fmt.Fprintf(&b, "  Total sessions: %d\n\n", len(sessions))
	return b.String()
}

func withCLI(t *testing.T, f *fakeCLI, psdEvery time.Duration) func(*Config) {
	addr := startFakeCLI(t, f)
	dir := t.TempDir()
	return func(c *Config) {
		c.CLIAddr, c.CLIPassword, c.PSDPath, c.PSDInterval = addr, f.password, filepath.Join(dir, "psd.txt"), psdEvery
	}
}

// Tracker: an inferred end accepts exactly one monotone final, sealed as a
// new snapshot; nothing follows a final; settled inferred ends retire only
// after the upgrade window.
func TestTrackerInferredEndUpgradeAndRetire(t *testing.T) {
	al := &alerts{}
	tr := NewTracker("r", al.f)
	tr.ApplyEvents(tE1, []Event{{Kind: KindNew, Username: tUser, SessionID: tSID}, traffic(100)}, 1)
	tr.ApplyListing(tE1, nil, tr.gen, 2, 2)
	tr.ApplyListing(tE1, nil, tr.gen, 3, 2)
	a := tr.Allocs[AllocKey{tE1, tSID}]
	s := sealedAt(tr, 4)
	if len(s) != 1 || s[0].Snap.State != wire.StateEndedUnfinalized || a.EndedUnix != 3 {
		t.Fatalf("inferred end: %+v", a)
	}
	ended := *a.Snap
	a.MarkPersisted()
	tr.ApplyAck(a, wire.Ack{Key: ended.Key(), Seq: ended.Seq, Hash: ended.Hash, Status: wire.AckAccepted, Accepted: 100})
	if a.Done() || len(tr.Retire(3+upgradeWindowSecs-1)) != 0 {
		t.Fatal("inferred end retired inside the upgrade window")
	}
	// A late interval delta is not sealed (the final includes it); the final upgrades.
	tr.ApplyEvents(tE1, []Event{traffic(50)}, 5)
	if len(sealedAt(tr, 6)) != 0 {
		t.Fatal("delta after an inferred end sealed a snapshot")
	}
	if !tr.ApplyEvents(tE1, []Event{total(400)}, 7) {
		t.Fatal("upgrade not reported as a final")
	}
	s = sealedAt(tr, 8)
	if len(s) != 1 || s[0].Snap.Seq != ended.Seq+1 || s[0].Snap.State != wire.StateFinal || s[0].Snap.Cumulative != 400 {
		t.Fatalf("upgrade snapshot: %+v", s)
	}
	if ended.Hash != ended.ComputeHash() || ended.State != wire.StateEndedUnfinalized {
		t.Fatal("earlier snapshot mutated")
	}
	// The earlier ACK cannot settle the upgrade; nothing changes after the final.
	if done, _ := tr.ApplyAck(a, wire.Ack{Key: ended.Key(), Seq: ended.Seq, Hash: ended.Hash, Status: wire.AckAccepted, Accepted: 100}); done || a.Settled() {
		t.Fatal("older ACK settled the upgrade")
	}
	tr.ApplyEvents(tE1, []Event{total(9999)}, 9)
	if a.Final != 400 || len(sealedAt(tr, 10)) != 0 {
		t.Fatal("record changed after a true final")
	}
	// An epoch end is never upgraded.
	tr.ApplyEvents(tE1, []Event{{Kind: KindTraffic, Username: tUser, SessionID: "007000000000000002", Bytes: 10}}, 11)
	tr.EndEpoch(tE2)
	tr.ApplyEvents(tE1, []Event{{Kind: KindTotal, Username: tUser, SessionID: "007000000000000002", Bytes: 99}}, 12)
	if b := tr.Allocs[AllocKey{tE1, "007000000000000002"}]; b.State != wire.StateEpochEnded || b.Final != 0 {
		t.Fatalf("epoch end upgraded: %+v", b)
	}
}

// The missing window must exceed barrier interval + timeout.
func TestConfigOrderingGuard(t *testing.T) {
	cfg := Config{RelayID: "r", Realm: "relayium.com", RedisAddr: "x", CentralURL: "x", Token: "t", SpoolDir: t.TempDir(),
		Epoch: &fakeEpoch{}, CLIAddr: "x", PSDPath: "/x", PSDInterval: 2 * time.Second}
	if err := cfg.defaults(); err == nil || !strings.Contains(err.Error(), "must exceed") {
		t.Fatalf("2 × 2s accepted against a 10s barrier timeout: %v", err)
	}
	cfg.PSDInterval = 30 * time.Second
	if err := cfg.defaults(); err != nil {
		t.Fatal(err)
	}
}

// F2 money control: a snapshot that is not on disk is never delivered. Spool
// full → the record stays in memory unsent; the bridge crashes; after the
// restart the same allocation's final is delivered as a fresh sequence that
// central never saw, so no seq is ever reused with other content. Its birth
// died with the crash; after the restart coturn's psd listing supplies its
// start again, as in production, so it stays billable.
func TestBridgeNeverSendsUnpersistedSnapshot(t *testing.T) {
	h := newHarness(t, account.CoturnMeteringBillable)
	h.startWith(func(c *Config) { c.SpoolMaxEntries = 1 })
	h.eventually("subscription", h.subscribed)
	u := h.c.username("g1")
	h.born(u, "007000000000000001")
	h.redis.publish(chan4(u, "007000000000000001", "traffic"), counters(100, 0))
	h.eventually("first delivered", func() bool { return h.c.sawSession("007000000000000001") && h.c.billed() == 100 })
	h.born(u, "007000000000000002")
	h.redis.publish(chan4(u, "007000000000000002", "traffic"), counters(0, 40))
	h.eventually("spool full", func() bool { return h.logs.has("spool full") })
	time.Sleep(300 * time.Millisecond) // ~10 report cycles
	if h.c.sawSession("007000000000000002") {
		t.Fatal("an unpersisted snapshot was delivered")
	}
	h.halt() // crash: the second allocation existed only in memory

	f := &fakeCLI{password: "pw"}
	f.set(psdListing(
		PSDSession{SessionID: "007000000000000001", Username: u, StartedAgo: 5},
		PSDSession{SessionID: "007000000000000002", Username: u, StartedAgo: 4}), "")
	cli := withCLI(t, f, 700*time.Millisecond)
	h.startWith(func(c *Config) { cli(c); c.SpoolMaxEntries = 1 })
	h.eventually("resubscribed", h.subscribed)
	h.eventually("second allocation's start listed", func() bool {
		for _, a := range h.b.Snapshot() {
			if a.Key.SessionID == "007000000000000002" {
				return a.StartKnown && a.FirstObservedUnix > 1
			}
		}
		return false
	})
	h.redis.publish(chan4(u, "007000000000000002", "total_traffic"), counters(0, 70))
	time.Sleep(200 * time.Millisecond)
	if h.c.sawSession("007000000000000002") {
		t.Fatal("unpersisted final delivered while the spool is full")
	}
	h.redis.publish(chan4(u, "007000000000000001", "total_traffic"), counters(300, 0))
	h.eventually("both settled", func() bool { n, _ := h.b.spool.Count(); return n == 0 && h.c.billed() == 370 })
	if h.b.Status().DeadLettered != 0 || h.logs.has("conflict") {
		t.Fatal("seq reuse conflict")
	}
}

// Held allocations (start unknown, no snapshot yet) are on disk: a crash
// during the hold keeps their counters.
func TestBridgeHeldAllocationIsPersisted(t *testing.T) {
	f := &fakeCLI{password: "pw", reply: "Cannot open file for writing\n\n"} // listings unusable: start stays unknown
	h := newHarness(t, account.CoturnMeteringBillable)
	cli := withCLI(t, f, 700*time.Millisecond)
	h.startWith(cli)
	h.eventually("subscription", h.subscribed)
	u := h.c.username("g1")
	h.redis.publish(chan4(u, tSID, "traffic"), counters(123, 0))
	h.eventually("held and persisted", func() bool {
		st := h.b.Status()
		n, _ := h.b.spool.Count()
		return st.Held == 1 && st.Unpersisted == 0 && n == 1
	})
	if h.c.sawSession(tSID) {
		t.Fatal("held allocation delivered")
	}
	h.halt()
	h.startWith(cli)
	a := h.b.Snapshot()
	if len(a) != 1 || a[0].StreamSum != 123 || a[0].Snap != nil {
		t.Fatalf("reloaded held allocation: %+v", a)
	}
}

// Late final after an inferred end, through the real loops: coturn lists the
// session no longer, the bridge infers the end and delivers its lower bound,
// then coturn's own final arrives and is billed exactly, once.
func TestBridgeLateFinalUpgradesInferredEnd(t *testing.T) {
	f := &fakeCLI{password: "pw"}
	h := newHarness(t, account.CoturnMeteringBillable)
	u := h.c.username("g1")
	f.set(psdListing(PSDSession{SessionID: tSID, Username: u, Bytes: 150, StartedAgo: 5}), "")
	h.startWith(withCLI(t, f, 700*time.Millisecond))
	h.eventually("subscription", h.subscribed)
	h.redis.publish(chan4(u, tSID, "traffic"), counters(100, 100))
	h.eventually("live delivered", func() bool { return h.c.billed() == 200 })
	f.set(psdListing(), "") // coturn removed it from its listing; the final is not out yet
	h.eventually("end inferred and delivered", func() bool {
		bs, _ := h.c.store.CoturnBindings(context.Background())
		return len(bs) == 1 && bs[0].Terminal && bs[0].LastState == wire.StateEndedUnfinalized && bs[0].Accepted == 200
	})
	h.redis.publish(chan4(u, tSID, "traffic"), counters(10, 10)) // delta published just before the final
	h.redis.publish(chan4(u, tSID, "total_traffic"), counters(600, 400))
	h.eventually("upgraded and settled", func() bool {
		bs, _ := h.c.store.CoturnBindings(context.Background())
		n, _ := h.b.spool.Count()
		return len(bs) == 1 && bs[0].LastState == wire.StateFinal && n == 0
	})
	if got := h.c.billed(); got != 1000 {
		t.Fatalf("billed %d, want exactly the final 1000", got)
	}
	key := AllocKey{Epoch: tE1, SessionID: tSID}.String()
	h.eventually("final listed for drain", func() bool {
		for _, k := range h.b.Status().RecentFinals {
			if k == key {
				return true
			}
		}
		return false
	})
}

// The reporter refuses an ACK body with a trailing delimiter.
func TestBridgeRefusesTrailingJSONAck(t *testing.T) {
	h := newHarness(t, account.CoturnMeteringBillable)
	h.c.mode.Store("trailingack")
	h.start()
	h.eventually("subscription", h.subscribed)
	h.born(h.c.username("g1"), tSID)
	h.redis.publish(chan4(h.c.username("g1"), tSID, "total_traffic"), counters(10, 0))
	h.eventually("trailing ACK refused", func() bool { return h.logs.has("bad ACK") && h.c.posts.Load() >= 2 })
	if n, _ := h.b.spool.Count(); n != 1 {
		t.Fatal("settled on a malformed ACK body")
	}
	h.c.mode.Store("")
	h.eventually("settled", func() bool { n, _ := h.b.spool.Count(); return n == 0 && h.c.billed() == 10 })
}

// Drain readiness, causally: each condition that can make a stop lossy keeps
// Drain waiting.
func TestDrainReady(t *testing.T) {
	e := tE1
	empty := int64(10_000)
	k := AllocKey{Epoch: e, SessionID: tSID}
	final := func() *Alloc {
		return &Alloc{Key: k, State: wire.StateFinal, Snap: &wire.Snapshot{State: wire.StateFinal}}
	}
	ok := Status{Epoch: e.String(), LastTrustedBarrierSentMilli: empty + 1}
	cancelled := map[string]bool{tSID: true}
	cases := []struct {
		name string
		st   Status
		recs map[AllocKey]*Alloc
		gone map[AllocKey]bool
		want string
	}{
		{"ready (final spooled)", ok, map[AllocKey]*Alloc{k: final()}, nil, ""},
		{"ready (final delivered)", Status{Epoch: e.String(), LastTrustedBarrierSentMilli: empty + 1, RecentFinals: []string{k.String()}}, nil, nil, ""},
		// Owner deleted: not a final, but nothing is billable — ready.
		{"ready (owner gone)", ok, nil, map[AllocKey]bool{k: true}, ""},
		{"gone mark of another epoch", ok, nil, map[AllocKey]bool{{Epoch: tE2, SessionID: tSID}: true}, "has no final"},
		{"gone but barrier sent before empty", Status{Epoch: e.String(), LastTrustedBarrierSentMilli: empty}, nil, map[AllocKey]bool{k: true}, "no trusted barrier"},
		{"gone but held in memory", Status{Epoch: e.String(), LastTrustedBarrierSentMilli: empty + 1, Held: 1}, nil, map[AllocKey]bool{k: true}, "held"},
		// The PING of the latest trusted barrier went out before the empty
		// listing: a final published in between may not be applied yet.
		{"barrier sent before empty", Status{Epoch: e.String(), LastTrustedBarrierSentMilli: empty}, map[AllocKey]*Alloc{k: final()}, nil, "no trusted barrier"},
		{"other epoch", Status{Epoch: tE2.String(), LastTrustedBarrierSentMilli: empty + 1}, map[AllocKey]*Alloc{k: final()}, nil, "confirms epoch"},
		{"unpersisted", Status{Epoch: e.String(), LastTrustedBarrierSentMilli: empty + 1, Unpersisted: 1}, map[AllocKey]*Alloc{k: final()}, nil, "unpersisted"},
		{"held in memory", Status{Epoch: e.String(), LastTrustedBarrierSentMilli: empty + 1, Held: 1}, map[AllocKey]*Alloc{k: final()}, nil, "held"},
		{"final not yet seen", ok, nil, nil, "has no final"},
		{"still live", ok, map[AllocKey]*Alloc{k: {Key: k, State: wire.StateLive, Snap: &wire.Snapshot{State: wire.StateLive}}}, nil, "live or unsealed"},
		{"final not sealed", ok, map[AllocKey]*Alloc{k: {Key: k, State: wire.StateFinal, Snap: &wire.Snapshot{State: wire.StateEndedUnfinalized}}}, nil, "live or unsealed"},
		{"only inferred end", ok, map[AllocKey]*Alloc{k: {Key: k, State: wire.StateEndedUnfinalized, Snap: &wire.Snapshot{State: wire.StateEndedUnfinalized}}}, nil, "has no final"},
	}
	for _, c := range cases {
		got := drainReady(e, empty, cancelled, c.st, c.recs, c.gone)
		if (c.want == "") != (got == "") || (c.want != "" && !strings.Contains(got, c.want)) {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

// Owner hard-purged mid-allocation: central answers "gone"; the bridge
// removes its record (which names the user) instead of dead-lettering it,
// does not resend it, and a later message for the key does not recreate it.
func TestBridgeGoneOwnerRecordRemoved(t *testing.T) {
	h := newHarness(t, account.CoturnMeteringBillable)
	h.start()
	h.eventually("subscription", h.subscribed)
	u := h.c.username("g1")
	h.born(u, tSID)
	h.redis.publish(chan4(u, tSID, "traffic"), counters(100, 0))
	h.eventually("delivered", func() bool { return h.c.billed() == 100 })
	ctx := context.Background()
	if err := h.c.store.SetAccountDeletion(ctx, h.c.user, 1, 100); err != nil {
		t.Fatal(err)
	}
	if err := h.c.store.ArchiveAndPurgeUser(ctx, h.c.user, 200); err != nil {
		t.Fatal(err)
	}
	h.redis.publish(chan4(u, tSID, "total_traffic"), counters(500, 0))
	h.eventually("record removed", func() bool { n, _ := h.b.spool.Count(); return n == 0 && len(h.b.Snapshot()) == 0 })
	posts := h.c.posts.Load()
	h.redis.publish(chan4(u, tSID, "traffic"), counters(7, 0))
	time.Sleep(300 * time.Millisecond)
	if len(h.b.Snapshot()) != 0 || h.c.posts.Load() != posts {
		t.Fatal("purged owner's allocation recreated or resent")
	}
	st := h.b.Status()
	if st.DeadLettered != 0 || len(st.RecentFinals) != 0 {
		t.Fatalf("gone handled as dead letter or as a drain final: %+v", st)
	}
	if ents, _ := os.ReadDir(filepath.Join(h.dir, "dead")); len(ents) != 0 {
		t.Fatal("user-linked dead letter written")
	}
	// The only trace on the host is an identity mark: provider key + time.
	marks, _ := os.ReadDir(filepath.Join(h.dir, "gone"))
	if len(marks) != 1 {
		t.Fatalf("%d gone marks, want 1", len(marks))
	}
	raw, _ := os.ReadFile(filepath.Join(h.dir, "gone", marks[0].Name()))
	if strings.Contains(string(raw), h.c.user) || strings.Contains(string(raw), "username") || strings.Contains(string(raw), "cumulative") {
		t.Fatalf("gone mark carries user or traffic data: %s", raw)
	}
	// Purged owner live at drain: the cancelled session is ready via its gone
	// mark (not as a final), once a barrier is sent after the empty listing.
	emptyAt := time.Now().UnixMilli()
	h.eventually("a trusted barrier sent after the empty listing", func() bool {
		st, recs, gone, err := drainState(h.dir)
		return err == nil && drainReady(tE1, emptyAt, map[string]bool{tSID: true}, st, recs, gone) == ""
	})
	// The mark survives a bridge restart and still blocks recreation.
	h.halt()
	h.start()
	h.eventually("resubscribed", h.subscribed)
	h.redis.publish(chan4(u, tSID, "traffic"), counters(9, 0))
	time.Sleep(300 * time.Millisecond)
	if len(h.b.Snapshot()) != 0 {
		t.Fatal("purged owner's allocation recreated after restart")
	}
	bs, _ := h.c.store.CoturnBindings(ctx)
	if len(bs) != 1 || !bs[0].Purged || bs[0].UserID != "" || bs[0].Accepted != 0 {
		t.Fatalf("central tombstone: %+v", bs)
	}
}

// Crash between writing a gone mark and removing the record: on restart the
// mark wins, the record (which names the user) is deleted, and the key stays
// tombstoned.
func TestBridgeGoneMarkWinsAfterCrash(t *testing.T) {
	dir := t.TempDir()
	sp := &Spool{Dir: dir, MaxEntries: 10, MaxBytes: 64 << 10}
	if err := sp.Open(); err != nil {
		t.Fatal(err)
	}
	tr := NewTracker("coturn-central", (&alerts{}).f)
	tr.ApplyEvents(tE1, []Event{{Kind: KindNew, Username: tUser, SessionID: tSID}, traffic(10)}, 1)
	a := sealedAt(tr, 2)[0]
	if err := sp.MarkGone(a.Key, 3); err != nil {
		t.Fatal(err)
	}
	if err := sp.Put(a); err != nil { // the record is back: the crash window
		t.Fatal(err)
	}
	b, err := New(Config{RelayID: "coturn-central", Realm: "relayium.com", RedisAddr: "127.0.0.1:1", CentralURL: "http://127.0.0.1:1",
		Token: "t", SpoolDir: dir, Epoch: &fakeEpoch{}})
	if err != nil {
		t.Fatal(err)
	}
	if n, _ := sp.Count(); n != 0 || len(b.Snapshot()) != 0 {
		t.Fatalf("record survived its gone mark: %d files", n)
	}
	b.tr.ApplyEvents(tE1, []Event{traffic(5)}, 4)
	if len(b.Snapshot()) != 0 {
		t.Fatal("gone key recreated after restart")
	}
}
