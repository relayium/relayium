package coturnbridge

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/coturnbridge/wire"
)

var tE1 = Epoch{BootID: "boot-0000000000000001", PID: 100, StartTicks: 5000}
var tE2 = Epoch{BootID: "boot-0000000000000001", PID: 200, StartTicks: 9000}

const tSID = "007000000000000001"

type alerts struct{ lines []string }

func (a *alerts) f(format string, args ...any) {
	a.lines = append(a.lines, fmt.Sprintf(format, args...))
}
func (a *alerts) has(sub string) bool {
	for _, l := range a.lines {
		if strings.Contains(l, sub) {
			return true
		}
	}
	return false
}

func traffic(n uint64) Event {
	return Event{Kind: KindTraffic, Username: tUser, SessionID: tSID, Bytes: n}
}
func total(n uint64) Event { return Event{Kind: KindTotal, Username: tUser, SessionID: tSID, Bytes: n} }

// The three counters are independent lower bounds, never added together.
func TestTrackerCountersAreIndependentMax(t *testing.T) {
	al := &alerts{}
	tr := NewTracker("coturn-central", al.f)
	tr.ApplyEvents(tE1, []Event{traffic(100), traffic(100)}, 1000) // identical payloads: two real events
	tr.ApplyListing(tE1, []PSDSession{{SessionID: tSID, Username: tUser, Bytes: 150}}, tr.gen, 1001, 2)
	a := tr.Allocs[AllocKey{tE1, tSID}]
	if a.StreamSum != 200 || a.LiveSnapshot != 150 || a.cumulative() != 200 {
		t.Fatalf("stream %d psd %d cum %d, want 200/150/200 (never 350)", a.StreamSum, a.LiveSnapshot, a.cumulative())
	}
	// A psd listing that is ahead of the stream (missed deltas) wins, without
	// being added to it.
	tr.ApplyListing(tE1, []PSDSession{{SessionID: tSID, Username: tUser, Bytes: 900}}, tr.gen, 1002, 2)
	if a.cumulative() != 900 || a.StreamSum != 200 {
		t.Fatalf("cum %d stream %d", a.cumulative(), a.StreamSum)
	}
	tr.ApplyEvents(tE1, []Event{traffic(50), total(1000)}, 1003)
	if a.Final != 1000 || !a.FinalSeen || a.State != wire.StateFinal || a.cumulative() != 1000 {
		t.Fatalf("final: %+v", a)
	}
	// Nothing after the final changes the record.
	tr.ApplyEvents(tE1, []Event{traffic(10), total(5000)}, 1004)
	if a.cumulative() != 1000 || !al.has("it already ended") {
		t.Fatalf("post-final event changed the record: %d", a.cumulative())
	}
	snaps := sealedAt(tr, 1005)
	if len(snaps) != 1 || snaps[0].Snap.Cumulative != 1000 || snaps[0].Snap.State != wire.StateFinal || snaps[0].Snap.Validate() != nil {
		t.Fatalf("flush: %+v", snaps)
	}
}

func TestTrackerFinalBelowLowerBoundAlerts(t *testing.T) {
	al := &alerts{}
	tr := NewTracker("r", al.f)
	tr.ApplyEvents(tE1, []Event{traffic(500), total(400)}, 1)
	a := tr.Allocs[AllocKey{tE1, tSID}]
	if a.cumulative() != 500 || !al.has("below an independent lower bound") {
		t.Fatalf("cum %d alerts %v", a.cumulative(), al.lines)
	}
}

