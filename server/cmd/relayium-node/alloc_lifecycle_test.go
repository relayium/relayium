package main

import (
	"errors"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/pion/turn/v4"
)

// What these tests hold the registry to.
//
// A permanent leak of the same shape as the observed defect is reproduced
// against real pion in alloc_evenport_repro_test.go; that file is where the
// leak is argued from pion's source, and where the limits of what it does and
// does not establish about the fleet incident are stated. These are the
// invariants the fix rests on, and they hold regardless of which trigger the
// incident actually had:
//
//	L1  Closing the relay socket retires its entry, with no callback of any
//	    kind, ever.
//	L2  Retirement is idempotent: two Closes retire once and flush once.
//	L3  A retired allocation flushes its final CUMULATIVE byte total exactly
//	    once and never loses a byte — including when the underlying Close
//	    errors, and including bytes still in flight when it is retired.
//	L4  Nothing is retired by a client or relay address. A finished allocation
//	    can never retire the one that reused its addresses.
//	L5  activeAllocs counts open relay sockets and converges to zero.

// errPC is a relay socket whose Close REPORTS an error. It closes nothing at
// all — the embedded PacketConn is nil and Close just returns errCloseFailed —
// and that is deliberate, because the property under test is not "the fd was
// released anyway". A failing Close proves nothing either way about the
// descriptor: it can fail having released it, or fail without.
//
// What makes retirement correct is upstream of the fd. pion closes the relay
// socket only once it has already finished with the allocation, so it will not
// read from that socket or hand it to another allocation whatever Close
// returns, and the node holds no way to un-close or re-adopt it. The registry
// must therefore retire the entry rather than strand it and its bytes. See
// countingPacketConn.Close.
type errPC struct{ net.PacketConn }

var errCloseFailed = errors.New("close failed")

func (errPC) ReadFrom(p []byte) (int, net.Addr, error)  { return len(p), &net.UDPAddr{}, nil }
func (errPC) WriteTo(p []byte, _ net.Addr) (int, error) { return len(p), nil }
func (errPC) Close() error                              { return errCloseFailed }

// indexSizes reports the live index cardinalities, which is where a leak shows
// up first: entries can look right while byRelay accumulates forever.
func indexSizes(r *allocRegistry) (entries, byRelay int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.entries), len(r.byRelay)
}

func mustClose(t *testing.T, c net.PacketConn) {
	t.Helper()
	if err := c.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

// L1/L5: a relay socket pion allocated and then closed, with no callback ever.
// This is the EVEN-PORT probe sockets' shape reduced to the registry — the
// population proven to leak permanently in
// TestEvenPortAllocateLeaksProbeSocketsBeforeTheFix.
func TestCloseRetiresAllocationWithNoLifecycleCallbackEverFiring(t *testing.T) {
	reg := newAllocRegistry(nil)
	relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}

	c := reg.wrap(fakePC{}, relay)
	if got := reg.activeAllocs(); got != 1 {
		t.Fatalf("allocated socket: activeAllocs = %d, want 1 — an open relay socket counts "+
			"before OnAllocationCreated joins a username to it", got)
	}
	c.WriteTo(make([]byte, 700), &net.UDPAddr{})

	mustClose(t, c)

	if got := reg.activeAllocs(); got != 0 {
		t.Fatalf("after Close with no callback: activeAllocs = %d, want 0 — a socket retired "+
			"with no callback of any kind is the shape of the permanent leak proven in "+
			"TestEvenPortAllocateLeaksProbeSocketsBeforeTheFix, and of the fleet's "+
			"active_transfers that only ever rose", got)
	}
	snap := reg.snapshot()
	if len(snap) != 1 || snap[0].RelayedBytes != 700 {
		t.Fatalf("final flush = %+v, want exactly one sample of 700 bytes", snap)
	}
	if got := reg.snapshot(); len(got) != 0 {
		t.Fatalf("second snapshot = %d samples, want 0 — the retired entry must be evicted "+
			"after its single final flush", len(got))
	}
	if e, r := indexSizes(reg); e != 0 || r != 0 {
		t.Fatalf("after retirement: entries=%d byRelay=%d, want 0/0 — a surviving index key IS "+
			"the leak", e, r)
	}
}

