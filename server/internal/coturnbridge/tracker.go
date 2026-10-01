package coturnbridge

import (
	"fmt"
	"sort"
	"strconv"

	"github.com/relayium/relayium/internal/coturnbridge/wire"
)

// Epoch identifies one coturn process on one machine boot. coturn's raw
// session ids restart from zero with every process, so they mean nothing
// without it.
type Epoch struct {
	BootID     string `json:"bootId"`
	PID        int    `json:"pid"`
	StartTicks uint64 `json:"startTicks"`
}

func (e Epoch) String() string {
	return e.BootID + "/" + strconv.Itoa(e.PID) + "/" + strconv.FormatUint(e.StartTicks, 10)
}

// Valid reports whether e names a process.
func (e Epoch) Valid() bool { return e.BootID != "" && e.PID > 0 && e.StartTicks > 0 }

// AllocKey identifies one allocation: provider epoch + raw session id.
type AllocKey struct {
	Epoch     Epoch  `json:"epoch"`
	SessionID string `json:"sessionId"`
}

func (k AllocKey) String() string { return k.Epoch.String() + "/" + k.SessionID }

// Alloc is the bridge's durable record of one allocation.
//
// StreamSum (sum of observed interval deltas), LiveSnapshot (largest psd
// usage) and Final (total_traffic) are independent: each is a lower bound of
// the true client-side total (Final is exact), and they are never added to
// each other. A snapshot's cumulative is their max.
type Alloc struct {
	Key      AllocKey `json:"key"`
	Username string   `json:"username"`

	StreamSum    uint64 `json:"streamSum"`
	LiveSnapshot uint64 `json:"liveSnapshot"`
	Final        uint64 `json:"final"`
	FinalSeen    bool   `json:"finalSeen"`
	State        string `json:"state"`
	StreamGaps   uint32 `json:"streamGaps"`
	DeletedSeen  bool   `json:"deletedSeen"`

	// FirstObservedUnix is the earliest start the bridge can vouch for: the
	// bridge time it saw coturn's "new" status, or, for an allocation first
	// met mid-life (bridge restart, stream gap), now minus psd's "started N
	// secs ago"; 1 when coturn gives no start. It gates billable activation
	// only — central bills an allocation only if this is at or after the
	// activation time — so an unknown start is never billable. Fixed once the
	// first snapshot is sealed.
	FirstObservedUnix int64 `json:"firstObservedUnix"`
	// StartKnown: FirstObservedUnix is settled (from "new" or a psd listing).
	StartKnown bool `json:"startKnown"`
	// SeenUnix is the bridge time of first sight.
	SeenUnix int64 `json:"seenUnix"`
	// MissingListings counts consecutive complete psd listings, taken after
	// this allocation was first observed, that did not contain it.
	MissingListings int `json:"missingListings"`
	// FirstSeq is the first observation's psd/barrier generation (in-memory
	// ordering for the missing-listing rule; persisted for restarts).
	FirstGen uint64 `json:"firstGen"`

	// Snap is the latest immutable snapshot (nil before the first flush).
	Snap *wire.Snapshot `json:"snap,omitempty"`
	// Ack is central's acknowledgement of Snap, if any.
	AckSeq      uint64 `json:"ackSeq"`
	AckAccepted uint64 `json:"ackAccepted"`
	AckStatus   string `json:"ackStatus"`
	// LastSentUnix orders fair delivery (oldest first).
	LastSentUnix int64 `json:"lastSentUnix"`
	// EndedUnix is the bridge time the end was inferred (ended_unfinalized);
	// the record is kept that long plus upgradeWindowSecs so coturn's own
	// final, which it publishes asynchronously and unordered with its psd
	// removal, can still upgrade it.
	EndedUnix int64 `json:"endedUnix"`

	dirty bool
	// persistedSeq is the seq of the snapshot durably in the spool (0: none).
	// Only a persisted snapshot may be delivered: a delivered seq that is not
	// on disk could, after a crash, be resealed with other content.
	persistedSeq uint64
}

