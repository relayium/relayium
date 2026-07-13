package cloud

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/relayium/relayium/internal/storecrypto"
)

// UploadOpts controls the retention parameters attached to an upload. A zero
// value asks for none of them, so the server applies its own admin-configured
// default retention policy — see resolveRetention on the server side.
type UploadOpts struct {
	Burn         bool
	TTLSeconds   int64
	MaxDownloads int64
}

// uploadStatusError maps an upload's HTTP status to an actionable message,
// distinct from a bare "unexpected status N" so the CLI can tell the user
// what to actually do (re-login, shrink the file, wait for quota reset).
func uploadStatusError(status int) error {
	switch status {
	case http.StatusUnauthorized:
		return errors.New("session expired, run `relayium login` again")
	case http.StatusRequestEntityTooLarge:
		return errors.New("file exceeds server max size")
	case http.StatusTooManyRequests:
		return errors.New("daily quota exceeded")
	default:
		return fmt.Errorf("upload failed: unexpected status %d", status)
	}
}

// uploadFile pairs a manifest entry with the absolute path to read it from.
type uploadFile struct {
	name string // relative, forward-slash path as recorded in the manifest
	path string // absolute source path on disk
}

// walkUploadPaths expands paths (files and/or directory trees) into the flat
// list of files an upload will send, using relative forward-slash names —
// matching web's manifest `name` (a bare file's own basename; a directory's
// contents prefixed by the directory name), mirroring xfer.BuildManifest's
// convention of walking relative to the parent of each root.
func walkUploadPaths(paths []string) ([]uploadFile, error) {
	var files []uploadFile
	for _, root := range paths {
		absRoot, err := filepath.Abs(root)
		if err != nil {
			return nil, err
		}
		parent := filepath.Dir(absRoot)
		err = filepath.WalkDir(absRoot, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !d.Type().IsRegular() {
				return nil
			}
			rel, err := filepath.Rel(parent, p)
			if err != nil {
				return err
			}
			files = append(files, uploadFile{name: filepath.ToSlash(rel), path: p})
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return files, nil
}

// uploadQuery builds the /api/files query string from opt, omitting any
// zero/false parameter so the server falls back to its admin-configured
// default retention policy for that field.
func uploadQuery(opt UploadOpts) string {
	q := url.Values{}
	if opt.Burn {
		q.Set("burnAfterRead", "1")
	}
	if opt.TTLSeconds > 0 {
		q.Set("ttl", fmt.Sprintf("%d", opt.TTLSeconds))
	}
	if opt.MaxDownloads > 0 {
		q.Set("maxDownloads", fmt.Sprintf("%d", opt.MaxDownloads))
	}
	return q.Encode()
}

// Upload encrypts paths (files and/or directory trees) client-side and
// streams the ciphertext to the account-bound cloud store. It never buffers
// the full payload in memory: the request body is produced on the fly by a
// goroutine writing into an io.Pipe, which http.NewRequestWithContext reads
// from directly.
//
// Wire format (frozen, must match the server's handleUploadFile exactly):
//
//	uint32BE(len(encManifest)) || encManifest || framedCiphertext
//
// where framedCiphertext is each file's storecrypto.ChunkSize chunks, each
// encoded via storecrypto.FrameChunk(key, seq, chunk) using one GLOBAL seq
// counter across all files, starting at 1 (the manifest itself occupies
// seq 0, per EncryptManifest).
func (c *Client) Upload(ctx context.Context, paths []string, opt UploadOpts) (id, keyB64Url string, err error) {
	files, err := walkUploadPaths(paths)
	if err != nil {
		return "", "", err
	}

	key, err := storecrypto.GenerateKey()
	if err != nil {
		return "", "", err
	}

	manifest := storecrypto.Manifest{Files: make([]storecrypto.FileEntry, len(files))}
	var total int64
	for i, f := range files {
		info, err := os.Stat(f.path)
		if err != nil {
			return "", "", err
		}
		manifest.Files[i] = storecrypto.FileEntry{Name: f.name, Size: info.Size()}
		total += info.Size()
	}

	encManifest, err := storecrypto.EncryptManifest(key, manifest)
	if err != nil {
		return "", "", err
	}

	var onProgress func(sent int64)
	if c.Progress != nil {
		c.Progress(0, total) // starting line before any bytes stream
		onProgress = func(sent int64) { c.Progress(sent, total) }
	}

	pr, pw := io.Pipe()
	go func() {
		pw.CloseWithError(writeUploadBody(pw, encManifest, files, key, onProgress))
	}()

	q := uploadQuery(opt)
	reqURL := c.Server + "/api/files"
	if q != "" {
		reqURL += "?" + q
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, pr)
	if err != nil {
		pr.Close()
		return "", "", err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/octet-stream")

	httpc := c.HTTP
	if httpc == nil {
		httpc = http.DefaultClient
	}
	resp, err := httpc.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", uploadStatusError(resp.StatusCode)
	}

	var out struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", "", err
	}
	return out.ID, storecrypto.EncodeKey(key), nil
}

// writeUploadBody writes the framed request body (manifest header + each
// file's encrypted chunks) into w, using one global seq counter starting at
// 1 across all files (seq 0 is the manifest, per EncryptManifest/nonce(0)).
func writeUploadBody(w io.Writer, encManifest []byte, files []uploadFile, key []byte, progress func(sent int64)) error {
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(encManifest)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if _, err := w.Write(encManifest); err != nil {
		return err
	}

	seq := uint64(1)
	var sent int64
	buf := make([]byte, storecrypto.ChunkSize)
	for _, f := range files {
		fh, err := os.Open(f.path)
		if err != nil {
			return err
		}
		err = func() error {
			defer fh.Close()
			for {
				n, rerr := io.ReadFull(fh, buf)
				if n > 0 {
					frame, ferr := storecrypto.FrameChunk(key, seq, buf[:n])
					if ferr != nil {
						return ferr
					}
					seq++
					if _, werr := w.Write(frame); werr != nil {
						return werr
					}
					sent += int64(n)
					if progress != nil {
						progress(sent)
					}
				}
				if rerr == io.EOF || rerr == io.ErrUnexpectedEOF {
					return nil
				}
				if rerr != nil {
					return rerr
				}
			}
		}()
		if err != nil {
			return err
		}
	}
	return nil
}

// DownloadLink builds the shareable claim link for id: the key travels only
// in the URL fragment, so it is never sent to the server on a normal page
// load.
func (c *Client) DownloadLink(origin, id, keyB64Url string) string {
	return origin + "/d/" + id + "#k=" + keyB64Url
}

// ParseClaim parses a download claim in either of the two forms `down`
// accepts: a full shareable link, as built by DownloadLink
// (scheme://host/d/<id>#k=<key>), or a bare compact code with no host
// (<id>#k=<key>) — for the latter, server is returned empty and the caller
// supplies a default (--server, or defaultCloudServer). Both forms carry the
// key as a "k=" URL-fragment, matching web's buildDownloadLink/
// parseDownloadKey so links interop between the CLI and the browser.
func ParseClaim(s string) (server, id, keyB64Url string, err error) {
	hashIdx := strings.LastIndex(s, "#")
	if hashIdx < 0 {
		return "", "", "", fmt.Errorf("cloud: claim %q: missing #k=<key> fragment", s)
	}
	head, frag := s[:hashIdx], s[hashIdx+1:]
	key, ok := strings.CutPrefix(frag, "k=")
	if !ok || key == "" {
		return "", "", "", fmt.Errorf("cloud: claim %q: fragment must be k=<key>", s)
	}

	if u, uerr := url.Parse(head); uerr == nil && u.Scheme != "" && u.Host != "" {
		id, ok := strings.CutPrefix(u.Path, "/d/")
		if !ok || id == "" {
			return "", "", "", fmt.Errorf("cloud: claim %q: not a /d/<id> link", s)
		}
		return u.Scheme + "://" + u.Host, id, key, nil
	}

	if head == "" {
		return "", "", "", fmt.Errorf("cloud: claim %q: missing id", s)
	}
	return "", head, key, nil
}

// downloadStatusError maps a meta/blob fetch's HTTP status to an actionable
// message, distinct from a bare "unexpected status N".
func downloadStatusError(what string, status int) error {
	switch status {
	case http.StatusNotFound:
		return fmt.Errorf("cloud: %s: not found (expired, burned, or wrong id)", what)
	case http.StatusServiceUnavailable:
		return fmt.Errorf("cloud: %s: storage temporarily unavailable, try again later", what)
	default:
		return fmt.Errorf("cloud: %s: unexpected status %d", what, status)
	}
}

// writeError wraps a local filesystem error encountered while routing
// decrypted bytes into files, so Download can tell it apart from a
// storecrypto decrypt/integrity failure (see the errors.As check below) even
// though both surface through the same Decryptor.Push emit callback.
type writeError struct{ err error }

func (e *writeError) Error() string { return e.err.Error() }
func (e *writeError) Unwrap() error { return e.err }

// manifestWriter routes a stream of decrypted plaintext (delivered in
// arbitrary-sized chunks by Decryptor.Push) into the right output files, in
// manifest order: the manifest is the sole source of truth for where one
// file ends and the next begins, since the ciphertext stream carries no
// per-file framing of its own (writeUploadBody emits zero chunks for a
// zero-size file).
type manifestWriter struct {
	destDir string
	files   []storecrypto.FileEntry

	idx       int      // index into files of the next file to open
	cur       *os.File // currently-open output file, or nil between files
	remaining int64    // bytes left to write to cur
	paths     []string // paths written so far, in manifest order
}

// openNext opens files starting at idx, creating (and immediately closing)
// any zero-size entries along the way — since no ciphertext bytes exist for
// them — until it finds one with bytes left to receive, or exhausts the
// manifest (cur stays nil in that case).
func (w *manifestWriter) openNext() error {
	for w.cur == nil && w.idx < len(w.files) {
		f := w.files[w.idx]
		path, err := safeJoin(w.destDir, f.Name)
		if err != nil {
			return err
		}
		dir := filepath.Dir(path)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		// Defense in depth beyond safeJoin's lexical check and the leaf
		// O_NOFOLLOW below: a pre-planted symlinked *directory* under destDir
		// (which defaults to the user's cwd — never freshly created) could
		// still redirect the write outside it. Confirm the parent's real
		// (symlink-resolved) path stays within destDir. Mirrors the receive
		// path's hardening (internal/xfer, commit a4bc65d).
		if err := ensureWithin(w.destDir, dir); err != nil {
			return err
		}
		// O_NOFOLLOW refuses a symlink at the leaf, so a pre-planted
		// notes.txt -> /outside symlink can't be followed and overwritten.
		fh, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_TRUNC|oNoFollow, 0o644)
		if err != nil {
			return err
		}
		w.paths = append(w.paths, path)
		w.idx++
		if f.Size == 0 {
			if err := fh.Close(); err != nil {
				return err
			}
			continue
		}
		w.cur = fh
		w.remaining = f.Size
	}
	return nil
}

