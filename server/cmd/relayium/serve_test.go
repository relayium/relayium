package main

import (
	"io"
	"strings"
	"testing"
)

func TestPromptApprove(t *testing.T) {
	cases := map[string]bool{
		"y\n":     true,
		"Y\n":     true,
		"yes\n":   true,
		"n\n":     false,
		"no\n":    false,
		"\n":      false, // bare Enter ⇒ default no
		"":        false, // EOF ⇒ no
		"maybe\n": false,
	}
	for in, want := range cases {
		if got := promptApprove(strings.NewReader(in), io.Discard, "1.2.3.4:5678", "abc123"); got != want {
			t.Errorf("promptApprove(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestIsFingerprint(t *testing.T) {
	ok := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if !isFingerprint(ok) {
		t.Fatal("valid 64-hex should be accepted")
	}
	for _, bad := range []string{"", "abc", ok + "0" /*65*/, strings.ToUpper(ok) /*uppercase*/, ok[:63] + "g" /*non-hex*/} {
		if isFingerprint(bad) {
			t.Errorf("isFingerprint(%q) = true, want false", bad)
		}
	}
}
