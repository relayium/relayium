package xfer

import (
	"context"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

// The watch loop is driven entirely through injected seams: a fake watcher, a
// fake one-shot timer and a fake clock. No test below sleeps for a duration and
// hopes; each one hands the loop exactly one input at a time and observes the
// single timer it owns.

// ---------------------------------------------------------------- fake clock

type fakeSched struct {
	mu    sync.Mutex
	now   time.Time
	armed chan *fakeTimer
}

func newFakeSched() *fakeSched {
	return &fakeSched{now: time.Unix(1_700_000_000, 0), armed: make(chan *fakeTimer, 64)}
}

func (s *fakeSched) Now() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.now
}

func (s *fakeSched) newTimer(d time.Duration) (<-chan time.Time, func() bool) {
	t := &fakeTimer{s: s, d: d, c: make(chan time.Time, 1)}
	s.armed <- t
	return t.c, t.Stop
}

// next returns the next timer the loop armed, in order.
func (s *fakeSched) next(tb testing.TB) *fakeTimer {
	tb.Helper()
	select {
	case ft := <-s.armed:
		return ft
	case <-time.After(5 * time.Second):
		tb.Fatal("watch loop never armed a timer")
		return nil
	}
}

// nextDelay asserts the delay of the next armed timer and returns it.
func (s *fakeSched) nextDelay(tb testing.TB, want time.Duration) *fakeTimer {
	tb.Helper()
	ft := s.next(tb)
	if ft.d != want {
		tb.Fatalf("next attempt scheduled in %s, want %s", ft.d, want)
	}
	return ft
}

type fakeTimer struct {
	s *fakeSched
	d time.Duration
	c chan time.Time

	mu      sync.Mutex
	stopped bool
	fired   bool
}

func (t *fakeTimer) Stop() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.stopped || t.fired {
		return false
	}
	t.stopped = true
	return true
}

func (t *fakeTimer) isStopped() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.stopped
}

// fire advances the fake clock by this timer's delay and delivers it.
func (t *fakeTimer) fire(tb testing.TB) {
	tb.Helper()
	t.mu.Lock()
	if t.stopped {
		t.mu.Unlock()
		tb.Fatalf("test fired a timer the loop had already stopped")
	}
	t.fired = true
	t.mu.Unlock()

	t.s.mu.Lock()
	t.s.now = t.s.now.Add(t.d)
	t.s.mu.Unlock()

	t.c <- time.Time{}
}

// -------------------------------------------------------------- fake watcher

type fakeWatcher struct {
	events chan fsnotify.Event
	errs   chan error

	mu     sync.Mutex
	added  []string
	addErr map[string]error
	closed bool
}

func newFakeWatcher(buf int) *fakeWatcher {
	return &fakeWatcher{
		events: make(chan fsnotify.Event, buf),
		errs:   make(chan error, buf),
		addErr: map[string]error{},
	}
}

func (f *fakeWatcher) Add(p string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.addErr[p]; err != nil {
		return err
	}
	f.added = append(f.added, p)
	return nil
}

func (f *fakeWatcher) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
	return nil
}

func (f *fakeWatcher) Events() <-chan fsnotify.Event { return f.events }
func (f *fakeWatcher) Errors() <-chan error          { return f.errs }

func (f *fakeWatcher) paths() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.added...)
}

func (f *fakeWatcher) countAdds(p string) int {
	n := 0
	for _, got := range f.paths() {
		if got == p {
			n++
		}
	}
	return n
}

func (f *fakeWatcher) watches(p string) bool { return f.countAdds(p) > 0 }

func (f *fakeWatcher) isClosed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}

func (f *fakeWatcher) failAdd(p string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.addErr[p] = err
}

// clearAddErr lets a test prove the loop retries an add rather than merely
// reporting it once.
func (f *fakeWatcher) clearAddErr(p string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.addErr, p)
}

// ------------------------------------------------------------------ harness

type watchHarness struct {
	sched   *fakeSched
	w       *fakeWatcher
	notices chan error
	done    chan error

	cancel  context.CancelFunc
	started chan struct{}
	result  chan error
	calls   atomic.Int32
	active  atomic.Int32
	overlap atomic.Int32
}

// start launches WatchAndSync against the fakes. Every sync attempt blocks
// until the test answers it, which is what makes ordering deterministic.
func startWatch(t *testing.T, roots []string, buf int, tune func(*WatchOpts)) *watchHarness {
	t.Helper()
	h := &watchHarness{
		sched:   newFakeSched(),
		w:       newFakeWatcher(buf),
		notices: make(chan error, 64),
		done:    make(chan error, 1),
		started: make(chan struct{}),
		result:  make(chan error),
	}
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	t.Cleanup(cancel)

	opts := WatchOpts{
		Debounce:   800 * time.Millisecond,
		MinBackoff: time.Second,
		MaxBackoff: 4 * time.Second,
		OnNotice: func(err error) {
			select {
			case h.notices <- err:
			default:
			}
		},
		newWatcher: func() (fsWatcher, error) { return h.w, nil },
		newTimer:   h.sched.newTimer,
		now:        h.sched.Now,
	}
	if tune != nil {
		tune(&opts)
	}

	syncFn := func() error {
		if h.active.Add(1) != 1 {
			h.overlap.Add(1)
		}
		defer h.active.Add(-1)
		h.calls.Add(1)
		h.started <- struct{}{}
		return <-h.result
	}
	go func() { h.done <- WatchAndSync(ctx, roots, syncFn, opts) }()
	return h
}