// L2/L3: repeated Closes retire once and flush one complete total. A real
// socket's second Close errors; the registry's behaviour is what is under test.
func TestRetirementIsIdempotent(t *testing.T) {
	for _, closes := range []int{1, 2, 5} {
		t.Run(strconv.Itoa(closes)+" closes", func(t *testing.T) {
			reg := newAllocRegistry(nil)
			relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}

			c := reg.wrap(fakePC{}, relay)
			reg.created(relay, "6000:userX.1")
			c.WriteTo(make([]byte, 250), &net.UDPAddr{})

			for i := 0; i < closes; i++ {
				_ = c.Close()
			}

			if got := reg.activeAllocs(); got != 0 {
				t.Fatalf("after %d closes: activeAllocs = %d, want 0", closes, got)
			}
			// Exactly one final flush carrying the complete total. Two flushes
			// would double-count nothing (central keeps the max per alloc_id)
			// but would keep refreshing recorded_at for a dead allocation; zero
			// would lose the bytes outright.
			snap := reg.snapshot()
			if len(snap) != 1 {
				t.Fatalf("after %d closes: final flush = %d samples, want exactly 1", closes, len(snap))
			}
			if snap[0].RelayedBytes != 250 || snap[0].Username != "6000:userX.1" {
				t.Fatalf("after %d closes: final sample = %+v, want 250 bytes attributed to "+
					"6000:userX.1", closes, snap[0])
			}
			if got := reg.snapshot(); len(got) != 0 {
				t.Fatalf("after %d closes: %d samples on the second snapshot, want 0", closes, len(got))
			}
			if e, r := indexSizes(reg); e != 0 || r != 0 {
				t.Fatalf("after %d closes: entries=%d byRelay=%d, want 0/0", closes, e, r)
			}
		})
	}
}

// L3: a failing Close still retires the allocation and still flushes its bytes.
// Reporting the error to the caller is separate from, and must not gate, the
// bookkeeping.
func TestUnderlyingCloseErrorStillRetiresAndFlushesFinalBytes(t *testing.T) {
	reg := newAllocRegistry(nil)
	relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 3), Port: 50500}

	c := reg.wrap(errPC{}, relay)
	reg.created(relay, "6000:userE.1")
	c.WriteTo(make([]byte, 1234), &net.UDPAddr{})

	if err := c.Close(); !errors.Is(err, errCloseFailed) {
		t.Fatalf("Close error = %v, want it propagated to the caller", err)
	}
	if got := reg.activeAllocs(); got != 0 {
		t.Fatalf("after a failing Close: activeAllocs = %d, want 0 — the error says nothing "+
			"about the descriptor, but pion has already finished with this socket and will "+
			"not relay through it again, so retiring only on a clean Close would strand the "+
			"entry and its bytes forever", got)
	}
	snap := reg.snapshot()
	if len(snap) != 1 || snap[0].RelayedBytes != 1234 {
		t.Fatalf("final flush after a failing Close = %+v, want one sample of 1234 bytes", snap)
	}
	if e, r := indexSizes(reg); e != 0 || r != 0 {
		t.Fatalf("entries=%d byRelay=%d, want 0/0", e, r)
	}
}

// ── L4: address reuse, the reason retirement is keyed by allocID ─────────────

