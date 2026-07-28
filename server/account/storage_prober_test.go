package account

import (
	"context"
	"errors"
	"io"
	"log"
	"testing"
	"time"
)

func proberFor(st Store, probe func(context.Context, Node) error, now int64) *StorageProber {
	return &StorageProber{
		Store: st,
		Now:   func() time.Time { return time.Unix(now, 0) },
		Probe: probe,
		Log:   log.New(io.Discard, "", 0),
	}
}

// The whole point of the prober: a node that heartbeats fine but cannot be
// reached on its blob port stops being handed uploads.
func TestProberTakesAnUnreachableNodeOutOfPlacement(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	const now = 10000

	st.UpsertNode(ctx, reachableTestNode("alive", "1.1.1.1", now))
	st.UpsertNode(ctx, reachableTestNode("dead", "2.2.2.2", now))

	proberFor(st, func(_ context.Context, n Node) error {
		if n.ID == "dead" {
			return errors.New("dial tcp: i/o timeout")
		}
		return nil
	}, now).sweep(ctx)

	nodes, err := st.StorageNodes(ctx, now-1, 0)
	if err != nil {
		t.Fatalf("StorageNodes: %v", err)
	}
	if len(nodes) != 1 || nodes[0].ID != "alive" {
		t.Fatalf("only the reachable node should be placeable, got %+v", nodes)
	}
}

// And comes back on its own once the port is open again — an operator who fixes
// the firewall should not also have to know to poke central.
func TestProberRestoresANodeThatComesBack(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	const now = 10000

	st.UpsertNode(ctx, reachableTestNode("flaky", "3.3.3.3", now))

	proberFor(st, func(context.Context, Node) error { return errors.New("refused") }, now).sweep(ctx)
	if nodes, _ := st.StorageNodes(ctx, now-1, 0); len(nodes) != 0 {
		t.Fatalf("expected the node out of the pool, got %+v", nodes)
	}

	proberFor(st, func(context.Context, Node) error { return nil }, now+300).sweep(ctx)
	nodes, err := st.StorageNodes(ctx, now-1, 0)
	if err != nil {
		t.Fatalf("StorageNodes: %v", err)
	}
	if len(nodes) != 1 {
		t.Fatalf("a node that answers again must return to the pool, got %+v", nodes)
	}
	if nodes[0].StorageProbedAt != now+300 {
		t.Fatalf("probe time not recorded: got %d", nodes[0].StorageProbedAt)
	}
}

// A relay-only node has no blob endpoint to probe; probing it would mark every
// relay node unreachable and is meaningless besides.
func TestProberIgnoresRelayOnlyNodes(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	const now = 10000

	relayOnly := reachableTestNode("relay", "7.7.7.7", now)
	relayOnly.StorageEnabled = false
	relayOnly.StorageURL = ""
	st.UpsertNode(ctx, relayOnly)

	probed := 0
	proberFor(st, func(context.Context, Node) error { probed++; return nil }, now).sweep(ctx)
	if probed != 0 {
		t.Fatalf("relay-only node must not be probed, probed %d", probed)
	}
}