// Sendable reports whether a's latest snapshot is durably spooled.
func (a *Alloc) Sendable() bool { return a.Snap != nil && a.persistedSeq == a.Snap.Seq }

// MarkPersisted records that a's current record (and snapshot) is on disk.
func (a *Alloc) MarkPersisted() {
	if a.Snap != nil {
		a.persistedSeq = a.Snap.Seq
	}
}

// cumulative is what a snapshot of a would report now.
func (a *Alloc) cumulative() uint64 { return max(a.StreamSum, a.LiveSnapshot, a.Final) }

// Settled reports whether central has acknowledged a's latest snapshot with
// an accepted cumulative covering it.
func (a *Alloc) Settled() bool {
	return a.Snap != nil && a.AckSeq == a.Snap.Seq &&
		(a.AckStatus == wire.AckAccepted || a.AckStatus == wire.AckStale) &&
		a.AckAccepted >= a.Snap.Cumulative
}

// Done reports whether a can be forgotten at once: a final or epoch-ended
// snapshot, settled. An inferred end (ended_unfinalized) is kept for the
// upgrade window instead; see Tracker.Retire.
func (a *Alloc) Done() bool {
	return a.Snap != nil && wire.Terminal(a.Snap.State) && a.Snap.State != wire.StateEndedUnfinalized && a.Settled()
}

// Tracker holds every allocation the bridge has not yet delivered. It is not
// safe for concurrent use; Bridge serializes access.
type Tracker struct {
	RelayID string
	Allocs  map[AllocKey]*Alloc
	// Alert receives every anomaly (never silent).
	Alert func(format string, args ...any)
	// HoldUnknownSecs delays the first snapshot of a live allocation whose
	// start is not yet known, for at most this long after first sight, so a
	// psd listing can supply its start (0: never hold).
	HoldUnknownSecs int64
	gen             uint64
	// forgotten holds recently delivered keys (bridge time) so a listing or
	// late message cannot resurrect a finished allocation.
	forgotten map[AllocKey]int64
}

// forgetSecs is how long a delivered allocation's key stays tombstoned.
const forgetSecs = 600

// upgradeWindowSecs is how long an inferred end stays upgradable by a late
// final (its record stays in the spool, so this survives a bridge restart).
const upgradeWindowSecs = 600

// NewTracker returns an empty tracker.
func NewTracker(relayID string, alert func(string, ...any)) *Tracker {
	return &Tracker{RelayID: relayID, Allocs: map[AllocKey]*Alloc{}, Alert: alert, forgotten: map[AllocKey]int64{}}
}

// Forget drops a delivered (or dead-lettered) allocation and tombstones its
// key for forgetSecs.
func (t *Tracker) Forget(k AllocKey, now int64) {
	delete(t.Allocs, k)
	t.forgotten[k] = now
}

// Gen advances and returns the observation generation (one per trusted
// segment or psd listing).
func (t *Tracker) Gen() uint64 { t.gen++; return t.gen }

// alloc returns the allocation for key, creating and binding it to username
// on first sight (start, when startKnown, is its FirstObservedUnix). A
// different username for an existing key is refused (nil): coturn never
// changes a session's username (441/437), so it is an anomaly. A recently
// delivered key is not recreated (nil).
func (t *Tracker) alloc(key AllocKey, username string, now int64, gen uint64, startKnown bool, start int64) *Alloc {
	if a, ok := t.Allocs[key]; ok {
		if a.Username != username {
			t.Alert("ALERT username %q for %s differs from bound %q: quarantined", username, key, a.Username)
			return nil
		}
		return a
	}
	if _, gone := t.forgotten[key]; gone {
		return nil
	}
	a := &Alloc{Key: key, Username: username, State: wire.StateLive, FirstObservedUnix: 1, SeenUnix: now, FirstGen: gen, dirty: true}
	if startKnown {
		a.FirstObservedUnix, a.StartKnown = max(start, 1), true
	}
	t.Allocs[key] = a
	return a
}

