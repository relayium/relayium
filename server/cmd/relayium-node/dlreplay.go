package main

import "sync"

// replayGuard makes a direct-download token single-use.
//
// Why: central pre-meters the file size when it signs the 302, then the client
// fetches the ciphertext straight from this node. Without a guard the same
// signed URL can be replayed for the whole life of the token (a couple of
// minutes), so ONE metered request buys an unbounded number of unmetered fetches
// from a fleet node — whose bandwidth is an operator cost. That is not a stolen-
// token scenario: every legitimate downloader of a public share link holds a
// valid token and could do it. One token, one fetch closes it.
//
// This costs the client nothing, because no client ever reuses a token: both the
// browser and the CLI re-enter central for every attempt (including a Range
// resume) and are handed a fresh 302 each time.
//
// A spent nonce only has to be remembered until its own token expires, so
// entries are pruned by the token's expiry. Losing the whole set on restart is
// harmless: the tokens outstanding at that moment expire within minutes.
type replayGuard struct {
	mu sync.Mutex
	// used maps a spent token's identity (blob key + nonce) to that token's
	// expiry, in unix seconds.
	used map[string]int64
	// pruneAt is the size at which the next sweep runs, so pruning is amortized
	// rather than an O(n) scan on every download.
	pruneAt int
}

// minPruneAt keeps a low-traffic node from sweeping a nearly empty map.
const minPruneAt = 512

func newReplayGuard() *replayGuard {
	return &replayGuard{used: make(map[string]int64), pruneAt: minPruneAt}
}

// claim records a token as spent and reports whether THIS caller is the first to
// spend it. exp is the token's own expiry and now the current time, both in unix
// seconds. A re-presented token whose recorded expiry has already passed is
// treated as fresh — it cannot be replayed anyway, because Verify rejects it
// before we ever get here.
func (g *replayGuard) claim(id string, exp, now int64) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if prev, ok := g.used[id]; ok && now <= prev {
		return false
	}
	if len(g.used) >= g.pruneAt {
		for k, e := range g.used {
			if now > e {
				delete(g.used, k)
			}
		}
		// Grow the threshold with the live set so a node with genuinely many
		// tokens in flight doesn't sweep on every single request.
		g.pruneAt = 2 * len(g.used)
		if g.pruneAt < minPruneAt {
			g.pruneAt = minPruneAt
		}
	}
	g.used[id] = exp
	return true
}
