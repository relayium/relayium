package main

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/relayium/relayium/internal/storage"
)

// limits holds the node's live month-to-date relayed total and its hard caps,
// shared by the auth handler (reject new allocations), the relay counters (cut
// live traffic), and the blob handler (reject writes). Zero cap = unlimited.
type limits struct {
	monthlyRelayed int64 // atomic
	trafficCap     int64 // atomic
	diskCap        int64 // atomic
}

func (l *limits) addRelayed(n int64) { atomic.AddInt64(&l.monthlyRelayed, n) }

// overTraffic reports whether the node has reached its monthly relay cap.
func (l *limits) overTraffic() bool {
	c := atomic.LoadInt64(&l.trafficCap)
	return c > 0 && atomic.LoadInt64(&l.monthlyRelayed) >= c
}

func (l *limits) diskCapBytes() int64 { return atomic.LoadInt64(&l.diskCap) }

// sync adopts central's authoritative month-to-date total and caps. Central's
// value resets correctly at the month boundary (per-period accounting), so the
// node adopts it rather than keeping a stale local high-water; local increments
// accrue between syncs.
func (l *limits) sync(monthly, trafficCap, diskCap int64) {
	atomic.StoreInt64(&l.monthlyRelayed, monthly)
	atomic.StoreInt64(&l.trafficCap, trafficCap)
	atomic.StoreInt64(&l.diskCap, diskCap)
}

// countingPacketConn wraps a relay PacketConn, tallying every byte read and
// written through it into *n (the allocation's cumulative relayed bytes) and the
// shared node monthly total, and cutting egress once the monthly cap is reached.
//
// It is also the allocation's LIFECYCLE handle, and the ONLY one. This conn IS
// the relay socket pion allocated, so reg/id name exactly the registry entry it
// owns and its Close retires exactly that entry — no index lookup, no address
// to collide on. See allocRegistry.markClosed for why that identity is what
// makes retirement safe, and newTURNServer for why pion's OnAllocationDeleted
// callback is deliberately not wired to it.
//
// reg, id and pending are nil/empty for a counting-only conn built by hand in a
// test; every method degrades to plain counting.
type countingPacketConn struct {
	net.PacketConn
	n       *int64
	lim     *limits        // nil = no enforcement (counting only)
	reg     *allocRegistry // nil = counting only, owns no lifecycle
	id      string         // the allocID this socket IS
	pending *int64         // atomic; see beginIO
}

// beginIO/endIO bracket a socket operation from before it starts until after
// its bytes are in the entry's total.
//
// The window they protect is small and real: between `c.PacketConn.ReadFrom`
// returning 1400 bytes and the atomic add that records them, this goroutine can
// be descheduled. A concurrent Close (pion's lifetime timer, or Manager.Close
// on shutdown — both on other goroutines) can retire the entry in that gap, and
// the next heartbeat's snapshot would then publish a "final" cumulative total
// missing those 1400 bytes and evict the entry the add is about to land in.
//
// So snapshot refuses to finalise an entry with pending != 0. Counting the
// operations rather than locking keeps this off the relay's hot path — two
// uncontended atomics per datagram, and Close never blocks waiting for a reader
// that may not be about to return.
func (c *countingPacketConn) beginIO() {
	if c.pending != nil {
		atomic.AddInt64(c.pending, 1)
	}
}

func (c *countingPacketConn) endIO() {
	if c.pending != nil {
		atomic.AddInt64(c.pending, -1)
	}
}

// tally records n relayed bytes against this allocation and the node total.
func (c *countingPacketConn) tally(n int64) {
	atomic.AddInt64(c.n, n)
	if c.lim != nil {
		c.lim.addRelayed(n)
	}
}

func (c *countingPacketConn) ReadFrom(p []byte) (int, net.Addr, error) {
	c.beginIO()
	defer c.endIO() // runs after tally, which is the whole point
	nn, addr, err := c.PacketConn.ReadFrom(p)
	c.tally(int64(nn))
	return nn, addr, err
}