// ApplyEvents applies events from one trusted segment of epoch e. It reports
// whether a final was observed (the caller flushes those at once).
func (t *Tracker) ApplyEvents(e Epoch, events []Event, now int64) (finals bool) {
	gen := t.Gen()
	for _, ev := range events {
		if ev.Kind == KindIgnored || ev.Kind == KindUnattributed {
			continue
		}
		key := AllocKey{Epoch: e, SessionID: ev.SessionID}
		if _, gone := t.forgotten[key]; gone {
			if ev.Kind == KindTotal {
				t.Alert("ALERT final %d for %s arrived after its record was retired: anything above the reported lower bound is not billed", ev.Bytes, key)
			}
			continue
		}
		// Only coturn's "new" status shows the allocation's birth.
		a := t.alloc(key, ev.Username, now, gen, ev.Kind == KindNew, now)
		if a == nil {
			continue
		}
		if a.State == wire.StateEndedUnfinalized && ev.Kind == KindTotal {
			// The one permitted change after an end: the end was inferred from
			// psd, and coturn's own final total is authoritative. Same epoch,
			// session and username (checked above); a new snapshot is sealed,
			// so the earlier one and its ACK stay exact.
			a.Final, a.FinalSeen, a.State, a.EndedUnix, a.dirty = ev.Bytes, true, wire.StateFinal, 0, true
			t.Alert("allocation %s: coturn's final %d arrived after its end was inferred; upgraded to final", key, ev.Bytes)
			finals = true
			continue
		}
		if a.State != wire.StateLive {
			// After a final or an epoch end nothing may change the record; an
			// inferred end only accepts the final (above).
			switch {
			case a.State == wire.StateEndedUnfinalized:
				// An interval delta published just before the final: the final,
				// if it arrives, includes it.
			case ev.Kind == KindTraffic || ev.Kind == KindTotal:
				t.Alert("ALERT %s event (%d bytes) for %s ignored: it already ended (%s)", ev.Kind, ev.Bytes, key, a.State)
			}
			continue
		}
		switch ev.Kind {
		case KindTraffic:
			a.StreamSum = satAdd(a.StreamSum, ev.Bytes)
			a.dirty = true
		case KindTotal:
			a.Final, a.FinalSeen, a.State, a.dirty = ev.Bytes, true, wire.StateFinal, true
			if a.StreamSum > a.Final || a.LiveSnapshot > a.Final {
				t.Alert("ALERT final %d for %s below an independent lower bound (stream %d, psd %d)", a.Final, key, a.StreamSum, a.LiveSnapshot)
			}
			finals = true
		case KindDeleted:
			a.DeletedSeen = true
		case KindNew, KindRefreshed:
			// Binding only.
		}
	}
	return finals
}

// NoteGap records a subscription gap (reconnect or quarantined segment) for
// every live allocation of e: their StreamSum is now a lower bound.
func (t *Tracker) NoteGap(e Epoch) {
	for _, a := range t.Allocs {
		if a.Key.Epoch == e && a.State == wire.StateLive {
			a.StreamGaps++
			a.dirty = true
		}
	}
}

// PSDSession is one session of a complete psd listing.
type PSDSession struct {
	SessionID string
	Username  string
	Bytes     uint64 // rb + sb: max(lifetime, current interval)
	// StartedAgo is coturn's "started N secs ago"; -1 for "started:
	// undefined time".
	StartedAgo int64
}