// The adversarial ordering. A previous design retired by srcAddr, because that
// is the only thing pion's OnAllocationDeleted carries. This is the sequence
// that breaks:
//
//	alloc1 opens from src S       -> indexed under S
//	alloc1's relay socket closes  -> alloc1 retired
//	alloc2 opens from the SAME S  -> S now points at alloc2
//	alloc1's OnAllocationDeleted arrives late -> looks up S -> retires alloc2
//
// alloc2 is live, is relaying, and has just been reported as finished. The
// callback's five arguments (srcAddr, dstAddr, protocol, username, realm) are
// identical for both allocations, so no lookup keyed on any of them can tell
// them apart — a delay of any length is enough. There is no safe version of
// that hook, which is why this node does not install it (see
// TestNodeEventHandlerHasNoAddressKeyedRetirement) and why retirement is keyed
// by the allocID the socket itself carries.
//
// This test drives the whole sequence through the PRODUCTION event handler, so
// it exercises the real wiring rather than a restatement of it, and delivers
// every late callback that wiring can still deliver.
func TestLateSignalsForARetiredAllocationCannotRetireItsSuccessor(t *testing.T) {
	reg := newAllocRegistry(nil)
	handler := nodeEventHandler(reg)
	src := &net.UDPAddr{IP: net.IPv4(192, 168, 1, 5), Port: 4242} // reused by both
	dst := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 3478}
	relay1 := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}
	relay2 := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50001}

	first := reg.wrap(fakePC{}, relay1)
	handler.OnAllocationCreated(src, dst, "udp", "6000:userA.1", "relayium.test", relay1, 0)
	first.WriteTo(make([]byte, 100), &net.UDPAddr{})
	mustClose(t, first)
	firstFlush := reg.snapshot()
	if len(firstFlush) != 1 || firstFlush[0].RelayedBytes != 100 {
		t.Fatalf("first allocation flush = %+v, want one sample of 100 bytes", firstFlush)
	}

	// Same client 5-tuple, brand new allocation.
	second := reg.wrap(fakePC{}, relay2)
	handler.OnAllocationCreated(src, dst, "udp", "6000:userA.2", "relayium.test", relay2, 0)
	second.WriteTo(make([]byte, 300), &net.UDPAddr{})

	// Now every late signal the first allocation could still produce, delivered
	// after the second one exists. The delete hook is absent today, and the
	// conditional is the point: re-add it and this test starts driving it with
	// the first allocation's arguments, which are identical to the second's, and
	// the assertions below fail. That is the defect, reproduced.
	handler.OnAllocationCreated(src, dst, "udp", "6000:userA.1", "relayium.test", relay1, 0)
	if deleted := handler.OnAllocationDeleted; deleted != nil {
		deleted(src, dst, "udp", "6000:userA.1", "relayium.test")
	}

	if got := reg.activeAllocs(); got != 1 {
		t.Fatalf("after the first allocation's late callbacks: activeAllocs = %d, want 1 — the "+
			"SECOND allocation is live and relaying, and a signal about the first one must not "+
			"retire it", got)
	}
	live := reg.snapshot()
	if len(live) != 1 {
		t.Fatalf("snapshot = %d samples, want 1 (the live second allocation)", len(live))
	}
	if live[0].RelayedBytes != 300 || live[0].Username != "6000:userA.2" {
		t.Fatalf("live sample = %+v, want 300 bytes attributed to 6000:userA.2 — a late signal "+
			"rewrote the live allocation", live[0])
	}
	if live[0].AllocID == firstFlush[0].AllocID {
		t.Fatalf("two allocations shared allocID %q", live[0].AllocID)
	}

	// And it still retires by its own socket, on its own schedule.
	mustClose(t, second)
	if got := reg.activeAllocs(); got != 0 {
		t.Fatalf("after the second allocation's own Close: activeAllocs = %d, want 0", got)
	}
	if got := reg.snapshot(); len(got) != 1 || got[0].RelayedBytes != 300 {
		t.Fatalf("second allocation final flush = %+v, want one sample of 300 bytes", got)
	}
	if e, r := indexSizes(reg); e != 0 || r != 0 {
		t.Fatalf("entries=%d byRelay=%d, want 0/0", e, r)
	}
}

// The absence of an address-keyed retirement hook, made executable. Re-adding
// OnAllocationDeleted reintroduces the misattribution above, and it is a
// two-line change that nothing else in this repository would notice.
func TestNodeEventHandlerHasNoAddressKeyedRetirement(t *testing.T) {
	h := nodeEventHandler(newAllocRegistry(nil))

	if h.OnAllocationDeleted != nil {
		t.Fatal("OnAllocationDeleted is wired again. It carries only srcAddr, dstAddr, protocol, " +
			"username and realm — nothing that says WHICH allocation ended — so a callback " +
			"delayed past a reallocation from the same source port retires the LIVE allocation " +
			"(see TestLateSignalsForARetiredAllocationCannotRetireItsSuccessor). pion also closes " +
			"the relay socket inside DeleteAllocation BEFORE firing it, so it can only ever be " +
			"later and less specific than the Close the registry already uses.")
	}
	if h.OnAllocationCreated == nil {
		t.Fatal("OnAllocationCreated is not wired. It is the only source of the TURN username, " +
			"so without it every relayed byte is counted and none of it can be attributed to " +
			"an account.")
	}
}

// A callback that arrives after the socket has closed AND after the final flush
// evicted the entry must not resurrect anything, or a usage row appears for an
// allocation that is over.
func TestLateCallbackAfterEvictionResurrectsNothing(t *testing.T) {
	reg := newAllocRegistry(nil)
	relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50001}

	c := reg.wrap(fakePC{}, relay)
	reg.created(relay, "6000:userL.1")
	mustClose(t, c)
	reg.snapshot() // final flush + eviction

	reg.created(relay, "6000:userL.1") // late OnAllocationCreated
	if got := reg.activeAllocs(); got != 0 {
		t.Fatalf("after a late callback: activeAllocs = %d, want 0", got)
	}
	if got := reg.snapshot(); len(got) != 0 {
		t.Fatalf("after a late callback: %d samples, want 0", len(got))
	}
	if e, r := indexSizes(reg); e != 0 || r != 0 {
		t.Fatalf("entries=%d byRelay=%d, want 0/0 — a late callback re-indexed a dead allocation", e, r)
	}
}