// The username is bound on first sight; a different one is never merged.
func TestTrackerUsernameBindingAndEpochKeys(t *testing.T) {
	al := &alerts{}
	tr := NewTracker("r", al.f)
	other := strings.Replace(tUser, "0123456789abcdef0123456789abcdef.", "fedcba9876543210fedcba9876543210.", 1)
	tr.ApplyEvents(tE1, []Event{traffic(100)}, 1)
	tr.ApplyEvents(tE1, []Event{{Kind: KindTraffic, Username: other, SessionID: tSID, Bytes: 999}}, 2)
	if a := tr.Allocs[AllocKey{tE1, tSID}]; a.StreamSum != 100 || !al.has("differs from bound") {
		t.Fatalf("username change merged: %+v", a)
	}
	// Same raw id under a new epoch is a different allocation.
	tr.ApplyEvents(tE2, []Event{{Kind: KindTraffic, Username: other, SessionID: tSID, Bytes: 999}}, 3)
	if len(tr.Allocs) != 2 || tr.Allocs[AllocKey{tE2, tSID}].StreamSum != 999 {
		t.Fatalf("epoch keying: %d allocs", len(tr.Allocs))
	}
	tr.EndEpoch(tE2)
	if a := tr.Allocs[AllocKey{tE1, tSID}]; a.State != wire.StateEpochEnded || a.cumulative() != 100 {
		t.Fatalf("old epoch not ended: %+v", a)
	}
	if a := tr.Allocs[AllocKey{tE2, tSID}]; a.State != wire.StateLive {
		t.Fatalf("current epoch ended: %+v", a)
	}
}

// An allocation is judged ended only after missingLimit complete listings
// taken after it was first observed, all without it.
func TestTrackerMissingListingRule(t *testing.T) {
	tr := NewTracker("r", (&alerts{}).f)
	start := tr.gen
	tr.ApplyEvents(tE1, []Event{traffic(10)}, 1) // observed after the listing started
	tr.ApplyListing(tE1, nil, start, 2, 2)
	a := tr.Allocs[AllocKey{tE1, tSID}]
	if a.MissingListings != 0 {
		t.Fatal("judged by a listing that started before it was observed")
	}
	tr.ApplyListing(tE1, nil, tr.gen, 3, 2)
	if a.State != wire.StateLive || a.MissingListings != 1 {
		t.Fatalf("after one listing: %+v", a)
	}
	tr.ApplyListing(tE1, nil, tr.gen, 4, 2)
	if a.State != wire.StateEndedUnfinalized {
		t.Fatalf("after two listings: %+v", a)
	}
	s := sealedAt(tr, 5)
	if len(s) != 1 || s[0].Snap.State != wire.StateEndedUnfinalized || s[0].Snap.FinalSeen {
		t.Fatalf("terminal snapshot: %+v", s[0].Snap)
	}
}

// Snapshots are immutable; seq grows only on content change; nothing follows
// a terminal snapshot.
func TestTrackerSnapshotsImmutable(t *testing.T) {
	tr := NewTracker("r", (&alerts{}).f)
	tr.ApplyEvents(tE1, []Event{traffic(10)}, 1)
	s1 := sealedAt(tr, 2)[0].Snap
	if s1.Seq != 1 {
		t.Fatal(s1.Seq)
	}
	if len(sealedAt(tr, 3)) != 0 {
		t.Fatal("flush without change sealed a snapshot")
	}
	tr.ApplyEvents(tE1, []Event{traffic(10)}, 4)
	s2 := sealedAt(tr, 5)[0].Snap
	if s2.Seq != 2 || s1.Cumulative != 10 || s1.Hash != s1.ComputeHash() || s2.Cumulative != 20 {
		t.Fatalf("s1 %+v s2 %+v", s1, s2)
	}
	tr.ApplyEvents(tE1, []Event{total(25)}, 6)
	s3 := sealedAt(tr, 7)[0].Snap
	tr.Allocs[AllocKey{tE1, tSID}].dirty = true
	if s3.State != wire.StateFinal || len(sealedAt(tr, 8)) != 0 {
		t.Fatal("snapshot sealed after terminal")
	}
}