// write is the Decryptor.Push emit callback: it fans a chunk of decrypted
// plaintext out across one or more files per the manifest's declared sizes.
// Any error here — a Zip-Slip-rejected name, a disk write failure — is
// wrapped in *writeError so Download can distinguish it from a genuine
// decrypt/integrity failure, even though both propagate through the same
// Push return value.
func (w *manifestWriter) write(pt []byte) error {
	for len(pt) > 0 {
		if w.cur == nil {
			if err := w.openNext(); err != nil {
				return &writeError{err}
			}
			if w.cur == nil {
				return &writeError{errors.New("more decrypted data than the manifest declares")}
			}
		}
		n := int64(len(pt))
		if n > w.remaining {
			n = w.remaining
		}
		if _, err := w.cur.Write(pt[:n]); err != nil {
			return &writeError{err}
		}
		pt = pt[n:]
		w.remaining -= n
		if w.remaining == 0 {
			if err := w.cur.Close(); err != nil {
				return &writeError{err}
			}
			w.cur = nil
		}
	}
	return nil
}

// finish opens (as empty files) any manifest entries left unopened once the
// ciphertext stream is exhausted — trailing zero-size files never receive a
// Push call at all, so they must be flushed out explicitly. Only called
// after Decryptor.End has confirmed the total byte count matches the
// manifest, which guarantees any entries left here are all zero-size.
func (w *manifestWriter) finish() error {
	if w.cur != nil {
		if err := w.cur.Close(); err != nil {
			return err
		}
		w.cur = nil
	}
	return w.openNext()
}

