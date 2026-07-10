package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/relayium/relayium/internal/storage"
)

// newBlobHandler serves PUT/GET/DELETE /blob/{key} backed by a local DiskStore,
// authenticated by a bearer secret (constant-time). The DiskStore's own key
// validation (validKey regex) rejects path-traversal keys.
func newBlobHandler(ds *storage.DiskStore, secret string) http.Handler {
	mux := http.NewServeMux()
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
		_, _ = io.Copy(w, rc)
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
