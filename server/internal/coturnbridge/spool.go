package coturnbridge

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/relayium/relayium/internal/coturnbridge/wire"
)

// Spool is the bridge's durable state: one JSON file per undelivered
// allocation, written atomically (temp file, fsync, rename, directory fsync).
//
// Two finite tiers hold allocation records in the same format: the primary
// directory (MaxEntries) and overflow/ (OverflowMaxEntries). A new key is
// assigned a tier once — primary while it has room, else overflow — and keeps
// it for its whole life: no migration, and no failover after a failed write
// (a write that failed after its rename may have committed where it was
// aimed). When both tiers are full a new key is refused (ErrSpoolFull) and
// the caller counts and alerts; nothing is held without bound.
//
// A file is removed only when its allocation is Done (terminal snapshot
// acknowledged with an accepted cumulative covering it). Refused allocations
// move to dead/ and stay there for an operator; unreadable files move to
// corrupt/. An allocation whose owner account was deleted (central: gone) is
// replaced by a mark in gone/ holding only the provider key and a time — no
// username, counters or receipt — kept for forgetSecs as a tombstone and as
// Drain's evidence. dead/, corrupt/ and gone/ are finite too: when one is
// full the original file stays where it is and the caller is told
// (ErrArchiveFull). Nothing is ever dropped silently.
//
// Open takes an exclusive lock on <Dir>/.lock before anything else in the
// directory is changed; Close releases it.
type Spool struct {
	Dir                string
	MaxEntries         int   // primary allocation records
	MaxBytes           int64 // largest single record accepted (read and write)
	OverflowMaxEntries int   // overflow/ allocation records (0: no overflow tier)
	DeadMaxEntries     int   // dead/ (0: defaultDeadMax)
	CorruptMaxEntries  int   // corrupt/ (0: defaultCorruptMax)
	CorruptMaxBytes    int64 // corrupt/ bytes (0: defaultCorruptMaxBytes)
	GoneMaxEntries     int   // gone/ (0: MaxEntries + OverflowMaxEntries)
	QuarantineMaxBytes int64 // quarantine.jsonl (0: defaultQuarantineMaxBytes); checked at Open

	fs   spoolFS
	lock *os.File

	files     map[AllocKey]*spoolEntry
	tiers     [2]TierUse
	diskKeys  [2]int // keys of each tier whose record is on disk
	dead      ClassUse
	corrupt   ClassUse
	gone      ClassUse
	quarBytes int64
	dups      []AllocKey
	// leftNames: file names of records left in place unloaded (unreadable,
	// or the same name in both tiers). A key whose record would take such a
	// name is never placed in either tier: its write would overwrite, or
	// conflict with, evidence awaiting an operator.
	leftNames map[string]bool
	// leftGone: names of unreadable gone marks left in place; never replaced.
	leftGone map[string]bool
	unloaded int // unreadable records left in place (corrupt/ full) or duplicates
	tmpGone  int // zero-length temp files removed at Open
	tmpKept  int // non-empty record temp files preserved (moved to corrupt/ or left)
	metaGone int // status (metadata) temp files removed at Open
	// heldTemps: non-empty temp files of earlier runs left in place at Open
	// (corrupt/ full or archive failed) — possibly unique evidence, kept.
	heldTemps int
	// stuck: this run's temp files whose removal failed. While any remains
	// (each new temp first retries removing them) no new temp is created.
	stuck map[string]bool
}

// tempHoldMax bounds earlier-run temp files held in place: at the limit no
// new temp file is created, so writes fail closed instead of piling up temps.
const tempHoldMax = 8

// ErrTempHeld: a new temporary file is refused because earlier temp files
// cannot be cleaned up (this run's removal failed, or too many earlier-run
// temps are held in place). Writes fail closed; nothing is deleted.
var ErrTempHeld = errors.New("coturnbridge: temporary files cannot be cleaned up: no new temporary file is created")

