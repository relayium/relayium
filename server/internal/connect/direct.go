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

// FilterPeerCandidates drops candidates that a paired peer must never be able to
// steer us into dialing: loopback (the victim's own localhost services),
// link-local (incl. the cloud metadata endpoint 169.254.169.254), and the
// unspecified address. peerCandidates arrive from the untrusted peer over the
// crossnet handshake, so without this a malicious peer turns our dialer into a
// limited SSRF / internal port-probe (pinned TLS then fails, so no data flows,
// but the reachability probe is the issue). Private (RFC1918) addresses are
// deliberately kept — LAN direct transfer legitimately dials them; a
// non-IP-literal candidate (hostname) is kept too (it can't be classified here
// without resolving, and is not the described attack vector). Apply at the trust
// boundary; RaceDirect itself stays a general mechanism.
func FilterPeerCandidates(cands []string) []string {
	out := cands[:0:0]
	for _, c := range cands {
		host, _, err := net.SplitHostPort(c)
		if err != nil {
			continue // malformed candidate — drop it
		}
		if ip := net.ParseIP(host); ip != nil &&
			(ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified()) {
			continue
		}
		out = append(out, c)
	}
	return out
}

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

// directGracePeriod is how long RaceDirect holds a non-preferred connection,
// waiting for its preferred-kind connection to arrive, before giving up and
// using the held one. Short enough to stay imperceptible, long enough that a
// LAN/loopback preferred connection always beats it when it can exist at all.
const directGracePeriod = 400 * time.Millisecond

// RaceDirect returns a direct connection to the peer, established either by
// accepting on ln or by dialing one of peerCandidates. When both peers are
// publicly reachable, TWO independent TCP connections form (each side dialing
// the other) — "glare". Left uncoordinated, the two peers keep DIFFERENT
// connections ~50% of the time and their pinned-TLS handshakes both fail. To
// converge deterministically, RaceDirect is role-aware:
//
//   - The preferred connection kind is accept when preferAccept is set (this
//     peer is the lower-id TLS server), else dial. Both peers therefore prefer
//     the SAME physical connection: the one dialed by the higher-id peer (a
//     dial for it, an accept for the lower-id peer).
//   - A preferred-kind success wins immediately.
//   - A non-preferred success is HELD for directGracePeriod: if a preferred
//     connection arrives within the grace window it wins (the held one is
//     closed); otherwise the held connection is used. This covers the cases
//     where only one side is reachable, so only one connection kind can ever
//     exist.
//
// Losing connections are closed deterministically by a reaper goroutine.
//
// ln.Accept blocks until an inbound connection arrives or ln is closed; it does
// not observe ctx. RaceDirect therefore does not unblock a stuck acceptor on
// its own — callers must arrange for ln to be closed (e.g. defer ln.Close())
// so the internal accept/reaper goroutines can exit.
func RaceDirect(ctx context.Context, ln net.Listener, peerCandidates []string, dialTimeout time.Duration, preferAccept bool) (net.Conn, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	type result struct {
		c          net.Conn
		err        error
		fromAccept bool
	}
	// Buffer == producer count, so every send below is non-blocking and can be
	// unconditional: no send ever needs to race ctx.Done() (which would let a
	// live winner conn get silently dropped instead of reaped).
	total := 1 + len(peerCandidates)
	results := make(chan result, total)

	go func() {
		c, err := ln.Accept()
		results <- result{c: c, err: err, fromAccept: true}
	}()

	var d net.Dialer
	for _, cand := range peerCandidates {
		cand := cand
		go func() {
			dctx, dcancel := context.WithTimeout(ctx, dialTimeout)
			defer dcancel()
			c, err := d.DialContext(dctx, "tcp", cand)
			results <- result{c: c, err: err, fromAccept: false}
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

	// win finalizes a winner: abort in-flight dials, drain+close the rest.
	win := func(winner net.Conn, consumed int) (net.Conn, error) {
		cancel()
		reap(total-consumed, winner)
		return winner, nil
	}

	var held net.Conn          // a non-preferred success being held during grace
	var grace <-chan time.Time // nil until we start holding

	consumed := 0
	for {
		select {
		case <-ctx.Done():
			if held != nil {
				return win(held, consumed)
			}
			reap(total-consumed, nil)
			return nil, errors.New("connect: no direct connection established")
		case <-grace:
			// Grace expired with no preferred connection: use the held one.
			return win(held, consumed)
		case r := <-results:
			consumed++
			if r.err != nil || r.c == nil {
				continue // error result: keep waiting for another producer
			}
			if r.fromAccept == preferAccept {
				// Preferred kind → win immediately, dropping any held one.
				if held != nil {
					held.Close()
				}
				return win(r.c, consumed)
			}
			// Non-preferred success: hold the first, close any extra.
			if held == nil {
				held = r.c
				grace = time.After(directGracePeriod)
			} else {
				r.c.Close()
			}
		}
	}
}
