package main

import (
	"net"
	"testing"
)

// The empty default must keep producing exactly ":9031" — that is the historical
// all-interface behavior, and changing it would silently narrow every existing
// listener. JoinHostPort is what keeps a literal IPv6 address bracketed.
func TestServeListenAddr(t *testing.T) {
	cases := []struct {
		bind string
		port int
		want string
	}{
		{"", 9031, ":9031"},
		{"127.0.0.1", 9031, "127.0.0.1:9031"},
		{"::1", 9031, "[::1]:9031"},
		{"::", 9031, "[::]:9031"},
		{"10.0.0.5", 0, "10.0.0.5:0"},
		{"receiver.example.com", 9040, "receiver.example.com:9040"},
	}
	for _, c := range cases {
		if got := serveListenAddr(c.bind, c.port); got != c.want {
			t.Errorf("serveListenAddr(%q, %d) = %q, want %q", c.bind, c.port, got, c.want)
		}
	}
}

// --bind must actually restrict the socket. Port 0 lets the OS choose, so this
// asserts the bound IP rather than assuming any particular port is free.
func TestServeListenAddrBindsWhereAsked(t *testing.T) {
	ln, err := net.Listen("tcp", serveListenAddr("127.0.0.1", 0))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	addr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("listener address %v is not TCP", ln.Addr())
	}
	if !addr.IP.IsLoopback() {
		t.Fatalf("bound to %v, want loopback only", addr.IP)
	}
	if addr.IP.IsUnspecified() {
		t.Fatalf("bound to the wildcard address %v despite --bind", addr.IP)
	}
}
