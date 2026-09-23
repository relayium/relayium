package main

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/relayium/relayium/internal/signal"
)

// The hidden `__link` command against the REAL signalling hub (signal.ServeWS,
// with the A08a roster hint), against a hub that predates the hint (a proxy
// that strips it), and against a real CLI binary built from 723481c78, the
// last commit before any link-pairing code: every release in the field speaks
// what that binary speaks.

const ldCode = "483920" // the test hub ignores the code; it must only be well-formed

// ldOldCommit is the old peer. Override with RELAYIUM_OLD_CLI=/path/to/binary.
const ldOldCommit = "723481c78"

// ldHub is the real hub in one pairing-code room (two members, hints honoured
// as on production). Ids are deterministic: peer1, peer2, ... in join order.
type ldHub struct {
	url   string
	joins chan string
}

func startLinkDevHub(t *testing.T) *ldHub {
	t.Helper()
	h := &ldHub{joins: make(chan string, 16)}
	hub := signal.NewHub()
	var seq int32
	handle := signal.ServeWSObserved(hub, func() string { return fmt.Sprintf("peer%d", atomic.AddInt32(&seq, 1)) },
		func(room, id string, peers int, members []string) { h.joins <- id })
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		handle(r.Context(), c, "testroom", 2, "127.0.0.1", false)
		c.Close(websocket.StatusNormalClosure, "")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	h.url = "ws" + strings.TrimPrefix(srv.URL, "http")
	return h
}