// closeAll is a best-effort cleanup for early-return error paths; it does
// not report errors since Download already has one to return by the time it
// runs.
func (w *manifestWriter) closeAll() {
	if w.cur != nil {
		_ = w.cur.Close()
		w.cur = nil
	}
}

// safeJoin joins a manifest file name onto destDir, rejecting any path that
// would let a malicious/buggy manifest escape destDir (Zip-Slip) — mirrors
// xfer's safeJoin (internal/xfer/recv.go).
func safeJoin(destDir, name string) (string, error) {
	// Resolve destDir to an absolute, cleaned path first: without this a
	// destDir like "." (down's default) never prefix-matches the joined
	// result, rejecting every file.
	base, err := filepath.Abs(destDir)
	if err != nil {
		return "", err
	}
	clean := filepath.Clean("/" + filepath.FromSlash(name))
	joined := filepath.Join(base, clean)
	if joined != base && !strings.HasPrefix(joined, base+string(filepath.Separator)) {
		return "", fmt.Errorf("cloud: unsafe path in manifest: %q", name)
	}
	return joined, nil
}

// ensureWithin verifies that dir, after resolving any symlinks, is still inside
// destDir (also symlink-resolved). Both must exist. This catches a symlinked
// directory pre-planted under destDir that a purely lexical check would miss.
// Copied from internal/xfer/recv.go's identical defense (commit a4bc65d).
func ensureWithin(destDir, dir string) error {
	absBase, err := filepath.Abs(destDir)
	if err != nil {
		return err
	}
	realBase, err := filepath.EvalSymlinks(absBase)
	if err != nil {
		return err
	}
	realDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return err
	}
	if realDir != realBase && !strings.HasPrefix(realDir, realBase+string(filepath.Separator)) {
		return fmt.Errorf("cloud: refusing write outside destDir via symlinked directory: %q", dir)
	}
	return nil
}

