// Package httpx holds small, stateless HTTP helpers shared across account
// (open) and, eventually, the commercial layer. Every function here is a pure
// function of its arguments — no package state, no receiver — which is what
// let it move out of account without dragging any of that package's
// internals along.
package httpx

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
)

// maxJSONBody caps a JSON API request body. Every JSON endpoint carries a
// small payload (a few fields), so 1 MiB is generous; it exists only to stop
// an unbounded body from being buffered/decoded. Streaming endpoints
// (blob/upload) do NOT use DecodeJSONBody — they enforce their own, much
// larger, size limits.
const maxJSONBody = 1 << 20

// DecodeJSONBody caps r.Body at maxJSONBody, then decodes it into dst. Used in
// place of a bare json.NewDecoder(r.Body).Decode so no JSON handler can be made
// to buffer an arbitrarily large request body.
func DecodeJSONBody(w http.ResponseWriter, r *http.Request, dst any) error {
	return json.NewDecoder(http.MaxBytesReader(w, r.Body, maxJSONBody)).Decode(dst)
}

// DecodeStrictJSONBody is the versioned-protocol variant of DecodeJSONBody.
// It rejects unknown fields and trailing JSON values, so a newer client cannot
// silently believe central understood security-sensitive material that it
// actually ignored. An empty body returns io.EOF to let endpoints that define
// an empty request as valid handle that case explicitly.
func DecodeStrictJSONBody(w http.ResponseWriter, r *http.Request, dst any) error {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxJSONBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("httpx: multiple JSON values")
		}
		return err
	}
	return nil
}

// WriteJSON writes v as a JSON response body with the given status code.
func WriteJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// ClientIP returns the client's IP: first X-Forwarded-For entry when a reverse
// proxy sets it, else RemoteAddr with the port stripped. Mirrors
// internal/signal.ClientIP — SAME DEPLOYMENT CONTRACT: the proxy MUST overwrite
// (not append) X-Forwarded-For, else an attacker can spoof the leading entry
// and dodge per-IP limits keyed off it.
func ClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if first := strings.TrimSpace(strings.Split(xff, ",")[0]); first != "" {
			return first
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// RequireOrigin rejects requests that carry no Origin header. Some callers
// (top-level form posts, native clients) legitimately omit Origin and must
// not be wrapped with this; but a JSON endpoint that's only ever called by
// fetch always sends Origin, so a missing one there is a forgery signal, not
// a legitimate client.
func RequireOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") == "" {
			http.Error(w, "origin required", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
