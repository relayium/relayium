package inboxsend

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"

	"github.com/relayium/relayium/internal/inboxsend/sendlock"
)

// journalStore is the send record directory under one config dir:
//
//	<config-dir>/inbox-send/   0700
//
// EVERY operation — send, retry, discard, listing and collection alike —
// first proves the directory is safe and then works only through a
// descriptor of the directory it proved (openDir): the config dir and the
// record directory must be real directories (not symbolic links) owned by
// this user that nobody else can write into, and the directory opened must be
// the very one inspected. Names inside it are resolved against that
// descriptor (os.Root), never by re-walking the path, and a file is used only
// when an Lstat through the same descriptor shows a regular file that is the
// file opened. So a directory swapped for a symbolic link, or made writable
// by others, is refused before anything is read, written, locked, chmod'ed,
// removed or sent — and nothing outside it is ever touched.
type journalStore struct{ cfg, dir string }

func newJournalStore(cfgDir string) journalStore {
	return journalStore{cfg: cfgDir, dir: filepath.Join(cfgDir, journalDirName)}
}

// Names inside the directory.
func journalName(id string) string { return id + ".json" }
func lockName(id string) string    { return "." + id + ".lock" }

// Paths, for messages and tests only: no operation walks them.
func (s journalStore) path(id string) string     { return filepath.Join(s.dir, journalName(id)) }
func (s journalStore) lockPath(id string) string { return filepath.Join(s.dir, lockName(id)) }

// errNoDir: the record directory does not exist (and was not to be created).
var errNoDir = errors.New("no send record directory")

// syncRootDir fsyncs the directory behind r. A variable so a test can make the
// step after a rename fail.
var syncRootDir = func(r *os.Root) error {
	d, err := r.Open(".")
	if err != nil {
		if fsyncDirUnsupported {
			return nil
		}
		return err
	}
	defer d.Close()
	if err := d.Sync(); err != nil && !fsyncDirUnsupported {
		return err
	}
	return nil
}

// openDir proves the directory safe and opens it. create makes it (0700)
// when it does not exist; otherwise a missing directory is errNoDir.
func (s journalStore) openDir(create bool) (*os.Root, error) {
	cfi, err := os.Lstat(s.cfg)
	if err != nil {
		return nil, fmt.Errorf("the configuration directory: %w", err)
	}
	if err := checkDirInfo(cfi); err != nil {
		return nil, fmt.Errorf("the configuration directory %v", err)
	}
	fi, err := os.Lstat(s.dir)
	if errors.Is(err, os.ErrNotExist) {
		if !create {
			return nil, errNoDir
		}
		if err := os.Mkdir(s.dir, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		fi, err = os.Lstat(s.dir)
	}
	if err != nil {
		return nil, err
	}
	if err := checkDirInfo(fi); err != nil {
		return nil, fmt.Errorf("the send record directory %v", err)
	}
	r, err := os.OpenRoot(s.dir)
	if err != nil {
		return nil, err
	}
	d, err := r.Open(".")
	if err != nil {
		r.Close()
		return nil, err
	}
	defer d.Close()
	opened, err := d.Stat()
	if err != nil || !os.SameFile(fi, opened) {
		r.Close()
		return nil, errors.New("the send record directory changed while it was being opened")
	}
	if err := closeDir(d, opened); err != nil {
		r.Close()
		return nil, err
	}
	return r, nil
}

// openRegular opens name inside r only if it is a regular file (never a
// symbolic link) and is the file an Lstat through r showed.
func openRegularIn(r *os.Root, name string, flag int) (*os.File, error) {
	fi, err := r.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", name)
	}
	f, err := r.OpenFile(name, flag, 0)
	if err != nil {
		return nil, err
	}
	got, err := f.Stat()
	if err != nil || !os.SameFile(fi, got) {
		f.Close()
		return nil, fmt.Errorf("%s changed while it was being opened", name)
	}
	return f, nil
}

// ensure creates and proves the directory.
func (s journalStore) ensure() error {
	r, err := s.openDir(true)
	if err != nil {
		return err
	}
	return r.Close()
}

