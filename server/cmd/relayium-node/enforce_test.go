package main

import (
	"bytes"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/relayium/relayium/internal/storage"
)

// recordingPC records how many bytes were actually forwarded via WriteTo.
type recordingPC struct {
	net.PacketConn
	forwarded int64
}

func (r *recordingPC) WriteTo(p []byte, _ net.Addr) (int, error) {
	r.forwarded += int64(len(p))
	return len(p), nil
}
func (r *recordingPC) ReadFrom(p []byte) (int, net.Addr, error) { return len(p), &net.UDPAddr{}, nil }
func (r *recordingPC) Close() error                             { return nil }

// Once the node is over its monthly relay cap, the counting conn must stop
// forwarding egress (cut the transfer) while still reporting success to pion.
func TestCountingConnCutsOverMonthlyCap(t *testing.T) {
	lim := &limits{}
	lim.sync(0, 1000, 0) // cap 1000, nothing used yet
	rec := &recordingPC{}
	var n int64
	c := &countingPacketConn{PacketConn: rec, n: &n, lim: lim}

	c.WriteTo(make([]byte, 600), &net.UDPAddr{}) // under cap: forwards, monthly=600
	c.WriteTo(make([]byte, 600), &net.UDPAddr{}) // checked under cap, forwards, monthly=1200 (now over)
	if rec.forwarded != 1200 {
		t.Fatalf("pre-cut forwarded=%d, want 1200", rec.forwarded)
	}
	before := rec.forwarded
	nw, err := c.WriteTo(make([]byte, 500), &net.UDPAddr{}) // over cap: blackholed
	if err != nil || nw != 500 {
		t.Fatalf("cut write should report success: n=%d err=%v", nw, err)
	}
	if rec.forwarded != before {
		t.Fatalf("over cap: expected no further forwarding, got %d", rec.forwarded)
	}
	if got := atomic.LoadInt64(&lim.monthlyRelayed); got != 1200 {
		t.Fatalf("blackholed bytes must not count: monthly=%d, want 1200", got)
	}
}

// sync adopts central's authoritative month-to-date total, so a new month (a
// lower total from central) clears an over-cap node rather than staying stuck.
func TestLimitsSyncResetsForNewMonth(t *testing.T) {
	lim := &limits{}
	lim.sync(2000, 1000, 0)
	if !lim.overTraffic() {
		t.Fatal("2000/1000 should be over cap")
	}
	lim.sync(50, 1000, 0) // month rollover: central reports the new small total
	if lim.overTraffic() {
		t.Fatal("after month reset, 50/1000 should be under cap")
	}
}

// The blob handler must refuse PUTs (507) once blob-dir usage reaches the disk
// cap, and serve them below it.
func TestBlobHandlerEnforcesDiskCap(t *testing.T) {
	ds, err := storage.NewDiskStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	lim := &limits{}
	lim.sync(0, 0, 1000) // disk cap 1000
	var used int64
	h := newBlobHandler(ds, "s", lim, func() int64 { return atomic.LoadInt64(&used) })

	put := func() int {
		r := httptest.NewRequest("PUT", "/blob/abc123", bytes.NewReader([]byte("data")))
		r.Header.Set("Authorization", "Bearer s")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if code := put(); code != http.StatusOK {
		t.Fatalf("under disk cap: PUT=%d, want 200", code)
	}
	atomic.StoreInt64(&used, 1000)
	if code := put(); code != http.StatusInsufficientStorage {
		t.Fatalf("at disk cap: PUT=%d, want 507", code)
	}
}