// serve answers the next sync attempt with err, and returns once the callback
// has been handed its result.
func (h *watchHarness) serve(tb testing.TB, err error) {
	tb.Helper()
	select {
	case <-h.started:
	case <-time.After(5 * time.Second):
		tb.Fatal("no sync attempt started")
	}
	select {
	case h.result <- err:
	case <-time.After(5 * time.Second):
		tb.Fatal("sync callback never took its result")
	}
}

// barrierEvent is a name no test cares about. A zero Op is observed as nothing
// at all, so delivering it cannot change the watch set.
const barrierEvent = "<barrier>"

// send delivers ev and returns only once the loop has finished acting on it.
//
// The event channel is unbuffered, so a bare send completes as soon as the loop
// *receives* — which is before observe has run, and asserting on the watch set
// straight afterwards is a race. A second send on the same channel cannot be
// received until the first event has been fully observed, so the barrier send is
// the synchronisation, not a sleep. It shares the first event's debounce
// deadline, so it cannot arm a timer of its own either.
func (h *watchHarness) send(tb testing.TB, ev fsnotify.Event) {
	tb.Helper()
	h.deliver(tb, ev)
	h.deliver(tb, fsnotify.Event{Name: barrierEvent})
}

func (h *watchHarness) deliver(tb testing.TB, ev fsnotify.Event) {
	tb.Helper()
	select {
	case h.w.events <- ev:
	case <-time.After(5 * time.Second):
		tb.Fatalf("the watch loop never took the event for %q", ev.Name)
	}
}

// notReturned asserts WatchAndSync has not returned. It is exact rather than
// timing-based: the loop calls sync inline, so while an attempt is waiting on
// h.result the loop provably cannot have reached its return.
func (h *watchHarness) notReturned(tb testing.TB) {
	tb.Helper()
	select {
	case err := <-h.done:
		tb.Fatalf("WatchAndSync returned (%v) while a sync attempt was still in flight", err)
	default:
	}
}

// noSyncAttempt asserts that no attempt is in flight right now.
func (h *watchHarness) noSyncAttempt(tb testing.TB) {
	tb.Helper()
	select {
	case <-h.started:
		tb.Fatal("a sync attempt ran when none was expected")
	default:
	}
}

func (h *watchHarness) wait(tb testing.TB) error {
	tb.Helper()
	select {
	case err := <-h.done:
		return err
	case <-time.After(5 * time.Second):
		tb.Fatal("WatchAndSync did not return")
		return nil
	}
}

func (h *watchHarness) notice(tb testing.TB) error {
	tb.Helper()
	select {
	case err := <-h.notices:
		return err
	case <-time.After(5 * time.Second):
		tb.Fatal("expected a notice, got none")
		return nil
	}
}

// setupFail runs the harness up to the point where the first attempt has failed
// and a MinBackoff retry is pending, and returns that pending timer.
func (h *watchHarness) setupFail(t *testing.T, err error) *fakeTimer {
	t.Helper()
	h.sched.nextDelay(t, 0).fire(t)
	h.serve(t, err)
	h.notice(t)
	return h.sched.nextDelay(t, time.Second)
}

// ------------------------------------------------------------------- tests

// The first sync runs on its own, without waiting for a filesystem event.
func TestWatchSyncsOnceAtStartup(t *testing.T) {
	dir := t.TempDir()
	h := startWatch(t, []string{dir}, 0, nil)

	h.sched.nextDelay(t, 0).fire(t)
	h.serve(t, nil)

	if !h.w.watches(dir) {
		t.Fatalf("root was never watched; added = %v", h.w.paths())
	}
}

// The whole point of the retry: a first sync that fails must try again by
// itself, with no filesystem event to wake it.
func TestWatchInitialFailureRetriesWithNoEvent(t *testing.T) {
	dir := t.TempDir()
	h := startWatch(t, []string{dir}, 0, nil)

	retry := h.setupFail(t, errors.New("receiver refused the connection"))

	// No event happens at all — only the retry timer.
	retry.fire(t)
	h.serve(t, nil)

	// A success must leave nothing scheduled and reset the backoff: the next
	// event schedules an ordinary debounce, not a doubled backoff.
	h.w.events <- fsnotify.Event{Name: filepath.Join(dir, "a"), Op: fsnotify.Write}
	h.sched.nextDelay(t, 800*time.Millisecond)
	if n := h.calls.Load(); n != 2 {
		t.Fatalf("expected exactly 2 attempts, got %d", n)
	}
}

