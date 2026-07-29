package account

import "testing"

func TestRelayAddrNormalises(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"plain turn", "turn:198.51.100.7:3478", "198.51.100.7:3478"},
		{"transport variant is the same relay", "turn:198.51.100.7:3478?transport=tcp", "198.51.100.7:3478"},
		{"turn default port", "turn:relay.example", "relay.example:3478"},
		{"turns default port", "turns:relay.example", "relay.example:5349"},
		{"turns explicit port", "turns:relay.example:5349", "relay.example:5349"},
		{"host case folds", "turn:Relay.EXAMPLE:3478", "relay.example:3478"},
		{"scheme case folds", "TURN:relay.example:3478", "relay.example:3478"},
		{"ipv6 with port", "turn:[2001:db8::1]:3478", "[2001:db8::1]:3478"},
		{"ipv6 without port", "turn:[2001:db8::1]", "[2001:db8::1]:3478"},
		{"surrounding space", "  turn:relay.example:3478  ", "relay.example:3478"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := relayAddr(tc.in)
			if !ok {
				t.Fatalf("relayAddr(%q) returned not-ok", tc.in)
			}
			if got != tc.want {
				t.Fatalf("relayAddr(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// Different ports on one host are different relays. Collapsing them would
// silently shrink a pool that legitimately runs two relays on one machine.
func TestRelayAddrDistinguishesPorts(t *testing.T) {
	a, ok := relayAddr("turn:relay.example:3478")
	if !ok {
		t.Fatal("first url did not parse")
	}
	b, ok := relayAddr("turn:relay.example:3479")
	if !ok {
		t.Fatal("second url did not parse")
	}
	if a == b {
		t.Fatalf("ports collapsed: both normalised to %q", a)
	}
}

// Anything unreadable must report not-ok rather than inventing an address.
// A wrong address is worse than no address: it would drop a working relay.
func TestRelayAddrRejectsUnparseable(t *testing.T) {
	for _, in := range []string{
		"",
		"   ",
		"turn:",
		"stun:relay.example:3478",   // not a TURN url
		"relay.example:3478",        // no scheme
		"turn:relay.example:notaport",
		"turn:relay.example:",
		"turn:[2001:db8::1",         // unterminated bracket
		"turn:2001:db8::1:3478",     // bare ipv6, brackets required
		"turn:[2001:db8::1]junk",    // trailing garbage after the bracket
	} {
		if got, ok := relayAddr(in); ok {
			t.Fatalf("relayAddr(%q) = %q, want not-ok", in, got)
		}
	}
}

// relayAddrs drops what it cannot read instead of failing the whole list --
// this is what makes an entry with one odd URL stay in the pool.
func TestRelayAddrsSkipsUnparseable(t *testing.T) {
	got := relayAddrs([]string{"turn:relay.example:3478", "garbage", "turns:other.example"})
	want := []string{"relay.example:3478", "other.example:5349"}
	if len(got) != len(want) {
		t.Fatalf("relayAddrs = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("relayAddrs = %v, want %v", got, want)
		}
	}
}

func TestRelayAddrsEmptyWhenNothingParses(t *testing.T) {
	if got := relayAddrs([]string{"garbage", ""}); len(got) != 0 {
		t.Fatalf("relayAddrs = %v, want empty", got)
	}
}
