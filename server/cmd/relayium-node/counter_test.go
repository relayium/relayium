package main

import (
	"net"
	"strings"
	"sync"
	"testing"
)

// fakePC is a no-op PacketConn whose ReadFrom/WriteTo report fixed byte counts.
type fakePC struct{ net.PacketConn }

func (fakePC) ReadFrom(p []byte) (int, net.Addr, error)  { return len(p), &net.UDPAddr{}, nil }
func (fakePC) WriteTo(p []byte, _ net.Addr) (int, error) { return len(p), nil }
func (fakePC) Close() error                              { return nil }

func TestCountingConnTallies(t *testing.T) {
	var n int64
	c := &countingPacketConn{PacketConn: fakePC{}, n: &n}
	c.WriteTo(make([]byte, 100), &net.UDPAddr{})
	c.ReadFrom(make([]byte, 40))
	if n != 140 {
		t.Fatalf("tally=%d want 140", n)
	}
}

func TestRegistrySnapshotAttributes(t *testing.T) {
	reg := newAllocRegistry(nil)
	src := &net.UDPAddr{IP: net.IPv4(192, 168, 1, 5), Port: 12345}
	relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}
	c := reg.wrap(fakePC{}, relay)
	reg.created(src, relay, "6000:userX.123456")
	c.WriteTo(make([]byte, 250), &net.UDPAddr{})

	snap := reg.snapshot()
	if len(snap) != 1 {
		t.Fatalf("want 1 sample, got %d", len(snap))
	}
	if snap[0].Username != "6000:userX.123456" || snap[0].RelayedBytes != 250 {
		t.Fatalf("sample=%+v", snap[0])
	}
	// allocID is relayAddr + "#" + nonce, so it carries the relay addr as a prefix.
	if !strings.HasPrefix(snap[0].AllocID, relay.String()+"#") {
		t.Fatalf("allocID=%q want prefix %q#", snap[0].AllocID, relay.String())
	}
}

// C1: two allocations that reuse the same relay address (port reuse over time)
// must get DISTINCT allocIDs so central keep-max never straddles two owners.
func TestAllocIDUniquePerAllocation(t *testing.T) {
	reg := newAllocRegistry(nil)
	relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}
	srcA := &net.UDPAddr{IP: net.IPv4(192, 168, 1, 5), Port: 1111}
	srcB := &net.UDPAddr{IP: net.IPv4(192, 168, 1, 6), Port: 2222}

	reg.wrap(fakePC{}, relay)
	reg.created(srcA, relay, "6000:userA.1")
	reg.closeAlloc(srcA)
	first := reg.snapshot() // final flush of A, then evicted
	if len(first) != 1 {
		t.Fatalf("want A reported once, got %d", len(first))
	}
	idA := first[0].AllocID

	// Same relay port reused for user B.
	reg.wrap(fakePC{}, relay)
	reg.created(srcB, relay, "6000:userB.2")
	second := reg.snapshot()
	if len(second) != 1 {
		t.Fatalf("want only B live, got %d", len(second))
	}
	if second[0].AllocID == idA {
		t.Fatalf("reused relay port produced same allocID %q — central keep-max would cross-attribute", idA)
	}
	if second[0].Username != "6000:userB.2" {
		t.Fatalf("username=%q want userB", second[0].Username)
	}
}

// I1: a closed allocation is reported exactly once more (final flush) and then
// evicted, so it stops refreshing central recorded_at and the map stays bounded.
func TestClosedAllocEvictedAfterFinalSnapshot(t *testing.T) {
	reg := newAllocRegistry(nil)
	src := &net.UDPAddr{IP: net.IPv4(192, 168, 1, 5), Port: 3333}
	relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 2), Port: 51000}
	c := reg.wrap(fakePC{}, relay)
	reg.created(src, relay, "6000:userX.9")
	c.WriteTo(make([]byte, 500), &net.UDPAddr{})

	reg.closeAlloc(src)
	if got := reg.snapshot(); len(got) != 1 || got[0].RelayedBytes != 500 {
		t.Fatalf("closed alloc must flush once with final bytes, got %+v", got)
	}
	if got := reg.snapshot(); len(got) != 0 {
		t.Fatalf("closed alloc must be evicted after its final flush, got %d entries", len(got))
	}
}

func TestRegistryConcurrent(t *testing.T) {
	reg := newAllocRegistry(nil)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, byte(i)), Port: 40000 + i}
		c := reg.wrap(fakePC{}, relay)
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				c.WriteTo(make([]byte, 10), &net.UDPAddr{})
			}
		}()
	}
	wg.Wait()
	var total int64
	for _, s := range reg.snapshot() {
		total += s.RelayedBytes
	}
	if total != 8*100*10 {
		t.Fatalf("total=%d want %d", total, 8*100*10)
	}
}
