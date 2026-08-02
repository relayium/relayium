package signal

import "testing"

// The pairing-code TTL is a security parameter, not a comfort setting: it is the
// width of the online brute-force window against the 24^6 code space. Pin it so
// widening it again is a deliberate edit to a test that says why, rather than a
// one-character change nobody reviews. See CodeTTLSeconds for the arithmetic.
func TestCodeTTLIsThirtyMinutes(t *testing.T) {
	const want int64 = 30 * 60
	if CodeTTLSeconds != want {
		t.Fatalf("CodeTTLSeconds = %d, want %d — 改宽它就是改宽爆破窗口，先读那个常量上的取舍", CodeTTLSeconds, want)
	}
	// An hour is where the per-IP join limiter (30/min) starts handing a
	// 1000-IP botnet ~1% at a given live code. Past that, lengthen CodeLen
	// instead of the window.
	if CodeTTLSeconds > 3600 {
		t.Errorf("CodeTTLSeconds = %d: 超过一小时应当先加长 CodeLen，而不是继续放宽窗口", CodeTTLSeconds)
	}
}

// Adversarial boundary: expiry is exclusive, so a code must die at exactly
// now+TTL and not one second later. Driven through the real registry at the real
// TTL, because an off-by-one here silently grants an extra second of guessing on
// every code ever minted.
func TestCodeExpiresExactlyAtTheTTLBoundary(t *testing.T) {
	clock := int64(1_000_000)
	r := NewPairRegistry(CodeTTLSeconds, func() int64 { return clock })

	code, exp := r.MintFor("owner-1")
	if code == "" {
		t.Fatal("MintFor returned no code")
	}
	if exp != clock+CodeTTLSeconds {
		t.Fatalf("exp = %d, want %d", exp, clock+CodeTTLSeconds)
	}

	// One second before the boundary: still live, and still attributable.
	clock = exp - 1
	if !r.Validate(code) {
		t.Fatalf("code must still be valid at TTL-1 (t=%d, exp=%d)", clock, exp)
	}
	if owner, ok := r.OwnerOf(code); !ok || owner != "owner-1" {
		t.Fatalf("OwnerOf at TTL-1 = (%q,%v), want (owner-1,true)", owner, ok)
	}

	// Exactly at the boundary: dead, in both admission paths.
	clock = exp
	if r.Validate(code) {
		t.Fatal("code must be invalid at exactly its expiry (expiry is exclusive)")
	}
	if owner, ok := r.OwnerOf(code); ok || owner != "" {
		t.Fatalf("OwnerOf at expiry = (%q,%v), want ('',false)", owner, ok)
	}

	// And a /ws join must be refused there too — Validate is what RoomFor asks.
	if _, _, _, ok := RoomFor(code, r.Validate); ok {
		t.Fatal("RoomFor must refuse an expired code")
	}
}

// The TTL governs ADMISSION only. A code that expires while two peers are
// already paired must not retroactively invalidate the room they are in: the
// room key is derived once, at join time, and nothing re-checks the code
// afterwards. This is the invariant the new 30-minute countdown copy promises
// ("an established transfer is never cut off by it"), so it is pinned here
// rather than left as an emergent property of RoomFor's call sites.
func TestExpiryDoesNotChangeAnEstablishedRoom(t *testing.T) {
	clock := int64(500)
	r := NewPairRegistry(CodeTTLSeconds, func() int64 { return clock })
	code, exp := r.MintFor("owner-1")

	roomAtJoin, maxPeers, lan, ok := RoomFor(code, r.Validate)
	if !ok || lan || roomAtJoin == "" {
		t.Fatalf("RoomFor(live code) = (%q,%d,%v,%v), want a real code room", roomAtJoin, maxPeers, lan, ok)
	}

	// Time passes well beyond expiry; the pair is mid-transfer.
	clock = exp + 10_000
	r.reap()

	// The room identity the live socket is bound to is a pure function of the
	// code, so it is unchanged — the peers stay in the same room. Only a NEW
	// join is refused, which is exactly the intended effect of expiry.
	roomLater, _, _, okLater := RoomFor(code, func(string) bool { return true })
	if roomLater != roomAtJoin {
		t.Fatalf("room key drifted after expiry: %q then %q", roomAtJoin, roomLater)
	}
	if !okLater {
		t.Fatal("room derivation must not depend on registry state")
	}
	if _, _, _, okNew := RoomFor(code, r.Validate); okNew {
		t.Fatal("a fresh join with the expired code must be refused")
	}
}