// A sync that fails after a healthy period retries the same way.
func TestWatchLaterFailureRetriesWithNoEvent(t *testing.T) {
	dir := t.TempDir()
	h := startWatch(t, []string{dir}, 0, nil)

	h.sched.nextDelay(t, 0).fire(t)
	h.serve(t, nil)

	h.w.events <- fsnotify.Event{Name: filepath.Join(dir, "a"), Op: fsnotify.Write}
	h.sched.nextDelay(t, 800*time.Millisecond).fire(t)
	h.serve(t, errors.New("connection reset"))
	h.notice(t)

	h.sched.nextDelay(t, time.Second).fire(t)
	h.serve(t, nil)
	h.noSyncAttempt(t)
}

// Backoff doubles, stops at the cap, and a success puts it back to zero.
func TestWatchBackoffDoublesCapsAndResets(t *testing.T) {
	dir := t.TempDir()
	h := startWatch(t, []string{dir}, 0, nil) // min 1s, max 4s

	boom := errors.New("nope")
	h.sched.nextDelay(t, 0).fire(t)
	h.serve(t, boom)
	h.notice(t)

	for _, want := range []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 4 * time.Second} {
		ft := h.sched.nextDelay(t, want)
		ft.fire(t)
		h.serve(t, boom)
		h.notice(t)
	}

	// Cap holds, then success resets: the following failure starts at min again.
	h.sched.nextDelay(t, 4*time.Second).fire(t)
	h.serve(t, nil)

	h.w.events <- fsnotify.Event{Name: filepath.Join(dir, "a"), Op: fsnotify.Write}
	h.sched.nextDelay(t, 800*time.Millisecond).fire(t)
	h.serve(t, boom)
	h.notice(t)
	h.sched.nextDelay(t, time.Second)
}

// A change arriving during a pending backoff pulls that one attempt earlier. It
// must not start a second attempt and must not leave the old timer running.
func TestWatchChangeDuringBackoffPullsRetryEarlier(t *testing.T) {
	dir := t.TempDir()
	h := startWatch(t, []string{dir}, 0, func(o *WatchOpts) {
		o.MinBackoff = 10 * time.Second
	})

	h.sched.nextDelay(t, 0).fire(t)
	h.serve(t, errors.New("receiver down"))
	h.notice(t)
	pending := h.sched.nextDelay(t, 10*time.Second)

	h.w.events <- fsnotify.Event{Name: filepath.Join(dir, "a"), Op: fsnotify.Write}

	sooner := h.sched.nextDelay(t, 800*time.Millisecond)
	if !pending.isStopped() {
		t.Fatal("the pending backoff timer was left running alongside the earlier one")
	}
	h.noSyncAttempt(t)

	sooner.fire(t)
	h.serve(t, nil)
	if n := h.calls.Load(); n != 2 {
		t.Fatalf("expected 2 attempts (initial + pulled-in retry), got %d", n)
	}
}

// A change while a *shorter* deadline is already pending must not push the
// attempt back.
func TestWatchChangeDoesNotDelayANearerDeadline(t *testing.T) {
	dir := t.TempDir()
	h := startWatch(t, []string{dir}, 0, func(o *WatchOpts) {
		o.MinBackoff = 100 * time.Millisecond // nearer than the 800ms debounce
		o.MaxBackoff = time.Second
	})

	h.sched.nextDelay(t, 0).fire(t)
	h.serve(t, errors.New("down"))
	h.notice(t)
	pending := h.sched.nextDelay(t, 100*time.Millisecond)

	h.w.events <- fsnotify.Event{Name: filepath.Join(dir, "a"), Op: fsnotify.Write}
	if pending.isStopped() {
		t.Fatal("a change pushed an already-nearer retry further away")
	}
	pending.fire(t)
	h.serve(t, nil)
}

// A burst of changes coalesces into one attempt.
func TestWatchCoalescesChangeStorm(t *testing.T) {
	dir := t.TempDir()
	h := startWatch(t, []string{dir}, 0, nil)

	h.sched.nextDelay(t, 0).fire(t)
	h.serve(t, nil)

	for i := 0; i < 5; i++ {
		h.w.events <- fsnotify.Event{Name: filepath.Join(dir, "a"), Op: fsnotify.Write}
	}
	ft := h.sched.nextDelay(t, 800*time.Millisecond)
	if extra := len(h.sched.armed); extra != 0 {
		t.Fatalf("a 5-write burst armed %d extra timers; it should coalesce into one", extra)
	}
	ft.fire(t)
	h.serve(t, nil)
	if n := h.calls.Load(); n != 2 {
		t.Fatalf("burst should coalesce into one extra attempt, got %d attempts total", n)
	}
}

// Attempts are serialized: changes that land while a sync is running are picked
// up afterwards as one further attempt, never as a concurrent one.
func TestWatchNeverOverlapsSyncRuns(t *testing.T) {
	dir := t.TempDir()
	h := startWatch(t, []string{dir}, 8, nil) // buffered, so events can queue mid-run

	h.sched.nextDelay(t, 0).fire(t)
	select {
	case <-h.started:
	case <-time.After(5 * time.Second):
		t.Fatal("no sync attempt started")
	}
	// The sync is now in flight and has not been given its result yet.
	for i := 0; i < 3; i++ {
		h.w.events <- fsnotify.Event{Name: filepath.Join(dir, "a"), Op: fsnotify.Write}
	}
	if n := h.calls.Load(); n != 1 {
		t.Fatalf("events during a run started %d attempts, want 1 in flight", n)
	}
	h.result <- nil

	h.sched.nextDelay(t, 800*time.Millisecond).fire(t)
	h.serve(t, nil)

	if h.overlap.Load() != 0 {
		t.Fatal("sync callbacks overlapped")
	}
	if n := h.calls.Load(); n != 2 {
		t.Fatalf("expected 2 attempts, got %d", n)
	}
}

