package main

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestHumanBytes(t *testing.T) {
	cases := map[int64]string{
		0:          "0 B",
		512:        "512 B",
		1024:       "1.0 KB",
		1536:       "1.5 KB",
		1048576:    "1.0 MB",
		9762611:    "9.3 MB",
		1073741824: "1.0 GB",
	}
	for n, want := range cases {
		if got := humanBytes(n); got != want {
			t.Errorf("humanBytes(%d) = %q, want %q", n, got, want)
		}
	}
}

// clockFrom returns a now() that advances by step on each call, so the TTY
// throttle can be exercised deterministically.
func clockFrom(step time.Duration) func() time.Time {
	base := time.Unix(1_700_000_000, 0)
	var n int64
	return func() time.Time {
		t := base.Add(time.Duration(n) * step)
		n++
		return t
	}
}

func TestProgressNonTTYMilestones(t *testing.T) {
	var buf bytes.Buffer
	p := &progressBar{w: &buf, tty: false, glyph: "⇣", verb: "Downloading", now: clockFrom(time.Second)}
	total := int64(1000)
	for _, d := range []int64{0, 240, 260, 520, 760, 1000} {
		p.update(d, total)
	}
	p.finish()
	out := buf.String()
	for _, want := range []string{"Downloading", "1000 B", "25%", "50%", "75%", "100%"} {
		if !strings.Contains(out, want) {
			t.Fatalf("non-TTY output missing %q; got:\n%s", want, out)
		}
	}
	// A milestone must be printed exactly once even if straddled by two updates.
	if n := strings.Count(out, "25%"); n != 1 {
		t.Fatalf("25%% printed %d times, want 1", n)
	}
	// No carriage-return repaint when not a TTY.
	if strings.Contains(out, "\r") {
		t.Fatalf("non-TTY output should not repaint with CR; got:\n%s", out)
	}
}

func TestProgressTTYSingleLine(t *testing.T) {
	var buf bytes.Buffer
	// 200ms/step clears the 100ms throttle so the second update paints.
	p := &progressBar{w: &buf, tty: true, glyph: "⇣", verb: "Downloading", now: clockFrom(200 * time.Millisecond)}
	p.update(0, 1000)
	p.update(500, 1000)
	p.finish()
	out := buf.String()
	if !strings.Contains(out, "\r") {
		t.Fatalf("TTY output should repaint with CR; got %q", out)
	}
	if !strings.Contains(out, "50%") {
		t.Fatalf("TTY output missing percentage; got %q", out)
	}
	// finish() must clear the line so a following summary starts clean.
	if !strings.HasSuffix(out, "\r\033[K") {
		t.Fatalf("finish() should leave a cleared line; got %q", out)
	}
}

func TestProgressTTYThrottle(t *testing.T) {
	var buf bytes.Buffer
	// 10ms/step: updates after the first are within the 100ms window → throttled.
	p := &progressBar{w: &buf, tty: true, glyph: "⇣", verb: "Downloading", now: clockFrom(10 * time.Millisecond)}
	p.update(0, 1000)
	for i := int64(1); i <= 5; i++ {
		p.update(i*100, 1000)
	}
	// Only the first paint should have happened (one CR); the rest throttled.
	if n := strings.Count(buf.String(), "\r"); n != 1 {
		t.Fatalf("expected 1 paint under throttle, got %d; out=%q", n, buf.String())
	}
}
