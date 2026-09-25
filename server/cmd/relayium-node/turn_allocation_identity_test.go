package main

import (
	"bufio"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/turn/v4"
)

// A client that ends an allocation with Refresh(LIFETIME=0) and immediately
// allocates again from the same source port reuses the 5-tuple. Upstream pion
// v4.1.4 let the FIRST allocation's relay reader, when it unwound late, call
// Manager.DeleteAllocation(fiveTuple) — a lookup by 5-tuple, not by identity —
// which removed and closed the SECOND, live allocation. The node then counted
// no allocation and pion answered nothing for a client whose relay it had just
// granted. TestRealPionSrcAddrReuseAcrossAllocations caught it on a loaded CI
// runner; these tests pin the ordering instead of waiting for load to find it.
//
// The only thing controlled here is WHEN the first relay socket's already-failed
// ReadFrom is handed back to pion. Everything else is the production registry,
// counting generator and event handler, real pion, and a raw wire client with a
// fresh transaction ID per request. The fix is the identity guard carried in
// third_party/pion-turn (see its PATCHES.md), and both tests below fail against
// unpatched pion v4.1.4 only in the late-reader ordering.

// heldRelay delays handing the first relay socket's read error back to pion.
type heldRelay struct {
	net.PacketConn // the production countingPacketConn

	once       sync.Once
	readFailed chan struct{}
	hold       chan struct{}
	holdOnce   sync.Once
	readerGID  string
}

func (h *heldRelay) ReadFrom(p []byte) (int, net.Addr, error) {
	n, addr, err := h.PacketConn.ReadFrom(p) // bytes tallied and in-flight IO ended
	if err != nil {
		h.once.Do(func() {
			h.readerGID = currentGoroutineID()
			close(h.readFailed)
		})
		<-h.hold
	}
	return n, addr, err
}

func (h *heldRelay) release() { h.holdOnce.Do(func() { close(h.hold) }) }

// heldGenerator hands out the production counting relay sockets, wrapping only
// the first in a heldRelay.
type heldGenerator struct {
	inner *countingGenerator

	mu    sync.Mutex
	first *heldRelay
}

func (g *heldGenerator) Validate() error { return g.inner.Validate() }

func (g *heldGenerator) AllocateConn(network string, port int) (net.Conn, net.Addr, error) {
	return g.inner.AllocateConn(network, port)
}

func (g *heldGenerator) AllocatePacketConn(network string, port int) (net.PacketConn, net.Addr, error) {
	pc, addr, err := g.inner.AllocatePacketConn(network, port)
	if err != nil {
		return pc, addr, err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.first == nil {
		g.first = &heldRelay{PacketConn: pc, readFailed: make(chan struct{}), hold: make(chan struct{})}
		return g.first, addr, nil
	}
	return pc, addr, nil
}

func (g *heldGenerator) firstRelay(t *testing.T) *heldRelay {
	t.Helper()
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.first == nil {
		t.Fatal("no relay socket was allocated")
	}
	return g.first
}

// startHeldTURNServer is newTURNServer's construction with the relay generator
// wrapped: same registry, counting generator and event handler.
func startHeldTURNServer(t *testing.T) (*allocRegistry, *heldGenerator, string, string, string) {
	t.Helper()
	realm, secret := "relayium.test", "test-secret"
	udpConn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen turn socket: %v", err)
	}
	reg := newAllocRegistry(&limits{})
	gen := &heldGenerator{inner: &countingGenerator{reg: reg, inner: &turn.RelayAddressGeneratorPortRange{
		RelayAddress: net.ParseIP("127.0.0.1"), Address: "0.0.0.0", MinPort: 49152, MaxPort: 65535,
	}}}
	srv, err := turn.NewServer(turn.ServerConfig{
		Realm: realm,
		AuthHandler: func(username, realm string, _ net.Addr) ([]byte, bool) {
			if credentialExpired(username, time.Now().Unix()) {
				return nil, false
			}
			return turn.GenerateAuthKey(username, realm, longTermPassword(secret, username)), true
		},
		EventHandler:      nodeEventHandler(reg),
		PacketConnConfigs: []turn.PacketConnConfig{{PacketConn: udpConn, RelayAddressGenerator: gen}},
	})
	if err != nil {
		udpConn.Close()
		t.Fatalf("turn.NewServer: %v", err)
	}
	t.Cleanup(func() {
		gen.mu.Lock()
		if gen.first != nil {
			gen.first.release()
		}
		gen.mu.Unlock()
		_ = srv.Close()
	})
	return reg, gen, udpConn.LocalAddr().String(), realm, secret
}

