package signal

import (
	"testing"
)

func TestPairRegistryMintValidate(t *testing.T) {
	clock := int64(1000)
	now := func() int64 { return clock }
	r := NewPairRegistry(300, now)

	code, exp := r.Mint()
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
		c, _ := r.Mint()
		if seen[c] {
			t.Fatalf("Mint returned a live duplicate: %s", c)
		}
		seen[c] = true
	}
}

func TestPairRegistryReapDropsExpired(t *testing.T) {
	clock := int64(1000)
	r := NewPairRegistry(300, func() int64 { return clock })
	code, _ := r.Mint()
	clock = 2000
	r.reap()
	r.mu.Lock()
	_, present := r.codes[code]
	r.mu.Unlock()
	if present {
		t.Fatal("reap should delete an expired code")
	}
}
