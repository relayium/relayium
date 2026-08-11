package signal

import "testing"

// The registry half of the pre-upload lifetime rule.
//
// A pairing code used to die exactly CodeTTLSeconds after it was minted, and
// nothing could move that. Pre-upload needs it to follow the room's join
// deadline instead — a ten-minute upload must not kill its own code at T+5 —
// and every test here pins one of the properties that makes moving it safe:
// owner-bound, forward-only, never a resurrection, and gone for good when the
// room it named is void.
//
// What is deliberately NOT here is a ceiling. The registry has no idea what a
// pair room is; the six-hour bound is pairroom.go's, applied by the caller that
// computes `until`. Putting a second one here would be a second home for the
// rule and the two would drift.

func TestExtendForKeepsAnOwnedCodeAliveBeyondItsMintTTL(t *testing.T) {
	clock := int64(1000)
	r := NewPairRegistry(300, func() int64 { return clock })
	code, exp := r.MintFor("owner-1")
	if exp != 1300 {
		t.Fatalf("minted exp = %d, want 1300", exp)
	}

	// Progress at T+250 buys another 300 seconds.
	clock = 1250
	if !r.ExtendFor(code, "owner-1", 1550) {
		t.Fatal("ExtendFor on a live owned code should report success")
	}

	// The instant the un-extended code would have died.
	clock = 1300
	if !r.Validate(code) {
		t.Fatal("an extended code must still validate past its original mint TTL")
	}
	if owner, ok := r.OwnerOf(code); !ok || owner != "owner-1" {
		t.Fatalf("OwnerOf = %q,%v — an extended code must still resolve to its minter", owner, ok)
	}
	// ...and it dies at the extended deadline, not later.
	clock = 1550
	if r.Validate(code) {
		t.Fatal("an extended code must expire at the deadline it was extended to")
	}
}

func TestExtendForNeverShortensACode(t *testing.T) {
	clock := int64(1000)
	r := NewPairRegistry(300, func() int64 { return clock })
	code, _ := r.MintFor("owner-1")

	// An out-of-order or stale progress report: two chunks of the same batch
	// commit concurrently and the older one lands second. It must not pull the
	// deadline back in under the newer one.
	if !r.ExtendFor(code, "owner-1", 1500) {
		t.Fatal("ExtendFor should succeed")
	}
	if !r.ExtendFor(code, "owner-1", 1100) {
		t.Fatal("a stale extension is not a failure — the code lives at least that long")
	}
	clock = 1400
	if !r.Validate(code) {
		t.Fatal("a stale extension must not shorten a code that was already extended further")
	}
}

func TestExtendForRefusesAnotherAccountsCode(t *testing.T) {
	clock := int64(1000)
	r := NewPairRegistry(300, func() int64 { return clock })
	code, _ := r.MintFor("owner-1")

	if r.ExtendFor(code, "attacker", 9999) {
		t.Fatal("ExtendFor must refuse an account that did not mint the code")
	}
	clock = 1300
	if r.Validate(code) {
		t.Fatal("a refused extension must not have moved the deadline anyway")
	}
}

// The expiry/reaper boundary, from both sides: a code that is already over is
// dead whether or not the reaper has got to it yet, and neither state may be
// extended back to life. Otherwise a late progress report could resurrect digits
// that have already been handed to somebody else.
func TestExtendForNeverResurrectsAnExpiredOrReapedCode(t *testing.T) {
	clock := int64(1000)
	r := NewPairRegistry(300, func() int64 { return clock })
	code, _ := r.MintFor("owner-1")

	clock = 1300 // expired, still in the map
	if r.ExtendFor(code, "owner-1", 2000) {
		t.Fatal("an expired code must not be extendable, reaped or not")
	}
	if r.Validate(code) {
		t.Fatal("a refused extension must leave an expired code expired")
	}

	r.reap()
	if r.ExtendFor(code, "owner-1", 2000) {
		t.Fatal("a reaped code must not be re-created by an extension")
	}
	if r.Validate(code) {
		t.Fatal("extending a reaped code must not put it back in the registry")
	}
	if r.ExtendFor("424242", "owner-1", 2000) {
		t.Fatal("a code that was never minted must not be created by an extension")
	}
}

// Revocation is what makes "the room is void" and "the code is dead" one fact
// rather than two clocks that happen to agree.
func TestRevokeForEndsTheCodeImmediately(t *testing.T) {
	clock := int64(1000)
	r := NewPairRegistry(300, func() int64 { return clock })
	code, _ := r.MintFor("owner-1")
	if !r.ExtendFor(code, "owner-1", 5000) {
		t.Fatal("ExtendFor should succeed")
	}

	if !r.RevokeFor(code, "owner-1", 5000) {
		t.Fatal("RevokeFor should report that it took the code")
	}
	if r.Validate(code) {
		t.Fatal("a revoked code must not validate — a receiver may not join a transfer that is gone")
	}
	if _, ok := r.OwnerOf(code); ok {
		t.Fatal("a revoked code must not resolve to an owner either")
	}
	if r.RevokeFor(code, "owner-1", 5000) {
		t.Fatal("revoking twice must report that there was nothing to take")
	}
}

func TestRevokeForRefusesAnotherAccountsCode(t *testing.T) {
	clock := int64(1000)
	r := NewPairRegistry(300, func() int64 { return clock })
	code, _ := r.MintFor("owner-1")

	if r.RevokeFor(code, "someone-else", 1300) {
		t.Fatal("RevokeFor must refuse an account that did not mint the code")
	}
	if !r.Validate(code) {
		t.Fatal("a refused revocation must leave the code alive")
	}
}

// The recycled-digits case, which is the one that makes revocation dangerous if
// it is done by digits alone: a room's void may run long after its deadline (the
// GC sweep is ten minutes), and by then those six digits can legitimately belong
// to a fresh transfer. A minting that happened AFTER the void'ing room's own
// deadline is exactly what `notAfter` refuses to touch.
func TestRevokeForCannotTakeACodeThatWasMintedAgainSince(t *testing.T) {
	clock := int64(1000)
	r := NewPairRegistry(300, func() int64 { return clock })
	code, _ := r.MintFor("owner-1")
	roomDeadline := int64(1300)

	// The code expires, is reaped, and the same digits are re-minted — to the
	// same account, which is the case owner-matching alone cannot catch.
	clock = 1400
	r.reap()
	r.mu.Lock()
	r.codes[code] = codeEntry{exp: clock + 300, owner: "owner-1"}
	r.mu.Unlock()

	if r.RevokeFor(code, "owner-1", roomDeadline) {
		t.Fatal("RevokeFor must not take digits that have been minted again since the room's deadline")
	}
	if !r.Validate(code) {
		t.Fatal("the new holder's code must survive the previous room's void")
	}
}