func (c *countingPacketConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	if c.lim != nil && c.lim.overTraffic() {
		// Over the monthly relay cap: blackhole egress so the transfer stops
		// locally in real time, rather than continuing until the credential
		// expires. Report success so pion doesn't error the allocation loop.
		// Nothing reached the socket, so there is nothing to tally and no
		// in-flight window to bracket.
		return len(p), nil
	}
	c.beginIO()
	defer c.endIO()
	nn, err := c.PacketConn.WriteTo(p, addr)
	c.tally(int64(nn))
	return nn, err
}

// Close retires the allocation. It is the SOLE retirement signal.
//
// pion closes an allocation's relay socket on every path that ends it:
// Allocation.Close does it unconditionally, and Manager.DeleteAllocation (the
// refresh-with-lifetime-0 handler, the allocation lifetime timer, and
// packetHandler's read-error path) and Manager.Close both go through it. It
// also closes the probe sockets it allocates and discards inside
// GetRandomEvenPort, which have no allocation at all — a path proven to leak
// permanently before this fix, in
// TestEvenPortAllocateLeaksProbeSocketsBeforeTheFix.
//
// The registry is updated through a defer, so the bookkeeping happens even when
// the underlying Close reports an error or panics — and the reason is NOT that
// the file descriptor is provably gone. It may not be: Close can report a
// deferred error against a descriptor it did release, and it can fail without
// releasing one. What justifies retiring anyway is upstream of the fd. By the
// time this Close runs, pion has already finished with the socket — it closes
// the relay socket as the last step of ending an allocation, and discards a
// GetRandomEvenPort probe outright — so it will never read from it or hand it
// to another allocation, and this node holds no way to un-close or re-adopt it.
// The entry therefore describes a socket that can no longer relay a byte for
// anyone, whatever Close returned. Skipping the bookkeeping on the error path
// is exactly how such an entry and its final byte total would be stranded
// forever. markClosed is idempotent, so a duplicate Close retires the entry
// exactly once.
func (c *countingPacketConn) Close() error {
	if c.reg != nil {
		defer c.reg.markClosed(c.id)
	}
	return c.PacketConn.Close()
}

type allocEntry struct {
	allocID  string
	bytes    int64 // atomic
	pending  int64 // atomic; socket operations whose bytes are not in bytes yet
	username string
	relayKey string
	// joined records that OnAllocationCreated attributed this relay socket to a
	// real allocation. A socket that is retired without it was never one — pion
	// allocates and discards bare relay sockets in GetRandomEvenPort — and
	// counting those is the diagnostic in stats().
	joined bool
	closed bool
}

// allocRegistry tracks per-allocation byte counters. Entries are keyed by a
// unique allocID (relay address + random nonce) so a relay port reused across
// allocation lifetimes never collides on the central side (keep-max is by
// alloc_id). byRelay indexes live allocations for the username join, which is
// all pion's OnAllocationCreated can be keyed by.
type allocRegistry struct {
	lim     *limits // shared node caps/total; nil = counting only
	mu      sync.Mutex
	entries map[string]*allocEntry // allocID -> entry
	byRelay map[string]string      // relayAddr.String() -> allocID (current live)
	// retiredUnjoined counts relay sockets retired without ever having been
	// attributed to an allocation, cumulatively since start. Diagnostic only;
	// see stats(). Monotonic: markClosed only ever increments it.
	retiredUnjoined int64
	// loggedRetiredUnjoined is the retiredUnjoined value the heartbeat
	// diagnostic last reported, so a cumulative total that has not moved is not
	// re-reported every heartbeat forever. See statsForHeartbeat.
	loggedRetiredUnjoined int64
}

func newAllocRegistry(lim *limits) *allocRegistry {
	return &allocRegistry{
		lim:     lim,
		entries: make(map[string]*allocEntry),
		byRelay: make(map[string]string),
	}
}

