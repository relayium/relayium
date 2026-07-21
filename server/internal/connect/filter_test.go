package connect

import (
	"reflect"
	"testing"
)

// Peer-supplied candidates pointing at loopback / link-local (incl. the metadata
// endpoint) / unspecified must be dropped; private (LAN) and public are kept.
func TestFilterPeerCandidates(t *testing.T) {
	in := []string{
		"203.0.113.5:5000",       // public — keep
		"192.168.1.20:5000",      // private (LAN) — keep
		"127.0.0.1:22",           // loopback — drop (localhost probe)
		"169.254.169.254:80",     // link-local metadata endpoint — drop
		"[::1]:443",              // IPv6 loopback — drop
		"0.0.0.0:5000",           // unspecified — drop
		"not-a-host-port",        // malformed — drop
		"peer.example.com:5000",  // hostname — keep (can't classify without resolving)
	}
	got := FilterPeerCandidates(in)
	want := []string{"203.0.113.5:5000", "192.168.1.20:5000", "peer.example.com:5000"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("FilterPeerCandidates = %v, want %v", got, want)
	}
}
