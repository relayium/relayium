package xfer

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Defaults for WatchAndSync. The backoff bounds are deliberately short: a watch
// is an interactive foreground command, so a receiver that comes back should be
// picked up in seconds rather than minutes.
const (
	DefaultWatchDebounce   = 800 * time.Millisecond
	DefaultWatchMinBackoff = 1 * time.Second
	DefaultWatchMaxBackoff = 30 * time.Second
)

// ErrWatcherClosed is returned when the filesystem watcher's channels close
// underneath a running watch. It is not a normal shutdown: cancelling the
// context returns nil instead.
var ErrWatcherClosed = errors.New("--watch: the filesystem watcher closed unexpectedly; nothing is being watched any more")

// fsWatcher is the part of *fsnotify.Watcher that WatchAndSync uses. It exists
// so tests can drive events, errors, channel closure and Add failures without
// depending on real filesystem timing.
type fsWatcher interface {
	Add(path string) error
	Close() error
	Events() <-chan fsnotify.Event
	Errors() <-chan error
}

type realWatcher struct{ w *fsnotify.Watcher }

func (r realWatcher) Add(p string) error            { return r.w.Add(p) }
func (r realWatcher) Close() error                  { return r.w.Close() }
func (r realWatcher) Events() <-chan fsnotify.Event { return r.w.Events }
func (r realWatcher) Errors() <-chan error          { return r.w.Errors }

func newRealWatcher() (fsWatcher, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	return realWatcher{w: w}, nil
}

// newTimerFunc starts a one-shot timer and returns its channel plus a stop
// function, mirroring time.NewTimer. The watch loop owns exactly one timer at a
// time and always stops the previous one before arming another.
type newTimerFunc func(d time.Duration) (<-chan time.Time, func() bool)

func realTimer(d time.Duration) (<-chan time.Time, func() bool) {
	t := time.NewTimer(d)
	return t.C, t.Stop
}

// WatchOpts tunes WatchAndSync. The zero value is usable: every field falls
// back to its documented default.
type WatchOpts struct {
	// Debounce is how long a change storm is coalesced before a sync attempt.
	Debounce time.Duration
	// MinBackoff and MaxBackoff bound the retry delay after a failed sync.
	MinBackoff time.Duration
	MaxBackoff time.Duration
	// OnNotice reports recoverable trouble: a failed sync that will be retried,
	// a watcher error, or a new subdirectory that could not be followed. It may
	// be nil. It is called from the watch goroutine and must not block.
	OnNotice func(error)

	// Test seams. Left nil, they use the real watcher, timer and clock.
	newWatcher func() (fsWatcher, error)
	newTimer   newTimerFunc
	now        func() time.Time
}

func (o *WatchOpts) applyDefaults() {
	if o.Debounce <= 0 {
		o.Debounce = DefaultWatchDebounce
	}
	if o.MinBackoff <= 0 {
		o.MinBackoff = DefaultWatchMinBackoff
	}
	if o.MaxBackoff < o.MinBackoff {
		o.MaxBackoff = max(DefaultWatchMaxBackoff, o.MinBackoff)
	}
	if o.newWatcher == nil {
		o.newWatcher = newRealWatcher
	}
	if o.newTimer == nil {
		o.newTimer = realTimer
	}
	if o.now == nil {
		o.now = time.Now
	}
}