// ApplyListing applies a complete psd listing taken entirely within epoch e.
// startGen is the generation current when the listing was requested: only
// allocations observed before it can be judged missing.
func (t *Tracker) ApplyListing(e Epoch, sessions []PSDSession, startGen uint64, now int64, missingLimit int) {
	gen := t.Gen()
	present := map[string]bool{}
	for _, s := range sessions {
		present[s.SessionID] = true
		start, known := int64(1), true // coturn's undefined start: settled as unknown
		if s.StartedAgo >= 0 {
			start = now - s.StartedAgo
		}
		a := t.alloc(AllocKey{Epoch: e, SessionID: s.SessionID}, s.Username, now, gen, known, start)
		if a == nil || a.State != wire.StateLive {
			continue
		}
		if !a.StartKnown && a.Snap == nil {
			a.FirstObservedUnix, a.StartKnown, a.dirty = max(start, 1), true, true
		}
		a.MissingListings = 0
		if s.Bytes > a.LiveSnapshot {
			a.LiveSnapshot, a.dirty = s.Bytes, true
		}
	}
	for _, a := range t.Allocs {
		if a.Key.Epoch != e || a.State != wire.StateLive || present[a.Key.SessionID] || a.FirstGen > startGen {
			continue
		}
		a.MissingListings++
		a.dirty = true
		if a.MissingListings >= missingLimit {
			a.State, a.EndedUnix = wire.StateEndedUnfinalized, now
			t.Alert("allocation %s ended without an observed final: reporting lower bound %d", a.Key, a.cumulative())
		}
	}
}

// EndEpoch marks every live allocation of an epoch other than current as
// ended: its process is gone and can publish nothing more.
func (t *Tracker) EndEpoch(current Epoch) {
	for _, a := range t.Allocs {
		if a.Key.Epoch != current && a.State == wire.StateLive {
			a.State, a.dirty = wire.StateEpochEnded, true
			t.Alert("allocation %s lost its provider process without a final: reporting lower bound %d", a.Key, a.cumulative())
		}
	}
}

// Flush seals a new immutable snapshot for every allocation whose content
// changed and returns them (sealed) for persistence, together with the
// allocations whose first snapshot is held (held: persisted without a
// snapshot, so a crash during the hold does not lose their counters). A
// terminal snapshot is the last one, except that an inferred end can be
// followed by one final.
func (t *Tracker) Flush(now int64) (sealed, held []*Alloc) {
	for k, at := range t.forgotten {
		if now-at > forgetSecs {
			delete(t.forgotten, k)
		}
	}
	for _, a := range t.Allocs {
		if !a.dirty {
			continue
		}
		if a.Snap == nil && !a.StartKnown && a.State == wire.StateLive && now-a.SeenUnix < t.HoldUnknownSecs {
			held = append(held, a) // still dirty: sealed once a listing supplies its start
			continue
		}
		a.dirty = false
		if a.Snap != nil && wire.Terminal(a.Snap.State) && !(a.Snap.State == wire.StateEndedUnfinalized && a.State == wire.StateFinal) {
			continue
		}
		next := a.snapshot(t.RelayID, now)
		if a.Snap != nil && sameContent(a.Snap, next) {
			continue
		}
		next.Hash = next.ComputeHash()
		a.Snap = next
		sealed = append(sealed, a)
	}
	sort.Slice(sealed, func(i, j int) bool { return sealed[i].Key.String() < sealed[j].Key.String() })
	sort.Slice(held, func(i, j int) bool { return held[i].Key.String() < held[j].Key.String() })
	return sealed, held
}

// Retire returns the settled inferred ends whose upgrade window has passed:
// the caller removes and forgets them.
func (t *Tracker) Retire(now int64) []AllocKey {
	var out []AllocKey
	for k, a := range t.Allocs {
		if a.Snap != nil && a.Snap.State == wire.StateEndedUnfinalized && a.State == wire.StateEndedUnfinalized &&
			a.Settled() && now-a.EndedUnix >= upgradeWindowSecs {
			out = append(out, k)
		}
	}
	return out
}

// Held returns how many allocations have no snapshot yet.
func (t *Tracker) Held() int {
	n := 0
	for _, a := range t.Allocs {
		if a.Snap == nil {
			n++
		}
	}
	return n
}