// createTemp is the only way the spool creates a temp file.
func (s *Spool) createTemp(dir, prefix string) (spoolFile, error) {
	for p := range s.stuck {
		if err := s.fsys().Remove(p); err == nil || errors.Is(err, os.ErrNotExist) {
			delete(s.stuck, p)
		}
	}
	if n := len(s.stuck); n > 0 {
		return nil, fmt.Errorf("%w: %d temporary file(s) of this run could not be removed", ErrTempHeld, n)
	}
	if s.heldTemps >= tempHoldMax {
		return nil, fmt.Errorf("%w: %d temporary files of earlier runs are held in place (limit %d; corrupt/ full or archiving failed): operator",
			ErrTempHeld, s.heldTemps, tempHoldMax)
	}
	return s.fsys().CreateTemp(dir, prefix+"*")
}

// dropTemp removes this run's temp file p; if that fails p is tracked and
// blocks new temps until a later retry removes it. Only temps this run
// created (copies of state it still holds, or of a file already linked into
// place) are removed this way.
func (s *Spool) dropTemp(p string) {
	if err := s.fsys().Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		if s.stuck == nil {
			s.stuck = map[string]bool{}
		}
		s.stuck[p] = true
	}
}

// Temps reports earlier-run temps held in place and this run's temps that
// could not be removed.
func (s *Spool) Temps() (held, stuck int) { return s.heldTemps, len(s.stuck) }

// Tier indexes.
const (
	TierPrimary  = 0
	TierOverflow = 1
)

// TierUse is one allocation tier's exact use: Keys counts every key assigned
// to the tier (on disk or reserved), Files the records on disk (including
// unreadable ones left in place), Bytes their sizes.
type TierUse struct {
	Keys  int   `json:"keys"`
	Files int   `json:"files"`
	Bytes int64 `json:"bytes"`
}

// ClassUse is an archive directory's exact use.
type ClassUse struct {
	Files int   `json:"files"`
	Bytes int64 `json:"bytes"`
}

type spoolEntry struct {
	tier   int
	size   int64
	onDisk bool
}

const (
	defaultDeadMax         = 10000
	defaultCorruptMax      = 1000
	defaultCorruptMaxBytes = 64 << 20
	defaultQuarantineMax   = 256 << 20
)

// ErrSpoolFull is returned when a new allocation cannot be given a place in
// either tier, or quarantine evidence would exceed its cap.
var ErrSpoolFull = errors.New("coturnbridge: spool full")

// ErrArchiveFull is returned when dead/, corrupt/ or gone/ is at its cap: the
// original record is kept where it is.
var ErrArchiveFull = errors.New("coturnbridge: spool archive full")

// ErrKeyBlocked: a record with the key's file name was left in place
// unloaded (awaiting an operator); the key is not placed in either tier.
var ErrKeyBlocked = errors.New("coturnbridge: a record with this key's name awaits an operator")

// ErrSpoolLocked: another process holds the spool.
var ErrSpoolLocked = errors.New("coturnbridge: spool is locked by another process")

// ErrSpoolOverLimit: the spool on disk holds more than the configured limits
// allow; nothing was loaded or changed.
var ErrSpoolOverLimit = errors.New("coturnbridge: spool holds more than the configured limits")

const (
	spoolExt   = ".alloc.json"
	tmpPrefix  = ".tmp-"
	overflowSD = "overflow"
	// statusTmpPrefix marks temp files of metadata (status.json): never
	// financial evidence, removed at Open. It also starts with tmpPrefix so
	// an older binary's scans treat it as a temp file.
	statusTmpPrefix = ".tmp-status-"
	// deadReasonMax bounds the reason stored with a dead letter (raw bytes;
	// JSON may encode each byte as up to 6, e.g. \u0001 or \ufffd).
	deadReasonMax = 1024
	// deadLetterOverhead bounds the JSON envelope of a dead letter.
	deadLetterOverhead = 64
	// archiveNameTries bounds the search for a free unique archive name.
	archiveNameTries = 10000
	// legacyStatusMaxRead bounds how much of a legacy temp file is read to
	// recognise an old status.json temp.
	legacyStatusMaxRead = 8 << 20
)

func (s *Spool) deadMax() int {
	if s.DeadMaxEntries > 0 {
		return s.DeadMaxEntries
	}
	return defaultDeadMax
}

func (s *Spool) corruptMax() int {
	if s.CorruptMaxEntries > 0 {
		return s.CorruptMaxEntries
	}
	return defaultCorruptMax
}

func (s *Spool) corruptMaxBytes() int64 {
	if s.CorruptMaxBytes > 0 {
		return s.CorruptMaxBytes
	}
	return defaultCorruptMaxBytes
}

