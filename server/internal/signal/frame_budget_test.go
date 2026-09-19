package signal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Two invariants of the ServeWS read loop, both about what a connection has
// earned before the server acts on its frames.
//
//  1. BUDGET. Every decoded frame is charged exactly once, whatever its type.
//     The single exemption is the join that admits the connection. Charged too
//     little and a frame the type switch ignores — an unknown type, `null`, a
//     repeat join — is a free flood channel that still costs a read and a JSON
//     parse. Charged twice and an ordinary rendezvous pays double for the
//     frames it legitimately sends, so a real pairing can be closed mid-flight.
//
//  2. ADMISSION. A signal is forwarded only for a connection the hub admitted.
//     Hub.Relay resolves `to` inside the room and never checks the sender.
//
// These drive the real read loop over a real websocket (wsFixture / writeFrame
// / readRoster live in activate_ws_test.go). connlimit_test.go pins the bucket
// arithmetic; it cannot see eligibility, which is where both defects were.
//
// **Positive evidence here is a marker frame received by a second admitted
// peer, never silence.** A quiet socket proves nothing about how much of what
// we wrote the server actually consumed; an in-order marker at the far end
// proves the whole prefix was processed and the connection was not closed.

const markerPhase = "marker"

// closeReason reads the server's close status and reason from a read error.
func closeReason(err error) (websocket.StatusCode, string) {
	var ce websocket.CloseError
	if errors.As(err, &ce) {
		return ce.Code, ce.Reason
	}
	return websocket.CloseStatus(err), ""
}

// drainUntilClosed reads until the server closes the socket, reporting the
// close status and reason. The join handshake and any relayed frames arrive
// first, so a single read would see those rather than the close.
func drainUntilClosed(t *testing.T, ctx context.Context, c *websocket.Conn) (websocket.StatusCode, string) {
	t.Helper()
	readCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	for {
		if _, _, err := c.Read(readCtx); err != nil {
			return closeReason(err)
		}
	}
}

// joinAs joins the room and returns the peer id the server assigned, which is
// what another connection must name to reach it.
func joinAs(t *testing.T, ctx context.Context, c *websocket.Conn, name, deviceID string) string {
	t.Helper()
	frame := map[string]any{"type": "join", "name": name}
	if deviceID != "" {
		frame["deviceId"] = deviceID
	}
	writeFrame(t, ctx, c, frame)
	readCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	for {
		_, data, err := c.Read(readCtx)
		if err != nil {
			t.Fatalf("no welcome for %q: %v", name, err)
		}
		e, err := DecodeEnvelope(data)
		if err == nil && e.Type == TypeWelcome {
			return e.Name
		}
	}
}

func signalTo(to, phase string, pad int) map[string]any {
	data := map[string]any{"phase": phase}
	if pad > 0 {
		data["pad"] = strings.Repeat("y", pad)
	}
	return map[string]any{"type": "signal", "to": to, "data": data}
}

// awaitPhase reads the target's stream until a signal carrying `want` arrives.
// Receipt is the positive barrier: the server processed everything the sender
// wrote before it, in order, without closing the sender's socket.
func awaitPhase(t *testing.T, ctx context.Context, c *websocket.Conn, want string) {
	t.Helper()
	readCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	for {
		_, data, err := c.Read(readCtx)
		if err != nil {
			t.Fatalf("marker %q never arrived: %v", want, err)
		}
		e, err := DecodeEnvelope(data)
		if err != nil || e.Type != TypeSignal {
			continue
		}
		var body struct {
			Phase string `json:"phase"`
		}
		if json.Unmarshal(e.Data, &body) == nil && body.Phase == want {
			return
		}
	}
}

// firstSignalPhase returns the phase of the FIRST signal the target receives.
func firstSignalPhase(t *testing.T, ctx context.Context, c *websocket.Conn) string {
	t.Helper()
	readCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	for {
		_, data, err := c.Read(readCtx)
		if err != nil {
			t.Fatalf("no signal reached the target: %v", err)
		}
		e, err := DecodeEnvelope(data)
		if err != nil || e.Type != TypeSignal {
			continue
		}
		var body struct {
			Phase string `json:"phase"`
		}
		if err := json.Unmarshal(e.Data, &body); err != nil {
			t.Fatalf("undecodable signal payload: %v", err)
		}
		return body.Phase
	}
}

