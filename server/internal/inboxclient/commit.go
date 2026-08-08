package inboxclient

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Committing verified bytes into the user's directory.
//
// THE CENTRAL CHOICE: link(2), NOT rename(2).
//
// rename() replaces its destination unconditionally and silently. Every
// "check that it does not exist, then rename" is therefore a race: a file
// created in the window between the check and the call is destroyed with no
// error and no trace. That window is not theoretical here — the check happens at
// planning time, before a download that may take minutes.
//
// link() fails with EEXIST if the destination name is taken by ANYTHING: a file,
// a directory, a socket, a device node, or a dangling symlink. The kernel makes
// the test and the creation one operation, so there is no window at all. Its two
// costs are accepted deliberately: it needs the same filesystem (which is why
// staging lives inside the receive directory) and it leaves the source behind
// (which is what makes a crashed commit provable — see commitOne).
//
// Nothing in this file opens, truncates, executes, or extracts anything that was
// already on disk. The only mutations are: create a fresh directory, create a
// fresh link, remove a file this package itself staged.

// receivedFileMode is the mode of a committed file: owner read/write, and NO
// EXECUTABLE BIT ON ANY PLATFORM (PRD §9). The mode is set explicitly on the
// staged file rather than left to the process umask, so the result does not
// depend on how the service happened to be launched — a systemd unit, a
// container entrypoint and an interactive shell all produce the same thing.
//
// 0600 rather than 0644 because an inbox is personal by default and this process
// may be running as a shared service account. Widening is a decision for the
// operator, and one they can make; narrowing after the fact cannot un-expose a
// file that was briefly world-readable.
const receivedFileMode os.FileMode = 0o600

// receivedDirMode matches: directories created for a received tree are private
// to the receiving user.
const receivedDirMode os.FileMode = 0o700

// ensureDirWithin creates every missing component between root and dir, refusing
// to traverse anything that is not a real directory.
//
// Deliberately NOT os.MkdirAll. MkdirAll follows an existing symlinked component
// — a pre-planted `inbox/photos -> /etc` is enough to have it happily create
// `/etc/2026` — and it discovers that only afterwards, if at all. Here each
// component is Lstat'ed BEFORE it is descended into, so a symlink is seen as a
// symlink and refused, and anything that exists but is not a directory (a file,
// a FIFO, a device node) is refused too. Components that do not exist are
// created fresh, and a freshly created directory cannot be a symlink.
func ensureDirWithin(root, dir string) error {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	absDir, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	if absDir == absRoot {
		return nil
	}
	rel, err := filepath.Rel(absRoot, absDir)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("%w: %v is outside the receive directory", ErrDirectoryUnavailable, dir)
	}
	cur := absRoot
	for _, comp := range strings.Split(rel, string(filepath.Separator)) {
		if comp == "" || comp == "." {
			continue
		}
		cur = filepath.Join(cur, comp)
		fi, err := os.Lstat(cur)
		switch {
		case err == nil:
			if fi.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("%w: refusing to write through a symlinked directory", ErrDirectoryUnavailable)
			}
			if !fi.IsDir() {
				return fmt.Errorf("%w: a non-directory occupies a directory in the destination path", ErrDirectoryUnavailable)
			}
		case errors.Is(err, os.ErrNotExist):
			if mkErr := os.Mkdir(cur, receivedDirMode); mkErr != nil && !errors.Is(mkErr, os.ErrExist) {
				return mkErr
			}
			// A concurrent creator may have won the race; re-check that what is
			// there now is a real directory rather than assuming our Mkdir shaped
			// it.
			fi, err := os.Lstat(cur)
			if err != nil {
				return err
			}
			if fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
				return fmt.Errorf("%w: destination directory was replaced during the commit", ErrDirectoryUnavailable)
			}
		default:
			return err
		}
	}
	return nil
}

// commitOne links one staged file into its planned destination with no-replace
// semantics, and reports whether the destination now holds THIS task's bytes.
//
// The EEXIST branch is the crash-recovery core. If the destination exists and
// the staged source still exists, os.SameFile decides the question the directory
// alone cannot answer: a hard link shares an inode with its source, so SameFile
// true means "this is the link I made before I crashed" — idempotent, finish the
// bookkeeping. SameFile false means somebody else's file is at that name, which
// is never overwritten and never merged; the task stops for a human.
func commitOne(staged, dest string) error {
	err := os.Link(staged, dest)
	if err == nil {
		// The link is only durable once its parent directory entry is.
		return fsyncDir(filepath.Dir(dest))
	}
	if errors.Is(err, syscall.EXDEV) {
		// Staging lives inside the receive directory precisely so this cannot
		// happen; it means a separate filesystem is mounted underneath. Copying
		// instead would give up the atomic no-replace guarantee, so this stops
		// and says exactly what is wrong.
		return fmt.Errorf("%w: a separate filesystem is mounted inside the receive directory, "+
			"which this device cannot commit into atomically", ErrDirectoryUnavailable)
	}
	if !errors.Is(err, os.ErrExist) {
		return err
	}
	si, serr := os.Lstat(staged)
	di, derr := os.Lstat(dest)
	if serr == nil && derr == nil && sameFile(si, di) {
		return fsyncDir(filepath.Dir(dest))
	}
	return fmt.Errorf("%w", ErrDestinationOccupied)
}

