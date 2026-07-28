package account

import (
	"context"
	"log"
	"time"
)

// StorageProber keeps placement honest about the direction blob traffic
// actually travels.
//
// A node's "online" state comes from its heartbeat, which is node→central.
// Blob writes are central→node. Those are different paths through different
// firewalls, and when only the second one is shut the node looks perfectly
// healthy while every upload placed on it fails: the client's chunk PATCHes
// return 500 forever and the transfer sits at 0%. That is not hypothetical —
// it is what a node with its blob port un-allowlisted did in production.
//
// So central asks the question in the direction that matters, on a schedule,
// and records the answer where placement can see it.
type StorageProber struct {
	Store Store
	Now   func() time.Time
	// Probe reports whether central can reach this node's blob endpoint right
	// now. Injected so the sweep is testable without a network.
	Probe func(ctx context.Context, n Node) error
	Log   *log.Logger
}

// sweep probes every node that claims a blob endpoint and records each result.
//
// It deliberately reads ALL nodes rather than the placement set: the placement
// set now excludes unreachable nodes, so probing it would mean a node could
// never be found healthy again — the mark would be permanent and an operator
// who fixed the firewall would have no way back short of editing the database.
func (p *StorageProber) sweep(ctx context.Context) {
	nodes, err := p.Store.ListNodes(ctx)
	if err != nil {
		p.Log.Printf("storage-probe: list nodes: %v", err)
		return
	}
	at := p.Now().Unix()
	for _, n := range nodes {
		// Relay-only and uninstalled nodes have nothing to probe.
		if !n.StorageEnabled || n.StorageURL == "" || n.RemovedAt != 0 {
			continue
		}
		err := p.Probe(ctx, n)
		reachable := err == nil
		// Log only transitions. A healthy fleet would otherwise write one line
		// per node per interval forever, and the lines that matter — a node
		// leaving or rejoining the pool — would be invisible among them.
		if reachable == n.StorageUnreachable {
			if reachable {
				p.Log.Printf("storage-probe: node %s (%s) reachable again, returning to placement", n.ID, n.Label)
			} else {
				p.Log.Printf("storage-probe: node %s (%s) blob endpoint %s unreachable (%v); removing from placement",
					n.ID, n.Label, n.StorageURL, err)
			}
		}
		if serr := p.Store.SetNodeStorageReachable(ctx, n.ID, reachable, at); serr != nil {
			p.Log.Printf("storage-probe: record %s: %v", n.ID, serr)
		}
	}
}

// Run sweeps once immediately, then every interval until ctx is cancelled.
func (p *StorageProber) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	p.sweep(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.sweep(ctx)
		}
	}
}