// ── L3: bytes still in flight when the allocation is retired ─────────────────

// hazardPC runs onIO from INSIDE the socket operation — after the wrapper has
// begun the operation, before it has tallied the bytes the operation is about
// to return. That is the exact window a concurrent Close and heartbeat can land
// in, reproduced without depending on the scheduler.
//
// onIO is armed by the test between operations, so which operation carries the
// hazard is explicit rather than "whichever ran first". Like fakePC, it reports
// len(p) bytes, so every figure in these tests is the size the caller asked for.
type hazardPC struct {
	net.PacketConn
	onIO func()
}

func (h *hazardPC) fire() {
	if h.onIO != nil {
		f := h.onIO
		h.onIO = nil // exactly one operation carries the hazard
		f()
	}
}

func (h *hazardPC) ReadFrom(p []byte) (int, net.Addr, error) {
	h.fire()
	return len(p), &net.UDPAddr{}, nil
}

func (h *hazardPC) WriteTo(p []byte, _ net.Addr) (int, error) {
	h.fire()
	return len(p), nil
}

func (h *hazardPC) Close() error { return nil }

// L3, deterministically. In production the interleaving is: pion's
// packetHandler goroutine returns 500 relayed bytes from the relay socket and
// is descheduled before recording them; the allocation's lifetime timer fires
// on another goroutine and closes the socket; the heartbeat ticker snapshots on
// a third. Without the in-flight guard the snapshot publishes a final total
// short by 500 bytes and evicts the entry the increment is about to land in —
// the bytes are lost, and the customer is not billed for relay the node did.
//
// Rather than race three goroutines and hope, the close and the snapshot are
// driven from inside the socket operation itself, which is that window by
// construction.
func TestFinalSnapshotIncludesBytesStillInFlight(t *testing.T) {
	for _, tc := range []struct {
		name string
		io   func(c net.PacketConn)
	}{
		{"relayed inbound (ReadFrom)", func(c net.PacketConn) { c.ReadFrom(make([]byte, 500)) }},
		{"relayed outbound (WriteTo)", func(c net.PacketConn) { c.WriteTo(make([]byte, 500), &net.UDPAddr{}) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reg := newAllocRegistry(nil)
			relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}

			var (
				c         net.PacketConn
				innerSnap []allocSample
				innerLive int
			)
			hz := &hazardPC{}
			c = reg.wrap(hz, relay)
			reg.created(relay, "6000:userF.1")
			c.WriteTo(make([]byte, 250), &net.UDPAddr{}) // 250 already settled

			// Arm the hazard only now, so it lands on the operation below.
			hz.onIO = func() {
				// Inside the operation: the 500 bytes have left the socket and
				// are NOT in the entry's total yet.
				_ = c.Close()
				innerLive = reg.activeAllocs()
				innerSnap = reg.snapshot()
			}
			tc.io(c) // fires hz.onIO, then tallies 500

			// The count must go to zero the moment the socket closes: it is
			// about liveness, not about accounting.
			if innerLive != 0 {
				t.Fatalf("activeAllocs during the close = %d, want 0", innerLive)
			}
			// The snapshot taken in that window must decline to finalise.
			if len(innerSnap) != 0 {
				t.Fatalf("a snapshot taken while 500 bytes were in flight reported %+v.\n"+
					"It finalised and evicted the entry those bytes were about to land in, so "+
					"they are now unreportable: the allocation's cumulative total reaches "+
					"central 500 bytes short.", innerSnap)
			}

			// The next one reports it whole: 250 settled plus the 500 in flight.
			final := reg.snapshot()
			if len(final) != 1 {
				t.Fatalf("final flush = %d samples, want exactly 1", len(final))
			}
			if final[0].RelayedBytes != 750 {
				t.Fatalf("final sample = %+v, want 750 relayed bytes (250 settled + 500 in flight)", final[0])
			}
			if final[0].Username != "6000:userF.1" {
				t.Fatalf("final sample = %+v, want it attributed to 6000:userF.1", final[0])
			}
			// Still exactly one final sample, not two.
			if got := reg.snapshot(); len(got) != 0 {
				t.Fatalf("second snapshot = %d samples, want 0 — the entry must be evicted by "+
					"the one snapshot that reported it", len(got))
			}
			if e, r := indexSizes(reg); e != 0 || r != 0 {
				t.Fatalf("entries=%d byRelay=%d, want 0/0", e, r)
			}
		})
	}
}

