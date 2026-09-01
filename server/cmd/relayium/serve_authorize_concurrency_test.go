package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/trust"
)

// These tests pin the concurrency contract of serveHandler.authorize: the disk
// read and the operator prompt happen outside the map lock, while unknown peers
// stay serialized behind a single approval path.
//
// Nothing here asserts on elapsed time. Every interleaving is driven by channels
// the test controls, so a correct implementation finishes immediately and a
// regression blocks forever rather than "usually" being slow — the timeouts are
// only there to turn that block into a named failure instead of a hung suite.

// blockedTimeout bounds a call that must not block at all. It is a failure
// ceiling, not a measurement: correct code returns in microseconds.
const blockedTimeout = 15 * time.Second

// syncWriter is a bytes.Buffer safe for the concurrent stderr writes these tests
// provoke. The handler deliberately does not serialize its own output, so the
// test has to, or -race reports the buffer rather than the code under test.
type syncWriter struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (w *syncWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}

func (w *syncWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.String()
}

// fpN builds a distinct valid 64-hex fingerprint for peer n.
func fpN(n int) string { return strings.Repeat(fmt.Sprintf("%02x", n), 32) }

// mustNotBlock runs f and fails the test by name if it does not return, instead
// of letting the whole package time out with no explanation.
func mustNotBlock(t *testing.T, what string, f func() bool) bool {
	t.Helper()
	res := make(chan bool, 1)
	go func() { res <- f() }()
	select {
	case v := <-res:
		return v
	case <-time.After(blockedTimeout):
		t.Fatalf("%s never returned — it is stuck behind another connection's slow path", what)
		return false
	}
}

// recv takes one value from ch, failing by name instead of hanging the suite if
// the interleaving the test set up never happens.
func recv[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(blockedTimeout):
		t.Fatalf("timed out waiting for %s", what)
		var zero T
		return zero
	}
}

// An already-authorized peer must not queue behind another connection's
// allow-list read. This is the regression the split exists for: while the reload
// held the map lock, one slow disk delayed every peer, including peers whose
// answer was already in memory.
func TestCachedPeerIsNotBlockedByAnotherPeersReload(t *testing.T) {
	loading := make(chan struct{}, 8)
	release := make(chan struct{})
	h := &serveHandler{
		cfgDir: t.TempDir(),
		allow:  map[string]bool{fpA: true},
		stderr: &syncWriter{},
		loadAllow: func(dir string) (map[string]bool, error) {
			loading <- struct{}{}
			<-release
			return map[string]bool{}, nil
		},
	}

	unknown := make(chan bool, 1)
	go func() { unknown <- h.authorize(fpB, "198.51.100.9:5000") }()
	// The reload is now provably inside the loader and stopped there.
	recv(t, loading, "the reload to reach the loader")

	if !mustNotBlock(t, "a cached peer's authorize", func() bool {
		return h.authorize(fpA, "203.0.113.7:5000")
	}) {
		t.Fatal("a cached peer must be authorized from memory")
	}

	close(release)
	if recv(t, unknown, "the unknown peer's authorize") {
		t.Fatal("the unknown peer must still be rejected")
	}
}

// The same guarantee against the slowest blocker there is: a human who has not
// answered the prompt yet. An approved peer's push must not wait for them.
func TestCachedPeerIsNotBlockedByAnotherPeersPrompt(t *testing.T) {
	prompting := make(chan struct{}, 8)
	release := make(chan struct{})
	h := &serveHandler{
		cfgDir: t.TempDir(),
		allow:  map[string]bool{fpA: true},
		stderr: &syncWriter{},
		approve: func(remote, fp string) bool {
			prompting <- struct{}{}
			<-release
			return true
		},
	}

	approved := make(chan bool, 1)
	go func() { approved <- h.authorize(fpB, "198.51.100.9:5000") }()
	recv(t, prompting, "the prompt to be shown") // the operator has not answered

	if !mustNotBlock(t, "a cached peer's authorize", func() bool {
		return h.authorize(fpA, "203.0.113.7:5000")
	}) {
		t.Fatal("a cached peer must be authorized while another peer waits at the prompt")
	}

	close(release)
	if !recv(t, approved, "the approved peer's authorize") {
		t.Fatal("the approved peer must be authorized")
	}
}