// A watcher error must be reported with context and must trigger a re-sync
// rather than being swallowed.
func TestWatchWatcherErrorIsSurfacedAndResyncs(t *testing.T) {
	dir := t.TempDir()
	h := startWatch(t, []string{dir}, 0, nil)

	h.sched.nextDelay(t, 0).fire(t)
	h.serve(t, nil)

	h.w.errs <- errors.New("inotify queue overflow")
	n := h.notice(t)
	if !strings.Contains(n.Error(), "inotify queue overflow") || !strings.Contains(n.Error(), "watcher reported an error") {
		t.Fatalf("watcher error lost its context: %v", n)
	}
	h.sched.nextDelay(t, 800*time.Millisecond).fire(t)
	h.serve(t, nil)
}

// The failure a watcher error really hides: the dropped events may include a
// watched directory being removed and recreated under the same name. The kernel
// watch died with the old inode, but nothing here saw it, so the watch set still
// records the path as watched. A repair that trusts that record adds nothing,
// reports success, and leaves the recreated directory permanently unwatched.
//
// So the recovery has to distrust its own registrations, not just the tree: no
// event is delivered for the removal or the recreation here, and the repair must
// still hand both the root and its subdirectory to the watcher again.
func TestWatchWatcherErrorRewatchesPathsItStillThinksAreWatched(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "src")
	sub := filepath.Join(root, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	h := startWatch(t, []string{root}, 0, nil)

	h.sched.nextDelay(t, 0).fire(t)
	h.serve(t, nil)
	if h.w.countAdds(root) != 1 || h.w.countAdds(sub) != 1 {
		t.Fatalf("startup did not watch the tree: %v", h.w.paths())
	}

	// The subtree is replaced by an identical-looking one. This is the part the
	// overflow swallowed: no Remove and no Create reaches the loop, so nothing
	// but the error itself can tell it that its watches are stale.
	if err := os.RemoveAll(sub); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}

	h.w.errs <- errors.New("inotify queue overflow")
	if n := h.notice(t); !strings.Contains(n.Error(), "rebuilding the watch set") {
		t.Fatalf("watcher error reported as %v", n)
	}

	// The repair pass. Both paths look unchanged from here, so the only correct
	// behaviour is to add them again regardless.
	h.sched.nextDelay(t, 800*time.Millisecond).fire(t)
	h.serve(t, nil)
	for _, p := range []string{root, sub} {
		if n := h.w.countAdds(p); n != 2 {
			t.Fatalf("after a watcher error %q was added %d times, want 2 (the repair must not trust its own record); added = %v", p, n, h.w.paths())
		}
	}

	// And the repair genuinely settled: a later write schedules an ordinary
	// debounce rather than another backoff, and no notice says the source is
	// still partly unwatched.
	select {
	case n := <-h.notices:
		t.Fatalf("the repaired watch set still reported trouble: %v", n)
	default:
	}
	h.send(t, fsnotify.Event{Name: filepath.Join(sub, "f.txt"), Op: fsnotify.Write})
	h.sched.nextDelay(t, 800*time.Millisecond).fire(t)
	h.serve(t, nil)

	if n := h.calls.Load(); n != 3 {
		t.Fatalf("expected 3 attempts (startup, repair, post-repair write), got %d", n)
	}
	if h.overlap.Load() != 0 {
		t.Fatal("sync callbacks overlapped")
	}
}

// A closed event channel means nothing is being watched any more. That must end
// the loop with an error, not spin on a permanently ready channel.
func TestWatchClosedEventChannelReturnsError(t *testing.T) {
	dir := t.TempDir()
	h := startWatch(t, []string{dir}, 0, nil)

	h.sched.nextDelay(t, 0).fire(t)
	h.serve(t, nil)

	close(h.w.events)
	if err := h.wait(t); !errors.Is(err, ErrWatcherClosed) {
		t.Fatalf("err = %v, want ErrWatcherClosed", err)
	}
	if n := h.calls.Load(); n != 1 {
		t.Fatalf("a closed channel spun the loop into %d attempts", n)
	}
}

func TestWatchClosedErrorChannelReturnsError(t *testing.T) {
	dir := t.TempDir()
	h := startWatch(t, []string{dir}, 0, nil)

	h.sched.nextDelay(t, 0).fire(t)
	h.serve(t, nil)

	close(h.w.errs)
	if err := h.wait(t); !errors.Is(err, ErrWatcherClosed) {
		t.Fatalf("err = %v, want ErrWatcherClosed", err)
	}
}

