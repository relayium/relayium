package account

import (
	"bufio"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/relayium/relayium/internal/storage"
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

// Stub handlers for routes registered above; full implementations land in Task 5.

func (s *Service) handleListFiles(w http.ResponseWriter, r *http.Request, u User) {
	files, err := s.store.ListStoredFilesByUser(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": files})
}

func (s *Service) handleDeleteFile(w http.ResponseWriter, r *http.Request, u User) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func (s *Service) handleFileMeta(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func (s *Service) handleFileBlob(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

// ensure storage import is used even before Task 5 adds blob streaming.
var _ = storage.ErrNotFound
