package inboxclient

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"time"
)

// The per-task crash journal.
//
// WHAT IT IS FOR. Central knows a task's state, but only this machine knows what
// it did to its own disk. Between "the ciphertext verified" and "every file is
// committed" there are as many crash windows as there are files, and after a
// crash the directory alone cannot answer "did I create that, or did the user?".
// The journal is the record that makes each of those windows recoverable without
// ever overwriting and without ever reporting a false `saved`.
//
// THE ORDERING CONTRACT, which the rest of this package depends on:
//
//  1. The plan is journalled (durably) BEFORE the first destination exists.
//  2. Each destination is linked, its directory is fsynced, and only THEN is it
//     appended to Committed and the journal fsynced. A crash between the link
//     and the journal append leaves a destination whose staged source still
//     exists — and os.SameFile proves it was ours, because a hard link shares an
//     inode with its source.
//  3. The staged source is removed only after the journal records the commit, so
//     the evidence outlives the ambiguity.
//  4. Completed is set only when every planned destination is committed. `saved`
//     is reported only from Completed, so a lost report retries into an
//     idempotent no-op rather than a second delivery.
//
// It is a local secret: it contains manifest file names and absolute
// destinations, so it lives at 0600 inside the 0700 state directory and nothing
// in it is ever logged or sent to central.

const journalVersion = 1

// JournalRetention bounds how long a finished receipt is kept. It outlives the
// server's own terminal-row retention (inbox.TerminalTaskRetention, 7 days) so a
// duplicate delivery attempt for a task this device already saved is still
// recognised from local evidence alone.
const JournalRetention = 30 * 24 * time.Hour

// Journal is one task's durable local record.
type Journal struct {
	Version      int    `json:"version"`
	TaskID       string `json:"taskId"`
	StoredFileID string `json:"storedFileId"`
	TargetKeyID  string `json:"targetKeyId"`
	// Root is the receive directory the plan was computed against. A task
	// journalled for one directory must never be resumed into another: the
	// planned destinations would be meaningless there.
	Root    string `json:"root"`
	Staging string `json:"staging"`
	// Plan is the complete, ordered set of destinations this task may create.
	// Fixed at planning time and never recomputed for a resumed task.
	Plan   []PlanEntry `json:"plan"`
	PlanAt int64       `json:"planAt"`
	// Committed lists destinations already durably in place, in plan order.
	Committed []string `json:"committed"`
	// Completed means every planned destination is committed. It is the ONLY
	// basis on which `saved` is reported.
	Completed bool `json:"completed"`
	// SavedReported records that central acknowledged the commit, so a receipt
	// is not retried forever after the task has left the queue.
	SavedReported bool  `json:"savedReported"`
	CompletedAt   int64 `json:"completedAt"`
	UpdatedAt     int64 `json:"updatedAt"`
}

// IsCommitted reports whether dest is already recorded as committed.
func (j *Journal) IsCommitted(dest string) bool { return slices.Contains(j.Committed, dest) }

// JournalStore holds the per-task journals in dir (0700).
type JournalStore struct{ dir string }

// NewJournalStore roots a journal store at dir.
func NewJournalStore(dir string) *JournalStore { return &JournalStore{dir: dir} }

// Dir returns the journal directory.
func (s *JournalStore) Dir() string { return s.dir }

// ErrBadTaskID rejects a task id that could not safely become a file name.
var ErrBadTaskID = errors.New("relayium inbox: refusing to use this task id as a file name")

// validTaskID bounds a central-issued id to characters that are inert in a path.
// Central mints these itself, so this can never fire in practice — which is
// exactly why it is here: the journal turns a remote string into a local file
// name, and that conversion must not depend on a remote invariant staying true.
func validTaskID(id string) error {
	if id == "" || len(id) > 64 {
		return ErrBadTaskID
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		ok := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_'
		if !ok {
			return ErrBadTaskID
		}
	}
	return nil
}

func (s *JournalStore) path(taskID string) (string, error) {
	if err := validTaskID(taskID); err != nil {
		return "", err
	}
	return filepath.Join(s.dir, taskID+".json"), nil
}

// Load returns the journal for taskID. found is false when this device has never
// started the task, which is the normal first-delivery case.
func (s *JournalStore) Load(taskID string) (j Journal, found bool, err error) {
	p, err := s.path(taskID)
	if err != nil {
		return Journal{}, false, err
	}
	b, rerr := os.ReadFile(p)
	if errors.Is(rerr, os.ErrNotExist) {
		return Journal{}, false, nil
	}
	if rerr != nil {
		return Journal{}, false, rerr
	}
	if err := json.Unmarshal(b, &j); err != nil {
		return Journal{}, false, fmt.Errorf("relayium inbox: task journal is unreadable: %w", err)
	}
	if j.Version != journalVersion {
		return Journal{}, false, fmt.Errorf("relayium inbox: task journal is version %d, this build understands %d", j.Version, journalVersion)
	}
	return j, true, nil
}

// Save atomically replaces the journal and returns only once it is durable.
// Every caller depends on that: the whole recovery argument is that the record
// reaches stable storage before the action it describes becomes irreversible.
func (s *JournalStore) Save(j *Journal, now time.Time) error {
	p, err := s.path(j.TaskID)
	if err != nil {
		return err
	}
	j.Version = journalVersion
	j.UpdatedAt = now.Unix()
	b, err := json.MarshalIndent(j, "", "  ")
	if err != nil {
		return err
	}
	return writeSecretFile(p, b)
}

// Remove deletes a journal.
func (s *JournalStore) Remove(taskID string) error {
	p, err := s.path(taskID)
	if err != nil {
		return err
	}
	rerr := os.Remove(p)
	if errors.Is(rerr, os.ErrNotExist) {
		return nil
	}
	if rerr != nil {
		return rerr
	}
	return fsyncDir(s.dir)
}

// Prune deletes receipts whose work finished longer ago than JournalRetention.
// Only COMPLETED, reported journals are eligible: an unfinished one is the only
// record of an in-flight task's destination plan, and deleting it early would
// turn a resumable crash into an ambiguous directory.
func (s *JournalStore) Prune(now time.Time) error {
	entries, err := os.ReadDir(s.dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	cutoff := now.Add(-JournalRetention).Unix()
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		id := e.Name()[:len(e.Name())-len(".json")]
		j, found, err := s.Load(id)
		if err != nil || !found {
			continue
		}
		if j.Completed && j.SavedReported && j.UpdatedAt < cutoff {
			_ = s.Remove(id)
		}
	}
	return nil
}
