package main

import (
	"fmt"
	"io"
	"math"
	"time"

	"github.com/relayium/relayium/internal/xfer"
)

// syncProgress keeps the output useful for a single large file and for a tree
// of small files. Writes are throttled independently of file boundaries.
func syncProgress(w io.Writer, label string) func(xfer.TransferProgress) {
	interval := 5 * time.Second
	if isTTY(w) {
		interval = time.Second
	}
	var started, last time.Time
	return func(p xfer.TransferProgress) {
		if p.AwaitingResult {
			fmt.Fprintln(w, "Waiting for receiver confirmation...")
			return
		}
		now := time.Now()
		if started.IsZero() {
			started = now
		}
		complete := p.FilesTotal > 0 && p.FilesDone == p.FilesTotal
		if !complete && now.Sub(last) < interval {
			return
		}
		last = now
		fmt.Fprintf(w, "%s %s / %s · %d/%d files", label,
			humanBytes(p.BytesDone), humanBytes(p.BytesTotal), p.FilesDone, p.FilesTotal)
		elapsed := now.Sub(started).Seconds()
		if p.BytesDone > 0 && elapsed >= 0.5 {
			rate := float64(p.BytesDone) / elapsed
			fmt.Fprintf(w, " · %s/s", humanBytes(int64(rate)))
			seconds := float64(p.BytesTotal-p.BytesDone) / rate
			if seconds > 0 && seconds < float64((365*24*time.Hour)/time.Second) {
				fmt.Fprintf(w, " · ETA %s", time.Duration(math.Ceil(seconds))*time.Second)
			}
		}
		if p.Path != "" {
			fmt.Fprintf(w, " · %s", termSafe(p.Path))
		}
		fmt.Fprintln(w)
	}
}
