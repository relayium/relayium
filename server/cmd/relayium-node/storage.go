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
func newBlobHandler(ds *storage.DiskStore, secret string, lim *limits, diskUsed func() int64, diskFull func() bool, guard *replayGuard) http.Handler {
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
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if err := ds.Ready(); err != nil {
			http.Error(w, "storage unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ready"})
	})
	authed := func(h func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			// The "Bearer " scheme is required, not optional: TrimPrefix alone
			// also accepted the bare secret as the whole header. Every caller
			// (internal/storage.Remote) sends the scheme.
			tok, hasScheme := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			// Fail closed on an unset secret: "" == "" would otherwise let an
			// empty (or absent) bearer through. loadState back-fills a legacy
			// state.json, so this only fires if that ever regresses.
			if !hasScheme || secret == "" || subtle.ConstantTimeCompare([]byte(tok), []byte(secret)) != 1 {
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
	registerDownloadRoutes(mux, ds, secret, guard, nil)
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
		// relayium-append-durability-v1 is negotiated per request: only a central
		// that asks for it gets its answers (and may authorize a repair). Anyone
		// else gets the legacy answers deliberately — the same statuses and sizes a
		// pre-v1 node gave — and no claim beyond them.
		strict := r.Header.Get(storage.AppendDurabilityHeader) == storage.AppendDurabilityV1
		ctx := r.Context()
		if strict {
			w.Header().Set(storage.AppendDurabilityHeader, storage.AppendDurabilityV1)
			if v := r.Header.Get(storage.SettledThroughHeader); v != "" {
				settled, serr := strconv.ParseInt(v, 10, 64)
				if serr != nil || settled < 0 {
					http.Error(w, "bad settled floor", http.StatusBadRequest)
					return
				}
				ctx = storage.WithSettledThrough(ctx, settled)
			}
		}
		size, err := ds.Append(ctx, key, offset, r.Body)
		writeAppendAnswer(w, strict, size, err)
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

// countingWriter wraps a ResponseWriter to count the bytes actually written to
// the client, so the node can report how much it served in a download receipt.
type countingWriter struct {
	http.ResponseWriter
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.ResponseWriter.Write(p)
	c.n += int64(n)
	return n, err
}

// registerDownloadRoutes adds the PUBLIC, token-authed direct-download routes to
// mux: a client fetches the ciphertext straight from this node (central out of
// the data path) by presenting a short-lived, per-key token central signed with
// this node's secret. No bearer secret — the client must never hold it. Shared
// by the internal blob server and the dedicated public download listener.
//
// receipt (may be nil) is fired after a served download with the blob key, the
// token nonce, and the byte count, so central can reconcile the metering it
// pre-charged when it issued the 302.
//
// guard makes each token single-use (see replayGuard). It may be nil, which
// gives this mux a private guard — enforcement is never off, but a process
// serving these routes on more than one listener must pass ONE shared guard, or
// a token spent on one listener could still be replayed on the other.
func registerDownloadRoutes(mux *http.ServeMux, ds *storage.DiskStore, secret string, guard *replayGuard, receipt func(blobKey, nonce string, served int64)) {
	if guard == nil {
		guard = newReplayGuard()
	}
	// CORS preflight: the browser fetches cross-origin (relayium.com ->
	// nodeN.relayium.com); a Range header (resumable streaming) is not
	// CORS-safelisted, so it preflights. Answer it.
	mux.HandleFunc("OPTIONS /dl/{key}", func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Range")
		h.Set("Access-Control-Max-Age", "86400")
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /dl/{key}", func(w http.ResponseWriter, r *http.Request) {
		key := r.PathValue("key")
		tok := r.URL.Query().Get("t")
		now := time.Now().Unix()
		// An empty secret is an empty HMAC key: anyone could mint a token.
		if secret == "" || !dltoken.Verify(secret, key, now, tok) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		// One token, one fetch. Spend it before serving: a token burned by a
		// download that then failed costs the client nothing, because every
		// retry re-enters central and is handed a fresh one.
		exp, _ := dltoken.Exp(tok) // ok: Verify already parsed it
		if !guard.claim(key+"\x00"+dltoken.Nonce(tok), exp, now) {
			http.Error(w, "this download link was already used — request a fresh one", http.StatusForbidden)
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
		cw := &countingWriter{ResponseWriter: w}
		h := cw.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		// Expose the length/range headers so streaming JS can read them cross-origin.
		h.Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
		h.Set("Content-Type", "application/octet-stream")
		h.Set("Cache-Control", "private, no-store")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Disposition", "attachment")
		// ServeContent gives Range/206/Accept-Ranges for free (resumable download).
		if rs, ok := rc.(io.ReadSeeker); ok {
			http.ServeContent(cw, r, key, time.Time{}, rs)
		} else {
			_, _ = io.Copy(cw, rc)
		}
		// Report what we actually served so central can reconcile its pre-charge.
		if receipt != nil {
			receipt(key, dltoken.Nonce(tok), cw.n)
		}
	})
}

// newDownloadHandler is a mux serving ONLY the public download routes plus a
// health probe — for the node's public-facing listener, so the bearer-authed
// /blob write API is never exposed there (Cloudflare proxies to this listener).
// receipt (may be nil) is fired after each served download for central to reconcile.
func newDownloadHandler(ds *storage.DiskStore, secret string, guard *replayGuard, receipt func(blobKey, nonce string, served int64)) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if err := ds.Ready(); err != nil {
			http.Error(w, "storage unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ready"})
	})
	registerDownloadRoutes(mux, ds, secret, guard, receipt)
	return mux
}

// writeAppendAnswer renders one DiskStore.Append outcome as the PATCH answer.
//
// strict (v1): 200 and 409 sizes are durable; a not-durable outcome is 500
// with a NotDurableBody, so central bills the accepted bytes and resumes only
// from the durable size.
//
// legacy: what a pre-v1 node answered. A blob holding a tail this node cannot
// vouch for answers 409 with its PHYSICAL size, exactly as before (a legacy
// central re-syncs from it, and keeps the guarantees it always had — no more);
// a failed flush is a plain 500.
func writeAppendAnswer(w http.ResponseWriter, strict bool, size int64, err error) {
	var nde *storage.NotDurableError
	switch {
	case errors.As(err, &nde) && strict:
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(storage.NotDurableBody{
			NotDurable: true, Durable: nde.Durable, Physical: nde.Physical, Written: nde.Written,
		})
	case errors.As(err, &nde) && nde.Written == 0 && nde.Physical > nde.Durable:
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]int64{"size": nde.Physical})
	case errors.Is(err, storage.ErrOffsetMismatch):
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]int64{"size": size})
	case errors.Is(err, storage.ErrInvalidKey):
		http.Error(w, "bad key", http.StatusBadRequest)
	case err != nil:
		http.Error(w, "append failed", http.StatusInternalServerError)
	default:
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]int64{"size": size})
	}
}
