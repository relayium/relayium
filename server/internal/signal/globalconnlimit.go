package signal

import "sync"

// maxGlobalConns bounds the total number of concurrent /ws connections across
// ALL client IPs. IPConnLimiter (ipconnlimit.go) only stops a single IP from
// exhausting the server; an attacker who rotates source addresses gets a
// fresh budget of maxConnsPerIP from every new IP, and nothing bounded the
// sum. This is that backstop.
//
// Derivation, not a round number:
//   - maxRooms (hub.go) caps the room table at 5000, and a normal rendezvous
//     holds 2 peers, so legitimate steady-state load is on the order of 10k
//     connections (an un-joined connection holds no room but still counts
//     here, so this is a floor, not an exact figure).
//   - Per-connection cost: coder/websocket gives each side a bufio reader and
//     writer (4 KiB default each = 8 KiB), ServeWS (client.go) runs the read
//     loop plus one ping-ticker goroutine per connection (a couple KiB of
//     stack apiece, more only if actually reading/writing), and the small
//     connLimiter/peer bookkeeping structs are well under 1 KiB. Call it
//     ~16-32 KiB of Go-heap per connection before counting kernel-side socket
//     buffers.
//   - 50000 is 5x steady-state — comfortably above any plausible legitimate
//     peak (so it isn't a self-inflicted outage) while translating to roughly
//     1-2 GiB of heap, which a modest single instance can spare. It sits far
//     below the multi-hundred-thousand-socket range where a box actually
//     falls over, so it still bounds the attack this exists to stop. Tunable.
const maxGlobalConns = 50000

// GlobalConnLimiter is a single shared counter of concurrent /ws connections,
// independent of client IP. Unlike IPConnLimiter it needs no per-key map —
// there is exactly one budget for the whole process. A successful Acquire
// must be balanced by exactly one Release.
type GlobalConnLimiter struct {
	mu sync.Mutex
	n  int
}

func NewGlobalConnLimiter() *GlobalConnLimiter {
	return &GlobalConnLimiter{}
}

// Acquire reserves a connection slot, returning false when the server is
// already at maxGlobalConns. A rejected Acquire leaves the counter untouched.
func (l *GlobalConnLimiter) Acquire() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.n >= maxGlobalConns {
		return false
	}
	l.n++
	return true
}

// Release frees a slot. Guarded against underflow the same way
// IPConnLimiter.Release is, so a stray extra Release cannot drive the counter
// negative and wrongly free capacity that was never reserved.
func (l *GlobalConnLimiter) Release() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.n > 0 {
		l.n--
	}
}
