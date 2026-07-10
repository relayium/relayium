package main

import (
	"crypto/rand"
	"encoding/hex"
	"net"
	"sync"
	"sync/atomic"
)

// countingPacketConn wraps a relay PacketConn, tallying every byte read and
// written through it into *n (the allocation's cumulative relayed bytes).
type countingPacketConn struct {
	net.PacketConn
	n *int64
}

func (c *countingPacketConn) ReadFrom(p []byte) (int, net.Addr, error) {
	nn, addr, err := c.PacketConn.ReadFrom(p)
	atomic.AddInt64(c.n, int64(nn))
	return nn, addr, err
}

func (c *countingPacketConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	nn, err := c.PacketConn.WriteTo(p, addr)
	atomic.AddInt64(c.n, int64(nn))
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
	mu      sync.Mutex
	entries map[string]*allocEntry // allocID -> entry
	byRelay map[string]string      // relayAddr.String() -> allocID (current live)
	bySrc   map[string]string      // srcAddr.String()  -> allocID
}

func newAllocRegistry() *allocRegistry {
	return &allocRegistry{
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
	return &countingPacketConn{PacketConn: pc, n: &e.bytes}
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
