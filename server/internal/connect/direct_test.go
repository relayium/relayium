package connect

import (
	"context"
	"net"
	"testing"
	"time"
)

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
	conn, err := RaceDirect(ctx, ourLn, []string{peerLn.Addr().String()}, 2*time.Second)
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
	conn, err := RaceDirect(ctx, ourLn, []string{"192.0.2.1:9"}, 300*time.Millisecond)
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