// The same guard must not strand a LIVE allocation. A live entry always has a
// read parked in the relay socket, so an in-flight operation is its normal
// state; only a retired one may be held back.
func TestInFlightIODoesNotSuppressALiveAllocationsSample(t *testing.T) {
	reg := newAllocRegistry(nil)
	relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}

	var innerSnap []allocSample
	hz := &hazardPC{}
	c := reg.wrap(hz, relay)
	reg.created(relay, "6000:userG.1")
	c.WriteTo(make([]byte, 600), &net.UDPAddr{})

	hz.onIO = func() { innerSnap = reg.snapshot() } // no Close: the allocation is live
	c.ReadFrom(make([]byte, 400))

	if len(innerSnap) != 1 || innerSnap[0].RelayedBytes != 600 {
		t.Fatalf("snapshot during a live allocation's in-flight read = %+v, want one sample of "+
			"the 600 bytes settled so far — a live allocation must keep reporting", innerSnap)
	}
	if got := reg.activeAllocs(); got != 1 {
		t.Fatalf("activeAllocs = %d, want 1", got)
	}
	mustClose(t, c)
	if got := reg.snapshot(); len(got) != 1 || got[0].RelayedBytes != 1000 {
		t.Fatalf("final flush = %+v, want one sample of 1000 bytes", got)
	}
}

// L3/L5 under -race: close, relayed I/O and heartbeat snapshots all running at
// once. Every allocation's LAST reported total must be its complete total —
// this asserts the sample CONTENTS, because a converging count that quietly
// drops bytes is the failure this pass exists to rule out.
func TestConcurrentCloseAndSnapshotLoseNoBytes(t *testing.T) {
	const (
		allocs        = 32
		writes        = 20
		bytesPerWrite = 64
		wantPerAlloc  = int64(writes * bytesPerWrite)
	)
	reg := newAllocRegistry(nil)
	conns := make([]net.PacketConn, allocs)
	for i := range conns {
		relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000 + i}
		conns[i] = reg.wrap(fakePC{}, relay)
		reg.created(relay, "6000:user."+strconv.Itoa(i))
	}
	if got := reg.activeAllocs(); got != allocs {
		t.Fatalf("activeAllocs = %d, want %d", got, allocs)
	}

	// One heartbeat goroutine, so "the last sample for this allocID" is a
	// well-defined observation rather than a race between observers. An entry
	// is evicted by the very snapshot that reports it while closed, so its last
	// appearance IS its final flush.
	lastSeen := make(map[string]int64, allocs)
	samples := make(map[string]int, allocs)
	stop := make(chan struct{})
	var beat sync.WaitGroup
	beat.Add(1)
	go func() {
		defer beat.Done()
		for {
			for _, s := range reg.snapshot() {
				lastSeen[s.AllocID] = s.RelayedBytes
				samples[s.AllocID]++
			}
			reg.activeAllocs()
			select {
			case <-stop:
				return
			default:
			}
		}
	}()

	var wg sync.WaitGroup
	for i := range conns {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < writes; j++ {
				conns[i].WriteTo(make([]byte, bytesPerWrite), &net.UDPAddr{})
			}
			_ = conns[i].Close()
			_ = conns[i].Close() // duplicate, from the other retirement path's shape
		}()
	}
	wg.Wait()
	close(stop)
	beat.Wait()

	// Drain whatever the heartbeat did not get to, into the same tally.
	for range 3 {
		for _, s := range reg.snapshot() {
			lastSeen[s.AllocID] = s.RelayedBytes
			samples[s.AllocID]++
		}
	}

	if got := reg.activeAllocs(); got != 0 {
		t.Fatalf("after concurrent close and snapshot: activeAllocs = %d, want 0", got)
	}
	if e, r := indexSizes(reg); e != 0 || r != 0 {
		t.Fatalf("entries=%d byRelay=%d, want 0/0", e, r)
	}
	if len(lastSeen) != allocs {
		t.Fatalf("%d distinct allocations were reported, want %d — one was never flushed at all",
			len(lastSeen), allocs)
	}
	var total int64
	for id, got := range lastSeen {
		if got != wantPerAlloc {
			t.Fatalf("allocation %s: last reported total = %d bytes over %d samples, want %d. "+
				"Its final flush went out short, so those relayed bytes never reach central.",
				id, got, samples[id], wantPerAlloc)
		}
		total += got
	}
	if want := int64(allocs) * wantPerAlloc; total != want {
		t.Fatalf("relayed bytes across every allocation = %d, want %d", total, want)
	}
}

