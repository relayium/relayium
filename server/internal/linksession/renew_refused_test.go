package linksession

// G34-N13: an authenticated prepare this side REFUSES still spends its epoch.
// The refusal verified the peer's HMAC and routed the epoch, so the exact
// signed envelope, replayed after the refusing condition clears, must start
// nothing: no attempt, no server round request, no budget change, no
// deadline change. A fresh, strictly newer signed prepare still works. Every
// envelope here is signed by the peer engine's real link key.

import (
	"maps"
	"testing"
	"time"
)

// rfSigned is side 1's genuinely signed prepare for epoch, addressed to side 0.
func rfSigned(t *testing.T, h *rtHarness, epoch uint32) []byte {
	t.Helper()
	sig := RenewSignal{Type: "prepare", Epoch: epoch}
	p, err := RenewSignalPayload(sig, "b", "a")
	if err != nil {
		t.Fatal(err)
	}
	auth, ok := h.e[1].sign(p)
	if !ok {
		t.Fatal("sign")
	}
	return EncodeRenewEnvelope(sig, auth)
}

// rfSent takes every envelope side 0 has queued for side 1 since the last call.
func rfSent(h *rtHarness) []RenewSignal {
	var out []RenewSignal
	rest := h.q[:0]
	for _, it := range h.q {
		if it.to == 1 && it.kind == "signal" {
			if sig, _, ok := ParseRenewEnvelope(it.raw); ok {
				out = append(out, sig)
				continue
			}
		}
		rest = append(rest, it)
	}
	h.q = rest
	return out
}

func rfInWindow(h *rtHarness) {
	h.toWindow()
	h.l.clk.t = h.l.clk.t.Add(2 * time.Second)
}

type rfGate struct {
	name   string
	reason string
	set    func(h *rtHarness)
	clear  func(h *rtHarness)
}

func rfGates() []rfGate {
	return []rfGate{
		{"idle", renewAbortUnavailable,
			func(h *rtHarness) { h.active[0] = false }, func(h *rtHarness) { h.active[0] = true }},
		{"no-deadline", renewAbortUnavailable,
			func(h *rtHarness) { h.hasBound[0] = false }, func(h *rtHarness) { h.hasBound[0] = true }},
		// roundDenied is cleared by a commit (a later round the server granted).
		{"denied", renewAbortDenied,
			func(h *rtHarness) { h.e[0].roundDenied = true }, func(h *rtHarness) { h.e[0].roundDenied = false }},
		// The approach budget is per round key; a new round (or retention
		// eviction) resets it.
		{"approach-budget", renewAbortUnavailable,
			func(h *rtHarness) { h.e[0].approachSpent[h.e[0].round+1] = RenewMaxPregrantAttempts },
			func(h *rtHarness) { delete(h.e[0].approachSpent, h.e[0].round+1) }},
		{"round-exhausted", renewAbortUnavailable,
			func(h *rtHarness) { h.e[0].migrationSpent[h.e[0].round+1] = RenewMaxEpochsPerRound },
			func(h *rtHarness) { delete(h.e[0].migrationSpent, h.e[0].round+1) }},
		// Refused in Signal before onPrepare; its existing record is preserved.
		{"busy", renewAbortUnavailable,
			func(h *rtHarness) { h.busy[0] = true }, func(h *rtHarness) { h.busy[0] = false }},
	}
}