func currentGoroutineID() string {
	buf := make([]byte, 64)
	buf = buf[:runtime.Stack(buf, false)]
	// "goroutine 123 [running]:"
	f := strings.Fields(string(buf))
	if len(f) < 2 || f[0] != "goroutine" {
		return ""
	}
	return f[1]
}

// waitGoroutineExited waits until goroutine gid has returned. Goroutine IDs are
// never reused, so this is the exact point at which pion's packetHandler for
// the first allocation has finished whatever it does with its read error.
func waitGoroutineExited(t *testing.T, gid string) {
	t.Helper()
	if gid == "" {
		t.Fatal("reader goroutine ID was not captured")
	}
	marker := "goroutine " + gid + " ["
	deadline := time.Now().Add(10 * time.Second)
	buf := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buf, true)
		if n == len(buf) {
			buf = make([]byte, 2*len(buf))
			continue
		}
		if !strings.Contains(string(buf[:n]), marker) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("10s later: the first allocation's relay reader (goroutine %s) has not returned", gid)
		}
		time.Sleep(time.Millisecond)
	}
}

// pionHasAllocation asks pion itself, not the registry, whether the client's
// 5-tuple still has an allocation: Refresh(LIFETIME=600) succeeds only if it
// does. pion v4.1.4 sends nothing at all for a Refresh on an unknown 5-tuple,
// so no reply within 2s on loopback means "no allocation".
func pionHasAllocation(t *testing.T, c *turnWire) (bool, string) {
	t.Helper()
	txID := make([]byte, 12)
	if _, err := rand.Read(txID); err != nil {
		t.Fatalf("transaction id: %v", err)
	}
	body := attr(attrLifetime, []byte{0, 0, 0x02, 0x58})
	body = append(body, attr(attrUsername, []byte(c.username))...)
	body = append(body, attr(attrRealm, []byte(c.realm))...)
	body = append(body, attr(attrNonce, c.nonce)...)
	msg := signMessageIntegrity(append(stunHeader(msgRefreshRequest, txID, len(body)), body...), c.key)
	if _, err := c.conn.WriteTo(msg, c.server); err != nil {
		t.Fatalf("send refresh: %v", err)
	}
	_ = c.conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	defer c.conn.SetReadDeadline(time.Time{})
	buf := make([]byte, 1600)
	n, _, err := c.conn.ReadFrom(buf)
	if err != nil {
		return false, "no reply: " + err.Error()
	}
	typ, attrs, err := decodeSTUN(buf[:n])
	if err != nil {
		return false, err.Error()
	}
	return typ == msgRefreshSuccess, "type=0x" + strconv.FormatUint(uint64(typ), 16) + " ERROR-CODE=" + errorCode(attrs)
}

