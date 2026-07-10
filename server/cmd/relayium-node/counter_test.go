package main

import (
	"net"
	"sync"
	"testing"
)

// fakePC is a no-op PacketConn whose ReadFrom/WriteTo report fixed byte counts.
type fakePC struct{ net.PacketConn }

func (fakePC) ReadFrom(p []byte) (int, net.Addr, error) { return len(p), &net.UDPAddr{}, nil }
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
	reg := newAllocRegistry()
	relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}
	c := reg.wrap(fakePC{}, relay)
	reg.tag(relay, "6000:userX.123456")
	c.WriteTo(make([]byte, 250), &net.UDPAddr{})

	snap := reg.snapshot()
	if len(snap) != 1 {
		t.Fatalf("want 1 sample, got %d", len(snap))
	}
	if snap[0].Username != "6000:userX.123456" || snap[0].RelayedBytes != 250 {
		t.Fatalf("sample=%+v", snap[0])
	}
	if snap[0].AllocID != relay.String() {
		t.Fatalf("allocID=%q want %q", snap[0].AllocID, relay.String())
	}
}

func TestRegistryConcurrent(t *testing.T) {
	reg := newAllocRegistry()
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
