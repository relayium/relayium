package account

import (
	"bufio"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"strconv"
)

const (
	dayWindow        = int64(86400)
	maxManifestBytes = 64 * 1024
)

// errTooLarge is returned by cappedReader once the upload exceeds the live
// max_file_size; it propagates out of BlobStore.Put so no oversize blob commits.
var errTooLarge = errors.New("account: upload exceeds max file size")

// cappedReader fails the copy as soon as more than max bytes are read.
type cappedReader struct {
	r   io.Reader
	n   int64
	max int64
}

func (c *cappedReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	if c.n > c.max {
		return n, errTooLarge
	}
	return n, err
}

// registerFileRoutes mounts the stored-transfer endpoints on the account mux.
// Public routes (meta/blob) are unauthenticated; the rest require a session.
func (s *Service) registerFileRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/files", s.RequireSession(s.handleUploadFile))
	mux.HandleFunc("GET /api/files", s.RequireSession(s.handleListFiles))
	mux.HandleFunc("DELETE /api/files/{id}", s.RequireSession(s.handleDeleteFile))
	mux.HandleFunc("GET /api/files/{id}/meta", s.handleFileMeta)
	mux.HandleFunc("GET /api/files/{id}/blob", s.handleFileBlob)
}

func (s *Service) handleUploadFile(w http.ResponseWriter, r *http.Request, u User) {
	if s.blobs == nil {
		http.Error(w, "storage unavailable", http.StatusServiceUnavailable)
		return
	}
	st := s.resolveSettings(r.Context())
	burn := r.URL.Query().Get("burnAfterRead") == "1"
	reqTTL, _ := strconv.ParseInt(r.URL.Query().Get("ttl"), 10, 64)
	ttl := clampTTL(reqTTL, st)

	br := bufio.NewReader(r.Body)
	// Length-prefixed opaque encrypted manifest.
	var mlen uint32
	if err := binary.Read(br, binary.BigEndian, &mlen); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if int64(mlen) > maxManifestBytes {
		http.Error(w, "manifest too large", http.StatusBadRequest)
		return
	}
	encManifest := make([]byte, mlen)
	if _, err := io.ReadFull(br, encManifest); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	now := s.now().Unix()

	// Cheap pre-check to avoid writing a blob we'd immediately delete: if the
	// declared body already overflows the remaining daily quota, reject before
	// touching disk. Content-Length is client-supplied, so it is trusted only to
	// fail fast — never to admit; the authoritative gate is ReserveUpload below.
	if r.ContentLength > 0 {
		declared := r.ContentLength - 4 - int64(mlen) // ciphertext bytes (minus framing)
		if declared > 0 {
			used, err := s.store.UserUploadedSince(r.Context(), u.ID, now-dayWindow)
			if err != nil {
				http.Error(w, "server error", http.StatusInternalServerError)
				return
			}
			if used+declared > st.DailyQuota {
				http.Error(w, "daily quota exceeded", http.StatusTooManyRequests)
				return
			}
		}
	}

	blobKey := randToken()
	capped := &cappedReader{r: br, max: st.MaxFileSize}
	size, err := s.blobs.Put(r.Context(), blobKey, capped)
	if err != nil {
		// Put cleans up its temp file on error, so nothing is committed.
		if errors.Is(err, errTooLarge) {
			http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	// Daily quota: atomically re-read the rolling 24h sum, verify this upload
	// fits, and record the event in one transaction. This closes the read/record
	// race where concurrent uploads each see a stale sum and collectively bust the
	// quota. Reserve first, then commit the file — if either fails, drop the blob.
	ok, err := s.store.ReserveUpload(r.Context(),
		UploadEvent{ID: newID(), UserID: u.ID, Bytes: size, UploadedAt: now},
		now-dayWindow, st.DailyQuota)
	if err != nil {
		_ = s.blobs.Delete(r.Context(), blobKey)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		_ = s.blobs.Delete(r.Context(), blobKey)
		http.Error(w, "daily quota exceeded", http.StatusTooManyRequests)
		return
	}
	id := newID()
	sf := StoredFile{
		ID: id, UserID: u.ID, BlobKey: blobKey, EncManifest: encManifest,
		Size: size, BurnAfterRead: burn, CreatedAt: now, ExpiresAt: now + ttl,
	}
	if err := s.store.CreateStoredFile(r.Context(), sf); err != nil {
		_ = s.blobs.Delete(r.Context(), blobKey)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "expiresAt": sf.ExpiresAt})
}

func (s *Service) handleFileMeta(w http.ResponseWriter, r *http.Request) {
	sf, ok := s.liveFile(r, r.PathValue("id"))
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"encManifest":   base64.StdEncoding.EncodeToString(sf.EncManifest),
		"size":          sf.Size,
		"burnAfterRead": sf.BurnAfterRead,
		"expiresAt":     sf.ExpiresAt,
	})
}