// wrap registers a fresh counter for a new relay socket on relayAddr and returns
// a counting conn over pc. The allocID is unique per socket lifetime.
//
// Not every socket pion allocates here becomes an allocation: GetRandomEvenPort
// allocates and immediately closes throwaway sockets looking for an even port.
// Those get an entry too, are never joined to a username, and are retired by
// their own Close like anything else.
func (r *allocRegistry) wrap(pc net.PacketConn, relayAddr net.Addr) net.PacketConn {
	nonce := make([]byte, 8)
	_, _ = rand.Read(nonce)
	relayKey := relayAddr.String()
	allocID := relayKey + "#" + hex.EncodeToString(nonce)
	e := &allocEntry{allocID: allocID, relayKey: relayKey}
	r.mu.Lock()
	r.entries[allocID] = e
	r.byRelay[relayKey] = allocID
	r.mu.Unlock()
	// The returned conn carries its own allocID, which is what lets Close retire
	// exactly this entry without consulting any index.
	return &countingPacketConn{PacketConn: pc, n: &e.bytes, lim: r.lim, reg: r, id: allocID, pending: &e.pending}
}

// created records the TURN username for the allocation on relayAddr, joined via
// pion's OnAllocationCreated. It is the only thing the event handlers still do,
// because it is the only thing the relay socket cannot tell us itself.
//
// A callback for a socket that has ALREADY closed is dropped: markClosed
// removes the byRelay key, so the lookup fails, and an evicted entry is gone
// from entries entirely. Attributing a username to a retired allocation would
// invent a usage row for it on the next snapshot.
func (r *allocRegistry) created(relayAddr net.Addr, username string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	id, ok := r.byRelay[relayAddr.String()]
	if !ok {
		return
	}
	e := r.entries[id]
	if e == nil || e.closed {
		return
	}
	e.username = username
	e.joined = true
}

// markClosed retires the allocation with this ID. It is the single place an
// entry becomes closed.
//
// Keying on the allocID rather than on any address is what makes it safe. The
// obvious alternative — retiring by srcAddr, which is all pion's
// OnAllocationDeleted carries — cannot distinguish one allocation from the next
// one that reuses the same client 5-tuple, so a late callback for a finished
// allocation would retire the LIVE one that replaced it. An allocID is minted
// per socket and held by that socket alone, so no delayed signal can be
// misattributed. See newTURNServer.
//
// Idempotent by construction: an entry that is already closed, or already
// flushed and evicted by snapshot and so absent from entries, is a no-op. Two
// Closes therefore decrement activeAllocs once and flush one final byte total.
func (r *allocRegistry) markClosed(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e := r.entries[id]
	if e == nil || e.closed {
		return
	}
	e.closed = true
	if !e.joined {
		r.retiredUnjoined++
	}
	// Drop the index HERE rather than at eviction, so nothing can join a
	// username to a socket that is already gone. The delete is identity-guarded
	// so an index that has already moved on to a NEWER socket on the same relay
	// port is left alone.
	if r.byRelay[e.relayKey] == id {
		delete(r.byRelay, e.relayKey)
	}
	// The entry itself survives one more snapshot so its final cumulative byte
	// total reaches central; snapshot evicts it immediately after.
}

// activeAllocs is how many relay sockets this node has open RIGHT NOW, which
// central stores as nodes.active_transfers and uses to pick the rollout canary:
// the least-busy machine gets a new build first, because it has the least to
// lose if the build is bad.
//
// It counts entries whose socket is still open, which is deliberately NOT the
// same population as snapshot()'s: snapshot reports a closed allocation one
// final time (so its last bytes flush) and sendHeartbeat drops samples with no
// username, so len(usage) means "allocations seen since the last heartbeat" and
// would over- and under-count live ones at the same time. A separate, honest
// counter is cheaper than explaining that difference to every future reader of
// the heartbeat.
//
// Because an entry is created in wrap() and retired in the socket's Close(),
// this counts exactly the relay sockets that are open, and returns to zero once
// they are all closed, with no dependence on a callback being delivered.
func (r *allocRegistry) activeAllocs() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, e := range r.entries {
		if !e.closed {
			n++
		}
	}
	return n
}

