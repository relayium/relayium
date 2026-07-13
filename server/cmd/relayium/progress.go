package main

import (
	"fmt"
	"io"
	"strings"
	"time"

	"golang.org/x/term"
)

// progressBar renders byte-transfer progress. On a TTY it repaints a single
// line in place via CR (throttled to ~10 fps); on a non-TTY (a pipe or CI log)
// it prints a start line and one milestone line per 25% crossed, so the output
// stays readable without control codes. All output goes to w (stderr), keeping
// stdout clean for the command's real result.
type progressBar struct {
	w     io.Writer
	tty   bool
	glyph string // leading symbol, e.g. "⇣" / "⇡"
	verb  string // "Downloading" / "Uploading"

	now func() time.Time // injectable clock (tests); nil → time.Now

	started  bool
	finished bool
	start    time.Time
	last     time.Time // last TTY repaint
	total    int64
	nextPct  int // non-TTY: next milestone still to print
}

// newProgressBar builds a bar writing to w, auto-detecting whether w is a
// terminal.
func newProgressBar(w io.Writer, glyph, verb string) *progressBar {
	return &progressBar{w: w, tty: isTTY(w), glyph: glyph, verb: verb, now: time.Now}
}

// isTTY reports whether w is an interactive terminal. It type-asserts the
// os.File Fd() method, so a bytes.Buffer (tests) or pipe reads as non-TTY.
func isTTY(w io.Writer) bool {
	if f, ok := w.(interface{ Fd() uintptr }); ok {
		return term.IsTerminal(int(f.Fd()))
	}
	return false
}

func (p *progressBar) tnow() time.Time {
	if p.now != nil {
		return p.now()
	}
	return time.Now()
}

// update reports done/total bytes. It is safe to call very frequently: TTY
// repaints are throttled and non-TTY output only emits on milestone crossings.
// total may be 0 (unknown/empty) — then no percentage is shown.
func (p *progressBar) update(done, total int64) {
	t := p.tnow()
	first := !p.started
	if first {
		p.started = true
		p.start = t
		p.last = t
		p.nextPct = 25
		if !p.tty {
			if total > 0 {
				fmt.Fprintf(p.w, "%s %s...\n", p.verb, humanBytes(total))
			} else {
				fmt.Fprintf(p.w, "%s...\n", p.verb)
			}
		}
	}
	p.total = total

	if p.tty {
		if !first && t.Sub(p.last) < 100*time.Millisecond {
			return
		}
		p.last = t
		p.renderTTY(done, total, t)
		return
	}
	if total > 0 {
		for p.nextPct <= 100 && int64(p.nextPct)*total <= done*100 {
			fmt.Fprintf(p.w, "  %d%%  %s\n", p.nextPct, humanBytes(done))
			p.nextPct += 25
		}
	}
}

// renderTTY repaints the single status line: "⇣ 45%  4.2/9.3 MB  1.8 MB/s".
// The leading "\r\033[K" returns to column 0 and clears the old line so a
// shorter update leaves no stale characters.
func (p *progressBar) renderTTY(done, total int64, t time.Time) {
	var b strings.Builder
	b.WriteString("\r\033[K")
	b.WriteString(p.glyph)
	b.WriteByte(' ')
	if total > 0 {
		pct := done * 100 / total
		if pct > 100 {
			pct = 100
		}
		fmt.Fprintf(&b, "%3d%%  %s/%s", pct, humanBytes(done), humanBytes(total))
	} else {
		b.WriteString(humanBytes(done))
	}
	if r := p.rate(done, t); r != "" {
		b.WriteString("  ")
		b.WriteString(r)
	}
	fmt.Fprint(p.w, b.String())
}

// rate returns an average throughput string once enough time has elapsed to be
// meaningful (avoids a wild figure in the first fraction of a second).
func (p *progressBar) rate(done int64, t time.Time) string {
	el := t.Sub(p.start).Seconds()
	if el < 0.2 || done <= 0 {
		return ""
	}
	return humanBytes(int64(float64(done)/el)) + "/s"
}

// finish clears the in-place TTY line so the command's summary line starts
// clean. On a non-TTY it does nothing (milestones already printed). Idempotent.
func (p *progressBar) finish() {
	if p.finished {
		return
	}
	p.finished = true
	if p.tty && p.started {
		fmt.Fprint(p.w, "\r\033[K")
	}
}

// humanBytes formats a byte count with a binary (1024) unit and one decimal.
func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}