// A peer opening several connections at once must be asked about ONCE. Without
// serialization the operator gets a prompt per connection for the same
// fingerprint, and the later ones race the first one's persist.
func TestConcurrentFirstConnectionsFromOnePeerPromptOnce(t *testing.T) {
	const conns = 8
	cfgDir := t.TempDir()
	var prompts int32
	h := &serveHandler{
		cfgDir: cfgDir,
		allow:  map[string]bool{},
		stderr: &syncWriter{},
		approve: func(remote, fp string) bool {
			atomic.AddInt32(&prompts, 1)
			return true
		},
	}

	start := make(chan struct{})
	var wg sync.WaitGroup
	results := make([]bool, conns)
	for i := range conns {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			results[i] = h.authorize(fpA, fmt.Sprintf("203.0.113.7:%d", 5000+i))
		}()
	}
	close(start)
	wg.Wait()

	if got := atomic.LoadInt32(&prompts); got != 1 {
		t.Fatalf("the operator was prompted %d times for one fingerprint, want exactly 1", got)
	}
	for i, ok := range results {
		if !ok {
			t.Fatalf("connection %d was rejected even though the peer was approved", i)
		}
	}
	if n := countInAllowFile(t, cfgDir, fpA); n != 1 {
		t.Fatalf("the fingerprint was persisted %d times, want exactly 1", n)
	}
}

// Different unknown peers arriving together must never be prompted for at the
// same time — two interleaved questions on one terminal are unanswerable, and
// whichever answer arrives could be applied to the wrong fingerprint. Every
// approval must also survive: none may be lost to another peer's concurrent one.
func TestConcurrentUnknownPeersNeverPromptSimultaneously(t *testing.T) {
	const peers = 8
	cfgDir := t.TempDir()
	// Capacity 1: a prompt that cannot claim the token found another prompt
	// already in progress. This catches an overlap at the instant it happens
	// rather than inferring it from timing.
	token := make(chan struct{}, 1)
	var overlaps int32
	h := &serveHandler{
		cfgDir: cfgDir,
		allow:  map[string]bool{},
		stderr: &syncWriter{},
		approve: func(remote, fp string) bool {
			select {
			case token <- struct{}{}:
			default:
				atomic.AddInt32(&overlaps, 1)
				return false
			}
			defer func() { <-token }()
			// Widen the window a broken implementation would overlap in, without
			// making the assertion depend on wall-clock time.
			for range 100 {
				runtime.Gosched()
			}
			return true
		},
	}

	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range peers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if !h.authorize(fpN(0x10+i), fmt.Sprintf("203.0.113.%d:5000", i+1)) {
				t.Errorf("peer %d was rejected after approval", i)
			}
		}()
	}
	close(start)
	wg.Wait()

	if got := atomic.LoadInt32(&overlaps); got != 0 {
		t.Fatalf("%d prompts overlapped another prompt", got)
	}
	// No lost update, in memory or on disk.
	for i := range peers {
		fp := fpN(0x10 + i)
		if !h.cachedAllows(fp) {
			t.Fatalf("peer %d's approval was lost from the in-memory allow-list", i)
		}
		if n := countInAllowFile(t, cfgDir, fp); n != 1 {
			t.Fatalf("peer %d appears %d times in the allow-list, want exactly 1", i, n)
		}
	}
	assertAllowFileNotWorldWritable(t, cfgDir)
}

