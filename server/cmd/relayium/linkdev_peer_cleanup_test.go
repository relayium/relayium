package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

// In-process link-dev ends are cancellable and owned by the test that starts
// them (N-1001-6): cancelling the context handed to ldStartLive ends the run
// and releases its room membership on the real hub, an already-cancelled
// context never joins, and a test that ends -- normally or through the
// FailNow/SkipNow unwinding -- cancels and joins its ends before the fixture
// goes away, without taking their results.

// ldLoneEnd is a pairing end whose second end never arrives.
func ldLoneEnd(t *testing.T, hub *ldHub) ldPeer {
	return ldPeer{cmd: "pair", via: hub.url, args: []string{"--yes", "--dest", t.TempDir(),
		"--script", ldScript(t, "text ping", "wait-texts 1"), ldCode}}
}

// ldWaitJoined waits for the hub to admit one end. A lone end then waits
// inside rzvous.JoinRoom, reading for the roster that would name its peer.
func ldWaitJoined(t *testing.T, hub *ldHub) {
	t.Helper()
	select {
	case <-hub.joins:
	case <-time.After(30 * time.Second):
		t.Fatal("the end never joined the hub")
	}
	if n := hub.sig.PeerCount("testroom"); n != 1 {
		t.Fatalf("hub counts %d members after the join, want 1", n)
	}
}

// ldWantCancelledLone checks the result of a lone end that was cancelled
// while waiting for its peer: it failed (exit 1, with the read error the
// cancellation caused -- its wording depends on where the read was) and
// never got as far as a room, because no peer ever arrived.
func ldWantCancelledLone(t *testing.T, r ldResult) {
	t.Helper()
	if r.code != 1 || strings.TrimSpace(r.stderr) == "" || strings.Contains(r.stderr, "link-dev: room ") {
		t.Fatalf("cancelled lone end:\n%s", r)
	}
}

// ldWantReleased waits (bounded) until the hub counts no member in the room
// and every /ws handler it entered has returned: the end's connection is
// gone on the server side, not merely its Run.
func ldWantReleased(t *testing.T, hub *ldHub) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		n, opened, done := hub.sig.PeerCount("testroom"), hub.wsOpened.Load(), hub.wsDone.Load()
		if n == 0 && opened == done {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("hub still holds the end: members=%d /ws handlers entered=%d returned=%d\n%s",
				n, opened, done, hub.diagnostics())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A lone end waiting for its peer returns once its context is cancelled and
// leaves the room on the real hub.
func TestLinkDevLoneEndCancelReleasesRoom(t *testing.T) {
	hub := startLinkDevHub(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, _ := ldStartLive(ctx, t, "", ldLoneEnd(t, hub))
	ldWaitJoined(t, hub)
	cancel()
	select {
	case r := <-a:
		ldWantCancelledLone(t, r)
	case <-time.After(15 * time.Second):
		t.Fatal("a lone end did not return within 15s of its context being cancelled")
	}
	ldWantReleased(t, hub)
	if opened := hub.wsOpened.Load(); opened != 1 {
		t.Fatalf("/ws handlers entered=%d, want 1", opened)
	}
}

// An end whose context is already cancelled never dials the hub.
func TestLinkDevCancelledBeforeStartNeverJoins(t *testing.T) {
	hub := startLinkDevHub(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	a, _ := ldStartLive(ctx, t, "", ldLoneEnd(t, hub))
	select {
	case r := <-a:
		if r.code != 1 || !strings.Contains(r.stderr, context.Canceled.Error()) || strings.Contains(r.stderr, "link-dev: room") {
			t.Fatalf("pre-cancelled end:\n%s", r)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a pre-cancelled end did not return within 5s")
	}
	if opened := hub.wsOpened.Load(); opened != 0 {
		t.Fatalf("a pre-cancelled end reached the hub: /ws handlers entered=%d", opened)
	}
	select {
	case id := <-hub.joins:
		t.Fatalf("a pre-cancelled end joined as %s", id)
	default:
	}
	if n := hub.sig.PeerCount("testroom"); n != 0 {
		t.Fatalf("hub counts %d members, want 0", n)
	}
}

// A test that ends with its only end still waiting for a peer -- by
// returning, or by the runtime.Goexit unwinding that t.Fatal and t.SkipNow
// share (the first-peer-only failure of ldPairUp) -- cancels and joins that
// end in its cleanup. The end's own result is still in its channel
// afterwards (the cleanup did not take it), and the hub has released it.
func TestLinkDevEndJoinedWhenTestEnds(t *testing.T) {
	for _, exit := range []string{"return", "goexit"} {
		t.Run(exit, func(t *testing.T) {
			hub := startLinkDevHub(t)
			var a <-chan ldResult
			t.Run("test", func(t *testing.T) {
				a, _ = ldStartLive(context.Background(), t, "", ldLoneEnd(t, hub))
				ldWaitJoined(t, hub)
				if exit == "goexit" {
					t.SkipNow() // the same unwinding as t.FailNow, without failing the parent
				}
			})
			if a == nil {
				t.Fatal("the end was not started")
			}
			select {
			case r := <-a:
				ldWantCancelledLone(t, r)
			default:
				t.Fatal("after the test ended, its end had not delivered a result: it was not joined, or its result was taken")
			}
			ldWantReleased(t, hub)
		})
	}
}
