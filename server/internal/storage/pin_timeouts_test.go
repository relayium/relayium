package storage

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

// pinnedClient replaces only the TLS config. Every timeout the caller put on
// its Transport — the handshake one above all, whose absence let a node that
// never finishes TLS hold a caller forever — must survive into the clone.
func TestPinnedClientKeepsTheBaseTransportTimeouts(t *testing.T) {
	base := &http.Client{Transport: &http.Transport{
		ResponseHeaderTimeout: 15 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		ExpectContinueTimeout: time.Second,
	}}
	c := pinnedClient(base, strings.Repeat("cd", 32))
	tr, ok := c.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("pinned transport is %T", c.Transport)
	}
	if tr.TLSHandshakeTimeout != 10*time.Second || tr.ResponseHeaderTimeout != 15*time.Second ||
		tr.IdleConnTimeout != 90*time.Second || tr.ExpectContinueTimeout != time.Second {
		t.Fatalf("pinned clone lost a timeout: handshake=%v header=%v idle=%v continue=%v",
			tr.TLSHandshakeTimeout, tr.ResponseHeaderTimeout, tr.IdleConnTimeout, tr.ExpectContinueTimeout)
	}
	if tr.TLSClientConfig == nil || tr.TLSClientConfig.VerifyPeerCertificate == nil {
		t.Fatal("pinned clone has no pin")
	}
}
