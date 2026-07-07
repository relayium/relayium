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
// dialing one of peerCandidates, whichever completes first.
func RaceDirect(ctx context.Context, ln net.Listener, peerCandidates []string, dialTimeout time.Duration) (net.Conn, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	type result struct {
		c   net.Conn
		err error
	}
	results := make(chan result, 1+len(peerCandidates))

	go func() {
		c, err := ln.Accept()
		select {
		case results <- result{c, err}:
		case <-ctx.Done():
			if c != nil {
				c.Close()
			}
		}
	}()

	var d net.Dialer
	for _, cand := range peerCandidates {
		cand := cand
		go func() {
			dctx, dcancel := context.WithTimeout(ctx, dialTimeout)
			defer dcancel()
			c, err := d.DialContext(dctx, "tcp", cand)
			select {
			case results <- result{c, err}:
			case <-ctx.Done():
				if c != nil {
					c.Close()
				}
			}
		}()
	}

	for {
		select {
		case <-ctx.Done():
			return nil, errors.New("connect: no direct connection established")
		case r := <-results:
			if r.err == nil && r.c != nil {
				return r.c, nil
			}
			// keep waiting for another candidate / the acceptor
		}
	}
}