// startLinkDevProxy is a TEST-ONLY WebSocket relay in front of the real hub.
//
//   - strip: deletes every `proto` from welcome and peers frames, i.e. a hub
//     that predates A08a (no echo, no roster hint).
//   - holdRoster: holds every `peers` frame toward its client until one
//     `signal` frame has passed, then releases them after it. That makes the
//     race the hub's roster debounce opens in production -- the peer's first
//     signal overtaking our roster -- happen on every run.
func startLinkDevProxy(t *testing.T, upstream string, strip, holdRoster bool) string {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		down, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer down.Close(websocket.StatusNormalClosure, "")
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		u := upstream + "/ws"
		if r.URL.RawQuery != "" {
			u += "?" + r.URL.RawQuery
		}
		up, _, err := websocket.Dial(ctx, u, nil)
		if err != nil {
			return
		}
		defer up.Close(websocket.StatusNormalClosure, "")
		go func() {
			defer cancel()
			for {
				typ, b, err := down.Read(ctx)
				if err != nil {
					return
				}
				if err := up.Write(ctx, typ, b); err != nil {
					return
				}
			}
		}()
		var held [][]byte
		released := !holdRoster
		for {
			typ, b, err := up.Read(ctx)
			if err != nil {
				return
			}
			env, _ := signal.DecodeEnvelope(b)
			if strip && (env.Type == signal.TypeWelcome || env.Type == signal.TypePeers) {
				b = ldStripProto(b)
			}
			if !released && env.Type == signal.TypePeers {
				held = append(held, b)
				continue
			}
			if err := down.Write(ctx, typ, b); err != nil {
				return
			}
			if !released && env.Type == signal.TypeSignal {
				released = true
				for _, h := range held {
					if err := down.Write(ctx, websocket.MessageText, h); err != nil {
						return
					}
				}
				held = nil
			}
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

func ldStripProto(b []byte) []byte {
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return b
	}
	delete(m, "proto")
	if peers, ok := m["peers"].([]any); ok {
		for _, p := range peers {
			if pm, ok := p.(map[string]any); ok {
				delete(pm, "proto")
			}
		}
	}
	out, err := json.Marshal(m)
	if err != nil {
		return b
	}
	return out
}

// ldPeer is one end: the new CLI in process (`__link <cmd>`), or the old
// binary as a real process (`<cmd>`).
type ldPeer struct {
	old  bool
	cmd  string
	args []string
	via  string // the server URL this end dials (hub or proxy)
}

type ldResult struct {
	code           int
	stdout, stderr string
}

func (r ldResult) String() string {
	return fmt.Sprintf("exit %d\n--- stderr\n%s--- stdout\n%s", r.code, r.stderr, r.stdout)
}

func ldStart(ctx context.Context, t *testing.T, bin string, p ldPeer) <-chan ldResult {
	t.Helper()
	ch := make(chan ldResult, 1)
	if !p.old {
		argv := append([]string{"__link", p.cmd, "--server", p.via}, p.args...)
		go func() {
			var out, errb bytes.Buffer
			code := Run(argv, &out, &errb)
			ch <- ldResult{code, out.String(), errb.String()}
		}()
		return ch
	}
	cmd := exec.CommandContext(ctx, bin, append([]string{p.cmd, "--server", p.via}, p.args...)...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	cmd.Env = append(os.Environ(), "HOME="+t.TempDir(), "XDG_CONFIG_HOME="+t.TempDir())
	if p.cmd == "text" {
		cmd.Stdin = strings.NewReader(ldOldText)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start old CLI: %v", err)
	}
	go func() {
		_ = cmd.Wait()
		ch <- ldResult{cmd.ProcessState.ExitCode(), out.String(), errb.String()}
	}()
	return ch
}

// ldPairUp runs first until the hub has admitted it, then second, and waits
// for both.
func ldPairUp(t *testing.T, hub *ldHub, bin string, first, second ldPeer) (ldResult, ldResult) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	a := ldStart(ctx, t, bin, first)
	select {
	case <-hub.joins:
	case <-ctx.Done():
		t.Fatal("first peer never joined")
	}
	b := ldStart(ctx, t, bin, second)
	ra, rb := ldResult{code: -9}, ldResult{code: -9} // -9: still running
	for i := 0; i < 2; i++ {
		select {
		case ra = <-a:
			a = nil
		case rb = <-b:
			b = nil
		case <-ctx.Done():
			// Kills an old binary still running; an in-process end that is
			// still running is reported as such.
			grace := time.After(5 * time.Second)
			for a != nil || b != nil {
				select {
				case ra = <-a:
					a = nil
				case rb = <-b:
					b = nil
				case <-grace:
					a, b = nil, nil
				}
			}
			t.Fatalf("pairing did not end in time\nfirst: %s\nsecond: %s", ra, rb)
		}
	}
	return ra, rb
}

var ldSASLine = regexp.MustCompile(`verification code \(SAS\): (\S+)`)

func ldSAS(r ldResult) string {
	if m := ldSASLine.FindStringSubmatch(r.stderr); m != nil {
		return m[1]
	}
	return ""
}

// ldWantLink: discovery chose link/1 and stopped there, as A08d must.
func ldWantLink(t *testing.T, who string, r ldResult, serverHints bool) {
	t.Helper()
	if r.code != linkDevExitLinkPending || !strings.Contains(r.stderr, "link would be established") {
		t.Errorf("%s: want the link outcome (exit %d)\n%s", who, linkDevExitLinkPending, r)
	}
	if want := fmt.Sprintf("serverHints=%t", serverHints); !strings.Contains(r.stderr, want) {
		t.Errorf("%s: room view lacks %q\n%s", who, want, r)
	}
	if strings.Contains(r.stderr, "verification code") {
		t.Errorf("%s: a link outcome must not run the legacy handshake\n%s", who, r)
	}
}

// ldWantLegacy: both ends completed today's commit/reveal handshake with each
// other -- the same SAS on both, which only a completed commit/reveal with the
// right fingerprints produces -- and then ran today's direct race.
//
// The race itself is out of A08d's scope and is NOT asserted beyond "ended
// with status 0 or 1": between two processes on one host that has TUN or CGNAT
// addresses (a VPN, Tailscale) today's RaceDirect loses the TLS handshake to
// connection glare about one run in five, old binary against old binary alike
// (measured 4/20, a08d-wiring/03-scratch-old-old-direct-race.log), and on a
// host with no public address it fails with "no direct connection". When the
// race succeeds, the callers check the bytes that crossed.
func ldWantLegacy(t *testing.T, ra, rb ldResult) {
	t.Helper()
	sa, sb := ldSAS(ra), ldSAS(rb)
	if sa == "" || sa != sb {
		t.Fatalf("legacy handshake did not complete with one shared SAS (%q vs %q)\n%s\n%s", sa, sb, ra, rb)
	}
	for _, r := range []ldResult{ra, rb} {
		if r.code != 0 && r.code != 1 {
			t.Errorf("after the handshake: want exit 0 or 1\n%s", r)
		}
		if r.code != 0 {
			t.Logf("direct race after the shared SAS did not complete (today's behaviour, not A08d's):\n%s", r)
		}
	}
}

// ldOldText is what the old binary's `text` sends from its (piped) stdin.
const ldOldText = "hello from the old CLI\n"

// ldCheckText: when the direct race succeeded, the new side's `text` printed
// what the old binary sent.
func ldCheckText(t *testing.T, rn ldResult) {
	t.Helper()
	if rn.code == 0 && !strings.Contains(rn.stdout, strings.TrimSpace(ldOldText)) {
		t.Errorf("text session finished but the old side's message never arrived\n%s", rn)
	}
}

func ldSrc(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "payload.txt")
	if err := os.WriteFile(p, []byte("a08d legacy payload\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func ldCheckReceived(t *testing.T, sender, receiver ldResult, dest string) {
	t.Helper()
	if receiver.code != 0 {
		return
	}
	b, err := os.ReadFile(filepath.Join(dest, "payload.txt"))
	if err != nil || string(b) != "a08d legacy payload\n" {
		t.Errorf("transfer reported success but the file is %q (%v)", b, err)
	}
}

// ---------------------------------------------------------------- old binary

// ldOldCLI returns a relayium binary built from ldOldCommit into dir, from
// `git archive` (no worktree is created and the checkout is not touched).
// Skips when the commit is not in the local history (e.g. a shallow CI clone)
// and RELAYIUM_OLD_CLI is unset.
func ldOldCLI(t *testing.T, dir string) string {
	t.Helper()
	if p := os.Getenv("RELAYIUM_OLD_CLI"); p != "" {
		return p
	}
	top, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		t.Skip("not in a git checkout; set RELAYIUM_OLD_CLI")
	}
	root := strings.TrimSpace(string(top))
	if exec.Command("git", "-C", root, "cat-file", "-e", ldOldCommit+"^{commit}").Run() != nil {
		t.Skip(ldOldCommit + " is not in the local history (shallow clone?); set RELAYIUM_OLD_CLI")
	}
	if err := ldExtract(root, dir); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "relayium-old")
	build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", out, "./cmd/relayium")
	build.Dir = filepath.Join(dir, "server")
	build.Env = append(os.Environ(), "CGO_ENABLED=0", "GOFLAGS=-mod=readonly")
	if b, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build old CLI: %v\n%s", err, b)
	}
	// Guard against testing the new CLI by mistake: the old one has no hidden
	// __link and must reject it as an unknown command.
	probe := exec.Command(out, "__link")
	if b, _ := probe.CombinedOutput(); probe.ProcessState.ExitCode() != 2 || !strings.Contains(string(b), "unknown command") {
		t.Fatalf("the binary built from %s knows __link: %s", ldOldCommit, b)
	}
	return out
}