// Cancellation stops the owned timer, closes the watcher and exits cleanly.
func TestWatchCancellationStopsTimerAndWatcher(t *testing.T) {
	dir := t.TempDir()
	h := startWatch(t, []string{dir}, 0, nil)

	pending := h.setupFail(t, errors.New("down"))

	h.cancel()
	if err := h.wait(t); err != nil {
		t.Fatalf("cancellation returned %v, want nil", err)
	}
	if !pending.isStopped() {
		t.Fatal("the pending retry timer was left running after cancellation")
	}
	if !h.w.isClosed() {
		t.Fatal("the watcher was not closed after cancellation")
	}
}

// Cancelling during an in-flight sync must not start another attempt.
func TestWatchCancellationDuringSyncDoesNotReattempt(t *testing.T) {
	dir := t.TempDir()
	h := startWatch(t, []string{dir}, 0, nil)

	h.sched.nextDelay(t, 0).fire(t)
	select {
	case <-h.started:
	case <-time.After(5 * time.Second):
		t.Fatal("no sync attempt started")
	}
	h.cancel()
	h.result <- errors.New("interrupted")

	if err := h.wait(t); err != nil {
		t.Fatalf("cancellation returned %v, want nil", err)
	}
	if n := h.calls.Load(); n != 1 {
		t.Fatalf("cancelled watch ran %d attempts, want 1", n)
	}
}

// The exact boundary the help promises: Ctrl-C starts no further attempt, and
// the command exits once the attempt already running has returned. A transfer
// in flight is not cut off.
func TestWatchCancelExitsOnlyAfterTheRunningAttemptReturns(t *testing.T) {
	dir := t.TempDir()
	h := startWatch(t, []string{dir}, 0, nil)

	h.sched.nextDelay(t, 0).fire(t)
	select {
	case <-h.started:
	case <-time.After(5 * time.Second):
		t.Fatal("no sync attempt started")
	}

	// Cancelled mid-sync. The loop calls sync inline, so it cannot have returned
	// while this attempt is still waiting for its result.
	h.cancel()
	h.notReturned(t)

	// Only once the in-flight attempt returns does the command exit — and it
	// exits rather than running the attempt the cancellation interrupted.
	h.result <- nil
	if err := h.wait(t); err != nil {
		t.Fatalf("cancellation returned %v, want nil", err)
	}
	if n := h.calls.Load(); n != 1 {
		t.Fatalf("cancellation ran %d attempts, want only the one already in flight", n)
	}
}

// ------------------------------------------------- root validation up front

// A missing root must fail immediately instead of parking a process with no
// watchers, and the error must name the source.
func TestWatchRejectsMissingRoot(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "gone")
	h := startWatch(t, []string{missing}, 0, nil)

	err := h.wait(t)
	if err == nil || !strings.Contains(err.Error(), "gone") || !strings.Contains(err.Error(), "--watch") {
		t.Fatalf("err = %v, want an actionable --watch error naming the source", err)
	}
	h.noSyncAttempt(t)
	if n := h.calls.Load(); n != 0 {
		t.Fatalf("a bad root still ran %d syncs", n)
	}
}

// sync itself skips symlinks and special files, so watching one could only ever
// send nothing. Say so instead of watching a path that can never produce work.
func TestWatchRejectsSymlinkRoot(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "real")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	h := startWatch(t, []string{link}, 0, nil)

	err := h.wait(t)
	if err == nil || !strings.Contains(err.Error(), "symlinks") {
		t.Fatalf("err = %v, want a symlink-specific --watch refusal", err)
	}
}

// A file source is legitimate for sync, so --watch supports it — but it watches
// the directory holding the file too. Editors replace a file by renaming a
// temporary over it, which drops a watch on the file itself and would otherwise
// leave this process running with nothing left to notice.
func TestWatchFileRootAlsoWatchesItsDirectory(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "page.html")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := startWatch(t, []string{file}, 0, nil)

	h.sched.nextDelay(t, 0).fire(t)
	h.serve(t, nil)

	if !h.w.watches(file) {
		t.Errorf("file source is not watched; added = %v", h.w.paths())
	}
	if !h.w.watches(dir) {
		t.Errorf("the directory holding the file source is not watched; added = %v", h.w.paths())
	}
}

// watcher.Add failures must reach the user, not be dropped on the floor.
func TestWatchPropagatesAddFailure(t *testing.T) {
	dir := t.TempDir()
	h := &watchHarness{
		sched:   newFakeSched(),
		w:       newFakeWatcher(0),
		notices: make(chan error, 64),
		done:    make(chan error, 1),
		started: make(chan struct{}),
		result:  make(chan error),
	}
	h.w.failAdd(dir, errors.New("no space left on device"))
	go func() {
		h.done <- WatchAndSync(context.Background(), []string{dir}, func() error { return nil }, WatchOpts{
			newWatcher: func() (fsWatcher, error) { return h.w, nil },
			newTimer:   h.sched.newTimer,
			now:        h.sched.Now,
		})
	}()

	err := h.wait(t)
	if err == nil || !strings.Contains(err.Error(), "no space left on device") {
		t.Fatalf("err = %v, want the watcher.Add failure surfaced", err)
	}
}