// S1: the first allocation's reader unwinds only after the second allocation on
// the same 5-tuple exists. Fails against unpatched pion v4.1.4.
func TestTURNLateReaderOfEndedAllocationCannotEndItsSuccessor(t *testing.T) {
	reg, gen, addr, realm, secret := startHeldTURNServer(t)
	c := dialTURN(t, addr, realm, secret)

	c.allocate(t)
	c.release(t)
	first := gen.firstRelay(t)
	<-first.readFailed // #1 is closed; its reader holds the error
	waitForActiveAllocs(t, reg, 0)
	ackedSnapshot(reg) // flush, acknowledge and evict #1

	c.allocate(t)
	if got := reg.activeAllocs(); got != 1 {
		t.Fatalf("before the late reader: activeAllocs = %d, want 1", got)
	}

	first.release()
	waitGoroutineExited(t, first.readerGID)

	if got := reg.activeAllocs(); got != 1 {
		t.Fatalf("the first allocation's late relay reader ended the second: activeAllocs = %d, want 1", got)
	}
	if ok, detail := pionHasAllocation(t, c); !ok {
		t.Fatalf("pion no longer has the second allocation after the first one's reader unwound (%s)", detail)
	}

	// The client's own Refresh(0) still ends the allocation that is current.
	c.release(t)
	waitForActiveAllocs(t, reg, 0)
}

// S2, the control: identical, except the first reader has fully unwound
// before the second Allocate. Reusing a 5-tuple is harmless by itself; this
// passes against unpatched pion too, which is what makes S1 about ordering.
func TestTURNReaderUnwoundBeforeReuseLeavesSuccessorLive(t *testing.T) {
	reg, gen, addr, realm, secret := startHeldTURNServer(t)
	c := dialTURN(t, addr, realm, secret)

	c.allocate(t)
	c.release(t)
	first := gen.firstRelay(t)
	<-first.readFailed
	first.release()
	waitGoroutineExited(t, first.readerGID)
	waitForActiveAllocs(t, reg, 0)
	ackedSnapshot(reg)

	c.allocate(t)
	if got := reg.activeAllocs(); got != 1 {
		t.Fatalf("activeAllocs = %d, want 1", got)
	}
	if ok, detail := pionHasAllocation(t, c); !ok {
		t.Fatalf("pion has no allocation for the reused 5-tuple (%s)", detail)
	}
	c.release(t)
	waitForActiveAllocs(t, reg, 0)
}

