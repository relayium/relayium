package cloud

import (
	"bytes"
	"crypto/rand"
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

	"github.com/relayium/relayium/internal/storecrypto"
)

// Durable upload operations.
//
// `relayium up` is a single POST whose answer can be lost after the server has
// stored the upload (a gateway error, a dropped connection, a confirmation that
// cannot be read). The link is made of the server's id and a key that exists
// only on this machine, so a lost answer used to mean an upload that counts
// against the account and that nobody can ever open.
//
// Before the request is sent, the operation is recorded here: the
// Idempotency-Key the request carries, the content key, the exact retention
// parameters and body length, and the server and account it belongs to. When
// the outcome is unknown, `relayium up --recover <id>` asks the server about
// that same key WITHOUT sending a body again (RecoverUpload), and rebuilds the
// link from the server's id and the recorded key. Nothing is ever encrypted or
// uploaded a second time from a record.
//
// The record holds a secret (the content key), so it lives beside the
// credential in the private configuration directory, owner-only, written
// atomically, and is never printed. It is deleted when the outcome is known:
// the link was printed, the server proved the object gone, or the request
// definitely failed before the server could have stored anything.

// UpOperation is one recorded upload.
type UpOperation struct {
	Version      int    `json:"version"`
	ID           string `json:"id"`
	Server       string `json:"server"`
	Account      string `json:"account"`
	OpKey        string `json:"opKey"`
	ContentKey   string `json:"contentKey"`
	Burn         bool   `json:"burn,omitempty"`
	TTLSeconds   int64  `json:"ttlSeconds,omitempty"`
	MaxDownloads int64  `json:"maxDownloads,omitempty"`
	BodyLength   int64  `json:"bodyLength"`
	// FileCount and TotalBytes summarize what was uploaded, for `up --pending`.
	// File names are deliberately not recorded: recovery never re-reads,
	// re-encrypts or re-sends anything, and a summary keeps every record small
	// enough to always load back (maxUpRecord).
	FileCount  int   `json:"fileCount"`
	TotalBytes int64 `json:"totalBytes"`
	CreatedAt  int64 `json:"createdAt"`
}

// Opts are the retention options recorded with the operation.
func (o UpOperation) Opts() UploadOpts {
	return UploadOpts{Burn: o.Burn, TTLSeconds: o.TTLSeconds, MaxDownloads: o.MaxDownloads}
}

const upOperationVersion = 1

// upJournalDirName is the directory under the configuration directory.
const upJournalDirName = "up-operations"

// maxUpRecord bounds a record, on save and on load alike: a record that saves
// must load. Real records are a few hundred bytes.
const maxUpRecord = 16 << 10

// ErrUpOperationTooLarge means the record would exceed maxUpRecord; it is
// refused before anything is written or sent.
var ErrUpOperationTooLarge = errors.New("the upload operation record would be too large to keep; nothing was sent")

var (
	ErrUpOperationNotFound = errors.New("no such upload operation on this machine")
	ErrUpOperationCorrupt  = errors.New("the upload operation record is unreadable or malformed; it was left in place")
	ErrUpOperationUnsafe   = errors.New("the upload operation record is not a private file owned by this user; it was left in place and not used")
	ErrUpOperationBusy     = errors.New("another relayium process is working on this upload operation")
)

var (
	upIDPattern    = regexp.MustCompile(`^[0-9a-f]{32}$`)
	upOpKeyPattern = regexp.MustCompile(`^relayium-up\.[0-9a-f]{32}$`)
)

// ValidUpOperationID reports whether id has the form NewUpOperation produces.
func ValidUpOperationID(id string) bool { return upIDPattern.MatchString(id) }

// UpJournalDir is the directory holding operation records for cfgDir.
func UpJournalDir(cfgDir string) string { return filepath.Join(cfgDir, upJournalDirName) }

