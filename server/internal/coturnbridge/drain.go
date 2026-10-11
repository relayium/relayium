package coturnbridge

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/relayium/relayium/internal/coturnbridge/wire"
)

// DrainConfig configures Drain.
type DrainConfig struct {
	CLIAddr, CLIPassword, PSDPath string
	SpoolDir                      string
	Epoch                         EpochSource
	Timeout                       time.Duration
	Logf                          func(string, ...any)
}

// Drain makes a planned coturn stop exact. coturn 4.6.1 has no SIGTERM
// handler, so a plain stop publishes no final total for any live allocation.
// Drain instead cancels every live session through the CLI ("cs", which runs
// coturn's forced flush and publishes total_traffic), repeating until a
// complete psd listing is empty, and then waits until the running bridge is
// ready (drainReady): a trusted barrier whose PING was SENT after that empty
// listing has been applied, nothing is held or unpersisted, no allocation of
// this epoch is live or unsealed, and every session Drain cancelled is either
// a spooled or delivered FINAL or — distinctly, not as a final — marked gone
// (its owner account was deleted: nothing is billable, the bytes are
// forgiven, and only the provider key was kept). coturn removes a session from its listing and
// publishes its final asynchronously and unordered, so an empty listing alone
// proves nothing about the finals. A last listing then confirms no new
// session arrived meanwhile (if one did, the cycle repeats); a session
// allocated between that listing and the stop itself is not covered. On
// timeout Drain returns an error naming what is missing: the stop is then
// lossy (lower bounds only).
func Drain(ctx context.Context, cfg DrainConfig) error {
	logf := cfg.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	deadline := time.Now().Add(cfg.Timeout)
	e, err := cfg.Epoch.Read()
	if err != nil {
		return fmt.Errorf("drain: %w", err)
	}
	// Refusal counters at the start: any refusal during the drain means some
	// evidence of this stop was not kept, so the stop cannot be exact.
	base, _, _, err := drainState(cfg.SpoolDir)
	if err != nil {
		return fmt.Errorf("drain: bridge status unreadable: %w", err)
	}
	cli, err := DialCLI(cfg.CLIAddr, cfg.CLIPassword, 10*time.Second)
	if err != nil {
		return fmt.Errorf("drain: %w", err)
	}
	defer cli.Close()
	cancelled := map[string]bool{}
	for {
		var emptyAtMilli int64
		for {
			sessions, err := cli.DumpSessions(cfg.PSDPath, 64<<20)
			if err != nil {
				return fmt.Errorf("drain: %w", err)
			}
			if len(sessions) == 0 {
				// Sessions ParsePSD cannot attribute are not Relayium's and are
				// never billed; they are not waited for.
				emptyAtMilli = time.Now().UnixMilli()
				break
			}
			for _, s := range sessions {
				if err := cli.CancelSession(s.SessionID); err != nil {
					return fmt.Errorf("drain: cancel %s: %w", s.SessionID, err)
				}
				cancelled[s.SessionID] = true
			}
			logf("drain: cancelled %d sessions", len(sessions))
			if time.Now().After(deadline) {
				return fmt.Errorf("drain: sessions still live at timeout")
			}
			if !sleepCtx(ctx, time.Second) {
				return ctx.Err()
			}
		}
		for {
			st, recs, gone, err := drainState(cfg.SpoolDir)
			why := "status unreadable"
			if err == nil {
				why = drainReady(e, emptyAtMilli, cancelled, st, recs, gone)
				spool, final := drainSpoolReady(st, base)
				if final {
					return fmt.Errorf("drain: %s", spool)
				}
				if why == "" {
					why = spool
				}
			} else {
				why += ": " + err.Error()
			}
			if why == "" {
				break
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("drain: bridge not ready at timeout: %s", why)
			}
			if !sleepCtx(ctx, 500*time.Millisecond) {
				return ctx.Err()
			}
		}
		sessions, err := cli.DumpSessions(cfg.PSDPath, 64<<20)
		if err != nil {
			return fmt.Errorf("drain: %w", err)
		}
		if len(sessions) == 0 {
			logf("drain: complete for epoch %s (%d sessions finalized)", e, len(cancelled))
			return nil
		}
		logf("drain: %d new sessions appeared; draining again", len(sessions))
	}
}

// drainReady returns "" when a coturn stop after emptyAtMilli loses nothing
// the bridge can account, or the reason it would.
func drainReady(e Epoch, emptyAtMilli int64, cancelled map[string]bool, st Status, recs map[AllocKey]*Alloc, gone map[AllocKey]bool) string {
	switch {
	case st.Epoch != e.String():
		return fmt.Sprintf("bridge confirms epoch %q, not %q", st.Epoch, e)
	case st.LastTrustedBarrierSentMilli <= emptyAtMilli:
		return fmt.Sprintf("no trusted barrier sent after the empty listing (last sent %d, empty at %d)", st.LastTrustedBarrierSentMilli, emptyAtMilli)
	case st.Unpersisted != 0:
		return fmt.Sprintf("%d records unpersisted", st.Unpersisted)
	case st.Held != 0:
		return fmt.Sprintf("%d allocations held without a snapshot", st.Held)
	}
	for k, a := range recs {
		if k.Epoch != e {
			continue
		}
		if a.State == wire.StateLive || a.Snap == nil || a.Snap.State != a.State {
			return fmt.Sprintf("allocation %s is live or unsealed", k)
		}
	}
	finals := map[string]bool{}
	for _, k := range st.RecentFinals {
		finals[k] = true
	}
	for sid := range cancelled {
		k := AllocKey{Epoch: e, SessionID: sid}
		if finals[k.String()] || gone[k] {
			continue
		}
		a, ok := recs[k]
		if !ok || a.Snap == nil || a.Snap.State != wire.StateFinal {
			return fmt.Sprintf("cancelled session %s has no final yet", sid)
		}
	}
	return ""
}

