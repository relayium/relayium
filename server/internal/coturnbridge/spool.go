package coturnbridge

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/relayium/relayium/internal/coturnbridge/wire"
)

// Spool is the bridge's durable state: one JSON file per undelivered
// allocation, written atomically (temp file, fsync, rename, directory fsync).
// A file is removed only when its allocation is Done (terminal snapshot
// acknowledged with an accepted cumulative covering it). Refused allocations
// move to dead/ and stay there for an operator; unreadable files move to
// corrupt/. An allocation whose owner account was deleted (central: gone) is
// replaced by a mark in gone/ holding only the provider key and a time — no
// username, counters or receipt — kept for forgetSecs as a tombstone and as
// Drain's evidence. Nothing is ever dropped silently.
type Spool struct {
	Dir        string
	MaxEntries int   // live files in Dir
	MaxBytes   int64 // largest single file
}

// ErrSpoolFull is returned when a new allocation cannot be persisted because
// the spool holds MaxEntries files. The allocation stays in memory and is
// retried on the next flush; the caller alerts.
var ErrSpoolFull = errors.New("coturnbridge: spool full")

const spoolExt = ".alloc.json"

// Open creates the spool directories (0700).
func (s *Spool) Open() error {
	for _, d := range []string{s.Dir, filepath.Join(s.Dir, "dead"), filepath.Join(s.Dir, "corrupt"), filepath.Join(s.Dir, "gone")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	return nil
}

func (s *Spool) name(k AllocKey) string {
	sum := sha256.Sum256([]byte(k.String()))
	return hex.EncodeToString(sum[:16]) + spoolExt
}

// Load returns every persisted allocation. A file that does not decode, or
// whose snapshot does not validate, is moved to corrupt/ and reported.
func (s *Spool) Load(alert func(string, ...any)) ([]*Alloc, error) {
	ents, err := os.ReadDir(s.Dir)
	if err != nil {
		return nil, err
	}
	var out []*Alloc
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), spoolExt) {
			continue
		}
		p := filepath.Join(s.Dir, e.Name())
		a, err := s.read(p)
		if err != nil {
			alert("ALERT spool file %s unreadable (%v): moved to corrupt/", e.Name(), err)
			if err := os.Rename(p, filepath.Join(s.Dir, "corrupt", e.Name())); err != nil {
				return nil, err
			}
			continue
		}
		out = append(out, a)
	}
	return out, nil
}

func (s *Spool) read(p string) (*Alloc, error) {
	fi, err := os.Stat(p)
	if err != nil {
		return nil, err
	}
	if fi.Size() > s.MaxBytes {
		return nil, fmt.Errorf("%d bytes exceeds %d", fi.Size(), s.MaxBytes)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var a Alloc
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&a); err != nil {
		return nil, err
	}
	if !a.Key.Epoch.Valid() || !wire.ValidSessionID(a.Key.SessionID) || !wire.ValidUsername(a.Username) {
		return nil, errors.New("invalid key")
	}
	if filepath.Base(p) != s.name(a.Key) {
		return nil, errors.New("file name does not match its key")
	}
	if a.Snap != nil {
		if err := a.Snap.Validate(); err != nil {
			return nil, fmt.Errorf("snapshot: %w", err)
		}
		if a.Snap.SessionID != a.Key.SessionID || a.Snap.BootID != a.Key.Epoch.BootID ||
			a.Snap.PID != a.Key.Epoch.PID || a.Snap.StartTicks != a.Key.Epoch.StartTicks || a.Snap.Username != a.Username {
			return nil, errors.New("snapshot does not match its key")
		}
	}
	return &a, nil
}

// Count returns the number of live spool files.
func (s *Spool) Count() (int, error) {
	ents, err := os.ReadDir(s.Dir)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, e := range ents {
		if !e.IsDir() && strings.HasSuffix(e.Name(), spoolExt) {
			n++
		}
	}
	return n, nil
}