func (a *Alloc) snapshot(relayID string, now int64) *wire.Snapshot {
	var seq uint64 = 1
	if a.Snap != nil {
		seq = a.Snap.Seq + 1
	}
	s := &wire.Snapshot{
		Version: wire.Version, RelayID: relayID,
		BootID: a.Key.Epoch.BootID, PID: a.Key.Epoch.PID, StartTicks: a.Key.Epoch.StartTicks,
		SessionID: a.Key.SessionID, Username: a.Username,
		Seq: seq, StreamSum: a.StreamSum, LiveSnapshot: a.LiveSnapshot, Final: a.Final, FinalSeen: a.FinalSeen,
		State: a.State, StreamGaps: a.StreamGaps,
		FirstObservedUnix: a.FirstObservedUnix, CreatedUnix: max(now, a.FirstObservedUnix),
	}
	s.Cumulative = a.cumulative()
	return s
}

// sameContent compares everything but seq, creation time and hash.
func sameContent(a, b *wire.Snapshot) bool {
	return a.Cumulative == b.Cumulative && a.StreamSum == b.StreamSum && a.LiveSnapshot == b.LiveSnapshot &&
		a.Final == b.Final && a.FinalSeen == b.FinalSeen && a.State == b.State && a.StreamGaps == b.StreamGaps
}

// ApplyAck applies central's acknowledgement. It returns whether the
// allocation is now done (deletable) and whether it must be dead-lettered.
// An ACK that does not name a's latest snapshot never settles it: an older
// ACK cannot delete a newer cumulative.
func (t *Tracker) ApplyAck(a *Alloc, ack wire.Ack) (done, dead bool) {
	if a.Snap == nil || ack.Seq != a.Snap.Seq || ack.Hash != a.Snap.Hash {
		if a.Snap != nil && ack.Seq < a.Snap.Seq {
			return false, false // an older snapshot's ACK: harmless, ignored
		}
		t.Alert("ALERT bad ACK for %s: seq %d hash %s does not match latest snapshot", a.Key, ack.Seq, ack.Hash)
		return false, false
	}
	switch ack.Status {
	case wire.AckAccepted, wire.AckStale:
		if ack.Accepted > a.Snap.Cumulative {
			t.Alert("ALERT bad ACK for %s seq %d: accepted %d exceeds the snapshot's %d", a.Key, ack.Seq, ack.Accepted, a.Snap.Cumulative)
			return false, false
		}
		a.AckSeq, a.AckAccepted, a.AckStatus = ack.Seq, ack.Accepted, ack.Status
		if ack.Accepted < a.Snap.Cumulative {
			if ack.Clamp == wire.ClampCeiling {
				t.Alert("ALERT %s seq %d hit the per-allocation ceiling: accepted %d of %d", a.Key, ack.Seq, ack.Accepted, a.Snap.Cumulative)
				return false, true
			}
			t.Alert("%s seq %d clamped (%q): accepted %d of %d, retrying", a.Key, ack.Seq, ack.Clamp, ack.Accepted, a.Snap.Cumulative)
			return false, false
		}
		return a.Done(), false
	case wire.AckConflict, wire.AckRejected:
		t.Alert("ALERT %s seq %d %s by central: %s", a.Key, ack.Seq, ack.Status, ack.Reason)
		return false, true
	case wire.AckGone:
		// The owner account is deleted: the record (which names the user) is
		// removed, not dead-lettered. Logged by provider key only.
		a.AckSeq, a.AckStatus = ack.Seq, ack.Status
		t.Alert("%s seq %d: owner account deleted; record removed, bytes forgiven", a.Key, ack.Seq)
		return true, false
	case wire.AckRetry:
		return false, false
	default:
		t.Alert("ALERT bad ACK status %q for %s", ack.Status, a.Key)
		return false, false
	}
}

// Live returns the number of live allocations of epoch e.
func (t *Tracker) Live(e Epoch) int {
	n := 0
	for _, a := range t.Allocs {
		if a.Key.Epoch == e && a.State == wire.StateLive {
			n++
		}
	}
	return n
}

// String summarizes the tracker for logs.
func (t *Tracker) String() string { return fmt.Sprintf("%d allocations", len(t.Allocs)) }