// drainSpoolReady returns "" when finite holding cannot have cost this drain
// any evidence, or the reason it may have, and whether that reason is final
// (waiting cannot cure it: the stop is not exact).
//
// Capacity alone is NOT loss: a busy spool (primary near its limit, records
// in overflow, even both tiers full) whose cancelled sessions all have a
// durable final or gone mark is exact — drainReady checks those records in
// both tiers. What refuses is uncertainty or loss: allocations not durable,
// evidence refused since the drain began, records in both tiers or unreadable
// records left in place, an incomplete recent-finals list, or failing status
// writes (this status may then be stale).
func drainSpoolReady(st, base Status) (why string, final bool) {
	switch {
	case st.RefusedNewKeys != base.RefusedNewKeys || st.RefusedEvents != base.RefusedEvents ||
		st.RefusedListingSessions != base.RefusedListingSessions || st.QuarantineRefusedMessages != base.QuarantineRefusedMessages:
		return fmt.Sprintf("NOT EXACT: evidence was refused during the drain (refused keys %d->%d, events %d->%d, listing sessions %d->%d, quarantine refusals %d->%d)",
			base.RefusedNewKeys, st.RefusedNewKeys, base.RefusedEvents, st.RefusedEvents, base.RefusedListingSessions, st.RefusedListingSessions,
			base.QuarantineRefusedMessages, st.QuarantineRefusedMessages), true
	case st.DuplicateKeys != 0:
		return fmt.Sprintf("NOT EXACT: %d keys have records in both spool tiers (operator)", st.DuplicateKeys), true
	case st.UnloadedRecords != 0:
		return fmt.Sprintf("NOT EXACT: %d unreadable spool records were left in place unarchived (operator)", st.UnloadedRecords), true
	case st.TempsHeld != 0:
		return fmt.Sprintf("NOT EXACT: %d temporary files of earlier runs are held in place (possibly unique evidence; operator)", st.TempsHeld), true
	case st.TempsStuck != 0:
		return fmt.Sprintf("%d temporary files could not be removed: writes fail closed", st.TempsStuck), false
	case st.AtRisk != 0:
		return fmt.Sprintf("%d allocations at risk (state not durable after a write error)", st.AtRisk), false
	case st.RecentFinalsTruncated:
		return "recent finals truncated: a cancelled session's final may be missing from the list", false
	case st.StatusWriteFailures != base.StatusWriteFailures:
		return fmt.Sprintf("status writes failed during the drain (%d->%d): the status may be stale", base.StatusWriteFailures, st.StatusWriteFailures), false
	}
	return "", false
}

// drainState reads the bridge's status, spool records (both tiers) and gone
// marks without modifying any of them. A key in both tiers is an error.
func drainState(dir string) (Status, map[AllocKey]*Alloc, map[AllocKey]bool, error) {
	var st Status
	raw, err := readCapped(filepath.Join(dir, "status.json"), statusReadMaxBytes)
	if err != nil {
		return st, nil, nil, err
	}
	if err := json.Unmarshal(raw, &st); err != nil {
		return st, nil, nil, err
	}
	gone := map[AllocKey]bool{}
	gents, err := os.ReadDir(filepath.Join(dir, "gone"))
	if err != nil && !os.IsNotExist(err) {
		return st, nil, nil, err
	}
	for _, ent := range gents {
		if ent.IsDir() || !strings.HasSuffix(ent.Name(), spoolExt) {
			continue // temps; marks are named like records (as LoadGone reads them)
		}
		b, err := readCapped(filepath.Join(dir, "gone", ent.Name()), goneMarkMaxBytes)
		if err != nil {
			return st, nil, nil, err
		}
		var m GoneMark
		if err := json.Unmarshal(b, &m); err != nil {
			return st, nil, nil, err
		}
		gone[m.Key] = true
	}
	// Records are read only up to the bridge's configured record limit (from
	// its status; 64 KiB for a status without limits): a larger file is
	// named, never read whole.
	recordMax := st.Limits.RecordMaxBytes
	if recordMax <= 0 {
		recordMax = 64 << 10
	}
	recs := map[AllocKey]*Alloc{}
	for _, d := range []string{dir, filepath.Join(dir, overflowSD)} {
		ents, err := os.ReadDir(d)
		if err != nil {
			if d != dir && os.IsNotExist(err) {
				continue // a spool written before the overflow tier existed
			}
			return st, nil, nil, err
		}
		for _, ent := range ents {
			if ent.IsDir() || !strings.HasSuffix(ent.Name(), spoolExt) {
				continue
			}
			b, err := readCapped(filepath.Join(d, ent.Name()), recordMax)
			if err != nil {
				return st, nil, nil, err
			}
			var a Alloc
			if err := json.Unmarshal(b, &a); err != nil {
				return st, nil, nil, err
			}
			if _, dup := recs[a.Key]; dup {
				return st, nil, nil, fmt.Errorf("allocation %s has a record in both spool tiers", a.Key)
			}
			recs[a.Key] = &a
		}
	}
	return st, recs, gone, nil
}

// readCapped reads p only if its size is at most max, checking the size
// before any read and bounding the read itself; a larger file is a named
// error and nothing of it is read.
func readCapped(p string, max int64) ([]byte, error) {
	fi, err := os.Lstat(p)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file (%v): not read", p, fi.Mode().Type())
	}
	if fi.Size() > max {
		return nil, fmt.Errorf("%s is oversized (%d bytes, limit %d): not read", p, fi.Size(), max)
	}
	return readBounded(p, max)
}