func TestTrackerAckRules(t *testing.T) {
	al := &alerts{}
	tr := NewTracker("r", al.f)
	tr.ApplyEvents(tE1, []Event{traffic(100)}, 1)
	a := tr.Allocs[AllocKey{tE1, tSID}]
	s1 := *sealedAt(tr, 2)[0].Snap
	tr.ApplyEvents(tE1, []Event{total(300)}, 3)
	s2 := *sealedAt(tr, 4)[0].Snap
	ack := func(s wire.Snapshot, status string, acc uint64, clamp string) wire.Ack {
		return wire.Ack{Key: s.Key(), Seq: s.Seq, Hash: s.Hash, Status: status, Accepted: acc, Clamp: clamp}
	}
	// An older snapshot's ACK (lost-and-late) cannot settle or delete the newer one.
	if done, dead := tr.ApplyAck(a, ack(s1, wire.AckAccepted, 100, "")); done || dead || a.Settled() {
		t.Fatal("older ACK settled the newer snapshot")
	}
	// Right seq, wrong hash: bad ACK.
	bad := ack(s2, wire.AckAccepted, 300, "")
	bad.Hash = s1.Hash
	if done, _ := tr.ApplyAck(a, bad); done || !al.has("bad ACK") {
		t.Fatal("hash-mismatched ACK accepted")
	}
	// Accepted beyond what was reported: bad ACK.
	if done, _ := tr.ApplyAck(a, ack(s2, wire.AckAccepted, 301, "")); done {
		t.Fatal("over-accepting ACK accepted")
	}
	// Rate clamp: retained for retry.
	if done, dead := tr.ApplyAck(a, ack(s2, wire.AckAccepted, 200, wire.ClampRate)); done || dead || a.Settled() {
		t.Fatal("clamped ACK settled")
	}
	// Retry: not settled.
	if done, dead := tr.ApplyAck(a, ack(s2, wire.AckRetry, 0, "")); done || dead {
		t.Fatal("retry ACK settled")
	}
	// Full acceptance of the terminal snapshot: done.
	if done, dead := tr.ApplyAck(a, ack(s2, wire.AckAccepted, 300, "")); !done || dead {
		t.Fatal("terminal accepted ACK not done")
	}
	// Ceiling and refusals: dead-lettered.
	for _, c := range []wire.Ack{ack(s2, wire.AckAccepted, 200, wire.ClampCeiling), ack(s2, wire.AckConflict, 0, ""), ack(s2, wire.AckRejected, 0, "")} {
		if _, dead := tr.ApplyAck(a, c); !dead {
			t.Fatalf("%+v not dead-lettered", c)
		}
	}
}

func TestSpoolDurabilityAndBounds(t *testing.T) {
	dir := t.TempDir()
	sp := &Spool{Dir: dir, MaxEntries: 2, MaxBytes: 64 << 10}
	if err := sp.Open(); err != nil {
		t.Fatal(err)
	}
	tr := NewTracker("r", (&alerts{}).f)
	for i, sid := range []string{"007000000000000001", "007000000000000002", "007000000000000003"} {
		tr.ApplyEvents(tE1, []Event{{Kind: KindTraffic, Username: tUser, SessionID: sid, Bytes: uint64(10 * (i + 1))}}, 1)
	}
	allocs := sealedAt(tr, 2)
	if err := sp.Put(allocs[0]); err != nil {
		t.Fatal(err)
	}
	if err := sp.Put(allocs[1]); err != nil {
		t.Fatal(err)
	}
	if err := sp.Put(allocs[2]); !errors.Is(err, ErrSpoolFull) {
		t.Fatalf("third entry: %v", err)
	}
	// Updating an existing entry is never refused.
	if err := sp.Put(allocs[0]); err != nil {
		t.Fatal(err)
	}
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), ".tmp-") {
			t.Fatalf("temp file left: %s", e.Name())
		}
		if !e.IsDir() {
			fi, _ := e.Info()
			if fi.Mode().Perm() != 0o600 {
				t.Fatalf("%s mode %v", e.Name(), fi.Mode().Perm())
			}
		}
	}
	// Tamper with one record's snapshot: on load it is moved to corrupt/, not used.
	p := filepath.Join(dir, sp.name(allocs[1].Key))
	raw, _ := os.ReadFile(p)
	os.WriteFile(p, []byte(strings.Replace(string(raw), `"cumulative":20`, `"cumulative":99999`, 1)), 0o600)
	al := &alerts{}
	got, err := sp.Load(al.f)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Key != allocs[0].Key || got[0].Snap.Cumulative != 10 {
		t.Fatalf("loaded %+v", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "corrupt", sp.name(allocs[1].Key))); err != nil || !al.has("corrupt") {
		t.Fatalf("tampered record not quarantined: %v", err)
	}
	if err := sp.DeadLetter(got[0], "conflict: test"); err != nil {
		t.Fatal(err)
	}
	if n, _ := sp.Count(); n != 0 {
		t.Fatalf("%d live files after dead-letter", n)
	}
	if _, err := os.Stat(filepath.Join(dir, "dead", sp.name(allocs[0].Key))); err != nil {
		t.Fatal("dead letter not retained")
	}
}

