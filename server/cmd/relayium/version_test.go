package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestVersionCommand(t *testing.T) {
	for _, arg := range []string{"version", "--version", "-version"} {
		var o, e bytes.Buffer
		if rc := Run([]string{arg}, &o, &e); rc != 0 {
			t.Fatalf("%s: rc=%d stderr=%s", arg, rc, e.String())
		}
		if got := strings.TrimSpace(o.String()); got != version {
			t.Fatalf("%s: printed %q, want %q", arg, got, version)
		}
	}
}
