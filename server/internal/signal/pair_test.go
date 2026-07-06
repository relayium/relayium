package signal

import (
	"testing"
)

func TestPairRegistryMintValidate(t *testing.T) {
	clock := int64(1000)
	now := func() int64 { return clock }
	r := NewPairRegistry(300, now)

	code, exp := r.MintFor("u")
	if len(code) != 6 {
		t.Fatalf("code = %q, want 6 digits", code)
	}
	for _, c := range code {
		if c < '0' || c > '9' {
			t.Fatalf("code %q has non-digit", code)
		}
	}
	if exp != 1300 {
		t.Fatalf("exp = %d, want 1300", exp)
	}
	if !r.Validate(code) {
		t.Fatal("freshly minted code should validate")
	}
	if r.Validate("000000-bogus") || r.Validate("999999") {
		t.Fatal("unknown code must not validate")
	}

	// Expire it.
	clock = 1300
	if r.Validate(code) {
		t.Fatal("code at exact expiry must be invalid")
	}
}

func TestPairRegistryMintUnique(t *testing.T) {
	clock := int64(1)
	r := NewPairRegistry(300, func() int64 { return clock })
	seen := map[string]bool{}
	for i := 0; i < 500; i++ {
		c, _ := r.MintFor("u")
		if seen[c] {
			t.Fatalf("Mint returned a live duplicate: %s", c)
		}
		seen[c] = true
	}
}

func TestPairRegistryReapDropsExpired(t *testing.T) {
	clock := int64(1000)
	r := NewPairRegistry(300, func() int64 { return clock })
	code, _ := r.MintFor("u")
	clock = 2000
	r.reap()
	r.mu.Lock()
	_, present := r.codes[code]
	r.mu.Unlock()
	if present {
		t.Fatal("reap should delete an expired code")
	}
}

func TestPairRegistryOwner(t *testing.T) {
	var clock int64 = 1000
	r := NewPairRegistry(60, func() int64 { return clock })

	code, exp := r.MintFor("user-abc")
	if exp != 1060 {
		t.Fatalf("exp = %d, want 1060", exp)
	}
	owner, ok := r.OwnerOf(code)
	if !ok || owner != "user-abc" {
		t.Fatalf("OwnerOf = (%q,%v), want (user-abc,true)", owner, ok)
	}
	if !r.Validate(code) {
		t.Fatalf("Validate should be true for a live code")
	}
	// After expiry: no owner, not valid.
	clock = 1060
	if owner, ok := r.OwnerOf(code); ok || owner != "" {
		t.Fatalf("expired OwnerOf = (%q,%v), want ('',false)", owner, ok)
	}
	if r.Validate(code) {
		t.Fatalf("Validate should be false after expiry")
	}
	// Unknown code.
	if _, ok := r.OwnerOf("000000"); ok {
		t.Fatalf("OwnerOf unknown code should be false")
	}
}