// The adversarial ordering the serialized path could get wrong: peer B decides
// it is unknown, then blocks behind peer A's prompt while the operator, in
// another terminal, authorizes B. When B finally gets its turn its stage-2
// answer is stale, so it must look again rather than prompt for — or reject — a
// peer that is authorized by then.
func TestExternalAuthorizeDuringAnotherPeersPromptSkipsThePrompt(t *testing.T) {
	cfgDir := t.TempDir()
	loads := make(chan struct{}, 32)
	promptedFor := make(chan string, 16)
	releaseA := make(chan struct{})
	h := &serveHandler{
		cfgDir: cfgDir,
		allow:  map[string]bool{},
		stderr: &syncWriter{},
		loadAllow: func(dir string) (map[string]bool, error) {
			m, err := trust.LoadAuthorized(dir)
			loads <- struct{}{}
			return m, err
		},
		approve: func(remote, fp string) bool {
			promptedFor <- fp
			if fp == fpA {
				<-releaseA // hold the approval lock open
			}
			return true
		},
	}

	aDone := make(chan bool, 1)
	go func() { aDone <- h.authorize(fpA, "203.0.113.7:5000") }()
	if got := recv(t, promptedFor, "peer A's prompt"); got != fpA {
		t.Fatalf("first prompt was for %s, want %s", got, fpA)
	}
	// A is parked at its prompt holding the approval lock, and both of its reads
	// are already accounted for.
	recv(t, loads, "peer A's first read")
	recv(t, loads, "peer A's second read")

	bDone := make(chan bool, 1)
	go func() { bDone <- h.authorize(fpB, "198.51.100.9:5000") }()
	recv(t, loads, "peer B's read") // B has read the file and found itself absent

	// Only now does the operator authorize B, in another process, while A's
	// prompt still holds the lock B is waiting on.
	if err := trust.AddAuthorized(cfgDir, fpB); err != nil {
		t.Fatal(err)
	}
	close(releaseA)

	if !recv(t, aDone, "peer A's authorize") {
		t.Fatal("peer A was rejected after the operator approved it")
	}
	if !recv(t, bDone, "peer B's authorize") {
		t.Fatal("peer B was rejected even though `relayium authorize` named it before its turn")
	}
	close(promptedFor)
	for fp := range promptedFor {
		if fp != fpA {
			t.Fatalf("the operator was prompted for %s, which was already authorized on disk", fp)
		}
	}
}

// Fail closed on the second read too. The serialized path re-reads the file
// before prompting, so a failure there must deny exactly like a failure on the
// first read — and must never fall through to the prompt.
func TestReloadFailureInsideTheApprovalPathFailsClosed(t *testing.T) {
	cfgDir := t.TempDir()
	var reads int32
	var prompted int32
	h := &serveHandler{
		cfgDir: cfgDir,
		allow:  map[string]bool{},
		stderr: &syncWriter{},
		loadAllow: func(dir string) (map[string]bool, error) {
			if atomic.AddInt32(&reads, 1) == 1 {
				return map[string]bool{}, nil
			}
			return nil, errors.New("simulated read failure")
		},
		// An approve that says yes to anyone: a read failure must still deny, so
		// a broken file can never widen access.
		approve: func(remote, fp string) bool {
			atomic.AddInt32(&prompted, 1)
			return true
		},
	}

	if h.authorize(fpA, "203.0.113.7:5000") {
		t.Fatal("a read failure in the approval path must fail closed")
	}
	if got := atomic.LoadInt32(&prompted); got != 0 {
		t.Fatalf("the operator was prompted %d times despite an unreadable allow-list", got)
	}
	if h.cachedAllows(fpA) {
		t.Fatal("a denied peer must not be cached as authorized")
	}
	out := h.stderr.(*syncWriter).String()
	if !strings.Contains(out, trust.AuthorizedPath(cfgDir)) {
		t.Fatalf("the warning must name the file to fix, got: %q", out)
	}
}

