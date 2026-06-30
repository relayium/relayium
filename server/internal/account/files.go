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

	// Daily quota: rolling 24h sum + this upload must stay within the limit.
	used, err := s.store.UserUploadedSince(r.Context(), u.ID, now-dayWindow)
	if err != nil {
		_ = s.blobs.Delete(r.Context(), blobKey)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if used+size > st.DailyQuota {
		_ = s.blobs.Delete(r.Context(), blobKey)
		http.Error(w, "daily quota exceeded", http.StatusTooManyRequests)
		return
	}

	if err := s.store.RecordUpload(r.Context(), UploadEvent{
		ID: newID(), UserID: u.ID, Bytes: size, UploadedAt: now,
	}); err != nil {
		_ = s.blobs.Delete(r.Context(), blobKey)
		http.Error(w, "server error", http.StatusInternalServerError)
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
		return // client hung up mid-stream; leave the file intact
	}
	// Burn-after-read: only after the whole blob streamed out. Row-state delete
	// is idempotent so a double download can't 500.
	if sf.BurnAfterRead && n == sf.Size {
		_ = s.store.MarkDownloaded(r.Context(), sf.ID, s.now().Unix())
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
	return sf, true
}
