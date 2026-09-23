package inboxsend

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/relayium/relayium/internal/inbox"
	"github.com/relayium/relayium/internal/inboxsend/sendlock"
)

// The local send journal: the durable, NON-SECRET record that lets `inbox
// retry` finish a send whose command was interrupted, without encrypting and
// without uploading (invariant N3).
//
//	<config-dir>/inbox-send/<local-send-id>.json   0600, dir 0700
//
// It never contains the content key (N2). It does contain the wrapped key —
// the content key sealed to the target device, which only that device's
// private key can open and which central stores anyway — and the ids needed to
// complete or report the send. It lives beside the credential, not in the
// receiver's state directory, so `inbox disable` never touches it and a machine
// that never receives never creates receiver state.
//
// A journal is remote-controlled input only in the sense that anything on disk
// is: it is read through a bound, decoded strictly, and every field is
// validated before it is used — above all the server origin, which must equal
// the logged-in credential's server before the bearer is sent anywhere.

// Journal phases, in order.
const (
	PhasePlanned    = "planned"    // wrapped key sealed; no upload started (as far as we know)
	PhaseUploading  = "uploading"  // upload session opened; bytes may be committed
	PhaseFinalizing = "finalizing" // every byte acknowledged; finalize sent or about to be
	PhaseFinalized  = "finalized"  // stored object id known; the task may not exist yet
)

const (
	journalVersion  = 1
	journalDirName  = "inbox-send"
	maxJournalBytes = 16 << 10
)

var (
	localSendIDRe    = regexp.MustCompile(`^[0-9a-f]{32}$`)
	idempotencyKeyRe = regexp.MustCompile(`^cli-[0-9a-f]{32}$`)
	journalFileRe    = regexp.MustCompile(`^([0-9a-f]{32})\.json$`)
)

// Journal is one unfinished local send.
type Journal struct {
	V                   int    `json:"v"`
	ID                  string `json:"id"`
	Phase               string `json:"phase"`
	Server              string `json:"server"`
	AccountEmail        string `json:"accountEmail"`
	SourceDeviceID      string `json:"sourceDeviceId"`
	TargetDeviceID      string `json:"targetDeviceId"`
	TargetKeyID         string `json:"targetKeyId"`
	TargetKeyGeneration int64  `json:"targetKeyGeneration"`
	WrappedKey          string `json:"wrappedKey"`
	IdempotencyKey      string `json:"idempotencyKey"`
	TTL                 int64  `json:"ttl"`
	CiphertextBytes     int64  `json:"ciphertextBytes"`
	ManifestSHA256      string `json:"manifestSha256"`
	UploadID            string `json:"uploadId,omitempty"`
	StoredFileID        string `json:"storedFileId,omitempty"`
	ExpiresAt           int64  `json:"expiresAt,omitempty"`
	CreatedAt           int64  `json:"createdAt"`
}

// ValidLocalSendID reports whether id has the only spelling a local send id may
// have. Checked before the id is ever joined into a path.
func ValidLocalSendID(id string) bool { return localSendIDRe.MatchString(id) }

func newRandomHex() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func (j *Journal) validate() error {
	bad := func(what string) error { return fmt.Errorf("journal field %s is invalid", what) }
	switch {
	case j.V != journalVersion:
		return bad("v")
	case !ValidLocalSendID(j.ID):
		return bad("id")
	case j.Phase != PhasePlanned && j.Phase != PhaseUploading && j.Phase != PhaseFinalizing && j.Phase != PhaseFinalized:
		return bad("phase")
	case !isInertID(j.SourceDeviceID):
		return bad("sourceDeviceId")
	case !isInertID(j.TargetDeviceID):
		return bad("targetDeviceId")
	case !isInertID(j.TargetKeyID) || j.TargetKeyGeneration <= 0:
		return bad("target key")
	case !validWrappedKey(j.WrappedKey):
		return bad("wrappedKey")
	case !idempotencyKeyRe.MatchString(j.IdempotencyKey):
		return bad("idempotencyKey")
	case j.TTL < 0 || j.CiphertextBytes < 0 || j.CreatedAt <= 0 || j.ExpiresAt < 0:
		return bad("numbers")
	case len(j.ManifestSHA256) != 64 || strings.Trim(j.ManifestSHA256, "0123456789abcdef") != "":
		return bad("manifestSha256")
	case len(j.AccountEmail) > 320:
		return bad("accountEmail")
	}
	if s, err := ValidateServer(j.Server); err != nil || s != j.Server {
		return bad("server")
	}
	needUpload := j.Phase != PhasePlanned
	if needUpload != (j.UploadID != "") || (j.UploadID != "" && !isInertID(j.UploadID)) {
		return bad("uploadId")
	}
	needObject := j.Phase == PhaseFinalized
	if needObject != (j.StoredFileID != "") || (j.StoredFileID != "" && !isInertID(j.StoredFileID)) {
		return bad("storedFileId")
	}
	return nil
}

func validWrappedKey(s string) bool {
	if len(s) > inbox.MaxWrappedKeyLen {
		return false
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(s)
	return err == nil && len(raw) == inbox.SealedBoxBytes
}

// journalStore is the journal directory under one config dir.
type journalStore struct{ dir string }

func newJournalStore(cfgDir string) journalStore {
	return journalStore{dir: filepath.Join(cfgDir, journalDirName)}
}

func (s journalStore) path(id string) string { return filepath.Join(s.dir, id+".json") }
func (s journalStore) lockPath(id string) string {
	return filepath.Join(s.dir, "."+id+".lock")
}

func (s journalStore) ensure() error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	return os.Chmod(s.dir, 0o700)
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

func lockFile(path string) (*fileLock, error) {
	l, err := sendlock.Acquire(path)
	if err != nil {
		return nil, err
	}
	return &fileLock{l: l}, nil
}

// lock takes the per-send lock. errLocked means another command holds it.
func (s journalStore) lock(id string) (*fileLock, error) {
	if !ValidLocalSendID(id) {
		return nil, errors.New("invalid local send id")
	}
	if err := s.ensure(); err != nil {
		return nil, err
	}
	return lockFile(s.lockPath(id))
}

// save writes j durably: temp file + fsync + rename + directory fsync, 0600.
func (s journalStore) save(j *Journal) error {
	if err := j.validate(); err != nil {
		return err
	}
	b, err := json.Marshal(j)
	if err != nil {
		return err
	}
	if err := s.ensure(); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dir, "."+j.ID+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, s.path(j.ID)); err != nil {
		return err
	}
	return syncDir(s.dir)
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
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

// errNoJournal means no journal exists under that id.
var errNoJournal = errors.New("no such local send")

// load reads and validates one journal.
func (s journalStore) load(id string) (*Journal, error) {
	if !ValidLocalSendID(id) {
		return nil, errNoJournal
	}
	f, err := openNoFollow(s.path(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil, errNoJournal
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, errors.New("journal is not a regular file")
	}
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
	err := os.Remove(s.path(id))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_ = os.Remove(s.lockPath(id))
	return syncDir(s.dir)
}

// ids lists the local send ids present, sorted. A directory that does not
// exist is an empty list, not an error, and is not created.
func (s journalStore) ids() ([]string, error) {
	ents, err := os.ReadDir(s.dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
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
