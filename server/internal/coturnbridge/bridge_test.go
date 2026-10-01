package coturnbridge

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
	"github.com/relayium/relayium/internal/coturnbridge/wire"
)

// fakeRedis answers PSUBSCRIBE and PING like Redis in subscribed mode
// (RESP2). Published messages are queued and delivered, in order, before the
// reply to the next PING — the ordering guarantee the barrier relies on.
// onPing runs while a PING is being processed, i.e. between the bridge's
// "pre" and "post" epoch reads.
type fakeRedis struct {
	ln     net.Listener
	mu     sync.Mutex
	queue  []string // RESP-encoded pmessages
	conns  []net.Conn
	pings  atomic.Int64
	onPing atomic.Pointer[func(n int64)]
}

func startFakeRedis(t *testing.T) *fakeRedis {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeRedis{ln: ln}
	t.Cleanup(func() { ln.Close(); f.dropAll() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			f.mu.Lock()
			f.conns = append(f.conns, c)
			f.mu.Unlock()
			go f.serve(c)
		}
	}()
	return f
}

func bulk(s string) string { return "$" + strconv.Itoa(len(s)) + "\r\n" + s + "\r\n" }

func (f *fakeRedis) publish(channel, payload string) {
	f.mu.Lock()
	f.queue = append(f.queue, "*4\r\n"+bulk("pmessage")+bulk("turn/realm/relayium.com/user/*")+bulk(channel)+bulk(payload))
	f.mu.Unlock()
}

func (f *fakeRedis) dropAll() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.conns {
		c.Close()
	}
	f.conns = nil
	f.queue = nil // pub/sub is at-most-once: queued messages die with the connection
}

func (f *fakeRedis) serve(c net.Conn) {
	r := bufio.NewReader(c)
	for {
		n, err := r.ReadString('\n')
		if err != nil {
			return
		}
		cnt, _ := strconv.Atoi(strings.TrimSpace(n[1:]))
		args := make([]string, cnt)
		for i := range args {
			r.ReadString('\n')
			l, _ := r.ReadString('\n')
			args[i] = strings.TrimRight(l, "\r\n")
		}
		switch args[0] {
		case "PSUBSCRIBE":
			c.Write([]byte("*3\r\n" + bulk("psubscribe") + bulk(args[1]) + ":1\r\n"))
		case "PING":
			k := f.pings.Add(1)
			if fn := f.onPing.Load(); fn != nil {
				(*fn)(k)
			}
			f.mu.Lock()
			out := strings.Join(f.queue, "")
			f.queue = nil
			f.mu.Unlock()
			c.Write([]byte(out + "*2\r\n" + bulk("pong") + bulk(args[1])))
		}
	}
}

type fakeEpoch struct {
	mu sync.Mutex
	e  Epoch
}

func (f *fakeEpoch) Read() (Epoch, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.e.Valid() {
		return Epoch{}, ErrNoProvider
	}
	return f.e, nil
}
func (f *fakeEpoch) set(e Epoch) { f.mu.Lock(); f.e = e; f.mu.Unlock() }

// central is the real ingest over a real SQLite ledger, behind a switchable
// front: down (connection refused semantics via 503), lose the ACK, or
// corrupt the ACK.
type central struct {
	t     *testing.T
	store *account.SQLiteStore
	ing   *account.CoturnMeteringIngest
	srv   *httptest.Server
	mode  atomic.Value // "", "down", "loseack", "badack"
	posts atomic.Int64
	user  string
	seen  sync.Map // "sessionId" → true for every snapshot ever POSTed
}

func (c *central) sawSession(sid string) bool { _, ok := c.seen.Load(sid); return ok }

