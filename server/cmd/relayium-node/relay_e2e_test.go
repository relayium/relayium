package main

import (
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/pion/turn/v4"
)

// End-to-end through the real pion TURN server: a client can allocate a relay
// address under the cap, but once the node is over its monthly relay cap the
// server's auth handler refuses new allocations.
func TestTURNServerRefusesAllocationOverCap(t *testing.T) {
	udp, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	lim := &limits{}
	reg := newAllocRegistry(lim)
	const secret = "e2e-secret"
	srv, err := newTURNServer(udp, "127.0.0.1", 20000, 30000, "relayium", secret, reg, lim)
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	serverAddr := udp.LocalAddr().String()

	tryAllocate := func() error {
		conn, err := net.ListenPacket("udp4", "127.0.0.1:0")
		if err != nil {
			return err
		}
		defer conn.Close()
		username := fmt.Sprintf("%d:user.code", time.Now().Add(time.Minute).Unix())
		c, err := turn.NewClient(&turn.ClientConfig{
			STUNServerAddr: serverAddr,
			TURNServerAddr: serverAddr,
			Conn:           conn,
			Username:       username,
			Password:       longTermPassword(secret, username),
			Realm:          "relayium",
		})
		if err != nil {
			return err
		}
		defer c.Close()
		if err := c.Listen(); err != nil {
			return err
		}
		relay, err := c.Allocate()
		if err != nil {
			return err
		}
		relay.Close()
		return nil
	}

	// Under cap: allocation succeeds through the real server.
	if err := tryAllocate(); err != nil {
		t.Fatalf("under cap: allocation should succeed, got %v", err)
	}
	// Over cap: the auth handler refuses, so allocation fails.
	lim.sync(1000, 500, 0) // month-to-date 1000 >= traffic cap 500
	if err := tryAllocate(); err == nil {
		t.Fatal("over cap: allocation should be refused by the server")
	}
}