// A directory the walk cannot read is a real problem: sync itself would fail on
// it, so --watch must not start as if everything were fine.
func TestWatchPropagatesWalkDirFailure(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root can read any directory")
	}
	dir := t.TempDir()
	blocked := filepath.Join(dir, "blocked")
	if err := os.Mkdir(blocked, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(blocked, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(blocked, 0o755) })

	h := startWatch(t, []string{dir}, 0, nil)
	err := h.wait(t)
	if err == nil || !strings.Contains(err.Error(), "--watch") {
		t.Fatalf("err = %v, want the walk failure reported as a --watch error", err)
	}
	if n := h.calls.Load(); n != 0 {
		t.Fatalf("an unwalkable root still ran %d syncs", n)
	}
}

// Lstat succeeds on a file this process cannot read, and so does adding a watch
// to it. Without an explicit open, --watch would settle into watching a source
// that every single sync then fails on.
func TestWatchRejectsUnreadableFileRoot(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root can read any file")
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "secret.txt")
	if err := os.WriteFile(file, []byte("x"), 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(file, 0o644) })
	if f, err := os.Open(file); err == nil {
		f.Close()
		t.Skip("this filesystem does not enforce the mode")
	}

	h := startWatch(t, []string{file}, 0, nil)
	err := h.wait(t)
	if err == nil || !strings.Contains(err.Error(), "secret.txt") || !strings.Contains(err.Error(), "--watch") {
		t.Fatalf("err = %v, want an actionable --watch error naming the unreadable source", err)
	}
	if n := h.calls.Load(); n != 0 {
		t.Fatalf("an unreadable source still ran %d syncs", n)
	}
}

func TestWatchRejectsEmptyRootList(t *testing.T) {
	h := startWatch(t, nil, 0, nil)
	if err := h.wait(t); err == nil {
		t.Fatal("watching nothing should be an error")
	}
}

// ------------------------------------------------ watch set, driven directly

// These drive watchLoop.observe as a plain method call. The watch set is what
// they assert on, and a send on the loop's event channel only proves the loop
// received the event, never that it acted on it — calling the method is the
// only way to make that ordering exact.

type observeHarness struct {
	l       *watchLoop
	w       *fakeWatcher
	notices []error
}

func newObserveHarness(t *testing.T, roots ...string) *observeHarness {
	t.Helper()
	h := &observeHarness{w: newFakeWatcher(0)}
	opts := WatchOpts{OnNotice: func(err error) { h.notices = append(h.notices, err) }}
	opts.applyDefaults()
	h.l = &watchLoop{w: h.w, opts: opts, added: map[string]bool{}}
	if err := h.l.start(roots); err != nil {
		t.Fatalf("start(%v): %v", roots, err)
	}
	return h
}

func (h *observeHarness) create(p string) { h.l.observe(fsnotify.Event{Name: p, Op: fsnotify.Create}) }
func (h *observeHarness) remove(p string) { h.l.observe(fsnotify.Event{Name: p, Op: fsnotify.Remove}) }

// A new subdirectory is watched, once, and needs no repair pass afterwards.
func TestObserveWatchesNewSubdirectoryExactlyOnce(t *testing.T) {
	dir := t.TempDir()
	h := newObserveHarness(t, dir)

	sub := filepath.Join(dir, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	h.create(sub)
	h.create(sub) // a second create for a path already watched
	if n := h.w.countAdds(sub); n != 1 {
		t.Fatalf("new subdirectory added %d times, want 1; added = %v", n, h.w.paths())
	}
	if h.l.dirty {
		t.Fatal("following a new subdirectory should not leave the watch set needing repair")
	}
}

// A removed directory is forgotten together with everything under it, so a
// recreated subtree is watched again instead of skipped as already-watched. It
// also marks the set dirty: fsnotify cannot report the recreation of a path
// whose parent is not watched, so only the repair pass can finish the job.
func TestObserveForgetsRemovedSubtreeAndAsksForRepair(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "sub")
	deep := filepath.Join(sub, "deep")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	h := newObserveHarness(t, dir)
	if !h.l.added[sub] || !h.l.added[deep] {
		t.Fatalf("startup did not watch the whole tree: %v", h.w.paths())
	}

	if err := os.RemoveAll(sub); err != nil {
		t.Fatal(err)
	}
	h.remove(sub)
	if h.l.added[sub] || h.l.added[deep] {
		t.Fatalf("removing %q left descendants in the watch set: %v", sub, h.l.added)
	}
	if !h.l.dirty {
		t.Fatal("a removed watched directory did not mark the watch set for repair")
	}

	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	h.create(sub)
	for _, p := range []string{sub, deep} {
		if n := h.w.countAdds(p); n != 2 {
			t.Fatalf("recreated %q added %d times, want 2; added = %v", p, n, h.w.paths())
		}
	}
}

// Deleting an ordinary file is not a watch-set problem. Marking the set dirty
// for it would buy a full tree walk on every deleted file for nothing.
func TestObserveIgnoresRemovedRegularFile(t *testing.T) {
	dir := t.TempDir()
	h := newObserveHarness(t, dir)
	h.remove(filepath.Join(dir, "f.txt"))
	if h.l.dirty {
		t.Fatal("deleting an unwatched file asked for a whole watch-set rebuild")
	}
}

