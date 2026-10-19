package cloud

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/relayium/relayium/internal/storecrypto"
)

var spoolHashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var uploadIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,256}$`)

func upSpoolPath(dir, id string) string { return filepath.Join(UpJournalDir(dir), id+".cipher") }

// SpoolUpOperation encrypts ONCE before network admission. The caller holds the
// operation lock. Restarts read only this verified ciphertext, never the sources.
func SpoolUpOperation(dir string, o *UpOperation, p *PreparedUpload) error {
	if o == nil || p == nil || o.validate() != nil || o.Version != 1 || o.BodyLength != p.BodyLength || o.ContentKey != p.Key() {
		return ErrUpOperationCorrupt
	}
	root, err := ensureJournalDir(dir)
	if err != nil {
		return err
	}
	if err = journalDirSyncable(root); err != nil {
		return err
	}
	f, err := os.CreateTemp(root, ".spool-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	unchanged := func() error {
		for _, src := range p.files {
			info, err := os.Stat(src.path)
			if err != nil {
				return err
			}
			if src.snapshot == nil || !os.SameFile(src.snapshot, info) || info.Size() != src.size || !info.ModTime().Equal(src.snapshot.ModTime()) {
				return fmt.Errorf("source changed while preparing encrypted copy; nothing uploaded")
			}
		}
		return nil
	}
	if err = unchanged(); err != nil {
		return err
	}
	hash := sha256.New()
	if err = writeUploadBody(io.MultiWriter(f, hash), p.encManifest, p.files, p.key, nil); err != nil {
		return err
	}
	if err = unchanged(); err != nil {
		return err
	}
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if st.Size() != o.BodyLength {
		return fmt.Errorf("source size changed while encrypting; nothing uploaded")
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	path := upSpoolPath(dir, o.ID)
	if err = os.Link(f.Name(), path); err != nil {
		return err
	}
	if err = journalDirSync(root); err != nil {
		_ = os.Remove(path)
		return err
	}
	o.Version, o.Phase, o.HeaderBytes, o.SpoolSHA256 = 2, "planned", int64(4+len(p.encManifest)), hex.EncodeToString(hash.Sum(nil))
	return nil
}

func openUpSpool(dir string, o UpOperation) (*os.File, error) {
	path := upSpoolPath(dir, o.ID)
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || !ownedPrivately(info) || info.Size() != o.BodyLength {
		return nil, ErrUpOperationUnsafe
	}
	f, err := openNoFollow(path)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*os.File, error) { _ = f.Close(); return nil, err }
	st, err := f.Stat()
	if err != nil {
		return fail(err)
	}
	if !os.SameFile(info, st) {
		return fail(ErrUpOperationUnsafe)
	}
	h := sha256.New()
	if _, err = io.Copy(h, io.NewSectionReader(f, 0, o.BodyLength)); err != nil {
		return fail(err)
	}
	if hex.EncodeToString(h.Sum(nil)) != o.SpoolSHA256 {
		return fail(fmt.Errorf("encrypted copy hash mismatch; nothing uploaded"))
	}
	header := make([]byte, o.HeaderBytes)
	if _, err = f.ReadAt(header, 0); err != nil {
		return fail(err)
	}
	if int64(binary.BigEndian.Uint32(header[:4])) != o.HeaderBytes-4 {
		return fail(ErrUpOperationCorrupt)
	}
	key, err := storecrypto.DecodeKey(o.ContentKey)
	if err != nil {
		return fail(ErrUpOperationCorrupt)
	}
	manifest, err := storecrypto.DecryptManifest(key, header[4:])
	if err != nil {
		return fail(ErrUpOperationCorrupt)
	}
	var plain int64
	for _, entry := range manifest.Files {
		plain += entry.Size
	}
	if len(manifest.Files) != o.FileCount || plain != o.TotalBytes {
		return fail(ErrUpOperationCorrupt)
	}
	return f, nil
}

// RemoveUpSpool removes only this validated operation's local ciphertext.
func RemoveUpSpool(dir, id string) error {
	if !ValidUpOperationID(id) {
		return ErrUpOperationNotFound
	}
	err := os.Remove(upSpoolPath(dir, id))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// resumeJSON bounds transport idle time and tail confirmation/JSON response,
// and never follows a redirect carrying this account's credential. No error
// includes response text.
func (c *Client) resumeJSON(ctx context.Context, method, path string, body []byte, rangeHeader string, out any) error {
	if err := checkSecureServer(c.Server); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	idle := c.idleTimeout
	if idle <= 0 {
		idle = defaultIdleTimeout
	}
	// A progressing body has no total-duration cap. After its last byte is
	// exposed to the transport, allow the existing size-scaled confirmation
	// interval for the unconfirmed tail and bounded JSON response.
	wait := idle
	if len(body) == 0 {
		wait = c.confirmTimeout(0)
	}
	if wait <= 0 {
		wait = defaultIdleTimeout
	}
	timer := time.AfterFunc(wait, cancel)
	defer timer.Stop()
	req, err := http.NewRequestWithContext(ctx, method, c.Server+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	if len(body) > 0 {
		// HTTP/2 can rewind through GetBody after REFUSED_STREAM/GOAWAY.
		// Every attempt must observe transport progress; NewRequest's original
		// bytes.Reader factory would bypass the idle timer on a retry.
		var bodyMu sync.Mutex
		var generation uint64
		req.GetBody = func() (io.ReadCloser, error) {
			bodyMu.Lock()
			defer bodyMu.Unlock()
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			generation++
			owner := generation
			timer.Reset(idle)
			return io.NopCloser(&resumeBodyProgress{reader: bytes.NewReader(body), remaining: len(body), progress: func(last bool) {
				bodyMu.Lock()
				defer bodyMu.Unlock()
				if owner != generation {
					return // a late read from the retired attempt owns no timer
				}
				bound := idle
				if last {
					bound = c.confirmTimeout(int64(len(body)))
				}
				if bound <= 0 {
					bound = defaultIdleTimeout
				}
				timer.Reset(bound)
			}}), nil
		}
		req.Body, err = req.GetBody()
		if err != nil {
			return err
		}
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/octet-stream")
	if strings.HasSuffix(path, "/finalize") {
		req.Header.Set("Content-Type", "application/json")
	}
	if rangeHeader != "" {
		req.Header.Set("Content-Range", rangeHeader)
	}
	httpc := c.HTTP
	if httpc == c.stdHTTP && c.uploadHTTP != nil {
		httpc = c.uploadHTTP
	}
	client := *httpc
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		statusErr := &HTTPError{Path: path, Status: resp.StatusCode}
		if strings.HasSuffix(path, "/finalize") {
			if resp.StatusCode == http.StatusNotFound {
				return fmt.Errorf("the server no longer identifies this upload session; this does not prove whether it previously completed. Check the account file list before starting another upload: %w", statusErr)
			}
			if resp.StatusCode == http.StatusConflict {
				// Only interpret the documented recovery envelope; arbitrary
				// gateway bodies must not become trusted outcome instructions.
				b, readErr := io.ReadAll(io.LimitReader(resp.Body, (16<<10)+1))
				var reply struct {
					Error   string `json:"error"`
					Outcome string `json:"outcome"`
				}
				if readErr == nil && len(b) <= 16<<10 && json.Unmarshal(b, &reply) == nil && reply.Error == "already_finalized" {
					switch reply.Outcome {
					case "running":
						return fmt.Errorf("finalization is still running; retry later using the same operation: %w", statusErr)
					case "expired", "removed":
						return fmt.Errorf("the finalized object is %s; check the account file list. Local recovery material is kept: %w", reply.Outcome, statusErr)
					case "failed":
						return fmt.Errorf("the server cannot provide a finalized link; check the account file list before starting another upload. Local recovery material is kept: %w", statusErr)
					}
				}
			}
		}
		return statusErr
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, (16<<10)+1))
	if err != nil {
		return err
	}
	if len(b) > 16<<10 {
		return fmt.Errorf("resumable response too large")
	}
	if err = json.Unmarshal(b, out); err != nil {
		return fmt.Errorf("unusable resumable response")
	}
	return nil
}

// Observes transport consumption rather than UI/producer completion. Only the
// transport reads a request body; no source file or cryptography is involved.
type resumeBodyProgress struct {
	reader    *bytes.Reader
	remaining int
	progress  func(bool)
}

func (r *resumeBodyProgress) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	r.remaining -= n
	if n > 0 {
		r.progress(r.remaining == 0)
	}
	return n, err
}

// ResumeUpOperation continues exactly the recorded session. An unknown/dead
// session is retained and refused; it is NEVER silently replaced or resealed.
func (c *Client) ResumeUpOperation(ctx context.Context, dir string, o *UpOperation) (string, int64, error) {
	if o.Version != 2 {
		return "", 0, ErrUpOperationCorrupt
	}
	if err := o.validate(); err != nil {
		return "", 0, err
	}
	if !sameUploadServer(c.Server, o.Server) {
		return "", 0, fmt.Errorf("resumable operation belongs to a different server")
	}
	f, err := openUpSpool(dir, *o)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	total := o.BodyLength - o.HeaderBytes
	if o.Phase == "planned" {
		header := make([]byte, o.HeaderBytes)
		if _, err = f.ReadAt(header, 0); err != nil {
			return "", 0, err
		}
		var init struct {
			ID    string `json:"uploadId"`
			Chunk int64  `json:"chunkSize"`
		}
		q := uploadQuery(o.Opts())
		q += "&size=" + fmt.Sprint(total)
		if err = c.resumeJSON(ctx, http.MethodPost, "/api/uploads?"+q, header, "", &init); err != nil {
			return "", 0, err
		}
		if !uploadIDPattern.MatchString(init.ID) || init.Chunk <= 0 || init.Chunk > 16<<20 {
			return "", 0, fmt.Errorf("unusable upload session")
		}
		o.Phase, o.UploadID, o.ChunkSize = "uploading", init.ID, init.Chunk
		if err = SaveUpOperation(dir, *o); err != nil {
			return "", 0, err
		}
	}
	path := "/api/uploads/" + url.PathEscape(o.UploadID)
	if o.Phase == "uploading" {
		var status struct {
			Received *int64 `json:"received"`
		}
		if err = c.resumeJSON(ctx, http.MethodGet, path, nil, "", &status); err != nil {
			return "", 0, err
		}
		if status.Received == nil || *status.Received < 0 || *status.Received > total {
			return "", 0, fmt.Errorf("unusable durable upload offset")
		}
		from := *status.Received
		chunk := min(o.ChunkSize, int64(1<<20))
		buf := make([]byte, chunk)
		// Empty ciphertext still needs one accepted empty append to materialize it.
		empty := total == 0
		for from < total || empty {
			n := min(chunk, total-from)
			part := buf[:n]
			if _, err = f.ReadAt(part, o.HeaderBytes+from); err != nil {
				return "", 0, err
			}
			var ack struct {
				Received *int64 `json:"received"`
			}
			hdr := fmt.Sprintf("bytes %d-%d/%d", from, from+n-1, total)
			if err = c.resumeJSON(ctx, http.MethodPatch, path, part, hdr, &ack); err != nil {
				return "", 0, err
			}
			if ack.Received == nil || *ack.Received != from+n {
				return "", 0, fmt.Errorf("unexpected durable upload offset; resume will recheck server")
			}
			from = *ack.Received
			empty = false
			if c.Progress != nil {
				c.Progress(from, total)
			}
		}
		o.Phase = "finalizing"
		if err = SaveUpOperation(dir, *o); err != nil {
			return "", 0, err
		}
	}
	var done struct {
		ID      string `json:"id"`
		Expires int64  `json:"expiresAt"`
	}
	if err = c.resumeJSON(ctx, http.MethodPost, path+"/finalize", []byte(`{"recoverFinalized":true}`), "", &done); err != nil {
		return "", 0, err
	}
	if !usableID.MatchString(done.ID) || done.Expires <= 0 {
		return "", 0, fmt.Errorf("unusable finalize response")
	}
	return done.ID, done.Expires, nil
}

func sameUploadServer(a, b string) bool {
	return strings.TrimRight(a, "/") == strings.TrimRight(b, "/")
}
