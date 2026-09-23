package inboxsend

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/relayium/relayium/internal/termtext"
)

// Stage R: the local encrypted copy ("spool") of one `inbox send --resumable`.
//
//	<config-dir>/inbox-send/<local-send-id>.spool   0600, dir 0700
//
// The spool is the init body (uint32BE(len)||sealed manifest) followed by the
// complete upload body (every frame), exactly as they go on the wire. It is
// written by the single sealing pass BEFORE the upload is opened, fsynced, and
// its size and SHA-256 are journalled. From then on every byte this send ever
// uploads — in the first process and after any restart — is read from the
// spool, after the whole file was checked against that hash. So:
//
//   - N1/N3 hold unchanged: nothing is sealed after the spool is complete
//     (sealer.closeSealing), and a restarted process has no key at all;
//   - N2 holds: the spool is ciphertext only; the content key is in no file;
//   - N4 holds on restart too: a replayed byte is a copy of the one ciphertext,
//     never a re-read of a source file that may have changed since. Nothing
//     about the sources (size, mtime, inode) is consulted after spooling.
//
// Ownership: the record owns its spool. It is removed only after the record
// itself is gone (a finished or definitively failed send), by an explicit
// discard, or by expiry/orphan collection under the send's lock — never while
// a record that may still need it could not be written.

const (
	spoolSuffix = ".spool"
	// maxSpoolHeader bounds the init body: central refuses a sealed manifest
	// over 64 KiB.
	maxSpoolHeader = 4 + 64<<10
	// gcmTag is the manifest seal's overhead.
	gcmTag = 16
	// spoolReserve is free space left untouched after the spool is written, so
	// a resumable send never fills the disk the journal must still be written to.
	spoolReserve = 64 << 20
)

// maxSpoolBytes caps one spool. A variable so tests can lower it.
var maxSpoolBytes int64 = 16 << 30

// spoolMaxAge is when an unfinished spooled record's copy expires. An open
// upload session is reclaimed by central after about an hour without data, so
// a copy this old can rarely still be resumed, and it holds disk space.
const spoolMaxAge = 24 * time.Hour

var (
	spoolFileRe = regexp.MustCompile(`^([0-9a-f]{32})\.spool$`)
	spoolTempRe = regexp.MustCompile(`^\.([0-9a-f]{32})\.spool\.tmp-[0-9a-f]+$`)
)

var (
	errSpoolMissing = errors.New("the local encrypted copy is missing")
	errSpoolCorrupt = errors.New("the local encrypted copy does not match its record")
	// errSpoolRead is a read of a verified spool that failed mid-upload.
	errSpoolRead = errors.New("the local encrypted copy could not be read")
)

func (s journalStore) spoolPath(id string) string { return filepath.Join(s.dir, id+spoolSuffix) }
func spoolName(id string) string                  { return id + spoolSuffix }

// projectedSpoolBytes is the exact spool size for plan: the sealed manifest is
// its plaintext plus one GCM tag.
func projectedSpoolBytes(p *Plan) int64 {
	return 4 + int64(len(p.manifest)) + gcmTag + p.CiphertextBytes
}

// ensurePrivate refuses --resumable where this platform cannot keep a copy,
// and otherwise creates and proves the record directory like every other
// operation does (journalStore.openDir).
func (s journalStore) ensurePrivate() error {
	if !spoolSupported {
		return errors.New("resumable sends are not available on this platform")
	}
	return s.ensure()
}

// checkSpoolRoom refuses, before anything is encrypted, a spool larger than
// the cap or than the free space (minus a reserve) on its filesystem.
func (s journalStore) checkSpoolRoom(need int64) *Error {
	if need > maxSpoolBytes {
		return localf(CodeSpoolUnavailable, "--resumable keeps a local encrypted copy, and this delivery (%d bytes encrypted) "+
			"is larger than the %d-byte limit for one; send it without --resumable. Nothing was sent", need, maxSpoolBytes)
	}
	free, err := freeDiskBytes(s.dir)
	if err != nil {
		return localf(CodeSpoolUnavailable, "cannot tell how much disk space is free for the local encrypted copy (%s); "+
			"nothing was sent", termtext.Safe(err.Error()))
	}
	if free < uint64(need)+spoolReserve {
		return localf(CodeSpoolUnavailable, "--resumable needs %d bytes of free disk space in the configuration directory "+
			"for a local encrypted copy (plus %d spare), and only %d are free. Free some space or send without --resumable. "+
			"Nothing was sent", need, int64(spoolReserve), free)
	}
	return nil
}