func ldExtract(root, dir string) error {
	cmd := exec.Command("git", "-C", root, "archive", "--format=tar", ldOldCommit, "server")
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	tr := tar.NewReader(pipe)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		name := filepath.Join(dir, filepath.FromSlash(h.Name))
		if !strings.HasPrefix(name, dir+string(os.PathSeparator)) {
			return fmt.Errorf("archive entry escapes: %q", h.Name)
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(name, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(name, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
			if err != nil {
				return err
			}
			_, cerr := io.Copy(f, tr)
			f.Close()
			if cerr != nil {
				return cerr
			}
		}
	}
	return cmd.Wait()
}

// ---------------------------------------------------------------- tests

func TestLinkDevIsHidden(t *testing.T) {
	var out, errb bytes.Buffer
	Run(nil, &out, &errb)
	Run([]string{"--help"}, &out, &errb)
	if strings.Contains(out.String()+errb.String(), "__link") {
		t.Fatal("the hidden __link command appears in the usage text")
	}
	if _, ok := commandUsage["__link"]; ok {
		t.Fatal("__link has a help entry")
	}
}

func TestLinkDevRefusesBadInvocations(t *testing.T) {
	cases := [][]string{
		{"__link"},
		{"__link", "bogus", ldCode},
		{"__link", "pair"},
		{"__link", "pair", ""},           // the code-less LAN room is refused
		{"__link", "pair", "not-a-code"}, // made-up code: never dialled
		{"__link", "receive"},
		{"__link", "text", ldCode, "extra"},
		{"__link", "send", ldSrc(t)}, // __link never mints
	}
	for _, argv := range cases {
		var out, errb bytes.Buffer
		if rc := Run(argv, &out, &errb); rc != 2 {
			t.Errorf("%q: exit %d, want 2\n%s", argv, rc, errb.String())
		}
	}
}

// New ↔ new on the real hub with hints: every combination of commands links,
// and the two ends take opposite link roles. The room view comes from the real
// A08a hub (welcome echo, peer hint), not a stand-in.
func TestLinkDevNewToNewWithHints(t *testing.T) {
	pairs := [][2]string{{"pair", "pair"}, {"send", "receive"}, {"receive", "send"}, {"text", "text"}, {"pair", "text"}}
	for _, pc := range pairs {
		t.Run(pc[0]+"-"+pc[1], func(t *testing.T) {
			t.Parallel()
			hub := startLinkDevHub(t)
			a := ldPeer{cmd: pc[0], via: hub.url}
			b := ldPeer{cmd: pc[1], via: hub.url}
			for _, p := range []*ldPeer{&a, &b} {
				switch p.cmd {
				case "send":
					p.args = []string{ldSrc(t), ldCode}
				case "receive":
					p.args = []string{ldCode, t.TempDir()}
				default:
					p.args = []string{ldCode}
				}
			}
			ra, rb := ldPairUp(t, hub, "", a, b)
			ldWantLink(t, "first", ra, true)
			ldWantLink(t, "second", rb, true)
			for _, r := range []ldResult{ra, rb} {
				if !strings.Contains(r.stderr, "peerHint=true") {
					t.Errorf("the real hub did not carry the peer's hint\n%s", r)
				}
			}
			roles := ldRole(ra) + "/" + ldRole(rb)
			if roles != "initiator/responder" && roles != "responder/initiator" {
				t.Errorf("link roles %s, want one of each", roles)
			}
		})
	}
}

func ldRole(r ldResult) string {
	switch {
	case strings.Contains(r.stderr, "link/1, initiator"):
		return "initiator"
	case strings.Contains(r.stderr, "link/1, responder"):
		return "responder"
	}
	return "?"
}

// New ↔ new on a hub that predates hints (proxy strips them): `pair` still
// links (both greet); `send`/`receive`/`text` keep today's legacy wire; a
// `pair` meeting a legacy-mode CLI ends on both sides at once.
func TestLinkDevNewToNewWithoutHints(t *testing.T) {
	t.Run("pair-pair", func(t *testing.T) {
		t.Parallel()
		hub := startLinkDevHub(t)
		via := startLinkDevProxy(t, hub.url, true, false)
		ra, rb := ldPairUp(t, hub, "",
			ldPeer{cmd: "pair", args: []string{ldCode}, via: via},
			ldPeer{cmd: "pair", args: []string{ldCode}, via: via})
		ldWantLink(t, "first", ra, false)
		ldWantLink(t, "second", rb, false)
	})
	t.Run("send-receive", func(t *testing.T) {
		t.Parallel()
		hub := startLinkDevHub(t)
		via := startLinkDevProxy(t, hub.url, true, false)
		dest := t.TempDir()
		ra, rb := ldPairUp(t, hub, "",
			ldPeer{cmd: "send", args: []string{ldSrc(t), ldCode}, via: via},
			ldPeer{cmd: "receive", args: []string{ldCode, dest}, via: via})
		for _, r := range []ldResult{ra, rb} {
			if !strings.Contains(r.stderr, "serverHints=false") {
				t.Errorf("stripped hub read as hinted\n%s", r)
			}
		}
		ldWantLegacy(t, ra, rb)
		ldCheckReceived(t, ra, rb, dest)
	})
	t.Run("text-text", func(t *testing.T) {
		t.Parallel()
		hub := startLinkDevHub(t)
		via := startLinkDevProxy(t, hub.url, true, false)
		ra, rb := ldPairUp(t, hub, "",
			ldPeer{cmd: "text", args: []string{ldCode}, via: via},
			ldPeer{cmd: "text", args: []string{ldCode}, via: via})
		ldWantLegacy(t, ra, rb)
	})
	t.Run("pair-receive", func(t *testing.T) {
		t.Parallel()
		hub := startLinkDevHub(t)
		via := startLinkDevProxy(t, hub.url, true, false)
		ra, rb := ldPairUp(t, hub, "",
			ldPeer{cmd: "pair", args: []string{ldCode}, via: via},
			ldPeer{cmd: "receive", args: []string{ldCode, t.TempDir()}, via: via})
		if ra.code != 1 || !strings.Contains(ra.stderr, "legacy CLI handshake after our link hello") {
			t.Errorf("pair: want the legacy-after-hello refusal\n%s", ra)
		}
		if rb.code != 1 || !strings.Contains(rb.stderr, "app or the web page") {
			t.Errorf("receive: want today's not-a-CLI refusal for a link hello\n%s", rb)
		}
	})
}

// New ↔ a real old CLI binary, both modes, both roles and both join orders,
// on the hinted hub and on a hub without hints. Legacy must be exactly today's
// wire: one shared SAS from the unchanged old handshake.
func TestLinkDevAgainstOldCLI(t *testing.T) {
	bin := ldOldCLI(t, t.TempDir())
	t.Run("matrix", func(t *testing.T) { ldOldMatrix(t, bin) })
	t.Run("capture", func(t *testing.T) { ldOldCapture(t, bin) })
}

func ldOldMatrix(t *testing.T, bin string) {
	type tc struct {
		name     string
		strip    bool
		newFirst bool
		newCmd   string
		oldCmd   string
		check    func(t *testing.T, rn, ro ldResult, dest string)
	}
	legacy := func(t *testing.T, rn, ro ldResult, dest string) {
		ldWantLegacy(t, rn, ro)
		if strings.Contains(rn.stderr, "link would be established") {
			t.Errorf("new side chose link against an old CLI\n%s", rn)
		}
	}
	var cases []tc
	for _, strip := range []bool{false, true} {
		for _, newFirst := range []bool{true, false} {
			hub := "hints"
			if strip {
				hub = "nohints"
			}
			order := "old-first"
			if newFirst {
				order = "new-first"
			}
			for _, c := range [][2]string{{"receive", "send"}, {"send", "receive"}, {"text", "text"}} {
				cases = append(cases, tc{name: fmt.Sprintf("%s/%s/new-%s-old-%s", hub, order, c[0], c[1]),
					strip: strip, newFirst: newFirst, newCmd: c[0], oldCmd: c[1], check: legacy})
			}
		}
	}
	// Mode mismatch is still refused exactly as today, on both ends.
	cases = append(cases, tc{name: "hints/new-send-old-text", newFirst: true, newCmd: "send", oldCmd: "text",
		check: func(t *testing.T, rn, ro ldResult, dest string) {
			if rn.code != 1 || !strings.Contains(rn.stderr, "the other side is running `relayium text`, not `relayium send`/`relayium receive`") {
				t.Errorf("new: want today's mode refusal\n%s", rn)
			}
			if ro.code != 1 || !strings.Contains(ro.stderr, "the other side is running `relayium send`/`relayium receive`, not `relayium text`") {
				t.Errorf("old: want its mode refusal\n%s", ro)
			}
		}})
	// A `pair` meeting an old CLI: both end within one round trip; the old one
	// quotes the notice it cannot understand.
	for _, strip := range []bool{false, true} {
		for _, oldCmd := range []string{"send", "text"} {
			name := "hints"
			if strip {
				name = "nohints"
			}
			strip, oldCmd := strip, oldCmd
			cases = append(cases, tc{name: name + "/new-pair-old-" + oldCmd, strip: strip, newFirst: false, newCmd: "pair", oldCmd: oldCmd,
				check: func(t *testing.T, rn, ro ldResult, dest string) {
					if rn.code != 1 {
						t.Errorf("new pair: want a refusal\n%s", rn)
					}
					if !strip {
						if !strings.Contains(rn.stderr, "older relayium CLI") {
							t.Errorf("new pair: want the older-CLI report\n%s", rn)
						}
						if ro.code != 1 || !strings.Contains(ro.stderr, "pair-needs-newer-relayium") {
							t.Errorf("old: want it to quote pair-needs-newer-relayium\n%s", ro)
						}
					} else {
						if !strings.Contains(rn.stderr, "legacy CLI handshake after our link hello") {
							t.Errorf("new pair: want the legacy-after-hello report\n%s", rn)
						}
						if ro.code != 1 || !strings.Contains(ro.stderr, "app or the web page") {
							t.Errorf("old: want its not-a-CLI refusal of our hello\n%s", ro)
						}
					}
				}})
		}
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			hub := startLinkDevHub(t)
			via := hub.url
			if c.strip {
				via = startLinkDevProxy(t, hub.url, true, false)
			}
			dest := t.TempDir()
			newP := ldPeer{cmd: c.newCmd, via: via}
			oldP := ldPeer{old: true, cmd: c.oldCmd, via: hub.url}
			src := ldSrc(t)
			for _, p := range []*ldPeer{&newP, &oldP} {
				switch p.cmd {
				case "send":
					p.args = []string{src, ldCode}
				case "receive":
					p.args = []string{ldCode, dest}
				default:
					p.args = []string{ldCode}
				}
			}
			var rn, ro ldResult
			if c.newFirst {
				rn, ro = ldPairUp(t, hub, bin, newP, oldP)
			} else {
				ro, rn = ldPairUp(t, hub, bin, oldP, newP)
			}
			want := "serverHints=" + fmt.Sprint(!c.strip) + " peerHint=false"
			if !strings.Contains(rn.stderr, want) {
				t.Errorf("new side's room view lacks %q\n%s", want, rn)
			}
			c.check(t, rn, ro, dest)
			if c.newCmd == "text" && c.oldCmd == "text" {
				ldCheckText(t, rn)
			}
			if c.newCmd == "receive" {
				ldCheckReceived(t, ro, rn, dest)
			} else if c.oldCmd == "receive" {
				ldCheckReceived(t, rn, ro, dest)
			}
		})
	}
}

