package storage

import (
	"container/list"
	"context"
	"errors"
	"fmt"
	"sync"
)

// ErrNotDurable marks an append answer whose bytes past NotDurableError.Durable
// are NOT known to be on stable storage. errors.Is(err, ErrNotDurable) is how a
// caller tells it from every other failure; errors.As with *NotDurableError
// gives the numbers.
var ErrNotDurable = errors.New("storage: appended bytes are not known to be durable")

// errUncertifiedTail is the cause recorded when the blob already holds bytes
// past the caller's offset that this process never flushed: written by a
// process that has since restarted, by an append whose flush failed, or by one
// whose certification this process has forgotten (knownDurable eviction).
var errUncertifiedTail = errors.New("storage: blob holds bytes past the offset that are not known to be durable")

// NotDurableError is Append's answer when it cannot vouch for every byte the
// blob physically holds. All three numbers are ABSOLUTE offsets or counts, and
// they answer different questions, which is the whole point of the type:
//
//   - Durable is the resume truth: the size through which the blob is known to
//     be on stable storage (the caller's offset, or a higher size this process
//     itself flushed). A resumable upload may continue from here and nowhere
//     further.
//   - Physical is the blob's size as the file system reports it. Everything in
//     [Durable, Physical) is ACCEPTED-BUT-NOT-DURABLE: bytes that crossed the
//     network and were written, and therefore are billed, but that no flush
//     has certified. They are left in place as the evidence of that bill until
//     the server's ledger has settled them (see WithSettledThrough); they are
//     never reported as a resumable size.
//   - Written is how many bytes THIS call consumed from its reader and wrote.
//     It does not describe transport-side reader ownership: even a zero
//     count must never authorize reuse of the same HTTP request body.
//
// Err joins every cause — a flush failure AND the body's read error, when both
// happened — so neither masks the other.
type NotDurableError struct {
	Durable  int64
	Physical int64
	Written  int64
	Err      error
}

func (e *NotDurableError) Error() string {
	return fmt.Sprintf("storage: not durable past %d (physical %d, wrote %d): %v",
		e.Durable, e.Physical, e.Written, e.Err)
}

func (e *NotDurableError) Unwrap() []error { return []error{ErrNotDurable, e.Err} }

// settledThroughKey carries the server-owned settled floor into Append.
type settledThroughKey struct{}

// WithSettledThrough authorizes ONE kind of repair on the append it is passed
// to: when the blob holds an accepted-but-not-durable tail past the append's
// offset, and that whole tail lies at or below `settled`, Append may verify
// matching overlap and rewrite it from a fresh request. It never truncates
// retained bytes and certifies only the prefix rewritten and flushed now.
//
// `settled` must be the SERVER's own number — the offset through which the
// session's ledger has durably billed accepted bytes (its `metered` high-water,
// read back from the transaction that wrote it), or an explicit "nothing to
// bill" for an own-node upload — never anything a client said. Below the floor
// the tail is still the only evidence of a bill, and Append leaves it alone.
//
// Probes must not carry it: a zero-byte probe never repairs, and a size-asking
// path has no business destroying what it is asking about.
func WithSettledThrough(ctx context.Context, settled int64) context.Context {
	return context.WithValue(ctx, settledThroughKey{}, settled)
}

// SettledThrough returns the floor WithSettledThrough attached, if any.
func SettledThrough(ctx context.Context) (int64, bool) {
	v, ok := ctx.Value(settledThroughKey{}).(int64)
	return v, ok
}

// knownDurableLimit bounds knownDurable. One entry per blob an append flushed
// recently; an evicted entry only costs a client a replay (its tail becomes
// "not known durable"), never a wrong answer.
const knownDurableLimit = 4096

// knownDurable remembers, per key, the size THIS process last flushed
// successfully — the one way a physical size past a caller's offset can be
// certified (a sibling append whose answer or commit was lost). It is an
// optimization and nothing else: empty after a restart, and an absent entry
// makes the tail untrusted rather than trusted. Entries are written only after
// every flush an append needed succeeded, under the key's lock; LRU-bounded.
type knownDurable struct {
	mu    sync.Mutex
	limit int
	order *list.List // front = most recent; values are *durableEntry
	byKey map[string]*list.Element
}

type durableEntry struct {
	key  string
	size int64
}

func newKnownDurable(limit int) *knownDurable {
	return &knownDurable{limit: limit, order: list.New(), byKey: make(map[string]*list.Element)}
}

func (k *knownDurable) get(key string) (int64, bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	el, ok := k.byKey[key]
	if !ok {
		return 0, false
	}
	k.order.MoveToFront(el)
	return el.Value.(*durableEntry).size, true
}

func (k *knownDurable) set(key string, size int64) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if el, ok := k.byKey[key]; ok {
		el.Value.(*durableEntry).size = size
		k.order.MoveToFront(el)
		return
	}
	k.byKey[key] = k.order.PushFront(&durableEntry{key: key, size: size})
	for k.order.Len() > k.limit {
		last := k.order.Back()
		k.order.Remove(last)
		delete(k.byKey, last.Value.(*durableEntry).key)
	}
}

func (k *knownDurable) forget(key string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if el, ok := k.byKey[key]; ok {
		k.order.Remove(el)
		delete(k.byKey, key)
	}
}

func (k *knownDurable) len() int {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.order.Len()
}