// allocStats is the diagnostic breakdown behind activeAllocs.
//
// The fleet's stuck active_transfers (0/16/28/16/16, never falling) could not be
// attributed from the node at all: it reported a single number and kept no
// record of what was in that number, so the investigation had to proceed by
// reading pion's source. That produced a proven permanent leak — see
// TestEvenPortAllocateLeaksProbeSocketsBeforeTheFix — but NOT a demonstration
// that this leak was that incident's trigger. No per-path record was kept while
// it was happening, so the attribution is not recoverable after the fact.
//
// These fields are what would have answered it directly, and what a future
// controlled run should be read against:
//
//   - LiveUnjoined > 0 for any sustained period means relay sockets are open
//     that pion never turned into allocations. On this pion version a real
//     allocation is joined synchronously, inside the same CreateAllocation call
//     that allocated the socket, so a healthy node's LiveUnjoined is ~0.
//   - RetiredUnjoined climbing means clients are driving GetRandomEvenPort
//     (Allocate with EVEN-PORT); before this fix, every one of those probes was
//     a permanent leak. This is the field that would settle the question the
//     original incident left open.
//   - AwaitingFlush is entries retired but still owed their final byte report.
//     It should be small and transient.
type allocStats struct {
	Live            int
	LiveUnjoined    int
	AwaitingFlush   int
	RetiredUnjoined int64
}

// stats is the read-only view, with no reporting side effect. The heartbeat
// deliberately does not use it — production logging goes through
// statsForHeartbeat, which also decides whether to log — so its callers are the
// tests and any future reader that only wants to observe.
func (r *allocRegistry) stats() allocStats {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.statsLocked()
}

// statsLocked is stats() without the lock, so statsForHeartbeat can decide
// whether to report from the same consistent view it returns.
func (r *allocRegistry) statsLocked() allocStats {
	s := allocStats{RetiredUnjoined: r.retiredUnjoined}
	for _, e := range r.entries {
		if e.closed {
			s.AwaitingFlush++
			continue
		}
		s.Live++
		if !e.joined {
			s.LiveUnjoined++
		}
	}
	return s
}

// statsForHeartbeat returns the breakdown and whether this heartbeat should log
// it. It exists because the three fields have two different lifetimes, and
// treating them alike produced permanent log spam.
//
// LiveUnjoined and AwaitingFlush are instantaneous: both are ~0 on a healthy
// node, and either being non-zero is news every time it is observed, so both
// are reported whenever present.
//
// RetiredUnjoined is CUMULATIVE and never decreases. Reporting it whenever it
// is non-zero means one line every heartbeat, forever, from the first EVEN-PORT
// request a node ever serves — an idle node emitting an unchanging number every
// ~30s until it restarts. What carries information is the GROWTH: a node that
// retired 40 unjoined sockets an hour ago and none since is quiet, and a node
// retiring them steadily is the signal the diagnostic was added to catch. So it
// is reported only when it has moved since the last line.
//
// The comparison and the update happen under the same lock as the read, so two
// heartbeats (or a heartbeat and any future caller) cannot both observe the
// same growth and log it twice. There is no timer and no expiry: the state is
// one int64 whose meaning is exactly "the value already written to the log".
func (r *allocRegistry) statsForHeartbeat() (allocStats, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.statsLocked()
	report := s.LiveUnjoined > 0 || s.AwaitingFlush > 0 || r.retiredUnjoined > r.loggedRetiredUnjoined
	if report {
		// Any line that goes out carries the current cumulative total, so that
		// total counts as reported regardless of which condition triggered it.
		r.loggedRetiredUnjoined = r.retiredUnjoined
	}
	return s, report
}

