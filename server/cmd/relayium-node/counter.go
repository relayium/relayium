package main

import (
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
	bytes    int64 // atomic
	username string
}

// allocRegistry tracks per-allocation byte counters keyed by relay address, and
// the username each allocation authenticated with (joined via pion's
// OnAllocationCreated event → relayAddr).
type allocRegistry struct {
	mu      sync.Mutex
	entries map[string]*allocEntry
}

func newAllocRegistry() *allocRegistry {
	return &allocRegistry{entries: make(map[string]*allocEntry)}
}

// wrap registers a counter for relayAddr and returns a counting conn over pc.
func (r *allocRegistry) wrap(pc net.PacketConn, relayAddr net.Addr) net.PacketConn {
	r.mu.Lock()
	e := &allocEntry{}
	r.entries[relayAddr.String()] = e
	r.mu.Unlock()
	return &countingPacketConn{PacketConn: pc, n: &e.bytes}
}

// tag associates a TURN username with the counter for relayAddr.
func (r *allocRegistry) tag(relayAddr net.Addr, username string) {
	r.mu.Lock()
	if e := r.entries[relayAddr.String()]; e != nil {
		e.username = username
	}
	r.mu.Unlock()
}

type allocSample struct {
	AllocID      string
	Username     string
	RelayedBytes int64
}

// snapshot returns the current cumulative bytes per allocation. Counters are
// cumulative and monotonic; keep-max on the central side makes redelivery safe.
func (r *allocRegistry) snapshot() []allocSample {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]allocSample, 0, len(r.entries))
	for id, e := range r.entries {
		out = append(out, allocSample{
			AllocID:      id,
			Username:     e.username,
			RelayedBytes: atomic.LoadInt64(&e.bytes),
		})
	}
	return out
}
