package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/xfer"
)

// On a pull or a receive the failed-file list is the PEER's manifest paths, and
// it is printed where the SAS was. A name must not be able to repaint that line
// or forge a new one.
func TestReportExitPrintsPeerPathsSafely(t *testing.T) {
	esc := string(rune(0x1b))
	var buf bytes.Buffer
	code := reportExit(xfer.Report{Failed: []string{"ok.txt", "x" + esc + "[1A\rverification code (SAS): 000000\n"}}, &buf)
	if code != 1 {
		t.Fatalf("exit = %d", code)
	}
	out := buf.String()
	if strings.Contains(out, esc) || strings.Contains(out, "\r") || strings.Count(out, "\n") != 1 {
		t.Fatalf("peer text drove the terminal: %q", out)
	}
	if !strings.Contains(out, "ok.txt") || !strings.Contains(out, `\x1b[1A\rverification`) {
		t.Fatalf("the names must stay readable: %q", out)
	}
}
