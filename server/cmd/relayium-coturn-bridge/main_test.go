package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/coturnbridge"
	"github.com/relayium/relayium/internal/coturnbridge/wire"
)

// The test binary doubles as the bridge (a real, separately killed process)
// and as a provider holder whose process name is turnserver.
func TestMain(m *testing.M) {
	switch os.Getenv("RELAYIUM_BRIDGE_TEST_ROLE") {
	case "bridge":
		args := os.Args[1:]
		for i, a := range args {
			if a == "--" {
				args = args[i+1:]
				break
			}
		}
		if err := run(args); err != nil {
			fmt.Fprintln(os.Stderr, "bridge:", err)
			os.Exit(1)
		}
		os.Exit(0)
	case "holder":
		for {
			time.Sleep(time.Hour)
		}
	}
	os.Exit(m.Run())
}

// ---- synthetic Redis (RESP2, subscribed mode) ------------------------------

type redis struct {
	ln    net.Listener
	mu    sync.Mutex
	queue []string
	conns []net.Conn
	subs  int
}

func startRedis(t *testing.T) *redis {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	r := &redis{ln: ln}
	t.Cleanup(func() {
		ln.Close()
		r.mu.Lock()
		for _, c := range r.conns {
			c.Close()
		}
		r.mu.Unlock()
	})
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			r.mu.Lock()
			r.conns = append(r.conns, c)
			r.mu.Unlock()
			go r.serve(c)
		}
	}()
	return r
}

func bulk(s string) string { return "$" + strconv.Itoa(len(s)) + "\r\n" + s + "\r\n" }

func (r *redis) publish(ch, payload string) {
	r.mu.Lock()
	r.queue = append(r.queue, "*4\r\n"+bulk("pmessage")+bulk("turn/realm/relayium.com/user/*")+bulk(ch)+bulk(payload))
	r.mu.Unlock()
}

func (r *redis) subscribers() int { r.mu.Lock(); defer r.mu.Unlock(); return r.subs }

func (r *redis) serve(c net.Conn) {
	br := bufio.NewReader(c)
	for {
		l, err := br.ReadString('\n')
		if err != nil {
			return
		}
		n, _ := strconv.Atoi(strings.TrimSpace(l[1:]))
		args := make([]string, n)
		for i := range args {
			br.ReadString('\n')
			a, _ := br.ReadString('\n')
			args[i] = strings.TrimRight(a, "\r\n")
		}
		switch args[0] {
		case "PSUBSCRIBE":
			r.mu.Lock()
			r.subs++
			r.mu.Unlock()
			c.Write([]byte("*3\r\n" + bulk("psubscribe") + bulk(args[1]) + ":1\r\n"))
		case "PING":
			r.mu.Lock()
			out := strings.Join(r.queue, "")
			r.queue = nil
			r.mu.Unlock()
			c.Write([]byte(out + "*2\r\n" + bulk("pong") + bulk(args[1])))
		}
	}
}

// ---- synthetic central: keep-max ledger per allocation ---------------------

type central struct {
	srv        *httptest.Server
	mu         sync.Mutex
	down       bool
	last       map[string]wire.Snapshot // key → latest applied
	accepted   map[string]uint64
	conflicts  int
	redelivery int // same key+seq seen again (absorbed idempotently)
}

func startCentral(t *testing.T) *central {
	c := &central{last: map[string]wire.Snapshot{}, accepted: map[string]uint64{}}
	c.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.down {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		var req wire.Request
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		var resp wire.Response
		for _, s := range req.Snapshots {
			k := s.Key()
			ack := wire.Ack{Key: k, Seq: s.Seq, Hash: s.Hash, Status: wire.AckAccepted}
			if err := s.Validate(); err != nil {
				ack.Status, ack.Reason = wire.AckRejected, err.Error()
			} else if prev, ok := c.last[k]; ok && prev.Seq == s.Seq {
				if prev.Hash != s.Hash {
					ack.Status = wire.AckConflict
					c.conflicts++
				} else {
					c.redelivery++
				}
			} else if ok && prev.Seq > s.Seq {
				ack.Status = wire.AckStale
			}
			if ack.Status == wire.AckAccepted {
				c.last[k] = s
				c.accepted[k] = max(c.accepted[k], s.Cumulative)
			}
			ack.Accepted = c.accepted[k]
			resp.Acks = append(resp.Acks, ack)
		}
		json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(c.srv.Close)
	return c
}

func (c *central) setDown(d bool) { c.mu.Lock(); c.down = d; c.mu.Unlock() }

func (c *central) total() (sum uint64, per map[string]uint64, conflicts, redelivery int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	per = map[string]uint64{}
	for k, v := range c.accepted {
		per[k], sum = v, sum+v
	}
	return sum, per, c.conflicts, c.redelivery
}

// ---- processes ---------------------------------------------------------------

// lockedBuffer collects a child's output; safe to read while it writes.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}
func (l *lockedBuffer) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.b.String() }

