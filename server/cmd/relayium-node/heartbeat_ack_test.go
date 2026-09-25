package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// G34-N10: a closed allocation's final byte total must survive a heartbeat that
// does not succeed. The registry used to evict a closed entry inside the very
// snapshot that reported it, BEFORE the POST, so a heartbeat that failed on the
// network lost the allocation's last bytes for good. Now snapshot only samples
// and ack evicts, and sendHeartbeat acks only on a decoded ok response.
//
// What these tests hold the node to:
//
//	A1  A heartbeat that fails in ANY way — transport error, lost response,
//	    HTTP error, undecodable 200, 200 without ok — acknowledges nothing.
//	A2  A successful heartbeat acknowledges exactly the final totals it
//	    carried: never a live sample, never a total that has moved since.
//	A3  Re-sending a final total bills it once (central keeps the max per
//	    alloc_id), proven against the real central handler and SQLite ledger
//	    in heartbeat_ledger_test.go.
//	A4  A backlog drains within central's per-user and body limits, one POST
//	    per heartbeat, without dropping an entry and without starving live
//	    allocations.

// ackedSnapshot is one SUCCESSFUL heartbeat reduced to the registry: take the
// batch, send the attributed samples, and acknowledge exactly those. The
// existing lifecycle tests use it where they previously relied on snapshot
// evicting by itself; their byte assertions are unchanged.
func ackedSnapshot(reg *allocRegistry) []allocSample {
	snap := reg.snapshot()
	reg.ack(attributed(snap))
	return snap
}

// attributed is the subset of samples sendHeartbeat actually puts on the wire.
func attributed(snap []allocSample) []allocSample {
	var out []allocSample
	for _, s := range snap {
		if s.Username != "" {
			out = append(out, s)
		}
	}
	return out
}

// ── registry-level acknowledgement ───────────────────────────────────────────

func TestClosedAllocationIsReportedUntilAcknowledged(t *testing.T) {
	reg := newAllocRegistry(nil)
	relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}
	c := reg.wrap(fakePC{}, relay)
	reg.created(relay, "6000:userA.1")
	c.WriteTo(make([]byte, 900), &net.UDPAddr{})
	mustClose(t, c)

	// Three heartbeats whose POST never succeeded: no ack.
	for i := 0; i < 3; i++ {
		snap := reg.snapshot()
		if len(snap) != 1 || snap[0].RelayedBytes != 900 || !snap[0].Final {
			t.Fatalf("unacknowledged heartbeat %d = %+v, want the final 900 bytes again", i, snap)
		}
	}
	if st := reg.stats(); st.AwaitingFlush != 1 || st.Live != 0 {
		t.Fatalf("stats = %+v, want one retired entry awaiting its acknowledged flush", st)
	}
	if got := reg.activeAllocs(); got != 0 {
		t.Fatalf("activeAllocs = %d, want 0 — a retained final is not a live transfer", got)
	}

	snap := ackedSnapshot(reg)
	if len(snap) != 1 || snap[0].RelayedBytes != 900 {
		t.Fatalf("acknowledged heartbeat = %+v, want the final 900 bytes", snap)
	}
	if got := reg.snapshot(); len(got) != 0 {
		t.Fatalf("after acknowledgement: %+v, want nothing left to report", got)
	}
	if e, r := indexSizes(reg); e != 0 || r != 0 {
		t.Fatalf("entries=%d byRelay=%d, want 0/0", e, r)
	}
}