// ── diagnostics ─────────────────────────────────────────────────────────────

// stats() is the breakdown that would have attributed the fleet's stuck
// active_transfers from a node log instead of from pion's source. It exists
// because of what the investigation could NOT establish: which population that
// count was made of. The node kept no per-path record at the time, so the
// incident's trigger is not recoverable now — these fields are what makes the
// same question answerable on the next controlled run.
func TestStatsAttributeUnjoinedRelaySockets(t *testing.T) {
	reg := newAllocRegistry(nil)
	relayA := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}
	relayB := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50001}

	joined := reg.wrap(fakePC{}, relayA)
	reg.created(relayA, "6000:userS.1")
	probe := reg.wrap(fakePC{}, relayB) // a GetRandomEvenPort probe: never joined

	if got := reg.stats(); got != (allocStats{Live: 2, LiveUnjoined: 1}) {
		t.Fatalf("stats with one allocation and one bare socket = %+v, want Live 2 / LiveUnjoined 1", got)
	}

	mustClose(t, probe)
	if got := reg.stats(); got != (allocStats{Live: 1, AwaitingFlush: 1, RetiredUnjoined: 1}) {
		t.Fatalf("stats after the bare socket closed = %+v, want the retirement counted as "+
			"unjoined — that count is what distinguishes 'clients are driving GetRandomEvenPort' "+
			"from 'real allocations are not being retired'", got)
	}

	reg.snapshot() // flush the probe
	if got := reg.stats(); got != (allocStats{Live: 1, RetiredUnjoined: 1}) {
		t.Fatalf("stats after the flush = %+v, want the live allocation only, with the "+
			"cumulative retired-unjoined total preserved", got)
	}

	mustClose(t, joined)
	reg.snapshot()
	if got := reg.stats(); got != (allocStats{RetiredUnjoined: 1}) {
		t.Fatalf("stats once everything is retired = %+v, want an empty registry and a "+
			"RetiredUnjoined that did NOT count the real allocation", got)
	}
}

// The heartbeat diagnostic must not become permanent idle log spam.
//
// RetiredUnjoined is cumulative and never decreases, so the first version's
// condition — report whenever any field is non-zero — meant that a node which
// served ONE EVEN-PORT request logged the same unchanging line every ~30s until
// it restarted. An idle node repeating a constant is not evidence; it is noise
// that trains a reader to skip the line the one time it changes.
//
// So this pins both halves: growth in the cumulative counter is reported, a
// cumulative counter that has not moved is not, and the two transient fields
// are still reported whenever they are present.
func TestHeartbeatDiagnosticReportsGrowthNotAConstant(t *testing.T) {
	reg := newAllocRegistry(nil)
	relayA := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}
	relayB := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50001}
	relayC := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50002}

	// heartbeat runs the condition sendHeartbeat runs, and reports what the log
	// line would have carried.
	heartbeat := func(t *testing.T, want bool, why string) allocStats {
		t.Helper()
		st, report := reg.statsForHeartbeat()
		if report != want {
			t.Fatalf("statsForHeartbeat() reported %v for %+v, want %v — %s", report, st, want, why)
		}
		return st
	}

	heartbeat(t, false, "an empty registry has nothing to say")

	joined := reg.wrap(fakePC{}, relayA)
	reg.created(relayA, "6000:userH.1")
	heartbeat(t, false, "a healthy node with one attributed allocation is quiet")

	// A live unattributed socket is instantaneous news, every time it is seen.
	probe := reg.wrap(fakePC{}, relayB)
	heartbeat(t, true, "a live unattributed relay socket must be reported")
	heartbeat(t, true, "it is still there, so it is still reported")

	// Retiring it grows the cumulative counter AND leaves a transient
	// AwaitingFlush, so this heartbeat reports.
	mustClose(t, probe)
	if st := heartbeat(t, true, "a retirement awaiting its final flush must be reported"); st.RetiredUnjoined != 1 {
		t.Fatalf("reported RetiredUnjoined = %d, want 1", st.RetiredUnjoined)
	}

	// The regression. After the flush nothing is transient any more and the
	// cumulative total has not moved since it was last logged, so every
	// subsequent heartbeat must stay silent — not just the next one.
	reg.snapshot()
	for i := 0; i < 5; i++ {
		heartbeat(t, false, "RetiredUnjoined is cumulative: an unchanged total is not news, and "+
			"reporting it anyway is one log line every ~30s forever")
	}

	// stats() is the read-only view and must not affect any of that.
	if got := reg.stats(); got != (allocStats{Live: 1, RetiredUnjoined: 1}) {
		t.Fatalf("stats() = %+v, want Live 1 / RetiredUnjoined 1", got)
	}
	heartbeat(t, false, "calling stats() must not disturb the heartbeat condition")

	// Growth resumes reporting, carrying the new cumulative total.
	probe2 := reg.wrap(fakePC{}, relayC)
	mustClose(t, probe2)
	reg.snapshot()
	if st := heartbeat(t, true, "the cumulative total grew, which is the signal the line exists for"); st.RetiredUnjoined != 2 {
		t.Fatalf("reported RetiredUnjoined = %d, want 2", st.RetiredUnjoined)
	}
	heartbeat(t, false, "and it goes quiet again at the new total")

	// Retiring a real allocation is not unattributed traffic, so it must not
	// re-open the diagnostic.
	mustClose(t, joined)
	if st := heartbeat(t, true, "AwaitingFlush is transient and is reported while present"); st.RetiredUnjoined != 2 {
		t.Fatalf("retiring an ATTRIBUTED allocation changed RetiredUnjoined to %d, want 2", st.RetiredUnjoined)
	}
	reg.snapshot()
	heartbeat(t, false, "an empty registry with an unchanged cumulative total is quiet again")
}

