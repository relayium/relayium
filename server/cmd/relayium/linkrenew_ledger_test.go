//go:build !windows

package main

// A11 provider-to-ledger reconciliation across a relay renewal (Codex gate-2
// item 4). Everything on the money path is PRODUCTION code, in process or as
// a real process:
//
//   - central: account.Service over a real SQLite store (plans seeded), its
//     real /api/ice and node routes, the real PairRegistry and GrantRegistry
//     wired exactly as server/main.go wires them (SetPairCodes, the issuance
//     observer, IssuedSegmentForTag/RetainTag), the real /ws hub with
//     main.go's Join/Leave/Renew hooks, and the real RenewRelayGrant issuer;
//   - the provider: the REAL relayium-node binary (built from this tree),
//     registered with central under a fleet token, relaying the link over
//     its patched pion TURN server with REST auth on every request, counting
//     per allocation and reporting through its real heartbeat;
//   - the ledger: RecordUsage into usage_events / usage_periods, read back
//     directly, and the allowance query UserRelayedSince.
//
// What is simulated, and nothing else: (1) the renewal grant registry's clock
// runs 35 s ahead so a 120 s credential clears the half-TTL issuance floor
// inside its own final margin (the same arithmetic as minute 50 of a
// one-hour credential); (2) central's clock is moved across a UTC month
// boundary mid-run through account.Service.SetNow, to exercise cross-month
// attribution; (3) duplicate and late reports are replays of the node's own
// captured heartbeats. The third-party coturn path is NOT exercised: central
// is configured without legacy TURN URLs, so the only relay is the node.
// Production coturn is not metered at all (fin-research H1) — see the author
// report; that is a recorded release blocker, not something this proves.

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/relayium/relayium/account"
	"github.com/relayium/relayium/internal/signal"
)

type ledgerHeartbeat struct {
	at   time.Time
	body []byte
}

type ledgerUsage struct {
	AllocID      string `json:"allocID"`
	Username     string `json:"username"`
	RelayedBytes int64  `json:"relayedBytes"`
}

// syncBuf is a goroutine-safe log sink for the node process.
type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func buildRelayiumNode(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "relayium-node")
	cmd := exec.Command("go", "build", "-o", bin, "./cmd/relayium-node")
	cmd.Dir = filepath.Join("..", "..")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build relayium-node: %v\n%s", err, out)
	}
	return bin
}

func freeUDPPort(t *testing.T) int {
	t.Helper()
	c, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).Port
}