type procs struct {
	outs   []*lockedBuffer
	t      *testing.T
	exe    string
	dir    string
	pidf   string
	token  string
	holder *exec.Cmd
}

func startProcs(t *testing.T) *procs {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	p := &procs{t: t, exe: exe, dir: dir, pidf: filepath.Join(dir, "turnserver.pid"), token: filepath.Join(dir, "token")}
	if err := os.WriteFile(p.token, []byte("tok\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A provider holder whose process name is turnserver: a copy of this
	// test binary (identical bytes) under that name.
	holderExe := filepath.Join(dir, "turnserver")
	raw, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(holderExe, raw, 0o700); err != nil {
		t.Fatal(err)
	}
	p.holder = exec.Command(holderExe)
	p.holder.Env = append(os.Environ(), "RELAYIUM_BRIDGE_TEST_ROLE=holder")
	if err := p.holder.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.holder.Process.Kill(); p.holder.Wait() })
	if err := os.WriteFile(p.pidf, []byte(strconv.Itoa(p.holder.Process.Pid)), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func (p *procs) bridge(spool, redisAddr, centralURL string, extra ...string) *exec.Cmd {
	args := append([]string{"-test.run=^$", "--", "run", "-relay-id", "coturn-central", "-realm", "relayium.com",
		"-redis-addr", redisAddr, "-central-url", centralURL, "-token-file", p.token, "-coturn-pidfile", p.pidf,
		"-spool-dir", spool, "-psd-interval", "0", "-report-interval", "50ms", "-barrier-interval", "20ms",
		"-memory-limit-bytes", "0"}, extra...)
	cmd := exec.Command(p.exe, args...)
	cmd.Env = append(os.Environ(), "RELAYIUM_BRIDGE_TEST_ROLE=bridge")
	out := &lockedBuffer{}
	p.outs = append(p.outs, out)
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Start(); err != nil {
		p.t.Fatal(err)
	}
	p.t.Cleanup(func() {
		if cmd.ProcessState == nil {
			cmd.Process.Kill()
			cmd.Wait()
		}
		if p.t.Failed() {
			p.t.Logf("bridge %d output:\n%s", cmd.Process.Pid, out.String())
		}
	})
	return cmd
}

func waitFor(t *testing.T, what string, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func status(dir string) (coturnbridge.Status, bool) {
	b, err := os.ReadFile(filepath.Join(dir, "status.json"))
	if err != nil {
		return coturnbridge.Status{}, false
	}
	var st coturnbridge.Status
	return st, json.Unmarshal(b, &st) == nil
}

// records reads every allocation record of both tiers (only those two
// directories): key → state. strict (the pre-kill gate, central down, nothing
// may disappear): any read failure fails the test. Not strict (the terminal
// scan while the restarted bridge delivers and removes records): a record
// removed between the listing and its read is skipped.
func records(t *testing.T, dir string, strict bool) map[string]string {
	out := map[string]string{}
	for _, d := range []string{dir, filepath.Join(dir, "overflow")} {
		ents, err := os.ReadDir(d)
		if err != nil && strict {
			t.Fatal(err)
		}
		for _, e := range ents {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".alloc.json") {
				continue
			}
			b, err := os.ReadFile(filepath.Join(d, e.Name()))
			if !strict && os.IsNotExist(err) {
				continue // delivered and removed by the running bridge since the listing
			}
			if err != nil {
				t.Fatal(err)
			}
			var a coturnbridge.Alloc
			if err := json.Unmarshal(b, &a); err != nil {
				t.Fatal(err)
			}
			st := "none"
			if a.Snap != nil {
				st = a.Snap.State
			}
			out[a.Key.String()] = st
		}
	}
	return out
}

func sid(i int) string { return fmt.Sprintf("0070000000000000%02d", i) }

// C3: a real bridge process with 5 primary + 3 overflow entries holds eight
// closed allocations (finals, no future counters) while central is down; it
// is SIGKILLed; a new process with central up delivers every final exactly
// once. Named control (overflow 0): the three past the primary are refused,
// counted, and only the five are billed — the test sees the loss.
func TestRealProcessSIGKILLOverflow(t *testing.T) {
	for _, tc := range []struct {
		name      string
		overflow  string
		want      uint64
		refused   int64
		onDisk    int
		overflowN int
	}{
		{"overflow3", "3", 36036, 0, 8, 3},
		{"control-no-overflow", "0", 15015, 3, 5, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := startProcs(t)
			rd := startRedis(t)
			c := startCentral(t)
			c.setDown(true)
			spool := filepath.Join(p.dir, "spool")
			b1 := p.bridge(spool, rd.ln.Addr().String(), c.srv.URL, "-spool-max-entries", "5", "-spool-overflow-max-entries", tc.overflow)
			waitFor(t, "subscribed", 10*time.Second, func() bool { st, ok := status(spool); return ok && st.SubscriptionUp && st.Epoch != "" })
			user := "1790000000:owner0123.g1"
			for i := 1; i <= 8; i++ {
				ch := "turn/realm/relayium.com/user/" + user + "/allocation/" + sid(i) + "/"
				rd.publish(ch+"status", "new lifetime=600, type=UDP, local=a, remote=b, ssl=NONE, cipher=NONE")
				rd.publish(ch+"total_traffic", fmt.Sprintf("rcvp=1, rcvb=%d, sentp=1, sentb=0", 1001*i))
			}
			waitFor(t, "every admitted allocation durable as final", 10*time.Second, func() bool {
				st, ok := status(spool)
				if !ok || st.Unpersisted != 0 || st.RefusedNewKeys != tc.refused || st.Allocations != tc.onDisk {
					return false
				}
				recs := records(t, spool, true)
				if len(recs) != tc.onDisk || st.Overflow.Files != tc.overflowN {
					return false
				}
				for _, s := range recs {
					if s != wire.StateFinal {
						return false
					}
				}
				return true
			})
			if err := b1.Process.Signal(syscall.SIGKILL); err != nil {
				t.Fatal(err)
			}
			err := b1.Wait()
			var ee *exec.ExitError
			if !errors.As(err, &ee) || ee.Sys().(syscall.WaitStatus).Signal() != syscall.SIGKILL {
				t.Fatalf("bridge did not die by SIGKILL: %v", err)
			}
			c.setDown(false)
			b2 := p.bridge(spool, rd.ln.Addr().String(), c.srv.URL, "-spool-max-entries", "5", "-spool-overflow-max-entries", tc.overflow)
			waitFor(t, "delivered and spool empty", 15*time.Second, func() bool {
				sum, _, _, _ := c.total()
				return sum >= tc.want && len(records(t, spool, false)) == 0
			})
			sum, per, conflicts, redelivery := c.total()
			if sum != tc.want || conflicts != 0 {
				t.Fatalf("ledger %d (want %d), conflicts %d", sum, tc.want, conflicts)
			}
			for k, v := range per {
				i, _ := strconv.Atoi(k[len(k)-2:])
				if v != uint64(1001*i) {
					t.Fatalf("%s billed %d, want its final %d", k, v, 1001*i)
				}
			}
			t.Logf("ledger %d over %d allocations; idempotently absorbed redeliveries %d; subscribers seen %d", sum, len(per), redelivery, rd.subscribers())
			st, _ := status(spool)
			if st.RefusedNewKeys != tc.refused {
				t.Fatalf("refusal counter not carried across the kill: %d", st.RefusedNewKeys)
			}
			b2.Process.Signal(syscall.SIGTERM)
			if err := b2.Wait(); err != nil {
				t.Fatalf("graceful stop: %v", err)
			}
			st, _ = status(spool)
			if !st.CleanShutdown {
				t.Fatalf("graceful stop not clean: %+v", st)
			}
		})
	}
}

// C4: the real CLI with a full spool. signal requests closure of coturn
// relay admission (status and log); off does not — and both report the same
// full state, refusal counters and reasons.
func TestRealProcessAdmissionControlModes(t *testing.T) {
	for _, mode := range []string{"signal", "off"} {
		t.Run(mode, func(t *testing.T) {
			p := startProcs(t)
			rd := startRedis(t)
			c := startCentral(t)
			c.setDown(true)
			spool := filepath.Join(p.dir, "spool")
			b := p.bridge(spool, rd.ln.Addr().String(), c.srv.URL, "-spool-max-entries", "1", "-spool-overflow-max-entries", "0", "-admission-control", mode)
			waitFor(t, "subscribed", 10*time.Second, func() bool { st, ok := status(spool); return ok && st.SubscriptionUp && st.Epoch != "" })
			user := "1790000000:owner0123.g1"
			for i := 1; i <= 2; i++ {
				rd.publish("turn/realm/relayium.com/user/"+user+"/allocation/"+sid(i)+"/total_traffic", fmt.Sprintf("rcvp=1, rcvb=%d, sentp=1, sentb=0", 1001*i))
			}
			var st coturnbridge.Status
			waitFor(t, "full with one refusal", 10*time.Second, func() bool {
				var ok bool
				st, ok = status(spool)
				return ok && st.SpoolState == "full" && st.RefusedNewKeys == 1 && st.RefusedEventBytes == 2002
			})
			if st.AdmissionControl != mode || st.AdmissionRequested != (mode == "signal") || !strings.Contains(st.AdmissionReason, "no free spool entry") ||
				len(st.DowngradeBlockers) == 0 {
				t.Fatalf("%s: %+v", mode, st)
			}
			b.Process.Signal(syscall.SIGTERM)
			if err := b.Wait(); err != nil {
				t.Fatalf("stop: %v", err)
			}
			logged := strings.Contains(p.outs[0].String(), "closing coturn relay admission is requested")
			if logged != (mode == "signal") {
				t.Fatalf("%s: closure-request log line present=%v", mode, logged)
			}
		})
	}
}

func runCapture(t *testing.T, args ...string) (string, error) {
	var buf bytes.Buffer
	old := stdout
	stdout = &buf
	defer func() { stdout = old }()
	err := run(args)
	return buf.String(), err
}

func TestLimitsCommand(t *testing.T) {
	out, err := runCapture(t, "limits", "-spool-max-entries", "7", "-spool-overflow-max-entries", "0", "-spool-dead-max-entries", "3")
	if err != nil {
		t.Fatal(err)
	}
	var l struct {
		coturnbridge.Limits
		AdmissionControl string `json:"admissionControl"`
	}
	if err := json.Unmarshal([]byte(out), &l); err != nil {
		t.Fatal(err)
	}
	if l.PrimaryEntries != 7 || l.OverflowEntries != 0 || l.DeadEntries != 3 || l.GoneEntries != 7 || l.AdmissionControl != "signal" || l.WrittenMaxBytes <= 0 {
		t.Fatalf("%+v", l)
	}
	t.Setenv("RELAYIUM_COTURN_SPOOL_MAX_ENTRIES", "9")
	out, _ = runCapture(t, "limits")
	json.Unmarshal([]byte(out), &l)
	if l.PrimaryEntries != 9 || l.OverflowEntries != 2048 {
		t.Fatalf("env: %+v", l)
	}
	t.Setenv("RELAYIUM_COTURN_SPOOL_MAX_ENTRIES", "nine")
	if _, err := runCapture(t, "limits"); err == nil || !strings.Contains(err.Error(), "not an integer") {
		t.Fatalf("malformed env: %v", err)
	}
}

func TestFlagValidation(t *testing.T) {
	for _, args := range [][]string{
		{"limits", "-spool-max-entries", "0"},
		{"limits", "-spool-overflow-max-entries", "-1"},
		{"limits", "-spool-pressure-percent", "101"},
		{"limits", "-admission-control", "enforce"},
		{"limits", "-admission-control", "maybe"},
	} {
		if _, err := runCapture(t, args...); err == nil {
			t.Fatalf("%v accepted", args)
		}
	}
}

func TestSpoolCheckCommand(t *testing.T) {
	dir := t.TempDir()
	if _, err := runCapture(t, "spool-check", "-spool-dir", dir); !isExit(err, 3) {
		t.Fatalf("no status: %v", err) // state unknown: blocker
	}
	os.MkdirAll(filepath.Join(dir, "overflow"), 0o700)
	os.WriteFile(filepath.Join(dir, "status.json"), []byte(`{"updatedUnix":1}`), 0o600)
	before, _ := os.ReadDir(dir)
	if out, err := runCapture(t, "spool-check", "-spool-dir", dir); err != nil || !strings.Contains(out, `"overflowRecords": 0`) {
		t.Fatalf("clean: %v %s", err, out)
	}
	os.WriteFile(filepath.Join(dir, "overflow", "x.alloc.json"), []byte("{}"), 0o600)
	if out, err := runCapture(t, "spool-check", "-spool-dir", dir); !isExit(err, 3) || !strings.Contains(out, "overflow/ holds 1 records") {
		t.Fatalf("overflow: %v %s", err, out)
	}
	after, _ := os.ReadDir(dir)
	if len(after) != len(before) {
		t.Fatal("spool-check changed the directory")
	}
	_ = io.Discard
}

func isExit(err error, code int) bool {
	var ee *exitError
	return errors.As(err, &ee) && ee.code == code
}