// A2: a LIVE sample never retires anything, including when the allocation
// closes between the snapshot and the acknowledgement with more bytes.
func TestAckOfLiveSampleDoesNotEvictAllocationThatClosedLater(t *testing.T) {
	reg := newAllocRegistry(nil)
	relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}
	c := reg.wrap(fakePC{}, relay)
	reg.created(relay, "6000:userA.1")
	c.WriteTo(make([]byte, 100), &net.UDPAddr{})

	inFlight := reg.snapshot() // live, 100 bytes
	c.WriteTo(make([]byte, 50), &net.UDPAddr{})
	mustClose(t, c)
	reg.ack(attributed(inFlight)) // the stale success arrives now

	snap := reg.snapshot()
	if len(snap) != 1 || snap[0].RelayedBytes != 150 || !snap[0].Final {
		t.Fatalf("after a stale ack of a live sample: %+v, want the final 150 bytes still owed", snap)
	}

	// Even with no bytes after the live sample, a live sample is not a final.
	reg2 := newAllocRegistry(nil)
	c2 := reg2.wrap(fakePC{}, relay)
	reg2.created(relay, "6000:userA.2")
	c2.WriteTo(make([]byte, 70), &net.UDPAddr{})
	live := reg2.snapshot()
	mustClose(t, c2)
	reg2.ack(attributed(live))
	if got := reg2.snapshot(); len(got) != 1 || !got[0].Final || got[0].RelayedBytes != 70 {
		t.Fatalf("an ack of a live sample evicted the later-closed entry: %+v", got)
	}
}

// A2: an ack whose final total no longer matches the entry does not evict it.
// A closed relay socket cannot normally move bytes, but the check is what makes
// "acknowledged" mean "central has this exact total", so it is tested directly.
func TestStaleFinalAckDoesNotEraseNewerBytes(t *testing.T) {
	reg := newAllocRegistry(nil)
	relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}
	c := reg.wrap(fakePC{}, relay).(*countingPacketConn)
	reg.created(relay, "6000:userA.1")
	c.WriteTo(make([]byte, 400), &net.UDPAddr{})
	mustClose(t, c)

	sent := reg.snapshot()
	// Bytes land on the entry after the final was sampled (bracketed exactly as
	// the wrapper brackets real I/O).
	c.beginIO()
	c.tally(25)
	c.endIO()
	reg.ack(attributed(sent))

	snap := reg.snapshot()
	if len(snap) != 1 || snap[0].RelayedBytes != 425 {
		t.Fatalf("after a stale final ack: %+v, want the newer 425-byte total still owed", snap)
	}
	reg.ack(attributed(snap))
	reg.ack(attributed(snap)) // duplicate
	reg.ack(attributed(sent)) // very late duplicate of the stale one
	if e, r := indexSizes(reg); e != 0 || r != 0 {
		t.Fatalf("entries=%d byRelay=%d, want 0/0", e, r)
	}
}

// A2: an ack while the closed entry has I/O in flight cannot evict it: that
// snapshot never offered it as final in the first place, and a forged final
// for it is refused by the pending check.
func TestAckDuringInFlightIOKeepsTheEntry(t *testing.T) {
	reg := newAllocRegistry(nil)
	relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}
	hz := &hazardPC{}
	c := reg.wrap(hz, relay)
	reg.created(relay, "6000:userF.1")
	c.WriteTo(make([]byte, 250), &net.UDPAddr{})

	var innerSnap []allocSample
	var id string
	for _, s := range reg.snapshot() {
		id = s.AllocID
	}
	hz.onIO = func() {
		_ = c.Close()
		innerSnap = ackedSnapshot(reg)
		// Even a final for the settled figure, acknowledged now, must not evict.
		reg.ack([]allocSample{{AllocID: id, Username: "6000:userF.1", RelayedBytes: 250, Final: true}})
	}
	c.ReadFrom(make([]byte, 500))

	if len(innerSnap) != 0 {
		t.Fatalf("snapshot with I/O in flight = %+v, want the closed entry held back", innerSnap)
	}
	if got := ackedSnapshot(reg); len(got) != 1 || got[0].RelayedBytes != 750 {
		t.Fatalf("after the I/O settled: %+v, want one final of 750 bytes", got)
	}
	if e, r := indexSizes(reg); e != 0 || r != 0 {
		t.Fatalf("entries=%d byRelay=%d, want 0/0", e, r)
	}
}

