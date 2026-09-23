// Package deppolicy holds build-graph policy tests: structural rules about
// which third-party code each shipped binary may contain.
package deppolicy

// Pion boundary (A09-DESIGN §3.2, docs/DEPENDENCY-POLICY.md "Pion").
//
// The server module now carries two TURN implementations:
//
//   - github.com/pion/turn/v4, replaced by the PATCHED local copy
//     (server/third_party/pion-turn) — the only TURN SERVER Relayium runs, in
//     relayium-node;
//   - github.com/pion/turn/v5, pulled in by pion/ice for the TURN CLIENT the
//     CLI's WebRTC transport (internal/linkrtc) uses. Its upstream server still
//     has the five-tuple deletion defect the v4 copy patches (W-N38), so it
//     must never serve.
//
// Two rules make that structural:
//
//  1. relayium-node's package graph contains no WebRTC stack and no turn/v5
//     (package level via `go list -deps`, the stricter check).
//  2. A binary that links internal/linkrtc contains no linked SYMBOL from
//     turn/v5's server or allocation manager. This must be a symbol check: the
//     turn/v5 root package imports internal/server and internal/allocation, so
//     they are in the import graph of every linkrtc user even though the
//     linker keeps none of their code. A package-level deny would be a false
//     alarm and a package-level allow would be vacuous.
//
// Rule 2 is checked against the real relayium CLI and against a small probe
// main that makes linkrtc reachable, because until the CLI imports linkrtc
// (A09b) the real binary would pass vacuously. Set
// RELAYIUM_DEPPOLICY_ALL_TARGETS=1 to repeat rule 2 for all six release
// targets (slow; the default is the host target).

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const moduleRoot = "../.."

func goTool(t *testing.T) string {
	t.Helper()
	p := filepath.Join(runtime.GOROOT(), "bin", "go")
	if _, err := os.Stat(p); err == nil {
		return p
	}
	p, err := exec.LookPath("go")
	if err != nil {
		t.Skip("go tool not available")
	}
	return p
}

func run(t *testing.T, env []string, name string, args ...string) []byte {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = moduleRoot
	cmd.Env = append(os.Environ(), env...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, stderr.String())
	}
	return out
}

var forbiddenInNode = []string{
	"github.com/pion/webrtc/",
	"github.com/pion/ice/",
	"github.com/pion/sctp",
	"github.com/pion/datachannel",
	"github.com/pion/turn/v5",
}

func TestRelayiumNodeLinksNoWebRTCStackOrTurnV5(t *testing.T) {
	out := run(t, nil, goTool(t), "list", "-deps", "./cmd/relayium-node")
	var bad []string
	sawPatchedTurn := false
	for _, pkg := range strings.Fields(string(out)) {
		for _, f := range forbiddenInNode {
			if pkg == strings.TrimSuffix(f, "/") || strings.HasPrefix(pkg, f) {
				bad = append(bad, pkg)
			}
		}
		if pkg == "github.com/pion/turn/v4/internal/allocation" {
			sawPatchedTurn = true
		}
	}
	if len(bad) > 0 {
		t.Errorf("relayium-node depends on %v; its TURN server must stay the patched turn/v4 copy alone", bad)
	}
	if !sawPatchedTurn {
		t.Error("relayium-node no longer depends on turn/v4's allocation manager: the check above has become vacuous")
	}
	// The v4 packages it links must come from the local copy.
	mod := run(t, nil, goTool(t), "list", "-m", "-json", "github.com/pion/turn/v4")
	var m struct {
		Replace *struct{ Path string }
	}
	if err := json.Unmarshal(mod, &m); err != nil {
		t.Fatal(err)
	}
	if m.Replace == nil || m.Replace.Path != "./third_party/pion-turn" {
		t.Errorf("turn/v4 is not replaced by ./third_party/pion-turn: %s", mod)
	}
}