func startCentral(t *testing.T, mode string, since int64) *central {
	t.Helper()
	store, err := account.OpenSQLite(filepath.Join(t.TempDir(), "central.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	u, err := store.UpsertUserByEmail(context.Background(), "owner@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	ing, err := account.NewCoturnMeteringIngest(store, nil, account.CoturnMeteringConfig{
		Relays: map[string][32]byte{"coturn-central": sha256.Sum256([]byte("tok"))},
		Mode:   mode, BillableSince: since, Logf: t.Logf,
	})
	if err != nil {
		t.Fatal(err)
	}
	c := &central{t: t, store: store, ing: ing, user: u.ID}
	c.mode.Store("")
	c.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.posts.Add(1)
		raw, _ := io.ReadAll(r.Body)
		var req wire.Request
		if json.Unmarshal(raw, &req) == nil {
			for _, sn := range req.Snapshots {
				c.seen.Store(sn.SessionID, true)
			}
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		switch c.mode.Load().(string) {
		case "down":
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		case "loseack":
			c.ing.ServeHTTP(httptest.NewRecorder(), r) // applied, answer lost
			http.Error(w, "gateway timeout", http.StatusGatewayTimeout)
			return
		case "ack502":
			// A misbehaving proxy: a well-formed ACK body under an error status.
			rec := httptest.NewRecorder()
			c.ing.ServeHTTP(rec, r)
			w.WriteHeader(http.StatusBadGateway)
			w.Write(rec.Body.Bytes())
			return
		case "trailingack":
			// A well-formed ACK followed by a stray closing bracket.
			rec := httptest.NewRecorder()
			c.ing.ServeHTTP(rec, r)
			w.Write(append(bytes.TrimSpace(rec.Body.Bytes()), ']'))
			return
		case "badack":
			rec := httptest.NewRecorder()
			c.ing.ServeHTTP(rec, r)
			var resp wire.Response
			json.Unmarshal(rec.Body.Bytes(), &resp)
			for i := range resp.Acks {
				resp.Acks[i].Hash = strings.Repeat("0", 64)
			}
			json.NewEncoder(w).Encode(resp)
			return
		}
		c.ing.ServeHTTP(w, r)
	}))
	t.Cleanup(c.srv.Close)
	return c
}

func (c *central) billed() int64 {
	c.t.Helper()
	n, err := c.store.UserRelayedSince(context.Background(), c.user, 0)
	if err != nil {
		c.t.Fatal(err)
	}
	return n
}

func (c *central) username(tag string) string { return "1790000000:" + c.user + "." + tag }

type harness struct {
	t     *testing.T
	redis *fakeRedis
	ep    *fakeEpoch
	c     *central
	dir   string
	b     *Bridge
	stop  context.CancelFunc
	done  chan struct{}
	logs  *alertsSync
}

type alertsSync struct {
	mu    sync.Mutex
	lines []string
}

func (a *alertsSync) f(format string, args ...any) {
	a.mu.Lock()
	a.lines = append(a.lines, fmt.Sprintf(format, args...))
	a.mu.Unlock()
}

func (a *alertsSync) has(sub string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, l := range a.lines {
		if strings.Contains(l, sub) {
			return true
		}
	}
	return false
}

func newHarness(t *testing.T, mode string) *harness {
	h := &harness{t: t, redis: startFakeRedis(t), ep: &fakeEpoch{}, dir: t.TempDir(), logs: &alertsSync{}}
	h.ep.set(tE1)
	h.c = startCentral(t, mode, 1)
	return h
}

func (h *harness) start() { h.startWith(nil) }

