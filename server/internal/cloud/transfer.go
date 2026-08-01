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
	"time"

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
func (c *Client) Upload(ctx context.Context, paths []string, opt UploadOpts) (id, keyB64Url string, expiresAt int64, err error) {
	files, err := walkUploadPaths(paths)
	if err != nil {
		return "", "", 0, err
	}

	key, err := storecrypto.GenerateKey()
	if err != nil {
		return "", "", 0, err
	}

	manifest := storecrypto.Manifest{Files: make([]storecrypto.FileEntry, len(files))}
	var total int64
	for i, f := range files {
		info, err := os.Stat(f.path)
		if err != nil {
			return "", "", 0, err
		}
		manifest.Files[i] = storecrypto.FileEntry{Name: f.name, Size: info.Size()}
		total += info.Size()
	}

	encManifest, err := storecrypto.EncryptManifest(key, manifest)
	if err != nil {
		return "", "", 0, err
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
		return "", "", 0, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/octet-stream")

	httpc := c.HTTP
	if httpc == nil {
		httpc = http.DefaultClient
	}
	resp, err := httpc.Do(req)
	if err != nil {
		return "", "", 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", 0, uploadStatusError(resp.StatusCode)
	}

	var out struct {
		ID string `json:"id"`
		// ExpiresAt is the EFFECTIVE expiry, already clamped to the account's
		// plan retention cap. Callers compare it against the requested TTL to
		// notice a silent truncation; 0 means the server did not report one.
		ExpiresAt int64 `json:"expiresAt"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", "", 0, err
	}
	return out.ID, storecrypto.EncodeKey(key), out.ExpiresAt, nil
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
	case http.StatusForbidden:
		return fmt.Errorf("cloud: %s: the storage node rejected the download link as already used", what)
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

// prepare resolves the whole batch before creating its first file. This makes
// path collisions and pre-existing user files an all-or-nothing refusal rather
// than something discovered after earlier entries have already been written.
func (w *manifestWriter) prepare() error {
	seen := make(map[string]struct{}, len(w.files))
	for _, f := range w.files {
		path, err := safeJoin(w.destDir, f.Name)
		if err != nil {
			return err
		}
		key := filepath.Clean(path)
		if _, ok := seen[key]; ok {
			return fmt.Errorf("duplicate destination in manifest: %q", f.Name)
		}
		seen[key] = struct{}{}
		if _, err := os.Lstat(path); err == nil {
			return fmt.Errorf("destination already exists: %s", path)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
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
		// Defense in depth beyond safeJoin's lexical check and the leaf
		// O_NOFOLLOW below: a pre-planted symlinked *directory* under destDir
		// (which defaults to the user's cwd — never freshly created) could
		// still redirect the write outside it. mkdirAllWithin verifies the
		// deepest existing ancestor stays within destDir BEFORE MkdirAll can
		// follow it (a symlink must already exist to be followed), and the
		// post-create ensureWithin is the backstop. Mirrors the receive path's
		// hardening (internal/xfer, commit a4bc65d).
		if err := mkdirAllWithin(w.destDir, dir); err != nil {
			return err
		}
		if err := ensureWithin(w.destDir, dir); err != nil {
			return err
		}
		// O_NOFOLLOW refuses a symlink at the leaf, so a pre-planted
		// notes.txt -> /outside symlink can't be followed and overwritten.
		fh, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL|oNoFollow, 0o644)
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

// mkdirAllWithin creates dir like os.MkdirAll, but first verifies the deepest
// already-existing ancestor of dir resolves (symlinks and all) within destDir.
// os.MkdirAll follows an existing symlinked component, so a pre-planted
// destDir/evil -> /outside would let it create /outside/sub before the leaf
// guards fire; checking the deepest existing ancestor closes that, since a
// symlink must already exist to be followed and EvalSymlinks resolves the whole
// chain. Components MkdirAll creates below the ancestor are fresh real dirs.
func mkdirAllWithin(destDir, dir string) error {
	anc := dir
	for {
		if _, err := os.Lstat(anc); err == nil {
			break // deepest existing ancestor
		}
		parent := filepath.Dir(anc)
		if parent == anc {
			break // reached the filesystem root
		}
		anc = parent
	}
	if err := ensureWithin(destDir, anc); err != nil {
		return err
	}
	return os.MkdirAll(dir, 0o755)
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

	// Stream the blob into the writer, resuming across transient interruptions.
	// A single stalled/reset connection (common through proxies on large
	// transfers) shouldn't fail the whole download: on a mid-stream network
	// error we reconnect with `Range: bytes=<consumed>-` and continue from the
	// last whole frame the Decryptor accepted. The writer and Decryptor persist
	// across reconnects so the output files keep filling in place.
	w := &manifestWriter{destDir: destDir, files: manifest.Files}
	if err := w.prepare(); err != nil {
		return nil, fmt.Errorf("cloud: prepare destination: %w", err)
	}
	dec := storecrypto.NewDecryptor(key)
	var written int64
	defer func() { w.closeAll() }()

	// priorPaths accumulates output paths from writers discarded by reset(), so a
	// download that ultimately fails cleans up files opened before a reset too —
	// not just the current writer's. Without this, a reset followed by attempts
	// that fail before re-opening the files would leave the pre-reset output on
	// disk, the very truncated-file-left-behind case removePartials guards.
	var priorPaths []string

	// reset restarts from scratch (fresh writer/decryptor, re-truncating output),
	// used when the server ignores Range and answers a resume with a full 200
	// (an old server, or a limited/burn file).
	reset := func() {
		priorPaths = append(priorPaths, w.paths...)
		w.closeAll()
		removePartials(w, nil)
		w = &manifestWriter{destDir: destDir, files: manifest.Files}
		dec = storecrypto.NewDecryptor(key)
		written = 0
	}

	if c.Progress != nil {
		c.Progress(0, expectedTotal) // show a starting line even for tiny blobs
	}

	sleep := c.sleep
	if sleep == nil {
		sleep = time.Sleep
	}

	const maxAttempts = 5
	attempt := 0
	for {
		serr := c.streamBlob(ctx, httpc, idPath, dec, w, expectedTotal, &written)
		if serr == nil {
			break // whole blob consumed
		}
		var fe *fatalError
		if errors.As(serr, &fe) {
			removePartials(w, priorPaths) // corrupt/tampered data or a disk error — don't leave junk
			return nil, fe.err
		}
		attempt++
		if attempt >= maxAttempts {
			removePartials(w, priorPaths)
			return nil, fmt.Errorf("cloud: download failed after %d attempts: %w", attempt, serr)
		}
		if errors.Is(serr, errIgnoredRange) {
			reset() // server won't resume — start over
			continue
		}
		// Transient network/stream error: back off, then resume from the last
		// fully-decoded frame (ResetBuffer drops the interrupted partial frame).
		dec.ResetBuffer()
		sleep(resumeBackoff(attempt))
	}

	if err := dec.End(expectedTotal); err != nil {
		removePartials(w, priorPaths)
		return nil, fmt.Errorf("cloud: decrypt failed (wrong key, or corrupt/tampered/truncated data): %w", err)
	}
	if err := w.finish(); err != nil {
		removePartials(w, priorPaths)
		return nil, fmt.Errorf("cloud: write file: %w", err)
	}
	return w.paths, nil
}

// errIgnoredRange signals the server answered a resume (Range) request with a
// full 200 body rather than a 206 tail — it won't resume this file, so the
// caller must restart from scratch instead of treating the body as a tail.
var errIgnoredRange = errors.New("cloud: server ignored Range")

// fatalError wraps a non-retryable download failure (bad key, corrupt/tampered
// data, or a local write error) so the resume loop returns it immediately
// instead of reconnecting.
type fatalError struct{ err error }

func (e *fatalError) Error() string { return e.err.Error() }
func (e *fatalError) Unwrap() error { return e.err }

// resumeBackoff is the delay before the Nth (1-based) resume attempt: 300ms
// doubling up to a 5s cap.
func resumeBackoff(attempt int) time.Duration {
	d := 300 * time.Millisecond << (attempt - 1)
	if d > 5*time.Second {
		d = 5 * time.Second
	}
	return d
}

// removePartials deletes the output files written so far, so a download that
// ultimately fails never leaves a truncated file masquerading as complete.
// prior holds paths from writers discarded by reset() (see Download), removed
// alongside the current writer's so a pre-reset attempt's output isn't orphaned.
func removePartials(w *manifestWriter, prior []string) {
	w.closeAll()
	seen := make(map[string]bool, len(w.paths)+len(prior))
	for _, p := range prior {
		if !seen[p] {
			seen[p] = true
			_ = os.Remove(p)
		}
	}
	for _, p := range w.paths {
		if !seen[p] {
			seen[p] = true
			_ = os.Remove(p)
		}
	}
}

// streamBlob performs one blob GET — resuming from dec.ConsumedCipher via a
// Range header when nonzero — and feeds the body through the Decryptor into the
// writer. Returns: nil on a clean EOF; a *fatalError for non-retryable failures;
// errIgnoredRange when a resume got a 200; or the raw transport/read error
// (to be retried) on a mid-stream failure.
func (c *Client) streamBlob(ctx context.Context, httpc *http.Client, idPath string, dec *storecrypto.Decryptor, w *manifestWriter, expectedTotal int64, written *int64) error {
	start := dec.ConsumedCipher()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Server+"/api/files/"+idPath+"/blob", nil)
	if err != nil {
		return &fatalError{err}
	}
	if start > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", start))
	}
	// CLI is not subject to browser CSP and can safely follow a BYO user's
	// custom-domain direct-download redirect. The Web client deliberately omits
	// this opt-in and stays on central's same-origin proxy path.
	req.Header.Set("X-Relayium-Direct-Download", "1")
	resp, err := httpc.Do(req)
	if err != nil {
		return err // transport error — retryable
	}
	defer resp.Body.Close()
	// 403 comes from a storage node whose one-shot download token was already
	// spent (a duplicated request somewhere below us). Retryable, not fatal: the
	// next attempt goes back through central and is handed a fresh token.
	if resp.StatusCode == http.StatusForbidden {
		return downloadStatusError("fetch blob", resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &fatalError{downloadStatusError("fetch blob", resp.StatusCode)}
	}
	if start > 0 && resp.StatusCode == http.StatusOK {
		return errIgnoredRange // asked to resume, got the whole object
	}

	emit := func(pt []byte) error {
		if err := w.write(pt); err != nil {
			return err
		}
		*written += int64(len(pt))
		return nil
	}

	// Bound each Read against a stalled body: if no bytes arrive within
	// idleTimeout, close the body so the blocked Read unblocks with an error the
	// resume loop retries (reconnect + Range from dec.ConsumedCipher). Reset on
	// every read that makes progress. A closed-body Read error is retryable, not
	// fatal, so a genuine stall recovers rather than hanging forever.
	idle := c.idleTimeout
	if idle <= 0 {
		idle = defaultIdleTimeout
	}
	stall := time.AfterFunc(idle, func() { resp.Body.Close() })
	defer stall.Stop()

	buf := make([]byte, storecrypto.ChunkSize)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			stall.Reset(idle)
			if perr := dec.Push(buf[:n], emit); perr != nil {
				var we *writeError
				if errors.As(perr, &we) {
					return &fatalError{fmt.Errorf("cloud: write file: %w", we.err)}
				}
				return &fatalError{fmt.Errorf("cloud: decrypt failed (wrong key, or corrupt/tampered data): %w", perr)}
			}
			if c.Progress != nil {
				c.Progress(*written, expectedTotal)
			}
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			return rerr // mid-stream read error — retryable
		}
	}
}