// Refused while no attempt is in flight, the condition clears, the exact
// signed frame is replayed: nothing starts. Then epoch+1 starts one attempt.
func TestRenewRefusedPrepareReplayStartsNothing(t *testing.T) {
	for _, g := range rfGates() {
		t.Run(g.name, func(t *testing.T) {
			h := newRT(t)
			rfInWindow(h)
			e := h.e[0]
			bound := h.bound[0]
			env := rfSigned(t, h, 1)

			g.set(h)
			if !e.Signal(env) {
				t.Fatal("not consumed")
			}
			out := rfSent(h)
			if len(out) != 1 || out[0].Type != "abort" || out[0].Epoch != 1 || out[0].Reason != g.reason {
				t.Fatalf("refusal sent %+v, want one abort(1, %s)", out, g.reason)
			}
			if e.epochCounter != 1 {
				t.Errorf("the refused, verified prepare left the counter at %d, want 1", e.epochCounter)
			}
			if e.attempt != nil || h.requests[0] != 0 || e.prepareSent != 0 {
				t.Fatalf("refusal started work: attempt %v requests %d prepares %d", e.attempt != nil, h.requests[0], e.prepareSent)
			}

			g.clear(h)
			approach2, migration2 := maps.Clone(e.approachSpent), maps.Clone(e.migrationSpent)
			if !e.Signal(env) { // the exact same signed frame
				t.Fatal("not consumed")
			}
			if out := rfSent(h); len(out) != 0 {
				t.Fatalf("the replay was answered: %+v", out)
			}
			if e.attempt != nil || h.requests[0] != 0 || e.prepareSent != 0 || e.epochCounter != 1 {
				t.Fatalf("replay after %s cleared: attempt %v requests %d prepares %d counter %d",
					g.name, e.attempt != nil, h.requests[0], e.prepareSent, e.epochCounter)
			}
			if !h.bound[0].DeadlineAt.Equal(bound.DeadlineAt) || len(h.commits[0]) != 0 {
				t.Fatal("the deadline moved")
			}
			if !maps.Equal(approach2, e.approachSpent) || !maps.Equal(migration2, e.migrationSpent) {
				t.Fatalf("budget changed by the replay: %v %v -> %v %v", approach2, migration2, e.approachSpent, e.migrationSpent)
			}

			// A fresh, strictly newer legitimate prepare is accepted.
			if !e.Signal(rfSigned(t, h, 2)) {
				t.Fatal("not consumed")
			}
			out = rfSent(h)
			if e.attempt == nil || e.attempt.epoch != 2 || h.requests[0] != 1 || len(out) != 1 || out[0].Type != "prepare" || out[0].Epoch != 2 {
				t.Fatalf("fresh epoch 2: attempt %v requests %d sent %+v", e.attempt, h.requests[0], out)
			}
			if e.peerUnsupported {
				t.Fatal("peer marked unsupported")
			}
		})
	}
}

// The refusal changes no budget: nothing is charged or refunded by it.
func TestRenewRefusedPrepareChargesNothing(t *testing.T) {
	for _, g := range rfGates() {
		t.Run(g.name, func(t *testing.T) {
			h := newRT(t)
			rfInWindow(h)
			e := h.e[0]
			g.set(h)
			approach, migration := maps.Clone(e.approachSpent), maps.Clone(e.migrationSpent)
			e.Signal(rfSigned(t, h, 1))
			if !maps.Equal(approach, e.approachSpent) || !maps.Equal(migration, e.migrationSpent) {
				t.Fatalf("refusal changed budgets: %v %v -> %v %v", approach, migration, e.approachSpent, e.migrationSpent)
			}
		})
	}
}