// Relay port reuse: the acknowledgement for the first allocation cannot touch
// the second on the same port, and duplicate closes keep one retained final.
func TestAckIsKeyedToTheExactAllocationAcrossPortReuse(t *testing.T) {
	reg := newAllocRegistry(nil)
	relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}

	a := reg.wrap(fakePC{}, relay)
	reg.created(relay, "6000:userA.1")
	a.WriteTo(make([]byte, 100), &net.UDPAddr{})
	_ = a.Close()
	_ = a.Close()
	sentA := reg.snapshot()
	if len(sentA) != 1 || !sentA[0].Final {
		t.Fatalf("after duplicate closes: %+v, want exactly one final", sentA)
	}

	// Same relay port, new allocation, same byte count and username.
	b := reg.wrap(fakePC{}, relay)
	reg.created(relay, "6000:userA.1")
	b.WriteTo(make([]byte, 100), &net.UDPAddr{})
	_ = b.Close()

	reg.ack(attributed(sentA))
	snap := reg.snapshot()
	if len(snap) != 1 || snap[0].AllocID == sentA[0].AllocID || snap[0].RelayedBytes != 100 {
		t.Fatalf("after acking A: %+v, want only B's final left", snap)
	}
	reg.ack(attributed(snap))
	if e, r := indexSizes(reg); e != 0 || r != 0 {
		t.Fatalf("entries=%d byRelay=%d, want 0/0", e, r)
	}
}

// A username that joins after a snapshot is reported by the next one, and the
// allocation's final is then retained until acknowledged like any other.
func TestLateUsernameJoinIsReportedAndRetained(t *testing.T) {
	reg := newAllocRegistry(nil)
	relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}
	c := reg.wrap(fakePC{}, relay)
	c.WriteTo(make([]byte, 30), &net.UDPAddr{})
	if got := attributed(ackedSnapshot(reg)); len(got) != 0 {
		t.Fatalf("unjoined allocation was put on the wire: %+v", got)
	}
	reg.created(relay, "6000:userJ.1")
	c.WriteTo(make([]byte, 20), &net.UDPAddr{})
	mustClose(t, c)
	if got := reg.snapshot(); len(got) != 1 || got[0].RelayedBytes != 50 || got[0].Username != "6000:userJ.1" {
		t.Fatalf("after late join and close: %+v, want the final 50 bytes attributed", got)
	}
	if got := ackedSnapshot(reg); len(got) != 1 || got[0].RelayedBytes != 50 {
		t.Fatalf("retry: %+v, want the same final", got)
	}
	if got := reg.snapshot(); len(got) != 0 {
		t.Fatalf("after ack: %+v", got)
	}
}

// A probe socket that was never attributed can never be reported, so it must
// not wait for an acknowledgement that will never name it — including while
// every heartbeat is failing.
func TestUnattributedClosedSocketIsEvictedWithoutAck(t *testing.T) {
	reg := newAllocRegistry(nil)
	for i := 0; i < 10; i++ {
		relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000 + i}
		mustClose(t, reg.wrap(fakePC{}, relay))
	}
	snap := reg.snapshot() // a heartbeat that then fails: no ack
	if len(snap) != 10 || len(attributed(snap)) != 0 {
		t.Fatalf("probe snapshot = %+v, want 10 unattributed finals, none sent", snap)
	}
	if e, r := indexSizes(reg); e != 0 || r != 0 {
		t.Fatalf("entries=%d byRelay=%d, want 0/0 — probe sockets leaked while heartbeats fail", e, r)
	}
	if st := reg.stats(); st != (allocStats{RetiredUnjoined: 10}) {
		t.Fatalf("stats = %+v", st)
	}
}

// ── bounded batches ─────────────────────────────────────────────────────────

// usernameFor yields a distinct username per allocation for one account.
func usernameFor(user string, i int) string { return fmt.Sprintf("6000:%s.%d", user, i) }

// drainUntilEmpty runs successful heartbeats until nothing is left and returns
// every final total that was acknowledged, checking every batch's bounds.
func drainUntilEmpty(t *testing.T, reg *allocRegistry, maxBeats int) (finals map[string]int64, beats int) {
	t.Helper()
	finals = map[string]int64{}
	for beats = 0; beats < maxBeats; beats++ {
		snap := reg.snapshot()
		sent := attributed(snap)
		checkBatchBounds(t, sent)
		for _, s := range sent {
			if s.Final {
				finals[s.AllocID] = s.RelayedBytes
			}
		}
		reg.ack(sent)
		if e, _ := indexSizes(reg); e == 0 {
			return finals, beats + 1
		}
	}
	t.Fatalf("registry not drained after %d heartbeats", maxBeats)
	return nil, 0
}

