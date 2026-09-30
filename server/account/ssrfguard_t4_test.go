package account

import (
	"net"
	"testing"
)

// A-L12: reserved IPv4 ranges net.IP's predicates miss, and IPv6 transition
// forms that embed an IPv4 address, must be judged by the IPv4 rules.
func TestIsBlockedIPReservedAndEmbeddedIPv4(t *testing.T) {
	cases := []struct {
		ip      string
		blocked bool
	}{
		{"0.1.2.3", true},             // 0.0.0.0/8
		{"198.18.0.1", true},          // 198.18.0.0/15
		{"198.19.255.254", true},      // 198.18.0.0/15, upper half
		{"198.20.0.1", false},         // just outside
		{"240.0.0.1", true},           // 240.0.0.0/4
		{"255.255.255.255", true},     // limited broadcast
		{"64:ff9b::7f00:1", true},     // NAT64 of 127.0.0.1
		{"64:ff9b::a9fe:a9fe", true},  // NAT64 of 169.254.169.254
		{"64:ff9b::a00:5", true},      // NAT64 of 10.0.0.5
		{"64:ff9b::808:808", false},   // NAT64 of 8.8.8.8
		{"64:ff9b:1::1", true},        // local-use NAT64
		{"2002:7f00:1::", true},       // 6to4 of 127.0.0.1
		{"2002:c0a8:101::1", true},    // 6to4 of 192.168.1.1
		{"2002:a9fe:a9fe::", true},    // 6to4 of 169.254.169.254
		{"2002:808:808::1", false},    // 6to4 of 8.8.8.8
		{"::7f00:1", true},            // IPv4-compatible 127.0.0.1
		{"::a00:1", true},             // IPv4-compatible 10.0.0.1
		{"::a9fe:a9fe", true},         // IPv4-compatible 169.254.169.254
		{"::808:808", false},          // IPv4-compatible 8.8.8.8
		{"::ffff:127.0.0.1", true},    // IPv4-mapped (already covered by To4)
		{"::ffff:198.18.0.1", true},   // IPv4-mapped benchmarking
		{"2606:2800:220:1::1", false}, // ordinary public IPv6
	}
	for _, c := range cases {
		ip := net.ParseIP(c.ip)
		if ip == nil {
			t.Fatalf("bad test IP %q", c.ip)
		}
		if got := isBlockedIP(ip); got != c.blocked {
			t.Errorf("isBlockedIP(%s) = %v, want %v", c.ip, got, c.blocked)
		}
	}
	if err := validateNodeStorageURL("http://[64:ff9b::a9fe:a9fe]/latest/meta-data/", false); err == nil {
		t.Error("NAT64-wrapped metadata literal accepted as a storage URL")
	}
}
