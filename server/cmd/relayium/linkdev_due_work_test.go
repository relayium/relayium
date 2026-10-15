package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/linksession"
)

func TestLinkDevDueWorkRequiresAnActualRunnableOwner(t *testing.T) {
	for _, name := range []string{"held-event", "no-held-event", "unadmitted-file", "unadmitted-sleep", "stale-sleep"} {
		t.Run(name, func(t *testing.T) {
			s, err := linksession.NewSession(linksession.Config{Cmd: linksession.CmdPair, Clock: linkDevClock{}})
			if err != nil {
				t.Fatal(err)
			}
			d := &linkDevDriver{s: s}
			past := time.Now().Add(-time.Millisecond)
			switch name {
			case "held-event":
				ep := s.Epoch()
				d.heldLost, d.heldUntil = &ep, past
			case "no-held-event":
				d.heldUntil = past
			case "unadmitted-file":
				d.outQ = []*ldOut{{notBefore: past}}
			case "unadmitted-sleep":
				d.sleepUntil, d.script = past, []ldCmd{{op: "sleep"}}
			case "stale-sleep":
				d.admitted, d.sleepUntil = true, past
			}
			start := time.Now()
			immediate := !d.nextWake().After(start.Add(100 * time.Millisecond))
			if immediate != (name == "held-event") {
				t.Fatalf("immediate=%v, timer must follow the actual runnable owner", immediate)
			}
		})
	}
}

// Exercise the same progress -> timer-arm boundary as the text regression,
// using real admitted CLI links. The hook advances only the local work mark;
// every protocol timeout and the actual file/text exchange stay unchanged.
func TestLinkDevOverdueLocalWorkWakes(t *testing.T) {
	for _, kind := range []string{"file", "sleep"} {
		t.Run(kind, func(t *testing.T) {
			hub := startLinkDevHub(t)
			var checked, missed, blockedChecked, spun atomic.Bool
			ldHookBeforeWake = func(d *linkDevDriver) {
				if !d.admitted || d.closed {
					return
				}
				if kind == "file" && d.cur != nil {
					fs, _ := d.laneStates()
					if fs == "OutWait" && blockedChecked.CompareAndSwap(false, true) {
						// A queued retry still needs the occupied lane's peer event;
						// an expired mark cannot make that work runnable.
						cur, queue := d.cur, d.outQ
						saved := cur.notBefore
						d.cur, d.outQ = nil, []*ldOut{cur}
						cur.notBefore = time.Now().Add(-time.Millisecond)
						start := time.Now()
						if !d.nextWake().After(start.Add(100 * time.Millisecond)) {
							spun.Store(true)
						}
						d.cur, d.outQ, cur.notBefore = cur, queue, saved
					}
				}
				if checked.Load() {
					return
				}
				var mark *time.Time
				if kind == "file" {
					fs, _ := d.laneStates()
					if d.cur != nil || len(d.outQ) == 0 || fs != "Idle" {
						return
					}
					mark = &d.outQ[0].notBefore
				} else {
					if d.sleepUntil.IsZero() {
						return
					}
					mark = &d.sleepUntil
				}
				if !checked.CompareAndSwap(false, true) {
					return
				}
				*mark = time.Now().Add(-time.Millisecond)
				start := time.Now()
				if d.nextWake().After(start.Add(100 * time.Millisecond)) {
					missed.Store(true)
					// Cleanup wake only AFTER observing a failing timer decision.
					select {
					case d.q.wake <- struct{}{}:
					default:
					}
				}
			}
			t.Cleanup(func() { ldHookBeforeWake = nil })
			src := filepath.Join(t.TempDir(), "due.bin")
			body := []byte(strings.Repeat("full-file-check\x00", 1024))
			if err := os.WriteFile(src, body, 0600); err != nil {
				t.Fatal(err)
			}
			dst := t.TempDir()
			commands := []string{"sleep 1s", "text after deadline"}
			if kind == "file" {
				// The setup hook uses the normal script's queue path, then
				// installs the same local mark a BUSY retry uses before pumpFiles.
				commands = []string{"send " + src, "wait-sent", "text after deadline"}
				ldHookProgress = func(d *linkDevDriver) {
					if d.admitted && d.cur == nil && len(d.script) > 0 && d.script[0].op == "send" && !checked.Load() {
						d.advanceScript() // normal source/manifest/queue path, before pumpFiles
						d.outQ[0].notBefore = time.Now().Add(time.Second)
					}
				}
				t.Cleanup(func() { ldHookProgress = nil })
			}
			a := ldPeer{cmd: "pair", via: hub.url, args: []string{"--yes", "--dest", t.TempDir(), "--script", ldScript(t, commands...), ldCode}}
			b := ldPeer{cmd: "pair", via: hub.url, args: []string{"--yes", "--dest", dst, "--script", ldScript(t, "wait-texts 1"), ldCode}}
			ra, rb := ldPairUp(t, hub, "", a, b)
			if !checked.Load() {
				t.Fatal("local due-work timer boundary was not exercised")
			}
			if missed.Load() {
				t.Error("overdue runnable " + kind + " was left without a timer wake")
			}
			if kind == "file" && (!blockedChecked.Load() || spun.Load()) {
				t.Errorf("blocked file lane: checked=%v spun=%v", blockedChecked.Load(), spun.Load())
			}
			if ra.code != 0 || rb.code != 0 || !strings.Contains(rb.stdout, "after deadline") {
				t.Fatalf("peers did not finish: A=%s B=%s", ra, rb)
			}
			if kind == "file" {
				got, err := os.ReadFile(filepath.Join(dst, "due.bin"))
				if err != nil || string(got) != string(body) {
					t.Fatalf("full file mismatch: bytes=%d err=%v", len(got), err)
				}
			}
		})
	}
}
