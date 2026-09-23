// SPDX-FileCopyrightText: 2026 The Relayium authors
// SPDX-License-Identifier: MIT

//go:build go1.25

// Relayium local patch tests (see PATCHES.md at the module root). Not upstream.
//
// Every test runs inside a testing/synctest bubble with in-memory relay sockets
// whose reads block on channels, so "every goroutine has finished reacting" is
// an exact condition (synctest.Wait) rather than a sleep, and allocation
// lifetimes run on the bubble's fake clock.
//
// synctest refuses the pre-Go-1.23 asynchronous timer channels this module's
// `go 1.21` line would otherwise select for its test binary. Relayium builds
// this package from a go 1.26 main module, where asynctimerchan=0 is already the
// default, so the directive below makes this package's tests run with the
// product's timer semantics rather than weaker ones.

//go:debug asynctimerchan=0

package allocation

import (
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/pion/logging"
)

var errInjectedRead = errors.New("injected relay read failure")

// memRelay is an in-memory relay socket. ReadFrom blocks until the socket is
// closed or a failure is injected; when hold is non-nil the already-failed read
// is not handed back to the caller until hold is closed, which is how a test
// makes the allocation's packetHandler late.
type memRelay struct {
	mu        sync.Mutex
	closed    chan struct{}
	fail      chan struct{}
	hold      chan struct{}
	holdOnce  sync.Once
	readError chan struct{} // closed once ReadFrom has its error in hand
	closes    atomic.Int32
}

func newMemRelay() *memRelay {
	return &memRelay{
		closed:    make(chan struct{}),
		fail:      make(chan struct{}),
		readError: make(chan struct{}),
	}
}

func (r *memRelay) ReadFrom([]byte) (int, net.Addr, error) {
	var err error
	select {
	case <-r.closed:
		err = net.ErrClosed
	case <-r.fail:
		err = errInjectedRead
	}
	close(r.readError)
	if r.hold != nil {
		<-r.hold
	}

	return 0, nil, err
}

func (r *memRelay) WriteTo(p []byte, _ net.Addr) (int, error) { return len(p), nil }

func (r *memRelay) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closes.Add(1) == 1 {
		close(r.closed)
	}

	return nil
}

func (r *memRelay) release() {
	if r.hold != nil {
		r.holdOnce.Do(func() { close(r.hold) })
	}
}

func (r *memRelay) isClosed() bool {
	select {
	case <-r.closed:
		return true
	default:
		return false
	}
}

func (r *memRelay) LocalAddr() net.Addr              { return &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 3478} }
func (r *memRelay) SetDeadline(time.Time) error      { return nil }
func (r *memRelay) SetReadDeadline(time.Time) error  { return nil }
func (r *memRelay) SetWriteDeadline(time.Time) error { return nil }

// identityHarness is a Manager whose relay sockets are handed out from a queue
// the test fills, and which counts OnAllocationDeleted.
type identityHarness struct {
	m       *Manager
	next    chan *memRelay
	deleted atomic.Int32
	ft      *FiveTuple
	relays  []*memRelay
}