// An allocation first met mid-life (no "new" status seen) has no start the
// bridge can vouch for: its first snapshot waits (bounded) for a psd listing
// to supply coturn's own start age, and is never billable-eligible if none
// comes. One whose birth was seen starts at that moment.
func TestTrackerStartBoundGatesActivation(t *testing.T) {
	tr := NewTracker("r", (&alerts{}).f)
	tr.HoldUnknownSecs = 65
	born := Event{Kind: KindNew, Username: tUser, SessionID: "007000000000000009"}
	tr.ApplyEvents(tE1, []Event{born, traffic(10)}, 1000)
	if a := tr.Allocs[AllocKey{tE1, "007000000000000009"}]; !a.StartKnown || a.FirstObservedUnix != 1000 {
		t.Fatalf("born alloc: %+v", a)
	}
	// tSID: first met through a delta.
	key := AllocKey{tE1, tSID}
	if a := tr.Allocs[key]; a.StartKnown || a.FirstObservedUnix != 1 {
		t.Fatalf("mid-life alloc: %+v", a)
	}
	for _, a := range sealedAt(tr, 1010) {
		if a.Key == key {
			t.Fatal("mid-life alloc sealed before its start was known")
		}
	}
	tr.ApplyListing(tE1, []PSDSession{{SessionID: tSID, Username: tUser, Bytes: 10, StartedAgo: 400}}, tr.gen, 1020, 2)
	sealed := sealedAt(tr, 1021)
	if len(sealed) != 1 || sealed[0].Snap.FirstObservedUnix != 620 {
		t.Fatalf("back-dated start: %+v", sealed)
	}
	// Fixed once sealed: a later listing cannot move it.
	tr.ApplyListing(tE1, []PSDSession{{SessionID: tSID, Username: tUser, Bytes: 10, StartedAgo: 1}}, tr.gen, 1030, 2)
	if tr.Allocs[key].FirstObservedUnix != 620 {
		t.Fatal("start moved after sealing")
	}

	// No listing within the hold: sealed with the unknown start (1).
	tr2 := NewTracker("r", (&alerts{}).f)
	tr2.HoldUnknownSecs = 65
	tr2.ApplyEvents(tE1, []Event{traffic(10)}, 2000)
	if len(sealedAt(tr2, 2064)) != 0 {
		t.Fatal("sealed inside the hold")
	}
	s := sealedAt(tr2, 2065)
	if len(s) != 1 || s[0].Snap.FirstObservedUnix != 1 {
		t.Fatalf("after the hold: %+v", s)
	}
	// A final is sealed at once, start unknown.
	tr3 := NewTracker("r", (&alerts{}).f)
	tr3.HoldUnknownSecs = 65
	tr3.ApplyEvents(tE1, []Event{total(99)}, 3000)
	if s := sealedAt(tr3, 3001); len(s) != 1 || s[0].Snap.FirstObservedUnix != 1 || s[0].Snap.State != wire.StateFinal {
		t.Fatalf("final with unknown start: %+v", s)
	}
}

// A delivered key is tombstoned: a listing taken before its final but applied
// after delivery does not resurrect it.
func TestTrackerForgottenKeyIsNotResurrected(t *testing.T) {
	tr := NewTracker("r", (&alerts{}).f)
	tr.ApplyEvents(tE1, []Event{total(50)}, 1)
	sealedAt(tr, 2)
	tr.Forget(AllocKey{tE1, tSID}, 3)
	tr.ApplyListing(tE1, []PSDSession{{SessionID: tSID, Username: tUser, Bytes: 40, StartedAgo: 5}}, 0, 4, 2)
	tr.ApplyEvents(tE1, []Event{{Kind: KindDeleted, Username: tUser, SessionID: tSID}}, 5)
	if len(tr.Allocs) != 0 {
		t.Fatalf("resurrected: %+v", tr.Allocs)
	}
	sealedAt(tr, 3+forgetSecs+1)
	if len(tr.forgotten) != 0 {
		t.Fatal("tombstone not pruned")
	}
}

// sealedAt is Flush's sealed snapshots only.
func sealedAt(t *Tracker, now int64) []*Alloc {
	s, _ := t.Flush(now)
	return s
}