func (s *Spool) quarantineMax() int64 {
	if s.QuarantineMaxBytes > 0 {
		return s.QuarantineMaxBytes
	}
	return defaultQuarantineMax
}

func (s *Spool) goneMax() int {
	if s.GoneMaxEntries > 0 {
		return s.GoneMaxEntries
	}
	return s.MaxEntries + s.OverflowMaxEntries
}

func (s *Spool) tierMax(t int) int {
	if t == TierOverflow {
		return s.OverflowMaxEntries
	}
	return s.MaxEntries
}

func (s *Spool) tierDir(t int) string {
	if t == TierOverflow {
		return filepath.Join(s.Dir, overflowSD)
	}
	return s.Dir
}

func (s *Spool) fsys() spoolFS {
	if s.fs == nil {
		return osFS{}
	}
	return s.fs
}

// Open creates the spool directories (0700), takes the lock, takes one
// inventory of every directory, refuses (ErrSpoolOverLimit, nothing changed)
// when more records are on disk than the limits allow, and then tidies
// temporary files: an empty one is removed, a non-empty one — never renamed
// into place, so never a delivered record, but possibly evidence — is moved
// to corrupt/ or, if corrupt/ is full, left and counted.
func (s *Spool) Open() error { return s.open(nil) }

// open is Open with a preflight run while the lock is held and before
// anything else in the directory is created, inventoried, refused, moved or
// removed (the bridge reads and validates the previous status there, so no
// other writer can still change it). A preflight error releases the lock.
func (s *Spool) open(preflight func() error) error {
	if s.lock != nil {
		return errors.New("coturnbridge: spool already open")
	}
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	lk, err := lockDir(s.Dir)
	if err != nil {
		return err
	}
	s.lock = lk
	ok := false
	defer func() {
		if !ok {
			s.Close()
		}
	}()
	if preflight != nil {
		if err := preflight(); err != nil {
			return err
		}
	}
	for _, d := range []string{s.tierDir(TierOverflow), filepath.Join(s.Dir, "dead"), filepath.Join(s.Dir, "corrupt"), filepath.Join(s.Dir, "gone")} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	s.files = map[AllocKey]*spoolEntry{}
	s.leftNames = map[string]bool{}
	s.leftGone = map[string]bool{}
	s.stuck = map[string]bool{}
	s.heldTemps = 0
	s.tiers = [2]TierUse{}
	s.diskKeys = [2]int{}
	s.dead, s.corrupt, s.gone = ClassUse{}, ClassUse{}, ClassUse{}
	var tmps []string
	scan := func(dir string, onFile func(name string, size int64)) error {
		ents, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, e := range ents {
			if e.IsDir() {
				continue
			}
			if strings.HasPrefix(e.Name(), tmpPrefix) {
				tmps = append(tmps, filepath.Join(dir, e.Name()))
				continue
			}
			fi, err := e.Info()
			if err != nil {
				return err
			}
			onFile(e.Name(), fi.Size())
		}
		return nil
	}
	for t := range 2 {
		if err := scan(s.tierDir(t), func(name string, size int64) {
			if strings.HasSuffix(name, spoolExt) {
				s.tiers[t].Files++
				s.tiers[t].Bytes += size
			}
		}); err != nil {
			return err
		}
	}
	for _, c := range []struct {
		sub string
		u   *ClassUse
	}{{"dead", &s.dead}, {"corrupt", &s.corrupt}, {"gone", &s.gone}} {
		u := c.u
		if err := scan(filepath.Join(s.Dir, c.sub), func(_ string, size int64) { u.Files++; u.Bytes += size }); err != nil {
			return err
		}
	}
	if fi, err := os.Stat(filepath.Join(s.Dir, "quarantine.jsonl")); err == nil {
		s.quarBytes = fi.Size()
	}
	// Every class is checked before any temp tidy, archive move or removal:
	// records and evidence are exactly as found (only the lock file and
	// missing empty directories may have been created).
	var over []string
	for _, c := range []struct {
		have, limit int64
		what, flag  string
	}{
		{int64(s.tiers[TierPrimary].Files), int64(s.MaxEntries), "primary records", "-spool-max-entries"},
		{int64(s.tiers[TierOverflow].Files), int64(s.OverflowMaxEntries), "overflow records", "-spool-overflow-max-entries"},
		{int64(s.gone.Files), int64(s.goneMax()), "gone marks", "-spool-gone-max-entries"},
		{int64(s.dead.Files), int64(s.deadMax()), "dead letters", "-spool-dead-max-entries"},
		{int64(s.corrupt.Files), int64(s.corruptMax()), "corrupt/ files", "-spool-corrupt-max-entries"},
		{s.corrupt.Bytes, s.corruptMaxBytes(), "corrupt/ bytes", "-spool-corrupt-max-bytes"},
		{s.quarBytes, s.quarantineMax(), "quarantine.jsonl bytes", "-quarantine-max-bytes"},
	} {
		if c.have > c.limit {
			over = append(over, fmt.Sprintf("%d %s (limit %s %d)", c.have, c.what, c.flag, c.limit))
		}
	}
	if len(over) > 0 {
		return fmt.Errorf("%w: %s; records and evidence were left unchanged (only the lock file and missing empty directories may "+
			"have been created): restart with each named limit at least the count shown", ErrSpoolOverLimit, strings.Join(over, ", "))
	}
	for _, p := range tmps {
		fi, err := os.Lstat(p)
		if err != nil {
			return err
		}
		meta := strings.HasPrefix(filepath.Base(p), statusTmpPrefix)
		if !meta && fi.Mode().IsRegular() && fi.Size() > 0 && filepath.Dir(p) == filepath.Clean(s.Dir) {
			meta = isLegacyStatusTemp(p, fi.Size())
		}
		switch {
		case meta && fi.Mode().IsRegular():
			if err := s.fsys().Remove(p); err != nil {
				return err
			}
			s.metaGone++
		case fi.Mode().IsRegular() && fi.Size() == 0:
			if err := s.fsys().Remove(p); err != nil {
				return err
			}
			s.tmpGone++
		default:
			// A record temp never renamed into place: never delivered, but
			// possibly the only copy of evidence. Preserved, never deleted.
			s.tmpKept++
			prefix := "tmp-"
			if filepath.Dir(p) != filepath.Clean(s.Dir) {
				prefix += filepath.Base(filepath.Dir(p)) + "-"
			}
			archived := false
			if s.corrupt.Files < s.corruptMax() && s.corrupt.Bytes+fi.Size() <= s.corruptMaxBytes() {
				// Counted once linked, even if the original could not be
				// removed (then both copies exist; the original is retried
				// at the next start under a further unique name).
				dst, merr := s.archiveMove(p, filepath.Join(s.Dir, "corrupt"), prefix+strings.TrimPrefix(filepath.Base(p), tmpPrefix))
				if dst != "" {
					s.corrupt.Files++
					s.corrupt.Bytes += fi.Size()
				}
				archived = merr == nil
			}
			if !archived {
				// Still in place: held, and counted against tempHoldMax.
				s.heldTemps++
			}
		}
	}
	ok = true
	return nil
}