// Put persists a atomically. A new file is refused with ErrSpoolFull when the
// spool already holds MaxEntries files; an existing file is always replaced.
func (s *Spool) Put(a *Alloc) error {
	p := filepath.Join(s.Dir, s.name(a.Key))
	if _, err := os.Stat(p); errors.Is(err, os.ErrNotExist) {
		n, err := s.Count()
		if err != nil {
			return err
		}
		if n >= s.MaxEntries {
			return ErrSpoolFull
		}
	}
	b, err := json.Marshal(a)
	if err != nil {
		return err
	}
	if int64(len(b)) > s.MaxBytes {
		return fmt.Errorf("coturnbridge: record for %s is %d bytes", a.Key, len(b))
	}
	return writeAtomic(s.Dir, p, b)
}

// Remove deletes a's file (it is Done).
func (s *Spool) Remove(k AllocKey) error {
	err := os.Remove(filepath.Join(s.Dir, s.name(k)))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDir(s.Dir)
}

// DeadLetter moves a's record to dead/ (refused by central, or ceiling
// clamped): kept for an operator, never resent automatically.
func (s *Spool) DeadLetter(a *Alloc, reason string) error {
	rec := struct {
		Reason string `json:"reason"`
		Alloc  *Alloc `json:"alloc"`
	}{reason, a}
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	dead := filepath.Join(s.Dir, "dead")
	if err := writeAtomic(dead, filepath.Join(dead, s.name(a.Key)), b); err != nil {
		return err
	}
	return s.Remove(a.Key)
}

// writeAtomic writes b to path via a synced temp file and rename, then syncs
// the directory so the rename itself is durable.
func writeAtomic(dir, path string, b []byte) error {
	f, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		if !ok {
			f.Close()
			os.Remove(tmp)
		}
	}()
	if err := f.Chmod(0o600); err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	ok = true
	return syncDir(dir)
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// AppendQuarantine appends one JSON line of quarantined evidence to
// quarantine.jsonl, refusing (ErrSpoolFull) beyond maxBytes.
func (s *Spool) AppendQuarantine(v any, maxBytes int64) error {
	p := filepath.Join(s.Dir, "quarantine.jsonl")
	if fi, err := os.Stat(p); err == nil && fi.Size() >= maxBytes {
		return ErrSpoolFull
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(b, '\n')); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// GoneMark is the only trace of an allocation whose owner was deleted: the
// provider key and when central answered gone.
type GoneMark struct {
	Key    AllocKey `json:"key"`
	AtUnix int64    `json:"atUnix"`
}

// MarkGone writes k's gone mark and then removes its record. A crash between
// the two leaves both; LoadGone's caller treats the mark as authoritative.
func (s *Spool) MarkGone(k AllocKey, at int64) error {
	b, err := json.Marshal(GoneMark{Key: k, AtUnix: at})
	if err != nil {
		return err
	}
	dir := filepath.Join(s.Dir, "gone")
	if err := writeAtomic(dir, filepath.Join(dir, s.name(k)), b); err != nil {
		return err
	}
	return s.Remove(k)
}

// LoadGone returns every gone mark (key → time). An unreadable mark is moved
// to corrupt/ and reported.
func (s *Spool) LoadGone(alert func(string, ...any)) (map[AllocKey]int64, error) {
	dir := filepath.Join(s.Dir, "gone")
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := map[AllocKey]int64{}
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), spoolExt) {
			continue
		}
		p := filepath.Join(dir, e.Name())
		var m GoneMark
		b, err := os.ReadFile(p)
		if err == nil && len(b) <= 4096 {
			dec := json.NewDecoder(strings.NewReader(string(b)))
			dec.DisallowUnknownFields()
			err = dec.Decode(&m)
		} else if err == nil {
			err = errors.New("oversized")
		}
		if err == nil && (!m.Key.Epoch.Valid() || !wire.ValidSessionID(m.Key.SessionID) || s.name(m.Key) != e.Name()) {
			err = errors.New("invalid key")
		}
		if err != nil {
			alert("ALERT gone mark %s unreadable (%v): moved to corrupt/", e.Name(), err)
			if err := os.Rename(p, filepath.Join(s.Dir, "corrupt", "gone-"+e.Name())); err != nil {
				return nil, err
			}
			continue
		}
		out[m.Key] = m.AtUnix
	}
	return out, nil
}

// PruneGone removes the gone mark of k.
func (s *Spool) PruneGone(k AllocKey) error {
	dir := filepath.Join(s.Dir, "gone")
	if err := os.Remove(filepath.Join(dir, s.name(k))); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDir(dir)
}