// ── real pion, end to end ───────────────────────────────────────────────────

// The whole chain against a real pion server built by newTURNServer: a real
// client allocates, relays bytes, and releases the allocation. Nothing here is
// a double — pion decides when to close the relay socket — so this is what
// proves the wiring rather than the registry.
//
// It takes about a second: the release path is a refresh with lifetime 0, not
// an expiry, so nothing waits on pion's allocation lifetime.
func TestRealPionAllocationCloseConvergesToZero(t *testing.T) {
	reg, _, client, clientConn := newTestTURNServer(t)

	relayConn, err := client.Allocate()
	if err != nil {
		t.Fatalf("client.Allocate: %v", err)
	}
	if got := reg.activeAllocs(); got != 1 {
		t.Fatalf("after a real allocation: activeAllocs = %d, want 1", got)
	}

	// Relay a datagram back to the client through its own relayed address, so
	// the allocation has a non-zero final byte total to flush.
	if _, err := relayConn.WriteTo([]byte("relayium"), clientConn.LocalAddr()); err != nil {
		t.Fatalf("relay write: %v", err)
	}

	// The real release path: pion sends REFRESH with lifetime 0, the server
	// deletes the allocation, and Allocation.Close closes the relay socket —
	// which is the countingPacketConn this registry handed it.
	if err := relayConn.Close(); err != nil {
		t.Fatalf("relayConn.Close: %v", err)
	}
	waitForActiveAllocs(t, reg, 0)

	// One final flush, then gone — and no index left behind.
	snap := reg.snapshot()
	if len(snap) != 1 {
		t.Fatalf("final flush = %d samples, want exactly 1", len(snap))
	}
	if snap[0].RelayedBytes <= 0 {
		t.Fatalf("final sample = %+v, want the relayed bytes preserved", snap[0])
	}
	if got := reg.snapshot(); len(got) != 0 {
		t.Fatalf("second snapshot = %d samples, want 0", len(got))
	}
	if e, r := indexSizes(reg); e != 0 || r != 0 {
		t.Fatalf("entries=%d byRelay=%d, want 0/0", e, r)
	}
}

// L4 against real pion: the SAME client socket allocates, releases, and
// allocates again. Both allocations therefore carry an identical five-tuple, so
// this is the address reuse that no address-keyed retirement could survive —
// here driven by pion itself rather than reconstructed.
func TestRealPionSrcAddrReuseAcrossAllocations(t *testing.T) {
	reg, _, serverAddr, realm, secret := startTestTURNServer(t)
	c := dialTURN(t, serverAddr, realm, secret)

	if got := c.allocate(t); got == "" {
		t.Fatal("first allocate reported no XOR-RELAYED-ADDRESS")
	}
	c.release(t)
	waitForActiveAllocs(t, reg, 0)
	reg.snapshot() // flush and evict the first

	// Same client socket, same source port, second allocation.
	if got := c.allocate(t); got == "" {
		t.Fatal("second allocate reported no XOR-RELAYED-ADDRESS")
	}
	if got := reg.activeAllocs(); got != 1 {
		t.Fatalf("after reallocating from the same source port: activeAllocs = %d, want 1 — "+
			"a signal about the FIRST allocation retired the second", got)
	}

	// Give any in-flight pion goroutine from the first allocation a chance to
	// deliver something late before the assertion is trusted.
	time.Sleep(50 * time.Millisecond)
	if got := reg.activeAllocs(); got != 1 {
		t.Fatalf("50ms after reallocating: activeAllocs = %d, want 1", got)
	}

	c.release(t)
	waitForActiveAllocs(t, reg, 0)
}

