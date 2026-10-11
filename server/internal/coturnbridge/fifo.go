package coturnbridge

// fifoSet is a bounded set of keys with insertion times, evicting in
// insertion order. Each Add gives the key a new insertion generation and
// queues it at the back (a refresh moves the key to the back); queue entries
// of earlier generations are stale and are dropped by compaction, so the
// queue stays O(len(m)) whatever the times are — repeated keys, identical
// times and clocks that go backwards included. When the set would exceed max
// the entries inserted earliest are evicted (and counted). max <= 0 means
// unbounded (direct library/test use only; the bridge always bounds).
type fifoSet[K comparable] struct {
	m       map[K]fifoVal
	q       []fifoEnt[K]
	max     int
	gen     uint64
	evicted int64
}

type fifoVal struct {
	at  int64
	gen uint64
}

type fifoEnt[K comparable] struct {
	k   K
	gen uint64
}

func newFifoSet[K comparable](max int) *fifoSet[K] {
	return &fifoSet[K]{m: map[K]fifoVal{}, max: max}
}

func (s *fifoSet[K]) Len() int { return len(s.m) }

func (s *fifoSet[K]) Has(k K) bool { _, ok := s.m[k]; return ok }

// current reports whether queue entry e is k's latest insertion.
func (s *fifoSet[K]) current(e fifoEnt[K]) bool {
	v, ok := s.m[e.k]
	return ok && v.gen == e.gen
}

// Add records k at time at (a refresh if k is present) and returns how many
// entries were evicted.
func (s *fifoSet[K]) Add(k K, at int64) int {
	s.gen++
	s.m[k] = fifoVal{at: at, gen: s.gen}
	s.q = append(s.q, fifoEnt[K]{k, s.gen})
	n := 0
	for s.max > 0 && len(s.m) > s.max && len(s.q) > 0 {
		e := s.q[0]
		s.q = s.q[1:]
		if s.current(e) {
			delete(s.m, e.k)
			n++
		}
	}
	s.evicted += int64(n)
	s.compact()
	return n
}

// Delete removes k (its queue entries become stale).
func (s *fifoSet[K]) Delete(k K) { delete(s.m, k); s.compact() }

// Expire removes every entry older than ttl at now. The queue is in
// insertion order, not time order (clocks can go back), so the map is swept.
func (s *fifoSet[K]) Expire(now, ttl int64) {
	for k, v := range s.m {
		if now-v.at > ttl {
			delete(s.m, k)
		}
	}
	s.compact()
}

// compact drops stale queue entries once they outnumber the live ones (plus
// slack), so the queue never exceeds 2·len(m)+64 entries after any call.
func (s *fifoSet[K]) compact() {
	if len(s.q) <= 2*len(s.m)+64 {
		return
	}
	q := make([]fifoEnt[K], 0, len(s.m))
	for _, e := range s.q {
		if s.current(e) {
			q = append(q, e)
		}
	}
	s.q = q
}

// Keys returns the keys (any order).
func (s *fifoSet[K]) Keys() []K {
	out := make([]K, 0, len(s.m))
	for k := range s.m {
		out = append(out, k)
	}
	return out
}