// Download fetches id's encrypted manifest and blob from server, decrypts
// them with the key encoded in keyB64Url, and writes the resulting files
// under destDir (creating parent directories as needed). It streams the
// blob response directly into a storecrypto.Decryptor rather than buffering
// it, and verifies the total decrypted length against the manifest via
// Decryptor.End before returning. Returns the written file paths, in
// manifest order.
func (c *Client) Download(ctx context.Context, id, keyB64Url, destDir string) ([]string, error) {
	key, err := storecrypto.DecodeKey(keyB64Url)
	if err != nil {
		return nil, fmt.Errorf("cloud: %w", err)
	}

	httpc := c.HTTP
	if httpc == nil {
		httpc = http.DefaultClient
	}

	// id is untrusted (typically pasted from a claim link); escape it so it
	// can't smuggle extra path segments into the request URL.
	idPath := url.PathEscape(id)

	metaReq, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Server+"/api/files/"+idPath+"/meta", nil)
	if err != nil {
		return nil, err
	}
	metaResp, err := httpc.Do(metaReq)
	if err != nil {
		return nil, fmt.Errorf("cloud: fetch metadata: %w", err)
	}
	defer metaResp.Body.Close()
	if metaResp.StatusCode < 200 || metaResp.StatusCode >= 300 {
		return nil, downloadStatusError("fetch metadata", metaResp.StatusCode)
	}
	var meta struct {
		EncManifest string `json:"encManifest"`
	}
	if err := json.NewDecoder(metaResp.Body).Decode(&meta); err != nil {
		return nil, fmt.Errorf("cloud: fetch metadata: %w", err)
	}

	encManifest, err := base64.StdEncoding.DecodeString(meta.EncManifest)
	if err != nil {
		return nil, fmt.Errorf("cloud: fetch metadata: bad encManifest encoding: %w", err)
	}
	manifest, err := storecrypto.DecryptManifest(key, encManifest)
	if err != nil {
		return nil, fmt.Errorf("cloud: decrypt failed (wrong key, or corrupt/tampered manifest): %w", err)
	}

	var expectedTotal int64
	for _, f := range manifest.Files {
		expectedTotal += f.Size
	}

	blobReq, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Server+"/api/files/"+idPath+"/blob", nil)
	if err != nil {
		return nil, err
	}
	blobResp, err := httpc.Do(blobReq)
	if err != nil {
		return nil, fmt.Errorf("cloud: fetch blob: %w", err)
	}
	defer blobResp.Body.Close()
	if blobResp.StatusCode < 200 || blobResp.StatusCode >= 300 {
		return nil, downloadStatusError("fetch blob", blobResp.StatusCode)
	}

	w := &manifestWriter{destDir: destDir, files: manifest.Files}
	defer w.closeAll()

	// emit routes decrypted plaintext into the output files and tallies the
	// bytes written so Progress reflects file-recovery progress (plaintext,
	// against the manifest's known total) rather than depending on the blob
	// response advertising a Content-Length.
	var written int64
	emit := func(pt []byte) error {
		if err := w.write(pt); err != nil {
			return err
		}
		written += int64(len(pt))
		return nil
	}

	if c.Progress != nil {
		c.Progress(0, expectedTotal) // show a starting line even for tiny blobs
	}
	dec := storecrypto.NewDecryptor(key)
	buf := make([]byte, storecrypto.ChunkSize)
	for {
		n, rerr := blobResp.Body.Read(buf)
		if n > 0 {
			if perr := dec.Push(buf[:n], emit); perr != nil {
				var we *writeError
				if errors.As(perr, &we) {
					return nil, fmt.Errorf("cloud: write file: %w", we.err)
				}
				return nil, fmt.Errorf("cloud: decrypt failed (wrong key, or corrupt/tampered data): %w", perr)
			}
			if c.Progress != nil {
				c.Progress(written, expectedTotal)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return nil, fmt.Errorf("cloud: network error while downloading: %w", rerr)
		}
	}

	if err := dec.End(expectedTotal); err != nil {
		return nil, fmt.Errorf("cloud: decrypt failed (wrong key, or corrupt/tampered/truncated data): %w", err)
	}

	if err := w.finish(); err != nil {
		return nil, fmt.Errorf("cloud: write file: %w", err)
	}

	return w.paths, nil
}