// WatchAndSync watches every source root and runs sync whenever they change,
// including once at the start.
//
// It is a small state machine with a single owned timer, driven from one
// goroutine, so sync attempts never overlap and a change storm coalesces into
// one attempt. A failed sync — including the very first one — schedules its own
// retry with exponential backoff between MinBackoff and MaxBackoff, so a
// receiver that comes back is picked up without needing another file change. A
// successful sync resets the backoff. A change arriving while a retry is pending
// pulls that one attempt earlier rather than starting a second.
//
// Every root is validated and watched before the first attempt: a missing,
// unreadable or unwatchable root is an error, never a process that sits forever
// with no watchers. After that the watch set is self-healing rather than
// fixed — a subtree that could not be followed, or a root that was removed and
// recreated, marks it dirty, and the next attempt rebuilds it from the roots
// before any sync is allowed to count as healthy. A watch set that stays broken
// therefore keeps retrying instead of settling into a partially-watched
// "everything is fine".
//
// Cancelling ctx stops the timer and watcher and returns nil. It prevents any
// further attempt from starting, but does not interrupt one already running:
// the sync callback is called inline, so the loop returns once that call has
// returned.
func WatchAndSync(ctx context.Context, roots []string, sync func() error, opts WatchOpts) error {
	opts.applyDefaults()

	w, err := opts.newWatcher()
	if err != nil {
		return fmt.Errorf("--watch: cannot start a filesystem watcher: %w", err)
	}
	defer w.Close()

	l := &watchLoop{w: w, sync: sync, opts: opts, added: map[string]bool{}}
	defer l.disarm()

	if err := l.start(roots); err != nil {
		return err
	}
	// The first sync goes through the same state machine as every later one, so
	// an initial failure retries on its own instead of waiting for a change.
	l.arm(0)

	events, errs := w.Events(), w.Errors()
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-events:
			if !ok {
				return ErrWatcherClosed
			}
			l.observe(ev)
			l.requestSooner(l.opts.Debounce)
		case err, ok := <-errs:
			if !ok {
				return ErrWatcherClosed
			}
			// An error here — an inotify queue overflow, say — means events were
			// dropped, and the dropped ones may be exactly the removals that
			// keep the watch set honest. Rebuild it rather than trust it, and
			// throw away what we think is watched along with it: a dropped
			// remove+recreate under the same name leaves the kernel watch gone
			// while the path still looks watched, so a repair that trusted that
			// record would skip the path and call itself healthy.
			l.invalidate()
			l.notice(fmt.Errorf("the filesystem watcher reported an error; re-syncing and rebuilding the watch set to recover: %w", err))
			l.requestSooner(l.opts.Debounce)
		case <-l.timerC:
			l.disarm()
			l.attempt()
			if ctx.Err() != nil {
				return nil
			}
		}
	}
}

// watchLoop is the state machine's data. Every field is touched from the single
// WatchAndSync goroutine only.
type watchLoop struct {
	w    fsWatcher
	sync func() error
	opts WatchOpts

	// roots are the canonical sources, resolved once at startup. They are the
	// only authority on what must be watched: the live watch set is rebuilt from
	// exactly these whenever it goes dirty, which is what lets a root that was
	// removed and recreated become fully watched again. Nothing else can supply
	// that, because a root's parent is not watched and so its recreation is
	// never reported.
	roots []watchRoot
	// added is the set of paths currently handed to the watcher, so a path is
	// not watched twice. It is only ever a record of what this process asked
	// for: when dropped events make it untrustworthy, invalidate clears it so
	// the repair pass re-adds everything rather than believing it.
	added map[string]bool
	// dirty means the watch set is known to be incomplete: an add failed, or a
	// watched path went away and may come back. The next attempt reconciles
	// before syncing and refuses to call itself healthy until it succeeds.
	dirty bool

	// The one owned timer. timerC is nil exactly when no attempt is scheduled,
	// which makes the loop's select block instead of spinning.
	timerC <-chan time.Time
	stop   func() bool
	dueAt  time.Time

	// backoff is how long the last failure asked us to wait; zero means healthy.
	backoff time.Duration
}

// watchRoot is one source: the canonical path the watcher is driven from, plus
// the spelling the user typed, so an error names the source they wrote rather
// than an absolute path they never mentioned.
type watchRoot struct {
	display string
	path    string
}

func (l *watchLoop) notice(err error) {
	if l.opts.OnNotice != nil {
		l.opts.OnNotice(err)
	}
}

// arm replaces the owned timer with one due after d.
func (l *watchLoop) arm(d time.Duration) {
	l.disarm()
	l.dueAt = l.opts.now().Add(d)
	l.timerC, l.stop = l.opts.newTimer(d)
}