// isLegacyStatusTemp: before statusTmpPrefix existed, status.json was written
// through the same ".tmp-" prefix as records. A leftover that decodes
// strictly as a Status (and not as an allocation record) is metadata.
func isLegacyStatusTemp(p string, size int64) bool {
	if size > legacyStatusMaxRead {
		return false // too large to sniff: preserved as evidence instead
	}
	b, err := readBounded(p, legacyStatusMaxRead)
	if err != nil {
		return false
	}
	var st Status
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if dec.Decode(&st) != nil || st.UpdatedUnix <= 0 {
		return false
	}
	var a Alloc
	dec = json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	return dec.Decode(&a) != nil
}

// archiveMove moves src into dir under base, or base.1, base.2, … — the
// first name that does not exist. The new name is created with link(2),
// which fails rather than replacing an existing file, so earlier evidence is
// never overwritten; src is removed only after the link exists. A crash
// between the two leaves both names (a duplicate copy, never a loss).
func (s *Spool) archiveMove(src, dir, base string) (string, error) {
	for i := range archiveNameTries {
		dst := filepath.Join(dir, base)
		if i > 0 {
			dst += "." + strconv.Itoa(i)
		}
		err := os.Link(src, dst)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if err := s.fsys().SyncDir(dir); err != nil {
			return dst, err
		}
		if err := s.fsys().Remove(src); err != nil {
			return dst, err
		}
		return dst, s.fsys().SyncDir(filepath.Dir(src))
	}
	return "", fmt.Errorf("coturnbridge: no free archive name for %s in %s", base, dir)
}

