package connect

import (
	"context"
	"io"
	"net"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/secure"
)

// TestRaceDirectGlareConverges exercises the both-sides-reachable "glare" case:
// two peers each listen AND dial the other, forming two independent TCP
// connections. With role-aware preferAccept, both peers must deterministically
// keep the SAME connection (otherwise their pinned-TLS handshakes would fail).
// Verified by round-tripping a byte in both directions on the returned pair —
// which only works if they are the two ends of one connection. Run under
// -count=20 -race so a ~50%-glare regression fails reliably.
func TestRaceDirectGlareConverges(t *testing.T) {
	for i := 0; i < 20; i++ {
		lnA, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		lnB, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)

		type res struct {
			c   net.Conn
			err error
		}
		ra := make(chan res, 1)
		rb := make(chan res, 1)
		// A is the lower-id TLS server → preferAccept true; B is the higher-id
		// client → preferAccept false. Both converge on the B-dialed connection.
		go func() {
			c, err := RaceDirect(ctx, lnA, []string{lnB.Addr().String()}, time.Second, true)
			ra <- res{c, err}
		}()
		go func() {
			c, err := RaceDirect(ctx, lnB, []string{lnA.Addr().String()}, time.Second, false)
			rb <- res{c, err}
		}()
		a := <-ra
		b := <-rb
		if a.err != nil || b.err != nil {
			t.Fatalf("iter %d: A err=%v B err=%v", i, a.err, b.err)
		}

		// a and b must be the two ends of ONE TCP connection: round-trip a byte
		// in both directions. If glare left them on different connections, each
		// far end is closed and these reads fail/hang.
		a.c.SetDeadline(time.Now().Add(2 * time.Second))
		b.c.SetDeadline(time.Now().Add(2 * time.Second))
		buf := make([]byte, 3)
		if _, err := a.c.Write([]byte("a2b")); err != nil {
			t.Fatalf("iter %d: a write: %v", i, err)
		}
		if _, err := io.ReadFull(b.c, buf); err != nil || string(buf) != "a2b" {
			t.Fatalf("iter %d: b read = %q err=%v (conns not paired)", i, buf, err)
		}
		if _, err := b.c.Write([]byte("b2a")); err != nil {
			t.Fatalf("iter %d: b write: %v", i, err)
		}
		if _, err := io.ReadFull(a.c, buf); err != nil || string(buf) != "b2a" {
			t.Fatalf("iter %d: a read = %q err=%v (conns not paired)", i, buf, err)
		}

		a.c.Close()
		b.c.Close()
		lnA.Close()
		lnB.Close()
		cancel()
	}
}

func TestRaceDirectDialSucceeds(t *testing.T) {
	// Peer "server" listens; our RaceDirect should dial in and win.
	peerLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer peerLn.Close()
	go func() {
		c, err := peerLn.Accept()
		if err == nil {
			c.Write([]byte("ok"))
			c.Close()
		}
	}()

	// Our own listener (nobody dials it in this test).
	ourLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ourLn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	// We are the dialer here (nobody dials ourLn): prefer dial so the dial wins.
	conn, err := RaceDirect(ctx, ourLn, []string{peerLn.Addr().String()}, 2*time.Second, false)
	if err != nil {
		t.Fatalf("RaceDirect: %v", err)
	}
	defer conn.Close()
	buf := make([]byte, 2)
	conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := conn.Read(buf); err != nil || string(buf) != "ok" {
		t.Fatalf("read = %q err=%v", buf, err)
	}
}