type allocSample struct {
	AllocID      string
	Username     string
	RelayedBytes int64
}

// snapshot returns the current cumulative bytes per allocation and evicts
// allocations marked closed, reporting them one final time. Closed allocations
// thus stop refreshing their central recorded_at and the map stays bounded.
//
// A closed entry with in-flight I/O is skipped entirely — neither reported nor
// evicted — and picked up whole by the next snapshot. See beginIO: its bytes
// have left the socket but are not in the total yet, so reporting now would
// publish a final figure short of them and then evict the entry the pending add
// is about to land in. Skipping rather than reporting-without-evicting is what
// keeps "exactly one final sample" true.
//
// The load order below matters and is not incidental: pending is read BEFORE
// bytes. Both are sequentially consistent atomics and the tally is sequenced
// before endIO in the same goroutine, so observing pending == 0 guarantees the
// subsequent read of bytes sees every completed operation.
//
// If a socket's I/O never completes, its entry is retained rather than reported
// short. That costs one map entry and loses no bytes; a relay conn whose
// ReadFrom never returns after Close would already have pion's packetHandler
// goroutine wedged behind it, which is the larger failure.
func (r *allocRegistry) snapshot() []allocSample {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]allocSample, 0, len(r.entries))
	for id, e := range r.entries {
		if e.closed && atomic.LoadInt64(&e.pending) != 0 {
			continue
		}
		out = append(out, allocSample{
			AllocID:      e.allocID,
			Username:     e.username,
			RelayedBytes: atomic.LoadInt64(&e.bytes),
		})
		if e.closed {
			delete(r.entries, id)
			// markClosed already dropped the index; this guard keeps eviction
			// self-sufficient if a future path ever sets closed directly, and is
			// identity-checked so a newer socket that has since taken the key is
			// not unindexed by this one.
			if r.byRelay[e.relayKey] == id {
				delete(r.byRelay, e.relayKey)
			}
		}
	}
	return out
}

// blobUsageRefresh is how often the blob-directory size gauge is recomputed.
// It is deliberately independent of the heartbeat cadence, which central
// dictates (registerResp.HeartbeatInterval; the node's own 30s is only a
// fallback for an unset value). A faster heartbeat therefore just means several
// heartbeats in a row can carry the same gauge reading.
const blobUsageRefresh = 30 * time.Second

// blobUsage caches the blob directory's total size.
//
// Both readers are hot: the heartbeat fires every ~30s and the blob handler
// consults it on every PUT. Walking the tree on each of those would be O(files)
// work in the request path, so the walk happens on a ticker and readers get an
// atomic load. A value up to one refresh interval stale is fine — the 80%
// volume reserve in relay.go is the real backstop against overshoot.
type blobUsage struct {
	bytes int64 // atomic
}

// get returns the last refreshed total (0 before the first refresh).
func (b *blobUsage) get() int64 { return atomic.LoadInt64(&b.bytes) }

// refresh recomputes the total. A walk error leaves the previous value in place
// rather than zeroing the gauge — reporting 0 used would read as "plenty of
// room" and invite an overfill.
//
// That fail-open choice is why the error is logged rather than swallowed: a
// persistent failure (lost permissions, store dir removed) pins the gauge
// forever, and every consequence of that is silent. The heartbeat keeps
// reporting the frozen figure, and if the gauge never got past 0 the admin disk
// cap stops being enforced entirely (storage.go's `diskUsed() >= cap` can never
// fire), leaving only the 80% whole-volume reserve.
func (b *blobUsage) refresh(ds *storage.DiskStore) {
	n, err := ds.UsedBytes()
	if err != nil {
		log.Printf("relayium-node: blob usage refresh failed: %v", err)
		return
	}
	atomic.StoreInt64(&b.bytes, n)
}