// A file created inside a watched directory must not become a watch of its own.
func TestObserveIgnoresCreatedFiles(t *testing.T) {
	dir := t.TempDir()
	h := newObserveHarness(t, dir)

	file := filepath.Join(dir, "f.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.create(file)
	if h.w.watches(file) {
		t.Fatalf("a created regular file was added as a watch: %v", h.w.paths())
	}
	if h.l.dirty {
		t.Fatal("a created regular file asked for a watch-set rebuild")
	}
}

// A directory that cannot be followed is reported *and* remembered. Reporting
// alone is what left a subtree permanently unwatched.
func TestObserveReportsAndRemembersUnfollowableDirectory(t *testing.T) {
	dir := t.TempDir()
	h := newObserveHarness(t, dir)

	sub := filepath.Join(dir, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	h.w.failAdd(sub, errors.New("watch limit reached"))
	h.create(sub)

	if len(h.notices) != 1 {
		t.Fatalf("got %d notices, want exactly 1: %v", len(h.notices), h.notices)
	}
	if n := h.notices[0]; !strings.Contains(n.Error(), "watch limit reached") || !strings.Contains(n.Error(), "sub") {
		t.Fatalf("unfollowable directory reported as %v", n)
	}
	if !h.l.dirty {
		t.Fatal("an add failure was reported but not remembered, so nothing would ever retry it")
	}
}

// Repeated watcher errors must keep the rebuild bounded. Each one re-adds every
// live path exactly once and rebuilds the record from the canonical roots, so
// the tracked set neither grows nor stacks duplicate adds within a pass.
func TestInvalidateRebuildsWatchSetWithoutGrowingIt(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	h := newObserveHarness(t, dir)

	want := map[string]bool{dir: true, sub: true}
	for round := 1; round <= 3; round++ {
		h.l.invalidate()
		if len(h.l.added) != 0 {
			t.Fatalf("round %d: invalidate kept %d registrations, so the repair would still skip them", round, len(h.l.added))
		}
		if !h.l.dirty {
			t.Fatalf("round %d: invalidate did not ask for a repair", round)
		}
		if err := h.l.reconcile(); err != nil {
			t.Fatalf("round %d: reconcile: %v", round, err)
		}
		if h.l.dirty {
			t.Fatalf("round %d: a successful rebuild left the watch set dirty", round)
		}
		if !maps.Equal(h.l.added, want) {
			t.Fatalf("round %d: rebuilt watch set = %v, want %v", round, h.l.added, want)
		}
		for p := range want {
			// One add per path per rebuild: the first from startup, then one more
			// each round. More would mean a rebuild adding the same path twice.
			if n := h.w.countAdds(p); n != round+1 {
				t.Fatalf("round %d: %q added %d times, want %d; added = %v", round, p, n, round+1, h.w.paths())
			}
		}
	}
}

// Re-adding a path the real watcher is already watching has to be a no-op
// rather than an error or a second delivery, because that is exactly what the
// rebuild above does to every still-live directory.
func TestRealWatcherReAddIsSafe(t *testing.T) {
	dir := t.TempDir()
	w, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	for i := 0; i < 3; i++ {
		if err := w.Add(dir); err != nil {
			t.Fatalf("add #%d of an already-watched directory: %v", i+1, err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	select {
	case ev := <-w.Events:
		if !strings.HasSuffix(ev.Name, "f.txt") {
			t.Fatalf("unexpected event %v", ev)
		}
	case err := <-w.Errors:
		t.Fatalf("watcher error after re-adding: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("a re-added directory stopped reporting writes")
	}
}

// ------------------------------------------------- watch-set repair, in loop

// The failure this is really about: a source root that is removed and recreated
// while the watch runs. Nothing watches a root's parent, so no filesystem event
// can ever report its return — only the repair pass can. And until the repair
// lands, a sync that happens to succeed must not be treated as healthy, because
// the watch it depends on is not there.
func TestWatchRemovedRootIsRewatchedByRetryWithNoEvent(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "src")
	sub := filepath.Join(root, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	h := startWatch(t, []string{root}, 0, nil)

	h.sched.nextDelay(t, 0).fire(t)
	h.serve(t, nil)
	if h.w.countAdds(root) != 1 || h.w.countAdds(sub) != 1 {
		t.Fatalf("startup did not watch the tree: %v", h.w.paths())
	}

	// The root goes away. This event is the last thing the watcher will ever say
	// about it.
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	h.send(t, fsnotify.Event{Name: root, Op: fsnotify.Remove})

	// The sync itself succeeds — and the attempt still must not settle. A
	// healthy result here is exactly the partially-watched success being fixed.
	h.sched.nextDelay(t, 800*time.Millisecond).fire(t)
	h.serve(t, nil)
	if n := h.notice(t); !strings.Contains(n.Error(), "not being watched") {
		t.Fatalf("a successful sync over a broken watch set reported: %v", n)
	}
	retry := h.sched.nextDelay(t, time.Second)

	// The root comes back. No event announces it; the pending retry is the only
	// thing that can notice, and it must rebuild the whole subtree.
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	retry.fire(t)
	h.serve(t, nil)
	for _, p := range []string{root, sub} {
		if n := h.w.countAdds(p); n != 2 {
			t.Fatalf("recreated %q watched %d times, want 2; added = %v", p, n, h.w.paths())
		}
	}

	// It is genuinely healthy again: a later write under the recreated subtree
	// schedules an ordinary debounce (not another backoff) and does sync.
	h.send(t, fsnotify.Event{Name: filepath.Join(sub, "f.txt"), Op: fsnotify.Write})
	h.sched.nextDelay(t, 800*time.Millisecond).fire(t)
	h.serve(t, nil)
	if n := h.calls.Load(); n != 4 {
		t.Fatalf("expected 4 attempts (startup, broken, repaired, post-repair write), got %d", n)
	}
	if h.overlap.Load() != 0 {
		t.Fatal("sync callbacks overlapped")
	}
}

// A live watcher.Add failure must not settle into a healthy partially-watched
// state. Every attempt here syncs successfully; none of them may go quiet, and
// the add has to be retried on the loop's own timer with no further events.
func TestWatchLiveAddFailureNeverSettlesHealthy(t *testing.T) {
	root := t.TempDir()
	h := startWatch(t, []string{root}, 0, nil) // min 1s, max 4s

	h.sched.nextDelay(t, 0).fire(t)
	h.serve(t, nil)

	sub := filepath.Join(root, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	h.w.failAdd(sub, errors.New("watch limit reached"))
	h.send(t, fsnotify.Event{Name: sub, Op: fsnotify.Create})
	if n := h.notice(t); !strings.Contains(n.Error(), "watch limit reached") {
		t.Fatalf("the unfollowable directory was not reported: %v", n)
	}

	// Four attempts, each with a working sync, each refusing to be healthy and
	// backing further off instead of falling silent.
	for _, want := range []time.Duration{800 * time.Millisecond, time.Second, 2 * time.Second, 4 * time.Second} {
		h.sched.nextDelay(t, want).fire(t)
		h.serve(t, nil)
		if n := h.notice(t); !strings.Contains(n.Error(), "not being watched") {
			t.Fatalf("a partially-watched attempt reported: %v", n)
		}
	}

	// No new event, ever: the retry alone re-adds the subtree once it can.
	h.w.clearAddErr(sub)
	h.sched.nextDelay(t, 4*time.Second).fire(t)
	h.serve(t, nil)
	if !h.w.watches(sub) {
		t.Fatalf("the failed add was never retried; added = %v", h.w.paths())
	}

	// Only now is it healthy: the next change gets a debounce, not a backoff.
	h.send(t, fsnotify.Event{Name: filepath.Join(sub, "f.txt"), Op: fsnotify.Write})
	h.sched.nextDelay(t, 800*time.Millisecond).fire(t)
	h.serve(t, nil)
	if h.overlap.Load() != 0 {
		t.Fatal("sync callbacks overlapped")
	}
}

// An add failure that never clears must keep retrying rather than quietly
// succeeding. The backoff sits at the cap and every attempt still reports.
func TestWatchPermanentAddFailureKeepsReporting(t *testing.T) {
	root := t.TempDir()
	h := startWatch(t, []string{root}, 0, nil)

	h.sched.nextDelay(t, 0).fire(t)
	h.serve(t, nil)

	sub := filepath.Join(root, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	h.w.failAdd(sub, errors.New("watch limit reached"))
	h.send(t, fsnotify.Event{Name: sub, Op: fsnotify.Create})
	h.notice(t)

	for _, want := range []time.Duration{800 * time.Millisecond, time.Second, 2 * time.Second, 4 * time.Second, 4 * time.Second, 4 * time.Second} {
		h.sched.nextDelay(t, want).fire(t)
		h.serve(t, nil)
		if n := h.notice(t); !strings.Contains(n.Error(), "not being watched") {
			t.Fatalf("a permanently partial watch reported: %v", n)
		}
	}
}

// ------------------------------------------------------- real watcher smoke

// One end-to-end pass over the real fsnotify watcher and real timers, so the
// seams above cannot drift from the wiring that actually ships. It waits on
// channels rather than sleeping for a fixed period.
func TestWatchAndSyncWithRealWatcher(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	fired := make(chan struct{}, 16)
	done := make(chan error, 1)
	go func() {
		done <- WatchAndSync(ctx, []string{dir}, func() error {
			select {
			case fired <- struct{}{}:
			default:
			}
			return nil
		}, WatchOpts{Debounce: 5 * time.Millisecond})
	}()

	// The startup sync.
	select {
	case <-fired:
	case <-time.After(10 * time.Second):
		t.Fatal("startup sync never ran")
	}
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	select {
	case <-fired:
	case <-time.After(10 * time.Second):
		t.Fatal("a write under the root never triggered a sync")
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("cancellation returned %v, want nil", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("WatchAndSync did not stop on cancellation")
	}
}