func (h *harness) startWith(adjust func(*Config)) {
	h.t.Helper()
	cfg := Config{
		RelayID: "coturn-central", Realm: "relayium.com",
		RedisAddr: h.redis.ln.Addr().String(), SpoolDir: h.dir,
		CentralURL: h.c.srv.URL, Token: "tok", Epoch: h.ep,
		BarrierInterval: 20 * time.Millisecond, BarrierTimeout: time.Second,
		FlushInterval: 20 * time.Millisecond, ReportInterval: 30 * time.Millisecond,
		ClampRetry: time.Second, BatchSize: 4,
		Logf: h.logs.f,
	}
	if adjust != nil {
		adjust(&cfg)
	}
	b, err := New(cfg)
	if err != nil {
		h.t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	h.b, h.stop, h.done = b, cancel, make(chan struct{})
	go func() { b.Run(ctx); close(h.done) }()
	h.t.Cleanup(h.halt)
}

func (h *harness) halt() {
	if h.stop != nil {
		h.stop()
		<-h.done
		h.stop = nil
	}
}

func (h *harness) eventually(what string, cond func() bool) {
	h.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			h.t.Fatalf("timed out waiting for %s; logs:\n%s", what, strings.Join(h.logs.lines, "\n"))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (h *harness) subscribed() bool {
	return h.b.Status().SubscriptionUp && h.b.Status().LastTrustedBarrier > 0
}

func chan4(user, sid, kind string) string {
	return "turn/realm/relayium.com/user/" + user + "/allocation/" + sid + "/" + kind
}

func counters(rcvb, sentb uint64) string {
	return fmt.Sprintf("rcvp=1, rcvb=%d, sentp=1, sentb=%d", rcvb, sentb)
}

// Normal close: deltas, then the final, delivered once; the spool empties.
func TestBridgeDeliversFinalExactlyOnce(t *testing.T) {
	h := newHarness(t, account.CoturnMeteringBillable)
	h.start()
	h.eventually("subscription", h.subscribed)
	u := h.c.username("g1")
	h.redis.publish(chan4(u, tSID, "status"), "new lifetime=600, type=UDP, local=a, remote=b, ssl=NONE, cipher=NONE")
	h.redis.publish(chan4(u, tSID, "traffic"), counters(1000, 900))
	h.redis.publish(chan4(u, tSID, "traffic"), counters(1000, 900)) // identical payload, a real second interval
	h.redis.publish(chan4(u, tSID, "traffic/peer"), counters(4294967295, 4294967295))
	h.redis.publish(chan4(u, tSID, "status"), "deleted")
	h.redis.publish(chan4(u, tSID, "total_traffic"), counters(2500, 2300))
	h.eventually("ledger", func() bool { return h.c.billed() == 4800 })
	h.eventually("spool drained", func() bool { n, _ := h.b.spool.Count(); return n == 0 && len(h.b.Snapshot()) == 0 })
	time.Sleep(100 * time.Millisecond)
	if h.c.billed() != 4800 {
		t.Fatalf("billed %d", h.c.billed())
	}
}

// A coturn restart inside a barrier segment: the segment's messages cannot be
// attributed to either process and are quarantined, never billed; the old
// epoch's live allocations end with their lower bound.
func TestBridgeQuarantinesSegmentAcrossProviderRestart(t *testing.T) {
	h := newHarness(t, account.CoturnMeteringBillable)
	h.start()
	h.eventually("subscription", h.subscribed)
	u := h.c.username("g1")
	h.redis.publish(chan4(u, tSID, "traffic"), counters(100, 100))
	h.eventually("first delta delivered", func() bool { return h.c.billed() == 200 })

	var armed atomic.Bool
	armed.Store(true)
	restart := func(int64) {
		if armed.CompareAndSwap(true, false) {
			h.ep.set(tE2) // restart lands between this barrier's pre and post reads
		}
	}
	h.redis.onPing.Store(&restart)
	// Same raw session id, published around the restart.
	h.redis.publish(chan4(u, tSID, "traffic"), counters(7000, 7000))
	h.eventually("quarantine", func() bool { return h.b.Status().QuarantinedMessages >= 1 })
	h.eventually("old epoch ended and delivered", func() bool {
		bs, _ := h.c.store.CoturnBindings(context.Background())
		return len(bs) == 1 && bs[0].Terminal
	})
	if h.c.billed() != 200 {
		t.Fatalf("quarantined bytes billed: %d", h.c.billed())
	}
	// The new process reuses the raw id for a new allocation: a new binding.
	u2 := h.c.username("g2")
	h.redis.publish(chan4(u2, tSID, "total_traffic"), counters(10, 20))
	h.eventually("new epoch allocation billed", func() bool { return h.c.billed() == 230 })
	bs, _ := h.c.store.CoturnBindings(context.Background())
	if len(bs) != 2 || bs[0].PID == bs[1].PID {
		t.Fatalf("bindings %+v", bs)
	}
}

// Central down, then a lost ACK, then a corrupted ACK: everything is retained
// and retried, and the ledger counts the bytes exactly once.
func TestBridgeCentralOutageLostAndBadAck(t *testing.T) {
	h := newHarness(t, account.CoturnMeteringBillable)
	h.c.mode.Store("down")
	h.start()
	h.eventually("subscription", h.subscribed)
	u := h.c.username("g1")
	h.redis.publish(chan4(u, tSID, "traffic"), counters(500, 500))
	h.redis.publish(chan4(u, tSID, "total_traffic"), counters(800, 700))
	h.eventually("delivery failing", func() bool { return h.b.Status().ReportFailingSince > 0 && h.c.posts.Load() >= 2 })
	if n, _ := h.b.spool.Count(); n != 1 || h.c.billed() != 0 {
		t.Fatalf("while down: spool %d billed %d", n, h.c.billed())
	}

	h.c.mode.Store("loseack")
	h.eventually("applied with lost ACK", func() bool { return h.c.billed() == 1500 })
	time.Sleep(150 * time.Millisecond)
	if n, _ := h.b.spool.Count(); n != 1 {
		t.Fatal("snapshot deleted without an ACK")
	}

	h.c.mode.Store("ack502")
	before := h.c.posts.Load()
	h.eventually("ack under HTTP 502 refused", func() bool { return h.c.posts.Load() >= before+2 && h.logs.has("HTTP 502") })
	if n, _ := h.b.spool.Count(); n != 1 {
		t.Fatal("snapshot deleted on an ACK carried by an error status")
	}

	h.c.mode.Store("badack")
	h.eventually("bad ACK seen", func() bool { return h.logs.has("bad ACK") })
	if n, _ := h.b.spool.Count(); n != 1 {
		t.Fatal("snapshot deleted on a bad ACK")
	}

	h.c.mode.Store("")
	h.eventually("settled", func() bool { n, _ := h.b.spool.Count(); return n == 0 })
	if h.c.billed() != 1500 {
		t.Fatalf("billed %d after retries, want exactly 1500", h.c.billed())
	}
}

// Bridge restart (state from the spool) and a Redis disconnect: the stream
// gap is recorded, the final still settles the allocation exactly.
func TestBridgeRestartAndRedisDisconnect(t *testing.T) {
	h := newHarness(t, account.CoturnMeteringBillable)
	h.c.mode.Store("down")
	h.start()
	h.eventually("subscription", h.subscribed)
	u := h.c.username("g1")
	h.redis.publish(chan4(u, tSID, "traffic"), counters(300, 300))
	h.eventually("spooled", func() bool { n, _ := h.b.spool.Count(); return n == 1 })
	h.halt() // bridge stops (as in a crash after the spool write)

	h.start() // reloads the spool
	h.eventually("resubscribed", h.subscribed)
	a := h.b.Snapshot()
	if len(a) != 1 || a[0].StreamSum != 600 || a[0].StreamGaps == 0 {
		t.Fatalf("reloaded: %+v", a)
	}
	h.redis.dropAll() // Redis connection lost; anything queued is gone
	h.eventually("gap recorded", func() bool { return h.b.Status().Gaps >= 1 })
	h.eventually("resubscribed", func() bool { return h.b.Status().SubscriptionUp })
	time.Sleep(60 * time.Millisecond)
	h.c.mode.Store("")
	h.redis.publish(chan4(u, tSID, "total_traffic"), counters(1000, 1000))
	h.eventually("final settled", func() bool { n, _ := h.b.spool.Count(); return n == 0 && h.c.billed() == 2000 })
}

// More unsettled allocations than one request holds: every one is delivered,
// oldest attempt first, BatchSize at a time.
func TestBridgeFairPagination(t *testing.T) {
	h := newHarness(t, account.CoturnMeteringShadow)
	h.c.mode.Store("down")
	h.start()
	h.eventually("subscription", h.subscribed)
	u := h.c.username("g1")
	for i := range 10 {
		h.redis.publish(chan4(u, fmt.Sprintf("0070000000000000%02d", i), "total_traffic"), counters(uint64(i+1), 0))
	}
	h.eventually("spooled", func() bool { n, _ := h.b.spool.Count(); return n == 10 })
	h.c.mode.Store("")
	h.eventually("all delivered", func() bool { n, _ := h.b.spool.Count(); return n == 0 })
	bs, _ := h.c.store.CoturnBindings(context.Background())
	if len(bs) != 10 {
		t.Fatalf("%d bindings", len(bs))
	}
	if h.c.billed() != 0 {
		t.Fatal("shadow billed")
	}
}

// A full spool never drops a report: the record stays in memory, is alerted,
// is still delivered, and the ledger counts it exactly once.
func TestBridgeFullSpoolStillDeliversAndAlerts(t *testing.T) {
	h := newHarness(t, account.CoturnMeteringBillable)
	h.c.mode.Store("down")
	h.startWith(func(c *Config) { c.SpoolMaxEntries = 1 })
	h.eventually("subscription", h.subscribed)
	u := h.c.username("g1")
	h.redis.publish(chan4(u, "007000000000000001", "total_traffic"), counters(100, 0))
	h.redis.publish(chan4(u, "007000000000000002", "total_traffic"), counters(0, 50))
	h.eventually("spool full alerted", func() bool { return h.logs.has("spool full") && h.b.Status().Unpersisted == 1 })
	if n, _ := h.b.spool.Count(); n != 1 || len(h.b.Snapshot()) != 2 {
		t.Fatalf("spool %d, tracked %d", n, len(h.b.Snapshot()))
	}
	h.c.mode.Store("")
	h.eventually("both delivered", func() bool { return h.c.billed() == 150 && len(h.b.Snapshot()) == 0 })
	if n, _ := h.b.spool.Count(); n != 0 {
		t.Fatalf("spool %d after delivery", n)
	}
}