// The node's TURN server must be built from the patched local copy, and that
// copy must be exactly upstream v4.1.4 plus the files PATCHES.md accounts for.
// A dependency bump, a dropped replace, or an unrecorded edit to the copy each
// fail here rather than silently reintroducing the defect or hiding a change.
func TestPionTurnLocalCopyProvenance(t *testing.T) {
	const (
		modPath   = "github.com/pion/turn/v4"
		version   = "v4.1.4"
		copyDir   = "../../third_party/pion-turn"
		replaceTo = "./third_party/pion-turn"
	)

	gomod, err := os.ReadFile("../../go.mod")
	if err != nil {
		t.Fatal(err)
	}
	var required, replaced []string
	inRequire := false
	for _, line := range strings.Split(string(gomod), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "require (":
			inRequire = true
			continue
		case inRequire && line == ")":
			inRequire = false
			continue
		}
		f := strings.Fields(strings.SplitN(line, "//", 2)[0])
		if inRequire && len(f) >= 2 && f[0] == modPath {
			required = append(required, f[1])
		}
		if len(f) >= 3 && f[0] == "require" && f[1] == modPath {
			required = append(required, f[2])
		}
		if len(f) >= 1 && f[0] == "replace" && strings.Contains(line, modPath) {
			replaced = append(replaced, strings.Join(f[1:], " "))
		}
	}
	if len(required) != 1 || required[0] != version {
		t.Errorf("go.mod requires %s %v; the local copy is %s. Bumping pion/turn means re-deriving the copy and "+
			"PATCHES.md (or dropping the replace once upstream carries the fix), not just editing go.mod", modPath, required, version)
	}
	if want := modPath + " => " + replaceTo; len(replaced) != 1 || replaced[0] != want {
		t.Errorf("go.mod replace for %s = %v, want exactly [%s]", modPath, replaced, want)
	}

	patches, err := os.ReadFile(filepath.Join(copyDir, "PATCHES.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{modPath + "@" + version, "h1:EU11yMXKIsK43FhcUnjLlrhE4nboHZq+TXBIi3QpcxQ=", "Removal trigger"} {
		if !strings.Contains(string(patches), want) {
			t.Errorf("PATCHES.md does not record %q", want)
		}
	}
	license, err := os.ReadFile(filepath.Join(copyDir, "LICENSE"))
	if err != nil || !strings.Contains(string(license), "MIT License") || !strings.Contains(string(license), "The Pion community") {
		t.Errorf("upstream MIT LICENSE missing or altered (err %v)", err)
	}

	baseline := readSHA256Manifest(t, filepath.Join(copyDir, "RELAYIUM-BASELINE.sha256"))
	patched := readSHA256Manifest(t, filepath.Join(copyDir, "RELAYIUM-PATCHED.sha256"))
	bookkeeping := map[string]bool{"PATCHES.md": true, "RELAYIUM-BASELINE.sha256": true, "RELAYIUM-PATCHED.sha256": true}

	var seen []string
	err = filepath.WalkDir(copyDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(copyDir, path)
		rel = filepath.ToSlash(rel)
		seen = append(seen, rel)
		if bookkeeping[rel] {
			return nil
		}
		want, ok := patched[rel]
		if !ok {
			want, ok = baseline[rel]
		}
		if !ok {
			t.Errorf("%s is in the copy but in neither the upstream baseline nor RELAYIUM-PATCHED.sha256", rel)
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(b)
		if got := hex.EncodeToString(sum[:]); got != want {
			t.Errorf("%s: sha256 %s, want %s (unrecorded change to the local pion copy)", rel, got, want)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	have := map[string]bool{}
	for _, s := range seen {
		have[s] = true
	}
	var missing []string
	for rel := range baseline {
		if !have[rel] {
			missing = append(missing, rel)
		}
	}
	for rel := range patched {
		if !have[rel] {
			missing = append(missing, rel)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("files recorded in the manifests are missing from the copy: %v", missing)
	}
	for rel := range patched {
		if _, upstream := baseline[rel]; upstream && patched[rel] == baseline[rel] {
			t.Errorf("%s is listed as patched but is byte-identical to upstream", rel)
		}
	}

	// The copy is its own module, so no `./...` in the server module reaches
	// its tests; go.yml runs them in a dedicated step. Losing that step would
	// leave the patch's own regression tests running nowhere, silently.
	workflow, err := os.ReadFile("../../../.github/workflows/go.yml")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"working-directory: server/third_party/pion-turn",
		"go vet . ./internal/...",
		"go test -race -count=1 -timeout 10m . ./internal/...",
	} {
		if !strings.Contains(string(workflow), want) {
			t.Errorf(".github/workflows/go.yml no longer contains %q, so the local pion copy's tests stop running in CI", want)
		}
	}
	// And a directory replace has no version, so `govulncheck ./...` skips the
	// copy; go.yml queries the vulnerability database for the upstream version
	// separately and must keep failing on anything but a confirmed clean answer.
	for _, want := range []string{
		"mod=" + modPath + "\n",
		`ver="$(go list -m -f '{{.Version}}' "$mod")"`,
		`go run "$scanner" -mode=query -json "$mod@$ver" > "$report"`,
		`--arg lookup "Looking up vulnerabilities in $mod at $ver..."`,
		`elif ($m | map(select(has("osv"))) | length) > 0`,
	} {
		if !strings.Contains(string(workflow), want) {
			t.Errorf(".github/workflows/go.yml no longer contains %q, so pion/turn is no longer checked for advisories", want)
		}
	}
}

func readSHA256Manifest(t *testing.T, path string) map[string]string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	m := map[string]string{}
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 || len(fields[0]) != 64 {
			t.Fatalf("%s: malformed line %q", path, line)
		}
		m[fields[1]] = fields[0]
	}
	if err := s.Err(); err != nil {
		t.Fatal(err)
	}
	if len(m) == 0 {
		t.Fatalf("%s is empty", path)
	}
	return m
}
