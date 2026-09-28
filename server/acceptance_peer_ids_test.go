package main

import "testing"

func TestAcceptancePeerIDGeneratorDefaultsToRandomIDs(t *testing.T) {
	gen, err := acceptancePeerIDGenerator("", ":8080", "auto", true)
	if err != nil {
		t.Fatal(err)
	}
	if got := gen(); len(got) != 16 {
		t.Fatalf("generated id length = %d, want 16", len(got))
	}
}

func TestAcceptancePeerIDGeneratorCyclesDeterministicIDsLocally(t *testing.T) {
	gen, err := acceptancePeerIDGenerator(
		"ffffffffffffffff, 0000000000000000",
		"127.0.0.1:0",
		mailTransportDevLogLinks,
		false,
	)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"ffffffffffffffff", "0000000000000000", "ffffffffffffffff"}
	for i, expected := range want {
		if got := gen(); got != expected {
			t.Fatalf("id %d = %q, want %q", i, got, expected)
		}
	}
}

func TestAcceptancePeerIDGeneratorRefusesUnsafeConfiguration(t *testing.T) {
	tests := []struct {
		name      string
		raw       string
		addr      string
		transport string
		release   bool
	}{
		{"public listener", "ffffffffffffffff,0000000000000000", ":8080", mailTransportDevLogLinks, false},
		{"release check", "ffffffffffffffff,0000000000000000", "127.0.0.1:0", mailTransportDevLogLinks, true},
		{"normal mail", "ffffffffffffffff,0000000000000000", "127.0.0.1:0", "auto", false},
		{"malformed id", "not-hex,0000000000000000", "127.0.0.1:0", mailTransportDevLogLinks, false},
		{"one id", "0000000000000000", "127.0.0.1:0", mailTransportDevLogLinks, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := acceptancePeerIDGenerator(tt.raw, tt.addr, tt.transport, tt.release); err == nil {
				t.Fatal("accepted unsafe deterministic peer-id configuration")
			}
		})
	}
}
