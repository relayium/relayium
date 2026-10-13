package xfer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Content-checked sync.
//
// Size and whole-second modification time do not identify a file: an edit that
// keeps the size within the same second, or a copy that preserves timestamps
// (cp -p, rsync -t, an archive extraction), leaves both equal while the bytes
// differ, and a size+mtime skip then silently keeps the stale copy. A sync
// sender that sets Hello.ContentCheck puts each source file's SHA-256 in the
// manifest; a receiver that understands it skips a file only when its own copy
// has the same size AND the same digest, installs a received file only when the
// body matches that digest, and says so by echoing ResumeState.ContentCheck.
//
// Nothing here is trusted from an older peer: a sender never treats a missing
// echo as support, and a receiver uses the digests only when the sender
// announced them.

// ErrContentCheckUnsupported is returned by Send when SendOpts.RequireContentCheck
// is set and the receiver did not echo content checking. It is returned before
// any file body is sent.
var ErrContentCheckUnsupported = errors.New("the receiver does not support content-checked sync (it is an older relayium): " +
	"it would decide what is unchanged by size and modification time only. Only a capability question was sent; no file in the receive directory was written or deleted by this sync. " +
	"Update relayium on the receiver, or run without --checksum to accept size+mtime skipping")

// ErrDeleteReportUnsupported is returned by Send when SendOpts.RequireDeleteReport
// is set and the receiver cannot report a refused or partial delete. Only the
// non-deleting preflight was sent: the delete request never was.
var ErrDeleteReportUnsupported = errors.New("the receiver runs an older relayium that cannot report whether its delete ran in full, " +
	"so --strict-delete cannot be honoured. Only a capability question was sent; no file in the receive directory was written or deleted by this sync. " +
	"Update relayium on the receiver, or run without --strict-delete")

// validDigest reports whether s is a SHA-256 in the exact form this protocol
// uses: 64 lowercase hexadecimal characters.
func validDigest(s string) bool {
	if len(s) != sha256.Size*2 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// hashSourcePrefix returns the SHA-256 of exactly the first size bytes of
// path. A file that is now shorter than size changed after the manifest was
// built, and is an error: the digest must describe the bytes the manifest
// promises.
func hashSourcePrefix(ctx context.Context, path string, size int64) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.CopyN(h, ctxReader{ctx, f}, size)
	if cerr := ctx.Err(); cerr != nil {
		return "", cerr
	}
	if n != size {
		if err == nil || errors.Is(err, io.EOF) {
			return "", fmt.Errorf("%s: changed while preparing the sync (now %d bytes, expected %d)", path, n, size)
		}
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// WithContentDigests returns a copy of m whose entries carry the SHA-256 of
// srcs[i]. m itself is not modified. A caller may compute the digests before
// connecting (hashing a large tree takes time a connected peer should not have
// to wait through); Send then uses them as they are.
func WithContentDigests(m Manifest, srcs []string) (Manifest, error) {
	return withContentDigestsCtx(context.Background(), m, srcs)
}

// WithContentDigestsContext is WithContentDigests that stops when ctx is done:
// it checks ctx between files and between reads, runs on the caller's
// goroutine, and leaves nothing running when it returns ctx.Err().
func WithContentDigestsContext(ctx context.Context, m Manifest, srcs []string) (Manifest, error) {
	return withContentDigestsCtx(ctx, m, srcs)
}

func withContentDigests(m Manifest, srcs []string) (Manifest, error) {
	return withContentDigestsCtx(context.Background(), m, srcs)
}

func withContentDigestsCtx(ctx context.Context, m Manifest, srcs []string) (Manifest, error) {
	if len(srcs) != len(m.Files) {
		return Manifest{}, fmt.Errorf("content check: %d sources for %d manifest entries", len(srcs), len(m.Files))
	}
	files := make([]FileEntry, len(m.Files))
	copy(files, m.Files)
	for i := range files {
		if err := ctx.Err(); err != nil {
			return Manifest{}, err
		}
		d, err := hashSourcePrefix(ctx, srcs[i], files[i].Size)
		if err != nil {
			return Manifest{}, err
		}
		files[i].SHA256 = d
	}
	return Manifest{Files: files}, nil
}

// destMatchesDigest reports whether the receiver's existing copy at dest has
// exactly size bytes hashing to want. Any doubt answers false (send it): a
// missing, unreadable or non-regular file, a symbolic link, or a parent
// directory that resolves outside base -- the digest comparison must never be
// a way to ask about a file outside the receive directory.
func destMatchesDigest(base, dest string, size int64, want string) bool {
	info, err := os.Lstat(dest)
	if err != nil || !info.Mode().IsRegular() || info.Size() != size {
		return false
	}
	if err := ensureWithin(base, filepath.Dir(dest)); err != nil {
		return false
	}
	f, err := os.Open(dest)
	if err != nil {
		return false
	}
	defer f.Close()
	// The file opened must still be the regular file checked above.
	if st, err := f.Stat(); err != nil || !os.SameFile(st, info) {
		return false
	}
	h := sha256.New()
	if n, err := io.Copy(h, io.LimitReader(f, size+1)); err != nil || n != size {
		return false
	}
	return hex.EncodeToString(h.Sum(nil)) == want
}

// contentSyncStateFor is syncStateFor for a content-checked sync: a manifest
// file is skipped only when the on-disk copy has the same size and digest.
// Modification time plays no part in the decision. Partial files still get a
// resume offer, and their merged result must then match the manifest digest.
func contentSyncStateFor(destDir string, m Manifest) ResumeState {
	rs := ResumeState{ContentCheck: true}
	base, err := filepath.Abs(destDir)
	if err != nil {
		return rs
	}
	for i, f := range m.Files {
		dest, err := safeJoin(destDir, f.Path)
		if err != nil {
			continue
		}
		info, err := os.Lstat(dest)
		if err != nil || !info.Mode().IsRegular() {
			continue // absent, or not a plain file → full send
		}
		if info.Size() == f.Size {
			if destMatchesDigest(base, dest, f.Size, f.SHA256) {
				rs.Skip = append(rs.Skip, i)
			}
			continue
		}
		if info.Size() > 0 && info.Size() < f.Size {
			rs.Entries = append(rs.Entries, ResumeEntry{Index: i, Have: info.Size()})
		}
	}
	return rs
}

// checkManifestDigests validates every entry's digest when the sender
// announced content checking. A content-checked manifest with a missing or
// malformed digest is a protocol error, not something to guess around.
func checkManifestDigests(m Manifest) error {
	for i, f := range m.Files {
		if !validDigest(f.SHA256) {
			return fmt.Errorf("protocol error: manifest entry %d has no valid content digest", i)
		}
	}
	return nil
}

// hasAllDigests reports whether every entry already carries a valid digest
// (computed earlier by WithContentDigests).
func hasAllDigests(m Manifest) bool {
	for _, f := range m.Files {
		if !validDigest(f.SHA256) {
			return false
		}
	}
	return true
}

// ctxReader fails its next Read once ctx is done, so hashing a large file
// stops within one read of a cancellation.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}