// NewUpOperation records a prepared upload for server and account. It returns
// the record, not yet saved.
func NewUpOperation(p *PreparedUpload, server, account string, now int64) (UpOperation, error) {
	id, err := randomHex(16)
	if err != nil {
		return UpOperation{}, err
	}
	k, err := randomHex(16)
	if err != nil {
		return UpOperation{}, err
	}
	o := p.Opts()
	return UpOperation{
		Version: upOperationVersion, ID: id,
		Server: strings.TrimRight(server, "/"), Account: account,
		OpKey: "relayium-up." + k, ContentKey: p.Key(),
		Burn: o.Burn, TTLSeconds: o.TTLSeconds, MaxDownloads: o.MaxDownloads,
		BodyLength: p.BodyLength, FileCount: len(p.files), TotalBytes: p.total, CreatedAt: now,
	}, nil
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (o UpOperation) validate() error {
	if o.Version != upOperationVersion || !upIDPattern.MatchString(o.ID) || !upOpKeyPattern.MatchString(o.OpKey) {
		return ErrUpOperationCorrupt
	}
	if k, err := storecrypto.DecodeKey(o.ContentKey); err != nil || len(k) != 32 {
		return ErrUpOperationCorrupt
	}
	if o.Server == "" || o.Account == "" || o.BodyLength <= 0 || o.TTLSeconds < 0 || o.MaxDownloads < 0 {
		return ErrUpOperationCorrupt
	}
	if o.FileCount < 0 || o.FileCount > storecrypto.MaxFiles || o.TotalBytes < 0 || o.TotalBytes > storecrypto.MaxSafeInteger || o.TotalBytes > o.BodyLength {
		return ErrUpOperationCorrupt
	}
	return nil
}

// ensureJournalDir creates (or checks) the private journal directory: a real
// directory, not a symbolic link, owned by this user.
func ensureJournalDir(cfgDir string) (string, error) {
	dir := UpJournalDir(cfgDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !ownedPrivately(info) {
		return "", ErrUpOperationUnsafe
	}
	return dir, nil
}

// SaveUpOperation writes o atomically: a private temporary file is written,
// flushed to disk and renamed over the record, and the directory is synced, so
// a crash leaves either no record or a complete one.
func SaveUpOperation(cfgDir string, o UpOperation) error {
	if err := o.validate(); err != nil {
		return err
	}
	dir, err := ensureJournalDir(cfgDir)
	if err != nil {
		return err
	}
	// The record is the only copy of the content key, and the caller sends
	// the upload only after this returns. So the checkpoint must be able to
	// make itself durable BEFORE anything is written: a journal directory that
	// cannot even be opened for its sync is refused here, not discovered after.
	if err := journalDirSyncable(dir); err != nil {
		return err
	}
	b, err := json.Marshal(o)
	if err != nil {
		return err
	}
	// Checked before anything is written: a record that could not be loaded
	// back would hold the only copy of a key nobody could use.
	if len(b) > maxUpRecord {
		return ErrUpOperationTooLarge
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			_ = tmp.Close()
			_ = os.Remove(name)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	final := filepath.Join(dir, o.ID+".json")
	if err := os.Rename(name, final); err != nil {
		return err
	}
	ok = true
	// The rename is durable only once the directory is synced. If that fails,
	// the checkpoint failed: the new record is withdrawn (best effort) and the
	// error returned, so the caller sends nothing. Other records are untouched.
	if err := journalDirSync(dir); err != nil {
		_ = os.Remove(final)
		return fmt.Errorf("upload operation record could not be made durable (directory sync failed: %w); nothing was sent", err)
	}
	return nil
}

// ErrJournalNotDurable means the journal directory cannot be synced, so a
// record written there could not be made durable.
var ErrJournalNotDurable = errors.New("the upload operation journal directory cannot be synced, so a record there could not be made durable; nothing was sent")

// LoadUpOperation reads the record id. It refuses a record that is not a
// private regular file owned by this user, and one that does not parse or
// validate exactly; in every refusal the file is left as it is.
func LoadUpOperation(cfgDir, id string) (UpOperation, error) {
	if !upIDPattern.MatchString(id) {
		return UpOperation{}, ErrUpOperationNotFound
	}
	p := filepath.Join(UpJournalDir(cfgDir), id+".json")
	info, err := os.Lstat(p)
	if errors.Is(err, os.ErrNotExist) {
		return UpOperation{}, ErrUpOperationNotFound
	}
	if err != nil {
		return UpOperation{}, err
	}
	if !info.Mode().IsRegular() || !ownedPrivately(info) {
		return UpOperation{}, ErrUpOperationUnsafe
	}
	f, err := openNoFollow(p)
	if err != nil {
		return UpOperation{}, err
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || !os.SameFile(st, info) {
		return UpOperation{}, ErrUpOperationUnsafe
	}
	b, err := io.ReadAll(io.LimitReader(f, maxUpRecord+1))
	if err != nil {
		return UpOperation{}, err
	}
	if len(b) > maxUpRecord {
		return UpOperation{}, ErrUpOperationCorrupt
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var o UpOperation
	if err := dec.Decode(&o); err != nil {
		return UpOperation{}, ErrUpOperationCorrupt
	}
	// Exactly one JSON value: anything after it but whitespace -- a second
	// value, or a stray closing delimiter that Decoder.More would not report
	// -- makes the record corrupt.
	if _, err := dec.Token(); err != io.EOF {
		return UpOperation{}, ErrUpOperationCorrupt
	}
	if err := o.validate(); err != nil || o.ID != id {
		return UpOperation{}, ErrUpOperationCorrupt
	}
	return o, nil
}

// RemoveUpOperation deletes the record (and its lock file). A record that is
// already gone is not an error.
func RemoveUpOperation(cfgDir, id string) error {
	if !upIDPattern.MatchString(id) {
		return ErrUpOperationNotFound
	}
	dir := UpJournalDir(cfgDir)
	err := os.Remove(filepath.Join(dir, id+".json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_ = os.Remove(filepath.Join(dir, id+".lock"))
	syncDir(dir)
	return nil
}

// UpOperationSummary describes a pending operation without its secrets.
type UpOperationSummary struct {
	ID        string `json:"id"`
	Server    string `json:"server"`
	Account   string `json:"account"`
	Files     int    `json:"files"`
	Bytes     int64  `json:"bytes"`
	CreatedAt int64  `json:"createdAt"`
	Problem   string `json:"problem,omitempty"`
}

// ListUpOperations lists the recorded operations, oldest first. A record that
// cannot be used is listed with its problem rather than skipped.
func ListUpOperations(cfgDir string) ([]UpOperationSummary, error) {
	entries, err := os.ReadDir(UpJournalDir(cfgDir))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []UpOperationSummary
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ".json")
		if !ok || !upIDPattern.MatchString(id) {
			continue
		}
		o, err := LoadUpOperation(cfgDir, id)
		if err != nil {
			out = append(out, UpOperationSummary{ID: id, Problem: err.Error()})
			continue
		}
		s := UpOperationSummary{ID: id, Server: o.Server, Account: o.Account, Files: o.FileCount, Bytes: o.TotalBytes, CreatedAt: o.CreatedAt}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out, nil
}

// LockUpOperation takes the exclusive per-operation lock, or returns
// ErrUpOperationBusy. The lock is released by the kernel if the holder dies.
func LockUpOperation(cfgDir, id string) (*UpLock, error) {
	if !upIDPattern.MatchString(id) {
		return nil, ErrUpOperationNotFound
	}
	dir, err := ensureJournalDir(cfgDir)
	if err != nil {
		return nil, err
	}
	return lockFile(filepath.Join(dir, id+".lock"))
}