// writeNoReplace writes b durably under a unique name in dir (base, base.1,
// …), never replacing an existing file: temp file, fsync, link to the free
// name, remove the temp, fsync the directory.
func (s *Spool) writeNoReplace(dir, base string, b []byte) (string, error) {
	f, err := s.createTemp(dir, tmpPrefix)
	if err != nil {
		return "", err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		if !ok {
			f.Close()
			s.dropTemp(tmp)
		}
	}()
	if err := f.Chmod(0o600); err != nil {
		return "", err
	}
	if _, err := f.Write(b); err != nil {
		return "", err
	}
	if err := f.Sync(); err != nil {
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	ok = true
	dst, err := s.archiveMove(tmp, dir, base)
	if err != nil {
		// Not linked (dst ""), or linked but the directory sync or the temp
		// removal failed: the temp is this run's copy; drop it (tracked and
		// blocking new temps if that fails too).
		s.dropTemp(tmp)
	}
	return dst, err
}

// Close releases the lock. The Spool must not be used afterwards.
func (s *Spool) Close() error {
	if s.lock == nil {
		return nil
	}
	err := s.lock.Close()
	s.lock = nil
	return err
}

func (s *Spool) name(k AllocKey) string {
	sum := sha256.Sum256([]byte(k.String()))
	return hex.EncodeToString(sum[:16]) + spoolExt
}

// Load returns every persisted allocation of both tiers. A file that does
// not decode, or whose snapshot does not validate, is moved to corrupt/ (or,
// with corrupt/ full, left in place and not loaded) and reported. A key found
// in both tiers is a conflict: both files are kept, neither is loaded, and
// the key is listed by Duplicates so the caller can block it.
func (s *Spool) Load(alert func(string, ...any)) ([]*Alloc, error) {
	if s.files == nil {
		return nil, errors.New("coturnbridge: spool not open")
	}
	var out []*Alloc
	names := [2]map[string]bool{{}, {}}
	for t := range 2 {
		ents, err := os.ReadDir(s.tierDir(t))
		if err != nil {
			return nil, err
		}
		for _, e := range ents {
			if !e.IsDir() && strings.HasSuffix(e.Name(), spoolExt) {
				names[t][e.Name()] = true
			}
		}
	}
	for t := range 2 {
		for n := range names[t] {
			p := filepath.Join(s.tierDir(t), n)
			fi, err := os.Lstat(p)
			if err != nil {
				return nil, err
			}
			if t == TierPrimary && names[TierOverflow][n] {
				if a, err := s.read(p); err == nil {
					s.dups = append(s.dups, a.Key)
				}
				alert("ALERT spool record %s exists in both tiers: both kept, neither loaded or delivered (operator)", n)
				s.unloaded += 2
				s.leftNames[n] = true
				continue
			}
			if t == TierOverflow && names[TierPrimary][n] {
				continue // counted with its primary twin
			}
			a, err := s.read(p)
			if err != nil {
				base := n
				if t == TierOverflow {
					base = overflowSD + "-" + n
				}
				if s.corrupt.Files >= s.corruptMax() || s.corrupt.Bytes+fi.Size() > s.corruptMaxBytes() {
					alert("ALERT spool file %s unreadable (%v) and corrupt/ is full: left in place, not loaded (operator)", n, err)
					s.unloaded++
					s.leftNames[n] = true
					continue
				}
				dst, merr := s.archiveMove(p, filepath.Join(s.Dir, "corrupt"), base)
				if dst != "" {
					s.corrupt.Files++
					s.corrupt.Bytes += fi.Size()
				}
				switch {
				case merr == nil:
					alert("ALERT spool file %s unreadable (%v): moved to corrupt/%s", n, err, filepath.Base(dst))
					s.tiers[t].Files--
					s.tiers[t].Bytes -= fi.Size()
				case dst != "":
					// Linked into corrupt/ but the original could not be
					// removed: both copies exist and are counted.
					alert("ALERT spool file %s unreadable (%v): copied to corrupt/%s, original not removed (%v): left in place, not loaded", n, err, filepath.Base(dst), merr)
					s.unloaded++
					s.leftNames[n] = true
				default:
					alert("ALERT spool file %s unreadable (%v): could not be archived (%v): left in place, not loaded", n, err, merr)
					s.unloaded++
					s.leftNames[n] = true
				}
				continue
			}
			s.files[a.Key] = &spoolEntry{tier: t, size: fi.Size(), onDisk: true}
			s.tiers[t].Keys++
			s.diskKeys[t]++
			out = append(out, a)
		}
	}
	return out, nil
}

// Duplicates returns the keys found in both tiers by Load.
func (s *Spool) Duplicates() []AllocKey { return s.dups }

func (s *Spool) read(p string) (*Alloc, error) {
	fi, err := os.Stat(p)
	if err != nil {
		return nil, err
	}
	if fi.Size() > s.MaxBytes {
		return nil, fmt.Errorf("%d bytes exceeds %d", fi.Size(), s.MaxBytes)
	}
	b, err := readBounded(p, s.MaxBytes) // the file may have grown since the stat
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

// Count lists both tier directories and returns the number of allocation
// record files on disk: the disk's own answer, independent of the cached
// accounting (operators and tests; O(N), never on the write path — Put uses
// the cached accounting). Safe to call concurrently with the bridge.
func (s *Spool) Count() (int, error) {
	n := 0
	for t := range 2 {
		ents, err := os.ReadDir(s.tierDir(t))
		if err != nil {
			if t == TierOverflow && os.IsNotExist(err) {
				continue
			}
			return 0, err
		}
		for _, e := range ents {
			if !e.IsDir() && strings.HasSuffix(e.Name(), spoolExt) {
				n++
			}
		}
	}
	return n, nil
}

// Use returns the exact use of both tiers and the archives.
func (s *Spool) Use() (tiers [2]TierUse, dead, corrupt, gone ClassUse, quarantineBytes int64) {
	return s.tiers, s.dead, s.corrupt, s.gone, s.quarBytes
}

// Unloaded reports unreadable or duplicate records left in place, and the
// temp files Open removed (empty record temps, status temps) or preserved.
func (s *Spool) Unloaded() (unloaded, tmpRemoved, tmpPreserved, metaRemoved int) {
	return s.unloaded, s.tmpGone, s.tmpKept, s.metaGone
}

// room reports whether tier t can take one more key. Unreadable records and
// duplicates left in place occupy their tier's files.
func (s *Spool) room(t int) bool {
	u := s.tiers[t]
	inUse := u.Keys + (u.Files - s.onDiskKeys(t))
	return inUse < s.tierMax(t)
}

// onDiskKeys: keys of tier t whose record is on disk. Kept implicitly:
// Files counts every record file, Keys every assigned key; the difference
// between Files and on-disk keys is records that are not keys (unloaded).
func (s *Spool) onDiskKeys(t int) int { return s.diskKeys[t] }

// Reserve assigns k a tier (primary first) if it has none, or returns
// ErrSpoolFull. The assignment is final for k's life.
func (s *Spool) Reserve(k AllocKey) (int, error) {
	if e, ok := s.files[k]; ok {
		return e.tier, nil
	}
	if s.leftNames[s.name(k)] {
		return 0, ErrKeyBlocked
	}
	for t := range 2 {
		if s.room(t) {
			s.files[k] = &spoolEntry{tier: t}
			s.tiers[t].Keys++
			return t, nil
		}
	}
	return 0, ErrSpoolFull
}

// TierOf returns k's tier and whether its record is on disk.
func (s *Spool) TierOf(k AllocKey) (tier int, onDisk, ok bool) {
	e, ok := s.files[k]
	if !ok {
		return 0, false, false
	}
	return e.tier, e.onDisk, true
}

// Release drops the reservation of a key whose record was never written.
func (s *Spool) Release(k AllocKey) {
	if e, ok := s.files[k]; ok && !e.onDisk {
		delete(s.files, k)
		s.tiers[e.tier].Keys--
	}
}

func (s *Spool) setOnDisk(e *spoolEntry, size int64) {
	if !e.onDisk {
		e.onDisk = true
		s.tiers[e.tier].Files++
		s.diskKeys[e.tier]++
		e.size = 0
	}
	s.tiers[e.tier].Bytes += size - e.size
	e.size = size
}

// Put persists a atomically in its tier (assigned now if new: ErrSpoolFull
// when neither tier has room). An existing record is always replaced. Only a
// nil error means the record is durable. After a failed write the target is
// inspected only to keep the accounting exact: a failure after the rename
// may have left the new file in place, which is counted but still reported
// as an error (not durable as far as the caller may assume).
func (s *Spool) Put(a *Alloc) error {
	if s.files == nil {
		return errors.New("coturnbridge: spool not open")
	}
	if _, err := s.Reserve(a.Key); err != nil {
		return err
	}
	e := s.files[a.Key]
	b, err := json.Marshal(a)
	if err != nil {
		return err
	}
	if int64(len(b)) > s.MaxBytes {
		return fmt.Errorf("coturnbridge: record for %s is %d bytes", a.Key, len(b))
	}
	dir := s.tierDir(e.tier)
	p := filepath.Join(dir, s.name(a.Key))
	if err := s.writeAtomic(dir, p, b); err != nil {
		if fi, serr := os.Lstat(p); serr == nil {
			s.setOnDisk(e, fi.Size())
		}
		return err
	}
	s.setOnDisk(e, int64(len(b)))
	return nil
}

// Remove deletes k's record (it is Done) and forgets its tier.
func (s *Spool) Remove(k AllocKey) error {
	e, ok := s.files[k]
	if !ok {
		return nil
	}
	if !e.onDisk {
		s.Release(k)
		return nil
	}
	dir := s.tierDir(e.tier)
	err := s.fsys().Remove(filepath.Join(dir, s.name(k)))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	s.dropEntry(k, e)
	return s.fsys().SyncDir(dir)
}

func (s *Spool) dropEntry(k AllocKey, e *spoolEntry) {
	delete(s.files, k)
	s.tiers[e.tier].Keys--
	if e.onDisk {
		s.tiers[e.tier].Files--
		s.diskKeys[e.tier]--
		s.tiers[e.tier].Bytes -= e.size
	}
}

// DeadLetter moves a's record to dead/ (refused by central, or ceiling
// clamped): kept for an operator, never resent automatically. With dead/ full
// it returns ErrArchiveFull and the live record stays.
func (s *Spool) DeadLetter(a *Alloc, reason string) error {
	if s.dead.Files >= s.deadMax() {
		return ErrArchiveFull
	}
	if len(reason) > deadReasonMax {
		reason = reason[:deadReasonMax]
	}
	rec := struct {
		Reason string `json:"reason"`
		Alloc  *Alloc `json:"alloc"`
	}{reason, a}
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	// A unique, never-replacing name: an earlier dead letter of the same key
	// (another run, another refusal) stays intact.
	dst, err := s.writeNoReplace(filepath.Join(s.Dir, "dead"), s.name(a.Key), b)
	if dst != "" {
		s.dead.Files++
		s.dead.Bytes += int64(len(b))
	}
	if err != nil {
		return err
	}
	return s.Remove(a.Key)
}

// writeAtomic writes b to path via a synced temp file and rename, then syncs
// the directory so the rename itself is durable.
func (s *Spool) writeAtomic(dir, path string, b []byte) error {
	return s.writeAtomicPrefix(dir, path, b, tmpPrefix)
}

func (s *Spool) writeAtomicPrefix(dir, path string, b []byte, prefix string) error {
	fsys := s.fsys()
	f, err := s.createTemp(dir, prefix)
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		if !ok {
			f.Close()
			s.dropTemp(tmp)
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
	if err := fsys.Rename(tmp, path); err != nil {
		return err
	}
	ok = true
	return fsys.SyncDir(dir)
}

// writeMeta writes a metadata file (status.json) atomically through the
// status temp prefix: its leftovers are never mistaken for evidence.
func (s *Spool) writeMeta(path string, b []byte) error {
	return s.writeAtomicPrefix(filepath.Dir(path), path, b, statusTmpPrefix)
}

// AppendQuarantine appends one JSON line of quarantined evidence to
// quarantine.jsonl. The file never exceeds maxBytes: a line that would cross
// it is refused (ErrSpoolFull) whole.
func (s *Spool) AppendQuarantine(v any, maxBytes int64) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	p := filepath.Join(s.Dir, "quarantine.jsonl")
	if s.quarBytes+int64(len(b)) > maxBytes {
		return ErrSpoolFull
	}
	f, err := s.fsys().OpenAppend(p)
	if err != nil {
		return err
	}
	_, werr := f.Write(b)
	if werr == nil {
		werr = f.Sync()
	}
	cerr := f.Close()
	if fi, err := os.Stat(p); err == nil {
		s.quarBytes = fi.Size()
	}
	if werr != nil {
		return werr
	}
	return cerr
}

// GoneMark is the only trace of an allocation whose owner was deleted: the
// provider key and when central answered gone.
type GoneMark struct {
	Key    AllocKey `json:"key"`
	AtUnix int64    `json:"atUnix"`
}

// MarkGone writes k's gone mark (durable) and only then removes its record,
// so a user-linked record never outlives a missing mark. A crash between the
// two leaves both; Load's caller treats the mark as authoritative. With gone/
// full it returns ErrArchiveFull and the record stays.
func (s *Spool) MarkGone(k AllocKey, at int64) error {
	if s.gone.Files >= s.goneMax() {
		return ErrArchiveFull
	}
	if s.leftGone[s.name(k)] {
		return ErrKeyBlocked // an unreadable mark of this name awaits an operator: never replaced
	}
	b, err := json.Marshal(GoneMark{Key: k, AtUnix: at})
	if err != nil {
		return err
	}
	dir := filepath.Join(s.Dir, "gone")
	p := filepath.Join(dir, s.name(k))
	_, existed := os.Lstat(p)
	if err := s.writeAtomic(dir, p, b); err != nil {
		if existed != nil {
			if _, serr := os.Lstat(p); serr == nil {
				s.gone.Files++
				s.gone.Bytes += int64(len(b))
			}
		}
		return err
	}
	if existed != nil {
		s.gone.Files++
		s.gone.Bytes += int64(len(b))
	}
	return s.Remove(k)
}

// LoadGone returns every gone mark (key → time). An unreadable mark is moved
// to corrupt/ (or left in place if corrupt/ is full) and reported.
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
		// The size decides before anything is read: an oversized mark is
		// never loaded into memory (its archive decision uses its real size).
		fi, err := os.Lstat(p)
		if err != nil {
			return nil, err
		}
		size := fi.Size()
		if !fi.Mode().IsRegular() {
			err = errors.New("not a regular file")
		} else if size > goneMarkMaxBytes {
			err = fmt.Errorf("oversized (%d bytes, limit %d)", size, goneMarkMaxBytes)
		} else {
			var b []byte
			if b, err = readBounded(p, goneMarkMaxBytes); err == nil {
				dec := json.NewDecoder(strings.NewReader(string(b)))
				dec.DisallowUnknownFields()
				err = dec.Decode(&m)
			}
		}
		if err == nil && (!m.Key.Epoch.Valid() || !wire.ValidSessionID(m.Key.SessionID) || s.name(m.Key) != e.Name()) {
			err = errors.New("invalid key")
		}
		if err != nil {
			if s.corrupt.Files < s.corruptMax() && s.corrupt.Bytes+size <= s.corruptMaxBytes() {
				dst, merr := s.archiveMove(p, filepath.Join(s.Dir, "corrupt"), "gone-"+e.Name())
				if dst != "" {
					s.corrupt.Files++
					s.corrupt.Bytes += size
				}
				if merr == nil {
					alert("ALERT gone mark %s unreadable (%v): moved to corrupt/%s", e.Name(), err, filepath.Base(dst))
					s.gone.Files--
					s.gone.Bytes -= size
				} else {
					alert("ALERT gone mark %s unreadable (%v): not fully archived (%v): left in place", e.Name(), err, merr)
					s.unloaded++
					s.leftGone[e.Name()] = true
				}
			} else {
				alert("ALERT gone mark %s unreadable (%v) and corrupt/ is full: left in place (operator)", e.Name(), err)
				s.unloaded++
				s.leftGone[e.Name()] = true
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
	p := filepath.Join(dir, s.name(k))
	fi, statErr := os.Lstat(p)
	if err := s.fsys().Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if statErr == nil {
		s.gone.Files--
		s.gone.Bytes -= fi.Size()
	}
	return s.fsys().SyncDir(dir)
}