// writeSpool writes the init body and then every frame next yields into a new
// spool for id, durably, and returns its size and SHA-256. The caller holds
// id's lock and id is fresh. On any failure nothing is left behind.
func (s journalStore) writeSpool(id string, encManifest []byte, want int64, next func() ([]byte, error)) (int64, string, error) {
	r, err := s.openDir(true)
	if err != nil {
		return 0, "", err
	}
	defer r.Close()
	tmp, tmpName, err := createTemp(r, "."+id+spoolSuffix+".tmp-")
	if err != nil {
		return 0, "", err
	}
	ok := false
	defer func() {
		if !ok {
			tmp.Close()
			r.Remove(tmpName)
		}
	}()
	h := sha256.New()
	bw := bufio.NewWriterSize(io.MultiWriter(tmp, h), 1<<20)
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(encManifest)))
	if _, err := bw.Write(hdr[:]); err != nil {
		return 0, "", err
	}
	if _, err := bw.Write(encManifest); err != nil {
		return 0, "", err
	}
	var body int64
	for {
		fr, err := next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return 0, "", err
		}
		body += int64(len(fr))
		if body > want {
			return 0, "", errSourceChanged
		}
		if _, err := bw.Write(fr); err != nil {
			return 0, "", err
		}
	}
	if body != want {
		return 0, "", errSourceChanged
	}
	if err := bw.Flush(); err != nil {
		return 0, "", err
	}
	if err := tmp.Sync(); err != nil {
		return 0, "", err
	}
	if err := tmp.Close(); err != nil {
		return 0, "", err
	}
	// The id is fresh and its lock is held, so nothing is at the final name.
	if err := r.Rename(tmpName, spoolName(id)); err != nil {
		return 0, "", err
	}
	ok = true
	if err := syncRootDir(r); err != nil {
		r.Remove(spoolName(id))
		return 0, "", err
	}
	return 4 + int64(len(encManifest)) + body, hex.EncodeToString(h.Sum(nil)), nil
}

// spoolFile is a verified spool, open for reading.
type spoolFile struct {
	f           *os.File
	encManifest []byte
	body        *io.SectionReader
}

func (sp *spoolFile) close() { _ = sp.f.Close() }

// openSpool opens the spool j names through the verified record directory —
// only a regular file, never a symbolic link — and proves it is the one the
// record describes: exactly the recorded size, a matching SHA-256 and a
// well-formed header. The same descriptor is then the only source of every
// uploaded byte.
func (s journalStore) openSpool(j *Journal) (*spoolFile, error) {
	r, err := s.openDir(false)
	if errors.Is(err, errNoDir) {
		return nil, errSpoolMissing
	}
	if err != nil {
		return nil, err
	}
	defer r.Close()
	if _, err := r.Lstat(spoolName(j.ID)); errors.Is(err, os.ErrNotExist) {
		return nil, errSpoolMissing
	}
	f, err := openRegularIn(r, spoolName(j.ID), os.O_RDONLY)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errSpoolCorrupt, err)
	}
	fail := func(err error) (*spoolFile, error) { f.Close(); return nil, err }
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() || fi.Size() != j.SpoolBytes {
		return fail(errSpoolCorrupt)
	}
	h := sha256.New()
	if _, err := io.Copy(h, io.NewSectionReader(f, 0, j.SpoolBytes)); err != nil {
		return fail(fmt.Errorf("%w: %v", errSpoolCorrupt, err))
	}
	if hex.EncodeToString(h.Sum(nil)) != j.SpoolSHA256 {
		return fail(errSpoolCorrupt)
	}
	hdr := make([]byte, j.HeaderBytes)
	if _, err := f.ReadAt(hdr, 0); err != nil || int64(binary.BigEndian.Uint32(hdr))+4 != j.HeaderBytes {
		return fail(errSpoolCorrupt)
	}
	return &spoolFile{f: f, encManifest: hdr[4:], body: io.NewSectionReader(f, j.HeaderBytes, j.CiphertextBytes)}, nil
}

