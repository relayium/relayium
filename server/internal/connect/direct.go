// Package connect establishes a raw byte stream to the peer: it races a direct
// TCP dial/accept and falls back to the server relay. It carries no crypto — the
// caller wraps the returned conn with package secure.
package connect

import (
	"context"
	"errors"
	"net"
	"strconv"
	"time"
)

// LocalCandidates lists publicly-plausible TCP endpoints for this host: every
// non-loopback, non-private, non-link-local interface address at the given
// port, plus an explicit advertise value (host:port) when provided.
func LocalCandidates(port int, advertise string) []string {
	var out []string
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipnet.IP
		if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsPrivate() || ip.IsUnspecified() {
			continue
		}
		out = append(out, net.JoinHostPort(ip.String(), strconv.Itoa(port)))
	}
	if advertise != "" {
		out = append(out, advertise)
	}
	return out
}

// RaceDirect returns the first connection made either by accepting on ln or by
// dialing one of peerCandidates, whichever completes first. Losing connections
// are closed deterministically by a reaper goroutine.
//
// ln.Accept blocks until an inbound connection arrives or ln is closed; it does
// not observe ctx. RaceDirect therefore does not unblock a stuck acceptor on
// its own — callers must arrange for ln to be closed (e.g. defer ln.Close())
// so the internal accept/reaper goroutines can exit.
func RaceDirect(ctx context.Context, ln net.Listener, peerCandidates []string, dialTimeout time.Duration) (net.Conn, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	type result struct {
		c   net.Conn
		err error
	}
	// Buffer == producer count, so every send below is non-blocking and can be
	// unconditional: no send ever needs to race ctx.Done() (which would let a
	// live winner conn get silently dropped instead of reaped).
	total := 1 + len(peerCandidates)
	results := make(chan result, total)

	go func() {
		c, err := ln.Accept()
		results <- result{c, err}
	}()

	var d net.Dialer
	for _, cand := range peerCandidates {
		cand := cand
		go func() {
			dctx, dcancel := context.WithTimeout(ctx, dialTimeout)
			defer dcancel()
			c, err := d.DialContext(dctx, "tcp", cand)
			results <- result{c, err}
		}()
	}

	// reap drains the n results not yet consumed, closing any straggler conn
	// (except the winner). It may block on the acceptor until ln is closed —
	// that's the documented accept caveat above.
	reap := func(n int, winner net.Conn) {
		go func() {
			for i := 0; i < n; i++ {
				lr := <-results
				if lr.c != nil && lr.c != winner {
					lr.c.Close()
				}
			}
		}()
	}

	consumed := 0
	for {
		select {
		case <-ctx.Done():
			reap(total-consumed, nil)
			return nil, errors.New("connect: no direct connection established")
		case r := <-results:
			consumed++
			if r.err == nil && r.c != nil {
				winner := r.c
				cancel() // abort in-flight dials
				reap(total-consumed, winner)
				return winner, nil
			}
			// error result: keep waiting for another candidate / the acceptor
		}
	}
}