// exists reports whether a record for id is present, without creating
// anything. An unsafe directory is an error, not "absent".
func (s journalStore) exists(id string) (bool, error) {
	if !ValidLocalSendID(id) {
		return false, nil
	}
	r, err := s.openDir(false)
	if errors.Is(err, errNoDir) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer r.Close()
	_, err = r.Lstat(journalName(id))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// fileLock is the per-send lock held while one command works on one record.
// It excludes other processes on Unix and Windows alike (see sendlock).
type fileLock struct{ l *sendlock.Lock }

func (f *fileLock) release() {
	if f != nil {
		f.l.Release()
	}
}

var errLocked = sendlock.ErrLocked

// lock takes the per-send lock. errLocked means another command holds it.
func (s journalStore) lock(id string) (*fileLock, error) {
	if !ValidLocalSendID(id) {
		return nil, errors.New("invalid local send id")
	}
	r, err := s.openDir(true)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	name := lockName(id)
	if fi, err := r.Lstat(name); err == nil && !fi.Mode().IsRegular() {
		return nil, errors.New("the lock file is not a regular file")
	}
	f, err := r.OpenFile(name, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if fi, err := r.Lstat(name); err != nil || !fi.Mode().IsRegular() {
		f.Close()
		return nil, errors.New("the lock file is not a regular file")
	} else if got, err := f.Stat(); err != nil || !os.SameFile(fi, got) {
		f.Close()
		return nil, errors.New("the lock file changed while it was being opened")
	}
	l, err := sendlock.AcquireFile(f)
	if err != nil {
		return nil, err
	}
	return &fileLock{l: l}, nil
}

// createTemp creates a new 0600 file named prefix+random inside r, never
// following or replacing anything.
func createTemp(r *os.Root, prefix string) (*os.File, string, error) {
	for range 16 {
		suffix, err := newRandomHex()
		if err != nil {
			return nil, "", err
		}
		name := prefix + suffix[:12]
		f, err := r.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return nil, "", err
		}
		return f, name, nil
	}
	return nil, "", errors.New("cannot create a temporary file")
}

// save writes j durably: temp file + fsync + rename + directory fsync, 0600.
func (s journalStore) save(j *Journal) error {
	_, err := s.saveReporting(j)
	return err
}

// saveReporting is save, also saying whether the record reached its final
// name. A failure with renamed true is AMBIGUOUS: the new record is visible
// now and may or may not survive a crash, so whatever it refers to must be
// kept.
func (s journalStore) saveReporting(j *Journal) (renamed bool, err error) {
	if err := j.validate(); err != nil {
		return false, err
	}
	b, err := json.Marshal(j)
	if err != nil {
		return false, err
	}
	r, err := s.openDir(true)
	if err != nil {
		return false, err
	}
	defer r.Close()
	tmp, tmpName, err := createTemp(r, "."+j.ID+".tmp-")
	if err != nil {
		return false, err
	}
	defer r.Remove(tmpName)
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return false, err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return false, err
	}
	if err := tmp.Close(); err != nil {
		return false, err
	}
	if err := r.Rename(tmpName, journalName(j.ID)); err != nil {
		return false, err
	}
	return true, syncRootDir(r)
}

// errNoJournal means no journal exists under that id.
var errNoJournal = errors.New("no such local send")

// load reads and validates one journal.
func (s journalStore) load(id string) (*Journal, error) {
	if !ValidLocalSendID(id) {
		return nil, errNoJournal
	}
	r, err := s.openDir(false)
	if errors.Is(err, errNoDir) {
		return nil, errNoJournal
	}
	if err != nil {
		return nil, err
	}
	defer r.Close()
	if _, err := r.Lstat(journalName(id)); errors.Is(err, os.ErrNotExist) {
		return nil, errNoJournal
	}
	f, err := openRegularIn(r, journalName(id), os.O_RDONLY)
	if err != nil {
		return nil, fmt.Errorf("journal: %w", err)
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxJournalBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxJournalBytes {
		return nil, errors.New("journal is too large")
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var j Journal
	if err := dec.Decode(&j); err != nil {
		return nil, errors.New("journal is not a valid record")
	}
	// The record must be the whole file. Decoder.More is not an end-of-input
	// test (it reports false before a stray `]` or `}`), so a second Decode
	// must find nothing but whitespace: exactly io.EOF.
	if err := dec.Decode(new(json.RawMessage)); err != io.EOF {
		return nil, errors.New("journal has trailing data")
	}
	if err := j.validate(); err != nil {
		return nil, err
	}
	if j.ID != id {
		return nil, errors.New("journal id does not match its file name")
	}
	return &j, nil
}

// remove deletes a journal and its lock file.
func (s journalStore) remove(id string) error {
	if !ValidLocalSendID(id) {
		return errNoJournal
	}
	r, err := s.openDir(false)
	if errors.Is(err, errNoDir) {
		return nil
	}
	if err != nil {
		return err
	}
	defer r.Close()
	if err := r.Remove(journalName(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_ = r.Remove(lockName(id))
	return syncRootDir(r)
}

// ids lists the local send ids present, sorted. A directory that does not
// exist is an empty list, not an error, and is not created; an unsafe one is
// an error.
func (s journalStore) ids() ([]string, error) {
	r, err := s.openDir(false)
	if errors.Is(err, errNoDir) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer r.Close()
	ents, err := readDirIn(r)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range ents {
		if m := journalFileRe.FindStringSubmatch(e.Name()); m != nil && e.Type().IsRegular() {
			out = append(out, m[1])
		}
	}
	sort.Strings(out)
	return out, nil
}

func readDirIn(r *os.Root) ([]os.DirEntry, error) {
	d, err := r.Open(".")
	if err != nil {
		return nil, err
	}
	defer d.Close()
	return d.ReadDir(-1)
}