func (l *watchLoop) disarm() {
	if l.stop != nil {
		l.stop()
	}
	l.timerC, l.stop = nil, nil
}

// requestSooner asks for an attempt at the earlier of any already-scheduled
// deadline and now+d. It never creates a second attempt: a change during a
// pending backoff pulls that retry in, and a change storm coalesces into the
// first change's debounce window instead of pushing the attempt back forever.
func (l *watchLoop) requestSooner(d time.Duration) {
	due := l.opts.now().Add(d)
	if l.timerC != nil && !l.dueAt.After(due) {
		return
	}
	l.arm(d)
}

// attempt runs one whole cycle inline, so cycles cannot overlap: first it
// repairs the watch set, then it syncs.
//
// Both halves have to succeed for the attempt to count as healthy. Repairing
// first means a root that came back is watched before the sync that reports
// success reads it, and treating an unrepaired watch set as a failure is what
// stops this from settling into a long-running "synced" state that is quietly
// blind to part of the source. The sync still runs either way — a watch set
// that lost a subtree still mirrors that subtree correctly, and stopping the
// transfer would turn a missed-notification bug into a data-propagation one.
func (l *watchLoop) attempt() {
	werr := l.reconcile()
	serr := l.sync()
	if werr == nil && serr == nil {
		l.backoff = 0
		return
	}
	l.growBackoff()
	switch {
	case werr != nil && serr != nil:
		l.notice(fmt.Errorf("sync failed (%v), and part of the source is not being watched (%v); retrying in %s", serr, werr, l.backoff))
	case serr != nil:
		l.notice(fmt.Errorf("sync failed (%v); retrying in %s", serr, l.backoff))
	default:
		l.notice(fmt.Errorf("the sync ran, but part of the source is not being watched, so later changes there would be missed (%v); retrying in %s", werr, l.backoff))
	}
	l.arm(l.backoff)
}

// growBackoff moves the retry delay one step along MinBackoff → MaxBackoff.
func (l *watchLoop) growBackoff() {
	switch {
	case l.backoff == 0:
		l.backoff = l.opts.MinBackoff
	case l.backoff*2 > l.opts.MaxBackoff:
		l.backoff = l.opts.MaxBackoff
	default:
		l.backoff *= 2
	}
}

// reconcile rebuilds the watch set from the canonical roots when it is known to
// be incomplete. It is a no-op in the common case, so the extra walk costs
// nothing until something actually went wrong.
func (l *watchLoop) reconcile() error {
	if !l.dirty {
		return nil
	}
	if err := l.addRoots(); err != nil {
		return err
	}
	l.dirty = false
	return nil
}

// observe keeps the watch set in step with the tree.
//
// It can only ever do half the job: fsnotify reports what happened under a
// watched directory, and a source root's own parent is not watched, so the
// return of a removed root is invisible here. Anything it cannot finish marks
// the set dirty, which hands the rest to reconcile.
func (l *watchLoop) observe(ev fsnotify.Event) {
	if ev.Has(fsnotify.Remove) || ev.Has(fsnotify.Rename) {
		// Forget the path and everything under it, or a recreated subtree would
		// be skipped as already-watched. Only a path that really was watched
		// marks the set dirty: an ordinary file being deleted is not a watch-set
		// problem and must not cost a walk.
		if l.forget(ev.Name) {
			l.dirty = true
		}
		return
	}
	if !ev.Has(fsnotify.Create) {
		return
	}
	fi, err := os.Lstat(ev.Name)
	if err != nil || !fi.IsDir() {
		return
	}
	if err := l.addTree(ev.Name); err != nil {
		l.dirty = true
		l.notice(fmt.Errorf("cannot watch new directory %q, so changes under it would be missed; retrying before the next sync counts as healthy: %w", ev.Name, err))
	}
}

