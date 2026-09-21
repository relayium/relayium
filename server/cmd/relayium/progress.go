package main

import (
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

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
	nextPct  int   // non-TTY: next milestone still to print
	base     int64 // bytes already done when the bar started (a resumed file); not counted in the rate
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
	moved := done - p.base
	if el < 0.2 || moved <= 0 {
		return ""
	}
	return humanBytes(int64(float64(moved)/el)) + "/s"
}

// confirming replaces the bar with what an upload is actually doing once its last
// byte has been handed to the network: waiting for the server to say it has it.
// From a host that writes faster than its path delivers, that wait is most of the
// upload, and a bar frozen just short of 100% reads as a hang. TTY only -- a
// non-TTY has already printed its last milestone, and a fast server would make
// this a line of noise in every log.
func (p *progressBar) confirming() {
	if p.finished || !p.tty || !p.started {
		return
	}
	fmt.Fprintf(p.w, "\r\033[K%s 100%%  %s sent — waiting for the server to confirm…", p.glyph, humanBytes(p.total))
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

// transferProgress adapts xfer's per-file Progress callback — SendOpts.Progress,
// or RecvOpts.Progress when recv is set — to a progressBar. Both are reported the
// same way: from the transfer's own single goroutine, one file at a time, after
// every chunk it writes (send) or accepts from the peer (receive); done is
// cumulative within that file (it starts at the resume offset, not at 0) and
// total is the manifest size. An empty file is never reported. On a send, total
// can be 0 or smaller than done only when the file changed under it, which Send
// then fails; on a receive neither can happen.
//
// Not a TTY: exactly one "  path (N bytes)" line as each file completes — no
// start or milestone lines, so a tree of small files costs a pipe or CI log
// one line per file, never five. TTY: the file in flight additionally gets a
// live in-place bar, cleared before its completion line is printed.
//
// The line says the file's bytes all went through, in either direction. It is
// printed before the receiver has verified them, so a file that then fails its
// integrity check keeps its line and is also named by reportExit, which is what
// sets the exit code.
type transferProgress struct {
	w    io.Writer
	tty  bool
	recv bool             // receiving: "⇣" instead of "⇡" on the bar
	now  func() time.Time // injectable clock (tests); nil → time.Now

	bar  *progressBar // the file in flight; nil between files and when not a TTY
	path string
}

func newSendProgress(w io.Writer) *transferProgress {
	return &transferProgress{w: w, tty: isTTY(w), now: time.Now}
}

func newRecvProgress(w io.Writer) *transferProgress {
	return &transferProgress{w: w, tty: isTTY(w), recv: true, now: time.Now}
}

// report is the xfer.SendOpts.Progress / xfer.RecvOpts.Progress callback.
func (s *transferProgress) report(path string, done, total int64) {
	if s.bar != nil && path != s.path {
		s.finish()
	}
	if done == total {
		s.finish()
		fmt.Fprintf(s.w, "  %s (%d bytes)\n", termSafe(path), total)
		return
	}
	if !s.tty {
		return
	}
	if s.bar == nil {
		glyph, verb := "⇡", "Sending"
		if s.recv {
			glyph, verb = "⇣", "Receiving"
		}
		// base: a resumed file opens at its offset, and counting those bytes
		// would report a transfer rate nothing achieved.
		s.bar = &progressBar{w: s.w, tty: true, glyph: glyph, verb: verb, now: s.now, base: done}
		s.path = path
	}
	s.bar.update(done, total)
}

// finish clears a bar a failed transfer left painted, so the caller's error
// starts on a clean line instead of being glued to it. A completed file has
// already cleared its own; with nothing in flight this does nothing. Idempotent.
func (s *transferProgress) finish() {
	if s.bar != nil {
		s.bar.finish()
		s.bar = nil
	}
}

// termSafe returns path fit to print on a terminal line. On a receive the path
// is the PEER's manifest entry, and the receiving terminal is also where the SAS
// was just printed: an escape sequence in a file name must not be able to move
// the cursor and repaint it, and a newline must not forge a line of output. An
// ordinary name comes back unchanged; control characters, the Unicode line
// separators and bytes that are not UTF-8 come back as visible Go-style escapes.
func termSafe(path string) string {
	clean := utf8.ValidString(path)
	for _, r := range path {
		if termUnsafe(r) {
			clean = false
			break
		}
	}
	if clean {
		return path
	}
	var b strings.Builder
	for i := 0; i < len(path); {
		r, width := utf8.DecodeRuneInString(path[i:])
		switch {
		case r == utf8.RuneError && width == 1:
			fmt.Fprintf(&b, `\x%02x`, path[i])
		case termUnsafe(r):
			q := strconv.QuoteRuneToASCII(r)
			b.WriteString(q[1 : len(q)-1])
		default:
			b.WriteRune(r)
		}
		i += width
	}
	return b.String()
}

func termUnsafe(r rune) bool {
	return unicode.IsControl(r) || r == '\u2028' || r == '\u2029'
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