// probeMain makes every linkrtc entry point reachable (gated at run time so
// the probe does nothing when executed).
const probeMain = `package main

import (
	"os"

	"github.com/pion/webrtc/v4"
	"github.com/relayium/relayium/internal/linkrtc"
)

func main() {
	if os.Getenv("RELAYIUM_LINKRTC_PROBE") == "" {
		return
	}
	api, err := linkrtc.NewAPI(linkrtc.Options{AdvertiseIPs: []string{os.Args[0]}})
	if err != nil {
		panic(err)
	}
	cfg := webrtc.Configuration{
		ICEServers:         []webrtc.ICEServer{{URLs: []string{"turn:127.0.0.1:3478?transport=udp"}, Username: "u", Credential: "p"}},
		ICETransportPolicy: webrtc.ICETransportPolicyRelay,
	}
	c, err := linkrtc.NewConn(api, cfg, linkrtc.Initiator, func(e linkrtc.Event) {})
	if err != nil {
		panic(err)
	}
	_ = c.Offer()
	_ = c.SetRemote(webrtc.SessionDescription{})
	_ = c.AddICE(webrtc.ICECandidateInit{})
	_ = c.RestartICE()
	_ = c.Attach(func([]byte) {}, func([]byte) {})
	_ = c.Write(linkrtc.LaneFile, nil)
	_, _ = c.Budget()
	_, _ = c.SelectedPath()
	c.Close()
}
`

type target struct{ goos, goarch string }

var releaseTargets = []target{
	{"linux", "amd64"}, {"linux", "arm64"},
	{"darwin", "amd64"}, {"darwin", "arm64"},
	{"windows", "amd64"}, {"windows", "arm64"},
}

func turnV5ServerSymbols(nm []byte) (server []string, clientAllocate, peerConnection bool) {
	sc := bufio.NewScanner(bytes.NewReader(nm))
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 3 {
			continue
		}
		sym := strings.Join(f[2:], " ")
		switch {
		case strings.Contains(sym, "github.com/pion/turn/v5/internal/server."),
			strings.Contains(sym, "github.com/pion/turn/v5/internal/allocation."),
			strings.Contains(sym, "github.com/pion/turn/v5.NewServer"),
			strings.Contains(sym, "github.com/pion/turn/v5.(*Server)"):
			server = append(server, sym)
		case strings.Contains(sym, "github.com/pion/turn/v5.(*Client).Allocate"):
			clientAllocate = true
		case strings.Contains(sym, "github.com/pion/webrtc/v4.(*PeerConnection).CreateDataChannel"):
			peerConnection = true
		}
	}
	return server, clientAllocate, peerConnection
}

func TestLinkrtcBinariesLinkNoTurnV5Server(t *testing.T) {
	if testing.Short() {
		t.Skip("builds binaries")
	}
	goBin := goTool(t)
	tmp := t.TempDir()

	// Overlay a probe main into the module (internal/ imports require it)
	// without adding a file to the repository.
	abs, err := filepath.Abs(filepath.Join(moduleRoot, "internal", "deppolicy", "linkrtcprobe", "main.go"))
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(tmp, "main.go")
	if err := os.WriteFile(src, []byte(probeMain), 0o600); err != nil {
		t.Fatal(err)
	}
	overlay := filepath.Join(tmp, "overlay.json")
	ov, _ := json.Marshal(map[string]map[string]string{"Replace": {abs: src}})
	if err := os.WriteFile(overlay, ov, 0o600); err != nil {
		t.Fatal(err)
	}

	targets := []target{{runtime.GOOS, runtime.GOARCH}}
	if os.Getenv("RELAYIUM_DEPPOLICY_ALL_TARGETS") == "1" {
		targets = releaseTargets
	}
	for _, tg := range targets {
		env := []string{"CGO_ENABLED=0", "GOOS=" + tg.goos, "GOARCH=" + tg.goarch}
		for _, b := range []struct{ name, pkg string }{
			{"linkrtc-probe", "./internal/deppolicy/linkrtcprobe"},
			{"relayium", "./cmd/relayium"},
		} {
			out := filepath.Join(tmp, b.name+"-"+tg.goos+"-"+tg.goarch)
			// Unstripped (no -s -w) so the symbol table is present.
			run(t, env, goBin, "build", "-overlay", overlay, "-trimpath", "-o", out, b.pkg)
			nm := run(t, nil, goBin, "tool", "nm", out)
			server, alloc, pcSym := turnV5ServerSymbols(nm)
			if len(server) > 0 {
				t.Errorf("%s %s/%s links turn/v5 server/allocation code (%d symbols, e.g. %s)",
					b.name, tg.goos, tg.goarch, len(server), server[0])
			}
			if b.name == "linkrtc-probe" && (!alloc || !pcSym) {
				t.Errorf("%s %s/%s: the probe does not link the TURN v5 client / PeerConnection "+
					"(client=%v pc=%v); the symbol check has become vacuous", b.name, tg.goos, tg.goarch, alloc, pcSym)
			}
			t.Logf("%s %s/%s: turn/v5 server symbols=%d client Allocate=%v", b.name, tg.goos, tg.goarch, len(server), alloc)
			_ = os.Remove(out)
		}
	}
}