// invalidate marks the watch set dirty and drops every remembered registration,
// so the next reconcile hands every currently existing root and subdirectory to
// the watcher again instead of skipping it as already watched.
//
// It is for the case where events were dropped. After that, "this process added
// the path" no longer implies "the kernel is still watching that inode": a
// missed remove-and-recreate under the same name leaves a stale record pointing
// at a watch that no longer exists. Only re-adding can tell the difference,
// because the recreated directory looks identical from here.
//
// Re-adding a path whose watch is still live is safe: fsnotify's Add is
// idempotent — inotify updates the existing watch descriptor and kqueue returns
// early — so a rebuild costs one Add per watched directory and never stacks a
// second watch on the same path. The set is rebuilt from the canonical roots,
// so repeated errors cannot make it grow either.
func (l *watchLoop) invalidate() {
	l.added = map[string]bool{}
	l.dirty = true
}

// forget drops p and every path under it from the watch set, reporting whether
// anything was actually watched there.
func (l *watchLoop) forget(p string) bool {
	if !l.added[p] {
		// addTree watches a directory's ancestors before the directory itself,
		// so a path that is not in the set cannot have descendants in it. That
		// makes the commonest event by far — an ordinary file being deleted —
		// one map lookup instead of a scan of the whole watch set.
		return false
	}
	delete(l.added, p)
	prefix := p + string(filepath.Separator)
	for got := range l.added {
		if strings.HasPrefix(got, prefix) {
			delete(l.added, got)
		}
	}
	return true
}

// start resolves the sources once and watches them for the first time. Anything
// that would leave this process watching nothing is an error here, before the
// caller's first long-running wait, rather than silence later.
func (l *watchLoop) start(roots []string) error {
	if len(roots) == 0 {
		return errors.New("--watch: no source to watch")
	}
	l.roots = make([]watchRoot, 0, len(roots))
	for _, r := range roots {
		abs, err := filepath.Abs(r)
		if err != nil {
			return fmt.Errorf("--watch: cannot resolve source %q: %w", r, err)
		}
		l.roots = append(l.roots, watchRoot{display: r, path: abs})
	}
	return l.addRoots()
}

// addRoots watches every canonical root. It is idempotent — already-watched
// paths are skipped — so it doubles as the repair pass.
func (l *watchLoop) addRoots() error {
	for _, r := range l.roots {
		fi, err := os.Lstat(r.path)
		if err != nil {
			return fmt.Errorf("--watch: cannot watch source %q: %w", r.display, err)
		}
		switch {
		case fi.IsDir():
			if err := l.addTree(r.path); err != nil {
				return fmt.Errorf("--watch: cannot watch source %q: %w", r.display, err)
			}
		case fi.Mode().IsRegular():
			// Lstat and a watcher Add both succeed on a file this process cannot
			// read, so prove it is readable here; otherwise --watch settles into
			// watching a source every single sync then fails on.
			if err := openable(r.path); err != nil {
				return fmt.Errorf("--watch: cannot read source %q: %w", r.display, err)
			}
			// A file source is watched together with the directory holding it.
			// Editors replace a file by renaming a temporary over it, which
			// drops a watch on the file itself; without the parent this process
			// would keep running with nothing left to notice.
			if err := l.add(filepath.Dir(r.path)); err != nil {
				return fmt.Errorf("--watch: cannot watch the directory holding source %q: %w", r.display, err)
			}
			if err := l.add(r.path); err != nil {
				return fmt.Errorf("--watch: cannot watch source %q: %w", r.display, err)
			}
		default:
			return fmt.Errorf("--watch: cannot watch source %q: not a regular file or directory, and sync skips symlinks and special files, so there would be nothing to send", r.display)
		}
	}
	return nil
}

// openable reports whether p can actually be opened for reading.
func openable(p string) error {
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	return f.Close()
}

// addTree watches root and every directory under it, reporting rather than
// swallowing walk and watcher failures.
func (l *watchLoop) addTree(root string) error {
	return filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			return nil
		}
		return l.add(p)
	})
}

// add watches p unless it is already watched.
func (l *watchLoop) add(p string) error {
	if l.added[p] {
		return nil
	}
	if err := l.w.Add(p); err != nil {
		return err
	}
	l.added[p] = true
	return nil
}