// A file that cannot be PARSED is as unusable as one that cannot be read: we do
// not know who is authorized, so no peer that is not already cached is —
// including the peers named on the lines that did parse, above the damage. The
// handler here starts with an empty cache, so "not already cached" covers
// everyone; the non-empty case is
// TestUnreadableAllowListKeepsCachedPeersAndDeniesUnknownOnes.
func TestMalformedAllowListAuthorizesNoUncachedPeer(t *testing.T) {
	cfgDir := t.TempDir()
	// A line past the scanner's token limit: a truncated or corrupted file, not
	// a comment the parser is meant to skip.
	overlong := strings.Repeat("c", 70*1024)
	if err := os.WriteFile(trust.AuthorizedPath(cfgDir), []byte(fpA+"\n"+overlong+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Confirm the real loader genuinely rejects this file, so the test is about
	// authorize's response to a parse failure and not about a file it tolerates.
	if _, err := trust.LoadAuthorized(cfgDir); err == nil {
		t.Fatal("the allow-list loader accepted a malformed file; this test no longer provokes a parse failure")
	}

	var prompted int32
	h := &serveHandler{
		cfgDir: cfgDir,
		allow:  map[string]bool{},
		stderr: &syncWriter{},
		approve: func(remote, fp string) bool {
			atomic.AddInt32(&prompted, 1)
			return true
		},
	}
	if h.authorize(fpA, "203.0.113.7:5000") {
		t.Fatal("a fingerprint on a parseable line of a malformed file must not be authorized")
	}
	if h.authorize(fpB, "198.51.100.9:5000") {
		t.Fatal("a malformed allow-list must not authorize a peer that is not already cached")
	}
	if got := atomic.LoadInt32(&prompted); got != 0 {
		t.Fatalf("the operator was prompted %d times for an unparseable allow-list", got)
	}
	out := h.stderr.(*syncWriter).String()
	if strings.Contains(out, overlong) {
		t.Fatal("the warning echoed the allow-list contents")
	}
}

// The exact boundary of failing closed, which the zero-I/O fast path makes
// narrower than "an unreadable file rejects everyone". A peer already in the
// cache never reaches the reload, so a file that breaks underneath a running
// listener cannot revoke it; every peer that is NOT cached is denied and must
// never be prompted for, because a prompt would let a corrupted allow-list turn
// into a question an operator might answer yes to.
//
// Both halves are load-bearing. If the cached half regressed, anyone able to
// truncate or unlink authorized_fingerprints would gain a remote revocation
// switch over a running daemon. If the unknown half regressed, the same person
// would gain the opposite and worse: a way to provoke an approval prompt for a
// fingerprint the file never named.
func TestUnreadableAllowListKeepsCachedPeersAndDeniesUnknownOnes(t *testing.T) {
	cfgDir := t.TempDir()
	// A real parse failure from the real loader, not an injected error: a line
	// past the scanner's token limit, the way a truncated or corrupted file
	// actually presents. fpB is named on the line above the damage, so the file
	// "says" it is authorized while being unusable — the file is the adversary
	// here, so it must not be believed.
	overlong := strings.Repeat("c", 70*1024)
	if err := os.WriteFile(trust.AuthorizedPath(cfgDir), []byte(fpB+"\n"+overlong+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := trust.LoadAuthorized(cfgDir); err == nil {
		t.Fatal("the allow-list loader accepted a malformed file; this test no longer provokes a parse failure")
	}

	const unknown = 0x91
	var reads, prompts int32
	h := &serveHandler{
		cfgDir: cfgDir,
		// fpA was cached before the file broke — read at startup, or approved
		// earlier in this process's life. Its authorization does not depend on
		// the file being readable now.
		allow:  map[string]bool{fpA: true},
		stderr: &syncWriter{},
		loadAllow: func(dir string) (map[string]bool, error) {
			atomic.AddInt32(&reads, 1)
			return trust.LoadAuthorized(dir)
		},
		// An approve that says yes to anyone, so anything that reaches the
		// prompt is visibly a widening of access.
		approve: func(remote, fp string) bool {
			atomic.AddInt32(&prompts, 1)
			return true
		},
	}

	if !h.authorize(fpA, "203.0.113.7:5000") {
		t.Fatal("a peer cached before the allow-list broke must keep pushing")
	}
	// Not merely "it was allowed": it was allowed without touching the file at
	// all. That is why no disk failure can reach it.
	if got := atomic.LoadInt32(&reads); got != 0 {
		t.Fatalf("the cached peer's authorize read the allow-list %d times, want 0", got)
	}

	// A peer the file never named: denied, and never put in front of the operator.
	if h.authorize(fpN(unknown), "198.51.100.9:5000") {
		t.Fatal("an unknown peer must be denied while the allow-list is unreadable")
	}
	// A peer the broken file DOES name, on a line that parsed: still denied,
	// because a file we cannot parse is not evidence of anything.
	if h.authorize(fpB, "198.51.100.10:5000") {
		t.Fatal("a peer named on a parseable line of a malformed file must not be authorized")
	}
	if got := atomic.LoadInt32(&prompts); got != 0 {
		t.Fatalf("the operator was prompted %d times despite an unreadable allow-list, want 0", got)
	}
	for _, fp := range []string{fpN(unknown), fpB} {
		if h.cachedAllows(fp) {
			t.Fatalf("denied peer %s was cached as authorized", fp)
		}
	}
	// The denials must not have disturbed the cached peer either.
	if !h.authorize(fpA, "203.0.113.7:5000") {
		t.Fatal("the cached peer stopped being authorized after two failed reloads")
	}

	out := h.stderr.(*syncWriter).String()
	if !strings.Contains(out, trust.AuthorizedPath(cfgDir)) {
		t.Fatalf("the warning must name the file to fix, got: %q", out)
	}
	if strings.Contains(out, overlong) {
		t.Fatal("the warning echoed the allow-list contents")
	}
	// The message must not restate the contract this test just disproved: an
	// operator told every peer is rejected would go hunting for an outage that
	// is not happening, and would not learn that the peers they can still see
	// pushing are running on cache that only lasts as long as this process.
	if strings.Contains(out, "every peer is rejected") {
		t.Fatalf("the warning claims a total lockout that does not happen, got: %q", out)
	}
}

// Reading the file outside the lock means the snapshot can be stale by the time
// it is merged. Merging must therefore only ever ADD: an approval that landed
// while the read was in flight must survive it. Assigning the snapshot instead
// would silently revoke a peer that was just approved.
//
// The check has to happen inside the window: the stale merge is followed by a
// fresh read that would repair the damage, so asserting afterwards would pass
// against an implementation that erases and re-reads. Both of the stale
// connection's reads are gated so the cache can be inspected between them.
func TestStaleReloadCannotEraseAConcurrentApproval(t *testing.T) {
	cfgDir := t.TempDir()
	snapshotTaken := make(chan struct{})
	approvalDone := make(chan struct{})
	staleMerged := make(chan struct{})
	checkDone := make(chan struct{})
	var reads int32
	h := &serveHandler{
		cfgDir: cfgDir,
		allow:  map[string]bool{},
		stderr: &syncWriter{},
		loadAllow: func(dir string) (map[string]bool, error) {
			m, err := trust.LoadAuthorized(dir)
			switch atomic.AddInt32(&reads, 1) {
			case 1:
				// Peer B's first read. This snapshot predates fpA's approval;
				// hold it here until that approval has landed, so the merge it
				// feeds is provably stale.
				close(snapshotTaken)
				<-approvalDone
			case 4:
				// Peer B's second read, which happens after the stale merge and
				// would restore anything the merge dropped. Pause before it so
				// the test can look at the cache in between.
				close(staleMerged)
				<-checkDone
			}
			return m, err
		},
		approve: func(remote, fp string) bool { return fp == fpA },
	}

	staleDone := make(chan bool, 1)
	go func() { staleDone <- h.authorize(fpB, "198.51.100.9:5000") }()
	recv(t, snapshotTaken, "the stale snapshot to be taken")

	// Peer A is approved end to end while peer B's read is parked (reads 2 and 3).
	if !mustNotBlock(t, "peer A's authorize", func() bool {
		return h.authorize(fpA, "203.0.113.7:5000")
	}) {
		t.Fatal("peer A must be approved")
	}
	close(approvalDone)

	// Peer B has now merged its stale, empty snapshot and has not re-read yet.
	recv(t, staleMerged, "the stale snapshot to be merged")
	if !h.cachedAllows(fpA) {
		t.Fatal("a stale reload erased an approval granted while it was in flight")
	}
	close(checkDone)

	if recv(t, staleDone, "the stale reload's authorize") {
		t.Fatal("peer B must be rejected")
	}
	if !h.cachedAllows(fpA) {
		t.Fatal("peer A's approval did not survive peer B's connection")
	}
	if n := countInAllowFile(t, cfgDir, fpA); n != 1 {
		t.Fatalf("fpA appears %d times in the allow-list, want exactly 1", n)
	}
}

// Everything at once, for the race detector: cached hits, unknown peers, and a
// second process writing the allow-list, all against one handler.
//
// Memory is only half of it. The allow-list is the durable answer — it is what
// the next restart reads — so this also pins what survives ON DISK while two
// writers append concurrently: the handler persisting its own approvals, and
// `relayium authorize` adding peers underneath it. A lost or duplicated line
// here is a peer that silently stops being authorized after a restart, or an
// allow-list that grows without bound.
func TestAuthorizeUnderConcurrentExternalWrites(t *testing.T) {
	cfgDir := t.TempDir()
	const cached = 0x40
	h := &serveHandler{
		cfgDir:  cfgDir,
		allow:   map[string]bool{fpN(cached): true},
		stderr:  &syncWriter{},
		approve: func(remote, fp string) bool { return true },
	}

	var wg sync.WaitGroup
	for i := range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// A peer already in memory, one this goroutine will get approved, and
			// one an external `relayium authorize` is adding underneath us.
			if !h.authorize(fpN(cached), "203.0.113.1:5000") {
				t.Errorf("goroutine %d: the cached peer was rejected", i)
			}
			if !h.authorize(fpN(0x50+i), fmt.Sprintf("203.0.113.2:%d", 5000+i)) {
				t.Errorf("goroutine %d: an approved peer was rejected", i)
			}
			if err := trust.AddAuthorized(cfgDir, fpN(0x70+i)); err != nil {
				t.Errorf("goroutine %d: external authorize: %v", i, err)
			}
			if !h.authorize(fpN(0x70+i), fmt.Sprintf("203.0.113.3:%d", 5000+i)) {
				t.Errorf("goroutine %d: an externally authorized peer was rejected", i)
			}
		}()
	}
	wg.Wait()

	if !h.cachedAllows(fpN(cached)) {
		t.Fatal("the startup fingerprint was erased by a concurrent reload")
	}
	for i := range 16 {
		if !h.cachedAllows(fpN(0x50 + i)) {
			t.Fatalf("approval for peer %d was lost", i)
		}
	}
	// On disk, where it has to survive a restart. Exactly once each, for both
	// writers: the handler's own persisted approvals interleaved with 16
	// external appends, and every one of those external appends still present
	// and intact after the handler wrote between them.
	for i := range 16 {
		if n := countInAllowFile(t, cfgDir, fpN(0x50+i)); n != 1 {
			t.Fatalf("approved peer %d appears %d times in the allow-list, want exactly 1", i, n)
		}
		if n := countInAllowFile(t, cfgDir, fpN(0x70+i)); n != 1 {
			t.Fatalf("externally authorized peer %d appears %d times in the allow-list, want exactly 1", i, n)
		}
	}
	// Nothing but those 32 fingerprints, so a torn or interleaved append shows
	// up as garbage here rather than passing because each name happens to occur
	// somewhere in the file.
	if got := countAllowFileLines(t, cfgDir); got != 32 {
		t.Fatalf("the allow-list holds %d entries, want the 16 approved plus 16 externally authorized", got)
	}
	assertAllowFileNotWorldWritable(t, cfgDir)
}

// countInAllowFile reports how many lines of the allow-list name fp.
func countInAllowFile(t *testing.T, cfgDir, fp string) int {
	t.Helper()
	body, err := os.ReadFile(trust.AuthorizedPath(cfgDir))
	if err != nil {
		t.Fatalf("reading the allow-list: %v", err)
	}
	n := 0
	for _, line := range strings.Split(string(body), "\n") {
		if strings.TrimSpace(line) == fp {
			n++
		}
	}
	return n
}

// countAllowFileLines reports how many non-empty lines the allow-list holds, so
// a test can assert the file contains nothing beyond what it expects.
func countAllowFileLines(t *testing.T, cfgDir string) int {
	t.Helper()
	body, err := os.ReadFile(trust.AuthorizedPath(cfgDir))
	if err != nil {
		t.Fatalf("reading the allow-list: %v", err)
	}
	n := 0
	for _, line := range strings.Split(string(body), "\n") {
		if strings.TrimSpace(line) != "" {
			n++
		}
	}
	return n
}

// assertAllowFileNotWorldWritable guards the persistence this change must not
// weaken: the allow-list decides who may write to this host.
func assertAllowFileNotWorldWritable(t *testing.T, cfgDir string) {
	t.Helper()
	fi, err := os.Stat(trust.AuthorizedPath(cfgDir))
	if err != nil {
		t.Fatalf("stat allow-list: %v", err)
	}
	if mode := fi.Mode().Perm(); mode&0o022 != 0 {
		t.Fatalf("allow-list mode is %#o — it must not be group- or world-writable", mode)
	}
}