func TestRaceDirectAcceptSucceeds(t *testing.T) {
	ourLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ourLn.Close()
	// Peer dials us; no reachable peer candidate given.
	go func() {
		time.Sleep(50 * time.Millisecond)
		c, err := net.Dial("tcp", ourLn.Addr().String())
		if err == nil {
			c.Write([]byte("in"))
			c.Close()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	// We are the acceptor here (the only reachable path): prefer accept.
	conn, err := RaceDirect(ctx, ourLn, []string{"192.0.2.1:9"}, 300*time.Millisecond, true)
	if err != nil {
		t.Fatalf("RaceDirect: %v", err)
	}
	defer conn.Close()
	buf := make([]byte, 2)
	conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := conn.Read(buf); err != nil || string(buf) != "in" {
		t.Fatalf("read = %q err=%v", buf, err)
	}
}

func TestLocalCandidatesIncludesAdvertiseAndExcludesLoopback(t *testing.T) {
	cands := LocalCandidates(7777, "203.0.113.5:7777")
	found := false
	for _, c := range cands {
		if c == "203.0.113.5:7777" {
			found = true
		}
		if c == "127.0.0.1:7777" {
			t.Fatalf("loopback leaked into candidates: %v", cands)
		}
	}
	if !found {
		t.Fatalf("advertise not included: %v", cands)
	}
}

func TestRaceDirectMultipleCandidatesConverge(t *testing.T) {
	for i := 0; i < 20; i++ {
		lnA, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		lnB, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)

		type res struct {
			c   net.Conn
			err error
		}
		ra := make(chan res, 1)
		rb := make(chan res, 1)
		// A is the lower-id TLS server → preferAccept true; B is the higher-id
		// client → preferAccept false. Both converge on the B-dialed connection.
		go func() {
			c, err := RaceDirect(ctx, lnA, []string{lnB.Addr().String(), lnB.Addr().String()}, time.Second, true)
			ra <- res{c, err}
		}()
		go func() {
			c, err := RaceDirect(ctx, lnB, []string{lnA.Addr().String(), lnA.Addr().String(), lnA.Addr().String(), lnA.Addr().String()}, time.Second, false)
			rb <- res{c, err}
		}()
		a := <-ra
		b := <-rb
		if a.err != nil || b.err != nil {
			t.Fatalf("iter %d: A err=%v B err=%v", i, a.err, b.err)
		}

		// a and b must be the two ends of ONE TCP connection: round-trip a byte
		// in both directions. If glare left them on different connections, each
		// far end is closed and these reads fail/hang.
		a.c.SetDeadline(time.Now().Add(2 * time.Second))
		b.c.SetDeadline(time.Now().Add(2 * time.Second))
		idA, err := secure.NewIdentity()
		if err != nil {
			t.Fatal(err)
		}
		idB, err := secure.NewIdentity()
		if err != nil {
			t.Fatal(err)
		}
		tlsA := make(chan res, 1)
		go func() { c, err := secure.Server(a.c, idA, idB.Fingerprint); tlsA <- res{c, err} }()
		bc, be := secure.Client(b.c, idB, idA.Fingerprint)
		ac := <-tlsA
		if be != nil || ac.err != nil {
			t.Fatalf("pinned TLS: server %v client %v", ac.err, be)
		}
		a.c, b.c = ac.c, bc

		buf := make([]byte, 3)
		if _, err := a.c.Write([]byte("a2b")); err != nil {
			t.Fatalf("iter %d: a write: %v", i, err)
		}
		if _, err := io.ReadFull(b.c, buf); err != nil || string(buf) != "a2b" {
			t.Fatalf("iter %d: b read = %q err=%v (conns not paired)", i, buf, err)
		}
		if _, err := b.c.Write([]byte("b2a")); err != nil {
			t.Fatalf("iter %d: b write: %v", i, err)
		}
		if _, err := io.ReadFull(a.c, buf); err != nil || string(buf) != "b2a" {
			t.Fatalf("iter %d: a read = %q err=%v (conns not paired)", i, buf, err)
		}

		a.c.Close()
		b.c.Close()
		lnA.Close()
		lnB.Close()
		cancel()
	}
}

// Silent early interfaces still leave time to reach a later candidate, without
// concurrent successful dials to the same listener.
func TestRaceDirectTriesLaterCandidateWithinWindow(t *testing.T) {
	peer, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	own, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer own.Close()
	go func() {
		c, err := peer.Accept()
		if err == nil {
			defer c.Close()
			_, _ = c.Write([]byte("ok"))
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
	defer cancel()
	dial := func(ctx context.Context, network, addr string) (net.Conn, error) {
		if addr == "silent" {
			<-ctx.Done()
			return nil, ctx.Err()
		}
		var d net.Dialer
		return d.DialContext(ctx, network, addr)
	}
	c, err := raceDirect(ctx, own, []string{"silent", "silent", peer.Addr().String()}, time.Second, false, dial)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(time.Second))
	var b [2]byte
	if _, err := io.ReadFull(c, b[:]); err != nil || string(b[:]) != "ok" {
		t.Fatalf("late candidate: %q %v", b, err)
	}
}
