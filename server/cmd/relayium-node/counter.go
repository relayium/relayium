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
type countingPacketConn struct {
	net.PacketConn
	n   *int64
	lim *limits // nil = no enforcement (counting only)
}

func (c *countingPacketConn) ReadFrom(p []byte) (int, net.Addr, error) {
	nn, addr, err := c.PacketConn.ReadFrom(p)
	atomic.AddInt64(c.n, int64(nn))
	if c.lim != nil {
		c.lim.addRelayed(int64(nn))
	}
	return nn, addr, err
}

func (c *countingPacketConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	if c.lim != nil && c.lim.overTraffic() {
		// Over the monthly relay cap: blackhole egress so the transfer stops
		// locally in real time, rather than continuing until the credential
		// expires. Report success so pion doesn't error the allocation loop.
		return len(p), nil
	}
	nn, err := c.PacketConn.WriteTo(p, addr)
	atomic.AddInt64(c.n, int64(nn))
	if c.lim != nil {
		c.lim.addRelayed(int64(nn))
	}
	return nn, err
}

type allocEntry struct {
	allocID  string
	bytes    int64 // atomic
	username string
	relayKey string
	closed   bool
}

// allocRegistry tracks per-allocation byte counters. Entries are keyed by a
// unique allocID (relay address + random nonce) so a relay port reused across
// allocation lifetimes never collides on the central side (keep-max is by
// alloc_id). byRelay/bySrc index live allocations for the join (OnAllocationCreated
// has relayAddr) and eviction (OnAllocationDeleted has only srcAddr).
type allocRegistry struct {
	lim     *limits // shared node caps/total; nil = counting only
	mu      sync.Mutex
	entries map[string]*allocEntry // allocID -> entry
	byRelay map[string]string      // relayAddr.String() -> allocID (current live)
	bySrc   map[string]string      // srcAddr.String()  -> allocID
}

func newAllocRegistry(lim *limits) *allocRegistry {
	return &allocRegistry{
		lim:     lim,
		entries: make(map[string]*allocEntry),
		byRelay: make(map[string]string),
		bySrc:   make(map[string]string),
	}
}

// wrap registers a fresh counter for a new allocation on relayAddr and returns a
// counting conn over pc. The allocID is unique per allocation lifetime.
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
	return &countingPacketConn{PacketConn: pc, n: &e.bytes, lim: r.lim}
}

// created records the TURN username for the allocation on relayAddr (joined via
// pion's OnAllocationCreated) and indexes it by srcAddr for later eviction.
func (r *allocRegistry) created(srcAddr, relayAddr net.Addr, username string) {
	r.mu.Lock()
	if id, ok := r.byRelay[relayAddr.String()]; ok {
		if e := r.entries[id]; e != nil {
			e.username = username
		}
		r.bySrc[srcAddr.String()] = id
	}
	r.mu.Unlock()
}

// closeAlloc marks the allocation for srcAddr closed (via OnAllocationDeleted,
// which carries srcAddr but not relayAddr). The entry survives one more snapshot
// so its final bytes flush, then snapshot evicts it.
func (r *allocRegistry) closeAlloc(srcAddr net.Addr) {
	r.mu.Lock()
	if id, ok := r.bySrc[srcAddr.String()]; ok {
		if e := r.entries[id]; e != nil {
			e.closed = true
		}
		delete(r.bySrc, srcAddr.String())
	}
	r.mu.Unlock()
}

type allocSample struct {
	AllocID      string
	Username     string
	RelayedBytes int64
}

// snapshot returns the current cumulative bytes per allocation and evicts
// allocations marked closed (reporting them one final time). Closed allocations
// thus stop refreshing their central recorded_at and the map stays bounded.
func (r *allocRegistry) snapshot() []allocSample {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]allocSample, 0, len(r.entries))
	for id, e := range r.entries {
		out = append(out, allocSample{
			AllocID:      e.allocID,
			Username:     e.username,
			RelayedBytes: atomic.LoadInt64(&e.bytes),
		})
		if e.closed {
			delete(r.entries, id)
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