// Capture ordering: the old CLI's commit reaches the new side BEFORE the new
// side's roster (forced by the roster-holding proxy on every run). The new
// side must capture it and continue the legacy handshake from it, on a hinted
// hub (discovery Passive) and on one without hints (discovery commits first
// and the captured commit is replayed after).
func ldOldCapture(t *testing.T, bin string) {
	for _, strip := range []bool{false, true} {
		name := "hints"
		if strip {
			name = "nohints"
		}
		for _, newCmd := range []string{"receive", "text"} {
			strip, newCmd := strip, newCmd
			t.Run(name+"/"+newCmd, func(t *testing.T) {
				t.Parallel()
				hub := startLinkDevHub(t)
				via := startLinkDevProxy(t, hub.url, strip, true)
				dest := t.TempDir()
				oldCmd, newArgs, oldArgs := "text", []string{ldCode}, []string{ldCode}
				if newCmd == "receive" {
					oldCmd, newArgs, oldArgs = "send", []string{ldCode, dest}, []string{ldSrc(t), ldCode}
				}
				rn, ro := ldPairUp(t, hub, bin,
					ldPeer{cmd: newCmd, args: newArgs, via: via},
					ldPeer{old: true, cmd: oldCmd, args: oldArgs, via: hub.url})
				if !strings.Contains(rn.stderr, "captured=1") {
					t.Errorf("the proxy did not put the commit ahead of the roster\n%s", rn)
				}
				if !strings.Contains(rn.stderr, "continuing from the peer's commit") {
					t.Errorf("the captured commit was not the handshake's first message\n%s", rn)
				}
				ldWantLegacy(t, rn, ro)
				if newCmd == "receive" {
					ldCheckReceived(t, ro, rn, dest)
				} else {
					ldCheckText(t, rn)
				}
			})
		}
	}
}