// L2/L5 through real pion on the shutdown path, where the relay sockets are
// closed by turn.Server's own goroutines.
//
// turn.Server starts one goroutine per PacketConnConfig that runs readLoop and
// then calls allocation.Manager.Close(), which closes every live allocation's
// RelaySocket — the countingPacketConn this registry handed out. Each
// allocation's packetHandler goroutine is meanwhile parked in
// RelaySocket.ReadFrom, and that read fails as soon as the socket closes.
//
// This is a REGRESSION test, not a reproducer: it passes against the pre-fix
// registry too, and is recorded as doing so. What it covers is that the
// retirement, the final flush and the eviction are all correct when the close
// arrives from a goroutine the node does not control, concurrently with a
// packetHandler unwinding.
func TestRealPionServerShutdownRetiresEveryAllocation(t *testing.T) {
	reg, server, client, _ := newTestTURNServer(t)

	relayConn, err := client.Allocate()
	if err != nil {
		t.Fatalf("client.Allocate: %v", err)
	}
	defer relayConn.Close()
	waitForActiveAllocs(t, reg, 1)

	if err := server.Close(); err != nil {
		t.Fatalf("server.Close: %v", err)
	}
	waitForActiveAllocs(t, reg, 0)

	if got := reg.snapshot(); len(got) != 1 {
		t.Fatalf("final flush = %d samples, want exactly 1", len(got))
	}
	if got := reg.snapshot(); len(got) != 0 {
		t.Fatalf("second snapshot = %d samples, want 0", len(got))
	}
	if e, r := indexSizes(reg); e != 0 || r != 0 {
		t.Fatalf("entries=%d byRelay=%d, want 0/0", e, r)
	}
}

// startTestTURNServer builds a real pion TURN server on loopback through the
// production newTURNServer, and returns the registry it reports through plus
// everything a client needs to authenticate to it. Torn down by t.Cleanup.
//
// pion rejects a zero relay port bound, so the relay range is the whole
// ephemeral range: 16384 candidates and pion's own 10 retries make a collision
// with another process or a parallel run of these tests not worth engineering
// around.
func startTestTURNServer(t *testing.T) (reg *allocRegistry, server *turn.Server, serverAddr, realm, turnSecret string) {
	t.Helper()
	realm, turnSecret = "relayium.test", "test-secret"

	udpConn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen turn socket: %v", err)
	}
	serverAddr = udpConn.LocalAddr().String()

	reg = newAllocRegistry(&limits{})
	server, err = newTURNServer(udpConn, "127.0.0.1", 49152, 65535, realm, turnSecret, reg, reg.lim)
	if err != nil {
		udpConn.Close()
		t.Fatalf("newTURNServer: %v", err)
	}
	t.Cleanup(func() { _ = server.Close() })
	return reg, server, serverAddr, realm, turnSecret
}

// newTestTURNServer adds pion's own client, with a valid long-term credential,
// to the server startTestTURNServer builds.
func newTestTURNServer(t *testing.T) (*allocRegistry, *turn.Server, *turn.Client, net.PacketConn) {
	t.Helper()
	reg, server, serverAddr, realm, turnSecret := startTestTURNServer(t)

	username := strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10) + ":pion-test"
	clientConn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen client socket: %v", err)
	}
	t.Cleanup(func() { _ = clientConn.Close() })

	client, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: serverAddr,
		TURNServerAddr: serverAddr,
		Conn:           clientConn,
		Username:       username,
		Password:       longTermPassword(turnSecret, username),
		Realm:          realm,
	})
	if err != nil {
		t.Fatalf("turn.NewClient: %v", err)
	}
	t.Cleanup(client.Close)
	if err := client.Listen(); err != nil {
		t.Fatalf("client.Listen: %v", err)
	}
	return reg, server, client, clientConn
}

// waitForActiveAllocs polls until the count settles, so the assertion does not
// depend on how promptly pion's own goroutines get scheduled.
func waitForActiveAllocs(t *testing.T, reg *allocRegistry, want int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		got := reg.activeAllocs()
		if got == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("10s later: activeAllocs = %d, want %d", got, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