// hasSpool reports whether id's spool is present (in a safe directory).
func (s journalStore) hasSpool(id string) (bool, error) {
	r, err := s.openDir(false)
	if errors.Is(err, errNoDir) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer r.Close()
	_, err = r.Lstat(spoolName(id))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// removeSpool deletes id's spool and any temporary copy of it, through the
// verified record directory. The caller holds id's lock.
func (s journalStore) removeSpool(id string) error {
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
	var first error
	if err := r.Remove(spoolName(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		first = err
	}
	if ents, err := readDirIn(r); err == nil {
		for _, e := range ents {
			if m := spoolTempRe.FindStringSubmatch(e.Name()); m != nil && m[1] == id {
				if err := r.Remove(e.Name()); err != nil && first == nil && !errors.Is(err, os.ErrNotExist) {
					first = err
				}
			}
		}
	}
	if err := syncRootDir(r); err != nil && first == nil {
		first = err
	}
	return first
}

// collectOrphanSpools removes spools (and temporary copies) that no record
// owns: a send killed between writing its copy and recording it, or a
// record removed by an earlier command that could not then remove its copy.
// Each is removed only under its id's lock, re-checking that no record
// appeared, so a send still writing its copy is never touched. A directory
// that is not safe is left alone entirely.
func (s journalStore) collectOrphanSpools() (removed []string) {
	r, err := s.openDir(false)
	if err != nil {
		return nil
	}
	ents, err := readDirIn(r)
	r.Close()
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	for _, e := range ents {
		id := ""
		if m := spoolFileRe.FindStringSubmatch(e.Name()); m != nil {
			id = m[1]
		} else if m := spoolTempRe.FindStringSubmatch(e.Name()); m != nil {
			id = m[1]
		}
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		if has, err := s.exists(id); has || err != nil {
			continue // a record owns it (or cannot be ruled out)
		}
		lk, err := s.lock(id)
		if err != nil {
			continue // a command is working on it right now
		}
		if has, err := s.exists(id); !has && err == nil && s.removeSpool(id) == nil {
			if r, err := s.openDir(false); err == nil {
				_ = r.Remove(lockName(id))
				r.Close()
			}
			removed = append(removed, id)
		}
		lk.release()
	}
	return removed
}

// spoolUpload pushes the spool body into uploadID from the server's offset
// from. Every byte comes from the verified spool, so any offset the server
// reports inside [0, total] can be continued from — a replay is a
// byte-identical copy — and nothing is ever sealed.
func spoolUpload(ctx context.Context, c *Client, uploadID string, chunk, total, from int64, body io.ReaderAt) error {
	if from < 0 || from > total {
		return errUploadDesync
	}
	pos := from
	failures := 0
	buf := make([]byte, min(chunk, max(total, 1)))
	adopt := func(n int64) error {
		if n < 0 || n > total {
			return errUploadDesync
		}
		if n > pos {
			failures = 0
		}
		pos = n
		return nil
	}
	retryable := func(err error) error {
		failures++
		if failures > uploadRetryBudget {
			return err
		}
		if serr := sleepCtx(ctx, uploadBackoff(failures-1)); serr != nil {
			return serr
		}
		n, serr := c.UploadStatus(ctx, uploadID)
		switch {
		case serr == nil:
			return adopt(n)
		case statusOf(serr) == http.StatusNotFound:
			return errUploadLost
		case isTransport(serr) || statusOf(serr) >= 500:
			return nil
		default:
			return serr
		}
	}
	for pos < total {
		n := min(chunk, total-pos)
		if _, err := body.ReadAt(buf[:n], pos); err != nil {
			return fmt.Errorf("%w: %v", errSpoolRead, err)
		}
		start := pos
		got, err := c.Append(ctx, uploadID, start, total, buf[:n])
		if ctx.Err() != nil {
			return ctx.Err()
		}
		switch {
		case err == nil:
			if aerr := adopt(got); aerr != nil {
				return aerr
			}
		case statusOf(err) == http.StatusConflict:
			var ae *APIError
			if !errors.As(err, &ae) || ae.Received < 0 {
				return err
			}
			if aerr := adopt(ae.Received); aerr != nil {
				return aerr
			}
		case statusOf(err) == http.StatusNotFound:
			return errUploadLost
		case isTransport(err) || statusOf(err) >= 500:
			if rerr := retryable(err); rerr != nil {
				return rerr
			}
			continue
		default:
			return err
		}
		if pos <= start {
			if rerr := retryable(errors.New("the server acknowledged no progress")); rerr != nil {
				return rerr
			}
		}
	}
	return nil
}