// Committer applies a journalled plan to disk and keeps the journal in step.
type Committer struct {
	Store   *JournalStore
	Root    string
	Now     func() time.Time
	Staging string
	// BeforeEach is an optional lease guard. It runs before every not-yet-
	// committed destination so a long multi-file commit cannot continue after
	// central has reassigned the task.
	BeforeEach func() error
}

// Commit places every planned destination, resuming a partially committed task
// without duplicating a file and without ever overwriting one.
//
// The per-file order is fixed and is the whole recovery argument:
//
//	link -> fsync the destination directory -> journal it -> remove the staged source
//
// Crash after the link: the source survives, SameFile proves ownership, the
// journal catches up. Crash after the journal: the entry is skipped and the
// stale source is cleaned. There is no ordering in which a destination exists
// that the journal cannot account for, and none in which a file is written twice.
func (c *Committer) Commit(j *Journal) error {
	for _, e := range j.Plan {
		if j.IsCommitted(e.Dest) {
			// Already durably placed. Drop any staged source left by a crash
			// between the journal write and the unlink.
			_ = os.Remove(c.stagedPath(e))
			continue
		}
		if c.BeforeEach != nil {
			if err := c.BeforeEach(); err != nil {
				return err
			}
		}
		if err := ensureDirWithin(c.Root, filepath.Dir(e.Dest)); err != nil {
			return err
		}
		if err := commitOne(c.stagedPath(e), e.Dest); err != nil {
			return err
		}
		j.Committed = append(j.Committed, e.Dest)
		if err := c.Store.Save(j, c.Now()); err != nil {
			// The destination exists but is unrecorded. That is recoverable (the
			// SameFile branch above), so surface the error rather than pressing
			// on and losing the ordering guarantee for the remaining files.
			return err
		}
		_ = os.Remove(c.stagedPath(e))
	}
	j.Completed = true
	j.CompletedAt = c.Now().Unix()
	if err := c.Store.Save(j, c.Now()); err != nil {
		return err
	}
	c.cleanStaging()
	return nil
}

// stagedPath is where a plan entry's verified bytes wait. Staged files are named
// by manifest INDEX, never by the manifest's own name: the staging area is
// created and consumed entirely by this package, so it has no reason to contain
// attacker-influenced names, and giving it none removes the whole class of
// question about what is safe to create there.
func (c *Committer) stagedPath(e PlanEntry) string {
	return filepath.Join(c.Staging, fmt.Sprintf("%d.part", e.Index))
}

// cleanStaging removes the per-task staging area. Best effort: a leftover
// staging directory is inert (0700, inside a dot-directory) and is cleaned by
// the next run, whereas failing a completed commit over it would be a false
// negative on work that actually succeeded.
func (c *Committer) cleanStaging() {
	if c.Staging == "" {
		return
	}
	_ = os.RemoveAll(c.Staging)
}

// PrepareStaging creates a fresh, private staging directory for a task.
//
// An existing staging directory from an earlier attempt is REMOVED rather than
// reused: its contents were never verified as a whole (that only happens once
// the entire authenticated stream has been consumed), so treating them as a
// starting point would be exactly the "apparently complete unverified file"
// this design exists to prevent.
func PrepareStaging(root, taskID string) (string, error) {
	if err := validTaskID(taskID); err != nil {
		return "", err
	}
	base := filepath.Join(root, stagingDirName)
	// The staging parent is inside a directory the user controls, so it is
	// checked the same way any destination directory is: no symlink, no
	// non-directory.
	if err := ensureDirWithin(root, base); err != nil {
		return "", err
	}
	if err := os.Chmod(base, receivedDirMode); err != nil {
		return "", err
	}
	dir := filepath.Join(base, taskID)
	if err := os.RemoveAll(dir); err != nil {
		return "", err
	}
	if err := os.Mkdir(dir, receivedDirMode); err != nil {
		return "", err
	}
	return dir, nil
}
