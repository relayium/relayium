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

// Bidi controls print nothing yet reorder what is shown around them: a peer's
// "‮txt.exe" would read as "exe.txt". Every terminal sink that prints a
// peer's name removes them (A10).
func TestTerminalSinksRemoveBidiControls(t *testing.T) {
	name := "report‮txt.exe⁦x⁩‏"
	var buf bytes.Buffer
	reportExit(xfer.Report{Failed: []string{name}}, &buf)
	p := newRecvProgress(&buf)
	p.report(name, 3, 3)
	for _, r := range []string{"‮", "⁦", "⁩", "‏"} {
		if strings.Contains(buf.String(), r) {
			t.Errorf("bidi control %q reached the terminal: %q", r, buf.String())
		}
	}
	if !strings.Contains(buf.String(), "reporttxt.exex") {
		t.Errorf("the visible characters must stay: %q", buf.String())
	}
	if got := displayName("a‮b\x1bc"); got != "abc" {
		t.Errorf("displayName = %q", got)
	}
	if got := peerTextSafe("a‮b\x1bc\r"); got != `ab\x1bc\r` {
		t.Errorf("peerTextSafe = %q", got)
	}
}

// Removing bidi controls must not swallow a raw byte that is not UTF-8: it
// stays visible as an escape, as termtext.Safe shows it.
func TestBidiRemovalKeepsInvalidBytesVisible(t *testing.T) {
	if got := termSafe("a\x9b‮2J"); got != `a\x9b2J` {
		t.Errorf("termSafe = %q", got)
	}
}