func TestLinkRenewLedgerReconciliationWithRealNode(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and runs the real relayium-node")
	}
	const (
		nodeToken = "a11-ledger-fleet-token"
		credTTL   = 120 * time.Second
	)
	ctx := context.Background()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "central.db")
	store, err := account.OpenSQLite(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	svc := account.NewService(store, &account.LogMailer{Log: log.New(io.Discard, "", 0)}, account.Config{
		BaseURL: "http://127.0.0.1", TURNCredTTL: credTTL, NodeToken: nodeToken,
	})
	var centralOffset atomic.Int64 // nanoseconds; moved once, across a month boundary
	svc.SetNow(func() time.Time { return time.Now().Add(time.Duration(centralOffset.Load())) })
	if err := svc.SeedPlans(ctx); err != nil {
		t.Fatal(err)
	}
	owner, err := store.UpsertUserByEmail(ctx, "a11-ledger-owner@example.com", "a11-ledger-owner@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetEmailVerified(ctx, owner.ID); err != nil {
		t.Fatal(err)
	}

	pair := signal.NewPairRegistry(signal.CodeTTLSeconds, func() int64 { return time.Now().Unix() })
	svc.SetPairCodes(pair)
	hub := signal.NewHub()
	var issued atomic.Int32
	var issuedAt atomic.Int64
	grants := signal.NewGrantRegistry(credTTL, func() int64 { return time.Now().Unix() + 35 },
		func(c context.Context, o, tag string) signal.RenewIssue {
			issued.Add(1)
			issuedAt.Store(time.Now().UnixNano())
			return svc.RenewRelayGrant(c, o, tag)
		},
		func(room, peer string, data json.RawMessage) {
			hub.Relay(room, signal.Envelope{Type: signal.TypeICEGrant, To: peer, Data: data})
		},
		pair.IssuedSegmentForTag, pair.RetainTag)
	pair.SetIssuedObserver(grants.NoteIssued)

	joins := make(chan string, 16)
	var seq int32
	handle := signal.ServeWSHooked(hub, func() string { return fmt.Sprintf("peer%d", atomic.AddInt32(&seq, 1)) }, signal.WSHooks{
		Join: func(room, id string, peers int, members []string) {
			joins <- id
			_, o, tag, activity, current := pair.ObserveAdmittedRoomAttrib(room, peers)
			if current && peers >= 2 && activity.Paired {
				grants.Open(room, o, tag, members)
			}
		},
		Leave: func(room, id string) { grants.Depart(room, id) },
		Renew: func(room, id string, req signal.RenewRequest) { grants.Request(room, id, req) },
	})
	root := http.NewServeMux()
	svc.RegisterNodeRoutes(root)
	root.Handle("/", svc.Routes())

	var hbMu sync.Mutex
	var heartbeats []ledgerHeartbeat
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		room, ok := pair.RoomFor(r.URL.Query().Get("code"))
		if !ok {
			http.Error(w, "invalid or expired pairing code", http.StatusForbidden)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		handle(r.Context(), c, room, 2, "127.0.0.1", false)
		c.Close(websocket.StatusNormalClosure, "")
	})
	mux.HandleFunc("/api/nodes/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		hbMu.Lock()
		heartbeats = append(heartbeats, ledgerHeartbeat{time.Now(), b})
		hbMu.Unlock()
		r.Body = io.NopCloser(bytes.NewReader(b))
		root.ServeHTTP(w, r)
	})
	mux.Handle("/", root)
	central := httptest.NewServer(mux)
	t.Cleanup(central.Close)

	// ---- the real node
	nodeBin := buildRelayiumNode(t)
	turnPort := freeUDPPort(t)
	var nodeLog syncBuf
	node := exec.Command(nodeBin, "-central-url", central.URL, "-node-token", nodeToken, "-public-ip", "127.0.0.1",
		"-turn-port", fmt.Sprint(turnPort), "-min-port", "41000", "-max-port", "41999",
		"-state-dir", filepath.Join(dir, "node"), "-download-addr", "", "-region", "test")
	node.Stdout, node.Stderr = &nodeLog, &nodeLog
	if err := os.MkdirAll(filepath.Join(dir, "node"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := node.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = node.Process.Kill(); _ = node.Wait(); t.Logf("relayium-node log:\n%s", nodeLog.String()) })
	deadline := time.Now().Add(30 * time.Second)
	var nodeID string
	for nodeID == "" {
		nodes, _ := store.ListNodes(ctx)
		for _, n := range nodes {
			if len(n.URLs) > 0 {
				nodeID = n.ID
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("the node never registered\n%s", nodeLog.String())
		}
		time.Sleep(100 * time.Millisecond)
	}

	// ---- the month switch: after the heartbeat that carries the OLD
	// allocations' final counts (they close at the restart, right after the
	// renewal is issued), central's clock moves into the next UTC month.
	now := time.Now().UTC()
	nextMonth := time.Date(now.Year(), now.Month()+1, 1, 0, 0, 30, 0, time.UTC)
	var switchedAt atomic.Int64
	stopSwitch := make(chan struct{})
	go func() {
		tk := time.NewTicker(200 * time.Millisecond)
		defer tk.Stop()
		for {
			select {
			case <-stopSwitch:
				return
			case <-tk.C:
			}
			at := issuedAt.Load()
			if at == 0 {
				continue
			}
			hbMu.Lock()
			last := time.Time{}
			if len(heartbeats) > 0 {
				last = heartbeats[len(heartbeats)-1].at
			}
			hbMu.Unlock()
			if last.After(time.Unix(0, at).Add(5 * time.Second)) {
				centralOffset.Store(int64(time.Until(nextMonth)))
				switchedAt.Store(time.Now().UnixNano())
				return
			}
		}
	}()
	t.Cleanup(func() { close(stopSwitch) })

	// ---- the relayed CLI session crossing one renewal
	code, _ := pair.MintFor(owner.ID)
	if code == "" {
		t.Fatal("mint refused")
	}
	srcA := ldTree(t, "ledgerA", map[string]int{"a.bin": 3 << 20})
	srcB := ldTree(t, "ledgerB", map[string]int{"b.bin": 3 << 20})
	destA, destB := t.TempDir(), t.TempDir()
	script := func(src, m1, m2 string) string {
		return ldScript(t, "text "+m1, "wait-texts 1", "wait-renewed 1", "sleep 25s", "send "+src, "text "+m2, "wait-texts 2", "wait-files 1", "wait-sent")
	}
	h := &ldHub{url: "ws" + strings.TrimPrefix(central.URL, "http"), joins: joins}
	ra, rb := ldPairUpWithin(t, h,
		ldPeer{cmd: "pair", via: central.URL, args: []string{"--yes", "--dest", destA, "--script", script(srcA, "a1", "a2"), code}},
		ldPeer{cmd: "pair", via: central.URL, args: []string{"--yes", "--dest", destB, "--script", script(srcB, "b1", "b2"), code}},
		4*time.Minute)
	for _, r := range []ldResult{ra, rb} {
		if r.code != 0 || !strings.Contains(r.stderr, "relay renewal committed round 1") ||
			!strings.Contains(r.stderr, "batches sent=1 received=1 texts received=2") {
			t.Fatalf("want a complete relayed session across one renewal\n%s", r)
		}
	}
	ldSameTree(t, srcA, destB)
	ldSameTree(t, srcB, destA)
	if issued.Load() != 1 {
		t.Fatalf("RenewRelayGrant ran %d times for one renewal", issued.Load())
	}
	if switchedAt.Load() == 0 {
		t.Fatal("central's clock was never moved across the month boundary")
	}

	// ---- wait for the provider's final reports: every allocation this
	// session used has been reported and then evicted by the node.
	parse := func(b []byte) []ledgerUsage {
		var hb struct {
			Usage []ledgerUsage `json:"usage"`
		}
		_ = json.Unmarshal(b, &hb)
		return hb.Usage
	}
	ended := time.Now()
	var allocs map[string]ledgerUsage // allocID -> max report
	lastSeen := map[string]time.Time{}
	for {
		hbMu.Lock()
		hbs := append([]ledgerHeartbeat(nil), heartbeats...)
		hbMu.Unlock()
		allocs = map[string]ledgerUsage{}
		for _, hb := range hbs {
			for _, u := range parse(hb.body) {
				if u.RelayedBytes >= allocs[u.AllocID].RelayedBytes {
					allocs[u.AllocID] = u
				}
				lastSeen[u.AllocID] = hb.at
			}
		}
		final := len(hbs) > 0 && hbs[len(hbs)-1].at.After(ended)
		for _, u := range parse(hbs[len(hbs)-1].body) {
			_ = u
			final = false // something is still being reported
		}
		if final {
			break
		}
		if time.Since(ended) > 100*time.Second {
			t.Fatalf("the node never finished reporting (%d heartbeats)", len(hbs))
		}
		time.Sleep(time.Second)
	}

	// ---- the ledger, read back
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	type row struct {
		user, token, node string
		bytes             int64
		billable          int
	}
	ledgerEvents := func() map[string]row {
		out := map[string]row{}
		rs, err := db.Query(`SELECT alloc_id, user_id, token, COALESCE(node_id,''), relayed_bytes, billable FROM usage_events`)
		if err != nil {
			t.Fatal(err)
		}
		defer rs.Close()
		for rs.Next() {
			var id string
			var r row
			if err := rs.Scan(&id, &r.user, &r.token, &r.node, &r.bytes, &r.billable); err != nil {
				t.Fatal(err)
			}
			out[id] = r
		}
		return out
	}
	ledgerPeriods := func() map[string]map[string]int64 { // alloc -> period -> bytes
		out := map[string]map[string]int64{}
		rs, err := db.Query(`SELECT alloc_id, period, bytes FROM usage_periods`)
		if err != nil {
			t.Fatal(err)
		}
		defer rs.Close()
		for rs.Next() {
			var id, p string
			var n int64
			if err := rs.Scan(&id, &p, &n); err != nil {
				t.Fatal(err)
			}
			if out[id] == nil {
				out[id] = map[string]int64{}
			}
			out[id][p] = n
		}
		return out
	}
	events, periods := ledgerEvents(), ledgerPeriods()

	// Old vs renewed allocations, by the credential they authenticated with.
	expOf := func(u string) string { return strings.SplitN(u, ":", 2)[0] }
	byExp := map[string][]string{}
	for id, u := range allocs {
		byExp[expOf(u.Username)] = append(byExp[expOf(u.Username)], id)
	}
	if len(allocs) != 4 || len(byExp) != 2 {
		t.Fatalf("provider reported allocations %v: want two per credential round (old + renewed)", allocs)
	}
	var oldExp, newExp string
	for e := range byExp {
		if oldExp == "" || e < oldExp {
			oldExp = e
		}
	}
	for e := range byExp {
		if e != oldExp {
			newExp = e
		}
	}
	thisMonth := now.Format("200601")
	nextPeriod := nextMonth.Format("200601")
	switchT := time.Unix(0, switchedAt.Load())

	var ledgerTotal int64
	for id, u := range allocs {
		ev, ok := events[id]
		if !ok {
			t.Errorf("allocation %s (%d bytes reported) never reached the ledger", id, u.RelayedBytes)
			continue
		}
		// Exactly once: the ledger holds the provider's final cumulative for
		// the allocation — not a sum of its repeated reports, not less.
		if ev.bytes != u.RelayedBytes {
			t.Errorf("allocation %s: ledger %d, provider final %d", id, ev.bytes, u.RelayedBytes)
		}
		var perPeriod int64
		for _, n := range periods[id] {
			perPeriod += n
		}
		if perPeriod != ev.bytes {
			t.Errorf("allocation %s: month buckets sum to %d, cumulative %d (double or lost attribution)", id, perPeriod, ev.bytes)
		}
		// Attributed to the code owner, billable (fleet), from this node,
		// under one attribution tag across the renewal.
		if ev.user != owner.ID || ev.billable != 1 || ev.node != nodeID || !strings.HasSuffix(u.Username, ":"+owner.ID+"."+ev.token) {
			t.Errorf("allocation %s attributed %+v (username %s), want owner %s billable from node %s", id, ev, u.Username, owner.ID, nodeID)
		}
		ledgerTotal += ev.bytes
	}
	tokens := map[string]bool{}
	for _, ev := range events {
		tokens[ev.token] = true
	}
	if len(tokens) != 1 || len(events) != 4 {
		t.Errorf("ledger rows %v: want 4 rows under ONE attribution tag", events)
	}
	// Old allocations: final count reported after they closed (at the
	// restart), all of it in the month they ran, and finalised before the
	// month moved.
	for _, id := range byExp[oldExp] {
		if lastSeen[id].After(switchT) {
			t.Errorf("old allocation %s still reported after the switch", id)
		}
		if len(periods[id]) != 1 || periods[id][thisMonth] != events[id].bytes {
			t.Errorf("old allocation %s buckets %v, want everything in %s", id, periods[id], thisMonth)
		}
	}
	// Renewed allocations: the pre-switch messages in this month, the files
	// (sent after the switch) in the next.
	for _, id := range byExp[newExp] {
		if periods[id][nextPeriod] < 2*(3<<20) {
			t.Errorf("renewed allocation %s: %v — the post-switch files are not in %s", id, periods[id], nextPeriod)
		}
	}
	// Allowance: what the quota gate reads equals the ledger, once.
	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).Unix()
	allowance, err := store.UserRelayedSince(ctx, owner.ID, monthStart)
	if err != nil || allowance != ledgerTotal {
		t.Errorf("allowance debit %d (err %v), ledger %d", allowance, err, ledgerTotal)
	}
	// Provider traffic vs the bytes the two ends moved: each end's
	// allocations carry its payload both ways, plus framing.
	as, _ := ldMoved(t, ra)
	bs, _ := ldMoved(t, rb)
	payload := as + bs
	if ledgerTotal < 2*payload || ledgerTotal > 2*(payload+payload/5+512<<10) {
		t.Errorf("ledger %d for payload %d: outside 2x payload plus framing", ledgerTotal, payload)
	}

	// ---- duplicate and late reports: replay the node's own heartbeats.
	hbMu.Lock()
	replays := append([]ledgerHeartbeat(nil), heartbeats...)
	hbMu.Unlock()
	for _, hb := range replays {
		if len(parse(hb.body)) == 0 {
			continue
		}
		req, _ := http.NewRequest("POST", central.URL+"/api/nodes/heartbeat", bytes.NewReader(hb.body))
		req.Header.Set("Authorization", "Bearer "+nodeToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("replay status %d", resp.StatusCode)
		}
	}
	events2, periods2 := ledgerEvents(), ledgerPeriods()
	for id, ev := range events {
		if events2[id] != ev {
			t.Errorf("a replayed report moved allocation %s: %+v -> %+v", id, ev, events2[id])
		}
		for p, n := range periods[id] {
			if periods2[id][p] != n {
				t.Errorf("a replayed report moved %s/%s: %d -> %d", id, p, n, periods2[id][p])
			}
		}
	}
	if len(events2) != len(events) {
		t.Errorf("replays created ledger rows: %d -> %d", len(events), len(events2))
	}
	allowance2, _ := store.UserRelayedSince(ctx, owner.ID, monthStart)
	if allowance2 != allowance {
		t.Errorf("replays changed the allowance debit %d -> %d", allowance, allowance2)
	}
	t.Logf("provider/ledger: 4 allocations, old %v, renewed %v; ledger %d bytes for payload %d (x%.4f of 2x); buckets %v; %d heartbeats replayed with no effect",
		byExp[oldExp], byExp[newExp], ledgerTotal, payload, float64(ledgerTotal)/float64(2*payload), periods, len(replays))
}