func writeRaw(t *testing.T, ctx context.Context, c *websocket.Conn, frame string) bool {
	t.Helper()
	return c.Write(ctx, websocket.MessageText, []byte(frame)) == nil
}

// ── 1. budget: a frame the switch ignores is not a free frame ───────────────

// Adopted from the independent review overlay, with the close REASON asserted
// rather than the status alone: "too many malformed frames" is also a policy
// violation, and for these frames — every one of which decodes cleanly — it
// would be the wrong mechanism passing the test.
func TestIgnoredFramesSpendTheFrameBudget(t *testing.T) {
	for _, tc := range []struct {
		name   string
		frame  string
		joined bool
	}{
		{"unknown-type-before-join", `{"type":"not-a-message"}`, false},
		{"unknown-type-after-join", `{"type":"not-a-message"}`, true},
		{"repeat-join", `{"type":"join","name":"again"}`, true},
		{"null-after-join", `null`, true},
		{"empty-object-after-join", `{}`, true},
		{"empty-type-before-join", `{"type":""}`, false},
		{"signal-before-join", `{"type":"signal","to":"p1","data":{}}`, false},
		{"activate-before-join", `{"type":"activate"}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dial, ctx := wsFixture(t, "c:483920", 2, false)
			c := dial()
			if tc.joined {
				writeFrame(t, ctx, c, map[string]any{"type": "join", "name": "test"})
			}
			// Well past the 50-token burst even allowing for refill.
			for i := 0; i < 300; i++ {
				if !writeRaw(t, ctx, c, tc.frame) {
					break // the server has closed us; remaining writes error
				}
			}
			status, reason := drainUntilClosed(t, ctx, c)
			if status != websocket.StatusPolicyViolation {
				t.Fatalf("ignored frames escaped the budget: close status=%v reason=%q", status, reason)
			}
			if reason != "signal rate exceeded" {
				t.Fatalf("closed for the wrong reason: %q", reason)
			}
		})
	}
}

// The byte half reaches ignored frames too, not just the rate half. ~40 frames
// of ~30 KB is over the 1 MiB budget while under the 50-token burst, so bytes
// are unambiguously what trips.
func TestIgnoredFramesSpendTheByteBudget(t *testing.T) {
	dial, ctx := wsFixture(t, "c:483920", 2, false)
	c := dial()
	writeFrame(t, ctx, c, map[string]any{"type": "join", "name": "test"})

	payload, _ := json.Marshal(strings.Repeat("y", 30000))
	for i := 0; i < 40; i++ {
		frame, _ := json.Marshal(map[string]any{"type": "not-a-message", "data": json.RawMessage(payload)})
		if c.Write(ctx, websocket.MessageText, frame) != nil {
			break
		}
	}
	status, reason := drainUntilClosed(t, ctx, c)
	if status != websocket.StatusPolicyViolation || reason != "signal budget exceeded" {
		t.Fatalf("want byte-budget close, got status=%v reason=%q", status, reason)
	}
}

// ── 2. budget: the exemption is exactly one frame, and nothing is doubled ───

// **The admitting join costs nothing, proved on the deterministic half of the
// budget.** The token bucket refills, so a one-frame difference in it is not a
// sound discriminator; the byte budget never refills. The fixture sends a large
// join plus exactly as many signal frames as fit under the byte budget WITHOUT
// it, and asserts the two conditions that make that a real discriminator. If
// the join were charged, the run would cross the budget and the marker would
// never reach the far end.
func TestAdmittingJoinIsExemptFromTheByteBudget(t *testing.T) {
	dial, ctx := wsFixture(t, "c:483920", 2, false)
	target := dial()
	targetID := joinAs(t, ctx, target, "target", "")

	sender := dial()
	joinFrame := map[string]any{"type": "join", "name": strings.Repeat("j", 30000)}
	joinBytes, err := json.Marshal(joinFrame)
	if err != nil {
		t.Fatalf("marshal join: %v", err)
	}
	sigBytes, err := json.Marshal(signalTo(targetID, "filler", 29000))
	if err != nil {
		t.Fatalf("marshal signal: %v", err)
	}
	n := maxSignalBytes / len(sigBytes) // fits exactly, with the join exempt

	// The fixture only means something while all three hold.
	if len(joinBytes) >= maxFrameBytes || len(sigBytes) >= maxFrameBytes {
		t.Fatalf("fixture frame exceeds the read limit: join=%d signal=%d", len(joinBytes), len(sigBytes))
	}
	if n > signalBurst {
		t.Fatalf("fixture would trip the rate limit first: n=%d burst=%d", n, signalBurst)
	}
	if len(joinBytes)+n*len(sigBytes) <= maxSignalBytes {
		t.Fatalf("fixture does not discriminate: a charged join would still fit (%d + %d*%d <= %d)",
			len(joinBytes), n, len(sigBytes), maxSignalBytes)
	}

	if err := sender.Write(ctx, websocket.MessageText, joinBytes); err != nil {
		t.Fatalf("write join: %v", err)
	}
	for i := 0; i < n-1; i++ {
		if sender.Write(ctx, websocket.MessageText, sigBytes) != nil {
			break
		}
	}
	writeFrame(t, ctx, sender, signalTo(targetID, markerPhase, 29000))
	awaitPhase(t, ctx, target, markerPhase)
}

// A normal paired rendezvous is relayed and is not double-charged. 45 charged
// frames sit inside the 50-token burst; billed twice they are 90 and the server
// closes a healthy pairing before the marker lands. This is a no-doubling and
// normal-relay assertion — the exact exemption boundary is the test above.
func TestPairedSessionIsNotDoubleCharged(t *testing.T) {
	dial, ctx := wsFixture(t, "c:483920", 2, false)
	target := dial()
	targetID := joinAs(t, ctx, target, "target", "")

	sender := dial()
	joinAs(t, ctx, sender, "sender", "")
	for i := 0; i < 44; i++ {
		writeFrame(t, ctx, sender, signalTo(targetID, "filler", 0))
	}
	writeFrame(t, ctx, sender, signalTo(targetID, markerPhase, 0))
	awaitPhase(t, ctx, target, markerPhase)
}

// The same statement for a LAN room, where a session legitimately mixes
// activate with signal. Both were charged inside their own switch branch before
// the charge moved above the switch; leaving either behind doubles the bill for
// exactly the frames real clients send. 41 charged frames fit the burst; 82 do
// not.
func TestMixedActivateAndSignalSessionIsNotDoubleCharged(t *testing.T) {
	dial, ctx := wsFixture(t, "lan", 4, true)
	target := dial()
	targetID := joinAs(t, ctx, target, "target", "0123456789abcdef0123456789abcdef")

	sender := dial()
	joinAs(t, ctx, sender, "sender", "fedcba9876543210fedcba9876543210")
	for i := 0; i < 20; i++ {
		writeFrame(t, ctx, sender, map[string]any{"type": "activate"})
		writeFrame(t, ctx, sender, signalTo(targetID, "filler", 0))
	}
	writeFrame(t, ctx, sender, signalTo(targetID, markerPhase, 0))
	awaitPhase(t, ctx, target, markerPhase)
}

// …and the budget is still real on a LAN connection that keeps going.
func TestLanActivateFloodStillTripsTheBudget(t *testing.T) {
	dial, ctx := wsFixture(t, "lan", 4, true)
	c := dial()
	joinAs(t, ctx, c, "loud", "fedcba9876543210fedcba9876543210")
	for i := 0; i < 300; i++ {
		if !writeRaw(t, ctx, c, `{"type":"activate"}`) {
			break
		}
	}
	status, reason := drainUntilClosed(t, ctx, c)
	if status != websocket.StatusPolicyViolation || reason != "signal rate exceeded" {
		t.Fatalf("want rate-limit close, got status=%v reason=%q", status, reason)
	}
}

// ── 3. budget: the malformed path keeps its own rule ────────────────────────

// Malformed frames are charged (they always were) AND capped at
// maxMalformedFrames consecutive. 25 undecodable frames is over that cap and
// under the token burst, so the cap is what must fire: moving the charge above
// the switch must not have routed malformed frames through it as well, which
// would charge them twice.
func TestMalformedFramesKeepTheirConsecutiveCap(t *testing.T) {
	dial, ctx := wsFixture(t, "c:483920", 2, false)
	c := dial()
	writeFrame(t, ctx, c, map[string]any{"type": "join", "name": "test"})
	for i := 0; i < 25; i++ {
		if !writeRaw(t, ctx, c, `{not json`) {
			break
		}
	}
	status, reason := drainUntilClosed(t, ctx, c)
	if status != websocket.StatusPolicyViolation || reason != "too many malformed frames" {
		t.Fatalf("want malformed-cap close, got status=%v reason=%q", status, reason)
	}
}

// A good frame between bad ones still resets the consecutive counter. 15 bad,
// one good, 15 bad: never 20 in a row, and 32 charged frames stay inside the
// burst, so the marker must still arrive.
func TestOneGoodFrameResetsTheMalformedRun(t *testing.T) {
	dial, ctx := wsFixture(t, "c:483920", 2, false)
	target := dial()
	targetID := joinAs(t, ctx, target, "target", "")

	sender := dial()
	joinAs(t, ctx, sender, "sender", "")
	for i := 0; i < 15; i++ {
		writeRaw(t, ctx, sender, `{not json`)
	}
	writeFrame(t, ctx, sender, signalTo(targetID, "filler", 0))
	for i := 0; i < 15; i++ {
		writeRaw(t, ctx, sender, `{not json`)
	}
	writeFrame(t, ctx, sender, signalTo(targetID, markerPhase, 0))
	awaitPhase(t, ctx, target, markerPhase)
}

// ── 4. admission: the hub forwards only for an admitted connection ──────────

// **A signal is a membership action.** An un-joined socket that knows an
// admitted peer's opaque server-issued id could reach it: Hub.Relay resolves
// `to` inside the room and never checks the sender, and ServeWS relayed before
// the join branch had run. That sender is on no roster, so the peer also never
// gets the `left` frame for it.
//
// The barrier is positive and ordered — the same socket sends "before-join",
// then joins, then sends "after-join", and the FIRST signal the target sees
// must be "after-join". No absence timeout is involved.
func TestSignalIsNotForwardedBeforeAdmission(t *testing.T) {
	dial, ctx := wsFixture(t, "c:483920", 2, false)
	target := dial()
	targetID := joinAs(t, ctx, target, "target", "")

	sender := dial()
	writeFrame(t, ctx, sender, signalTo(targetID, "before-join", 0))
	joinAs(t, ctx, sender, "sender", "")
	writeFrame(t, ctx, sender, signalTo(targetID, "after-join", 0))

	if got := firstSignalPhase(t, ctx, target); got != "after-join" {
		t.Fatalf("forwarded before membership admission: first signal was %q", got)
	}
}

// Suppressing the relay must not make a pre-join signal free: it still costs
// what it cost to receive. Sized on the deterministic byte budget rather than
// the bucket, and the connection never joins, so the only thing that can close
// it is the budget.
func TestPreJoinSignalsStillSpendTheByteBudget(t *testing.T) {
	dial, ctx := wsFixture(t, "c:483920", 2, false)
	c := dial()
	frame, _ := json.Marshal(signalTo("p1", "before-join", 29000))
	for i := 0; i < maxSignalBytes/len(frame)+2; i++ {
		if c.Write(ctx, websocket.MessageText, frame) != nil {
			break
		}
	}
	status, reason := drainUntilClosed(t, ctx, c)
	if status != websocket.StatusPolicyViolation || reason != "signal budget exceeded" {
		t.Fatalf("want byte-budget close for an un-joined sender, got status=%v reason=%q", status, reason)
	}
}

// ── 4b. a refused join is terminal, proved on the refused socket ────────────

// hubRoomFixture is wsFixture (activate_ws_test.go) plus the hub itself. The two
// tests below need Hub.Relay by hand: relaying for a sender the room never
// admitted is precisely the defect the admission guard exists to stop, and the
// negative control has no other way to produce it without editing the read loop.
// Its peer ids are prefixed differently from wsFixture's so a stale id from one
// fixture can never name a peer in the other.
func hubRoomFixture(t *testing.T, room string, maxPeers int, lan bool) (*Hub, func() *websocket.Conn, context.Context) {
	t.Helper()
	h := NewHub()
	var seq int32
	newID := func() string { n := atomic.AddInt32(&seq, 1); return "r" + strconv.Itoa(int(n)) }
	handle := ServeWS(h, newID)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		handle(r.Context(), c, room, maxPeers, "127.0.0.1", lan)
		// The handler owns no close of its own on the refusal path, so this is
		// the observable end of the connection — see the barrier below.
		_ = c.Close(websocket.StatusNormalClosure, "")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	return h, func() *websocket.Conn {
		t.Helper()
		c, _, err := websocket.Dial(ctx, url, nil)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		t.Cleanup(func() { c.CloseNow() })
		return c
	}, ctx
}

const refusalRoom = "c:483920"

// A join the room refuses leaves no way in either: the refusal ends the read
// loop, so a connection that was kept out never reaches the admitted peer,
// whatever it writes next.
//
// **The barrier is the refused socket's OWN close, awaited before the marker is
// written.** An earlier version wrote the marker on a different socket and
// claimed its arrival proved the refused socket's frames had been dealt with;
// two sockets are two read goroutines, and nothing orders them, so a frame that
// did leak could simply have arrived after the marker. The ordering this version
// relies on is real and entirely within the server:
//
//   - anything the server could forward for this connection happens on this
//     connection's read goroutine, inside the read loop, hence strictly before
//     the handler returns;
//   - Hub.Relay is synchronous and writes under the target's own write mutex, so
//     when it returns the frame is already on the target's socket;
//   - the close we read here is written after the handler returned, so observing
//     it places us after any such write;
//   - the marker is written only afterwards, and the target reads one TCP stream
//     in order.
//
// So if any frame had been forwarded on behalf of the refused connection, the
// target's FIRST signal would be that frame and not the marker. No sleep and no
// absence timeout is involved. TestRefusalBarrierReportsAnUnadmittedForward is
// the negative control for exactly that claim.
//
// Note what the close status is and is not: the refusal path returns silently
// (see the `room full` branch in ServeWS), so the status here is the fixture's
// own post-handler StatusNormalClosure, NOT a policy violation naming a full
// room. That is what makes it usable as the barrier — it is emitted only once
// the handler has returned. Asserting it also excludes the one other way
// drainUntilClosed can return, its 3s read deadline, which yields status -1.
func TestRefusedJoinCannotSignalIntoTheRoom(t *testing.T) {
	_, dial, ctx := hubRoomFixture(t, refusalRoom, 2, false) // room holds two peers
	target := dial()
	targetID := joinAs(t, ctx, target, "target", "")
	barrier := dial()
	joinAs(t, ctx, barrier, "barrier", "") // room is now full

	refused := dial()
	refusedJoin, _ := json.Marshal(map[string]any{"type": "join", "name": "refused"})
	refusedSignal, _ := json.Marshal(signalTo(targetID, "after-refusal", 0))
	// Tolerant writes: the refusal ends this socket underneath us.
	_ = refused.Write(ctx, websocket.MessageText, refusedJoin)
	_ = refused.Write(ctx, websocket.MessageText, refusedSignal)

	if status, reason := drainUntilClosed(t, ctx, refused); status != websocket.StatusNormalClosure {
		t.Fatalf("the refused socket did not end: close status=%v reason=%q", status, reason)
	}

	writeFrame(t, ctx, barrier, signalTo(targetID, markerPhase, 0))

	if got := firstSignalPhase(t, ctx, target); got != markerPhase {
		t.Fatalf("a refused connection reached the room: first signal was %q", got)
	}
}

// Negative control for the barrier above, and the reason its passing means
// something. The refusal's terminal `return` is one statement in the read loop
// and a test cannot remove it, so drive the leak it prevents directly: Hub.Relay
// resolves `to` inside the room and never looks at the sender, so calling it for
// a connection the room refused IS the frame that must never appear. It is
// injected before the barrier awaits the close, which is the whole window a real
// leak could occupy (the read loop cannot forward anything after it returns), and
// the barrier assertion must then name it rather than the marker. If this test
// reported the marker, the test above would be vacuous.
func TestRefusalBarrierReportsAnUnadmittedForward(t *testing.T) {
	h, dial, ctx := hubRoomFixture(t, refusalRoom, 2, false)
	target := dial()
	targetID := joinAs(t, ctx, target, "target", "")
	barrier := dial()
	joinAs(t, ctx, barrier, "barrier", "")

	refused := dial()
	refusedJoin, _ := json.Marshal(map[string]any{"type": "join", "name": "refused"})
	_ = refused.Write(ctx, websocket.MessageText, refusedJoin)

	// The mutant: the room forwards for a sender it never admitted.
	h.Relay(refusalRoom, Envelope{Type: TypeSignal, To: targetID, Data: json.RawMessage(`{"phase":"after-refusal"}`)})

	if status, reason := drainUntilClosed(t, ctx, refused); status != websocket.StatusNormalClosure {
		t.Fatalf("the refused socket did not end: close status=%v reason=%q", status, reason)
	}
	writeFrame(t, ctx, barrier, signalTo(targetID, markerPhase, 0))

	if got := firstSignalPhase(t, ctx, target); got != "after-refusal" {
		t.Fatalf("the barrier missed an unadmitted forward: first signal was %q", got)
	}
}

// ── 5. concurrency, for -race ───────────────────────────────────────────────

// Several connections in one room, each charging its OWN limiter on its own
// read goroutine while the hub relays between them. A shared or racy budget
// would show up as a data race, as one peer's traffic closing another, or as a
// hub panic on a peer torn down mid-relay.
func TestFrameBudgetIsPerConnectionUnderConcurrency(t *testing.T) {
	const flooders = 6
	dial, ctx := wsFixture(t, "lan", 0, true)

	// A well-behaved pair that must survive everything the others do.
	target := dial()
	targetID := joinAs(t, ctx, target, "target", "")
	good := dial()
	joinAs(t, ctx, good, "good", "")

	var wg sync.WaitGroup
	closed := make([]struct {
		status websocket.StatusCode
		reason string
	}, flooders)
	for i := 0; i < flooders; i++ {
		c := dial()
		joinAs(t, ctx, c, "flooder", "")
		wg.Add(1)
		go func(i int, c *websocket.Conn) {
			defer wg.Done()
			for n := 0; n < 300; n++ {
				if !writeRaw(t, ctx, c, `{"type":"not-a-message"}`) {
					break
				}
			}
			closed[i].status, closed[i].reason = drainUntilClosed(t, ctx, c)
		}(i, c)
	}
	wg.Wait()

	for i, got := range closed {
		if got.status != websocket.StatusPolicyViolation || got.reason != "signal rate exceeded" {
			t.Fatalf("flooder %d: want rate-limit close, got status=%v reason=%q", i, got.status, got.reason)
		}
	}
	// The quiet peer spent nothing but its exempt join, so its budget is intact
	// and its relay still works.
	for i := 0; i < 40; i++ {
		writeFrame(t, ctx, good, signalTo(targetID, "filler", 0))
	}
	writeFrame(t, ctx, good, signalTo(targetID, markerPhase, 0))
	awaitPhase(t, ctx, target, markerPhase)
}