func checkBatchBounds(t *testing.T, sent []allocSample) {
	t.Helper()
	if len(sent) > maxUsagePerHeartbeat {
		t.Fatalf("batch of %d usage items, over %d", len(sent), maxUsagePerHeartbeat)
	}
	per := map[string]int{}
	usage := make([]usageItem, 0, len(sent))
	for _, s := range sent {
		per[usageUserKey(s.Username)]++
		usage = append(usage, usageItem{AllocID: s.AllocID, Username: s.Username, RelayedBytes: s.RelayedBytes})
	}
	for u, n := range per {
		if n > maxUsagePerUser {
			t.Fatalf("batch carries %d items for user %q, central records only %d and silently skips the rest", n, u, maxUsagePerUser)
		}
	}
	b, _ := json.Marshal(heartbeatBody{NodeID: "node-1", Status: "ok", Usage: usage})
	if len(b) > 1<<20 {
		t.Fatalf("heartbeat body is %d bytes, over central's 1 MiB limit", len(b))
	}
}

// A4: 200 closed allocations for ONE user (an outage's backlog) drain at 64 per
// heartbeat, every one with its exact final total.
func TestSameUserBacklogDrainsWithinCentralsPerUserCap(t *testing.T) {
	const n = 200
	reg := newAllocRegistry(nil)
	want := map[string]int64{}
	for i := 0; i < n; i++ {
		relay := &net.UDPAddr{IP: net.IPv4(10, 0, 1, 1), Port: 20000 + i}
		c := reg.wrap(fakePC{}, relay)
		reg.created(relay, usernameFor("userB", i))
		c.WriteTo(make([]byte, 10+i), &net.UDPAddr{})
		mustClose(t, c)
	}
	for _, s := range reg.snapshot() { // one failed heartbeat's worth of sampling
		want[s.AllocID] = s.RelayedBytes
	}
	if len(want) != maxUsagePerUser {
		t.Fatalf("one heartbeat carried %d items for one user, want exactly %d", len(want), maxUsagePerUser)
	}
	finals, beats := drainUntilEmpty(t, reg, 10)
	if len(finals) != n {
		t.Fatalf("%d finals acknowledged, want %d", len(finals), n)
	}
	var total, wantTotal int64
	for _, v := range finals {
		total += v
	}
	for i := 0; i < n; i++ {
		wantTotal += int64(10 + i)
	}
	if total != wantTotal {
		t.Fatalf("acknowledged bytes %d, want %d", total, wantTotal)
	}
	if beats != 4 { // ceil(200/64)
		t.Fatalf("drained in %d heartbeats, want 4", beats)
	}
}

// A4: long usernames push a backlog past what one 1 MiB body can hold, while
// staying under the per-user and per-heartbeat item counts, so the wire budget
// is the only bound that can hold it. It must drain across heartbeats with
// every body under central's limit and nothing dropped.
func TestBacklogBeyondOneBodyDrainsWithinTheWireBudget(t *testing.T) {
	const users, perUser = 40, 10 // 400 items: under 512 total and 64 per user
	pad := strings.Repeat("x", 3000)
	reg := newAllocRegistry(nil)
	var all int
	for u := 0; u < users; u++ {
		for i := 0; i < perUser; i++ {
			relay := &net.UDPAddr{IP: net.IPv4(10, 1, byte(u), 1), Port: 30000 + i}
			c := reg.wrap(fakePC{}, relay).(*countingPacketConn)
			name := fmt.Sprintf("6000:user%d.%s%d", u, pad, i)
			reg.created(relay, name)
			c.WriteTo(make([]byte, 1), &net.UDPAddr{})
			mustClose(t, c)
			all += usageWireSize(allocSample{AllocID: c.id, Username: name, RelayedBytes: 1})
		}
	}
	if all <= 1<<20 {
		t.Fatalf("fixture backlog is only %d bytes; it must exceed central's 1 MiB body limit", all)
	}
	first := attributed(reg.snapshot())
	var w int
	for _, s := range first {
		w += usageWireSize(s)
	}
	if w > maxUsageWireBytes {
		t.Fatalf("first batch is %d bytes of usage, over the %d budget", w, maxUsageWireBytes)
	}
	if len(first) == 0 || len(first) >= users*perUser {
		t.Fatalf("first batch has %d of %d items: the wire budget did not split the backlog", len(first), users*perUser)
	}
	checkBatchBounds(t, first)
	finals, _ := drainUntilEmpty(t, reg, 10)
	if len(finals) != users*perUser {
		t.Fatalf("%d finals acknowledged, want %d", len(finals), users*perUser)
	}
}

