// SPDX-FileCopyrightText: 2026 The Relayium authors
// SPDX-License-Identifier: MIT

//go:build !js
// +build !js

// Relayium local patch test fixture (see PATCHES.md at the module root, Patch
// 2). Not upstream.
//
// Upstream's TestClientWithSTUN sends its Binding requests to
// stun1.l.google.com:19302, so it needs DNS and UDP egress and fails after
// retransmitting for ~17 s wherever those are missing. This is the same
// exchange against a responder on 127.0.0.1, so the client-side assertions
// run hermetically.

package turn

import (
	"net"
	"sync"
	"testing"
	"time"

	"github.com/pion/stun/v3"
	"github.com/stretchr/testify/require"
)

// localSTUNResponder answers every well-formed Binding request with a Binding
// success response carrying the request's transaction ID and the sender's
// address as XOR-MAPPED-ADDRESS — what a public STUN server returns. Anything
// else is dropped unanswered, so a client that sends a malformed request
// times out instead of passing.
type localSTUNResponder struct {
	conn net.PacketConn
	done chan struct{}

	mu    sync.Mutex
	txIDs map[[stun.TransactionIDSize]byte]bool
}

// startLocalSTUNResponder listens on an ephemeral 127.0.0.1 UDP port until the
// test ends. Cleanup closes the socket and waits, bounded, for the serving
// goroutine to return, so no responder outlives its test.
func startLocalSTUNResponder(t *testing.T) *localSTUNResponder {
	t.Helper()

	conn, err := net.ListenPacket("udp4", "127.0.0.1:0") // nolint: noctx
	require.NoError(t, err)

	r := &localSTUNResponder{
		conn:  conn,
		done:  make(chan struct{}),
		txIDs: map[[stun.TransactionIDSize]byte]bool{},
	}
	go r.serve()

	t.Cleanup(func() {
		_ = conn.Close()
		select {
		case <-r.done:
		case <-time.After(5 * time.Second):
			t.Error("local STUN responder did not stop within 5s of its socket closing")
		}
	})

	return r
}

func (r *localSTUNResponder) addr() string { return r.conn.LocalAddr().String() }

// answered is the number of distinct transactions the responder replied to
// (a retransmission of an answered transaction is not counted again).
func (r *localSTUNResponder) answered() int {
	r.mu.Lock()
	defer r.mu.Unlock()

	return len(r.txIDs)
}

func (r *localSTUNResponder) serve() {
	defer close(r.done)

	buf := make([]byte, 1500)
	for {
		n, from, err := r.conn.ReadFrom(buf)
		if err != nil {
			return // Socket closed by cleanup.
		}

		req := &stun.Message{Raw: append([]byte(nil), buf[:n]...)}
		if req.Decode() != nil || req.Type != stun.BindingRequest {
			continue
		}
		src, ok := from.(*net.UDPAddr)
		if !ok {
			continue
		}

		resp, err := stun.Build(
			&stun.Message{TransactionID: req.TransactionID},
			stun.BindingSuccess,
			&stun.XORMappedAddress{IP: src.IP, Port: src.Port},
			stun.Fingerprint,
		)
		if err != nil {
			continue
		}

		// Recorded before the reply is sent, so a client that has its answer
		// always sees it counted.
		r.mu.Lock()
		r.txIDs[req.TransactionID] = true
		r.mu.Unlock()

		_, _ = r.conn.WriteTo(resp.Raw, from)
	}
}