func newIdentityHarness(t *testing.T) *identityHarness {
	t.Helper()
	h := &identityHarness{next: make(chan *memRelay, 4), ft: randomFiveTuple()}
	m, err := NewManager(ManagerConfig{
		LeveledLogger: logging.NewDefaultLoggerFactory().NewLogger("identity-test"),
		AllocatePacketConn: func(string, int) (net.PacketConn, net.Addr, error) {
			r := <-h.next

			return r, r.LocalAddr(), nil
		},
		AllocateConn: func(string, int) (net.Conn, net.Addr, error) { return nil, nil, nil },
		EventHandler: EventHandler{
			OnAllocationDeleted: func(net.Addr, net.Addr, string, string, string) { h.deleted.Add(1) },
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	h.m = m
	// Unblock every reader even when an assertion failed with an allocation
	// orphaned, so a failure is reported as itself rather than as a bubble
	// deadlock that aborts the remaining tests.
	t.Cleanup(func() {
		for _, r := range h.relays {
			r.release()
			_ = r.Close()
		}
		_ = h.m.Close()
	})

	return h
}

func (h *identityHarness) create(t *testing.T, relay *memRelay, lifetime time.Duration) *Allocation {
	t.Helper()
	h.relays = append(h.relays, relay)
	h.next <- relay
	a, err := h.m.CreateAllocation(h.ft, newMemRelay(), 0, lifetime, "user", "realm")
	if err != nil {
		t.Fatalf("CreateAllocation: %v", err)
	}

	return a
}

// I1, reader path: the first allocation's packetHandler returns its read error
// only after a second allocation exists on the same 5-tuple. It must not
// remove, close or report the second.
func TestLateReaderOfDeletedAllocationLeavesSuccessor(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newIdentityHarness(t)
		relay1 := newMemRelay()
		relay1.hold = make(chan struct{})
		first := h.create(t, relay1, time.Hour)

		h.m.DeleteAllocation(h.ft) // the client's Refresh(LIFETIME=0)
		<-relay1.readError         // #1's reader has the error, and is held
		relay2 := newMemRelay()
		second := h.create(t, relay2, time.Hour)
		synctest.Wait()
		if got := h.deleted.Load(); got != 1 {
			t.Fatalf("before the late reader: OnAllocationDeleted fired %d times, want 1", got)
		}

		relay1.release()
		synctest.Wait() // #1's packetHandler has returned

		if got := h.m.GetAllocation(h.ft); got != second {
			t.Fatalf("late reader of #1 removed the live successor: current=%p want %p (#1=%p)", got, second, first)
		}
		if relay2.isClosed() {
			t.Fatal("late reader of #1 closed the live successor's relay socket")
		}
		if got := h.deleted.Load(); got != 1 {
			t.Fatalf("OnAllocationDeleted fired %d times, want 1 (only for #1)", got)
		}
		if got := relay1.closes.Load(); got != 1 {
			t.Fatalf("#1's relay socket closed %d times, want 1", got)
		}

		// I2: an explicit delete of the 5-tuple still ends the current one.
		h.m.DeleteAllocation(h.ft)
		synctest.Wait()
		if h.m.GetAllocation(h.ft) != nil || !relay2.isClosed() || h.deleted.Load() != 2 {
			t.Fatalf("explicit delete of the successor: current=%v closed=%t deleted=%d, want nil/true/2",
				h.m.GetAllocation(h.ft), relay2.isClosed(), h.deleted.Load())
		}
	})
}

// I1, lifetime-timer path: #1's own lifetime callback runs after #1 was
// removed and a successor exists. Close stops the timer, so the late callback
// is replayed by re-arming #1's real timer, whose function is the closure
// CreateAllocation installed for #1; that is exactly the callback that races a
// concurrent Close when Stop comes too late.
func TestLateLifetimeTimerOfDeletedAllocationLeavesSuccessor(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newIdentityHarness(t)
		relay1 := newMemRelay()
		first := h.create(t, relay1, time.Hour)

		h.m.DeleteAllocation(h.ft)
		synctest.Wait() // #1's reader has unwound BEFORE #2 exists: only the timer is late
		relay2 := newMemRelay()
		second := h.create(t, relay2, time.Hour)
		synctest.Wait()

		first.lifetimeTimer.Reset(time.Second)
		time.Sleep(2 * time.Second)
		synctest.Wait() // #1's timer callback has run to completion

		if got := h.m.GetAllocation(h.ft); got != second {
			t.Fatalf("late lifetime timer of #1 removed the live successor: current=%p want %p", got, second)
		}
		if relay2.isClosed() {
			t.Fatal("late lifetime timer of #1 closed the live successor's relay socket")
		}
		if got := h.deleted.Load(); got != 1 {
			t.Fatalf("OnAllocationDeleted fired %d times, want 1", got)
		}

		h.m.DeleteAllocation(h.ft)
		synctest.Wait()
		if got := h.deleted.Load(); got != 2 {
			t.Fatalf("OnAllocationDeleted fired %d times after deleting the successor, want 2", got)
		}
	})
}

// The guarded paths still end the CURRENT allocation: its own lifetime expiry
// and its own relay socket failing each remove, close and report it once, and
// the reader that unwinds afterwards adds nothing.
func TestOwnSignalsStillEndTheCurrentAllocation(t *testing.T) {
	t.Run("lifetime expiry", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			h := newIdentityHarness(t)
			relay := newMemRelay()
			a := h.create(t, relay, 5*time.Second)

			time.Sleep(4 * time.Second)
			synctest.Wait()
			if h.m.GetAllocation(h.ft) != a || relay.isClosed() {
				t.Fatal("allocation ended before its lifetime")
			}

			time.Sleep(2 * time.Second)
			synctest.Wait() // timer callback and the reader it unblocked are done
			if h.m.GetAllocation(h.ft) != nil || !relay.isClosed() {
				t.Fatal("expired allocation still registered or its relay socket still open")
			}
			if got := h.deleted.Load(); got != 1 {
				t.Fatalf("OnAllocationDeleted fired %d times, want exactly 1", got)
			}
			if got := relay.closes.Load(); got != 1 {
				t.Fatalf("relay socket closed %d times, want 1", got)
			}
		})
	})
	t.Run("relay socket read failure", func(t *testing.T) {
		synctest.Test(t, func(t *testing.T) {
			h := newIdentityHarness(t)
			relay := newMemRelay()
			a := h.create(t, relay, time.Hour)

			close(relay.fail)
			synctest.Wait()
			if h.m.GetAllocation(h.ft) != nil || !relay.isClosed() {
				t.Fatalf("allocation whose relay read failed: current=%p (was %p) closed=%t, want nil/true",
					h.m.GetAllocation(h.ft), a, relay.isClosed())
			}
			if got := h.deleted.Load(); got != 1 {
				t.Fatalf("OnAllocationDeleted fired %d times, want exactly 1", got)
			}
			// I4: a further Close of an ended allocation is a no-op.
			if err := a.Close(); err != nil {
				t.Fatalf("second Close: %v", err)
			}
			if got := relay.closes.Load(); got != 1 {
				t.Fatalf("relay socket closed %d times, want 1", got)
			}
		})
	})
}

// Manager.Close (server shutdown) closes every allocation without removing it;
// each reader then removes and reports its own, still exactly once.
func TestManagerCloseStillReportsEachAllocationOnce(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newIdentityHarness(t)
		relay := newMemRelay()
		h.create(t, relay, time.Hour)

		if err := h.m.Close(); err != nil {
			t.Fatalf("Manager.Close: %v", err)
		}
		synctest.Wait()
		if h.m.AllocationCount() != 0 || !relay.isClosed() {
			t.Fatalf("after Manager.Close: count=%d closed=%t, want 0/true", h.m.AllocationCount(), relay.isClosed())
		}
		if got := h.deleted.Load(); got != 1 {
			t.Fatalf("OnAllocationDeleted fired %d times, want exactly 1", got)
		}
	})
}