// Refused while an attempt is in flight (the higher epoch would supersede it):
// once the condition clears, the replayed higher frame does not supersede.
// The budget refusals come after supersession (existing order): the old
// attempt has already ended, charged, when the new epoch is refused.
func TestRenewRefusedHigherEpochNotReusableDuringAttempt(t *testing.T) {
	for _, g := range rfGates() {
		if g.name == "no-deadline" || g.name == "busy" {
			// no-deadline: an attempt cannot exist without one in practice;
			// busy: TestRenewRefusedEpochNotReusableDuringAttempt.
			continue
		}
		t.Run(g.name, func(t *testing.T) {
			h := newRT(t)
			rfInWindow(h)
			e := h.e[0]
			a := e.begin(5, false)
			env := rfSigned(t, h, 6)
			g.set(h)
			e.Signal(env)
			if out := rfSent(h); len(out) != 1 || out[0].Type != "abort" || out[0].Epoch != 6 || out[0].Reason != g.reason {
				t.Fatalf("refusal sent %+v", out)
			}
			want := a
			if g.name == "approach-budget" || g.name == "round-exhausted" {
				want = nil
			}
			if e.epochCounter != 6 {
				t.Errorf("the refused, verified prepare left the counter at %d, want 6", e.epochCounter)
			}
			if e.attempt != want {
				t.Fatalf("refusal: attempt %v", e.attempt)
			}
			g.clear(h)
			reqs := h.requests[0]
			e.Signal(env)
			if e.attempt != want || h.requests[0] != reqs || len(rfSent(h)) != 0 {
				t.Fatalf("a replayed refused prepare superseded the attempt (requests %d -> %d)", reqs, h.requests[0])
			}
			// The next legitimate epoch supersedes as before.
			e.Signal(rfSigned(t, h, 7))
			if e.attempt == nil || e.attempt == a || e.attempt.epoch != 7 || h.requests[0] != reqs+1 {
				t.Fatalf("epoch 7 did not start: attempt %v requests %d", e.attempt, h.requests[0])
			}
		})
	}
}

// A forged or corrupted prepare never moves the counter: the genuine prepare
// at that epoch still works afterwards.
func TestRenewInvalidHMACDoesNotSpendEpoch(t *testing.T) {
	h := newRT(t)
	rfInWindow(h)
	e := h.e[0]
	h.active[0] = false
	sig := RenewSignal{Type: "prepare", Epoch: 3}
	good := rfSigned(t, h, 3)
	// Signed over a different epoch: well-formed, wrong MAC for epoch 3.
	other, _ := RenewSignalPayload(RenewSignal{Type: "prepare", Epoch: 4}, "b", "a")
	badAuth, _ := h.e[1].sign(other)
	// Signed by a different link's key.
	foreign := newRTSeeded(t, 9, 109)
	fp, _ := RenewSignalPayload(sig, "b", "a")
	foreignAuth, _ := foreign.e[1].sign(fp)
	for _, env := range [][]byte{EncodeRenewEnvelope(sig, badAuth), EncodeRenewEnvelope(sig, foreignAuth)} {
		if !e.Signal(env) {
			t.Fatal("not consumed")
		}
		if e.epochCounter != 0 || e.peerProven || len(rfSent(h)) != 0 {
			t.Fatalf("an unauthenticated prepare acted: counter %d proven %v", e.epochCounter, e.peerProven)
		}
	}
	h.active[0] = true
	e.Signal(good)
	if e.attempt == nil || e.attempt.epoch != 3 || h.requests[0] != 1 {
		t.Fatalf("the genuine prepare was refused after forgeries: attempt %v requests %d", e.attempt, h.requests[0])
	}
}

// Same-epoch coalescing, stale drop and higher supersession are unchanged.
func TestRenewPrepareCoalesceStaleHigher(t *testing.T) {
	h := newRT(t)
	rfInWindow(h)
	e := h.e[0]
	env2 := rfSigned(t, h, 2)
	e.Signal(env2)
	a := e.attempt
	if a == nil || a.epoch != 2 || h.requests[0] != 1 || len(rfSent(h)) != 1 {
		t.Fatal("epoch 2 did not start")
	}
	e.Signal(env2) // the attempt in flight: coalesces
	if e.attempt != a || h.requests[0] != 1 || len(rfSent(h)) != 0 {
		t.Fatal("the in-flight epoch did not coalesce")
	}
	e.Signal(rfSigned(t, h, 1)) // stale
	if e.attempt != a || h.requests[0] != 1 || len(rfSent(h)) != 0 || e.epochCounter != 2 {
		t.Fatal("a stale prepare acted")
	}
	e.Signal(rfSigned(t, h, 3)) // higher: supersedes
	if e.attempt == nil || e.attempt == a || e.attempt.epoch != 3 || h.requests[0] != 2 || e.epochCounter != 3 {
		t.Fatalf("epoch 3 did not supersede: attempt %v requests %d", e.attempt, h.requests[0])
	}
}
