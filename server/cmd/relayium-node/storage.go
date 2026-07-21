package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/relayium/relayium/internal/dltoken"
	"github.com/relayium/relayium/internal/storage"
)

// newBlobHandler serves PUT/GET/DELETE /blob/{key} backed by a local DiskStore,
// authenticated by a bearer secret (constant-time). The DiskStore's own key
// validation (validKey regex) rejects path-traversal keys. When lim carries a
// disk cap, PUTs are refused (507) once diskUsed reaches it, enforcing the cap
// locally instead of relying on central's placement heuristic alone. diskFull is
// a built-in safety reserve (independent of the admin cap): it returns true once
// the volume is past ~80% used, so relayium can never fill the disk and wedge the
// host. It also serves an unauthenticated GET /healthz for central's reachability
// probe.
func newBlobHandler(ds *storage.DiskStore, secret string, lim *limits, diskUsed func() int64, diskFull func() bool) http.Handler {
	// full reports whether a write must be refused: over the admin disk cap, or
	// past the built-in 80%-full safety reserve.
	full := func() bool {
		if lim != nil && diskUsed != nil {
			if cap := lim.diskCapBytes(); cap > 0 && diskUsed() >= cap {
				return true
			}
		}
		return diskFull != nil && diskFull()
	}
	mux := http.NewServeMux()
	// Liveness probe for central's connectivity check — no secret, reveals nothing
	// beyond "this node is up and serving HTTP".
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})
	authed := func(h func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if subtle.ConstantTimeCompare([]byte(tok), []byte(secret)) != 1 {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			key := strings.TrimPrefix(r.URL.Path, "/blob/")
			h(w, r, key)
		}
	}
	mux.HandleFunc("PUT /blob/{key}", authed(func(w http.ResponseWriter, r *http.Request, key string) {
		if full() {
			http.Error(w, "storage full", http.StatusInsufficientStorage)
			return
		}
		n, err := ds.Put(r.Context(), key, r.Body)
		if errors.Is(err, storage.ErrInvalidKey) {
			http.Error(w, "bad key", http.StatusBadRequest)
			return
		}
		if err != nil {
			http.Error(w, "write failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]int64{"size": n})
	}))
	mux.HandleFunc("GET /blob/{key}", authed(func(w http.ResponseWriter, r *http.Request, key string) {
		rc, err := ds.Get(r.Context(), key)
		if errors.Is(err, storage.ErrNotFound) || errors.Is(err, storage.ErrInvalidKey) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, "read failed", http.StatusInternalServerError)
			return
		}
		defer rc.Close()
		w.Header().Set("Content-Type", "application/octet-stream")
		// ServeContent gives us Range/206/Accept-Ranges for free, so central can
		// resume an interrupted download. DiskStore.Get returns an *os.File
		// (io.ReadSeeker); fall back to a plain copy for any non-seekable store.
		if rs, ok := rc.(io.ReadSeeker); ok {
			http.ServeContent(w, r, key, time.Time{}, rs)
			return
		}
		_, _ = io.Copy(w, rc)
	}))
	// Public direct-download endpoint: a client fetches the ciphertext straight
	// from this node (central out of the data path) by presenting a short-lived,
	// per-key token central signed with this node's secret. No bearer secret — the
	// client must never hold it. CORS-open because a browser on relayium.com
	// initiates the cross-origin fetch; the token is the access control, and the
	// payload is opaque AEAD ciphertext.
	mux.HandleFunc("GET /dl/{key}", func(w http.ResponseWriter, r *http.Request) {
		key := r.PathValue("key")
		if !dltoken.Verify(secret, key, time.Now().Unix(), r.URL.Query().Get("t")) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		rc, err := ds.Get(r.Context(), key)
		if errors.Is(err, storage.ErrNotFound) || errors.Is(err, storage.ErrInvalidKey) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, "read failed", http.StatusInternalServerError)
			return
		}
		defer rc.Close()
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/octet-stream")
		// ServeContent gives Range/206/Accept-Ranges for free (resumable download).
		if rs, ok := rc.(io.ReadSeeker); ok {
			http.ServeContent(w, r, key, time.Time{}, rs)
			return
		}
		_, _ = io.Copy(w, rc)
	})
	mux.HandleFunc("PATCH /blob/{key}", authed(func(w http.ResponseWriter, r *http.Request, key string) {
		offset, oerr := strconv.ParseInt(r.Header.Get("X-Blob-Offset"), 10, 64)
		if oerr != nil || offset < 0 {
			http.Error(w, "bad offset", http.StatusBadRequest)
			return
		}
		if full() {
			http.Error(w, "storage full", http.StatusInsufficientStorage)
			return
		}
		size, err := ds.Append(r.Context(), key, offset, r.Body)
		if errors.Is(err, storage.ErrOffsetMismatch) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(map[string]int64{"size": size})
			return
		}
		if errors.Is(err, storage.ErrInvalidKey) {
			http.Error(w, "bad key", http.StatusBadRequest)
			return
		}
		if err != nil {
			http.Error(w, "append failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]int64{"size": size})
	}))
	mux.HandleFunc("DELETE /blob/{key}", authed(func(w http.ResponseWriter, r *http.Request, key string) {
		if err := ds.Delete(r.Context(), key); err != nil && !errors.Is(err, storage.ErrInvalidKey) {
			http.Error(w, "delete failed", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent) // idempotent
	}))
	return mux
}
