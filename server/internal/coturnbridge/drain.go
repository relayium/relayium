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

// drainState reads the bridge's status, spool records and gone marks
// without modifying any of them.
func drainState(dir string) (Status, map[AllocKey]*Alloc, map[AllocKey]bool, error) {
	var st Status
	raw, err := os.ReadFile(filepath.Join(dir, "status.json"))
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
		b, err := os.ReadFile(filepath.Join(dir, "gone", ent.Name()))
		if err != nil {
			return st, nil, nil, err
		}
		var m GoneMark
		if err := json.Unmarshal(b, &m); err != nil {
			return st, nil, nil, err
		}
		gone[m.Key] = true
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return st, nil, nil, err
	}
	recs := map[AllocKey]*Alloc{}
	for _, ent := range ents {
		if ent.IsDir() || !strings.HasSuffix(ent.Name(), spoolExt) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, ent.Name()))
		if err != nil {
			return st, nil, nil, err
		}
		var a Alloc
		if err := json.Unmarshal(b, &a); err != nil {
			return st, nil, nil, err
		}
		recs[a.Key] = &a
	}
	return st, recs, gone, nil
}