// A4: while a large backlog drains, a live allocation of the same user is
// still reported regularly, not after the whole backlog.
func TestBacklogDoesNotStarveLiveAllocations(t *testing.T) {
	reg := newAllocRegistry(nil)
	for i := 0; i < 300; i++ {
		relay := &net.UDPAddr{IP: net.IPv4(10, 0, 2, 1), Port: 20000 + i}
		c := reg.wrap(fakePC{}, relay)
		reg.created(relay, usernameFor("userC", i))
		mustClose(t, c)
	}
	liveRelay := &net.UDPAddr{IP: net.IPv4(10, 0, 3, 1), Port: 40000}
	live := reg.wrap(fakePC{}, liveRelay)
	reg.created(liveRelay, "6000:userC.live")

	// Heartbeats keep failing; the live allocation keeps relaying.
	seenLive := 0
	for beat := 0; beat < 10; beat++ {
		live.WriteTo(make([]byte, 10), &net.UDPAddr{})
		for _, s := range reg.snapshot() {
			if s.Username == "6000:userC.live" {
				seenLive++
			}
		}
	}
	// 301 entries, 64 per heartbeat: every entry at least once per 5 heartbeats.
	if seenLive < 2 {
		t.Fatalf("live allocation reported %d times in 10 heartbeats behind a 300-entry backlog", seenLive)
	}
	if got := reg.activeAllocs(); got != 1 {
		t.Fatalf("activeAllocs = %d, want 1 — retained finals are not active transfers", got)
	}
}

// Failed heartbeats rotate through a backlog: each entry is offered once before
// any is offered twice, so nothing is starved while central is unreachable and
// the batch after recovery is not always the same 64.
func TestFailedHeartbeatsRotateThroughTheBacklog(t *testing.T) {
	const n = 150
	reg := newAllocRegistry(nil)
	for i := 0; i < n; i++ {
		relay := &net.UDPAddr{IP: net.IPv4(10, 0, 4, 1), Port: 20000 + i}
		c := reg.wrap(fakePC{}, relay)
		reg.created(relay, usernameFor("userD", i))
		mustClose(t, c)
	}
	offered := map[string]int{}
	for beat := 0; beat < 3; beat++ { // 3 x 64 = 192 >= 150
		batch := attributed(reg.snapshot())
		if len(batch) != maxUsagePerUser {
			t.Fatalf("failed heartbeat %d offered %d items, want %d", beat+1, len(batch), maxUsagePerUser)
		}
		for _, s := range batch {
			offered[s.AllocID]++
		}
		if beat < 2 {
			for id, k := range offered {
				if k > 1 {
					t.Fatalf("%s offered twice before every entry was offered once", id)
				}
			}
		}
	}
	if len(offered) != n {
		t.Fatalf("three failed heartbeats offered %d distinct entries, want all %d", len(offered), n)
	}
	for id, k := range offered {
		if k > 2 {
			t.Fatalf("%s offered %d times in 3 heartbeats", id, k)
		}
	}
}

// ── sendHeartbeat end to end ────────────────────────────────────────────────

// centralStub records every heartbeat body and answers with respond.
type centralStub struct {
	mu      sync.Mutex
	bodies  []heartbeatBody
	respond func(w http.ResponseWriter, call int)
}

func (c *centralStub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var hb heartbeatBody
	b, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(b, &hb)
	c.mu.Lock()
	c.bodies = append(c.bodies, hb)
	call := len(c.bodies)
	c.mu.Unlock()
	c.respond(w, call)
}

func okResponse(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(heartbeatResp{OK: true})
}