func (s *Service) handleFileBlob(w http.ResponseWriter, r *http.Request) {
	if s.blobs == nil {
		http.Error(w, "storage unavailable", http.StatusServiceUnavailable)
		return
	}
	sf, ok := s.liveFile(r, r.PathValue("id"))
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	// Burn-after-read: atomically claim the single download BEFORE streaming a
	// byte. Concurrent GETs race on one UPDATE; only the winner proceeds, the rest
	// 404. Claiming up front means even an interrupted transfer spends the one
	// shot — that is the burn contract, and it closes the TOCTOU where two GETs
	// both streamed the full plaintext before either marked it consumed.
	if sf.BurnAfterRead {
		claimed, err := s.store.ClaimBurnDownload(r.Context(), sf.ID, s.now().Unix())
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		if !claimed {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
	}
	rc, err := s.blobs.Get(r.Context(), sf.BlobKey)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(sf.Size, 10))
	n, err := io.Copy(w, rc)
	if err != nil {
		return // client hung up mid-stream; the download is already spent
	}
	// Burn-after-read: the download is already claimed, so this is pure cleanup of
	// the now-spent ciphertext and row (an interrupted stream leaves them for GC).
	if sf.BurnAfterRead && n == sf.Size {
		_ = s.blobs.Delete(r.Context(), sf.BlobKey)
		_ = s.store.DeleteStoredFile(r.Context(), sf.ID)
	}
}

func (s *Service) handleListFiles(w http.ResponseWriter, r *http.Request, u User) {
	files, err := s.store.ListStoredFilesByUser(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	out := make([]map[string]any, 0, len(files))
	for _, f := range files {
		out = append(out, map[string]any{
			"id":            f.ID,
			"size":          f.Size,
			"createdAt":     f.CreatedAt,
			"expiresAt":     f.ExpiresAt,
			"burnAfterRead": f.BurnAfterRead,
			"downloaded":    f.DownloadedAt > 0,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": out})
}

func (s *Service) handleDeleteFile(w http.ResponseWriter, r *http.Request, u User) {
	sf, err := s.store.GetStoredFile(r.Context(), r.PathValue("id"))
	if err != nil || sf.UserID != u.ID {
		// Non-owner and missing are indistinguishable: no existence leak.
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if s.blobs != nil {
		_ = s.blobs.Delete(r.Context(), sf.BlobKey)
	}
	if err := s.store.DeleteStoredFile(r.Context(), sf.ID); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// liveFile fetches a stored file that exists and has not expired; ok=false maps
// to a 404 for missing, expired, or store errors (fail closed).
func (s *Service) liveFile(r *http.Request, id string) (StoredFile, bool) {
	sf, err := s.store.GetStoredFile(r.Context(), id)
	if err != nil || s.now().Unix() >= sf.ExpiresAt {
		return StoredFile{}, false
	}
	// A burn-after-read file whose one download was already claimed is spent:
	// treat it as gone even if the row lingers (e.g. an interrupted stream that
	// claimed the download but never reached the cleanup delete).
	if sf.BurnAfterRead && sf.DownloadedAt > 0 {
		return StoredFile{}, false
	}
	return sf, true
}