// A1: every way a heartbeat can fail leaves the final total in place, and the
// next healthy heartbeat carries it and then retires it.
func TestSendHeartbeatKeepsFinalUntilUsableOKResponse(t *testing.T) {
	failures := []struct {
		name    string
		respond func(w http.ResponseWriter)
	}{
		{"HTTP 503", func(w http.ResponseWriter) { http.Error(w, "down", http.StatusServiceUnavailable) }},
		{"HTTP 500", func(w http.ResponseWriter) { http.Error(w, "server error", http.StatusInternalServerError) }},
		{"200 undecodable", func(w http.ResponseWriter) { _, _ = io.WriteString(w, "<html>proxy</html>") }},
		{"200 truncated JSON", func(w http.ResponseWriter) { _, _ = io.WriteString(w, `{"ok":tr`) }},
		{"200 empty body", func(w http.ResponseWriter) {}},
		{"200 ok=false", func(w http.ResponseWriter) { _, _ = io.WriteString(w, `{"ok":false}`) }},
		{"200 no ok field", func(w http.ResponseWriter) { _, _ = io.WriteString(w, `{"heartbeatInterval":30}`) }},
		{"200 null", func(w http.ResponseWriter) { _, _ = io.WriteString(w, `null`) }},
		{"response lost after the body was read", func(w http.ResponseWriter) {
			hj, ok := w.(http.Hijacker)
			if !ok {
				panic("no hijacker")
			}
			conn, _, _ := hj.Hijack()
			_ = conn.Close()
		}},
	}
	for _, f := range failures {
		t.Run(f.name, func(t *testing.T) {
			stub := &centralStub{respond: func(w http.ResponseWriter, call int) {
				if call <= 3 {
					f.respond(w)
					return
				}
				okResponse(w)
			}}
			central := httptest.NewServer(stub)
			defer central.Close()

			reg := newAllocRegistry(nil)
			relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}
			c := reg.wrap(fakePC{}, relay)
			reg.created(relay, "6000:userA.1")
			c.WriteTo(make([]byte, 4096), &net.UDPAddr{})
			mustClose(t, c)

			rp := newReporter(central.URL, "tok")
			for i := 0; i < 5; i++ {
				sendHeartbeat(rp, "node-1", reg, "", t.TempDir(), nil, nil, nil)
			}
			stub.mu.Lock()
			defer stub.mu.Unlock()
			if len(stub.bodies) != 5 {
				t.Fatalf("%d heartbeats reached central, want 5", len(stub.bodies))
			}
			// Calls 1-3 fail, call 4 succeeds: all four carry the same final;
			// call 5 carries nothing because 4 retired it.
			for i := 0; i < 4; i++ {
				u := stub.bodies[i].Usage
				if len(u) != 1 || u[0].RelayedBytes != 4096 || u[0].Username != "6000:userA.1" {
					t.Fatalf("heartbeat %d usage = %+v, want the final 4096 bytes", i+1, u)
				}
			}
			if u := stub.bodies[4].Usage; len(u) != 0 {
				t.Fatalf("heartbeat after the acknowledged one still carried %+v", u)
			}
			if e, r := indexSizes(reg); e != 0 || r != 0 {
				t.Fatalf("entries=%d byRelay=%d, want 0/0", e, r)
			}
		})
	}
}

// A1 with the transport itself down: nothing is listening at all.
func TestSendHeartbeatKeepsFinalWhenCentralIsUnreachable(t *testing.T) {
	dead := httptest.NewServer(http.NotFoundHandler())
	url := dead.URL
	dead.Close()

	reg := newAllocRegistry(nil)
	relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}
	c := reg.wrap(fakePC{}, relay)
	reg.created(relay, "6000:userA.1")
	c.WriteTo(make([]byte, 77), &net.UDPAddr{})
	mustClose(t, c)
	sendHeartbeat(newReporter(url, "tok"), "node-1", reg, "", t.TempDir(), nil, nil, nil)

	if got := reg.snapshot(); len(got) != 1 || got[0].RelayedBytes != 77 || !got[0].Final {
		t.Fatalf("after a connection-refused heartbeat: %+v, want the final 77 bytes kept", got)
	}
}

// A4 through sendHeartbeat: a same-user backlog over central's per-user cap is
// spread across heartbeats, never more than 64 per user in one body.
func TestSendHeartbeatDrainsSameUserBacklogAcrossHeartbeats(t *testing.T) {
	stub := &centralStub{respond: func(w http.ResponseWriter, call int) { okResponse(w) }}
	central := httptest.NewServer(stub)
	defer central.Close()

	const n = 150
	reg := newAllocRegistry(nil)
	for i := 0; i < n; i++ {
		relay := &net.UDPAddr{IP: net.IPv4(10, 0, 5, 1), Port: 20000 + i}
		c := reg.wrap(fakePC{}, relay)
		reg.created(relay, usernameFor("userE", i))
		c.WriteTo(make([]byte, 100), &net.UDPAddr{})
		mustClose(t, c)
	}
	rp := newReporter(central.URL, "tok")
	for i := 0; i < 4; i++ {
		sendHeartbeat(rp, "node-1", reg, "", t.TempDir(), nil, nil, nil)
	}
	stub.mu.Lock()
	defer stub.mu.Unlock()
	seen := map[string]int{}
	for i, hb := range stub.bodies {
		if len(hb.Usage) > maxUsagePerUser {
			t.Fatalf("heartbeat %d carried %d items for one user", i+1, len(hb.Usage))
		}
		for _, u := range hb.Usage {
			seen[u.AllocID]++
		}
	}
	if len(seen) != n {
		t.Fatalf("%d distinct allocations reached central, want %d", len(seen), n)
	}
	for id, k := range seen {
		if k != 1 {
			t.Fatalf("allocation %s sent %d times despite every heartbeat succeeding", id, k)
		}
	}
	if e, _ := indexSizes(reg); e != 0 {
		t.Fatalf("%d entries left after the backlog drained", e)
	}
}

// A1/A2 under -race: relayed I/O, closes, and heartbeats most of which fail,
// all at once. Every allocation's final total must still reach an acknowledged
// heartbeat complete, and nothing may be retired without one.
func TestConcurrentCloseWithFailingHeartbeatsLosesNoBytes(t *testing.T) {
	const (
		allocs        = 32
		writes        = 20
		bytesPerWrite = 64
		wantPerAlloc  = int64(writes * bytesPerWrite)
	)
	reg := newAllocRegistry(nil)
	conns := make([]net.PacketConn, allocs)
	for i := range conns {
		relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000 + i}
		conns[i] = reg.wrap(fakePC{}, relay)
		reg.created(relay, usernameFor("userR", i))
	}

	acked := make(map[string]int64, allocs) // allocID -> final total acknowledged
	beatOnce := func(n int) {
		snap := reg.snapshot()
		if n%3 != 0 {
			return // this heartbeat failed
		}
		sent := attributed(snap)
		reg.ack(sent)
		for _, s := range sent {
			if s.Final {
				acked[s.AllocID] = s.RelayedBytes
			}
		}
	}
	stop := make(chan struct{})
	var beat sync.WaitGroup
	beat.Add(1)
	go func() {
		defer beat.Done()
		for n := 0; ; n++ {
			beatOnce(n)
			select {
			case <-stop:
				return
			default:
			}
		}
	}()
	var wg sync.WaitGroup
	for i := range conns {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < writes; j++ {
				conns[i].WriteTo(make([]byte, bytesPerWrite), &net.UDPAddr{})
			}
			_ = conns[i].Close()
			_ = conns[i].Close()
		}()
	}
	wg.Wait()
	close(stop)
	beat.Wait()
	for n := 0; n < 6; n++ {
		beatOnce(n)
	}

	if e, r := indexSizes(reg); e != 0 || r != 0 {
		t.Fatalf("entries=%d byRelay=%d, want 0/0", e, r)
	}
	if len(acked) != allocs {
		t.Fatalf("%d allocations had a final acknowledged, want %d", len(acked), allocs)
	}
	for id, got := range acked {
		if got != wantPerAlloc {
			t.Fatalf("allocation %s: acknowledged final %d, want %d", id, got, wantPerAlloc)
		}
	}
}
